import { setBoundedMapValue } from "./boundedCache";
import { buildSNISplitterSourceRestrictionCleanupCmds } from "./agentActionCommands";

export const SNI_SOURCE_CLEANUP_RUNTIME = "sni-source-cleanup";

type CleanupState = { session: string; issuedAt: number; complete: boolean };
const cleanupStates = new Map<number, CleanupState>();

// 面板或 Agent 重启后重新核实防火墙。空来源元数据无法证明历史规则已清理，
// 只有这一轮清理动作的成功回报才完成迁移；失败沿用正常配置下发重试。
export function sniSourceCleanupAction(hostId: number, session: string) {
  let state = cleanupStates.get(hostId);
  if (!state || state.session !== session) {
    state = { session, issuedAt: Math.max(Date.now(), (state?.issuedAt || 0) + 1), complete: false };
    setBoundedMapValue(cleanupStates, hostId, state, 5000);
  }
  if (state.complete) return null;
  return {
    statusType: "runtime",
    forwardType: SNI_SOURCE_CLEANUP_RUNTIME,
    ruleId: 0,
    tunnelId: 0,
    sourcePort: 0,
    targetIp: "",
    targetPort: 0,
    protocol: "tcp",
    op: "apply",
    issuedAt: state.issuedAt,
    knownRunning: false,
    forceRuntimeSync: true,
    reportStatus: true,
    failureMessage: "SNI 来源限制清理失败或无法核实，Agent 将重试，请检查主机防火墙权限和日志",
    commands: buildSNISplitterSourceRestrictionCleanupCmds(),
  };
}

export function recordSniSourceCleanupResult(hostId: number, issuedAt: unknown, success: boolean) {
  const state = cleanupStates.get(hostId);
  if (state && Number(issuedAt) === state.issuedAt) state.complete = success;
}
