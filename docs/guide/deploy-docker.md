# Docker 部署

支持一键安装与手动 Compose 两种方式。默认容器名为 forwardx-panel，Compose 服务名为 forwardx，宿主机端口 9810 映射到容器端口 3000。

## 一键安装（推荐）

使用 root 执行；非 root 将管道后的 bash 替换为 sudo bash。

~~~bash
curl -fsSL https://raw.githubusercontent.com/owo10086/sni-panel/main/scripts/install-panel-docker.sh | bash -s -- install --language zh-CN
~~~

安装时按提示选择访问端口和数据库。SQLite 无需额外数据库服务；MySQL/PostgreSQL 需要准备可访问的数据库和账号。脚本可能预填数据库配置，网页仍需确认连接并完成初始化。

访问 http://服务器IP:9810（端口以安装时选择为准）。英文向导使用 --language en；跟随浏览器语言使用 --language auto，网页可手动切换。

脚本会选择并校验发布镜像；默认镜像仓库为 ghcr.io/owo10086/sni-panel。新版本镜像尚未构建完成时不要强行替换正在运行的容器。

## 数据与配置

| 项目 | 默认位置 |
| --- | --- |
| 宿主机部署目录 | /opt/forwardx-docker |
| Compose 与环境配置 | docker-compose.yml、.env（位于部署目录） |
| 容器程序 | /app |
| 容器持久化数据 | /data |
| 宿主机数据目录 | 部署目录下的 forwardx-data，默认 /opt/forwardx-docker/forwardx-data |
| 数据库连接配置 | /data/database.json |
| SQLite 文件 | /data/forwardx.db |

旧版可能使用命名卷，当前脚本和仓库 Compose 将部署目录中的 `forwardx-data` 挂载到容器 `/data`。通过以下命令确认实际挂载，不要凭目录名判断数据是否存在：

~~~bash
docker inspect forwardx-panel --format '{{range .Mounts}}{{println .Type .Name .Source .Destination}}{{end}}'
~~~

安装脚本会复用已有数据目录；从旧版命名卷升级时会复制旧卷内容到该目录。删除容器会保留目录，删除部署目录会同时删除 SQLite 数据和配置。不要随意更换数据挂载或使用 `down -v`；自定义挂载以实际配置为准。

## 日常管理

新版官方安装/升级后，在**宿主机 SSH** 直接输入 `fwxm` 打开交互菜单；同机装有 Agent 时先选择面板。常用命令：

~~~bash
fwxm panel status
fwxm panel restart
fwxm panel logs
fwxm panel address
fwxm panel reset-admin
~~~

详见 [SSH 管理菜单](./ssh-management.md)。旧版或手工部署未注册该命令时，使用原生 Docker 命令：

~~~bash
docker ps --filter name=forwardx-panel
docker logs --tail 300 forwardx-panel
docker restart forwardx-panel
~~~

上面的 restart 只重启已有容器，**不会重新读取修改后的 Compose 环境变量**。修改环境配置后需要重建容器，详见 [环境变量](./env-vars.md)。

脚本管理的部署使用脚本升级：

已有新版管理命令时可使用 `fwxm panel upgrade`；否则执行下方入口脚本。

~~~bash
curl -fsSL https://raw.githubusercontent.com/owo10086/sni-panel/main/scripts/install-panel-docker.sh | bash -s -- upgrade
~~~

升级会保留数据和脚本识别的核心配置，但脚本会重新生成 Compose 和 .env，**不会原样保留所有手动追加的内容**。升级前备份配置并核对自定义挂载、网络和环境变量。完整流程见 [升级与备份](./upgrade-backup.md)。

## 手动 Compose 部署

适合已经安装 Docker Engine 与 Compose 插件、能够自行维护配置的用户。使用独立目录，避免与安装脚本管理的目录混用。以下目录和 Docker 操作需要 root 权限；可先执行 `sudo -i`，或逐条使用适当的 sudo 权限，包括创建和编辑 `.env`。

~~~bash
sudo mkdir -p /opt/forwardx-compose
cd /opt/forwardx-compose
sudo curl -fsSL https://raw.githubusercontent.com/owo10086/sni-panel/main/docker-compose.yml -o docker-compose.yml
openssl rand -hex 32
~~~

用编辑器创建 .env，填写下列配置；将 JWT_SECRET 的提示文字替换为上一步生成的随机值，不能使用仓库里的示例密钥：

~~~ini
COMPOSE_PROJECT_NAME=forwardx
FORWARDX_CONTAINER_NAME=forwardx-panel
FORWARDX_IMAGE=ghcr.io/owo10086/sni-panel:latest
PORT=9810
FORWARDX_SETUP_LANGUAGE=zh-CN
JWT_SECRET=替换为随机密钥
~~~

建议生产环境将 FORWARDX_IMAGE 固定为已发布且构建完成的版本标签。使用 main 分支 Compose 时先核对它与所选镜像支持的配置是否一致。保护 .env 的读取权限。

~~~bash
sudo chmod 600 .env
sudo docker compose up -d forwardx
sudo docker compose logs --tail 300 forwardx
~~~

默认只有面板服务，不包含 MySQL/PostgreSQL 容器；可以在网页配置外部数据库。数据库地址见 [数据库配置](./database.md)。

## 手动升级

在面板的更新提示或「系统设置 → 检查更新」中，默认显示「手动升级」。复制命令后，在面板服务器以 root 身份执行。命令会使用提示中的目标版本；以后发布新版本时，命令中的版本号也会随之变化。

命令从当前 `forwardx-panel` 容器读取原部署目录、项目名和服务名，使用该目录里的 `docker-compose.yml`，并依次完成：

1. 准备只修改面板镜像版本的新配置，核对它能够被 Docker Compose 读取。
2. 下载目标版本镜像。下载失败时停止，原配置和容器保持原状。
3. 备份原配置为 `docker-compose.yml.bak-日期时间`，再把面板镜像改为目标版本。
4. 只重新创建面板容器，继续使用原数据目录，随后核对容器内实际程序版本。

这也适用于此前写死旧版本标签或镜像摘要的部署，以及从 `.env` 读取旧镜像的部署；命令会在 Compose 的面板服务中明确写入目标版本。它不会重写 `.env`、重启其他服务或自动删除旧镜像。

升级前请备份数据库。如修改过容器名，先调整命令开头的 `PANEL_CONTAINER`。该命令适用于本仓库提供的 `docker-compose.yml` 格式；自定义文件名、缩进或多文件合并部署，应先核对原启动配置。找不到部署目录或不能唯一识别面板镜像时，命令会停止。

执行成功时，终端显示 `ForwardX panel version: 目标版本`。刷新面板，在系统设置中核对版本；也可以单独检查：

~~~bash
docker exec forwardx-panel node -p 'require("./package.json").version'
~~~

「一键脚本」仍适用于由安装器管理的部署，会重新生成部署目录中的 Compose 和 `.env` 配置。手动部署应使用上述手动升级命令，保留自己的部署设置。不要通过卸载或删除数据目录来升级。

## GitHub 下载加速

下面是格式示例，mirror.example.com 必须替换为你信任且实际可用的加速站：

~~~bash
curl -fsSL "https://mirror.example.com/https://raw.githubusercontent.com/owo10086/sni-panel/main/scripts/install-panel-docker.sh" \
  | bash -s -- install --language zh-CN --github-accelerator "https://mirror.example.com"
~~~

脚本保存加速地址，后续升级可复用。该参数仅代理 GitHub 下载，不代理 ghcr.io；镜像源使用 FORWARDX_IMAGE / FORWARDX_IMAGE_REPO 单独配置。

## 下一步

完成 [首次初始化](./first-setup.md)，配置 [HTTPS](./reverse-proxy.md)。需要找文件、查看日志或恢复管理员时，分别参考 [目录与日志](./paths-logs.md)、[账号恢复](./account-recovery.md)。

卸载脚本经确认后会删除容器、部署目录及其中数据，并处理旧版数据卷；不是“停止服务”的替代命令。操作前阅读 [卸载说明](./uninstall.md)。
