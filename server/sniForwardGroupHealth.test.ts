import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

for (const [scenario, description] of [
  ["member-release", "removed SNI group hosts retain routes through the DNS switch and fixed TTL"],
  ["member-release-ddns-error", "DNS failure retains the old SNI entrance until the original fallback deadline"],
  ["configuration", "SNI entrance selection checks all configurations and ignores destination results"],
  ["adjustment-fault-apply", "an apply failure between configuration reports still requires SNI recovery observation"],
  ["adjustment-fault-missing", "an unrelated missing SNI domain during an adjustment still requires recovery observation"],
  ["adjustment-fault-restart", "an Agent restart during a SNI adjustment still requires recovery observation"],
  ["adjustment-fault-reconnect", "an Agent reconnect during a SNI adjustment still requires recovery observation"],
  ["adjustment-fault-expiry", "an expired SNI confirmation cannot gain an adjustment exemption"],
  ["windows", "SNI, China health and recovery windows advance independently through Agent reports"],
  ["lifecycle", "SNI confirmation expiry, reconnect, process restart and unchanged reports use current evidence"],
  ["ddns", "SNI DDNS reconciles renamed domains, retries failures and rejects obsolete provider responses"],
  ["backup", "recently recovered SNI backups wait with failback on or off and respond to setting changes"],
  ["mixed", "mixed failover groups ignore ordinary destination failures but retain entry runtime and health gates"],
  ["failure-settings", "changing failure delays replaces pending deadlines and reevaluates automatically"],
  ["third-backup", "a qualified third entrance wins while the preferred backup is recovering"],
  ["china-expiry", "expired China probes block selection independently of fresh SNI confirmations"],
  ["recovery-expiry", "confirmation expiry discards unfinished recovery instead of combining healthy segments"],
  ["coalesced-restart", "coalesced heartbeats invalidate runtime confirmation after an Agent restart"],
  ["concurrent-restart", "an old in-flight heartbeat cannot restore runtime confirmation after a new process arrives"],
  ["brief-missing", "a briefly missing rule resets recovery even when runtime reports are coalesced"],
  ["deleted-domain", "deleted domains still present in an old table block entrance readiness"],
  ["clockless-slow", "clockless reports with a slow Agent clock preserve reconnect and late-report protections"],
  ["clockless-fast", "clockless reports with a fast Agent clock preserve reconnect and late-report protections"],
  ["clockless-unknown", "unknown Agent clocks require a new session receipt, full runtime and current China evidence"],
  ["clockless-backward", "an Agent clock moving backward still permits verified current recovery"],
  ["apply-failure", "failed splitter apply receipts switch automatically and require recovery observation"],
  ["notifications", "automatic switch notifications and events follow provider success and manual sync semantics"],
  ["ddns-current", "an in-flight DDNS refresh requires the current entrance to finish recovery again"],
  ["ddns-failback-disabled", "disabling failback during a provider request preserves the healthy backup"],
  ["pending-normal", "missing ordinary destination reports do not block a mixed failover entrance"],
  ["pending-china", "missing China reports have a fixed waiting deadline despite continuous runtime reports"],
  ["entry-mixed-scope", "multi-entry groups keep ordinary destination gating outside the host failover policy"],
]) test(description, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-sni-health-"));
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "server/test-support/sniForwardGroupHealthHarness.mjs", scenario], {
      cwd: process.cwd(), env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "test.db") }, encoding: "utf8", timeout: 150_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a real panel process restart rebuilds missing history and waits before failback", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-sni-restart-"));
  try {
    for (const scenario of ["restart-prepare", "restart-resume"]) {
      const result = spawnSync(process.execPath, ["--import", "tsx", "server/test-support/sniForwardGroupHealthHarness.mjs", scenario], {
        cwd: process.cwd(), env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "test.db") }, encoding: "utf8", timeout: 150_000,
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a panel restart replaces a current entrance that stays online without reconfirming its runtime", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-sni-restart-missing-"));
  try {
    for (const scenario of ["restart-prepare", "restart-resume"]) {
      const result = spawnSync(process.execPath, ["--import", "tsx", "server/test-support/sniForwardGroupHealthHarness.mjs", scenario], {
        cwd: process.cwd(),
        env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "test.db"), FORWARDX_TEST_RESTART_CURRENT_MISSING: "1" },
        encoding: "utf8",
        timeout: 150_000,
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
