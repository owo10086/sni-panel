export type ProbeStatistics = {
  total: number;
  successes: number;
  /** No cumulative telemetry means old, state-change-biased history. */
  available: boolean;
  observedSince: Date | null;
  latestAt: Date | null;
  /** Real reported batches only; historical health caches never enter this set. */
  latencySamples?: Array<{ latency: number; probeCount: number; probeSuccesses: number }>;
  latencySamplesTruncated?: boolean;
};
