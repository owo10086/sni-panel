import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { build } from "esbuild";
import { createServer } from "vite";
import tailwindcss from "@tailwindcss/vite";
import express from "express";
import { createExpressMiddleware } from "@trpc/server/adapters/express";

const chrome = process.env.CHROME_BIN || (process.platform === "darwin"
  ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "/usr/bin/chromium");
const harness = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { httpBatchLink } from '@trpc/client';
import superjson from 'superjson';
import { trpc } from './client/src/lib/trpc';
import { ConfirmDialogProvider } from './client/src/components/ui/confirm-dialog';
import { Toaster } from 'sonner';
import { initializeLanguage, setLanguagePreference, t } from './client/src/i18n';
setLanguagePreference(new URLSearchParams(location.search).get('lang') || 'en');
await initializeLanguage();
// Import after locale initialization: the real page has translated tab constants.
const {default: Plans} = await import('./client/src/pages/Plans');
const queryClient = new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});
const client = trpc.createClient({links:[httpBatchLink({url:'/api/trpc',transformer:superjson})]});
window.qa = {t};
createRoot(document.getElementById('root')).render(<trpc.Provider client={client} queryClient={queryClient}><QueryClientProvider client={queryClient}><ConfirmDialogProvider><Plans/><Toaster/></ConfirmDialogProvider></QueryClientProvider></trpc.Provider>);
`;

test("browser: real Plans page and embedded metered manager preserve both views and management actions", { skip: !fs.existsSync(chrome), timeout: 180_000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-plan-billing-browser-"));
  process.env.DATABASE_TYPE = "sqlite";
  process.env.DATABASE_CONFIG_PATH = path.join(directory, "database.json");
  process.env.SQLITE_PATH = path.join(directory, "products.db");
  process.env.FORWARDX_LOG_DIR = path.join(directory, "logs");
  process.env.TELEGRAM_BOT_TOKEN = "";
  process.env.DISCORD_BOT_TOKEN = "";
  const runtime = await import("../../../server/dbRuntime");
  let server: Awaited<ReturnType<typeof createServer>> | undefined;
  let browser: ReturnType<typeof spawn> | undefined;
  let socket: WebSocket | undefined;
  try {
    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.SQLITE_PATH } });
    await (await import("../../../server/dbSchema")).ensureDatabaseSchema();
    const { plansRouter } = await import("../../../server/routers/plans");
    const { trafficBillingRouter } = await import("../../../server/routers/trafficBilling");
    const { hostsRouter } = await import("../../../server/routers/hosts");
    const { tunnelsRouter } = await import("../../../server/routers/tunnels");
    const { forwardGroupsRouter } = await import("../../../server/routers/forwardGroups");
    const { router } = await import("../../../server/_core/trpc");
    // Only authentication and the navigation shell are fixtures. The complete
    // Plans page, embedded TrafficBillingConfigManager and all CRUD APIs are real.
    const context = { user: { id: 1, username: "isolated-admin", role: "admin", accountEnabled: true }, req: { headers: {}, socket: {} }, res: {}, authSession: null, authFailureReason: null } as any;
    const plans = plansRouter.createCaller(context);
    const billing = trafficBillingRouter.createCaller(context);
    for (const id of [1, 2, 3]) await runtime.insertAndGetId("users", { id, username: `browser-${id}`, password: "unused", role: id === 1 ? "admin" : "user" });
    await runtime.insertAndGetId("hosts", { id: 1, name: "Isolated host", ip: "192.0.2.1", userId: 1 });
    for (const id of [1, 2, 3]) {
      await runtime.insertAndGetId("forward_groups", { id, name: `Port resource ${id}`, targetIp: "192.0.2.10", groupType: "host", groupMode: "port", userId: 1 });
      await runtime.insertAndGetId("forward_group_members", { groupId: id, memberType: "host", hostId: 1 });
    }
    const bundle = await build({ stdin: { contents: harness, loader: "tsx", resolveDir: process.cwd() }, bundle: true, write: false,
      format: "esm", platform: "browser", target: "es2022", jsx: "automatic", logLevel: "silent",
      plugins: [{ name: "isolated-navigation-shell", setup(build) {
        build.onResolve({ filter: /\/DashboardLayout$/ }, () => ({ path: "shell", namespace: "qa-shell" }));
        build.onLoad({ filter: /.*/, namespace: "qa-shell" }, () => ({ contents: "export default function Shell({children}) { return <main style={{padding:16,minWidth:0}}>{children}</main> }", loader: "tsx", resolveDir: process.cwd() }));
      } }],
    });
    server = await createServer({ configFile: false, root: process.cwd(), cacheDir: path.join(directory, "vite-cache"), plugins: [tailwindcss()], appType: "custom",
      resolve: { alias: { "@": path.join(process.cwd(), "client/src"), "@shared": path.join(process.cwd(), "shared") } },
      server: { host: "127.0.0.1", port: 0, preTransformRequests: false, watch: null, hmr: false }, optimizeDeps: { noDiscovery: true },
    });
    const api = express(); api.use(express.json());
    const apiErrors: string[] = [];
    const mutations: string[] = [];
    api.use("/api/trpc", createExpressMiddleware({
      router: router({ plans: plansRouter, trafficBilling: trafficBillingRouter, hosts: hostsRouter, tunnels: tunnelsRouter, forwardGroups: forwardGroupsRouter }),
      createContext: () => context,
      onError: ({ error, path }) => apiErrors.push(`${path}: ${error.message}`),
      responseMeta: ({ paths, type }) => { if (type === "mutation") mutations.push(...paths || []); return {}; },
    }));
    server.middlewares.use(api);
    server.middlewares.use((req, res, next) => {
      const pathname = new URL(req.url || "/", "http://localhost").pathname;
      if (pathname === "/app.js") { res.setHeader("Content-Type", "application/javascript"); res.end(bundle.outputFiles[0].text); }
      else if (pathname === "/qa") { res.setHeader("Content-Type", "text/html"); res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/client/src/index.css"><div id="root"></div><script type="module" src="/app.js"></script>'); }
      else if (pathname === "/blank") { res.setHeader("Content-Type", "text/html"); res.end("<!doctype html><title>Isolated fixture</title>"); }
      else next();
    });
    await server.listen();
    const origin = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}`;
    browser = spawn(chrome, ["--headless=new", "--no-sandbox", "--disable-gpu", "--disable-background-networking", "--no-first-run", "--remote-debugging-port=0", `--user-data-dir=${path.join(directory, "chrome")}`, "about:blank"], { stdio: "ignore" });
    const portFile = path.join(directory, "chrome/DevToolsActivePort");
    for (let count = 0; count < 150 && !fs.existsSync(portFile); count++) await delay(50);
    assert.ok(fs.existsSync(portFile), "isolated Chrome started");
    const port = fs.readFileSync(portFile, "utf8").split("\n")[0];
    const page = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json() as { webSocketDebuggerUrl: string };
    socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => { socket!.addEventListener("open", () => resolve(), { once: true }); socket!.addEventListener("error", () => reject(new Error("CDP connection failed")), { once: true }); });
    let nextId = 0;
    const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
    const browserErrors: string[] = [];
    socket.addEventListener("message", event => {
      const message = JSON.parse(String(event.data));
      if (message.method === "Runtime.exceptionThrown") browserErrors.push(JSON.stringify(message.params.exceptionDetails));
      if (message.method === "Fetch.requestPaused") {
        const url = message.params.request.url;
        void command(url.startsWith(origin + "/") ? "Fetch.continueRequest" : "Fetch.failRequest", { requestId: message.params.requestId, ...(url.startsWith(origin + "/") ? {} : { errorReason: "BlockedByClient" }) });
      }
      if (!message.id) return;
      const handler = pending.get(message.id); pending.delete(message.id);
      if (message.error) handler?.reject(new Error(JSON.stringify(message.error))); else handler?.resolve(message.result);
    });
    const command = (method: string, params: Record<string, unknown> = {}): Promise<any> => new Promise((resolve, reject) => {
      const id = ++nextId; pending.set(id, { resolve, reject }); socket!.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async (expression: string): Promise<any> => {
      const result = await command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result?.value;
    };
    const until = async (expression: string) => {
      for (let count = 0; count < 180; count++) { if (await evaluate(expression)) return; await delay(30); }
      assert.fail(`browser condition timed out: ${expression}\n${await evaluate("document.body.innerText")}\n${apiErrors.join("\n")}\n${browserErrors.join("\n")}`);
    };
    const click = async (expression: string) => {
      // Wait for closing dialog overlays and layout transitions before sending
      // real pointer events. A DOM .click() would bypass those browser barriers.
      const pointExpression = `(() => {const el=${expression}; if(!el) return null;el.scrollIntoView({block:'center',inline:'center',behavior:'instant'});const r=el.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y);return el.contains(hit) ? {x,y} : null;})()`;
      await until(pointExpression);
      const point = await evaluate(pointExpression);
      await command("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
      await command("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...point });
      await command("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...point });
    };
    const translated = (source: string) => `window.qa.t(${JSON.stringify(source)})`;
    const button = (attribute: string, source: string) => `Array.from(document.querySelectorAll('button')).find(el=>el.getAttribute(${JSON.stringify(attribute)})===${translated(source)})`;
    const items = `Array.from(document.querySelectorAll('[class~="group/sortable"]'))`;
    const item = (name: string) => `${items}.find(el=>el.textContent.includes(${JSON.stringify(name)}))`;
    const edit = (name: string, label: string) => click(`${item(name)}.querySelector('button[aria-label="'+${translated(label)}+'"]')`);
    const fill = async (expression: string, value: string) => {
      await evaluate(`(() => {const el=${expression};el.focus();el.select();})()`);
      await command("Input.insertText", { text: value });
    };
    const field = (label: string) => `(() => {const label=Array.from(document.querySelectorAll('[role="dialog"] label')).find(el=>el.textContent.trim()===${translated(label)});return label.htmlFor ? document.getElementById(label.htmlFor) : label.parentElement.querySelector('input');})()`;
    const key = async (value: string, code = value) => {
      await command("Input.dispatchKeyEvent", { type: "keyDown", key: value, code });
      await command("Input.dispatchKeyEvent", { type: "keyUp", key: value, code });
    };
    const reorder = async (first: string, second: string) => {
      await evaluate(`${item(first)}.scrollIntoView({block:'start',behavior:'instant'})`);
      await evaluate(`${item(first)}.querySelector('button[aria-roledescription="sortable"]').focus()`);
      await key(" ", "Space"); await delay(70);
      const direction = await evaluate(`(() => {const a=${item(first)}.getBoundingClientRect(),b=${item(second)}.getBoundingClientRect();return Math.abs(a.top-b.top)<10?'ArrowRight':'ArrowDown';})()`);
      await key(direction); await delay(90); await key(" ", "Space");
      await until(`${items}[0]?.textContent.includes(${JSON.stringify(second)})`);
    };
    const stock = async (name: string, used: number, limit: number) => {
      const badge = `${item(name)}.querySelector('[title="'+window.qa.t('已占用 {0} / 总量 {1}',[${used},${JSON.stringify(limit || "∞")}])+'"]')`;
      await until(`!!${badge}`);
      assert.equal(await evaluate(`${badge}.textContent`), `${await evaluate(translated("库存"))}：${limit ? Math.max(0, limit - used) : "∞"}`);
    };
    const view = async (mode: "card" | "table") => {
      await click(button("title", mode === "card" ? "卡片视图" : "列表视图"));
      await until(mode === "table" ? "!!document.querySelector('table tbody tr')" : "!document.querySelector('table') && !!document.querySelector('.standard-card-grid')");
    };
    await command("Runtime.enable");
    await command("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
    const version = await command("Browser.getVersion");
    t.diagnostic(`${version.product}; SQLite ${(await runtime.queryRaw<any>("SELECT sqlite_version() AS version"))[0].version}`);

    for (const language of ["en", "zh-CN"]) for (const width of [1280, 390]) await t.test(`${language}, ${width}px: table/card CRUD, sorting, stock and persisted preferences`, async () => {
      await command("Page.navigate", { url: origin + "/blank" });
      await until("document.title==='Isolated fixture'");
      await evaluate(`localStorage.clear();localStorage.setItem('forwardx.plans.viewMode','table');localStorage.setItem('forwardx.trafficBilling.configs.viewMode','table')`);
      await runtime.executeRaw("DELETE FROM forward_rules");
      for (const config of (await billing.configs()).configs) await billing.deleteConfig({ id: config.id });
      for (const plan of await plans.list()) await plans.delete({ id: plan.id });
      const planA = await plans.create({ name: "Alpha Plan", priceCents: 1234, stockLimit: 7, sortOrder: 0, forwardGroupIds: [1], portCount: 12 });
      await plans.create({ name: "Beta Plan", priceCents: 2000, stockLimit: 0, sortOrder: 1, forwardGroupIds: [2] });
      await plans.create({ name: "Disposable Plan", priceCents: 3000, stockLimit: 1, sortOrder: 2, forwardGroupIds: [3] });
      // Existing occupancy is fixture data; all management operations use APIs.
      await runtime.executeRaw("UPDATE subscription_plans SET stockUsed = 2 WHERE id = ?", [planA.id]);
      const configA = await billing.saveConfig({ name: "Alpha Meter", resourceType: "forward_group", resourceId: 1, pricePerGbMilliCents: 12300, stockLimit: 9, maxRulesPerUser: 5 });
      const configB = await billing.saveConfig({ name: "Beta Meter", resourceType: "forward_group", resourceId: 2, pricePerGbMilliCents: 20000, stockLimit: 0 });
      const configC = await billing.saveConfig({ name: "Disposable Meter", resourceType: "forward_group", resourceId: 3, pricePerGbMilliCents: 30000, stockLimit: 1 });
      await billing.reorder({ ids: [configA.id, configB.id, configC.id] });
      for (const id of [2, 3]) await runtime.insertAndGetId("forward_rules", { name: `Occupied ${id}`, userId: id, hostId: 1, forwardGroupId: 1, sourcePort: 20000 + id, targetIp: "192.0.2.20", targetPort: 80, protocol: "tcp", forwardType: "realm", isEnabled: false });
      apiErrors.length = 0; mutations.length = 0; browserErrors.length = 0;
      await command("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: width === 390 });
      const url = `${origin}/qa?lang=${language}&tab=plans`;
      await command("Page.navigate", { url });
      await until(`!!window.qa && document.querySelector('h1')?.textContent===${translated("套餐管理")} && document.querySelectorAll('table tbody tr').length===3`);
      await stock("Alpha Plan", 2, 7); await stock("Beta Plan", 0, 0);
      await edit("Alpha Plan", "编辑套餐");
      await until("!!document.querySelector('[role=dialog]')");
      await fill(field("套餐名称"), "Edited Plan"); await fill(field("库存总量"), "8");
      await click(`Array.from(document.querySelectorAll('[role="dialog"] button')).find(el=>el.textContent.trim()===${translated("保存")})`);
      await until(`!document.querySelector('[role=dialog]') && ${items}.some(el=>el.textContent.includes('Edited Plan'))`);
      assert.equal((await plans.list()).find(plan => plan.id === planA.id)?.stockLimit, 8);
      await stock("Edited Plan", 2, 8);
      await view("card"); await stock("Edited Plan", 2, 8); await stock("Beta Plan", 0, 0);
      await reorder("Edited Plan", "Beta Plan");
      await until(`!Array.from(document.querySelectorAll('button')).some(el=>el.title===${translated("正在保存排序")})`);
      assert.equal((await plans.list())[0].name, "Beta Plan");
      await edit("Disposable Plan", "删除");
      await until(`${items}.length===2 && !document.body.textContent.includes('Disposable Plan')`);
      assert.equal((await plans.list()).length, 2);
      await view("table"); await stock("Edited Plan", 2, 8);
      await command("Page.reload"); await until("document.querySelectorAll('table tbody tr').length===2");
      assert.equal(await evaluate("localStorage.getItem('forwardx.plans.viewMode')"), "table");
      await view("card"); await command("Page.reload");
      await until(`!document.querySelector('table') && ${items}.length===2`);
      await stock("Edited Plan", 2, 8);
      assert.equal(await evaluate("document.documentElement.scrollWidth<=innerWidth+1"), true, "cards fit the viewport");

      await click(`Array.from(document.querySelectorAll('button')).find(el=>el.textContent.trim()===${translated("按量计费资源")})`);
      await until("document.querySelectorAll('table tbody tr').length===3");
      await stock("Alpha Meter", 2, 9); await stock("Beta Meter", 0, 0);
      await edit("Alpha Meter", "编辑计费资源"); await until("!!document.querySelector('#billing-config-name')");
      await fill("document.querySelector('#billing-config-name')", "Edited Meter"); await fill(field("库存总量"), "10");
      await click(`Array.from(document.querySelectorAll('[role="dialog"] button')).find(el=>el.textContent.trim()===${translated("保存")})`);
      await until(`!document.querySelector('[role=dialog]') && ${items}.some(el=>el.textContent.includes('Edited Meter'))`);
      assert.equal((await billing.configs()).configs.find((config: any) => config.id === configA.id)?.stockLimit, 10);
      await stock("Edited Meter", 2, 10);
      await view("card"); await stock("Edited Meter", 2, 10); await stock("Beta Meter", 0, 0);
      await reorder("Edited Meter", "Beta Meter");
      await until(`!Array.from(document.querySelectorAll('button')).some(el=>el.title===${translated("正在保存排序")})`);
      assert.equal((await billing.configs()).configs[0].name, "Beta Meter");
      await edit("Disposable Meter", "删除"); await until(`${items}.length===2 && !document.body.textContent.includes('Disposable Meter')`);
      assert.equal((await billing.configs()).configs.length, 2);
      await view("table"); await stock("Edited Meter", 2, 10);
      await command("Page.reload"); await until("document.querySelectorAll('table tbody tr').length===2");
      assert.equal(await evaluate("localStorage.getItem('forwardx.trafficBilling.configs.viewMode')"), "table");
      assert.equal(await evaluate("localStorage.getItem('forwardx.plans.viewMode')"), "card");
      await view("card"); await command("Page.reload");
      await until(`!document.querySelector('table') && ${items}.length===2`);
      await stock("Edited Meter", 2, 10);
      assert.equal(await evaluate("document.documentElement.scrollWidth<=innerWidth+1"), true, "metered cards fit the viewport");
      assert.deepEqual(apiErrors, []); assert.deepEqual(browserErrors, []);
      for (const mutation of ["plans.update", "plans.reorder", "plans.delete", "trafficBilling.saveConfig", "trafficBilling.reorder", "trafficBilling.deleteConfig"]) assert.ok(mutations.includes(mutation), `${mutation} came from the browser`);
    });
  } finally {
    socket?.close(); browser?.kill();
    if (browser && browser.exitCode === null) await new Promise<void>(resolve => { browser!.once("exit", () => resolve()); setTimeout(resolve, 3000).unref(); });
    await server?.close(); await runtime.closeDatabase();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
