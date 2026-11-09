# B1-12ze 规则测试作者说明（D10-1183、D10-1189；08 BR-TEXT-23 APPEAL_RESULT）

依据：任务书 §9.2。target_type=order 的 order_revoked 与 upheld 站内信落地 `OrderDetail { order_id: 载荷 target_id }`，
写入 inbox_messages.route（jsonb）；账户申诉仍为空；blocked_request 仍不发；模板不能覆盖渠道与路由；文案不变。
规则原文、契约与任务书之间未见冲突。期望落地写在 `routes.ts`（无导入），不读实现。

## 新用例（只用顶层 it，订单 target_id 用与 user_id 不同的随机 UUID）

| 编号 | 文件 | 钉住什么 |
| --- | --- | --- |
| #1 | render.test.ts | 订单 revoked / upheld × need_reauth：route 逐字为 OrderDetail{order_id: target_id}，不带 user_id、appeal_id |
| #2 | render.test.ts | 有标题与正文覆盖时订单行仍落地本单、仍只站内 |
| #3 | render.test.ts | 同一用户两笔订单各落自己的单，账户申诉为 null |
| #4 | delivery.int.test.ts | 持久化的 route 恰为 OrderDetail{order_id: target_id}，日志只有 inbox success |
| #5 | delivery.int.test.ts | 模板配 Wallet 路由与 push / sms 渠道时，订单行仍落本单、只发站内 |
| #6 | delivery.int.test.ts | 同一用户账户信 route 为空、订单信落本单 |

骨架：`appeal-result-message.ts` 已有 B1-12p 完整实现，本任务未改；新用例在基线上红在 route 断言（基线恒为 null）。

## 冻结用例改动（照 D10-327 / D10-1189，只收紧 route 期望，标题与其余断言不动）

在回调里按 `row.target_type` 取期望：订单行 `{ route: 'OrderDetail', params: { order_id: <事件 target_id> } }`，账户行 `null`。

1. `appeal-result-message/render.test.ts` [AC-B1-12p#1]：先把 `payload(row)` 存为 `input`，期望用 `input.target_id`。
2. `appeal-result-message/templates.int.test.ts` [AC-B1-12p#18]、[AC-B1-12p#21]：先把 `f.event(...)` 存为 `received`（参数不变），期望用 `received.payload.target_id`。
3. `appeal-result-message/delivery.int.test.ts` [AC-B1-12p#8]：期望用已有的 `received.payload.target_id`。

fixtures.ts、consumer.int.test.ts、db-kit.ts 未动。
