import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createServer as createHttpServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { initTRPC, TRPCError } from "@trpc/server";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import tailwindcss from "@tailwindcss/vite";
import { build } from "esbuild";
import express from "express";
import superjson from "superjson";
import { createServer } from "vite";
import { z } from "zod";

const chrome = process.env.CHROME_BIN || (process.platform === "darwin"
  ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "/usr/bin/chromium");
const listedTokenId = 41;
const createdTokenId = 42;
const publicPanelUrl = "https://panel.browser.invalid";
const takeoverNotice = "继续安装将由新 Agent 接管该主机及规则。支持接管协议的旧 Agent 会停止面板同步；面板将隔离旧实例，已有转发保留运行。如需管理两台主机，请新建 Token。";
const harness = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {httpBatchLink} from '@trpc/client';
import superjson from 'superjson';
import {Toaster, toast} from 'sonner';
import {trpc} from './client/src/lib/trpc';
import {initializeLanguage, setLanguagePreference, t} from './client/src/i18n';
setLanguagePreference(new URLSearchParams(location.search).get('lang') || 'en');
await initializeLanguage();
const {default: AgentTokenManager} = await import('./client/src/components/AgentTokenManager');
const queryClient = new QueryClient({defaultOptions:{queries:{retry:false,refetchOnWindowFocus:false},mutations:{retry:false}}});
const client = trpc.createClient({links:[httpBatchLink({url:'/api/trpc',transformer:superjson})]});
const writes = [], fallbacks = [], prompts = [];
// Intercept both clipboard paths, so this never touches the OS clipboard.
Object.defineProperty(navigator, 'clipboard', {configurable:true,value:{writeText:async text=>{writes.push(text)}}});
const execCommand = document.execCommand.bind(document);
document.execCommand = (name,...args)=>name==='copy' ? (fallbacks.push(name),false) : execCommand(name,...args);
window.prompt = (...args)=>{prompts.push(args);return null};
window.qa = {t,writes,fallbacks,prompts,dismissToasts:()=>toast.dismiss()};
createRoot(document.getElementById('root')).render(<trpc.Provider client={client} queryClient={queryClient}><QueryClientProvider client={queryClient}><main style={{padding:16,minWidth:0}}><AgentTokenManager/></main><Toaster visibleToasts={10}/></QueryClientProvider></trpc.Provider>);
`;

type InstallReply = { token?: string; boundHost?: { id: number; name: string; isOnline: boolean } | null };
type LookupFailure = { code: "INTERNAL_SERVER_ERROR" | "FORBIDDEN"; message: string };

test("browser: real AgentTokenManager installation copies use fresh binding and require takeover confirmation", {
  skip: !fs.existsSync(chrome), timeout: 180_000,
}, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-agent-token-browser-"));
  let server: Awaited<ReturnType<typeof createServer>> | undefined;
  let httpServer: ReturnType<typeof createHttpServer> | undefined;
  let browser: ReturnType<typeof spawn> | undefined;
  let socket: WebSocket | undefined;
  let reply: InstallReply = { token: "initial-install-token", boundHost: null };
  let failure: LookupFailure | null = null;
  let gate: Promise<void> | undefined;
  const releases = new Set<() => void>();
  const lookups: Array<{ input: { id: number }; reply: InstallReply; failure: LookupFailure | null }> = [];
  const creates: unknown[] = [];
  const apiErrors: string[] = [];
  const browserErrors: string[] = [];
  const blockedExternalRequests: string[] = [];
  let copyQueries = 0;
  let clipboardWrites = 0;
  let cancellations = 0;
  let confirmations = 0;
  try {
    // Only response fixtures are used here. Real API authorization is covered by
    // server/agentInstallation.test.ts; no DB, server entry point or notifier runs.
    const fixture = initTRPC.create({ transformer: superjson });
    const router = fixture.router({
      auth: fixture.router({ me: fixture.procedure.query(() => ({ id: 1, username: "isolated-admin", role: "admin" })) }),
      system: fixture.router({ getSettings: fixture.procedure.query(() => ({ panelPublicUrl: publicPanelUrl,
        githubAccelerator: { enabled: false, url: "" }, agentPreferPanelInstall: false })) }),
      agentTokens: fixture.router({
        list: fixture.procedure.query(() => [{ id: listedTokenId, token: "list-token-not-for-install", description: "Browser fixture",
          createdAt: new Date("2026-01-01T00:00:00Z"), isUsed: false, host: null }]),
        create: fixture.procedure.input(z.object({ description: z.string().optional() })).mutation(({ input }) => {
          creates.push(input);
          return { id: createdTokenId, token: "new-dialog-token" };
        }),
        getInstallToken: fixture.procedure.input(z.object({ id: z.number() }).strict()).query(async ({ input }) => {
          assert.ok(input.id === listedTokenId || input.id === createdTokenId, "the requested token belongs to this fixture");
          const response = structuredClone(reply);
          const rejection = failure && { ...failure };
          const waiting = gate;
          lookups.push({ input, reply: response, failure: rejection });
          await waiting;
          if (rejection) throw new TRPCError(rejection);
          return response;
        }),
      }),
    });
    const bundle = await build({ stdin: { contents: harness, loader: "tsx", resolveDir: process.cwd() }, bundle: true, write: false,
      format: "esm", platform: "browser", target: "es2022", jsx: "automatic", logLevel: "silent" });
    server = await createServer({ configFile: false, envFile: false, root: process.cwd(), envDir: directory,
      cacheDir: path.join(directory, "vite-cache"), plugins: [tailwindcss()], appType: "custom",
      resolve: { alias: { "@": path.join(process.cwd(), "client/src"), "@shared": path.join(process.cwd(), "shared") } },
      server: { middlewareMode: true, preTransformRequests: false, watch: null, hmr: false, ws: false }, optimizeDeps: { noDiscovery: true },
    });
    const api = express();
    api.use(express.json());
    api.use("/api/trpc", createExpressMiddleware({ router, createContext: () => ({}),
      onError: ({ path: procedure, error }) => apiErrors.push(`${procedure}: ${error.message}`),
    }));
    server.middlewares.use(api);
    server.middlewares.use((req, res, next) => {
      const pathname = new URL(req.url || "/", "http://127.0.0.1").pathname;
      if (pathname === "/app.js") { res.setHeader("Content-Type", "application/javascript"); res.end(bundle.outputFiles[0].text); }
      else if (pathname === "/qa") { res.setHeader("Content-Type", "text/html"); res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/client/src/index.css"><div id="root"></div><script type="module" src="/app.js"></script>'); }
      else if (pathname === "/blank") { res.setHeader("Content-Type", "text/html"); res.end("<!doctype html><title>Isolated fixture</title>"); }
      else if (pathname === "/favicon.ico") { res.statusCode = 204; res.end(); }
      else next();
    });
    // Own the listener: Vite interprets port:0 as its default port.
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
    await new Promise<void>((resolve, reject) => {
      socket!.addEventListener("open", () => resolve(), { once: true });
      socket!.addEventListener("error", () => reject(new Error("CDP connection failed")), { once: true });
    });
    let nextId = 0;
    const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
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
      while (Date.now() < deadline) { if (await evaluate(expression)) return; await delay(30); }
      assert.fail(`browser condition timed out: ${expression}\n${await evaluate("document.body.innerText")}\n${apiErrors.join("\n")}\n${browserErrors.join("\n")}`);
    };
    const eventually = async (check: () => boolean, label: string) => {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) { if (check()) return; await delay(20); }
      assert.fail(label);
    };
    const click = async (expression: string) => {
      const pointExpression = `(() => {const el=${expression};if(!el || el.disabled)return null;el.scrollIntoView({block:'center',inline:'center',behavior:'instant'});const r=el.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;return r.width && r.height && el.contains(document.elementFromPoint(x,y))?{x,y}:null;})()`;
      await until(pointExpression);
      let point = await evaluate(pointExpression);
      // Require settled coordinates during the real Radix opening animation.
      for (let count = 0; count < 100; count++) {
        await delay(60);
        const next = await evaluate(pointExpression);
        if (next && point && Math.abs(next.x - point.x) < 0.5 && Math.abs(next.y - point.y) < 0.5) { point = next; break; }
        point = next;
      }
      assert.ok(point, `pointer target is visible: ${expression}`);
      await command("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
      await command("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...point });
      await command("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...point });
    };
    const translated = (source: string) => `window.qa.t(${JSON.stringify(source)})`;
    const openDialogs = `Array.from(document.querySelectorAll('[role="dialog"][data-state="open"]'))`;
    const activeDialog = `${openDialogs}.at(-1)`;
    const reuseDialog = `${openDialogs}.find(el=>el.querySelector('h2')?.textContent===${translated("此 Token 已关联 Agent")})`;
    const button = (source: string, scope = "document") => `Array.from((${scope}).querySelectorAll('button')).find(el=>el.textContent.trim()===${translated(source)})`;
    const visible = async (expression: string) => {
      await until(`!!(${expression})`);
      await evaluate(`(${expression}).scrollIntoView({block:'center',inline:'nearest',behavior:'instant'})`);
      await until(`(() => {const el=${expression},r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>0 && r.height>0 && r.left>=-1 && r.right<=innerWidth+1 && r.top>=-1 && r.bottom<=innerHeight+1 && s.visibility==='visible' && s.display!=='none';})()`);
    };
    const assertCommand = (text: string, token: string) => {
      assert.ok(text.includes("https://raw.githubusercontent.com/owo10086/sni-panel/main/scripts/install-agent.sh"), "copied command retains the sni-panel source");
      assert.ok(text.includes(`${publicPanelUrl}/api/agent/install.sh`), `panel fallback remains in the copied command: ${text}`);
      assert.equal(text.split(`install ${token}`).length - 1, 2, "both command alternatives use the latest server token");
      assert.ok(text.includes(publicPanelUrl));
      for (const stale of ["new-dialog-token", "script-dialog-token", "list-token-not-for-install", "poouo/Forwardx"]) {
        assert.ok(!text.includes(stale), `copied command excludes stale/source fixture: ${stale}`);
      }
    };
    await command("Runtime.enable");
    await command("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
    t.diagnostic(`${(await command("Browser.getVersion")).product}; Node ${process.version}; controlled tRPC responses and clipboard`);

    for (const language of ["en", "zh-CN"]) for (const width of [1280, 390]) for (const entry of ["new", "existing"] as const) {
      await t.test(`${language}, ${width}px, ${entry} token: fresh copies, online/offline cancel/confirm and rejected lookups`, async () => {
        await command("Page.navigate", { url: origin + "/blank" });
        await until("document.title==='Isolated fixture'");
        await evaluate("localStorage.clear()");
        await command("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: width === 390 });
        reply = { token: "script-dialog-token", boundHost: null }; failure = null;
        const lookupStart = lookups.length;
        const expectedTokenId = entry === "new" ? createdTokenId : listedTokenId;
        const createStart = creates.length;
        const apiErrorStart = apiErrors.length;
        await command("Page.navigate", { url: `${origin}/qa?lang=${language}` });
        await until(`!!window.qa && !!document.querySelector('.standard-card-grid code') && !!${button("添加主机")}`);
        assert.equal(await evaluate("document.documentElement.lang"), language);
        if (language === "en") {
          assert.equal(await evaluate(translated("此 Token 已关联 Agent")), "This token is already linked to an Agent");
          assert.equal(await evaluate(translated("确认并复制")), "Confirm and copy");
          assert.notEqual(await evaluate(translated(takeoverNotice)), takeoverNotice, "takeover consequences have an English translation");
        }
        if (entry === "new") {
          await click(button("添加主机"));
          await click(button("生成安装命令", activeDialog));
          await until(`(${activeDialog})?.querySelector('h2')?.textContent===${translated("安装命令已生成")}`);
          await visible(button("复制安装命令", activeDialog));
          assert.equal(creates.length, createStart + 1);
          assert.equal(lookups.length, lookupStart, "creating/opening a token never copies or queries installation credentials");
        } else {
          await click(`Array.from(document.querySelectorAll('button')).find(el=>el.title===${translated("查看安装命令")})`);
          await until(`(${activeDialog})?.querySelector('h2')?.textContent===${translated("安装命令")}`);
          assert.equal(lookups.length, lookupStart + 1, "existing-token dialog obtains its displayed command from the API");
          assert.deepEqual(lookups.at(-1)?.input, { id: listedTokenId });
          assert.equal(creates.length, createStart);
          for (const label of ["安装命令", "卸载命令", "升级命令"]) {
            await visible(`Array.from((${activeDialog}).querySelectorAll('label')).find(el=>el.textContent===${translated(label)})`);
          }
        }
        // Settings arrive asynchronously; explicitly choose the public address
        // with pointer input instead of assuming which address starts selected.
        const publicAddress = `Array.from((${activeDialog}).querySelectorAll('button[aria-pressed]')).find(el=>el.querySelector('span')?.textContent===${translated("公开域名")})`;
        await click(publicAddress);
        await until(`(${publicAddress})?.getAttribute('aria-pressed')==='true'`);
        await visible(`(${activeDialog}).querySelector('h2')`);
        await visible(`(${activeDialog}).querySelector('p[id]')`);
        assert.ok(await evaluate(`(${activeDialog}).querySelector('code').textContent.includes(${JSON.stringify(entry === "new" ? "new-dialog-token" : "script-dialog-token")})`));
        assert.equal(await evaluate("window.qa.writes.length"), 0, "opening either dialog never copies automatically");
        assert.equal(await evaluate("window.isSecureContext"), true, "the controlled navigator.clipboard path is exercised");

        const copyButton = entry === "new" ? button("复制安装命令", activeDialog)
          : `Array.from((${activeDialog}).querySelectorAll('label')).find(el=>el.textContent===${translated("安装命令")}).parentElement.querySelector('button')`;
        const expectedTokens: string[] = [];
        const attemptCopy = async (token: string | undefined, boundHost: InstallReply["boundHost"], rejection: LookupFailure | null = null, held = false) => {
          reply = { token, boundHost }; failure = rejection;
          const before = lookups.length;
          let release: (() => void) | undefined;
          if (held) { gate = new Promise<void>(resolve => { release = resolve; releases.add(resolve); }); }
          await click(copyButton);
          await eventually(() => lookups.length > before, "every installation-copy click issues a new getInstallToken request");
          assert.equal(lookups.length, before + 1);
          assert.deepEqual(lookups.at(-1), { input: { id: expectedTokenId }, reply, failure: rejection });
          copyQueries++;
          if (held) {
            await delay(100);
            assert.equal(await evaluate("window.qa.writes.length"), expectedTokens.length, "no copy occurs while the fresh lookup is pending");
            assert.equal(await evaluate(`!!(${reuseDialog})`), false);
            release!(); releases.delete(release!); gate = undefined;
          }
        };
        const copied = async (token: string) => {
          expectedTokens.push(token);
          await until(`window.qa.writes.length===${expectedTokens.length}`);
          const writes = await evaluate("window.qa.writes") as string[];
          writes.forEach((text, index) => assertCommand(text, expectedTokens[index]));
          clipboardWrites++;
          assert.equal(await evaluate(`!!(${reuseDialog})`), false);
        };
        const noCopy = async () => {
          await delay(100);
          assert.equal(await evaluate("window.qa.writes.length"), expectedTokens.length);
          assert.deepEqual(await evaluate("window.qa.fallbacks"), []);
          assert.deepEqual(await evaluate("window.qa.prompts"), []);
        };
        const checkReuse = async (hostName: string, online: boolean) => {
          await until(`!!(${reuseDialog})`);
          const description = `(${reuseDialog}).querySelector('p[id]')`;
          const expected = await evaluate(`window.qa.t('已关联主机：{0}（{1}）。',[${JSON.stringify(hostName)},window.qa.t(${JSON.stringify(online ? "在线" : "离线")})])+${translated(takeoverNotice)}`);
          assert.equal(await evaluate(`${description}.textContent`), expected, "confirmation shows the binding fetched after the installation dialog opened");
          await visible(`(${reuseDialog}).querySelector('h2')`);
          await visible(description);
          await visible(button("取消", reuseDialog));
          await visible(button("确认并复制", reuseDialog));
          assert.equal(await evaluate(`(${reuseDialog}).scrollWidth<=(${reuseDialog}).clientWidth+1 && document.documentElement.scrollWidth<=innerWidth+1`), true, "key confirmation content fits the viewport");
          await noCopy();
        };

        await attemptCopy("fresh-unbound-first", null, null, true); await copied("fresh-unbound-first");
        await attemptCopy("fresh-unbound-second", null); await copied("fresh-unbound-second");
        for (const online of [true, false]) {
          const hostName = online ? "Latest online host" : "Changed offline host";
          const token = online ? "fresh-online-cancel" : "fresh-offline-cancel";
          await attemptCopy(token, { id: online ? 101 : 102, name: hostName, isOnline: online });
          await checkReuse(hostName, online);
          await click(button("取消", reuseDialog)); cancellations++;
          await until(`!(${reuseDialog})`); await noCopy();
        }
        for (const online of [true, false]) {
          const hostName = online ? "Confirmed online host" : "Confirmed offline host";
          const token = online ? "fresh-online-confirm" : "fresh-offline-confirm";
          await attemptCopy(token, { id: online ? 103 : 104, name: hostName, isOnline: online });
          await checkReuse(hostName, online);
          await click(button("确认并复制", reuseDialog)); confirmations++;
          await copied(token);
        }
        const expectedErrors: string[] = [];
        for (const code of ["INTERNAL_SERVER_ERROR", "FORBIDDEN"] as const) {
          const message = code === "FORBIDDEN" ? "Cross-account token denied" : "Controlled installation lookup failure";
          await attemptCopy("must-not-copy-rejected-token", null, { code, message });
          await until(`Array.from(document.querySelectorAll('[data-sonner-toast]')).some(el=>el.textContent.includes(${JSON.stringify(message)}))`);
          await visible(`Array.from(document.querySelectorAll('[data-sonner-toast]')).find(el=>el.textContent.includes(${JSON.stringify(message)}))`);
          expectedErrors.push(`agentTokens.getInstallToken: ${message}`);
          assert.equal(await evaluate(`!!(${reuseDialog})`), false);
          await noCopy();
        }
        for (const malformed of [{ token: "must-not-copy-incomplete-token" }, { boundHost: null }] as InstallReply[]) {
          await evaluate("window.qa.dismissToasts()");
          await until("document.querySelectorAll('[data-sonner-toast]').length===0");
          await attemptCopy(malformed.token, malformed.boundHost);
          // Neither incomplete response may reach the clipboard or confirmation.
          await until(`Array.from(document.querySelectorAll('[data-sonner-toast]')).some(el=>el.textContent.includes(${translated("获取安装命令失败")}))`);
          await noCopy();
          assert.equal(await evaluate(`!!(${reuseDialog})`), false);
        }
        await attemptCopy("fresh-recovered-token", null); await copied("fresh-recovered-token");
        await noCopy();
        assert.equal(await evaluate("document.documentElement.scrollWidth<=innerWidth+1"), true);
        assert.equal(await evaluate(`(${activeDialog}).scrollWidth<=(${activeDialog}).clientWidth+1`), true);
        assert.deepEqual(apiErrors.slice(apiErrorStart), expectedErrors, "only the two intentionally rejected API requests fail");
        assert.equal(lookups.length - lookupStart, entry === "existing" ? 12 : 11);
      });
    }
    assert.deepEqual(browserErrors, [], "no uncaught browser exceptions");
    assert.deepEqual(blockedExternalRequests, [], "the page requests only the isolated loopback origin");
    assert.equal(copyQueries, 88);
    assert.equal(lookups.length, 92);
    assert.equal(clipboardWrites, 40);
    assert.equal(cancellations, 16);
    assert.equal(confirmations, 16);
    t.diagnostic(`8 locale/viewport/entry cases; ${copyQueries} copy-time queries; ${lookups.length} total install lookups; ${clipboardWrites} intercepted writes; ${cancellations} cancels; ${confirmations} confirmations`);
  } finally {
    for (const release of releases) release();
    socket?.close();
    if (browser && browser.exitCode === null) {
      const exited = new Promise<void>(resolve => browser!.once("exit", () => resolve()));
      browser.kill(); await exited;
    }
    if (httpServer) await new Promise<void>((resolve, reject) => httpServer!.close(error => error ? reject(error) : resolve()));
    await server?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
