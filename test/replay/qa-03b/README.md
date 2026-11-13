# QA-03b 合成数据结算回放

规格固定为 `62b5c99338f8ebe3030d55e5d282adbc7493c637`。依据 BR-FUND-02、BR-FUND-19，以及任务书明确补充授权的 BR-FUND-04（月结细则）；测试不声称验证真实平台能力。

`settlement.int.test.ts` 的 `[AC-QA-03b#1]` 分别跑 22、24、28 日；24 日不配置，检验默认值。沿用 QA-03a 的 `startReplay`、`orderSeeds`、`syncDriver` 和显式 `orderStream`，跟单、预估、收货实际落库。测试适配层只把合成输入佣金固定为 1000 分、服务费固定为 0 分；收货之后再把同一批领域 DTO 送进真实 worker 的订单流水线，显式提供结算额 1000 分和结算时间。DTO 的 `raw_status='5'` 使用已有映射表，不是平台录制或平台报文。

期望来自规则与夹具输入：预留 0，本人比例 5000bp，无上下级，每单本人 500 分、平台 500 分；三单本人 1500 分、平台 1500 分、联盟应收 3000 分。每轮最低一张账单、三条校验候选、一批确认、三单实际入账，具体门槛在 provenance.json 中且测试断言固定值。不得从实现输出更新期望。

分录符号依据本任务第 11 节指定的 BR-FUND-16（同一 SPEC_REF 的 `规划/08_业务规则/06_FUND_资金状态与账务.md`）：借为正、贷为负；第 1170 行明确「用户负债账户贷记为负」。因此每单 USER_BALANCE 的 CREDIT 分录为 −500 分；daily_balances 保留分录符号，按 BR-FUND-19①「期初 + 当日发生额 = 期末」，期初 0 + 三单 ×（−500）= 期末 −1500 分。account_balances.available_fen 是可提现余额缓存，仍为 +1500 分；账单份额与 booked 金额仍为正数。本轮逐条核对 settlement.int.test.ts：CREDIT_SHARE 的 amount_fen=−500 正确；daily_balances 的 opening_fen=0 不变、closing_fen 改为 −1500；凭证断言只检查空集与三张 CREDIT 的数量；VALIDATION_NO_MONEY、CONFIRM_NO_MONEY、CREDIT_REDELIVERY 比较完整凭证、分录与余额快照是否不变，不换算符号。其余断言不动。

出账使用实际 worker 注册的 `settle/bill` handler；一致性校验是该任务内部的原子步骤，测试在返回后分别核对账单与校验候选，不虚构中间持久化状态。确认调用应用层 `confirmAdminSettleBill`，实际批次命令和审计写库；之后 `scanDueBatches` 投递的 `batch_execute` 经实际 handler、executor、`createCreditOrder` 入账。队列传输为可控替身，数据库、金额计算、单一写者及事务均为真实实现；不验证 pg-boss 传输可靠性。worker 的后台定时器可能入队，但替身只执行场景显式投递的任务。

人工确认是自动化替身，不通过 HTTP 鉴权；权限点与 TOTP 由既有 `test/spec/settlement/admin-settle-commands/access.int.test.ts` 覆盖：`[AC-B2-09f#3]` 拒绝无 settle.bill 权限及未登录调用、`#4` 检验持有 settle.bill 可写、`#5` 检验 TOTP 缺失/异主体/SMS 降级/消费后重用。确认行为本身由本段及 `confirm.int.test.ts [AC-B2-09f#7]` 覆盖。

四段结束分别调用 QA-03a 的 checkpoint，运行 db/invariants/ledger 中全部生效 SQL（按已有 superseded.json 排除被替代版本），核对文件清单且账户/全局/落单差异均为零。随后将同一注入时钟推到 D+1 01:00 +08:00，调用真实 `ledger-check/daily` 检查入账会计日 D，并断言用户期初 0、期末 −1500（分录口径）。出账与执行各重复投递，结果与资金记录不增加。测试只新增规则资产，不新增业务实现或人为制造先红的骨架。

## 容器验证与变异清单

2026-11-13 在测试机上经容器先红通道（`couli-runs/scripts/container-run.sh`，运行 red/5）对未改动的主干实现运行本场景：基线三例全部绿（账单日 22 / 24 / 28）。主干不加新实现即为绿，按 D10-1370④ 视为刻画已有行为（test-change），以变异运行代替先红。下表 12 处变异逐一单独应用后运行本场景（运行 red/6–red/17），每一处都转红（三例均失败），失败断言即表中最后一列。运行后已还原实现，apps/ 的 `git status` 干净；未提交任何变异。

| 阶段 | 文件:行 | 具体变异 | 预期失败断言（均为 AC-QA-03b#1） |
| --- | --- | --- | --- |
| 出账 | apps/api/src/modules/settlement/bill/job.ts:732 | 账单日比较中的 `billDay` 改为 `billDay + 1` | BILL_VOLUME（当天没有账单） |
| 出账 | apps/api/src/modules/settlement/bill/job.ts:730 | `settlementBillPeriod(input.runAt)` 改为 `accountingDate(input.runAt).slice(0, 7)` | BILL_TOTALS 的 bill_id 应为 2026-10 |
| 出账 | apps/api/src/modules/settlement/bill/job.ts:694 | `beneficiary_total_fen` 写成 `0n` | BILL_TOTALS 应为 1500 |
| 校验 | apps/api/src/modules/settlement/bill/job.ts:516 | 候选 `bSettleFen: bSettle` 改为 `bSettleFen: addFen(bSettle, 1n)` | VALIDATED_AMOUNT 应为 1000 |
| 校验 | apps/api/src/modules/settlement/bill/job.ts:515 | 候选 `settleSeq` 在 `latestSeqWithin(...)` 后加 1 | VALIDATED_AMOUNT 的 settle_seq 应为 1 |
| 校验 | apps/api/src/modules/settlement/bill/job.ts:665 | 明细 INSERT 的 `result: null` 改为 `result: 'skipped'`，同时下一行的 skip_reason 写 `mutant` | VALIDATED_AMOUNT 的 result 应为 null |
| 确认 | apps/api/src/modules/settlement/batch/commands/service.ts:246 | CAS 中 row_version 的加 1 改为加 2 | CONFIRM_STATE 的版本只增 1 |
| 确认 | apps/api/src/modules/settlement/batch/commands/service.ts:330 | `confirmed_at: now` 改为 `confirmed_at: draft.created_at` | CONFIRM_STATE 应使用推进一分钟后的注入时钟 |
| 确认 | apps/api/src/modules/settlement/application/admin-settle-commands.ts:337 | 审计 action 改成字符串 `settle_bill_confirm_mutant` | CONFIRM_AUDIT 应有且仅有一条正式确认审计 |
| 入账 | apps/api/src/modules/settlement/batch/executor/executor.ts:398 | order 明细分支不调用 creditOrder，直接返回 `{ result: 'skipped', amount_fen: null, skip_reason: 'mutant' }` | CREDIT_VOLUME（三单必须真正 CREDITED） |
| 入账 | apps/api/src/modules/settlement/batch/executor/executor.ts:473 | credited_count 的加 1 改为加 0 | BATCH_DONE 的 credited_count 应为 3 |
| 入账 | apps/api/src/modules/settlement/credit/credit-order.ts:458 | 本人 `ratio_bp` 从 `BigInt(b.ratioBp)` 改为 `BigInt(b.ratioBp) - 1n` | CREDIT_BALANCE 应为 1500，不能变成 1497 |

类型检查、lint 及其余验证由 PR 的必过 CI 检查完成；上述变异结果记录在运行目录 couli-runs/QA-03b/mutations/results.tsv（不在仓库内）。
