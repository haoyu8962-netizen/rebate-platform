// B1-12zc CLAWBACK delivery on real PostgreSQL (BR-TEXT-09 表与细则「上级隐私」「频控与免打扰」例 5,
// BR-TEXT-05, BR-TEXT-10; D10-773 ①②③⑤). Synthetic order.clawed_back events go straight to the
// consumer; the consumer is created in each test body (fixture.deliver / fixture.handle), so the
// skeleton fails each case with NotImplemented. Top-level it() only.
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { failInsert } from '../risk-state-message/db-kit.ts';
import {
  BUYER_NICKNAME,
  NOW,
  ORDER_TITLE,
  REASON_TITLES,
  TITLES,
  clawbackBody,
  clawbackKey,
  expectedLogs,
  fixture,
  isLedger,
  openSuite,
  orderDetail,
  pushPayload,
  seedUser,
  type Suite,
} from './kit.ts';

let suite: Suite;
beforeAll(async () => {
  suite = await openSuite(createTestDatabase);
}, 120_000);
afterAll(async () => {
  await suite?.close();
});

/** The recipient switched the service category's push off (BR-TEXT-09 例 5). */
const SERVICE_OFF = { service_push: false, subscription_push: true, marketing_push: true };
/** Only the subscription and marketing pushes are off. */
const OTHERS_OFF = { service_push: true, subscription_push: false, marketing_push: false };

it('[AC-B1-12zc#10] 自购单 R8 扣回（原因 REFUND）→ 自购本人、直推、间推各一条 CLAWBACK：正文与标题逐字、金额负值格式、去重键 {order_key}:{uid}:{role}:CLAWBACK:{rights_event_id}，提交后各推送一条', async () => {
  const f = await fixture(suite);
  const { self, direct, indirect } = f.users;
  const targets = {
    self: await f.token(self),
    direct: await f.token(direct),
    indirect: await f.token(indirect),
  };
  await f.deliver(
    f.clawedBack({
      rights_event_id: 'R7001',
      reason: 'REFUND',
      beneficiaries: [
        { user_id: self, role: 'self', clawback_fen: '320' },
        { user_id: direct, role: 'direct', clawback_fen: '64' },
        { user_id: indirect, role: 'indirect', clawback_fen: '32' },
      ],
    }),
  );
  const mine = await f.messagesOf(self);
  expect(mine).toMatchObject([
    {
      app_id: f.appId,
      user_id: self,
      code: 'CLAWBACK',
      title: TITLES.CLAWBACK.self,
      body: clawbackBody.self('-¥3.2', REASON_TITLES.REFUND),
      read_at: null,
    },
  ]);
  expect(mine).toHaveLength(1);
  expect(mine[0]!.route).toEqual(orderDetail(f.order.order_id));
  expect(mine[0]!.created_at.toISOString()).toBe(NOW);
  const up = await f.messagesOf(direct);
  expect(up).toMatchObject([
    {
      user_id: direct,
      code: 'CLAWBACK',
      title: TITLES.CLAWBACK.invite,
      body: clawbackBody.invite('-¥0.64'),
    },
  ]);
  expect(up).toHaveLength(1);
  expect(isLedger(up[0]!.route)).toBe(true);
  const upper = await f.messagesOf(indirect);
  expect(upper).toMatchObject([
    {
      user_id: indirect,
      code: 'CLAWBACK',
      title: TITLES.CLAWBACK.invite,
      body: clawbackBody.invite('-¥0.32'),
    },
  ]);
  expect(upper).toHaveLength(1);
  expect(isLedger(upper[0]!.route)).toBe(true);
  const keys = [
    clawbackKey(f.order, self, 'self', 'R7001'),
    clawbackKey(f.order, direct, 'direct', 'R7001'),
    clawbackKey(f.order, indirect, 'indirect', 'R7001'),
  ];
  expect(await f.logKeys()).toEqual(expectedLogs(keys));
  const { logs } = await f.rows();
  expect(logs.every((log) => log.code === 'CLAWBACK')).toBe(true);
  // One push per recipient, payload exactly the stored message (B1-12o), to that recipient only.
  const sent = f.channel.send.mock.calls.map((call) => call.slice(0, 2));
  expect(sent).toHaveLength(3);
  expect(sent).toEqual(
    expect.arrayContaining([
      [[targets.self], pushPayload(mine[0]!)],
      [[targets.direct], pushPayload(up[0]!)],
      [[targets.indirect], pushPayload(upper[0]!)],
    ]),
  );
});

it('[AC-B1-12zc#11] 分享单 R8 扣回（原因 RIGHTS）→ 分享者收 share 句（带原因、跳订单详情），直推收邀请句（不带原因、跳余额流水）', async () => {
  const f = await fixture(suite);
  const { share, direct } = f.users;
  await f.deliver(
    f.clawedBack({
      rights_event_id: 'R7002',
      reason: 'RIGHTS',
      beneficiaries: [
        { user_id: share, role: 'share', clawback_fen: '500' },
        { user_id: direct, role: 'direct', clawback_fen: '100' },
      ],
    }),
  );
  const sharer = await f.messagesOf(share);
  expect(sharer).toMatchObject([
    {
      code: 'CLAWBACK',
      title: TITLES.CLAWBACK.share,
      body: clawbackBody.share('-¥5', REASON_TITLES.RIGHTS),
    },
  ]);
  expect(sharer).toHaveLength(1);
  expect(sharer[0]!.route).toEqual(orderDetail(f.order.order_id));
  const up = await f.messagesOf(direct);
  expect(up).toMatchObject([
    {
      code: 'CLAWBACK',
      title: TITLES.CLAWBACK.invite,
      body: clawbackBody.invite('-¥1'),
    },
  ]);
  expect(up).toHaveLength(1);
  expect(isLedger(up[0]!.route)).toBe(true);
  const keys = [
    clawbackKey(f.order, share, 'share', 'R7002'),
    clawbackKey(f.order, direct, 'direct', 'R7002'),
  ];
  // Nobody has a push registration: each push log ends failed (B1-12o), never suppressed.
  expect(await f.logKeys()).toEqual(expectedLogs(keys, 'failed'));
});

it.each([
  ['PUNISH', REASON_TITLES.PUNISH],
  ['COMMISSION_ZERO', REASON_TITLES.COMMISSION_ZERO],
] as const)(
  '[AC-B1-12zc#12] R8 原因 %s → 自购句的 {reason.title} 取 BR-TEXT-05 标题「%s」',
  async (reason, title) => {
    const f = await fixture(suite);
    const row = { user_id: f.users.self, role: 'self', clawback_fen: '1234' };
    await f.deliver(f.clawedBack({ reason, beneficiaries: [row] }));
    const mine = await f.messagesOf(f.users.self);
    expect(mine.map((message) => [message.code, message.title, message.body])).toEqual([
      ['CLAWBACK', TITLES.CLAWBACK.self, clawbackBody.self('-¥12.34', title)],
    ]);
  },
);

it('[AC-B1-12zc#13] R9 扣回（载荷无 reason）也发：自购句以「订单返利已扣回 {amount}」开头、跳订单详情，邀请句逐字不带原因；去重键用该 rights_event_id', async () => {
  const f = await fixture(suite);
  const { self, indirect } = f.users;
  await f.deliver(
    f.clawedBack({
      rights_event_id: 'R7003',
      transition: 'R9',
      beneficiaries: [
        { user_id: self, role: 'self', clawback_fen: '100' },
        { user_id: indirect, role: 'indirect', clawback_fen: '20' },
      ],
    }),
  );
  const mine = await f.messagesOf(self);
  expect(mine).toHaveLength(1);
  expect(mine[0]).toMatchObject({ code: 'CLAWBACK', title: TITLES.CLAWBACK.self });
  // How R9 names its reason is not pinned here; the amount and the sentence head are.
  expect(mine[0]!.body).toMatch(/^订单返利已扣回 -¥1(?:：.+)?$/);
  expect(mine[0]!.route).toEqual(orderDetail(f.order.order_id));
  const upper = await f.messagesOf(indirect);
  expect(upper.map((message) => [message.code, message.title, message.body])).toEqual([
    ['CLAWBACK', TITLES.CLAWBACK.invite, clawbackBody.invite('-¥0.2')],
  ]);
  expect(isLedger(upper[0]!.route)).toBe(true);
  const keys = [
    clawbackKey(f.order, self, 'self', 'R7003'),
    clawbackKey(f.order, indirect, 'indirect', 'R7003'),
  ];
  expect(await f.inboxKeys()).toEqual(keys.sort());
});

it('[AC-B1-12zc#14] 上级隐私：直推、间推的站内信与推送只含金额与状态——不含商品标题、下级昵称、订单号、子订单号与原因', async () => {
  const f = await fixture(suite);
  const { self, direct, indirect } = f.users;
  await f.token(direct);
  await f.token(indirect);
  await f.deliver(
    f.clawedBack({
      reason: 'REFUND',
      beneficiaries: [
        { user_id: self, role: 'self', clawback_fen: '320' },
        { user_id: direct, role: 'direct', clawback_fen: '64' },
        { user_id: indirect, role: 'indirect', clawback_fen: '32' },
      ],
    }),
  );
  const uplines = [...(await f.messagesOf(direct)), ...(await f.messagesOf(indirect))];
  expect(uplines).toHaveLength(2);
  const pushed = f.channel.send.mock.calls.map((call) => call[1]);
  expect(pushed).toHaveLength(2);
  const seen = JSON.stringify([uplines, pushed]);
  const secrets = [
    ORDER_TITLE,
    BUYER_NICKNAME,
    f.order.order_id,
    f.order.sub_order_id,
    f.order.order_key,
    self,
    REASON_TITLES.REFUND,
  ];
  for (const secret of secrets) expect(seen).not.toContain(secret);
});

it('[AC-B1-12zc#15] 同一 rights_event_id 重复投递（再投原事件、换事件编号）→ 每人仍只一条站内信、一条推送，原文与时间不变', async () => {
  const f = await fixture(suite);
  const { self, direct } = f.users;
  await f.token(self);
  await f.token(direct);
  const beneficiaries = [
    { user_id: self, role: 'self', clawback_fen: '320' },
    { user_id: direct, role: 'direct', clawback_fen: '64' },
  ];
  const first = f.clawedBack({ rights_event_id: 'R7004', reason: 'REFUND', beneficiaries });
  await f.deliver(first);
  const before = await f.rows();
  expect(before.inbox).toHaveLength(2);
  await f.deliver({ ...first, attempt: 2 });
  const renamed = f.clawedBack({ rights_event_id: 'R7004', reason: 'REFUND', beneficiaries });
  await f.deliver(renamed);
  expect(await f.rows()).toEqual(before);
  expect(f.channel.send).toHaveBeenCalledTimes(2);
});

it('[AC-B1-12zc#16] 不同 rights_event_id 是两次扣回，各发一条；不同订单同一用户也各发一条', async () => {
  const f = await fixture(suite);
  const { self } = f.users;
  const other = await f.newOrder();
  const row = { user_id: self, role: 'self', clawback_fen: '100' };
  const a = f.clawedBack({ rights_event_id: 'R7005', reason: 'RIGHTS', beneficiaries: [row] });
  const b = f.clawedBack({ rights_event_id: 'R7006', reason: 'RIGHTS', beneficiaries: [row] });
  const c = f.clawedBack({
    order: other,
    rights_event_id: 'R7005',
    reason: 'REFUND',
    beneficiaries: [row],
  });
  for (const event of [a, b, c]) await f.deliver(event);
  const mine = await f.messagesOf(self);
  expect(mine).toHaveLength(3);
  const keys = [
    clawbackKey(f.order, self, 'self', 'R7005'),
    clawbackKey(f.order, self, 'self', 'R7006'),
    clawbackKey(other, self, 'self', 'R7005'),
  ];
  expect(await f.inboxKeys()).toEqual(keys.sort());
  const routes = mine.map((message) => message.route);
  expect(routes).toContainEqual(orderDetail(f.order.order_id));
  expect(routes).toContainEqual(orderDetail(other.order_id));
});

it('[AC-B1-12zc#17] 同一事件在并发事务里投递 → PG 唯一约束最终每人只留一信、一条站内日志、一条推送日志，所有投递成功', async () => {
  const f = await fixture(suite);
  const { self, direct } = f.users;
  await f.token(self);
  await f.token(direct);
  const beneficiaries = [
    { user_id: self, role: 'self', clawback_fen: '320' },
    { user_id: direct, role: 'direct', clawback_fen: '64' },
  ];
  const deliveries = [1, 2, 3, 4].map(() =>
    f.deliver(f.clawedBack({ rights_event_id: 'R7007', reason: 'REFUND', beneficiaries })),
  );
  const results = await Promise.allSettled(deliveries);
  expect(results.map((result) => result.status)).toEqual([
    'fulfilled',
    'fulfilled',
    'fulfilled',
    'fulfilled',
  ]);
  const { inbox } = await f.rows();
  expect(inbox.map((message) => message.user_id).sort()).toEqual([self, direct].sort());
  const keys = [
    clawbackKey(f.order, self, 'self', 'R7007'),
    clawbackKey(f.order, direct, 'direct', 'R7007'),
  ];
  expect(await f.logKeys()).toEqual(expectedLogs(keys));
  expect(f.channel.send).toHaveBeenCalledTimes(2);
});

it('[AC-B1-12zc#18] 用户关闭「服务」类推送 → 只写站内信，推送日志 suppressed(push_disabled)；只关订阅与营销类的上级照常推送', async () => {
  const f = await fixture(suite);
  const { self, direct } = f.users;
  await f.token(self);
  const target = await f.token(direct);
  await f.settings(self, SERVICE_OFF);
  await f.settings(direct, OTHERS_OFF);
  await f.deliver(
    f.clawedBack({
      rights_event_id: 'R7008',
      reason: 'REFUND',
      beneficiaries: [
        { user_id: self, role: 'self', clawback_fen: '320' },
        { user_id: direct, role: 'direct', clawback_fen: '64' },
      ],
    }),
  );
  expect(await f.messagesOf(self)).toHaveLength(1);
  expect(await f.messagesOf(direct)).toHaveLength(1);
  expect(await f.logsOf(self)).toEqual([
    ['inbox', 'success', null],
    ['push', 'suppressed', 'push_disabled'],
  ]);
  expect(await f.logsOf(direct)).toEqual([
    ['inbox', 'success', null],
    ['push', 'success', null],
  ]);
  expect(f.channel.send.mock.calls.map((call) => call[0])).toEqual([[target]]);
});

it('[AC-B1-12zc#19] 只通知事件列出的受益人：未列出的（扣到坏账的、同 app 其他用户、别的 app 用户）不收任何消息', async () => {
  const f = await fixture(suite);
  const { self, direct, indirect } = f.users;
  const neighbour = await seedUser(f.db, f.appId);
  const otherApp = `deduct-other-${randomUUID()}`;
  await seedUser(f.db, otherApp);
  // The buyer's clawback went to BAD_DEBT (deletion in progress): the producer does not list it.
  await f.deliver(
    f.clawedBack({
      rights_event_id: 'R7009',
      reason: 'REFUND',
      beneficiaries: [
        { user_id: direct, role: 'direct', clawback_fen: '64' },
        { user_id: indirect, role: 'indirect', clawback_fen: '32' },
      ],
    }),
  );
  const { inbox, logs } = await f.rows();
  expect(inbox.map((message) => message.user_id).sort()).toEqual([direct, indirect].sort());
  expect(logs.every((log) => log.user_id === direct || log.user_id === indirect)).toBe(true);
  expect(await f.messagesOf(self)).toEqual([]);
  expect(await f.messagesOf(neighbour)).toEqual([]);
  expect(await f.rows(otherApp)).toEqual({ inbox: [], logs: [] });
});

it('[AC-B1-12zc#20] 站内信与日志在调用方事务里写：提交前别的连接看不到，事务失败两表皆空，重投成功', async () => {
  const f = await fixture(suite);
  const row = { user_id: f.users.self, role: 'self', clawback_fen: '320' };
  const event = f.clawedBack({ reason: 'REFUND', beneficiaries: [row] });
  const sut = f.consumer();
  await expect(
    f.db.transaction().execute(async (trx) => {
      await sut.handle(event, trx);
      const inside = await trx
        .selectFrom('inbox_messages')
        .select('code')
        .where('app_id', '=', f.appId)
        .execute();
      expect(inside).toEqual([{ code: 'CLAWBACK' }]);
      expect(await f.rows()).toEqual({ inbox: [], logs: [] });
      throw new Error('caller rollback');
    }),
  ).rejects.toThrow('caller rollback');
  expect(await f.rows()).toEqual({ inbox: [], logs: [] });
  await f.deliver(event);
  const { inbox, logs } = await f.rows();
  expect(inbox).toHaveLength(1);
  expect(logs.filter((log) => log.channel === 'inbox')).toHaveLength(1);
});

it.each(['inbox_messages', 'notify_logs'] as const)(
  '[AC-B1-12zc#21] %s 写入失败不吞错，两表一起回滚（含已写的其他受益人），重投成功',
  async (table) => {
    const f = await fixture(suite);
    const { self, direct } = f.users;
    const event = f.clawedBack({
      rights_event_id: 'R7011',
      reason: 'PUNISH',
      beneficiaries: [
        { user_id: self, role: 'self', clawback_fen: '320' },
        { user_id: direct, role: 'direct', clawback_fen: '64' },
      ],
    });
    const fault = failInsert(table);
    await expect(f.handle(event, f.db.withPlugin(fault.plugin))).rejects.toMatchObject({
      code: '22012',
    });
    expect(fault.fired()).toBe(true);
    expect(await f.rows()).toEqual({ inbox: [], logs: [] });
    await f.deliver(event);
    const { inbox } = await f.rows();
    const seen = inbox.map((message) => [message.user_id, message.body]).sort();
    expect(seen).toEqual(
      [
        [self, clawbackBody.self('-¥3.2', REASON_TITLES.PUNISH)],
        [direct, clawbackBody.invite('-¥0.64')],
      ].sort(),
    );
  },
);

it('[AC-B1-12zc#22] notify_templates 覆盖按 app、code、variant 精确匹配：CLAWBACK invite 的覆盖只管上级，self 仍用默认；SETTLE_ADJUSTED 与别的 app 的覆盖不串用；跳转不变', async () => {
  const f = await fixture(suite);
  const { self, direct } = f.users;
  const invite = { title_override: '收益变动', body_override: '邀请收益调整 {amount}' };
  const wrong = { title_override: '错用', body_override: '错用 {amount}' };
  await f.template('CLAWBACK', 'invite', invite);
  await f.template('SETTLE_ADJUSTED', 'self', wrong);
  await f.template('CLAWBACK', 'self', wrong, `deduct-other-${randomUUID()}`);
  await f.deliver(
    f.clawedBack({
      rights_event_id: 'R7012',
      reason: 'REFUND',
      beneficiaries: [
        { user_id: self, role: 'self', clawback_fen: '320' },
        { user_id: direct, role: 'direct', clawback_fen: '64' },
      ],
    }),
  );
  const mine = await f.messagesOf(self);
  expect(mine.map((message) => [message.title, message.body])).toEqual([
    [TITLES.CLAWBACK.self, clawbackBody.self('-¥3.2', REASON_TITLES.REFUND)],
  ]);
  expect(mine[0]!.route).toEqual(orderDetail(f.order.order_id));
  const up = await f.messagesOf(direct);
  expect(up.map((message) => [message.title, message.body])).toEqual([
    ['收益变动', '邀请收益调整 -¥0.64'],
  ]);
  expect(isLedger(up[0]!.route)).toBe(true);
});
