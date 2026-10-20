import assert from "node:assert/strict";
import { fork } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import * as runtime from "./dbRuntime";
import { quoteIdentifier as q, boolLiteral } from "./dbCompat";
import { ensureDatabaseSchema } from "./dbSchema";
import { cleanMonitorHistory } from "./operationsMonitor";
import { cleanProbeHealthHistory } from "./hostProbeHealth";
import { createMcpToken, listMcpTokens } from "./mcpTokens";

// The test runner always supplies a dedicated temporary database explicitly.
const config = JSON.parse(fs.readFileSync(process.env.FORWARDX_TEST_RETENTION_CONFIG!, "utf8"));
await runtime.connectDatabase(config);
if (process.argv.includes("--token-worker")) {
  try {
    process.send!({ type: "ready" });
    await new Promise<void>(resolve => process.once("message", () => resolve()));
    try {
      await createMcpToken(1, `concurrent-${process.pid}`, 7);
      process.send!({ type: "result", created: true });
    } catch (error) {
      if (!(error instanceof Error) || !/10/.test(error.message)) throw error;
      process.send!({ type: "result", created: false });
    }
  } finally { await runtime.closeDatabase(); }
} else {
  const children: ReturnType<typeof fork>[] = [];
  try {
    await ensureDatabaseSchema();
    const now = Math.floor(Date.now() / 1000), old = now - 100 * 86400, future = now + 86400;
    const backlog = 50_001;
    const seed = async (table: string, columns: string[], row: (index: number) => unknown[]) => {
      for (let offset = 0; offset < backlog; offset += 500) {
        const rows = Array.from({ length: Math.min(500, backlog - offset) }, (_, index) => row(offset + index));
        await runtime.executeRaw(`INSERT INTO ${q(table)} (${columns.map(q).join(",")}) VALUES ${rows.map(() => `(${columns.map(() => "?").join(",")})`).join(",")}`, rows.flat());
      }
    };
    await seed("operations_alert_events", ["hostId", "hostName", "metric", "type", "value", "createdAt"], () => [1, "fixture", "cpu", "triggered", 95, old]);
    await seed("operations_alert_state", ["hostId", "metric", "phase", "since", "lastSeen", "peak"], index => [index + 100, "cpu", "pending", old, old, 95]);
    await seed("external_mcp_tokens", ["userId", "name", "prefix", "tokenHash", "expiresAt", "createdAt"], index => [2, "expired", "fixture", `expired-${index}`, old, old]);
    await seed("host_ip_switch_attempts", ["hostId", "serviceId", "incidentId", "status", "createdAt"], index => [1, 1, `old-${index}`, "success", old]);
    await runtime.insertAndGetId("operations_alert_events", { hostId: 1, hostName: "keep", metric: "cpu", type: "triggered", value: 95, createdAt: future });
    await runtime.insertAndGetId("operations_alert_state", { hostId: 1, metric: "cpu", phase: "active", since: now, lastSeen: future, peak: 95 });
    await runtime.insertAndGetId("external_mcp_tokens", { userId: 2, name: "keep", prefix: "fixture", tokenHash: "keep-future", expiresAt: future, createdAt: now });
    await runtime.insertAndGetId("external_mcp_tokens", { userId: 2, name: "at-boundary", prefix: "fixture", tokenHash: "expires-now", expiresAt: now, createdAt: old });
    for (const status of ["pending", "uncertain"]) for (const acknowledged of [false, true]) {
      await runtime.insertAndGetId("host_ip_switch_attempts", { hostId: 1, serviceId: 1, incidentId: `${status}-${acknowledged}`, status, createdAt: old, acknowledged });
    }
    await runtime.insertAndGetId("host_ip_switch_attempts", { hostId: 1, serviceId: 1, incidentId: "recent-success", status: "success", createdAt: future });
    const count = async (table: string, condition: string, params: unknown[] = []) => Number((await runtime.queryRaw<any>(`SELECT COUNT(*) AS total FROM ${q(table)} WHERE ${condition}`, params))[0].total);
    const oldCounts = async () => Promise.all([
      count("operations_alert_events", `${q("createdAt")} < ?`, [now - 30 * 86400]),
      count("operations_alert_state", `${q("lastSeen")} < ?`, [now - 30 * 86400]),
      count("external_mcp_tokens", `${q("expiresAt")} <= ?`, [now]),
      count("host_ip_switch_attempts", `(${q("status")} NOT IN ('pending','uncertain') OR ${q("acknowledged")} = ${boolLiteral(true)}) AND ${q("createdAt")} < ?`, [now - 90 * 86400]),
    ]);
    let before = await oldCounts();
    await cleanMonitorHistory();
    await cleanProbeHealthHistory();
    let remaining = await oldCounts();
    for (let index = 0; index < remaining.length; index++) {
      assert.ok(remaining[index] > 0, "one pass must leave work beyond its 50,000-row budget");
      assert.ok(before[index] - remaining[index] > 0 && before[index] - remaining[index] <= 50_000);
    }
    for (let pass = 0; remaining.some(Boolean); pass++) {
      assert.ok(pass < 30, "backlog must make bounded forward progress");
      before = remaining;
      await cleanMonitorHistory();
      await cleanProbeHealthHistory();
      remaining = await oldCounts();
      for (let index = 0; index < remaining.length; index++) {
        if (before[index]) assert.ok(remaining[index] < before[index]);
        assert.ok(before[index] - remaining[index] <= 50_000);
      }
    }
    assert.equal(await count("operations_alert_events", "1 = 1"), 1);
    assert.equal(await count("operations_alert_state", "1 = 1"), 1);
    assert.equal(await count("external_mcp_tokens", "1 = 1"), 1, "expiry is inclusive but future tokens remain");
    assert.deepEqual((await runtime.queryRaw<any>(`SELECT ${q("incidentId")} FROM ${q("host_ip_switch_attempts")} ORDER BY ${q("incidentId")}`)).map(row => row.incidentId), ["pending-false", "recent-success", "uncertain-false"]);
    console.log("bounded retention: four backlogs, current rows and unacknowledged attempts verified");

    await runtime.insertAndGetId("users", { id: 1, username: "token-admin", password: "fixture-only", role: "admin" });
    for (let index = 0; index < 9; index++) await createMcpToken(1, `existing-${index}`, 7);
    const results: boolean[] = [];
    const workers = Array.from({ length: 2 }, () => {
      const child = fork(path.resolve("server/monitorRetention.fixture.ts"), ["--token-worker"], { execArgv: ["--import", "tsx"], env: process.env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
      children.push(child);
      let output = "";
      child.stdout!.on("data", chunk => { output += String(chunk); });
      child.stderr!.on("data", chunk => { output += String(chunk); });
      let ready!: () => void, resolveResult!: () => void;
      const readyPromise = new Promise<void>(resolve => { ready = resolve; });
      const resultPromise = new Promise<void>(resolve => { resolveResult = resolve; });
      child.on("message", (message: any) => {
        if (message.type === "ready") ready();
        if (message.type === "result") { results.push(message.created); resolveResult(); }
      });
      const closed = new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", code => code === 0 ? resolve() : reject(new Error(output || `worker exit ${code}`)));
      });
      // Surface a failed worker while waiting for readiness or its result.
      return { child, ready: Promise.race([readyPromise, closed.then(() => { throw new Error("worker exited before readiness"); })]), result: Promise.race([resultPromise, closed.then(() => { if (results.length < 2) throw new Error("worker exited before result"); })]), closed };
    });
    await Promise.all(workers.map(worker => worker.ready));
    await runtime.withDatabaseTransaction(async () => {
      await runtime.queryRaw(`SELECT ${q("id")} FROM ${q("users")} WHERE ${q("id")} = ?${runtime.getDatabaseKind() === "sqlite" ? "" : " FOR UPDATE"}`, [1]);
      workers.forEach(worker => worker.child.send({ type: "create" }));
      await new Promise<void>(resolve => setTimeout(resolve, 300));
      assert.equal(results.length, 0, "a second process must wait for the account database lock");
    });
    await Promise.all(workers.map(worker => worker.result));
    await Promise.all(workers.map(worker => worker.closed));
    assert.deepEqual(results.sort(), [false, true]);
    assert.equal((await listMcpTokens(1)).length, 10);
    console.log("MCP cross-process issuance: one success, one limit rejection, exactly ten tokens");
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill();
    await runtime.closeDatabase();
  }
}
