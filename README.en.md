# ForwardX Forwarding Management Panel

[简体中文](README.md) | [English](README.en.md)

Manage port forwarding, encrypted tunnels, failover, users and plans across Linux servers through lightweight agents. The panel manages configuration; forwarding runtimes on managed hosts carry business traffic. The panel does not store host SSH keys.

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)
[![Latest Release](https://img.shields.io/github/v/release/owo10086/sni-panel?display_name=tag&sort=semver)](https://github.com/owo10086/sni-panel/releases/latest)
[![Node.js](https://img.shields.io/badge/Node.js-22+-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Docker](https://img.shields.io/badge/Docker-Ready-2496ED?logo=docker&logoColor=white)](https://www.docker.com/)

[Documentation (Chinese)](https://poouo.github.io/Forwardx/) · [Downloads](https://github.com/poouo/Forwardx/releases/latest) · [English changelog](CHANGELOG.en.md) · [中文更新日志](CHANGELOG.md) · [Telegram Group](https://t.me/ForwardX_panel)

- [Documentation (Chinese)](https://owo10086.github.io/sni-panel/)
- [GitHub Releases](https://github.com/owo10086/sni-panel/releases/latest)
- [Changelog (English)](CHANGELOG.en.md) · [更新日志（中文）](CHANGELOG.md)
- [Telegram Group](https://t.me/ForwardX_panel)
- [Android APK](https://github.com/owo10086/sni-panel/releases/latest)

## Documentation Map

Detailed guides are currently in Chinese; this README provides English installation instructions.

- [Interface and common tasks](docs/guide/interface.md) · [Versions and documentation updates](docs/guide/releases.md)
- [Deployment overview](docs/guide/deploy-panel.md) · [Docker](docs/guide/deploy-docker.md) · [Local deployment](docs/guide/deploy-local.md)
- [Databases](docs/guide/database.md) · [HTTPS and proxies](docs/guide/reverse-proxy.md) · [Environment variables](docs/guide/env-vars.md)
- [Initial setup](docs/guide/first-setup.md) · [Agent installation](docs/guide/agent.md) · [Forwarding rules](docs/guide/rules.md)
- [Notifications](docs/guide/notifications.md) · [AI assistant](docs/guide/ai-assistant.md) · [Google sign-in](docs/guide/google-login.md)
- [Paths and logs](docs/guide/paths-logs.md) · [Account recovery](docs/guide/account-recovery.md) · [Upgrades and backups](docs/guide/upgrade-backup.md) · [Panel migration](docs/guide/migration.md)
- [Full documentation index](docs/guide/index.md) · [Local development](docs/guide/development.md) · [Plugin development](docs/guide/plugins.md)

## Features

- TCP, UDP and TCP+UDP rules using `iptables`, `nftables`, `realm`, `socat`, `gost` or `nginx`.
- GOST, ForwardX V1/V2 and Nginx Stream tunnels with multiple hops, entry/exit groups and multiple exits.
- Forwarding chains with fixed entry, relay and exit paths.
- Multi-entry failover with forwarding groups and DDNS; Cloudflare, Huawei Cloud, Alibaba Cloud, Tencent Cloud DNSPod and Webhook support.
- Host status, rule traffic, cumulative traffic, latency charts, topology maps, connectivity tests and system logs.
- User permissions, traffic/port quotas, plans, balances, redemption codes, discount codes and payment integrations.
- Email reminders, mutually exclusive Telegram / Discord notification channels (Telegram by default), panel/agent upgrades and the existing Android client. See the [notification setup guide](docs/guide/notifications.md).
- Optional Google sign-in, AI-assisted queries and confirmed operations, and administrator-controlled per-rule quotas.
- Human verification for sign-in/sign-up is enabled by default. Administrators can disable it under **Settings → System configuration** for HTTP browser compatibility without restarting. Passwords, sign-in rate limits, email verification and 2FA remain active. Use trusted HTTPS and keep verification enabled on public panels.
- Plugin stores, third-party stores and dynamic agent resource management APIs.

## 1. Choose a deployment method

Production requires a **single panel instance**. SQLite, MySQL and PostgreSQL are supported; an external database does not imply multi-replica support. Managed hosts require Linux, root access and connectivity to the panel.

| Method | Use case | Guide |
| --- | --- | --- |
| Port forwarding | Client → single host → target | A host that can reach the target directly |
| Tunnel | Client → entry → tunnel → exit → target | Separate entry/exit hosts or encrypted transport |
| Forwarding chain | Client → entry → relays → exit → target | A fixed multi-hop path |
| Forwarding group | Multiple entries → same target | High availability and DDNS failover |

Entry groups reuse multiple entry hosts; exit groups reuse multiple tunnel exits. Rules reference saved resources, so multiple rules can share the same resource.

## Mobile Clients

## Quick Deployment

The default panel port is `9810`. Run the following commands as `root`; otherwise replace `bash` with `sudo bash`.

### Docker Compose

Install:

```bash
curl -fsSL https://raw.githubusercontent.com/owo10086/sni-panel/main/scripts/install-panel-docker.sh | bash -s -- install --language en
```

Default host directory: `/opt/forwardx-docker`; container: `forwardx-panel`; container port: `3000`. Database configuration, SQLite and persistent data live in a named volume mounted at `/data`, **not in a data subdirectory of the default host deployment directory**.

### Linux local installation

```bash
curl -fsSL https://raw.githubusercontent.com/owo10086/sni-panel/main/scripts/install-panel-docker.sh | bash -s -- upgrade
```

Default directory: `/opt/forwardx-panel`; data: `/opt/forwardx-panel/data`; service: `forwardx-panel`. Supports systemd / OpenRC / SysV. The installer prepares Node.js 22+ and pnpm, then installs a Release bundle.

```bash
curl -fsSL https://raw.githubusercontent.com/owo10086/sni-panel/main/scripts/install-panel-docker.sh | bash -s -- uninstall
```

The installer selects and verifies a release image from `ghcr.io/owo10086/sni-panel` by default. Database configuration and SQLite data live in the deployment directory's `forwardx-data/`, mounted at `/data` in the container. Upgrades copy legacy named-volume contents into this directory. Upgrades preserve data and recognized core settings, but regenerate Compose and `.env`; back up and recheck custom environment variables, mounts and networking. Confirmed uninstall removes the container, deployment directory and its data, and handles legacy data volumes.

1. Open `http://SERVER_IP:9810`, check database settings and create the first administrator. Reused databases retain existing accounts.
2. Configure [HTTPS/reverse proxy](docs/guide/reverse-proxy.md) and set the public panel URL reachable by Agents.
3. In **Hosts → Token Management**, create a **separate Token for each host** and copy its installation command.
4. Run it as root on the managed Linux host and verify the Agent is online.
5. Create a link resource (port forward/tunnel), add a forwarding rule, then test real application traffic.

Example Agent installation:

```bash
curl -fsSL https://raw.githubusercontent.com/owo10086/sni-panel/main/scripts/install-panel-local.sh | bash -s -- install --language en
```

Replace the URL and Token. Inside Docker, `127.0.0.1` is not the host database address. NAT hosts need their actual mapped port ranges configured; allow ports through both security groups and host firewalls. See [Quick Start](docs/guide/quick-start.md), [Setup](docs/guide/first-setup.md) and [Agent installation](docs/guide/agent.md).

```bash
curl -fsSL https://raw.githubusercontent.com/owo10086/sni-panel/main/scripts/install-panel-local.sh | bash -s -- upgrade
```

New official installation/upgrade workflows register the four-letter command. In SSH, run:

```bash
curl -fsSL https://raw.githubusercontent.com/owo10086/sni-panel/main/scripts/install-panel-local.sh | bash -s -- uninstall
```

With one installed role, its menu opens directly. With both roles on the same host, choose panel or Agent first. Menus provide status, logs, restart, proxies, upgrades, repair and removal; the panel menu also offers administrator password reset. Manage Docker panels from the **host**, not the container. Non-root users run `sudo fwxm`.

```bash
fwxm panel status
fwxm panel restart
fwxm panel logs
fwxm panel address
fwxm panel reset-admin

fwxm agent status
fwxm agent restart
fwxm agent logs
fwxm agent upgrade
```

Older/manual deployments may not have this command. Official script-managed installations register it on upgrade; do not blindly apply default installers to manually managed deployments. [Full command and proxy guide](docs/guide/agent-proxy-manager.en.md).

## 4. Agent installation, runtime and upgrades through SOCKS

Downloading the bootstrap and running it are separate steps: **configure both proxies**.

```bash
# Docker
curl -fsSL "https://mirror.example.com/https://raw.githubusercontent.com/owo10086/sni-panel/main/scripts/install-panel-docker.sh" \
  | bash -s -- install --language en --github-accelerator "https://mirror.example.com"

# Local systemd
curl -fsSL "https://mirror.example.com/https://raw.githubusercontent.com/owo10086/sni-panel/main/scripts/install-panel-local.sh" \
  | bash -s -- install --language en --github-accelerator "https://mirror.example.com"
```

The installer saves `proxyUrl` in `/etc/forwardx/agent/config.json`; upgrades reuse it. Existing newer Agents can edit the field and restart, or use:

This does not proxy `ghcr.io` image pulls. Configure `FORWARDX_IMAGE` or `FORWARDX_IMAGE_REPO` separately. See [Deployment](https://owo10086.github.io/sni-panel/guide/deploy-panel) and [Upgrades & Backups](https://owo10086.github.io/sni-panel/guide/upgrade-backup) (Chinese).

`set` uses hidden input, saves and restarts Agent; `off` saves direct mode and restarts. Removing/clearing `proxyUrl` and restarting also means explicit direct mode, ignoring host proxy variables. Only management/download traffic is proxied, **not forwarding or network probes**.

Supports SOCKS5 / HTTP / HTTPS; SOCKS uses remote DNS. Dependency installation depends on package-manager support; preinstall Alpine APK dependencies when using SOCKS. Docker pulls need a separate Docker daemon HTTP/HTTPS proxy. Panel maintenance proxy settings do not proxy Node runtime traffic. See the [proxy guide](docs/guide/agent-proxy-manager.en.md).

## 5. Upgrades, backups and recovery

[Back up databases and configuration](docs/guide/upgrade-backup.md) first. With the manager:

```bash
fwxm panel upgrade
fwxm agent upgrade
```

For older script-managed deployments:

```bash
# Docker panel
curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-panel-docker.sh | bash -s -- upgrade

```bash
curl -fsSL https://raw.githubusercontent.com/owo10086/sni-panel/main/scripts/install-mimic.sh | sudo bash
```

In-place upgrades restart services/recreate containers; uninterrupted traffic is not guaranteed. Installers retain data and recognized settings, but regenerate `.env`/Compose. Back up and recheck custom variables, mounts and services. Downgrading binaries alone is not a safe rollback after database migrations.

Use a [trusted GitHub accelerator](docs/guide/deploy-docker.md#github-下载加速) if necessary. It is different from a SOCKS proxy and does not proxy GHCR image pulls.

For forgotten passwords use `fwxm panel reset-admin`, or the [older deployment recovery methods](docs/guide/account-recovery.md). Reinstallation does not reset accounts in an existing database. **Agent removal interrupts managed forwarding; confirmed Docker removal deletes its volume, while local removal can retain data.** See [removal guidance](docs/guide/uninstall.md).

## Documentation map

See [Environment Variables (Chinese)](https://owo10086.github.io/sni-panel/guide/env-vars) for database URLs, reverse proxies and upgrades. The panel automatically manages MySQL/PostgreSQL connection pools based on host count. Common variables (paths below are container/application defaults, overridden by the local installer; additional Docker `.env` variables must also be mapped into the container by Compose):

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `9810` | Panel port |
| `DATABASE_CONFIG_PATH` | `/data/database.json` | Database connection configuration file |
| `SQLITE_PATH` | `/data/forwardx.db` | SQLite data file |
| `DATABASE_TYPE` / `DB_TYPE` | Empty | Force `sqlite`, `mysql` or `postgresql` |
| `JWT_SECRET` | Automatically generated | Login signing secret; keep it fixed in production |
| `TELEGRAM_BOT_TOKEN` | Empty | Telegram bot token |
| `DISCORD_BOT_TOKEN` | Empty | Discord bot token; select and enable Discord in notification settings |
| `FORWARDX_IMAGE` | `ghcr.io/owo10086/sni-panel:latest` | Docker image |

See the [full index](docs/guide/index.md). Without a manual preference, language follows the installation hint during setup, then browser languages/trusted country hints; no extra third-party visitor IP lookup is made. Manual selection is saved in the current browser. Normal language switching reloads the page, so save changes first. The selector offers only Simplified Chinese / English.

## Mobile clients

Download Android APK or `forwardx-ios-v<version>-unsigned.ipa` from [GitHub Releases](https://github.com/poouo/Forwardx/releases/latest). iOS/iPadOS 15+ is supported. The IPA is **unsigned**: users provide certificates, signing and installation; App Store/TestFlight distribution is not provided.


## Local development

```bash
pnpm install
pnpm dev:panel
```

Requires Node.js 22+ and pnpm 10.28.1. `dev:panel` serves real pages at `http://127.0.0.1:5173` with isolated SQLite data under the repository's `.dev` and automatic developer-admin sign-in. **Never expose it publicly.** `pnpm dev` starts only the backend and is not the isolated launcher.

Checks: `pnpm exec tsc --noEmit`, `pnpm test:agent-proxy`, `pnpm test:server`, `pnpm build`, `pnpm docs:build`, `pnpm check:versions`. See [development](docs/guide/development.md).

## Security

Keep a fixed random `JWT_SECRET`, use HTTPS/strong passwords/least privilege, and disable public registration when unnecessary. Human verification defaults to enabled and can be disabled in system configuration; keep it enabled on public panels. Protect Agent/DDNS Tokens, proxy credentials and backups; verify restores. Never publish `.env`, database configuration or migration credentials.

## Support the author

USDT (TRON): `TGCVssNj5v58JPHxPZLLVQXsphQzLqQ3fK`

Solana: `8XvFdKNmESquSSJqhYepqqPJkWUqtBXn4jgeDjXyhzHU`

BNB Smart Chain: `0x44543FE6C5569Efe2b0Dc13454D4008378c92fE3`

USDT (Polygon): `0x44543FE6C5569Efe2b0Dc13454D4008378c92fE3`

## License

GNU Affero General Public License v3.0 only. See [LICENSE](LICENSE).

ForwardX Agent includes the third-party userspace WireGuard implementation under the MIT License. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Star history

[![Stargazers over time](https://starchart.cc/owo10086/sni-panel.svg)](https://starchart.cc/owo10086/sni-panel)

## 284 integration — unreleased

Panel stays at 3.3.8; Agent and FXP stay at 3.3.0. These features require the new local build; existing same-version release assets remain unchanged. Native apps are excluded.

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

Explicit management proxy example: `{"proxyUrl":"socks5h://127.0.0.1:1080"}`; `--proxy socks5h://127.0.0.1:1080`.

Only management and download traffic uses this proxy. Empty configuration means direct access without inheriting system proxy variables; proxy failure does not fall back to direct.
