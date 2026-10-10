import { createHash } from "node:crypto";
import { hasAgentProbeCounter, normalizeAgentProbeCounts, type AgentProbeCounter } from "../../shared/agentDtos";
import type { ProbeStatistics } from "../../shared/probeStatistics";
import { executeRaw, getDatabaseKind, queryRaw, withDatabaseTransaction } from "../dbRuntime";
import { limitOffset, quoteIdentifier as q } from "../dbCompat";

export type ProbeCounterKind = "rule" | "tunnel" | "forwardGroup";
export type ProbeCounterSnapshot = {
  kind: ProbeCounterKind;
  refId: number;
  hostId: number;
  probeKey: string;
  epoch: string;
  epochStartedAt: number;
  totalCount: number;
  totalSuccesses: number;
  batchCount: number;
  batchSuccesses: number;
  latencyMs: number | null;
};

/** Call only after host, entity, target and topology authorization. Never
 * call for an aggregate assembled from cached hops or tunnel health. */
export function probeCounterSnapshot(kind: ProbeCounterKind, refId: number, hostId: number,
  report: AgentProbeCounter & { probeCount?: number; probeSuccesses?: number; isTimeout?: boolean } & Record<string, any>): ProbeCounterSnapshot | null {
  if (!hasAgentProbeCounter(report) || !report.probeCounterStartedAt || report.method === "self") return null;
  const counts = normalizeAgentProbeCounts(report, { legacyZeroAsSuccess: false });
  if (Number(report.probeTotalCount) < counts.probeCount || Number(report.probeTotalSuccesses) < counts.probeSuccesses
    || Number(report.probeTotalCount) - Number(report.probeTotalSuccesses) < counts.probeCount - counts.probeSuccesses) return null;
  // Include the validated identity, not only the Agent-supplied probeKey.
  const identity = [kind, refId, hostId, report.topologyKey || "", report.probeKey || "",
    String(report.targetIp || "").toLowerCase(), report.targetPort || 0, report.sourcePort || 0,
    report.method || "", report.hopIndex ?? -1, report.hopCount || 0, report.seriesKey || "", report.memberId || 0, report.probeType || ""];
  return { kind, refId, hostId, probeKey: createHash("sha256").update(JSON.stringify(identity)).digest("hex"),
    epoch: report.probeCounterEpoch!, totalCount: report.probeTotalCount!, totalSuccesses: report.probeTotalSuccesses!,
    epochStartedAt: report.probeCounterStartedAt,
    batchCount: counts.probeCount, batchSuccesses: counts.probeSuccesses,
    latencyMs: counts.probeSuccesses > 0 && Number.isFinite(report.latencyMs) && Number(report.latencyMs) > 0
      ? Math.round(Number(report.latencyMs)) : null };
}

export function probeCounterInsertSql(rowCount: number, kind = getDatabaseKind()) {
  const columns = ["kind", "refId", "hostId", "probeKey", "epoch", "totalCount", "totalSuccesses", "batchCount", "batchSuccesses", "recordedAt",
    "epochStartedAt", "countDelta", "successDelta", "latencyMs"];
  const unique = ["hostId", "kind", "refId", "probeKey", "epoch", "totalCount"];
  return `INSERT INTO ${q("probe_counter_snapshots")} (${columns.map(q).join(", ")}) VALUES ${Array.from({ length: rowCount }, () => `(${columns.map(() => "?").join(", ")})`).join(", ")}`
    + (kind === "mysql" ? ` ON DUPLICATE KEY UPDATE ${q("totalCount")} = ${q("totalCount")}`
      : ` ON CONFLICT (${unique.map(q).join(", ")}) DO NOTHING`);
}

export async function insertProbeCounterSnapshots(rows: ProbeCounterSnapshot[], recordedAt = new Date()) {
  // Lock the persisted stream head before advancing it. This also protects
  // concurrent deliveries and survives a panel restart or health-gate eviction.
  // A first observation counts only its batch, not an unobserved lifetime.
  const at = Math.floor(recordedAt.getTime() / 1000);
  const ordered = [...rows].sort((a, b) => `${a.hostId}:${a.kind}:${a.refId}:${a.probeKey}`.localeCompare(`${b.hostId}:${b.kind}:${b.refId}:${b.probeKey}`)
    || a.epochStartedAt - b.epochStartedAt || a.totalCount - b.totalCount);
  for (let offset = 0; offset < ordered.length; offset += 60) {
    await withDatabaseTransaction(async () => {
      const values: unknown[] = [];
      for (const row of ordered.slice(offset, offset + 60)) {
        const identity = [row.hostId, row.kind, row.refId, row.probeKey];
        const where = ["hostId", "kind", "refId", "probeKey"].map(column => `${q(column)} = ?`).join(" AND ");
        const conflict = getDatabaseKind() === "mysql" ? ` ON DUPLICATE KEY UPDATE ${q("probeKey")} = ${q("probeKey")}`
          : ` ON CONFLICT (${["hostId", "kind", "refId", "probeKey"].map(q).join(", ")}) DO NOTHING`;
        await executeRaw(`INSERT INTO ${q("probe_counter_heads")} (${["hostId", "kind", "refId", "probeKey", "epoch", "epochStartedAt", "totalCount", "totalSuccesses", "recordedAt"].map(q).join(", ")})
          VALUES (?, ?, ?, ?, '', 0, 0, 0, ?)${conflict}`, [...identity, at]);
        const [head] = await queryRaw<{ epoch: string; epochStartedAt: number; totalCount: number; totalSuccesses: number }>(
          `SELECT * FROM ${q("probe_counter_heads")} WHERE ${where}${getDatabaseKind() === "sqlite" ? "" : " FOR UPDATE"}`, identity);
        const sameEpoch = head.epoch === row.epoch;
        if (row.epochStartedAt < Number(head.epochStartedAt)
          || (!sameEpoch && row.epochStartedAt === Number(head.epochStartedAt))
          || (sameEpoch && (row.epochStartedAt !== Number(head.epochStartedAt) || row.totalCount <= Number(head.totalCount)))) continue;
        const countDelta = sameEpoch ? row.totalCount - Number(head.totalCount) : row.batchCount;
        const successDelta = sameEpoch ? row.totalSuccesses - Number(head.totalSuccesses) : row.batchSuccesses;
        if (successDelta < 0 || successDelta > countDelta) continue;
        await executeRaw(`UPDATE ${q("probe_counter_heads")} SET ${["epoch", "epochStartedAt", "totalCount", "totalSuccesses", "recordedAt"].map(column => `${q(column)} = ?`).join(", ")} WHERE ${where}`,
          [row.epoch, row.epochStartedAt, row.totalCount, row.totalSuccesses, at, ...identity]);
        values.push(row.kind, row.refId, row.hostId, row.probeKey, row.epoch, row.totalCount, row.totalSuccesses,
          row.batchCount, row.batchSuccesses, at, row.epochStartedAt, countDelta, successDelta, row.latencyMs);
      }
      if (values.length) await executeRaw(probeCounterInsertSql(values.length / 14), values);
    });
  }
}

export async function getProbeCounterStatistics(kind: ProbeCounterKind, refIds: number | number[], since: Date): Promise<ProbeStatistics> {
  const ids = [...new Set((Array.isArray(refIds) ? refIds : [refIds]).filter((id) => Number.isInteger(id) && id > 0))];
  const empty: ProbeStatistics = { total: 0, successes: 0, available: false, observedSince: null, latestAt: null };
  if (!ids.length) return empty;
  const start = Math.floor(since.getTime() / 1000);
  const predicate = `${q("kind")} = ? AND ${q("refId")} IN (${ids.map(() => "?").join(", ")}) AND ${q("recordedAt")} >= ? AND ${q("countDelta")} IS NOT NULL`;
  const params = [kind, ...ids, start];
  const [row] = await queryRaw<any>(`SELECT SUM(${q("countDelta")}) AS ${q("total")}, SUM(${q("successDelta")}) AS ${q("successes")},
    MIN(${q("recordedAt")}) AS ${q("firstAt")}, MAX(${q("recordedAt")}) AS ${q("lastAt")}
    FROM ${q("probe_counter_snapshots")} WHERE ${predicate}`, params);
  if (row?.total !== null && row?.total !== undefined) {
    empty.total = Number(row.total);
    empty.successes = Number(row.successes);
    empty.available = true;
    empty.observedSince = new Date(Number(row.firstAt) * 1000);
    empty.latestAt = new Date(Number(row.lastAt) * 1000);
  }
  // This bound applies to latency batches only. Exact attempt totals above
  // span every retained snapshot, independently of chart/query downsampling.
  const limit = 2880;
  const page = limitOffset(limit + 1);
  const samples = await queryRaw<{ latencyMs: number; batchCount: number; batchSuccesses: number }>(
    `SELECT ${q("latencyMs")}, ${q("batchCount")}, ${q("batchSuccesses")} FROM ${q("probe_counter_snapshots")}
    WHERE ${predicate} AND ${q("latencyMs")} > 0 AND ${q("batchSuccesses")} > 0
    ORDER BY ${q("recordedAt")} DESC, ${q("id")} DESC ${page.sql}`, [...params, ...page.params]);
  empty.latencySamplesTruncated = samples.length > limit;
  empty.latencySamples = samples.slice(0, limit).map(sample => ({ latency: Number(sample.latencyMs),
    probeCount: Number(sample.batchCount), probeSuccesses: Number(sample.batchSuccesses) }));
  return empty;
}
