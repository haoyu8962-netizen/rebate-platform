# 拼多多联盟映射

本文件记拼多多适配器已定下的映射，依次是订单、商品、转链。平台字段资料见私有库 `docs-mirror/pdd/api/<接口名>.md`；录制只放在私有库，这里只写路径引用：`rebate-private/cap-tests/2026-10-15/pdd/`。

# 拼多多订单映射（B1-04i、B1-04w、B1-08e、B1-08p、B1-08zh）

接口 `pdd.ddk.order.list.increment.get`（按更新时间）、`pdd.ddk.order.list.range.get`（按支付时间）、`pdd.ddk.order.detail.get`（按单号查一单）。参数与映射在 `apps/api/src/modules/union/infra/pdd/orders.ts`，请求流程在 `pdd-adapter.ts` 的 `listOrders`、`getPddOrderDetail`。

映射只读各接口登记过的字段（三张字段表：共有字段，另加 increment 的 `order_id`、`p_id`、`fail_reason`、`order_receive_time`、`order_verify_time`、`order_settle_time`；range 的 `p_id`、`fail_reason`、`order_settle_time`；detail 的 `pid`、`url_last_generate_time`、`return_status`）。某接口没登记的字段即使出现在报文里也不读、不校验、不进 DTO；从不 spread 整份报文。

## 请求

- `listOrders` 不传 `queryMode` 即 increment；`pay_time` 走 range；其他值 `invalid_dto`。
- **increment**：参数 `start_update_time`、`end_update_time`（Unix 秒）、`page`、`page_size` 50、`return_count` false。时间窗按毫秒原值判：from < to、跨度 ≤ 24 小时、起点不早于注入时钟的 90 天前，不合格 `invalid_dto`、不发请求；拆窗归 order-sync。再转秒：from 向下、to 向上取整；取整越过限制时只把越界的那一秒收回。
- **increment 倒序翻页**：首次调用不依赖 total_count，先倍增再二分探出最后一个非空页，从它开始往回取到第 1 页（游标 `inc:<页码>`，页码 1..10000）。探到 10000 页仍满 → `invalid_dto`（窗口要拆小）。同一次调用里已取过的页缓存复用，不重复计量。
- **range**：参数 `start_time`、`end_time`（北京时间「yyyy-MM-dd HH:mm:ss」），续批带 `last_order_id`（游标 `range:<迭代器>`）。空批、没有迭代器、或迭代器原样不变都结束。
- **detail**：参数 `order_sn`；空白单号 `invalid_dto`，不发请求。
- 外层 `order_list` 不是数组 → `invalid_dto`，不当作空页。外层键缺失 → `upstream_unavailable`。
- 每次实际上游请求单独经配额治理（`listOrdersMetering = 'per_request'`）。
- 游标与查询方式不符或格式不对 → `invalid_dto`。
- 订单同步带 `CallCtx.rowErrors: 'collect'` 调用时，映射拒绝的行进 `rejected`，其余行与游标照常；否则整页报错。

## 字段对照

| DTO 字段 | 报文字段 | 说明 |
| --- | --- | --- |
| `order_id` | `order_sn` | 非空字符串，必需 |
| `sub_order_id` | `order_sn` | 与 `order_id` 相同 |
| `parent_order_id` | 无 | 恒为 null：拼多多没有父单 |
| `platform_order_id` | `order_id` | 只有 increment 登记了，其余接口为 null |
| `goods_id` | `goods_id` | 按原始 JSON 文本取十进制串，上限 2^53（含），超出或不合格 `invalid_dto` |
| `goods_sign` | `goods_sign` | 字符串原样 |
| `pid` | `p_id` / `pid` | 列表取 `p_id`，详情取 `pid` |
| `promotion_slot` | `p_id` / `pid` | 同 `pid` |
| `custom_parameters` | `custom_parameters` | 字符串原样，不解析 |
| `attr_params.custom_parameters` | `custom_parameters` | 同上 |
| `attr_params.relation_id` | 无 | 恒为 null |
| `attr_params.sub_union_id` | 无 | 恒为 null |
| `order_status` | `order_status` | 安全整数原样 |
| `raw_status` | `order_status` | 整数的字符串形式；不映射订单状态，状态见 `specs/order-status-map/pdd.csv` |
| `order_status_desc` | `order_status_desc` | 字符串原样 |
| `fail_reason` | `fail_reason` | 字符串原样；详情不登记，为 null |
| `return_status` | `return_status` | 只读详情；缺失为 null，不推断为无售后 |
| `paid_fen` | `order_amount` | 必需，非负整数分 |
| `commission_fen` | `promotion_amount` | 必需，非负整数分；毛额，含软件服务费，不入库 |
| `service_fee_fen` | `duo_id_service_fee` | 按本次报文原样；缺失为 null |
| `est_commission_fen` | `promotion_amount` − `duo_id_service_fee` | 净额，见「金额」 |
| `settle_commission_fen` | 无 | 恒为 null，见「金额」 |
| `goods_price_fen` | `goods_price` | 非负整数分 |
| `platform_discount_fen` | `platform_discount` | 非负整数分 |
| `sep_market_fee_fen` | `sep_market_fee` | 非负整数分 |
| `promotion_rate` | `promotion_rate` | 千分比整数，非负 |
| `sep_rate` | `sep_rate` | 千分比整数，非负 |
| `order_create_time` | `order_create_time` | Unix 秒原样 |
| `order_pay_time` | `order_pay_time` | Unix 秒原样 |
| `order_group_success_time` | `order_group_success_time` | Unix 秒原样 |
| `order_receive_time` | `order_receive_time` | Unix 秒原样；只有 increment 登记 |
| `order_verify_time` | `order_verify_time` | Unix 秒原样；只有 increment 登记 |
| `order_settle_time` | `order_settle_time` | Unix 秒原样；increment、range 登记 |
| `order_modify_at` | `order_modify_at` | Unix 秒原样 |
| `url_last_generate_time` | `url_last_generate_time` | Unix 秒原样；只有详情登记 |
| `deposit_paid_at` | 无 | 恒为 null |
| `paid_at` | `order_pay_time` | 秒转时刻；0 或缺失为 null |
| `received_at` | `order_receive_time` | 秒转时刻；0 或缺失为 null |
| `settled_at` | `order_settle_time` | 秒转时刻；0 或缺失为 null |
| `modified_at` | `order_modify_at` | 秒转时刻；0 或缺失为 null |
| `subsidy_duo_amount_level` | `subsidy_duo_amount_level` | 非负整数；内部渠道数据，不并入任何金额 |
| `subsidy_duo_amount_ten_million` | `subsidy_duo_amount_ten_million` | 非负整数；同上 |
| `subsidy_type` | `subsidy_type` | 整数原样 |
| `subsidy_list` | `subsidy_list` | 只留长度（成员一律占位 null，不读）；不是数组 `invalid_dto` |
| `shop_id` | `mall_id` | 按原始 JSON 文本取十进制正整数、≤ 2^53 − 1；缺失或不合格为 null，不丢单 |
| `raw_payload_id` | 无 | 不映射报文字段：取归档传输回传的该页归档行 id，没有为 null |

报文里的其他字段（含 `mall_name`）不读、不进 DTO。拼多多订单不给件数与已退件数（`quantity`、`refunded_quantity` 缺键）。

金额、费率、时间都是 JSON 整数；非安全整数、非整数、负数一律 `invalid_dto`，不舍入。金额经 `@couli/money` 的 `parseFen`。

`order_status` 为 4（审核失败）或 10（已处罚）的订单，映射成功后每单告警 `order_reason_sub_unmapped`（带 `fail_reason` 原值）；毛额 > 0 时另告警 `pdd_invalid_with_commission`。都不带单号、金额、用户（B1-04zgc，D10-1069）。

## 金额

扣除只在适配器一处（BR-CALC-02、BR-CALC-03，B1-08zh，D10-574）。快照、重试、refresh、钱包、订单页都不再减。

- `est_commission_fen` = `promotion_amount` − `duo_id_service_fee`：净额，可为负；缺服务费为 null，绝不按 0。
- `commission_fen` = `promotion_amount`：毛额，含软件服务费，不入库，不是可分配基数。
- `settle_commission_fen` 恒为 null：适配器不写，现有映射没有单独的结算佣金字段（待 CAP-PDD-07）。
- **新单缺服务费**：est 为 null，待处理 `SERVICE_FEE_RATE_MISSING`，版本留 0。
- **已有 est 的单后续缺服务费**：est 不覆盖，版本不前进，不进待处理；计数 `couli_pdd_service_fee_missing_total`，warning 告警 `CouliPddServiceFeeMissing`。
- 不回填：未上线；staging 已有的单下次同步时 est 变净额。
- 补贴（`subsidy_duo_amount_level` 等）单列透传，不并入任何金额。

## 上线前要实测

- **CAP-PDD-04，奖励佣金**：`duo_id_service_fee` 是基础佣金及奖励佣金之和对应的费，这里只从基础佣金扣（负责人 2026-10-02 定的公式）。有等级奖励（`subsidy_duo_amount_level`）时 N 偏小，偏保守。文档没给费率，拆不开。未实测。
- **CAP-PDD-07，结算额（`credit.enabled.pdd` 开启前置）**：结算额按已扣服务费处理。实测若是毛额，要在结算写入处换算。未实测。
- 状态映射 `specs/order-status-map/pdd.csv` 各行 verified=false；3（审核成功）实测前不算已结算（BR-FUND-02）。

# 拼多多商品映射（B1-04u）

接口 `pdd.ddk.goods.search`、`pdd.ddk.goods.detail`、`pdd.ddk.goods.recommend.get`，实现在 `apps/api/src/modules/union/infra/pdd/goods.ts`。这里只记要点，细则见文件头注释。

## 请求

- 每次商品调用读一次服务端注入的查询身份（已备案的推广位 + custom_parameters，D-u2）并校验；未注入 `upstream_rejected`，非法 `invalid_identity`。
- `resolveLink`：先以原链接作 goods.search 的关键词；无结果且是 http(s) 链接时，用 url.short.parse 展开一次（参数 `original_url`）。只有短链展开被平台拒绝（`upstream_rejected`）时视为认不出，其他错误上抛。
- `materialFeed`：游标 `pdd-feed:<offset>`，满页且未到 total 才给下一页。

## 字段对照

只读三个商品接口共有的字段：`goods_id`、`goods_sign`、`goods_name`、`goods_desc`（只详情用）、`min_group_price`、`coupon_discount`、`coupon_min_order_amount`、`coupon_start_time`、`coupon_end_time`、`coupon_remain_quantity`、`promotion_rate`，以及图片 `goods_image_url`、`goods_gallery_urls`、店铺名 `mall_name`；详情另读 `sales_tip`、`mall_img_url`、`desc_txt`、`serv_txt`、`lgst_txt`、`mall_id`。

单买价、预测 / 分享比例、平台券、店铺券、收藏券、补贴都不计入（待 CAP-PDD-02 实测另开）。金额是 JSON 整数分，经 `@couli/money` 的 `parseFen` / `subFen` 运算。

# 拼多多转链（B1-04h）

接口 `pdd.ddk.goods.promotion.url.generate`（转链）、`pdd.ddk.member.authority.query`（备案查询）、`pdd.ddk.rp.prom.url.generate` channel_type=10（备案链接），实现在 `apps/api/src/modules/union/infra/pdd/promotion.ts`。

## 请求

- 三个接口都用 linking 在服务端构造的身份：推广位取 `identity.promotionSlot`（备案按推广位分开，D-u3），custom_parameters 按原对象序列化，不重排、不补键、不删键，也不从 userId 重建。
- 转链是写操作：治理层不重试，适配器也不重试；`multi_group` 为 false（BR-PRICE-02 细则 G-48），请求 scheme 与短链。未备案 50001 / 60001 → `upstream_rejected`。
- 只读字段清单里的出参字段，清单外字段（如小程序信息、微信短链）一律不映射。scheme 与短链同时请求未实测。
