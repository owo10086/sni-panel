import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  getRuleBulkCheckboxState, getRuleBulkSelectability, pruneRuleBulkSelection, toggleRuleBulkSelection,
  type RuleBulkRule,
} from "@/lib/ruleBulkSelection";

export function useRuleBulkSelection<T extends RuleBulkRule>({ rules, scopeKey, ready, isSupported }: {
  rules: readonly T[];
  scopeKey: string;
  ready: boolean;
  isSupported: (rule: T) => boolean;
}) {
  const [selection, setSelection] = useState({ scopeKey, ids: new Set<number>() });
  const [busy, setBusy] = useState(false);
  // 筛选改变的当次渲染即清空可见选择，避免等待副作用期间使用上一页编号。
  const selectedIds = useMemo(() => selection.scopeKey === scopeKey
    ? pruneRuleBulkSelection(selection.ids, rules, isSupported) : new Set<number>(),
  [selection, scopeKey, rules, isSupported]);
  const current = useRef({ scopeKey, ready, busy });
  current.current = { scopeKey, ready, busy };

  useEffect(() => {
    setSelection((previous) => {
      const ids = previous.scopeKey === scopeKey
        ? pruneRuleBulkSelection(previous.ids, rules, isSupported) : new Set<number>();
      if (previous.scopeKey === scopeKey && ids.size === previous.ids.size) return previous;
      return { scopeKey, ids };
    });
  }, [scopeKey, rules, isSupported]);

  const clear = useCallback(() => setSelection({ scopeKey: current.current.scopeKey, ids: new Set() }), []);
  const retain = useCallback((ids: readonly number[], expectedScopeKey: string) => {
    if (current.current.scopeKey === expectedScopeKey) setSelection({ scopeKey: expectedScopeKey, ids: new Set(ids) });
  }, []);
  const getCheckboxProps = (items: readonly T[]) => {
    const state = getRuleBulkCheckboxState(items, selectedIds, isSupported);
    const reason = !ready ? "正在加载当前页规则" : busy ? "正在执行批量操作"
      : items.length === 1 ? getRuleBulkSelectability(items[0], isSupported(items[0])).reason
      : state.disabled ? "该范围内没有可批量修改的规则" : null;
    return {
      ...state, disabled: state.disabled || !ready || busy, reason,
      onCheckedChange: (checked: boolean) => {
        if (!current.current.ready || current.current.busy || current.current.scopeKey !== scopeKey) return;
        setSelection((previous) => ({ scopeKey, ids: toggleRuleBulkSelection(
          previous.scopeKey === scopeKey ? previous.ids : new Set(), items, checked, isSupported,
        ) }));
      },
    };
  };
  const selectedRules = rules.filter((rule) => selectedIds.has(Number(rule.id)));
  return { scopeKey, ready, busy, setBusy, selectedIds, selectedRules, clear, retain, getCheckboxProps };
}

export type RuleBulkSelection<T extends RuleBulkRule> = ReturnType<typeof useRuleBulkSelection<T>>;
