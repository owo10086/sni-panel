// Isolated rule-router, Agent notification, heartbeat and traffic boundaries.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import { performance } from "node:perf_hooks";
import express from "express";
import * as db from "../db.ts";
import * as runtime from "../dbRuntime.ts";
import { ensureDatabaseSchema } from "../dbSchema.ts";
import { rulesRouter } from "../routers/rules.ts";
import { registerAgentEventClient } from "../agentEvents.ts";
import { decryptPayload } from "../agentCrypto.ts";
import { registerAgentHeartbeatRoute } from "../agentHeartbeatRoute.ts";
import { registerAgentReportRoutes } from "../agentReportRoutes.ts";
import { runBatchOperations } from "../../client/src/lib/batchOperations.ts";

const [scenario, existingValue = "0", countValue = "12"] = process.argv.slice(2);
const existingCount = Number(existingValue);
const count = Number(countValue);
const hostIds = [1, 2, 3];
const context = (id, role) => ({ user: { id, username: role, role, accountEnabled: true }, req: { headers: {} }, res: { clearCookie() {} } });
const admin = rulesRouter.createCaller(context(1, "admin"));
const customer = rulesRouter.createCaller(context(2, "user"));
const zeroLimits = { rateLimitMbps: 0, trafficLimit: 0, trafficMode: "outbound", expiresAt: null };
const ruleInput = (prefix, index, overrides = {}) => ({
  forwardGroupId: 10, name: prefix + "-" + index, sourcePort: 18443,
  forwardType: "nftables", protocol: "tcp", targetIp: "203.0.113.10", targetPort: 19443 + index,
  sni: prefix + "-" + index + ".example.test", isEnabled: true, ...zeroLimits, ...overrides,
});
const insert = (table, values) => runtime.executeRaw(
  'INSERT INTO "' + table + '" (' + Object.keys(values).map(key => '"' + key + '"').join(",") + ') VALUES (' + Object.keys(values).map(() => "?").join(",") + ')', Object.values(values));

// The response is the external SSE boundary. It consumes frames immediately,
// so counts measure requested notifications rather than socket backpressure.
class NotificationResponse extends EventEmitter {
  messages = [];
  lastComment = "";
  constructor(token) { super(); this.token = token; }
  write(frame) {
    for (const line of String(frame).split("\n")) {
      if (line.startsWith("data: ")) this.messages.push(decryptPayload(JSON.parse(line.slice(6)), this.token));
      if (line.startsWith(": ")) this.lastComment = line.slice(2);
    }
    return true;
  }
  end() { this.emit("finish"); }
  destroy() { this.emit("close"); }
}
const notifications = new Map();
function captureNotifications() {
  for (const hostId of hostIds) {
    const response = new NotificationResponse("token-" + hostId);
    const stream = registerAgentEventClient(hostId, "token-" + hostId, response);
    notifications.set(hostId, { response, stream });
  }
}
function notificationCounts() {
  return Object.fromEntries([...notifications].map(([id, { response, stream }]) => {
    stream.writeComment("checkpoint");
    assert.equal(response.lastComment, "checkpoint");
    const counts = {};
    for (const message of response.messages) if (message.type === "agent-refresh") {
      const reason = message.data.reason;
      counts[reason] = (counts[reason] || 0) + 1;
    }
    return [id, counts];
  }));
}
function clearNotifications() {
  notificationCounts();
  for (const { response } of notifications.values()) response.messages.length = 0;
}
function notificationEvidence() {
  const counts = notificationCounts();
  return Object.fromEntries([...notifications].map(([id, { response }]) => {
    const byUrgency = {};
    for (const message of response.messages) if (message.type === "agent-refresh") {
      const key = message.data.reason + (message.data.urgent ? ":urgent" : ":normal");
      byUrgency[key] = (byUrgency[key] || 0) + 1;
    }
    return [id, { counts: counts[id], byUrgency, messages: [...response.messages] }];
  }));
}
function assertRefreshCount(reason, expected) {
  for (const [hostId, counts] of Object.entries(notificationCounts())) assert.equal(counts[reason] || 0, expected, "host " + hostId + " reason " + reason);
}

const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.agentToken = String(req.headers.authorization || "").replace(/^Bearer /, ""); next(); });
registerAgentHeartbeatRoute(app);
registerAgentReportRoutes(app);
const server = http.createServer(app);
async function agentPost(hostId, route, body) {
  const response = await fetch("http://127.0.0.1:" + server.address().port + "/api/agent/" + route, {
    method: "POST", headers: { authorization: "Bearer token-" + hostId, "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  assert.equal(result.success, true, JSON.stringify(result));
  return result;
}
const heartbeat = (hostId, localRules = []) => agentPost(hostId, "heartbeat", {
  agentVersion: "3.3.0", agentBootId: "import-boot-" + hostId, agentProcessId: 1000 + hostId,
  forceReconcile: true, localState: { rules: localRules },
});
const splitter = result => result.desiredState.actions.find(action => action.op === "apply" && action.fxp?.role === "sni-splitter" && action.sourcePort === 18443)?.fxp;
const localRules = config => config.sniRoutes.map(route => ({ ...route, port: config.listenPort, forwardType: "forwardx", protocol: "tcp", sniRouteVersion: config.sniRouteVersion, sourceAllowIps: [], ready: true }));
async function importRules(prefix, number, overrides = {}) {
  return runBatchOperations(Array.from({ length: number }, (_, index) => ruleInput(prefix, index, overrides)), 6, async (input, index) => {
    await admin.checkSniImport({ userId: input.userId, forwardGroupId: 10, sourcePort: 18443, rules: [{ lineNumber: index + 1, sni: input.sni }] });
    return admin.create(input);
  });
}
async function verifyImported(results, seeded = 0) {
  assert.ok(results.every(result => result.status === "fulfilled"), JSON.stringify(results));
  const roots = (await admin.list()).filter(rule => rule.forwardGroupId === 10);
  assert.equal(roots.length, seeded + results.length);
  for (const result of results) {
    const saved = await admin.getById({ id: result.value.id });
    assert.equal(saved.adminManaged, true);
    assert.equal(saved.isRunning, false, "a save cannot confirm a new configuration");
    assert.equal(saved.sniRuntime.entries.length, 3);
  }
  const inputs = [...Array.from({ length: seeded }, (_, index) => ruleInput("seed", index)), ...results.map(result => result.item)];
  const configs = new Map();
  const childIds = new Set();
  for (const hostId of hostIds) {
    const config = splitter(await heartbeat(hostId));
    assert.ok(config, "host " + hostId + " needs its splitter configuration");
    assert.equal(config.sniRoutes.length, inputs.length);
    for (const input of inputs) {
      const route = config.sniRoutes.find(route => route.sni === input.sni);
      assert.ok(route, input.sni);
      assert.equal(route.targetIp, input.targetIp);
      assert.equal(route.targetPort, input.targetPort);
      childIds.add(route.ruleId);
    }
    configs.set(hostId, config);
  }
  assert.equal(childIds.size, inputs.length * 3);
  return configs;
}

try {
  assert.ok(process.env.FORWARDX_TEST_DB, "an isolated database path is required");
  await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
  await ensureDatabaseSchema();
  if (scenario !== "benchmark") {
    await insert("users", { id: 1, username: "admin", password: "unused", role: "admin", canAddRules: 1, manualCanAddRules: 1, balanceCents: 1000 });
    await insert("users", { id: 2, username: "customer", password: "unused", role: "user", canAddRules: 1, manualCanAddRules: 1, balanceCents: 1000 });
    for (const id of hostIds) await insert("hosts", { id, name: "import-entry-" + id, ip: "192.0.2." + id, ipv4: "192.0.2." + id, agentToken: "token-" + id, userId: 1, isOnline: 1, lastHeartbeat: Math.floor(Date.now() / 1000), agentVersion: "3.3.0", portRangeStart: 18000, portRangeEnd: 30000 });
    await insert("forward_groups", { id: 10, name: "SNI import", groupType: "host", groupMode: "failover", forwardType: "nftables", domain: "", targetIp: "0.0.0.0", targetPort: 1, userId: 1, isEnabled: 1, failoverSeconds: 10, recoverSeconds: 10 });
    for (const id of hostIds) await insert("forward_group_members", { id: 100 + id, groupId: 10, memberType: "host", hostId: id, priority: id * 10, isEnabled: 1 });
    await db.setUserHostPermissions(2, hostIds);
    await db.setUserForwardGroupPermissions(2, [10]);
  }
  for (const id of hostIds) await runtime.executeRaw('UPDATE hosts SET "isOnline" = 1, "lastHeartbeat" = ? WHERE id = ?', [Math.floor(Date.now() / 1000), id]);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));

  if (scenario === "prepare") {
    for (let index = 0; index < existingCount; index++) await admin.create(ruleInput("seed", index));
  } else {
    captureNotifications();
    if (scenario === "baseline-control") {
      const omitted = await admin.create(ruleInput("omitted", 0, { rateLimitMbps: undefined, trafficLimit: undefined, trafficMode: undefined, expiresAt: undefined }));
      assert.equal((await admin.getById({ id: omitted.id })).adminManaged, false);
      assertRefreshCount("rule-limits-changed", 0);
      clearNotifications();
      const explicit = await admin.create(ruleInput("explicit", 0));
      assert.equal((await admin.getById({ id: explicit.id })).adminManaged, true);
      console.log("SNI_IMPORT_RESULT=" + JSON.stringify({ notifications: notificationCounts(), omittedManaged: false, explicitManaged: true }));
    } else if (scenario === "benchmark") {
      const start = performance.now();
      const results = await importRules("import", count);
      const durationMs = Math.round(performance.now() - start);
      const counts = notificationCounts();
      await verifyImported(results, existingCount);
      console.log("SNI_IMPORT_RESULT=" + JSON.stringify({ existingCount, count, hosts: 3, concurrency: 6, durationMs, notifications: counts, rootCount: existingCount + count, childCount: (existingCount + count) * 3 }));
    } else if (scenario === "notifications") {
      const input = ruleInput("seed", 0);
      await admin.create(input);
      const single = notificationEvidence();
      clearNotifications();
      const results = await importRules("concurrent", 12);
      const batch = notificationEvidence();
      await verifyImported(results, 1);
      assert.ok(process.env.FORWARDX_NOTIFICATION_OUTPUT, "a notification evidence output path is required");
      fs.writeFileSync(process.env.FORWARDX_NOTIFICATION_OUTPUT, JSON.stringify({ single, batch }, null, 2) + "\n");
    } else if (scenario === "sync") {
      const input = ruleInput("seed", 0);
      const created = await admin.create(input);
      assertRefreshCount("forward-group-synced", 1);
      const initial = await verifyImported([{ status: "fulfilled", item: input, value: created }]);
      for (const [hostId, config] of initial) await heartbeat(hostId, localRules(config));
      assert.equal((await admin.getById({ id: created.id })).isRunning, true);
      clearNotifications();
      const results = await importRules("concurrent", 12);
      assertRefreshCount("forward-group-synced", 12);
      assert.equal((await admin.getById({ id: created.id })).isRunning, true, "adding routes preserves the existing confirmed route");
      const configs = await verifyImported(results, 1);
      for (const [hostId, config] of configs) await heartbeat(hostId, localRules(config));
      for (const result of results) assert.ok((await admin.getById({ id: result.value.id })).sniRuntime.entries.every(entry => entry.applied));
    } else if (scenario === "limits") {
      const managed = await admin.create(ruleInput("quota", 0, { userId: 2 }));
      assertRefreshCount("rule-limits-changed", 0);
      const saved = await customer.getById({ id: managed.id });
      assert.equal(saved.adminManaged, true);
      assert.equal(Number(saved.quotaUsedIn || 0), 0, "usage starts empty before any heartbeat or traffic report");
      await assert.rejects(customer.update({ id: managed.id, name: "not allowed" }), /仅可查看/);
      await assert.rejects(customer.toggle({ id: managed.id, isEnabled: false }), /仅可查看/);
      await assert.rejects(customer.delete({ id: managed.id }), /仅可查看/);
      // Look up the generated Agent identities only to submit its first report;
      // quota assertions use the rule router and no heartbeat has run yet.
      const children = await db.getForwardGroupChildRulesForTemplate(managed.id);
      const report = (hostId, bytesIn, bytesOut) => agentPost(hostId, "traffic", {
        reportId: "first-" + hostId, reportProducerId: "import-producer-" + hostId,
        stats: [{ ruleId: children.find(child => child.hostId === hostId).id, bytesIn, bytesOut, connections: 1 }],
      });
      await report(1, 100, 200);
      await report(2, 300, 400);
      await report(1, 100, 200);
      const counted = await customer.getById({ id: managed.id });
      assert.equal(counted.quotaUsedIn, 400);
      assert.equal(counted.quotaUsedOut, 600);
      await admin.update({ id: managed.id, trafficLimit: 500 });
      assert.equal((await admin.getById({ id: managed.id })).ruleLimitReason, "traffic_limit");
      await admin.update({ id: managed.id, trafficLimit: 2000 });
      assert.equal((await admin.getById({ id: managed.id })).quotaUsedOut, 600);
      assert.equal((await admin.getById({ id: managed.id })).ruleLimitReason, null);
      clearNotifications();
      const results = await importRules("unlimited", 12);
      assert.ok(results.every(result => result.status === "fulfilled"), JSON.stringify(results));
      assertRefreshCount("rule-limits-changed", 0);
      for (const result of results) assert.equal((await admin.getById({ id: result.value.id })).adminManaged, true);
      for (const [name, limits] of [
        ["speed", { rateLimitMbps: 10 }],
        ["traffic", { trafficLimit: 1000 }],
        ["expiry", { expiresAt: new Date(Math.floor(Date.now() / 1000) * 1000 + 86400000) }],
      ]) {
        clearNotifications();
        const input = ruleInput(name, 0, limits);
        const created = await admin.create(input);
        assertRefreshCount("rule-limits-changed", 1);
        for (const { response } of notifications.values()) assert.ok(response.messages.filter(message => message.data?.reason === "rule-limits-changed").every(message => message.data.urgent));
        const configs = new Map();
        for (const hostId of hostIds) {
          const config = splitter(await heartbeat(hostId));
          const route = config.sniRoutes.find(route => route.sni === input.sni);
          assert.ok(route, name + " rule must remain available before its limit is reached");
          if (name === "speed") assert.equal(route.limitIn, 1250000);
          configs.set(hostId, config);
        }
        if (name === "traffic") {
          const route = configs.get(1).sniRoutes.find(route => route.sni === input.sni);
          await agentPost(1, "traffic", { reportId: "quota-reached", reportProducerId: "quota-producer", stats: [{ ruleId: route.ruleId, bytesIn: 0, bytesOut: 1000, connections: 1 }] });
          assert.equal((await admin.getById({ id: created.id })).ruleLimitReason, "traffic_limit");
        } else if (name === "expiry") {
          assert.equal((await admin.getById({ id: created.id })).expiresAt.getTime(), limits.expiresAt.getTime());
          await admin.update({ id: created.id, createdAt: new Date(Date.now() - 86400000), expiresAt: new Date(Date.now() - 1000) });
          assert.equal((await admin.getById({ id: created.id })).ruleLimitReason, "expired");
        }
        if (name !== "speed") for (const hostId of hostIds) {
          const config = splitter(await heartbeat(hostId));
          assert.ok(config.sniRoutes.every(route => route.sni !== input.sni));
          assert.ok(config.sniRoutes.some(route => route.sni === "unlimited-0.example.test"), "other shared-port domains remain available");
        }
      }
    } else if (scenario === "cross-resource") {
      await insert("forward_groups", { id: 30, name: "chain", groupType: "host", groupMode: "chain", forwardType: "nftables", domain: "", targetIp: "0.0.0.0", targetPort: 1, userId: 1, isEnabled: 1 });
      for (const id of [1, 2]) await insert("forward_group_members", { id: 300 + id, groupId: 30, memberType: "host", hostId: id, priority: id * 10, isEnabled: 1 });
      await insert("tunnels", { id: 20, name: "direct TLS", entryHostId: 1, exitHostId: 2, mode: "tls", listenPort: 26000, userId: 1, isEnabled: 1 });
      for (const [name, route] of [
        ["plain", { forwardGroupId: null, hostId: 1, sni: null, sourcePort: 18500 }],
        ["chain", { forwardGroupId: 30, sourcePort: 18510 }],
        ["tunnel", { forwardGroupId: null, hostId: 1, tunnelId: 20, forwardType: "gost", sourcePort: 18520 }],
      ]) {
        clearNotifications();
        const input = ruleInput(name, 0, route);
        const managed = await admin.create(input);
        assertRefreshCount("rule-limits-changed", 0);
        assert.equal((await admin.getById({ id: managed.id })).adminManaged, true);
        const omitted = await admin.create({ ...input, name: name + "-omitted", sni: input.sni ? name + "-omitted.example.test" : null, sourcePort: input.sourcePort + 1, rateLimitMbps: undefined, trafficLimit: undefined, trafficMode: undefined, expiresAt: undefined });
        assert.equal((await admin.getById({ id: omitted.id })).adminManaged, false);
        assertRefreshCount("rule-limits-changed", 0);
        if (name === "plain") {
          // Model a managed rule whose usage baseline has not been initialized.
          // Creation may already initialize it during required port checks.
          await runtime.executeRaw('UPDATE forward_rules SET "quotaUsedIn" = NULL, "quotaUsedOut" = NULL WHERE id = ?', [managed.id]);
          const firstReport = { reportId: "plain-first", reportProducerId: "plain-producer", stats: [{ ruleId: managed.id, bytesIn: 123, bytesOut: 456, connections: 1 }] };
          await agentPost(1, "traffic", firstReport);
          await agentPost(1, "traffic", firstReport);
          const counted = await admin.getById({ id: managed.id });
          assert.equal(counted.quotaUsedIn, 123);
          assert.equal(counted.quotaUsedOut, 456);
          assert.ok((await heartbeat(1)).desiredState.actions.some(action => action.op === "apply" && action.sourcePort === input.sourcePort));
        } else {
          const result = await heartbeat(2);
          const exitRoute = result.desiredState.actions.flatMap(action => action.fxp?.sniRoutes || []).find(route => route.sni === input.sni && route.targetIp === input.targetIp && route.targetPort === input.targetPort);
          assert.ok(exitRoute, name + " exit receives its destination route");
        }
      }
    } else if (scenario === "partial-failure") {
      const inputs = Array.from({ length: 12 }, (_, index) => ruleInput("mixed", index));
      inputs[11].sni = inputs[0].sni;
      const results = await runBatchOperations(inputs, 6, async (input, index) => {
        await admin.checkSniImport({ forwardGroupId: 10, sourcePort: 18443, rules: [{ lineNumber: index + 1, sni: input.sni }] });
        return admin.create(input);
      });
      assert.equal(results[11].status, "rejected");
      assert.equal(results.filter(result => result.status === "fulfilled").length, 11, JSON.stringify(results, (_key, value) => value instanceof Error ? value.message : value));
      await verifyImported(results.filter(result => result.status === "fulfilled"));
      clearNotifications();
      await runtime.executeRaw('CREATE TRIGGER reject_import_child BEFORE INSERT ON forward_rules WHEN NEW."hostId" = 3 AND NEW."targetPort" = 19999 BEGIN SELECT RAISE(ABORT, "import child write failure"); END');
      await assert.rejects(admin.create(ruleInput("rollback", 0, { targetPort: 19999 })), /import child write failure/);
      assert.equal((await admin.list()).length, 11);
      for (const counts of Object.values(notificationCounts())) assert.deepEqual(counts, {});
      // An unchanged pending configuration is resent after one minute. Advance
      // this isolated clock to request a fresh snapshot without a repair sync.
      const now = Date.now;
      Date.now = () => now() + 61_000;
      for (const hostId of hostIds) {
        const config = splitter(await heartbeat(hostId));
        assert.equal(config.sniRoutes.length, 11);
        assert.ok(config.sniRoutes.every(route => route.sni !== "rollback-0.example.test"));
      }
    } else {
      throw new Error("Unknown SNI import scenario: " + scenario);
    }
  }
} finally {
  for (const { stream } of notifications.values()) stream.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await runtime.closeDatabase();
}
process.exit(0);
