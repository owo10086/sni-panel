import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

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
      // Real reports for the old destination must not qualify a new address on the same port.
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
        assert.ok((await groups.list()).find(g => g.id === 10).members.every(m => m.healthStatus !== "healthy"), "old address health cannot qualify the newly applied destination");
        for (const id of [1, 2]) await report(id, oldConfigs[id - 1]);
        await groups.runFailover();
        assert.ok((await groups.list()).find(g => g.id === 10).members.every(m => m.healthStatus !== "healthy"), "late reports for the old address are rejected");
        for (const id of [1, 2]) await report(id, newConfigs[id - 1]);
        await groups.runFailover();
        assert.ok((await groups.list()).find(g => g.id === 10).members.every(m => m.healthStatus === "healthy"));

        // Change a limit while the DDNS provider is still handling the selected backup.
        const settings = await import("./server/repositories/settingsRepository.ts");
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
        assert.equal((await state()).activeMemberId, 101, "failure observation window keeps the current entrance");
        rejectDdns = true;
        await assert.rejects(() => reportStage("failed"), /simulated DDNS failure/);
        const failedDns = await state();
        assert.equal(failedDns.activeMemberId, 101, "a failed DDNS update does not announce a completed switch");
        assert.equal(failedDns.lastStatus, "error");
        rejectDdns = false;
        await groups.runFailover();
        assert.equal((await state()).activeMemberId, 102);
        assert.equal((await state()).lastDdnsValue, "127.0.0.2");
        await reportStage("recover-pending");
        assert.equal((await state()).activeMemberId, 102, "recovery observation window keeps the backup entrance");
        await groups.updateFields({ id: 10, autoFailback: false });
        await reportStage("recovered");
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
        assert.equal((await state()).lastStatus, "down", "no healthy destination is reported as a successful failover");
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
