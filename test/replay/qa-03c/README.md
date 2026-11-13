# QA-03c：合成数据回放

本单是 `test-change`，目标是**主干上合成数据回放绿**，不创建 `NotImplemented` 骨架。
没有真实平台录制，`provenance.json` 的 `source` 是 `synthetic`；不作为平台能力或真实支付验证的证据。
只新增本目录文件，QA-03a / QA-03b、生产实现和门禁配置均未修改。

## 场景与手算账目

顶层用例 `[AC-QA-03c#1]` 使用注入 Clock，依次推进以下日期；没有真实时间等待。
规格依据为 `SPEC_REF=62b5c99338f8ebe3030d55e5d282adbc7493c637` 的 BR-FUND-08、BR-FUND-16、BR-WDR-14、BR-WDR-30。

| 时间（+08:00） | 动作 | 用户 available / frozen（分） |
| --- | --- | --- |
| 10-05 / 10-08 | QA-03a 跟单、预估、收货，三单进入 WAITING | 0 / 0 |
| 11-20 / 11-24 | 合成 SETTLED 输入；QA-03b 出账、校验、应用层确认、批次入账 | 1500 / 0 |
| 11-25 | 第一单结算后失效，经同步窗口扣回 | 1000 / 0 |
| 11-26 01:00 | 生产日终任务校验 11-25 | 1000 / 0 |
| 11-26 10:00 | 真实应用服务申请 1000 分，真实 worker 自动审批、执行 | 0 / 1000 |
| 11-26 10:01 / 10:02 | transfer → review → release → 脚本成功 → land | 0 / 0 |
| 11-27 01:00 | 生产日终任务校验 11-26 | 0 / 0 |
| 11-27 11:10 | 第二单结算后失效，扣回 500 分；申请 100 分被拒绝 | −500 / 0 |
| 11-28 01:00 | 生产日终任务校验 11-27 | −500 / 0 |

每单联盟佣金 N=1000 分、预留 0、本人份额 5000bp、无上级，所以本人与平台各得 500 分。
每次整单失效 N_new=B_new=0，用户扣回 500 分、平台冲回 500 分，应收净减少 1000 分。
BR-FUND-16 借正贷负：用户 `USER_BALANCE/available` 分录 **+500**，余额变动 **−500**；
平台 `COMMISSION_REVENUE` 借 +500，两张凭证分别贷 `UNION_RECEIVABLE:pdd` −500。
`ledger_type=CLAWBACK`、`sub_type=FULL`；历史事件 `INVALID_AFTER_SETTLE`，按现有契约父原因是 `REFUND`。
申请冻结 available +1000 / frozen −1000；到账为 frozen +1000 / CASH_ALIPAY −1000，费用和税为 0。
金额期望来自上述输入和规则手算，不从服务输出倒推。负余额的可提现额必须是 0，申请拒绝码为契约中的 30302。

每个阶段调用 QA-03a `checkpoint`，执行全部活动的 `db/invariants/ledger/*` 与 BR-FUND-19 日终校验，差异必须为 0。
跨日调用 QA-03b 捕获的真实 `ledger-check/daily` 任务，核对完成记录及有业务发生日的期初、期末。
最低业务量为扣回 2 单、到账 1 单；每次失效窗口重复投递，并比较订单及全部资金记录。
transfer/release 在 PAYING 和 PAID_API 两个时点重复投递，land 再投一次；渠道仅调用一次、attempt 和资金记录不增加。

## 驱动边界

- `startReplay`、`replayClock`、`demoStream` 和 `startWorker` 全部复用既有驱动。三笔种子只在本目录添加晚于入账的 `refundedAt`。
- QA-03a 的 `syncDriver` 使用基础 `rebatePortFactory`，用于入账前阶段；它没有生产 `orderSyncWorker` 追加的 clawback 钩子。因此本目录 `sync-fixture.ts` 捕获生产 worker 的完整 rebate 工厂，以同一真实订单 pipeline / update step / 同步窗口处理器完成失效；只替换外部合成流、其状态映射和合成账号发现入口，不直接调用 clawback，不写订单或账务结果。
- `payout-fixture.ts` 捕获生产装配创建的 `WithdrawApplyService` 与规则读取服务，原工厂照常执行。实名、劳务协议和收款账号只是合成夹具，校验仍读真实数据库。两个旧驱动各建临时字段密钥环，因此 worker 启动配置复用 API 夹具的临时密钥环，使成年判定、结算受益人校验和解密使用同一密钥；不替换这些业务读取器。
- 申请替身仅越过 HTTP 层，向应用服务传 `stepUpValid=true`。HTTP 签名、认证、幂等键、step-up 消费由 `test/spec/payout/apply/http.int.test.ts` 的 AC-B2-05d#50–57 覆盖，数据库幂等由 `idempotency.int.test.ts` 的 #10–15 覆盖，实名等校验由 `validation.int.test.ts` 的 #60 覆盖。本场景不声称再次验证 HTTP 安全链。
- 自动到账由真实 worker 的 `evt.payout-auto-payout` 消费者执行，真实 `decideAutoPayout → executeBatch`；仅配置合成 app 的自动开关和阈值。失效占比 1/3，记录向上取整 3334bp，测试阈值 10000bp；不强制写 `auto_decision`、`risk_flags` 或提现状态。
- 生产 worker 的 FakeChannel 没有脚本。本场景按 `test/spec/payout/process/kit.ts` 的先例，构造按本单 `out_biz_no` 唯一键脚本化的 `dry_run FakeChannel` 与真实 `createTransferJob`，连接真实 `couli_payout` 角色；review / land 仍通过真实 worker 处理。队列仅捕获并手动投递，不让计时器自动出款。
- 本单验证成功主线及重复投递；未知结果查询时间表、超时转人工、失败分支、部分退款和并发矩阵由既有专门规则测试负责，不在此扩大验收范围。

## 验证状态与容器命令

2026-11-13 在测试机上验证：
- 本地静态检查：`tsc -b test`，以及对 `test/replay/qa-03c` 的 eslint、prettier 均通过。
- 场景经容器红路径 `couli-runs/scripts/container-run.sh … --red` 运行（对本文件执行 `vitest run --config vitest.replay.config.ts`，带一次性 PostgreSQL 与 Redis）。
- 主干基线（生产实现未改）red/3：`[AC-QA-03c#1]` 通过（1/1）。主干不加新实现即绿，按 D10-1370 ④ 本单是 test-change，以下面的变异代替先红。
- 变异结果见下方变异清单；原始结果在运行目录 `couli-runs/QA-03c/mutations/results-1-9.tsv`、`mutations-c1b/results.tsv`、`mutations-c1c/results.tsv`（不在仓库内）。

全仓验收仍由编排者在隔离容器 / CI 运行：

```sh
pnpm typecheck
pnpm lint
pnpm --filter @couli/spec-tests test:replay replay/qa-03c/clawback-payout.int.test.ts
```

`test:replay` 才会收集本场景；仓库的 `verify` / `test:int` 不收集 replay，不能拿它们的绿代替。
依赖真实测试 PostgreSQL（`TEST_PG_ADMIN_URL`）及测试 Redis；只使用隔离测试设施。

## 变异清单（2026-11-13 已实跑）

每次在隔离副本只改一处，先静态检查，再执行上面的单文件 replay 命令，保存 `[AC-QA-03c#1]` 的断言失败，随后恢复。
下列位置是本任务基线的生产文件行号，并附语句锚点；本任务没有修改这些文件。
编译错误、模块缺失、数据库设施故障不算杀死变异。

每个变异单独施加、跑场景、随后恢复；跑完后 `apps/` 的 `git status` 干净，没有提交任何变异。
计入的变异共 9 个，每段 3 个（扣回 C1c / C2 / C3，提现 W1 / W2 / W3，到账 P1 / P2 / P3），全部在所列断言处变红。
C1 是等价变异、C1b 红在生产代码抛错而非所列断言，两者都不计入；C1c 代替 C1。

| 编号 | 文件:行与变异 | 应变红的断言 | 结果 |
| --- | --- | --- | --- |
| C1 扣回触发 | `apps/api/src/modules/settlement/clawback/clawback-order.ts:1488`，整段 `if (source.event === 'PLATFORM_INVALID' || change.to_status === 'INVALID')` 条件改成 `source.event === 'PLATFORM_INVALID' && change.to_status !== 'INVALID'`，使本次失效不进入扣回 | `CLAWBACK_VOLUME`：应有 1 单终态 | red/4：**存活（通过）**。等价变异：失效转入 routeSync，有效基数由 >0 变 0，触发同一个 R8 扣回（BR-FUND-08 两种触发都列了），结果相同。不计入 |
| C1b 扣回前置守卫 | 同文件 `:1485`，守卫 `order.rebate_status !== FROM_STATUS` 改成 `===` | —（不针对单条断言） | red/13：变红，但是生产代码抛错 `settlement clawback: CREDITED order without booked pair`，不在所列断言处。不计入 |
| C1c 扣回原因 | 同文件 `:1078`，R8 CAS 的 `reason: r8Reason` 改成 `reason: 'RIGHTS'` | `CLAWBACK_STATE`：原因必须是 REFUND | red/14：在 `CLAWBACK_STATE` 变红。计入，代替 C1 |
| C2 用户扣回 | 同文件 `:761`，用户循环里的 `await ledger.post(trx, postingOf(...))` 改为 `void built;`，平台入账保留 | `CLAWBACK_AVAILABLE`：应从 1500 降至 1000 | red/5：在 `CLAWBACK_AVAILABLE` 变红 |
| C3 平台冲回 | 同文件 `:765`，`if (delta === 0n) return null` 改成 `if (delta <= 0n) return null` | `CLAWBACK_VOUCHERS`：每失效单应有用户、平台两张凭证 | red/6：在 `CLAWBACK_VOUCHERS` 变红（得到 1 张，应为 2 张） |
| W1 申请冻结 | `apps/api/src/modules/payout/application/withdraw-apply.ts:410`，`withdraw_fen: amount` 改成 `withdraw_fen: 900n` | `APPLY_FREEZE` / `APPLY_FREEZE_ENTRIES`：应冻结 1000 分 | red/7：在 `APPLY_FREEZE` 变红 |
| W2 自动判定 | `apps/api/src/modules/payout/domain/auto-decision.ts:233`，开关判断 `!== 'on'` 改成 `=== 'on'` | `AUTO_EXECUTED`：应 auto / PAYING，失败条件为空 | red/8：在 `AUTO_EXECUTED` 变红 |
| W3 负余额拒绝 | `apps/api/src/modules/payout/domain/withdraw-rules.ts:176`，负余额判断 `< 0n` 改成 `< -1000n` | `NEGATIVE_REFUSED`：−500 分必须返回 30302，不能落入普通余额不足 | red/9：在 `NEGATIVE_REFUSED` 变红（返回 30301，应为 30302） |
| P1 成功落账 | `apps/api/src/modules/payout/application/payout-landing.ts:218`，在 `success` 开头增加 `if (row.net_fen > 0n) return false;` | `PAID_API`：成功必须结束 PAYING | red/10：在 `PAID_API` 变红 |
| P2 渠道单号 | 同文件 `:241`，成功 CAS 的 `channel_order_id: result.channelOrderId ?? null` 改成 `channel_order_id: null` | `PAID_API`：必须保存脚本渠道单号 | red/11：在 `PAID_API` 变红 |
| P3 转账金额 | `apps/api/src/modules/payout/jobs/transfer-job.ts:735`，渠道请求的 `netFen: row.net_fen` 改成 `netFen: 900n` | `TRANSFER_REQUEST`：应向脚本渠道提交 1000 分 | red/12：在 `TRANSFER_REQUEST` 变红 |

基线或变异如因业务缺口不能得到预期结果，保留失败证据，另开实现任务；不改期望来迁就生产输出。
