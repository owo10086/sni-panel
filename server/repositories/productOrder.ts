import { TRPCError } from "@trpc/server";
import { executeRaw, getDatabaseKind, queryRaw, quoteDbIdentifier, withDatabaseTransaction } from "../dbRuntime";
import { withKeyedTaskLock } from "../keyedTaskLock";

/** Reorder a visible page without changing the relative order of other products. */
export async function reorderProducts(
  table: "subscription_plans" | "traffic_billing_configs",
  ids: number[],
  startIndex = 0,
) {
  if (!ids.length || new Set(ids).size !== ids.length || ids.some(id => !Number.isSafeInteger(id) || id <= 0)
    || !Number.isSafeInteger(startIndex) || startIndex < 0) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "无效的排序参数" });
  }
  return withKeyedTaskLock(`product-order:${table}`, () => withDatabaseTransaction(async () => {
    const q = quoteDbIdentifier;
    const fallback = table === "subscription_plans" ? "createdAt" : "updatedAt";
    const lock = getDatabaseKind() === "sqlite" ? "" : " FOR UPDATE";
    const rows = await queryRaw<{ id: number; sortOrder: number }>(
      `SELECT ${q("id")}, ${q("sortOrder")} FROM ${q(table)} ORDER BY ${q("sortOrder")} ASC, ${q(fallback)} DESC, ${q("id")} DESC${lock}`,
    );
    const current = new Map(rows.map(row => [Number(row.id), Number(row.sortOrder)]));
    if (ids.some(id => !current.has(id))) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "排序资源不存在，请刷新后重试" });
    }
    const selected = new Set(ids);
    const existingIds = rows.map(row => Number(row.id));
    const currentRange = existingIds.slice(startIndex, startIndex + ids.length);
    // Plans reorder one complete visible page; metered resources show the full list.
    // Reject stale/mixed ranges rather than moving unrelated products between pages.
    if (currentRange.length !== ids.length || currentRange.some(id => !selected.has(id))
      || (table === "traffic_billing_configs" && (startIndex !== 0 || ids.length !== rows.length))) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "排序列表已变化，请刷新后重试" });
    }
    const ordered = [...existingIds.slice(0, startIndex), ...ids, ...existingIds.slice(startIndex + ids.length)];
    for (const [index, id] of ordered.entries()) {
      if (current.get(id) === index) continue;
      // Sorting must not change billing settings, permissions or subscriber snapshots.
      await executeRaw(`UPDATE ${q(table)} SET ${q("sortOrder")} = ? WHERE ${q("id")} = ?`, [index, id]);
    }
    return { success: true };
  }));
}
