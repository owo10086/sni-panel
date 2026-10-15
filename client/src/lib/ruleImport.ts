import { normalizeSniValue } from "@shared/sni";
import { runBatchOperations, type BatchOperationResult } from "./batchOperations";

type ImportResult<R> = { status: "fulfilled"; value: R } | { status: "rejected"; reason: string };

// The page owns parsing and retry content. This boundary submits all SNI items
// together and keeps ordinary-rule results aligned with their original input.
export async function runRuleImport<T extends { sni?: unknown }, R>(
  items: readonly T[],
  operations: {
    createOne: (item: T) => Promise<R>;
    createSniBatch: (items: T[]) => Promise<{ results: ImportResult<R>[] }>;
  },
): Promise<Array<BatchOperationResult<T, R>>> {
  const indexed = items.map((item, index) => ({ item, index }));
  const sniItems = indexed.filter(({ item }) => !!normalizeSniValue(item.sni));
  const ordinaryItems = indexed.filter(({ item }) => !normalizeSniValue(item.sni));
  const results = new Array<BatchOperationResult<T, R>>(items.length);
  const saveSni = async () => {
    if (!sniItems.length) return;
    try {
      const batch = await operations.createSniBatch(sniItems.map(({ item }) => item));
      for (const [position, { item, index }] of sniItems.entries()) {
        results[index] = { ...batch.results[position], item };
      }
    } catch (reason) {
      for (const { item, index } of sniItems) results[index] = { item, status: "rejected", reason };
    }
  };
  const saveOrdinary = async () => {
    const outcomes = await runBatchOperations(ordinaryItems, 6, ({ item }) => operations.createOne(item));
    for (const outcome of outcomes) results[outcome.item.index] = { ...outcome, item: outcome.item.item };
  };
  await Promise.all([saveSni(), saveOrdinary()]);
  return results;
}
