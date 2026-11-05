# CT-26p 规则测试作者说明（orders-quantity 基线）

作者：claude-independent（D10-327）。依据：D10-664 S-04、04 §6.4、contracts/README 第 8 条。

## 改了什么

只改 `baseline.ts` 里 `OrderSummary` 的基线；测试体 `orders-quantity.test.ts` 和 `OrderDetail` 基线没有改。

- 改前：`baselineWithoutQuantity('OrderSummary').properties` = `commonProperties`（12 项，没有 `is_price_compare`）。
- 改后：`properties` = `{ ...commonProperties, ...summaryProperties }`，其中
  `summaryProperties = { is_price_compare: { type: ['boolean', 'null'] } }`。
- `required` 不变（仍是 `commonRequired`）：这个字段是可选的，`/v1` 现有结构只许新增可选字段。
- `OrderDetail` 分支照旧是 `{ ...commonProperties, ...detailProperties }`，`required` 照旧追加 `Object.keys(detailProperties)`，结果和改前完全相同。

## 理由

- 写法和 `OrderDetail.is_price_compare` 一致：`type: [boolean, 'null']`，没有 format / enum / default / const。
- 测试里的 `structure()` 比较前会去掉所有 `description`，所以基线里不写描述；契约里的描述（来源 orders.is_price_compare；为 true 时显示「比价订单」标识，文案键 order.tag.price_compare，BR-TEXT-03；识别口径 BR-CALC-16；未核实前不置位）不影响这个用例，用什么措辞都可以。
- 基线也不允许额外约束：契约里的 `is_price_compare` 只能有 `type`（以及描述），否则 `toEqual` 不通过。

## 先红

现在的契约里 `OrderSummary.properties` 还没有 `is_price_compare`，所以 `[AC-CT-04b#1] OrderSummary` 会在
`expect(structure(...)).toEqual(baselineWithoutQuantity(name))` 这一句因断言失败变红；`OrderDetail` 那一组和 `[AC-CT-04b#2]` 不受影响，照旧通过。
契约按上面的写法加上可选的 `is_price_compare` 以后，这个用例转绿。

## 第 2 次

第 1 次对 `baseline.ts` 的改动保持不动。新增 `order-summary-price-compare.test.ts`（读契约的写法照 `orders-quantity.test.ts`，
读 YAML 用 `tools/lib/yaml-lite.ts` 的 `parseYamlLite`，照 `test/spec/content/text-guard/fixtures.ts`）。四个用例：

- `[AC-CT-26p#1]`：`OrderSummary.properties.is_price_compare` 存在、`type` 恰为 `['boolean', 'null']`（顺序与 `OrderDetail` 写法一致），
  不在 `OrderSummary.required` 里；`GET /v1/orders` 200 示例 `data.items` 中带了该字段的项取值只能是布尔或 null（示例不带也行）；
  `OrderDetail.is_price_compare` 照旧存在、类型相同、仍必填。示例和 OrderDetail 的检查现在就成立，所以和 schema 断言放在同一个用例里，
  这样每个用例都先红，不会出现不检查任何东西就通过的用例。
- `[AC-CT-26p#2]`：`texts.default.json` 的 `texts['order.tag.price_compare']` 为「比价订单」（BR-TEXT-14 表 C / BR-TEXT-03）。
- `[AC-CT-26p#3]`：`fund-term-keys.yaml` 的 `fund_terms.keys` 含该键（BR-TEXT-12 细则「单列」，所以查 keys，不接受前缀覆盖），
  而且 `ordinary.keys` / `ordinary.prefixes` 都不覆盖它（与 admin-dict reader 的「恰归一类」口径一致）。
- `[AC-CT-26p#4]`：`banned-words.yaml` 只有一个「比价」条目，它的 `allow_keys` 含该键（BR-TEXT-13）。

先红：现在的契约里四项都缺，所以 #1 红在 `toHaveProperty(['is_price_compare'])`，#2 红在 `hasOwn` 为 false，
#3、#4 红在 `toContain`，全部是断言失败。依据都在 SPEC_REF 的 docs/changes/20261105-返利按接口实际金额展示.md 第 82 行
和 08 12_TEXT 第 1078 行。
