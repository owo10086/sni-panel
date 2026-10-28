# 主机型主备组按入口健康判断 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking. 用户要求不创建工作树，在当前目录实施；用户已确认三项推荐并要求严格限制范围。

**Goal:** 主机型主备组中的普通业务目标失败、缺失或过期不单独影响选入口与 DDNS，入口自身应运行规则未运行仍影响资格。

**Architecture:** 沿用现有入口观察窗口与 SNI 完整配置检查，把主机型主备组的普通规则改按入口运行状态判断。共享判断仍保留明确的组类型／模式条件，入口组及隧道等模式继续读取原有普通目标结果。保留每条目标检测的记录、展示及手动测试。

**Tech Stack:** TypeScript、Node test、SQLite 隔离数据库、本地 HTTP DDNS 回调。

**Spec:** `.scratch/2026-10-19_普通转发组按入口健康判断/讨论记录.md`；用户 2026-10-19 回复“按推荐，注意不要扩大范围”，确认 Q1 A、Q2 A、Q3 A。

## Global Constraints

- 只改主机型 `failover` 主备组，覆盖纯普通及混合组；不改变 `entry`、`port`、`exit`、`chain` 或隧道型主备组的策略。
- 开关关闭时只跳过入口外部检测，不恢复业务目标门槛；在线、运行、流量、观察、优先级与回切条件保留。
- SNI 现有完整配置确认继续保留；不把普通运行标记宣称为 SNI 同等强度的确认。
- 不新增依赖或改锁文件，不升级 Agent，不操作生产，不发布、推送或创建工作树。
- 验证使用现有公开入口：`runForwardGroupFailover`／组查询、真实 Agent 报告与心跳、隔离 DDNS 回调；不针对私有判断函数编写模拟实现测试。

## Task 1：入口资格和范围保护

**Files:** `server/repositories/forwardGroupRepository.ts`；`server/forwardGroupFailover.test.ts`；`server/sniForwardGroupHealth.test.ts`；`server/test-support/sniForwardGroupHealthHarness.mjs`。

**Interfaces:** 保留现有 `runForwardGroupFailover`、组接口、心跳和报告接口及数据结构。

- [x] 先增加纯普通组回归：运行规则正常，目标失败／缺失／过期，调用真实选入口及本地 DDNS 回调，仍应选出成员。旧实现应在选入口或状态断言失败。
- [x] 主机型主备组复用现有入口观察逻辑；其普通规则只提供运行状态条件，SNI 继续确认完整配置。概念条件如下：

```ts
const entryHealthOnly = group.groupType === "host" && groupModeOf(group) === "failover";
if (entryHealthOnly) {
  observations.push({ key: `rule:${template.id}`, healthy: running,
    message: running ? "普通转发规则已运行" : "普通转发规则尚未运行" });
  continue;
}
```

- [x] 入口健康报告与选择前复核只在本轮范围内沿用入口窗口要求，防止业务目标的旧健康结论或入口检测替入口规则凑观察时间。
- [x] 调整旧测试中以目标失败冒充入口故障的输入，保留原优先级、观察、重试、排除和并发行为验证。混合组通过真实报告确认普通目标失败不切换，但普通规则未运行仍切换。
- [x] 增加或保留范围对照：多入口资源混合普通部分及隧道型主备组仍执行原目标要求；不改这些模式的生产代码。
- [x] 执行相关健康、主备、在线、SNI、手动测试与多入口检查，完成类型检查和构建。测试使用已锁定依赖；环境依赖缺失先修复本地安装，不改依赖版本。

## Task 2：决定、文档与审查

**Files:** `AGENTS.md`；`docs/adr/0006-sni-group-ddns-uses-confirmed-entry-health.md`；新增 `docs/adr/0008-host-failover-groups-use-entry-health.md`；本轮讨论及验证记录。

- [x] 记录用户三项选择，标明范围；ADR-0007 的多入口普通目标要求继续保留。
- [x] 更新旧约定中对主机型主备组普通规则的目标门槛描述；每条目标检测继续展示、记录和排查。
- [x] 使用 `requesting-code-review`，委托 Codex CLI 只读审查本轮差异，重点检查范围没有扩大、入口运行门槛未放宽、观察时间及 DDNS 结果可信；处理实质问题。
- [x] 保存实际失败／通过证据和检查结果，交付本地修改；不把本地验证当作生产修复或用户验收。

实际结果：64 项相关回归通过，全项目类型与构建通过，独立审查指出的恢复重启问题已修复并复核。证据见 `.scratch/2026-10-19_普通转发组按入口健康判断/实施与验证记录.md`。未提交、未发布、未上线，未进行人工验收。
