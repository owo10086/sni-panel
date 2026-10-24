import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// The rule self-test only connects from the entry host to the target. These
// tests drive the real Agent result route and the real result readers and check
// that the stored and returned records keep the target result without ever
// claiming that the external path through the entry was verified.
test("target self-tests keep their result and never claim a verified external path", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-selftest-evidence-"));
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    const mod = file => import(pathToFileURL(path.join(process.cwd(), file)).href);
    const runtime = await mod("server/dbRuntime.ts");
    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
    await (await mod("server/dbSchema.ts")).ensureDatabaseSchema();
    const db = await mod("server/db.ts");
    const { selfTestRulesRouter } = await mod("server/routers/rules.selfTest.ts");
    const { forwardGroupsRouter } = await mod("server/routers/forwardGroups.ts");
    const { Router } = await import("express");
    const { registerAgentSelfTestRoutes } = await mod("server/agentSelfTestRoutes.ts");
    const insert = async (table, data) => {
      const keys = Object.keys(data);
      await runtime.executeRaw('INSERT INTO "' + table + '" (' + keys.map(k => '"' + k + '"').join(',') + ') VALUES (' + keys.map(() => '?').join(',') + ')', Object.values(data));
    };
    const now = Math.floor(Date.now() / 1000);
    const caller = selfTestRulesRouter.createCaller({ user: { id: 1, role: "user" }, req: { headers: {} }, res: {} });
    const agentRouter = Router();
    registerAgentSelfTestRoutes(agentRouter);
    const route = path => agentRouter.stack.find(layer => layer.route?.path === path).route.stack[0].handle;
    const report = async (hostId, body) => {
      let result;
      await route("/api/agent/selftest-result")({ agentToken: "token-" + hostId, body }, { json: value => result = value, status: code => { throw new Error("HTTP " + code); } });
      return result;
    };
    const run = async (body) => {
      const started = await caller.startSelfTest({ ruleId: 100 });
      await report(1, { testId: started.id, ...body });
      return started.id;
    };
    try {
      await insert("hosts", { id: 1, name: "entry", ip: "198.51.100.1", ipv4: "198.51.100.1", userId: 1, isOnline: 1, agentToken: "token-1", lastHeartbeat: now });
      await insert("forward_rules", { id: 100, hostId: 1, userId: 1, name: "rule", sourcePort: 18000, targetIp: "203.0.113.10", targetPort: 443, forwardType: "nftables", protocol: "tcp", isEnabled: 1, pendingDelete: 0 });

      // An older Agent reports exactly this shape: the target result and nothing about the entry path.
      const okId = await run({ targetReachable: true, latencyMs: 147, message: "目标 203.0.113.10:443 TCP可达，延迟 147ms" });
      const stored = await db.getForwardTestById(okId);
      assert.equal(stored.status, "success");
      assert.equal(Number(stored.latencyMs), 147, "the target latency stays visible");
      assert.equal(Boolean(stored.targetReachable), true);
      assert.equal(Boolean(stored.forwardOk), false, "a direct target probe is not a verified forwarding path");
      assert.equal(Boolean(stored.listenOk), false, "nor did it touch the entry listener");

      const seen = await caller.latestTest({ ruleId: 100, includeActive: false });
      assert.equal(seen.status, "success");
      assert.equal(seen.latencyMs, 147);
      assert.deepEqual(seen.evidence, { probe: "target", target: "reachable", externalPath: "unverified" });
      assert.equal(seen.forwardOk, false);

      // A newer or hostile reporter cannot assert the external path either.
      const claimed = await run({ targetReachable: true, latencyMs: 9, forwardOk: true, listenOk: true, externalPathVerified: true });
      assert.equal(Boolean((await db.getForwardTestById(claimed)).forwardOk), false);
      assert.equal((await caller.latestTest({ ruleId: 100, includeActive: false })).evidence.externalPath, "unverified");

      // A failed target is a failed target; the unexamined path is still just unverified.
      const failedId = await run({ targetReachable: false, latencyMs: 0, message: "目标 203.0.113.10:443 TCP不可达或超时" });
      const failed = await caller.latestTest({ ruleId: 100, includeActive: false });
      assert.equal(failed.id, failedId);
      assert.equal(failed.status, "failed");
      assert.deepEqual(failed.evidence, { probe: "target", target: "unreachable", externalPath: "unverified" });

      // Records stored before this contract carried unconditional success flags.
      const legacyId = Number((await runtime.executeRaw(
        'INSERT INTO "forward_tests" ("ruleId","hostId","userId","status","listenOk","targetReachable","forwardOk","latencyMs","message") VALUES (100,1,1,\'success\',1,1,1,147,\'目标 TCP可达\')',
      ))?.lastInsertRowid || 0);
      const legacy = await caller.latestTest({ ruleId: 100, includeActive: false });
      assert.ok(legacy.id >= legacyId);
      assert.equal(legacy.forwardOk, false, "an old success flag is not evidence of a forwarding path");
      assert.equal(legacy.listenOk, false);
      assert.equal(legacy.latencyMs, 147);
      assert.deepEqual(legacy.evidence, { probe: "target", target: "reachable", externalPath: "unverified" });

      // The same reader contract applies to a forward-chain group's own result.
      await insert("forward_groups", { id: 10, name: "chain", groupMode: "chain", groupType: "host", userId: 1, isEnabled: 1, targetIp: "203.0.113.10" });
      const group = forwardGroupsRouter.createCaller({ user: { id: 1, role: "admin" }, req: { headers: {} }, res: {} });
      assert.equal(await group.latestTest({ groupId: 10, includeActive: false }), null, "no result yet");
    } finally { await runtime.closeDatabase(); }
  `;
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      cwd: process.cwd(), env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "test.db"), FORWARDX_LOG_DIR: path.join(directory, "logs") },
      encoding: "utf8", timeout: 90_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
