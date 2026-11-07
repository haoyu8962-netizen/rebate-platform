# B1-12zc 规则测试作者说明（D10-773 方案 C；FU-CLAWBACK-NOTIFY 并入）

依据：08 12_TEXT BR-TEXT-09 表（l.600–602）与 l.611、细则「上级隐私」「频控与免打扰」例 5；BR-TEXT-05 原因表
（l.443–456）；BR-TEXT-10；06 BR-FUND-09 细则 l.651；`contracts/texts.default.json` 的
`inbox.title.CLAWBACK.self / .promo`、`inbox.title.SETTLE_ADJUSTED.self / .share / .invite`（CT-26za）。
规则原文、契约与本任务书 §9 之间未见冲突。

## 新用例

| 编号 | 文件 | 钉住什么 |
| --- | --- | --- |
| #1–#6 | clawback-message/render.test.ts | CLAWBACK 三个变体正文与标题逐字、{amount} 负值格式（-¥x）、邀请句不带原因、覆盖分别生效、跳转（自购 / 分享→OrderDetail，邀请→Ledger 无参数） |
| #10–#22 | clawback-message/delivery.int.test.ts | 真库：站内信 + notify_logs + 推送（提交后）；去重键 `{order_key}:{uid}:{role}:CLAWBACK:{rights_event_id}`；R9 无原因也发；上级隐私；重投与并发不重复；关「服务」推送只写站内信；只发事件列出的受益人；同一事务写、失败一起回滚；模板覆盖按 (app, code, variant) |
| #23–#25 | clawback-message/consumer.int.test.ts | 真 AppModule worker 装配：order.clawed_back 路由到 evt.notification-clawback，processed_events、关推送、失败回滚后重投 |
| #26–#27 | clawback-message/routing.test.ts | 一个消费者 `notification-clawback` 同时订 order.clawed_back 与 order.settle_adjusted，各事件只有它一个订阅者；evt 队列 standard + 死信；只 worker 消费、并发 5 |
| #30–#37 | settle-adjusted-message/render.test.ts | SETTLE_ADJUSTED 三个变体正文与标题逐字；{amount} 取绝对值（「减少 ¥x」，不出现 -¥）；adjust_fen ≥ 0 与 bucket ≠ user_available 返回 null；覆盖；后台渠道目录加 SETTLE_ADJUSTED（与 CLAWBACK 同形） |
| #40–#52 | settle-adjusted-message/delivery.int.test.ts | 真库：同 CLAWBACK 一组，去重键 `{order_key}:{uid}:{role}:SETTLE_ADJ:{settle_seq}`；同一事件里正数、零、坏账行忽略；整件无可发行不写不推不抛；同人同单先调减后扣回两条不相撞 |
| #53–#55 | settle-adjusted-message/consumer.int.test.ts | 真 AppModule worker：order.settle_adjusted 路由到同一队列；只有正数 / 坏账行时确认事件但不写消息；关推送 |

共用 kit：`clawback-message/kit.ts`（数据库夹具、期望文案）与 `clawback-message/routes.ts`（跳转判定，无导入，供单元测试用）。
期望文案全部手写自任务书与 08，不读实现。所有 it 都是顶层，SUT 在用例体内构造，骨架上每条红在
`NotImplemented` 或断言（routing / 目录用例红在断言）。

## 骨架

`apps/api/src/modules/notification/application/clawback-message.ts`：`renderClawbackMessage`、
`renderSettleAdjustedMessage`、`createOrderDeductionMessageConsumer`（handle 在事件事务里写、dispatch 在提交后发推送，
同 B1-12u 形状）与相关类型。未改 events/types.ts、queue/catalog.ts、worker-plan.ts、catalog.ts、app.module.ts
（骨架阶段只许类型与 NotImplemented 函数，订阅、队列与目录项由实现者加）。

## 冻结用例改动（照 B1-12u 先例，只改计数与清单，不改其他断言与标题）

- `test/spec/platform/events/contract.test.ts`：EVENT_SUBSCRIPTIONS 期望清单在 notification-withdrawal-result 之后加
  `{ consumer: 'notification-clawback', events: ['order.clawed_back', 'order.settle_adjusted'] }`。
- `test/spec/platform/queue/contract.test.ts`：生产队列目录在 evt.notification-withdrawal-result 之后加
  `evt.notification-clawback`（目录默认值、死信 `.dead`）；worker 计划同位置加 `w('evt.notification-clawback', 5)`。
- `test/spec/platform/queue-concurrency/kit.ts`：TRUNK_WORKER_PLAN 加 `w('evt.notification-clawback', 5)`（注释 26 个队列、
  55 槽）；TRUNK_BUSINESS_QUEUES 加该队列；ENV_NAME_OF 加 `QUEUE_CONCURRENCY_EVT_NOTIFICATION_CLAWBACK`（按队列名自动推导，
  不需改 config）。
- `test/spec/platform/queue-concurrency/limits.test.ts`：worker 槽位合计 50 → 55，标题不变。

这几处在骨架上会红（实现还没加订阅与队列），台账 red_exempt 已列 limits.test.ts 两条；events / queue 契约的对应用例
同理属于「未改测试体意图、只改计数」的冻结用例。

## 给实现者

- 新队列名 `evt.notification-clawback`、消费者 `notification-clawback`，在 worker-plan 中紧跟
  evt.notification-withdrawal-result，并发 5；NotificationModule 只在 worker 注册。
- admin-channels/catalog.ts 加 `SETTLE_ADJUSTED: { defaultChannels: ['push', 'inbox'], variables: { self: ['amount', 'reason'],
  share: ['amount', 'reason'], invite: ['amount'] } }`；已有 admin-channels / 前端渠道页测试若枚举全部编码需随之核对。
- R9 扣回（载荷无 reason）的自购 / 分享句只钉开头与金额，原因写法未定（#13）。

测试第 2 轮（编排 §9.5）：settle-adjusted-message/render.test.ts #32 的「不带原因」检查原为正文不含任何原因标题，但 SETTLE_DIFF 标题「结算金额调整」是固定措辞「按结算金额调整」的子串，任何实现都过不了；改为正文不含「：」+ 原因标题（附原因的写法），正文逐字断言不变，其余用例未动。
