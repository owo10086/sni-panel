import assert from "node:assert/strict";
import test from "node:test";
import {
  getSniRuntimeGroupStatus,
  recordSniRuntimeApplyResult,
  recordSniRuntimeSnapshot,
} from "./sniRuntimeObservability";

const report = (overrides: Record<string, unknown> = {}) => ({
  port: 24000,
  ruleId: 101,
  sni: "api.example.com",
  sniRouteVersion: 7,
  ready: true,
  ...overrides,
});

test("a snapshot records the version and applied domains per splitter port", () => {
  recordSniRuntimeSnapshot(11, [
    report({ sniUnmatchedConnections: 4 }),
    report({ ruleId: 202, sni: "Web.Example.com.", sniRouteVersion: 7 }),
    report({ port: 24001, ruleId: 303, sni: "other.example.com", sniRouteVersion: 3 }),
  ]);

  const first = getSniRuntimeGroupStatus(11, 24000);
  assert.equal(first?.currentVersion, 7);
  assert.equal(first?.unmatchedConnections, 4);
  assert.deepEqual(first?.appliedDomains, ["api.example.com", "web.example.com"]);
  assert.deepEqual(first?.appliedRuleIds, [101, 202]);
  assert.equal(getSniRuntimeGroupStatus(11, 24001)?.currentVersion, 3);
});

test("ports missing from a later snapshot are zeroed instead of hanging the caller", () => {
  const ports = [24000, 24001, 24002];
  recordSniRuntimeSnapshot(12, ports.map((port, index) => report({
    port,
    ruleId: 100 + index,
    sni: `host-${index}.example.com`,
  })));
  for (const port of ports) {
    assert.equal(getSniRuntimeGroupStatus(12, port)?.currentVersion, 7, `port ${port} was not recorded`);
  }

  // Only one of the three splitter ports is still reported. The other two must
  // be marked as no longer applied — and the snapshot must return at all.
  recordSniRuntimeSnapshot(12, [report({ port: 24000, ruleId: 100, sni: "host-0.example.com" })]);

  assert.equal(getSniRuntimeGroupStatus(12, 24000)?.currentVersion, 7);
  for (const port of [24001, 24002]) {
    const status = getSniRuntimeGroupStatus(12, port);
    assert.equal(status?.currentVersion, 0, `port ${port} still reports a live version`);
    assert.deepEqual(status?.appliedDomains, []);
    assert.deepEqual(status?.appliedRuleIds, []);
  }
});

test("an empty snapshot clears every port of that host and leaves other hosts alone", () => {
  recordSniRuntimeSnapshot(13, [report({ port: 24010 })]);
  recordSniRuntimeSnapshot(14, [report({ port: 24010 })]);

  recordSniRuntimeSnapshot(13, []);

  assert.equal(getSniRuntimeGroupStatus(13, 24010)?.currentVersion, 0);
  assert.equal(getSniRuntimeGroupStatus(14, 24010)?.currentVersion, 7);
});

test("routes the splitter has not brought up do not count as applied", () => {
  recordSniRuntimeSnapshot(15, [report({ port: 24020, ready: false })]);

  const notReady = getSniRuntimeGroupStatus(15, 24020);
  assert.equal(notReady?.currentVersion, 7);
  assert.deepEqual(notReady?.appliedDomains, []);
  assert.deepEqual(notReady?.appliedRuleIds, []);

  recordSniRuntimeSnapshot(15, [
    report({ port: 24020, ready: false }),
    report({ port: 24020, ruleId: 202, sni: "live.example.com" }),
  ]);

  const mixed = getSniRuntimeGroupStatus(15, 24020);
  assert.deepEqual(mixed?.appliedDomains, ["live.example.com"]);
  assert.deepEqual(mixed?.appliedRuleIds, [202]);
});

test("a failed apply surfaces its reason without dropping the applied domains", () => {
  recordSniRuntimeSnapshot(16, [report({ port: 24030 })]);
  recordSniRuntimeApplyResult({ hostId: 16, splitterPort: 24030, success: false, message: "分流表校验失败" });

  const failed = getSniRuntimeGroupStatus(16, 24030);
  assert.equal(failed?.lastConfigError, "分流表校验失败");
  assert.deepEqual(failed?.appliedDomains, ["api.example.com"]);

  recordSniRuntimeApplyResult({ hostId: 16, splitterPort: 24030, success: true });
  assert.equal(getSniRuntimeGroupStatus(16, 24030)?.lastConfigError, "");
});
