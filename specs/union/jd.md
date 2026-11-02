# 京东联盟映射

本文件记京东适配器定下的映射，依次是订单、商品、转链。

# 京东订单映射（B1-04zb）

接口 `jd.union.open.order.row.query`，实现在 `apps/api/src/modules/union/infra/jd/orders.ts`。本文件记本单定下的映射；依据 D10-520、D10-522，结算与 `validCode` 的口径以 D10-529 为准（撤回 D10-520 ①）。

## 请求

- 业务参数只有 `orderReq`：`pageIndex`（从 1）、`pageSize` 200、`type` 3（按更新时间）、`startTime`、`endTime`（GMT+8 的 `yyyy-MM-dd HH:mm:ss`）。
- 不带 `positionId`：它不是过滤参数。不带 `fields`：只影响商品与类目附加信息，这里不映射。
- 时间窗按毫秒原值判：from < to、跨度 ≤ 1 小时、from ≥ 当前时刻 − 90 天，不合格 `invalid_dto`、不发请求；拆窗归 order-sync。
- 内层 2002452（窗口内订单量超接口上限）仍是 `upstream_rejected`，适配器不重试、不缩窗，只在错误上带 `windowTooLarge`。订单侧在同一任务内把窗口对半切开、从第 1 页重查，跨度 ≤ 60 秒不再切，抛原错误；水位只在原窗全部完成后按原窗推进一次（B1-04zt，`orders/application/fetch-window.ts`）。
- 增量起点早于「当前时刻 − 90 天 + 1 小时」超过 30 分钟时，调度先把水位收到这个时刻（无水位行就插入）再发窗，打 warn `order_sync_start_clamped`；CAS 落空本轮不发（B1-04zt）。

## 字段对照

| DTO 字段 | 报文字段 | 说明 |
| --- | --- | --- |
| `sub_order_id` | `id` | 原文字符串 |
| `order_id` | `orderId` | 原文字符串 |
| `parent_order_id` | `parentId` | 0 或缺键为 null |
| `item_id` | `itemId` / `skuId` | 按商品键模式：item 取 `itemId` 全串，sku 取 `skuId`；缺值为 null，不互相顶替 |
| `promotion_slot` | `positionId` | 原文字符串，缺键为 null |
| `attr_params.sub_union_id` | `subUnionId` | 空串或缺键为 null；`relation_id`、`custom_parameters` 恒为 null |
| `raw_status` | `validCode` | 原文字符串；不映射订单状态 |
| `modified_at` | `modifyTime` | 必填 |
| `received_at` | `finishTime` | 空串或缺键为 null |
| `settled_at` | 无 | 恒为 null；`payMonth` 只是预估，不读 |
| `est_commission_fen` | `actualFee` / `estimateFee` | 见下节；保留原值，可为负 |
| `commission_fen` | 同 `est_commission_fen` | 负值取 0 |
| `settle_commission_fen` | 无 | 恒为 null，见下节 |
| `paid_fen` | `actualCosPrice` / `estimateCosPrice` | 见下节 |
| `service_fee_fen` | 无 | 不给 |
| `raw_payload_id` | 无 | 该页归档行 id，取传输回传的元数据，不读报文 |

报文里的其他字段（含图片）不读、不进 DTO。

## 金额

元转分用 `@couli/money` 的 `yuanStrToFen`，只认报文数字的原文（BR-CALC-26），两位小数以外数学 floor。要读的金额字段缺失或非数字时整页 `invalid_dto`，不按 0 处理。

- **`settle_commission_fen`**：京东 Adapter 不写，任何 `validCode` 都是 null，不看 `actualFee`，也不看 `payMonth`。结算额只由联盟结算明细导入写 `order_settlements`（`source=STATEMENT`）。原因：BR-FUND-02 规定 Adapter 只在平台明确已结算时才写这一列，而京东官方的 `validCode` 没有已结算码，17 只是已完成，18 这个码不存在。
- **`est_commission_fen`**：17 取 `actualFee`，其余取 `estimateFee`。未完成单的 `actualFee` 是 0.0，取它就把预估佣金冲成 0；17 下 `actualFee` 真为 0（如退款后）时才是 0n。
- **`commission_fen`**：`max(0, est_commission_fen)`。
- **`paid_fen`**：17 取 `actualCosPrice`，其余取 `estimateCosPrice`。两个原值都留在归档的原始报文里。
- **18 不特殊**：与其他非 17 的码同样处理。
- **只读用得上的字段**：17 不读 `estimateFee`、`estimateCosPrice`，其余状态不读 `actualFee`、`actualCosPrice`；没读的字段缺失、为负、非数字都不影响该行。
- **负数（D10-522）**：`est_commission_fen` 保留原值，`'-3.20'` → -320，`'-3.205'` → -321。`commission_fen`、`paid_fen` 必填非负，取 0；原值留在归档报文。

## 付款时点

| `validCode` | `paid_at` | `deposit_paid_at` |
| --- | --- | --- |
| 24（已付定金） | null | `orderTime` |
| 15（待付款） | null | null |
| 其余（16、17 与各类无效码） | `orderTime` | null |

这是**下单时刻近似付款时刻**：文档列的 `orderPayTime` 实际不出现，只能用 `orderTime`。15 不读 `orderTime`。

适配器只为金额与付款时点读 `validCode`，不判订单状态，不丢弃无效单，不按推广位过滤。

## 时间

全部按 GMT+8 解析，与进程时区无关。不存在的时刻（如 2 月 30 日）算不合格，报 `invalid_dto`。

## 翻页与空页

每次 `listOrders` 取一页，每页单独经配额治理（`listOrdersMetering = 'per_request'`）；`hasMore` 为 true 时 `nextCursor` 指下一页。

`hasMore` 的实际含义是「本页已满」，不是「后面还有」（D10-524，实测：pageSize=1 取只有 1 行的窗口，第 1 页 1 行、`hasMore` 为 true，第 2 页 `data` 与 `hasMore` 两键都缺）。所以行数恰为页大小整数倍的窗口会多取一页，那一页两键都缺，算正常翻完。

| 内层 200 的形状 | 结果 |
| --- | --- |
| 任何一页 `data`、`hasMore` 都缺（无单时间窗与满页后的下一页都是这样） | 空页，翻完 |
| `data` 为 `[]` 且 `hasMore` 为 false | 空页 |
| `data` 为非空数组，`hasMore` 为布尔 | 正常页 |
| 缺 `data` 但有 `hasMore`（任意值） | `invalid_dto` |
| `data` 不是数组（含 null） | `invalid_dto` |
| 有 `data` 但缺 `hasMore`，或 `hasMore` 非布尔 | `invalid_dto` |
| `hasMore` 为 true 而 `data` 为空数组 | `invalid_dto` |

# 京东商品映射（B1-04zc）

接口 `jd.union.open.goods.query`，外层键 `jd_union_open_goods_query_responce`，结果键 `queryResult`，实现在 `apps/api/src/modules/union/infra/jd/goods.ts`。依据 BR-PRICE-01 / 02、BR-PROD-03 / 05、BR-CALC-26、CAP-JD-01、D10-525。

**这一节没有实测依据**：接口现在内层 403，权限批下前只按文档，规则测试的报文都是合成的。标题字段 `skuName` 与空结果形状都待实测核对。

## 请求

业务参数只有 `goodsReqDTO`，`sceneId` 固定 1（2 须申请，本段不用）。`goods.link.query` 不用。

| 端口 | 参数 |
| --- | --- |
| `searchItems` | `keyword`、`pageIndex`（从 1）、`pageSize` 20、`sceneId` |
| `getItem` | `itemIds`（一次一个）、`sceneId` |
| `resolveLink` 走上游时 | 同 `searchItems`，`keyword` 是链接原文，`pageIndex` 1 |

`searchItems` 的游标是不透明的 `jd-goods:<页码>`，关键词不进游标，由调用方续传。游标在取凭据、发请求之前校验，损坏报 `invalid_dto`，不从首页重来。

## 字段对照

| DTO 字段 | 报文字段 | 说明 |
| --- | --- | --- |
| `item_id` | `itemId` / `skuId` | 按商品键模式：item 取 `itemId` 全串，sku 取 `skuId` 原文（16 位内外都无损） |
| `itemId`、`skuId` | 同名 | 有值才给，下游派生商品键用 |
| `title` | `skuName` | 必填 |
| `price_fen` | `priceInfo.price` | 见下节 |
| `coupon_fen` | `couponInfo.couponList` | 自选，见「选券」 |
| `final_price_fen` | 无 | 一律自算 |
| `commission_rate_bp` | `commissionInfo.commissionShare` | 百分比，见「佣金比例」 |
| `quoted_at` | 无 | 注入 `Clock` 的取数时刻 |

图片不映射（B1-22s），报文里的其他字段不读、不进 DTO。

## 商品键模式

`productKeyMode` 每次调用按 `ctx.appId` 读一次，不缓存，缺省 item，其他值 `invalid_dto`。

- 当前模式的键缺失时不拿另一个顶替。
- `skuId` 为 0 或不是十进制数字算缺失。
- 搜索或详情的行缺键、缺标题：`invalid_dto`，搜索是整页失败，与拼多多一致。
- sku 模式下若 `sceneId=1` 真不返回 `skuId`，搜索会一直 `invalid_dto`。要等实测确认，或者申请 `sceneId=2`。

## 价格

| 字段 | 用途 |
| --- | --- |
| `priceInfo.price` | `price_fen`，唯一来源 |
| `priceInfo.lowestPrice` | 不读，只留在归档原始报文 |
| `priceInfo.lowestCouponPrice` | 不参与计算，只用于比对告警，原值留在归档原始报文 |

**金额解析（D10-525）**：`price`、券 `discount`、`quota`、`lowestCouponPrice` 用 `@couli/domain` 的 `parseYuanToFen`，不舍入、不走 floor（与订单不同）。

- JSON 数字一律先转 `String(n)`，**不取报文原文**：`39.900` 得 `39.9`，3990 分；`3.99e1` 得 `39.9`，3990 分。
- 转出来不是两位小数串的算缺失：`39.905`、`99.999`、`1e21`、`1e-7`。
- 字符串形式的金额原样解析：`"39.90"` 收，`"39.900"`、`"3.99e1"` 算缺失。
- 超出双精度的报价现实中不存在，不特别处理。

**平台券后价白名单为空**：京东没有可直接采用的券后价，`final_price_fen` = `price_fen` − `coupon_fen` 恒成立，`lowestCouponPrice` 再怎么有值也不取。

**比对告警**：`lowestCouponPrice` 有值且与自算券后价相差 ≥ 1 分时记 `PRICE_CALC_DIFF`，不改结果。商品异常时不比对。

## 选券

候选券要同时满足：

- `useStartTime` ≤ 当前时刻 < `useEndTime`，毫秒时间戳，取注入 `Clock`；缺任一端不算候选。
- `price_fen` ≥ `quota`，门槛按单件。
- `discount`、`quota` 都解析得出；缺失或不合格的券跳过，不影响其他券。
- `couponStatus` 不是 -1（不可领取）；缺失或其他值仍算候选。

候选里取 `discount` 最大的一张，面额相同取门槛低的。`isBest` 不看。接口没有剩余量字段，视为有余量。一张都没有时 `coupon_fen` 为 0，不算异常。

## 佣金比例

`commissionShare` 取报文**原文**（不走 `String(n)`），用 `@couli/money` 的 `pctStrToBp` 按 BR-CALC-26 换算，超两位小数 floor，范围 0..100 %。缺失、非数字、负数、超过 100、科学计数法都按数据异常，不当 0。

## 异常

| 情形 | `price_anomaly_reason` |
| --- | --- |
| `price` 缺失或不合格 | `missing_field` |
| `price` 为 0，或 `coupon_fen` ≥ `price_fen` | `invalid_price` |
| 佣金比例不合格 | `missing_field` |

先判价格，再判佣金，一个商品只告警一次。异常商品记 `PRICE_ANOMALY`，三价与比例置 0 占位并标 `price_status: 'anomaly'`，不当 0 元。

- `searchItems`：该商品不出卡，同页其他商品照常，它仍计入已取条数。
- `getItem`：照样返回带异常标记的商品。
- `resolveLink`：只认身份，不看价格，不告警。

## 翻页与内层 code

`nextCursor`：空页结束；否则看 `(页码 − 1) × 20 + 本页上游行数 < totalCount`；`totalCount` 不可用时满页才继续。

内层 200 而 `data` 缺失算空结果；`data` 存在但不是数组（含 null）报 `invalid_dto`。

| 内层 code | `searchItems` | `getItem` | `resolveLink` |
| --- | --- | --- | --- |
| 201 未查询到满足条件的商品 | 空页，翻页结束 | `item_unavailable` | `link_unrecognized` |
| 202 已达到分页上限 | 空页，翻页结束 | `upstream_rejected` | `upstream_rejected` |
| 410、411 sceneId 无权限或格式不匹配 | `link_unrecognized` | `link_unrecognized` | `link_unrecognized` |
| 429 | `rate_limited` | `rate_limited` | `rate_limited` |
| 403 与其余 | 按底座，403 告警一次 | 同左 | 同左 |

## getItem

只用于 item 模式：`item_id` 优先，其次 `itemId`，空结果 `item_unavailable`。sku 模式没有 `sceneId=2` 权限，手里的 skuId 也不能当 `itemIds` 传，所以不发请求，直接 `item_unavailable`。

## resolveLink 各形态（CAP-JD-01）

| 链接 | item 模式 | sku 模式 |
| --- | --- | --- |
| `jingfen.jd.com/detail/<itemId>.html`（可带 http(s) 与查询串） | 直接得 itemId，不取凭据、不调上游 | 走 keyword，取第一条的 `skuId` |
| `u.jd.com`、`union-click.jd.com`、其他 URL | 走 keyword，取第一条 | 同左 |
| 主站 `item.jd.com`、`item.m.jd.com`、`3.cn` | 走 keyword，上游 410、411、201 或空结果 → `link_unrecognized` | 同左 |

- 走 keyword 时身份只取响应。第一条价格异常也不换第二条：链接认的是商品，不是出卡。
- 第一条缺当前模式的键 → `link_unrecognized`，不把 itemId 当 skuId，不从链接补。
- jingfen 严格匹配域名与路径，仿冒的和 itemId 字符集（字母、数字、`_`、`-`）之外的都走 keyword。
- 不跟随跳转，不抓页面，不从链接里抽 skuId。

## 不泄密

错误与告警只带固定文案、方法名、code、商品标识、原因和分值，不带报文内容、比例原文、关键词、链接、券链接。

| 告警 | 字段 |
| --- | --- |
| `PRICE_ANOMALY` | `method`、`code`、`item_id`、`reason` |
| `PRICE_CALC_DIFF` | `method`、`code`、`item_id`、`final_price_fen`、`lowest_coupon_price_fen` |

# 京东转链（B1-04zd）

接口 `jd.union.open.promotion.common.get`，外层键 `jd_union_open_promotion_common_get_responce`，结果键 `getResult`，实现在 `apps/api/src/modules/union/infra/jd/promotion.ts`。依据 D10-500 ①、BR-ATTR-05、CAP-JD-06。`promotion.bysubunionid.get` 不用。

## 请求

业务参数只有 `promotionCodeReq`：

| 参数 | 取值 |
| --- | --- |
| `materialId` | `https://jingfen.jd.com/detail/<itemId>.html` |
| `siteId` | 配置 `JD_SITE_ID`，字符串原文上行，不过 number |
| `positionId` | 身份的 `promotionSlot`，转成 Number |
| `sceneId` | 固定 1 |
| `subUnionId` | 身份有这个属性才带 |

不发 `pid`、`ext1`、`couponUrl`、`command`、`protocol`；`idempotencyKey` 与 `userId` 不上行。归档用途 `kind=convert`。写操作，治理层与适配器都不重试。

检查顺序：`siteId` → 身份 → 商品键模式 → 商品，都在取凭据、发请求之前。

## materialId

用联盟 itemId 形式。`item_id` 优先，其次 `itemId`（linking 实际传这个）。

- 两个键走同一套校验：只收字母、数字、`_`、`-`，与 `resolveLink` 认的 jingfen 字符集一致。空串、含 `/`、`?`、空白或其他字符都 `invalid_dto`。
- `item_id` 给了值就只看它，不合格不退到 `itemId`；`item_id` 缺失或 null 才看 `itemId`。
- `productKeyMode` 每次调用按 `ctx.appId` 读一次，不缓存。读到 sku → `link_unrecognized`：sku 模式存的是 skuId，官方只接受完整联盟商品 ID（2001707），换不了，不发请求，不猜。

## siteId

`JD_SITE_ID` 可不配，启动不拒绝。缺失（未给、null、空白）时 `convert` 报 `adapter_unimplemented`，不取凭据、不发请求，下游出 50303。其他京东端口不受影响。

## 身份、subUnionId 与 no_rebate

只认 `isServerIdentity` 为真且 `platform=jd` 的身份，否则 `invalid_identity`，不取凭据、不发请求。

- `promotionSlot` 须是十进制正整数（无前导零）且不超过安全整数，否则 `invalid_identity`。
- `subUnionId` 读身份的同名属性（`n_{attr_code}` 或 `n_{attr_code}_{lk}`，linking 已构造好），原样上行，适配器不拼不改。格式是字母、数字、`_`、`-`，1～80 字符，不合 `invalid_identity`。
- **no_rebate**：身份没有这个属性时请求里就没有这个键，不发空串。属性存在但为 null 算格式不合，不当 no_rebate。

## 结果

`{ kind: 'url', url: clickURL }`，`clickURL` 取内层 `data.clickURL`。

- 须是 `http://` 或 `https://` 开头、不含空白、能解析出主机的字符串，否则 `upstream_unavailable`。
- `jCommand` 不进结果，不用它顶替，不自行拼 scheme，不回退原链接。
- **没有短链**：这个接口的结果只取 `clickURL`，不再调别的接口换短链，`short_url` 不给。

## 错误码映射

内层 code 走底座细分表，限流在先。

| 内层 code | 结果 | 告警 |
| --- | --- | --- |
| 429 | `rate_limited` | 否 |
| 2001104 商品不在推广中 | `item_unavailable` | 否 |
| 2001101、2001102、2001703、2001706、2001707 链接或场景不支持 | `link_unrecognized` | 否 |
| 2001701 本单不用 `couponUrl`，只可能是 `siteId` 类型不符（CAP-JD-06） | `upstream_rejected` | 一次 |
| 403、2001403、2001602、2001603 无权限 | `upstream_rejected` | 一次 |
| 2001208 `subUnionId` 格式 | `upstream_rejected` | 否 |
| 2001609 服务降级 | `upstream_unavailable` | 否 |
| 其余 | `upstream_rejected`（底座） | 否 |

网关层错误、HTTP 5xx、传输抛错沿用底座分类。

## 不泄密

错误与告警不带 `subUnionId`、`clickURL`、`itemId`、推广位与上游 `message`。告警只含 `method` 与 `code`。
