# 09 — 删除过渡路径，整体验收

**What to build:** 02–08 完成后，所有共享分页列表都已接入每页条数。删除工单 01 为未接入列表保留的过渡路径，让共享分页栏只剩一种行为：始终显示选择器，显示条件为总数 > 20。然后对照 [spec](../spec.md) 整体验收。

- 删除过渡路径及只为它写的测试，确认没有调用方依赖它。`usePersistentPagination` 当前没有业务调用方；它要么同样接入每页条数，要么删除，不保留两套规则。
- 对照用户截图核对桌面和窄屏布局：整体靠右，「共 N 条」、箭头、页码、「N 条/页」；窄屏时选择器在第二行。
- 逐个核对 26 个列表的默认档位：
  - 原有共享分页的 16 个：账单 5、用户和用户订阅 2、套餐 1、隧道 1、转发组 5、主机 1、规则 1；
  - 原来自己写分页的 10 个：推广 5、工单 1、运营 4。
  - 推广 `Records` 的用户视图和管理员视图分别验收存储隔离。同一列表的多处分页栏（如主机页）只算一个。
- 核对 Out of Scope 中的项目确实没有变化：弹窗里的选择器、日志翻页、地图的分批加载、地图模式下分页栏的位置和去留等。

**Blocked by:** 02, 03, 04, 05, 06, 07, 08

**Status:** resolved（分支 lps/09-wrap-up，提交 02fc64c，已合并到 feat/list-page-size 的 29e36a5）

- [x] 共享分页组件只剩一种显示规则，过渡路径和只为它写的测试已删除
- [x] 26 个列表都显示选择器，默认档位与 spec 一致
- [x] 桌面和窄屏布局与截图一致，有截图留证（`../截图/`：桌面分页栏、档位下拉展开、窄屏 390px）
- [x] `pnpm exec tsc --noEmit`、`pnpm build` 通过
- [x] `pnpm run pretest:server`、`test:server`、`test:ui`、`test:i18n`、`test:payments`、`test:billing-export`、`test:plan-display`、`test:affiliates`、`test:support`、`test:operations`、`test:observability`、`test:user-selection`、`test:sni-classification`、`test:rule-groups`、`test:port-entry`、`test:host-load`、`test:list-settings`、`test:performance`、`test:login-ui` 全部通过
