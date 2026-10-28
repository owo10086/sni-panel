import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("encrypted registration fences retired installations while legacy hosts can migrate", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-installation-"));
  const script = String.raw`
    import assert from "node:assert/strict";
    import { once } from "node:events";
    import http from "node:http";
    import { setTimeout as delay } from "node:timers/promises";
    import express from "express";
    import { connectDatabase, closeDatabase, executeRaw } from "./server/dbRuntime.ts";
    import { ensureDatabaseSchema } from "./server/dbSchema.ts";
    import { quoteIdentifier as q } from "./server/dbCompat.ts";
    import { agentRouter, createAgentApiRouter } from "./server/agentRoutes.ts";
    import { agentEncryptionMiddleware } from "./server/agentEncryptionMiddleware.ts";
    import { encryptPayload, decryptPayload } from "./server/agentCrypto.ts";
    import { agentTokensRouter } from "./server/routers/agentTokens.ts";
    import { hostsRouter } from "./server/routers/hosts.ts";
    import { rulesRouter } from "./server/routers/rules.ts";
    import { acceptSniHeartbeatProcess, isRetiredSniHeartbeatProcess } from "./server/sniRuntimeObservability.ts";
    import { getAgentConnectionStats, recordAgentConnectionStats } from "./server/agentConnectionStats.ts";
    import { withKeyedTaskLock, keyedTaskDepth } from "./server/keyedTaskLock.ts";
    import { agentStatusOrderingKey } from "./server/agentStatusOrdering.ts";
    const context = (id, role = "user") => ({ user: { id, username: "owner-" + id, role }, req: { headers: {}, socket: {} }, res: {}, authSession: null, authFailureReason: null });
    const tokens = agentTokensRouter.createCaller(context(1, "admin"));
    const hosts = hostsRouter.createCaller(context(1, "admin"));
    const rules = rulesRouter.createCaller(context(1, "admin"));
    const foreign = agentTokensRouter.createCaller(context(2));
    const a = "a".repeat(64), b = "b".repeat(64), c = "c".repeat(64);
    let token, base, tokenId, hostId;
    const app = express();
    let disconnected;
    const disconnectedResponse = new Promise((resolve) => { disconnected = resolve; });
    app.use((req, res, next) => {
      if (req.headers["x-test-disconnect"]) res.once("close", disconnected);
      next();
    });
    const lifecycleRouter = createAgentApiRouter();
    let completeLifecycle, lifecycleWork, lifecycleOrder;
    lifecycleRouter.use("/installation-fence-test", agentEncryptionMiddleware);
    lifecycleRouter.post("/installation-fence-test", async (req, res, next) => {
      if (req.body.mode === "reject") throw new Error("rejected handler");
      if (req.body.mode === "finish") res.json({ success: true });
      else next(new Error("forwarded handler error"));
      await lifecycleWork;
      lifecycleOrder.push("handler settled");
    });
    app.use(express.json()); app.use(lifecycleRouter); app.use(agentRouter);
    app.use((error, req, res, next) => { res.status(503).json({ error: error.message }); });
    const server = http.createServer(app);
    const post = async (route, installationId, payload = {}) => {
      const response = await fetch(base + "/api/sync", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(encryptPayload({ path: route, installationId, payload }, token)) });
      const body = decryptPayload(await response.json(), token, { validateTimestamp: false });
      assert.equal(response.status, 200, JSON.stringify(body));
      return body;
    };
    const register = (id, ip = "203.0.113.10") => post("/api/agent/register", id, { token, ip, ipv4: ip, agentVersion: "3.8.0" });
    const heartbeat = (id) => post("/api/agent/heartbeat", id, { agentVersion: "3.8.0", ip: "203.0.113.10", ipv4: "203.0.113.10", forceReconcile: true, localState: { rules: [], tunnels: [], services: [] } });
    const stream = async (id) => {
      const envelope = encryptPayload({ installationId: id, agentVersion: "3.8.0" }, token);
      return fetch(base + "/api/stream?e=" + encodeURIComponent(JSON.stringify(envelope)));
    };
    try {
      const config = process.env.FORWARDX_INSTALLATION_TEST_DATABASE ? JSON.parse(process.env.FORWARDX_INSTALLATION_TEST_DATABASE) : { type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } };
      await connectDatabase(config); await ensureDatabaseSchema();
      await executeRaw('INSERT INTO users (id, username, password, role) VALUES (?, ?, ?, ?)', [1, "owner", "hash", "admin"]);
      await executeRaw('INSERT INTO users (id, username, password, role) VALUES (?, ?, ?, ?)', [2, "other", "hash", "user"]);
      ({ id: tokenId, token } = await tokens.create({ description: "installation host" }));
      assert.equal((await tokens.getInstallToken({ id: tokenId })).boundHost, null);
      server.listen(0, "127.0.0.1"); await once(server, "listening");
      base = "http://127.0.0.1:" + server.address().port;
      ({ hostId } = await register(""));
      assert.deepEqual((await tokens.getInstallToken({ id: tokenId })).boundHost, { id: hostId, name: "installation host", isOnline: true });
      assert.equal((await heartbeat("")).agentSuperseded, undefined, "panel-only upgrade keeps the unbound legacy Agent usable");
      // Upgrade an existing pre-identity database without losing its host/token.
      await executeRaw('DROP TABLE ' + q('agent_installations'));
      await executeRaw('ALTER TABLE ' + q('hosts') + ' DROP COLUMN ' + q('agentInstallationId'));
      await ensureDatabaseSchema();
      assert.equal((await hosts.getById({ id: hostId })).name, "installation host");
      const columns = ["id", "hostId", "name", "forwardType", "protocol", "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning", "createdAt"];
      await executeRaw('INSERT INTO ' + q('forward_rules') + ' (' + columns.map(q).join(', ') + ') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [1, hostId, "restored rule", "realm", "tcp", 21000, "198.51.100.30", 443, 1, true, true, Math.floor(Date.now() / 1000) - 60]);
      assert.equal((await register(a)).hostId, hostId, "first identity binds the existing host");
      assert.equal((await rules.getById({ id: 1 })).isRunning, false, "first binding requires fresh runtime confirmation");
      const oldStream = await stream(a), reader = oldStream.body.getReader();
      assert.equal((await reader.read()).done, false);
      const oldProcess = { agentBootId: "reused-boot", agentProcessId: 42, agentProcessStartedAt: 1234 };
      acceptSniHeartbeatProcess({ id: hostId, ...oldProcess }, { ...oldProcess, agentProcessId: 43 });
      assert.equal(isRetiredSniHeartbeatProcess(hostId, oldProcess), true);
      await register(a); // ordinary registration preserves identity
      assert.equal(isRetiredSniHeartbeatProcess(hostId, oldProcess), true, "same installation must keep fencing its retired processes");
      assert.equal((await heartbeat(a)).agentSuperseded, undefined);
      recordAgentConnectionStats(hostId, {
        version: 1, scope: "network-namespace", source: "proc-sockstat", sampledAt: Math.floor(Date.now() / 1000),
        tcp: { status: "ok", total: 9, inUse: 8, timeWait: 1, ipv6Included: true },
        udp: { status: "ok", total: 2, inUse: 2, ipv6Included: true },
      });
      assert.equal(getAgentConnectionStats(hostId).stats.tcp.total, 9);
      await register(b); // takeover while predecessor is still online
      assert.equal(isRetiredSniHeartbeatProcess(hostId, oldProcess), false, "a new installation may reuse the predecessor's process identifiers");
      assert.equal(getAgentConnectionStats(hostId), null, "takeover must not display the previous installation's socket counts");
      let eventText = "";
      for (;;) { const next = await reader.read(); if (next.done) break; eventText += new TextDecoder().decode(next.value); }
      const events = eventText.split("data: ").slice(1).map((value) => decryptPayload(JSON.parse(value.split("\n")[0]), token, { validateTimestamp: false }));
      assert.ok(events.some((event) => event.type === "agent-superseded"), "the live predecessor receives a takeover event");
      for (const stale of ["", a, c]) {
        assert.equal((await post("/api/agent/heartbeat", stale, { ip: "203.0.113.99" })).agentSuperseded, true);
        assert.equal((await post("/api/agent/rule-status", stale, { ruleId: 1, success: true, isRunning: true })).agentSuperseded, true);
        assert.equal((await post("/api/agent/traffic", stale, { stats: [{ ruleId: 1, bytesIn: 999, bytesOut: 999 }] })).agentSuperseded, true);
        const rejected = await stream(stale);
        const frame = (await rejected.text()).split("data: ")[1].trim();
        assert.equal(decryptPayload(JSON.parse(frame), token, { validateTimestamp: false }).type, "agent-superseded");
      }
      assert.equal((await register(a, "203.0.113.99")).agentSuperseded, true, "retired installation cannot reclaim on restart");
      assert.equal((await hosts.getById({ id: hostId })).ip, "203.0.113.10");
      assert.equal((await rules.getById({ id: 1 })).isRunning, false);
      assert.equal((await rules.traffic({ ruleId: 1, limit: 10 })).length, 0);
      const desired = await heartbeat(b);
      const actions = desired.desiredState?.actions || desired.actions || [];
      const apply = actions.find((action) => action.ruleId === 1 && action.op === "apply");
      assert.ok(apply, "current installation receives the configuration to recreate forwarding");
      assert.match(apply.unit, /realm/);
      const trafficResponse = await post("/api/agent/traffic", b, { reportId: "current-report", reportProducerId: "current-installation", stats: [{ ruleId: 1, bytesIn: 10, bytesOut: 20 }] });
      const traffic = await rules.traffic({ ruleId: 1, limit: 11 });
      assert.ok(traffic.length > 0, "current installation can report usage: " + JSON.stringify({ trafficResponse, traffic, rule: await rules.getById({ id: 1 }) }));

      // Keep an authenticated report waiting at the existing status ordering
      // boundary, then disconnect its HTTP client before replacing the Agent.
      const statusKey = agentStatusOrderingKey(hostId, { ruleId: 1 });
      let unblockStatus;
      const statusBlocked = new Promise((resolve) => { unblockStatus = resolve; });
      const blocker = withKeyedTaskLock(statusKey, () => statusBlocked);
      const oldReport = http.request(base + "/api/sync", {
        method: "POST", headers: { "content-type": "application/json", "x-test-disconnect": "1" },
      });
      oldReport.on("error", () => {}); // destroying the client intentionally resets its socket
      oldReport.end(JSON.stringify(encryptPayload({
        path: "/api/agent/rule-status", installationId: b,
        payload: { ruleId: 1, success: true, isRunning: true },
      }, token)));
      try {
        const deadline = Date.now() + 5_000;
        while (keyedTaskDepth(statusKey) < 2 && Date.now() < deadline) await delay(5);
        assert.equal(keyedTaskDepth(statusKey), 2, "old report passed identity validation and reached the write queue");
        oldReport.destroy();
        await disconnectedResponse;
        const replacement = register(c);
        // A broken close-based fence lets registration finish here, before the
        // old write. A correct fence drains the handler before resetting state.
        await Promise.race([replacement, delay(250)]);
        unblockStatus();
        await blocker;
        const drainDeadline = Date.now() + 5_000;
        while (keyedTaskDepth(statusKey) > 0 && Date.now() < drainDeadline) await delay(5);
        assert.equal(keyedTaskDepth(statusKey), 0, "the disconnected report actually finished its writes");
        assert.equal((await replacement).hostId, hostId);
        assert.equal((await rules.getById({ id: 1 })).isRunning, false, "a disconnected predecessor cannot restore running state after takeover");
        assert.equal((await heartbeat(b)).agentSuperseded, true);
        assert.equal((await post("/api/agent/rule-status", c, { ruleId: 1, success: true, isRunning: true })).success, true);
        assert.equal((await rules.getById({ id: 1 })).isRunning, true, "current installation can still confirm runtime");
      } finally {
        oldReport.destroy();
        unblockStatus();
        await blocker;
      }

      for (const mode of ["finish", "next-error", "reject"]) {
        lifecycleOrder = [];
        lifecycleWork = new Promise((resolve) => { completeLifecycle = resolve; });
        let registration;
        try {
          const response = await fetch(base + "/installation-fence-test", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify(encryptPayload({ installationId: c, mode }, token)),
            signal: AbortSignal.timeout(5_000),
          });
          assert.equal(response.status, mode === "finish" ? 200 : 503);
          const body = decryptPayload(await response.json(), token, { validateTimestamp: false });
          if (mode === "next-error") assert.equal(body.error, "forwarded handler error", "next(error) reaches Express before the handler settles");
          if (mode === "reject") assert.equal(body.error, "rejected handler", "async rejection reaches Express 4");
          registration = register(c).then(() => lifecycleOrder.push("registration completed"));
          await Promise.race([registration, delay(100)]);
        } finally { completeLifecycle(); }
        await registration;
        assert.deepEqual(lifecycleOrder, mode === "reject"
          ? ["registration completed"]
          : ["handler settled", "registration completed"], mode + " must release ownership only after actual handler completion");
      }
      await closeDatabase(); await connectDatabase(config); await ensureDatabaseSchema();
      assert.equal((await register(a)).agentSuperseded, true, "retirement survives reopening the database");
      await assert.rejects(() => foreign.getInstallToken({ id: tokenId }), /无权/);
    } finally {
      server.closeAllConnections();
      if (server.listening) await new Promise((resolve) => server.close(resolve));
      await closeDatabase();
    }
  `;
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      cwd: process.cwd(), encoding: "utf8", timeout: 60_000,
      env: { ...process.env, DATABASE_TYPE: process.env.FORWARDX_INSTALLATION_TEST_DATABASE ? JSON.parse(process.env.FORWARDX_INSTALLATION_TEST_DATABASE).type : "sqlite", FORWARDX_TEST_DB: path.join(directory, "installation.db"), FORWARDX_DEV_PANEL: "1", JWT_SECRET: "installation-test-secret-with-more-than-32-characters", FORWARDX_LOG_DIR: directory },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
