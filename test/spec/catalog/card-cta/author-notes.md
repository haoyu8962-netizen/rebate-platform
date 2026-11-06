# B1-05zg 规则测试作者说明（D10-664 S-08）

依据：08 BR-TEXT-12 细则「购买按钮」（2026-11-05 v3 改定，SPEC_REF 18f0015）、BR-TEXT-15、BR-AI-11；
契约 `ProductCta` 描述（contracts/openapi.yaml）与 `contracts/texts.default.json` 已有全部键
（`btn.buy.rebate`、`btn.buy.rebate_unknown`、`rebate_login_to_view`、`btn.buy.no_rebate`），无冲突。

## 新用例

| 编号 | 文件 | 钉住什么 |
| --- | --- | --- |
| AC-B1-05zg#1 | catalog/card-cta/assembly.test.ts | 真实 createCardAssembler：normal 有券 / 无券 → btn.buy.rebate；no_rebate 有券 / 无券 → btn.buy.no_rebate；benefit_tags 不变 |
| AC-B1-05zg#2 | catalog/card-cta/assembly.test.ts | 属性：任意平台、entry_source、价格、券额、返利额，按钮只看返利状态；从不下发 btn.buy.coupon / btn.buy.rebate_suffix |
| AC-B1-05zg#3–#7 | catalog/card-cta/entries.test.ts | 搜索、识别（粘贴）、详情、收藏、热销榜各一处：有券单值卡 → btn.buy.rebate（入口沿用 entry-quote-parity 的 viaX；收藏走 createFavoriteCardPort + detail kit） |
| AC-B1-05zg#8 | agent/tools-search-cta/cards.test.ts | 游客开关开：遮罩为 login_required 的卡 → rebate_login_to_view；开关关的 normal 卡保持 btn.buy.rebate |
| AC-B1-05zg#9 | agent/tools-search-cta/cards.test.ts | 游客开关开：amount_unknown 卡被改为 login_required → rebate_login_to_view |
| AC-B1-05zg#10 | agent/tools-search-cta/cards.test.ts | 不遮罩：amount_unknown → btn.buy.rebate_unknown；入口已是 login_required → rebate_login_to_view |
| AC-B1-05zg#11 | agent/tools-search-cta/quote.test.ts | 查返利（链接报价）normal 单值卡有券 / 无券 → btn.buy.rebate |

先红：现实现 ctaKeyFor 有券给 btn.buy.coupon、无券给 btn.buy；Agent 搜索卡遮罩与 normalizeCard 原样沿用入口
cta。上述每条在现实现上都红在 toEqual 断言（#2 为 fast-check 反例），no_rebate 的断言与 normal 的断言放在
同一个 it 里，不单独成为现实现上就绿的用例。

不在本单：LinkLanding / 分享面板的卡（契约 SharedProductCard 不带 cta），linking 的 kit 未碰。

## 冻结用例改动（D10-327）

`test/spec/catalog/card/assembly.test.ts`，同文件其余用例不动：

- [AC-B1-05f#1]
  - 改前：标题「BR-PRICE-01/06：保留三个价格字段，只透传报价端口的本人份额（淘宝搜索卡单值）」；
    `cta: { text_key: 'btn.buy.coupon' }`
  - 改后：标题「BR-PRICE-01/06：保留三个价格字段，只透传报价端口的本人份额（淘宝搜索卡单值，有券按钮 btn.buy.rebate）」；
    `cta: { text_key: 'btn.buy.rebate' }`
- [AC-B1-05f#8]
  - 改前：标题「无券正常返利使用普通购买按钮，JSON 金额保留安全整数上界」；
    `expect(card.cta).toEqual({ text_key: 'btn.buy' })`
  - 改后：标题「无券正常返利与有券同用 btn.buy.rebate 购买按钮，JSON 金额保留安全整数上界」；
    `expect(card.cta).toEqual({ text_key: 'btn.buy.rebate' })`

两处各在用例上方加一行注释说明来源（B1-05zg / D10-664 S-08）。改后两条在现实现上红在 cta 断言。

## 给实现者

单元测试里钉旧键的 `apps/api/src/modules/catalog/domain/card.test.ts`（btn.buy / btn.buy.coupon）与
`apps/api/src/modules/agent/tools/quote/index.test.ts`（btn.buy.coupon）在任务路径内，需随实现改。
