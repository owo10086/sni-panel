import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("scheduler recovers completed rule batches and settles expired segments once", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-scheduler-rule-probe-"));
  const script = String.raw`
    import assert from "node:assert/strict";
    const runtime = await import("./server/dbRuntime.ts");
    const { startScheduler } = await import("./server/scheduler.ts");
    const { createForwardTest } = await import("./server/repositories/forwardTestRepository.ts");
    const { getLatestForwardTest } = await import("./server/repositories/forwardTestRepository.ts");
    const timers = [];
    const originalSetTimeout = globalThis.setTimeout;
    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await (await import("./server/dbSchema.ts")).ensureDatabaseSchema();
      const seed = async (ruleId, batchId, status) => {
        for (let segment = 0; segment < 2; segment++) await createForwardTest({
          ruleId, hostId: segment + 1, userId: 1, batchId, status, latencyMs: status === "success" ? 5 : null,
          message: JSON.stringify({ kind: segment ? "forward-via-tunnel" : "tunnel-hop", tunnelId: 1,
            batchId, pathKeys: ["path-1"], hopIndex: 0, hopCount: 1, fromHostId: segment + 1, toHostId: 3 }),
        });
      };
      await seed(1, "rt-recovered", "success");
      await seed(2, "rt-expired", "running");
      globalThis.setTimeout = (callback, delay) => {
        const timer = { callback, delay, unref() {} }; timers.push(timer); return timer;
      };
      startScheduler();
      // Queuing already activates timers. Wait for the persisted recovery result.
      for (let turn = 0; turn < 100; turn++) {
        const [sample] = await runtime.queryRaw('SELECT COUNT(*) AS count FROM tcping_stats WHERE ruleId=1');
        if (sample.count === 1) break;
        await new Promise(resolve => setImmediate(resolve));
      }
      const recovered = await getLatestForwardTest(1);
      assert.equal(recovered.status, "success");
      assert.equal(recovered.latencyMs, 10);
      assert.equal(recovered.forwardOk, false, "segment success does not prove an external path");
      assert.equal((await runtime.queryRaw('SELECT COUNT(*) AS count FROM tcping_stats WHERE ruleId=1'))[0].count, 1);
      const expiredAt = Math.floor(Date.now() / 1000) - 200;
      await runtime.executeRaw('UPDATE forward_tests SET createdAt=?,updatedAt=? WHERE ruleId=2', [expiredAt, expiredAt]);
      const sweep = timers.find(timer => timer.delay === 2000);
      assert.ok(sweep, "active persisted tests arm the timeout sweep");
      await sweep.callback();
      assert.equal((await getLatestForwardTest(2)).status, "timeout");
      assert.equal((await runtime.queryRaw('SELECT COUNT(*) AS count FROM forward_tests WHERE batchSettled=0'))[0].count, 0);
      const stats = await runtime.queryRaw('SELECT ruleId,latencyMs,isTimeout FROM tcping_stats ORDER BY ruleId');
      assert.deepEqual(stats, [{ ruleId: 1, latencyMs: 10, isTimeout: 0 }, { ruleId: 2, latencyMs: null, isTimeout: 1 }]);
      await timers.filter(timer => timer.delay === 2000).at(-1).callback();
      assert.equal((await runtime.queryRaw('SELECT COUNT(*) AS count FROM tcping_stats'))[0].count, 2, "later sweeps cannot duplicate batch samples");
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      await runtime.closeDatabase();
    }
  `;
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(), env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "fixture.db"),
        DATABASE_CONFIG_PATH: path.join(directory, "database.json"), FORWARDX_LOG_DIR: path.join(directory, "logs") },
      encoding: "utf8", timeout: 30_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
