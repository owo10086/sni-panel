import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function verifySniWrites(body: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-sni-writes-"));
  const script = String.raw`
    import assert from "node:assert/strict";
    import * as runtime from "./server/dbRuntime.ts";
    import { ensureDatabaseSchema } from "./server/dbSchema.ts";
    import { rulesRouter } from "./server/routers/rules.ts";
    import * as settings from "./server/repositories/settingsRepository.ts";
    import http from "node:http";
    import express from "express";
    import { registerAgentHeartbeatRoute } from "./server/agentHeartbeatRoute.ts";
    let server;
    let onDns = async () => ({ success: true });
    const heartbeat = async (id, localRules = []) => {
      if (!server) {
        const app = express();
        app.use(express.json());
        app.post("/test-ddns", async (_req, res) => {
          const result = await onDns();
          res.status(result.success ? 200 : 503).json(result);
        });
        app.use((req, _res, next) => { req.agentToken = String(req.headers.authorization || "").replace("Bearer ", ""); next(); });
        registerAgentHeartbeatRoute(app);
        server = http.createServer(app);
        await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
      }
      const response = await fetch("http://127.0.0.1:" + server.address().port + "/api/agent/heartbeat", {
        method: "POST", headers: { authorization: "Bearer token-" + id, "content-type": "application/json" },
        body: JSON.stringify({ agentVersion: "3.3.3", agentBootId: "writes-boot-" + id, agentProcessId: 1000 + id, forceReconcile: true, localState: { rules: localRules } }),
      });
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.equal(result.success, true);
      return result;
    };
    const splitters = result => result.desiredState.actions.filter(action => action.op === "apply" && action.fxp?.role === "sni-splitter");
    const insert = (table, values) => runtime.executeRaw(
      'INSERT INTO "' + table + '" (' + Object.keys(values).map(k => '"' + k + '"').join(',') + ') VALUES (' + Object.keys(values).map(() => '?').join(',') + ')', Object.values(values));
    const context = user => ({ req: { headers: {} }, res: { clearCookie() {} }, user, authSession: null, authFailureReason: null });
    const admin = rulesRouter.createCaller(context({ id: 1, username: "admin", role: "admin", accountEnabled: true }));
    const within = async (work, label) => {
      const watchdog = setTimeout(() => { console.error(label + " did not finish within 5 seconds"); process.exit(2); }, 5000);
      try { return await work; } finally { clearTimeout(watchdog); }
    };
    const create = (name, route = { forwardGroupId: 10 }) => admin.create({ ...route, name, sourcePort: 443, targetIp: "203.0.113.10", targetPort: 8443, sni: name + ".example.test", isEnabled: true });
    const addGroup = async (id, mode, hostIds, extra = {}) => {
      await insert("forward_groups", { id, name: "group-" + id, groupType: "host", groupMode: mode, forwardType: "nftables", domain: "", targetIp: "0.0.0.0", targetPort: 1, userId: 1, isEnabled: 1, ...extra });
      for (const [index, hostId] of hostIds.entries()) await insert("forward_group_members", { id: id * 100 + index, groupId: id, memberType: "host", hostId, priority: index * 10, isEnabled: 1 });
    };
    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await ensureDatabaseSchema();
      await insert("users", { id: 1, username: "admin", password: "x", role: "admin", canAddRules: 1, manualCanAddRules: 1, balanceCents: 10000 });
      for (let id = 1; id <= 12; id++) await insert("hosts", { id, name: "host-" + id, ip: "192.0.2." + id, ipv4: "192.0.2." + id, agentToken: "token-" + id, userId: 1, isOnline: 1, lastHeartbeat: Math.floor(Date.now() / 1000), agentVersion: "3.3.3", portRangeStart: 400, portRangeEnd: 30000 });
      await addGroup(10, "failover", [1, 2]);
      ${body}
    } finally {
      if (server) {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
      }
      await runtime.closeDatabase();
    }
    process.exit(0);
  `;
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(), env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "test.db") }, encoding: "utf8", timeout: 120_000,
    });
    assert.equal(result.status, 0, [result.error?.message, result.stderr, result.stdout].filter(Boolean).join("\n"));
    if (result.stdout.trim()) process.stdout.write(result.stdout);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

