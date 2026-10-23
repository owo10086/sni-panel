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

test("ordinary users can import ordinary rules in one batch with complete entry configurations", () => {
  verifyBatchImport("import-ordinary");
});

test("personal groups cover ordinary and SNI single/batch saves without changing ordinary all", () => {
  verifyBatchImport("personal-groups");
});

test("batch imports preserve manual fixed ports and retry only ordinary file port conflicts", () => {
  verifyBatchImport("import-ports");
});

test("mixed imports use original file order for quota and port competition and release failed items", () => {
  verifyBatchImport("import-order");
});

test("mixed imports roll back ordinary and SNI candidates together on final save and commit failures", () => {
  verifyBatchImport("import-final-failure");
});

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

test("SNI batch cleanup and multi-user traffic reports finish without waiting on each other", () => {
  verifyBatchImport("batch-billing-concurrency");
});

for (const kind of ["port", "chain", "tunnel"]) {
  test(kind + " SNI batch removes failed writes and rolls back final commit failures without changing old configuration", () => {
    verifyBatchImport("batch-failure-" + kind);
  });
}

test("SNI batch import returns saved results when notification delivery disconnects", () => {
  verifyBatchImport("batch-notification-failure");
});

for (const kind of ["port", "chain", "tunnel"]) {
  test(kind + " mixed imports save ordinary protocols alongside complete SNI configurations", () => {
    verifyBatchImport("import-resource-" + kind);
  });
}

test("ordinary batches coordinate with single and mixed creates and recheck changed entry members", () => {
  verifyBatchImport("import-concurrency");
});

for (const kind of ["port", "chain", "tunnel"]) {
  test(kind + " mixed imports isolate failed writes and roll back both kinds on commit failure", () => {
    verifyBatchImport("import-failure-" + kind);
  });
}

test("ordinary batch rules preserve managed limits and count the first traffic reports exactly once", () => {
  verifyBatchImport("import-usage");
});

test("all five webpage input combinations make one real batch request and save complete configurations", () => {
  verifyBatchImport("import-web");
});

test("an invalid first item cannot narrow coordination for later valid tunnel rules", () => {
  verifyBatchImport("import-leading-failure");
});

for (const kind of ["chain", "tunnel"]) {
  test("entry member removal withdraws real " + kind + " configurations", () => {
    verifyBatchImport("member-release-entry-" + kind);
  });
}
