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

/**
 * A stateful stand-in for an iptables front end. It models only what the
 * compatibility scripts rely on: the FORWARD policy and jumps, plus an ordered
 * DOCKER-USER chain addressed by rule specification and position.
 */
class FakeIptables {
  readonly directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-fake-iptables-"));

  constructor(private readonly binaries: string[], options: { forward?: string[]; dockerUser?: string[]; failWrites?: boolean; failDeletes?: boolean } = {}) {
    fs.mkdirSync(path.join(this.directory, "bin"));
    this.write("forward", options.forward ?? ["-P FORWARD DROP", "-A FORWARD -j DOCKER-USER", "-A FORWARD -j DOCKER-FORWARD"]);
    this.write("chain", options.dockerUser ?? []);
    this.write("log", []);
    const script = [
      "#!/bin/sh",
      `state=${JSON.stringify(this.directory)}`,
      'echo "$(basename "$0") $*" >> "$state/log"',
      "[ \"$1\" = -w ] && shift 2",
      'op=$1; chain=$2; shift 2',
      `if [ -f "$state/fail" ] && { [ "$op" = -I ] || [ "$op" = -A ]; }; then exit 4; fi`,
      `if [ -f "$state/faildelete" ] && [ "$op" = -D ]; then exit 5; fi`,
      'case "$op $chain" in',
      '  "-S FORWARD") cat "$state/forward" ;;',
      '  "-S DOCKER-USER") echo "-N DOCKER-USER"; cat "$state/chain" ;;',
      '  "-C DOCKER-USER") grep -qxF -- "-A DOCKER-USER $*" "$state/chain" ;;',
      '  "-A DOCKER-USER") echo "-A DOCKER-USER $*" >> "$state/chain" ;;',
      '  "-I DOCKER-USER") n=$1; shift; awk -v n="$n" -v rule="-A DOCKER-USER $*" \'NR==n {print rule} {print}\' "$state/chain" > "$state/chain.new" && mv "$state/chain.new" "$state/chain" ;;',
      '  "-D DOCKER-USER") awk -v n="$1" \'NR!=n\' "$state/chain" > "$state/chain.new" && mv "$state/chain.new" "$state/chain" ;;',
      "  *) exit 1 ;;",
      "esac",
      "",
    ].join("\n");
    for (const binary of binaries) {
      const file = path.join(this.directory, "bin", binary);
      fs.writeFileSync(file, script, { mode: 0o755 });
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
    return fs.readFileSync(path.join(this.directory, "log"), "utf8");
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

test("DOCKER-USER allowances are scoped to the rule, original port, protocol, target and direction", () => {
  withFake(["iptables-nft"], {}, (fake) => {
    const result = fake.run(buildDockerForwardCompatCmds(rule));
    assert.equal(result.ok, true, result.output);
    assert.deepEqual(fake.chain, [
      "-A DOCKER-USER -p tcp -d 203.0.113.10 --dport 443 -m conntrack --ctorigdstport 22022 -m comment --comment fwx-docker-42-22022-tcp-in -j ACCEPT",
      "-A DOCKER-USER -p tcp -s 203.0.113.10 --sport 443 -m conntrack --ctorigdstport 22022 --ctdir REPLY --ctstate ESTABLISHED,RELATED -m comment --comment fwx-docker-42-22022-tcp-out -j ACCEPT",
      "-A DOCKER-USER -p udp -d 203.0.113.10 --dport 443 -m conntrack --ctorigdstport 22022 -m comment --comment fwx-docker-42-22022-udp-in -j ACCEPT",
      "-A DOCKER-USER -p udp -s 203.0.113.10 --sport 443 -m conntrack --ctorigdstport 22022 --ctdir REPLY --ctstate ESTABLISHED,RELATED -m comment --comment fwx-docker-42-22022-udp-out -j ACCEPT",
    ]);
  });
});

test("repeated application keeps one copy of each allowance", () => {
  withFake(["iptables-nft"], {}, (fake) => {
    for (let round = 0; round < 3; round += 1) {
      assert.equal(fake.run(buildDockerForwardCompatCmds(rule)).ok, true);
    }
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
      assert.doesNotMatch(fake.log, / -[IA] /);
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

test("rule cleanup removes only that rule's allowances and leaves other rules and administrator rules", () => {
  const admin = "-A DOCKER-USER -s 198.51.100.7/32 -j DROP";
  withFake(["iptables-nft"], { dockerUser: [admin] }, (fake) => {
    const other = { id: 420, sourcePort: 22023, targetIp: "203.0.113.10", targetPort: 443, protocol: "both" };
    assert.equal(fake.run(buildDockerForwardCompatCmds(rule)).ok, true);
    assert.equal(fake.run(buildDockerForwardCompatCmds(other)).ok, true);
    const cleanup = fake.run(buildDockerForwardCompatCleanupCmds({ ruleId: 42, port: 22022, protocol: "both" }));
    assert.equal(cleanup.ok, true, cleanup.output);
    const chain = fake.chain;
    assert.equal(chain[0], admin);
    assert.equal(chain.length, 5);
    assert.ok(chain.slice(1).every((line) => line.includes("fwx-docker-420-22023-")), chain.join("\n"));
  });
});

test("port cleanup removes one protocol and keeps the other for the same port", () => {
  withFake(["iptables-nft"], {}, (fake) => {
    assert.equal(fake.run(buildDockerForwardCompatCmds(rule)).ok, true);
    assert.equal(fake.run(buildDockerForwardCompatCleanupCmds({ port: 22022, protocol: "tcp" })).ok, true);
    const chain = fake.chain;
    assert.equal(chain.length, 2);
    assert.ok(chain.every((line) => line.includes("-udp-")), chain.join("\n"));
  });
});

test("cleanup reports allowances it cannot remove", () => {
  const owned = ["-A DOCKER-USER -m comment --comment fwx-docker-42-22022-tcp-in -j ACCEPT"];
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
    assert.match(invocation, /-w 5 (-S (FORWARD|DOCKER-USER)|-[CIAD] DOCKER-USER)$/, invocation);
  }
  assert.doesNotMatch(text, /flush ruleset|-j DROP|-j REJECT/);
});

test("native nft forwarding installs and removes the allowances with the rule", () => {
  const apply = buildNftForwardCmds(rule).join("\n");
  assert.match(apply, /fwx-docker-42-22022-tcp-in/);
  assert.match(apply, /fwx-docker-42-22022-udp-out/);
  // The pass that rebuilds the rule must clean the previous allowances first.
  assert.ok(apply.indexOf("could not remove ForwardX allowance") < apply.indexOf('fwx_dc_ensure "$fwx_dc_b"'), "cleanup precedes install");
  assert.match(buildNftCleanupCmds(rule).join("\n"), /fwx-docker-/);
  assert.match(buildManagedPortCleanupCmds(22022, "tcp").join("\n"), /fwx-docker-/);
  assert.doesNotMatch(buildNftForwardCmds({ ...rule, targetIp: "2001:db8::10" }).join("\n"), /fwx_dc_ensure "\$fwx_dc_b"/);
});
