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
    const relayHostIp = "198.51.100.15";
    const exitHostIp = "198.51.100.20";
    const finalTargetIp = "203.0.113.20";
    const scenarios = [
      { forwardType: "nftables", groupId: 10, templateId: 100, entryRuleId: 101, exitRuleId: 102, entryMemberId: 1001, exitMemberId: 1002, sourcePort: 18443, splitterPort: 24000, sni: "api.example.com" },
      { forwardType: "gost", groupId: 20, templateId: 200, entryRuleId: 201, exitRuleId: 202, entryMemberId: 2001, exitMemberId: 2002, sourcePort: 18444, splitterPort: 24001, sni: "gost.example.com" },
      { forwardType: "nginx", groupId: 30, templateId: 300, entryRuleId: 301, exitRuleId: 302, entryMemberId: 3001, exitMemberId: 3002, sourcePort: 18445, splitterPort: 24002, sni: "nginx.example.com" },
    ];
    const threeHop = { groupId: 40, templateId: 400, entryRuleId: 401, relayRuleId: 402, exitRuleId: 403, entryMemberId: 4001, relayMemberId: 4002, exitMemberId: 4003, sourcePort: 18446, relayPort: 23100, splitterPort: 24003, sni: "three-hop.example.com" };
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
      await insert("hosts", ["id", "name", "ip", "ipv4", "agentToken", "userId", "isOnline", "lastHeartbeat", "agentVersion", "portRangeStart", "portRangeEnd"], [3, "relay", relayHostIp, relayHostIp, "relay-token", 1, 1, now, "2.2.195", 23000, 23999]);
      for (const scenario of scenarios) {
        await insertSniChain(scenario);
      }
      await insert("forward_groups", ["id", "name", "groupType", "groupMode", "forwardType", "domain", "targetIp", "targetPort", "userId", "isEnabled"], [threeHop.groupId, "three-hop-chain", "host", "chain", "gost", "", "0.0.0.0", 1, 1, 1]);
      await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [threeHop.entryMemberId, threeHop.groupId, "host", 1, 10, 1]);
      await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [threeHop.relayMemberId, threeHop.groupId, "host", 3, 20, 1]);
      await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [threeHop.exitMemberId, threeHop.groupId, "host", 2, 30, 1]);
      await insert("forward_rules", [
        "id", "hostId", "name", "forwardType", "protocol", "forwardGroupId", "isForwardGroupTemplate",
        "sourcePort", "sni", "sniSplitterPort", "targetIp", "targetPort", "rateLimitMbps", "maxConnections", "userId", "isEnabled", "isRunning"
      ], [threeHop.templateId, 1, "three-hop-template", "gost", "tcp", threeHop.groupId, 1, threeHop.sourcePort, threeHop.sni, threeHop.splitterPort, finalTargetIp, 443, 100, 7, 1, 1, 0]);
      await insert("forward_rules", [
        "id", "hostId", "name", "forwardType", "protocol", "forwardGroupId", "forwardGroupRuleId", "forwardGroupMemberId", "isForwardGroupTemplate",
        "sourcePort", "sni", "sniSplitterPort", "targetIp", "targetPort", "rateLimitMbps", "maxConnections", "userId", "isEnabled", "isRunning"
      ], [threeHop.entryRuleId, 1, "three-hop-entry", "gost", "tcp", threeHop.groupId, threeHop.templateId, threeHop.entryMemberId, 0, threeHop.sourcePort, threeHop.sni, threeHop.splitterPort, relayHostIp, threeHop.relayPort, 100, 7, 1, 1, 0]);
      await insert("forward_rules", [
        "id", "hostId", "name", "forwardType", "protocol", "forwardGroupId", "forwardGroupRuleId", "forwardGroupMemberId", "isForwardGroupTemplate",
        "sourcePort", "sni", "sniSplitterPort", "targetIp", "targetPort", "rateLimitMbps", "maxConnections", "userId", "isEnabled", "isRunning"
      ], [threeHop.relayRuleId, 3, "three-hop-relay", "gost", "tcp", threeHop.groupId, threeHop.templateId, threeHop.relayMemberId, 0, threeHop.relayPort, threeHop.sni, threeHop.splitterPort, exitHostIp, threeHop.splitterPort, 100, 7, 1, 1, 0]);
      await insert("forward_rules", [
        "id", "hostId", "name", "forwardType", "protocol", "forwardGroupId", "forwardGroupRuleId", "forwardGroupMemberId", "isForwardGroupTemplate",
        "sourcePort", "sni", "sniSplitterPort", "targetIp", "targetPort", "rateLimitMbps", "maxConnections", "userId", "isEnabled", "isRunning"
      ], [threeHop.exitRuleId, 2, "three-hop-exit", "gost", "tcp", threeHop.groupId, threeHop.templateId, threeHop.exitMemberId, 0, threeHop.splitterPort, threeHop.sni, threeHop.splitterPort, finalTargetIp, 443, 100, 7, 1, 1, 0]);

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

      const entrySplitters = entryActions
        .filter((action) => action.op === "apply" && action.fxp?.role === "sni-splitter")
        .sort((left, right) => Number(left.sourcePort) - Number(right.sourcePort));
      assert.equal(entrySplitters.length, scenarios.length + 1);
      for (const [index, scenario] of scenarios.entries()) {
        const entryApply = entrySplitters[index];
        assert.equal(entryApply.ruleId, scenario.entryRuleId);
        assert.equal(entryApply.forwardType, "forwardx");
        assert.equal(entryApply.sourcePort, scenario.sourcePort);
        assert.equal(entryApply.protocol, "tcp");
        assert.equal(entryApply.fxp.listenPort, scenario.sourcePort);
        assert.deepEqual(entryApply.fxp.sourceAllowIps, []);
        assert.deepEqual(entryApply.fxp.sniRoutes, [{
          sni: scenario.sni,
          ruleId: scenario.entryRuleId,
          targetIp: exitHostIp,
          targetPort: scenario.splitterPort,
        }]);
        assert.doesNotMatch((entryApply.commands || []).join("\n"), /tcp dport \d+ drop/);
      }
      const threeHopEntry = entrySplitters.at(-1);
      assert.equal(threeHopEntry.sourcePort, threeHop.sourcePort);
      assert.deepEqual(threeHopEntry.fxp.sniRoutes, [{
        sni: threeHop.sni,
        ruleId: threeHop.entryRuleId,
        targetIp: relayHostIp,
        targetPort: threeHop.relayPort,
      }]);

      const relay = await postHeartbeat(baseUrl, "relay-token", { agentBootId: "boot-relay", agentProcessId: 2003 });
      assert.equal(relay.status, 200);
      const relayAction = relay.payload.desiredState.actions.find((action) => action.op === "apply" && action.ruleId === threeHop.relayRuleId);
      assert.ok(relayAction, "missing three-hop relay action");
      assert.equal(relayAction.forwardType, "gost");
      assert.equal(relayAction.sourcePort, threeHop.relayPort);
      assert.equal(relayAction.targetIp, exitHostIp);
      assert.equal(relayAction.targetPort, threeHop.splitterPort);
      assert.equal(relayAction.fxp, undefined);

      const exit = await postHeartbeat(baseUrl, "exit-token", { agentBootId: "boot-exit", agentProcessId: 2002 });
      assert.equal(exit.status, 200);
      assert.equal(exit.payload.success, true);
      const exitActions = exit.payload.desiredState.actions;
      const splitterApplies = exitActions
        .filter((action) => action.op === "apply" && action.fxp?.role === "sni-splitter")
        .sort((left, right) => Number(left.sourcePort) - Number(right.sourcePort));
      assert.equal(splitterApplies.length, scenarios.length + 1);
      for (const [index, scenario] of scenarios.entries()) {
        const splitterApply = splitterApplies[index];
        assert.equal(splitterApply.sourcePort, scenario.splitterPort);
        assert.equal(splitterApply.targetIp, exitHostIp);
        assert.equal(splitterApply.targetPort, scenario.splitterPort);
        assert.equal(splitterApply.fxp.listenPort, scenario.splitterPort);
        assert.equal(splitterApply.fxp.sniRouteVersion, 1);
        assert.deepEqual(splitterApply.fxp.sourceAllowIps, [entryHostIp]);
        const splitterCommands = (splitterApply.commands || []).join("\n");
        assert.match(splitterCommands, new RegExp("fwx-sni-splitter-" + scenario.splitterPort));
        assert.match(splitterCommands, new RegExp("ip saddr " + entryHostIp.replace(/\./g, "\\.") + " tcp dport " + scenario.splitterPort + " accept"));
        assert.match(splitterCommands, new RegExp("tcp dport " + scenario.splitterPort + " drop"));
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
      const threeHopExit = splitterApplies.at(-1);
      assert.deepEqual(threeHopExit.fxp.sourceAllowIps, [relayHostIp]);
      assert.deepEqual(threeHopExit.fxp.sniRoutes, [{
        sni: threeHop.sni,
        ruleId: threeHop.exitRuleId,
        targetIp: finalTargetIp,
        targetPort: 443,
        limitIn: 12_500_000,
        limitOut: 12_500_000,
        maxConnections: 7,
        maxIPs: 0,
        accessScope: "u1_h2",
      }]);

      const runtimeScenarios = [
        ...scenarios.map((scenario) => ({
          ...scenario,
          sourceAllowIps: [entryHostIp],
          limitIn: 0,
          limitOut: 0,
          maxConnections: 0,
        })),
        {
          ...threeHop,
          sourceAllowIps: [relayHostIp],
          limitIn: 12_500_000,
          limitOut: 12_500_000,
          maxConnections: 7,
        },
      ];
      const runningSplitters = exit.payload.runningRules
        .filter((rule) => rule.forwardType === "forwardx" && runtimeScenarios.some((scenario) => Number(scenario.splitterPort) === Number(rule.sourcePort)))
        .sort((left, right) => Number(left.sourcePort) - Number(right.sourcePort));
      assert.equal(runningSplitters.length, runtimeScenarios.length);
      for (const scenario of runtimeScenarios) {
        await runtime.executeRaw('UPDATE "forward_rules" SET "isRunning" = 1 WHERE "id" = ?', [scenario.exitRuleId]);
      }
      const exitWithoutDrift = await postHeartbeat(baseUrl, "exit-token", {
        agentBootId: "boot-exit",
        agentProcessId: 2002,
        forceReconcile: true,
        localState: {
          rules: runningSplitters.map((rule) => {
            const scenario = runtimeScenarios.find((item) => Number(item.splitterPort) === Number(rule.sourcePort));
            assert.ok(scenario);
            return {
              port: scenario.splitterPort,
              ruleId: scenario.exitRuleId,
              forwardType: "forwardx",
              sni: scenario.sni,
              targetIp: finalTargetIp,
              targetPort: 443,
              limitIn: scenario.limitIn,
              limitOut: scenario.limitOut,
              maxConnections: scenario.maxConnections,
              maxIPs: 0,
              accessScope: "u1_h2",
              protocol: "tcp",
              sniRouteVersion: 1,
              sourceAllowIps: scenario.sourceAllowIps,
              ready: true,
            };
          }),
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
            sni: scenarios[0].sni,
            targetIp: finalTargetIp,
            targetPort: 443,
            accessScope: "u1_h2",
            protocol: "tcp",
            sniRouteVersion: 1,
            sourceAllowIps: [entryHostIp],
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
      assert.match((removeSplitter.commands || []).join("\n"), new RegExp("fwx-sni-splitter-" + scenarios[0].splitterPort));
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

test("SNI forward chains share one entry splitter and keep per-chain next hops", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-sni-desired-state-shared-"));
  const databasePath = path.join(directory, "sni-desired-shared.db");
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
    const rulesCrud = await import(moduleUrl("server/routers/rules.crud.ts"));
    const { rulesRouter } = await import(moduleUrl("server/routers/rules.ts"));
    const q = (name) => '"' + name + '"';
    const insert = async (table, columns, values) => {
      await runtime.executeRaw(
        "INSERT INTO " + q(table) + " (" + columns.map(q).join(", ") + ") VALUES (" + values.map(() => "?").join(", ") + ")",
        values,
      );
    };
    const heartbeatBody = {
      agentVersion: "2.2.195",
      agentBootId: "boot-sni-shared",
      agentProcessId: 1001,
      agentProcessStartedAt: Math.floor(Date.now() / 1000),
      forceReconcile: true,
    };
    const entryHostIp = "198.51.100.10";
    const refreshedEntryHostIp = "198.51.100.11";
    const exitHostIp = "198.51.100.20";
    const entryGroupHostIps = ["198.51.100.30", "198.51.100.40"];
    const entryGroupRelayHostIp = "198.51.100.50";
    const entryGroupThreeHop = {
      groupId: 60,
      templateId: 600,
      entryARuleId: 601,
      relayRuleId: 602,
      entryBRuleId: 603,
      exitRuleId: 604,
      relayMemberId: 6001,
      exitMemberId: 6002,
      sourcePort: 18444,
      relayPort: 23000,
      splitterPort: 24004,
      sni: "group-three-hop.example.com",
    };
    const routes = [
      { templateId: 100, entryRuleId: 101, exitRuleId: 102, name: "api", sni: "api.example.com", targetIp: "203.0.113.20", targetPort: 443 },
      { templateId: 110, entryRuleId: 111, exitRuleId: 112, name: "web", sni: "web.example.com", targetIp: "203.0.113.21", targetPort: 8443 },
    ];
    const runtimeGroups = [
      {
        groupId: 20,
        forwardType: "gost",
        sourcePort: 18443,
        splitterPort: 24001,
        entryMemberId: 2001,
        exitMemberId: 2002,
        routes: [
          { templateId: 200, entryRuleId: 201, exitRuleId: 202, name: "gost-api", sni: "gost-api.example.com", targetIp: "203.0.113.30", targetPort: 443 },
          { templateId: 210, entryRuleId: 211, exitRuleId: 212, name: "gost-web", sni: "gost-web.example.com", targetIp: "203.0.113.31", targetPort: 8443 },
        ],
      },
      {
        groupId: 30,
        forwardType: "nginx",
        sourcePort: 18443,
        splitterPort: 24002,
        entryMemberId: 3001,
        exitMemberId: 3002,
        routes: [
          { templateId: 300, entryRuleId: 301, exitRuleId: 302, name: "nginx-api", sni: "nginx-api.example.com", targetIp: "203.0.113.40", targetPort: 443 },
          { templateId: 310, entryRuleId: 311, exitRuleId: 312, name: "nginx-web", sni: "nginx-web.example.com", targetIp: "203.0.113.41", targetPort: 8443 },
        ],
      },
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

    async function insertSniRule(route, options = {}) {
      const groupId = Number(options.groupId || 10);
      const forwardType = String(options.forwardType || "nftables");
      const sourcePort = Number(options.sourcePort || 18443);
      const splitterPort = Number(options.splitterPort || 24000);
      const entryMemberId = Number(options.entryMemberId || 1001);
      const exitMemberId = Number(options.exitMemberId || 1002);
      await insert("forward_rules", [
        "id", "hostId", "name", "forwardType", "protocol", "forwardGroupId", "isForwardGroupTemplate",
        "sourcePort", "sni", "sniSplitterPort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning"
      ], [route.templateId, 1, route.name + "-template", forwardType, "tcp", groupId, 1, sourcePort, route.sni, splitterPort, route.targetIp, route.targetPort, 1, 1, 0]);
      await insert("forward_rules", [
        "id", "hostId", "name", "forwardType", "protocol", "forwardGroupId", "forwardGroupRuleId", "forwardGroupMemberId", "isForwardGroupTemplate",
        "sourcePort", "sni", "sniSplitterPort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning"
      ], [route.entryRuleId, 1, route.name + "-entry-child", forwardType, "tcp", groupId, route.templateId, entryMemberId, 0, sourcePort, route.sni, splitterPort, exitHostIp, splitterPort, 1, 1, 0]);
      await insert("forward_rules", [
        "id", "hostId", "name", "forwardType", "protocol", "forwardGroupId", "forwardGroupRuleId", "forwardGroupMemberId", "isForwardGroupTemplate",
        "sourcePort", "sni", "sniSplitterPort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning"
      ], [route.exitRuleId, 2, route.name + "-exit-child", forwardType, "tcp", groupId, route.templateId, exitMemberId, 0, splitterPort, route.sni, splitterPort, route.targetIp, route.targetPort, 1, 1, 0]);
    }

    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      const now = Math.floor(Date.now() / 1000);
      await insert("users", ["id", "username", "password", "role", "canAddRules", "manualCanAddRules"], [1, "admin", "x", "admin", 1, 1]);
      await insert("system_settings", ["key", "value"], ["forwardProtocols", JSON.stringify({ nginx: true })]);
      await insert("hosts", ["id", "name", "ip", "ipv4", "agentToken", "userId", "blockHttp", "isOnline", "lastHeartbeat", "agentVersion", "portRangeStart", "portRangeEnd"], [1, "entry", entryHostIp, entryHostIp, "entry-token", 1, 1, 1, now, "2.2.195", 18000, 19000]);
      await insert("hosts", ["id", "name", "ip", "ipv4", "agentToken", "userId", "isOnline", "lastHeartbeat", "agentVersion", "portRangeStart", "portRangeEnd"], [2, "exit", exitHostIp, exitHostIp, "exit-token", 1, 1, now, "2.2.195", 24000, 24010]);
      await insert("hosts", ["id", "name", "ip", "ipv4", "agentToken", "userId", "isOnline", "lastHeartbeat", "agentVersion", "portRangeStart", "portRangeEnd"], [3, "entry-a", entryGroupHostIps[0], entryGroupHostIps[0], "entry-a-token", 1, 1, now, "2.2.195", 18000, 19000]);
      await insert("hosts", ["id", "name", "ip", "ipv4", "agentToken", "userId", "isOnline", "lastHeartbeat", "agentVersion", "portRangeStart", "portRangeEnd"], [4, "entry-b", entryGroupHostIps[1], entryGroupHostIps[1], "entry-b-token", 1, 1, now, "2.2.195", 18000, 19000]);
      await insert("hosts", ["id", "name", "ip", "ipv4", "agentToken", "userId", "isOnline", "lastHeartbeat", "agentVersion", "portRangeStart", "portRangeEnd"], [5, "entry-group-relay", entryGroupRelayHostIp, entryGroupRelayHostIp, "entry-group-relay-token", 1, 1, now, "2.2.195", 23000, 23999]);
      await insert("forward_groups", ["id", "name", "groupType", "groupMode", "forwardType", "domain", "targetIp", "targetPort", "userId", "isEnabled"], [10, "shared-chain", "host", "chain", "nftables", "", "0.0.0.0", 1, 1, 1]);
      await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [1001, 10, "host", 1, 10, 1]);
      await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [1002, 10, "host", 2, 20, 1]);
      for (const route of routes) {
        await insertSniRule(route);
      }
      await insert("forward_groups", ["id", "name", "groupType", "groupMode", "forwardType", "domain", "targetIp", "targetPort", "userId", "isEnabled"], [40, "sni-entry-group", "host", "entry", "nftables", "", "0.0.0.0", 1, 1, 1]);
      await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [4001, 40, "host", 3, 10, 1]);
      await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [4002, 40, "host", 4, 20, 1]);
      await insert("forward_groups", ["id", "name", "groupType", "groupMode", "entryGroupId", "forwardType", "domain", "targetIp", "targetPort", "userId", "isEnabled"], [50, "entry-group-chain", "host", "chain", 40, "nftables", "", "0.0.0.0", 1, 1, 1]);
      await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [5002, 50, "host", 2, 10, 1]);
      await insert("forward_rules", [
        "id", "hostId", "name", "forwardType", "protocol", "forwardGroupId", "forwardGroupMemberId", "isForwardGroupTemplate",
        "sourcePort", "sni", "sniSplitterPort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning"
      ], [502, 2, "entry-group-exit-child", "nftables", "tcp", 50, 5002, 0, 24003, "group.example.com", 24003, "203.0.113.50", 443, 1, 1, 0]);
      await insert("forward_groups", ["id", "name", "groupType", "groupMode", "entryGroupId", "forwardType", "domain", "targetIp", "targetPort", "userId", "isEnabled"], [entryGroupThreeHop.groupId, "entry-group-three-hop-chain", "host", "chain", 40, "gost", "", "0.0.0.0", 1, 1, 1]);
      await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [entryGroupThreeHop.relayMemberId, entryGroupThreeHop.groupId, "host", 5, 10, 1]);
      await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [entryGroupThreeHop.exitMemberId, entryGroupThreeHop.groupId, "host", 2, 20, 1]);
      await insert("forward_rules", [
        "id", "hostId", "name", "forwardType", "protocol", "forwardGroupId", "isForwardGroupTemplate",
        "sourcePort", "sni", "sniSplitterPort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning"
      ], [entryGroupThreeHop.templateId, 3, "entry-group-three-hop-template", "gost", "tcp", entryGroupThreeHop.groupId, 1, entryGroupThreeHop.sourcePort, entryGroupThreeHop.sni, entryGroupThreeHop.splitterPort, "203.0.113.60", 443, 1, 1, 0]);
      for (const [id, hostId, name] of [
        [entryGroupThreeHop.entryARuleId, 3, "entry-group-three-hop-entry-a"],
        [entryGroupThreeHop.entryBRuleId, 4, "entry-group-three-hop-entry-b"],
      ]) {
        await insert("forward_rules", [
          "id", "hostId", "name", "forwardType", "protocol", "forwardGroupId", "forwardGroupRuleId", "forwardGroupMemberId", "isForwardGroupTemplate",
          "sourcePort", "sni", "sniSplitterPort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning"
        ], [id, hostId, name, "gost", "tcp", entryGroupThreeHop.groupId, entryGroupThreeHop.templateId, entryGroupThreeHop.relayMemberId, 0, entryGroupThreeHop.sourcePort, entryGroupThreeHop.sni, entryGroupThreeHop.splitterPort, entryGroupRelayHostIp, entryGroupThreeHop.relayPort, 1, 1, 0]);
      }
      await insert("forward_rules", [
        "id", "hostId", "name", "forwardType", "protocol", "forwardGroupId", "forwardGroupRuleId", "forwardGroupMemberId", "isForwardGroupTemplate",
        "sourcePort", "sni", "sniSplitterPort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning"
      ], [entryGroupThreeHop.relayRuleId, 5, "entry-group-three-hop-relay", "gost", "tcp", entryGroupThreeHop.groupId, entryGroupThreeHop.templateId, entryGroupThreeHop.relayMemberId, 0, entryGroupThreeHop.relayPort, entryGroupThreeHop.sni, entryGroupThreeHop.splitterPort, exitHostIp, entryGroupThreeHop.splitterPort, 1, 1, 0]);
      await insert("forward_rules", [
        "id", "hostId", "name", "forwardType", "protocol", "forwardGroupId", "forwardGroupRuleId", "forwardGroupMemberId", "isForwardGroupTemplate",
        "sourcePort", "sni", "sniSplitterPort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning"
      ], [entryGroupThreeHop.exitRuleId, 2, "entry-group-three-hop-exit", "gost", "tcp", entryGroupThreeHop.groupId, entryGroupThreeHop.templateId, entryGroupThreeHop.exitMemberId, 0, entryGroupThreeHop.splitterPort, entryGroupThreeHop.sni, entryGroupThreeHop.splitterPort, "203.0.113.60", 443, 1, 1, 0]);
      for (const group of runtimeGroups) {
        await insert("forward_groups", ["id", "name", "groupType", "groupMode", "forwardType", "domain", "targetIp", "targetPort", "userId", "isEnabled"], [group.groupId, group.forwardType + "-shared-chain", "host", "chain", group.forwardType, "", "0.0.0.0", 1, 1, 1]);
        await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [group.entryMemberId, group.groupId, "host", 1, 10, 1]);
        await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [group.exitMemberId, group.groupId, "host", 2, 20, 1]);
        for (const route of group.routes) {
          await insertSniRule(route, group);
        }
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

      const entry = await postHeartbeat(baseUrl, "entry-token", { agentBootId: "boot-entry-shared", agentProcessId: 2001 });
      assert.equal(entry.status, 200);
      assert.equal(entry.payload.success, true);
      const entryActions = entry.payload.desiredState.actions;
      const entryApplies = entryActions.filter((action) => action.op === "apply" && action.sourcePort === 18443);
      assert.equal(entryApplies.length, 1);
      assert.equal(entryApplies[0].forwardType, "forwardx");
      assert.equal(entryApplies[0].protocol, "tcp");
      assert.equal(entryApplies[0].fxp.role, "sni-splitter");
      assert.equal(entryApplies[0].fxp.listenPort, 18443);
      assert.deepEqual(entryApplies[0].fxp.sourceAllowIps, []);
      assert.deepEqual(entryApplies[0].fxp.sniRoutes, [
        { sni: "api.example.com", ruleId: 101, targetIp: exitHostIp, targetPort: 24000 },
        { sni: "gost-api.example.com", ruleId: 201, targetIp: exitHostIp, targetPort: 24001 },
        { sni: "gost-web.example.com", ruleId: 211, targetIp: exitHostIp, targetPort: 24001 },
        { sni: "nginx-api.example.com", ruleId: 301, targetIp: exitHostIp, targetPort: 24002 },
        { sni: "nginx-web.example.com", ruleId: 311, targetIp: exitHostIp, targetPort: 24002 },
        { sni: "web.example.com", ruleId: 111, targetIp: exitHostIp, targetPort: 24000 },
      ]);
      assert.doesNotMatch(JSON.stringify(entryActions), /203\.0\.113\./);
      assert.doesNotMatch(decodedManagedConfigText(entryActions), /203\.0\.113\./);
      assert.doesNotMatch((entryApplies[0].commands || []).join("\n"), /fwx-stat-|forwardx_traffic/);
      assert.doesNotMatch((entryApplies[0].commands || []).join("\n"), /\bcounter\b/);

      const gostConfigText = findManagedConfig(entryActions, "/runtime/gost.json");
      if (gostConfigText) assert.equal(JSON.parse(gostConfigText).services.filter((service) => service.addr === ":18443").length, 0);
      assert.doesNotMatch(findManagedConfig(entryActions, "/nginx/nginx.conf"), /listen \[::\]:18443\b/);

      for (const [token, ruleId, bootId, processId] of [
        ["entry-a-token", entryGroupThreeHop.entryARuleId, "boot-entry-a", 2003],
        ["entry-b-token", entryGroupThreeHop.entryBRuleId, "boot-entry-b", 2004],
      ]) {
        const entryGroupHeartbeat = await postHeartbeat(baseUrl, token, { agentBootId: bootId, agentProcessId: processId });
        assert.equal(entryGroupHeartbeat.status, 200);
        const entryGroupApply = entryGroupHeartbeat.payload.desiredState.actions.find(
          (action) => action.op === "apply" && action.fxp?.role === "sni-splitter" && Number(action.sourcePort) === entryGroupThreeHop.sourcePort,
        );
        assert.ok(entryGroupApply, "missing entry-group public entry splitter");
        assert.equal(entryGroupApply.ruleId, ruleId);
        assert.deepEqual(entryGroupApply.fxp.sourceAllowIps, []);
        assert.deepEqual(entryGroupApply.fxp.sniRoutes, [{
          sni: entryGroupThreeHop.sni,
          ruleId,
          targetIp: entryGroupRelayHostIp,
          targetPort: entryGroupThreeHop.relayPort,
        }]);
      }

      const entryGroupRelay = await postHeartbeat(baseUrl, "entry-group-relay-token", { agentBootId: "boot-entry-group-relay", agentProcessId: 2005 });
      assert.equal(entryGroupRelay.status, 200);
      const entryGroupRelayApply = entryGroupRelay.payload.desiredState.actions.find(
        (action) => action.op === "apply" && action.ruleId === entryGroupThreeHop.relayRuleId,
      );
      assert.ok(entryGroupRelayApply, "missing entry-group chain relay action");
      assert.equal(entryGroupRelayApply.forwardType, "gost");
      assert.equal(entryGroupRelayApply.sourcePort, entryGroupThreeHop.relayPort);
      assert.equal(entryGroupRelayApply.targetIp, exitHostIp);
      assert.equal(entryGroupRelayApply.targetPort, entryGroupThreeHop.splitterPort);
      assert.equal(entryGroupRelayApply.fxp, undefined);

      const exit = await postHeartbeat(baseUrl, "exit-token", { agentBootId: "boot-exit-shared", agentProcessId: 2002 });
      assert.equal(exit.status, 200);
      assert.equal(exit.payload.success, true);
      const splitterApplies = exit.payload.desiredState.actions.filter((action) => action.op === "apply" && action.fxp?.role === "sni-splitter" && Number(action.sourcePort) === 24000);
      assert.equal(splitterApplies.length, 1);
      assert.equal(splitterApplies[0].sourcePort, 24000);
      assert.equal(splitterApplies[0].fxp.sniRouteVersion, 1);
      assert.deepEqual(splitterApplies[0].fxp.sourceAllowIps, [entryHostIp]);
      const splitterCommandText = (splitterApplies[0].commands || []).join("\n");
      assert.match(splitterCommandText, /fwx-sni-splitter-24000/);
      assert.match(splitterCommandText, /ip saddr 198\.51\.100\.10 tcp dport 24000 accept/);
      assert.match(splitterCommandText, /tcp dport 24000 drop/);
      assert.deepEqual(splitterApplies[0].fxp.sniRoutes, [
        {
          sni: "api.example.com",
          ruleId: 102,
          targetIp: "203.0.113.20",
          targetPort: 443,
          limitIn: 0,
          limitOut: 0,
          maxConnections: 0,
          maxIPs: 0,
          accessScope: "u1_h2",
        },
        {
          sni: "web.example.com",
          ruleId: 112,
          targetIp: "203.0.113.21",
          targetPort: 8443,
          limitIn: 0,
          limitOut: 0,
          maxConnections: 0,
          maxIPs: 0,
          accessScope: "u1_h2",
        },
      ]);
      const entryGroupSplitterApply = exit.payload.desiredState.actions.find(
        (action) => action.op === "apply" && action.fxp?.role === "sni-splitter" && Number(action.sourcePort) === 24003,
      );
      assert.ok(entryGroupSplitterApply, "missing entry-group sni splitter apply");
      assert.deepEqual(entryGroupSplitterApply.fxp.sourceAllowIps, entryGroupHostIps);
      const entryGroupCommandText = (entryGroupSplitterApply.commands || []).join("\n");
      for (const sourceIp of entryGroupHostIps) {
        assert.match(entryGroupCommandText, new RegExp("ip saddr " + sourceIp.replace(/\./g, "\\.") + " tcp dport 24003 accept"));
      }
      assert.match(entryGroupCommandText, /tcp dport 24003 drop/);
      const entryGroupThreeHopExit = exit.payload.desiredState.actions.find(
        (action) => action.op === "apply" && action.fxp?.role === "sni-splitter" && Number(action.sourcePort) === entryGroupThreeHop.splitterPort,
      );
      assert.ok(entryGroupThreeHopExit, "missing entry-group three-hop exit splitter");
      assert.deepEqual(entryGroupThreeHopExit.fxp.sourceAllowIps, [entryGroupRelayHostIp]);
      assert.deepEqual(entryGroupThreeHopExit.fxp.sniRoutes, [{
        sni: entryGroupThreeHop.sni,
        ruleId: entryGroupThreeHop.exitRuleId,
        targetIp: "203.0.113.60",
        targetPort: 443,
        limitIn: 0,
        limitOut: 0,
        maxConnections: 0,
        maxIPs: 0,
        accessScope: "u1_h2",
      }]);

      await postHeartbeat(baseUrl, "exit-token", {
        agentBootId: "boot-exit-shared",
        agentProcessId: 2002,
        localState: {
          rules: [{
            port: entryGroupThreeHop.splitterPort,
            ruleId: entryGroupThreeHop.exitRuleId,
            forwardType: "forwardx",
            sni: entryGroupThreeHop.sni,
            targetIp: "203.0.113.60",
            targetPort: 443,
            protocol: "tcp",
            sniRouteVersion: 1,
            sourceAllowIps: [entryGroupRelayHostIp],
            ready: true,
          }],
          tunnels: [],
          services: [],
        },
      });
      await postHeartbeat(baseUrl, "entry-a-token", {
        agentBootId: "boot-entry-a",
        agentProcessId: 2003,
        localState: {
          rules: [{
            port: entryGroupThreeHop.sourcePort,
            ruleId: entryGroupThreeHop.entryARuleId,
            forwardType: "forwardx",
            sni: entryGroupThreeHop.sni,
            targetIp: entryGroupRelayHostIp,
            targetPort: entryGroupThreeHop.relayPort,
            protocol: "tcp",
            sniRouteVersion: 1,
            sourceAllowIps: [],
            ready: true,
          }],
          tunnels: [],
          services: [],
        },
      });
      const partialEntryStates = await runtime.queryRaw(
        'SELECT "id", "isRunning" FROM "forward_rules" WHERE "id" BETWEEN 600 AND 604 ORDER BY "id"',
      );
      assert.deepEqual(partialEntryStates.map((row) => [Number(row.id), Number(row.isRunning)]), [
        [600, 0], [601, 0], [602, 0], [603, 0], [604, 0],
      ]);
      await postHeartbeat(baseUrl, "entry-b-token", {
        agentBootId: "boot-entry-b",
        agentProcessId: 2004,
        localState: {
          rules: [{
            port: entryGroupThreeHop.sourcePort,
            ruleId: entryGroupThreeHop.entryBRuleId,
            forwardType: "forwardx",
            sni: entryGroupThreeHop.sni,
            targetIp: entryGroupRelayHostIp,
            targetPort: entryGroupThreeHop.relayPort,
            protocol: "tcp",
            sniRouteVersion: 1,
            sourceAllowIps: [],
            ready: true,
          }],
          tunnels: [],
          services: [],
        },
      });
      const completeEntryStates = await runtime.queryRaw(
        'SELECT "id", "isRunning" FROM "forward_rules" WHERE "id" BETWEEN 600 AND 604 ORDER BY "id"',
      );
      assert.deepEqual(completeEntryStates.map((row) => [Number(row.id), Number(row.isRunning)]), [
        [600, 1], [601, 1], [602, 0], [603, 1], [604, 1],
      ]);

      for (const route of routes) {
        await runtime.executeRaw('UPDATE "forward_rules" SET "isRunning" = 1 WHERE "id" = ?', [route.exitRuleId]);
      }
      const exitWithoutDrift = await postHeartbeat(baseUrl, "exit-token", {
        agentBootId: "boot-exit-shared",
        agentProcessId: 2002,
        localState: {
          rules: [
            {
              port: 24000,
              ruleId: 102,
              forwardType: "forwardx",
              sni: "api.example.com",
              targetIp: "203.0.113.20",
              targetPort: 443,
              accessScope: "u1_h2",
              protocol: "tcp",
              sniRouteVersion: 1,
              sourceAllowIps: [entryHostIp],
              ready: true,
            },
            {
              port: 24000,
              ruleId: 112,
              forwardType: "forwardx",
              sni: "web.example.com",
              targetIp: "203.0.113.21",
              targetPort: 8443,
              accessScope: "u1_h2",
              protocol: "tcp",
              sniRouteVersion: 1,
              sourceAllowIps: [entryHostIp],
              ready: true,
            },
          ],
          tunnels: [],
          services: [],
        },
      });
      assert.equal(exitWithoutDrift.status, 200);
      assert.equal(exitWithoutDrift.payload.success, true);
      const repeatedSplitterApplies = exitWithoutDrift.payload.desiredState.actions
        .filter((action) => action.op === "apply" && action.fxp?.role === "sni-splitter" && Number(action.sourcePort) === 24000);
      assert.equal(repeatedSplitterApplies.length, 0);

      await runtime.executeRaw('UPDATE "hosts" SET "ip" = ?, "ipv4" = ? WHERE "id" = 1', [refreshedEntryHostIp, refreshedEntryHostIp]);
      const exitAfterEntryAddressChange = await postHeartbeat(baseUrl, "exit-token", {
        agentBootId: "boot-exit-shared",
        agentProcessId: 2002,
        forceReconcile: true,
        localState: {
          rules: [
            {
              port: 24000,
              ruleId: 102,
              forwardType: "forwardx",
              sni: "api.example.com",
              targetIp: "203.0.113.20",
              targetPort: 443,
              accessScope: "u1_h2",
              protocol: "tcp",
              sniRouteVersion: 1,
              sourceAllowIps: [entryHostIp],
              ready: true,
            },
            {
              port: 24000,
              ruleId: 112,
              forwardType: "forwardx",
              sni: "web.example.com",
              targetIp: "203.0.113.21",
              targetPort: 8443,
              accessScope: "u1_h2",
              protocol: "tcp",
              sniRouteVersion: 1,
              sourceAllowIps: [entryHostIp],
              ready: true,
            },
          ],
          tunnels: [],
          services: [],
        },
      });
      assert.equal(exitAfterEntryAddressChange.status, 200);
      assert.equal(exitAfterEntryAddressChange.payload.success, true);
      const refreshedSourceRestrictionApplies = exitAfterEntryAddressChange.payload.desiredState.actions
        .filter((action) => action.op === "apply" && action.fxp?.role === "sni-splitter" && Number(action.sourcePort) === 24000);
      assert.equal(refreshedSourceRestrictionApplies.length, 1);
      assert.deepEqual(refreshedSourceRestrictionApplies[0].fxp.sourceAllowIps, [refreshedEntryHostIp]);
      const refreshedCommandText = (refreshedSourceRestrictionApplies[0].commands || []).join("\n");
      assert.match(refreshedCommandText, /fwx-sni-splitter-24000/);
      assert.match(refreshedCommandText, /ip saddr 198\.51\.100\.11 tcp dport 24000 accept/);
      assert.doesNotMatch(refreshedCommandText, /ip saddr 198\.51\.100\.10 tcp dport 24000 accept/);
      await runtime.executeRaw('UPDATE "hosts" SET "ip" = ?, "ipv4" = ? WHERE "id" = 1', [entryHostIp, entryHostIp]);

      const gostGroup = runtimeGroups[0];
      const initialGostSplitterApply = exit.payload.desiredState.actions.find(
        (action) => action.op === "apply" && action.fxp?.role === "sni-splitter" && Number(action.sourcePort) === gostGroup.splitterPort,
      );
      assert.ok(initialGostSplitterApply, "missing initial gost sni splitter apply");
      for (const route of gostGroup.routes) {
        await runtime.executeRaw('UPDATE "forward_rules" SET "isRunning" = 1 WHERE "id" = ?', [route.exitRuleId]);
      }
      const nonRepresentativeDeletion = await rulesCrud.deleteForwardRuleForActor({ id: 1, role: "admin" }, 210);
      assert.equal(nonRepresentativeDeletion.success, true);
      const exitAfterNonRepresentativeDelete = await postHeartbeat(baseUrl, "exit-token", {
        agentBootId: "boot-exit-shared",
        agentProcessId: 2002,
        forceReconcile: true,
        localState: {
          rules: [
            {
              port: gostGroup.splitterPort,
              ruleId: 202,
              forwardType: "forwardx",
              sni: "gost-api.example.com",
              targetIp: "203.0.113.30",
              targetPort: 443,
              accessScope: "u1_h2",
              protocol: "tcp",
              sniRouteVersion: 9,
              sourceAllowIps: [entryHostIp],
              ready: true,
            },
            {
              port: gostGroup.splitterPort,
              ruleId: 212,
              forwardType: "forwardx",
              sni: "gost-web.example.com",
              targetIp: "203.0.113.31",
              targetPort: 8443,
              accessScope: "u1_h2",
              protocol: "tcp",
              sniRouteVersion: 9,
              sourceAllowIps: [entryHostIp],
              ready: true,
            },
          ],
          tunnels: [],
          services: [],
        },
      });
      assert.equal(exitAfterNonRepresentativeDelete.status, 200);
      assert.equal(exitAfterNonRepresentativeDelete.payload.success, true);
      const shrinkSplitterApplies = exitAfterNonRepresentativeDelete.payload.desiredState.actions
        .filter((action) => action.op === "apply" && action.fxp?.role === "sni-splitter" && Number(action.sourcePort) === gostGroup.splitterPort);
      assert.equal(shrinkSplitterApplies.length, 1);
      assert.equal(shrinkSplitterApplies[0].ruleId, 202);
      assert.equal(shrinkSplitterApplies[0].fxp.ruleId, 202);
      assert.ok(Number(shrinkSplitterApplies[0].fxp.sniRouteVersion) > Number(initialGostSplitterApply.fxp.sniRouteVersion));
      assert.ok(Number(shrinkSplitterApplies[0].fxp.sniRouteVersion) > 9);
      assert.deepEqual(shrinkSplitterApplies[0].fxp.sniRoutes, [{
        sni: "gost-api.example.com",
        ruleId: 202,
        targetIp: "203.0.113.30",
        targetPort: 443,
        limitIn: 0,
        limitOut: 0,
        maxConnections: 0,
        maxIPs: 0,
        accessScope: "u1_h2",
      }]);

      const deletion = await rulesCrud.deleteForwardRuleForActor({ id: 1, role: "admin" }, 100);
      assert.equal(deletion.success, true);
      const exitAfterDelete = await postHeartbeat(baseUrl, "exit-token", {
        agentBootId: "boot-exit-shared",
        agentProcessId: 2002,
        forceReconcile: true,
        localState: {
          rules: [
            {
              port: 24000,
              ruleId: 102,
              forwardType: "forwardx",
              sni: "api.example.com",
              targetIp: "203.0.113.20",
              targetPort: 443,
              accessScope: "u1_h2",
              protocol: "tcp",
              sniRouteVersion: 1,
              sourceAllowIps: [entryHostIp],
              ready: true,
            },
            {
              port: 24000,
              ruleId: 112,
              forwardType: "forwardx",
              sni: "web.example.com",
              targetIp: "203.0.113.21",
              targetPort: 8443,
              accessScope: "u1_h2",
              protocol: "tcp",
              sniRouteVersion: 1,
              sourceAllowIps: [entryHostIp],
              ready: true,
            },
          ],
          tunnels: [],
          services: [],
        },
      });
      assert.equal(exitAfterDelete.status, 200);
      assert.equal(exitAfterDelete.payload.success, true);
      const refreshedSplitterApplies = exitAfterDelete.payload.desiredState.actions
        .filter((action) => action.op === "apply" && action.fxp?.role === "sni-splitter" && Number(action.sourcePort) === 24000);
      assert.equal(refreshedSplitterApplies.length, 1);
      assert.equal(refreshedSplitterApplies[0].ruleId, 112);
      assert.equal(refreshedSplitterApplies[0].fxp.ruleId, 112);
      assert.ok(Number(refreshedSplitterApplies[0].fxp.sniRouteVersion) > Number(splitterApplies[0].fxp.sniRouteVersion));
      assert.deepEqual(refreshedSplitterApplies[0].fxp.sniRoutes, [{
        sni: "web.example.com",
        ruleId: 112,
        targetIp: "203.0.113.21",
        targetPort: 8443,
        limitIn: 0,
        limitOut: 0,
        maxConnections: 0,
        maxIPs: 0,
        accessScope: "u1_h2",
      }]);

      const entryAfterDelete = await postHeartbeat(baseUrl, "entry-token", { agentBootId: "boot-entry-shared", agentProcessId: 2001 });
      const remainingEntryApply = entryAfterDelete.payload.desiredState.actions.find(
        (action) => action.op === "apply" && action.fxp?.role === "sni-splitter" && Number(action.sourcePort) === 18443,
      );
      assert.ok(remainingEntryApply, "missing entry splitter after deleting the smallest rule");
      const entryBaseConfig = ({ ruleId, sniRouteVersion, sniRoutes, ...config }) => config;
      assert.deepEqual(entryBaseConfig(remainingEntryApply.fxp), entryBaseConfig(entryApplies[0].fxp));
      assert.deepEqual(remainingEntryApply.fxp.sniRoutes, [
        { sni: "gost-api.example.com", ruleId: 201, targetIp: exitHostIp, targetPort: 24001 },
        { sni: "nginx-api.example.com", ruleId: 301, targetIp: exitHostIp, targetPort: 24002 },
        { sni: "nginx-web.example.com", ruleId: 311, targetIp: exitHostIp, targetPort: 24002 },
        { sni: "web.example.com", ruleId: 111, targetIp: exitHostIp, targetPort: 24000 },
      ]);
      const route = { templateId: 120, entryRuleId: 121, exitRuleId: 122, name: "new", sni: "new.example.com", targetIp: "203.0.113.22", targetPort: 443 };
      await insertSniRule(route);
      const entryAfterAdd = await postHeartbeat(baseUrl, "entry-token", { agentBootId: "boot-entry-shared", agentProcessId: 2001 });
      const expandedEntryApply = entryAfterAdd.payload.desiredState.actions.find(
        (action) => action.op === "apply" && action.fxp?.role === "sni-splitter" && Number(action.sourcePort) === 18443,
      );
      assert.ok(expandedEntryApply, "missing entry splitter after adding a domain");
      assert.deepEqual(entryBaseConfig(expandedEntryApply.fxp), entryBaseConfig(remainingEntryApply.fxp));
      assert.deepEqual(expandedEntryApply.fxp.sniRoutes.filter((route) => route.sni !== "new.example.com"), remainingEntryApply.fxp.sniRoutes);
      assert.deepEqual(expandedEntryApply.fxp.sniRoutes.find((route) => route.sni === "new.example.com"), {
        sni: "new.example.com", ruleId: 121, targetIp: exitHostIp, targetPort: 24000,
      });
      const caller = rulesRouter.createCaller({ req: { headers: {} }, res: { clearCookie() {} },
        user: { id: 1, username: "admin", role: "admin", accountEnabled: true },
        authSession: null, authFailureReason: null });
      await caller.update({ id: 120, targetIp: "203.0.113.99", targetPort: 9443 });
      const entryAfterTargetChange = await postHeartbeat(baseUrl, "entry-token", { agentBootId: "boot-entry-shared", agentProcessId: 2001 });
      const unchangedEntryApply = entryAfterTargetChange.payload.desiredState.actions.find(
        (action) => action.op === "apply" && action.fxp?.role === "sni-splitter" && Number(action.sourcePort) === 18443,
      );
      assert.ok(unchangedEntryApply, "missing entry splitter after changing a landing target");
      assert.deepEqual(entryBaseConfig(unchangedEntryApply.fxp), entryBaseConfig(expandedEntryApply.fxp));
      assert.deepEqual(unchangedEntryApply.fxp.sniRoutes, expandedEntryApply.fxp.sniRoutes);
      const exitAfterTargetChange = await postHeartbeat(baseUrl, "exit-token", { agentBootId: "boot-exit-shared", agentProcessId: 2002 });
      const changedExitApply = exitAfterTargetChange.payload.desiredState.actions.find(
        (action) => action.op === "apply" && action.fxp?.role === "sni-splitter" && Number(action.sourcePort) === 24000,
      );
      assert.ok(changedExitApply, "missing exit splitter after changing a landing target");
      const changedRoute = changedExitApply.fxp.sniRoutes.find((route) => route.sni === "new.example.com");
      assert.equal(changedRoute.targetIp, "203.0.113.99");
      assert.equal(changedRoute.targetPort, 9443);

      const currentEntryLocalRules = [
        { ruleId: 111, sni: "web.example.com", targetPort: 24000 },
        { ruleId: 121, sni: "new.example.com", targetPort: 24000 },
        { ruleId: 201, sni: "gost-api.example.com", targetPort: 24001 },
        { ruleId: 211, sni: "gost-web.example.com", targetPort: 24001 },
        { ruleId: 301, sni: "nginx-api.example.com", targetPort: 24002 },
        { ruleId: 311, sni: "nginx-web.example.com", targetPort: 24002 },
      ].map((localRoute) => ({
        port: 18443,
        ruleId: localRoute.ruleId,
        forwardType: "forwardx",
        sni: localRoute.sni,
        targetIp: exitHostIp,
        targetPort: localRoute.targetPort,
        protocol: "tcp",
        sniRouteVersion: 5,
        sourceAllowIps: [],
        ready: true,
      }));
      const oldVersionWithCurrentIdentity = await postHeartbeat(baseUrl, "entry-token", {
        agentVersion: "2.2.194",
        agentBootId: "boot-entry-shared",
        agentProcessId: 2001,
        localState: { rules: currentEntryLocalRules, tunnels: [], services: [] },
      });
      assert.equal(oldVersionWithCurrentIdentity.payload.runningRules.some(
        (rule) => Number(rule.sourcePort) === 18443,
      ), false);
      const currentIdentityRemovals = oldVersionWithCurrentIdentity.payload.desiredState.actions.filter(
        (action) => action.op === "remove" && Number(action.sourcePort) === 18443 && action.ruleId > 0,
      );
      assert.equal(oldVersionWithCurrentIdentity.status, 200);
      assert.equal(oldVersionWithCurrentIdentity.payload.success, true);
      assert.deepEqual(currentIdentityRemovals.map((action) => action.ruleId), [111, 121, 201, 211, 301, 311]);
      for (const action of currentIdentityRemovals) {
        assert.equal(action.forwardType, "forwardx");
        assert.equal(action.fxp?.role, "sni-splitter");
        assert.equal(action.fxp?.ruleId, action.ruleId);
      }
      assert.equal(oldVersionWithCurrentIdentity.payload.desiredState.actions.filter(
        (action) => action.op === "remove" && Number(action.sourcePort) === 18443,
      ).length, 7);

      const oldVersionWithStaleIdentity = await postHeartbeat(baseUrl, "entry-token", {
        agentVersion: "2.2.194",
        agentBootId: "boot-entry-shared",
        agentProcessId: 2001,
        localState: {
          rules: [{
            port: 18443,
            ruleId: 101,
            forwardType: "forwardx",
            sni: "api.example.com",
            targetIp: exitHostIp,
            targetPort: 24000,
            protocol: "tcp",
            sniRouteVersion: 1,
            sourceAllowIps: [],
            ready: true,
          }, ...currentEntryLocalRules],
          tunnels: [],
          services: [],
        },
      });
      const staleIdentityRemovals = oldVersionWithStaleIdentity.payload.desiredState.actions.filter(
        (action) => action.op === "remove" && Number(action.sourcePort) === 18443 && action.ruleId > 0,
      );
      assert.deepEqual(staleIdentityRemovals.map((action) => action.ruleId), [101, 111, 121, 201, 211, 301, 311]);
      assert.equal(staleIdentityRemovals[0].fxp?.role, "sni-splitter");
      assert.equal(oldVersionWithStaleIdentity.payload.desiredState.actions.filter(
        (action) => action.op === "remove" && Number(action.sourcePort) === 18443,
      ).length, 8);

      for (const localRules of [currentEntryLocalRules, [{
        port: 18443,
        ruleId: 311,
        tunnelId: 77,
        forwardType: "gost",
        targetIp: exitHostIp,
        targetPort: 24002,
        protocol: "tcp",
        ready: true,
      }]]) {
        for (let attempt = 0; attempt < 2; attempt++) {
          const repeatedRemoval = await postHeartbeat(baseUrl, "entry-token", {
            agentVersion: "2.2.194",
            agentBootId: "boot-entry-shared",
            agentProcessId: 2001,
            localState: { rules: localRules, tunnels: [], services: [] },
          });
          assert.equal(repeatedRemoval.status, 200);
          assert.equal(repeatedRemoval.payload.success, true);
          assert.equal(repeatedRemoval.payload.runningRules.some((rule) => Number(rule.sourcePort) === 18443), false);
          if (attempt === 1 && !repeatedRemoval.payload.desiredState) {
            assert.deepEqual(repeatedRemoval.payload.actions, []);
            continue;
          }
          assert.equal(repeatedRemoval.payload.desiredState.actions.some(
            (action) => action.op === "apply" && Number(action.sourcePort) === 18443,
          ), false);
          const removals = repeatedRemoval.payload.desiredState.actions.filter(
            (action) => action.op === "remove" && Number(action.sourcePort) === 18443,
          );
          const localRemovals = removals.filter((action) => action.ruleId > 0);
          if (localRules === currentEntryLocalRules) {
            assert.deepEqual(localRemovals.map((action) => action.ruleId), [111, 121, 201, 211, 301, 311]);
            assert.equal(removals.length, 7, "orphan cleanup must not duplicate the complete entry removal batch");
          } else {
            assert.deepEqual(localRemovals.map((action) => [action.ruleId, action.tunnelId, action.forwardType, action.protocol]), [
              [311, 77, "gost", "tcp"],
            ]);
            assert.equal(localRemovals[0].fxp, undefined);
            assert.equal(removals.length, 2, "old gost state must receive one local removal and one splitter removal");
          }
          const portRemovals = removals.filter((action) => action.ruleId === 0);
          assert.equal(portRemovals.length, 1);
          assert.notEqual(portRemovals[0].statusType, "rule");
          assert.equal(portRemovals[0].fxp?.role, "sni-splitter");
          assert.equal(portRemovals[0].fxp?.tunnelId, 0);
        }
      }

      const zeroIdentityBothRemoval = await postHeartbeat(baseUrl, "entry-token", {
        agentVersion: "2.2.194",
        agentBootId: "boot-entry-shared",
        agentProcessId: 2001,
        localState: {
          rules: [{ port: 18443, ruleId: 0, forwardType: "gost", targetIp: exitHostIp, targetPort: 24002, protocol: "both", ready: true }],
          tunnels: [],
          services: [],
        },
      });
      assert.equal(zeroIdentityBothRemoval.status, 200);
      assert.equal(zeroIdentityBothRemoval.payload.success, true);
      const zeroIdentityBothActions = zeroIdentityBothRemoval.payload.desiredState.actions.filter(
        (action) => action.op === "remove" && Number(action.sourcePort) === 18443,
      );
      const zeroIdentityBothLocalActions = zeroIdentityBothActions.filter((action) => action.statusType === "rule");
      assert.deepEqual(zeroIdentityBothLocalActions.map((action) => [action.ruleId, action.tunnelId, action.forwardType, action.protocol]), [
        [0, 0, "gost", "both"],
      ]);
      assert.equal(zeroIdentityBothActions.length, 2, "the original local protocol must cover the record without an orphan removal");
      const zeroIdentityBothSplitter = zeroIdentityBothActions.find((action) => action.fxp?.role === "sni-splitter");
      assert.ok(zeroIdentityBothSplitter);
      assert.equal(zeroIdentityBothSplitter.ruleId, 0);
      assert.notEqual(zeroIdentityBothSplitter.statusType, "rule");
      assert.equal(zeroIdentityBothSplitter.protocol, "tcp");
      assert.equal(zeroIdentityBothSplitter.fxp.protocol, "tcp");

      const missingProtocolRemoval = await postHeartbeat(baseUrl, "entry-token", {
        agentVersion: "2.2.194",
        agentBootId: "boot-entry-shared",
        agentProcessId: 2001,
        localState: {
          rules: [{ port: 18443, ruleId: 0, forwardType: "gost", targetIp: exitHostIp, targetPort: 24001, ready: true }],
          tunnels: [],
          services: [],
        },
      });
      assert.equal(missingProtocolRemoval.status, 200);
      assert.equal(missingProtocolRemoval.payload.success, true);
      const missingProtocolActions = missingProtocolRemoval.payload.desiredState.actions.filter(
        (action) => action.op === "remove" && Number(action.sourcePort) === 18443,
      );
      assert.deepEqual(missingProtocolActions.filter((action) => action.statusType === "rule")
        .map((action) => [action.ruleId, action.forwardType, action.protocol]), [[0, "gost", "both"]]);
      assert.equal(missingProtocolActions.length, 2, "missing local protocol must default to both without an orphan removal");
      assert.equal(missingProtocolActions.filter((action) => action.fxp?.role === "sni-splitter").length, 1);

      const kernelBothRemoval = await postHeartbeat(baseUrl, "entry-token", {
        agentVersion: "2.2.194",
        agentBootId: "boot-entry-shared",
        agentProcessId: 2001,
        localState: {
          rules: [{ port: 18443, ruleId: 0, forwardType: "nftables", targetIp: exitHostIp, targetPort: 24000, protocol: "both", ready: true }],
          tunnels: [],
          services: [],
        },
      });
      assert.equal(kernelBothRemoval.status, 200);
      assert.equal(kernelBothRemoval.payload.success, true);
      const kernelBothActions = kernelBothRemoval.payload.desiredState.actions.filter(
        (action) => action.op === "remove" && Number(action.sourcePort) === 18443,
      );
      const kernelBothLocalActions = kernelBothActions.filter((action) => action.statusType === "rule");
      assert.deepEqual(kernelBothLocalActions.map((action) => [action.ruleId, action.forwardType, action.protocol]), [
        [0, "nftables", "both"],
      ]);
      assert.equal(kernelBothActions.length, 2, "kernel forwarding cleanup must cover both protocols without an orphan removal");
      const kernelCleanupCommands = kernelBothLocalActions[0].commands.join("\n");
      assert.match(kernelCleanupCommands, / -p tcp /);
      assert.match(kernelCleanupCommands, / -p udp /);
      assert.match(kernelCleanupCommands, /-v proto='tcp'/);
      assert.match(kernelCleanupCommands, /-v proto='udp'/);
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

test("SNI chain running state waits for entry and exit snapshots", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-sni-running-state-"));
  const databasePath = path.join(directory, "sni-running-state.db");
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
    const entryHostIp = "198.51.100.10";
    const exitHostIp = "198.51.100.20";
    const sni = "status.example.com";
    const { rulesRouter } = await import(moduleUrl("server/routers/rules.ts"));
    let server;

    async function postHeartbeat(baseUrl, token, localRule, processId, agentVersion = "2.2.195") {
      const response = await fetch(baseUrl + "/api/agent/heartbeat", {
        method: "POST",
        headers: { authorization: "Bearer " + token, "content-type": "application/json" },
        body: JSON.stringify({
          agentVersion,
          agentBootId: "boot-" + token,
          agentProcessId: processId,
          agentProcessStartedAt: Math.floor(Date.now() / 1000),
          forceReconcile: true,
          ...(localRule === undefined ? {} : {
            localState: { rules: localRule ? [localRule] : [], tunnels: [], services: [] },
          }),
        }),
      });
      const payload = await response.json();
      assert.equal(response.status, 200);
      assert.equal(payload.success, true);
      return payload;
    }

    async function runningStates() {
      const rows = await runtime.queryRaw('SELECT "id", "isRunning" FROM "forward_rules" WHERE "id" IN (100, 101, 102) ORDER BY "id"');
      return rows.map((row) => [Number(row.id), Number(row.isRunning)]);
    }

    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      const now = Math.floor(Date.now() / 1000);
      await insert("users", ["id", "username", "password", "role", "canAddRules", "manualCanAddRules"], [1, "admin", "x", "admin", 1, 1]);
      await insert("hosts", ["id", "name", "ip", "ipv4", "agentToken", "userId", "isOnline", "lastHeartbeat", "agentVersion", "portRangeStart", "portRangeEnd"], [1, "entry", entryHostIp, entryHostIp, "entry-token", 1, 1, now, "2.2.195", 18000, 19000]);
      await insert("hosts", ["id", "name", "ip", "ipv4", "agentToken", "userId", "isOnline", "lastHeartbeat", "agentVersion", "portRangeStart", "portRangeEnd"], [2, "exit", exitHostIp, exitHostIp, "exit-token", 1, 1, now, "2.2.195", 24000, 25000]);
      await insert("forward_groups", ["id", "name", "groupType", "groupMode", "forwardType", "domain", "targetIp", "targetPort", "userId", "isEnabled"], [10, "status-chain", "host", "chain", "nftables", "", "0.0.0.0", 1, 1, 1]);
      await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [1001, 10, "host", 1, 10, 1]);
      await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [1002, 10, "host", 2, 20, 1]);
      await insert("forward_rules", [
        "id", "hostId", "name", "forwardType", "protocol", "forwardGroupId", "isForwardGroupTemplate",
        "sourcePort", "sni", "sniSplitterPort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning"
      ], [100, 1, "status-template", "nftables", "tcp", 10, 1, 18443, sni, 24000, "203.0.113.20", 443, 1, 1, 0]);
      await insert("forward_rules", [
        "id", "hostId", "name", "forwardType", "protocol", "forwardGroupId", "forwardGroupRuleId", "forwardGroupMemberId", "isForwardGroupTemplate",
        "sourcePort", "sni", "sniSplitterPort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning"
      ], [101, 1, "status-entry", "nftables", "tcp", 10, 100, 1001, 0, 18443, sni, 24000, exitHostIp, 24000, 1, 1, 0]);
      await insert("forward_rules", [
        "id", "hostId", "name", "forwardType", "protocol", "forwardGroupId", "forwardGroupRuleId", "forwardGroupMemberId", "isForwardGroupTemplate",
        "sourcePort", "sni", "sniSplitterPort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning"
      ], [102, 2, "status-exit", "nftables", "tcp", 10, 100, 1002, 0, 24000, sni, 24000, "203.0.113.20", 443, 1, 1, 0]);

      await insert("forward_rules", ["id", "hostId", "name", "forwardType", "protocol", "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning"],
        [103, 1, "ordinary-forward", "nftables", "tcp", 18500, "203.0.113.30", 8443, 1, 1, 0]);
      await insert("forward_groups", ["id", "name", "groupType", "groupMode", "forwardType", "domain", "targetIp", "targetPort", "userId", "isEnabled"],
        [20, "single-host-sni", "host", "port", "gost", "", "0.0.0.0", 1, 1, 1]);
      await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [2001, 20, "host", 1, 10, 1]);
      await insert("forward_rules", ["id", "hostId", "name", "forwardType", "protocol", "forwardGroupId", "isForwardGroupTemplate", "sourcePort", "sni", "sniSplitterPort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning"],
        [200, 1, "single-host-template", "gost", "tcp", 20, 1, 18501, "port.example.com", 18501, "203.0.113.40", 9443, 1, 1, 0]);
      await insert("forward_rules", ["id", "hostId", "name", "forwardType", "protocol", "forwardGroupId", "forwardGroupRuleId", "forwardGroupMemberId", "isForwardGroupTemplate", "sourcePort", "sni", "sniSplitterPort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning"],
        [201, 1, "single-host-rule", "gost", "tcp", 20, 200, 2001, 0, 18501, "port.example.com", 18501, "203.0.113.40", 9443, 1, 1, 0]);

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

      await runtime.executeRaw('UPDATE "hosts" SET "agentVersion" = NULL WHERE "id" = 1');
      const unreportedEntryHeartbeat = await postHeartbeat(baseUrl, "entry-token", null, 2001, "");
      assert.equal(unreportedEntryHeartbeat.runningRules.some((rule) => Number(rule.sourcePort) === 18443), false);
      assert.equal(unreportedEntryHeartbeat.actions.some((action) => action.op === "apply" && Number(action.sourcePort) === 18443), false);
      assert.ok(unreportedEntryHeartbeat.actions.some((action) => action.op === "remove" && action.fxp?.role === "sni-splitter" && Number(action.sourcePort) === 18443));

      await postHeartbeat(baseUrl, "entry-token", {
        port: 18443,
        ruleId: 101,
        forwardType: "forwardx",
        sni,
        targetIp: exitHostIp,
        targetPort: 24000,
        protocol: "tcp",
        sniRouteVersion: 1,
        sourceAllowIps: [],
        ready: true,
      }, 2001);
      assert.deepEqual(await runningStates(), [[100, 0], [101, 0], [102, 0]]);

      await postHeartbeat(baseUrl, "exit-token", {
        port: 24000,
        ruleId: 102,
        forwardType: "forwardx",
        sni,
        targetIp: "203.0.113.20",
        targetPort: 443,
        protocol: "tcp",
        sniRouteVersion: 1,
        sourceAllowIps: [entryHostIp],
        ready: true,
      }, 2002);
      assert.deepEqual(await runningStates(), [[100, 1], [101, 1], [102, 1]]);

      await postHeartbeat(baseUrl, "entry-token", null, 2001);
      assert.deepEqual(await runningStates(), [[100, 0], [101, 0], [102, 0]]);

      await postHeartbeat(baseUrl, "entry-token", {
        port: 18443,
        ruleId: 101,
        forwardType: "forwardx",
        sni,
        targetIp: exitHostIp,
        targetPort: 24000,
        protocol: "tcp",
        sniRouteVersion: 2,
        sourceAllowIps: [],
        ready: true,
      }, 2001);
      assert.deepEqual(await runningStates(), [[100, 1], [101, 1], [102, 1]]);

      await postHeartbeat(baseUrl, "entry-token", {
        port: 18443, ruleId: 101, forwardType: "forwardx", sni,
        targetIp: exitHostIp, targetPort: 24000, protocol: "tcp",
        sniRouteVersion: 2, sniLastConfigError: "invalid route table", sourceAllowIps: [], ready: true,
      }, 2001);
      const caller = rulesRouter.createCaller({ req: { headers: {} }, res: { clearCookie() {} },
        user: { id: 1, username: "admin", role: "admin", accountEnabled: true },
        authSession: null, authFailureReason: null });
      const ruleAfterRejectedUpdate = await caller.getById({ id: 100 });
      assert.equal(ruleAfterRejectedUpdate.sniRuntime.entries[0].currentVersion, 2);
      assert.equal(ruleAfterRejectedUpdate.sniRuntime.entries[0].lastConfigError, "invalid route table");
      assert.equal(ruleAfterRejectedUpdate.sniRuntime.entries[0].applied, true);
      assert.equal(ruleAfterRejectedUpdate.isRunning, true);

      const invalidEntryHeartbeat = await postHeartbeat(baseUrl, "entry-token", undefined, 2001, "2.2.999garbage");
      assert.deepEqual(await runningStates(), [[100, 0], [101, 0], [102, 0]]);
      assert.equal(invalidEntryHeartbeat.runningRules.some((rule) => Number(rule.sourcePort) === 18443), false);
      assert.equal(invalidEntryHeartbeat.desiredState.actions.some((action) => action.op === "apply" && Number(action.sourcePort) === 18443), false);
      const invalidEntryRemoval = invalidEntryHeartbeat.desiredState.actions.find((action) => action.op === "remove" && Number(action.sourcePort) === 18443);
      assert.ok(invalidEntryRemoval);
      assert.equal(invalidEntryRemoval.ruleId, 0);
      assert.notEqual(invalidEntryRemoval.statusType, "rule");
      assert.equal(invalidEntryRemoval.fxp.role, "sni-splitter");
      assert.equal(invalidEntryRemoval.fxp.ruleId, 0);
      assert.equal(invalidEntryRemoval.fxp.listenPort, 18443);
      const splitterOnlyCleanup = invalidEntryRemoval.commands.join("\n");
      assert.match(splitterOnlyCleanup, /fwx-sni-splitter-18443:/);
      assert.match(splitterOnlyCleanup, /fxp-sni-splitter-0/);
      assert.doesNotMatch(splitterOnlyCleanup, /traffic_|port_18443|tunnel_18443|forwardx-(?:gost|realm|socat)|fxp-\*-18443|\budp\b/);
      assert.equal(invalidEntryHeartbeat.desiredState.actions.filter(
        (action) => action.op === "remove" && Number(action.sourcePort) === 18443,
      ).length, 1);
      assert.ok(invalidEntryHeartbeat.runningRules.some((rule) => Number(rule.sourcePort) === 18500));
      assert.ok(invalidEntryHeartbeat.runningRules.some((rule) => Number(rule.sourcePort) === 18501));
      assert.ok(invalidEntryHeartbeat.desiredState.actions.some((action) => action.op === "apply" && action.fxp?.role === "sni-splitter" && Number(action.sourcePort) === 18501));
      assert.equal(invalidEntryHeartbeat.desiredState.actions.some((action) => action.op === "remove" && [18500, 18501].includes(Number(action.sourcePort))), false);
      await postHeartbeat(baseUrl, "entry-token", undefined, 2001);
      assert.deepEqual(await runningStates(), [[100, 1], [101, 1], [102, 1]]);

      const oldEntryHeartbeat = await postHeartbeat(baseUrl, "entry-token", undefined, 2001, "2.2.194");
      assert.deepEqual(await runningStates(), [[100, 0], [101, 0], [102, 0]]);
      assert.equal(oldEntryHeartbeat.runningRules.some((rule) => Number(rule.sourcePort) === 18443), false);
      assert.equal(oldEntryHeartbeat.desiredState.actions.some((action) => action.op === "apply" && Number(action.sourcePort) === 18443), false);
      assert.ok(oldEntryHeartbeat.desiredState.actions.some((action) => action.op === "remove" && action.fxp?.role === "sni-splitter" && Number(action.sourcePort) === 18443));
      const enabledAfterOldEntryHeartbeat = await runtime.queryRaw(
        'SELECT "id", "isEnabled" FROM "forward_rules" WHERE "id" IN (100, 101, 102) ORDER BY "id"',
      );
      assert.deepEqual(enabledAfterOldEntryHeartbeat.map((row) => [Number(row.id), Number(row.isEnabled)]), [
        [100, 1], [101, 1], [102, 1],
      ]);

      const stoppedOldEntryHeartbeat = await postHeartbeat(baseUrl, "entry-token", null, 2001, "2.2.194");
      assert.equal(stoppedOldEntryHeartbeat.runningRules.some((rule) => Number(rule.sourcePort) === 18443), false);
      assert.equal(stoppedOldEntryHeartbeat.desiredState.actions.some((action) => action.op === "apply" && Number(action.sourcePort) === 18443), false);
      const emptyStateRemovals = stoppedOldEntryHeartbeat.desiredState.actions.filter(
        (action) => action.op === "remove" && Number(action.sourcePort) === 18443,
      );
      assert.equal(emptyStateRemovals.length, 1);
      assert.equal(emptyStateRemovals[0].ruleId, 0);
      assert.notEqual(emptyStateRemovals[0].statusType, "rule");
      const restoredEntryHeartbeat = await postHeartbeat(baseUrl, "entry-token", null, 2001);
      assert.ok(restoredEntryHeartbeat.runningRules.some((rule) => Number(rule.sourcePort) === 18443));
      assert.ok(restoredEntryHeartbeat.desiredState.actions.some((action) => action.op === "apply" && action.fxp?.role === "sni-splitter" && Number(action.sourcePort) === 18443));

      await postHeartbeat(baseUrl, "entry-token", null, 2001);
      assert.deepEqual(await runningStates(), [[100, 0], [101, 0], [102, 0]]);
      await postHeartbeat(baseUrl, "exit-token", {
        port: 24000,
        ruleId: 102,
        forwardType: "forwardx",
        sni,
        targetIp: "203.0.113.20",
        targetPort: 443,
        protocol: "tcp",
        sniRouteVersion: 2,
        sourceAllowIps: [entryHostIp],
        ready: true,
      }, 2002);
      assert.deepEqual(await runningStates(), [[100, 0], [101, 0], [102, 0]]);
      await postHeartbeat(baseUrl, "entry-token", {
        port: 18443,
        ruleId: 101,
        forwardType: "forwardx",
        sni,
        targetIp: exitHostIp,
        targetPort: 24000,
        protocol: "tcp",
        sniRouteVersion: 3,
        sourceAllowIps: [],
        ready: true,
      }, 2001);
      assert.deepEqual(await runningStates(), [[100, 1], [101, 1], [102, 1]]);
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

test("SNI chain relay status does not overwrite splitter observability when ports collide", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-sni-status-port-collision-"));
  const databasePath = path.join(directory, "sni-status-port-collision.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import http from "node:http";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    import express from "express";

    const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(moduleUrl("server/dbRuntime.ts"));
    const schema = await import(moduleUrl("server/dbSchema.ts"));
    const status = await import(moduleUrl("server/agentStatusRoutes.ts"));
    const observability = await import(moduleUrl("server/sniRuntimeObservability.ts"));
    const q = (name) => '"' + name + '"';
    const insert = async (table, columns, values) => {
      await runtime.executeRaw(
        "INSERT INTO " + q(table) + " (" + columns.map(q).join(", ") + ") VALUES (" + values.map(() => "?").join(", ") + ")",
        values,
      );
    };
    let server;

    async function postRuleStatus(baseUrl, token, body) {
      const response = await fetch(baseUrl + "/api/agent/rule-status", {
        method: "POST",
        headers: { authorization: "Bearer " + token, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json();
      assert.equal(response.status, 200);
      assert.equal(payload.success, true);
    }

    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      const now = Math.floor(Date.now() / 1000);
      await insert("users", ["id", "username", "password", "role", "canAddRules", "manualCanAddRules"], [1, "admin", "x", "admin", 1, 1]);
      await insert("hosts", ["id", "name", "ip", "ipv4", "agentToken", "userId", "isOnline", "lastHeartbeat", "agentVersion"], [1, "entry", "198.51.100.10", "198.51.100.10", "entry-token", 1, 1, now, "2.2.195"]);
      await insert("hosts", ["id", "name", "ip", "ipv4", "agentToken", "userId", "isOnline", "lastHeartbeat", "agentVersion"], [2, "relay", "198.51.100.15", "198.51.100.15", "relay-token", 1, 1, now, "2.2.195"]);
      await insert("hosts", ["id", "name", "ip", "ipv4", "agentToken", "userId", "isOnline", "lastHeartbeat", "agentVersion"], [3, "exit", "198.51.100.20", "198.51.100.20", "exit-token", 1, 1, now, "2.2.195"]);
      await insert("forward_groups", ["id", "name", "groupType", "groupMode", "forwardType", "domain", "targetIp", "targetPort", "userId", "isEnabled"], [10, "three-hop-chain", "host", "chain", "gost", "", "0.0.0.0", 1, 1, 1]);
      await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [1001, 10, "host", 1, 10, 1]);
      await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [1002, 10, "host", 2, 20, 1]);
      await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [1003, 10, "host", 3, 30, 1]);
      await insert("forward_rules", [
        "id", "hostId", "name", "forwardType", "protocol", "forwardGroupId", "isForwardGroupTemplate",
        "sourcePort", "sni", "sniSplitterPort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning"
      ], [100, 1, "three-hop-template", "gost", "tcp", 10, 1, 18443, "status.example.com", 24000, "203.0.113.20", 443, 1, 1, 0]);
      await insert("forward_rules", [
        "id", "hostId", "name", "forwardType", "protocol", "forwardGroupId", "forwardGroupRuleId", "forwardGroupMemberId", "isForwardGroupTemplate",
        "sourcePort", "sni", "sniSplitterPort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning"
      ], [101, 1, "three-hop-entry", "gost", "tcp", 10, 100, 1001, 0, 18443, "status.example.com", 24000, "198.51.100.15", 24000, 1, 1, 0]);
      await insert("forward_rules", [
        "id", "hostId", "name", "forwardType", "protocol", "forwardGroupId", "forwardGroupRuleId", "forwardGroupMemberId", "isForwardGroupTemplate",
        "sourcePort", "sni", "sniSplitterPort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning"
      ], [102, 2, "three-hop-relay", "gost", "tcp", 10, 100, 1002, 0, 24000, "status.example.com", 24000, "198.51.100.20", 24000, 1, 1, 0]);
      await insert("forward_rules", [
        "id", "hostId", "name", "forwardType", "protocol", "forwardGroupId", "forwardGroupRuleId", "forwardGroupMemberId", "isForwardGroupTemplate",
        "sourcePort", "sni", "sniSplitterPort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning"
      ], [103, 3, "three-hop-exit", "gost", "tcp", 10, 100, 1003, 0, 24000, "status.example.com", 24000, "203.0.113.20", 443, 1, 1, 0]);

      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        const authorization = String(req.headers.authorization || "");
        req.agentToken = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
        next();
      });
      status.registerAgentStatusRoutes(app);
      server = http.createServer(app);
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      assert.ok(address && typeof address === "object");
      const baseUrl = "http://127.0.0.1:" + address.port;

      await postRuleStatus(baseUrl, "entry-token", {
        ruleId: 101,
        isRunning: false,
        sourcePort: 18443,
        forwardType: "forwardx",
        message: "entry splitter failed",
      });
      assert.equal(observability.getSniRuntimeGroupStatus(1, 18443)?.lastConfigError, "entry splitter failed");

      await postRuleStatus(baseUrl, "relay-token", {
        ruleId: 102,
        isRunning: false,
        sourcePort: 24000,
        forwardType: "gost",
        message: "relay failed",
      });
      assert.equal(observability.getSniRuntimeGroupStatus(2, 24000), null);
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

test("a tunnel SNI rule update reaches the very next heartbeat", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-sni-update-order-"));
  const databasePath = path.join(directory, "sni-update-order.db");
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
    const { rulesRouter } = await import(moduleUrl("server/routers/rules.ts"));
    const q = (name) => '"' + name + '"';
    const insert = async (table, columns, values) => {
      await runtime.executeRaw(
        "INSERT INTO " + q(table) + " (" + columns.map(q).join(", ") + ") VALUES (" + values.map(() => "?").join(", ") + ")",
        values,
      );
    };
    const entryHostIp = "198.51.100.10";
    const exitHostIp = "198.51.100.20";
    const sourcePort = 18443;
    const splitterPort = 24000;
    const tunnelExitPort = 24005;
    const callerContext = (user) => ({
      req: { headers: {} },
      res: { clearCookie() {} },
      user,
      authSession: null,
      authFailureReason: null,
    });
    let server;

    async function postExitHeartbeat(baseUrl) {
      const response = await fetch(baseUrl + "/api/agent/heartbeat", {
        method: "POST",
        headers: { authorization: "Bearer exit-token", "content-type": "application/json" },
        body: JSON.stringify({
          agentVersion: "2.2.195",
          agentBootId: "boot-exit",
          agentProcessId: 2002,
          agentProcessStartedAt: Math.floor(Date.now() / 1000),
          forceReconcile: true,
        }),
      });
      const payload = await response.json();
      assert.equal(response.status, 200);
      assert.equal(payload.success, true);
      return payload;
    }

    function splitterRoutes(actions) {
      const apply = actions.find(
        (action) => action.op === "apply" && action.fxp?.role === "sni-splitter" && Number(action.sourcePort) === splitterPort,
      );
      assert.ok(apply, "missing sni splitter apply action");
      return apply.fxp.sniRoutes;
    }

    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      const now = Math.floor(Date.now() / 1000);
      await insert("users", ["id", "username", "password", "role", "canAddRules", "manualCanAddRules"], [1, "admin", "x", "admin", 1, 1]);
      await insert("hosts", ["id", "name", "ip", "ipv4", "agentToken", "userId", "isOnline", "lastHeartbeat", "agentVersion", "portRangeStart", "portRangeEnd"], [1, "entry", entryHostIp, entryHostIp, "entry-token", 1, 1, now, "2.2.195", 18000, 19000]);
      await insert("hosts", ["id", "name", "ip", "ipv4", "agentToken", "userId", "isOnline", "lastHeartbeat", "agentVersion", "portRangeStart", "portRangeEnd"], [2, "exit", exitHostIp, exitHostIp, "exit-token", 1, 1, now, "2.2.195", 24000, 24010]);
      await insert("tunnels", ["id", "name", "entryHostId", "exitHostId", "mode", "listenPort", "userId", "isEnabled"], [7, "kr-hk", 1, 2, "tls", 21000, 1, 1]);
      for (const route of [
        { id: 101, name: "api", sni: "api.example.com", targetIp: "203.0.113.20", targetPort: 443 },
        { id: 102, name: "web", sni: "web.example.com", targetIp: "203.0.113.21", targetPort: 8443 },
      ]) {
        await insert("forward_rules", [
          "id", "hostId", "name", "forwardType", "protocol", "tunnelId", "sourcePort", "sni", "sniSplitterPort",
          "tunnelExitPort", "targetIp", "targetPort", "rateLimitMbps", "maxConnections", "userId", "isEnabled", "isRunning",
        ], [route.id, 1, route.name, "gost", "tcp", 7, sourcePort, route.sni, splitterPort, tunnelExitPort, route.targetIp, route.targetPort, 0, 0, 1, 1, 0]);
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
      const baseUrl = "http://127.0.0.1:" + server.address().port;

      const initial = await postExitHeartbeat(baseUrl);
      const before = splitterRoutes(initial.desiredState.actions);
      assert.ok(initial.runningRules.some((rule) => Number(rule.sourcePort) === tunnelExitPort && rule.forwardType === "gost-tunnel-exit"));
      assert.ok(!initial.runningRules.some((rule) => Number(rule.sourcePort) === 21000 && rule.forwardType === "gost-tunnel-exit"));
      const apiBefore = before.find((route) => route.sni === "api.example.com");
      assert.ok(apiBefore, "missing api route in the initial sni route table");
      assert.equal(apiBefore.targetIp, "203.0.113.20");
      assert.equal(apiBefore.limitIn, 0);
      assert.equal(apiBefore.maxConnections, 0);

      const caller = rulesRouter.createCaller(callerContext({ id: 1, username: "admin", role: "admin", accountEnabled: true }));
      await caller.update({
        id: 101,
        targetIp: "203.0.113.99",
        targetPort: 8443,
        rateLimitMbps: 50,
        maxConnections: 7,
      });

      // No sleep: the heartbeat that arrives right after the write must already
      // carry the new landing server and the new limits.
      const after = splitterRoutes((await postExitHeartbeat(baseUrl)).desiredState.actions);
      const apiAfter = after.find((route) => route.sni === "api.example.com");
      assert.ok(apiAfter, "missing api route after the update");
      assert.equal(apiAfter.targetIp, "203.0.113.99");
      assert.equal(apiAfter.targetPort, 8443);
      assert.ok(apiAfter.limitIn > 0, "rate limit did not reach the splitter: " + JSON.stringify(apiAfter));
      assert.equal(apiAfter.maxConnections, 7);

      const webAfter = after.find((route) => route.sni === "web.example.com");
      assert.ok(webAfter, "updating one rule dropped the other rule from the sni route table");
      assert.equal(webAfter.targetIp, "203.0.113.21");
      assert.equal(webAfter.limitIn, 0);
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

test("deleting the first rule of a tunnel SNI group leaves the entry runtime untouched", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-sni-representative-"));
  const databasePath = path.join(directory, "sni-representative.db");
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
    const rulesCrud = await import(moduleUrl("server/routers/rules.crud.ts"));
    const q = (name) => '"' + name + '"';
    const insert = async (table, columns, values) => {
      await runtime.executeRaw(
        "INSERT INTO " + q(table) + " (" + columns.map(q).join(", ") + ") VALUES (" + values.map(() => "?").join(", ") + ")",
        values,
      );
    };
    const entryHostIp = "198.51.100.10";
    const exitHostIp = "198.51.100.20";
    const sourcePort = 18443;
    const splitterPort = 24000;
    const tunnelListenPort = 24001;
    let server;

    async function heartbeatActions(baseUrl, token, bootId, processId) {
      const response = await fetch(baseUrl + "/api/agent/heartbeat", {
        method: "POST",
        headers: { authorization: "Bearer " + token, "content-type": "application/json" },
        body: JSON.stringify({
          agentVersion: "2.2.195",
          agentBootId: bootId,
          agentProcessId: processId,
          agentProcessStartedAt: Math.floor(Date.now() / 1000),
          forceReconcile: true,
        }),
      });
      const payload = await response.json();
      assert.equal(response.status, 200);
      assert.equal(payload.success, true);
      return payload.desiredState.actions || [];
    }

    function managedConfig(actions, suffix) {
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
      await insert("hosts", ["id", "name", "ip", "ipv4", "agentToken", "userId", "isOnline", "lastHeartbeat", "agentVersion", "portRangeStart", "portRangeEnd"], [1, "entry", entryHostIp, entryHostIp, "entry-token", 1, 1, now, "2.2.195", 18000, 19000]);
      await insert("hosts", ["id", "name", "ip", "ipv4", "agentToken", "userId", "isOnline", "lastHeartbeat", "agentVersion", "portRangeStart", "portRangeEnd"], [2, "exit", exitHostIp, exitHostIp, "exit-token", 1, 1, now, "2.2.195", 24000, 24010]);
      await insert("tunnels", ["id", "name", "entryHostId", "exitHostId", "mode", "listenPort", "userId", "isEnabled"], [7, "kr-hk", 1, 2, "tls", tunnelListenPort, 1, 1]);
      for (const route of [
        { id: 101, name: "api", sni: "api.example.com", targetIp: "203.0.113.20", targetPort: 443 },
        { id: 102, name: "web", sni: "web.example.com", targetIp: "203.0.113.21", targetPort: 8443 },
      ]) {
        await insert("forward_rules", [
          "id", "hostId", "name", "forwardType", "protocol", "tunnelId", "sourcePort", "sni", "sniSplitterPort",
          "tunnelExitPort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning",
        ], [route.id, 1, route.name, "gost", "tcp", 7, sourcePort, route.sni, splitterPort, tunnelListenPort, route.targetIp, route.targetPort, 1, 1, 0]);
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
      const baseUrl = "http://127.0.0.1:" + server.address().port;

      const entryBefore = managedConfig(await heartbeatActions(baseUrl, "entry-token", "boot-entry", 2001), "gost.json");
      assert.ok(entryBefore.includes('":' + sourcePort + '"'), "entry runtime is not listening on the shared entry port: " + entryBefore);
      assert.doesNotMatch(entryBefore, /203\.0\.113\.2[01]/, "landing servers must not reach the entry host");

      await rulesCrud.deleteForwardRuleForActor({ id: 1, role: "admin" }, 101);

      // The whole point of a 分流组: removing one member changes the 分流表 on the
      // exit, and nothing at all on the entry. Any difference here means the
      // shared runtime gets restarted and every other rule drops its connections.
      const entryAfter = managedConfig(await heartbeatActions(baseUrl, "entry-token", "boot-entry", 2001), "gost.json");
      assert.equal(entryAfter, entryBefore, "deleting one rule rewrote the shared entry runtime config");

      const exitActions = await heartbeatActions(baseUrl, "exit-token", "boot-exit", 2002);
      const splitterApply = exitActions.find(
        (action) => action.op === "apply" && action.fxp?.role === "sni-splitter" && Number(action.sourcePort) === splitterPort,
      );
      assert.ok(splitterApply, "missing sni splitter apply action after the delete");
      assert.deepEqual(splitterApply.fxp.sniRoutes.map((route) => route.sni), ["web.example.com"]);
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
