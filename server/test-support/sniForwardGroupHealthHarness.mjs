// Isolated acceptance environment: real Agent routes and a local DDNS provider.
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import fs from "node:fs";
const scenario = process.argv[2] || "configuration";
const restartClockFile = process.env.FORWARDX_TEST_DB + ".clock";
const { mock } = await import("node:test");
const realSetTimeout = globalThis.setTimeout;
mock.timers.enable({ apis: ["Date", "setTimeout"], now: scenario === "restart-resume" ? Number(fs.readFileSync(restartClockFile, "utf8")) + 1000 : Math.floor(Date.now() / 1000) * 1000 });
const runtime = await import("../dbRuntime.ts");
const { ensureDatabaseSchema } = await import("../dbSchema.ts");
const { rulesRouter } = await import("../routers/rules.ts");
const { forwardGroupsRouter } = await import("../routers/forwardGroups.ts");
const { registerAgentHeartbeatRoute } = await import("../agentHeartbeatRoute.ts");
const { registerAgentReportRoutes } = await import("../agentReportRoutes.ts");
const { registerAgentStatusRoutes } = await import("../agentStatusRoutes.ts");
const { setSettings } = await import("../repositories/settingsRepository.ts");
const insert = (table, values) => runtime.executeRaw(
  'INSERT INTO "' + table + '" (' + Object.keys(values).map(k => '"' + k + '"').join(',') + ') VALUES (' + Object.keys(values).map(() => '?').join(',') + ')', Object.values(values));
const context = { req: { headers: {} }, res: { clearCookie() {} }, user: { id: 1, username: "admin", role: "admin", accountEnabled: true }, authSession: null, authFailureReason: null };
const rules = rulesRouter.createCaller(context);
const groups = forwardGroupsRouter.createCaller(context);
const app = express();
app.use(express.json());
const { agentEncryptionMiddleware } = await import("../agentEncryptionMiddleware.ts");
const { encryptPayload, decryptPayload, agentTokenFingerprint, signAgentChallengeAuthProof } = await import("../agentCrypto.ts");
const { issueAgentAuthChallenge } = await import("../agentAuthChallenge.ts");
const { panelCryptoNowMs } = await import("../panelClock.ts");
const { randomBytes } = await import("node:crypto");
app.use((req, res, next) => req.path.startsWith("/api/agent/") ? agentEncryptionMiddleware(req, res, next) : next());
registerAgentHeartbeatRoute(app);
registerAgentReportRoutes(app);
registerAgentStatusRoutes(app);
const requests = [];
const notifications = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  if (new URL(String(url)).hostname === "api.telegram.org") {
    notifications.push(JSON.parse(String(options?.body || "{}")));
    return Response.json({ ok: true, result: { message_id: notifications.length } });
  }
  return realFetch(url, options);
};
let dnsFailure = false;
let onDns = async () => {};
app.post("/test-ddns", async (req, res) => {
  requests.push(req.body);
  await onDns();
  if (dnsFailure) res.status(503).json({ error: "simulated DDNS failure" });
  else res.json({ success: true });
});
const server = http.createServer(app);
try {
  await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
  await ensureDatabaseSchema();
  if (scenario !== "restart-resume") {
  await insert("users", { id: 1, username: "admin", password: "x", role: "admin", canAddRules: 1, manualCanAddRules: 1 });
  const now = Math.floor(Date.now() / 1000);
  for (const id of [1, 2]) await insert("hosts", { id, name: "entrance-" + id, ip: "127.0.0." + id, ipv4: "127.0.0." + id, agentToken: "token-" + id, userId: 1, isOnline: 1, lastHeartbeat: now, agentVersion: "2.2.195", portRangeStart: 18000, portRangeEnd: 19000 });
  await insert("forward_groups", { id: 10, name: "SNI standby", groupType: "host", groupMode: "failover", forwardType: "nftables", domain: "", targetIp: "0.0.0.0", targetPort: 1, userId: 1, isEnabled: 1, failoverSeconds: 17, recoverSeconds: 23 });
  for (const id of [1, 2]) await insert("forward_group_members", { id: 100 + id, groupId: 10, memberType: "host", hostId: id, priority: id * 10, isEnabled: 1 });
  }
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  let useClockless = scenario.startsWith("clockless-") && scenario !== "clockless-unknown";
  let agentClockSkew = scenario === "clockless-slow" ? -600_000 : scenario === "clockless-fast" ? 600_000 : 0;
  const agentRequest = (id, route, body) => {
    const token = "token-" + id;
    const bodyText = JSON.stringify(encryptPayload(body, token, { timestampMs: panelCryptoNowMs() + agentClockSkew }));
    let authorization = "Bearer " + token;
    if (useClockless && (id === 1 || scenario !== "clockless-unknown")) {
      const challenge = issueAgentAuthChallenge();
      const nonce = randomBytes(16).toString("hex");
      const sig = signAgentChallengeAuthProof({ token, method: "POST", path: "/api/agent/" + route, bodyText, challenge, nonce });
      authorization = "Bearer v2." + agentTokenFingerprint(token) + "." + challenge + "." + nonce + "." + sig;
    }
    return { method: "POST", headers: { authorization, "content-type": "application/json" }, body: bodyText };
  };
  const post = async (id, route, body) => {
    const response = await fetch("http://127.0.0.1:" + server.address().port + "/api/agent/" + route, {
      ...agentRequest(id, route, body),
    });
    assert.equal(response.status, 200, await response.clone().text());
    return decryptPayload(await response.json(), "token-" + id);
  };
  const receivedHashes = new Map();
  const heartbeat = async (id, localRules, extra = {}) => {
    const result = await post(id, "heartbeat", { agentVersion: "2.2.195", agentBootId: "boot-" + id, agentProcessId: 1000 + id, agentLastReceivedHash: receivedHashes.get(id), forceReconcile: true, ...(localRules ? { localState: { rules: localRules } } : {}), ...extra });
    if (result.desiredState?.configHash) receivedHashes.set(id, result.desiredState.configHash);
    return result;
  };
  const state = async () => (await groups.list()).find(group => group.id === 10);
  const settle = async () => {
    for (let i = 0; i < 5; i++) {
      mock.timers.tick(300);
      await new Promise(resolve => realSetTimeout(resolve, 20));
    }
  };
  const presence = id => post(id, "presence", {});
  const advance = async (seconds, { online = [1, 2], renew = [] } = {}) => {
    for (const id of online) await presence(id);
    for (let left = seconds; left > 0;) {
      const step = Math.min(30, left);
      mock.timers.tick(step * 1000);
      left -= step;
      for (const id of online) await presence(id);
      for (const id of renew) await heartbeat(id, configurations[id - 1]);
      await settle();
    }
  };
  const china = (id, status = "healthy") => post(id, "tcping", { force: true, forwardGroups: [{
    groupId: 10, memberId: 100 + id, probeType: "china", targetIp: "www.bing.com", targetPort: 80,
    latencyMs: status === "healthy" ? 5 : null, isTimeout: status !== "healthy", healthStatus: status,
    probeCount: 1, probeSuccesses: status === "healthy" ? 1 : 0,
  }] });
  if (scenario !== "restart-resume") for (let i = 0; i < 12; i++) await rules.create({ forwardGroupId: 10, name: "service-" + i, sourcePort: 18443, targetIp: "203.0.113.10", targetPort: 19443 + i, sni: "service-" + i + ".example.com", isEnabled: true });
  else {
    assert.equal((await state()).activeMemberId, 102);
    assert.ok((await state()).members.every(member => !member.selectionReady), "a new panel process cannot reuse an in-memory readiness decision");
  }
  const configurations = [];
  for (const id of [1, 2]) {
    if (scenario === "restart-resume" && process.env.FORWARDX_TEST_RESTART_CURRENT_MISSING === "1" && id === 2) {
      await presence(id);
      configurations.push(undefined);
      continue;
    }
    const result = await heartbeat(id, scenario === "restart-resume" ? [] : undefined);
    const config = result.desiredState.actions.find(action => action.fxp?.role === "sni-splitter").fxp;
    assert.equal(config.sniRoutes.length, 12);
    const reports = config.sniRoutes.map(route => ({ ...route, port: config.listenPort, forwardType: "forwardx", protocol: "tcp", sniRouteVersion: config.sniRouteVersion, ready: true, sourceAllowIps: [] }));
    configurations.push(reports);
    await heartbeat(id, reports);
  }
  await setSettings({ ddnsEnabled: "true", ddnsProvider: "webhook", ddnsWebhookUrl: "http://127.0.0.1:" + server.address().port + "/test-ddns", ddnsWebhookMethod: "POST", ddnsTtl: "60" });
  await groups.updateFields({ id: 10, domain: "entry.example.test" });
  await groups.runFailover();
  if (scenario !== "restart-resume") {
    assert.equal((await state()).activeMemberId, 101, "first confirmation can select an entrance without destination reports");
    assert.equal(requests.at(-1).domain, "entry.example.test");
    assert.deepEqual(requests.at(-1).values, ["127.0.0.1"]);
  } else {
    assert.equal((await state()).activeMemberId, 102, "reconfirming after a panel restart is not the first-use exception");
    await advance(7, { renew: [1, 2] });
    assert.equal((await state()).activeMemberId, 102, "incomplete prior history cannot finish recovery early");
    await advance(18, { renew: [1, 2] });
    assert.equal((await state()).activeMemberId, 101, "the recovery deadline automatically restores priority after restart");
  }
  await settle();
  for (const id of [1, 2]) await presence(id);
  if (scenario === "member-release" || scenario === "member-release-ddns-error") {
    await advance(25, { renew: [1, 2] });
    const rootSql =
      'SELECT id,name,userId,sourcePort,targetIp,targetPort,sni,quotaUsedIn,quotaUsedOut ' +
      'FROM forward_rules WHERE forwardGroupId=10 AND isForwardGroupTemplate=1 ORDER BY id';
    const before = await runtime.queryRaw(rootSql);
    const expectedDomains = before.map(rule => rule.sni).sort();
    assert.equal(expectedDomains.length, 12);
    assert.ok(expectedDomains.every(domain => typeof domain === "string" && domain.length > 0));
    const requestCount = requests.length;
    dnsFailure = scenario === "member-release-ddns-error";
    const save = () => groups.updateFields({
      id: 10, members: [
        { memberType: "host", hostId: 2, priority: 0, isEnabled: true },
      ],
    });
    if (dnsFailure) await assert.rejects(save, error => {
      assert.match(error.message, /配置已保存/);
      const aggregate = error instanceof AggregateError ? error : error.cause;
      assert.ok(aggregate instanceof AggregateError);
      assert.ok(aggregate.errors.some(cause => /simulated DDNS failure/.test(String(cause.message))));
      return true;
    });
    else await save();

    assert.deepEqual((await state()).members.map(member => member.hostId), [2]);
    assert.notEqual((await state()).activeMemberId, 101);
    assert.deepEqual(await runtime.queryRaw(rootSql), before);
    assert.deepEqual(await runtime.queryRaw(
      'SELECT DISTINCT hostId FROM forward_rules WHERE forwardGroupId=10 ' +
      'AND isForwardGroupTemplate=1'
    ), [{ hostId: 2 }]);
    assert.equal(Number((await runtime.queryRaw(
      'SELECT COUNT(*) AS count FROM forward_rules WHERE forwardGroupId=10 ' +
      'AND hostId=1 AND isForwardGroupTemplate=0 AND pendingDelete=0'
    ))[0].count), 0);

    const oldReply = await heartbeat(1, configurations[0]);
    // The retained member already acknowledged this unchanged configuration.
    // Request a complete desired state to inspect its actual route table.
    receivedHashes.delete(2);
    const newReply = await heartbeat(2, []);
    const domainsIn = reply => (reply.desiredState?.actions || [])
      .filter(action => action.op === "apply")
      .flatMap(action => action.fxp?.sniRoutes || [])
      .map(route => route.sni).sort();
    assert.deepEqual(domainsIn(oldReply), []);
    assert.deepEqual(domainsIn(newReply), expectedDomains);
    assert.ok(requests.length > requestCount, "member removal must reach the local DNS provider");
    if (dnsFailure) {
      assert.equal((await state()).lastStatus, "error");
      assert.equal((await state()).lastDdnsValue, "127.0.0.1");
    } else {
      assert.equal((await state()).lastDdnsValue, "127.0.0.2");
    }
  }

  if (scenario === "restart-prepare") {
    await heartbeat(1, []);
    await advance(19, { renew: [2] });
    assert.equal((await state()).activeMemberId, 102);
    fs.writeFileSync(restartClockFile, String(Date.now()));
  }
  if (scenario === "configuration") {
    const requestCount = requests.length;
    for (const status of ["healthy", "unhealthy", "unknown"]) {
      await post(1, "tcping", { force: true, results: [{
        ruleId: configurations[0][0].ruleId, sourcePort: 18443, targetIp: "203.0.113.10", targetPort: 19443,
        latencyMs: status === "healthy" ? 5 : null, isTimeout: status !== "healthy", healthStatus: status,
        probeCount: 1, probeSuccesses: status === "healthy" ? 1 : 0,
      }] });
      await groups.runFailover();
      assert.equal((await state()).activeMemberId, 101, "SNI destination results cannot change the entrance");
    }
    assert.equal(requests.length, requestCount, "SNI destination failures do not send a failover request");
    const root = (await rules.list()).find(rule => rule.sni === "service-0.example.com");
    await rules.update({ id: root.id, targetIp: "203.0.113.99", targetPort: 20443, rateLimitMbps: 13, maxConnections: 8 });
    await heartbeat(2, configurations[1]);
    await groups.runFailover();
    assert.equal((await state()).members.find(member => member.id === 102).healthStatus, "unhealthy", "old destination and limits cannot confirm the saved configuration");
    const next = await heartbeat(2);
    const config = next.desiredState.actions.find(action => action.op === "apply" && action.fxp?.role === "sni-splitter").fxp;
    configurations[1] = config.sniRoutes.map(route => ({ ...route, port: config.listenPort, forwardType: "forwardx", protocol: "tcp", sniRouteVersion: config.sniRouteVersion, ready: true }));
    await heartbeat(2, configurations[1]);
    await groups.runFailover();
    assert.equal((await state()).activeMemberId, 101, "newly recovered backup must finish recovery observation");
    await advance(25, { renew: [2] });
    assert.equal((await state()).activeMemberId, 102, "the saved destination is eligible without a new destination probe");
    // A member needs every required splitter port, including a non-default port.
    await rules.create({ forwardGroupId: 10, name: "other port", sourcePort: 18444, targetIp: "203.0.113.11", targetPort: 443, sni: "other.example.com", isEnabled: true });
    for (const id of [1, 2]) {
      const result = await heartbeat(id);
      const configs = result.desiredState.actions.filter(action => action.op === "apply" && action.fxp?.role === "sni-splitter");
      const replacedPorts = new Set(configs.map(action => action.fxp.listenPort));
      configurations[id - 1] = [
        ...configurations[id - 1].filter(rule => !replacedPorts.has(rule.port)),
        ...configs.flatMap(action => action.fxp.sniRoutes.map(route => ({ ...route, port: action.fxp.listenPort, forwardType: "forwardx", protocol: "tcp", sniRouteVersion: action.fxp.sniRouteVersion, ready: true }))),
      ];
      await heartbeat(id, configurations[id - 1]);
    }
    await advance(25, { renew: [1, 2] });
    await groups.updateFields({ id: 10, autoFailback: false });
    const activeId = (await state()).activeMemberId - 100;
    await heartbeat(activeId, configurations[activeId - 1].filter(rule => rule.port !== 18444));
    await groups.runFailover();
    assert.equal((await state()).activeMemberId, activeId + 100);
    await advance(19, { renew: [3 - activeId] });
    assert.equal((await state()).activeMemberId, 103 - activeId, "one stopped port makes the entire member unavailable");
  }
  if (scenario === "windows") {
    await groups.updateFields({ id: 10, chinaHealthCheckEnabled: true, chinaHealthCheckTarget: "www.bing.com:80" });
    for (const id of [1, 2]) await china(id);
    await heartbeat(1, []);
    await groups.runFailover();
    const failureSince = (await state()).members.find(member => member.id === 101).failureSince;
    await advance(8);
    await china(1);
    await groups.runFailover();
    assert.equal((await state()).activeMemberId, 101);
    assert.deepEqual((await state()).members.find(member => member.id === 101).failureSince, failureSince, "Bing success cannot reset the splitter failure window");
    await advance(11);
    assert.equal((await state()).activeMemberId, 102, "failure deadline switches without another runtime report");
    await heartbeat(1, configurations[0]);
    await china(1);
    await settle();
    await advance(7);
    assert.equal((await state()).activeMemberId, 102, "splitter recovery cannot borrow Bing's earlier healthy time");
    await heartbeat(1, []);
    await settle();
    await heartbeat(1, configurations[0]);
    await advance(8);
    assert.equal((await state()).activeMemberId, 102, "a second failure discards the first recovery segment");
    await groups.updateFields({ id: 10, recoverSeconds: 41 });
    await advance(20);
    assert.equal((await state()).activeMemberId, 102, "lengthening recovery reschedules its deadline");
    await groups.updateFields({ id: 10, recoverSeconds: 17, autoFailback: false });
    await settle();
    assert.equal((await state()).activeMemberId, 102, "disabled failback keeps the healthy backup");
    await heartbeat(2, []);
    await china(2);
    await groups.runFailover();
    await advance(19);
    assert.equal((await state()).activeMemberId, 101, "a failed current entrance can use a recovered higher-priority entrance with failback disabled");
    await heartbeat(2, configurations[1]);
    await advance(19);
    await china(1, "unhealthy");
    await heartbeat(1, []);
    await groups.runFailover();
    assert.equal((await state()).activeMemberId, 102, "an Agent's completed China failure window is not restarted by a new splitter failure");
  }
  if (scenario === "lifecycle") {
    // A matching signature confirms the actual table again; a heartbeat that
    // omits both the signature and the table supplies no such confirmation.
    const signature = "a".repeat(64);
    await heartbeat(1, configurations[0], { localStateSignature: signature });
    await advance(290, { renew: [2] });
    await heartbeat(1, undefined, { localStateSignature: signature });
    await advance(25, { renew: [2] });
    assert.equal((await state()).activeMemberId, 101, "known unchanged content renews the five-minute confirmation");
    const unknown = await heartbeat(1, undefined, { localStateSignature: "b".repeat(64) });
    assert.equal(unknown.requestLocalState, true, "an unknown signature requests the full table");
    await groups.updateFields({ id: 10, chinaHealthCheckEnabled: true, chinaHealthCheckTarget: "www.bing.com:80" });
    for (const id of [1, 2]) await china(id);
    for (let i = 0; i < 9; i++) {
      await advance(30, { renew: [2] });
      for (const id of [1, 2]) await china(id);
      await heartbeat(1); // Online and Bing do not renew splitter confirmation.
    }
    await advance(24, { renew: [2] });
    await china(2);
    await settle();
    assert.equal((await state()).activeMemberId, 102, "confirmation expiry plus the configured failure window switches automatically");
    assert.equal((await state()).members.find(member => member.id === 101).healthStatus, "unhealthy");
    await groups.updateFields({ id: 10, chinaHealthCheckEnabled: false });
    await heartbeat(1, configurations[0]);
    await settle();
    assert.equal((await state()).activeMemberId, 102, "expired confirmation must recover before failback");
    await advance(25, { renew: [1, 2] });
    assert.equal((await state()).activeMemberId, 101);

    const delayedEnvelope = encryptPayload({ agentVersion: "2.2.195", agentBootId: "boot-1", agentProcessId: 1001, localState: { rules: configurations[0] } }, "token-1");
    await advance(110, { online: [2], renew: [2] });
    assert.equal((await state()).activeMemberId, 102, "confirmed offline cannot keep the original entrance eligible");
    const response = await fetch("http://127.0.0.1:" + server.address().port + "/api/agent/heartbeat", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(delayedEnvelope),
    });
    assert.equal(response.status, 200);
    assert.equal(decryptPayload(await response.json(), "token-1").requestLocalState, true, "a delayed pre-offline encrypted report cannot restore readiness");
    const reconnected = await heartbeat(1, undefined, { localStateSignature: signature });
    assert.equal(reconnected.requestLocalState, true);
    await groups.runFailover();
    assert.equal((await state()).activeMemberId, 102, "reconnection needs this session's full confirmation even with China health disabled");
    await heartbeat(1, configurations[0]);
    await settle();
    await advance(25, { renew: [1, 2] });
    assert.equal((await state()).activeMemberId, 101);
    await heartbeat(1, undefined, { agentProcessId: 2001 });
    await groups.runFailover();
    assert.equal((await state()).members.find(member => member.id === 101).healthStatus, "unhealthy", "an Agent process restart invalidates its old splitter report");
    const lateProcess = await heartbeat(1, configurations[0]);
    assert.equal(lateProcess.requestLocalState, true, "a late report from the retired Agent process is rejected");
    await advance(19, { renew: [2] });
    assert.equal((await state()).activeMemberId, 102);
    await heartbeat(1, configurations[0], { agentProcessId: 2001 });
    await settle();
    assert.equal((await state()).activeMemberId, 102);
    await advance(25, { renew: [2] });
    assert.equal((await state()).activeMemberId, 101, "a valid post-restart report still needs recovery observation");
  }
  if (scenario.startsWith("clockless-")) {
    if (scenario === "clockless-unknown") {
      await groups.updateFields({ id: 10, chinaHealthCheckEnabled: true, chinaHealthCheckTarget: "www.bing.com:80" });
      for (const id of [1, 2]) await china(id);
      await groups.runFailover();
      useClockless = true;
    }
    const delayed = agentRequest(1, "heartbeat", { agentVersion: "2.2.195", agentBootId: "boot-1", agentProcessId: 1001, localState: { rules: configurations[0] } });
    const delayedChina = agentRequest(1, "tcping", { force: true, forwardGroups: [{ groupId: 10, memberId: 101, probeType: "china", targetIp: "www.bing.com", targetPort: 80, latencyMs: 5, isTimeout: false, healthStatus: "healthy", probeCount: 1, probeSuccesses: 1 }] });
    await advance(110, { online: [2], renew: [2] });
    if (scenario === "clockless-backward") agentClockSkew = -600_000;
    assert.equal((await state()).activeMemberId, 102);
    const response = await fetch("http://127.0.0.1:" + server.address().port + "/api/agent/heartbeat", delayed);
    assert.equal(response.status, 200);
    const delayedResult = decryptPayload(await response.json(), "token-1");
    assert.ok(delayedResult.desiredState?.configHash, "an old body must receive this session's confirmation hash before supplying evidence");
    assert.equal((await state()).members.find(member => member.id === 101).selectionReady, false);
    receivedHashes.set(1, delayedResult.desiredState.configHash);
    if (scenario === "clockless-unknown") {
      const oldChinaResponse = await fetch("http://127.0.0.1:" + server.address().port + "/api/agent/tcping", delayedChina);
      assert.equal(oldChinaResponse.status, 200);
      const hashOnly = await heartbeat(1);
      assert.equal(hashOnly.requestLocalState, true, "a session receipt without a full runtime table cannot qualify the entrance");
    }
    await heartbeat(1, configurations[0]);
    await advance(25, { renew: [1, 2] });
    if (scenario === "clockless-unknown") {
      assert.equal((await state()).activeMemberId, 102, "a late China probe while session confirmation is pending cannot restore eligibility");
      await china(1);
      await groups.runFailover();
    }
    assert.equal((await state()).activeMemberId, 101, "clockless authentication accepts fresh recovery with a fast or slow Agent clock");
  }
  if (scenario === "apply-failure") {
    await post(1, "rule-status", { ruleId: configurations[0][0].ruleId, sourcePort: 18443, sniRuntimePort: 18443, forwardType: "forwardx", isRunning: false, message: "simulated splitter apply failure" });
    await advance(19, { renew: [2] });
    assert.equal((await state()).activeMemberId, 102, "a failed splitter apply starts failure timing and switches without another runtime report");
    await heartbeat(1, configurations[0]);
    await settle();
    assert.equal((await state()).activeMemberId, 102);
    await advance(25, { renew: [1, 2] });
    assert.equal((await state()).activeMemberId, 101);
  }
  if (scenario === "coalesced-restart") {
    await heartbeat(1, configurations[0], { forceReconcile: false });
    const result = await heartbeat(1, undefined, { agentProcessId: 2001, forceReconcile: false });
    assert.equal(result.reconciliationCoalesced, true);
    assert.equal(result.requestLocalState, true);
    await groups.runFailover();
    assert.equal((await state()).members.find(member => member.id === 101).selectionReady, false, "coalescing a restarted process cannot keep the old runtime confirmation");
  }
  if (scenario === "notifications") {
    await runtime.executeRaw('UPDATE users SET telegramId = ? WHERE id = 1', ["test-admin"]);
    await setSettings({ notificationChannel: "telegram", telegramBotEnabled: "true", telegramBotToken: "local-test-token" });
    await groups.updateFields({ id: 10, telegramSwitchNotifyEnabled: true });
    await groups.updateFields({ id: 10, domain: "notice.example.test" });
    await settle();
    assert.equal(notifications.length, 0, "renaming a domain without changing members keeps existing notification semantics");
    await heartbeat(1, []);
    dnsFailure = true;
    await advance(19, { renew: [2] });
    assert.equal((await state()).lastStatus, "error");
    assert.equal((await state()).activeMemberId, 101);
    assert.equal(notifications.length, 0, "DDNS failure cannot announce a successful switch");
    dnsFailure = false;
    await advance(3, { renew: [2] });
    assert.equal((await state()).activeMemberId, 102);
    assert.equal(notifications.length, 1);
    assert.match(notifications[0].text, /notice\.example\.test/);
    assert.match(notifications[0].text, /127\.0\.0\.1/);
    assert.match(notifications[0].text, /127\.0\.0\.2/);
    const events = await groups.events({ groupId: 10 });
    assert.ok(events.some(event => event.type === "ddns-error"));
    assert.ok(events.some(event => event.type === "failover"));
    const beforeSync = requests.length;
    await groups.sync({ id: 10 });
    assert.ok(requests.length > beforeSync, "manual synchronization reaches the provider");
    assert.equal(notifications.length, 1, "manual synchronization does not emit an automatic switch message");
    await heartbeat(1, configurations[0]);
    await advance(25, { renew: [1, 2] });
    assert.equal((await state()).activeMemberId, 101);
    assert.equal(notifications.length, 2);
    await groups.reorder({ groupId: 10, memberIds: [102, 101] });
    await settle();
    assert.equal((await state()).activeMemberId, 102, "manual member ordering selects the new eligible priority");
    assert.equal(notifications.length, 2, "manual member ordering keeps automatic switch notifications suppressed");
  }
  if (scenario === "brief-missing") {
    await heartbeat(1, []);
    await advance(19, { renew: [2] });
    await heartbeat(1, configurations[0]);
    await advance(10, { renew: [2] });
    await heartbeat(1, configurations[0].slice(1));
    await heartbeat(1, configurations[0]);
    await advance(12, { renew: [2] });
    assert.equal((await state()).activeMemberId, 102, "a missing rule resets recovery even when the next snapshot repairs it before queued evaluation");
    await advance(12, { renew: [1, 2] });
    assert.equal((await state()).activeMemberId, 101);
  }
  if (scenario === "deleted-domain") {
    const root = (await rules.list()).find(rule => rule.sni === "service-0.example.com");
    await rules.delete({ id: root.id });
    await heartbeat(1, configurations[0]);
    await groups.runFailover();
    assert.equal((await state()).members.find(member => member.id === 101).selectionReady, false, "a deleted domain still running in the old table blocks readiness");
    const deletedIds = configurations.map(reports => reports.find(rule => rule.sni === "service-0.example.com").ruleId);
    for (const id of [1, 2]) await heartbeat(id, configurations[id - 1].filter(rule => rule.sni !== "service-0.example.com"));
    assert.deepEqual(await runtime.queryRaw('SELECT id FROM forward_rules WHERE id IN (?, ?)', deletedIds), [], "the removed children have been physically purged");
    await heartbeat(1, configurations[0]);
    configurations[1] = configurations[1].filter(rule => rule.sni !== "service-0.example.com");
    await advance(25, { renew: [2] });
    assert.equal((await state()).members.find(member => member.id === 101).selectionReady, false, "a purged domain reappearing in an old full table cannot restore eligibility");
  }
  if (scenario === "ddns") {
    const firstRequestCount = requests.length;
    await groups.updateFields({ id: 10, domain: "new-entry.example.test" });
    await groups.runFailover();
    assert.equal(requests.length, firstRequestCount + 1);
    assert.equal(requests.at(-1).domain, "new-entry.example.test", "the same member and address still update a new domain");
    dnsFailure = true;
    await assert.rejects(() => groups.updateFields({ id: 10, domain: "retry-entry.example.test" }), /simulated DDNS failure/);
    await assert.rejects(() => groups.runFailover(), /simulated DDNS failure/);
    assert.equal((await state()).lastStatus, "error");
    assert.equal((await state()).activeMemberId, 101);
    dnsFailure = false;
    await advance(3);
    assert.equal((await state()).lastStatus, "healthy", "the existing queue retries a failed provider request");
    assert.equal(requests.at(-1).domain, "retry-entry.example.test");
    await groups.updateFields({ id: 10, domain: "race-old.example.test" });
    const before = (await state()).lastDdnsAt;
    mock.timers.tick(1000);
    let concurrentSave;
    onDns = async () => {
      onDns = async () => {};
      concurrentSave = groups.updateFields({ id: 10, domain: "race-current.example.test" });
      for (let i = 0; i < 100; i++) {
        if ((await state()).domain === "race-current.example.test") return;
        await new Promise(resolve => realSetTimeout(resolve, 10));
      }
      throw new Error("domain save did not reach the report recheck");
    };
    const { runForwardGroupFailover } = await import("../repositories/forwardGroupRepository.ts");
    await runForwardGroupFailover(10, { forceSync: true });
    assert.equal((await state()).domain, "race-current.example.test");
    assert.deepEqual((await state()).lastDdnsAt, before, "an obsolete response cannot commit success for the new domain");
    await concurrentSave;
    await settle();
    assert.equal(requests.at(-1).domain, "race-current.example.test");
    assert.equal((await state()).lastStatus, "healthy");
    await groups.updateFields({ id: 10, domain: "config-race.example.test" });
    const root = (await rules.list()).find(rule => rule.sni === "service-0.example.com");
    const beforeRace = (await state()).lastDdnsAt;
    mock.timers.tick(1000);
    onDns = async () => {
      onDns = async () => {};
      concurrentSave = rules.update({ id: root.id, maxConnections: 19 });
      for (let i = 0; i < 100; i++) {
        if ((await rules.getById({ id: root.id })).maxConnections === 19) return;
        await new Promise(resolve => realSetTimeout(resolve, 10));
      }
      throw new Error("rule save did not reach the report recheck");
    };
    await runForwardGroupFailover(10, { forceSync: true });
    assert.deepEqual((await state()).lastDdnsAt, beforeRace, "a DDNS response cannot confirm a splitter table that changed during the request");
    await concurrentSave;
    await settle();
    assert.notEqual((await state()).lastStatus, "healthy");
    for (const id of [1, 2]) {
      const result = await heartbeat(id);
      const config = result.desiredState.actions.find(action => action.op === "apply" && action.fxp?.role === "sni-splitter").fxp;
      configurations[id - 1] = config.sniRoutes.map(route => ({ ...route, port: config.listenPort, forwardType: "forwardx", protocol: "tcp", sniRouteVersion: config.sniRouteVersion, ready: true }));
      await heartbeat(id, configurations[id - 1]);
    }
    const requestsBeforeRecovery = requests.length;
    await advance(25, { renew: [1, 2] });
    assert.equal((await state()).lastStatus, "healthy");
    assert.ok(requests.length > requestsBeforeRecovery, "a discarded provider response forces later reconciliation even when the address is unchanged");
    const retained = (await state()).lastDdnsValue;
    for (const id of [1, 2]) await heartbeat(id, []);
    await advance(19);
    assert.equal((await state()).lastStatus, "down");
    assert.equal((await state()).lastDdnsValue, retained, "ordinary health failures retain the working DNS address");
    assert.ok(requests.every(request => request.values.length > 0), "ordinary failures do not delete provider DNS records");
  }
  if (scenario === "ddns-current") {
    const before = (await state()).lastDdnsAt;
    mock.timers.tick(1000);
    onDns = async () => {
      onDns = async () => {};
      await heartbeat(1, []);
      await heartbeat(1, configurations[0]);
    };
    await (await import("../repositories/forwardGroupRepository.ts")).runForwardGroupFailover(10, { forceSync: true });
    assert.deepEqual((await state()).lastDdnsAt, before, "an in-flight refresh cannot commit success after the same entrance loses and regains runtime confirmation");
    await settle();
    assert.notEqual((await state()).lastStatus, "healthy");
    assert.equal((await state()).members.find(member => member.id === 101).selectionReady, false);
    await advance(25, { renew: [1, 2] });
    assert.equal((await state()).lastStatus, "healthy");
  }
  if (scenario === "ddns-failback-disabled") {
    await heartbeat(1, []);
    await advance(19, { renew: [2] });
    assert.equal((await state()).activeMemberId, 102);
    await heartbeat(1, configurations[0]);
    let concurrentSave;
    onDns = async () => {
      onDns = async () => {};
      concurrentSave = groups.updateFields({ id: 10, autoFailback: false });
      for (let i = 0; i < 100; i++) {
        if ((await state()).autoFailback === false) return;
        await new Promise(resolve => realSetTimeout(resolve, 10));
      }
      throw new Error("failback setting did not reach the recheck");
    };
    await advance(25, { renew: [1, 2] });
    await concurrentSave;
    await settle();
    assert.equal((await state()).autoFailback, false);
    assert.equal((await state()).activeMemberId, 102, "disabling failback while the provider responds cancels the obsolete switch");
    assert.equal(requests.at(-1).values[0], "127.0.0.2", "the current eligible entrance is reconciled after an obsolete provider request");
  }
  if (scenario === "pending-normal" || scenario === "pending-china") {
    if (scenario === "pending-china") await groups.updateFields({ id: 10, chinaHealthCheckEnabled: true });
    else {
      await rules.create({ forwardGroupId: 10, name: "ordinary waiting", sourcePort: 18500, targetIp: "203.0.113.20", targetPort: 80, protocol: "tcp", forwardType: "nftables", isEnabled: true });
      for (const id of [1, 2]) {
        const result = await heartbeat(id, configurations[id - 1]);
        const probe = result.runningRules.find(rule => rule.sourcePort === 18500);
        configurations[id - 1].push({ ruleId: probe.ruleId, port: 18500, targetIp: "203.0.113.20", targetPort: 80, protocol: "tcp", forwardType: "nftables", ready: true });
        await heartbeat(id, configurations[id - 1]);
      }
    }
    await groups.runFailover();
    assert.equal((await state()).lastStatus, "unknown");
    await advance(330, { renew: [1, 2] });
    assert.equal((await state()).lastStatus, "down", "continual evaluations cannot extend a missing report's waiting period forever");
  }
  if (scenario === "backup") {
    for (const autoFailback of [true, false]) {
      await groups.updateFields({ id: 10, autoFailback, recoverSeconds: 71, failoverSeconds: 13 });
      await heartbeat(2, []);
      await settle();
      await heartbeat(1, []);
      await advance(15);
      const retained = (await state()).lastDdnsValue;
      await heartbeat(2, configurations[1]);
      await advance(5);
      assert.equal((await state()).activeMemberId, 101, "a newly recovered backup cannot replace a failed current entrance");
      assert.equal((await state()).lastDdnsValue, retained);
      assert.match((await state()).lastMessage, /恢复观察/);
      await groups.updateFields({ id: 10, recoverSeconds: 89 });
      await advance(64, { renew: [2] });
      assert.equal((await state()).activeMemberId, 101, "lengthened backup recovery continues waiting");
      await groups.updateFields({ id: 10, recoverSeconds: 61 });
      await settle();
      assert.equal((await state()).activeMemberId, 102, "shortening an elapsed recovery setting automatically selects the backup");
      await heartbeat(1, configurations[0]);
      await advance(65, { renew: [1, 2] });
      await groups.sync({ id: 10 });
      assert.equal((await state()).activeMemberId, 101, "manual priority sync still uses a fully recovered member");
    }
  }
  if (scenario === "failure-settings") {
    await heartbeat(1, []);
    await settle();
    await advance(5, { renew: [2] });
    await groups.updateFields({ id: 10, failoverSeconds: 43 });
    await advance(16, { renew: [2] });
    assert.equal((await state()).activeMemberId, 101, "lengthening a failure delay replaces its old deadline");
    await groups.updateFields({ id: 10, failoverSeconds: 19 });
    await settle();
    assert.equal((await state()).activeMemberId, 102, "shortening an elapsed failure delay automatically reevaluates");
  }
  if (scenario === "recovery-expiry") {
    await groups.updateFields({ id: 10, recoverSeconds: 401 });
    await heartbeat(1, []);
    await advance(19, { renew: [2] });
    assert.equal((await state()).activeMemberId, 102);
    await heartbeat(1, configurations[0]);
    await advance(305, { renew: [2] });
    assert.equal((await state()).activeMemberId, 102, "confirmation expiry interrupts an unfinished recovery");
    await heartbeat(1, configurations[0]);
    await advance(120, { renew: [1, 2] });
    assert.equal((await state()).activeMemberId, 102, "normal time on either side of expiry cannot be stitched together");
    await advance(290, { renew: [1, 2] });
    assert.equal((await state()).activeMemberId, 101, "recovery completes from the new valid confirmation");
  }
  if (scenario === "third-backup") {
    await insert("hosts", { id: 3, name: "entrance-3", ip: "127.0.0.3", ipv4: "127.0.0.3", agentToken: "token-3", userId: 1, isOnline: 1, lastHeartbeat: Math.floor(Date.now() / 1000), agentVersion: "2.2.195", portRangeStart: 18000, portRangeEnd: 19000 });
    await (await import("../db.ts")).getAgentAuthTokenCandidates({ force: true });
    await groups.updateFields({ id: 10, recoverSeconds: 71, members: [1, 2, 3].map(id => ({ memberType: "host", hostId: id, priority: id * 10 })) });
    const next = await heartbeat(3);
    const config = next.desiredState.actions.find(action => action.op === "apply" && action.fxp?.role === "sni-splitter").fxp;
    configurations[2] = config.sniRoutes.map(route => ({ ...route, port: config.listenPort, forwardType: "forwardx", protocol: "tcp", sniRouteVersion: config.sniRouteVersion, ready: true }));
    await heartbeat(3, configurations[2]);
    await heartbeat(2, []);
    await settle();
    await heartbeat(1, []);
    await heartbeat(2, configurations[1]);
    await advance(19, { online: [1, 2, 3], renew: [2, 3] });
    const memberC = (await state()).members.find(member => member.hostId === 3);
    assert.equal((await state()).activeMemberId, memberC.id, "a ready third entrance is chosen while the preferred backup is still recovering");
    assert.equal(requests.at(-1).values[0], "127.0.0.3");
  }
  if (scenario === "china-expiry") {
    await groups.updateFields({ id: 10, chinaHealthCheckEnabled: true, chinaHealthCheckTarget: "www.bing.com:80" });
    for (const id of [1, 2]) await china(id);
    await groups.runFailover();
    assert.equal((await state()).lastStatus, "healthy");
    await advance(305, { renew: [1, 2] });
    assert.notEqual((await state()).lastStatus, "healthy", "fresh splitter confirmations cannot renew expired China probes");
    const retained = (await state()).lastDdnsValue;
    await advance(19, { renew: [1, 2] });
    assert.equal((await state()).lastDdnsValue, retained);
    for (const id of [1, 2]) await china(id);
    await settle();
    assert.equal((await state()).lastStatus, "healthy", "the Agent's final recovered China decision does not add another SNI recovery window");
  }
  if (scenario === "mixed") {
    const ordinary = await rules.create({ forwardGroupId: 10, name: "ordinary service", sourcePort: 18500, targetIp: "203.0.113.20", targetPort: 80, protocol: "tcp", forwardType: "nftables", isEnabled: true });
    const normalReports = [];
    for (const id of [1, 2]) {
      const result = await heartbeat(id, configurations[id - 1]);
      const probe = result.runningRules.find(rule => rule.sourcePort === 18500);
      assert.ok(probe);
      normalReports.push({ ruleId: probe.ruleId, sourcePort: 18500, targetIp: "203.0.113.20", targetPort: 80, latencyMs: 4, isTimeout: false, healthStatus: "healthy", probeCount: 1, probeSuccesses: 1 });
      configurations[id - 1].push({ ruleId: probe.ruleId, port: 18500, targetIp: "203.0.113.20", targetPort: 80, protocol: "tcp", forwardType: "nftables", ready: true });
      await heartbeat(id, configurations[id - 1]);
      await post(id, "tcping", { force: true, results: [normalReports[id - 1]] });
    }
    await groups.runFailover();
    assert.equal((await state()).activeMemberId, 101);
    await post(1, "tcping", { force: true, results: [{ ...normalReports[0], latencyMs: null, isTimeout: true, healthStatus: "unhealthy", probeSuccesses: 0 }] });
    await groups.runFailover();
    assert.equal((await state()).activeMemberId, 102, "ordinary target failure still affects a mixed member");
    await post(1, "tcping", { force: true, results: [normalReports[0]] });
    await groups.runFailover();
    assert.equal((await state()).activeMemberId, 101, "an Agent's completed ordinary recovery needs no duplicate SNI wait");
    const delayed = agentRequest(1, "tcping", { force: true, results: [normalReports[0]] });
    await advance(110, { online: [2], renew: [2] });
    assert.equal((await state()).activeMemberId, 102);
    await presence(1);
    await settle();
    await heartbeat(1, configurations[0]);
    const delayedResponse = await fetch("http://127.0.0.1:" + server.address().port + "/api/agent/tcping", delayed);
    assert.equal(delayedResponse.status, 200);
    await advance(25, { renew: [1, 2] });
    assert.equal((await state()).activeMemberId, 102, "a pre-offline ordinary probe cannot qualify a mixed entrance after reconnect");
    await post(1, "tcping", { force: true, results: [normalReports[0]] });
    await groups.runFailover();
    assert.equal((await state()).activeMemberId, 101);
    await groups.updateFields({ id: 10, chinaHealthCheckEnabled: true, chinaHealthCheckTarget: "www.bing.com:80" });
    await groups.runFailover();
    assert.equal((await state()).lastStatus, "unknown", "enabled China checks wait for the first report");
    for (const id of [1, 2]) await china(id);
    await groups.runFailover();
    assert.equal((await state()).lastStatus, "healthy");
    await china(1, "unhealthy");
    await groups.runFailover();
    assert.equal((await state()).activeMemberId, 102);
    await china(1);
    await groups.runFailover();
    assert.equal((await state()).activeMemberId, 101, "completed China recovery does not restart a SNI window");
    await rules.toggle({ id: ordinary.id, isEnabled: false });
    // Rule exclusions also require the safe updated splitter table, and never
    // ask the excluded domain to run in order to qualify the other services.
    const root = (await rules.list()).find(rule => rule.sni === "service-0.example.com");
    for (const patch of [{ isEnabled: false }, { isEnabled: true, createdAt: new Date(Date.now() - 86_400_000), expiresAt: new Date(Date.now() - 1000) }, { expiresAt: null, trafficLimit: 1 }]) {
      await rules.update({ id: root.id, ...patch });
      for (const id of [1, 2]) {
        const result = await heartbeat(id, configurations[id - 1]);
        const configs = result.desiredState.actions.filter(action => action.op === "apply" && action.fxp?.role === "sni-splitter");
        if (configs.length) {
          configurations[id - 1] = configs.flatMap(action => action.fxp.sniRoutes.map(route => ({ ...route, port: action.fxp.listenPort, forwardType: "forwardx", protocol: "tcp", sniRouteVersion: action.fxp.sniRouteVersion, ready: true })));
          await heartbeat(id, configurations[id - 1]);
        }
      }
      await groups.runFailover();
      assert.ok(configurations.every(reports => reports.some(rule => rule.sni === "service-1.example.com")), "other shared-port domains continue running");
      await advance(25, { renew: [1, 2] });
      assert.equal((await state()).lastStatus, "healthy");
    }
  }
  if (scenario === "concurrent-restart") {
    const dbHandle = await runtime.getDb();
    const originalSelect = dbHandle.select.bind(dbHandle);
    let resolvePaused, resolveRelease;
    const paused = new Promise(resolve => resolvePaused = resolve);
    const released = new Promise(resolve => resolveRelease = resolve);
    let pauseOnce = true;
    // Pause the old heartbeat at its real database await, then let the new
    // process invalidate confirmation through the ordinary coalesced route.
    dbHandle.select = (...args) => {
      const builder = originalSelect(...args);
      const originalFrom = builder.from.bind(builder);
      builder.from = (...fromArgs) => {
        const query = originalFrom(...fromArgs);
        const originalThen = query.then.bind(query);
        query.then = (fulfilled, rejected) => {
          if (pauseOnce && query.toSQL().sql.includes('from "forward_rules" where "forward_rules"."id" in')) {
            pauseOnce = false;
            resolvePaused();
            return released.then(() => originalThen(fulfilled, rejected));
          }
          return originalThen(fulfilled, rejected);
        };
        return query;
      };
      return builder;
    };
    let pauseTimeout;
    try {
      const oldRequest = heartbeat(1, configurations[0]);
      await Promise.race([paused, new Promise((_, reject) => {
        pauseTimeout = realSetTimeout(() => reject(new Error("old heartbeat did not reach its runtime confirmation query")), 3000);
      })]);
      clearTimeout(pauseTimeout);
      const newRequest = await heartbeat(1, undefined, { agentProcessId: 2001, forceReconcile: false });
      assert.equal(newRequest.reconciliationCoalesced, true);
      const { getSniRuntimeGroupStatus } = await import("../sniRuntimeObservability.ts");
      assert.equal(getSniRuntimeGroupStatus(1, 18443).confirmedAt, 0, "the new process invalidates confirmation while the old handler is paused");
      resolveRelease();
      const oldResult = await oldRequest;
      assert.equal(oldResult.requestLocalState, true);
      assert.equal(getSniRuntimeGroupStatus(1, 18443).confirmedAt, 0, "the old in-flight handler cannot recreate confirmation after invalidation");
      await groups.runFailover();
      assert.equal((await state()).members.find(member => member.id === 101).selectionReady, false);
    } finally {
      clearTimeout(pauseTimeout);
      resolveRelease();
      dbHandle.select = originalSelect;
    }
  }
  console.log("PASS " + scenario + ": real encrypted reports, member state, timed evaluation and local DDNS requests");
} finally {
  await new Promise(resolve => server.close(resolve));
  await runtime.closeDatabase();
}
process.exit(0);
