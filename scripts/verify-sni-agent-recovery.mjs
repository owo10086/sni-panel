// Run only in an isolated Linux container. Input contains real heartbeat output,
// scrubbed retired snapshots, and freshly built Agent/FXP executables.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import tls from "node:tls";

assert.equal(process.platform, "linux");
assert.ok(fs.existsSync("/.dockerenv"), "use an isolated Docker container");
const input = process.argv[2];
const agentBinary = process.argv[3] || path.join(input, "forwardx-agent");
const releasedBinary = path.join(input, "released-agent");
const desired = JSON.parse(fs.readFileSync(path.join(input, "desired.json"), "utf8"));
const valid = desired.actions.find(action => action.fxp?.role === "sni-splitter" && action.sourcePort === 24000).fxp;
const retired = JSON.parse(fs.readFileSync(path.join(input, "retired-snapshots.json"), "utf8"));
assert.ok(retired.length > 0);
assert.ok(retired.every(snapshot => snapshot.spec.listenPort === 56392));
const work = "/tmp/sni-agent-recovery";
const evidenceDir = path.join(input, "recovery-evidence");
fs.mkdirSync(evidenceDir, { recursive: true });
const persistentDir = "/var/lib/forwardx-agent/fxp";
fs.mkdirSync(work, { recursive: true });
fs.mkdirSync(persistentDir, { recursive: true });
fs.mkdirSync("/run/forwardx-agent", { recursive: true });
fs.copyFileSync(path.join(input, "forwardx-fxp"), "/usr/local/bin/forwardx-fxp");
fs.chmodSync("/usr/local/bin/forwardx-fxp", 0o755);
const execute = (binary, args) => {
  const result = spawnSync(binary, args, { encoding: "utf8", timeout: 15000 });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  return result.stdout;
};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const offlinePanel = http.createServer((_req, res) => { res.writeHead(503); res.end("offline verification"); });
await new Promise(resolve => offlinePanel.listen(0, "127.0.0.1", resolve));
const configPath = path.join(work, "agent.json");
const panelUrl = process.env.FORWARDX_RECOVERY_PANEL_URL || `http://127.0.0.1:${offlinePanel.address().port}`;
fs.writeFileSync(configPath, JSON.stringify({ panelUrl, token: "isolated-recovery-token", interval: 1 }));
for (const snapshot of retired) {
  const spec = snapshot.spec;
  fs.writeFileSync(path.join(persistentDir, `fxp-v1-sni-splitter-0-${spec.ruleId}-${spec.listenPort}.json`), JSON.stringify(snapshot));
}
// A runtime JSON left by an earlier process is not evidence of a live listener.
fs.writeFileSync("/run/forwardx-agent/fxp-sni-splitter-0-56392.json", JSON.stringify(retired.at(-1).spec));
fs.writeFileSync(path.join(persistentDir, `fxp-v1-sni-splitter-0-${valid.ruleId}-24000.json`), JSON.stringify({ version: 1, spec: valid }));
let agent;
let agentLog;
let fxp;
let connection;
let backend;
const probe = port => new Promise(resolve => {
  const socket = net.connect(port, "127.0.0.1");
  socket.setTimeout(500, () => { socket.destroy(); resolve(false); });
  socket.once("connect", () => { socket.destroy(); resolve(true); });
  socket.once("error", () => resolve(false));
});
async function startAgent(stage, binary = agentBinary) {
  agentLog = path.join(work, `agent-${stage}.log`);
  const log = fs.openSync(agentLog, "w");
  agent = spawn(binary, ["-config", configPath], { stdio: ["ignore", log, log] });
  fs.closeSync(log);
  for (let attempt = 0; attempt < 300; attempt++) {
    assert.equal(agent.exitCode, null, fs.readFileSync(agentLog, "utf8"));
    if (fs.readFileSync(agentLog, "utf8").includes("local runtime restore complete")) return;
    await pause(50);
  }
  throw new Error("Agent restoration did not finish: " + fs.readFileSync(agentLog, "utf8"));
}
async function stopAgent() {
  if (agent?.exitCode === null && agent.signalCode === null) {
    const stopped = new Promise(resolve => agent.once("exit", resolve));
    agent.kill("SIGTERM");
    await stopped;
  }
  if (agentLog && fs.existsSync(agentLog)) {
    fs.writeFileSync(path.join(evidenceDir, path.basename(agentLog)), fs.readFileSync(agentLog, "utf8").replaceAll("isolated-recovery-token", "[test-token]"));
  }
}
function runtimeSnapshot(stage) {
  const snapshots = fs.readdirSync(persistentDir).map(filename => {
    const spec = JSON.parse(fs.readFileSync(path.join(persistentDir, filename))).spec;
    return { filename, role: spec.role, ruleId: spec.ruleId, listenPort: spec.listenPort, routeRuleIds: spec.sniRoutes?.map(route => route.ruleId) };
  });
  fs.writeFileSync(path.join(evidenceDir, stage + ".json"), JSON.stringify({ snapshots, listeners: execute("ss", ["-lntp"]) }, null, 2));
}
function echo(socket, text) {
  return new Promise((resolve, reject) => {
    socket.once("data", data => resolve(data.toString()));
    socket.once("error", reject);
    socket.write(text);
  });
}
try {
  await startAgent("cold");
  runtimeSnapshot("cold");
  assert.equal(await probe(56392), false, "retired SNI snapshots must not reopen port 56392 before panel confirmation");
  assert.equal(await probe(24000), false, "a stopped SNI must wait for the current panel configuration");
  console.log("PASS: cold Agent startup leaves retired and unconfirmed SNI listeners closed");
  await stopAgent();
  execute("ip", ["address", "add", "203.0.113.20/32", "dev", "lo"]);
  execute("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", path.join(work, "key.pem"), "-out", path.join(work, "cert.pem"), "-subj", "/CN=api.example.com", "-days", "1"]);
  backend = tls.createServer({ key: fs.readFileSync(path.join(work, "key.pem")), cert: fs.readFileSync(path.join(work, "cert.pem")) }, socket => {
    socket.on("error", () => {});
    socket.on("data", data => socket.write(data));
  });
  await new Promise(resolve => backend.listen(443, "203.0.113.20", resolve));
  const runtimePath = "/run/forwardx-agent/fxp-sni-splitter-0-24000.json";
  const socketPath = "/run/forwardx-agent/fxp-sni-splitter-0-24000.sock";
  const agentConfig = JSON.parse(fs.readFileSync(configPath));
  fs.writeFileSync(runtimePath, JSON.stringify({ ...valid, panelUrl: agentConfig.panelUrl, token: agentConfig.token, controlSocketPath: socketPath }));
  const log = fs.openSync(path.join(work, "fxp.log"), "w");
  fxp = spawn("/usr/local/bin/forwardx-fxp", ["-config", runtimePath], { stdio: ["ignore", log, log] });
  fs.closeSync(log);
  for (let attempt = 0; !await probe(24000) && attempt < 100; attempt++) await pause(20);
  connection = await new Promise((resolve, reject) => {
    const socket = tls.connect({ host: "127.0.0.1", port: 24000, servername: "api.example.com", rejectUnauthorized: false });
    socket.setTimeout(3000, () => socket.destroy(new Error("TLS timed out")));
    socket.once("error", reject);
    socket.once("secureConnect", () => resolve(socket));
  });
  const originalPid = fxp.pid;
  assert.equal(await echo(connection, "before"), "before");
  const stages = ["cold", "restart"];
  await startAgent("restart");
  assert.equal(await probe(56392), false);
  assert.equal(fxp.exitCode, null, "live FXP process must survive Agent startup");
  assert.equal(await echo(connection, "restart"), "restart", "existing TLS connection must survive Agent restart");
  runtimeSnapshot("restart");
  await stopAgent();
  console.log("PASS: restart retains the live SNI process and TLS connection; retired port stays closed");
  if (fs.existsSync(releasedBinary)) {
    // Keep old snapshots aside while the released Agent starts. Reintroduce
    // the real retired snapshots before replacing it with the candidate.
    const oldSnapshots = new Map();
    for (const filename of fs.readdirSync(persistentDir)) {
      const file = path.join(persistentDir, filename);
      if (JSON.parse(fs.readFileSync(file)).spec.listenPort !== 56392) continue;
      oldSnapshots.set(file, fs.readFileSync(file));
      fs.unlinkSync(file);
    }
    const staleRuntimePath = "/run/forwardx-agent/fxp-sni-splitter-0-56392.json";
    const staleRuntime = fs.readFileSync(staleRuntimePath);
    fs.unlinkSync(staleRuntimePath);
    await startAgent("released-agent", releasedBinary);
    assert.equal(await echo(connection, "released"), "released");
    await stopAgent();
    for (const [file, bytes] of oldSnapshots) fs.writeFileSync(file, bytes);
    fs.writeFileSync(staleRuntimePath, staleRuntime);
    await startAgent("upgrade-restart");
    assert.equal(await probe(56392), false);
    assert.equal(fxp.exitCode, null);
    assert.equal(await echo(connection, "upgraded"), "upgraded");
    runtimeSnapshot("upgrade");
    await stopAgent();
    stages.push("released-agent-to-candidate");
    console.log("PASS: replacing the released Agent with the candidate preserves the live TLS connection and leaves the retired port closed");
  }
  if (process.env.FORWARDX_RECOVERY_PANEL_URL) {
    connection.destroy();
    connection = undefined;
    const stopped = new Promise(resolve => fxp.once("exit", resolve));
    fxp.kill("SIGTERM");
    await stopped;
    await startAgent("panel-confirmation");
    assert.equal(await probe(24000), false);
    const response = await fetch(panelUrl + "/verification/online", { method: "POST" });
    assert.equal(response.status, 200);
    for (let attempt = 0; !await probe(24000) && attempt < 300; attempt++) await pause(50);
    assert.equal(await probe(24000), true, "current heartbeat configuration must start the valid SNI");
    assert.equal(await probe(56392), false);
    const socket = await new Promise((resolve, reject) => {
      const candidate = tls.connect({ host: "127.0.0.1", port: 24000, servername: "api.example.com", rejectUnauthorized: false });
      candidate.once("error", reject);
      candidate.once("secureConnect", () => resolve(candidate));
    });
    assert.equal(await echo(socket, "confirmed"), "confirmed");
    socket.destroy();
    runtimeSnapshot("panel-confirmed");
    stages.push("actual-panel-heartbeat-confirmation");
    console.log("PASS: actual panel heartbeat starts the valid SNI while the retired port stays closed");
  }
  fs.writeFileSync(path.join(input, "recovery-result.json"), JSON.stringify({ retiredSnapshotCount: retired.length, retiredPort: 56392, livePort: 24000, livePid: originalPid, stages, runtime: execute("ss", ["-lntp"]) }, null, 2));
} finally {
  connection?.destroy();
  await stopAgent();
  if (fxp?.exitCode === null && fxp.signalCode === null) {
    const stopped = new Promise(resolve => fxp.once("exit", resolve));
    fxp.kill("SIGTERM");
    await stopped;
  }
  if (backend) await new Promise(resolve => backend.close(resolve));
  await new Promise(resolve => offlinePanel.close(resolve));
}
