import { createHash, randomBytes } from "node:crypto";
import { executeRaw, getDatabaseKind, insertAndGetId, isDatabaseTransactionActive, queryRaw, withDatabaseTransaction } from "./dbRuntime";
import { quoteIdentifier as q } from "./dbCompat";
import { withKeyedTaskLock } from "./keyedTaskLock";

const fields = ["id", "name", "prefix", "expiresAt", "createdAt", "lastUsedAt"].map(q).join(",");
export class McpTokenLimitError extends Error {
  constructor() { super("最多保留 10 个有效 MCP 令牌，请先撤销旧令牌"); this.name = "McpTokenLimitError"; }
}
export async function listMcpTokens(userId: number) {
  return queryRaw<any>(`SELECT ${fields} FROM ${q("external_mcp_tokens")} WHERE ${q("userId")} = ? ORDER BY ${q("id")} DESC`, [userId]);
}
export async function createMcpToken(userId: number, name: string, days: number) {
  return withKeyedTaskLock(`mcp-tokens:${userId}`, async () => {
    const nested = isDatabaseTransactionActive();
    for (let attempt = 0; ; attempt++) {
      try {
        return await withDatabaseTransaction(async () => {
          // A real row update also makes PostgreSQL reject a stale REPEATABLE READ
          // snapshot. A lock-only SELECT would allow two issuers to count old tokens.
          await executeRaw(`UPDATE ${q("users")} SET ${q("id")} = ${q("id")} WHERE ${q("id")} = ?`, [userId]);
          const [owner] = await queryRaw(`SELECT ${q("id")} FROM ${q("users")} WHERE ${q("id")} = ?`, [userId]);
          if (!owner) throw new Error("用户不存在");
          const now = Math.floor(Date.now() / 1000);
          await executeRaw(`DELETE FROM ${q("external_mcp_tokens")} WHERE ${q("userId")} = ? AND ${q("expiresAt")} <= ?`, [userId, now]);
          // MySQL locking reads use current committed rows even in a nested
          // repeatable-read transaction that established its snapshot earlier.
          const tokens = await queryRaw(`SELECT ${q("id")} FROM ${q("external_mcp_tokens")} WHERE ${q("userId")} = ?${getDatabaseKind() === "sqlite" ? "" : " FOR UPDATE"}`, [userId]);
          if (tokens.length >= 10) throw new McpTokenLimitError();
          const token = `fxm_${randomBytes(32).toString("hex")}`;
          const id = await insertAndGetId("external_mcp_tokens", { userId, name, prefix: token.slice(0, 12), tokenHash: hashMcpToken(token), createdAt: now, expiresAt: now + days * 86400 });
          return { id, token, expiresAt: now + days * 86400 };
        });
      } catch (error) {
        // Retry only a transaction owned here, after its rollback. Never retry
        // inside an already-failed caller transaction or swallow unrelated errors.
        if (nested || attempt >= 2 || getDatabaseKind() !== "postgresql" || (error as { code?: string })?.code !== "40001") throw error;
      }
    }
  });
}
export const hashMcpToken = (value: string) => createHash("sha256").update(value).digest("hex");
export async function revokeMcpToken(userId: number, id: number) {
  await executeRaw(`DELETE FROM ${q("external_mcp_tokens")} WHERE ${q("id")} = ? AND ${q("userId")} = ?`, [id, userId]);
}
export async function resolveMcpToken(value: string) {
  if (!/^fxm_[a-f0-9]{64}$/.test(value)) return null;
  const [row] = await queryRaw<any>(`SELECT ${q("id")}, ${q("userId")}, ${q("lastUsedAt")} FROM ${q("external_mcp_tokens")} WHERE ${q("tokenHash")} = ? AND ${q("expiresAt")} > ?`, [hashMcpToken(value), Math.floor(Date.now() / 1000)]);
  return row || null;
}
