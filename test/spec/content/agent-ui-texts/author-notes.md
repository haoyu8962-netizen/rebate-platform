# CT-26zn 规则测试说明（C4b，D10-1315 ②(a)、D10-1354）

## 依据（SPEC_REF 62b5c99338f8）

- 08 BR-TEXT-14 细则表 C 第八批 15 行（「AI 助手·对话页骨架」至「AI 助手·举报半屏的校验与操作失败」）：
  `kit.ts` 的 `tableRows` 逐字抄「场景」列里的键名写法与「文案」列；键名按 `a.b.c / .d` → `a.b.d` 展开
  （分隔符「 / 」与「、」），文案按「｜」切开，与键一一对应，共 53 个键。
- 08 BR-TEXT-12 细则「资金术语键」：逐键列出归普通的 52 个键（`ordinaryKeys`，顺序同 08）；
  `agent.earnings.updated_at` 在 `agent.earnings.` 前缀内，归资金术语。测试 #1 核对表 C 展开的键与这 53 个键是同一组。

## 测试取的「动作」列细节（同在 BR-TEXT-14 表 C）

- `agent.earnings.updated_at`：画板示例「更新于 10:03」，`{time}` 只显示时刻，不加「今天」「昨天」与日期（#5）。
- 次数用完三句不写数字（额度数值只在 BR-AI-15）；`agent.report.too_long` 不写数字（上限随契约）；
  `agent.too_long` 的 500 是 BR-AI-23 ⑤ 的上限（#6）。
- 键名沿用客户端 `agent.draft.*` 的后缀并去掉 `.draft` 一段，字典里不留 `agent.draft.*`（#7）。

## 归类

- 52 个普通键逐键列在 `ordinary.keys`，不加 `agent.report.`、`agent.quota.` 一类整前缀（08 逐键写，整前缀会吞掉以后的资金术语键）。
- `agent.earnings.updated_at` 由已有的 `fund_terms.prefixes` 里的 `agent.earnings.` 覆盖，不单列
  （单列会被 checkFundTermDoc 报 already covered by a prefix）。
- 53 句都不命中关键词核对（无金额变量，`{q}`、`{time}` 不是金额；无术语表用户词与关键词），都不进 `exempt`。

## 不在本单范围

- 客户端换键由各端另做；`fund-term-keys.gen.ts` 须由生成脚本按 YAML 重新生成（#12 核对两者一致）。
