# 01 — 共享分页栏改造，账单 5 个列表先接入

**What to build:** 打通整条链路：服务端列表分页上限提到 1000，共享分页栏换成截图样式并带「N 条/页」选择器，账单页的 5 个列表（余额流水、订阅、余额记录、兑换码、折扣码）先接入。见 [spec](../spec.md)。

服务端：

- `shared/pagination.ts` 增加档位常量（20/50/100/200/500/1000）和每页上限常量 1000，`normalizePageRequest` 的截断改用该常量。
- spec 列出的 12 个列表分页接口，每页条数校验一次全部改成引用共享常量（1..1000）。默认值不变。这样后续工单只需改客户端。
- `normalizeBillingLimit` 的 500 上限改到 1000。

共享分页栏 `client/src/components/PersistentPagination.tsx`：

- 截图布局：整体靠右，「共 N 条」、只有箭头的翻页按钮、页码、「N 条/页」下拉。窄屏时选择器换到第二行，保留「x / y」。
- 删除 `itemName` 参数，所有调用处一并删掉。
- 每页条数由分页状态负责：读取、保存（存储键 `xxx.page` → `xxx.pageSize`）、校验、修改。修改时页码回到 1。请求里的 pageSize 必须取自分页状态。
- 列表接入的方式是传入自己的默认档位。接入后显示选择器，显示条件为总数 > 20。
- 未接入的列表：不显示选择器，每页条数和显示条件（总数 > 每页条数）沿用现状。共享逻辑不得读写它们的 pageSize 存储键。规则页的旧工具栏选择器和 `forwardx.rules.pageSize` 里的旧值（12/24/36/48）原样保留，到工单 05 再迁移。这条过渡路径由工单 09 删除。
- 下拉使用现有 `client/src/components/ui/select.tsx`。
- 同时提供一个「按上限分批请求再合并」的小工具并做单测，供工单 04、05 使用。

账单页 `client/src/pages/Billing.tsx`：

- 5 个列表接入，默认档位：余额流水、订阅、余额记录 20，兑换码、折扣码 50。
- 兑换码按使用状态筛选的 effect（`Billing.tsx:349` 附近）现在首次挂载就会把页码设为 1、清空勾选，与恢复页码冲突。改为首次挂载保留恢复的页码，只有筛选值真的变化时才回第 1 页。
- 兑换码改档位时清空勾选。
- 兑换码勾选超过 500 个时，批量删除按钮禁用，并提示「一次最多删除 500 个兑换码」，不发请求、不分批。`billing.deleteRedemptionCodes` 上限不变。

共享文件归属，避免 02–08 并行时冲突：

- 本单把本轮所有新文案的英文翻译一次加进 `client/src/i18n/en.json`：「{0} 条/页」，以及三条上限提示——「一次最多删除 500 个兑换码」、「一次最多批量处理 50 个工单」、「当前页超过 100 个套餐，请切换到更小的每页条数后再排序」。语言测试允许暂未使用的译文。02–08 原则上不再改 en.json。
- 新增测试文件加入 `package.json` 的 `test:ui`（共享组件）或 `test:payments`（账单）。后续每张工单只往自己指定的脚本行里加。

**Blocked by:** None — can start immediately

**Status:** resolved（分支 feat/list-page-size，提交 652826b）

- [x] 12 个列表分页接口传 `pageSize: 1000` 成功、传 1001 返回 `BAD_REQUEST`；`server/billingPagination.test.ts` 的 101 断言改为 1001，导出首批 500 条的断言保留
- [x] 账单流水超过 500 条时，`pageSize: 1000` 返回的条数与总数一致
- [x] 隧道页 `pageSize: 1` 的汇总请求仍然可用；地图接口按 100 一批的行为不变
- [x] 档位读写纯函数单测：缺失、非法、不在档位里时回落默认档位
- [x] 分批合并工具单测：恰好等于上限、超过上限一条、空数组、合并后不丢不重
- [x] `client/src/components/ui/ui-copy.test.tsx` 改为新文案（「共 100 条」「20 条/页」），保留 `aria-label="第 2 页，共 5 页"`，箭头按钮有可访问名称
- [x] 渲染断言：已接入的列表，总数 ≤ 20 时不渲染分页栏，总数 > 20 且只有一页时渲染；未接入的列表行为同现状
- [x] 自动化交互测试，以实际发出的 tRPC 入参为准，覆盖账单 5 个列表：请求的 pageSize 与所选档位一致；改档位回第 1 页；重新挂载后恢复档位和页码；5 个列表互不影响
- [x] 兑换码：保存在第 2 页后重新挂载，筛选 effect 执行后仍在第 2 页；修改使用状态筛选后回第 1 页
- [x] 兑换码：在第 1 页改档位也会清空勾选；勾选 500 个可以删除；勾选 501 个时按钮禁用、显示提示，并且没有发出删除请求
- [x] 其他列表外观变为新布局，每页条数不变，不显示选择器；规则页旧选择器和 `forwardx.rules.pageSize` 的值不受影响
- [x] `pnpm exec tsc --noEmit`、`pnpm build` 通过
- [x] `test:payments`、`test:billing-export`、`test:ui`、`test:login-ui`、`test:plan-display`、`test:i18n`、`test:server` 通过（含 `client/src/components/ui/pearl-ui.test.tsx`、`client/src/lib/paymentCheckout.test.ts`、`client/src/components/ProductSorting.test.tsx`、`server/paginationQueries.test.ts`）
