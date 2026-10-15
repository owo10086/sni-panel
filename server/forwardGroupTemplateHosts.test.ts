import assert from "node:assert/strict";
import test from "node:test";
import {
  planTemplateHostRepairs,
  type TemplateHostCandidate,
} from "./forwardGroupTemplateHosts";

const row = (
  patch: Partial<TemplateHostCandidate> = {},
): TemplateHostCandidate => ({
  ruleId: 100, groupId: 10, storedHostId: 1,
  groupMode: "failover", externalEntry: false,
  memberId: 102, hostId: 2, priority: 0, enabled: true,
  ...patch,
});

test("removed host transfers to a remaining configured member", () => {
  assert.deepEqual(planTemplateHostRepairs([row()]), [
    { ruleId: 100, groupId: 10, fromHostId: 1, toHostId: 2 },
  ]);
});

test("a still configured owner is retained without rewriting", () => {
  assert.deepEqual(planTemplateHostRepairs([
    row({ hostId: 2 }), row({ memberId: 103, hostId: 1, priority: 1 }),
  ]), []);
});

test("configured disabled members still provide a stable saved owner", () => {
  assert.equal(planTemplateHostRepairs([row({ enabled: false })])[0].toHostId, 2);
});

test("an external-entry chain uses entry-group candidates", () => {
  assert.equal(planTemplateHostRepairs([
    row({ groupMode: "chain", externalEntry: true, hostId: 5 }),
  ])[0].toHostId, 5);
});

test("an ordinary chain uses its first configured enabled hop", () => {
  assert.equal(planTemplateHostRepairs([
    row({ groupMode: "chain", hostId: 3, priority: 1, memberId: 103 }),
    row({ groupMode: "chain", hostId: 2, priority: 0 }),
  ])[0].toHostId, 2);
});

test("input order and invalid candidate ids do not change the result", () => {
  assert.deepEqual(planTemplateHostRepairs([
    row({ hostId: 0 }), row({ hostId: 3, memberId: 103, priority: 1 }), row(),
  ]), planTemplateHostRepairs([row()]));
});

test("equal priorities use member ids and enabled candidates come first", () => {
  assert.equal(planTemplateHostRepairs([
    row({ hostId: 4, memberId: 104, enabled: false, priority: -1 }),
    row({ hostId: 3, memberId: 103 }),
    row({ hostId: 2, memberId: 102 }),
  ])[0].toHostId, 2);
});

test("empty candidates do not authorize deleting a rule", () => {
  assert.deepEqual(planTemplateHostRepairs([]), []);
});

test("reversing valid candidates preserves the selected owner", () => {
  const candidates = [row(), row({ hostId: 3, memberId: 103, priority: 1 })];
  assert.deepEqual(planTemplateHostRepairs([...candidates].reverse()), planTemplateHostRepairs(candidates));
});
