// 仅在隔离 Linux 测试环境运行：需要 NET_ADMIN，会预置测试防火墙规则和回环地址。
// 参数目录包含 sniDesiredState.test.ts 导出的真实 desired.json、panel.db 和 FXP 二进制。
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import tls from "node:tls";

const input = process.argv[2];
assert.equal(process.platform, "linux", "use an isolated Linux container");
assert.ok(input, "provide the directory exported by the heartbeat integration test");
const desired = JSON.parse(fs.readFileSync(path.join(input, "desired.json"), "utf8"));
const cleanup = desired.actions.find((action) => action.forwardType === "sni-source-cleanup");
const splitter = desired.actions.find((action) => action.fxp?.role === "sni-splitter" && action.sourcePort === 24000);
assert.ok(cleanup && splitter);
const work = fs.mkdtempSync(path.join(os.tmpdir(), "sni-source-verify-"));
const cleanupFile = path.join(work, "cleanup.sh");
fs.writeFileSync(cleanupFile, cleanup.commands.join("\n"));

function execute(binary, args, options = {}) {
  const result = spawnSync(binary, args, { encoding: "utf8", timeout: 15_000, ...options });
  assert.equal(result.status, 0, `${binary} ${args.join(" ")}: ${result.stderr || result.error || result.stdout}`);
  return result.stdout;
}

function backendEnvironment(backend) {
  const directory = path.join(work, backend);
  fs.mkdirSync(directory, { recursive: true });
  for (const binary of ["iptables", "ip6tables"]) {
    for (const suffix of ["", "-restore"]) {
      const link = path.join(directory, binary + suffix);
      if (!fs.existsSync(link)) fs.symlinkSync(`/usr/sbin/${binary}-${backend}${suffix}`, link);
    }
  }
  return { ...process.env, PATH: directory + ":" + process.env.PATH };
}

function seedRules(env, seedNft = true) {
  if (seedNft) {
    execute("nft", ["add", "table", "inet", "forwardx"]);
    execute("nft", ["add", "chain", "inet", "forwardx", "sni_input", "{ type filter hook input priority -10; policy accept; }"]);
    execute("nft", ["add", "chain", "inet", "forwardx", "ordinary"]);
    for (const port of [24000, 29999]) {
      execute("nft", ["add", "rule", "inet", "forwardx", "sni_input", "ip", "saddr", "198.51.100.10", "tcp", "dport", String(port), "accept", "comment", `"fwx-sni-splitter-${port}:v123:allow:198.51.100.10"`]);
      execute("nft", ["add", "rule", "inet", "forwardx", "sni_input", "tcp", "dport", String(port), "drop", "comment", `"fwx-sni-splitter-${port}:v123:drop"`]);
    }
    for (const comment of ["fwx-rule-42", "fwx-stat-24000:in", "admin-fwx-sni-splitter-24000:drop", "china-whitelist"]) {
      execute("nft", ["add", "rule", "inet", "forwardx", "sni_input", "counter", "comment", `"${comment}"`]);
    }
  }
  for (const binary of ["iptables", "ip6tables"]) {
    const source = binary === "iptables" ? "198.51.100.10" : "2001:db8::10";
    for (const port of [24000, 29999]) {
      execute(binary, ["-A", "INPUT", "-p", "tcp", "-s", source, "--dport", String(port), "-m", "comment", "--comment", `fwx-sni-splitter-${port}:allow:${source}`, "-j", "ACCEPT"], { env });
      execute(binary, ["-A", "INPUT", "-p", "tcp", "--dport", String(port), "-m", "comment", "--comment", `fwx-sni-splitter-${port}:drop`, "-j", "DROP"], { env });
    }
    execute(binary, ["-A", "INPUT", "-m", "comment", "--comment", "admin-fwx-sni-splitter-24000:drop", "-j", "ACCEPT"], { env });
    execute(binary, ["-t", "mangle", "-A", "INPUT", "-m", "comment", "--comment", "fwx-stat-24000:in"], { env });
  }
}

function verifyUnrelatedRules(env) {
  const nft = execute("nft", ["list", "table", "inet", "forwardx"]);
  for (const comment of ["fwx-rule-42", "fwx-stat-24000:in", "admin-fwx-sni-splitter-24000:drop", "china-whitelist"]) assert.ok(nft.includes(`comment "${comment}"`));
  assert.doesNotMatch(nft, /comment "fwx-sni-splitter-[0-9]+:/);
  for (const binary of ["iptables", "ip6tables"]) {
    const rules = execute(binary, ["-S"], { env });
    assert.match(rules, /admin-fwx-sni-splitter-24000:drop/);
    assert.doesNotMatch(rules, /--comment "?fwx-sni-splitter-[0-9]+:/);
    assert.match(execute(binary, ["-t", "mangle", "-S"], { env }), /fwx-stat-24000:in/);
  }
}

for (const backend of ["nft", "legacy"]) {
  test(`real nftables and ${backend} IPv4/IPv6 cleanup preserves unrelated rules`, () => {
    const env = backendEnvironment(backend);
    seedRules(env);
    // 使用按端口清理，确认不会删掉其他端口的历史标记。
    const scoped = path.join(work, "scoped.sh");
    fs.writeFileSync(scoped, splitter.commands.join("\n"));
    execute("sh", [scoped], { env });
    assert.match(execute("nft", ["list", "table", "inet", "forwardx"]), /fwx-sni-splitter-29999:/);
    assert.match(execute("ip6tables", ["-S"], { env }), /fwx-sni-splitter-29999:/);
    execute("sh", [cleanupFile], { env });
    verifyUnrelatedRules(env);
    execute("sh", [cleanupFile], { env });
    verifyUnrelatedRules(env);
    execute("nft", ["delete", "table", "inet", "forwardx"]);
  });
}

test("coexisting legacy and nft iptables rules are cleared after alternatives change", () => {
  const nftEnv = backendEnvironment("nft");
  const legacyEnv = backendEnvironment("legacy");
  seedRules(nftEnv);
  seedRules(legacyEnv, false);
  execute("sh", [cleanupFile], { env: nftEnv });
  verifyUnrelatedRules(nftEnv);
  verifyUnrelatedRules(legacyEnv);
  execute("nft", ["delete", "table", "inet", "forwardx"]);
});

test("deletion and inspection failures remain failures until a real retry succeeds", () => {
  const env = { ...process.env };
  seedRules(env);
  const failingPath = path.join(work, "failing");
  fs.mkdirSync(failingPath);
  const nft = path.join(failingPath, "nft");
  fs.writeFileSync(nft, '#!/bin/sh\nif [ "$1" = delete ]; then exit 1; fi\nexec /usr/sbin/nft "$@"\n', { mode: 0o755 });
  const failure = spawnSync("sh", [cleanupFile], { encoding: "utf8", env: { ...env, PATH: failingPath + ":" + env.PATH } });
  assert.notEqual(failure.status, 0);
  assert.match(execute("nft", ["list", "table", "inet", "forwardx"]), /comment "fwx-sni-splitter-24000:/);
  execute("sh", [cleanupFile], { env });
  verifyUnrelatedRules(env);
  fs.writeFileSync(nft, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const unverified = spawnSync("sh", [cleanupFile], { env: { ...env, PATH: failingPath + ":" + env.PATH } });
  assert.notEqual(unverified.status, 0, "an unreadable firewall must not count as an empty firewall");
});

test("unchanged panel address and route accept real TLS from sources A, B and C after migration", async () => {
  const dbAddress = () => execute("python3", ["-c", "import sqlite3,sys; c=sqlite3.connect('file:'+sys.argv[1]+'?immutable=1',uri=True); print(c.execute('SELECT ip FROM hosts WHERE id=1').fetchone()[0])", path.join(input, "panel.db")]).trim();
  assert.equal(dbAddress(), "198.51.100.10");
  const databaseBefore = fs.readFileSync(path.join(input, "panel.db"));
  execute("ip", ["address", "add", "203.0.113.20/32", "dev", "lo"]);
  for (const ip of ["198.51.100.10", "198.51.100.11", "198.51.100.12"]) execute("ip", ["address", "add", ip + "/32", "dev", "lo"]);
  for (const ip of ["2001:db8::10", "2001:db8::11", "2001:db8::12"]) execute("ip", ["-6", "address", "add", ip + "/128", "dev", "lo", "nodad"]);
  const cert = path.join(work, "cert.pem");
  const key = path.join(work, "key.pem");
  execute("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-subj", "/CN=api.example.com", "-days", "1"]);
  const backend = tls.createServer({ cert: fs.readFileSync(cert), key: fs.readFileSync(key) }, (socket) => socket.end("correct-target"));
  await new Promise((resolve) => backend.listen(443, "203.0.113.20", resolve));
  const configPath = path.join(work, "splitter.json");
  fs.writeFileSync(configPath, JSON.stringify({ ...splitter.fxp, controlSocketPath: path.join(work, "splitter.sock") }));
  const logs = fs.openSync(path.join(work, "fxp.log"), "a");
  let processHandle;
  const start = async () => {
    processHandle = spawn(path.join(input, "forwardx-fxp"), ["-config", configPath], { stdio: ["ignore", logs, logs] });
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await new Promise((resolve) => { const socket = net.connect(24000, "127.0.0.1"); socket.on("connect", () => { socket.destroy(); resolve(true); }); socket.on("error", () => resolve(false)); })) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("FXP did not start: " + fs.readFileSync(path.join(work, "fxp.log"), "utf8"));
  };
  const stop = () => new Promise((resolve) => { processHandle.once("exit", resolve); processHandle.kill("SIGTERM"); });
  const request = (localAddress, servername = "api.example.com") => new Promise((resolve, reject) => {
    const socket = tls.connect({ host: localAddress.includes(":") ? "::1" : "127.0.0.1", port: 24000, localAddress, servername, rejectUnauthorized: false });
    const data = [];
    let handshakeComplete = false;
    socket.once("secureConnect", () => { handshakeComplete = true; });
    socket.setTimeout(2000, () => socket.destroy(new Error("TLS request timed out")));
    socket.on("data", (chunk) => data.push(chunk));
    socket.on("end", () => handshakeComplete ? resolve(Buffer.concat(data).toString()) : reject(new Error("TLS handshake rejected")));
    socket.on("error", reject);
  });
  try {
    await start();
    // 先证明真实旧防火墙只放行 A，B 被拦截；元数据为空仍必须执行清理。
    execute("nft", ["add", "rule", "inet", "forwardx", "sni_input", "ip", "saddr", "198.51.100.10", "tcp", "dport", "24000", "accept", "comment", '"fwx-sni-splitter-24000:allow:198.51.100.10"']);
    execute("nft", ["add", "rule", "inet", "forwardx", "sni_input", "tcp", "dport", "24000", "drop", "comment", '"fwx-sni-splitter-24000:drop"']);
    assert.equal(await request("198.51.100.10"), "correct-target");
    await assert.rejects(request("198.51.100.11"));
    execute("sh", [cleanupFile]);
    for (const source of ["198.51.100.10", "198.51.100.11", "198.51.100.12", "2001:db8::10", "2001:db8::11", "2001:db8::12"]) assert.equal(await request(source), "correct-target", source);
    await assert.rejects(request("198.51.100.12", "unknown.example.com"));
    await assert.rejects(request("198.51.100.12", ""));
    assert.equal(dbAddress(), "198.51.100.10");
    assert.deepEqual(fs.readFileSync(path.join(input, "panel.db")), databaseBefore);
    await stop();
    await start();
    execute("sh", [cleanupFile]);
    assert.equal(await request("198.51.100.11"), "correct-target");
    assert.doesNotMatch(execute("nft", ["list", "table", "inet", "forwardx"]), /comment "fwx-sni-splitter-[0-9]+:/);
  } finally {
    if (processHandle && processHandle.exitCode === null) await stop();
    await new Promise((resolve) => backend.close(resolve));
    fs.closeSync(logs);
  }
});
