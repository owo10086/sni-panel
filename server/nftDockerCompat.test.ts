import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildManagedPortCleanupCmds,
  buildNftCleanupCmds,
  buildNftForwardCmds,
  buildDockerForwardCompatCleanupCmds,
  buildDockerForwardCompatCmds,
} from "./agentActionCommands";

const rule = { id: 42, sourcePort: 22022, targetIp: "203.0.113.10", targetPort: 443, protocol: "both" };
// First eight hex digits of sha1("<target ip>:<target port>"), computed independently of the code under test.
const tag = "3b5b6cf2"; // 203.0.113.10:443
const otherTargetTag = "bcc33507"; // 203.0.113.11:443

/**
 * A stateful stand-in for an iptables front end. It models only what the
 * compatibility scripts rely on: the FORWARD policy and jumps, plus an ordered
 * DOCKER-USER chain addressed by rule specification and position, and the
 * matching `-restore` binary that deletes by specification.
 */
class FakeIptables {
  readonly directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-fake-iptables-"));

  constructor(private readonly binaries: string[], options: { forward?: string[]; dockerUser?: string[]; failWrites?: boolean; failDeletes?: boolean } = {}) {
    fs.mkdirSync(path.join(this.directory, "bin"));
    this.write("forward", options.forward ?? ["-P FORWARD DROP", "-A FORWARD -j DOCKER-USER", "-A FORWARD -j DOCKER-FORWARD"]);
    this.write("chain", options.dockerUser ?? []);
    this.write("log", []);
    const front = [
      "#!/bin/sh",
      `state=${JSON.stringify(this.directory)}`,
      'echo "$(basename "$0") $*" >> "$state/log"',
      "[ \"$1\" = -w ] && shift 2",
      'op=$1; chain=$2; shift 2',
      `if [ -f "$state/fail" ] && { [ "$op" = -I ] || [ "$op" = -A ]; }; then exit 4; fi`,
      'case "$op $chain" in',
      '  "-S FORWARD") cat "$state/forward" ;;',
      '  "-S DOCKER-USER") echo "-N DOCKER-USER"; cat "$state/chain" ;;',
      '  "-C DOCKER-USER") grep -qxF -- "-A DOCKER-USER $*" "$state/chain" ;;',
      '  "-A DOCKER-USER") echo "-A DOCKER-USER $*" >> "$state/chain" ;;',
      '  "-I DOCKER-USER") n=$1; shift; awk -v n="$n" -v rule="-A DOCKER-USER $*" \'NR==n {print rule} {print}\' "$state/chain" > "$state/chain.new" && mv "$state/chain.new" "$state/chain" ;;',
      "  *) exit 1 ;;",
      "esac",
      "",
    ].join("\n");
    // `<front>-restore --noflush --wait 5` reads `*filter`, `-D DOCKER-USER <spec>` lines and `COMMIT`.
    const restore = [
      "#!/bin/sh",
      `state=${JSON.stringify(this.directory)}`,
      'echo "$(basename "$0") $*" >> "$state/log"',
      'if [ -f "$state/faildelete" ]; then cat >/dev/null; exit 5; fi',
      "while IFS= read -r line; do",
      '  case "$line" in',
      '    "-D DOCKER-USER "*) rule="-A DOCKER-USER ${line#-D DOCKER-USER }"; awk -v rule="$rule" \'!done && $0 == rule {done=1; next} {print}\' "$state/chain" > "$state/chain.new" && mv "$state/chain.new" "$state/chain" ;;',
      "  esac",
      "done",
      "",
    ].join("\n");
    for (const binary of binaries) {
      fs.writeFileSync(path.join(this.directory, "bin", binary), front, { mode: 0o755 });
      fs.writeFileSync(path.join(this.directory, "bin", `${binary}-restore`), restore, { mode: 0o755 });
    }
    if (options.failWrites) fs.writeFileSync(path.join(this.directory, "fail"), "");
    if (options.failDeletes) fs.writeFileSync(path.join(this.directory, "faildelete"), "");
  }

  private write(name: string, lines: string[]) {
    fs.writeFileSync(path.join(this.directory, name), lines.map((line) => `${line}\n`).join(""));
  }

  get chain() {
    return fs.readFileSync(path.join(this.directory, "chain"), "utf8").split("\n").filter(Boolean);
  }

  get log() {
    return fs.readFileSync(path.join(this.directory, "log"), "utf8").split("\n").filter(Boolean);
  }

  /** Writes issued so far: insertions/appends and restore (deletion) transactions. */
  get writes() {
    return this.log.filter((line) => / -[IA] DOCKER-USER /.test(line) || /-restore /.test(line));
  }

  run(commands: string[]) {
    // Mirrors the Agent's batch: each command in its own shell, any failure fails the batch.
    const results = commands.map((command) => spawnSync("sh", ["-c", command], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${path.join(this.directory, "bin")}:/usr/bin:/bin` },
    }));
    return { ok: results.every((result) => result.status === 0), output: results.map((result) => result.stdout + result.stderr).join("") };
  }

  dispose() {
    fs.rmSync(this.directory, { recursive: true, force: true });
  }
}

const withFake = (binaries: string[], options: ConstructorParameters<typeof FakeIptables>[1], body: (fake: FakeIptables) => void) => {
  const fake = new FakeIptables(binaries, options);
  try {
    body(fake);
  } finally {
    fake.dispose();
  }
};

const allowance = (proto: "tcp" | "udp", direction: "in" | "out", options: { id?: number; port?: number; ip?: string; suffix?: string } = {}) => {
  const { id = 42, port = 22022, ip = "203.0.113.10", suffix = tag } = options;
  const comment = `fwx-docker-${id}-${port}-${proto}-${direction}-${suffix}`;
  return direction === "in"
    ? `-A DOCKER-USER -p ${proto} -d ${ip} --dport 443 -m conntrack --ctorigdstport ${port} -m comment --comment ${comment} -j ACCEPT`
    : `-A DOCKER-USER -p ${proto} -s ${ip} --sport 443 -m conntrack --ctorigdstport ${port} --ctdir REPLY --ctstate ESTABLISHED,RELATED -m comment --comment ${comment} -j ACCEPT`;
};

test("DOCKER-USER allowances are scoped to the rule, original port, protocol, target and direction", () => {
  withFake(["iptables-nft"], {}, (fake) => {
    const result = fake.run(buildDockerForwardCompatCmds(rule));
    assert.equal(result.ok, true, result.output);
    assert.deepEqual(fake.chain, [
      allowance("tcp", "in"), allowance("tcp", "out"), allowance("udp", "in"), allowance("udp", "out"),
    ]);
  });
});

test("re-applying an unchanged rule writes nothing, so forwarding is never interrupted", () => {
  withFake(["iptables-nft"], {}, (fake) => {
    assert.equal(fake.run(buildDockerForwardCompatCmds(rule)).ok, true);
    const firstWrites = fake.writes.length;
    assert.equal(firstWrites, 4);
    for (let round = 0; round < 3; round += 1) {
      assert.equal(fake.run(buildDockerForwardCompatCmds(rule)).ok, true);
    }
    assert.equal(fake.writes.length, firstWrites, "no deletion and no re-insertion while the specification is unchanged");
    assert.equal(fake.chain.length, 4);
  });
});

test("allowances sit after administrator rules and before a trailing RETURN", () => {
  const admin = "-A DOCKER-USER -s 198.51.100.7/32 -j DROP";
  withFake(["iptables-nft"], { dockerUser: [admin, "-A DOCKER-USER -j RETURN"] }, (fake) => {
    assert.equal(fake.run(buildDockerForwardCompatCmds({ ...rule, protocol: "tcp" })).ok, true);
    const chain = fake.chain;
    assert.equal(chain[0], admin, "the administrator's explicit deny keeps its precedence");
    assert.equal(chain.at(-1), "-A DOCKER-USER -j RETURN");
    assert.equal(chain.length, 4);
    assert.match(chain[1], /fwx-docker-42-22022-tcp-in/);
    assert.match(chain[2], /fwx-docker-42-22022-tcp-out/);
  });
});

test("nothing is installed unless FORWARD drops by default and jumps to DOCKER-USER", () => {
  for (const forward of [
    ["-P FORWARD ACCEPT", "-A FORWARD -j DOCKER-USER"],
    ["-P FORWARD DROP", "-A FORWARD -j DOCKER-FORWARD"],
  ]) {
    withFake(["iptables-nft"], { forward }, (fake) => {
      const result = fake.run(buildDockerForwardCompatCmds(rule));
      assert.equal(result.ok, true, result.output);
      assert.deepEqual(fake.chain, []);
      assert.equal(fake.writes.length, 0);
    });
  }
});

test("hosts without an iptables front end are left alone", () => {
  withFake([], {}, (fake) => {
    assert.equal(fake.run(buildDockerForwardCompatCmds(rule)).ok, true);
    assert.equal(fake.run(buildDockerForwardCompatCleanupCmds({ ruleId: 42, port: 22022, protocol: "both" })).ok, true);
  });
});

test("a single unsuffixed iptables front end is used when no explicit variants exist", () => {
  withFake(["iptables"], {}, (fake) => {
    assert.equal(fake.run(buildDockerForwardCompatCmds({ ...rule, protocol: "udp" })).ok, true);
    assert.equal(fake.chain.length, 2);
  });
});

test("an allowance that cannot be installed fails with a readable reason", () => {
  withFake(["iptables-nft"], { failWrites: true }, (fake) => {
    const result = fake.run(buildDockerForwardCompatCmds(rule));
    assert.equal(result.ok, false, "a failed install must never be reported as applied");
    assert.match(result.output, /\[docker-compat\] iptables-nft: .*rule 42.*22022\/tcp/);
    assert.deepEqual(fake.chain, []);
  });
});

test("a changed target is converged in place: the new allowances are added before the old ones are removed", () => {
  withFake(["iptables-nft"], {}, (fake) => {
    assert.equal(fake.run(buildDockerForwardCompatCmds(rule)).ok, true);
    const result = fake.run(buildDockerForwardCompatCmds({ ...rule, targetIp: "203.0.113.11" }));
    assert.equal(result.ok, true, result.output);
    const moved = { ip: "203.0.113.11", suffix: otherTargetTag };
    assert.deepEqual(fake.chain, [
      allowance("tcp", "in", moved), allowance("tcp", "out", moved), allowance("udp", "in", moved), allowance("udp", "out", moved),
    ]);
    const writes = fake.writes;
    assert.ok(writes.slice(4, 8).every((line) => / -[IA] DOCKER-USER /.test(line)), "the four replacements are installed first");
    assert.ok(/-restore /.test(writes[8]), "only then are the previous target's allowances removed");
  });
});

test("narrowing the protocol removes only the dropped protocol's allowances", () => {
  withFake(["iptables-nft"], {}, (fake) => {
    assert.equal(fake.run(buildDockerForwardCompatCmds(rule)).ok, true);
    assert.equal(fake.run(buildDockerForwardCompatCmds({ ...rule, protocol: "tcp" })).ok, true);
    assert.deepEqual(fake.chain, [allowance("tcp", "in"), allowance("tcp", "out")]);
  });
});

test("a previous owner of the same port and protocol is removed, a neighbour on another protocol is kept", () => {
  const previousOwner = [allowance("tcp", "in", { id: 7 }), allowance("tcp", "out", { id: 7 })];
  const neighbour = [allowance("udp", "in", { id: 9 }), allowance("udp", "out", { id: 9 })];
  withFake(["iptables-nft"], { dockerUser: [...previousOwner, ...neighbour] }, (fake) => {
    assert.equal(fake.run(buildDockerForwardCompatCmds({ ...rule, protocol: "tcp" })).ok, true);
    assert.deepEqual(fake.chain, [...neighbour, allowance("tcp", "in"), allowance("tcp", "out")]);
  });
});

test("rule cleanup removes only that rule's allowances and leaves other rules and administrator rules", () => {
  const admin = "-A DOCKER-USER -s 198.51.100.7/32 -j DROP";
  const other = [allowance("tcp", "in", { id: 420, port: 22023 }), allowance("tcp", "out", { id: 420, port: 22023 })];
  withFake(["iptables-nft"], { dockerUser: [admin, ...other] }, (fake) => {
    assert.equal(fake.run(buildDockerForwardCompatCmds(rule)).ok, true);
    const cleanup = fake.run(buildDockerForwardCompatCleanupCmds({ ruleId: 42, port: 22022, protocol: "both" }));
    assert.equal(cleanup.ok, true, cleanup.output);
    assert.deepEqual(fake.chain, [admin, ...other]);
  });
});

test("port cleanup removes one protocol and keeps the other for the same port", () => {
  withFake(["iptables-nft"], {}, (fake) => {
    assert.equal(fake.run(buildDockerForwardCompatCmds(rule)).ok, true);
    assert.equal(fake.run(buildDockerForwardCompatCleanupCmds({ port: 22022, protocol: "tcp" })).ok, true);
    assert.deepEqual(fake.chain, [allowance("udp", "in"), allowance("udp", "out")]);
  });
});

test("deletion is by rule specification in one transaction, never by position", () => {
  withFake(["iptables-nft"], {}, (fake) => {
    assert.equal(fake.run(buildDockerForwardCompatCmds(rule)).ok, true);
    assert.equal(fake.run(buildDockerForwardCompatCleanupCmds({ ruleId: 42, port: 22022, protocol: "both" })).ok, true);
    assert.equal(fake.log.some((line) => / -D DOCKER-USER \d+/.test(line)), false, "an index can shift when Docker or an administrator edits the chain concurrently");
    assert.ok(fake.log.some((line) => /^iptables-nft-restore --noflush --wait 5/.test(line)));
  });
});

test("cleanup reports allowances it cannot remove", () => {
  const owned = [allowance("tcp", "in")];
  withFake(["iptables-nft"], { dockerUser: owned, failDeletes: true }, (fake) => {
    const result = fake.run(buildDockerForwardCompatCleanupCmds({ ruleId: 42, port: 22022, protocol: "tcp" }));
    assert.equal(result.ok, false, "a stale allowance must never be reported as removed");
    assert.match(result.output, /\[docker-compat\] iptables-nft: could not remove/);
    assert.deepEqual(fake.chain, owned);
  });
});

test("IPv6 targets and unusable targets get no IPv4 allowance", () => {
  assert.deepEqual(buildDockerForwardCompatCmds({ ...rule, targetIp: "2001:db8::10" }), []);
  assert.deepEqual(buildDockerForwardCompatCmds({ ...rule, targetIp: "" }), []);
  assert.deepEqual(buildDockerForwardCompatCmds({ ...rule, targetPort: 0 }), []);
});

test("compatibility commands only read FORWARD and only edit DOCKER-USER", () => {
  const text = [
    ...buildDockerForwardCompatCmds(rule),
    ...buildDockerForwardCompatCleanupCmds({ ruleId: 42, port: 22022, protocol: "both" }),
  ].join("\n");
  const invocations = text.match(/"\$fwx_dc_\w+" -w 5 -[A-Za-z] \S+/g) ?? [];
  assert.ok(invocations.length > 0);
  for (const invocation of invocations) {
    assert.match(invocation, /-w 5 (-S (FORWARD|DOCKER-USER)|-[CIA] DOCKER-USER)$/, invocation);
  }
  assert.doesNotMatch(text, /flush ruleset|-j DROP|-j REJECT|-F |-X /);
  assert.doesNotMatch(text, /-D FORWARD|-D INPUT|-I FORWARD|-A FORWARD /);
  assert.match(text, /\*filter/);
});

test("allowances add no counters, so traffic attribution stays with the ForwardX table", () => {
  const text = buildDockerForwardCompatCmds(rule).join("\n");
  assert.doesNotMatch(text, /counter|-j LOG|-j MARK|-j CONNMARK|--set-mark/);
});

test("rebuilding a native nft rule converges its allowances in place, while removal still clears them", () => {
  const apply = buildNftForwardCmds(rule);
  const installs = apply.filter((command) => command.includes('fwx_dc_ensure "$fwx_dc_b"'));
  assert.equal(installs.length, 1);
  assert.match(installs[0], new RegExp(`fwx-docker-42-22022-tcp-in-${tag}`));
  assert.match(installs[0], new RegExp(`fwx-docker-42-22022-udp-out-${tag}`));
  // The pass that rebuilds the rule must not strip the allowances first: that is what would interrupt forwarding.
  assert.equal(apply.filter((command) => command.includes("fwx_dc_prune")).length, 1, "only the converging script prunes");
  const removal = buildNftCleanupCmds(rule).filter((command) => command.includes("fwx_dc_prune"));
  assert.equal(removal.length, 1, "removing a rule clears its allowances");
  assert.doesNotMatch(removal[0], /fwx_dc_ensure "\$fwx_dc_b"/);
  assert.match(buildManagedPortCleanupCmds(22022, "tcp").join("\n"), /fwx-docker-/);
  assert.doesNotMatch(buildNftForwardCmds({ ...rule, targetIp: "2001:db8::10" }).join("\n"), /fwx_dc_ensure "\$fwx_dc_b"/);
});
