import assert from "node:assert/strict";
import test from "node:test";
import { overviewKey, recordKey, recordKinds, setupAffiliatePage } from "@/test/affiliatePaginationHarness";

test("all affiliate record kinds send selected sizes, reset atomically, restore and isolate user/admin views", () => {
  const storage = new Map<string, string>();
  for (const admin of [false, true]) {
    const page = setupAffiliatePage(admin, storage);
    page.render();
    for (const [index, kind] of recordKinds.entries()) {
      page.switchKind(kind);
      assert.equal(page.lastRequest().pageSize, 20);
      page.pagination().setPage(2); page.render();
      const offset = page.requests.length;
      const size = [50, 100, 200, 500][index];
      page.selectSize(size);
      const requests = page.requests.slice(offset).filter(request => request.procedure === (admin ? "adminList" : "list"));
      assert.ok(requests.length);
      assert.ok(requests.every(({ input }) => input.page === 1 && input.pageSize === size));
      page.pagination().setPage(admin ? 4 : 3); page.render();
    }
    page.remount();
    for (const [index, kind] of recordKinds.entries()) {
      page.switchKind(kind);
      assert.equal(page.lastRequest().page, admin ? 4 : 3);
      assert.equal(page.lastRequest().pageSize, [50, 100, 200, 500][index]);
    }
  }
  const user = setupAffiliatePage(false, storage);
  user.render();
  assert.equal(user.lastRequest().page, 3);
  assert.equal(storage.get(recordKey(true, "commissions")), "4");
  assert.equal(storage.get(recordKey(false, "commissions")), "3");
});

test("switching record kinds waits for current data before correcting restored page 8 and never overwrites the source", () => {
  for (const admin of [false, true]) {
    for (const flags of [
      { isLoading: true, isPlaceholderData: false },
      { isLoading: false, isPlaceholderData: true },
    ]) {
      const sourceKey = recordKey(admin, "commissions");
      const targetKey = recordKey(admin, "withdrawals");
      const storage = new Map([[sourceKey, "2"], [sourceKey.replace(/\.page$/, ".pageSize"), "20"],
        [targetKey, "8"], [targetKey.replace(/\.page$/, ".pageSize"), "100"]]);
      const page = setupAffiliatePage(admin, storage);
      page.setTotal(21);
      page.setPending({ procedure: admin ? "adminList" : "list", kind: "withdrawals", ...flags, data: { items: [], total: 21 } });
      const offset = page.requests.length;
      page.switchKind("withdrawals");
      const requests = page.requests.slice(offset).filter(request => request.input.kind === "withdrawals");
      assert.ok(requests.length);
      assert.ok(requests.every(({ input }) => input.page === 8 && input.pageSize === 100));
      assert.equal(storage.get(targetKey), "8");
      assert.equal(storage.get(sourceKey), "2");
      page.setPending(undefined); page.setTotal(2400);
      assert.equal(page.lastRequest().page, 8);
      page.switchKind("commissions");
      assert.equal(page.lastRequest().page, 2);
      assert.equal(page.lastRequest().pageSize, 20);
      assert.equal(storage.get(targetKey), "8");
    }
  }
});

test("admin overview restores on mount and after debounce, resets only changed search, and isolates its selected size", () => {
  const storage = new Map([[overviewKey, "4"], [overviewKey.replace(/\.page$/, ".pageSize"), "100"]]);
  const page = setupAffiliatePage(true, storage);
  page.render();
  assert.equal(page.lastRequest("adminOverview").page, 4);
  assert.equal(page.lastRequest("adminOverview").pageSize, 100);
  page.flushTimers();
  assert.equal(page.lastRequest("adminOverview").page, 4);
  page.selectSize(500, "overview");
  assert.equal(page.lastRequest("adminOverview").page, 1);
  assert.equal(page.lastRequest("adminOverview").pageSize, 500);
  assert.equal(page.lastRequest().pageSize, 20);
  page.pagination("overview").setPage(3); page.render();
  page.remount(); page.flushTimers();
  assert.equal(page.lastRequest("adminOverview").page, 3);
  assert.equal(page.lastRequest("adminOverview").pageSize, 500);
  const search = page.elements(element => element.type === "Input" && element.props.maxLength === 100)[0];
  search.props.onChange({ target: { value: "alice" } }); page.render();
  assert.equal(page.lastRequest("adminOverview").page, 3, "retain current search page until debounce fires");
  const offset = page.requests.length;
  page.flushTimers();
  const inputs = page.requests.slice(offset).filter(request => request.procedure === "adminOverview").map(request => request.input);
  assert.ok(inputs.length);
  assert.ok(inputs.every(input => input.page === 1 && input.pageSize === 500 && input.search === "alice"));
});
