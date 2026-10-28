import type { BatchOperationResult } from "./batchOperations";
import { RuleTaskOutcomeUnknownError } from "../../../shared/ruleTaskOutcome";

type ImportResult<R> = { status: "fulfilled"; value: R } | { status: "rejected"; reason: string; retryable?: boolean };
type ImportOptions = { fixedPortFirst?: boolean; retryPortConflicts?: boolean };

// Submit the original order once. The server owns allocation, retry and the
// shared save boundary; the page keeps source lines and failed retry content.
export async function runRuleImport<T, R>(
  items: readonly T[],
  operations: {
    createBatch: (items: T[], options: ImportOptions) => Promise<{ results: ImportResult<R>[] }>;
  },
  options: ImportOptions = {},
): Promise<Array<BatchOperationResult<T, R> & { retryable?: boolean }>> {
  if (!items.length) return [];
  try {
    const batch = await operations.createBatch([...items], options);
    return items.map((item, index) => ({ ...batch.results[index], item }));
  } catch (reason) {
    if (reason instanceof RuleTaskOutcomeUnknownError) throw reason;
    return items.map(item => ({ item, status: "rejected", reason }));
  }
}
