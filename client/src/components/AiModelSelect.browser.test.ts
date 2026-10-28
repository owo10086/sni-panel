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

// Exercise the rendered controls in an isolated browser. No panel account,
// production settings, external model provider or WebGL renderer is needed.
const chrome = process.env.CHROME_BIN || (process.platform === "darwin"
  ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "/usr/bin/chromium");
const harness = `
import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import AiModelSelect from './client/src/components/AiModelSelect';
import { Sidebar, SidebarProvider, useSidebar } from './client/src/components/ui/sidebar';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from './client/src/components/ui/dialog';
import { trackGlobeTooltip } from './client/src/lib/globeTooltipPosition';
import { globeTooltip } from './client/src/components/GlobeWorkspace';
import { initializeLanguage, setLanguagePreference } from './client/src/i18n';
setLanguagePreference('en'); await initializeLanguage();
function Controls() {
  const [value, setValue] = useState('saved/custom');
  const [models, setModels] = useState([{id:'alpha/chat'},{id:'beta/chat'}]);
  const [refreshes, setRefreshes] = useState(0);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);
  const sidebar = useSidebar();
  const stage = useRef(null);
  useEffect(() => trackGlobeTooltip(stage.current), []);
  return <main style={{padding:20,width:'100%',minHeight:800}}>
    <output id="drawer-state">{sidebar.openMobile ? 'open' : 'closed'}</output>
    <section style={{maxWidth:420}}><AiModelSelect value={value} onValueChange={setValue} models={models} configured loading={false} error={error}
      onRefresh={() => {setModels([{id:'alpha/chat'},{id:'gamma/chat'}]);setRefreshes(n=>n+1)}} />
      <output id="selected-model">{value}</output><output id="refreshes">{refreshes}</output>
      <button id="list-error" onClick={()=>{setModels([]);setError('Controlled provider failure')}}>Fail list</button>
    </section>
    <button id="open-dialog" onClick={()=>setOpen(true)}>Open long form</button>
    <article id="swipe-surface" style={{height:140}}>Page content</article>
    <Dialog open={open} onOpenChange={setOpen}><DialogContent className="max-h-[92svh] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden">
      <DialogHeader><DialogTitle>Long settings</DialogTitle><DialogDescription>Scrollable form</DialogDescription></DialogHeader>
      <div id="form-scroll" className="min-h-0 overflow-y-auto overscroll-contain">{Array.from({length:50},(_,i)=><label key={i} className="block p-3">Field {i}<input aria-label={'Field '+i}/></label>)}</div>
      <DialogFooter><button id="save-form" onClick={()=>setOpen(false)}>Save form</button></DialogFooter>
    </DialogContent></Dialog>
    <div ref={stage} id="globe-stage" className="globe-stage" style={{position:'relative',height:360,width:'100%',maxWidth:700,marginTop:20}}>
      <div className="float-tooltip-kap" style={{position:'absolute'}} dangerouslySetInnerHTML={{__html:globeTooltip({title:'<unsafe title>',color:'#123456',rows:Array.from({length:7},(_,i)=>({label:'Detail '+i,value:'A long value that wraps near edges'}))})}} />
    </div>
  </main>;
}
createRoot(document.getElementById('root')).render(<SidebarProvider><Sidebar><a href="#node">Navigation</a></Sidebar><Controls /></SidebarProvider>);
`;

test("browser: model search/custom/refresh, safe dialogs, sidebar touch and globe edges", { skip: !fs.existsSync(chrome), timeout: 60_000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-controls-browser-"));
  const bundle = await build({ stdin: { contents: harness, loader: "tsx", resolveDir: process.cwd() }, bundle: true, write: false,
    format: "esm", platform: "browser", target: "es2022", jsx: "automatic", logLevel: "silent" });
  const server = await createServer({ configFile: false, root: process.cwd(), plugins: [tailwindcss()], appType: "custom",
    resolve: { alias: { "@": path.join(process.cwd(), "client/src"), "@shared": path.join(process.cwd(), "shared") } },
    server: { host: "127.0.0.1", port: 0, preTransformRequests: false }, optimizeDeps: { noDiscovery: true },
  });
  server.middlewares.use((req, res, next) => {
    if (req.url === "/app.js") { res.setHeader("Content-Type", "application/javascript"); res.end(bundle.outputFiles[0].text); }
    else if (req.url === "/qa") { res.setHeader("Content-Type", "text/html"); res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/client/src/index.css"><div id="root"></div><script type="module" src="/app.js"></script>'); }
    else next();
  });
  await server.listen();
  const address = server.httpServer!.address() as { port: number };
  const browser = spawn(chrome, ["--headless=new", "--no-sandbox", "--disable-gpu", "--remote-debugging-port=0", `--user-data-dir=${directory}`, "about:blank"], { stdio: "ignore" });
  let socket: WebSocket | undefined;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  let nextId = 0;
  try {
    const portFile = path.join(directory, "DevToolsActivePort");
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
      assert.fail(`browser condition timed out: ${expression}`);
    };
    const click = (selector: string) => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
    const input = async (text: string) => {
      await evaluate(`document.querySelector('input[role="combobox"]').focus()`);
      await command("Input.insertText", { text });
    };
    const enter = async () => { await command("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter" }); await command("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter" }); };
    await command("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await command("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
    await command("Page.navigate", { url: `http://127.0.0.1:${address.port}/qa` });
    await until(`document.querySelector('#selected-model')?.textContent === 'saved/custom'`);
    await click('button[role="combobox"]'); await input("alpha");
    await until(`document.querySelectorAll('[role="option"]').length === 2`);
    await command("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowDown", code: "ArrowDown" }); await enter();
    await until(`document.querySelector('#selected-model').textContent === 'alpha/chat'`);
    await click('button[role="combobox"]'); await input("future/model"); await enter();
    await until(`document.querySelector('#selected-model').textContent === 'future/model'`);
    await click('button[role="combobox"]'); await input("draft/model");
    // Find refresh by its visible accessible label; it never commits the draft.
    await evaluate(`Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === 'Refresh').click()`);
    await until(`document.querySelector('#refreshes').textContent === '1'`);
    assert.equal(await evaluate(`document.querySelector('input[role="combobox"]').value`), "draft/model");
    assert.equal(await evaluate(`document.querySelector('#selected-model').textContent`), "future/model");
    await enter(); await until(`document.querySelector('#selected-model').textContent === 'draft/model'`);
    await click("#list-error"); await click('button[role="combobox"]');
    await until(`document.querySelector('[role="alert"]')?.textContent === 'Controlled provider failure'`);
    await input("offline/custom"); await enter();
    await until(`document.querySelector('#selected-model').textContent === 'offline/custom'`);
    await evaluate(`document.documentElement.style.setProperty('--forwardx-safe-area-top','42px');document.documentElement.style.setProperty('--forwardx-safe-area-bottom','34px')`);
    await click("#open-dialog"); await until(`!!document.querySelector('[role="dialog"]')`);
    await until(`(() => {const r=document.querySelector('[role="dialog"]').getBoundingClientRect();return r.top>=42 && r.bottom<=810})()`);
    const dialogBounds = await evaluate(`(() => { const d=document.querySelector('[role="dialog"]').getBoundingClientRect(), f=document.querySelector('#save-form').getBoundingClientRect(), s=document.querySelector('#form-scroll'); return {top:d.top,bottom:d.bottom,footerBottom:f.bottom,scrolls:s.scrollHeight>s.clientHeight}; })()`);
    assert.ok(dialogBounds.top >= 42 && dialogBounds.bottom <= 810 && dialogBounds.footerBottom <= 810 && dialogBounds.scrolls, JSON.stringify(dialogBounds));
    await click("#save-form"); await until(`!document.querySelector('[role="dialog"]')`);
    await until(`!document.body.dataset.dialogScrollLock`);
    await evaluate(`document.documentElement.style.removeProperty('--forwardx-safe-area-top');document.documentElement.style.removeProperty('--forwardx-safe-area-bottom')`);
    const swipe = async (fromX: number, fromY: number, toX: number, toY: number) => {
      await command("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: fromX, y: fromY }] });
      await command("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: toX, y: toY }] });
      await command("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    };
    const swipeY = await evaluate(`document.querySelector('#swipe-surface').getBoundingClientRect().top + 60`);
    await swipe(25, swipeY, 140, swipeY + 2); await until(`document.querySelector('#drawer-state').textContent === 'open'`);
    await swipe(180, 200, 70, 202); await until(`document.querySelector('#drawer-state').textContent === 'closed'`);
    await swipe(15, 200, 18, 300);
    assert.equal(await evaluate(`document.querySelector('#drawer-state').textContent`), "closed");
    await command("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await evaluate(`document.querySelector('#globe-stage').scrollIntoView({block:'center'})`);
    for (const theme of ["light", "dark"]) for (const edge of ["top-left", "bottom-right"]) {
      await evaluate(`document.documentElement.classList.toggle('dark',${theme === "dark"})`);
      await evaluate(`(() => {const s=document.querySelector('#globe-stage'),r=s.getBoundingClientRect();s.dispatchEvent(new MouseEvent('mousemove',{clientX:${edge === "top-left" ? "r.left+2" : "r.right-2"},clientY:${edge === "top-left" ? "r.top+2" : "r.bottom-2"},bubbles:true}));})()`);
      await delay(40);
      const box = await evaluate(`(() => {const s=document.querySelector('#globe-stage').getBoundingClientRect(), t=document.querySelector('.float-tooltip-kap').getBoundingClientRect();return {inside:t.left>=s.left && t.right<=s.right && t.top>=s.top && t.bottom<=s.bottom, text:document.querySelector('.globe-tooltip').textContent, scripts:document.querySelector('.globe-tooltip').children.length};})()`);
      assert.equal(box.inside, true, `${theme} ${edge}: tooltip remains inside the visible stage`);
      assert.ok(box.text.includes("<unsafe title>"), "untrusted labels are displayed as text");
    }
  } finally {
    socket?.close(); browser.kill();
    await new Promise<void>(resolve => { if (browser.exitCode !== null) resolve(); else { browser.once("exit", () => resolve()); setTimeout(resolve, 3000).unref(); } });
    await server.close(); fs.rmSync(directory, { recursive: true, force: true });
  }
});
