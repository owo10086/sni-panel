import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as affiliate from "@shared/affiliate";
import { createPaginationHarness, findElements } from "./paginationHarness";

type QueryInput = { kind?: string; page: number; pageSize: number; search?: string; status?: string; userId?: number };
export const recordKinds = ["commissions", "withdrawals", "ledger", "referrals"] as const;
export const recordKey = (admin: boolean, kind: string) => `forwardx.affiliates.${admin ? "admin" : "user"}.${kind}.page`;
export const overviewKey = "forwardx.affiliates.admin.overview.page";

export function setupAffiliatePage(admin = false, storage = new Map<string, string>()) {
  const requests: Array<{ procedure: string; input: QueryInput }> = [];
  const cacheUpdates: Array<{ input: QueryInput; data: any }> = [];
  const cached = new Map<string, any>();
  const timers = new Map<number, () => void>();
  let timerId = 0;
  let total = 2400;
  let pending: { procedure: string; kind?: string; isLoading: boolean; isPlaceholderData: boolean; data?: any } | undefined;
  let active: ReturnType<typeof createPaginationHarness>;
  const hooks = Object.fromEntries(["useState", "useMemo", "useCallback", "useRef", "useEffect"].map(name => [
    name, (...args: any[]) => (active.hooks as any)[name](...args),
  ]));
  const utils = { affiliates: {
    invalidate() {},
    adminOverview: { setData(input: QueryInput, update: (old: any) => any) {
      const key = JSON.stringify(["adminOverview", input, total]);
      const data = update(cached.get(key));
      cached.set(key, data);
      cacheUpdates.push({ input, data });
    } },
  } };
  const trpc = { useUtils: () => utils, affiliates: new Proxy({}, { get: (_, procedure) => ({
    useQuery(input: QueryInput, options?: { enabled?: boolean }) {
      const name = String(procedure);
      if (options?.enabled === false) return { isLoading: false, isPlaceholderData: false };
      if (input) requests.push({ procedure: name, input });
      if (pending?.procedure === name && pending.kind === input?.kind) return pending;
      const key = JSON.stringify([name, input, total]);
      if (!cached.has(key)) cached.set(key, name === "me" ? {
        config: affiliate.AFFILIATE_DEFAULTS, codes: [], panelUrl: "https://panel.test", availableCents: 0,
      } : name === "adminOverview" ? {
        accounts: [], total, config: affiliate.AFFILIATE_DEFAULTS, enabled: true, totals: {},
      } : { items: [], total });
      return { data: cached.get(key), isLoading: false, isPlaceholderData: false };
    },
    useMutation(options?: { onSuccess?: (data: any, input: any) => void }) {
      return { isPending: false, mutate(input: any) { options?.onSuccess?.({ success: true }, input); } };
    },
  }) }) };
  const mocks: Record<string, any> = {
    react: hooks,
    "@/lib/trpc": { trpc },
    "@/_core/hooks/useAuth": { useAuth: () => ({ user: { id: 1, role: "admin" } }) },
    "@shared/affiliate": affiliate,
    "@/i18n": { t: (key: string, values: any[] = []) => key.replace(/\{(\d+)\}/g, (_, i) => String(values[Number(i)])), getFormatLocale: () => "zh-CN" },
    "@/lib/localizedToast": { toast: { success() {}, error() {} } },
  };
  const root = createPaginationHarness(storage, mocks);
  const overview = createPaginationHarness(storage, mocks);
  const records = createPaginationHarness(storage, mocks);
  active = root;
  const paginationModule = root.load("client/src/components/PersistentPagination.tsx");
  mocks["@/components/PersistentPagination"] = paginationModule;
  const module = { exports: {} as any };
  const require = createRequire(import.meta.url);
  const source = ts.transpileModule(readFileSync("client/src/pages/Affiliates.tsx", "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  runInNewContext(source, {
    exports: module.exports, module,
    setTimeout(callback: () => void) { timers.set(++timerId, callback); return timerId; },
    clearTimeout(id: number) { timers.delete(id); },
    require(id: string) {
      if (id in mocks) return mocks[id];
      if (id === "react/jsx-runtime") return require(id);
      return new Proxy({ __esModule: true }, { get: (_, key) => key === "__esModule" ? true : String(key) });
    },
  }, { filename: "client/src/pages/Affiliates.tsx" });
  let tree: any;
  let overviewTree: any;
  let recordsTree: any;
  const render = () => {
    active = root;
    const rootTree = root.render(() => module.exports.default({ admin }));
    const main = findElements(rootTree, element => typeof element.type === "function" && /^(Admin|User)Affiliates$/.test(element.type.name))[0];
    assert.ok(main, "render the actual affiliate page and its active view");
    active = overview;
    overviewTree = overview.render(() => main.type(main.props));
    const child = findElements(overviewTree, element => typeof element.type === "function" && element.type.name === "Records")[0];
    assert.ok(child, "the real view renders its records component");
    active = records;
    recordsTree = records.render(() => child.type(child.props));
    tree = [rootTree, overviewTree, recordsTree];
    return tree;
  };
  const bar = (scope: "records" | "overview") => findElements(scope === "records" ? recordsTree : overviewTree,
    element => element.type === paginationModule.PersistentPagination)[0];
  return {
    storage, requests, cacheUpdates, render,
    remount() { root.remount(); overview.remount(); records.remount(); timers.clear(); render(); },
    flushTimers() { const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach(callback => callback()); render(); },
    setTotal(value: number) { total = value; render(); },
    setPending(value: typeof pending) { pending = value; },
    lastRequest(procedure = admin ? "adminList" : "list") { return requests.filter(request => request.procedure === procedure).at(-1)!.input; },
    elements(predicate: (element: any) => boolean) { return findElements(tree, predicate); },
    pagination(scope: "records" | "overview" = "records") { assert.ok(bar(scope), "shared pagination must be rendered"); return bar(scope).props.pagination; },
    selectSize(size: number, scope: "records" | "overview" = "records") {
      assert.ok(bar(scope), "shared pagination must be rendered");
      const selector = findElements(paginationModule.PersistentPagination(bar(scope).props), element => element.type === "Select")[0];
      assert.ok(selector, "use the actual shared pagination selector");
      selector.props.onValueChange(String(size)); render();
    },
    switchKind(kind: string) {
      const select = findElements(recordsTree, element => element.type === "Select" && recordKinds.includes(element.props.value))[0];
      select.props.onValueChange(kind); render();
    },
  };
}
