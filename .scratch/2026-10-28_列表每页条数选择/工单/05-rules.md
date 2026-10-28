# 05 — 规则列表接入，迁移旧选择器，所属用户和流量请求分批

**What to build:** 规则列表（`client/src/pages/Rules.tsx`）接入工单 01 的共享每页条数，默认 20。去掉工具栏里的旧选择器。见 [spec](../spec.md)「规则页」和「按当前页提交的请求」。

旧选择器：

- 删除工具栏的「每页数量」选择器、`RULE_PAGE_SIZE_OPTIONS`、`RulePageSize`，以及紧凑卡片默认 24 的逻辑。
- 读取 `forwardx.rules.pageSize` 时先取原始值，旧值往上取档：12 → 20，24/36/48 → 50；再按新档位校验。现有读取函数（`Rules.tsx:566` 附近）只接受旧档位，要替换掉。
- 计数单位不变：一个 SNI 组算 1 条展示单元。`ruleStartIndex`、当前页全选、筛选键和选择范围里带 pageSize 等逻辑不变。改档位会清空勾选，现在就是这样。

分批请求（服务端上限不变，用 01 提供的分批工具）：

- 所属用户：`users.optionsByIds` 每批 100。`client/src/lib/userSelection.ts` 的 `ruleOwnerOptionIds` 现在截到 100 个，要改成取全部；`client/src/components/UserSelect.test.tsx` 中断言 100 截断的用例改为断言取全部。服务端仓储层单次截 100 的逻辑不变。
- 流量：`rules.trafficSummary` 每批 1000。SNI 组展开后，一页的规则 ID 可能超过 1000。`range: "total"` 和 `range: "24h"` 两种请求都要分批。

新增测试文件加入 `package.json` 的 `test:sni-classification`。

**Blocked by:** 01

**Status:** resolved（分支 lps/05-rules，提交 22e7b19，已合并到 feat/list-page-size）

- [x] 自动化交互测试，以实际发出的 tRPC 入参为准：规则列表请求的 pageSize 与所选档位一致；默认 20；改档位回第 1 页并清空勾选；重新挂载恢复
- [x] 旧值迁移单测：12 → 20，24/36/48 → 50，缺失或非法时用默认 20
- [x] 工具栏不再有每页数量选择器，代码里不再引用 `RULE_PAGE_SIZE_OPTIONS`
- [x] 管理员视图下当前页规则涉及超过 100 个用户时，每批不超过 100，每条规则都显示用户名，不出现「用户 #ID」
- [x] 当前页展开后超过 1000 条规则时，流量请求没有 `BAD_REQUEST`，每批不超过 1000，每条规则都有流量数据
- [x] `server/sniRuleCategory.test.ts`（含「a group stays whole even at size 1」）、`server/ruleGroups.test.ts` 保持通过
- [x] `client/src/lib/ruleBulkSelection.test.ts`、`server/ruleOwnerSniPermissions.test.ts`、`server/paginationQueries.test.ts`（都在 `test:server`）保持通过
- [x] `client/src/components/ui/pearl-ui.test.tsx` 中 Rules 的 `className="mt-5"` 断言保持通过
- [x] `pnpm exec tsc --noEmit`、`pnpm build` 通过
- [x] `test:user-selection`、`test:sni-classification`、`test:rule-groups`、`test:server`、`test:ui`、`test:i18n` 通过
