import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("agent heartbeat caches verified listeners and requests a changed snapshot", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-occupancy-heartbeat-"));
  const databasePath = path.join(directory, "heartbeat.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import express from "express";
    import http from "node:http";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(moduleUrl("server/dbRuntime.ts"));
    const schema = await import(moduleUrl("server/dbSchema.ts"));
    const heartbeat = await import(moduleUrl("server/agentHeartbeatRoute.ts"));
    const { rulesRouter } = await import(moduleUrl("server/routers/rules.ts"));
    const { getPortOccupancy } = await import(moduleUrl("server/portOccupancy.ts"));
    const { getRulePortWarnings } = await import(moduleUrl("server/rulePortOccupancy.ts"));
    let server;
    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      const insert = async (table, fields, values) => runtime.executeRaw(
        'INSERT INTO "' + table + '" (' + fields.map((field) => '"' + field + '"').join(',') + ') VALUES (' + fields.map(() => '?').join(',') + ')', values);
      await insert("users", ["id", "username", "password", "role", "canAddRules"], [1, "admin", "x", "admin", 1]);
      await insert("hosts", ["id", "name", "ip", "ipv4", "userId", "agentToken", "agentVersion", "isOnline", "lastHeartbeat", "portRangeStart", "portRangeEnd"],
        [1, "entry", "198.51.100.5", "198.51.100.5", 1, "test-token", "2.2.195", 1, Math.floor(Date.now() / 1000), 11000, 12000]);
      await insert("forward_rules", ["id", "hostId", "name", "forwardType", "protocol", "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning"],
        [600, 1, "shared-runtime-rule", "gost", "tcp", 11128, "203.0.113.5", 80, 1, 1, 0]);
      await insert("forward_rules", ["id", "hostId", "name", "forwardType", "protocol", "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning"],
        [601, 1, "kernel-rule", "iptables", "tcp", 11127, "203.0.113.5", 80, 1, 1, 1]);
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => { req.agentToken = String(req.headers.authorization || "").replace(/^Bearer /, ""); next(); });
      heartbeat.registerAgentHeartbeatRoute(app);
      server = http.createServer(app);
      await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
      const baseUrl = "http://127.0.0.1:" + server.address().port;
      const post = async (data) => {
        const response = await fetch(baseUrl + "/api/agent/heartbeat", {
          method: "POST", headers: { authorization: "Bearer test-token", "content-type": "application/json" },
          body: JSON.stringify({ agentVersion: "2.2.195", agentBootId: "test-boot", agentProcessId: 100,
            agentProcessStartedAt: Math.floor(Date.now() / 1000), forceReconcile: true, ...data }),
        });
        assert.equal(response.status, 200);
        return response.json();
      };
      const caller = rulesRouter.createCaller({ req: { headers: {} }, res: { clearCookie() {} },
        user: { id: 1, username: "admin", role: "admin", accountEnabled: true }, authSession: null, authFailureReason: null });
      const collectedAt = Date.now();
      await post({ portOccupancySignature: "abc1", portOccupancyCollected: true,
        localStateSignature: "abc1", localState: { rules: [{ port: 11128, ruleId: 600, forwardType: "gost", protocol: "tcp", ready: false }] },
        portOccupancy: { listeners: [
          { port: 11127, protocol: "tcp", address: "127.0.0.1", process: "code" },
          { port: 11128, protocol: "tcp", address: "127.0.0.1", process: "other-process" },
        ], collectedAt, complete: true } });
      assert.match(getRulePortWarnings(601, true)[0].message, /code/);
      assert.match((await caller.getById({ id: 600 })).portBindFailure, /other-process/);
      const ordinaryCaller = rulesRouter.createCaller({ req: { headers: {} }, res: { clearCookie() {} },
        user: { id: 1, username: "owner", role: "user", accountEnabled: true }, authSession: null, authFailureReason: null });
      assert.doesNotMatch(JSON.stringify((await ordinaryCaller.getById({ id: 600 })).portBindFailure), /other-process/);
      const first = await caller.checkPort({ hostId: 1, sourcePort: 11127, protocol: "tcp", forwardType: "iptables", excludeRuleId: 601 });
      assert.equal(first.occupancy, "warning");
      assert.match(first.warning, /code/);
      const verifiedAt = getPortOccupancy(1).verifiedAt;
      const stable = await post({ forceReconcile: false, portOccupancySignature: "abc1", portOccupancyCollected: true });
      assert.equal(stable.requestPortOccupancy, false);
      assert.equal(stable.reconciliationCoalesced, true);
      assert.equal(getPortOccupancy(1).collectedAt, collectedAt);
      assert.ok(getPortOccupancy(1).verifiedAt >= verifiedAt);
      const missing = await post({ forceReconcile: false, portOccupancySignature: "abc2", portOccupancyCollected: true });
      assert.equal(missing.requestPortOccupancy, true);
      assert.equal(getPortOccupancy(1), null);
      assert.equal((await caller.checkPort({ hostId: 1, sourcePort: 11127, protocol: "tcp", excludeRuleId: 601 })).occupancy, "unverified");
      const changed = await post({ forceReconcile: false, portOccupancySignature: "abc2", portOccupancyCollected: true,
        portOccupancy: { listeners: [{ port: 11127, protocol: "tcp", address: "127.0.0.1", process: "new-owner" }],
          collectedAt: Date.now(), complete: true } });
      assert.equal(changed.requestPortOccupancy, false);
      assert.match(getRulePortWarnings(601, true)[0].message, /new-owner/);
      await post({ portOccupancySignature: "abc2", portOccupancyCollected: true,
        localStateSignature: "abc2", localState: { rules: [{ port: 11128, ruleId: 600, forwardType: "gost", protocol: "tcp", ready: true }] },
        portOccupancy: { listeners: [], collectedAt: Date.now(), complete: true } });
      assert.equal((await caller.getById({ id: 600 })).portBindFailure, null);
      assert.equal((await caller.checkPort({ hostId: 1, sourcePort: 11127, protocol: "tcp", excludeRuleId: 601 })).occupancy, "free");
      await post({ portOccupancySignature: "abc2", portOccupancyCollected: false });
      assert.equal((await caller.checkPort({ hostId: 1, sourcePort: 11127, protocol: "tcp", excludeRuleId: 601 })).occupancy, "unverified");
    } finally {
      if (server) await new Promise((resolve) => server.close(resolve));
      await runtime.closeDatabase();
    }
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: process.cwd(), env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: databasePath },
    encoding: "utf8", timeout: 60_000,
  });
  fs.rmSync(directory, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
