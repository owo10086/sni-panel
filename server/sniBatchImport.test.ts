import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function verifyBatchImport(scenario: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-sni-batch-import-"));
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "server/test-support/sniImportHarness.mjs", scenario], {
      cwd: process.cwd(), encoding: "utf8", timeout: 120_000,
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "test.db"), FORWARDX_LOG_DIR: path.join(directory, "logs") },
    });
    assert.equal(result.status, 0, result.error?.message || result.stderr + result.stdout);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("SNI batch import saves complete configurations on three failover entries and preserves confirmed routes", () => {
  verifyBatchImport("batch-group");
});

test("SNI batch import removes failed item writes at early and late positions while keeping other successes", () => {
  verifyBatchImport("batch-item-failure");
});

test("SNI batch import rolls back all new rules if final member saving fails and keeps the old confirmed configuration", () => {
  verifyBatchImport("batch-final-failure");
});

for (const kind of ["port", "chain", "tunnel"]) {
  test(kind + " SNI batch import preserves shared listeners, partial results and complete entry/exit configurations", () => {
    verifyBatchImport("batch-" + kind);
  });
}

test("SNI batch creation preserves managed permissions, first and repeated traffic, rate limits and expiry", () => {
  verifyBatchImport("batch-limits");
});

test("SNI batch import preserves owner permissions, input bounds and shared-port quotas", () => {
  verifyBatchImport("batch-permissions");
});

test("SNI batches coordinate with ordinary saves and recheck changed entries after waiting", () => {
  verifyBatchImport("batch-concurrency");
});

for (const kind of ["port", "chain", "tunnel"]) {
  test(kind + " SNI batch removes failed writes and rolls back final commit failures without changing old configuration", () => {
    verifyBatchImport("batch-failure-" + kind);
  });
}

test("SNI batch import returns saved results when notification delivery disconnects", () => {
  verifyBatchImport("batch-notification-failure");
});
