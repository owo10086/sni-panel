/** Retain definitive per-row validation errors when the shared save rolls back.
 * Prepared IDs are deliberately omitted: they were never committed. */
export class RuleBatchSaveError extends Error {
  constructor(readonly itemErrors: Array<string | undefined>, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
  }
}

export function findRuleBatchSaveError(error: unknown): RuleBatchSaveError | null {
  const seen = new Set<unknown>();
  for (let current = error; current && !seen.has(current); current = (current as Error).cause) {
    if (current instanceof RuleBatchSaveError) return current;
    seen.add(current);
  }
  return null;
}

export function isRuleWriteOutcomeUnknown(error: unknown): boolean {
  const seen = new Set<unknown>();
  for (let current = error; current && !seen.has(current); current = (current as Error).cause) {
    seen.add(current);
    const code = String((current as { code?: unknown }).code || "");
    const message = current instanceof Error ? current.message : String(current);
    if (/^(?:FORWARDX_WRITE_OUTCOME_UNKNOWN|ECONNRESET|ETIMEDOUT|ECONNABORTED|EPIPE|PROTOCOL_CONNECTION_LOST|57P0[123]|08\w{3})$/.test(code)
      || /(?:connection.*(?:lost|closed|terminated|reset)|(?:commit|query|socket).*tim(?:e|ed) ?out|write outcome unknown)/i.test(message)) return true;
  }
  return false;
}
