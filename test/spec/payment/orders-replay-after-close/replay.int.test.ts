// B2-15y rule tests of the idempotent replay of POST /v1/pay/orders (claude-independent, SPEC_REF
// 865361d5; 08 BR-PAY-03: no launch parameters once the order is in the close flow or past
// expire_at; ruling D10-1067, FU-PAY-IDEM-REPLAY-AFTER-CLOSE). A replay of a stored code 0 answer
// looks the order up first: launchable (PENDING, closing=false, not past expire_at, the same test
// as the first order) → the stored bytes; PAID → 30902; anything else → 20902; no launch either
// way. Real api entry and PostgreSQL (../orders/kit.ts); the channels are FakePayChannel; the
// clock is the fixture's. Top-level it() only (规划/11 §4.3).
//
// A replay that "really read the order" is observed through a Kysely plugin on the app's database
// handle: it counts the reads of pay_orders and can make them fail, wherever they are issued.
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import type { KyselyPlugin, Updateable } from 'kysely';
import { expect, it } from 'vitest';
import type { PayChannelCode } from '../../../../apps/api/src/modules/payment/domain/types.ts';
import {
  CHANNELS,
  TTL_MS,
  answer,
  attempts,
  conflict,
  conforms,
  createBody,
  enable,
  fixture,
  holdingBizLock,
  lockKey,
  payOrder,
  payOrders,
  seedOrder,
  setConfig,
  success,
  suite,
  track,
  untilWaiting,
  withHttp,
  type Fixture,
  type Send,
  type Sent,
} from '../orders/kit.ts';

const s = suite();

// ---------------------------------------------------------------------------------------------
// The probe on the app's database handle (the test's own reads go through f.db, unprobed).

interface Probe {
  /** While true, every read of pay_orders by the app rejects. */
  fail: boolean;
  /** Reads of pay_orders by the app so far; the tests reset it before the request they observe. */
  reads: number;
}

function namesPayOrders(node: unknown): boolean {
  return JSON.stringify(node, (_key, value: unknown) =>
    typeof value === 'bigint' ? value.toString() : value,
  ).includes('pay_orders');
}

function probed(f: Fixture): { app: Fixture; probe: Probe } {
  const probe: Probe = { fail: false, reads: 0 };
  const plugin: KyselyPlugin = {
    transformQuery({ node }) {
      const kind: string = node.kind;
      if ((kind === 'SelectQueryNode' || kind === 'RawNode') && namesPayOrders(node)) {
        probe.reads += 1;
        if (probe.fail) throw new Error('synthetic pay_orders read failure');
      }
      return node;
    },
    async transformResult({ result }) {
      return result;
    },
  };
  return { app: { ...f, db: f.db.withPlugin(plugin) }, probe };
}

async function setup() {
  const f = await fixture(s);
  await enable(f);
  return { f, ...probed(f) };
}

// ---------------------------------------------------------------------------------------------
// Orders and what must not change.

/** A first order with a launch, under its own Idempotency-Key. */
async function placed(send: Send, channel: PayChannelCode, bizRef: string = randomUUID()) {
  const body = createBody(bizRef, channel);
  const key = `pay-${randomUUID()}`;
  const first = await send('create', { body, key });
  const data = await success(first);
  expect(data['launch'], first.body).toBeDefined();
  const id = data['pay_order_id'];
  expect(typeof id, first.body).toBe('string');
  return { body, key, first, data, id: id as string };
}

async function patchOrder(f: Fixture, id: string, patch: Updateable<DB['pay_orders']>) {
  await f.db
    .updateTable('pay_orders')
    .set({ ...patch, updated_at: f.clock.now() })
    .where('app_id', '=', f.subject.app_id)
    .where('id', '=', id)
    .execute();
}

type Advance = (f: Fixture, id: string, send: Send) => Promise<void>;
type State = { status: string; closing: boolean };

/** As the close flow leaves it (BR-PAY-05: the channel confirmed closed; closing cleared). */
const toClosed: Advance = (f, id) =>
  patchOrder(f, id, {
    status: 'CLOSED',
    closed_at: f.clock.now(),
    close_reason: 'user_cancel',
    closing: false,
  });

/** The user's cancel: the order stays PENDING with closing=true until the close job runs. */
const toClosing: Advance = async (_f, id, send) => {
  await success(await send('cancel', { id }));
};

/** No row write: only the clock moves past expire_at (the close job has not caught up). */
const toExpired: Advance = async (f) => {
  f.clock.advanceMs(TTL_MS + 1);
};

/** As the settlement leaves it (closing cleared). */
const toPaid: Advance = (f, id) =>
  patchOrder(f, id, {
    status: 'PAID',
    paid_at: f.clock.now(),
    channel_trade_no: `fake-trade-${randomUUID()}`,
    closing: false,
  });

const toPaidThenExpired: Advance = async (f, id, send) => {
  await toPaid(f, id, send);
  f.clock.advanceMs(TTL_MS + 1);
};

function idempotencyRows(f: Fixture) {
  return f.db
    .selectFrom('idempotency_keys')
    .selectAll()
    .where('app_id', '=', f.subject.app_id)
    .orderBy('id')
    .execute();
}

/** Everything a refused replay must leave alone (whole rows: status, closing, launch_issued_at…). */
async function world(f: Fixture) {
  return {
    orders: await payOrders(f),
    attempts: await attempts(f),
    idempotency: await idempotencyRows(f),
    createCalls: {
      wechat_pay: f.channels.wechat_pay.createCalls().length,
      alipay: f.channels.alipay.createCalls().length,
    },
  };
}

const SECRET_FIELDS = ['prepayid', 'noncestr', 'sign', 'order_str'];

function secretsOf(first: Record<string, unknown>): string[] {
  const launch = first['launch'] as Record<string, unknown>;
  const secrets = Object.entries(launch)
    .filter(([name]) => SECRET_FIELDS.includes(name))
    .map(([, value]) => String(value));
  expect(secrets.length).toBeGreaterThan(0);
  return secrets;
}

function noLaunch(sent: Sent, first: Record<string, unknown>) {
  expect(sent.body).not.toContain('launch');
  for (const secret of secretsOf(first)) expect(sent.body).not.toContain(secret);
}

/** What two answers must have in common (trace_id is the request's own). */
function essence(sent: Sent) {
  const { code, msg, data } = sent.json();
  return { code, msg, data };
}

/** Same key, same body, after `advance`: the exact refusal, no launch, nothing touched. */
async function replayRefused(
  channel: PayChannelCode,
  advance: Advance,
  state: State,
  code: number,
  dataOf: (id: string) => unknown,
) {
  const { f, app } = await setup();
  await withHttp(app, async (send, logs) => {
    const order = await placed(send, channel);
    await advance(f, order.id, send);
    expect(await payOrder(f, order.id)).toMatchObject(state);
    const before = await world(f);
    const sent = await send('create', { body: order.body, key: order.key });
    await answer(sent, code, dataOf(order.id));
    noLaunch(sent, order.data);
    expect(await world(f)).toEqual(before);
    const logged = logs.join('\n');
    for (const secret of secretsOf(order.data)) expect(logged).not.toContain(secret);
  });
}

// ---------------------------------------------------------------------------------------------
// Refusals.

type StateRow = [string, PayChannelCode, Advance, State];

const NOT_LAUNCHABLE: [string, Advance, State][] = [
  ['CLOSED', toClosed, { status: 'CLOSED', closing: false }],
  ['closing=true（仍 PENDING，关单流程中）', toClosing, { status: 'PENDING', closing: true }],
  ['PENDING 已过 expire_at（closing=false）', toExpired, { status: 'PENDING', closing: false }],
];

it.each(
  CHANNELS.flatMap((channel) =>
    NOT_LAUNCHABLE.map(([name, advance, state]): StateRow => [name, channel, advance, state]),
  ),
)(
  '[AC-B2-15y#1] BR-PAY-03：%s 的单（%s）回放 → 20902 data.resource=pay_order，不带 launch；不调渠道、不写 pay_query_attempts、不改支付单、不动 idempotency_keys',
  async (_name, channel, advance, state) => {
    await replayRefused(channel, advance, state, 20902, () => conflict);
  },
  60_000,
);

const PAID_ROWS: StateRow[] = [
  ['PAID', 'wechat_pay', toPaid, { status: 'PAID', closing: false }],
  ['PAID', 'alipay', toPaid, { status: 'PAID', closing: false }],
  ['PAID 且已过 expire_at', 'alipay', toPaidThenExpired, { status: 'PAID', closing: false }],
];

it.each(PAID_ROWS)(
  '[AC-B2-15y#2] BR-PAY-02 / 03：%s 的单（%s）回放 → 30902 data.pay_order_id=该单，不带 launch；不调渠道、不写 pay_query_attempts、不改支付单、不动 idempotency_keys',
  async (_name, channel, advance, state) => {
    await replayRefused(channel, advance, state, 30902, (id) => ({ pay_order_id: id }));
  },
  60_000,
);

it.each([
  ['closing=true', toClosing],
  ['PENDING 已过 expire_at', toExpired],
  ['PAID', toPaid],
] as [string, Advance][])(
  '[AC-B2-15y#3] %s 的回放与换新键对同一业务对象再下单答复一致（code、msg、data）',
  async (_name, advance) => {
    const { f, app } = await setup();
    await withHttp(app, async (send) => {
      const order = await placed(send, 'wechat_pay');
      await advance(f, order.id, send);
      const replay = await send('create', { body: order.body, key: order.key });
      const fresh = await send('create', { body: order.body, key: `pay-${randomUUID()}` });
      expect(essence(replay), replay.body).toEqual(essence(fresh));
      noLaunch(replay, order.data);
    });
  },
  60_000,
);

// ---------------------------------------------------------------------------------------------
// The launchable order keeps its replay, and the order is really looked up.

it.each(CHANNELS)(
  '[AC-B2-15y#4] 对照（%s）：PENDING、closing=false、未过 expire_at 的回放现查支付单后字节与首次完全相同（含 launch），状态不变、不调渠道',
  async (channel) => {
    const { f, app, probe } = await setup();
    await withHttp(app, async (send, logs) => {
      const order = await placed(send, channel);
      const before = await payOrder(f, order.id);
      expect(before.launch_issued_at, 'the first answer recorded its issue').not.toBeNull();
      // D10-1067: a byte-for-byte replay is not a new issue. The clock moves (still before
      // expire_at) so that rewriting launch_issued_at or updated_at with now shows in the row.
      f.clock.advanceMs(1_000);
      const unchanged = await world(f);
      probe.reads = 0;
      const replay = await send('create', { body: order.body, key: order.key });
      expect(replay.statusCode).toBe(order.first.statusCode);
      expect(replay.body).toBe(order.first.body);
      expect(probe.reads, 'the replay looks the order up before answering').toBeGreaterThan(0);
      const after = await payOrder(f, order.id);
      expect({ status: after.status, closing: after.closing, expire_at: after.expire_at }).toEqual({
        status: before.status,
        closing: before.closing,
        expire_at: before.expire_at,
      });
      expect(await payOrders(f)).toHaveLength(1);
      expect(await attempts(f)).toHaveLength(1);
      expect(f.channels[channel].createCalls()).toHaveLength(1);
      expect(await world(f)).toEqual(unchanged);
      const logged = logs.join('\n');
      for (const secret of secretsOf(order.data)) expect(logged).not.toContain(secret);
    });
  },
  60_000,
);

it('[AC-B2-15y#5] 边界（isPayOrderExpired，与首次下单口径一致）：expire_at 前 1 毫秒仍原样回放，恰好 now == expire_at 算已过期 → 20902 不带 launch', async () => {
  const { f, app } = await setup();
  await withHttp(app, async (send) => {
    const order = await placed(send, 'wechat_pay');
    const row = await payOrder(f, order.id);
    f.clock.set(new Date(row.expire_at.getTime() - 1));
    const inTime = await send('create', { body: order.body, key: order.key });
    expect(inTime.statusCode).toBe(order.first.statusCode);
    expect(inTime.body).toBe(order.first.body);
    f.clock.set(row.expire_at);
    const before = await world(f);
    const atExpiry = await send('create', { body: order.body, key: order.key });
    await answer(atExpiry, 20902, conflict);
    noLaunch(atExpiry, order.data);
    expect(await world(f)).toEqual(before);
  });
}, 60_000);

it.each(CHANNELS)(
  '[AC-B2-15y#6] 读单失败（%s）：数据库读支付单抛错 → 50001，响应体与日志都不含 launch，什么也不写；读恢复后可调起的单照旧原样回放',
  async (channel) => {
    const { f, app, probe } = await setup();
    await withHttp(app, async (send, logs) => {
      const order = await placed(send, channel);
      const before = await world(f);
      probe.fail = true;
      const sent = await send('create', { body: order.body, key: order.key });
      probe.fail = false;
      expect(sent.statusCode, sent.body).toBe(500);
      expect(sent.json().code, sent.body).toBe(50001);
      noLaunch(sent, order.data);
      await conforms(sent);
      const logged = logs.join('\n');
      for (const secret of secretsOf(order.data)) expect(logged).not.toContain(secret);
      expect(await world(f)).toEqual(before);
      const recovered = await send('create', { body: order.body, key: order.key });
      expect(recovered.body).toBe(order.first.body);
    });
  },
  60_000,
);

// ---------------------------------------------------------------------------------------------
// Isolation: only the caller's own order of this app decides.

type ForeignRow = [string, 'user' | 'app', 'PENDING' | 'PAID'];
const FOREIGN: ForeignRow[] = [
  ['同 app 他人的可调起单', 'user', 'PENDING'],
  ['同 app 他人的已支付单', 'user', 'PAID'],
  ['别的 app 的可调起单', 'app', 'PENDING'],
  ['别的 app 的已支付单', 'app', 'PAID'],
];

async function foreignOrder(f: Fixture, owner: 'user' | 'app', status: 'PENDING' | 'PAID') {
  const patch = { status, paid_at: status === 'PAID' ? f.clock.now() : null };
  if (owner === 'app') return seedOrder(await fixture(s), patch);
  return seedOrder(f, { ...patch, user_id: (await f.stranger()).user_id });
}

/**
 * Points the stored answer of `key` at another order (platform idempotency section 4: response is
 * {status, body}): the only way to make a replay name an order that is not the caller's, so that
 * "the lookup is by owner and app" can be observed at all.
 */
async function repointStored(f: Fixture, key: string, payOrderId: string) {
  const rows = (await idempotencyRows(f)).filter((row) => row.key === key);
  expect(rows).toHaveLength(1);
  const row = rows[0]!;
  const stored = row.response as unknown as { status: number; body: string };
  const envelope = JSON.parse(stored.body) as { data: Record<string, unknown> };
  envelope.data['pay_order_id'] = payOrderId;
  await f.db
    .updateTable('idempotency_keys')
    .set({ response: { status: stored.status, body: JSON.stringify(envelope) } })
    .where('id', '=', row.id)
    .execute();
}

it.each(FOREIGN)(
  '[AC-B2-15y#7] 隔离：存储答复指向%s 时按查无本人的单处理，不带 launch，不描述对方的单',
  async (_name, owner, status) => {
    const { f, app } = await setup();
    await withHttp(app, async (send) => {
      const order = await placed(send, 'wechat_pay');
      const foreign = await foreignOrder(f, owner, status);
      await repointStored(f, order.key, foreign.id);
      const before = await world(f);
      const sent = await send('create', { body: order.body, key: order.key });
      expect([20902, 50001], sent.body).toContain(sent.json().code);
      expect([409, 500], sent.body).toContain(sent.statusCode);
      noLaunch(sent, order.data);
      expect(sent.body).not.toContain(foreign.id);
      await conforms(sent);
      expect(await world(f)).toEqual(before);
    });
  },
  60_000,
);

it('[AC-B2-15y#8] 隔离：本人的单已 CLOSED、同一业务对象已被他人下了可调起的单，回放仍按本人的单 → 20902，不带 launch，不描述他人的单', async () => {
  const { f, app } = await setup();
  await withHttp(app, async (send) => {
    const order = await placed(send, 'wechat_pay');
    await toClosed(f, order.id, send);
    const stranger = await f.stranger();
    const foreign = await seedOrder(f, {
      user_id: stranger.user_id,
      biz_ref: order.body.biz_ref,
      pay_channel: 'wechat_pay',
    });
    const before = await world(f);
    const sent = await send('create', { body: order.body, key: order.key });
    await answer(sent, 20902, conflict);
    noLaunch(sent, order.data);
    expect(sent.body).not.toContain(foreign.id);
    expect(await world(f)).toEqual(before);
  });
}, 60_000);

it('[AC-B2-15y#9] 同一业务对象换了新单：旧键按旧单 CLOSED → 20902，新键照旧原样回放', async () => {
  const { f, app } = await setup();
  await withHttp(app, async (send) => {
    const old = await placed(send, 'alipay');
    await toClosed(f, old.id, send);
    const renewed = await placed(send, 'alipay', old.body.biz_ref);
    expect(renewed.id).not.toBe(old.id);
    const sent = await send('create', { body: old.body, key: old.key });
    await answer(sent, 20902, conflict);
    noLaunch(sent, old.data);
    noLaunch(sent, renewed.data);
    const again = await send('create', { body: renewed.body, key: renewed.key });
    expect(again.body).toBe(renewed.first.body);
  });
}, 60_000);

// ---------------------------------------------------------------------------------------------
// Stored refusals stay as stored; a refused replay is never written back.

it('[AC-B2-15y#10] 存储答复 30902（不是 code 0）的回放照旧原样、不现查支付单；同一张单 code 0 的旧键仍现查并答 30902', async () => {
  const { f, app, probe } = await setup();
  await withHttp(app, async (send) => {
    const order = await placed(send, 'wechat_pay');
    await toPaid(f, order.id, send);
    const paidKey = `pay-${randomUUID()}`;
    const stored = await send('create', { body: order.body, key: paidKey });
    await answer(stored, 30902, { pay_order_id: order.id });
    probe.reads = 0;
    const again = await send('create', { body: order.body, key: paidKey });
    expect(again.statusCode).toBe(stored.statusCode);
    expect(again.body).toBe(stored.body);
    expect(probe.reads, 'a stored 30902 is replayed without looking the order up').toBe(0);
    const sent = await send('create', { body: order.body, key: order.key });
    await answer(sent, 30902, { pay_order_id: order.id });
    noLaunch(sent, order.data);
  });
}, 60_000);

it('[AC-B2-15y#11] 存储答复 30901（不是 code 0）的回放照旧原样、不现查支付单；同一请求体 code 0 的键在单 CLOSED 后 → 20902', async () => {
  const f = await fixture(s);
  await enable(f);
  await setConfig(f, 'pay.biz.test_item.platforms', ['android', 'harmony']);
  const { app, probe } = probed(f);
  await withHttp(app, async (send) => {
    const body = createBody(randomUUID(), 'wechat_pay');
    const refusedKey = `pay-${randomUUID()}`;
    const stored = await send('create', { body, key: refusedKey, platform: 'ios' });
    await answer(stored, 30901, { reason: 'platform_not_allowed' });
    probe.reads = 0;
    const again = await send('create', { body, key: refusedKey, platform: 'ios' });
    expect(again.statusCode).toBe(stored.statusCode);
    expect(again.body).toBe(stored.body);
    expect(probe.reads, 'a stored 30901 is replayed without looking the order up').toBe(0);
    const order = await placed(send, 'wechat_pay', body.biz_ref);
    await toClosed(f, order.id, send);
    const sent = await send('create', { body: order.body, key: order.key });
    await answer(sent, 20902, conflict);
    noLaunch(sent, order.data);
  });
}, 60_000);

it('[AC-B2-15y#12] 不可调起的回放连续两次答复一致、不改写 idempotency_keys；之后单变 PAID，同一个键现查答 30902', async () => {
  const { f, app } = await setup();
  await withHttp(app, async (send) => {
    const order = await placed(send, 'wechat_pay');
    await toClosing(f, order.id, send);
    const before = await world(f);
    const first = await send('create', { body: order.body, key: order.key });
    await answer(first, 20902, conflict);
    noLaunch(first, order.data);
    const second = await send('create', { body: order.body, key: order.key });
    await answer(second, 20902, conflict);
    noLaunch(second, order.data);
    expect(essence(second)).toEqual(essence(first));
    expect(await world(f)).toEqual(before);
    await toPaid(f, order.id, send);
    const third = await send('create', { body: order.body, key: order.key });
    await answer(third, 30902, { pay_order_id: order.id });
    noLaunch(third, order.data);
    expect(await idempotencyRows(f)).toEqual(before.idempotency);
  });
}, 60_000);

// ---------------------------------------------------------------------------------------------
// The lookup and the close flow exclude each other under the business object lock.

it('[AC-B2-15y#13] BR-PAY-03（取参数与关单在同一把业务对象级锁内互斥）：回放等业务对象级锁，持锁期间单被置 closing=true 并提交，放锁后答 20902 data.resource=pay_order，不带 launch，其余不变', async () => {
  const { f, app } = await setup();
  await withHttp(app, async (send) => {
    const order = await placed(send, 'wechat_pay');
    const key = lockKey(f, order.body.biz_ref);
    const { sent, before } = await holdingBizLock(f, key, async (release) => {
      const replay = track(send('create', { body: order.body, key: order.key }));
      expect(await untilWaiting(f, key, 1, [replay]), 'the replay waits on the lock').toBe(true);
      await patchOrder(f, order.id, { closing: true, close_reason: 'user_cancel' });
      const snapshot = await world(f);
      expect(replay.settled, 'no answer while the lock is held').toBe(false);
      await release();
      return { sent: await replay.promise, before: snapshot };
    });
    expect(await payOrder(f, order.id)).toMatchObject({ status: 'PENDING', closing: true });
    await answer(sent, 20902, conflict);
    noLaunch(sent, order.data);
    expect(await world(f)).toEqual(before);
  });
}, 60_000);
