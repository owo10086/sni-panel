// Acceptance seam: management callers, encrypted Agent HTTP, and a DDNS webhook.
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import express from "express";
import { mock } from "node:test";

const scenario = process.argv[2] || "baseline";
const clockFile = process.env.FORWARDX_TEST_DB + ".clock";
const resuming = scenario.endsWith("-resume");
const realSetTimeout = globalThis.setTimeout;
mock.timers.enable({ apis: ["Date", "setTimeout"], now: resuming
  ? Number(fs.readFileSync(clockFile, "utf8")) : Math.floor(Date.now() / 1000) * 1000 });
const runtime = await import("../dbRuntime.ts");
const { ensureDatabaseSchema } = await import("../dbSchema.ts");
const { rulesRouter } = await import("../routers/rules.ts");
const { forwardGroupsRouter } = await import("../routers/forwardGroups.ts");
const { registerAgentHeartbeatRoute } = await import("../agentHeartbeatRoute.ts");
const { registerAgentReportRoutes } = await import("../agentReportRoutes.ts");
const { registerAgentStatusRoutes } = await import("../agentStatusRoutes.ts");
const { agentEncryptionMiddleware } = await import("../agentEncryptionMiddleware.ts");
const { encryptPayload, decryptPayload } = await import("../agentCrypto.ts");
const { setSettings } = await import("../repositories/settingsRepository.ts");
const context = { req: { headers: {} }, res: { clearCookie() {} }, user: { id: 1, username: "admin", role: "admin", accountEnabled: true }, authSession: null, authFailureReason: null };
const rules = rulesRouter.createCaller(context);
const groups = forwardGroupsRouter.createCaller(context);
const app = express();
app.use(express.json());
app.use((req, res, next) => req.path.startsWith("/api/agent/") ? agentEncryptionMiddleware(req, res, next) : next());
registerAgentHeartbeatRoute(app);
registerAgentReportRoutes(app);
registerAgentStatusRoutes(app);
const requests = [];
let dnsFailure = false;
let onDns = async () => {};
app.post("/test-ddns", async (req, res) => {
  requests.push({ ...req.body, at: Date.now() });
  await onDns(req.body);
  res.status(dnsFailure ? 503 : 200).json(dnsFailure ? { error: "simulated DDNS failure" } : { success: true });
});
const server = http.createServer(app);
const insert = (table, values) => runtime.executeRaw(
  'INSERT INTO "' + table + '" (' + Object.keys(values).map(key => '"' + key + '"').join(",") + ') VALUES (' + Object.keys(values).map(() => "?").join(",") + ')', Object.values(values));
let groupId = 1;
const reports = new Map();
const processes = new Map();
const post = async (id, route, payload) => {
  const token = "token-" + id;
  const response = await fetch("http://127.0.0.1:" + server.address().port + "/api/agent/" + route, {
    method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" },
    body: JSON.stringify(encryptPayload(payload, token)),
  });
  assert.equal(response.status, 200, await response.clone().text());
  return decryptPayload(await response.json(), token);
};
const heartbeat = (id, localRules = reports.get(id), extra = {}) => post(id, "heartbeat", {
  agentVersion: "2.2.195", agentBootId: "boot-" + id, agentProcessId: processes.get(id) || 1000 + id,
  forceReconcile: true, ...(localRules === undefined ? {} : { localState: { rules: localRules } }), ...extra,
});
const presence = id => post(id, "presence", {});
const state = async () => (await groups.list()).find(group => group.id === groupId);
const member = async id => (await state()).members.find(entry => entry.hostId === id);
const runningReports = reply => (reply.runningRules || []).filter(rule => Number(rule.ruleId) > 0).map(rule => ({
  ruleId: rule.ruleId, port: rule.sourcePort, targetIp: rule.targetIp, targetPort: rule.targetPort,
  forwardType: rule.forwardType, protocol: rule.protocol, ready: true,
}));
const confirm = async id => {
  const reply = await heartbeat(id);
  reports.set(id, runningReports(reply));
  assert.ok(reports.get(id).length, "ordinary group must send an expected runtime configuration");
  await heartbeat(id);
};
const settle = async () => {
  for (let round = 0; round < 5; round++) {
    mock.timers.tick(100);
    await new Promise(resolve => realSetTimeout(resolve, 15));
  }
};
const advance = async (seconds, { online = [1, 2], renew = [] } = {}) => {
  for (const id of online) await presence(id);
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const step = Math.min(10, (deadline - Date.now()) / 1000);
    mock.timers.tick(step * 1000);
    for (const id of online) await presence(id);
    for (const id of renew) await heartbeat(id);
    await settle();
  }
};
const createRule = (sourcePort = 18100) => rules.create({ forwardGroupId: groupId, name: "ordinary-" + sourcePort,
  sourcePort, targetIp: "203.0.113.10", targetPort: 8080, protocol: "tcp", forwardType: "nftables", isEnabled: true });
const configureDdns = (ttl = 60) => setSettings({ ddnsEnabled: "true", ddnsProvider: "webhook",
  ddnsWebhookUrl: "http://127.0.0.1:" + server.address().port + "/test-ddns", ddnsWebhookMethod: "POST", ddnsTtl: String(ttl) });
const expectDns = async hostId => {
  const current = await state();
  assert.equal(current.lastDdnsValue, "127.0.0." + hostId);
  assert.equal(current.members.find(entry => entry.id === current.activeMemberId)?.hostId, hostId);
};
const expectOldConfiguration = async (retained, message) => {
  const reply = await heartbeat(1);
  assert.equal((reply.runningRules || []).some(rule => rule.sourcePort === 18100), retained, message);
};
const order = async ids => groups.reorder({ groupId, memberIds: await Promise.all(ids.map(async id => (await member(id)).id)) });
const rootRule = async (port = 18100) => (await rules.list()).find(rule => rule.forwardGroupId === groupId && rule.sourcePort === port && rule.isForwardGroupTemplate);
const members = (ids, disabled = []) => ids.map((id, priority) => ({ memberType: "host", hostId: id, priority, isEnabled: !disabled.includes(id) }));
const ruleStatus = (id, running, message, report = reports.get(id)?.[0]) => post(id, "rule-status", {
  ruleId: report.ruleId, isRunning: running, ...(message ? { message } : {}),
});
const removeCurrent = () => groups.updateFields({ id: groupId, members: members([2]) });
const disableCurrent = () => groups.updateFields({ id: groupId, members: members([1, 2], [1]) });
const tickUntil = async (deadline, options) => {
  const remaining = Math.max(0, deadline - Date.now());
  await advance(remaining / 1000, options);
};

try {
  await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
  await ensureDatabaseSchema();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  if (!resuming) {
    await insert("users", { id: 1, username: "admin", password: "x", role: "admin", canAddRules: 1, manualCanAddRules: 1 });
    const now = Math.floor(Date.now() / 1000);
    for (const id of [1, 2, 3]) await insert("hosts", { id, name: "ordinary-entry-" + id, ip: "127.0.0." + id,
      ipv4: "127.0.0." + id, agentToken: "token-" + id, userId: 1, isOnline: 1, lastHeartbeat: now,
      agentVersion: "2.2.195", portRangeStart: 18000, portRangeEnd: 19000 });
    const created = await groups.create({ name: "ordinary standby", groupType: "host", groupMode: "failover",
      forwardType: "nftables", protocol: "tcp", domain: "", failoverSeconds: 17, recoverSeconds: 23,
      autoFailback: false, members: [1, 2].map((id, priority) => ({ memberType: "host", hostId: id, priority, isEnabled: true })) });
    groupId = created.id;
    await createRule();
    for (const id of [1, 2]) await confirm(id);
    if (scenario !== "new-group") await advance(25, { renew: [1, 2] });
    await configureDdns();
    await groups.updateFields({ id: groupId, domain: "ordinary.example.test" });
    await groups.runFailover();
    await expectDns(1);
    assert.equal((await member(1)).healthStatus, "healthy", "baseline ordinary current entry must be healthy");
    assert.equal((await member(2)).healthStatus, "healthy", "baseline ordinary backup must be healthy");
  }
  if (scenario === "baseline") {
    const before = requests.length;
    await groups.updateFields({ id: groupId, name: "renamed standby" });
    await groups.runFailover();
    await expectDns(1);
    assert.equal(requests.length, before, "name-only save does not republish unchanged DNS");
    await heartbeat(1);
    await heartbeat(2);
    await groups.runFailover();
    await expectDns(1);
  }
  if (scenario === "add-rule") {
    await createRule(18101);
    await groups.runFailover();
    assert.notEqual((await member(1)).healthStatus, "healthy", "unreported new rule blocks readiness");
    assert.equal((await state()).lastDdnsValue, "127.0.0.1", "pending deployment retains old DNS");
    for (const id of [1, 2]) await confirm(id);
    await groups.runFailover();
    await groups.reorder({ groupId, memberIds: [(await member(2)).id, (await member(1)).id] });
    await expectDns(2);
  }
  if (scenario === "new-group") {
    assert.deepEqual(requests.at(-1).values, ["127.0.0.1"], "a newly created group's confirmed first entry is published immediately");
  }
  if (scenario === "edit-rule") {
    await rules.update({ id: (await rootRule()).id, targetPort: 8081 });
    assert.equal((await state()).lastDdnsValue, "127.0.0.1");
    for (const id of [1, 2]) await confirm(id);
    await order([2, 1]);
    await expectDns(2);
  }
  if (scenario === "delete-rule") {
    const added = await createRule(18101);
    for (const id of [1, 2]) await confirm(id);
    await advance(25, { renew: [1, 2] });
    await rules.delete({ id: added.id });
    await order([2, 1]);
    await expectDns(2);
  }
  if (scenario === "delete-billing-concurrency") {
    const taskLocks = await import("../keyedTaskLock.ts");
    const billingKey = taskLocks.trafficBillingUserLockKey(1);
    let releaseBilling;
    let billingReady;
    const released = new Promise(resolve => { releaseBilling = resolve; });
    const started = new Promise(resolve => { billingReady = resolve; });
    const billing = taskLocks.withKeyedTaskLock(billingKey, async () => {
      billingReady();
      await released;
    });
    await started;
    const deletion = rules.delete({ id: (await rootRule()).id });
    try {
      for (let attempt = 0; attempt < 200 && taskLocks.keyedTaskDepth(billingKey) < 2; attempt++) {
        await new Promise(resolve => realSetTimeout(resolve, 5));
      }
      assert.equal(taskLocks.keyedTaskDepth(billingKey), 2, "template deletion must queue behind the existing traffic billing operation");
      const independentWrite = runtime.withDatabaseTransaction(() => runtime.executeRaw(
        'UPDATE "forward_groups" SET "name" = ? WHERE "id" = ?', ["billing operation completed its write", groupId],
      ));
      const databaseAvailable = await Promise.race([
        independentWrite.then(() => true), new Promise(resolve => realSetTimeout(() => resolve(false), 500)),
      ]);
      releaseBilling();
      await Promise.all([billing, deletion, independentWrite]);
      assert.equal(databaseAvailable, true, "ordinary template deletion must not wait for traffic billing while holding the database transaction");
      assert.equal((await state()).templateRuleCount, 0, "deletion completes after the queued billing operation releases its lock");
    } finally {
      releaseBilling();
      await Promise.allSettled([billing, deletion]);
    }
  }
  if (scenario === "domain") {
    await groups.updateFields({ id: groupId, domain: "renamed.example.test" });
    assert.equal(requests.at(-1).domain, "renamed.example.test");
    assert.deepEqual(requests.at(-1).values, ["127.0.0.1"]);
  }
  if (scenario === "new-member") {
    await groups.updateFields({ id: groupId, members: members([1, 2, 3]) });
    await confirm(3);
    await order([3, 1, 2]);
    await expectDns(3);
  }
  if (scenario === "edit-timeout" || scenario === "continuous-edit") {
    const added = await createRule(18101);
    const started = Date.now();
    await advance(10);
    if (scenario === "continuous-edit") {
      await rules.update({ id: added.id, targetPort: 8081 });
      await createRule(18102);
    }
    await tickUntil(started + 19_000);
    await groups.runFailover();
    assert.equal((await state()).lastStatus, "down", "deployment timeout is a real failure at the original failure deadline");
    for (const id of [1, 2]) await confirm(id);
    if (scenario === "continuous-edit") {
      await rules.update({ id: added.id, targetPort: 8082 });
      for (const id of [1, 2]) await confirm(id);
    }
    await order([2, 1]);
    assert.equal((await state()).lastDdnsValue, "127.0.0.1", "a timed-out adjustment cannot erase required recovery");
    await advance(25, { renew: [1, 2] });
    await expectDns(2);
  }
  if (scenario === "independent-deadlines") {
    await createRule(18101);
    const started = Date.now();
    await advance(10);
    await createRule(18102);
    for (const id of [1, 2]) {
      reports.set(id, runningReports(await heartbeat(id)).filter(report => report.port !== 18102));
      await heartbeat(id);
    }
    await settle();
    await tickUntil(started + 20_000);
    for (const id of [1, 2]) await confirm(id);
    await order([2, 1]);
    await expectDns(2);
  }
  if (scenario === "agent-restart" || scenario === "agent-offline") {
    if (scenario === "agent-restart") {
      processes.set(2, 2002);
      await heartbeat(2);
      await groups.runFailover();
    } else {
      await advance(200, { online: [1], renew: [1] });
      await groups.runFailover();
      await heartbeat(2);
    }
    await createRule(18101);
    for (const id of [1, 2]) await confirm(id);
    await order([2, 1]);
    await expectDns(1);
    await advance(25, { renew: [1, 2] });
    await expectDns(2);
  }
  if (scenario === "explicit-failure" || scenario === "unrelated-failure" || scenario === "reused-adjustment") {
    if (scenario === "reused-adjustment") {
      await createRule(18101);
      for (const id of [1, 2]) await confirm(id);
    } else if (scenario === "explicit-failure") {
      await createRule(18101);
      await confirm(1);
      reports.set(2, runningReports(await heartbeat(2)));
    }
    const failedReport = scenario === "explicit-failure" ? reports.get(2).find(report => report.port === 18101) : reports.get(2)[0];
    await ruleStatus(2, false, scenario === "explicit-failure" ? "bind failed" : undefined, failedReport);
    await groups.runFailover();
    if (scenario === "unrelated-failure") await groups.updateFields({ id: groupId, domain: "unrelated.example.test" });
    await ruleStatus(2, true, undefined, failedReport);
    await order([2, 1]);
    await expectDns(1);
    await advance(25, { renew: [1, 2] });
    await expectDns(2);
  }
  if (["remove-current", "disable-current", "remove-redeploy", "fallback", "ddns-failure", "old-ttl", "late-switch", "retirement-prepare"].includes(scenario)) {
    if (scenario === "old-ttl" || scenario === "retirement-prepare") {
      await configureDdns(600);
      await groups.updateFields({ id: groupId, domain: "ttl-baseline.example.test" });
      await groups.updateFields({ id: groupId, domain: "ordinary.example.test" });
      if (scenario === "old-ttl") await configureDdns(60);
    }
    if (["remove-redeploy", "fallback", "late-switch"].includes(scenario)) {
      await rules.update({ id: (await rootRule()).id, targetPort: 8081 });
      await confirm(1);
    }
    dnsFailure = scenario === "ddns-failure";
    const started = Date.now();
    if (dnsFailure) await assert.rejects(removeCurrent, /配置已保存|DDNS|simulated/);
    else await (scenario === "disable-current" ? disableCurrent() : removeCurrent());
    assert.equal((await state()).members.filter(entry => entry.isEnabled).length, 1);
    if (scenario !== "disable-current") assert.deepEqual((await state()).members.map(entry => entry.hostId), [2]);
    await expectOldConfiguration(true, "the removed entrance remains in Agent desired runtime during handover");
    if (["remove-redeploy", "fallback", "late-switch"].includes(scenario)) {
      assert.equal((await state()).lastDdnsValue, "127.0.0.1", "unready replacement retains working old DNS");
    }
    if (scenario === "fallback" || scenario === "ddns-failure") {
      if (scenario === "ddns-failure") {
        await tickUntil(started + 120_000, { renew: [2] });
        await groups.updateFields({ id: groupId, name: "retry does not restart fallback" }).catch(() => undefined);
      }
      await tickUntil(started + 295_000, { renew: scenario === "ddns-failure" ? [2] : [] });
      await expectOldConfiguration(true, "no switch retains original entrance up to the original five-minute fallback");
      await tickUntil(started + 302_000, { renew: scenario === "ddns-failure" ? [2] : [] });
      await groups.runFailover().catch(() => undefined);
      await expectOldConfiguration(false, "unpublished replacement cannot preserve removed entrance beyond five minutes");
    } else {
      if (scenario === "late-switch") {
        await configureDdns(600);
        await advance(210);
        await confirm(2);
        await settle();
        await advance(25, { renew: [2] });
      }
      if (scenario === "remove-redeploy") await confirm(2);
      await groups.runFailover();
      await expectDns(2);
      assert.deepEqual(requests.at(-1).values, ["127.0.0.2"]);
      const switchedAt = requests.filter(request => request.values?.includes("127.0.0.2")).at(0).at;
      const ttl = ["old-ttl", "late-switch", "retirement-prepare"].includes(scenario) ? 600 : 60;
      if (scenario === "retirement-prepare") {
        await configureDdns(60);
        fs.writeFileSync(clockFile, String(Date.now()));
        fs.writeFileSync(clockFile + ".deadline", String(switchedAt + ttl * 1000));
      } else {
        await tickUntil(switchedAt + (ttl - 5) * 1000, { renew: [2] });
        await expectOldConfiguration(true, "old DNS cache users retain their entry until the TTL snapshot expires");
        await groups.sync({ id: groupId });
        await tickUntil(switchedAt + (ttl + 2) * 1000, { renew: [2] });
        await groups.runFailover();
        await expectOldConfiguration(false, "successful repeat syncs do not extend the fixed retirement deadline");
      }
    }
  }
  if (scenario === "retirement-resume") {
    await configureDdns(60);
    for (const id of [1, 2]) await confirm(id);
    const deadline = Number(fs.readFileSync(clockFile + ".deadline", "utf8"));
    await tickUntil(deadline - 5000, { renew: [2] });
    await expectOldConfiguration(true, "panel restart and smaller TTL do not shorten the persisted cache deadline");
    await tickUntil(deadline + 2000, { renew: [2] });
    await groups.runFailover();
    await expectOldConfiguration(false, "panel restart resumes the original retirement deadline");
  }
  if (scenario === "reorder-pending" || scenario === "reorder-ddns-failure" || scenario === "reorder-recovery" || scenario === "reorder-prepare") {
    if (scenario === "reorder-pending" || scenario === "reorder-ddns-failure") {
      await rules.update({ id: (await rootRule()).id, targetPort: 8081 });
      await confirm(1);
    } else {
      await ruleStatus(2, false, "runtime failed");
      await groups.runFailover();
    }
    await order([2, 1]);
    await expectDns(1);
    dnsFailure = scenario === "reorder-ddns-failure";
    await confirm(2);
    await groups.runFailover().catch(() => undefined);
    if (scenario === "reorder-ddns-failure") {
      assert.equal((await state()).lastDdnsValue, "127.0.0.1");
      dnsFailure = false;
      await groups.runFailover();
    }
    if (scenario === "reorder-recovery" || scenario === "reorder-prepare") {
      await expectDns(1);
      if (scenario === "reorder-prepare") fs.writeFileSync(clockFile, String(Date.now()));
      else {
        await advance(25, { renew: [1, 2] });
        await expectDns(2);
      }
    } else await expectDns(2);
  }
  if (scenario === "reorder-resume") {
    await configureDdns();
    for (const id of [1, 2]) await confirm(id);
    await groups.runFailover();
    await expectDns(1);
    await advance(25, { renew: [1, 2] });
    await expectDns(2);
  }
  if (["reorder-edit-form", "reorder-override", "reorder-cancel-target"].includes(scenario)) {
    await rules.update({ id: (await rootRule()).id, targetPort: 8081 });
    await confirm(1);
    if (scenario === "reorder-edit-form") await groups.updateFields({ id: groupId, members: members([2, 1]) });
    else await order([2, 1]);
    await expectDns(1);
    if (scenario === "reorder-override") await order([1, 2]);
    if (scenario === "reorder-cancel-target") {
      await groups.updateFields({ id: groupId, members: members([1]) });
      await groups.updateFields({ id: groupId, members: members([1, 2]) });
    }
    await confirm(2);
    await groups.runFailover();
    await expectDns(scenario === "reorder-edit-form" ? 2 : 1);
    await advance(25, { renew: [1, 2] });
    await expectDns(scenario === "reorder-edit-form" ? 2 : 1);
  }
  if (["remove-backup", "remove-only", "no-domain", "ddns-disabled", "disable-group", "delete-group", "readd-host"].includes(scenario)) {
    if (scenario === "remove-backup") {
      await groups.updateFields({ id: groupId, members: members([1]) });
      const reply = await heartbeat(2);
      assert.equal((reply.runningRules || []).some(rule => rule.sourcePort === 18100), false);
    } else if (scenario === "remove-only") {
      await groups.updateFields({ id: groupId, members: members([1]) });
      await groups.updateFields({ id: groupId, members: members([1], [1]) });
      await expectOldConfiguration(false, "disabling the only member immediately withdraws forwarding");
    } else if (scenario === "disable-group" || scenario === "delete-group") {
      await removeCurrent();
      if (scenario === "disable-group") await groups.toggle({ id: groupId, isEnabled: false });
      else await groups.delete({ id: groupId, confirmRules: true });
      await expectOldConfiguration(false, "whole-group removal or disable cancels retained forwarding immediately");
    } else if (scenario === "readd-host") {
      const oldRuleId = reports.get(1)[0].ruleId;
      await removeCurrent();
      await groups.updateFields({ id: groupId, members: members([2, 1]) });
      const reply = await heartbeat(1);
      assert.equal((reply.runningRules || []).some(rule => rule.ruleId === oldRuleId), false, "readding a host cannot reuse its retiring child");
      assert.equal((reply.runningRules || []).filter(rule => rule.sourcePort === 18100).length, 1, "readded host has one replacement listener");
    } else {
      if (scenario === "no-domain") await groups.updateFields({ id: groupId, domain: "" });
      else await setSettings({ ddnsEnabled: "false" });
      await removeCurrent();
      await expectOldConfiguration(false, "without managed DNS there is no handover TTL to wait for");
    }
  }
  if (scenario === "renamed-retirement") {
    await rules.update({ id: (await rootRule()).id, targetPort: 8081 });
    await confirm(1);
    const started = Date.now();
    await removeCurrent();
    await groups.updateFields({ id: groupId, domain: "replacement-domain.example.test" });
    await confirm(2);
    await groups.runFailover();
    assert.equal(requests.at(-1).domain, "replacement-domain.example.test");
    assert.deepEqual(requests.at(-1).values, ["127.0.0.2"]);
    await tickUntil(started + 75_000, { renew: [2] });
    await expectOldConfiguration(true, "publishing a different domain does not start the old domain's TTL retirement");
    await tickUntil(started + 302_000, { renew: [2] });
    await groups.runFailover();
    await expectOldConfiguration(false, "without an effective switch of the original DNS identity the original fallback still applies");
  }
  if (scenario === "stale-retirement") {
    onDns = async payload => {
      if (!payload.values?.includes("127.0.0.2")) return;
      onDns = async () => {};
      await ruleStatus(2, false, "runtime failed while DNS provider was responding");
    };
    const started = Date.now();
    await removeCurrent().catch(() => undefined);
    assert.equal((await state()).lastDdnsValue, "127.0.0.1", "a now-ineligible replacement cannot commit the provider success");
    await tickUntil(started + 75_000);
    await expectOldConfiguration(true, "an obsolete provider success cannot start retirement TTL");
    await tickUntil(started + 302_000);
    await groups.runFailover();
    await expectOldConfiguration(false, "obsolete success does not postpone the original fallback");
  }
  if (scenario === "tcp-handover") {
    // These local TCP adapters apply Agent expected listeners. They verify real
    // new connections at the agreed seam; they do not execute Agent nftables.
    const sockets = new Set();
    const track = socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); return socket; };
    const backend = net.createServer(socket => track(socket).end("ordinary backend reached\n"));
    const forwarders = new Map();
    const addresses = new Map();
    const close = fixture => new Promise(resolve => fixture.close(resolve));
    const applyExpected = async id => {
      const reply = await heartbeat(id);
      const listener = (reply.runningRules || []).find(rule => rule.sourcePort === 18100);
      if (!listener) {
        const previous = forwarders.get(id);
        if (previous) { await close(previous); forwarders.delete(id); }
        return;
      }
      if (forwarders.has(id)) return;
      const forwarder = net.createServer(client => {
        track(client);
        const destination = track(net.createConnection({ host: listener.targetIp, port: listener.targetPort }));
        destination.on("error", error => client.destroy(error));
        client.on("error", () => destination.destroy());
        client.pipe(destination).pipe(client);
      });
      await new Promise(resolve => forwarder.listen(0, "127.0.0.1", resolve));
      forwarders.set(id, forwarder);
      addresses.set(id, forwarder.address());
    };
    const connect = (id, phase = "test TCP connection") => new Promise((resolve, reject) => {
      const address = addresses.get(id);
      const client = track(net.createConnection({ host: "127.0.0.1", port: address.port }));
      let data = "";
      const timeout = realSetTimeout(() => { client.destroy(); reject(new Error("test TCP connection timed out")); }, 3000);
      timeout.unref();
      client.on("data", chunk => { data += chunk; });
      client.on("end", () => resolve(data));
      client.on("error", error => reject(new Error(phase + ": " + error.message, { cause: error })));
    });
    try {
      await new Promise(resolve => backend.listen(0, "127.0.0.1", resolve));
      await rules.update({ id: (await rootRule()).id, targetIp: "127.0.0.1", targetPort: backend.address().port });
      for (const id of [1, 2]) await confirm(id);
      await applyExpected(1);
      await applyExpected(2);
      assert.equal(await connect(1, "before DNS switch"), "ordinary backend reached\n", "before switch, new connections reach the original entry");
      await removeCurrent();
      await groups.runFailover();
      await expectDns(2);
      const switchedAt = requests.filter(request => request.values?.includes("127.0.0.2")).at(0).at;
      await applyExpected(1);
      await applyExpected(2);
      assert.equal(await connect(2, "after DNS switch on replacement"), "ordinary backend reached\n", "new DNS uses a confirmed replacement that accepts a real TCP connection");
      await tickUntil(switchedAt + 50_000, { renew: [2] });
      await applyExpected(1);
      assert.equal(await connect(1, "old cached address inside TTL"), "ordinary backend reached\n", "a new connection using cached old DNS still reaches the backend inside TTL");
      await tickUntil(switchedAt + 62_000, { renew: [2] });
      await groups.runFailover();
      await applyExpected(1);
      await assert.rejects(() => connect(1), /ECONNREFUSED/, "after retirement, the old listener is withdrawn");
    } finally {
      for (const socket of sockets) socket.destroy();
      for (const forwarder of forwarders.values()) await close(forwarder);
      await close(backend);
    }
  }
} finally {
  await runtime.closeDatabase().catch(() => undefined);
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  mock.timers.reset();
}
