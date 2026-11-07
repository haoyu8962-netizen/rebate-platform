# B1-04zzn 规则测试 author-notes

规则：BR-PROD-04（S-19，D10-728 ②）。作者：独立 Claude（第 1 次），没有 shell，`pnpm typecheck`、`pnpm lint`、先红都没跑，由编排者跑。

## 骨架

`apps/api/src/modules/catalog/domain/spec-hint.ts`：只给 `PriceSpecHintInput` 加了可选类型字段 `fromUnionDetail?: boolean`（编排补充「只加类型不算骨架」），函数体没动，card-assembler 与 B1-05zh 的用例照常可跑。`detail.ts` 没动：现行实现把拼多多详情判成 spec_uncertain，新用例在断言上红。

## 用例

| 文件 | 编号 | 钉什么 | 现行实现上红在 |
| --- | --- | --- | --- |
| rule.test.ts | #1–#9 | 纯函数：pdd + `fromUnionDetail === true` → price_from；缺省 / false / 非 true 值 → spec_uncertain；平台码严格（'PDD'、' pdd' 等不算）；淘宝、京东 item 详情价仍 spec_uncertain，京东 sku 仍 null；jdMode 不影响 pdd；标题、区间字段不参与；无状态；fast-check 属性（带固定反例 examples） | 断言 / fast-check 反例 |
| detail.test.ts | #10–#18 | 经 getProduct：拼多多联盟详情的新鲜答复、缓存命中、stale 旧缓存、带 from_link_id、带 item_ref、无券标题写「起」→ price_from；池回退（50401 → 池行）→ spec_uncertain；淘宝 / 京东 item 详情 spec_uncertain、京东 sku 详情 null；交替取详情逐次判定 | `price_from` 断言 |
| cards.test.ts | #19 | 共用出卡器出的拼多多搜索、feed、池、rank、parse、tlj_pool、Agent 卡仍 spec_uncertain；同一商品的详情 price_from | `price_from` 断言 |

## 作者定下的取值（请评审确认）

1. 判定入口：出卡器（card-assembler.ts，不在本单 paths）照旧按 entrySource 不区分详情；B1-05zh#10 已钉「出卡器以 entrySource=detail 出 pdd 卡 → spec_uncertain」，所以收窄只能在 `detail.ts` 的联盟详情分支里经 `priceSpecHintFor({ …, fromUnionDetail: true })` 写回，池回退分支不传。
2. 收藏卡（favorites card-port 复用 getProduct，`images` / `detailExtras` 为 false）价格同样取自联盟详情，本单不钉它是 price_from 还是 spec_uncertain，留给编排定。
