import { isValidSniValue, normalizeSniValue } from "@shared/sni";

// SNI 分流规则的真值来源始终是 sni 字段非空（见 .scratch/sni-toggle/spec.md）。
// 这里的开关只是表单状态：它决定表单长什么样，不决定规则是什么。

export const SNI_DEFAULT_ENTRY_PORT = 443;

export type SniRuleFormSlice = {
  sourcePort: number;
  sni: string;
  rateLimitMbps: number;
  maxConnections: number;
  protocol: "tcp" | "udp" | "both";
  failoverEnabled: boolean;
  failoverTargetsText: string;
};

export type SniToggleState = {
  enabled: boolean;
  /** 拨开开关之前的源端口，拨回时原样还给用户 */
  portBeforeSni: number;
  /** 折叠的「修改入口端口」是否已经展开 */
  portUnlocked: boolean;
};

export const closedSniToggleState: SniToggleState = {
  enabled: false,
  portBeforeSni: 0,
  portUnlocked: false,
};

/**
 * 打开一条已有规则时的开关状态。端口原样保留：「锁 443」是拨动开关那一刻的
 * 动作，不是持续约束，否则点开一条 8443 的规则再保存就会把它从原分流组里拽走。
 */
export function sniToggleStateForRule(rule: { sni?: unknown; sourcePort?: unknown }): SniToggleState {
  const enabled = !!normalizeSniValue(rule?.sni);
  const sourcePort = Number(rule?.sourcePort || 0);
  return {
    enabled,
    portBeforeSni: enabled && sourcePort > 0 ? sourcePort : 0,
    portUnlocked: false,
  };
}

export function applySniToggle<T extends SniRuleFormSlice>(
  form: T,
  state: SniToggleState,
  enabled: boolean,
): { form: T; state: SniToggleState } {
  if (enabled === state.enabled) return { form, state };
  if (enabled) {
    return {
      form: {
        ...form,
        sourcePort: SNI_DEFAULT_ENTRY_PORT,
        protocol: "tcp",
        failoverEnabled: false,
        failoverTargetsText: "",
      },
      state: {
        enabled: true,
        portBeforeSni: Number(form.sourcePort || 0),
        portUnlocked: false,
      },
    };
  }
  return {
    form: {
      ...form,
      sourcePort: Number(state.portBeforeSni || 0),
      sni: "",
      rateLimitMbps: 0,
      maxConnections: 0,
    },
    state: closedSniToggleState,
  };
}

/** 承载资源不支持分流时，把规则拖回普通转发形态，避免留下半个 SNI 表单。 */
export function clearSniFromForm<T extends SniRuleFormSlice>(form: T): T {
  if (!form.sni && !form.rateLimitMbps && !form.maxConnections) return form;
  return { ...form, sni: "", rateLimitMbps: 0, maxConnections: 0 };
}

export type SniRouteMode = "local" | "tunnel" | "chain" | "group";
export type SniGroupModeForRule = "port" | "chain" | "failover" | "entry" | "exit";

export function sniRuleRouteModeForEdit(
  rule: { forwardGroupId?: unknown; tunnelId?: unknown; forwardType?: unknown },
  groupModeForRule: SniGroupModeForRule | null,
): SniRouteMode | null {
  if (Number(rule.forwardGroupId || 0) > 0) {
    if (!groupModeForRule) return null;
    if (groupModeForRule === "port") return "local";
    if (groupModeForRule === "chain") return "chain";
    return "group";
  }
  return String(rule.forwardType || "") === "gost" && Number(rule.tunnelId || 0) > 0
    ? "tunnel"
    : "local";
}

type SniToggleSupportMember = {
  isEnabled?: unknown;
  memberType?: unknown;
};

export type SniToggleSupportInput = {
  isAdmin: boolean;
  routeMode: SniRouteMode;
  tunnel?: { exitGroupId?: unknown; loadBalanceEnabled?: unknown; exitHostId?: unknown } | null;
  group?: { groupType?: unknown; members?: SniToggleSupportMember[] | null } | null;
  /** normalizeForwardGroupModeForRule 的结果，port / chain / failover / entry / exit */
  groupModeForRule?: SniGroupModeForRule | null;
  /** 表单上已选的资源 id，用来区分「还没选」和「选了但列表还没加载出来」 */
  tunnelId?: number | null;
  groupId?: number | null;
};

export type SniToggleSupport = {
  /** 普通用户完全看不到开关 */
  visible: boolean;
  /** 非空表示开关置灰，内容就是置灰原因 */
  reason: string | null;
  /**
   * 承载资源还没拿到（列表未加载完或用户尚未选择）。此时「不支持」只是暂时结论，
   * 调用方不能据此清空表单里已有的 SNI 配置。
   */
  pending: boolean;
};

export function isSniFormModeOn(
  state: Pick<SniToggleState, "enabled">,
  support: SniToggleSupport,
) {
  return state.enabled && support.visible && (!support.reason || support.pending);
}

function enabledMembersOf(group: SniToggleSupportInput["group"]) {
  const members = Array.isArray(group?.members) ? group.members : [];
  return members.filter((member) => member?.isEnabled !== false);
}

/**
 * 只复刻前端已经拿得到的事实。出口 Agent 版本、额外出口节点这类前端没有的信息，
 * 仍然由保存时的服务端校验负责（server/routers/rules.crud.ts）。
 */
export function sniToggleSupport(input: SniToggleSupportInput): SniToggleSupport {
  const blocked = (reason: string, pending = false): SniToggleSupport => ({ visible: true, reason, pending });
  const allowed: SniToggleSupport = { visible: true, reason: null, pending: false };
  if (!input.isAdmin) return { visible: false, reason: null, pending: false };
  if (input.routeMode === "group") {
    return blocked("转发组不支持 SNI 分流，请改用转发链、隧道或端口转发");
  }
  if (input.routeMode === "tunnel") {
    const tunnel = input.tunnel;
    if (!tunnel) return blocked("请先选择隧道", true);
    if (Number(tunnel.exitGroupId || 0) > 0 || tunnel.loadBalanceEnabled === true) {
      return blocked("该隧道为多出口，SNI 分流仅支持单出口");
    }
    if (Number(tunnel.exitHostId || 0) <= 0) {
      return blocked("该隧道没有可推导的出口主机");
    }
    return allowed;
  }
  const group = input.group;
  const groupPending = !group && Number(input.groupId || 0) > 0;
  if (input.routeMode === "chain") {
    if (!group) return blocked("请先选择转发链", groupPending);
    if (input.groupModeForRule !== "chain") return blocked("请先选择转发链");
  } else if (!group) {
    return blocked("SNI 分流仅支持已保存的端口转发资源", groupPending);
  } else if (input.groupModeForRule !== "port") {
    return blocked("SNI 分流仅支持已保存的端口转发资源");
  }
  if (String(group?.groupType || "host") !== "host") {
    return blocked("SNI 分流仅支持主机型链路资源");
  }
  const members = enabledMembersOf(group);
  if (members.some((member) => String(member?.memberType || "host") !== "host")) {
    return blocked("SNI 分流仅支持主机型链路资源");
  }
  if (input.routeMode === "local" && members.length !== 1) {
    return blocked("SNI 分流的端口转发资源必须且只能包含一台主机");
  }
  if (members.length === 0) {
    return blocked("该链路资源没有启用的主机成员");
  }
  return allowed;
}

export function sniDomainFormatError(value: string): string | null {
  const normalized = normalizeSniValue(value);
  if (!normalized) return null;
  if (isValidSniValue(normalized)) return null;
  return "SNI 域名格式不正确：只填写完整域名，不含 https://、端口、路径或通配符";
}
