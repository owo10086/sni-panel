# 转发组／入口组删减成员后释放主机 Implementation Plan

> **实施授权更新（2026-10-16）：** 用户已明确要求“执行计划后，完成提交并发布新版”。以下“仅方案”属于前期边界；本轮已授权实施、检查、提交并向 `sni-panel` 发布，不包含直接修改生产数据库或删除 dmit6。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.
>
> 本仓库执行约定优先：用户明确同意改代码后才能实施；在当前目录工作，不创建工作树。上面的技能名称表示执行方式，不代表本轮已获准执行。当前已安装的逐项执行技能为 `/Users/macmini/.codex/skills/executing-plans/SKILL.md`；选择逐项执行时读取该文件。计划编写阶段的自查由编写者完成；本轮实施按所选技能逐项执行并独立审查。

**Goal:** 转发组或入口组删减成员并成功保存后，释放该组对旧主机的引用，同时保留原有规则、用量和其他真实用途的保护。

**Architecture:** 把“主规则还应该归属哪台现有主机”的选择收拢到一个小文件，保存成员和整理组规则共用这一判断。成员变更、主规则归属和依赖转发链在同一次数据库保存中完成，提交后再下发清理和处理 DNS。删除检查先修正历史归属，最终删除再核对真实用途；保存检查直接读取记录，避免被删除检查的自动修正掩盖。

**Tech Stack:** 沿用 TypeScript、Node.js、现有 Drizzle 数据层、SQLite／MySQL／PostgreSQL 兼容工具、`node:test` 和 `tsx`；不增加依赖、接口、数据库字段或 Agent 协议。

**Spec:** `.scratch/2026-10-16_dmit6移出转发组仍被引用/spec.md`。接手者同时阅读需求、排查记录和本文件。

## Global Constraints

- 禁止自动修改代码，需要人工同意才能修改代码。
- 禁止创建工作树。
- 发问题、报告、清单、总结时需要使用md格式排版。
- 不要用技术语言，用大白话解释，逻辑复杂的项目需要举例说明。
- 所有代码提交、版本标签和发布操作只推送到 `sni-panel` 远端的 `main` 分支，仓库地址为 `https://github.com/owo10086/sni-panel.git`。
- `origin` 仅作为上游参考来源，禁止向该远端推送代码、标签或发布内容。
- 原生 Android、iOS／iPadOS 应用按长期约定排除。
- 沿用原有成员数量限制；本次不增加“保留空组”的功能。
- 不把“禁用成员”解释成“移除成员”；禁用成员仍是用户保存的组成员。
- 不扩大为出口组选路、健康算法、DNS 政策或主机卸载改造。
- 本轮最新授权包含实施、检查、提交和发布新版；生产数据处理、部署和删除 dmit6 没有在本轮执行。

---

## 接手时先看什么

1. 阅读 `AGENTS.md`、`CONTEXT.md`、需求文件，以及 `docs/adr/0001-sni-splitting-runs-as-a-standalone-fxp-role-at-the-exit.md`。保留 SNI 入口、出口和用量归属的既有约定。
2. 用 `git -c core.quotePath=false status --short` 记录已有修改；不覆盖其他会话的文件，不创建工作树，不自动清理或暂存整个目录。
3. 当前原因已确认：主备组留下 44 条旧主机归属；入口组影响的转发链也能留下同类主规则。入口组本身是集合，不直接持有业务主规则。
4. 现有 `deleteHost` 会按旧主机编号删除规则，不能只取消报错。必须先转移主规则归属，再判断和删除。
5. `syncForwardGroupRules` 禁止在已经开始的数据库保存中再申请组保存位置；使用现有 `withForwardGroupsSyncTransaction`，先按编号顺序申请全部组，再统一保存。
6. `removeManagedRule` 已有用量结算和提交后刷新路径，继续使用。不得改成直接删除成员副本。
7. 原计划未要求改版本号；本轮按追加授权准备面板 3.3.8。正式发布、生产处理和人工验收分别记录。

## 文件分工

| 文件 | 创建／修改 | 负责什么 |
| --- | --- | --- |
| `server/forwardGroupTemplateHosts.ts` | 创建 | 只决定主规则归属；输入最新配置候选，输出确需转移的主机编号，不访问数据库或 DNS。 |
| `server/forwardGroupTemplateHosts.test.ts` | 创建 | 检查候选顺序、禁用／离线、稳定归属、不同组模式。 |
| `server/repositories/forwardGroupRepository.ts` | 修改 | 读取候选、在已有保存保护内改归属；整理规则前修正归属；查询入口组影响的链；修正历史引用。 |
| `server/services/forwardGroupService.ts` | 修改 | 把成员保存与规则整理放在同一次保存中；入口组刷新先于 DNS 调用。 |
| `server/routers/forwardGroups.ts` | 修改 | 局部编辑先取得成员修改位置，再读取原配置和合并修改，防止把旧名单带回去。 |
| `server/repositories/hostRepository.ts` | 修改 | 删除前修正历史归属，检查真实组／隧道引用；保留现有规则和待清理数量的含义。 |
| `server/groupMemberMutation.ts` | 创建 | 让组成员保存和主机／Token 删除依次完成；统一申请顺序，允许同一次保存内部再次进入。 |
| `server/dbRuntime.ts`、`server/databaseTransaction.test.ts` | 修改 | 为本次保存增加“提交后各项都尝试，再报告错误”的可选方式；保持其他调用的默认行为。 |
| `server/repositories/tokenRepository.ts` | 修改 | Token 删除及认证缓存处理跟随最终保存结果，失败不提前断开绑定。 |
| `server/routers/hosts.ts` | 修改 | 删除主机前执行完整引用检查。 |
| `server/routers/agentTokens.ts` | 修改 | 删除 Token 前使用同样的真实引用保护。 |
| `server/test-support/groupMemberReleaseHarness.ts` | 创建 | 用独立进程和临时数据库运行真实保存、删除场景，结束后删除临时数据。 |
| `server/groupMemberRelease.test.ts` | 创建 | 检查普通组、SNI 组、入口组、历史数据、真实引用和失败撤回。 |
| `server/test-support/sniForwardGroupHealthHarness.mjs` | 修改 | 在既有真实心跳／本地 DNS 环境中检查成员移除后配置与 DNS 失败的关系。 |
| `server/sniForwardGroupHealth.test.ts` | 修改 | 注册上面的实际配置场景。 |
| `server/test-support/sniImportHarness.mjs`、`server/sniBatchImport.test.ts` | 修改 | 复用已有入口组／TLS 隧道环境，核对旧入口撤除和独立入口保留。 |
| `server/test-support/groupMemberReleaseDialectHarness.mjs` | 创建 | 仅在专用空测试库中运行保存、历史修正和最终删除，不自动寻找线上连接。 |
| `client/src/i18n/en.json` | 修改 | 若删除保护增加提示，为固定中文原文补充英文。 |
| `docs/guide/groups.md`、`docs/guide/hosts.md` | 修改 | 用例子说明移除、释放、仍被独立资源使用和实际清理的区别。 |
| `package.json` | 修改 | 把两份新检查文件加入既有 `test:server`，不改依赖或其他测试顺序。 |

`server/portForwardRuleHosts.ts` 和原有检查先保留，作为普通端口转发的兼容对照。组整理和主机删除的新增路径统一使用新判断；确认没有外部调用后也不在本次顺带删除旧文件或改造启动迁移。

## Task 1: 决定主规则应该留在哪台现有主机

**Files:**

- Create: `server/forwardGroupTemplateHosts.ts`
- Test: `server/forwardGroupTemplateHosts.test.ts`

**Interfaces:**

- Consumes：下面定义的 `TemplateHostCandidate`，只包含当前配置成员，不包含健康检查结果。
- Produces：`planTemplateHostRepairs(rows: TemplateHostCandidate[]): TemplateHostRepair[]`。任务 2、3、4 使用这一个选择函数。

- [x] **Step 1: 先写失败检查。**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  planTemplateHostRepairs,
  type TemplateHostCandidate,
} from "./forwardGroupTemplateHosts";

const row = (
  patch: Partial<TemplateHostCandidate> = {},
): TemplateHostCandidate => ({
  ruleId: 100, groupId: 10, storedHostId: 1,
  groupMode: "failover", externalEntry: false,
  memberId: 102, hostId: 2, priority: 0, enabled: true,
  ...patch,
});

test("removed host transfers to a remaining configured member", () => {
  assert.deepEqual(planTemplateHostRepairs([row()]), [
    { ruleId: 100, groupId: 10, fromHostId: 1, toHostId: 2 },
  ]);
});

test("a still configured owner is retained without rewriting", () => {
  assert.deepEqual(planTemplateHostRepairs([
    row({ hostId: 2 }), row({ memberId: 103, hostId: 1, priority: 1 }),
  ]), []);
});

test("configured disabled members still provide a stable saved owner", () => {
  assert.equal(planTemplateHostRepairs([row({ enabled: false })])[0].toHostId, 2);
});

test("an external-entry chain uses entry-group candidates", () => {
  assert.equal(planTemplateHostRepairs([
    row({ groupMode: "chain", externalEntry: true, hostId: 5 }),
  ])[0].toHostId, 5);
});

test("an ordinary chain uses its first configured enabled hop", () => {
  assert.equal(planTemplateHostRepairs([
    row({ groupMode: "chain", hostId: 3, priority: 1, memberId: 103 }),
    row({ groupMode: "chain", hostId: 2, priority: 0 }),
  ])[0].toHostId, 2);
});

test("input order and invalid candidate ids do not change the result", () => {
  assert.deepEqual(planTemplateHostRepairs([
    row({ hostId: 0 }), row({ hostId: 3, memberId: 103, priority: 1 }), row(),
  ]), planTemplateHostRepairs([row()]));
});
```

- [x] **Step 2: 运行，确认旧代码无法提供这项能力。**

```bash
node --import tsx --test server/forwardGroupTemplateHosts.test.ts
```

预期：新模块不存在，或上述归属断言失败。记录真实输出，不能把加载失败当成后续业务场景已经重现。

- [x] **Step 3: 增加只负责选择的小文件。**

```ts
export type TemplateHostCandidate = {
  ruleId: number;
  groupId: number;
  storedHostId: number;
  groupMode: "port" | "failover" | "chain";
  externalEntry: boolean;
  memberId: number;
  hostId: number;
  priority: number;
  enabled: boolean;
};

export type TemplateHostRepair = {
  ruleId: number;
  groupId: number;
  fromHostId: number;
  toHostId: number;
};

export function planTemplateHostRepairs(
  rows: TemplateHostCandidate[],
): TemplateHostRepair[] {
  const byRule = new Map<number, TemplateHostCandidate[]>();
  for (const row of rows) {
    if (![row.ruleId, row.groupId, row.memberId, row.hostId]
      .every(value => Number.isInteger(value) && value > 0)) continue;
    const current = byRule.get(row.ruleId) || [];
    current.push(row);
    byRule.set(row.ruleId, current);
  }
  const repairs: TemplateHostRepair[] = [];
  for (const [ruleId, candidates] of [...byRule].sort(([a], [b]) => a - b)) {
    candidates.sort((a, b) =>
      Number(b.enabled) - Number(a.enabled)
      || a.priority - b.priority || a.memberId - b.memberId);
    const first = candidates[0];
    const eligible = first.groupMode === "chain" && !first.externalEntry
      ? candidates.slice(0, 1) : candidates;
    if (eligible.some(candidate => candidate.hostId === first.storedHostId)) continue;
    repairs.push({
      ruleId, groupId: first.groupId,
      fromHostId: first.storedHostId, toHostId: eligible[0].hostId,
    });
  }
  return repairs;
}
```

候选由后续任务从最新配置读取；没有候选时不把主规则设成空值，也不删规则。正常成员保存沿用“至少一个成员”的限制，遇到历史损坏配置则保留删除保护并给出原因。

- [x] **Step 4: 运行并补齐明确的边界断言。**

```ts
test("equal priorities use member ids and enabled candidates come first", () => {
  assert.equal(planTemplateHostRepairs([
    row({ hostId: 4, memberId: 104, enabled: false, priority: -1 }),
    row({ hostId: 3, memberId: 103 }),
    row({ hostId: 2, memberId: 102 }),
  ])[0].toHostId, 2);
});
test("empty candidates do not authorize deleting a rule", () => {
  assert.deepEqual(planTemplateHostRepairs([]), []);
});
```

```bash
node --import tsx --test server/forwardGroupTemplateHosts.test.ts server/portForwardRuleHosts.test.ts
```

预期：全部通过，现有普通端口转发检查继续通过。本项不声称已经修好保存或删除接口。

- [x] **Step 5: 单独提交本项。**

```bash
git add server/forwardGroupTemplateHosts.ts server/forwardGroupTemplateHosts.test.ts
git commit -m "fix: define current group template host ownership"
```

## Task 2: 转发组保存成员时完整释放旧主机

**Files:**

- Modify: `server/repositories/forwardGroupRepository.ts`：`syncForwardGroupRulesUnlocked`、`replaceForwardGroupMembers` 及其附近的归属处理。
- Modify: `server/services/forwardGroupService.ts`：`updateForwardGroupFromInput` 的成员变更分支。
- Modify: `server/routers/forwardGroups.ts`：`updateFields` 读取和合并修改的位置。
- Create: `server/groupMemberMutation.ts`
- Modify: `server/dbRuntime.ts`、`server/databaseTransaction.test.ts`：可选的提交后错误收集。
- Create: `server/test-support/groupMemberReleaseHarness.ts`
- Test: `server/groupMemberRelease.test.ts`

**Interfaces:**

- Consumes：任务 1 的 `TemplateHostCandidate`、`TemplateHostRepair`、`planTemplateHostRepairs`。
- Produces：仓库内部函数 `repairForwardGroupTemplateHostsUnlocked(groupId: number): Promise<TemplateHostRepair[]>`。调用前必须已取得有关组的保存位置；函数本身不申请保存位置、不访问 DNS、不启动另一轮组同步。
- Produces：测试辅助 `runGroupMemberReleaseCase(body: string): void`。子进程内提供 `runtime`、`links`、`hosts`、`groups`、`hostCaller`、`tokenCaller`、`insert`、`seedFailover`、`saveMembers`、`rootSnapshot`、`assertGroupReleased`，定义见本项。

- [x] **Step 1: 添加独立数据库检查辅助，并先写真实保存失败检查。**

先创建 Step 3a 给出的 `groupMemberMutation.ts` 辅助，暂时不接入原保存路径，保证检查能加载模块；这一准备不应修好成员归属。缺模块的失败单独记为准备未完成，不能算旧业务问题重现。

`server/test-support/groupMemberReleaseHarness.ts` 的检查辅助按如下内容创建：

```ts
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function runGroupMemberReleaseCase(body: string): void {
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
    import { registerAgentEventClient } from "./server/agentEvents.ts";
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
      cwd: process.cwd(), encoding: "utf8", timeout: 30_000,
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
```

`server/groupMemberRelease.test.ts` 的首批检查：

```ts
import test from "node:test";
import { runGroupMemberReleaseCase } from "./test-support/groupMemberReleaseHarness";

for (const count of [1, 44]) {
  test("failover member removal releases old host with " + count + " roots", () => {
    runGroupMemberReleaseCase(`
      await seedFailover(` + count + `);
      const before = await rootSnapshot(10);
      const keptSql = 'SELECT id,forwardGroupRuleId FROM forward_rules WHERE forwardGroupId=10 ' +
        'AND hostId=2 AND isForwardGroupTemplate=0 AND pendingDelete=0 ORDER BY id';
      const keptBefore = await runtime.queryRaw(keptSql);
      assert.equal(keptBefore.length, ` + count + `);
      await saveMembers(10, [2]);
      await assertGroupReleased(10, 1, 2);
      assert.deepEqual(await rootSnapshot(10), before);
      assert.deepEqual(await runtime.queryRaw(keptSql), keptBefore);
      const retired = await runtime.queryRaw(
        'SELECT pendingDelete,isEnabled FROM forward_rules WHERE forwardGroupId=10 ' +
        'AND hostId=1 AND isForwardGroupTemplate=0'
      );
      assert.equal(retired.length, ` + count + `);
      assert.ok(retired.every(rule => Number(rule.pendingDelete) === 1 && Number(rule.isEnabled) === 0));
      assert.equal((await hosts.getHostRuleDeleteBlockers(1)).managedRuleCount, 0);
      const rootHosts = await runtime.queryRaw(
        'SELECT DISTINCT hostId FROM forward_rules ' +
        'WHERE forwardGroupId=10 AND isForwardGroupTemplate=1'
      );
      assert.deepEqual(rootHosts, [{ hostId: 2 }]);
      assert.notEqual(Number((await links.getForwardGroupById(10)).activeMemberId), 101);
      assert.equal(Number((await runtime.queryRaw(
        'SELECT COUNT(*) AS count FROM forward_rules WHERE hostId=1 ' +
        'AND isForwardGroupTemplate=0 AND pendingDelete=0'
      ))[0].count), 0);
    `);
  });
}
```

保存后活动成员编号可以是新成员或空值，但不能仍是已移除的 101；不等断言允许健康检查选中新的现有成员。

- [x] **Step 2: 运行，确认通过真实接口仍能遇到旧问题。**

```bash
node --import tsx --test --test-name-pattern="failover member removal" server/groupMemberRelease.test.ts
```

预期：成员名单成功改变，但旧主机引用仍为 1 或 44；主规则的主机归属断言失败。这与现场的有效引用数量对应。

- [x] **Step 3: 在现有仓库文件中加入候选读取与归属保存。**

在 `forwardGroupRepository.ts` 增加函数；这里使用的 `dbBool`、`getHostById`、`memberEntryHostId`、`sortedMembers`、`getForwardGroupTemplateRules`、`nowDate` 和数据库工具都已经存在。现有 `../dbRuntime` 导入列表补入 `rawAffectedRows`：

```ts
import {
  planTemplateHostRepairs,
  type TemplateHostCandidate,
  type TemplateHostRepair,
} from "../forwardGroupTemplateHosts";

async function repairForwardGroupTemplateHostsUnlocked(
  groupId: number,
): Promise<TemplateHostRepair[]> {
  const group = await getForwardGroupById(groupId);
  if (!group) return [];
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const activeMemberId = Number(group.activeMemberId || 0);
  if (activeMemberId > 0 && !(group.members || []).some(
    (member: any) => Number(member.id) === activeMemberId,
  )) {
    await db.update(forwardGroups).set({ activeMemberId: null, updatedAt: nowDate() })
      .where(and(eq(forwardGroups.id, groupId), eq(forwardGroups.activeMemberId, activeMemberId)));
  }
  const mode = groupModeOf(group);
  if (mode !== "port" && mode !== "failover" && mode !== "chain") return [];
  const externalEntry = mode === "chain" && Number(group.entryGroupId || 0) > 0;
  const sourceGroup = externalEntry
    ? await getForwardGroupById(Number(group.entryGroupId)) : group;
  if (!sourceGroup || (externalEntry && groupModeOf(sourceGroup) !== "entry")) return [];
  const memberCandidates = [];
  for (const member of sortedMembers(sourceGroup)) {
    const hostId = await memberEntryHostId(member);
    if (!hostId || !(await getHostById(hostId))) continue;
    memberCandidates.push({
      memberId: Number(member.id), hostId,
      priority: Number(member.priority || 0),
      enabled: dbBool(member.isEnabled),
    });
  }
  const templates = await getForwardGroupTemplateRules(groupId);
  const rows: TemplateHostCandidate[] = [];
  for (const template of templates as any[]) {
    if (dbBool(template.pendingDelete)) continue;
    for (const candidate of memberCandidates) rows.push({
      ...candidate, ruleId: Number(template.id), groupId,
      storedHostId: Number(template.hostId), groupMode: mode, externalEntry,
    });
  }
  const repairs = planTemplateHostRepairs(rows);
  const q = quoteIdentifier;
  for (const repair of repairs) {
    const result = await executeRaw(
      "UPDATE " + q("forward_rules") + " SET " + q("hostId") + "=?," +
      q("isRunning") + "=?," + q("updatedAt") + "=? WHERE " +
      q("id") + "=? AND " + q("forwardGroupId") + "=? AND " +
      q("hostId") + "=? AND " + q("isForwardGroupTemplate") + "=? AND " +
      q("pendingDelete") + "=?",
      [repair.toHostId, boolValue(false), nowDate(), repair.ruleId, repair.groupId,
        repair.fromHostId, boolValue(true), boolValue(false)],
    );
    if (rawAffectedRows(result) !== 1) {
      throw new Error("规则归属发生变化，请刷新后重试");
    }
  }
  return repairs;
}
```

将该调用放在 `syncForwardGroupRulesUnlocked` 读取主规则之前、处理禁用状态而提前返回之前。普通端口模式不重复执行两套归属更新：

```ts
await repairForwardGroupTemplateHostsUnlocked(groupId);
const templates = await getForwardGroupTemplateRules(groupId);
```

成员移除时，在同一保存中清除已经删除的活动成员编号。条件更新避免覆盖已经选中的其他成员：

```ts
await db.update(forwardGroups).set({
  activeMemberId: null, updatedAt: nowDate(),
}).where(and(
  eq(forwardGroups.id, groupId),
  eq(forwardGroups.activeMemberId, Number(old.id)),
));
```

保留 `removeManagedRule(rule.id, { deferRefresh: true })` 原有逻辑；不把旧副本直接物理删除，不把它改回有效规则。

- [x] **Step 3a: 统一成员保存与删除的先后顺序。**

新增 `server/groupMemberMutation.ts`。只保护本次涉及的成员变更和主机／Token 删除，不给整个系统套全局数据库锁：

```ts
import { AsyncLocalStorage } from "node:async_hooks";
import { withResourceTaskLock } from "./keyedTaskLock";
import { isDatabaseTransactionActive } from "./dbRuntime";

const context = new AsyncLocalStorage<{ active: boolean }>();
export function assertGroupMemberMutationHeld(): void {
  if (!context.getStore()?.active) throw new Error("成员保存必须先取得修改位置");
}
export async function withGroupMemberMutation<T>(work: () => Promise<T>): Promise<T> {
  if (context.getStore()?.active) return work();
  if (isDatabaseTransactionActive()) throw new Error("成员修改位置必须在数据库保存前取得");
  return withResourceTaskLock("group-member-mutation", async () => {
    const token = { active: true };
    try { return await context.run(token, work); }
    finally { token.active = false; }
  });
}
```

将服务层 `createForwardGroupFromInput`、`updateForwardGroupFromInput` 的原函数体分别提为同参数的私有 `createForwardGroupFromInputUnlocked`、`updateForwardGroupFromInputUnlocked`，公开函数只负责包装。必须从读取 `existing` 和计算 `membersChanged` **之前**进入；原网页路由的 `forward-group:id` 保存位置继续保留，不在服务层重复申请这把不可重入的位置：

```ts
export function createForwardGroupFromInput(input: ForwardGroupInput, userId: number) {
  return withGroupMemberMutation(() => createForwardGroupFromInputUnlocked(input, userId));
}
export function updateForwardGroupFromInput(id: number, input: ForwardGroupInput) {
  return withGroupMemberMutation(() => updateForwardGroupFromInputUnlocked(id, input));
}
```

服务层、组仓库、主机仓库和主机／Token 路由分别从 `../groupMemberMutation` 导入所需函数；组仓库和主机仓库同时导入 `assertGroupMemberMutationHeld`。主机仓库补入 `afterDatabaseCommit`、`isDatabaseTransactionActive`；Token 仓库补入 `afterDatabaseCommit`。`forwardGroups.updateFields` 已经在网页的同组保存位置内读取原配置，但这一位置不能阻止底层直接调用。给路由补入同一包装，放在读取 `existing` 之前，现有查询、合并和校验内容完整保留：

```ts
.mutation(async ({ input }) => withKeyedTaskLock(`forward-group:${input.id}`, () =>
  withGroupMemberMutation(async () => {
    const existing = await db.getForwardGroupById(input.id) as any;
    if (!existing) throw new Error("转发资源不存在");
    const current = Object.fromEntries(Object.keys(baseSchema.shape)
      .filter(key => existing[key] !== undefined && existing[key] !== null)
      .map(key => [key, existing[key]]));
    if (typeof current.failoverTargets === "string") current.failoverTargets = JSON.parse(current.failoverTargets);
    const merged = baseSchema.parse({ ...current, ...input });
    const group = await updateForwardGroupFromInput(input.id, merged);
    return { success: true, group };
  })))
```

这是路由现有 procedure 链中 `.mutation` 的替换片段，语法检查时接在 `procedure` 标识符后。服务层再次进入本包装能够复用当前修改位置，不会再次排队。

仓库公开的 `createForwardGroup`、任务 3 的非 `skipSync` 成员替换也在最外层使用同一个包装，覆盖绕过网页的调用与新建依赖链。`skipSync` 是保存内部入口，先执行 `assertGroupMemberMutationHeld()`，不得在已经开始保存后才申请这把位置。创建仓库函数在包装内重新核对 `entryGroupId` 指向现存入口组，沿用成员主机存在性校验。统一顺序为：网页同组位置（若有）→ 本包装 → 按编号取得组同步位置 → 数据库保存；反向申请直接拒绝。包装只服务单个面板进程，不宣称支持多个面板同时写同一数据库；没有增加分布式锁。

这样能保证：删除检查通过后若另一请求把主机重新加入组，要么加入先完成、删除重新检查后拒绝，要么删除先完成、加入时按现有“主机不存在”校验拒绝。入口组成员变化与新链创建也依次完成，不会漏掉刚创建的引用链。

- [x] **Step 3b: 提交后的工作失败时，其他清理仍要尝试。**

现有 `dbRuntime.runAfterCommitCallbacks` 遇到第一项错误就停止。不要全局改成忽略错误。给现有 `withDeferredDatabaseCommitCallbacks` 增加可选参数 `{ continueOnError?: boolean }`，默认仍保持原行为；`DeferredCommitCallbacks` 增加同名布尔值，嵌套调用选择 `true` 时提升当前范围，提交回调依次执行并收集错误。核心执行函数如下：

```ts
async function runAfterCommitCallbacks(
  callbacks: Array<() => Promise<void> | void>, continueOnError = false,
) {
  const errors: unknown[] = [];
  for (const callback of callbacks) {
    try { await callback(); }
    catch (error) {
      if (!continueOnError) throw error;
      errors.push(error);
    }
  }
  if (errors.length) throw new AggregateError(errors, "配置已保存，部分提交后处理失败");
}
```

现有包装替换为下面实现；如果保存主体与提交后回调分别失败，保留两者，不能让 `finally` 覆盖原始原因。主体失败且没有成功提交时，不得新增任何回调。类型 `DeferredCommitCallbacks` 同时补充 `continueOnError: boolean`：

```ts
export async function withDeferredDatabaseCommitCallbacks<T>(
  work: () => Promise<T>, options: { continueOnError?: boolean } = {},
): Promise<T> {
  const inherited = deferredCommitCallbacks.getStore();
  if (inherited?.active) {
    if (options.continueOnError) inherited.continueOnError = true;
    return work();
  }
  if (isDatabaseTransactionActive()) throw new Error("Commit callback scope must start before a database transaction");
  const scope: DeferredCommitCallbacks = {
    active: true, callbacks: [], continueOnError: options.continueOnError === true,
  };
  let result!: T;
  let workFailed = false;
  let workError: unknown;
  try { result = await deferredCommitCallbacks.run(scope, work); }
  catch (error) { workFailed = true; workError = error; }
  finally { scope.active = false; }
  try { await runAfterCommitCallbacks(scope.callbacks, scope.continueOnError); }
  catch (error) {
    if (workFailed) throw new AggregateError([workError, error], "保存或提交后处理失败");
    throw error;
  }
  if (workFailed) throw workError;
  return result;
}
```

在 `forwardGroupRepository.ts` 增加下列导出，供本项和任务 3 使用。它在一次自有的回调范围内完成保存，再尝试每项提交后工作；这里的 `afterCommit` 参数用于依次执行隧道刷新、健康／DNS和限速，不能传入数据库成员写入：

```ts
export async function commitForwardGroupMemberChange(
  groupIds: number[], work: () => Promise<void>,
  options: SyncForwardGroupRulesOptions = {},
  afterCommit: Array<() => Promise<unknown>> = [],
): Promise<void> {
  let committed = false;
  const errors: unknown[] = [];
  try {
    await withDeferredDatabaseCommitCallbacks(() =>
      withForwardGroupsSyncTransaction(groupIds, async () => {
        await work();
        await afterDatabaseCommit(() => { committed = true; });
      }, options), { continueOnError: true });
  } catch (error) {
    if (!committed) throw error;
    errors.push(error);
  }
  for (const stage of afterCommit) {
    try { await stage(); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, "配置已保存，部分提交后处理失败");
}
```

本入口由服务层和公共成员替换调用，二者外部没有既有延迟回调范围；不得在批量规则导入的外层回调范围中调用它，导入仍使用保存内部的 `skipSync` 路径。将 `withDeferredDatabaseCommitCallbacks` 补入现有导入；不创建第二套事务工具。

`removeManagedRule` 的结算和刷新分别 `try/catch`，两项都尝试后再将收集到的错误抛出；刷新不能被结算错误跳过。错误保留原文在 `AggregateError.errors`，接口总提示明确“配置已保存”，不能让用户误以为名单已经撤回。入口组多条隧道的提交后刷新也逐条尝试，收集错误后再报告；出口组维持原行为。

```ts
// Replace the body of removeManagedRule's existing afterDatabaseCommit callback.
const errors: unknown[] = [];
try {
  const billed = resource ? await withTrafficBillingUserLock(Number(rule.userId), () =>
    settleTrafficBillingRuleOnDelete({ userId: Number(rule.userId || 0),
      ruleId: Number(rule.id), resourceType: resource.resourceType,
      resourceId: Number(resource.resourceId || 0) })) : null;
  if (billed && Number(billed.balanceAfterCents) < 0) {
    await setUserForwardAccess(Number(rule.userId), false, "traffic_billing_balance");
  }
} catch (error) { errors.push(error); }
try { await refreshRuleEndpoints(rule, "forward-group-child-deleted"); }
catch (error) { errors.push(error); }
if (errors.length) throw new AggregateError(errors, "配置已保存，旧规则清理部分失败");
```

`server/databaseTransaction.test.ts` 增加以下实质检查，使用该文件已有的临时数据库脚本：

```js
const seen = [];
await assert.rejects(() => runtime.withDeferredDatabaseCommitCallbacks(() =>
  runtime.withDatabaseTransaction(async () => {
    await runtime.afterDatabaseCommit(() => { seen.push("first"); throw new Error("first callback failed"); });
    await runtime.afterDatabaseCommit(() => { seen.push("second"); });
  }), { continueOnError: true }), /配置已保存/);
assert.deepEqual(seen, ["first", "second"]);
seen.length = 0;
await assert.rejects(() => runtime.withDeferredDatabaseCommitCallbacks(() =>
  runtime.withDatabaseTransaction(async () => {
    await runtime.afterDatabaseCommit(() => { seen.push("must not run"); });
    throw new Error("save failed");
  }), { continueOnError: true }), /save failed/);
assert.deepEqual(seen, []);
await assert.rejects(() => runtime.withDeferredDatabaseCommitCallbacks(() =>
  runtime.withDatabaseTransaction(async () => {
    await runtime.afterDatabaseCommit(() => { seen.push("first"); throw new Error("default failure"); });
    await runtime.afterDatabaseCommit(() => { seen.push("second"); });
  })), /default failure/);
assert.deepEqual(seen, ["first"], "other callers retain their existing default behavior");
```

- [x] **Step 4: 业务转发组的成员修改共用完整保存过程。**

在服务层中，让普通端口组、主备组和转发链的成员变化使用 `commitForwardGroupMemberChange` 包装现有 `withForwardGroupsSyncTransaction([id], ...)`，再运行健康／DNS。新增分支处理成员和开关同时变化的情况，不能只依赖原来“不改开关”的转发链分支：

```ts
if (hasSniRules && String(existing.groupMode) === "failover"
  && (normalized.data.groupMode !== "failover" || normalized.data.groupType !== "host")) {
  throw new Error("承载 SNI 分流规则的转发组必须保持主机型转发组");
}
if (membersChanged && ["port", "failover", "chain"].includes(normalized.data.groupMode)) {
  await db.commitForwardGroupMemberChange([id], async () => {
    await persistConfiguration({ deferRefresh: true });
    if (enabledChanged) {
      await db.setForwardGroupEnabled(id, desiredEnabled, { skipSync: true });
    }
  }, { preserveRuntime: hasSniRules }, [
    async () => {
      if (normalized.data.groupMode !== "failover") return;
      await db.runForwardGroupFailover(id, {
        manual: true, forcePriority: memberPriorityChanged,
        forceSync: memberPriorityChanged, skipRuleSync: true,
      });
    },
    async () => {
      if (rateLimitChanged && ["port", "failover"].includes(normalized.data.groupMode)) {
        await db.refreshForwardGroupRuntime(id, "forward-group-rate-limit-updated");
      }
    },
  ]);
  return db.getForwardGroupById(id);
}
```

上面先执行原有“不允许承载 SNI 的组改成其他类型”的检查。新增成员分支放在现有 SNI 分支之前，现有 SNI 分支保留给没有成员变化的更新；不能删掉整个旧分支而改变开关、名称更新的行为。成员和限速一起改变时，上面显式执行既有的限速刷新。

- [x] **Step 5: 加入 SNI、离线、禁用与失败撤回检查。**

```ts
test("SNI roots retain ids, targets and saved usage after removing a host", () => {
  runGroupMemberReleaseCase(`
    await seedFailover(3, true);
    const before = await rootSnapshot(10);
    await saveMembers(10, [2]);
    assert.deepEqual(await rootSnapshot(10), before);
    await assertGroupReleased(10, 1, 2);
    assert.equal((await hosts.getHostRuleDeleteBlockers(1)).managedRuleCount, 0);
  `);
});
test("offline and disabled groups do not retain removed template owners", () => {
  runGroupMemberReleaseCase(`
    await seedFailover(1, false, false);
    await runtime.executeRaw('UPDATE hosts SET isOnline=0');
    await saveMembers(10, [2]);
    await assertGroupReleased(10, 1, 2);
    assert.equal((await hosts.getHostRuleDeleteBlockers(1)).managedRuleCount, 0);
  `);
});
test("a template-owner write failure restores members and children", () => {
  runGroupMemberReleaseCase(`
    await seedFailover();
    const before = await runtime.queryRaw('SELECT * FROM forward_rules ORDER BY id');
    await runtime.executeRaw(
      'CREATE TRIGGER reject_owner BEFORE UPDATE OF hostId ON forward_rules ' +
      'WHEN OLD.isForwardGroupTemplate=1 AND NEW.hostId=2 ' +
      "BEGIN SELECT RAISE(ABORT,'injected-owner-write-failure'); END"
    );
    await assert.rejects(() => saveMembers(10, [2]), /injected-owner-write-failure/);
    assert.deepEqual(await runtime.queryRaw('SELECT * FROM forward_rules ORDER BY id'), before);
    assert.deepEqual((await links.getForwardGroupById(10)).members.map(m => m.hostId), [1, 2]);
  `);
});
for (const mode of ["port", "chain"]) {
  test("ordinary member changes release the saved owner in mode=" + mode, () => {
    runGroupMemberReleaseCase(`
      await seedFailover();
      await runtime.executeRaw('UPDATE forward_groups SET groupMode=? WHERE id=10', ["` + mode + `"]);
      if ("` + mode + `" === "port") {
        await runtime.executeRaw('DELETE FROM forward_group_members WHERE hostId=2');
        await saveMembers(10, [2]);
      } else {
        await saveMembers(10, [2, 3], { isEnabled: false });
      }
      await assertGroupReleased(10, 1, 2);
      assert.equal((await hosts.getHostRuleDeleteBlockers(1)).managedRuleCount, 0);
      assert.deepEqual(await runtime.queryRaw(
        'SELECT hostId FROM forward_rules WHERE id=1000'
      ), [{ hostId: 2 }]);
    `);
  });
}
```

任务 4 给出了隧道型组的完整保存样本：入口 1／2、共同出口 3，移除第一条成员后，主规则归属移到第二条隧道入口；第一条独立隧道仍保留并受到删除保护。

```bash
node --import tsx --test server/groupMemberRelease.test.ts server/forwardGroupListeners.test.ts server/forwardGroupToggle.test.ts server/sniForwardGroup.test.ts
```

预期：新增真实保存检查全部通过，原有监听、禁用、SNI 保存与删除检查通过。

- [x] **Step 6: 单独提交本项。**

```bash
git add server/groupMemberMutation.ts server/dbRuntime.ts server/databaseTransaction.test.ts server/repositories/forwardGroupRepository.ts server/services/forwardGroupService.ts server/routers/forwardGroups.ts server/test-support/groupMemberReleaseHarness.ts server/groupMemberRelease.test.ts
git commit -m "fix: release removed forwarding group host references"
```

## Task 3: 入口组删减成员时同步释放所有引用路径

**Files:**

- Modify: `server/repositories/forwardGroupRepository.ts`：`refreshForwardGroupReferences`、依赖链查询。
- Modify: `server/services/forwardGroupService.ts`：入口组成员变更路径。
- Modify: `server/test-support/groupMemberReleaseHarness.ts`
- Test: `server/groupMemberRelease.test.ts`

**Interfaces:**

- Consumes：任务 2 的 `repairForwardGroupTemplateHostsUnlocked`，由组同步自动调用。
- Produces：`getForwardGroupMemberUpdateIds(groupId: number): Promise<number[]>`，返回当前组及其引用链编号，去重并升序排列。
- Consumes：现有 `withForwardGroupsSyncTransaction<T>(groupIds, work, options): Promise<T>`、`refreshForwardGroupReferences(groupId, { previousHostIds, syncDependentChains, reason }): Promise<void>`。
- 测试新增辅助 `seedEntryChain(sni?: boolean): Promise<void>`；入口组 30 使用主机 4／5，链 40 的主机为 1／2，主规则 400 初始归属 4，默认创建普通规则。

- [x] **Step 1: 在辅助的子进程脚本中增加入口组样本，再写真实入口组保存检查。**

```js
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
```

```ts
for (const sni of [false, true]) {
  test("entry group removal transfers chain roots and retires old listeners, SNI=" + sni, () => {
    runGroupMemberReleaseCase(`
    await seedEntryChain(` + sni + `);
    const before = await rootSnapshot(40);
    await saveMembers(30, [5]);
    assert.deepEqual(await rootSnapshot(40), before);
    await assertGroupReleased(40, 4, 5);
    assert.equal((await hosts.getHostRuleDeleteBlockers(4)).managedRuleCount, 0);
    assert.deepEqual(await runtime.queryRaw(
      'SELECT DISTINCT hostId FROM forward_rules WHERE forwardGroupRuleId=400 ' +
      'AND pendingDelete=0 ORDER BY hostId'
    ), [{ hostId: 1 }, { hostId: 2 }, { hostId: 5 }]);
    assert.deepEqual(await runtime.queryRaw(
      'SELECT hostId FROM forward_rules WHERE id=400'
    ), [{ hostId: 5 }]);
    `);
  });
}
```

- [x] **Step 2: 运行，确认旧入口组路径失败。**

```bash
node --import tsx --test --test-name-pattern="entry group removal" server/groupMemberRelease.test.ts
```

预期：任务 2 的同步修正可能已经让简单样本通过；这时不要制造假失败。继续添加本项下一步的“第二条链失败时全部撤回”检查，旧服务层先保存入口组再逐条同步的路径应失败。

- [x] **Step 3: 一次取得入口组和全部引用链，再保存和整理。**

在仓库文件新增导出，使用现有查询工具和模式判断：

```ts
export async function getForwardGroupMemberUpdateIds(groupId: number): Promise<number[]> {
  const group = await getForwardGroupById(groupId);
  if (!group) throw new Error("转发资源不存在");
  if (groupModeOf(group) !== "entry") return [groupId];
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const chains = await db.select({ id: forwardGroups.id }).from(forwardGroups)
    .where(and(
      eq(forwardGroups.groupMode, "chain"),
      eq(forwardGroups.entryGroupId, groupId),
    ));
  return [...new Set([groupId, ...chains.map(row => Number(row.id))])]
    .sort((a, b) => a - b);
}
```

入口组成员变更的服务层分支：

```ts
if (membersChanged && normalized.data.groupMode === "entry") {
  const groupIds = await db.getForwardGroupMemberUpdateIds(id);
  await db.commitForwardGroupMemberChange(groupIds, async () => {
    const currentIds = await db.getForwardGroupMemberUpdateIds(id);
    if (currentIds.join(",") !== groupIds.join(",")) {
      throw new Error("入口组引用发生变化，请刷新后重试");
    }
    await persistConfiguration({ deferRefresh: true });
    if (enabledChanged) {
      await db.setForwardGroupEnabled(id, desiredEnabled, { skipSync: true });
    }
  }, {}, [
    () => db.refreshForwardGroupReferences(id, {
      reason: "entry-group-members-updated", previousHostIds, syncDependentChains: false,
    }),
    () => db.runForwardGroupFailover(id, {
      manual: true, forceSync: true, skipRuleSync: true,
    }),
  ]);
  return db.getForwardGroupById(id);
}
```

这段顺序使隧道的新旧入口刷新发生在 DNS 调用之前。`refreshTunnelsUsingForwardGroup` 继续将 `previousHostIds` 和当前成员一起通知，旧入口也能收到撤除配置的机会。不要更改独立的 `tunnels.entryHostId`、中继、出口或其他组。

入口组的旧入口副本挂在“转发链第一跳成员”名下，仅删除入口组成员不会自动找到这些副本。现有禁用分支又会在清理旧路径之前返回。因此在 `syncForwardGroupRulesUnlocked` 读取主规则后、检查 `runtimeDependenciesEnabled` 之前加入下列检查，只根据最新配置撤除已经不存在的路径；组被禁用时也执行。随后保留既有有效路径生成和运行状态处理。

```ts
if (groupMode === "chain") {
  const configuredKeys = new Set<string>();
  const configuredEntry = Number(group.entryGroupId || 0) > 0
    ? await getForwardGroupById(Number(group.entryGroupId)) : null;
  const entryHosts = configuredEntry && groupModeOf(configuredEntry) === "entry"
    ? sortedMembers(configuredEntry).filter((member: any) => member.memberType === "host")
    : [];
  const firstMember = members.find(member => dbBool(member.isEnabled)) || members[0];
  for (const template of templates as any[]) {
    for (const member of members) {
      const hostId = await memberEntryHostId(member);
      if (hostId > 0) configuredKeys.add(`${template.id}:${member.id}:${hostId}`);
    }
    if (firstMember) for (const entry of entryHosts) {
      const hostId = Number(entry.hostId || 0);
      if (hostId > 0) configuredKeys.add(`${template.id}:${firstMember.id}:${hostId}`);
    }
  }
  for (const child of await getForwardGroupChildRules(groupId) as any[]) {
    if (dbBool(child.pendingDelete)) continue;
    const key = `${child.forwardGroupRuleId}:${child.forwardGroupMemberId}:${child.hostId}`;
    if (!configuredKeys.has(key)) {
      await removeManagedRule(Number(child.id), options);
    }
  }
}
```

这里保留尚在配置中的禁用成员，后续既有逻辑负责停用；这一步只解决已移除路径在提前返回前漏清理的问题。清理继续使用 `removeManagedRule`，沿用提交后结算和刷新。

成员和入口组开关一起保存时，现有 `setForwardGroupEnabled(..., { skipSync: true })` 还会调用 `refreshControlledTunnelRuntime`。该函数的数据库更新继续留在保存中；移除函数开头的 `clearTunnelRuntimeStatus(tunnelId)`，并把末尾通知改为下列提交后处理，防止第二条链失败时提前清掉隧道状态或发出撤除通知：

```ts
await afterDatabaseCommit(() => {
  clearTunnelRuntimeStatus(tunnelId);
  for (const hostId of hostIds) {
    pushAgentRefresh(hostId, `${reason}-tunnel-${tunnelId}`, { urgent: true });
  }
});
```

现有 `refreshControlledForwardRules` 已经使用同样的提交后处理，无需重复增加一层。

底层 `replaceForwardGroupMembers` 不带 `skipSync` 的直接调用也必须走同样的“取全部组 → 保存成员 → 统一整理 → 提交后刷新”过程，不能只修网页调用。做法是把现有逐项成员写入提成私有 `replaceForwardGroupMembersUnlocked`；公共函数在成员修改位置内、数据库保存外取得 `getForwardGroupMemberUpdateIds` 并调用 `commitForwardGroupMemberChange`，保存内部已有调用使用 `skipSync: true, deferRefresh: true`。函数参数和返回值保持不变。公共函数在已经开始数据库保存且未要求 `skipSync` 时明确报错，沿用现有组同步的调用顺序约束。

```ts
export async function replaceForwardGroupMembers(
  groupId: number,
  members: ForwardGroupMemberInput[],
  options: { skipSync?: boolean; deferRefresh?: boolean } = {},
): Promise<void> {
  if (options.skipSync) {
    assertGroupMemberMutationHeld();
    return replaceForwardGroupMembersUnlocked(groupId, members, options);
  }
  return withGroupMemberMutation(() => replaceForwardGroupMembersWithSync(groupId, members));
}
async function replaceForwardGroupMembersWithSync(
  groupId: number, members: ForwardGroupMemberInput[],
): Promise<void> {
  if (isDatabaseTransactionActive()) {
    throw new Error("成员更新必须在数据库保存前取得组保存位置");
  }
  const groupIds = await getForwardGroupMemberUpdateIds(groupId);
  let previousHostIds: number[] = [];
  let mode = "";
  await commitForwardGroupMemberChange(groupIds, async () => {
    const latestIds = await getForwardGroupMemberUpdateIds(groupId);
    if (latestIds.join(",") !== groupIds.join(",")) {
      throw new Error("入口组引用发生变化，请刷新后重试");
    }
    const group = await getForwardGroupById(groupId);
    mode = groupModeOf(group);
    previousHostIds = await groupHostIds(groupId);
    await replaceForwardGroupMembersUnlocked(groupId, members, {
      skipSync: true, deferRefresh: true,
    });
  }, {}, [async () => {
    if (mode === "entry") await refreshForwardGroupReferences(groupId, {
      reason: "entry-group-members-updated", previousHostIds,
      syncDependentChains: false,
    });
    else if (mode === "exit") await runForwardGroupFailover(groupId, { forceSync: true, manual: true });
  }, async () => {
    if (mode === "entry") await runForwardGroupFailover(groupId, {
      forceSync: true, manual: true, skipRuleSync: true,
    });
    else if (mode === "exit") await refreshForwardGroupReferences(groupId, {
      reason: "exit-group-members-updated", previousHostIds,
    });
  }]);
}
```

私有 `replaceForwardGroupMembersUnlocked` 保留原函数的参数、成员校验和逐项写入，包含任务 2 的活动成员清除；删除其末尾从 `if (options.skipSync) return` 开始的同步／DNS 分支，固定返回 `Promise<void>`，交由公共包装统一处理。入口组的集合变化在保存中再次核对，不一致时整次撤回并提示用户刷新重试。出口组沿用既有提交后顺序，不改选路政策。不得在数据库保存内部调用 `syncForwardGroupRules` 或访问外部 DNS。

- [x] **Step 4: 检查多条引用链、禁用组、保留副本和全部撤回。**

```ts
for (const injectFailure of [false, true]) {
  test("entry update handles two chains, injected failure=" + injectFailure, () => {
    runGroupMemberReleaseCase(`
    await seedEntryChain();
    await insert("forward_groups", {
      id: 41, name: "second-chain", groupType: "host", groupMode: "chain",
      entryGroupId: 30, forwardType: "iptables", targetIp: "0.0.0.0",
      userId: 1, isEnabled: 1,
    });
    await insert("forward_group_members", {
      id: 410, groupId: 41, memberType: "host", hostId: 3, priority: 0, isEnabled: 1,
    });
    await insert("forward_rules", {
      id: 4100, hostId: 4, name: "second-root", forwardType: "iptables",
      protocol: "tcp", forwardGroupId: 41, isForwardGroupTemplate: 1,
      sourcePort: 43005, targetIp: "192.0.2.91", targetPort: 8443,
      userId: 1, isEnabled: 1,
    });
    await links.syncForwardGroupRules(41);
    await insert("tunnels", {
      id: 70, name: "affected-tunnel", entryHostId: 6, exitHostId: 3,
      entryGroupId: 30, mode: "tls", listenPort: 25070, userId: 1, isEnabled: 1,
    });
    const before = await runtime.queryRaw('SELECT * FROM forward_rules ORDER BY id');
    const tunnelsBefore = await runtime.queryRaw('SELECT * FROM tunnels ORDER BY id');
    const frames = captureAgentFrames([1, 2, 3, 4, 5, 6]);
    tunnelState.recordTunnelRuntimeHostStatus(70, 4, true);
    const generationBefore = tunnelState.getTunnelRuntimeGeneration(70);
    const framesBefore = frames();
    if (` + injectFailure + `) {
      await runtime.executeRaw(
        'CREATE TRIGGER reject_second_chain BEFORE UPDATE OF hostId ON forward_rules ' +
        'WHEN OLD.id=4100 AND NEW.hostId=5 ' +
        "BEGIN SELECT RAISE(ABORT,'injected-second-chain-failure'); END"
      );
      await assert.rejects(() => saveMembers(30, [5], { isEnabled: false }), /injected-second-chain-failure/);
      assert.deepEqual(await runtime.queryRaw('SELECT * FROM forward_rules ORDER BY id'), before);
      assert.deepEqual(await runtime.queryRaw('SELECT * FROM tunnels ORDER BY id'), tunnelsBefore);
      assert.deepEqual((await links.getForwardGroupById(30)).members.map(m => m.hostId), [4, 5]);
      assert.equal(tunnelState.getTunnelRuntimeHostStatus(70, 4), true);
      assert.equal(tunnelState.getTunnelRuntimeGeneration(70), generationBefore);
      assert.deepEqual(frames(), framesBefore, 'rollback must not notify old or retained hosts');
    } else {
      const saved = [await rootSnapshot(40), await rootSnapshot(41)];
      await saveMembers(30, [5]);
      assert.deepEqual([await rootSnapshot(40), await rootSnapshot(41)], saved);
      assert.deepEqual(await runtime.queryRaw(
        'SELECT hostId FROM forward_rules WHERE id IN (400,4100) ORDER BY id'
      ), [{ hostId: 5 }, { hostId: 5 }]);
      await assertGroupReleased(40, 4, 5);
      await assertGroupReleased(41, 4, 5);
      assert.ok(frames().find(([id]) => id === 4)[1].length > framesBefore.find(([id]) => id === 4)[1].length);
      assert.equal((await hosts.getHostRuleDeleteBlockers(4)).managedRuleCount, 0);
    }
    `);
  });
}
test("disabled entry group still releases a removed configured owner", () => {
  runGroupMemberReleaseCase(`
    await seedEntryChain();
    await saveMembers(30, [5], { isEnabled: false });
    await assertGroupReleased(40, 4, 5);
    assert.equal((await hosts.getHostRuleDeleteBlockers(4)).managedRuleCount, 0);
    assert.deepEqual(await runtime.queryRaw(
      'SELECT hostId FROM forward_rules WHERE id=400'
    ), [{ hostId: 5 }]);
  `);
});
```

失败样本必须先确认 `generationBefore`、旧入口 ready 状态和通知流都已经建立，避免检查空状态而误通过。另在任务 2 的主规则写入失败样本使用同一通知捕获辅助，断言 `frames()` 与失败前完全一致。

提交后某条隧道刷新失败，也必须尝试后面的隧道。为 `refreshTunnelsUsingForwardGroup` 的入口组分支增加错误收集；将当前循环主体提为内部 `refreshOneTunnel(tunnel)` 闭包，保留出口组选路原逻辑，循环改为：

```ts
const refreshOneTunnel = async (tunnel: any): Promise<void> => {
  if (exitStrategy && group && hasEnabledExitMember) {
    const synced = await syncTunnelExitGroupEndpoints(tunnel, exitMembers, exitStrategy);
    Object.assign(tunnel, synced.tunnel);
  } else if (exitStrategy && dbBool(group?.isEnabled)) {
    throw new Error("Enabled exit group must contain at least one enabled host");
  }
  await refreshControlledTunnelRuntime(tunnel, reason, {
    resetRules: true, extraHostIds: referencedHostIds,
  });
};
const errors: unknown[] = [];
for (const tunnel of affectedTunnels) {
  try { await refreshOneTunnel(tunnel); }
  catch (error) {
    if (groupMode !== "entry") throw error;
    errors.push(error);
  }
}
if (errors.length) throw new AggregateError(errors, "配置已保存，部分提交后处理失败");
```

真实故障检查：在入口组样本再建隧道 71，让隧道 70 更新失败，确认 71 仍收到刷新；移除故障后再次显式刷新，70 的配置也能恢复。不得声称数据库提交后的错误可以把已经成功保存的成员撤回：

```ts
test("one post-commit tunnel failure does not prevent other tunnel refreshes", () => {
  runGroupMemberReleaseCase(`
    await seedEntryChain();
    for (const id of [70, 71]) await insert("tunnels", {
      id, name: "affected-" + id, entryHostId: 6, exitHostId: 3,
      entryGroupId: 30, mode: "tls", listenPort: 25000 + id, userId: 1, isEnabled: 1,
    });
    const frames = captureAgentFrames([4, 5, 6]);
    const before = frames();
    await runtime.executeRaw(
      'CREATE TRIGGER reject_tunnel_refresh BEFORE UPDATE ON tunnels WHEN OLD.id=70 ' +
      "BEGIN SELECT RAISE(ABORT,'injected-tunnel-refresh-failure'); END"
    );
    await assert.rejects(() => saveMembers(30, [5]), /配置已保存/);
    await assertGroupReleased(40, 4, 5);
    assert.deepEqual((await links.getForwardGroupById(30)).members.map(m => m.hostId), [5]);
    assert.ok(frames().find(([id]) => id === 6)[1].length > before.find(([id]) => id === 6)[1].length);
    await runtime.executeRaw('DROP TRIGGER reject_tunnel_refresh');
    await links.refreshForwardGroupReferences(30, { previousHostIds: [4, 5], syncDependentChains: false });
    assert.ok(tunnelState.getTunnelRuntimeGeneration(70) > 0);
  `);
});
```

以下场景检查剩余成员全部禁用、旧主机离线，以及直接调用仓库保存的路径。独立隧道的明确保护检查在任务 4 给出。

```ts
for (const directCall of [false, true]) {
  test("entry release uses configured disabled hosts, direct=" + directCall, () => {
    runGroupMemberReleaseCase(`
      await seedEntryChain();
      await runtime.executeRaw('UPDATE hosts SET isOnline=0');
      const members = [{ memberType: "host", hostId: 5, priority: 0, isEnabled: false }];
      if (` + directCall + `) await links.replaceForwardGroupMembers(30, members);
      else await saveMembers(30, [5], { members });
      await assertGroupReleased(40, 4, 5);
      assert.equal((await hosts.getHostRuleDeleteBlockers(4)).managedRuleCount, 0);
      assert.deepEqual(await runtime.queryRaw(
        'SELECT hostId FROM forward_rules WHERE id=400'
      ), [{ hostId: 5 }]);
      assert.equal(Boolean((await links.getForwardGroupById(30)).members[0].isEnabled), false);
    `);
  });
}
```

```bash
node --import tsx --test server/groupMemberRelease.test.ts server/forwardGroupListeners.test.ts server/tunnelEndpointRefresh.test.ts server/tunnelRuntimePlan.test.ts
```

- [x] **Step 5: 单独提交本项。**

```bash
git add server/repositories/forwardGroupRepository.ts server/services/forwardGroupService.ts server/test-support/groupMemberReleaseHarness.ts server/groupMemberRelease.test.ts
git commit -m "fix: release removed entry group hosts across dependent chains"
```

## Task 4: 修正历史遗留引用，并保留真实使用关系的删除保护

**Files:**

- Modify: `server/repositories/forwardGroupRepository.ts`、`server/repositories/hostRepository.ts`、`server/repositories/tokenRepository.ts`
- Modify: `server/routers/hosts.ts`、`server/routers/agentTokens.ts`
- Modify: `client/src/i18n/en.json`
- Test: `server/groupMemberRelease.test.ts`、`server/portForwardRuleHosts.test.ts`、`server/forwardGroupRuleIntegrity.test.ts`

**Interfaces:**

- Consumes：任务 2 的内部归属修正，任务 3 的受影响组编号查询，以及现有 `withForwardGroupSyncLocks`、`withDatabaseTransaction`。
- Produces：`repairForwardGroupTemplateHostReferences(options?: { hostId?: number; groupIds?: number[] }): Promise<TemplateHostRepair[]>`，在数据库保存外调用；修正主规则归属并清空已不存在的活动成员编号，不运行 DNS、健康检查或整组端口分配。
- Produces：`getHostLinkDeleteBlockers(hostId: number): Promise<{ groupCount: number; tunnelCount: number }>`，统计当前组成员关系和去重后的独立隧道关系。
- Produces：只读 `readHostRuleDeleteBlockers(hostId: number)`（返回类型与现有删除检查一致）、`assertHostHasNoForwardingReferences(hostId: number): Promise<void>`、`getAgentTokenAffectedHostIds(token: { hostId?: number | null; token?: string | null }): Promise<number[]>`。
- 不改变 `getHostRuleDeleteBlockers` 返回字段及 `pendingCleanupCount` 的含义。

- [x] **Step 1: 先检查旧数据，要求实际删除后规则仍在。**

```ts
test("historic failover references are repaired before real host deletion", () => {
  runGroupMemberReleaseCase(`
    await seedFailover(44);
    const before = await rootSnapshot(10);
    await runtime.executeRaw('DELETE FROM forward_group_members WHERE hostId=1');
    await hostCaller.delete({ id: 1 });
    assert.deepEqual(await rootSnapshot(10), before);
    assert.equal((await runtime.queryRaw('SELECT id FROM hosts WHERE id=1')).length, 0);
    assert.deepEqual(await runtime.queryRaw(
      'SELECT DISTINCT hostId FROM forward_rules WHERE forwardGroupId=10 ' +
      'AND isForwardGroupTemplate=1'
    ), [{ hostId: 2 }]);
  `);
});
test("removing an entry-group membership does not remove a standalone tunnel entry", () => {
  runGroupMemberReleaseCase(`
    await seedEntryChain();
    await insert("tunnels", {
      id: 70, name: "independent-entry", entryHostId: 4, exitHostId: 6,
      entryGroupId: 30, mode: "tls", listenPort: 25000,
      userId: 1, isEnabled: 1,
    });
    await saveMembers(30, [5]);
    await assertGroupReleased(40, 4, 5);
    assert.equal((await hosts.getHostRuleDeleteBlockers(4)).managedRuleCount, 0);
    await assert.rejects(() => hostCaller.delete({ id: 4 }), /隧道|引用|使用/);
    assert.equal((await runtime.queryRaw('SELECT entryHostId FROM tunnels WHERE id=70'))[0].entryHostId, 4);
    assert.equal((await runtime.queryRaw('SELECT id FROM hosts WHERE id=4')).length, 1);
  `);
});
```

第一项旧代码会报 44 条引用。第二项在缺少结构引用保护时可能错误删除主机，因此必须先断言拒绝，再确认主机和隧道仍在。

- [x] **Step 2: 添加只修归属的外部入口。**

先查 `forward_rules` 中未删除的主规则，按可选 `hostId`／`groupIds` 缩小范围；取得它们所在组以及外部入口组的编号。按升序取得这些组的保存位置，再开始一次数据库保存，重新查询并调用任务 2 的内部修正。第二次读取出现未锁住的入口组或链时，结束本次保存并在外层重试；最多 3 次，仍持续改变则提示刷新重试，不边保存边申请更多组。

保存顺序的代码形态为：

```ts
export async function repairForwardGroupTemplateHostReferences(
  options: { hostId?: number; groupIds?: number[] } = {},
): Promise<TemplateHostRepair[]> {
  if (isDatabaseTransactionActive()) {
    throw new Error("主规则归属修正必须在数据库保存前取得组保存位置");
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const lockIds = await getTemplateReferenceRepairGroupIds(options);
    try {
      return await withForwardGroupSyncLocks(lockIds, () =>
        withDatabaseTransaction(async () => {
          const latestGroupIds = await getTemplateReferenceRepairGroupIds(options);
          if (latestGroupIds.some(id => !lockIds.includes(id))) {
            throw new TemplateReferenceScopeChangedError();
          }
          const repairs: TemplateHostRepair[] = [];
          for (const id of lockIds) {
            repairs.push(...await repairForwardGroupTemplateHostsUnlocked(id));
          }
          return repairs;
        }));
    } catch (error) {
      if (!(error instanceof TemplateReferenceScopeChangedError)) throw error;
      if (attempt === 2) throw new Error("组成员持续变化，请刷新后重试");
    }
  }
  throw new Error("组成员持续变化，请刷新后重试");
}
```

本段需要的两个新名字在同一仓库文件定义，不能作为未提供的外部方法引用：

```ts
class TemplateReferenceScopeChangedError extends Error {}
async function getTemplateReferenceRepairGroupIds(
  options: { hostId?: number; groupIds?: number[] } = {},
): Promise<number[]> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const conditions = [
    eq(forwardRules.isForwardGroupTemplate, true),
    eq(forwardRules.pendingDelete, false),
  ];
  if (options.hostId !== undefined) conditions.push(eq(forwardRules.hostId, options.hostId));
  if (options.groupIds !== undefined) {
    if (options.groupIds.length === 0) return [];
    conditions.push(inArray(forwardRules.forwardGroupId, options.groupIds));
  }
  const rows = await db.select({
    id: forwardGroups.id, entryGroupId: forwardGroups.entryGroupId,
  }).from(forwardRules).innerJoin(
    forwardGroups, eq(forwardRules.forwardGroupId, forwardGroups.id),
  ).where(and(...conditions));
  return [...new Set(rows.flatMap(row => [
    Number(row.id), Number(row.entryGroupId || 0),
  ]).filter(id => Number.isInteger(id) && id > 0))].sort((a, b) => a - b);
}
```

`lockIds` 包含主规则所属组和外部入口组编号。循环修正主规则归属和失效活动成员编号；入口组自身不持有主规则，因此返回空列表，不调用整组同步。只捕获 `TemplateReferenceScopeChangedError` 执行外层重试；数据库失败和权限失败保留真实错误。候选不存在时保留原归属和删除阻拦，不将规则标记删除。

在 `getHostRuleDeleteBlockers` 开头，替换原来仅针对普通端口转发的修正调用：

```ts
const { repairForwardGroupTemplateHostReferences } =
  await import("./forwardGroupRepository");
await repairForwardGroupTemplateHostReferences({ hostId });
await repairForwardGroupRuleIntegrity(hostId);
```

`deleteHost` 原有全局普通端口归属修正也改为针对本主机调用这一个入口，并按下面 Step 3a 区分保存外的历史修正和保存内的最终检查。用动态导入避免新增仓库文件间的顶层初始化循环。已有孤立副本修正和待清理释放继续执行。

- [x] **Step 3: 增加真实组成员和隧道关系的检查。**

在 `hostRepository.ts` 定义 `getHostLinkDeleteBlockers`。组成员不因被禁用就消失；隧道编号通过 `UNION` 去重；组、隧道已不存在的孤立记录不计数：

```ts
export async function getHostLinkDeleteBlockers(
  hostId: number,
): Promise<{ groupCount: number; tunnelCount: number }> {
  const q = quoteIdentifier;
  const [groups, tunnels] = await Promise.all([
    queryRaw<{ count: unknown }>(
      "SELECT COUNT(DISTINCT m." + q("groupId") + ") AS " + q("count") +
      " FROM " + q("forward_group_members") + " m" +
      " INNER JOIN " + q("forward_groups") + " g ON g." + q("id") + "=m." + q("groupId") +
      " WHERE m." + q("memberType") + "=? AND m." + q("hostId") + "=?",
      ["host", hostId],
    ),
    queryRaw<{ count: unknown }>(
      "SELECT COUNT(*) AS " + q("count") + " FROM (" +
      " SELECT t." + q("id") + " AS " + q("tunnelId") +
      " FROM " + q("tunnels") + " t WHERE t." + q("entryHostId") + "=?" +
      " OR t." + q("exitHostId") + "=?" +
      " UNION SELECT h." + q("tunnelId") +
      " FROM " + q("tunnel_hops") + " h" +
      " INNER JOIN " + q("tunnels") + " t ON t." + q("id") + "=h." + q("tunnelId") +
      " WHERE h." + q("hostId") + "=?" +
      " UNION SELECT e." + q("tunnelId") +
      " FROM " + q("tunnel_exit_nodes") + " e" +
      " INNER JOIN " + q("tunnels") + " t ON t." + q("id") + "=e." + q("tunnelId") +
      " WHERE e." + q("hostId") + "=?" +
      " UNION SELECT x." + q("tunnelId") +
      " FROM " + q("forward_rule_tunnel_exits") + " x" +
      " INNER JOIN " + q("tunnels") + " t ON t." + q("id") + "=x." + q("tunnelId") +
      " INNER JOIN " + q("forward_rules") + " r ON r." + q("id") + "=x." + q("ruleId") +
      " WHERE x." + q("exitHostId") + "=? AND r." + q("pendingDelete") + "=?" +
      ") " + q("linked_tunnels"),
      [hostId, hostId, hostId, hostId, hostId, boolValue(false)],
    ),
  ]);
  return {
    groupCount: Number(groups[0]?.count || 0),
    tunnelCount: Number(tunnels[0]?.count || 0),
  };
}
```

`hostRepository.ts` 已有 `quoteIdentifier` 和 `queryRaw`；这一查询沿用现有兼容工具，不访问真实外部服务。

`hosts.delete` 和 `agentTokens.delete` 在任何清理、删除动作前，调用上面的结构检查；组规则的旧错误提示仍通过现有规则检查返回：

```ts
const links = await db.getHostLinkDeleteBlockers(hostId);
if (links.groupCount > 0) {
  throw new Error("该主机仍是转发组或入口组的成员，请先从组中移除");
}
if (links.tunnelCount > 0) {
  throw new Error("该主机仍被隧道的独立入口、中继或出口使用，请先移除对应引用");
}
```

`hostId` 在主机接口使用 `input.id`，在 Token 接口使用下文列出的全部受影响主机编号。保留原有权限检查和用户归属保护；修正 Token 只查第一台主机的问题，不能保留这一遗漏。不给普通用户展示其他人的资源名称。规则单独选择的隧道出口也算真实用途；上面的最后一段查询通过现存规则、现存隧道过滤孤立记录。

新增的两种提示使用固定原文，直接进入现有翻译目录；不引入新的动态错误解析：

```json
{
  "该主机仍是转发组或入口组的成员，请先从组中移除":
    "This host is still a member of a forwarding or entry group. Remove it from the group first.",
  "该主机仍被隧道的独立入口、中继或出口使用，请先移除对应引用":
    "This host is still used as a tunnel's independent entry, relay or exit. Remove these references first."
}
```

现有页面的 `translateNotificationText` 会按固定原文查目录，无需修改翻译函数。

- [x] **Step 3a: 真正删除前再检查，拒绝时全部保持原样。**

将 `getHostRuleDeleteBlockers` 中修正之后的查询和返回部分，原样提取为导出 `readHostRuleDeleteBlockers(hostId: number)`；这个新函数只读取，不修正。原公开函数在保存外执行修正后返回只读函数结果，原返回结构不变。最终删除必须使用只读函数，避免在已开始的数据库保存中重新申请组同步位置。

```ts
export async function assertHostHasNoForwardingReferences(hostId: number): Promise<void> {
  const [rules, links] = await Promise.all([
    readHostRuleDeleteBlockers(hostId), getHostLinkDeleteBlockers(hostId),
  ]);
  if (rules.ruleCount || rules.managedRuleCount || links.groupCount || links.tunnelCount) {
    throw new Error("主机引用已变化，请刷新后重试");
  }
}
```

把 `deleteHost` 原先实际删记录的部分提为私有 `deleteHostRowsUnlocked(id: number): Promise<void>`。它要求本轮成员修改位置与数据库保存均已取得，并先执行上述最终检查。业务规则删除语句必须限定为已经标记删除的记录：

```ts
await db.delete(forwardRules).where(and(
  eq(forwardRules.hostId, id), eq(forwardRules.pendingDelete, true),
));
```

**禁止保留旧的“按 hostId 删除全部规则”语句。** 权限、指标、Token 等原有清理留在同一次数据库保存中；删除主机后的 `removePresenceCapableHost`、认证缓存失效和连接池刷新放到 `afterDatabaseCommit`。审计记录随数据库保存一起成功或撤回。主机路由不再先调用 `deleteHostPermissions`，权限清理由仓库统一完成。

```ts
export async function deleteHost(id: number): Promise<void> {
  return withGroupMemberMutation(async () => {
    const { repairForwardGroupTemplateHostReferences } = await import("./forwardGroupRepository");
    await repairForwardGroupTemplateHostReferences({ hostId: id });
    await repairForwardGroupRuleIntegrity(id);
    await withDatabaseTransaction(() => deleteHostRowsUnlocked(id));
  });
}
```

`hosts.delete` 在首次权限判断之后，使用 `withGroupMemberMutation` 包住“重新读取主机与权限 → 原有详细引用提示 → 仓库删除”全过程。待清理释放也移进最终保存；拒绝删除不能提前停掉待清理记录、删除权限或清 Token。

同一事务不是任意写入者的通用排他保护，因此最终删除 `hosts` 时还要使用带条件的删除，拒绝最后一刻新出现的有效规则和真实组／隧道关系。以下片段用于替换原 `db.delete(hosts)`，参数严格按顺序绑定；失败抛错会撤回之前的所有附属清理：

```ts
const q = quoteIdentifier;
const result = await executeRaw(
  "DELETE FROM " + q("hosts") + " WHERE " + q("id") + "=?" +
  " AND NOT EXISTS (SELECT 1 FROM " + q("forward_rules") + " r WHERE r." + q("hostId") +
    "=? AND r." + q("pendingDelete") + "=?)" +
  " AND NOT EXISTS (SELECT 1 FROM " + q("forward_group_members") + " m JOIN " +
    q("forward_groups") + " g ON g." + q("id") + "=m." + q("groupId") +
    " WHERE m." + q("memberType") + "=? AND m." + q("hostId") + "=?)" +
  " AND NOT EXISTS (SELECT 1 FROM " + q("tunnels") + " t WHERE t." + q("entryHostId") +
    "=? OR t." + q("exitHostId") + "=?)" +
  " AND NOT EXISTS (SELECT 1 FROM " + q("tunnel_hops") + " h JOIN " + q("tunnels") +
    " t ON t." + q("id") + "=h." + q("tunnelId") + " WHERE h." + q("hostId") + "=?)" +
  " AND NOT EXISTS (SELECT 1 FROM " + q("tunnel_exit_nodes") + " e JOIN " + q("tunnels") +
    " t ON t." + q("id") + "=e." + q("tunnelId") + " WHERE e." + q("hostId") + "=?)" +
  " AND NOT EXISTS (SELECT 1 FROM " + q("forward_rule_tunnel_exits") + " x JOIN " +
    q("forward_rules") + " r ON r." + q("id") + "=x." + q("ruleId") + " JOIN " +
    q("tunnels") + " t ON t." + q("id") + "=x." + q("tunnelId") +
    " WHERE x." + q("exitHostId") + "=? AND r." + q("pendingDelete") + "=?)",
  [id, id, boolValue(false), "host", id, id, id, id, id, id, boolValue(false)],
);
if (rawAffectedRows(result) !== 1) throw new Error("主机引用已变化，请刷新后重试");
```

这条删除语句必须位于 `forward_rule_tunnel_exits` 清理之前，否则可能先删掉真实用途再检查。只清理关联已删除规则的出口记录；有效规则的出口选择不得删掉。并发新增普通规则时也不能因删除主机而丢失业务规则。本保护不代替其他资源创建时已有的主机存在性校验。

`hostHasLiveReferences` 改用同一组只读规则判断和 `getHostLinkDeleteBlockers`，删除原先四套未过滤孤立记录的组／隧道计数；**保留套餐绑定和其他 Token 的额外保护**。`deleteHostIfUnreferenced`、`purgeOrphanedAgentHosts` 都使用这一判断。`deleteHostIfUnreferenced` 在保存外先取得成员修改位置并修正历史，再开始保存；若调用方已在同一次保存中，先 `assertGroupMemberMutationHeld()`，只执行最终只读检查及私有删除，不再修正或申请位置。

```ts
async function hostHasLiveReferences(hostId: number): Promise<boolean> {
  const db = await getDb();
  if (!db) return true;
  const [rules, links, plans, tokens] = await Promise.all([
    readHostRuleDeleteBlockers(hostId), getHostLinkDeleteBlockers(hostId),
    db.select({ count: sqlCountAll() }).from(subscriptionPlanHosts)
      .where(eq(subscriptionPlanHosts.hostId, hostId)),
    db.select({ count: sqlCountAll() }).from(agentTokens)
      .where(eq(agentTokens.hostId, hostId)),
  ]);
  return Boolean(rules.ruleCount || rules.managedRuleCount || links.groupCount || links.tunnelCount
    || Number(plans[0]?.count || 0) || Number(tokens[0]?.count || 0));
}
```

人工直接删除主机仍沿用现有套餐等附属记录清理政策；Token 删除后的自动清理继续额外保留套餐／其他 Token，不借本次修复放宽。该差别是既有产品行为，规则、组和隧道的保护则必须一致。

- [x] **Step 3b: Token 查全受影响主机，先全部检查再一次保存。**

Token 删除不能使用只返回一台主机的 `getHostByAgentToken`。在主机仓库新增以下内部查询；不要修改原认证查询的含义：

```ts
export async function getAgentTokenAffectedHostIds(
  token: { hostId?: number | null; token?: string | null },
): Promise<number[]> {
  const q = quoteIdentifier;
  const rows = token.token ? await queryRaw<{ id: number }>(
    "SELECT " + q("id") + " FROM " + q("hosts") + " WHERE " + q("agentToken") + "=?",
    [token.token],
  ) : [];
  return [...new Set([Number(token.hostId || 0), ...rows.map(row => Number(row.id))])]
    .filter(id => Number.isInteger(id) && id > 0).sort((a, b) => a - b);
}
```

Token 路由的顺序固定为：

1. 读取 Token 并检查操作者权限。此时不得调用会修正数据的删除检查。
2. 在 `withGroupMemberMutation` 内重新读取 Token 并再核对权限，读取全部受影响主机。普通用户不能通过自己的 Token 清除另一用户主机的绑定。
3. 对所有主机完成历史修正和原有详细引用检查，**此轮只检查，不释放待清理、不改绑定、不删除任何 Token**。
4. 一次 `withDatabaseTransaction` 内重读 Token 和全部主机编号，Token 值、归属用户、`hostId` 或集合变化则抛出“主机引用已变化，请刷新后重试”；逐台调用只读最终检查。
5. 全部通过后才释放待清理、调用 `deleteAgentToken`，然后逐台 `deleteHostIfUnreferenced`。若后面一台失败，整次撤回，前面主机的权限、Token 绑定和在线标记也恢复。

`tokenRepository.deleteAgentToken` 的认证缓存失效改为 `afterDatabaseCommit`，数据库清空绑定和删除 Token 都沿用外层保存。主机删除和 Token 删除不允许在检查循环中穿插清理动作。

反向也要保护：`deleteHostRowsUnlocked` 原来按 `agent_tokens.hostId` 删除 Token。若 Token 记录指向待删主机 1，但另一台主机 2 仍实际使用这枚 Token，删除主机 1 不能注销主机 2。将原先整批删除关联 Token 的语句替换为逐条判断；还有其他绑定主机时，只清空这枚 Token 的旧 `hostId` 关联，保留 Token 和其他主机的绑定：

```ts
const associatedTokens = await db.select().from(agentTokens).where(eq(agentTokens.hostId, id));
for (const token of associatedTokens) {
  const otherHosts = await db.select({ id: hosts.id }).from(hosts).where(and(
    eq(hosts.agentToken, token.token), sql`${hosts.id} <> ${id}`,
  )).limit(1);
  if (otherHosts.length) {
    await db.update(agentTokens).set({ hostId: null }).where(eq(agentTokens.id, token.id));
  } else {
    await db.delete(agentTokens).where(eq(agentTokens.id, token.id));
  }
}
```

固定提示补入英文目录，提交后错误保留明细在服务端记录：

```json
{
  "主机引用已变化，请刷新后重试": "Host references changed. Refresh and try again.",
  "配置已保存，部分提交后处理失败": "The configuration was saved, but some follow-up operations failed."
}
```

- [x] **Step 4: 补上正常删除、仍有真实用途、重复修复和 Token 场景。**

```ts
test("a host with another ordinary rule remains protected", () => {
  runGroupMemberReleaseCase(`
    await seedFailover();
    await saveMembers(10, [2]);
    await insert("forward_rules", {
      id: 9000, hostId: 1, userId: 1, name: "independent-rule",
      sourcePort: 29000, targetIp: "192.0.2.90", targetPort: 80,
      forwardType: "iptables", protocol: "tcp", isEnabled: 1,
    });
    await assert.rejects(() => hostCaller.delete({ id: 1 }), /转发规则/);
    assert.equal((await runtime.queryRaw('SELECT id FROM forward_rules WHERE id=9000')).length, 1);
  `);
});
test("repeat history repair does not rewrite saved root ownership", () => {
  runGroupMemberReleaseCase(`
    await seedFailover();
    await runtime.executeRaw('DELETE FROM forward_group_members WHERE hostId=1');
    await hosts.getHostRuleDeleteBlockers(1);
    const group = await links.getForwardGroupById(10);
    assert.ok(!group.activeMemberId || group.members.some(member => member.id === group.activeMemberId));
    const before = await runtime.queryRaw(
      'SELECT hostId,updatedAt FROM forward_rules WHERE isForwardGroupTemplate=1'
    );
    await hosts.getHostRuleDeleteBlockers(1);
    assert.deepEqual(await runtime.queryRaw(
      'SELECT hostId,updatedAt FROM forward_rules WHERE isForwardGroupTemplate=1'
    ), before);
  `);
});
test("deleting an obsolete token preserves moved group roots", () => {
  runGroupMemberReleaseCase(`
    await seedFailover();
    await insert("agent_tokens", {
      id: 50, token: "diagnosis-token", hostId: 1, userId: 1,
    });
    await runtime.executeRaw(
      "UPDATE hosts SET agentToken='diagnosis-token' WHERE id=1"
    );
    await saveMembers(10, [2]);
    const before = await rootSnapshot(10);
    await tokenCaller.delete({ id: 50 });
    assert.deepEqual(await rootSnapshot(10), before);
    assert.equal((await runtime.queryRaw('SELECT id FROM agent_tokens WHERE id=50')).length, 0);
  `);
});
```

组成员、独立隧道各个位置以及 Token 都要使用真实删除接口检查；即便没有业务规则，仍在配置中的关系也不能被删除：

```ts
for (const usage of ["group", "entry", "exit", "hop", "extra-exit", "rule-exit"]) {
  for (const token of [false, true]) {
    test("saved relationship blocks deletion: " + usage + ", token=" + token, () => {
      runGroupMemberReleaseCase(`
        const usage = "` + usage + `";
        if (usage === "group") {
          await insert("forward_groups", {
            id: 20, name: "other-group", groupType: "host", groupMode: "failover",
            targetIp: "0.0.0.0", userId: 1, isEnabled: 0,
          });
          await insert("forward_group_members", {
            id: 201, groupId: 20, memberType: "host", hostId: 1, priority: 0, isEnabled: 0,
          });
        } else {
          await insert("tunnels", {
            id: 70, name: "other-tunnel", entryHostId: usage === "entry" ? 1 : 2,
            exitHostId: usage === "exit" ? 1 : 3, listenPort: 25070,
            mode: "tls", userId: 1, isEnabled: 0,
          });
          if (usage === "hop" || usage === "extra-exit") await insert(
            usage === "hop" ? "tunnel_hops" : "tunnel_exit_nodes",
            { tunnelId: 70, seq: 0, hostId: 1, listenPort: 25071 },
          );
          if (usage === "rule-exit") {
            await insert("forward_rules", {
              id: 9000, name: "selected-exit", hostId: 2, userId: 1, tunnelId: 70,
              sourcePort: 29000, targetIp: "192.0.2.90", targetPort: 80,
              protocol: "tcp", forwardType: "gost", isEnabled: 1,
            });
            await insert("forward_rule_tunnel_exits", {
              ruleId: 9000, tunnelId: 70, exitNodeId: 701, exitSeq: 0,
              exitHostId: 1, tunnelExitPort: 25071,
            });
          }
        }
        await insert("agent_tokens", { id: 50, token: "reference-token", hostId: 1, userId: 1 });
        const remove = ` + token + `
          ? () => tokenCaller.delete({ id: 50 }) : () => hostCaller.delete({ id: 1 });
        await assert.rejects(remove, /组|隧道|引用|使用/);
        assert.equal((await runtime.queryRaw('SELECT id FROM hosts WHERE id=1')).length, 1);
        assert.equal((await runtime.queryRaw('SELECT id FROM agent_tokens WHERE id=50')).length, 1);
      `);
    });
  }
}
test("historic entry ownership repairs before deletion and removed extra entries are released", () => {
  runGroupMemberReleaseCase(`
    await seedEntryChain();
    await insert("tunnels", {
      id: 70, name: "extra-entries", entryHostId: 6, exitHostId: 3,
      entryGroupId: 30, mode: "tls", listenPort: 25070, userId: 1, isEnabled: 1,
    });
    await saveMembers(30, [5]);
    // Recreate the old released-members/stale-root state produced by the faulty version.
    await runtime.executeRaw('UPDATE forward_rules SET hostId=4 WHERE id=400');
    const before = await rootSnapshot(40);
    await hostCaller.delete({ id: 4 });
    assert.deepEqual(await rootSnapshot(40), before);
    assert.deepEqual(await runtime.queryRaw('SELECT hostId FROM forward_rules WHERE id=400'), [{ hostId: 5 }]);
    assert.equal((await runtime.queryRaw('SELECT entryHostId FROM tunnels WHERE id=70'))[0].entryHostId, 6);
    assert.equal((await runtime.queryRaw('SELECT id FROM hosts WHERE id=4')).length, 0);
  `);
});
test("concurrent member saves leave roots on the final saved member", () => {
  runGroupMemberReleaseCase(`
    await seedFailover();
    await Promise.all([saveMembers(10, [2]), saveMembers(10, [3])]);
    const members = (await links.getForwardGroupById(10)).members;
    assert.equal(members.length, 1);
    const owner = (await runtime.queryRaw('SELECT hostId FROM forward_rules WHERE id=1000'))[0].hostId;
    assert.equal(owner, members[0].hostId);
    await assertGroupReleased(10, 1, members[0].hostId);
    assert.equal((await hosts.getHostRuleDeleteBlockers(1)).managedRuleCount, 0);
  `);
});
test("rejoining a removed member keeps its current child active", () => {
  runGroupMemberReleaseCase(`
    await seedFailover();
    await saveMembers(10, [2]);
    await saveMembers(10, [1, 2]);
    await links.syncForwardGroupRules(10);
    const current = await runtime.queryRaw(
      'SELECT id,isEnabled FROM forward_rules WHERE hostId=1 ' +
      'AND isForwardGroupTemplate=0 AND pendingDelete=0'
    );
    assert.equal(current.length, 1);
    assert.equal(Boolean(current[0].isEnabled), true);
    assert.equal((await hosts.getHostRuleDeleteBlockers(1)).managedRuleCount, 1);
  `);
});
```

隧道型组的主规则修正与独立隧道保护样本：

```ts
test("tunnel-member removal releases the group but preserves the standalone tunnel", () => {
  runGroupMemberReleaseCase(`
    for (const id of [71, 72]) await insert("tunnels", {
      id, name: "tunnel-" + id, entryHostId: id - 70, exitHostId: 3,
      mode: "tls", listenPort: 25000 + id, userId: 1, isEnabled: 1,
    });
    await insert("forward_groups", {
      id: 10, name: "tunnel-members", groupType: "tunnel", groupMode: "failover",
      forwardType: "gost", targetIp: "0.0.0.0", userId: 1, isEnabled: 1,
    });
    for (const id of [71, 72]) await insert("forward_group_members", {
      id: 100 + id, groupId: 10, memberType: "tunnel",
      tunnelId: id, priority: id - 71, isEnabled: 1,
    });
    await insert("forward_rules", {
      id: 1000, hostId: 1, name: "root", userId: 1, forwardGroupId: 10,
      isForwardGroupTemplate: 1, isEnabled: 1, sourcePort: 20000,
      forwardType: "gost", protocol: "tcp", targetIp: "192.0.2.90", targetPort: 80,
    });
    await groups.update({
      id: 10, name: "tunnel-members", groupMode: "failover", groupType: "tunnel",
      forwardType: "gost", protocol: "tcp", failoverSeconds: 17, recoverSeconds: 23,
      autoFailback: true, isEnabled: true, domain: null, recordType: "A",
      members: [{ memberType: "tunnel", tunnelId: 72, priority: 0, isEnabled: true }],
    });
    await assertGroupReleased(10, 1, 2);
    assert.equal((await hosts.getHostRuleDeleteBlockers(1)).managedRuleCount, 0);
    await assert.rejects(() => hostCaller.delete({ id: 1 }), /隧道|引用|使用/);
    assert.equal((await runtime.queryRaw('SELECT hostId FROM forward_rules WHERE id=1000'))[0].hostId, 2);
  `);
});
```

补充独立验证，不能让删除检查替保存检查补好数据：

```ts
test("save assertions detect a stale owner before historic repair runs", () => {
  runGroupMemberReleaseCase(`
    await seedFailover();
    await saveMembers(10, [2]);
    await assertGroupReleased(10, 1, 2);
    await runtime.executeRaw('UPDATE forward_rules SET hostId=1 WHERE id=1000');
    await assert.rejects(() => assertGroupReleased(10, 1, 2));
    await hosts.getHostRuleDeleteBlockers(1);
    await assertGroupReleased(10, 1, 2);
  `);
});
for (const order of ["join-first", "delete-first"]) {
  test("member joining and host deletion use a controlled order: " + order, () => {
    runGroupMemberReleaseCase(`
      await seedFailover();
      await saveMembers(10, [2]);
      await assertGroupReleased(10, 1, 2);
      assert.equal((await hosts.getHostRuleDeleteBlockers(1)).managedRuleCount, 0);
      let unlock, started;
      const ready = new Promise(resolve => { started = resolve; });
      const gate = new Promise(resolve => { unlock = resolve; });
      const holding = withGroupMemberMutation(async () => { started(); await gate; });
      await ready;
      const join = () => saveMembers(10, [1, 2]);
      const remove = () => hostCaller.delete({ id: 1 });
      const first = ("` + order + `" === "join-first" ? join() : remove())
        .then(value => ({ value }), error => ({ error }));
      await waitForMutationQueue(2);
      const second = ("` + order + `" === "join-first" ? remove() : join())
        .then(value => ({ value }), error => ({ error }));
      await waitForMutationQueue(3);
      unlock(); await holding;
      const results = await Promise.all([first, second]);
      assert.ok(!results[0].error);
      assert.ok(results[1].error);
      if ("` + order + `" === "join-first") {
        assert.equal((await runtime.queryRaw('SELECT id FROM hosts WHERE id=1')).length, 1);
        assert.deepEqual((await links.getForwardGroupById(10)).members.map(m => m.hostId), [1, 2]);
      } else {
        assert.equal((await runtime.queryRaw('SELECT id FROM hosts WHERE id=1')).length, 0);
        assert.deepEqual((await links.getForwardGroupById(10)).members.map(m => m.hostId), [2]);
      }
      assert.equal((await rootSnapshot(10)).length, 1);
    `);
  });
}
test("a final delete failure restores permissions, bindings and pending cleanup", () => {
  runGroupMemberReleaseCase(`
    await seedFailover(); await saveMembers(10, [2]);
    await insert("agent_tokens", { id: 50, token: "rollback-token", hostId: 1, userId: 1 });
    await runtime.executeRaw("UPDATE hosts SET agentToken='rollback-token' WHERE id=1");
    await insert("user_host_permissions", { userId: 1, hostId: 1 });
    const before = await deleteSnapshot();
    await runtime.executeRaw(
      'CREATE TRIGGER reject_host_delete BEFORE DELETE ON hosts WHEN OLD.id=1 ' +
      "BEGIN SELECT RAISE(ABORT,'injected-final-delete-failure'); END"
    );
    await assert.rejects(() => hostCaller.delete({ id: 1 }), /injected-final-delete-failure/);
    assert.deepEqual(await deleteSnapshot(), before);
    await assert.rejects(() => tokenCaller.delete({ id: 50 }), /injected-final-delete-failure/);
    assert.deepEqual(await deleteSnapshot(), before);
  `);
});
for (const source of ["hostId", "agentToken", "mixed"]) {
  test("token deletion checks every affected host: " + source, () => {
    runGroupMemberReleaseCase(`
      const source = "` + source + `";
      await insert("agent_tokens", {
        id: 50, token: "multi-token", hostId: source === "agentToken" ? null : 1, userId: 1,
      });
      if (source !== "hostId") await runtime.executeRaw(
        "UPDATE hosts SET agentToken='multi-token' WHERE id IN (2,3)"
      );
      const protectedHost = source === "hostId" ? 1 : 3;
      await insert("forward_rules", {
        id: 9000, name: "protected", hostId: protectedHost, userId: 1,
        sourcePort: 29000, targetIp: "192.0.2.90", targetPort: 80,
        protocol: "tcp", forwardType: "iptables", isEnabled: 1,
      });
      const before = await deleteSnapshot();
      await assert.rejects(() => tokenCaller.delete({ id: 50 }), /转发规则/);
      assert.deepEqual(await deleteSnapshot(), before);
    `);
  });
}
test("unauthorized deletions do not trigger historical repair", () => {
  runGroupMemberReleaseCase(`
    await seedFailover();
    await runtime.executeRaw('DELETE FROM forward_group_members WHERE hostId=1');
    await insert("users", { id: 2, username: "customer", password: "test", role: "user" });
    await insert("agent_tokens", { id: 50, token: "admin-only", hostId: 1, userId: 1 });
    const customer = { ...context, user: { id: 2, username: "customer", role: "user", accountEnabled: true } };
    const before = await deleteSnapshot();
    await assert.rejects(() => hostsRouter.createCaller(customer).delete({ id: 1 }), /无权/);
    await assert.rejects(() => agentTokensRouter.createCaller(customer).delete({ id: 50 }), /无权/);
    assert.deepEqual(await deleteSnapshot(), before);
  `);
});
test("owning a token does not allow changing another user's host", () => {
  runGroupMemberReleaseCase(`
    await insert("users", { id: 2, username: "customer", password: "test", role: "user" });
    await insert("agent_tokens", { id: 50, token: "customer-token", hostId: 1, userId: 2 });
    await runtime.executeRaw("UPDATE hosts SET agentToken='customer-token' WHERE id=1");
    const customer = { ...context, user: { id: 2, username: "customer", role: "user", accountEnabled: true } };
    const before = await deleteSnapshot();
    await assert.rejects(() => agentTokensRouter.createCaller(customer).delete({ id: 50 }), /无权/);
    assert.deepEqual(await deleteSnapshot(), before);
  `);
});
test("deleting a host preserves a token still used by another host", () => {
  runGroupMemberReleaseCase(`
    await insert("agent_tokens", { id: 50, token: "shared-legacy-token", hostId: 1, userId: 1 });
    await runtime.executeRaw("UPDATE hosts SET agentToken='shared-legacy-token' WHERE id=2");
    await insert("forward_rules", {
      id: 9000, hostId: 2, userId: 1, name: "other-host-rule", sourcePort: 29000,
      targetIp: "192.0.2.90", targetPort: 80, forwardType: "iptables", protocol: "tcp",
    });
    await hostCaller.delete({ id: 1 });
    assert.deepEqual(await runtime.queryRaw('SELECT hostId FROM agent_tokens WHERE id=50'), [{ hostId: null }]);
    assert.deepEqual(await runtime.queryRaw('SELECT agentToken FROM hosts WHERE id=2'), [{ agentToken: "shared-legacy-token" }]);
    assert.equal((await runtime.queryRaw('SELECT id FROM forward_rules WHERE id=9000')).length, 1);
  `);
});
test("moving root ownership retains its billing records and account balance", () => {
  runGroupMemberReleaseCase(`
    await seedFailover();
    await runtime.executeRaw('UPDATE users SET balanceCents=50000 WHERE id=1');
    await insert("traffic_billing_configs", {
      id: 90, resourceType: "forward_group", resourceId: 10, enabled: 1,
      pricePerGbCents: 100, multiplier: 100,
    });
    await insert("traffic_billing_rule_usage", {
      id: 91, userId: 1, ruleId: 1000, resourceType: "forward_group", resourceId: 10,
      totalBytes: 123456, billedGb: 0, pendingMilliCents: 1234, settled: 0,
    });
    await insert("traffic_billing_records", {
      id: 92, userId: 1, ruleId: 1000, resourceType: "forward_group", resourceId: 10,
      bytes: 1000000, amountCents: 100, balanceAfterCents: 50000,
    });
    const snapshot = async () => ({
      usage: await runtime.queryRaw('SELECT * FROM traffic_billing_rule_usage WHERE ruleId=1000'),
      records: await runtime.queryRaw('SELECT * FROM traffic_billing_records WHERE ruleId=1000'),
      config: await runtime.queryRaw('SELECT * FROM traffic_billing_configs WHERE id=90'),
      balance: await runtime.queryRaw('SELECT balanceCents FROM users WHERE id=1'),
    });
    const before = await snapshot();
    await saveMembers(10, [2]); await assertGroupReleased(10, 1, 2);
    assert.deepEqual(await snapshot(), before);
    await links.syncForwardGroupRules(10);
    assert.deepEqual(await snapshot(), before);
  `);
});
```

这里的双请求网页保存样本只证明现有路由的串行结果，不能替代上面明确排队的检查。底层直接调用与网页保存、新链创建与入口组保存分别检查：

```ts
test("direct replacement and API saving read the final member configuration", () => {
  runGroupMemberReleaseCase(`
    await seedEntryChain();
    const frames = captureAgentFrames([4, 5, 6]); const before = frames();
    await runInMutationOrder(
      () => links.replaceForwardGroupMembers(30, [{ memberType: "host", hostId: 5, priority: 0, isEnabled: true }]),
      () => saveMembers(30, [6]),
    );
    await assertGroupReleased(40, 4, 6);
    await assertGroupReleased(40, 5, 6);
    assert.deepEqual((await links.getForwardGroupById(30)).members.map(m => m.hostId), [6]);
    for (const oldHost of [4, 5]) assert.ok(
      frames().find(([id]) => id === oldHost)[1].length > before.find(([id]) => id === oldHost)[1].length
    );
  `);
});
test("a partial name edit cannot restore an obsolete member list", () => {
  runGroupMemberReleaseCase(`
    await seedEntryChain();
    await runInMutationOrder(
      () => links.replaceForwardGroupMembers(30, [{ memberType: "host", hostId: 5, priority: 0, isEnabled: true }]),
      () => groups.updateFields({ id: 30, name: "renamed-entry" }),
    );
    await assertGroupReleased(40, 4, 5);
    const saved = await links.getForwardGroupById(30);
    assert.equal(saved.name, "renamed-entry");
    assert.deepEqual(saved.members.map(m => m.hostId), [5]);
  `);
});
for (const createFirst of [false, true]) {
  test("new dependent chains and entry saving agree, create first=" + createFirst, () => {
    runGroupMemberReleaseCase(`
      await seedEntryChain();
      let createdId;
      const create = () => withGroupMemberMutation(async () => {
        const result = await groups.create({
          name: "new-chain", groupMode: "chain", groupType: "host", entryGroupId: 30,
          protocol: "tcp", forwardType: "iptables", failoverSeconds: 17,
          recoverSeconds: 23, autoFailback: true, isEnabled: true,
          members: [{ memberType: "host", hostId: 3, priority: 0, isEnabled: true }],
        });
        createdId = result.id;
        const owner = (await links.getForwardGroupById(30)).members[0].hostId;
        await insert("forward_rules", {
          id: 4100, name: "new-root", hostId: owner, userId: 1,
          forwardGroupId: createdId, isForwardGroupTemplate: 1, isEnabled: 1,
          sourcePort: 43005, targetIp: "192.0.2.90", targetPort: 80,
          protocol: "tcp", forwardType: "iptables",
        });
        await links.syncForwardGroupRules(createdId);
      });
      const save = () => saveMembers(30, [5]);
      await runInMutationOrder(...(` + createFirst + ` ? [create, save] : [save, create]));
      await assertGroupReleased(40, 4, 5);
      await assertGroupReleased(createdId, 4, 5);
    `);
  });
}
for (const usage of ["orphan-group", "orphan-hop", "orphan-exit", "plan", "other-token"]) {
  test("automatic cleanup shares real references and retains extra protections: " + usage, () => {
    runGroupMemberReleaseCase(`
      const usage = "` + usage + `";
      if (usage === "orphan-group") await insert("forward_group_members", {
        groupId: 999, memberType: "host", hostId: 1, priority: 0,
      });
      if (usage === "orphan-hop" || usage === "orphan-exit") await insert(
        usage === "orphan-hop" ? "tunnel_hops" : "tunnel_exit_nodes",
        { tunnelId: 999, seq: 0, hostId: 1, listenPort: 25071 },
      );
      if (usage === "plan") {
        await insert("subscription_plans", { id: 80, name: "protected-plan", durationDays: 30 });
        await insert("subscription_plan_hosts", { planId: 80, hostId: 1 });
      }
      if (usage === "other-token") await insert("agent_tokens", {
        id: 51, token: "retained-token", hostId: 1, userId: 1,
      });
      const before = await deleteSnapshot();
      const protectedUse = usage === "plan" || usage === "other-token";
      assert.equal(await hosts.deleteHostIfUnreferenced(1), !protectedUse);
      if (protectedUse) assert.deepEqual(await deleteSnapshot(), before);
      else assert.equal((await runtime.queryRaw('SELECT id FROM hosts WHERE id=1')).length, 0);
    `);
  });
}
```

前面的 `rule-exit` 是现存规则单独选择的出口，不能在清理前删除它再让最终检查通过。

```bash
node --import tsx --test server/groupMemberRelease.test.ts server/portForwardRuleHosts.test.ts server/forwardGroupRuleIntegrity.test.ts client/src/lib/agentTokenStatus.test.ts
```

预期：新增删除检查与现有孤立规则、普通端口转发、Token 状态检查全部通过。

- [x] **Step 5: 单独提交本项。**

```bash
git add server/repositories/forwardGroupRepository.ts server/repositories/hostRepository.ts server/repositories/tokenRepository.ts server/routers/hosts.ts server/routers/agentTokens.ts client/src/i18n/en.json server/groupMemberRelease.test.ts
git commit -m "fix: repair historical host references before guarded deletion"
```

## Task 5: 验证实际撤除配置，补齐说明与交付证据

**Files:**

- Modify: `server/test-support/sniForwardGroupHealthHarness.mjs`、`server/sniForwardGroupHealth.test.ts`
- Modify: `server/test-support/sniImportHarness.mjs`、`server/sniBatchImport.test.ts`
- Create: `server/test-support/groupMemberReleaseDialectHarness.mjs`，只在专用空测试库中手动运行。
- Modify: `package.json`、`docs/guide/groups.md`、`docs/guide/hosts.md`
- Create during implementation: `.scratch/2026-10-16_dmit6移出转发组仍被引用/实施验证记录.md`

**Interfaces:**

- Consumes：前四项的保存、修正和删除行为，以及既有心跳检查辅助中的 `groups`、`heartbeat`、`advance`、`configurations`、`state`、`requests`、`dnsFailure`。
- Produces：实际心跳返回不再下发旧组配置的证据、DNS 失败后的成员及主规则状态、完整检查结果和未验收事项。没有新业务接口。

- [x] **Step 1: 在既有真实心跳检查环境加入成员移除场景。**

该辅助已创建本地 DNS 服务、认证过的心跳请求与 SNI 组，不另建生产测试。在公共初始化完成、已有的 `await settle()` 和主机在线确认之后，加入以下两个场景。先用虚拟时钟让备用成员完成已有恢复等待，确保 DNS 失败场景确实请求了本地服务：

```js
if (scenario === "member-release" || scenario === "member-release-ddns-error") {
  await advance(25, { renew: [1, 2] });
  const rootSql =
    'SELECT id,name,userId,sourcePort,targetIp,targetPort,sni,quotaUsedIn,quotaUsedOut ' +
    'FROM forward_rules WHERE forwardGroupId=10 AND isForwardGroupTemplate=1 ORDER BY id';
  const before = await runtime.queryRaw(rootSql);
  const expectedDomains = before.map(rule => rule.sni).sort();
  assert.equal(expectedDomains.length, 12);
  assert.ok(expectedDomains.every(domain => typeof domain === "string" && domain.length > 0));
  const requestCount = requests.length;
  dnsFailure = scenario === "member-release-ddns-error";
  const save = () => groups.updateFields({
    id: 10, members: [
      { memberType: "host", hostId: 2, priority: 0, isEnabled: true },
    ],
  });
  if (dnsFailure) await assert.rejects(save, error => {
    assert.match(error.message, /配置已保存/);
    assert.ok(error instanceof AggregateError);
    assert.ok(error.errors.some(cause => /simulated DDNS failure/.test(String(cause.message))));
    return true;
  });
  else await save();

  assert.deepEqual((await state()).members.map(member => member.hostId), [2]);
  assert.notEqual((await state()).activeMemberId, 101);
  assert.deepEqual(await runtime.queryRaw(rootSql), before);
  assert.deepEqual(await runtime.queryRaw(
    'SELECT DISTINCT hostId FROM forward_rules WHERE forwardGroupId=10 ' +
    'AND isForwardGroupTemplate=1'
  ), [{ hostId: 2 }]);
  assert.equal(Number((await runtime.queryRaw(
    'SELECT COUNT(*) AS count FROM forward_rules WHERE forwardGroupId=10 ' +
    'AND hostId=1 AND isForwardGroupTemplate=0 AND pendingDelete=0'
  ))[0].count), 0);

  const oldReply = await heartbeat(1, configurations[0]);
  const newReply = await heartbeat(2, configurations[1]);
  const domainsIn = reply => (reply.desiredState?.actions || [])
    .filter(action => action.op === "apply")
    .flatMap(action => action.fxp?.sniRoutes || [])
    .map(route => route.sni).sort();
  assert.deepEqual(domainsIn(oldReply), []);
  assert.deepEqual(domainsIn(newReply), expectedDomains);
  assert.ok(requests.length > requestCount, "member removal must reach the local DNS provider");
  if (dnsFailure) {
    assert.equal((await state()).lastStatus, "error");
    assert.equal((await state()).lastDdnsValue, "127.0.0.1");
  } else {
    assert.equal((await state()).lastDdnsValue, "127.0.0.2");
  }
}
```

现有 `sniRoutes` 和心跳上报都使用 `sni` 字段；上述断言要求明确存在 12 个非空域名，再比较新入口下发的完整列表，避免缺字段时误通过。

在 `server/sniForwardGroupHealth.test.ts` 已有的场景／描述数组中增加两项，直接使用当前循环及其 `spawnSync`，不引入新的运行函数：

```ts
["member-release", "removed SNI group hosts stop receiving routes while roots and new entrance remain"],
["member-release-ddns-error", "DNS failure preserves committed member release and old entrance cleanup"],
```

DNS 失败场景要求错误如实返回和保存状态保持一致；旧入口仍能取得撤除配置，不能声称解析已成功切换。两个场景结束后沿用该辅助现有的服务器、数据库和虚拟时钟清理。

- [x] **Step 1a: 入口组和 TLS 附加入口也检查真实心跳。**

复用 `sniImportHarness.mjs` 已有的 `admin`、`heartbeat`、`insert`、临时 HTTP 服务。在场景分支增加下列两个值；初始化和收尾沿用原文件。新建主机 4／5 与入口组 30，直接 TLS 隧道仍以主机 1 为独立入口，不能把移除附加入口 4 误当成删除主入口 1。以下代码完整建立业务样本：

```js
} else if (["member-release-entry-chain", "member-release-entry-tunnel"].includes(scenario)) {
  const tunnel = scenario.endsWith("tunnel");
  const { forwardGroupsRouter } = await import("../routers/forwardGroups.ts");
  const groups = forwardGroupsRouter.createCaller(context(1, "admin"));
  for (const id of [4, 5]) await insert("hosts", {
    id, name: "extra-entry-" + id, ip: "192.0.2." + id, ipv4: "192.0.2." + id,
    agentToken: "token-" + id, userId: 1, isOnline: 1,
    lastHeartbeat: Math.floor(Date.now() / 1000), agentVersion: "3.3.0",
    portRangeStart: 18000, portRangeEnd: 30000,
  });
  await insert("forward_groups", {
    id: 30, name: "entries", groupType: "host", groupMode: "entry",
    domain: "entry.example.test", ddnsAutoResolveEnabled: 0,
    targetIp: "0.0.0.0", userId: 1, isEnabled: 1,
  });
  for (const id of [4, 5]) await insert("forward_group_members", {
    id: 300 + id, groupId: 30, memberType: "host", hostId: id,
    priority: id, isEnabled: 1,
  });
  let route;
  if (tunnel) {
    await insert("tunnels", {
      id: 20, name: "direct TLS", entryHostId: 1, exitHostId: 3, entryGroupId: 30,
      mode: "tls", listenPort: 26000, userId: 1, isEnabled: 1,
    });
    route = { forwardGroupId: null, tunnelId: 20, hostId: 1, forwardType: "gost" };
  } else {
    await insert("forward_groups", {
      id: 20, name: "entry-chain", groupType: "host", groupMode: "chain",
      entryGroupId: 30, forwardType: "nftables", targetIp: "0.0.0.0", userId: 1, isEnabled: 1,
    });
    for (const id of [1, 3]) await insert("forward_group_members", {
      id: 200 + id, groupId: 20, memberType: "host", hostId: id, priority: id, isEnabled: 1,
    });
    route = { forwardGroupId: 20 };
  }
  const created = await admin.create(ruleInput("retained", 0, route));
  const oldBefore = await heartbeat(4);
  const newBefore = await heartbeat(5);
  const domainList = reply => (reply.desiredState?.actions || [])
    .filter(action => action.op === "apply").flatMap(action => action.fxp?.sniRoutes || [])
    .map(row => row.sni).sort();
  const services = reply => (reply.desiredState?.actions || [])
    .filter(action => action.op === "apply" && action.forwardType === "gost-runtime-sync")
    .flatMap(action => action.managedConfigs || [])
    .flatMap(config => JSON.parse(Buffer.from(config.contentBase64, "base64").toString("utf8")).services || []);
  if (tunnel) {
    assert.ok(services(oldBefore).length > 0);
    assert.ok(services(newBefore).length > 0);
  } else {
    assert.deepEqual(domainList(oldBefore), ["retained-0.example.test"]);
    assert.deepEqual(domainList(newBefore), ["retained-0.example.test"]);
  }
  await groups.updateFields({ id: 30, members: [
    { memberType: "host", hostId: 5, priority: 0, isEnabled: true },
  ] });
  const oldReply = await heartbeat(4, oldBefore.runningRules);
  const newReply = await heartbeat(5);
  const exitReply = await heartbeat(3);
  if (tunnel) {
    // Runtime-sync may still carry an empty cleanup config: inspect its actual services.
    assert.deepEqual(services(oldReply), []);
    assert.ok(services(newReply).some(service => /(?:^|:)18443$/.test(String(service.addr))));
    const independent = await heartbeat(1);
    assert.ok(services(independent).some(service => /(?:^|:)18443$/.test(String(service.addr))));
    assert.equal((await runtime.queryRaw('SELECT entryHostId FROM tunnels WHERE id=20'))[0].entryHostId, 1);
  } else {
    assert.deepEqual(domainList(oldReply), []);
    assert.deepEqual(domainList(newReply), ["retained-0.example.test"]);
  }
  assert.deepEqual(domainList(exitReply), ["retained-0.example.test"]);
  assert.equal((await admin.getById({ id: created.id })).id, created.id);
```

这是一段加入既有 `if/else if` 的分支，末尾接回原文件下一条分支；语法检查时用外层 `if (false) {}` 和结束大括号包住。不能拿不存在的 `gostConfig` 字段做断言：当前心跳使用 `managedConfigs[].contentBase64`。TLS 入口检查实际 GOST 服务表，出口才检查 SNI 域名。

在 `sniBatchImport.test.ts` 注册到已有 `verifyBatchImport`：

```ts
for (const kind of ["chain", "tunnel"]) {
  test("entry member removal withdraws real " + kind + " configurations", () => {
    verifyBatchImport("member-release-entry-" + kind);
  });
}
```

- [x] **Step 2: 把新增检查加入既有服务端检查，并执行相关检查。**

将 `server/forwardGroupTemplateHosts.test.ts` 与 `server/groupMemberRelease.test.ts` 加入 `package.json` 的 `test:server` 命令列表，保留原有文件和前置检查。

```bash
node --import tsx --test server/forwardGroupTemplateHosts.test.ts server/groupMemberRelease.test.ts
node --import tsx --test server/forwardGroupListeners.test.ts server/forwardGroupRuleIntegrity.test.ts server/portForwardRuleHosts.test.ts server/forwardGroupFailover.test.ts server/forwardGroupToggle.test.ts server/forwardGroupRename.test.ts
node --import tsx --test server/sniForwardGroup.test.ts server/sniForwardGroupHealth.test.ts server/tunnelEndpointRefresh.test.ts server/tunnelRuntimePlan.test.ts client/src/lib/agentTokenStatus.test.ts
node --import tsx --test server/databaseTransaction.test.ts server/trafficBatch.test.ts server/userTrafficBillingReset.test.ts server/subscriptionBillingState.test.ts server/ruleResourceAuthorization.test.ts server/sniBatchImport.test.ts
pnpm exec tsc --noEmit
pnpm test:i18n
pnpm test:server
pnpm build
```

先运行新增和相关检查，再运行完整检查一次；出现失败后定位本次引入的问题并重跑受影响部分，不反复全量运行掩盖失败。若类型检查本来就有无关失败，记录具体位置与实施前对照，不能直接标为通过。`databaseTransaction.test.ts` 有 SQLite 保存和驱动检查，但不等于本次新增 SQL 已在 MySQL／PostgreSQL 跑过；不能引用一个不存在的“跨库通过”结果。

- [x] **Step 2a: 明确跨库入口与未运行边界。**

新增独立的 `server/test-support/groupMemberReleaseDialectHarness.mjs`，只用于专用、空的测试数据库。配置文件路径从 `FORWARDX_MEMBER_RELEASE_DB_CONFIG` 读取，不在命令里写密码、不读取生产配置；`DATABASE_TYPE` 在启动进程之前设置，避免加载错误的表结构。脚本内容如下：

```js
import assert from "node:assert/strict";
import fs from "node:fs";
const kind = process.env.DATABASE_TYPE;
assert.ok(["mysql", "postgresql"].includes(kind));
assert.ok(process.env.FORWARDX_MEMBER_RELEASE_DB_CONFIG, "dedicated test config path is required");
const config = JSON.parse(fs.readFileSync(process.env.FORWARDX_MEMBER_RELEASE_DB_CONFIG, "utf8"));
assert.equal(config.type, kind);
assert.ok(String(config[kind]?.database || "").endsWith("_member_release_test"), "dedicated test database required");
const runtime = await import("../dbRuntime.ts");
try {
  await runtime.connectDatabase(config);
  const tables = await runtime.queryRaw(kind === "mysql"
    ? "SELECT COUNT(*) AS count FROM information_schema.tables WHERE table_schema=DATABASE()"
    : "SELECT COUNT(*) AS count FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'");
  assert.equal(Number(tables[0].count), 0, "refuse to change a nonempty test database");
  await (await import("../dbSchema.ts")).ensureDatabaseSchema();
  const links = await import("../repositories/forwardGroupRepository.ts");
  const hosts = await import("../repositories/hostRepository.ts");
  const { forwardGroupsRouter } = await import("../routers/forwardGroups.ts");
  const { hostsRouter } = await import("../routers/hosts.ts");
  const { quoteIdentifier: q, boolValue } = await import("../dbCompat.ts");
  const userId = await runtime.insertAndGetId("users", {
    username: "release-admin", password: "test", role: "admin", canAddRules: true, manualCanAddRules: true,
  });
  const ids = [];
  for (const suffix of [1, 2]) ids.push(await runtime.insertAndGetId("hosts", {
    name: "test-" + suffix, ip: "192.0.2." + suffix, ipv4: "192.0.2." + suffix,
    userId, isOnline: false,
  }));
  const [oldHost, newHost] = ids;
  const groupId = await links.createForwardGroup({
    name: "dialect-release", groupType: "host", groupMode: "failover",
    targetIp: "0.0.0.0", userId, isEnabled: true,
  }, ids.map((hostId, priority) => ({ memberType: "host", hostId, priority, isEnabled: true })));
  const ruleId = await runtime.insertAndGetId("forward_rules", {
    name: "retained-root", hostId: oldHost, userId, forwardGroupId: groupId,
    isForwardGroupTemplate: true, isEnabled: true, forwardType: "iptables", protocol: "tcp",
    sourcePort: 20000, targetIp: "192.0.2.90", targetPort: 80,
  });
  await links.syncForwardGroupRules(groupId);
  const context = { req: { headers: {} }, res: { clearCookie() {} },
    user: { id: userId, username: "release-admin", role: "admin", accountEnabled: true },
    authSession: null, authFailureReason: null };
  await forwardGroupsRouter.createCaller(context).updateFields({ id: groupId, members: [
    { memberType: "host", hostId: newHost, priority: 0, isEnabled: true },
  ] });
  const readOwner = () => runtime.queryRaw(
    "SELECT " + q("hostId") + " FROM " + q("forward_rules") + " WHERE " + q("id") + "=?", [ruleId]);
  assert.equal(Number((await readOwner())[0].hostId), newHost);
  assert.deepEqual(await hosts.getHostLinkDeleteBlockers(oldHost), { groupCount: 0, tunnelCount: 0 });
  await runtime.executeRaw("UPDATE " + q("forward_rules") + " SET " + q("hostId") + "=? WHERE " + q("id") + "=?", [oldHost, ruleId]);
  assert.equal((await hosts.getHostRuleDeleteBlockers(oldHost)).managedRuleCount, 0);
  assert.equal(Number((await readOwner())[0].hostId), newHost);
  await hostsRouter.createCaller(context).delete({ id: oldHost });
  assert.equal(Number((await readOwner())[0].hostId), newHost);
  const live = await runtime.queryRaw("SELECT COUNT(*) AS count FROM " + q("forward_rules") +
    " WHERE " + q("hostId") + "=? AND " + q("pendingDelete") + "=?", [oldHost, boolValue(false)]);
  assert.equal(Number(live[0].count), 0);
  console.log("member-release dialect checks passed: " + kind);
} finally { await runtime.closeDatabase(); }
```

每种数据库分别使用一个新建空库和对应测试配置文件运行；环境变量指向已准备的测试配置，不把配置内容打印到日志：

```bash
DATABASE_TYPE=mysql node --import tsx server/test-support/groupMemberReleaseDialectHarness.mjs
DATABASE_TYPE=postgresql node --import tsx server/test-support/groupMemberReleaseDialectHarness.mjs
```

没有实例或配置就标为“未运行 MySQL／PostgreSQL 真实检查”，继续完成 SQLite 和静态检查，不能用 SQLite 通过替代。脚本不自动删库，结果和专用测试库名记入实施记录，凭据不入库。本脚本覆盖保存、历史修正、结构查询和最终删除 SQL，不冒充覆盖所有数据库故障或多个面板进程并发。

- [x] **Step 3: 更新使用说明。**

在 `docs/guide/groups.md` 的成员管理和入口组部分写入下列说明，主机文档的删除说明引用同一约定：

```md
保存成员列表后，系统会解除已移除主机在该组中的规则引用，并通知旧主机清理对应配置。原有业务规则和用量记录继续保留。

例如，入口组由 A、B 改为只保留 B，引用它的转发链会改用 B；如果 A 没有其他用途，就可以正常删除。若 A 还被其他组使用，或仍是某条独立隧道的入口、中继、出口，需要先解除那项引用。

旧主机离线时，面板中的引用可以先释放，实际配置撤除需要等它重新连接。成员保存成功也不代表 DNS 和业务连接已经切换完成，应分别查看健康状态和解析结果。
```

- [x] **Step 4: 保存能核对的交付记录。**

实施验证记录逐项写实际结果，不预填“通过”：

```md
# 成员移除释放主机：实施验证记录

- 实施提交：
- 代码修改授权依据：
- 普通组 1／44 条规则：
- SNI 主备组：
- 入口组及多条依赖链：
- 独立隧道入口／中继／出口的保护：
- 历史引用修正和实际主机／Token 删除：
- 规则编号、业务配置与用量保留：
- 旧入口撤除和新入口配置：
- DNS 失败后的保存与撤除：
- 失败撤回与重复保存：
- 保存只读断言与历史修正独立验证：
- Token 全部影响主机、权限与最终删除撤回：
- 同组保存、直接调用、新链创建与删除的明确先后顺序：
- 提交后单项失败、其他清理继续和再次刷新：
- 类型、相关检查、完整服务端检查、构建：
- SQLite／MySQL／PostgreSQL 实际运行范围：
- 生产处理：本地实施不等于生产已处理。
- 人工验收：等待用户明确确认。
```

当前生产 dmit6 的附加情况要保留在交付说明：面板曾因剩余三台成员不健康而保留旧 DDNS 地址。修复引用后仍须单独核对解析和实际业务；本计划不通过改变健康政策来宣称已经切换。

生产处理只在获得对应授权后进行。先保存只读基线和可恢复备份，部署修复版本，再让正常同步／删除检查修正历史引用；核对 44 条主规则和三台现有成员的规则保留，最后才执行用户明确要求的删除。不得直接运行删除这 44 条规则的 SQL。

- [x] **Step 5: 单独提交本项，交付本地结果供查看。**

```bash
git add package.json server/test-support/sniForwardGroupHealthHarness.mjs server/sniForwardGroupHealth.test.ts server/test-support/sniImportHarness.mjs server/sniBatchImport.test.ts server/test-support/groupMemberReleaseDialectHarness.mjs docs/guide/groups.md docs/guide/hosts.md .scratch/2026-10-16_dmit6移出转发组仍被引用/实施验证记录.md
git commit -m "test: verify group member release and document deletion behavior"
```

提交不等于推送或发版；本计划不包含自动生产部署。

## 需求覆盖自查

| 需求 | 对应任务 |
| --- | --- |
| R01 解除旧组引用并允许无其他用途的主机删除 | 2、3、4 |
| R02 普通／SNI、主机／隧道型组、入口组引用链和附加入口 | 2、3、4、5 |
| R03 规则身份、业务配置、用量及真实使用关系保留 | 2、3、4、5 |
| R04 旧副本停用、用量处理、通知和离线清理 | 2、3、5 |
| R05 禁用／离线不阻止归属修正 | 1、2、3 |
| R06 重复调用稳定、无悬空活动成员 | 1、2、4 |
| R07 保存失败撤回、提交后刷新、最终删除撤回 | 2、3、4、5 |
| R08 历史数据自修复 | 4 |
| R09 真实组／隧道／独立规则保护，Token 一致 | 4 |
| R10 全部引用链同步，单项提交后错误与 DNS 失败不挡其他撤除 | 2、3、5 |
| R11 DNS 与业务切换单独确认 | 5 |
| R12 不增加依赖、字段、接口或 Agent 协议 | 全部 |

本表列出原计划的需求覆盖关系；实施步骤和本地检查已完成，实际结果见本任务的实施验证记录。

2026-10-16 审查补齐后的自查结果：R01—R12 已逐项对应到实施任务；52 段 TypeScript／JavaScript 示例与 32 段内嵌脚本通过语法解析，2 段 JSON 示例解析通过；29 个引用文件路径已核对为现有文件或明确列出的待创建文件，文档链接、代码围栏、草稿占位扫描和文档差异空白检查通过。数组条目、路由链和既有场景分支分别按原文说明补上外层结构后检查。

本次补齐详情见 `.scratch/2026-10-16_dmit6移出转发组仍被引用/计划审查记录.md`。语法解析没有运行计划中的业务代码，也不代替实施后的类型、保存、删除、心跳、跨库或构建检查。这是计划编写时的状态；当前实施结果以实施验证记录为准。

## 执行交接

计划交付后可选择：

1. 分任务执行：每项交给新的子代理完成，逐项检查后继续；用户选择后先确认相应执行技能可用。
2. 当前会话逐项执行：使用已安装的 `executing-plans` 技能，按本计划的小步骤实施，并在各项交付点核对。

本轮用户已明确同意执行、提交并发布新版，实际采用逐项实施与独立审查。完成状态按真实检查和发布证据记录；本地通过不代表生产已升级或人工验收通过。


## 2026-10-16 实施与发布补充

- 五项实现和本地验证已完成，面板准备为 3.3.8；Agent／FXP 保持 3.3.0，原生应用按长期约定排除。
- 完整服务端 1083 项通过；类型、双语、版本与发布说明、产品和正式路径文档构建通过。MySQL／PostgreSQL 真实实例未运行，已有专用空库入口。
- 第四项独立审查发现两处缺口并已修复、复审通过：Token 的待清理和自动主机清理结束后再次检查全部主机的用途，出现有效规则则整次撤回；主机删除在历史修正之后的最终保存内重读归属并核对权限。以上补充替代原 Step3b 只在清理之前检查的不足。
- Task4 新增 9 项检查先得到 7 项危险样本失败、2 项合法保留样本通过；修正后 9 项通过，相关回归 86 项通过。
- 本轮追加发布要求已纳入第五项，在 3.3.8 状态完成检查。远端只允许 sni-panel/main 与版本标签，不向 origin 推送。
- 最终审查及公开发布结果另见实施验证和发布记录；没有修改生产数据库或删除 dmit6，没有记录人工验收通过。
