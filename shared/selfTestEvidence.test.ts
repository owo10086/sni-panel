import assert from "node:assert/strict";
import test from "node:test";
import { selfTestEvidence, withSelfTestEvidence } from "./selfTestEvidence";

const row = (overrides: Record<string, unknown>) => ({
  id: 1, ruleId: 5, status: "success", listenOk: true, targetReachable: true, forwardOk: true, latencyMs: 12, ...overrides,
});

test("a reachable target is not evidence that the external path through the entry works", () => {
  const evidence = selfTestEvidence(row({}));
  assert.equal(evidence.target, "reachable");
  assert.equal(evidence.externalPath, "unverified");
});

test("an unreachable target and an unverified path are different facts", () => {
  const evidence = selfTestEvidence(row({ status: "failed", targetReachable: false, listenOk: true, forwardOk: false, latencyMs: null }));
  assert.equal(evidence.target, "unreachable");
  assert.equal(evidence.externalPath, "unverified", "not having tested the path is neither success nor failure of it");
});

test("pending, running and Agent-less timeouts do not claim a target result", () => {
  assert.equal(selfTestEvidence(row({ status: "pending", targetReachable: false })).target, "pending");
  assert.equal(selfTestEvidence(row({ status: "running", targetReachable: false })).target, "pending");
  assert.equal(selfTestEvidence(row({ status: "timeout", targetReachable: false })).target, "unknown");
});

test("a timed out overall test still reports a target that did answer", () => {
  assert.equal(selfTestEvidence(row({ status: "timeout", targetReachable: true })).target, "reachable");
});

test("old records that stored unconditional success flags are reinterpreted by their evidence", () => {
  // Before this contract every successful probe was written with listenOk and forwardOk set.
  const legacy = withSelfTestEvidence(row({ listenOk: 1, forwardOk: 1 }));
  assert.equal(legacy.forwardOk, false, "no earlier probe ever sent traffic through the entry from outside");
  assert.equal(legacy.listenOk, false, "a direct target probe never touched the entry listener");
  assert.equal(legacy.evidence.target, "reachable");
  assert.equal(legacy.evidence.externalPath, "unverified");
  assert.equal(legacy.latencyMs, 12, "the target latency is kept");
  assert.equal(legacy.status, "success", "the target result keeps its status");
});

test("an entry-port probe keeps the listener result it really measured", () => {
  const meta = JSON.stringify({ kind: "forward-via-tunnel-entry", tunnelId: 3, entryIp: "198.51.100.5", entrySourcePort: 443 });
  const entry = withSelfTestEvidence(row({ requestMessage: meta, listenOk: true }));
  assert.equal(entry.listenOk, true);
  assert.equal(entry.forwardOk, false);
  assert.equal(entry.evidence.externalPath, "unverified");
  const failedEntry = withSelfTestEvidence(row({ requestMessage: meta, status: "failed", listenOk: false, targetReachable: false }));
  assert.equal(failedEntry.listenOk, false);
});

test("rows without any stored result stay absent", () => {
  assert.equal(withSelfTestEvidence(undefined), undefined);
  assert.equal(withSelfTestEvidence(null), null);
});
