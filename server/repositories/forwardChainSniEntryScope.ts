import { inArray } from "drizzle-orm";
import { forwardGroupMembers, forwardGroups, forwardRules } from "../../drizzle/schema";
import { getDb } from "../dbRuntime";
import { normalizePositiveIds, normalizeSniValue } from "./repositoryUtils";

export type ForwardChainSniEntryRuleCandidate = {
  id?: unknown;
  hostId?: unknown;
  forwardGroupId?: unknown;
  forwardGroupRuleId?: unknown;
  isForwardGroupTemplate?: unknown;
  sourcePort?: unknown;
  sni?: unknown;
};

type ForwardChainGroupRow = {
  id: number;
  groupMode: string;
  entryGroupId: number | null;
  isEnabled: unknown;
};

type ForwardChainMemberRow = {
  id: number;
  groupId: number;
  memberType: string;
  hostId: number | null;
  priority: number;
  isEnabled: unknown;
};

function dbBool(value: unknown) {
  if (value === true || value === 1) return true;
  return typeof value === "string" && ["1", "true"].includes(value.trim().toLowerCase());
}

async function loadInBatches<T>(
  ids: number[],
  load: (batch: number[]) => Promise<T[]>,
) {
  const rows: T[] = [];
  for (let index = 0; index < ids.length; index += 400) {
    rows.push(...await load(ids.slice(index, index + 400)));
  }
  return rows;
}

export async function getForwardChainSniEntryRuleIds(
  inputRows: ForwardChainSniEntryRuleCandidate[],
): Promise<Set<number>> {
  const db = await getDb();
  if (!db || inputRows.length === 0) return new Set<number>();

  const candidates = inputRows.filter((row) => (
    Number(row.id || 0) > 0
    && Number(row.forwardGroupId || 0) > 0
    && !!normalizeSniValue(row.sni)
  ));
  if (candidates.length === 0) return new Set<number>();

  const referencedTemplateIds = normalizePositiveIds(candidates
    .filter((row) => !dbBool(row.isForwardGroupTemplate))
    .map((row) => row.forwardGroupRuleId));
  const referencedTemplates = await loadInBatches<ForwardChainSniEntryRuleCandidate>(referencedTemplateIds, async (ids) => (
    await db.select({
      id: forwardRules.id,
      forwardGroupId: forwardRules.forwardGroupId,
      isForwardGroupTemplate: forwardRules.isForwardGroupTemplate,
      sourcePort: forwardRules.sourcePort,
      sni: forwardRules.sni,
    }).from(forwardRules).where(inArray(forwardRules.id, ids)) as ForwardChainSniEntryRuleCandidate[]
  ));
  const templates = [
    ...candidates.filter((row) => dbBool(row.isForwardGroupTemplate)),
    ...referencedTemplates,
  ];
  const templateById = new Map(templates.map((row) => [Number(row.id), row]));
  const groupIds = normalizePositiveIds([
    ...candidates.map((row) => row.forwardGroupId),
    ...templates.map((row) => row.forwardGroupId),
  ]);
  const chainGroups = await loadInBatches<ForwardChainGroupRow>(groupIds, async (ids) => (
    await db.select({
      id: forwardGroups.id,
      groupMode: forwardGroups.groupMode,
      entryGroupId: forwardGroups.entryGroupId,
      isEnabled: forwardGroups.isEnabled,
    }).from(forwardGroups).where(inArray(forwardGroups.id, ids)) as ForwardChainGroupRow[]
  ));
  const entryGroupIds = normalizePositiveIds(chainGroups
    .filter((group) => String(group.groupMode || "") === "chain")
    .map((group) => group.entryGroupId));
  const entryGroups = await loadInBatches<ForwardChainGroupRow>(entryGroupIds, async (ids) => (
    await db.select({
      id: forwardGroups.id,
      groupMode: forwardGroups.groupMode,
      entryGroupId: forwardGroups.entryGroupId,
      isEnabled: forwardGroups.isEnabled,
    }).from(forwardGroups).where(inArray(forwardGroups.id, ids)) as ForwardChainGroupRow[]
  ));
  const groupById = new Map([...chainGroups, ...entryGroups]
    .map((group) => [Number(group.id), group]));
  const memberGroupIds = normalizePositiveIds([...groupIds, ...entryGroupIds]);
  const members = await loadInBatches<ForwardChainMemberRow>(memberGroupIds, async (ids) => (
    await db.select({
      id: forwardGroupMembers.id,
      groupId: forwardGroupMembers.groupId,
      memberType: forwardGroupMembers.memberType,
      hostId: forwardGroupMembers.hostId,
      priority: forwardGroupMembers.priority,
      isEnabled: forwardGroupMembers.isEnabled,
    }).from(forwardGroupMembers).where(inArray(forwardGroupMembers.groupId, ids)) as ForwardChainMemberRow[]
  ));
  const membersByGroupId = new Map<number, typeof members>();
  for (const member of members) {
    const groupId = Number(member.groupId || 0);
    membersByGroupId.set(groupId, [...(membersByGroupId.get(groupId) || []), member]);
  }
  const enabledHostMembers = (groupId: number) => (membersByGroupId.get(groupId) || [])
    .filter((member) => (
      dbBool(member.isEnabled)
      && String(member.memberType || "") === "host"
      && Number(member.hostId || 0) > 0
    ))
    .sort((left, right) => (
      Number(left.priority || 0) - Number(right.priority || 0)
      || Number(left.id || 0) - Number(right.id || 0)
    ));
  const entryHostIdsByChain = new Map<number, Set<number>>();
  for (const group of chainGroups) {
    if (String(group.groupMode || "") !== "chain") continue;
    const groupId = Number(group.id);
    const entryGroupId = Number(group.entryGroupId || 0);
    const entryGroup = groupById.get(entryGroupId);
    const externalEntryMembers = entryGroup
      && String(entryGroup.groupMode || "") === "entry"
      && dbBool(entryGroup.isEnabled)
      ? enabledHostMembers(entryGroupId)
      : [];
    const entryMembers = externalEntryMembers.length > 0
      ? externalEntryMembers
      : enabledHostMembers(groupId).slice(0, 1);
    entryHostIdsByChain.set(groupId, new Set(entryMembers.map((member) => Number(member.hostId))));
  }

  const ruleIds = new Set<number>();
  for (const row of candidates) {
    const ruleId = Number(row.id);
    const groupId = Number(row.forwardGroupId);
    if (!entryHostIdsByChain.has(groupId)) continue;
    if (dbBool(row.isForwardGroupTemplate)) {
      ruleIds.add(ruleId);
      continue;
    }
    const template = templateById.get(Number(row.forwardGroupRuleId || 0));
    if (
      !template
      || !dbBool(template.isForwardGroupTemplate)
      || Number(template.forwardGroupId || 0) !== groupId
      || Number(template.sourcePort || 0) !== Number(row.sourcePort || 0)
      || !entryHostIdsByChain.get(groupId)?.has(Number(row.hostId || 0))
    ) continue;
    ruleIds.add(ruleId);
  }
  return ruleIds;
}
