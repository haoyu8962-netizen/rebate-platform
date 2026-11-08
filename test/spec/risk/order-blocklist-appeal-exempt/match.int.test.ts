// B1-03zk：订单侧名单端口 match 的再命中豁免（08 BR-ATTR-26「申诉撤销后的再命中」，D10-1093）。
// 每条用例都带一条主干上会红的正向断言；不豁免的条件放在正向断言之前，主干上先验证夹具确实命中。
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  ABORT,
  AFTER,
  BEFORE,
  CLOSED,
  END,
  START,
  databaseFixture,
  expectEntries,
  scene,
  seedBlock,
  shift,
  type Matches,
  type Scene,
} from './kit.ts';

const database = databaseFixture();

const channel = (id: string, value = 'R8') => ({
  blocklist_id: id,
  dimension: 'channel' as const,
  value,
});
const suffix = (id: string, value = '123456') => ({
  blocklist_id: id,
  dimension: 'order_no_suffix' as const,
  value,
});

it('[AC-B1-03zk#1] 渠道维度：订单申诉已撤销且结案前有该值 void_commission 命中，带 order_id 的 match 不再返回该值', async () => {
  const db = database();
  const s = await scene(db);
  await seedBlock(db, s.f);
  await s.hit({
    order_id: s.orderId,
    dimension: 'channel',
    value: 'R8',
    at: BEFORE,
    risk_action: 'void_commission',
  });
  await s.appeal({ target_id: s.orderId, status: 'revoked', closed_at: CLOSED });
  expect(await s.match({ order_id: s.orderId })).toEqual([]);
}, 60_000);

it('[AC-B1-03zk#2] 尾号维度：订单申诉已撤销且结案前有该值命中，带 order_id 的 match 不再返回该值', async () => {
  const db = database();
  const s = await scene(db);
  await seedBlock(db, s.f, { dimension: 'order_no_suffix' });
  await s.exempt(s.orderId, 'order_no_suffix', '123456');
  expect(await s.match({ order_id: s.orderId })).toEqual([]);
}, 60_000);

it('[AC-B1-03zk#3] 结案前的命中只有 manual_review 也豁免（不限处置），两种维度都如此', async () => {
  const db = database();
  const s = await scene(db);
  await seedBlock(db, s.f);
  await seedBlock(db, s.f, { dimension: 'order_no_suffix' });
  for (const [dimension, value] of [
    ['channel', 'R8'],
    ['order_no_suffix', '123456'],
  ] as const) {
    await s.hit({
      order_id: s.orderId,
      dimension,
      value,
      at: BEFORE,
      risk_action: 'manual_review',
    });
  }
  await s.appeal({ target_id: s.orderId, status: 'revoked', closed_at: CLOSED });
  expect(await s.match({ order_id: s.orderId })).toEqual([]);
}, 60_000);

it('[AC-B1-03zk#4] 一单多个已命中值全部豁免；结案后才写命中的值、从未命中的值照常返回', async () => {
  const db = database();
  const s = await scene(db);
  await seedBlock(db, s.f);
  await seedBlock(db, s.f, { dimension: 'order_no_suffix' });
  const late = await seedBlock(db, s.f, { value: 'R9' });
  const never = await seedBlock(db, s.f, { value: 'R10' });
  const neverSuffix = await seedBlock(db, s.f, { dimension: 'order_no_suffix', value: '654321' });
  const lateSuffix = await seedBlock(db, s.f, { dimension: 'order_no_suffix', value: '777777' });
  await s.exempt(s.orderId, 'channel', 'R8');
  await s.hit({ order_id: s.orderId, dimension: 'order_no_suffix', value: '123456', at: BEFORE });
  await s.hit({ order_id: s.orderId, dimension: 'channel', value: 'R9', at: AFTER });
  await s.hit({ order_id: s.orderId, dimension: 'order_no_suffix', value: '777777', at: AFTER });
  const order_id = s.orderId;

  expect(await s.match({ order_id })).toEqual([]);
  expect(await s.match({ order_id, relation_id: 'R9' })).toEqual([channel(late, 'R9')]);
  expect(await s.match({ order_id, relation_id: 'R10' })).toEqual([channel(never, 'R10')]);
  expect(await s.match({ order_id, trade_parent_id: '3301987654654321' })).toEqual([
    suffix(neverSuffix, '654321'),
  ]);
  expect(await s.match({ order_id, trade_parent_id: '3301987654777777' })).toEqual([
    suffix(lateSuffix, '777777'),
  ]);
}, 60_000);

it('[AC-B1-03zk#5] 边界：命中 created_at 等于 closed_at 豁免，早 1 毫秒豁免，晚 1 毫秒不豁免', async () => {
  const db = database();
  const s = await scene(db);
  const id = await seedBlock(db, s.f);
  const equal = randomUUID();
  const earlier = randomUUID();
  const later = randomUUID();
  for (const [order, at] of [
    [equal, CLOSED],
    [earlier, shift(CLOSED, -1)],
    [later, shift(CLOSED, 1)],
  ] as const) {
    await s.hit({ order_id: order, dimension: 'channel', value: 'R8', at });
    await s.appeal({ target_id: order, status: 'revoked', closed_at: CLOSED });
  }
  expect(await s.match({ order_id: later })).toEqual([channel(id)]);
  expect(await s.match({ order_id: earlier })).toEqual([]);
  expect(await s.match({ order_id: equal })).toEqual([]);
}, 60_000);

it('[AC-B1-03zk#5] 多次申诉：以某一条撤销申诉的结案时刻为准；撤销之后才命中、后来申诉又维持的不豁免', async () => {
  const db = database();
  const s = await scene(db);
  const id = await seedBlock(db, s.f);
  const hitAfterRevoke = randomUUID();
  const betweenRevokes = randomUUID();
  const beforeBoth = randomUUID();
  const preAndPost = randomUUID();

  // 撤销在前、命中在后、维持在最后：没有一条撤销申诉覆盖这次命中。
  await s.appeal({ target_id: hitAfterRevoke, status: 'revoked', closed_at: BEFORE });
  await s.hit({ order_id: hitAfterRevoke, dimension: 'channel', value: 'R8', at: CLOSED });
  await s.appeal({ target_id: hitAfterRevoke, status: 'upheld', closed_at: AFTER });

  // 第二条撤销申诉覆盖命中。
  await s.appeal({ target_id: betweenRevokes, status: 'revoked', closed_at: BEFORE });
  await s.hit({ order_id: betweenRevokes, dimension: 'channel', value: 'R8', at: CLOSED });
  await s.appeal({ target_id: betweenRevokes, status: 'revoked', closed_at: AFTER });

  // 撤销申诉覆盖命中，之后又有维持的申诉，不影响已成立的豁免。
  await s.hit({ order_id: beforeBoth, dimension: 'channel', value: 'R8', at: BEFORE });
  await s.appeal({ target_id: beforeBoth, status: 'revoked', closed_at: CLOSED });
  await s.appeal({ target_id: beforeBoth, status: 'upheld', closed_at: AFTER });

  // 同一值结案前后各有一条命中：结案前那条成立。
  await s.hit({
    order_id: preAndPost,
    dimension: 'channel',
    value: 'R8',
    at: BEFORE,
    risk_action: 'manual_review',
  });
  await s.appeal({ target_id: preAndPost, status: 'revoked', closed_at: CLOSED });
  await s.hit({
    order_id: preAndPost,
    dimension: 'channel',
    value: 'R8',
    at: AFTER,
    risk_action: 'void_commission',
  });

  expect(await s.match({ order_id: hitAfterRevoke })).toEqual([channel(id)]);
  expect(await s.match({ order_id: betweenRevokes })).toEqual([]);
  expect(await s.match({ order_id: beforeBoth })).toEqual([]);
  expect(await s.match({ order_id: preAndPost })).toEqual([]);
}, 60_000);

type Arrange = (s: Scene, target: string) => Promise<void>;

const NOT_EXEMPT: readonly (readonly [string, Arrange])[] = [
  ['别的订单（同名单值，该单无命中无申诉）', () => Promise.resolve()],
  [
    '申诉结案为维持',
    async (s, target) => {
      await s.hit({ order_id: target, dimension: 'channel', value: 'R8', at: BEFORE });
      await s.appeal({ target_id: target, status: 'upheld', closed_at: CLOSED });
    },
  ],
  [
    '申诉仍在处理中',
    async (s, target) => {
      await s.hit({ order_id: target, dimension: 'channel', value: 'R8', at: BEFORE });
      await s.appeal({ target_id: target, status: 'processing', closed_at: null });
    },
  ],
  [
    '有命中但没有申诉',
    async (s, target) => {
      await s.hit({ order_id: target, dimension: 'channel', value: 'R8', at: BEFORE });
    },
  ],
  [
    '撤销的申诉属于别的 app',
    async (s, target) => {
      const otherUser = await s.foreignUser();
      await s.hit({ order_id: target, dimension: 'channel', value: 'R8', at: BEFORE });
      await s.appeal({
        target_id: target,
        status: 'revoked',
        closed_at: CLOSED,
        app_id: s.otherApp,
        user_id: otherUser,
      });
    },
  ],
  [
    '结案前的命中属于别的 app',
    async (s, target) => {
      await s.hit({
        order_id: target,
        dimension: 'channel',
        value: 'R8',
        at: BEFORE,
        app_id: s.otherApp,
      });
      await s.appeal({ target_id: target, status: 'revoked', closed_at: CLOSED });
    },
  ],
  [
    '撤销的申诉对象不是订单（target_id 同为该订单 id）',
    async (s, target) => {
      await s.hit({ order_id: target, dimension: 'channel', value: 'R8', at: BEFORE });
      await s.appeal({
        target_id: target,
        status: 'revoked',
        closed_at: CLOSED,
        target_type: 'blocked_request',
      });
    },
  ],
  [
    '结案前的命中对象不是订单（ref_id 同为该订单 id）',
    async (s, target) => {
      await s.appeal({ target_id: target, status: 'revoked', closed_at: CLOSED });
      await s.rawHit({
        ref_id: target,
        ref_type: 'withdrawal',
        dimension: 'channel',
        value_hmac: s.hmac('channel', 'R8'),
        at: BEFORE,
      });
    },
  ],
  [
    '结案前命中的是别的名单值',
    async (s, target) => {
      await s.hit({ order_id: target, dimension: 'channel', value: 'R9', at: BEFORE });
      await s.appeal({ target_id: target, status: 'revoked', closed_at: CLOSED });
    },
  ],
  [
    '命中行的 dimension 或 value_hmac 与这个名单值错位',
    async (s, target) => {
      await s.appeal({ target_id: target, status: 'revoked', closed_at: CLOSED });
      await s.rawHit({
        ref_id: target,
        dimension: 'order_no_suffix',
        value_hmac: s.hmac('channel', 'R8'),
        at: BEFORE,
      });
      await s.rawHit({
        ref_id: target,
        dimension: 'channel',
        value_hmac: s.hmac('order_no_suffix', 'R8'),
        at: BEFORE,
      });
    },
  ],
];

it.each(NOT_EXEMPT)(
  '[AC-B1-03zk#6] 不豁免：%s（同用例内已满足条件的订单仍被豁免）',
  async (_label, arrange) => {
    const db = database();
    const s = await scene(db);
    const id = await seedBlock(db, s.f);
    await s.exempt();
    const target = randomUUID();
    await arrange(s, target);
    expect(await s.match({ order_id: target })).toEqual([channel(id)]);
    expect(await s.match({ order_id: s.orderId })).toEqual([]);
  },
  60_000,
);

it('[AC-B1-03zk#6] 同值不同维度互不豁免：渠道命中不豁免同值尾号，尾号命中不豁免同值渠道', async () => {
  const db = database();
  const s = await scene(db);
  const sameValue = '123456';
  const channelId = await seedBlock(db, s.f, { value: sameValue });
  const suffixId = await seedBlock(db, s.f, { dimension: 'order_no_suffix', value: sameValue });
  const channelOnly = randomUUID();
  const suffixOnly = randomUUID();
  await s.exempt(channelOnly, 'channel', sameValue);
  await s.exempt(suffixOnly, 'order_no_suffix', sameValue);
  const query = { relation_id: sameValue };
  expect(await s.match({ ...query, order_id: channelOnly })).toEqual([suffix(suffixId, sameValue)]);
  expect(await s.match({ ...query, order_id: suffixOnly })).toEqual([
    channel(channelId, sameValue),
  ]);
}, 60_000);

it('[AC-B1-03zk#7] 不传 order_id 行为同主干：两种维度全部返回；传了 order_id 的同一查询才豁免', async () => {
  const db = database();
  const s = await scene(db);
  const channelId = await seedBlock(db, s.f);
  const suffixId = await seedBlock(db, s.f, { dimension: 'order_no_suffix' });
  await s.exempt(s.orderId, 'channel', 'R8');
  await s.hit({ order_id: s.orderId, dimension: 'order_no_suffix', value: '123456', at: BEFORE });
  expectEntries(await s.match(), [channel(channelId), suffix(suffixId)]);
  expect(await s.match({ order_id: s.orderId })).toEqual([]);
}, 60_000);

it('[AC-B1-03zk#8] match 只读：调用前后 risk_hits、blocklist、appeals 行数与内容不变，名单条目仍 active', async () => {
  const db = database();
  const s = await scene(db);
  await seedBlock(db, s.f);
  await seedBlock(db, s.f, { dimension: 'order_no_suffix' });
  await s.exempt(s.orderId, 'channel', 'R8');
  await s.hit({ order_id: s.orderId, dimension: 'order_no_suffix', value: '123456', at: BEFORE });
  const before = await s.snapshot();
  const rows = await s.match({ order_id: s.orderId });
  const after = await s.snapshot();
  expect(after).toEqual(before);
  expect(after.blocks).toHaveLength(2);
  expect(after.blocks.every((row) => row.status === 'active')).toBe(true);
  expect(after.hits).toHaveLength(2);
  expect(after.appeals).toHaveLength(1);
  expect(rows).toEqual([]);
}, 60_000);

it('[AC-B1-03zk#9] 调用方未提交事务里写入的申诉结果在事务内可见；事务外看不到，回滚后仍命中', async () => {
  const db = database();
  const s = await scene(db);
  const id = await seedBlock(db, s.f);
  await s.hit({ order_id: s.orderId, dimension: 'channel', value: 'R8', at: BEFORE });
  const appealId = await s.appeal({
    target_id: s.orderId,
    status: 'processing',
    closed_at: null,
  });
  let inside: Matches = [];
  let outside: Matches = [];
  await expect(
    db.transaction().execute(async (trx) => {
      await trx
        .updateTable('appeals')
        .set({ status: 'revoked', handler_id: 'fixture-handler', closed_at: CLOSED })
        .where('id', '=', appealId)
        .execute();
      inside = await s.f.ports.match(trx, s.query({ order_id: s.orderId }));
      outside = await s.match({ order_id: s.orderId });
      throw ABORT;
    }),
  ).rejects.toBe(ABORT);
  expect(outside).toEqual([channel(id)]);
  expect(await s.match({ order_id: s.orderId })).toEqual([channel(id)]);
  expect(inside).toEqual([]);
}, 60_000);

it('[AC-B1-03zk#9] 调用方未提交事务里写入的命中与申诉都按调用方句柄读到', async () => {
  const db = database();
  const s = await scene(db);
  await seedBlock(db, s.f);
  let inside: Matches = [];
  await db.transaction().execute(async (trx) => {
    s.f.clock.set(BEFORE);
    await s.f.ports.recordHit(trx, {
      app_id: s.f.app,
      user_id: null,
      order_id: s.orderId,
      dimension: 'channel',
      value: 'R8',
      risk_action: 'void_commission',
    });
    await trx
      .insertInto('appeals')
      .values({
        id: randomUUID(),
        app_id: s.f.app,
        user_id: s.user,
        target_type: 'order',
        target_id: s.orderId,
        status: 'revoked',
        content: 'fixture appeal',
        deadline_at: END,
        handler_id: 'fixture-handler',
        closed_at: CLOSED,
        created_at: START,
        updated_at: START,
      })
      .execute();
    inside = await s.f.ports.match(trx, s.query({ order_id: s.orderId }));
  });
  expect(inside).toEqual([]);
  expect(await s.match({ order_id: s.orderId })).toEqual([]);
}, 60_000);

it('[AC-B1-03zk#11] 豁免按名单值：同值多个条目全部不再生效，结案后才进名单的同值条目也不生效，不传 order_id 时照常命中', async () => {
  const db = database();
  const s = await scene(db);
  const first = await seedBlock(db, s.f, { end_at: END });
  const second = await seedBlock(db, s.f, { start_at: shift(START, -86_400_000) });
  const late = await s.lateChannel('R8');
  await s.exempt();
  expectEntries(await s.match(), [channel(first), channel(second), channel(late)]);
  expect(await s.match({ order_id: s.orderId })).toEqual([]);
}, 60_000);
