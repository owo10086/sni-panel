# SNI 分流由出口主机上的独立 fxp 分流器承担

SNI 分流需要在链路终点读取客户端 TLS 握手里的域名，再决定连哪台落地机。我们把这个能力实现为 `forwardx-fxp` 的一个独立运行时角色，部署在链路的出口主机上，而不是内嵌进隧道出口、也不借用 nginx 或 HAProxy。

## Considered Options

**nginx `ssl_preread`** —— 面板已有一套完整的受管 nginx stream 管线（配置面板侧渲染、Agent 落盘并平滑重载），加一个 `map $ssl_preread_server_name` 就能分流。否决原因有三：`nginx` 与 `nginx_stream` 在默认协议开关里是关闭的；Agent 的 nginx 运行时是**拷贝主机上的系统 nginx 二进制**，能否用 `ssl_preread` 取决于该发行版怎么编译，装不上就没有分流；每条 SNI 规则的流量只能靠解析 session access log 得到。

**HAProxy** —— 姊妹项目 relay-panel 的做法。否决原因是引入一个 ForwardX 从未托管过的新依赖，而安装脚本一贯的策略是不碰主机上已有的同名服务，为此要新增一整套安装、探测、能力上报和配置校验。

**内嵌进 FXP 隧道出口** —— 出口本来就是 fxp 进程，分流长在里面可以做到零额外跳。否决原因是它把分流能力绑死在 `mode = forwardx` 的隧道上；GOST 隧道、Nginx 隧道和转发链的出口都不是 fxp 进程，这些链路形态就用不了分流。

## Consequences

分流器与链路类型完全解耦：隧道、转发链、端口转发的最后一跳都可以把流量交给它，换 KR→HK 那一跳的实现不需要重配任何分流规则。

Agent 已经在解析 TLS 记录和握手头（`detectTLSProtocol`，用于协议阻断），取 SNI 是往下读扩展的增量改动。

每条 SNI 规则的流量、限速和连接数上限全部在分流器内按匹配到的规则执行——这不是选择而是必然：入口不解析 SNI，对所有 SNI 规则的转发行为完全一致，在入口侧物理上无法分账。

代价是非 FXP 链路多一次本机回环拷贝。
