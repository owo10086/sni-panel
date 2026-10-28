import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-support-pagination-"));
process.env.DATABASE_TYPE = "sqlite";
process.env.SQLITE_PATH = path.join(directory, "support.sqlite");
process.env.DATABASE_CONFIG_PATH = path.join(directory, "database.json");
process.env.FORWARDX_LOG_DIR = path.join(directory, "logs");
let runtime: typeof import("./dbRuntime");
let router: typeof import("./routers/supportTickets").supportTicketsRouter;
const admin = { id: 1, role: "admin" as const, username: "staff" };
const user = { id: 2, role: "user" as const, username: "customer" };
function caller(actor = admin as typeof admin | typeof user) {
  return router.createCaller({
    user: actor as any, req: { headers: {} } as any, res: {} as any,
    authSession: null, authFailureReason: null,
  });
}
const expectedIds = Array.from({ length: 137 }, (_, index) => 137 - index);

before(async () => {
  runtime = await import("./dbRuntime");
  await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.SQLITE_PATH! } });
  await (await import("./dbSchema")).ensureDatabaseSchema();
  router = (await import("./routers/supportTickets")).supportTicketsRouter;
  for (const actor of [admin, user])
    await runtime.insertAndGetId("users", { ...actor, password: "unused" });
  await caller().saveSettings({ enabled: true, notificationsEnabled: false });
  await runtime.withDatabaseTransaction(async () => {
    for (let id = 1; id <= 137; id++)
      await runtime.insertAndGetId("support_tickets", {
        id, userId: user.id, title: `Pagination ticket ${id}`,
        createdAt: 1800000000, updatedAt: 1800000000,
      });
  });
});
after(async () => {
  await runtime?.closeDatabase();
  fs.rmSync(directory, { recursive: true, force: true });
});

test("support list accepts 1..1000, keeps default 20 and returns complete ordered SQL pages", async () => {
  for (const actor of [admin, user]) {
    const api = caller(actor);
    const defaults = await api.list({ page: 1 });
    assert.equal(defaults.pageSize, 20);
    assert.deepEqual(defaults.items.map(ticket => ticket.id), expectedIds.slice(0, 20));
    for (const pageSize of [1, 20, 50, 1000]) {
      const seen: number[] = [];
      const lastPage = Math.ceil(137 / pageSize);
      for (let page = 1; page <= lastPage; page++) {
        const result = await api.list({ page, pageSize });
        assert.equal(result.pageSize, pageSize);
        assert.equal(result.total, 137);
        assert.deepEqual(result.items.map(ticket => ticket.id), expectedIds.slice((page - 1) * pageSize, page * pageSize));
        seen.push(...result.items.map(ticket => ticket.id));
      }
      assert.deepEqual(seen, expectedIds, "all pages contain every ticket once, including tied timestamps and a partial last page");
      const beyond = await api.list({ page: lastPage + 1, pageSize });
      assert.equal(beyond.total, 137);
      assert.equal(beyond.pageSize, pageSize);
      assert.deepEqual(beyond.items, [], "out-of-range requests keep the existing empty-page behavior");
      const empty = await api.list({ page: 2, pageSize, search: "no matching ticket" });
      assert.equal(empty.total, 0);
      assert.equal(empty.pageSize, pageSize);
      assert.deepEqual(empty.items, []);
    }
    for (const pageSize of [0, 1001])
      await assert.rejects(() => api.list({ page: 1, pageSize }), { code: "BAD_REQUEST" });
  }
});

test("bulk status retains the 50-ticket limit and rolls back the whole batch on a stale revision", async () => {
  const api = caller();
  const tickets = Array.from({ length: 51 }, (_, index) => ({ id: index + 1, version: 1 }));
  await assert.rejects(() => api.bulkStatus({ tickets, status: "resolved" }), { code: "BAD_REQUEST" });
  assert.equal((await api.list({ page: 1, status: "resolved" })).total, 0);
  await assert.rejects(() => api.bulkStatus({
    tickets: [...tickets.slice(0, 49), { id: 50, version: 2 }], status: "resolved",
  }), { code: "CONFLICT" });
  assert.equal((await api.list({ page: 1, status: "resolved" })).total, 0);
  await api.bulkStatus({ tickets: tickets.slice(0, 50), status: "resolved" });
  const resolved = await api.list({ page: 1, pageSize: 1000, status: "resolved" });
  assert.equal(resolved.total, 50);
  assert.deepEqual(resolved.items.map(ticket => ticket.id).sort((a, b) => a - b), tickets.slice(0, 50).map(ticket => ticket.id));
});
