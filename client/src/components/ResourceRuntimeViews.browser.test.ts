import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createServer as createHttpServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import tailwindcss from "@tailwindcss/vite";
import { build } from "esbuild";
import express from "express";
import { createServer } from "vite";

const chrome = process.env.CHROME_BIN || (process.platform === "darwin"
  ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "/usr/bin/chromium");

// A component harness, not the Hosts/ForwardGroups/Rules pages. Authentication
// context and Agent reports are controlled; management/query/report handlers,
// SQLite, localization, CSS and the components below are production modules.
// These reports do not establish real socket collection or external forwarding.
const harness = `
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {httpBatchLink} from '@trpc/client';
import superjson from 'superjson';
import {Toaster, toast} from 'sonner';
import {trpc} from './client/src/lib/trpc';
import {TooltipProvider} from './client/src/components/ui/tooltip';
import {initializeLanguage, setLanguagePreference, t} from './client/src/i18n';
setLanguagePreference(new URLSearchParams(location.search).get('lang') || 'en');
await initializeLanguage();
const {default: HostConnectionCount} = await import('./client/src/components/hosts/HostConnectionCount');
const {ResourceTrafficResetButton, ResourceTrafficResetDialog} = await import('./client/src/components/ResourceTrafficReset');
const {LinkTestProbeView, LinkTestLatencySummary, parseLinkTestMessage} = await import('./client/src/components/LinkTestLatencySummary');
const {LatencyStabilityStats} = await import('./client/src/components/LatencyStabilityStats');
const {SelfTestEvidenceNote} = await import('./client/src/components/rules/SelfTestEvidenceNote');
const {getLatencyStabilityStats} = await import('./client/src/lib/latencyChart');
const queryClient = new QueryClient({defaultOptions:{queries:{retry:false,refetchOnWindowFocus:false},mutations:{retry:false}}});
const client = trpc.createClient({links:[httpBatchLink({url:'/api/trpc',transformer:superjson})]});
window.qa = {t, dismissToasts:()=>toast.dismiss()};
function Connections() {
  const query = trpc.hosts.list.useQuery();
  return <section id="connections"><button id="refresh-hosts" onClick={()=>query.refetch()}>{t('刷新')}</button>
    <div className="grid gap-3 sm:grid-cols-2">{query.data?.map(host=><article key={host.id} data-host={host.id} className="min-w-0 rounded border p-3">
      <p>{host.name}</p><div className="grid grid-cols-2 gap-2">{['tcp','udp'].map(protocol=><div key={protocol} data-protocol={protocol}><p>{protocol.toUpperCase()}</p><HostConnectionCount snapshot={host.connectionStats} protocol={protocol} isOnline={host.isOnline}/></div>)}</div>
    </article>)}</div></section>;
}
function Resource() {
  const utils = trpc.useUtils();
  const query = trpc.forwardGroups.listPage.useQuery({groupMode:'port',page:1,pageSize:12});
  const group = query.data?.items.find(group=>group.id===10);
  const [name,setName] = useState(null);
  // Explicitly reproduce the page's public component callbacks, without importing
  // its unrelated management UI. Page-level callback wiring is outside this test.
  const reset = trpc.forwardGroups.resetTraffic.useMutation({onSuccess:async()=>{
    setName(null);toast.success(t('统计流量已重置'));await utils.forwardGroups.listPage.invalidate();
  },onError:error=>toast.error(error.message || t('重置统计流量失败'))});
  return <section id="resource" className="rounded border p-3"><p>{group?.name}</p>
    <p>{t('累计流量')}: <output id="traffic-total">{group?.trafficSummary?.totalBytes}</output> B</p>
    <p>{t('当日流量')}: <output id="traffic-daily">{group?.trafficSummary?.daily.totalBytes}</output> B</p>
    <ResourceTrafficResetButton disabled={!group || reset.isPending} onClick={()=>setName(group.name)}/>
    <button id="refresh-resource" onClick={()=>query.refetch()}>{t('刷新')}</button>
    <ResourceTrafficResetDialog name={name} pending={reset.isPending} onClose={()=>setName(null)} onConfirm={()=>{if(group && !reset.isPending)reset.mutate({id:group.id})}}/>
  </section>;
}
function Probe() {
  const query = trpc.rules.latestTest.useQuery({ruleId:202},{refetchInterval:100});
  const start = trpc.rules.startSelfTest.useMutation({onSuccess:()=>query.refetch()});
  const result = query.data;
  const testing = start.isPending || result?.status==='running' || result?.status==='pending';
  const success = result?.status==='success';
  const parsed = parseLinkTestMessage(result?.message);
  const planned = [{from:'Slow entry',to:'Exit',fromHostId:1,toHostId:3,hopIndex:0,hopCount:1},
    {from:'Fast entry',to:'Exit',fromHostId:2,toHostId:3,hopIndex:0,hopCount:1},
    {from:'Exit',to:t('目标'),fromHostId:3,toHostId:null}];
  const samples = parsed.details.filter(detail=>!detail.pending).map(detail=>({latency:detail.latencyMs || 0,probeCount:1,probeSuccesses:detail.success?1:0}));
  return <section id="probe" className="min-w-0 rounded border p-3">
    <button id="start-probe" disabled={testing} onClick={()=>start.mutate({ruleId:202})}>{t('开始测试')}</button>
    <output id="probe-status">{result?.status || 'idle'}</output>
    <div id="probe-summary"><LinkTestLatencySummary parsed={parsed} fallbackLatencyMs={result?.latencyMs} isSuccess={success} isTesting={testing}/></div>
    <div id="probe-path"><LinkTestProbeView parsed={parsed} fallbackLatencyMs={result?.latencyMs} isSuccess={success} isTesting={testing}
      plannedSegments={planned} ignorePlannedResultsWhenDetailsPresent mobileStacked/></div>
    {!testing && <SelfTestEvidenceNote result={result}/>}
    <LatencyStabilityStats stats={getLatencyStabilityStats(samples,null)} counterStatistics={null}/>
  </section>;
}
const view = new URLSearchParams(location.search).get('view');
createRoot(document.getElementById('root')).render(<trpc.Provider client={client} queryClient={queryClient}><QueryClientProvider client={queryClient}><TooltipProvider><main style={{padding:16,minWidth:0}}>{view==='connections'?<Connections/>:view==='resource'?<Resource/>:<Probe/>}</main><Toaster visibleToasts={10}/></TooltipProvider></QueryClientProvider></trpc.Provider>);
`;

test("browser: resource runtime components with real management APIs and isolated SQLite", {
  skip: !fs.existsSync(chrome), timeout: 240_000,
}, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-resource-runtime-browser-"));
  const environment = {
    DATABASE_TYPE: "sqlite", DATABASE_CONFIG_PATH: path.join(directory, "database.json"),
    SQLITE_PATH: path.join(directory, "runtime.db"), FORWARDX_LOG_DIR: path.join(directory, "logs"),
    FORWARDX_JWT_SECRET_PATH: path.join(directory, "jwt-secret"), JWT_SECRET: "isolated-browser-secret-not-a-real-key",
    FORWARDX_DEV_PANEL: "0", TELEGRAM_BOT_TOKEN: "", TELEGRAM_BOT_POLLING: "false", DISCORD_BOT_TOKEN: "",
  };
  const savedEnvironment = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
  Object.assign(process.env, environment);
  // Do not import the server entry point, dotenv, schedulers or notification runners.
  const runtime = await import("../../../server/dbRuntime");
  let server: Awaited<ReturnType<typeof createServer>> | undefined;
  let httpServer: ReturnType<typeof createHttpServer> | undefined;
  let browser: ReturnType<typeof spawn> | undefined;
  let socket: WebSocket | undefined;
  let releaseReset: (() => void) | undefined;
  try {
    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: environment.SQLITE_PATH } });
    await (await import("../../../server/dbSchema")).ensureDatabaseSchema();
    const { hostsRouter } = await import("../../../server/routers/hosts");
    const { forwardGroupsRouter } = await import("../../../server/routers/forwardGroups");
    const { rulesRouter } = await import("../../../server/routers/rules");
    const { router } = await import("../../../server/_core/trpc");
    const metrics = await import("../../../server/repositories/metricsRepository");
    const connections = await import("../../../server/agentConnectionStats");
    const { registerAgentSelfTestRoutes } = await import("../../../server/agentSelfTestRoutes");
    const context = (id: number, role: "admin" | "user") => ({
      user: { id, role, username: `browser-${id}`, accountEnabled: true },
      req: { headers: {}, socket: { remoteAddress: "127.0.0.1" } }, res: {}, authSession: null, authFailureReason: null,
    } as any);
    const adminContext = context(1, "admin");
    const admin = forwardGroupsRouter.createCaller(adminContext);
    const summary = async (userId?: number) => (await metrics.getForwardGroupTrafficSummaries([10], userId)).get(10)!;
    const reportTraffic = async (ruleId: number, userId: number, bytesIn: number, bytesOut: number) => {
      await metrics.insertTrafficStatsBatch([{ stat: { ruleId, hostId: 1, bytesIn, bytesOut, connections: 1, recordedAt: new Date() }, userId }]);
    };
    // Snapshot every table that a display reset must leave untouched. Baselines
    // and audit logs are intentionally excluded, just as in the server regression.
    const accounting = async () => {
      const snapshot: Record<string, unknown> = {};
      for (const table of ["traffic_stats", "traffic_stat_buckets", "user_traffic_counters", "forward_rule_traffic_counters",
        "users", "forward_rules", "operations_traffic_daily", "traffic_billing_usage", "traffic_billing_rule_usage", "agent_traffic_reports"]) {
        snapshot[table] = await runtime.queryRaw(`SELECT * FROM "${table}" ORDER BY "id"`);
      }
      return snapshot;
    };
    const allRows = async () => {
      const tables = await runtime.queryRaw<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
      const snapshot: Record<string, unknown> = {};
      for (const { name } of tables) snapshot[name] = await runtime.queryRaw(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`);
      return snapshot;
    };
    for (const id of [1, 2, 3]) await runtime.insertAndGetId("users", {
      id, username: `browser-${id}`, password: "unused", role: id === 1 ? "admin" : "user",
      accountEnabled: 1, trafficLimit: 100000, trafficUsed: 1234, balanceCents: 5678,
    });
    for (const [id, name, online] of [[1, "Slow entry", true], [2, "Fast entry", true], [3, "Exit", true],
      [4, "Legacy Agent", true], [5, "Offline host", false], [6, "Expired sample", true]] as const) {
      await runtime.insertAndGetId("hosts", { id, name, ip: "127.0.0.1", ipv4: "127.0.0.1", userId: 1,
        isOnline: online, lastHeartbeat: online ? Math.floor(Date.now() / 1000) : 0, agentToken: `isolated-agent-${id}` });
    }
    const countSample = (total: number) => ({ version: 1, scope: "network-namespace", source: "proc-sockstat", sampledAt: Math.floor(Date.now() / 1000),
      tcp: { status: "ok", total, inUse: total - 345, timeWait: 345, ipv6Included: true },
      udp: { status: "ok", total: 0, inUse: 0, ipv6Included: false } });
    assert.equal(connections.recordAgentConnectionStats(1, countSample(12345)), true);
    assert.equal(connections.recordAgentConnectionStats(5, countSample(999)), true);
    const expiredAt = Date.now() - 901_000;
    assert.equal(connections.recordAgentConnectionStats(6, { ...countSample(888), sampledAt: Math.floor(expiredAt / 1000) }, expiredAt), true);
    await runtime.insertAndGetId("forward_groups", { id: 10, name: "Isolated port resource", groupType: "host", groupMode: "port", userId: 1, targetIp: "127.0.0.1" });
    await runtime.insertAndGetId("forward_groups", { id: 20, name: "Isolated entry group", groupType: "host", groupMode: "entry", userId: 1, isEnabled: true, targetIp: "127.0.0.1" });
    for (const hostId of [1, 2]) await runtime.insertAndGetId("forward_group_members", { groupId: 20, memberType: "host", hostId, isEnabled: true });
    for (const [id, userId] of [[101, 2], [102, 3]]) await runtime.insertAndGetId("forward_rules", {
      id, userId, name: `Accounted ${userId}`, hostId: 1, forwardGroupId: 10, sourcePort: 10000 + id,
      targetIp: "127.0.0.1", targetPort: 443, protocol: "tcp", forwardType: "gost", isEnabled: true,
    });
    await runtime.insertAndGetId("tunnels", { id: 4, userId: 1, name: "Controlled multi-entry", entryHostId: 1,
      entryGroupId: 20, exitHostId: 3, listenPort: 14003, mode: "tls", isEnabled: true });
    await runtime.insertAndGetId("forward_rules", { id: 202, userId: 1, name: "Controlled probe", hostId: 1, tunnelId: 4,
      sourcePort: 12000, targetIp: "127.0.0.1", targetPort: 443, protocol: "tcp", forwardType: "gost-tunnel" });

    const bundle = await build({ stdin: { contents: harness, loader: "tsx", resolveDir: process.cwd() }, bundle: true, write: false,
      format: "esm", platform: "browser", target: "es2022", jsx: "automatic", logLevel: "silent" });
    server = await createServer({ configFile: false, envFile: false, root: process.cwd(), envDir: directory,
      cacheDir: path.join(directory, "vite-cache"), plugins: [tailwindcss()], appType: "custom",
      resolve: { alias: { "@": path.join(process.cwd(), "client/src"), "@shared": path.join(process.cwd(), "shared") } },
      server: { middlewareMode: true, preTransformRequests: false, watch: null, hmr: false, ws: false }, optimizeDeps: { noDiscovery: true },
    });
    const apiErrors: Array<{ path?: string; code: string; message: string }> = [];
    const mutations: string[] = [];
    let resetUser = adminContext;
    let resetGate: Promise<void> | undefined;
    const api = express(); api.use(express.json());
    api.use("/api/trpc", async (req, _res, next) => {
      if (req.path.slice(1).split(",").includes("forwardGroups.resetTraffic")) await resetGate;
      next();
    });
    api.use("/api/trpc", createExpressMiddleware({
      router: router({ hosts: hostsRouter, forwardGroups: forwardGroupsRouter, rules: rulesRouter }),
      createContext: () => resetUser,
      onError: ({ path, error }) => apiErrors.push({ path, code: error.code, message: error.message }),
      responseMeta: ({ paths, type }) => { if (type === "mutation") mutations.push(...paths || []); return {}; },
    }));
    // Supply only the already-authenticated fixture identity, as the server unit
    // test does. All pull/result handling and generation settlement stay real.
    api.use((req, _res, next) => { (req as any).agentToken = req.headers["x-isolated-agent"]; next(); });
    registerAgentSelfTestRoutes(api);
    server.middlewares.use(api);
    server.middlewares.use((req, res, next) => {
      const pathname = new URL(req.url || "/", "http://127.0.0.1").pathname;
      if (pathname === "/app.js") { res.setHeader("Content-Type", "application/javascript"); res.end(bundle.outputFiles[0].text); }
      else if (pathname === "/qa") { res.setHeader("Content-Type", "text/html"); res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/client/src/index.css"><div id="root"></div><script type="module" src="/app.js"></script>'); }
      else if (pathname === "/blank") { res.setHeader("Content-Type", "text/html"); res.end("<!doctype html><title>Isolated fixture</title>"); }
      else if (pathname === "/favicon.ico") { res.statusCode = 204; res.end(); }
      else next();
    });
    httpServer = createHttpServer(server.middlewares);
    await new Promise<void>(resolve => httpServer!.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(httpServer.address() as { port: number }).port}`;
    const agentRequest = async (route: string, hostId: number, body = {}) => {
      const response = await fetch(origin + route, { method: "POST", headers: { "Content-Type": "application/json", "x-isolated-agent": `isolated-agent-${hostId}` }, body: JSON.stringify(body) });
      assert.equal(response.status, 200);
      return await response.json() as any;
    };
    const pull = async () => {
      const rows: Array<{ testId: number; hostId: number }> = [];
      for (const hostId of [1, 2, 3]) {
        const response = await agentRequest("/api/agent/selftest-pull", hostId);
        for (const task of response.selfTests) rows.push({ testId: task.testId, hostId });
      }
      assert.deepEqual(rows.map(row => row.hostId), [1, 2, 3]);
      return rows;
    };
    const report = (row: { testId: number; hostId: number }, latencyMs: number, targetReachable = true) =>
      agentRequest("/api/agent/selftest-result", row.hostId, { testId: row.testId, latencyMs, targetReachable });

    browser = spawn(chrome, ["--headless=new", "--no-sandbox", "--disable-gpu", "--disable-background-networking", "--disable-component-update",
      "--disable-sync", "--no-first-run", "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0",
      `--user-data-dir=${path.join(directory, "chrome")}`, "about:blank"], { stdio: "ignore" });
    const portFile = path.join(directory, "chrome/DevToolsActivePort");
    for (let count = 0; count < 150 && !fs.existsSync(portFile); count++) await delay(50);
    assert.ok(fs.existsSync(portFile), "isolated Chrome started");
    const port = fs.readFileSync(portFile, "utf8").split("\n")[0];
    const page = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json() as { webSocketDebuggerUrl: string };
    socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      socket!.addEventListener("open", () => resolve(), { once: true });
      socket!.addEventListener("error", () => reject(new Error("CDP connection failed")), { once: true });
    });
    let nextId = 0;
    const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
    const browserErrors: string[] = [];
    const blockedExternalRequests: string[] = [];
    const command = (method: string, params: Record<string, unknown> = {}): Promise<any> => new Promise((resolve, reject) => {
      const id = ++nextId; pending.set(id, { resolve, reject }); socket!.send(JSON.stringify({ id, method, params }));
    });
    socket.addEventListener("message", event => {
      const message = JSON.parse(String(event.data));
      if (message.method === "Runtime.exceptionThrown") browserErrors.push(JSON.stringify(message.params.exceptionDetails));
      if (message.method === "Fetch.requestPaused") {
        const external = !message.params.request.url.startsWith(origin + "/");
        if (external) blockedExternalRequests.push(message.params.request.url);
        void command(external ? "Fetch.failRequest" : "Fetch.continueRequest", {
          requestId: message.params.requestId, ...(external ? { errorReason: "BlockedByClient" } : {}),
        }).catch(error => browserErrors.push(String(error)));
      }
      if (!message.id) return;
      const handler = pending.get(message.id); pending.delete(message.id);
      if (message.error) handler?.reject(new Error(JSON.stringify(message.error))); else handler?.resolve(message.result);
    });
    const evaluate = async (expression: string): Promise<any> => {
      const result = await command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result?.value;
    };
    const until = async (expression: string) => {
      const deadline = Date.now() + 10_000;
      // Conditions can end in querySelector(). Coerce in the browser so CDP
      // never tries to serialize a DOM node (and React's attached object graph).
      while (Date.now() < deadline) { if (await evaluate(`!!(${expression})`)) return; await delay(30); }
      assert.fail(`browser condition timed out: ${expression}\n${await evaluate("document.body.innerText")}\n${JSON.stringify(apiErrors)}\n${browserErrors.join("\n")}`);
    };
    const click = async (expression: string) => {
      // Hit testing and settled coordinates are required; never use DOM.click().
      const pointExpression = `(() => {const el=${expression};if(!el || el.disabled)return null;el.scrollIntoView({block:'center',inline:'center',behavior:'instant'});const r=el.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;return r.width && r.height && el.contains(document.elementFromPoint(x,y))?{x,y}:null;})()`;
      await until(pointExpression);
      let point = await evaluate(pointExpression);
      let settled = false;
      for (let count = 0; count < 100; count++) {
        await delay(60); const next = await evaluate(pointExpression);
        if (next && point && Math.abs(next.x - point.x) < 0.5 && Math.abs(next.y - point.y) < 0.5) { point = next; settled = true; break; }
        point = next;
      }
      assert.ok(point && settled, `pointer target is visible and settled: ${expression}`);
      await command("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
      await command("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...point });
      await command("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...point });
    };
    const translated = (source: string) => `window.qa.t(${JSON.stringify(source)})`;
    const dialog = `document.querySelector('[role="dialog"][data-state="open"]')`;
    const button = (source: string, scope = "document") => `Array.from((${scope}).querySelectorAll('button')).find(el=>el.textContent.trim()===${translated(source)})`;
    const resetButton = `document.querySelector('#resource button[aria-label]')`;
    const readable = async (selector: string) => {
      // Inspect actual rendered text boxes, including wrapping/clipping and both
      // responsive variants. Hidden desktop/mobile trees do not count as visible.
      const failures = await evaluate(`(() => {const root=document.querySelector(${JSON.stringify(selector)}),bad=[];const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);while(walker.nextNode()){const n=walker.currentNode;if(!n.textContent.trim())continue;const el=n.parentElement;if(el.closest('.sr-only') || !el.getClientRects().length || getComputedStyle(el).visibility==='hidden')continue;const range=document.createRange();range.selectNodeContents(n);for(const r of range.getClientRects()){if(!r.width || !r.height)continue;let clipped=r.left < -1 || r.right > innerWidth+1;for(let p=el;p && p!==root.parentElement;p=p.parentElement){if(['hidden','clip','auto','scroll'].includes(getComputedStyle(p).overflowX)){const b=p.getBoundingClientRect();clipped ||= r.left<b.left-2 || r.right>b.right+2;}}if(clipped)bad.push(n.textContent.trim());}}return bad;})()`);
      assert.deepEqual(failures, [], `visible text is readable within ${selector}`);
      assert.equal(await evaluate("document.documentElement.scrollWidth<=innerWidth+1"), true, "no document horizontal overflow");
    };
    const navigate = async (language: string, width: number, view: string) => {
      resetUser = adminContext;
      await command("Page.navigate", { url: origin + "/blank" });
      await until("document.title==='Isolated fixture'");
      await evaluate("localStorage.clear()");
      await command("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: width === 390 });
      await command("Page.navigate", { url: `${origin}/qa?lang=${language}&view=${view}` });
      await until(`!!window.qa && !!document.querySelector('#${view === "connections" ? "connections" : view === "resource" ? "resource" : "probe"}')`);
    };
    await command("Runtime.enable");
    await command("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
    t.diagnostic(`${(await command("Browser.getVersion")).product}; Node ${process.version}; SQLite ${(await runtime.queryRaw<any>("SELECT sqlite_version() AS version"))[0].version}; controlled Agent reports, no external forwarding`);

    for (const language of ["en", "zh-CN"]) for (const width of [1280, 390]) {
      await t.test(`${language}, ${width}px: host query supplies TCP/UDP, absent/offline/expired never become zero`, async () => {
        await navigate(language, width, "connections");
        const cell = (id: number, protocol: string) => `document.querySelector('[data-host="${id}"] [data-protocol="${protocol}"] span')`;
        await until(`${cell(1, "tcp")}?.textContent==='12,345'`);
        assert.equal(await evaluate(`${cell(1, "udp")}.textContent`), "0");
        const tcpTitle = await evaluate(`${cell(1, "tcp")}.title`);
        assert.ok(tcpTitle.includes("12,000") && tcpTitle.includes("345") && tcpTitle.includes("IPv4 / IPv6"));
        assert.ok(tcpTitle.includes(await evaluate("window.qa.t('采样时间：{0}', [''])")));
        assert.equal(await evaluate(`${cell(1, "udp")}.title.includes(${translated("UDP 套接字数：{0}，不代表远端客户端数量")}.replace('{0}','0'))`), true);
        for (const id of [4, 5, 6]) for (const protocol of ["tcp", "udp"]) assert.equal(await evaluate(`${cell(id, protocol)}.textContent`), "—");
        assert.ok((await evaluate(`${cell(4, "tcp")}.title`)).includes(await evaluate(translated("尚未收到连接数，请确认 Agent 已更新并等待心跳"))));
        assert.ok((await evaluate(`${cell(5, "tcp")}.title`)).includes(await evaluate(translated("主机离线，连接数不可用"))));
        await readable("#connections");
        if (language === "en") assert.doesNotMatch(await evaluate("Array.from(document.querySelectorAll('#connections [title]')).map(el=>el.title).join(' ')"), /\p{Script=Han}/u);
        assert.equal(connections.recordAgentConnectionStats(1, countSample(12346)), true);
        await click("document.querySelector('#refresh-hosts')");
        await until(`${cell(1, "tcp")}.textContent==='12,346'`);
        assert.equal(connections.recordAgentConnectionStats(1, countSample(12345)), true);
      });

      await t.test(`${language}, ${width}px: reset cancel, pending, confirm, new traffic and real permission failure`, async () => {
        await reportTraffic(101, 2, 100, 200); await reportTraffic(102, 3, 30, 40);
        await navigate(language, width, "resource");
        const initial = (await summary()).totalBytes;
        await until(`document.querySelector('#traffic-total').textContent==='${initial}'`);
        const beforeCancel = await allRows();
        const mutationStart = mutations.length;
        await click(resetButton); await until(`!!${dialog}`);
        await readable('[role="dialog"]');
        await click(button("取消", dialog)); await until(`!${dialog}`);
        assert.deepEqual(await allRows(), beforeCancel, "cancel does not change any SQLite table");
        assert.equal(mutations.length, mutationStart, "cancel makes no mutation request");

        await click(resetButton); await until(`!!${dialog}`);
        const beforeReset = await accounting();
        resetGate = new Promise<void>(resolve => { releaseReset = resolve; });
        await click(button("确认重置", dialog));
        await until(`(${button("确认重置", dialog)})?.disabled && (${button("取消", dialog)})?.disabled`);
        assert.deepEqual(await accounting(), beforeReset);
        assert.equal((await summary()).totalBytes, initial);
        releaseReset!(); releaseReset = undefined; resetGate = undefined;
        await until(`!${dialog} && document.querySelector('#traffic-total').textContent==='0' && document.querySelector('#traffic-daily').textContent==='0'`);
        await until(`document.body.innerText.includes(${translated("统计流量已重置")})`);
        assert.deepEqual(await accounting(), beforeReset, "display reset preserves actual counters, quotas, billing, history and rule state");
        for (const userId of [undefined, 2, 3]) assert.equal((await summary(userId)).totalBytes, 0);
        await reportTraffic(101, 2, 5, 7); await reportTraffic(102, 3, 3, 4);
        assert.equal((await summary()).totalBytes, 19);
        // The real page polls; displayQueries intentionally returns cached/stale
        // totals briefly. Repeat normal refresh clicks across that cache lifetime
        // instead of clearing the production cache or changing its clock.
        for (let count = 0; count < 40; count++) {
          await click("document.querySelector('#refresh-resource')");
          if (await evaluate("document.querySelector('#traffic-total').textContent==='19'")) break;
          await delay(150);
        }
        await until("document.querySelector('#traffic-total').textContent==='19' && document.querySelector('#traffic-daily').textContent==='19'");
        assert.equal((await summary(2)).totalBytes, 12); assert.equal((await summary(3)).totalBytes, 7);
        await readable("#resource");

        await evaluate("window.qa.dismissToasts()");
        await until("!document.querySelector('[data-sonner-toast][data-visible=true]')");
        const beforeFailure = await allRows();
        const errorStart = apiErrors.length;
        // Change only the authenticated fixture identity. The real adminProcedure
        // rejects the same HTTP mutation; this is not an injected error response.
        resetUser = context(2, "user");
        await click(resetButton); await until(`!!${dialog}`); await click(button("确认重置", dialog));
        await until(`!!${dialog} && !(${button("确认重置", dialog)})?.disabled && document.querySelector('[data-sonner-toast][data-type="error"]')`);
        assert.deepEqual(apiErrors.slice(errorStart).map(error => [error.path, error.code]), [["forwardGroups.resetTraffic", "FORBIDDEN"]]);
        assert.ok((await evaluate("document.querySelector('[data-sonner-toast][data-type=error]').innerText")).includes(apiErrors.at(-1)!.message));
        assert.equal(await evaluate(`document.body.innerText.includes(${translated("统计流量已重置")})`), false);
        assert.deepEqual(await allRows(), beforeFailure, "a forbidden reset leaves SQLite unchanged");
        assert.equal((await summary()).totalBytes, 19);
        await readable('[role="dialog"]');
        await click(button("取消", dialog)); await until(`!${dialog}`);
        resetUser = adminContext;
      });

      await t.test(`${language}, ${width}px: real self-test API publishes fast paths before slow entry and honest final evidence`, async () => {
        await navigate(language, width, "probe");
        await until("!!document.querySelector('#start-probe') && !document.querySelector('#start-probe').disabled");
        await click("document.querySelector('#start-probe')");
        await until("document.querySelector('#probe-status').textContent==='running'");
        const rows = await pull();
        await until(`document.querySelector('#probe-summary').innerText===${translated("正在测试中")}`);
        assert.equal(await evaluate("!!document.querySelector('#probe-path .animate-spin')"), true);
        await report(rows[1], 8); await report(rows[2], 1);
        await until("document.querySelector('#probe-path').innerText.includes('8 ms') && document.querySelector('#probe-path').innerText.includes('1 ms')");
        assert.equal(await evaluate("document.querySelector('#probe-status').textContent"), "running");
        assert.equal(await evaluate("document.querySelector('#probe-summary').innerText"), await evaluate(translated("正在测试中")));
        assert.equal(await evaluate("!!document.querySelector('#probe-path .animate-spin')"), true, "slow entry remains pending beside completed fast/target results");
        assert.equal(await evaluate("document.querySelector('#probe-path').innerText.includes('6 ms')"), false);
        await readable("#probe");
        await report(rows[0], 6);
        await until("document.querySelector('#probe-status').textContent==='success' && !document.querySelector('#probe-path .animate-spin')");
        for (const value of ["6 ms", "8 ms", "1 ms", "9 ms"]) assert.ok((await evaluate("document.querySelector('#probe-path').innerText")).includes(value), value);
        await until(`document.querySelector('#probe-summary').innerText.includes('9ms') && document.querySelector('[role=note]')?.innerText.includes(${translated("目标连接成功")})`);
        const successLabels = await evaluate("document.querySelector('#probe-path').innerText + document.querySelector('#probe-summary').innerText");
        const evidence = await evaluate("document.querySelector('[role=note]').innerText");
        for (const label of ["检测来源到目标", "外部经入口的转发路径", "未验证"]) assert.ok(evidence.includes(await evaluate(translated(label))), label);
        // Manual report details are not cumulative Agent counters. Preserve the
        // production unavailable-counter explanation instead of inventing a rate.
        const stats = await evaluate("document.querySelector('[data-latency-stats]').innerText");
        assert.ok(stats.includes("8 ms") && stats.includes("1 ms") && stats.includes("5 ms"));
        assert.ok(stats.includes(await evaluate(translated("暂无累计探测统计，请升级 Agent 并等待上报。旧记录省略了稳定成功探测，无法准确计算失败率与稳定性。"))));
        assert.doesNotMatch(stats, /\d+(?:\.\d+)?%|\d+\/100/);
        await readable("#probe");
        if (language === "en") assert.doesNotMatch(evidence + stats, /\p{Script=Han}/u);

        await click("document.querySelector('#start-probe')");
        await until("document.querySelector('#probe-status').textContent==='running' && !document.querySelector('#probe-path').innerText.includes('8 ms')");
        const failedRows = await pull();
        for (const row of failedRows) await report(row, 0, false);
        await until(`document.querySelector('#probe-status').textContent==='failed' && document.querySelector('[role=note]')?.innerText.includes(${translated("目标连接失败")})`);
        assert.equal(await evaluate("!!document.querySelector('#probe-path .animate-spin')"), false);
        assert.ok((await evaluate("document.querySelector('[role=note]').innerText")).includes(await evaluate(translated("未验证"))));
        await readable("#probe");
        if (language === "en") assert.doesNotMatch(successLabels, /\p{Script=Han}/u,
          "English self-test path/summary must localize server-generated target labels");
      });
    }
    assert.equal(apiErrors.length, 4, "only the four intentional real permission denials occurred");
    assert.deepEqual(browserErrors, [], "no uncaught browser exceptions");
    assert.deepEqual(blockedExternalRequests, [], "the page requested only its isolated loopback origin");
    assert.equal((await admin.listPage({ groupMode: "port", page: 1, pageSize: 12 })).items.find(group => group.id === 10)?.trafficSummary?.totalBytes, 19);
  } finally {
    releaseReset?.();
    socket?.close();
    if (browser && browser.exitCode === null) {
      const exited = new Promise<void>(resolve => browser!.once("exit", () => resolve()));
      browser.kill(); await exited;
    }
    if (httpServer) await new Promise<void>((resolve, reject) => httpServer!.close(error => error ? reject(error) : resolve()));
    await server?.close(); await runtime.closeDatabase();
    for (const [key, value] of Object.entries(savedEnvironment)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
