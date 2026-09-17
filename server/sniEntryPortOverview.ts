import * as db from "./db";
import { isAgentVersionAtLeast } from "./agentRouteUtils";
import { SNI_SPLITTER_MIN_AGENT_VERSION } from "@shared/sni";
import { normalizeSniValue } from "@shared/sni";

export type SniEntryHostVersionStatus = {
  id: number;
  name: string;
  agentVersion: string | null;
  versionSupported: boolean;
};

export type SniEntryPortOverviewRoute = {
  ruleId: number;
  ruleName: string;
  sni: string;
  isEnabled: boolean;
  forwardGroup: { id: number; name: string };
  target: { address: string; port: number };
};

export type SniEntryPortOverviewEntry = {
  entryHost: SniEntryHostVersionStatus;
  sourcePort: number;
  domainSetConsistent: boolean;
  missingDomains: string[];
  routes: SniEntryPortOverviewRoute[];
};

export type SniEntryPortOverview = {
  minimumAgentVersion: string;
  hasDomainDifferences: boolean;
  unsupportedEntryHostCount: number;
  entries: SniEntryPortOverviewEntry[];
};

function dbBool(value: unknown, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return value === true || value === 1 || value === "1" || String(value).trim().toLowerCase() === "true";
}

export async function getSniEntryHostVersionStatuses(entryHostIds: number[]) {
  const hostIds = Array.from(new Set(entryHostIds
    .map((hostId) => Number(hostId))
    .filter((hostId) => Number.isInteger(hostId) && hostId > 0)))
    .sort((left, right) => left - right);
  const hosts = await db.getHostStatusRows({ hostIds }) as any[];
  const hostById = new Map(hosts.map((host) => [Number(host.id), host]));
  return hostIds.map((hostId): SniEntryHostVersionStatus => {
    const host = hostById.get(hostId);
    const agentVersion = String(host?.agentVersion || "").trim() || null;
    return {
      id: hostId,
      name: String(host?.name || `ID ${hostId}`).trim() || `ID ${hostId}`,
      agentVersion,
      versionSupported: !!host && isAgentVersionAtLeast(agentVersion || "", SNI_SPLITTER_MIN_AGENT_VERSION),
    };
  });
}

export async function assertSniEntryAgentVersions(entryHostIds: number[]) {
  const statuses = await getSniEntryHostVersionStatuses(entryHostIds);
  const unsupported = statuses.find((status) => !status.versionSupported);
  if (!unsupported) return statuses;
  const currentVersion = unsupported.agentVersion || "未上报";
  throw new Error(
    `入口 Agent「${unsupported.name}」（ID ${unsupported.id}）版本 ${currentVersion} 不足，SNI 分流需要 ${SNI_SPLITTER_MIN_AGENT_VERSION} 或更高版本`,
  );
}

export async function getSniEntryPortOverview(): Promise<SniEntryPortOverview> {
  const rules = (await db.getForwardRules() as any[]).filter((rule) => (
    dbBool(rule?.isForwardGroupTemplate)
    && Number(rule?.forwardGroupId || 0) > 0
    && Number(rule?.sourcePort || 0) > 0
    && !!normalizeSniValue(rule?.sni)
  ));
  const groupIds = Array.from(new Set(rules.map((rule) => Number(rule.forwardGroupId))));
  const groups = await db.getForwardGroups(undefined, { includeRuntime: false, ids: groupIds }) as any[];
  const groupById = new Map(groups
    .filter((group) => String(group?.groupMode || "") === "chain")
    .map((group) => [Number(group.id), group]));
  const entryHostIdsByGroup = new Map(await Promise.all(Array.from(groupById.keys()).map(async (groupId) => (
    [groupId, await db.getForwardGroupRuleEntryHostIds(groupId)] as const
  ))));
  const hostIds = Array.from(new Set(Array.from(entryHostIdsByGroup.values()).flat()));
  const hostStatusById = new Map((await getSniEntryHostVersionStatuses(hostIds))
    .map((status) => [status.id, status]));
  const entriesByKey = new Map<string, SniEntryPortOverviewEntry>();

  for (const rule of rules) {
    const forwardGroupId = Number(rule.forwardGroupId);
    const group = groupById.get(forwardGroupId);
    if (!group) continue;
    const sourcePort = Number(rule.sourcePort);
    const route: SniEntryPortOverviewRoute = {
      ruleId: Number(rule.id),
      ruleName: String(rule.name || `规则 #${rule.id}`),
      sni: normalizeSniValue(rule.sni),
      isEnabled: dbBool(rule.isEnabled),
      forwardGroup: { id: forwardGroupId, name: String(group.name || `转发链 #${forwardGroupId}`) },
      target: { address: String(rule.targetIp || ""), port: Number(rule.targetPort || 0) },
    };
    for (const hostId of entryHostIdsByGroup.get(forwardGroupId) || []) {
      const entryHost = hostStatusById.get(hostId);
      if (!entryHost) continue;
      const key = `${hostId}:${sourcePort}`;
      const entry = entriesByKey.get(key) || {
        entryHost,
        sourcePort,
        domainSetConsistent: true,
        missingDomains: [],
        routes: [],
      };
      entry.routes.push(route);
      entriesByKey.set(key, entry);
    }
  }

  const entries = Array.from(entriesByKey.values());
  const entriesByPort = new Map<number, SniEntryPortOverviewEntry[]>();
  for (const entry of entries) {
    entry.routes.sort((left, right) => left.sni.localeCompare(right.sni) || left.ruleId - right.ruleId);
    entriesByPort.set(entry.sourcePort, [...(entriesByPort.get(entry.sourcePort) || []), entry]);
  }
  for (const portEntries of entriesByPort.values()) {
    const remaining = new Set(portEntries);
    while (remaining.size > 0) {
      const first = remaining.values().next().value as SniEntryPortOverviewEntry;
      const component: SniEntryPortOverviewEntry[] = [];
      const pending = [first];
      remaining.delete(first);
      while (pending.length > 0) {
        const current = pending.pop()!;
        component.push(current);
        const currentRuleIds = new Set(current.routes.map((route) => route.ruleId));
        for (const candidate of Array.from(remaining)) {
          if (!candidate.routes.some((route) => currentRuleIds.has(route.ruleId))) continue;
          remaining.delete(candidate);
          pending.push(candidate);
        }
      }
      const enabledDomainsByEntry = new Map(component.map((entry) => [
        entry,
        new Set(entry.routes.filter((route) => route.isEnabled).map((route) => route.sni)),
      ]));
      const signatures = new Set(Array.from(enabledDomainsByEntry.values())
        .map((domains) => Array.from(domains).sort().join("\n")));
      const domainSetConsistent = signatures.size <= 1;
      const allDomains = Array.from(new Set(Array.from(enabledDomainsByEntry.values())
        .flatMap((domains) => Array.from(domains)))).sort();
      for (const entry of component) {
        const ownDomains = enabledDomainsByEntry.get(entry) || new Set<string>();
        entry.domainSetConsistent = domainSetConsistent;
        entry.missingDomains = allDomains.filter((domain) => !ownDomains.has(domain));
      }
    }
  }
  entries.sort((left, right) => left.entryHost.id - right.entryHost.id || left.sourcePort - right.sourcePort);
  return {
    minimumAgentVersion: SNI_SPLITTER_MIN_AGENT_VERSION,
    hasDomainDifferences: entries.some((entry) => !entry.domainSetConsistent),
    unsupportedEntryHostCount: new Set(entries
      .filter((entry) => !entry.entryHost.versionSupported)
      .map((entry) => entry.entryHost.id)).size,
    entries,
  };
}
