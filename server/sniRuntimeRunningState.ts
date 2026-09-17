import { isSniEntryAgentVersionSupported, normalizeSniValue } from "@shared/sni";
import { inArray, or } from "drizzle-orm";
import { forwardGroupMembers, forwardGroups, forwardRules, hosts } from "../drizzle/schema";
import * as db from "./db";
import { withKeyedTaskLock } from "./keyedTaskLock";
import { getSniRuntimeGroupStatus } from "./sniRuntimeObservability";

function runtimeBool(value: unknown, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return value === true || value === 1 || value === "1" || String(value).trim().toLowerCase() === "true";
}

function runtimeHasDomain(hostId: number, port: number, sni: string) {
  return !!getSniRuntimeGroupStatus(hostId, port)?.appliedDomains.includes(sni);
}

function positiveIds(values: unknown[]) {
  return Array.from(new Set(values
    .map((value) => Number(value || 0))
    .filter((value) => Number.isInteger(value) && value > 0)));
}

async function selectInBatches<T>(ids: number[], load: (batch: number[]) => Promise<T[]>) {
  const rows: T[] = [];
  for (let index = 0; index < ids.length; index += 400) {
    rows.push(...await load(ids.slice(index, index + 400)));
  }
  return rows;
}

export async function reconcileSniChainRunningStateForHost(hostIdValue: unknown) {
  const hostId = Number(hostIdValue || 0);
  if (!Number.isInteger(hostId) || hostId <= 0) return new Map<number, boolean>();
  const rules = await db.getForwardRulesForAgent(hostId) as any[];
  const relevantRules = rules
    .filter((rule) => (
      normalizeSniValue(rule?.sni)
      && Number(rule?.sniSplitterPort || 0) > 0
      && Number(rule?.forwardGroupId || 0) > 0
      && Number(rule?.forwardGroupRuleId || 0) > 0
    ));
  const templateRuleIds = positiveIds(relevantRules.map((rule) => rule.forwardGroupRuleId));
  if (templateRuleIds.length === 0) return new Map<number, boolean>();

  return withKeyedTaskLock("sni-chain-running-state", async () => {
    const database = await db.getDb();
    if (!database) return new Map<number, boolean>();
    const templateRuleIdSet = new Set(templateRuleIds);
    const ruleRows = await selectInBatches<any>(templateRuleIds, (batch) => database
      .select()
      .from(forwardRules)
      .where(or(
        inArray(forwardRules.id, batch),
        inArray(forwardRules.forwardGroupRuleId, batch),
      )));
    const templates = ruleRows.filter((rule) => templateRuleIdSet.has(Number(rule.id || 0)));
    const childrenByTemplateId = new Map<number, any[]>();
    for (const rule of ruleRows) {
      const templateId = Number(rule.forwardGroupRuleId || 0);
      if (!templateRuleIdSet.has(templateId)) continue;
      childrenByTemplateId.set(templateId, [...(childrenByTemplateId.get(templateId) || []), rule]);
    }

    const groupIds = positiveIds(templates.map((template) => template.forwardGroupId));
    const chainGroups = await selectInBatches<any>(groupIds, (batch) => database
      .select()
      .from(forwardGroups)
      .where(inArray(forwardGroups.id, batch)));
    const entryGroupIds = positiveIds(chainGroups.map((group) => group.entryGroupId));
    const entryGroups = await selectInBatches<any>(entryGroupIds, (batch) => database
      .select()
      .from(forwardGroups)
      .where(inArray(forwardGroups.id, batch)));
    const groupById = new Map([...chainGroups, ...entryGroups]
      .map((group) => [Number(group.id), group]));
    const allGroupIds = positiveIds([...groupIds, ...entryGroupIds]);
    const memberRows = await selectInBatches<any>(allGroupIds, (batch) => database
      .select()
      .from(forwardGroupMembers)
      .where(inArray(forwardGroupMembers.groupId, batch)));
    const membersByGroupId = new Map<number, any[]>();
    for (const member of memberRows) {
      const groupId = Number(member.groupId || 0);
      membersByGroupId.set(groupId, [...(membersByGroupId.get(groupId) || []), member]);
    }
    for (const members of membersByGroupId.values()) {
      members.sort((left, right) => Number(left.priority) - Number(right.priority));
    }

    const entryHostIdsByGroupId = new Map<number, number[]>();
    for (const group of chainGroups) {
      const groupId = Number(group.id || 0);
      const enabledHostMembers = (membersByGroupId.get(groupId) || []).filter((member) => (
        runtimeBool(member?.isEnabled, true)
        && String(member?.memberType || "") === "host"
        && Number(member?.hostId || 0) > 0
      ));
      const entryGroup = groupById.get(Number(group.entryGroupId || 0));
      const externalEntryMembers = entryGroup
        && runtimeBool(entryGroup.isEnabled)
        && String(entryGroup.groupMode || "") === "entry"
        ? (membersByGroupId.get(Number(entryGroup.id)) || []).filter((member) => (
          runtimeBool(member?.isEnabled, true)
          && String(member?.memberType || "") === "host"
          && Number(member?.hostId || 0) > 0
        ))
        : [];
      entryHostIdsByGroupId.set(groupId, positiveIds((externalEntryMembers.length > 0
        ? externalEntryMembers
        : enabledHostMembers.slice(0, 1)).map((member) => member.hostId)));
    }
    const entryHostIds = positiveIds(Array.from(entryHostIdsByGroupId.values()).flat());
    const entryHosts = await selectInBatches<any>(entryHostIds, (batch) => database
      .select({ id: hosts.id, agentVersion: hosts.agentVersion })
      .from(hosts)
      .where(inArray(hosts.id, batch)));
    const entryHostById = new Map(entryHosts.map((entryHost) => [Number(entryHost.id), entryHost]));

    const updates = new Map<number, boolean>();
    const runningIds: number[] = [];
    const stoppedIds: number[] = [];
    for (const template of templates) {
      const templateId = Number(template.id || 0);
      const groupId = Number(template.forwardGroupId || 0);
      const group = groupById.get(groupId);
      const sni = normalizeSniValue(template.sni);
      const entryPort = Number(template.sourcePort || 0);
      const exitPort = Number(template.sniSplitterPort || 0);
      if (!group || String(group.groupMode || "") !== "chain" || !sni || entryPort <= 0 || exitPort <= 0) continue;

      const enabledMembers = (membersByGroupId.get(groupId) || []).filter((member) => (
        runtimeBool(member?.isEnabled, true)
        && String(member?.memberType || "") === "host"
        && Number(member?.hostId || 0) > 0
      ));
      const exitMember = enabledMembers.at(-1) as any;
      const exitHostId = Number(exitMember?.hostId || 0);
      const exitMemberId = Number(exitMember?.id || 0);
      const templateEntryHostIds = entryHostIdsByGroupId.get(groupId) || [];
      const entriesApplied = templateEntryHostIds.length > 0
        && templateEntryHostIds.every((entryHostId) => {
          const entryHost = entryHostById.get(entryHostId) as any;
          return !!entryHost
            && isSniEntryAgentVersionSupported(entryHost.agentVersion)
            && runtimeHasDomain(entryHostId, entryPort, sni);
        });
      const exitApplied = exitHostId > 0 && runtimeHasDomain(exitHostId, exitPort, sni);
      const applied = runtimeBool(group.isEnabled) && entriesApplied && exitApplied;
      const entryHostIdSet = new Set(templateEntryHostIds);
      const endpointChildren = (childrenByTemplateId.get(templateId) || []).filter((rule) => {
        const ruleHostId = Number(rule?.hostId || 0);
        const isPublicEntry = entryHostIdSet.has(ruleHostId)
          && Number(rule?.sourcePort || 0) === entryPort;
        const isExit = ruleHostId === exitHostId
          && Number(rule?.forwardGroupMemberId || 0) === exitMemberId;
        return isPublicEntry || isExit;
      });
      for (const rule of [template, ...endpointChildren]) {
        const ruleId = Number(rule?.id || 0);
        if (ruleId <= 0) continue;
        const running = applied
          && runtimeBool(rule?.isEnabled)
          && !runtimeBool(rule?.pendingDelete);
        updates.set(ruleId, running);
        if (running) {
          if (!runtimeBool(rule?.isRunning)) runningIds.push(ruleId);
        } else if (runtimeBool(rule?.isRunning)) {
          stoppedIds.push(ruleId);
        }
      }
    }
    await Promise.all([
      runningIds.length > 0 ? db.markForwardRulesRunning(runningIds) : Promise.resolve(0),
      stoppedIds.length > 0 ? db.markForwardRulesNotRunning(stoppedIds) : Promise.resolve(0),
    ]);
    return updates;
  });
}
