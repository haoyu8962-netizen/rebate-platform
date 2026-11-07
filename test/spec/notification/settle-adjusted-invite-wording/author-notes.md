# B1-12zd 规则测试作者说明（D10-803、D10-816 ①；08 BR-TEXT-01 收益术语唯一含义）

依据：任务书 §9.1 / §9.2。邀请分佣（direct / indirect）叫「推广收益」，「邀请奖励」只指 BR-INV 邀请双方活动；
SETTLE_ADJUSTED 邀请变体标题改「推广收益已调整」，正文改「一笔推广收益已按结算金额调整，减少 {amount}」；
自购 / 分享两行、变量、J7 不带原因、跳余额流水都不变。规则原文、契约与任务书之间未见冲突。

## 新用例（settle-adjusted-invite-wording/wording.test.ts，只用顶层 it）

| 编号 | 钉住什么 |
| --- | --- |
| #1 | `contracts/texts.default.json` 的 `inbox.title.SETTLE_ADJUSTED.invite` 为「推广收益已调整」，self / share 不变，三键都不含「邀请奖励」 |
| #2 | direct 负差：标题与正文逐字、不带原因、跳余额流水、不含订单号 |
| #3 | indirect（PRICE_PROTECT）负差：同一邀请行，正文不带「：商家价保退差」 |
| #4 | 两种上级 × 三种 sub_type × 三个金额 × 无覆盖 / 覆盖全空：标题与正文逐字，都不含「邀请奖励」 |
| #5 | 只改邀请行：自购 / 分享两行原样 |
| #6 | 邀请行只覆盖正文时标题回退新默认；只覆盖标题时正文回退新默认句 |

骨架：`clawback-message.ts` 已有 B1-12zc 的完整实现，本任务不加新导出，未动骨架文件与 `texts.default.json`；
新用例在基线上红在断言（旧措辞）。

## 冻结用例改动（照 D10-327，只改邀请行期望，不改其他行、不削弱断言）

1. `test/spec/contracts/settle-adjusted-template/kit.ts`：`titles['inbox.title.SETTLE_ADJUSTED.invite']`
   「邀请奖励已调整」→「推广收益已调整」。
2. `test/spec/notification/clawback-message/kit.ts`：`TITLES.SETTLE_ADJUSTED.invite` 同上；
   `settleBody.invite`「一笔邀请奖励已按结算金额调整，减少 ${amount}」→「一笔推广收益已按结算金额调整，减少 ${amount}」。
3. `test/spec/notification/settle-adjusted-message/render.test.ts`：
   - #32 用例标题里的两处引文（正文句、标题）与期望 `title`、`body`；
   - #33 期望数组的第三句（邀请句）；
   - #36 两条邀请行（invite 覆盖正文、两项覆盖都为空）的期望 `title`，以及后者的期望 `body`。

测试第 2 轮（§9.4，照 D10-657 / D10-737 拆表）：render.test.ts 原 `[AC-B1-12zc#36] 标题与正文分别覆盖、分别回退：$label` 表只留 self、share 两行（字面量、标题模板、回调体与 HEAD 逐字相同），两条邀请行移到紧随其后的新表 `[AC-B1-12zc#36] 标题与正文分别覆盖、分别回退（邀请行）：$label`，回调体相同，期望为新措辞；其余未动。

测试第 3 轮（§9.5）：wording.test.ts 的 [AC-B1-12zd#4] 循环是 2 种上级 × 3 种 sub_type × 3 个金额 × 2 种覆盖 = 36 次，原断言 `toHaveLength(24)` 计错、任何实现都过不了，只把它改为 `toHaveLength(36)`；其他断言与文件未动。
