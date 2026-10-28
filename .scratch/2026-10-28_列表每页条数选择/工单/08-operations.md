# 08 — 运营的四个列表改为共享分页

**What to build:** 运营页的来源 IP（`client/src/components/OperationsSourceList.tsx`）、财务流水（`client/src/components/OperationsFinanceSummary.tsx`）、资源告警事件和 IP 更换事件（`client/src/components/OperationsMonitorPanel.tsx`），自己写的分页改用共享分页栏，默认 20。见 [spec](../spec.md)。

服务端：

- `operations.sources`、`operations.financeLedger` 各新增一个每页条数入参。
- `operations.monitor` 新增两个：告警事件和 IP 更换事件各一个（如 `pageSize` 和 `ipPageSize`）。
- 校验都用共享常量（1..1000）。服务端默认值保持现有固定值：来源 IP 10、财务流水 10、两个事件列表各 20。`OPERATIONS_SOURCE_PAGE_SIZE`、`OPERATIONS_LEDGER_PAGE_SIZE` 和 `monitorOverview` 里的 `LIMIT 20` 改为参数化。
- 三个接口的缓存键加上每页条数。`monitor:${page}:${ipPage}` 两个每页条数都要加。
- 页码仍从 0 开始，客户端在边界处换算。

客户端：

- 分页栏以外，还有几处写死按 10 计算，都要改成按当前档位：
  - 来源 IP 的跨页序号：`OperationsSourceList.tsx:27` 附近的 `page * OPERATIONS_SOURCE_PAGE_SIZE`；
  - 来源 IP 的最后一页纠偏：`Operations.tsx:59` 附近；
  - 财务流水的总页数：`OperationsFinanceSummary.tsx:45` 附近的固定除以 10。
- 首次挂载时的重置要去掉：`Operations.tsx` 的搜索防抖 effect 和 `OperationsFinanceSummary` 的日期 effect，现在首次挂载就会把页码清零。改为首次挂载保留恢复的页码，只有日期范围、用户范围、搜索、排序真的变化时才回第 1 页。
- 两个事件列表共用一个查询，但页码和档位各自独立，改一个不重置另一个。

新增测试文件加入 `package.json` 的 `test:operations`。

**Blocked by:** 01

**Status:** resolved（分支 lps/08-operations，提交 3fd7e52，已合并到 feat/list-page-size）

- [x] 三个接口传每页条数 1000 成功、传 1001 返回 `BAD_REQUEST`（`monitor` 的两个参数分别验证）
- [x] 用超过两页、末页不满的固定数据，在多个每页条数下顺序拼接所有页，结果与完整预期序列一致；两个事件列表分别覆盖；从 0 开始的页码换算正确；空结果、末页、末页之后一页的行为与现在一致
- [x] 不传每页条数时按现有默认值返回：`server/operations.test.ts`、`server/operationsFinance.test.ts` 中按 10 条的断言，以及 `server/observability.fixture.ts` 中 IP 事件按 20 条分页的断言（由 `test:observability` 运行）保持通过
- [x] 缓存隔离：缓存有效期内固定页码，先只改告警事件的每页条数，再只改 IP 更换事件的每页条数，分别断言对应列表变化、另一个不变；调换请求顺序再验一次。`sources`、`financeLedger` 各自验证同一页不同每页条数返回不同结果
- [x] 自动化交互测试，以实际发出的 tRPC 入参为准：四个列表请求的每页条数与所选档位一致；改档位回第 1 页；重新挂载恢复；四个列表互不影响
- [x] 来源 IP 序号、来源 IP 最后一页纠偏、财务流水总页数在档位 50 时都正确
- [x] 首次挂载不把恢复的页码重置；修改日期范围、用户范围、搜索或排序后回第 1 页
- [x] 改告警事件的档位或页码，不影响 IP 更换事件，反之亦然
- [x] `client/src/components/OperationsChinaMap.test.tsx` 随 `OperationsSourceList` 的改造更新（原来按每页 10 条断言「第 2 页，共 9 页」）
- [x] `client/src/components/ui/ui-copy.test.tsx` 中运营监控面板的断言保持通过
- [x] `pnpm exec tsc --noEmit`、`pnpm build` 通过
- [x] `test:operations`、`test:observability`、`test:ui`、`test:i18n` 通过
