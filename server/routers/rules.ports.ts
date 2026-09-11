import { protectedProcedure, router } from "../_core/trpc";
import { z } from "zod";
import * as db from "../db";
import {
  requireHostUseAccess,
  requireRuleAccess,
  requireTrafficBillingAccessIfConfigured,
  requireTunnelUseOrTrafficBillingAccess,
} from "./helpers";
import { combineHostPortPolicyWithRange, combinePortPolicies, isPortAllowedByPolicy, portPolicyErrorMessage, portPolicyFrom } from "../portPolicy";
import { isValidSniValue, normalizeSniValue } from "@shared/sni";

const randomPortInputSchema = z.object({
  hostId: z.number().optional(),
  tunnelId: z.number().nullable().optional(),
  forwardGroupId: z.number().optional(),
  excludeRuleId: z.number().optional(),
  protocol: z.enum(["tcp", "udp", "both"]).optional().default("both"),
});

function databaseBool(value: unknown, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (value === true || value === 1) return true;
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true";
}

async function tunnelEntryHostIds(tunnel: any) {
  const hostIds = new Set<number>();
  const primaryEntryHostId = Number(tunnel?.entryHostId || 0);
  if (primaryEntryHostId > 0) hostIds.add(primaryEntryHostId);
  const entryGroupId = Number(tunnel?.entryGroupId || 0);
  if (entryGroupId <= 0) return Array.from(hostIds);
  const entryGroup = await db.getForwardGroupById(entryGroupId) as any;
  if (!entryGroup || !databaseBool(entryGroup.isEnabled) || String(entryGroup.groupMode || "") !== "entry") {
    return Array.from(hostIds);
  }
  for (const member of entryGroup.members || []) {
    if (!member || !databaseBool(member.isEnabled, true) || String(member.memberType || "") !== "host") continue;
    const hostId = Number(member.hostId || 0);
    if (hostId > 0) hostIds.add(hostId);
  }
  return Array.from(hostIds);
}

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
      const excludeRuleIds = input.excludeRuleId
        ? [
            input.excludeRuleId,
            ...((await db.getForwardGroupChildRulesForTemplate(input.excludeRuleId)) as any[]).map((rule: any) => Number(rule.id)),
          ]
        : [];
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
            const entryHostIds = await db.getForwardGroupRuleEntryHostIds(input.forwardGroupId);
            const state = await db.getForwardGroupSniEntryPortState({
              groupId: input.forwardGroupId,
              sourcePort: input.sourcePort,
              entryHostIds,
              sni: normalizedSni,
              excludeRuleIds,
            });
            if (state.duplicateRule) {
              return { used: true, reason: `SNI 域名 ${normalizedSni} 已存在` };
            }
            if (state.plainRule || state.otherGroupSniRule) {
              return { used: true, reason: "入口端口已被其它规则占用" };
            }
            portUsageIgnoreRuleIds = [
              ...excludeRuleIds,
              ...state.shareableRuleIds,
            ];
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
      let selectedTunnel: any = null;
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
        const excluded = new Set(excludeRuleIds.map(Number));
        const ruleById = new Map<number, any>();
        const entryHostIds = await tunnelEntryHostIds(selectedTunnel);
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
          && !excluded.has(Number(rule.id || 0))
          && !databaseBool(rule.pendingDelete)
          && !databaseBool(rule.isForwardGroupTemplate)
        ));
        const duplicate = rows.find((rule) => (
          normalizeSniValue(rule.sni) === normalizedSni
        ));
        if (duplicate) return { used: true, reason: `SNI 域名 ${normalizedSni} 已存在` };
        const activeRows = rows.filter((rule) => (
          databaseBool(rule.isEnabled)
          && Number(rule.sourcePort || 0) === Number(input.sourcePort)
        ));
        const shareableRows = activeRows.filter((rule) => (
          Number(rule.tunnelId || 0) === Number(input.tunnelId)
          && !!normalizeSniValue(rule.sni)
        ));
        if (activeRows.length !== shareableRows.length) {
          return { used: true, reason: "入口端口已被其它规则占用" };
        }
        portUsageIgnoreRuleIds = [
          ...excludeRuleIds,
          ...shareableRows.map((rule) => Number(rule.id || 0)).filter((id) => id > 0),
        ];
      }
      const used = await db.isHostPortUnavailableForExplicitUse(hostId, input.sourcePort, portUsageIgnoreRuleIds, input.protocol, undefined, false);
      return { used };
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
      const excludeRuleIds = input.excludeRuleId
        ? [
            input.excludeRuleId,
            ...((await db.getForwardGroupChildRulesForTemplate(input.excludeRuleId)) as any[]).map((rule: any) => Number(rule.id)),
          ]
        : [];
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
