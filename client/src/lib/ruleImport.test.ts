import assert from "node:assert/strict";
import test from "node:test";
import { runRuleImport } from "./ruleImport";
import { parseSniBulkImportText, parseRuleTransferFile } from "./ruleTransfer";

test("text SNI import submits one batch and maps partial results to original lines", async () => {
  const parsed = parseSniBulkImportText("first#a.example.test#203.0.113.1#443\n\nsecond#b.example.test#203.0.113.2#443", 18443);
  assert.equal(parsed.ok, true);
  const submitted: string[][] = [];
  const results = await runRuleImport(parsed.rules, {
    createOne: async () => { throw new Error("unexpected ordinary rule"); },
    createSniBatch: async rules => {
      submitted.push(rules.map(rule => rule.sni!));
      return { results: [{ status: "fulfilled", value: { id: 41 } }, { status: "rejected", reason: "duplicate domain" }] };
    },
  });
  assert.deepEqual(submitted, [["a.example.test", "b.example.test"]]);
  assert.deepEqual(results.map(result => result.status), ["fulfilled", "rejected"]);
  assert.equal(results[1].item.sourceLineNumber, 3);
  assert.equal(results[1].status === "rejected" && results[1].reason, "duplicate domain");
  const retry = results.filter(result => result.status === "rejected").map(result => result.item);
  assert.deepEqual(retry.map(rule => rule.name), ["second"]);
});

test("mixed file import returns SNI and ordinary results in file order even when the batch fails", async () => {
  const parsed = parseSniBulkImportText("first#a.example.test#203.0.113.1#443\nsecond#b.example.test#203.0.113.2#443", 18443);
  const ordinary = { ...parsed.rules[0], name: "ordinary", sni: undefined, sourcePort: 18444 };
  const file = { kind: "forwardx.forward-rules", version: 1, rules: [parsed.rules[0], ordinary, parsed.rules[1]] };
  const imported = parseRuleTransferFile(file);
  assert.equal(imported.ok, true);
  if (!imported.ok) return;
  const saved: string[] = [];
  const results = await runRuleImport(imported.file.rules, {
    createOne: async rule => { saved.push(rule.name); return { id: 72 }; },
    createSniBatch: async rules => { assert.equal(rules.length, 2); throw new Error("save rolled back"); },
  });
  assert.deepEqual(saved, ["ordinary"]);
  assert.deepEqual(results.map(result => result.item.name), ["first", "ordinary", "second"]);
  assert.deepEqual(results.map(result => result.status), ["rejected", "fulfilled", "rejected"]);
  const normal = await runRuleImport([ordinary], { createOne: async () => ({ id: 73 }), createSniBatch: async () => { throw new Error("unexpected SNI batch"); } });
  assert.equal(normal[0].status, "fulfilled");
});
