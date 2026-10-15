import { AsyncLocalStorage } from "node:async_hooks";
import { withResourceTaskLock } from "./keyedTaskLock";
import { isDatabaseTransactionActive } from "./dbRuntime";

const context = new AsyncLocalStorage<{ active: boolean }>();
export function assertGroupMemberMutationHeld(): void {
  if (!context.getStore()?.active) throw new Error("成员保存必须先取得修改位置");
}
export async function withGroupMemberMutation<T>(work: () => Promise<T>): Promise<T> {
  if (context.getStore()?.active) return work();
  if (isDatabaseTransactionActive()) throw new Error("成员修改位置必须在数据库保存前取得");
  return withResourceTaskLock("group-member-mutation", async () => {
    const token = { active: true };
    try { return await context.run(token, work); }
    finally { token.active = false; }
  });
}
