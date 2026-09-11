import { setBoundedMapValue } from "./boundedCache";
import { normalizeSniValue } from "./repositories/repositoryUtils";

export type SniRuntimeRuleReport = {
  port?: unknown;
  ruleId?: unknown;
  sni?: unknown;
  sniRouteVersion?: unknown;
  sniUnmatchedConnections?: unknown;
  sniLastConfigError?: unknown;
  ready?: unknown;
};

export type SniRuntimeGroupStatus = {
  hostId: number;
  splitterPort: number;
  currentVersion: number;
  unmatchedConnections: number;
  lastConfigError: string;
  appliedDomains: string[];
  appliedRuleIds: number[];
  observedAt: number;
};

const SNI_RUNTIME_CACHE_MAX_SIZE = 10_000;
const sniRuntimeStatusCache = new Map<string, SniRuntimeGroupStatus>();

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
      observedAt,
    };
    group.currentVersion = Math.max(group.currentVersion, normalizedCounter(report?.sniRouteVersion));
    group.unmatchedConnections = Math.max(
      group.unmatchedConnections,
      normalizedCounter(report?.sniUnmatchedConnections),
    );
    const lastConfigError = String(report?.sniLastConfigError || "").trim();
    if (lastConfigError) group.lastConfigError = lastConfigError.slice(0, 1000);
    if (report?.ready !== false && group.currentVersion > 0) {
      if (!group.appliedDomains.includes(sni)) group.appliedDomains.push(sni);
      const ruleId = Math.floor(Number(report?.ruleId || 0));
      if (ruleId > 0 && !group.appliedRuleIds.includes(ruleId)) group.appliedRuleIds.push(ruleId);
    }
    groups.set(splitterPort, group);
  }

  const observedKeys = new Set(Array.from(groups.keys()).map((splitterPort) => cacheKey(hostId, splitterPort)));
  for (const [key, current] of sniRuntimeStatusCache) {
    if (current.hostId !== hostId || observedKeys.has(key)) continue;
    setBoundedMapValue(
      sniRuntimeStatusCache,
      key,
      {
        ...current,
        currentVersion: 0,
        appliedDomains: [],
        appliedRuleIds: [],
        observedAt,
      },
      SNI_RUNTIME_CACHE_MAX_SIZE,
    );
  }

  for (const group of groups.values()) {
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
    observedAt: 0,
  };
  const next: SniRuntimeGroupStatus = {
    ...current,
    appliedDomains: [...current.appliedDomains],
    appliedRuleIds: [...current.appliedRuleIds],
    observedAt: Math.max(current.observedAt, Number(input.observedAt || Date.now())),
    lastConfigError: input.success ? "" : String(input.message || "SNI 分流配置应用失败").trim().slice(0, 1000),
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
  } : null;
}
