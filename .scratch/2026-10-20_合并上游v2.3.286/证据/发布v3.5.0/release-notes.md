## 简体中文

### 新功能与改进

- 兼容上游 286 的网页、服务端和 Agent／FXP 改进，保留本地 SNI、主机型主备健康判断、计费、安全、品牌和安装来源。原生安装应用继续排除。
- 支持主机多个公网 IPv4／IPv6、主地址选择和可选双栈／全部地址同步。旧单 IP 配置保持原更新方式，主动启用新模式后才管理完整记录名单；改回主 IP 仍清理该模式的多余记录。
- 新增独立主机健康检测和可选自动换 IP，默认关闭；管理员明确配置后由对应 Agent 执行，带冷却、次数限制和结果不明不重发保护。地址同步不绕过 SNI 完整配置确认及组解析观察。
- 新增管理员外部只读 MCP、验证码方式选择和默认关闭的持续资源告警；不自动生成凭证，保留既有登录及写操作确认保护。
- 账单支持完整 Excel 导出，套餐和按量资源顺序与商店同步；改进精确统计、网络诊断、多入口延迟和地图展示。
- 网页按页加载并保留导航，首页先展示隔离缓存后更新；登录布局、中英文及本地图标同步改善。FXP 只在业务数据发送前重试连接和初始握手，不重放已发送业务。
- 改进三类数据库升级、错误提示和后台分批清理；安装脚本检查来源流量采集依赖。
- 新增历史记录清理沿用分批与时间预算，保留未确认的换 IP 记录；管理员只读接入凭证在数据库并发及重复读设置下仍保持每账户最多 10 个。

### 版本与升级说明

- 面板、Agent 和 ForwardX FXP runtime：`3.5.0`。本版包含运行程序改动，请先备份，再升级面板及配套 Agent／FXP；仅更新面板不会让旧程序自动具备多地址上报和自动换 IP 能力。
- 自动换 IP、持续资源告警默认关闭，外部只读接入不自动生成凭证。完整名单 DDNS 模式请使用专用域名，主动启用后切回主 IP 仍会清理多余记录。
- 保留 ADR-0006／0008 的本地入口健康、完整 SNI 配置确认、观察等待与发布前复查；目标检测异常不单独卡住 SNI 或主机型主备组入口。
- 当前发布 Linux amd64 资产；原生 Android、iOS／iPadOS 按长期约定排除，不发布 APK／IPA。
- 自动检查与独立审查已完成。真实商家换 IP、生产 DNS、告警消息及部分规模场景仍有验收边界；发版不代表主机已经升级或用户人工验收通过。

---

## English

### Features and improvements

- Integrate upstream 286 web, server and Agent/FXP improvements while preserving local SNI, host failover entry health, billing, security, branding and installation sources. Native applications remain excluded.
- Discover multiple public IPv4/IPv6 addresses, select primary addresses and optionally synchronize dual-stack or complete address sets. Existing single-IP configurations retain single-record updates; explicitly enabling the new mode manages the complete selected record sets, including removal of extra records after returning to primary-only mode.
- Add independent host health checks and optional automatic IP switching, disabled by default. Explicit administrator configuration lets the corresponding Agent call the provider with cooldowns, attempt limits and no blind retries for uncertain outcomes. Address synchronization retains SNI configuration confirmation and group DNS observation rules.
- Add administrator-only read-only external MCP access, CAPTCHA provider selection and optional sustained resource alerts. No tokens are generated automatically; existing login and write-confirmation safeguards remain.
- Export complete billing ledgers to Excel and persist product/resource ordering in the store. Improve precise statistics, network diagnostics, multi-entry latency and map details.
- Load pages on demand while retaining navigation, restore isolated presentation caches before refreshing the dashboard, and improve login layouts, languages and local logo synchronization. FXP retries connection/initial hello setup only before business payload is sent; it does not replay established streams.
- Improve database upgrades, safe failure explanations and paced background retention across supported databases. Installation scripts check source-accounting dependencies.
- Apply bounded batches and time budgets to new history tables while retaining unacknowledged IP-switch attempts. Administrator read-only access tokens remain limited to ten per account, including concurrent issuance under repeatable-read database settings.

### Versions and upgrade notes

- Panel, Agent and ForwardX FXP runtime: `3.5.0`. Runtime programs have changed: back up first, then upgrade the panel and matching Agent/FXP assets. Updating only the panel does not give older binaries multi-address reporting or automatic IP-switch capabilities.
- Automatic IP switching and sustained resource alerts default off; external read-only access generates no tokens automatically. Use a dedicated domain for complete-record-set DDNS management; returning to primary-only mode still removes extra records.
- Preserve ADR-0006/0008 entry health, complete current SNI configuration confirmation, observation waits and pre-publication rechecks. Destination-probe failures alone do not block SNI or host failover entry selection.
- Assets target Linux amd64. Native Android and iOS/iPadOS applications remain excluded; no APK/IPA is published.
- Automated checks and independent review are complete. Real provider IP changes, production DNS, alert delivery and some scale scenarios retain acceptance gaps. Publishing does not imply upgraded hosts or user acceptance.
