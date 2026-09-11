import { normalizeSniValue } from "@shared/sni";

export { epochSeconds, sqlBool } from "../dbCompat";
export { normalizeSniValue };

export function clampPositiveInt(value: unknown, fallback: number, max: number) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, max);
}

export function normalizePositiveIds(values: unknown[] | undefined) {
  return Array.from(new Set((values || [])
    .map((value) => Math.floor(Number(value)))
    .filter((value) => Number.isInteger(value) && value > 0)));
}

function truthyDatabaseFlag(value: unknown) {
  return value === undefined
    || value === null
    || value === true
    || value === 1
    || value === "1"
    || String(value).trim().toLowerCase() === "true";
}

export function isSniSplitterChainExitRule(
  rule: { sni?: unknown; sniSplitterPort?: unknown; forwardGroupMemberId?: unknown; hostId?: unknown },
  group: { groupMode?: unknown; members?: Array<{ id?: unknown; hostId?: unknown; priority?: unknown; isEnabled?: unknown }> } | null | undefined,
) {
  if (!group || String(group.groupMode || "failover") !== "chain") return false;
  if (!normalizeSniValue(rule.sni) || Number(rule.sniSplitterPort || 0) <= 0) return false;
  const members = [...(group.members || [])]
    .filter((member) => truthyDatabaseFlag(member.isEnabled))
    .sort((a, b) => Number(a.priority) - Number(b.priority) || Number(a.id || 0) - Number(b.id || 0));
  const lastMember = members[members.length - 1];
  return Number(lastMember?.id || 0) === Number(rule.forwardGroupMemberId || 0)
    && Number(lastMember?.hostId || 0) === Number(rule.hostId || 0);
}

export function addMonthsClamped(date: Date, months: number): Date {
  const next = new Date(date.getTime());
  const day = next.getDate();
  next.setDate(1);
  next.setMonth(next.getMonth() + months);
  const lastDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
  next.setDate(Math.min(day, lastDay));
  return next;
}

export function nextMonthlyTrafficReset(start: Date, expiresAt: Date | null): Date | null {
  if (!expiresAt) return addMonthsClamped(start, 1);
  const next = addMonthsClamped(start, 1);
  return next.getTime() < expiresAt.getTime() ? next : null;
}
