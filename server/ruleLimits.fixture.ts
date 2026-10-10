import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import express from "express";
import http from "node:http";
import type { ForwardRule } from "../drizzle/schema";
import * as runtime from "./dbRuntime";
import { ensureDatabaseSchema } from "./dbSchema";
import * as db from "./db";
import { rulesRouter } from "./routers/rules";
import { billingRouter } from "./routers/billing";
import { usersRouter } from "./routers/users";
import { applyRuleLimitsForRuntime, reconcileRuleLimits } from "./ruleLimits";
import { registerAgentReportRoutes } from "./agentReportRoutes";
import { registerAgentHeartbeatRoute } from "./agentHeartbeatRoute";
import { parsePanelCall } from "./ai/panelTools";
import { clearLinkAccessScopeCache, gateForwardRulesForRuntime } from "./linkAccessView";

let server: http.Server | undefined;
await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB! } });
try {
  await ensureDatabaseSchema();
  // Simulate the pre-feature table, then migrate a live legacy rule in place.
  for (const column of ["rateLimitMbps", "trafficLimit", "trafficMode", "expiresAt", "ruleLimitReason", "quotaUsedIn", "quotaUsedOut", "adminManaged"]) {
    await runtime.executeRaw(`ALTER TABLE forward_rules DROP COLUMN "${column}"`);
  }
  await runtime.executeRaw(`INSERT INTO forward_rules (id,"hostId",name,"sourcePort","targetIp","targetPort","userId") VALUES (99,1,'legacy',23999,'192.0.2.99',443,1)`);
  await ensureDatabaseSchema();
  const legacy: any = await db.getForwardRuleById(99);
  assert.equal(legacy.isEnabled, true); assert.equal(legacy.rateLimitMbps, 0);
  assert.equal(legacy.trafficLimit, 0); assert.equal(legacy.trafficMode, "both"); assert.equal(legacy.expiresAt, null);
  assert.equal(legacy.adminManaged, false);
  await runtime.executeRaw(`INSERT INTO users (id,username,password,name,role,"accountEnabled","canAddRules","manualCanAddRules","maxRules","maxPorts") VALUES (1,'admin','unused','Admin','admin',1,1,1,100,100),(2,'user','unused','User','user',1,1,1,100,100)`);
  await runtime.executeRaw(`INSERT INTO hosts (id,name,ip,"userId","agentVersion","isOnline","lastHeartbeat") VALUES (1,'entry','192.0.2.1',1,'2.2.190',1,?),(2,'exit','192.0.2.2',1,'2.2.190',1,?)`, [Math.floor(Date.now()/1000),Math.floor(Date.now()/1000)]);
  await runtime.executeRaw(`UPDATE hosts SET "agentToken"='quota-test-' || id`);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).agentToken = String(req.headers.authorization || "").replace(/^Bearer /, "");
    next();
  });
  registerAgentReportRoutes(app);
  registerAgentHeartbeatRoute(app);
  server = http.createServer(app);
  await new Promise<void>((resolve, reject) => {
    server!.once("error", reject);
    server!.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  let reportSequence = 0;
  const report = async (hostId: number, stats: Array<db.TrafficStatBatchItem["stat"]>, reportId = `quota-${++reportSequence}`) => {
    const response = await fetch(`${baseUrl}/api/agent/traffic`, {
      method: "POST", headers: { authorization: `Bearer quota-test-${hostId}`, "content-type": "application/json" },
      body: JSON.stringify({ reportId, reportProducerId: `quota-producer-${hostId}`, stats }),
    });
    return { status: response.status, body: await response.json() };
  };
  const heartbeat = async (hostId: number) => {
    const response = await fetch(`${baseUrl}/api/agent/heartbeat`, {
      method: "POST", headers: { authorization: `Bearer quota-test-${hostId}`, "content-type": "application/json" },
      body: JSON.stringify({ agentVersion: "2.2.190", forceReconcile: true }),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  await db.setUserHostPermissions(2, [1, 2]);
  await db.setSetting("trafficBillingEnabled", "true");
  await runtime.executeRaw(`UPDATE users SET "balanceCents"=1000`);
  await runtime.executeRaw(`INSERT INTO traffic_billing_configs (id,"resourceType","resourceId",enabled,"requiresPermission","pricePerGbCents",multiplier) VALUES (1,'host',1,1,0,1,100)`);
  const caller = (id: number, role: "admin" | "user") => rulesRouter.createCaller({ user: { id, role }, req: { headers: {} }, res: {} } as any);
  const admin = caller(1, "admin"); const customer = caller(2, "user");
  const adminContext = { user: { id: 1, role: "admin" }, req: { headers: {} }, res: {} } as any;
  const billingAdmin = billingRouter.createCaller(adminContext);
  const userAdmin = usersRouter.createCaller(adminContext);
  const base = { hostId: 1, name: "limited", forwardType: "iptables" as const, protocol: "both" as const, sourcePort: 24001, targetIp: "192.0.2.99", targetPort: 443 };
  const createdAt = new Date(Date.now() - 86400000);
  const expiresAt = new Date(Date.now() + 86400000);
  const { id } = await admin.create({ ...base, userId: 2, rateLimitMbps: 12, trafficLimit: 1000, trafficMode: "max", createdAt, expiresAt });
  let saved: any = await db.getForwardRuleById(id);
  assert.equal(saved.userId, 2); assert.equal(saved.rateLimitMbps, 12); assert.equal(saved.trafficLimit, 1000);
  assert.equal(saved.trafficMode, "max"); assert.ok(Math.abs(saved.createdAt.getTime() - createdAt.getTime()) < 1000);
  assert.ok(Math.abs(saved.expiresAt.getTime() - expiresAt.getTime()) < 1000);
  const normal = await admin.create({ ...base, sourcePort: 24002 });
  const defaults: any = await db.getForwardRuleById(normal.id);
  assert.equal(defaults.trafficLimit, 0); assert.equal(defaults.rateLimitMbps, 0); assert.equal(defaults.expiresAt, null);
  assert.equal((await applyRuleLimitsForRuntime([defaults]))[0].isEnabled, true);
  await assert.rejects(customer.create({ ...base, sourcePort: 24003, trafficLimit: 1 }), /仅管理员/);
  await assert.rejects(customer.update({ id, rateLimitMbps: 0 }), /仅管理员/);
  assert.throws(() => parsePanelCall({ role: "user" }, "rules.update", { id, expiresAt: null }, "write"), /仅管理员/);
  await assert.rejects(admin.update({ id, expiresAt: new Date(createdAt.getTime() - 1000) }), /到期时间/);
  assert.equal((await db.getForwardRuleById(id))!.trafficLimit, 1000);
  const stat = (bytesIn: number, bytesOut: number, ruleId = id, hostId = 1) => ({ stat: { ruleId, hostId, bytesIn, bytesOut, connections: 1 }, userId: 2 });
  const recordTraffic = async (items: db.TrafficStatBatchItem[]) => {
    for (const hostId of new Set(items.map(item => item.stat.hostId))) {
      const result = await report(hostId, items.filter(item => item.stat.hostId === hostId).map(item => item.stat));
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal(result.body.success, true);
    }
  };
  await recordTraffic([stat(600, 500)]);
  await reconcileRuleLimits([id]);
  assert.equal((await db.getForwardRuleById(id))!.ruleLimitReason, null); // max of totals, not their sum
  await admin.update({ id, trafficMode: "both" });
  assert.equal((await db.getForwardRuleById(id))!.ruleLimitReason, "traffic_limit");
  saved = await db.getForwardRuleById(id);
  assert.equal(saved.isEnabled, true); // preserve user's switch
  assert.equal((await applyRuleLimitsForRuntime([saved]))[0].isEnabled, false);
  assert.equal((await applyRuleLimitsForRuntime([defaults]))[0].isEnabled, true);
  assert.equal((await customer.getById({ id }))!.trafficLimit, 1000);
  await assert.rejects(customer.update({ id, name: "still limited" }), /仅可查看/);
  await assert.rejects(customer.toggle({ id, isEnabled: false }), /仅可查看/);
  await assert.rejects(customer.delete({ id }), /仅可查看/);
  await assert.rejects(customer.reorder({ category: "local", ids: [id] }), /仅可查看/);
  assert.equal((await db.getForwardRuleById(id))!.trafficLimit, 1000);
  await assert.rejects(customer.resetTraffic({ scope: "rule", ruleId: id }), /仅可查看/);
  await admin.update({ id, trafficMode: "outbound", expiresAt: null, createdAt: new Date(Date.now() - 2 * 86400000) });
  saved = await db.getForwardRuleById(id);
  assert.equal(saved.ruleLimitReason, null); assert.equal(saved.expiresAt, null);
  await recordTraffic([stat(0, 500)]);
  await reconcileRuleLimits([id]);
  assert.equal((await db.getForwardRuleById(id))!.ruleLimitReason, "traffic_limit"); // exact boundary
  await admin.resetTraffic({ scope: "rule", ruleId: id });
  assert.equal((await db.getForwardRuleById(id))!.ruleLimitReason, null);
  await admin.update({ id, expiresAt: new Date(Date.now() - 60_000) });
  await reconcileRuleLimits();
  saved = await db.getForwardRuleById(id);
  assert.equal(saved.ruleLimitReason, "expired");
  await admin.update({ id, expiresAt: null, trafficLimit: 0, rateLimitMbps: 0 });
  assert.equal((await db.getForwardRuleById(id))!.adminManaged, true);
  await assert.rejects(customer.update({ id, name: "cleared limits" }), /仅可查看/);
  assert.equal((await db.getForwardRuleById(id))!.ruleLimitReason, null);
  // A hidden old Agent cannot silently accept a per-rule speed configuration.
  await runtime.executeRaw(`UPDATE hosts SET "agentVersion"='2.2.186' WHERE id=1`);
  await assert.rejects(admin.update({ id, rateLimitMbps: 1 }), /升级 Agent/);
  assert.equal((await db.getForwardRuleById(id))!.rateLimitMbps, 0);
  await runtime.executeRaw(`UPDATE hosts SET "agentVersion"='2.2.190' WHERE id=1`);
  // Managed members inherit the parent policy at runtime; traffic rolls up once.
  await runtime.executeRaw(`INSERT INTO forward_groups (id,name,"groupType","groupMode",domain,"targetIp","userId") VALUES (10,'group','host','failover','','0.0.0.0',1)`);
  await runtime.executeRaw(`INSERT INTO forward_group_members (id,"groupId","memberType","hostId",priority,"isEnabled") VALUES (101,10,'host',1,0,1),(102,10,'host',2,1,1)`);
  await db.setUserForwardGroupPermissions(2, [10]);
  const template = await admin.create({ ...base, userId: 2, hostId: undefined, sourcePort: 24100, forwardGroupId: 10, rateLimitMbps: 10, trafficLimit: 1000, trafficMode: "max" });
  const children = await db.getForwardGroupChildRulesForTemplate(template.id);
  assert.equal(children.length, 2);
  let gated = await applyRuleLimitsForRuntime(children);
  assert.ok(gated.every((child: any) => child.rateLimitMbps === 10 && child.isEnabled));
  await recordTraffic([stat(600, 50, children[0].id, 1), stat(500, 60, children[1].id, 2)]);
  await reconcileRuleLimits([template.id]);
  assert.equal((await db.getForwardRuleById(template.id))!.ruleLimitReason, "traffic_limit");
  gated = await applyRuleLimitsForRuntime(children);
  assert.ok(gated.every((child: any) => !child.isEnabled && child.ruleLimitReason === "traffic_limit"));
  await admin.update({ id: template.id, trafficLimit: 2000 });
  assert.ok((await applyRuleLimitsForRuntime(children)).every((child: any) => child.isEnabled));
  await admin.update({ id: template.id, expiresAt: new Date(Date.now() + 60_000) });
  // Runtime expiry is checked fresh even before the scheduler stores its reason.
  const expiredPolicy: any = await db.getForwardRuleById(template.id);
  await db.updateForwardRule(template.id, { expiresAt: new Date(Date.now() - 1000), createdAt: new Date(Date.now() - 86400000) });
  assert.equal(expiredPolicy.ruleLimitReason, null);
  assert.ok((await applyRuleLimitsForRuntime(children)).every((child: any) => !child.isEnabled));
  // Chain hops see the same bytes; only the first hop may consume the quota.
  await runtime.executeRaw(`INSERT INTO forward_groups (id,name,"groupType","groupMode",domain,"targetIp","userId", "forwardType") VALUES (11,'chain','host','chain','','0.0.0.0',1,'gost')`);
  await runtime.executeRaw(`INSERT INTO forward_group_members (id,"groupId","memberType","hostId",priority,"isEnabled") VALUES (201,11,'host',1,0,1),(202,11,'host',2,1,1)`);
  await db.setUserForwardGroupPermissions(2, [10, 11]);
  const chain = await admin.create({ ...base, userId: 2, hostId: undefined, sourcePort: 24200, forwardGroupId: 11, rateLimitMbps: 8, trafficLimit: 1000, trafficMode: "max" });
  const chainChildren: any[] = await db.getForwardGroupChildRulesForTemplate(chain.id);
  assert.equal(chainChildren.length, 2);
  const first = chainChildren.find(child => Number(child.hostId) === 1)!;
  const last = chainChildren.find(child => Number(child.hostId) === 2)!;
  await recordTraffic([stat(600, 10, first.id, 1), stat(600, 10, last.id, 2)]);
  await reconcileRuleLimits([chain.id]);
  assert.equal((await db.getForwardRuleById(chain.id))!.ruleLimitReason, null);
  await recordTraffic([stat(400, 10, first.id, 1)]);
  await reconcileRuleLimits([chain.id]);
  assert.equal((await db.getForwardRuleById(chain.id))!.ruleLimitReason, "traffic_limit");
  assert.ok((await applyRuleLimitsForRuntime(chainChildren)).every((child: any) => !child.isEnabled));
  // Replacing all managed members must not reset a logical rule's quota.
  await db.updateForwardRule(first.id, { pendingDelete: true });
  await db.updateForwardRule(last.id, { pendingDelete: true });
  await reconcileRuleLimits([chain.id]);
  assert.equal((await db.getForwardRuleById(chain.id))!.ruleLimitReason, "traffic_limit");
  assert.equal((await db.getForwardRuleById(chain.id))!.quotaUsedIn, 1000);
  // Plain admin-created customer rules stay read-only even without any limits.
  const managed = await admin.create({ ...base, userId: 2, sourcePort: 24300 });
  assert.equal((await customer.getById({ id: managed.id }))!.adminManaged, true);
  await recordTraffic([stat(123, 456, managed.id)]);
  const managedRow = (await customer.getById({ id: managed.id }))!;
  assert.equal(managedRow.quotaUsedIn, 123); assert.equal(managedRow.quotaUsedOut, 456);
  await assert.rejects(customer.toggle({ id: managed.id, isEnabled: false }), /仅可查看/);
  await assert.rejects(customer.resetTraffic({ scope: "rule", ruleId: managed.id }), /仅可查看/);
  const ordinary = await customer.create({ ...base, name: "self-service", sourcePort: 24301 });
  assert.equal((await customer.getById({ id: ordinary.id }))!.adminManaged, false);
  await customer.update({ id: ordinary.id, name: "self-service edited" });
  await customer.toggle({ id: ordinary.id, isEnabled: false });
  // Full reset retains the local owner scope and ignores selected IDs.
  const fullReset = await customer.resetTraffic({ scope: "all", ruleIds: [ordinary.id, managed.id] });
  assert.ok(fullReset.requestedRuleIds.includes(ordinary.id));
  assert.ok(!fullReset.requestedRuleIds.includes(managed.id));
  await assert.rejects(customer.reorder({ category: "local", ids: [ordinary.id, managed.id] }), /仅可查看/);
  await customer.resetTraffic({ scope: "all" }); // excludes managed rules
  assert.equal((await customer.getById({ id: managed.id }))!.quotaUsedOut, 456);
  const batch = await customer.deleteBatch({ ids: [ordinary.id, managed.id] });
  assert.deepEqual(batch.deletedIds, [ordinary.id]);
  assert.equal(batch.failures[0].id, managed.id);
  assert.match(batch.failures[0].error, /仅可查看/);
  assert.equal((await customer.getById({ id: managed.id }))!.pendingDelete, false);
  await admin.toggle({ id: managed.id, isEnabled: false });
  await admin.delete({ id: managed.id });
  // Administrators may share their own rules without creating a subaccount.
  // Administrative permissions never exempt a rule from its own quota/expiry.
  const self = await admin.create({ ...base, sourcePort: 24400, trafficLimit: 1000, trafficMode: "both", rateLimitMbps: 5, createdAt });
  const explicitSelf = await admin.create({ ...base, userId: 1, sourcePort: 24401, trafficLimit: 500, trafficMode: "outbound" });
  assert.equal((await admin.getById({ id: self.id }))!.userId, 1);
  assert.equal((await admin.getById({ id: explicitSelf.id }))!.userId, 1);
  assert.equal((await admin.getById({ id: self.id }))!.adminManaged, true);
  await recordTraffic([{ ...stat(600, 500, self.id), userId: 1 }]);
  await reconcileRuleLimits([self.id]);
  let selfRule = (await admin.getById({ id: self.id }))!;
  assert.equal(selfRule.quotaUsedIn, 600); assert.equal(selfRule.quotaUsedOut, 500);
  assert.equal(selfRule.ruleLimitReason, "traffic_limit");
  assert.equal(selfRule.isEnabled, true);
  let runtimeRules = await gateForwardRulesForRuntime([selfRule, (await admin.getById({ id: explicitSelf.id }))!]);
  assert.equal(runtimeRules[0].isEnabled, false, "admin access cannot bypass the rule quota");
  assert.equal(runtimeRules[1].isEnabled, true, "one capped rule must not disable unrelated admin rules");
  await admin.toggle({ id: self.id, isEnabled: true });
  assert.equal((await gateForwardRulesForRuntime([(await admin.getById({ id: self.id }))!]))[0].isEnabled, false);
  await admin.resetTraffic({ scope: "rule", ruleId: self.id });
  selfRule = (await admin.getById({ id: self.id }))!;
  assert.equal(selfRule.quotaUsedIn, 0); assert.equal(selfRule.quotaUsedOut, 0);
  assert.equal((await gateForwardRulesForRuntime([selfRule]))[0].isEnabled, true);
  await admin.update({ id: self.id, trafficLimit: 2000, expiresAt: new Date(Date.now() - 1000) });
  assert.equal((await gateForwardRulesForRuntime([(await admin.getById({ id: self.id }))!]))[0].isEnabled, false);
  await admin.update({ id: self.id, expiresAt: null });
  assert.equal((await gateForwardRulesForRuntime([(await admin.getById({ id: self.id }))!]))[0].isEnabled, true);
  await recordTraffic([{ ...stat(1000, 499, explicitSelf.id), userId: 1 }]);
  await reconcileRuleLimits([explicitSelf.id]);
  assert.equal((await admin.getById({ id: explicitSelf.id }))!.ruleLimitReason, null);
  await recordTraffic([{ ...stat(0, 1, explicitSelf.id), userId: 1 }]);
  await reconcileRuleLimits([explicitSelf.id]);
  assert.equal((await admin.getById({ id: explicitSelf.id }))!.ruleLimitReason, "traffic_limit");
  // Own-account group rules use the same logical quota across their members.
  const ownGroup = await admin.create({ ...base, userId: 1, hostId: undefined, forwardGroupId: 10, sourcePort: 24402, trafficLimit: 500, trafficMode: "max", rateLimitMbps: 5 });
  const ownChildren: ForwardRule[] = await db.getForwardGroupChildRulesForTemplate(ownGroup.id);
  assert.equal(ownChildren.length, 2);
  assert.ok(ownChildren.every(child => child.userId === 1));
  await recordTraffic(ownChildren.map(child => ({ ...stat(250, 10, child.id, child.hostId), userId: 1 })));
  await reconcileRuleLimits([ownGroup.id]);
  runtimeRules = await gateForwardRulesForRuntime(ownChildren);
  assert.ok(runtimeRules.every(child => !child.isEnabled && child.ruleLimitReason === "traffic_limit" && child.rateLimitMbps === 5));
  await admin.update({ id: ownGroup.id, trafficLimit: 600 });
  assert.ok((await gateForwardRulesForRuntime(ownChildren)).every(child => child.isEnabled));
  // Existing cumulative statistics become the first quota baseline, including
  // traffic reported before the upgrade or before an administrator sets limits.
  await recordTraffic([{ ...stat(400, 500, 99), userId: 1 }]);
  assert.equal((await db.getForwardRuleById(99))!.quotaUsedIn, null);
  await admin.update({ id: 99, trafficLimit: 1000, trafficMode: "both" });
  assert.equal((await db.getForwardRuleById(99))!.quotaUsedIn, 400);
  assert.equal((await db.getForwardRuleById(99))!.quotaUsedOut, 500);
  const lastReport = stat(40, 60, 99).stat;
  assert.equal((await report(1, [lastReport], "baseline-boundary")).status, 200);
  assert.deepEqual(await report(1, [lastReport], "baseline-boundary"), { status: 200, body: { success: true, duplicate: true } });
  assert.equal((await db.getForwardRuleById(99))!.ruleLimitReason, "traffic_limit");
  assert.equal((await db.getForwardRuleById(99))!.quotaUsedIn, 440);
  assert.equal((await db.getForwardRuleById(99))!.quotaUsedOut, 560);
  assert.equal((await report(2, [lastReport], "wrong-host")).status, 200);
  assert.equal((await report(999, [lastReport], "wrong-token")).status, 401);
  assert.equal((await db.getForwardRuleById(99))!.quotaUsedIn, 440);
  // Normal toggling, changing dates and replacing a direct host preserve usage.
  await admin.toggle({ id: 99, isEnabled: false });
  await admin.toggle({ id: 99, isEnabled: true });
  await admin.update({ id: 99, hostId: 2, createdAt: new Date(Date.now() - 5 * 86400000) });
  const upgraded = (await db.getForwardRuleById(99))!;
  assert.equal(upgraded.quotaUsedIn, 440); assert.equal(upgraded.quotaUsedOut, 560);
  assert.equal(upgraded.ruleLimitReason, "traffic_limit"); assert.equal(upgraded.isEnabled, true);
  const beforeReset = await db.getTrafficCounterSummaryByRule({ ruleIds: [99], includeLatency: false });
  const accountSnapshot = async () => ({
    users: await runtime.queryRaw(`SELECT id,"trafficUsed","balanceCents","expiresAt" FROM users ORDER BY id`),
    usage: await runtime.queryRaw(`SELECT * FROM traffic_billing_usage ORDER BY id`),
    ruleUsage: await runtime.queryRaw(`SELECT * FROM traffic_billing_rule_usage ORDER BY id`),
    records: await runtime.queryRaw(`SELECT * FROM traffic_billing_records ORDER BY id`),
  });
  // Produce a real, nonzero charge before checking that reset preserves ledgers.
  await recordTraffic([{ ...stat(0, 1024 ** 3, normal.id), userId: 1 }]);
  const accountsBefore = await accountSnapshot();
  assert.ok(accountsBefore.usage.length > 0 && accountsBefore.ruleUsage.length > 0 && accountsBefore.records.length > 0,
    "reset preservation must cover populated billing ledgers");
  // A failing quota write must roll back earlier statistic deletions as well.
  await runtime.executeRaw(`CREATE TRIGGER reject_quota_reset BEFORE UPDATE OF "quotaUsedIn" ON forward_rules
    WHEN NEW.id=99 AND NEW."quotaUsedIn"=0 BEGIN SELECT RAISE(ABORT,'quota reset failure'); END`);
  await assert.rejects(admin.resetTraffic({ scope: "rule", ruleId: 99 }), /quota reset failure/);
  assert.deepEqual(await db.getTrafficCounterSummaryByRule({ ruleIds: [99], includeLatency: false }), beforeReset);
  assert.equal((await db.getForwardRuleById(99))!.quotaUsedIn, 440);
  await runtime.executeRaw(`DROP TRIGGER reject_quota_reset`);
  await admin.resetTraffic({ scope: "rule", ruleId: 99 });
  assert.equal((await db.getForwardRuleById(99))!.quotaUsedIn, 0);
  assert.equal((await db.getForwardRuleById(99))!.ruleLimitReason, null);
  assert.ok((await db.getTrafficCounterSummaryByRule({ ruleIds: [99], includeLatency: false })).every(row => row.bytesIn === 0 && row.bytesOut === 0));
  assert.deepEqual(await accountSnapshot(), accountsBefore);
  // A user scope spans pages/categories and ignores the supplied selection.
  const scopedRules = await admin.list({ userId: 2 });
  const scopePage = await admin.listPage({ userId: 2, page: 1, pageSize: 1 });
  assert.ok(scopePage.totalItems > scopePage.items.length);
  const ownBefore = (await db.getForwardRuleById(ownGroup.id))!;
  const reset = await admin.resetTraffic({ scope: "all", userId: 2, ruleIds: [id] });
  assert.deepEqual(reset.requestedRuleIds, scopedRules.map(rule => Number(rule.id)).sort((a, b) => a - b));
  assert.equal((await db.getForwardRuleById(ownGroup.id))!.quotaUsedIn, ownBefore.quotaUsedIn);
  assert.equal((await db.getForwardRuleById(id))!.quotaUsedIn, 0);
  // Resetting usage cannot remove expiry or account/plan/balance blockers.
  await admin.update({ id, expiresAt: new Date(Date.now() - 1000) });
  await admin.resetTraffic({ scope: "rule", ruleId: id });
  assert.equal((await db.getForwardRuleById(id))!.ruleLimitReason, "expired");
  await admin.update({ id, expiresAt: new Date(Date.now() + 86400000), trafficLimit: 1 });
  await recordTraffic([stat(1, 1)]);
  await db.setUserForwardAccess(2, false, "traffic_limit");
  await admin.resetTraffic({ scope: "rule", ruleId: id });
  assert.equal((await db.getForwardRuleById(id))!.ruleLimitReason, null);
  assert.equal((await db.getForwardRuleById(id))!.isEnabled, false);
  assert.equal((await db.getForwardRuleById(id))!.disabledByUser, true);
  await db.setUserForwardAccess(2, true);
  await admin.toggle({ id, isEnabled: true });
  assert.equal((await db.getForwardRuleById(id))!.isEnabled, true);
  clearLinkAccessScopeCache();
  assert.equal((await gateForwardRulesForRuntime([(await db.getForwardRuleById(id))!]))[0].isEnabled, true,
    "the rule must be runnable before introducing a balance blocker");
  await runtime.executeRaw(`UPDATE users SET "balanceCents"=0 WHERE id=2`);
  clearLinkAccessScopeCache();
  await recordTraffic([stat(1, 1)]);
  assert.equal((await db.getUserById(2))!.forwardAccessPauseReason, "traffic_billing_balance");
  assert.equal((await db.getForwardRuleById(id))!.disabledByUser, true);
  await admin.resetTraffic({ scope: "rule", ruleId: id });
  assert.equal((await db.getForwardRuleById(id))!.ruleLimitReason, null);
  assert.equal((await db.getUserById(2))!.forwardAccessPauseReason, "traffic_billing_balance");
  assert.equal((await db.getForwardRuleById(id))!.isEnabled, false, "rule reset cannot undo a billing pause");
  assert.equal((await gateForwardRulesForRuntime([(await db.getForwardRuleById(id))!]))[0].isEnabled, false);
  await billingAdmin.adminSetBalance({ userId: 2, balanceCents: 1000 });
  clearLinkAccessScopeCache();
  assert.equal((await gateForwardRulesForRuntime([(await db.getForwardRuleById(id))!]))[0].isEnabled, true);
  await userAdmin.setAccountEnabled({ userId: 2, enabled: false });
  await admin.resetTraffic({ scope: "rule", ruleId: id });
  assert.equal((await db.getUserById(2))!.accountEnabled, false);
  assert.equal((await db.getForwardRuleById(id))!.isEnabled, false);
  assert.equal((await db.getForwardRuleById(id))!.disabledByUser, true);
  await userAdmin.setAccountEnabled({ userId: 2, enabled: true });
  // Two public entries share a downstream chain member. Only entry Agents
  // enforce the rule cap, so the downstream must not pool both entry buckets.
  await runtime.executeRaw(`INSERT INTO hosts (id,name,ip,"userId","agentVersion","agentToken","isOnline","lastHeartbeat")
    VALUES (3,'downstream','192.0.2.3',1,'2.2.186','quota-test-3',1,?)`, [Math.floor(Date.now()/1000)]);
  await runtime.executeRaw(`INSERT INTO forward_groups (id,name,"groupType","groupMode","forwardType",domain,"targetIp","userId","entryGroupId")
    VALUES (30,'entries','host','entry','gost','','0.0.0.0',1,NULL),(31,'multi-entry-chain','host','chain','gost','','0.0.0.0',1,30)`);
  await runtime.executeRaw(`INSERT INTO forward_group_members (id,"groupId","memberType","hostId",priority,"isEnabled")
    VALUES (301,30,'host',1,10,1),(302,30,'host',2,20,1),(311,31,'host',3,10,1)`);
  const multiEntry = await admin.create({ ...base, hostId: undefined, forwardGroupId: 31, sourcePort: 24500, forwardType: "gost", protocol: "tcp", rateLimitMbps: 10 });
  const entryRules: ForwardRule[] = await db.getForwardGroupChildRulesForTemplate(multiEntry.id);
  assert.deepEqual(entryRules.map(rule => Number(rule.hostId)).sort(), [1, 2, 3]);
  await runtime.executeRaw(`UPDATE hosts SET "agentVersion"='2.2.186' WHERE id=2`);
  await assert.rejects(admin.update({ id: multiEntry.id, rateLimitMbps: 12 }), /入口 Agent.*升级/);
  await runtime.executeRaw(`UPDATE hosts SET "agentVersion"='2.2.190' WHERE id=2`);
  const entryLimitEvidence = [];
  for (const hostId of [1, 2, 3]) {
    const payload = await heartbeat(hostId);
    const child = entryRules.find(rule => Number(rule.hostId) === hostId)!;
    const configs = (payload.desiredState?.actions || payload.actions || []).flatMap((action: any) => action.managedConfigs || []).filter((config: any) => config.format === "json")
      .map((config: any) => JSON.parse(Buffer.from(config.contentBase64, "base64").toString("utf8")));
    const service = configs.flatMap((config: any) => config.services || []).find((service: any) => service.name === `fwx-${child.id}-tcp`);
    assert.ok(service, `host ${hostId} must receive its live GOST service: ${JSON.stringify({ requestLocalState: payload.requestLocalState, services: configs.flatMap((config: any) => (config.services || []).map((service: any) => service.name)) })}`);
    if (hostId < 3) assert.equal(service.limiter, `fwx-rule-${multiEntry.id}-host-${hostId}-10`);
    else assert.equal(service.limiter, undefined, "shared downstream must not enforce the public-entry rule cap");
    entryLimitEvidence.push({ hostId, ruleId: child.id, limiter: service.limiter || null });
  }
  // Durable logical counters survive closing/reopening the database.
  await runtime.closeDatabase();
  await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB! } });
  const durable = (await db.getForwardRuleById(ownGroup.id))!;
  assert.equal(durable.quotaUsedIn, ownBefore.quotaUsedIn);
  assert.equal(durable.quotaUsedOut, ownBefore.quotaUsedOut);
  if (process.env.FORWARDX_RULE_LIMIT_EVIDENCE_DIR) {
    fs.mkdirSync(process.env.FORWARDX_RULE_LIMIT_EVIDENCE_DIR, { recursive: true });
    fs.writeFileSync(path.join(process.env.FORWARDX_RULE_LIMIT_EVIDENCE_DIR, "逻辑额度与重置结果.json"), JSON.stringify({
      upgraded: { id: upgraded.id, enabled: upgraded.isEnabled, reason: upgraded.ruleLimitReason, bytesIn: upgraded.quotaUsedIn, bytesOut: upgraded.quotaUsedOut },
      resetScope: reset.requestedRuleIds, transactionRollbackVerified: true, accountLedgersPreserved: true,
      persisted: { id: durable.id, bytesIn: durable.quotaUsedIn, bytesOut: durable.quotaUsedOut },
      entryLimits: entryLimitEvidence,
    }, null, 2));
  }
} finally {
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
  await runtime.closeDatabase();
}
