# 07 — 工单列表改为共享分页，批量改状态限 50 个

**What to build:** 工单主列表（`client/src/pages/SupportTickets.tsx`）自己写的分页改用共享分页栏，默认 20。原来的「共 {0} 个工单」改为「共 {0} 条」。见 [spec](../spec.md)。

服务端：

- `supportTickets.list` 新增每页条数入参，校验用共享常量（1..1000），服务端默认值保持 20。
- `server/repositories/supportTicketRepository.ts` 的 `LIMIT 20` 和返回值里的 `pageSize: 20` 改为参数化。

客户端：

- 页码越界时把页码拉回最后一页，这段逻辑现在按 20 计算，要改成按当前档位算。
- 改档位时清空勾选。现在清空勾选的 effect 依赖里没有每页条数，在第 1 页改档位不会清空，要补上。
- 勾选超过 50 个时，批量改状态的按钮禁用，并提示「一次最多批量处理 50 个工单」，不发请求、不分批。`supportTickets.bulkStatus` 上限 50 和单事务语义都不变。这条提示的英文翻译已在 01 加好。
- 工单服务选择器、工单消息的「加载更早」不在本单范围。

新增测试文件加入 `package.json` 的 `test:support`。

**Blocked by:** 01

**Status:** resolved（分支 lps/07-support-tickets，提交 2793ace，已合并到 feat/list-page-size）

- [x] `supportTickets.list` 传 `pageSize: 1000` 成功、传 1001 返回 `BAD_REQUEST`；不传 pageSize 时仍按 20
- [x] 用超过两页、末页不满的固定数据，在多个 pageSize 下顺序拼接所有页，结果与完整预期序列一致；空结果、末页、末页之后一页的行为与现在一致
- [x] 自动化交互测试，以实际发出的 tRPC 入参为准：请求的 pageSize 与所选档位一致；改档位回第 1 页；重新挂载恢复档位和页码
- [x] 在第 1 页改档位时也会清空勾选
- [x] 勾选 50 个可以批量改状态；勾选 51 个时按钮禁用、显示提示，并且没有发出 `bulkStatus` 请求
- [x] `client/src/components/ui/ui-copy.test.tsx` 中工单相关的双语操作断言保持通过
- [x] `pnpm exec tsc --noEmit`、`pnpm build` 通过
- [x] `test:support`、`test:ui`、`test:i18n` 通过
