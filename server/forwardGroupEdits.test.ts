import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

for (const [scenario, description] of [
  ["baseline", "ordinary host failover preserves unchanged DNS after name-only saves and repeated runtime reports"],
  ["add-rule", "ordinary rules added by an administrator become eligible as soon as their runtime is confirmed"],
  ["new-group", "a new ordinary group publishes its first confirmed entry without recovery delay"],
  ["edit-rule", "ordinary rule edits restore entry eligibility immediately after confirmation"],
  ["delete-rule", "deleting an ordinary rule preserves the remaining entry qualification"],
  ["delete-billing-concurrency", "ordinary template deletion does not hold a database transaction while waiting for traffic billing"],
  ["retirement-billing-concurrency", "ordinary retirement does not hold the group lock while waiting for traffic billing"],
  ["domain", "editing only the ordinary group domain publishes the ready entry immediately"],
  ["new-member", "a newly added ordinary backup can take over immediately after confirmation"],
  ["edit-timeout", "ordinary deployment timeout becomes a real failure at the original failure deadline"],
  ["continuous-edit", "continuous ordinary rule edits cannot postpone a deployment failure or erase recovery"],
  ["independent-deadlines", "ordinary rules added in later edits retain independent deployment deadlines"],
  ["agent-restart", "an ordinary Agent restart still requires recovery across subsequent administrator edits"],
  ["agent-offline", "an ordinary Agent coming back online still requires recovery across subsequent administrator edits"],
  ["explicit-failure", "explicit ordinary apply failure still requires recovery after an administrator adjustment"],
  ["unrelated-failure", "domain-only edits do not excuse unrelated ordinary runtime failure"],
  ["reused-adjustment", "a completed administrator adjustment cannot excuse later ordinary runtime failure"],
  ["confirmed-adjustment-drift", "ordinary heartbeat confirmation ends adjustment before the next health sweep"],
  ["confirmed-adjustment-status-drift", "ordinary status confirmation ends adjustment before the next health sweep"],
  ["transient-adjustment-drift", "ordinary confirmed listener loss and recovery before one sweep still require recovery observation"],
  ["confirmed-adjustment-delayed-sweep", "ordinary confirmation before the deployment deadline remains immediate when the health sweep runs later"],
  ["remove-current", "removing a ready current ordinary entry switches immediately and retains it for one TTL"],
  ["disable-current", "disabling the current ordinary entry uses the same handover and TTL"],
  ["remove-redeploy", "removing the current ordinary entry keeps forwarding until replacement reconfirms"],
  ["fallback", "an unready replacement cannot retain a removed ordinary entry after five minutes"],
  ["ddns-failure", "DDNS failures retain removed ordinary forwarding until the original five-minute deadline"],
  ["old-ttl", "lowering TTL at handover preserves the previous successful DNS cache period"],
  ["late-switch", "a late successful handover uses its full TTL past the five-minute fallback"],
  ["reorder-pending", "manual ordinary reorder survives an unready preferred entry with auto failback disabled"],
  ["reorder-ddns-failure", "a failed DNS publish does not consume a delayed manual reorder"],
  ["reorder-recovery", "manual reorder waits for genuine ordinary runtime recovery before takeover"],
  ["reorder-edit-form", "editing the ordinary member order preserves the same delayed manual takeover intent"],
  ["reorder-override", "a later explicit ordinary reorder replaces an earlier unfulfilled takeover"],
  ["reorder-cancel-target", "removing an ordinary reorder target cancels its old takeover intent"],
  ["remove-backup", "removing a noncurrent ordinary backup withdraws its configuration immediately"],
  ["remove-only", "disabling the only ordinary entry withdraws its configuration immediately"],
  ["no-domain", "ordinary groups without a domain immediately withdraw removed forwarding"],
  ["ddns-disabled", "ordinary groups with DDNS disabled immediately withdraw removed forwarding"],
  ["disable-group", "disabling a whole ordinary group immediately withdraws retained forwarding"],
  ["delete-group", "deleting a whole ordinary group immediately withdraws retained forwarding"],
  ["readd-host", "readding a retiring ordinary host replaces its retained child without duplicate listeners"],
  ["tcp-handover", "real TCP connections through expected local listeners reach the backend before switch and through the old DNS TTL"],
  ["renamed-retirement", "publishing only a renamed domain does not claim the retiring old DNS identity switched"],
  ["stale-retirement", "a provider response that fails current qualification cannot start ordinary retirement TTL"],
  ["provider-retirement", "a queued DDNS request cannot start old provider retirement TTL after publishing through another provider"],
]) test(description, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-ordinary-edits-"));
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "server/test-support/ordinaryForwardGroupEditsHarness.mjs", scenario], {
      cwd: process.cwd(), env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "test.db") }, encoding: "utf8", timeout: 150_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

for (const [scenarios, description] of [
  [["retirement-prepare", "retirement-resume"], "a real panel restart preserves the original ordinary retirement identity and TTL deadline"],
  [["reorder-prepare", "reorder-resume"], "a real panel restart preserves a delayed manual ordinary reorder and rebuilds recovery evidence"],
] as const) test(description, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-ordinary-restart-"));
  try {
    for (const scenario of scenarios) {
      const result = spawnSync(process.execPath, ["--import", "tsx", "server/test-support/ordinaryForwardGroupEditsHarness.mjs", scenario], {
        cwd: process.cwd(), env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "test.db") }, encoding: "utf8", timeout: 150_000,
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
