import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function runIsolatedScript(directory: string, databasePath: string, name: string, script: string) {
  const scriptPath = path.join(directory, `${name}.mjs`);
  fs.writeFileSync(scriptPath, script, "utf8");
  const result = spawnSync(process.execPath, ["--import", "tsx", scriptPath], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_TYPE: "sqlite",
      FORWARDX_TEST_DB: databasePath,
      FORWARDX_LOG_DIR: path.join(directory, "logs"),
    },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.error?.stack || result.stderr || result.stdout);
}

test("ordinary host failover keeps DDNS when business targets fail or have no reports", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-host-entry-health-"));
  const script = String.raw`
    import assert from "node:assert/strict";
    import http from "node:http";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    const mod = file => import(pathToFileURL(path.join(process.cwd(), file)).href);
    const runtime = await mod("server/dbRuntime.ts");
    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
    await (await mod("server/dbSchema.ts")).ensureDatabaseSchema();
    const groups = await mod("server/repositories/forwardGroupRepository.ts");
    const settings = await mod("server/repositories/settingsRepository.ts");
    const requests = [];
    const provider = http.createServer((request, response) => {
      let body = "";
      request.on("data", chunk => { body += chunk; });
      request.on("end", () => { requests.push(JSON.parse(body)); response.writeHead(204); response.end(); });
    });
    await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
    await settings.setSettings({ ddnsEnabled: "true", ddnsProvider: "webhook", ddnsWebhookUrl: "http://127.0.0.1:" + provider.address().port + "/ddns", ddnsWebhookMethod: "POST" });
    const { mock } = await import("node:test");
    mock.timers.enable({ apis: ["Date"], now: Math.floor(Date.now() / 1000) * 1000 });
    const insert = (table, data) => runtime.executeRaw('INSERT INTO "' + table + '" (' + Object.keys(data).map(k => '"' + k + '"').join(',') + ') VALUES (' + Object.keys(data).map(() => '?').join(',') + ')', Object.values(data));
    const seconds = () => Math.floor(Date.now() / 1000);
    const state = () => groups.getForwardGroupById(10);
    const evaluate = () => groups.runForwardGroupFailover(10, { skipRuleSync: true });
    const advance = async value => {
      mock.timers.tick(value * 1000);
      await runtime.executeRaw('UPDATE hosts SET lastHeartbeat = ?', [seconds()]);
    };
    const china = async (memberId, status = "healthy") => groups.updateForwardGroupMemberChinaHealth({
      groupId: 10, memberId, hostId: memberId - 100, latencyMs: status === "healthy" ? 5 : null,
      isTimeout: status !== "healthy", healthStatus: status,
    });
    try {
      await insert("users", { id: 1, username: "admin", password: "x", role: "admin", canAddRules: 1, manualCanAddRules: 1 });
      for (const id of [1, 2]) {
        await insert("hosts", { id, name: "entry-" + id, ip: "198.51.100." + id, ipv4: "198.51.100." + id, userId: 1, isOnline: 1, lastHeartbeat: seconds() });
      }
      await insert("forward_groups", { id: 10, name: "ordinary entries", groupType: "host", groupMode: "failover", domain: "ordinary.example.test", targetIp: "0.0.0.0", userId: 1, isEnabled: 1, failoverSeconds: 10, recoverSeconds: 20, autoFailback: 1, chinaHealthCheckEnabled: 1 });
      for (const id of [1, 2]) await insert("forward_group_members", { id: 100 + id, groupId: 10, memberType: "host", hostId: id, priority: id, isEnabled: 1 });
      for (const id of [1000, 2000]) {
        const rule = { name: "business-" + id, hostId: 1, sourcePort: id + 30000, targetIp: "203.0.113.10", targetPort: 443, forwardType: "nftables", protocol: "tcp", userId: 1, forwardGroupId: 10, isEnabled: 1 };
        await insert("forward_rules", { ...rule, id, isForwardGroupTemplate: 1 });
        for (const hostId of [1, 2]) await insert("forward_rules", { ...rule, id: id + hostId, hostId, forwardGroupRuleId: id, forwardGroupMemberId: 100 + hostId, isRunning: 1 });
      }
      for (const hostId of [1, 2]) {
        await insert("tcping_stats", { ruleId: 1000 + hostId, hostId, isTimeout: 1, healthStatus: "unhealthy", healthPending: 0, recordedAt: seconds() });
        await china(100 + hostId);
      }
      await evaluate();
      assert.equal((await state()).activeMemberId, 101, "failed and missing business target results must not block an available entry");
      assert.equal((await state()).lastDdnsValue, "198.51.100.1");
      assert.deepEqual(requests.at(-1).values, ["198.51.100.1"], "the provider receives the healthy entry despite business target failures");
      const metrics = await mod("server/repositories/metricsRepository.ts");
      assert.ok((await metrics.getTcpingSeriesByRule(1001, { since: new Date(0) })).some(point => point.isTimeout), "the business failure remains visible in rule history");
      await advance(330);
      for (const id of [101, 102]) await china(id);
      await evaluate();
      assert.equal((await state()).lastStatus, "healthy", "expired business target reports do not expire entry health");
      await runtime.executeRaw('UPDATE forward_groups SET chinaHealthCheckEnabled = 0 WHERE id=10');
      await evaluate();
      assert.equal((await state()).activeMemberId, 101, "disabling the entry probe does not restore target gating");
      await runtime.executeRaw('UPDATE forward_rules SET isRunning=0 WHERE id=2001');
      await evaluate();
      assert.equal((await state()).activeMemberId, 101, "a local rule failure observes the configured failure delay");
      await advance(11);
      await evaluate();
      assert.equal((await state()).activeMemberId, 102, "an entry with an unready local rule cannot serve the group");
      await runtime.executeRaw('UPDATE forward_rules SET isRunning=1 WHERE id=2001');
      await evaluate();
      await advance(10);
      await evaluate();
      assert.equal((await state()).activeMemberId, 102, "entry recovery cannot borrow business probe health");
      await advance(11);
      await evaluate();
      assert.equal((await state()).activeMemberId, 101, "the configured recovery window permits priority failback");
      await runtime.executeRaw('UPDATE forward_groups SET chinaHealthCheckEnabled = 1 WHERE id=10');
      await china(101, "unhealthy");
      await china(102);
      await evaluate();
      assert.equal((await state()).activeMemberId, 102, "an enabled entry probe still controls failover");
      await runtime.executeRaw('UPDATE hosts SET lastHeartbeat=? WHERE id=2', [seconds() - 170]);
      await evaluate();
      assert.notEqual((await state()).lastStatus, "healthy", "online and entry-probe requirements cannot be bypassed");
    } finally { mock.timers.reset(); await runtime.closeDatabase(); await new Promise(resolve => provider.close(resolve)); }
  `;
  try { runIsolatedScript(directory, path.join(directory, "test.db"), "ordinary-entry", script); }
  finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("ordinary host failover cannot skip recovery by restarting the panel", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-host-entry-restart-"));
  const database = path.join(directory, "test.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import fs from "node:fs";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    import { mock } from "node:test";
    mock.timers.enable({ apis: ["Date"], now: phase === "prepare" ? Math.floor(Date.now()/1000)*1000 : Number(fs.readFileSync(process.env.FORWARDX_TEST_DB + ".clock", "utf8")) + 1000 });
    const mod = file => import(pathToFileURL(path.join(process.cwd(), file)).href);
    const runtime = await mod("server/dbRuntime.ts");
    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
    await (await mod("server/dbSchema.ts")).ensureDatabaseSchema();
    const groups = await mod("server/repositories/forwardGroupRepository.ts");
    const insert = (table, data) => runtime.executeRaw('INSERT INTO "' + table + '" (' + Object.keys(data).map(k => '"' + k + '"').join(',') + ') VALUES (' + Object.keys(data).map(() => '?').join(',') + ')', Object.values(data));
    const seconds = () => Math.floor(Date.now()/1000);
    const evaluate = () => groups.runForwardGroupFailover(10, { skipRuleSync: true });
    const active = async () => (await groups.getForwardGroupById(10)).activeMemberId;
    const advance = async secondsToPass => { mock.timers.tick(secondsToPass*1000); await runtime.executeRaw('UPDATE hosts SET lastHeartbeat=?', [seconds()]); };
    try {
      if (phase === "prepare") {
        await insert("users", { id: 1, username: "admin", password: "x", role: "admin", canAddRules: 1, manualCanAddRules: 1 });
        await insert("forward_groups", { id: 10, name: "restart", groupType: "host", groupMode: "failover", domain: "restart.example.test", targetIp: "0.0.0.0", userId: 1, isEnabled: 1, failoverSeconds: 10, recoverSeconds: 20, autoFailback: 1 });
        for (const id of [1,2]) {
          await insert("hosts", { id, name: "entry-"+id, ip: "198.51.100."+id, ipv4: "198.51.100."+id, userId: 1, isOnline: 1, lastHeartbeat: seconds() });
          await insert("forward_group_members", { id: 100+id, groupId: 10, memberType: "host", hostId: id, priority: id, isEnabled: 1 });
        }
        const rule = { name: "business", hostId: 1, sourcePort: 35212, targetIp: "203.0.113.10", targetPort: 443, forwardType: "nftables", protocol: "tcp", userId: 1, forwardGroupId: 10, isEnabled: 1 };
        await insert("forward_rules", { ...rule, id: 1000, isForwardGroupTemplate: 1 });
        for (const id of [1,2]) await insert("forward_rules", { ...rule, id: 1000+id, hostId: id, forwardGroupRuleId: 1000, forwardGroupMemberId: 100+id, isRunning: 1 });
        await evaluate();
        assert.equal(await active(), 101);
        await runtime.executeRaw('UPDATE forward_rules SET isRunning=0 WHERE id=1001');
        await evaluate(); await advance(11); await evaluate();
        assert.equal(await active(), 102);
        await runtime.executeRaw('UPDATE forward_rules SET isRunning=1 WHERE id=1001');
        await evaluate(); await advance(1); await evaluate();
        assert.equal(await active(), 102);
        fs.writeFileSync(process.env.FORWARDX_TEST_DB + ".clock", String(Date.now()));
      } else {
        await advance(0); await evaluate();
        assert.equal(await active(), 102, "restarting cannot turn an incomplete ordinary runtime recovery into a completed one");
        await advance(21); await evaluate();
        assert.equal(await active(), 101, "priority failback resumes after a complete recovery observation");
      }
    } finally { mock.timers.reset(); await runtime.closeDatabase(); }
  `;
  try {
    for (const phase of ["prepare", "resume"]) runIsolatedScript(directory, database, phase, 'const phase = "' + phase + '";\n' + script);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

for (const scenario of ["continuous", "another-rule", "entry-probe", "recurred", "replacement"]) test("ordinary host failover persists the right failure clock across restart: " + scenario, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-host-entry-failure-restart-"));
  const database = path.join(directory, "test.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import fs from "node:fs";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    import { mock } from "node:test";
    mock.timers.enable({ apis: ["Date"], now: phase === "prepare" ? Math.floor(Date.now()/1000)*1000 : Number(fs.readFileSync(process.env.FORWARDX_TEST_DB + ".clock", "utf8")) + 1000 });
    const mod = file => import(pathToFileURL(path.join(process.cwd(), file)).href);
    const runtime = await mod("server/dbRuntime.ts");
    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
    await (await mod("server/dbSchema.ts")).ensureDatabaseSchema();
    const groups = await mod("server/repositories/forwardGroupRepository.ts");
    const savedRules = await mod("server/repositories/forwardRuleRepository.ts");
    const insert = (table, data) => runtime.executeRaw('INSERT INTO "' + table + '" (' + Object.keys(data).map(k => '"' + k + '"').join(',') + ') VALUES (' + Object.keys(data).map(() => '?').join(',') + ')', Object.values(data));
    const seconds = () => Math.floor(Date.now()/1000);
    const evaluate = () => groups.runForwardGroupFailover(10, { skipRuleSync: true });
    const active = async () => (await groups.getForwardGroupById(10)).activeMemberId;
    const advance = async value => { mock.timers.tick(value*1000); await runtime.executeRaw('UPDATE hosts SET lastHeartbeat=?', [seconds()]); };
    const china = async (memberId, healthy) => groups.updateForwardGroupMemberChinaHealth({ groupId: 10, memberId, hostId: memberId - 100, latencyMs: healthy ? 5 : null, isTimeout: !healthy });
    try {
      if (phase === "prepare") {
        await insert("users", { id: 1, username: "admin", password: "x", role: "admin", canAddRules: 1, manualCanAddRules: 1 });
        await insert("forward_groups", { id: 10, name: "failure restart", groupType: "host", groupMode: "failover", domain: "failure.example.test", targetIp: "0.0.0.0", userId: 1, isEnabled: 1, failoverSeconds: 10, recoverSeconds: 20, autoFailback: 0, chinaHealthCheckEnabled: scenario === "entry-probe" ? 1 : 0 });
        for (const id of [1, 2]) {
          await insert("hosts", { id, name: "entry-" + id, ip: "198.51.100." + id, ipv4: "198.51.100." + id, userId: 1, isOnline: 1, lastHeartbeat: seconds() });
          await insert("forward_group_members", { id: 100+id, groupId: 10, memberType: "host", hostId: id, priority: id, isEnabled: 1 });
        }
        for (const id of [1000, 2000]) {
          const rule = { name: "business-" + id, hostId: 1, sourcePort: 30000+id, targetIp: "203.0.113.10", targetPort: 443, forwardType: "nftables", protocol: "tcp", userId: 1, forwardGroupId: 10, isEnabled: 1 };
          await insert("forward_rules", { ...rule, id, isForwardGroupTemplate: 1 });
          for (const hostId of [1, 2]) await insert("forward_rules", { ...rule, id: id+hostId, hostId, forwardGroupRuleId: id, forwardGroupMemberId: 100+hostId, isRunning: 1 });
        }
        if (scenario === "entry-probe") for (const id of [101, 102]) await china(id, true);
        await evaluate();
        assert.equal(await active(), 101);
        if (scenario === "entry-probe") await china(101, false);
        else await savedRules.updateRuleRunningStatus(1001, false);
        await evaluate(); await advance(9);
        if (scenario === "another-rule" || scenario === "entry-probe") await savedRules.updateRuleRunningStatus(2001, false);
        if (scenario === "recurred") {
          await savedRules.updateRuleRunningStatus(1001, true);
          await evaluate();
          await savedRules.updateRuleRunningStatus(1001, false);
        }
        if (scenario === "replacement") {
          const { id, ...old } = await savedRules.getForwardRuleById(1001);
          await savedRules.markForwardRulePendingDelete(id);
          await savedRules.createForwardRule({ ...old, isEnabled: true, isRunning: false, pendingDelete: false });
        }
        await evaluate();
        assert.equal(await active(), 101, "the original failure delay has not completed yet");
        fs.writeFileSync(process.env.FORWARDX_TEST_DB + ".clock", String(Date.now()));
      } else {
        await advance(0);
        if (scenario === "another-rule") await savedRules.updateRuleRunningStatus(1001, true);
        if (scenario === "entry-probe") {
          // A completed external check cannot lend its earlier failure time to a local rule.
          await groups.updateForwardGroupMemberChinaHealth({ groupId: 10, memberId: 101, hostId: 1, latencyMs: 5, isTimeout: false, healthStatus: "healthy" });
          await china(102, true);
        }
        await evaluate();
        if (scenario === "continuous") assert.equal(await active(), 102, "a restart must retain the completed ordinary-rule failure delay");
        else {
          assert.equal(await active(), 101, "a newly failed rule cannot borrow the clock of another rule or entry probe");
          await advance(8); await evaluate();
          assert.equal(await active(), 101, "the rule's own failure delay is still incomplete");
          await advance(1); await evaluate();
          assert.equal(await active(), 102, "the new rule's own persisted failure delay completes normally");
        }
      }
    } finally { mock.timers.reset(); await runtime.closeDatabase(); }
  `;
  try {
    for (const phase of ["prepare", "resume"]) runIsolatedScript(directory, database, phase, 'const phase = "' + phase + '", scenario = "' + scenario + '";\n' + script);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("ordinary host failover selects the live replacement after moving a rule back", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-host-entry-move-back-"));
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    import { mock } from "node:test";
    mock.timers.enable({ apis: ["Date"], now: Math.floor(Date.now()/1000)*1000 });
    const mod = file => import(pathToFileURL(path.join(process.cwd(), file)).href);
    const runtime = await mod("server/dbRuntime.ts");
    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
    await (await mod("server/dbSchema.ts")).ensureDatabaseSchema();
    const groups = await mod("server/repositories/forwardGroupRepository.ts");
    const savedRules = await mod("server/repositories/forwardRuleRepository.ts");
    const { rulesRouter } = await mod("server/routers/rules.ts");
    const admin = rulesRouter.createCaller({ req: { headers: {} }, res: { clearCookie() {} }, user: { id: 1, username: "admin", role: "admin", accountEnabled: true }, authSession: null, authFailureReason: null });
    const insert = (table, data) => runtime.executeRaw('INSERT INTO "' + table + '" (' + Object.keys(data).map(k => '"' + k + '"').join(',') + ') VALUES (' + Object.keys(data).map(() => '?').join(',') + ')', Object.values(data));
    const seconds = () => Math.floor(Date.now()/1000);
    const evaluate = () => groups.runForwardGroupFailover(10, { skipRuleSync: true });
    try {
      await insert("users", { id: 1, username: "admin", password: "x", role: "admin", canAddRules: 1, manualCanAddRules: 1 });
      for (const id of [1, 2]) await insert("hosts", { id, name: "entry-" + id, ip: "198.51.100." + id, ipv4: "198.51.100." + id, userId: 1, isOnline: 1, lastHeartbeat: seconds() });
      for (const groupId of [10, 20]) {
        await insert("forward_groups", { id: groupId, name: "group-" + groupId, groupType: "host", groupMode: "failover", domain: groupId === 10 ? "move.example.test" : null, targetIp: "0.0.0.0", userId: 1, isEnabled: 1, failoverSeconds: 10, recoverSeconds: 20 });
        for (const hostId of [1, 2]) await insert("forward_group_members", { id: groupId * 10 + hostId, groupId, memberType: "host", hostId, priority: hostId, isEnabled: 1 });
      }
      const rule = await admin.create({ forwardGroupId: 10, name: "movable", sourcePort: 35212, targetIp: "203.0.113.10", targetPort: 443, forwardType: "nftables", protocol: "tcp", isEnabled: true });
      const oldChildren = await savedRules.getForwardGroupChildRulesForTemplate(rule.id);
      await admin.update({ id: rule.id, forwardGroupId: 20 });
      await admin.update({ id: rule.id, forwardGroupId: 10 });
      const children = await savedRules.getForwardGroupChildRulesForTemplate(rule.id);
      assert.ok(oldChildren.every(old => children.some(child => child.id === old.id && child.pendingDelete)), "the real move retains retired children for Agent cleanup");
      for (const child of children.filter(child => child.forwardGroupId === 10 && !child.pendingDelete)) {
        await savedRules.updateRuleRunningStatus(child.id, true);
      }
      await runtime.executeRaw('UPDATE forward_groups SET activeMemberId=101,lastDdnsValue=? WHERE id=10', ["198.51.100.1"]);
      await evaluate();
      mock.timers.tick(21_000);
      await evaluate();
      const current = children.find(child => child.forwardGroupMemberId === 101 && !child.pendingDelete);
      assert.ok(current);
      await savedRules.updateRuleRunningStatus(current.id, false);
      await evaluate();
      mock.timers.tick(11_000);
      await evaluate();
      const state = await groups.getForwardGroupById(10);
      assert.equal(state.activeMemberId, 102, "retired copies must not mask the prepared replacement backup");
      assert.equal(state.lastStatus, "healthy");
    } finally { mock.timers.reset(); await runtime.closeDatabase(); }
  `;
  try { runIsolatedScript(directory, path.join(directory, "test.db"), "move-back", script); }
  finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("tunnel failover retains destination gates and entry groups retain their health windows", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-group-failover-"));
  const databasePath = path.join(directory, "failover.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import http from "node:http";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(moduleUrl("server/dbRuntime.ts"));
    const schema = await import(moduleUrl("server/dbSchema.ts"));
    const requests = [];
    let webhookFailuresRemaining = 0;
    let heldWebhook = null;
    const holdNextWebhookRequest = () => {
      let markStarted;
      let release;
      const started = new Promise((resolve) => { markStarted = resolve; });
      const released = new Promise((resolve) => { release = resolve; });
      heldWebhook = { markStarted, released };
      return { started, release };
    };
    const webhook = http.createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        requests.push(JSON.parse(body || "{}"));
        if (webhookFailuresRemaining > 0) {
          webhookFailuresRemaining -= 1;
          response.writeHead(503, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ message: "temporary provider outage" }));
          return;
        }
        const finish = () => {
          response.writeHead(204);
          response.end();
        };
        const held = heldWebhook;
        if (!held) {
          finish();
          return;
        }
        heldWebhook = null;
        held.markStarted();
        void held.released.then(finish);
      });
    });
    // Fetch rejects restricted ports through 10080 before issuing a request.
    while (true) {
      await new Promise((resolve) => webhook.listen(0, "127.0.0.1", resolve));
      const address = webhook.address();
      if (address && typeof address === "object" && address.port > 10080) break;
      await new Promise((resolve) => webhook.close(resolve));
    }

    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      await runtime.executeRaw('INSERT INTO users (id,username,password,role,canAddRules,manualCanAddRules) VALUES (1,\'admin\',\'x\',\'admin\',1,1)');

      const settings = await import(moduleUrl("server/repositories/settingsRepository.ts"));
      const ddns = await import(moduleUrl("server/ddns.ts"));
      const hosts = await import(moduleUrl("server/repositories/hostRepository.ts"));
      const forwardGroups = await import(moduleUrl("server/repositories/forwardGroupRepository.ts"));
      const forwardGroupHealth = await import(moduleUrl("server/forwardGroupHealthRecheck.ts"));
      const locks = await import(moduleUrl("server/keyedTaskLock.ts"));
      const address = webhook.address();
      assert.ok(address && typeof address === "object");
      await settings.setSettings({
        ddnsEnabled: "true",
        ddnsProvider: "webhook",
        ddnsWebhookUrl: "http://127.0.0.1:" + address.port + "/ddns",
        ddnsWebhookMethod: "POST",
        ddnsTtl: "60",
      });

      const q = (name) => '"' + name + '"';
      const insert = async (table, columns, values) => {
        const placeholders = values.map(() => "?").join(", ");
        await runtime.executeRaw(
          "INSERT INTO " + q(table) + " (" + columns.map(q).join(", ") + ") VALUES (" + placeholders + ")",
          values,
        );
      };
      const now = Math.floor(Date.now() / 1000);
      const useTunnelMembers = async (groupId, bindings) => {
        await runtime.executeRaw('UPDATE forward_groups SET groupType=\'tunnel\' WHERE id=?', [groupId]);
        for (const [memberId, hostId, ruleId] of bindings) {
          await runtime.executeRaw('INSERT INTO tunnels (id,name,entryHostId,exitHostId,listenPort,mode,userId,isEnabled) VALUES (?, ?, ?, ?, ?, ?, 1, 1)',
            [memberId, "tunnel-" + memberId, hostId, hostId === 1 ? 2 : 1, 19000 + memberId, "tls"]);
          await runtime.executeRaw('UPDATE forward_group_members SET memberType=\'tunnel\',hostId=NULL,tunnelId=? WHERE id=?', [memberId, memberId]);
          await runtime.executeRaw('UPDATE forward_rules SET tunnelId=?,forwardType=\'gost\' WHERE id=?', [memberId, ruleId]);
        }
      };

      await insert(
        "hosts",
        ["id", "name", "ip", "ipv4", "userId", "isOnline", "lastHeartbeat"],
        [1, "primary", "198.51.100.10", "198.51.100.10", 1, 1, now - 45],
      );
      await insert(
        "hosts",
        ["id", "name", "ip", "ipv4", "userId", "isOnline", "lastHeartbeat"],
        [2, "standby", "198.51.100.20", "198.51.100.20", 1, 1, now],
      );
      await insert(
        "forward_groups",
        ["id", "name", "groupType", "groupMode", "domain", "recordType", "targetIp", "userId", "isEnabled", "activeMemberId", "failoverSeconds", "recoverSeconds", "autoFailback"],
        [10, "failover", "host", "failover", "edge.example.test", "A", "0.0.0.0", 1, 1, 101, 60, 120, 1],
      );
      await insert(
        "forward_group_members",
        ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"],
        [101, 10, "host", 1, 0, 1],
      );
      await insert(
        "forward_group_members",
        ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"],
        [102, 10, "host", 2, 1, 1],
      );
      await insert(
        "forward_rules",
        ["id", "hostId", "name", "forwardType", "protocol", "forwardGroupId", "isForwardGroupTemplate", "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning"],
        [100, 1, "template", "iptables", "tcp", 10, 1, 16000, "203.0.113.10", 80, 1, 1, 0],
      );
      for (const [id, hostId, memberId] of [[110, 1, 101], [120, 2, 102]]) {
        await insert(
          "forward_rules",
          ["id", "hostId", "name", "forwardType", "protocol", "gostMode", "forwardGroupId", "forwardGroupRuleId", "forwardGroupMemberId", "isForwardGroupTemplate", "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning"],
          [id, hostId, "managed child", "iptables", "tcp", "direct", 10, 100, memberId, 0, 16000, "203.0.113.10", 80, 1, 1, 1],
        );
      }

      await insert(
        "tcping_stats",
        ["ruleId", "hostId", "latencyMs", "isTimeout", "recordedAt"],
        [120, 2, null, 1, now - 360],
      );

      await useTunnelMembers(10, [[101, 1, 110], [102, 2, 120]]);
      await forwardGroups.runForwardGroupFailover(10, { skipRuleSync: true });
      let state = (await runtime.queryRaw(
        'SELECT "activeMemberId", "lastDdnsValue" FROM "forward_groups" WHERE "id" = 10',
      ))[0];
      assert.equal(Number(state.activeMemberId), 101);
      assert.equal(state.lastDdnsValue, "198.51.100.10");

      await runtime.executeRaw('UPDATE "hosts" SET "lastHeartbeat" = ? WHERE "id" = 1', [now - 75]);
      assert.equal((await hosts.getHostById(1)).isOnline, true, "global 150 second host TTL should not have expired yet");

      await forwardGroups.runForwardGroupFailover(10, { skipRuleSync: true });
      state = (await runtime.queryRaw(
        'SELECT "activeMemberId", "lastDdnsValue" FROM "forward_groups" WHERE "id" = 10',
      ))[0];
      assert.equal(Number(state.activeMemberId), 101, "panel communication age must not switch forwarding health");
      await insert(
        "tcping_stats",
        ["ruleId", "hostId", "latencyMs", "isTimeout", "healthStatus", "healthPending", "recordedAt"],
        [110, 1, null, 1, "unhealthy", 0, now],
      );
      await insert(
        "tcping_stats",
        ["ruleId", "hostId", "latencyMs", "isTimeout", "healthStatus", "healthPending", "recordedAt"],
        [120, 2, 12, 0, "healthy", 0, now],
      );
      await forwardGroups.runForwardGroupFailover(10, { skipRuleSync: true });
      state = (await runtime.queryRaw(
        'SELECT "activeMemberId", "lastDdnsValue" FROM "forward_groups" WHERE "id" = 10',
      ))[0];
      assert.equal(Number(state.activeMemberId), 102);
      assert.equal(state.lastDdnsValue, "198.51.100.20");
      assert.equal(
        (await runtime.queryRaw('SELECT "healthStatus" FROM "forward_group_members" WHERE "id" = 102'))[0].healthStatus,
        "healthy",
        "an expired timeout must not permanently block an online standby member",
      );
      assert.deepEqual(requests.map((request) => request.value), ["198.51.100.10", "198.51.100.20"]);
      assert.deepEqual(requests.map((request) => request.values), [["198.51.100.10"], ["198.51.100.20"]]);

      await runtime.executeRaw('UPDATE "hosts" SET "isOnline" = 1, "lastHeartbeat" = ? WHERE "id" = 1', [now]);
      await insert(
        "tcping_stats",
        ["ruleId", "hostId", "latencyMs", "isTimeout", "healthStatus", "healthPending", "recordedAt"],
        [110, 1, 11, 0, "healthy", 0, now + 1],
      );
      await forwardGroups.runForwardGroupFailover(10, { skipRuleSync: true });
      state = (await runtime.queryRaw(
        'SELECT "activeMemberId", "lastDdnsValue" FROM "forward_groups" WHERE "id" = 10',
      ))[0];
      assert.equal(Number(state.activeMemberId), 101);
      assert.equal(state.lastDdnsValue, "198.51.100.10");
      assert.deepEqual(requests.at(-1).values, ["198.51.100.10"], "failover groups must keep exactly one DDNS record");

      const held = holdNextWebhookRequest();
      const firstSync = forwardGroups.runForwardGroupFailover(10, { forceSync: true, skipRuleSync: true });
      await held.started;
      const queuedSync = forwardGroups.runForwardGroupFailover(10, { forceSync: true, skipRuleSync: true });
      const queueDeadline = Date.now() + 2000;
      while (locks.keyedTaskDepth("forward-group-failover:10") < 2 && Date.now() < queueDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(locks.keyedTaskDepth("forward-group-failover:10"), 2, "second failover should wait for the same group");
      await insert(
        "tcping_stats",
        ["ruleId", "hostId", "latencyMs", "isTimeout", "healthStatus", "healthPending", "recordedAt"],
        [110, 1, null, 1, "unhealthy", 0, now + 2],
      );
      await insert(
        "tcping_stats",
        ["ruleId", "hostId", "latencyMs", "isTimeout", "healthStatus", "healthPending", "recordedAt"],
        [120, 2, 10, 0, "healthy", 0, now + 2],
      );
      held.release();
      await Promise.all([firstSync, queuedSync]);
      state = (await runtime.queryRaw(
        'SELECT "activeMemberId", "lastDdnsValue" FROM "forward_groups" WHERE "id" = 10',
      ))[0];
      assert.equal(Number(state.activeMemberId), 102, "queued failover must reload host state after acquiring the group lock");
      assert.equal(state.lastDdnsValue, "198.51.100.20");
      assert.deepEqual(requests.at(-1).values, ["198.51.100.20"], "stale work must not restore the offline primary record");

      await insert(
        "forward_groups",
        ["id", "name", "groupType", "groupMode", "domain", "recordType", "targetIp", "userId", "isEnabled", "activeMemberId", "lastDdnsValue", "failoverSeconds"],
        [30, "fresh-probe", "host", "failover", "fresh.example.test", "A", "0.0.0.0", 1, 1, 301, "198.51.100.10", 60],
      );
      for (const [id, hostId, priority] of [[301, 1, 0], [302, 2, 1]]) {
        await insert(
          "forward_group_members",
          ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"],
          [id, 30, "host", hostId, priority, 1],
        );
      }
      await insert(
        "forward_rules",
        ["id", "hostId", "name", "forwardType", "protocol", "forwardGroupId", "isForwardGroupTemplate", "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning"],
        [300, 1, "fresh template", "iptables", "tcp", 30, 1, 17000, "203.0.113.30", 80, 1, 1, 0],
      );
      for (const [id, hostId, memberId] of [[310, 1, 301], [320, 2, 302]]) {
        await insert(
          "forward_rules",
          ["id", "hostId", "name", "forwardType", "protocol", "gostMode", "forwardGroupId", "forwardGroupRuleId", "forwardGroupMemberId", "isForwardGroupTemplate", "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning"],
          [id, hostId, "fresh child", "iptables", "tcp", "direct", 30, 300, memberId, 0, 17000, "203.0.113.30", 80, 1, 1, 1],
        );
      }
      await insert(
        "tcping_stats",
        ["ruleId", "hostId", "latencyMs", "isTimeout", "healthStatus", "healthPending", "recordedAt"],
        [310, 1, null, 1, "unhealthy", 0, now],
      );
      await insert(
        "tcping_stats",
        ["ruleId", "hostId", "latencyMs", "isTimeout", "healthStatus", "healthPending", "recordedAt"],
        [320, 2, null, 1, "unhealthy", 0, now],
      );
      await useTunnelMembers(30, [[301, 1, 310], [302, 2, 320]]);
      await forwardGroups.runForwardGroupFailover(30, { skipRuleSync: true });
      let freshProbeState = (await runtime.queryRaw(
        'SELECT "activeMemberId", "lastDdnsValue", "lastStatus" FROM "forward_groups" WHERE "id" = 30',
      ))[0];
      assert.equal(Number(freshProbeState.activeMemberId), 301);
      assert.equal(freshProbeState.lastDdnsValue, "198.51.100.10");
      assert.equal(freshProbeState.lastStatus, "down");
      assert.equal(requests.at(-1).action, "replace");
      assert.deepEqual(requests.at(-1).values, ["198.51.100.10"]);

      await insert(
        "tcping_stats",
        ["ruleId", "hostId", "latencyMs", "isTimeout", "healthStatus", "healthPending", "recordedAt"],
        [320, 2, 12, 0, "healthy", 0, now + 1],
      );
      await forwardGroups.runForwardGroupFailover(30, { skipRuleSync: true });
      freshProbeState = (await runtime.queryRaw(
        'SELECT "activeMemberId", "lastDdnsValue", "lastStatus" FROM "forward_groups" WHERE "id" = 30',
      ))[0];
      assert.equal(Number(freshProbeState.activeMemberId), 302);
      assert.equal(freshProbeState.lastDdnsValue, "198.51.100.20");
      assert.equal(requests.at(-1).action, "replace", "a successful fresh probe should immediately restore failover");
      assert.deepEqual(requests.at(-1).values, ["198.51.100.20"]);

      const chinaHealthTtlSeconds = Math.ceil(forwardGroupHealth.FORWARD_GROUP_CHINA_HEALTH_FRESHNESS_TTL_MS / 1000);
      await runtime.executeRaw('UPDATE "hosts" SET "isOnline" = 1, "lastHeartbeat" = ?', [now]);
      await insert(
        "tcping_stats",
        ["ruleId", "hostId", "latencyMs", "isTimeout", "healthStatus", "healthPending", "recordedAt"],
        [310, 1, 11, 0, "healthy", 0, now + 2],
      );
      await runtime.executeRaw('UPDATE "forward_groups" SET "chinaHealthCheckEnabled" = 1 WHERE "id" = 30');
      const requestCountBeforeOrdinaryPendingHealth = requests.length;
      await forwardGroups.runForwardGroupFailover(30, { skipRuleSync: true });
      freshProbeState = (await runtime.queryRaw(
        'SELECT "activeMemberId", "lastDdnsValue", "lastStatus" FROM "forward_groups" WHERE "id" = 30',
      ))[0];
      assert.equal(Number(freshProbeState.activeMemberId), 302);
      assert.equal(freshProbeState.lastDdnsValue, "198.51.100.20");
      assert.equal(freshProbeState.lastStatus, "unknown");
      assert.equal(requests.length, requestCountBeforeOrdinaryPendingHealth, "an active member awaiting its first China probe must keep the current DNS record");
      assert.equal(
        (await runtime.queryRaw('SELECT "failureSince" FROM "forward_group_members" WHERE "id" = 302'))[0].failureSince,
        null,
        "pending China health must not start the failover window",
      );
      await runtime.executeRaw(
        'UPDATE "forward_group_members" SET "chinaHealthStatus" = \'healthy\', "chinaHealthCheckedAt" = ? WHERE "id" = 301',
        [now],
      );
      await runtime.executeRaw(
        'UPDATE "forward_group_members" SET "chinaHealthStatus" = \'healthy\', "chinaHealthCheckedAt" = ? WHERE "id" = 302',
        [now - chinaHealthTtlSeconds - 61],
      );
      await forwardGroups.runForwardGroupFailover(30, { skipRuleSync: true });
      freshProbeState = (await runtime.queryRaw(
        'SELECT "activeMemberId", "lastDdnsValue", "lastStatus" FROM "forward_groups" WHERE "id" = 30',
      ))[0];
      assert.equal(Number(freshProbeState.activeMemberId), 301, "a stale healthy snapshot must not keep the ordinary group on that member");
      assert.equal(freshProbeState.lastDdnsValue, "198.51.100.10");
      assert.equal(
        (await runtime.queryRaw('SELECT "healthStatus" FROM "forward_group_members" WHERE "id" = 302'))[0].healthStatus,
        "unhealthy",
      );

      await insert(
        "forward_groups",
        ["id", "name", "groupType", "groupMode", "domain", "recordType", "targetIp", "userId", "isEnabled", "failoverSeconds"],
        [20, "entry", "host", "entry", "entry.example.test", "A", "0.0.0.0", 1, 1, 60],
      );
      await insert(
        "forward_group_members",
        ["id", "groupId", "memberType", "hostId", "priority", "isEnabled", "healthStatus", "lastCheckedAt", "healthySince"],
        [201, 20, "host", 1, 0, 1, "healthy", now, now - 121],
      );
      await insert(
        "forward_group_members",
        ["id", "groupId", "memberType", "hostId", "priority", "isEnabled", "healthStatus", "lastCheckedAt", "healthySince"],
        [202, 20, "host", 2, 1, 1, "healthy", now, now - 121],
      );

      await runtime.executeRaw('UPDATE "hosts" SET "isOnline" = 1, "lastHeartbeat" = ?', [now]);
      await forwardGroups.runForwardGroupFailover(20);
      let entryState = (await runtime.queryRaw(
        'SELECT "activeMemberId", "lastDdnsValue", "lastStatus" FROM "forward_groups" WHERE "id" = 20',
      ))[0];
      assert.equal(Number(entryState.activeMemberId), 201);
      assert.equal(entryState.lastDdnsValue, "198.51.100.10,198.51.100.20");
      assert.deepEqual(requests.at(-1).values, ["198.51.100.10", "198.51.100.20"]);

      await runtime.executeRaw('UPDATE "hosts" SET "isOnline" = 1, "lastHeartbeat" = ?', [now - 75]);
      await forwardGroups.runForwardGroupFailover(20);
      entryState = (await runtime.queryRaw(
        'SELECT "activeMemberId", "lastDdnsValue", "lastStatus" FROM "forward_groups" WHERE "id" = 20',
      ))[0];
      assert.equal(Number(entryState.activeMemberId), 201);
      assert.equal(entryState.lastDdnsValue, "198.51.100.10,198.51.100.20");
      assert.equal(entryState.lastStatus, "healthy");
      assert.deepEqual(
        requests.at(-1).values,
        ["198.51.100.10", "198.51.100.20"],
        "panel communication age must not override the Agent health decision",
      );

      await runtime.executeRaw('UPDATE "forward_groups" SET "chinaHealthCheckEnabled" = 1 WHERE "id" = 20');
      const requestCountBeforeInitialHealth = requests.length;
      await forwardGroups.runForwardGroupFailover(20);
      entryState = (await runtime.queryRaw(
        'SELECT "activeMemberId", "lastDdnsValue", "lastStatus" FROM "forward_groups" WHERE "id" = 20',
      ))[0];
      assert.equal(Number(entryState.activeMemberId), 201);
      assert.equal(entryState.lastDdnsValue, "198.51.100.10,198.51.100.20");
      assert.equal(entryState.lastStatus, "unknown");
      assert.equal(requests.length, requestCountBeforeInitialHealth, "enabling health checks must wait for the first result without clearing DNS");

      await runtime.executeRaw('UPDATE "hosts" SET "isOnline" = 0 WHERE "id" = 1');
      await runtime.executeRaw('UPDATE "forward_group_members" SET "chinaHealthStatus" = \'healthy\', "chinaHealthCheckedAt" = ? WHERE "id" = 201', [now]);
      await runtime.executeRaw('UPDATE "forward_group_members" SET "chinaHealthStatus" = \'unhealthy\', "chinaHealthCheckedAt" = ? WHERE "id" = 202', [now]);
      await runtime.executeRaw('UPDATE "forward_group_members" SET "failureSince" = ? WHERE "id" = 202', [now - 61]);
      await forwardGroups.runForwardGroupFailover(20);
      entryState = (await runtime.queryRaw(
        'SELECT "activeMemberId", "lastDdnsValue", "lastStatus" FROM "forward_groups" WHERE "id" = 20',
      ))[0];
      assert.equal(Number(entryState.activeMemberId), 201);
      assert.equal(entryState.lastDdnsValue, "198.51.100.10");
      assert.deepEqual(
        requests.at(-1).values,
        ["198.51.100.10"],
        "an enabled China health check must own DNS selection after the failover window",
      );

      await runtime.executeRaw(
        'UPDATE "forward_group_members" SET "chinaHealthStatus" = \'healthy\', "chinaHealthCheckedAt" = ? WHERE "id" = 201',
        [now - chinaHealthTtlSeconds - 1],
      );
      await runtime.executeRaw(
        'UPDATE "forward_group_members" SET "chinaHealthStatus" = \'healthy\', "chinaHealthCheckedAt" = ? WHERE "id" = 202',
        [now],
      );
      await runtime.executeRaw('UPDATE "forward_group_members" SET "failureSince" = ? WHERE "id" = 201', [now - 61]);
      await runtime.executeRaw('UPDATE "forward_group_members" SET "healthySince" = ? WHERE "id" = 202', [now - 121]);
      await forwardGroups.runForwardGroupFailover(20);
      entryState = (await runtime.queryRaw(
        'SELECT "activeMemberId", "lastDdnsValue", "lastStatus" FROM "forward_groups" WHERE "id" = 20',
      ))[0];
      assert.equal(Number(entryState.activeMemberId), 202);
      assert.equal(entryState.lastDdnsValue, "198.51.100.20");
      assert.deepEqual(requests.at(-1).values, ["198.51.100.20"], "entry groups must apply failure and recovery after both windows mature");

      const requestCountBeforePendingHealth = requests.length;
      await runtime.executeRaw('UPDATE "forward_group_members" SET "chinaHealthStatus" = \'unknown\', "chinaHealthCheckedAt" = NULL WHERE "groupId" = 20');
      await forwardGroups.runForwardGroupFailover(20);
      entryState = (await runtime.queryRaw(
        'SELECT "activeMemberId", "lastDdnsValue", "lastStatus" FROM "forward_groups" WHERE "id" = 20',
      ))[0];
      assert.equal(Number(entryState.activeMemberId), 202);
      assert.equal(entryState.lastDdnsValue, "198.51.100.20");
      assert.equal(entryState.lastStatus, "unknown");
      assert.equal(requests.length, requestCountBeforePendingHealth, "pending probes must not clear a working DNS record");

      await runtime.executeRaw(
        'UPDATE "forward_group_members" SET "chinaHealthStatus" = \'healthy\', "chinaHealthCheckedAt" = ? WHERE "groupId" = 20',
        [now - chinaHealthTtlSeconds - 1],
      );
      await runtime.executeRaw('UPDATE "forward_group_members" SET "failureSince" = ?', [now - 61]);
      await forwardGroups.runForwardGroupFailover(20);
      entryState = (await runtime.queryRaw(
        'SELECT "activeMemberId", "lastDdnsValue", "lastStatus" FROM "forward_groups" WHERE "id" = 20',
      ))[0];
      assert.equal(Number(entryState.activeMemberId), 202);
      assert.equal(entryState.lastDdnsValue, "198.51.100.20");
      assert.equal(entryState.lastStatus, "down");
      assert.equal(requests.at(-1).action, "replace");
      assert.deepEqual(requests.at(-1).values, ["198.51.100.20"]);

      await runtime.executeRaw('UPDATE "forward_groups" SET "chinaHealthCheckEnabled" = 0 WHERE "id" = 20');
      await forwardGroups.resetForwardGroupChinaHealth(20);
      await runtime.executeRaw('UPDATE "hosts" SET "isOnline" = 1, "lastHeartbeat" = ? WHERE "id" = 2', [now - 75]);
      await runtime.executeRaw(
        'UPDATE "forward_group_members" SET "healthStatus" = \'unhealthy\', "lastCheckedAt" = ?, "failureSince" = ?, "healthySince" = NULL WHERE "id" = 201',
        [now, now - 61],
      );
      await runtime.executeRaw(
        'UPDATE "forward_group_members" SET "healthStatus" = \'healthy\', "lastCheckedAt" = ?, "failureSince" = NULL, "healthySince" = ? WHERE "id" = 202',
        [now, now - 121],
      );
      await forwardGroups.runForwardGroupFailover(20);
      entryState = (await runtime.queryRaw(
        'SELECT "activeMemberId", "lastDdnsValue", "lastStatus" FROM "forward_groups" WHERE "id" = 20',
      ))[0];
      assert.equal(Number(entryState.activeMemberId), 202);
      assert.equal(entryState.lastDdnsValue, "198.51.100.20");
      assert.deepEqual(requests.at(-1).values, ["198.51.100.20"]);
      assert.deepEqual(
        (await runtime.queryRaw('SELECT "chinaHealthStatus" FROM "forward_group_members" WHERE "groupId" = 20 ORDER BY "id"')).map((row) => row.chinaHealthStatus),
        ["unknown", "unknown"],
        "turning health checks off must ignore the reset health state",
      );

      await runtime.executeRaw('UPDATE "hosts" SET "isOnline" = 0 WHERE "id" = 1');
      await forwardGroups.runForwardGroupFailover(20);
      entryState = (await runtime.queryRaw(
        'SELECT "activeMemberId", "lastDdnsValue", "lastStatus" FROM "forward_groups" WHERE "id" = 20',
      ))[0];
      assert.equal(Number(entryState.activeMemberId), 202);
      assert.equal(entryState.lastDdnsValue, "198.51.100.20");
      assert.equal(entryState.lastStatus, "healthy");
      assert.equal(requests.at(-1).action, "replace");
      assert.deepEqual(requests.at(-1).values, ["198.51.100.20"], "communication flags must not override the last Agent health decision");

      await runtime.executeRaw('UPDATE "hosts" SET "isOnline" = 1, "lastHeartbeat" = ? WHERE "id" = 1', [now]);
      await runtime.executeRaw(
        'UPDATE "forward_group_members" SET "healthStatus" = \'healthy\', "lastCheckedAt" = ?, "failureSince" = NULL, "healthySince" = ? WHERE "id" = 201',
        [now, now - 121],
      );
      await forwardGroups.runForwardGroupFailover(20);
      entryState = (await runtime.queryRaw(
        'SELECT "activeMemberId", "lastDdnsValue", "lastStatus" FROM "forward_groups" WHERE "id" = 20',
      ))[0];
      assert.equal(Number(entryState.activeMemberId), 201);
      assert.equal(entryState.lastDdnsValue, "198.51.100.10,198.51.100.20");
      assert.equal(entryState.lastStatus, "healthy");
      assert.deepEqual(requests.at(-1).values, ["198.51.100.10", "198.51.100.20"], "entry groups must restore the recovered host record");

      await runtime.executeRaw('UPDATE "hosts" SET "isOnline" = 0');
      await runtime.executeRaw(
        'UPDATE "forward_group_members" SET "healthStatus" = \'unhealthy\', "lastCheckedAt" = ?, "failureSince" = ?, "healthySince" = NULL',
        [now, now - 61],
      );
      await forwardGroups.runForwardGroupFailover(20);
      entryState = (await runtime.queryRaw(
        'SELECT "activeMemberId", "lastDdnsValue", "lastStatus" FROM "forward_groups" WHERE "id" = 20',
      ))[0];
      assert.equal(Number(entryState.activeMemberId), 201);
      assert.equal(entryState.lastDdnsValue, "198.51.100.10");
      assert.equal(entryState.lastStatus, "down");
      assert.equal(requests.at(-1).action, "replace");
      assert.deepEqual(requests.at(-1).values, ["198.51.100.10"]);

      await runtime.executeRaw('UPDATE "hosts" SET "lastHeartbeat" = ?', [now - 75]);
      await forwardGroups.runForwardGroupFailover(10, { forceSync: true, skipRuleSync: true });
      state = (await runtime.queryRaw(
        'SELECT "activeMemberId", "lastDdnsValue", "lastStatus" FROM "forward_groups" WHERE "id" = 10',
      ))[0];
      assert.equal(Number(state.activeMemberId), 102);
      assert.equal(state.lastDdnsValue, "198.51.100.20");
      assert.equal(state.lastStatus, "healthy");
      assert.equal(requests.at(-1).domain, "edge.example.test");
      assert.equal(requests.at(-1).action, "replace");
      assert.deepEqual(requests.at(-1).values, ["198.51.100.20"]);

      await runtime.executeRaw('UPDATE "hosts" SET "isOnline" = 1, "lastHeartbeat" = ?', [now]);
      await runtime.executeRaw(
        'UPDATE "forward_group_members" SET "healthStatus" = \'healthy\', "lastCheckedAt" = ?, "failureSince" = NULL, "healthySince" = ? WHERE "groupId" = 20',
        [now, now - 121],
      );
      webhookFailuresRemaining = 1;
      const entryRetryRequestStart = requests.length;
      forwardGroups.scheduleForwardGroupFailover([20]);
      const entryRetryDeadline = Date.now() + 5_000;
      do {
        entryState = (await runtime.queryRaw(
          'SELECT "activeMemberId", "lastDdnsValue", "lastStatus" FROM "forward_groups" WHERE "id" = 20',
        ))[0];
        if (
          Number(entryState.activeMemberId) === 201
          && entryState.lastDdnsValue === "198.51.100.10,198.51.100.20"
          && requests.length >= entryRetryRequestStart + 2
        ) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      } while (Date.now() < entryRetryDeadline);
      assert.equal(Number(entryState.activeMemberId), 201, "entry group did not recover after a transient DDNS failure");
      assert.equal(entryState.lastDdnsValue, "198.51.100.10,198.51.100.20");
      assert.equal(entryState.lastStatus, "healthy");
      assert.equal(requests.length, entryRetryRequestStart + 2, "entry group must retry one failed provider request once");

      await insert(
        "forward_groups",
        ["id", "name", "groupType", "groupMode", "domain", "recordType", "targetIp", "userId", "isEnabled", "failoverSeconds"],
        [40, "retry", "host", "failover", "retry.example.test", "A", "0.0.0.0", 1, 1, 60],
      );
      await insert(
        "forward_group_members",
        ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"],
        [401, 40, "host", 1, 0, 1],
      );
      webhookFailuresRemaining = 1;
      const singleRetryRequestStart = requests.length;
      forwardGroups.scheduleForwardGroupFailover([40]);
      const singleRetryDeadline = Date.now() + 5_000;
      let retryState;
      do {
        [retryState] = await runtime.queryRaw(
          'SELECT "activeMemberId", "lastDdnsValue", "lastStatus" FROM "forward_groups" WHERE "id" = 40',
        );
        if (
          Number(retryState?.activeMemberId) === 401
          && retryState?.lastDdnsValue === "198.51.100.10"
          && requests.length >= singleRetryRequestStart + 2
        ) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      } while (Date.now() < singleRetryDeadline);
      assert.equal(Number(retryState?.activeMemberId), 401, "failover group did not recover after a transient DDNS failure");
      assert.equal(retryState?.lastDdnsValue, "198.51.100.10");
      assert.equal(retryState?.lastStatus, "healthy");
      assert.equal(requests.length, singleRetryRequestStart + 2, "failover group must retry one failed provider request once");

      await settings.setSettings({
        ddnsEnabled: "true",
        ddnsProvider: "cloudflare",
        ddnsCloudflareZoneId: "zone-1",
        ddnsCloudflareApiToken: "token-1",
        ddnsTtl: "60",
      });
      let cloudflareRecords = [
        { id: "old-1", name: "edge.cloudflare.test", type: "A", content: "198.51.100.10", proxied: false },
        { id: "old-2", name: "edge.cloudflare.test", type: "A", content: "198.51.100.20", proxied: false },
      ];
      const cloudflareOperations = [];
      let cloudflareRecordSequence = 0;
      let delayedCloudflareValue = "";
      globalThis.fetch = async (rawUrl, init = {}) => {
        const url = String(rawUrl);
        const method = String(init.method || "GET").toUpperCase();
        if (method === "GET") {
          return new Response(JSON.stringify({ success: true, result: cloudflareRecords }), { status: 200 });
        }
        if (method === "DELETE") {
          const id = decodeURIComponent(url.split("/").at(-1));
          cloudflareOperations.push({ method, id });
          cloudflareRecords = cloudflareRecords.filter((record) => record.id !== id);
          return new Response(JSON.stringify({ success: true, result: null }), { status: 200 });
        }
        if (method === "PUT") {
          const id = decodeURIComponent(url.split("/").at(-1));
          const payload = JSON.parse(String(init.body || "{}"));
          cloudflareOperations.push({ method, id, value: payload.content });
          if (payload.content === delayedCloudflareValue) {
            await new Promise((resolve) => setTimeout(resolve, 40));
          }
          cloudflareRecords = cloudflareRecords.map((record) => record.id === id ? { ...record, ...payload } : record);
          return new Response(JSON.stringify({ success: true, result: payload }), { status: 200 });
        }
        if (method === "POST") {
          const payload = JSON.parse(String(init.body || "{}"));
          const id = "new-" + (++cloudflareRecordSequence);
          cloudflareOperations.push({ method, id, value: payload.content });
          cloudflareRecords.push({ id, ...payload });
          return new Response(JSON.stringify({ success: true, result: payload }), { status: 200 });
        }
        throw new Error("unexpected Cloudflare request " + method + " " + url);
      };
      await ddns.updateDdnsRecordValues({
        groupId: 99,
        domain: "edge.cloudflare.test",
        recordType: "A",
        values: ["198.51.100.20"],
      });
      assert.deepEqual(cloudflareRecords.map((record) => record.content), ["198.51.100.20"]);
      assert.equal(cloudflareRecords[0].id, "old-2", "entry group must preserve the online member record");
      assert.deepEqual(cloudflareOperations, [{ method: "DELETE", id: "old-1" }]);

      cloudflareRecords = [
        { id: "single-1", name: "edge.cloudflare.test", type: "A", content: "198.51.100.10", proxied: false },
      ];
      cloudflareOperations.length = 0;
      await ddns.updateDdnsRecordValues({
        groupId: 99,
        domain: "edge.cloudflare.test",
        recordType: "A",
        values: ["198.51.100.20"],
      });
      assert.deepEqual(cloudflareRecords.map((record) => [record.id, record.content]), [["single-1", "198.51.100.20"]]);
      assert.deepEqual(cloudflareOperations, [
        { method: "PUT", id: "single-1", value: "198.51.100.20" },
      ], "single-record failover must update in place without delete/create gap");

      cloudflareRecords = [
        { id: "serial-1", name: "edge.cloudflare.test", type: "A", content: "198.51.100.10", proxied: false },
      ];
      cloudflareOperations.length = 0;
      delayedCloudflareValue = "198.51.100.20";
      const firstUpdate = ddns.updateDdnsRecordValues({
        groupId: 99,
        domain: "edge.cloudflare.test",
        recordType: "A",
        values: ["198.51.100.20"],
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
      const secondUpdate = ddns.updateDdnsRecordValues({
        groupId: 99,
        domain: "edge.cloudflare.test",
        recordType: "A",
        values: ["198.51.100.30"],
      });
      await Promise.all([firstUpdate, secondUpdate]);
      delayedCloudflareValue = "";
      assert.deepEqual(cloudflareRecords.map((record) => [record.id, record.content]), [["serial-1", "198.51.100.30"]]);
      assert.deepEqual(cloudflareOperations.map((operation) => operation.method), ["PUT", "PUT"]);

      await ddns.updateDdnsRecordValues({
        groupId: 99,
        domain: "edge.cloudflare.test",
        recordType: "A",
        values: [],
      });
      assert.deepEqual(cloudflareRecords, []);
    } finally {
      await runtime.closeDatabase().catch(() => undefined);
      await new Promise((resolve) => webhook.close(resolve));
    }
  `;

  try {
    runIsolatedScript(directory, databasePath, "failover", script);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("entry group health windows suppress transient DDNS flaps", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-entry-health-window-"));
  const databasePath = path.join(directory, "entry-health.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import http from "node:http";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(moduleUrl("server/dbRuntime.ts"));
    const schema = await import(moduleUrl("server/dbSchema.ts"));
    const requests = [];
    const webhook = http.createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        requests.push(JSON.parse(body || "{}"));
        response.writeHead(204);
        response.end();
      });
    });
    // Fetch rejects restricted ports through 10080 before issuing a request.
    while (true) {
      await new Promise((resolve) => webhook.listen(0, "127.0.0.1", resolve));
      const address = webhook.address();
      if (address && typeof address === "object" && address.port > 10080) break;
      await new Promise((resolve) => webhook.close(resolve));
    }

    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      const settings = await import(moduleUrl("server/repositories/settingsRepository.ts"));
      const groups = await import(moduleUrl("server/repositories/forwardGroupRepository.ts"));
      const activity = await import(moduleUrl("server/agentActivity.ts"));
      const address = webhook.address();
      await settings.setSettings({
        ddnsEnabled: "true",
        ddnsProvider: "webhook",
        ddnsWebhookUrl: "http://127.0.0.1:" + address.port + "/ddns",
        ddnsWebhookMethod: "POST",
      });
      const insert = async (table, columns, values) => {
        const q = (name) => '"' + name + '"';
        await runtime.executeRaw(
          "INSERT INTO " + q(table) + " (" + columns.map(q).join(", ") + ") VALUES (" + values.map(() => "?").join(", ") + ")",
          values,
        );
      };
      const now = Math.floor(Date.now() / 1000);
      for (const [id, ip] of [[1, "198.51.100.10"], [2, "198.51.100.20"]]) {
        await insert("hosts", ["id", "name", "ip", "ipv4", "userId", "isOnline", "lastHeartbeat"], [id, "entry-" + id, ip, ip, 1, 1, now]);
      }
      await insert(
        "forward_groups",
        ["id", "name", "groupType", "groupMode", "domain", "recordType", "targetIp", "userId", "isEnabled", "failoverSeconds", "recoverSeconds", "chinaHealthCheckEnabled"],
        [70, "stable-entry", "host", "entry", "stable.example.test", "A", "0.0.0.0", 1, 1, 10, 10, 1],
      );
      for (const [id, hostId, priority] of [[701, 1, 0], [702, 2, 1]]) {
        await insert(
          "forward_group_members",
          ["id", "groupId", "memberType", "hostId", "priority", "isEnabled", "chinaHealthStatus", "chinaHealthCheckedAt"],
          [id, 70, "host", hostId, priority, 1, "healthy", now],
        );
      }

      activity.recordAuthenticatedAgentActivity(1, (now - 300) * 1000);
      await groups.runForwardGroupFailover(70);
      assert.deepEqual(requests.at(-1).values, ["198.51.100.10", "198.51.100.20"], "newer DB heartbeat must win over stale in-memory activity");

      const baseline = requests.length;
      await runtime.executeRaw('UPDATE "forward_group_members" SET "chinaHealthStatus" = \'unhealthy\', "chinaHealthCheckedAt" = ? WHERE "id" = 701', [now]);
      await groups.runForwardGroupFailover(70);
      await runtime.executeRaw('UPDATE "forward_group_members" SET "chinaHealthStatus" = \'healthy\', "chinaHealthCheckedAt" = ? WHERE "id" = 701', [now]);
      await groups.runForwardGroupFailover(70);
      assert.equal(requests.length, baseline, "timeout followed by success inside failover window must not touch DDNS");

      await runtime.executeRaw('UPDATE "forward_group_members" SET "chinaHealthStatus" = \'unhealthy\', "chinaHealthCheckedAt" = ?, "failureSince" = ? WHERE "id" = 701', [now, now - 11]);
      await groups.runForwardGroupFailover(70);
      assert.deepEqual(requests.at(-1).values, ["198.51.100.20"]);
      const failed = requests.length;
      await runtime.executeRaw('UPDATE "forward_group_members" SET "chinaHealthStatus" = \'healthy\', "chinaHealthCheckedAt" = ? WHERE "id" = 701', [now]);
      await groups.runForwardGroupFailover(70);
      assert.equal(requests.length, failed, "recovery inside recover window must not re-add the entry");
      await runtime.executeRaw('UPDATE "forward_group_members" SET "healthySince" = ? WHERE "id" = 701', [now - 11]);
      await groups.runForwardGroupFailover(70);
      assert.deepEqual(requests.at(-1).values, ["198.51.100.10", "198.51.100.20"]);

      const beforePendingHealth = requests.length;
      await runtime.executeRaw('UPDATE "hosts" SET "isOnline" = 0, "lastHeartbeat" = ? WHERE "id" = 1', [now - 300]);
      await runtime.executeRaw('UPDATE "forward_group_members" SET "chinaHealthStatus" = \'unknown\', "chinaHealthCheckedAt" = NULL, "failureSince" = ? WHERE "id" = 701', [now - 11]);
      await groups.runForwardGroupFailover(70);
      assert.equal(requests.length, beforePendingHealth + 1, "confirmed host offline must override a pending health snapshot");
      assert.deepEqual(requests.at(-1).values, ["198.51.100.20"]);

      await runtime.executeRaw(
        'UPDATE "forward_group_members" SET "chinaHealthStatus" = \'unhealthy\', "chinaHealthCheckedAt" = ?, "failureSince" = ? WHERE "id" = 701',
        [now, now - 11],
      );
      await groups.runForwardGroupFailover(70);
      assert.deepEqual(requests.at(-1).values, ["198.51.100.20"], "a final unhealthy decision must remove the failed entry");

      const oneEntry = requests.length;
      await runtime.executeRaw('UPDATE "hosts" SET "isOnline" = 0, "lastHeartbeat" = ? WHERE "id" = 2', [now - 300]);
      await groups.runForwardGroupFailover(70);
      assert.equal(requests.length, oneEntry, "an all-offline group must retain its last managed record");
      await runtime.executeRaw(
        'UPDATE "forward_group_members" SET "chinaHealthStatus" = \'unhealthy\', "chinaHealthCheckedAt" = ?, "failureSince" = ? WHERE "id" = 702',
        [now, now - 11],
      );
      await groups.runForwardGroupFailover(70);
      assert.equal(requests.at(-1).action, "replace");
      assert.deepEqual(requests.at(-1).values, ["198.51.100.20"], "all-offline entry groups must retain one managed record");

      await runtime.executeRaw('UPDATE "hosts" SET "isOnline" = 1, "lastHeartbeat" = ? WHERE "id" = 1', [now]);
      await runtime.executeRaw(
        'UPDATE "forward_group_members" SET "chinaHealthStatus" = \'healthy\', "chinaHealthCheckedAt" = ?, "failureSince" = NULL, "healthySince" = ? WHERE "id" = 701',
        [now, now - 11],
      );
      await groups.runForwardGroupFailover(70);
      assert.equal(requests.at(-1).action, "replace");
      assert.deepEqual(requests.at(-1).values, ["198.51.100.10"], "DNS must move to the member that recovers while the retained member remains offline");
    } finally {
      await runtime.closeDatabase().catch(() => undefined);
      await new Promise((resolve) => webhook.close(resolve));
    }
  `;

  try {
    runIsolatedScript(directory, databasePath, "entry-health-window", script);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("failover groups return to the highest-priority recovered member after multiple failures", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-group-priority-failback-"));
  const databasePath = path.join(directory, "priority-failback.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import http from "node:http";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(moduleUrl("server/dbRuntime.ts"));
    const schema = await import(moduleUrl("server/dbSchema.ts"));
    const groups = await import(moduleUrl("server/repositories/forwardGroupRepository.ts"));
    const settings = await import(moduleUrl("server/repositories/settingsRepository.ts"));
    const requests = [];
    const webhook = http.createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        requests.push(JSON.parse(body || "{}"));
        response.writeHead(204);
        response.end();
      });
    });
    while (true) {
      await new Promise((resolve) => webhook.listen(0, "127.0.0.1", resolve));
      const address = webhook.address();
      if (address && typeof address === "object" && address.port > 10080) break;
      await new Promise((resolve) => webhook.close(resolve));
    }

    const insert = async (table, columns, values) => {
      const q = (name) => '"' + name + '"';
      await runtime.executeRaw(
        "INSERT INTO " + q(table) + " (" + columns.map(q).join(", ") + ") VALUES (" + values.map(() => "?").join(", ") + ")",
        values,
      );
    };
    const health = async (ruleId, status, recordedAt) => {
      await runtime.executeRaw(
        'INSERT INTO "tcping_stats" ("ruleId", "hostId", "latencyMs", "isTimeout", "healthStatus", "healthPending", "recordedAt") VALUES (?, ?, ?, ?, ?, ?, ?)',
        [ruleId, Math.floor(ruleId / 10) - 80, status === "healthy" ? 10 : null, status === "healthy" ? 0 : 1, status, 0, recordedAt],
      );
      const hostId = Math.floor(ruleId / 10) - 80;
      await groups.updateForwardGroupMemberChinaHealth({ groupId: 80, memberId: 800 + hostId, hostId,
        latencyMs: status === "healthy" ? 10 : null, isTimeout: status !== "healthy", healthStatus: status });
    };

    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      await runtime.executeRaw('INSERT INTO users (id,username,password,role,canAddRules,manualCanAddRules) VALUES (1,\'admin\',\'x\',\'admin\',1,1)');
      const address = webhook.address();
      await settings.setSettings({
        ddnsEnabled: "true",
        ddnsProvider: "webhook",
        ddnsWebhookUrl: "http://127.0.0.1:" + address.port + "/ddns",
        ddnsWebhookMethod: "POST",
      });
      const now = Math.floor(Date.now() / 1000);
      for (const [id, ip] of [[1, "198.51.100.11"], [2, "198.51.100.12"], [3, "198.51.100.13"]]) {
        await insert("hosts", ["id", "name", "ip", "ipv4", "userId", "isOnline", "lastHeartbeat"], [id, "member-" + id, ip, ip, 1, 1, now]);
      }
      await insert(
        "forward_groups",
        ["id", "name", "groupType", "groupMode", "domain", "recordType", "targetIp", "userId", "isEnabled", "activeMemberId", "failoverSeconds", "recoverSeconds", "autoFailback", "chinaHealthCheckEnabled"],
        [80, "priority-failback", "host", "failover", "priority.example.test", "A", "0.0.0.0", 1, 1, 801, 10, 10, 1, 1],
      );
      for (const [memberId, hostId, priority] of [[801, 1, 0], [802, 2, 1], [803, 3, 2]]) {
        await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [memberId, 80, "host", hostId, priority, 1]);
      }
      await insert(
        "forward_rules",
        ["id", "hostId", "name", "forwardType", "protocol", "forwardGroupId", "isForwardGroupTemplate", "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning"],
        [800, 1, "priority template", "iptables", "tcp", 80, 1, 18000, "203.0.113.80", 80, 1, 1, 0],
      );
      for (const [ruleId, hostId, memberId] of [[810, 1, 801], [820, 2, 802], [830, 3, 803]]) {
        await insert(
          "forward_rules",
          ["id", "hostId", "name", "forwardType", "protocol", "gostMode", "forwardGroupId", "forwardGroupRuleId", "forwardGroupMemberId", "isForwardGroupTemplate", "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning"],
          [ruleId, hostId, "priority child", "iptables", "tcp", "direct", 80, 800, memberId, 0, 18000, "203.0.113.80", 80, 1, 1, 1],
        );
      }

      await health(810, "healthy", now);
      await health(820, "healthy", now);
      await health(830, "healthy", now);
      await groups.runForwardGroupFailover(80);
      let state = (await runtime.queryRaw('SELECT "activeMemberId", "lastDdnsValue" FROM "forward_groups" WHERE "id" = 80'))[0];
      assert.equal(Number(state.activeMemberId), 801);

      await health(810, "unhealthy", now + 1);
      await groups.runForwardGroupFailover(80);
      state = (await runtime.queryRaw('SELECT "activeMemberId", "lastDdnsValue" FROM "forward_groups" WHERE "id" = 80'))[0];
      assert.equal(Number(state.activeMemberId), 802, "the first member failure should select member 2");

      await health(820, "unhealthy", now + 2);
      await groups.runForwardGroupFailover(80);
      state = (await runtime.queryRaw('SELECT "activeMemberId", "lastDdnsValue" FROM "forward_groups" WHERE "id" = 80'))[0];
      assert.equal(Number(state.activeMemberId), 803, "the second member failure should select member 3");

      await health(810, "healthy", now + 3);
      await groups.runForwardGroupFailover(80);
      state = (await runtime.queryRaw('SELECT "activeMemberId", "lastDdnsValue" FROM "forward_groups" WHERE "id" = 80'))[0];
      assert.equal(Number(state.activeMemberId), 801, "a recovered member must reclaim its higher priority");
      assert.equal(state.lastDdnsValue, "198.51.100.11");
      assert.deepEqual(requests.map((request) => request.value), [
        "198.51.100.11",
        "198.51.100.12",
        "198.51.100.13",
        "198.51.100.11",
      ]);
    } finally {
      await runtime.closeDatabase().catch(() => undefined);
      await new Promise((resolve) => webhook.close(resolve));
    }
  `;

  try {
    runIsolatedScript(directory, databasePath, "priority-failback", script);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
