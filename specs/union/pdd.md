# 拼多多订单金额口径（B1-08zh，D10-574，BR-CALC-02、BR-CALC-03）

平台字段见私有库 `docs-mirror/pdd/api/pdd.ddk.order.list.increment.get.md`。

| 我方字段 | 平台字段 | 说明 |
| --- | --- | --- |
| `commission_fen` | `promotion_amount` | 毛额，含软件服务费，不入库 |
| `service_fee_fen` | `duo_id_service_fee` | 按本次报文原样；缺失为 null |
| `est_commission_fen` | `promotion_amount − duo_id_service_fee` | 净额，可为负；缺服务费为 null，绝不按 0 |
| `settle_commission_fen` | 无 | 适配器不写，恒为 null |

- 扣除只在适配器一处（BR-CALC-03）。快照、重试、refresh、钱包、订单页都不再减。
- **新单缺服务费**：est 为 null，待处理 `SERVICE_FEE_RATE_MISSING`，版本留 0。
- **已有 est 的单后续缺服务费**：est 不覆盖，版本不前进，不进待处理；计数 `couli_pdd_service_fee_missing_total`，warning 告警 `CouliPddServiceFeeMissing`。
- 不回填：未上线；staging 已有的单下次同步时 est 变净额。

## 上线前要实测

- **CAP-PDD-04，奖励佣金**：`duo_id_service_fee` 是基础佣金及奖励佣金之和对应的费，这里只从基础佣金扣（负责人 2026-10-02 定的公式）。有等级奖励（`subsidy_duo_amount_level`）时 N 偏小，偏保守。文档没给费率，拆不开。
- **CAP-PDD-07，结算额（`credit.enabled.pdd` 开启前置）**：结算额按已扣服务费处理。实测若是毛额，要在结算写入处换算。
