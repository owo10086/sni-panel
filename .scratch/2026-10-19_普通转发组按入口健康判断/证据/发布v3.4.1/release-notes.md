## 简体中文

### 修复与改进

- 主机型主备转发组按入口自身运行与健康情况选择成员。普通业务目标检测失败、缺失或过期，不再单独阻止入口选择、卡住 DDNS 或触发整组切换；逐条目标故障、延迟、历史和手动排查继续保留。
- 入口健康检测关闭时只跳过指定外部地址的检查；成员在线、流量政策、应运行规则、观察等待、优先级和自动回切继续生效。SNI 仍要求当前完整分流配置得到确认。
- 修复普通规则持续故障期间重启面板会重新开始等待的问题，分别保存每条规则当前副本的故障起点；恢复、换副本或另一条规则发生故障时，不借用旧故障或入口检测的时间。
- 修复规则移组再移回后，待删除旧副本遮住已运行新副本的问题，使准备好的备用入口可以正常选中；保留 SNI 对已撤销域名和旧分流配置的检查。

### 版本与升级说明

- 面板：`3.4.1`；Agent 和 ForwardX FXP runtime：`3.4.0`。本次只需升级面板，无需为这项修复升级 Agent／FXP。
- 调整仅适用于主机型主备组，包括普通规则和 SNI 混合组；多入口组、端口资源、出口组、转发链及隧道型主备组继续原有策略。
- 本版不会修复业务目标服务自身的故障；已运行但目标不可达的规则仍如实显示失败。原生 Android、iOS／iPadOS 应用按长期约定排除，不发布 APK／IPA。

---

## English

### Fixes and improvements

- Select members of host failover groups using entry runtime readiness and health. Failed, missing or expired ordinary business-target probes no longer independently block entry selection, stall DDNS or switch the entire group. Keep per-rule failures, latency, history and manual diagnostics.
- Disabling the entry health check skips only its configured external probe. Retain member liveness, traffic policy, required running rules, observation delays, priority and automatic failback. SNI still requires confirmation of the complete current routing configuration.
- Preserve each ordinary rule's current child failure start across panel restarts so an ongoing failure does not restart its failover delay. Recovery, replacement children and newly failed rules cannot borrow time from earlier failures or the entry health check.
- Ignore retired children when selecting the current ordinary child after a rule moves to another group and back, allowing a prepared backup entry to qualify. Preserve SNI checks for revoked hostnames and obsolete routing configurations.

### Versions and upgrade notes

- Panel: `3.4.1`; Agent and ForwardX FXP runtime: `3.4.0`. Only the panel needs upgrading for this fix; no Agent/FXP upgrade is required.
- This change applies only to host failover groups, including ordinary and mixed SNI groups. Keep the existing policies for parallel entry groups, port resources, exit groups, forwarding chains and tunnel failover groups.
- This release does not repair failed business-target services. Running rules whose destinations are unreachable continue to display failures. Native Android and iOS/iPadOS applications remain excluded; no APK/IPA is published.
