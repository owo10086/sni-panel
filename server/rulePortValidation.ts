import type { PortListener } from "./portOccupancy";

type ListeningRule = { id: number; isRunning?: unknown; forwardType: string; tunnelId?: number | null; forwardGroupId?: number | null;
  sni?: string | null; sniSplitterPort?: number | null; sourcePort: number };

export function managedListenerMatchesRule(listener: PortListener, rule: ListeningRule, allowPendingSni = false) {
  if (![true, 1, "1"].includes(rule.isRunning as string | number | boolean) && !(allowPendingSni && rule.sni)) return false;
  if (rule.forwardType === "gost") {
    if (listener.managedRuntime === "forwardx-fxp") {
      const tunnelId = Number(rule.tunnelId || 0);
      const runtimeId = listener.managedRuntimeId || "";
      if (!runtimeId) return false;
      if (rule.sni && Number(rule.sniSplitterPort) === listener.port &&
          (runtimeId === `v1:sni-splitter:${tunnelId}:${listener.port}` ||
           runtimeId === `v2:sni-splitter:${tunnelId}:${listener.port}`) &&
          (tunnelId > 0 || Number(rule.forwardGroupId || 0) > 0)) return true;
      if (!tunnelId) return false;
      return runtimeId === `entry-group:v1:${tunnelId}` || runtimeId === `entry-group:v2:${tunnelId}` ||
        runtimeId === `v1:entry:${tunnelId}:${rule.id}:${listener.port}` ||
        runtimeId === `v2:entry:${tunnelId}:${rule.id}:${listener.port}`;
    }
    return listener.managedRuntime === "forwardx-runtime";
  }
  if (rule.forwardType === "nginx") return listener.managedRuntime === "forwardx-nginx";
  if (rule.forwardType === "realm" || rule.forwardType === "socat") {
    return listener.managedRuntime === `forwardx-${rule.forwardType}`;
  }
  return false;
}
