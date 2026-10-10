// Usage: node verify-probe-agent-counters.mjs OUTPUT_DIR AGENT [RELEASED_AGENT]
// Run inside an isolated Linux container; all probe targets are loopback.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";

assert.equal(process.platform, "linux");
assert.ok(fs.existsSync("/.dockerenv"));
const [output, binary, released] = process.argv.slice(2);
fs.mkdirSync(output, { recursive: true });
const token = "isolated-probe-agent-token";
const reports = [];
let agent;
let stage = "healthy";
let backend;
let collect = true;
const key = salt => crypto.createHash("sha256").update(`${token}|${salt}`).digest();
function envelope(payload) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-ctr", key("forwardx-agent-v1"), iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(payload)), cipher.final()]);
  const ts = Date.now(); const bytes = Buffer.alloc(8); bytes.writeBigUInt64BE(BigInt(ts));
  const mac = crypto.createHmac("sha256", key("forwardx-agent-mac"))
    .update(Buffer.concat([Buffer.from("v1"), iv, ct, bytes])).digest("hex");
  return { v: 1, iv: iv.toString("hex"), ct: ct.toString("hex"), ts, mac };
}
const probes = [{ ruleId: 1, tunnelId: 1, targetIp: "127.0.0.1", targetPort: 31001, method: "tcping" },
  { ruleId: 2, tunnelId: 1, targetIp: "127.0.0.1", targetPort: 31001, method: "ping" }];
const panel = http.createServer(async (req, res) => {
  if (req.method === "GET") { res.writeHead(404); res.end(); return; }
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks));
  const decipher = crypto.createDecipheriv("aes-256-ctr", key("forwardx-agent-v1"), Buffer.from(body.iv, "hex"));
  const message = JSON.parse(Buffer.concat([decipher.update(Buffer.from(body.ct, "hex")), decipher.final()]));
  let response = { success: true };
  if (message.path === "/api/agent/heartbeat") response = { nextInterval: 1, forceTcping: collect,
    runningRules: [], ruleLatencyProbes: probes };
  if (message.path === "/api/agent/tcping") {
    reports.push({ stage, payload: message.payload });
    fs.writeFileSync(path.join(output, "reports.json"), JSON.stringify(reports, null, 2));
  }
  res.setHeader("content-type", "application/json"); res.end(JSON.stringify(envelope(response)));
});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check) {
  const until = Date.now() + 45000;
  while (Date.now() < until) {
    if (check()) return;
    assert.ok(agent?.exitCode === null && agent?.signalCode === null, "Agent exited early");
    await pause(100);
  }
  throw new Error(`Timed out at ${stage}`);
}
async function startBackend() {
  backend = net.createServer(conn => conn.end());
  await new Promise(resolve => backend.listen(31001, "127.0.0.1", resolve));
}
async function stopAgent() {
  if (agent?.exitCode === null && agent.signalCode === null) {
    const done = new Promise(resolve => agent.once("exit", resolve)); agent.kill("SIGTERM"); await done;
  }
  agent = undefined;
}
function startAgent(executable) {
  const fd = fs.openSync(path.join(output, `agent-${stage}.log`), "w");
  agent = spawn(executable, ["-config", "/tmp/probe-agent.json"], { stdio: ["ignore", fd, fd] }); fs.closeSync(fd);
}
const current = () => reports.filter(item => item.stage === stage);
try {
  await startBackend(); await new Promise(resolve => panel.listen(0, "127.0.0.1", resolve));
  fs.writeFileSync("/tmp/probe-agent.json", JSON.stringify({ panelUrl: `http://127.0.0.1:${panel.address().port}`, token, interval: 1 }));
  startAgent(binary);
  await waitFor(() => current().length >= 2);
  const healthy = current().at(-1).payload.results;
  assert.ok(healthy.every(row => row.probeTotalCount >= row.probeCount * 2 && row.probeTotalSuccesses === row.probeTotalCount));
  assert.equal(healthy.find(row => row.ruleId === 1).probeCount, 3);
  assert.equal(healthy.find(row => row.ruleId === 2).probeCount, 5);
  const originalEpoch = healthy.find(row => row.ruleId === 1);
  stage = "tcp-failed"; await new Promise(resolve => backend.close(resolve)); backend = undefined;
  await waitFor(() => current().some(item => item.payload.results.some(row => row.ruleId === 1 && row.probeSuccesses === 0)));
  const failed = current().at(-1).payload.results.find(row => row.ruleId === 1);
  assert.equal(failed.probeCounterEpoch, originalEpoch.probeCounterEpoch);
  assert.ok(failed.probeTotalCount > originalEpoch.probeTotalCount);
  assert.ok(failed.probeTotalCount > failed.probeTotalSuccesses);
  stage = "tcp-recovered"; await startBackend();
  await waitFor(() => current().some(item => item.payload.results.some(row => row.ruleId === 1 && row.probeSuccesses === 3)));
  const recovered = current().at(-1).payload.results.find(row => row.ruleId === 1);
  assert.equal(recovered.probeCounterEpoch, originalEpoch.probeCounterEpoch);
  await stopAgent(); stage = "restarted"; startAgent(binary);
  await waitFor(() => current().length > 0);
  const restarted = current()[0].payload.results.find(row => row.ruleId === 1);
  assert.notEqual(restarted.probeCounterEpoch, originalEpoch.probeCounterEpoch);
  assert.ok(restarted.probeCounterStartedAt > originalEpoch.probeCounterStartedAt);
  assert.equal(restarted.probeTotalCount, 3);
  await stopAgent();
  if (released) {
    stage = "released-3.2.0"; startAgent(released); await waitFor(() => current().length > 0);
    assert.ok(current()[0].payload.results.every(row => row.probeCounterEpoch === undefined && row.probeCounterStartedAt === undefined));
    await stopAgent();
  }
  collect = false;
  console.log(JSON.stringify({ tcpBatch: 3, pingBatch: 5, healthyCumulative: true, failureAndRecovery: true,
    restartIdentity: true, releasedLegacy: !!released, reports: reports.length }));
} finally {
  await stopAgent();
  if (backend) await new Promise(resolve => backend.close(resolve));
  panel.closeAllConnections(); await new Promise(resolve => panel.close(resolve));
}
