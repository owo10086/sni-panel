import { pruneMapEntries, updateBoundedMapValueInPlace } from "./boundedCache";

export type PortListener = { port: number; protocol: "tcp" | "udp"; address: string; process?: string; managedRuntime?: string; managedRuntimeId?: string };
export type PortOccupancySnapshot = {
  listeners: PortListener[];
  collectedAt: number;
  complete: boolean;
  coveredThrough: number;
  verifiedAt: number;
};

const MAX_HOSTS = 10_000;
const MAX_LISTENERS = 256;
const FRESH_MS = 5 * 60 * 1000;
const FUTURE_SKEW_MS = 60 * 1000;
const snapshots = new Map<number, { signature: string; snapshot: PortOccupancySnapshot; failed: boolean }>();

export function receivePortOccupancy(hostId: number, input: {
  signature?: unknown;
  collected?: unknown;
  snapshot?: any;
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
    if (!raw || !Array.isArray(raw.listeners) || raw.listeners.length > MAX_LISTENERS ||
        Buffer.byteLength(JSON.stringify(raw)) > 33 * 1024 || typeof raw.complete !== "boolean") {
      markUnverified();
      return { requestPortOccupancy: true, verified: false };
    }
    const collectedAt = Number(raw.collectedAt);
    const coveredThrough = Number(raw.coveredThrough || 0);
    if (!Number.isFinite(collectedAt) || collectedAt <= 0 || collectedAt > now + FUTURE_SKEW_MS ||
        !Number.isInteger(coveredThrough) || coveredThrough < 0 || coveredThrough > 65535) {
      markUnverified();
      return { requestPortOccupancy: true, verified: false };
    }
    const listeners: PortListener[] = [];
    for (const item of raw.listeners) {
      const port = Number(item?.port);
      const address = String(item?.address || "").trim();
      if (!Number.isInteger(port) || port < 1 || port > 65535 ||
          (item?.protocol !== "tcp" && item?.protocol !== "udp") || !address || address.length > 128 ||
          String(item?.process || "").length > 128 ||
          (item?.managedRuntimeId && (item.managedRuntime !== "forwardx-fxp" ||
            typeof item.managedRuntimeId !== "string" || !/^[a-z0-9:-]{1,128}$/.test(item.managedRuntimeId))) ||
          (item?.managedRuntime && !["forwardx-runtime", "forwardx-tunnel-runtime", "forwardx-nginx", "forwardx-fxp", "forwardx-realm", "forwardx-socat"].includes(item.managedRuntime))) {
        markUnverified();
        return { requestPortOccupancy: true, verified: false };
      }
      listeners.push({ port, protocol: item.protocol, address,
        ...(item.process ? { process: String(item.process) } : {}),
        ...(item.managedRuntime ? { managedRuntime: item.managedRuntime } : {}),
        ...(item.managedRuntimeId ? { managedRuntimeId: item.managedRuntimeId } : {}),
      });
    }
    updateBoundedMapValueInPlace(snapshots, hostId, {
      signature,
      snapshot: { listeners, collectedAt, complete: raw.complete, coveredThrough, verifiedAt: now },
      failed: false,
    }, MAX_HOSTS);
    return { requestPortOccupancy: false, verified: true };
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
}

export function inspectPortOccupancy(
  snapshot: PortOccupancySnapshot | null,
  port: number,
  protocol: "tcp" | "udp" | "both",
  reusable: (listener: PortListener) => boolean = () => false,
) {
  if (!snapshot) return { status: "unverified" as const, adminMessage: "主机端口信息未经核实", userMessage: "主机端口信息未经核实" };
  const matching = snapshot.listeners.filter((listener) => listener.port === port &&
    (protocol === "both" || listener.protocol === protocol) && !reusable(listener));
  if (matching.length) {
    const details = matching.map((listener) => `${listener.protocol.toUpperCase()} ${listener.address}:${port}${listener.process ? ` (${listener.process})` : ""}`).join("、");
    const generic = matching.map((listener) => `${listener.protocol.toUpperCase()} ${listener.address}:${port}`).join("、");
    return { status: "occupied" as const, listeners: matching, collectedAt: snapshot.collectedAt, verifiedAt: snapshot.verifiedAt,
      adminMessage: `该端口存在监听：${details}`, userMessage: `该端口存在占用：${generic}` };
  }
  if (!snapshot.complete && port > snapshot.coveredThrough) {
    return { status: "unverified" as const, adminMessage: "主机端口信息未经核实", userMessage: "主机端口信息未经核实" };
  }
  return { status: "free" as const, collectedAt: snapshot.collectedAt, verifiedAt: snapshot.verifiedAt };
}

export function occupiedSnapshotPorts(hostIds: number[], protocol: "tcp" | "udp" | "both") {
  const ports = new Set<number>();
  for (const hostId of hostIds) {
    const snapshot = getPortOccupancy(hostId);
    if (!snapshot) continue;
    for (const listener of snapshot.listeners) {
      if (protocol === "both" || protocol === listener.protocol) ports.add(listener.port);
    }
  }
  return ports;
}
