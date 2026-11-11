# 三平台 N 取数映射（BR-CALC-03、BR-CALC-18）

本文件记录京东、淘宝、拼多多三个订单适配器如何把联盟订单报文映射成 N（已扣技术服务费的推广者收入），对应 BR-CALC-03「映射写在 specs/attribution.md 并附录制报文」与 BR-CALC-18「基础佣金与补贴类佣金分开」。只记现状；源码与规则不一致处在各节「与规则的差异」和文末「待办」里写明。

通用口径：

- 金额单位是分；元转分按 BR-CALC-26，只认报文数字原文，不用浮点。
- 适配器给出的 `est_commission_fen`、`settle_commission_fen` 就是 N（净额），下游不再扣服务费（D10-105）。
- BR-CALC-03 的毛收入回退（B1-18e）：只对报文给毛额、需扣服务费的淘宝与拼多多；报文没有服务费金额时按费率扣，服务费 = ceil(毛额 × fee_bp / 10000)（向上取整，N 取保守值，只经 `@couli/money`），N = 毛额 − 服务费，`service_fee_fen` 写实际扣的服务费。fee_bp 的顺序：淘宝先取报文费率 `alimm_tech_service_rate`（按百分数读，未核实）、再取配置 union.taobao.service_fee_bp；拼多多报文没有费率字段，直接取配置 union.pdd.service_fee_bp。两处都没有：N 为 null，下游进待处理（`SERVICE_FEE_RATE_MISSING`），绝不按 0。配置键已登记（B1-18et）但**未填任何取值**（08 未给费率；填值须附来源，未核实的标 verified=false「待核实」）。现有 `tech_fee_bp` 只用于商品卡与报价，不参与订单 N。
- 配置值形状（B1-18e 定）：object，键为订单类型（淘宝取报文 `order_type` 原文，没有该键用 "*"；拼多多只用 "*"），值为 bp（0..10000 的整数）、source（非空字符串）、verified（布尔）三项。形状不合法当作没有配置并告警；verified=false 照常使用并告警，不影响金额。
- 补贴类佣金（BR-CALC-18，B1-18c）：淘宝适配器按官方 `*_for_sdy` 字段输出 `subsidy_commission_fen`（分字段返回，直接映射）；京东、拼多多报文分不开补贴类佣金，不输出（null）。三家都不输出单独的 `n_base_fen`：`est_commission_fen`、`settle_commission_fen` 本身不含补贴类佣金，就是基础 N。订单流水线首次入库把适配器给的值写进 `orders.subsidy_commission_fen`（没给为 null），后续同步按本次报文更新；分佣快照取同一个值（null 记 0）（`apps/api/src/modules/orders/application/pipeline-port.ts`、`apps/api/src/modules/orders/application/update-step.ts`）。commission_version 在有效 N（结算优先）变化时 +1；N 不变而本次报文补贴与当前版本合计行记的补贴不同（空值与 0 相同；合计行补贴为空的旧行回退分佣快照的补贴）也 +1，这个版本各受益人份额与 base 沿用上一版本，只按新补贴重算合计行（BR-CALC-15、BR-CALC-27，B1-18i）。报文不输出补贴字段的平台不因补贴推版本；报文平台更新时间早于订单当前记录的也不因补贴推版本。基础 N 不含补贴的依据按平台分别写在各节。
- 未单列补贴类佣金的平台（BR-CALC-25）：按配置 `union.<platform>.subsidy_itemized`（boolean，未设值按 true）判定；为 false 时该平台新订单首次入库置 `orders.credit_requires_settle` = true，不设 hold、不改 N（N 整体计入 B，快照照常）。三个键都未设值，即都按 true；改 false 等 09 结论（「补贴类佣金未单列」由编排回写 09 表）。
- 录制只按路径引用私有库，不在本仓库放报文；所引文件是字段形状摘要，不是整包原文。
- 「取值时机」指适配器在订单同步的哪一种状态下读哪个字段。

## 京东

源码：`apps/api/src/modules/union/infra/jd/orders.ts`（`mapJdOrder`）；字段说明另见 `specs/union/jd.md`「金额」。

| DTO 字段 | 报文字段与公式 | 取值时机 | 实现位置 |
| --- | --- | --- | --- |
| `est_commission_fen` | `validCode` 为 17 取 `actualFee`；其余取 `estimateFee`。报文金额按净额原样换算成分，适配器不做任何运算 | 每次订单同步逐行读 `validCode` 选字段；未完成单的实际佣金是 0.0，所以只有已完成才读实际佣金 | `apps/api/src/modules/union/infra/jd/orders.ts:240-270` |
| `settle_commission_fen` | 无报文字段：适配器不写，恒为 null（D10-529：京东没有已结算 `validCode`） | 任何 `validCode` 都不写；结算额只由联盟结算明细导入写入 | `apps/api/src/modules/union/infra/jd/orders.ts:271-273` |
| `subsidy_commission_fen` | 未输出：订单行没有单列补贴类佣金的字段，适配器不读任何补贴类字段；订单流水线写 null | 不取值；未单列的处理按 BR-CALC-25 走配置 `union.jd.subsidy_itemized` | `apps/api/src/modules/union/infra/jd/orders.ts`、`apps/api/src/modules/orders/application/pipeline-port.ts:345-400` |

- 净额口径：按 BR-CALC-03 细则的默认值（未验证前按字段已是推广者实得开发）映射，报文金额原样使用；这一口径未实测（09 CAP-JD-04）。
- 补贴（BR-CALC-18）：京东订单行没有单列补贴类佣金的字段，适配器也不读；`estimateFee`、`actualFee` 本身是否混有补贴类佣金未实测。基础 N 不含补贴的依据目前只是「适配器不读补贴字段」，不是实测结论。
- 录制：`rebate-private/cap-tests/2026-11-01/jd/`（字段形状摘要，不是整包原文）
- 核对状态：未核对。BR-CALC-03 要求与联盟后台同一订单的推广者收入逐单核对，需真实订单与后台账号，尚未做；证据路径待回填 09 对应 CAP。

## 淘宝

源码：`apps/api/src/modules/union/infra/taobao/orders.ts`（`mapRow`，经大淘客取 `publisher_order_dto`）。

| DTO 字段 | 报文字段与公式 | 取值时机 | 实现位置 |
| --- | --- | --- | --- |
| `est_commission_fen` | `pub_share_pre_fee_for_commission` − 预估服务费；预估服务费取 `alimm_share_info_dto.alimm_tech_service_pre_fee`，缺值回退 `alimama_share_fee`，非法不回退、结果 null。两者都没有值时按费率扣：服务费 = ceil(毛额 × bp / 10000)，bp 先取 `alimm_share_info_dto.alimm_tech_service_rate`（按百分数读，未核实；非法不回退、结果 null），没有值再取配置 union.taobao.service_fee_bp（按 `order_type`）；都没有为 null，绝不按 0。金额两边各自 floor 到分再减，可为负 | 每次订单同步都读，与 `tk_status` 无关 | `apps/api/src/modules/union/infra/taobao/orders.ts:14-48, 960-1100` |
| `settle_commission_fen` | `pub_share_fee_for_commission` − 结算服务费；结算服务费取 `alimm_share_info_dto.alimm_tech_service_fee`，缺值回退 `alimama_share_fee`，非法不回退、结果 null。两者都没有值时同 est 行按费率扣（毛额用本行字段）；都没有为 null，绝不按 0 | 只在 `tk_status` 为 3 时读（D10-588、BR-FUND-02），不看 `tk_earning_time`；其余状态为 null | `apps/api/src/modules/union/infra/taobao/orders.ts:112-125, 960-1100` |
| `subsidy_commission_fen` | 未结算行取 `pub_share_pre_fee_for_sdy`，已结算行取 `pub_share_fee_for_sdy`，元转分同 BR-CALC-26（两位以外 floor，只收非负）；不扣服务费（补贴部分是否另扣待核实）。缺键、JSON null、「--」、空串、非法 → null，不拒行。`subsidy_fee` 只作淘宝专有字段原样带出，不并入任何金额 | 同 est / settle：`tk_status` 为 3 读结算字段，其余状态读预估字段；另一个不读 | `apps/api/src/modules/union/infra/taobao/orders.ts:25-29, 115-118, 950-991` |

- 服务费金额由报文直接给出，按 BR-CALC-03 细则「报文给服务费金额时 N = 佣金 − 报文服务费金额」处理，不按费率重算；只有金额都没有值时才走费率回退（B1-18e）。报文费率 `alimm_tech_service_rate` 按百分数读（与本适配器其他比例字段同一换算），**未核实**：官方字段手册（私有库 `rebate-private/docs-mirror/taobao/aff-open-docs/server-api/tbk-server-api.json`，taobao.tbk.order.details.get）只写「技术服务费比率」、没写单位，同一响应的其他比率字段是百分数；录制 `rebate-private/cap-tests/2026-10-31/dataoke/orders-shapes.json` 里该字段是两位数的整数，量级与百分数一致，但只有形状、没有与服务费金额配对的值。同一份官方文档里，taobao.tbk.order.details.get 嵌套 dto 中已废弃的字段 `share_relative_rate`（专项服务费率）示例为 "0.10"，是全文唯一一处像小数写法的比率（字段已废弃，不作为本字段单位的依据）。用到报文费率的行告警 `taobao_order_service_fee_from_rate`（每行至多一次）；待 CAP-TB-04 实测。
- 补贴（BR-CALC-18）：N 只取官方 `*_for_commission` 两个字段（不含补贴类佣金）；补贴部分在官方 `*_for_sdy` 字段里，单独输出为 `subsidy_commission_fen`，不进 N。`pub_share_pre_fee` 含补贴，值不用，只作必需字段校验。这是基础 N 不含补贴的依据；两组字段的口径未实测。
- 源码注释 `TODO(规划/11 §4.5)`：N 字段映射 verified=false，待测试单核对。
- 录制：`rebate-private/cap-tests/2026-10-31/dataoke/orders-shapes.json`（经大淘客，字段形状摘要，不是整包原文）
- 核对状态：未核对。BR-CALC-03 要求与联盟后台同一订单的推广者收入逐单核对，需真实订单与后台账号，尚未做；证据路径待回填 09 对应 CAP。

## 拼多多

源码：`apps/api/src/modules/union/infra/pdd/orders.ts`（`mapPddOrder`）；字段说明另见 `specs/union/pdd.md`。

| DTO 字段 | 报文字段与公式 | 取值时机 | 实现位置 |
| --- | --- | --- | --- |
| `est_commission_fen` | `promotion_amount` − `duo_id_service_fee`（服务费只从基础佣金扣）；服务费缺失时按配置 union.pdd.service_fee_bp（只用 "*"）扣：服务费 = ceil(毛额 × bp / 10000)；配置也没有为 null，绝不按 0；可为负 | 每次订单同步（列表与详情接口）都读，与 `order_status` 无关 | `apps/api/src/modules/union/infra/pdd/orders.ts:400-545` |
| `settle_commission_fen` | 无单独报文字段：恒为 null（CAP-PDD-07 未实测，不臆造） | 不取值 | `apps/api/src/modules/union/infra/pdd/orders.ts:490-491` |
| `subsidy_commission_fen` | 未输出：`subsidy_duo_amount_level`、`subsidy_duo_amount_ten_million`、`subsidy_type`、`subsidy_list` 作为拼多多内部字段原样带出，不并入任何金额；订单流水线写 null | 不取值；未单列的处理按 BR-CALC-25 走配置 `union.pdd.subsidy_itemized` | `apps/api/src/modules/union/infra/pdd/orders.ts`、`apps/api/src/modules/orders/application/pipeline-port.ts:345-400` |

- `duo_id_service_fee` 是基础佣金加奖励佣金对应的服务费，这里全数从基础佣金扣（负责人 2026-10-02 定的公式），有等级奖励时 N 偏小、偏保守；待 CAP-PDD-04 实测。
- 补贴（BR-CALC-18）：补贴类字段单列带出、不进 N，这是基础 N 不含补贴的依据；`promotion_amount` 本身是否含补贴、是否已含账号等级系数与自购折算，未实测。
- 录制：`rebate-private/cap-tests/2026-10-15/pdd/`（字段形状摘要，不是整包原文）
- 核对状态：未核对。BR-CALC-03 要求与联盟后台同一订单的推广者收入逐单核对，需真实订单与后台账号，尚未做；证据路径待回填 09 对应 CAP。

## 待办

- BR-CALC-18：淘宝已输出 `subsidy_commission_fen`（`*_for_sdy`）；补贴部分是否另扣服务费、两组字段口径待实测（CAP-TB-04）。京东、拼多多报文未单列补贴类佣金，按 BR-CALC-25 走配置 `union.<platform>.subsidy_itemized`（现未设值，按 true）；改 false 等 09 结论（CAP-JD-04、CAP-PDD-04），09 表「补贴类佣金未单列」由编排回写。`n_base_fen` 不单列，`est_commission_fen` / `settle_commission_fen` 即基础 N。
- BR-CALC-03 的毛收入回退已实现（B1-18e，淘宝、拼多多；京东报文为净额不适用），但 union.taobao.service_fee_bp、union.pdd.service_fee_bp 都未填取值：填值须附来源（08 未给费率，CAP-TB-04、CAP-PDD-04）。淘宝报文费率 `alimm_tech_service_rate` 按百分数读未核实（出处见淘宝节）。
- 三家都未做 BR-CALC-03 的逐单核对；核对完成后回填 09 对应 CAP（京东 CAP-JD-04、淘宝 CAP-TB-04、拼多多 CAP-PDD-04 与 CAP-PDD-07），并更新各节「核对状态」。
