// B1-12zc SETTLE_ADJUSTED delivery on real PostgreSQL (D10-773 ①②④⑤; BR-TEXT-09 细则「上级隐私」
// 「频控与免打扰」例 5, BR-TEXT-05, BR-TEXT-10, BR-FUND-09 细则). Synthetic order.settle_adjusted
// events (payload per D10-773 ④; the producer is booked separately) go straight to the consumer;
// the consumer is created in each test body (fixture.deliver / fixture.handle), so the skeleton
// fails each case with NotImplemented. Top-level it() only.
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { failInsert } from '../risk-state-message/db-kit.ts';
import {
  AVAILABLE,
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
  settleBody,
  settleKey,
  type Fixture,
  type Suite,
} from '../clawback-message/kit.ts';

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

/** [code, title, body] of one user's inbox messages. */
async function textsOf(f: Fixture, userId: string) {
  const messages = await f.messagesOf(userId);
  return messages.map((message) => [message.code, message.title, message.body]);
}

it('[AC-B1-12zc#40] 自购单 SETTLE_DIFF 负差（都记到可用余额）→ 自购本人、直推、间推各一条 SETTLE_ADJUSTED：正文与标题逐字、金额取绝对值、去重键 {order_key}:{uid}:{role}:SETTLE_ADJ:{settle_seq}，提交后各推送一条', async () => {
  const f = await fixture(suite);
  const { self, direct, indirect } = f.users;
  const targets = {
    self: await f.token(self),
    direct: await f.token(direct),
    indirect: await f.token(indirect),
  };
  await f.deliver(
    f.settleAdjusted({
      settle_seq: 2,
      sub_type: 'SETTLE_DIFF',
      beneficiaries: [
        { user_id: self, role: 'self', adjust_fen: '-320', bucket: AVAILABLE },
        { user_id: direct, role: 'direct', adjust_fen: '-64', bucket: AVAILABLE },
        { user_id: indirect, role: 'indirect', adjust_fen: '-32', bucket: AVAILABLE },
      ],
    }),
  );
  const mine = await f.messagesOf(self);
  expect(mine).toMatchObject([
    {
      app_id: f.appId,
      user_id: self,
      code: 'SETTLE_ADJUSTED',
      title: TITLES.SETTLE_ADJUSTED.self,
      body: settleBody.self('¥3.2', REASON_TITLES.SETTLE_DIFF),
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
      code: 'SETTLE_ADJUSTED',
      title: TITLES.SETTLE_ADJUSTED.invite,
      body: settleBody.invite('¥0.64'),
    },
  ]);
  expect(up).toHaveLength(1);
  expect(isLedger(up[0]!.route)).toBe(true);
  const upper = await f.messagesOf(indirect);
  expect(upper).toMatchObject([
    {
      user_id: indirect,
      code: 'SETTLE_ADJUSTED',
      title: TITLES.SETTLE_ADJUSTED.invite,
      body: settleBody.invite('¥0.32'),
    },
  ]);
  expect(upper).toHaveLength(1);
  expect(isLedger(upper[0]!.route)).toBe(true);
  const keys = [
    settleKey(f.order, self, 'self', 2),
    settleKey(f.order, direct, 'direct', 2),
    settleKey(f.order, indirect, 'indirect', 2),
  ];
  expect(await f.logKeys()).toEqual(expectedLogs(keys));
  const { logs } = await f.rows();
  expect(logs.every((log) => log.code === 'SETTLE_ADJUSTED')).toBe(true);
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

it.each([
  ['PRICE_PROTECT', REASON_TITLES.PRICE_PROTECT],
  ['PRICE_COMPARE', REASON_TITLES.PRICE_COMPARE],
] as const)(
  '[AC-B1-12zc#41] 分享单 %s 负差 → 分享者收 share 句（原因「%s」、跳订单详情），直推收邀请句（不带原因、跳余额流水）',
  async (sub_type, title) => {
    const f = await fixture(suite);
    const { share, direct } = f.users;
    await f.deliver(
      f.settleAdjusted({
        settle_seq: 5,
        sub_type,
        beneficiaries: [
          { user_id: share, role: 'share', adjust_fen: '-500', bucket: AVAILABLE },
          { user_id: direct, role: 'direct', adjust_fen: '-100', bucket: AVAILABLE },
        ],
      }),
    );
    expect(await textsOf(f, share)).toEqual([
      ['SETTLE_ADJUSTED', TITLES.SETTLE_ADJUSTED.share, settleBody.share('¥5', title)],
    ]);
    const [sharer] = await f.messagesOf(share);
    expect(sharer?.route).toEqual(orderDetail(f.order.order_id));
    expect(await textsOf(f, direct)).toEqual([
      ['SETTLE_ADJUSTED', TITLES.SETTLE_ADJUSTED.invite, settleBody.invite('¥1')],
    ]);
    const [up] = await f.messagesOf(direct);
    expect(isLedger(up?.route)).toBe(true);
    const keys = [settleKey(f.order, share, 'share', 5), settleKey(f.order, direct, 'direct', 5)];
    // Nobody has a push registration: each push log ends failed (B1-12o), never suppressed.
    expect(await f.logKeys()).toEqual(expectedLogs(keys, 'failed'));
  },
);

it('[AC-B1-12zc#42] 同一事件里只处理 adjust_fen < 0 且 bucket = user_available 的行：正向补差、零、记到坏账的负差都忽略（不写站内信、不写日志、不推送）', async () => {
  const f = await fixture(suite);
  const { self, share, direct, indirect } = f.users;
  for (const user of [self, share, direct, indirect]) await f.token(user);
  await f.deliver(
    f.settleAdjusted({
      settle_seq: 4,
      sub_type: 'SETTLE_DIFF',
      beneficiaries: [
        { user_id: self, role: 'self', adjust_fen: '150', bucket: AVAILABLE },
        { user_id: share, role: 'share', adjust_fen: '0', bucket: AVAILABLE },
        { user_id: direct, role: 'direct', adjust_fen: '-64', bucket: 'bad_debt' },
        { user_id: indirect, role: 'indirect', adjust_fen: '-32', bucket: AVAILABLE },
      ],
    }),
  );
  const { inbox, logs } = await f.rows();
  expect(inbox.map((message) => message.user_id)).toEqual([indirect]);
  expect(await textsOf(f, indirect)).toEqual([
    ['SETTLE_ADJUSTED', TITLES.SETTLE_ADJUSTED.invite, settleBody.invite('¥0.32')],
  ]);
  expect(logs.every((log) => log.user_id === indirect)).toBe(true);
  const keys = [settleKey(f.order, indirect, 'indirect', 4)];
  expect(await f.logKeys()).toEqual(expectedLogs(keys));
  expect(f.channel.send).toHaveBeenCalledTimes(1);
});

/** [role, adjust_fen, bucket] of one beneficiary row. */
type Row = readonly ['self' | 'share' | 'direct' | 'indirect', string, string];
const NOTHING_TO_SEND: ReadonlyArray<readonly [string, readonly Row[]]> = [
  [
    '正向补差',
    [
      ['self', '320', AVAILABLE],
      ['direct', '64', AVAILABLE],
    ],
  ],
  ['零', [['share', '0', AVAILABLE]]],
  [
    '负差全记坏账',
    [
      ['self', '-320', 'bad_debt'],
      ['indirect', '-32', 'bad_debt'],
    ],
  ],
];

it.each(NOTHING_TO_SEND)(
  '[AC-B1-12zc#43] 整个事件没有可发的行（%s）→ 不写站内信与日志、不推送、不抛',
  async (_label, rows) => {
    const f = await fixture(suite);
    for (const user of Object.values(f.users)) await f.token(user);
    const beneficiaries = rows.map(([role, adjust_fen, bucket]) => ({
      user_id: f.users[role],
      role,
      adjust_fen,
      bucket,
    }));
    const event = f.settleAdjusted({ settle_seq: 6, sub_type: 'PRICE_PROTECT', beneficiaries });
    await f.deliver(event);
    expect(await f.rows()).toEqual({ inbox: [], logs: [] });
    expect(f.channel.send).not.toHaveBeenCalled();
  },
);

it('[AC-B1-12zc#44] 上级隐私：直推、间推的站内信与推送只含金额与状态——不含商品标题、下级昵称、订单号、子订单号与原因', async () => {
  const f = await fixture(suite);
  const { self, direct, indirect } = f.users;
  await f.token(direct);
  await f.token(indirect);
  await f.deliver(
    f.settleAdjusted({
      sub_type: 'PRICE_COMPARE',
      beneficiaries: [
        { user_id: self, role: 'self', adjust_fen: '-320', bucket: AVAILABLE },
        { user_id: direct, role: 'direct', adjust_fen: '-64', bucket: AVAILABLE },
        { user_id: indirect, role: 'indirect', adjust_fen: '-32', bucket: AVAILABLE },
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
    REASON_TITLES.PRICE_COMPARE,
  ];
  for (const secret of secrets) expect(seen).not.toContain(secret);
});

it('[AC-B1-12zc#45] 同一 settle_seq 重复投递（再投原事件、换事件编号）→ 每人仍只一条；新的 settle_seq 是新一次调减，各发一条', async () => {
  const f = await fixture(suite);
  const { self, direct } = f.users;
  await f.token(self);
  const beneficiaries = [
    { user_id: self, role: 'self', adjust_fen: '-320', bucket: AVAILABLE },
    { user_id: direct, role: 'direct', adjust_fen: '-64', bucket: AVAILABLE },
  ];
  const first = f.settleAdjusted({ settle_seq: 7, beneficiaries });
  await f.deliver(first);
  const before = await f.rows();
  expect(before.inbox).toHaveLength(2);
  await f.deliver({ ...first, attempt: 2 });
  await f.deliver(f.settleAdjusted({ settle_seq: 7, beneficiaries }));
  expect(await f.rows()).toEqual(before);
  expect(f.channel.send).toHaveBeenCalledTimes(1);
  await f.deliver(f.settleAdjusted({ settle_seq: 8, beneficiaries }));
  const keys = [
    settleKey(f.order, self, 'self', 7),
    settleKey(f.order, direct, 'direct', 7),
    settleKey(f.order, self, 'self', 8),
    settleKey(f.order, direct, 'direct', 8),
  ];
  expect(await f.inboxKeys()).toEqual(keys.sort());
  expect(f.channel.send).toHaveBeenCalledTimes(2);
});

it('[AC-B1-12zc#46] 同一受益人同一订单先被结算负差调减、再被扣回 → SETTLE_ADJUSTED 与 CLAWBACK 各一条，去重键互不相撞', async () => {
  const f = await fixture(suite);
  const { self } = f.users;
  const decrease = { user_id: self, role: 'self', adjust_fen: '-100', bucket: AVAILABLE };
  const taken = { user_id: self, role: 'self', clawback_fen: '220' };
  await f.deliver(f.settleAdjusted({ settle_seq: 1, beneficiaries: [decrease] }));
  await f.deliver(f.clawedBack({ reason: 'REFUND', beneficiaries: [taken] }));
  expect((await textsOf(f, self)).sort()).toEqual(
    [
      ['CLAWBACK', TITLES.CLAWBACK.self, clawbackBody.self('-¥2.2', REASON_TITLES.REFUND)],
      ['SETTLE_ADJUSTED', TITLES.SETTLE_ADJUSTED.self, settleBody.self('¥1', '结算金额调整')],
    ].sort(),
  );
  // The kit's default rights_event_id is R1001.
  const keys = [clawbackKey(f.order, self, 'self', 'R1001'), settleKey(f.order, self, 'self', 1)];
  expect(await f.inboxKeys()).toEqual(keys.sort());
});

it('[AC-B1-12zc#47] 同一事件在并发事务里投递 → 每人只留一信、一条站内日志、一条推送日志，所有投递成功', async () => {
  const f = await fixture(suite);
  const { share, indirect } = f.users;
  await f.token(share);
  await f.token(indirect);
  const beneficiaries = [
    { user_id: share, role: 'share', adjust_fen: '-500', bucket: AVAILABLE },
    { user_id: indirect, role: 'indirect', adjust_fen: '-50', bucket: AVAILABLE },
  ];
  const deliveries = [1, 2, 3, 4].map(() =>
    f.deliver(f.settleAdjusted({ settle_seq: 10, beneficiaries })),
  );
  const results = await Promise.allSettled(deliveries);
  expect(results.map((result) => result.status)).toEqual([
    'fulfilled',
    'fulfilled',
    'fulfilled',
    'fulfilled',
  ]);
  const { inbox } = await f.rows();
  expect(inbox.map((message) => message.user_id).sort()).toEqual([share, indirect].sort());
  const keys = [
    settleKey(f.order, share, 'share', 10),
    settleKey(f.order, indirect, 'indirect', 10),
  ];
  expect(await f.logKeys()).toEqual(expectedLogs(keys));
  expect(f.channel.send).toHaveBeenCalledTimes(2);
});

it('[AC-B1-12zc#48] 用户关闭「服务」类推送 → 只写站内信，推送日志 suppressed(push_disabled)，不调推送通道；只关订阅与营销类不影响', async () => {
  const f = await fixture(suite);
  const { self, indirect } = f.users;
  await f.token(self);
  const target = await f.token(indirect);
  await f.settings(self, SERVICE_OFF);
  await f.settings(indirect, OTHERS_OFF);
  await f.deliver(
    f.settleAdjusted({
      beneficiaries: [
        { user_id: self, role: 'self', adjust_fen: '-320', bucket: AVAILABLE },
        { user_id: indirect, role: 'indirect', adjust_fen: '-32', bucket: AVAILABLE },
      ],
    }),
  );
  expect(await f.messagesOf(self)).toHaveLength(1);
  expect(await f.messagesOf(indirect)).toHaveLength(1);
  expect(await f.logsOf(self)).toEqual([
    ['inbox', 'success', null],
    ['push', 'suppressed', 'push_disabled'],
  ]);
  expect(await f.logsOf(indirect)).toEqual([
    ['inbox', 'success', null],
    ['push', 'success', null],
  ]);
  expect(f.channel.send.mock.calls.map((call) => call[0])).toEqual([[target]]);
});

it('[AC-B1-12zc#49] 只通知事件里可发的受益人：同 app 其他用户与别的 app 不受影响', async () => {
  const f = await fixture(suite);
  const { self, share } = f.users;
  const neighbour = await seedUser(f.db, f.appId);
  const otherApp = `deduct-other-${randomUUID()}`;
  await seedUser(f.db, otherApp);
  const row = { user_id: share, role: 'share', adjust_fen: '-80', bucket: AVAILABLE };
  await f.deliver(f.settleAdjusted({ beneficiaries: [row] }));
  const { inbox, logs } = await f.rows();
  expect(inbox.map((message) => message.user_id)).toEqual([share]);
  expect(logs.every((log) => log.user_id === share)).toBe(true);
  expect(await f.messagesOf(self)).toEqual([]);
  expect(await f.messagesOf(neighbour)).toEqual([]);
  expect(await f.rows(otherApp)).toEqual({ inbox: [], logs: [] });
});

it('[AC-B1-12zc#50] 站内信与日志在调用方事务里写：提交前别的连接看不到，事务失败两表皆空，重投成功', async () => {
  const f = await fixture(suite);
  const row = { user_id: f.users.self, role: 'self', adjust_fen: '-320', bucket: AVAILABLE };
  const event = f.settleAdjusted({ beneficiaries: [row] });
  const sut = f.consumer();
  await expect(
    f.db.transaction().execute(async (trx) => {
      await sut.handle(event, trx);
      const inside = await trx
        .selectFrom('inbox_messages')
        .select('code')
        .where('app_id', '=', f.appId)
        .execute();
      expect(inside).toEqual([{ code: 'SETTLE_ADJUSTED' }]);
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
  '[AC-B1-12zc#51] %s 写入失败不吞错，两表一起回滚（含已写的其他受益人），重投成功',
  async (table) => {
    const f = await fixture(suite);
    const { self, direct } = f.users;
    const event = f.settleAdjusted({
      sub_type: 'PRICE_PROTECT',
      beneficiaries: [
        { user_id: self, role: 'self', adjust_fen: '-320', bucket: AVAILABLE },
        { user_id: direct, role: 'direct', adjust_fen: '-64', bucket: AVAILABLE },
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
        [self, settleBody.self('¥3.2', REASON_TITLES.PRICE_PROTECT)],
        [direct, settleBody.invite('¥0.64')],
      ].sort(),
    );
  },
);

it('[AC-B1-12zc#52] notify_templates 覆盖按 app、code、variant 精确匹配：SETTLE_ADJUSTED self 的覆盖只管自购，invite 仍用默认；CLAWBACK 与别的 app 的覆盖不串用；跳转不变', async () => {
  const f = await fixture(suite);
  const { self, direct } = f.users;
  const own = { title_override: '返利变动', body_override: '返利减少 {amount}' };
  const wrong = { title_override: '错用', body_override: '错用 {amount}' };
  await f.template('SETTLE_ADJUSTED', 'self', own);
  await f.template('CLAWBACK', 'invite', wrong);
  await f.template('SETTLE_ADJUSTED', 'invite', wrong, `deduct-other-${randomUUID()}`);
  await f.deliver(
    f.settleAdjusted({
      beneficiaries: [
        { user_id: self, role: 'self', adjust_fen: '-320', bucket: AVAILABLE },
        { user_id: direct, role: 'direct', adjust_fen: '-64', bucket: AVAILABLE },
      ],
    }),
  );
  expect(await textsOf(f, self)).toEqual([['SETTLE_ADJUSTED', '返利变动', '返利减少 ¥3.2']]);
  const [mine] = await f.messagesOf(self);
  expect(mine?.route).toEqual(orderDetail(f.order.order_id));
  expect(await textsOf(f, direct)).toEqual([
    ['SETTLE_ADJUSTED', TITLES.SETTLE_ADJUSTED.invite, settleBody.invite('¥0.64')],
  ]);
  const [up] = await f.messagesOf(direct);
  expect(isLedger(up?.route)).toBe(true);
});
