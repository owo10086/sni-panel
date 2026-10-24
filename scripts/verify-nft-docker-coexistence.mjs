// Isolated end-to-end verification for native nftables forwarding beside a
// Docker-style default-DROP FORWARD chain.
//
//   node --import tsx scripts/verify-nft-docker-coexistence.mjs [scenario ...]
//
// Everything that changes firewall state runs in a disposable privileged
// container without any network: nothing here touches this machine's firewall,
// production hosts, production targets or DNS providers. The panel half is the
// real heartbeat route on a throw-away SQLite database; the Agent half is the
// real Agent test binary replaying the heartbeat's desired state, so the
// commands under test are produced and executed by the shipped code.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import express from "express";

process.env.DATABASE_TYPE = "sqlite";
const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const IMAGE = process.env.FORWARDX_TEST_IMAGE || "forwardx-sni-test:20261006";
const moduleUrl = (file) => pathToFileURL(path.join(repo, file)).href;

const run = (command, args, options = {}) => spawnSync(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...options });

// ---------------------------------------------------------------- build ----
function dockerArch() {
  const result = run("docker", ["run", "--rm", IMAGE, "uname", "-m"]);
  assert.equal(result.status, 0, result.stderr || "docker is required");
  return result.stdout.trim() === "x86_64" ? "amd64" : "arm64";
}

function buildAgentTestBinary(directory) {
  const output = path.join(directory, "agent.test");
  const result = run("go", ["test", "-c", "-o", output, "."], {
    cwd: path.join(repo, "agent"),
    env: { ...process.env, GOOS: "linux", GOARCH: dockerArch(), CGO_ENABLED: "0" },
  });
  assert.equal(result.status, 0, result.stderr);
  return output;
}

const ECHO_PY = `
import socket, sys, threading
port = int(sys.argv[1])
def tcp():
    s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind(("0.0.0.0", port)); s.listen(16)
    while True:
        c, _ = s.accept()
        def handle(c=c):
            data = c.recv(64); c.sendall(b"forwarded:" + data); c.close()
        threading.Thread(target=handle, daemon=True).start()
threading.Thread(target=tcp, daemon=True).start()
u = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); u.bind(("0.0.0.0", port))
while True:
    data, peer = u.recvfrom(64); u.sendto(b"forwarded:" + data, peer)
`;

const PROBE_PY = `
import socket, sys
proto, host, port = sys.argv[1], sys.argv[2], int(sys.argv[3])
try:
    if proto == "tcp":
        s = socket.create_connection((host, port), timeout=2); s.settimeout(2); s.sendall(b"ping"); data = s.recv(64)
    else:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.settimeout(2); s.sendto(b"ping", (host, port)); data, _ = s.recvfrom(64)
    print("OK " + data.decode())
except Exception as error:
    print("FAIL " + type(error).__name__)
`;

// ------------------------------------------------------------------ lab ----
class Lab {
  constructor(directory, name) {
    this.name = name;
    this.directory = directory;
  }

  start() {
    const result = run("docker", [
      "run", "-d", "--rm", "--network", "none", "--privileged", "--name", this.name,
      "-v", `${this.directory}:/work:ro`, IMAGE, "sleep", "3600",
    ]);
    assert.equal(result.status, 0, result.stderr);
    this.sh(`
      set -e
      ip link set lo up
      ip netns add fxc; ip netns add fxt
      ip link add c1 type veth peer name c0 netns fxc
      ip addr add 10.201.1.1/24 dev c1; ip link set c1 up
      ip netns exec fxc ip link set lo up
      ip netns exec fxc ip addr add 10.201.1.2/24 dev c0; ip netns exec fxc ip link set c0 up
      ip netns exec fxc ip route add default via 10.201.1.1
      ip link add t1 type veth peer name t0 netns fxt
      ip addr add 10.201.2.1/24 dev t1; ip link set t1 up
      ip netns exec fxt ip link set lo up
      ip netns exec fxt ip addr add 10.201.2.2/24 dev t0; ip netns exec fxt ip link set t0 up
      # The target has no route back to the client: only source translation lets replies return.
    `);
    for (const port of [10042, 10043]) {
      run("docker", ["exec", "-d", this.name, "ip", "netns", "exec", "fxt", "python3", "/work/echo.py", String(port)]);
    }
    return this;
  }

  sh(script, { allowFailure = false } = {}) {
    const result = run("docker", ["exec", "-i", this.name, "sh", "-c", script]);
    if (!allowFailure) assert.equal(result.status, 0, `${script}\n${result.stdout}${result.stderr}`);
    return { status: result.status, out: result.stdout + result.stderr };
  }

  writeFile(file, content, mode = "755") {
    const result = run("docker", ["exec", "-i", this.name, "sh", "-c", `cat > ${file} && chmod ${mode} ${file}`], { input: content });
    assert.equal(result.status, 0, result.stderr);
  }

  /** Docker-style filter: a default-DROP base chain that only jumps to Docker's chains. */
  installDockerFilter({ trailingReturn = false } = {}) {
    this.sh(`
      iptables -P FORWARD DROP
      iptables -N DOCKER-USER; iptables -N DOCKER-FORWARD
      iptables -A FORWARD -j DOCKER-USER; iptables -A FORWARD -j DOCKER-FORWARD
      ${trailingReturn ? "iptables -A DOCKER-USER -j RETURN" : ""}
    `);
  }

  probe(from, proto, host, port) {
    const ns = from === "client" ? "ip netns exec fxc " : from === "target" ? "ip netns exec fxt " : "";
    const { out } = this.sh(`${ns}python3 /work/probe.py ${proto} ${host} ${port}`, { allowFailure: true });
    return out.trim();
  }

  /** The independent client reaches the target through the entry's business port. */
  viaEntry(proto, port) {
    return this.probe("client", proto, "10.201.1.1", port);
  }

  agent(op, input = {}) {
    const file = `/tmp/agent-io-${op}.json`;
    const write = run("docker", ["exec", "-i", this.name, "sh", "-c", `cat > ${file}`], { input: JSON.stringify(input) });
    assert.equal(write.status, 0, write.stderr);
    const result = run("docker", [
      "exec", "-e", `FORWARDX_NFT_DOCKER_OP=${op}`, "-e", `FORWARDX_NFT_DOCKER_IO=${file}`,
      this.name, "/work/agent.test", "-test.run", "^TestNftDockerAgentOperation$", "-test.timeout", "180s",
    ]);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    if (process.env.LAB_DEBUG) console.log(`--- agent ${op}\n${result.stdout}${result.stderr}`);
    const read = run("docker", ["exec", this.name, "cat", `${file}.out`]);
    assert.equal(read.status, 0, read.stderr);
    return JSON.parse(read.stdout);
  }

  stop() {
    run("docker", ["rm", "-f", this.name]);
  }
}

// ---------------------------------------------------------------- panel ----
let panelSequence = 0;

class Panel {
  async start(directory) {
    // The heartbeat route keeps per-host caches for the life of the process.
    panelSequence += 1;
    this.token = `lab-token-${panelSequence}`;
    this.bootId = `lab-boot-${panelSequence}`;
    this.runtime = await import(moduleUrl("server/dbRuntime.ts"));
    this.schema = await import(moduleUrl("server/dbSchema.ts"));
    const heartbeat = await import(moduleUrl("server/agentHeartbeatRoute.ts"));
    const statusRoutes = await import(moduleUrl("server/agentStatusRoutes.ts"));
    await this.runtime.connectDatabase({ type: "sqlite", sqlite: { path: path.join(directory, "panel.db") } });
    await this.schema.ensureDatabaseSchema();
    this.hostId = 100 + panelSequence;
    await this.insert("users", ["id", "username", "password", "role", "canAddRules"], [1, "admin", "x", "admin", 1]);
    await this.insert("hosts", ["id", "name", "ip", "ipv4", "userId", "agentToken", "agentVersion", "isOnline", "lastHeartbeat", "portRangeStart", "portRangeEnd"],
      [this.hostId, "entry", "10.201.1.1", "10.201.1.1", 1, this.token, agentVersion(), 1, Math.floor(Date.now() / 1000), 30000, 40000]);
    const app = express();
    app.use(express.json({ limit: "32mb" }));
    app.use((req, _res, next) => { req.agentToken = String(req.headers.authorization || "").replace(/^Bearer /, ""); next(); });
    heartbeat.registerAgentHeartbeatRoute(app);
    const router = express.Router();
    statusRoutes.registerAgentStatusRoutes(router);
    app.use(router);
    this.server = http.createServer(app);
    await new Promise((resolve, reject) => { this.server.once("error", reject); this.server.listen(0, "127.0.0.1", resolve); });
    this.baseUrl = `http://127.0.0.1:${this.server.address().port}`;
    return this;
  }

  insert(table, fields, values) {
    return this.runtime.executeRaw(
      `INSERT INTO "${table}" (${fields.map((field) => `"${field}"`).join(",")}) VALUES (${fields.map(() => "?").join(",")})`, values);
  }

  addRule(rule) {
    const row = { forwardType: "nftables", protocol: "both", isEnabled: 1, isRunning: 0, userId: 1, hostId: this.hostId, ...rule };
    const fields = Object.keys(row);
    return this.insert("forward_rules", fields, fields.map((field) => row[field]));
  }

  update(id, values) {
    const fields = Object.keys(values);
    return this.runtime.executeRaw(
      `UPDATE "forward_rules" SET ${fields.map((field) => `"${field}" = ?`).join(", ")} WHERE "id" = ?`, [...fields.map((field) => values[field]), id]);
  }

  /** One real heartbeat, optionally carrying the Agent's real local runtime state. */
  async heartbeat(agentOutput, { restart = false } = {}) {
    if (restart) this.restarts = (this.restarts || 0) + 1;
    const body = {
      agentVersion: agentVersion(), agentBootId: `${this.bootId}-${this.restarts || 0}`, agentProcessId: 100 + (this.restarts || 0),
      agentProcessStartedAt: Math.floor(Date.now() / 1000), forceReconcile: true,
    };
    if (agentOutput) {
      body.localStateSignature = agentOutput.localStateSignature;
      body.localState = agentOutput.localState;
    }
    const response = await fetch(`${this.baseUrl}/api/agent/heartbeat`, {
      method: "POST", headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" }, body: JSON.stringify(body),
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    // A desired state without rule actions only says "nothing to change"; the Agent keeps the last one with work.
    if (result.desiredState?.actions?.some((action) => action.ruleId > 0)) this.lastDesiredState = result.desiredState;
    return result;
  }

  /** Deliver the status reports the Agent queued, exactly as its reporter would. */
  async report(agentOutput) {
    if (!agentOutput.reports?.length) return;
    const response = await fetch(`${this.baseUrl}/api/agent/rule-status-batch`, {
      method: "POST", headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: JSON.stringify({ statuses: agentOutput.reports }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    // A report for a rule the panel has already deleted is expected after removals.
    const unexpected = body.rejected.filter((item) => item.error !== "rule not found");
    assert.deepEqual(unexpected, [], "the panel must accept the Agent's status reports");
    if (process.env.LAB_DEBUG) console.log("report", JSON.stringify(agentOutput.reports), JSON.stringify(body));
    return body;
  }

  async rule(id) {
    const rows = await this.runtime.queryRaw('SELECT * FROM "forward_rules" WHERE "id" = ?', [id]);
    return rows[0];
  }

  async stop() {
    this.server?.close();
    await this.runtime.closeDatabase();
  }
}

function agentVersion() {
  return fs.readFileSync(path.join(repo, "agent/main.go"), "utf8").match(/^var Version = "([^"]+)"/m)[1];
}

// ------------------------------------------------------------ scenarios ----
const HK = { id: 1607, name: "hk", sourcePort: 35211, targetIp: "10.201.2.2", targetPort: 10042 };
const OK = "OK forwarded:ping";

function ruleState(agentOutput, ruleId) {
  return agentOutput.localState.rules.filter((rule) => rule.ruleId === ruleId);
}

/** The rule actions of a heartbeat; shared runtime housekeeping is not under test. */
function ruleActions(heartbeat) {
  return { ...heartbeat.desiredState, actions: heartbeat.desiredState.actions.filter((action) => action.ruleId > 0) };
}

/**
 * Apply what the panel currently wants, as the Agent would after a heartbeat.
 * The panel sends an unchanged desired state only once; the Agent keeps it and
 * re-checks it against the kernel on later cycles, so the previous one is reused.
 */
async function converge(panel, lab, previous, options) {
  const heartbeat = await panel.heartbeat(previous, options);
  assert.ok(panel.lastDesiredState, "the panel has issued no desired state");
  const state = ruleActions({ desiredState: panel.lastDesiredState });
  const output = lab.agent("sync", { state });
  await panel.report(output);
  return { heartbeat, output };
}

/** Re-run the panel's current actions unconditionally, as a manual or heartbeat retry does. */
async function retry(panel, lab) {
  const output = lab.agent("apply", { state: ruleActions({ desiredState: panel.lastDesiredState }) });
  await panel.report(output);
  return output;
}

const isRunning = async (panel, id) => Boolean(Number((await panel.rule(id)).isRunning));
const readyOf = (output, id) => ruleState(output, id).map((rule) => rule.ready);

const dockerUserRules = (lab) => lab.sh("iptables -S DOCKER-USER 2>/dev/null", { allowFailure: true }).out.split("\n").filter((line) => line.startsWith("-"));
const managedAllowances = (lab) => dockerUserRules(lab).filter((line) => line.includes("fwx-docker-"));

const scenarios = {
  async "docker-drop-forwards-tcp-and-udp"({ lab, panel }) {
    assert.equal(lab.probe("entry", "tcp", "10.201.2.2", 10042), OK, "the target itself is reachable");
    lab.installDockerFilter();
    assert.match(lab.sh("iptables-legacy -S FORWARD", { allowFailure: true }).out, /-P FORWARD ACCEPT/, "legacy view must stay misleading");
    await panel.addRule(HK);
    const { output: applied } = await converge(panel, lab);
    const report = applied.reports.find((item) => item.ruleId === HK.id);
    assert.ok(report?.isRunning, `Agent must report the rule running: ${JSON.stringify(report)}`);
    assert.equal(lab.viaEntry("tcp", HK.sourcePort), OK, "TCP round trip through the entry");
    assert.equal(lab.viaEntry("udp", HK.sourcePort), OK, "UDP round trip through the entry");
    assert.match(lab.sh("iptables -S FORWARD").out, /-P FORWARD DROP/, "Docker's default DROP must be kept");
    assert.match(lab.probe("client", "tcp", "10.201.2.2", 10043), /^FAIL/, "unmanaged target port stays filtered");
    assert.match(lab.probe("client", "tcp", "10.201.2.2", 10042), /^FAIL/, "bypassing the entry port stays filtered");
    assert.equal(managedAllowances(lab).length, 4, "one allowance per protocol and direction");
  },

  async "hosts without Docker keep working and gain no allowances"({ lab, panel }) {
    await panel.addRule(HK);
    const { output } = await converge(panel, lab);
    assert.ok(output.reports.find((item) => item.ruleId === HK.id)?.isRunning);
    assert.equal(lab.viaEntry("tcp", HK.sourcePort), OK);
    assert.equal(lab.viaEntry("udp", HK.sourcePort), OK);
    assert.equal(lab.sh("iptables -S; iptables-legacy -S; nft list ruleset", { allowFailure: true }).out.includes("fwx-docker"), false);
  },

  async "administrator deny rules keep precedence over the allowance"({ lab, panel }) {
    lab.installDockerFilter({ trailingReturn: true });
    lab.sh("iptables -I DOCKER-USER 1 -s 10.201.1.2 -p tcp -j DROP");
    await panel.addRule(HK);
    await converge(panel, lab);
    assert.match(lab.viaEntry("tcp", HK.sourcePort), /^FAIL/, "the administrator's explicit TCP deny still applies");
    assert.equal(lab.viaEntry("udp", HK.sourcePort), OK, "other traffic of the rule is allowed");
    const chain = dockerUserRules(lab).filter((line) => line.startsWith("-A"));
    assert.match(chain[0], /-s 10\.201\.1\.2\/32 -p tcp -j DROP/, "administrator rule stays first");
    assert.equal(chain.at(-1), "-A DOCKER-USER -j RETURN", "Docker's trailing RETURN stays last");
    lab.sh("iptables -D DOCKER-USER 1");
    assert.equal(lab.viaEntry("tcp", HK.sourcePort), OK, "removing the deny restores the path without another apply");
  },

  async "repeated apply and Agent restarts do not duplicate or break the allowance"({ lab, panel }) {
    lab.installDockerFilter();
    await panel.addRule(HK);
    await converge(panel, lab);
    await converge(panel, lab, undefined, { restart: true }); // a new Agent process adopts the matching kernel state
    assert.equal(managedAllowances(lab).length, 4);
    lab.sh("rm -f /var/lib/forwardx-agent/desired_state_records.json");
    await converge(panel, lab, undefined, { restart: true }); // intact kernel state is adopted, not rebuilt
    assert.equal(managedAllowances(lab).length, 4);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const output = await retry(panel, lab);
      assert.deepEqual(output.applied, [true], "a retry re-runs and succeeds");
      assert.equal(managedAllowances(lab).length, 4, "re-applying never stacks copies");
      assert.equal(lab.sh("nft list chain inet forwardx prerouting").out.split("\n").filter((line) => line.includes("dnat ip to")).length, 2, "nor does it stack DNAT rules");
    }
    assert.equal(lab.viaEntry("tcp", HK.sourcePort), OK);
    assert.equal(lab.viaEntry("udp", HK.sourcePort), OK);
  },

  async "allowances that cannot be installed fail the action with a reason"({ lab, panel }) {
    lab.installDockerFilter();
    // A front end that refuses writes models missing privileges or a broken tool.
    const real = lab.sh("command -v iptables-nft").out.trim();
    lab.writeFile("/usr/local/sbin/iptables-nft", [
      "#!/bin/sh",
      'case " $* " in *" DOCKER-USER "*) case "$*" in *" -I "*|*" -A "*) echo "iptables: Permission denied" >&2; exit 4 ;; esac ;; esac',
      `exec ${real} "$@"`, "",
    ].join("\n"));
    await panel.addRule(HK);
    const { output } = await converge(panel, lab);
    const report = output.reports.find((item) => item.ruleId === HK.id);
    assert.equal(report?.isRunning, false, `a failed install must not be reported as running: ${JSON.stringify(report)}`);
    assert.match(report.message, /\[docker-compat\] iptables-nft: cannot install DOCKER-USER allowance for rule 1607/);
    assert.match(lab.viaEntry("tcp", HK.sourcePort), /^FAIL/);
  },

  async "a removed allowance is detected although DNAT stays, and is repaired"({ lab, panel }) {
    lab.installDockerFilter();
    await panel.addRule(HK);
    let { output } = await converge(panel, lab);
    assert.deepEqual(readyOf(output, HK.id), [true]);
    assert.match(lab.sh("iptables-legacy -S FORWARD", { allowFailure: true }).out, /-P FORWARD ACCEPT/, "the legacy view stays misleading");
    assert.equal(await isRunning(panel, HK.id), true);

    lab.sh("iptables -F DOCKER-USER");
    assert.match(lab.sh("nft list chain inet forwardx prerouting").out, /dnat ip to 10\.201\.2\.2:10042/, "the DNAT is still installed");
    assert.match(lab.viaEntry("tcp", HK.sourcePort), /^FAIL/, "without the allowance the business path is dead");
    output = lab.agent("state");
    assert.deepEqual(readyOf(output, HK.id), [false], "the Agent must stop reporting the rule ready");
    await panel.heartbeat(output);
    assert.equal(await isRunning(panel, HK.id), false, "the panel must stop showing the rule as running");

    ({ output } = await converge(panel, lab, output, { restart: true }));
    assert.deepEqual(readyOf(output, HK.id), [true], "rebuilding the configuration restores readiness");
    assert.equal(await isRunning(panel, HK.id), true);
    assert.equal(lab.viaEntry("tcp", HK.sourcePort), OK);
    assert.equal(lab.viaEntry("udp", HK.sourcePort), OK);
  },

  async "a restarted Agent does not trust old success records over the kernel"({ lab, panel }) {
    lab.installDockerFilter();
    await panel.addRule(HK);
    await converge(panel, lab);
    lab.sh("iptables -F DOCKER-USER");
    assert.match(lab.viaEntry("udp", HK.sourcePort), /^FAIL/);
    const { output } = await converge(panel, lab, undefined, { restart: true });
    assert.ok(output.reports.find((item) => item.ruleId === HK.id)?.isRunning, "the drift is repaired on adoption");
    assert.equal(lab.viaEntry("udp", HK.sourcePort), OK);
    assert.equal(managedAllowances(lab).length, 4);
  },

  async "disabled IP forwarding is detected and restored"({ lab, panel }) {
    await panel.addRule(HK);
    let { output } = await converge(panel, lab);
    assert.equal(lab.viaEntry("tcp", HK.sourcePort), OK);
    lab.sh("sysctl -w net.ipv4.ip_forward=0");
    assert.match(lab.viaEntry("tcp", HK.sourcePort), /^FAIL/);
    output = lab.agent("state");
    assert.deepEqual(readyOf(output, HK.id), [false]);
    ({ output } = await converge(panel, lab, output, { restart: true }));
    assert.deepEqual(readyOf(output, HK.id), [true]);
    assert.equal(lab.sh("cat /proc/sys/net/ipv4/ip_forward").out.trim(), "1");
    assert.equal(lab.viaEntry("tcp", HK.sourcePort), OK);
  },

  async "missing source translation is detected and rebuilt"({ lab, panel }) {
    await panel.addRule(HK);
    let { output } = await converge(panel, lab);
    assert.equal(lab.viaEntry("tcp", HK.sourcePort), OK);
    lab.sh(`for h in $(nft -a list chain inet forwardx postrouting | awk '/masquerade/ {print $NF}'); do nft delete rule inet forwardx postrouting handle "$h"; done`);
    assert.match(lab.viaEntry("tcp", HK.sourcePort), /^FAIL/, "replies cannot return without source translation");
    output = lab.agent("state");
    assert.deepEqual(readyOf(output, HK.id), [false]);
    ({ output } = await converge(panel, lab, output, { restart: true }));
    assert.deepEqual(readyOf(output, HK.id), [true]);
    assert.equal(lab.viaEntry("tcp", HK.sourcePort), OK);
  },

  async "a missing forward accept is detected and rebuilt"({ lab, panel }) {
    await panel.addRule(HK);
    let { output } = await converge(panel, lab);
    lab.sh(`for h in $(nft -a list chain inet forwardx forward | awk '/accept/ {print $NF}'); do nft delete rule inet forwardx forward handle "$h"; done`);
    output = lab.agent("state");
    assert.deepEqual(readyOf(output, HK.id), [false]);
    ({ output } = await converge(panel, lab, output, { restart: true }));
    assert.deepEqual(readyOf(output, HK.id), [true]);
  },

  async "an unavailable target does not make a complete local configuration unready"({ lab, panel }) {
    lab.installDockerFilter();
    await panel.addRule(HK);
    await converge(panel, lab);
    lab.sh("pkill -f /work/echo.py", { allowFailure: true });
    assert.match(lab.viaEntry("tcp", HK.sourcePort), /^FAIL/, "the business target is down");
    const output = lab.agent("state");
    assert.deepEqual(readyOf(output, HK.id), [true], "local readiness must not depend on the business target");
    await panel.heartbeat(output);
    assert.equal(await isRunning(panel, HK.id), true);
  },

  async "a default-DROP layout outside the supported Docker structure is not judged"({ lab, panel }) {
    lab.sh("iptables -P FORWARD DROP; iptables -N ufw-before-forward; iptables -A FORWARD -j ufw-before-forward");
    await panel.addRule(HK);
    const { output } = await converge(panel, lab);
    assert.ok(output.reports.find((item) => item.ruleId === HK.id)?.isRunning, "an unsupported structure is neither modified nor reported as failed");
    assert.deepEqual(managedAllowances(lab), []);
    assert.equal(lab.sh("iptables -S ufw-before-forward").out.includes("fwx-"), false);
  },

  async "disabling and deleting rules removes only their own allowances"({ lab, panel }) {
    lab.installDockerFilter();
    const second = { id: 1608, name: "second", sourcePort: 35212, targetIp: "10.201.2.2", targetPort: 10042 };
    await panel.addRule(HK);
    await panel.addRule(second);
    let { output } = await converge(panel, lab);
    assert.equal(managedAllowances(lab).length, 8);
    assert.equal(lab.viaEntry("tcp", second.sourcePort), OK, "two entry ports may share one target");
    await panel.update(HK.id, { isEnabled: 0 });
    ({ output } = await converge(panel, lab, output));
    assert.deepEqual(managedAllowances(lab).filter((line) => line.includes("fwx-docker-1607-")), [], "the disabled rule leaves nothing open");
    assert.equal(managedAllowances(lab).filter((line) => line.includes("fwx-docker-1608-")).length, 4, "the shared-target neighbour is untouched");
    assert.match(lab.viaEntry("tcp", HK.sourcePort), /^FAIL/);
    assert.equal(lab.viaEntry("tcp", second.sourcePort), OK);
    assert.equal(lab.viaEntry("udp", second.sourcePort), OK);
    await panel.runtime.executeRaw('DELETE FROM "forward_rules" WHERE "id" = ?', [second.id]);
    ({ output } = await converge(panel, lab, output));
    assert.deepEqual(managedAllowances(lab), [], "deleting the last rule removes every allowance");
    assert.match(lab.sh("iptables -S FORWARD").out, /-P FORWARD DROP/);
    assert.deepEqual(dockerUserRules(lab), ["-N DOCKER-USER"], "Docker's chain is left as it was");
  },
};

// ----------------------------------------------------------------- main ----
const selected = process.argv.slice(2);
const names = selected.length ? selected : Object.keys(scenarios);
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-nft-docker-"));
fs.writeFileSync(path.join(directory, "echo.py"), ECHO_PY);
fs.writeFileSync(path.join(directory, "probe.py"), PROBE_PY);
buildAgentTestBinary(directory);
let failed = 0;
for (const name of names) {
  assert.ok(scenarios[name], `unknown scenario ${name}`);
  const scenarioDirectory = fs.mkdtempSync(path.join(directory, "panel-"));
  const lab = new Lab(directory, `forwardx-nft-docker-${process.pid}-${Math.random().toString(36).slice(2, 8)}`).start();
  const panel = await new Panel().start(scenarioDirectory);
  try {
    await scenarios[name]({ lab, panel });
    console.log(`PASS ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name}\n${error.stack || error}`);
  } finally {
    await panel.stop();
    lab.stop();
  }
}
fs.rmSync(directory, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
