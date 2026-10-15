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
const hostIds = ["import-benchmark", "import-ordinary", "import-order", "import-final-failure", "import-ports"].includes(scenario) && process.env.RULE_IMPORT_SAMPLE !== "sni3" ? [1, 2, 3, 4] : [1, 2, 3];
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
    if (scenario === "import-benchmark") {
      const sample = process.env.RULE_IMPORT_SAMPLE || "ordinary";
      const makeInput = (prefix, index) => ruleInput(prefix, index, sample.startsWith("sni") || (sample === "mixed" && index % 2)
        ? {} : { sni: null, sourcePort: (prefix === "seed" ? 20000 : 21000) + index, protocol: ["tcp", "udp", "both"][index % 3] });
      for (let index = 0; index < existingCount; index++) await admin.create(makeInput("seed", index));
      clearNotifications();
      const inputs = Array.from({ length: count }, (_, index) => makeInput("import", index));
      const start = performance.now();
      let results;
      if (process.env.FORWARDX_BATCH_IMPORT === "1") results = (await admin.createBatch({ rules: inputs })).results;
      else {
        results = new Array(inputs.length);
        await Promise.all([
          (async () => {
            const entries = inputs.map((item, index) => ({ item, index })).filter(({ item }) => item.sni);
            if (!entries.length) return;
            const batch = await admin.createSniBatch({ rules: entries.map(({ item }) => item) });
            entries.forEach(({ index }, position) => { results[index] = batch.results[position]; });
          })(),
          (async () => {
            const entries = inputs.map((item, index) => ({ item, index })).filter(({ item }) => !item.sni);
            const saved = await runBatchOperations(entries, 6, ({ item }) => admin.create(item));
            saved.forEach(result => { results[result.item.index] = result; });
          })(),
        ]);
      }
      const durationMs = Math.round(performance.now() - start);
      assert.ok(results.every(result => result.status === "fulfilled"), JSON.stringify(results));
      const roots = (await admin.list()).filter(rule => rule.forwardGroupId === 10);
      assert.equal(roots.length, existingCount + count);
      for (const hostId of hostIds) {
        const state = await heartbeat(hostId);
        const ordinary = roots.filter(rule => !rule.sni);
        for (const root of ordinary) assert.ok(state.runningRules.some(rule => rule.sourcePort === root.sourcePort && rule.targetPort === root.targetPort), "ordinary configuration missing on " + hostId);
        const sniRoots = roots.filter(rule => rule.sni);
        if (sniRoots.length) assert.equal(splitter(state).sniRoutes.length, sniRoots.length);
      }
      console.log("RULE_IMPORT_RESULT=" + JSON.stringify({ sample, existingCount, count, hosts: hostIds.length, durationMs, seedConfirmed: false, roots: roots.length, children: roots.length * hostIds.length, notifications: notificationCounts() }));
    } else if (scenario === "import-web") {
      const { createExpressMiddleware } = await import("@trpc/server/adapters/express");
      const { createTRPCClient, httpLink } = await import("@trpc/client");
      const { default: superjson } = await import("superjson");
      const { router } = await import("../_core/trpc.ts");
      const { runRuleImport } = await import("../../client/src/lib/ruleImport.ts");
      const { parseManualBulkImportText, parseSniBulkImportText, parseRuleTransferFile } = await import("../../client/src/lib/ruleTransfer.ts");
      const paths = [];
      app.use("/api/trpc", (req, _res, next) => { paths.push(req.path); next(); }, createExpressMiddleware({
        router: router({ rules: rulesRouter }), createContext: ({ req, res }) => ({ ...context(1, "admin"), req, res }),
      }));
      const client = createTRPCClient({ links: [httpLink({ url: "http://127.0.0.1:" + server.address().port + "/api/trpc", transformer: superjson })] });
      const manual = parseManualBulkImportText("example.net:443\nfixed#23001#203.0.113.10#443", { forwardType: "nftables", protocol: "both" });
      const sniText = parseSniBulkImportText("web-sni#web.example.test#203.0.113.10#443", 23443);
      assert.equal(manual.ok, true); assert.equal(sniText.ok, true);
      const variants = [[manual.rules, { fixedPortFirst: true }], [sniText.rules, {}]];
      for (const rules of [[manual.rules[1]], sniText.rules, [manual.rules[1], sniText.rules[0], manual.rules[0]]]) {
        const file = parseRuleTransferFile({ kind: "forwardx.forward-rules", version: 1, rules });
        assert.equal(file.ok, true);
        variants.push([file.file.rules, { retryPortConflicts: true }]);
      }
      const saved = [];
      for (const [position, [rules, options]] of variants.entries()) {
        const inputs = rules.map((rule, index) => ({ ...rule, name: "web-" + position + "-" + index, ...(rule.sni ? { sni: "web-" + position + "-" + index + ".example.test" } : rule.sourcePort ? { sourcePort: 23000 + position * 10 + index } : {}) }));
        const before = paths.length;
        const results = await runRuleImport(inputs, { createBatch: (items, flags) => client.rules.createBatch.mutate({ ...flags, rules: items.map(item => ({ ...item, forwardGroupId: 10 })) }) }, options);
        assert.deepEqual(paths.slice(before), ["/rules.createBatch"], "each webpage input makes exactly one real save request");
        assert.ok(results.every(result => result.status === "fulfilled"), JSON.stringify(results));
        for (const result of results) {
          const root = await admin.getById({ id: result.value.id });
          assert.equal(root.name, result.item.name);
          saved.push(root);
        }
      }
      for (const hostId of hostIds) {
        const state = await heartbeat(hostId);
        for (const rule of saved.filter(rule => !rule.sni)) assert.ok(state.runningRules.some(row => row.sourcePort === rule.sourcePort && row.targetPort === rule.targetPort));
        assert.equal(state.desiredState.actions.find(action => action.fxp?.role === "sni-splitter" && action.sourcePort === 23443).fxp.sniRoutes.length, 3);
      }
    } else if (scenario === "import-leading-failure") {
      const { withResourceTaskLock, keyedTaskDepth } = await import("../keyedTaskLock.ts");
      await insert("tunnels", { id: 20, name: "leading error route", entryHostId: 1, exitHostId: 3, mode: "tls", listenPort: 26000, userId: 1, isEnabled: 1 });
      let held, release;
      const ready = new Promise(resolve => { held = resolve; });
      const gate = new Promise(resolve => { release = resolve; });
      const moving = withResourceTaskLock("tunnel:20", async () => { held(); await gate; });
      await ready;
      const route = { forwardGroupId: null, tunnelId: 20, hostId: 1 };
      const saving = admin.createBatch({ rules: [ruleInput("bad-leading", 0, { ...route, sni: null, forwardType: "nftables", sourcePort: 22900 }), ruleInput("valid-after-leading", 0, { ...route, forwardType: "gost" })] });
      let settled = false;
      void saving.then(() => { settled = true; }, () => { settled = true; });
      let timer;
      try {
        const deadline = Date.now() + 2000;
        while (!settled && keyedTaskDepth("tunnel:20") < 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
        assert.equal(settled, false, "batch must wait for the selected tunnel even when its first item is invalid");
        await Promise.race([db.setSetting("leading-error-independent-write", "complete"), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("invalid first item let batch wait for its actual route while holding the database")), 1000); })]);
      } finally { clearTimeout(timer); release(); await moving; }
      const saved = await saving;
      assert.deepEqual(saved.results.map(result => result.status), ["rejected", "fulfilled"], JSON.stringify(saved));
      assert.equal((await admin.getById({ id: saved.results[1].value.id })).tunnelId, 20);
    } else if (scenario === "import-order") {
      await insert("users", { id: 3, username: "second-owner", password: "unused", role: "user", canAddRules: 1, manualCanAddRules: 1, balanceCents: 1000 });
      await db.setUserHostPermissions(3, hostIds);
      await db.setUserForwardGroupPermissions(3, [10]);
      await runtime.executeRaw('UPDATE users SET "maxRules" = 1, "manualMaxRules" = 1 WHERE id IN (2, 3)');
      await runtime.executeRaw(`CREATE TRIGGER reject_order_item AFTER INSERT ON forward_rules WHEN NEW."isForwardGroupTemplate" = 1 AND NEW."targetPort" = 19999 BEGIN SELECT RAISE(FAIL, 'item save failure'); END`);
      for (const [owner, sniFirst] of [[2, false], [3, true]]) {
        const inputs = [
          ruleInput("failed-owner" + owner, 0, { userId: owner, sni: null, sourcePort: 22300 + owner, targetPort: 19999 }),
          ruleInput("first-owner" + owner, 0, { userId: owner, sni: sniFirst ? "first-owner3.example.test" : null, sourcePort: 22300 + owner }),
          ruleInput("later-owner" + owner, 0, { userId: owner, sni: sniFirst ? null : "later-owner2.example.test", sourcePort: 22310 + owner }),
        ];
        const saved = await admin.createBatch({ rules: inputs });
        assert.deepEqual(saved.results.map(result => result.status), ["rejected", "fulfilled", "rejected"], JSON.stringify(saved));
        assert.match(saved.results[0].reason, /item save failure/);
        assert.match(saved.results[2].reason, /最大规则数量/);
        assert.equal((await admin.getById({ id: saved.results[1].value.id })).name, inputs[1].name);
      }
      const portCompetition = await admin.createBatch({ rules: [ruleInput("sni-first", 0, { sourcePort: 22400 }), ruleInput("plain-later", 0, { sni: null, sourcePort: 22400 }), ruleInput("sni-shared", 0, { sourcePort: 22400 }), ruleInput("plain-first", 0, { sni: null, sourcePort: 22401 }), ruleInput("sni-later", 0, { sourcePort: 22401 }), ruleInput("plain-duplicate", 0, { sni: null, sourcePort: 22401 })] });
      assert.deepEqual(portCompetition.results.map(result => result.status), ["fulfilled", "rejected", "fulfilled", "fulfilled", "rejected", "rejected"], JSON.stringify(portCompetition));
      const userInputs = [ruleInput("user-normal", 0, { sni: null, sourcePort: 22410 }), ruleInput("user-denied", 0), ruleInput("user-normal", 1, { sni: null, sourcePort: 22411 })].map(rule => ({ ...rule, ...Object.fromEntries(Object.keys(zeroLimits).map(key => [key, undefined])) }));
      await runtime.executeRaw('UPDATE users SET "maxRules" = 0, "manualMaxRules" = 0 WHERE id = 2');
      const userResults = await customer.createBatch({ rules: userInputs });
      assert.deepEqual(userResults.results.map(result => result.status), ["fulfilled", "rejected", "fulfilled"], JSON.stringify(userResults));
      assert.match(userResults.results[1].reason, /仅管理员/);
      await assert.rejects(admin.createBatch({ rules: [] }));
      await assert.rejects(admin.createBatch({ rules: Array.from({ length: 501 }, (_, index) => ruleInput("too-many", index)) }));
      await assert.rejects(admin.createBatch({ rules: [ruleInput("same", 0), ruleInput("different", 0, { forwardGroupId: 99 })] }), /同一个/);
    } else if (scenario === "import-final-failure") {
      const keptPlain = await admin.create(ruleInput("kept-plain", 0, { sni: null, sourcePort: 22500 }));
      const keptSni = await admin.create(ruleInput("kept-sni", 0));
      await runtime.executeRaw('UPDATE forward_rules SET "quotaUsedIn" = 123, "quotaUsedOut" = 456 WHERE id = ?', [keptPlain.id]);
      clearNotifications();
      await runtime.executeRaw(`CREATE TRIGGER reject_mixed_final BEFORE INSERT ON forward_rules WHEN NEW."hostId" = 3 AND NEW."isForwardGroupTemplate" = 0 AND NEW."targetPort" = 19999 BEGIN SELECT RAISE(ABORT, 'mixed final failure'); END`);
      const inputs = [ruleInput("new-plain", 0, { sni: null, sourcePort: 22501 }), ruleInput("new-sni", 0, { targetPort: 19999 })];
      await assert.rejects(admin.createBatch({ rules: inputs }), /mixed final failure/);
      assert.deepEqual((await admin.list()).map(rule => rule.id).sort((a, b) => a - b), [keptPlain.id, keptSni.id]);
      for (const counts of Object.values(notificationCounts())) assert.deepEqual(counts, {});
      assert.equal((await admin.getById({ id: keptPlain.id })).quotaUsedOut, 456);
      await runtime.executeRaw('DROP TRIGGER reject_mixed_final');
      await runtime.executeRaw('CREATE TABLE mixed_commit_guard (id INTEGER REFERENCES users(id) DEFERRABLE INITIALLY DEFERRED)');
      await runtime.executeRaw(`CREATE TRIGGER reject_mixed_commit AFTER INSERT ON forward_rules WHEN NEW."targetPort" = 19998 BEGIN INSERT INTO mixed_commit_guard VALUES (999999); END`);
      await assert.rejects(admin.createBatch({ rules: [inputs[0], { ...inputs[1], targetPort: 19998 }] }), /FOREIGN KEY/);
      assert.equal((await admin.list()).length, 2);
      for (const counts of Object.values(notificationCounts())) assert.deepEqual(counts, {});
      await runtime.executeRaw('DROP TRIGGER reject_mixed_commit');
      for (const hostId of hostIds) {
        const state = await heartbeat(hostId);
        assert.deepEqual(splitter(state).sniRoutes.map(route => route.sni), ["kept-sni-0.example.test"]);
        assert.ok(state.runningRules.some(rule => rule.sourcePort === 22500));
        assert.ok(!state.runningRules.some(rule => rule.sourcePort === 22501));
      }
      const retried = await admin.createBatch({ rules: [inputs[0], { ...inputs[1], targetPort: 19443 }] });
      assert.ok(retried.results.every(result => result.status === "fulfilled"), JSON.stringify(retried));
    } else if (scenario === "import-usage") {
      const inputs = [ruleInput("managed-plain", 0, { sni: null, sourcePort: 22800, userId: 2, rateLimitMbps: 8, trafficLimit: 1000 }), ruleInput("managed-sni", 0, { userId: 2 })];
      const { results } = await admin.createBatch({ rules: inputs });
      assert.ok(results.every(result => result.status === "fulfilled"), JSON.stringify(results));
      const id = results[0].value.id;
      await assert.rejects(customer.update({ id, name: "forbidden" }), /仅可查看/);
      const children = await db.getForwardGroupChildRulesForTemplate(id);
      const report = (hostId, bytesOut) => agentPost(hostId, "traffic", { reportId: "ordinary-first-" + hostId, reportProducerId: "ordinary-usage", stats: [{ ruleId: children.find(child => child.hostId === hostId).id, bytesIn: 10, bytesOut, connections: 1 }] });
      await report(1, 200); await report(2, 300); await report(1, 200);
      const saved = await customer.getById({ id });
      assert.equal(saved.quotaUsedIn, 20);
      assert.equal(saved.quotaUsedOut, 500);
      assert.equal(saved.ruleLimitReason, null);
      const state = await heartbeat(1);
      assert.ok(state.runningRules.some(rule => rule.sourcePort === 22800));
      assert.equal(saved.rateLimitMbps, 8);
      assert.equal(state.guardRules.find(rule => rule.listenPort === 22800).limitIn, 1_000_000);
      const added = await admin.createBatch({ rules: [ruleInput("after-usage", 0, { sni: null, sourcePort: 22801 })] });
      assert.equal(added.results[0].status, "fulfilled");
      assert.equal((await customer.getById({ id })).quotaUsedOut, 500);
      await admin.update({ id, trafficLimit: 400 });
      assert.equal((await customer.getById({ id })).ruleLimitReason, "traffic_limit");
    } else if (scenario === "import-ports") {
      Math.random = () => 0;
      await runtime.executeRaw('UPDATE hosts SET "portRangeStart" = 22000, "portRangeEnd" = 22001');
      const ordinary = (index, port) => ruleInput("ports", index, { sni: null, sourcePort: port });
      const manual = await admin.createBatch({ rules: [ordinary(0, 0), ordinary(1, 22000)], fixedPortFirst: true });
      assert.deepEqual(manual.results.map(result => result.status), ["fulfilled", "fulfilled"], JSON.stringify(manual));
      assert.deepEqual(manual.results.map(result => result.value.sourcePort), [22001, 22000]);
      const conflict = await admin.createBatch({ rules: [ordinary(2, 22000)] });
      assert.equal(conflict.results[0].status, "rejected", "manual fixed ports never silently change");
      await runtime.executeRaw('UPDATE hosts SET "portRangeEnd" = 22006');
      const file = await admin.createBatch({ retryPortConflicts: true, rules: [ordinary(3, 22000), ordinary(4, 45000), ruleInput("no-sni-retry", 0, { sourcePort: 22000 }), ordinary(5, 22005), ordinary(6, 22005)] });
      assert.deepEqual(file.results.map(result => result.status), ["fulfilled", "fulfilled", "rejected", "fulfilled", "fulfilled"], JSON.stringify(file));
      assert.deepEqual(file.results.filter(result => result.status === "fulfilled").map(result => result.value.sourcePort), [22002, 22003, 22005, 22004]);
      await runtime.executeRaw('UPDATE hosts SET "portRangeEnd" = 22007');
      const mixed = await admin.createBatch({ rules: [ruleInput("auto-after-sni", 0, { sourcePort: 22006 }), ordinary(7, 0)] });
      assert.deepEqual(mixed.results.map(result => result.status), ["fulfilled", "fulfilled"], JSON.stringify(mixed));
      assert.equal(mixed.results[1].value.sourcePort, 22007);
    } else if (scenario === "import-ordinary") {
      const inputs = [ruleInput("ordinary", 0, { sni: null, sourcePort: 22000, rateLimitMbps: undefined, trafficLimit: undefined, trafficMode: undefined, expiresAt: undefined }), ruleInput("ordinary", 1, { sni: null, sourcePort: 22001, protocol: "udp", rateLimitMbps: undefined, trafficLimit: undefined, trafficMode: undefined, expiresAt: undefined })];
      const { results } = await customer.createBatch({ rules: inputs });
      assert.deepEqual(results.map(result => result.status), ["fulfilled", "fulfilled"], JSON.stringify(results));
      for (const result of results) {
        const saved = await customer.getById({ id: result.value.id });
        assert.equal(saved.userId, 2);
        assert.equal(saved.adminManaged, false);
      }
      for (const hostId of hostIds) {
        const state = await heartbeat(hostId);
        assert.ok(state.runningRules.some(rule => rule.sourcePort === 22000 && rule.protocol === "tcp"));
        assert.ok(state.runningRules.some(rule => rule.sourcePort === 22001 && rule.protocol === "udp"));
      }
    } else if (scenario === "batch-live-connection") {
      const { verifyBatchKeepsConnection } = await import("./sniLiveConnection.mjs");
      await verifyBatchKeepsConnection(async target => {
        await admin.create(ruleInput("live-kept", 0, target));
        const before = splitter(await heartbeat(1));
        return { before, importBatch: async () => {
          const imported = await admin.createSniBatch({ rules: Array.from({ length: 12 }, (_, index) => ruleInput("live-added", index, target)) });
          assert.ok(imported.results.every(result => result.status === "fulfilled"), JSON.stringify(imported));
          return splitter(await heartbeat(1));
        } };
      });
    } else if (scenario === "batch-group") {
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
    } else if (["batch-port", "batch-chain", "batch-tunnel"].includes(scenario) || scenario.startsWith("import-resource-")) {
      const generic = scenario.startsWith("import-resource-");
      const kind = generic ? scenario.slice("import-resource-".length) : scenario.slice(6);
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
      if (generic) {
        Object.assign(inputs[0], { sni: null, sourcePort: 22400, protocol: "udp" });
        Object.assign(inputs[3], { sni: null, sourcePort: 22401, protocol: "both" });
      }
      inputs[1].sni = keptInput.sni;
      inputs[4].sni = inputs[2].sni;
      const { results } = await (generic ? admin.createBatch({ rules: inputs }) : admin.createSniBatch({ rules: inputs }));
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
      const sniExpected = expected.filter(input => input.sni);
      assert.equal(exit.fxp.sniRoutes.length, sniExpected.length);
      for (const input of sniExpected) {
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
        assert.equal(entry.fxp.sniRoutes.length, sniExpected.length);
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
      for (const input of expected.filter(input => !input.sni)) {
        for (const id of kind === "port" ? [1] : kind === "chain" ? [4, 5] : [1, 4, 5]) {
          assert.ok(states.get(id).runningRules.some(rule => rule.sourcePort === input.sourcePort && rule.protocol === input.protocol), "ordinary entry configuration missing on " + id);
        }
        assert.ok(states.get(kind === "port" ? 1 : 3).runningRules.some(rule => rule.targetPort === input.targetPort), "ordinary final target missing");
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
    } else if (scenario === "batch-billing-concurrency") {
      const { keyedTaskDepth, trafficBillingUserLockKey, withTrafficBillingUserLock } = await import("../keyedTaskLock.ts");
      const old = await admin.create(ruleInput("removed", 0));
      await db.markForwardRulePendingDelete(old.id);
      let releaseReport;
      const reportGate = new Promise(resolve => { releaseReport = resolve; });
      let reportHeld;
      const held = new Promise(resolve => { reportHeld = resolve; });
      const report = withTrafficBillingUserLock(1, async () => {
        reportHeld();
        await reportGate;
        // Agent reports acquire affected users in ascending order.
        await withTrafficBillingUserLock(2, () => db.setSetting("multi-user-report", "complete"));
      });
      await held;
      const batch = admin.createSniBatch({ rules: [ruleInput("other-owner", 0, { userId: 2 })] });
      const deadline = Date.now() + 5000;
      while (keyedTaskDepth(trafficBillingUserLockKey(1)) < 2 && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      assert.equal(keyedTaskDepth(trafficBillingUserLockKey(1)), 2, "cleanup must reach the old owner's billing queue");
      releaseReport();
      let timer;
      try {
        const [saved] = await Promise.race([
          Promise.all([batch, report]),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("batch cleanup and traffic report deadlocked")), 2000); }),
        ]);
        assert.equal(saved.results[0].status, "fulfilled");
        assert.equal(await db.getSetting("multi-user-report"), "complete");
      } finally { clearTimeout(timer); }
    } else if (scenario === "batch-concurrency" || scenario === "import-concurrency") {
      const generic = scenario === "import-concurrency";
      const createBatch = input => generic ? admin.createBatch(input) : admin.createSniBatch(input);
      const { withResourceTaskLock, withTrafficBillingUserLock } = await import("../keyedTaskLock.ts");
      const deferred = () => {
        let resolve;
        const promise = new Promise(done => { resolve = done; });
        return { promise, resolve };
      };
      const held = deferred(); const release = deferred();
      const billing = withTrafficBillingUserLock(2, async () => { held.resolve(); await release.promise; });
      await held.promise;
      const waiting = createBatch({ rules: [ruleInput("billing", 0, { userId: 2 })] });
      await new Promise(resolve => setImmediate(resolve));
      // The batch must wait before owning SQLite, so independent writes finish.
      await db.setSetting("batch-independent-write", "available");
      release.resolve(); await billing;
      assert.equal((await waiting).results[0].status, "fulfilled");
      const concurrent = await Promise.all([
        createBatch({ rules: [ruleInput("race", 0), ruleInput("unique", 0)] }),
        createBatch({ rules: [ruleInput("race", 0, { sourcePort: 18444 }), ruleInput("unique", 1)] }),
        admin.create(ruleInput("single", 0)),
      ]);
      const outcomes = concurrent.slice(0, 2).flatMap(item => item.results);
      assert.equal(outcomes.filter(item => item.status === "fulfilled").length, 3, JSON.stringify(concurrent));
      assert.equal(outcomes.filter(item => item.status === "rejected").length, 1);
      if (generic) {
        const plain = index => ruleInput("plain-race", index, { sni: null, sourcePort: 22600 });
        const raced = await Promise.allSettled([
          admin.createBatch({ rules: [plain(0), ruleInput("mixed-race", 0)] }),
          admin.createBatch({ rules: [plain(1), ruleInput("plain-after-race", 0, { sni: null, sourcePort: 22601 })] }),
          admin.create(plain(2)),
        ]);
        const outcomes = raced.flatMap(result => result.status === "fulfilled" && result.value.results ? result.value.results : [result]);
        assert.equal(outcomes.filter(result => result.status === "fulfilled").length, 3, JSON.stringify(raced));
        assert.equal((await admin.list()).filter(rule => rule.sourcePort === 22600).length, 1);
      }
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
      const pending = createBatch({ rules: [ruleInput("occupied", 0, generic ? { sni: null, sourcePort: 18445 } : {})] });
      await new Promise(resolve => setTimeout(resolve, 25));
      groupRelease.resolve(); await moving;
      const afterMove = await pending;
      assert.equal(afterMove.results[0].status, "rejected");
      assert.match(afterMove.results[0].reason, generic ? /端口|port/ : /SNI|域名/);
      assert.equal((await createBatch({ rules: [ruleInput("after-move", 0)] })).results[0].status, "fulfilled");
    } else if (scenario.startsWith("batch-failure-") || scenario.startsWith("import-failure-")) {
      const generic = scenario.startsWith("import-failure-");
      const kind = scenario.split("-").at(-1);
      const createBatch = input => generic ? admin.createBatch(input) : admin.createSniBatch(input);
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
      if (generic) for (const index of [0, 2]) Object.assign(inputs[index], { sni: null, sourcePort: 22700 + index });
      const { results } = await createBatch({ rules: inputs });
      assert.deepEqual(results.map(result => result.status), ["rejected", "fulfilled", "fulfilled", "rejected", "fulfilled"], JSON.stringify(results));
      assert.equal((await admin.list()).length, 4);
      await runtime.executeRaw('DROP TRIGGER reject_item');
      await runtime.executeRaw('CREATE TABLE batch_commit_guard (id INTEGER REFERENCES users(id) DEFERRABLE INITIALLY DEFERRED)');
      await runtime.executeRaw(`CREATE TRIGGER reject_commit AFTER INSERT ON forward_rules WHEN NEW."targetPort" = 19998 BEGIN INSERT INTO batch_commit_guard VALUES (999999); END`);
      clearNotifications();
      await assert.rejects(createBatch({ rules: [ruleInput("commit", 0, { ...route, ...(generic ? { sni: null, sourcePort: 22710 } : {}) }), ruleInput("commit", 1, { ...route, targetPort: 19998 })] }), /FOREIGN KEY/);
      assert.equal((await admin.list()).length, 4);
      assert.equal((await admin.getById({ id: kept.id })).targetPort, 19443);
      for (const counts of Object.values(notificationCounts())) assert.deepEqual(counts, {});
      const exitHost = kind === "port" ? 1 : 3;
      const state = await heartbeat(exitHost);
      const domains = state.desiredState.actions.flatMap(action => action.fxp?.sniRoutes || []).map(item => item.sni).sort();
      assert.deepEqual(domains, generic ? ["items-1.example.test", "items-4.example.test", "kept-0.example.test"] : ["items-1.example.test", "items-2.example.test", "items-4.example.test", "kept-0.example.test"]);
      if (generic) assert.ok(state.runningRules.some(rule => rule.targetPort === 19445), "ordinary successful item remains complete after later rollback");
      await runtime.executeRaw('DROP TRIGGER reject_commit');
      assert.equal((await createBatch({ rules: [ruleInput("retry", 0, route)] })).results[0].status, "fulfilled");
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
