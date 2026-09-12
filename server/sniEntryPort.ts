import * as db from "./db";
import { normalizePositiveIds } from "./repositories/repositoryUtils";
import { normalizeSniValue } from "@shared/sni";

// SNI 分流规则共用一个入口端口（ADR-0002），所以「这个端口能不能用」不再是一次
// 布尔查询。判定同时服务两条路径：创建/更新规则时（抛错），以及表单实时校验端口
// 时（返回原因）。两边必须是同一份实现，否则界面会说端口可用而提交时报占用。

export type SniEntryPortState = Awaited<ReturnType<typeof db.getForwardGroupSniEntryPortState>>;

export type ForwardRuleConflictTarget = {
  id?: unknown;
  name?: unknown;
};

export type DirectTunnelSniEntryPortState = {
  shareableRuleIds: number[];
  splitterPort: number | null;
  tunnelExitPort: number | null;
  duplicateRule: ForwardRuleConflictTarget | null;
  plainRule: ForwardRuleConflictTarget | null;
  otherResourceSniRule: ForwardRuleConflictTarget | null;
  anySniRule: ForwardRuleConflictTarget | null;
};

function dbBool(value: unknown, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return value === true || value === 1 || value === "1" || String(value).trim().toLowerCase() === "true";
}

export function forwardRuleConflictLabel(rule: ForwardRuleConflictTarget | null | undefined) {
  const name = String(rule?.name || "").trim();
  const id = Number(rule?.id || 0);
  if (name && id > 0) return `「${name}」（ID ${id}）`;
  if (name) return `「${name}」`;
  if (id > 0) return `ID ${id}`;
  return "已有规则";
}

export async function directTunnelSniEntryHostIds(tunnel: any) {
  const hostIds = new Set<number>();
  const primaryEntryHostId = Number(tunnel?.entryHostId || 0);
  if (primaryEntryHostId > 0) hostIds.add(primaryEntryHostId);
  const entryGroupId = Number(tunnel?.entryGroupId || 0);
  if (entryGroupId <= 0) return Array.from(hostIds);
  const entryGroup = await db.getForwardGroupById(entryGroupId) as any;
  if (!entryGroup || !dbBool(entryGroup.isEnabled) || String(entryGroup.groupMode || "") !== "entry") {
    return Array.from(hostIds);
  }
  for (const member of entryGroup.members || []) {
    if (!member || !dbBool(member.isEnabled, true) || String(member.memberType || "") !== "host") continue;
    const hostId = Number(member.hostId || 0);
    if (hostId > 0) hostIds.add(hostId);
  }
  return Array.from(hostIds);
}

export async function getDirectTunnelSniEntryPortState(options: {
  tunnel: any;
  sourcePort: number;
  sni: string | null;
  excludeRuleIds?: number[];
}): Promise<DirectTunnelSniEntryPortState> {
  const tunnelId = Number(options.tunnel?.id || 0);
  const sourcePort = Number(options.sourcePort || 0);
  const excludedIds = new Set(normalizePositiveIds(options.excludeRuleIds));
  const empty: DirectTunnelSniEntryPortState = {
    shareableRuleIds: [],
    splitterPort: null,
    tunnelExitPort: null,
    duplicateRule: null,
    plainRule: null,
    otherResourceSniRule: null,
    anySniRule: null,
  };
  const entryHostIds = await directTunnelSniEntryHostIds(options.tunnel);
  if (tunnelId <= 0 || entryHostIds.length === 0 || sourcePort <= 0) return empty;
  const ruleById = new Map<number, any>();
  const rulesByEntryHost = await Promise.all(
    entryHostIds.map((entryHostId) => db.getForwardRulesForAgent(entryHostId)),
  );
  for (const entryHostRules of rulesByEntryHost) {
    for (const rule of entryHostRules as any[]) {
      const ruleId = Number(rule?.id || 0);
      if (ruleId > 0 && !ruleById.has(ruleId)) ruleById.set(ruleId, rule);
    }
  }
  const rows = Array.from(ruleById.values()).filter((rule) => (
    rule
    && !excludedIds.has(Number(rule.id || 0))
    && !dbBool(rule.pendingDelete)
    && !dbBool(rule.isForwardGroupTemplate)
  ));
  const portRows = rows.filter((rule) => Number(rule.sourcePort || 0) === sourcePort);
  const activeRows = portRows.filter((rule) => dbBool(rule.isEnabled));
  const sniRows = activeRows.filter((rule) => !!normalizeSniValue(rule.sni));
  const sameTunnelRows = sniRows.filter((rule) => Number(rule.tunnelId || 0) === tunnelId);
  const normalizedSni = normalizeSniValue(options.sni);
  const duplicateRule = normalizedSni
    ? rows.find((rule) => (
      normalizeSniValue(rule.sni) === normalizedSni
    )) || null
    : null;
  const splitterPort = sameTunnelRows
    .map((rule) => Number(rule.sniSplitterPort || 0))
    .find((port) => Number.isInteger(port) && port > 0 && port <= 65535) || null;
  const tunnelExitPort = sameTunnelRows
    .map((rule) => Number(rule.tunnelExitPort || 0))
    .find((port) => Number.isInteger(port) && port > 0 && port <= 65535) || null;
  return {
    shareableRuleIds: normalizePositiveIds(sameTunnelRows.map((rule) => Number(rule.id))),
    splitterPort,
    tunnelExitPort,
    duplicateRule,
    plainRule: activeRows.find((rule) => !normalizeSniValue(rule.sni)) || null,
    otherResourceSniRule: sniRows.find((rule) => Number(rule.tunnelId || 0) !== tunnelId) || null,
    anySniRule: sniRows[0] || null,
  };
}

export function assertSniEntryPortCanUseSni(state: SniEntryPortState, sourcePort: number, normalizedSni: string) {
  if (state?.duplicateRule) {
    throw new Error(`SNI 域名 ${normalizedSni} 与规则 ${forwardRuleConflictLabel(state.duplicateRule)} 冲突`);
  }
  if (state?.plainRule) {
    throw new Error(`入口端口 ${sourcePort} 已被普通转发规则 ${forwardRuleConflictLabel(state.plainRule)} 占用，无法创建 SNI 分流规则`);
  }
  if (state?.otherGroupSniRule) {
    throw new Error(`入口端口 ${sourcePort} 已被其它转发链的 SNI 分流规则 ${forwardRuleConflictLabel(state.otherGroupSniRule)} 占用`);
  }
}

export function assertSniEntryPortCanUsePlain(state: SniEntryPortState, sourcePort: number) {
  if (state?.anySniRule) {
    throw new Error(`入口端口 ${sourcePort} 已被 SNI 分流规则 ${forwardRuleConflictLabel(state.anySniRule)} 占用，无法创建普通转发规则`);
  }
}

export function assertDirectTunnelSniEntryPortUse(
  state: DirectTunnelSniEntryPortState,
  sourcePort: number,
  normalizedSni: string | null,
) {
  if (normalizedSni) {
    if (state.duplicateRule) {
      throw new Error(`SNI 域名 ${normalizedSni} 与规则 ${forwardRuleConflictLabel(state.duplicateRule)} 冲突`);
    }
    if (state.plainRule) {
      throw new Error(`入口端口 ${sourcePort} 已被普通转发规则 ${forwardRuleConflictLabel(state.plainRule)} 占用，无法创建 SNI 分流规则`);
    }
    if (state.otherResourceSniRule) {
      throw new Error(`入口端口 ${sourcePort} 已被其它链路资源的 SNI 分流规则 ${forwardRuleConflictLabel(state.otherResourceSniRule)} 占用`);
    }
    return;
  }
  if (state.anySniRule) {
    throw new Error(`入口端口 ${sourcePort} 已被 SNI 分流规则 ${forwardRuleConflictLabel(state.anySniRule)} 占用，无法创建普通转发规则`);
  }
}

/**
 * The port-check query wants a reason, not an exception. Running the same
 * assertions keeps the two paths from drifting apart.
 */
export function sniEntryPortConflictReason(check: () => void) {
  try {
    check();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : "入口端口已被其它规则占用";
  }
}
