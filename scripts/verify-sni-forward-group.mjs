// Run in the isolated SNI verification container; input comes from real heartbeats.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";

const input = process.argv[2];
assert.ok(input, "provide the heartbeat export directory");
const entranceId = Number(process.argv[3]);
assert.ok([1, 2].includes(entranceId), "run once per isolated entrance container (1 or 2)");
for (const file of fs.readdirSync(input).filter(file => file.startsWith(`probe-${entranceId}-`))) fs.unlinkSync(path.join(input, file));
const configs = [JSON.parse(fs.readFileSync(path.join(input, `initial-${entranceId}.json`), "utf8"))];
const shared = JSON.parse(fs.readFileSync(path.join(input, `shared-${entranceId}.json`), "utf8"));
const remaining = JSON.parse(fs.readFileSync(path.join(input, `remaining-${entranceId}.json`), "utf8"));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "sni-group-network-"));
const cert = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", path.join(work, "key.pem"), "-out", path.join(work, "cert.pem"), "-subj", "/CN=sni-group-test", "-days", "1"], { encoding: "utf8", timeout: 15000 });
assert.equal(cert.status, 0, cert.stderr);
const credentials = { key: fs.readFileSync(path.join(work, "key.pem")), cert: fs.readFileSync(path.join(work, "cert.pem")) };
const backends = [];
const connections = new Set();
const track = socket => { connections.add(socket); socket.once("close", () => connections.delete(socket)); };
const processes = [];
const helloByDomain = new Map();
const serversByDomain = new Map();
try {
  const targets = new Map([...configs, shared].flatMap(config => config.sniRoutes).map(route => [`${route.targetIp}:${route.targetPort}`, route]));
  for (const route of targets.values()) {
    const tlsServer = tls.createServer(credentials, socket => {
      track(socket);
      socket.on("error", () => {});
      socket.on("data", data => socket.write(`${route.targetPort}/${socket.servername}/${data}`));
    });
    await new Promise(resolve => tlsServer.listen(0, "127.0.0.1", resolve));
    backends.push(tlsServer);
    const server = net.createServer(socket => {
      track(socket);
      socket.once("data", data => helloByDomain.set(route.sni, Buffer.from(data)));
      const upstream = net.connect(tlsServer.address().port, "127.0.0.1");
      track(upstream);
      socket.on("error", () => upstream.destroy());
      upstream.on("error", () => socket.destroy());
      socket.pipe(upstream).pipe(socket);
    });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(route.targetPort, route.targetIp, resolve); });
    backends.push(server);
    serversByDomain.set(route.sni, server);
  }
  for (const [index, config] of configs.entries()) {
    const listenHost = "127.0.0.1";
    const configPath = `/run/forwardx-agent/fxp-sni-splitter-0-${config.listenPort}.json`;
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.mkdirSync("/usr/local/bin", { recursive: true });
    fs.copyFileSync(path.join(input, "forwardx-fxp"), "/usr/local/bin/forwardx-fxp");
    const control = configPath.replace(/\.json$/, ".sock");
    fs.writeFileSync(configPath, JSON.stringify({ ...config, listenHost, controlSocketPath: control }));
    const process = spawn("/usr/local/bin/forwardx-fxp", ["-config", configPath], { stdio: ["ignore", "ignore", "pipe"] });
    let errors = "";
    process.stderr.on("data", chunk => { errors += chunk; });
    processes.push(process);
    for (let attempt = 0; !fs.existsSync(control) && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(fs.existsSync(control), errors);
    const request = servername => new Promise((resolve, reject) => {
      const socket = tls.connect({ host: listenHost, port: config.listenPort, servername, rejectUnauthorized: false });
      socket.setTimeout(2000, () => socket.destroy(new Error("TLS timed out")));
      socket.once("error", reject);
      socket.once("secureConnect", () => socket.write("probe"));
      socket.once("data", data => { socket.destroy(); resolve(data.toString()); });
    });
    for (const route of config.sniRoutes) {
      assert.equal(await request(route.sni), `${route.targetPort}/${route.sni}/probe`);
      assert.equal(helloByDomain.get(route.sni)?.[0], 22, "destination receives the original TLS handshake record");
    }
    await assert.rejects(request("unknown.example.com"));
    await assert.rejects(request(undefined));
    const update = next => new Promise((resolve, reject) => {
      const socket = net.connect(control);
      let response = "";
      socket.once("error", reject);
      socket.once("connect", () => socket.write(JSON.stringify({ version: next.sniRouteVersion, sniRoutes: next.sniRoutes }) + "\n"));
      socket.on("data", data => {
        response += data;
        if (!response.includes("\n")) return;
        const result = JSON.parse(response.trim());
        socket.destroy();
        assert.equal(result.ok, true, result.error);
        fs.writeFileSync(configPath, JSON.stringify({ ...next, listenHost, controlSocketPath: control }));
        resolve();
      });
    });
    const adoptedInitial = path.join(work, "adopted-initial.json");
    fs.writeFileSync(adoptedInitial, JSON.stringify({ ...config, listenHost, controlSocketPath: control }));
    const adopt = spawnSync(path.join(input, "agent-probe.test"), ["-test.run", "^TestSniForwardGroupFailedRevocation$", "-test.timeout", "30s"], {
      env: { ...globalThis.process.env, FORWARDX_SNI_REVOCATION_ADOPT_ONLY: "1", FORWARDX_SNI_REVOCATION_INITIAL: adoptedInitial, FORWARDX_SNI_REVOCATION_ACTION: path.join(input, `removal-action-${entranceId}.json`) }, encoding: "utf8", timeout: 40000,
    });
    assert.equal(adopt.status, 0, adopt.stdout + adopt.stderr);
    await update(shared);
    for (const route of shared.sniRoutes) assert.equal(await request(route.sni), `${route.targetPort}/${route.sni}/probe`);
    // Exercise the saved per-member connection cap with real TLS connections.
    const capped = shared.sniRoutes.find(route => route.sni === "a.example.com");
    const held = [];
    try {
      await new Promise(resolve => setTimeout(resolve, 50));
      for (let slot = 0; slot < capped.maxConnections; slot++) {
        const socket = tls.connect({ host: listenHost, port: config.listenPort, servername: capped.sni, rejectUnauthorized: false });
        socket.on("error", () => {});
        held.push(socket);
        await new Promise((resolve, reject) => { socket.once("secureConnect", resolve); socket.once("error", reject); });
      }
      await assert.rejects(request(capped.sni), "a connection beyond the saved cap is rejected");
      const other = shared.sniRoutes.find(route => route.sni === "b.example.com");
      assert.equal(await request(other.sni), `${other.targetPort}/${other.sni}/probe`, "another domain keeps its own connection allowance");
    } finally {
      held.forEach(socket => socket.destroy());
    }
    if (fs.existsSync(path.join(input, "agent-probe.test"))) {
      const output = path.join(input, `probe-${entranceId}`);
      const probe = spawn(path.join(input, "agent-probe.test"), ["-test.run", "^TestSniForwardGroupDestinationProbes$", "-test.timeout", "90s"], {
        env: { ...process.env, FORWARDX_SNI_PROBE_INPUT: path.join(input, `running-${entranceId}.json`), FORWARDX_SNI_PROBE_OUTPUT: output }, stdio: "inherit",
      });
      processes.push(probe);
      const waitResult = async stage => {
        const file = `${output}-${stage}.json`;
        for (let attempt = 0; !fs.existsSync(file) && attempt < 1500; attempt++) await new Promise(resolve => setTimeout(resolve, 20));
        assert.ok(fs.existsSync(file), `Agent did not report ${stage}`);
        return JSON.parse(fs.readFileSync(file, "utf8"));
      };
      assert.ok((await waitResult("healthy")).every(result => result.healthStatus === "healthy"));
      const affected = shared.sniRoutes.find(route => route.sni === "a.example.com");
      const destination = serversByDomain.get(affected.sni);
      if (entranceId === 1) await new Promise(resolve => destination.close(resolve));
      const unaffected = shared.sniRoutes.find(route => route.sni === "b.example.com");
      assert.equal(await request(unaffected.sni), `${unaffected.targetPort}/${unaffected.sni}/probe`, "entrance remains listening");
      fs.writeFileSync(`${output}-fail.trigger`, "");
      await waitResult("pending");
      const failed = await waitResult("failed");
      assert.equal(failed.find(result => result.ruleId === affected.ruleId).healthStatus, entranceId === 1 ? "unhealthy" : "healthy");
      if (entranceId === 1) await new Promise(resolve => destination.listen(affected.targetPort, affected.targetIp, resolve));
      fs.writeFileSync(`${output}-recover.trigger`, "");
      await waitResult("recover-pending");
      assert.ok((await waitResult("recovered")).every(result => result.healthStatus === "healthy"));
      await new Promise(resolve => probe.exitCode !== null ? resolve() : probe.once("exit", resolve));
      assert.equal(probe.exitCode, 0);
    }
    const unchanged = shared.sniRoutes.find(route => route.sni === "b.example.com");
    const persistent = tls.connect({ host: listenHost, port: config.listenPort, servername: unchanged.sni, rejectUnauthorized: false });
    persistent.on("error", () => {});
    persistent.setTimeout(2000, () => persistent.destroy(new Error("persistent TLS echo timed out")));
    await new Promise((resolve, reject) => { persistent.once("secureConnect", resolve); persistent.once("error", reject); });
    const echo = value => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("persistent TLS echo timed out")), 2000);
      persistent.once("data", data => { clearTimeout(timer); resolve(data.toString()); });
      persistent.once("error", error => { clearTimeout(timer); reject(error); });
      persistent.once("close", () => { clearTimeout(timer); reject(new Error("persistent TLS connection closed")); });
      persistent.write(value);
    });
    assert.equal(await echo("before"), `${unchanged.targetPort}/${unchanged.sni}/before`);
    fs.writeFileSync(path.join(work, "before-successful-revocation.json"), JSON.stringify({ ...shared, listenHost, controlSocketPath: control }));
    const successfulRemoval = spawnSync(path.join(input, "agent-probe.test"), ["-test.run", "^TestSniForwardGroupFailedRevocation$", "-test.timeout", "30s"], {
      env: { ...globalThis.process.env, FORWARDX_SNI_REVOCATION_INITIAL: path.join(work, "before-successful-revocation.json"), FORWARDX_SNI_REVOCATION_ACTION: path.join(input, `removal-action-${entranceId}.json`) }, encoding: "utf8", timeout: 40000,
    });
    assert.equal(successfulRemoval.status, 0, successfulRemoval.stdout + successfulRemoval.stderr);
    assert.equal(process.exitCode, null);
    assert.equal(await echo("after"), `${unchanged.targetPort}/${unchanged.sni}/after`);
    await assert.rejects(request("a.example.com"));
    persistent.destroy();
    const restored = { ...shared, sniRouteVersion: remaining.sniRouteVersion + 1 };
    await update(restored);
    fs.writeFileSync(path.join(work, "before-revocation.json"), JSON.stringify({ ...restored, listenHost, controlSocketPath: control }));
    assert.equal(await request("a.example.com"), `${capped.targetPort}/a.example.com/probe`);
    const revoke = spawnSync(path.join(input, "agent-probe.test"), ["-test.run", "^TestSniForwardGroupFailedRevocation$", "-test.timeout", "30s"], {
      env: { ...globalThis.process.env, FORWARDX_SNI_REVOCATION_FAIL: "1", FORWARDX_SNI_REVOCATION_INITIAL: path.join(work, "before-revocation.json"), FORWARDX_SNI_REVOCATION_ACTION: path.join(input, `removal-action-${entranceId}.json`) }, encoding: "utf8", timeout: 40000,
    });
    assert.equal(revoke.status, 0, revoke.stdout + revoke.stderr);
    await new Promise(resolve => setTimeout(resolve, 100));
    await assert.rejects(request("a.example.com"), "a failed removal cannot retain the revoked domain");
    assert.equal(fs.existsSync(configPath), false, "unsafe runtime configuration must not survive restart");
    const snapshots = "/var/lib/forwardx-agent/fxp";
    assert.ok(!fs.existsSync(snapshots) || !fs.readdirSync(snapshots).some(file => file.includes(`sni-splitter-0-`) && file.endsWith(`-${config.listenPort}.json`)), "unsafe persistent snapshots are removed");
  }
  console.log(`PASS entrance ${entranceId}: saved destinations, original TLS SNI, unknown and missing SNI rejected`);
} finally {
  await Promise.all(processes.map(process => new Promise(resolve => {
    if (process.exitCode !== null || process.signalCode !== null) return resolve();
    process.once("exit", resolve); process.kill("SIGTERM");
  })));
  connections.forEach(socket => socket.destroy());
  await Promise.all(backends.map(server => new Promise(resolve => server.close(resolve))));
  fs.rmSync(work, { recursive: true, force: true });
}
