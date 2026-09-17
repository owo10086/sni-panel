import * as db from "./db";
import { getPortOccupancy, inspectPortOccupancy, type PortListener } from "./portOccupancy";
import { notifyForwardRuleOccupancy, portOccupancyNotificationTransition, prunePortOccupancyNotificationsForHost } from "./forwardRuleErrorNotifier";
import { updateBoundedMapValueInPlace } from "./boundedCache";
import { managedListenerMatchesRule } from "./rulePortValidation";
import { clearPortOccupancyNotification } from "./forwardRuleErrorNotifier";
import { getPortRuleEntriesForHost, type PortRuleEntry } from "./portRuleManifest";
import { normalizeSniValue } from "@shared/sni";

export type RulePortWarning = { status: "occupied"; message: string; hostId: number; port: number; collectedAt?: number; verifiedAt?: number };
const warnings = new Map<string, { admin: RulePortWarning; user: RulePortWarning }>();
const MAX_WARNINGS = 20_000;

export function getRulePortWarnings(ruleId: number, admin: boolean) {
  const prefix = `${ruleId}:`;
  return Array.from(warnings.entries())
    .filter(([key]) => key.startsWith(prefix))
    .map(([, entry]) => admin ? entry.admin : entry.user);
}

export async function refreshRulePortWarningsForHost(hostId: number, manifestEntries?: PortRuleEntry[]) {
  const snapshot = getPortOccupancy(hostId);
  const [rules, entries] = await Promise.all([
    db.getForwardRulesForAgent(hostId) as Promise<any[]>, manifestEntries ?? getPortRuleEntriesForHost(hostId),
  ]);
  const portsByRule = new Map<number, number[]>();
  for (const entry of entries) {
    if (entry.forwardType !== "iptables" && entry.forwardType !== "nftables") continue;
    const ports = portsByRule.get(entry.ruleId) || [];
    ports.push(entry.port);
    portsByRule.set(entry.ruleId, ports);
  }
  const activeKeys = new Set<string>();
  for (const rule of rules) {
    if (![true, 1, "1"].includes(rule.isEnabled) ||
        [true, 1, "1"].includes(rule.pendingDelete) ||
        !!normalizeSniValue(rule.sni) ||
        (rule.forwardType !== "iptables" && rule.forwardType !== "nftables")) continue;
    for (const port of portsByRule.get(Number(rule.id)) || []) {
      const ruleId = Number(rule.forwardGroupRuleId || rule.id);
      const key = `${ruleId}:${hostId}:${port}:${rule.protocol}`;
      activeKeys.add(key);
      if (!snapshot) continue;
      const result = inspectPortOccupancy(snapshot, port, rule.protocol || "both",
        (listener) => managedListenerMatchesRule(listener, rule));
      if (result.status === "unverified") continue;
      if (result.status === "occupied") {
        const common = { status: "occupied" as const, hostId, port, collectedAt: result.collectedAt, verifiedAt: result.verifiedAt };
        updateBoundedMapValueInPlace(warnings, key, {
          admin: { ...common, message: result.adminMessage }, user: { ...common, message: result.userMessage },
        }, MAX_WARNINGS);
      } else {
        warnings.delete(key);
      }
      if (![true, 1, "1"].includes(rule.telegramErrorNotifyEnabled)) continue;
      const owner = result.status === "occupied"
        ? result.listeners.map((listener: PortListener) => `${listener.protocol}:${listener.address}:${listener.port}:${listener.process || ""}:${listener.managedRuntimeId || ""}`).sort().join("|")
        : "";
      const change = portOccupancyNotificationTransition(key, owner, true);
      if (change) {
        void notifyForwardRuleOccupancy({
          rule, host: await db.getHostById(hostId), recovered: change === "recovered",
          message: change === "recovered" ? "监听占用已解除" : (result.status === "occupied" ? result.adminMessage : ""),
        }).catch((error) => console.warn(`[Telegram] Port occupancy notification failed: ${String(error)}`));
      }
    }
  }
  for (const [key, entry] of warnings) {
    if (entry.admin.hostId === hostId && !activeKeys.has(key)) {
      warnings.delete(key);
      clearPortOccupancyNotification(key);
    }
  }
  prunePortOccupancyNotificationsForHost(hostId, activeKeys);
}
