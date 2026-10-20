import * as db from "./db";
import { pushAgentRefresh } from "./agentEvents";
import * as hopRepo from "./repositories/tunnelRepository";
import { clearTunnelRuntimeStatusForHost } from "./tunnelRuntimeStatus";
import { scheduleHostDdnsUpdate } from "./hostDdns";
import { normalizeSniValue } from "../shared/sni";
import { invalidateSniRuntimeConfirmation } from "./sniRuntimeObservability";

export function hostIngressAddress(hostLike: any) {
  return String(hostLike?.entryIp || hostLike?.ipv4 || hostLike?.ipv6 || hostLike?.ip || "").trim();
}

export function hostUsesAutomaticIngress(hostLike: any) {
  return !String(hostLike?.entryIp || "").trim();
}

// Compare configuration rather than running flags: resetting those flags is not
// evidence that an unchanged splitter table needs to be confirmed again.
async function sniAddressConfiguration(hostId: number, previousHost?: any) {
  const rules: any[] = (await db.getForwardRulesForAgent() as any[]).filter(rule => normalizeSniValue(rule.sni));
  const snapshots = new Map<number, string>();
  if (!rules.length) return snapshots;
  const linkedTunnels = new Map<number, any>((await db.getTunnelsByHost(hostId) as any[]).map(tunnel => [Number(tunnel.id), tunnel]));
  const tunnelConfigurations = new Map<number, { signature: string; entryHostIds: number[] }>();
  for (const tunnelId of new Set(rules.map(rule => Number(rule.tunnelId)).filter(id => linkedTunnels.has(id)))) {
    const tunnel = linkedTunnels.get(tunnelId)!;
    const hops: any[] = await hopRepo.getTunnelHops(tunnelId);
    const exits: any[] = await hopRepo.getTunnelExitNodes(tunnelId);
    const entryGroup = Number(tunnel.entryGroupId) > 0 ? await db.getForwardGroupById(Number(tunnel.entryGroupId)) : null;
    const entryHostIds: number[] = entryGroup ? (entryGroup.members as any[]).filter(member => member.memberType === "host"
      && (member.isEnabled === true || Number(member.isEnabled) === 1)).map(member => Number(member.hostId)) : [Number(tunnel.entryHostId)];
    const host = previousHost || await db.getHostById(hostId);
    // An address change can alter a tunnel's runtime endpoints without changing
    // the SNI rule row. Keep that dependency in the complete confirmation scope.
    const address = [hostIngressAddress(host), String(host?.tunnelEntryIp || "")];
    tunnelConfigurations.set(tunnelId, { entryHostIds, signature: JSON.stringify([
      address, tunnel.connectHost, tunnel.networkType, tunnel.entryHostId, tunnel.exitHostId,
      hops.map(hop => [hop.id, hop.hostId, hop.connectHost]),
      exits.map(exit => [exit.id, exit.hostId, exit.connectHost]),
    ]) });
  }
  const byHost = new Map<number, unknown[]>();
  for (const rule of rules.sort((left, right) => Number(left.id) - Number(right.id))) {
    const tunnel = tunnelConfigurations.get(Number(rule.tunnelId));
    const entryHostIds = tunnel?.entryHostIds.length ? tunnel.entryHostIds : [Number(rule.hostId)];
    const configuration = [rule.id, rule.userId, rule.sourcePort, normalizeSniValue(rule.sni), rule.targetIp, rule.targetPort,
      rule.forwardType, rule.protocol, rule.rateLimitMbps, rule.maxConnections, rule.isEnabled,
      rule.pendingDelete, rule.disabledByGroup, rule.disabledByUser, rule.disabledByTunnel, tunnel?.signature];
    for (const entryHostId of entryHostIds) {
      if (!entryHostId) continue;
      const entries = byHost.get(entryHostId) || [];
      entries.push(configuration);
      byHost.set(entryHostId, entries);
    }
  }
  for (const [entryHostId, configurations] of byHost) snapshots.set(entryHostId, JSON.stringify(configurations));
  return snapshots;
}

export async function refreshAgentsAffectedByHostAddress(hostId: number, reason: string) {
  const affected = new Set<number>();
  const id = Number(hostId);
  if (Number.isFinite(id) && id > 0) affected.add(id);

  const tunnels = await db.getTunnelsByHost(id);
  await Promise.all((tunnels as any[]).map(async (tunnel: any) => {
    const entryHostId = Number(tunnel?.entryHostId || 0);
    const exitHostId = Number(tunnel?.exitHostId || 0);
    if (entryHostId > 0) affected.add(entryHostId);
    if (exitHostId > 0) affected.add(exitHostId);

    const hops = await hopRepo.getTunnelHops(Number(tunnel?.id || 0)).catch(() => []);
    for (const hop of hops || []) {
      const hopHostId = Number((hop as any)?.hostId || 0);
      if (hopHostId > 0) affected.add(hopHostId);
    }

    const exits = await hopRepo.getTunnelExitNodes(Number(tunnel?.id || 0)).catch(() => []);
    for (const exit of exits || []) {
      const exitHostId = Number((exit as any)?.hostId || 0);
      if (exitHostId > 0) affected.add(exitHostId);
    }
  }));

  for (const affectedHostId of affected) {
    pushAgentRefresh(affectedHostId, reason);
  }
}

export async function refreshHostAddressRuntime(hostId: number, previousHost: any, reason: string) {
  const before = await sniAddressConfiguration(hostId, previousHost);
  await db.syncForwardChainsForHost(hostId, previousHost, { deferEntryDdns: true });
  await db.syncTunnelsForHostAddress(hostId, previousHost);
  const after = await sniAddressConfiguration(hostId);
  const changedSniHosts = new Set([...before.keys(), ...after.keys()].filter(id => before.get(id) !== after.get(id)));
  for (const id of changedSniHosts) invalidateSniRuntimeConfirmation(id);
  await db.resetAgentRuntimeStateForHost(hostId);
  clearTunnelRuntimeStatusForHost(hostId);
  await refreshAgentsAffectedByHostAddress(hostId, reason);
  for (const id of changedSniHosts) pushAgentRefresh(id, reason, { urgent: true });
  // The existing evaluator controls waiting, retaining, withdrawing and
  // selecting addresses; a vendor response never grants entry qualification.
  for (const id of new Set([hostId, ...changedSniHosts])) await db.runForwardGroupsForHostAddressChange(id, reason);
}

export async function handleHostAddressChanged(hostId: number, currentHost: any, previousHost: any, reason: string) {
  scheduleHostDdnsUpdate(currentHost, reason);
  if (hostUsesAutomaticIngress(previousHost)) {
    await refreshHostAddressRuntime(hostId, previousHost, reason);
  } else {
    await db.runForwardGroupsForHostAddressChange(hostId, reason);
  }
}
