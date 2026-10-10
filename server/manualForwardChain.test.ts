import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("chain results preserve the newest generation and show durable partial progress", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-chain-generation-"));
  const script = String.raw`
    import assert from "node:assert/strict";
    import { pathToFileURL } from "node:url";
    import path from "node:path";
    const source = name => import(pathToFileURL(path.join(process.cwd(), name)).href);
    const runtime = await source("server/dbRuntime.ts");
    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
    await (await source("server/dbSchema.ts")).ensureDatabaseSchema();
    const tests = await source("server/repositories/forwardTestRepository.ts");
    const chain = await source("server/forwardChainManualProbe.ts");
    const metrics = await source("server/repositories/metricsRepository.ts");
    await runtime.insertAndGetId("forward_groups", { id: 9, name: "chain", groupType: "host", groupMode: "chain",
      forwardType: "nftables", domain: "", targetIp: "0.0.0.0", targetPort: 1, userId: 1, isEnabled: true });
    await runtime.insertAndGetId("forward_rules", { id: 19, hostId: 1, name: "chain", sourcePort: 24019,
      targetIp: "192.0.2.99", targetPort: 443, userId: 1, forwardGroupId: 9, isForwardGroupTemplate: true });
    await runtime.insertAndGetId("forward_rules", { id: 20, hostId: 1, name: "chain-member", sourcePort: 24020,
      targetIp: "192.0.2.99", targetPort: 443, userId: 1, forwardGroupId: 9, forwardGroupRuleId: 19 });
    const createBatch = async batchId => {
      const ids = [];
      for (let hop = 0; hop < 2; hop++) ids.push(await tests.createForwardTest({
        ruleId: 19, hostId: hop + 1, userId: 1, batchId,
        message: JSON.stringify({ kind: "forward-chain", groupId: 9, hopLabel: String(hop),
          routeLabel: hop ? "B -> C" : "A -> B", method: "tcp" }),
      }));
      return ids;
    };
    try {
      const old = await createBatch("fc-old");
      const current = await createBatch("fc-current");
      for (const id of current) await tests.completeForwardTestIfActive(id, { status: "success", latencyMs: 7 });
      await chain.settleManualForwardChainBatch("fc-current");
      for (const id of old) await tests.completeForwardTestIfActive(id, { status: "failed", message: "old failure" });
      // Different seconds make the ordering problem deterministic.
      await runtime.executeRaw('UPDATE "forward_tests" SET "updatedAt" = ? WHERE "batchId" = ?',
        [Math.floor(Date.now() / 1000) + 5, "fc-old"]);
      await chain.settleManualForwardChainBatch("fc-old");
      const latest = await tests.getLatestForwardTest(19);
      assert.equal(latest.batchId, "fc-current");
      assert.equal(latest.status, "success");
      assert.equal(latest.latencyMs, 14);
      assert.equal((await metrics.getTrafficSummaryByRule({ ruleIds: [19] }))[0].latestLatencyMs, 14,
        "the rule list must also keep the newest completed chain batch");
      const partial = await createBatch("fc-partial");
      await tests.completeForwardTestIfActive(partial[0], { status: "success", latencyMs: 9 });
      await runtime.closeDatabase();
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      const progress = await tests.getLatestForwardTest(19);
      assert.equal(progress.status, "pending");
      const details = JSON.parse(progress.message).details;
      assert.equal(details.length, 2);
      assert.equal(details[0].latencyMs, 9);
      assert.equal(details[0].pending, false);
      assert.equal(details[1].pending, true);
      assert.equal((await tests.getLatestForwardTest(19, { includeActive: false })).batchId, "fc-current",
        "a partial sample must not be published as a completed batch");
      assert.equal((await metrics.getTrafficSummaryByRule({ ruleIds: [19] }))[0].latestLatencyMs, 14,
        "an unfinished chain segment must not replace a complete chain result");
      await runtime.executeRaw('INSERT INTO users (id,username,password,name,role) VALUES (1,?,?,?,?)', ['admin','unused','Admin','admin']);
      await runtime.executeRaw('INSERT INTO hosts (id,name,ip,"userId","agentToken") VALUES (1,?, ?,1,?)', ['entry','127.0.0.1','probe-fixture-token']);
      await runtime.executeRaw('INSERT INTO forward_rules (id,"hostId",name,protocol,"sourcePort","targetIp","targetPort","userId") VALUES (99,1,?,\'udp\',24001,?,443,1)', ['direct','192.0.2.20']);
      const { rulesRouter } = await source("server/routers/rules.ts");
      const caller = rulesRouter.createCaller({ user: { id: 1, role: "admin" }, req: { headers: {} }, res: {} });
      const direct = await caller.startSelfTest({ ruleId: 99 });
      await runtime.executeRaw('UPDATE "forward_rules" SET "targetIp" = ?, "targetPort" = ? WHERE "id" = 99', ["192.0.2.30", 8443]);
      const { default: express } = await import("express");
      const app = express(); app.use(express.json());
      app.use((req, _res, next) => { req.agentToken = "probe-fixture-token"; next(); });
      (await source("server/agentSelfTestRoutes.ts")).registerAgentSelfTestRoutes(app);
      const server = app.listen(0, "127.0.0.1");
      await new Promise(resolve => server.once("listening", resolve));
      try {
        const response = await fetch("http://127.0.0.1:" + server.address().port + "/api/agent/selftest-pull", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
        });
        assert.equal(response.status, 200);
        const probe = (await response.json()).selfTests.find(probe => probe.testId === direct.id);
        assert.equal(probe.targetIp, "192.0.2.20", "a queued request keeps its original target");
        assert.equal(probe.targetPort, 443);
        assert.equal(probe.method, "ping");
      } finally { await new Promise(resolve => server.close(resolve)); }
    } finally { await runtime.closeDatabase(); }
  `;
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(), env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "panel.db"),
        FORWARDX_LOG_DIR: directory }, encoding: "utf8", timeout: 60_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
