export function normalizeSniValue(value: unknown) {
  return String(value || "").trim().toLowerCase().replace(/\.+$/, "");
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
