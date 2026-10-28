import { setBoundedMapValue } from "./boundedCache";

type Adjustment = { childId: number; configuration: string; startedAt: number; deadlineAt: number };
const adjustments = new Map<string, Adjustment>();
const sniAdjustments = new Map<number, Omit<Adjustment, "childId">>();
const runtimeFailures = new Map<number, number>();
const hostRuntimeInterruptions = new Map<number, number>();
const keyFor = (memberId: number, ruleId: number) => `${memberId}:${ruleId}`;

// These are the fields that can change an ordinary member's deployed runtime.
// Names, ordering and the group's DNS name deliberately do not belong here.
export function forwardGroupRuleConfiguration(rule: any) {
  const numbers = ["hostId", "sourcePort", "targetPort", "tunnelId", "tunnelExitPort", "proxyProtocolVersion", "sniSplitterPort", "rateLimitMbps", "maxConnections", "failoverSeconds", "recoverSeconds"];
  const strings = ["forwardType", "protocol", "gostMode", "targetIp", "sni", "failoverStrategy", "failoverTargets", "protocolBlockReason"];
  const booleans = ["proxyProtocolReceive", "proxyProtocolSend", "proxyProtocolExitReceive", "proxyProtocolExitSend", "tcpFastOpen", "zeroCopy", "udpOverTcp", "failoverEnabled", "autoFailback", "isEnabled", "disabledByGroup", "disabledByTunnel", "disabledByUser"];
  const enabled = (value: unknown) => value === true || value === 1 || value === "1";
  return JSON.stringify([
    numbers.map(field => Number(rule?.[field] || 0)),
    strings.map(field => String(rule?.[field] || "").trim()),
    booleans.map(field => enabled(rule?.[field])),
  ]);
}

export function recordForwardGroupRuleAdjustment(rule: any, failoverMs: number, now = Date.now()) {
  const key = keyFor(Number(rule.forwardGroupMemberId), Number(rule.forwardGroupRuleId));
  const previous = adjustments.get(key);
  setBoundedMapValue(adjustments, key, {
    childId: Number(rule.id), configuration: forwardGroupRuleConfiguration(rule),
    startedAt: previous?.startedAt ?? now, deadlineAt: previous?.deadlineAt ?? now + failoverMs,
  }, 50_000);
}

export function forwardGroupRuleAdjustment(rule: any) {
  if (!rule) return undefined;
  const adjustment = adjustments.get(keyFor(Number(rule.forwardGroupMemberId), Number(rule.forwardGroupRuleId)));
  return adjustment?.childId === Number(rule.id) && adjustment.configuration === forwardGroupRuleConfiguration(rule)
    ? adjustment : undefined;
}

export function finishForwardGroupRuleAdjustment(rule: any) {
  adjustments.delete(keyFor(Number(rule.forwardGroupMemberId), Number(rule.forwardGroupRuleId)));
}

export function recordForwardGroupRuleRuntimeFailure(rule: any, at = Date.now()) {
  if (!Number(rule?.forwardGroupMemberId) || !Number(rule?.forwardGroupRuleId)) return;
  finishForwardGroupRuleAdjustment(rule);
  setBoundedMapValue(runtimeFailures, Number(rule.id), at, 50_000);
}

export function forwardGroupRuleRuntimeFailureAt(ruleId: number) {
  return runtimeFailures.get(ruleId) || 0;
}

// Ordinary host failover rules retain their existing running-report protocol.
// A process restart still constitutes a real interruption, even if the first
// report already says running and no intervening failover sweep saw it stop.
export function recordForwardGroupHostRuntimeInterruption(hostId: number, at = Date.now()) {
  setBoundedMapValue(hostRuntimeInterruptions, hostId,
    Math.max(at, hostRuntimeInterruptions.get(hostId) || 0), 10_000);
}

export function forwardGroupHostRuntimeInterruptionAt(hostId: number) {
  return hostRuntimeInterruptions.get(hostId) || 0;
}

export function recordForwardGroupSniAdjustment(memberId: number, configuration: string, failoverMs: number, now = Date.now()) {
  const previous = sniAdjustments.get(memberId);
  setBoundedMapValue(sniAdjustments, memberId, {
    configuration, startedAt: previous?.startedAt ?? now, deadlineAt: previous?.deadlineAt ?? now + failoverMs,
  }, 10_000);
}

export function forwardGroupSniAdjustment(memberId: number, configuration: string) {
  const adjustment = sniAdjustments.get(memberId);
  return adjustment?.configuration === configuration ? adjustment : undefined;
}

export function finishForwardGroupSniAdjustment(memberId: number) {
  sniAdjustments.delete(memberId);
}
