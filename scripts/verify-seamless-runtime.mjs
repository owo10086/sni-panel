// Isolated two-panel/two-Agent verification. Never points at a production panel.
// node --import tsx scripts/verify-seamless-runtime.mjs OUTPUT AGENT FXP GOST [IMAGE]
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import net from "node:net";
import tls from "node:tls";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function command(binary, args) {
  const result = spawnSync(binary, args, { encoding: "utf8", timeout: 30000 });
  assert.equal(result.status, 0, result.stderr || result.stdout || String(result.error));
  return result.stdout.trim();
}
async function waitFor(check, description, limit = 45000) {
  const until = Date.now() + limit;
  let last;
  while (Date.now() < until) {
    try { const result = await check(); if (result) return result; } catch (error) { last = error; }
    await pause(100);
  }
  throw new Error(`Timed out: ${description}; ${last?.message || "condition not met"}`);
}
function connection(host, port, servername) {
  return new Promise((resolve, reject) => {
    const socket = servername ? tls.connect({ host, port, servername, rejectUnauthorized: false }) : net.connect(port, host);
    socket.setTimeout(3000, () => socket.destroy(new Error("Connection timed out")));
    socket.once("error", reject);
    socket.once(servername ? "secureConnect" : "connect", () => { socket.setTimeout(0); socket.on("error", () => {}); resolve(socket); });
  });
}
async function echo(socket, value) {
  assert.equal(socket.destroyed, false, "the established business connection must survive");
  const expected = Buffer.from(value);
  await new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    const cleanup = () => { clearTimeout(timer); socket.off("data", data); socket.off("error", fail); socket.off("close", closed); };
    const fail = error => { cleanup(); reject(error); };
    const closed = () => fail(new Error("Business connection closed"));
    const data = chunk => { chunks.push(chunk); size += chunk.length; if (size >= expected.length) { cleanup(); try { assert.deepEqual(Buffer.concat(chunks), expected); resolve(); } catch (error) { reject(error); } } };
    const timer = setTimeout(() => fail(new Error("Business echo timed out")), 5000);
    socket.on("data", data); socket.once("error", fail); socket.once("close", closed); socket.write(expected);
  });
}

async function linuxBackends() {
  assert.ok(fs.existsSync("/.dockerenv"));
  const directory = fs.mkdtempSync("/tmp/seamless-backends-");
  command("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", `${directory}/key.pem`, "-out", `${directory}/cert.pem`, "-subj", "/CN=seamless-fixture", "-days", "1"]);
  const credentials = { key: fs.readFileSync(`${directory}/key.pem`), cert: fs.readFileSync(`${directory}/cert.pem`) };
  for (const port of [30443, 30843, 31443, 31843, 30001]) {
    const echo = socket => { socket.on("error", () => {}); socket.on("data", data => socket.write(data)); };
    const server = port === 30001 ? net.createServer(echo) : tls.createServer(credentials, echo);
    await new Promise(resolve => server.listen(port, "0.0.0.0", resolve));
  }
  console.log("Synthetic TLS and TCP targets ready");
}

async function linuxClient(base, exitIp) {
  assert.ok(fs.existsSync("/.dockerenv"));
  const api = async action => {
    const response = await fetch(`${base}/${action}`, { method: "POST", signal: AbortSignal.timeout(160000) });
    const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result)); return result;
  };
  const request = async (name, payload = "probe") => {
    const socket = await connection("127.0.0.1", 18443, name);
    try { await echo(socket, payload); } finally { socket.destroy(); }
  };
  await waitFor(async () => { await request("healthy.example.test"); return true; }, "managed SNI entry and exit");
  await waitFor(async () => { const socket = await connection(exitIp, 21001); socket.destroy(); return true; }, "managed ordinary GOST");
  const healthy = await connection("127.0.0.1", 18443, "healthy.example.test");
  const plain = await connection(exitIp, 21001);
  const check = async stage => {
    await echo(healthy, `persistent-tls-${stage}`); await echo(plain, `persistent-tcp-${stage}`);
    await assert.rejects(request("exhausted.example.test")); await assert.rejects(request("expired.example.test"));
  };
  try {
    await check("before"); await request("metered.example.test", Buffer.alloc(128 * 1024, 97));
    await api("before"); await api("transfer");
    await check("verifying"); await request("metered.example.test", Buffer.alloc(64 * 1024, 98));
    await api("during"); await api("restart-and-resume");
    await check("active"); await request("metered.example.test", Buffer.alloc(64 * 1024, 99));
    await api("after");
    console.log("PASS: managed TLS and ordinary TCP connections survived transfer, uncertain result and both panel restarts; existing exhausted/expired SNI stayed blocked");
  } finally { healthy.destroy(); plain.destroy(); }
}

async function verifyPanels() {
  const [outputArg, agent, fxp, gost, image = "forwardx-sni-test:20261006"] = process.argv.slice(2);
  assert.ok(outputArg && agent && fxp && gost, "provide output and the three actual runtime binaries");
  const output = path.resolve(outputArg); fs.mkdirSync(output, { recursive: true });
  const host = Object.values(os.networkInterfaces()).flat().find(nic => nic && !nic.internal && nic.family === "IPv4")?.address;
  assert.ok(host, "a real local IPv4 interface is required; production SSRF checks stay enabled");
  const { encryptPayload, decryptPayload } = await import("../server/agentCrypto.ts");
  const { gmPaySign } = await import("../server/gmPay.ts");
  const network = `forwardx-migration-${process.pid}`;
  const names = [`${network}-entry`, `${network}-exit`];
  const children = new Set(); const checks = {};
  let source, target, server, sourceUrl, targetUrl, initial, sourceFrozen, replay;
  const token = "fixture-private-takeover-token";
  const hash = filename => createHash("sha256").update(fs.readFileSync(filename)).digest("hex");
  fs.writeFileSync(path.join(output, "artifacts.json"), JSON.stringify({ agent: hash(agent), fxp: hash(fxp), gost: hash(gost) }, null, 2));
  for (const [binary, name] of [[agent, "forwardx-agent"], [fxp, "forwardx-fxp"], [gost, "gost"]]) { fs.copyFileSync(binary, path.join(output, name)); fs.chmodSync(path.join(output, name), 0o755); }
  const exec = (container, args) => command("docker", ["exec", container, ...args]);
  const runtimeSnapshot = () => Object.fromEntries(names.map(name => [name.endsWith("entry") ? "entry" : "exit", JSON.parse(exec(name, ["node", "-e", String.raw`
    const fs=require('fs'),crypto=require('crypto');const processes=[];
    for(const pid of fs.readdirSync('/proc').filter(x=>/^\d+$/.test(x))){try{const name=fs.readFileSync('/proc/'+pid+'/comm','utf8').trim();if(!['forwardx-fxp','forwardx-runtim','forwardx-tunne','gost','forwardx-agent'].some(x=>name.startsWith(x)))continue;const stat=fs.readFileSync('/proc/'+pid+'/stat','utf8');processes.push({pid:Number(pid),name,start:stat.slice(stat.lastIndexOf(')')+2).split(' ')[19]})}catch{}}
    const configs={};for(const dir of ['/run/forwardx-agent','/etc/forwardx','/etc/forwardx/runtime']){if(!fs.existsSync(dir))continue;for(const name of fs.readdirSync(dir)){if(!name.endsWith('.json'))continue;const p=dir+'/'+name;configs[p]=crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')}}
    console.log(JSON.stringify({processes:processes.sort((a,b)=>a.pid-b.pid),configs}));`]))]));
  const runtimeListeners = () => Object.fromEntries(names.map(name => [name.endsWith("entry") ? "entry" : "exit", exec(name, ["ss", "-lntup"])]));
  const stop = async panel => { if (!panel || panel.child.exitCode !== null || panel.child.signalCode !== null) return; const done = once(panel.child, "exit"); panel.child.kill(); await done; children.delete(panel.child); };
  async function panel(role, port = 0) {
    const directory = path.join(output, role); fs.mkdirSync(directory, { recursive: true });
    const child = spawn(process.execPath, ["--import", "tsx", "server/seamlessMigration.fixture.ts"], {
      stdio: ["ignore", "pipe", "pipe", "ipc"], env: { ...process.env, SQLITE_PATH: path.join(directory, "panel.db"), DATABASE_TYPE: "sqlite",
        DATABASE_CONFIG_PATH: path.join(directory, "database.json"), FORWARDX_SEAMLESS_MIGRATION_STATE_PATH: path.join(directory, "migration.json"),
        FORWARDX_LOG_DIR: path.join(directory, "logs"), FORWARDX_TEST_HOST: host, FORWARDX_TEST_PORT: String(port), FORWARDX_DEV_PANEL: "true", JWT_SECRET: "migration-fixture-secret" },
    });
    children.add(child); let logs = "", seq = 0;
    child.stdout.on("data", data => { logs += data; fs.appendFileSync(path.join(directory, "panel.log"), data); });
    child.stderr.on("data", data => { logs += data; fs.appendFileSync(path.join(directory, "panel.log"), data); });
    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Panel start failed: ${logs}`)), 20000);
      child.once("exit", code => { clearTimeout(timer); reject(new Error(`Panel exited ${code}: ${logs}`)); });
      child.on("message", message => { if (message.ready) { clearTimeout(timer); resolve(message.ready); } });
    });
    const call = (op, values = {}) => new Promise((resolve, reject) => {
      const id = ++seq; const timer = setTimeout(() => { child.off("message", listener); reject(new Error(`Panel ${op} timed out: ${logs}`)); }, 145000);
      const listener = message => { if (message.id !== id) return; clearTimeout(timer); child.off("message", listener); message.error ? reject(new Error(message.error)) : resolve(message.result); };
      child.on("message", listener); child.send({ id, op, ...values });
    });
    return { child, url, call };
  }
  const sql = async (panel, query) => panel.call("query", { sql: query });
  const accounting = async panel => ({
    rules: await sql(panel, "SELECT id,quotaUsedIn,quotaUsedOut,ruleLimitReason FROM forward_rules ORDER BY id"),
    users: await sql(panel, "SELECT id,trafficUsed,balanceCents FROM users ORDER BY id"),
    reports: await sql(panel, "SELECT hostId,producerId,reportId FROM agent_traffic_reports ORDER BY hostId,id"),
    payments: await sql(panel, "SELECT outTradeNo,status FROM payment_orders"),
    balance: await sql(panel, "SELECT paymentOrderNo,amountCents FROM balance_transactions"),
  });
  const postTraffic = async (url, identityToken, payload) => {
    const response = await fetch(`${url}/api/agent/traffic`, { method: "POST", headers: { authorization: `Bearer ${identityToken}`, "content-type": "application/json", "x-agent-encrypted": "1" }, body: JSON.stringify(encryptPayload(payload, identityToken)) });
    assert.equal(response.status, 200); return decryptPayload(await response.json(), identityToken);
  };
  const payment = async () => {
    const body = { pid: "1000", order_id: "MIGRATION-PAYMENT", trade_id: "MIGRATION-TRADE", amount: 2, token: "USDT", status: 2 };
    body.signature = gmPaySign(body, "migration-test-payment-secret");
    const response = await fetch(`${sourceUrl}/api/payment/webhook/gmpay`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal(response.status, 200, await response.text());
  };
  try {
    command("docker", ["network", "create", network]);
    for (const name of names) command("docker", ["run", "-d", "--init", "--cap-add", "NET_ADMIN", "--network", network, "--name", name, "-v", `${output}:/verification`, "-v", `${path.resolve("scripts/verify-seamless-runtime.mjs")}:/verify.mjs:ro`, "--entrypoint", "tail", image, "-f", "/dev/null"]);
    const ips = names.map(name => command("docker", ["inspect", name, "--format", `{{(index .NetworkSettings.Networks "${network}").IPAddress}}`]));
    const subnet = command("docker", ["network", "inspect", network, "--format", "{{(index .IPAM.Config 0).Subnet}}"]);
    source = await panel("source"); target = await panel("target"); sourceUrl = source.url; targetUrl = target.url;
    await source.call("seed-runtime", { entryIp: ips[0], exitIp: ips[1] });
    for (const [index, name] of names.entries()) {
      // Both containers share the host's Internet egress. Keep their distinct
      // synthetic addresses: allow only this panel, peers, and loopback.
      for (const address of [host, subnet, "127.0.0.0/8"]) exec(name, ["iptables", "-A", "OUTPUT", "-d", address, "-j", "ACCEPT"]);
      exec(name, ["iptables", "-A", "OUTPUT", "-j", "REJECT"]);
      exec(name, ["ip6tables", "-A", "OUTPUT", "-d", "::1", "-j", "ACCEPT"]);
      exec(name, ["ip6tables", "-A", "OUTPUT", "-j", "REJECT"]);
      exec(name, ["sh", "-c", "cp /verification/forwardx-fxp /usr/local/bin/forwardx-fxp; cp /verification/gost /usr/local/bin/gost; cp /verification/gost /usr/local/bin/forwardx-runtime; mkdir -p /verification/" + (index ? "exit" : "entry")]);
      const cfg = { panelUrl: sourceUrl, token: index ? "migration-test-exit-token" : "migration-test-agent-token", interval: 1 };
      fs.writeFileSync(path.join(output, `${index ? "exit" : "entry"}-agent.json`), JSON.stringify(cfg), { mode: 0o600 });
    }
    command("docker", ["exec", "-d", names[1], "sh", "-c", "node /verify.mjs --backends > /verification/backends.log 2>&1"]);
    for (const [index, name] of names.entries()) command("docker", ["exec", "-d", name, "sh", "-c", `/verification/forwardx-agent -config /verification/${index ? "exit" : "entry"}-agent.json > /verification/${index ? "exit" : "entry"}-agent.log 2>&1`]);
    const handlers = {
      before: async () => {
        await waitFor(async () => (await accounting(source)).rules.some(row => row.id === 101 && row.quotaUsedIn > 1000), "actual exit accounting");
        replay = (await source.call("observations")).findLast(row => row.path === "/api/agent/traffic" && row.token === "migration-test-exit-token" && row.payload.stats?.some(stat => stat.ruleId === 101 && stat.bytesIn > 0));
        assert.ok(replay, "actual FXP/Agent exit report captured"); initial = runtimeSnapshot(); checks.beforeRuntime = initial; checks.beforeListeners = runtimeListeners(); checks.before = await accounting(source);
        for (const runtime of Object.values(initial)) assert.ok(runtime.processes.some(row => row.name.startsWith("forwardx-agent")));
        assert.ok(initial.exit.processes.some(row => row.name.startsWith("forwardx-fxp")), "exit splitter is actually managed by Agent");
        assert.ok(Object.keys(initial.exit.configs).some(filename => filename.startsWith("/etc/forwardx/runtime/")), "actual GOST runtime configuration is recorded");
        return checks.before;
      },
      transfer: async () => {
        const snapshot = await source.call("freeze", { token, targetUrl }); sourceFrozen = await accounting(source);
        await target.call("import", { snapshot, sourceUrl }); await source.call("drop-activation-response");
        await assert.rejects(target.call("resume"), /fetch failed/);
        assert.equal((await source.call("status")).phase, "forwarding"); assert.equal((await target.call("status")).phase, "verifying");
        const before = await accounting(target);
        assert.equal((await postTraffic(sourceUrl, replay.token, replay.payload)).duplicate, true);
        assert.deepEqual((await accounting(target)).rules, before.rules, "the pending pre-freeze report stays deduplicated immediately after takeover");
        checks.preMigrationReplayDuplicate = true;
        checks.uncertainActivationRetained = true; return { phase: "verifying" };
      },
      during: async () => {
        await waitFor(async () => (await target.call("observations")).some(row => row.path === "/api/agent/traffic" && row.token === "migration-test-exit-token" && row.payload.stats?.some(stat => stat.ruleId === 101 && stat.bytesIn > 0)), "new panel receives actual traffic while verifying");
        checks.verifyingRuntime = runtimeSnapshot(); checks.verifyingListeners = runtimeListeners(); assert.deepEqual(checks.verifyingRuntime, initial, "managed processes and config files remain identical during verification");
        const current = (await target.call("observations")).findLast(row => row.path === "/api/agent/traffic" && row.token === "migration-test-exit-token" && row.payload.stats?.some(stat => stat.ruleId === 101 && stat.bytesIn > 0));
        const before = await accounting(target);
        assert.equal((await postTraffic(sourceUrl, current.token, current.payload)).duplicate, true);
        const after = await accounting(target); assert.deepEqual(after.rules, before.rules, "retrying the current exit report does not bill twice");
        await postTraffic(sourceUrl, "migration-test-agent-token", { reportId: "migration-entry-not-billed", reportProducerId: "migration-entry-fixture", stats: [{ ruleId: 101, bytesIn: 999999, bytesOut: 999999, connections: 1 }] });
        assert.deepEqual((await accounting(target)).rules, before.rules, "entry report cannot double bill logical SNI quota");
        await payment(); await payment();
        checks.verifyingAccounting = await accounting(target); assert.equal(checks.verifyingAccounting.users[0].balanceCents, 100200); assert.equal(checks.verifyingAccounting.balance.length, 1);
        assert.deepEqual(await accounting(source), sourceFrozen, "only the target writes accounting after transfer");
        return { actualExitReportDeduplicated: true, entryIgnored: true, signedPaymentAppliedOnce: true };
      },
      "restart-and-resume": async () => {
        await stop(target); await stop(source);
        source = await panel("source", Number(new URL(sourceUrl).port)); target = await panel("target", Number(new URL(targetUrl).port));
        assert.equal((await source.call("status")).phase, "forwarding"); assert.equal((await target.call("status")).phase, "verifying");
        await assert.rejects(source.call("write", { sql: "UPDATE forward_rules SET isEnabled=0" }), /保留数据/);
        const replies = await Promise.allSettled([target.call("resume"), target.call("resume")]);
        assert.equal(replies.filter(reply => reply.status === "fulfilled" && reply.value.status === "success").length, 1);
        assert.equal(replies.filter(reply => reply.status === "rejected").length, 1);
        assert.equal((await source.call("status")).phase, "archived"); assert.equal((await target.call("status")).phase, "active");
        await payment(); assert.equal((await accounting(target)).balance.length, 1);
        checks.restartAndResume = true; return { phase: "active" };
      },
      after: async () => {
        await waitFor(async () => (await accounting(target)).rules.find(row => row.id === 101).quotaUsedIn > checks.verifyingAccounting.rules.find(row => row.id === 101).quotaUsedIn, "continued actual traffic after takeover");
        checks.activeRuntime = runtimeSnapshot(); checks.activeListeners = runtimeListeners();
        for (const role of ["entry", "exit"]) assert.deepEqual(checks.activeRuntime[role].processes, initial[role].processes, "Agent and managed forwarding process identity remains unchanged after takeover");
        checks.after = await accounting(target); assert.deepEqual(await accounting(source), sourceFrozen);
        assert.equal(checks.after.rules.find(row => row.id === 103).ruleLimitReason, "traffic_limit"); assert.equal(checks.after.rules.find(row => row.id === 104).ruleLimitReason, "expired");
        assert.equal(await target.call("advertised"), sourceUrl); checks.managedLongConnections = true;
        fs.writeFileSync(path.join(output, "result.json"), JSON.stringify(checks, null, 2)); return { success: true };
      },
    };
    server = http.createServer(async (req, res) => {
      try { const handler = handlers[req.url.slice(1)]; assert.ok(handler, "unknown verification stage"); const result = await handler(); res.setHeader("content-type", "application/json"); res.end(JSON.stringify(result)); }
      catch (error) { res.writeHead(500, { "content-type": "application/json" }); res.end(JSON.stringify({ error: error.message })); }
    });
    await new Promise(resolve => server.listen(0, "0.0.0.0", resolve));
    const client = spawn("docker", ["exec", names[0], "node", "/verify.mjs", "--client", `http://${host}:${server.address().port}`, ips[1]], { stdio: "inherit" });
    assert.equal((await once(client, "exit"))[0], 0, "actual managed connection verification failed");
    assert.equal(checks.managedLongConnections, true);
  } finally {
    fs.writeFileSync(path.join(output, "progress.json"), JSON.stringify(checks, null, 2));
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await Promise.all([...children].map(child => stop({ child })));
    for (const name of names) spawnSync("docker", ["rm", "-f", name], { encoding: "utf8" });
    spawnSync("docker", ["network", "rm", network], { encoding: "utf8" });
  }
}

if (process.argv[2] === "--backends") await linuxBackends();
else if (process.argv[2] === "--client") await linuxClient(process.argv[3], process.argv[4]);
else await verifyPanels();
