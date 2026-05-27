export function getLatencyYAxisMax(maxLatency: number, fallback = 120) {
  if (!Number.isFinite(maxLatency) || maxLatency <= 0) return fallback;

  const multiplier =
    maxLatency < 50 ? 2
      : maxLatency < 100 ? 1.8
        : maxLatency < 150 ? 1.6
          : maxLatency < 250 ? 1.4
            : maxLatency < 350 ? 1.25
              : 1.15;
  const rounded = Math.ceil((maxLatency * multiplier) / 10) * 10;
  return Math.min(500, Math.max(fallback, rounded));
}

export function getLatencyYAxisTicks(yMax: number) {
  const step = yMax <= 120 ? 20 : yMax <= 200 ? 40 : yMax <= 300 ? 50 : 100;
  const ticks: number[] = [];
  for (let value = 0; value <= yMax; value += step) ticks.push(value);
  if (ticks[ticks.length - 1] !== yMax) ticks.push(yMax);
  return ticks;
}
