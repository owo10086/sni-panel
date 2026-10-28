import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import mysql from "mysql2/promise";
import pg from "pg";
import express from "express";
import { MYSQL_COMPATIBILITY_FLAGS } from "./mysqlCompatibility";

// Run PostgreSQL in a separate Node process: Drizzle chooses its dialect once
// when imported. MySQL's existing upgrade gate imports this file as well.
const kind = process.env.DATABASE_TYPE === "postgresql" ? "postgresql" : "mysql";
const label = kind === "mysql" ? "MySQL" : "PostgreSQL";
const testUrl = kind === "mysql" ? process.env.FORWARDX_TEST_MYSQL_URL : process.env.FORWARDX_TEST_POSTGRES_URL;
type Runtime = typeof import("./dbRuntime");
const configurationDirectory = testUrl ? mkdtempSync(join(tmpdir(), "forwardx-compat-config-")) : undefined;
if (configurationDirectory) {
  // Migration entry points reconnect from the saved configuration. Keep that
  // configuration private to this test process, never the real panel's file.
  process.env.DATABASE_TYPE = kind;
  process.env.DATABASE_CONFIG_PATH = join(configurationDirectory, "database.json");
  process.env.MYSQL_CONFIG_PATH = join(configurationDirectory, "mysql.json");
  after(() => { rmSync(configurationDirectory, { recursive: true, force: true }); });
}

// The supplied database is used only to create/drop a randomly named fixture.
// Never initialize, migrate or clear tables in the supplied database itself.
async function isolatedDatabase(work: (runtime: Runtime, reconnect: () => Promise<unknown>) => Promise<void>) {
  const url = new URL(testUrl!);
  const database = `forwardx_compat_test_${randomBytes(8).toString("hex")}`;
  assert.match(database, /^forwardx_compat_test_[a-f0-9]{16}$/);
  const connection = {
    host: url.hostname, port: Number(url.port || (kind === "mysql" ? 3306 : 5432)),
    user: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
  };
  let executeAdmin: (sql: string) => Promise<unknown>;
  let closeAdmin: () => Promise<void>;
  if (kind === "mysql") {
    const admin = await mysql.createConnection({ ...connection, flags: MYSQL_COMPATIBILITY_FLAGS });
    executeAdmin = sql => admin.query(sql);
    closeAdmin = () => admin.end();
  } else {
    const admin = new pg.Client({ ...connection, database: decodeURIComponent(url.pathname.slice(1)) || "postgres" });
    await admin.connect();
    executeAdmin = sql => admin.query(sql);
    closeAdmin = () => admin.end();
  }
  let runtime: Runtime | undefined;
  let created = false;
  const quoted = kind === "mysql" ? `\`${database}\`` : `"${database}"`;
  try {
    await executeAdmin(`CREATE DATABASE ${quoted}${kind === "mysql" ? " CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci" : ""}`);
    created = true;
    process.env.DATABASE_TYPE = kind;
    runtime = await import("./dbRuntime");
    const config = kind === "mysql"
      ? { type: "mysql" as const, mysql: { ...connection, database } }
      : { type: "postgresql" as const, postgresql: { ...connection, database } };
    runtime.writeDatabaseConfig(config);
    const saved = runtime.readDatabaseConfig();
    assert.equal(saved?.type, kind);
    assert.equal(saved?.type === "mysql" ? saved.mysql.database : saved?.type === "postgresql" ? saved.postgresql.database : undefined, database, "environment overrides must never redirect migration to another database");
    const reconnect = () => runtime!.connectDatabase(config);
    await reconnect();
    await (await import("./dbSchema")).ensureDatabaseSchema();
    await work(runtime, reconnect);
  } finally {
    try { await runtime?.closeDatabase(); }
    finally {
      try { if (created) await executeAdmin(`DROP DATABASE ${quoted}`); }
      finally { await closeAdmin(); }
    }
  }
}

test(`real ${label} 290-292 schema creates and upgrades new state without changing core data or ADR-0010 handoffs`, {
  skip: !testUrl, timeout: 120_000,
}, async () => isolatedDatabase(async (runtime, reconnect) => {
  const schema = await import("./dbSchema");
  const q = runtime.quoteDbIdentifier;
  const additions = ["agent_installations", "resource_traffic_baselines", "resource_alert_service_state"];
  for (const table of additions) {
    assert.deepEqual(await runtime.queryRaw(`SELECT * FROM ${q(table)}`), [], `${table} must exist on a new installation`);
  }
  await runtime.insertAndGetId("users", { id: 1, username: "compat-owner", password: "fixture", role: "admin", balanceCents: 12345, trafficUsed: 5678 });
  await runtime.insertAndGetId("hosts", { id: 1, name: "compat-host", ip: "192.0.2.1", userId: 1 });
  await runtime.insertAndGetId("forward_groups", { id: 1, name: "compat-failover", targetIp: "198.51.100.1", userId: 1, activeMemberId: 1, manualTakeoverMemberId: 2, manualTakeoverToken: "preserve-handoff", lastDdnsTtl: 120 });
  await runtime.insertAndGetId("forward_group_members", { id: 1, groupId: 1, memberType: "host", hostId: 1, failureSince: 1700000010, healthySince: 1700000020 });
  await runtime.insertAndGetId("forward_rules", { id: 1, name: "compat-rule", hostId: 1, userId: 1, sourcePort: 18001, targetIp: "198.51.100.1", targetPort: 443, sni: "keep.example", forwardGroupId: 1, forwardGroupMemberId: 1 });
  await runtime.insertAndGetId("forward_group_retirements", { id: 1, groupId: 1, memberId: 1, hostId: 1, ruleIds: "[1]", provider: "fixture", domain: "keep.example", recordType: "A", oldValue: "192.0.2.1", startedAt: 1700000000000, fallbackDeadlineAt: 1700000600000, oldTtl: 120, switchedAt: 1700000010000, switchTtl: 120, retireAt: 1700000130000, state: "switched" });
  await runtime.insertAndGetId("subscription_plans", { id: 1, name: "compat-stock", stockLimit: 7, stockUsed: 3, priceCents: 100 });
  await runtime.insertAndGetId("payment_orders", { id: 1, outTradeNo: "compat-paid", userId: 1, provider: "fixture", paymentType: "fixture", status: "completed", subject: "keep", amountCents: 100, planId: 1 });
  await runtime.insertAndGetId("balance_transactions", { id: 1, userId: 1, type: "traffic_billing", amountCents: -100, balanceAfterCents: 12345, description: "keep" });
  await runtime.insertAndGetId("traffic_billing_usage", { id: 1, userId: 1, resourceType: "host", resourceId: 1, totalBytes: 1073741824, billedGb: 1 });
  await runtime.insertAndGetId("traffic_stats", { id: 1, ruleId: 1, hostId: 1, bytesIn: 123, bytesOut: 456, recordedAt: 1700000000 });
  await runtime.insertAndGetId("operations_alert_state", { id: 1, hostId: 1, metric: "cpu", phase: "active", since: 1700000000, lastSeen: 1700000010, peak: 91 });
  await runtime.insertAndGetId("operations_alert_events", { id: 1, hostId: 1, hostName: "compat-host", metric: "cpu", type: "alert", value: 91, createdAt: 1700000000 });
  await runtime.insertAndGetId("host_probe_health", { id: 1, serviceId: 1, hostId: 1, config: "{}", hookCiphertext: "fixture-only", state: '{"phase":"pending"}', updatedAt: 1700000000 });
  const coreTables = ["users", "hosts", "forward_groups", "forward_group_members", "forward_rules", "forward_group_retirements", "subscription_plans", "payment_orders", "balance_transactions", "traffic_billing_usage", "traffic_stats", "operations_alert_state", "operations_alert_events", "host_probe_health"];
  const snapshot = async () => {
    const rows: Record<string, unknown> = {};
    for (const table of coreTables) rows[table] = await runtime.queryRaw(`SELECT * FROM ${q(table)} ORDER BY ${q("id")}`);
    return rows;
  };
  const before = await snapshot();
  for (const table of additions) await runtime.executeRaw(`DROP TABLE ${q(table)}`);
  await runtime.executeRaw(`ALTER TABLE ${q("hosts")} DROP COLUMN ${q("agentInstallationId")}`);
  for (const column of ["serviceId", "serviceName"]) await runtime.executeRaw(`ALTER TABLE ${q("operations_alert_events")} DROP COLUMN ${q(column)}`);
  await schema.ensureDatabaseSchema();
  await schema.ensureDatabaseSchema();
  assert.deepEqual(await snapshot(), before, "upgrade and repeat initialization preserve accounts, runtime, stock, charges, history and pending handoffs");
  assert.equal((await runtime.queryRaw<any>(`SELECT ${q("agentInstallationId")} FROM ${q("hosts")} WHERE ${q("id")} = 1`))[0].agentInstallationId, null, "legacy hosts remain unbound after panel-only upgrade");
  const state = {
    agent_installations: { hostId: 1, installationId: "a".repeat(64), createdAt: 1700000000 },
    resource_traffic_baselines: { groupId: 1, ruleId: 1, hostId: 1, bytesIn: 4294967297, bytesOut: 8589934593, dailyIn: 123, dailyOut: 456, resetDay: 1700000000, resetAt: 1700000100 },
    resource_alert_service_state: { serviceId: "cpu-load-alert", hostId: 1, metric: "cpu", phase: "active", since: 1700000000, lastSeen: 1700000100, peak: 97 },
  };
  for (const [table, row] of Object.entries(state)) {
    await runtime.insertAndGetId(table, row);
    await assert.rejects(runtime.insertAndGetId(table, row), (error: any) => error.code === (kind === "mysql" ? "ER_DUP_ENTRY" : "23505"), `${table} must enforce its identity without duplicate state`);
  }
  await runtime.insertAndGetId("agent_installations", { hostId: 1, installationId: "b".repeat(64), createdAt: 1700000100 });
  await runtime.executeRaw(`UPDATE ${q("hosts")} SET ${q("agentInstallationId")} = ? WHERE ${q("id")} = 1`, ["b".repeat(64)]);
  const persisted: Record<string, unknown> = {};
  for (const table of additions) persisted[table] = await runtime.queryRaw(`SELECT * FROM ${q(table)} ORDER BY ${q("id")}`);
  await runtime.closeDatabase();
  await reconnect();
  await schema.ensureDatabaseSchema();
  for (const table of additions) assert.deepEqual(await runtime.queryRaw(`SELECT * FROM ${q(table)} ORDER BY ${q("id")}`), persisted[table], `${table} survives reconnect and repeat initialization`);
  assert.equal((await runtime.queryRaw<any>(`SELECT ${q("agentInstallationId")} FROM ${q("hosts")} WHERE ${q("id")} = 1`))[0].agentInstallationId, "b".repeat(64));
  const migration = await import("./migration");
  for (const dataScope of ["full", "essential"] as const) {
    const exported = await migration.exportMigrationSnapshot("https://fixture.invalid", { dataScope, consistent: true });
    assert.deepEqual(exported.tables.agent_installations, persisted.agent_installations, "migration retains current and retired installation identities");
    assert.deepEqual(exported.tables.resource_traffic_baselines, persisted.resource_traffic_baselines, "migration retains display baselines separately from accounting totals");
    assert.deepEqual(exported.tables.forward_group_retirements, before.forward_group_retirements, "migration preserves the independent ADR-0010 handoff state");
  }
}));

test(`real ${label} batched quota accounting crosses chunk boundaries, isolates users and rolls back atomically`, {
  skip: !testUrl, timeout: 120_000,
}, async () => isolatedDatabase(async runtime => {
  const users = await import("./repositories/userRepository");
  const billing = await import("./repositories/trafficBillingRepository");
  const q = runtime.quoteDbIdentifier;
  for (let id = 1; id <= 130; id++) await runtime.insertAndGetId("users", { id, username: `quota-${id}`, password: "fixture", balanceCents: 1000, trafficLimit: id === 1 ? 150 : 0, expiresAt: id === 2 ? 1700000000 : null });
  const rows = await runtime.withDatabaseTransaction(async () => {
    await billing.lockTrafficBillingUserRows(Array.from({ length: 129 }, (_, i) => 129 - i));
    return users.addUsersTrafficBatch([...Array.from({ length: 129 }, (_, i) => [i + 1, 100] as const), [1, 100], [0, 50], [130, 0], [130, -10], [130, NaN]]);
  });
  assert.equal(rows.length, 129);
  assert.deepEqual(Object.keys(rows[0]).sort(), ["expiresAt", "id", "trafficLimit", "trafficUsed"]);
  assert.equal(Number(rows.find(row => Number(row.id) === 1)!.trafficUsed), 200);
  assert.equal(Number(rows.find(row => Number(row.id) === 1)!.trafficLimit), 150);
  assert.equal(rows.find(row => Number(row.id) === 2)!.expiresAt?.getTime(), 1700000000000);
  const used = async (id: number) => Number((await runtime.queryRaw<any>(`SELECT ${q("trafficUsed")} FROM ${q("users")} WHERE ${q("id")} = ?`, [id]))[0].trafficUsed);
  assert.equal(await used(130), 0, "invalid or empty deltas must not affect another user");
  await assert.rejects(runtime.withDatabaseTransaction(async () => {
    await users.addUsersTrafficBatch(Array.from({ length: 129 }, (_, i) => [i + 1, 500] as const));
    throw new Error("quota-rollback-fixture");
  }), /quota-rollback-fixture/);
  assert.equal(await used(1), 200);
  assert.equal(await used(129), 100, "rollback must also undo the final chunk");
  await Promise.all(Array.from({ length: 8 }, () => runtime.withDatabaseTransaction(async () => {
    await billing.lockTrafficBillingUserRows([2, 1]);
    await users.addUsersTrafficBatch([[1, 10], [2, 20]]);
  }, { retryConflicts: true })));
  assert.equal(await used(1), 280);
  assert.equal(await used(2), 260);
  assert.equal(await used(130), 0);
  const [balances] = await runtime.queryRaw<any>(`SELECT SUM(${q("balanceCents")}) AS total FROM ${q("users")}`);
  assert.equal(Number(balances.total), 130000, "quota batching alone must never charge balances");
}));

test(`real ${label} whole-transaction deadlock retries commit quota, billing and callbacks exactly once`, {
  skip: !testUrl, timeout: 120_000,
}, async () => isolatedDatabase(async runtime => {
  const users = await import("./repositories/userRepository");
  const billing = await import("./repositories/trafficBillingRepository");
  const q = runtime.quoteDbIdentifier;
  await (await import("./repositories/settingsRepository")).setSetting("trafficBillingEnabled", "true");
  for (const id of [1, 2]) {
    await runtime.insertAndGetId("users", { id, username: `deadlock-${id}`, password: "fixture", balanceCents: 10000 });
    await runtime.insertAndGetId("hosts", { id, name: `deadlock-host-${id}`, ip: `192.0.2.${id}`, userId: id });
    await runtime.insertAndGetId("forward_rules", { id, hostId: id, userId: id, name: `deadlock-rule-${id}`, sourcePort: 18000 + id, targetIp: "198.51.100.1", targetPort: 443 });
    await runtime.insertAndGetId("traffic_billing_configs", { resourceType: "host", resourceId: id, enabled: true, pricePerGbCents: 100, pricePerGbMilliCents: 100000, multiplier: 100 });
  }
  if (kind === "postgresql") await runtime.executeRaw("SET deadlock_timeout = '100ms'");
  const attempts = [0, 0];
  const committed: number[] = [];
  const settled: number[] = [];
  let readyCount = 0;
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  const actors = [1, 2].map(id => runtime.withDatabaseTransaction(async () => {
    attempts[id - 1]++;
    await billing.lockTrafficBillingUserRows(id);
    if (attempts[id - 1] === 1) {
      if (++readyCount === 2) release();
      await ready;
    }
    await users.addUsersTrafficBatch([[id, 1073741824]]);
    await billing.billTrafficUsage({ userId: id, ruleId: id, bytes: 1073741824, resourceType: "host", resourceId: id });
    await runtime.afterDatabaseCommit(() => { committed.push(id); });
    await runtime.afterDatabaseTransactionSettled(() => { settled.push(id); });
    // Both actors have already charged their own user; opposite row locks now
    // force a real server deadlock that must undo the victim's entire charge.
    await runtime.executeRaw(`UPDATE ${q("users")} SET ${q("trafficUsed")} = ${q("trafficUsed")} WHERE ${q("id")} = ?`, [id === 1 ? 2 : 1]);
  }, { retryConflicts: true }).catch(error => { release(); throw error; }));
  const outcomes = await Promise.allSettled(actors);
  for (const outcome of outcomes) if (outcome.status === "rejected") throw outcome.reason;
  assert.equal(attempts[0] + attempts[1], 3, "two initial actors plus exactly one complete retry must execute");
  assert.deepEqual(committed.sort(), [1, 2], "rolled-back attempts must discard their commit callbacks");
  assert.equal(settled.length, 3, "every completed or rolled-back attempt settles once");
  const totals = await runtime.queryRaw<any>(`SELECT ${q("id")}, ${q("trafficUsed")}, ${q("balanceCents")} FROM ${q("users")} ORDER BY ${q("id")}`);
  assert.deepEqual(totals.map(row => [Number(row.id), Number(row.trafficUsed), Number(row.balanceCents)]), [[1, 1073741824, 9900], [2, 1073741824, 9900]]);
  for (const table of ["traffic_billing_records", "balance_transactions"]) {
    const rows = await runtime.queryRaw<any>(`SELECT ${q("userId")}, ${q("amountCents")} FROM ${q(table)} ORDER BY ${q("userId")}`);
    assert.deepEqual(rows.map(row => [Number(row.userId), Number(row.amountCents)]), table === "balance_transactions" ? [[1, -100], [2, -100]] : [[1, 100], [2, 100]], `${table}: one charge per user, no partial or duplicate ledger rows`);
  }
  const usage = await runtime.queryRaw<any>(`SELECT ${q("userId")}, ${q("totalBytes")}, ${q("billedGb")} FROM ${q("traffic_billing_usage")} ORDER BY ${q("userId")}`);
  assert.deepEqual(usage.map(row => [Number(row.userId), Number(row.totalBytes), Number(row.billedGb)]), [[1, 1073741824, 1], [2, 1073741824, 1]]);
  let postCommitAttempts = 0;
  await assert.rejects(runtime.withDatabaseTransaction(async () => {
    postCommitAttempts++;
    await users.addUsersTrafficBatch([[1, 7]]);
    await runtime.afterDatabaseCommit(() => { throw Object.assign(new Error("committed-callback-fixture"), { code: kind === "mysql" ? "ER_LOCK_DEADLOCK" : "40P01" }); });
  }, { retryConflicts: true }), /committed-callback-fixture/);
  assert.equal(postCommitAttempts, 1, "an error after COMMIT must never replay committed accounting");
  const [after] = await runtime.queryRaw<any>(`SELECT ${q("trafficUsed")}, ${q("balanceCents")} FROM ${q("users")} WHERE ${q("id")} = 1`);
  assert.equal(Number(after.trafficUsed), 1073741831);
  assert.equal(Number(after.balanceCents), 9900);
}));

test(`real ${label} encrypted Agent batches deduplicate concurrent reports and fence retired installations`, {
  skip: !testUrl, timeout: 120_000,
}, async () => isolatedDatabase(async (runtime, reconnect) => {
  const { agentRouter } = await import("./agentRoutes");
  const { encryptPayload, decryptPayload } = await import("./agentCrypto");
  const { claimAgentInstallation } = await import("./agentInstallation");
  const billing = await import("./repositories/trafficBillingRepository");
  const q = runtime.quoteDbIdentifier;
  const tokens = [randomBytes(32).toString("hex"), randomBytes(32).toString("hex")];
  const installations = ["a".repeat(64), "b".repeat(64)];
  await billing.setTrafficBillingEnabled(true);
  for (const id of [1, 2]) {
    await runtime.insertAndGetId("users", { id, username: `report-${id}`, password: "fixture", role: "user", balanceCents: 100000, trafficLimit: 10000 });
    await runtime.insertAndGetId("hosts", { id, name: `report-host-${id}`, ip: `192.0.2.${id}`, userId: id, hostType: "slave", agentToken: tokens[id - 1] });
    assert.deepEqual(await claimAgentInstallation(id, ""), { accepted: true, changed: false, replaced: false });
    assert.deepEqual(await claimAgentInstallation(id, installations[id - 1]), { accepted: true, changed: true, replaced: false });
    for (let n = 1; n <= 65; n++) await runtime.insertAndGetId("forward_rules", { id: (id - 1) * 65 + n, hostId: id, userId: id, name: `report-rule-${id}-${n}`, sourcePort: 18000 + n, targetIp: "198.51.100.1", targetPort: 443, isEnabled: true });
  }
  await runtime.insertAndGetId("traffic_billing_configs", { resourceType: "host", resourceId: 1, enabled: true, pricePerGbCents: 100, pricePerGbMilliCents: 100000, multiplier: 100 });
  const app = express();
  app.use(express.json());
  app.use(agentRouter);
  const server = createServer(app);
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const post = async (hostId: number, reportId: string, installationId = installations[hostId - 1]) => {
      const token = tokens[hostId - 1];
      const payload = { reportId, reportProducerId: `compat-producer-${hostId}`, stats: Array.from({ length: 65 }, (_, n) => ({ ruleId: (hostId - 1) * 65 + n + 1, bytesIn: hostId === 1 ? 1073741824 : 10, bytesOut: hostId === 1 ? 0 : 20, connections: 1 })) };
      const response = await fetch(`http://127.0.0.1:${address.port}/api/sync`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(encryptPayload({ path: "/api/agent/traffic", installationId, payload }, token)),
        signal: AbortSignal.timeout(30000),
      });
      const body = decryptPayload(await response.json(), token, { validateTimestamp: false });
      assert.equal(response.status, 200, JSON.stringify(body));
      assert.equal(body.success, true, JSON.stringify(body));
      return body;
    };
    let previousCounterIds: unknown;
    for (const reportId of ["first-batch", "second-batch"]) {
      for (const hostId of [1, 2]) {
        const responses = await Promise.all(Array.from({ length: 4 }, () => post(hostId, reportId)));
        assert.equal(responses.filter(body => body.duplicate === true).length, 3, "one report commits and three concurrent retransmissions are duplicates");
      }
      if (kind === "mysql") {
        const ids = await runtime.queryRaw("SELECT TABLE_NAME, AUTO_INCREMENT FROM information_schema.tables WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('user_traffic_counters', 'forward_rule_traffic_counters') ORDER BY TABLE_NAME");
        if (previousCounterIds) assert.deepEqual(ids, previousCounterIds, "existing counters update without burning auto-increment IDs");
        previousCounterIds = ids;
      }
    }
    const users = await runtime.queryRaw<any>(`SELECT ${q("id")}, ${q("trafficUsed")}, ${q("balanceCents")} FROM ${q("users")} ORDER BY ${q("id")}`);
    assert.deepEqual(users.map(row => [Number(row.id), Number(row.trafficUsed), Number(row.balanceCents)]), [[1, 0, 87000], [2, 3900, 100000]], "billed traffic and package quota remain isolated across users");
    for (const table of ["traffic_billing_records", "balance_transactions"]) {
      const [ledger] = await runtime.queryRaw<any>(`SELECT COUNT(*) AS n, SUM(${q("amountCents")}) AS total FROM ${q(table)}`);
      assert.deepEqual([Number(ledger.n), Number(ledger.total)], [130, table === "balance_transactions" ? -13000 : 13000], "duplicate requests must not create duplicate charges");
    }
    const [samples] = await runtime.queryRaw<any>(`SELECT COUNT(*) AS n FROM ${q("traffic_stats")}`);
    assert.equal(Number(samples.n), 260);
    const counters = await runtime.queryRaw<any>(`SELECT ${q("userId")}, SUM(${q("bytesIn")}) AS i, SUM(${q("bytesOut")}) AS o, SUM(${q("connections")}) AS c FROM ${q("forward_rule_traffic_counters")} GROUP BY ${q("userId")} ORDER BY ${q("userId")}`);
    assert.deepEqual(counters.map(row => [Number(row.userId), Number(row.i), Number(row.o), Number(row.c)]), [[1, 139586437120, 0, 130], [2, 1300, 2600, 130]]);
    const replacement = "c".repeat(64);
    assert.deepEqual(await claimAgentInstallation(1, replacement), { accepted: true, changed: true, replaced: true });
    assert.equal((await post(1, "retired-report")).agentSuperseded, true);
    assert.deepEqual(await claimAgentInstallation(1, installations[0]), { accepted: false, changed: false, replaced: false });
    assert.deepEqual(await claimAgentInstallation(1, ""), { accepted: false, changed: false, replaced: false });
    await runtime.closeDatabase();
    await reconnect();
    assert.deepEqual(await claimAgentInstallation(1, installations[0]), { accepted: false, changed: false, replaced: false }, "retirement persists after reconnect");
    assert.deepEqual(await claimAgentInstallation(1, replacement), { accepted: true, changed: false, replaced: false });
    const [unchanged] = await runtime.queryRaw<any>(`SELECT ${q("balanceCents")} FROM ${q("users")} WHERE ${q("id")} = 1`);
    assert.equal(Number(unchanged.balanceCents), 87000, "retired reports cannot change accounting");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}));

test(`real ${label} structured migration remaps installation identities, display baselines and retained handoffs`, {
  skip: !testUrl, timeout: 120_000,
}, async () => isolatedDatabase(async runtime => {
  const migration = await import("./migration");
  const q = runtime.quoteDbIdentifier;
  await runtime.insertAndGetId("users", { id: 1, username: "existing-owner", password: "fixture", balanceCents: 777 });
  await runtime.insertAndGetId("hosts", { id: 1, name: "existing-host", ip: "192.0.2.100", userId: 1 });
  await runtime.insertAndGetId("forward_groups", { id: 1, name: "existing-group", targetIp: "192.0.2.100", userId: 1 });
  await runtime.insertAndGetId("forward_group_members", { id: 11, groupId: 1, hostId: 1, memberType: "host" });
  if (kind === "postgresql") {
    // Explicit fixture IDs must advance sequences just as an existing panel's
    // inserts do; otherwise the fixture creates artificial primary-key clashes.
    for (const table of ["users", "hosts", "forward_groups", "forward_group_members"]) await runtime.executeRaw(`SELECT setval(pg_get_serial_sequence(?, 'id'), (SELECT MAX(${q("id")}) FROM ${q(table)}))`, [table]);
  }
  const existing = await runtime.queryRaw(`SELECT * FROM ${q("users")} WHERE ${q("id")} = 1`);
  const result = await migration.importMigrationSnapshot({ version: 1, exportedAt: 1700000000000, dataScope: "essential", tables: {
    users: [{ id: 1, username: "incoming-owner", password: "fixture", balanceCents: 12345 }],
    hosts: [{ id: 1, name: "incoming-host", ip: "192.0.2.1", userId: 1, agentInstallationId: "b".repeat(64) }],
    agent_installations: [{ id: 1, hostId: 1, installationId: "a".repeat(64), createdAt: 1700000000 }, { id: 2, hostId: 1, installationId: "b".repeat(64), createdAt: 1700000010 }],
    forward_groups: [{ id: 1, name: "incoming-group", targetIp: "192.0.2.2", userId: 1, manualTakeoverMemberId: 11, manualTakeoverToken: "incoming-sort", lastDdnsTtl: 600 }],
    forward_group_members: [{ id: 11, groupId: 1, hostId: 1, memberType: "host" }],
    forward_rules: [
      { id: 100, name: "incoming-root", hostId: 1, userId: 1, sourcePort: 20000, targetIp: "192.0.2.2", targetPort: 443, forwardGroupId: 1, isForwardGroupTemplate: true },
      { id: 101, name: "incoming-retained", hostId: 1, userId: 1, sourcePort: 20000, targetIp: "192.0.2.2", targetPort: 443, forwardGroupId: 1, isForwardGroupTemplate: false, forwardGroupRuleId: 100, forwardGroupMemberId: 10 },
    ],
    resource_traffic_baselines: [{ id: 1, groupId: 1, ruleId: 101, hostId: 1, bytesIn: 4294967297, bytesOut: 8589934593, dailyIn: 12, dailyOut: 34, resetDay: 1700000000, resetAt: 1700000010 }],
    forward_group_retirements: [{ id: 8, groupId: 1, memberId: 10, hostId: 1, ruleIds: "[101]", provider: "fixture", domain: "handoff.example", recordType: "A", oldValue: "192.0.2.1", startedAt: 1700000000000, fallbackDeadlineAt: 1700000300000, oldTtl: 600, switchedAt: 1700000001000, switchTtl: 60, retireAt: 1700000601000, state: "pending" }],
  } });
  assert.equal(result.success, true);
  assert.equal(result.partial, false, JSON.stringify(result));
  assert.equal(result.skippedRows, 0, "best-effort tables must also import without losing any baseline");
  assert.deepEqual(await runtime.queryRaw(`SELECT * FROM ${q("users")} WHERE ${q("id")} = 1`), existing);
  const [host] = await runtime.queryRaw<any>(`SELECT * FROM ${q("hosts")} WHERE ${q("name")} = ?`, ["incoming-host"]);
  assert.notEqual(Number(host.id), 1);
  assert.equal(host.agentInstallationId, "b".repeat(64));
  const identities = await runtime.queryRaw<any>(`SELECT ${q("hostId")}, ${q("installationId")} FROM ${q("agent_installations")} ORDER BY ${q("installationId")}`);
  assert.deepEqual(identities.map(row => [Number(row.hostId), row.installationId]), [[Number(host.id), "a".repeat(64)], [Number(host.id), "b".repeat(64)]]);
  const [group] = await runtime.queryRaw<any>(`SELECT * FROM ${q("forward_groups")} WHERE ${q("name")} = ?`, ["incoming-group"]);
  assert.notEqual(Number(group.id), 1);
  assert.notEqual(Number(group.manualTakeoverMemberId), 11);
  assert.equal(group.manualTakeoverToken, "incoming-sort");
  const [rule] = await runtime.queryRaw<any>(`SELECT * FROM ${q("forward_rules")} WHERE ${q("name")} = ?`, ["incoming-retained"]);
  const [baseline] = await runtime.queryRaw<any>(`SELECT * FROM ${q("resource_traffic_baselines")}`);
  assert.deepEqual([Number(baseline.groupId), Number(baseline.ruleId), Number(baseline.hostId), Number(baseline.bytesIn), Number(baseline.bytesOut)], [Number(group.id), Number(rule.id), Number(host.id), 4294967297, 8589934593]);
  const [handoff] = await runtime.queryRaw<any>(`SELECT * FROM ${q("forward_group_retirements")}`);
  assert.deepEqual([Number(handoff.groupId), Number(handoff.hostId), Number(handoff.memberId), handoff.ruleIds, Number(handoff.retireAt)], [Number(group.id), Number(host.id), 10, JSON.stringify([Number(rule.id)]), 1700000601000]);
}));
