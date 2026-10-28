import assert from "node:assert/strict";
import test from "node:test";
import * as forwardTypes from "@shared/forwardTypes";
import * as forwardGroup from "@shared/forwardGroup";
import * as exitStrategy from "@shared/exitStrategy";
import * as trafficMultiplier from "@shared/trafficMultiplier";
import * as tunnelRelay from "@shared/tunnelRelay";
import * as linkAvailability from "@/lib/linkAvailability";
import * as tunnelDisplay from "@/lib/tunnelDisplay";
import * as polling from "@/lib/polling";
import * as segmented from "@/components/ui/segmented";
import { createPaginationHarness, findElements } from "@/test/paginationHarness";

type GroupMode = "port" | "failover" | "chain" | "entry" | "exit";
type PageInput = { page: number; pageSize: number; groupMode?: GroupMode; search?: string };

function setup(kind: "tunnels" | "groups", storage = new Map<string, string>()) {
  let mode: GroupMode = "port";
  let section = "tunnels";
  let searchQuery = "";
  let groupProps: Record<string, any> = {};
  let listState: "ready" | "loading" | "placeholder" = "ready";
  let fullGroups: any[] = [];
  const requests: Array<{ procedure: string; input: PageInput }> = [];
  const mutations: Array<{ procedure: string; input: any }> = [];
  const cache = new Map<string, any>();
  const react: Record<string, any> = {};
  const utils = new Proxy({}, { get: () => new Proxy({}, { get: () => ({ invalidate() {} }) }) });
  const trpc = new Proxy({}, { get: (_, resource) => resource === "useUtils" ? () => utils : new Proxy({}, {
    get: (_, procedure) => ({
      useQuery(input: PageInput, options?: { enabled?: boolean }) {
        const name = `${String(resource)}.${String(procedure)}`;
        if (input?.pageSize && options?.enabled !== false) requests.push({ procedure: name, input });
        const key = JSON.stringify([name, input]);
        if (!cache.has(key)) cache.set(key, input?.pageSize ? {
          items: Array.from({ length: input.pageSize }, (_, index) => ({
            id: (input.page - 1) * input.pageSize + index + 1,
            name: `Resource ${index + 1}`, groupMode: input.groupMode, members: [], mode: "forwardx",
          })),
          totalItems: 2400, scopeTotalItems: 2400, enabledItems: 1300, availableItems: 1300,
        } : name === "system.getSettings" || name === "tunnels.sectionCounts" ? {} : []);
        const pending = procedure === "listPage" && input.pageSize > 1 && listState !== "ready";
        return {
          data: pending ? { items: [], totalItems: 0 }
            : name === "forwardGroups.options" ? fullGroups : cache.get(key),
          isLoading: pending && listState === "loading",
          isPlaceholderData: pending && listState === "placeholder",
        };
      },
      useInfiniteQuery() { return { data: undefined, isLoading: false, hasNextPage: false }; },
      useMutation() {
        return { isPending: false, mutate: (input: any) => mutations.push({ procedure: `${String(resource)}.${String(procedure)}`, input }) };
      },
    }),
  }) });
  const mocks: Record<string, any> = {
    react,
    "@/lib/trpc": { trpc },
    "@shared/forwardTypes": forwardTypes,
    "@shared/forwardGroup": forwardGroup,
    "@shared/exitStrategy": exitStrategy,
    "@shared/trafficMultiplier": trafficMultiplier,
    "@shared/tunnelRelay": tunnelRelay,
    "@/lib/linkAvailability": linkAvailability,
    "@/lib/tunnelDisplay": tunnelDisplay,
    "@/lib/polling": polling,
    "@/components/ui/segmented": segmented,
    "@/hooks/useUrlTab": { useUrlTab: () => [section, (value: string) => { section = value; }] },
    "@/_core/hooks/useAuth": { useAuth: () => ({ user: { role: "admin" }, loading: false }) },
    "@/lib/localizedToast": { toast: { success() {}, error() {} } },
    "@dnd-kit/core": { MeasuringStrategy: { Always: "always" }, useSensor: () => ({}), useSensors: () => [] },
    "@dnd-kit/sortable": { arrayMove: (items: any[], from: number, to: number) => {
      const next = [...items]; next.splice(to, 0, next.splice(from, 1)[0]); return next;
    } },
  };
  const harness = createPaginationHarness(storage, mocks, { setTimeout: () => 0, clearTimeout() {} });
  Object.assign(react, harness.hooks, { lazy: () => "ReactGlobe", Suspense: "Suspense" });
  // Exercise the real sorting hooks; only the DOM sensors are replaced.
  mocks["@/components/SortableDragHandle"] = harness.load("client/src/components/SortableDragHandle.tsx");
  const component = kind === "groups"
    ? harness.load("client/src/pages/ForwardGroups.tsx").ForwardGroupsContent
    : harness.load("client/src/pages/Tunnels.tsx").default().props.children.type;
  const paginationModule = harness.load("client/src/components/PersistentPagination.tsx");
  let tree: any;
  const render = () => { tree = harness.render(() => component(kind === "groups" ? { mode, searchQuery, ...groupProps } : undefined)); return tree; };
  const paginationElement = () => findElements(tree, (element) => element.type === paginationModule.PersistentPagination)[0];
  return {
    ...harness, requests, mutations, render,
    switchMode(value: GroupMode) { mode = value; render(); },
    setSearch(value: string) { searchQuery = value; render(); },
    setProps(value: Record<string, any>) { groupProps = value; render(); },
    setGroups(value: any[]) { fullGroups = value; },
    switchSection(value: string) { section = value; render(); },
    elements(predicate: (element: any) => boolean) { return findElements(tree, predicate); },
    sortable() { return findElements(tree, (element) => !!element.props.sortable)[0].props.sortable; },
    setListState(value: typeof listState) { listState = value; },
    pagination() { return paginationElement().props.pagination; },
    selectSize(size: number) {
      const bar = paginationModule.PersistentPagination(paginationElement().props);
      const select = findElements(bar, (element) => element.type === "Select")[0];
      assert.ok(select, "the real pagination selector is available");
      select.props.onValueChange(String(size)); render();
    },
    lastRequest() { return requests.filter((request) => request.procedure === (kind === "groups" ? "forwardGroups.listPage" : "tunnels.listPage")).at(-1)!.input; },
  };
}

test("tunnel list sends the selected size, resets to page 1 and restores after remount", () => {
  const page = setup("tunnels");
  page.render();
  assert.equal(page.lastRequest().pageSize, 20);
  page.pagination().setPage(3); page.render();
  assert.equal(page.lastRequest().page, 3);
  const offset = page.requests.length;
  page.selectSize(1000);
  assert.ok(page.requests.slice(offset).every(({ input }) => input.page === 1 && input.pageSize === 1000));
  page.pagination().setPage(2); page.render();
  page.remount(); page.render();
  assert.equal(page.lastRequest().page, 2);
  assert.equal(page.lastRequest().pageSize, 1000);
});

test("embedded group lists use their saved sizes while section summaries stay at pageSize 1 and retain totals", () => {
  const cases = [
    { section: "ports", mode: "port", size: 50, stat: "portsActive" },
    { section: "groups", mode: "failover", size: 100, stat: "forwardGroupsActive" },
    { section: "chains", mode: "chain", size: 200, stat: "chainsActive" },
    { section: "entries", mode: "entry", size: 500, stat: "entryGroupsActive" },
    { section: "exits", mode: "exit", size: 1000, stat: "exitGroupsActive" },
  ] as const;
  const storage = new Map<string, string>();
  for (const { mode, size } of cases) {
    storage.set(`forwardx.forwardGroups.${mode}.page`, "2");
    storage.set(`forwardx.forwardGroups.${mode}.pageSize`, String(size));
  }
  const parent = setup("tunnels", storage);
  for (const { section, mode, size, stat } of cases) {
    parent.switchSection(section);
    const summary = parent.requests.at(-1)!;
    assert.equal(summary.procedure, "forwardGroups.listPage");
    assert.deepEqual({ ...summary.input }, { page: 1, pageSize: 1, groupMode: mode, search: "" });
    const header = parent.elements((element) => element.props.cacheKey === `tunnels.header.${stat}`)[0];
    assert.equal(header.props.value, "1300 / 2400 已启用");
    const embedded = parent.elements((element) => element.type === "ForwardGroupsContent" && element.props.mode === mode)[0];
    const child = setup("groups", storage);
    child.setProps(embedded.props);
    assert.equal(child.lastRequest().pageSize, size);
    assert.equal(child.lastRequest().page, 2);
  }
});

test("dragging within page 2 of 1000 items submits every current-page ID with offset 1000", () => {
  for (const mode of ["tunnels", "port", "failover", "chain", "entry", "exit"] as const) {
    const page = setup(mode === "tunnels" ? "tunnels" : "groups");
    if (mode === "tunnels") page.render(); else page.switchMode(mode);
    page.selectSize(1000);
    page.pagination().setPage(2); page.render();
    assert.equal(page.sortable().disabled, false, mode);
    page.sortable().handleDragStart({ active: { id: "1001" } }); page.render();
    page.sortable().handleDragEnd({ active: { id: "1001" }, over: { id: "2000" } }); page.render();
    assert.equal(page.mutations.length, 1, mode);
    const mutation = page.mutations[0];
    assert.equal(mutation.procedure, mode === "tunnels" ? "tunnels.reorder" : "forwardGroups.reorderGroups");
    assert.equal(mutation.input.startIndex, 1000, mode);
    assert.equal(mutation.input.ids.length, 1000);
    assert.equal(new Set(mutation.input.ids).size, 1000);
    assert.equal(mutation.input.ids[0], 1002);
    assert.equal(mutation.input.ids[998], 2000);
    assert.equal(mutation.input.ids[999], 1001);
    if (mode !== "tunnels") assert.equal(mutation.input.groupMode, mode);
    assert.equal(page.pagination().items[0].id, 1002, "optimistic order is visible");
  }
});

test("the globe's hidden chain editor sends no list page queries and never rewrites chain pagination", () => {
  const storage = new Map([
    ["forwardx.forwardGroups.viewMode", "globe"],
    ["forwardx.forwardGroups.chain.page", "5"], ["forwardx.forwardGroups.chain.pageSize", "1000"],
  ]);
  const parent = setup("tunnels", storage);
  parent.switchSection("chains");
  const hidden = parent.elements((element) => element.type === "div" && element.props["aria-hidden"])[0];
  assert.ok(hidden, "globe keeps its edit dialog component mounted");
  const editor = setup("groups", storage);
  editor.setProps(hidden.props.children.props);
  assert.equal(editor.requests.length, 0, "hidden editor does not fetch a list page");
  editor.setProps({ ...hidden.props.children.props, searchQuery: "changed on globe" });
  assert.equal(editor.requests.length, 0);
  assert.equal(editor.writes.length, 0);
  assert.equal(storage.get("forwardx.forwardGroups.chain.page"), "5");
  assert.equal(storage.get("forwardx.forwardGroups.chain.pageSize"), "1000");
  editor.setGroups([{ id: 42, name: "Globe chain", groupMode: "chain", forwardType: "iptables", members: [], isEnabled: true }]);
  let consumed = false;
  editor.setProps({
    ...hidden.props.children.props,
    editRequest: { id: 42, requestKey: 1 },
    onEditRequestConsumed: () => { consumed = true; },
  });
  assert.equal(consumed, true, "the full options query still resolves the requested edit");
  assert.ok(editor.elements((element) => element.type === "Dialog" && element.props.open).length > 0);
  assert.ok(editor.elements((element) => element.type === "Input" && element.props.value === "Globe chain").length > 0);
  assert.equal(editor.requests.length, 0, "opening the editor also keeps list queries disabled");
  assert.equal(editor.writes.length, 0);
});

test("loading and placeholder totals never clamp a restored tunnel or group page", () => {
  for (const kind of ["tunnels", "groups"] as const) {
    for (const state of ["loading", "placeholder"] as const) {
      const key = kind === "tunnels" ? "forwardx.tunnels" : "forwardx.forwardGroups.port";
      const page = setup(kind, new Map([[`${key}.page`, "3"], [`${key}.pageSize`, "100"]]));
      page.setListState(state); page.render();
      assert.equal(page.lastRequest().page, 3, `${kind}: ${state}`);
      assert.equal(page.storage.get(`${key}.page`), "3");
      assert.equal(page.writes.length, 0);
      page.setListState("ready"); page.render();
      assert.equal(page.pagination().currentPage, 3);
    }
  }
});

test("switching forward group modes restores the target without rewriting either list; search still resets", () => {
  const storage = new Map([
    ["forwardx.forwardGroups.port.page", "3"], ["forwardx.forwardGroups.port.pageSize", "100"],
    ["forwardx.forwardGroups.chain.page", "2"], ["forwardx.forwardGroups.chain.pageSize", "1000"],
  ]);
  const page = setup("groups", storage);
  page.render();
  assert.equal(page.lastRequest().page, 3);
  page.switchMode("chain");
  assert.equal(page.lastRequest().page, 2);
  assert.equal(page.lastRequest().pageSize, 1000);
  page.switchMode("port");
  assert.equal(page.lastRequest().page, 3);
  assert.equal(page.lastRequest().pageSize, 100);
  assert.equal(page.writes.length, 0);
  page.setSearch("resource");
  assert.equal(page.lastRequest().page, 1);
  assert.equal(page.lastRequest().search, "resource");
  assert.equal(storage.get("forwardx.forwardGroups.chain.page"), "2");
});


test("all five forward group modes send the selected size, reset and restore their own pagination", () => {
  const storage = new Map<string, string>();
  const cases = [
    { mode: "port", size: 50 },
    { mode: "failover", size: 100 },
    { mode: "chain", size: 200 },
    { mode: "entry", size: 500 },
    { mode: "exit", size: 1000 },
  ] as const;
  for (const { mode, size } of cases) {
    const page = setup("groups", storage);
    page.switchMode(mode);
    assert.equal(page.lastRequest().pageSize, 20, mode);
    page.pagination().setPage(3); page.render();
    const offset = page.requests.length;
    page.selectSize(size);
    const inputs = page.requests.slice(offset).map(({ input }) => input);
    assert.ok(inputs.length > 0);
    assert.ok(inputs.every((input) => input.page === 1 && input.pageSize === size), mode);
    page.pagination().setPage(2); page.render();
    page.remount(); page.render();
    assert.equal(page.lastRequest().page, 2, mode);
    assert.equal(page.lastRequest().pageSize, size, mode);
    assert.equal(storage.get(`forwardx.forwardGroups.${mode}.pageSize`), String(size));
  }
  const tunnel = setup("tunnels", storage);
  tunnel.render();
  assert.equal(tunnel.lastRequest().pageSize, 20);
  for (const { mode, size } of cases) {
    const page = setup("groups", storage);
    page.switchMode(mode);
    assert.equal(page.lastRequest().page, 2, mode);
    assert.equal(page.lastRequest().pageSize, size, mode);
  }
});
