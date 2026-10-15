import { AsyncLocalStorage } from "node:async_hooks";
import { normalizeSniValue } from "@shared/sni";
import { withKeyedTaskLock, withResourceTaskLock } from "./keyedTaskLock";
import { getForwardRuleById, getForwardGroupChildRulesForTemplate } from "./repositories/forwardRuleRepository";
import { getForwardGroupById } from "./repositories/forwardGroupRepository";
import { getTunnelById, getTunnelHops, getTunnelExitNodes } from "./repositories/tunnelRepository";

type RuleRoute = { hostId?: unknown; forwardGroupId?: unknown; tunnelId?: unknown; forwardType?: unknown; sni?: unknown };
type WriteContext = { active: boolean; afterSave: Array<() => Promise<unknown>> };
const writeContext = new AsyncLocalStorage<WriteContext>();

async function readWriteRoute(ruleId: number | undefined, input: RuleRoute, includePlain = false) {
  const rule = ruleId ? await getForwardRuleById(ruleId) : undefined;
  if (!includePlain && !normalizeSniValue(rule?.sni) && !normalizeSniValue(input.sni)) return null;
  const hosts = new Set<number>();
  const groups = new Set<number>();
  const tunnels = new Set<number>();
  const addHost = (value: unknown) => { const id = Number(value); if (Number.isInteger(id) && id > 0) hosts.add(id); };
  const visitTunnel = async (value: unknown) => {
    const id = Number(value);
    if (!(id > 0) || tunnels.has(id)) return;
    tunnels.add(id);
    const tunnel = await getTunnelById(id);
    if (!tunnel) return;
    addHost(tunnel.entryHostId);
    addHost(tunnel.exitHostId);
    await visitGroup(tunnel.entryGroupId);
    await visitGroup(tunnel.exitGroupId);
    for (const hop of await getTunnelHops(id)) addHost(hop.hostId);
    for (const exit of await getTunnelExitNodes(id)) addHost(exit.hostId);
  };
  const visitGroup = async (value: unknown) => {
    const id = Number(value);
    if (!(id > 0) || groups.has(id)) return;
    groups.add(id);
    const group = await getForwardGroupById(id);
    if (!group) return;
    await visitGroup(group.entryGroupId);
    for (const member of group.members) {
      if (member.isEnabled === false || member.isEnabled === 0 || member.isEnabled === "0") continue;
      addHost(member.hostId);
      await visitTunnel(member.tunnelId);
    }
  };
  if (rule) {
    addHost(rule.hostId);
    await visitGroup(rule.forwardGroupId);
    await visitTunnel(rule.tunnelId);
    if (rule.isForwardGroupTemplate) {
      for (const child of await getForwardGroupChildRulesForTemplate(Number(rule.id))) {
        if (child.pendingDelete === true || child.pendingDelete === 1 || child.pendingDelete === "1") continue;
        addHost(child.hostId);
        await visitTunnel(child.tunnelId);
      }
    }
  }
  const nextGroupId = input.forwardGroupId !== undefined ? input.forwardGroupId : rule?.forwardGroupId;
  addHost(input.hostId ?? rule?.hostId);
  await visitGroup(nextGroupId);
  // Creates/imports coordinate the selected resource before individual checks.
  // An invalid first item's backend must not hide a later item's tunnel route.
  if (!Number(nextGroupId) && (includePlain || (input.forwardType ?? rule?.forwardType) === "gost")) {
    await visitTunnel(input.tunnelId !== undefined ? input.tunnelId : rule?.tunnelId);
  }
  return {
    hosts: [...hosts].sort((a, b) => a - b),
    groups: [...groups].sort((a, b) => a - b),
    tunnels: [...tunnels].sort((a, b) => a - b),
  };
}

// Per-host ordering also covers different resources and different ports: the
// SNI domain namespace belongs to the actual host, not to a resource or port.
// includePlain lets ordinary creates/imports share this ordering for ports,
// member changes and mixed batches; existing SNI updates keep their old gate.
export async function withSniRuleWrite<T>(ruleId: number | undefined, input: RuleRoute, save: () => Promise<T>, options: { includePlain?: boolean } = {}): Promise<T> {
  if (writeContext.getStore()?.active) return save();
  const changed = Symbol("route changed while waiting");
  // Both waits share this retry budget. Every retry fully unwinds the old
  // resource and host positions before reading and joining the new route.
  for (let retry = 0; retry <= 3; retry++) {
    const route = await readWriteRoute(ruleId, input, options.includePlain);
    if (!route) return save();
    const sameRoute = async () => JSON.stringify(await readWriteRoute(ruleId, input, options.includePlain)) === JSON.stringify(route);
    const context: WriteContext = { active: true, afterSave: [] };
    const keys = [
      ...route.groups.map(id => `forward-group-sync:${id}`),
      ...route.tunnels.map(id => `tunnel:${id}`),
      ...(ruleId ? [`rule-tunnel-exits:${ruleId}`] : []),
    ];
    const acquireResources = (index: number): Promise<T | typeof changed> => index < keys.length
      ? withResourceTaskLock(keys[index], () => acquireResources(index + 1))
      : sameRoute().then<T | typeof changed>(same => same ? writeContext.run(context, save) : changed);
    const acquireHosts = (index: number): Promise<T | typeof changed> => index < route.hosts.length
      ? withKeyedTaskLock(`sni-write-host:${route.hosts[index]}`, () => acquireHosts(index + 1))
      : sameRoute().then<T | typeof changed>(same => same ? acquireResources(0) : changed);
    let result: T | typeof changed;
    try {
      result = await acquireHosts(0);
    } finally {
      context.active = false;
    }
    if (result === changed) continue;
    for (const work of context.afterSave) await work();
    return result;
  }
  throw new Error("入口配置已变化，请刷新后重试");
}

// DDNS and health selection must finish after saving releases host ordering.
// Outside a coordinated write the existing immediate behavior is preserved.
export async function afterSniRuleWrite(work: () => Promise<unknown>): Promise<void> {
  const context = writeContext.getStore();
  if (context?.active) context.afterSave.push(work);
  else await work();
}
