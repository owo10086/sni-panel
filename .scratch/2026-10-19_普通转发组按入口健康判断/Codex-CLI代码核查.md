**核查结论：SNI 的“主机型主备组”已经采用你说的核心逻辑——单个 SNI 落地服务失败，不单独影响入口资格，也不因此切换整组或卡住 DDNS。普通主机型主备组目前还没有采用这套逻辑。** 普通组仍要求相关启用规则的目标检测通过，所以会出现“dmit7、dmit9、dmit10 都在线，`tool.lu:80` 检测正常，却选不出入口”的情况。

本报告依据本仓库当前代码，提交位置为 `cbe7ad7c324f8a9e91644b2be425c119ad4d139d`。本轮只读取文件和仓库状态，没有修改代码、文档、数据库或线上配置，没有创建工作树、运行测试或委派。三台入口的具体线上状态引用前轮 **2026-10-19 16:54—17:02** 的记录，本轮没有重新访问线上确认。

**1．SNI 主机型主备组：确实不等落地健康，但还要满足这些入口条件**

代码先判断：**主备模式、主机类型、组内存在 SNI 规则**，满足后进入 SNI 专门的资格检查。入口位置见 [SNI 与普通组的判断分支](/Users/macmini/Documents/Aixiaoji/haproxy-sni/Forwardx/server/repositories/forwardGroupRepository.ts:4706)。

| 条件 | 当前实际要求 |
|---|---|
| 组和成员已启用 | 组停用不参加处理；正式选定入口时，还会复查成员是否启用、组配置是否仍然有效。 |
| 入口 Agent 可用 | 按有效活动和离线确认判断。支持新版在线报告的主机使用专门的在线状态；旧方式保留约 150 秒活动有效期。页面一个“在线”字样不能代替这里的全部检查。 |
| 没有被流量政策排除 | 如果已开启流量故障转移、设有流量额度，并已达到排除条件，即使 Agent 在线也不能参加。 |
| Agent 支持 SNI | 代码会检查最低支持版本，目前常量是 `2.2.195`。 |
| 当前完整 SNI 配置确实生效 | 每条应运行的 SNI 规则都要有成员副本；实际分流内容要与当前要求一致，包括域名、目标、端口、限速和连接数限制等。应删除的旧域名仍在运行，也会挡住资格。 |
| 运行确认仍有效 | 确认有效期是 5 分钟。离线、重启、确认中断等情况后，旧确认不能直接拿来重新取得资格。 |
| 已开启的入口检测通过 | 开关开启时，检测结果必须正常、有效，并符合重新上线后的报告要求；关闭时不增加这一项条件。 |
| 满足故障、恢复观察 | 各项条件分别记录观察时间。国内检测一直正常，不能替刚恢复的分流程序“凑够恢复时间”。 |
| 有适合发布的地址 | A 记录需要 IPv4，AAAA 需要 IPv6，CNAME 需要可用域名。真正修改解析还要求系统 DDNS 已启用、服务商配置可用，并且更新成功。 |

对应证据：

- [在线和流量排除判断](/Users/macmini/Documents/Aixiaoji/haproxy-sni/Forwardx/server/repositories/forwardGroupRepository.ts:595)、[流量排除的开关与额度条件](/Users/macmini/Documents/Aixiaoji/haproxy-sni/Forwardx/shared/hostTrafficPolicy.ts:32)。
- [SNI 完整配置、过期确认、旧配置撤除检查](/Users/macmini/Documents/Aixiaoji/haproxy-sni/Forwardx/server/repositories/forwardGroupRepository.ts:4560)、[实际配置内容逐项比较](/Users/macmini/Documents/Aixiaoji/haproxy-sni/Forwardx/server/sniRuntimeObservability.ts:270)、[最低支持版本](/Users/macmini/Documents/Aixiaoji/haproxy-sni/Forwardx/shared/sni.ts:1)。
- [已开启的入口检测条件](/Users/macmini/Documents/Aixiaoji/haproxy-sni/Forwardx/server/repositories/forwardGroupRepository.ts:4678)、[5 分钟有效期](/Users/macmini/Documents/Aixiaoji/haproxy-sni/Forwardx/server/forwardGroupHealthRecheck.ts:9)、[分别计算观察时间](/Users/macmini/Documents/Aixiaoji/haproxy-sni/Forwardx/server/forwardGroupSniHealth.ts:59)。
- [正式选定前再次核对](/Users/macmini/Documents/Aixiaoji/haproxy-sni/Forwardx/server/repositories/forwardGroupRepository.ts:2113)、[DDNS 更新与选定结果保存](/Users/macmini/Documents/Aixiaoji/haproxy-sni/Forwardx/server/repositories/forwardGroupRepository.ts:5484)。

故障观察默认 60 秒，恢复观察默认 120 秒，最低 10 秒。代码也接受 Agent 已完成观察后的健康结论，因此**不能理解成 Agent 等完一次，面板必定再重复等一次**。恢复后的 SNI 配置确认仍有自己的观察要求，见 [时间设置](/Users/macmini/Documents/Aixiaoji/haproxy-sni/Forwardx/server/repositories/forwardGroupRepository.ts:566)、[观察完成条件](/Users/macmini/Documents/Aixiaoji/haproxy-sni/Forwardx/server/forwardGroupSniHealth.ts:90)。

入口合格后，主备组还会按优先级选择，并遵守“恢复后切回”开关；并非任何一台恢复都立刻抢回。见 [优先级、故障切换与自动回切](/Users/macmini/Documents/Aixiaoji/haproxy-sni/Forwardx/server/repositories/forwardGroupRepository.ts:5701)。

**单个 SNI 落地失败，不在上述入口条件里。** 比如 A 域名的台湾服务停了，B 域名的香港服务正常，只要入口的完整分流配置和已开启的入口检测仍正常，就不会只因为台湾服务停了而切换整个组。但如果 A 域名在入口上仍指向旧目标，那属于“入口配置没生效”，仍会影响资格。

**2．普通主机型主备组：为什么一个落地失败会拖住整个成员**

当前数据流是：

**入口检测每条规则的目标 → 上报每条规则的结果 → 面板逐条检查 → 任意一条不合格，该入口就不合格 → 三台都不合格，就选不出新的活动入口 → DDNS 走保留旧解析的处理。**

具体证据如下：

| 环节 | 代码事实 |
|---|---|
| 检测的是业务目标 | 普通直连规则的检测任务使用该规则的 `targetIp`、`targetPort`。TCP 等规则做 TCP 连接检查，纯 UDP 规则这里使用 ping。见 [业务目标检测任务](/Users/macmini/Documents/Aixiaoji/haproxy-sni/Forwardx/agent/metrics.go:1547)。 |
| Agent 会给出健康结论 | 主备组的每条成员规则带有该组的故障、恢复观察设置；Agent 根据探测结果生成健康状态。见 [给规则附带组观察设置](/Users/macmini/Documents/Aixiaoji/haproxy-sni/Forwardx/server/agentHeartbeatRoute.ts:2380)、[Agent 生成健康结论](/Users/macmini/Documents/Aixiaoji/haproxy-sni/Forwardx/agent/forward_group_health.go:127)。 |
| 结果进入逐条记录 | 面板保存规则检测结果，健康状态变化会安排重新判断组入口。见 [保存结果并触发组判断](/Users/macmini/Documents/Aixiaoji/haproxy-sni/Forwardx/server/agentReportRoutes.ts:1583)。 |
| 一条失败就停止判为健康 | 逐条检查时，规则未运行、报告缺失或过期、健康结论失败，或者没有正常健康结论且探测超时，都会让该成员不合格。见 [逐条检查及失败分支](/Users/macmini/Documents/Aixiaoji/haproxy-sni/Forwardx/server/repositories/forwardGroupRepository.ts:4773)。 |
| 入口检测是附加条件 | 只有前面逐条规则已经判为健康，才继续检查 `chinaHealthCheckEnabled` 对应的入口检测。见 [入口检测的执行位置](/Users/macmini/Documents/Aixiaoji/haproxy-sni/Forwardx/server/repositories/forwardGroupRepository.ts:4845)。 |
| 没有健康候选就保留旧解析 | 见 [没有候选入口时的处理](/Users/macmini/Documents/Aixiaoji/haproxy-sni/Forwardx/server/repositories/forwardGroupRepository.ts:5745)、[旧解析保留逻辑](/Users/macmini/Documents/Aixiaoji/haproxy-sni/Forwardx/server/repositories/forwardGroupRepository.ts:4940)。 |

因此，现在的普通组相当于要求：**“入口能用，而且组内每条相关业务也要能到目标。”** 不是开启入口检测后，就改为只按入口判断。

前轮记录中，组 16 的 44 条有效主规则全部是普通规则，三台入口各有 20 条目标失败、24 条正常，国内检测正常，活动入口为空。这与当前代码吻合。详见 [前轮规则和组状态](/Users/macmini/Documents/Aixiaoji/haproxy-sni/Forwardx/.scratch/2026-10-19_35212端口只读排查/排查记录.md:21)。

**3．截图里的 `tool.lu:80` 开关，就是页面的“入口健康度检测”**

| 页面上的内容 | 代码中的名称 |
|---|---|
| “入口健康度检测”开关 | `chinaHealthCheckEnabled` |
| 填写 `tool.lu:80` 的目标框 | `chinaHealthCheckTarget` |
| 成员检测结果、延迟、检查时间 | `chinaHealthStatus`、`chinaHealthLatencyMs`、`chinaHealthCheckedAt` |

页面证据见 [目标输入框与入口健康度开关](/Users/macmini/Documents/Aixiaoji/haproxy-sni/Forwardx/client/src/pages/ForwardGroups.tsx:2642)。所以，**页面所说的“入口健康度”和后台多处仍写的“国内健康度”，这里是同一项检测的两套称呼。**

按你提供的截图配置，每台入口上的 Agent 会主动连接 `tool.lu:80`。面板给它生成的是单独的组检测任务，结果也单独保存；这与每条业务规则的目标检查独立。见 [生成入口检测任务](/Users/macmini/Documents/Aixiaoji/haproxy-sni/Forwardx/server/repositories/forwardGroupRepository.ts:1869)、[保存入口检测结果](/Users/macmini/Documents/Aixiaoji/haproxy-sni/Forwardx/server/repositories/forwardGroupRepository.ts:1945)。

还有两个事实需要说清：

- **这项检查是入口主动向外连接目标。** 它没有让外部探测机连入口的 `35212` 等业务端口，也没有请求 `tool.lu` 网页内容。实际执行的是 TCP 连接检查，见 [Agent 执行连接检测](/Users/macmini/Documents/Aixiaoji/haproxy-sni/Forwardx/agent/metrics.go:1876)。
- 留空时默认目标是 `www.189.cn:80`；`tool.lu:80` 是截图提供的配置值，代码没有把它固定为所有组的目标。见 [默认值和目标解析](/Users/macmini/Documents/Aixiaoji/haproxy-sni/Forwardx/server/repositories/forwardGroupRepository.ts:515)。

**4．哪些模式会受同一套判断影响，不能一起笼统修改**

| 模式 | 当前是否受“逐条业务目标失败影响组资格”约束 |
|---|---|
| **主机型主备组，全部是 SNI** | SNI 落地结果不影响资格；按第 1 点的入口条件判断。 |
| **主机型主备组，全部是普通规则** | 会。现有逐条目标要求正是本次问题所在。 |
| **主机型主备组，SNI 与普通混合** | SNI 落地结果不影响，但普通部分仍逐条检查；普通目标失败可以让整个成员不合格。 |
| **隧道型主备组** | 仍走通用逐条检查。并且规则检测结果可能包含“隧道段＋最终目标”的合并结果，不能把其中的失败全部当成单纯落地服务失败。 |
| **单机 `port` 端口转发资源** | 不经过这套主备选入口流程。不能因为都是 nftables 转发，就把它当成同一种组。 |
| **`entry` 入口组，一般情况** | 单独处理，可以发布多台合格入口地址；开启入口检测时用该检测，关闭时使用 Agent 自身报告，不逐条等待所有业务目标。 |
| **入口组被含 SNI 的 `port` 资源引用** | 会复用 SNI 资格检查，并汇总所引用端口资源的规则。SNI 落地不挡资格，但其中的普通规则仍会挡；影响还可能跨多个引用同一入口组的端口资源。 |
| **`exit` 出口组** | 不走这里的主备 DDNS 资格判断。这里的“健康”主要表示存在启用且未被流量排除的成员；真正连接出口的选择另由隧道运行方式处理。 |
| **`chain` 转发链** | 不经过这套主备判断，有自己的逐段检测。引用入口组时，其入口地址发布仍受那个入口组的判断影响。 |

主要证据是 [各模式的处理分支](/Users/macmini/Documents/Aixiaoji/haproxy-sni/Forwardx/server/repositories/forwardGroupRepository.ts:5600)、[混合组中的普通规则检查](/Users/macmini/Documents/Aixiaoji/haproxy-sni/Forwardx/server/repositories/forwardGroupRepository.ts:4658)、[入口组汇总引用规则并复用 SNI 判断](/Users/macmini/Documents/Aixiaoji/haproxy-sni/Forwardx/server/repositories/forwardGroupRepository.ts:5064)、[隧道与目标检测结果合并](/Users/macmini/Documents/Aixiaoji/haproxy-sni/Forwardx/server/agentReportRoutes.ts:1529)、[出口组状态处理](/Users/macmini/Documents/Aixiaoji/haproxy-sni/Forwardx/server/repositories/forwardGroupRepository.ts:5446)。

**建议的最小明确调整范围，是“主机型主备组中的普通规则”，同时包括混合主备组的普通部分。** 这能覆盖 dmit7／dmit9／dmit10 所在的组 16，也避免混合组继续被普通落地故障卡住。范围按“主机型＋主备模式”划定，不能只限定 nftables，否则其他转发方式还会存在相同差异。

这个范围应保留：组和成员启用、Agent 可用、流量排除、入口上应运行的配置状态、已开启入口检测的有效结果、故障和恢复观察、优先级、自动回切，以及 DDNS 发布前的再次核对。SNI 当前的完整配置确认继续保留。

**隧道型主备、入口组多地址发布、出口切换、转发链逐段检测，需要各自明确范围。** 特别是入口组直连 SNI 的新模式，ADR 目前还标注“已实现，等待人工验收”，见 [ADR-0007 的状态和范围](/Users/macmini/Documents/Aixiaoji/haproxy-sni/Forwardx/docs/adr/0007-sni-port-entry-groups-forward-directly-to-targets.md:3)。

**5．关闭入口检测后，目前有哪些事实可用**

目前三种情况并不相同：

- **SNI 主机型主备组：**关闭后，跳过国内／入口检测这一项，仍要求 Agent 可用、完整分流配置确认有效、观察条件满足等。
- **普通主机型主备组：**关闭后，依旧检查每条业务规则的运行和目标检测；不会自动变成 SNI 的入口判断。
- **一般入口组：**关闭后，Agent 会收到 `self` 类型任务。该任务直接生成“自身可报告”的成功结果，**并不检查外网连通，也不检查业务转发是否正常**；面板另外继续检查在线、报告有效期等条件。见 [关闭后生成自身报告任务](/Users/macmini/Documents/Aixiaoji/haproxy-sni/Forwardx/server/repositories/forwardGroupRepository.ts:1852)、[该任务直接产生成功结果](/Users/macmini/Documents/Aixiaoji/haproxy-sni/Forwardx/agent/metrics.go:1855)。

如果普通主备组扩大为入口判断，关闭开关后的设计有两个直接选项：

| 选项 | 关闭后的含义 |
|---|---|
| **A．沿用 SNI 的含义** | 不检查外部检测目标，凭 Agent 可用、入口配置运行情况、流量政策和观察条件判断。业务目标结果继续展示。 |
| **B．保留普通组现有后备方式** | 开启时采用入口判断，关闭时恢复逐条业务目标要求。这样开关除了控制检测，还承担了切换组判断方式的作用，需要明确说明。 |

代码现状不能替你决定选 A 还是 B。

**6．“没有可测试的活动入口”的实际调用关系，以及改策略能解决什么**

调用关系已经核实：

1. 页面点击“链路测试”，调用 `rules.startSelfTest`，见 [按钮调用](/Users/macmini/Documents/Aixiaoji/haproxy-sni/Forwardx/client/src/pages/Rules.tsx:9423)。
2. 后台发现是组主规则，调用 `getForwardGroupRuleForSelfTest`，先找本次要测试的真实成员规则，见 [后台挑选测试入口](/Users/macmini/Documents/Aixiaoji/haproxy-sni/Forwardx/server/routers/rules.selfTest.ts:115)。
3. 组绑定了域名、但没有 `activeMemberId` 时，候选列表直接为空，随后抛出“转发组当前没有可测试的活动入口……”，见 [候选为空和报错位置](/Users/macmini/Documents/Aixiaoji/haproxy-sni/Forwardx/server/repositories/forwardGroupRepository.ts:2283)。
4. 创建测试任务在后面，所以这种情况**测试还没开始，就已被拒绝**，见 [实际创建任务的位置](/Users/macmini/Documents/Aixiaoji/haproxy-sni/Forwardx/server/routers/rules.selfTest.ts:161)。

因此，如果改用入口健康策略后，三台入口中至少一台满足其他条件并被正常选定，以下症状**可能自然消失**：

- 因普通落地故障而没有合格入口；
- DDNS 因无健康候选而一直保留旧地址；
- 点击链路测试时，因为没有活动入口而无法创建任务。

但**目标端口拒绝连接、目标服务停止、实际转发失败不会因此恢复**。以本次为例，即使 dmit7 被选中，`hinet.332323.xyz:10042` 仍可能在测试中显示失败。前轮确认的拒绝连接见 [目标连接结果](/Users/macmini/Documents/Aixiaoji/haproxy-sni/Forwardx/.scratch/2026-10-19_35212端口只读排查/排查记录.md:57)。

逐条业务目标检测仍有价值，应继续服务于**每条规则的延迟、失败状态、历史曲线和排查**；手动链路测试也应继续显示监听、目标可达、实际转发等结果。把这些结果从“整组入口资格”里拿开，不等于把失败显示成正常。现有逐条查询入口见 [规则检测统计和曲线查询](/Users/macmini/Documents/Aixiaoji/haproxy-sni/Forwardx/server/routers/rules.selfTest.ts:15)。

**7．新决定会涉及哪些现有约定，以及少量待决定边界**

现有文档明确要求普通规则继续检查目标，扩大范围后必须同步说明，否则以后合并上游或审查时，会再次把旧要求套回来：

| 位置 | 当前文字与需要明确的地方 |
|---|---|
| [AGENTS.md 第 21 行](/Users/macmini/Documents/Aixiaoji/haproxy-sni/Forwardx/AGENTS.md:21) | 明写“同组普通规则继续执行原有目标检测”。需要明确新的适用组类型，以及普通目标结果是否仅用于逐条展示和排查。 |
| [ADR-0006 第 13 行](/Users/macmini/Documents/Aixiaoji/haproxy-sni/Forwardx/docs/adr/0006-sni-group-ddns-uses-confirmed-entry-health.md:13) | 第 5 条保留混合组普通目标检测，与扩大后的主备组决定直接相关。 |
| [ADR-0006 第 29 行](/Users/macmini/Documents/Aixiaoji/haproxy-sni/Forwardx/docs/adr/0006-sni-group-ddns-uses-confirmed-entry-health.md:29) | 核查要求仍写“普通规则……按要求执行”，需要区分入口运行条件与业务目标结果。 |
| [ADR-0007 第 15 行](/Users/macmini/Documents/Aixiaoji/haproxy-sni/Forwardx/docs/adr/0007-sni-port-entry-groups-forward-directly-to-targets.md:15) | 新入口组直连模式也明写普通规则继续目标检测。若本次仅改变主机型主备组，这里应保留并明确范围；若入口组也扩大，这里就需要跟随新决定调整。 |

**另一个边界是：普通规则“运行中”的证据，目前不能直接等同于 SNI 的完整配置确认。** 普通组资格函数主要读取规则的启用、运行标记和探测结果；心跳另有目标、端口、协议等对照和修复逻辑，但这里没有采用 SNI 那套完整分流表及其 5 分钟确认。见 [普通组读取运行标记](/Users/macmini/Documents/Aixiaoji/haproxy-sni/Forwardx/server/repositories/forwardGroupRepository.ts:4773)、[普通规则心跳内容对照](/Users/macmini/Documents/Aixiaoji/haproxy-sni/Forwardx/server/agentHeartbeatRoute.ts:5056)。

后续只需要你明确这几项边界，无需重新讨论“单个落地失败不应拖住整组”这个核心诉求：

1. **扩大到哪里：**只覆盖主机型主备组及其混合普通部分，还是也覆盖入口组引用端口资源的普通部分？隧道型主备应单独决定，因为其失败结果可能包含隧道本身故障。
2. **关闭入口检测时选哪种含义：**采用上面的 A，凭在线和入口运行状态判断；还是采用 B，恢复逐条业务目标要求？
3. **某条应运行的普通规则没有运行，是否阻止该入口参加整组选择：**目前会。我建议继续区分“入口没把规则运行起来”和“规则已运行、落地服务却停了”。前者继续挡入口，后者只影响那条规则的展示。否则可能选到连自身业务规则都没准备好的入口。
4. **是否接受现有入口检测的覆盖范围：**Agent 在线、能连接 `tool.lu:80`，仍可能出现入口公网业务端口被拦、某种转发方式损坏、UDP 不通等情况。保留运行确认能发现一部分问题，但不能证明真实业务完全可用；若要求这些情况也触发整组切换，就需要另行明确要验证哪条实际转发路径。
