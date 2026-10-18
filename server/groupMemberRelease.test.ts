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

test("historic failover references are repaired before real host deletion", () => {
  runGroupMemberReleaseCase(`
    await seedFailover(44);
    const before = await rootSnapshot(10);
    await runtime.executeRaw('DELETE FROM forward_group_members WHERE hostId=1');
    await assert.rejects(() => hostCaller.delete({ id: 1 }), /清理/);
    await runtime.executeRaw('UPDATE forward_rules SET isRunning=0 WHERE hostId=1 AND pendingDelete=1');
    await hostCaller.delete({ id: 1 });
    assert.deepEqual(await rootSnapshot(10), before);
    assert.equal((await runtime.queryRaw('SELECT id FROM hosts WHERE id=1')).length, 0);
    assert.deepEqual(await runtime.queryRaw(
      'SELECT DISTINCT hostId FROM forward_rules WHERE forwardGroupId=10 ' +
      'AND isForwardGroupTemplate=1'
    ), [{ hostId: 2 }]);
  `);
});
test("removing an entry-group membership does not remove a standalone tunnel entry", () => {
  runGroupMemberReleaseCase(`
    await seedEntryChain();
    await insert("tunnels", {
      id: 70, name: "independent-entry", entryHostId: 4, exitHostId: 6,
      entryGroupId: 30, mode: "tls", listenPort: 25000,
      userId: 1, isEnabled: 1,
    });
    await saveMembers(30, [5]);
    await assertGroupReleased(40, 4, 5);
    assert.equal((await hosts.getHostRuleDeleteBlockers(4)).managedRuleCount, 0);
    await assert.rejects(() => hostCaller.delete({ id: 4 }), /隧道|引用|使用/);
    assert.equal((await runtime.queryRaw('SELECT entryHostId FROM tunnels WHERE id=70'))[0].entryHostId, 4);
    assert.equal((await runtime.queryRaw('SELECT id FROM hosts WHERE id=4')).length, 1);
  `);
});

for (const usage of ["group", "entry", "exit", "hop", "extra-exit", "rule-exit"]) {
  for (const token of [false, true]) {
    test("saved relationship blocks deletion: " + usage + ", token=" + token, () => {
      runGroupMemberReleaseCase(`
        const usage = "` + usage + `";
        if (usage === "group") {
          await insert("forward_groups", {
            id: 20, name: "other-group", groupType: "host", groupMode: "failover",
            targetIp: "0.0.0.0", userId: 1, isEnabled: 0,
          });
          await insert("forward_group_members", {
            id: 201, groupId: 20, memberType: "host", hostId: 1, priority: 0, isEnabled: 0,
          });
        } else {
          await insert("tunnels", {
            id: 70, name: "other-tunnel", entryHostId: usage === "entry" ? 1 : 2,
            exitHostId: usage === "exit" ? 1 : 3, listenPort: 25070,
            mode: "tls", userId: 1, isEnabled: 0,
          });
          if (usage === "hop" || usage === "extra-exit") await insert(
            usage === "hop" ? "tunnel_hops" : "tunnel_exit_nodes",
            { tunnelId: 70, seq: 0, hostId: 1, listenPort: 25071 },
          );
          if (usage === "rule-exit") {
            await insert("forward_rules", {
              id: 9000, name: "selected-exit", hostId: 2, userId: 1, tunnelId: 70,
              sourcePort: 29000, targetIp: "192.0.2.90", targetPort: 80,
              protocol: "tcp", forwardType: "gost", isEnabled: 1,
            });
            await insert("forward_rule_tunnel_exits", {
              ruleId: 9000, tunnelId: 70, exitNodeId: 701, exitSeq: 0,
              exitHostId: 1, tunnelExitPort: 25071,
            });
          }
        }
        await insert("agent_tokens", { id: 50, token: "reference-token", hostId: 1, userId: 1 });
        const remove = ` + token + `
          ? () => tokenCaller.delete({ id: 50 }) : () => hostCaller.delete({ id: 1 });
        await assert.rejects(remove, /组|隧道|引用|使用/);
        assert.equal((await runtime.queryRaw('SELECT id FROM hosts WHERE id=1')).length, 1);
        assert.equal((await runtime.queryRaw('SELECT id FROM agent_tokens WHERE id=50')).length, 1);
      `);
    });
  }
}
test("historic entry ownership repairs before deletion and removed extra entries are released", () => {
  runGroupMemberReleaseCase(`
    await seedEntryChain();
    await insert("tunnels", {
      id: 70, name: "extra-entries", entryHostId: 6, exitHostId: 3,
      entryGroupId: 30, mode: "tls", listenPort: 25070, userId: 1, isEnabled: 1,
    });
    await saveMembers(30, [5]);
    // Recreate the old released-members/stale-root state produced by the faulty version.
    await runtime.executeRaw('UPDATE forward_rules SET hostId=4 WHERE id=400');
    const before = await rootSnapshot(40);
    await assert.rejects(() => hostCaller.delete({ id: 4 }), /清理/);
    await runtime.executeRaw("UPDATE forward_rules SET isRunning=0 WHERE hostId=4 AND pendingDelete=1");
    await hostCaller.delete({ id: 4 });
    assert.deepEqual(await rootSnapshot(40), before);
    assert.deepEqual(await runtime.queryRaw('SELECT hostId FROM forward_rules WHERE id=400'), [{ hostId: 5 }]);
    assert.equal((await runtime.queryRaw('SELECT entryHostId FROM tunnels WHERE id=70'))[0].entryHostId, 6);
    assert.equal((await runtime.queryRaw('SELECT id FROM hosts WHERE id=4')).length, 0);
  `);
});
test("concurrent member saves leave roots on the final saved member", () => {
  runGroupMemberReleaseCase(`
    await seedFailover();
    await Promise.all([saveMembers(10, [2]), saveMembers(10, [3])]);
    const members = (await links.getForwardGroupById(10)).members;
    assert.equal(members.length, 1);
    const owner = (await runtime.queryRaw('SELECT hostId FROM forward_rules WHERE id=1000'))[0].hostId;
    assert.equal(owner, members[0].hostId);
    await assertGroupReleased(10, 1, members[0].hostId);
    assert.equal((await hosts.getHostRuleDeleteBlockers(1)).managedRuleCount, 0);
  `);
});
test("rejoining a removed member keeps its current child active", () => {
  runGroupMemberReleaseCase(`
    await seedFailover();
    await saveMembers(10, [2]);
    await saveMembers(10, [1, 2]);
    await links.syncForwardGroupRules(10);
    const current = await runtime.queryRaw(
      'SELECT id,isEnabled FROM forward_rules WHERE hostId=1 ' +
      'AND isForwardGroupTemplate=0 AND pendingDelete=0'
    );
    assert.equal(current.length, 1);
    assert.equal(Boolean(current[0].isEnabled), true);
    assert.equal((await hosts.getHostRuleDeleteBlockers(1)).managedRuleCount, 1);
  `);
});

test("a host with another ordinary rule remains protected", () => {
  runGroupMemberReleaseCase(`
    await seedFailover();
    await saveMembers(10, [2]);
    await insert("forward_rules", {
      id: 9000, hostId: 1, userId: 1, name: "independent-rule",
      sourcePort: 29000, targetIp: "192.0.2.90", targetPort: 80,
      forwardType: "iptables", protocol: "tcp", isEnabled: 1,
    });
    await assert.rejects(() => hostCaller.delete({ id: 1 }), /转发规则/);
    assert.equal((await runtime.queryRaw('SELECT id FROM forward_rules WHERE id=9000')).length, 1);
  `);
});
test("repeat history repair does not rewrite saved root ownership", () => {
  runGroupMemberReleaseCase(`
    await seedFailover();
    await runtime.executeRaw('DELETE FROM forward_group_members WHERE hostId=1');
    await hosts.getHostRuleDeleteBlockers(1);
    const group = await links.getForwardGroupById(10);
    assert.ok(!group.activeMemberId || group.members.some(member => member.id === group.activeMemberId));
    const before = await runtime.queryRaw(
      'SELECT hostId,updatedAt FROM forward_rules WHERE isForwardGroupTemplate=1'
    );
    await hosts.getHostRuleDeleteBlockers(1);
    assert.deepEqual(await runtime.queryRaw(
      'SELECT hostId,updatedAt FROM forward_rules WHERE isForwardGroupTemplate=1'
    ), before);
  `);
});
test("deleting an obsolete token preserves moved group roots", () => {
  runGroupMemberReleaseCase(`
    await seedFailover();
    await insert("agent_tokens", {
      id: 50, token: "diagnosis-token", hostId: 1, userId: 1,
    });
    await runtime.executeRaw(
      "UPDATE hosts SET agentToken='diagnosis-token' WHERE id=1"
    );
    await saveMembers(10, [2]);
    const before = await rootSnapshot(10);
    await tokenCaller.delete({ id: 50 });
    assert.deepEqual(await rootSnapshot(10), before);
    assert.equal((await runtime.queryRaw('SELECT id FROM agent_tokens WHERE id=50')).length, 0);
  `);
});

test("tunnel-member removal releases the group but preserves the standalone tunnel", () => {
  runGroupMemberReleaseCase(`
    for (const id of [71, 72]) await insert("tunnels", {
      id, name: "tunnel-" + id, entryHostId: id - 70, exitHostId: 3,
      mode: "tls", listenPort: 25000 + id, userId: 1, isEnabled: 1,
    });
    await insert("forward_groups", {
      id: 10, name: "tunnel-members", groupType: "tunnel", groupMode: "failover",
      forwardType: "gost", targetIp: "0.0.0.0", userId: 1, isEnabled: 1,
    });
    for (const id of [71, 72]) await insert("forward_group_members", {
      id: 100 + id, groupId: 10, memberType: "tunnel",
      tunnelId: id, priority: id - 71, isEnabled: 1,
    });
    await insert("forward_rules", {
      id: 1000, hostId: 1, name: "root", userId: 1, forwardGroupId: 10,
      isForwardGroupTemplate: 1, isEnabled: 1, sourcePort: 20000,
      forwardType: "gost", protocol: "tcp", targetIp: "192.0.2.90", targetPort: 80,
    });
    await groups.update({
      id: 10, name: "tunnel-members", groupMode: "failover", groupType: "tunnel",
      forwardType: "gost", protocol: "tcp", failoverSeconds: 17, recoverSeconds: 23,
      autoFailback: true, isEnabled: true, domain: null, recordType: "A",
      members: [{ memberType: "tunnel", tunnelId: 72, priority: 0, isEnabled: true }],
    });
    await assertGroupReleased(10, 1, 2);
    assert.equal((await hosts.getHostRuleDeleteBlockers(1)).managedRuleCount, 0);
    await assert.rejects(() => hostCaller.delete({ id: 1 }), /隧道|引用|使用/);
    assert.equal((await runtime.queryRaw('SELECT hostId FROM forward_rules WHERE id=1000'))[0].hostId, 2);
  `);
});

test("save assertions detect a stale owner before historic repair runs", () => {
  runGroupMemberReleaseCase(`
    await seedFailover();
    await saveMembers(10, [2]);
    await assertGroupReleased(10, 1, 2);
    await runtime.executeRaw('UPDATE forward_rules SET hostId=1 WHERE id=1000');
    await assert.rejects(() => assertGroupReleased(10, 1, 2));
    await hosts.getHostRuleDeleteBlockers(1);
    await assertGroupReleased(10, 1, 2);
  `);
});
for (const order of ["join-first", "delete-first"]) {
  test("member joining and host deletion use a controlled order: " + order, () => {
    runGroupMemberReleaseCase(`
      await seedFailover();
      await saveMembers(10, [2]);
      await assertGroupReleased(10, 1, 2);
      assert.equal((await hosts.getHostRuleDeleteBlockers(1)).managedRuleCount, 0);
      let unlock, started;
      const ready = new Promise(resolve => { started = resolve; });
      const gate = new Promise(resolve => { unlock = resolve; });
      const holding = withGroupMemberMutation(async () => { started(); await gate; });
      await ready;
      const join = () => saveMembers(10, [1, 2]);
      // The ordering check starts after the old listener has acknowledged stopping.
      await runtime.executeRaw("UPDATE forward_rules SET isRunning=0 WHERE hostId=1 AND pendingDelete=1");
      const remove = () => hostCaller.delete({ id: 1 });
      const first = ("` + order + `" === "join-first" ? join() : remove())
        .then(value => ({ value }), error => ({ error }));
      await waitForMutationQueue(2);
      const second = ("` + order + `" === "join-first" ? remove() : join())
        .then(value => ({ value }), error => ({ error }));
      await waitForMutationQueue(3);
      unlock(); await holding;
      const results = await Promise.all([first, second]);
      assert.ok(!results[0].error);
      assert.ok(results[1].error);
      if ("` + order + `" === "join-first") {
        assert.equal((await runtime.queryRaw('SELECT id FROM hosts WHERE id=1')).length, 1);
        assert.deepEqual((await links.getForwardGroupById(10)).members.map(m => m.hostId), [1, 2]);
      } else {
        assert.equal((await runtime.queryRaw('SELECT id FROM hosts WHERE id=1')).length, 0);
        assert.deepEqual((await links.getForwardGroupById(10)).members.map(m => m.hostId), [2]);
      }
      assert.equal((await rootSnapshot(10)).length, 1);
    `);
  });
}
test("a final delete failure restores permissions, bindings and pending cleanup", () => {
  runGroupMemberReleaseCase(`
    await seedFailover(); await saveMembers(10, [2]);
    await insert("agent_tokens", { id: 50, token: "rollback-token", hostId: 1, userId: 1 });
    await runtime.executeRaw("UPDATE hosts SET agentToken='rollback-token' WHERE id=1");
    await insert("user_host_permissions", { userId: 1, hostId: 1 });
    await runtime.executeRaw("UPDATE hosts SET isOnline=0 WHERE id=1");
    const before = await deleteSnapshot();
    await runtime.executeRaw(
      'CREATE TRIGGER reject_host_delete BEFORE DELETE ON hosts WHEN OLD.id=1 ' +
      "BEGIN SELECT RAISE(ABORT,'injected-final-delete-failure'); END"
    );
    await assert.rejects(() => hostCaller.delete({ id: 1, confirmOfflineCleanup: true }), /injected-final-delete-failure/);
    assert.deepEqual(await deleteSnapshot(), before);
    await assert.rejects(() => tokenCaller.delete({ id: 50 }), /injected-final-delete-failure/);
    assert.deepEqual(await deleteSnapshot(), before);
  `);
});
for (const source of ["hostId", "agentToken", "mixed"]) {
  test("token deletion checks every affected host: " + source, () => {
    runGroupMemberReleaseCase(`
      const source = "` + source + `";
      await insert("agent_tokens", {
        id: 50, token: "multi-token", hostId: source === "agentToken" ? null : 1, userId: 1,
      });
      if (source !== "hostId") await runtime.executeRaw(
        "UPDATE hosts SET agentToken='multi-token' WHERE id IN (2,3)"
      );
      const protectedHost = source === "hostId" ? 1 : 3;
      await insert("forward_rules", {
        id: 9000, name: "protected", hostId: protectedHost, userId: 1,
        sourcePort: 29000, targetIp: "192.0.2.90", targetPort: 80,
        protocol: "tcp", forwardType: "iptables", isEnabled: 1,
      });
      const before = await deleteSnapshot();
      await assert.rejects(() => tokenCaller.delete({ id: 50 }), /转发规则/);
      assert.deepEqual(await deleteSnapshot(), before);
    `);
  });
}
test("unauthorized deletions do not trigger historical repair", () => {
  runGroupMemberReleaseCase(`
    await seedFailover();
    await runtime.executeRaw('DELETE FROM forward_group_members WHERE hostId=1');
    await insert("users", { id: 2, username: "customer", password: "test", role: "user" });
    await insert("agent_tokens", { id: 50, token: "admin-only", hostId: 1, userId: 1 });
    const customer = { ...context, user: { id: 2, username: "customer", role: "user", accountEnabled: true } };
    const before = await deleteSnapshot();
    await assert.rejects(() => hostsRouter.createCaller(customer).delete({ id: 1 }), /无权/);
    await assert.rejects(() => agentTokensRouter.createCaller(customer).delete({ id: 50 }), /无权/);
    assert.deepEqual(await deleteSnapshot(), before);
  `);
});
test("owning a token does not allow changing another user's host", () => {
  runGroupMemberReleaseCase(`
    await insert("users", { id: 2, username: "customer", password: "test", role: "user" });
    await insert("agent_tokens", { id: 50, token: "customer-token", hostId: 1, userId: 2 });
    await runtime.executeRaw("UPDATE hosts SET agentToken='customer-token' WHERE id=1");
    const customer = { ...context, user: { id: 2, username: "customer", role: "user", accountEnabled: true } };
    const before = await deleteSnapshot();
    await assert.rejects(() => agentTokensRouter.createCaller(customer).delete({ id: 50 }), /无权/);
    assert.deepEqual(await deleteSnapshot(), before);
  `);
});
test("deleting a host preserves a token still used by another host", () => {
  runGroupMemberReleaseCase(`
    await insert("agent_tokens", { id: 50, token: "shared-legacy-token", hostId: 1, userId: 1 });
    await runtime.executeRaw("UPDATE hosts SET agentToken='shared-legacy-token' WHERE id=2");
    await insert("forward_rules", {
      id: 9000, hostId: 2, userId: 1, name: "other-host-rule", sourcePort: 29000,
      targetIp: "192.0.2.90", targetPort: 80, forwardType: "iptables", protocol: "tcp",
    });
    await hostCaller.delete({ id: 1 });
    assert.deepEqual(await runtime.queryRaw('SELECT hostId FROM agent_tokens WHERE id=50'), [{ hostId: null }]);
    assert.deepEqual(await runtime.queryRaw('SELECT agentToken FROM hosts WHERE id=2'), [{ agentToken: "shared-legacy-token" }]);
    assert.equal((await runtime.queryRaw('SELECT id FROM forward_rules WHERE id=9000')).length, 1);
  `);
});
test("moving root ownership retains its billing records and account balance", () => {
  runGroupMemberReleaseCase(`
    await seedFailover();
    await runtime.executeRaw('UPDATE users SET balanceCents=50000 WHERE id=1');
    await insert("traffic_billing_configs", {
      id: 90, resourceType: "forward_group", resourceId: 10, enabled: 1,
      pricePerGbCents: 100, multiplier: 100,
    });
    await insert("traffic_billing_rule_usage", {
      id: 91, userId: 1, ruleId: 1000, resourceType: "forward_group", resourceId: 10,
      totalBytes: 123456, billedGb: 0, pendingMilliCents: 1234, settled: 0,
    });
    await insert("traffic_billing_records", {
      id: 92, userId: 1, ruleId: 1000, resourceType: "forward_group", resourceId: 10,
      bytes: 1000000, amountCents: 100, balanceAfterCents: 50000,
    });
    const snapshot = async () => ({
      usage: await runtime.queryRaw('SELECT * FROM traffic_billing_rule_usage WHERE ruleId=1000'),
      records: await runtime.queryRaw('SELECT * FROM traffic_billing_records WHERE ruleId=1000'),
      config: await runtime.queryRaw('SELECT * FROM traffic_billing_configs WHERE id=90'),
      balance: await runtime.queryRaw('SELECT balanceCents FROM users WHERE id=1'),
    });
    const before = await snapshot();
    await saveMembers(10, [2]); await assertGroupReleased(10, 1, 2);
    assert.deepEqual(await snapshot(), before);
    await links.syncForwardGroupRules(10);
    assert.deepEqual(await snapshot(), before);
  `);
});

test("direct replacement and API saving read the final member configuration", () => {
  runGroupMemberReleaseCase(`
    await seedEntryChain();
    const frames = captureAgentFrames([4, 5, 6]); const before = frames();
    await runInMutationOrder(
      () => links.replaceForwardGroupMembers(30, [{ memberType: "host", hostId: 5, priority: 0, isEnabled: true }]),
      () => saveMembers(30, [6]),
    );
    await assertGroupReleased(40, 4, 6);
    await assertGroupReleased(40, 5, 6);
    assert.deepEqual((await links.getForwardGroupById(30)).members.map(m => m.hostId), [6]);
    for (const oldHost of [4, 5]) assert.ok(
      frames().find(([id]) => id === oldHost)[1].length > before.find(([id]) => id === oldHost)[1].length
    );
  `);
});
test("a partial name edit cannot restore an obsolete member list", () => {
  runGroupMemberReleaseCase(`
    await seedEntryChain();
    await runInMutationOrder(
      () => links.replaceForwardGroupMembers(30, [{ memberType: "host", hostId: 5, priority: 0, isEnabled: true }]),
      () => groups.updateFields({ id: 30, name: "renamed-entry" }),
    );
    await assertGroupReleased(40, 4, 5);
    const saved = await links.getForwardGroupById(30);
    assert.equal(saved.name, "renamed-entry");
    assert.deepEqual(saved.members.map(m => m.hostId), [5]);
  `);
});
for (const createFirst of [false, true]) {
  test("new dependent chains and entry saving agree, create first=" + createFirst, () => {
    runGroupMemberReleaseCase(`
      await seedEntryChain();
      let createdId;
      const create = () => withGroupMemberMutation(async () => {
        const result = await groups.create({
          name: "new-chain", groupMode: "chain", groupType: "host", entryGroupId: 30,
          protocol: "tcp", forwardType: "iptables", failoverSeconds: 17,
          recoverSeconds: 23, autoFailback: true, isEnabled: true,
          members: [{ memberType: "host", hostId: 3, priority: 0, isEnabled: true }],
        });
        createdId = result.id;
        const owner = (await links.getForwardGroupById(30)).members[0].hostId;
        await insert("forward_rules", {
          id: 4100, name: "new-root", hostId: owner, userId: 1,
          forwardGroupId: createdId, isForwardGroupTemplate: 1, isEnabled: 1,
          sourcePort: 43005, targetIp: "192.0.2.90", targetPort: 80,
          protocol: "tcp", forwardType: "iptables",
        });
        await links.syncForwardGroupRules(createdId);
      });
      const save = () => saveMembers(30, [5]);
      await runInMutationOrder(...(` + createFirst + ` ? [create, save] : [save, create]));
      await assertGroupReleased(40, 4, 5);
      await assertGroupReleased(createdId, 4, 5);
    `);
  });
}
for (const usage of ["orphan-group", "orphan-hop", "orphan-exit", "plan", "other-token"]) {
  test("automatic cleanup shares real references and retains extra protections: " + usage, () => {
    runGroupMemberReleaseCase(`
      const usage = "` + usage + `";
      if (usage === "orphan-group") await insert("forward_group_members", {
        groupId: 999, memberType: "host", hostId: 1, priority: 0,
      });
      if (usage === "orphan-hop" || usage === "orphan-exit") await insert(
        usage === "orphan-hop" ? "tunnel_hops" : "tunnel_exit_nodes",
        { tunnelId: 999, seq: 0, hostId: 1, listenPort: 25071 },
      );
      if (usage === "plan") {
        await insert("subscription_plans", { id: 80, name: "protected-plan", durationDays: 30 });
        await insert("subscription_plan_hosts", { planId: 80, hostId: 1 });
      }
      if (usage === "other-token") await insert("agent_tokens", {
        id: 51, token: "retained-token", hostId: 1, userId: 1,
      });
      const before = await deleteSnapshot();
      const protectedUse = usage === "plan" || usage === "other-token";
      assert.equal(await hosts.deleteHostIfUnreferenced(1), !protectedUse);
      if (protectedUse) assert.deepEqual(await deleteSnapshot(), before);
      else assert.equal((await runtime.queryRaw('SELECT id FROM hosts WHERE id=1')).length, 0);
    `);
  });
}

for (const usage of ["ordinary-rule", "rule-exit"]) {
  test("actual guarded DELETE refuses a reference added after the final read: " + usage, () => {
    runGroupMemberReleaseCase(`
      await insert("forward_rules", {
        id: 9001, hostId: 1, userId: 1, name: "pending", sourcePort: 29001,
        targetIp: "192.0.2.90", targetPort: 80, pendingDelete: 1, isRunning: 1,
      });
      await insert("agent_tokens", { id: 50, token: "late-reference", hostId: 1, userId: 1 });
      await runtime.executeRaw("UPDATE hosts SET agentToken='late-reference' WHERE id=1");
      await insert("user_host_permissions", { userId: 1, hostId: 1 });
      await insert("tunnels", {
        id: 70, name: "independent", entryHostId: 2, exitHostId: 3,
        mode: "tls", listenPort: 25070, userId: 1,
      });
      const usage = "` + usage + `";
      const statements = usage === "ordinary-rule"
        ? "INSERT INTO forward_rules (id,hostId,userId,name,sourcePort,targetIp,targetPort) " +
          "VALUES (9002,1,1,'late-rule',29002,'192.0.2.90',80);"
        : "INSERT INTO forward_rules (id,hostId,userId,name,sourcePort,targetIp,targetPort) " +
          "VALUES (9002,2,1,'late-exit',29002,'192.0.2.90',80); " +
          "INSERT INTO forward_rule_tunnel_exits (ruleId,tunnelId,exitNodeId,exitSeq,exitHostId,tunnelExitPort) " +
          "VALUES (9002,70,701,0,1,25071);";
      await runtime.executeRaw("UPDATE hosts SET isOnline=0 WHERE id=1");
      // This fires during pending cleanup, after all read-only final guards.
      await runtime.executeRaw(
        'CREATE TRIGGER add_late_reference AFTER UPDATE OF isRunning ON forward_rules ' +
        'WHEN OLD.id=9001 BEGIN ' + statements + ' END'
      );
      const before = await deleteSnapshot();
      const auditBefore = await runtime.queryRaw('SELECT * FROM config_audit_events ORDER BY id');
      await assert.rejects(() => hostCaller.delete({ id: 1, confirmOfflineCleanup: true }), /主机引用已变化/);
      assert.deepEqual(await deleteSnapshot(), before);
      assert.deepEqual(await runtime.queryRaw('SELECT * FROM forward_rule_tunnel_exits'), []);
      assert.deepEqual(await runtime.queryRaw('SELECT * FROM config_audit_events ORDER BY id'), auditBefore);
    `);
  });
}

test("multi-host token deletion rolls back earlier hosts and preserves runtime presence until commit", () => {
  runGroupMemberReleaseCase(`
    const presence = await import("./server/agentFastLiveness.ts");
    const auth = await import("./server/repositories/tokenRepository.ts");
    await insert("agent_tokens", { id: 50, token: "shared-rollback", hostId: 1, userId: 1 });
    await runtime.executeRaw("UPDATE hosts SET agentToken='shared-rollback' WHERE id IN (1,2)");
    for (const id of [1,2]) {
      await insert("user_host_permissions", { userId: 1, hostId: id });
      await insert("forward_rules", {
        id: 9000 + id, hostId: id, userId: 1, name: "pending-" + id,
        sourcePort: 29000 + id, targetIp: "192.0.2.90", targetPort: 80,
        pendingDelete: 1, isRunning: 1,
      });
      presence.registerPresenceCapableHost(id);
    }
    const presenceBefore = [1,2].map(presence.getAgentFastLivenessState);
    const authBefore = await auth.getAgentAuthTokenCandidates({ force: true });
    const before = await deleteSnapshot();
    const auditBefore = await runtime.queryRaw('SELECT * FROM config_audit_events ORDER BY id');
    await runtime.executeRaw(
      'CREATE TRIGGER reject_second_host BEFORE DELETE ON hosts WHEN OLD.id=2 ' +
      "BEGIN SELECT RAISE(ABORT,'injected-second-host-failure'); END"
    );
    await assert.rejects(() => tokenCaller.delete({ id: 50 }), /injected-second-host-failure/);
    assert.deepEqual(await deleteSnapshot(), before);
    assert.deepEqual([1,2].map(presence.getAgentFastLivenessState), presenceBefore);
    assert.deepEqual(await auth.getAgentAuthTokenCandidates(), authBefore);
    assert.deepEqual(await runtime.queryRaw('SELECT * FROM config_audit_events ORDER BY id'), auditBefore);
    await runtime.executeRaw('DROP TRIGGER reject_second_host');
    const result = await tokenCaller.delete({ id: 50 });
    assert.equal(result.removedHosts, 2);
    assert.equal(result.releasedPendingCleanup, 2);
    assert.ok([1,2].every(id => !presence.getAgentFastLivenessState(id)));
    assert.ok(!(await auth.getAgentAuthTokenCandidates()).includes("shared-rollback"));
  `);
});

for (const change of ["value", "owner", "hostId", "host-set", "host-owner"]) {
  test("token deletion rechecks its complete saved identity and host set: " + change, () => {
    runGroupMemberReleaseCase(`
      await seedFailover();
      await runtime.executeRaw('DELETE FROM forward_group_members WHERE hostId=1');
      await insert("agent_tokens", { id: 50, token: "changing-token", hostId: 1, userId: 1 });
      await runtime.executeRaw("UPDATE hosts SET agentToken='changing-token' WHERE id=1");
      await insert("users", { id: 2, username: "customer", password: "test", role: "user" });
      const updates = {
        value: "UPDATE agent_tokens SET token='replacement-token' WHERE id=50;",
        owner: "UPDATE agent_tokens SET userId=2 WHERE id=50;",
        hostId: "UPDATE agent_tokens SET hostId=2 WHERE id=50;",
        "host-set": "UPDATE hosts SET agentToken='changing-token' WHERE id=3;",
        "host-owner": "UPDATE hosts SET userId=2 WHERE id=1;",
      };
      const change = "` + change + `";
      // Ownership must also be checked after historical repair, inside the final save.
      const customerContext = { ...context, user: { ...context.user, role: "user" } };
      const caller = change === "host-owner" ? agentTokensRouter.createCaller(customerContext) : tokenCaller;
      await runtime.executeRaw(
        'CREATE TRIGGER change_token_during_repair AFTER UPDATE OF hostId ON forward_rules ' +
        'WHEN OLD.id=1000 BEGIN ' + updates[change] + ' END'
      );
      await assert.rejects(() => caller.delete({ id: 50 }), /主机引用已变化|无权/);
      assert.equal((await runtime.queryRaw('SELECT id FROM hosts WHERE id=1')).length, 1);
      assert.equal((await runtime.queryRaw('SELECT id FROM agent_tokens WHERE id=50')).length, 1);
      assert.equal((await runtime.queryRaw('SELECT hostId FROM forward_rules WHERE id=1000'))[0].hostId, 2);
    `);
  });
}

test("historical repair without a surviving candidate retains the original root and deletion protection", () => {
  runGroupMemberReleaseCase(`
    await seedFailover();
    await runtime.executeRaw('DELETE FROM forward_group_members WHERE groupId=10');
    const before = await rootSnapshot(10);
    assert.equal((await hosts.getHostRuleDeleteBlockers(1)).managedRuleCount, 1);
    await assert.rejects(() => hostCaller.delete({ id: 1 }), /转发组/);
    assert.deepEqual(await rootSnapshot(10), before);
    assert.deepEqual(await runtime.queryRaw('SELECT hostId,pendingDelete FROM forward_rules WHERE id=1000'),
      [{ hostId: 1, pendingDelete: 0 }]);
  `);
});

test("deletion preview lists the retained root when historical members have no surviving host", () => {
  runGroupMemberReleaseCase(`
    await seedFailover();
    await runtime.executeRaw('UPDATE forward_group_members SET hostId=999 WHERE groupId=10');
    await runtime.executeRaw('DELETE FROM forward_rules WHERE forwardGroupId=10 AND isForwardGroupTemplate=0');
    const before = await deleteSnapshot();
    const preview = await hostCaller.deleteImpact({ id: 1 });
    assert.equal(preview.blocked, true);
    assert.deepEqual(preview.rules.items.map(rule => rule.id), [1000]);
    assert.deepEqual(await deleteSnapshot(), before);
    const prepared = await hostCaller.prepareDelete({ id: 1 });
    assert.equal(prepared.blocked, true);
    assert.deepEqual(prepared.rules.items, preview.rules.items);
    await assert.rejects(() => hostCaller.delete({ id: 1 }), error => {
      assert.ok(error.message.includes(preview.rules.items[0].name));
      return true;
    });
    assert.deepEqual(await deleteSnapshot(), before);
  `);
});

test("final rule checks are read only and historical repair rejects an already-started save", () => {
  runGroupMemberReleaseCase(`
    await seedFailover();
    await runtime.executeRaw('DELETE FROM forward_group_members WHERE hostId=1');
    const before = await deleteSnapshot();
    await withGroupMemberMutation(() => runtime.withDatabaseTransaction(async () => {
      assert.equal((await hosts.readHostRuleDeleteBlockers(1)).managedRuleCount, 2);
      await assert.rejects(() => hosts.assertHostHasNoForwardingReferences(1), /主机引用已变化/);
      await assert.rejects(() => links.repairForwardGroupTemplateHostReferences({ hostId: 1 }), /数据库保存前/);
    }));
    assert.deepEqual(await deleteSnapshot(), before);
  `);
});

test("structure blocker counts deduplicate a tunnel and ignore orphaned links", () => {
  runGroupMemberReleaseCase(`
    await insert("tunnels", {
      id: 70, name: "multi-use", entryHostId: 1, exitHostId: 1,
      mode: "tls", listenPort: 25070, userId: 1,
    });
    await insert("tunnel_hops", { tunnelId: 70, seq: 0, hostId: 1, listenPort: 25071 });
    await insert("tunnel_exit_nodes", { tunnelId: 70, seq: 0, hostId: 1, listenPort: 25072 });
    await insert("tunnel_hops", { tunnelId: 999, seq: 0, hostId: 1, listenPort: 25073 });
    await insert("forward_group_members", { groupId: 999, memberType: "host", hostId: 1, priority: 0 });
    assert.deepEqual(await hosts.getHostLinkDeleteBlockers(1), { groupCount: 0, tunnelCount: 1 });
  `);
});

for (const stage of ["pending-cleanup", "token-unbind", "later-host-delete"]) {
  for (const usage of ["ordinary-rule", "rule-exit"]) {
    test("token deletion rolls back a live reference introduced during " + stage + ": " + usage, () => {
      runGroupMemberReleaseCase(`
        const stage = "` + stage + `";
        const usage = "` + usage + `";
        await insert("forward_rules", {
          id: 9001, hostId: 1, userId: 1, name: "pending", sourcePort: 29001,
          targetIp: "192.0.2.90", targetPort: 80, pendingDelete: 1, isRunning: 1,
        });
        await insert("agent_tokens", { id: 50, token: "late-token-use", hostId: 1, userId: 1 });
        await runtime.executeRaw("UPDATE hosts SET agentToken='late-token-use' WHERE id=1");
        await insert("user_host_permissions", { userId: 1, hostId: 1 });
        await insert("tunnels", {
          id: 70, name: "independent", entryHostId: 3, exitHostId: 4,
          mode: "tls", listenPort: 25070, userId: 1,
        });
        if (stage === "later-host-delete") {
          // Host 1 legitimately survives automatic cleanup; host 2 deletes later.
          await runtime.executeRaw("UPDATE hosts SET agentToken='late-token-use' WHERE id=2");
          await insert("subscription_plans", { id: 80, name: "retained", durationDays: 30 });
          await insert("subscription_plan_hosts", { planId: 80, hostId: 1 });
        }
        const statements = usage === "ordinary-rule"
          ? "INSERT INTO forward_rules (id,hostId,userId,name,sourcePort,targetIp,targetPort) " +
            "VALUES (9002,1,1,'late-rule',29002,'192.0.2.90',80);"
          : "INSERT INTO forward_rules (id,hostId,userId,name,sourcePort,targetIp,targetPort) " +
            "VALUES (9002,3,1,'late-exit',29002,'192.0.2.90',80); " +
            "INSERT INTO forward_rule_tunnel_exits (ruleId,tunnelId,exitNodeId,exitSeq,exitHostId,tunnelExitPort) " +
            "VALUES (9002,70,701,0,1,25071);";
        const trigger = stage === "pending-cleanup"
          ? 'AFTER UPDATE OF isRunning ON forward_rules WHEN OLD.id=9001'
          : stage === "token-unbind"
            ? 'AFTER UPDATE OF agentToken ON hosts WHEN OLD.id=1 AND NEW.agentToken IS NULL'
            : 'AFTER DELETE ON hosts WHEN OLD.id=2';
        await runtime.executeRaw('CREATE TRIGGER late_token_reference ' + trigger + ' BEGIN ' + statements + ' END');
        const before = await deleteSnapshot();
        const auditBefore = await runtime.queryRaw('SELECT * FROM config_audit_events ORDER BY id');
        await assert.rejects(() => tokenCaller.delete({ id: 50 }), /主机引用已变化/);
        assert.deepEqual(await deleteSnapshot(), before);
        assert.deepEqual(await runtime.queryRaw('SELECT * FROM forward_rule_tunnel_exits'), []);
        assert.deepEqual(await runtime.queryRaw('SELECT * FROM config_audit_events ORDER BY id'), auditBefore);
      `);
    });
  }
}

for (const retainedBy of ["plan", "other-token"]) {
  test("token deletion still permits legitimate automatic host retention: " + retainedBy, () => {
    runGroupMemberReleaseCase(`
      await insert("agent_tokens", { id: 50, token: "remove-only-token", hostId: 1, userId: 1 });
      await runtime.executeRaw("UPDATE hosts SET agentToken='remove-only-token' WHERE id=1");
      if ("` + retainedBy + `" === "plan") {
        await insert("subscription_plans", { id: 80, name: "retained", durationDays: 30 });
        await insert("subscription_plan_hosts", { planId: 80, hostId: 1 });
      } else {
        await insert("agent_tokens", { id: 51, token: "keep-other-token", hostId: 1, userId: 1 });
      }
      const result = await tokenCaller.delete({ id: 50 });
      assert.equal(result.removedHosts, 0);
      assert.equal((await runtime.queryRaw('SELECT id FROM agent_tokens WHERE id=50')).length, 0);
      assert.deepEqual(await runtime.queryRaw('SELECT id,agentToken FROM hosts WHERE id=1'), [{ id: 1, agentToken: null }]);
      if ("` + retainedBy + `" === "plan") {
        assert.equal((await runtime.queryRaw('SELECT hostId FROM subscription_plan_hosts WHERE hostId=1')).length, 1);
      } else {
        assert.equal((await runtime.queryRaw('SELECT id FROM agent_tokens WHERE id=51')).length, 1);
      }
    `);
  });
}

test("host deletion rechecks current ownership in the final save after historical repair", () => {
  runGroupMemberReleaseCase(`
    await seedFailover();
    await runtime.executeRaw('DELETE FROM forward_group_members WHERE hostId=1');
    await insert("users", { id: 2, username: "new-owner", password: "test", role: "user" });
    await insert("agent_tokens", { id: 50, token: "new-owner-token", hostId: 1, userId: 1 });
    await runtime.executeRaw("UPDATE hosts SET agentToken='new-owner-token' WHERE id=1");
    await insert("user_host_permissions", { userId: 1, hostId: 1 });
    await insert("forward_rules", {
      id: 9001, hostId: 1, userId: 1, name: "pending", sourcePort: 29001,
      targetIp: "192.0.2.90", targetPort: 80, pendingDelete: 1, isRunning: 1,
    });
    await runtime.executeRaw(
      'CREATE TRIGGER transfer_host_during_repair AFTER UPDATE OF hostId ON forward_rules ' +
      'WHEN OLD.id=1000 BEGIN UPDATE hosts SET userId=2 WHERE id=1; END'
    );
    const userContext = { ...context, user: { ...context.user, role: "user" } };
    await assert.rejects(() => hostsRouter.createCaller(userContext).delete({ id: 1 }), /无权/);
    assert.deepEqual(await runtime.queryRaw('SELECT userId,agentToken FROM hosts WHERE id=1'),
      [{ userId: 2, agentToken: "new-owner-token" }]);
    assert.equal((await runtime.queryRaw('SELECT id FROM agent_tokens WHERE id=50')).length, 1);
    assert.equal((await runtime.queryRaw('SELECT userId FROM user_host_permissions WHERE hostId=1')).length, 1);
    assert.deepEqual(await runtime.queryRaw('SELECT isRunning FROM forward_rules WHERE id=9001'), [{ isRunning: 1 }]);
    assert.deepEqual(await runtime.queryRaw('SELECT hostId FROM forward_rules WHERE id=1000'), [{ hostId: 2 }]);
    assert.equal((await runtime.queryRaw("SELECT id FROM config_audit_events WHERE resourceType='host' AND resourceId=1 AND action='delete'")).length, 0);
  `);
});

for (const enable of [false, true]) {
  for (const tunnelFirst of [true, false]) {
    test(`entry members and toggle finish with tunnel save queued first=${tunnelFirst}, enable=${enable}`, () => {
      runGroupMemberReleaseCase(`
        // Keep a stuck child alive so the parent timeout proves it cannot hang the suite.
        const keepAlive = setInterval(() => {}, 1000);
        const { withResourceTaskLock, withKeyedTaskLock } = await import('./server/keyedTaskLock.ts');
        const { tunnelsRouter } = await import('./server/routers/tunnels.ts');
        await seedEntryChain();
        if (${enable}) await links.setForwardGroupEnabled(30, false);
        // Insert in reverse order: acquisition must use numeric ids, not query order.
        for (const id of [71, 70]) {
          await insert('tunnels', { id, name:'queued-' + id, entryHostId:4, exitHostId:3,
            entryGroupId:30, mode:'tls', listenPort:25000 + id, userId:1,
            isEnabled:${enable ? 0 : 1}, disabledByGroup:${enable ? 1 : 0} });
          await insert('forward_rules', { id:9000 + id, name:'tunnel-rule-' + id,
            hostId:4, userId:1, tunnelId:id, forwardType:'gost', protocol:'tcp',
            sourcePort:26000 + id, targetIp:'192.0.2.90', targetPort:8443,
            isEnabled:${enable ? 0 : 1}, disabledByTunnel:${enable ? 1 : 0} });
          tunnelState.bumpTunnelRuntimeGeneration(id);
          tunnelState.recordTunnelRuntimeHostStatus(id, 4, true);
        }
        const frames = captureAgentFrames([1,2,3,4,5,6]);
        const before = frames();
        const generations = [70,71].map(id => tunnelState.getTunnelRuntimeGeneration(id));
        const waitDepth = async (key, expected) => {
          for (let i=0;i<2000;i++) {
            if (keyedTaskDepth(key) === expected) return;
            await new Promise(resolve => setImmediate(resolve));
          }
          assert.fail(key + ' did not reach depth ' + expected);
        };
        let release, entered;
        const gate = new Promise(resolve => { release=resolve; });
        const ready = new Promise(resolve => { entered=resolve; });
        let groupSave, tunnelSave;
        if (${tunnelFirst}) {
          // Queue the real route before the group, then release the gate only
          // after both reached the same tunnel position. Old code holds the DB
          // at that point, so the real tunnel route and group wait on each other.
          const holding = withKeyedTaskLock('tunnel:70', async () => {
            entered(); await gate;
          });
          await ready;
          tunnelSave = tunnelsRouter.createCaller(context).update({id:70,name:'concurrent-save'});
          await waitDepth('tunnel:70', 2);
          groupSave = saveMembers(30, [5], { isEnabled:${enable} });
          await waitDepth('tunnel:70', 3);
          assert.equal(keyedTaskDepth('tunnel:71'), 0, 'acquire smaller tunnel first');
          release();
          await holding;
        } else {
          // Pause before the second tunnel position, outside the DB transaction.
          const holding = withResourceTaskLock('tunnel:71', async () => {
            entered(); await gate;
          });
          await ready;
          groupSave = saveMembers(30, [5], { isEnabled:${enable} });
          await waitDepth('tunnel:71', 2);
          assert.equal(keyedTaskDepth('forward-group-sync:30'), 1);
          assert.equal(keyedTaskDepth('forward-group-sync:40'), 1);
          assert.equal(keyedTaskDepth('tunnel:70'), 1);
          assert.deepEqual(frames(), before, 'queued save must not notify');
          for (const [index,id] of [70,71].entries()) {
            assert.equal(tunnelState.getTunnelRuntimeGeneration(id), generations[index]);
            assert.equal(tunnelState.getTunnelRuntimeHostStatus(id,4), true);
          }
          // This direction calls the real tunnel update route, queued behind the group.
          tunnelSave = tunnelsRouter.createCaller(context).update({id:70,name:'concurrent-save'});
          await waitDepth('tunnel:70', 2);
          release();
          await holding;
        }
        await Promise.all([groupSave,tunnelSave]);
        assert.deepEqual((await links.getForwardGroupById(30)).members.map(m => m.hostId), [5]);
        assert.equal(Boolean((await links.getForwardGroupById(30)).isEnabled), ${enable});
        await assertGroupReleased(40,4,5);
        assert.deepEqual(await runtime.queryRaw(
          'SELECT id,isEnabled,disabledByGroup,entryHostId FROM tunnels ORDER BY id'),
          [70,71].map(id => ({id,isEnabled:${enable ? 1 : 0},disabledByGroup:${enable ? 0 : 1},entryHostId:4})));
        assert.equal((await runtime.queryRaw('SELECT name FROM tunnels WHERE id=70'))[0].name,'concurrent-save');
        const tunnelRules = await runtime.queryRaw('SELECT isEnabled,disabledByTunnel FROM forward_rules WHERE tunnelId IN (70,71) ORDER BY id');
        assert.deepEqual(tunnelRules, [70,71].map(() => ({isEnabled:${enable ? 1 : 0},disabledByTunnel:${enable ? 0 : 1}})));
        for (const [index,id] of [70,71].entries()) {
          assert.ok(tunnelState.getTunnelRuntimeGeneration(id)>generations[index]);
          assert.notEqual(tunnelState.getTunnelRuntimeHostStatus(id,4),true);
        }
        assert.ok(frames().some(([id,values]) => values.length>before.find(([old])=>old===id)[1].length));
        clearInterval(keepAlive);
      `, { timeout: 8_000 });
    });
  }
}

for (const enable of [false, true]) {
  test('entry toggle rolls back both tunnel saves and runtime, enable=' + enable, () => {
    runGroupMemberReleaseCase(`
      await seedEntryChain();
      if (${enable}) await links.setForwardGroupEnabled(30, false);
      for (const id of [71,70]) {
        await insert('tunnels', { id,name:'rollback-' + id,entryHostId:4,exitHostId:3,
          entryGroupId:30,mode:'tls',listenPort:25000 + id,userId:1,
          isEnabled:${enable ? 0 : 1},disabledByGroup:${enable ? 1 : 0} });
        await insert('forward_rules', { id:9000 + id,name:'rollback-rule-' + id,
          hostId:4,userId:1,tunnelId:id,forwardType:'gost',protocol:'tcp',
          sourcePort:26000 + id,targetIp:'192.0.2.90',targetPort:8443,
          isEnabled:${enable ? 0 : 1},disabledByTunnel:${enable ? 1 : 0} });
        tunnelState.bumpTunnelRuntimeGeneration(id);
        tunnelState.recordTunnelRuntimeHostStatus(id,4,true);
      }
      const members = await runtime.queryRaw('SELECT * FROM forward_group_members ORDER BY id');
      const rules = await runtime.queryRaw('SELECT * FROM forward_rules ORDER BY id');
      const tunnels = await runtime.queryRaw('SELECT * FROM tunnels ORDER BY id');
      const groupsBefore = await runtime.queryRaw('SELECT * FROM forward_groups ORDER BY id');
      const frames = captureAgentFrames([1,2,3,4,5,6]);
      const before = frames();
      const generations = [70,71].map(id => tunnelState.getTunnelRuntimeGeneration(id));
      await runtime.executeRaw('CREATE TRIGGER reject_second_tunnel BEFORE UPDATE OF isEnabled ON tunnels ' +
        'WHEN OLD.id=71 AND NEW.isEnabled=${enable ? 1 : 0} ' +
        "BEGIN SELECT RAISE(ABORT,'injected-second-tunnel-toggle'); END");
      await assert.rejects(() => saveMembers(30,[5],{isEnabled:${enable}}), /injected-second-tunnel-toggle/);
      assert.deepEqual(await runtime.queryRaw('SELECT * FROM forward_group_members ORDER BY id'),members);
      assert.deepEqual(await runtime.queryRaw('SELECT * FROM forward_rules ORDER BY id'),rules);
      assert.deepEqual(await runtime.queryRaw('SELECT * FROM tunnels ORDER BY id'),tunnels);
      assert.deepEqual(await runtime.queryRaw('SELECT * FROM forward_groups ORDER BY id'),groupsBefore);
      assert.deepEqual(frames(),before);
      for (const [index,id] of [70,71].entries()) {
        assert.equal(tunnelState.getTunnelRuntimeGeneration(id),generations[index]);
        assert.equal(tunnelState.getTunnelRuntimeHostStatus(id,4),true);
      }
      await runtime.executeRaw('DROP TRIGGER reject_second_tunnel');
      // All positions must also be released after rollback.
      await saveMembers(30,[5],{isEnabled:${enable}});
      await assertGroupReleased(40,4,5);
    `, {timeout:8_000});
  });
}

test('entry toggle rejects a newly attached tunnel before saving any group state', () => {
  runGroupMemberReleaseCase(`
    const { withKeyedTaskLock } = await import('./server/keyedTaskLock.ts');
    await seedEntryChain();
    await insert('tunnels', {id:70,name:'scope',entryHostId:4,exitHostId:3,
      entryGroupId:30,mode:'tls',listenPort:25070,userId:1,isEnabled:1});
    const frames = captureAgentFrames([1,2,3,4,5,6]);
    const before = frames();
    const rules = await runtime.queryRaw('SELECT * FROM forward_rules ORDER BY id');
    let release,entered;
    const gate = new Promise(resolve => {release=resolve;});
    const ready = new Promise(resolve => {entered=resolve;});
    const edit = withKeyedTaskLock('tunnel:70',async () => {
      entered(); await gate;
      await runtime.withDatabaseTransaction(() => insert('tunnels',{
        id:71,name:'late-reference',entryHostId:6,exitHostId:3,entryGroupId:30,
        mode:'tls',listenPort:25071,userId:1,isEnabled:1}));
    });
    await ready;
    const save = saveMembers(30,[5],{isEnabled:false});
    // Attach rejection immediately: the held edit will change the saved scope.
    const rejected = assert.rejects(save,/入口组引用发生变化/);
    for (let turn=0;turn<2000 && keyedTaskDepth('tunnel:70')!==2;turn++) {
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.equal(keyedTaskDepth('tunnel:70'),2);
    release();
    await Promise.all([edit,rejected]);
    const current = await links.getForwardGroupById(30);
    assert.deepEqual(current.members.map(m=>m.hostId),[4,5]);
    assert.equal(Boolean(current.isEnabled),true);
    assert.deepEqual(await runtime.queryRaw('SELECT * FROM forward_rules ORDER BY id'),rules);
    assert.deepEqual(await runtime.queryRaw('SELECT id,isEnabled FROM tunnels ORDER BY id'),
      [{id:70,isEnabled:1},{id:71,isEnabled:1}]);
    assert.deepEqual(frames(),before);
    await saveMembers(30,[5],{isEnabled:false});
    assert.deepEqual(await runtime.queryRaw('SELECT id,isEnabled FROM tunnels ORDER BY id'),
      [{id:70,isEnabled:0},{id:71,isEnabled:0}]);
  `, {timeout:8_000});
});

test('entry toggle follows existing SNI group then tunnel save order', () => {
  runGroupMemberReleaseCase(`
    const { withResourceTaskLock } = await import('./server/keyedTaskLock.ts');
    const { withSniRuleWrite } = await import('./server/sniRuleWrite.ts');
    await seedEntryChain(true);
    await insert('tunnels',{id:70,name:'sni-order',entryHostId:6,exitHostId:3,
      entryGroupId:30,mode:'tls',listenPort:25070,userId:1,isEnabled:1});
    let release,entered;
    const gate = new Promise(resolve=>{release=resolve;});
    const ready = new Promise(resolve=>{entered=resolve;});
    // The existing SNI coordinator holds all group positions before tunnels.
    // Reuse that active group scope so its real coordinator can pause between them.
    const sniSave = withResourceTaskLock('forward-group-sync:30',async()=>{
      entered(); await gate;
      return withSniRuleWrite(undefined,{tunnelId:70,forwardType:'gost',sni:'order.example.test'},
        ()=>runtime.withDatabaseTransaction(()=>runtime.executeRaw(
          "UPDATE tunnels SET name='sni-coordinated-save' WHERE id=70")));
    });
    await ready;
    const groupSave = saveMembers(30,[5],{isEnabled:false});
    for(let turn=0;turn<2000 && keyedTaskDepth('forward-group-sync:30')!==2;turn++) {
      await new Promise(resolve=>setImmediate(resolve));
    }
    assert.equal(keyedTaskDepth('forward-group-sync:30'),2);
    assert.equal(keyedTaskDepth('tunnel:70'),0,
      'group save must not hold a tunnel while waiting for the SNI group position');
    release();
    await Promise.all([sniSave,groupSave]);
    await assertGroupReleased(40,4,5);
    assert.deepEqual(await runtime.queryRaw('SELECT name,isEnabled,entryHostId FROM tunnels WHERE id=70'),
      [{name:'sni-coordinated-save',isEnabled:0,entryHostId:6}]);
  `,{timeout:8_000});
});


test("stopped member cleanup preserves failed settlement for later retry", () => {
  runGroupMemberReleaseCase(`
    await seedFailover();
    const settings = await import('./server/repositories/settingsRepository.ts');
    const rules = await import('./server/repositories/forwardRuleRepository.ts');
    await settings.setSetting('trafficBillingEnabled', 'true');
    await runtime.executeRaw('UPDATE users SET balanceCents=100000 WHERE id=1');
    const [child] = await runtime.queryRaw('SELECT id FROM forward_rules WHERE forwardGroupRuleId=1000 AND hostId=1');
    await insert('traffic_billing_configs', {id:90,resourceType:'forward_group',resourceId:10,enabled:1,pricePerGbCents:100,multiplier:100});
    await insert('traffic_billing_rule_usage', {id:91,userId:1,ruleId:child.id,resourceType:'forward_group',resourceId:10,totalBytes:100000000,billedGb:0,pendingMilliCents:0,settled:0});
    await runtime.executeRaw("CREATE TRIGGER reject_settlement BEFORE UPDATE OF settled ON traffic_billing_rule_usage WHEN OLD.id=91 BEGIN SELECT RAISE(ABORT,'injected-settlement-failure'); END");
    await assert.rejects(() => saveMembers(10,[2]));
    await rules.updateRuleRunningStatus(child.id,false);
    const pending = await rules.getForwardRuleById(child.id);
    assert.ok(pending, 'retain settlement retry identity after stop acknowledgement');
    assert.equal(Number(pending.isRunning),0);
    await runtime.executeRaw('DROP TRIGGER reject_settlement');
    await rules.purgeSettledPendingForwardRuleDeletes();
    assert.equal(await rules.getForwardRuleById(child.id), undefined);
    const [usage] = await runtime.queryRaw('SELECT settled FROM traffic_billing_rule_usage WHERE id=91');
    assert.equal(Number(usage.settled),1);
    const records = await runtime.queryRaw('SELECT amountCents FROM traffic_billing_records WHERE ruleId=?',[child.id]);
    assert.equal(records.length,1);
    await rules.purgeSettledPendingForwardRuleDeletes();
    assert.equal((await runtime.queryRaw('SELECT id FROM traffic_billing_records WHERE ruleId=?',[child.id])).length,1);
  `);
});
