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
import { useRuleGroupBulkEditor, RuleGroupBulkEditor, RuleGroupBulkPagination, RuleGroupBulkApplyButton } from './client/src/components/rules/PersonalRuleGroups';
import { ConfirmDialogProvider } from './client/src/components/ui/confirm-dialog';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from './client/src/components/ui/dialog';
import { initializeLanguage, setLanguagePreference } from './client/src/i18n';
setLanguagePreference('en'); await initializeLanguage();
const queryClient = new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});
const client = trpc.createClient({links:[httpBatchLink({url:'/api/trpc',transformer:superjson})]});
function Editor() {
  const editor = useRuleGroupBulkEditor({enabled:true});
  return <Dialog open><DialogContent className="flex max-h-[92svh] flex-col overflow-hidden sm:max-w-xl">
    <DialogHeader><DialogTitle>Organize rules</DialogTitle><DialogDescription>Account private groups</DialogDescription></DialogHeader>
    <div id="group-fields" className="min-h-0 overflow-y-auto"><RuleGroupBulkEditor editor={editor}/></div>
    <DialogFooter id="group-footer" className="shrink-0 sm:items-center sm:justify-between"><RuleGroupBulkPagination editor={editor}/><RuleGroupBulkApplyButton editor={editor}/></DialogFooter>
  </DialogContent></Dialog>;
}
createRoot(document.getElementById('root')).render(<trpc.Provider client={client} queryClient={queryClient}><QueryClientProvider client={queryClient}><ConfirmDialogProvider><Editor/></ConfirmDialogProvider></QueryClientProvider></trpc.Provider>);
`;

test("browser: personal groups keep cross-page selection and apply only the chosen rules", { skip: !fs.existsSync(chrome), timeout: 60_000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-groups-browser-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  process.env.DATABASE_TYPE = "sqlite";
  process.env.DATABASE_CONFIG_PATH = path.join(directory, "database.json");
  process.env.SQLITE_PATH = path.join(directory, "groups.db");
  process.env.FORWARDX_LOG_DIR = path.join(directory, "logs");
  const runtime = await import("../../../../server/dbRuntime");
  t.after(() => runtime.closeDatabase());
  await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.SQLITE_PATH } });
  await (await import("../../../../server/dbSchema")).ensureDatabaseSchema();
  const { rulesRouter } = await import("../../../../server/routers/rules");
  const { router } = await import("../../../../server/_core/trpc");
  const context = { user: { id: 1, username: "group-owner", role: "admin", accountEnabled: true }, req: { headers: {} }, res: {} } as any;
  const caller = rulesRouter.createCaller(context);
  await runtime.insertAndGetId("users", { id: 1, username: "group-owner", password: "unused", role: "admin" });
  await runtime.insertAndGetId("users", { id: 2, username: "other-owner", password: "unused", role: "user" });
  for (let id = 1; id <= 24; id++) await runtime.insertAndGetId("forward_rules", {
    id, userId: id === 24 ? 2 : 1, name: id === 24 ? "Foreign rule" : `Rule ${id}`, hostId: 1,
    sourcePort: 10000 + id, targetIp: "192.0.2.1", targetPort: 443, protocol: "tcp", forwardType: "realm",
  });
  const groupA = await caller.savePersonalGroup({ name: "Group A" });
  const groupB = await caller.savePersonalGroup({ name: "Group B" });
  const bundle = await build({ stdin: { contents: harness, loader: "tsx", resolveDir: process.cwd() }, bundle: true, write: false,
    format: "esm", platform: "browser", target: "es2022", jsx: "automatic", logLevel: "silent" });
  const server = await createServer({ configFile: false, root: process.cwd(), plugins: [tailwindcss()], appType: "custom",
    resolve: { alias: { "@": path.join(process.cwd(), "client/src"), "@shared": path.join(process.cwd(), "shared") } },
    server: { host: "127.0.0.1", port: 0, preTransformRequests: false }, optimizeDeps: { noDiscovery: true },
  });
  t.after(() => server.close());
  const api = express(); api.use(express.json());
  api.use("/api/trpc", createExpressMiddleware({ router: router({ rules: rulesRouter }), createContext: () => context }));
  server.middlewares.use(api);
  server.middlewares.use((req, res, next) => {
    if (req.url === "/app.js") { res.setHeader("Content-Type", "application/javascript"); res.end(bundle.outputFiles[0].text); }
    else if (req.url === "/qa") { res.setHeader("Content-Type", "text/html"); res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/client/src/index.css"><div id="root"></div><script type="module" src="/app.js"></script>'); }
    else next();
  });
  await server.listen();
  const address = server.httpServer!.address() as { port: number };
  const browser = spawn(chrome, ["--headless=new", "--no-sandbox", "--disable-gpu", "--remote-debugging-port=0", `--user-data-dir=${path.join(directory, "chrome")}`, "about:blank"], { stdio: "ignore" });
  let socket: WebSocket | undefined;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  let nextId = 0;
  try {
    const portFile = path.join(directory, "chrome", "DevToolsActivePort");
    for (let count = 0; count < 100 && !fs.existsSync(portFile); count++) await delay(50);
    assert.ok(fs.existsSync(portFile), "isolated Chrome started");
    const port = fs.readFileSync(portFile, "utf8").split("\n")[0];
    const page = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json() as { webSocketDebuggerUrl: string };
    socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => { socket!.addEventListener("open", () => resolve(), { once: true }); socket!.addEventListener("error", () => reject(new Error("CDP connection failed")), { once: true }); });
    socket.addEventListener("message", event => {
      const message = JSON.parse(String(event.data));
      if (!message.id) return;
      const handler = pending.get(message.id); pending.delete(message.id);
      if (message.error) handler?.reject(new Error(JSON.stringify(message.error))); else handler?.resolve(message.result);
    });
    const command = (method: string, params: Record<string, unknown> = {}): Promise<any> => new Promise((resolve, reject) => {
      const id = ++nextId; pending.set(id, { resolve, reject }); socket!.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async (expression: string) => {
      const result = await command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result?.value;
    };
    const until = async (expression: string) => {
      for (let count = 0; count < 100; count++) { if (await evaluate(expression)) return; await delay(30); }
      assert.fail(`browser condition timed out: ${expression}\n${await evaluate(`document.body.innerText + '\\n' + JSON.stringify(Array.from(document.querySelectorAll('button')).map(b=>({text:b.textContent,expanded:b.getAttribute('aria-expanded'),state:b.getAttribute('data-state'),disabled:b.disabled})))`)}`);
    };
    const clickText = async (text: string) => {
      const match = `Array.from(document.querySelectorAll('button,[role="option"]')).find(element=>element.textContent.trim()===${JSON.stringify(text)})`;
      await until(`!!(${match})`);
      await evaluate(`(${match}).click()`);
    };
    const selectGroup = async (name: string) => {
      await until(`!document.querySelector('[role="listbox"]')`);
      const trigger = `Array.from(document.querySelectorAll('button')).find(b=>b.textContent.includes('group') && (b.textContent.includes('selected') || b.textContent.includes('Select groups')))`;
      await until(`!!(${trigger}) && !(${trigger}).disabled`);
      await evaluate(`(${trigger}).click()`);
      await until(`!!Array.from(document.querySelectorAll('label')).find(label=>label.textContent.includes(${JSON.stringify(name)}))`);
      await evaluate(`Array.from(document.querySelectorAll('label')).find(label=>label.textContent.includes(${JSON.stringify(name)})).querySelector('input').click()`);
      await evaluate(`(${trigger}).click()`);
      await until(`!Array.from(document.querySelectorAll('label')).find(label=>label.textContent.includes(${JSON.stringify(name)}))`);
    };
    const selectFirst = async () => {
      const id = await evaluate(`Number(document.querySelector('#group-fields input[type="checkbox"]').closest('label').textContent.split('#').pop())`);
      await evaluate(`document.querySelector('#group-fields input[type="checkbox"]').click()`);
      return id;
    };
    await command("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await command("Page.navigate", { url: `http://127.0.0.1:${address.port}/qa` });
    await until(`document.querySelector('#group-fields')?.textContent.toLowerCase().includes('select')`);
    await selectGroup("Group A");
    await until(`document.querySelectorAll('#group-fields input[type="checkbox"]').length===20`);
    assert.equal(await evaluate(`document.body.textContent.includes('Foreign rule')`), false);
    const first = await selectFirst();
    await clickText("Next Page");
    await until(`document.querySelectorAll('#group-fields input[type="checkbox"]').length===3`);
    const second = await selectFirst();
    await until(`document.querySelector('#group-footer').textContent.includes('2 rules')`);
    await clickText("Previous Page");
    await until(`document.querySelectorAll('#group-fields input[type="checkbox"]').length===20`);
    assert.equal(await evaluate(`document.querySelector('#group-fields input[type="checkbox"]').checked`), true);
    const bounds = await evaluate(`(() => {const f=document.querySelector('#group-footer').getBoundingClientRect();return {top:f.top,bottom:f.bottom,right:f.right}})()`);
    assert.ok(bounds.top>=0 && bounds.bottom<=844 && bounds.right<=390, JSON.stringify(bounds));
    await clickText("Apply to 2 rules");
    await until(`document.querySelector('#group-footer').textContent.includes('0 rules')`);
    assert.deepEqual((await caller.personalGroupItems({ personalGroupId: groupA.id, pageSize: 20 })).items.map((rule: any) => rule.id).sort((a: number, b: number) => a-b), [first, second].sort((a,b)=>a-b));
    await command("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await evaluate(`document.querySelector('button[role="combobox"]').click()`);
    await clickText("Remove from groups");
    await until(`document.querySelectorAll('#group-fields input[type="checkbox"]').length===2`);
    await selectFirst();
    await selectGroup("Group A");
    await selectGroup("Group B");
    await until(`document.querySelectorAll('#group-fields input[type="checkbox"]').length===0 && document.querySelector('#group-footer').textContent.includes('0 rules')`);
    assert.equal((await caller.personalGroupItems({ personalGroupId: groupB.id })).totalItems, 0);
  } finally {
    socket?.close(); browser.kill();
    await new Promise<void>(resolve => { if (browser.exitCode !== null) resolve(); else { browser.once("exit", () => resolve()); setTimeout(resolve, 3000).unref(); } });
  }
});
