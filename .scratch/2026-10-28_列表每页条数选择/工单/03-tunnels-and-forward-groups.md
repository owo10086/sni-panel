# 03 — 隧道与转发组列表接入

**What to build:** 隧道列表（`client/src/pages/Tunnels.tsx`），以及 `ForwardGroupsContent` 的五种转发组列表（端口转发、故障转移组、转发链、入口组、出口组），接入工单 01 的共享每页条数，默认 20（原来是 12）。转发组既出现在独立的转发组页面，也出现在隧道页的各个标签页里。只改客户端。见 [spec](../spec.md)。

- 五种转发组的存储键各自派生自现有页码键（如 `forwardx.forwardGroups.port.page` → `forwardx.forwardGroups.port.pageSize`），互不影响。
- 隧道页用 `pageSize: 1` 请求分区汇总，这不是列表分页，保持不变。
- 转发链地球视图会挂载一个隐藏的 `ForwardGroupsContent`，接入后不能因此多发分页请求，也不能改写转发链列表的存储。
- 隧道和转发组的拖动排序接口没有数量上限，不需要额外处理。

新增测试文件加入 `package.json` 的 `test:port-entry`。

**Blocked by:** 01

**Status:** resolved（分支 lps/03-tunnels-forward-groups，提交 ca12c93，已合并到 feat/list-page-size）

- [x] 自动化交互测试，以实际发出的 tRPC 入参为准：隧道列表和五种转发组列表请求的 pageSize 与所选档位一致；默认 20；改档位回第 1 页；重新挂载恢复；各列表互不影响
- [x] 隧道页分区汇总仍以 `pageSize: 1` 请求，汇总数字不变
- [x] 当前页内的拖动排序在大档位下仍然正确
- [x] `client/src/components/ui/pearl-ui.test.tsx` 中 ForwardGroups 的 `className="mt-5"` 断言保持通过
- [x] `pnpm exec tsc --noEmit`、`pnpm build` 通过
- [x] `test:port-entry`、`test:ui`、`test:i18n` 通过
