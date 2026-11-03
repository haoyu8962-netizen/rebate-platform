# B1-04zz 规则测试 author-notes

规则：BR-CALC-03、BR-CALC-18、BR-FUND-02、D10-105、D10-588。作者：新鲜独立 Claude。没有 shell，`pnpm typecheck`、`pnpm lint`、先红都没跑过，全部由编排者跑。

kit 默认行的新口径：`pub_share_pre_fee_for_commission` 7.74 − 预估服务费 0.50 = **724**（原 799）；结算服务费 1.00；默认行**没有** `pub_share_fee_for_commission`。

## 作者定下的取值

1. tk_status=3 而 `pub_share_fee_for_commission` 缺失或非法：不开 collect 时 settle 为 null 加 warn，collect 下进 rejected（BR-CALC-03；否则已结算单按预估入账，B1-04zv 就是防这个）。
2. `*_for_commission` 字符串与 JSON number 都收（kit 默认行是字符串）。
3. 「--」和 JSON null 按无值：est 为 null，collect 下进 rejected，不强制 warn（现有 Reader 的语义）。
4. `service_fee_fen`：tk_status=3 写结算服务费，其余写预估服务费，来源同 est / settle。
5. 服务费都缺时未结算行留在 items（走 SERVICE_FEE_RATE_MISSING），不进 rejected；已结算行见第 4 次 ①。
6. 第 2 次作者加的 #20（已结算行不带可入账的 N 出来，rejected 或 est 置 null 都过）被第 4 次 ① 取代：collect 下一律进 rejected。
7. 没钉，留给实现：tk_status≠3 带 tk_earning_time 时的 `settled_at`。

## 编排定的三点（第 2 次，已钉）

1. `pub_share_pre_fee` 保留必需，值不进 N：#18（缺失或非法跳过、进 rejected）、#19（合法值含负数都不改 est）、#1。冻结用例 #34、`BROKEN_AMOUNTS`、`REQUIRED_ILLEGAL` 因此不用改。
2. est 为 null 时 `commission_fen` 按拼多多做法，毛额照常：服务费拿不到时等于佣金字段收到非负（#7 的 1000、负佣金 0；#8 的 1000）。佣金字段本身缺时没有毛额，只能是 0（`makeUnionOrder` 要求非负 bigint，#9），不回退 `pub_share_pre_fee`。
3. dto 服务费非法不回退 `alimama_share_fee`：#8（对应的 est 或 settle 为 null，有告警；结算服务费非法的已结算行 collect 下进 rejected，第 4 次改），#17 的第二行（未结算行，真库走到 SERVICE_FEE_RATE_MISSING）。

## 编排定的三点（第 4 次，已钉）

1. 已结算行的结算服务费或 `pub_share_fee_for_commission` 拿不到：collect 下一律进 rejected，不开 collect 仍 null 加告警。#7、#8、#20 的已结算分支随之改（#10 本来就是）。#17 的已结算分支搬到新增的 #22：真库，库里已有 est 900，经 fetchWindow 进 ORDER_ROW_INVALID，不生成快照，不按预估，订单各列不变；#22 的后半段是对照，同一单字段齐了入账 820、待处理解决。#17 只剩未结算行走 SERVICE_FEE_RATE_MISSING。
2. `alimama_share_fee` 非法（「-1.00」「abc」）：#23 各一行，est、service_fee_fen 为 null，不保留负号、不按 0。
3. S2：dto 只有 `alimm_tech_service_rate`、金额字段和 alimama 都缺；dto 是字符串、数组时不回退 alimama：#23 各一行。

第 ① 点的连带：`taobao-negative/unchanged` 的 zw#6「结算服务费非法，行照常返回」在 collect 下与 ① 相反，见下表最后一行。这个文件任务书没点名，不改的话实现后这一条永远红。

## 编排定的一点（第 5 次，已钉）

#4 的 collect 分支：tk_status 3 而 tk_earning_time 缺失、null 或「--」时进 rejected，不留在 items，`detail` 点名 `tk_earning_time`（BR-CALC-03：缺已结算行的必需字段，不生成快照，不按预估顶替）。

#4 由 `it.each(inBothModes(...))` 六例拆成两条 `it.each`，各三例：不开 collect 的断言一字未改，标题里的 `$mode` 写死成「不开 collect」；collect 这条新写，同页放一行好的。别的用例没动。

任务书说不开 collect 时「打 warn」，但这一分支要求保持现样，原用例没有断言告警，所以 warn 没有钉。现实现的 `Reader` 对「--」、null 和缺失的 tk_earning_time 不告警，要告警得由实现另加。

其他走 collect 的用例已查过，没有 tk_status 3 又缺 tk_earning_time 的行：zw#5、zv#1 的这类行是 tk_status 12，`AC-B1-04f#22` 不开 collect。

## 改动清单

新增：`mapping.test.ts`（#1–#13、#18–#20、#23）、`paging.test.ts`（#14–#15）、`pipeline.int.test.ts`（#16–#17、#21–#22）、`net-row.ts`。

#21 钉淘宝不计入 `couli_pdd_service_fee_missing_total`、不打 `pdd_service_fee_missing`，拼多多仍计（编排 05:25）。实现要改 `apps/api/src/modules/orders/application/update-step.ts`，把计数限定 platform === 'pdd'；该文件不在本任务 paths 内，实现轮要放开。

`row-quarantine/wires.ts`：`TAOBAO.good` 补 `pub_share_fee_for_commission: '7.66'`，`pub_share_pre_fee_for_commission` 用 kit 默认行的就够。`TAOBAO.bad` 没动：坏字段 `alipay_total_price` 先读，行照样拒。同文件未改用例的连带判定由编排用 red_exempt 声明。

| 文件 | 用例 | 改前 | 改后 |
| --- | --- | --- | --- |
| taobao-orders/amounts | AC-B1-04f#28 | 覆盖 pub_share_pre_fee、pub_share_fee | 覆盖两个 `_for_commission`，dto 服务费 0；期望不变 |
| taobao-orders/amounts | #29 | pre_fee 0.2999…，commission/est 29 | `_for_commission` 1.2999…，减 0.2999…，commission/est 100 |
| taobao-orders/amounts | #32 | 表内 pub_share_fee；commission 799 | 表内 pub_share_fee_for_commission；commission 724 |
| taobao-orders/mapping | #18 | row()；commission/est 799 | 行内补结算字段 7.66；commission/est 724，settle 仍 666 |
| taobao-orders/mapping | #21 | est 799 | est 724 |
| taobao-orders/slots | #43 | commission 799 | commission 724 |
| taobao-negative/required | 全部（zw#3、#4） | 负 pub_share_pre_fee；est 等于负值；799 | 负 `_for_commission`；est 是负值减 50；724 |
| taobao-negative/settled | 全部（zw#1、#2、#7） | 负 pub_share_fee；settle 等于负值 | 负 `_for_commission`；settle 是负值减 100 |
| taobao-negative/unchanged | 全部（zw#5、#6） | control() 的 settle −100；未结算靠 tk_earning_time | settledControl() 的 settle −200；未结算靠 tk_status 12；字段名换新 |
| row-quarantine/unchanged | zv#2 taobao、zv#3 taobao | 默认行 | 行内补结算字段，加 est 724、settle 666 断言 |
| row-quarantine/rejected | zv#1 淘宝已结算行 | pub_share_fee；799 | pub_share_fee_for_commission；724；未结算行改 tk_status 12 |
| row-quarantine/rejected | zv#5 淘宝 | 默认行 | 行内补结算字段，加 settle 700 断言 |
| orders/taobao-negative/settled.int | zw#8 | settledIncoming 夹具；−100、−321；est 799 | 文件内自写已结算行；−200、−421；est 724 |
| orders/platform-rules/funds | za#11、#12、#13 | PINNED 的 serviceFeeDeducted；只有 pdd | 用例内 `platform !== 'jd'`；pdd、taobao |
| orders/platform-rules/exports | za#22 | deducting 等于 [pdd] | deducting 等于 [pdd, taobao] |
| union/pdd-net-n/mapping | zh#5（第 3 次） | 「只有拼多多减」；默认行；淘宝 est 799、settle 666 | 标题随口径改；行内补结算字段 `'7.66'`；淘宝 est 724、settle 仍 666；拼多多、京东不变 |
| union/pdd-net-n/plans | zh#13（第 3 次） | 「其他平台不变」；淘宝、京东 N 为空都是 AMOUNT_PARSE_FAILED | 标题随口径改；N 为空且没有服务费时淘宝是 SERVICE_FEE_RATE_MISSING（快照、重试）；京东与 N 已知的断言不变 |
| taobao-negative/unchanged | zw#6 $mode：$field（第 4 次） | 两种模式下 9 个字段的负值都「行照常返回」 | collect 下的 `alimm_tech_service_fee` 从表里去掉，新增一条：这一行进 rejected，值同样是「-1.00」「-0.00」的字符串与 JSON number；其余 17 例不变 |

taobao-negative 的 required、settled、unchanged 和 orders/taobao-negative/settled.int 这四个文件动了用例之外的代码，会整文件判红；它们的用例在现实现上都应是红的，所以这样改。kit.ts、negative-wire.ts、settled-flow.ts 没动；platform-rules/kit.ts 的 `PINNED.taobao.serviceFeeDeducted` 仍是 false，已与新口径不一致。

pdd-net-n 这两个文件里拼多多的用例在现实现上是绿的，所以用例之外的代码一个 token 都没动（只改了头部注释），按用例判定：只有 #5、#13 要红，其余豁免。也因此 #5 的金额写字符串（`num` 要加 import，算用例外改动），#13 用文件已有的 `FEE_MISSING`。

## 没改的冻结用例

- `orders/commission-snapshot/amounts.test.ts` #10 的标题写淘宝不扣服务费，断言不受影响。
- `union/taobao-dataoke-switches/**` 用 kit 默认行，不开 collect，只断言 `order_id`：默认行实现后 settle 为 null 加 warn，行仍在 items，不受影响。
