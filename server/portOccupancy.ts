import { pruneMapEntries, setBoundedMapValue, updateBoundedMapValueInPlace } from "./boundedCache";

export type PortListener = { port: number; protocol: "tcp" | "udp"; address: string; process?: string; managedRuntime?: string; managedRuntimeId?: string };
export type CoveredPort = { port: number; protocol: "tcp" | "udp" };
export type PortOccupancySnapshot = {
  listeners: PortListener[];
  covered: CoveredPort[];
  collectedAt: number;
  verifiedAt: number;
};

const MAX_HOSTS = 10_000;
const MAX_LISTENERS = 256;
export const MAX_PORT_OCCUPANCY_RECEIVE_BYTES = 20 * 1024;
const FRESH_MS = 10 * 60 * 1000;
const FUTURE_SKEW_MS = 60 * 1000;
const snapshots = new Map<number, { signature: string; snapshot: PortOccupancySnapshot; failed: boolean }>();
const rejected = new Map<number, { signature: string; at: number; requestedAt: number }>();
const REJECT_COOLDOWN_MS = 5 * 60 * 1000;

export function receivePortOccupancy(hostId: number, input: {
  signature?: unknown;
  collected?: unknown;
  snapshot?: any;
  schemaVersion?: unknown;
}, now = Date.now()) {
  if (input.collected === false && Number.isSafeInteger(hostId) && hostId > 0) {
    const cached = snapshots.get(hostId);
    if (cached) updateBoundedMapValueInPlace(snapshots, hostId, { ...cached, failed: true }, MAX_HOSTS);
    return { requestPortOccupancy: false, verified: false };
  }
  const signature = String(input.signature || "");
  if (!Number.isSafeInteger(hostId) || hostId <= 0) {
    return { requestPortOccupancy: false, verified: false };
  }
  const cached = snapshots.get(hostId);
  const markUnverified = () => {
    if (cached) updateBoundedMapValueInPlace(snapshots, hostId, { ...cached, failed: true }, MAX_HOSTS);
  };
  if (input.schemaVersion !== 2) {
    markUnverified();
    rejected.delete(hostId);
    return { requestPortOccupancy: false, verified: false };
  }
  if (!/^[a-f0-9]{1,128}$/i.test(signature)) {
    markUnverified();
    return { requestPortOccupancy: false, verified: false };
  }
  if (input.collected !== true) {
    markUnverified();
    return { requestPortOccupancy: false, verified: false };
  }
  if (input.snapshot != null) {
    const raw = input.snapshot;
    const reject = () => {
      markUnverified();
      setBoundedMapValue(rejected, hostId, { signature, at: now, requestedAt: 0 }, MAX_HOSTS);
      return { requestPortOccupancy: false, verified: false };
    };
    if (!raw || !Array.isArray(raw.listeners) ||
        !Array.isArray(raw.covered) || raw.covered.length > 1024 ||
        Buffer.byteLength(JSON.stringify(raw)) > MAX_PORT_OCCUPANCY_RECEIVE_BYTES ||
        "complete" in raw || "coveredThrough" in raw) {
      return reject();
    }
    const collectedAt = Number(raw.collectedAt);
    if (!Number.isFinite(collectedAt) || collectedAt <= 0 || collectedAt > now + FUTURE_SKEW_MS) {
      return reject();
    }
    const covered: CoveredPort[] = [];
    const coveredKeys = new Set<string>();
    for (const item of raw.covered) {
      if (!Number.isInteger(item?.port) || item.port < 1 || item.port > 65535 ||
          (item?.protocol !== "tcp" && item?.protocol !== "udp")) return reject();
      const key = `${item.port}:${item.protocol}`;
      if (coveredKeys.has(key)) return reject();
      coveredKeys.add(key);
      covered.push({ port: item.port, protocol: item.protocol });
    }
    const listeners: PortListener[] = [];
    const listenerCountsByPort = new Map<number, number>();
    for (const item of raw.listeners) {
      const port = Number(item?.port);
      const address = String(item?.address || "").trim();
      if (!Number.isInteger(port) || port < 1 || port > 65535 ||
          (item?.protocol !== "tcp" && item?.protocol !== "udp") || !address || address.length > 128 ||
          String(item?.process || "").length > 128 ||
          (item?.managedRuntimeId && (item.managedRuntime !== "forwardx-fxp" ||
            typeof item.managedRuntimeId !== "string" || !/^[a-z0-9:-]{1,128}$/.test(item.managedRuntimeId))) ||
          (item?.managedRuntime && !["forwardx-runtime", "forwardx-tunnel-runtime", "forwardx-nginx", "forwardx-fxp", "forwardx-realm", "forwardx-socat"].includes(item.managedRuntime))) {
        return reject();
      }
      if (!coveredKeys.has(`${port}:${item.protocol}`)) return reject();
      const listenerCount = (listenerCountsByPort.get(port) || 0) + 1;
      if (listenerCount > MAX_LISTENERS) return reject();
      listenerCountsByPort.set(port, listenerCount);
      listeners.push({ port, protocol: item.protocol, address,
        ...(item.process ? { process: String(item.process) } : {}),
        ...(item.managedRuntime ? { managedRuntime: item.managedRuntime } : {}),
        ...(item.managedRuntimeId ? { managedRuntimeId: item.managedRuntimeId } : {}),
      });
    }
    updateBoundedMapValueInPlace(snapshots, hostId, {
      signature,
      snapshot: { listeners, covered, collectedAt, verifiedAt: now },
      failed: false,
    }, MAX_HOSTS);
    rejected.delete(hostId);
    return { requestPortOccupancy: false, verified: true };
  }
  const rejectedEntry = rejected.get(hostId);
  if (rejectedEntry) {
    markUnverified();
    if (now - rejectedEntry.at >= REJECT_COOLDOWN_MS && rejectedEntry.requestedAt === 0) {
      rejected.set(hostId, { ...rejectedEntry, requestedAt: now });
      return { requestPortOccupancy: true, verified: false };
    }
    return { requestPortOccupancy: false, verified: false };
  }
  if (!cached || cached.signature !== signature) {
    markUnverified();
    return { requestPortOccupancy: true, verified: false };
  }
  updateBoundedMapValueInPlace(snapshots, hostId, {
    ...cached, failed: false, snapshot: { ...cached.snapshot, verifiedAt: now },
  }, MAX_HOSTS);
  return { requestPortOccupancy: false, verified: true };
}

export function getPortOccupancy(hostId: number, now = Date.now()): PortOccupancySnapshot | null {
  const entry = snapshots.get(hostId);
  if (!entry || entry.failed || now - entry.snapshot.verifiedAt > FRESH_MS ||
      entry.snapshot.verifiedAt > now + FUTURE_SKEW_MS ||
      entry.snapshot.collectedAt > now + FUTURE_SKEW_MS) return null;
  return entry.snapshot;
}

export function prunePortOccupancy(now = Date.now()) {
  pruneMapEntries(snapshots, ({ snapshot }) => now - snapshot.verifiedAt > 24 * 60 * 60 * 1000);
  pruneMapEntries(rejected, ({ at }) => now - at > 24 * 60 * 60 * 1000);
}

export function inspectPortOccupancy(
  snapshot: PortOccupancySnapshot | null,
  port: number,
  protocol: "tcp" | "udp" | "both",
  reusable: (listener: PortListener) => boolean = () => false,
) {
  if (!snapshot || !(protocol === "both" ? ["tcp", "udp"] : [protocol])
    .every((needed) => snapshot.covered.some((item) => item.port === port && item.protocol === needed))) {
    return { status: "unverified" as const, adminMessage: "主机端口信息未经核实", userMessage: "主机端口信息未经核实" };
  }
  const matching = snapshot.listeners.filter((listener) => listener.port === port &&
    (protocol === "both" || listener.protocol === protocol) && !reusable(listener));
  if (matching.length) {
    const details = matching.map((listener) => `${listener.protocol.toUpperCase()} ${listener.address}:${port}${listener.process ? ` (${listener.process})` : ""}`).join("、");
    const generic = matching.map((listener) => `${listener.protocol.toUpperCase()} ${listener.address}:${port}`).join("、");
    return { status: "occupied" as const, listeners: matching, collectedAt: snapshot.collectedAt, verifiedAt: snapshot.verifiedAt,
      adminMessage: `该端口存在监听：${details}`, userMessage: `该端口存在占用：${generic}` };
  }
  return { status: "free" as const, collectedAt: snapshot.collectedAt, verifiedAt: snapshot.verifiedAt };
}
