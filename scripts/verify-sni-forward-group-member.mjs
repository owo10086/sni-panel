// Run only in the isolated verification container, using real member heartbeats.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";

const input = process.argv[2];
assert.ok(input, "provide the heartbeat export directory");
const additions = JSON.parse(fs.readFileSync(path.join(input, "member-added-3.json"), "utf8"));
assert.equal(additions.length, 2, "the new member receives both business ports");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "sni-member-network-"));
const cert = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", path.join(work, "key.pem"), "-out", path.join(work, "cert.pem"), "-subj", "/CN=sni-member-test", "-days", "1"], { encoding: "utf8", timeout: 15000 });
assert.equal(cert.status, 0, cert.stderr);
const credentials = { key: fs.readFileSync(path.join(work, "key.pem")), cert: fs.readFileSync(path.join(work, "cert.pem")) };
const backends = [];
const connections = new Set();
const replay = stage => {
  const result = spawnSync(path.join(input, "agent-probe.test"), ["-test.run", "^TestSniForwardGroupMemberActions$", "-test.timeout", "30s"], {
    env: { ...process.env, FORWARDX_SNI_MEMBER_ACTIONS: path.join(input, `member-${stage}-3.json`) }, encoding: "utf8", timeout: 40000,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
};
const request = (port, servername) => new Promise((resolve, reject) => {
  const socket = tls.connect({ host: "127.0.0.1", port, servername, rejectUnauthorized: false });
  socket.setTimeout(2000, () => socket.destroy(new Error("new member TLS timed out")));
  socket.once("error", reject);
  socket.once("secureConnect", () => socket.write("new-member"));
  socket.once("data", data => { socket.destroy(); resolve(data.toString()); });
});
try {
  fs.mkdirSync("/usr/local/bin", { recursive: true });
  fs.copyFileSync(path.join(input, "forwardx-fxp"), "/usr/local/bin/forwardx-fxp");
  const targets = new Map(additions.flatMap(item => item.fxp.sniRoutes).map(route => [`${route.targetIp}:${route.targetPort}`, route]));
  for (const route of targets.values()) {
    const server = tls.createServer(credentials, socket => {
      connections.add(socket);
      socket.once("close", () => connections.delete(socket));
      socket.on("error", () => {});
      socket.on("data", data => socket.write(`${route.targetPort}/${socket.servername}/${data}`));
    });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(route.targetPort, route.targetIp, resolve); });
    backends.push(server);
  }
  replay("added");
  for (const item of additions) {
    for (const route of item.fxp.sniRoutes) {
      assert.equal(await request(item.sourcePort, route.sni), `${route.targetPort}/${route.sni}/new-member`);
    }
  }
  replay("disabled");
  for (const item of additions) {
    await assert.rejects(request(item.sourcePort, item.fxp.sniRoutes[0].sni), "disabled member must no longer accept its business domain");
  }
  console.log("PASS new member C: both heartbeat ports reach their saved destinations; disabling removes both listeners");
} finally {
  connections.forEach(socket => socket.destroy());
  await Promise.all(backends.map(server => new Promise(resolve => server.close(resolve))));
  fs.rmSync(work, { recursive: true, force: true });
}
