import assert from "node:assert/strict";
import test from "node:test";
import { runRuleImport } from "./ruleImport";
import { parseSniBulkImportText, parseRuleTransferFile, parseManualBulkImportText, formatManualBulkImportRuleLine } from "./ruleTransfer";

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

test("manual imports wait for every fixed port before random allocation and keep original results", async () => {
  let releaseLast!: () => void;
  const lastFixed = new Promise<void>(resolve => { releaseLast = resolve; });
  const random = Array.from({ length: 8 }, (_, index) => ({ name: `random-${index}`, sourcePort: 0, sni: undefined }));
  const fixed = Array.from({ length: 7 }, (_, index) => ({ name: `fixed-${index}`, sourcePort: 18000 + index, sni: undefined }));
  let randomStarted = 0;
  const active = { fixed: 0, random: 0 };
  const maximum = { fixed: 0, random: 0 };
  const saving = runRuleImport([...random, ...fixed], {
    createSniBatch: async () => { throw new Error("unexpected SNI batch"); },
    createOne: async rule => {
      const kind = rule.sourcePort ? "fixed" : "random";
      if (kind === "random") randomStarted++;
      active[kind]++;
      maximum[kind] = Math.max(maximum[kind], active[kind]);
      await new Promise<void>(resolve => setImmediate(resolve));
      if (rule.name === "fixed-6") await lastFixed;
      active[kind]--;
      if (rule.name === "fixed-2") throw new Error("fixed port is occupied");
      return { name: rule.name };
    },
  }, { fixedPortFirst: true });
  // Allow the first six fixed operations to finish and the seventh to block.
  await new Promise<void>(resolve => setImmediate(resolve));
  await new Promise<void>(resolve => setImmediate(resolve));
  const startedBeforeLastFixedFinished = randomStarted;
  releaseLast();
  const results = await saving;
  assert.equal(startedBeforeLastFixedFinished, 0, "random rules started while a fixed rule was still pending");
  assert.equal(randomStarted, 8, "one fixed-port failure must not stop random imports");
  assert.deepEqual(maximum, { fixed: 6, random: 6 });
  assert.deepEqual(results.map(result => result.item.name), [...random, ...fixed].map(rule => rule.name));
  assert.equal(results[10].status, "rejected");
  assert.equal(results.filter(result => result.status === "fulfilled").length, 14);
});

test("default imports preserve existing scheduling and one-format manual imports work", async () => {
  const inputs = [{ name: "random", sourcePort: 0, sni: undefined }, { name: "fixed", sourcePort: 18000, sni: undefined }];
  const started: string[] = [];
  await runRuleImport(inputs, {
    createOne: async rule => { started.push(rule.name); return rule.name; },
    createSniBatch: async () => { throw new Error("unexpected SNI"); },
  });
  assert.deepEqual(started, ["random", "fixed"]);
  for (const items of [[], [inputs[0]], [inputs[1]]]) {
    const result = await runRuleImport(items, {
      createOne: async rule => rule.name,
      createSniBatch: async () => { throw new Error("unexpected SNI"); },
    }, { fixedPortFirst: true });
    assert.deepEqual(result.map(row => row.item.name), items.map(rule => rule.name));
  }
});

test("mixed manual failures retain exact source lines and retry only the failed rules", async () => {
  const defaults = { forwardType: "iptables", protocol: "both" } as const;
  const parsed = parseManualBulkImportText("example.net:443\n\n失败名称#17500# example.com #443\n成功#17501#203.0.113.20#80", defaults);
  assert.equal(parsed.ok, true);
  const saved: string[] = [];
  const results = await runRuleImport(parsed.rules, {
    createOne: async rule => {
      if (rule.sourcePort === 17500) throw new Error("port is occupied");
      saved.push(rule.name);
      return rule.name;
    },
    createSniBatch: async () => { throw new Error("unexpected SNI"); },
  }, { fixedPortFirst: true });
  const failed = results.filter(result => result.status === "rejected").map(result => result.item);
  assert.equal(failed[0].sourceLineNumber, 3);
  assert.equal(failed[0].sourcePort, 17500);
  assert.equal(failed.map(formatManualBulkImportRuleLine).join("\n"), "失败名称#17500# example.com #443");
  const retry = parseManualBulkImportText("失败名称#17502# example.com #443", defaults);
  await runRuleImport(retry.rules, {
    createOne: async rule => { saved.push(rule.name); return rule.name; },
    createSniBatch: async () => { throw new Error("unexpected SNI"); },
  }, { fixedPortFirst: true });
  assert.deepEqual(saved, ["成功", "example.net:443", "失败名称"]);
});
