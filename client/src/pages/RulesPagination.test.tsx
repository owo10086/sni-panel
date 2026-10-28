import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import { createPaginationHarness, findElements } from "@/test/paginationHarness";

const require = createRequire(import.meta.url);
type Request = { procedure: string; input: any };
const admin = { id: 1, role: "admin", username: "admin" };

function setup(storage = new Map<string, string>(), count = 25, grouped = false, manyOwners = false) {
  const harness = createPaginationHarness(storage);
  const requests: Request[] = [];
  const cache = new Map<string, any>();
  let pending: Promise<unknown>[] = [];
  let placeholder = false;
  let loading = false;
  const rules = Array.from({ length: count }, (_, i) => ({
    id: i + 1, userId: manyOwners ? i + 1 : admin.id, name: `rule-${i + 1}`, hostId: 1, forwardType: "iptables",
    protocol: "tcp", sourcePort: grouped ? 443 : 10000 + i, targetIp: "192.0.2.1", targetPort: 80,
    sni: grouped ? `site-${i + 1}.test` : "", forwardGroupId: grouped ? 1 : null, isEnabled: true,
  }));
  const response = (name: string, input: any) => {
    requests.push({ procedure: name, input });
    if (name === "users.optionsByIds") {
      assert.ok(input.ids.length <= 100, "owner API keeps its 100 ID limit");
      return input.ids.map((id: number) => ({ id, username: `owner-${id}` }));
    }
    if (name === "rules.trafficSummary") {
      assert.ok(input.ruleIds.length <= 1000, "traffic API keeps its 1000 ID limit");
      return input.ruleIds.map((ruleId: number) => ({ ruleId, bytesIn: ruleId * 1024, bytesOut: 0, connections: 0 }));
    }
    if (name === "rules.listPage") {
      const scoped = input.scope === "all" ? rules : rules.filter((rule) => rule.userId === input.userId);
      return {
        items: grouped ? scoped : scoped.slice((input.page - 1) * input.pageSize, input.page * input.pageSize),
        totalItems: grouped ? 1 : scoped.length, ruleTotalItems: scoped.length, scopeTotalItems: scoped.length, ruleStartIndex: 0,
        hasAdminManagedRules: false,
      };
    }
    if (name === "rules.listSummary") return {};
    if (name === "system.getSettings") return {};
    return [];
  };
  const queryResult = (name: string, input: any, options?: any) => {
    const key = JSON.stringify([name, input]);
    if (options?.enabled !== false && !cache.has(key)) cache.set(key, response(name, input));
    // Record each list render to catch transient requests with a stale page/size pair.
    if (name === "rules.listPage" && cache.has(key)) requests.push({ procedure: name, input });
    const data = cache.get(key);
    const staleKey = `stale:${key}`;
    if (!cache.has(staleKey)) cache.set(staleKey, { ...data, totalItems: 1 });
    return {
      data: name === "rules.listPage" && (placeholder || loading) ? cache.get(staleKey) : data,
      isLoading: name === "rules.listPage" && loading, isFetched: options?.enabled !== false,
      isPlaceholderData: name === "rules.listPage" && placeholder,
    };
  };
  const utils = new Proxy({}, { get: (_, resource) => resource === "client"
    ? new Proxy({}, { get: (_, r) => new Proxy({}, { get: (_, p) => ({ query: async (input: any) => response(`${String(r)}.${String(p)}`, input) }) }) })
    : new Proxy({}, { get: () => ({ invalidate() {}, setData() {} }) }) });
  const trpc = new Proxy({}, { get: (_, resource) => resource === "useUtils" ? () => utils : new Proxy({}, {
    get: (_, procedure) => ({
      _def: () => ({ path: [resource, procedure] }),
      useQuery: (input: any, options: any) => queryResult(`${String(resource)}.${String(procedure)}`, input, options),
      useInfiniteQuery: () => ({ data: undefined }),
      useMutation: () => ({ isPending: false, mutate() {}, mutateAsync: async () => ({}) }),
    }),
  }) });
  const mocks: Record<string, any> = {
    react: { ...harness.hooks, useLayoutEffect: harness.hooks.useEffect, useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(), lazy: () => "Lazy", Fragment: "Fragment", Suspense: "Suspense" },
    "@/lib/trpc": { trpc },
    "@/components/PersistentPagination": harness.load("client/src/components/PersistentPagination.tsx"),
    "@/components/ui/confirm-dialog": { useConfirmDialog: () => async () => true },
    "@/components/rules/RuleLimitsForm": { newRuleLimitsForm: () => ({}) },
    "@/components/rules/PersonalRuleGroups": new Proxy({ useRuleGroupBulkEditor: () => ({ isPending: false }) } as Record<string, any>, {
      get: (target, key) => key in target ? target[key as string] : String(key),
    }),
    "@/_core/hooks/useAuth": { useAuth: () => ({ user: admin }) },
    "@/hooks/useMobile": { useIsMobile: () => false },
    "@/hooks/useUrlTab": { useUrlTab: () => harness.hooks.useState("all") },
    wouter: { useLocation: () => ["/rules", () => {}], useSearch: () => "" },
    "@/components/SortableDragHandle": {
      SortableReorderContext: "SortableReorderContext", SortableItem: "SortableItem",
      useOptimisticSortableOrder: ({ items }: any) => ({ items }), useSortableReorder: ({ disabled }: any) => ({ disabled }),
    },
    "@/lib/localizedToast": { toast: { success() {}, error() {} } },
    "@tanstack/react-query": { useQuery(options: any) {
      const key = JSON.stringify(options.queryKey);
      if (options.enabled !== false && !cache.has(key)) {
        cache.set(key, undefined);
        pending.push(options.queryFn().then((data: any) => cache.set(key, data)));
      }
      return { data: cache.get(key), isFetched: cache.get(key) !== undefined };
    } },
  };
  const modules: Record<string, any> = {};
  const load = (file: string): any => {
    if (modules[file]) return modules[file];
    const module = { exports: {} };
    const source = ts.transpileModule(readFileSync(file, "utf8"), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
    }).outputText;
    runInNewContext(source, {
      exports: module.exports, module,
      window: { localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) }, setTimeout: (callback: () => void) => { callback(); return 1; }, clearTimeout() {} },
      URLSearchParams, setTimeout, clearTimeout,
      require(id: string) {
        if (id in mocks) return mocks[id];
        if (id === "@/i18n") return { ...require(id), t: (key: string, values: any[] = []) => key.replace(/\{(\d+)\}/g, (_, i) => String(values[Number(i)])) };
        if (id === "@/hooks/useRuleTableLayout" || id.includes("/useRuleBulk")) return load(`client/src/${id.slice(2)}.ts`);
        if (id === "@/lib/rulePageSize") return load("client/src/lib/rulePageSize.ts");
        if (id === "@/components/rules/RuleTableFrame") return { ...require(id), RuleTableFrame: "RuleTableFrame" };
        if (id === "@/components/ui/segmented") return require(id);
        if (id.startsWith(".")) return require(resolve(dirname(file), id));
        if (id.startsWith("@/lib/") || id.startsWith("@shared/") || !id.startsWith("@/")) return require(id);
        return new Proxy({}, { get: (_, key) => String(key) });
      },
    }, { filename: file });
    modules[file] = module.exports;
    return module.exports;
  };
  const Page = load("client/src/pages/Rules.tsx").default;
  const Content = Page().props.children.type;
  let tree: any;
  const render = () => { tree = harness.render(() => Content()); return tree; };
  const paginationElement = () => findElements(tree, (e) => e.type === mocks["@/components/PersistentPagination"].PersistentPagination)[0];
  return {
    ...harness, requests, render,
    async settle() { render(); while (pending.length) { const current = pending; pending = []; await Promise.all(current); render(); } },
    pagination: () => paginationElement().props.pagination,
    selectSize(size: number) {
      const bar = mocks["@/components/PersistentPagination"].PersistentPagination(paginationElement().props);
      findElements(bar, (e) => e.type === "Select")[0].props.onValueChange(String(size)); render();
    },
    setPlaceholder(value: boolean) { placeholder = value; render(); },
    setLoading(value: boolean) { loading = value; render(); },
    elements: (predicate: (e: any) => boolean) => findElements(tree, predicate),
    lastRequest: () => requests.filter((r) => r.procedure === "rules.listPage").at(-1)!.input,
  };
}

test("rules default to 20 and the bottom selector sends selected sizes atomically, resets and restores", async () => {
  const page = setup(new Map([["forwardx.rules.cardSize", "compact"]]), 2400);
  await page.settle();
  assert.equal(page.lastRequest().pageSize, 20, "compact cards also default to 20");
  page.pagination().setPage(2); await page.settle();
  assert.equal(page.lastRequest().page, 2);
  const offset = page.requests.length;
  page.selectSize(50); await page.settle();
  assert.ok(page.requests.slice(offset).filter((r) => r.procedure === "rules.listPage").every((r) => r.input.page === 1 && r.input.pageSize === 50));
  page.pagination().setPage(2); await page.settle();
  page.remount(); await page.settle();
  assert.equal(page.lastRequest().page, 2);
  assert.equal(page.lastRequest().pageSize, 50);
  assert.equal(page.storage.get("forwardx.rules.pageSize"), "50");
});

test("changing size on page 1 clears the actual current-page bulk selection and removes the toolbar selector", async () => {
  const page = setup();
  await page.settle();
  const selectAll = page.elements((e) => e.type === "RuleBulkCheckbox" && e.props.label === "选择本页全部可选规则")[0];
  selectAll.props.onCheckedChange(true); await page.settle();
  assert.equal(page.elements((e) => e.type === "RuleBulkActionBar")[0].props.count, 20);
  page.selectSize(50); await page.settle();
  assert.equal(page.lastRequest().page, 1);
  assert.equal(page.elements((e) => e.type === "RuleBulkActionBar")[0].props.count, 0);
  assert.equal(page.elements((e) => e.type === "SelectValue" && e.props.placeholder === "每页数量").length, 0);
});

test("a stored legacy size migrates before the first query and preserves its restored page", async () => {
  const page = setup(new Map([["forwardx.rules.pageSize", "36"], ["forwardx.rules.page", "2"]]), 150);
  await page.settle();
  assert.ok(page.requests.filter((r) => r.procedure === "rules.listPage").every((r) => r.input.pageSize === 50 && r.input.page === 2));
  assert.equal(page.storage.get("forwardx.rules.pageSize"), "50");
});

test("placeholder and loading totals cannot clamp the restored rules page", async () => {
  const page = setup(new Map([["forwardx.rules.pageSize", "50"], ["forwardx.rules.page", "3"]]), 150);
  page.setPlaceholder(true); await page.settle();
  assert.equal(page.storage.get("forwardx.rules.page"), "3");
  page.setLoading(true); page.setPlaceholder(false); await page.settle();
  assert.equal(page.storage.get("forwardx.rules.page"), "3");
  page.setLoading(false); await page.settle();
  assert.equal(page.pagination().currentPage, 3);
  assert.ok(page.requests.filter((r) => r.procedure === "rules.listPage").every((r) => r.input.page === 3));
});

test("more than 100 visible owners are hydrated in bounded requests and every rule shows its username", async () => {
  const page = setup(new Map([["forwardx.rules.pageSize", "200"]]), 101, false, true);
  await page.settle();
  const offset = page.requests.length;
  const ownerFilter = page.elements((e) => e.props.specialOptions?.some((option: any) => option.value === "all"))[0];
  ownerFilter.props.onValueChange("all"); await page.settle();
  assert.equal(page.lastRequest().scope, "all");
  const ownerRequests = page.requests.slice(offset).filter((r) => r.procedure === "users.optionsByIds");
  assert.deepEqual(ownerRequests.map((r) => r.input.ids.length), [100, 1]);
  const labels = page.elements((e) => e.type === "div" && e.props.className === "mt-1 text-xs text-muted-foreground");
  assert.equal(new Set(labels.flatMap((e) => e.props.children).filter((text) => /^owner-\d+$/.test(text))).size, 101);
  for (let id = 1; id <= 101; id++) assert.ok(labels.some((e) => e.props.children.includes(`owner-${id}`)), `rule ${id} has its username`);
  assert.ok(labels.every((e) => !JSON.stringify(e.props.children).includes("用户 #")));
});

test("an intact SNI display group with 1001 rules loads both traffic ranges in bounded batches with complete rows", async () => {
  const page = setup(new Map(), 1001, true);
  await page.settle();
  const groups = page.elements((e) => e.type === "RuleBulkCheckbox" && e.props.label === "选择 SNI 组内全部可选规则");
  assert.ok(groups.length > 0, "fixture is rendered as an SNI group");
  const summaries = page.elements((e) => e.type === "RuleUsageSummary" && e.props.iconOnly);
  assert.equal(new Set(summaries.map((e) => e.props.rule.id)).size, 1001);
  for (const summary of summaries) assert.equal(summary.props.totals?.bytesIn, summary.props.rule.id * 1024);
  for (const range of ["total", "24h"]) {
    const inputs = page.requests.filter((r) => r.procedure === "rules.trafficSummary" && r.input.range === range).map((r) => r.input);
    assert.deepEqual(inputs.map((input) => input.ruleIds.length), [1000, 1]);
    assert.deepEqual(inputs.flatMap((input) => Array.from(input.ruleIds)), Array.from({ length: 1001 }, (_, i) => i + 1));
  }
  assert.ok(page.elements((e) => e.type === "span" && e.props.children?.includes?.("1001 KB")).length > 0, "last rule also shows 24h traffic");
});
