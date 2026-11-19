# B2-02z 规则测试作者说明（claude-independent；D10-2092 ⑤、D10-2093、D10-2097、D10-2084、D10-2115）

依据：任务书 §2（BR-FUND-24 ⑦⑧ 摘录、BR-TEXT-10 细则 App 表与算法）、§9；`contracts/openapi.yaml`
recalcBalanceAdminReconDiff「Member notice」与 adminListNotifyChannels「只发站内信」一组；
`contracts/texts.default.json` 的 `inbox.title.BALANCE_CORRECTED`「余额更正」。规则原文、契约与任务书之间未见冲突。

导入方式：规则测试一律**直接从文件导入**（`application/balance-corrected-message.ts`、
`application/balance-corrected-message-record.ts`、`admin-channels/catalog.ts`、`admin-channels/view.ts`），
不经 `notification/index.ts`；index 导出与 app.module 接线由实现方做，本目录不钉。

## 用例

| 编号 | 文件 | 钉住什么 |
| --- | --- | --- |
| #1 | render.test.ts | 默认标题「余额更正」、默认正文逐字（调增、调减各一条） |
| #2 | render.test.ts | 8 组手写向量（调增、调减、调到负数、-150 → -¥1.5、0 → ¥0、不加千分位、负数之间）+ 属性测试（任意前后金额按 BR-TEXT-10 App 写法） |
| #3 | render.test.ts、record.int.test.ts | 前后相等 → 渲染 null（有覆盖行也一样，属性测试）；写入函数返回 false、两张表无行 |
| #4 | render.test.ts、record.int.test.ts | 覆盖标题 / 正文替换措辞，{before} {after} 照替换（顺序可换、出现几次换几次）；`$&` 等照字面（属性测试）；只覆盖其一时另一项用默认；写入读本 app 的覆盖行，别的 app 的不用 |
| #5 | render.test.ts | code BALANCE_CORRECTED、variant default、category service 恒定（属性测试） |
| #6 | catalog.test.ts、channels.int.test.ts | catalog：inboxOnly、默认渠道只有 inbox；view.itemOf 与后台入口列表：push_switchable / sms_switchable 为 false、无短信行、disabled；开推送、开短信 → 20001 notify_channel_locked、不写 |
| #7 | record.int.test.ts | users.status deleting、deleted 不写（it.each 两条）；cooling 申请 + status normal 照写；同一事务里未提交的 status=deleting 也不写（证明在调用方事务里读） |
| #8 | record.int.test.ts | 一条 notify_logs（inbox、success、去重键 `balance_corrected:{reconDiffId}:{balanceVersion}`、sent_at 非空）+ 一条站内信（created_at = now、read_at null）；没有推送 / 短信行；同一键同事务连调与另一事务再调都返回 false 且不多写；同一差异单新余额版本另写一条 |
| #9 | rollback.int.test.ts | 调用方回滚 → 两张表无行，之后同一键照常写入；写入后调用方后续步骤失败 → 整笔回滚 |

期望文案全部在 `texts.ts` 里按规则手写（含按 BR-TEXT-10 算法另写的 `appYuan`），不读实现。所有 it 顶层、无 describe，
显式超时 `900_000`；属性测试用 `propParams()`。骨架上：渲染与写入用例红在 `NotImplemented`，#6 红在断言（目录还没有这一行，
列表按存量渠道推出 push / sms 可开）。

## 骨架

- `application/balance-corrected-message.ts`：`BALANCE_CORRECTED_CODE`、`renderBalanceCorrectedMessage(facts, override)`
  （抛 NotImplemented）与类型 `BalanceCorrectedFacts { before_fen, after_fen }`、`BalanceCorrectedOverride`、`BalanceCorrectedMessage`。
- `application/balance-corrected-message-record.ts`：`recordBalanceCorrectedMessage(trx, input)`（返回 rejected Promise）与
  `BalanceCorrectedRecordInput { appId, userId, reconDiffId, balanceVersion: number, facts, now }`。

## 给实现者

- catalog 加 `BALANCE_CORRECTED: { defaultChannels: INBOX, inboxOnly: true, variables: {} }`（与 BALANCE_ADJUSTED 同形；
  短信变量为空，因为它不发短信）。
- 会员状态只按 users.status 判（deleting、deleted 不写），在调用方事务里读，不看 deletion_requests。
- 写入照 balance-adjusted-message-record.ts：先读覆盖行，ON CONFLICT (app_id, dedupe_key) DO NOTHING 再写站内信。
