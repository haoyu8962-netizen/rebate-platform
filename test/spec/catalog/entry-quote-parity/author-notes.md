# B1-05zc 规则测试 author-notes

规则：D10-641（规划变更记录 `20261105-返利按接口实际金额展示`），BR-PRICE-07、BR-CALC-16、BR-TEXT-03（下单前部分），BR-PRICE-17、BR-CALC-20。作者：新鲜独立 Claude（第 1 次）。没有 shell，`pnpm typecheck`、`pnpm lint`、先红都没跑过，全部由编排者跑。编排给的 `inventory.md` 在本会话的受限文件工具之外读不到，清单由作者按 `test_paths` 逐文件 grep 自行重做（见文末「对账」）。

口径：同一淘宝商品 券前 3990、券 1000、券后 2990、佣金率 2000bp（BR-CALC-20 例子），技术服务费 10%、预留 0、本人 50%：N = 598 − 59 = 539，本人 **269**，预估返后价 2990 − 269 = **2721**；旧区间下限是 135。真实 commission 报价器与演示报价器各跑一遍，两份配置都故意带 `rebate.taobao.compare_rate_ratio_bp = 5000`。

## 新增（`test/spec/catalog/entry-quote-parity/`）

| 文件 | 用例 | 钉什么 |
| --- | --- | --- |
| entries.test.ts | #1 | 搜索（`searchProducts`）、粘贴（`createParsing().parseInput`）、首页池（`getSectionItems` product_pool）、详情（`getProduct` 无来源）四个入口同额单值：`normal`、269–269、2721、`['price_basis','rebate_estimate']`；四次报价 context 都是 normal；不读比价键；entry_source 分别记 search / parse / feed / detail |
| entries.test.ts | #2 | 热销榜（`getHotRank`）同上，entry_source 记 rank |
| entries.test.ts | #3 | Agent `get_rebate_quote`（`createLinkQuoteRunner`）同额单值，小字含 rebate_estimate、不含 rebate_compare，entry_source 记 agent |
| entries.test.ts | #4 | 带 from_link_id 的详情：来源卡 search / parse / agent / agent_refresh / feed / watch / null 一律单值，来源照常读（APP_ID, from_link_id）并继承登记 |
| quoters.test.ts | #5 | 两个报价器收到 `price_compare_risk` context（淘宝、京东、拼多多）一律 `TypeError` 拒绝，不读比价键 |
| quoters.test.ts | #6 | 两个报价器省略 context（游客自购、无来源）报淘宝也是单值 269–269 |
| quoters.test.ts | #7 | 比价键 5000 / 2500 / 0 / 缺失 / 字符串 / 越界：淘宝搜索卡都是同一张单值卡，不拒绝报价，不读该键 |
| quoters.test.ts | #8 | `COMMISSION_QUOTE_CONFIG_KEYS`（open 预读用）恰为 commission.platforms、tech_fee_bp、两个 pdd 系数 |
| open-requote.int.test.ts | #9 | 淘宝搜索卡打开复核（linking 真实库）：new_rebate_min/max 都是 '269'，报价 context normal，不读比价键 |

支撑：`kit.ts`（两个报价器、配置、期望值）、`entries.ts`（各入口的驱动，其余端口复用各入口现有 kit，未改它们）。

## 作者定下的取值

1. 报价器收到 `price_compare_risk` 抛 `TypeError`（与现有「未知口径」「京东拼多多不许区间」同类，也与冻结用例 AC-B2-03c#23 一致）；演示报价器同样拒绝。
2. 省略 context 的淘宝报价按 normal 单值（两报价器）。
3. 比价键缺失或格式错不拒绝报价，也不能读它（D10-641「不再读」；配置项在 content 注册表保留，content 自己的注册表用例已钉，这里没再钉）。
4. 演示报价器的 open 预读键恰为 `[ruleKey, 'tech_fee_bp']`（commission/wiring/assembly #1）。
5. CardQuoteContext 仍带 `rebateBasis`（新用例只断言它为 normal，用 objectContaining，不钉其余字段）。

## 改动清单（冻结用例）

| 文件 | 用例 | 改前 | 改后 | 为什么 |
| --- | --- | --- | --- | --- |
| commission/quoter/fixtures.ts | 支撑 | `CONFIG_KEYS: COMMISSION_QUOTE_CONFIG_KEYS` 含比价键；`COMPARE satisfies CommissionQuoteContext` | `CONFIG_KEYS` 去掉比价键、不再标类型（as const）；`COMPARE` 改 `as unknown as`；配置里的比价 5000 保留并注明故意 | 预读键作废；类型实现后才收窄 |
| commission/quoter/quotation | AC-B2-03c#6 | COMPARE 报 212–426 区间 | COMPARE 被 `TypeError` 拒绝，不读比价键 | 区间算法作废 |
| commission/quoter/quotation | #7 | COMPARE 报 0–1 区间 | 无 context 报 1–1、返后 2、normal，不读比价键 | 零下限区间作废 |
| commission/quoter/quotation | #8 | COMPARE 走到 no_rebate | 无 context 走到 no_rebate，并断言不读比价键 | COMPARE 现在被拒；钉「不读」 |
| commission/quoter/quotation | #10 | 淘宝无 context 250–500 price_compare_risk | 淘宝 500–500 normal，不读比价键；京东拼多多不变 | 无来源不再判风险 |
| commission/quoter/quotation-r2 | #39 | 比价系数先乘佣金率，987–1976 | 无 context 与 search normal 都 1976–1976、返后 18024；系数改 2500 不变；COMPARE 拒绝；不读比价键 | 系数作废 |
| commission/quoter/failures | #19 | 5 行，淘宝行用 COMPARE；缺比价键要拒绝 | 4 行，淘宝行改 NORMAL；另起一条同号：缺比价键时无 context 与 search normal 都报 500–500 | 缺这个键也不拒绝报价 |
| commission/quoter/failures | #20 | 比价键与两个 pdd 系数非法都拒绝 | pdd 两键照旧拒绝；比价键非法时淘宝无 context 仍报 500–500 | 比价键不再读 |
| commission/quoter/failures | #23 | 京东、拼多多 COMPARE 拒绝 | 加淘宝行 | 淘宝也没有区间了 |
| commission/wiring/assembly | AC-B2-03d#1 | 演示预读 `[rule, tech_fee, 比价键]`，真实预读 5 键 | 演示 `[rule, tech_fee]`，真实 4 键；另断言预读不含比价键 | DEMO_QUOTE_KEYS / COMMISSION_QUOTE_CONFIG_KEYS 去掉比价键 |
| catalog/card/kit.ts | 支撑 | `quote()` 默认 211–433 price_compare_risk；fixture normal 才回 433–433 | `quote()` 默认 433–433 normal；新增 `compareQuote(金额覆盖)`（旧 211–433 区间，`as unknown as RebateQuote`），fixture 对非 normal 请求回它 | 报价端口的正常答复是单值；仍问风险口径的旧代码会拿到区间而红；类型实现后可能收窄 |
| catalog/card/assembly | AC-B1-05f#1 | 211–433、context risk、rebate_compare | 433–433、返后 9567、context normal、disclaimer 恰为 `[price_basis, rebate_estimate]` | 淘宝搜索卡单值 |
| catalog/card/assembly | #3 | 第二次报 101–203；context risk；first.min 211 | 第二次替身按口径答：normal 回 203–203、返后 9797，其余回旧 101–203 区间（`compareQuote`）；期望 context normal、first.min 433 | 同上；替身按口径答，现实现红在断言而不是 card-assembler 的「basis differs」TypeError（第 2 次修正） |
| catalog/card/assembly | #7 | 0–1 区间保留 | 报价端口回 price_compare_risk 0–1（`compareQuote`）时拒绝出卡、不登记 | 区间不再出卡 |
| catalog/card/source | #12 | 各来源按表判 normal / risk，min 433 / 211 | 一律 normal，min 433；标题改为 `%s` | 来源不再判风险 |
| catalog/card/source | #13 | 继承来源按表判 | 继承来源照常读与登记，报价一律 normal；标题改为 `%s` | 同上 |
| catalog/card/source | #14 | 换来源 risk 211 与 normal 433、rebate_compare | 两次都 433–433、rebate_estimate，各自重新报价（context entrySource search、pool） | 同上 |
| catalog/card/source | #15 | 读不到来源 → risk | 读不到来源登记 null，报价 normal 单值 | 同上 |
| catalog/card/demo-quote | 模块常量 `context` | rebateBasis price_compare_risk | rebateBasis normal（search）；加 `COMPARE_KEY` 常量、配置注明故意 | 卡片不再请求风险口径 |
| catalog/card/demo-quote | #16 | context risk，212–426、返后 9791、读比价键 | 无 context，426–426、返后 9577、normal、不读比价键 | 区间作废 |
| catalog/card/demo-quote | #19 | 改比价键 2500 使下限变 250 | 无 context 1000–1000；改比价键 2500 加改规则 50% 后 500–500；不读比价键 | 比价键不影响金额 |
| catalog/card/demo-quote | #21 | 0–1 区间、返后 1 | 无 context 1–1、返后 0、normal | 零下限区间作废 |
| catalog/card/contract | AC-B1-05f#22 | 普通、区间、零下限区间、无返利 | 普通、1–1 单值、无返利 | 区间卡不再出 |
| catalog/price-state/cards | AC-B1-05i#5 | 淘宝 rebate_compare | 三平台都 rebate_estimate | BR-PRICE-17 |
| catalog/price-state/cards | #6 | 登记 211–433 price_compare_risk | 登记 433–433 normal | 粘贴卡单值 |
| catalog/price-state/disclaimer | AC-B1-05i#10 | search 行 risk + rebate_compare | search、parse 行 normal + rebate_estimate；标题加 `$source` 防重名 | 同上 |
| catalog/search/refill | AC-B1-05d#14 | 0–1 区间保留 | 1–1 normal 保留，max=0 仍过滤 | 区间作废 |
| catalog/detail/detail | AC-B1-05e#1 | 135–269 price_compare_risk，登记 135–269 | 269–269 normal，登记 269–269 normal | 无来源详情单值 |
| catalog/detail/detail | #8 | 来源表判 normal 269 / risk 135 | 一律 normal 269–269，来源照常继承登记 | 来源不再判风险 |
| catalog/detail/detail | #9 | 无来源详情按 risk | 按 normal 单值，登记 detail，不读来源链接 | 同上 |
| catalog/detail/route.int | AC-B1-05e#18 | 详情 rebate_basis price_compare_risk，金额抄搜索卡 | 搜索来源卡与详情都 normal、min = max，含 rebate_estimate、详情不含 rebate_compare；配置里的比价 5000 保留 | 同上 |
| catalog/product-pool-read/detail-fallback.int | 回退沿用来源卡（search 行） | price_compare_risk 135 | normal 269 | 同上 |
| catalog/product-pool-read/detail-fallback.int | 无来源卡回退 | price_compare_risk 135–269 | normal 269–269 | 同上 |
| catalog/hot-rank-viewer/app.int | `GUEST_REBATE` | 299–598 | normal 598–598（比价 5000 仍在库里） | 热销榜单值 |
| catalog/hot-rank-upstream/kit.ts | 支撑 | 报价替身 10–20 | 20–20 | 单值；该 kit 的用例不断言金额，实现前后都不受影响 |
| agent/tools-quote/snapshots | AC-B3-04c#21 | 淘宝报价替身回 0–137 risk，卡保留区间 | 替身只对风险请求回 0–137（`as unknown as RebateQuote`），对 normal 回 137–137；卡 normal 137–137、返后 2853、rebate_estimate、无 rebate_compare，context entrySource agent / normal | Agent 卡单值（BR-AI-04 细则） |
| linking/open-requote/prices.int | AC-B1-06k#6 | 替身回 180–180 price_compare_risk | 回 180–180 normal；加 requote_failed:false 与末次报价 context normal | 复核卡单值 |

## 需要编排用 red_exempt 声明的

现实现上仍是绿的改过用例（只改数据或只改了不影响现结果的行）：quotation #10 的京东、拼多多行；failures #19 的四行（淘宝行由 COMPARE 改 NORMAL，现实现照旧因缺键拒绝）；source #12 的 feed、pool、tlj_pool 行，#13 的 pool、feed、tlj_pool、share_panel、share_landing 行；detail-fallback 的 feed 行；contract #22。（price-state cards #5 京东拼多多、disclaimer #10 feed 与 no_rebate、detail #8 feed / pool / tlj_pool / share 第 3 次已恢复成与基线逐字相同，不再是改过的用例，见下。）

支撑文件连带（用例体没改）：
- card/kit.ts → assembly #2 在现实现上红在断言（登记的 quote 现在是 compareQuote）；assembly #5 第 3 次起在现实现上**照旧绿**（报价端口包装把替身的 normal 单值按现实现请求的 risk 口径答回，见第 3 次第 3 条），实现后仍绿；assembly #4、#6（上限 0 先于口径核对判 no_rebate）、#8、#9、#10、#11、#24 与 shop-name/catalog.test.ts（test_paths 外）不受影响。
- linking/open-requote/prices.int #6：替身固定回 normal，现实现请求 risk 被 card-assembler 拒绝，但 open 复核捕获后答 requote_failed=true，所以红在断言。
- quoter/fixtures.ts 的 `CONFIG_KEYS` → **commission/wiring/open-quotes.test.ts AC-B2-03d#4（台账第 2 次已加进 test_paths，用例体没改）在现实现上红**（预读仍含比价键），实现后转绿；不改 CONFIG_KEYS 的话该用例实现后会永远红。
- demo-quote 的模块常量 `context` 改 normal → #18、#20、#23 与 #21 的零上限半段现实现照旧绿。

## 第 2 次复核（只修错漏）

- assembly #3：第 1 次把第二次报价改成固定 normal 203–203，现实现请求 risk 会在断言前抛「basis differs」TypeError（不算合格的红）；改为按口径答。
- 测试里写成 `RebateQuote` 类型的 `price_compare_risk` 字面量（card/kit.ts、assembly #3 #7、snapshots #21）一律经 `as unknown as` 转，实现收窄报价类型后 tsc 仍过。
- entry-quote-parity 复核：各入口驱动只替换报价端口，其余端口沿用各入口 kit；commission 报价器本身不经 open 预读包装（包装在 app.module），#9 里直接读配置替身；未改。

## 第 3 次（按先红 red/1 的结论，只改三处）

1. commission/quoter/failures：[AC-B2-03c#19]「缺少比价键不拒绝报价」与 [#20] 各行的淘宝单值报价不再用 `.resolves`（现实现的拒绝经它冒出时被判成普通 Error 的红），改经同文件的 `settled()`：拒绝折成字符串 `'rejected'`，再用 `toEqual` 比单值；#19 两次报价收进数组一起比 `[single, single]`。现实现红在 `toEqual` 断言，实现后绿。期望值未变。
2. 恢复成与基线逐字相同（标题、用例体、行值都同 base；只把改了期望的行拆到新的用例里）：
   - detail/detail [AC-B1-05e#8]：原表原标题原用例体只留 feed、pool、tlj_pool、share 四行；search、parse、agent、null 四行另起 `it.each`，标题「…继承登记，报价一律单值」，期望 normal 269–269（现实现红在断言）。
   - price-state/cards [AC-B1-05i#5]：jd、pdd 两行回原标题原用例体（表写成 `it.each<(typeof PLATFORMS)[number]>(['jd', 'pdd'])`，保持原用例体里 `platform === 'taobao'` 的类型可比）；taobao 另起 `it.each(['taobao'] as const)`，标题加「（单值，rebate_estimate）」，期望 rebate_estimate。
   - price-state/disclaimer [AC-B1-05i#10]：feed normal、search no_rebate 两行回原表原标题原用例体；search、parse 两行另起 `it.each`，标题「已有出卡器的 %s 来源 normal …（单值，rebate_estimate）」，用例体去掉 no_rebate 分支，期望 normal + rebate_estimate。
3. catalog/card/kit.ts：fixture 交给出卡器的报价端口包一层 `answerRequestedBasis`：`quoted` 替身（含用例用 `mockResolvedValue` / `mockImplementation` 设的答复）回 normal 时，对 normal 请求原样返回，对其他口径（仍请求 price_compare_risk 的现实现）按所请求口径、原金额返回；非 normal 答复（compareQuote、no_rebate）原样透传。默认替身照旧按口径答（normal → `quote()`，其他 → `compareQuote()`），口径改经 `requestedBasis()` 宽松读取（实现收窄类型后 tsc 仍过）。效果：assembly #5（用例体未改）在现实现上照旧绿、实现后绿，请用 red_exempt 声明；#6、#7、#8、#11、contract #22、source、shop-name 的结果不变（#7 现实现仍红在断言，实现后报 basis differs 被拒而绿）。`f.quoted` 的调用记录不变。

## 第 4 次（D10-657：基线块原样保留、表只删行，删掉的行另起新用例）

基线 = `c7af2517b321`（原文按本会话可读的 diff 还原；作者无 shell，没跑 `git show`，请编排逐字对一遍）。下列「新用例」在旧实现上都红在所列断言，不是红在类型、导入或冒出的异常。

| # | 文件 / 用例 | 基线块保留的行 | 新用例（标题） | 旧实现上红在 |
| --- | --- | --- | --- | --- |
| 1 | detail/detail [AC-B1-05e#8] | feed、pool、tlj_pool、share（第 3 次已是，未再动） | 「来源卡 %s 经 SourceLinkReader 按 App 范围读取并继承登记，报价一律单值」：search、parse、agent、null | `expect(card).toMatchObject({ rebate_basis: 'normal', rebate_min_fen: 269, … })`（旧：price_compare_risk、135） |
| 2 | price-state/disclaimer [AC-B1-05i#10] | normal/feed 行、no_rebate/search 行（第 3 次已是，未再动） | 「已有出卡器的 %s 来源 normal 有券/无券口径键精确且顺序不变（单值，rebate_estimate）」：search、parse | `expect(result).toMatchObject({ value: { rebate_basis: 'normal', disclaimer_keys: [..., 'rebate_estimate'] } })`（旧：price_compare_risk、rebate_compare） |
| 3a | card/source [AC-B1-05f#12] | 恢复基线标题「淘宝无预判结果，$source 按 $basis 报价」与用例体，表只留 feed、pool、tlj_pool 三行 | 「淘宝 %s 来源一律按 normal 单值报价」：parse、search、agent、agent_refresh、detail、watch、null、unknown_source，期望 normal、433–433 | `expect(f.quoted).toHaveBeenCalledExactlyOnceWith(…, { rebateBasis: 'normal' })`（旧请求 price_compare_risk） |
| 3b | card/source [AC-B1-05f#13] | 恢复基线标题「…继承服务端来源 $origin」与用例体，表只留 pool、feed、tlj_pool、share_panel、share_landing | 「…继承服务端来源 %s 登记，报价一律 normal」：search、parse、agent、null | 同上一条 |
| 4 | product-pool-read/detail-fallback.int「回退出卡沿用来源卡」 | 表只留 feed 行（标题、体同基线；基线块前的注释改写，去掉 search 走风险的说法） | 「[BR-PRICE-07][TRADE-12] 回退出卡沿用来源卡：from_link_id 的入口是 search → rebate_basis=normal 单值，链接记 search」 | `expect(card).toMatchObject({ rebate_basis: 'normal', rebate_min_fen: 269, … })`（旧：price_compare_risk、135） |
| 5 | commission/quoter/quotation [AC-B2-03c#10] | 恢复基线标题与用例体（含淘宝 250–500 分支），表 `['jd', 'pdd'] as const` | 「省略 context 时淘宝按游客自购和无来源语义报价，单值 500–500、不读比价系数」 | `toEqual({ 500n, 500n, 9500n, 'normal' })`（旧：250–500 price_compare_risk） |
| 6a | commission/quoter/failures [AC-B2-03c#19] | 恢复基线标题与用例体（含 `platform === 'taobao' ? COMPARE : NORMAL`），表只留两条 pdd 行 | 第 3 次的「缺少比价键不拒绝报价」并入新标题「淘宝缺少 commission.platforms / tech_fee_bp 仍拒绝报价；缺少 rebate.taobao.compare_rate_ratio_bp 不拒绝…」：先用 NORMAL 断言缺这两键各自仍拒绝（旧实现照样拒绝，通过），再断言缺比价键时无 context 与 search normal 都报 500–500 | `expect(outcomes).toEqual([single, single])`（旧：无 context 走风险口径读比价键，缺键被拒，折成 `'rejected'`） |
| 6b | commission/quoter/failures [AC-B2-03c#23] | 恢复成与基线完全一样（表 `['jd', 'pdd'] as const`） | 「BR-PRICE-07 淘宝也不允许比价区间：price_compare_risk 口径拒绝报价」 | `.rejects.toThrow(TypeError)`（旧实现报出区间，promise resolve，判断言失败） |
| 7 | price-state/cards [AC-B1-05i#5] | 基线是 `it.each(PLATFORMS)`（导入常量），不能保留成删行块；第 3 次的 jd/pdd 块删去 | 「新用例：$0 与同入口同券况的淘宝卡小字键一致，口径键排首位、返利小字均为 rebate_estimate」：jd、pdd 各两入口 × 有券/无券，每种情况再出一张淘宝卡，两张卡都期望 `[price_basis 或 price_basis.general, 'rebate_estimate']`。第 3 次的 taobao 单行新用例保留；文件不再用 `PLATFORMS`，从 import 删掉 | 淘宝卡那次 `expect(result).toEqual({ …, disclaimer_keys: expected })`（旧：rebate_compare） |
| 8 | card/contract [AC-B1-05f#22] | 无（基线块用的 `quote()` 默认值已随 kit 改，不能原样保留）；标题加「，淘宝搜索卡为单值」 | 同一用例末尾：新 fixture 用默认报价替身出淘宝 search 卡，先过 ProductCard 契约，再断言 normal、min = max、含 rebate_estimate、不含 rebate_compare | `expect(search).toMatchObject({ rebate_basis: 'normal', rebate_min_fen: search.rebate_max_fen })`（旧：price_compare_risk、211–433；旧卡也合契约，所以契约那句先过） |

类型说明（第 5、6a 条）：只剩 jd / pdd 行时，原用例体里 `platform === 'taobao'` 是 TS2367（类型不重叠），所以这两块的 `it.each` 加了类型实参 `it.each<(typeof PLATFORMS)[number]>(…)`、`it.each<MissingKeyRow>(…)`（`MissingKeyRow` 是同文件新加的 interface，platform 取三平台联合）。标题模板、回调参数与体、表的每行都与基线逐字相同；只有 `it.each` 后的类型实参不同，请编排确认 CT-06zzze 是否接受。

red_exempt 更新（取代上文「需要编排用 red_exempt 声明的」第一段）：按 `red_exempt_rows` 声明的删行基线块：detail #8 四行、disclaimer #10 两行、source #12 三行与 #13 五行、detail-fallback feed 行、quotation #10 jd/pdd、failures #19 两条 pdd 行。failures #23 基线块已与基线完全一样，不是改过的用例。contract #22 现在在旧实现上红。支撑文件连带（assembly #5 等）同上文，不变。

## 第 5 次（D10-669：commission/quoter 两处删保留块，jd / pdd 断言并进淘宝新用例）

基线 = `a9b9c64afcf9`。第 4 次表里第 5、6a 条与上面的「类型说明」作废：两个带类型实参的保留块都已删掉，red_exempt_rows 里 quotation #10 jd/pdd、failures #19 两条 pdd 行不再需要声明。两条新用例在旧实现上照旧红在淘宝部分的断言；搬进来的 jd / pdd 断言在旧实现上本就通过，条数与取值不改。

1. `commission/quoter/quotation.test.ts`：删掉 `[AC-B2-03c#9]` 之后的 `it.each<(typeof PLATFORMS)[number]>(['jd', 'pdd'] as const)('[AC-B2-03c#10] 省略 context 时 $0 按游客自购和无来源语义报价', …)` 整块（连同上方两行注释），搬进「[AC-B2-03c#10] 省略 context 时淘宝按游客自购和无来源语义报价，单值 500–500、不读比价系数」末尾，jd、pdd 各放一个块作用域 `{ const f = fixture(); … }`：
   - 原文：`expect(await f.quoter.quote(item({ platform }), viewer())).toEqual(platform === 'taobao' ? {…} : { rebateMinFen: platform === 'pdd' ? 375n : 500n, rebateMaxFen: platform === 'pdd' ? 375n : 500n, estNetPriceFen: platform === 'pdd' ? 9625n : 9500n, rebateBasis: 'normal' })`
   - 搬后 jd：`expect(await f.quoter.quote(item({ platform: 'jd' }), viewer())).toEqual({ rebateMinFen: 500n, rebateMaxFen: 500n, estNetPriceFen: 9500n, rebateBasis: 'normal' })`
   - 搬后 pdd：`expect(await f.quoter.quote(item({ platform: 'pdd' }), viewer())).toEqual({ rebateMinFen: 375n, rebateMaxFen: 375n, estNetPriceFen: 9625n, rebateBasis: 'normal' })`
2. `commission/quoter/failures.test.ts`：删掉文件开头的 `interface MissingKeyRow`（只为该块存在）与 `it.each<MissingKeyRow>([{ key: 'union.pdd.self_buy_factor_bp', platform: 'pdd' }, { key: 'union.pdd.account_level_factor_bp', platform: 'pdd' }] as const)('[AC-B2-03c#19] 缺少 $key 时拒绝报价，不填默认值', …)` 整块，搬进「[AC-B2-03c#19] 淘宝缺少 commission.platforms / tech_fee_bp 仍拒绝报价；缺少 rebate.taobao.compare_rate_ratio_bp 不拒绝…」，放在淘宝两键循环之后、比价键部分之前，每行一个块作用域；块上方注释改写为覆盖全表：
   - 原文：`const f = fixture(); f.values.delete(key); await expect(f.quoter.quote(item({ platform }), viewer(), platform === 'taobao' ? COMPARE : NORMAL)).rejects.toThrow();`
   - 搬后（self_buy）：`const f = fixture(); f.values.delete('union.pdd.self_buy_factor_bp'); await expect(f.quoter.quote(item({ platform: 'pdd' }), viewer(), NORMAL)).rejects.toThrow();`
   - 搬后（account_level）：`const f = fixture(); f.values.delete('union.pdd.account_level_factor_bp'); await expect(f.quoter.quote(item({ platform: 'pdd' }), viewer(), NORMAL)).rejects.toThrow();`

两个文件的 `COMPARE`、`PLATFORMS` 导入仍被别的用例使用，所以保留。failures 里搬进来的 `await expect(…).rejects.toThrow()` 去掉三元后不到 100 列，按 prettier 合成一行，只是换行不同，内容一样。

## 第 6 次（D10-673：catalog/search 两条漏网冻结用例）

台账头 `ae9b994d8`。搜索 kit（`catalog/search/kit.ts`）的报价替身按请求口径作答：normal → min = max = 上限；风险口径 → min = 下限、max = 上限。D10-641 后搜索按 normal 请求，所以这两条的期望要跟着改成单值。kit.ts 与其他用例没动。下文「对账」原先把 availability.test.ts 列为不涉及口径，那句写错了，已从对账清单里删掉。

1. `catalog/search/availability.test.ts` [AC-B1-05d#29]「搜索开启但转链关闭时仍出卡；只登记链接和报价，不转链」：标题与其他断言不动。
   - 改前：`quote: expect.objectContaining({ rebateMinFen: 10n, rebateMaxFen: 20n })`
   - 改后：`quote: expect.objectContaining({ rebateMinFen: 20n, rebateMaxFen: 20n, rebateBasis: 'normal' })`
   - 为什么：下单前一律单值、口径 normal（D10-641）；旧实现请求风险口径，替身回 10–20、price_compare_risk，红在 `register` 的 `toHaveBeenCalledExactlyOnceWith` 断言。
2. `catalog/search/filter-sort.test.ts` [AC-B1-05d#7]：
   - 标题改前：「[AC-B1-05d#7] 返利排序用下限而非上限或佣金率，不请求联盟按返利排序」；改后：「[AC-B1-05d#7] BR-PRICE-15：返利排序按单值返利降序，不请求联盟按返利排序」。
   - `f.quotes.set` 三行不变（max-only 20–900、min-winner 30–40、zero-min 0–950）；按 normal 请求时替身回 900、40、950。
   - 期望顺序改前：`min-winner → max-only → zero-min`（按下限 30 > 20 > 0）；改后：`zero-min（950）→ max-only（900）→ min-winner（40）`。
   - `f.search` 只请求 `relevance` 的断言保留。
   - 为什么：min = max 以后没有上下限之分，排序就按单值返利（D10-641、BR-PRICE-15）；旧实现按风险口径取下限，排出 min-winner 打头，红在顺序的 `toEqual` 断言。

## 对账：test_paths 内没改的

`catalog/price-state/anomalies.test.ts` 与 `kit.ts`（kit 的替身按 context 回 433–433 / 211–433，已兼容）、`catalog/hot-rank-upstream/*.test.ts`、`commission/quoter/versions.test.ts`、`live-only/**`、`reader.int.test.ts`（都只用 NORMAL）。

test_paths 外仍出现旧口径字样的，都只在夹具里（配置行带比价 5000，或替身注入的 Agent 卡 / 登记入参带 price_compare_risk），没动：search-route/wiring、agent/tools-search/search、linking/promo-url/rules（Agent 工具侧放行代码不动）、各 int 夹具的配置行。
