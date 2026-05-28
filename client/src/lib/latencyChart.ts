export const MAX_LATENCY_CHART_MS = 500;

export function clipLatencyForChart(latency: number) {
  if (!Number.isFinite(latency) || latency <= 0) return 0;
  return Math.min(MAX_LATENCY_CHART_MS, latency);
}

export function getLatencyYAxisMax(maxLatency: number, fallback = 120) {
  if (!Number.isFinite(maxLatency) || maxLatency <= 0) return fallback;

  const clipped = clipLatencyForChart(maxLatency);
  const padding =
    clipped < 20 ? 1.35
      : clipped < 50 ? 1.25
        : clipped < 150 ? 1.2
          : clipped < 300 ? 1.15
            : 1.1;
  const padded = Math.max(clipped + 1, clipped * padding);
  const step = getNiceLatencyStep(padded / 5);
  const rounded = Math.ceil(padded / step) * step;
  return Math.min(MAX_LATENCY_CHART_MS, Math.max(1, Math.ceil(rounded)));
}

export function getLatencyYAxisTicks(yMax: number) {
  if (!Number.isFinite(yMax) || yMax <= 0) return [0];
  const max = Math.ceil(yMax);
  const step = getNiceLatencyStep(max / 6);
  const ticks: number[] = [];
  for (let value = 0; value <= max; value += step) ticks.push(value);
  if (ticks[ticks.length - 1] !== max) ticks.push(max);
  return ticks;
}

function getNiceLatencyStep(rawStep: number) {
  if (!Number.isFinite(rawStep) || rawStep <= 1) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / magnitude;
  const candidates = magnitude >= 10 ? [1, 2, 2.5, 5, 10] : [1, 2, 5, 10];
  const selected = candidates.find((step) => normalized <= step) ?? 10;
  return selected * magnitude;
}
