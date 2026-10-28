import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
test("rule self-test API streams arriving segments, resumes after restart and isolates old generations", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-rule-probe-"));
  const script = String.raw`
    import assert from "node:assert/strict";
    import { pathToFileURL } from "node:url";
    import path from "node:path";
    const mod = file => import(pathToFileURL(path.join(process.cwd(), file)).href);
    const runtime = await mod("server/dbRuntime.ts");
    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
    await (await mod("server/dbSchema.ts")).ensureDatabaseSchema();
    const { rulesRouter } = await mod("server/routers/rules.ts");
    const metrics = await mod("server/repositories/metricsRepository.ts");
    const { Router } = await import("express");
    const { registerAgentSelfTestRoutes } = await mod("server/agentSelfTestRoutes.ts");
    const router = Router(); registerAgentSelfTestRoutes(router);
    const request = async (route, hostId, body = {}) => {
      let result;
      await router.stack.find(layer => layer.route?.path === route).route.stack[0].handle(
        { agentToken: "token-" + hostId, body },
        { json: value => result = value, status: code => { throw new Error("HTTP " + code); } });
      return result;
    };
    const caller = rulesRouter.createCaller({ user: { id: 1, role: "admin" }, req: { headers: {} }, res: {} });
    const pull = async () => {
      const rows = [];
      for (const hostId of [1, 2, 3]) {
        const result = await request("/api/agent/selftest-pull", hostId);
        for (const test of result.selfTests) rows.push({ id: test.testId, hostId });
      }
      return rows;
    };
    const start = async () => {
      const result = await caller.startSelfTest({ ruleId: 2 });
      assert.equal(result.queued, 3);
      return pull();
    };
    const report = async (row, latencyMs, targetReachable = true) => request("/api/agent/selftest-result", row.hostId,
      { testId: row.id, targetReachable, latencyMs });
    const details = result => JSON.parse(result.message).details;
    try {
      if (process.env.FORWARDX_PROBE_STAGE === "seed") {
        for (let id = 1; id <= 3; id++) await runtime.insertAndGetId("hosts", {
          id, name: "host-" + id, ip: "192.0.2." + id, ipv4: "192.0.2." + id,
          userId: 1, isOnline: true, agentToken: "token-" + id,
        });
        await runtime.insertAndGetId("forward_groups", { id: 1, name: "entries", userId: 1, groupMode: "entry", groupType: "host", isEnabled: true, targetIp: "198.51.100.1" });
        for (let id = 1; id <= 2; id++) await runtime.insertAndGetId("forward_group_members", {
          groupId: 1, memberType: "host", hostId: id, isEnabled: true,
        });
        await runtime.insertAndGetId("tunnels", { id: 4, userId: 1, name: "multi-entry", entryHostId: 1,
          entryGroupId: 1, exitHostId: 3, listenPort: 4003, mode: "tls", isEnabled: true });
        await runtime.insertAndGetId("forward_rules", { id: 2, userId: 1, name: "rule", hostId: 1, tunnelId: 4,
          sourcePort: 12000, targetIp: "198.51.100.1", targetPort: 443, protocol: "tcp", forwardType: "gost-tunnel" });
        await metrics.insertTrafficStatsBatch([{ stat: { ruleId: 2, hostId: 1, bytesIn: 1, bytesOut: 1, connections: 1 }, userId: 1 }]);
        const unauthorized = rulesRouter.createCaller({ user: { id: 9, role: "user" }, req: { headers: {} }, res: {} });
        await assert.rejects(() => unauthorized.startSelfTest({ ruleId: 2 }), /无权操作/);
        const rows = await start();
        assert.equal(rows.length, 3);
        assert.deepEqual(rows.map(row => row.hostId), [1, 2, 3]);
        const initial = await caller.latestTest({ ruleId: 2 });
        assert.equal(initial.status, "running");
        assert.equal(details(initial).every(detail => detail.pending), true);
        // The second entry wins this race; the target then arrives while entry 1 waits.
        await report(rows[1], 8);
        await report(rows[2], 1);
        const partial = await caller.latestTest({ ruleId: 2, includeActive: false });
        assert.equal(partial.forwardOk, false);
        assert.equal(partial.evidence.externalPath, "unverified");
        assert.equal(partial.id, initial.id, "logical test id does not change with report order");
        assert.equal(partial.status, "running");
        assert.deepEqual(details(partial).map(detail => detail.pending), [true, false, false]);
        assert.equal(details(partial)[1].latencyMs, 8);
        console.log("AGENT_INFLIGHT:" + JSON.stringify(rows[0]));
        // Leave entry 1 pending across a real process exit. The next process
        // must publish these same partial results before it receives the last report.
      } else {
        const partial = await caller.latestTest({ ruleId: 2 });
        assert.equal(partial.status, "running");
        assert.deepEqual(details(partial).map(detail => detail.pending), [true, false, false]);
        const oldTarget = { id: partial.id, hostId: 3 };
        const outstanding = JSON.parse(process.env.FORWARDX_AGENT_INFLIGHT);
        assert.equal(outstanding.hostId, 1);
        assert.equal((await pull()).length, 0, "the dispatched Agent retains its lease across a panel restart");
        await report(outstanding, 6);
        const completed = await caller.latestTest({ ruleId: 2 });
        assert.equal(completed.status, "success");
        assert.equal(completed.latencyMs, 9);
        const summary = await metrics.getTrafficSummaryByRule({ ruleIds: [2] });
        assert.equal(summary[0].latestLatencyMs, 9, "list latency must use the whole probe round, not the exit-to-target segment");
        assert.equal(summary[0].latestLatencyBatchId, completed.batchId, "list provenance must identify the complete round");
        assert.equal(summary[0].latestLatencyTestId, completed.id);
        assert.equal(completed.forwardOk, false);
        assert.equal(completed.listenOk, false);
        assert.equal(completed.evidence.externalPath, "unverified");
        assert.deepEqual(details(completed).map(detail => detail.latencyMs), [6, 8, 1]);
        assert.equal((await report(oldTarget, 99)).ignored, true, "duplicate reports cannot overwrite received results");
        const fresh = await start();
        const freshInitial = await caller.latestTest({ ruleId: 2 });
        assert.equal(details(freshInitial).every(detail => detail.pending), true);
        await report(oldTarget, 99);
        assert.equal((await caller.latestTest({ ruleId: 2 })).id, freshInitial.id);
        await report(fresh[0], 6);
        await report(fresh[1], 0, false);
        const waiting = await caller.latestTest({ ruleId: 2 });
        assert.equal(waiting.status, "running", "one failed entry does not end pending target work");
        await report(fresh[2], 1);
        const alternative = await caller.latestTest({ ruleId: 2 });
        assert.equal(alternative.status, "success");
        assert.equal(alternative.latencyMs, 7, "an independent successful entry path remains available");
        assert.deepEqual(details(alternative).map(detail => detail.success), [true, false, true]);
        const failedRound = await start();
        for (const row of failedRound) await report(row, 0, false);
        const failed = await caller.latestTest({ ruleId: 2 });
        assert.equal(failed.status, "failed");
        assert.equal(failed.latencyMs, null);
        assert.equal(failed.evidence.externalPath, "unverified");
      }
    } finally { await runtime.closeDatabase(); }
  `;
  try {
    let inFlight = "";
    for (const stage of ["seed", "resume"]) {
      const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
        cwd: process.cwd(), env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "probe.db"),
          FORWARDX_PROBE_STAGE: stage, FORWARDX_AGENT_INFLIGHT: inFlight, FORWARDX_LOG_DIR: directory }, encoding: "utf8", timeout: 90_000,
      });
      assert.equal(result.status, 0, `${stage}: ${result.stderr || result.stdout}`);
      if (stage === "seed") {
        inFlight = result.stdout.match(/AGENT_INFLIGHT:(.*)/)?.[1] || "";
        assert.ok(inFlight, "the controlled Agent retains its dispatched work outside the panel process");
      }
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
