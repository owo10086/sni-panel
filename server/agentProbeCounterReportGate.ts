import type { ProbeCounterSnapshot } from "./repositories/probeCounterRepository";
import { pruneMapEntries, setBoundedMapValue } from "./boundedCache";

type State = { count: number; seenAt: number };

/** Independent from sampled health: persist every received advancement.
 * Suppressing a healthy snapshot would permanently lose its tail if the
 * Agent restarts before the next report. This cache only skips retries;
 * the persisted head still enforces ordering after eviction or reconnect. */
export class AgentProbeCounterReportGate {
  private readonly states = new Map<string, State>();
  private lastPruneAt = 0;
  constructor(private readonly capacity = 32768, private readonly ttlMs = 30 * 60_000) {}

  plan(rows: ProbeCounterSnapshot[], _force = false, now = Date.now()) {
    if (now - this.lastPruneAt >= 60_000) {
      pruneMapEntries(this.states, (state) => now - state.seenAt > this.ttlMs);
      this.lastPruneAt = now;
    }
    const updates = new Map<string, State>();
    const selected = rows.filter((row) => {
      const key = `${row.hostId}:${row.kind}:${row.refId}:${row.probeKey}:${row.epoch}`;
      const previous = this.states.get(key);
      if (previous) previous.seenAt = now;
      if (previous && row.totalCount <= previous.count) return false;
      updates.set(key, { count: row.totalCount, seenAt: now });
      return true;
    });
    return { rows: selected, commit: () => {
      for (const [key, state] of updates) {
        const previous = this.states.get(key);
        if (!previous || state.count > previous.count) setBoundedMapValue(this.states, key, state, this.capacity);
      }
    } };
  }
}

export const agentProbeCounterReportGate = new AgentProbeCounterReportGate();
