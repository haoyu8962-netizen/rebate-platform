# 三平台 N 取数映射（BR-CALC-03、BR-CALC-18）

本文件记录京东、淘宝、拼多多三个订单适配器如何把联盟订单报文映射成 N（已扣技术服务费的推广者收入），对应 BR-CALC-03「映射写在 specs/attribution.md 并附录制报文」与 BR-CALC-18「基础佣金与补贴类佣金分开」。只记现状；源码与规则不一致处在各节「与规则的差异」和文末「待办」里写明。

通用口径：

- 金额单位是分；元转分按 BR-CALC-26，只认报文数字原文，不用浮点。
- 适配器给出的 `est_commission_fen`、`settle_commission_fen` 就是 N（净额），下游不再扣服务费（D10-105）。
- BR-CALC-03 的毛收入回退公式（按费率向上取整扣服务费、配置 `union.<platform>.service_fee_bp`）：**未实现**。仓库里没有 `service_fee_bp` 配置，也没有按费率扣服务费的订单代码；现有 `tech_fee_bp` 只用于商品卡与报价，不参与订单 N。
- 补贴类佣金（BR-CALC-18，B1-18c）：淘宝适配器按官方 `*_for_sdy` 字段输出 `subsidy_commission_fen`（分字段返回，直接映射）；京东、拼多多报文分不开补贴类佣金，不输出（null）。三家都不输出单独的 `n_base_fen`：`est_commission_fen`、`settle_commission_fen` 本身不含补贴类佣金，就是基础 N。订单流水线首次入库把适配器给的值写进 `orders.subsidy_commission_fen`（没给为 null），后续同步按本次报文更新；分佣快照取同一个值（null 记 0）（`apps/api/src/modules/orders/application/pipeline-port.ts`、`apps/api/src/modules/orders/application/update-step.ts`）。基础 N 不含补贴的依据按平台分别写在各节。
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
| `est_commission_fen` | `pub_share_pre_fee_for_commission` − 预估服务费；预估服务费取 `alimm_share_info_dto.alimm_tech_service_pre_fee`，缺值回退 `alimama_share_fee`，非法不回退、结果 null，绝不按 0。两边各自 floor 到分再减，可为负 | 每次订单同步都读，与 `tk_status` 无关 | `apps/api/src/modules/union/infra/taobao/orders.ts:14-40, 920-1011` |
| `settle_commission_fen` | `pub_share_fee_for_commission` − 结算服务费；结算服务费取 `alimm_share_info_dto.alimm_tech_service_fee`，缺值回退 `alimama_share_fee`，非法不回退、结果 null，绝不按 0 | 只在 `tk_status` 为 3 时读（D10-588、BR-FUND-02），不看 `tk_earning_time`；其余状态为 null | `apps/api/src/modules/union/infra/taobao/orders.ts:112-120, 920-1011` |
| `subsidy_commission_fen` | 未结算行取 `pub_share_pre_fee_for_sdy`，已结算行取 `pub_share_fee_for_sdy`，元转分同 BR-CALC-26（两位以外 floor，只收非负）；不扣服务费（补贴部分是否另扣待核实）。缺键、JSON null、「--」、空串、非法 → null，不拒行。`subsidy_fee` 只作淘宝专有字段原样带出，不并入任何金额 | 同 est / settle：`tk_status` 为 3 读结算字段，其余状态读预估字段；另一个不读 | `apps/api/src/modules/union/infra/taobao/orders.ts:25-29, 115-118, 950-991` |

- 服务费金额由报文直接给出，按 BR-CALC-03 细则「报文给服务费金额时 N = 佣金 − 报文服务费金额」处理，不按费率重算。
- 补贴（BR-CALC-18）：N 只取官方 `*_for_commission` 两个字段（不含补贴类佣金）；补贴部分在官方 `*_for_sdy` 字段里，单独输出为 `subsidy_commission_fen`，不进 N。`pub_share_pre_fee` 含补贴，值不用，只作必需字段校验。这是基础 N 不含补贴的依据；两组字段的口径未实测。
- 源码注释 `TODO(规划/11 §4.5)`：N 字段映射 verified=false，待测试单核对。
- 录制：`rebate-private/cap-tests/2026-10-31/dataoke/orders-shapes.json`（经大淘客，字段形状摘要，不是整包原文）
- 核对状态：未核对。BR-CALC-03 要求与联盟后台同一订单的推广者收入逐单核对，需真实订单与后台账号，尚未做；证据路径待回填 09 对应 CAP。

## 拼多多

源码：`apps/api/src/modules/union/infra/pdd/orders.ts`（`mapPddOrder`）；字段说明另见 `specs/union/pdd.md`。

| DTO 字段 | 报文字段与公式 | 取值时机 | 实现位置 |
| --- | --- | --- | --- |
| `est_commission_fen` | `promotion_amount` − `duo_id_service_fee`（服务费只从基础佣金扣）；服务费缺失时为 null，绝不按 0；可为负 | 每次订单同步（列表与详情接口）都读，与 `order_status` 无关 | `apps/api/src/modules/union/infra/pdd/orders.ts:400-495` |
| `settle_commission_fen` | 无单独报文字段：恒为 null（CAP-PDD-07 未实测，不臆造） | 不取值 | `apps/api/src/modules/union/infra/pdd/orders.ts:490-491` |
| `subsidy_commission_fen` | 未输出：`subsidy_duo_amount_level`、`subsidy_duo_amount_ten_million`、`subsidy_type`、`subsidy_list` 作为拼多多内部字段原样带出，不并入任何金额；订单流水线写 null | 不取值；未单列的处理按 BR-CALC-25 走配置 `union.pdd.subsidy_itemized` | `apps/api/src/modules/union/infra/pdd/orders.ts`、`apps/api/src/modules/orders/application/pipeline-port.ts:345-400` |

- `duo_id_service_fee` 是基础佣金加奖励佣金对应的服务费，这里全数从基础佣金扣（负责人 2026-10-02 定的公式），有等级奖励时 N 偏小、偏保守；待 CAP-PDD-04 实测。
- 补贴（BR-CALC-18）：补贴类字段单列带出、不进 N，这是基础 N 不含补贴的依据；`promotion_amount` 本身是否含补贴、是否已含账号等级系数与自购折算，未实测。
- 录制：`rebate-private/cap-tests/2026-10-15/pdd/`（字段形状摘要，不是整包原文）
- 核对状态：未核对。BR-CALC-03 要求与联盟后台同一订单的推广者收入逐单核对，需真实订单与后台账号，尚未做；证据路径待回填 09 对应 CAP。

## 待办

- BR-CALC-18：淘宝已输出 `subsidy_commission_fen`（`*_for_sdy`）；补贴部分是否另扣服务费、两组字段口径待实测（CAP-TB-04）。京东、拼多多报文未单列补贴类佣金，按 BR-CALC-25 走配置 `union.<platform>.subsidy_itemized`（现未设值，按 true）；改 false 等 09 结论（CAP-JD-04、CAP-PDD-04），09 表「补贴类佣金未单列」由编排回写。`n_base_fen` 不单列，`est_commission_fen` / `settle_commission_fen` 即基础 N。
- BR-CALC-03 的毛收入回退（按 `union.<platform>.service_fee_bp` 向上取整扣服务费）未实现；现在三家要么报文已是净额（京东，未实测），要么报文直接给服务费金额（淘宝、拼多多）。
- 三家都未做 BR-CALC-03 的逐单核对；核对完成后回填 09 对应 CAP（京东 CAP-JD-04、淘宝 CAP-TB-04、拼多多 CAP-PDD-04 与 CAP-PDD-07），并更新各节「核对状态」。
