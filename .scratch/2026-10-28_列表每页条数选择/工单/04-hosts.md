# 04 — 主机列表接入，状态、指标、流量请求分批

**What to build:** 主机列表（`client/src/pages/Hosts.tsx`，卡片、紧凑卡片、表格三种视图）接入工单 01 的共享每页条数，默认 20（原来是 12）。见 [spec](../spec.md)「按当前页提交的请求」。

主机页会把当前页的全部主机 ID 提交给四个接口。服务端上限不改，客户端用 01 提供的分批工具按上限分批请求，再合并结果：

| 接口 | 每批上限 |
|---|---|
| `hosts.statusSummary` | 100 |
| `hosts.watchMetrics` | 200 |
| `hosts.latestMetricsSummary` | 500 |
| `hosts.trafficSummary` | 500 |

- `watchMetrics` 首次调用和定时调用都要分批。
- 当前页的每台主机都要拿到状态、指标和流量，不能因为排在上限之后而缺数据。
- 地图和平面地图模式下，窄屏有两处分页栏（`Hosts.tsx:2581`、`:2598` 附近）。它们的位置和去留保持不变；它们与普通列表共用 `hostPagination`，会跟着共享组件和档位一起改。地图的分批加载不变。

新增测试文件加入 `package.json` 的 `test:host-load`。

**Blocked by:** 01

**Status:** resolved（分支 lps/04-hosts，提交 2b9616f，已合并到 feat/list-page-size）

- [x] 自动化交互测试，以实际发出的 tRPC 入参为准：主机列表请求的 pageSize 与所选档位一致；默认 20；改档位回第 1 页；重新挂载恢复
- [x] 当前页 101、201、501 台主机时，四个接口都没有 `BAD_REQUEST`，每批都不超过上限，每台主机都显示状态、指标和流量
- [x] 一页不超过上限时请求次数与现在相同，不多发
- [x] 四个接口的服务端上限不变
- [x] `server/hostUserSortOrder.test.ts`、`server/paginationQueries.test.ts`（`test:server`）和 `server/displayQueryRoutes.test.ts`（`test:performance`）保持通过
- [x] `pnpm exec tsc --noEmit`、`pnpm build` 通过
- [x] `test:host-load`、`test:list-settings`、`test:server`、`test:performance`、`test:i18n` 通过
