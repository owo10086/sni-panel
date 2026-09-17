import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("forward-chain SNI rule creation is admin-only and prepares splitter metadata", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-sni-rule-router-"));
  const databasePath = path.join(directory, "sni-rule.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(moduleUrl("server/dbRuntime.ts"));
    const schema = await import(moduleUrl("server/dbSchema.ts"));
    const { rulesRouter } = await import(moduleUrl("server/routers/rules.ts"));
    const q = (name) => '"' + name + '"';
    const insert = async (table, columns, values) => {
      await runtime.executeRaw(
        "INSERT INTO " + q(table) + " (" + columns.map(q).join(", ") + ") VALUES (" + values.map(() => "?").join(", ") + ")",
        values,
      );
    };
    const callerContext = (user) => ({
      req: { headers: {} },
      res: { clearCookie() {} },
      user,
      authSession: null,
      authFailureReason: null,
    });
    const createInput = (overrides = {}) => ({
      forwardGroupId: 10,
      name: "sni-rule",
      forwardType: "nftables",
      protocol: "udp",
      sourcePort: 18443,
      targetIp: "203.0.113.20",
      targetPort: 443,
      sni: "Api.Example.COM.",
      isEnabled: true,
      ...overrides,
    });

    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      const now = Math.floor(Date.now() / 1000);
      await insert("users", ["id", "username", "password", "role", "canAddRules", "manualCanAddRules", "balanceCents"], [1, "admin", "x", "admin", 1, 1, 1000]);
      await insert("users", ["id", "username", "password", "role", "canAddRules", "manualCanAddRules", "balanceCents"], [2, "ordinary", "x", "user", 1, 1, 1000]);
      await insert("hosts", ["id", "name", "ip", "ipv4", "userId", "isOnline", "lastHeartbeat", "agentVersion", "portRangeStart", "portRangeEnd"], [1, "entry", "198.51.100.10", "198.51.100.10", 1, 1, now, "2.2.195", 18000, 19000]);
      await insert("hosts", ["id", "name", "ip", "ipv4", "userId", "isOnline", "lastHeartbeat", "agentVersion", "portRangeStart", "portRangeEnd"], [2, "exit", "198.51.100.20", "198.51.100.20", 1, 1, now, "2.2.195", 24000, 24010]);
      await insert("forward_groups", ["id", "name", "groupType", "groupMode", "forwardType", "domain", "targetIp", "targetPort", "userId", "isEnabled"], [10, "chain", "host", "chain", "nftables", "", "0.0.0.0", 1, 1, 1]);
      await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [101, 10, "host", 1, 10, 1]);
      await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [102, 10, "host", 2, 20, 1]);
      await insert("user_forward_group_permissions", ["userId", "forwardGroupId"], [2, 10]);

      const adminCaller = rulesRouter.createCaller(callerContext({ id: 1, username: "admin", role: "admin", accountEnabled: true }));
      const ordinaryCaller = rulesRouter.createCaller(callerContext({ id: 2, username: "ordinary", role: "user", accountEnabled: true }));

      await assert.rejects(
        () => ordinaryCaller.create(createInput({ name: "ordinary-sni", sourcePort: 18444, sni: "ordinary.example.com" })),
        /SNI 分流仅管理员可创建/,
      );

      const created = await adminCaller.create(createInput());
      assert.ok(Number(created.id) > 0);
      assert.equal(created.sourcePort, 18443);

      const rows = await runtime.queryRaw(
        'SELECT "id", "hostId", "forwardGroupRuleId", "isForwardGroupTemplate", "protocol", "sourcePort", "targetIp", "targetPort", "sni", "sniSplitterPort" FROM "forward_rules" WHERE "forwardGroupId" = ? ORDER BY "isForwardGroupTemplate" DESC, "id" ASC',
        [10],
      );
      assert.equal(rows.length, 3);
      for (const row of rows) {
        assert.equal(row.sni, "api.example.com");
        assert.equal(row.protocol, "tcp");
        assert.equal(row.sniSplitterPort, rows[0].sniSplitterPort);
      }
      const splitterPort = Number(rows[0].sniSplitterPort);
      assert.ok(splitterPort >= 24000 && splitterPort <= 24010, "splitter port escaped exit host range: " + splitterPort);
      assert.equal(rows[0].isForwardGroupTemplate, 1);
      assert.equal(rows[0].targetIp, "203.0.113.20");
      assert.equal(rows[0].targetPort, 443);

      await adminCaller.update({
        id: Number(created.id),
        protocol: "udp",
        sni: "Web.Example.COM.",
        targetPort: 8443,
      });
      const updatedRows = await runtime.queryRaw(
        'SELECT "id", "protocol", "sni", "sniSplitterPort", "targetIp", "targetPort" FROM "forward_rules" WHERE "forwardGroupRuleId" = ? OR "id" = ? ORDER BY "isForwardGroupTemplate" DESC, "id" ASC',
        [created.id, created.id],
      );
      assert.equal(updatedRows.length, 3);
      for (const row of updatedRows) {
        assert.equal(row.sni, "web.example.com");
        assert.equal(row.protocol, "tcp");
        assert.equal(Number(row.sniSplitterPort), splitterPort);
        if (row.targetIp === "203.0.113.20") {
          assert.equal(Number(row.targetPort), 8443);
        }
      }

      const plain = await adminCaller.create(createInput({ name: "plain-chain", sourcePort: 18445, protocol: "tcp", sni: null }));
      await runtime.executeRaw('UPDATE "forward_rules" SET "userId" = ? WHERE "id" = ?', [2, Number(plain.id)]);
      await assert.rejects(
        () => ordinaryCaller.update({ id: Number(plain.id), sni: "ordinary.example.com" }),
        /SNI 分流仅管理员可创建/,
      );

      const maxSni = ["a".repeat(63), "b".repeat(63), "c".repeat(63), "d".repeat(61)].join(".");
      assert.equal(maxSni.length, 253);
      const maxCreated = await adminCaller.create(createInput({
        name: "max-sni",
        sourcePort: 18446,
        sni: maxSni + ".",
      }));
      const maxRows = await runtime.queryRaw(
        'SELECT "sni" FROM "forward_rules" WHERE "id" = ?',
        [maxCreated.id],
      );
      assert.equal(maxRows[0].sni, maxSni);
    } finally {
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

test("SNI rule creation rejects ambiguous exit hosts and old exit agents", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-sni-rule-reject-"));
  const databasePath = path.join(directory, "sni-rule-reject.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(moduleUrl("server/dbRuntime.ts"));
    const schema = await import(moduleUrl("server/dbSchema.ts"));
    const { rulesRouter } = await import(moduleUrl("server/routers/rules.ts"));
    const q = (name) => '"' + name + '"';
    const insert = async (table, columns, values) => {
      await runtime.executeRaw(
        "INSERT INTO " + q(table) + " (" + columns.map(q).join(", ") + ") VALUES (" + values.map(() => "?").join(", ") + ")",
        values,
      );
    };
    const callerContext = (user) => ({
      req: { headers: {} },
      res: { clearCookie() {} },
      user,
      authSession: null,
      authFailureReason: null,
    });
    const createInput = (overrides = {}) => ({
      forwardGroupId: 20,
      name: "sni-rule",
      forwardType: "nftables",
      protocol: "tcp",
      sourcePort: 18443,
      targetIp: "203.0.113.20",
      targetPort: 443,
      sni: "api.example.com",
      isEnabled: true,
      ...overrides,
    });

    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      const now = Math.floor(Date.now() / 1000);
      await insert("users", ["id", "username", "password", "role", "canAddRules", "manualCanAddRules"], [1, "admin", "x", "admin", 1, 1]);
      await insert("hosts", ["id", "name", "ip", "ipv4", "userId", "isOnline", "lastHeartbeat", "agentVersion", "portRangeStart", "portRangeEnd"], [1, "entry", "198.51.100.10", "198.51.100.10", 1, 1, now, "2.2.195", 18000, 19000]);
      await insert("hosts", ["id", "name", "ip", "ipv4", "userId", "isOnline", "lastHeartbeat", "agentVersion", "portRangeStart", "portRangeEnd"], [2, "old-exit", "198.51.100.20", "198.51.100.20", 1, 1, now, "2.2.194", 24000, 24010]);
      await insert("hosts", ["id", "name", "ip", "ipv4", "userId", "isOnline", "lastHeartbeat", "agentVersion", "portRangeStart", "portRangeEnd"], [3, "other-exit", "198.51.100.30", "198.51.100.30", 1, 1, now, "2.2.195", 24020, 24030]);
      await insert("forward_groups", ["id", "name", "groupType", "groupMode", "forwardType", "domain", "targetIp", "targetPort", "userId", "isEnabled"], [20, "old-chain", "host", "chain", "nftables", "", "0.0.0.0", 1, 1, 1]);
      await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [201, 20, "host", 1, 10, 1]);
      await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [202, 20, "host", 2, 20, 1]);
      await insert("forward_groups", ["id", "name", "groupType", "groupMode", "forwardType", "domain", "targetIp", "targetPort", "userId", "isEnabled"], [30, "ambiguous", "host", "failover", "nftables", "", "0.0.0.0", 1, 1, 1]);
      await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [301, 30, "host", 2, 10, 1]);
      await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [302, 30, "host", 3, 20, 1]);

      const caller = rulesRouter.createCaller(callerContext({ id: 1, username: "admin", role: "admin", accountEnabled: true }));
      await assert.rejects(
        () => caller.create(createInput()),
        /出口 Agent 版本不足.*2\.2\.195/,
      );
      await runtime.executeRaw('UPDATE "hosts" SET "agentVersion" = ? WHERE "id" = ?', ["2.2.195", 2]);
      await runtime.executeRaw('UPDATE "hosts" SET "agentVersion" = ? WHERE "id" = ?', ["2.2.194", 1]);
      await assert.rejects(
        () => caller.create(createInput()),
        /入口 Agent.*entry.*2\.2\.195/,
      );
      await runtime.executeRaw('UPDATE "hosts" SET "agentVersion" = ? WHERE "id" = ?', ["2.2.195", 1]);
      const created = await caller.create(createInput({ isEnabled: false }));
      await runtime.executeRaw('UPDATE "hosts" SET "agentVersion" = ? WHERE "id" = ?', ["2.2.194", 1]);
      await assert.rejects(
        () => caller.update({ id: Number(created.id), name: "renamed-sni" }),
        /入口 Agent.*entry.*2\.2\.195/,
      );
      await assert.rejects(
        () => caller.toggle({ id: Number(created.id), isEnabled: true }),
        /入口 Agent.*entry.*2\.2\.195/,
      );
      await assert.rejects(
        () => caller.checkSniImport({
          forwardGroupId: 20,
          sourcePort: 18444,
          rules: [{ lineNumber: 1, sni: "import.example.com" }],
        }),
        /入口 Agent.*entry.*2\.2\.195/,
      );
      const liveCheck = await caller.checkSni({
        forwardGroupId: 20,
        sourcePort: 18444,
        sni: "live.example.com",
      });
      assert.equal(liveCheck.ok, false);
      assert.match(String(liveCheck.reason || ""), /入口 Agent.*entry.*2\.2\.195/);
      await assert.rejects(
        () => caller.create(createInput({ forwardGroupId: 30, sourcePort: 18444 })),
        /SNI 分流当前只支持单出口/,
      );
    } finally {
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

test("SNI splitter port belongs to the chain exit host for host port checks", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-sni-port-owner-"));
  const databasePath = path.join(directory, "sni-port-owner.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(moduleUrl("server/dbRuntime.ts"));
    const schema = await import(moduleUrl("server/dbSchema.ts"));
    const { rulesRouter } = await import(moduleUrl("server/routers/rules.ts"));
    const q = (name) => '"' + name + '"';
    const insert = async (table, columns, values) => {
      await runtime.executeRaw(
        "INSERT INTO " + q(table) + " (" + columns.map(q).join(", ") + ") VALUES (" + values.map(() => "?").join(", ") + ")",
        values,
      );
    };
    const callerContext = (user) => ({
      req: { headers: {} },
      res: { clearCookie() {} },
      user,
      authSession: null,
      authFailureReason: null,
    });

    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      const now = Math.floor(Date.now() / 1000);
      await insert("users", ["id", "username", "password", "role", "canAddRules", "manualCanAddRules", "balanceCents"], [1, "admin", "x", "admin", 1, 1, 1000]);
      await insert("hosts", ["id", "name", "ip", "ipv4", "userId", "isOnline", "lastHeartbeat", "agentVersion", "portRangeStart", "portRangeEnd"], [1, "entry", "198.51.100.10", "198.51.100.10", 1, 1, now, "2.2.195", 18000, 25000]);
      await insert("hosts", ["id", "name", "ip", "ipv4", "userId", "isOnline", "lastHeartbeat", "agentVersion", "portRangeStart", "portRangeEnd"], [2, "exit", "198.51.100.20", "198.51.100.20", 1, 1, now, "2.2.195", 24000, 24000]);
      await insert("forward_groups", ["id", "name", "groupType", "groupMode", "forwardType", "domain", "targetIp", "targetPort", "userId", "isEnabled"], [10, "chain", "host", "chain", "nftables", "", "0.0.0.0", 1, 1, 1]);
      await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [101, 10, "host", 1, 10, 1]);
      await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [102, 10, "host", 2, 20, 1]);

      const caller = rulesRouter.createCaller(callerContext({ id: 1, username: "admin", role: "admin", accountEnabled: true }));
      const created = await caller.create({
        forwardGroupId: 10,
        name: "sni-rule",
        forwardType: "nftables",
        protocol: "tcp",
        sourcePort: 18443,
        targetIp: "203.0.113.20",
        targetPort: 443,
        sni: "api.example.com",
        isEnabled: true,
      });
      const rows = await runtime.queryRaw(
        'SELECT "hostId", "isForwardGroupTemplate", "sourcePort", "sniSplitterPort" FROM "forward_rules" WHERE "forwardGroupRuleId" = ? OR "id" = ? ORDER BY "isForwardGroupTemplate" DESC, "id" ASC',
        [created.id, created.id],
      );
      assert.equal(rows.length, 3);
      const splitterPort = Number(rows[0].sniSplitterPort);
      assert.equal(splitterPort, 24000);
      const exitChild = rows.find((row) => Number(row.hostId) === 2 && Number(row.isForwardGroupTemplate) === 0);
      assert.ok(exitChild, "missing exit child rule");
      assert.equal(Number(exitChild.sourcePort), splitterPort);

      assert.deepEqual(
        await caller.checkPort({ hostId: 1, sourcePort: splitterPort, protocol: "tcp" }),
        { used: false },
      );
      assert.deepEqual(
        await caller.checkPort({ hostId: 2, sourcePort: splitterPort, protocol: "tcp" }),
        { used: true },
      );
    } finally {
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

test("SNI splitter port is reallocated when the stored port is occupied before re-enable", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-sni-port-reenable-"));
  const databasePath = path.join(directory, "sni-port-reenable.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(moduleUrl("server/dbRuntime.ts"));
    const schema = await import(moduleUrl("server/dbSchema.ts"));
    const { rulesRouter } = await import(moduleUrl("server/routers/rules.ts"));
    const q = (name) => '"' + name + '"';
    const insert = async (table, columns, values) => {
      await runtime.executeRaw(
        "INSERT INTO " + q(table) + " (" + columns.map(q).join(", ") + ") VALUES (" + values.map(() => "?").join(", ") + ")",
        values,
      );
    };
    const callerContext = (user) => ({
      req: { headers: {} },
      res: { clearCookie() {} },
      user,
      authSession: null,
      authFailureReason: null,
    });

    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      const now = Math.floor(Date.now() / 1000);
      await insert("users", ["id", "username", "password", "role", "canAddRules", "manualCanAddRules", "balanceCents"], [1, "admin", "x", "admin", 1, 1, 1000]);
      await insert("hosts", ["id", "name", "ip", "ipv4", "userId", "isOnline", "lastHeartbeat", "agentVersion", "portRangeStart", "portRangeEnd"], [1, "entry", "198.51.100.10", "198.51.100.10", 1, 1, now, "2.2.195", 18000, 19000]);
      await insert("hosts", ["id", "name", "ip", "ipv4", "userId", "isOnline", "lastHeartbeat", "agentVersion", "portRangeStart", "portRangeEnd"], [2, "exit", "198.51.100.20", "198.51.100.20", 1, 1, now, "2.2.195", 24000, 24010]);
      await insert("forward_groups", ["id", "name", "groupType", "groupMode", "forwardType", "domain", "targetIp", "targetPort", "userId", "isEnabled"], [10, "chain", "host", "chain", "nftables", "", "0.0.0.0", 1, 1, 1]);
      await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [101, 10, "host", 1, 10, 1]);
      await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [102, 10, "host", 2, 20, 1]);

      const caller = rulesRouter.createCaller(callerContext({ id: 1, username: "admin", role: "admin", accountEnabled: true }));
      const created = await caller.create({
        forwardGroupId: 10,
        name: "sni-rule",
        forwardType: "nftables",
        protocol: "tcp",
        sourcePort: 18443,
        targetIp: "203.0.113.20",
        targetPort: 443,
        sni: "api.example.com",
        isEnabled: true,
      });
      const beforeRows = await runtime.queryRaw(
        'SELECT "sniSplitterPort" FROM "forward_rules" WHERE "forwardGroupRuleId" = ? OR "id" = ? ORDER BY "isForwardGroupTemplate" DESC, "id" ASC',
        [created.id, created.id],
      );
      const oldSplitterPort = Number(beforeRows[0].sniSplitterPort);
      assert.ok(oldSplitterPort >= 24000 && oldSplitterPort <= 24010);

      await caller.toggle({ id: Number(created.id), isEnabled: false });
      await insert(
        "forward_rules",
        ["id", "hostId", "name", "forwardType", "protocol", "sourcePort", "targetIp", "targetPort", "isEnabled", "userId"],
        [900, 2, "port-owner", "nftables", "tcp", oldSplitterPort, "203.0.113.200", 443, 1, 1],
      );

      await caller.toggle({ id: Number(created.id), isEnabled: true });
      const afterRows = await runtime.queryRaw(
        'SELECT "protocol", "sni", "sniSplitterPort" FROM "forward_rules" WHERE "forwardGroupRuleId" = ? OR "id" = ? ORDER BY "isForwardGroupTemplate" DESC, "id" ASC',
        [created.id, created.id],
      );
      assert.equal(afterRows.length, 3);
      const newSplitterPort = Number(afterRows[0].sniSplitterPort);
      assert.notEqual(newSplitterPort, oldSplitterPort);
      assert.ok(newSplitterPort >= 24000 && newSplitterPort <= 24010);
      for (const row of afterRows) {
        assert.equal(row.protocol, "tcp");
        assert.equal(row.sni, "api.example.com");
        assert.equal(Number(row.sniSplitterPort), newSplitterPort);
      }
    } finally {
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

test("forward-chain SNI rules share one entry port and reject duplicate or mixed ports", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-sni-rule-sharing-"));
  const databasePath = path.join(directory, "sni-rule-sharing.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(moduleUrl("server/dbRuntime.ts"));
    const schema = await import(moduleUrl("server/dbSchema.ts"));
    const { rulesRouter } = await import(moduleUrl("server/routers/rules.ts"));
    const q = (name) => '"' + name + '"';
    const insert = async (table, columns, values) => {
      await runtime.executeRaw(
        "INSERT INTO " + q(table) + " (" + columns.map(q).join(", ") + ") VALUES (" + values.map(() => "?").join(", ") + ")",
        values,
      );
    };
    const callerContext = (user) => ({
      req: { headers: {} },
      res: { clearCookie() {} },
      user,
      authSession: null,
      authFailureReason: null,
    });
    const createInput = (overrides = {}) => ({
      forwardGroupId: 10,
      name: "sni-api",
      forwardType: "nftables",
      protocol: "udp",
      sourcePort: 18443,
      targetIp: "203.0.113.20",
      targetPort: 443,
      sni: "api.example.com",
      isEnabled: true,
      ...overrides,
    });

    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      const now = Math.floor(Date.now() / 1000);
      await insert("users", ["id", "username", "password", "role", "canAddRules", "manualCanAddRules", "balanceCents"], [1, "admin", "x", "admin", 1, 1, 1000]);
      await insert("hosts", ["id", "name", "ip", "ipv4", "userId", "isOnline", "lastHeartbeat", "agentVersion", "portRangeStart", "portRangeEnd"], [1, "entry", "198.51.100.10", "198.51.100.10", 1, 1, now, "2.2.195", 18443, 18444]);
      await insert("hosts", ["id", "name", "ip", "ipv4", "userId", "isOnline", "lastHeartbeat", "agentVersion", "portRangeStart", "portRangeEnd"], [2, "exit", "198.51.100.20", "198.51.100.20", 1, 1, now, "2.2.195", 24000, 24010]);
      await insert("hosts", ["id", "name", "ip", "ipv4", "userId", "isOnline", "lastHeartbeat", "agentVersion", "portRangeStart", "portRangeEnd"], [3, "middle", "198.51.100.30", "198.51.100.30", 1, 1, now, "2.2.195", 22000, 22010]);
      await insert("hosts", ["id", "name", "ip", "ipv4", "userId", "isOnline", "lastHeartbeat", "agentVersion", "portRangeStart", "portRangeEnd"], [4, "second-exit", "198.51.100.40", "198.51.100.40", 1, 1, now, "2.2.195", 24020, 24030]);
      await insert("forward_groups", ["id", "name", "groupType", "groupMode", "forwardType", "domain", "targetIp", "targetPort", "userId", "isEnabled"], [10, "chain", "host", "chain", "nftables", "", "0.0.0.0", 1, 1, 1]);
      await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [101, 10, "host", 1, 10, 1]);
      await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [102, 10, "host", 3, 20, 1]);
      await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [103, 10, "host", 2, 30, 1]);
      await insert("forward_groups", ["id", "name", "groupType", "groupMode", "forwardType", "domain", "targetIp", "targetPort", "userId", "isEnabled"], [12, "second-chain", "host", "chain", "nftables", "", "0.0.0.0", 1, 1, 1]);
      await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [121, 12, "host", 1, 10, 1]);
      await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [122, 12, "host", 4, 20, 1]);

      const caller = rulesRouter.createCaller(callerContext({ id: 1, username: "admin", role: "admin", accountEnabled: true }));
      const first = await caller.create(createInput({ name: "sni-api", sni: "Api.Example.COM." }));
      const second = await caller.create(createInput({
        name: "sni-web",
        sni: "web.example.com",
        targetIp: "203.0.113.21",
        targetPort: 8443,
      }));

      assert.equal(first.sourcePort, 18443);
      assert.equal(second.sourcePort, 18443);
      const sharedRows = await runtime.queryRaw(
        'SELECT "id", "hostId", "forwardGroupRuleId", "forwardGroupMemberId", "isForwardGroupTemplate", "sourcePort", "sni", "sniSplitterPort", "targetIp", "targetPort" FROM "forward_rules" WHERE "forwardGroupId" = ? ORDER BY "id"',
        [10],
      );
      assert.equal(sharedRows.length, 8);
      const splitterPorts = Array.from(new Set(sharedRows.map((row) => Number(row.sniSplitterPort))));
      assert.equal(splitterPorts.length, 1);
      assert.ok(splitterPorts[0] >= 24000 && splitterPorts[0] <= 24010);
      assert.equal(sharedRows.filter((row) => row.sni === "api.example.com").length, 4);
      assert.equal(sharedRows.filter((row) => row.sni === "web.example.com").length, 4);
      const entryChildren = sharedRows.filter((row) => Number(row.forwardGroupMemberId) === 101 && !Number(row.isForwardGroupTemplate));
      const middleChildren = sharedRows.filter((row) => Number(row.forwardGroupMemberId) === 102 && !Number(row.isForwardGroupTemplate));
      const exitChildren = sharedRows.filter((row) => Number(row.forwardGroupMemberId) === 103 && !Number(row.isForwardGroupTemplate));
      assert.equal(entryChildren.length, 2);
      assert.equal(middleChildren.length, 2);
      assert.equal(exitChildren.length, 2);
      assert.deepEqual(Array.from(new Set(entryChildren.map((row) => Number(row.sourcePort)))), [18443]);
      const middlePorts = Array.from(new Set(middleChildren.map((row) => Number(row.sourcePort))));
      assert.equal(middlePorts.length, 1);
      assert.ok(middlePorts[0] >= 22000 && middlePorts[0] <= 22010);
      assert.deepEqual(Array.from(new Set(entryChildren.map((row) => Number(row.targetPort)))), middlePorts);
      assert.deepEqual(Array.from(new Set(middleChildren.map((row) => Number(row.targetPort)))), [splitterPorts[0]]);
      assert.deepEqual(Array.from(new Set(exitChildren.map((row) => Number(row.sourcePort)))), [splitterPorts[0]]);

      await insert("forward_groups", ["id", "name", "groupType", "groupMode", "forwardType", "domain", "targetIp", "targetPort", "userId", "isEnabled"], [13, "relay-conflict-chain", "host", "chain", "nftables", "", "0.0.0.0", 1, 1, 1]);
      await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [131, 13, "host", 3, 10, 1]);
      await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [132, 13, "host", 1, 20, 1]);
      await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [133, 13, "host", 2, 30, 1]);
      await insert("forward_rules", ["id", "hostId", "name", "forwardType", "protocol", "forwardGroupId", "isForwardGroupTemplate", "sourcePort", "sni", "sniSplitterPort", "targetIp", "targetPort", "userId", "isEnabled", "pendingDelete"], [900, 3, "relay-conflict", "nftables", "tcp", 13, 1, 22000, "relay.example.com", 24009, "203.0.113.50", 443, 1, 1, 0]);
      await insert("forward_rules", ["id", "hostId", "name", "forwardType", "protocol", "forwardGroupId", "forwardGroupRuleId", "forwardGroupMemberId", "isForwardGroupTemplate", "sourcePort", "sni", "sniSplitterPort", "targetIp", "targetPort", "userId", "isEnabled", "pendingDelete"], [901, 1, "relay-conflict-middle", "nftables", "tcp", 13, 900, 132, 0, 18443, "relay.example.com", 24009, "198.51.100.20", 24009, 1, 1, 0]);
      const db = await import(moduleUrl("server/db.ts"));
      const entryPortState = await db.getForwardGroupSniEntryPortState({
        groupId: 12,
        sourcePort: 18443,
        entryHostIds: [1],
        sni: "edge.example.com",
      });
      const expectedShareableIds = sharedRows
        .filter((row) => Number(row.isForwardGroupTemplate) || Number(row.forwardGroupMemberId) === 101)
        .map((row) => Number(row.id))
        .sort((left, right) => left - right);
      assert.deepEqual(
        [...entryPortState.shareableRuleIds].sort((left, right) => left - right),
        expectedShareableIds,
      );
      assert.equal(entryPortState.shareableRuleIds.includes(901), false);
      assert.ok(entryPortState.otherGroupSniRule);
      assert.deepEqual(
        await caller.checkSni({ forwardGroupId: 12, sourcePort: 18443, sni: "relay.example.com" }),
        { ok: true, reason: null },
      );
      const duplicateEntryDomain = await caller.checkSni({
        forwardGroupId: 12,
        sourcePort: 18443,
        sni: "api.example.com",
      });
      assert.equal(duplicateEntryDomain.ok, false);
      assert.match(String(duplicateEntryDomain.reason || ""), /SNI 域名 api\.example\.com 与规则.*sni-api/);
      assert.deepEqual(
        await caller.checkPort({ forwardGroupId: 12, sourcePort: 18443, protocol: "tcp", forwardType: "nftables", sni: "edge.example.com" }),
        { used: true },
      );
      await db.repairConflictingProtocolPortRules();
      assert.equal((await caller.getById({ id: 901 })).isEnabled, false);
      assert.deepEqual(
        await caller.checkPort({ forwardGroupId: 12, sourcePort: 18443, protocol: "tcp", forwardType: "nftables", sni: "edge.example.com" }),
        { used: false },
      );
      const crossChain = await caller.create(createInput({
        forwardGroupId: 12,
        name: "sni-edge",
        sni: "edge.example.com",
        targetIp: "203.0.113.40",
        targetPort: 9443,
      }));
      assert.equal(crossChain.sourcePort, 18443);
      const crossChainRows = await runtime.queryRaw(
        'SELECT "hostId", "forwardGroupRuleId", "isForwardGroupTemplate", "sourcePort", "sni", "targetIp", "targetPort" FROM "forward_rules" WHERE "forwardGroupId" = ? ORDER BY "id"',
        [12],
      );
      assert.equal(crossChainRows.length, 3);
      assert.deepEqual(Array.from(new Set(crossChainRows.map((row) => row.sni))), ["edge.example.com"]);
      assert.equal(crossChainRows.filter((row) => !Number(row.isForwardGroupTemplate)).length, 2);
      const crossChainTemplate = crossChainRows.find((row) => Number(row.isForwardGroupTemplate));
      const crossChainExit = crossChainRows.find((row) => !Number(row.isForwardGroupTemplate) && Number(row.hostId) === 4);
      assert.equal(crossChainTemplate.targetIp, "203.0.113.40");
      assert.equal(Number(crossChainTemplate.targetPort), 9443);
      assert.equal(crossChainExit.targetIp, "203.0.113.40");
      assert.equal(Number(crossChainExit.targetPort), 9443);
      assert.equal(crossChainRows.find((row) => !Number(row.isForwardGroupTemplate) && Number(row.hostId) === 1).targetIp, "198.51.100.40");
      await db.repairConflictingProtocolPortRules();
      const entryRowsAfterRepair = await runtime.queryRaw(
        'SELECT "id" FROM "forward_rules" WHERE "hostId" = ? AND "sourcePort" = ? AND "isForwardGroupTemplate" = ? AND "isEnabled" = ? ORDER BY "id"',
        [1, 18443, 0, 1],
      );
      assert.equal(entryRowsAfterRepair.length, 3);
      for (const row of entryRowsAfterRepair) {
        assert.equal((await caller.getById({ id: Number(row.id) })).isEnabled, true);
      }

      await assert.rejects(
        () => caller.create(createInput({
          name: "duplicate-api",
          sni: "API.EXAMPLE.COM.",
          targetIp: "203.0.113.22",
        })),
        /SNI 域名 api\.example\.com 与规则.*sni-api.*冲突/,
      );
      await assert.rejects(
        () => caller.create(createInput({
          name: "duplicate-api-other-port",
          sourcePort: 18444,
          sni: "api.example.com",
          targetIp: "203.0.113.23",
        })),
        /SNI 域名 api\.example\.com 与规则.*sni-api.*冲突/,
      );
      await assert.rejects(
        () => caller.create(createInput({ name: "plain-on-sni-port", sni: null, protocol: "tcp" })),
        /入口端口 18443 已被 SNI 分流规则.*无法创建普通转发规则/,
      );

      const plain = await caller.create(createInput({
        name: "plain-chain",
        sourcePort: 18444,
        sni: null,
        protocol: "tcp",
        targetIp: "203.0.113.30",
      }));
      assert.equal(plain.sourcePort, 18444);
      await assert.rejects(
        () => caller.create(createInput({ name: "sni-on-plain-port", sourcePort: 18444, sni: "other.example.com" })),
        /入口端口 18444 已被普通转发规则.*无法创建 SNI 分流规则/,
      );
      await assert.rejects(
        () => caller.create(createInput({ name: "auto-plain", sourcePort: 0, sni: null, protocol: "tcp" })),
        /转发组入口端口区间内已无可用端口/,
      );
      await runtime.executeRaw('UPDATE "hosts" SET "portRangeEnd" = ? WHERE "id" = ?', [18445, 1]);
      await insert("forward_groups", ["id", "name", "groupType", "groupMode", "forwardType", "domain", "targetIp", "targetPort", "userId", "isEnabled"],
        [11, "gost-chain", "host", "chain", "gost", "", "0.0.0.0", 1, 1, 1]);
      for (const [memberId, hostId, priority] of [[111, 1, 10], [112, 3, 20], [113, 2, 30]]) {
        await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [memberId, 11, "host", hostId, priority, 1]);
      }
      const gostSni = { ...createInput({ forwardGroupId: 11, forwardType: "gost", sourcePort: 18445, name: "gost-first", sni: "first.example.com" }) };
      await caller.create(gostSni);
      const sharedPort = await caller.checkPort({ forwardGroupId: 11, sourcePort: 18445, protocol: "tcp", forwardType: "gost", sni: "next.example.com" });
      assert.deepEqual(sharedPort, { used: false });
      await caller.create({ ...gostSni, name: "gost-second", sni: "next.example.com" });
    } finally {
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

test("checkSni enforces domain-only validation, exclusions, and administrator access", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-sni-domain-check-"));
  const databasePath = path.join(directory, "sni-domain-check.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(moduleUrl("server/dbRuntime.ts"));
    const schema = await import(moduleUrl("server/dbSchema.ts"));
    const { rulesRouter } = await import(moduleUrl("server/routers/rules.ts"));
    const q = (name) => '"' + name + '"';
    const insert = async (table, columns, values) => {
      await runtime.executeRaw(
        "INSERT INTO " + q(table) + " (" + columns.map(q).join(", ") + ") VALUES (" + values.map(() => "?").join(", ") + ")",
        values,
      );
    };
    const callerContext = (user) => ({
      req: { headers: {} },
      res: { clearCookie() {} },
      user,
      authSession: null,
      authFailureReason: null,
    });
    const createInput = (overrides = {}) => ({
      forwardGroupId: 10,
      name: "rule",
      forwardType: "nftables",
      protocol: "tcp",
      sourcePort: 18443,
      targetIp: "203.0.113.20",
      targetPort: 443,
      isEnabled: true,
      ...overrides,
    });

    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      const now = Math.floor(Date.now() / 1000);
      await insert("users", ["id", "username", "password", "role", "canAddRules", "manualCanAddRules", "balanceCents"], [1, "admin", "x", "admin", 1, 1, 1000]);
      await insert("users", ["id", "username", "password", "role", "canAddRules", "manualCanAddRules", "balanceCents"], [2, "ordinary", "x", "user", 1, 1, 1000]);
      await insert("hosts", ["id", "name", "ip", "ipv4", "userId", "isOnline", "lastHeartbeat", "agentVersion", "portRangeStart", "portRangeEnd"], [1, "entry", "198.51.100.10", "198.51.100.10", 1, 1, now, "2.2.195", 18000, 19000]);
      await insert("hosts", ["id", "name", "ip", "ipv4", "userId", "isOnline", "lastHeartbeat", "agentVersion", "portRangeStart", "portRangeEnd"], [2, "exit", "198.51.100.20", "198.51.100.20", 1, 1, now, "2.2.195", 24000, 24010]);
      await insert("hosts", ["id", "name", "ip", "ipv4", "userId", "isOnline", "lastHeartbeat", "agentVersion", "portRangeStart", "portRangeEnd"], [3, "primary-entry", "198.51.100.30", "198.51.100.30", 1, 1, now, "2.2.195", 18000, 19000]);
      await insert("forward_groups", ["id", "name", "groupType", "groupMode", "forwardType", "domain", "targetIp", "targetPort", "userId", "isEnabled"], [10, "chain", "host", "chain", "nftables", "", "0.0.0.0", 1, 1, 1]);
      await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [101, 10, "host", 1, 10, 1]);
      await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [102, 10, "host", 2, 20, 1]);
      await insert("forward_groups", ["id", "name", "groupType", "groupMode", "forwardType", "domain", "targetIp", "targetPort", "userId", "isEnabled"], [20, "tunnel-entry", "host", "entry", "nftables", "", "0.0.0.0", 1, 1, 1]);
      await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [201, 20, "host", 1, 10, 1]);
      await insert("tunnels", ["id", "name", "entryGroupId", "entryHostId", "exitHostId", "mode", "listenPort", "userId", "isEnabled"], [30, "multi-entry", 20, 3, 2, "tls", 25000, 1, 1]);
      await insert("forward_rules", ["id", "hostId", "name", "forwardType", "protocol", "tunnelId", "sourcePort", "sni", "targetIp", "targetPort", "userId", "isEnabled", "pendingDelete"], [900, 3, "tunnel-sni", "gost", "tcp", 30, 18500, "shared.example.com", "203.0.113.90", 443, 1, 1, 0]);
      await insert("user_forward_group_permissions", ["userId", "forwardGroupId"], [2, 10]);

      const admin = rulesRouter.createCaller(callerContext({ id: 1, username: "admin", role: "admin", accountEnabled: true }));
      const ordinary = rulesRouter.createCaller(callerContext({ id: 2, username: "ordinary", role: "user", accountEnabled: true }));

      // 一条普通规则占住 18443。端口被占用是端口维度的事实，域名预检不应该报告它。
      await admin.create(createInput({ name: "plain", sourcePort: 18443 }));
      assert.deepEqual(
        await admin.checkSni({ forwardGroupId: 10, sourcePort: 18443, sni: "fresh.example.com" }),
        { ok: true, reason: null },
        "checkSni 把入口端口占用当成了域名冲突",
      );
      // 同一份占用在端口校验里必须照报不误。
      const portCheck = await admin.checkPort({ forwardGroupId: 10, sourcePort: 18443, protocol: "tcp", forwardType: "nftables", sni: "fresh.example.com" });
      assert.equal(portCheck.used, true);
      assert.match(String(portCheck.reason || ""), /已被普通转发规则/);

      const sniRule = await admin.create(createInput({ name: "sni", sourcePort: 18444, sni: "api.example.com" }));

      // 换端口也算重复：域名唯一性以入口主机为范围。
      const duplicate = await admin.checkSni({ forwardGroupId: 10, sourcePort: 18446, sni: "API.Example.COM." });
      assert.equal(duplicate.ok, false);
      assert.match(String(duplicate.reason || ""), /SNI 域名 api\.example\.com 与规则/);

      // 直接隧道的主入口是 3，但入口组还让主机 1 接收入站；转发链同样从主机 1 入站。
      // 两种资源在主机 1 上共享入口范围，因此相同域名仍然必须被识别。
      const crossResourceDuplicate = await admin.checkSni({ forwardGroupId: 10, sourcePort: 18447, sni: "shared.example.com" });
      assert.equal(crossResourceDuplicate.ok, false);
      assert.match(String(crossResourceDuplicate.reason || ""), /SNI 域名 shared\.example\.com 与规则.*tunnel-sni/);
      await assert.rejects(
        () => admin.create(createInput({ name: "cross-resource-duplicate", sourcePort: 18447, sni: "shared.example.com" })),
        /SNI 域名 shared\.example\.com 与规则.*tunnel-sni/,
      );

      // 编辑自己这条规则时不算与自己冲突。
      assert.deepEqual(
        await admin.checkSni({ forwardGroupId: 10, sourcePort: 18444, sni: "api.example.com", excludeRuleId: Number(sniRule.id) }),
        { ok: true, reason: null },
      );

      // 另一个域名在同一个分流端口上是允许的，这正是共用入口端口的用法。
      assert.deepEqual(
        await admin.checkSni({ forwardGroupId: 10, sourcePort: 18444, sni: "files.example.com" }),
        { ok: true, reason: null },
      );

      const forbidden = await ordinary.checkSni({ forwardGroupId: 10, sourcePort: 18444, sni: "files.example.com" });
      assert.equal(forbidden.ok, false);
      assert.match(String(forbidden.reason || ""), /仅管理员/);
    } finally {
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

test("SNI rule queries expose entry and exit runtime status and require both ends", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-sni-rule-runtime-"));
  const databasePath = path.join(directory, "sni-runtime.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(moduleUrl("server/dbRuntime.ts"));
    const schema = await import(moduleUrl("server/dbSchema.ts"));
    const { rulesRouter } = await import(moduleUrl("server/routers/rules.ts"));
    const { recordSniRuntimeSnapshot } = await import(moduleUrl("server/sniRuntimeObservability.ts"));
    const q = (name) => '"' + name + '"';
    const insert = async (table, columns, values) => {
      await runtime.executeRaw(
        "INSERT INTO " + q(table) + " (" + columns.map(q).join(", ") + ") VALUES (" + values.map(() => "?").join(", ") + ")",
        values,
      );
    };
    const callerContext = (user) => ({ req: { headers: {} }, res: { clearCookie() {} }, user,
      authSession: null, authFailureReason: null });

    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      const now = Math.floor(Date.now() / 1000);
      await insert("users", ["id", "username", "password", "role", "canAddRules", "manualCanAddRules"], [1, "admin", "x", "admin", 1, 1]);
      for (const [id, name, ip] of [[1, "entry", "198.51.100.10"], [2, "exit", "198.51.100.20"], [3, "second-entry", "198.51.100.30"]]) {
        await insert("hosts", ["id", "name", "ip", "ipv4", "userId", "isOnline", "lastHeartbeat", "agentVersion"], [id, name, ip, ip, 1, 1, now, "2.2.195"]);
      }
      await insert("forward_groups", ["id", "name", "groupType", "groupMode", "forwardType", "domain", "targetIp", "targetPort", "userId", "isEnabled"], [10, "chain", "host", "chain", "nftables", "", "0.0.0.0", 1, 1, 1]);
      await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [101, 10, "host", 1, 10, 1]);
      await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [102, 10, "host", 2, 20, 1]);
      await insert("forward_rules", ["id", "hostId", "name", "forwardType", "protocol", "forwardGroupId", "isForwardGroupTemplate", "sourcePort", "sni", "sniSplitterPort", "targetIp", "targetPort", "userId", "isEnabled"], [900, 1, "api", "nftables", "tcp", 10, 1, 18443, "api.example.com", 24000, "203.0.113.20", 443, 1, 1]);
      const caller = rulesRouter.createCaller(callerContext({ id: 1, username: "admin", role: "admin", accountEnabled: true }));

      recordSniRuntimeSnapshot(2, [{ port: 24000, ruleId: 900, sni: "api.example.com", sniRouteVersion: 7,
        sniUnmatchedConnections: 3, sniLastConfigError: "exit rejected update", ready: true }], 2000);
      const exitOnly = await caller.getById({ id: 900 });
      assert.equal(exitOnly.sniRuntime.applied, false);
      assert.equal(exitOnly.isRunning, false);
      assert.deepEqual(exitOnly.sniRuntime.entries, [{ hostId: 1, port: 18443, observed: false, applied: false,
        currentVersion: 0, unmatchedConnections: 0, lastConfigError: "", observedAt: 0 }]);
      assert.deepEqual(exitOnly.sniRuntime.exit, { hostId: 2, port: 24000, observed: true, applied: true,
        currentVersion: 7, unmatchedConnections: 3, lastConfigError: "exit rejected update", observedAt: 2000 });

      recordSniRuntimeSnapshot(1, [{ port: 18443, ruleId: 900, sni: "api.example.com", sniRouteVersion: 8,
        sniUnmatchedConnections: 11, ready: true }], 3000);
      const bothEnds = await caller.getById({ id: 900 });
      assert.equal(bothEnds.sniRuntime.applied, true);
      assert.equal(bothEnds.isRunning, true);
      assert.deepEqual(bothEnds.sniRuntime.entries, [{ hostId: 1, port: 18443, observed: true, applied: true,
        currentVersion: 8, unmatchedConnections: 11, lastConfigError: "", observedAt: 3000 }]);
      assert.equal((await caller.list({ scope: "all" }))[0].sniRuntime.applied, true);
      assert.equal((await caller.listPage({ scope: "all", category: "chain" })).items[0].sniRuntime.applied, true);
      assert.equal((await caller.mapItems({ scope: "all", category: "chain" })).items[0].sniRuntime.applied, true);
      await runtime.executeRaw('UPDATE "hosts" SET "agentVersion" = ? WHERE "id" = ?', ["2.2.194", 1]);
      const unsupportedEntryVersion = await caller.getById({ id: 900 });
      assert.equal(unsupportedEntryVersion.sniRuntime.applied, true);
      assert.equal(unsupportedEntryVersion.isRunning, false);
      await runtime.executeRaw('UPDATE "hosts" SET "agentVersion" = ? WHERE "id" = ?', ["2.2.195", 1]);
      await runtime.executeRaw('UPDATE "forward_rules" SET "isEnabled" = ? WHERE "id" = ?', [0, 900]);
      const disabledRule = await caller.getById({ id: 900 });
      assert.equal(disabledRule.sniRuntime.applied, true);
      assert.equal(disabledRule.isRunning, false);
      await runtime.executeRaw('UPDATE "forward_rules" SET "isEnabled" = ? WHERE "id" = ?', [1, 900]);
      await runtime.executeRaw('UPDATE "forward_rules" SET "pendingDelete" = ? WHERE "id" = ?', [1, 900]);
      const pendingRule = await caller.getById({ id: 900 });
      assert.equal(pendingRule.sniRuntime.applied, true);
      assert.equal(pendingRule.isRunning, false);
      await runtime.executeRaw('UPDATE "forward_rules" SET "pendingDelete" = ? WHERE "id" = ?', [0, 900]);
      await runtime.executeRaw('UPDATE "forward_groups" SET "isEnabled" = ? WHERE "id" = ?', [0, 10]);
      const disabledGroupRule = await caller.getById({ id: 900 });
      assert.equal(disabledGroupRule.sniRuntime.applied, true);
      assert.equal(disabledGroupRule.isRunning, false);
      await runtime.executeRaw('UPDATE "forward_groups" SET "isEnabled" = ? WHERE "id" = ?', [1, 10]);

      await insert("forward_groups", ["id", "name", "groupType", "groupMode", "domain", "targetIp", "userId", "isEnabled"], [20, "entry-group", "host", "entry", "", "0.0.0.0", 1, 1]);
      await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [201, 20, "host", 1, 10, 1]);
      await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [202, 20, "host", 3, 20, 1]);
      await runtime.executeRaw('UPDATE "forward_groups" SET "entryGroupId" = ? WHERE "id" = ?', [20, 10]);
      const missingEntry = await caller.getById({ id: 900 });
      assert.equal(missingEntry.sniRuntime.applied, false);
      assert.deepEqual(missingEntry.sniRuntime.entries.map((entry) => [entry.hostId, entry.applied]), [[1, true], [3, false]]);
      recordSniRuntimeSnapshot(3, [{ port: 18443, ruleId: 900, sni: "api.example.com", sniRouteVersion: 4, ready: true }], 4000);
      assert.equal((await caller.getById({ id: 900 })).sniRuntime.applied, true);
      recordSniRuntimeSnapshot(2, [], 5000);
      assert.equal((await caller.getById({ id: 900 })).sniRuntime.applied, false);

      await insert("tunnels", ["id", "name", "entryHostId", "exitHostId", "mode", "listenPort", "userId", "isEnabled"], [30, "sni-tunnel", 1, 2, "tls", 25001, 1, 1]);
      await insert("forward_rules", ["id", "hostId", "name", "forwardType", "protocol", "tunnelId", "sourcePort", "sni", "sniSplitterPort", "targetIp", "targetPort", "userId", "isEnabled"], [901, 1, "tunnel-api", "gost", "tcp", 30, 19443, "tunnel.example.com", 25000, "203.0.113.30", 443, 1, 1]);
      recordSniRuntimeSnapshot(2, [{ port: 25000, ruleId: 901, sni: "tunnel.example.com", sniRouteVersion: 9,
        sniUnmatchedConnections: 5, ready: true }], 6000);
      const tunnelRule = await caller.getById({ id: 901 });
      assert.equal(tunnelRule.sniRuntime.applied, true);
      assert.equal(tunnelRule.isRunning, true);
      assert.deepEqual(tunnelRule.sniRuntime.entries, []);
      assert.deepEqual(tunnelRule.sniRuntime.exit, { hostId: 2, port: 25000, observed: true, applied: true,
        currentVersion: 9, unmatchedConnections: 5, lastConfigError: "", observedAt: 6000 });
      await runtime.executeRaw('UPDATE "tunnels" SET "isEnabled" = ? WHERE "id" = ?', [0, 30]);
      const disabledTunnelRule = await caller.getById({ id: 901 });
      assert.equal(disabledTunnelRule.sniRuntime.applied, true);
      assert.equal(disabledTunnelRule.isRunning, false);

      await insert("forward_groups", ["id", "name", "groupType", "groupMode", "forwardType", "domain", "targetIp", "targetPort", "userId", "isEnabled"], [40, "sni-port", "host", "port", "nftables", "", "0.0.0.0", 1, 1, 1]);
      await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [401, 40, "host", 2, 10, 1]);
      await insert("forward_rules", ["id", "hostId", "name", "forwardType", "protocol", "forwardGroupId", "isForwardGroupTemplate", "sourcePort", "sni", "sniSplitterPort", "targetIp", "targetPort", "userId", "isEnabled"], [902, 2, "port-api", "nftables", "tcp", 40, 1, 26000, "port.example.com", 26000, "203.0.113.40", 443, 1, 1]);
      recordSniRuntimeSnapshot(2, [{ port: 26000, ruleId: 902, sni: "port.example.com", sniRouteVersion: 10,
        sniUnmatchedConnections: 7, ready: true }], 7000);
      const portRule = await caller.getById({ id: 902 });
      assert.equal(portRule.sniRuntime.applied, true);
      assert.equal(portRule.isRunning, true);
      assert.deepEqual(portRule.sniRuntime.entries, []);
      assert.equal(portRule.sniRuntime.exit.hostId, 2);
      await runtime.executeRaw('UPDATE "forward_groups" SET "isEnabled" = ? WHERE "id" = ?', [0, 40]);
      assert.equal((await caller.getById({ id: 902 })).isRunning, false);
    } finally {
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

test("SNI entry port overview reports routes, entry differences, and agent support", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-sni-entry-overview-"));
  const databasePath = path.join(directory, "sni-entry-overview.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(moduleUrl("server/dbRuntime.ts"));
    const schema = await import(moduleUrl("server/dbSchema.ts"));
    const { rulesRouter } = await import(moduleUrl("server/routers/rules.ts"));
    const q = (name) => '"' + name + '"';
    const insert = async (table, columns, values) => {
      await runtime.executeRaw(
        "INSERT INTO " + q(table) + " (" + columns.map(q).join(", ") + ") VALUES (" + values.map(() => "?").join(", ") + ")",
        values,
      );
    };
    const callerContext = (user) => ({ req: { headers: {} }, res: { clearCookie() {} }, user,
      authSession: null, authFailureReason: null });

    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      const now = Math.floor(Date.now() / 1000);
      await insert("users", ["id", "username", "password", "role", "canAddRules", "manualCanAddRules"], [1, "admin", "x", "admin", 1, 1]);
      await insert("users", ["id", "username", "password", "role", "canAddRules", "manualCanAddRules"], [2, "ordinary", "x", "user", 1, 1]);
      await insert("hosts", ["id", "name", "ip", "ipv4", "userId", "isOnline", "lastHeartbeat", "agentVersion"], [1, "entry-a", "198.51.100.10", "198.51.100.10", 1, 1, now, "2.2.195"]);
      await insert("hosts", ["id", "name", "ip", "ipv4", "userId", "isOnline", "lastHeartbeat", "agentVersion"], [2, "exit", "198.51.100.20", "198.51.100.20", 1, 1, now, "2.2.195"]);
      await insert("hosts", ["id", "name", "ip", "ipv4", "userId", "isOnline", "lastHeartbeat", "agentVersion"], [3, "entry-b-old", "198.51.100.30", "198.51.100.30", 1, 1, now, "2.2.194"]);
      await insert("hosts", ["id", "name", "ip", "ipv4", "userId", "isOnline", "lastHeartbeat", "agentVersion"], [4, "independent-entry", "198.51.100.40", "198.51.100.40", 1, 1, now, "2.2.195"]);
      await insert("forward_groups", ["id", "name", "groupType", "groupMode", "forwardType", "domain", "targetIp", "targetPort", "userId", "isEnabled"], [20, "entry-group", "host", "entry", "nftables", "", "0.0.0.0", 1, 1, 1]);
      await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [201, 20, "host", 1, 10, 1]);
      await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [202, 20, "host", 3, 20, 1]);
      await insert("forward_groups", ["id", "name", "groupType", "groupMode", "forwardType", "domain", "targetIp", "targetPort", "userId", "isEnabled"], [10, "shared-entry-chain", "host", "chain", "nftables", "", "0.0.0.0", 1, 1, 1]);
      await runtime.executeRaw('UPDATE "forward_groups" SET "entryGroupId" = ? WHERE "id" = ?', [20, 10]);
      await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [101, 10, "host", 2, 10, 1]);
      await insert("forward_groups", ["id", "name", "groupType", "groupMode", "forwardType", "domain", "targetIp", "targetPort", "userId", "isEnabled"], [11, "single-entry-chain", "host", "chain", "nftables", "", "0.0.0.0", 1, 1, 1]);
      await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [111, 11, "host", 1, 10, 1]);
      await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [112, 11, "host", 2, 20, 1]);
      await insert("forward_groups", ["id", "name", "groupType", "groupMode", "forwardType", "domain", "targetIp", "targetPort", "userId", "isEnabled"], [12, "independent-chain", "host", "chain", "nftables", "", "0.0.0.0", 1, 1, 1]);
      await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [121, 12, "host", 4, 10, 1]);
      await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [122, 12, "host", 2, 20, 1]);
      await insert("forward_rules", ["id", "hostId", "name", "forwardType", "protocol", "forwardGroupId", "isForwardGroupTemplate", "sourcePort", "sni", "sniSplitterPort", "targetIp", "targetPort", "userId", "isEnabled", "pendingDelete"], [900, 2, "shared-domain", "nftables", "tcp", 10, 1, 18443, "shared.example.com", 24000, "203.0.113.10", 443, 1, 1, 0]);
      await insert("forward_rules", ["id", "hostId", "name", "forwardType", "protocol", "forwardGroupId", "isForwardGroupTemplate", "sourcePort", "sni", "sniSplitterPort", "targetIp", "targetPort", "userId", "isEnabled", "pendingDelete"], [901, 1, "single-domain", "nftables", "tcp", 11, 1, 18443, "single.example.com", 24001, "target.example.net", 8443, 1, 1, 0]);
      await insert("forward_rules", ["id", "hostId", "name", "forwardType", "protocol", "forwardGroupId", "isForwardGroupTemplate", "sourcePort", "sni", "sniSplitterPort", "targetIp", "targetPort", "userId", "isEnabled", "pendingDelete"], [902, 1, "deleted-domain", "nftables", "tcp", 11, 1, 18443, "deleted.example.com", 24001, "203.0.113.99", 9443, 1, 0, 1]);
      await insert("forward_rules", ["id", "hostId", "name", "forwardType", "protocol", "forwardGroupId", "isForwardGroupTemplate", "sourcePort", "sni", "sniSplitterPort", "targetIp", "targetPort", "userId", "isEnabled", "pendingDelete"], [903, 4, "independent-domain", "nftables", "tcp", 12, 1, 18443, "independent.example.com", 24002, "203.0.113.40", 443, 1, 1, 0]);

      const admin = rulesRouter.createCaller(callerContext({ id: 1, username: "admin", role: "admin", accountEnabled: true }));
      const ordinary = rulesRouter.createCaller(callerContext({ id: 2, username: "ordinary", role: "user", accountEnabled: true }));
      await assert.rejects(() => ordinary.sniEntryPortOverview(), (error) => error.code === "FORBIDDEN");
      const overview = await admin.sniEntryPortOverview();
      assert.equal(overview.minimumAgentVersion, "2.2.195");
      assert.equal(overview.hasDomainDifferences, true);
      assert.equal(overview.unsupportedEntryHostCount, 1);
      assert.equal(overview.entries.length, 3);
      assert.deepEqual(overview.entries.map((entry) => [entry.entryHost.id, entry.sourcePort]), [[1, 18443], [3, 18443], [4, 18443]]);
      const first = overview.entries[0];
      assert.deepEqual(first.entryHost, { id: 1, name: "entry-a", agentVersion: "2.2.195", versionSupported: true });
      assert.equal(first.domainSetConsistent, false);
      assert.deepEqual(first.missingDomains, []);
      assert.deepEqual(first.routes, [
        { ruleId: 900, ruleName: "shared-domain", sni: "shared.example.com", isEnabled: true,
          forwardGroup: { id: 10, name: "shared-entry-chain" }, target: { address: "203.0.113.10", port: 443 } },
        { ruleId: 901, ruleName: "single-domain", sni: "single.example.com", isEnabled: true,
          forwardGroup: { id: 11, name: "single-entry-chain" }, target: { address: "target.example.net", port: 8443 } },
      ]);
      const second = overview.entries[1];
      assert.deepEqual(second.entryHost, { id: 3, name: "entry-b-old", agentVersion: "2.2.194", versionSupported: false });
      assert.equal(second.domainSetConsistent, false);
      assert.deepEqual(second.missingDomains, ["single.example.com"]);
      assert.deepEqual(second.routes.map((route) => route.sni), ["shared.example.com"]);
      const independent = overview.entries[2];
      assert.equal(independent.domainSetConsistent, true);
      assert.deepEqual(independent.missingDomains, []);
      assert.deepEqual(independent.routes.map((route) => route.sni), ["independent.example.com"]);
    } finally {
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
