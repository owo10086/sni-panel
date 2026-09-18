// 行内批量选择的判断与结果归纳，规格见 .scratch/rule-bulk-select/spec.md。
export type RuleBulkRule = {
  id: number;
  forwardGroupRuleId?: unknown;
  forwardGroupMemberId?: unknown;
};

export function getRuleBulkSelectability(rule: RuleBulkRule, supported: boolean) {
  if (rule.forwardGroupRuleId || rule.forwardGroupMemberId) {
    return { selectable: false, reason: "转发组派生规则不支持批量修改" };
  }
  if (!supported) return { selectable: false, reason: "当前运行时不支持该规则的协议" };
  return { selectable: true, reason: null };
}

function selectableRules<T extends RuleBulkRule>(rules: readonly T[], isSupported: (rule: T) => boolean) {
  return rules.filter((rule) => getRuleBulkSelectability(rule, isSupported(rule)).selectable);
}

export function getRuleBulkCheckboxState<T extends RuleBulkRule>(
  rules: readonly T[], selectedIds: ReadonlySet<number>, isSupported: (rule: T) => boolean,
) {
  const selectable = selectableRules(rules, isSupported);
  const selectedCount = selectable.filter((rule) => selectedIds.has(Number(rule.id))).length;
  return {
    checked: selectable.length > 0 && selectedCount === selectable.length,
    indeterminate: selectedCount > 0 && selectedCount < selectable.length,
    disabled: selectable.length === 0,
  };
}

export function toggleRuleBulkSelection<T extends RuleBulkRule>(
  selectedIds: ReadonlySet<number>, rules: readonly T[], checked: boolean, isSupported: (rule: T) => boolean,
) {
  const next = new Set(selectedIds);
  for (const rule of selectableRules(rules, isSupported)) {
    if (checked) next.add(Number(rule.id));
    else next.delete(Number(rule.id));
  }
  return next;
}

export function pruneRuleBulkSelection<T extends RuleBulkRule>(
  selectedIds: ReadonlySet<number>, rules: readonly T[], isSupported: (rule: T) => boolean,
) {
  return new Set(selectableRules(rules, isSupported)
    .map((rule) => Number(rule.id)).filter((id) => selectedIds.has(id)));
}

export type RuleBulkRouteMode = "local" | "tunnel" | "chain" | "group";
export type RuleBulkEditInput = {
  routeMode: RuleBulkRouteMode | null;
  tunnelId: number | null;
  forwardGroupId: number | null;
  targetIp: string;
  targetPort: number;
  conflictStrategy: "skip" | "auto" | "error";
};

export function getRuleBulkRoutePreset<T>(rules: readonly T[], getRouteMode: (rule: T) => RuleBulkRouteMode) {
  const types = new Set(rules.map(getRouteMode));
  return { routeMode: types.size === 1 ? [...types][0] : null, typeCount: types.size };
}

export type RuleBulkOutcome = {
  ruleId: number;
  outcome: "updated" | "skipped" | "failed";
  error?: string;
};

export function summarizeRuleBulkResult(outcomes: readonly RuleBulkOutcome[]) {
  const updated = outcomes.filter((result) => result.outcome === "updated").length;
  const skipped = outcomes.filter((result) => result.outcome === "skipped").length;
  const failures = outcomes.filter((result) => result.outcome === "failed");
  const failed = failures.length;
  const keepSelectedIds = outcomes.filter((result) => result.outcome !== "updated").map((result) => result.ruleId);
  let message = `已批量编辑 ${updated} 条规则`;
  if (failed > 0) {
    message = `${updated === 0 && skipped === 0 ? "" : `成功 ${updated} 条，跳过 ${skipped} 条，`}失败 ${failed} 条：${failures[0].error || "未知错误"}`;
  } else if (updated === 0 && skipped > 0) {
    message = `${skipped} 条规则因端口冲突全部跳过，未做任何修改`;
  } else if (skipped > 0) {
    message = `已批量编辑 ${updated} 条，跳过 ${skipped} 条（端口冲突）`;
  }
  return {
    updated, skipped, failed, tone: (failed > 0 || updated === 0 ? "error" : "success") as "success" | "error",
    message, keepSelectedIds, closeDialog: updated > 0 || failed > 0,
  };
}

export function summarizeRuleBulkDeleteResult(outcomes: readonly RuleBulkOutcome[]) {
  const summary = summarizeRuleBulkResult(outcomes);
  const error = outcomes.find((result) => result.outcome === "failed")?.error || "删除失败";
  return {
    ...summary,
    message: summary.failed > 0
      ? `成功 ${summary.updated} 条，失败 ${summary.failed} 条：${error}`
      : `已删除 ${summary.updated} 条规则`,
  };
}
