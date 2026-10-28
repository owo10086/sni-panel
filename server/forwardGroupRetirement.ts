import {
  executeRaw,
  insertAndGetId,
  queryRaw,
  quoteDbIdentifier as q,
  rawAffectedRows,
  withDatabaseTransaction,
} from "./dbRuntime";

export const FORWARD_GROUP_RETIREMENT_FALLBACK_MS = 5 * 60 * 1000;

export type ForwardGroupRetirementBatch = {
  id: number;
  groupId: number;
  memberId: number;
  hostId: number;
  ruleIds: number[];
  provider: string;
  domain: string;
  recordType: string;
  oldValue: string;
  /** All batch instants are Unix epoch milliseconds; TTLs are seconds. */
  startedAt: number;
  fallbackDeadlineAt: number;
  oldTtl: number;
  switchedAt: number | null;
  switchTtl: number | null;
  retireAt: number | null;
  state: "pending" | "retiring";
};
export type RetirementBatch = ForwardGroupRetirementBatch;

const table = () => q("forward_group_retirements");
const normalizedDomain = (domain: string) => domain.trim().toLowerCase().replace(/\.$/, "");
const normalizedProvider = (provider: string) => provider.trim().toLowerCase();
const normalizedRecordType = (recordType: string) => recordType.trim().toUpperCase();
const ttlSeconds = (value: unknown, fallback = 600) => {
  const ttl = Math.floor(Number(value));
  return Number.isFinite(ttl) && ttl > 0 ? Math.min(ttl, 2_147_483_647) : fallback;
};

function readBatch(row: Record<string, any>): ForwardGroupRetirementBatch {
  const ruleIds = JSON.parse(String(row.ruleIds));
  if (!Array.isArray(ruleIds) || ruleIds.some(id => !Number.isSafeInteger(id) || id <= 0)) {
    throw new Error("转发组待撤销批次的规则身份无效");
  }
  return {
    id: Number(row.id), groupId: Number(row.groupId), memberId: Number(row.memberId), hostId: Number(row.hostId),
    ruleIds, provider: row.provider, domain: row.domain, recordType: row.recordType, oldValue: row.oldValue,
    startedAt: Number(row.startedAt), fallbackDeadlineAt: Number(row.fallbackDeadlineAt), oldTtl: Number(row.oldTtl),
    switchedAt: row.switchedAt == null ? null : Number(row.switchedAt),
    switchTtl: row.switchTtl == null ? null : Number(row.switchTtl),
    retireAt: row.retireAt == null ? null : Number(row.retireAt), state: row.state,
  };
}

export async function listForwardGroupRetirements(groupId?: number): Promise<ForwardGroupRetirementBatch[]> {
  const rows = await queryRaw(`SELECT * FROM ${table()}${groupId === undefined ? "" : ` WHERE ${q("groupId")} = ?`} ORDER BY ${q("id")}`,
    groupId === undefined ? [] : [groupId]);
  return rows.map(readBatch);
}

export async function getForwardGroupRetirement(id: number): Promise<ForwardGroupRetirementBatch | undefined> {
  const [row] = await queryRaw(`SELECT * FROM ${table()} WHERE ${q("id")} = ?`, [id]);
  return row ? readBatch(row) : undefined;
}

export async function getProtectedForwardGroupRuleIds(groupId?: number): Promise<Set<number>> {
  return new Set((await listForwardGroupRetirements(groupId)).flatMap(batch => batch.ruleIds));
}

export function forwardGroupRetirementDeadline(batch: ForwardGroupRetirementBatch): number {
  return batch.retireAt ?? batch.fallbackDeadlineAt;
}

/** Mutating callers hold their existing group lock; nested transactions share
 * the saved group change or the valid DDNS publication's local commit. */
export async function createForwardGroupRetirement(input: {
  groupId: number;
  memberId: number;
  hostId: number;
  ruleIds: number[];
  provider: string;
  domain: string;
  recordType: string;
  oldValue: string;
  oldTtl?: number | null;
  fallbackTtl?: number;
  startedAt?: number;
}): Promise<ForwardGroupRetirementBatch> {
  return withDatabaseTransaction(async () => {
    const [existing] = await queryRaw(`SELECT * FROM ${table()} WHERE ${q("groupId")} = ? AND ${q("memberId")} = ? AND ${q("hostId")} = ?`,
      [input.groupId,input.memberId,input.hostId]);
    if (existing) return readBatch(existing);
    const startedAt = input.startedAt ?? Date.now();
    const ruleIds = [...new Set(input.ruleIds)].filter(id => Number.isSafeInteger(id) && id > 0);
    const id = await insertAndGetId("forward_group_retirements", {
      groupId:input.groupId, memberId:input.memberId, hostId:input.hostId, ruleIds:JSON.stringify(ruleIds),
      provider:normalizedProvider(input.provider), domain:normalizedDomain(input.domain), recordType:normalizedRecordType(input.recordType),
      oldValue:input.oldValue.trim(), startedAt, fallbackDeadlineAt:startedAt+FORWARD_GROUP_RETIREMENT_FALLBACK_MS,
      oldTtl:ttlSeconds(input.oldTtl,ttlSeconds(input.fallbackTtl)), switchedAt:null,switchTtl:null,retireAt:null,state:"pending",
    });
    return (await getForwardGroupRetirement(id))!;
  });
}

/** Called only after both publication eligibility checks succeeded, inside
 * the transaction saving that publication. Skips and stale replies never call it. */
export async function commitForwardGroupRetirementSwitch(input: {
  groupId: number;
  provider: string;
  domain: string;
  recordType: string;
  value: string;
  ttl: number;
  now?: number;
}): Promise<ForwardGroupRetirementBatch[]> {
  if (!input.value.trim()) return [];
  return withDatabaseTransaction(async () => {
    const now = input.now ?? Date.now();
    const ttl = ttlSeconds(input.ttl);
    const changed: ForwardGroupRetirementBatch[] = [];
    for (const batch of await listForwardGroupRetirements(input.groupId)) {
      if (batch.state !== "pending" || batch.switchedAt !== null || batch.startedAt > now || batch.fallbackDeadlineAt <= now
        || batch.provider !== normalizedProvider(input.provider) || batch.domain !== normalizedDomain(input.domain)
        || batch.recordType !== normalizedRecordType(input.recordType) || batch.oldValue === input.value.trim()) continue;
      const retireAt = now + Math.max(batch.oldTtl,ttl) * 1000;
      const result = await executeRaw(`UPDATE ${table()} SET ${q("switchedAt")} = ?, ${q("switchTtl")} = ?, ${q("retireAt")} = ?
        WHERE ${q("id")} = ? AND ${q("state")} = ? AND ${q("switchedAt")} IS NULL AND ${q("fallbackDeadlineAt")} > ?`,
      [now,ttl,retireAt,batch.id,"pending",now]);
      if (rawAffectedRows(result)) changed.push({...batch,switchedAt:now,switchTtl:ttl,retireAt});
    }
    return changed;
  });
}

/** Persist the point of no return before invoking rule settlement/removal.
 * Retiring rows remain visible on later attempts until cleanup succeeds. */
export async function markForwardGroupRetirementsDue(input: {
  groupId?: number;
  hostId?: number;
  now?: number;
  force?: boolean;
} = {}): Promise<ForwardGroupRetirementBatch[]> {
  return withDatabaseTransaction(async () => {
    const now = input.now ?? Date.now();
    const retiring: ForwardGroupRetirementBatch[] = [];
    for (const batch of await listForwardGroupRetirements(input.groupId)) {
      if (input.hostId !== undefined && batch.hostId !== input.hostId) continue;
      if (batch.state === "retiring") { retiring.push(batch); continue; }
      if (!input.force && forwardGroupRetirementDeadline(batch) > now) continue;
      const dueCondition = input.force ? "" : ` AND ((${q("retireAt")} IS NULL AND ${q("fallbackDeadlineAt")} <= ?) OR ${q("retireAt")} <= ?)`;
      const result = await executeRaw(`UPDATE ${table()} SET ${q("state")} = ? WHERE ${q("id")} = ? AND ${q("state")} = ?${dueCondition}`,
        ["retiring",batch.id,"pending",...input.force ? [] : [now,now]]);
      if (rawAffectedRows(result)) retiring.push({...batch,state:"retiring"});
    }
    return retiring;
  });
}

export async function finishForwardGroupRetirement(id: number): Promise<void> {
  await executeRaw(`DELETE FROM ${table()} WHERE ${q("id")} = ? AND ${q("state")} = ?`, [id,"retiring"]);
}
