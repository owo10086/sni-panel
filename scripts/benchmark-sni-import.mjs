import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { samples: { type: "string" }, output: { type: "string" }, prepare: { type: "boolean" }, batch: { type: "boolean" }, rounds: { type: "string", default: "3" } } });
assert.ok(values.samples && values.output, "Pass --samples <directory> and --output <json-file>; use --prepare only before business changes.");
const rounds = Number(values.rounds);
assert.ok(Number.isInteger(rounds) && rounds >= 3, "At least three rounds are required");
const samples = path.resolve(values.samples);
fs.mkdirSync(samples, { recursive: true });
const digest = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const harness = "server/test-support/sniImportHarness.mjs";
const scenarios = [{ name: "small", existingCount: 0, count: 12 }, { name: "empty", existingCount: 0, count: 56 }, { name: "existing", existingCount: 56, count: 56 }];
function run(mode, database, existingCount, count) {
  const result = spawnSync(process.execPath, ["--import", "tsx", harness, mode, String(existingCount), String(count)], {
    cwd: process.cwd(), encoding: "utf8", timeout: 600_000, maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: database, FORWARDX_LOG_DIR: path.join(path.dirname(database), "logs"), FORWARDX_BATCH_IMPORT: values.batch ? "1" : "0" },
  });
  assert.equal(result.status, 0, result.error?.message || result.stderr + result.stdout);
  if (mode === "prepare") return;
  const line = result.stdout.split("\n").find(line => line.startsWith("SNI_IMPORT_RESULT="));
  assert.ok(line, "Benchmark must emit its result");
  return JSON.parse(line.slice("SNI_IMPORT_RESULT=".length));
}
const manifestFile = path.join(samples, "manifest.json");
if (values.prepare) {
  assert.ok(!fs.existsSync(manifestFile), "Samples already exist; reuse them without --prepare");
  const manifest = {};
  for (const existingCount of [0, 56]) {
    const database = path.join(samples, "seed-" + existingCount + ".db");
    assert.ok(!fs.existsSync(database), "Refusing to replace an existing sample");
    run("prepare", database, existingCount, 0);
    manifest[existingCount] = digest(database);
  }
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + "\n");
}
const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
const record = {
  measuredAt: new Date().toISOString(), commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  node: process.version, platform: process.platform, architecture: process.arch,
  importMode: values.batch ? "server-batch" : "six-concurrent-single-creates",
  ruleRouterSha256: digest("server/routers/rules.crud.ts"), samples: manifest,
  notificationReceiver: "immediate SSE response; no network backpressure", scenarios: [],
};
for (const scenario of scenarios) {
  const sample = path.join(samples, "seed-" + scenario.existingCount + ".db");
  assert.equal(digest(sample), manifest[scenario.existingCount], "Starting sample changed");
  const measurements = [];
  for (let round = 1; round <= rounds; round++) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-sni-import-benchmark-"));
    try {
      const database = path.join(directory, "test.db");
      fs.copyFileSync(sample, database);
      const measurement = run("benchmark", database, scenario.existingCount, scenario.count);
      measurements.push({ round, ...measurement });
      console.log(scenario.name + " round " + round + ": " + measurement.durationMs + " ms");
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  }
  const sorted = measurements.map(item => item.durationMs).sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const medianMs = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  record.scenarios.push({ ...scenario, medianMs, measurements });
}
fs.mkdirSync(path.dirname(path.resolve(values.output)), { recursive: true });
fs.writeFileSync(values.output, JSON.stringify(record, null, 2) + "\n");
console.log("Saved " + values.output);
