# ForwardX Forwarding Management Panel

[简体中文](README.md) | [English](README.en.md)

Manage port forwarding, encrypted tunnels, users, plans and failover across Linux servers through lightweight Agents. The panel manages configuration; the forwarding programs on managed hosts carry business traffic. The panel does not store host SSH keys.

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)
[![Latest Release](https://img.shields.io/github/v/release/owo10086/sni-panel?display_name=tag&sort=semver)](https://github.com/owo10086/sni-panel/releases/latest)
[![Node.js](https://img.shields.io/badge/Node.js-22+-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Docker](https://img.shields.io/badge/Docker-Ready-2496ED?logo=docker&logoColor=white)](https://www.docker.com/)

[Documentation](https://owo10086.github.io/sni-panel/) · [Downloads](https://github.com/owo10086/sni-panel/releases/latest) · [English changelog](CHANGELOG.en.md) · [中文更新日志](CHANGELOG.md) · [Telegram Group](https://t.me/ForwardX_panel)

## Documentation map

Most detailed guides are in Chinese. English guides cover [Agent proxies](docs/guide/agent-proxy-manager.en.md), [SNI routing](docs/guide/sni-routing.en.md), [multi-entry direct forwarding](docs/guide/port-entry-groups.en.md), [experimental ny import](docs/guide/nyanpass-import.en.md) and [operations](docs/guide/operations.en.md).

- [Deployment](docs/guide/deploy-panel.md) · [Docker](docs/guide/deploy-docker.md) · [Local installation](docs/guide/deploy-local.md) · [Databases](docs/guide/database.md)
- [Initial setup](docs/guide/first-setup.md) · [Agent installation](docs/guide/agent.md) · [Rules](docs/guide/rules.md) · [Groups](docs/guide/groups.md)
- [Payments](docs/guide/payments.md) · [Billing](docs/guide/billing.md) · [Notifications](docs/guide/notifications.md) · [Users and plans](docs/guide/users-billing.md)
- [Backups](docs/guide/upgrade-backup.md) · [Migration](docs/guide/migration.md) · [Recovery](docs/guide/account-recovery.md) · [Full index](docs/guide/index.md)

## Features and local integration

- TCP, UDP and TCP+UDP forwarding through iptables, nftables, Realm, Socat, GOST or Nginx.
- GOST, ForwardX V1/V2 and Nginx Stream tunnels, plus fixed forwarding chains and reusable entry/exit groups.
- Direct port resources with simultaneous entries; SNI rules can share a TCP port and route each hostname to its saved destination.
- Per-entry status and diagnostics, resource traffic totals, accurate probe counts, source sampling and offline IP lookup.
- User permissions, rule quotas, plans, balances, payment integrations, billing pagination, affiliates and support tickets.
- Chinese/English interfaces, optional Google sign-in, AI-assisted confirmed operations, email and Telegram/Discord notifications.

Version **3.4.0** integrates upstream 283–285 and adds direct SNI forwarding through simultaneous port entry groups. Upgrade the panel and its matching Agent/FXP assets together; native applications remain excluded. V3 internals are included, while both the web form and API reject V3 creation/switching; existing V1/V2 tunnels keep their versions. Published assets are available from [this project’s Release](https://github.com/owo10086/sni-panel/releases/tag/v3.4.0). See [version and compatibility notes](docs/guide/releases.md).

## Deployment

Production requires one panel instance. SQLite, MySQL and PostgreSQL are supported; using an external database does not enable multiple panel replicas. Managed hosts need Linux, root access and a working connection to the panel.

Run as root, or replace the Bash command after the pipe with `sudo bash`. The default public port is `9810`.

### Docker Compose

```bash
curl -fsSL https://raw.githubusercontent.com/owo10086/sni-panel/main/scripts/install-panel-docker.sh | bash -s -- install --language en
```

Default directory: `/opt/forwardx-docker`; container: `forwardx-panel`; container port: `3000`. The installer selects and verifies an image from `ghcr.io/owo10086/sni-panel`. Data and database configuration live in the deployment directory's `forwardx-data/`, mounted at `/data`. Older deployments may use named volumes; inspect the actual mounts before backup or removal. Upgrades copy supported legacy-volume contents to the directory.

### Linux local installation

```bash
curl -fsSL https://raw.githubusercontent.com/owo10086/sni-panel/main/scripts/install-panel-local.sh | bash -s -- install --language en
```

Default directory: `/opt/forwardx-panel`; data: `/opt/forwardx-panel/data`; service: `forwardx-panel`. The installer prepares Node.js 22+ and pnpm and installs a Release bundle. Systemd, OpenRC and SysV installations are supported.

Installers preserve data and recognized core settings during upgrades but regenerate service/environment files. Back up and recheck custom environment variables, mounts and networking. Inside a container, `127.0.0.1` does not identify a database on the host.

## First setup and Agents

1. Open `http://SERVER_IP:9810`, confirm database settings and create the first administrator. An existing database keeps its accounts.
2. Configure [HTTPS](docs/guide/reverse-proxy.md) and a public panel URL reachable by Agents.
3. In **Hosts → Token Management**, create a separate Token for each host and copy its installation command.
4. Run the command as root on that host and confirm it comes online.
5. Create a link resource, add a forwarding rule and verify real application traffic.

Example, replacing the panel URL and Token:

```bash
curl -fsSL https://raw.githubusercontent.com/owo10086/sni-panel/main/scripts/install-agent.sh -o /tmp/forwardx-install-agent.sh
PANEL_URL='https://panel.example.com' bash /tmp/forwardx-install-agent.sh install YOUR_AGENT_TOKEN
```

NAT hosts need their actual mapped port ranges configured. Allow business ports through both cloud security groups and host firewalls. An online Agent or a saved rule does not prove that the destination can be reached.

## SSH management and management proxies

New installer/upgrade workflows register `fwxm`. Run it on the host, including for Docker panels; non-root users use `sudo fwxm`. With both panel and Agent installed, choose which role to manage.

```bash
fwxm panel status
fwxm panel restart
fwxm panel logs
fwxm panel reset-admin
fwxm agent status
fwxm agent restart
fwxm agent proxy set
fwxm agent proxy off
```

`proxy set` uses hidden input, saves the setting and restarts the Agent. Empty or removed `proxyUrl` means explicit direct access without inheriting system proxy variables; a failed configured proxy does not silently fall back to direct access. Only management and download requests use this proxy, not business forwarding or network probes.

Downloading the bootstrap and running the installer are separate stages. Configure both if a SOCKS proxy is needed:

```bash
curl --proxy 'socks5h://127.0.0.1:1080' -fsSL \
  https://raw.githubusercontent.com/owo10086/sni-panel/main/scripts/install-agent.sh \
  -o /tmp/forwardx-install-agent.sh
PANEL_URL='https://panel.example.com' bash /tmp/forwardx-install-agent.sh \
  install YOUR_AGENT_TOKEN --proxy 'socks5h://127.0.0.1:1080'
```

The setting is saved in `/etc/forwardx/agent/config.json`, for example `"proxyUrl":"socks5h://127.0.0.1:1080"`. Use the hidden prompt when credentials are needed. Dependency downloads depend on package-manager support; Docker image pulls require a separate daemon proxy. A GitHub accelerator changes download URLs and does not proxy GHCR pulls. See the [full proxy and manager guide](docs/guide/agent-proxy-manager.en.md).

## Upgrades, backups and recovery

[Back up configuration and databases](docs/guide/upgrade-backup.md) before maintenance. Installers restart services or recreate containers; in-place upgrades do not promise uninterrupted traffic.

```bash
fwxm panel upgrade
fwxm agent upgrade
```

For script-managed installations without the manager, use the matching installer:

```bash
# Docker panel
curl -fsSL https://raw.githubusercontent.com/owo10086/sni-panel/main/scripts/install-panel-docker.sh | bash -s -- upgrade
# Local panel
curl -fsSL https://raw.githubusercontent.com/owo10086/sni-panel/main/scripts/install-panel-local.sh | bash -s -- upgrade
```

Do not apply default installers blindly to manual deployments. Keep a matching database/configuration backup; replacing a binary alone is not a safe rollback after database changes. Full backups include optional operations history; essential backups can omit it. Affiliate records and probe counters retain the local restore protections.

Use `fwxm panel reset-admin` for forgotten administrator passwords, or follow the [recovery guide](docs/guide/account-recovery.md). Reinstallation does not reset accounts in an existing database. Removing an Agent interrupts forwarding; confirmed Docker uninstall removes the deployment directory and its data. Review [removal instructions](docs/guide/uninstall.md) first.

## Configuration and development

Common defaults are listed below. Local installers can override paths; Docker environment values must also be mapped into the container.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `9810` | Panel port |
| `DATABASE_CONFIG_PATH` | `/data/database.json` | Database configuration |
| `SQLITE_PATH` | `/data/forwardx.db` | SQLite file |
| `DATABASE_TYPE` / `DB_TYPE` | Empty | Force SQLite, MySQL or PostgreSQL |
| `JWT_SECRET` | Generated and persisted | Login signing secret |
| `FORWARDX_IMAGE` | `ghcr.io/owo10086/sni-panel:latest` | Docker image |

See [environment variables](docs/guide/env-vars.md) for complete settings. Language follows setup/browser hints unless manually selected; manual language changes are remembered in the current browser.

```bash
pnpm install
pnpm dev:panel
```

Development needs Node.js 22+ and pnpm 10.28.1. The launcher uses isolated SQLite data under `.dev`, real routes and automatic developer-admin sign-in on loopback addresses. Do not expose it publicly. Backend edits reload automatically while keeping development data. `pnpm dev` starts the ordinary backend, without the isolated launcher's guarantees.

Checks include `pnpm exec tsc --noEmit`, `pnpm test:server`, `pnpm build`, `pnpm docs:build`, `pnpm test:deployment-docs` and `pnpm check:versions`. Actual checks and manual acceptance are recorded separately; listing these commands is not evidence that all have passed. See [development](docs/guide/development.md).

## Security

Use HTTPS, strong passwords, least privilege and a fixed random `JWT_SECRET`. Human verification is enabled by default; administrators can change it in system settings without a restart. Protect Agent/DDNS Tokens, proxy credentials and backups. Never publish environment files, database credentials or private keys.

## Support the author

USDT (TRON): `TGCVssNj5v58JPHxPZLLVQXsphQzLqQ3fK`

Solana: `8XvFdKNmESquSSJqhYepqqPJkWUqtBXn4jgeDjXyhzHU`

BNB Smart Chain: `0x44543FE6C5569Efe2b0Dc13454D4008378c92fE3`

USDT (Polygon): `0x44543FE6C5569Efe2b0Dc13454D4008378c92fE3`

## License

GNU Affero General Public License v3.0 only. See [LICENSE](LICENSE).

ForwardX Agent includes the third-party userspace WireGuard implementation under the MIT License. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Star history

<a href="https://star-history.com/#owo10086/sni-panel&amp;Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=owo10086/sni-panel&amp;type=Date&amp;theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=owo10086/sni-panel&amp;type=Date" />
    <img alt="sni-panel Star History" src="https://api.star-history.com/svg?repos=owo10086/sni-panel&amp;type=Date" />
  </picture>
</a>
