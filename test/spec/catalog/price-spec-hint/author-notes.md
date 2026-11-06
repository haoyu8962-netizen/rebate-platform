# B1-05zh 规则测试 author-notes

规则：BR-PROD-04（S-19，D10-713），一跳 BR-AI-24、BR-AI-11。作者：独立 Claude（第 1 次），没有 shell，`pnpm typecheck`、`pnpm lint`、先红都没跑，由编排者跑。

## 骨架

`apps/api/src/modules/catalog/domain/spec-hint.ts`：`priceSpecHintFor(input: { platform: string; jdMode?: 'item' | 'sku' }): 'price_from' | 'spec_uncertain' | null`，只抛 `NotImplemented`。card-assembler、Agent 卡（search/card.ts、quote/index.ts）没动（接线排在 B1-05zg 之后）。

## 用例

| 文件 | 编号 | 钉什么 | 骨架上红在 |
| --- | --- | --- | --- |
| rule.test.ts | #1–#8 | 纯函数：jd+sku → null；jd item / 无模式 / 非法模式值 → spec_uncertain；taobao、pdd、其余平台码不论 jdMode 都是 spec_uncertain；标题、spec_text、价格、区间字段不参与；无状态；fast-check 属性 | `NotImplemented` |
| cards.test.ts | #9–#16 | 真实 createCardAssembler / createCatalogCardEntry：四种形态（taobao、pdd、jd item、jd sku）× 搜索、池回退 stale、feed、缓存降级、rank、parse、detail、tlj_pool、agent、带 sourceLinkId、无返利、无券标题写规格；预备卡与登记后卡一致；同一京东条目按卡片自身 product_key 判定；交替出卡逐张判定 | `toHaveProperty('price_spec_hint')` |
| agent-search.test.ts | #17–#20 | normalizeCard 照抄目录卡的值（spec_uncertain / null / price_from），与 match_tag 无关；login_to_view 遮罩后保留；目录卡缺字段 → null；真实出卡器 → Agent 卡同一判定 | `toHaveProperty('price_spec_hint')` |
| agent-quote.test.ts | #21–#23 | resolve_link 与 get_rebate_quote 的报价卡带目录判定；照抄目录卡的值（含打补丁的 price_from / null），不按平台重算；match_tag 仍是 matched | `toHaveProperty('price_spec_hint')` |

## 作者定下的取值（请评审确认）

1. **出卡器怎么知道京东模式**：CardAssemblerOptions 与 AssembleCardInput 都没有配置口，所有 createCatalogCardEntry 接线点（catalog.module、app.module、linking.module、parse-input、catalog-admin）都在本单 paths 之外。所以用例按卡片自身身份判定：BR-PROD-03 派生下 item 模式的 key 是 `jd:i_<n>`（raw_item_id = itemId），sku 模式是 `jd:<skuId>`（raw_item_id = skuId）。两种京东条目都同时带 itemId 与 skuId，只是派生出的 product_key 不同（不按条目字段猜模式，B1-05w#34）。好处是池回退、旧卡在模式切换后仍按该卡价格的实际粒度判定。如果编排要求按 App 当前 `product_key.jd.mode` 读配置，需要把接线文件加进 paths，并改 cards / agent 用例的夹具。
2. 目录卡缺 `price_spec_hint` 时，Agent 搜索卡给 `null`（按契约「Absent is read as null」照抄），不自行补成 spec_uncertain（#19）。
3. Agent 卡照抄任何目录值，包括 `price_from`（#17、#23）；只有目录判定本身不出 price_from（#1–#16 每处都断言不是 price_from）。
4. 用例不过 agent-stream 帧校验：CT-26v（Agent 卡 price_spec_hint）还没进本工作树的 contracts，过校验会让实现在契约合并前失败。
