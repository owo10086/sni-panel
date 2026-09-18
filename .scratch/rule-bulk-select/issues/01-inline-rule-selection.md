# 01 — 规则列表行内多选

Status: resolved

**What to build:** 管理员能在转发规则列表里直接勾选多条规则。表格视图最左固定一列勾选框、表头带全选；卡片视图（标准与紧凑）在状态点左侧带勾选框；SNI 规则组的组头带三态勾选框，一键选中整组。选择范围只算当前页，翻页与改筛选清空。

本票只做选择本身，不含操作栏和任何批量动作。

规格见 `../spec.md`。

**Blocked by:** None

## 验收标准

### 新增文件
- [x] 纯逻辑放在 `client/src/lib/ruleBulkSelection.ts`：可选性判定、三态计算、选择集合增删与剪枝。照 `client/src/lib/sniRuleForm.ts` 的先例，文件头注释指回 `../spec.md`
- [x] 对应测试 `client/src/lib/ruleBulkSelection.test.ts`，覆盖：空集合、整组不可选、部分选中、全选、勾组头选整组、取消整组、刷新后剔除已消失的 ID
- [x] **新测试文件加进 `package.json` 的 `test:server` 脚本文件列表**（紧挨着已有的 `client/src/lib/sniRuleForm.test.ts`、`client/src/lib/batchOperations.test.ts`）。仓库没有裸的 `test` 脚本，CI 跑的是 `pnpm test:server`（`.github/workflows/ci.yml`），不登记在这里就永远不会被执行
- [x] 登记后跑一次 `pnpm test:server`，确认新测试被执行且全绿
- [x] React 侧状态容器放在 `client/src/components/rules/useRuleBulkSelection.ts`，只做状态与副作用，判断逻辑一律调 lib 里的纯函数
- [x] 三态勾选框组件放在 `components/rules/` 下，用 `indeterminate` ref 实现，不新建 `components/ui/checkbox.tsx`
- [x] `Rules.tsx` 里不出现任何选择判断逻辑，只有挂载点

### 表格视图

列顺序统一为 **选择列 → 排序列（仅排序开启时存在）→ 状态列 → …**。`<colgroup>`、`<TableHeader>`、`renderRuleTableRow` 三处必须是同一个顺序，否则列宽会错配到相邻列上。两列都是 44px，肉眼看不出来。

- [x] `renderRuleTableRow` 的勾选格插在现有排序格**之前**，成为第一个 `<TableCell>`
- [x] 表头的勾选 `<TableHead>` 插在现有排序 `<TableHead>` **之前**
- [x] 表头勾选框为三态：本页可选规则全选中显示选中、部分选中显示半选、都没选显示未选
- [x] 点表头勾选框在「全选本页可选」与「清空」之间切换
- [x] 验证：排序开启时（任一非「全部」类别页签）列宽不发生整体右移或错位

### 表格的四处宽度与跨度定义必须同步

表格的列定义散在四个地方，只改其中一处会让列宽错位或组头少覆盖一列。四处都要改，并且**管理员视图和普通账号视图都要验证**：

- [x] `<colgroup>` 的**第一个** `<col>` 是选择列 `<col className="w-[44px]" />`，排在排序列 `<col>` 之前、与表头和数据行的顺序一致
- [x] `<Table>` 的四个 min-width 硬编码值各加 44px：`min-w-[1954px]`→`1998`、`min-w-[1844px]`→`1888`、`min-w-[1910px]`→`1954`、`min-w-[1800px]`→`1844`
- [x] SNI 组头用的 `ruleTableColumnCount` 加 1
- [x] 类别组头的硬编码 `colSpan={user?.role === "admin" ? 14 : 13}` 加 1
- [x] 验证：表格横向不出现错位，SNI 组头与类别组头都仍然铺满整行

> 类别组头原本不加排序列是正确的——它只在 `ruleCategory === "all"` 时渲染，而 `ruleSortingEnabled` 要求 `ruleCategory !== "all"`，两者互斥。勾选列与它不互斥，所以必须加。不要顺手把排序列也加进去。

### 卡片视图
- [x] 标准卡片在状态点左侧、同一行带勾选框
- [x] 紧凑卡片同位置带勾选框，尺寸小一号，不撑破现有布局
- [x] 移动端（强制卡片视图）勾选框可点且不与开关、拖拽手柄重叠

### 全选的三层入口

「列表视图」在窄屏下不渲染表格，而是走 `sm:hidden` 的卡片布局；卡片视图本身又是默认视图。所以全选不能只挂在 `<TableHeader>` 上。

- [x] 表格视图（≥640px）的全选在表头勾选框
- [x] 卡片视图，以及列表视图的手机布局（<640px），在列表上方有一行「全选本页」
- [x] 这一行在表格视图下带 `sm:hidden`，不与表头的全选同时出现
- [x] 本页没有规则时这一行不渲染
- [x] 类别组头（端口转发 / 隧道转发 / 转发链 / 转发组）带三态勾选框，勾选范围是该类别在**本页**的规则
- [x] 类别组头的勾选框在表格和卡片两个视图都出现（`renderRuleGroupHeader` 共用）
- [x] 点类别组头的勾选框不会连带折叠或展开该分组
- [x] 三层全选互相一致：勾满某类别后类别组头显示全选、页级显示半选；勾满整页后三层都显示全选

### SNI 组头
- [x] 表格和卡片两种视图的组头都带三态勾选框
- [x] 勾组头选中组内全部可选规则，再点取消整组
- [x] 组内部分选中时组头显示半选
- [x] 组折叠状态下组头勾选框照常可用
- [x] 整组都不可选时组头勾选框置灰

### 可选性
- [x] 转发组派生规则（`forwardGroupRuleId` 或 `forwardGroupMemberId` 非空）勾选框置灰，悬停写明「转发组派生规则不支持批量修改」
- [x] 当前运行时不支持的协议（`isRuleSupported` 为假）勾选框置灰，悬停写明原因
- [x] 全选与三态计算只统计可选规则，置灰的规则永远不进选择集合

### 数据未落地时禁止勾选

`rules.listPage` 配了 `placeholderData: (previousData) => previousData`。翻页或改筛选后、新数据回来之前，列表上显示的仍然是**上一页的规则**。只做「翻页时清空集合」不够——清空之后用户照样能在这份旧数据上勾选，选进上一页的规则，再交给批量编辑或删除。

现有排序功能已经有这个先例：`ruleSortingReady = ruleSortingEnabled && !rulePageQuery.isPlaceholderData`。

- [x] `rulePageQuery.isPlaceholderData` 为真时，行勾选框、组头勾选框、表头全选框一律禁用
- [x] 同一时刻操作栏上的批量执行按钮也禁用
- [x] 数据落地后自动恢复可用，不需要用户额外操作
- [x] 验证：快速连续翻页时不会有任何上一页的规则 ID 进入选择集合

### 选择范围
- [x] 全选本页的数据源是 `pagedRules`，包含折叠 SNI 组内部的规则
- [x] 翻页清空选择
- [x] 切类别页签、改资源筛选、改用户筛选、改搜索词，各自清空选择
- [x] 卡片↔表格切换、改卡片密度，选择保留
- [x] 轮询刷新后已不存在的规则自动从选择里剔除

### 不回归
- [x] 类别组头改为 `<div>` 包裹勾选框与按钮后，折叠/展开、图标、计数徽标、描述文案与改动前一致
- [x] 类别组头在表格视图里仍然铺满整行（它在一个 `colSpan` 的 `<TableCell>` 里）
- [x] 表格排序拖拽功能与改动前一致
- [x] SNI 组的折叠/展开与折叠状态持久化与改动前一致
- [x] 3D 流量转发图视图不出现任何勾选框

## Comments

2026-09-18 实施摘要：新增 `client/src/lib/ruleBulkSelection.ts`（可选性判定、三态计算、选择集合增删与剪枝）及其测试（13 项），登记进 `test:server`。`Rules.tsx` 挂载点：表格视图选择列固定在排序列之前，`<colgroup>`/`<Table>` min-width/`ruleTableColumnCount`/类别组头 `colSpan` 四处同步 +1（管理员 15、普通 14）；SNI 组头与类别组头均带三态勾选框；卡片视图（标准/紧凑）在状态点左侧带勾选框；卡片布局与列表视图的手机断点额外提供一行「全选本页」，覆盖表头之外的两种情形。`rulePageQuery.isPlaceholderData` 为真时全部勾选框禁用，避免翻页占位期间误选上一页规则。`tsc --noEmit`、`pnpm test:server`（664/664）、`pnpm build` 均通过。
