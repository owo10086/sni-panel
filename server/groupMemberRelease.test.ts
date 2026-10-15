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
    const frames = captureAgentFrames([1, 2]);
    const framesBefore = frames();
    assert.ok(framesBefore.every(([, values]) => values.length > 0));
    await runtime.executeRaw(
      'CREATE TRIGGER reject_owner BEFORE UPDATE OF hostId ON forward_rules ' +
      'WHEN OLD.isForwardGroupTemplate=1 AND NEW.hostId=2 ' +
      "BEGIN SELECT RAISE(ABORT,'injected-owner-write-failure'); END"
    );
    await assert.rejects(() => saveMembers(10, [2]), /injected-owner-write-failure/);
    assert.deepEqual(await runtime.queryRaw('SELECT * FROM forward_rules ORDER BY id'), before);
    assert.deepEqual((await links.getForwardGroupById(10)).members.map(m => m.hostId), [1, 2]);
    assert.deepEqual(frames(), framesBefore);
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

for (const sni of [false, true]) {
  test("entry group removal transfers chain roots and retires old listeners, SNI=" + sni, () => {
    runGroupMemberReleaseCase(`
    await seedEntryChain(` + sni + `);
    const before = await rootSnapshot(40);
    const retainedSql = "SELECT id,hostId FROM forward_rules WHERE forwardGroupRuleId=400 AND hostId IN (1,2,5) AND pendingDelete=0 ORDER BY id";
    const retainedBefore = await runtime.queryRaw(retainedSql);
    assert.equal(retainedBefore.length, 3);
    await saveMembers(30, [5]);
    assert.deepEqual(await runtime.queryRaw(retainedSql), retainedBefore);
    assert.deepEqual(await rootSnapshot(40), before);
    await assertGroupReleased(40, 4, 5);
    assert.equal((await hosts.getHostRuleDeleteBlockers(4)).managedRuleCount, 0);
    assert.deepEqual(await runtime.queryRaw(
      'SELECT DISTINCT hostId FROM forward_rules WHERE forwardGroupRuleId=400 ' +
      'AND pendingDelete=0 ORDER BY hostId'
    ), [{ hostId: 1 }, { hostId: 2 }, { hostId: 5 }]);
    assert.deepEqual(await runtime.queryRaw(
      'SELECT hostId FROM forward_rules WHERE id=400'
    ), [{ hostId: 5 }]);
    `);
  });
}

for (const injectFailure of [false, true]) {
  test("entry update handles two chains, injected failure=" + injectFailure, () => {
    runGroupMemberReleaseCase(`
    await seedEntryChain();
    await insert("forward_groups", {
      id: 41, name: "second-chain", groupType: "host", groupMode: "chain",
      entryGroupId: 30, forwardType: "iptables", targetIp: "0.0.0.0",
      userId: 1, isEnabled: 1,
    });
    await insert("forward_group_members", {
      id: 410, groupId: 41, memberType: "host", hostId: 3, priority: 0, isEnabled: 1,
    });
    await insert("forward_rules", {
      id: 4100, hostId: 4, name: "second-root", forwardType: "iptables",
      protocol: "tcp", forwardGroupId: 41, isForwardGroupTemplate: 1,
      sourcePort: 43005, targetIp: "192.0.2.91", targetPort: 8443,
      userId: 1, isEnabled: 1,
    });
    await links.syncForwardGroupRules(41);
    await insert("tunnels", {
      id: 70, name: "affected-tunnel", entryHostId: 6, exitHostId: 3,
      entryGroupId: 30, mode: "tls", listenPort: 25070, userId: 1, isEnabled: 1,
    });
    const before = await runtime.queryRaw('SELECT * FROM forward_rules ORDER BY id');
    const tunnelsBefore = await runtime.queryRaw('SELECT * FROM tunnels ORDER BY id');
    const frames = captureAgentFrames([1, 2, 3, 4, 5, 6]);
    tunnelState.bumpTunnelRuntimeGeneration(70);
    tunnelState.recordTunnelRuntimeHostStatus(70, 4, true);
    const generationBefore = tunnelState.getTunnelRuntimeGeneration(70);
    const framesBefore = frames();
    assert.ok(generationBefore > 0);
    assert.equal(tunnelState.getTunnelRuntimeHostStatus(70, 4), true);
    assert.ok(framesBefore.every(([, values]) => values.length > 0));
    if (` + injectFailure + `) {
      await runtime.executeRaw(
        'CREATE TRIGGER reject_second_chain BEFORE UPDATE OF hostId ON forward_rules ' +
        'WHEN OLD.id=4100 AND NEW.hostId=5 ' +
        "BEGIN SELECT RAISE(ABORT,'injected-second-chain-failure'); END"
      );
      await assert.rejects(() => saveMembers(30, [5], { isEnabled: false }), /injected-second-chain-failure/);
      assert.deepEqual(await runtime.queryRaw('SELECT * FROM forward_rules ORDER BY id'), before);
      assert.deepEqual(await runtime.queryRaw('SELECT * FROM tunnels ORDER BY id'), tunnelsBefore);
      assert.deepEqual((await links.getForwardGroupById(30)).members.map(m => m.hostId), [4, 5]);
      assert.equal(tunnelState.getTunnelRuntimeHostStatus(70, 4), true);
      assert.equal(tunnelState.getTunnelRuntimeGeneration(70), generationBefore);
      assert.deepEqual(frames(), framesBefore, 'rollback must not notify old or retained hosts');
    } else {
      const saved = [await rootSnapshot(40), await rootSnapshot(41)];
      await saveMembers(30, [5]);
      assert.deepEqual([await rootSnapshot(40), await rootSnapshot(41)], saved);
      assert.deepEqual(await runtime.queryRaw(
        'SELECT hostId FROM forward_rules WHERE id IN (400,4100) ORDER BY id'
      ), [{ hostId: 5 }, { hostId: 5 }]);
      await assertGroupReleased(40, 4, 5);
      await assertGroupReleased(41, 4, 5);
      assert.ok(frames().find(([id]) => id === 4)[1].length > framesBefore.find(([id]) => id === 4)[1].length);
      assert.equal((await hosts.getHostRuleDeleteBlockers(4)).managedRuleCount, 0);
    }
    `);
  });
}
test("disabled entry group still releases a removed configured owner", () => {
  runGroupMemberReleaseCase(`
    await seedEntryChain();
    await saveMembers(30, [5], { isEnabled: false });
    await assertGroupReleased(40, 4, 5);
    assert.equal((await hosts.getHostRuleDeleteBlockers(4)).managedRuleCount, 0);
    assert.deepEqual(await runtime.queryRaw(
      'SELECT hostId FROM forward_rules WHERE id=400'
    ), [{ hostId: 5 }]);
  `);
});

test("one post-commit tunnel failure does not prevent other tunnel refreshes", () => {
  runGroupMemberReleaseCase(`
    await seedEntryChain();
    for (const id of [70, 71]) await insert("tunnels", {
      id, name: "affected-" + id, entryHostId: 6, exitHostId: 3,
      entryGroupId: 30, mode: "tls", listenPort: 25000 + id, userId: 1, isEnabled: 1,
    });
    const frames = captureAgentFrames([4, 5, 6]);
    const before = frames();
    await runtime.executeRaw(
      'CREATE TRIGGER reject_tunnel_refresh BEFORE UPDATE ON tunnels WHEN OLD.id=70 ' +
      "BEGIN SELECT RAISE(ABORT,'injected-tunnel-refresh-failure'); END"
    );
    await assert.rejects(() => saveMembers(30, [5]), /配置已保存/);
    await assertGroupReleased(40, 4, 5);
    assert.deepEqual((await links.getForwardGroupById(30)).members.map(m => m.hostId), [5]);
    assert.ok(frames().find(([id]) => id === 6)[1].length > before.find(([id]) => id === 6)[1].length);
    await runtime.executeRaw('DROP TRIGGER reject_tunnel_refresh');
    await links.refreshForwardGroupReferences(30, { previousHostIds: [4, 5], syncDependentChains: false });
    assert.ok(tunnelState.getTunnelRuntimeGeneration(70) > 0);
  `);
});

for (const directCall of [false, true]) {
  test("entry release uses configured disabled hosts, direct=" + directCall, () => {
    runGroupMemberReleaseCase(`
      await seedEntryChain();
      await runtime.executeRaw('UPDATE hosts SET isOnline=0');
      const members = [{ memberType: "host", hostId: 5, priority: 0, isEnabled: false }];
      if (` + directCall + `) await links.replaceForwardGroupMembers(30, members);
      else await saveMembers(30, [5], { members });
      await assertGroupReleased(40, 4, 5);
      assert.equal((await hosts.getHostRuleDeleteBlockers(4)).managedRuleCount, 0);
      assert.deepEqual(await runtime.queryRaw(
        'SELECT hostId FROM forward_rules WHERE id=400'
      ), [{ hostId: 5 }]);
      assert.equal(Boolean((await links.getForwardGroupById(30)).members[0].isEnabled), false);
    `);
  });
}
