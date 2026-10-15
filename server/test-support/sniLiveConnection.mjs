// Opt-in local verification with a real FXP process and a persistent TLS socket.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";

export async function verifyBatchKeepsConnection(prepare) {
  const binary = process.env.FORWARDX_FXP_RELEASE_BINARY;
  assert.ok(binary, "FORWARDX_FXP_RELEASE_BINARY must point to a local FXP build");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sni-live-"));
  const controlSocketPath = path.join(directory, "control.sock");
  const certificate = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", path.join(directory, "key.pem"), "-out", path.join(directory, "cert.pem"), "-subj", "/CN=local-batch-check", "-days", "1"], { encoding: "utf8", timeout: 15_000 });
  assert.equal(certificate.status, 0, certificate.stderr);
  const sockets = new Set();
  const backend = tls.createServer({ key: fs.readFileSync(path.join(directory, "key.pem")), cert: fs.readFileSync(path.join(directory, "cert.pem")) }, socket => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    socket.on("data", data => socket.write(socket.servername + ":" + data));
  });
  let fxp;
  let persistent;
  let logs = "";
  const connect = (port, servername) => new Promise((resolve, reject) => {
    const socket = tls.connect({ host: "127.0.0.1", port, servername, rejectUnauthorized: false });
    socket.setTimeout(5000, () => socket.destroy(new Error("TLS probe timed out")));
    socket.once("error", reject);
    socket.once("secureConnect", () => resolve(socket));
  });
  const echo = (socket, payload) => new Promise((resolve, reject) => {
    const failed = error => { socket.removeListener("data", received); reject(error); };
    const received = data => { socket.removeListener("error", failed); resolve(data.toString()); };
    socket.once("error", failed);
    socket.once("data", received);
    socket.write(payload);
  });
  try {
    await new Promise((resolve, reject) => { backend.once("error", reject); backend.listen(0, "127.0.0.1", resolve); });
    const { before, importBatch } = await prepare({ targetIp: "127.0.0.1", targetPort: backend.address().port });
    const healthy = before.sniRoutes[0].sni;
    const configFile = path.join(directory, "config.json");
    fs.writeFileSync(configFile, JSON.stringify({ ...before, listenHost: "127.0.0.1", controlSocketPath }));
    fxp = spawn(binary, ["-config", configFile], { stdio: ["ignore", "pipe", "pipe"] });
    fxp.stdout.on("data", data => { logs += data; });
    fxp.stderr.on("data", data => { logs += data; });
    for (let attempt = 0; !fs.existsSync(controlSocketPath) && attempt < 100; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(fs.existsSync(controlSocketPath), logs);
    persistent = await connect(before.listenPort, healthy);
    assert.equal(await echo(persistent, "before"), healthy + ":before");
    const after = await importBatch();
    assert.equal(await echo(persistent, "saved"), healthy + ":saved", "same connection survives the actual batch save");
    assert.equal(after.listenPort, before.listenPort);
    assert.deepEqual(after.sniRoutes.find(route => route.sni === healthy), before.sniRoutes[0]);
    await new Promise((resolve, reject) => {
      const socket = net.connect(controlSocketPath);
      let response = "";
      socket.setTimeout(2000, () => socket.destroy(new Error("route update timed out")));
      socket.once("error", reject);
      socket.once("connect", () => socket.write(JSON.stringify({ version: after.sniRouteVersion, sniRoutes: after.sniRoutes }) + "\n"));
      socket.on("data", data => {
        response += data;
        if (!response.includes("\n")) return;
        socket.destroy();
        try {
          const result = JSON.parse(response.trim());
          assert.equal(result.ok, true, result.error);
          assert.equal(result.version, after.sniRouteVersion);
          resolve();
        } catch (error) { reject(error); }
      });
    });
    assert.equal(await echo(persistent, "applied"), healthy + ":applied", "same connection survives the heartbeat route update");
    for (const route of after.sniRoutes) {
      const socket = await connect(after.listenPort, route.sni);
      try { assert.equal(await echo(socket, "new"), route.sni + ":new"); }
      finally { socket.destroy(); }
    }
    assert.equal(fxp.exitCode, null, logs);
    console.log("PASS: one live TLS connection survived batch creation and heartbeat route replacement; all " + after.sniRoutes.length + " domains accept new TLS connections; the same FXP process remains alive");
  } finally {
    persistent?.destroy();
    for (const socket of sockets) socket.destroy();
    if (fxp?.exitCode === null) {
      const stopped = new Promise(resolve => fxp.once("exit", resolve));
      fxp.kill("SIGTERM");
      await stopped;
    }
    await new Promise(resolve => backend.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
