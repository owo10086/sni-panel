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
      await insert("forward_groups", ["id", "name", "groupType", "groupMode", "forwardType", "domain", "targetIp", "targetPort", "userId", "isEnabled"], [10, "chain", "host", "chain", "nftables", "", "0.0.0.0", 1, 1, 1]);
      await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [101, 10, "host", 1, 10, 1]);
      await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [102, 10, "host", 3, 20, 1]);
      await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [103, 10, "host", 2, 30, 1]);

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
