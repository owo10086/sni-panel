import assert from "node:assert/strict";
import test from "node:test";
import * as billingTime from "@shared/billingTime";
import * as dndCore from "@dnd-kit/core";
import * as dndSortable from "@dnd-kit/sortable";
import { createPaginationHarness, findElements } from "@/test/paginationHarness";

type QueryInput = { page: number; pageSize: number };
type QueryState = { isLoading?: boolean; isPlaceholderData?: boolean; totalItems?: number };

function setup(surface: "users" | "plans", storage = new Map<string, string>()) {
  let tab = surface === "users" ? "accounts" : "plans";
  let planCount = 0;
  const requests: Array<{ procedure: string; input: QueryInput }> = [];
  const mutations: Array<{ procedure: string; input: any }> = [];
  const states = new Map<string, QueryState>();
  const cached = new Map<string, any>();
  const utils = new Proxy({}, { get: () => new Proxy({}, { get: () => ({ invalidate() {} }) }) });
  const trpc = new Proxy({}, { get: (_, resource) => resource === "useUtils" ? () => utils : new Proxy({}, {
    get: (_, procedure) => ({
      useQuery(input: QueryInput, options?: { enabled?: boolean }) {
        const name = `${String(resource)}.${String(procedure)}`;
        if (input?.pageSize && options?.enabled !== false) requests.push({ procedure: name, input });
        const state = states.get(name);
        const key = JSON.stringify([name, input, state, planCount]);
        if (!cached.has(key)) cached.set(key, input?.pageSize ? {
          items: name === "plans.listPage" ? Array.from({ length: Math.min(planCount, input.pageSize) }, (_, index) => ({
            id: (input.page - 1) * input.pageSize + index + 1, name: `Plan ${index + 1}`,
          })) : [{ id: 1, username: "alice", status: "active" }],
          totalItems: state?.totalItems ?? 2400,
        } : undefined);
        return { data: cached.get(key), isLoading: false, isPlaceholderData: false, ...state };
      },
      useMutation() {
        return { isPending: false, mutate: (input: any) => mutations.push({ procedure: `${String(resource)}.${String(procedure)}`, input }) };
      },
    }),
  }) });
  const mocks: Record<string, any> = {
    "@/lib/trpc": { trpc },
    "@/_core/hooks/useAuth": { useAuth: () => ({ user: { id: 1, role: "admin" } }) },
    "@/hooks/useUrlTab": { useUrlTab: () => [tab, (value: string) => { tab = value; }] },
    "wouter": { useLocation: () => ["/users", () => {}] },
    "@/lib/polling": { pollingInterval: () => false },
    "@/lib/localizedToast": { toast: { success() {}, error() {} } },
    "@shared/billingTime": billingTime,
    "@dnd-kit/core": { ...dndCore, useSensor: () => ({}), useSensors: () => [] },
    "@dnd-kit/sortable": dndSortable,
  };
  const harness = createPaginationHarness(storage, mocks);
  const sortingModule = harness.load("client/src/components/SortableDragHandle.tsx");
  mocks["@/components/SortableDragHandle"] = sortingModule;
  const Page = harness.load(`client/src/pages/${surface === "users" ? "Users" : "Plans"}.tsx`).default;
  const paginationModule = harness.load("client/src/components/PersistentPagination.tsx");
  let tree: any;
  const render = () => {
    tree = harness.render(() => {
      const page = Page();
      // Users wraps its content in DashboardLayout; execute that real content.
      const content = surface === "users" && findElements(page, (element) => typeof element.type === "function")[0];
      return content ? content.type(content.props) : page;
    });
    return tree;
  };
  const paginationElement = (index: number) => findElements(tree, (element) => element.type === paginationModule.PersistentPagination)[index];
  return {
    ...harness, requests, mutations, render,
    switchTab(value: string) { tab = value; render(); },
    setPlanCount(value: number) { planCount = value; render(); },
    setQueryState(procedure: string, state: QueryState) { states.set(procedure, state); },
    pagination(index = 0) { return paginationElement(index).props.pagination; },
    selectSize(size: number, index = 0) {
      const bar = paginationModule.PersistentPagination(paginationElement(index).props);
      const select = findElements(bar, (element) => element.type === "Select")[0];
      assert.ok(select, "the actual page-size selector must be present");
      select.props.onValueChange(String(size));
      render();
    },
    elements(predicate: (element: any) => boolean) { return findElements(tree, predicate); },
    lastRequest(procedure: string) { return requests.filter((request) => request.procedure === procedure).at(-1)!.input; },
    sortingModule,
  };
}

const lists = [
  { surface: "users", tab: "accounts", procedure: "users.listPage", key: "forwardx.users", index: 0 },
  { surface: "users", tab: "subscriptions", procedure: "plans.subscriptionsPage", key: "forwardx.users.subscriptions", index: 1 },
  { surface: "plans", tab: "plans", procedure: "plans.listPage", key: "forwardx.plans", index: 0 },
] as const;

for (const list of lists) test(`${list.tab} defaults to 20, sends the selected tRPC pageSize, resets atomically and restores after remount`, () => {
  const page = setup(list.surface);
  page.switchTab(list.tab);
  assert.equal(page.lastRequest(list.procedure).pageSize, 20);
  for (const size of [50, 200, 500, 1000, 100, 20]) {
    page.pagination(list.index).setPage(3); page.render();
    assert.equal(page.lastRequest(list.procedure).page, 3);
    const offset = page.requests.length;
    page.selectSize(size, list.index);
    const inputs = page.requests.slice(offset).filter((request) => request.procedure === list.procedure).map((request) => request.input);
    assert.ok(inputs.length > 0);
    assert.ok(inputs.every((input) => input.page === 1 && input.pageSize === size));
  }
  page.pagination(list.index).setPage(2); page.render();
  page.remount(); page.render();
  assert.equal(page.lastRequest(list.procedure).page, 2);
  assert.equal(page.lastRequest(list.procedure).pageSize, 20);
  assert.equal(page.storage.get(`${list.key}.pageSize`), "20");
});

for (const list of lists) for (const pending of ["isLoading", "isPlaceholderData"] as const) {
  test(`${list.tab} preserves restored page while ${pending} exposes a stale total`, () => {
    const page = setup(list.surface, new Map([[`${list.key}.page`, "4"], [`${list.key}.pageSize`, "100"]]));
    page.setQueryState(list.procedure, { [pending]: true, totalItems: 0 });
    page.switchTab(list.tab);
    assert.equal(page.lastRequest(list.procedure).page, 4);
    assert.equal(page.lastRequest(list.procedure).pageSize, 100);
    assert.equal(page.storage.get(`${list.key}.page`), "4");
    page.setQueryState(list.procedure, {}); page.render();
    assert.equal(page.lastRequest(list.procedure).page, 4);
    assert.equal(page.pagination(list.index).currentPage, 4);
  });
}

test("accounts, user subscriptions and plans keep independent pages and sizes across tabs and remounts", () => {
  const storage = new Map<string, string>();
  const users = setup("users", storage);
  const plans = setup("plans", storage);
  const sizes = [50, 200, 1000];
  const pages = [3, 4, 2];
  for (const [index, list] of lists.entries()) {
    const page = list.surface === "users" ? users : plans;
    page.switchTab(list.tab);
    page.selectSize(sizes[index], list.index);
    page.pagination(list.index).setPage(pages[index]); page.render();
  }
  users.remount(); plans.remount();
  for (const [index, list] of lists.entries()) {
    const page = list.surface === "users" ? users : plans;
    page.switchTab(list.tab);
    assert.equal(page.lastRequest(list.procedure).pageSize, sizes[index]);
    assert.equal(page.lastRequest(list.procedure).page, pages[index]);
    assert.equal(storage.get(`${list.key}.pageSize`), String(sizes[index]));
    assert.equal(storage.get(`${list.key}.page`), String(pages[index]));
  }
});

for (const view of ["card", "table"]) for (const count of [100, 101]) {
  test(`${view} view with ${count} plans ${count === 100 ? "sorts once with the page offset" : "disables dragging, shows the limit and never reorders"}`, () => {
    const page = setup("plans", new Map([["forwardx.plans.viewMode", view]]));
    page.setPlanCount(count);
    page.selectSize(200);
    page.pagination().setPage(3); page.render();
    const context = () => page.elements((element) => element.type === page.sortingModule.SortableReorderContext)[0];
    assert.equal(context().props.sortable.disabled, count > 100);
    const items = page.elements((element) => element.type === page.sortingModule.SortableItem);
    assert.equal(items.length, count);
    assert.ok(items.every((item) => item.props.disabled === (count > 100)));
    const notice = page.elements((element) => element.type === "p" && element.props.children === "当前页超过 100 个套餐，请切换到更小的每页条数后再排序");
    assert.equal(notice.length, count > 100 ? 1 : 0);
    context().props.sortable.handleDragStart({ active: { id: "401" } }); page.render();
    context().props.sortable.handleDragEnd({ active: { id: "401" }, over: { id: "402" } }); page.render();
    const mutations = page.mutations.filter((mutation) => mutation.procedure === "plans.reorder");
    assert.equal(mutations.length, count > 100 ? 0 : 1);
    if (count === 100) {
      assert.equal(mutations[0].input.startIndex, 400);
      assert.equal(mutations[0].input.ids.length, 100);
      assert.deepEqual(Array.from(mutations[0].input.ids.slice(0, 3)), [402, 401, 403]);
      assert.equal(new Set(mutations[0].input.ids).size, 100);
    }
  });
}
