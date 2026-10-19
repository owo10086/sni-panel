import * as db from "./db";
import { gateForwardRulesForRuntime } from "./linkAccessView";
import { normalizeSniValue } from "@shared/sni";
import { getSniRuntimeGroupStatus, isFailoverSniRuleApplied, isSniRouteApplied } from "./sniRuntimeObservability";
import { getForwardChainSniEntryRuleIds } from "./repositories/forwardChainSniEntryScope";
import { forwardGroups } from "../drizzle/schema";
import { inArray } from "drizzle-orm";

function enabled(value: unknown) { return value === true || value === 1 || value === "1"; }

// A direct entry can share its listener across resources. Read all current
// routes on that host, so a report for one resource cannot confirm the rest.
export async function getDirectSniReadyPorts(hostId: number): Promise<Set<number>> {
  const rows = await gateForwardRulesForRuntime(await db.getForwardRulesForAgent(hostId));
  const candidates = rows.filter(rule => normalizeSniValue(rule.sni) && enabled(rule.isEnabled)
    && !enabled(rule.pendingDelete) && !enabled(rule.isForwardGroupTemplate));
  const database = await db.getDb();
  const groupIds = [...new Set(candidates.map(rule => Number(rule.forwardGroupId)).filter(id => id > 0))];
  const groups: Array<{ id: number; groupMode: string }> = database && groupIds.length ? await database.select({ id: forwardGroups.id, groupMode: forwardGroups.groupMode })
    .from(forwardGroups).where(inArray(forwardGroups.id, groupIds)) : [];
  const chainIds = new Set(groups.filter(group => group.groupMode === "chain").map(group => Number(group.id)));
  const chainEntryRuleIds = await getForwardChainSniEntryRuleIds(candidates.filter(rule => chainIds.has(Number(rule.forwardGroupId))));
  const byPort = new Map<number, typeof candidates>();
  for (const rule of candidates) {
    const port = Number(rule.sourcePort);
    byPort.set(port, [...(byPort.get(port) || []), rule]);
  }
  const ready = new Set<number>();
  for (const [port, rules] of byPort) {
    const report = getSniRuntimeGroupStatus(hostId, port);
    const ids = new Set(rules.map(rule => Number(rule.id)));
    // Chain entrances only select the next hop; their limits and access scope
    // are enforced at the exit. Direct routes enforce them on this listener.
    const applied = rules.every(rule => chainEntryRuleIds.has(Number(rule.id))
      ? isSniRouteApplied({ id: rule.id, hostId: rule.hostId, sourcePort: rule.sourcePort }, { sni: rule.sni, targetIp: rule.targetIp, targetPort: rule.targetPort })
      : isFailoverSniRuleApplied({ id: rule.id, hostId: rule.hostId, userId: rule.userId, sourcePort: rule.sourcePort,
        sni: rule.sni, targetIp: rule.targetIp, targetPort: rule.targetPort, rateLimitMbps: rule.rateLimitMbps, maxConnections: rule.maxConnections }));
    if (applied && report?.appliedRoutes.length === ids.size
      && report.appliedRoutes.every(route => ids.has(Number(route.ruleId)))) ready.add(port);
  }
  return ready;
}
