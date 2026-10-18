import * as db from "./db";
import { gateForwardRulesForRuntime } from "./linkAccessView";
import { normalizeSniValue } from "@shared/sni";
import { getSniRuntimeGroupStatus, isFailoverSniRuleApplied } from "./sniRuntimeObservability";

function enabled(value: unknown) { return value === true || value === 1 || value === "1"; }

// A direct entry can share its listener across resources. Read all current
// routes on that host, so a report for one resource cannot confirm the rest.
export async function getDirectSniReadyPorts(hostId: number): Promise<Set<number>> {
  const rows = await gateForwardRulesForRuntime(await db.getForwardRulesForAgent(hostId));
  const candidates = rows.filter(rule => normalizeSniValue(rule.sni) && enabled(rule.isEnabled)
    && !enabled(rule.pendingDelete) && !enabled(rule.isForwardGroupTemplate));
  const byPort = new Map<number, typeof candidates>();
  for (const rule of candidates) {
    const port = Number(rule.sourcePort);
    byPort.set(port, [...(byPort.get(port) || []), rule]);
  }
  const ready = new Set<number>();
  for (const [port, rules] of byPort) {
    const report = getSniRuntimeGroupStatus(hostId, port);
    const ids = new Set(rules.map(rule => Number(rule.id)));
    if (rules.every(rule => isFailoverSniRuleApplied({ id: rule.id, hostId: rule.hostId, userId: rule.userId, sourcePort: rule.sourcePort, sni: rule.sni, targetIp: rule.targetIp, targetPort: rule.targetPort, rateLimitMbps: rule.rateLimitMbps, maxConnections: rule.maxConnections })) && report?.appliedRoutes.length === ids.size
      && report.appliedRoutes.every(route => ids.has(Number(route.ruleId)))) ready.add(port);
  }
  return ready;
}
