import { protectedProcedure, router } from "../_core/trpc";
import { z } from "zod";
import * as db from "../db";
import { crudRulesRouter } from "./rules.crud";
import { copyRulesRouter } from "./rules.copy";
import { portsRulesRouter } from "./rules.ports";
import { selfTestRulesRouter } from "./rules.selfTest";
import { trafficRulesRouter } from "./rules.traffic";

function isVisibleForwardGroupRuleForUser(rule: any, allowedForwardGroupIds: Set<number>) {
  return !!rule?.isForwardGroupTemplate
    && !!rule?.forwardGroupId
    && !rule?.forwardGroupRuleId
    && !rule?.forwardGroupMemberId
    && allowedForwardGroupIds.has(Number(rule.forwardGroupId));
}

export const rulesRouter = router({
  list: protectedProcedure
    .input(z.object({
      hostId: z.number().optional(),
      userId: z.number().optional(),
      scope: z.enum(["self", "all"]).optional(),
      tunnelId: z.number().nullable().optional(),
    }).optional())
    .query(async ({ input, ctx }) => {
      const isAdmin = ctx.user.role === "admin";
      const requestedUserId = isAdmin
        ? input?.scope === "all"
          ? undefined
          : input?.userId ?? ctx.user.id
        : ctx.user.id;
      const rules = await db.getForwardRules(requestedUserId, input?.hostId);
      const allowedForwardGroupIds = isAdmin ? new Set<number>() : new Set(await db.getUserAllowedForwardGroupIds(ctx.user.id));
      const visibleRules = isAdmin
        ? rules
        : rules.filter((rule: any) => {
          const isForwardGroupRule = !!(rule?.forwardGroupId || rule?.isForwardGroupTemplate || rule?.forwardGroupRuleId || rule?.forwardGroupMemberId);
          return !isForwardGroupRule || isVisibleForwardGroupRuleForUser(rule, allowedForwardGroupIds);
        });
      if (input?.tunnelId === undefined) return visibleRules;
      if (input.tunnelId === null) return visibleRules.filter((rule: any) => !rule.tunnelId);
      return visibleRules.filter((rule: any) => Number(rule.tunnelId || 0) === Number(input.tunnelId));
    }),
  getById: protectedProcedure
    .input(z.object({ id: z.number() }))
    .query(async ({ input, ctx }) => {
      const rule = await db.getForwardRuleById(input.id);
      if (!rule) return null;
      if (ctx.user.role !== "admin" && rule.userId !== ctx.user.id) return null;
      if (ctx.user.role !== "admin") {
        const isForwardGroupRule = !!(rule?.forwardGroupId || rule?.isForwardGroupTemplate || rule?.forwardGroupRuleId || rule?.forwardGroupMemberId);
        if (isForwardGroupRule) {
          const allowedForwardGroupIds = new Set(await db.getUserAllowedForwardGroupIds(ctx.user.id));
          if (!isVisibleForwardGroupRuleForUser(rule, allowedForwardGroupIds)) return null;
        }
      }
      return rule;
    }),
  ...portsRulesRouter._def.procedures,
  ...copyRulesRouter._def.procedures,
  ...crudRulesRouter._def.procedures,
  ...trafficRulesRouter._def.procedures,
  ...selfTestRulesRouter._def.procedures,
});
