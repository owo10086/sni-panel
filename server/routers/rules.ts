import { protectedProcedure, router } from "../_core/trpc";
import { z } from "zod";
import * as db from "../db";
import { crudRulesRouter } from "./rules.crud";
import { portsRulesRouter } from "./rules.ports";
import { selfTestRulesRouter } from "./rules.selfTest";
import { trafficRulesRouter } from "./rules.traffic";
import { canUseForwardRuleResource, getLinkAccessScope } from "../linkAccessView";
import { isManagedForwardGroupChildRule } from "../forwardRuleVisibility";
import { getSniRuntimeGroupStatus } from "../sniRuntimeObservability";
import { getPortOccupancy, inspectPortOccupancy } from "../portOccupancy";
import { getRulePortWarnings, type RulePortWarning } from "../rulePortOccupancy";
import { getRulePortFailure } from "../rulePortFailure";
import { isHostStatusOnline } from "../hostStatusNotifier";
import { normalizeSniValue } from "@shared/sni";
import type { ForwardRule } from "../../drizzle/schema";

type SniRuntimeRuleStatus = {
  observed: boolean;
  applied: boolean;
  currentVersion: number;
  unmatchedConnections: number;
  lastConfigError: string;
  observedAt: number;
  exitHostId: number;
};

type ForwardRuleView = ForwardRule & {
  sniRuntime?: SniRuntimeRuleStatus;
  portOccupancyWarnings?: RulePortWarning[];
  portBindFailure?: string | null;
  resourceAccessAllowed?: boolean;
};

type ForwardRulePageInput = { items: ForwardRule[] };
type ForwardRulePageView = { items: ForwardRuleView[] };
type ForwardRuleViewInput = ForwardRule | ForwardRule[] | ForwardRulePageInput | null | undefined;
type ForwardRuleViewOutput = ForwardRuleView | ForwardRuleView[] | ForwardRulePageView | null | undefined;

type SniRuntimeForwardGroup = {
  id: unknown;
  members?: Array<{
    hostId?: unknown;
    isEnabled?: unknown;
    memberType?: unknown;
    priority?: unknown;
  }>;
};

function runtimeBool(value: unknown, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return value === true || value === 1 || value === "1" || String(value).trim().toLowerCase() === "true";
}

function isForwardRulePage(value: ForwardRuleViewInput): value is ForwardRulePageInput {
  return !!value && !Array.isArray(value) && "items" in value && Array.isArray(value.items);
}

function mapForwardRuleView(
  value: ForwardRuleViewInput,
  decorate: (rule: ForwardRule) => ForwardRuleView,
): ForwardRuleViewOutput {
  if (Array.isArray(value)) return value.map(decorate);
  if (isForwardRulePage(value)) return { ...value, items: value.items.map(decorate) };
  return value ? decorate(value) : value;
}

async function attachSniRuntimeStatus(value: ForwardRuleViewInput): Promise<ForwardRuleViewOutput> {
  const rules = Array.isArray(value)
    ? value
    : isForwardRulePage(value)
      ? value.items
      : value
        ? [value]
        : [];
  const sniRules = rules.filter((rule) => (
    !!normalizeSniValue(rule.sni)
    && (Number(rule.forwardGroupId || 0) > 0 || Number(rule.tunnelId || 0) > 0)
    && Number(rule.sniSplitterPort || 0) > 0
  ));
  if (sniRules.length === 0) return value;
  const groupIds = Array.from(new Set(sniRules
    .map((rule) => Number(rule.forwardGroupId || 0))
    .filter((id) => id > 0)));
  const tunnelIds = Array.from(new Set(sniRules
    .map((rule) => Number(rule.tunnelId || 0))
    .filter((id) => id > 0)));
  const [groups, tunnels] = await Promise.all([
    groupIds.length > 0
      ? db.getForwardGroups(undefined, { includeRuntime: false, ids: groupIds }) as Promise<SniRuntimeForwardGroup[]>
      : Promise.resolve([] as SniRuntimeForwardGroup[]),
    Promise.all(tunnelIds.map((id) => db.getTunnelById(id))),
  ]);
  const groupById = new Map(groups.map((group) => [Number(group.id), group]));
  const tunnelById = new Map(tunnels.filter(Boolean).map((tunnel: any) => [Number(tunnel.id), tunnel]));
  const decorate = (rule: ForwardRule): ForwardRuleView => {
    const sni = normalizeSniValue(rule.sni);
    const splitterPort = Number(rule.sniSplitterPort || 0);
    const group = groupById.get(Number(rule.forwardGroupId || 0));
    const tunnel = tunnelById.get(Number(rule.tunnelId || 0));
    if (!sni || splitterPort <= 0 || (!group && !tunnel)) return rule;
    const exitHostId = tunnel
      ? Number((tunnel as any).exitHostId || 0)
      : Number([...(group?.members || [])]
        .filter((member) => (
          runtimeBool(member.isEnabled, true)
          && String(member.memberType || "") === "host"
          && Number(member.hostId || 0) > 0
        ))
        .sort((left, right) => Number(left.priority) - Number(right.priority))
        .at(-1)?.hostId || 0);
    const runtime = getSniRuntimeGroupStatus(exitHostId, splitterPort);
    return {
      ...rule,
      sniRuntime: {
        observed: !!runtime,
        applied: !!runtime?.appliedDomains.includes(sni),
        currentVersion: Number(runtime?.currentVersion || 0),
        unmatchedConnections: Number(runtime?.unmatchedConnections || 0),
        lastConfigError: String(runtime?.lastConfigError || ""),
        observedAt: Number(runtime?.observedAt || 0),
        exitHostId,
      },
    };
  };
  return mapForwardRuleView(value, decorate);
}

async function withRuleResourceAccess(value: ForwardRule[], user: { id: number; role: string }): Promise<ForwardRuleView[]>;
async function withRuleResourceAccess<T extends ForwardRulePageInput>(
  value: T,
  user: { id: number; role: string },
): Promise<Omit<T, "items"> & { items: ForwardRuleView[] }>;
async function withRuleResourceAccess(
  value: ForwardRule | null | undefined,
  user: { id: number; role: string },
): Promise<ForwardRuleView | null | undefined>;
async function withRuleResourceAccess(
  value: ForwardRuleViewInput,
  user: { id: number; role: string },
): Promise<ForwardRuleViewOutput> {
  const ruleRows = Array.isArray(value) ? value : isForwardRulePage(value) ? value.items : value ? [value] : [];
  const groupIds = Array.from(new Set(ruleRows
    .filter((rule) => rule.isEnabled)
    .map((rule) => Number(rule.forwardGroupId || 0)).filter((id) => id > 0)));
  const groupHostIds = new Map(await Promise.all(groupIds.map(async (id) =>
    [id, await db.getForwardGroupRuleEntryHostIds(id)] as const)));
  const tunnelIds = Array.from(new Set(ruleRows
    .filter((rule) => rule.isEnabled && !rule.forwardGroupId)
    .map((rule) => Number(rule.tunnelId || 0)).filter((id) => id > 0)));
  const tunnelEntryHostIds = new Map(await Promise.all(tunnelIds.map(async (id) => {
    const tunnel = await db.getTunnelById(id);
    const entryGroupId = Number((tunnel as any)?.entryGroupId || 0);
    return [id, entryGroupId ? await db.getForwardGroupRuleEntryHostIds(entryGroupId) : []] as const;
  })));
  const entryHostsForRule = (rule: ForwardRule) =>
    groupHostIds.get(Number(rule.forwardGroupId || 0)) ||
    tunnelEntryHostIds.get(Number(rule.tunnelId || 0)) || [Number(rule.hostId)];
  const occupancyHostIds = Array.from(new Set(ruleRows
    .filter((rule) => rule.isEnabled)
    .flatMap(entryHostsForRule)
    .filter((id) => id > 0)));
  const onlineHosts = new Map(await Promise.all(occupancyHostIds.map(async (id) =>
    [id, isHostStatusOnline(await db.getHostById(id))] as const)));
  const decorateOccupancy = (rule: ForwardRule): ForwardRuleView => {
    const entries = rule.isEnabled ? getRulePortWarnings(Number(rule.id), user.role === "admin") : [];
    const warnings = entries.map((entry) => onlineHosts.get(entry.hostId) && getPortOccupancy(entry.hostId)
      ? entry
      : { status: "unverified" as const, message: "主机端口信息未经核实", hostId: entry.hostId });
    if (rule.isEnabled) {
      for (const hostId of entryHostsForRule(rule)) {
        if (warnings.some((entry) => entry.hostId === hostId)) continue;
        const status = inspectPortOccupancy(onlineHosts.get(hostId) ? getPortOccupancy(hostId) : null, Number(rule.sourcePort),
          rule.protocol === "udp" ? "udp" : rule.protocol === "tcp" ? "tcp" : "both");
        if (status.status === "unverified") {
          warnings.push({ status: "unverified", message: "主机端口信息未经核实", hostId });
        }
      }
    }
    return { ...rule, portOccupancyWarnings: warnings, portBindFailure: getRulePortFailure(Number(rule.id), user.role === "admin") };
  };
  const decorated = mapForwardRuleView(value, decorateOccupancy);
  if (user.role === "admin") return attachSniRuntimeStatus(decorated);
  const scope = await getLinkAccessScope(user);
  const decorate = (rule: ForwardRule): ForwardRuleView => ({
    ...rule,
    resourceAccessAllowed: canUseForwardRuleResource(rule, scope),
  });
  return mapForwardRuleView(decorated, decorate);
}


type RuleListCategory = "all" | "local" | "tunnel" | "chain" | "group";
type RuleResourceType = "local" | "tunnel" | "chain" | "group";
type RuleListFilters = {
  userId?: number;
  scope?: "self" | "all";
  entryHostId?: number | null;
  resourceType?: RuleResourceType | null;
  resourceId?: number | null;
  category: RuleListCategory;
  search: string;
};

async function getRuleListRepositoryInput(
  input: RuleListFilters,
  user: { id: number; role: string },
) {
  const isAdmin = user.role === "admin";
  const accessScope = isAdmin ? null : await getLinkAccessScope(user);
  const ownerUserId = isAdmin
    ? input.scope === "all"
      ? undefined
      : input.userId ?? user.id
    : user.id;
  return {
    ownerUserId,
    searchVisibleHostIds: accessScope
      ? Array.from(accessScope.useHostIds || accessScope.hostIds)
      : undefined,
    searchVisibleTunnelIds: accessScope
      ? Array.from(accessScope.useTunnelIds || accessScope.tunnelIds)
      : undefined,
    searchVisibleForwardGroupIds: accessScope
      ? Array.from(accessScope.useGroupIds || accessScope.groupIds)
      : undefined,
    entryHostId: input.entryHostId,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    category: input.category,
    search: input.search,
  };
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
      const filtered = input?.tunnelId === undefined
        ? rules
        : input.tunnelId === null
          ? rules.filter((rule: any) => !rule.tunnelId)
          : rules.filter((rule: any) => Number(rule.tunnelId || 0) === Number(input.tunnelId));
      return withRuleResourceAccess(filtered, ctx.user);
    }),
  listPage: protectedProcedure
    .input(z.object({
      page: z.number().int().positive().default(1),
      pageSize: z.number().int().min(1).max(100).default(12),
      userId: z.number().optional(),
      scope: z.enum(["self", "all"]).optional(),
      entryHostId: z.number().int().positive().nullable().optional(),
      resourceType: z.enum(["local", "tunnel", "chain", "group"]).nullable().optional(),
      resourceId: z.number().int().positive().nullable().optional(),
      category: z.enum(["all", "local", "tunnel", "chain", "group"]).default("all"),
      search: z.string().trim().max(200).optional().default(""),
    }))
    .query(async ({ input, ctx }) => {
      const repositoryInput = await getRuleListRepositoryInput(input, ctx.user);
      const page = await db.getForwardRulesPage({ ...repositoryInput, page: input.page, pageSize: input.pageSize });
      return withRuleResourceAccess(page, ctx.user);
    }),
  mapItems: protectedProcedure
    .input(z.object({
      cursor: z.number().int().min(0).optional(),
      limit: z.number().int().min(20).max(250).default(100),
      userId: z.number().optional(),
      scope: z.enum(["self", "all"]).optional(),
      entryHostId: z.number().int().positive().nullable().optional(),
      resourceType: z.enum(["local", "tunnel", "chain", "group"]).nullable().optional(),
      resourceId: z.number().int().positive().nullable().optional(),
      category: z.enum(["all", "local", "tunnel", "chain", "group"]).default("all"),
      search: z.string().trim().max(200).optional().default(""),
    }))
    .query(async ({ input, ctx }) => {
      const repositoryInput = await getRuleListRepositoryInput(input, ctx.user);
      const batch = await db.getForwardRuleMapBatch(repositoryInput, input.cursor || 0, input.limit);
      return withRuleResourceAccess(batch, ctx.user);
    }),
  listSummary: protectedProcedure
    .input(z.object({
      userId: z.number().optional(),
      scope: z.enum(["self", "all"]).optional(),
      entryHostId: z.number().int().positive().nullable().optional(),
      resourceType: z.enum(["local", "tunnel", "chain", "group"]).nullable().optional(),
      resourceId: z.number().int().positive().nullable().optional(),
      category: z.enum(["all", "local", "tunnel", "chain", "group"]).default("all"),
      search: z.string().trim().max(200).optional().default(""),
    }))
    .query(async ({ input, ctx }) => {
      const repositoryInput = await getRuleListRepositoryInput(input, ctx.user);
      const selection = await db.getForwardRuleSummarySelection(repositoryInput);
      const [totalRows, dailyRows] = selection.ruleIds.length > 0
        ? await Promise.all([
          db.getTrafficCounterSummaryByRule({
            userId: ctx.user.role === "admin" ? undefined : ctx.user.id,
            ruleIds: selection.ruleIds,
          }),
          db.getTrafficSummaryByRule({
            userId: ctx.user.role === "admin" ? undefined : ctx.user.id,
            ruleIds: selection.ruleIds,
            since: new Date(Date.now() - 24 * 60 * 60 * 1000),
          }),
        ])
        : [[], []];
      const sumRows = (rows: any[]) => rows.reduce((total, row) => ({
        bytesIn: total.bytesIn + Math.max(0, Number(row?.bytesIn) || 0),
        bytesOut: total.bytesOut + Math.max(0, Number(row?.bytesOut) || 0),
        connections: total.connections + Math.max(0, Number(row?.connections) || 0),
      }), { bytesIn: 0, bytesOut: 0, connections: 0 });
      return {
        totalItems: selection.totalItems,
        activeItems: selection.activeItems,
        totalTraffic: sumRows(totalRows as any[]),
        dailyTraffic: sumRows(dailyRows as any[]),
      };
    }),
  getById: protectedProcedure
    .input(z.object({ id: z.number() }))
    .query(async ({ input, ctx }) => {
      const rule = await db.getForwardRuleById(input.id);
      if (!rule) return null;
      if (ctx.user.role !== "admin" && rule.userId !== ctx.user.id) return null;
      if (ctx.user.role !== "admin" && isManagedForwardGroupChildRule(rule)) return null;
      return withRuleResourceAccess(rule, ctx.user);
    }),
  reorder: protectedProcedure
    .input(z.object({
      category: z.enum(["local", "tunnel", "chain", "group"]),
      ids: z.array(z.number().int().positive()).min(1),
      startIndex: z.number().int().min(0).max(1_000_000).optional().default(0),
    }))
    .mutation(async ({ input, ctx }) => {
      await db.reorderForwardRules(input.category, input.ids, ctx.user.role === "admin" ? undefined : ctx.user.id, input.startIndex);
      return { success: true };
    }),
  ...portsRulesRouter._def.procedures,
  ...crudRulesRouter._def.procedures,
  ...trafficRulesRouter._def.procedures,
  ...selfTestRulesRouter._def.procedures,
});
