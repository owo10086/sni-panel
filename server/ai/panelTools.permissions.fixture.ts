import assert from "node:assert/strict";
import * as runtime from "../dbRuntime";
import { ensureDatabaseSchema } from "../dbSchema";
import * as db from "../db";
import { appRouter } from "../routers";
import { preparePanelCall, executePanelCall, PanelPreflightError } from "./panelTools";
import { toggleForwardRuleForActor, deleteForwardRuleForActor } from "../routers/rules.crud";

await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB! } });
const insert = (table: string, values: Record<string, unknown>) => runtime.executeRaw(
  `INSERT INTO "${table}" (${Object.keys(values).map(key => `"${key}"`).join(",")}) VALUES (${Object.keys(values).map(() => "?").join(",")})`, Object.values(values));
const caller = async (id: number) => appRouter.createCaller({
  user: (await db.getUserById(id))!, authSession: null, authFailureReason: null,
  req: { headers: {}, socket: {}, protocol: "https", get: () => undefined }, res: { clearCookie: () => undefined },
} as any);
const run = async (actor: number, tool: string, input: unknown) => executePanelCall(actor, await preparePanelCall(actor, tool, input));
try {
  await ensureDatabaseSchema();
  for (const id of [1, 2, 3]) await insert("users", { id, username: `actor${id}`, password: "test-only", role: id === 1 ? "admin" : "user",
    accountEnabled: 1, canAddRules: 1, manualCanAddRules: 1, balanceCents: 1000 });
  for (const id of [1, 2]) await insert("hosts", { id, name: `主机${id}`, ip: `198.51.100.${id}`, ipv4: `198.51.100.${id}`, userId: 1,
    isOnline: 1, lastHeartbeat: Math.floor(Date.now() / 1000), agentVersion: "3.3.0", portRangeStart: id === 1 ? 18000 : 24000, portRangeEnd: id === 1 ? 19000 : 24100 });
  for (const id of [10, 11]) await insert("forward_groups", { id, name: `资源${id}`, groupType: "host", groupMode: id === 10 ? "port" : "chain",
    forwardType: "nftables", domain: "", targetIp: "0.0.0.0", targetPort: 1, userId: 1, isEnabled: 1 });
  await insert("forward_group_members", { id: 101, groupId: 10, memberType: "host", hostId: 1, priority: 0, isEnabled: 1 });
  for (const id of [1, 2]) await insert("forward_group_members", { id: 110 + id, groupId: 11, memberType: "host", hostId: id, priority: id, isEnabled: 1 });
  await db.setUserForwardGroupPermissions(2, [10, 11]);
  const admin = await caller(1);
  const owner = await caller(2);
  const base = { name: "用户自建 <&>", forwardGroupId: 10, forwardType: "nftables", protocol: "tcp", sourcePort: 18500, targetIp: "203.0.113.20", targetPort: 443 } satisfies Parameters<typeof admin.rules.create>[0];
  const routeChanged = await preparePanelCall(2, "rules.create", base);
  await admin.forwardGroups.updateFields({ id: 10, forwardType: "realm" });
  await assert.rejects(executePanelCall(2, routeChanged), error => error instanceof PanelPreflightError && /配置已.*变化/.test(error.message));
  assert.equal((await owner.rules.list()).length, 0, "a changed route rejects creation before any rules are written");
  await admin.forwardGroups.updateFields({ id: 10, forwardType: "nftables" });
  const own = (await run(2, "rules.create", base)).result.id;
  await run(2, "rules.update", { id: own, targetPort: 8443 });
  const read = (await owner.rules.getById({ id: own }))!;
  assert.equal(read.userId, 2);
  assert.equal(read.name, "用户自建 <&>");
  assert.equal(read.sourcePort, 18500);
  assert.equal(read.targetIp, "203.0.113.20");
  assert.equal(read.targetPort, 8443);
  assert.equal(read.protocol, "tcp");
  assert.equal(read.forwardGroupId, 10);
  assert.equal(read.adminManaged, false);
  await run(2, "rules.update", { id: own, isEnabled: false });
  assert.equal((await owner.rules.getById({ id: own }))!.isEnabled, false);
  await run(2, "rules.update", { id: own, isEnabled: true });
  await assert.rejects(preparePanelCall(3, "rules.update", { id: own, name: "跨用户" }), /无权/);
  await assert.rejects(preparePanelCall(2, "rules.update", { id: own, trafficLimit: 1 }), /仅管理员/);
  await assert.rejects(run(1, "rules.create", { ...base, userId: 3, sourcePort: 18501 }), /无权使用该转发组/);
  await assert.rejects(run(1, "rules.create", { ...base, userId: 2, sourcePort: 19500 }), /端口范围|允许范围/);
  const managed = (await run(1, "rules.create", { ...base, userId: 2, sourcePort: 18502, trafficLimit: 500, trafficMode: "outbound" })).result.id;
  await assert.rejects(preparePanelCall(2, "rules.update", { id: managed, name: "禁止" }), /仅可查看/);
  await assert.rejects(preparePanelCall(2, "rules.update", { id: managed, isEnabled: false }), /仅可查看/);
  await assert.rejects(toggleForwardRuleForActor({ id: 2, role: "user" }, managed, false), /仅可查看/);
  await assert.rejects(deleteForwardRuleForActor({ id: 2, role: "user" }, managed), /仅可查看/);
  const sni = await admin.rules.create({ ...base, userId: 2, forwardGroupId: 11, sourcePort: 18503, sni: "managed.example.test" });
  await assert.rejects(preparePanelCall(2, "rules.update", { id: Number(sni.id), targetPort: 80 }), /仅可查看/);
  const children = await db.getForwardGroupChildRulesForTemplate(Number(sni.id));
  assert.equal(children.length, 2);
  await assert.rejects(preparePanelCall(1, "rules.update", { id: children[0].id, name: "绕过模板" }), /系统维护/);
  const revoked = await preparePanelCall(2, "rules.update", { id: own, targetPort: 9443 });
  await admin.users.setForwardGroupPermissions({ userId: 2, forwardGroupIds: [] });
  await assert.rejects(executePanelCall(2, revoked), error => error instanceof PanelPreflightError && /配置已.*变化/.test(error.message));
  await assert.rejects(run(2, "rules.update", { id: own, targetPort: 9443 }), /无权使用该转发组/);
  assert.equal((await owner.rules.getById({ id: own }))!.targetPort, 8443);
  await admin.users.setForwardGroupPermissions({ userId: 2, forwardGroupIds: [10, 11] });
  const paused = await preparePanelCall(2, "rules.update", { id: own, name: "暂停后禁止" });
  await runtime.executeRaw(`UPDATE users SET "accountEnabled"=0 WHERE id=2`);
  await assert.rejects(executePanelCall(2, paused), error => error instanceof PanelPreflightError && /停用/.test(error.message));
  await assert.rejects(run(1, "rules.create", { ...base, userId: 2, sourcePort: 18504 }), /停用|禁用/);
  await runtime.executeRaw(`UPDATE users SET "accountEnabled"=1,"maxRules"=1,"manualMaxRules"=1 WHERE id=2`);
  await assert.rejects(run(1, "rules.create", { ...base, userId: 2, sourcePort: 18504 }), /最大规则数量限制/);
  await runtime.closeDatabase();
  await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB! } });
  const persisted = (await (await caller(2)).rules.getById({ id: own }))!;
  assert.equal(persisted.name, "用户自建 <&>");
  assert.equal(persisted.targetPort, 8443);
  assert.equal(persisted.protocol, "tcp");
  assert.equal(persisted.forwardGroupId, 10);
  console.log(JSON.stringify({ ordinaryRule: own, managedRule: managed, sniRule: Number(sni.id), derivedRules: children.length,
    partialUpdatePreserved: true, ownerChecksPassed: true, executionRevocationRejected: true, reopenPreserved: true }));
} finally { await runtime.closeDatabase(); }
