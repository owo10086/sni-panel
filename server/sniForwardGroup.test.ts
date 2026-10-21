import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function verifySniImportScenario(scenario: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-sni-import-"));
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "server/test-support/sniImportHarness.mjs", scenario], {
      cwd: process.cwd(), encoding: "utf8", timeout: 60_000,
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "test.db"), FORWARDX_LOG_DIR: path.join(directory, "logs") },
    });
    assert.equal(result.status, 0, result.error?.message || result.stderr + result.stdout);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("SNI import distinguishes omitted limits from explicit administrator-managed zero limits", () => {
  verifySniImportScenario("baseline-control");
});

test("SNI import creates one complete configuration refresh per entrance and preserves confirmed shared routes", () => {
  verifySniImportScenario("sync");
});

test("SNI import skips zero-limit refresh while preserving managed access, first traffic and actual limits", () => {
  verifySniImportScenario("limits");
});

test("Zero-limit creation preserves configurations and managed meaning for ordinary rules, chains and direct TLS tunnels", () => {
  verifySniImportScenario("cross-resource");
});

test("SNI import preserves successful items and rolls back incomplete member writes without notifications", () => {
  verifySniImportScenario("partial-failure");
});

function verifySniGroupDeletion(body: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-sni-group-delete-"));
  const script = String.raw`
    import assert from "node:assert/strict";
    import http from "node:http";
    import express from "express";
    import * as runtime from "./server/dbRuntime.ts";
    import { ensureDatabaseSchema } from "./server/dbSchema.ts";
    import { rulesRouter } from "./server/routers/rules.ts";
    import * as groups from "./server/repositories/forwardGroupRepository.ts";
    import * as savedRules from "./server/repositories/forwardRuleRepository.ts";
    import * as settings from "./server/repositories/settingsRepository.ts";
    import * as users from "./server/repositories/userRepository.ts";
    import * as billing from "./server/repositories/trafficBillingRepository.ts";
    import { registerAgentHeartbeatRoute } from "./server/agentHeartbeatRoute.ts";
    import { trafficBillingUserLockKey, withKeyedTaskLock } from "./server/keyedTaskLock.ts";
    const insert = (table, values) => runtime.executeRaw(
      'INSERT INTO "' + table + '" (' + Object.keys(values).map(k => '"' + k + '"').join(',') + ') VALUES (' + Object.keys(values).map(() => '?').join(',') + ')', Object.values(values));
    const context = user => ({ req: { headers: {} }, res: { clearCookie() {} }, user, authSession: null, authFailureReason: null });
    const admin = rulesRouter.createCaller(context({ id: 1, username: "admin", role: "admin", accountEnabled: true }));
    const within = async (work, label) => {
      const watchdog = setTimeout(() => { console.error(label + " did not finish within 5 seconds"); process.exit(2); }, 5000);
      try { return await work; } finally { clearTimeout(watchdog); }
    };
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.agentToken = String(req.headers.authorization || "").replace("Bearer ", ""); next(); });
    registerAgentHeartbeatRoute(app);
    const server = http.createServer(app);
    let beforeHeartbeat = () => {};
    const heartbeat = async (id, localRules = []) => {
      beforeHeartbeat();
      const response = await fetch("http://127.0.0.1:" + server.address().port + "/api/agent/heartbeat", {
        method: "POST", headers: { authorization: "Bearer token-" + id, "content-type": "application/json" },
        body: JSON.stringify({ agentVersion: "3.3.0", agentBootId: "delete-boot-" + id, agentProcessId: 1000 + id, forceReconcile: true, localState: { rules: localRules } }),
      });
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.equal(result.success, true);
      return result;
    };
    const splitter = result => result.desiredState.actions.find(action => action.op === "apply" && action.fxp?.role === "sni-splitter" && action.sourcePort === 18443);
    const localRules = config => config.sniRoutes.map(route => ({ ...route, port: config.listenPort, forwardType: "forwardx", protocol: "tcp", sniRouteVersion: config.sniRouteVersion, sourceAllowIps: [], ready: true }));
    const createRules = async (prefix, count) => {
      const ids = [];
      for (let index = 0; index < count; index++) {
        const rule = await admin.create({ forwardGroupId: 10, name: prefix + "-" + index, sourcePort: 18443, targetIp: "203.0.113.10", targetPort: 19443 + index, sni: prefix + "-" + index + ".example.test", isEnabled: true });
        ids.push(Number(rule.id));
      }
      return ids;
    };
    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await ensureDatabaseSchema();
      await insert("users", { id: 1, username: "admin", password: "x", role: "admin", canAddRules: 1, manualCanAddRules: 1, balanceCents: 1000 });
      await insert("users", { id: 2, username: "other", password: "x", role: "user", canAddRules: 1, manualCanAddRules: 1 });
      for (const id of [1, 2]) await insert("hosts", { id, name: "entrance-" + id, ip: "192.0.2." + id, ipv4: "192.0.2." + id, agentToken: "token-" + id, userId: 1, isOnline: 1, lastHeartbeat: Math.floor(Date.now() / 1000), agentVersion: "3.3.0", portRangeStart: 18000, portRangeEnd: 19000 });
      await insert("forward_groups", { id: 10, name: "delete-test", groupType: "host", groupMode: "failover", forwardType: "nftables", domain: "", targetIp: "0.0.0.0", targetPort: 1, userId: 1, isEnabled: 1, failoverSeconds: 10, recoverSeconds: 10 });
      for (const id of [1, 2]) await insert("forward_group_members", { id: 100 + id, groupId: 10, memberType: "host", hostId: id, priority: id * 10, isEnabled: 1 });
      await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
      ${body}
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      await runtime.closeDatabase();
    }
    process.exit(0);
  `;
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(), env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "test.db") }, encoding: "utf8", timeout: 60_000,
    });
    assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("SNI group batch deletion completes, preserves unselected routes and removes the final listener", () => {
  verifySniGroupDeletion(String.raw`
    const ids = await createRules("original", 12);
    const initial = [];
    for (const id of [1, 2]) {
      const config = splitter(await heartbeat(id)).fxp;
      assert.equal(config.sniRoutes.length, 12);
      initial.push(config);
      await heartbeat(id, localRules(config));
    }
    const result = await within(admin.deleteBatch({ ids: ids.slice(0, 9) }), "12 rules deleting 9");
    assert.equal(result.success, true);
    assert.equal(result.requested, 9);
    assert.deepEqual(result.deletedIds, ids.slice(0, 9));
    assert.deepEqual(result.failures, []);
    assert.deepEqual((await admin.list()).map(rule => Number(rule.id)).sort((a, b) => a - b), ids.slice(9));
    for (const id of ids.slice(0, 9)) assert.equal(await savedRules.getForwardRuleById(id), undefined);
    const remaining = [];
    for (const id of [1, 2]) {
      const config = splitter(await within(heartbeat(id, localRules(initial[id - 1])), "heartbeat after deletion")).fxp;
      assert.deepEqual(config.sniRoutes.map(route => route.sni).sort(), ["original-10.example.test", "original-11.example.test", "original-9.example.test"]);
      remaining.push(config);
      await heartbeat(id, localRules(config));
    }
    const children = await savedRules.getForwardGroupChildRules(10);
    assert.equal(children.filter(rule => !rule.pendingDelete).length, 6);
    assert.ok(children.filter(rule => !rule.pendingDelete).every(rule => ids.slice(9).includes(Number(rule.forwardGroupRuleId))));
    await within(settings.setSetting("batchDeleteProgress", "saved"), "database write after deletion");
    assert.equal(await settings.getSetting("batchDeleteProgress"), "saved");
    await within(admin.deleteBatch({ ids: ids.slice(9) }), "deleting the remaining domains");
    for (const id of [1, 2]) {
      const result = await heartbeat(id, localRules(remaining[id - 1]));
      assert.equal(splitter(result), undefined);
      assert.ok(result.desiredState.actions.some(action => action.op === "remove" && action.fxp?.role === "sni-splitter" && action.sourcePort === 18443));
      await heartbeat(id, []);
    }
    for (let attempt = 0; attempt < 10; attempt++) {
      const small = await createRules("repeat-" + attempt, 4);
      const deleted = await within(admin.deleteBatch({ ids: small }), "4 rules deleting all, attempt " + attempt);
      assert.equal(deleted.success, true);
      assert.deepEqual(deleted.deletedIds, small);
      assert.deepEqual(deleted.failures, []);
      assert.deepEqual(await admin.list(), []);
      await within(settings.setSetting("batchDeleteProgress", String(attempt)), "database write after repeated deletion");
      assert.equal(await settings.getSetting("batchDeleteProgress"), String(attempt));
    }
  `);
});

test("SNI member removal commits before waiting for billing and sends no refresh on rollback", () => {
  verifySniGroupDeletion(String.raw`
    const ids = await createRules("managed", 1);
    const children = await savedRules.getForwardGroupChildRulesForTemplate(ids[0]);
    const removed = children.find(rule => Number(rule.hostId) === 1);
    await billing.setTrafficBillingEnabled(true);
    await billing.upsertTrafficBillingConfig({ resourceType: "forward_group", resourceId: 10, enabled: true, requiresPermission: false, pricePerGbCents: 100, multiplier: 100 });
    await billing.billTrafficUsage({ userId: 1, ruleId: Number(removed.id), bytes: 268435456, resourceType: "forward_group", resourceId: 10 });
    const { registerAgentEventClient } = await import("./server/agentEvents.ts");
    const { decryptPayload } = await import("./server/agentCrypto.ts");
    const eventNow = Date.now() + 5000;
    Date.now = () => eventNow;
    let events;
    app.get("/test-events", (_req, res) => {
      res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      res.flushHeaders();
      events = registerAgentEventClient(1, "token-1", res);
    });
    const response = await fetch("http://127.0.0.1:" + server.address().port + "/test-events");
    const reader = response.body.getReader();
    const checkpoint = async label => {
      events.writeComment(label);
      let frames = "";
      while (!frames.includes(": " + label + "\n\n")) {
        const chunk = await reader.read();
        assert.equal(chunk.done, false);
        frames += Buffer.from(chunk.value).toString("utf8");
      }
      return frames.split("\n").filter(line => line.startsWith("data: "))
        .map(line => decryptPayload(JSON.parse(line.slice(6)), "token-1").type);
    };
    const remainingMembers = [{ memberType: "host", hostId: 2, priority: 20, isEnabled: true }];
    try {
      const { withGroupMemberMutation } = await import("./server/groupMemberMutation.ts");
      await assert.rejects(() => within(withGroupMemberMutation(() => groups.withForwardGroupSyncTransaction(10, async () => {
        // Intentionally omit deferRefresh: the cleanup boundary must detect the transaction itself.
        await groups.replaceForwardGroupMembers(10, remainingMembers, { skipSync: true });
        throw new Error("intentional rollback");
      })), "member removal rollback"), /intentional rollback/);
      assert.equal((await savedRules.getForwardRuleById(Number(removed.id))).pendingDelete, false);
      assert.deepEqual((await groups.getForwardGroupById(10)).members.map(member => Number(member.hostId)).sort(), [1, 2]);
      assert.deepEqual(await billing.listTrafficBillingRecords({ userId: 1 }), []);
      assert.equal((await users.getUserById(1)).balanceCents, 1000);
      assert.deepEqual(await within(checkpoint("rollback-checked"), "rollback event checkpoint"), []);

      const held = Promise.withResolvers();
      const release = Promise.withResolvers();
      const committed = Promise.withResolvers();
      const billingTask = withKeyedTaskLock(trafficBillingUserLockKey(1), async () => {
        held.resolve();
        await release.promise;
      });
      await held.promise;
      let finished = false;
      const save = withGroupMemberMutation(() => groups.withForwardGroupSyncTransaction(10, async () => {
        await runtime.afterDatabaseCommit(() => { committed.resolve(); });
        await groups.replaceForwardGroupMembers(10, remainingMembers, { skipSync: true });
      })).finally(() => { finished = true; });
      try {
        await within(committed.promise, "database commit with billing held");
        await within(users.updateUserProfile(1, { name: "database available" }), "independent write while billing waits");
        assert.equal((await users.getUserById(1)).name, "database available");
        assert.equal((await savedRules.getForwardRuleById(Number(removed.id))).pendingDelete, true);
        assert.equal((await users.getUserById(1)).balanceCents, 1000);
        assert.deepEqual(await billing.listTrafficBillingRecords({ userId: 1 }), []);
        assert.equal(finished, false, "settlement must still wait for the billing task");
        assert.deepEqual(await within(checkpoint("commit-checked"), "commit event checkpoint"), []);
      } finally {
        release.resolve();
        await billingTask;
      }
      await within(save, "member removal after billing release");
      assert.equal((await users.getUserById(1)).balanceCents, 975);
      const records = await billing.listTrafficBillingRecords({ userId: 1 });
      assert.equal(records.length, 1);
      assert.equal(records[0].amountCents, 25);
      assert.equal(records[0].ruleId, Number(removed.id));
      assert.ok((await within(checkpoint("billing-checked"), "billing event checkpoint")).includes("agent-refresh"));
      await groups.syncForwardGroupRules(10);
      assert.equal((await users.getUserById(1)).balanceCents, 975);
      assert.equal((await billing.listTrafficBillingRecords({ userId: 1 })).length, 1);
    } finally {
      events.close();
      await reader.cancel();
    }
  `);
});

test("SNI batch deletion settles selected usage once and retains low-balance access controls", () => {
  verifySniGroupDeletion(String.raw`
    const ids = await createRules("billing", 12);
    await billing.setTrafficBillingEnabled(true);
    await billing.upsertTrafficBillingConfig({ resourceType: "forward_group", resourceId: 10, enabled: true, requiresPermission: false, pricePerGbCents: 100, multiplier: 100 });
    // Each domain has exactly a quarter GB left to settle, costing 25 cents.
    for (const ruleId of ids) await billing.billTrafficUsage({ userId: 1, ruleId, bytes: 268435456, resourceType: "forward_group", resourceId: 10 });
    assert.equal((await users.getUserById(1)).balanceCents, 1000);
    const deleted = await within(admin.deleteBatch({ ids: ids.slice(0, 9) }), "batch deletion with unsettled usage");
    assert.equal(deleted.success, true);
    assert.deepEqual(deleted.deletedIds, ids.slice(0, 9));
    assert.equal((await users.getUserById(1)).balanceCents, 775);
    let records = await billing.listTrafficBillingRecords({ userId: 1 });
    assert.equal(records.length, 9);
    assert.ok(records.every(record => record.amountCents === 25 && record.bytes === 268435456));
    assert.deepEqual(records.map(record => Number(record.ruleId)).sort((a, b) => a - b), ids.slice(0, 9));
    assert.equal((await billing.getTrafficBillingSummary(1)).totalAmountCents, 225);
    await groups.syncForwardGroupRules(10);
    await groups.syncForwardGroupRules(10);
    assert.equal((await users.getUserById(1)).balanceCents, 775);
    assert.equal((await billing.listTrafficBillingRecords({ userId: 1 })).length, 9);

    const { setUserBalance } = await import("./server/repositories/billingRepository.ts");
    await setUserBalance(1, 10, { type: "adjustment", description: "low balance fixture" });
    const lowBalance = await within(admin.deleteBatch({ ids: [ids[9]] }), "deletion crossing the balance limit");
    assert.equal(lowBalance.success, true);
    assert.deepEqual(lowBalance.deletedIds, [ids[9]]);
    const account = await users.getUserById(1);
    assert.equal(account.balanceCents, -15);
    assert.equal(account.canAddRules, false);
    assert.equal(account.allowForwardXTunnel, false);
    assert.equal(account.forwardAccessPauseReason, "traffic_billing_balance");
    records = await billing.listTrafficBillingRecords({ userId: 1 });
    assert.equal(records.length, 10);
    assert.equal(records.find(record => Number(record.ruleId) === ids[9]).amountCents, 25);
    for (const id of ids.slice(10)) {
      const saved = await admin.getById({ id });
      assert.equal(saved.isEnabled, false);
      assert.equal(saved.disabledByUser, true);
    }
    for (const hostId of [1, 2]) assert.equal(splitter(await heartbeat(hostId)), undefined);
    await groups.syncForwardGroupRules(10);
    assert.equal((await users.getUserById(1)).balanceCents, -15);
    assert.equal((await billing.listTrafficBillingRecords({ userId: 1 })).length, 10);
  `);
});

test("SNI batch deletion reports unauthorized and missing rules while deleting permitted selections", () => {
  verifySniGroupDeletion(String.raw`
    const ids = await createRules("permitted", 5);
    await insert("forward_rules", { id: 9999, hostId: 1, userId: 2, name: "other-owner", sourcePort: 18444, protocol: "tcp", forwardType: "nftables", targetIp: "203.0.113.20", targetPort: 443, isEnabled: 1 });
    const owner = rulesRouter.createCaller(context({ id: 1, username: "admin", role: "user", accountEnabled: true }));
    const result = await within(owner.deleteBatch({ ids: [...ids.slice(0, 4), 9999, 99999, ids[0]] }), "mixed batch deletion");
    assert.equal(result.success, false);
    assert.equal(result.requested, 6, "duplicate selections count only once");
    assert.deepEqual(result.deletedIds, ids.slice(0, 4));
    assert.deepEqual(result.failures.map(item => item.id), [9999, 99999]);
    assert.match(result.failures[0].error, /无权/);
    assert.match(result.failures[1].error, /不存在|已删除/);
    assert.equal((await savedRules.getForwardRuleById(9999)).pendingDelete, false);
    assert.deepEqual((await owner.list()).map(rule => Number(rule.id)), [ids[4]]);
    for (const hostId of [1, 2]) {
      const config = splitter(await heartbeat(hostId)).fxp;
      assert.deepEqual(config.sniRoutes.map(route => route.sni), ["permitted-4.example.test"]);
    }
    await within(settings.setSetting("mixedBatchProgress", "saved"), "database write after a partial result");
    assert.equal(await settings.getSetting("mixedBatchProgress"), "saved");
  `);
});

test("host failover SNI lifecycle preserves readiness, atomic saves, imports and accounting", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-sni-group-"));
  const script = String.raw`
    import assert from "node:assert/strict";
    import http from "node:http";
    import express from "express";
    import * as runtime from "./server/dbRuntime.ts";
    import { ensureDatabaseSchema } from "./server/dbSchema.ts";
    import { parseSniBulkImportText, parseRuleTransferFile, exportRuleForTransfer, RULE_TRANSFER_FILE_KIND, RULE_TRANSFER_FILE_VERSION } from "./client/src/lib/ruleTransfer.ts";
    import { rulesRouter } from "./server/routers/rules.ts";
    import { forwardGroupsRouter } from "./server/routers/forwardGroups.ts";
    import { registerAgentHeartbeatRoute } from "./server/agentHeartbeatRoute.ts";
    import { registerAgentReportRoutes } from "./server/agentReportRoutes.ts";
    let testNow = Date.now();
    Date.now = () => testNow;
    const insert = (table, values) => runtime.executeRaw(
      'INSERT INTO "' + table + '" (' + Object.keys(values).map(k => '"' + k + '"').join(',') + ') VALUES (' + Object.keys(values).map(() => '?').join(',') + ')', Object.values(values));
    const context = user => ({ req: { headers: {} }, res: { clearCookie() {} }, user, authSession: null, authFailureReason: null });
    const admin = rulesRouter.createCaller(context({ id: 1, username: "admin", role: "admin", accountEnabled: true }));
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.agentToken = String(req.headers.authorization || "").replace("Bearer ", ""); next(); });
    registerAgentHeartbeatRoute(app);
    registerAgentReportRoutes(app);
    const server = http.createServer(app);
    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await ensureDatabaseSchema();
      await insert("users", { id: 1, username: "admin", password: "x", role: "admin", canAddRules: 1, manualCanAddRules: 1 });
      const now = Math.floor(Date.now() / 1000);
      for (const id of [1, 2]) await insert("hosts", { id, name: "entrance-" + id, ip: "127.0.0." + id, ipv4: "127.0.0." + id, agentToken: "token-" + id, userId: 1, isOnline: 1, lastHeartbeat: now, agentVersion: "2.2.195", portRangeStart: 18000, portRangeEnd: 19000 });
      await insert("forward_groups", { id: 10, name: "standby", groupType: "host", groupMode: "failover", forwardType: "nftables", domain: "", targetIp: "0.0.0.0", targetPort: 1, userId: 1, isEnabled: 1, failoverSeconds: 10, recoverSeconds: 10 });
      for (const id of [1, 2]) await insert("forward_group_members", { id: 100 + id, groupId: 10, memberType: "host", hostId: id, priority: id * 10, isEnabled: 1 });
      await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
      const heartbeat = async (id, localRules) => {
        const response = await fetch("http://127.0.0.1:" + server.address().port + "/api/agent/heartbeat", {
          method: "POST", headers: { authorization: "Bearer token-" + id, "content-type": "application/json" },
          body: JSON.stringify({ agentVersion: "2.2.195", agentBootId: "boot-" + id, agentProcessId: 1000 + id, forceReconcile: true, ...(localRules ? { localState: { rules: localRules } } : {}) }),
        });
        assert.equal(response.status, 200);
        const result = await response.json();
        assert.equal(result.success, true);
        return result;
      };
      const input = { forwardGroupId: 10, name: "service-a", forwardType: "nftables", protocol: "udp", sourcePort: 18443, targetIp: "127.0.0.1", targetPort: 19443, sni: "A.Example.COM.", rateLimitMbps: 12, maxConnections: 7, isEnabled: true };
      const imported = parseSniBulkImportText("service-a#A.Example.COM.#127.0.0.1#19443\nservice-b#b.example.com#127.0.0.1#19444", 18443);
      assert.equal(imported.ok, true);
      await admin.checkSniImport({ forwardGroupId: 10, sourcePort: 18443, rules: imported.rules.map((rule, index) => ({ sni: rule.sni, lineNumber: index + 1 })) });
      const created = await admin.create({ ...imported.rules[0], ...input });
      const saved = await admin.getById({ id: created.id });
      assert.equal(saved.sni, "a.example.com");
      assert.equal(saved.protocol, "tcp");
      assert.equal(saved.sniSplitterPort, 18443);
      assert.equal(saved.isRunning, false, "saving is not proof that entrances applied the configuration");
      const initial = [];
      for (const id of [1, 2]) {
        const result = await heartbeat(id);
        const splitters = result.desiredState.actions.filter(a => a.op === "apply" && a.fxp?.role === "sni-splitter");
        assert.equal(splitters.length, 1);
        const config = splitters[0].fxp;
        assert.equal(config.listenPort, 18443);
        assert.deepEqual(config.sourceAllowIps, []);
        assert.equal(config.sniRoutes.length, 1);
        assert.equal(config.sniRoutes[0].sni, "a.example.com");
        assert.equal(config.sniRoutes[0].targetIp, "127.0.0.1");
        assert.equal(config.sniRoutes[0].targetPort, 19443);
        assert.equal(config.sniRoutes[0].maxConnections, 7);
        assert.ok(config.sniRoutes[0].limitIn > 0);
        initial.push(config);
      }
      assert.notEqual(initial[0].sniRoutes[0].ruleId, initial[1].sniRoutes[0].ruleId);
      const localRules = config => config.sniRoutes.map(route => ({ ...route, port: config.listenPort, forwardType: "forwardx", protocol: "tcp", sniRouteVersion: config.sniRouteVersion, sourceAllowIps: [], ready: true }));
      await heartbeat(1, localRules(initial[0]));
      await heartbeat(2, localRules(initial[1]));
      const prepared = await admin.getById({ id: created.id });
      assert.equal(prepared.sniRuntime.entries.length, 2);
      assert.ok(prepared.sniRuntime.entries.every(entry => entry.applied));
      if (process.env.FORWARDX_SNI_GROUP_EXPORT) {
        const fs = await import("node:fs");
        fs.mkdirSync(process.env.FORWARDX_SNI_GROUP_EXPORT, { recursive: true });
        initial.forEach((config, index) => fs.writeFileSync(process.env.FORWARDX_SNI_GROUP_EXPORT + "/initial-" + (index + 1) + ".json", JSON.stringify(config)));
      }
      // A second domain shares each entrance's business port.
      const second = await admin.create({ ...input, ...imported.rules[1], rateLimitMbps: 12, maxConnections: 7 });
      const shared = [];
      for (const id of [1, 2]) {
        const result = await heartbeat(id, localRules(initial[id - 1]));
        const splitters = result.desiredState.actions.filter(a => a.op === "apply" && a.fxp?.role === "sni-splitter");
        assert.equal(splitters.length, 1);
        assert.deepEqual(splitters[0].fxp.sniRoutes.map(route => route.sni), ["a.example.com", "b.example.com"]);
        shared.push(splitters[0].fxp);
      }
      await assert.rejects(() => admin.create({ ...input, sourcePort: 18444, sni: "a.example.com" }), /SNI 域名.*冲突/);
      await assert.rejects(() => admin.create({ ...input, sni: null }), /SNI 分流规则.*占用/);
      for (const id of [1, 2]) await heartbeat(id, localRules(shared[id - 1]));
      await admin.delete({ id: created.id });
      const remaining = [];
      for (const id of [1, 2]) {
        const result = await heartbeat(id, localRules(shared[id - 1]));
        const apply = result.desiredState.actions.find(a => a.op === "apply" && a.fxp?.role === "sni-splitter");
        assert.ok(apply);
        assert.equal(apply.sourcePort, 18443);
        assert.deepEqual(apply.fxp.sniRoutes.map(route => route.sni), ["b.example.com"]);
        remaining.push(apply.fxp);
      }
      assert.equal((await admin.getById({ id: second.id })).isRunning, true, "removing the first domain does not stop the other domain");
      if (process.env.FORWARDX_SNI_GROUP_EXPORT) {
        const fs = await import("node:fs");
        shared.forEach((config, index) => fs.writeFileSync(process.env.FORWARDX_SNI_GROUP_EXPORT + "/shared-" + (index + 1) + ".json", JSON.stringify(config)));
        remaining.forEach((config, index) => fs.writeFileSync(process.env.FORWARDX_SNI_GROUP_EXPORT + "/remaining-" + (index + 1) + ".json", JSON.stringify(config)));
      }
      // Destination checks must reach the saved service, even while the entrance listens.
      for (const id of [1, 2]) {
        const result = await heartbeat(id, localRules(remaining[id - 1]));
        const probe = result.runningRules.find(rule => rule.ruleId === remaining[id - 1].sniRoutes[0].ruleId);
        assert.equal(probe.targetIp, "127.0.0.1");
        assert.equal(probe.targetPort, 19444);
        assert.ok(probe.forwardGroupHealth);
      }
      await admin.update({ id: second.id, targetPort: 19445, rateLimitMbps: 15, maxConnections: 8 });
      const staleHeartbeat = await heartbeat(2, localRules(remaining[1]));
      const stale = await admin.getById({ id: second.id });
      assert.equal(stale.sniRuntime.entries.find(entry => entry.hostId === 2).applied, false, "a domain still present with an old destination is not ready");
      // A delayed running-status write must not make an old observed table ready.
      await runtime.executeRaw('UPDATE forward_rules SET isRunning = 1 WHERE forwardGroupRuleId = ? AND hostId = 2', [second.id]);
      assert.equal((await admin.getById({ id: second.id })).sniRuntime.entries.find(entry => entry.hostId === 2).applied, false, "readiness compares the currently saved contents even after a delayed status write");
      const updatedConfig = staleHeartbeat.desiredState.actions.find(a => a.op === "apply" && a.fxp?.role === "sni-splitter").fxp;
      await heartbeat(2, localRules(updatedConfig));
      assert.equal((await admin.getById({ id: second.id })).sniRuntime.entries.find(entry => entry.hostId === 2).applied, true);
      // Entrance readiness follows current splitter contents; destination
      // measurements remain useful history but do not grant that readiness.
      {
        const groups = forwardGroupsRouter.createCaller(context({ id: 1, username: "admin", role: "admin", accountEnabled: true }));
        const report = async (id, config) => {
          const results = config.sniRoutes.map(route => ({ ruleId: route.ruleId, sourcePort: config.listenPort, targetIp: route.targetIp, targetPort: route.targetPort, method: "tcping", latencyMs: 1, probeCount: 1, probeSuccesses: 1, healthStatus: "healthy" }));
          const response = await fetch("http://127.0.0.1:" + server.address().port + "/api/agent/tcping", { method: "POST", headers: { authorization: "Bearer token-" + id, "content-type": "application/json" }, body: JSON.stringify({ results, force: true }) });
          assert.equal(response.status, 200);
        };
        const oldConfigs = [];
        for (const id of [1, 2]) {
          const result = await heartbeat(id, []);
          const config = result.desiredState.actions.find(a => a.op === "apply" && a.fxp?.role === "sni-splitter").fxp;
          oldConfigs.push(config);
          await heartbeat(id, localRules(config));
          await report(id, config);
        }
        await groups.runFailover();
        assert.ok((await groups.list()).find(g => g.id === 10).members.every(m => m.healthStatus === "healthy"));
        await admin.update({ id: second.id, targetIp: "127.0.0.2" });
        const newConfigs = [];
        for (const id of [1, 2]) {
          const result = await heartbeat(id, []);
          const config = result.desiredState.actions.find(a => a.op === "apply" && a.fxp?.role === "sni-splitter").fxp;
          newConfigs.push(config);
          await heartbeat(id, localRules(config));
        }
        await groups.runFailover();
        assert.ok((await groups.list()).find(g => g.id === 10).members.every(m => m.healthStatus === "healthy"), "current applied contents qualify without probing the new destination");
        for (const id of [1, 2]) await report(id, oldConfigs[id - 1]);
        await groups.runFailover();
        assert.ok((await groups.list()).find(g => g.id === 10).members.every(m => m.healthStatus === "healthy"), "late destination reports cannot change entrance readiness");
        for (const id of [1, 2]) await report(id, newConfigs[id - 1]);
        await groups.runFailover();
        assert.ok((await groups.list()).find(g => g.id === 10).members.every(m => m.healthStatus === "healthy"));

        // Change a limit while the DDNS provider is still handling the selected backup.
        const settings = await import("./server/repositories/settingsRepository.ts");
        testNow += 11_000;
        for (const id of [1, 2]) await heartbeat(id, localRules(newConfigs[id - 1]));
        let onDns = async () => {};
        app.post("/test-ddns-race", async (_req, res) => { await onDns(); res.json({ success: true }); });
        await settings.setSettings({ ddnsEnabled: "true", ddnsProvider: "webhook", ddnsWebhookUrl: "http://127.0.0.1:" + server.address().port + "/test-ddns-race", ddnsWebhookMethod: "POST" });
        await groups.updateFields({ id: 10, domain: "race.example.test" });
        await groups.runFailover();
        assert.equal((await groups.list()).find(g => g.id === 10).activeMemberId, 101);
        let concurrentSave;
        onDns = async () => {
          onDns = async () => {};
          concurrentSave = admin.update({ id: second.id, maxConnections: 9 });
          for (let attempt = 0; attempt < 100; attempt++) {
            if ((await admin.getById({ id: second.id })).maxConnections === 9) return;
            await new Promise(resolve => setTimeout(resolve, 10));
          }
          throw new Error("concurrent rule save did not finish before DDNS response");
        };
        await groups.updateFields({ id: 10, members: [{ memberType: "host", hostId: 1, priority: 20 }, { memberType: "host", hostId: 2, priority: 10 }] });
        await groups.runFailover();
        await concurrentSave;
        assert.equal((await groups.list()).find(g => g.id === 10).activeMemberId, 101, "a backup with a superseded readiness decision cannot be committed after DDNS returns");
        await settings.setSettings({ ddnsEnabled: "false", ddnsProvider: "disabled" });
        await groups.updateFields({ id: 10, domain: "", members: [{ memberType: "host", hostId: 1, priority: 10 }, { memberType: "host", hostId: 2, priority: 20 }] });
        await admin.update({ id: second.id, targetIp: "127.0.0.1", maxConnections: 8 });
      }
      if (process.env.FORWARDX_SNI_GROUP_NETWORK === "1") {
        const fs = await import("node:fs");
        const { spawn } = await import("node:child_process");
        const settings = await import("./server/repositories/settingsRepository.ts");
        const groups = forwardGroupsRouter.createCaller(context({ id: 1, username: "admin", role: "admin", accountEnabled: true }));
        const directory = process.env.FORWARDX_SNI_GROUP_EXPORT;
        for (const file of fs.readdirSync(directory).filter(file => /^probe-[12]-/.test(file))) fs.unlinkSync(directory + "/" + file);
        const restored = await admin.create(input);
        const full = [];
        const running = [];
        for (const id of [1, 2]) {
          const result = await heartbeat(id, []);
          full.push(result.desiredState.actions.find(a => a.op === "apply" && a.fxp?.role === "sni-splitter").fxp);
          running.push(result.runningRules);
          fs.writeFileSync(directory + "/shared-" + id + ".json", JSON.stringify(full[id - 1]));
          fs.writeFileSync(directory + "/running-" + id + ".json", JSON.stringify(running[id - 1]));
          await heartbeat(id, localRules(full[id - 1]));
        }
        await admin.toggle({ id: restored.id, isEnabled: false });
        for (const id of [1, 2]) {
          const result = await heartbeat(id, localRules(full[id - 1]));
          const removalAction = result.desiredState.actions.find(a => a.op === "apply" && a.fxp?.role === "sni-splitter");
          const remaining = removalAction.fxp;
          fs.writeFileSync(directory + "/removal-action-" + id + ".json", JSON.stringify(removalAction));
          fs.writeFileSync(directory + "/remaining-" + id + ".json", JSON.stringify(remaining));
        }
        await admin.toggle({ id: restored.id, isEnabled: true });
        for (const id of [1, 2]) {
          const result = await heartbeat(id, []);
          full[id - 1] = result.desiredState.actions.find(a => a.op === "apply" && a.fxp?.role === "sni-splitter").fxp;
          running[id - 1] = result.runningRules;
          await heartbeat(id, localRules(full[id - 1]));
        }
        await Promise.all([1, 2].map(id => new Promise((resolve, reject) => {
          const child = spawn("docker", ["run", "--rm", "--cap-add", "NET_ADMIN", "-v", directory + ":/input", "-v", process.cwd() + "/scripts/verify-sni-forward-group.mjs:/verify.mjs:ro", "--entrypoint", "node", "forwardx-sni-test:20261006", "/verify.mjs", "/input", String(id)], { stdio: "inherit" });
          child.once("error", reject); child.once("exit", code => code === 0 ? resolve() : reject(new Error("network verification failed: " + code)));
        })));
        const dnsRequests = [];
        let rejectDdns = false;
        app.post("/test-ddns", (req, res) => { dnsRequests.push(req.body); if (rejectDdns) res.status(503).json({ error: "simulated DDNS failure" }); else res.json({ success: true }); });
        await settings.setSettings({ ddnsEnabled: "true", ddnsProvider: "webhook", ddnsWebhookUrl: "http://127.0.0.1:" + server.address().port + "/test-ddns", ddnsWebhookMethod: "POST", ddnsTtl: "60" });
        await groups.updateFields({ id: 10, domain: "entry.example.test" });
        const state = async () => {
          await new Promise(resolve => setTimeout(resolve, 350));
          return (await groups.list()).find(group => group.id === 10);
        };
        const reportStage = async stage => {
          for (const id of [1, 2]) {
            const results = JSON.parse(fs.readFileSync(directory + "/probe-" + id + "-" + stage + ".json", "utf8"));
            const response = await fetch("http://127.0.0.1:" + server.address().port + "/api/agent/tcping", { method: "POST", headers: { authorization: "Bearer token-" + id, "content-type": "application/json" }, body: JSON.stringify({ results, force: true }) });
            assert.equal(response.status, 200);
          }
          await groups.runFailover();
        };
        await reportStage("healthy");
        assert.equal((await state()).activeMemberId, 101);
        await reportStage("pending");
        await reportStage("failed");
        assert.equal((await state()).activeMemberId, 101, "destination failure alone keeps the current entrance");
        await heartbeat(1, []);
        await groups.runFailover();
        assert.equal((await state()).activeMemberId, 101, "splitter failure observes the configured delay");
        testNow += 11_000;
        rejectDdns = true;
        await assert.rejects(() => groups.runFailover(), /simulated DDNS failure/);
        const failedDns = await state();
        assert.equal(failedDns.activeMemberId, 101, "a failed DDNS update does not announce a completed switch");
        assert.equal(failedDns.lastStatus, "error");
        rejectDdns = false;
        await groups.runFailover();
        assert.equal((await state()).activeMemberId, 102);
        assert.equal((await state()).lastDdnsValue, "127.0.0.2");
        await reportStage("recover-pending");
        await heartbeat(1, localRules(full[0]));
        await groups.runFailover();
        assert.equal((await state()).activeMemberId, 102, "recovery observation window keeps the backup entrance");
        await groups.updateFields({ id: 10, autoFailback: false });
        await reportStage("recovered");
        testNow += 11_000;
        await groups.runFailover();
        assert.equal((await state()).activeMemberId, 102, "disabling automatic failback keeps the healthy backup after recovery");
        await groups.updateFields({ id: 10, autoFailback: true });
        await groups.runFailover();
        assert.equal((await state()).activeMemberId, 101);
        assert.ok(dnsRequests.length >= 3);
        for (const id of [1, 2]) {
          const results = JSON.parse(fs.readFileSync(directory + "/probe-" + id + "-failed.json", "utf8")).map(result => ({ ...result, healthStatus: "unhealthy", isTimeout: true, latencyMs: null, probeSuccesses: 0 }));
          const response = await fetch("http://127.0.0.1:" + server.address().port + "/api/agent/tcping", { method: "POST", headers: { authorization: "Bearer token-" + id, "content-type": "application/json" }, body: JSON.stringify({ results, force: true }) });
          assert.equal(response.status, 200);
        }
        await groups.runFailover();
        assert.equal((await state()).lastStatus, "healthy", "destination failure does not mark working splitters down");
        for (const id of [1, 2]) await heartbeat(id, []);
        testNow += 11_000;
        await groups.runFailover();
        assert.equal((await state()).lastStatus, "down", "no working splitter is reported as a successful failover");
        await reportStage("recovered");
      }
      const groups = forwardGroupsRouter.createCaller(context({ id: 1, username: "admin", role: "admin", accountEnabled: true }));
      const groupState = async () => (await groups.listPage({ groupMode: "failover", page: 1, pageSize: 20 })).items.find(group => group.id === 10);
      const fourth = await admin.create({ ...input, name: "another-port", sni: "port.example.com", sourcePort: 18444 });
      await insert("hosts", { id: 3, name: "entrance-3", ip: "127.0.0.3", ipv4: "127.0.0.3", agentToken: "token-3", userId: 1, isOnline: 1, lastHeartbeat: now, agentVersion: "2.2.195", portRangeStart: 18000, portRangeEnd: 19000 });
      const occupied = await admin.create({ ...input, forwardGroupId: null, hostId: 3, name: "occupied", sni: null, sourcePort: 18444 });
      const beforeMembers = await groupState();
      await assert.rejects(() => groups.updateFields({ id: 10, name: "failed replacement", members: [{ memberType: "host", hostId: 1, priority: 10 }, { memberType: "host", hostId: 3, priority: 20 }] }), /18444.*(used|占用)/);
      const rejectedMembers = await groupState();
      assert.equal(rejectedMembers.name, beforeMembers.name);
      assert.deepEqual(rejectedMembers.members.map(member => member.hostId), [1, 2]);
      const thirdHeartbeat = await heartbeat(3, []);
      assert.ok(!thirdHeartbeat.desiredState.actions.some(action => action.fxp?.role === "sni-splitter"), "failed replacement leaves no partial configuration on C");
      await admin.delete({ id: occupied.id });
      await runtime.executeRaw('CREATE TRIGGER reject_partial_member BEFORE INSERT ON forward_rules WHEN NEW.hostId = 3 AND NEW.sourcePort = 18444 BEGIN SELECT RAISE(ABORT, "simulated second write failure"); END');
      await assert.rejects(() => groups.updateFields({ id: 10, name: "partial write", members: [{ memberType: "host", hostId: 1, priority: 10 }, { memberType: "host", hostId: 3, priority: 20 }] }), /simulated second write failure/);
      assert.equal((await groupState()).name, beforeMembers.name);
      assert.deepEqual((await groupState()).members.map(member => member.hostId), [1, 2]);
      const afterPartialFailure = await heartbeat(3, []);
      assert.ok(!afterPartialFailure.desiredState?.actions?.some(action => action.fxp?.role === "sni-splitter"));
      await runtime.executeRaw('DROP TRIGGER reject_partial_member');
      await runtime.executeRaw('UPDATE hosts SET agentVersion = NULL WHERE id = 3');
      await assert.rejects(() => groups.updateFields({ id: 10, members: [{ memberType: "host", hostId: 1 }, { memberType: "host", hostId: 3 }] }), /entrance-3.*2\.2\.195/);
      await runtime.executeRaw('UPDATE hosts SET agentVersion = ? WHERE id = 3', ["2.2.195"]);
      await groups.updateFields({ id: 10, members: [{ memberType: "host", hostId: 1, priority: 10 }, { memberType: "host", hostId: 3, priority: 20 }] });
      const newEntrance = await heartbeat(3, []);
      const preparedPorts = newEntrance.desiredState.actions.filter(action => action.op === "apply" && action.fxp?.role === "sni-splitter").map(action => action.sourcePort).sort();
      assert.deepEqual(preparedPorts, [18443, 18444]);
      assert.equal((await admin.getById({ id: second.id })).sniRuntime.entries.find(entry => entry.hostId === 3).applied, false);
      const newMemberActions = newEntrance.desiredState.actions.filter(action => action.op === "apply" && action.fxp?.role === "sni-splitter");
      await heartbeat(3, newMemberActions.flatMap(action => localRules(action.fxp)));
      assert.equal((await admin.getById({ id: second.id })).sniRuntime.entries.find(entry => entry.hostId === 3).applied, true);
      await groups.updateFields({ id: 10, members: [{ memberType: "host", hostId: 1, priority: 10 }, { memberType: "host", hostId: 3, priority: 20, isEnabled: false }] });
      const disabledMember = await heartbeat(3, newMemberActions.flatMap(action => localRules(action.fxp)));
      assert.ok(!disabledMember.desiredState?.actions?.some(action => action.op === "apply" && action.fxp?.role === "sni-splitter"));
      assert.deepEqual(disabledMember.desiredState.actions.filter(action => action.op === "remove" && action.fxp?.role === "sni-splitter").map(action => action.sourcePort).sort(), [18443, 18444], "disabling a member removes its actual splitters, regardless of the group's ordinary forwarding tool");
      if (process.env.FORWARDX_SNI_GROUP_NETWORK === "1") {
        const fs = await import("node:fs");
        const { spawn } = await import("node:child_process");
        const directory = process.env.FORWARDX_SNI_GROUP_EXPORT;
        fs.writeFileSync(directory + "/member-added-3.json", JSON.stringify(newMemberActions));
        fs.writeFileSync(directory + "/member-disabled-3.json", JSON.stringify(disabledMember.desiredState.actions));
        await new Promise((resolve, reject) => {
          const child = spawn("docker", ["run", "--rm", "--cap-add", "NET_ADMIN", "-v", directory + ":/input", "-v", process.cwd() + "/scripts/verify-sni-forward-group-member.mjs:/verify-member.mjs:ro", "--entrypoint", "node", "forwardx-sni-test:20261006", "/verify-member.mjs", "/input"], { stdio: "inherit" });
          child.once("error", reject); child.once("exit", code => code === 0 ? resolve() : reject(new Error("new member network verification failed: " + code)));
        });
      }
      await groups.updateFields({ id: 10, members: [{ memberType: "host", hostId: 1, priority: 10 }, { memberType: "host", hostId: 2, priority: 20 }] });
      await runtime.executeRaw('CREATE TRIGGER reject_partial_rule BEFORE UPDATE ON forward_rules WHEN NEW.hostId = 2 AND NEW.sourcePort = 18443 AND NEW.targetPort = 19999 BEGIN SELECT RAISE(ABORT, "simulated rule save failure"); END');
      await assert.rejects(() => admin.update({ id: second.id, targetPort: 19999 }), /simulated rule save failure/);
      assert.equal((await admin.getById({ id: second.id })).targetPort, 19445);
      await runtime.executeRaw('DROP TRIGGER reject_partial_rule');
      await insert("forward_groups", { id: 20, name: "replacement group", groupType: "host", groupMode: "failover", forwardType: "nftables", domain: "", targetIp: "0.0.0.0", targetPort: 1, userId: 1, isEnabled: 1 });
      await insert("forward_group_members", { id: 203, groupId: 20, memberType: "host", hostId: 3, priority: 10, isEnabled: 1 });
      await runtime.executeRaw('CREATE TRIGGER reject_rule_move BEFORE INSERT ON forward_rules WHEN NEW.hostId = 3 AND NEW.sourcePort = 18443 BEGIN SELECT RAISE(ABORT, "simulated rule move failure"); END');
      await assert.rejects(() => admin.update({ id: second.id, forwardGroupId: 20 }), /simulated rule move failure/);
      assert.equal((await admin.getById({ id: second.id })).forwardGroupId, 10, "a failed move keeps the rule in its original group");
      await runtime.executeRaw('DROP TRIGGER reject_rule_move');
      await groups.toggle({ id: 10, isEnabled: false });
      assert.equal((await admin.getById({ id: second.id })).isEnabled, false);
      await groups.toggle({ id: 10, isEnabled: true });
      assert.equal((await admin.getById({ id: second.id })).isEnabled, true);
      const trafficConfig = [];
      for (const id of [1, 2]) {
        const result = await heartbeat(id, []);
        trafficConfig.push(result.desiredState.actions.find(action => action.op === "apply" && action.fxp?.role === "sni-splitter" && action.sourcePort === 18443).fxp);
      }
      const postTraffic = async (id, reportId, bytesIn, bytesOut) => {
        const route = trafficConfig[id - 1].sniRoutes.find(route => route.sni === "b.example.com");
        const response = await fetch("http://127.0.0.1:" + server.address().port + "/api/agent/traffic", {
          method: "POST", headers: { authorization: "Bearer token-" + id, "content-type": "application/json" },
          body: JSON.stringify({ reportId: String(reportId), reportProducerId: "producer-" + id, stats: [{ ruleId: route.ruleId, bytesIn, bytesOut, connections: 1 }] }),
        });
        assert.equal(response.status, 200);
      };
      await postTraffic(1, 1, 100, 200);
      await postTraffic(2, 1, 300, 400);
      await postTraffic(1, 1, 100, 200);
      const traffic = await admin.traffic({ ruleId: second.id });
      assert.equal(traffic.reduce((sum, stat) => sum + stat.bytesIn, 0), 400);
      assert.equal(traffic.reduce((sum, stat) => sum + stat.bytesOut, 0), 600);
      assert.equal((await admin.getById({ id: second.id })).sniRuntime.entries.find(entry => entry.hostId === 2).applied, false, "traffic from a previous configuration does not confirm that the latest configuration is ready");
      const counted = await admin.getById({ id: second.id });
      const metrics = await import("./server/repositories/metricsRepository.ts");
      assert.deepEqual(await metrics.getTotalTraffic(1), { totalIn: 400, totalOut: 600 });
      assert.equal(counted.quotaUsedIn, 400);
      assert.equal(counted.quotaUsedOut, 600);
      for (const id of [1, 2]) await heartbeat(id, localRules(trafficConfig[id - 1]));
      assert.equal((await admin.getById({ id: second.id })).isRunning, true);
      const samePort = await admin.create({ ...input, sni: "unaffected.example.com", name: "same port remains" });
      await admin.update({ id: second.id, trafficLimit: 1000, trafficMode: "both" });
      const limited = await admin.getById({ id: second.id });
      assert.equal(limited.ruleLimitReason, "traffic_limit");
      assert.equal(limited.isRunning, false);
      for (const id of [1, 2]) {
        const result = await heartbeat(id, []);
        const configs = result.desiredState.actions.filter(action => action.op === "apply" && action.fxp?.role === "sni-splitter");
        assert.ok(configs.some(action => action.fxp.sniRoutes.some(route => route.sni === "port.example.com")));
        assert.ok(configs.some(action => action.sourcePort === 18443 && action.fxp.sniRoutes.some(route => route.sni === "unaffected.example.com")));
        assert.ok(!configs.some(action => action.fxp.sniRoutes.some(route => route.sni === "b.example.com")));
      }
      await admin.update({ id: second.id, trafficLimit: 2000 });
      assert.equal((await admin.getById({ id: second.id })).quotaUsedIn, 400);
      assert.equal((await admin.getById({ id: second.id })).quotaUsedOut, 600);
      await admin.update({ id: second.id, createdAt: new Date(Date.now() - 86_400_000), expiresAt: new Date(Date.now() - 1000) });
      assert.equal((await admin.getById({ id: second.id })).ruleLimitReason, "expired");
      for (const id of [1, 2]) {
        const result = await heartbeat(id, []);
        const routes = result.desiredState.actions.flatMap(action => action.fxp?.sniRoutes || []);
        assert.ok(routes.some(route => route.sni === "unaffected.example.com"));
        assert.ok(!routes.some(route => route.sni === "b.example.com"));
      }
      await admin.update({ id: second.id, expiresAt: null });
      const copied = await admin.create({ ...input, forwardGroupId: 20, sni: "b.example.com", targetPort: 19445, rateLimitMbps: 15, maxConnections: 8, trafficLimit: 2000, trafficMode: "both" });
      const copiedRule = await admin.getById({ id: copied.id });
      const exported = parseRuleTransferFile({ kind: RULE_TRANSFER_FILE_KIND, version: RULE_TRANSFER_FILE_VERSION, scope: { type: "group", id: 20 }, rules: [exportRuleForTransfer(copiedRule)] });
      assert.equal(exported.ok, true);
      assert.equal(exported.file.rules[0].sourcePort, 18443);
      assert.equal(exported.file.rules[0].sni, "b.example.com");
      assert.equal(exported.file.rules[0].rateLimitMbps, 15);
      assert.equal(exported.file.rules[0].maxConnections, 8);
      assert.equal(exported.file.rules[0].trafficLimit, 2000);
      await assert.rejects(() => admin.create({ ...exported.file.rules[0], forwardGroupId: 20 }), /SNI 域名.*冲突/);
      await admin.delete({ id: copied.id });
      const reimported = await admin.create({ ...exported.file.rules[0], forwardGroupId: 20 });
      assert.equal((await admin.getById({ id: reimported.id })).targetPort, 19445);
      await runtime.executeRaw("CREATE TRIGGER reject_import_item BEFORE INSERT ON forward_rules WHEN NEW.hostId = 2 AND NEW.sni = 'failed.example.com' BEGIN SELECT RAISE(ABORT, 'simulated import failure'); END");
      await assert.rejects(() => admin.create({ ...input, sni: "failed.example.com" }), /simulated import failure/);
      await runtime.executeRaw('DROP TRIGGER reject_import_item');
      const successful = await admin.create({ ...input, sni: "successful.example.com" });
      const finalRules = await admin.list();
      assert.ok(finalRules.some(rule => rule.id === successful.id));
      assert.ok(!finalRules.some(rule => rule.sni === "failed.example.com"));
      for (const id of [1, 2]) {
        const result = await heartbeat(id, []);
        assert.ok(!result.desiredState.actions.some(action => action.fxp?.sniRoutes?.some(route => route.sni === "failed.example.com")));
      }
      await assert.rejects(() => admin.update({ id: trafficConfig[0].sniRoutes[0].ruleId, targetPort: 20000 }), /成员规则.*系统维护/);
      // Older chain reports keep their existing acceptance rules; strict
      // destination matching belongs to the newly supported failover hosts.
      await insert("forward_groups", { id: 40, name: "existing chain", groupType: "host", groupMode: "chain", targetIp: "0.0.0.0", targetPort: 1, forwardType: "nftables", userId: 1, isEnabled: 1 });
      await insert("forward_group_members", { id: 402, groupId: 40, memberType: "host", hostId: 2, priority: 20, isEnabled: 1 });
      await insert("forward_rules", { id: 901, hostId: 1, protocol: "tcp", name: "legacy chain root", isForwardGroupTemplate: 1, forwardGroupId: 40, sourcePort: 18743, targetIp: "203.0.113.99", targetPort: 443, sni: "legacy.example.com", sniSplitterPort: 18743, userId: 1, isEnabled: 1 });
      await insert("forward_rules", { id: 902, protocol: "tcp", name: "legacy chain exit", hostId: 2, forwardGroupId: 40, forwardGroupRuleId: 901, forwardGroupMemberId: 402, sourcePort: 18743, targetIp: "203.0.113.99", targetPort: 443, sni: "legacy.example.com", sniSplitterPort: 18743, userId: 1, isEnabled: 1 });
      const legacyProbe = await fetch("http://127.0.0.1:" + server.address().port + "/api/agent/tcping", { method: "POST", headers: { authorization: "Bearer token-2", "content-type": "application/json" }, body: JSON.stringify({ force: true, results: [{ ruleId: 902, sourcePort: 18743, targetIp: "127.0.0.2", latencyMs: 2, probeCount: 1, probeSuccesses: 1, method: "tcping" }] }) });
      assert.equal(legacyProbe.status, 200);
      assert.ok((await admin.tcpingSeries({ ruleId: 902 })).some(point => point.latencyMs === 2), "legacy chain report fields remain accepted");
    } finally {
      await new Promise(resolve => server.close(resolve));
      await runtime.closeDatabase();
    }
    process.exit(0);
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: process.cwd(), env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "test.db") }, encoding: "utf8", timeout: 150_000,
  });
  fs.rmSync(directory, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});


test("port and chain SNI sharing one listener receive one complete table and preserve each other's routes", () => {
  verifySniGroupDeletion(String.raw`
    const { mock } = await import("node:test");
    mock.timers.enable({ apis: ["Date"], now: Date.now() });
    beforeHeartbeat = () => mock.timers.tick(100);
    const service = await import("./server/services/forwardGroupService.ts");
    const input = { name: "mixed", groupType: "host", forwardType: "gost", protocol: "tcp", isEnabled: true,
      autoFailback: true, failoverSeconds: 10, recoverSeconds: 10, ddnsAutoResolveEnabled: false };
    const entryId = await service.createForwardGroupFromInput({ ...input, groupMode: "entry", domain: "mixed.example.test",
      members: [1, 2].map(hostId => ({ memberType: "host", hostId, isEnabled: true })) }, 1);
    await service.updateForwardGroupFromInput(10, { ...input, groupMode: "port", entryGroupId: entryId, members: [] });
    const [directId] = await createRules("direct", 1);
    await insert("hosts", { id: 3, name: "chain-exit", ip: "192.0.2.3", ipv4: "192.0.2.3", agentToken: "token-3", userId: 1,
      isOnline: 1, lastHeartbeat: Math.floor(Date.now() / 1000), agentVersion: "3.3.0", portRangeStart: 18000, portRangeEnd: 30000 });
    const chainId = await service.createForwardGroupFromInput({ ...input, name: "mixed-chain", groupMode: "chain",
      members: [1, 3].map(hostId => ({ memberType: "host", hostId, isEnabled: true })) }, 1);
    const chain = await admin.create({ forwardGroupId: chainId, name: "chain", sourcePort: 18443, targetIp: "203.0.113.50",
      targetPort: 443, sni: "chain.example.test", isEnabled: true });
    const table = async (rules = []) => {
      const result = await heartbeat(1, rules);
      const actions = result.desiredState.actions.filter(action => action.op === "apply" && action.fxp?.role === "sni-splitter" && action.sourcePort === 18443);
      assert.equal(actions.length, 1, "one listener must receive one complete table");
      return actions[0];
    };
    const initial = (await table()).fxp;
    assert.deepEqual(initial.sniRoutes.map(route => route.sni).sort(), ["chain.example.test", "direct-0.example.test"]);
    const chainRoute = initial.sniRoutes.find(route => route.sni === "chain.example.test");
    assert.equal(chainRoute.targetIp, "192.0.2.3");
    await heartbeat(1, localRules(initial));
    assert.equal((await admin.getById({ id: directId })).sniRuntime.entries.find(entry => entry.hostId === 1).applied, true,
      "the complete mixed table can confirm its direct entry");
    assert.equal((await admin.getById({ id: chain.id })).isRunning, false, "chain still waits for its own exit confirmation");
    await admin.update({ id: directId, targetIp: "203.0.113.99" });
    const updated = (await table(localRules(initial))).fxp;
    assert.deepEqual(updated.sniRoutes.find(route => route.sni === "chain.example.test"), chainRoute);
    assert.equal(updated.sniRoutes.find(route => route.sni === "direct-0.example.test").targetIp, "203.0.113.99");
    await admin.toggle({ id: directId, isEnabled: false });
    const chainOnly = await table(localRules(updated));
    assert.deepEqual(chainOnly.fxp.sniRoutes.map(route => route.sni), ["chain.example.test"]);
    assert.ok(chainOnly.postCommands?.length, "removing the direct route keeps revocation protection on the shared listener");
    await admin.toggle({ id: directId, isEnabled: true });
    const both = (await table(localRules(chainOnly.fxp))).fxp;
    await admin.toggle({ id: chain.id, isEnabled: false });
    const directOnly = (await table(localRules(both))).fxp;
    assert.deepEqual(directOnly.sniRoutes.map(route => route.sni), ["direct-0.example.test"]);
  `);
});

test("port entry SNI uses each entry directly and confirms all resources before DNS inclusion", () => {
  verifySniGroupDeletion(String.raw`
    const { mock } = await import("node:test");
    mock.timers.enable({ apis: ["Date"], now: Date.now() });
    beforeHeartbeat = () => mock.timers.tick(100);
    // This process tests manual decisions. Keep automatically scheduled work
    // pending until explicitly driven, including observation-window rechecks.
    const { ForwardGroupEvaluationQueue, ForwardGroupHealthRecheckScheduler } = await import("./server/forwardGroupHealthRecheck.ts");
    const scheduled = new Set();
    mock.method(ForwardGroupEvaluationQueue.prototype, "enqueue", function(ids) {
      for (const id of ids) scheduled.add(Number(id));
      return scheduled.size;
    });
    mock.method(ForwardGroupHealthRecheckScheduler.prototype, "replace", function(id, dueAt) {
      if (dueAt) scheduled.add(Number(id));
      return Boolean(dueAt);
    });
    const service = await import("./server/services/forwardGroupService.ts");
    const input = { name: "parallel", groupType: "host", forwardType: "gost", protocol: "tcp", isEnabled: true,
      autoFailback: true, failoverSeconds: 10, recoverSeconds: 10, ddnsAutoResolveEnabled: false };
    const entryId = await service.createForwardGroupFromInput({ ...input, groupMode: "entry", domain: "parallel.example.test",
      members: [1, 2].map(hostId => ({ memberType: "host", hostId, isEnabled: true })) }, 1);
    await service.updateForwardGroupFromInput(10, { ...input, groupMode: "port", entryGroupId: entryId, members: [] });
    const ids = await createRules("parallel", 2);
    await admin.update({ id: ids[1], targetIp: "203.0.113.20", targetPort: 20443, rateLimitMbps: 10, maxConnections: 100 });
    const otherId = await service.createForwardGroupFromInput({ ...input, name: "another-resource", groupMode: "port", entryGroupId: entryId, members: [] }, 1);
    const third = await admin.create({ forwardGroupId: otherId, name: "third", sourcePort: 18443, targetIp: "203.0.113.30", targetPort: 21443, sni: "third.example.test", isEnabled: true });
    const requests = [];
    app.post("/test-entry-dns", (req, res) => { requests.push(req.body); res.json({ success: true }); });
    await settings.setSettings({ ddnsEnabled: "true", ddnsProvider: "webhook", ddnsWebhookUrl: "http://127.0.0.1:" + server.address().port + "/test-entry-dns", ddnsWebhookMethod: "POST", ddnsTtl: "60" });
    const entryInput = { ...input, groupMode: "entry", domain: "parallel.example.test", ddnsAutoResolveEnabled: true,
      members: [1, 2].map(hostId => ({ memberType: "host", hostId, isEnabled: true })) };
    await service.updateForwardGroupFromInput(entryId, entryInput);
    await groups.runForwardGroupFailover(entryId, { manual: true, forceSync: true });
    assert.equal(requests.length, 0, "unconfirmed entries cannot be first published as fallback");
    const initial = [];
    for (const hostId of [1, 2]) {
      const response = await heartbeat(hostId);
      const action = splitter(response);
      assert.ok(action, "each entry must own its final splitter");
      assert.equal(action.fxp.listenPort, 18443);
      assert.equal(action.fxp.sniRoutes.length, 3, "resources legally share the same listener");
      const byDomain = new Map(action.fxp.sniRoutes.map(route => [route.sni, route]));
      assert.equal(byDomain.get("parallel-0.example.test").targetIp, "203.0.113.10");
      assert.equal(byDomain.get("parallel-0.example.test").targetPort, 19443);
      assert.equal(byDomain.get("parallel-1.example.test").targetIp, "203.0.113.20");
      assert.equal(byDomain.get("parallel-1.example.test").targetPort, 20443);
      assert.equal(byDomain.get("parallel-1.example.test").limitIn, 1250000);
      assert.equal(byDomain.get("parallel-1.example.test").maxConnections, 100);
      initial.push(action.fxp);
    }
    await heartbeat(1, localRules(initial[0]));
    await heartbeat(2, localRules(initial[1]).filter(rule => rule.sni !== "third.example.test"));
    await groups.runForwardGroupFailover(entryId, { manual: true, forceSync: true });
    mock.timers.tick(11_000);
    await heartbeat(1, localRules(initial[0]));
    await heartbeat(2, localRules(initial[1]).filter(rule => rule.sni !== "third.example.test"));
    await groups.runForwardGroupFailover(entryId, { manual: true, forceSync: true });
    let entry = await groups.getForwardGroupById(entryId);
    assert.equal(entry.lastDdnsValue, "192.0.2.1", "A is ready while B lacks another resource");
    assert.deepEqual(requests.at(-1).values, ["192.0.2.1"]);
    let row = (await admin.list()).find(rule => Number(rule.id) === ids[0]);
    assert.equal(row.sniRuntime.entries.find(e => e.hostId === 1).applied, true);
    assert.equal(row.sniRuntime.entries.find(e => e.hostId === 2).applied, false);
    await heartbeat(2, localRules(initial[1]));
    await groups.runForwardGroupFailover(entryId, { manual: true, forceSync: true });
    assert.equal((await groups.getForwardGroupById(entryId)).lastDdnsValue, "192.0.2.1", "B must complete its recovery observation");
    mock.timers.tick(11_000);
    await heartbeat(1, localRules(initial[0]));
    await heartbeat(2, localRules(initial[1]));
    await groups.runForwardGroupFailover(entryId, { manual: true, forceSync: true });
    entry = await groups.getForwardGroupById(entryId);
    assert.deepEqual(entry.lastDdnsValue.split(",").sort(), ["192.0.2.1", "192.0.2.2"]);
    const { registerAgentReportRoutes } = await import("./server/agentReportRoutes.ts");
    registerAgentReportRoutes(app);
    const postUsage = async (hostId, bytesIn) => {
      const route = initial[hostId - 1].sniRoutes.find(route => route.sni === "parallel-0.example.test");
      const response = await fetch("http://127.0.0.1:" + server.address().port + "/api/agent/traffic", {
        method: "POST", headers: { authorization: "Bearer token-" + hostId, "content-type": "application/json" },
        body: JSON.stringify({ reportId: "1", reportProducerId: "port-entry-" + hostId,
          stats: [{ ruleId: route.ruleId, bytesIn, bytesOut: 0, connections: 1 }] }),
      });
      assert.equal(response.status, 200);
    };
    await postUsage(1, 30_000_000_000);
    await postUsage(2, 20_000_000_000);
    await postUsage(1, 30_000_000_000);
    const usage = await admin.traffic({ ruleId: ids[0] });
    assert.equal(usage.reduce((sum, stat) => sum + stat.bytesIn, 0), 50_000_000_000,
      "30 GB on A plus 20 GB on B totals 50 GB on the root, without counting the retry");
    const metrics = await import("./server/repositories/metricsRepository.ts");
    assert.deepEqual(await metrics.getTotalTraffic(1), { totalIn: 50_000_000_000, totalOut: 0 });
    await admin.update({ id: ids[0], targetIp: "203.0.113.99" });
    const firstUpdatedA = await heartbeat(1, localRules(initial[0]));
    row = (await admin.list()).find(rule => Number(rule.id) === ids[0]);
    assert.equal(row.sniRuntime.entries.find(e => e.hostId === 1).applied, false, "old target cannot confirm new save");
    const current = [];
    for (const id of [1, 2]) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const response = id === 1 && attempt === 0 ? firstUpdatedA : await heartbeat(id, localRules(initial[id - 1]));
        const action = response.desiredState?.actions?.find(a => a.op === "apply" && a.fxp?.role === "sni-splitter" && a.sourcePort === 18443);
        if (action) { current.push(action.fxp); break; }
        // The panel deliberately limits resending an unchanged desired state.
        mock.timers.tick(15_000);
      }
      assert.equal(current.length, id, "the next normal heartbeat receives the current table");
      if (process.env.FORWARDX_PORT_SNI_EXPORT) {
        const fs = await import("node:fs");
        fs.mkdirSync(process.env.FORWARDX_PORT_SNI_EXPORT, { recursive: true });
        fs.writeFileSync(process.env.FORWARDX_PORT_SNI_EXPORT + "/initial-" + id + ".json", JSON.stringify(initial[id - 1]));
        fs.writeFileSync(process.env.FORWARDX_PORT_SNI_EXPORT + "/updated-" + id + ".json", JSON.stringify(current[id - 1]));
      }
    }
    for (const id of [1, 2]) await heartbeat(id, localRules(current[id - 1]));
    await groups.runForwardGroupFailover(entryId, { manual: true, forceSync: true });
    mock.timers.tick(11_000);
    for (const id of [1, 2]) await heartbeat(id, localRules(current[id - 1]));
    await groups.runForwardGroupFailover(entryId, { manual: true, forceSync: true });
    // A concurrent save after health evaluation must invalidate that selection.
    // The trigger gives this race a deterministic database boundary, without a
    // production test hook or replacing the actual DNS provider request.
    await runtime.executeRaw('CREATE TABLE dns_race_hits (phase TEXT, memberId INTEGER)');
    let phase = "setup";
    const repeat = Number(process.env.FORWARDX_DNS_RACE_REPEATS || 1);
    assert.ok(Number.isInteger(repeat) && repeat > 0);
    const race = async (name) => {
      for (let iteration = 0; iteration < repeat; iteration++) {
        await runtime.executeRaw('DELETE FROM dns_race_hits');
        await runtime.executeRaw('CREATE TRIGGER change_sni_during_health AFTER UPDATE OF "lastCheckedAt" ON "forward_group_members" WHEN NEW."groupId" = ' + entryId + ' BEGIN INSERT INTO dns_race_hits VALUES (\'health\', NEW."id"); UPDATE "forward_rules" SET "targetIp" = \'203.0.113.88\' WHERE "id" = ' + third.id + ' OR "forwardGroupRuleId" = ' + third.id + '; END');
        // Exercise work already queued before the manual check, and delayed
        // work queued while a previous decision is still pending.
        assert.ok(scheduled.has(entryId), "saving/heartbeats must enqueue the entry");
        await Promise.resolve();
        assert.deepEqual(await runtime.queryRaw('SELECT * FROM dns_race_hits'), [], "background work cannot consume the trigger before this decision");
        assert.equal((await admin.getById({ id: third.id })).targetIp, "203.0.113.30");
        const before = structuredClone(requests);
        phase = name + "-" + iteration;
        await groups.runForwardGroupFailover(entryId, { manual: true, forceSync: true });
        const hits = await runtime.queryRaw('SELECT * FROM dns_race_hits');
        assert.ok(hits.length > 0, phase + ": concurrent save must happen inside health evaluation");
        assert.ok(hits.every(hit => hit.phase === "health"));
        assert.equal((await admin.getById({ id: third.id })).targetIp, "203.0.113.88");
        assert.deepEqual(requests, before, phase + ": old DNS decision must not send any HTTP payload");
        await runtime.executeRaw('DROP TRIGGER change_sni_during_health');
        await runtime.executeRaw('UPDATE "forward_rules" SET "targetIp" = ? WHERE "id" = ? OR "forwardGroupRuleId" = ?', ["203.0.113.30", third.id, third.id]);
      }
    };
    await race("same-entry");
    const anotherEntryId = await service.createForwardGroupFromInput({ ...input, groupMode: "entry", domain: "another-entry.example.test",
      members: [1, 2].map(hostId => ({ memberType: "host", hostId, isEnabled: true })) }, 1);
    await runtime.executeRaw('UPDATE "forward_groups" SET "entryGroupId" = ? WHERE "id" = ?', [anotherEntryId, otherId]);
    await race("shared-listener-other-entry");
    await runtime.executeRaw('UPDATE "forward_groups" SET "entryGroupId" = ? WHERE "id" = ?', [entryId, otherId]);
    await service.updateForwardGroupFromInput(entryId, { ...entryInput, members: [{ memberType: "host", hostId: 2, isEnabled: true }] });
    await groups.runForwardGroupFailover(entryId, { manual: true, forceSync: true });
    assert.deepEqual(requests.at(-1).values, ["192.0.2.2"], "removed A must leave managed DNS");
    await service.updateForwardGroupFromInput(entryId, { ...entryInput, members: [{ memberType: "host", hostId: 2, isEnabled: false }] });
    await groups.runForwardGroupFailover(entryId, { manual: true, forceSync: true });
    assert.deepEqual(requests.at(-1).values, [], "disabled B cannot be resurrected as fallback");
  `);
});


test("SNI heartbeats automatically enqueue the production evaluator and health events in flight get a second check", () => {
  verifySniGroupDeletion(String.raw`
    const { mock } = await import("node:test");
    const { ForwardGroupEvaluationQueue, ForwardGroupHealthRecheckScheduler } = await import("./server/forwardGroupHealthRecheck.ts");
    const arm = ForwardGroupEvaluationQueue.prototype.arm;
    const flush = ForwardGroupEvaluationQueue.prototype.flush;
    const timers = [];
    const enqueued = Promise.withResolvers();
    const started = Promise.withResolvers();
    const release = Promise.withResolvers();
    let completed = Promise.withResolvers();
    let executions = 0;
    // Keep the singleton's real evaluate callback (skipRuleSync), changing
    // only its clock and exposing completion of the existing asynchronous work.
    mock.method(ForwardGroupEvaluationQueue.prototype, "arm", function(delay) {
      this.setTimer = callback => { const timer = { callback, unref() {} }; timers.push(timer); return timer; };
      this.clearTimer = timer => { timer.cleared = true; };
      if (!this.testClockInstalled) {
        this.testClockInstalled = true;
        const evaluate = this.evaluate;
        this.evaluate = async ids => {
          executions++;
          if (executions === 1) { started.resolve(); await release.promise; }
          return evaluate(ids);
        };
      }
      const result = arm.call(this, delay);
      enqueued.resolve();
      return result;
    });
    mock.method(ForwardGroupEvaluationQueue.prototype, "flush", async function() {
      try { await flush.call(this); completed.resolve(); } catch (error) { completed.reject(error); throw error; }
    });
    mock.method(ForwardGroupHealthRecheckScheduler.prototype, "replace", () => false);
    await createRules("background", 1);
    await runtime.executeRaw('CREATE TABLE background_health_hits (memberId INTEGER)');
    await runtime.executeRaw('CREATE TRIGGER track_background_health AFTER UPDATE OF lastCheckedAt ON forward_group_members BEGIN INSERT INTO background_health_hits VALUES (NEW.id); END');
    await heartbeat(1);
    await enqueued.promise;
    assert.equal(timers.length, 1, "real heartbeat must automatically arm the background queue");
    assert.equal(executions, 0);
    timers.shift().callback();
    await started.promise;
    // An explicit host health event arriving during the first evaluation must
    // be retained; the queue must not depend on a later unrelated heartbeat.
    await groups.scheduleForwardGroupsForHostHealthChange(1);
    release.resolve();
    await completed.promise;
    const firstHits = await runtime.queryRaw('SELECT * FROM background_health_hits');
    assert.ok(firstHits.length > 0, "the production evaluator must really update member health");
    assert.equal(timers.length, 1, "an event in flight must schedule another pass");
    completed = Promise.withResolvers();
    timers.shift().callback();
    await completed.promise;
    assert.equal(executions, 2);
    const secondHits = await runtime.queryRaw('SELECT * FROM background_health_hits');
    assert.ok(secondHits.length > firstHits.length, "the second production check must also update health");
  `);
});
