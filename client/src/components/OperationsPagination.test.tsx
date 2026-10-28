import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import * as operations from "@shared/operations";
import { createPaginationHarness, findElements } from "@/test/paginationHarness";

const require = createRequire(import.meta.url);
type QueryState = "ready" | "loading" | "placeholder";

function setup(kind: "sources" | "financeLedger" | "monitor", storage = new Map<string, string>()) {
  const requests: Array<{procedure: string; input: any}> = [];
  let state: QueryState = "ready", total = 2400;
  let props = {from:"2026-10-28",to:"2026-10-28",userId:"self" as "self"|"all"|number,refreshInterval:false as false};
  const pendingTimers = new Map<number, () => void>();
  let timerId = 0;
  const utils = {operations:{invalidate() {}}};
  const trpc = new Proxy({}, {get: (_, resource) => resource === "useUtils" ? () => utils : new Proxy({}, {
    get: (_, procedure) => ({
      useQuery(input: any) {
        const name = String(procedure);
        requests.push({procedure:name,input});
        const page = input?.page ?? 0;
        const data = name === "sources" ? {ips:[{ip:"192.0.2.1",rules:1,bytesIn:1,bytesOut:0,knownSamples:1,unknownSamples:0}],totals:{ips:total},statuses:[],location:{},provinces:[]}
          : name === "financeLedger" ? {rows:[],total,page:Math.min(page,Math.max(0,Math.ceil(total/(input.pageSize || 10))-1))}
          : name === "monitor" ? {events:[],total,page,ipEvents:[],ipTotal:total,ipPage:input.ipPage,security:[],resources:[],active:[],health:[]}
          : name === "overview" ? {trend:[],current:[],availability:[],events:[]}
          : name === "finance" ? {receipts:[],balances:[],subscriptions:[]} : undefined;
        return {data,isLoading:state === "loading",isPlaceholderData:state === "placeholder",isFetching:state !== "ready"};
      },
      useMutation() {return {isPending:false,mutate() {}};},
    }),
  })});
  const mocks: Record<string, any> = {
    "@/lib/trpc": {trpc},
    "@/_core/hooks/useAuth": {useAuth: () => ({user:{id:1}})},
    "@/hooks/useOperationsRefresh": {useOperationsRefresh: () => ({interval:false})},
    "@/lib/operationsRefresh": {operationsRefreshOptions: () => ({})},
    "@/components/ui/confirm-dialog": {useConfirmDialog: () => async () => true},
    "@/components/OperationsSourceList": {__esModule:true,default:"OperationsSourceList"},
    "@/components/OperationsChinaMap": {__esModule:true,default:"OperationsChinaMap",operationsBytes: String,sourceUsage: String},
    "./OperationsChinaMap": {sourceUsage: String},
  };
  const harness = createPaginationHarness(storage,mocks);
  const paginationModule = harness.load("client/src/components/PersistentPagination.tsx");
  let Component: any;
  if (kind === "sources") {
    // The page needs Vite's import.meta and debounced browser timers. Keep those
    // environment adapters local; execute the real page, hooks and JSX handlers.
    const module = {exports:{} as any};
    const code = ts.transpileModule(readFileSync("client/src/pages/Operations.tsx","utf8").replace("import.meta", "({env:{}})"), {
      compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true},
    }).outputText;
    runInNewContext(code, {module,exports:module.exports,
      setTimeout(callback: () => void) {pendingTimers.set(++timerId,callback);return timerId;},
      clearTimeout(id: number) {pendingTimers.delete(id);},
      require(id: string) {
        if (id in mocks) return mocks[id];
        if (id === "react") return harness.hooks;
        if (id === "react/jsx-runtime") return require(id);
        if (id === "@shared/operations") return operations;
        if (id === "@/components/PersistentPagination") return paginationModule;
        if (id === "@/i18n") return {t:(key: string,values: any[] = []) => key.replace(/\{(\d+)\}/g,(_,i)=>String(values[Number(i)])),getFormatLocale:()=>"zh-CN"};
        return new Proxy({__esModule:true},{get:(_,key)=>key === "__esModule" ? true : String(key)});
      },
    });
    Component = module.exports.default;
  } else Component = harness.load(`client/src/components/${kind === "monitor" ? "OperationsMonitorPanel" : "OperationsFinanceSummary"}.tsx`).default;
  let tree: any;
  const render = () => {tree=harness.render(()=>Component(kind === "monitor" ? {interval:false} : props));return tree;};
  const elements = (predicate: (element: any) => boolean) => findElements(tree,predicate);
  const bars = () => kind === "sources"
    ? [elements(element=>element.type === "OperationsSourceList")[0].props]
    : elements(element=>element.type === paginationModule.PersistentPagination).map(element=>element.props);
  return {...harness,requests,render,elements,
    pagination(index = 0) {return bars()[index].pagination;},
    selectSize(size: number,index = 0) {
      const bar = paginationModule.PersistentPagination(bars()[index]);
      const select = findElements(bar,element=>element.type === "Select")[0];
      assert.ok(select,"the actual shared size selector must be present");
      select.props.onValueChange(String(size));render();
    },
    lastRequest() {return requests.filter(request=>request.procedure === kind).at(-1)!.input;},
    flushTimers() {const timers=[...pendingTimers.values()];pendingTimers.clear();for(const callback of timers) callback();render();},
    setData(nextTotal: number,nextState: QueryState = "ready") {total=nextTotal;state=nextState;render();},
    setProps(next: Partial<typeof props>) {props={...props,...next};render();},
  };
}

test("four operations lists send selected sizes and zero-based pages, reset atomically, restore and stay independent", () => {
  const storage = new Map<string,string>();
  const source=setup("sources",storage), finance=setup("financeLedger",storage), monitor=setup("monitor",storage);
  for(const page of [source,finance,monitor]) {page.render();assert.equal(page.lastRequest().pageSize,20);}
  assert.equal(monitor.lastRequest().ipPageSize,20);
  const lists=[{page:source,index:0,size:50,key:"sources"},{page:finance,index:0,size:100,key:"financeLedger"},{page:monitor,index:0,size:200,key:"alertEvents"},{page:monitor,index:1,size:500,key:"ipEvents"}];
  for(const {page,index,size} of lists) {
    page.pagination(index).setPage(3);page.render();
    assert.equal(page.lastRequest()[index ? "ipPage" : "page"],2);
    const offset=page.requests.length;
    page.selectSize(size,index);
    const inputs=page.requests.slice(offset).filter(request=>request.procedure === (page === source ? "sources" : page === finance ? "financeLedger" : "monitor"));
    assert.ok(inputs.length>0);
    assert.ok(inputs.every(({input})=>input[index ? "ipPage" : "page"] === 0 && input[index ? "ipPageSize" : "pageSize"] === size));
    page.pagination(index).setPage(2);page.render();
  }
  for(const page of [source,finance,monitor]) {page.remount();page.render();}
  source.flushTimers();
  for(const {page,index,size,key} of lists) {
    assert.equal(page.lastRequest()[index ? "ipPage" : "page"],1,key);
    assert.equal(page.lastRequest()[index ? "ipPageSize" : "pageSize"],size,key);
    assert.equal(storage.get(`forwardx.operations.${key}.pageSize`),String(size));
    assert.equal(storage.get(`forwardx.operations.${key}.page`),"2");
  }
});

test("restored operations pages survive loading and placeholder totals, then clamp using size 50", () => {
  const storage = new Map(["sources","financeLedger","alertEvents","ipEvents"].flatMap(key => [
    [`forwardx.operations.${key}.page`,"9"], [`forwardx.operations.${key}.pageSize`,"50"],
  ]));
  for (const kind of ["sources","financeLedger","monitor"] as const) {
    const page=setup(kind,storage);
    for (const state of ["loading","placeholder"] as const) {
      page.setData(0,state);page.flushTimers();
      assert.equal(page.lastRequest().page,8,`${kind}: ${state}`);
      if(kind === "monitor") assert.equal(page.lastRequest().ipPage,8);
    }
    page.setData(117);
    assert.equal(page.lastRequest().page,2,`${kind}: last page`);
    assert.equal(page.pagination().totalPages,3);
    if(kind === "monitor") assert.equal(page.lastRequest().ipPage,2);
  }
});

test("source date, user, debounced search and sort changes reset only when the filter actually changes", () => {
  const page=setup("sources",new Map([["forwardx.operations.sources.page","3"]]));
  page.render();page.flushTimers();
  assert.equal(page.lastRequest().page,2,"initial debounce preserves the restored page");
  const dateFilter=()=>page.elements(element=>typeof element.props.onApply === "function")[0];
  dateFilter().props.onApply();page.render();
  assert.equal(page.lastRequest().page,2,"reapplying the same dates preserves the page");
  dateFilter().props.onFromChange("2026-10-27");page.render();
  dateFilter().props.onApply();page.render();
  assert.equal(page.lastRequest().page,0);
  assert.equal(page.lastRequest().from,"2026-10-27");
  page.pagination().setPage(3);page.render();
  page.elements(element=>element.props.id === "operations-user")[0].props.onValueChange("all");page.render();
  assert.equal(page.lastRequest().page,0);assert.equal(page.lastRequest().userId,"all");
  page.pagination().setPage(3);page.render();
  page.elements(element=>element.type === "Input" && element.props.placeholder === "搜索来源 IP")[0].props.onChange({target:{value:"  192.0.2.1  "}});page.render();
  assert.equal(page.lastRequest().page,2,"search waits for debounce");
  page.flushTimers();
  assert.equal(page.lastRequest().page,0);assert.equal(page.lastRequest().search,"192.0.2.1");
  page.pagination().setPage(3);page.render();
  page.elements(element=>element.type === "OperationsSourceList")[0].props.onSortChange("rules");page.render();
  assert.equal(page.lastRequest().page,0);assert.equal(page.lastRequest().sort,"rules");
});

test("finance restores on mount and resets for each changed date or user, preserving size and same filters", () => {
  const page=setup("financeLedger",new Map([["forwardx.operations.financeLedger.page","3"],["forwardx.operations.financeLedger.pageSize","50"]]));
  page.render();
  assert.equal(page.lastRequest().page,2);
  page.setProps({from:"2026-10-28"});
  assert.equal(page.lastRequest().page,2);
  for (const filter of [{from:"2026-10-27"},{to:"2026-10-29"},{userId:"all" as const}]) {
    page.setProps(filter);
    assert.equal(page.lastRequest().page,0);
    assert.equal(page.lastRequest().pageSize,50);
    page.pagination().setPage(3);page.render();
  }
});

test("shared monitor placeholders never reset the other event list when either size or page changes", () => {
  const page=setup("monitor");page.render();
  page.pagination(0).setPage(4);page.pagination(1).setPage(3);page.render();
  page.setData(21,"placeholder");
  page.selectSize(200,0);
  assert.equal(page.lastRequest().page,0);assert.equal(page.lastRequest().ipPage,2);
  page.setData(2400);
  page.pagination(0).setPage(4);page.render();
  page.setData(21,"placeholder");
  page.selectSize(50,1);
  assert.equal(page.lastRequest().page,3);assert.equal(page.lastRequest().ipPage,0);
  page.setData(2400);
  page.pagination(1).setPage(3);page.render();
  page.setData(21,"placeholder");
  page.pagination(0).previousPage();page.render();
  assert.equal(page.lastRequest().page,2);assert.equal(page.lastRequest().ipPage,2);
  page.pagination(1).previousPage();page.render();
  assert.equal(page.lastRequest().page,2);assert.equal(page.lastRequest().ipPage,1);
  assert.equal(page.lastRequest().pageSize,200);assert.equal(page.lastRequest().ipPageSize,50);
});
