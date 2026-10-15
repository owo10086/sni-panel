import assert from "node:assert/strict";
import fs from "node:fs";
const kind = process.env.DATABASE_TYPE;
assert.ok(["mysql", "postgresql"].includes(kind));
assert.ok(process.env.FORWARDX_MEMBER_RELEASE_DB_CONFIG, "dedicated test config path is required");
const config = JSON.parse(fs.readFileSync(process.env.FORWARDX_MEMBER_RELEASE_DB_CONFIG, "utf8"));
assert.equal(config.type, kind);
assert.ok(String(config[kind]?.database || "").endsWith("_member_release_test"), "dedicated test database required");
const runtime = await import("../dbRuntime.ts");
try {
  await runtime.connectDatabase(config);
  const tables = await runtime.queryRaw(kind === "mysql"
    ? "SELECT COUNT(*) AS count FROM information_schema.tables WHERE table_schema=DATABASE()"
    : "SELECT COUNT(*) AS count FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'");
  assert.equal(Number(tables[0].count), 0, "refuse to change a nonempty test database");
  await (await import("../dbSchema.ts")).ensureDatabaseSchema();
  const links = await import("../repositories/forwardGroupRepository.ts");
  const hosts = await import("../repositories/hostRepository.ts");
  const { forwardGroupsRouter } = await import("../routers/forwardGroups.ts");
  const { hostsRouter } = await import("../routers/hosts.ts");
  const { quoteIdentifier: q, boolValue } = await import("../dbCompat.ts");
  const userId = await runtime.insertAndGetId("users", {
    username: "release-admin", password: "test", role: "admin", canAddRules: true, manualCanAddRules: true,
  });
  const ids = [];
  for (const suffix of [1, 2]) ids.push(await runtime.insertAndGetId("hosts", {
    name: "test-" + suffix, ip: "192.0.2." + suffix, ipv4: "192.0.2." + suffix,
    userId, isOnline: false,
  }));
  const [oldHost, newHost] = ids;
  const groupId = await links.createForwardGroup({
    name: "dialect-release", groupType: "host", groupMode: "failover",
    targetIp: "0.0.0.0", userId, isEnabled: true,
  }, ids.map((hostId, priority) => ({ memberType: "host", hostId, priority, isEnabled: true })));
  const ruleId = await runtime.insertAndGetId("forward_rules", {
    name: "retained-root", hostId: oldHost, userId, forwardGroupId: groupId,
    isForwardGroupTemplate: true, isEnabled: true, forwardType: "iptables", protocol: "tcp",
    sourcePort: 20000, targetIp: "192.0.2.90", targetPort: 80,
  });
  await links.syncForwardGroupRules(groupId);
  const context = { req: { headers: {} }, res: { clearCookie() {} },
    user: { id: userId, username: "release-admin", role: "admin", accountEnabled: true },
    authSession: null, authFailureReason: null };
  await forwardGroupsRouter.createCaller(context).updateFields({ id: groupId, members: [
    { memberType: "host", hostId: newHost, priority: 0, isEnabled: true },
  ] });
  const readOwner = () => runtime.queryRaw(
    "SELECT " + q("hostId") + " FROM " + q("forward_rules") + " WHERE " + q("id") + "=?", [ruleId]);
  assert.equal(Number((await readOwner())[0].hostId), newHost);
  assert.deepEqual(await hosts.getHostLinkDeleteBlockers(oldHost), { groupCount: 0, tunnelCount: 0 });
  await runtime.executeRaw("UPDATE " + q("forward_rules") + " SET " + q("hostId") + "=? WHERE " + q("id") + "=?", [oldHost, ruleId]);
  assert.equal((await hosts.getHostRuleDeleteBlockers(oldHost)).managedRuleCount, 0);
  assert.equal(Number((await readOwner())[0].hostId), newHost);
  await hostsRouter.createCaller(context).delete({ id: oldHost });
  assert.equal(Number((await readOwner())[0].hostId), newHost);
  const live = await runtime.queryRaw("SELECT COUNT(*) AS count FROM " + q("forward_rules") +
    " WHERE " + q("hostId") + "=? AND " + q("pendingDelete") + "=?", [oldHost, boolValue(false)]);
  assert.equal(Number(live[0].count), 0);
  console.log("member-release dialect checks passed: " + kind);
} finally { await runtime.closeDatabase(); }
