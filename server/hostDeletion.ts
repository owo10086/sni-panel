import { boolLiteral, quoteIdentifier as q } from "./dbCompat";
import { getDb, queryRaw } from "./dbRuntime";
import { appendPanelLog } from "./_core/panelLogger";
import { deleteHost, getHostById } from "./repositories/hostRepository";
import { repairForwardGroupRuleIntegrity } from "./forwardGroupRuleIntegrity";
import { repairForwardGroupTemplateHostReferences } from "./repositories/forwardGroupRepository";
import { pushAgentRefresh } from "./agentEvents";
import { withGroupMemberMutation } from "./groupMemberMutation";

type Viewer = { id: number; role: string };
type DeletionOptions = { viewer?: Viewer; assertCanDelete?: () => Promise<void> };
type Reference = { id: number; name: string; userId: number };
function referenceList(rows: Reference[], viewer?: Viewer) {
  const visible = viewer && viewer.role !== "admin" ? rows.filter(row => Number(row.userId) === viewer.id) : rows;
  return { count: rows.length, hiddenCount: rows.length - visible.length, items: visible.slice(0, 50).map((row) => ({ id: Number(row.id), name: String(row.name || `#${row.id}`) })) };
}

/** Read-only preview: template host IDs are metadata; members define actual usage. */
export async function getHostDeletionImpact(hostId: number, viewer?: Viewer) {
  if (!(await getDb())) throw new Error("Database unavailable");
  const host = await getHostById(hostId);
  if (!host) throw new Error("主机不存在");
  if (viewer && viewer.role !== "admin" && Number(host.userId) !== viewer.id) throw new Error("无权操作此主机");
  const [rules, groups, tunnels, pending] = await Promise.all([
    queryRaw<Reference>(`SELECT DISTINCT r.${q("id")} AS ${q("id")}, r.${q("name")} AS ${q("name")}, r.${q("userId")} AS ${q("userId")}
      FROM ${q("forward_rules")} r
      WHERE r.${q("pendingDelete")} = ${boolLiteral(false)}
        AND (r.${q("isForwardGroupTemplate")} = ${boolLiteral(false)} OR NOT EXISTS (
          SELECT 1 FROM ${q("forward_group_members")} m WHERE m.${q("groupId")} = r.${q("forwardGroupId")}))
        AND (r.${q("hostId")} = ? OR EXISTS (
          SELECT 1 FROM ${q("forward_rule_tunnel_exits")} e
          WHERE e.${q("ruleId")} = r.${q("id")} AND e.${q("exitHostId")} = ?))
      ORDER BY r.${q("id")}`, [hostId, hostId]),
    queryRaw<Reference>(`SELECT DISTINCT g.${q("id")} AS ${q("id")}, g.${q("name")} AS ${q("name")}, g.${q("userId")} AS ${q("userId")}
      FROM ${q("forward_groups")} g
      INNER JOIN ${q("forward_group_members")} m ON m.${q("groupId")} = g.${q("id")}
      WHERE m.${q("memberType")} = 'host' AND m.${q("hostId")} = ? ORDER BY g.${q("id")}`, [hostId]),
    queryRaw<Reference>(`SELECT DISTINCT t.${q("id")} AS ${q("id")}, t.${q("name")} AS ${q("name")}, t.${q("userId")} AS ${q("userId")}
      FROM ${q("tunnels")} t WHERE t.${q("entryHostId")} = ? OR t.${q("exitHostId")} = ?
        OR EXISTS (SELECT 1 FROM ${q("tunnel_hops")} h WHERE h.${q("tunnelId")} = t.${q("id")} AND h.${q("hostId")} = ?)
        OR EXISTS (SELECT 1 FROM ${q("tunnel_exit_nodes")} e WHERE e.${q("tunnelId")} = t.${q("id")} AND e.${q("hostId")} = ?)
      ORDER BY t.${q("id")}`, [hostId, hostId, hostId, hostId]),
    queryRaw<{ count: number }>(`SELECT COUNT(*) AS ${q("count")} FROM ${q("forward_rules")}
      WHERE ${q("hostId")} = ? AND ${q("pendingDelete")} = ${boolLiteral(true)} AND ${q("isRunning")} = ${boolLiteral(true)}`, [hostId]),
  ]);
  const ruleRefs = referenceList(rules, viewer);
  const groupRefs = referenceList(groups, viewer);
  const tunnelRefs = referenceList(tunnels, viewer);
  return {
    hostId, hostName: host.name, online: !!host.isOnline,
    rules: ruleRefs, groups: groupRefs, tunnels: tunnelRefs,
    blocked: ruleRefs.count + groupRefs.count + tunnelRefs.count > 0,
    pendingCleanupCount: Number(pending[0]?.count || 0),
  };
}

export async function prepareHostDeletion(hostId: number, options: DeletionOptions = {}) {
  return withGroupMemberMutation(async () => {
    // The caller checks ownership again after waiting, before any historical repair.
    await options.assertCanDelete?.();
    await repairForwardGroupRuleIntegrity(hostId);
    await repairForwardGroupTemplateHostReferences({ hostId });
    await options.assertCanDelete?.();
    const impact = await getHostDeletionImpact(hostId, options.viewer);
    if (impact.online && impact.pendingCleanupCount > 0) {
      pushAgentRefresh(hostId, "host-delete-pending-cleanup", { urgent: true });
    }
    return impact;
  });
}

export async function deleteHostWithImpact(hostId: number, confirmOfflineCleanup = false, options: DeletionOptions = {}) {
  return withGroupMemberMutation(async () => {
    await prepareHostDeletion(hostId, options);
    let pendingCleanupCount = 0;
    // deleteHost takes the member lock before the transaction and keeps its last
    // guarded reference/owner checks. Never start a transaction outside that lock.
    await deleteHost(hostId, { assertCanDelete: async () => {
      await options.assertCanDelete?.();
      const impact = await getHostDeletionImpact(hostId, options.viewer);
      if (impact.blocked) {
        const names = [...impact.rules.items, ...impact.groups.items, ...impact.tunnels.items]
          .slice(0, 5).map((item) => `${item.name} (#${item.id})`).join("、");
        const categories = [impact.rules.count ? "转发规则 / 转发组主规则" : "", impact.groups.count ? "转发组 / 转发链" : "", impact.tunnels.count ? "隧道" : ""].filter(Boolean).join("、");
        throw new Error(`主机仍有关联配置（${categories}），请先移除引用${names ? `：${names}` : "，部分关联配置需要管理员处理"}`);
      }
      pendingCleanupCount = impact.pendingCleanupCount;
      if (pendingCleanupCount > 0) {
        if (impact.online) throw new Error("主机正在清理已移除的规则，请稍后重试，不需要重新保存规则");
        if (!confirmOfflineCleanup) throw new Error("主机离线，无法确认规则已停止，请确认离线移除风险后重试");
      }
    } });
    appendPanelLog("info", `[Host] deleted host=${hostId} offlineCleanup=${pendingCleanupCount > 0} pending=${pendingCleanupCount}`);
    return { success: true };
  });
}
