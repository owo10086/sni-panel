import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { normalizePageRequest, PAGE_SIZE_OPTIONS } from "@shared/pagination";
import { pageSizeStorageKey, parsePageSize, readStoredPageSize, writeStoredPageSize } from "@/lib/pageSize";
import { queryInChunks } from "@/lib/batchOperations";
import { createPaginationHarness } from "@/test/paginationHarness";
import { PersistentPagination, type PersistentPaginationState } from "./PersistentPagination";

const state: PersistentPaginationState<never> = {
  currentPage: 1, totalPages: 1, totalItems: 50, pageSize: 100,
  startItem: 1, endItem: 50, items: [], setPage() {}, setPageSize() {}, nextPage() {}, previousPage() {},
};

test("page-size tiers fall back for missing, invalid and unsupported storage values", () => {
  assert.deepEqual(PAGE_SIZE_OPTIONS, [20, 50, 100, 200, 500, 1000]);
  for (const value of [null, undefined, "", "bad", "NaN", "Infinity", "-20", "0", "12", "24", "30", "1001", "20.5"]) {
    assert.equal(parsePageSize(value, 50), 50, String(value));
  }
  for (const value of PAGE_SIZE_OPTIONS) assert.equal(parsePageSize(String(value), 20), value);
  assert.equal(pageSizeStorageKey("forwardx.billing.ledger.page"), "forwardx.billing.ledger.pageSize");
  assert.equal(readStoredPageSize("unavailable.page", 50), 50);
  assert.doesNotThrow(() => writeStoredPageSize("unavailable.page", 100));
  assert.equal(normalizePageRequest({pageSize: 1001}).pageSize, 1000);
  assert.equal(normalizePageRequest({pageSize: 1}).pageSize, 1);
});

test("page-size state persists independently and legacy Rules never accesses its pageSize key", () => {
  const harness = createPaginationHarness(new Map([
    ["forwardx.rules.pageSize", "24"], ["forwardx.rules.page", "2"],
    ["billing.page", "3"], ["billing.pageSize", "50"],
  ]));
  const { usePersistentPageRequest, useServerPagination } = harness.load("client/src/components/PersistentPagination.tsx");
  let key = "forwardx.rules.page";
  let defaultSize: 20 | undefined;
  const render = () => harness.render(() => {
    const request = usePersistentPageRequest(key, defaultSize);
    return { request, pagination: useServerPagination([], 1000, request, {pageSize: 24}) };
  });
  let result = render();
  assert.equal(result.pagination.pageSize, 24);
  assert.equal(result.pagination.setPageSize, undefined);
  result.pagination.nextPage(); render();
  assert.equal(harness.storage.get("forwardx.rules.pageSize"), "24");
  assert.ok(!harness.reads.includes("forwardx.rules.pageSize"));
  assert.ok(!harness.writes.includes("forwardx.rules.pageSize"));
  key = "billing.page"; defaultSize = 20;
  result = render();
  assert.equal(result.request.page, 3);
  assert.equal(result.pagination.pageSize, 50);
  result.pagination.setPageSize(100); result = render();
  assert.equal(result.request.page, 1);
  assert.equal(result.pagination.pageSize, 100);
  result.pagination.setPage(4); render();
  harness.remount(); result = render();
  assert.equal(result.request.page, 4);
  assert.equal(result.request.pageSize, 100);
  assert.equal(harness.storage.get("billing.pageSize"), "100");
  assert.equal(harness.storage.get("forwardx.rules.page"), "3");
});

test("new pagination visibility uses 20 while fixed-size lists keep their original rule", () => {
  for (const totalItems of [0, 20]) assert.equal(renderToStaticMarkup(<PersistentPagination pagination={{...state, totalItems}} />), "");
  const html = renderToStaticMarkup(<PersistentPagination pagination={{...state, totalItems: 21}} />);
  assert.match(html, /共 21 条/);
  assert.match(html, /role="combobox"/);
  assert.match(html, /100 条\/页/);
  assert.match(html, /w-full justify-end sm:w-auto/);
  assert.equal(renderToStaticMarkup(<PersistentPagination pagination={{...state, setPageSize: undefined}} />), "");
  const legacy = renderToStaticMarkup(<PersistentPagination pagination={{...state, totalItems: 101, setPageSize: undefined}} />);
  assert.match(legacy, /共 101 条/);
  assert.doesNotMatch(legacy, /combobox/);
  for (const file of ["Hosts", "Tunnels", "Rules"]) {
    const source = readFileSync(`client/src/pages/${file}.tsx`, "utf8");
    assert.match(source, /limit: 100,/);
  }
  for (const file of ["Rules"]) {
    const source = readFileSync(`client/src/pages/${file}.tsx`, "utf8");
    assert.doesNotMatch(source, /usePersistentPageRequest\([^\n]+, (20|50)\)/);
  }
  assert.match(readFileSync("client/src/pages/Rules.tsx", "utf8"), /RULE_PAGE_SIZE_OPTIONS/);
});

test("chunk queries make one call at the cap, two one above, none for empty, and preserve every result", async () => {
  for (const length of [0, 100, 101, 1000]) {
    const ids = Array.from({length}, (_, i) => i + 1);
    const chunks: number[][] = [];
    const rows = await queryInChunks(ids, 100, async (chunk) => {
      chunks.push(chunk);
      return chunk.map((id) => ({id}));
    });
    assert.equal(chunks.length, Math.ceil(length / 100));
    assert.ok(chunks.every((chunk) => chunk.length <= 100));
    assert.deepEqual(rows.map((row) => row.id), ids);
    assert.equal(new Set(rows.map((row) => row.id)).size, length);
  }
  await assert.rejects(queryInChunks([1, 2], 1, async () => { throw new Error("query failed"); }), /query failed/);
});
