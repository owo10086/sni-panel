import assert from "node:assert/strict";
import test from "node:test";
import { getRuleBulkCheckboxState, getRuleBulkRoutePreset, getRuleBulkSelectability, pruneRuleBulkSelection, summarizeRuleBulkDeleteResult, summarizeRuleBulkResult, toggleRuleBulkSelection } from "./ruleBulkSelection";

test("仅普通且受支持的规则可以参与行内批量操作", () => {
  assert.deepEqual(getRuleBulkSelectability({ id: 1 }, true), { selectable: true, reason: null });
  for (const rule of [{ id: 2, forwardGroupRuleId: 7 }, { id: 3, forwardGroupMemberId: 8 }]) {
    assert.deepEqual(getRuleBulkSelectability(rule, true), {
      selectable: false, reason: "转发组派生规则不支持批量修改",
    });
  }
  assert.deepEqual(getRuleBulkSelectability({ id: 4 }, false), {
    selectable: false, reason: "当前运行时不支持该规则的协议",
  });
});

test("表头和组头的三态仅统计可选规则", () => {
  const rules = [{ id: 1 }, { id: 2 }, { id: 3, forwardGroupRuleId: 7 }, { id: 4 }];
  const supported = (rule: { id: number }) => rule.id !== 4;
  assert.deepEqual(getRuleBulkCheckboxState([], new Set(), supported), {
    checked: false, indeterminate: false, disabled: true,
  });
  assert.deepEqual(getRuleBulkCheckboxState(rules.slice(2), new Set([3, 4]), supported), {
    checked: false, indeterminate: false, disabled: true,
  });
  assert.deepEqual(getRuleBulkCheckboxState(rules, new Set(), supported), {
    checked: false, indeterminate: false, disabled: false,
  });
  assert.deepEqual(getRuleBulkCheckboxState(rules, new Set([1]), supported), {
    checked: false, indeterminate: true, disabled: false,
  });
  assert.deepEqual(getRuleBulkCheckboxState(rules, new Set([1, 2]), supported), {
    checked: true, indeterminate: false, disabled: false,
  });
});

test("选择整组与取消整组保留组外选择且跳过不可选规则", () => {
  const rules = [{ id: 1 }, { id: 2 }, { id: 3, forwardGroupMemberId: 7 }, { id: 4 }];
  const supported = (rule: { id: number }) => rule.id !== 4;
  const original = new Set([9]);
  const selected = toggleRuleBulkSelection(original, rules, true, supported);
  assert.deepEqual(selected, new Set([9, 1, 2]));
  assert.deepEqual(original, new Set([9]));
  assert.deepEqual(toggleRuleBulkSelection(selected, rules, false, supported), new Set([9]));
});

test("刷新后的选择集合仅保留本页仍存在且可选的编号", () => {
  const rules = [{ id: 1 }, { id: 2, forwardGroupRuleId: 7 }, { id: 3 }];
  assert.deepEqual(pruneRuleBulkSelection(new Set([1, 2, 3, 99]), rules, (rule) => rule.id !== 3), new Set([1]));
});

test("相同入口类型预选该类型，混合入口类型保留空选并报告类型数", () => {
  const route = (rule: { route: "local" | "tunnel" | "chain" | "group" }) => rule.route;
  assert.deepEqual(getRuleBulkRoutePreset([], route), { routeMode: null, typeCount: 0 });
  assert.deepEqual(getRuleBulkRoutePreset([{ route: "chain" }, { route: "chain" }], route), { routeMode: "chain", typeCount: 1 });
  assert.deepEqual(getRuleBulkRoutePreset([{ route: "tunnel" }, { route: "chain" }, { route: "local" }], route), { routeMode: null, typeCount: 3 });
});

test("全部编辑成功时清空选择并关闭对话框", () => {
  assert.deepEqual(summarizeRuleBulkResult([{ ruleId: 1, outcome: "updated" }, { ruleId: 2, outcome: "updated" }]), {
    updated: 2, skipped: 0, failed: 0, tone: "success", message: "已批量编辑 2 条规则",
    keepSelectedIds: [], closeDialog: true,
  });
});

test("部分跳过时保留跳过编号，全部跳过时保留对话框供调整策略", () => {
  assert.deepEqual(summarizeRuleBulkResult([{ ruleId: 1, outcome: "updated" }, { ruleId: 2, outcome: "skipped" }]), {
    updated: 1, skipped: 1, failed: 0, tone: "success", message: "已批量编辑 1 条，跳过 1 条（端口冲突）",
    keepSelectedIds: [2], closeDialog: true,
  });
  assert.deepEqual(summarizeRuleBulkResult([{ ruleId: 2, outcome: "skipped" }, { ruleId: 3, outcome: "skipped" }]), {
    updated: 0, skipped: 2, failed: 0, tone: "error", message: "2 条规则因端口冲突全部跳过，未做任何修改",
    keepSelectedIds: [2, 3], closeDialog: false,
  });
});

test("部分失败与全部失败分别汇总，且只保留失败规则的编号", () => {
  const result = summarizeRuleBulkResult([{ ruleId: 1, outcome: "updated" }, { ruleId: 2, outcome: "failed", error: "端口被占用" }]);
  assert.deepEqual(result, {
    updated: 1, skipped: 0, failed: 1, tone: "error", message: "成功 1 条，跳过 0 条，失败 1 条：端口被占用",
    keepSelectedIds: [2], closeDialog: true,
  });
  const reversed = summarizeRuleBulkResult([{ ruleId: 1, outcome: "failed", error: "端口被占用" }, { ruleId: 2, outcome: "updated" }]);
  assert.deepEqual(reversed.keepSelectedIds, [1]);
  assert.equal(reversed.updated, result.updated);
  assert.equal(reversed.failed, result.failed);
  assert.deepEqual(summarizeRuleBulkResult([{ ruleId: 1, outcome: "failed", error: "无权使用资源" }, { ruleId: 2, outcome: "failed", error: "端口被占用" }]), {
    updated: 0, skipped: 0, failed: 2, tone: "error", message: "失败 2 条：无权使用资源",
    keepSelectedIds: [1, 2], closeDialog: true,
  });
});

test("三类结果并存且顺序变化时仍保留跳过与失败编号", () => {
  const result = summarizeRuleBulkResult([
    { ruleId: 3, outcome: "skipped" }, { ruleId: 1, outcome: "updated" },
    { ruleId: 2, outcome: "failed", error: "目标配置无效" },
  ]);
  assert.deepEqual(result, {
    updated: 1, skipped: 1, failed: 1, tone: "error", message: "成功 1 条，跳过 1 条，失败 1 条：目标配置无效",
    keepSelectedIds: [3, 2], closeDialog: true,
  });
});

test("删除结果移除成功项，保留失败项并显示首条错误", () => {
  const success = summarizeRuleBulkDeleteResult([{ ruleId: 1, outcome: "updated" }]);
  assert.equal(success.message, "已删除 1 条规则");
  assert.equal(success.tone, "success");
  assert.deepEqual(success.keepSelectedIds, []);
  const partial = summarizeRuleBulkDeleteResult([
    { ruleId: 1, outcome: "updated" }, { ruleId: 2, outcome: "failed", error: "删除失败" },
  ]);
  assert.equal(partial.message, "成功 1 条，失败 1 条：删除失败");
  assert.equal(partial.tone, "error");
  assert.deepEqual(partial.keepSelectedIds, [2]);
});
