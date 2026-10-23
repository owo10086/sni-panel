import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import mysql from "mysql2/promise";

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
    await runtime.connectDatabase({ type: "mysql", mysql: { ...connection, database } });
    const pool = runtime.getPool()!;
    await ensureDatabaseSchema(pool);
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
