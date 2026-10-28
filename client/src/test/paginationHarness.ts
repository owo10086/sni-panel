import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as sharedPagination from "@shared/pagination";

const require = createRequire(import.meta.url);

// Run real page components and hooks with deterministic effects, without a DOM
// or dashboard providers. JSX handlers and tRPC query inputs remain executable.
export function createPaginationHarness(storage = new Map<string, string>(), mocks: Record<string, any> = {}, globals: Record<string, any> = {}) {
  let slots: any[] = [];
  let cursor = 0;
  let dirty = false;
  let effects: Array<() => void> = [];
  const reads: string[] = [];
  const writes: string[] = [];
  const same = (a?: unknown[], b?: unknown[]) => !!a && !!b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  const hooks = {
    useState(initial: any) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
      return [slots[index], (value: any) => {
        const next = typeof value === "function" ? value(slots[index]) : value;
        if (!Object.is(next, slots[index])) { slots[index] = next; dirty = true; }
      }];
    },
    useMemo(factory: () => any, deps: unknown[]) {
      const index = cursor++;
      if (!slots[index] || !same(slots[index].deps, deps)) slots[index] = { value: factory(), deps };
      return slots[index].value;
    },
    useCallback(callback: any, deps: unknown[]) { return hooks.useMemo(() => callback, deps); },
    useRef(value: any) { return hooks.useMemo(() => ({ current: value }), []); },
    useEffect(callback: () => void, deps: unknown[]) {
      const index = cursor++;
      if (!slots[index] || !same(slots[index], deps)) effects.push(callback);
      slots[index] = deps;
    },
  };
  const localStorage = {
    getItem(key: string) { reads.push(key); return storage.get(key) ?? null; },
    setItem(key: string, value: string) { writes.push(key); storage.set(key, value); },
  };
  const modules: Record<string, any> = {};
  function load(file: string): any {
    if (modules[file]) return modules[file];
    const module = { exports: {} };
    const source = ts.transpileModule(readFileSync(file, "utf8"), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
    }).outputText;
    runInNewContext(source, {
      setTimeout, clearTimeout, URLSearchParams,
      ...globals,
      exports: module.exports, module, window: { localStorage },
      require(id: string) {
        if (id in mocks) return mocks[id];
        if (id === "react") return hooks;
        if (id === "react/jsx-runtime") return require(id);
        if (id === "@shared/pagination") return sharedPagination;
        if (id === "@/lib/pageSize") return load("client/src/lib/pageSize.ts");
        if (id === "@/components/PersistentPagination") return load("client/src/components/PersistentPagination.tsx");
        if (id === "@/lib/utils") return { cn: (...values: any[]) => values.filter(Boolean).join(" ") };
        if (id === "@/i18n") return {
          t: (key: string, values: any[] = []) => key.replace(/\{(\d+)\}/g, (_, i) => String(values[Number(i)])),
          getFormatLocale: () => "zh-CN",
        };
        return new Proxy({ __esModule: true }, { get: (target, key) => key === "__esModule" ? true : String(key) });
      },
    }, { filename: file });
    modules[file] = module.exports;
    return module.exports;
  }
  return {
    load, hooks, storage, reads, writes,
    remount() { slots = []; },
    render<T>(component: () => T): T {
      let result!: T;
      for (let attempt = 0; attempt < 30; attempt++) {
        cursor = 0; effects = []; dirty = false;
        result = component();
        for (const effect of effects) effect();
        if (!dirty) return result;
      }
      assert.fail("component effects did not settle");
    },
  };
}

export function findElements(tree: any, predicate: (element: any) => boolean): any[] {
  if (Array.isArray(tree)) return tree.flatMap((child) => findElements(child, predicate));
  if (!tree || typeof tree !== "object" || !tree.props) return [];
  return [...(predicate(tree) ? [tree] : []), ...findElements(tree.props.children, predicate)];
}
