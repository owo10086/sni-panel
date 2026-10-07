import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function verifyRules(body: string) {
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
    await assert.rejects(() => owner.update({ id: rule.id, name: "不能改名" }), /仅管理员/);
    await assert.rejects(() => other.toggle({ id: rule.id, isEnabled: false }), /无权操作/);
    const self = await admin.create(input({ sni: "self.example.com" }));
    assert.equal((await admin.getById({ id: Number(self.id) })).userId, 1);
  `);
});

test("SNI owners can resume existing rules at full quota and create another domain on their existing port", () => {
  verifyRules(String.raw`
    await runtime.executeRaw('UPDATE "users" SET "maxRules"=2,"maxPorts"=1,"manualMaxRules"=2,"manualMaxPorts"=1 WHERE "id"=2');
    const first = await admin.create(input({ userId: 2 }));
    const second = await admin.create(input({ userId: 2, sni: "web.example.com" }));
    await owner.toggle({ id: Number(first.id), isEnabled: false });
    await owner.toggle({ id: Number(first.id), isEnabled: true });
    assert.equal((await owner.getById({ id: Number(first.id) })).isEnabled, true);
    await assert.rejects(() => admin.create(input({ userId: 2, sni: "third.example.com" })), /最大规则数量/);
    await runtime.executeRaw('UPDATE "users" SET "maxRules"=3,"manualMaxRules"=3 WHERE "id"=2');
    await assert.rejects(() => admin.create(input({ userId: 2, sourcePort: 18444, sni: "newport.example.com" })), /最大端口数量/);
    await runtime.executeRaw('DELETE FROM "user_forward_group_permissions" WHERE "userId"=2');
    await owner.toggle({ id: Number(first.id), isEnabled: false });
    await assert.rejects(() => owner.toggle({ id: Number(first.id), isEnabled: true }), /无权使用该转发组/);
    const result = await owner.deleteBatch({ ids: [Number(first.id), Number(second.id)] });
    assert.deepEqual(result.deletedIds.sort((a,b)=>a-b), [Number(first.id), Number(second.id)].sort((a,b)=>a-b));
  `);
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
    const own = await owner.resetTraffic({ scope: "all" });
    assert.ok(!own.requestedRuleIds.includes(Number(self.id)));
    const all = await admin.resetTraffic({ scope: "all" });
    assert.ok(all.requestedRuleIds.includes(Number(self.id)));
  `);
});

test("direct tunnel SNI uses the selected owner and permits stopping and deleting after access is revoked", () => {
  verifyRules(String.raw`
    await insert("tunnels", ["id","name","entryHostId","exitHostId","mode","listenPort","userId","isEnabled"], [30,"隧道",1,2,"tls",24008,1,1]);
    await insert("user_tunnel_permissions", ["userId","tunnelId"], [2,30]);
    await runtime.executeRaw('UPDATE "users" SET "manualMaxRules"=2,"manualMaxPorts"=1 WHERE "id"=2');
    const create = changes => admin.create(input({ userId: 2, hostId: 1, forwardGroupId: null, tunnelId: 30, forwardType: "gost", ...changes }));
    const first = await create({});
    const second = await create({ sni: "web.example.com" });
    assert.equal((await owner.getById({ id: Number(first.id) })).userId, 2);
    await owner.toggle({ id: Number(first.id), isEnabled: false });
    await owner.toggle({ id: Number(first.id), isEnabled: true });
    await assert.rejects(() => owner.update({ id: Number(first.id), targetPort: 8443 }), /仅管理员/);
    await runtime.executeRaw('DELETE FROM "user_tunnel_permissions" WHERE "userId"=2');
    await owner.toggle({ id: Number(first.id), isEnabled: false });
    await assert.rejects(() => owner.toggle({ id: Number(first.id), isEnabled: true }), /无权使用|授权/);
    const result = await owner.deleteBatch({ ids: [Number(first.id), Number(second.id)] });
    assert.equal(result.failures.length, 0);
  `);
});
