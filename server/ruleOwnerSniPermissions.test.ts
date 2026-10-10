import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function verifyRules(body: string, evidenceName?: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-owner-sni-"));
  const script = String.raw`
    import assert from "node:assert/strict";
    const runtime = await import("./server/dbRuntime.ts");
    const schema = await import("./server/dbSchema.ts");
    const { rulesRouter } = await import("./server/routers/rules.ts");
    const insert = (table, columns, values) => runtime.executeRaw(
      'INSERT INTO "' + table + '" (' + columns.map(c => '"' + c + '"').join(',') + ') VALUES (' + values.map(() => '?').join(',') + ')', values);
    const context = user => ({ req: { headers: {} }, res: { clearCookie() {} }, user, authSession: null, authFailureReason: null });
    const input = overrides => ({ forwardGroupId: 10, name: "分流", forwardType: "nftables", protocol: "tcp", sourcePort: 18443, targetIp: "203.0.113.20", targetPort: 443, sni: "api.example.com", ...overrides });
    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      await insert("users", ["id", "username", "password", "role", "canAddRules", "manualCanAddRules", "balanceCents"], [1, "admin", "x", "admin", 1, 1, 1000]);
      await insert("users", ["id", "username", "password", "role", "canAddRules", "manualCanAddRules", "balanceCents"], [2, "owner", "x", "user", 1, 1, 1000]);
      await insert("users", ["id", "username", "password", "role", "canAddRules", "manualCanAddRules"], [3, "other", "x", "user", 1, 1]);
      const now = Math.floor(Date.now()/1000);
      for (const [id, name, start, end] of [[1,"入口",18000,19000],[2,"出口",24000,24010]]) {
        await insert("hosts", ["id", "name", "ip", "ipv4", "userId", "isOnline", "lastHeartbeat", "agentVersion", "portRangeStart", "portRangeEnd"], [id,name,"198.51.100."+id,"198.51.100."+id,1,1,now,"3.2.0",start,end]);
      }
      await insert("forward_groups", ["id", "name", "groupType", "groupMode", "forwardType", "domain", "targetIp", "targetPort", "userId", "isEnabled"], [10,"链","host","chain","nftables","","0.0.0.0",1,1,1]);
      for (const id of [1,2]) await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [100+id,10,"host",id,id*10,1]);
      await insert("user_forward_group_permissions", ["userId", "forwardGroupId"], [2,10]);
      const admin = rulesRouter.createCaller(context({ id: 1, role: "admin", accountEnabled: true }));
      const owner = rulesRouter.createCaller(context({ id: 2, role: "user", accountEnabled: true }));
      const other = rulesRouter.createCaller(context({ id: 3, role: "user", accountEnabled: true }));
      ${body}
    } finally { await runtime.closeDatabase(); }
  `;
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(), env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "rules.db") }, encoding: "utf8", timeout: 60_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const evidenceDirectory = process.env.FORWARDX_RULE_OWNER_EVIDENCE_DIR;
    if (evidenceDirectory && evidenceName) {
      fs.mkdirSync(evidenceDirectory, { recursive: true });
      fs.writeFileSync(path.join(evidenceDirectory, evidenceName + ".log"), result.stdout);
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

test("administrator configures SNI for the selected owner while enforcing that owner's resource access", () => {
  verifyRules(String.raw`
    assert.equal((await admin.checkPort({ userId: 2, forwardGroupId: 10, sourcePort: 18443, protocol: "tcp", sni: "api.example.com" })).used, false);
    const created = await admin.create(input({ userId: 2 }));
    const rule = await owner.getById({ id: Number(created.id) });
    assert.equal(rule.userId, 2);
    assert.equal(rule.sni, "api.example.com");
    await assert.rejects(() => admin.create(input({ userId: 3, sni: "other.example.com" })), /无权使用该转发组/);
    await assert.rejects(() => owner.create(input({ userId: 1 })), /无权操作其他用户/);
    await assert.rejects(() => owner.create(input({ sni: "own.example.com" })), /仅管理员/);
    await assert.rejects(() => owner.update({ id: rule.id, name: "不能改名" }), /仅可查看/);
    await assert.rejects(() => other.toggle({ id: rule.id, isEnabled: false }), /无权操作/);
    const self = await admin.create(input({ sni: "self.example.com" }));
    assert.equal((await admin.getById({ id: Number(self.id) })).userId, 1);
  `);
});

test("administrator-created SNI is read-only for its ordinary owner", () => {
  verifyRules(String.raw`
    const created = await admin.create(input({ userId: 2 }));
    const id = Number(created.id);
    assert.equal((await owner.getById({ id })).userId, 2);
    await assert.rejects(() => owner.toggle({ id, isEnabled: false }), /管理员.*仅可查看/);
    await assert.rejects(() => owner.delete({ id }), /管理员.*仅可查看/);
    await assert.rejects(() => owner.resetTraffic({ scope: "rule", ruleId: id }), /管理员.*仅可查看/);
    await admin.toggle({ id, isEnabled: false });
    await admin.toggle({ id, isEnabled: true });
  `);
});

test("ordinary sorting cannot move managed rules omitted from the request or another page", () => {
  verifyRules(String.raw`
    const first = await owner.create(input({ sni: null, sourcePort: 18440, name: "自建一" }));
    const managed = await admin.create(input({ userId: 2, sourcePort: 18441, name: "托管" }));
    const last = await owner.create(input({ sni: null, sourcePort: 18442, name: "自建二" }));
    const list = () => owner.listPage({ category: "chain", page: 1, pageSize: 10 });
    const before = (await list()).items.map(rule => ({ id: rule.id, sortOrder: rule.sortOrder }));
    const page = await owner.listPage({ category: "chain", page: 3, pageSize: 1 });
    assert.equal(page.items[0].id, Number(last.id));
    assert.equal(page.hasAdminManagedRules, true, "sorting availability covers managed rules on other pages");
    await assert.rejects(() => owner.reorder({ category: "chain", ids: [Number(last.id), Number(first.id)] }), /仅可查看/);
    await assert.rejects(() => owner.reorder({ category: "chain", ids: [Number(last.id)], startIndex: 0 }), /仅可查看/);
    await assert.rejects(() => owner.reorder({ category: "chain", ids: [Number(first.id)], startIndex: 2 }), /仅可查看/);
    assert.deepEqual((await list()).items.map(rule => ({ id: rule.id, sortOrder: rule.sortOrder })), before, "rejected requests leave all persisted positions intact");
    await admin.reorder({ category: "chain", ids: [Number(last.id)], startIndex: 0 });
    assert.deepEqual((await list()).items.map(rule => rule.id), [Number(last.id), Number(first.id), Number(managed.id)]);

    await insert("forward_groups", ["id", "name", "groupType", "groupMode", "forwardType", "domain", "targetIp", "targetPort", "userId", "isEnabled"], [20,"端口转发","host","port","nftables","","0.0.0.0",1,2,1]);
    await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [201,20,"host",1,10,1]);
    const local = await owner.create(input({ sni: null, forwardGroupId: 20, sourcePort: 18445 }));
    const local2 = await owner.create(input({ sni: null, forwardGroupId: 20, sourcePort: 18446 }));
    await owner.reorder({ category: "local", ids: [Number(local2.id), Number(local.id)] });
    const localPage = await owner.listPage({ category: "local", page: 1, pageSize: 10 });
    assert.equal(localPage.hasAdminManagedRules, false);
    assert.deepEqual(localPage.items.map(rule => rule.id), [Number(local2.id), Number(local.id)]);
    console.log(JSON.stringify({ case: "managed-sorting", before, rejected: ["omitted-managed-id", "other-page-to-front", "first-to-last"], unchangedAfterRejections: true, administratorOrder: (await list()).items.map(rule => ({id:rule.id,sortOrder:rule.sortOrder})), scopeMetadata: { chain: page.hasAdminManagedRules, local: localPage.hasAdminManagedRules }, writableCategoryOrder: localPage.items.map(rule=>rule.id) }));
  `, "排序持久状态");
});

test("administrators retain SNI port deduplication and rule quotas for a managed owner", () => {
  verifyRules(String.raw`
    await runtime.executeRaw('UPDATE "users" SET "maxRules"=2,"maxPorts"=1,"manualMaxRules"=2,"manualMaxPorts"=1 WHERE "id"=2');
    const first = await admin.create(input({ userId: 2 }));
    const second = await admin.create(input({ userId: 2, sni: "web.example.com" }));
    await assert.rejects(() => admin.update({ id: Number(second.id), sourcePort: 18444 }), /最大端口数量/);
    await assert.rejects(() => owner.toggle({ id: Number(first.id), isEnabled: false }), /仅可查看/);
    await admin.toggle({ id: Number(first.id), isEnabled: false });
    await admin.toggle({ id: Number(first.id), isEnabled: true });
    assert.equal((await owner.getById({ id: Number(first.id) })).isEnabled, true);
    await assert.rejects(() => admin.create(input({ userId: 2, sni: "third.example.com" })), /最大规则数量/);
    await runtime.executeRaw('UPDATE "users" SET "maxRules"=3,"manualMaxRules"=3 WHERE "id"=2');
    await assert.rejects(() => admin.create(input({ userId: 2, sourcePort: 18444, sni: "newport.example.com" })), /最大端口数量/);
    await runtime.executeRaw('DELETE FROM "user_forward_group_permissions" WHERE "userId"=2');
    await assert.rejects(() => owner.toggle({ id: Number(first.id), isEnabled: false }), /仅可查看/);
    await admin.toggle({ id: Number(first.id), isEnabled: false });
    await assert.rejects(() => admin.toggle({ id: Number(first.id), isEnabled: true }), /无权使用该转发组/);
    await assert.rejects(() => owner.toggle({ id: Number(first.id), isEnabled: true }), /仅可查看/);
    const result = await admin.deleteBatch({ ids: [Number(first.id), Number(second.id)] });
    assert.deepEqual(result.deletedIds.sort((a,b)=>a-b), [Number(first.id), Number(second.id)].sort((a,b)=>a-b));
  `);
});

test("editing shared SNI entry ports within the owner quota preserves both logical rules", () => {
  verifyRules(String.raw`
    await runtime.executeRaw('UPDATE "users" SET "maxRules"=2,"maxPorts"=2,"manualMaxRules"=2,"manualMaxPorts"=2 WHERE "id"=2');
    const first = await admin.create(input({ userId: 2 }));
    const second = await admin.create(input({ userId: 2, sni: "web.example.com" }));
    await admin.update({ id: Number(second.id), sourcePort: 18444 });
    assert.equal((await admin.getById({ id: Number(first.id) })).sourcePort, 18443);
    assert.equal((await admin.getById({ id: Number(second.id) })).sourcePort, 18444);
    await admin.update({ id: Number(second.id), sourcePort: 18443 });
    assert.equal((await admin.getById({ id: Number(second.id) })).sourcePort, 18443);
    assert.equal((await owner.listPage({ category: "chain", page: 1, pageSize: 10 })).items.length, 2);
  `);
});

test("clearing SNI expiry cannot allocate a stale tunnel exit over its shared splitter", () => {
  verifyRules(String.raw`
    await insert("tunnels", ["id","name","entryHostId","exitHostId","mode","listenPort","userId","isEnabled"], [30,"旧出口端口",1,2,"tls",21000,1,1]);
    for (const [id, sni] of [[51,"stale-api.example.com"],[52,"stale-web.example.com"]]) {
      await insert("forward_rules", ["id","hostId","name","forwardType","protocol","sourcePort","targetIp","targetPort","sni","sniSplitterPort","tunnelExitPort","tunnelId","userId","isEnabled","createdAt","expiresAt","ruleLimitReason"],
        [id,1,sni,"gost","tcp",18443,"203.0.113.20",443,sni,24000,21000,30,1,1,Math.floor(Date.now()/1000)-86400,id===51 ? Math.floor(Date.now()/1000)-1 : null,id===51 ? "expired" : null]);
    }
    // A deterministic allocation chooses the first port in the NAT range.
    // That port already belongs to the shared splitter and must be protected.
    const random = Math.random;
    try {
      Math.random = () => 0;
      await admin.update({ id: 51, expiresAt: null });
    } finally { Math.random = random; }
    const api = await admin.getById({ id: 51 });
    const web = await admin.getById({ id: 52 });
    assert.equal(api.ruleLimitReason, null);
    assert.equal(api.sniSplitterPort, 24000);
    assert.equal(web.sniSplitterPort, 24000);
    assert.equal(api.sourcePort, 18443);
    assert.equal(api.isEnabled, true);
  `);
});

test("legacy limited SNI upgrades to read-only and clearing limits retains its managed flag", () => {
  verifyRules(String.raw`
    for (const column of ["trafficLimit", "trafficMode", "expiresAt", "ruleLimitReason", "quotaUsedIn", "quotaUsedOut", "adminManaged"]) {
      await runtime.executeRaw('ALTER TABLE "forward_rules" DROP COLUMN "' + column + '"');
    }
    await insert("forward_rules", ["id", "hostId", "name", "forwardType", "protocol", "sourcePort", "targetIp", "targetPort", "sni", "rateLimitMbps", "sniSplitterPort", "forwardGroupId", "isForwardGroupTemplate", "userId"], [50,1,"旧限速 SNI","nftables","tcp",18443,"203.0.113.20",443,"legacy.example.com",12,24000,10,1,2]);
    await schema.ensureDatabaseSchema();
    const before = await owner.getById({ id: 50 });
    assert.equal(before.adminManaged, false, "upgrade does not invent a saved flag for existing rows");
    assert.equal(before.rateLimitMbps, 12);
    assert.equal(before.sni, "legacy.example.com");
    assert.equal(before.isEnabled, true);
    const assertReadOnly = async () => {
      await assert.rejects(() => owner.update({ id: 50, name: "不能改" }), /仅可查看/);
      await assert.rejects(() => owner.toggle({ id: 50, isEnabled: false }), /仅可查看/);
      await assert.rejects(() => owner.delete({ id: 50 }), /仅可查看/);
      await assert.rejects(() => owner.reorder({ category: "chain", ids: [50] }), /仅可查看/);
      await assert.rejects(() => owner.resetTraffic({ scope: "rule", ruleId: 50 }), /仅可查看/);
      const batch = await owner.deleteBatch({ ids: [50] });
      assert.deepEqual(batch.deletedIds, []);
      assert.equal(batch.failures[0].id, 50);
      assert.match(batch.failures[0].error, /仅可查看/);
    };
    await assertReadOnly();
    await admin.update({ id: 50, rateLimitMbps: 0, trafficLimit: 0, expiresAt: null });
    const cleared = await owner.getById({ id: 50 });
    assert.equal(cleared.adminManaged, true);
    assert.equal(cleared.rateLimitMbps, 0);
    assert.equal(cleared.trafficLimit, 0);
    assert.equal(cleared.expiresAt, null);
    await assertReadOnly();
    await runtime.closeDatabase();
    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
    assert.equal((await owner.getById({ id: 50 })).adminManaged, true, "saved flag survives database reconnection");
    await assertReadOnly();
    console.log(JSON.stringify({ case: "legacy-limited-sni", before: { id: before.id, sni: before.sni, adminManaged: before.adminManaged, rateLimitMbps: before.rateLimitMbps }, after: { id: cleared.id, adminManaged: cleared.adminManaged, rateLimitMbps: cleared.rateLimitMbps, trafficLimit: cleared.trafficLimit, expiresAt: cleared.expiresAt }, deniedOperations: ["update", "toggle", "delete", "reorder", "resetTraffic", "deleteBatch"], persistedAfterReconnect: true }));
  `, "存量SNI升级状态");
});

test("editing and toggling use the same owner quota checks when re-enabling existing rules", () => {
  verifyRules(String.raw`
    const first = await owner.create(input({ sni: null, sourcePort: 18440, name: "自建一" }));
    await owner.create(input({ sni: null, sourcePort: 18441, name: "自建二" }));
    const id = Number(first.id);
    await owner.toggle({ id, isEnabled: false });
    await runtime.executeRaw('UPDATE "users" SET "maxRules"=1,"manualMaxRules"=1 WHERE "id"=2');
    for (const actor of [owner, admin]) {
      await assert.rejects(() => actor.toggle({ id, isEnabled: true }), /最大规则数量/);
      await assert.rejects(() => actor.update({ id, isEnabled: true }), /最大规则数量/);
      assert.equal((await owner.getById({ id })).isEnabled, false);
    }
    await runtime.executeRaw('UPDATE "users" SET "maxRules"=0,"manualMaxRules"=0,"maxPorts"=1,"manualMaxPorts"=1 WHERE "id"=2');
    for (const actor of [owner, admin]) {
      await assert.rejects(() => actor.toggle({ id, isEnabled: true }), /最大端口数量/);
      await assert.rejects(() => actor.update({ id, isEnabled: true }), /最大端口数量/);
      assert.equal((await owner.getById({ id })).isEnabled, false);
    }
    await runtime.executeRaw('UPDATE "users" SET "maxPorts"=2,"manualMaxPorts"=2 WHERE "id"=2');
    await admin.update({ id, isEnabled: true });
    assert.equal((await owner.getById({ id })).isEnabled, true);
    assert.equal((await owner.getById({ id })).userId, 2);
    console.log(JSON.stringify({ case: "owner-reenable-quotas", id, checks: ["owner-toggle-rule-quota", "owner-update-rule-quota", "admin-toggle-rule-quota", "admin-update-rule-quota", "owner-toggle-port-quota", "owner-update-port-quota", "admin-toggle-port-quota", "admin-update-port-quota"], rejectedStatePreserved: true, afterQuotaIncrease: { userId: (await owner.getById({id})).userId, isEnabled: (await owner.getById({id})).isEnabled } }));
  `, "启用配额逐项结果");
});

test("reset all uses the owner scope across pages and ignores selected rule IDs", () => {
  verifyRules(String.raw`
    const first = await admin.create(input({ userId: 2 }));
    const second = await admin.create(input({ userId: 2, sni: "web.example.com" }));
    const self = await admin.create(input({ sni: "admin.example.com" }));
    await runtime.executeRaw('UPDATE "users" SET "trafficUsed"=321 WHERE "id"=2');
    const reset = await admin.resetTraffic({ scope: "all", userId: 2, ruleIds: [Number(first.id)] });
    assert.ok(reset.requestedRuleIds.includes(Number(first.id)));
    assert.ok(reset.requestedRuleIds.includes(Number(second.id)));
    assert.ok(!reset.requestedRuleIds.includes(Number(self.id)));
    const { getUserById } = await import("./server/repositories/userRepository.ts");
    const account = await getUserById(2);
    assert.equal(Number(account.trafficUsed), 321);
    assert.equal(Number(account.balanceCents), 1000);
    await assert.rejects(() => owner.resetTraffic({ scope: "all", userId: 1 }), /无权重置/);
    await assert.rejects(() => owner.resetTraffic({ scope: "all" }), /没有可重置/);
    const all = await admin.resetTraffic({ scope: "all" });
    assert.ok(all.requestedRuleIds.includes(Number(self.id)));
  `);
});

test("direct tunnel SNI remains read-only for owners after access is revoked", () => {
  verifyRules(String.raw`
    await insert("tunnels", ["id","name","entryHostId","exitHostId","mode","listenPort","userId","isEnabled"], [30,"隧道",1,2,"tls",24008,1,1]);
    await insert("user_tunnel_permissions", ["userId","tunnelId"], [2,30]);
    await runtime.executeRaw('UPDATE "users" SET "manualMaxRules"=2,"manualMaxPorts"=1 WHERE "id"=2');
    const create = changes => admin.create(input({ userId: 2, hostId: 1, forwardGroupId: null, tunnelId: 30, forwardType: "gost", ...changes }));
    const first = await create({});
    const second = await create({ sni: "web.example.com" });
    assert.equal((await owner.getById({ id: Number(first.id) })).userId, 2);
    await assert.rejects(() => owner.toggle({ id: Number(first.id), isEnabled: false }), /仅可查看/);
    await admin.toggle({ id: Number(first.id), isEnabled: false });
    await admin.toggle({ id: Number(first.id), isEnabled: true });
    await assert.rejects(() => owner.update({ id: Number(first.id), targetPort: 8443 }), /仅可查看/);
    await runtime.executeRaw('DELETE FROM "user_tunnel_permissions" WHERE "userId"=2');
    await assert.rejects(() => owner.toggle({ id: Number(first.id), isEnabled: false }), /仅可查看/);
    await admin.toggle({ id: Number(first.id), isEnabled: false });
    await assert.rejects(() => owner.toggle({ id: Number(first.id), isEnabled: true }), /仅可查看/);
    const result = await admin.deleteBatch({ ids: [Number(first.id), Number(second.id)] });
    assert.equal(result.failures.length, 0);
  `);
});
