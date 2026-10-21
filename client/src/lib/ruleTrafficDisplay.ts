/** Preserve the existing rule-counter scale while using the panel's MB/GB names. */
export function formatRuleTraffic(value: number) {
  let bytes = Math.max(0,Number(value) || 0);
  const units = ["B","KB","MB","GB","TB","PB"];
  let index = 0;
  while (bytes >= 1024 && index < units.length - 1) { bytes /= 1024; index++; }
  return `${bytes.toFixed(index ? 2 : 0)} ${units[index]}`;
}
