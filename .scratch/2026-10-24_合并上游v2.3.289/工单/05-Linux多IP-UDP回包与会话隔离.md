# 05：Linux 多 IP UDP 回包与会话隔离

Status: completed

**交付行为：** 同一台 Linux Agent 通过多个入口 IP 接收 UDP 时，从实际接收请求的入口 IP 回包；同一客户端访问不同入口 IP 不会串用会话。

**Blocked by:** 无（可独立开始）。

**规格对应：** [唯一规格](../spec.md)；用户故事 23、24、35；实施决定 2、15、21。

**执行边界：** 用户已通过 `$implement` 明确授权本地实施、验证、审查及当前分支中文提交。按固定上游 v2.3.289 兼容适配，保留既有工作区内容，不创建工作树；不推送、不打标签、不发布或部署。

## 验收标准

- [x] Linux 支持路径保留数据包实际接收的本地入口 IP，回包源 IP 与该入口一致，不因通配监听或默认路由改用另一个本地 IP。
- [x] 相同客户端地址和端口访问不同本地入口 IP 时分别建立和维护会话，双向数据与回包互不混用。
- [x] IPv4、IPv6、多本地 IP 和共享监听相关场景保持既有可用行为，会话关闭与资源清理不受影响。
- [x] 改动限定在 Agent 相关 UDP 网络路径；SNI 继续使用既有 TCP 数据面和共享监听方式，不扩大为新的 SNI 转发设计。
- [x] 非 Linux 平台兼容回退路径继续可构建和执行相应验证，但其结果不代替 Linux 多 IP 行为验证。
- [x] 使用真实 Linux 网络环境或网络命名空间，实际收发数据确认回包源地址和跨入口会话隔离；相关真实二进制、共享监听和竞态回归按既有入口完成。

## 验证入口

沿用 Agent Go 测试、Linux 网络命名空间、真实二进制及竞态验证入口，以客户端实际观察到的源 IP 和数据归属为依据。缺少所需平台、IPv6 或网络条件时具体列为未验证，不把编译成功写成网络行为通过。

## 实施与验证结果（2026-10-24）

- `6fa25ad` 在 Linux 使用 packet-info 保存实际接收入口地址并指定回包源地址；会话键包含 peer、本地 IP 与 IPv6 scope。同一客户端访问不同入口 IP 的会话相互隔离，SNI TCP 数据面保持既有方式。
- Ubuntu 24.04.5／Go 1.23.12 的真实 Linux 测试通过 IPv4、双栈、显式 IPv4／IPv6 入口、跨 IP 会话、scope 和生命周期。Agent 与 FXP 的 `go test ./...`、`go vet ./...`、`go test -race ./...` 均按分步验证通过。
- 已构建本轮 3.7.0 Agent／FXP 真实二进制；网络命名空间验证 IPv4／IPv6 端口限制，FXP 二进制 ECH SNI 验证通过；隔离 fixture 的 v1／v2 TCP、UDP、连接保持、重试、乱序、丢回复和冲突场景通过。
- FXP `TestV3PoolSkipsStaleSessions` 在 `GOMAXPROCS=1` 和 `4` 下各 1000 次通过。amd64 仿真首次 Agent vet 在 Go 标准库运行时崩溃，使用 `GODEBUG=asyncpreemptoff=1 GOMAXPROCS=2` 完成后续分步检查；上述稳定性专项仍分别使用 1／4。
- macOS arm64／Go 1.26.3 的 `go test -run 'UDP|Packet' ./...` 通过，验证非 Linux 回退与相应 UDP 行为。沙箱首次不允许回环绑定，获得本地测试执行许可后通过；此结果不替代 Linux packet-info 验证。
- 本轮未把分步结果记为一次完整 `pnpm verify agent` 通过。自动审批拒绝过带 Docker socket 且扩大容器权限的验证容器；未执行该方案，改为容器内构建／竞态／namespace 与宿主创建的隔离网络 fixture 完成原有检查。
