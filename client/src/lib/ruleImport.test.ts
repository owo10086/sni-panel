import assert from "node:assert/strict";
import test from "node:test";
import { runRuleImport } from "./ruleImport";
import { parseManualBulkImportText, parseRuleTransferFile, parseSniBulkImportText, formatManualBulkImportRuleLine } from "./ruleTransfer";

test("ordinary, SNI and mixed file imports use one save boundary and preserve original results", async () => {
  const parsed = parseSniBulkImportText("first#first.example.test#203.0.113.1#443\nsecond#second.example.test#203.0.113.2#443", 18443);
  assert.equal(parsed.ok, true);
  const ordinary = { ...parsed.rules[0], name: "ordinary", sni: undefined, sourcePort: 18444 };
  const imported = parseRuleTransferFile({ kind: "forwardx.forward-rules", version: 1, rules: [parsed.rules[0], ordinary, parsed.rules[1]] });
  assert.equal(imported.ok, true);
  if (!imported.ok) return;
  for (const items of [[ordinary], parsed.rules, imported.file.rules]) {
    const submissions: unknown[] = [];
    const result = await runRuleImport(items, {
      createBatch: async (submitted, options) => {
        submissions.push({ submitted, options });
        return { results: submitted.map((_, index) => index === 1 ? { status: "rejected" as const, reason: "item failed" } : { status: "fulfilled" as const, value: { id: index + 1 } }) };
      },
    }, { retryPortConflicts: true });
    assert.deepEqual(submissions, [{ submitted: items, options: { retryPortConflicts: true } }]);
    assert.deepEqual(result.map(row => row.item), items);
    assert.equal(result[0].status, "fulfilled");
    if (items.length > 1) assert.equal(result[1].status, "rejected");
  }
});

test("a final save failure leaves every mixed item available for retry", async () => {
  const items = [{ name: "ordinary", sni: null }, { name: "SNI", sni: "api.example.test" }];
  const failure = new Error("all new writes rolled back");
  const results = await runRuleImport(items, { createBatch: async () => { throw failure; } });
  assert.deepEqual(results, items.map(item => ({ item, status: "rejected", reason: failure })));
});

test("manual imports keep source lines and send fixed-port priority without reordering input", async () => {
  const defaults = { forwardType: "iptables", protocol: "both" } as const;
  const parsed = parseManualBulkImportText("example.net:443\n\n失败名称#17500# example.com #443\n成功#17501#203.0.113.20#80", defaults);
  assert.equal(parsed.ok, true);
  const results = await runRuleImport(parsed.rules, {
    createBatch: async (items, options) => {
      assert.deepEqual(items.map(item => item.sourcePort), [0, 17500, 17501]);
      assert.deepEqual(options, { fixedPortFirst: true });
      return { results: [{ status: "fulfilled", value: { id: 2, sourcePort: 17502 } }, { status: "rejected", reason: "port is occupied" }, { status: "fulfilled", value: { id: 1, sourcePort: 17501 } }] };
    },
  }, { fixedPortFirst: true });
  const failed = results.filter(row => row.status === "rejected").map(row => row.item);
  assert.equal(failed[0].sourceLineNumber, 3);
  assert.equal(failed.map(formatManualBulkImportRuleLine).join("\n"), "失败名称#17500# example.com #443");
  let retryNames: string[] = [];
  await runRuleImport(failed, { createBatch: async items => { retryNames = items.map(item => item.name); return { results: [{ status: "fulfilled", value: { id: 3 } }] }; } }, { fixedPortFirst: true });
  assert.deepEqual(retryNames, ["失败名称"]);
});

test("empty input does not start an import", async () => {
  assert.deepEqual(await runRuleImport([], { createBatch: async () => { throw new Error("unexpected save"); } }), []);
});
