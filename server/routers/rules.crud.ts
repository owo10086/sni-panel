import { protectedProcedure, router } from "../_core/trpc";
import { z } from "zod";
import { isIP } from "node:net";
import * as db from "../db";
import { pushAgentRefresh } from "../agentEvents";
import { assertRulePortOccupancy, rememberRulePortOwner, rulePortOwnerChanged, occupiedOnlineSnapshotPorts } from "../rulePortValidation";
import { refreshRulePortWarningsForHost } from "../rulePortOccupancy";
import { forwardTypeSchema } from "./schemas";
import {
  pushTunnelEndpointRefresh,
  refreshUserForwardEndpoints,
  requireHostUseAccess,
  requireTunnelUseOrTrafficBillingAccess,
} from "./helpers";
import { requireRuleProtocolEnabled } from "../forwardProtocolSettings";
import { combineHostPortPolicyWithRange, combinePortPolicies, isPortAllowedByPolicy, portPolicyErrorMessage, portPolicyFrom } from "../portPolicy";
import { isTelegramBotReady } from "../telegramReady";
import {
  releaseHostPortReservations,
  reserveAvailableHostPort,
  reserveSpecificHostPort,
  reservedHostPorts,
  tryReserveHostPort,
  type HostPortReservation,
} from "../portReservations";
import {
  ensureTunnelListenerPortPolicy,
  reconcileTunnelRulePrimaryExitPorts,
  reserveTunnelExitPort,
  usesSharedTunnelPrimaryListener,
} from "../repositories/tunnelRepository";
import { trafficBillingUserLockKey, withKeyedTaskLock } from "../keyedTaskLock";
import { mapWithConcurrency } from "../asyncPool";
import { reserveRuleCreateQuota, type RuleQuotaReservation } from "../ruleQuotaReservations";
import { isAgentVersionAtLeast } from "../agentRouteUtils";
import { isValidSniValue, normalizeSniValue, SNI_SPLITTER_MIN_AGENT_VERSION } from "@shared/sni";
import { normalizePositiveIds } from "../repositories/repositoryUtils";
import {
  assertDirectTunnelSniEntryPortUse,
  assertSniEntryPortCanUsePlain,
  assertSniEntryPortCanUseSni,
  forwardRuleConflictLabel,
  getDirectTunnelSniEntryPortState,
  type DirectTunnelSniEntryPortState,
  type ForwardRuleConflictTarget,
  type SniEntryPortState,
} from "../sniEntryPort";

const targetHostSchema = z.string().min(1).max(253).refine(
  (v) => /^[a-zA-Z0-9]([a-zA-Z0-9\-_.]*[a-zA-Z0-9])?$|^[a-fA-F0-9:.]+$/.test(v.trim()),
  "请输入有效的 IP 地址或域名"
);

const failoverTargetSchema = z.object({
  targetIp: z.string().max(253).optional().default(""),
  targetPort: z.number().int().min(0).max(65535).optional().default(0),
});
const strictFailoverTargetSchema = z.object({
  targetIp: targetHostSchema,
  targetPort: z.number().int().min(1).max(65535),
});
const failoverStrategySchema = z.enum(["fallback", "round_robin", "random", "ip_hash"]);
const MAX_FAILOVER_TARGETS = 10;
const mainBackupGostTunnelModes = new Set(["tls", "wss", "tcp", "mtls", "mwss", "mtcp"]);
const SNI_BULK_IMPORT_MAX_COUNT = 500;
const sniInputSchema = z.string().max(1024).nullable().optional();
const sniRuleLimitInputShape = {
  rateLimitMbps: z.number().int().min(0).max(1_000_000).optional(),
  maxConnections: z.number().int().min(0).max(1_000_000).optional(),
} as const;

type ForwardGroupRuntimeMember = {
  id?: unknown;
  memberType?: unknown;
  hostId?: unknown;
  tunnelId?: unknown;
  priority?: unknown;
  isEnabled?: unknown;
};
type ForwardGroupRuntimeConfig = {
  id?: unknown;
  groupMode?: unknown;
  groupType?: unknown;
  forwardType?: unknown;
  members?: ForwardGroupRuntimeMember[] | null;
};

function isMainBackupGostTunnelMode(mode: unknown) {
  return mainBackupGostTunnelModes.has(String(mode || "").toLowerCase());
}

function dbBool(value: unknown, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return value === true || value === 1 || value === "1" || String(value).trim().toLowerCase() === "true";
}

export function normalizeSniInput(value: unknown) {
  if (value === undefined || value === null) return null;
  const normalized = normalizeSniValue(value);
  if (!normalized) return null;
  if (!isValidSniValue(normalized)) {
    throw new Error("SNI 域名格式不正确");
  }
  return normalized;
}

function assertSniRuleAdmin(actor: { role: string }, sni: string | null) {
  if (sni && actor.role !== "admin") {
    throw new Error("SNI 分流仅管理员可创建");
  }
}

// 限速与连接数上限只对 SNI 分流规则有意义，而且永远成对出现：入口不解析 SNI，
// 两项都只能由出口的分流器按匹配到的规则执行（ADR-0001）。
type SniRuleLimitInput = {
  rateLimitMbps?: unknown;
  maxConnections?: unknown;
};

export type SniRuleLimits = {
  rateLimitMbps: number;
  maxConnections: number;
};

function resolveSniRuleLimits(
  sni: string | null,
  input: SniRuleLimitInput,
  current?: SniRuleLimitInput,
): SniRuleLimits {
  if (!sni) return { rateLimitMbps: 0, maxConnections: 0 };
  const normalizeLimit = (value: unknown) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return 0;
    return Math.min(1_000_000, Math.max(0, Math.floor(numeric)));
  };
  return {
    rateLimitMbps: normalizeLimit(input.rateLimitMbps ?? current?.rateLimitMbps),
    maxConnections: normalizeLimit(input.maxConnections ?? current?.maxConnections),
  };
}

const MULTI_EXIT_FORWARD_GROUP_MODES = new Set(["failover", "exit"]);

async function inferForwardGroupSniExitHost(group: ForwardGroupRuntimeConfig) {
  const members = Array.isArray(group?.members) ? group.members : [];
  const enabledMembers = members.filter((member) => dbBool(member?.isEnabled, true));
  const enabledHostMembers = enabledMembers.filter((member) => (
    String(member?.memberType || "") === "host"
    && Number(member?.hostId || 0) > 0
  ));
  const groupMode = String(group?.groupMode || "").trim().toLowerCase();
  // Members of these modes are alternatives to each other, so no single exit
  // host can be derived. Say that plainly instead of blaming the link type —
  // v1 rejects multi-exit rather than silently picking the first host.
  if (MULTI_EXIT_FORWARD_GROUP_MODES.has(groupMode)) {
    throw new Error("SNI 分流当前只支持单出口");
  }
  if (groupMode !== "chain" && groupMode !== "port") {
    throw new Error("SNI 分流仅支持端口转发、隧道或转发链");
  }
  if (String(group?.groupType || "host") !== "host") {
    throw new Error("SNI 分流仅支持主机型链路资源");
  }
  if (enabledMembers.some((member: any) => String(member?.memberType || "") !== "host")) {
    throw new Error("SNI 分流仅支持主机型链路资源");
  }
  if (groupMode === "port" && enabledHostMembers.length !== 1) {
    throw new Error("SNI 分流端口转发必须且只能包含一台主机");
  }
  const exitMember = enabledMembers[enabledMembers.length - 1];
  const exitHostId = Number(exitMember?.hostId || 0);
  if (!exitHostId) throw new Error("SNI 分流无法推导出口主机");
  const exitHost = await db.getHostById(exitHostId);
  if (!exitHost) throw new Error("SNI 分流出口主机不存在");
  if (!isAgentVersionAtLeast(String((exitHost as any).agentVersion || ""), SNI_SPLITTER_MIN_AGENT_VERSION)) {
    throw new Error(`出口 Agent 版本不足，SNI 分流需要 ${SNI_SPLITTER_MIN_AGENT_VERSION} 或更高版本`);
  }
  return exitHost as any;
}

async function reserveSniSplitterPortForForwardGroup(
  group: ForwardGroupRuntimeConfig,
  options: { currentPort?: unknown; excludeRuleIds?: number | number[] } = {},
) {
  const exitHost = await inferForwardGroupSniExitHost(group);
  const reservation = await reserveTunnelExitPort({
    hostId: Number(exitHost.id),
    preferredStart: (exitHost as any).portRangeStart,
    preferredEnd: (exitHost as any).portRangeEnd,
    currentPort: options.currentPort,
    excludeRuleIds: options.excludeRuleIds,
    reservedPorts: [],
    protocol: "both",
  });
  if (!reservation) throw new Error("出口 Agent 已无可用 SNI 分流器端口");
  return reservation;
}

type SniEntryPortValidation = {
  state: SniEntryPortState;
  portUsageIgnoreRuleIds: number[];
  splitterPortUsageIgnoreRuleIds: number[];
};

type ForwardGroupRuntimePortPreparation = {
  group: ForwardGroupRuntimeConfig;
  isForwardChain: boolean;
  isPortGroup: boolean;
  sniSplitterPort: number | null;
  entryPortReservationExcludeRuleIds: number[];
};

async function inferDirectTunnelSniExitHost(tunnel: any) {
  const tunnelId = Number(tunnel?.id || 0);
  if (tunnelId <= 0) throw new Error("SNI 分流隧道不存在");
  const extraExitNodes = await db.getTunnelExitNodes(tunnelId);
  if (
    dbBool(tunnel?.loadBalanceEnabled)
    || Number(tunnel?.exitGroupId || 0) > 0
    || (extraExitNodes as any[]).some((node) => dbBool(node?.isEnabled, true))
  ) {
    throw new Error("SNI 分流隧道仅支持单出口");
  }
  const exitHostId = Number(tunnel?.exitHostId || 0);
  if (exitHostId <= 0) throw new Error("SNI 分流无法推导隧道出口主机");
  const exitHost = await db.getHostById(exitHostId);
  if (!exitHost) throw new Error("SNI 分流隧道出口主机不存在");
  if (!isAgentVersionAtLeast(String((exitHost as any).agentVersion || ""), SNI_SPLITTER_MIN_AGENT_VERSION)) {
    throw new Error(`出口 Agent 版本不足，SNI 分流需要 ${SNI_SPLITTER_MIN_AGENT_VERSION} 或更高版本`);
  }
  return exitHost as any;
}

async function reserveDirectTunnelSniRuntimePorts(options: {
  tunnel: any;
  state: DirectTunnelSniEntryPortState;
  currentSplitterPort?: unknown;
  currentTunnelExitPort?: unknown;
  ownerRuleIds?: number[];
  enabled?: boolean;
  reservations: HostPortReservation[];
}) {
  const tunnel = options.tunnel;
  const exitHost = await inferDirectTunnelSniExitHost(tunnel);
  const excludeRuleIds = normalizePositiveIds([
    ...(options.ownerRuleIds || []),
    ...options.state.shareableRuleIds,
  ]);
  const existingTunnelExitPort = Number(options.state.tunnelExitPort || 0)
    || Number(options.currentTunnelExitPort || 0);
  let sharedListenPort: number | null = null;
  let listenerRepair: Awaited<ReturnType<typeof ensureTunnelListenerPortPolicy>> | null = null;
  if (!existingTunnelExitPort && usesSharedTunnelPrimaryListener(tunnel)) {
    listenerRepair = await ensureTunnelListenerPortPolicy(tunnel, {
      hostId: Number(tunnel.exitHostId),
      syncSharedPrimaryRule: true,
    });
    if (!listenerRepair) throw new Error("出口 Agent 已无可用隧道监听端口");
    sharedListenPort = await preferredSharedTunnelListenPort(tunnel, 0, options.enabled !== false);
  }
  let tunnelExitReservation: HostPortReservation | null = null;
  if (listenerRepair?.reservation && Number(sharedListenPort || 0) === listenerRepair.port) {
    tunnelExitReservation = listenerRepair.reservation;
  } else {
    listenerRepair?.reservation.release();
  }
  if (!tunnelExitReservation) {
    tunnelExitReservation = await reserveTunnelExitPort({
      hostId: Number(exitHost.id),
      preferredStart: exitHost.portRangeStart,
      preferredEnd: exitHost.portRangeEnd,
      currentPort: existingTunnelExitPort || sharedListenPort,
      excludeRuleIds,
      allowSameTunnelListener: Number(existingTunnelExitPort || sharedListenPort || 0) === Number(tunnel.listenPort || 0),
      excludeTunnelId: Number(tunnel.id),
      protocol: "both",
    });
  }
  if (!tunnelExitReservation) throw new Error("出口 Agent 已无可用隧道端口");
  options.reservations.push(tunnelExitReservation);
  const splitterReservation = await reserveTunnelExitPort({
    hostId: Number(exitHost.id),
    preferredStart: exitHost.portRangeStart,
    preferredEnd: exitHost.portRangeEnd,
    currentPort: Number(options.state.splitterPort || 0) || Number(options.currentSplitterPort || 0),
    excludeRuleIds,
    protocol: "both",
  });
  if (!splitterReservation) throw new Error("出口 Agent 已无可用 SNI 分流器端口");
  options.reservations.push(splitterReservation);
  return {
    tunnelExitPort: tunnelExitReservation.port,
    sniSplitterPort: splitterReservation.port,
    entryPortReservationExcludeRuleIds: excludeRuleIds,
  };
}

async function validateSniEntryPortUse(options: {
  groupId: number;
  sourcePort: number;
  entryHostIds: number[];
  sni: string | null;
  excludeRuleIds?: number[];
}): Promise<SniEntryPortValidation> {
  const state = await db.getForwardGroupSniEntryPortState({
    groupId: options.groupId,
    sourcePort: options.sourcePort,
    entryHostIds: options.entryHostIds,
    sni: options.sni,
    excludeRuleIds: options.excludeRuleIds,
  });
  if (options.sni) {
    assertSniEntryPortCanUseSni(state, options.sourcePort, options.sni);
  } else {
    assertSniEntryPortCanUsePlain(state, options.sourcePort);
  }
  const portUsageIgnoreRuleIds = options.sni
    ? normalizePositiveIds(state.shareableRuleIds || [])
    : [];
  const splitterPortUsageIgnoreRuleIds = options.sni && Number(state.splitterPort || 0) > 0
    ? normalizePositiveIds(await db.getForwardGroupSniSplitterPortRuleIds(options.groupId, Number(state.splitterPort)))
    : [];
  return { state, portUsageIgnoreRuleIds, splitterPortUsageIgnoreRuleIds };
}

function sniImportLinePrefix(lineNumber: unknown) {
  const value = Number(lineNumber || 0);
  return Number.isInteger(value) && value > 0 ? `第 ${value} 行：` : "";
}

async function prepareForwardGroupRuntimePorts(options: {
  groupId: number;
  sourcePort: number;
  protocol: "tcp" | "udp" | "both" | string;
  sni: string | null;
  sniEntryPortValidation: SniEntryPortValidation;
  excludeTemplateRuleId?: number | null;
  ownerRuleIds?: number[];
  currentSplitterPort?: unknown;
  reservations: HostPortReservation[];
}): Promise<ForwardGroupRuntimePortPreparation> {
  const ownerRuleIds = normalizePositiveIds(options.ownerRuleIds);
  const group = await db.validateForwardGroupRuleConfig(options.groupId, {
    sourcePort: options.sourcePort,
    protocol: options.protocol,
    excludeTemplateRuleId: options.excludeTemplateRuleId,
    portUsageIgnoreRuleIds: options.sni ? options.sniEntryPortValidation.portUsageIgnoreRuleIds : [],
  });
  const isForwardChain = group.groupMode === "chain";
  const isPortGroup = group.groupMode === "port";
  let sniSplitterPort: number | null = null;
  if (options.sni) {
    if (!isForwardChain && !isPortGroup) {
      throw new Error("SNI 分流仅支持端口转发、隧道或转发链");
    }
    if (isPortGroup) {
      await inferForwardGroupSniExitHost(group);
      sniSplitterPort = options.sourcePort;
    } else {
      const splitterReservation = await reserveSniSplitterPortForForwardGroup(group, {
        currentPort: Number(options.sniEntryPortValidation.state.splitterPort || 0)
          || Number(options.currentSplitterPort || 0)
          || undefined,
        excludeRuleIds: normalizePositiveIds([
          ...ownerRuleIds,
          ...options.sniEntryPortValidation.splitterPortUsageIgnoreRuleIds,
        ]),
      });
      options.reservations.push(splitterReservation);
      sniSplitterPort = splitterReservation.port;
    }
  }
  return {
    group,
    isForwardChain,
    isPortGroup,
    sniSplitterPort,
    entryPortReservationExcludeRuleIds: normalizePositiveIds(options.sni
      ? [...ownerRuleIds, ...options.sniEntryPortValidation.portUsageIgnoreRuleIds]
      : ownerRuleIds),
  };
}

const failoverInputShape = {
  failoverEnabled: z.boolean().optional(),
  failoverStrategy: failoverStrategySchema.optional(),
  failoverTargets: z.array(failoverTargetSchema).max(MAX_FAILOVER_TARGETS).optional(),
  failoverSeconds: z.number().int().min(10).max(3600).optional(),
  recoverSeconds: z.number().int().min(10).max(3600).optional(),
  autoFailback: z.boolean().optional(),
} as const;

const proxyProtocolVersionSchema = z.union([z.literal(1), z.literal(2)]);

const proxyProtocolInputShape = {
  proxyProtocolReceive: z.boolean().optional(),
  proxyProtocolSend: z.boolean().optional(),
  proxyProtocolExitReceive: z.boolean().optional(),
  proxyProtocolExitSend: z.boolean().optional(),
  proxyProtocolVersion: proxyProtocolVersionSchema.optional(),
} as const;

const transportTuningInputShape = {
  tcpFastOpen: z.boolean().optional(),
  zeroCopy: z.boolean().optional(),
  udpOverTcp: z.boolean().optional(),
  udpOverTcpPort: z.number().int().min(0).max(65535).nullable().optional(),
} as const;

async function requireRuleTelegramNotifyReady(enabled?: boolean) {
  if (!enabled) return;
  if (!(await isTelegramBotReady())) {
    throw new Error("请先在系统设置中配置并启用 Telegram 机器人，再开启异常TG提醒");
  }
}

type FailoverInput = {
  failoverEnabled?: boolean;
  failoverStrategy?: z.infer<typeof failoverStrategySchema>;
  failoverTargets?: Array<{ targetIp?: string; targetPort?: number }>;
  failoverSeconds?: number;
  recoverSeconds?: number;
  autoFailback?: boolean;
};

function parseFailoverTargets(raw: unknown) {
  if (!raw || typeof raw !== "string") return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((target) => ({ targetIp: String(target?.targetIp || "").trim(), targetPort: Number(target?.targetPort) }))
      .filter((target) => target.targetIp && target.targetPort >= 1 && target.targetPort <= 65535)
      .slice(0, MAX_FAILOVER_TARGETS);
  } catch {
    return [];
  }
}

export function normalizeFailoverInput(input: FailoverInput, protocol?: string | null) {
  const enabled = !!input.failoverEnabled;
  const targets: Array<{ targetIp: string; targetPort: number }> = [];
  if (enabled && protocol && protocol !== "tcp") {
    throw new Error("主备模式当前仅支持 TCP 协议");
  }
  if (enabled) {
    for (const target of input.failoverTargets || []) {
      const targetIp = String(target.targetIp || "").trim();
      const targetPort = Number(target.targetPort || 0);
      if (!targetIp && !targetPort) continue;
      if (!targetIp || !targetPort) {
        throw new Error("备用出站需要同时填写地址和端口，完全空白的行可以保留");
      }
      const parsed = strictFailoverTargetSchema.safeParse({ targetIp, targetPort });
      if (!parsed.success) throw new Error("备用出站地址或端口格式不正确");
      targets.push(parsed.data);
      if (targets.length >= MAX_FAILOVER_TARGETS) break;
    }
  }
  if (enabled && targets.length === 0) {
    throw new Error("开启主备模式后至少需要配置一个备用出站");
  }
  return {
    failoverEnabled: enabled,
    failoverStrategy: input.failoverStrategy || "fallback",
    failoverTargets: enabled ? JSON.stringify(targets) : null,
    failoverSeconds: input.failoverSeconds ?? 60,
    recoverSeconds: input.recoverSeconds ?? 120,
    autoFailback: input.autoFailback ?? true,
  };
}

export function normalizeProxyProtocolInput(input: {
  proxyProtocolReceive?: boolean;
  proxyProtocolSend?: boolean;
  proxyProtocolExitReceive?: boolean;
  proxyProtocolExitSend?: boolean;
  proxyProtocolVersion?: number;
  failoverEnabled?: boolean;
}, protocol?: string | null, forwardType?: string | null, isForwardChain?: boolean, options?: { clearUnsupported?: boolean; tunnelRoute?: boolean }) {
  const clearUnsupported = options?.clearUnsupported ?? false;
  const protocolSupported = !protocol || protocol === "tcp" || protocol === "both";
  const forwardTypeSupported = forwardType === "gost" || forwardType === "realm";
  const tunnelRoute = !!options?.tunnelRoute;
  const receive = !isForwardChain && protocolSupported && forwardTypeSupported && dbBool(input.proxyProtocolReceive);
  const send = !isForwardChain && protocolSupported && forwardTypeSupported && dbBool(input.proxyProtocolSend);
  const tunnelProxySupported = tunnelRoute && forwardType === "gost";
  const exitReceive = tunnelProxySupported && !isForwardChain && protocolSupported && dbBool(input.proxyProtocolExitReceive);
  const exitSend = tunnelProxySupported && !isForwardChain && protocolSupported && dbBool(input.proxyProtocolExitSend);
  const version = Number(input.proxyProtocolVersion) === 2 ? 2 : 1;
  if (!receive && !send && !exitReceive && !exitSend) {
    if (clearUnsupported) return {
      proxyProtocolReceive: false,
      proxyProtocolSend: false,
      proxyProtocolExitReceive: false,
      proxyProtocolExitSend: false,
      proxyProtocolVersion: 1,
    };
    if ((dbBool(input.proxyProtocolReceive) || dbBool(input.proxyProtocolSend) || dbBool(input.proxyProtocolExitReceive) || dbBool(input.proxyProtocolExitSend)) && protocol && protocol !== "tcp" && protocol !== "both") {
      throw new Error("PROXY Protocol 仅支持 TCP 协议");
    }
    if ((dbBool(input.proxyProtocolReceive) || dbBool(input.proxyProtocolSend) || dbBool(input.proxyProtocolExitReceive) || dbBool(input.proxyProtocolExitSend)) && !forwardTypeSupported) {
      throw new Error("PROXY Protocol 仅支持 GOST 端口转发、GOST 隧道和自定义加密隧道");
    }
    return {
      proxyProtocolReceive: false,
      proxyProtocolSend: false,
      proxyProtocolExitReceive: false,
      proxyProtocolExitSend: false,
      proxyProtocolVersion: 1,
    };
  }
  return {
    proxyProtocolReceive: receive,
    proxyProtocolSend: send,
    proxyProtocolExitReceive: exitReceive,
    proxyProtocolExitSend: exitSend,
    proxyProtocolVersion: version,
  };
}
export function normalizeTransportTuningInput(input: {
  tcpFastOpen?: boolean;
  zeroCopy?: boolean;
  udpOverTcp?: boolean;
  udpOverTcpPort?: number | null;
}, protocol?: string | null, forwardType?: string | null, isForwardChain?: boolean, options?: { clearUnsupported?: boolean; tunnelRoute?: boolean; forwardxTunnel?: boolean }) {
  const clearUnsupported = options?.clearUnsupported ?? false;
  const protocolSupported = !protocol || protocol === "tcp" || protocol === "both";
  const udpOverTcpProtocolSupported = protocol === "udp" || protocol === "both";
  const tunnelRoute = !!options?.tunnelRoute;
  const forwardxTunnel = !!options?.forwardxTunnel;
  // Realm 2.9.x removed the network.fast_open and network.zero_copy options
  // (the old TOML keys are silently ignored). Keep the database columns for
  // migration compatibility, but never advertise or persist these options for
  // Realm. ForwardX's own TFO implementation remains supported below.
  const fastOpenSupported = !isForwardChain && protocolSupported
    && forwardType === "gost" && tunnelRoute && forwardxTunnel;
  const zeroCopySupported = false;
  const udpOverTcpSupported = !isForwardChain && udpOverTcpProtocolSupported && forwardType === "gost" && tunnelRoute && forwardxTunnel;
  const tcpFastOpen = fastOpenSupported && dbBool(input.tcpFastOpen);
  const zeroCopy = zeroCopySupported && dbBool(input.zeroCopy);
  const udpOverTcp = udpOverTcpSupported && dbBool(input.udpOverTcp);
  if (dbBool(input.udpOverTcp) && !udpOverTcpSupported && !clearUnsupported) {
    if (protocol !== "udp" && protocol !== "both") {
      throw new Error("UDP 混淆仅支持 UDP 或 TCP+UDP 规则");
    }
    throw new Error("UDP 混淆仅支持 ForwardX 自定义加密隧道的 UDP/TCP+UDP 规则");
  }
  if (!tcpFastOpen && !zeroCopy && !udpOverTcp) {
    if (clearUnsupported) return { tcpFastOpen: false, zeroCopy: false, udpOverTcp: false, udpOverTcpPort: null };
    if ((dbBool(input.tcpFastOpen) || dbBool(input.zeroCopy)) && protocol && protocol !== "tcp" && protocol !== "both") {
      throw new Error("TCP Fast Open 和 zero-copy 仅支持 TCP 协议");
    }
    if (dbBool(input.tcpFastOpen) && !fastOpenSupported) {
      throw new Error("当前转发方式不支持 TCP Fast Open");
    }
    if (dbBool(input.zeroCopy) && !zeroCopySupported) {
      throw new Error("当前转发方式不支持 zero-copy");
    }
  }
  return { tcpFastOpen, zeroCopy, udpOverTcp, udpOverTcpPort: null };
}

function tunnelRuntimeOptionInput(tunnel: any | null | undefined) {
  if (!tunnel) return {};
  return {
    proxyProtocolReceive: dbBool(tunnel.proxyProtocolReceive),
    proxyProtocolSend: dbBool(tunnel.proxyProtocolSend),
    proxyProtocolExitReceive: dbBool(tunnel.proxyProtocolExitReceive),
    proxyProtocolExitSend: dbBool(tunnel.proxyProtocolExitSend),
    proxyProtocolVersion: Number(tunnel.proxyProtocolVersion) === 2 ? 2 : 1,
    tcpFastOpen: dbBool(tunnel.tcpFastOpen),
    zeroCopy: false,
    udpOverTcp: dbBool(tunnel.udpOverTcp),
    udpOverTcpPort: null,
  };
}

function normalizeRuleTargetIp(input: string, _options: { tunnelId?: number | null }) {
  return String(input || "").trim();
}

/**
 * Managed GOST/Nginx tunnels share the tunnel listener with the first active
 * runtime unit. Additional runtime units need independent exit listeners.
 * An existing SNI group supplies its shared port before this helper is called,
 * so this allocation only has to compare the candidate with earlier units.
 */
async function preferredSharedTunnelListenPort(tunnel: any, ruleId = 0, enabled = true) {
  if (!usesSharedTunnelPrimaryListener(tunnel)) return null;
  const tunnelId = Number(tunnel?.id || 0);
  const listenPort = Number(tunnel?.listenPort || 0);
  if (tunnelId <= 0 || listenPort <= 0 || !dbBool(enabled, true)) return null;
  const rules = await db.getForwardRulesByTunnel(tunnelId);
  const activeIds = (rules as any[])
    .filter((candidate) => (
      candidate
      && !dbBool(candidate.isForwardGroupTemplate)
      && !dbBool(candidate.pendingDelete)
      && dbBool(candidate.isEnabled)
      && String(candidate.forwardType || "").trim().toLowerCase() === "gost"
      && (!ruleId || Number(candidate.id) !== ruleId)
    ))
    .map((candidate) => Number(candidate.id || 0))
    .filter((id) => Number.isInteger(id) && id > 0);
  if (ruleId > 0) activeIds.push(ruleId);
  const primaryId = activeIds.length > 0 ? Math.min(...activeIds) : 0;
  // A new rule is primary only when no other active rule already owns this
  // tunnel. Existing rules are primary when they are the lowest active id.
  if (ruleId > 0 ? primaryId !== ruleId : activeIds.length > 0) return null;
  return listenPort;
}

async function reconcileSharedTunnelRulePorts(tunnel: any) {
  if (!tunnel || !usesSharedTunnelPrimaryListener(tunnel)) return;
  await reconcileTunnelRulePrimaryExitPorts(tunnel);
}

function normalizeAddressToken(value: unknown) {
  return String(value || "")
    .trim()
    .replace(/^\[(.*)\]$/, "$1")
    .replace(/\.$/, "")
    .toLowerCase();
}

function isLoopbackAddress(value: unknown) {
  const target = normalizeAddressToken(value);
  if (!target) return false;
  if (target === "localhost" || target === "ip6-localhost") return true;
  if (target === "0.0.0.0" || target === "::" || target === "0:0:0:0:0:0:0:0") return true;
  if (target === "::1" || target === "0:0:0:0:0:0:0:1") return true;
  // Browsers and DNS libraries also accept non-dotted IPv4 forms. Normalize
  // 32-bit decimal/hex forms before applying the loopback check so 127.0.0.1
  // cannot be disguised as 2130706433 or 0x7f000001.
  if (/^(?:0x[0-9a-f]+|\d+)$/.test(target)) {
    const value32 = target.startsWith("0x") ? Number.parseInt(target.slice(2), 16) : Number(target);
    if (Number.isSafeInteger(value32) && value32 >= 0 && value32 <= 0xffffffff) {
      const firstOctet = Math.floor(value32 / 0x1000000);
      if (firstOctet === 127) return true;
    }
  }
  if (isIP(target) === 4) return target.startsWith("127.");
  return false;
}

function hostAddressTokens(host: any) {
  return new Set(
    [
      host?.ip,
      host?.ipv4,
      host?.ipv6,
      host?.entryIp,
      host?.tunnelEntryIp,
      host?.ddnsDomain,
    ]
      .map(normalizeAddressToken)
      .filter(Boolean),
  );
}

function assertNoDirectSelfForwardLoop(options: {
  host?: any;
  sourcePort: number;
  targetIp: unknown;
  targetPort: number;
  tunnelId?: number | null;
}) {
  const sourcePort = Number(options.sourcePort || 0);
  const targetPort = Number(options.targetPort || 0);
  if (sourcePort <= 0 || sourcePort !== targetPort) return;
  if (Number(options.tunnelId || 0) > 0) return;
  const target = normalizeAddressToken(options.targetIp);
  if (!target) return;
  if (isLoopbackAddress(target) || hostAddressTokens(options.host).has(target)) {
    throw new Error(`禁止将本机 ${sourcePort} 端口转发回自身同端口，这会造成转发死循环`);
  }
}

function normalizeLockedForwardType(value: unknown) {
  const parsed = forwardTypeSchema.safeParse(String(value || ""));
  return parsed.success ? parsed.data : "iptables";
}

export function lockedForwardTypeForGroup(group: ForwardGroupRuntimeConfig, fallback: unknown = "iptables") {
  const groupMode = String(group?.groupMode || "failover");
  const groupType = String(group?.groupType || "host");
  if (groupMode !== "chain" && groupType === "tunnel") return "gost";
  return normalizeLockedForwardType(group?.forwardType || fallback);
}

async function forwardGroupTunnelMembersSupportMainBackup(group: ForwardGroupRuntimeConfig) {
  const members = Array.isArray(group?.members) ? group.members : [];
  const tunnelMembers = members.filter((member) => dbBool(member?.isEnabled, true) && Number(member?.tunnelId || 0) > 0);
  if (tunnelMembers.length === 0) return false;
  for (const member of tunnelMembers) {
    const tunnel = await db.getTunnelById(Number(member.tunnelId));
    if (!isMainBackupGostTunnelMode((tunnel as any)?.mode)) return false;
  }
  return true;
}

function isFailoverHotUpdate(input: Record<string, unknown>, rule: any, nextHostId: number, nextTunnelId: number | null) {
  const changedFields = [
    "sourcePort",
    "targetIp",
    "targetPort",
    "forwardType",
    "protocol",
    "gostMode",
    "gostRelayHost",
    "gostRelayPort",
    "tunnelId",
    "tunnelExitPort",
    "hostId",
    "failoverEnabled",
    "failoverStrategy",
    "failoverTargets",
    "failoverSeconds",
    "recoverSeconds",
    "autoFailback",
  ].filter((field) => input[field] !== undefined && input[field] !== rule?.[field]);
  if (changedFields.length === 0) return false;
  if (!dbBool(rule?.isEnabled) || !dbBool(rule?.isRunning) || !dbBool(rule?.failoverEnabled)) return false;
  if (input.failoverEnabled === false) return false;
  if (String(input.forwardType ?? rule.forwardType) !== "gost") return false;
  if (String(input.protocol ?? rule.protocol) !== "tcp") return false;
  if (Number(nextHostId) !== Number(rule.hostId)) return false;
  if (Number(nextTunnelId || 0) !== Number(rule.tunnelId || 0)) return false;

  const hotFields = new Set([
    "targetIp",
    "targetPort",
    "failoverStrategy",
    "failoverTargets",
    "failoverSeconds",
    "recoverSeconds",
    "autoFailback",
  ]);
  return changedFields.every((field) => hotFields.has(field));
}

export function requireMainBackupAllowed(options: {
  enabled?: boolean;
  protocol?: string | null;
  forwardType?: string | null;
  tunnelId?: number | null;
  tunnelMode?: string | null;
  isTunnelRoute?: boolean;
  isPortForwardGroup?: boolean;
  isAdmin: boolean;
}) {
  if (!options.enabled) return;
  if (options.protocol && options.protocol !== "tcp") {
    throw new Error("出站策略当前仅支持 TCP 协议");
  }
  if (options.forwardType !== "gost") {
    throw new Error("出站策略仅支持 GOST 端口转发和 GOST 隧道");
  }
  const isTunnelRoute = !!options.isTunnelRoute || Number(options.tunnelId || 0) > 0;
  if (isTunnelRoute && options.tunnelMode !== undefined && !isMainBackupGostTunnelMode(options.tunnelMode)) {
    throw new Error("出站策略仅支持 GOST 隧道");
  }
  if (!options.isAdmin && !isTunnelRoute && !options.isPortForwardGroup) {
    throw new Error("普通用户的普通端口转发不支持出站策略，请使用 GOST 隧道转发或联系管理员");
  }
}

async function requireForwardAccessReady(userId: number, options?: { allowTrafficBillingRecovery?: boolean }) {
  const check = await db.ensureUserForwardAccessReady(userId, options);
  if (!check.allowed) {
    throw new Error(check.message || "转发权限已暂停，请续费后再启用规则");
  }
  return check.user || await db.getUserById(userId);
}

async function requireTrafficBillingBalanceForRule(userId: number, isTrafficBillingRule: boolean, message = "流量计费余额不足，请充值后再使用该计费资源") {
  if (!isTrafficBillingRule) return;
  const user = await db.getUserById(userId);
  if (Number((user as any)?.balanceCents || 0) <= 0) {
    throw new Error(message);
  }
}

function requireForwardTypeAllowedForActor(
  actor: { role: string; allowedForwardTypes?: string | null },
  forwardType: string,
) {
  if (actor.role === "admin") return;
  const allowedRaw = actor.allowedForwardTypes;
  if (allowedRaw === null || allowedRaw === undefined) return;
  const allowed = new Set(allowedRaw.split(",").map((value) => value.trim()).filter(Boolean));
  if (!allowed.has(forwardType)) {
    throw new Error(`您没有使用 ${forwardType} 转发方式的权限，请联系管理员`);
  }
}

async function prepareDirectRuleRouteForActor(
  actor: { id: number; role: string; allowedForwardTypes?: string | null },
  input: { forwardType: string; tunnelId?: number | null; hostId?: number | null },
) {
  requireForwardTypeAllowedForActor(actor, input.forwardType);
  if (input.tunnelId && input.forwardType !== "gost") {
    throw new Error("隧道转发必须使用已创建的隧道协议，请先创建隧道后再选择使用。");
  }
  const tunnelId = input.forwardType === "gost" ? Number(input.tunnelId || 0) || null : null;
  const actorContext = { user: actor };
  let hostId = Number(input.hostId || 0);
  let selectedTunnelForRule: any = null;
  let isTrafficBillingRule = false;
  if (tunnelId) {
    const access = await requireTunnelUseOrTrafficBillingAccess(actorContext, tunnelId);
    selectedTunnelForRule = access.tunnel;
    isTrafficBillingRule = !!access.isTrafficBillingResource;
    if (!dbBool(selectedTunnelForRule.isEnabled)) throw new Error("所选隧道已停用");
    const entryHostId = Number(selectedTunnelForRule.entryHostId || 0);
    if (hostId > 0 && hostId !== entryHostId) {
      throw new Error("所选隧道的入口 Agent 必须与规则所属主机一致");
    }
    hostId = entryHostId;
  } else {
    if (!hostId) throw new Error("请选择所属主机");
    const access = await requireHostUseAccess(actorContext, hostId);
    isTrafficBillingRule = !!access.isTrafficBillingResource;
    if (actor.role !== "admin" && !isTrafficBillingRule) {
      throw new Error("普通端口转发请先创建转发组或转发链后再新增规则。");
    }
  }

  let currentUser = await db.getUserById(actor.id);
  if (actor.role !== "admin") {
    currentUser = await requireForwardAccessReady(actor.id, { allowTrafficBillingRecovery: isTrafficBillingRule });
    await requireTrafficBillingBalanceForRule(actor.id, isTrafficBillingRule);
    if (String(selectedTunnelForRule?.mode || "").toLowerCase() === "forwardx" && !(currentUser as any)?.canAddRules) {
      throw new Error("无权使用 ForwardX 加密隧道");
    }
    if (currentUser?.expiresAt && new Date(currentUser.expiresAt) <= new Date()) {
      throw new Error("您的账户已到期，无法添加或启用规则");
    }
  }
  return { currentUser, hostId, tunnelId, selectedTunnelForRule, isTrafficBillingRule };
}

async function forwardGroupTrafficBillingCandidates(group: any) {
  const candidates: Array<{ resourceType: "host" | "tunnel" | "forward_group"; resourceId: number; member: boolean }> = [];
  const groupId = Number((group as any).id || 0);
  if (groupId > 0) candidates.push({ resourceType: "forward_group", resourceId: groupId, member: false });
  const pending = [group];
  const visited = new Set<number>();
  while (pending.length > 0) {
    const current = pending.shift();
    const currentId = Number(current?.id || 0);
    if (currentId <= 0 || visited.has(currentId)) continue;
    visited.add(currentId);
    const members = Array.isArray(current?.members) ? current.members : [];
    for (const member of members) {
      if (!dbBool(member?.isEnabled, true)) continue;
      const resourceType = member.memberType === "tunnel" ? "tunnel" : member.memberType === "host" ? "host" : null;
      const resourceId = resourceType === "tunnel" ? Number(member.tunnelId || 0) : resourceType === "host" ? Number(member.hostId || 0) : 0;
      if (!resourceType || resourceId <= 0) continue;
      candidates.push({ resourceType, resourceId, member: true });
    }
    const entryGroupId = Number(current?.entryGroupId || 0);
    if (entryGroupId > 0 && !visited.has(entryGroupId)) {
      const entryGroup = await db.getForwardGroupById(entryGroupId);
      if (entryGroup) pending.push(entryGroup);
    }
  }
  return Array.from(new Map(candidates.map((candidate) => [
    `${candidate.resourceType}:${candidate.resourceId}`,
    candidate,
  ])).values());
}

async function requireForwardGroupUseAccess(
  ctx: { user: { id: number; role: string } },
  forwardGroupId: number,
) {
  if (ctx.user.role === "admin") return { isTrafficBillingResource: false };
  const [group, snapshot] = await Promise.all([
    db.getForwardGroupById(forwardGroupId),
    db.getTrafficBillingAccessSnapshot(ctx.user.id),
  ]);
  if (!group) throw new Error("转发组不存在");
  if (snapshot.status === "failed") throw new Error("流量计费授权状态暂时无法确认，请稍后重试");
  let isTrafficBillingResource = false;
  let rootIsTrafficBillingResource = false;
  for (const candidate of await forwardGroupTrafficBillingCandidates(group)) {
    const state = db.trafficBillingSnapshotResourceState(snapshot, candidate.resourceType, candidate.resourceId);
    if (!state.active) continue;
    isTrafficBillingResource = true;
    if (!candidate.member) rootIsTrafficBillingResource = true;
    if (state.usable) continue;
    if (candidate.member) {
      throw new Error("转发组包含需要额外授权的流量计费成员，请联系管理员授权");
    }
    throw new Error("您没有使用该转发计费资源的权限，请联系管理员授权");
  }
  if (!rootIsTrafficBillingResource) {
    const hasPermission = await db.checkUserForwardGroupPermission(ctx.user.id, forwardGroupId);
    if (!hasPermission) throw new Error("无权使用该转发组");
  }
  return { isTrafficBillingResource };
}

async function assertRulePortWithinEntryPolicy(options: {
  hostId: number;
  sourcePort: number;
  tunnelId?: number | null;
  tunnel?: any;
}) {
  const port = Number(options.sourcePort || 0);
  if (!port) return;
  let policy = portPolicyFrom(null);
  if (Number(options.tunnelId || 0) > 0) {
    const tunnel = options.tunnel || await db.getTunnelById(Number(options.tunnelId));
    const entryHost = await db.getHostById(Number((tunnel as any)?.entryHostId || options.hostId));
    policy = combineHostPortPolicyWithRange(
      entryHost as any,
      (tunnel as any)?.portRangeStart,
      (tunnel as any)?.portRangeEnd,
    );
  } else {
    const host = await db.getHostById(Number(options.hostId));
    policy = portPolicyFrom(host as any);
  }
  if (!isPortAllowedByPolicy(port, policy)) {
    throw new Error(portPolicyErrorMessage(policy, "入口端口"));
  }
}

async function assertRulePortWithinUserPlanRange(options: {
  userId: number;
  hostId: number;
  sourcePort: number;
  tunnelId?: number | null;
}) {
  const port = Number(options.sourcePort || 0);
  if (!port) return;
  const planRange = await db.getUserPlanPortRange(
    Number(options.userId),
    Number(options.hostId),
    Number(options.tunnelId || 0) || undefined,
  );
  if (planRange && !db.isPortAllowedByUserPlanRange(port, planRange)) {
    const ranges = planRange.ranges.map((range) => `${range.start}-${range.end}`).join(",");
    throw new Error(`套餐端口必须在 ${ranges} 区间内`);
  }
}

async function assertForwardGroupPortWithinUserPlanRange(options: {
  userId: number;
  forwardGroupId: number;
  sourcePort: number;
}) {
  const port = Number(options.sourcePort || 0);
  if (!port) return;
  const planRange = await db.getUserForwardGroupPlanPortRange(
    Number(options.userId),
    Number(options.forwardGroupId),
  );
  if (planRange && !db.isPortAllowedByUserPlanRange(port, planRange)) {
    const ranges = planRange.ranges.map((range) => `${range.start}-${range.end}`).join(",");
    throw new Error(`套餐端口必须在 ${ranges} 区间内`);
  }
}

async function settleTrafficBillingForDeletedRule(rule: any) {
  const billed = await withKeyedTaskLock(trafficBillingUserLockKey(rule.userId), async () => {
    const billingResource = await db.findTrafficBillingResourceForRule(rule);
    const fallback = db.trafficBillingResourceCandidatesForRule(rule)[0];
    const resource = billingResource || fallback;
    const result = resource
      ? await db.settleTrafficBillingRuleOnDelete({
        userId: Number(rule.userId),
        ruleId: Number(rule.id),
        resourceType: resource.resourceType,
        resourceId: resource.resourceId,
      })
      : null;
    // Keep settlement and the state transition under the same user lock so a
    // traffic report cannot create fresh unsettled usage between them.
    await db.markForwardRulePendingDelete(Number(rule.id));
    return result;
  });
  if (billed && Number(billed.balanceAfterCents) < 0) {
    await db.setUserForwardAccess(Number(rule.userId), false, "traffic_billing_balance");
    await refreshUserForwardEndpoints(Number(rule.userId), "traffic-billing-delete-balance-negative");
  }
  return billed;
}

async function refreshPendingTemplateChildren(childRules: any[], reason: string) {
  const refreshedTunnelIds = new Set<number>();
  for (const child of childRules) {
    const tunnelId = Number((child as any).tunnelId || 0);
    if (tunnelId > 0 && !refreshedTunnelIds.has(tunnelId)) {
      refreshedTunnelIds.add(tunnelId);
      const tunnel = await db.getTunnelById(tunnelId);
      if (tunnel) await pushTunnelEndpointRefresh(tunnel, reason);
    }
  }
  const hostIds = Array.from(new Set(childRules
    .map((child: any) => Number(child.hostId || 0))
    .filter((hostId: number) => hostId > 0)));
  for (const hostId of hostIds) pushAgentRefresh(hostId, reason);
}

async function reconcileSharedTunnelPortsForRules(rules: any[]) {
  const tunnelIds = normalizePositiveIds(
    rules.map((rule: any) => Number(rule?.tunnelId || 0)),
  );
  for (const tunnelId of tunnelIds) {
    await reconcileSharedTunnelRulePorts(await db.getTunnelById(tunnelId));
  }
}

async function refreshRemainingSniSplitterRulesAfterTemplateDelete(templateRule: any, deletedChildRules: any[], reason: string) {
  const groupId = Number(templateRule?.forwardGroupId || 0);
  const splitterPort = Number(templateRule?.sniSplitterPort || 0);
  if (!groupId || !splitterPort || !normalizeSniValue(templateRule?.sni)) return;
  const deletedRuleIds = new Set(normalizePositiveIds([
    Number(templateRule?.id || 0),
    ...deletedChildRules.map((child: any) => Number(child?.id || 0)),
  ]));
  const remainingRuleIds = normalizePositiveIds(
    await db.getForwardGroupSniSplitterPortRuleIds(groupId, splitterPort),
  ).filter((id) => !deletedRuleIds.has(id));
  if (remainingRuleIds.length === 0) return;
  const remainingRules = (await db.getForwardRulesByIds(remainingRuleIds) as any[])
    .filter((rule: any) => (
      !dbBool(rule?.isForwardGroupTemplate)
      && dbBool(rule?.isEnabled)
      && !dbBool(rule?.pendingDelete)
      && Number(rule?.forwardGroupId || 0) === groupId
      && Number(rule?.sniSplitterPort || 0) === splitterPort
      && !!normalizeSniValue(rule?.sni)
    ));
  for (const rule of remainingRules) {
    await db.updateRuleRunningStatus(Number(rule.id), false);
  }
  await refreshPendingTemplateChildren(remainingRules, reason);
}

async function markTemplateChildrenPendingDelete(
  templateRuleId: number,
  reason: string,
  options: { deferRefresh?: boolean } = {},
) {
  const childRules = await db.getForwardGroupChildRulesForTemplate(templateRuleId);
  for (const child of childRules as any[]) {
    await settleTrafficBillingForDeletedRule(child);
    const tunnelId = Number((child as any).tunnelId || 0);
    if (tunnelId) {
      await db.updateTunnel(tunnelId, { isRunning: false } as any);
    }
  }
  await reconcileSharedTunnelPortsForRules(childRules as any[]);
  if (!options.deferRefresh) await refreshPendingTemplateChildren(childRules as any[], reason);
  return childRules;
}

export async function deleteForwardRuleForActor(
  actor: { id: number; role: string },
  ruleId: number,
  options: { reasonPrefix?: string } = {},
) {
  return withKeyedTaskLock(`rule:${ruleId}`, async () => {
    const rule = await db.getForwardRuleById(ruleId);
    if (!rule || dbBool((rule as any).pendingDelete)) throw new Error("规则不存在或已删除");
    if (actor.role !== "admin" && rule.userId !== actor.id) throw new Error("无权操作此规则");
    if ((rule as any).forwardGroupRuleId) throw new Error("转发组成员规则由系统维护，不能直接删除");
    const reasonPrefix = String(options.reasonPrefix || "forward-rule").trim() || "forward-rule";
    let chargedCents = 0;
    let balanceAfterCents: number | null = null;
    const collectBilling = (billed: any) => {
      if (!billed) return;
      chargedCents += Math.max(0, Number(billed.amountCents || 0));
      if (Number.isFinite(Number(billed.balanceAfterCents))) balanceAfterCents = Number(billed.balanceAfterCents);
    };

    if ((rule as any).isForwardGroupTemplate) {
      const childRules = await db.getForwardGroupChildRulesForTemplate(ruleId);
      for (const child of childRules as any[]) {
        collectBilling(await settleTrafficBillingForDeletedRule(child));
        const childTunnelId = Number((child as any).tunnelId || 0);
        if (childTunnelId > 0) {
          const tunnel = await db.getTunnelById(childTunnelId);
          await db.updateTunnel(childTunnelId, { isRunning: false } as any);
          if (tunnel) await pushTunnelEndpointRefresh(tunnel, `${reasonPrefix}-group-deleted`);
        }
        pushAgentRefresh(Number(child.hostId), `${reasonPrefix}-group-deleted`);
      }
      await reconcileSharedTunnelPortsForRules(childRules as any[]);
      collectBilling(await settleTrafficBillingForDeletedRule(rule));
      await db.runForwardGroupFailover(Number((rule as any).forwardGroupId || 0));
      // Templates never run on an Agent, so they cannot receive a runtime stop ACK.
      // Their managed children remain pending until each Agent confirms removal.
      await db.finalizeForwardRuleDelete(ruleId);
      await refreshRemainingSniSplitterRulesAfterTemplateDelete(rule, childRules as any[], `${reasonPrefix}-group-deleted`);
      return { success: true, rule, childRules, chargedCents, balanceAfterCents };
    }

    collectBilling(await settleTrafficBillingForDeletedRule(rule));
    if ((rule as any).tunnelId) {
      const tunnel = await db.getTunnelById((rule as any).tunnelId);
      await reconcileSharedTunnelRulePorts(tunnel);
      await db.updateTunnel((rule as any).tunnelId, { isRunning: false } as any);
      if (tunnel) await pushTunnelEndpointRefresh(tunnel, `${reasonPrefix}-deleted`);
    }
    pushAgentRefresh(rule.hostId, `${reasonPrefix}-deleted`);
    return { success: true, rule, childRules: [] as any[], chargedCents, balanceAfterCents };
  });
}

export async function toggleForwardRuleForActor(
  actor: { id: number; role: string },
  ruleId: number,
  isEnabled: boolean,
  options: { reasonPrefix?: string; confirmPortOccupancy?: boolean } = {},
) {
  return withKeyedTaskLock(`rule:${ruleId}`, async () => {
    let sourcePortReservation: HostPortReservation | null = null;
    let sniSplitterPortReservation: HostPortReservation | null = null;
    const directTunnelSniReservations: HostPortReservation[] = [];
    try {
      const rule = await db.getForwardRuleById(ruleId);
      if (!rule) throw new Error("规则不存在");
      if (actor.role !== "admin" && rule.userId !== actor.id) throw new Error("无权操作此规则");
      if ((rule as any).forwardGroupRuleId) throw new Error("转发组成员规则由系统维护，不能直接开关");
      let enabledPortCheck: Parameters<typeof rememberRulePortOwner>[1] | null = null;
      if (isEnabled) {
        const groupId = Number((rule as any).isForwardGroupTemplate ? rule.forwardGroupId : 0);
        const hostIds = groupId ? await db.getForwardGroupRuleEntryHostIds(groupId) : [Number(rule.hostId)];
        enabledPortCheck = {
          hostIds, port: Number(rule.sourcePort), protocol: (rule.protocol || "both") as "tcp" | "udp" | "both",
          forwardType: String(rule.forwardType), sni: rule.sni, forwardGroupId: groupId || undefined,
          tunnelId: Number(rule.tunnelId || 0) || undefined, excludeRuleId: ruleId,
          admin: actor.role === "admin",
        };
        await assertRulePortOccupancy({ ...enabledPortCheck, confirmed: options.confirmPortOccupancy });
      }
      if ((rule as any).isForwardGroupTemplate) {
        if (actor.role !== "admin") {
          const groupId = Number((rule as any).forwardGroupId || 0);
          if (isEnabled) {
            if (!groupId) throw new Error("转发组不存在");
            const access = await requireForwardGroupUseAccess({ user: actor }, groupId);
            const owner = await requireForwardAccessReady(actor.id, { allowTrafficBillingRecovery: access.isTrafficBillingResource });
            await requireTrafficBillingBalanceForRule(actor.id, access.isTrafficBillingResource);
            if (owner.expiresAt && new Date(owner.expiresAt) <= new Date()) {
              throw new Error("套餐已到期，请续费后再启用规则");
            }
            await assertForwardGroupPortWithinUserPlanRange({
              userId: actor.id,
              forwardGroupId: groupId,
              sourcePort: Number(rule.sourcePort),
            });
          }
        }
        if (isEnabled) {
          const groupId = Number((rule as any).forwardGroupId || 0);
          if (!groupId) throw new Error("转发组不存在");
          const ruleSni = normalizeSniInput((rule as any).sni);
          const nextProtocol = ruleSni ? "tcp" : (rule as any).protocol;
          const childRules = await db.getForwardGroupChildRulesForTemplate(ruleId);
          const ownRuleIds = normalizePositiveIds([
            Number(rule.id),
            ...(childRules as any[]).map((child: any) => Number(child.id)),
          ]);
          const entryHostIds = await db.getForwardGroupRuleEntryHostIds(groupId);
          const sniEntryPortValidation = await validateSniEntryPortUse({
            groupId,
            sourcePort: Number(rule.sourcePort || 0),
            entryHostIds,
            sni: ruleSni,
            excludeRuleIds: ownRuleIds,
          });
          const group = await db.validateForwardGroupRuleConfig(groupId, {
            sourcePort: rule.sourcePort,
            protocol: nextProtocol,
            excludeTemplateRuleId: rule.id,
            portUsageIgnoreRuleIds: sniEntryPortValidation.portUsageIgnoreRuleIds,
          });
          const isForwardChain = group.groupMode === "chain";
          const isPortGroup = group.groupMode === "port";
          const enableData: any = {
            isEnabled: true,
            isRunning: false,
            disabledByUser: false,
            disabledByTunnel: false,
            disabledByGroup: false,
            protocolBlockReason: null,
          };
          if (ruleSni) {
            if (!isForwardChain && !isPortGroup) {
              throw new Error("SNI 分流仅支持端口转发、隧道或转发链");
            }
            enableData.protocol = "tcp";
            enableData.sni = ruleSni;
            if (isPortGroup) {
              await inferForwardGroupSniExitHost(group);
              enableData.sniSplitterPort = Number(rule.sourcePort);
            } else {
              sniSplitterPortReservation = await reserveSniSplitterPortForForwardGroup(group, {
                currentPort: Number(sniEntryPortValidation.state.splitterPort || 0) || (rule as any).sniSplitterPort,
                excludeRuleIds: normalizePositiveIds([...ownRuleIds, ...sniEntryPortValidation.splitterPortUsageIgnoreRuleIds]),
              });
              enableData.sniSplitterPort = sniSplitterPortReservation.port;
            }
          }
          const groupIsTunnel = !isForwardChain && group.groupType === "tunnel";
          const groupTunnelSupportsFailover = groupIsTunnel ? await forwardGroupTunnelMembersSupportMainBackup(group) : true;
          requireMainBackupAllowed({
            enabled: isForwardChain || (groupIsTunnel && !groupTunnelSupportsFailover) ? false : (rule as any).failoverEnabled,
            protocol: nextProtocol,
            forwardType: !isForwardChain && group.groupType === "tunnel" ? "gost" : (rule as any).forwardType,
            isTunnelRoute: groupIsTunnel,
            isPortForwardGroup: isPortGroup,
            isAdmin: actor.role === "admin",
          });
          await db.updateForwardRule(ruleId, enableData);
        } else {
          await db.toggleForwardRule(ruleId, false);
        }
        await db.syncForwardGroupRules(Number((rule as any).forwardGroupId));
        await db.runForwardGroupFailover(Number((rule as any).forwardGroupId));
        for (const entryHostId of await db.getForwardGroupRuleEntryHostIds(Number((rule as any).forwardGroupId))) {
          await refreshRulePortWarningsForHost(entryHostId);
        }
        if (enabledPortCheck) rememberRulePortOwner(ruleId, enabledPortCheck);
        return { success: true, rule };
      }

      const directRuleSni = normalizeSniInput((rule as any).sni);
      const directRuleProtocol = directRuleSni ? "tcp" : (rule as any).protocol;
      await requireRuleProtocolEnabled({ ...rule, protocol: directRuleProtocol });
      let toggleTunnelForRule: any = null;
      const reasonPrefix = String(options.reasonPrefix || "forward-rule").trim() || "forward-rule";
      if ((rule as any).tunnelId) {
        toggleTunnelForRule = await db.getTunnelById((rule as any).tunnelId);
        await db.updateTunnel((rule as any).tunnelId, { isRunning: false } as any);
      }
      if (isEnabled) {
        let directTunnelSniState: DirectTunnelSniEntryPortState | null = null;
        let directTunnelSniPorts: Awaited<ReturnType<typeof reserveDirectTunnelSniRuntimePorts>> | null = null;
        if (directRuleSni) {
          assertSniRuleAdmin(actor, directRuleSni);
          if (!toggleTunnelForRule) throw new Error("SNI 分流仅支持端口转发、隧道或转发链");
          directTunnelSniState = await getDirectTunnelSniEntryPortState({
            tunnel: toggleTunnelForRule,
            sourcePort: Number(rule.sourcePort),
            sni: directRuleSni,
            excludeRuleIds: [Number(rule.id)],
          });
          assertDirectTunnelSniEntryPortUse(directTunnelSniState, Number(rule.sourcePort), directRuleSni);
          directTunnelSniPorts = await reserveDirectTunnelSniRuntimePorts({
            tunnel: toggleTunnelForRule,
            state: directTunnelSniState,
            currentSplitterPort: (rule as any).sniSplitterPort,
            currentTunnelExitPort: (rule as any).tunnelExitPort,
            ownerRuleIds: [Number(rule.id)],
            reservations: directTunnelSniReservations,
          });
        }
        requireMainBackupAllowed({
          enabled: directRuleSni ? false : (rule as any).failoverEnabled,
          protocol: directRuleProtocol,
          forwardType: (rule as any).forwardType,
          tunnelId: (rule as any).tunnelId,
          tunnelMode: toggleTunnelForRule?.mode,
          isAdmin: actor.role === "admin",
        });
        await assertRulePortWithinEntryPolicy({
          hostId: Number(rule.hostId),
          sourcePort: Number(rule.sourcePort),
          tunnelId: Number((rule as any).tunnelId || 0) || null,
        });
        if (actor.role !== "admin") {
          await assertRulePortWithinUserPlanRange({
            userId: actor.id,
            hostId: Number(rule.hostId),
            sourcePort: Number(rule.sourcePort),
            tunnelId: Number((rule as any).tunnelId || 0) || null,
          });
          const activeTunnelId = Number((rule as any).tunnelId || 0);
          const actorContext = { user: actor };
          const resourceAccess = activeTunnelId
            ? await requireTunnelUseOrTrafficBillingAccess(actorContext, activeTunnelId)
            : await requireHostUseAccess(actorContext, rule.hostId);
          const owner = await requireForwardAccessReady(actor.id, { allowTrafficBillingRecovery: !!resourceAccess.isTrafficBillingResource });
          await requireTrafficBillingBalanceForRule(actor.id, !!resourceAccess.isTrafficBillingResource);
          if (owner.expiresAt && new Date(owner.expiresAt) <= new Date()) {
            throw new Error("套餐已到期，请续费后再启用规则");
          }
        }
        sourcePortReservation = await reserveSpecificHostPort({
          hostId: Number(rule.hostId),
          port: Number(rule.sourcePort),
          protocol: directRuleProtocol,
          isUsed: (port) => db.isHostPortUnavailableForExplicitUse(
            Number(rule.hostId),
            port,
            normalizePositiveIds([Number(rule.id), ...(directTunnelSniState?.shareableRuleIds || [])]),
            directRuleProtocol,
            undefined,
            false,
          ),
        });
        if (!sourcePortReservation) throw new Error(`端口 ${rule.sourcePort} 已被占用，请更换端口后再启用`);
        await db.updateForwardRule(ruleId, {
          isEnabled: true,
          isRunning: false,
          disabledByUser: false,
          disabledByTunnel: false,
          disabledByGroup: false,
          protocolBlockReason: null,
          ...(directRuleSni ? {
            protocol: "tcp",
            sni: directRuleSni,
            sniSplitterPort: directTunnelSniPorts?.sniSplitterPort,
            tunnelExitPort: directTunnelSniPorts?.tunnelExitPort,
            failoverEnabled: false,
            failoverTargets: "[]",
          } : {}),
        } as any);
      } else {
        await db.toggleForwardRule(ruleId, false);
      }
      releaseHostPortReservations(directTunnelSniReservations);
      await reconcileSharedTunnelRulePorts(toggleTunnelForRule);
      if (toggleTunnelForRule) await pushTunnelEndpointRefresh(toggleTunnelForRule, `${reasonPrefix}-toggled`);
      pushAgentRefresh(Number(rule.hostId), `${reasonPrefix}-${isEnabled ? "enabled" : "disabled"}`);
      await refreshRulePortWarningsForHost(Number(rule.hostId));
      if (enabledPortCheck) rememberRulePortOwner(ruleId, enabledPortCheck);
      return { success: true, rule };
    } finally {
      sourcePortReservation?.release();
      sniSplitterPortReservation?.release();
      releaseHostPortReservations(directTunnelSniReservations);
    }
  });
}

export async function createDirectForwardRuleForActor(
  actor: { id: number; role: string; allowedForwardTypes?: string | null },
  input: any,
  options: { reasonPrefix?: string } = {},
) {
  await requireRuleTelegramNotifyReady(!!input.telegramErrorNotifyEnabled);
  const normalizedSni = normalizeSniInput(input.sni);
  assertSniRuleAdmin(actor, normalizedSni);
  const ruleProtocol = normalizedSni ? "tcp" : input.protocol;
  const { confirmPortOccupancy, ...createInput } = input;
  const ruleInput = {
    ...createInput,
    ...resolveSniRuleLimits(normalizedSni, input),
    ...(normalizedSni
      ? { protocol: "tcp", sni: normalizedSni, failoverEnabled: false, failoverTargets: [] }
      : {}),
  };
  const {
    currentUser,
    hostId,
    tunnelId,
    selectedTunnelForRule,
    isTrafficBillingRule,
  } = await prepareDirectRuleRouteForActor(actor, ruleInput);
  if (normalizedSni && !tunnelId) {
    throw new Error("SNI 分流仅支持端口转发、隧道或转发链");
  }
  requireMainBackupAllowed({
    enabled: ruleInput.failoverEnabled,
    protocol: ruleProtocol,
    forwardType: ruleInput.forwardType,
    tunnelId,
    tunnelMode: selectedTunnelForRule?.mode,
    isAdmin: actor.role === "admin",
  });
  await requireRuleProtocolEnabled({ forwardType: ruleInput.forwardType, tunnelId }, selectedTunnelForRule);
  if (!isTrafficBillingRule && Number((currentUser as any)?.trafficLimit || 0) > 0 && Number((currentUser as any)?.trafficUsed || 0) >= Number((currentUser as any)?.trafficLimit || 0)) {
    throw new Error("您的流量已用完，无法添加规则");
  }
  const host = await db.getHostById(hostId);
  if (!host) throw new Error("主机不存在");
  const entryPolicy = selectedTunnelForRule
    ? combineHostPortPolicyWithRange(
      host as any,
      (selectedTunnelForRule as any).portRangeStart,
      (selectedTunnelForRule as any).portRangeEnd,
    )
    : portPolicyFrom(host as any);
  const planRange = actor.role !== "admin"
    ? await db.getUserPlanPortRange(actor.id, hostId, tunnelId ?? undefined)
    : null;
  const effectivePolicy = planRange
    ? combinePortPolicies(entryPolicy, portPolicyFrom({
      portRanges: planRange.ranges,
    }))
    : entryPolicy;

  let sourcePort = Number(input.sourcePort || 0);
  let sourcePortReservation: HostPortReservation | null = null;
  let tunnelExitPortReservation: HostPortReservation | null = null;
  const sniRuntimePortReservations: HostPortReservation[] = [];
  let quotaReservation: RuleQuotaReservation | null = null;
  let directTunnelSniState: DirectTunnelSniEntryPortState | null = null;
  try {
    if (sourcePort === 0) {
      let randomRangeStart = selectedTunnelForRule ? (selectedTunnelForRule as any).portRangeStart : null;
      let randomRangeEnd = selectedTunnelForRule ? (selectedTunnelForRule as any).portRangeEnd : null;
      const occupiedPorts = await occupiedOnlineSnapshotPorts([hostId], ruleProtocol);
      sourcePortReservation = await reserveAvailableHostPort({
        hostId,
        protocol: ruleProtocol,
        findPort: (reservedPorts) => db.findAvailablePort(
          hostId,
          randomRangeStart,
          randomRangeEnd,
          ruleProtocol,
          [...reservedPorts, ...occupiedPorts],
          [],
          planRange?.ranges || [],
        ),
        isUsed: (port) => db.isHostPortUnavailableForAllocation(hostId, port, undefined, ruleProtocol),
      });
      if (!sourcePortReservation) throw new Error("该主机端口区间内已无可用端口");
      sourcePort = sourcePortReservation.port;
    } else {
      if (!isPortAllowedByPolicy(sourcePort, effectivePolicy)) throw new Error(portPolicyErrorMessage(effectivePolicy, "源端口"));
      if (tunnelId) {
        directTunnelSniState = await getDirectTunnelSniEntryPortState({
          tunnel: selectedTunnelForRule,
          sourcePort,
          sni: normalizedSni,
        });
        assertDirectTunnelSniEntryPortUse(directTunnelSniState, sourcePort, normalizedSni);
      }
      sourcePortReservation = tryReserveHostPort(hostId, sourcePort, ruleProtocol);
      if (!sourcePortReservation) throw new Error(`端口 ${sourcePort} 正在被其他请求分配，请稍后重试`);
      const used = await db.isHostPortUnavailableForExplicitUse(
        hostId,
        sourcePort,
        directTunnelSniState?.shareableRuleIds || undefined,
        ruleProtocol,
      );
      if (used) {
        sourcePortReservation.release();
        sourcePortReservation = null;
        throw new Error(`端口 ${sourcePort} 已被其他规则占用`);
      }
    }

    await assertRulePortOccupancy({
      hostIds: [hostId], port: sourcePort, protocol: ruleProtocol,
      forwardType: ruleInput.forwardType, sni: normalizedSni, tunnelId,
      admin: actor.role === "admin", confirmed: !!confirmPortOccupancy,
    });
    quotaReservation = await reserveRuleCreateQuota({
      userId: actor.id,
      maxRules: Number(currentUser?.maxRules || 0),
      maxPorts: Number(currentUser?.maxPorts || 0),
      getRuleCount: () => db.getUserRuleCount(actor.id),
      getPortCount: () => db.getUserPortCount(actor.id),
    });
    let tunnelExitPort: number | null = null;
    let sniSplitterPort: number | null = null;
    assertNoDirectSelfForwardLoop({ host, sourcePort, targetIp: ruleInput.targetIp, targetPort: ruleInput.targetPort, tunnelId });
    if (tunnelId) {
      const tunnel = selectedTunnelForRule;
      if (!dbBool(tunnel.isEnabled)) throw new Error("所选隧道已停用");
      if (Number(tunnel.entryHostId) !== hostId) throw new Error("所选隧道的入口 Agent 必须与规则所属主机一致");
      const exit = await db.getHostById(tunnel.exitHostId);
      if (normalizedSni) {
        directTunnelSniState = directTunnelSniState || await getDirectTunnelSniEntryPortState({
          tunnel,
          sourcePort,
          sni: normalizedSni,
        });
        assertDirectTunnelSniEntryPortUse(directTunnelSniState, sourcePort, normalizedSni);
        const prepared = await reserveDirectTunnelSniRuntimePorts({
          tunnel,
          state: directTunnelSniState,
          enabled: ruleInput.isEnabled !== false,
          reservations: sniRuntimePortReservations,
        });
        tunnelExitPort = prepared.tunnelExitPort;
        sniSplitterPort = prepared.sniSplitterPort;
      } else {
        // The primary managed GOST rule must point at the same listener that the
        // tunnel service binds. Legacy rows may contain a high/unrestricted port
        // after a NAT range was introduced; repair the tunnel first rather than
        // merely assigning a new bookkeeping port to the rule.
        const listenerRepair = usesSharedTunnelPrimaryListener(tunnel)
          ? await ensureTunnelListenerPortPolicy(tunnel, {
            hostId: Number(tunnel.exitHostId),
            syncSharedPrimaryRule: true,
          })
          : null;
        if (usesSharedTunnelPrimaryListener(tunnel) && !listenerRepair) {
          throw new Error("出口 Agent 已无可用隧道监听端口");
        }
        const sharedListenPort = await preferredSharedTunnelListenPort(tunnel, 0, input.isEnabled !== false);
        // Reuse the reservation acquired while repairing the listener when this
        // new rule is the shared primary. Secondary rules must release it and
        // allocate an independent exit port.
        if (listenerRepair?.reservation && Number(sharedListenPort || 0) === listenerRepair.port) {
          tunnelExitPortReservation = listenerRepair.reservation;
        } else {
          listenerRepair?.reservation.release();
        }
        if (!tunnelExitPortReservation) {
          tunnelExitPortReservation = await reserveTunnelExitPort({
            hostId: Number(tunnel.exitHostId),
            preferredStart: (exit as any)?.portRangeStart,
            preferredEnd: (exit as any)?.portRangeEnd,
            currentPort: sharedListenPort,
            // The configured nginx listener belongs to this tunnel and may be
            // reused by its primary rule; other resources remain conflicts.
            allowSameTunnelListener: Number(sharedListenPort || 0) > 0,
            excludeTunnelId: Number(tunnel.id),
            protocol: "both",
          });
        }
        if (!tunnelExitPortReservation) throw new Error("出口 Agent 已无可用隧道端口");
        tunnelExitPort = tunnelExitPortReservation.port;
      }
    }
    const runtimeOptionInput = tunnelId ? tunnelRuntimeOptionInput(selectedTunnelForRule) : ruleInput;
    const proxyProtocol = normalizeProxyProtocolInput(runtimeOptionInput, ruleProtocol, ruleInput.forwardType, false, { tunnelRoute: !!tunnelId, clearUnsupported: !!tunnelId });
    const transportTuning = normalizeTransportTuningInput(runtimeOptionInput, ruleProtocol, ruleInput.forwardType, false, { tunnelRoute: !!tunnelId, forwardxTunnel: String(selectedTunnelForRule?.mode || "").toLowerCase() === "forwardx", clearUnsupported: !!tunnelId });
    const id = await db.createForwardRule({
      ...ruleInput,
      ...normalizeFailoverInput(ruleInput, ruleProtocol),
      ...proxyProtocol,
      ...transportTuning,
      telegramErrorNotifyEnabled: !!input.telegramErrorNotifyEnabled,
      blockHttp: false,
      blockSocks: false,
      blockTls: false,
      sourcePort,
      hostId,
      targetIp: normalizeRuleTargetIp(ruleInput.targetIp, { tunnelId }),
      gostMode: "direct",
      gostRelayHost: null,
      gostRelayPort: null,
      tunnelId,
      tunnelExitPort,
      sni: normalizedSni,
      sniSplitterPort,
      userId: actor.id,
    });
    await quotaReservation.release();
    quotaReservation = null;
    if (tunnelId) {
      const tunnel = await db.getTunnelById(tunnelId);
      // Mapping reconciliation has its own reservation scope. Release the
      // primary allocation after the rule row exists so a same-port mapping
      // is not mistaken for an unrelated in-flight allocation.
      tunnelExitPortReservation?.release();
      tunnelExitPortReservation = null;
      releaseHostPortReservations(sniRuntimePortReservations);
      if (tunnel) await db.reconcileForwardRuleTunnelExits({ ...ruleInput, id, hostId, tunnelExitPort, sourcePort, tunnelId }, tunnel);
      await db.updateTunnel(tunnelId, { isRunning: false } as any);
      if (tunnel) await pushTunnelEndpointRefresh(tunnel, `${options.reasonPrefix || "forward-rule"}-created`);
    } else {
      pushAgentRefresh(hostId, `${options.reasonPrefix || "forward-rule"}-created`);
    }
    await refreshRulePortWarningsForHost(hostId);
    rememberRulePortOwner(id, { hostIds: [hostId], port: sourcePort, protocol: ruleProtocol,
      forwardType: ruleInput.forwardType, admin: actor.role === "admin" });
    return { id, sourcePort };
  } finally {
    await quotaReservation?.release();
    tunnelExitPortReservation?.release();
    releaseHostPortReservations(sniRuntimePortReservations);
    sourcePortReservation?.release();
  }
}

export const crudRulesRouter = router({
  checkSniImport: protectedProcedure
    .input(z.object({
      forwardGroupId: z.number().int().positive().nullable().optional(),
      tunnelId: z.number().int().positive().nullable().optional(),
      sourcePort: z.number().int().min(1).max(65535),
      rules: z.array(z.object({
        lineNumber: z.number().int().positive(),
        sni: z.string().min(1).max(1024),
      })).min(1).max(SNI_BULK_IMPORT_MAX_COUNT),
    }).refine(
      (value) => !!value.forwardGroupId !== !!value.tunnelId,
      { message: "请选择一个链路资源" },
    ))
    .mutation(async ({ input, ctx }) => {
      if (ctx.user.role !== "admin") {
        throw new Error("SNI 分流仅管理员可创建");
      }
      const tunnelId = Number(input.tunnelId || 0);
      const forwardGroupId = Number(input.forwardGroupId || 0);
      const tunnel = tunnelId > 0 ? await db.getTunnelById(tunnelId) : null;
      if (tunnelId > 0 && !tunnel) throw new Error("隧道不存在");
      const group = forwardGroupId > 0 ? await db.getForwardGroupById(forwardGroupId) : null;
      if (forwardGroupId > 0 && !group) throw new Error("链路资源不存在");
      let entryHostIds: number[] = [];
      if (tunnel) {
        await inferDirectTunnelSniExitHost(tunnel);
      } else {
        await inferForwardGroupSniExitHost(group as any);
        entryHostIds = await db.getForwardGroupRuleEntryHostIds(forwardGroupId);
        if (entryHostIds.length === 0) throw new Error("链路资源没有可用入口 Agent");
      }

      const seen = new Map<string, number>();
      const normalizedRules: Array<{ lineNumber: number; sni: string }> = [];
      for (const item of input.rules) {
        const prefix = sniImportLinePrefix(item.lineNumber);
        let sni: string | null = null;
        try {
          sni = normalizeSniInput(item.sni);
        } catch (error) {
          throw new Error(`${prefix}${error instanceof Error ? error.message : "SNI 域名格式不正确"}`);
        }
        if (!sni) throw new Error(`${prefix}SNI 域名不能为空`);
        const previousLine = seen.get(sni);
        if (previousLine !== undefined) {
          throw new Error(`${prefix}SNI 域名 ${sni} 与第 ${previousLine} 行重复`);
        }
        seen.set(sni, Number(item.lineNumber || normalizedRules.length + 1));
        normalizedRules.push({ lineNumber: item.lineNumber, sni });
      }

      for (const item of normalizedRules) {
        const prefix = sniImportLinePrefix(item.lineNumber);
        try {
          if (tunnel) {
            const state = await getDirectTunnelSniEntryPortState({
              tunnel,
              sourcePort: input.sourcePort,
              sni: item.sni,
            });
            assertDirectTunnelSniEntryPortUse(state, input.sourcePort, item.sni);
          } else {
            const sniEntryPortValidation = await validateSniEntryPortUse({
              groupId: forwardGroupId,
              sourcePort: input.sourcePort,
              entryHostIds,
              sni: item.sni,
            });
            await db.validateForwardGroupRuleConfig(forwardGroupId, {
              sourcePort: input.sourcePort,
              protocol: "tcp",
              portUsageIgnoreRuleIds: sniEntryPortValidation.portUsageIgnoreRuleIds,
            });
          }
        } catch (error) {
          throw new Error(`${prefix}${error instanceof Error ? error.message : "SNI 分流规则校验失败"}`);
        }
      }
      return { ok: true };
    }),
  create: protectedProcedure
    .input(z.object({
      hostId: z.number().optional(),
      name: z.string().min(1).max(128),
      forwardType: forwardTypeSchema.default("iptables"),
      protocol: z.enum(["tcp", "udp", "both"]).default("both"),
      gostMode: z.enum(["direct", "reverse"]).default("direct"),
      gostRelayHost: z.string().max(128).nullable().optional(),
      gostRelayPort: z.number().min(1).max(65535).nullable().optional(),
      tunnelId: z.number().nullable().optional(),
      forwardGroupId: z.number().nullable().optional(),
      sourcePort: z.number().min(0).max(65535), // 0 = 随机分配
      confirmPortOccupancy: z.boolean().optional().default(false),
      sni: sniInputSchema,
      targetIp: z.string().min(1).max(253).refine(
        (v) => /^[a-zA-Z0-9]([a-zA-Z0-9\-_.]*[a-zA-Z0-9])?$|^[a-fA-F0-9:.]+$/.test(v.trim()),
        "请输入有效的 IP 地址或域名"
      ),
      targetPort: z.number().min(1).max(65535),
      isEnabled: z.boolean().optional().default(true),
      telegramErrorNotifyEnabled: z.boolean().optional().default(false),
      blockHttp: z.boolean().optional(),
      blockSocks: z.boolean().optional(),
      blockTls: z.boolean().optional(),
      ...failoverInputShape,
      ...proxyProtocolInputShape,
      ...transportTuningInputShape,
      ...sniRuleLimitInputShape,
    }))
    .mutation(async ({ input, ctx }) => {
      await requireRuleTelegramNotifyReady(input.telegramErrorNotifyEnabled);
      // 权限检查：管理员或有 canAddRules 权限的用户
      let currentUser = await db.getUserById(ctx.user.id);
      const normalizedSni = normalizeSniInput(input.sni);
      assertSniRuleAdmin(ctx.user, normalizedSni);
      if (input.forwardGroupId) {
        const forwardGroupId = Number(input.forwardGroupId);
        return withKeyedTaskLock(`forward-group:${forwardGroupId}`, async () => {
        const groupReservations: HostPortReservation[] = [];
        let quotaReservation: RuleQuotaReservation | null = null;
        try {
        const randomSourcePort = input.sourcePort === 0;
        let sourcePort = input.sourcePort;
        const ruleProtocol = normalizedSni ? "tcp" : input.protocol;
        let planRange: Awaited<ReturnType<typeof db.getUserForwardGroupPlanPortRange>> = null;
        let groupAccess = { isTrafficBillingResource: false };
        if (ctx.user.role !== "admin") {
          groupAccess = await requireForwardGroupUseAccess(ctx, forwardGroupId);
          currentUser = await requireForwardAccessReady(ctx.user.id, { allowTrafficBillingRecovery: groupAccess.isTrafficBillingResource });
          if (currentUser?.expiresAt && new Date(currentUser.expiresAt) <= new Date()) {
            throw new Error("您的账户已到期，无法添加规则");
          }
          planRange = await db.getUserForwardGroupPlanPortRange(ctx.user.id, forwardGroupId);
          if (sourcePort > 0 && planRange && !db.isPortAllowedByUserPlanRange(sourcePort, planRange)) {
            const ranges = planRange.ranges.map((range) => `${range.start}-${range.end}`).join(",");
            throw new Error(`套餐端口必须在 ${ranges} 内`);
          }
        }
        if (normalizedSni) {
          const sniGroup = await db.getForwardGroupById(forwardGroupId);
          if (!sniGroup) throw new Error("Forward group does not exist");
          await inferForwardGroupSniExitHost(sniGroup);
        }
        const entryHostIds = await db.getForwardGroupRuleEntryHostIds(forwardGroupId);
        let sniEntryPortValidation: SniEntryPortValidation | null = null;
        const reserveEntryPortFor = async (
          port: number,
          isUnavailable: (hostId: number, candidate: number) => Promise<boolean>,
        ) => {
          const reservations: HostPortReservation[] = [];
          try {
            for (const entryHostId of entryHostIds) {
              const reservation = await reserveSpecificHostPort({
                hostId: entryHostId,
                port,
                protocol: ruleProtocol,
                isUsed: (candidate) => isUnavailable(entryHostId, candidate),
              });
              if (!reservation) {
                releaseHostPortReservations(reservations);
                return null;
              }
              reservations.push(reservation);
            }
            return reservations;
          } catch (error) {
            releaseHostPortReservations(reservations);
            throw error;
          }
        };
        const reserveEntryPortForAllocation = (port: number) => reserveEntryPortFor(
          port,
          (entryHostId, candidate) => db.isHostPortUnavailableForAllocation(entryHostId, candidate, undefined, ruleProtocol),
        );
        const reserveEntryPortForExplicitUse = (port: number) => reserveEntryPortFor(
          port,
          (entryHostId, candidate) => db.isHostPortUnavailableForExplicitUse(entryHostId, candidate, undefined, ruleProtocol),
        );
        if (randomSourcePort) {
          const unavailablePorts = new Set([...entryHostIds.flatMap((hostId) => reservedHostPorts(hostId, ruleProtocol)),
            ...await occupiedOnlineSnapshotPorts(entryHostIds, ruleProtocol)]);
          for (let attempt = 0; attempt < 256; attempt += 1) {
            const availablePort = await db.findAvailableForwardGroupPort(
              forwardGroupId,
              undefined,
              planRange,
              ruleProtocol,
              unavailablePorts,
            );
            if (!availablePort) break;
            unavailablePorts.add(availablePort);
            const reservations = await reserveEntryPortForAllocation(availablePort);
            if (!reservations) continue;
            sourcePort = availablePort;
            groupReservations.push(...reservations);
            break;
          }
          if (sourcePort === 0) throw new Error("转发组入口端口区间内已无可用端口");
        } else {
          sniEntryPortValidation = await validateSniEntryPortUse({
            groupId: forwardGroupId,
            sourcePort,
            entryHostIds,
            sni: normalizedSni,
          });
          const reservations = normalizedSni
            ? await reserveEntryPortFor(
              sourcePort,
              (entryHostId, candidate) => db.isHostPortUnavailableForExplicitUse(entryHostId, candidate, sniEntryPortValidation?.portUsageIgnoreRuleIds || [], ruleProtocol),
            )
            : await reserveEntryPortForExplicitUse(sourcePort);
          if (!reservations) throw new Error(`入口 Agent 端口 ${sourcePort} 已被占用或正在分配`);
          groupReservations.push(...reservations);
        }
        sniEntryPortValidation = sniEntryPortValidation || await validateSniEntryPortUse({
          groupId: forwardGroupId,
          sourcePort,
          entryHostIds,
          sni: normalizedSni,
        });
        const occupancyGroup = await db.getForwardGroupById(forwardGroupId);
        await assertRulePortOccupancy({
          hostIds: entryHostIds, port: sourcePort, protocol: ruleProtocol,
          forwardType: lockedForwardTypeForGroup(occupancyGroup, input.forwardType),
          sni: normalizedSni, forwardGroupId, admin: ctx.user.role === "admin",
          confirmed: input.confirmPortOccupancy,
        });
        const preparedGroupRuntime = await prepareForwardGroupRuntimePorts({
          groupId: forwardGroupId,
          sourcePort,
          protocol: ruleProtocol,
          sni: normalizedSni,
          sniEntryPortValidation,
          reservations: groupReservations,
        });
        const { group, isForwardChain, isPortGroup, sniSplitterPort } = preparedGroupRuntime;
        if (ctx.user.role !== "admin") {
          await requireTrafficBillingBalanceForRule(ctx.user.id, groupAccess.isTrafficBillingResource);
        }
        const hostId = await db.getForwardGroupDefaultHostId(forwardGroupId);
        const forwardType = lockedForwardTypeForGroup(group, input.forwardType);
        requireForwardTypeAllowedForActor(ctx.user, forwardType);
        const groupIsTunnel = !isForwardChain && group.groupType === "tunnel";
        if (!isForwardChain && !groupIsTunnel) {
          const host = await db.getHostById(hostId);
          assertNoDirectSelfForwardLoop({
            host,
            sourcePort,
            targetIp: input.targetIp,
            targetPort: input.targetPort,
            tunnelId: null,
          });
        }
        const groupTunnelSupportsFailover = groupIsTunnel ? await forwardGroupTunnelMembersSupportMainBackup(group) : true;
        const groupSupportsFailover = !isForwardChain && ruleProtocol === "tcp" && forwardType === "gost" && (!groupIsTunnel || groupTunnelSupportsFailover);
        const createFailoverEnabled = groupSupportsFailover ? input.failoverEnabled : false;
        requireMainBackupAllowed({
          enabled: createFailoverEnabled,
          protocol: ruleProtocol,
          forwardType,
          isTunnelRoute: groupIsTunnel,
          isPortForwardGroup: isPortGroup,
          isAdmin: ctx.user.role === "admin",
        });
        if (ctx.user.role !== "admin") {
          quotaReservation = await reserveRuleCreateQuota({
            userId: ctx.user.id,
            maxRules: Number(currentUser?.maxRules || 0),
            maxPorts: Number(currentUser?.maxPorts || 0),
            getRuleCount: () => db.getUserRuleCount(ctx.user.id),
            getPortCount: () => db.getUserPortCount(ctx.user.id),
          });
        }
        await requireRuleProtocolEnabled({ forwardType, tunnelId: null });
        const createTemplateRule = () => db.createForwardRule({
          hostId,
          name: input.name,
          forwardType,
          protocol: ruleProtocol,
          gostMode: "direct",
          gostRelayHost: null,
          gostRelayPort: null,
          tunnelId: null,
          tunnelExitPort: null,
          forwardGroupId,
          forwardGroupRuleId: null,
          forwardGroupMemberId: null,
          isForwardGroupTemplate: true,
          sourcePort,
          sni: normalizedSni,
          sniSplitterPort,
          ...resolveSniRuleLimits(normalizedSni, input),
          targetIp: normalizeRuleTargetIp(input.targetIp, { tunnelId: forwardType === "gost" && !isForwardChain && group.groupType === "tunnel" ? 1 : null }),
          targetPort: input.targetPort,
          isEnabled: input.isEnabled,
          telegramErrorNotifyEnabled: !!input.telegramErrorNotifyEnabled,
          blockHttp: false,
          blockSocks: false,
          blockTls: false,
          ...normalizeProxyProtocolInput(
            input,
            ruleProtocol,
            forwardType,
            isForwardChain,
            { tunnelRoute: !isForwardChain && group.groupType === "tunnel", clearUnsupported: true },
          ),
          ...normalizeTransportTuningInput(
            input,
            ruleProtocol,
            forwardType,
            isForwardChain,
            { tunnelRoute: !isForwardChain && group.groupType === "tunnel", forwardxTunnel: false, clearUnsupported: true },
          ),
          ...normalizeFailoverInput({
            ...input,
            failoverEnabled: createFailoverEnabled,
            failoverTargets: createFailoverEnabled ? input.failoverTargets : [],
          }, ruleProtocol),
          isRunning: false,
          userId: ctx.user.id,
        } as any);
        let id = 0;
        if (isForwardChain) {
          id = await db.withForwardGroupSyncTransaction(forwardGroupId, createTemplateRule);
        } else {
          id = await createTemplateRule();
          await db.syncForwardGroupRules(forwardGroupId);
        }
        await quotaReservation?.release();
        quotaReservation = null;
        await db.runForwardGroupFailover(forwardGroupId);
        for (const entryHostId of entryHostIds) await refreshRulePortWarningsForHost(entryHostId);
        rememberRulePortOwner(id, { hostIds: entryHostIds, port: sourcePort, protocol: ruleProtocol,
          forwardType, admin: ctx.user.role === "admin" });
        return { id, sourcePort };
        } finally {
          await quotaReservation?.release();
          releaseHostPortReservations(groupReservations);
        }
        });
      }

      if (normalizedSni) {
        const tunnelId = input.forwardType === "gost" ? Number(input.tunnelId || 0) : 0;
        if (!tunnelId) throw new Error("SNI 分流仅支持端口转发、隧道或转发链");
        return withKeyedTaskLock(`tunnel-sni:${tunnelId}:${Number(input.sourcePort || 0)}`, () => (
          createDirectForwardRuleForActor(ctx.user, { ...input, protocol: "tcp", sni: normalizedSni })
        ));
      }
      return createDirectForwardRuleForActor(ctx.user, input);
    }),
  update: protectedProcedure
    .input(z.object({
      id: z.number(),
      hostId: z.number().optional(),
      name: z.string().min(1).max(128).optional(),
      forwardType: forwardTypeSchema.optional(),
      protocol: z.enum(["tcp", "udp", "both"]).optional(),
      gostMode: z.enum(["direct", "reverse"]).optional(),
      gostRelayHost: z.string().max(128).nullable().optional(),
      gostRelayPort: z.number().min(1).max(65535).nullable().optional(),
      tunnelId: z.number().nullable().optional(),
      tunnelExitPort: z.number().min(1).max(65535).nullable().optional(),
      forwardGroupId: z.number().nullable().optional(),
      sourcePort: z.number().min(0).max(65535).optional(),
      confirmPortOccupancy: z.boolean().optional().default(false),
      sni: sniInputSchema,
      targetIp: z.string().min(1).max(253).refine(
        (v) => /^[a-zA-Z0-9]([a-zA-Z0-9\-_.]*[a-zA-Z0-9])?$|^[a-fA-F0-9:.]+$/.test(v.trim()),
        "请输入有效的 IP 地址或域名"
      ).optional(),
      targetPort: z.number().min(1).max(65535).optional(),
      telegramErrorNotifyEnabled: z.boolean().optional(),
      blockHttp: z.boolean().optional(),
      blockSocks: z.boolean().optional(),
      blockTls: z.boolean().optional(),
      ...failoverInputShape,
      ...proxyProtocolInputShape,
      ...transportTuningInputShape,
      ...sniRuleLimitInputShape,
      isEnabled: z.boolean().optional(),
    }))
    .mutation(async ({ input, ctx }) => withKeyedTaskLock(`rule:${input.id}`, async () => {
      const heldReservations: HostPortReservation[] = [];
      // Keep the primary tunnel-exit reservation separate from source-port
      // reservations. It is released immediately after the rule row is
      // written, before the mapping reconciler acquires its own reservations.
      // Holding both would make a same-port mapping look externally busy and
      // could cause needless port churn on every edit.
      let tunnelExitPortReservationForUpdate: HostPortReservation | null = null;
      let tunnelExitPortReservationForConversion: HostPortReservation | null = null;
      const reserveRulePort = async (hostId: number, port: number, protocol: "tcp" | "udp" | "both", excludeRuleIds: number | number[]) => {
        const existing = heldReservations.find((reservation) => (
          reservation.hostId === Number(hostId)
          && reservation.port === Number(port)
          && reservation.protocol === protocol
        ));
        if (existing) return existing;
        const reservation = await reserveSpecificHostPort({
          hostId,
          port,
          protocol,
          isUsed: (candidate) => db.isHostPortUnavailableForExplicitUse(hostId, candidate, excludeRuleIds, protocol, undefined, false),
        });
        if (reservation) heldReservations.push(reservation);
        return reservation;
      };
      const reserveForwardGroupEntryPorts = async (
        groupId: number,
        port: number,
        protocol: "tcp" | "udp" | "both",
        excludeRuleIds: number[],
      ) => {
        const hostIds = await db.getForwardGroupRuleEntryHostIds(groupId);
        const outcomes = await Promise.allSettled(hostIds.map((hostId) => (
          reserveRulePort(hostId, port, protocol, excludeRuleIds)
        )));
        const failed = outcomes.find((outcome) => outcome.status === "rejected") as PromiseRejectedResult | undefined;
        if (failed) throw failed.reason;
        if (outcomes.some((outcome) => outcome.status === "fulfilled" && !outcome.value)) {
          throw new Error(`Port ${port} is already used or being allocated on a forward-group entry host`);
        }
      };
      try {
      const rule = await db.getForwardRuleById(input.id);
      if (!rule) throw new Error("规则不存在");
      if (ctx.user.role !== "admin" && rule.userId !== ctx.user.id) throw new Error("无权操作此规则");
      if ((rule as any).forwardGroupRuleId) throw new Error("转发组成员规则由系统维护，不能直接修改");
      const confirmedPortOccupancy = input.confirmPortOccupancy;
      delete (input as any).confirmPortOccupancy;
      await requireRuleTelegramNotifyReady(input.telegramErrorNotifyEnabled);
      const normalizedInputSni = input.sni !== undefined ? normalizeSniInput(input.sni) : undefined;
      if (normalizedInputSni || (ctx.user.role !== "admin" && normalizeSniInput((rule as any).sni))) {
        assertSniRuleAdmin(ctx.user, normalizedInputSni || normalizeSniInput((rule as any).sni));
      }

      if (input.sourcePort === 0) {
        const nextSniForPortAllocation = normalizedInputSni !== undefined ? normalizedInputSni : normalizeSniInput((rule as any).sni);
        const nextProtocol = nextSniForPortAllocation ? "tcp" : input.protocol ?? (rule as any).protocol;
        const childRules = (rule as any).isForwardGroupTemplate
          ? await db.getForwardGroupChildRulesForTemplate(Number(rule.id))
          : [];
        const excludeRuleIds = [
          Number(rule.id),
          ...(childRules as any[]).map((child: any) => Number(child.id)),
        ].filter((id) => Number.isInteger(id) && id > 0);
        const nextForwardGroupId = input.forwardGroupId !== undefined
          ? Number(input.forwardGroupId || 0)
          : (rule as any).isForwardGroupTemplate
            ? Number((rule as any).forwardGroupId || 0)
            : 0;

        if (nextForwardGroupId > 0) {
          let planRange: Awaited<ReturnType<typeof db.getUserForwardGroupPlanPortRange>> = null;
          if (ctx.user.role !== "admin") {
            await requireForwardGroupUseAccess(ctx, nextForwardGroupId);
            planRange = await db.getUserForwardGroupPlanPortRange(ctx.user.id, nextForwardGroupId);
          }
          const entryHostIds = await db.getForwardGroupRuleEntryHostIds(nextForwardGroupId);
          const unavailablePorts = new Set([...entryHostIds.flatMap((hostId) => reservedHostPorts(hostId, nextProtocol)),
            ...await occupiedOnlineSnapshotPorts(entryHostIds, nextProtocol)]);
          let selectedPort = 0;
          for (let attempt = 0; attempt < 256; attempt += 1) {
            const candidate = await db.findAvailableForwardGroupPort(
              nextForwardGroupId,
              Number(rule.id),
              planRange,
              nextProtocol,
              unavailablePorts,
            );
            if (!candidate) break;
            unavailablePorts.add(candidate);
            const candidateReservations: HostPortReservation[] = [];
            let reservedEveryEntry = true;
            try {
              for (const hostId of entryHostIds) {
                const reservation = await reserveSpecificHostPort({
                  hostId,
                  port: candidate,
                  protocol: nextProtocol,
                  isUsed: (port) => db.isHostPortUnavailableForAllocation(hostId, port, excludeRuleIds, nextProtocol, undefined, false),
                });
                if (!reservation) {
                  reservedEveryEntry = false;
                  break;
                }
                candidateReservations.push(reservation);
              }
            } catch (error) {
              releaseHostPortReservations(candidateReservations);
              throw error;
            }
            if (!reservedEveryEntry) {
              releaseHostPortReservations(candidateReservations);
              continue;
            }
            heldReservations.push(...candidateReservations);
            selectedPort = candidate;
            break;
          }
          if (!selectedPort) throw new Error("转发组入口端口区间内已无可用端口");
          input.sourcePort = selectedPort;
        } else {
          const nextForwardType = input.forwardType ?? (rule as any).forwardType;
          const nextTunnelId = nextForwardType === "gost"
            ? Number(input.tunnelId !== undefined ? input.tunnelId : (rule as any).tunnelId) || null
            : null;
          let nextHostId = Number(input.hostId ?? (rule as any).hostId);
          let rangeStart: number | null | undefined;
          let rangeEnd: number | null | undefined;
          let planRange: Awaited<ReturnType<typeof db.getUserPlanPortRange>> = null;
          if (nextTunnelId) {
            const { tunnel } = await requireTunnelUseOrTrafficBillingAccess(ctx, nextTunnelId);
            nextHostId = Number((tunnel as any).entryHostId || 0);
            rangeStart = (tunnel as any).portRangeStart;
            rangeEnd = (tunnel as any).portRangeEnd;
          } else {
            await requireHostUseAccess(ctx, nextHostId);
          }
          if (ctx.user.role !== "admin") {
            planRange = await db.getUserPlanPortRange(ctx.user.id, nextHostId, nextTunnelId || undefined);
          }
          const occupiedPorts = await occupiedOnlineSnapshotPorts([nextHostId], nextProtocol);
          const reservation = await reserveAvailableHostPort({
            hostId: nextHostId,
            protocol: nextProtocol,
            findPort: (reservedPorts) => db.findAvailablePort(
              nextHostId,
              rangeStart,
              rangeEnd,
              nextProtocol,
              [...reservedPorts, ...occupiedPorts],
              excludeRuleIds,
              planRange?.ranges || [],
            ),
            isUsed: (port) => db.isHostPortUnavailableForAllocation(nextHostId, port, excludeRuleIds, nextProtocol, undefined, false),
            maxAttempts: 256,
          });
          if (!reservation) throw new Error("入口 Agent 端口区间内已无可用端口");
          heldReservations.push(reservation);
          input.sourcePort = reservation.port;
        }
      }

      const nextGroupIdForOccupancy = Number(input.forwardGroupId !== undefined ? input.forwardGroupId :
        ((rule as any).isForwardGroupTemplate ? rule.forwardGroupId : 0)) || 0;
      const nextPortForOccupancy = Number(input.sourcePort ?? rule.sourcePort);
      const nextSniForOccupancy = input.sni !== undefined ? input.sni : rule.sni;
      const nextProtocolForOccupancy = (nextSniForOccupancy ? "tcp" : (input.protocol ?? rule.protocol)) as "tcp" | "udp" | "both";
      const nextTypeForOccupancy = nextGroupIdForOccupancy
        ? lockedForwardTypeForGroup(await db.getForwardGroupById(nextGroupIdForOccupancy), input.forwardType ?? rule.forwardType)
        : String(input.forwardType ?? rule.forwardType);
      const nextTunnelForOccupancy = Number(input.tunnelId !== undefined ? input.tunnelId : rule.tunnelId) || 0;
      const nextHostForOccupancy = nextTunnelForOccupancy
        ? Number((await db.getTunnelById(nextTunnelForOccupancy))?.entryHostId || 0)
        : Number(input.hostId ?? rule.hostId);
      const occupancyRelevantChange = nextPortForOccupancy !== Number(rule.sourcePort) ||
        nextProtocolForOccupancy !== rule.protocol || nextTypeForOccupancy !== rule.forwardType ||
        nextHostForOccupancy !== Number(rule.hostId) || nextGroupIdForOccupancy !== Number(rule.forwardGroupId || 0) ||
        (input.isEnabled === true && !dbBool(rule.isEnabled));
      const nextPortCheck = {
        hostIds: nextGroupIdForOccupancy ? await db.getForwardGroupRuleEntryHostIds(nextGroupIdForOccupancy) : [nextHostForOccupancy],
        port: nextPortForOccupancy, protocol: nextProtocolForOccupancy, forwardType: nextTypeForOccupancy,
        sni: nextSniForOccupancy, forwardGroupId: nextGroupIdForOccupancy || undefined,
        tunnelId: nextTunnelForOccupancy || undefined, excludeRuleId: Number(rule.id),
        admin: ctx.user.role === "admin", confirmed: confirmedPortOccupancy,
      };
      const refreshUpdatedRulePortWarnings = async () => {
        rememberRulePortOwner(Number(rule.id), nextPortCheck);
        const previousHosts = (rule as any).isForwardGroupTemplate && Number(rule.forwardGroupId) > 0
          ? await db.getForwardGroupRuleEntryHostIds(Number(rule.forwardGroupId)) : [Number(rule.hostId)];
        for (const hostId of new Set([...previousHosts, ...nextPortCheck.hostIds])) {
          if (hostId > 0) await refreshRulePortWarningsForHost(hostId);
        }
      };
      if ((occupancyRelevantChange ||
          (["iptables", "nftables"].includes(nextTypeForOccupancy) && rulePortOwnerChanged(Number(rule.id), nextPortCheck))) &&
          (input.isEnabled !== false && dbBool(rule.isEnabled) || input.isEnabled === true)) {
        await assertRulePortOccupancy(nextPortCheck);
      }

      if ((rule as any).isForwardGroupTemplate) {
        const groupId = Number((rule as any).forwardGroupId || 0);
        if (input.forwardGroupId === null) {
          if (!groupId) throw new Error("Forward group does not exist");
          const childRules = await db.getForwardGroupChildRulesForTemplate(input.id);
          const excludeRuleIds = [
            Number(rule.id),
            ...(childRules as any[]).map((child: any) => Number(child.id)),
          ].filter((id) => Number.isInteger(id) && id > 0);
          const nextForwardType = input.forwardType ?? (rule as any).forwardType;
          const requestedTunnelId = nextForwardType === "gost"
            ? Number(input.tunnelId !== undefined ? input.tunnelId : (rule as any).tunnelId) || null
            : null;
          const route = await prepareDirectRuleRouteForActor(
            {
              id: ctx.user.id,
              role: ctx.user.role,
              allowedForwardTypes: (ctx.user as any).allowedForwardTypes,
            },
            {
              forwardType: nextForwardType,
              tunnelId: requestedTunnelId,
              hostId: input.hostId !== undefined
                ? Number(input.hostId)
                : requestedTunnelId
                  ? null
                  : Number((rule as any).hostId),
            },
          );
          const nextTunnelId = route.tunnelId;
          const selectedTunnelForRule = route.selectedTunnelForRule;
          const nextHostId = route.hostId;

          const nextSni = normalizedInputSni !== undefined
            ? normalizedInputSni
            : normalizeSniInput((rule as any).sni);
          assertSniRuleAdmin(ctx.user, nextSni);
          if (nextSni && !nextTunnelId) {
            throw new Error("SNI 分流仅支持端口转发、隧道或转发链");
          }
          const nextProtocol = nextSni ? "tcp" : input.protocol ?? (rule as any).protocol;
          const nextSourcePort = Number(input.sourcePort ?? (rule as any).sourcePort);
          const nextMainBackupEnabled = false;
          requireMainBackupAllowed({
            enabled: nextMainBackupEnabled,
            protocol: nextProtocol,
            forwardType: nextForwardType,
            tunnelId: nextTunnelId,
            isAdmin: ctx.user.role === "admin",
          });
          await requireRuleProtocolEnabled({ ...rule, forwardType: nextForwardType, tunnelId: nextTunnelId }, selectedTunnelForRule);
          await assertRulePortWithinEntryPolicy({
            hostId: nextHostId,
            sourcePort: nextSourcePort,
            tunnelId: nextTunnelId,
            tunnel: selectedTunnelForRule,
          });
          if (ctx.user.role !== "admin") {
            const planRange = await db.getUserPlanPortRange(ctx.user.id, nextHostId, nextTunnelId || undefined);
            if (planRange && !db.isPortAllowedByUserPlanRange(nextSourcePort, planRange)) {
              const ranges = planRange.ranges.map((range) => `${range.start}-${range.end}`).join(",");
              throw new Error(`套餐端口必须在 ${ranges} 区间内`);
            }
          }
          let directTunnelSniState: DirectTunnelSniEntryPortState | null = null;
          if (nextTunnelId && selectedTunnelForRule) {
            directTunnelSniState = await getDirectTunnelSniEntryPortState({
              tunnel: selectedTunnelForRule,
              sourcePort: nextSourcePort,
              sni: nextSni,
              excludeRuleIds,
            });
            assertDirectTunnelSniEntryPortUse(directTunnelSniState, nextSourcePort, nextSni);
          }
          const sourceReservation = await reserveRulePort(
            nextHostId,
            nextSourcePort,
            nextProtocol,
            normalizePositiveIds([...excludeRuleIds, ...(directTunnelSniState?.shareableRuleIds || [])]),
          );
          if (!sourceReservation) throw new Error(`Port ${nextSourcePort} is already used or being allocated`);
          if (!nextTunnelId) {
            const host = await db.getHostById(nextHostId);
            assertNoDirectSelfForwardLoop({
              host,
              sourcePort: nextSourcePort,
              targetIp: input.targetIp ?? (rule as any).targetIp,
              targetPort: Number(input.targetPort ?? (rule as any).targetPort),
              tunnelId: nextTunnelId,
            });
          }

          let tunnelExitPort: number | null = null;
          let sniSplitterPort: number | null = null;
          if (nextTunnelId) {
            const tunnel = selectedTunnelForRule;
            const exit = await db.getHostById(tunnel.exitHostId);
            const existingExitPort = Number((rule as any).tunnelExitPort || 0);
            if (nextSni && directTunnelSniState) {
              const prepared = await reserveDirectTunnelSniRuntimePorts({
                tunnel,
                state: directTunnelSniState,
                currentSplitterPort: (rule as any).sniSplitterPort,
                currentTunnelExitPort: existingExitPort,
                ownerRuleIds: excludeRuleIds,
                enabled: input.isEnabled !== undefined ? dbBool(input.isEnabled) : dbBool((rule as any).isEnabled),
                reservations: heldReservations,
              });
              tunnelExitPort = prepared.tunnelExitPort;
              sniSplitterPort = prepared.sniSplitterPort;
            } else {
              const listenerRepair = usesSharedTunnelPrimaryListener(tunnel)
                ? await ensureTunnelListenerPortPolicy(tunnel, {
                  hostId: Number(tunnel.exitHostId),
                  syncSharedPrimaryRule: true,
                })
                : null;
              if (usesSharedTunnelPrimaryListener(tunnel) && !listenerRepair) {
                throw new Error("Tunnel exit agent has no available listener port");
              }
              const sharedListenPort = await preferredSharedTunnelListenPort(
                tunnel,
                Number(rule.id),
                input.isEnabled !== undefined ? dbBool(input.isEnabled) : dbBool((rule as any).isEnabled),
              );
              let exitReservation: HostPortReservation | null = null;
              if (listenerRepair?.reservation && Number(sharedListenPort || 0) === listenerRepair.port) {
                exitReservation = listenerRepair.reservation;
              } else {
                listenerRepair?.reservation.release();
              }
              if (!exitReservation) {
                exitReservation = await reserveTunnelExitPort({
                  hostId: Number(tunnel.exitHostId),
                  preferredStart: (exit as any)?.portRangeStart,
                  preferredEnd: (exit as any)?.portRangeEnd,
                  currentPort: sharedListenPort ?? existingExitPort,
                  reservedPorts: [],
                  excludeRuleIds,
                  allowSameTunnelListener: Number(sharedListenPort || 0) > 0,
                  excludeTunnelId: Number(tunnel.id),
                  protocol: "both",
                });
              }
              if (!exitReservation) throw new Error("Tunnel exit agent has no available port");
              tunnelExitPortReservationForConversion = exitReservation;
              tunnelExitPort = exitReservation.port;
            }
          }

          const failoverData = normalizeFailoverInput({
            failoverEnabled: false,
            failoverTargets: [],
          }, nextProtocol);
          const data: any = {
            name: input.name ?? (rule as any).name,
            hostId: nextHostId,
            forwardType: nextForwardType,
            protocol: nextProtocol,
            gostMode: "direct",
            gostRelayHost: null,
            gostRelayPort: null,
            tunnelId: nextTunnelId,
            tunnelExitPort,
            forwardGroupId: null,
            forwardGroupRuleId: null,
            forwardGroupMemberId: null,
            isForwardGroupTemplate: false,
            sourcePort: nextSourcePort,
            sni: nextSni,
            sniSplitterPort,
            ...resolveSniRuleLimits(nextSni, input, rule as any),
            targetIp: normalizeRuleTargetIp(input.targetIp ?? (rule as any).targetIp, { tunnelId: nextTunnelId }),
            targetPort: Number(input.targetPort ?? (rule as any).targetPort),
            telegramErrorNotifyEnabled: input.telegramErrorNotifyEnabled ?? (rule as any).telegramErrorNotifyEnabled,
            blockHttp: false,
            blockSocks: false,
            blockTls: false,
            ...normalizeProxyProtocolInput({}, nextProtocol, nextForwardType, false, { clearUnsupported: true, tunnelRoute: !!nextTunnelId }),
            ...normalizeTransportTuningInput({}, nextProtocol, nextForwardType, false, {
              clearUnsupported: true,
              tunnelRoute: !!nextTunnelId,
              forwardxTunnel: String(selectedTunnelForRule?.mode || "").toLowerCase() === "forwardx",
            }),
            ...failoverData,
            isEnabled: input.isEnabled !== undefined ? dbBool(input.isEnabled) : dbBool((rule as any).isEnabled),
            isRunning: false,
            pendingDelete: false,
          };
          if (dbBool(data.isEnabled)) {
            data.disabledByUser = false;
            data.disabledByTunnel = false;
            data.disabledByGroup = false;
            data.protocolBlockReason = null;
          }

          await db.updateForwardRule(input.id, data);
          // Let the mapping reconciler acquire endpoint reservations itself;
          // retaining this primary reservation would make a matching mapping
          // appear busy and can rotate its port unnecessarily.
          tunnelExitPortReservationForConversion?.release();
          tunnelExitPortReservationForConversion = null;
          releaseHostPortReservations(heldReservations);
          if (nextTunnelId && selectedTunnelForRule) {
            await reconcileSharedTunnelRulePorts(selectedTunnelForRule);
            await db.reconcileForwardRuleTunnelExits({ ...rule, ...data, id: input.id, tunnelId: nextTunnelId, tunnelExitPort }, selectedTunnelForRule);
            await db.updateTunnel(nextTunnelId, { isRunning: false } as any);
          } else {
            await db.clearForwardRuleTunnelExits(input.id);
          }
          const retiredChildren = await markTemplateChildrenPendingDelete(
            input.id,
            "forward-group-rule-converted",
            { deferRefresh: true },
          );
          await refreshPendingTemplateChildren(retiredChildren as any[], "forward-group-rule-converted");
          if (nextTunnelId && selectedTunnelForRule) {
            await pushTunnelEndpointRefresh(selectedTunnelForRule, "forward-group-rule-converted");
          } else {
            pushAgentRefresh(nextHostId, "forward-group-rule-converted");
          }
          await db.runForwardGroupFailover(groupId);
          await refreshUpdatedRulePortWarnings();
          return { success: true, reset: true };
        }
        if (!groupId) throw new Error("转发组不存在");
        const activeGroupId = input.forwardGroupId === undefined ? groupId : Number(input.forwardGroupId || 0);
        if (!activeGroupId) throw new Error("转发组不存在");
        const groupChanged = activeGroupId !== groupId;
        let groupAccess = { isTrafficBillingResource: false };
        if (ctx.user.role !== "admin") {
          groupAccess = await requireForwardGroupUseAccess(ctx, activeGroupId);
          const nextSourcePort = input.sourcePort ?? rule.sourcePort;
          const planRange = await db.getUserForwardGroupPlanPortRange(ctx.user.id, activeGroupId);
          if (planRange && !db.isPortAllowedByUserPlanRange(nextSourcePort, planRange)) {
            const ranges = planRange.ranges.map((range) => `${range.start}-${range.end}`).join(",");
            throw new Error(`套餐端口必须在 ${ranges} 内`);
          }
        }
        const nextSni = normalizedInputSni !== undefined ? normalizedInputSni : normalizeSniInput((rule as any).sni);
        const nextProtocol = nextSni ? "tcp" : input.protocol ?? (rule as any).protocol;
        const childRules = await db.getForwardGroupChildRulesForTemplate(input.id);
        const ownRuleIds = normalizePositiveIds([
          Number(rule.id),
          ...(childRules as any[]).map((child: any) => Number(child.id)),
        ]);
        const nextSourcePort = Number(input.sourcePort ?? (rule as any).sourcePort);
        const entryHostIds = await db.getForwardGroupRuleEntryHostIds(activeGroupId);
        const sniEntryPortValidation = await validateSniEntryPortUse({
          groupId: activeGroupId,
          sourcePort: nextSourcePort,
          entryHostIds,
          sni: nextSni,
          excludeRuleIds: ownRuleIds,
        });
        const preparedGroupRuntime = await prepareForwardGroupRuntimePorts({
          groupId: activeGroupId,
          sourcePort: nextSourcePort,
          protocol: nextProtocol,
          sni: nextSni,
          sniEntryPortValidation,
          excludeTemplateRuleId: rule.id,
          ownerRuleIds: ownRuleIds,
          currentSplitterPort: groupChanged ? undefined : (rule as any).sniSplitterPort,
          reservations: heldReservations,
        });
        const { group, isForwardChain, isPortGroup, sniSplitterPort: nextSniSplitterPort } = preparedGroupRuntime;
        if (ctx.user.role !== "admin" && (input.isEnabled === true || dbBool((rule as any).isEnabled))) {
          await requireTrafficBillingBalanceForRule(ctx.user.id, groupAccess.isTrafficBillingResource);
        }
        const nextForwardType = lockedForwardTypeForGroup(group, input.forwardType ?? (rule as any).forwardType);
        const groupRouteChanged = groupChanged
          || String(nextForwardType) !== String((rule as any).forwardType);
        if (groupRouteChanged) {
          requireForwardTypeAllowedForActor(ctx.user, nextForwardType);
        }
        await reserveForwardGroupEntryPorts(
          activeGroupId,
          nextSourcePort,
          nextProtocol,
          preparedGroupRuntime.entryPortReservationExcludeRuleIds,
        );
        const groupIsTunnel = !isForwardChain && group.groupType === "tunnel";
        const groupTunnelSupportsFailover = groupIsTunnel ? await forwardGroupTunnelMembersSupportMainBackup(group) : true;
        const groupSupportsFailover = !isForwardChain && nextProtocol === "tcp" && nextForwardType === "gost" && (!groupIsTunnel || groupTunnelSupportsFailover);
        const nextMainBackupEnabled = groupChanged ? false : (groupSupportsFailover ? input.failoverEnabled ?? (rule as any).failoverEnabled : false);
        requireMainBackupAllowed({
          enabled: nextMainBackupEnabled,
          protocol: nextProtocol,
          forwardType: nextForwardType,
          isTunnelRoute: groupIsTunnel,
          isPortForwardGroup: isPortGroup,
          isAdmin: ctx.user.role === "admin",
        });
        await requireRuleProtocolEnabled({ ...rule, forwardType: nextForwardType, tunnelId: null });
        const activeHostId = await db.getForwardGroupDefaultHostId(activeGroupId);
        if (!isForwardChain && !groupIsTunnel) {
          const host = await db.getHostById(activeHostId);
          assertNoDirectSelfForwardLoop({
            host,
            sourcePort: Number(input.sourcePort ?? (rule as any).sourcePort),
            targetIp: input.targetIp ?? (rule as any).targetIp,
            targetPort: Number(input.targetPort ?? (rule as any).targetPort),
            tunnelId: null,
          });
        }
        const data: any = {
          ...input,
          ...(groupChanged || isForwardChain || isPortGroup || !nextMainBackupEnabled ||
            input.failoverEnabled !== undefined ||
            input.failoverStrategy !== undefined ||
            input.failoverTargets !== undefined ||
            input.failoverSeconds !== undefined ||
            input.recoverSeconds !== undefined ||
            input.autoFailback !== undefined
            ? normalizeFailoverInput({
                failoverEnabled: nextMainBackupEnabled,
                failoverStrategy: groupChanged ? "fallback" : input.failoverStrategy ?? (rule as any).failoverStrategy ?? "fallback",
                failoverTargets: nextMainBackupEnabled && !groupChanged ? (input.failoverTargets ?? parseFailoverTargets((rule as any).failoverTargets)) : [],
                failoverSeconds: groupChanged ? 60 : input.failoverSeconds ?? (rule as any).failoverSeconds,
                recoverSeconds: groupChanged ? 120 : input.recoverSeconds ?? (rule as any).recoverSeconds,
                autoFailback: groupChanged ? true : input.autoFailback ?? (rule as any).autoFailback,
              }, nextProtocol)
            : {}),
          ...(input.targetIp !== undefined ? { targetIp: normalizeRuleTargetIp(input.targetIp, { tunnelId: !isForwardChain && group.groupType === "tunnel" ? 1 : null }) } : {}),
          forwardType: nextForwardType,
          protocol: nextProtocol,
          sni: nextSni,
          sniSplitterPort: nextSniSplitterPort,
          ...resolveSniRuleLimits(nextSni, input, rule as any),
          ...(groupChanged ? normalizeProxyProtocolInput({}, nextProtocol, nextForwardType, isForwardChain, { clearUnsupported: true, tunnelRoute: !isForwardChain && group.groupType === "tunnel" }) : normalizeProxyProtocolInput(
            { ...rule, ...input },
            nextProtocol,
            nextForwardType,
            isForwardChain,
            { clearUnsupported: true, tunnelRoute: !isForwardChain && group.groupType === "tunnel" },
          )),
          ...(groupChanged ? normalizeTransportTuningInput({}, nextProtocol, nextForwardType, isForwardChain, { clearUnsupported: true, tunnelRoute: !isForwardChain && group.groupType === "tunnel", forwardxTunnel: false }) : normalizeTransportTuningInput(
            { ...rule, ...input },
            nextProtocol,
            nextForwardType,
            isForwardChain,
            {
              clearUnsupported: true,
              tunnelRoute: !isForwardChain && group.groupType === "tunnel",
              forwardxTunnel: false,
            },
          )),
          gostMode: "direct",
          gostRelayHost: null,
          gostRelayPort: null,
          tunnelId: null,
          tunnelExitPort: null,
          hostId: activeHostId,
          forwardGroupId: activeGroupId,
          forwardGroupRuleId: null,
          forwardGroupMemberId: null,
          isForwardGroupTemplate: true,
        };
        delete data.id;
        delete data.blockHttp;
        delete data.blockSocks;
        delete data.blockTls;
        const watchedFields = ["sourcePort", "targetIp", "targetPort", "forwardType", "protocol", "sni", "sniSplitterPort", "rateLimitMbps", "maxConnections", "proxyProtocolReceive", "proxyProtocolSend", "proxyProtocolExitReceive", "proxyProtocolExitSend", "proxyProtocolVersion", "tcpFastOpen", "zeroCopy", "udpOverTcp", "udpOverTcpPort", "failoverEnabled", "failoverStrategy", "failoverTargets", "failoverSeconds", "recoverSeconds", "autoFailback"] as const;
        const keyFieldChanged = watchedFields.some((field) => data[field] !== undefined && data[field] !== (rule as any)[field]);
        if (dbBool(data.isEnabled)) {
          data.disabledByUser = false;
          data.disabledByTunnel = false;
          data.disabledByGroup = false;
          data.protocolBlockReason = null;
        }
        if (keyFieldChanged || groupChanged || data.isEnabled !== undefined) data.isRunning = false;
        if (!groupChanged && isForwardChain) {
          await db.withForwardGroupSyncTransaction(
            activeGroupId,
            () => db.updateForwardRule(input.id, data),
          );
        } else {
          if (groupChanged) await markTemplateChildrenPendingDelete(input.id, "forward-group-rule-route-changed");
          await db.updateForwardRule(input.id, data);
          if (groupChanged) {
            await db.syncForwardGroupRules(groupId);
            await db.runForwardGroupFailover(groupId);
          }
          await db.syncForwardGroupRules(activeGroupId);
        }
        await db.runForwardGroupFailover(activeGroupId);
        await refreshUpdatedRulePortWarnings();
        return { success: true, reset: keyFieldChanged || groupChanged };
      }

      if (input.forwardGroupId !== undefined && input.forwardGroupId !== null) {
        const groupId = Number(input.forwardGroupId);
        const sourcePort = Number(input.sourcePort ?? (rule as any).sourcePort);
        if (!groupId) throw new Error("请选择转发链或转发组");
        let groupAccess = { isTrafficBillingResource: false };
        if (ctx.user.role !== "admin") {
          groupAccess = await requireForwardGroupUseAccess(ctx, groupId);
          const planRange = await db.getUserForwardGroupPlanPortRange(ctx.user.id, groupId);
          if (planRange && !db.isPortAllowedByUserPlanRange(sourcePort, planRange)) {
            const ranges = planRange.ranges.map((range) => `${range.start}-${range.end}`).join(",");
            throw new Error(`套餐端口必须在 ${ranges} 内`);
          }
        }
        const nextSni = normalizedInputSni !== undefined ? normalizedInputSni : normalizeSniInput((rule as any).sni);
        const nextProtocol = nextSni ? "tcp" : input.protocol ?? (rule as any).protocol;
        const ownRuleIds = normalizePositiveIds([Number(rule.id)]);
        const entryHostIds = await db.getForwardGroupRuleEntryHostIds(groupId);
        const sniEntryPortValidation = await validateSniEntryPortUse({
          groupId,
          sourcePort,
          entryHostIds,
          sni: nextSni,
          excludeRuleIds: ownRuleIds,
        });
        const preparedGroupRuntime = await prepareForwardGroupRuntimePorts({
          groupId,
          sourcePort,
          protocol: nextProtocol,
          sni: nextSni,
          sniEntryPortValidation,
          excludeTemplateRuleId: rule.id,
          ownerRuleIds: ownRuleIds,
          reservations: heldReservations,
        });
        const { group, isForwardChain, isPortGroup, sniSplitterPort: nextSniSplitterPort } = preparedGroupRuntime;
        if (ctx.user.role !== "admin" && (input.isEnabled === true || dbBool((rule as any).isEnabled))) {
          await requireTrafficBillingBalanceForRule(ctx.user.id, groupAccess.isTrafficBillingResource);
        }
        const nextForwardType = lockedForwardTypeForGroup(group, input.forwardType ?? (rule as any).forwardType);
        requireForwardTypeAllowedForActor(ctx.user, nextForwardType);
        await reserveForwardGroupEntryPorts(
          groupId,
          sourcePort,
          nextProtocol,
          preparedGroupRuntime.entryPortReservationExcludeRuleIds,
        );
        const nextMainBackupEnabled = false;
        requireMainBackupAllowed({
          enabled: nextMainBackupEnabled,
          protocol: nextProtocol,
          forwardType: nextForwardType,
          isTunnelRoute: !isForwardChain && group.groupType === "tunnel",
          isAdmin: ctx.user.role === "admin",
        });
        await requireRuleProtocolEnabled({ ...rule, forwardType: nextForwardType, tunnelId: null });
        const hostId = await db.getForwardGroupDefaultHostId(groupId);
        if (!isForwardChain && group.groupType !== "tunnel") {
          const host = await db.getHostById(hostId);
          assertNoDirectSelfForwardLoop({
            host,
            sourcePort,
            targetIp: input.targetIp ?? (rule as any).targetIp,
            targetPort: Number(input.targetPort ?? (rule as any).targetPort),
            tunnelId: null,
          });
        }
        const data: any = {
          name: input.name ?? (rule as any).name,
          hostId,
          forwardType: nextForwardType,
          protocol: nextProtocol,
          gostMode: "direct",
          gostRelayHost: null,
          gostRelayPort: null,
          tunnelId: null,
          tunnelExitPort: null,
          forwardGroupId: groupId,
          forwardGroupRuleId: null,
          forwardGroupMemberId: null,
          isForwardGroupTemplate: true,
          sourcePort,
          sni: nextSni,
          sniSplitterPort: nextSniSplitterPort,
          ...resolveSniRuleLimits(nextSni, input, rule as any),
          targetIp: normalizeRuleTargetIp(input.targetIp ?? (rule as any).targetIp, { tunnelId: !isForwardChain && group.groupType === "tunnel" ? 1 : null }),
          targetPort: Number(input.targetPort ?? (rule as any).targetPort),
          telegramErrorNotifyEnabled: input.telegramErrorNotifyEnabled ?? (rule as any).telegramErrorNotifyEnabled,
          blockHttp: false,
          blockSocks: false,
          blockTls: false,
          ...normalizeProxyProtocolInput(
            {},
            nextProtocol,
            nextForwardType,
            isForwardChain,
            { clearUnsupported: true, tunnelRoute: !isForwardChain && group.groupType === "tunnel" },
          ),
          ...normalizeTransportTuningInput(
            {},
            nextProtocol,
            nextForwardType,
            isForwardChain,
            { clearUnsupported: true, tunnelRoute: !isForwardChain && group.groupType === "tunnel", forwardxTunnel: false },
          ),
          ...normalizeFailoverInput({
            failoverEnabled: false,
            failoverTargets: [],
          }, nextProtocol),
          isEnabled: input.isEnabled !== undefined ? dbBool(input.isEnabled) : dbBool((rule as any).isEnabled),
          isRunning: false,
          pendingDelete: false,
        };
        if (dbBool(data.isEnabled)) {
          data.disabledByUser = false;
          data.disabledByTunnel = false;
          data.disabledByGroup = false;
          data.protocolBlockReason = null;
        }
        await db.updateForwardRule(input.id, data);
        await db.clearForwardRuleTunnelExits(input.id);
        if ((rule as any).tunnelId) {
          const oldTunnel = await db.getTunnelById((rule as any).tunnelId);
          await reconcileSharedTunnelRulePorts(oldTunnel);
          await db.updateTunnel((rule as any).tunnelId, { isRunning: false } as any);
          if (oldTunnel) await pushTunnelEndpointRefresh(oldTunnel, "forward-rule-route-changed");
        } else if (Number((rule as any).hostId || 0) > 0) {
          pushAgentRefresh(Number((rule as any).hostId), "forward-rule-route-changed");
        }
        await db.syncForwardGroupRules(groupId);
        await db.runForwardGroupFailover(groupId);
        await refreshUpdatedRulePortWarnings();
        return { success: true, reset: true };
      }
      const nextDirectRuleSni = normalizedInputSni !== undefined ? normalizedInputSni : normalizeSniInput((rule as any).sni);
      assertSniRuleAdmin(ctx.user, nextDirectRuleSni);
      // 如果修改了源端口，检查端口区间和占用
      let selectedTunnelForRule: any = null;
      let nextTunnelIdForRule: number | null = null;
      let nextForwardTypeForRule = rule.forwardType;
      let nextHostIdForRule = Number(input.hostId ?? rule.hostId);
      {
        const nextForwardType = input.forwardType ?? rule.forwardType;
        nextForwardTypeForRule = nextForwardType;
        nextTunnelIdForRule = nextForwardType === "gost"
          ? (input.tunnelId !== undefined ? input.tunnelId : (rule as any).tunnelId)
          : null;
        if (nextTunnelIdForRule) {
          const access = await requireTunnelUseOrTrafficBillingAccess(ctx, nextTunnelIdForRule);
          selectedTunnelForRule = access.tunnel;
          if (!dbBool(selectedTunnelForRule.isEnabled)) throw new Error("Selected tunnel is disabled");
          nextHostIdForRule = Number(selectedTunnelForRule.entryHostId);
          if (ctx.user.role !== "admin" && String(selectedTunnelForRule.mode).toLowerCase() === "forwardx") {
            const owner = await requireForwardAccessReady(ctx.user.id, { allowTrafficBillingRecovery: !!access.isTrafficBillingResource });
            await requireTrafficBillingBalanceForRule(ctx.user.id, !!access.isTrafficBillingResource);
            if (!(owner as any)?.canAddRules) {
              throw new Error("No permission to use custom encrypted tunnels");
            }
          }
        }
      }
      const nextIsTunnelForward = nextForwardTypeForRule === "gost" && Number(nextTunnelIdForRule || 0) > 0;
      const routeChanged = String(nextForwardTypeForRule) !== String((rule as any).forwardType) || Number(nextTunnelIdForRule || 0) !== Number((rule as any).tunnelId || 0);
      const directRouteChanged = routeChanged || Number(nextHostIdForRule) !== Number((rule as any).hostId);
      if (directRouteChanged) {
        requireForwardTypeAllowedForActor(ctx.user, nextForwardTypeForRule);
      }
      const requestedMainBackupEnabled = input.failoverEnabled ?? (rule as any).failoverEnabled;
      if (nextDirectRuleSni && !nextTunnelIdForRule) {
        throw new Error("SNI 分流仅支持端口转发、隧道或转发链");
      }
      const nextProtocolForRule = nextDirectRuleSni ? "tcp" : input.protocol ?? (rule as any).protocol;
      await requireRuleProtocolEnabled({ ...rule, protocol: nextProtocolForRule, forwardType: nextForwardTypeForRule, tunnelId: nextTunnelIdForRule }, selectedTunnelForRule);
      const nextMainBackupEnabled = nextDirectRuleSni
        ? false
        : routeChanged
          ? false
          : (nextProtocolForRule === "tcp" && nextForwardTypeForRule === "gost" ? requestedMainBackupEnabled : false);
      requireMainBackupAllowed({
        enabled: nextMainBackupEnabled,
        protocol: nextProtocolForRule,
        forwardType: nextForwardTypeForRule,
        tunnelId: nextTunnelIdForRule,
        tunnelMode: selectedTunnelForRule?.mode,
        isAdmin: ctx.user.role === "admin",
      });
      const nextRuleEnabled = input.isEnabled !== undefined
        ? dbBool(input.isEnabled)
        : dbBool((rule as any).isEnabled);
      if (!nextTunnelIdForRule) {
        const access = await requireHostUseAccess(ctx, nextHostIdForRule);
        if (ctx.user.role !== "admin" && nextRuleEnabled) {
          await requireTrafficBillingBalanceForRule(ctx.user.id, !!access.isTrafficBillingResource);
        }
      }

      if (nextRuleEnabled && ctx.user.role !== "admin") {
        const activeTunnelId = Number(nextTunnelIdForRule || 0);
        const resourceAccess = activeTunnelId
          ? await requireTunnelUseOrTrafficBillingAccess(ctx, activeTunnelId)
          : await requireHostUseAccess(ctx, nextHostIdForRule);
        const owner = await requireForwardAccessReady(ctx.user.id, { allowTrafficBillingRecovery: !!resourceAccess.isTrafficBillingResource });
        await requireTrafficBillingBalanceForRule(ctx.user.id, !!resourceAccess.isTrafficBillingResource);
        if (owner.expiresAt && new Date(owner.expiresAt) <= new Date()) {
          throw new Error("套餐已到期，请续费后再启用规则");
        }
      }

      const nextSourcePortForRule = input.sourcePort ?? rule.sourcePort;
      let directTunnelSniState: DirectTunnelSniEntryPortState | null = null;
      if (nextTunnelIdForRule && selectedTunnelForRule) {
        directTunnelSniState = await getDirectTunnelSniEntryPortState({
          tunnel: selectedTunnelForRule,
          sourcePort: Number(nextSourcePortForRule),
          sni: nextDirectRuleSni,
          excludeRuleIds: [Number(rule.id)],
        });
        assertDirectTunnelSniEntryPortUse(
          directTunnelSniState,
          Number(nextSourcePortForRule),
          nextDirectRuleSni,
        );
      }
      if (!nextTunnelIdForRule) {
        const host = await db.getHostById(nextHostIdForRule);
        assertNoDirectSelfForwardLoop({
          host,
          sourcePort: nextSourcePortForRule,
          targetIp: input.targetIp ?? (rule as any).targetIp,
          targetPort: Number(input.targetPort ?? (rule as any).targetPort),
          tunnelId: nextTunnelIdForRule,
        });
      }
      const shouldCheckSourcePort = input.sourcePort !== undefined
        || input.protocol !== undefined
        || input.sni !== undefined
        || Number(nextHostIdForRule) !== Number(rule.hostId)
        || Number(nextTunnelIdForRule || 0) !== Number((rule as any).tunnelId || 0);
      if (shouldCheckSourcePort) {
        const host = await db.getHostById(nextHostIdForRule);
        if (host) {
          let effectivePolicy = selectedTunnelForRule
            ? combineHostPortPolicyWithRange(
              host as any,
              (selectedTunnelForRule as any).portRangeStart,
              (selectedTunnelForRule as any).portRangeEnd,
            )
            : portPolicyFrom(host as any);
          if (!isPortAllowedByPolicy(nextSourcePortForRule, effectivePolicy)) {
            throw new Error(portPolicyErrorMessage(effectivePolicy, "源端口"));
          }
          if (ctx.user.role !== "admin") {
            const planRange = await db.getUserPlanPortRange(ctx.user.id, nextHostIdForRule, nextTunnelIdForRule || undefined);
            if (planRange) {
              effectivePolicy = combinePortPolicies(effectivePolicy, portPolicyFrom({
                portRanges: planRange.ranges,
              }));
            }
            if (planRange && !isPortAllowedByPolicy(nextSourcePortForRule, effectivePolicy)) {
              const ranges = planRange.ranges.map((range) => `${range.start}-${range.end}`).join(",");
              throw new Error(`套餐端口必须在 ${ranges} 区间内`);
            }
          }
          const sourceReservation = await reserveRulePort(
            nextHostIdForRule,
            nextSourcePortForRule,
            nextProtocolForRule,
            normalizePositiveIds([Number(rule.id), ...(directTunnelSniState?.shareableRuleIds || [])]),
          );
          if (!sourceReservation) {
            throw new Error(`端口 ${nextSourcePortForRule} 已被其他规则占用`);
          }
        }
      }

      const { id, ...data } = input;
      delete (data as any).blockHttp;
      delete (data as any).blockSocks;
      delete (data as any).blockTls;
      (data as any).hostId = nextHostIdForRule;
      (data as any).protocol = nextProtocolForRule;
      (data as any).sni = nextDirectRuleSni;
      Object.assign(data as any, resolveSniRuleLimits(nextDirectRuleSni, input, rule as any));
      if (input.targetIp !== undefined) (data as any).targetIp = normalizeRuleTargetIp(input.targetIp, { tunnelId: nextTunnelIdForRule });
      if (
        input.failoverEnabled !== undefined ||
        input.failoverStrategy !== undefined ||
        input.failoverTargets !== undefined ||
        input.failoverSeconds !== undefined ||
        input.recoverSeconds !== undefined ||
        input.autoFailback !== undefined ||
        routeChanged ||
        !!nextDirectRuleSni ||
        nextMainBackupEnabled !== requestedMainBackupEnabled
      ) {
        Object.assign(data as any, normalizeFailoverInput({
          failoverEnabled: nextMainBackupEnabled,
          failoverStrategy: routeChanged ? "fallback" : input.failoverStrategy ?? (rule as any).failoverStrategy ?? "fallback",
          failoverTargets: nextMainBackupEnabled && !routeChanged ? (input.failoverTargets ?? parseFailoverTargets((rule as any).failoverTargets)) : [],
          failoverSeconds: routeChanged ? 60 : input.failoverSeconds ?? (rule as any).failoverSeconds,
          recoverSeconds: routeChanged ? 120 : input.recoverSeconds ?? (rule as any).recoverSeconds,
          autoFailback: routeChanged ? true : input.autoFailback ?? (rule as any).autoFailback,
        }, nextProtocolForRule));
      }
      if (
        input.proxyProtocolReceive !== undefined ||
        input.proxyProtocolSend !== undefined ||
        input.proxyProtocolExitReceive !== undefined ||
        input.proxyProtocolExitSend !== undefined ||
        input.proxyProtocolVersion !== undefined ||
        input.tcpFastOpen !== undefined ||
        input.zeroCopy !== undefined ||
        input.udpOverTcp !== undefined ||
        input.udpOverTcpPort !== undefined ||
        input.protocol !== undefined ||
        input.forwardType !== undefined ||
        input.failoverEnabled !== undefined ||
        routeChanged
      ) {
        const proxySource = routeChanged
          ? {}
          : nextTunnelIdForRule && selectedTunnelForRule
          ? tunnelRuntimeOptionInput(selectedTunnelForRule)
          : {
              proxyProtocolReceive: input.proxyProtocolReceive ?? (rule as any).proxyProtocolReceive,
              proxyProtocolSend: input.proxyProtocolSend ?? (rule as any).proxyProtocolSend,
              proxyProtocolExitReceive: input.proxyProtocolExitReceive ?? (rule as any).proxyProtocolExitReceive,
              proxyProtocolExitSend: input.proxyProtocolExitSend ?? (rule as any).proxyProtocolExitSend,
              proxyProtocolVersion: input.proxyProtocolVersion ?? (rule as any).proxyProtocolVersion,
              failoverEnabled: nextMainBackupEnabled,
            };
        Object.assign(data as any, normalizeProxyProtocolInput({
          ...proxySource,
          failoverEnabled: nextMainBackupEnabled,
        }, nextProtocolForRule, nextForwardTypeForRule, false, { clearUnsupported: true, tunnelRoute: !!nextTunnelIdForRule }));
      }
      if (
        input.tcpFastOpen !== undefined ||
        input.zeroCopy !== undefined ||
        input.udpOverTcp !== undefined ||
        input.udpOverTcpPort !== undefined ||
        input.protocol !== undefined ||
        input.forwardType !== undefined ||
        routeChanged
      ) {
        const transportSource = routeChanged
          ? {}
          : nextTunnelIdForRule && selectedTunnelForRule
          ? tunnelRuntimeOptionInput(selectedTunnelForRule)
          : {
              tcpFastOpen: input.tcpFastOpen ?? (rule as any).tcpFastOpen,
              zeroCopy: input.zeroCopy ?? (rule as any).zeroCopy,
              udpOverTcp: input.udpOverTcp ?? (rule as any).udpOverTcp,
              udpOverTcpPort: input.udpOverTcpPort ?? (rule as any).udpOverTcpPort,
            };
        const transportTuning = normalizeTransportTuningInput(transportSource, nextProtocolForRule, nextForwardTypeForRule, false, {
          clearUnsupported: true,
          tunnelRoute: !!nextTunnelIdForRule,
          forwardxTunnel: String(selectedTunnelForRule?.mode || "").toLowerCase() === "forwardx",
        });
        Object.assign(data as any, transportTuning);
      }
      if ((data.forwardType ?? rule.forwardType) !== "gost") {
        (data as any).gostMode = "direct";
        (data as any).gostRelayHost = null;
        (data as any).gostRelayPort = null;
        (data as any).tunnelId = null;
        (data as any).tunnelExitPort = null;
        if ((data.forwardType ?? rule.forwardType) !== "realm") {
          (data as any).proxyProtocolReceive = false;
          (data as any).proxyProtocolSend = false;
        }
        (data as any).proxyProtocolExitReceive = false;
        (data as any).proxyProtocolExitSend = false;
        if (!(data as any).proxyProtocolReceive && !(data as any).proxyProtocolSend) {
          (data as any).proxyProtocolVersion = 1;
        }
      } else {
        (data as any).gostMode = "direct";
        (data as any).gostRelayHost = null;
        (data as any).gostRelayPort = null;
        const nextTunnelId = data.tunnelId !== undefined ? data.tunnelId : (rule as any).tunnelId;
        if (nextTunnelId) {
          const tunnel = selectedTunnelForRule ?? (await requireTunnelUseOrTrafficBillingAccess(ctx, nextTunnelId)).tunnel;
          if (!dbBool(tunnel.isEnabled)) throw new Error("所选隧道已停用");
          if (Number(tunnel.entryHostId) !== Number(nextHostIdForRule)) {
            throw new Error("所选隧道的入口 Agent 必须与规则所属主机一致");
          }
          const sameTunnel = Number(nextTunnelId) === Number((rule as any).tunnelId || 0);
          const existingExitPort = Number((rule as any).tunnelExitPort || 0);
          if (nextDirectRuleSni && directTunnelSniState) {
            if (
              !nextRuleEnabled
              && sameTunnel
              && existingExitPort > 0
              && Number((rule as any).sniSplitterPort || 0) > 0
            ) {
              (data as any).tunnelExitPort = existingExitPort;
              (data as any).sniSplitterPort = Number((rule as any).sniSplitterPort);
            } else {
              const prepared = await reserveDirectTunnelSniRuntimePorts({
                tunnel,
                state: directTunnelSniState,
                currentSplitterPort: (rule as any).sniSplitterPort,
                currentTunnelExitPort: existingExitPort,
                ownerRuleIds: [Number(rule.id)],
                enabled: nextRuleEnabled,
                reservations: heldReservations,
              });
              (data as any).tunnelExitPort = prepared.tunnelExitPort;
              (data as any).sniSplitterPort = prepared.sniSplitterPort;
            }
          } else {
            (data as any).sniSplitterPort = null;
            // Disabling an existing rule is a state change, not a request to
            // move its data-plane listener. In particular, a primary managed
            // GOST rule intentionally shares tunnel.listenPort. Passing
            // `enabled=false` to preferredSharedTunnelListenPort removes that
            // sharing exemption, so a one-port NAT range would report "no
            // available port" (or silently rotate the stored port) merely when
            // the user toggles the rule off. Keep the old value as the next
            // enable's preference; the enabled path below will revalidate it
            // against the current NAT policy and repair it when necessary.
            const preserveDisabledExitPort = !nextRuleEnabled
              && sameTunnel
              && !routeChanged
              && existingExitPort > 0;
            if (preserveDisabledExitPort) {
              (data as any).tunnelExitPort = existingExitPort;
            } else {
              const exit = await db.getHostById(tunnel.exitHostId);
              // Repair a stale tunnel listener before assigning this rule's exit
              // port. Otherwise the rule could be pointed at a newly allocated
              // NAT port while the tunnel runtime keeps listening on the old one.
              const listenerRepair = usesSharedTunnelPrimaryListener(tunnel)
                ? await ensureTunnelListenerPortPolicy(tunnel, {
                  hostId: Number(tunnel.exitHostId),
                  syncSharedPrimaryRule: true,
                })
                : null;
              if (usesSharedTunnelPrimaryListener(tunnel) && !listenerRepair) {
                throw new Error("出口 Agent 已无可用隧道监听端口");
              }
              const sharedListenPort = await preferredSharedTunnelListenPort(
                tunnel,
                Number(rule.id),
                nextRuleEnabled,
              );
              let reservation: HostPortReservation | null = null;
              if (listenerRepair?.reservation && Number(sharedListenPort || 0) === listenerRepair.port) {
                reservation = listenerRepair.reservation;
              } else {
                listenerRepair?.reservation.release();
              }
              if (!reservation) {
                reservation = await reserveTunnelExitPort({
                  hostId: Number(tunnel.exitHostId),
                  preferredStart: (exit as any)?.portRangeStart,
                  preferredEnd: (exit as any)?.portRangeEnd,
                  currentPort: sharedListenPort ?? (sameTunnel ? existingExitPort : 0),
                  excludeRuleIds: [Number(rule.id)],
                  allowSameTunnelListener: Number(sharedListenPort || 0) > 0,
                  excludeTunnelId: Number(tunnel.id),
                  protocol: "both",
                });
              }
              if (!reservation) throw new Error("出口 Agent 已无可用隧道端口");
              tunnelExitPortReservationForUpdate = reservation;
              (data as any).tunnelExitPort = reservation.port;
            }
          }
        } else {
          (data as any).tunnelExitPort = null;
          (data as any).sniSplitterPort = null;
          await db.clearForwardRuleTunnelExits(id);
        }
      }
      if (dbBool(data.isEnabled)) {
        const sourcePort = Number(data.sourcePort ?? rule.sourcePort);
        await assertRulePortWithinEntryPolicy({
          hostId: nextHostIdForRule,
          sourcePort,
          tunnelId: nextTunnelIdForRule,
          tunnel: selectedTunnelForRule,
        });
        if (ctx.user.role !== "admin") {
          await assertRulePortWithinUserPlanRange({
            userId: ctx.user.id,
            hostId: nextHostIdForRule,
            sourcePort,
            tunnelId: nextTunnelIdForRule,
          });
        }
        const sourceReservation = await reserveRulePort(
          nextHostIdForRule,
          sourcePort,
          nextProtocolForRule,
          normalizePositiveIds([Number(rule.id), ...(directTunnelSniState?.shareableRuleIds || [])]),
        );
        if (!sourceReservation) throw new Error(`端口 ${sourcePort} 已被占用，请更换端口后再启用`);
        (data as any).disabledByUser = false;
        (data as any).disabledByTunnel = false;
        (data as any).disabledByGroup = false;
        (data as any).protocolBlockReason = null;
      }
      // 关键字段变更时重置 isRunning
      const watchedFields = [
        "sourcePort",
        "targetIp",
        "targetPort",
        "forwardType",
        "protocol",
        "sni",
        "sniSplitterPort",
        "rateLimitMbps",
        "maxConnections",
        "gostMode",
        "gostRelayHost",
        "gostRelayPort",
        "tunnelId",
        "tunnelExitPort",
        "hostId",
        "proxyProtocolReceive",
        "proxyProtocolSend",
        "proxyProtocolExitReceive",
        "proxyProtocolExitSend",
        "proxyProtocolVersion",
        "tcpFastOpen",
        "zeroCopy",
        "udpOverTcp",
        "udpOverTcpPort",
        "failoverEnabled",
        "failoverStrategy",
        "failoverTargets",
        "failoverSeconds",
        "recoverSeconds",
        "autoFailback",
      ] as const;
      const keyFieldChanged = watchedFields.some((f) => {
        const v = (data as any)[f];
        return v !== undefined && v !== (rule as any)[f];
      });
      const failoverHotUpdate = keyFieldChanged
        && isFailoverHotUpdate(data as any, rule as any, nextHostIdForRule, nextTunnelIdForRule);
      const oldHostIdForRule = Number(rule.hostId);
      const hostChanged = Number(oldHostIdForRule) !== Number(nextHostIdForRule);
      const affectedTunnelIdsForRefresh = new Set<number>();
      if (keyFieldChanged && !failoverHotUpdate) {
        (data as any).isRunning = false;
        if ((rule as any).tunnelId) affectedTunnelIdsForRefresh.add((rule as any).tunnelId);
        if ((data as any).tunnelId) affectedTunnelIdsForRefresh.add((data as any).tunnelId);
        for (const affectedTunnelId of affectedTunnelIdsForRefresh) {
          await db.updateTunnel(affectedTunnelId, { isRunning: false } as any);
        }
      }
      await db.updateForwardRule(id, data);
      await refreshUpdatedRulePortWarnings();
      // The mapping reconciler performs its own per-endpoint reservation. Do
      // not leave the primary reservation held while it runs; release is
      // idempotent and the finalizer below still covers error paths.
      tunnelExitPortReservationForUpdate?.release();
      tunnelExitPortReservationForUpdate = null;
      releaseHostPortReservations(heldReservations);
      const tunnelUnitChanged = input.sni !== undefined
        || input.sourcePort !== undefined
        || input.tunnelId !== undefined
        || input.forwardType !== undefined
        || input.isEnabled !== undefined;
      if (tunnelUnitChanged) {
        const affectedTunnelIds = normalizePositiveIds([
          Number((rule as any).tunnelId || 0),
          Number(nextTunnelIdForRule || 0),
        ]);
        for (const affectedTunnelId of affectedTunnelIds) {
          await reconcileSharedTunnelRulePorts(await db.getTunnelById(affectedTunnelId));
        }
      }
      if ((data.forwardType ?? rule.forwardType) === "gost") {
        const activeTunnelId = Number(nextTunnelIdForRule || 0);
        if (activeTunnelId) {
          const tunnel = selectedTunnelForRule ?? await db.getTunnelById(activeTunnelId);
          if (tunnel) {
            await db.reconcileForwardRuleTunnelExits(
              { ...rule, ...data, id, tunnelId: activeTunnelId, tunnelExitPort: (data as any).tunnelExitPort ?? (rule as any).tunnelExitPort },
              tunnel,
            );
          }
        } else {
          await db.clearForwardRuleTunnelExits(id);
        }
      } else {
        await db.clearForwardRuleTunnelExits(id);
      }
      for (const affectedTunnelId of affectedTunnelIdsForRefresh) {
        const affectedTunnel = await db.getTunnelById(affectedTunnelId);
        if (affectedTunnel) await pushTunnelEndpointRefresh(affectedTunnel, "forward-rule-updated");
      }
      if (keyFieldChanged) {
        if (hostChanged) {
          pushAgentRefresh(oldHostIdForRule, "forward-rule-updated-old-host");
          pushAgentRefresh(Number(nextHostIdForRule), "forward-rule-updated-new-host");
        } else if (!nextTunnelIdForRule) {
          pushAgentRefresh(Number(nextHostIdForRule), "forward-rule-updated");
        } else if (failoverHotUpdate) {
          const tunnel = await db.getTunnelById(nextTunnelIdForRule);
          if (tunnel) await pushTunnelEndpointRefresh(tunnel, "forward-rule-failover-hot-update");
          else pushAgentRefresh(Number(nextHostIdForRule), "forward-rule-failover-hot-update");
        }
      }
      return { success: true, reset: keyFieldChanged && !failoverHotUpdate, hotUpdated: failoverHotUpdate };
      } finally {
        tunnelExitPortReservationForUpdate?.release();
        tunnelExitPortReservationForConversion?.release();
        releaseHostPortReservations(heldReservations);
      }
    })),
  delete: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input, ctx }) => deleteForwardRuleForActor(ctx.user, input.id)),
  deleteBatch: protectedProcedure
    .input(z.object({ ids: z.array(z.number().int().positive()).min(1).max(500) }))
    .mutation(async ({ input, ctx }) => {
      const ids = Array.from(new Set(input.ids.map(Number)));
      const results = await mapWithConcurrency(ids, 8, async (id) => {
        try {
          await deleteForwardRuleForActor(ctx.user, id, { reasonPrefix: "batch-forward-rule" });
          return { id, success: true as const };
        } catch (error) {
          return {
            id,
            success: false as const,
            error: error instanceof Error ? error.message : String(error || "删除失败"),
          };
        }
      });
      const deletedIds = results.filter((item) => item.success).map((item) => item.id);
      const failures = results.filter((item): item is Extract<typeof item, { success: false }> => !item.success);
      return {
        success: failures.length === 0,
        requested: ids.length,
        deletedIds,
        failures,
      };
    }),
  toggle: protectedProcedure
    .input(z.object({ id: z.number(), isEnabled: z.boolean(), confirmPortOccupancy: z.boolean().optional().default(false) }))
    .mutation(async ({ input, ctx }) => toggleForwardRuleForActor(ctx.user, input.id, input.isEnabled, { confirmPortOccupancy: input.confirmPortOccupancy }))
});
