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
    if (scenario === "batch-group") {
      const kept = ruleInput("seed", 0);
      const saved = await admin.create(kept);
      const initial = await verifyImported([{ status: "fulfilled", item: kept, value: saved }]);
      for (const [hostId, config] of initial) await heartbeat(hostId, localRules(config));
      clearNotifications();
      const inputs = Array.from({ length: 12 }, (_, index) => ruleInput("batch", index));
      const { results } = await admin.createSniBatch({ rules: inputs });
      assert.equal(results.length, 12);
      for (const [hostId, counts] of Object.entries(notificationCounts())) {
        assert.equal(Object.values(counts).reduce((total, count) => total + count, 0), 1, "one complete saved update for host " + hostId);
      }
      assert.equal((await admin.getById({ id: saved.id })).isRunning, true, "the existing confirmed route stays available");
      const configs = await verifyImported(results.map((result, index) => ({ ...result, item: inputs[index] })), 1);
      for (const [hostId, config] of configs) await heartbeat(hostId, localRules(config));
      for (const result of results) assert.ok((await admin.getById({ id: result.value.id })).sniRuntime.entries.every(entry => entry.applied));
    } else if (scenario === "batch-item-failure") {
      await runtime.executeRaw(`CREATE TRIGGER reject_import_root AFTER INSERT ON forward_rules WHEN NEW."isForwardGroupTemplate" = 1 AND NEW."targetPort" = 19999 BEGIN SELECT RAISE(FAIL, 'import item write failure'); END`);
      const inputs = Array.from({ length: 8 }, (_, index) => ruleInput("partial", index));
      inputs[1].targetPort = 19999;
      inputs[6].targetPort = 19999;
      inputs[4].sni = inputs[0].sni;
      const { results } = await admin.createSniBatch({ rules: inputs });
      assert.deepEqual(results.map(result => result.status), ["fulfilled", "rejected", "fulfilled", "fulfilled", "rejected", "fulfilled", "rejected", "fulfilled"], JSON.stringify(results));
      assert.match(results[1].reason, /import item write failure/);
      assert.match(results[4].reason, /SNI|域名/);
      const successful = results.flatMap((result, index) => result.status === "fulfilled" ? [{ ...result, item: inputs[index] }] : []);
      await verifyImported(successful);
      const retry = await admin.createSniBatch({ rules: [ruleInput("retry", 0)] });
      assert.equal(retry.results[0].status, "fulfilled", "failed items release all temporary reservations");
    } else if (scenario === "batch-final-failure") {
      const kept = ruleInput("seed", 0);
      const saved = await admin.create(kept);
      const initial = await verifyImported([{ status: "fulfilled", item: kept, value: saved }]);
      for (const [hostId, config] of initial) await heartbeat(hostId, localRules(config));
      clearNotifications();
      await runtime.executeRaw(`CREATE TRIGGER reject_final_member BEFORE INSERT ON forward_rules WHEN NEW."hostId" = 3 AND NEW."targetPort" = 19999 BEGIN SELECT RAISE(ABORT, 'final member write failure'); END`);
      await assert.rejects(admin.createSniBatch({ rules: [ruleInput("new", 0), ruleInput("new", 1, { targetPort: 19999 })] }), /final member write failure/);
      assert.deepEqual((await admin.list()).map(rule => rule.id), [saved.id]);
      assert.equal((await admin.getById({ id: saved.id })).isRunning, true);
      for (const counts of Object.values(notificationCounts())) assert.deepEqual(counts, {});
      const now = Date.now;
      Date.now = () => now() + 61_000;
      for (const hostId of hostIds) {
        const config = splitter(await heartbeat(hostId));
        assert.deepEqual(config.sniRoutes.map(route => route.sni), [kept.sni]);
      }
      Date.now = now;
      await runtime.executeRaw('DROP TRIGGER reject_final_member');
      assert.equal((await admin.createSniBatch({ rules: [ruleInput("retry", 0)] })).results[0].status, "fulfilled");
    } else if (["batch-port", "batch-chain", "batch-tunnel"].includes(scenario)) {
      const kind = scenario.slice(6);
      for (const id of [4, 5]) await insert("hosts", { id, name: "extra-entry-" + id, ip: "192.0.2." + id, ipv4: "192.0.2." + id, agentToken: "token-" + id, userId: 1, isOnline: 1, lastHeartbeat: Math.floor(Date.now() / 1000), agentVersion: "3.3.0", portRangeStart: 18000, portRangeEnd: 30000 });
      await insert("forward_groups", { id: 30, name: "entries", groupType: "host", groupMode: "entry", forwardType: "nftables", domain: "entry.example.test", targetIp: "0.0.0.0", targetPort: 1, userId: 1, isEnabled: 1 });
      for (const id of [4, 5]) await insert("forward_group_members", { id: 300 + id, groupId: 30, memberType: "host", hostId: id, priority: id * 10, isEnabled: 1 });
      let route;
      if (kind === "tunnel") {
        await insert("tunnels", { id: 20, name: "direct TLS", entryHostId: 1, exitHostId: 3, entryGroupId: 30, mode: "tls", listenPort: 26000, userId: 1, isEnabled: 1 });
        route = { forwardGroupId: null, tunnelId: 20, hostId: 1, forwardType: "gost" };
      } else {
        await insert("forward_groups", { id: 20, name: kind, groupType: "host", groupMode: kind, forwardType: "nftables", domain: "", targetIp: "0.0.0.0", targetPort: 1, userId: 1, isEnabled: 1, ...(kind === "chain" ? { entryGroupId: 30 } : {}) });
        for (const id of kind === "port" ? [1] : [1, 2, 3]) await insert("forward_group_members", { id: 200 + id, groupId: 20, memberType: "host", hostId: id, priority: id * 10, isEnabled: 1 });
        route = { forwardGroupId: 20 };
      }
      const keptInput = ruleInput("kept", 0, route);
      const kept = await admin.create(keptInput);
      const initialAction = (await heartbeat(kind === "port" ? 1 : 3)).desiredState.actions.find(action => action.fxp?.role === "sni-splitter");
      const inputs = Array.from({ length: 6 }, (_, index) => ruleInput(kind, index, { ...route, rateLimitMbps: 16, maxConnections: 33 }));
      inputs[1].sni = keptInput.sni;
      inputs[4].sni = inputs[2].sni;
      const { results } = await admin.createSniBatch({ rules: inputs });
      assert.deepEqual(results.map(result => result.status), ["fulfilled", "rejected", "fulfilled", "fulfilled", "rejected", "fulfilled"], JSON.stringify(results));
      const expected = [keptInput, ...inputs.filter((_, index) => results[index].status === "fulfilled")];
      assert.equal((await admin.list()).length, expected.length);
      const now = Date.now;
      Date.now = () => now() + 61_000;
      const states = new Map();
      for (const id of kind === "port" ? [1] : [1, 2, 3, 4, 5]) states.set(id, await heartbeat(id));
      Date.now = now;
      const exit = states.get(kind === "port" ? 1 : 3).desiredState.actions.find(action => action.fxp?.role === "sni-splitter");
      assert.equal(exit.ruleId, initialAction.ruleId, "shared listener identity stays stable");
      assert.equal(exit.fxp.sniRoutes.length, expected.length);
      for (const input of expected) {
        const actual = exit.fxp.sniRoutes.find(item => item.sni === input.sni);
        assert.ok(actual, input.sni);
        assert.equal(actual.targetIp, input.targetIp);
        assert.equal(actual.targetPort, input.targetPort);
        if (input !== keptInput) {
          assert.equal(actual.limitIn, 2_000_000);
          assert.equal(actual.maxConnections, 33);
        }
      }
      if (kind === "chain") for (const id of [4, 5]) {
        const entry = states.get(id).desiredState.actions.find(action => action.fxp?.role === "sni-splitter" && action.sourcePort === 18443);
        assert.equal(entry.fxp.sniRoutes.length, expected.length);
        for (const item of entry.fxp.sniRoutes) {
          assert.equal(item.targetIp, "192.0.2.1");
          assert.ok(states.get(1).desiredState.actions.some(action => action.op === "apply" && action.sourcePort === item.targetPort));
        }
      }
      if (kind === "tunnel") for (const id of [1, 4, 5]) {
        const state = states.get(id);
        assert.ok(state.desiredState.actions.some(action => action.op === "apply" && action.forwardType === "gost-runtime-sync"), "direct TLS entry uses its tunnel configuration on host " + id);
        assert.ok(state.runningRules.some(rule => Number(rule.tunnelId) === 20 && Number(rule.sourcePort) === 18443 && Number(rule.ruleId) === kept.id), "shared tunnel keeps the original runtime identity");
      }
      for (const result of results.filter(result => result.status === "fulfilled")) {
        const saved = await admin.getById({ id: result.value.id });
        assert.equal(saved.isRunning, false);
        assert.equal(saved.adminManaged, true);
      }
      assert.equal((await admin.getById({ id: kept.id })).targetPort, keptInput.targetPort);
    } else if (scenario === "batch-notification-failure") {
      for (const { response } of notifications.values()) response.write = () => { throw new Error("disconnected notification receiver"); };
      const inputs = Array.from({ length: 3 }, (_, index) => ruleInput("offline", index));
      const { results } = await admin.createSniBatch({ rules: inputs });
      assert.ok(results.every(result => result.status === "fulfilled"), JSON.stringify(results));
      await verifyImported(results.map((result, index) => ({ ...result, item: inputs[index] })));
    } else if (scenario === "batch-permissions") {
      await assert.rejects(customer.createSniBatch({ rules: [ruleInput("denied", 0)] }), /仅管理员/);
      await assert.rejects(admin.createSniBatch({ rules: [] }));
      await assert.rejects(admin.createSniBatch({ rules: Array.from({ length: 501 }, (_, i) => ruleInput("large", i)) }));
      await assert.rejects(admin.createSniBatch({ rules: [ruleInput("mixed", 0), ruleInput("mixed", 1, { forwardGroupId: 99 })] }), /同一个/);
      assert.equal((await admin.list()).length, 0);
      await runtime.executeRaw('UPDATE users SET "maxRules" = 2, "manualMaxRules" = 2, "maxPorts" = 1, "manualMaxPorts" = 1 WHERE id = 2');
      const inputs = Array.from({ length: 4 }, (_, index) => ruleInput("quota", index, { userId: 2 }));
      inputs[0].sni = "bad host";
      inputs[1].sni = " QUOTA-1.EXAMPLE.TEST. ";
      const { results } = await admin.createSniBatch({ rules: inputs });
      assert.deepEqual(results.map(result => result.status), ["rejected", "fulfilled", "fulfilled", "rejected"], JSON.stringify(results));
      assert.match(results[3].reason, /最大规则数量/);
      assert.equal((await customer.getById({ id: results[1].value.id })).sni, "quota-1.example.test");
      assert.equal(await db.getUserPortCount(2), 1, "two domains share one port allowance");
      assert.equal(await db.getUserRuleCount(2), 2);
      await db.setUserForwardGroupPermissions(2, []);
      const denied = await admin.createSniBatch({ rules: [ruleInput("no-access", 0, { userId: 2 })] });
      assert.equal(denied.results[0].status, "rejected");
      assert.match(denied.results[0].reason, /无权/);
      const omitted = ruleInput("omitted", 0, { rateLimitMbps: undefined, trafficLimit: undefined, trafficMode: undefined, expiresAt: undefined });
      const managed = ruleInput("explicit", 0);
      const saved = await admin.createSniBatch({ rules: [omitted, managed] });
      assert.equal((await admin.getById({ id: saved.results[0].value.id })).adminManaged, false);
      assert.equal((await admin.getById({ id: saved.results[1].value.id })).adminManaged, true);
    } else if (scenario === "batch-concurrency") {
      const { withResourceTaskLock, withTrafficBillingUserLock } = await import("../keyedTaskLock.ts");
      const deferred = () => {
        let resolve;
        const promise = new Promise(done => { resolve = done; });
        return { promise, resolve };
      };
      const held = deferred(); const release = deferred();
      const billing = withTrafficBillingUserLock(2, async () => { held.resolve(); await release.promise; });
      await held.promise;
      const waiting = admin.createSniBatch({ rules: [ruleInput("billing", 0, { userId: 2 })] });
      await new Promise(resolve => setImmediate(resolve));
      // The batch must wait before owning SQLite, so independent writes finish.
      await db.setSetting("batch-independent-write", "available");
      release.resolve(); await billing;
      assert.equal((await waiting).results[0].status, "fulfilled");
      const concurrent = await Promise.all([
        admin.createSniBatch({ rules: [ruleInput("race", 0), ruleInput("unique", 0)] }),
        admin.createSniBatch({ rules: [ruleInput("race", 0, { sourcePort: 18444 }), ruleInput("unique", 1)] }),
        admin.create(ruleInput("single", 0)),
      ]);
      const outcomes = concurrent.slice(0, 2).flatMap(item => item.results);
      assert.equal(outcomes.filter(item => item.status === "fulfilled").length, 3, JSON.stringify(concurrent));
      assert.equal(outcomes.filter(item => item.status === "rejected").length, 1);
      await insert("hosts", { id: 4, name: "new-entry", ip: "192.0.2.4", agentToken: "token-4", userId: 1, isOnline: 1, lastHeartbeat: Math.floor(Date.now() / 1000), agentVersion: "3.3.0", portRangeStart: 18000, portRangeEnd: 30000 });
      await insert("forward_groups", { id: 20, name: "new-host", groupType: "host", groupMode: "port", forwardType: "nftables", domain: "", targetIp: "0.0.0.0", targetPort: 1, userId: 1, isEnabled: 1 });
      await insert("forward_group_members", { id: 204, groupId: 20, memberType: "host", hostId: 4, priority: 0, isEnabled: 1 });
      await admin.create(ruleInput("occupied", 0, { forwardGroupId: 20, sourcePort: 18445 }));
      const groupHeld = deferred(); const groupRelease = deferred();
      const moving = withResourceTaskLock("forward-group-sync:10", async () => { groupHeld.resolve(); await groupRelease.promise;
        await runtime.executeRaw('UPDATE forward_group_members SET "isEnabled" = 0 WHERE "groupId" = 10');
        await insert("forward_group_members", { id: 104, groupId: 10, memberType: "host", hostId: 4, priority: 0, isEnabled: 1 });
      });
      await groupHeld.promise;
      const pending = admin.createSniBatch({ rules: [ruleInput("occupied", 0)] });
      await new Promise(resolve => setTimeout(resolve, 25));
      groupRelease.resolve(); await moving;
      const afterMove = await pending;
      assert.equal(afterMove.results[0].status, "rejected");
      assert.match(afterMove.results[0].reason, /SNI|域名/);
      assert.equal((await admin.createSniBatch({ rules: [ruleInput("after-move", 0)] })).results[0].status, "fulfilled");
    } else if (scenario.startsWith("batch-failure-")) {
      const kind = scenario.slice("batch-failure-".length);
      let route;
      if (kind === "tunnel") {
        await insert("tunnels", { id: 20, name: "TLS failure", entryHostId: 1, exitHostId: 3, mode: "tls", listenPort: 26000, userId: 1, isEnabled: 1 });
        route = { forwardGroupId: null, tunnelId: 20, hostId: 1, forwardType: "gost" };
      } else {
        await runtime.executeRaw('UPDATE forward_groups SET "groupMode" = ? WHERE id = 10', [kind]);
        if (kind === "port") await runtime.executeRaw('DELETE FROM forward_group_members WHERE "groupId" = 10 AND "hostId" != 1');
        route = { forwardGroupId: 10 };
      }
      const kept = await admin.create(ruleInput("kept", 0, route));
      if (kind === "tunnel") {
        // Fail after root and listener references exist, while updating the tunnel.
        await runtime.executeRaw(`CREATE TRIGGER reject_item AFTER UPDATE ON tunnels WHEN NEW.id = 20 AND EXISTS (SELECT 1 FROM forward_rules WHERE "targetPort" = 19999) BEGIN SELECT RAISE(FAIL, 'mapping save failure'); END`);
      } else {
        await runtime.executeRaw(`CREATE TRIGGER reject_item AFTER INSERT ON forward_rules WHEN NEW."isForwardGroupTemplate" = 1 AND NEW."targetPort" = 19999 BEGIN SELECT RAISE(FAIL, 'item save failure'); END`);
      }
      const inputs = Array.from({ length: 5 }, (_, index) => ruleInput("items", index, { ...route, ...(index === 0 || index === 3 ? { targetPort: 19999 } : {}) }));
      const { results } = await admin.createSniBatch({ rules: inputs });
      assert.deepEqual(results.map(result => result.status), ["rejected", "fulfilled", "fulfilled", "rejected", "fulfilled"], JSON.stringify(results));
      assert.equal((await admin.list()).length, 4);
      await runtime.executeRaw('DROP TRIGGER reject_item');
      await runtime.executeRaw('CREATE TABLE batch_commit_guard (id INTEGER REFERENCES users(id) DEFERRABLE INITIALLY DEFERRED)');
      await runtime.executeRaw(`CREATE TRIGGER reject_commit AFTER INSERT ON forward_rules WHEN NEW."targetPort" = 19998 BEGIN INSERT INTO batch_commit_guard VALUES (999999); END`);
      clearNotifications();
      await assert.rejects(admin.createSniBatch({ rules: [ruleInput("commit", 0, route), ruleInput("commit", 1, { ...route, targetPort: 19998 })] }), /FOREIGN KEY/);
      assert.equal((await admin.list()).length, 4);
      assert.equal((await admin.getById({ id: kept.id })).targetPort, 19443);
      for (const counts of Object.values(notificationCounts())) assert.deepEqual(counts, {});
      const exitHost = kind === "port" ? 1 : 3;
      const state = await heartbeat(exitHost);
      const domains = state.desiredState.actions.flatMap(action => action.fxp?.sniRoutes || []).map(item => item.sni).sort();
      assert.deepEqual(domains, ["items-1.example.test", "items-2.example.test", "items-4.example.test", "kept-0.example.test"]);
      await runtime.executeRaw('DROP TRIGGER reject_commit');
      assert.equal((await admin.createSniBatch({ rules: [ruleInput("retry", 0, route)] })).results[0].status, "fulfilled");
    } else if (scenario === "baseline-control") {
      const omitted = await admin.create(ruleInput("omitted", 0, { rateLimitMbps: undefined, trafficLimit: undefined, trafficMode: undefined, expiresAt: undefined }));
      assert.equal((await admin.getById({ id: omitted.id })).adminManaged, false);
      assertRefreshCount("rule-limits-changed", 0);
      clearNotifications();
      const explicit = await admin.create(ruleInput("explicit", 0));
      assert.equal((await admin.getById({ id: explicit.id })).adminManaged, true);
      console.log("SNI_IMPORT_RESULT=" + JSON.stringify({ notifications: notificationCounts(), omittedManaged: false, explicitManaged: true }));
    } else if (scenario === "benchmark") {
      const inputs = Array.from({ length: count }, (_, index) => ruleInput("import", index));
      const useBatch = process.env.FORWARDX_BATCH_IMPORT === "1";
      const start = performance.now();
      const results = useBatch
        ? (await admin.createSniBatch({ rules: inputs })).results.map((result, index) => ({ ...result, item: inputs[index] }))
        : await importRules("import", count);
      const durationMs = Math.round(performance.now() - start);
      const counts = notificationCounts();
      await verifyImported(results, existingCount);
      console.log("SNI_IMPORT_RESULT=" + JSON.stringify({ existingCount, count, hosts: 3, concurrency: useBatch ? 1 : 6, durationMs, notifications: counts, rootCount: existingCount + count, childCount: (existingCount + count) * 3 }));
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
    } else if (scenario === "limits" || scenario === "batch-limits") {
      const create = async input => {
        if (scenario === "limits") return admin.create(input);
        const { results } = await admin.createSniBatch({ rules: [input] });
        assert.equal(results[0].status, "fulfilled", JSON.stringify(results));
        return results[0].value;
      };
      const managed = await create(ruleInput("quota", 0, { userId: 2 }));
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
      const inputs = Array.from({ length: 12 }, (_, index) => ruleInput("unlimited", index));
      const results = scenario === "limits" ? await importRules("unlimited", 12)
        : (await admin.createSniBatch({ rules: inputs })).results;
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
        const created = await create(input);
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
