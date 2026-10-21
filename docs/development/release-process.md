# 检查与发布操作说明

面板 3.5.2 起，日常 CI 和正式发布都调用 `.github/workflows/verify.yml`，实际命令只有一份，保存在 `scripts/verify.mjs`。任何检查失败都停止，不自动重跑来掩盖失败。

## 固定环境与本机检查

基线为 Ubuntu 24.04、Node 22.23.3、pnpm 10.28.1、Go 1.23.12。先运行 `pnpm install --frozen-lockfile`。Linux amd64 主机装好 Docker、iptables、iproute2、util-linux，并提供可用的 MySQL 8 服务后，设置 `FORWARDX_TEST_MYSQL_URL`，运行 `pnpm verify`。这会执行全部检查；缺少数据库或运行平台不符合时会报错，不以跳过代替通过。

单独排查可运行 `node scripts/verify.mjs prepare,language,functional,docs`、`node scripts/verify.mjs performance`、`node scripts/verify.mjs mysql` 或 `node scripts/verify.mjs agent`。先执行 prepare，保证依赖网页产物的检查不读旧文件。Mac 的测试通过只能作为开发依据，不能封存成 Linux 发布清单。

每组结果和完整命令日志保存在 `.release/checks/`。性能检查独立运行，文件并行数为 1；四类场景固定三轮，每轮 20 批、每批七条、最多六条并发，每批严格少于五秒。超时保留逐请求的完成数量及待完成阶段。DNS 两种并发场景各 100 次，FXP 在 1 核和 4 核各 1000 次，并运行竞态检查。

## 原检查与新入口的对应

| 原来源 | 新位置 | 保留内容 |
| --- | --- | --- |
| CI 面板检查 | prepare / language / functional / docs | 版本、双语说明、类型、网页构建、全部原 UI 和服务端脚本、AI、自测下发、文档构建 |
| 原 pretest:server | functional 显式执行 | 前置服务端和资源检查；关闭自动前后置脚本，避免隐式依赖或重复 |
| 原 SNI 批量矩阵 | performance 独立任务 | 四类、全部原行为断言、七条/六并发/五秒，固定三轮 |
| 原工单新增但未固定的测试 | test:sni-classification | 服务端及网页分类、域名异常、延迟存储及执行器 |
| CI MySQL 升级 | mysql | 真实 MySQL 8 历史升级、清理与保留检查；无连接配置即失败 |
| CI Agent/FXP | agent | 两模块 test/vet、真实 GOST、隔离网络的真实 FXP、Linux 端口限制 |
| 面板/Agent 发布检查 | agent | 单次二进制构建、真实发布 FXP 行为、稳定性及两模块 race |
| 独立 Docker 发布 | candidate | 从实际安装包解包组装镜像；按摘要启动、原生 SQLite、架构及内置二进制校验 |
| 独立文档发布 | docs 检查 + 最后收尾 | 构建一次、核对所有原页面与 build-info，最后部署同一份文档 |

旧 `release-agent.yml`、`docker-image.yml` 和 `docs.yml` 已合并到统一发布入口，避免多个工作流各自更新公开版本。

## 发布顺序

仅向 `owo10086/sni-panel` 的 main 推送。完成审查并获得推送、发布授权后，main 与新的版本标签一起推到 sni-panel；禁止向 origin 发布，不移动已有标签。当前面板 3.5.2，Agent/FXP 3.5.0，原生应用排除。

统一发布工作流只接受版本标签。日常检查产物与正式发布检查使用同一清单；本次发布检查内的产物构建一次，通过后交给后续步骤，不另取 main 或重建二进制。

1. 全部验证成功后，下载同提交的网页、服务端、文档、Agent 和检查证据。
2. 组装面板安装包；将同一份 Agent/FXP/GOST 放入安装包和独立附件，并核对逐文件校验值。
3. 从实际安装包解包生成镜像构建目录，只安装锁定的生产依赖；以摘要上传候选，不更新公开版本名或 latest。
4. 按摘要启动实际安装包组装的镜像，核对页面、原生 SQLite、amd64、面板版本、提交和三份二进制。
5. 封存 manifest.json：来源提交、各版本、完整检查记录、全部附件大小和 SHA256、镜像摘要。上传 verified-candidate 构建产物，保留 90 天。
6. 创建草稿 Release，先上传清单再上传附件。完整下载回来，逐个核对，禁止多余或缺失附件。
7. 核对成功后发布 Release，再更新镜像版本和 latest；最后部署此前构建的文档，回读文档提交与版本并再次核对公开资产。
8. 全部完成才写 `state.json` 的 complete。任何收尾中断都记 incomplete，不能因 Release 已公开就称整次发布完成。

下载、上传和可重复的远程操作最多三次，间隔五秒、十五秒。业务检查失败不重试、不放宽断言。各平台不能同时原子更新，正式公开之后发生的部分失败通过下述恢复处理。

## 中断后恢复

从失败运行下载 `release-state-*` 查看失败阶段；保留 verified-candidate 所在的运行编号。不要移动标签、重新构建或手改清单。

在 GitHub 的统一发布工作流中手动启动，选择**原来的版本标签**，填写 `resume_run` 为保存 verified-candidate 的原运行编号。恢复会下载原清单和原产物，重新核对来源、附件和远端状态，再以可重复步骤继续上传、发布、镜像及文档。它不信任“上次已做过”的本地标记，会再次回读远端。

如果公开 Release 中已有另一份清单、标签指向另一提交，或者更新的正式版本已经发布，恢复会拒绝，避免覆盖既有版本或倒退 latest。候选产物过期后不能宣称恢复了原产物，应另行制定新版本发布方案。

开发检查通过、人工验收通过、发布检查通过、正式发布完成分别记录依据。自动检查不代替用户业务验收；正式发布也不代表生产升级。
