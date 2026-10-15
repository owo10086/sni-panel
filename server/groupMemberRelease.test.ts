import test from "node:test";
import { runGroupMemberReleaseCase } from "./test-support/groupMemberReleaseHarness";

for (const count of [1, 44]) {
  test("failover member removal releases old host with " + count + " roots", () => {
    runGroupMemberReleaseCase(`
      await seedFailover(` + count + `);
      const before = await rootSnapshot(10);
      const keptSql = 'SELECT id,forwardGroupRuleId FROM forward_rules WHERE forwardGroupId=10 ' +
        'AND hostId=2 AND isForwardGroupTemplate=0 AND pendingDelete=0 ORDER BY id';
      const keptBefore = await runtime.queryRaw(keptSql);
      assert.equal(keptBefore.length, ` + count + `);
      await saveMembers(10, [2]);
      await assertGroupReleased(10, 1, 2);
      assert.deepEqual(await rootSnapshot(10), before);
      assert.deepEqual(await runtime.queryRaw(keptSql), keptBefore);
      const retired = await runtime.queryRaw(
        'SELECT pendingDelete,isEnabled FROM forward_rules WHERE forwardGroupId=10 ' +
        'AND hostId=1 AND isForwardGroupTemplate=0'
      );
      assert.equal(retired.length, ` + count + `);
      assert.ok(retired.every(rule => Number(rule.pendingDelete) === 1 && Number(rule.isEnabled) === 0));
      assert.equal((await hosts.getHostRuleDeleteBlockers(1)).managedRuleCount, 0);
      const rootHosts = await runtime.queryRaw(
        'SELECT DISTINCT hostId FROM forward_rules ' +
        'WHERE forwardGroupId=10 AND isForwardGroupTemplate=1'
      );
      assert.deepEqual(rootHosts, [{ hostId: 2 }]);
      assert.notEqual(Number((await links.getForwardGroupById(10)).activeMemberId), 101);
      assert.equal(Number((await runtime.queryRaw(
        'SELECT COUNT(*) AS count FROM forward_rules WHERE hostId=1 ' +
        'AND isForwardGroupTemplate=0 AND pendingDelete=0'
      ))[0].count), 0);
    `);
  });
}

test("SNI roots retain ids, targets and saved usage after removing a host", () => {
  runGroupMemberReleaseCase(`
    await seedFailover(3, true);
    const before = await rootSnapshot(10);
    await saveMembers(10, [2]);
    assert.deepEqual(await rootSnapshot(10), before);
    await assertGroupReleased(10, 1, 2);
    assert.equal((await hosts.getHostRuleDeleteBlockers(1)).managedRuleCount, 0);
  `);
});
test("offline and disabled groups do not retain removed template owners", () => {
  runGroupMemberReleaseCase(`
    await seedFailover(1, false, false);
    await runtime.executeRaw('UPDATE hosts SET isOnline=0');
    await saveMembers(10, [2]);
    await assertGroupReleased(10, 1, 2);
    assert.equal((await hosts.getHostRuleDeleteBlockers(1)).managedRuleCount, 0);
  `);
});
test("a template-owner write failure restores members and children", () => {
  runGroupMemberReleaseCase(`
    await seedFailover();
    const before = await runtime.queryRaw('SELECT * FROM forward_rules ORDER BY id');
    await runtime.executeRaw(
      'CREATE TRIGGER reject_owner BEFORE UPDATE OF hostId ON forward_rules ' +
      'WHEN OLD.isForwardGroupTemplate=1 AND NEW.hostId=2 ' +
      "BEGIN SELECT RAISE(ABORT,'injected-owner-write-failure'); END"
    );
    await assert.rejects(() => saveMembers(10, [2]), /injected-owner-write-failure/);
    assert.deepEqual(await runtime.queryRaw('SELECT * FROM forward_rules ORDER BY id'), before);
    assert.deepEqual((await links.getForwardGroupById(10)).members.map(m => m.hostId), [1, 2]);
  `);
});
for (const mode of ["port", "chain"]) {
  test("ordinary member changes release the saved owner in mode=" + mode, () => {
    runGroupMemberReleaseCase(`
      await seedFailover();
      await runtime.executeRaw('UPDATE forward_groups SET groupMode=? WHERE id=10', ["` + mode + `"]);
      if ("` + mode + `" === "port") {
        await runtime.executeRaw('DELETE FROM forward_group_members WHERE hostId=2');
        await saveMembers(10, [2]);
      } else {
        await saveMembers(10, [2, 3], { isEnabled: false });
      }
      await assertGroupReleased(10, 1, 2);
      assert.equal((await hosts.getHostRuleDeleteBlockers(1)).managedRuleCount, 0);
      assert.deepEqual(await runtime.queryRaw(
        'SELECT hostId FROM forward_rules WHERE id=1000'
      ), [{ hostId: 2 }]);
    `);
  });
}


test("direct member replacement releases owners and skipSync requires the outer guard", () => {
  runGroupMemberReleaseCase(`
    await seedFailover();
    const members = [{ memberType: "host", hostId: 2, priority: 0, isEnabled: true }];
    await assert.rejects(() => links.replaceForwardGroupMembers(10, members, { skipSync: true }), /成员保存必须/);
    await links.replaceForwardGroupMembers(10, members);
    await assertGroupReleased(10, 1, 2);
  `);
});

test("committed cleanup failures preserve saved members and attempt every remaining stage", () => {
  runGroupMemberReleaseCase(`
    await seedFailover();
    const seen = [];
    await assert.rejects(() => withGroupMemberMutation(() => links.commitForwardGroupMemberChange([10], async () => {
      await links.replaceForwardGroupMembers(10, [{ memberType: "host", hostId: 2, priority: 0, isEnabled: true }], { skipSync: true });
      await runtime.afterDatabaseCommit(() => { seen.push("cleanup-first"); throw new Error("cleanup failure"); });
      await runtime.afterDatabaseCommit(() => { seen.push("cleanup-second"); });
    }, {}, [
      async () => { seen.push("health"); throw new Error("health failure"); },
      async () => { seen.push("rate-limit"); },
    ])), error => {
      assert.match(error.message, /配置已保存/);
      assert.equal(error.errors.length, 2);
      assert.match(error.errors[0].errors[0].message, /cleanup failure/);
      assert.match(error.errors[1].message, /health failure/);
      return true;
    });
    assert.deepEqual(seen, ["cleanup-first", "cleanup-second", "health", "rate-limit"]);
    await assertGroupReleased(10, 1, 2);
  `);
});
