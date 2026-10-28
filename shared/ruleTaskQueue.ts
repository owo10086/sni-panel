import { z } from "zod";

export const ruleTaskActionSchema = z.object({
  operation: z.enum(["create", "createBatch", "update", "toggle", "restart", "delete"]),
  input: z.record(z.unknown()),
  conflictStrategy: z.enum(["error", "auto", "skip"]).default("error"),
  label: z.string().trim().max(160).optional(),
}).refine(action => action.operation !== "createBatch" || (
  Array.isArray(action.input.rules) && action.input.rules.length > 0 && action.input.rules.length <= 500
), { message: "一个集中导入请求必须包含 1–500 条规则" });
export const enqueueRuleTaskSchema = z.object({
  requestId: z.string().min(8).max(80),
  title: z.string().trim().min(1).max(80),
  actions: z.array(ruleTaskActionSchema).min(1).max(5000),
});
export type RuleTaskAction = z.infer<typeof ruleTaskActionSchema>;
export type RuleTaskResult = {
  index: number;
  label?: string;
  status: "succeeded" | "failed" | "skipped" | "cancelled" | "unknown";
  error?: string;
  value?: { id?: number; sourcePort?: number; skipped?: boolean };
};
export type RuleTaskSnapshot = {
  id: string;
  requestId: string;
  title: string;
  state: "queued" | "running" | "completed" | "cancelled";
  total: number;
  completed: number;
  succeeded: number;
  failed: number;
  skipped: number;
  cancelled: number;
  unknown?: number;
  activeOperation?: RuleTaskAction["operation"];
  queuePosition: number;
  createdAt: number;
  finishedAt?: number;
  results?: RuleTaskResult[];
};

/** Logical rows remain distinct from queue save units. */
export function ruleTaskActionSize(action: RuleTaskAction): number {
  if (action.operation !== "createBatch") return 1;
  if (!Array.isArray(action.input.rules) || !action.input.rules.length || action.input.rules.length > 500) {
    throw Error("一个集中导入请求必须包含 1–500 条规则");
  }
  return action.input.rules.length;
}

export function isRuleTaskPortConflict(reason: unknown) {
  const message = reason instanceof Error ? reason.message : String(reason || "");
  return /(?:端口.*(?:占用|冲突|正在被.*分配)|(?:源|入口|监听|套餐)端口.*(?:必须|仅限|不在|超出).*?(?:范围|区间|允许|内)|(?:source|entry|listener|plan) port.*?(?:range|allowed)|(?:port|entry agent port).*?(?:already (?:used|in use)|being allocated)|EADDRINUSE)/i.test(message);
}
