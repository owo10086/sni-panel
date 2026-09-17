export const SNI_SPLITTER_MIN_AGENT_VERSION = "2.2.195";

export function isSniEntryAgentVersionSupported(value: unknown) {
  const version = String(value || "").trim().replace(/^v/i, "");
  if (!/^\d+\.\d+\.\d+$/.test(version)) return false;
  const parts = version.split(".").map(Number);
  if (!parts.every(Number.isSafeInteger)) return false;
  const minimumParts = SNI_SPLITTER_MIN_AGENT_VERSION.split(".").map(Number);
  for (let index = 0; index < parts.length; index++) {
    if (parts[index] !== minimumParts[index]) return parts[index] > minimumParts[index];
  }
  return true;
}

export function normalizeSniValue(value: unknown) {
  return String(value || "").trim().toLowerCase().replace(/\.+$/, "");
}

export function getSniRuleGroupKey(rule: {
  sni?: unknown;
  tunnelId?: unknown;
  forwardGroupId?: unknown;
  sourcePort?: unknown;
}) {
  const forwardGroupId = Number(rule.forwardGroupId || 0);
  const tunnelId = Number(rule.tunnelId || 0);
  const sourcePort = Number(rule.sourcePort || 0);
  if (!normalizeSniValue(rule.sni) || sourcePort <= 0) return null;
  if (forwardGroupId > 0) return `sni:${forwardGroupId}:${sourcePort}`;
  if (tunnelId > 0) return `sni:tunnel:${tunnelId}:${sourcePort}`;
  return null;
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
