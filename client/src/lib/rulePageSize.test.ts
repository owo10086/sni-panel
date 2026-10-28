import assert from "node:assert/strict";
import test from "node:test";
import { parseRulePageSize } from "./rulePageSize";

test("rule page size migrates legacy values upward before validating shared tiers", () => {
  for (const [legacy, expected] of [["12", 20], ["24", 50], ["36", 50], ["48", 50]]) {
    assert.equal(parseRulePageSize(legacy), expected);
  }
  for (const size of [20, 50, 100, 200, 500, 1000]) {
    assert.equal(parseRulePageSize(String(size)), size);
  }
});

test("missing, invalid and unsupported rule page sizes default to 20", () => {
  for (const value of [null, undefined, "", "invalid", "0", "-1", "21", "1001", "Infinity", "12.5"]) {
    assert.equal(parseRulePageSize(value), 20);
  }
});
