# 卸载 ForwardX

本页说明如何卸载面板和 Agent（当前版本：面板 2.3.266 / Agent 2.2.181）。卸载前请先确认是否需要备份数据库、配置和日志。

::: warning 先备份
卸载可能删除服务、程序目录、容器或数据目录。生产环境建议先从面板导出备份，或手动备份数据库文件，再执行卸载。
:::

## 卸载前确认

建议先确认以下几点：

- 是否还需要保留用户、主机、规则、套餐和订单数据。
- 是否还需要保留 Agent 主机上的转发规则。
- 是否使用 Docker 部署目录中的 `forwardx-data` 保存 SQLite 数据。
- 是否使用外部 MySQL / PostgreSQL。

如果只是暂时停用，不建议直接卸载，可以先停止服务：

```bash
# Docker 面板
docker stop forwardx-panel

# 本地 systemd 面板
systemctl stop forwardx-panel

# Agent
systemctl stop forwardx-agent
```

## 卸载面板（Docker）

如果面板使用 Docker 安装，执行：

```bash
curl -fsSL https://raw.githubusercontent.com/owo10086/sni-panel/main/scripts/install-panel-docker.sh | bash -s -- uninstall
```

卸载完成后，检查是否还有残留容器或数据目录：

```bash
docker ps -a | grep forwardx
ls -la /opt/forwardx-docker
```

一键卸载会删除容器和部署目录，部署目录中的 `forwardx-data` 也会一并删除。对于旧版安装遗留的 Docker 数据卷，脚本会先读取面板容器实际挂载到 `/data` 的卷名并保存，然后尝试删除对应数据卷。旧数据卷仍被其他容器占用或 Docker 拒绝删除时，脚本会显示具体卷名并保留部署目录，以便再次执行卸载。

外部 MySQL/PostgreSQL 中的表和管理员账号不在 `forwardx-data` 中，一键卸载不会删除它们。重新安装后若仍连接同一个外部数据库，应继续使用原管理员凭据；需要全新初始化时，应先备份，再改用确认为空的新数据库。

只执行 `docker rm` 或 `docker compose down` 会保留 `/opt/forwardx-docker/forwardx-data`。需要判断当前容器的数据挂载来源时，可执行：

```bash
docker inspect forwardx-panel --format '{{range .Mounts}}{{println .Type .Name .Source .Destination}}{{end}}'
```

::: warning Docker 数据目录
Docker 部署的数据保存在 `/opt/forwardx-docker/forwardx-data`。删除容器不会自动删除该目录；删除部署目录会永久清除 SQLite 数据库和持久化配置。执行删除操作前应确认备份完整。
:::

## 卸载面板（本地 systemd）

如果面板使用本地 systemd 安装，执行：

```bash
curl -fsSL https://raw.githubusercontent.com/owo10086/sni-panel/main/scripts/install-panel-local.sh | bash -s -- uninstall
```

卸载完成后，检查服务和程序目录是否已清除：

```bash
systemctl status forwardx-panel
ls -la /opt/forwardx-panel
```

脚本可能保留数据目录，确认不再需要后手动删除（见下方"清理遗留文件"）。

## 卸载 Agent

在 Agent 所在服务器执行：

```bash
curl -fsSL https://raw.githubusercontent.com/owo10086/sni-panel/main/scripts/install-agent.sh | bash -s -- uninstall
```

确认服务已停止并移除：

```bash
systemctl status forwardx-agent
```

::: tip 只是换面板？
如果只是重新绑定到新面板，通常不需要卸载。在 Agent 主机重新执行当前面板提供的安装或升级命令即可。
:::

## 清理遗留文件

卸载脚本可能不会删除所有文件。根据需要手动清理：

**Agent 相关目录：**

```bash
# 配置文件
ls -la /etc/forwardx/
# 运行时数据
ls -la /var/lib/forwardx-agent/
# 日志
ls -la /var/log/forwardx-agent/
```

确认后手动删除：

```bash
rm -rf /etc/forwardx
rm -rf /var/lib/forwardx-agent
rm -rf /var/log/forwardx-agent
```

**面板相关目录（本地 systemd）：**

```bash
ls -la /opt/forwardx-panel
```

确认后手动删除：

```bash
rm -rf /opt/forwardx-panel
```

## 清理转发规则

正常卸载 Agent 时会尝试清理它维护的转发规则。如果怀疑仍有残留，可检查：

```bash
nft -a list table inet forwardx
iptables -t nat -S | grep -i forwardx
ip6tables -t nat -S | grep -i forwardx
```

如果使用 nftables，确认没有业务依赖后，可删除 ForwardX 表：

```bash
nft delete table inet forwardx
```

::: danger 谨慎操作
不要随意清空整台机器的 iptables 或 nftables 规则。服务器防火墙、Docker、面板和其他业务可能也依赖这些规则。只针对 ForwardX 相关条目进行清理。
:::

## 保留数据后重新安装

如果你保留了数据库和配置，重新安装时注意：

- 面板公开地址要填写当前可访问的域名或 IP，端口默认为 `9810`。
- 如果使用 HTTPS 反代，公开地址也要写 `https://`。
- Agent 失联时，在 Agent 主机重新执行当前面板提供的安装或升级命令。
- 外部数据库地址要从面板运行环境能访问；Docker 环境不要把 `127.0.0.1` 当成宿主机数据库地址。
