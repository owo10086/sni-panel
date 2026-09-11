export function normalizeSniValue(value: unknown) {
  return String(value || "").trim().toLowerCase().replace(/\.+$/, "");
}

export function getSniRuleGroupKey(rule: {
  sni?: unknown;
  forwardGroupId?: unknown;
  sourcePort?: unknown;
}) {
  const forwardGroupId = Number(rule.forwardGroupId || 0);
  const sourcePort = Number(rule.sourcePort || 0);
  if (!normalizeSniValue(rule.sni) || forwardGroupId <= 0 || sourcePort <= 0) return null;
  return `sni:${forwardGroupId}:${sourcePort}`;
}

export function isValidSniValue(value: unknown) {
  const normalized = normalizeSniValue(value);
  if (!normalized || normalized.length > 253 || normalized.includes("*")) return false;
  return normalized.split(".").every((label) => (
    label.length >= 1
    && label.length <= 63
    && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
  ));
}
