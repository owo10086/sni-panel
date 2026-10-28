import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Inject failures at the driver boundary, exercising the real transaction,
// nesting and callback scopes without requiring a running MySQL server.
function runMysqlScenario(scenario: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-runtime-retry-"));
  const fixture = String.raw`
    import assert from "node:assert/strict";
    import mysql from "mysql2/promise";
    const deadlock = () => Object.assign(new Error("deadlock"), { code: "ER_LOCK_DEADLOCK", errno: 1213 });
    let checkouts = 0, commits = 0, rollbacks = 0, releases = 0;
    let balance = 100, pendingBalance;
    let commitError, rollbackError, releaseError;
    const pool = {
      query: async sql => [[{ version: "8.0.36" }], []],
      end: async () => {},
      getConnection: async () => {
        checkouts++;
        return {
          beginTransaction: async () => { pendingBalance = balance; },
          execute: async (sql, params) => { pendingBalance -= params[0]; return [{ affectedRows: 1 }, []]; },
          commit: async () => { commits++; balance = pendingBalance; if (commitError) throw commitError; },
          rollback: async () => { rollbacks++; if (rollbackError) throw rollbackError; pendingBalance = undefined; },
          release: () => { releases++; if (releaseError) throw releaseError; },
        };
      },
    };
    mysql.createPool = () => pool;
    const runtime = await import("./server/dbRuntime.ts");
    try {
      await runtime.connectDatabase({ type: "mysql", mysql: { host: "test.invalid", port: 3306, user: "test", password: "", database: "test" } });
      ${scenario}
    } finally { await runtime.closeDatabase(); }
  `;
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", fixture], {
      cwd: process.cwd(), env: { ...process.env, DATABASE_TYPE: "mysql", DATABASE_CONFIG_PATH: path.join(directory, "database.json"),
        FORWARDX_LOG_DIR: path.join(directory, "logs") }, encoding: "utf8", timeout: 30_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

test("runtime retries only the entire opted-in rollback and keeps committed callbacks once", () => {
  runMysqlScenario(String.raw`
    let workCalls = 0;
    const committed = [], settled = [];
    const result = await runtime.withDeferredDatabaseCommitCallbacks(async () => {
      const value = await runtime.withDatabaseTransaction(async () => {
        const attempt = ++workCalls;
        await runtime.executeRaw("UPDATE account SET balance = balance - ?", [10]);
        await runtime.afterDatabaseCommit(() => { committed.push(attempt); });
        await runtime.afterDatabaseTransactionSettled(() => { settled.push(attempt); });
        await runtime.withDatabaseTransaction(async () => {
          assert.equal(runtime.isDatabaseTransactionActive(), true);
          if (attempt < 3) throw deadlock();
          await runtime.afterDatabaseCommit(() => { committed.push("nested"); });
        }, { retryConflicts: true });
        return "saved";
      }, { retryConflicts: true });
      assert.deepEqual(committed, [], "deferred effects wait for the outer lock scope");
      return value;
    });
    assert.equal(result, "saved");
    assert.equal(balance, 90, "only the final attempt changes committed quota");
    assert.deepEqual(committed, [3, "nested"]);
    assert.deepEqual(settled, [1, 2, 3]);
    assert.deepEqual([workCalls, checkouts, commits, rollbacks, releases], [3, 3, 1, 2, 3]);
  `);
});

test("nested opt-in cannot replay a partial transaction or enable outer retries", () => {
  runMysqlScenario(String.raw`
    let workCalls = 0, nestedCalls = 0;
    await assert.rejects(runtime.withDatabaseTransaction(async () => {
      workCalls++;
      await runtime.executeRaw("UPDATE account SET balance = balance - ?", [10]);
      await runtime.withDatabaseTransaction(async () => { nestedCalls++; throw deadlock(); }, { retryConflicts: true });
    }), /deadlock/);
    assert.deepEqual([balance, workCalls, nestedCalls, checkouts, rollbacks], [100, 1, 1, 1, 1]);
  `);
});

test("failed rollback and non-conflict errors never replay accounting", () => {
  runMysqlScenario(String.raw`
    for (const mode of ["rollback-failed", "lock-timeout", "network", "bounded-conflict"]) {
      let workCalls = 0;
      checkouts = commits = rollbacks = releases = 0;
      rollbackError = mode === "rollback-failed" ? new Error("rollback failed") : undefined;
      await assert.rejects(runtime.withDatabaseTransaction(async () => {
        workCalls++;
        await runtime.executeRaw("UPDATE account SET balance = balance - ?", [10]);
        if (mode === "lock-timeout") throw Object.assign(new Error("timeout"), { code: "ER_LOCK_WAIT_TIMEOUT" });
        if (mode === "network") throw Object.assign(new Error("network"), { code: "ECONNRESET" });
        throw deadlock();
      }, { retryConflicts: true }));
      const expected = mode === "bounded-conflict" ? 3 : 1;
      assert.deepEqual([balance, workCalls, checkouts, rollbacks, releases], [100, expected, expected, expected, expected], mode);
    }
  `);
});

test("an unconfirmed rollback exposes an unknown outcome instead of a definitive failed write", () => {
  runMysqlScenario(String.raw`
    const { isRuleWriteOutcomeUnknown } = await import("./server/ruleBatchSaveError.ts");
    rollbackError = new Error("rollback transport failed");
    let workCalls = 0;
    await assert.rejects(runtime.withDatabaseTransaction(async () => {
      workCalls++;
      await runtime.executeRaw("UPDATE account SET balance = balance - ?", [10]);
      throw new Error("save validation failed");
    }, { retryConflicts: true }), error => {
      assert.equal(isRuleWriteOutcomeUnknown(error), true);
      return true;
    });
    assert.deepEqual([workCalls, checkouts, rollbacks], [1, 1, 1]);
  `);
});

test("ambiguous commit and errors in committed or cleanup callbacks never replay", () => {
  runMysqlScenario(String.raw`
    for (const mode of ["commit", "after-commit", "after-settled-commit", "after-settled-rollback", "release"]) {
      balance = 100;
      checkouts = commits = rollbacks = releases = 0;
      commitError = mode === "commit" ? deadlock() : undefined;
      releaseError = mode === "release" ? deadlock() : undefined;
      let workCalls = 0, callbackCalls = 0;
      await assert.rejects(runtime.withDatabaseTransaction(async () => {
        workCalls++;
        await runtime.executeRaw("UPDATE account SET balance = balance - ?", [10]);
        if (mode === "after-commit") await runtime.afterDatabaseCommit(() => { callbackCalls++; throw deadlock(); });
        if (mode.startsWith("after-settled")) await runtime.afterDatabaseTransactionSettled(() => { callbackCalls++; throw deadlock(); });
        if (mode === "after-settled-rollback" || mode === "release") throw new Error("work failed");
      }, { retryConflicts: true }));
      const rolledBackWork = mode === "after-settled-rollback" || mode === "release";
      assert.deepEqual([balance, workCalls, checkouts, commits, releases], [rolledBackWork ? 100 : 90, 1, 1, rolledBackWork ? 0 : 1, 1], mode);
      assert.equal(callbackCalls, mode.startsWith("after-") ? 1 : 0, mode);
    }
  `);
});
