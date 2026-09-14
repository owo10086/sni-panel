import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getPortOccupancy, inspectPortOccupancy, receivePortOccupancy, MAX_PORT_OCCUPANCY_RECEIVE_BYTES } from "./portOccupancy";

test("covered protocols decide whether a rule port was verified", () => {
  const now = 2_000_000;
  assert.equal(receivePortOccupancy(9001, { schemaVersion: 2, signature: "a1", collected: true,
    snapshot: { listeners: [], covered: [{ port: 443, protocol: "tcp" }], collectedAt: now } }, now).verified, true);
  assert.equal(inspectPortOccupancy(getPortOccupancy(9001, now), 443, "tcp").status, "free");
  assert.equal(inspectPortOccupancy(getPortOccupancy(9001, now), 443, "both").status, "unverified");
  assert.equal(inspectPortOccupancy(getPortOccupancy(9001, now), 444, "tcp").status, "unverified");
  assert.equal(getPortOccupancy(9001, now + 10 * 60 * 1000 - 1)?.covered.length, 1);
  assert.equal(getPortOccupancy(9001, now + 10 * 60 * 1000 + 1), null);
});

test("invalid version and rejected snapshots cannot reactivate a cached listener through summaries", () => {
  const now = 3_000_000;
  const valid = { listeners: [{ port: 443, protocol: "tcp", address: "127.0.0.1", process: "code" }],
    covered: [{ port: 443, protocol: "tcp" }], collectedAt: now };
  receivePortOccupancy(9002, { schemaVersion: 2, signature: "a1", collected: true, snapshot: valid }, now);
  assert.equal(receivePortOccupancy(9002, { signature: "a1", collected: true }, now + 1).requestPortOccupancy, false);
  assert.equal(getPortOccupancy(9002, now + 1), null);
  const invalid = { ...valid, covered: [] };
  assert.equal(receivePortOccupancy(9002, { schemaVersion: 2, signature: "a2", collected: true, snapshot: invalid }, now + 2).requestPortOccupancy, false);
  assert.equal(receivePortOccupancy(9002, { schemaVersion: 2, signature: "a2", collected: true }, now + 299_999).requestPortOccupancy, false);
  assert.equal(receivePortOccupancy(9002, { schemaVersion: 2, signature: "a2", collected: true }, now + 300_002).requestPortOccupancy, true);
  assert.equal(receivePortOccupancy(9002, { schemaVersion: 2, signature: "a2", collected: true }, now + 300_003).requestPortOccupancy, false);
  assert.equal(getPortOccupancy(9002, now + 300_003), null);
  assert.equal(receivePortOccupancy(9002, { schemaVersion: 2, signature: "a3", collected: true,
    snapshot: { ...valid, collectedAt: now + 300_004 } }, now + 300_004).verified, true);
  assert.equal(inspectPortOccupancy(getPortOccupancy(9002, now + 300_004), 443, "tcp").status, "occupied");
  const source = fs.readFileSync(path.join(process.cwd(), "agent/port_occupancy.go"), "utf8");
  const agentLimit = Number(source.match(/const maxPortOccupancyBytes = (\d+) \* 1024/)?.[1]) * 1024;
  assert.ok(MAX_PORT_OCCUPANCY_RECEIVE_BYTES >= agentLimit);
});

test("panel accepts more than 256 listeners across ports but rejects an oversized single port", () => {
  const collectedAt = Date.now();
  const listener = (port: number) => ({ port, protocol: "tcp", address: "127.0.0.1" });
  const snapshot = { listeners: [...Array.from({ length: 255 }, () => listener(11127)), listener(11128), listener(11128)],
    covered: [{ port: 11127, protocol: "tcp" }, { port: 11128, protocol: "tcp" }], collectedAt };
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) <= 16 * 1024);
  assert.equal(receivePortOccupancy(9003, { schemaVersion: 2, signature: "a1", collected: true, snapshot }).verified, true);
  assert.equal(getPortOccupancy(9003)?.listeners.length, 257);
  const oversized = { ...snapshot, listeners: Array.from({ length: 257 }, () => listener(11127)) };
  assert.equal(receivePortOccupancy(9004, { schemaVersion: 2, signature: "a2", collected: true, snapshot: oversized }).verified, false);
  assert.equal(getPortOccupancy(9004), null);
});

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
    const { getPortOccupancy, inspectPortOccupancy } = await import(moduleUrl("server/portOccupancy.ts"));
    const { getRulePortWarnings } = await import(moduleUrl("server/rulePortOccupancy.ts"));
    const { recordRulePortFailure } = await import(moduleUrl("server/rulePortFailure.ts"));
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
      const initial = await post({ portOccupancySchemaVersion: 2, portOccupancySignature: "abc1", portOccupancyCollected: true,
        localStateSignature: "abc1", localState: { rules: [{ port: 11128, ruleId: 600, forwardType: "gost", protocol: "tcp", ready: false }] },
        portOccupancy: { listeners: [
          { port: 11127, protocol: "tcp", address: "127.0.0.1", process: "code" },
          { port: 11128, protocol: "tcp", address: "127.0.0.1", process: "other-process" },
        ], covered: [{ port: 11127, protocol: "tcp" }, { port: 11128, protocol: "tcp" }], collectedAt } });
      assert.ok(initial.portRuleManifest.some((entry) => entry.ruleId === 600 && entry.port === 11128));
      assert.ok(initial.portRuleManifest.some((entry) => entry.ruleId === 601 && entry.port === 11127));
      assert.match(getRulePortWarnings(601, true)[0].message, /code/);
      assert.equal(inspectPortOccupancy(getPortOccupancy(1), 11127, "both").status, "unverified");
      assert.deepEqual((await caller.getById({ id: 600 })).portOccupancyWarnings, []);
      recordRulePortFailure(600, "port 11128 occupied by other-process");
      assert.match((await caller.getById({ id: 600 })).portBindFailure, /other-process/);
      const ordinaryCaller = rulesRouter.createCaller({ req: { headers: {} }, res: { clearCookie() {} },
        user: { id: 1, username: "owner", role: "user", accountEnabled: true }, authSession: null, authFailureReason: null });
      assert.doesNotMatch(JSON.stringify((await ordinaryCaller.getById({ id: 600 })).portBindFailure), /other-process/);
      const first = await caller.checkPort({ hostId: 1, sourcePort: 11127, protocol: "tcp", forwardType: "iptables", excludeRuleId: 601 });
      assert.deepEqual(first, { used: false });
      const verifiedAt = getPortOccupancy(1).verifiedAt;
      const stable = await post({ forceReconcile: false, portRuleManifestSignature: initial.portRuleManifestSignature,
        portOccupancySchemaVersion: 2, portOccupancySignature: "abc1", portOccupancyCollected: true });
      assert.equal(stable.requestPortOccupancy, false);
      assert.equal(stable.reconciliationCoalesced, true);
      assert.equal(getPortOccupancy(1).collectedAt, collectedAt);
      assert.ok(getPortOccupancy(1).verifiedAt >= verifiedAt);
      const missing = await post({ forceReconcile: false, portOccupancySchemaVersion: 2,
        portOccupancySignature: "abc2", portOccupancyCollected: true });
      assert.equal(missing.requestPortOccupancy, true);
      assert.equal(getPortOccupancy(1), null);
      assert.deepEqual((await caller.getById({ id: 601 })).portOccupancyWarnings, []);
      const changed = await post({ forceReconcile: false, portOccupancySchemaVersion: 2,
        portOccupancySignature: "abc2", portOccupancyCollected: true,
        portOccupancy: { listeners: [{ port: 11127, protocol: "tcp", address: "127.0.0.1", process: "new-owner" }],
          covered: [{ port: 11127, protocol: "tcp" }], collectedAt: Date.now() } });
      assert.equal(changed.requestPortOccupancy, false);
      assert.match(getRulePortWarnings(601, true)[0].message, /new-owner/);
      const partial = await post({ portOccupancySchemaVersion: 2, portOccupancySignature: "abc2b", portOccupancyCollected: true,
        portOccupancy: { listeners: [], covered: [], collectedAt: Date.now() } });
      assert.equal(partial.requestPortOccupancy, false);
      assert.deepEqual((await caller.getById({ id: 601 })).portOccupancyWarnings, []);
      assert.match(getRulePortWarnings(601, true)[0].message, /new-owner/);
      const rejected = await post({ portOccupancySchemaVersion: 2, portOccupancySignature: "abc2c", portOccupancyCollected: true,
        portOccupancy: { listeners: [{ port: 11127, protocol: "tcp", address: "127.0.0.1" }],
          covered: [], collectedAt: Date.now() } });
      assert.equal(rejected.requestPortOccupancy, false);
      const rejectedSummary = await post({ portOccupancySchemaVersion: 2, portOccupancySignature: "abc2c", portOccupancyCollected: true });
      assert.equal(rejectedSummary.requestPortOccupancy, false);
      assert.equal(getPortOccupancy(1), null);
      await post({ portOccupancySchemaVersion: 2, portOccupancySignature: "abc3", portOccupancyCollected: true,
        localStateSignature: "abc2", localState: { rules: [{ port: 11128, ruleId: 600, forwardType: "gost", protocol: "tcp", ready: true }] },
        portOccupancy: { listeners: [], covered: [{ port: 11127, protocol: "tcp" }], collectedAt: Date.now() } });
      recordRulePortFailure(600, "");
      assert.equal((await caller.getById({ id: 600 })).portBindFailure, null);
      assert.deepEqual((await caller.getById({ id: 601 })).portOccupancyWarnings, []);
      await post({ portOccupancySchemaVersion: 2, portOccupancySignature: "abc3", portOccupancyCollected: false });
      assert.equal(getPortOccupancy(1), null);
      await insert("forward_rules", ["id", "hostId", "name", "forwardType", "protocol", "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning"],
        [602, 1, "never-applied", "gost", "tcp", 11129, "203.0.113.5", 80, 1, 1, 0]);
      const { recordConfigAuditEvent } = await import(moduleUrl("server/configAudit.ts"));
      await recordConfigAuditEvent({ resourceType: "forward_rule", resourceId: 602, hostId: 1, action: "create",
        after: { id: 602, sourcePort: 11129 } });
      const newer = await post({ portOccupancySchemaVersion: 2, portOccupancySignature: "abc3", portOccupancyCollected: false,
        portRuleManifestSignature: initial.portRuleManifestSignature });
      assert.ok(newer.portRuleManifestRevision > initial.portRuleManifestRevision);
      assert.ok(newer.portRuleManifest.some((entry) => entry.ruleId === 602 && entry.port === 11129));
      const restartedManifest = await import(moduleUrl("server/portRuleManifest.ts") + "?panel-restart");
      const afterRestart = await restartedManifest.buildPortRuleManifest(1, initial.portRuleManifestSignature);
      assert.ok(afterRestart.portRuleManifestRevision > initial.portRuleManifestRevision);
      assert.ok(afterRestart.portRuleManifest.some((entry) => entry.ruleId === 602 && entry.port === 11129));
      await insert("hosts", ["id", "name", "ip", "ipv4", "userId", "isOnline", "lastHeartbeat", "portRangeStart", "portRangeEnd"],
        [2, "exit", "198.51.100.6", "198.51.100.6", 1, 1, Math.floor(Date.now() / 1000), 24000, 26000]);
      await insert("tunnels", ["id", "name", "entryHostId", "exitHostId", "mode", "listenPort", "userId", "isEnabled"],
        [30, "tunnel", 1, 2, "tls", 24000, 1, 1]);
      await insert("forward_rules", ["id", "hostId", "tunnelId", "tunnelExitPort", "name", "forwardType", "protocol", "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning"],
        [603, 1, 30, 24000, "primary", "gost", "tcp", 11130, "203.0.113.5", 80, 1, 1, 1]);
      await insert("forward_rules", ["id", "hostId", "tunnelId", "tunnelExitPort", "name", "forwardType", "protocol", "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning"],
        [604, 1, 30, 25001, "secondary", "gost", "tcp", 11131, "203.0.113.5", 80, 1, 1, 0]);
      const { buildPortRuleManifest, effectiveRuleEntryPortsForHost } = await import(moduleUrl("server/portRuleManifest.ts"));
      const exitManifest = await buildPortRuleManifest(2);
      const secondary = await runtime.queryRaw('SELECT * FROM "forward_rules" WHERE "id" = ?', [604]);
      const tunnel = await runtime.queryRaw('SELECT * FROM "tunnels" WHERE "id" = ?', [30]);
      const effectivePort = effectiveRuleEntryPortsForHost(secondary[0], 2, { tunnel: tunnel[0], primaryRuleId: 603 })[0];
      assert.equal(effectivePort, 25001);
      assert.equal(exitManifest.portRuleManifest.find((entry) => entry.ruleId === 604).port, effectivePort);
      await runtime.executeRaw('UPDATE "forward_rules" SET "tunnelExitPort" = ? WHERE "id" = 604', [25002]);
      await recordConfigAuditEvent({ resourceType: "forward_rule", resourceId: 604, hostId: 2, action: "update",
        before: { tunnelExitPort: 25001 }, after: { tunnelExitPort: 25002 } });
      const changedExit = await buildPortRuleManifest(2, exitManifest.portRuleManifestSignature);
      assert.ok(changedExit.portRuleManifestRevision > exitManifest.portRuleManifestRevision);
      assert.equal(changedExit.portRuleManifest.find((entry) => entry.ruleId === 604).port, 25002);
      await insert("hosts", ["id", "name", "ip", "ipv4", "userId", "isOnline", "lastHeartbeat", "agentVersion", "portRangeStart", "portRangeEnd"],
        [6, "sni-entry", "198.51.100.16", "198.51.100.16", 1, 1, Math.floor(Date.now() / 1000), "2.2.195", 18000, 19000]);
      await insert("hosts", ["id", "name", "ip", "ipv4", "userId", "isOnline", "lastHeartbeat", "agentVersion", "portRangeStart", "portRangeEnd"],
        [7, "sni-exit", "198.51.100.17", "198.51.100.17", 1, 1, Math.floor(Date.now() / 1000), "2.2.195", 24000, 24010]);
      await insert("tunnels", ["id", "name", "entryHostId", "exitHostId", "mode", "listenPort", "userId", "isEnabled"],
        [31, "sni-tunnel", 6, 7, "tls", 21000, 1, 1]);
      for (const [id, sni] of [[606, "api.example.com"], [607, "web.example.com"]]) {
        await insert("forward_rules", ["id", "hostId", "tunnelId", "tunnelExitPort", "name", "forwardType", "protocol", "sourcePort", "sni", "sniSplitterPort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning"],
          [id, 6, 31, 24005, sni, "gost", "tcp", 18443, sni, 24000, "203.0.113.5", 443, 1, 1, 0]);
      }
      const sniEntryManifest = await buildPortRuleManifest(6);
      const sniExitManifest = await buildPortRuleManifest(7);
      for (const ruleId of [606, 607]) {
        assert.deepEqual(sniEntryManifest.portRuleManifest.filter((entry) => entry.ruleId === ruleId).map((entry) => entry.port), [18443]);
        assert.deepEqual(sniExitManifest.portRuleManifest.filter((entry) => entry.ruleId === ruleId).map((entry) => entry.port), [24000, 24005]);
      }
      assert.ok(!sniExitManifest.portRuleManifest.some((entry) => entry.port === 21000));
      const sniRule = (await runtime.queryRaw('SELECT * FROM "forward_rules" WHERE "id" = ?', [606]))[0];
      const sniTunnel = (await runtime.queryRaw('SELECT * FROM "tunnels" WHERE "id" = ?', [31]))[0];
      assert.deepEqual(effectiveRuleEntryPortsForHost(sniRule, 7, { tunnel: sniTunnel, primaryRuleId: 606 }), [24005, 24000]);
      await insert("hosts", ["id", "name", "ip", "ipv4", "userId", "isOnline", "lastHeartbeat", "portRangeStart", "portRangeEnd"],
        [3, "disabled-extra-exit", "198.51.100.7", "198.51.100.7", 1, 1, Math.floor(Date.now() / 1000), 24000, 26000]);
      await insert("tunnel_exit_nodes", ["id", "tunnelId", "seq", "hostId", "listenPort", "isEnabled"],
        [301, 30, 1, 3, 24001, 1]);
      await runtime.executeRaw('UPDATE "tunnels" SET "loadBalanceEnabled" = 1, "loadBalanceStrategy" = ? WHERE "id" = 30', ["none"]);
      const disabledExit = await buildPortRuleManifest(3);
      assert.deepEqual(disabledExit.portRuleManifest, []);
      await insert("users", ["id", "username", "password", "role"], [2, "member", "x", "user"]);
      await insert("hosts", ["id", "name", "ip", "ipv4", "userId", "isOnline", "lastHeartbeat", "portRangeStart", "portRangeEnd"],
        [5, "shared-entry", "198.51.100.8", "198.51.100.8", 1, 1, Math.floor(Date.now() / 1000), 11000, 12000]);
      await insert("user_host_permissions", ["userId", "hostId"], [2, 5]);
      await insert("forward_rules", ["id", "hostId", "name", "forwardType", "protocol", "sourcePort", "targetIp", "targetPort", "userId", "isEnabled"],
        [605, 5, "permitted", "iptables", "tcp", 11132, "203.0.113.5", 80, 2, 1]);
      assert.ok((await buildPortRuleManifest(5)).portRuleManifest.some((entry) => entry.ruleId === 605));
      await runtime.executeRaw('DELETE FROM "user_host_permissions" WHERE "userId" = 2 AND "hostId" = 5');
      await new Promise((resolve) => setTimeout(resolve, 1100));
      assert.deepEqual((await buildPortRuleManifest(5)).portRuleManifest, []);
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

test("inactive rules release occupancy state without a current snapshot across group hosts", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-occupancy-cleanup-"));
  const databasePath = path.join(directory, "cleanup.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(moduleUrl("server/dbRuntime.ts"));
    const schema = await import(moduleUrl("server/dbSchema.ts"));
    const { rulesRouter } = await import(moduleUrl("server/routers/rules.ts"));
    const { receivePortOccupancy, getPortOccupancy } = await import(moduleUrl("server/portOccupancy.ts"));
    const { refreshRulePortWarningsForHost, getRulePortWarnings } = await import(moduleUrl("server/rulePortOccupancy.ts"));
    const { portOccupancyNotificationTransition } = await import(moduleUrl("server/forwardRuleErrorNotifier.ts"));
    const insert = async (table, columns, values) => runtime.executeRaw(
      'INSERT INTO "' + table + '" (' + columns.map((column) => '"' + column + '"').join(',') + ') VALUES (' + values.map(() => '?').join(',') + ')', values);
    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      const now = Math.floor(Date.now() / 1000);
      await insert("users", ["id", "username", "password", "role", "canAddRules"], [1, "admin", "x", "admin", 1]);
      for (const [id, port] of [[1, 11000], [2, 22000]]) {
        await insert("hosts", ["id", "name", "ip", "ipv4", "userId", "isOnline", "lastHeartbeat", "portRangeStart", "portRangeEnd"],
          [id, "host-" + id, "198.51.100." + id, "198.51.100." + id, 1, 1, now, port, port + 999]);
      }
      await insert("forward_groups", ["id", "name", "groupType", "groupMode", "domain", "targetIp", "userId", "isEnabled"],
        [10, "entry-group", "host", "entry", "", "0.0.0.0", 1, 1]);
      for (const [id, hostId] of [[101, 1], [102, 2]]) {
        await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"],
          [id, 10, "host", hostId, id, 1]);
      }
      const columns = ["id", "hostId", "name", "forwardType", "protocol", "forwardGroupId", "forwardGroupRuleId",
        "forwardGroupMemberId", "isForwardGroupTemplate", "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning"];
      for (const [id, hostId, parent, member, template, port] of [
        [501, 1, null, null, 0, 11127], [503, 2, null, null, 0, 22229], [504, 1, null, null, 0, 11130],
        [600, 1, null, null, 1, 11128], [601, 1, 600, 101, 0, 11128], [602, 2, 600, 102, 0, 22228],
      ]) {
        await insert("forward_rules", columns, [id, hostId, "rule-" + id, "iptables", "tcp", parent ? 10 : template ? 10 : null,
          parent, member, template, port, "203.0.113.5", 80, 1, 1, 1]);
      }
      const snapshot = (hostId, ports) => receivePortOccupancy(hostId, { schemaVersion: 2, signature: String(hostId),
        collected: true, snapshot: { listeners: ports.map((port) => ({ port, protocol: "tcp", address: "127.0.0.1", process: "external" })),
          covered: ports.map((port) => ({ port, protocol: "tcp" })), collectedAt: Date.now() } });
      assert.equal(snapshot(1, [11127, 11128, 11130]).verified, true);
      assert.equal(snapshot(2, [22228, 22229]).verified, true);
      await refreshRulePortWarningsForHost(1);
      await refreshRulePortWarningsForHost(2);
      assert.equal(getRulePortWarnings(501, true).length, 1);
      assert.equal(getRulePortWarnings(600, true).length, 2);
      const time = Date.now() - 600_000;
      const keys = ["501:1:11127:tcp", "503:2:22229:tcp", "504:1:11130:tcp", "600:1:11128:tcp", "600:2:22228:tcp"];
      for (const key of keys) assert.equal(portOccupancyNotificationTransition(key, "owner", true, time), "occupied");
      for (const hostId of [1, 2]) {
        receivePortOccupancy(hostId, { schemaVersion: 2, collected: false });
        assert.equal(getPortOccupancy(hostId), null);
        await refreshRulePortWarningsForHost(hostId);
      }
      assert.equal(getRulePortWarnings(501, true).length, 1);
      assert.equal(portOccupancyNotificationTransition(keys[0], "owner", true, time + 1), null);
      assert.equal(portOccupancyNotificationTransition(keys[3], "owner", true, time + 1), null);
      const caller = rulesRouter.createCaller({ req: { headers: {} }, res: { clearCookie() {} },
        user: { id: 1, username: "admin", role: "admin", accountEnabled: true }, authSession: null, authFailureReason: null });
      assert.deepEqual((await caller.getById({ id: 501 })).portOccupancyWarnings, []);
      await caller.toggle({ id: 501, isEnabled: false });
      assert.deepEqual(getRulePortWarnings(501, true), []);
      assert.equal(portOccupancyNotificationTransition(keys[0], "owner", true, time + 2), "occupied");
      await caller.delete({ id: 503 });
      assert.deepEqual(getRulePortWarnings(503, true), []);
      assert.equal(portOccupancyNotificationTransition(keys[1], "owner", true, time + 2), "occupied");
      await caller.delete({ id: 600 });
      assert.deepEqual(getRulePortWarnings(600, true), []);
      assert.equal(portOccupancyNotificationTransition(keys[3], "owner", true, time + 2), "occupied");
      assert.equal(portOccupancyNotificationTransition(keys[4], "owner", true, time + 2), "occupied");
      assert.equal(portOccupancyNotificationTransition(keys[2], "owner", true, time + 2), null);
    } finally {
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
