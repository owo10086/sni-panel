export type TemplateHostCandidate = {
  ruleId: number;
  groupId: number;
  storedHostId: number;
  groupMode: "port" | "failover" | "chain";
  externalEntry: boolean;
  memberId: number;
  hostId: number;
  priority: number;
  enabled: boolean;
};

export type TemplateHostRepair = {
  ruleId: number;
  groupId: number;
  fromHostId: number;
  toHostId: number;
};

export function planTemplateHostRepairs(
  rows: TemplateHostCandidate[],
): TemplateHostRepair[] {
  const byRule = new Map<number, TemplateHostCandidate[]>();
  for (const row of rows) {
    if (![row.ruleId, row.groupId, row.memberId, row.hostId]
      .every(value => Number.isInteger(value) && value > 0)) continue;
    const current = byRule.get(row.ruleId) || [];
    current.push(row);
    byRule.set(row.ruleId, current);
  }
  const repairs: TemplateHostRepair[] = [];
  for (const [ruleId, candidates] of [...byRule].sort(([a], [b]) => a - b)) {
    candidates.sort((a, b) =>
      Number(b.enabled) - Number(a.enabled)
      || a.priority - b.priority || a.memberId - b.memberId);
    const first = candidates[0];
    const eligible = first.groupMode === "chain" && !first.externalEntry
      ? candidates.slice(0, 1) : candidates;
    if (eligible.some(candidate => candidate.hostId === first.storedHostId)) continue;
    repairs.push({
      ruleId, groupId: first.groupId,
      fromHostId: first.storedHostId, toHostId: eligible[0].hostId,
    });
  }
  return repairs;
}
