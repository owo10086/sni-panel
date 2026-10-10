// 仅在隔离 Linux 容器运行；读取心跳集成测试导出的真实入口配置。
// NET_ADMIN 用于把测试目标地址绑定到容器回环接口，不操作宿主机网络。
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";

assert.equal(process.platform, "linux");
const input = process.argv[2];
assert.ok(input, "provide the heartbeat export directory");
const configs = ["before", "excluded", "restored"].map(name => JSON.parse(fs.readFileSync(path.join(input, name + ".json"), "utf8")));
const [before, excluded, restored] = configs;
const healthy = process.argv[3] || "gost-api.example.com";
const affected = process.argv[4] || "nginx-api.example.com";
assert.ok(before.sniRoutes.some(route => route.sni === affected));
assert.ok(!excluded.sniRoutes.some(route => route.sni === affected));
assert.ok(restored.sniRoutes.some(route => route.sni === affected));
for (const config of configs) {
  assert.equal(config.listenPort, before.listenPort);
  assert.deepEqual(config.sourceAllowIps, []);
  assert.ok(config.sniRoutes.some(route => route.sni === healthy));
}
const work = fs.mkdtempSync(path.join(os.tmpdir(), "sni-traffic-verify-"));
function execute(binary, args) {
  const result = spawnSync(binary, args, { encoding: "utf8", timeout: 15_000 });
  assert.equal(result.status, 0, result.stderr || String(result.error));
}
const targets = new Map(before.sniRoutes.map(route => [route.targetIp + ":" + route.targetPort, route]));
for (const address of new Set([...targets.values()].map(route => route.targetIp))) {
  execute("ip", ["address", "add", address + "/32", "dev", "lo"]);
}
execute("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", path.join(work, "key.pem"), "-out", path.join(work, "cert.pem"), "-subj", "/CN=traffic-test", "-days", "1"]);
const credentials = { key: fs.readFileSync(path.join(work, "key.pem")), cert: fs.readFileSync(path.join(work, "cert.pem")) };
const backends = [];
let fxp;
let persistent;
function connect(servername) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: "127.0.0.1", port: before.listenPort, servername, rejectUnauthorized: false });
    socket.setTimeout(2000, () => socket.destroy(new Error("TLS timed out")));
    socket.once("error", reject);
    socket.once("secureConnect", () => resolve(socket));
  });
}
function echo(socket, payload) {
  return new Promise((resolve, reject) => {
    socket.once("data", data => resolve(data.toString()));
    socket.once("error", reject);
    socket.write(payload);
  });
}
async function request(servername) {
  const socket = await connect(servername);
  try { return await echo(socket, "probe"); } finally { socket.destroy(); }
}
const controlSocket = path.join(work, "control.sock");
function update(config) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(controlSocket);
    let response = "";
    socket.setTimeout(2000, () => socket.destroy(new Error("control update timed out")));
    socket.once("error", reject);
    socket.once("connect", () => socket.write(JSON.stringify({ version: config.sniRouteVersion, sniRoutes: config.sniRoutes }) + "\n"));
    socket.on("data", data => {
      response += data;
      if (!response.includes("\n")) return;
      const result = JSON.parse(response.trim());
      socket.destroy();
      assert.equal(result.ok, true, result.error);
      assert.equal(result.version, config.sniRouteVersion);
      resolve();
    });
  });
}
try {
  for (const route of targets.values()) {
    const backend = tls.createServer(credentials, socket => {
      socket.on("error", () => {});
      socket.on("data", data => socket.write(socket.servername + ":" + data.toString()));
    });
    await new Promise(resolve => backend.listen(route.targetPort, route.targetIp, resolve));
    backends.push(backend);
  }
  fs.writeFileSync(path.join(work, "config.json"), JSON.stringify({ ...before, controlSocketPath: controlSocket }));
  fxp = spawn(path.join(input, "forwardx-fxp"), ["-config", path.join(work, "config.json")], { stdio: "ignore" });
  for (let attempt = 0; !fs.existsSync(controlSocket) && attempt < 100; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(fs.existsSync(controlSocket), "FXP control socket must start");
  persistent = await connect(healthy);
  assert.equal(await echo(persistent, "before"), healthy + ":before");
  assert.equal(await request(affected), affected + ":probe");
  await update(excluded);
  assert.equal(fxp.exitCode, null, "shared listener process remains alive");
  assert.equal(await request(healthy), healthy + ":probe");
  assert.equal(await echo(persistent, "during"), healthy + ":during", "existing healthy TLS connection survives the update");
  await assert.rejects(request(affected));
  await assert.rejects(request("unknown.example.com"));
  await update(restored);
  assert.equal(await request(affected), affected + ":probe");
  assert.equal(await echo(persistent, "after"), healthy + ":after");
  assert.equal(fxp.exitCode, null);
  console.log("PASS: heartbeat configs exclude and restore the affected SNI route; shared listener and existing healthy TLS connection remain available");
} finally {
  persistent?.destroy();
  if (fxp?.exitCode === null) {
    const stopped = new Promise(resolve => fxp.once("exit", resolve));
    fxp.kill("SIGTERM");
    await stopped;
  }
  await Promise.all(backends.map(backend => new Promise(resolve => backend.close(resolve))));
}
