# F1-11b 规则测试说明（D10-1246）

## 键名与原句

| 键 | 默认文案 | 依据（SPEC_REF 1eb08a7） |
| --- | --- | --- |
| `share_page.invalid` | 分享链接已失效，请联系分享者重新分享 | 08 BR-ATTR-05 正文「中间页统一显示“分享链接已失效，请联系分享者重新分享”」；同条细则「别人的分享 link 不可用」「H5 中间页按正文显示」同一句 |
| `share_page.quote_time` | 取价 {time} · 价格可能已变化，以下单页为准 | 08 BR-PRICE-11 正文：age_sec > 300 或 stale=true 时显示「取价 HH:mm · 价格可能已变化，以下单页为准」（不是当天写 MM-DD HH:mm）；HH:mm 换成变量 `{time}`，由 H5 formatQuoteTime 产出。分享中间页正是在这一条件下才显示取价时间（apps/h5 share-page.ts quoteLine） |

- 04 §6 / §7 有一处简写「分享链接已失效」，08 正文是完整句，以 08 为准。
- 中间的「·」是 U+00B7，两侧各一个半角空格，与 08 原文一致；逗号是全角「，」。
- 键名是测试作者取的（任务书只规定 `share_page.` 前缀）：`invalid` 对应被替换的 `link_landing.invalid`，`quote_time` 对应 BR-PRICE-11「取价时间」。

## 归类（08 BR-TEXT-12 细则「资金术语键」）

- 两句都不说金额或提现状态、有没有返利，不在返利金额位置，`{time}` 不是金额变量 → 都归 `ordinary.keys`（逐键列出，不加 `share_page.` 前缀，免得吞掉以后的资金术语键）。
- `share_page.invalid` 含术语表用户词「已失效」，命中关键词核对；08 同一细则把 `link_landing.invalid`「链接已失效」列为例外表的例子（说的是链接），照此进 `exempt`，理由须写明说的是链接。
- `share_page.quote_time` 不命中关键词，不进 `exempt`（进了 checkFundTermDoc 会报「remove it」）。

## 不在本单范围

- `apps/h5` 换键由 fe 另做；暂借的 `link_landing.invalid`、`earnings.as_of` 原样保留（App 内 LinkLanding 与钱包仍在用）。
- `fund-term-keys.gen.ts` 须由生成脚本按 YAML 重新生成（测试核对两者一致）。
