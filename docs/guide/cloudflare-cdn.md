# Cloudflare 橙云接入

面板自带 HTTPS 能力，开启后监听端口会直接从 HTTP 切换为 HTTPS。把面板接入 Cloudflare CDN 时，由面板容器直接加载 Cloudflare 源站证书即可，不需要部署 Nginx、Caddy 或额外的反向代理容器。

接入后的访问链路：

```text
浏览器 / Agent → Cloudflare 橙云 → 宿主机 443 → ForwardX 容器 3000（内置 HTTPS）
```

本页基于 Docker Compose 部署。需要使用标准反向代理时，参考 [部署面板](./deploy-panel.md#配置域名和-https) 中的 Nginx 示例。

## 1. 选择面板端口

Cloudflare 橙云代理的 HTTPS 端口是固定的一组：`443`、`2053`、`2083`、`2087`、`2096`、`8443`。面板默认的 `9810` 不在其中，需要换用其中一个。

| 端口 | 适用情况 | 访问地址 |
| --- | --- | --- |
| `443` | 这台服务器只跑面板 | `https://panel.example.com` |
| `8443` | 这台服务器同时是转发节点 | `https://panel.example.com:8443` |

确认目标端口空闲，没有输出说明可用：

```bash
sudo ss -lntp | grep ':443 '
```

::: warning 转发节点上不要占用 443
443 是 SNI 分流最常用的入口端口，规则表单打开「SNI 分流转发」开关后会自动锁定到它。面板占用后，使用该端口的分流规则会无法启动，而面板不会对 SNI 分流的入口端口做占用探测，界面上不会有任何提示。这类服务器请选择 8443：在锁定的端口框右侧点击「修改入口端口」即可改写。
:::

## 2. 添加 DNS 记录

进入 Cloudflare 控制台的 **DNS** 页面，添加记录：

| 类型 | 名称 | 内容 | 代理状态 |
| --- | --- | --- | --- |
| A | `panel` | 服务器公网 IPv4 | 已代理（橙色云朵） |

服务器已配置 IPv6 时可以一并添加 AAAA 记录。

## 3. 生成源站证书

进入 Cloudflare 控制台：

```text
SSL/TLS -> 源服务器 -> 创建证书
```

主机名填写面板域名，例如 `panel.example.com`，密钥类型保持默认。创建后会显示**源站证书**和**私钥**两段内容，私钥只显示一次，离开页面前先复制保存。

## 4. 开启面板 SSL

用当前地址（例如 `http://服务器IP:9810`）登录面板，进入：

```text
系统设置 -> 系统信息 -> 面板 SSL 访问
```

| 设置项 | 配置 |
| --- | --- |
| 面板 SSL | 开启 |
| 证书来源 | 粘贴 PEM 内容 |
| 证书内容 | Cloudflare 源站证书 |
| 私钥内容 | Cloudflare 私钥 |

保存后面板会校验证书并自动重启，容器内的 3000 端口切换为 HTTPS。

此时通过 IP 访问会变成 `https://服务器IP:9810`，浏览器提示证书不受信任属于正常现象：Cloudflare 源站证书只用于 Cloudflare 与服务器之间，不由浏览器信任。

## 5. 修改部署配置

在部署目录的 `.env` 中设置对外端口。容器内部端口固定为 `3000`，不需要修改 `docker-compose.yml` 的 `ports` 段：

```bash
PORT=443
```

`FORWARDX_PUBLIC_PORT` 会自动跟随 `PORT`，不需要单独设置。

接着配置回源信任。套上 CDN 后，到达容器的请求源地址都是 Cloudflare 节点 IP，面板默认只信任回环地址，登录限流和登录日志会按 Cloudflare 节点计算。在 `docker-compose.yml` 的 `environment` 下增加一行，把变量传入容器：

```yaml
    environment:
      # ...保留原有配置
      FORWARDX_TRUST_PROXY: ${FORWARDX_TRUST_PROXY:-loopback}
```

再把 Cloudflare 回源网段写入 `.env`：

```bash
{ curl -s https://www.cloudflare.com/ips-v4; echo; \
  curl -s https://www.cloudflare.com/ips-v6; } \
  | grep -v '^$' | paste -sd, - \
  | sed 's/^/FORWARDX_TRUST_PROXY=/' >> .env
```

这里只填写网段列表。`FORWARDX_TRUST_PROXY` 的取值说明见 [环境变量](./env-vars.md#基础变量)。

## 6. 重建容器

```bash
docker compose up -d --force-recreate
docker compose logs --tail=100 forwardx | grep -i 'panel started'
```

日志中出现下面这行，且协议为 `HTTPS`，说明面板已按预期启动：

```text
[Server] ForwardX panel started on HTTPS port 3000 startupMs=... database=ready
```

服务器防火墙和云厂商安全组需要放行选定的面板端口。

## 7. 配置 Cloudflare

进入 `SSL/TLS -> 概述`，加密模式选择**完全（严格）**。该模式会校验面板加载的源站证书，Cloudflare 到服务器之间同样使用 HTTPS。「灵活」模式会让回源退回明文 HTTP，不要使用。

进入 `SSL/TLS -> 边缘证书`，开启**始终使用 HTTPS**。

进入 `速度 -> 优化`，关闭 **Rocket Loader** 和 **Auto Minify**。面板是单页应用，这两项功能会改写前端资源。

缓存保持默认即可，默认规则只缓存静态资源。自建缓存规则时需要排除 `/api/*`，面板的登录、实时状态、Agent 心跳和配置接口都在这个前缀下。

需要进一步限制直连源站时，可以只放行 Cloudflare 回源访问面板端口：

```bash
for cidr in $(curl -s https://www.cloudflare.com/ips-v4); do
  sudo ufw allow proto tcp from "$cidr" to any port 443 comment 'cloudflare'
done
```

这台服务器上的转发端口、分流端口和隧道端口仍需对公网开放，不要追加全局拒绝规则。

## 8. 填写面板公开访问地址

用域名登录面板，进入：

```text
系统设置 -> 系统信息 -> 面板公开访问地址
```

填写对外地址：

```text
https://panel.example.com
```

使用 443 时不需要写端口，使用 8443 时需要带上 `:8443`。

已安装的 Agent 需要检查保存的面板地址，仍使用旧地址的按 [安装 Agent](./agent.md) 重新执行安装或升级命令。进入「主机管理」，各主机保持绿色在线状态，说明接入完成。

::: tip 面板公开地址要和实际访问地址一致
该地址用于 Agent 安装命令、Agent 回连、面板升级和支付回调。留空或仍指向 `http://服务器IP:9810` 时，Agent 可能继续使用旧地址导致离线。
:::

## 橙云不能代理的流量

普通橙云只代理 HTTP 和 HTTPS 流量。

| 流量类型 | 橙云代理 |
| --- | --- |
| 面板 HTTPS 访问 | 支持 |
| Agent 回连与心跳 | 支持 |
| 面板静态资源 | 支持 |
| TCP / UDP 端口转发 | 不支持 |
| SNI 四层透传 | 不支持 |
| GOST、WireGuard 等隧道端口 | 不支持 |

项目中创建的转发端口仍需通过服务器真实 IP 或另一个**仅 DNS**（灰云）域名访问。Cloudflare Spectrum 可以代理部分四层协议，属于单独付费产品，普通橙云不包含该能力。
