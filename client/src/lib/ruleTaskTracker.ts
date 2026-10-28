import type { RuleTaskAction, RuleTaskSnapshot } from "@shared/ruleTaskQueue";
import { RuleTaskOutcomeUnknownError } from "../../../shared/ruleTaskOutcome";
import { mobileAuth } from "./mobileAuth";
import { t } from "@/i18n";

export type TrackedRuleTask = { ownerId: number; scope: string; instanceId: string; task: RuleTaskSnapshot; lost?: boolean };
let tasks: TrackedRuleTask[] = [];
let scope = "";
const listeners = new Set<() => void>();
function boundedTasks(rows: TrackedRuleTask[]) {
  const pending = rows.filter(row => !row.task.finishedAt && !row.lost);
  return [...pending, ...rows.filter(row => row.task.finishedAt || row.lost).slice(-(20 - pending.length))].slice(0, 20);
}
export const ruleTaskTracker = {
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  snapshot: () => tasks,
};
export function ruleTaskScope(userId: number) {
  const panel = mobileAuth.isNative ? mobileAuth.getPanelUrl() : typeof window === "undefined" ? "" : window.location.origin;
  return `${panel}:${userId}`;
}
function publish() {
  try { sessionStorage.setItem(`forwardx.ruleTasks:${scope}`, JSON.stringify(tasks.filter(row => !row.task.finishedAt && !row.lost).map(row => ({ ...row, task: { ...row.task, results: undefined } })))); } catch { /* optional tab recovery */ }
  for (const listener of listeners) listener();
}
export function configureRuleTasks(userId: number) {
  const next = ruleTaskScope(userId);
  if (next === scope) return;
  scope = next; tasks = [];
  try {
    const saved = JSON.parse(sessionStorage.getItem(`forwardx.ruleTasks:${scope}`) || "[]");
    if (Array.isArray(saved)) tasks = saved.filter(row => row?.scope === scope && row.ownerId === userId && typeof row.instanceId === "string"
      && /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(row.task?.id)
      && typeof row.task.title === "string" && row.task.title.length <= 80 && ["queued", "running"].includes(row.task.state)
      && !row.task.finishedAt && row.task.total > 0 && row.task.total <= 5000 && row.task.completed <= row.task.total
      && ["total", "completed", "succeeded", "failed", "skipped", "cancelled"].every(key => Number.isSafeInteger(row.task[key]) && row.task[key] >= 0)
      && Number.isSafeInteger(row.task.unknown ?? 0) && (row.task.unknown ?? 0) >= 0
      && row.task.completed === row.task.succeeded + row.task.failed + row.task.skipped + row.task.cancelled + (row.task.unknown ?? 0)).slice(0, 20);
  } catch { /* ignore malformed storage */ }
  publish();
}
export function registerRuleTask(userId: number, instanceId: string, task: RuleTaskSnapshot) {
  reconcileRuleTaskSubmissions(ruleTaskScope(userId), instanceId, task);
  configureRuleTasks(userId);
  const existing = tasks.find(row => row.task.id === task.id);
  tasks = boundedTasks([...tasks.filter(row => row !== existing), { ownerId: userId, scope, instanceId, task }]);
  publish();
}
export function updateRuleTasks(userId: number, instanceId: string, ids: string[], snapshots: Array<RuleTaskSnapshot | null>) {
  const expectedScope = ruleTaskScope(userId);
  // A poll started for the previous account can finish after switching away.
  // Reconcile its own attempts without exposing its tasks in the active scope.
  snapshots.forEach((task, index) => {
    if (task?.id === ids[index]) reconcileRuleTaskSubmissions(expectedScope, instanceId, task);
  });
  if (scope !== expectedScope) return;
  tasks = tasks.map(row => {
    const index = ids.indexOf(row.task.id);
    if (index < 0 || row.scope !== expectedScope || row.task.finishedAt || row.lost) return row;
    const task = snapshots[index];
    return row.instanceId !== instanceId || !task || task.id !== row.task.id ? { ...row, lost: true } : { ...row, task };
  });
  publish();
}
export function dismissRuleTask(id: string) {
  tasks = tasks.filter(row => row.task.id !== id || !row.task.finishedAt && !row.lost); publish();
}
export function waitForRuleTask(userId: number, id: string): Promise<RuleTaskSnapshot> {
  const expectedScope = ruleTaskScope(userId);
  return new Promise((resolve, reject) => {
    const check = () => {
      const row = tasks.find(row => row.task.id === id && row.scope === expectedScope);
      if (!row || row.lost) { unsubscribe(); reject(new RuleTaskOutcomeUnknownError(t("任务记录已丢失或过期，请核对规则后再操作，不要重复提交"))); }
      else if (row.task.finishedAt) {
        unsubscribe();
        if (!hasKnownOutcome(row.task)) reject(new RuleTaskOutcomeUnknownError(t("保存结果暂无法确认，请核对规则后再操作，不要重复提交")));
        else resolve(row.task);
      }
    };
    const unsubscribe = ruleTaskTracker.subscribe(check);
    check();
  });
}

type SubmissionApi = {
  enqueue(input: { requestId: string; title: string; actions: RuleTaskAction[] }): Promise<{ instanceId: string; task: RuleTaskSnapshot }>;
  lookup(input: { requestId: string }): Promise<{ instanceId: string; task: RuleTaskSnapshot | null }>;
};
// Page components can unmount while awaiting a task. Keep uncertain writes
// at the submission boundary for this tab runtime, scoped to panel/account.
// No business payload is persisted, and a reload is not an execution guarantee.
type SubmissionAttempt = {
  accepted?: { instanceId: string; taskId: string };
  outcome?: RuleTaskSnapshot;
  retryKey?: string;
  recovering: boolean;
  onSettled?: (task: RuleTaskSnapshot) => boolean | void;
};
const blockedSubmissions = new Map<string, Map<string, SubmissionAttempt>>();
function submissionKey(actions: RuleTaskAction[]) {
  return JSON.stringify(actions.map(({ label: _label, ...action }) => action), (_key, value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value);
}
function failedSubmissionKey(key: string, task: RuleTaskSnapshot) {
  const failed = new Set(task.results!.filter(result => result.status === "failed").map(result => result.index));
  if (!failed.size || failed.size === task.total) return undefined;
  let index = 0;
  const actions = (JSON.parse(key) as RuleTaskAction[]).flatMap(action => {
    if (action.operation === "createBatch" && Array.isArray(action.input.rules)) {
      const rules = action.input.rules.filter(() => failed.has(index++));
      return rules.length ? [{ ...action, input: { ...action.input, rules } }] : [];
    }
    return failed.has(index++) ? [action] : [];
  });
  return submissionKey(actions);
}
function hasKnownOutcome(task: RuleTaskSnapshot) {
  const results = task.results;
  return !!task.finishedAt && !task.unknown && task.completed === task.total && task.total > 0
    && results?.length === task.total && new Set(results.map(result => result.index)).size === task.total
    && results.every(result => Number.isSafeInteger(result.index) && result.index >= 0 && result.index < task.total && result.status !== "unknown");
}
function retainRecoveredOutcome(attempts: Map<string, SubmissionAttempt>, key: string, attempt: SubmissionAttempt) {
  if (attempts.get(key) !== attempt || !attempt.outcome) return;
  // Only a complete, explicitly failed result permits replaying this payload.
  // Mixed results must first reach the caller's failed-item selection flow.
  if (attempt.outcome.results!.every(result => result.status === "failed")) attempts.delete(key);
}
function reconcileRuleTaskSubmissions(scopeKey: string, instanceId: string, task: RuleTaskSnapshot) {
  if (!hasKnownOutcome(task)) return;
  const attempts = blockedSubmissions.get(scopeKey);
  if (!attempts) return;
  for (const [key, attempt] of attempts) {
    if (attempt.accepted?.instanceId !== instanceId || attempt.accepted.taskId !== task.id || attempt.outcome) continue;
    attempt.outcome = task;
    attempt.retryKey = failedSubmissionKey(key, task);
    const callback = attempt.onSettled;
    attempt.onSettled = undefined;
    if (callback?.(task) === false) attempt.recovering = true;
    if (attempt.recovering) retainRecoveredOutcome(attempts, key, attempt);
  }
}
export async function submitRuleTask(api: SubmissionApi, userId: number, title: string, actions: RuleTaskAction[], onAccepted?: () => void,
  // Return false if the owning page is gone, so the next page can recover
  // this result instead of submitting the same input again.
  onSettled?: (task: RuleTaskSnapshot) => boolean | void) {
  const scopeKey = ruleTaskScope(userId);
  const key = submissionKey(actions);
  let attempts = blockedSubmissions.get(scopeKey);
  if (!attempts) { attempts = new Map(); blockedSubmissions.set(scopeKey, attempts); }
  const existing = attempts.get(key);
  if (existing) {
    if (existing.outcome) { onSettled?.(existing.outcome); return existing.outcome; }
    existing.recovering = true;
    // One business attempt has one current page observer. Reopening it must
    // replace the old page closure rather than accumulate rejected callers.
    if (onSettled) existing.onSettled = onSettled;
    throw new RuleTaskOutcomeUnknownError(t("保存结果暂无法确认，请核对规则后再操作，不要重复提交"));
  }
  // Retain a finite history, but never evict an uncertain write to make room.
  if (attempts.size >= 20) {
    const settled = [...attempts].find(([, attempt]) => attempt.outcome);
    if (settled) attempts.delete(settled[0]);
  }
  if (attempts.size >= 20) throw new RuleTaskOutcomeUnknownError(t("保存结果暂无法确认，请核对规则后再操作，不要重复提交"));
  // A cached mixed result can be revisited after its failed subset succeeded.
  // Retain that subset's result too, so the stale parent cannot replay it.
  const recovering = [...attempts.values()].some(previous => previous.retryKey === key);
  const attempt: SubmissionAttempt = { recovering, onSettled };
  attempts.set(key, attempt);
  try {
    const task = await performRuleTaskSubmission(api, userId, title, actions, onAccepted, accepted => {
      attempt.accepted = { instanceId: accepted.instanceId, taskId: accepted.task.id };
      reconcileRuleTaskSubmissions(scopeKey, accepted.instanceId, accepted.task);
    });
    if (attempt.recovering && !attempt.outcome) throw new RuleTaskOutcomeUnknownError(t("保存结果暂无法确认，请核对规则后再操作，不要重复提交"));
    if (attempt.recovering && attempt.outcome) retainRecoveredOutcome(attempts, key, attempt);
    else if (attempts.get(key) === attempt) attempts.delete(key);
    return task;
  } catch (error) {
    if (attempts.get(key) === attempt) {
      if (error instanceof RuleTaskOutcomeUnknownError) {
        attempt.recovering = true;
        retainRecoveredOutcome(attempts, key, attempt);
      } else attempts.delete(key);
    }
    throw error;
  }
}
async function performRuleTaskSubmission(api: SubmissionApi, userId: number, title: string, actions: RuleTaskAction[], onAccepted: (() => void) | undefined,
  onIdentified: (accepted: { instanceId: string; task: RuleTaskSnapshot }) => void) {
  configureRuleTasks(userId);
  const expectedScope = ruleTaskScope(userId);
  // getRandomValues also works on ordinary HTTP panels, unlike randomUUID.
  const requestId = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("");
  let accepted;
  try { accepted = await api.enqueue({ requestId, title, actions }); }
  catch (error) {
    // The enqueue response can be lost after acceptance. Look it up, never
    // blindly submit another job (especially creates) with a different ID.
    const existing = await api.lookup({ requestId }).catch(() => null);
    if (!existing?.task) {
      const code = (error as any)?.data?.code;
      if (code && !["INTERNAL_SERVER_ERROR", "SERVICE_UNAVAILABLE", "TIMEOUT"].includes(code)) throw error;
      throw new RuleTaskOutcomeUnknownError(t("任务提交结果暂无法确认，请核对规则后再操作，不要重复提交"));
    }
    accepted = { instanceId: existing.instanceId, task: existing.task };
  }
  onIdentified(accepted);
  if (scope !== expectedScope) {
    try {
      const key = `forwardx.ruleTasks:${expectedScope}`;
      const saved = JSON.parse(sessionStorage.getItem(key) || "[]");
      const own = Array.isArray(saved) ? saved.filter(row => row?.ownerId === userId && row.scope === expectedScope && row.task?.id !== accepted.task.id) : [];
      sessionStorage.setItem(key, JSON.stringify(boundedTasks([...own, { ownerId: userId, scope: expectedScope, instanceId: accepted.instanceId, task: accepted.task }])));
    } catch { /* optional recovery */ }
    throw new RuleTaskOutcomeUnknownError(t("任务已提交，请使用原账号查看执行情况"));
  }
  registerRuleTask(userId, accepted.instanceId, accepted.task);
  onAccepted?.();
  return waitForRuleTask(userId, accepted.task.id);
}
