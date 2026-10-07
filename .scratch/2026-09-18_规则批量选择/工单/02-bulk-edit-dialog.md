# 02 — 选中操作栏与批量编辑对话框

Status: resolved

**What to build:** 选中数大于 0 时，在筛选工具栏与列表之间展开一条操作栏。点「批量编辑」打开一个小对话框，两块独立的替换项——替换入口资源（入口类型 + 资源下拉）和替换转发出口（目标地址 + 目标端口）——加一个端口冲突处理。未填写的项保留每条规则原来的值。

执行层复用 `Rules.tsx` 里现成的 `buildBatchEditRulePayload`、`updateBatchRuleTarget`、`runBatchOperations`，不新增服务端接口。

规格见 `../spec.md`。

**Blocked by:** 01 — 规则列表行内多选

## 验收标准

### 新增文件
- [x] 操作栏放在 `client/src/components/rules/RuleBulkActionBar.tsx`
- [x] 对话框放在 `client/src/components/rules/RuleBulkEditDialog.tsx`
- [x] 两个组件都不直接调 tRPC，执行函数由 `Rules.tsx` 作为 prop 传入
- [x] 混合入口类型的预选判断和执行结果归纳放进 01 建立的 `client/src/lib/ruleBulkSelection.ts`，并补进它的测试文件

### 执行函数改为接受显式覆盖参数

`buildBatchEditRulePayload` 和 `updateBatchRuleTarget` 今天是**闭包读大弹窗的组件状态**（`batchEditForm`、`selectedBatchEditTunnel`、`selectedBatchEditForwardGroup`、`batchEditTargetIp`、`batchEditTargetPort`、`copyConflictStrategy`），签名里只有 `rule` 和 `sourcePort`。内联对话框有自己独立的表单和不同的冲突策略默认值，直接复用会读到大弹窗的状态。

解决办法是给两个函数加一个**可选**的覆盖参数，不传时行为与今天完全一致：

```ts
type RuleBulkEditInput = {
  routeMode: RuleRouteMode;              // local | tunnel | chain | group
  tunnelId: number | null;
  forwardGroupId: number | null;
  targetIp: string;                      // "" 表示不改
  targetPort: number;                    // 0 表示不改
  conflictStrategy: "skip" | "auto" | "error";
};

buildBatchEditRulePayload(rule, sourcePort, override?: RuleBulkEditInput)
updateBatchRuleTarget(rule, override?: RuleBulkEditInput)
```

- [x] 两个函数加可选覆盖参数，`override` 缺省时从组件状态读取，逻辑与改动前逐字节一致
- [x] `override` 存在时，入口是否替换、选中的隧道/转发组、目标地址与端口、冲突策略**全部**从 `override` 推导，不读任何大弹窗状态
- [x] 内联路径完全不引用 `batchEditForm`、`copyConflictStrategy`、`selectedBatchEditTunnel`、`selectedBatchEditForwardGroup`，也不调用它们的 setter
- [x] 内联对话框点「应用」时把当前表单打成一个快照对象一次性传入，不依赖 React state 是否已提交——验证「改完下拉立刻点应用」用的是新值而不是上一轮渲染的值

### 两个弹窗的状态互不影响
- [x] 内联对话框首次打开时冲突策略是 `error`；同一次会话里打开大弹窗的批量编辑页签，它的冲突策略仍是 `auto`
- [x] 在大弹窗里把冲突策略改成 `skip` 并关闭，再打开内联对话框，内联仍是 `error`
- [x] 在内联对话框里选了转发链 X 并应用，再打开大弹窗，大弹窗的入口资源仍是「不替换入口」
- [x] 连续两次内联操作之间表单重置，第二次打开不残留第一次的选择

### 操作栏
- [x] 选中数为 0 时不出现；大于 0 时在筛选工具栏与列表之间展开，普通文档流，不做固定或浮动定位
- [x] 显示「已选 N 条（本页）」，带「清空」
- [x] 含「批量编辑」按钮
- [x] 移动端一行放不下时能换行，不横向溢出

### 对话框：替换入口资源
- [x] 入口类型四选一（端口转发 / 隧道转发 / 转发链 / 转发组），不可用的类型置灰，与大弹窗的可用性判断一致
- [x] 资源下拉复用大弹窗同款渲染，带状态点与倍率标签
- [x] 所选规则入口类型一致时预选该类型并直接展开对应资源下拉
- [x] 所选规则入口类型不一致时不预选，并在本块内显式提示「所选包含 N 种入口类型，应用后会全部改为 X」
- [x] 不选资源时本块不生效，保留每条规则原来的入口

### 对话框：替换转发出口
- [x] 块标题「替换转发出口」，字段为「目标地址」「目标端口」
- [x] 两个字段各自留空则保持该规则原来的值
- [x] 目标地址填了但不是合法主机时拦下并提示
- [x] 目标端口填了但不在 1–65535 时拦下并提示

### 对话框：端口冲突处理
- [x] 三个选项都给：跳过冲突规则 / 自动分配新端口 / 保持原端口，冲突则该条失败
- [x] **默认选中「保持原端口，冲突则该条失败」**，与大弹窗的 `auto` 默认不同
- [x] 下方写明原因：SNI 分流规则共用同一入口端口，自动改端口会把一组规则打散
- [x] 仅在替换入口资源时生效，未替换入口时该项置灰

### 执行与反馈
- [x] 两块都没填时「应用」置灰
- [x] 顶部显示「将对 N 条规则生效」
- [x] 执行复用 `runBatchOperations` 并发 6 逐条调 `rules.update`，不新增服务端接口
- [x] 执行中按钮进入 pending，不可重复提交
- [x] 完成后刷新规则列表、汇总、流量等相关查询，与大弹窗批量编辑后的失效范围一致
### 成功、跳过、失败要分开统计

`updateBatchRuleTarget` 对端口冲突有三种归宿，其中「跳过」返回 `{ updated: false, skipped: true }`——它在 `runBatchOperations` 里是**正常返回**，不带错误对象，所以不能并进失败里统计，否则 toast 里的「第一条错误」无数据可取。

三个计数分别统计，按下表给提示。跳过只在冲突策略选了「跳过冲突规则」时才可能非零；默认策略是「保持原端口，冲突则该条失败」，此时冲突计入失败。

纯函数吃的是**逐条结果**，不是计数——计数里没有规则编号，算不出该保留哪几条勾选。规则 A 成功 B 失败，与 B 成功 A 失败，三个计数完全相同，要保留的编号却相反。

```ts
type RuleBulkOutcome = {
  ruleId: number;
  outcome: "updated" | "skipped" | "failed";
  error?: string;                  // 仅 failed 携带
};

summarizeRuleBulkResult(outcomes: RuleBulkOutcome[]): {
  updated: number;
  skipped: number;
  failed: number;
  tone: "success" | "error";
  message: string;
  keepSelectedIds: number[];       // 所有 skipped 与 failed 的 ruleId
  closeDialog: boolean;
}
```

- [x] `summarizeRuleBulkResult` 放进 `ruleBulkSelection.ts`，输入逐条结果数组，三个计数在函数内部派生
- [x] `Rules.tsx` 负责把 `runBatchOperations` 的返回映射成 `RuleBulkOutcome[]`：`result.item.id` 取编号，`result.status === "rejected"` 记 failed 并带 `result.reason` 的文案，否则按 `result.value.updated` / `result.value.skipped` 记
- [x] 这一步映射是薄的，不含任何提示文案或保留策略的判断
- [x] `updated>0, skipped=0, failed=0` → success toast「已批量编辑 N 条规则」，清空选择，关闭对话框
- [x] `updated>0, skipped>0, failed=0` → toast「已批量编辑 N 条，跳过 M 条（端口冲突）」，成功项取消勾选、**跳过项保留勾选**，关闭对话框
- [x] `updated=0, skipped>0, failed=0` → toast「M 条规则因端口冲突全部跳过，未做任何修改」，**全部保留勾选，对话框不关闭**，让用户当场改冲突策略重试
- [x] `failed>0`（无论其他两个数）→ error toast「成功 N 条，跳过 M 条，失败 K 条：<第一条错误>」，成功项取消勾选、跳过与失败项保留勾选，关闭对话框
- [x] `updated=0, skipped=0, failed>0` → error toast 不显示「成功 0 条，跳过 0 条」这种噪音，只报失败数与第一条错误
- [x] `keepSelectedIds` 恒等于所有 skipped 与 failed 的 `ruleId`，与它们在输入数组里的位置无关
- [x] 保留勾选后直接再点一次「批量编辑」即为重试剩余项

### 结果归纳的测试
- [x] 五种计数组合各一条，断言 `tone` / `message` / `closeDialog`
- [x] **断言 `keepSelectedIds` 的集合本身，不只断言数量**
- [x] 一条非对称用例：`[{A, updated}, {B, failed}]` 与 `[{A, failed}, {B, updated}]` 三个计数相同，但 `keepSelectedIds` 分别是 `[B]` 和 `[A]`
- [x] 一条三种结果并存的用例：成功、跳过、失败各至少一条，验证 `keepSelectedIds` 同时包含跳过项和失败项

### 不回归
- [x] 大弹窗的批量编辑页签行为、默认值（端口冲突默认 `auto`）一个字不变
- [x] `buildBatchEditRulePayload` 与 `updateBatchRuleTarget` 只增加可选参数，原有代码路径（不传参数）的行为未改变
- [x] `runBatchOperations` 的实现完全未被修改
- [x] 大弹窗的批量复制路径（也调用 `runBatchOperations` 与冲突策略）不受影响

## Comments

2026-09-18 实施摘要：`buildBatchEditRulePayload`、`updateBatchRuleTarget` 加可选 `override` 参数，缺省时逐字节保持原大弹窗行为；内联对话框在「应用」时把表单打成快照传入，不依赖 React state 提交时序。新增 `RuleBulkActionBar.tsx`、`RuleBulkEditDialog.tsx`，两块替换项（入口资源 / 转发出口）与端口冲突处理均按规格实现，冲突默认值为 `error`（大弹窗仍是 `auto`）。结果归纳 `summarizeRuleBulkResult` 落在 `ruleBulkSelection.ts`，吃逐条 `RuleBulkOutcome[]`，`keepSelectedIds` 恒等于 skipped/failed 的 `ruleId`；`Rules.tsx` 只做薄映射。五种计数组合 + 非对称用例 + 三类并存用例均有测试覆盖。`tsc --noEmit`、`pnpm test:server`（664/664）、`pnpm build` 均通过。
