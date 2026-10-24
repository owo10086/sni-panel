// What a stored self-test row can honestly claim.
//
// A self-test runs on one host and connects (TCP) or pings (UDP rules) a
// target. That proves the probe source reaches the target and nothing more. No
// self-test sends a request through the entry's business port from outside the
// entry, so the external forwarding path is always "unverified" - which is
// neither a success nor a failure of that path. Rows written before this
// contract stored listenOk/forwardOk as true for every successful probe; they
// are read by their evidence, never by those flags.

export type SelfTestTargetEvidence = "reachable" | "unreachable" | "pending" | "unknown";

export interface SelfTestEvidence {
  /** What the probe connected to: the rule's target, or the entry's own listening port. */
  probe: "target" | "entry-listener";
  /** Whether the probe source reached what it connected to. */
  target: SelfTestTargetEvidence;
  /** Whether a request from outside went through the entry's business port. */
  externalPath: "unverified";
}

interface SelfTestRowLike {
  status?: unknown;
  targetReachable?: unknown;
  listenOk?: unknown;
  forwardOk?: unknown;
  requestMessage?: unknown;
  message?: unknown;
}

const truthy = (value: unknown) => value === true || value === 1 || value === "1" || value === "true";

function selfTestKind(row: SelfTestRowLike): string {
  for (const raw of [row.requestMessage, row.message]) {
    if (typeof raw !== "string" || !raw.trim().startsWith("{")) continue;
    try {
      const kind = JSON.parse(raw)?.kind;
      if (typeof kind === "string") return kind;
    } catch { /* free text */ }
  }
  return "";
}

export function selfTestEvidence(row: SelfTestRowLike): SelfTestEvidence {
  const status = String(row.status || "");
  let target: SelfTestTargetEvidence;
  if (status === "pending" || status === "running") target = "pending";
  else if (truthy(row.targetReachable)) target = "reachable";
  else if (status === "failed") target = "unreachable";
  else target = "unknown";
  return { probe: selfTestKind(row) === "forward-via-tunnel-entry" ? "entry-listener" : "target", target, externalPath: "unverified" };
}

/**
 * The row as readers should see it: the target result and latency are kept, the
 * listener flag survives only where a test really connected to the entry's
 * listener, and the forwarding flag is never set by evidence that does not
 * exist.
 */
export type WithSelfTestEvidence<T> = T & { listenOk: boolean; forwardOk: false; evidence: SelfTestEvidence };
export function withSelfTestEvidence<T extends SelfTestRowLike>(row: T): WithSelfTestEvidence<T>;
export function withSelfTestEvidence(row: null | undefined): null | undefined;
export function withSelfTestEvidence(row: SelfTestRowLike | null | undefined) {
  if (!row) return row;
  return {
    ...row,
    listenOk: selfTestKind(row) === "forward-via-tunnel-entry" && truthy(row.listenOk),
    forwardOk: false,
    evidence: selfTestEvidence(row),
  };
}
