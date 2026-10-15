import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function runGroupMemberReleaseCase(body: string, options: { timeout?: number } = {}): void {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-member-release-"));
  const setup = String.raw`
    import assert from "node:assert/strict";
    import { EventEmitter } from "node:events";
    import * as runtime from "./server/dbRuntime.ts";
    import { ensureDatabaseSchema } from "./server/dbSchema.ts";
    import * as links from "./server/repositories/forwardGroupRepository.ts";
    import * as hosts from "./server/repositories/hostRepository.ts";
    import { forwardGroupsRouter } from "./server/routers/forwardGroups.ts";
    import { hostsRouter } from "./server/routers/hosts.ts";
    import { agentTokensRouter } from "./server/routers/agentTokens.ts";
    import * as tunnelState from "./server/tunnelRuntimeStatus.ts";
    import { registerAgentEventClient, pushAgentRefresh } from "./server/agentEvents.ts";
    import { withGroupMemberMutation } from "./server/groupMemberMutation.ts";
    import { keyedTaskDepth } from "./server/keyedTaskLock.ts";
    const streams = [];
    const captureAgentFrames = hostIds => {
      const responses = new Map();
      for (const hostId of hostIds) {
        class Response extends EventEmitter {
          frames = [];
          write(value) { this.frames.push(String(value)); return true; }
          end() { this.emit("finish"); }
        }
        const response = new Response();
        responses.set(hostId, response);
        streams.push(registerAgentEventClient(hostId, "test-token-" + hostId, response));
        pushAgentRefresh(hostId, "capture-established", { urgent: true });
      }
      return () => [...responses].map(([id, response]) => [id, [...response.frames]]);
    };
    const context = {
      req: { headers: {} }, res: { clearCookie() {} },
      user: { id: 1, username: "admin", role: "admin", accountEnabled: true },
      authSession: null, authFailureReason: null,
    };
    const groups = forwardGroupsRouter.createCaller(context);
    const hostCaller = hostsRouter.createCaller(context);
    const tokenCaller = agentTokensRouter.createCaller(context);
    const deleteSnapshot = async () => {
      const result = {};
      for (const table of ["hosts", "agent_tokens", "user_host_permissions", "forward_rules",
        "forward_group_members", "tunnels", "subscription_plan_hosts"]) {
        result[table] = await runtime.queryRaw('SELECT * FROM "' + table + '" ORDER BY 1');
      }
      return result;
    };
    const waitForMutationQueue = async expected => {
      for (let turn = 0; turn < 100; turn++) {
        if (keyedTaskDepth("group-member-mutation") === expected) return;
        await new Promise(resolve => setImmediate(resolve));
      }
      assert.fail('request did not reach the member mutation queue');
    };
    const runInMutationOrder = async (first, second) => {
      let release, entered;
      const gate = new Promise(resolve => { release = resolve; });
      const ready = new Promise(resolve => { entered = resolve; });
      const holding = withGroupMemberMutation(async () => { entered(); await gate; });
      await ready;
      const one = first().then(value => ({ value }), error => ({ error }));
      await waitForMutationQueue(2);
      const two = second().then(value => ({ value }), error => ({ error }));
      try { await waitForMutationQueue(3); }
      finally { release(); }
      await holding;
      const result = await Promise.all([one, two]);
      for (const item of result) if (item.error) throw item.error;
      return result.map(item => item.value);
    };
    const insert = async (table, row) => runtime.executeRaw(
      'INSERT INTO "' + table + '" (' +
      Object.keys(row).map(key => '"' + key + '"').join(",") +
      ') VALUES (' + Object.keys(row).map(() => "?").join(",") + ')',
      Object.values(row),
    );
    const rootSnapshot = async groupId => (await runtime.queryRaw(
      'SELECT * FROM forward_rules ' +
      'WHERE forwardGroupId=? AND isForwardGroupTemplate=1 ORDER BY id', [groupId],
    )).map(({ hostId, isRunning, updatedAt, ...saved }) => saved);
    // Only reads: never call repair, deletion checks or sync from this assertion.
    const assertGroupReleased = async (groupId, oldHostId, expectedOwnerId) => {
      const owners = await runtime.queryRaw(
        'SELECT DISTINCT hostId FROM forward_rules WHERE forwardGroupId=? ' +
        'AND isForwardGroupTemplate=1 AND pendingDelete=0 ORDER BY hostId', [groupId],
      );
      assert.deepEqual(owners, [{ hostId: expectedOwnerId }]);
      const remaining = await runtime.queryRaw(
        'SELECT id FROM forward_rules WHERE forwardGroupId=? AND hostId=? ' +
        'AND pendingDelete=0', [groupId, oldHostId],
      );
      assert.deepEqual(remaining, [], 'saved group must release roots and live children');
    };
    const seedFailover = async (count = 1, sni = false, enabled = true) => {
      await insert("forward_groups", {
        id: 10, name: "release-group", groupType: "host", groupMode: "failover",
        forwardType: "iptables", targetIp: "0.0.0.0", userId: 1,
        isEnabled: Number(enabled), activeMemberId: 101,
        failoverSeconds: 17, recoverSeconds: 23, autoFailback: 1,
      });
      for (const hostId of [1, 2]) await insert("forward_group_members", {
        id: 100 + hostId, groupId: 10, memberType: "host", hostId,
        priority: hostId - 1, isEnabled: 1,
      });
      for (let index = 0; index < count; index++) await insert("forward_rules", {
        id: 1000 + index, hostId: 1, name: "rule-" + index, userId: 1,
        forwardType: "iptables", protocol: "tcp", forwardGroupId: 10,
        isForwardGroupTemplate: 1, isEnabled: 1, isRunning: 0,
        sourcePort: sni ? 443 : 20000 + index,
        sni: sni ? "rule-" + index + ".example.test" : null,
        sniSplitterPort: sni ? 443 : null,
        targetIp: "192.0.2.90", targetPort: 8443,
        quotaUsedIn: 123, quotaUsedOut: 456,
      });
      await links.syncForwardGroupRules(10);
    };
    const seedEntryChain = async (sni = false) => {
      await insert("forward_groups", {
        id: 30, name: "entry-group", groupType: "host", groupMode: "entry",
        domain: "entry.example.test", ddnsAutoResolveEnabled: 0,
        targetIp: "0.0.0.0", userId: 1, isEnabled: 1,
      });
      for (const hostId of [4, 5]) await insert("forward_group_members", {
        id: 300 + hostId, groupId: 30, memberType: "host",
        hostId, priority: hostId - 4, isEnabled: 1,
      });
      await insert("forward_groups", {
        id: 40, name: "chain", groupType: "host", groupMode: "chain",
        entryGroupId: 30, forwardType: "iptables", targetIp: "0.0.0.0",
        userId: 1, isEnabled: 1,
      });
      for (const hostId of [1, 2]) await insert("forward_group_members", {
        id: 400 + hostId, groupId: 40, memberType: "host",
        hostId, priority: hostId - 1, isEnabled: 1,
      });
      await insert("forward_rules", {
        id: 400, hostId: 4, name: "chain-rule", forwardType: "iptables",
        protocol: "tcp", forwardGroupId: 40, isForwardGroupTemplate: 1,
        sourcePort: 42005, targetIp: "192.0.2.90", targetPort: 8443,
        sni: sni ? "chain.example.test" : null, sniSplitterPort: sni ? 42005 : null,
        userId: 1, isEnabled: 1, isRunning: 0, quotaUsedIn: 123, quotaUsedOut: 456,
      });
      await links.syncForwardGroupRules(40);
    };

    const saveMembers = async (id, hostIds, patch = {}) => {
      const old = await links.getForwardGroupById(id);
      return groups.update({
        id, name: old.name, groupMode: old.groupMode, groupType: old.groupType,
        entryGroupId: old.entryGroupId, forwardType: "iptables", protocol: "tcp",
        domain: old.domain || null, recordType: "A",
        failoverSeconds: 17, recoverSeconds: 23, autoFailback: true,
        isEnabled: Boolean(old.isEnabled), ddnsAutoResolveEnabled: false,
        members: hostIds.map((hostId, priority) => ({
          memberType: "host", hostId, priority, isEnabled: true,
        })), ...patch,
      });
    };
    try {
      await runtime.connectDatabase({
        type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB },
      });
      await ensureDatabaseSchema();
      await insert("users", {
        id: 1, username: "admin", password: "test", role: "admin",
        canAddRules: 1, manualCanAddRules: 1,
      });
      for (const id of [1, 2, 3, 4, 5, 6]) await insert("hosts", {
        id, name: "host-" + id, ip: "192.0.2." + id, ipv4: "192.0.2." + id,
        userId: 1, isOnline: 1, lastHeartbeat: Math.floor(Date.now() / 1000),
        agentVersion: "3.3.0",
      });
  `;
  const cleanup = String.raw`
    } finally {
      streams.forEach(stream => stream.close());
      await runtime.closeDatabase();
    }
  `;
  try {
    const result = spawnSync(process.execPath, [
      "--import", "tsx", "--input-type=module", "--eval", setup + body + cleanup,
    ], {
      cwd: process.cwd(), encoding: "utf8", timeout: options.timeout ?? 30_000,
      env: {
        ...process.env, DATABASE_TYPE: "sqlite",
        FORWARDX_TEST_DB: path.join(directory, "test.db"),
        FORWARDX_LOG_DIR: path.join(directory, "logs"),
      },
    });
    assert.equal(result.status, 0,
      result.error?.message || result.stderr + result.stdout);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
