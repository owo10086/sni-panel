import { setBoundedMapValue } from "./boundedCache";

export type SniMemberHealthObservation = {
  key: string;
  healthy: boolean;
  pending?: boolean;
  pendingTtlMs?: number;
  agentFinal?: boolean;
  failureAt?: number;
  confirmedAt?: number;
  interruptedAt?: number;
  expiresAt?: number;
  adjustmentStartedAt?: number;
  adjustmentDeadlineAt?: number;
  message: string;
};

type SourceWindow = {
  healthy: boolean;
  hadFailure: boolean;
  failureAt: number | null;
  healthyAt: number | null;
  interruptedAt: number;
  pendingAt: number | null;
};

// Each source owns its observation window. A stable China probe cannot clear
// a splitter failure or lend its healthy duration to a recovering splitter.
const memberWindows = new Map<number, Map<string, SourceWindow>>();
const memberSummaries = new Map<number, { selectionReady: boolean; healthMessage: string }>();
const chinaProbeDecisions = new Map<number, { status: string; at: number; final: boolean }>();

export function recordSniChinaHealthDecision(memberId: number, status: string, at: number, final: boolean) {
  setBoundedMapValue(chinaProbeDecisions, memberId, { status, at, final }, 10_000);
}

export function isSniChinaHealthDecisionFinal(memberId: number, status: string, checkedAt: number) {
  const decision = chinaProbeDecisions.get(memberId);
  return !!decision && decision.status === status && Math.floor(decision.at / 1000) === Math.floor(checkedAt / 1000) && decision.final;
}

export function sniMemberHealthSummary(memberId: number) {
  return memberSummaries.get(memberId) || { selectionReady: false, healthMessage: "等待重新确认 SNI 分流运行状态" };
}

export function sniMemberAdjustmentAllowed(memberId: number, key: string, startedAt: number, recoverMs: number) {
  const source = memberWindows.get(memberId)?.get(key);
  return !source?.hadFailure || (source.healthy && source.healthyAt !== null && startedAt - source.healthyAt >= recoverMs);
}

export function evaluateSniMemberHealthWindows(input: {
  memberId: number;
  previouslyObserved: boolean;
  observations: SniMemberHealthObservation[];
  now: number;
  failoverMs: number;
  recoverMs: number;
}) {
  let sources = memberWindows.get(input.memberId);
  if (!sources) {
    sources = new Map();
    setBoundedMapValue(memberWindows, input.memberId, sources, 10_000);
  }
  const currentKeys = new Set(input.observations.map(observation => observation.key));
  const results = input.observations.map(rawObservation => {
    let observation = rawObservation;
    let window = sources!.get(observation.key);
    if (!window) {
      // A replacement cannot erase an existing recovery constraint for this
      // member/root rule. Its failure clock still belongs to its own replica.
      const rootKey = observation.key.startsWith("rule:") ? observation.key.split(":").slice(0, 2).join(":") + ":" : null;
      const priorFailure = rootKey && [...sources!].some(([key, source]) => key.startsWith(rootKey) && source.hadFailure
        && (!source.healthy || source.healthyAt === null
          || (observation.adjustmentStartedAt ?? input.now) - source.healthyAt < input.recoverMs));
      window = { healthy: false, hadFailure: !!priorFailure || (input.previouslyObserved && observation.adjustmentStartedAt === undefined), failureAt: null, healthyAt: null, interruptedAt: 0, pendingAt: null };
      sources!.set(observation.key, window);
    }
    if (observation.pending && observation.pendingTtlMs) {
      window.pendingAt ??= input.now;
      const deadline = window.pendingAt + observation.pendingTtlMs;
      observation = { ...observation, pending: input.now < deadline, expiresAt: deadline, failureAt: input.now >= deadline ? deadline : observation.failureAt };
    } else window.pendingAt = null;
    const interruptedAt = observation.interruptedAt || 0;
    if (interruptedAt > window.interruptedAt) {
      window.healthy = false;
      window.healthyAt = null;
      window.hadFailure = true;
      window.interruptedAt = interruptedAt;
    }
    const recoveryAlreadyCompleted = window.healthy && window.healthyAt !== null
      && observation.adjustmentStartedAt !== undefined && observation.adjustmentStartedAt - window.healthyAt >= input.recoverMs;
    const adjustment = observation.adjustmentStartedAt !== undefined && (!window.hadFailure || recoveryAlreadyCompleted)
      && interruptedAt <= window.interruptedAt;
    if (adjustment && recoveryAlreadyCompleted) window.hadFailure = false;
    const adjusting = adjustment && (input.now < (observation.adjustmentDeadlineAt ?? 0)
      || (observation.healthy && !!observation.confirmedAt && observation.confirmedAt < (observation.adjustmentDeadlineAt ?? 0)));
    if (adjustment && !adjusting) {
      window.hadFailure = true;
      window.failureAt = observation.adjustmentStartedAt!;
    }
    if (observation.healthy) {
      if (!window.healthy) window.healthyAt = Math.max(observation.confirmedAt || input.now, interruptedAt);
      window.healthy = true;
      window.failureAt = null;
    } else if (adjusting) {
      window.healthy = false;
      window.healthyAt = null;
      observation = { ...observation, pending: true, expiresAt: observation.adjustmentDeadlineAt };
    } else {
      if (!observation.pending || window.healthy || window.hadFailure) window.hadFailure = true;
      window.healthy = false;
      window.healthyAt = null;
      if (!observation.pending || window.failureAt || (window.hadFailure && !observation.pendingTtlMs)) {
        window.failureAt = Math.min(window.failureAt || input.now, observation.failureAt || observation.adjustmentStartedAt || input.now);
      }
    }
    const failed = !observation.healthy && (observation.agentFinal
      || (window.failureAt !== null && input.now - window.failureAt >= input.failoverMs));
    const recovered = observation.healthy && (observation.agentFinal || !window.hadFailure
      || (window.healthyAt !== null && input.now - window.healthyAt >= input.recoverMs));
    return { observation, window, failed, recovered };
  });
  for (const key of sources.keys()) if (!currentKeys.has(key)) sources.delete(key);
  const healthy = results.length > 0 && results.every(result => result.observation.healthy);
  const failedLongEnough = results.some(result => result.failed);
  const recoveredLongEnough = healthy && results.every(result => result.recovered);
  const blocking = results.find(result => result.failed)
    || results.find(result => !result.observation.healthy)
    || results.find(result => !result.recovered);
  const failureTimes = results.flatMap(result => result.window.failureAt === null ? [] : [result.window.failureAt]);
  const recoveryTimes = results.filter(result => !result.recovered).flatMap(result => result.window.healthyAt === null ? [] : [result.window.healthyAt]);
  const deadlines = results.flatMap(result => [
    ...(!result.observation.healthy && !result.failed && result.window.failureAt !== null ? [result.window.failureAt + input.failoverMs] : []),
    ...(result.observation.healthy && !result.recovered && result.window.healthyAt !== null ? [result.window.healthyAt + input.recoverMs] : []),
    ...(result.observation.expiresAt && result.observation.expiresAt > input.now ? [result.observation.expiresAt] : []),
  ]);
  const result = {
    healthy,
    healthPending: !failedLongEnough && results.some(result => result.observation.pending),
    failedLongEnough,
    recoveredLongEnough,
    failureSince: failureTimes.length ? new Date(Math.min(...failureTimes)) : null,
    healthySince: healthy ? new Date(recoveryTimes.length ? Math.max(...recoveryTimes) : input.now - input.recoverMs) : null,
    nextProbeExpiryAt: deadlines.length ? Math.max(input.now, Math.min(...deadlines)) : null,
    message: healthy && !recoveredLongEnough ? "入口恢复观察尚未完成" : blocking?.observation.message || "入口和 SNI 分流正常",
  };
  setBoundedMapValue(memberSummaries, input.memberId, {
    selectionReady: healthy && recoveredLongEnough,
    healthMessage: result.message,
  }, 10_000);
  return result;
}
