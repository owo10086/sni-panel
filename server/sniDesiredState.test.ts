import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("SNI forward-chain desired state sends entry traffic to the splitter and routes on the exit host", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-sni-desired-state-"));
  const databasePath = path.join(directory, "sni-desired.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import http from "node:http";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    import express from "express";

    const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(moduleUrl("server/dbRuntime.ts"));
    const schema = await import(moduleUrl("server/dbSchema.ts"));
    const heartbeat = await import(moduleUrl("server/agentHeartbeatRoute.ts"));
    const q = (name) => '"' + name + '"';
    const insert = async (table, columns, values) => {
      await runtime.executeRaw(
        "INSERT INTO " + q(table) + " (" + columns.map(q).join(", ") + ") VALUES (" + values.map(() => "?").join(", ") + ")",
        values,
      );
    };
    const heartbeatBody = {
      agentVersion: "2.2.195",
      agentBootId: "boot-sni",
      agentProcessId: 1001,
      agentProcessStartedAt: Math.floor(Date.now() / 1000),
      forceReconcile: true,
    };
    const entryHostIp = "198.51.100.10";
    const exitHostIp = "198.51.100.20";
    const finalTargetIp = "203.0.113.20";
    const scenarios = [
      { forwardType: "nftables", groupId: 10, templateId: 100, entryRuleId: 101, exitRuleId: 102, entryMemberId: 1001, exitMemberId: 1002, sourcePort: 18443, splitterPort: 24000, sni: "api.example.com" },
      { forwardType: "gost", groupId: 20, templateId: 200, entryRuleId: 201, exitRuleId: 202, entryMemberId: 2001, exitMemberId: 2002, sourcePort: 18444, splitterPort: 24001, sni: "gost.example.com" },
      { forwardType: "nginx", groupId: 30, templateId: 300, entryRuleId: 301, exitRuleId: 302, entryMemberId: 3001, exitMemberId: 3002, sourcePort: 18445, splitterPort: 24002, sni: "nginx.example.com" },
    ];
    let server;

    async function postHeartbeat(baseUrl, token, body = {}) {
      const response = await fetch(baseUrl + "/api/agent/heartbeat", {
        method: "POST",
        headers: {
          authorization: "Bearer " + token,
          "content-type": "application/json",
        },
        body: JSON.stringify({ ...heartbeatBody, ...body }),
      });
      const payload = await response.json();
      return { status: response.status, payload };
    }

    async function insertSniChain(scenario) {
      await insert("forward_groups", ["id", "name", "groupType", "groupMode", "forwardType", "domain", "targetIp", "targetPort", "userId", "isEnabled"], [
        scenario.groupId,
        scenario.forwardType + "-chain",
        "host",
        "chain",
        scenario.forwardType,
        "",
        "0.0.0.0",
        1,
        1,
        1,
      ]);
      await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [scenario.entryMemberId, scenario.groupId, "host", 1, 10, 1]);
      await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [scenario.exitMemberId, scenario.groupId, "host", 2, 20, 1]);
      await insert("forward_rules", [
        "id", "hostId", "name", "forwardType", "protocol", "forwardGroupId", "isForwardGroupTemplate",
        "sourcePort", "sni", "sniSplitterPort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning"
      ], [scenario.templateId, 1, scenario.forwardType + "-template", scenario.forwardType, "tcp", scenario.groupId, 1, scenario.sourcePort, scenario.sni, scenario.splitterPort, finalTargetIp, 443, 1, 1, 0]);
      await insert("forward_rules", [
        "id", "hostId", "name", "forwardType", "protocol", "forwardGroupId", "forwardGroupRuleId", "forwardGroupMemberId", "isForwardGroupTemplate",
        "sourcePort", "sni", "sniSplitterPort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning"
      ], [scenario.entryRuleId, 1, scenario.forwardType + "-entry-child", scenario.forwardType, "tcp", scenario.groupId, scenario.templateId, scenario.entryMemberId, 0, scenario.sourcePort, scenario.sni, scenario.splitterPort, exitHostIp, 18100, 1, 1, 0]);
      await insert("forward_rules", [
        "id", "hostId", "name", "forwardType", "protocol", "forwardGroupId", "forwardGroupRuleId", "forwardGroupMemberId", "isForwardGroupTemplate",
        "sourcePort", "sni", "sniSplitterPort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning"
      ], [scenario.exitRuleId, 2, scenario.forwardType + "-exit-child", scenario.forwardType, "tcp", scenario.groupId, scenario.templateId, scenario.exitMemberId, 0, 18100, scenario.sni, scenario.splitterPort, finalTargetIp, 443, 1, 1, 0]);
    }

    function decodedManagedConfigText(actions) {
      return actions
        .flatMap((action) => action.managedConfigs || [])
        .map((config) => Buffer.from(String(config.contentBase64 || ""), "base64").toString("utf8"))
        .join("\n");
    }

    function findManagedConfig(actions, suffix) {
      for (const action of actions) {
        for (const config of action.managedConfigs || []) {
          if (String(config.path || "").endsWith(suffix)) {
            return Buffer.from(String(config.contentBase64 || ""), "base64").toString("utf8");
          }
        }
      }
      return "";
    }

    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      const now = Math.floor(Date.now() / 1000);
      await insert("users", ["id", "username", "password", "role", "canAddRules", "manualCanAddRules"], [1, "admin", "x", "admin", 1, 1]);
      await insert("system_settings", ["key", "value"], ["forwardProtocols", JSON.stringify({ nginx: true })]);
      await insert("hosts", ["id", "name", "ip", "ipv4", "agentToken", "userId", "blockHttp", "isOnline", "lastHeartbeat", "agentVersion", "portRangeStart", "portRangeEnd"], [1, "entry", entryHostIp, entryHostIp, "entry-token", 1, 1, 1, now, "2.2.195", 18000, 19000]);
      await insert("hosts", ["id", "name", "ip", "ipv4", "agentToken", "userId", "isOnline", "lastHeartbeat", "agentVersion", "portRangeStart", "portRangeEnd"], [2, "exit", exitHostIp, exitHostIp, "exit-token", 1, 1, now, "2.2.195", 24000, 24010]);
      for (const scenario of scenarios) {
        await insertSniChain(scenario);
      }

      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        const authorization = String(req.headers.authorization || "");
        req.agentToken = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
        next();
      });
      heartbeat.registerAgentHeartbeatRoute(app);
      server = http.createServer(app);
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      assert.ok(address && typeof address === "object");
      const baseUrl = "http://127.0.0.1:" + address.port;

      const entry = await postHeartbeat(baseUrl, "entry-token", { agentBootId: "boot-entry", agentProcessId: 2001 });
      assert.equal(entry.status, 200);
      assert.equal(entry.payload.success, true);
      const entryActions = entry.payload.desiredState.actions;
      const entryActionText = JSON.stringify(entryActions);
      const entryConfigText = decodedManagedConfigText(entryActions);
      assert.doesNotMatch(entryActionText, /203\.0\.113\.20/);
      assert.doesNotMatch(entryConfigText, /203\.0\.113\.20/);

      for (const scenario of scenarios) {
        const entryApply = entryActions.find((action) => action.op === "apply" && action.ruleId === scenario.entryRuleId);
        assert.ok(entryApply, "missing entry apply action for " + scenario.forwardType);
        assert.equal(entryApply.sourcePort, scenario.sourcePort);
        assert.equal(entryApply.targetIp, exitHostIp);
        assert.equal(entryApply.targetPort, scenario.splitterPort);
        assert.equal(entryApply.protocol, "tcp");
        assert.equal(entryApply.fxp, undefined);
        assert.doesNotMatch((entryApply.commands || []).join("\n"), /203\.0\.113\.20/);
        if (scenario.forwardType === "nftables") {
          assert.doesNotMatch((entryApply.commands || []).join("\n"), /fwx-stat-|forwardx_traffic/);
        }
      }

      const gostConfigText = findManagedConfig(entryActions, "/runtime/gost.json");
      assert.ok(gostConfigText, "missing gost runtime config");
      const gostConfig = JSON.parse(gostConfigText);
      const gostService = gostConfig.services.find((service) => service.name === "fwx-201-tcp");
      assert.ok(gostService);
      assert.equal(gostService.addr, ":18444");
      assert.equal(gostService.forwarder.nodes[0].addr, exitHostIp + ":24001");

      const nginxConfigText = findManagedConfig(entryActions, "/nginx/nginx.conf");
      assert.ok(nginxConfigText, "missing nginx runtime config");
      assert.match(nginxConfigText, /listen \[::\]:18445\b/);
      assert.match(nginxConfigText, /server 198\.51\.100\.20:24002\b/);
      assert.doesNotMatch(nginxConfigText, /127\.0\.0\.1:43\d+/);

      const exit = await postHeartbeat(baseUrl, "exit-token", { agentBootId: "boot-exit", agentProcessId: 2002 });
      assert.equal(exit.status, 200);
      assert.equal(exit.payload.success, true);
      const exitActions = exit.payload.desiredState.actions;
      const splitterApplies = exitActions
        .filter((action) => action.op === "apply" && action.fxp?.role === "sni-splitter")
        .sort((left, right) => Number(left.sourcePort) - Number(right.sourcePort));
      assert.equal(splitterApplies.length, scenarios.length);
      for (const [index, scenario] of scenarios.entries()) {
        const splitterApply = splitterApplies[index];
        assert.equal(splitterApply.sourcePort, scenario.splitterPort);
        assert.equal(splitterApply.targetIp, exitHostIp);
        assert.equal(splitterApply.targetPort, scenario.splitterPort);
        assert.equal(splitterApply.fxp.listenPort, scenario.splitterPort);
        assert.deepEqual(splitterApply.fxp.sniRoutes, [{
          sni: scenario.sni,
          ruleId: scenario.exitRuleId,
          targetIp: finalTargetIp,
          targetPort: 443,
          limitIn: 0,
          limitOut: 0,
          maxConnections: 0,
          maxIPs: 0,
          accessScope: "u1_h2",
        }]);
      }

      const runningSplitters = exit.payload.runningRules
        .filter((rule) => rule.forwardType === "forwardx" && scenarios.some((scenario) => Number(scenario.splitterPort) === Number(rule.sourcePort)))
        .sort((left, right) => Number(left.sourcePort) - Number(right.sourcePort));
      assert.equal(runningSplitters.length, scenarios.length);
      for (const scenario of scenarios) {
        await runtime.executeRaw('UPDATE "forward_rules" SET "isRunning" = 1 WHERE "id" = ?', [scenario.exitRuleId]);
      }
      const exitWithoutDrift = await postHeartbeat(baseUrl, "exit-token", {
        agentBootId: "boot-exit",
        agentProcessId: 2002,
        forceReconcile: true,
        localState: {
          rules: runningSplitters.map((rule) => ({
            port: rule.sourcePort,
            ruleId: rule.ruleId,
            forwardType: rule.forwardType,
            targetIp: rule.targetIp,
            targetPort: rule.targetPort,
            protocol: rule.protocol,
            ready: true,
          })),
          tunnels: [],
          services: [],
        },
      });
      assert.equal(exitWithoutDrift.status, 200);
      assert.equal(exitWithoutDrift.payload.success, true);
      const repeatedSplitterApplies = exitWithoutDrift.payload.desiredState.actions
        .filter((action) => action.op === "apply" && action.fxp?.role === "sni-splitter");
      assert.equal(repeatedSplitterApplies.length, 0);

      await runtime.executeRaw('UPDATE "forward_rules" SET "isEnabled" = 0, "isRunning" = 0 WHERE "id" = ?', [scenarios[0].exitRuleId]);
      const staleSplitterCleanup = await postHeartbeat(baseUrl, "exit-token", {
        agentBootId: "boot-exit",
        agentProcessId: 2002,
        forceReconcile: true,
        localState: {
          rules: [{
            port: scenarios[0].splitterPort,
            ruleId: scenarios[0].exitRuleId,
            forwardType: "forwardx",
            targetIp: exitHostIp,
            targetPort: scenarios[0].splitterPort,
            protocol: "tcp",
            ready: true,
          }],
          tunnels: [],
          services: [],
        },
      });
      assert.equal(staleSplitterCleanup.status, 200);
      assert.equal(staleSplitterCleanup.payload.success, true);
      const removeSplitter = staleSplitterCleanup.payload.desiredState.actions.find(
        (action) => action.op === "remove" && action.ruleId === scenarios[0].exitRuleId,
      );
      assert.ok(removeSplitter, "missing stale sni splitter remove action");
      assert.equal(removeSplitter.fxp?.role, "sni-splitter");
      assert.equal(removeSplitter.fxp?.listenPort, scenarios[0].splitterPort);
    } finally {
      if (server) await new Promise((resolve) => server.close(resolve));
      await runtime.closeDatabase();
    }
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: databasePath },
    encoding: "utf8",
    timeout: 60_000,
  });
  fs.rmSync(directory, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
