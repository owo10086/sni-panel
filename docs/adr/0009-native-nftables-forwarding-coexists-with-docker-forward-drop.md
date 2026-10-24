# 原生 nftables 转发在 Docker 默认 DROP 下经 DOCKER-USER 放行，并按本机条件报告就绪

**状态：已实施（2026-10-24 规格 `.scratch/2026-10-24_v4x转发组全部规则超时/`）。自动验证与隔离网络验收通过；生产防火墙调整、Agent 升级和部署未执行，另行授权。**

入口主机运行 Docker 时，`iptables` 前端的 `FORWARD` 基础链默认策略为 DROP，只跳转到 Docker 自己的链。ForwardX 在 `inet forwardx` 表中的 ACCEPT 无法覆盖同一 hook 上另一个基础链的 DROP，所以 DNAT 存在、规则显示运行，外部连接却全部超时。Agent 原先只核实 DNAT 存在，自测又把“入口直连目标成功”写成转发成功，两处都掩盖了故障。

## 决定

1. **在被丢弃的那条链里放行。** 对每个应用了 nftables 转发的 IPv4 规则，在 `DOCKER-USER` 链安装带归属的精确放行：按规则编号、入口原始端口（`--ctorigdstport`）、协议、转换后的目标地址／端口区分，回程仅放行相应连接的返回方向（`--ctdir REPLY`）。注释格式 `fwx-docker-<规则>-<端口>-<协议>-<in|out>` 是面板命令、Agent 核实与清理共同依赖的契约。
2. **不改变主机既有策略。** 不改 FORWARD 策略、不清空规则集、不删除 Docker 或管理员规则。放行排在管理员规则之后、Docker 链末尾无条件 RETURN 之前，所以管理员显式拒绝仍然优先。
3. **各前端独立判断。** `iptables-nft` 与 `iptables-legacy` 的规则互不相通，内核两者都会求值；legacy 显示 ACCEPT 不代表 nft 前端不丢弃。只对“FORWARD 默认 DROP 且跳转 DOCKER-USER”的前端安装放行；legacy 表只在已加载时读取，避免在纯 nft 主机上触发内核模块加载。其他结构（ufw、自定义防火墙、Docker 的 nftables 原生后端）不判断、不修改。
4. **就绪核实本机必要条件。** `nftForwardRulePresent` 除 DNAT 外核实 IP 转发、源地址转换、转发与回程放行，以及需要时的 DOCKER-USER 放行；上一版目标、已移除协议遗留的 DNAT／放行视为未收敛。动作完成判定、旧动作接管与本地状态上报共用这一结论，因此 Agent 重启后旧的成功记录不能掩盖缺失。结论不依赖业务目标是否在线，也不承诺任意外部网络可达。IPv6 及无法解析的目标保持原有仅核实 DNAT 的含义。
5. **失败要有原因。** 安装失败以非零退出并输出 `[docker-compat] …`；内核转发类动作的失败输出进入动作状态消息，主备组子规则会把它保存为运行诊断。
6. **自测只证明它测到的。** 自测是检测来源到目标的连接，没有任何一种自测会从外部经入口业务端口发起请求。`forwardOk` 不再被写成成功，`listenOk` 只在入口端口检测中保留；读取端对新旧记录统一返回 `evidence`（目标连接结果 + 外部路径“未验证”），旧记录里的无条件成功标志按证据重新解释。

## 版本能力

| 升级对象 | 效果 |
| --- | --- |
| 仅面板 | 新下发的命令（旧 Agent 同样以 shell 执行）会安装 DOCKER-USER 放行，转发恢复；旧 Agent 的就绪判断仍只看 DNAT，缺失不会被发现。自测结果语义随面板生效，旧 Agent 的上报格式不变。 |
| 仅 Agent | 就绪判断变严格：在 Docker 主机上旧面板不会安装放行，规则会被如实报为未就绪并给出原因，而不是继续误报运行。 |
| 两者 | 完整行为。 |

## 边界与代价

- 放行结束 DOCKER-USER 的求值，受管流量因此不再经过其后的 Docker 隔离链；目标若是本机 Docker 容器，应继续使用 Docker 自己的端口发布。
- 现有访问限制不会被绕过：端口访问限制在 mangle 的 PREROUTING／OUTPUT 阶段、隧道访问限制插在 FORWARD 链首，都早于 DOCKER-USER 的跳转；`inet forwardx` 表内的限制与 Docker 的基础链需要各自通过。
- 主机型主备组按 [ADR-0008](0008-host-failover-groups-use-entry-health.md) 使用入口自身的运行状态：本机转发条件缺失会使入口规则未运行，按既有故障等待和恢复观察处理；业务目标失败仍不参与入口资格。SNI 保持 [ADR-0006](0006-sni-group-ddns-uses-confirmed-entry-health.md)。

## 验证入口

- `pnpm verify:nft-docker`：隔离的特权容器内，用面板真实心跳生成动作，由真实 Agent 回放，独立客户端做 TCP／UDP 往返；覆盖 Docker DROP 共存、管理员拒绝优先、重复应用与重启接管、故障对照、目标／协议／域名／后端变化、本地兜底清理、主备与 DDNS 提供方替身。需要本机 Docker 与 `forwardx-sni-test` 镜像（可用 `FORWARDX_TEST_IMAGE` 指定）。
- `server/nftDockerCompat.test.ts`、`agent/docker_forward_compat_test.go`：命令与核实的单元边界；`shared/selfTestEvidence.test.ts`、`server/selfTestEvidence.test.ts`：自测证据语义。
