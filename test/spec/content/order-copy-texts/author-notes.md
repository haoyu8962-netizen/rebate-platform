# CT-26zk 规则测试说明（D10-1248 ⑨、D10-1275 / D10-1276）

## 键名与原句

| 键 | 默认文案 | 依据（SPEC_REF fd92f360e7b8） |
| --- | --- | --- |
| `order_list.copy_label` | 复制 | 08 BR-TEXT-14 细则表 C「订单行的复制按钮」行，文案列「复制｜复制订单号 {no}」的前半；copy_label 是看得见的按钮文字 |
| `order_list.copy_spoken` | 复制订单号 {no} | 同一行文案列的后半；copy_spoken 是读屏名称，`{no}` 为本行完整订单号 order_no，不缩写、不脱敏（03 §10.5 ②） |

- 「｜」是表格里分隔两键文案的记号，不进文案；「订单号」与 `{no}` 之间是一个半角空格，与 08 原文一致。
- 订单列表与订单详情共用这两键（测试核对没有另起 `order_detail.copy_label` / `.copy_spoken`）；复制成功的提示仍用 `order_detail.copy.done`「已复制订单号」，原样保留。

## 归类（08 BR-TEXT-12 细则「资金术语键」）

- 08「普通」一句逐键写明「2026-11-12 新增的 `order_list.copy_label`、`order_list.copy_spoken`（D10-1275）……也归普通」→ 两键逐键列进 `ordinary.keys`，不加 `order_list.` 前缀。
- `{no}` 不是金额变量，两句不用术语表用户词、不含关键词 → 不命中关键词核对，不进 `exempt`（进了 checkFundTermDoc 会报「remove it」）。

## 不在本单范围

- 各端换用新键由 fe 另做。
- `fund-term-keys.gen.ts` 须由生成脚本按 YAML 重新生成（测试核对两者一致）。
- 08 没给 `copy_spoken` 的「变量缺失时」默认，测试不要求也不禁止 `fallbacks` 条目。
