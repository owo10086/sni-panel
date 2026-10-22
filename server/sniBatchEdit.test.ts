import test from "node:test";
import { verifySniWrites } from "./test-support/sniWrites";


test("different SNI domains can edit the same multi-host entry concurrently on port 443", () => {
  verifySniWrites(String.raw`
    const first = await create("first");
    const second = await create("second");
    const results = await within(Promise.allSettled([
      admin.update({ id: first.id, targetPort: 9443 }),
      admin.update({ id: second.id, targetPort: 10443 }),
    ]), "two concurrent SNI edits");
    assert.deepEqual(results.map(result => result.status), ["fulfilled", "fulfilled"], JSON.stringify(results));
    assert.equal((await admin.getById({ id: first.id })).targetPort, 9443);
    assert.equal((await admin.getById({ id: second.id })).targetPort, 10443);
    await within(settings.setSetting("sniWriteCheck", "saved"), "independent write after edits");
  `);
});


test("waiting for resource saving leaves ports free and rechecks changed entry hosts", () => {
  verifySniWrites(String.raw`
    const groups = await import("./server/repositories/forwardGroupRepository.ts");
    const { reserveSpecificHostPort } = await import("./server/portReservations.ts");
    await addGroup(20, "failover", [3, 4]);
    const rule = await create("moving");
    const held = Promise.withResolvers();
    const release = Promise.withResolvers();
    const change = groups.withForwardGroupSyncTransaction(20, async () => {
      await runtime.afterDatabaseCommit(async () => {
        held.resolve();
        await release.promise;
        await runtime.executeRaw('UPDATE "forward_group_members" SET "hostId" = 5 WHERE "groupId" = 20 AND "hostId" = 3');
      });
    });
    await held.promise;
    const editing = admin.update({ id: rule.id, forwardGroupId: 20, sourcePort: 444 });
    try {
      // Let the real database-backed route checks reach the held save boundary.
      for (let turn = 0; turn < 50; turn++) await new Promise(resolve => setImmediate(resolve));
      const allocation = await reserveSpecificHostPort({ hostId: 3, port: 444, protocol: "tcp", isUsed: async () => false });
      assert.ok(allocation, "an edit waiting for resource saving must not reserve its port yet");
      allocation.release();
      await within(settings.setSetting("duringResourceWait", "saved"), "database write during resource wait");
    } finally {
      release.resolve();
      await change;
    }
    await within(editing, "edit after entry host changes");
    const saved = await admin.getById({ id: rule.id });
    assert.equal(Number(saved.forwardGroupId), 20);
    assert.equal(Number(saved.sourcePort), 444);
    const children = await (await import("./server/repositories/forwardRuleRepository.ts")).getForwardGroupChildRules(20);
    assert.deepEqual(children.filter(row => !row.pendingDelete).map(row => Number(row.hostId)).sort(), [4, 5]);
  `);
});

test("SNI creation, import, edits and toggles share current domains across resources on one host", () => {
  verifySniWrites(String.raw`
    await addGroup(20, "chain", [3, 4]);
    await addGroup(21, "chain", [3, 5]);
    const first = await create("cross-resource", { forwardGroupId: 20 });
    const other = await create("other-resource", { forwardGroupId: 21 });
    await admin.checkSniImport({ forwardGroupId: 21, sourcePort: 443, rules: [{ lineNumber: 1, sni: "imported.example.test" }] });
    const results = await within(Promise.all([
      admin.update({ id: first.id, targetPort: 9443 }),
      admin.update({ id: other.id, maxConnections: 12 }),
      create("imported", { forwardGroupId: 21 }),
    ]), "import, create and edit together");
    const imported = results[2];
    assert.equal((await admin.getById({ id: first.id })).targetPort, 9443);
    assert.equal((await admin.getById({ id: other.id })).maxConnections, 12);
    const duplicate = await Promise.allSettled([
      admin.update({ id: first.id, sni: "Duplicate.Example.Test." }),
      admin.create({ forwardGroupId: 21, name: "duplicate", sourcePort: 444, targetIp: "203.0.113.20", targetPort: 443, sni: "duplicate.example.test" }),
    ]);
    assert.equal(duplicate.filter(result => result.status === "fulfilled").length, 1);
    assert.match(duplicate.find(result => result.status === "rejected").reason.message, /SNI|域名/);
    await Promise.all([
      admin.toggle({ id: imported.id, isEnabled: false }),
      admin.update({ id: other.id, targetPort: 10443 }),
    ]);
    assert.equal((await admin.getById({ id: imported.id })).isEnabled, false);
    await Promise.all([
      admin.toggle({ id: imported.id, isEnabled: true }),
      admin.update({ id: other.id, rateLimitMbps: 18 }),
    ]);
    assert.equal((await admin.getById({ id: imported.id })).isEnabled, true);
    await admin.update({ id: imported.id, sni: null, sourcePort: 446 });
    assert.equal((await admin.getById({ id: imported.id })).sni, null);
    await Promise.all([
      admin.update({ id: imported.id, sni: "imported.example.test", sourcePort: 443 }),
      admin.update({ id: other.id, targetPort: 11443 }),
    ]);
    assert.equal((await admin.getById({ id: imported.id })).sni, "imported.example.test");
    await assert.rejects(() => admin.create({ forwardGroupId: 21, name: "ordinary-mix", sourcePort: 443, targetIp: "203.0.113.50", targetPort: 443 }), /占用|used|SNI/);
    const ordinary = rulesRouter.createCaller(context({ id: 2, username: "ordinary", role: "user", accountEnabled: true }));
    await insert("users", { id: 2, username: "ordinary", password: "x", role: "user", canAddRules: 1, manualCanAddRules: 1 });
    const mixed = await Promise.allSettled([
      admin.update({ id: other.id, maxConnections: 15 }),
      ordinary.update({ id: first.id, targetPort: 12443 }),
      admin.update({ id: 999999, targetPort: 12443 }),
      admin.update({ id: imported.id, forwardGroupId: 999998 }),
    ]);
    assert.deepEqual(mixed.map(result => result.status), ["fulfilled", "rejected", "rejected", "rejected"]);
    assert.equal((await admin.getById({ id: other.id })).maxConnections, 15);
    const entry = splitters(await heartbeat(3)).find(action => action.sourcePort === 443);
    assert.ok(entry.fxp.sniRoutes.some(route => route.sni === "imported.example.test"));
    assert.ok(entry.fxp.sniRoutes.some(route => route.sni === "other-resource.example.test"));
  `);
});

test("opposite multi-host moves between a forward group and a direct TLS tunnel finish together", () => {
  verifySniWrites(String.raw`
    await addGroup(30, "entry", [5, 6], { domain: "tls.example.test" });
    await insert("tunnels", { id: 20, name: "direct-tls", entryHostId: 3, exitHostId: 4, entryGroupId: 30, mode: "tls", listenPort: 24020, userId: 1, isEnabled: 1 });
    const first = await create("to-tunnel");
    const kept = await create("group-kept");
    const second = await create("to-group", { forwardType: "gost", tunnelId: 20 });
    await within(Promise.all([
      admin.update({ id: first.id, forwardGroupId: null, forwardType: "gost", tunnelId: 20 }),
      admin.update({ id: second.id, forwardGroupId: 10 }),
    ]), "opposite group/tunnel conversions");
    assert.equal(Number((await admin.getById({ id: first.id })).tunnelId), 20);
    assert.equal(Number((await admin.getById({ id: second.id })).forwardGroupId), 10);
    for (const hostId of [1, 2]) {
      const routes = splitters(await heartbeat(hostId)).flatMap(action => action.fxp.sniRoutes);
      assert.deepEqual(routes.map(route => route.sni).sort(), ["group-kept.example.test", "to-group.example.test"]);
    }
    for (const hostId of [3, 5, 6]) {
      const state = await heartbeat(hostId);
      assert.ok(state.desiredState.actions.some(action => action.op === "apply" && action.forwardType === "gost-runtime-sync"));
      assert.ok(state.runningRules.some(rule => Number(rule.tunnelId) === 20 && Number(rule.sourcePort) === 443));
    }
    const exit = splitters(await heartbeat(4)).flatMap(action => action.fxp.sniRoutes);
    assert.deepEqual(exit.map(route => route.sni), ["to-tunnel.example.test"]);
    assert.equal(exit[0].targetIp, "203.0.113.10");
    const firstSaved = await admin.getById({ id: first.id });
    assert.equal(Number(firstSaved.sourcePort), 443);
    assert.ok(Number(firstSaved.tunnelExitPort) > 0);
    await within(Promise.all([
      admin.update({ id: first.id, forwardGroupId: 10 }),
      admin.update({ id: second.id, forwardGroupId: null, forwardType: "gost", tunnelId: 20 }),
    ]), "opposite conversions back");
    assert.equal(Number((await admin.getById({ id: first.id })).forwardGroupId), 10);
    assert.equal(Number((await admin.getById({ id: second.id })).tunnelId), 20);
    assert.equal((await admin.getById({ id: kept.id })).targetPort, 8443);
  `);
});

test("a failed member save rolls back the root and releases ports for the next edit", () => {
  verifySniWrites(String.raw`
    const rule = await create("rollback");
    const before = await admin.getById({ id: rule.id });
    const initial = splitters(await heartbeat(2));
    await runtime.executeRaw('CREATE TRIGGER reject_batch_save BEFORE UPDATE ON forward_rules WHEN NEW.hostId = 2 AND NEW.targetPort = 65432 BEGIN SELECT RAISE(ABORT, "simulated member save failure"); END');
    await assert.rejects(() => admin.update({ id: rule.id, targetPort: 65432 }), /simulated member save failure/);
    assert.equal((await admin.getById({ id: rule.id })).targetPort, before.targetPort);
    await new Promise(resolve => setImmediate(resolve));
    const afterRollback = await heartbeat(2);
    assert.ok(!afterRollback.desiredState || !afterRollback.desiredState.actions.some(action => action.fxp?.sniRoutes?.some(route => route.targetPort === 65432)), "rollback must never offer the uncommitted configuration");
    assert.equal(afterRollback.runningRules[0].targetPort, 8443);
    await runtime.executeRaw('DROP TRIGGER reject_batch_save');
    await within(admin.update({ id: rule.id, targetPort: 9443 }), "edit after rollback");
    assert.equal((await admin.getById({ id: rule.id })).targetPort, 9443);
    const { reserveSpecificHostPort } = await import("./server/portReservations.ts");
    const reservation = await reserveSpecificHostPort({ hostId: 1, port: 443, protocol: "tcp", isUsed: async () => false });
    assert.ok(reservation, "failed and successful saves must release temporary reservations");
    reservation.release();
    await within(settings.setSetting("rollbackProgress", "saved"), "write after rollback");
  `);
});

test("migration commits before billing waits, unrelated hosts keep saving, and usage settles once", () => {
  verifySniWrites(String.raw`
    const billing = await import("./server/repositories/trafficBillingRepository.ts");
    const users = await import("./server/repositories/userRepository.ts");
    const savedRules = await import("./server/repositories/forwardRuleRepository.ts");
    const groups = await import("./server/repositories/forwardGroupRepository.ts");
    const { trafficBillingUserLockKey, withKeyedTaskLock } = await import("./server/keyedTaskLock.ts");
    await addGroup(20, "failover", [3, 4]);
    await addGroup(30, "failover", [5, 6]);
    const moving = await create("billing-move");
    const independent = await create("independent", { forwardGroupId: 30 });
    await billing.setTrafficBillingEnabled(true);
    await billing.upsertTrafficBillingConfig({ resourceType: "forward_group", resourceId: 10, enabled: true, requiresPermission: false, pricePerGbCents: 100, multiplier: 100 });
    const children = await savedRules.getForwardGroupChildRulesForTemplate(moving.id);
    for (const child of children) await billing.billTrafficUsage({ userId: 1, ruleId: child.id, bytes: 268435456, resourceType: "forward_group", resourceId: 10 });
    const beforeBalance = (await users.getUserById(1)).balanceCents;
    const held = Promise.withResolvers();
    const release = Promise.withResolvers();
    const blockedBilling = withKeyedTaskLock(trafficBillingUserLockKey(1), async () => { held.resolve(); await release.promise; });
    await held.promise;
    let finished = false;
    const migration = admin.update({ id: moving.id, forwardGroupId: 20 }).finally(() => { finished = true; });
    try {
      await within((async () => {
        while (Number((await admin.getById({ id: moving.id })).forwardGroupId) !== 20) await new Promise(resolve => setImmediate(resolve));
      })(), "committed root while billing waits");
      assert.equal(finished, false);
      await within(settings.setSetting("duringBilling", "saved"), "independent database write while billing waits");
      await within(admin.update({ id: independent.id, targetPort: 9443 }), "different hosts save while billing waits");
      assert.equal((await admin.getById({ id: independent.id })).targetPort, 9443);
      assert.equal((await users.getUserById(1)).balanceCents, beforeBalance);
    } finally {
      release.resolve();
      await blockedBilling;
    }
    await within(migration, "migration after billing release");
    assert.equal((await users.getUserById(1)).balanceCents, beforeBalance - 50);
    assert.equal((await billing.listTrafficBillingRecords({ userId: 1 })).length, 2);
    await groups.syncForwardGroupRules(10);
    await groups.syncForwardGroupRules(20);
    assert.equal((await users.getUserById(1)).balanceCents, beforeBalance - 50);
    assert.equal((await billing.listTrafficBillingRecords({ userId: 1 })).length, 2);
    await billing.upsertTrafficBillingConfig({ resourceType: "forward_group", resourceId: 20, enabled: true, requiresPermission: false, pricePerGbCents: 100, multiplier: 100 });
    await (await import("./server/repositories/billingRepository.ts")).setUserBalance(1, 10, { type: "adjustment", description: "test balance" });
    const active = (await savedRules.getForwardGroupChildRulesForTemplate(moving.id)).find(child => !child.pendingDelete);
    await billing.billTrafficUsage({ userId: 1, ruleId: active.id, bytes: 268435456, resourceType: "forward_group", resourceId: 20 });
    await admin.update({ id: moving.id, forwardGroupId: 10 });
    const account = await users.getUserById(1);
    assert.equal(account.balanceCents, -15);
    assert.equal(account.forwardAccessPauseReason, "traffic_billing_balance");
    assert.equal((await admin.getById({ id: moving.id })).isEnabled, false);
  `);
});

test("editing and deleting concurrently never revives deleted or pending-delete SNI rules", () => {
  verifySniWrites(String.raw`
    const first = await create("delete-first");
    const second = await create("delete-second");
    const kept = await create("delete-kept");
    await within(Promise.allSettled([
      admin.update({ id: first.id, targetPort: 9443 }),
      admin.delete({ id: first.id }),
      admin.delete({ id: second.id }),
      admin.update({ id: second.id, maxConnections: 5 }),
    ]), "edits and deletes together");
    const visible = (await admin.list()).map(rule => Number(rule.id));
    assert.ok(!visible.includes(first.id));
    assert.ok(!visible.includes(second.id));
    const pending = await create("pending");
    await runtime.executeRaw('UPDATE "forward_rules" SET "pendingDelete" = 1, "isEnabled" = 0 WHERE "id" = ?', [pending.id]);
    await assert.rejects(() => admin.update({ id: pending.id, targetPort: 10443 }), /不存在|删除/);
    await assert.rejects(() => admin.toggle({ id: pending.id, isEnabled: true }), /不存在|删除/);
    assert.equal((await admin.getById({ id: kept.id })).targetPort, 8443);
    await within(settings.setSetting("afterDeleteEdit", "saved"), "write after delete/edit race");
  `);
});

test("returning to a previous entry keeps reused member rules after deferred settlement", () => {
  verifySniWrites(String.raw`
    await addGroup(20, "port", [3]);
    await addGroup(21, "port", [7]);
    const rule = await create("returning", { forwardGroupId: 20 });
    for (const forwardGroupId of [21, 20, 21]) {
      await admin.update({ id: rule.id, forwardGroupId });
      const children = await (await import("./server/repositories/forwardRuleRepository.ts")).getForwardGroupChildRules(forwardGroupId);
      assert.equal(children.filter(child => !child.pendingDelete && child.isEnabled && Number(child.forwardGroupRuleId) === rule.id).length, 1, "saved rule lost its member after returning to " + forwardGroupId);
    }
  `);
});

test("continually changing routes exhaust one retry budget without saving or leaving reservations", () => {
  verifySniWrites(String.raw`
    await addGroup(20, "port", [3]);
    const rule = await create("flapping");
    let native;
    let originalPrepare;
    await runtime.withSqliteExclusive(sqlite => {
      native = sqlite;
      originalPrepare = sqlite.prepare;
      sqlite.prepare = function(sql) {
        const statement = originalPrepare.call(this, sql);
        if (/^select /i.test(sql) && sql.includes('from "forward_group_members"')) {
          const originalAll = statement.all;
          statement.all = function(...params) {
            const rows = originalAll.apply(this, params);
            if (params.includes(20)) originalPrepare.call(native, 'UPDATE "forward_group_members" SET "hostId" = CASE WHEN "hostId" = 3 THEN 5 ELSE 3 END WHERE "groupId" = 20').run();
            return rows;
          };
        }
        return statement;
      };
    });
    try {
      await assert.rejects(() => within(admin.update({ id: rule.id, forwardGroupId: 20 }), "bounded route retries"), /入口配置已变化，请刷新后重试/);
    } finally {
      native.prepare = originalPrepare;
    }
    assert.equal(Number((await admin.getById({ id: rule.id })).forwardGroupId), 10);
    await runtime.executeRaw('UPDATE "forward_group_members" SET "hostId" = 3 WHERE "groupId" = 20');
    await within(admin.update({ id: rule.id, forwardGroupId: 20 }), "legal edit after retry exhaustion");
    assert.equal(Number((await admin.getById({ id: rule.id })).forwardGroupId), 20);
    await within(settings.setSetting("afterFlapping", "saved"), "database after retry exhaustion");
  `);
});

test("a route changed while waiting behind another host write is reread before saving", () => {
  verifySniWrites(String.raw`
    const groups = await import("./server/repositories/forwardGroupRepository.ts");
    const billing = await import("./server/repositories/trafficBillingRepository.ts");
    const savedRules = await import("./server/repositories/forwardRuleRepository.ts");
    const { trafficBillingUserLockKey, withKeyedTaskLock } = await import("./server/keyedTaskLock.ts");
    const { forwardGroupsRouter } = await import("./server/routers/forwardGroups.ts");
    const resources = forwardGroupsRouter.createCaller(context({ id: 1, username: "admin", role: "admin", accountEnabled: true }));
    await addGroup(20, "failover", [3, 4]);
    await addGroup(21, "failover", [7, 8]);
    const blocker = await create("host-blocker");
    const waiting = await create("host-waiter");
    const held = Promise.withResolvers();
    const release = Promise.withResolvers();
    const blockedBilling = withKeyedTaskLock(trafficBillingUserLockKey(1), async () => { held.resolve(); await release.promise; });
    await held.promise;
    const first = admin.update({ id: blocker.id, forwardGroupId: 20 });
    let second;
    try {
      await within((async () => {
        while (Number((await admin.getById({ id: blocker.id })).forwardGroupId) !== 20) await new Promise(resolve => setImmediate(resolve));
      })(), "first host write committed");
      second = admin.update({ id: waiting.id, forwardGroupId: 21 });
      for (let turn = 0; turn < 50; turn++) await new Promise(resolve => setImmediate(resolve));
      await resources.updateFields({ id: 21, members: [{ memberType: "host", hostId: 9, priority: 0 }, { memberType: "host", hostId: 8, priority: 10 }] });
      assert.equal(Number((await admin.getById({ id: waiting.id })).forwardGroupId), 10);
    } finally {
      release.resolve();
      await blockedBilling;
    }
    await within(Promise.all([first, second]), "host writes after route replacement");
    const children = await savedRules.getForwardGroupChildRulesForTemplate(waiting.id);
    assert.deepEqual(children.filter(child => !child.pendingDelete).map(child => Number(child.hostId)).sort(), [8, 9]);
    assert.equal(Number((await admin.getById({ id: waiting.id })).forwardGroupId), 21);
  `);
});

test("unchanged host sets still use the latest chain connection address after resource waiting", () => {
  verifySniWrites(String.raw`
    const groups = await import("./server/repositories/forwardGroupRepository.ts");
    const savedRules = await import("./server/repositories/forwardRuleRepository.ts");
    await addGroup(20, "chain", [3, 4]);
    const rule = await create("latest-route");
    await runtime.executeRaw('UPDATE "hosts" SET "tunnelEntryIp" = ? WHERE "id" = 4', ["192.0.2.44"]);
    const held = Promise.withResolvers();
    const release = Promise.withResolvers();
    const changing = groups.withForwardGroupSyncTransaction(20, async () => {
      await runtime.afterDatabaseCommit(async () => {
        held.resolve();
        await release.promise;
        await runtime.executeRaw('UPDATE "forward_group_members" SET "connectHost" = ? WHERE "groupId" = 20 AND "hostId" = 4', ["192.0.2.44"]);
      });
    });
    await held.promise;
    const editing = admin.update({ id: rule.id, forwardGroupId: 20 });
    for (let turn = 0; turn < 50; turn++) await new Promise(resolve => setImmediate(resolve));
    release.resolve();
    await changing;
    await within(editing, "same hosts with latest route");
    const children = await savedRules.getForwardGroupChildRulesForTemplate(rule.id);
    const entry = children.find(child => !child.pendingDelete && Number(child.hostId) === 3);
    assert.equal(entry.targetIp, "192.0.2.44");
  `);
});

test("known tunnel listeners and incompatible resources still reject SNI sharing", () => {
  verifySniWrites(String.raw`
    await addGroup(20, "port", [3]);
    await insert("tunnels", { id: 40, name: "existing-listener", entryHostId: 11, exitHostId: 3, mode: "tls", listenPort: 443, userId: 1, isEnabled: 1 });
    await assert.rejects(() => create("listener-conflict", { forwardGroupId: 20 }), /占用|used/);
    const existing = await create("resource-owner");
    await addGroup(21, "port", [1]);
    await assert.rejects(() => create("incompatible", { forwardGroupId: 21 }), /占用|used|SNI/);
    assert.equal((await admin.getById({ id: existing.id })).sourcePort, 443);
    const moving = await create("cannot-move");
    await assert.rejects(() => admin.update({ id: moving.id, forwardGroupId: 20 }), /占用|used/);
    assert.equal(Number((await admin.getById({ id: moving.id })).forwardGroupId), 10);
    assert.equal((await admin.getById({ id: moving.id })).sourcePort, 443);
  `);
});

test("direct TLS SNI mapping failure keeps the previous rule and mappings", () => {
  verifySniWrites(String.raw`
    await insert("tunnels", { id: 20, name: "mapped-tunnel", entryHostId: 3, exitHostId: 4, mode: "tls", listenPort: 24020, userId: 1, isEnabled: 1 });
    const route = { forwardType: "gost", tunnelId: 20 };
    const rule = await create("mapping-original", route);
    const before = await admin.getById({ id: rule.id });
    const mappings = await runtime.queryRaw('SELECT * FROM forward_rule_tunnel_exits WHERE ruleId = ?', [rule.id]);
    assert.equal(mappings.length, 0);
    // A retired mapping is valid cleanup input even for a single-exit tunnel.
    await insert("forward_rule_tunnel_exits", { ruleId: rule.id, tunnelId: 20, exitNodeId: 201, exitSeq: 1, exitHostId: 5, tunnelExitPort: 25000 });
    const retiredMappings = await runtime.queryRaw('SELECT * FROM forward_rule_tunnel_exits WHERE ruleId = ?', [rule.id]);
    await runtime.executeRaw('CREATE TRIGGER reject_mapping_save BEFORE DELETE ON forward_rule_tunnel_exits BEGIN SELECT RAISE(ABORT, "simulated mapping save failure"); END');
    await assert.rejects(() => admin.update({ id: rule.id, targetPort: 9443 }), /simulated mapping save failure/);
    assert.equal((await admin.getById({ id: rule.id })).targetPort, before.targetPort);
    assert.deepEqual(await runtime.queryRaw('SELECT * FROM forward_rule_tunnel_exits WHERE ruleId = ?', [rule.id]), retiredMappings);
    await runtime.executeRaw('DROP TRIGGER reject_mapping_save');
    await runtime.executeRaw('CREATE TRIGGER reject_mapping_save BEFORE UPDATE ON tunnels WHEN NEW.id = 20 BEGIN SELECT RAISE(ABORT, "simulated mapping save failure"); END');
    await assert.rejects(() => create("mapping-failed-create", route), /simulated mapping save failure/);
    assert.ok(!(await admin.list()).some(row => row.name === "mapping-failed-create"));
    await runtime.executeRaw('DROP TRIGGER reject_mapping_save');
    await within(admin.update({ id: rule.id, targetPort: 10443 }), "direct save after rollback");
    assert.equal((await admin.getById({ id: rule.id })).targetPort, 10443);
  `);
});

for (const changing of ["tunnel", "entry-group"]) {
  test(changing + " route changes during resource waiting are reread before direct SNI saving", () => {
    verifySniWrites(String.raw`
      const changing = ${JSON.stringify(changing)};
      const { withKeyedTaskLock } = await import("./server/keyedTaskLock.ts");
      const groups = await import("./server/repositories/forwardGroupRepository.ts");
      const { reserveSpecificHostPort } = await import("./server/portReservations.ts");
      await addGroup(30, "entry", [1, 2], { domain: "changing-entry.example.test" });
      await insert("tunnels", { id: 20, name: "changing-tunnel", entryHostId: 3, exitHostId: 4, entryGroupId: changing === "entry-group" ? 30 : null, mode: "tls", listenPort: 24020, userId: 1, isEnabled: 1 });
      const rule = await create("changing-direct");
      const held = Promise.withResolvers();
      const release = Promise.withResolvers();
      const change = (changing === "tunnel"
        ? work => withKeyedTaskLock("tunnel:20", work)
        : work => groups.withForwardGroupSyncLocks([30], work))(async () => {
        held.resolve();
        await release.promise;
        if (changing === "tunnel") await runtime.executeRaw('UPDATE tunnels SET entryHostId = 5 WHERE id = 20');
        else await runtime.executeRaw('UPDATE forward_group_members SET hostId = hostId + 4 WHERE groupId = 30');
      });
      await held.promise;
      const editing = admin.update({ id: rule.id, forwardGroupId: null, forwardType: "gost", tunnelId: 20, sourcePort: 444 });
      try {
        for (let turn = 0; turn < 50; turn++) await new Promise(resolve => setImmediate(resolve));
        const reservation = await reserveSpecificHostPort({ hostId: 3, port: 444, protocol: "tcp", isUsed: async () => false });
        assert.ok(reservation, "resource waiting must precede source-port reservation");
        reservation.release();
        await within(settings.setSetting("directRouteWait", changing), "database during direct route wait");
      } finally {
        release.resolve();
        await change;
      }
      await within(editing, "direct route edit after resource change");
      const saved = await admin.getById({ id: rule.id });
      assert.equal(Number(saved.tunnelId), 20);
      assert.equal(Number(saved.hostId), changing === "tunnel" ? 5 : 3);
      assert.equal(saved.sourcePort, 444);
      for (const hostId of changing === "tunnel" ? [5] : [5, 6]) {
        const result = await heartbeat(hostId);
        assert.ok(result.desiredState.actions.some(action => action.op === "apply" && action.forwardType === "gost-runtime-sync"));
        assert.ok(result.runningRules.some(row => Number(row.ruleId) === rule.id));
      }
    `);
  });
}

test("a rule-triggered DDNS wait releases saving positions and a provider failure keeps committed edits", () => {
  verifySniWrites(String.raw`
    const groups = await import("./server/repositories/forwardGroupRepository.ts");
    const first = await create("dns-first");
    const second = await create("dns-second");
    let testNow = Date.now();
    Date.now = () => testNow;
    const configs = [];
    const localRules = config => config.sniRoutes.map(route => ({ ...route, port: config.listenPort, forwardType: "forwardx", protocol: "tcp", sniRouteVersion: config.sniRouteVersion, sourceAllowIps: [], ready: true }));
    for (const hostId of [1, 2]) {
      const config = splitters(await heartbeat(hostId))[0].fxp;
      configs.push(config);
      await heartbeat(hostId, localRules(config));
    }
    await groups.runForwardGroupFailover(10, { manual: true });
    testNow += 121000;
    for (const [index, hostId] of [1, 2].entries()) await heartbeat(hostId, localRules(configs[index]));
    await groups.runForwardGroupFailover(10, { manual: true });
    await runtime.executeRaw('UPDATE forward_groups SET domain = ? WHERE id = 10', ["slow-dns.example.test"]);
    await settings.setSettings({ ddnsEnabled: "true", ddnsProvider: "webhook", ddnsWebhookUrl: "http://127.0.0.1:" + server.address().port + "/test-ddns", ddnsWebhookMethod: "POST" });
    let concurrentSave;
    let called = false;
    onDns = async () => {
      if (called) return { success: true };
      called = true;
      concurrentSave = admin.update({ id: second.id, maxConnections: 29 });
      await within((async () => {
        while ((await admin.getById({ id: second.id })).maxConnections !== 29) await new Promise(resolve => setImmediate(resolve));
      })(), "same-host rule save before DNS response");
      await within(settings.setSetting("duringRuleDns", "saved"), "database write before DNS response");
      return { success: false, error: "simulated DNS failure" };
    };
    await assert.rejects(() => within(admin.update({ id: first.id, name: "committed-before-dns" }), "rule-triggered DNS"), /simulated DNS failure|503/);
    assert.equal(called, true);
    await within(concurrentSave, "second rule after DNS failure");
    assert.equal((await admin.getById({ id: first.id })).name, "committed-before-dns");
    assert.equal((await admin.getById({ id: second.id })).maxConnections, 29);
  `);
});

for (const operation of ["toggle", "reorder", "delete"]) {
  test("entry group " + operation + " waits until a related SNI save releases its route", () => {
    verifySniWrites(String.raw`
      const operation = ${JSON.stringify(operation)};
      const { forwardGroupsRouter } = await import("./server/routers/forwardGroups.ts");
      const groupApi = forwardGroupsRouter.createCaller(context({ id: 1, username: "admin", role: "admin", accountEnabled: true }));
      const billing = await import("./server/repositories/trafficBillingRepository.ts");
      const savedRules = await import("./server/repositories/forwardRuleRepository.ts");
      const groups = await import("./server/repositories/forwardGroupRepository.ts");
      const { trafficBillingUserLockKey, withKeyedTaskLock } = await import("./server/keyedTaskLock.ts");
      await addGroup(30, "entry", [5, 6], { domain: "protected-entry.example.test" });
      await addGroup(20, "chain", [3, 4], { entryGroupId: 30 });
      const moving = await create("protected-save");
      await billing.setTrafficBillingEnabled(true);
      await billing.upsertTrafficBillingConfig({ resourceType: "forward_group", resourceId: 10, enabled: true, requiresPermission: false, pricePerGbCents: 100, multiplier: 100 });
      for (const child of await savedRules.getForwardGroupChildRulesForTemplate(moving.id)) await billing.billTrafficUsage({ userId: 1, ruleId: child.id, bytes: 268435456, resourceType: "forward_group", resourceId: 10 });
      const held = Promise.withResolvers();
      const release = Promise.withResolvers();
      const blocked = withKeyedTaskLock(trafficBillingUserLockKey(1), async () => { held.resolve(); await release.promise; });
      await held.promise;
      const migration = admin.update({ id: moving.id, forwardGroupId: 20 });
      let change;
      try {
        await within((async () => {
          while (Number((await admin.getById({ id: moving.id })).forwardGroupId) !== 20) await new Promise(resolve => setImmediate(resolve));
        })(), "committed migration awaiting settlement");
        change = operation === "toggle" ? groupApi.toggle({ id: 30, isEnabled: false })
          : operation === "reorder" ? groupApi.reorder({ groupId: 30, memberIds: [3001, 3000] })
          : groupApi.delete({ id: 30, confirmRules: true });
        for (let turn = 0; turn < 50; turn++) await new Promise(resolve => setImmediate(resolve));
        const current = await groups.getForwardGroupById(30);
        assert.ok(current, "entry group was deleted before route saving released");
        assert.equal(current.isEnabled, true, "entry group changed state during route saving");
        assert.equal(current.members.find(member => member.id === 3000).priority, 0, "entry group changed priority during route saving");
        await within(settings.setSetting("protectedSave", operation), "database write during protected saving");
      } finally {
        release.resolve();
        await blocked;
      }
      await within(migration, "protected migration finishes");
      await within(change, "entry group change after route release");
      const current = await groups.getForwardGroupById(30);
      if (operation === "delete") assert.equal(current, undefined);
      else if (operation === "toggle") assert.equal(current.isEnabled, false);
      else assert.equal(current.members.find(member => member.id === 3001).priority, 0);
    `);
  });
}

for (const failedStage of ["settlement", "debt-pause"]) {
  test("SNI chain migration durably retries financial closeout: " + failedStage, () => {
    verifySniWrites(String.raw`
      const rules = await import("./server/repositories/forwardRuleRepository.ts");
      const groups = await import("./server/repositories/forwardGroupRepository.ts");
      const billing = await import("./server/repositories/trafficBillingRepository.ts");
      await addGroup(30, "entry", [1, 2]);
      await addGroup(31, "entry", [5, 6]);
      await addGroup(20, "chain", [3, 4], { entryGroupId: 30 });
      await addGroup(21, "chain", [7, 8], { entryGroupId: 31 });
      const moving = await create("financial-move", { forwardGroupId: 20 });
      const [child] = (await rules.getForwardGroupChildRulesForTemplate(moving.id)).filter(row => !row.pendingDelete);
      assert.ok(child);
      await billing.setTrafficBillingEnabled(true);
      await billing.upsertTrafficBillingConfig({ resourceType: "forward_group", resourceId: 20, enabled: true, requiresPermission: false, pricePerGbCents: 100, multiplier: 100 });
      await runtime.executeRaw('UPDATE users SET balanceCents=1 WHERE id=1');
      await insert("traffic_billing_rule_usage", { id: 91, userId: 1, ruleId: child.id, resourceType: "forward_group", resourceId: 20, totalBytes: 100000000, billedGb: 0, pendingMilliCents: 0, settled: 0 });
      const failedStage = ${JSON.stringify(failedStage)};
      await runtime.executeRaw(failedStage === "settlement"
        ? "CREATE TRIGGER reject_migration_closeout BEFORE UPDATE OF settled ON traffic_billing_rule_usage WHEN OLD.id=91 BEGIN SELECT RAISE(ABORT,'migration-settlement-failure'); END"
        : "CREATE TRIGGER reject_migration_closeout BEFORE UPDATE OF canAddRules ON users WHEN NEW.canAddRules=0 BEGIN SELECT RAISE(ABORT,'migration-debt-pause-failure'); END");
      await assert.rejects(() => admin.update({ id: moving.id, forwardGroupId: 21 }));
      assert.equal(Number((await rules.getForwardRuleById(moving.id)).forwardGroupId), 21, "configuration committed before financial retry");
      const retired = await rules.getForwardRuleById(child.id);
      assert.ok(retired.pendingDelete);
      assert.ok(retired.deleteSettlementPending, "failed route closeout must leave a durable retry obligation");
      await assert.rejects(() => groups.syncForwardGroupRules(20, { preserveRuntime: true }));
      await runtime.executeRaw("DROP TRIGGER reject_migration_closeout");
      await groups.syncForwardGroupRules(20, { preserveRuntime: true });
      assert.equal(Boolean((await rules.getForwardRuleById(child.id)).deleteSettlementPending), false);
      const [user] = await runtime.queryRaw('SELECT balanceCents,canAddRules,forwardAccessPauseReason FROM users WHERE id=1');
      assert.equal(user.balanceCents, -8);
      assert.equal(Boolean(user.canAddRules), false);
      assert.equal(user.forwardAccessPauseReason, "traffic_billing_balance");
      await groups.syncForwardGroupRules(20, { preserveRuntime: true });
      const records = await runtime.queryRaw('SELECT amountCents FROM traffic_billing_records WHERE ruleId=?', [child.id]);
      assert.deepEqual(records.map(row => row.amountCents), [9]);
    `);
  });
}


test("SNI migration financial closeout refreshes the indebted user's unrelated host", () => {
  verifySniWrites(String.raw`
    const { EventEmitter } = await import("node:events");
    const { registerAgentEventClient } = await import("./server/agentEvents.ts");
    const rules = await import("./server/repositories/forwardRuleRepository.ts");
    const billing = await import("./server/repositories/trafficBillingRepository.ts");
    await addGroup(20, "failover", [3, 4]);
    const moving = await create("debt-refresh");
    await admin.create({ hostId: 12, name: "unrelated", sourcePort: 12000, targetIp: "203.0.113.12", targetPort: 80, isEnabled: true });
    const [child] = await rules.getForwardGroupChildRulesForTemplate(moving.id);
    await billing.setTrafficBillingEnabled(true);
    await billing.upsertTrafficBillingConfig({ resourceType: "forward_group", resourceId: 10, enabled: true, requiresPermission: false, pricePerGbCents: 100, multiplier: 100 });
    await runtime.executeRaw('UPDATE users SET balanceCents=1 WHERE id=1');
    await insert("traffic_billing_rule_usage", { id: 91, userId: 1, ruleId: child.id, resourceType: "forward_group", resourceId: 10, totalBytes: 100000000, billedGb: 0, pendingMilliCents: 0, settled: 0 });
    class Response extends EventEmitter {
      frames = [];
      write(value) { this.frames.push(String(value)); return true; }
      end() { this.emit("finish"); }
    }
    const response = new Response();
    const stream = registerAgentEventClient(12, "token-12", response);
    const { decryptPayload } = await import("./server/agentCrypto.ts");
    // The earlier create already requested a refresh. Move past the existing
    // coalescing window in this isolated process, without a wall-clock sleep.
    const actualNow = Date.now;
    Date.now = () => actualNow() + 5000;
    try {
      await admin.update({ id: moving.id, forwardGroupId: 20 });
      const messages = response.frames.map(frame => decryptPayload(JSON.parse(frame.split("data: ")[1].trim()), "token-12"));
      assert.ok(messages.some(message => message.type === "agent-refresh" && message.data.reason === "traffic-billing-delete-balance-negative"),
        "debt suspension must refresh other hosts belonging to the same user");
    } finally { stream.close(); }
  `);
});
