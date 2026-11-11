# 淘宝联盟映射

本文件记淘宝适配器已定下的映射，依次是订单、商品、转链。订单、维权、违规都经大淘客开放平台取数（D10-486），商品详情与官方搜索走淘宝 TOP。录制只放在私有库，这里只写路径引用：订单字段形状见 `rebate-private/cap-tests/2026-10-31/dataoke/orders-shapes.json`。

# 淘宝订单映射（B1-04f、B1-04zz、B1-04zzh）

接口大淘客 `GET /api/tb-service/get-order-details`（version v1.0.0），取 `data.results.publisher_order_dto`，字段与官方 publisher_order_dto 同名同义。实现在 `apps/api/src/modules/union/infra/taobao/orders.ts`，装配在 `taobao-adapter.ts` 的 `listOrders`。依据 D10-486 ②、D10-488、D10-504、D10-588、D10-692。

## 请求

- 业务参数：`queryType`、`startTime`、`endTime`、`pageSize` 100、`orderScene` 1；续页另带 `positionIndex` 与 `jumpType` 1。
- `queryType` 由 `OrderQueryOpt.timeBasis` 定：update 4（缺省）、pay 2、settle 3、create 1；其他值 `invalid_dto`。
- 时间窗按毫秒原值判 from < to，不合格 `invalid_dto`；再换成北京时间「YYYY-MM-DD HH:MM:SS」，from 向下、to 向上取整到秒，与注入时钟无关。窗口超过 3 小时按 3 小时顺序切窗。
- 每窗首页不带 `positionIndex`；`has_next` 为 true 时续页原样带上一页的 `position_index`。`has_next` 为 true 而 `position_index` 缺失、空串或与本次所带相同 → `upstream_unavailable`。
- 一次 `listOrders` 取一个上游页，每页单独经配额治理（`listOrdersMetering = 'per_request'`）。`nextCursor` 是不透明串（`tbo1.` 开头），带查询口径、整个窗口、当前窗起点与位点；游标的口径或窗口与本次调用不符 → `invalid_dto`。
- 口径、窗口、游标的校验都在读推广位、取凭据、发请求之前。
- 订单源（大淘客）或推广位读取端口没有注入 → `adapter_unimplemented`。
- 外层 code 分类沿用大淘客底座（`infra/dataoke/response.ts`）。外层键名、成功码与错误码待大淘客录制核对（源码 TODO）。

### 推广位过滤

- 推广位清单取 `union_pids` 登记的全部淘宝 PID，含已停用的；每次调用最多读一次，在发请求之前。取 PID 最后一段作 adzone。
- 清单为空是配置错误：告警 `taobao_order_no_slots`，抛 `adapter_unimplemented`，不发请求。
- 只留 `adzone_id` 属于清单的行。读得出而不属于凑狸的行丢弃，每页计数告警一次（`taobao_order_foreign_slot`），不带单号与金额。
- 读不出推广位（`adzone_id` 缺失、不是正整数或十进制数字串，或整行不是对象）是坏行，不算别家（B1-04zzh）：collect 下进 `rejected`，否则跳过并告警。一页 ≥ 1 行而全部读不出 → `upstream_unavailable`。
- 归档的报文去掉别家推广位的行，自家行与坏行保留（B1-04zzc）。

### 坏行

- 必需字段：`trade_id`、`alipay_total_price`、`pub_share_pre_fee`、可读的 `adzone_id`。缺失或非法时该行跳过，告警 `taobao_order_row_skipped`（只带字段名）。
- 订单同步带 `CallCtx.rowErrors: 'collect'` 调用时更严，坏行进 `rejected`、不打 row_skipped：另要求 `tk_status` 可读、`pub_share_pre_fee_for_commission` 有值；`tk_status` 为 3 的行还要有 `tk_earning_time`、`pub_share_fee_for_commission` 与结算服务费。
- 可选字段缺失、JSON null 或「--」静默为 null；非法值为 null 并告警 `taobao_order_field_invalid`（只带字段名）。

## 字段对照

| DTO 字段 | 报文字段 | 说明 |
| --- | --- | --- |
| `order_id` | `trade_id` | 非空字符串，必需 |
| `sub_order_id` | `trade_id` | 与 `order_id` 相同 |
| `parent_order_id` | `trade_parent_id` | JSON 整数转十进制串，非空字符串原样 |
| `item_id` | `item_id` | 非空字符串原样 |
| `promotion_slot` | `adzone_id` | 十进制串；是过滤推广位用的那个值 |
| `attr_params.relation_id` | `relation_id` | 同 `parent_order_id` 的读法；只有部分订单有 |
| `attr_params.custom_parameters` | 无 | 恒为 null |
| `attr_params.sub_union_id` | 无 | 恒为 null |
| `raw_status` | `tk_status` | 整数的字符串形式；不映射订单状态，状态见 `specs/order-status-map/taobao.csv` |
| `deposit_paid_at` | `tk_deposit_time` | 北京时间串转时刻 |
| `paid_at` | `tk_paid_time` | 北京时间串转时刻 |
| `received_at` | 无 | 恒为 null：订单报文没有确认收货时间 |
| `settled_at` | `tk_earning_time` | 北京时间串转时刻；不用它判是否已结算 |
| `modified_at` | `modified_time` | 北京时间串转时刻 |
| `paid_fen` | `alipay_total_price` | 必需；负值收到 0 |
| `commission_fen` | `pub_share_pre_fee_for_commission` | 见「金额」；负值收到 0 |
| `est_commission_fen` | `pub_share_pre_fee_for_commission` − `alimm_share_info_dto.alimm_tech_service_pre_fee` | 净额，见「金额」 |
| `settle_commission_fen` | `pub_share_fee_for_commission` − `alimm_share_info_dto.alimm_tech_service_fee` | 净额，只在 `tk_status` 为 3 时读，见「金额」 |
| `service_fee_fen` | `alimm_share_info_dto.alimm_tech_service_pre_fee` / `alimm_share_info_dto.alimm_tech_service_fee` / `alimama_share_fee` | 实际扣的那个数：`tk_status` 为 3 是结算服务费，其余是预估服务费 |
| `subsidy_commission_fen` | `pub_share_pre_fee_for_sdy` / `pub_share_fee_for_sdy` | 补贴类佣金（BR-CALC-18），取值时机同 est / settle：`tk_status` 为 3 取结算字段，其余取预估字段；元转分非负，不扣服务费，不进 N；缺键、null、「--」、空串、非法为 null，不拒行 |
| `raw_payload_id` | 无 | 不映射报文字段：取归档传输挂在响应上的元数据（该页归档行 id），不读报文里的同名值 |
| `shop_id` | 无 | 不给（不加此键）：订单接口没有与商品侧同口径的店铺 ID |
| `tk_status` | `tk_status` | JSON 整数原样 |
| `refund_tag` | `refund_tag` | JSON 整数原样 |
| `tk_order_role` | `tk_order_role` | JSON 整数原样 |
| `item_num` | `item_num` | JSON 整数原样 |
| `site_id` | `site_id` | 十进制串 |
| `special_id` | `special_id` | 十进制串；只有渠道订单有 |
| `item_price_fen` | `item_price` | 元转分，非负 |
| `alimama_share_fen` | `alimama_share_fee` | 元转分，非负 |
| `subsidy_fen` | `subsidy_fee` | 元转分，非负；不进 N |
| `total_commission_fen` | `total_commission_fee` | 元转分，非负 |
| `tech_service_fee_fen` | `alimm_share_info_dto.alimm_tech_service_fee` | 元转分，非负；只是 dto 里的原值，不含回退 |
| `tech_service_pre_fee_fen` | `alimm_share_info_dto.alimm_tech_service_pre_fee` | 元转分，非负；只是 dto 里的原值，不含回退 |
| `income_rate_bp` | `income_rate` | 百分比转 bp（`pctStrToBp`） |
| `pub_share_rate_bp` | `pub_share_rate` | 百分比转 bp |
| `total_commission_rate_bp` | `total_commission_rate` | 百分比转 bp |

报文里的其他字段不读、不进 DTO。大淘客自算的 income、income_by_one、price_by_one、day 不映射。淘宝订单不给件数与已退件数（`quantity`、`refunded_quantity` 缺键）。

## 金额

元转分用 `@couli/money` 的 `yuanStrToFen`，比例用 `pctStrToBp`（BR-CALC-26）。JSON 数字一律取报文原文（JSON.parse reviver 的源文本），不经 JS number；两位小数以外数学 floor。

N 是已扣技术服务费的推广者收入（BR-CALC-03、BR-CALC-18、D10-105、D10-588）。报文给服务费金额，扣除只在适配器这一处，下游不再减：

- `est_commission_fen` = `pub_share_pre_fee_for_commission` − `alimm_tech_service_pre_fee`（预估服务费）。
- `settle_commission_fen` = `pub_share_fee_for_commission` − `alimm_tech_service_fee`（结算服务费），只在 `tk_status` 为 3 时读（BR-FUND-02），不看 `tk_earning_time`；其余状态为 null。
- 两个服务费都取 `alimm_share_info_dto` 里的字段；dto 缺失、或该字段没有值（缺键、JSON null、「--」）时才回退 `alimama_share_fee`。dto 字段非法、dto 不是对象都不回退，服务费为 null。都没有也是 null，绝不按 0。
- 佣金或服务费任一为 null，对应的 N 为 null。两边各自 floor 到分再减，结果可为负；超出 int64 算非法。
- 补贴（官方 for_sdy 系列字段）不进 N，这里不读。`pub_share_pre_fee` 含补贴，值不用，仍是必需字段；结算侧的不带后缀字段不读。
- `commission_fen`：`est_commission_fen` 有值时取 max(0, 它)；算不出（缺服务费）时取 max(0, `pub_share_pre_fee_for_commission`) 毛额，同拼多多；佣金字段也没有才是 0。
- 负数（BR-CALC-26、D10-522、D10-572，与京东同一套）：只有 `pub_share_pre_fee_for_commission`、`pub_share_fee_for_commission`、`pub_share_pre_fee`、`alipay_total_price` 的负值是合法值，按数学 floor 保留；净额原样留在 N，必填非负的 `commission_fen`、`paid_fen` 收到 0。其余金额（含服务费）与比例的负值仍是非法值。
- 算不出 N：collect 下佣金字段拿不到、已结算行拿不到结算额都进 `rejected`；否则 null 加告警。

**未实测**：N 字段映射 verified=false，真实口径要用测试单与联盟后台逐单核对后才开入账，`credit.enabled.taobao` 保持 off（B1-04zz）。翻页结束条件与列表键按文档字段写，待大淘客订单录制复核（源码 TODO）。

## 时间

报文时间是北京时间「YYYY-MM-DD HH:MM:SS」，与进程时区无关；不存在的时刻（如 2 月 30 日）或 1970 年以前算非法。「--」表示尚未发生，为 null。

# 淘宝商品映射（B1-04l、B1-04zh、B1-04zx、B1-04zy）

实现在 `apps/api/src/modules/union/infra/taobao/goods.ts`、`official-search.ts`、`dataoke-search.ts`、`search-fallback.ts`。这里只记来源与要点，细则见各文件头注释。

## 请求

| 端口 | 接口 |
| --- | --- |
| `getItem` | TOP `taobao.tbk.item.info.upgrade.get`，参数 `item_id`（一次一个）、`biz_scene_id` 1 |
| `searchItems`（official，缺省） | TOP `taobao.tbk.dg.material.optional.upgrade`，要注入搜索推广位，否则 `adapter_unimplemented` |
| `searchItems`（dataoke） | 大淘客 `GET /api/goods/get-dtk-search-goods`（v2.1.2），大淘客 goodsId 经 `item.info.upgrade.get` 换成凑狸口径 `item_id`，换不到不返回 |
| `searchItems`（official_first） | 第 1 页官方优先，失败或 0 条回落大淘客，续页按游标前缀走 |

## 字段对照

详情与官方搜索的行走同一份映射，只读 `item_basic_info`、`price_promotion_info`、`publish_info.income_info.commission_rate` 下的指定字段，不 spread 整份报文。元转分只用 `@couli/domain` 的 `parseYuanToFen`（BR-PRICE-01），超两位小数、非数字、空串、负数一律按缺失，不截断。

详情实录（2026-11-08，B1-04zzzw）里 `item_basic_info` 只有类目名称、没有类目 ID，所以详情路径只出一级类目名称。

大淘客搜索的价格口径（D10-530）：`price_fen` = 券后价 + 券额，`coupon_fen` = 券额，`final_price_fen` = 券后价；原价只存不进三价。大淘客 goodsId 不作 `item_id`，也不出现在结果里。

# 淘宝转链（B1-04d、B1-04l）

## 请求

- `convert`：配置 convertSource 为 dataoke 且有订单源时，经大淘客 `GET /api/tb-service/get-privilege-link`（v1.3.1），实现在 `privilege-link.ts`；否则 `adapter_unimplemented`。参数 `goodsId` = 商品 `item_id` 原样，`pid` = 身份的推广位，`channelId` = 身份的 relationId（非空字符串才带；null 是 no_rebate，不带）。
- 外层 code 10031、10212、10213 → `item_unavailable`，其余照大淘客底座。
- 结果链接只认绝对 https：取 `short_url`，没有取 `coupon_click_url`，都没有 → `upstream_unavailable`。
- 淘口令（`taobao.tbk.tpwd.create`）与短链（`taobao.tbk.spread.get`）见 `links.ts`。

转链与商品段的真实返回形状以私有库录制为准，本文件不重复；未录制核对的部分以源码 TODO 为准。
