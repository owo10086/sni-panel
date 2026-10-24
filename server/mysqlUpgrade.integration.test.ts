import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import mysql, { type RowDataPacket } from "mysql2/promise";
import { MYSQL_COMPATIBILITY_FLAGS } from "./mysqlCompatibility";

// Opt-in only. Never migrate or clear the database named in the supplied URL:
// all work happens in a unique test database created and dropped by this test.
test("real MySQL upgrades legacy fields without altering business data and cleans a backlog in bounded passes", {
  skip: !process.env.FORWARDX_TEST_MYSQL_URL,
  timeout: 120_000,
}, async () => {
  const url = new URL(process.env.FORWARDX_TEST_MYSQL_URL!);
  const database = `forwardx_upgrade_test_${randomBytes(8).toString("hex")}`;
  assert.match(database, /^forwardx_upgrade_test_[a-f0-9]{16}$/);
  const connection = { host: url.hostname, port: Number(url.port || 3306), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password) };
  const admin = await mysql.createConnection(connection);
  process.env.DATABASE_TYPE = "mysql";
  const runtime = await import("./dbRuntime");
  const { ensureDatabaseSchema, getDatabaseTableDefs } = await import("./dbSchema");
  const { deleteExpiredHistoryRows } = await import("./repositories/historyRetention");
  let created = false;
  try {
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    created = true;
    await runtime.testMysqlConnection({ ...connection, database });
    await runtime.connectDatabase({ type: "mysql", mysql: { ...connection, database } });
    const pool = runtime.getPool()!;
    // Exercise the binary prepared protocol before schema initialization. A
    // text-protocol SELECT/ping alone misses the MySQL 8.0.24 cursor-flag bug.
    const probes = await Promise.all([pool.getConnection(), pool.getConnection()]);
    try {
      for (const probe of probes) {
        for (const value of ["sidebarMenu", "中文 ' ? \\ ; --", ""]) {
          const [rows] = await probe.execute<RowDataPacket[]>({ sql: "SELECT ? AS value", timeout: 5000 }, [value]);
          assert.equal(rows[0].value, value, "prepared parameters must remain bound and round-trip unchanged");
        }
      }
    } finally {
      for (const probe of probes) probe.destroy();
    }
    await ensureDatabaseSchema(pool);
    const [empty] = await pool.execute<RowDataPacket[]>({
      sql: "SELECT value FROM system_settings WHERE `key` = ?", timeout: 5000,
    }, ["forwardx-test-missing-setting"]);
    assert.equal(empty.length, 0, "empty prepared results must also complete");
    await pool.query("INSERT INTO users (id, username, password, role, balanceCents) VALUES (1, 'upgrade-admin', 'test-hash', 'admin', 12345)");
    await pool.query("INSERT INTO hosts (id, name, ip, userId) VALUES (1, 'existing-host', '192.0.2.10', 1)");
    await pool.query("INSERT INTO forward_rules (id, name, hostId, userId, sourcePort, targetIp, targetPort, forwardType) VALUES (1, 'existing-gost-rule', 1, 1, 10000, '198.51.100.10', 25565, 'gost')");
    await pool.query("INSERT INTO payment_orders (id, outTradeNo, userId, provider, paymentType, status, subject, amountCents) VALUES (1, 'existing-paid-order', 1, 'epay', 'alipay', 'completed', 'existing purchase', 1000)");
    const missing: Record<string, string[]> = {
      hosts: ["hostStatusNotifyEnabled"], forward_rules: ["runtimeDiagnostic"], forward_group_members: ["syncDiagnostic"],
      tunnels: ["v3Transport", "v3Host", "v3Path", "v3UserAgent", "v3ServerName", "v3Multiplex"],
      payment_orders: ["merchantIdentity", "failureReason", "lastPaymentCheckAt"],
    };
    await pool.query("ALTER TABLE payment_orders DROP INDEX idx_payment_orders_status_lastPaymentCheckAt");
    for (const [table, columns] of Object.entries(missing)) {
      for (const column of columns) await pool.query(`ALTER TABLE \`${table}\` DROP COLUMN \`${column}\``);
    }
    for (const table of ["operations_traffic_daily", "operations_source_daily", "operations_source_status", "operations_ip_geo"]) {
      await pool.query(`DROP TABLE \`${table}\``);
    }
    const snapshots = new Map<string, unknown>();
    for (const table of ["users", "hosts", "forward_rules", "payment_orders"]) {
      const [rows] = await pool.query(`SELECT * FROM \`${table}\` ORDER BY id`);
      snapshots.set(table, rows);
    }
    await ensureDatabaseSchema(pool);
    await ensureDatabaseSchema(pool);
    for (const [table, before] of snapshots) {
      const [after] = await pool.query<any[]>(`SELECT * FROM \`${table}\` ORDER BY id`);
      for (const row of after) for (const column of missing[table] || []) delete row[column];
      assert.deepEqual(after, before, `${table}: business data must survive both upgrade and restart`);
    }
    for (const definition of getDatabaseTableDefs()) {
      const [rows] = await pool.query<any[]>(`SHOW COLUMNS FROM \`${definition.name}\``);
      assert.deepEqual(new Set(rows.map(row => row.Field)), new Set(definition.columns.map(column => column.name)));
    }
    const [hostDefaults] = await pool.query<any[]>("SELECT hostStatusNotifyEnabled FROM hosts WHERE id = 1");
    assert.equal(Number(hostDefaults[0].hostStatusNotifyEnabled), 1);
    const now = Math.floor(Date.now() / 1000);
    for (let offset = 0; offset < 2501; offset += 500) {
      const rows = Array.from({ length: Math.min(500, 2501 - offset) }, () => [1, 1, 10, 20, 1]);
      await pool.query("INSERT INTO traffic_stats (ruleId, hostId, bytesIn, bytesOut, recordedAt) VALUES ?", [rows]);
    }
    await pool.execute("INSERT INTO traffic_stats (ruleId, hostId, bytesIn, bytesOut, recordedAt) VALUES (?, ?, ?, ?, ?)", [1, 1, 123, 456, now]);
    assert.equal(await deleteExpiredHistoryRows("traffic_stats", "recordedAt", now - 72 * 3600, { maxBatches: 1 }), 2000);
    assert.equal(await deleteExpiredHistoryRows("traffic_stats", "recordedAt", now - 72 * 3600), 501);
    const [remaining] = await pool.query<any[]>("SELECT bytesIn, bytesOut, recordedAt FROM traffic_stats");
    assert.deepEqual(remaining.map(row => [Number(row.bytesIn), Number(row.bytesOut), row.recordedAt]), [[123, 456, now]]);
  } finally {
    await runtime.closeDatabase();
    if (created) await admin.query(`DROP DATABASE \`${database}\``);
    await admin.end();
  }
});

test("real MySQL personal-group writes use committed groups after an older repeatable-read snapshot", {
  skip: !process.env.FORWARDX_TEST_MYSQL_URL,
  timeout: 120_000,
}, async () => {
  const url = new URL(process.env.FORWARDX_TEST_MYSQL_URL!);
  const database = `forwardx_groups_test_${randomBytes(8).toString("hex")}`;
  assert.match(database, /^forwardx_groups_test_[a-f0-9]{16}$/);
  const connection = { host: url.hostname, port: Number(url.port || 3306), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password) };
  const admin = await mysql.createConnection(connection);
  process.env.DATABASE_TYPE = "mysql";
  const runtime = await import("./dbRuntime");
  const { ensureDatabaseSchema } = await import("./dbSchema");
  const groups = await import("./repositories/ruleGroupRepository");
  const rules = await import("./repositories/forwardRuleRepository");
  let created = false;
  try {
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    created = true;
    await runtime.connectDatabase({ type: "mysql", mysql: { ...connection, database } });
    const pool = runtime.getPool()!;
    await ensureDatabaseSchema(pool);
    await runtime.insertAndGetId("users", { id: 1, username: "groups-owner", password: "test-hash" });
    await runtime.insertAndGetId("hosts", { id: 1, userId: 1, name: "groups-host", ip: "192.0.2.10" });
    // Both actors must use RR even if the supplied server has another default.
    const actorConnections = await Promise.all([pool.getConnection(), pool.getConnection()]);
    try {
      await Promise.all(actorConnections.map(actor => actor.query("SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ")));
    } finally { for (const actor of actorConnections) actor.release(); }

    let port = 18000;
    const createRule = (name: string, personalGroupIds: number[]) => rules.createForwardRule({
      userId: 1, hostId: 1, name, sourcePort: port++, targetIp: "198.51.100.10", targetPort: 443,
      forwardType: "gost", protocol: "tcp", isEnabled: false, personalGroupIds,
    });
    for (const scenario of ["create", "batch", "add", "remove"] as const) {
      const removed = (await groups.savePersonalRuleGroup(1, `${scenario}-removed`)).id;
      const kept = (await groups.savePersonalRuleGroup(1, `${scenario}-kept`)).id;
      const existing = await createRule(`${scenario}-existing`, [removed]);
      const connections: number[] = [];
      let snapshotRead!: () => void;
      let resumeWriter!: () => void;
      const snapshotReady = new Promise<void>(resolve => { snapshotRead = resolve; });
      const deletionCommitted = new Promise<void>(resolve => { resumeWriter = resolve; });
      const writer = runtime.withDatabaseTransaction(async () => {
        const [session] = await runtime.queryRaw<{ id: number; isolation: string }>("SELECT CONNECTION_ID() AS id, @@transaction_isolation AS isolation");
        assert.equal(session.isolation, "REPEATABLE-READ");
        connections.push(Number(session.id));
        // Match the outer batch/preflight reads that precede the owner's lock.
        assert.equal((await runtime.queryRaw("SELECT id FROM rule_groups WHERE id = ?", [removed])).length, 1);
        snapshotRead();
        await deletionCommitted;
        assert.equal((await runtime.queryRaw("SELECT id FROM rule_groups WHERE id = ?", [removed])).length, 1, "the old consistent snapshot must still see the deleted group");
        if (scenario === "batch") await createRule(`${scenario}-first`, [kept]);
        if (scenario === "create" || scenario === "batch") await createRule(`${scenario}-new`, [removed]);
        else await groups.moveRulesToPersonalGroups(1, [existing], scenario === "add" ? [kept] : [], scenario);
      }).then(() => ({ ok: true as const }), error => ({ ok: false as const, error }));
      await Promise.race([snapshotReady, writer.then(result => {
        if (!result.ok) throw result.error;
        throw new Error("writer finished before establishing its snapshot");
      })]);
      try {
        await runtime.withDatabaseTransaction(async () => {
          const [session] = await runtime.queryRaw<{ id: number }>("SELECT CONNECTION_ID() AS id");
          connections.push(Number(session.id));
          await groups.deletePersonalRuleGroup(1, removed);
        });
        assert.notEqual(connections[0], connections[1], "the deletion must commit on a second connection while the writer's transaction remains open");
      } finally { resumeWriter(); }
      const outcome = await writer;
      if (scenario === "create" || scenario === "batch") {
        assert.equal(outcome.ok, false, `${scenario}: a deleted group must reject the complete write`);
        if (!outcome.ok) assert.equal(outcome.error.code, "NOT_FOUND");
        assert.equal((await runtime.queryRaw("SELECT id FROM forward_rules WHERE name IN (?, ?)", [`${scenario}-first`, `${scenario}-new`])).length, 0, "the outer transaction must also roll back earlier batch items");
      } else {
        if (!outcome.ok) throw outcome.error;
        const memberships = await runtime.queryRaw<{ groupId: number }>("SELECT groupId FROM rule_group_members WHERE ruleId = ? ORDER BY groupId", [existing]);
        assert.deepEqual(memberships.map(row => Number(row.groupId)), scenario === "add" ? [kept] : [], `${scenario}: existing memberships must be read after the deletion, not recreated from the old snapshot`);
      }
      const [orphans] = await runtime.queryRaw<{ count: number }>("SELECT COUNT(*) AS count FROM rule_group_members m LEFT JOIN rule_groups g ON g.id = m.groupId WHERE g.id IS NULL");
      assert.equal(Number(orphans.count), 0, `${scenario}: no orphan group memberships may survive`);
    }
  } finally {
    await runtime.closeDatabase();
    if (created) await admin.query(`DROP DATABASE \`${database}\``);
    await admin.end();
  }
});

test("real MySQL personal-group transactions recover from cross-owner empty-range deadlocks", {
  skip: !process.env.FORWARDX_TEST_MYSQL_URL,
  timeout: 120_000,
}, async () => {
  const url = new URL(process.env.FORWARDX_TEST_MYSQL_URL!);
  const database = `forwardx_groups_retry_test_${randomBytes(8).toString("hex")}`;
  assert.match(database, /^forwardx_groups_retry_test_[a-f0-9]{16}$/);
  const connection = { host: url.hostname, port: Number(url.port || 3306), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password) };
  const admin = await mysql.createConnection(connection);
  process.env.DATABASE_TYPE = "mysql";
  const runtime = await import("./dbRuntime");
  const { ensureDatabaseSchema } = await import("./dbSchema");
  const groups = await import("./repositories/ruleGroupRepository");
  let created = false;
  try {
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    created = true;
    await runtime.connectDatabase({ type: "mysql", mysql: { ...connection, database } });
    const pool = runtime.getPool()!;
    await ensureDatabaseSchema(pool);
    for (const id of [1, 2]) {
      await runtime.insertAndGetId("users", { id, username: `retry-owner-${id}`, password: "test-hash" });
      await runtime.insertAndGetId("hosts", { id, userId: id, name: `retry-host-${id}`, ip: `192.0.2.${id}` });
      await runtime.insertAndGetId("forward_rules", { id, userId: id, hostId: id, name: `retry-rule-${id}`, sourcePort: 18000 + id, targetIp: "198.51.100.10", targetPort: 443 });
    }
    const actorConnections = await Promise.all([pool.getConnection(), pool.getConnection()]);
    try {
      await Promise.all(actorConnections.map(actor => actor.query("SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ")));
    } finally { for (const actor of actorConnections) actor.release(); }

    const groupIds: number[] = [];
    for (const phase of ["first-group", "first-membership"] as const) {
      let readers = 0;
      let release!: () => void;
      const ready = new Promise<void>(resolve => { release = resolve; });
      const attempts = [0, 0];
      const committed: number[] = [];
      await Promise.all([1, 2].map(userId => groups.withPersonalRuleGroupLock(userId, async () => {
        attempts[userId - 1]++;
        // Establish the real InnoDB empty-range conflict before either insert.
        if (phase === "first-group") await runtime.queryRaw("SELECT id FROM rule_groups WHERE userId = ? FOR UPDATE", [userId]);
        else await groups.getRulePersonalGroupIds(userId, [userId], { forWrite: true });
        await runtime.executeRaw("UPDATE hosts SET sortOrder = sortOrder + 1 WHERE id = ?", [userId]);
        await runtime.afterDatabaseCommit(() => { committed.push(userId); });
        if (++readers === 2) release();
        await ready;
        if (phase === "first-group") groupIds[userId - 1] = (await groups.savePersonalRuleGroup(userId, `first-${userId}`)).id;
        else await groups.moveRulesToPersonalGroups(userId, [userId], [groupIds[userId - 1]], "add");
      })));
      assert.ok(attempts[0] + attempts[1] >= 3, `${phase}: the fixture must force a real whole-transaction retry`);
      assert.deepEqual(committed.sort(), [1, 2], "rolled-back attempts must discard their post-commit work");
      for (const userId of [1, 2]) {
        const data = await groups.getPersonalRuleGroups(userId);
        assert.deepEqual(data.groups.map(group => [group.name, group.sortOrder, group.count]), [[`first-${userId}`, 0, phase === "first-group" ? 0 : 1]]);
        const [host] = await runtime.queryRaw<{ sortOrder: number }>("SELECT sortOrder FROM hosts WHERE id = ?", [userId]);
        assert.equal(Number(host.sortOrder), phase === "first-group" ? 1 : 2, "each complete transaction commits its earlier writes exactly once");
      }
    }
    // Nested callers cannot retry only group work after InnoDB aborts the outer
    // transaction: the original batch must fail and roll back all prior work.
    let nestedAttempts = 0;
    await assert.rejects(runtime.withDatabaseTransaction(async () => {
      await runtime.executeRaw("UPDATE hosts SET sortOrder = 99 WHERE id = 1");
      await groups.withPersonalRuleGroupLock(1, async () => {
        nestedAttempts++;
        throw Object.assign(new Error("nested-deadlock-fixture"), { code: "ER_LOCK_DEADLOCK", errno: 1213 });
      });
    }), { code: "ER_LOCK_DEADLOCK" });
    assert.equal(nestedAttempts, 1, "only the owner of the complete transaction can retry");
    const [unchanged] = await runtime.queryRaw<{ sortOrder: number }>("SELECT sortOrder FROM hosts WHERE id = 1");
    assert.equal(Number(unchanged.sortOrder), 2);

    // A deadlock after the new group's ID has been allocated must rerun creation,
    // not try to edit the rolled-back ID retained in a previous callback closure.
    await pool.query("CREATE TABLE retry_once (userId INT PRIMARY KEY) ENGINE=MEMORY");
    await pool.query(`CREATE TRIGGER reject_first_membership BEFORE INSERT ON rule_group_members FOR EACH ROW BEGIN
      IF (SELECT name FROM rule_groups WHERE id = NEW.groupId) = 'with-member' THEN
        INSERT IGNORE INTO retry_once (userId) VALUES (NEW.userId);
        IF ROW_COUNT() = 1 THEN SIGNAL SQLSTATE '40001' SET MYSQL_ERRNO = 1213, MESSAGE_TEXT = 'after-group-insert-deadlock'; END IF;
      END IF;
    END`);
    const withMember = await groups.savePersonalRuleGroup(1, "with-member", undefined, { addRuleIds: [1], removeRuleIds: [] });
    assert.deepEqual((await groups.getRulePersonalGroupIds(1, [1])).get(1), [groupIds[0], withMember.id]);
    assert.equal((await groups.getPersonalRuleGroups(1)).groups.filter(group => group.name === "with-member").length, 1);
    await pool.query("DROP TRIGGER reject_first_membership");

    let failedAttempts = 0;
    await assert.rejects(groups.withPersonalRuleGroupLock(1, async () => {
      failedAttempts++;
      await runtime.executeRaw("UPDATE hosts SET sortOrder = 99 WHERE id = 1");
      throw Object.assign(new Error("persistent-deadlock-fixture"), { code: "ER_LOCK_DEADLOCK", errno: 1213 });
    }), /persistent-deadlock-fixture/);
    assert.equal(failedAttempts, 3, "persistent deadlocks must stop after three complete attempts");
    const [afterFailure] = await runtime.queryRaw<{ sortOrder: number }>("SELECT sortOrder FROM hosts WHERE id = 1");
    assert.equal(Number(afterFailure.sortOrder), 2);
    let businessAttempts = 0;
    await assert.rejects(groups.withPersonalRuleGroupLock(1, async () => {
      businessAttempts++;
      await groups.assertPersonalRuleGroups(1, [0], { forWrite: true });
    }), { code: "NOT_FOUND" });
    assert.equal(businessAttempts, 1, "business validation failures must never retry");
    let committedAttempts = 0;
    await assert.rejects(groups.withPersonalRuleGroupLock(1, async () => {
      committedAttempts++;
      await runtime.executeRaw("UPDATE hosts SET sortOrder = sortOrder + 1 WHERE id = 1");
      await runtime.afterDatabaseCommit(() => { throw Object.assign(new Error("after-commit-deadlock-fixture"), { code: "ER_LOCK_DEADLOCK", errno: 1213 }); });
    }), /after-commit-deadlock-fixture/);
    assert.equal(committedAttempts, 1, "a post-commit failure must never rerun committed writes");
    const [committedHost] = await runtime.queryRaw<{ sortOrder: number }>("SELECT sortOrder FROM hosts WHERE id = 1");
    assert.equal(Number(committedHost.sortOrder), 3);
  } finally {
    await runtime.closeDatabase();
    if (created) await admin.query(`DROP DATABASE \`${database}\``);
    await admin.end();
  }
});

test("real MySQL inventory enforces current capacity after stale snapshots and serializes competing buyers", {
  skip: !process.env.FORWARDX_TEST_MYSQL_URL, timeout: 120_000,
}, async () => {
  const url = new URL(process.env.FORWARDX_TEST_MYSQL_URL!);
  const database = `forwardx_stock_test_${randomBytes(8).toString("hex")}`;
  const connection = { host: url.hostname, port: Number(url.port || 3306), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), flags: MYSQL_COMPATIBILITY_FLAGS };
  const admin = await mysql.createConnection(connection);
  process.env.DATABASE_TYPE = "mysql";
  const runtime = await import("./dbRuntime");
  const billing = await import("./repositories/billingRepository");
  const rules = await import("./repositories/forwardRuleRepository");
  const stock = await import("./repositories/productStockRepository");
  let created = false;
  try {
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    created = true;
    await runtime.connectDatabase({ type: "mysql", mysql: { ...connection, database } });
    await (await import("./dbSchema")).ensureDatabaseSchema(runtime.getPool()!);
    const actors = await Promise.all([runtime.getPool()!.getConnection(), runtime.getPool()!.getConnection()]);
    try { await Promise.all(actors.map(actor => actor.query("SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ"))); }
    finally { actors.forEach(actor => actor.release()); }
    for (const id of [1, 2]) await runtime.insertAndGetId("users", { id, username: `stock-${id}`, password: "fixture", balanceCents: 1000 });
    await runtime.insertAndGetId("hosts", { id: 1, name: "stock-host", ip: "192.0.2.1", userId: 1 });
    await (await import("./repositories/settingsRepository")).setSetting("trafficBillingEnabled", "true");
    const configId = await runtime.insertAndGetId("traffic_billing_configs", { resourceType: "host", resourceId: 1, enabled: true, stockLimit: 1, maxRulesPerUser: 2 });
    const createRule = (userId: number, port: number) => rules.createForwardRule({ hostId: 1, userId, name: "stock", forwardType: "realm", protocol: "tcp", sourcePort: port, targetIp: "198.51.100.1", targetPort: 443, isEnabled: false });
    const compete = async (userIds: number[]) => {
      let readers = 0;
      let release!: () => void;
      const ready = new Promise<void>(resolve => { release = resolve; });
      return Promise.allSettled(userIds.map((userId, index) => runtime.withDatabaseTransaction(async () => {
        // Both actors establish RR snapshots before either product lock is held.
        await runtime.queryRaw("SELECT id FROM forward_rules");
        if (++readers === userIds.length) release();
        await ready;
        return createRule(userId, 20000 + index);
      })));
    };
    const buyers = await compete([1, 2]);
    assert.equal(buyers.filter(result => result.status === "fulfilled").length, 1);
    const rejected = buyers.find(result => result.status === "rejected");
    assert.match(String(rejected?.reason), /库存/);
    assert.equal((await stock.getTrafficStockUsage()).get(configId), 1);
    const winner = buyers.find(result => result.status === "fulfilled")!;
    const owner = Number((await rules.getForwardRuleById(winner.value))!.userId);
    await runtime.executeRaw("UPDATE traffic_billing_configs SET stockLimit = 0 WHERE id = ?", [configId]);
    const sameOwner = await compete([owner, owner]);
    assert.equal(sameOwner.filter(result => result.status === "fulfilled").length, 1);
    assert.match(String(sameOwner.find(result => result.status === "rejected")?.reason), /单用户规则上限/);
    assert.equal((await stock.getTrafficRuleUsageForUser(owner)).get(configId), 2);
    const otherOwner = owner === 1 ? 2 : 1;
    await runtime.executeRaw("UPDATE traffic_billing_configs SET stockLimit = 1 WHERE id = ?", [configId]);
    const child = await rules.createForwardRule({ hostId: 1, userId: otherOwner, name: "managed-stock", forwardType: "realm", protocol: "tcp", sourcePort: 20010, targetIp: "198.51.100.1", targetPort: 443, forwardGroupRuleId: winner.value, forwardGroupMemberId: 1 });
    await rules.updateForwardRule(child, { hostId: 1, userId: otherOwner, forwardGroupRuleId: winner.value, targetPort: 8443 });
    assert.equal((await stock.getTrafficRuleUsageForUser(otherOwner)).get(configId), undefined);
    await assert.rejects(() => rules.updateForwardRule(child, { forwardGroupRuleId: null, forwardGroupMemberId: null }), /库存/);
    await assert.rejects(() => rules.updateForwardRule(child, { userId: owner, forwardGroupRuleId: null, forwardGroupMemberId: null }), /单用户规则上限/);
    assert.equal(Number((await rules.getForwardRuleById(child))!.userId), otherOwner);
    await runtime.executeRaw("UPDATE traffic_billing_configs SET stockLimit = 2 WHERE id = ?", [configId]);
    await rules.updateForwardRule(child, { forwardGroupRuleId: null, forwardGroupMemberId: null });
    assert.equal((await stock.getTrafficStockUsage()).get(configId), 2);
    await rules.updateForwardRule(child, { forwardGroupMemberId: 1 });
    assert.equal((await stock.getTrafficStockUsage()).get(configId), 1);
    await rules.updateForwardRule(child, { forwardGroupMemberId: null });
    assert.equal((await stock.getTrafficStockUsage()).get(configId), 2);
    const planId = await runtime.insertAndGetId("subscription_plans", { name: "limited", stockLimit: 1 });
    const orders = await Promise.allSettled([1, 2].map(userId => billing.createPaymentOrder({ outTradeNo: `stock-${userId}`, userId, provider: "stripe", paymentType: "stripe", subject: "stock", amountCents: 100, planId, orderType: "plan" })));
    assert.equal(orders.filter(result => result.status === "fulfilled").length, 1);
    assert.match(String(orders.find(result => result.status === "rejected")?.reason), /库存/);
    assert.equal(Number((await billing.getSubscriptionPlanById(planId))!.stockUsed), 1);
    const pending = orders.find(result => result.status === "fulfilled")!.value!;
    await Promise.all([billing.updatePaymentOrder(pending.outTradeNo, { status: "cancelled" }), billing.updatePaymentOrder(pending.outTradeNo, { status: "expired" })]);
    assert.equal(Number((await billing.getSubscriptionPlanById(planId))!.stockUsed), 0);
  } finally {
    await runtime.closeDatabase();
    if (created) await admin.query(`DROP DATABASE \`${database}\``);
    await admin.end();
  }
});
