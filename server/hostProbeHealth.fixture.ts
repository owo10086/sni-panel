import assert from "node:assert/strict";
import * as runtime from "./dbRuntime";
import * as db from "./db";
import { ensureDatabaseSchema } from "./dbSchema";
import { hostsRouter } from "./routers/hosts";
import { hostChinaHealthSchema, ipSwitchHookSchema } from "../shared/hostChinaHealth";
import { observeProbeHealth, getProbeHealthViews, saveProbeHealth, validateIpSwitchClaim, acknowledgeIpSwitch } from "./hostProbeHealth";
import { hostIngressAddress } from "./hostAddressRuntime";
import { forwardGroupsRouter } from "./routers/forwardGroups";
import { rulesRouter } from "./routers/rules";
import { getDirectSniReadyPorts } from "./sniDirectRuntime";
import { getSniRuntimeGroupStatus, recordSniRuntimeSnapshot, sniRuntimeConfirmationBoundary } from "./sniRuntimeObservability";
import express from "express";
import { registerAgentReportRoutes } from "./agentReportRoutes";
import { agentEncryptionMiddleware } from "./agentEncryptionMiddleware";
import { encryptPayload, decryptPayload } from "./agentCrypto";
import { panelCryptoNowMs } from "./panelClock";
import { recordIpSwitchAgentCapability, hasQueuedIpSwitchAgentTasks, takeIpSwitchAgentTasks } from "./agentIpSwitchTasks";

await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB! } });
let http: ReturnType<ReturnType<typeof express>["listen"]> | undefined;
try {
  await ensureDatabaseSchema();
  for (const id of [1, 2]) await runtime.insertAndGetId("users", { id, username: `user-${id}`, password: "test", name: `User ${id}`, role: id === 1 ? "admin" : "user" });
  for (const id of [1, 2, 3, 4, 5, 6, 7, 8, 9]) await runtime.insertAndGetId("hosts", { id, name: `Host ${id}`, ip: "1.1.1.1", ipv4: "1.1.1.1", agentToken: `test-token-${id}`, userId: 2,
    isOnline: true, lastHeartbeat: Math.floor(Date.now() / 1000), agentVersion: "3.4.0" });
  const caller = (id: number, role: string) => hostsRouter.createCaller({ user: { id, role }, req: { headers: {}, socket: {} }, res: {}, authSession: null, authFailureReason: null } as any);
  const admin = caller(1, "admin"), user = caller(2, "user");
  const hook = ipSwitchHookSchema.parse({ url: "http://10.0.0.1/api/changeip?token=private-provider-secret", successMode: "http" });
  const health = hostChinaHealthSchema.parse({ enabled: true, autoSwitch: true, notify: false, failureThreshold: 2, failureSeconds: 30, cooldownSeconds: 300, maxSwitchesPerDay: 2, hook });
  const serviceInput = { name: "China probe", method: "tcping" as const, targetIp: "223.5.5.5", targetPort: 443, hostScope: "specific" as const, hostIds: [1], intervalSeconds: 15, health };
  await assert.rejects(user.createProbeService(serviceInput), (error: any) => error.code === "FORBIDDEN");
  const { id } = await admin.createProbeService(serviceInput);
  const service = (await db.getHostProbeServiceById(id))!;
  const [stored] = await runtime.queryRaw<any>("SELECT * FROM host_probe_health WHERE serviceId = ?", [id]);
  assert.ok(stored.hookCiphertext.startsWith("v1:")); assert.doesNotMatch(JSON.stringify(stored), /private-provider-secret|10\.0\.0\.1/);
  const view = (await admin.probeServices()).find((item: any) => item.id === id)!.health;
  assert.equal(view.hookConfigured, true); assert.doesNotMatch(JSON.stringify(view), /private-provider-secret|hookCiphertext|10\.0\.0\.1/);
  assert.deepEqual(await user.probeServices(), []);
  // An unrelated update (e.g. pause) must preserve saved provider credentials.
  await admin.updateProbeService({ ...serviceInput, id, health: undefined });
  assert.equal((await runtime.queryRaw<any>("SELECT hookCiphertext FROM host_probe_health WHERE serviceId = ?", [id]))[0].hookCiphertext, stored.hookCiphertext);
  await assert.rejects(admin.createProbeService({ ...serviceInput, hostIds: [1, 2] }), /一台特定/);
  await assert.rejects(admin.createProbeService({ ...serviceInput, targetIp: "localhost" }), /固定公网 IP/);
  const base = Math.floor(Date.now() / 1000), host = (await db.getHostById(1))!;
  let calls = 0, notices = 0, ready = false;
  const deps = { ready: () => ready, notify: async () => { notices++; }, request: async (_hook: any, context: any) => {
    calls++;
    assert.equal(await validateIpSwitchClaim(1, id, context.incidentId, hostIngressAddress(host)), true);
    assert.equal(await validateIpSwitchClaim(2, id, context.incidentId, hostIngressAddress(host)), false);
    assert.equal(await validateIpSwitchClaim(1, id, context.incidentId, "8.8.8.8"), false);
    return { taskId: context.incidentId, outcome: "accepted" as const, reason: "ok" as const };
  }};
  const report = { serviceId: id, targetIp: "223.5.5.5", targetPort: 443, method: "tcping", probeCount: 3, probeSuccesses: 0 };
  await observeProbeHealth({ ...host, id: 2 }, [report], base, deps);
  await observeProbeHealth(host, [{ ...report, targetIp: "8.8.8.8" }, { ...report, method: "ping" }], base, deps);
  await observeProbeHealth(host, [{ ...report, probeSuccesses: -1 }], base, deps);
  assert.equal((await getProbeHealthViews([id])).get(id).state, null);
  for (const offset of [0, 15, 30]) await observeProbeHealth(host, [report], base + offset, deps);
  assert.equal((await getProbeHealthViews([id])).get(id).state.phase, "unhealthy"); assert.equal(calls, 0);
  ready = true;
  // No human reply or approval: a capable Agent immediately receives the action.
  await observeProbeHealth(host, [report], base + 45, deps);
  assert.equal(calls, 1); assert.equal((await getProbeHealthViews([id])).get(id).lastAction.status, "accepted");
  assert.equal((await db.getHostById(1))!.entryIp, null, "the default action does not write a manual ingress");
  await observeProbeHealth(host, [report, report], base + 60, deps); assert.equal(calls, 1);
  for (const offset of [75, 90]) await observeProbeHealth(host, [{ ...report, probeSuccesses: 3 }], base + offset, deps);
  assert.equal((await getProbeHealthViews([id])).get(id).state.phase, "healthy");
  for (const offset of [105, 120, 135]) await observeProbeHealth(host, [report], base + offset, deps);
  assert.equal(calls, 1); // Host cooldown applies across incidents.
  // A monitoring gap may not immediately trigger a previously deferred action.
  await observeProbeHealth(host, [report], base + 400, deps); assert.equal(calls, 1);
  for (const offset of [415, 430]) await observeProbeHealth(host, [report], base + offset, deps);
  assert.equal(calls, 2);
  for (const offset of [445, 460]) await observeProbeHealth(host, [{ ...report, probeSuccesses: 3 }], base + offset, deps);
  for (const offset of [900, 915, 930]) await observeProbeHealth(host, [report], base + offset, deps);
  assert.equal(calls, 2); // Daily cap, including earlier accepted calls.
  assert.ok(notices > 0);

  // Unknown result survives database reload/settings edits and blocks future paid calls.
  const second = await admin.createProbeService({ ...serviceInput, name: "Uncertain", hostIds: [2] });
  const host2 = (await db.getHostById(2))!, report2 = { ...report, serviceId: second.id };
  let uncertainCalls = 0;
  const uncertainDeps = { ...deps, request: async () => { uncertainCalls++; throw new Error("private-provider-secret"); } };
  for (const offset of [0, 15, 30]) await observeProbeHealth(host2, [report2], base + offset, uncertainDeps);
  assert.equal((await getProbeHealthViews([second.id])).get(second.id).lastAction.status, "uncertain");
  await admin.updateProbeService({ ...serviceInput, hostIds: [2], id: second.id, health: { ...health, hook: undefined } });
  for (const offset of [500, 515, 530]) await observeProbeHealth(host2, [report2], base + offset, uncertainDeps);
  assert.equal(uncertainCalls, 1);
  await runtime.executeRaw("UPDATE host_ip_switch_attempts SET createdAt = ? WHERE serviceId = ?", [base - 500, second.id]);
  await acknowledgeIpSwitch(second.id);
  assert.equal((await getProbeHealthViews([second.id])).get(second.id).lastAction.acknowledged, true);

  // Provider success followed by runtime sync failure must not be shown as fully synced.
  const third = await admin.createProbeService({ ...serviceInput, hostIds: [3], health: { ...health, hook: { ...hook, ipPath: "ip", updateAddress: "entry" } } });
  const host3 = (await db.getHostById(3))!, report3 = { ...report, serviceId: third.id };
  for (const offset of [0, 15, 30]) await observeProbeHealth(host3, [report3], base + offset, { ...deps,
    request: async (_hook, context) => ({ taskId: context.incidentId, outcome: "accepted", reason: "ok", newIp: "8.8.4.4" }),
    refresh: async () => { throw new Error("runtime_sync_failed"); },
  });
  assert.equal((await getProbeHealthViews([third.id])).get(third.id).lastAction.status, "sync_failed");
  assert.equal((await db.getHostById(3))!.entryIp, "8.8.4.4");
  assert.equal((await db.getHostById(3))!.tunnelEntryIp, null, "entry-only synchronization never changes the tunnel address");
  assert.equal((await db.getHostById(3))!.ipv4, "1.1.1.1", "the vendor response is not an Agent primary-IP report");

  // A real chain and a direct resource share a complete splitter table. Changing
  // a downstream address invalidates that table, while unrelated tables and an
  // unchanged exit configuration retain their confirmation.
  const context = { user: { id: 1, role: "admin", accountEnabled: true }, req: { headers: {}, socket: {} }, res: {}, authSession: null, authFailureReason: null } as any;
  const groups = forwardGroupsRouter.createCaller(context), rules = rulesRouter.createCaller(context);
  const common = { groupType: "host" as const, forwardType: "gost" as const, protocol: "tcp" as const, isEnabled: true,
    failoverSeconds: 10, recoverSeconds: 10, ddnsAutoResolveEnabled: false };
  const entry = await groups.create({ ...common, name: "Swap entry", groupMode: "entry", domain: "swap.example.test", members: [{ memberType: "host", hostId: 6 }] });
  const direct = await groups.create({ ...common, name: "Shared direct", groupMode: "port", entryGroupId: entry.id, members: [] });
  const chain = await groups.create({ ...common, name: "Address chain", groupMode: "chain", members: [6, 7].map(hostId => ({ memberType: "host" as const, hostId })) });
  const independent = await groups.create({ ...common, name: "Unrelated entry", groupMode: "failover", members: [{ memberType: "host", hostId: 8 }] });
  await rules.create({ forwardGroupId: direct.id, name: "Shared direct", sourcePort: 18443, targetIp: "203.0.113.60", targetPort: 443, sni: "direct.swap.test", isEnabled: true });
  await rules.create({ forwardGroupId: chain.id, name: "Chain route", sourcePort: 18443, targetIp: "203.0.113.70", targetPort: 443, sni: "chain.swap.test", isEnabled: true });
  await rules.create({ forwardGroupId: independent.id, name: "Unaffected route", sourcePort: 18443, targetIp: "203.0.113.80", targetPort: 443, sni: "unrelated.swap.test", isEnabled: true });
  const snapshot = async (hostId: number, observedAt = Date.now()) => {
    const rows = (await db.getForwardRulesForAgent(hostId) as any[]).filter(rule => rule.sni && rule.isEnabled && !rule.pendingDelete);
    recordSniRuntimeSnapshot(hostId, rows.map(rule => ({ port: rule.sourcePort, ruleId: rule.id, sni: rule.sni,
      targetIp: rule.targetIp, targetPort: rule.targetPort, forwardType: "forwardx", protocol: "tcp", ready: true, sniRouteVersion: 1,
      sourceAllowIps: [], maxIPs: 0, limitIn: 0, limitOut: 0, maxConnections: 0,
      accessScope: Number(rule.forwardGroupId) === chain.id && hostId === 6 ? "" : `u1_h${hostId}` })), observedAt);
  };
  for (const hostId of [6, 7, 8]) await snapshot(hostId, Date.now() - 20_000);
  assert.equal((await getDirectSniReadyPorts(6)).has(18443), true);
  const unrelatedConfirmation = getSniRuntimeGroupStatus(8, 18443)!.confirmedAt;
  const seventh = await admin.createProbeService({ ...serviceInput, name: "SNI address sync", hostIds: [7],
    health: { ...health, hook: { ...hook, ipPath: "ip", updateAddress: "entry_and_tunnel" } } });
  const host7 = (await db.getHostById(7))!;
  for (const offset of [0, 15, 30]) await observeProbeHealth(host7, [{ ...report, serviceId: seventh.id }], base + offset, { ...deps,
    request: async (_hook, context) => ({ taskId: context.incidentId, outcome: "accepted", reason: "ok", newIp: "8.8.4.4" }),
  });
  assert.equal((await getProbeHealthViews([seventh.id])).get(seventh.id).lastAction.status, "succeeded");
  const synchronizedHost = (await db.getHostById(7))!;
  assert.equal(synchronizedHost.entryIp, "8.8.4.4"); assert.equal(synchronizedHost.tunnelEntryIp, "8.8.4.4");
  assert.equal(synchronizedHost.ipv4, "1.1.1.1"); assert.equal(synchronizedHost.ip, "1.1.1.1");
  const changedRoute = (await db.getForwardRulesForAgent(6) as any[]).find(rule => rule.sni === "chain.swap.test");
  assert.equal(changedRoute.targetIp, "8.8.4.4");
  assert.ok(sniRuntimeConfirmationBoundary(6) > 0);
  assert.equal(getSniRuntimeGroupStatus(6, 18443)!.confirmedAt, 0);
  assert.equal((await getDirectSniReadyPorts(6)).has(18443), false, "the old complete table cannot confirm the new next hop");
  assert.equal(getSniRuntimeGroupStatus(8, 18443)!.confirmedAt, unrelatedConfirmation);
  assert.equal(sniRuntimeConfirmationBoundary(7), 0, "an unchanged exit table does not gain a destination-probe requirement");
  assert.match(String((await db.getForwardGroupById(entry.id))!.lastMessage), /确认|生效|等待|健康|解析/);
  await snapshot(6, Date.now() + 1);
  assert.equal((await getDirectSniReadyPorts(6)).has(18443), true, "a complete new report restores both shared resources without any destination probe");
  assert.deepEqual(getSniRuntimeGroupStatus(6, 18443)!.appliedDomains, ["chain.swap.test", "direct.swap.test"]);
  const { mock } = await import("node:test");
  mock.timers.enable({ apis: ["Date"], now: Date.now() + 2 });
  try {
    await db.runForwardGroupFailover(entry.id);
    assert.notEqual((await db.getForwardGroupById(entry.id))!.lastStatus, "healthy", "new confirmation does not borrow the old recovery window");
    mock.timers.tick(11_000);
    await db.runForwardGroupFailover(entry.id);
    assert.equal((await db.getForwardGroupById(entry.id))!.lastStatus, "healthy");
    assert.equal((await db.getForwardGroupById(entry.id))!.lastDdnsValue, "1.1.1.1", "the existing group policy recommends the confirmed entry after recovery waiting");
  } finally { mock.timers.reset(); }

  // Changing a touched address while the vendor request is in flight must not
  // overwrite the newer user input, even if the old ingress is unchanged.
  const ninth = await admin.createProbeService({ ...serviceInput, name: "Concurrent address edit", hostIds: [9],
    health: { ...health, hook: { ...hook, ipPath: "ip", updateAddress: "entry_and_tunnel" } } });
  const host9 = (await db.getHostById(9))!;
  for (const offset of [0, 15, 30]) await observeProbeHealth(host9, [{ ...report, serviceId: ninth.id }], base + offset, { ...deps,
    request: async (_hook, context) => {
      await db.updateHost(9, { tunnelEntryIp: "9.9.9.9" });
      return { taskId: context.incidentId, outcome: "accepted", reason: "ok", newIp: "8.8.4.4" };
    }, refresh: async () => assert.fail("a stale result must not refresh or publish the changed configuration"),
  });
  assert.equal((await getProbeHealthViews([ninth.id])).get(ninth.id).lastAction.status, "sync_skipped");
  assert.equal((await db.getHostById(9))!.entryIp, null); assert.equal((await db.getHostById(9))!.tunnelEntryIp, "9.9.9.9");
  const edited = await admin.createProbeService({ ...serviceInput, name: "Concurrent service edit", hostIds: [9],
    health: { ...health, maxSwitchesPerDay: 10, hook: { ...hook, ipPath: "ip", updateAddress: "entry" } } });
  for (const offset of [1000, 1015, 1030]) await observeProbeHealth((await db.getHostById(9))!, [{ ...report, serviceId: edited.id }], base + offset, { ...deps,
    request: async (_hook, context) => {
      await admin.updateProbeService({ ...serviceInput, hostIds: [9], id: edited.id, health: { ...health, autoSwitch: false, hook: undefined } });
      return { taskId: context.incidentId, outcome: "accepted", reason: "ok", newIp: "8.8.4.4" };
    }, refresh: async () => assert.fail("a service edit in flight must not refresh or publish an outdated action"),
  });
  assert.equal((await getProbeHealthViews([edited.id])).get(edited.id).lastAction.status, "sync_skipped");
  assert.equal((await db.getHostById(9))!.entryIp, null);

  const fourth = await admin.createProbeService({ ...serviceInput, hostIds: [4], intervalSeconds: 300, health: { ...health, autoSwitch: false } });
  await runtime.executeRaw("UPDATE host_probe_health SET state = ? WHERE serviceId = ?", [JSON.stringify({ phase: "healthy", lastSeen: base - 500 }), fourth.id]);
  assert.equal((await getProbeHealthViews([fourth.id])).get(fourth.id).state.stale, false);
  await saveProbeHealth({ ...service, id }, null);
  assert.equal((await getProbeHealthViews([id])).has(id), false);
  await admin.deleteProbeService({ id: second.id });
  assert.equal((await getProbeHealthViews([second.id])).has(second.id), false);
  assert.equal((await runtime.queryRaw<any>("SELECT COUNT(*) AS count FROM host_ip_switch_attempts WHERE serviceId = ?", [second.id]))[0].count, 1);
  const replacement = await admin.createProbeService({ ...serviceInput, hostIds: [2] });
  await runtime.executeRaw("UPDATE host_ip_switch_attempts SET acknowledged = 0 WHERE serviceId = ?", [second.id]);
  assert.equal((await getProbeHealthViews([replacement.id])).get(replacement.id).blockedAction.status, "uncertain");
  await acknowledgeIpSwitch(replacement.id);
  assert.equal((await getProbeHealthViews([replacement.id])).get(replacement.id).blockedAction, null);

  // Real encrypted HTTP result routes, and disabling a service while a task is queued.
  const app = express(); app.use(express.json()); app.use("/api/agent", agentEncryptionMiddleware);
  registerAgentReportRoutes(app);
  http = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => http!.once("listening", resolve));
  const address = http.address() as { port: number }, url = `http://127.0.0.1:${address.port}`;
  const agentPost = async (hostId: number, path: string, payload: unknown) => {
    const token = `test-token-${hostId}`;
    const response = await fetch(url + path, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(encryptPayload(payload, token, { timestampMs: panelCryptoNowMs() })) });
    assert.equal(response.status, 200);
    return decryptPayload(await response.json(), token);
  };
  assert.equal((await fetch(url + "/api/agent/ip-switch-result", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 401);
  const fifth = await admin.createProbeService({ ...serviceInput, hostIds: [5] });
  const host5 = (await db.getHostById(5))!, report5 = { ...report, serviceId: fifth.id };
  recordIpSwitchAgentCapability(5, true);
  for (const offset of [0, 15]) await observeProbeHealth(host5, [report5], base + offset, { notify: async () => {} });
  const waiting = observeProbeHealth(host5, [report5], base + 30, { notify: async () => {} });
  const deadline = Date.now() + 3000;
  while (!hasQueuedIpSwitchAgentTasks(5) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  const [task] = takeIpSwitchAgentTasks(5); assert.ok(task);
  assert.deepEqual(await agentPost(2, "/api/agent/ip-switch-claim", { taskId: task.taskId }), { allowed: false });
  await admin.updateProbeService({ ...serviceInput, hostIds: [5], id: fifth.id, isEnabled: false, health: undefined });
  assert.deepEqual(await agentPost(5, "/api/agent/ip-switch-claim", { taskId: task.taskId }), { allowed: false });
  assert.deepEqual(await agentPost(2, "/api/agent/ip-switch-result", { result: { taskId: task.taskId, outcome: "not_executed", reason: "claim_denied" } }), { success: false });
  assert.deepEqual(await agentPost(5, "/api/agent/ip-switch-result", { result: { taskId: task.taskId, outcome: "not_executed", reason: "claim_denied" } }), { success: true });
  await waiting;
  assert.equal((await getProbeHealthViews([fifth.id])).get(fifth.id).lastAction.status, "not_executed");
} finally {
  if (http) { http.closeIdleConnections(); await new Promise<void>(resolve => http!.close(() => resolve())); }
  await runtime.closeDatabase();
}
