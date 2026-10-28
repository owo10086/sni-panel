import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { createPaginationHarness, findElements } from "@/test/paginationHarness";

const require = createRequire(import.meta.url);
const limits: Record<string, number> = { statusSummary: 100, watchMetrics: 200, latestMetricsSummary: 500, trafficSummary: 500 };

function setup(storage = new Map<string, string>(), count = 2400, visible = false) {
  const harness = createPaginationHarness(storage);
  const requests: Array<{ procedure: string; input: any }> = [];
  const timers = new Map<number, () => void>();
  const cleanups = new Set<() => void>();
  const pending = new Set<Promise<unknown>>();
  const cache = new Map<string, any>();
  const liveQueries = new Map<string, any>();
  let placeholder: any;
  let tab = "hosts";
  const rows = Array.from({ length: count }, (_, i) => ({ id: i + 1, name: `Host ${i + 1}`, isOnline: false }));
  function request(procedure: string, input: any) {
    requests.push({ procedure, input });
    if (limits[procedure]) {
      assert.ok(input.hostIds.length <= limits[procedure], `${procedure}: BAD_REQUEST above ${limits[procedure]}`);
      return input.hostIds.map((id: number) => procedure === "statusSummary" ? { id, isOnline: true }
        : procedure === "trafficSummary" ? { hostId: id, bytesIn: id * 1024, bytesOut: id * 2048 }
          : { hostId: id, cpuUsage: id / 10, load1: id });
    }
    if (procedure === "listPage") return placeholder ?? {
      items: rows.slice((input.page - 1) * input.pageSize, input.page * input.pageSize), totalItems: count, scopeTotalItems: count,
    };
    if (procedure === "summary") return {};
    if (procedure === "getSettings") return { forwardProtocols: {} };
    return [];
  }
  function cachedQuery(procedure: string, input: any, options?: any) {
    const key = JSON.stringify([procedure, input, !!placeholder]);
    if (options?.enabled === false) return { data: undefined, isLoading: false };
    if (!cache.has(key)) cache.set(key, request(procedure, input));
    return { data: cache.get(key), isLoading: false, isPlaceholderData: procedure === "listPage" && !!placeholder };
  }
  const client = new Proxy({}, { get: () => new Proxy({}, { get: (_, name) => ({
    query: async (input: any) => request(String(name), input),
  }) }) });
  const utils = new Proxy({ client }, { get: (target, key) => key === "client" ? target.client : new Proxy({}, { get: () => ({ invalidate() {} }) }) });
  const trpc = new Proxy({}, { get: (_, resource) => resource === "useUtils" ? () => utils : new Proxy({}, { get: (_, name) => ({
    name: String(name),
    useQuery: (input: any, options: any) => cachedQuery(String(name), input, options),
    useInfiniteQuery: () => ({ data: undefined, hasNextPage: false, isLoading: false }),
    useMutation: () => ({ isPending: false, mutate: (input: any) => request(String(name), input), mutateAsync: async (input: any) => request(String(name), input) }),
  }) }) });
  const react = {
    ...harness.hooks, lazy: () => "Lazy", Suspense: "Suspense",
    useEffect(callback: () => any, deps: unknown[]) {
      const ref = harness.hooks.useRef(undefined);
      harness.hooks.useEffect(() => {
        if (ref.current) { ref.current(); cleanups.delete(ref.current); }
        ref.current = callback();
        if (ref.current) cleanups.add(ref.current);
      }, deps);
    },
  };
  const pagination = harness.load("client/src/components/PersistentPagination.tsx");
  const mocks: Record<string, any> = {
    react,
    "@/lib/trpc": { trpc },
    "@/components/PersistentPagination": pagination,
    "@trpc/react-query": { getQueryKey: (procedure: any, input: any) => [["hosts", procedure.name], { input, type: "query" }] },
    "@tanstack/react-query": { useQuery(options: any) {
      const key = JSON.stringify(options.queryKey);
      liveQueries.set(key, options);
      if (options.enabled !== false && !cache.has(key)) {
        cache.set(key, undefined);
        const promise = options.queryFn().then((data: any) => cache.set(key, data)).finally(() => pending.delete(promise));
        pending.add(promise);
      }
      return { data: cache.get(key) };
    } },
    "@/_core/hooks/useAuth": { useAuth: () => ({ user: { id: 1, role: "admin" } }) },
    "@/hooks/useUrlTab": { useUrlTab: () => [tab, (value: string) => { tab = value; }] },
    "@/hooks/useHostTableLayout": { useHostTableLayout: () => ({ columns: [{ id: "status", label: "状态" }, { id: "load", label: "负载" }, { id: "total", label: "流量" }], allColumns: [], layout: {} }) },
    "@/components/hosts/HostGroupManager": { __esModule: true, default: "HostGroupManager", compareHostGroupDisplayOrder: (a: any, b: any) => a.id - b.id },
    "@/components/hosts/HostCard": { __esModule: true, default: "HostCard", HostActionButtons: "HostActionButtons" },
    "@/components/hosts/HostLoad": { __esModule: true, default: "HostLoad" },
    "@/components/SortableDragHandle": { useSortableReorder: (options: any) => ({ disabled: options.disabled }), SortableItem: "SortableItem", SortableReorderContext: "SortableReorderContext" },
    "@/lib/utils": { cn: (...values: any[]) => values.filter(Boolean).join(" ") },
    "@/lib/localizedToast": { toast: { success() {}, error() {} } },
    "@/i18n": { t: (key: string, values: any[] = []) => key.replace(/\{(\d+)\}/g, (_, i) => String(values[Number(i)])), getFormatLocale: () => "zh-CN" },
  };
  const module = { exports: {} as any };
  runInNewContext(ts.transpileModule(readFileSync("client/src/pages/Hosts.tsx", "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText, {
    module, exports: module.exports,
    document: { visibilityState: visible ? "visible" : "hidden", addEventListener() {}, removeEventListener() {} },
    window: { localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
      setInterval: (callback: () => void) => { const id = timers.size + 1; timers.set(id, callback); return id; }, clearInterval: (id: number) => timers.delete(id) },
    require(id: string) {
      if (id in mocks) return mocks[id];
      if (id === "react/jsx-runtime" || id.startsWith("@shared/") || id.startsWith("@/lib/") || id === "@/components/hosts/hostDisplay") return require(id);
      return new Proxy({ __esModule: true }, { get: (_, key) => key === "__esModule" ? true : String(key) });
    },
  });
  let tree: any;
  const render = () => { tree = harness.render(() => module.exports.default().props.children.type()); return tree; };
  function expandSortable(element: any): any {
    if (Array.isArray(element)) return element.map(expandSortable);
    if (!element?.props) return element;
    const children = element.type === "SortableItem" ? element.props.children({ itemProps: {}, handleProps: {} }) : element.props.children;
    return { ...element, props: { ...element.props, children: expandSortable(children) } };
  }
  const elements = (predicate: (element: any) => boolean) => findElements(expandSortable(tree), predicate);
  const bar = () => elements((element) => element.type === pagination.PersistentPagination)[0];
  return {
    storage, requests, render, elements,
    pagination: () => bar().props.pagination,
    lastListRequest: () => requests.filter((row) => row.procedure === "listPage").at(-1)!.input,
    selectSize(size: number) {
      const selector = findElements(pagination.PersistentPagination(bar().props), (element) => element.type === "Select")[0];
      assert.ok(selector, "the real pagination bar must expose the selector");
      selector.props.onValueChange(String(size)); render();
    },
    remount() { for (const cleanup of cleanups) cleanup(); cleanups.clear(); cache.clear(); harness.remount(); render(); },
    setPlaceholder(data: any) { placeholder = data; render(); },
    async settle() {
      while (pending.size) await Promise.all([...pending]);
      // Finish the mutation effect's promise chain before the next render.
      await new Promise<void>((resolve) => setImmediate(resolve));
      render();
    },
    async tick() { for (const callback of [...timers.values()]) callback(); await this.settle(); },
    async pollQueries() {
      for (const [key, options] of liveQueries) {
        if (options.enabled && options.refetchInterval) cache.set(key, await options.queryFn());
      }
      render();
    },
  };
}

test("host views default to 20, send selected pageSize, reset atomically and restore page and size", () => {
  for (const view of ["card", "compact-card", "table"]) {
    const page = setup(new Map([["forwardx.hosts.viewMode", view]]));
    page.render();
    assert.equal(page.lastListRequest().pageSize, 20);
    for (const size of [50, 100, 200, 500, 1000]) {
      page.pagination().setPage(2); page.render();
      assert.equal(page.lastListRequest().page, 2);
      const offset = page.requests.length;
      page.selectSize(size);
      assert.equal(page.lastListRequest().page, 1);
      assert.equal(page.lastListRequest().pageSize, size);
      const inputs = page.requests.slice(offset).filter((row) => row.procedure === "listPage").map((row) => row.input);
      assert.ok(inputs.length > 0);
      assert.ok(inputs.every((input) => input.page === 1 && input.pageSize === size));
    }
    page.pagination().setPage(2); page.render(); page.remount();
    assert.equal(page.lastListRequest().page, 2);
    assert.equal(page.lastListRequest().pageSize, 1000);
    assert.equal(page.storage.get("forwardx.hosts.page"), "2");
    assert.equal(page.storage.get("forwardx.hosts.pageSize"), "1000");
  }
});

for (const count of [20, 100, 101, 200, 201, 500, 501, 1000]) {
  test(`${count} hosts: bounded initial and recurring requests cover every host exactly once`, async () => {
    const page = setup(new Map([["forwardx.hosts.pageSize", "1000"]]), count, true);
    page.render(); await page.settle();
    function assertBatches(requests: typeof page.requests, procedures: string[]) {
      for (const procedure of procedures) {
        const batches = requests.filter((row) => row.procedure === procedure);
        assert.equal(batches.length, Math.ceil(count / limits[procedure]), procedure);
        assert.ok(batches.every((row) => row.input.hostIds.length <= limits[procedure]));
        assert.deepEqual(batches.flatMap((row) => Array.from(row.input.hostIds)), Array.from({ length: count }, (_, i) => i + 1), procedure);
      }
    }
    assertBatches(page.requests, Object.keys(limits));
    const offset = page.requests.length;
    await page.tick(); await page.pollQueries();
    assertBatches(page.requests.slice(offset), Object.keys(limits));
  });
}

for (const view of ["card", "compact-card", "table"]) {
  for (const count of [101, 201, 501]) {
    test(`${view} displays status, metrics and traffic for all ${count} hosts`, async () => {
      const page = setup(new Map([["forwardx.hosts.pageSize", "1000"], ["forwardx.hosts.viewMode", view]]), count, true);
      page.render(); await page.settle();
      const cards = page.elements((element) => element.type === "HostCard");
      assert.equal(cards.length, count);
      for (const card of cards) {
        const { host, metrics, traffic } = card.props;
        assert.equal(host.isOnline, true, `status ${host.id}`);
        assert.equal(metrics[0].hostId, host.id);
        assert.equal(metrics[0].load1, host.id);
        assert.equal(traffic.hostId, host.id);
        assert.equal(traffic.bytesIn, host.id * 1024);
        assert.equal(card.props.compact, view === "compact-card");
      }
      if (view === "table") {
        const loads = page.elements((element) => element.type === "HostLoad" && element.props.showLabel === false);
        const statuses = page.elements((element) => element.type?.name === "HostListStatusBadge");
        const traffic = page.elements((element) => element.type?.name === "HostListFlowPair");
        assert.equal(loads.length, count);
        assert.equal(statuses.length, count);
        assert.equal(traffic.length, count);
        for (let i = 0; i < count; i++) {
          assert.equal(loads[i].props.metric.hostId, i + 1);
          assert.equal(statuses[i].props.host.isOnline, true);
          assert.equal(traffic[i].props.inValue, require("@/components/hosts/hostDisplay").formatBytes((i + 1) * 1024));
        }
      }
    });
  }
}

test("placeholder totals never overwrite a restored host page", () => {
  const page = setup(new Map([["forwardx.hosts.page", "3"], ["forwardx.hosts.pageSize", "200"]]));
  page.setPlaceholder({ items: [], totalItems: 0 });
  assert.equal(page.lastListRequest().page, 3);
  assert.equal(page.storage.get("forwardx.hosts.page"), "3");
  page.setPlaceholder(undefined);
  assert.equal(page.lastListRequest().page, 3);
});

test("empty host pages never send status, metrics, traffic or watch requests", async () => {
  const page = setup(new Map(), 0, true);
  page.render(); await page.settle(); await page.tick(); await page.pollQueries();
  assert.equal(page.requests.filter((row) => row.procedure in limits).length, 0);
});
