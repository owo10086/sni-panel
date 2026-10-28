import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createServer as createHttpServer } from "node:http";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import Database from "better-sqlite3";
import cookieParser from "cookie-parser";
import { build } from "esbuild";
import express from "express";
import { createServer } from "vite";

const chrome = process.env.CHROME_BIN || (process.platform === "darwin"
  ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "/usr/bin/chromium");

// Only the route/status surface is a probe. Identity, credentials, auth errors,
// query state and polling all come from the real hook and real HTTP routers.
// The small authentication-error boundary uses the same production predicate
// as main.tsx; this intentionally does not mount the complete Login/App tree.
const harness = `
import React, {useEffect} from 'react';
import {createRoot} from 'react-dom/client';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {getQueryKey} from '@trpc/react-query';
import {httpLink} from '@trpc/client';
import superjson from 'superjson';
import {trpc} from './client/src/lib/trpc';
import {useAuth} from './client/src/_core/hooks/useAuth';
import {isAuthenticationFailure, shouldRetryQuery} from './client/src/lib/queryPolicy';
import {initializeLanguage, setLanguagePreference, t} from './client/src/i18n';
const language = new URLSearchParams(location.search).get('lang');
if (language) setLanguagePreference(language);
await initializeLanguage();
const queryClient = new QueryClient({defaultOptions:{queries:{retry:shouldRetryQuery,
  refetchOnWindowFocus:false,staleTime:5000,gcTime:30*60_000},mutations:{retry:false}}});
const client = trpc.createClient({links:[httpLink({url:'/api/trpc',transformer:superjson,
  fetch:(input,init)=>fetch(input,{...init,credentials:'include'})})]});
const key = getQueryKey(trpc.auth.me, undefined, 'query');
queryClient.getQueryCache().subscribe(event => {
  if (event.type==='updated' && event.action.type==='error' && isAuthenticationFailure(event.query.state.error)) {
    queryClient.clear();
    if (location.pathname!=='/login') location.assign('/login');
  }
});
const states = [];
window.qa = {t,states,
  state:()=>{const s=queryClient.getQueryState(key);return s && {status:s.status,
    fetchStatus:s.fetchStatus,errorCount:s.errorUpdateCount,errorCode:s.error?.data?.code,
    user:s.data && {id:s.data.id,username:s.data.username,role:s.data.role}}},
  recheck:()=>queryClient.invalidateQueries({queryKey:key}),
  login:async username=>{const user=await client.auth.login.mutate({username,password:'browser-test-password'});
    await queryClient.invalidateQueries({queryKey:key});return {id:user.id,username:user.username}},
  adminRead:async()=>{try {await client.system.panelLogs.query({limit:1});return {status:200}}
    catch(error){return {status:error.data?.httpStatus,code:error.data?.code}}}
};
function Probe() {
  const {user,loading,logout}=useAuth();
  useEffect(()=>{
    states.push({id:user?.id ?? null,role:user?.role ?? null,loading,path:location.pathname});
    if (!loading && !user && location.pathname!=='/login') location.assign('/login');
  },[user,loading]);
  const status=loading?'pending':user?'authenticated':'anonymous';
  return <main data-status={status} data-user-id={user?.id ?? ''} data-role={user?.role ?? ''}>
    <h1>{t(loading?'加载中':user?'当前用户':'登录账号以继续')}</h1>
    {user && <><p id="identity">{user.username}</p><p id="role">{user.role}</p>
      <button id="logout" onClick={logout}>{t('退出登录')}</button></>}
  </main>;
}
createRoot(document.getElementById('root')).render(<trpc.Provider client={client} queryClient={queryClient}>
  <QueryClientProvider client={queryClient}><Probe/></QueryClientProvider></trpc.Provider>);
`;

type Read = { path: string; at: number; status: number; cleared: boolean; hadCookie: boolean };
type BrowserCookie = { name: string; value: string; httpOnly: boolean };

test("browser: useAuth preserves real login through SQL faults, backs off and rejects invalid sessions", {
  timeout: 240_000,
}, async t => {
  // An absent browser is an unmet acceptance check, not a silently passing skip.
  assert.ok(fs.existsSync(chrome), `Chrome is required (CHROME_BIN): ${chrome}`);
  const directory = fs.mkdtempSync("/tmp/forwardx-use-auth-browser-");
  // Set these before importing any server module. No dotenv/server entry point
  // is used; even optional persisted config/secret/log paths stay in /tmp.
  Object.assign(process.env, {
    NODE_ENV: "test", DATABASE_TYPE: "sqlite", SQLITE_PATH: path.join(directory, "auth.db"),
    DATABASE_CONFIG_PATH: path.join(directory, "database.json"), MYSQL_CONFIG_PATH: path.join(directory, "mysql.json"),
    JWT_SECRET: "use-auth-browser-isolated-secret-32-characters", FORWARDX_JWT_SECRET_PATH: path.join(directory, "jwt.secret"),
    FORWARDX_DEV_PANEL: "0", FORWARDX_LOG_DIR: path.join(directory, "logs"),
    FORWARDX_PORT_CONFIG_PATH: path.join(directory, "panel.env"),
    FORWARDX_SEAMLESS_MIGRATION_STATE_PATH: path.join(directory, "migration.json"),
    TELEGRAM_BOT_TOKEN: "", TELEGRAM_BOT_POLLING: "false", DISCORD_BOT_TOKEN: "",
  });
  let vite: Awaited<ReturnType<typeof createServer>> | undefined;
  let httpServer: ReturnType<typeof createHttpServer> | undefined;
  let browser: ReturnType<typeof spawn> | undefined;
  let socket: WebSocket | undefined;
  let external: InstanceType<typeof Database> | undefined;
  let runtime: typeof import("../../../../server/dbRuntime") | undefined;
  const reads: Read[] = [];
  const browserErrors: string[] = [];
  const blockedExternalRequests: string[] = [];
  const apiErrors: Array<{ path: string | undefined; code: string }> = [];
  try {
    runtime = await import("../../../../server/dbRuntime");
    const { ensureDatabaseSchema } = await import("../../../../server/dbSchema");
    const { createUser } = await import("../../../../server/repositories/userRepository");
    const { setSetting } = await import("../../../../server/repositories/settingsRepository");
    const { createContext, updateMultiDeviceLoginSettingCache } = await import("../../../../server/_core/context");
    const { databaseHealth } = await import("../../../../server/databaseHealthState");
    const { router } = await import("../../../../server/_core/trpc");
    const { authRouter } = await import("../../../../server/routers/auth");
    const { systemRouter } = await import("../../../../server/_core/systemRouter");
    const { COOKIE_NAME } = await import("../../../../shared/const");
    const { encodeSessionLease } = await import("../../../../server/session");
    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.SQLITE_PATH! } });
    await ensureDatabaseSchema();
    const alice = await createUser({ username: "alice@browser.invalid", password: "browser-test-password", role: "user" });
    const bob = await createUser({ username: "bob@browser.invalid", password: "browser-test-password", role: "admin" });
    await setSetting("authCaptchaEnabled", "false");
    await setSetting("allowMultiDeviceLogin", "false");
    updateMultiDeviceLoginSettingCache(false);
    databaseHealth.healthy();

    const bundle = await build({ stdin: { contents: harness, loader: "tsx", resolveDir: process.cwd() },
      bundle: true, write: false, format: "esm", platform: "browser", target: "es2022", jsx: "automatic", logLevel: "silent" });
    vite = await createServer({ configFile: false, envFile: false, root: process.cwd(), envDir: directory,
      cacheDir: path.join(directory, "vite-cache"), appType: "custom",
      server: { middlewareMode: true, preTransformRequests: false, watch: null, hmr: false, ws: false },
      optimizeDeps: { noDiscovery: true },
    });
    const api = express();
    api.use(express.json());
    api.use(cookieParser());
    api.use("/api/trpc", (req, res, next) => {
      const record: Read = { path: req.path.slice(1), at: performance.now(), status: 0,
        cleared: false, hadCookie: !!req.cookies[COOKIE_NAME] };
      res.once("finish", () => {
        record.status = res.statusCode;
        const cookies = res.getHeader("set-cookie");
        record.cleared = (Array.isArray(cookies) ? cookies : [String(cookies || "")])
          .some(value => value.startsWith(COOKIE_NAME + "=;"));
        reads.push(record);
      });
      next();
    }, createExpressMiddleware({ router: router({ auth: authRouter, system: systemRouter }), createContext,
      onError: ({ path: procedure, error }) => apiErrors.push({ path: procedure, code: error.code }),
    }));
    vite.middlewares.use(api);
    vite.middlewares.use((req, res, next) => {
      const pathname = new URL(req.url || "/", "http://127.0.0.1").pathname;
      if (pathname === "/app.js") {
        res.setHeader("Content-Type", "application/javascript"); res.end(bundle.outputFiles[0].text);
      } else if (pathname === "/qa" || pathname === "/login") {
        res.setHeader("Content-Type", "text/html");
        res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;font:16px system-ui}main{box-sizing:border-box;max-width:40rem;padding:24px}p{overflow-wrap:anywhere}button{font:inherit;padding:12px}h1{font-size:24px}</style><div id="root"></div><script type="module" src="/app.js"></script>');
      } else if (pathname === "/blank") {
        res.setHeader("Content-Type", "text/html"); res.end("<!doctype html><title>Isolated auth fixture</title>");
      } else if (pathname === "/favicon.ico") { res.statusCode = 204; res.end(); }
      else next();
    });
    httpServer = createHttpServer(vite.middlewares);
    await new Promise<void>((resolve, reject) => {
      httpServer!.once("error", reject); httpServer!.listen(0, "127.0.0.1", resolve);
    });
    const origin = `http://127.0.0.1:${(httpServer.address() as { port: number }).port}`;
    browser = spawn(chrome, ["--headless=new", "--no-sandbox", "--disable-gpu", "--disable-background-networking",
      "--disable-component-update", "--disable-sync", "--no-first-run", "--no-default-browser-check",
      "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows",
      "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0",
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
    const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
    const command = (method: string, params: Record<string, unknown> = {}): Promise<any> => new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timed out: ${method}`)); }, 10_000);
      pending.set(id, { resolve, reject, timer }); socket!.send(JSON.stringify({ id, method, params }));
    });
    socket.addEventListener("message", event => {
      const message = JSON.parse(String(event.data));
      if (message.method === "Runtime.exceptionThrown") browserErrors.push(JSON.stringify(message.params.exceptionDetails));
      if (message.method === "Fetch.requestPaused") {
        const externalRequest = !message.params.request.url.startsWith(origin + "/");
        if (externalRequest) blockedExternalRequests.push(message.params.request.url);
        void command(externalRequest ? "Fetch.failRequest" : "Fetch.continueRequest", {
          requestId: message.params.requestId, ...(externalRequest ? { errorReason: "BlockedByClient" } : {}),
        }).catch(error => browserErrors.push(String(error)));
      }
      if (!message.id) return;
      const handler = pending.get(message.id); pending.delete(message.id);
      if (handler) clearTimeout(handler.timer);
      if (message.error) handler?.reject(new Error(JSON.stringify(message.error))); else handler?.resolve(message.result);
    });
    const evaluate = async (expression: string): Promise<any> => {
      const result = await command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result?.value;
    };
    const until = async (expression: string, timeout = 10_000) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        if (await evaluate(expression)) return;
        await delay(40);
      }
      assert.fail(`browser condition timed out: ${expression}\n${await evaluate("document.body.innerText")}\n${JSON.stringify(apiErrors)}\n${browserErrors.join("\n")}`);
    };
    const meReads = (since: number) => reads.slice(since).filter(read => read.path === "auth.me");
    const cookie = async (): Promise<BrowserCookie | undefined> => {
      const result = await command("Network.getCookies", { urls: [origin] });
      return result.cookies.find((value: BrowserCookie) => value.name === COOKIE_NAME);
    };
    const unchangedCookie = async (value: string) => {
      // Never include the token in assertion output, even for test accounts.
      assert.ok((await cookie())?.value === value, "the original HttpOnly login cookie is retained");
    };
    const sid = (value: string) => String(JSON.parse(Buffer.from(decodeURIComponent(value).split(".")[1], "base64url").toString()).sid);
    const authenticated = async (id: number, username: string, role = "user") => {
      await until(`document.querySelector('main')?.dataset.status==='authenticated' && document.querySelector('main')?.dataset.userId==='${id}' && document.querySelector('main')?.dataset.role===${JSON.stringify(role)}`);
      assert.equal(await evaluate("document.querySelector('#identity').textContent"), username);
      assert.equal(await evaluate("location.pathname"), "/qa");
    };
    const retained = async (token: string, id?: number) => {
      await unchangedCookie(token);
      assert.equal(await evaluate("location.pathname"), "/qa", "a SQL failure must not navigate to Login");
      assert.equal(await evaluate("document.querySelector('main').dataset.status"), id ? "authenticated" : "pending");
      assert.equal(await evaluate("document.querySelector('main').dataset.userId"), id ? String(id) : "");
      assert.equal(await evaluate("window.qa.states.some(s=>!s.loading && !s.id)"), false, "no anonymous frame during infrastructure failure");
    };
    const login = async (username = "alice@browser.invalid") => {
      await command("Page.navigate", { url: origin + "/blank" });
      await until("document.title==='Isolated auth fixture'");
      // The browser receives Set-Cookie from actual password authentication;
      // no CDP cookie injection or fixed auth.me response is involved.
      const response = await evaluate(`(async()=>{const r=await fetch('/api/trpc/auth.login',{method:'POST',credentials:'include',headers:{'content-type':'application/json'},body:JSON.stringify({json:{username:${JSON.stringify(username)},password:'browser-test-password'}})});const body=await r.json();return {status:r.status,id:body.result?.data?.json?.id}})()`);
      assert.equal(response.status, 200, "real password login succeeds");
      assert.equal(response.id, username.startsWith("alice") ? alice : bob);
      const credential = await cookie();
      assert.ok(credential?.value, "login sets a browser cookie");
      assert.equal(credential.httpOnly, true);
      assert.equal(await evaluate(`document.cookie.includes(${JSON.stringify(COOKIE_NAME + "=")})`), false);
      return credential.value;
    };
    const open = async (language = "en", width = 1280) => {
      await command("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: width === 390 });
      await command("Page.navigate", { url: `${origin}/qa?lang=${language}` });
      await until("!!window.qa && !!document.querySelector('main')");
      assert.equal(await evaluate("document.documentElement.lang"), language);
    };
    const visible = async (selector: string) => {
      assert.equal(await evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)return false;const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>0&&r.height>0&&r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight&&s.visibility==='visible'})()`), true, `${selector} fits the viewport`);
      assert.equal(await evaluate("document.documentElement.scrollWidth<=innerWidth"), true);
    };
    const recheck = async () => { await evaluate("window.qa.recheck()"); };
    const anonymous = async () => {
      await until("location.pathname==='/login' && document.querySelector('main')?.dataset.status==='anonymous'");
      assert.equal(await cookie(), undefined, "invalid credentials are cleared by the server");
      assert.equal(await evaluate("!!document.querySelector('#identity')"), false);
      await visible("h1");
    };
    const noAutomaticRetries = async () => {
      const count = reads.length;
      await delay(5400);
      assert.equal(reads.length, count, "a terminal auth decision/successful anonymous read does not keep polling");
    };
    await command("Runtime.enable");
    await command("Page.enable");
    await command("Network.enable");
    await command("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
    t.diagnostic(`${(await command("Browser.getVersion")).product}; Node ${process.version}; real HTTP/SQLite/password cookies; /tmp isolation`);

    await t.test("en / 1280px: first-load SQL failure stays pending; real 5/10/20/30/30s polling recovers with the same cookie", async () => {
      const token = await login();
      await runtime!.executeRaw("ALTER TABLE users RENAME TO unavailable_users");
      const start = reads.length;
      await open();
      for (let index = 0; index < 5; index++) {
        await until(`window.qa.state()?.errorCount>=${index + 1}`, index === 0 ? 10_000 : [0, 8_000, 13_000, 23_000, 33_000][index]);
        assert.equal(meReads(start).length, index + 1, "each failure schedules one bounded poll, without an immediate retry");
        await retained(token);
        await visible("h1");
        assert.equal(await evaluate("document.querySelector('h1').textContent"), "Loading");
      }
      await runtime!.executeRaw("ALTER TABLE unavailable_users RENAME TO users");
      await authenticatedAfterPoll();
      async function authenticatedAfterPoll() {
        await until(`window.qa.state()?.status==='success'`, 33_000);
        await authenticated(alice, "alice@browser.invalid");
      }
      const attempts = meReads(start);
      assert.deepEqual(attempts.map(read => read.status), [500, 500, 500, 500, 500, 200]);
      assert.ok(attempts.every(read => read.hadCookie && !read.cleared));
      const intervals = attempts.slice(1).map((read, index) => read.at - attempts[index].at);
      [5000, 10000, 20000, 30000, 30000].forEach((expected, index) => {
        assert.ok(intervals[index] >= expected - 350 && intervals[index] <= expected + 2500,
          `HTTP interval ${index + 1}: ${Math.round(intervals[index])}ms, expected ${expected}ms`);
      });
      await unchangedCookie(token);
      t.diagnostic(`observed real HTTP polling intervals: ${intervals.map(Math.round).join(" / ")} ms`);
    });

    await t.test("en / 1280px: a background SQL failure retains the verified user; success resets backoff to 5s", async () => {
      const token = (await cookie())!.value;
      await runtime!.executeRaw("ALTER TABLE users RENAME TO unavailable_users");
      const start = reads.length;
      await recheck();
      assert.equal(await evaluate("window.qa.state().status"), "error");
      await retained(token, alice);
      assert.equal(await evaluate("document.querySelector('h1').textContent"), "Current User");
      await runtime!.executeRaw("ALTER TABLE unavailable_users RENAME TO users");
      await until("window.qa.state()?.status==='success'", 8000);
      await authenticated(alice, "alice@browser.invalid");
      const attempts = meReads(start);
      assert.deepEqual(attempts.map(read => read.status), [500, 200]);
      const interval = attempts[1].at - attempts[0].at;
      assert.ok(interval >= 4650 && interval <= 7500, `successful recovery resets the next error delay: ${interval}ms`);
      await unchangedCookie(token);
    });

    await t.test("zh-CN / 390px: first-load SQL failure stays pending and recovers without a Login frame", async () => {
      const token = await login();
      await runtime!.executeRaw("ALTER TABLE users RENAME TO unavailable_users");
      const start = reads.length;
      await open("zh-CN", 390);
      await until("window.qa.state()?.status==='error'");
      await retained(token);
      assert.equal(await evaluate("document.querySelector('h1').textContent"), "加载中");
      await visible("h1");
      await runtime!.executeRaw("ALTER TABLE unavailable_users RENAME TO users");
      await until("window.qa.state()?.status==='success'", 8000);
      await authenticated(alice, "alice@browser.invalid");
      assert.equal(await evaluate("document.querySelector('h1').textContent"), "当前用户");
      await visible("#identity"); await visible("#logout");
      assert.deepEqual(meReads(start).map(read => read.status), [500, 200]);
      assert.ok(meReads(start).every(read => read.hadCookie && !read.cleared));
      await unchangedCookie(token);
    });

    await t.test("zh-CN / 390px: a genuine second SQLite writer returns 503, preserves the user and automatically recovers", async () => {
      const token = (await cookie())!.value;
      await runtime!.executeRaw("UPDATE users SET browserSessionToken=? WHERE id=?", [encodeSessionLease(sid(token), Date.now() - 31_000), alice]);
      await runtime!.withSqliteExclusive(db => db.pragma("busy_timeout=30"));
      external = new Database(process.env.SQLITE_PATH!);
      external.exec("BEGIN IMMEDIATE");
      const start = reads.length;
      try {
        await recheck();
        assert.equal(await evaluate("window.qa.state().errorCode"), "SERVICE_UNAVAILABLE");
        await retained(token, alice);
        assert.equal(databaseHealth.snapshot().state, "healthy", "SQLite contention is backpressure, not an outage");
      } finally { external.exec("ROLLBACK"); external.close(); external = undefined; }
      await until("window.qa.state()?.status==='success'", 8000);
      await authenticated(alice, "alice@browser.invalid");
      assert.deepEqual(meReads(start).map(read => read.status), [503, 200]);
      assert.ok(meReads(start).every(read => read.hadCookie && !read.cleared));
      await unchangedCookie(token);
    });

    await t.test("en / 1280px: real account switching isolates auth data; role revocation immediately denies admin HTTP access", async () => {
      await login(); await open(); await authenticated(alice, "alice@browser.invalid");
      assert.deepEqual(await evaluate("window.qa.adminRead()"), { status: 403, code: "FORBIDDEN" });
      const start = reads.length;
      assert.deepEqual(await evaluate("window.qa.login('bob@browser.invalid')"), { id: bob, username: "bob@browser.invalid" });
      await authenticated(bob, "bob@browser.invalid", "admin");
      const bobCookie = (await cookie())!.value;
      assert.deepEqual(await evaluate("window.qa.adminRead()"), { status: 200 });
      await runtime!.executeRaw("ALTER TABLE users RENAME TO unavailable_users");
      try {
        await recheck(); await retained(bobCookie, bob);
        assert.equal(await evaluate("document.querySelector('#identity').textContent"), "bob@browser.invalid", "the retained identity belongs to the newly verified account");
      } finally { await runtime!.executeRaw("ALTER TABLE unavailable_users RENAME TO users"); }
      await recheck();
      await runtime!.executeRaw("UPDATE users SET role='user' WHERE id=?", [bob]);
      assert.deepEqual(await evaluate("window.qa.adminRead()"), { status: 403, code: "FORBIDDEN" });
      await recheck(); await authenticated(bob, "bob@browser.invalid");
      await unchangedCookie(bobCookie);
      assert.ok(meReads(start).every(read => read.hadCookie && !read.cleared));
      assert.equal(await evaluate("Object.values(localStorage).some(value=>value.includes('alice@browser.invalid')||value.includes('bob@browser.invalid'))"), false, "auth identity is not persisted as presentation data");
      await noAutomaticRetries();
    });

    await t.test("zh-CN / 390px: disabling a real account clears its cookie and reaches Login without endless retry", async () => {
      await login("bob@browser.invalid"); await open("zh-CN", 390); await authenticated(bob, "bob@browser.invalid");
      const start = reads.length;
      await runtime!.executeRaw("UPDATE users SET accountEnabled=0 WHERE id=?", [bob]);
      // Navigation can destroy the Runtime.evaluate context after the response.
      await evaluate("void window.qa.recheck()");
      await anonymous();
      assert.ok(meReads(start).some(read => read.status === 401 && read.cleared));
      assert.equal(await evaluate("document.querySelector('h1').textContent"), "登录账号以继续");
      await noAutomaticRetries();
      await runtime!.executeRaw("UPDATE users SET accountEnabled=1 WHERE id=?", [bob]);
    });

    await t.test("en / 1280px: an expired SQLite session rejects a genuine login cookie and stops polling", async () => {
      const token = await login(); await open(); await authenticated(alice, "alice@browser.invalid");
      const start = reads.length;
      await runtime!.executeRaw("UPDATE auth_sessions SET expiresAt=1 WHERE sid=?", [sid(token)]);
      await evaluate("void window.qa.recheck()");
      await anonymous();
      assert.ok(meReads(start).some(read => read.status === 401 && read.cleared));
      assert.equal(await evaluate("document.querySelector('h1').textContent"), "Sign in to your account to continue");
      await noAutomaticRetries();
    });

    await t.test("zh-CN / 390px: explicit SQL session revocation reaches Login and cannot reuse cached identity", async () => {
      const token = await login(); await open("zh-CN", 390); await authenticated(alice, "alice@browser.invalid");
      const start = reads.length;
      await runtime!.executeRaw("UPDATE auth_sessions SET revokedAt=?,revokeReason='browser_acceptance' WHERE sid=?", [Math.floor(Date.now() / 1000), sid(token)]);
      await evaluate("void window.qa.recheck()");
      await anonymous();
      assert.ok(meReads(start).some(read => read.status === 401 && read.cleared));
      await noAutomaticRetries();
    });

    await t.test("en / 1280px: the actual useAuth logout mutation revokes the server session and navigates to Login", async () => {
      const token = await login(); await open(); await authenticated(alice, "alice@browser.invalid");
      await visible("#logout");
      assert.equal(await evaluate("document.querySelector('#logout').textContent"), "Log Out");
      const start = reads.length;
      const point = await evaluate("(()=>{const r=document.querySelector('#logout').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()");
      await command("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...point });
      await command("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...point });
      await anonymous();
      assert.ok(reads.slice(start).some(read => read.path === "auth.logout" && read.status === 200 && read.cleared));
      const sessions = await runtime!.queryRaw<{ revokedAt: number | null; revokeReason: string }>("SELECT revokedAt,revokeReason FROM auth_sessions WHERE sid=?", [sid(token)]);
      assert.ok(sessions[0].revokedAt);
      assert.equal(sessions[0].revokeReason, "logout");
      // Replaying the actual, now-revoked cookie through HTTP cannot regain access.
      const replay = await fetch(origin + "/api/trpc/auth.me", { headers: { cookie: COOKIE_NAME + "=" + token } });
      assert.equal(replay.status, 401);
      assert.ok(replay.headers.get("set-cookie")?.startsWith(COOKIE_NAME + "=;"));
      await noAutomaticRetries();
    });

    assert.deepEqual(browserErrors, [], "no uncaught browser exceptions");
    assert.deepEqual(blockedExternalRequests, [], "the browser made no requests outside the isolated loopback origin");
    assert.ok(apiErrors.every(error => ["INTERNAL_SERVER_ERROR", "SERVICE_UNAVAILABLE", "UNAUTHORIZED", "FORBIDDEN"].includes(error.code)));
    t.diagnostic("9 browser scenarios; real routers/context/SQLite; en desktop + zh-CN 390px; no production entry, external traffic or notification calls");
  } finally {
    if (external) { external.exec("ROLLBACK"); external.close(); }
    socket?.close();
    let browserStopped = true;
    // Signal exits leave exitCode null; do not wait for an already-fired event.
    if (browser && browser.exitCode === null && browser.signalCode === null) {
      const exited = new Promise<boolean>(resolve => browser!.once("exit", () => resolve(true)));
      browser.kill();
      browserStopped = await Promise.race([exited, delay(3000, false, { ref: false })]);
      if (!browserStopped) {
        browser.kill("SIGKILL");
        browserStopped = await Promise.race([exited, delay(3000, false, { ref: false })]);
      }
    }
    if (httpServer) {
      httpServer.closeAllConnections();
      await new Promise<void>((resolve, reject) => httpServer!.close(error => error ? reject(error) : resolve()));
    }
    await vite?.close();
    await runtime?.closeDatabase();
    fs.rmSync(directory, { recursive: true, force: true });
    assert.ok(browserStopped, "isolated Chrome terminates within the bounded cleanup window");
  }
});
