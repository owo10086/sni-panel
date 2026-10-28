import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createServer as createHttpServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { build } from "esbuild";
import { createServer } from "vite";
import tailwindcss from "@tailwindcss/vite";
import express from "express";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import type { RuleTaskAction, RuleTaskSnapshot } from "../../../shared/ruleTaskQueue";

const chrome = process.env.CHROME_BIN || (process.platform === "darwin"
  ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "/usr/bin/chromium");
const harness = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {httpBatchLink} from '@trpc/client';
import superjson from 'superjson';
import {useLocation} from 'wouter';
import {trpc} from './client/src/lib/trpc';
import {ConfirmDialogProvider} from './client/src/components/ui/confirm-dialog';
import {TooltipProvider} from './client/src/components/ui/tooltip';
import RuleTaskNotifications from './client/src/components/RuleTaskNotifications';
import {Toaster} from './client/src/components/ui/sonner';
import {initializeLanguage, setLanguagePreference, t} from './client/src/i18n';
setLanguagePreference(new URLSearchParams(location.search).get('lang') || 'en');
await initializeLanguage();
const {default: Rules} = await import('./client/src/pages/Rules');
const queryClient = new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});
const client = trpc.createClient({links:[httpBatchLink({url:'/api/trpc',transformer:superjson})]});
window.qa = {t};
function App() {
  const [route] = useLocation();
  return <><Toaster/><RuleTaskNotifications/>{route === '/other' ? <main id="other-page">Other page</main> : <Rules/>}</>;
}
createRoot(document.getElementById('root')).render(<trpc.Provider client={client} queryClient={queryClient}><QueryClientProvider client={queryClient}><TooltipProvider><ConfirmDialogProvider><App/></ConfirmDialogProvider></TooltipProvider></QueryClientProvider></trpc.Provider>);
`;

test("browser: real Rules tasks, global notifications, router, queue and isolated SQLite", {
  skip: !fs.existsSync(chrome), timeout: 240_000,
}, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-rules-tasks-browser-"));
  const environment = { DATABASE_TYPE: "sqlite", DATABASE_CONFIG_PATH: path.join(directory, "database.json"),
    SQLITE_PATH: path.join(directory, "rules.db"), FORWARDX_LOG_DIR: path.join(directory, "logs"),
    FORWARDX_JWT_SECRET_PATH: path.join(directory, "jwt-secret"), FORWARDX_DEV_PANEL: "0",
    TELEGRAM_BOT_TOKEN: "", TELEGRAM_BOT_POLLING: "false", DISCORD_BOT_TOKEN: "" };
  const savedEnvironment = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
  Object.assign(process.env, environment);
  // No server entry point or dotenv import: only this temporary database is opened.
  const runtime = await import("../../../server/dbRuntime");
  let server: Awaited<ReturnType<typeof createServer>> | undefined;
  let httpServer: ReturnType<typeof createHttpServer> | undefined;
  let browser: ReturnType<typeof spawn> | undefined;
  let socket: WebSocket | undefined;
  const releases = new Set<() => void>();
  try {
    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: environment.SQLITE_PATH } });
    await (await import("../../../server/dbSchema")).ensureDatabaseSchema();
    const { rulesRouter } = await import("../../../server/routers/rules");
    const { hostsRouter } = await import("../../../server/routers/hosts");
    const { tunnelsRouter } = await import("../../../server/routers/tunnels");
    const { forwardGroupsRouter } = await import("../../../server/routers/forwardGroups");
    const { usersRouter } = await import("../../../server/routers/users");
    const { systemRouter } = await import("../../../server/_core/systemRouter");
    const { authRouter } = await import("../../../server/routers/auth");
    const { billingRouter } = await import("../../../server/routers/billing");
    const { trafficBillingRouter } = await import("../../../server/routers/trafficBilling");
    const { router } = await import("../../../server/_core/trpc");
    const { createAuthSession } = await import("../../../server/repositories/sessionRepository");
    const { getUserById } = await import("../../../server/repositories/userRepository");
    const { withKeyedTaskLock, withTrafficBillingUserLock } = await import("../../../server/keyedTaskLock");
    await runtime.insertAndGetId("users", { id: 1, username: "isolated-task-admin", password: "unused", role: "admin",
      accountEnabled: 1, canAddRules: 1, manualCanAddRules: 1, balanceCents: 1000 });
    await createAuthSession({ userId: 1, sid: "browser-tasks-session", kind: "browser", expiresAt: new Date(Date.now() + 600_000) });
    const user = await getUserById(1);
    const context = { user, req: { headers: {}, protocol: "http", socket: { remoteAddress: "127.0.0.1" } },
      res: { clearCookie() {} }, authSession: { userId: 1, sid: "browser-tasks-session", kind: "browser" }, authFailureReason: null } as any;
    const caller = rulesRouter.createCaller(context);
    // Hosts are fixtures; no Agent process, SSE subscriber, notification provider
    // or scheduler is started. Saves and runtime reconciliation remain real.
    await runtime.insertAndGetId("hosts", { id: 1, name: "Isolated entry", ip: "127.0.0.1", ipv4: "127.0.0.1", userId: 1,
      isOnline: 1, lastHeartbeat: Math.floor(Date.now() / 1000), agentVersion: "3.9.0", portRangeStart: 18000, portRangeEnd: 30000 });
    await runtime.insertAndGetId("forward_groups", { id: 10, name: "Isolated port resource", groupType: "host", groupMode: "port",
      forwardType: "nftables", targetIp: "0.0.0.0", targetPort: 1, userId: 1, isEnabled: 1 });
    await runtime.insertAndGetId("forward_group_members", { id: 101, groupId: 10, memberType: "host", hostId: 1, priority: 10, isEnabled: 1 });
    await runtime.insertAndGetId("forward_groups", { id: 11, name: "Isolated copy target B", groupType: "host", groupMode: "port",
      forwardType: "nftables", targetIp: "0.0.0.0", targetPort: 1, userId: 1, isEnabled: 1 });
    await runtime.insertAndGetId("forward_group_members", { id: 111, groupId: 11, memberType: "host", hostId: 1, priority: 10, isEnabled: 1 });
    const bundle = await build({ stdin: { contents: harness, loader: "tsx", resolveDir: process.cwd() }, bundle: true, write: false,
      format: "esm", platform: "browser", target: "es2022", jsx: "automatic", logLevel: "silent",
      plugins: [{ name: "isolated-navigation-shell", setup(builder) {
        builder.onResolve({ filter: /\/DashboardLayout$/ }, () => ({ path: "shell", namespace: "qa-shell" }));
        builder.onLoad({ filter: /.*/, namespace: "qa-shell" }, () => ({ loader: "tsx", resolveDir: process.cwd(),
          contents: "import {Link} from 'wouter'; export default function Shell({children}) { return <main style={{padding:16,minWidth:0}}><Link id='leave-rules' href='/other'>Other page</Link>{children}</main> }" }));
      } }],
    });
    server = await createServer({ configFile: false, envFile: false, root: process.cwd(), envDir: directory, cacheDir: path.join(directory, "vite-cache"), plugins: [tailwindcss()], appType: "custom",
      resolve: { alias: { "@": path.join(process.cwd(), "client/src"), "@shared": path.join(process.cwd(), "shared") } },
      server: { middlewareMode: true, preTransformRequests: false, watch: null, hmr: false, ws: false }, optimizeDeps: { noDiscovery: true },
    });
    const apiErrors: string[] = [];
    const submissions: Array<{ requestId: string; title: string; actions: RuleTaskAction[] }> = [];
    const mutations: string[] = [];
    const api = express(); api.use(express.json({ limit: "3mb" }));
    api.use("/api/trpc", (req, _res, next) => {
      const paths = req.path.slice(1).split(",");
      paths.forEach((name, index) => {
        if (name === "rules.enqueueTask") submissions.push(structuredClone(req.body[String(index)]?.json));
      });
      next();
    });
    api.use("/api/trpc", createExpressMiddleware({
      router: router({ rules: rulesRouter, hosts: hostsRouter, tunnels: tunnelsRouter, forwardGroups: forwardGroupsRouter,
        users: usersRouter, system: systemRouter, auth: authRouter, billing: billingRouter, trafficBilling: trafficBillingRouter }),
      createContext: () => context,
      onError: ({ error, path }) => apiErrors.push(`${path}: ${error.message}`),
      responseMeta: ({ paths, type }) => { if (type === "mutation") mutations.push(...paths || []); return {}; },
    }));
    server.middlewares.use(api);
    server.middlewares.use((req, res, next) => {
      const pathname = new URL(req.url || "/", "http://127.0.0.1").pathname;
      if (pathname === "/app.js") { res.setHeader("Content-Type", "application/javascript"); res.end(bundle.outputFiles[0].text); }
      else if (pathname === "/qa") { res.setHeader("Content-Type", "text/html"); res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/client/src/index.css"><div id="root"></div><script type="module" src="/app.js"></script>'); }
      else if (pathname === "/blank") { res.setHeader("Content-Type", "text/html"); res.end("<!doctype html><title>Isolated fixture</title>"); }
      else next();
    });
    // Vite treats port:0 as its default port. Own the listener so the OS really
    // chooses an ephemeral loopback port without probing any production port.
    httpServer = createHttpServer(server.middlewares);
    await new Promise<void>(resolve => httpServer!.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(httpServer.address() as { port: number }).port}`;
    browser = spawn(chrome, ["--headless=new", "--no-sandbox", "--disable-gpu", "--disable-background-networking", "--disable-component-update",
      "--disable-sync", "--no-first-run", "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0",
      `--user-data-dir=${path.join(directory, "chrome")}`, "about:blank"], { stdio: "ignore" });
    const portFile = path.join(directory, "chrome/DevToolsActivePort");
    for (let count = 0; count < 150 && !fs.existsSync(portFile); count++) await delay(50);
    assert.ok(fs.existsSync(portFile), "isolated Chrome started");
    const port = fs.readFileSync(portFile, "utf8").split("\n")[0];
    const page = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json() as { webSocketDebuggerUrl: string };
    socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => { socket!.addEventListener("open", () => resolve(), { once: true }); socket!.addEventListener("error", () => reject(new Error("CDP connection failed")), { once: true }); });
    let nextId = 0;
    let blockTaskStatus = false;
    let blockedStatusRequests = 0;
    const browserErrors: string[] = [];
    const blockedExternalRequests: string[] = [];
    const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
    const command = (method: string, params: Record<string, unknown> = {}): Promise<any> => new Promise((resolve, reject) => {
      const id = ++nextId; pending.set(id, { resolve, reject }); socket!.send(JSON.stringify({ id, method, params }));
    });
    socket.addEventListener("message", event => {
      const message = JSON.parse(String(event.data));
      if (message.method === "Runtime.exceptionThrown") browserErrors.push(JSON.stringify(message.params.exceptionDetails));
      if (message.method === "Fetch.requestPaused") {
        const url = message.params.request.url;
        const external = !url.startsWith(origin + "/");
        const statusFault = blockTaskStatus && new URL(url).pathname.includes("rules.taskStatus");
        if (external) blockedExternalRequests.push(url);
        if (statusFault) blockedStatusRequests++;
        void command(external || statusFault ? "Fetch.failRequest" : "Fetch.continueRequest", {
          requestId: message.params.requestId, ...(external || statusFault ? { errorReason: "BlockedByClient" } : {}),
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
    const until = async (expression: string, timeout = 12_000) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) { if (await evaluate(expression)) return; await delay(40); }
      assert.fail(`browser condition timed out: ${expression}\n${await evaluate("(document.querySelector('[role=dialog]')?.innerText || '')+'\\n'+document.body.innerText.slice(-2500)")}\n${apiErrors.join("\n")}\n${browserErrors.join("\n")}`);
    };
    const eventually = async (check: () => Promise<boolean>, label: string, describe?: () => Promise<unknown>) => {
      const deadline = Date.now() + 12_000;
      while (Date.now() < deadline) { if (await check()) return; await delay(20); }
      assert.fail(label + (describe ? "\n" + JSON.stringify(await describe()) : ""));
    };
    const click = async (expression: string, allowDisabled = false) => {
      const pointExpression = `(() => {const el=${expression};if(!el${allowDisabled ? "" : " || el.disabled"})return null;el.scrollIntoView({block:'center',inline:'center',behavior:'instant'});const r=el.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y);return r.width && r.height && (el.contains(hit)${allowDisabled ? " || el.disabled && hit?.contains(el)" : ""})?{x,y}:null;})()`;
      const describe = () => evaluate(`(() => {const el=${expression};if(!el)return {missing:true};const r=el.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {
        target:el.textContent.trim(),disabled:!!el.disabled,rect:{x:r.x,y:r.y,width:r.width,height:r.height},
        hit:hit?.outerHTML.slice(0,500),coveringTask:hit?.closest('[data-sonner-toast]')?.querySelector('[role=status]')?.textContent,
        dialog:document.querySelector('[role=dialog]')?.getAttribute('data-state')
      };})()`);
      await until(pointExpression);
      let point = await evaluate(pointExpression);
      // Radix dialogs animate their transform. Require stable hit coordinates
      // before real pointer input, including after scrolling a narrow dialog.
      await eventually(async () => {
        await delay(80);
        const next = await evaluate(pointExpression);
        const stable = next && point && Math.abs(next.x - point.x) < 0.5 && Math.abs(next.y - point.y) < 0.5;
        point = next;
        return !!stable;
      }, `pointer target settled: ${expression}`, describe);
      await command("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
      // Hovering Sonner expands the stack and can move the stop button.
      await eventually(async () => {
        await delay(80);
        const next = await evaluate(pointExpression);
        const stable = next && point && Math.abs(next.x - point.x) < 0.5 && Math.abs(next.y - point.y) < 0.5;
        point = next;
        return !!stable;
      }, `hover target settled: ${expression}`, describe);
      await command("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...point });
      await command("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...point });
    };
    const tr = (source: string, args?: unknown[]) => `window.qa.t(${JSON.stringify(source)}${args ? "," + JSON.stringify(args) : ""})`;
    const button = (source: string, scope = "document") => `Array.from(${scope}.querySelectorAll('button')).find(el=>el.textContent.trim()===${tr(source)})`;
    const dialog = "document.querySelector('[role=dialog]')";
    const notification = "document.querySelector('[data-rule-task-progress]')";
    const text = (source: string, scope = "document.body") => `${scope}?.textContent.includes(${tr(source)})`;
    const fill = async (expression: string, value: string) => {
      await click(expression);
      await evaluate(`(() => {const el=${expression};el.focus();el.select();})()`);
      await command("Input.insertText", { text: value });
    };
    const openBatch = async () => { await click(button("批量管理")); await until(`!!${dialog} && !!document.getElementById('batch-manage-operation')`); };
    const selectRule = async (name: string) => click(`Array.from(${dialog}.querySelectorAll('label')).find(el=>el.textContent.includes(${JSON.stringify(name)}))?.querySelector('input[type=checkbox]')`);
    const lastTask = async (): Promise<RuleTaskSnapshot> => {
      const request = submissions.at(-1);
      assert.ok(request, "the real page submitted a task");
      const task = (await caller.taskLookup({ requestId: request.requestId })).task;
      assert.ok(task, "the real router retained the accepted task");
      return task;
    };
    const finish = async () => {
      await eventually(async () => !!(await lastTask()).finishedAt, "accepted task finishes");
      return lastTask();
    };
    const submitAndFinish = async (source: string) => {
      const previous = submissions.length;
      await click(button(source, dialog));
      await eventually(async () => submissions.length === previous + 1, "page submitted exactly one task");
      return finish();
    };
    const accepted = async (previous: number, operation: string) => {
      await eventually(async () => submissions.length === previous + 1 && (await lastTask()).activeOperation === operation, "real task started its save unit");
      await until(`!!(${button("后台执行", dialog)})`);
    };
    // Coordinate through existing real resource/rule locks. Neither the queue,
    // task results, CRUD procedures nor the database are mocked or substituted.
    const hold = async (lock: (work: () => Promise<void>) => Promise<void>) => {
      let entered!: () => void, release!: () => void;
      const acquired = new Promise<void>(resolve => { entered = resolve; });
      const gate = new Promise<void>(resolve => { release = resolve; });
      const work = lock(async () => { entered(); await gate; });
      releases.add(release); await acquired;
      return async () => { release(); releases.delete(release); await work; };
    };
    const scenario = (name: string, run: () => Promise<void>) => t.test(name, async () => {
      const firstSubmission = submissions.length;
      try { await run(); }
      finally {
        blockTaskStatus = false;
        // A failed assertion must not leave the next scenario waiting on a
        // resource lock, or allow old tasks to write into its freshly seeded DB.
        for (const release of releases) release();
        releases.clear();
        await eventually(async () => {
          const tasks = await Promise.all(submissions.slice(firstSubmission).map(request => caller.taskLookup({ requestId: request.requestId })));
          return tasks.every(row => !!row.task?.finishedAt);
        }, "scenario tasks settled before replacing fixture rows");
      }
    });
    const seed = async () => {
      await runtime.executeRaw("DELETE FROM forward_rules");
      for (let id = 1; id <= 14; id++) await runtime.insertAndGetId("forward_rules", {
        id, userId: 1, hostId: 1, name: `Browser rule ${String(id).padStart(2, "0")}`, sourcePort: 18000 + id,
        forwardType: "nftables", protocol: "tcp", targetIp: "127.0.0.1", targetPort: 14443,
        isEnabled: id === 3 ? 0 : 1, disabledByUser: id === 3 ? 1 : 0, isRunning: id === 3 ? 0 : 1,
        quotaUsedIn: 1234, quotaUsedOut: 5678,
      });
    };
    const load = async (language: string, width: number) => {
      blockTaskStatus = false;
      await command("Page.navigate", { url: origin + "/blank" });
      await until("document.title==='Isolated fixture'");
      await evaluate("localStorage.clear();sessionStorage.clear();localStorage.setItem('forwardx.rules.viewMode','table');localStorage.setItem('forwardx.rules.pageSize','12')");
      await command("Emulation.setDeviceMetricsOverride", { width, height: 1000, deviceScaleFactor: 1, mobile: width === 390 });
      await command("Page.navigate", { url: origin + "/qa?lang=" + language });
      await until(`!!(${button("批量管理")}) && !!document.querySelector('input[type=checkbox]')`);
      assert.equal(await evaluate(`(${button("批量管理")}).textContent.trim()`), language === "en" ? "Bulk Actions" : "批量管理",
        "the requested locale actually loaded instead of silently falling back");
      await until("Array.from(document.querySelectorAll('input[type=checkbox]')).filter(el=>el.getAttribute('aria-label')?.includes('Browser rule') && el.getBoundingClientRect().width).length===12");
      // The page enables secondary queries at 300ms; allow their initial scope
      // and responsive layout effects to settle before selecting a page.
      await delay(450);
    };
    const rows = () => runtime.queryRaw<any>("SELECT id,name,isEnabled,isRunning,disabledByUser,quotaUsedIn,quotaUsedOut,sni,sourcePort,forwardGroupId,isForwardGroupTemplate,forwardGroupRuleId FROM forward_rules ORDER BY id");
    const upload = async (rules: Array<Record<string, unknown>>) => {
      const filename = path.join(directory, "mixed-rules.json");
      fs.writeFileSync(filename, JSON.stringify({ kind: "forwardx.forward-rules", version: 1, rules }));
      await until(`!!${dialog}.querySelector('input[type=file]')`);
      const { root } = await command("DOM.getDocument");
      const { nodeId } = await command("DOM.querySelector", { nodeId: root.nodeId, selector: "[role=dialog] input[type=file]" });
      await command("DOM.setFileInputFiles", { nodeId, files: [filename] });
      await until(`!(${button("下一步", dialog)}).disabled`);
    };
    const importRule = (name: string, sourcePort: number, sni?: string) => ({ name, sourcePort, forwardType: "nftables", protocol: "tcp",
      targetIp: "127.0.0.1", targetPort: 14443, isEnabled: true, ...(sni ? { sni } : {}) });
    const prepareImport = async (rules: Array<Record<string, unknown>>) => {
      await openBatch(); await click(button("导入导出", dialog));
      await upload(rules);
      await click(button("下一步", dialog));
      await click(`${dialog}.querySelector('button[title="Isolated port resource"]')`);
      await click(button("下一步", dialog));
      await until(`!!(${button("导入规则", dialog)})`);
    };
    await command("Runtime.enable");
    await command("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
    t.diagnostic(`${(await command("Browser.getVersion")).product}; Node ${process.version}; SQLite ${(await runtime.queryRaw<any>("SELECT sqlite_version() AS version"))[0].version}; ${origin}; all data/cache/profile in ${directory}`);

    for (const language of ["en", "zh-CN"]) for (const width of [1280, 390]) await scenario(`${language}, ${width}px: page selection, queued pause/enable/restart and cancel remaining`, async () => {
      await seed(); await load(language, width);
      const selectAll = `Array.from(document.querySelectorAll('input[type=checkbox]')).find(el=>el.getAttribute('aria-label')===${tr("选择本页全部可选规则")} && el.getBoundingClientRect().width)`;
      await click(selectAll);
      await until(`document.querySelector('[role=region][aria-label="'+${tr("所选规则批量操作")}+'"]')?.textContent.includes('12')`);
      await click(button("下一页"));
      await until("localStorage.getItem('forwardx.rules.page')==='2'");
      await until("Array.from(document.querySelectorAll('input[type=checkbox]')).every(el=>!el.checked)");
      await click(button("上一页"));
      await until("localStorage.getItem('forwardx.rules.page')==='1'");
      await until("Array.from(document.querySelectorAll('input[type=checkbox]')).filter(el=>el.getAttribute('aria-label')?.includes('Browser rule') && el.getBoundingClientRect().width).length===12");
      assert.equal(await evaluate("Array.from(document.querySelectorAll('input[type=checkbox]')).some(el=>el.checked)"), false,
        "returning to the original page does not restore its prior selection");
      assert.equal(await evaluate(`!!document.querySelector('[role=region][aria-label="'+${tr("所选规则批量操作")}+'"]')`), false);
      await openBatch();
      for (const name of ["Browser rule 01", "Browser rule 02", "Browser rule 04"]) await selectRule(name);
      // One started toggle completes; the two remaining toggles must never run.
      const release = await hold(work => withKeyedTaskLock("rule:4", work));
      const previous = submissions.length;
      await click(button("暂停", dialog)); await accepted(previous, "toggle");
      await click(button("后台执行", dialog)); await until(`!${dialog}`);
      await click("document.getElementById('leave-rules')"); await until("!!document.getElementById('other-page')");
      await until(`!!${notification} && !!(${button("停止排队", notification)})`);
      const previousCancels = mutations.filter(name => name === "rules.cancelTask").length;
      await click(button("停止排队", notification));
      await eventually(async () => mutations.filter(name => name === "rules.cancelTask").length === previousCancels + 1, "global cancel reached real router");
      await release();
      const stopped = await finish();
      assert.deepEqual([stopped.total, stopped.completed, stopped.succeeded, stopped.cancelled], [3, 3, 1, 2]);
      await until(`${notification}?.textContent.includes('1 / 3') && ${notification}?.textContent.includes('33%')`);
      const state = await rows();
      assert.deepEqual(state.slice(0, 4).map(row => Number(row.isEnabled)), [1, 1, 0, 0]);
      assert.ok(state.every(row => Number(row.quotaUsedIn) === 1234 && Number(row.quotaUsedOut) === 5678), "pause preserves counters");
      const box = await evaluate(`(() => {const r=${notification}.getBoundingClientRect();return {left:r.left,right:r.right}})()`);
      assert.ok(box.left >= 0 && box.right <= width, "global task controls fit the viewport");
      await load(language, width); await openBatch(); await selectRule("Browser rule 04");
      await submitAndFinish("启用");
      await until(`!!${dialog} && (${button("重启", dialog)})?.disabled === true && ${dialog}.querySelector('input[type=checkbox]')?.disabled === false`);
      assert.equal(Number((await rows())[3].isEnabled), 1);
      // Completed selection is cleared; choose enabled and paused rows again.
      await selectRule("Browser rule 04"); await selectRule("Browser rule 03");
      const restarted = await submitAndFinish("重启");
      assert.deepEqual([restarted.total, restarted.succeeded, restarted.skipped], [2, 1, 1]);
      const after = await rows();
      assert.equal(Number(after[3].isRunning), 0);
      assert.deepEqual([Number(after[2].isEnabled), Number(after[2].disabledByUser)], [0, 1]);
      assert.ok(after.every(row => Number(row.quotaUsedIn) === 1234 && Number(row.quotaUsedOut) === 5678));
    });

    for (const [language, width] of [["en", 1280], ["zh-CN", 390]] as const) await scenario(`${language}, ${width}px: mixed import finishes its entire started batch after cancel and navigation`, async () => {
      await seed(); await load(language, width);
      await prepareImport([importRule("Mixed ordinary", 20001), importRule("Mixed SNI A", 20443, "a.example.test"), importRule("Mixed SNI B", 20443, "b.example.test")]);
      const release = await hold(work => withTrafficBillingUserLock(1, work));
      const previous = submissions.length;
      await click(button("导入规则", dialog)); await accepted(previous, "createBatch");
      assert.equal(submissions.at(-1)!.actions.length, 1, "the real page sends one centralized save unit");
      assert.equal((submissions.at(-1)!.actions[0].input.rules as unknown[]).length, 3);
      await click(button("后台执行", dialog)); await until(`!${dialog}`);
      await click("document.getElementById('leave-rules')"); await until("!!document.getElementById('other-page')");
      await until(text("整批保存中，提交完成后统一更新进度；停止排队将等待当前批次结束", notification));
      const beforeCancel = mutations.filter(name => name === "rules.cancelTask").length;
      await click(button("停止排队", notification));
      await eventually(async () => mutations.filter(name => name === "rules.cancelTask").length === beforeCancel + 1, "cancel acknowledged before batch release");
      assert.equal((await lastTask()).completed, 0, "no fabricated incremental saved progress");
      await release();
      const result = await finish();
      assert.deepEqual([result.total, result.completed, result.succeeded, result.failed, result.cancelled], [3, 3, 3, 0, 0]);
      assert.deepEqual(result.results!.map(row => row.index), [0, 1, 2]);
      const saved = (await rows()).filter(row => row.name.startsWith("Mixed ") && Number(row.isForwardGroupTemplate));
      assert.deepEqual(saved.map(row => [row.name, row.sourcePort, row.sni || null]), [["Mixed ordinary", 20001, null], ["Mixed SNI A", 20443, "a.example.test"], ["Mixed SNI B", 20443, "b.example.test"]]);
      assert.equal(new Set(result.results!.map(row => row.value!.id)).size, 3);
      await until(`${notification}?.textContent.includes('3 / 3') && ${notification}?.textContent.includes('100%')`);
      assert.equal(await evaluate("!!document.getElementById('other-page')"), true, "Rules stays unmounted while global tracking finishes");
    });

    await scenario("en, 390px: confirmed per-row database failure retains only the failed original line for explicit retry", async () => {
      await seed(); await load("en", 390);
      await prepareImport([importRule("Retry saved", 21001), importRule("Retry rejected", 21443, "retry.example.test")]);
      await runtime.executeRaw("CREATE TRIGGER browser_reject_import BEFORE INSERT ON forward_rules WHEN NEW.name = 'Retry rejected' BEGIN SELECT RAISE(ABORT, 'browser confirmed row rejection'); END");
      try {
        const result = await submitAndFinish("导入规则");
        assert.deepEqual([result.succeeded, result.failed, result.unknown], [1, 1, 0]);
        await until("document.body.textContent.includes('browser confirmed row rejection')");
        await until(`${dialog}?.textContent.includes('1') && !(${button("导入规则", dialog)}).disabled`);
        // The confirmation step summarizes counts. Original row errors are
        // kept in the source step, where the user can correct failed inputs.
        await click(button("修改内容", dialog));
        await until(`${dialog}?.textContent.includes(${tr("第 {0} 行：", [2])}+'Retry rejected')`);
        assert.equal(await evaluate(`(() => {const source=${dialog}.cloneNode(true);source.querySelector('[data-rule-task-container]')?.remove();return source.textContent.includes('Retry saved');})()`), false,
          "retry source excludes the saved row; the embedded task history still retains its result");
        await click(button("下一步", dialog)); await click(button("下一步", dialog));
        assert.equal((await rows()).filter(row => row.name === "Retry saved" && Number(row.isForwardGroupTemplate)).length, 1);
      } finally { await runtime.executeRaw("DROP TRIGGER browser_reject_import"); }
      const previous = submissions.length;
      await click(button("导入规则", dialog));
      await eventually(async () => submissions.length === previous + 1, "explicit retry submitted");
      assert.deepEqual((submissions.at(-1)!.actions[0].input.rules as Array<{ name: string }>).map(row => row.name), ["Retry rejected"]);
      const retried = await finish();
      assert.deepEqual([retried.total, retried.succeeded, retried.failed], [1, 1, 0]);
      await until(`!${dialog}`);
      const saved = (await rows()).filter(row => row.name.startsWith("Retry ") && Number(row.isForwardGroupTemplate));
      assert.equal(saved.length, 2, "retry does not duplicate the already committed rule");
    });

    await scenario("en, 1280px: copying one rule to A and B retries only the failed target B without adding another A row", async () => {
      await seed(); await load("en", 1280); await openBatch();
      await click("document.getElementById('batch-manage-operation')");
      await click(`Array.from(document.querySelectorAll('[role=option]')).find(el=>el.textContent.trim()===${tr("批量复制")})`);
      await selectRule("Browser rule 01"); await click(button("下一步", dialog));
      for (const name of ["Isolated port resource", "Isolated copy target B"]) await selectRule(name);
      await click(button("下一步", dialog));
      await runtime.executeRaw("CREATE TRIGGER browser_reject_copy_b BEFORE INSERT ON forward_rules WHEN NEW.forwardGroupId = 11 BEGIN SELECT RAISE(ABORT, 'browser confirmed target B rejection'); END");
      let savedA: Awaited<ReturnType<typeof rows>> = [];
      try {
        const result = await submitAndFinish("复制所选规则");
        assert.deepEqual([result.total, result.succeeded, result.failed, result.unknown], [2, 1, 1, 0]);
        assert.deepEqual(submissions.at(-1)!.actions.slice().sort((a, b) => Number(a.input.forwardGroupId) - Number(b.input.forwardGroupId))
          .map(action => [action.operation, action.input.name, action.input.forwardGroupId]),
          [["create", "Browser rule 01", 10], ["create", "Browser rule 01", 11]]);
        assert.deepEqual(Object.fromEntries(result.results!.map(row => [row.label, row.status])),
          { "Browser rule 01 → Isolated port resource": "succeeded", "Browser rule 01 → Isolated copy target B": "failed" });
        assert.match(result.results!.find(row => row.status === "failed")!.error!, /browser confirmed target B rejection/);
        await until(`${dialog}?.textContent.includes(${tr("再次复制只重试 {0} 个已确认失败的规则与目标组合", [1])}) && !(${button("复制所选规则", dialog)}).disabled`);
        savedA = (await rows()).filter(row => Number(row.forwardGroupId) === 10);
        assert.equal(savedA.filter(row => Number(row.isForwardGroupTemplate)).length, 1);
        assert.equal((await rows()).filter(row => Number(row.forwardGroupId) === 11).length, 0);
      } finally { await runtime.executeRaw("DROP TRIGGER browser_reject_copy_b"); }
      const retried = await submitAndFinish("复制所选规则");
      assert.deepEqual(submissions.at(-1)!.actions.map(action => [action.operation, action.input.name, action.input.forwardGroupId]),
        [["create", "Browser rule 01", 11]], "the page excludes the successful rule/target A pair from its retry request");
      assert.deepEqual([retried.total, retried.succeeded, retried.failed], [1, 1, 0]);
      await until(`!${dialog}`);
      const after = await rows();
      assert.deepEqual(after.filter(row => Number(row.forwardGroupId) === 10), savedA,
        "all target A database rows, IDs and assigned ports remain identical after retry");
      assert.equal(after.filter(row => Number(row.forwardGroupId) === 11 && Number(row.isForwardGroupTemplate)).length, 1);
      assert.equal(after.filter(row => row.name === "Browser rule 01" && !row.forwardGroupId).length, 1, "the original source rule remains present");
    });

    await scenario("zh-CN, 390px: global notification expands every successful/failed result and its complete long error after leaving Rules", async () => {
      await seed(); await load("zh-CN", 390);
      const imported = Array.from({ length: 12 }, (_, index) => importRule(`Details ${index % 2 ? "failed" : "saved"} ${String(index + 1).padStart(2, "0")}`, 23001 + index));
      const rejection = "browser detail rejection: " + "完整错误详情必须全部显示 ".repeat(32) + "\nERROR_TAIL_END_完整结束";
      await prepareImport(imported);
      await runtime.executeRaw(`CREATE TRIGGER browser_reject_details BEFORE INSERT ON forward_rules WHEN NEW.name LIKE 'Details failed%' BEGIN SELECT RAISE(ABORT, '${rejection}'); END`);
      try {
        const release = await hold(work => withTrafficBillingUserLock(1, work));
        const previous = submissions.length;
        await click(button("导入规则", dialog)); await accepted(previous, "createBatch");
        await click(button("后台执行", dialog)); await until(`!${dialog}`);
        await click("document.getElementById('leave-rules')"); await until("!!document.getElementById('other-page')");
        await release();
        const result = await finish();
        assert.deepEqual([result.total, result.completed, result.succeeded, result.failed, result.unknown], [12, 12, 6, 6, 0]);
        assert.deepEqual(result.results!.map(row => [row.index, row.label, row.status]),
          imported.map((rule, index) => [index, rule.name, index % 2 ? "failed" : "succeeded"]));
        assert.ok(result.results!.filter(row => row.status === "failed").every(row => row.error!.includes(rejection)),
          "real database failure messages include the entire long error and its tail");
        assert.equal((await rows()).filter(row => row.name.startsWith("Details ") && Number(row.isForwardGroupTemplate)).length, 6);
        await until(`${notification}?.textContent.includes('12 / 12') && ${notification}?.textContent.includes('100%') && !!${notification}?.querySelector('summary')`);
        assert.equal(await evaluate(`${notification}.querySelector('details').open`), false);
        await click(`${notification}.querySelector('summary')`);
        await until(`${notification}.querySelector('details').open`);
        const actual = await evaluate(`Array.from(${notification}.querySelectorAll('ol > li')).map(el=>({
          label:el.querySelectorAll('p')[0].textContent,status:el.querySelectorAll('p')[1].textContent,error:el.querySelectorAll('p')[2]?.textContent || ''
        }))`);
        const expected = await evaluate(`(${JSON.stringify(result.results)}).map(row=>({
          label:(row.index+1)+'. '+row.label+(row.value?.id?' · #'+row.value.id:''),
          status:window.qa.t(row.status==='succeeded'?'操作成功':'执行失败'),error:row.error?window.qa.t(row.error):''
        }))`);
        assert.deepEqual(actual, expected, "all 12 rows retain exact order, success IDs, statuses and complete errors without preview truncation");
        // Inspect settled layout before sending wheel input to the real list.
        await delay(450);
        const geometry = await evaluate(`(() => {
          const el=${notification},list=el.querySelector('ol'),toast=el.closest('[data-rule-task-notifications]'),rect=node=>{const r=node.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom};};
          return {viewport:{width:innerWidth,height:innerHeight},notification:rect(el),list:rect(list),toast:rect(toast),scrollTop:list.scrollTop,scrollHeight:list.scrollHeight,clientHeight:list.clientHeight,overflow:getComputedStyle(list).overflowY};
        })()`);
        assert.ok(geometry.list.y >= 0 && geometry.list.bottom <= geometry.viewport.height,
          "expanded notification results must remain inside the viewport for real scrolling: " + JSON.stringify(geometry));
        const listPoint = { x: geometry.list.x + geometry.list.width / 2, y: geometry.list.y + geometry.list.height / 2 };
        await command("Input.dispatchMouseEvent", { type: "mouseWheel", ...listPoint, deltaX: 0, deltaY: 10000 });
        await until(`${notification}.querySelector('ol').scrollTop > 0 && (()=>{const list=${notification}.querySelector('ol');return list.scrollTop+list.clientHeight>=list.scrollHeight-1;})()`);
        const bounds = await evaluate(`(() => {const el=${notification},list=el.querySelector('ol'),tail=list.lastElementChild.lastElementChild,r=el.getBoundingClientRect(),a=list.getBoundingClientRect(),b=tail.getBoundingClientRect();return {
          left:r.left,right:r.right,scrollable:list.scrollHeight>list.clientHeight,lastErrorVisible:b.bottom<=a.bottom+1 && b.bottom>a.top,
          tail:tail.textContent.includes('ERROR_TAIL_END_完整结束'),nowrap:getComputedStyle(tail).whiteSpace==='nowrap'
        };})()`);
        assert.ok(bounds.left >= 0 && bounds.right <= 390 && bounds.scrollable && bounds.lastErrorVisible && bounds.tail && !bounds.nowrap,
          "the narrow global notification scrolls to the final full error without horizontal overflow");
        assert.equal(await evaluate("!!document.getElementById('other-page')"), true, "details remain usable while Rules is unmounted");
      } finally { await runtime.executeRaw("DROP TRIGGER browser_reject_details"); }
    });

    await scenario("zh-CN, 390px: lost status transport is unknown, blocks the same import after reopening and allows changed content", async () => {
      await seed(); await load("zh-CN", 390);
      await prepareImport([importRule("Unknown saved once", 22001)]);
      const release = await hold(work => withTrafficBillingUserLock(1, work));
      const previous = submissions.length;
      blockTaskStatus = true; blockedStatusRequests = 0;
      await click(button("导入规则", dialog)); await accepted(previous, "createBatch");
      await until(text("任务状态待核对", notification), 30_000);
      assert.ok(blockedStatusRequests >= 3, "real browser transport failed on three polls");
      assert.equal(submissions.length, previous + 1, "unknown polling never re-enqueues business writes");
      assert.equal(await evaluate("document.body.textContent.includes('已仅保留失败项供重试')"), false);
      assert.equal(await evaluate(text("面板可能已重启或任务已过期，请核对规则后再操作，不要重复提交", notification)), true);
      blockTaskStatus = false;
      await release(); const completed = await finish();
      assert.deepEqual([completed.succeeded, completed.failed], [1, 0]);
      assert.equal((await rows()).filter(row => row.name === "Unknown saved once" && Number(row.isForwardGroupTemplate)).length, 1);
      assert.equal(submissions.length, previous + 1);
      // Lost completion must not offer the same write as an ordinary failed-item retry.
      assert.equal(await evaluate(`(${button("导入规则", dialog)})?.disabled`), true,
        "unknown outcome must require rule reconciliation before another import submission");
      await click(button("取消", dialog)); await until(`!${dialog}`);
      await prepareImport([importRule("Unknown saved once", 22001)]);
      assert.equal(await evaluate(`(${button("导入规则", dialog)})?.disabled`), true,
        "closing and reopening with the same content and target must retain the unknown outcome guard");
      await click(button("导入规则", dialog), true);
      assert.equal(submissions.length, previous + 1, "real pointer input on the blocked button cannot submit a duplicate");
      assert.equal((await rows()).filter(row => row.name === "Unknown saved once" && Number(row.isForwardGroupTemplate)).length, 1);
      await click(button("修改内容", dialog));
      await upload([importRule("Changed content new attempt", 22002)]);
      await click(button("下一步", dialog)); await click(button("下一步", dialog));
      await until(`!(${button("导入规则", dialog)}).disabled`);
      const changed = await submitAndFinish("导入规则");
      assert.deepEqual([changed.total, changed.succeeded, changed.failed], [1, 1, 0]);
      assert.notEqual(submissions.at(-1)!.requestId, submissions[previous].requestId);
      assert.deepEqual((submissions.at(-1)!.actions[0].input.rules as Array<{ name: string }>).map(row => row.name), ["Changed content new attempt"]);
      await until(`!${dialog}`);
      const saved = (await rows()).filter(row => Number(row.isForwardGroupTemplate));
      assert.equal(saved.filter(row => row.name === "Unknown saved once").length, 1);
      assert.equal(saved.filter(row => row.name === "Changed content new attempt").length, 1);
      await prepareImport([importRule("Unknown saved once", 22001)]);
      assert.equal(await evaluate(`(${button("导入规则", dialog)})?.disabled`), true,
        "a later successful import must not clear the original unknown content guard");
      assert.equal(submissions.length, previous + 2);
    });
    assert.deepEqual(apiErrors, [], "all page APIs are backed by real routers");
    assert.deepEqual(browserErrors, [], "no uncaught browser exceptions");
    assert.deepEqual(blockedExternalRequests, [], "the page requested only this isolated loopback origin");
  } finally {
    for (const release of releases) release();
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
