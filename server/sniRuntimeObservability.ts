import { setBoundedMapValue, updateBoundedMapValueInPlace } from "./boundedCache";
import { normalizeSniValue } from "./repositories/repositoryUtils";
import { FORWARD_GROUP_AGENT_HEALTH_FRESHNESS_TTL_MS } from "./forwardGroupHealthRecheck";
import { subscribeAgentFastLivenessOffline } from "./agentFastLiveness";
import { randomBytes } from "node:crypto";

export type SniRuntimeRuleReport = {
  port?: unknown;
  ruleId?: unknown;
  sni?: unknown;
  sniRouteVersion?: unknown;
  sniUnmatchedConnections?: unknown;
  sniLastConfigError?: unknown;
  ready?: unknown;
  targetIp?: unknown;
  targetPort?: unknown;
  limitIn?: unknown;
  limitOut?: unknown;
  maxConnections?: unknown;
  maxIPs?: unknown;
  accessScope?: unknown;
  sourceAllowIps?: unknown;
  protocol?: unknown;
  forwardType?: unknown;
};

export type SniRuntimeGroupStatus = {
  hostId: number;
  splitterPort: number;
  currentVersion: number;
  unmatchedConnections: number;
  lastConfigError: string;
  appliedDomains: string[];
  appliedRuleIds: number[];
  appliedRoutes: SniRuntimeRuleReport[];
  observedAt: number;
  confirmedAt: number;
  interruptedAt: number;
};

const SNI_RUNTIME_CACHE_MAX_SIZE = 10_000;
const sniRuntimeStatusCache = new Map<string, SniRuntimeGroupStatus>();
const sniRuntimeInvalidatedAt = new Map<number, number>();
const retiredAgentProcesses = new Map<number, Set<string>>();
const pendingRuntimeSessions = new Map<number, string>();

export function pendingSniRuntimeSession(hostId: number) {
  return pendingRuntimeSessions.get(hostId);
}

export function beginSniRuntimeSession(hostId: number) {
  if (!pendingRuntimeSessions.has(hostId)) setBoundedMapValue(pendingRuntimeSessions, hostId, randomBytes(32).toString("hex"), SNI_RUNTIME_CACHE_MAX_SIZE);
}

export function sniRuntimePreviouslyAppliedRuleIds(hostId: number) {
  return [...new Set([...sniRuntimeStatusCache.values()].filter(status => status.hostId === hostId).flatMap(status => status.appliedRuleIds))];
}

export function acknowledgeSniRuntimeSession(hostId: number, hash: unknown) {
  const expected = pendingRuntimeSessions.get(hostId);
  if (!expected || expected !== hash) return false;
  pendingRuntimeSessions.delete(hostId);
  return true;
}

function agentProcessIdentity(value: any) {
  const startedAt = value.agentProcessStartedAt instanceof Date ? Math.floor(value.agentProcessStartedAt.getTime() / 1000) : value.agentProcessStartedAt;
  return [String(value.agentBootId || ""), Number(value.agentProcessId || 0), String(startedAt || "")].join(":");
}

export function isRetiredSniHeartbeatProcess(hostId: number, report: any) {
  return retiredAgentProcesses.get(hostId)?.has(agentProcessIdentity(report)) === true;
}

export function acceptSniHeartbeatProcess(host: any, report: any) {
  // Boot/PID are already supplied by every supported SNI Agent. The stored
  // timestamp is a Date, while the report uses seconds; compare it separately.
  if (!report.agentProcessId || !host.agentProcessId) return true;
  const key = agentProcessIdentity(report);
  let retired = retiredAgentProcesses.get(Number(host.id));
  if (retired?.has(key)) return false;
  if (key !== agentProcessIdentity(host)) {
    if (!retired) {
      retired = new Set();
      setBoundedMapValue(retiredAgentProcesses, Number(host.id), retired, SNI_RUNTIME_CACHE_MAX_SIZE);
    }
    retired.add(agentProcessIdentity(host));
    if (retired.size > 32) retired.delete(retired.values().next().value!);
  }
  return true;
}

export function invalidateSniRuntimeConfirmation(hostId: number, at = Date.now()) {
  if (at > (sniRuntimeInvalidatedAt.get(hostId) || 0)) {
    setBoundedMapValue(pendingRuntimeSessions, hostId, randomBytes(32).toString("hex"), SNI_RUNTIME_CACHE_MAX_SIZE);
  }
  at = Math.max(at, sniRuntimeInvalidatedAt.get(hostId) || 0);
  setBoundedMapValue(sniRuntimeInvalidatedAt, hostId, at, SNI_RUNTIME_CACHE_MAX_SIZE);
  for (const [key, status] of sniRuntimeStatusCache) {
    if (status.hostId !== hostId) continue;
    updateBoundedMapValueInPlace(sniRuntimeStatusCache, key, {
      ...status, confirmedAt: 0, interruptedAt: at,
    }, SNI_RUNTIME_CACHE_MAX_SIZE);
  }
}

export function sniRuntimeConfirmationBoundary(hostId: number) {
  return sniRuntimeInvalidatedAt.get(hostId) || 0;
}

export function renewSniRuntimeConfirmation(hostId: number, reports: SniRuntimeRuleReport[], observedAt = Date.now()) {
  const ports = new Set(reports.filter(report => normalizeSniValue(report.sni)).map(report => Number(report.port)));
  if ([...ports].some(port => !getSniRuntimeGroupStatus(hostId, port)?.confirmedAt || (getSniRuntimeGroupStatus(hostId, port)?.confirmedAt || 0) < sniRuntimeConfirmationBoundary(hostId))) return false;
  recordSniRuntimeSnapshot(hostId, reports, observedAt);
  return true;
}

subscribeAgentFastLivenessOffline(event => {
  if (event.isCurrent()) invalidateSniRuntimeConfirmation(event.hostId, event.offlineAt || Date.now());
});

function cacheKey(hostId: number, splitterPort: number) {
  return `${hostId}:${splitterPort}`;
}

function normalizedCounter(value: unknown) {
  const number = Number(value || 0);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.floor(number);
}

export function recordSniRuntimeSnapshot(
  hostIdValue: unknown,
  reports: SniRuntimeRuleReport[],
  observedAt = Date.now(),
  requiredRuleIds?: Set<number>,
) {
  const hostId = Math.floor(Number(hostIdValue || 0));
  if (hostId <= 0) return;

  const groups = new Map<number, SniRuntimeGroupStatus>();
  for (const report of reports || []) {
    const splitterPort = Math.floor(Number(report?.port || 0));
    const sni = normalizeSniValue(report?.sni);
    if (!sni || splitterPort <= 0 || splitterPort > 65535) continue;
    const group = groups.get(splitterPort) || {
      hostId,
      splitterPort,
      currentVersion: 0,
      unmatchedConnections: 0,
      lastConfigError: "",
      appliedDomains: [],
      appliedRuleIds: [],
      appliedRoutes: [],
      observedAt,
      confirmedAt: observedAt,
      interruptedAt: sniRuntimeConfirmationBoundary(hostId),
    };
    group.currentVersion = Math.max(group.currentVersion, normalizedCounter(report?.sniRouteVersion));
    group.unmatchedConnections = Math.max(
      group.unmatchedConnections,
      normalizedCounter(report?.sniUnmatchedConnections),
    );
    const lastConfigError = String(report?.sniLastConfigError || "").trim();
    if (lastConfigError) group.lastConfigError = lastConfigError.slice(0, 1000);
    if (report?.ready !== false && normalizedCounter(report?.sniRouteVersion) > 0) {
      group.appliedRoutes.push({ ...report, sourceAllowIps: Array.isArray(report.sourceAllowIps) ? [...report.sourceAllowIps] : [] });
      if (!group.appliedDomains.includes(sni)) group.appliedDomains.push(sni);
      const ruleId = Math.floor(Number(report?.ruleId || 0));
      if (ruleId > 0 && !group.appliedRuleIds.includes(ruleId)) group.appliedRuleIds.push(ruleId);
    }
    groups.set(splitterPort, group);
  }

  const observedKeys = new Set(Array.from(groups.keys()).map((splitterPort) => cacheKey(hostId, splitterPort)));
  for (const [key, current] of sniRuntimeStatusCache) {
    if (current.hostId !== hostId || observedKeys.has(key)) continue;
    updateBoundedMapValueInPlace(
      sniRuntimeStatusCache,
      key,
      {
        ...current,
        currentVersion: 0,
        appliedDomains: [],
        appliedRuleIds: [],
        appliedRoutes: [],
        observedAt,
        confirmedAt: observedAt,
        interruptedAt: observedAt,
      },
      SNI_RUNTIME_CACHE_MAX_SIZE,
    );
  }

  for (const group of groups.values()) {
    const previous = sniRuntimeStatusCache.get(cacheKey(hostId, group.splitterPort));
    group.interruptedAt = Math.max(group.interruptedAt, previous?.interruptedAt || 0);
    if (previous?.appliedRoutes.some(old => requiredRuleIds?.has(Number(old.ruleId)) && !group.appliedRoutes.some(current =>
      Number(current.ruleId) === Number(old.ruleId) && sniRouteContentMatches(current, old)))) {
      group.interruptedAt = observedAt;
    }
    if (previous?.confirmedAt && observedAt - previous.confirmedAt >= FORWARD_GROUP_AGENT_HEALTH_FRESHNESS_TTL_MS) {
      group.interruptedAt = Math.max(group.interruptedAt, previous.confirmedAt + FORWARD_GROUP_AGENT_HEALTH_FRESHNESS_TTL_MS);
    }
    if (group.appliedRoutes.length !== (reports || []).filter(report => Number(report.port) === group.splitterPort && normalizeSniValue(report.sni)).length) {
      group.interruptedAt = observedAt;
    }
    group.appliedDomains.sort();
    group.appliedRuleIds.sort((left, right) => left - right);
    setBoundedMapValue(
      sniRuntimeStatusCache,
      cacheKey(hostId, group.splitterPort),
      group,
      SNI_RUNTIME_CACHE_MAX_SIZE,
    );
  }
}

export function recordSniRuntimeApplyResult(input: {
  hostId: unknown;
  splitterPort: unknown;
  success: boolean;
  message?: unknown;
  observedAt?: number;
}) {
  const hostId = Math.floor(Number(input.hostId || 0));
  const splitterPort = Math.floor(Number(input.splitterPort || 0));
  if (hostId <= 0 || splitterPort <= 0 || splitterPort > 65535) return;
  const key = cacheKey(hostId, splitterPort);
  const current = sniRuntimeStatusCache.get(key) || {
    hostId,
    splitterPort,
    currentVersion: 0,
    unmatchedConnections: 0,
    lastConfigError: "",
    appliedDomains: [],
    appliedRuleIds: [],
    appliedRoutes: [],
    observedAt: 0,
    confirmedAt: 0,
    interruptedAt: 0,
  };
  const next: SniRuntimeGroupStatus = {
    ...current,
    appliedDomains: [...current.appliedDomains],
    appliedRuleIds: [...current.appliedRuleIds],
    appliedRoutes: [...current.appliedRoutes],
    observedAt: Math.max(current.observedAt, Number(input.observedAt || Date.now())),
    lastConfigError: input.success ? "" : String(input.message || "SNI 分流配置应用失败").trim().slice(0, 1000),
    ...(!input.success ? { confirmedAt: 0, interruptedAt: Number(input.observedAt || Date.now()) } : {}),
  };
  setBoundedMapValue(sniRuntimeStatusCache, key, next, SNI_RUNTIME_CACHE_MAX_SIZE);
}

export function getSniRuntimeGroupStatus(hostIdValue: unknown, splitterPortValue: unknown) {
  const hostId = Math.floor(Number(hostIdValue || 0));
  const splitterPort = Math.floor(Number(splitterPortValue || 0));
  if (hostId <= 0 || splitterPort <= 0 || splitterPort > 65535) return null;
  const status = sniRuntimeStatusCache.get(cacheKey(hostId, splitterPort));
  return status ? {
    ...status,
    appliedDomains: [...status.appliedDomains],
    appliedRuleIds: [...status.appliedRuleIds],
    appliedRoutes: status.appliedRoutes.map(route => ({ ...route, sourceAllowIps: Array.isArray(route.sourceAllowIps) ? [...route.sourceAllowIps] : [] })),
  } : null;
}

// Readiness follows the actual route contents so a delayed running-status write
// cannot confirm an older destination or limit after a newer save.
export function isFailoverSniRuleApplied(rule: {
  id: unknown; hostId: unknown; userId: unknown; sourcePort: unknown; sni?: unknown;
  targetIp: unknown; targetPort: unknown; rateLimitMbps?: unknown; maxConnections?: unknown;
}) {
  const rate = Number(rule.rateLimitMbps);
  const bytesPerSecond = Number.isFinite(rate) && rate > 0 ? Math.floor(rate) * 125_000 : 0;
  return isSniRouteApplied(rule, {
    sni: rule.sni, targetIp: rule.targetIp, targetPort: rule.targetPort,
    limitIn: bytesPerSecond, limitOut: bytesPerSecond,
    maxConnections: Math.min(1_000_000, Math.max(0, Math.floor(Number(rule.maxConnections) || 0))),
    maxIPs: 0, accessScope: `u${Number(rule.userId) || 0}_h${Number(rule.hostId)}`,
  });
}

export function isSniRouteApplied(rule: { id: unknown; hostId: unknown; sourcePort: unknown }, expected: SniRuntimeRuleReport) {
  const status = getSniRuntimeGroupStatus(rule.hostId, rule.sourcePort);
  if (!status?.confirmedAt || Date.now() - status.confirmedAt >= FORWARD_GROUP_AGENT_HEALTH_FRESHNESS_TTL_MS) return false;
  return !!status?.appliedRoutes.some(route => (
    Number(route.ruleId) === Number(rule.id)
    && ["forwardx", "fxp"].includes(String(route.forwardType || "").toLowerCase())
    && String(route.protocol || "").toLowerCase() === "tcp"
    && (!Array.isArray(route.sourceAllowIps) || route.sourceAllowIps.length === 0)
    && sniRouteContentMatches(route, expected)
  ));
}

export function sniRouteContentMatches(candidate: SniRuntimeRuleReport, expected: SniRuntimeRuleReport) {
  const endpoint = (value: unknown) => String(value || "").trim().replace(/^\[|\]$/g, "").toLowerCase();
  return normalizeSniValue(candidate.sni) === normalizeSniValue(expected.sni)
    && endpoint(candidate.targetIp) === endpoint(expected.targetIp)
    && Number(candidate.targetPort || 0) === Number(expected.targetPort || 0)
    && Number(candidate.limitIn || 0) === Number(expected.limitIn || 0)
    && Number(candidate.limitOut || 0) === Number(expected.limitOut || 0)
    && Number(candidate.maxConnections || 0) === Number(expected.maxConnections || 0)
    && Number(candidate.maxIPs || 0) === Number(expected.maxIPs || 0)
    && String(candidate.accessScope || "").trim() === String(expected.accessScope || "").trim();
}
