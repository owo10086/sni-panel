# SNI 入口组真实连接验证

日期：2026-10-19。面板代码检查点：`f36c7de570739121f4ac54f050e77829c7014d9b`。这次只运行隔离检查和补充证据，没有修改 SNI 业务代码或主任务的回归文件，没有提交、推送或连接生产。

## 输入来自真实保存和心跳

输入为主任务 `server/sniForwardGroup.test.ts` 中 “port entry SNI uses each entry directly and confirms all resources before DNS inclusion” 场景导出的四份心跳配置。场景实际经过保存入口组、建立三条域名规则、修改其中一个落地、接收主机心跳，再导出面板派发的内容。

四份原文件已原样保存到本目录 `port-sni-heartbeats/`。它们与 `/tmp/forwardx-285-implementation/port-sni-network/` 中主任务导出逐字节一致，文件摘要记录在 `port-sni-network-result.json`。另外独立运行同一回归也通过，导出的四份文件摘要均与主任务一致。

没有手写域名、落地、成员编号、限速或内容版本来替代心跳。为了让同一隔离环境同时启动两个入口，运行时只添加监听位置和控制文件路径：A 使用 `127.0.0.1`，B 使用 `::1`。两者保持心跳中的同一入口端口 `18443`，由两个独立 FXP 进程提供服务。

| 域名 | 开始时落地 | 修改后的落地 |
| --- | --- | --- |
| `parallel-0.example.test` | `203.0.113.10:19443` | `203.0.113.99:19443` |
| `parallel-1.example.test` | `203.0.113.20:20443` | 不变 |
| `third.example.test` | `203.0.113.30:21443` | 不变 |

例如，先只让 A 收到第一条域名的新落地：新连 A 会到 `.99`，同一时刻新连 B 仍到 `.10`；另外两个域名在 A、B 上已建立的连接都继续收发。之后再更新 B，它的新连接也到 `.99`。

## 实际运行结果

使用镜像 `forwardx-sni-test:20261006`，只挂载本轮心跳、检查脚本和已有 Linux FXP 程序。容器没有对外发布端口。四个测试落地地址只在容器内部回环网卡上临时添加。

使用的 FXP 文件摘要为 `d5216d628618658f342ebbc02c8654143eed6acc2b7d7ef5ae99397ad293afe2`；镜像摘要为 `sha256:b191d6dbc4898969d6ea13b5f7a71ec68dca066facad4a6b20542eb36491e063`。

| 检查 | 实际结果 |
| --- | --- |
| A、B 分别连接三个域名 | 每条都收到对应不同落地的真实 TLS 回包 |
| 连接握手有没有被中途改写 | 在入口前和落地前分别截取客户端开始连接时发出的原始内容，逐字节摘要一致；实际协商 TLS 1.3 |
| 未知域名、没有域名的连接 | A、B 均拒绝，四次尝试均没有连到任何落地 |
| 只更新 A 的第一条域名 | A 新连接到 `.99`，B 新连接仍到 `.10` |
| 更新 A、随后更新 B | 两个进程编号都没有更换 |
| 另外两个域名的已有连接 | A、B 共四条连接在两次更新前后均持续收发 |
| 停掉 A | A 新连接失败；B 三个域名的新连接和另外两个域名的已有连接继续收发 |

本次共有 22 条成功建立的 TLS 连接，结合已有连接上的后续请求，取得 32 次正确落地回包；另外四次未知或缺失域名连接按预期拒绝，停 A 后一次新连接按预期失败。结果文件完整记录每次回包对应的入口、域名、真实落地、连接阶段和原始握手摘要。

检查进程结束后，两个 FXP 和所有测试落地进程退出，`--rm` 自动删除容器；已确认没有残留名为 `forwardx-285-port-sni-network` 的容器。

## 复跑及日志

支持脚本为 `verify-port-sni-network.mjs`；完整结果为 `port-sni-network-result.json`；原始心跳在 `port-sni-heartbeats/`。

实际执行命令如下，输出日志为 `/tmp/forwardx-285-implementation/port-sni-network.log`：

```sh
docker run --rm --name forwardx-285-port-sni-network --cap-add NET_ADMIN \
  --mount type=bind,source=/tmp/forwardx-285-implementation/port-sni-network,target=/heartbeats,readonly \
  --mount type=bind,source=/tmp/forwardx-285-implementation/forwardx-fxp,target=/tmp/forwardx-fxp,readonly \
  --mount type=bind,source=/Users/macmini/Documents/Aixiaoji/haproxy-sni/Forwardx-task-4/.scratch/2026-10-19_合并上游v2.3.285/证据,target=/evidence \
  forwardx-sni-test:20261006 node /evidence/verify-port-sni-network.mjs \
  /heartbeats /tmp/forwardx-fxp /evidence/port-sni-network-result.json
```

独立导出回归日志为 `/tmp/forwardx-285-implementation/port-sni-independent-export.log`。初次运行检查脚本曾选用 `127.0.0.2`，被 FXP 已有监听位置限制拒绝；调整为允许的 IPv4、IPv6 回环后，上表全部通过，最终日志和结果来自修正后的完整运行。

## 本次没有覆盖的部分

- A、B 是同一隔离 Linux 容器中的两个独立真实进程，分别使用 IPv4、IPv6 回环监听；这证明进程和连接彼此独立，没有模拟两台物理主机或跨机网络故障。
- 使用真实心跳中的配置，直接启动实际 FXP 并调用其已有更新入口；没有在本次容器里启动完整 Agent 去领任务。Agent 下发动作、面板确认、域名解析资格和成员退出由对应服务端及 Agent 检查分别提供证据，不能用此网络结果替代。
- 本次实际握手为普通 TLS 1.3；没有把它宣称为 ECH、所有 TLS 版本或高并发压力检查。
- 本次核对了局部修改的连接保持，没有测每入口限速上限、三十天来源保留或真实付款，这些不属于此连接检查。
- 全部结果是隔离自动检查，不代表人工验收或发布。
