# 02 — 用户、用户订阅、套餐列表接入

**What to build:** 用户页的账户列表和订阅标签页（`client/src/pages/Users.tsx`），以及套餐列表（`client/src/pages/Plans.tsx`），接入工单 01 的共享每页条数，默认 20（原来是 12）。服务端上限已经在 01 改好，这里只改客户端。见 [spec](../spec.md)。

套餐拖动排序会一次提交整页 ID，`plans.reorder` 最多接受 100 个，这个上限不改。当前页超过 100 个套餐时不允许拖动排序，并提示「当前页超过 100 个套餐，请切换到更小的每页条数后再排序」。这条提示的英文翻译已在 01 加好。

新增测试文件加入 `package.json` 的 `test:plan-display`。

**Blocked by:** 01

**Status:** resolved（分支 lps/02-users-plans，提交 2816e4b，已合并到 feat/list-page-size）

- [x] 自动化交互测试，以实际发出的 tRPC 入参为准：三个列表请求的 pageSize 与所选档位一致；默认 20；改档位回第 1 页；重新挂载恢复；三个列表互不影响
- [x] 当前页正好 100 个套餐时可以拖动排序，`startIndex` 语义不变；101 个时不能拖动、显示提示，并且没有发出 `plans.reorder` 请求
- [x] `client/src/components/ProductSorting.test.tsx` 的 `startIndex: (planPagination.currentPage - 1) * planPagination.pageSize` 断言保持通过
- [x] `server/productOrder.test.ts`（`test:plan-display`）、`server/userTrafficBillingReset.test.ts` 和 `server/subscriptionBillingState.test.ts`（`pretest:server`）保持通过
- [x] `pnpm exec tsc --noEmit`、`pnpm build` 通过
- [x] `test:plan-display`、`pnpm run pretest:server`、`test:ui`、`test:i18n` 通过
