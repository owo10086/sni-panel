# ForwardX 转发管理面板

[简体中文](README.md) | [English](README.en.md)

通过轻量 Agent 统一管理多台 Linux 服务器的端口转发、加密隧道、故障转移、用户与套餐。面板负责管理，业务流量由被管理主机上的运行时转发；面板不保存主机 SSH 密钥。

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)
[![Latest Release](https://img.shields.io/github/v/release/owo10086/sni-panel?display_name=tag&sort=semver)](https://github.com/owo10086/sni-panel/releases/latest)
[![Node.js](https://img.shields.io/badge/Node.js-22+-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Docker](https://img.shields.io/badge/Docker-Ready-2496ED?logo=docker&logoColor=white)](https://www.docker.com/)

[使用文档](https://owo10086.github.io/sni-panel/) · [发布下载](https://github.com/owo10086/sni-panel/releases/latest) · [中文更新日志](CHANGELOG.md) · [English changelog](CHANGELOG.en.md) · [Telegram 群组](https://t.me/ForwardX_panel)

- [使用文档](https://owo10086.github.io/sni-panel/)
- [GitHub Releases](https://github.com/owo10086/sni-panel/releases/latest)
- [更新日志（中文）](CHANGELOG.md) · [Changelog (English)](CHANGELOG.en.md)
- [Telegram 群组](https://t.me/ForwardX_panel)
- [Android APK](https://github.com/owo10086/sni-panel/releases/latest)

## 功能概览

- TCP / UDP / TCP+UDP 转发，支持 iptables、nftables、Realm、socat、GOST、Nginx。
- GOST、ForwardX V1/V2、Nginx Stream 隧道，以及固定多跳转发链、入口组、出口组和故障转移。
- 主机监控、规则流量与限额、延迟历史、在线率、链路自测和诊断日志。
- 多用户权限、套餐、账单、余额、支付、工单及可选 AFF 推广返佣。
- 邮件、Telegram / Discord 通知，Google 登录、AI 助手、插件和中英文界面。
- 保留已有 Android 客户端及 Linux SSH 管理命令 `fwxm`；本轮不更新原生应用。

## 1. 选择部署方式

- 创建 TCP、UDP 或 TCP+UDP 规则，支持 `iptables`、`nftables`、`realm`、`socat`、`gost` 和 `nginx`。
- 管理 GOST、ForwardX V1/V2 和 Nginx Stream 隧道，支持多跳、入口组、出口组和多出口。
- 使用转发链组织固定的入口、中转和出口路径。
- 使用转发组和 DDNS 实现多入口故障转移，支持 Cloudflare、华为云、阿里云、腾讯云 DNSPod 和 Webhook。
- 查看主机状态、规则流量、累计流量、延迟趋势、链路图、自测结果和系统日志。
- 管理用户权限、流量与端口额度、套餐、余额、兑换码、折扣码和支付通道。
- 支持邮件提醒、Telegram / Discord 通知渠道二选一（默认 Telegram）、面板与 Agent 更新，以及已有 Android 客户端。
- 提供可选 Google 登录、AI 自然语言查询与确认操作、管理员单条规则限额。
- 登录/注册人机验证默认开启，可在「系统设置 → 系统配置」中关闭并保存以处理部分 HTTP 浏览器兼容问题；不影响密码、登录限流、邮箱验证及 2FA，公网部署推荐使用 HTTPS 并保持开启。
- 提供插件商店、第三方商店和 Agent 动态资源管理接口。

| 方式 | 适用场景 | 详细说明 |
| --- | --- | --- |
| 端口转发 | 用户 -> 单台主机 -> 目标 | 单台主机可直接访问目标 |
| 隧道 | 用户 -> 入口 -> 隧道 -> 出口 -> 目标 | 入口和出口不同，或需要加密链路 |
| 转发链 | 用户 -> 入口 -> 中转 -> 出口 -> 目标 | 固定多跳路径 |
| 转发组 | 多个入口 -> 同一目标 | 多入口高可用和 DDNS 故障转移 |

入口组用于复用多台入口主机，出口组用于复用多个隧道出口。规则引用已保存的资源，因此同一资源可以供多条规则使用。

## 快速部署

面板默认访问端口为 `9810`。以下命令请使用 `root` 执行；非 `root` 环境可将 `bash` 替换为 `sudo bash`。

下方安装命令传入 `--language zh-CN`，首次部署向导默认中文；英文 README 的命令传入 `--language en`，默认英文。向导右上角可切换简体中文 / English，界面直接更新且保留表单输入；用户选择保存在浏览器并优先生效。两个安装脚本均支持 `--language auto`（改用浏览器 / IP 判断），或通过 `FORWARDX_SETUP_LANGUAGE=zh-CN` / `en` 传入。升级保留原值；初始化完成后，自动模式恢复正常浏览器 / IP 判断。

### Docker Compose

安装：

```bash
curl -fsSL https://raw.githubusercontent.com/owo10086/sni-panel/main/scripts/install-panel-docker.sh | bash -s -- install --language zh-CN
```

默认目录 `/opt/forwardx-docker`，容器 `forwardx-panel`；宿主机端口映射容器 `3000`。数据库配置、SQLite 和其他持久化数据位于部署目录的 `forwardx-data/`，挂载到容器 `/data`；旧部署可能使用命名卷，请先核对实际挂载。

### Linux 本地安装

```bash
curl -fsSL https://raw.githubusercontent.com/owo10086/sni-panel/main/scripts/install-panel-local.sh | bash -s -- install --language zh-CN
```

默认目录 `/opt/forwardx-panel`，数据目录 `/opt/forwardx-panel/data`，服务 `forwardx-panel`；支持 systemd / OpenRC / SysV。安装器准备 Node.js 22+ 和 pnpm，并安装 Release 发布包。

Docker 默认使用 `ghcr.io/owo10086/sni-panel` 仓库，由脚本选择并校验发布镜像。数据库配置和 SQLite 数据在部署目录的 `forwardx-data/` 中，挂载到容器 `/data`；旧版命名卷升级时会复制到该目录。升级保留数据和脚本识别的核心配置，但会重新生成 Compose 与 `.env`；自定义环境、网络和挂载需备份并核对。卸载脚本经确认后会删除容器、部署目录及其中数据，并处理旧数据卷。

1. 打开 `http://服务器IP:9810`，核对数据库并创建首个管理员。复用旧数据库时使用原账号。
2. 配置 [HTTPS 与反向代理](docs/guide/reverse-proxy.md)，在系统设置填写 Agent 可访问的面板公开地址。
3. 在「主机管理 → Token 管理」为**每台主机分别创建 Token**，复制该主机的安装命令。
4. 在被管理 Linux 主机以 root 执行，确认 Agent 在线。
5. 先创建端口转发 / 隧道等链路资源，再添加规则并用真实业务验证。

Agent 安装示例：

```bash
curl -fsSL https://raw.githubusercontent.com/owo10086/sni-panel/main/scripts/install-agent.sh -o /tmp/forwardx-install-agent.sh
PANEL_URL='https://panel.example.com' bash /tmp/forwardx-install-agent.sh install YOUR_AGENT_TOKEN
```

替换实际地址和 Token。Docker 连接宿主机数据库时，不要把 `127.0.0.1` 当成宿主机。NAT 主机要配置实际映射端口段，安全组与系统防火墙均需放行对应端口。详见 [快速开始](docs/guide/quick-start.md)、[首次初始化](docs/guide/first-setup.md)、[Agent 安装](docs/guide/agent.md)。

## 3. SSH 日常管理

新版官方安装/升级流程会注册四字母命令。SSH 中直接输入：

```bash
fwxm
```

仅安装一种组件时进入对应菜单；同机安装面板与 Agent 时先选择对象。菜单提供运行状态、日志、重启、代理设置、升级、重装修复和卸载；面板额外提供管理员密码重置。Docker 面板在**宿主机**使用，非 root 使用 `sudo fwxm`。

```bash
fwxm panel status
fwxm panel restart
fwxm panel logs
fwxm panel reset-admin
fwxm agent status
fwxm agent restart
```

旧版本或手工部署未必有该命令；使用对应官方安装器升级后才能注册，手工部署不要直接套用默认安装流程。[完整命令与适用范围](docs/guide/agent-proxy-manager.md)。

## 4. Agent 通过 SOCKS 代理安装、运行与升级

下载入口脚本和执行安装是两个阶段，**两处都要指定代理**：

```bash
curl --proxy 'socks5h://127.0.0.1:1080' -fsSL \
  https://raw.githubusercontent.com/owo10086/sni-panel/main/scripts/install-agent.sh \
  -o /tmp/forwardx-install-agent.sh

PANEL_URL='https://panel.example.com' bash /tmp/forwardx-install-agent.sh \
  install YOUR_AGENT_TOKEN --proxy 'socks5h://127.0.0.1:1080'
```

代理保存到 `/etc/forwardx/agent/config.json` 的 `proxyUrl`，升级默认沿用。已有新版 Agent 可编辑该字段并重启，或使用：

```bash
fwxm agent proxy show
fwxm agent proxy set
fwxm agent proxy off
```

`set` 通过隐藏输入保存代理并重启 Agent，`off` 保存直连设置并重启。代理只影响管理及下载，不影响业务转发或网络探测；空配置不继承系统代理，代理失效不自动改成直连。GitHub 下载加速与管理代理分别配置，均不代理 `ghcr.io` 镜像拉取，详见[代理指南](docs/guide/agent-proxy-manager.md)及[部署说明](docs/guide/deploy-panel.md)。

支持 SOCKS5 / HTTP / HTTPS，SOCKS 域名由代理解析。系统依赖安装仍取决于包管理器；Alpine APK 使用 SOCKS 时需预装依赖。Docker 镜像拉取需单独配置 Docker daemon 的 HTTP/HTTPS 代理；面板维护代理不等同于 Node 运行代理。详见 [代理指南](docs/guide/agent-proxy-manager.md)。

## 5. 升级、备份与恢复

升级前 [备份数据库和配置](docs/guide/upgrade-backup.md)。有 `fwxm` 时：

```bash
fwxm panel upgrade
fwxm agent upgrade
```

旧版脚本部署：

```bash
# Docker 面板
curl -fsSL https://raw.githubusercontent.com/owo10086/sni-panel/main/scripts/install-panel-docker.sh | bash -s -- upgrade
# 本地面板
curl -fsSL https://raw.githubusercontent.com/owo10086/sni-panel/main/scripts/install-panel-local.sh | bash -s -- upgrade
```

原地升级会重启服务或重建容器，不保证业务不断。脚本保留数据和识别的核心配置，但会重写 `.env` / Compose，自定义环境、挂载与服务配置需备份核对。数据库已升级时，换回旧程序不等于安全回退。

GitHub 访问受限时使用 [可信加速站](docs/guide/deploy-docker.md#github-下载加速)；它与 SOCKS 代理不同，不代理 GHCR 镜像拉取。

忘记密码使用 `fwxm panel reset-admin`，旧部署见 [账号恢复](docs/guide/account-recovery.md)。重装不会重置旧数据库管理员。**卸载 Agent 会中断受管转发；Docker 卸载确认后删除部署目录及其中数据，本地卸载可选择保留数据**，详见 [卸载说明](docs/guide/uninstall.md)。

## 文档导航

| 主题 | 文档 |
| --- | --- |
| 安装与初始化 | [部署准备](docs/guide/preparation.md) · [Docker](docs/guide/deploy-docker.md) · [本地](docs/guide/deploy-local.md) · [数据库](docs/guide/database.md) |
| 日常维护 | [SSH 管理与代理](docs/guide/agent-proxy-manager.md) · [目录与日志](docs/guide/paths-logs.md) · [环境变量](docs/guide/env-vars.md) |
| 转发与计量 | [规则](docs/guide/rules.md) · [隧道](docs/guide/tunnels.md) · [转发链](docs/guide/port-chains.md) · [组](docs/guide/groups.md) · [流量与延迟](docs/guide/traffic-latency.md) |
| 本轮新增教程 | [多入口端口直连](docs/guide/port-entry-groups.md) · [SNI 分流](docs/guide/sni-routing.md) · [ny 实验导入](docs/guide/nyanpass-import.md) · [运维看板](docs/guide/operations.md) · [账单](docs/guide/billing.md) · [支付](docs/guide/payments.md) |
| 账户与通知 | [用户套餐](docs/guide/users-billing.md) · [通知](docs/guide/notifications.md) · [工单](docs/guide/support-tickets.md) · [推广](docs/guide/affiliates.md) |
| 扩展与恢复 | [Google 登录](docs/guide/google-login.md) · [AI](docs/guide/ai-assistant.md) · [插件](docs/guide/plugins.md) · [迁移](docs/guide/migration.md) · [排障](docs/guide/troubleshooting.md) |

数据库地址、反向代理和升级相关变量见[环境变量文档](https://owo10086.github.io/sni-panel/guide/env-vars)。MySQL/PostgreSQL 连接池由面板根据主机数量自动管理。常用变量如下（路径为容器/程序默认值，本地安装器会覆盖；Docker `.env` 中新增变量还需由 Compose 映射到容器）：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `9810` | 面板访问端口 |
| `DATABASE_CONFIG_PATH` | `/data/database.json` | 数据库连接配置文件 |
| `SQLITE_PATH` | `/data/forwardx.db` | SQLite 数据文件 |
| `DATABASE_TYPE` / `DB_TYPE` | 空 | 强制指定 `sqlite`、`mysql` 或 `postgresql` |
| `JWT_SECRET` | 自动生成 | 登录签名密钥；生产环境应固定配置 |
| `TELEGRAM_BOT_TOKEN` | 空 | Telegram 机器人 Token |
| `DISCORD_BOT_TOKEN` | 空 | Discord 机器人 Token；在通知设置中选择 Discord 并启用 |
| `FORWARDX_IMAGE` | `ghcr.io/owo10086/sni-panel:latest` | Docker 镜像 |

## 界面语言

支持简体中文与 English。首次部署使用安装命令的语言提示；未手动选择时继续参考浏览器语言和可信地区提示。手动选择保存在当前浏览器，切换前请保存尚未提交的修改。

## 本地开发

```bash
pnpm install
pnpm dev:panel
```

需要 Node.js 22+、pnpm 10.28.1。`dev:panel` 在 `http://127.0.0.1:5173` 启动真实页面，使用项目 `.dev` 中的隔离 SQLite 数据和开发管理员自动登录，**禁止暴露公网**。`pnpm dev` 仅直接启动后端，不是隔离开发启动器。

验证：`pnpm exec tsc --noEmit`、`pnpm test:agent-proxy`、`pnpm test:server`、`pnpm build`、`pnpm docs:build`、`pnpm check:versions`。详见 [开发指南](docs/guide/development.md)。

## 安全建议

固定随机 `JWT_SECRET`，启用 HTTPS、强密码及最小权限；不需要注册时关闭入口。登录人机验证默认开启，管理员可在系统配置关闭，但公网推荐保持开启。保护 Agent / DDNS Token、代理凭据和备份，定期验证恢复；不要公开 `.env`、数据库配置或迁移密钥。

## 给作者充点克劳德

USDT (TRON)：`TGCVssNj5v58JPHxPZLLVQXsphQzLqQ3fK`

Solana：`8XvFdKNmESquSSJqhYepqqPJkWUqtBXn4jgeDjXyhzHU`

BNB Smart Chain：`0x44543FE6C5569Efe2b0Dc13454D4008378c92fE3`

USDT (Polygon)：`0x44543FE6C5569Efe2b0Dc13454D4008378c92fE3`

## License

GNU Affero General Public License v3.0 only. See [LICENSE](LICENSE).

ForwardX Agent also includes the third-party userspace WireGuard implementation under the MIT License. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Star 趋势

[![Stargazers over time](https://starchart.cc/owo10086/sni-panel.svg)](https://starchart.cc/owo10086/sni-panel)

## 285 合并：未发布

面板保持 3.3.8，Agent／FXP 保持 3.3.0。本轮在本地 284 基础上整合上游 285，新增功能需要本轮实际构建，既有同版本正式附件保持原状。原生应用排除，本轮尚未发布。V3 仅合入底层，网页和接口均不开放新建或切换，已有 V1／V2 不转换；实际检查与人工验收分别记录，见[版本说明](docs/guide/releases.md)。

[Agent proxy](docs/guide/agent-proxy-manager.en.md) · [SSH management](docs/guide/ssh-management.md) · [Affiliates](docs/guide/affiliates.md) · [Support tickets](docs/guide/support-tickets.md)

```bash
fwxm panel status
fwxm panel restart
fwxm panel reset-admin
fwxm agent status
fwxm agent restart
fwxm agent proxy off
pnpm dev:panel
```

明确配置管理代理的例子：`{"proxyUrl":"socks5h://127.0.0.1:1080"}`; `--proxy socks5h://127.0.0.1:1080`.

代理只影响管理及下载；空配置直连，不继承系统代理，失效不自动回退。推广和工单默认关闭，30 天历史不补造未知时段，也不拼接历次主备切换。
