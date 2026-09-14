import crypto from "node:crypto";
import * as db from "./db";
import { latestConfigRevision } from "./configAudit";
import { gateForwardRulesForRuntime } from "./linkAccessView";
import { getTunnelExitNodesByTunnelIds } from "./repositories/tunnelRepository";
import { normalizeExitGroupStrategy } from "../shared/exitStrategy";

export type PortRuleEntry = { ruleId: number; port: number; protocol: "tcp" | "udp" | "both"; forwardType: string };

type RuleContext = {
  tunnel?: any;
  entryHostIds?: number[];
  primaryRuleId?: number;
  extraExits?: Array<{ hostId: number; listenPort: number; rulePort: number }>;
};

export type PortRuleManifestData = { revision: number; signature: string; entries: PortRuleEntry[] };

export function effectiveRuleEntryPortsForHost(rule: any, hostId: number, context: RuleContext = {}): number[] {
  const tunnel = context.tunnel;
  const sourcePort = Number(rule.sourcePort || 0);
  const entryHosts = context.entryHostIds || [Number(rule.hostId)];
  const ports: number[] = [];
  if (entryHosts.includes(hostId) && sourcePort > 0) ports.push(sourcePort);
  const mode = String(tunnel?.mode || "").toLowerCase();
  const hasExitListener = rule.forwardType === "gost" &&
    (["tls", "wss", "tcp", "mtls", "mwss", "mtcp", "nginx_stream"].includes(mode));
  if (hasExitListener && Number(tunnel.exitHostId) === hostId) {
    const port = Number(context.primaryRuleId === Number(rule.id) ? tunnel.listenPort : rule.tunnelExitPort);
    if (port > 0) ports.push(port);
  }
  if (hasExitListener) {
    for (const exit of context.extraExits || []) {
      if (exit.hostId !== hostId) continue;
      const port = context.primaryRuleId === Number(rule.id) ? exit.listenPort : exit.rulePort;
      if (port > 0) ports.push(port);
    }
  }
  return Array.from(new Set(ports));
}

export async function loadPortRuleManifestForHost(hostId: number): Promise<PortRuleManifestData> {
  const [tunnels, revision] = await Promise.all([db.getTunnelsByHost(hostId), latestConfigRevision()]);
  const tunnelById = new Map((tunnels as any[]).map((tunnel: any) => [Number(tunnel.id), tunnel]));
  const rawRules = await db.getForwardRulesForAgentScope(hostId, [...tunnelById.keys()]);
  const rules = (await gateForwardRulesForRuntime(rawRules as any[]))
    .filter((rule: any) => [true, 1, "1"].includes(rule.isEnabled) && ![true, 1, "1"].includes(rule.pendingDelete));
  const primaryRuleIds = new Map<number, number>();
  for (const rule of rules) {
    const tunnelId = Number(rule.tunnelId || 0);
    const previous = primaryRuleIds.get(tunnelId);
    if (tunnelId > 0 && (!previous || Number(rule.id) < previous)) primaryRuleIds.set(tunnelId, Number(rule.id));
  }
  const [exits, nodes, groupHosts] = await Promise.all([
    db.getForwardRuleTunnelExitsByRuleIds(rules.map((rule: any) => Number(rule.id))),
    getTunnelExitNodesByTunnelIds([...tunnelById.keys()]),
    Promise.all((tunnels as any[]).filter((tunnel: any) => Number(tunnel.entryGroupId) > 0)
      .map(async (tunnel: any) => [Number(tunnel.id), await db.getForwardGroupRuleEntryHostIds(Number(tunnel.entryGroupId))] as const)),
  ]);
  const groupHostsByTunnel = new Map(groupHosts);
  const nodesByTunnel = new Map<number, any[]>();
  for (const node of nodes as any[]) {
    const tunnelId = Number(node.tunnelId);
    nodesByTunnel.set(tunnelId, [...(nodesByTunnel.get(tunnelId) || []), node]);
  }
  const exitByRule = new Map<number, any[]>();
  for (const exit of exits as any[]) {
    const ruleId = Number(exit.ruleId);
    exitByRule.set(ruleId, [...(exitByRule.get(ruleId) || []), exit]);
  }
  const entries: PortRuleEntry[] = [];
  for (const rule of rules) {
    const tunnelId = Number(rule.tunnelId || 0);
    const tunnel = tunnelById.get(tunnelId);
    const mappings = new Map((exitByRule.get(Number(rule.id)) || [])
      .map((exit: any) => [Number(exit.exitNodeId), exit]));
    const extraExits = (nodesByTunnel.get(tunnelId) || [])
      .filter((node: any) => [true, 1, "1"].includes(node.isEnabled) &&
        [true, 1, "1"].includes(tunnel?.loadBalanceEnabled) && normalizeExitGroupStrategy(tunnel?.loadBalanceStrategy) !== "none")
      .map((node: any) => ({ hostId: Number(node.hostId), listenPort: Number(node.listenPort),
        rulePort: Number((mappings.get(Number(node.id)) as any)?.tunnelExitPort || 0) }));
    const context = { tunnel, entryHostIds: groupHostsByTunnel.get(tunnelId) || [Number(rule.hostId)],
      primaryRuleId: primaryRuleIds.get(tunnelId), extraExits };
    for (const port of effectiveRuleEntryPortsForHost(rule, hostId, context)) {
      if (port < 1 || port > 65535) continue;
      entries.push({ ruleId: Number(rule.id), port,
        protocol: rule.protocol === "tcp" || rule.protocol === "udp" ? rule.protocol : "both",
        forwardType: String(rule.forwardType || "") });
    }
  }
  entries.sort((a, b) => a.ruleId - b.ruleId || a.port - b.port || a.protocol.localeCompare(b.protocol) || a.forwardType.localeCompare(b.forwardType));
  const signature = crypto.createHash("sha256").update(entries
    .map((entry) => `${entry.ruleId}:${entry.port}:${entry.protocol}:${entry.forwardType}\n`).join(""))
    .digest("hex");
  return { revision, signature, entries };
}

export async function getPortRuleEntriesForHost(hostId: number): Promise<PortRuleEntry[]> {
  return (await loadPortRuleManifestForHost(hostId)).entries;
}

export function formatPortRuleManifest({ revision, signature, entries }: PortRuleManifestData, acknowledgedSignature?: unknown) {
  return { portRuleManifestRevision: revision, portRuleManifestSignature: signature,
    ...(acknowledgedSignature === signature ? {} : { portRuleManifest: entries }) };
}

export async function buildPortRuleManifest(hostId: number, acknowledgedSignature?: unknown) {
  return formatPortRuleManifest(await loadPortRuleManifestForHost(hostId), acknowledgedSignature);
}
