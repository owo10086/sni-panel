import type { RuleTaskSnapshot } from "@shared/ruleTaskQueue";

export type RuleBatchManageMode = "operate" | "copy" | "edit" | "export" | "import" | "groups";
export type RuleBatchCategory = "manage" | "transfer";
export type RuleBatchAccess = { hasRules: boolean; canAdd: boolean; isOwnRuleScope: boolean };
export type RuleBatchStage = "selectRules" | "importSource" | "configureTarget" | "editRules" | "confirm" | "operate" | "export" | "groups";

export type RuleCopyPair = { ruleId: number; resourceId: number };
export type RuleCopyRetry = { selectionKey: string; failedPairs: RuleCopyPair[]; unknown: boolean };
const copyRetries = new Map<string, Map<string, RuleCopyRetry>>();
const copyRetryListeners = new Set<() => void>();
let copyRetryRevision = 0;
export const ruleCopyRetries = {
  subscribe(listener: () => void) { copyRetryListeners.add(listener); return () => { copyRetryListeners.delete(listener); }; },
  snapshot: () => copyRetryRevision,
  get(scope: string, key: string) { return copyRetries.get(scope)?.get(key) ?? null; },
  remember(scope: string, retry: RuleCopyRetry) {
    let history = copyRetries.get(scope);
    if (!history) { history = new Map(); copyRetries.set(scope, history); }
    history.delete(retry.selectionKey); history.set(retry.selectionKey, retry);
    // Match the finite task-history window; switching a dialog or page never
    // resets the result of a retained copy attempt.
    while (history.size > 20) history.delete(history.keys().next().value!);
    copyRetryRevision++;
    for (const listener of copyRetryListeners) listener();
  },
  reconcile(scope: string, selectionKey: string, pairs: readonly RuleCopyPair[], task: RuleTaskSnapshot) {
    const results = task.results;
    if (!task.finishedAt || task.unknown || task.completed !== pairs.length || task.total !== pairs.length
      || results?.length !== pairs.length || new Set(results.map(result => result.index)).size !== pairs.length
      || results.some(result => !Number.isSafeInteger(result.index) || !pairs[result.index] || result.status === "unknown")) return false;
    ruleCopyRetries.remember(scope, { selectionKey, unknown: false,
      failedPairs: results.filter(result => result.status === "failed").map(result => pairs[result.index]),
    });
    return true;
  },
};
export function ruleCopySelectionKey(scope: string, ruleIds: readonly number[], resourceIds: readonly number[]) {
  const ids = (values: readonly number[]) => [...new Set(values)].sort((a, b) => a - b);
  return JSON.stringify([scope, ids(ruleIds), ids(resourceIds)]);
}
export function remainingRuleCopyJobs<T extends RuleCopyPair>(jobs: T[], selectionKey: string, retry: RuleCopyRetry | null) {
  if (!retry || retry.selectionKey !== selectionKey) return jobs;
  if (retry.unknown) return [];
  const failed = new Set(retry.failedPairs.map(pair => `${pair.ruleId}:${pair.resourceId}`));
  return jobs.filter(pair => failed.has(`${pair.ruleId}:${pair.resourceId}`));
}

export function ruleBatchCategory(mode: RuleBatchManageMode): RuleBatchCategory {
  return mode === "import" || mode === "export" ? "transfer" : "manage";
}

export function ruleBatchModes(category: RuleBatchCategory, isOwnRuleScope: boolean): RuleBatchManageMode[] {
  if (category === "transfer") return ["import", "export"];
  return isOwnRuleScope ? ["operate", "copy", "edit", "groups"] : ["operate", "copy", "edit"];
}

export function ruleBatchModeAvailable(mode: RuleBatchManageMode, access: RuleBatchAccess): boolean {
  if (mode === "import") return access.canAdd;
  if (mode === "groups") return access.isOwnRuleScope;
  return access.hasRules;
}

export function ruleBatchStages(mode: RuleBatchManageMode): readonly RuleBatchStage[] {
  switch (mode) {
    case "copy": return ["selectRules", "configureTarget", "confirm"];
    case "edit": return ["selectRules", "editRules"];
    case "import": return ["importSource", "configureTarget", "confirm"];
    default: return [mode];
  }
}

export function ruleBatchCanAdvance(mode: RuleBatchManageMode, step: number, state: {
  busy: boolean; selectedRules: number; selectedTargets: number; importSourceReady: boolean; importTargetReady: boolean;
}) {
  if (state.busy || step < 1 || step >= ruleBatchStages(mode).length) return false;
  if (mode === "import") return step === 1 ? state.importSourceReady : state.importSourceReady && state.importTargetReady;
  return state.selectedRules > 0 && (step === 1 || state.selectedTargets > 0);
}
