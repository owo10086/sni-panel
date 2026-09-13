import * as db from "./db";
import { getPortOccupancy, inspectPortOccupancy, occupiedSnapshotPorts, type PortListener } from "./portOccupancy";
import { setBoundedMapValue } from "./boundedCache";
import { isHostStatusOnline } from "./hostStatusNotifier";

type Protocol = "tcp" | "udp" | "both";
type PortCheck = {
  hostIds: number[];
  port: number;
  protocol: Protocol;
  forwardType: string;
  sni?: string | null;
  forwardGroupId?: number | null;
  tunnelId?: number | null;
  excludeRuleId?: number;
  admin: boolean;
};
const confirmedRuleOwners = new Map<number, string>();

export async function occupiedOnlineSnapshotPorts(hostIds: number[], protocol: Protocol) {
  const onlineHostIds = (await Promise.all(Array.from(new Set(hostIds)).map(async (hostId) =>
    isHostStatusOnline(await db.getHostById(hostId)) ? hostId : 0))).filter((hostId) => hostId > 0);
  return occupiedSnapshotPorts(onlineHostIds, protocol);
}

function ruleOwnerSignature(input: PortCheck): string | null {
  const entries: string[] = [];
  for (const hostId of input.hostIds) {
    const snapshot = getPortOccupancy(hostId);
    const occupied = inspectPortOccupancy(snapshot, input.port, input.protocol);
    if (occupied.status === "unverified") return null;
    if (occupied.status === "occupied") {
      entries.push(...occupied.listeners.map((listener) =>
        `${hostId}:${listener.protocol}:${listener.port}:${listener.address}:${listener.process || ""}:${listener.managedRuntime || ""}:${listener.managedRuntimeId || ""}`));
    }
  }
  return entries.sort().join("|");
}

export function rememberRulePortOwner(ruleId: number, input: PortCheck) {
  const signature = ruleOwnerSignature(input);
  if (signature !== null) setBoundedMapValue(confirmedRuleOwners, ruleId, signature, 10_000);
}

export function seedRulePortOwner(ruleId: number, input: PortCheck) {
  if (!confirmedRuleOwners.has(ruleId)) rememberRulePortOwner(ruleId, input);
}

export function rulePortOwnerChanged(ruleId: number, input: PortCheck) {
  const signature = ruleOwnerSignature(input);
  if (signature === null) return false;
  const previous = confirmedRuleOwners.get(ruleId);
  if (previous === undefined) {
    return false;
  }
  return previous !== signature && signature !== "";
}

type ListeningRule = { id: number; isRunning?: unknown; forwardType: string; tunnelId?: number | null; forwardGroupId?: number | null;
  sni?: string | null; sniSplitterPort?: number | null; sourcePort: number };

export function managedListenerMatchesRule(listener: PortListener, rule: ListeningRule, allowPendingSni = false) {
  if (![true, 1, "1"].includes(rule.isRunning as string | number | boolean) && !(allowPendingSni && rule.sni)) return false;
  if (rule.forwardType === "gost") {
    if (listener.managedRuntime === "forwardx-fxp") {
      const tunnelId = Number(rule.tunnelId || 0);
      const runtimeId = listener.managedRuntimeId || "";
      if (!runtimeId) return false;
      if (rule.sni && Number(rule.sniSplitterPort) === listener.port &&
          (runtimeId === `v1:sni-splitter:${tunnelId}:${listener.port}` ||
           runtimeId === `v2:sni-splitter:${tunnelId}:${listener.port}`) &&
          (tunnelId > 0 || Number(rule.forwardGroupId || 0) > 0)) return true;
      if (!tunnelId) return false;
      return runtimeId === `entry-group:v1:${tunnelId}` || runtimeId === `entry-group:v2:${tunnelId}` ||
        runtimeId === `v1:entry:${tunnelId}:${rule.id}:${listener.port}` ||
        runtimeId === `v2:entry:${tunnelId}:${rule.id}:${listener.port}`;
    }
    return listener.managedRuntime === "forwardx-runtime";
  }
  if (rule.forwardType === "nginx") return listener.managedRuntime === "forwardx-nginx";
  if (rule.forwardType === "realm" || rule.forwardType === "socat") {
    return listener.managedRuntime === `forwardx-${rule.forwardType}`;
  }
  return false;
}

export async function evaluateRulePortOccupancy(input: PortCheck) {
  const notices: string[] = [];
  const observations: Array<{ hostId: number; collectedAt: number; verifiedAt: number;
    listeners: Array<{ port: number; protocol: "tcp" | "udp"; address: string; process?: string }> }> = [];
  const unverifiedHosts: number[] = [];
  for (const hostId of Array.from(new Set(input.hostIds.filter((id) => id > 0)))) {
    if (!isHostStatusOnline(await db.getHostById(hostId))) {
      unverifiedHosts.push(hostId);
      continue;
    }
    const existingRules = input.sni
      ? ((await db.getForwardRulesForAgent(hostId)) as any[]).filter((rule: any) => (
        Number(rule.id) !== input.excludeRuleId && Number(rule.sourcePort) === input.port &&
        !!rule.sni && !!rule.isEnabled && rule.forwardType === input.forwardType &&
        rule.protocol === "tcp" && input.protocol === "tcp" &&
        (input.forwardGroupId ? Number(rule.forwardGroupId) === input.forwardGroupId : Number(rule.tunnelId || 0) === Number(input.tunnelId || 0))
      ))
      : [];
    const result = inspectPortOccupancy(getPortOccupancy(hostId), input.port, input.protocol,
      (listener) => input.forwardType !== "iptables" && input.forwardType !== "nftables" &&
        existingRules.some((rule) => managedListenerMatchesRule(listener, rule, true)));
    if (result.status === "unverified") {
      unverifiedHosts.push(hostId);
    } else if (result.status === "occupied") {
      notices.push(`主机 ${hostId}：${input.admin ? result.adminMessage : result.userMessage}`);
      observations.push({ hostId, collectedAt: result.collectedAt, verifiedAt: result.verifiedAt,
        listeners: result.listeners.map((listener) => ({
          port: listener.port, protocol: listener.protocol, address: listener.address,
          ...(input.admin && listener.process ? { process: listener.process } : {}),
        })) });
    }
  }
  const unverifiedMessage = unverifiedHosts.length
    ? input.forwardGroupId
      ? unverifiedHosts.map((hostId) => `主机 ${hostId}：主机端口信息未经核实`).join("；")
      : "主机端口信息未经核实"
    : "";
  if (notices.length === 0) return { occupancy: unverifiedMessage ? "unverified" as const : "free" as const,
    ...(unverifiedMessage ? { warning: unverifiedMessage } : {}) };
  const kernel = input.forwardType === "iptables" || input.forwardType === "nftables";
  return { occupancy: kernel ? "warning" as const : "blocked" as const,
    observations,
    warning: `${notices.join("；")}${unverifiedMessage ? `；${unverifiedMessage}` : ""}${kernel ? "；建立后该端口的入站流量将由本规则接管，请确认端口占用" : ""}` };
}

export async function assertRulePortOccupancy(input: PortCheck & { confirmed?: boolean }) {
  const result = await evaluateRulePortOccupancy(input);
  if (result.occupancy === "blocked" || (result.occupancy === "warning" && !input.confirmed)) {
    throw new Error(result.warning);
  }
  return result;
}
