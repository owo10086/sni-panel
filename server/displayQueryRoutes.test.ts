import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";

test("cached display routes keep ownership, live permission checks and write invalidation", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-display-cache-"));
  process.env.DATABASE_TYPE = "sqlite";
  process.env.SQLITE_PATH = path.join(directory, "fixture.db");
  process.env.DATABASE_CONFIG_PATH = path.join(directory, "config.json");
  process.env.JWT_SECRET = "display-cache-isolated-test-secret-never-used-for-login";
  process.env.FORWARDX_LOG_DIR = path.join(directory, "logs");
  const runtime = await import("./dbRuntime");
  let statusServer: import("node:http").Server | undefined;
  try {
    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.SQLITE_PATH } });
    await (await import("./dbSchema")).ensureDatabaseSchema();
    await runtime.withSqliteExclusive((sqlite) => sqlite.exec(`
      INSERT INTO users (id,username,password,role,canAddRules,manualCanAddRules) VALUES
        (1,'admin','x','admin',1,1),(2,'user-a','x','user',1,1),(3,'user-b','x','user',1,1);
      INSERT INTO hosts (id,name,ip,userId) VALUES (1,'shared','192.0.2.1',1);
      INSERT INTO user_host_permissions (userId,hostId) VALUES (2,1),(3,1);
      INSERT INTO forward_rules (id,hostId,userId,name,forwardType,sourcePort,targetIp,targetPort,isEnabled) VALUES
        (1,1,2,'User A rule','iptables',10001,'198.51.100.1',443,0),
        (2,1,3,'User B rule','iptables',10002,'198.51.100.1',443,0);
    `));
    const { appRouter } = await import("./routers");
    const { displayQueries } = await import("./displayQueryCache");
    const caller = (id: number, role: string) => appRouter.createCaller({
      user: { id, role } as any, req: { headers: {} } as any, res: {} as any,
      authSession: null, authFailureReason: null,
    });
    const a = caller(2, "user"), b = caller(3, "user"), admin = caller(1, "admin");
    const query = { page: 1, pageSize: 12 };
    assert.deepEqual((await a.rules.listPage(query)).items.map((r) => r.id), [1]);
    assert.deepEqual((await b.rules.listPage(query)).items.map((r) => r.id), [2]);
    assert.equal((await admin.rules.listPage(query)).totalItems, 0);
    assert.equal((await admin.rules.listPage({ ...query, scope: "all" })).totalItems, 2);
    await a.rules.update({ id: 1, name: "Updated A" });
    assert.equal((await a.rules.listPage(query)).items[0].name, "Updated A");
    assert.equal((await admin.rules.listPage({ ...query, scope: "all" })).items.find((r) => r.id === 1)?.name, "Updated A");
    assert.equal((await b.rules.listPage(query)).items[0].name, "User B rule");
    assert.equal((await a.hosts.statusSummary({ hostIds: [1] })).length, 1);
    assert.equal((await a.hosts.listPage(query)).items.length, 1);
    await a.hosts.trafficSummary({ hostIds: [1] });
    await b.hosts.trafficSummary({ hostIds: [1] });
    assert.equal((await b.hosts.summary()).totalHosts, 1);
    await (await import("./repositories/permissionRepository")).setUserHostPermissions(3, []);
    assert.equal((await b.hosts.summary()).totalHosts, 0, "cached summaries must recheck the current resource scope outside HTTP mutations");
    await (await import("./repositories/permissionRepository")).setUserHostPermissions(3, [1]);
    assert.equal((await b.hosts.summary()).totalHosts, 1);
    await admin.users.setHostPermissions({ userId: 2, hostIds: [] });
    assert.equal((await a.hosts.statusSummary({ hostIds: [1] })).length, 0);
    assert.equal((await a.hosts.listPage(query)).items.length, 0);
    assert.equal((await b.hosts.statusSummary({ hostIds: [1] })).length, 1);
    await assert.rejects(a.hosts.trafficSummary({ hostIds: [1] }), /无权访问/);
    await b.hosts.trafficSummary({ hostIds: [1] });
    // Existing rules stay editable/visible after their resource was revoked.
    assert.equal((await a.rules.listPage(query)).items[0].resourceAccessAllowed, false);
    await (await import("./repositories/forwardRuleRepository")).updateForwardRule(1, { name: "Background update" });
    assert.equal((await a.rules.listPage(query)).items[0].name, "Background update", "repository writes outside HTTP must invalidate display results");
    const ruleRepository = await import("./repositories/forwardRuleRepository");
    await ruleRepository.updateForwardRule(1, { protocol: "tcp", isEnabled: true, isRunning: true });
    assert.equal((await a.rules.listPage(query)).items[0].isRunning, true);
    await runtime.executeRaw("UPDATE hosts SET agentToken = 'display-cache-test-agent' WHERE id = 1");
    const statusApp = express();
    statusApp.use(express.json());
    statusApp.use((req, _res, next) => { (req as any).agentToken = "display-cache-test-agent"; next(); });
    (await import("./agentStatusRoutes")).registerAgentStatusRoutes(statusApp);
    statusServer = await new Promise<import("node:http").Server>((resolve) => {
      const server = statusApp.listen(0, "127.0.0.1", () => resolve(server));
    });
    const address = statusServer.address() as import("node:net").AddressInfo;
    const report = await fetch(`http://127.0.0.1:${address.port}/api/agent/rule-status`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ruleId: 1, sourcePort: 10001, protocol: "tcp", targetPort: 443, isRunning: false, message: "runtime process exited" }),
    });
    assert.equal(report.status, 200);
    assert.deepEqual(await report.json(), { success: true });
    assert.equal((await a.rules.listPage(query)).items[0].isRunning, false, "accepted Agent failures must immediately replace cached running state");
    await ruleRepository.markForwardRulesRunning([1]);
    assert.equal((await a.rules.listPage(query)).items[0].isRunning, true);
    await ruleRepository.markForwardRulesNotRunning([1]);
    assert.equal((await a.rules.listPage(query)).items[0].isRunning, false);
    assert.ok(displayQueries.stats().entries > 0);
    await runtime.closeDatabase();
    assert.equal(displayQueries.stats().entries, 0, "DB switching cannot reuse numeric IDs from the old DB");
  } finally {
    if (statusServer) await new Promise<void>((resolve, reject) => statusServer!.close(error => error ? reject(error) : resolve()));
    await runtime.closeDatabase();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
