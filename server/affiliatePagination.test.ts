import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-affiliate-pagination-"));
process.env.DATABASE_TYPE = "sqlite";
process.env.SQLITE_PATH = path.join(directory, "db.sqlite");
process.env.DATABASE_CONFIG_PATH = path.join(directory, "database.json");
process.env.FORWARDX_LOG_DIR = path.join(directory, "logs");
let runtime: typeof import("./dbRuntime");
let router: typeof import("./routers/affiliates").affiliatesRouter;
const kinds = ["commissions", "withdrawals", "ledger", "referrals"] as const;
const expected = Array.from({ length: 137 }, (_, index) => 137 - index);

before(async () => {
  runtime = await import("./dbRuntime");
  await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.SQLITE_PATH! } });
  await (await import("./dbSchema")).ensureDatabaseSchema();
  router = (await import("./routers/affiliates")).affiliatesRouter;
  for (let id = 1; id <= 137; id++) {
    await runtime.insertAndGetId("users", { id, username: `pagination-${id}`, password: "unused", role: id === 1 ? "admin" : "user" });
    await runtime.insertAndGetId("affiliate_accounts", { id, userId: id });
  }
  for (const id of [...expected, 1001]) {
    const userId = id === 1001 ? 3 : 2;
    await runtime.insertAndGetId("affiliate_commissions", {
      id, userId, referredUserId: id, orderNo: `PAGE-${id}`, orderAmountCents: 100,
      amountCents: 15, rateBps: 1500, status: "available", confirmAt: 1,
    });
    await runtime.insertAndGetId("affiliate_withdrawals", {
      id, userId, amountCents: 15, method: "alipay", account: "test", payee: "test", requestKey: `PAGE-${id}`,
    });
    await runtime.insertAndGetId("affiliate_ledger", {
      id, userId, type: "commission", amountCents: 15, balanceAfterCents: 15, reference: `PAGE-${id}`,
    });
    await runtime.insertAndGetId("affiliate_referrals", { id, userId: id + 2000, affiliateUserId: userId, codeId: 1 });
  }
});

after(async () => {
  await runtime?.closeDatabase();
  fs.rmSync(directory, { recursive: true, force: true });
});

const caller = (id: number, role = "user") => router.createCaller({
  user: { id, role } as any, req: { headers: {}, socket: {} } as any, res: {} as any,
  authSession: null, authFailureReason: null,
});

test("affiliate list, adminList and adminOverview accept 1000, reject invalid sizes and default to 20", async () => {
  const user = caller(2);
  const admin = caller(1, "admin");
  for (const kind of kinds) {
    assert.equal((await user.list({ kind, pageSize: 1000 })).items.length, 137);
    assert.equal((await admin.adminList({ kind, pageSize: 1000 })).items.length, 138);
    assert.equal((await user.list({ kind })).items.length, 20);
    assert.equal((await admin.adminList({ kind })).items.length, 20);
    for (const pageSize of [0, 1.5, 1001]) {
      await assert.rejects(user.list({ kind, pageSize }), { code: "BAD_REQUEST" });
      await assert.rejects(admin.adminList({ kind, pageSize }), { code: "BAD_REQUEST" });
    }
  }
  assert.equal((await admin.adminOverview({ pageSize: 1000 })).accounts.length, 137);
  assert.equal((await admin.adminOverview({})).accounts.length, 20);
  for (const pageSize of [0, 1.5, 1001]) {
    await assert.rejects(admin.adminOverview({ pageSize }), { code: "BAD_REQUEST" });
  }
});

test("all affiliate record kinds paginate in stable order without gaps, preserve scope and return empty beyond the last page", async () => {
  const user = caller(2);
  const admin = caller(1, "admin");
  for (const kind of kinds) {
    for (const [list, ids] of [
      [(input: { page: number; pageSize: number }) => user.list({ ...input, kind, userId: 3 }), expected],
      [(input: { page: number; pageSize: number }) => admin.adminList({ ...input, kind }), [1001, ...expected]],
      [(input: { page: number; pageSize: number }) => admin.adminList({ ...input, kind, userId: 2 }), expected],
    ] as const) {
      for (const pageSize of [7, 20, 50]) {
        const seen: number[] = [];
        const totalPages = Math.ceil(ids.length / pageSize);
        for (let page = 1; page <= totalPages; page++) {
          const result = await list({ page, pageSize });
          assert.equal(result.total, ids.length);
          assert.deepEqual(result.items.map(row => row.id), ids.slice((page - 1) * pageSize, page * pageSize));
          seen.push(...result.items.map(row => row.id));
        }
        assert.deepEqual(seen, ids, `${kind}, size ${pageSize}: no duplicates or omissions`);
        assert.deepEqual(await list({ page: totalPages + 1, pageSize }), { items: [], total: ids.length });
      }
    }
    assert.equal((await user.list({ kind, pageSize: 1 })).items.length, 1);
    assert.deepEqual(await caller(4).list({ kind, page: 9, pageSize: 50 }), { items: [], total: 0 });
  }
  assert.deepEqual(await admin.adminList({ kind: "commissions", status: "rejected", pageSize: 50 }), { items: [], total: 0 });
  assert.deepEqual(await admin.adminList({ kind: "withdrawals", status: "paid", pageSize: 50 }), { items: [], total: 0 });
});

test("affiliate account overview paginates and searches without changing empty or out-of-range behavior", async () => {
  const admin = caller(1, "admin");
  for (const pageSize of [7, 20, 50]) {
    const seen: number[] = [];
    const totalPages = Math.ceil(expected.length / pageSize);
    for (let page = 1; page <= totalPages; page++) {
      const result = await admin.adminOverview({ page, pageSize });
      assert.equal(result.total, 137);
      assert.deepEqual(result.accounts.map(row => row.userId), expected.slice((page - 1) * pageSize, page * pageSize));
      seen.push(...result.accounts.map(row => row.userId));
    }
    assert.deepEqual(seen, expected);
    const beyond = await admin.adminOverview({ page: totalPages + 1, pageSize });
    assert.equal(beyond.total, 137);
    assert.deepEqual(beyond.accounts, []);
  }
  const match = await admin.adminOverview({ search: "pagination-137", pageSize: 1 });
  assert.equal(match.total, 1);
  assert.deepEqual(match.accounts.map(row => row.userId), [137]);
  for (const page of [1, 9]) {
    const empty = await admin.adminOverview({ search: "no-match", page, pageSize: 50 });
    assert.equal(empty.total, 0);
    assert.deepEqual(empty.accounts, []);
  }
});
