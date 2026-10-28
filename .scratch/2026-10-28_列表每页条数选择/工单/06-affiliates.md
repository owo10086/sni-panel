# 06 — 推广列表改为共享分页

**What to build:** 推广页（`client/src/pages/Affiliates.tsx`）自己写的分页改用共享分页栏，默认 20。涉及 `Records` 组件的佣金、提现、佣金流水、邀请记录（用户视图和管理员视图共用这个组件），以及管理员账户总览。见 [spec](../spec.md)「改为共享分页的自写分页列表」。

服务端：

- `affiliates.list`、`affiliates.adminList`、`affiliates.adminOverview` 新增每页条数入参，校验用共享常量（1..1000），服务端默认值保持 20。
- `server/repositories/affiliateRepository.ts` 里的 `LIMIT 20 OFFSET (page-1)*20` 改为参数化。

客户端：

- 改成共享分页后，这些列表会记住页码和档位。存储键要区分记录种类，以及用户视图和管理员视图。
- 管理员总览的搜索防抖 effect 现在首次挂载就把页码设为 1。改为首次挂载保留恢复的页码，只有搜索条件真的变化时才回第 1 页。
- `Records` 切换记录种类时，现在会对当前列表调用 `setPage(1)`。改为切换到目标种类自己记住的页码和档位，不改写来源种类的存储。
- 管理员保存推广配置后，会用 `utils.affiliates.adminOverview.setData({ page, search })` 更新缓存（`Affiliates.tsx:896` 附近）。查询加上 pageSize 后，这里的入参必须和查询完全一致，否则更新不到当前缓存。
- 原来的 `Pager` 组件和写死的 20 删除。

新增测试文件加入 `package.json` 的 `test:affiliates`。

**Blocked by:** 01

**Status:** resolved（分支 lps/06-affiliates，提交 8393595，已合并到 feat/list-page-size）

- [x] 三个接口传 `pageSize: 1000` 成功、传 1001 返回 `BAD_REQUEST`；不传 pageSize 时仍按 20
- [x] 三个接口用超过两页、末页不满的固定数据，在多个 pageSize 下顺序拼接所有页，结果与完整预期序列一致；空结果、末页、末页之后一页的行为与现在一致
- [x] 自动化交互测试，以实际发出的 tRPC 入参为准：各列表请求的 pageSize 与所选档位一致；改档位回第 1 页；重新挂载恢复；不同种类、用户视图和管理员视图互不影响
- [x] 首次挂载不把恢复的页码重置为 1；修改搜索后回第 1 页
- [x] 切换记录种类再切回，原种类的页码和档位不变
- [x] `client/src/pages/Affiliates.test.tsx` 补一条回归：保存配置后 `adminOverview.setData` 的入参与当前查询一致，包含 pageSize
- [x] `pnpm exec tsc --noEmit`、`pnpm build` 通过
- [x] `test:affiliates`、`test:i18n` 通过
