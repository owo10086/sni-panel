# 列表每页条数选择

**Status:** ready-for-agent

**Decision date:** 2026-10-28

## Problem Statement

面板各列表的每页条数写死在页面里，用户无法调整：主机、规则、隧道、转发组、套餐、用户等每页 12 条，账单流水、订阅、余额记录每页 20 条，兑换码、折扣码每页 50 条。只有规则页工具栏里有一个「每页 N 项」选择器（12/24/36/48），而且不在分页栏里。

另外三处限制让放大每页条数不可行：

- 服务端 12 个分页接口的入参校验都写死 `pageSize` 最大 100，`shared/pagination.ts` 的 `normalizePageRequest` 也把 pageSize 截到 100。
- 账单流水 `listBillingLedgerPage` 在补全明细时还经过 `normalizeBillingLimit` 的 500 上限，超过 500 的那一页会少数据。
- 推广、工单、运营等列表自己写分页，服务端用固定的 `LIMIT 20` / `LIMIT 10`，不接受每页条数参数。

分页栏在总数 ≤ 每页条数时整体隐藏，即使加了选择器，选了大档位后也找不回来。

## Solution

所有页面级列表的分页栏统一加入「N 条/页」下拉，样式参照用户提供的截图：

- 档位固定为 20、50、100、200、500、1000，全站一致。普通下拉，不可搜索，不可输入自定义值，高亮当前档位。
- 每个列表分别记住自己的档位，保存在浏览器 localStorage，不跨设备。
- 改档位后回到第 1 页，同时清空该列表的勾选。
- 分页栏整体靠右：「共 N 条」、`‹`、页码、`›`、「N 条/页 ▾」。不再显示各列表的量词，统一用「条」；「上一页 / 下一页」文字按钮改为只有箭头的按钮；分页栏只在列表底部；不加跳页输入框。
- 总数 > 20（最小档）时显示分页栏，只有一页时也显示；总数 ≤ 20 时隐藏。
- 窄屏下第一行是「共 N 条」和翻页（保留现有「x / y」），选择器换到第二行。
- 服务端列表分页接口的每页上限统一提高到 1000。其他接口已有的数量上限一律不动：只读查询由客户端按现有上限分批，写操作超过上限时禁止并提示。

## User Stories

1. As a 面板用户, I want 在每个列表底部选择每页条数, so that 一屏看到我需要的数量。
2. As a 面板用户, I want 每个列表分别记住我选的档位, so that 下次打开不用重选，也不影响其他列表。
3. As a 面板用户, I want 改档位后回到第 1 页并清空勾选, so that 当前位置可预期，勾选的条目与看到的一致。
4. As a 面板用户, I want 选了大档位后分页栏仍然显示, so that 我还能把档位改回来。
5. As a 面板用户, I want 选 1000 条时服务端真的返回最多 1000 条, so that 不会因为后台上限而少数据。
6. As a 面板用户, I want 大页面上的状态、指标、流量、所属用户都完整显示, so that 选大档位不会让条目缺信息。
7. As a 管理员, I want 批量操作超过上限时看到明确提示, so that 我知道该减少勾选，而不是收到一条看不懂的报错。
8. As a 规则页用户, I want 我原来选的「每页 N 项」迁移到新档位且不少于原来, so that 升级后看到的规则不会变少。
9. As a 手机用户, I want 选择器在窄屏下换行显示, so that 翻页按钮不被挤掉。
10. As a 管理员, I want 推广、工单、运营里的页面级列表也能选每页条数并记住页码, so that 全站行为一致。

## Implementation Decisions

**共享常量与校验**

- 在 `shared/pagination.ts` 增加档位常量（20/50/100/200/500/1000）和每页上限常量 1000。`normalizePageRequest` 的截断从 100 改为该常量。
- 服务端列表分页的每页条数校验改为 1..1000，并引用共享常量，不再在各路由里写数字。服务端只校验范围，不要求必须是档位值：隧道页用 `pageSize: 1` 取分区汇总，这个请求必须仍然可用。
- 各接口的默认 `pageSize` 不变。客户端在所有分页请求里都显式传 pageSize，默认值只作为兜底。依赖默认值的现有断言保持通过：`server/operations.test.ts` 和 `server/operationsFinance.test.ts` 的每页 10 条，`server/observability.fixture.ts` 的 20 条。
- 账单流水 `normalizeBillingLimit` 的 500 上限改到 1000，保证 `ledgerPage` 选 1000 时返回的明细条数与选中的 ID 数一致。这个函数只有 `listBillingLedger` 在用；旧的 `billing.ledger` 接口仍限 500，导出仍按 500 分批，两者都不变。
- `hosts.mapPoints`、`tunnels.mapItems`、`rules.mapItems` 有自己的 `limit` 校验（20–250）；`users.optionsPage` 上限 50。这些都不改。主机和隧道的地图接口内部把 limit 转成 pageSize，原来会被共享截断压到 100；截断改成 1000 后，limit 超过 100 的请求会真的返回超过 100 条。三个地图客户端目前都显式按 100 一批请求，实际行为不变。

**需要改的服务端分页接口**

- 已接受 pageSize 的 12 个：`users.listPage`、`hosts.listPage`、`tunnels.listPage`、`forwardGroups.listPage`、`rules.listPage`、`rules.personalGroupItems`、`plans.listPage`、`plans.subscriptionsPage`、`billing.listTransactionsPage`、`billing.ledgerPage`、`billing.listRedemptionCodesPage`、`billing.listDiscountCodesPage`。只改上限。`rules.personalGroupItems` 的调用方不在本次改造范围内，只是共用校验跟着改。
- 新增 pageSize 入参（1..1000）的：
  - `affiliates.list`、`affiliates.adminList`、`affiliates.adminOverview`：仓储里的 `LIMIT 20 OFFSET (page-1)*20` 改为参数化。
  - `supportTickets.list`：仓储里的 `LIMIT 20` 和返回值里的 `pageSize: 20` 改为参数化。
  - `operations.sources`：`OPERATIONS_SOURCE_PAGE_SIZE`。
  - `operations.financeLedger`：`OPERATIONS_LEDGER_PAGE_SIZE`。
  - `operations.monitor`：告警事件和 IP 更换事件是同一接口里两个独立分页的列表，各加一个每页条数参数（如 `pageSize` 和 `ipPageSize`）。
- 这些接口的服务端默认值保持现有固定值。页码语义不变：运营接口仍从 0 开始，客户端在边界处换算。
- 运营的三个接口有按页码的缓存，缓存键要加上每页条数：`monitor:${page}:${ipPage}` 两个每页条数都要加，`financeLedger` 和 `sources` 各加一个。规则、主机分页的展示缓存已经把含 pageSize 的整个查询对象序列化进缓存键（`server/displayQueryCache.ts`），隧道、转发组的流量缓存按实际 ID 集合隔离，这几处都不用改。

**按当前页提交的请求：其他接口的上限不动**

不少页面会把当前页的全部条目一次性提交给其他接口，这些接口另有数量上限。用户决定：这些上限一律不改。

- 只读查询：客户端按该接口现有上限分批请求，合并结果。页面上任何条目都不能因为排在上限之后而缺数据。
  - 主机页：`hosts.statusSummary`（每批 100）、`hosts.watchMetrics`（200，定时调用时每次也要分批）、`hosts.latestMetricsSummary`（500）、`hosts.trafficSummary`（500）。
  - 规则页所属用户：`users.optionsByIds`（每批 100）。客户端 `ruleOwnerOptionIds`（`client/src/lib/userSelection.ts`）现在把用户 ID 截到 100 个，要改成取全部再分批；服务端仓储层对单次请求截 100 的逻辑不变。
  - 规则页流量：`rules.trafficSummary`（每批 1000）。上限已经是 1000，但一个 SNI 组展开后包含组内全部规则，一页的规则 ID 可能超过 1000。`range: "total"` 和 `range: "24h"` 两种请求都要分批。
- 写操作：超过上限时禁用该操作按钮，并提示上限，不分批提交，不改语义。
  - 工单批量改状态：`supportTickets.bulkStatus` 最多 50 个，提示如「一次最多批量处理 50 个工单」。仍在一个事务里完成。
  - 兑换码批量删除：`billing.deleteRedemptionCodes` 最多 500 个，提示如「一次最多删除 500 个兑换码」。
  - 套餐拖动排序：`plans.reorder` 一次提交整页 ID，最多 100 个。当前页超过 100 个套餐时不允许拖动排序，提示如「当前页超过 100 个套餐，请切换到更小的每页条数后再排序」。
- 已经能处理的不用改：规则批量删除，客户端已按 500 分批；主机、规则、隧道、转发组的拖动排序，上限为 2000 或不设上限；`rules.targetGeoBatch`，只在地球视图用累积的地图数据，与每页条数无关。

**客户端：共享分页**

- `client/src/components/PersistentPagination.tsx` 负责每页条数的读取、保存和变更。分页状态要提供当前档位和修改档位的方法，各页面不再写死 pageSize，请求里的 pageSize 必须与分页状态里的一致。
- 每页条数的存储键由页码存储键派生：`xxx.page` → `xxx.pageSize`。规则页现有的 `forwardx.rules.pageSize` 正好符合这个规则。现有各列表的页码存储键互不冲突；主机页的多处分页栏共用同一个列表状态。
- 存储值缺失、非法或不在档位里时，用该列表的默认档位。
- 修改档位：保存新值，页码设为 1，清空该列表的勾选。规则页现在就是这样。工单列表清空勾选的依赖里没有每页条数，在第 1 页改档位时不会清空，要补上。兑换码同理。
- 兑换码按使用状态筛选的 effect 现在首次挂载就把页码设为 1，与恢复页码冲突。改为只有筛选值真的变化时才回第 1 页。
- 组件去掉 `itemName` 参数，统一显示「共 {0} 条」（已有英文翻译 `{0} records`）。新增「{0} 条/页」，需要在 `client/src/i18n/en.json` 补英文翻译（如 `{0} / page`）；上述三条上限提示也要补英文翻译。都要通过 `test:i18n`。语言测试不检查残留的未用译文，去掉的量词文案不必清理。
- 显示条件：`totalItems > 20`（最小档）。
- 下拉用现有的 `client/src/components/ui/select.tsx`（Radix + Pearl 样式），不新做组件。

**默认档位**

- 已经在新档位里的保持不变：账单流水、订阅、余额记录 20，兑换码、折扣码 50。
- 原来 12 的改为 20：主机、规则、隧道、端口转发、故障转移组、转发链、入口组、出口组、套餐、用户、用户订阅。
- 原来 10 的改为 20：运营来源 IP、运营财务流水。
- 推广、工单、运营告警事件、IP 更换事件：20。

**规则页**

- 删除工具栏里的「每页数量」选择器、`RULE_PAGE_SIZE_OPTIONS`、`RulePageSize`，以及紧凑卡片默认 24 的逻辑。规则页默认 20。
- 读取 `forwardx.rules.pageSize` 时，先读原始值，旧值往上取档：12 → 20，24/36/48 → 50；再按新档位校验。现有读取函数只接受旧档位，要替换掉。
- 计数单位不变：一个 SNI 组算 1 条展示单元，组内规则不分页。拖动排序的 `ruleStartIndex` 计算、当前页全选、筛选键和选择范围里带 pageSize 等现有逻辑不变。

**改为共享分页的自写分页列表（共 10 个）**

- 推广 `Records` 组件的佣金、提现、佣金流水、邀请记录（用户视图和管理员视图共用这个组件），以及管理员账户总览。
- 工单主列表：原来的「共 {0} 个工单」改为「共 {0} 条」。
- 运营来源 IP（`OperationsSourceList`）、运营财务流水（`OperationsFinanceSummary`）、资源告警事件、IP 更换事件（`OperationsMonitorPanel`）。
- 改成共享分页后，这些列表也会记住页码，与其他列表一致。存储键要区分列表种类，以及用户视图和管理员视图。
- 记住页码与现有重置逻辑的冲突要处理：
  - 推广管理员总览、运营来源 IP、运营财务流水，现在首次挂载时就会通过筛选或防抖的 effect 把页码重置。改为首次挂载保留恢复的页码，只有筛选条件真的变化（日期范围、用户范围、搜索、排序等）时才回第 1 页。
  - 推广 `Records` 切换记录种类时，现在会对当前列表调用 `setPage(1)`。改为切换到目标种类自己记住的页码和档位，不改写来源种类的存储。
- 运营告警事件和 IP 更换事件共用一个查询，但页码和档位各自独立，改一个不重置另一个。
- 运营列表分页栏以外还有几处写死按 10 计算，都要改成按当前档位：来源 IP 的跨页序号、来源 IP 的最后一页纠偏、财务流水的总页数。
- 推广管理员保存配置后用 `adminOverview.setData` 更新缓存，入参要与加了 pageSize 的查询一致。

## Testing Decisions

- 服务端：
  - 12 个列表分页接口和新增 pageSize 的 7 个接口，传 `pageSize: 1000` 都能成功，传 1001 返回 `BAD_REQUEST`。`server/billingPagination.test.ts` 中「101 被拒绝」的断言改成 1001；导出首批 500 条的断言保留。
  - 账单流水在有超过 500 条记录时，`pageSize: 1000` 返回的条数与总数一致，不再截到 500。
  - 新增 pageSize 的推广、工单、运营接口：分页切片正确，跨页不重复不遗漏，超出范围的页码按现有方式处理。
  - 运营接口在缓存期内用不同 pageSize 请求同一页，返回不同的结果。
  - `pageSize: 1` 的汇总请求仍然可用。
  - `hosts.statusSummary`、`watchMetrics`、`latestMetricsSummary`、`trafficSummary`、`users.optionsByIds`、`rules.trafficSummary`、`supportTickets.bulkStatus`、`billing.deleteRedemptionCodes`、`plans.reorder` 的现有上限断言（如有）保持不变。
- 客户端：
  - 抽出档位读写和规则旧值迁移的纯函数并做单测，覆盖：缺失、非法、不在档位里、规则旧值 12/24/36/48。
  - 抽出按上限分批再合并的逻辑并做单测：恰好等于上限、超过上限一条、空数组、结果合并后不丢不重。
  - `client/src/lib/userSelection.ts` 的 `ruleOwnerOptionIds` 不再截到 100；`client/src/components/UserSelect.test.tsx` 中断言 100 截断的用例改为断言取全部。
  - `client/src/components/ui/ui-copy.test.tsx` 的分页渲染断言改为新文案「共 100 条」「20 条/页」，箭头按钮保留可访问名称，保留 `aria-label="第 2 页，共 5 页"`。
  - `client/src/components/OperationsChinaMap.test.tsx` 渲染 `OperationsSourceList` 时按每页 10 条断言「第 2 页，共 9 页」，要随组件改造更新。
  - 补一条渲染断言：总数 ≤ 20 时不渲染分页栏，总数 > 20 且只有一页时渲染。
  - 补交互测试：请求的 pageSize 与所选档位一致；改档位回第 1 页并清空勾选（含在第 1 页改档位时的工单列表）；重新挂载后恢复档位和页码；不同列表互不影响；运营两个事件分页互不重置；首次挂载不把恢复的页码重置成 1。
  - 写操作上限：工单勾选 51 个、兑换码勾选 501 个时按钮禁用并显示提示；当前页超过 100 个套餐时不能拖动排序。
  - 现有约束保持通过：`client/src/components/ui/pearl-ui.test.tsx`（Rules、ForwardGroups 的 `className="mt-5"`；Select 的 combobox 语义）、`client/src/components/ProductSorting.test.tsx`（`startIndex` 表达式）、`client/src/lib/paymentCheckout.test.ts`（账单共享分页、筛选用户时 `ledgerPageRequest.setPage(1)`）、`server/sniRuleCategory.test.ts`、`server/paginationQueries.test.ts`。
  - `test:i18n` 通过。
- 每张工单除 `pnpm build` 外，还要通过 `pnpm exec tsc --noEmit`（根配置，覆盖 client、server、shared）。`pnpm build` 不做类型检查，仓库的 `scripts/verify.mjs` 也单独跑 tsc。
- 测试脚本在 `package.json` 里逐个列出文件，新增测试文件要加进对应脚本才会运行。

## Out of Scope

- 性能优化：隧道分页的逐条查询、规则分页每次全量加载匹配索引、转发组和用户订阅的明细补全、主机的 geo 刷新调度、表格模式同时挂载手机卡片和桌面行。选 500/1000 时这些页面会变慢，这是明确接受的代价。
- 提高列表分页以外的任何接口上限。
- 弹窗、下拉里的分页选择器：规则组成员选择（`PersonalRuleGroups`）、用户选择框（`UserSelect`）、工单服务选择。
- 设置页日志的「较新 / 更早」翻页、工单消息的「加载更早」、主机可用性的「更多时段」、地图和地球视图的分批加载。
- 地图和地球视图下现有分页栏（主机页地图模式下窄屏的两处、规则页地球视图）的位置和去留不变；它们与普通列表共用分页状态，会跟着共享组件和档位一起改。
- 现在没有分页的列表一律不新增分页（钱包、商店、我的订阅、主机分组、Agent 令牌、插件等）。
- 跳页输入框、自定义每页条数、按账号跨设备同步档位。
- 修改服务端各接口的默认 pageSize。

## Further Notes

- 决定来自 2026-10-28 与用户的逐轮问答：
  - 档位由用户定为 20/50/100/200/500/1000（去掉了截图里的 10）。
  - 按当前页提交的请求，用户明确要求不提高其他接口的上限：「有限制的就限制就行了，比如工单全选后批量改状态上限 50 就保持 50」。只读查询在客户端分批，是为了在上限不变的前提下不让条目缺数据。
  - 改档位时清空勾选，覆盖工单和兑换码，由用户确认。
  - 其余各项按推荐确认：统一改共享组件、每个列表分别存在本地、改档位回第 1 页、照截图布局并统一用「条」、普通下拉、窄屏换行、规则页合并且旧值往上取档、默认档位、列表分页上限 1000 且不做性能优化、自写分页只改 10 个页面级列表。
- 本规格经过两路 Codex 对照代码审查（服务端、客户端），再加一次专门排查「按当前页提交的请求」，发现的问题已并入上文。拆成工单后又经过两路 Codex 审查（切分覆盖、事实核对），修订同步回本规格。
- 实施工单：`工单/01`–`09`。01 先做共享分页栏并接入账单；02–08 各接入一组页面，相互独立，可以并行；09 删除过渡路径并整体验收。
- 1000 条时的开销估计来自静态阅读，没有做基准测试。风险较高的接口有：
  - `tunnels.listPage`：每条隧道约 2 次额外查询，页面还会定时刷新。
  - `rules.listPage`、`rules.personalGroupItems`：每次都加载全部匹配的展示索引，SNI 组还会放大实际规则数。
  - `forwardGroups.listPage`、`hosts.listPage`、`plans.subscriptionsPage`：每条订阅约 2–5 次额外查询。
  - 实际开销取决于真实条数，条数少时选 1000 等于一次全部返回。
