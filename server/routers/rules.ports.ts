import { protectedProcedure, router } from "../_core/trpc";
import { z } from "zod";
import * as db from "../db";
import type { Tunnel } from "../../drizzle/schema";
import {
  requireHostUseAccess,
  requireRuleAccess,
  requireTrafficBillingAccessIfConfigured,
  requireTunnelUseOrTrafficBillingAccess,
} from "./helpers";
import { combineHostPortPolicyWithRange, combinePortPolicies, isPortAllowedByPolicy, portPolicyErrorMessage, portPolicyFrom } from "../portPolicy";
import { isValidSniValue, normalizeSniValue } from "@shared/sni";
import {
  assertDirectTunnelSniEntryPortUse,
  assertSniEntryPortCanUseSni,
  getDirectTunnelSniEntryPortState,
  sniDomainDuplicateReason,
  sniEntryPortConflictReason,
  type ForwardRuleConflictTarget,
} from "../sniEntryPort";

const randomPortInputSchema = z.object({
  hostId: z.number().optional(),
  tunnelId: z.number().nullable().optional(),
  forwardGroupId: z.number().optional(),
  excludeRuleId: z.number().optional(),
  protocol: z.enum(["tcp", "udp", "both"]).optional().default("both"),
});

async function requireForwardGroupPortAccess(ctx: { user: { id: number; role: string } }, forwardGroupId: number) {
  if (ctx.user.role === "admin") return;
  const isTrafficBillingResource = await requireTrafficBillingAccessIfConfigured(
    ctx,
    "forward_group",
    forwardGroupId,
  );
  if (isTrafficBillingResource) return;
  const hasPermission = await db.checkUserForwardGroupPermission(ctx.user.id, forwardGroupId);
  if (!hasPermission) throw new Error("无权使用该转发组");
}

/** 模板规则的子规则与模板本身必须一起排除，否则规则会和自己的副本冲突。 */
async function resolveExcludeRuleIds(excludeRuleId?: number) {
  if (!excludeRuleId) return [];
  const childRules = await db.getForwardGroupChildRulesForTemplate(excludeRuleId);
  return [excludeRuleId, ...childRules.map((rule: { id: unknown }) => Number(rule.id))];
}

type SniEntryPortLookup = {
  duplicateRule: ForwardRuleConflictTarget | null;
  shareableRuleIds: number[];
  /** 完整的入口端口判定（域名重复 + 端口占用），供保存前的端口校验使用 */
  assertCanUseSni: () => void;
};

/**
 * 转发组与直接隧道的入口端口状态查询只有取数方式不同，判定口径必须是同一份。
 * 调用方各取所需：端口校验跑完整断言，域名预检只看 duplicateRule。
 */
async function loadSniEntryPortState(options: {
  forwardGroupId?: number | null;
  tunnel?: Tunnel | null;
  sourcePort: number;
  sni: string;
  excludeRuleIds: number[];
}): Promise<SniEntryPortLookup | null> {
  const { sourcePort, sni, excludeRuleIds } = options;
  if (options.forwardGroupId) {
    const entryHostIds = await db.getForwardGroupRuleEntryHostIds(options.forwardGroupId);
    const state = await db.getForwardGroupSniEntryPortState({
      groupId: options.forwardGroupId,
      sourcePort,
      entryHostIds,
      sni,
      excludeRuleIds,
    });
    return {
      duplicateRule: state.duplicateRule,
      shareableRuleIds: state.shareableRuleIds,
      assertCanUseSni: () => assertSniEntryPortCanUseSni(state, sourcePort, sni),
    };
  }
  if (!options.tunnel) return null;
  const state = await getDirectTunnelSniEntryPortState({
    tunnel: options.tunnel,
    sourcePort,
    sni,
    excludeRuleIds,
  });
  return {
    duplicateRule: state.duplicateRule,
    shareableRuleIds: state.shareableRuleIds,
    assertCanUseSni: () => assertDirectTunnelSniEntryPortUse(state, sourcePort, sni),
  };
}

export const portsRulesRouter = router({
  checkPort: protectedProcedure
    .input(z.object({
      hostId: z.number().int().positive().optional(),
      forwardGroupId: z.number().int().positive().optional(),
      tunnelId: z.number().nullable().optional(),
      sourcePort: z.number().min(1).max(65535),
      excludeRuleId: z.number().optional(),
      protocol: z.enum(["tcp", "udp", "both"]).optional().default("both"),
      sni: z.string().max(1024).nullable().optional(),
      forwardType: z.string().max(32).optional().default("iptables"),
    }).refine(
      (input) => !!input.hostId !== !!input.forwardGroupId,
      { message: "请选择一个主机、隧道或转发组" },
    ))
    .query(async ({ input, ctx }) => {
      if (input.excludeRuleId) {
        await requireRuleAccess(ctx, input.excludeRuleId);
      }
      const normalizedSni = normalizeSniValue(input.sni);
      if (normalizedSni && (!isValidSniValue(normalizedSni) || ctx.user.role !== "admin")) {
        return { used: true, reason: "SNI 域名格式不正确或当前账号无权配置" };
      }
      const excludeRuleIds = await resolveExcludeRuleIds(input.excludeRuleId);
      if (input.forwardGroupId) {
        if (ctx.user.role !== "admin") {
          await requireForwardGroupPortAccess(ctx, input.forwardGroupId);
          const planRange = await db.getUserForwardGroupPlanPortRange(ctx.user.id, input.forwardGroupId);
          if (planRange && !db.isPortAllowedByUserPlanRange(input.sourcePort, planRange)) {
            const ranges = planRange.ranges.map((range) => `${range.start}-${range.end}`).join(",");
            return { used: true, reason: `套餐端口必须在 ${ranges} 范围内` };
          }
        }
        try {
          let portUsageIgnoreRuleIds = excludeRuleIds;
          if (normalizedSni) {
            const lookup = await loadSniEntryPortState({
              forwardGroupId: input.forwardGroupId,
              sourcePort: input.sourcePort,
              sni: normalizedSni,
              excludeRuleIds,
            });
            if (lookup) {
              const conflict = sniEntryPortConflictReason(lookup.assertCanUseSni);
              if (conflict) return { used: true, reason: conflict };
              portUsageIgnoreRuleIds = [...excludeRuleIds, ...lookup.shareableRuleIds];
            }
          }
          await db.validateForwardGroupRuleConfig(input.forwardGroupId, {
            sourcePort: input.sourcePort,
            protocol: input.protocol,
            excludeTemplateRuleId: input.excludeRuleId,
            portUsageIgnoreRuleIds,
          });
          return { used: false };
        } catch (error) {
          const reason = error instanceof Error ? error.message : "";
          const isRangeError = /必须在.*(?:范围|区间)|must be.*range/i.test(reason);
          return {
            used: true,
            ...(isRangeError ? { reason } : {}),
          };
        }
      }

      const hostId = Number(input.hostId);
      let policy = portPolicyFrom(null);
      let selectedTunnel: Tunnel | null = null;
      if (input.tunnelId) {
        const { tunnel } = await requireTunnelUseOrTrafficBillingAccess(ctx, input.tunnelId);
        selectedTunnel = tunnel;
        if (tunnel.entryHostId !== hostId) throw new Error("隧道入口主机与规则主机不一致");
        const host = await db.getHostById(hostId);
        policy = combineHostPortPolicyWithRange(
          host as any,
          (tunnel as any).portRangeStart,
          (tunnel as any).portRangeEnd,
        );
      } else {
        const { host } = await requireHostUseAccess(ctx, hostId);
        policy = portPolicyFrom(host as any);
      }
      if (!isPortAllowedByPolicy(input.sourcePort, policy)) {
        return { used: true, reason: portPolicyErrorMessage(policy) };
      }
      if (ctx.user.role !== "admin") {
        const planRange = await db.getUserPlanPortRange(ctx.user.id, hostId, input.tunnelId ?? undefined);
        if (planRange) {
          policy = combinePortPolicies(policy, portPolicyFrom({
            portRanges: planRange.ranges,
          }));
        }
        if (planRange && !isPortAllowedByPolicy(input.sourcePort, policy)) {
          return { used: true, reason: portPolicyErrorMessage(policy, "套餐端口") };
        }
      }
      let portUsageIgnoreRuleIds = excludeRuleIds;
      if (normalizedSni && input.tunnelId) {
        const lookup = await loadSniEntryPortState({
          tunnel: selectedTunnel,
          sourcePort: input.sourcePort,
          sni: normalizedSni,
          excludeRuleIds,
        });
        if (lookup) {
          const conflict = sniEntryPortConflictReason(lookup.assertCanUseSni);
          if (conflict) return { used: true, reason: conflict };
          portUsageIgnoreRuleIds = [...excludeRuleIds, ...lookup.shareableRuleIds];
        }
      }
      const used = await db.isHostPortUnavailableForExplicitUse(hostId, input.sourcePort, portUsageIgnoreRuleIds, input.protocol, undefined, false);
      if (used) return { used };
      return { used: false };
    }),
  // SNI 分流规则不做端口探测（同组规则共用入口端口是设计本身，探测只会误报），
  // 需要前置反馈的只有域名维度：同一台入口主机上完整域名唯一，跨端口、跨承载资源都算重复。
  checkSni: protectedProcedure
    .input(z.object({
      hostId: z.number().int().positive().optional(),
      forwardGroupId: z.number().int().positive().optional(),
      tunnelId: z.number().nullable().optional(),
      sourcePort: z.number().min(1).max(65535),
      sni: z.string().max(1024),
      excludeRuleId: z.number().optional(),
    }).refine(
      (input) => !!input.hostId !== !!input.forwardGroupId,
      { message: "请选择一个主机、隧道或转发组" },
    ))
    .query(async ({ input, ctx }) => {
      if (ctx.user.role !== "admin") return { ok: false, reason: "SNI 分流仅管理员可配置" };
      const normalizedSni = normalizeSniValue(input.sni);
      if (!normalizedSni) return { ok: true, reason: null };
      if (!isValidSniValue(normalizedSni)) return { ok: false, reason: "SNI 域名格式不正确" };
      if (input.excludeRuleId) {
        await requireRuleAccess(ctx, input.excludeRuleId);
      }
      const excludeRuleIds = await resolveExcludeRuleIds(input.excludeRuleId);
      let lookup: SniEntryPortLookup | null = null;
      if (input.forwardGroupId) {
        await requireForwardGroupPortAccess(ctx, input.forwardGroupId);
        lookup = await loadSniEntryPortState({
          forwardGroupId: input.forwardGroupId,
          sourcePort: input.sourcePort,
          sni: normalizedSni,
          excludeRuleIds,
        });
      } else if (input.tunnelId) {
        const { tunnel } = await requireTunnelUseOrTrafficBillingAccess(ctx, input.tunnelId);
        if (Number(tunnel.entryHostId) !== Number(input.hostId)) {
          return { ok: false, reason: "隧道入口主机与规则主机不一致" };
        }
        lookup = await loadSniEntryPortState({
          tunnel,
          sourcePort: input.sourcePort,
          sni: normalizedSni,
          excludeRuleIds,
        });
      }
      // 只报域名维度的冲突。入口端口被普通规则或其它分流组占用属于端口维度，
      // 由保存时的服务端校验拦截；放进这里只会把端口错误显示在域名输入框下方。
      const reason = sniDomainDuplicateReason(lookup?.duplicateRule, normalizedSni);
      return reason ? { ok: false, reason } : { ok: true, reason: null };
    }),
  randomPort: protectedProcedure
    .input(randomPortInputSchema)
    .query(async ({ input, ctx }) => {
      if (input.excludeRuleId) {
        await requireRuleAccess(ctx, input.excludeRuleId);
      }
      if (input.forwardGroupId) {
        let planRange: Awaited<ReturnType<typeof db.getUserForwardGroupPlanPortRange>> = null;
        if (ctx.user.role !== "admin") {
          await requireForwardGroupPortAccess(ctx, input.forwardGroupId);
          planRange = await db.getUserForwardGroupPlanPortRange(ctx.user.id, input.forwardGroupId);
        }
        const port = await db.findAvailableForwardGroupPort(input.forwardGroupId, input.excludeRuleId, planRange, input.protocol);
        if (!port) throw new Error("转发组入口端口区间内已无可用端口");
        return { port };
      }
      if (!input.hostId) throw new Error("请选择主机");
      let rangeStart: number | null | undefined;
      let rangeEnd: number | null | undefined;
      let planRange: Awaited<ReturnType<typeof db.getUserPlanPortRange>> = null;
      if (input.tunnelId) {
        const { tunnel } = await requireTunnelUseOrTrafficBillingAccess(ctx, input.tunnelId);
        if (tunnel.entryHostId !== input.hostId) throw new Error("隧道入口主机与规则主机不一致");
        rangeStart = (tunnel as any).portRangeStart;
        rangeEnd = (tunnel as any).portRangeEnd;
      } else {
        await requireHostUseAccess(ctx, input.hostId);
      }
      if (ctx.user.role !== "admin") {
        planRange = await db.getUserPlanPortRange(ctx.user.id, input.hostId, input.tunnelId ?? undefined);
        // Keep the subscription's disjoint ranges intact. The repository
        // intersects them with the host/tunnel policy when selecting a port.
      }
      const excludeRuleIds = await resolveExcludeRuleIds(input.excludeRuleId);
      const port = await db.findAvailablePort(
        input.hostId,
        rangeStart,
        rangeEnd,
        input.protocol,
        [],
        excludeRuleIds,
        planRange?.ranges || [],
      );
      if (!port) throw new Error("该主机端口区间内已无可用端口");
      return { port };
    }),
});
