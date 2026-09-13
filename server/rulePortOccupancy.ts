import * as db from "./db";
import { getPortOccupancy, inspectPortOccupancy, type PortListener } from "./portOccupancy";
import { notifyForwardRuleOccupancy, portOccupancyNotificationTransition } from "./forwardRuleErrorNotifier";
import { updateBoundedMapValueInPlace } from "./boundedCache";
import { managedListenerMatchesRule, seedRulePortOwner } from "./rulePortValidation";

export type RulePortWarning = { status: "occupied" | "unverified"; message: string; hostId: number; collectedAt?: number; verifiedAt?: number };
const warnings = new Map<string, { admin: RulePortWarning; user: RulePortWarning }>();
const MAX_WARNINGS = 20_000;

export function getRulePortWarnings(ruleId: number, admin: boolean) {
  const prefix = `${ruleId}:`;
  return Array.from(warnings.entries())
    .filter(([key]) => key.startsWith(prefix))
    .map(([, entry]) => admin ? entry.admin : entry.user);
}

export async function refreshRulePortWarningsForHost(hostId: number) {
  const snapshot = getPortOccupancy(hostId);
  if (!snapshot) return;
  const rules = (await db.getForwardRulesForAgent(hostId)) as any[];
  const activeKeys = new Set<string>();
  const groupHosts = new Map<number, number[]>();
  for (const rule of rules) {
    if (![true, 1, "1"].includes(rule.isEnabled) || Number(rule.sourcePort) <= 0) continue;
    const result = inspectPortOccupancy(snapshot, Number(rule.sourcePort), rule.protocol || "both",
      (listener) => managedListenerMatchesRule(listener, rule));
    const ruleId = Number(rule.forwardGroupRuleId || rule.id);
    const key = `${ruleId}:${hostId}:${rule.sourcePort}:${rule.protocol}`;
    activeKeys.add(key);
    if (result.status === "unverified") {
      updateBoundedMapValueInPlace(warnings, key, {
        admin: { status: "unverified", message: result.adminMessage, hostId },
        user: { status: "unverified", message: result.userMessage, hostId },
      }, MAX_WARNINGS);
      continue;
    }
    if (result.status === "occupied") {
      if (rule.forwardType === "iptables" || rule.forwardType === "nftables") {
        const groupId = Number(rule.forwardGroupId || 0);
        if (groupId > 0 && !groupHosts.has(groupId)) {
          groupHosts.set(groupId, await db.getForwardGroupRuleEntryHostIds(groupId));
        }
        seedRulePortOwner(ruleId, { hostIds: groupId ? groupHosts.get(groupId)! : [hostId],
          port: Number(rule.sourcePort), protocol: rule.protocol || "both", forwardType: rule.forwardType,
          admin: true });
      }
      const common = { status: "occupied" as const, hostId, collectedAt: result.collectedAt, verifiedAt: result.verifiedAt };
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
  for (const [key, entry] of warnings) {
    if (entry.admin.hostId === hostId && !activeKeys.has(key)) warnings.delete(key);
  }
}
