import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("SNI category isolates every resource, pages whole groups, and scopes counts, summaries and ordering", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-sni-category-"));
  const script = String.raw`
    import assert from "node:assert/strict";
    import * as runtime from "./server/dbRuntime.ts";
    import { ensureDatabaseSchema } from "./server/dbSchema.ts";
    import * as rules from "./server/repositories/forwardRuleRepository.ts";
    import { rulesRouter } from "./server/routers/rules.ts";
    const insert = (table, values) => runtime.executeRaw(
      'INSERT INTO "' + table + '" (' + Object.keys(values).map(k => '"' + k + '"').join(',') + ') VALUES (' + Object.keys(values).map(() => '?').join(',') + ')', Object.values(values));
    const caller = (id, role) => rulesRouter.createCaller({ req: { headers: {} }, res: { clearCookie() {} },
      user: { id, username: 'user-' + id, role, accountEnabled: true }, authSession: null, authFailureReason: null });
    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await ensureDatabaseSchema();
      for (const id of [1, 2]) await insert('users', { id, username: 'user-' + id, password: 'x', role: id === 1 ? 'admin' : 'user' });
      for (const id of [1, 2]) await insert('hosts', { id, name: 'host-' + id, ip: '192.0.2.' + id, userId: 1 });
      for (const [id, mode] of [[10, 'port'], [11, 'chain'], [12, 'failover']]) {
        await insert('forward_groups', { id, name: 'resource-' + id, groupType: 'host', groupMode: mode, forwardType: 'nftables', targetIp: '0.0.0.0', targetPort: 1, userId: 1 });
      }
      await insert('tunnels', { id: 20, name: 'direct-tunnel', entryHostId: 1, exitHostId: 2, listenPort: 24000, userId: 1, mode: 'tls' });
      const fixtures = [
        [1, 10, null, null, 1], [2, null, 20, '', 1], [3, 11, null, null, 1], [4, 12, null, '   ', 1],
        [101, 10, null, 'port-a.example', 1], [102, null, 20, 'tunnel.example', 1],
        [103, 11, null, 'chain.example', 1], [104, 12, null, 'group.example', 1],
        [105, 10, null, 'port-b.example', 1], [201, 12, null, 'other.example', 2],
      ];
      for (const [index, [id, groupId, tunnelId, sni, userId]] of fixtures.entries()) {
        await insert('forward_rules', { id, name: 'rule-' + id, hostId: 1, forwardGroupId: groupId, tunnelId,
          isForwardGroupTemplate: groupId ? 1 : 0, forwardType: tunnelId ? 'gost' : 'nftables',
          protocol: 'tcp', sourcePort: sni && sni.trim() ? 443 : 10000 + id, targetIp: '203.0.113.1', targetPort: 443,
          sni, userId, isEnabled: 1, pendingDelete: 0, sortOrder: index });
      }
      await insert('forward_rules', { id: 301, hostId: 1, name: 'managed-child', forwardGroupId: 10, forwardGroupRuleId: 101,
        sni: 'child.example', sourcePort: 443, targetIp: '203.0.113.1', targetPort: 443, userId: 1 });
      await insert('forward_rules', { id: 302, hostId: 1, name: 'pending-delete', forwardGroupId: 10,
        sni: 'deleted.example', sourcePort: 443, targetIp: '203.0.113.1', targetPort: 443, userId: 1, pendingDelete: 1 });
      for (const id of [2,102,201]) {
        await insert('forward_rule_traffic_counters', { ruleId:id,hostId:1,userId:id === 201 ? 2 : 1,bytesIn:id*10,bytesOut:id*20,connections:id });
        await insert('traffic_stats', { ruleId:id,hostId:1,bytesIn:id,bytesOut:id*2,connections:1,recordedAt:Math.floor(Date.now()/1000) });
      }
      const admin = caller(1, 'admin');
      const input = { page: 1, pageSize: 1, category: 'sni' };
      const page = await admin.listPage(input);
      assert.deepEqual(page.categoryCounts, { all: 4, local: 1, tunnel: 1, chain: 1, group: 1, sni: 5 });
      assert.equal(page.totalItems, 4, 'four SNI display groups');
      assert.equal(page.ruleTotalItems, 5, 'badge counts logical rules');
      assert.deepEqual(page.items.map(r => r.id), [101, 105], 'a group stays whole even at size 1');
      const second = await admin.listPage({ ...input, page: 2 });
      assert.deepEqual(second.items.map(r => r.id), [102]);
      assert.equal(second.ruleStartIndex, 2, 'sort offset counts rules in preceding whole groups');
      assert.deepEqual((await admin.listPage({ ...input, category: 'all', pageSize: 20 })).items.map(r => r.id), [3, 4, 1, 2]);
      for (const [category, id] of [['local', 1], ['tunnel', 2], ['chain', 3], ['group', 4]]) {
        assert.deepEqual((await admin.listPage({ ...input, category, pageSize: 20 })).items.map(r => r.id), [id]);
      }
      assert.deepEqual((await admin.listPage({ ...input, resourceType: 'local' })).items.map(r => r.id), [101, 105]);
      assert.deepEqual((await admin.listPage({ ...input, resourceType: 'tunnel', resourceId: 20 })).items.map(r => r.id), [102]);
      assert.equal((await admin.listPage({ ...input, resourceType: 'group', resourceId: 10 })).totalItems, 0);
      const search = await admin.listPage({ ...input, search: 'port-b.example' });
      assert.deepEqual(search.items.map(r => r.id), [105]);
      assert.equal(search.categoryCounts.all, 0);
      assert.equal(search.categoryCounts.sni, 1);
      assert.equal((await admin.listPage({ ...input, category: 'all', search: 'port-b.example' })).totalItems, 0);
      const map = await admin.mapItems({ category: 'sni', limit: 20 });
      assert.deepEqual(map.items.map(r => r.id).sort((a,b) => a-b), [101,102,103,104,105]);
      const ordinaryMap = await admin.mapItems({ category: 'all', limit: 20 });
      assert.deepEqual(ordinaryMap.items.map(r => r.id).sort((a,b) => a-b), [1,2,3,4]);
      const selected = await rules.getForwardRuleSummarySelection({ ownerUserId: 1, category: 'sni' });
      assert.deepEqual(selected.ruleIds.sort((a,b) => a-b), [101,102,103,104,105]);
      assert.equal((await admin.listSummary({ category: 'sni' })).activeItems, 5);
      assert.equal((await admin.listSummary({ category: 'all' })).activeItems, 4);
      const sniSummary = await admin.listSummary({ category: 'sni' });
      assert.deepEqual(sniSummary.totalTraffic, {bytesIn:1020,bytesOut:2040,connections:102});
      assert.deepEqual(sniSummary.dailyTraffic, {bytesIn:102,bytesOut:204,connections:1});
      const plainSummary = await admin.listSummary({ category: 'all' });
      assert.deepEqual(plainSummary.totalTraffic, {bytesIn:20,bytesOut:40,connections:2});
      assert.deepEqual(plainSummary.dailyTraffic, {bytesIn:2,bytesOut:4,connections:1});
      assert.deepEqual((await admin.listSummary({ category:'sni',search:'absent.example' })).totalTraffic, {bytesIn:0,bytesOut:0,connections:0});
      assert.equal((await admin.listPage({ ...input, scope: 'all' })).categoryCounts.sni, 6);
      const other = caller(2, 'user');
      assert.deepEqual((await other.listPage({ ...input, scope: 'all', userId: 1 })).items.map(r => r.id), [201]);
      await assert.rejects(() => other.sniEntryPortOverview(), error => error.code === 'FORBIDDEN');
      // Exercise the normal backend write boundary so cached pages are invalidated.
      await rules.updateForwardRule(201, { adminManaged: true });
      const managedPage = await other.listPage(input);
      assert.equal(managedPage.hasAdminManagedRules,true);
      assert.equal(managedPage.items[0].adminManaged,true);
      await assert.rejects(() => other.reorder({category:'sni',ids:[201]}), /仅可查看/);

      const before = await runtime.queryRaw('SELECT id, sortOrder FROM forward_rules WHERE id IN (1,2,3,4,201) ORDER BY id');
      await admin.reorder({ category: 'sni', ids: [104], startIndex: 0 });
      assert.deepEqual((await admin.listPage({ ...input })).items.map(r => r.id), [104]);
      assert.deepEqual((await admin.listPage({ ...input, page: 2 })).items.map(r => r.id), [101,105]);
      const after = await runtime.queryRaw('SELECT id, sortOrder FROM forward_rules WHERE id IN (1,2,3,4,201) ORDER BY id');
      assert.deepEqual(after, before, 'SNI ordering does not renumber ordinary or foreign rules');
      await assert.rejects(() => admin.reorder({ category: 'group', ids: [104] }), /类型不一致/);
      await assert.rejects(() => admin.reorder({ category: 'sni', ids: [101,201] }), /所属用户不一致/);
    } finally { await runtime.closeDatabase(); }
  `;
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(), encoding: "utf8", timeout: 60_000,
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "category.db"), FORWARDX_LOG_DIR: path.join(directory, "logs") },
    });
    assert.equal(result.status, 0, result.error?.message || result.stderr + result.stdout);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
