import { parsePageSize } from "./pageSize";

export function parseRulePageSize(value: unknown) {
  const size = Number(value);
  const migrated = size === 12 ? 20 : [24, 36, 48].includes(size) ? 50 : value;
  return parsePageSize(migrated, 20);
}

// Run before the shared pagination hook reads the existing storage key.
export function migrateStoredRulePageSize() {
  try {
    const key = "forwardx.rules.pageSize";
    const raw = window.localStorage.getItem(key);
    const size = parseRulePageSize(raw);
    if (raw !== null && raw !== String(size)) window.localStorage.setItem(key, String(size));
  } catch {
    // The shared hook falls back to 20 if storage is unavailable.
  }
}
