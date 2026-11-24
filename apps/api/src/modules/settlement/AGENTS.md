# apps/api/src/modules/settlement（资金：结算与入账编排）

订单类凭证的唯一编排者：按订单返利状态与返利快照生成入账、扣回与补记计划，经 ledger 记账；结算批次、受益人入账义务与联盟对账也在本模块。不直接改余额。

## 谁能改

- 风险级 RV2（资金，`ops/risk-map.yaml`）。主实现 Claude Opus 5.5 子代理；规则测试作者 Codex（实现前先写、先红）；Codex 新只读会话对抗评审，无未关闭的 S0 / S1 才合并（`ops/approvals.yaml` 第 19、27 条）。
- 不变量 SQL 在 `db/invariants/`（保护路径，只能新增），由规则测试作者编写。

## 依据（只写指针，取值与公式只在 08）

| 要查什么 | 看哪里 |
| --- | --- |
| 模块职责、拥有的表、依赖 | 规划/02 §4.1 `settlement` 行、§8 典型分录、§18 一致性做法 |
| 结算流程、批次、入账与扣回 | 08 BR-FUND-01、04、05、08、09、10 |
| 返利金额计算 | 08 BR-CALC-13 |
| 表结构 | `db/schema.sql` |
| 拆分方案与待裁定 | `couli-runs/FUNDS-quote/settlement-plan.md`（不入库） |

## 硬规则

1. 订单类凭证只由本模块编排；记账只经 ledger 的 `lockBalances` / `post` / `reverse`，与订单列写入同一事务，不自写分录或余额。
2. 订单 `rebate_status` 只由本模块写，且只调用生成的 `transition()`。
3. 加锁顺序固定：仅结算批次先取所属平台的结算互斥锁（执行入账的明细事务取共享，生成批次的事务取排他；其余记账事务不取）→ 订单键 advisory 锁 → identity 的 users 行锁 → `ledger.lockBalances`；不得颠倒或跳步，持有订单键锁时不得再等平台锁。
4. 幂等落在 PG 唯一约束上；任务按至少一次投递写，重放同一事件不重复记账。
5. 金额只经 `@couli/money`；本模块不自写取整或换算。
6. 时间只读注入的 `Clock`；会计日与结算月只用 `@couli/domain` 的函数，不用 SQL 时钟。
7. 只读写本模块的表；别的模块的数据只经对方 `index.ts` 导出的端口，不读别的模块的表。
8. 日志只用 pino，不打金额以外的个人信息。
