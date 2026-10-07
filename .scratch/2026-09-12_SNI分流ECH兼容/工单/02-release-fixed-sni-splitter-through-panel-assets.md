# 02 — 通过面板 Agent 资产发布并升级修复后的分流器

**What to build:** 修复后的 `forwardx-fxp` 进入面板携带的 Agent 资产。出口主机通过常规 Agent 升级并启用面板资产优先下载后，能够安装包含 ECH 判定修复的分流器，无需手工替换二进制，也无需修改现有 SNI 分流规则。

**Blocked by:** 01 — 带 ECH 扩展的连接按可读明文 SNI 分流

**Status:** resolved

- [x] `forwardx-fxp` 运行时版本按现有版本规则更新，变更记录中的版本信息与源码保持一致
- [x] 发布过程生成 `amd64` 和 `arm64` 两种 `forwardx-fxp` 二进制及对应校验和
- [x] 面板发布包包含本次构建的分流器资产，并能通过现有 Agent 资产接口提供对应版本的下载
- [x] `FORWARDX_AGENT_PANEL_FIRST` 启用时，升级脚本优先取得面板资产；面板资产暂时不可用时，继续遵循既有备用下载行为并保留可用的旧分流器
- [x] 常规 Agent 升级完成后，出口主机运行的分流器版本包含工单 01 的 ECH 判定修复
- [x] 升级过程保留现有 SNI 分流规则和分流表配置，无需配置迁移
- [x] 升级期间的连接中断范围与既有分流器重启行为一致
- [x] 升级后的真实连接验证覆盖带 Chrome 指纹或等价 GREASE ECH ClientHello 的场景，并确认连接到达对应目标服务
- [x] 发布前的版本校验、测试、静态检查和资产完整性检查全部通过

## Comments

**2026-09-13** — 实现于 `e761fc5`。正式发布的 `v2.3.280` 使用 Agent `2.2.194` 和 ForwardX FXP runtime `2.2.117`；本次面板与 APK Release 更新为 `2.3.281`，携带尚未发布的 Agent `2.2.195` 和 ForwardX FXP runtime `2.2.118`。`scripts/build-agent-release.sh` 生成两种架构的 Agent、FXP 和 GOST runtime，六个文件均通过 `SHA256SUMS` 校验，机器类型分别为 Linux x86-64 与 ARM aarch64。

面板压缩包检查确认两个 FXP 文件与校验文件位于 `dist/agent`，`/api/agent/assets/v2.3.281/forwardx-fxp-linux-arm64` 返回有效 ELF 文件。升级脚本测试确认启用 `FORWARDX_AGENT_PANEL_FIRST` 后先访问面板，面板资产不可用时再访问 GitHub，FXP 下载失败时保留旧文件；升级段保留 Agent 配置和 SNI 运行状态，也没有增加全量停止 FXP 进程的命令，连接中断继续由既有 Agent 重启后的运行时更新行为决定。

两种架构的发布 FXP 文件均在对应 Linux 容器中报告 runtime `2.2.118`，并通过等价 GREASE ECH ClientHello 的真实套接字测试，落地机收到的握手字节与客户端发送内容一致。版本校验、TypeScript 类型检查、644 项面板测试、Agent 与 FXP 全量测试及静态检查、生产构建和发布包资产检查全部通过。
