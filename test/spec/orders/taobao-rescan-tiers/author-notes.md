# B1-04zzr 规则测试作者说明（claude-independent，SPEC_REF 3f2b91d）

依据：编排者说明 w1-search-linking（D10-798 / D10-804）。新行为全部写在本目录；下面列出按 D10-327 改过的既有冻结用例（只改期望、不删用例、标题不变）。

## 改动的既有冻结用例

| 文件 | 用例标题 | 旧期望 → 新期望 | 原因 |
| --- | --- | --- | --- |
| `test/spec/orders/rescan/config.test.ts` | `[AC-B1-04zm#16] %s 就算配了开关和上限也不回扫`（taobao 分支） | `f.sent()` 长度 1、`f.sent()[0]` 匹配淘宝账号 → 除 `rescan_hour` 外的窗长度 1、且它的第 0 个（不是 `f.sent()[0]`）匹配淘宝账号 | 只给默认开的小时档 `rescan_hour` 让位；周档默认关，「只发一个窗、不混入别的窗」对其余窗照旧成立；`rescanDefaults('taobao')` 那条没改（天档沿用 `{ enabled: true, days: 30 }`） |
| `test/spec/orders/taobao-sync/schedule.test.ts` | `[AC-B1-04zzb#18] 回扫：键未设时淘宝开、回扫 30 天，窗长取规则表 20 分钟；开关与天数按淘宝的键读` | `f.sent()` 等于 `[taobaoRescanWindow(roundStart(30))]`（20 分钟、无 timeBasis）→ 除 `rescan_hour` 外的窗等于 `[{ ...taobaoRescanWindow(roundStart(30), 180 分钟), timeBasis: 'update' }]` | 回扫窗口改读 `window_minutes`（默认 180），载荷带 timeBasis；同一轮小时档会多发窗。**标题里的「20 分钟」与新期望 180 分钟不一致**：这是 D10-327「标题不变」的结果，标题没改，以期望为准 |
| `test/spec/orders/taobao-sync/schedule.test.ts` | `[AC-B1-04zzb#19] 回扫：淘宝开关显式关闭后不回扫；天数在 1～90 内按配置` | ① `send` 没被调用 → 除 `rescan_hour` 外的窗为空；② `days.f.sent()` 等于 `[taobaoRescanWindow(roundStart(45))]` → 除 `rescan_hour` 外的窗等于 `[{ ...taobaoRescanWindow(roundStart(45), 180 分钟), timeBasis: 'update' }]` | `order_sync.rescan.taobao.enabled` 只管天档，小时档默认开照发、周档默认关；窗长与 timeBasis 同上 |
| `test/spec/orders/wiring/module.test.ts` | `[AC-B1-08n#1] worker 装配只注册一次 order-sync，零查询、零投递、零定时器，映射取真实 CSV` | `rescans = 3` → `rescans = 5` | 淘宝三档节奏各不相同（天 / 小时 / 周），每档一条回扫循环；周档默认关也起循环、每轮重读开关（同 pdd 的做法） |

`test/spec/platform/metrics-sync-streams/**` 没有钉「rescan_* 照常计入水位」的用例，没改。kit 文件都没改。

## 小时档（第 1 轮提出、编排者 w1 裁定后钉死）

第 1 轮指出：按说明的模型，小时档起点 = now − 3 小时 + 1 小时余量、窗口 180 分钟，放不下一整窗，永不派发。编排者裁定，本轮据此钉死（`kit.ts` 的 `hourWindow` / `HOUR_WINDOW_MS`，替掉了第 1 轮的宽松断言 `expectHourWindow`）：

- 小时档（rescan_hour）**不加起点余量**：起点 = now − 3 小时（#7、#8、#9、#10、#11、#14、#15）。
- 小时档窗口 = min(实际回扫窗口, 20 分钟)，实际回扫窗口照旧 = promo_mode ? min(window_minutes, 20) : window_minutes；默认值、window_minutes = 60、非法值时都是 20 分钟（#7、#10、#11），window_minutes = 10 时 10 分钟（#9、#42）。
- 节奏 = max(60, floor(1 小时 ÷ (3 小时 ÷ 小时档窗口)))：20 分钟 → 400 秒（#27、#29、#30），10 分钟 → 200 秒（#42）。
- 终点 = min(now, 增量游标)，只发整窗；放不下的最后一窗本轮结束、游标回到 now − 3 小时，不补短窗（#39、#40、#41）。
- `tiers.test.ts` #3 里 hour 档 180 / 60 分钟的两行是纯公式 `rescanTierIntervalSeconds(P, D, cap)` 的取值（传进去的 cap 就是窗口），没有改；调度器给小时档传的是封顶后的窗口。
- 天档、周档不变：起点 now − D + 1 小时（`RESCAN_START_MARGIN_MS`，与 `rescan/kit.ts` 的 roundStart 一致），窗口 = 实际回扫窗口。

上表三处冻结用例只滤掉 `query_kind = 'rescan_hour'` 的窗（第 3 轮按复审意见从「只留 `rescan`」收紧回来，`rescan_week` 或别的窗混入仍会让它们红），期望不受这次裁定影响；默认值下小时档现在确实会在同一轮多发一个 `rescan_hour` 窗。

## 没有钉死的地方

- `window_minutes` 只钉「正整数分钟合法」；超过 180 分钟是否合法没钉。
- promo_mode 非布尔值、读配置失败时各档怎么处理没钉。
- 处理端拒收的 timeBasis 只钉明显非法的值（`synthetic-basis`、空串、`PAY`、数字）；`settle` / `create` 没钉。

## 骨架（只抛 NotImplemented）

- `domain/platform-rules/rescan.ts`：`rescanTiers(platform)`，类型 `RescanQueryKind`、`RescanTimeBasis`、`RescanTier`。
- `domain/sync-window.ts`：`rescanTierIntervalSeconds(periodMs, depthMs, capMs)`、`isRescanWindowMinutes(value)`、`rescanWindowCapMs(windowMinutes, promoMode)`。
- `application/sync-ports.ts`：`RescanStream.query_kind` 放宽为 `RescanQueryKind`，`OrderRescanWindow.timeBasis?`（只改类型）。
- `platform/metrics/rescan-position.ts`：`isRescanQueryKind(queryKind)`、`countsInWatermarkLag(queryKind)`。
