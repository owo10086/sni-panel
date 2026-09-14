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
          assert.doesNotMatch((entryApply.commands || []).join("\n"), /\bcounter\b/);
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
          rules: runningSplitters.map((rule) => {
            const scenario = scenarios.find((item) => Number(item.splitterPort) === Number(rule.sourcePort));
            assert.ok(scenario);
            return {
              port: scenario.splitterPort,
              ruleId: scenario.exitRuleId,
              forwardType: "forwardx",
              sni: scenario.sni,
              targetIp: finalTargetIp,
              targetPort: 443,
              accessScope: "u1_h2",
              protocol: "tcp",
              sniRouteVersion: 1,
              sourceAllowIps: [entryHostIp],
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

test("SNI forward-chain desired state shares one entry listener for multiple domains", () => {
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
    const routes = [
      { templateId: 100, entryRuleId: 101, exitRuleId: 102, name: "api", sni: "api.example.com", targetIp: "203.0.113.20", targetPort: 443 },
      { templateId: 110, entryRuleId: 111, exitRuleId: 112, name: "web", sni: "web.example.com", targetIp: "203.0.113.21", targetPort: 8443 },
    ];
    const runtimeGroups = [
      {
        groupId: 20,
        forwardType: "gost",
        sourcePort: 18444,
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
        sourcePort: 18445,
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
      assert.equal(entryApplies[0].targetIp, exitHostIp);
      assert.equal(entryApplies[0].targetPort, 24000);
      assert.equal(entryApplies[0].protocol, "tcp");
      assert.doesNotMatch(JSON.stringify(entryActions), /203\.0\.113\./);
      assert.doesNotMatch(decodedManagedConfigText(entryActions), /203\.0\.113\./);
      assert.doesNotMatch((entryApplies[0].commands || []).join("\n"), /fwx-stat-|forwardx_traffic/);
      assert.doesNotMatch((entryApplies[0].commands || []).join("\n"), /\bcounter\b/);

      const gostConfigText = findManagedConfig(entryActions, "/runtime/gost.json");
      assert.ok(gostConfigText, "missing gost runtime config");
      const gostConfig = JSON.parse(gostConfigText);
      const gostEntryServices = gostConfig.services.filter((service) => service.addr === ":18444");
      assert.equal(gostEntryServices.length, 1);
      assert.equal(gostEntryServices[0].name, "fwx-201-tcp");
      assert.deepEqual(gostEntryServices[0].forwarder.nodes.map((node) => node.addr), [exitHostIp + ":24001"]);

      const nginxConfigText = findManagedConfig(entryActions, "/nginx/nginx.conf");
      assert.ok(nginxConfigText, "missing nginx runtime config");
      assert.equal((nginxConfigText.match(/listen \[::\]:18445\b/g) || []).length, 1);
      assert.equal((nginxConfigText.match(/server 198\.51\.100\.20:24002\b/g) || []).length, 1);

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
