// B2-15z rule tests of the ownership check of POST /v1/pay/orders (claude-independent, SPEC_REF
// deaba4fb; 08 BR-PAY-01 ①④; rulings D10-1030 ②, D10-1155 ①, D10-1156 ①; HANDOFF:1206): after the
// switches and the platform check and before pricing, the business object must belong to the
// caller; false → 30901 biz_not_sellable (no difference between missing and someone else's), a
// hook that fails → 50001 (fail closed). Real api entry and PostgreSQL (../orders/kit.ts); the
// channels are FakePayChannel. Top-level it() only (规划/11 §4.3).
//
// The registry is built inside PaymentModule, so the hook is put in at createBizRegistry: the real
// registry of APP_ENV=test with `ownedBy` and `price` replaced by the test's own, read at each
// call. The order of the checks is observed through what those two record and through the channel,
// pay_orders and the queue, never through the call stack.
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { expect, it, vi } from 'vitest';
import type {
  BizPriceInput,
  BizTypeEntry,
  BizTypeRegistry,
} from '../../../../apps/api/src/modules/payment/application/biz-registry.ts';
import type { AppEnv } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  CHANNELS,
  TITLE,
  answer,
  attempts,
  conforms,
  createBody,
  enable,
  fixture,
  payOrders,
  seedOrder,
  setConfig,
  success,
  suite,
  withHttp,
  type Fixture,
  type OrderRow,
  type Platform,
  type Sent,
} from '../orders/kit.ts';

const harness = vi.hoisted(() => ({
  overrides: {} as Partial<Pick<BizTypeEntry, 'ownedBy' | 'price'>>,
}));

vi.mock(
  '../../../../apps/api/src/modules/payment/application/biz-registry.ts',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('../../../../apps/api/src/modules/payment/application/biz-registry.ts')
      >();
    const hooked = (entry: BizTypeEntry): BizTypeEntry => ({ ...entry, ...harness.overrides });
    return {
      ...actual,
      createBizRegistry(appEnv: AppEnv): BizTypeRegistry {
        const registry = actual.createBizRegistry(appEnv);
        return {
          get(code) {
            const entry = registry.get(code);
            return entry === undefined ? undefined : hooked(entry);
          },
          list() {
            return registry.list().map(hooked);
          },
        };
      },
    };
  },
);

const s = suite();
const NOT_SELLABLE = { reason: 'biz_not_sellable' } as const;

type OwnedBy = (input: BizPriceInput) => Promise<boolean>;

interface Spies {
  /** Every call of the ownership hook. */
  readonly owner: BizPriceInput[];
  /** Every call of the pricing of the business type. */
  readonly prices: BizPriceInput[];
}

/** Installs the hook for the next api entry and records the calls of it and of the pricing. */
function arrange(ownedBy: OwnedBy): Spies {
  const owner: BizPriceInput[] = [];
  const prices: BizPriceInput[] = [];
  harness.overrides = {
    ownedBy(input) {
      owner.push(input);
      return ownedBy(input);
    },
    price(input) {
      prices.push(input);
      return Promise.resolve({ amountFen: 1n, title: TITLE });
    },
  };
  return { owner, prices };
}

const owned: OwnedBy = () => Promise.resolve(true);
const notOwned: OwnedBy = () => Promise.resolve(false);

/** Jobs of queue `pay` that mention the fixture's app (every pay payload names its app_id). */
async function payJobCount(f: Fixture): Promise<number> {
  const result = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM pgboss.job
    WHERE name = 'pay' AND data::text LIKE ${`%${f.subject.app_id}%`}`.execute(f.db);
  return result.rows[0]?.n ?? 0;
}

/** No step of placing an order ran: no pricing, no new row, no attempt, no channel call, no job. */
async function nothingPlaced(f: Fixture, spies: Spies, before: readonly OrderRow[] = []) {
  expect(spies.prices).toEqual([]);
  expect(await payOrders(f)).toEqual(before);
  expect(await attempts(f)).toEqual([]);
  expect(f.channels.wechat_pay.createCalls()).toEqual([]);
  expect(f.channels.alipay.createCalls()).toEqual([]);
  expect(await payJobCount(f)).toBe(0);
}

/** A response as the client sees it, without the only part that is the request's own. */
function withoutTrace(sent: Sent) {
  return {
    status: sent.statusCode,
    body: sent.body.replace(/"trace_id":"[^"]*"/, '"trace_id":""'),
  };
}

it.each(CHANNELS)(
  '[AC-B2-15z#1] %s 别人的业务对象（ownedBy=false）：30901 biz_not_sellable，不定价、不建单、不写尝试、不调渠道、不入队',
  async (channel) => {
    const f = await fixture(s);
    await enable(f);
    const spies = arrange(notOwned);
    await withHttp(f, async (send) => {
      const sent = await send('create', { body: createBody(randomUUID(), channel) });
      await answer(sent, 30901, NOT_SELLABLE);
      expect(spies.owner).toHaveLength(1);
      await nothingPlaced(f, spies);
    });
  },
  60_000,
);

it('[AC-B2-15z#2] 本人的业务对象（ownedBy=true）：正常下单；钩子收到的 appId、userId 来自令牌，bizRef 来自请求体，每次下单只调一次', async () => {
  const f = await fixture(s);
  await enable(f);
  const spies = arrange(owned);
  const other = await f.stranger();
  const mine = randomUUID();
  const theirs = randomUUID();
  await withHttp(f, async (send) => {
    const first = await success(await send('create', { body: createBody(mine, 'wechat_pay') }));
    const second = await success(
      await send('create', { body: createBody(theirs, 'alipay'), subject: other }),
    );
    expect(first['launch']).toBeDefined();
    expect(second['launch']).toBeDefined();
    expect(spies.owner).toEqual([
      { appId: f.subject.app_id, userId: f.subject.user_id, bizRef: mine },
      { appId: other.app_id, userId: other.user_id, bizRef: theirs },
    ]);
    expect(spies.prices).toHaveLength(2);
    const rows = await payOrders(f);
    expect(rows.map((row) => [row.user_id, row.biz_ref]).sort()).toEqual(
      [
        [f.subject.user_id, mine],
        [other.user_id, theirs],
      ].sort(),
    );
    expect(f.channels.wechat_pay.createCalls()).toHaveLength(1);
    expect(f.channels.alipay.createCalls()).toHaveLength(1);
    expect(await payJobCount(f)).toBeGreaterThan(0);
  });
}, 60_000);

it('[AC-B2-15z#3] 已有本人 PENDING 单时再次下单 ownedBy=false：同样 30901，响应无 launch，已有单不变，不取调起参数', async () => {
  const f = await fixture(s);
  await enable(f);
  const pending = await seedOrder(f, {
    pay_channel: 'wechat_pay',
    launch_issued_at: new Date(f.clock.now().getTime() - 60_000),
  });
  const spies = arrange(notOwned);
  await withHttp(f, async (send) => {
    const sent = await send('create', { body: createBody(pending.biz_ref, 'wechat_pay') });
    await answer(sent, 30901, NOT_SELLABLE);
    expect(sent.body).not.toContain('launch');
    await nothingPlaced(f, spies, [pending]);
  });
}, 60_000);

it('[AC-B2-15z#4] 防探测：不存在的对象、别人有 PENDING 单的对象、别人有 PAID 单的对象，三种拒绝除 trace_id 外字节一致，且与不可售业务类型的答复一致', async () => {
  const f = await fixture(s);
  await enable(f);
  const stranger = await f.stranger();
  const foreignPending = await seedOrder(f, { user_id: stranger.user_id });
  const foreignPaid = await seedOrder(f, {
    user_id: stranger.user_id,
    status: 'PAID',
    paid_at: f.clock.now(),
  });
  const before = await payOrders(f);
  const spies = arrange(notOwned);
  await withHttp(f, async (send) => {
    const refusals: Sent[] = [];
    for (const bizRef of [randomUUID(), foreignPending.biz_ref, foreignPaid.biz_ref]) {
      const sent = await send('create', { body: createBody(bizRef, 'wechat_pay') });
      await answer(sent, 30901, NOT_SELLABLE);
      refusals.push(sent);
    }
    const unsellable = await send('create', {
      body: createBody(randomUUID(), 'wechat_pay', 'unknown_item'),
    });
    await answer(unsellable, 30901, NOT_SELLABLE);
    const expected = withoutTrace(unsellable);
    for (const refusal of refusals) expect(withoutTrace(refusal)).toEqual(expected);
    expect(spies.owner).toHaveLength(3);
    await nothingPlaced(f, spies, before);
  });
}, 60_000);

const LEAK = 'spec-owner-lookup-internal-detail';
type HookFailure = [string, OwnedBy];
const HOOK_FAILURES: HookFailure[] = [
  ['返回被拒绝的 Promise', () => Promise.reject(new Error(LEAK))],
  [
    '同步抛错',
    () => {
      throw new Error(LEAK);
    },
  ],
];

it.each(HOOK_FAILURES)(
  '[AC-B2-15z#5] 钩子失败（%s）：不捕获、答 50001，响应不含错误信息，不定价、不建单、不调渠道、不入队',
  async (_name, ownedBy) => {
    const f = await fixture(s);
    await enable(f);
    const spies = arrange(ownedBy);
    await withHttp(f, async (send) => {
      const sent = await send('create', { body: createBody(randomUUID(), 'wechat_pay') });
      expect(sent.statusCode, sent.body).toBe(500);
      expect(sent.json().code, sent.body).toBe(50001);
      expect(sent.body).not.toContain(LEAK);
      await conforms(sent);
      expect(spies.owner).toHaveLength(1);
      await nothingPlaced(f, spies);
    });
  },
  60_000,
);

interface Gate {
  readonly name: string;
  readonly config: ReadonlyArray<readonly [string, unknown]>;
  readonly platform: Platform;
  readonly reason: string;
}

const GATES: readonly Gate[] = [
  { name: 'pay.enabled off', config: [], platform: 'android', reason: 'pay_disabled' },
  {
    name: 'channel off',
    config: [['pay.enabled', true]],
    platform: 'android',
    reason: 'channel_disabled',
  },
  {
    name: 'platform not sellable',
    config: [
      ['pay.enabled', true],
      ['pay.channel_enabled.wechat_pay', true],
      ['pay.biz.test_item.platforms', ['android', 'harmony']],
    ],
    platform: 'ios',
    reason: 'platform_not_allowed',
  },
];

// The hook answers false throughout: a hook consulted before a gate would turn its reason into
// biz_not_sellable. The last part opens every gate, so that "not called" above cannot be vacuous.
it('[AC-B2-15z#6] 判定顺序：pay.enabled 关、渠道关、端不可售时先答原 reason，钩子未被调用；三项都通过后才调钩子', async () => {
  for (const gate of GATES) {
    const f = await fixture(s);
    for (const [key, value] of gate.config) await setConfig(f, key, value);
    const spies = arrange(notOwned);
    await withHttp(f, async (send) => {
      const sent = await send('create', {
        body: createBody(randomUUID(), 'wechat_pay'),
        platform: gate.platform,
      });
      await answer(sent, 30901, { reason: gate.reason });
      expect(spies.owner, gate.name).toEqual([]);
      await nothingPlaced(f, spies);
    });
  }
  const f = await fixture(s);
  await enable(f);
  const spies = arrange(notOwned);
  await withHttp(f, async (send) => {
    const sent = await send('create', { body: createBody(randomUUID(), 'wechat_pay') });
    await answer(sent, 30901, NOT_SELLABLE);
    expect(spies.owner).toHaveLength(1);
    await nothingPlaced(f, spies);
  });
}, 180_000);

it('[AC-B2-15z#7] 跨 app 隔离：两个 app 的同一 biz_ref，钩子按各自令牌的 app_id 调用，一个拒一个过，互不影响', async () => {
  const denied = await fixture(s);
  const allowed = await fixture(s);
  await enable(denied);
  await enable(allowed);
  const bizRef = randomUUID();
  const spies = arrange((input) => Promise.resolve(input.appId === allowed.subject.app_id));
  await withHttp(denied, async (send) => {
    await answer(await send('create', { body: createBody(bizRef, 'alipay') }), 30901, NOT_SELLABLE);
  });
  await withHttp(allowed, async (send) => {
    await success(await send('create', { body: createBody(bizRef, 'alipay') }));
  });
  expect(spies.owner).toEqual([
    { appId: denied.subject.app_id, userId: denied.subject.user_id, bizRef },
    { appId: allowed.subject.app_id, userId: allowed.subject.user_id, bizRef },
  ]);
  expect(spies.prices).toHaveLength(1);
  expect(await payOrders(denied)).toEqual([]);
  expect(denied.channels.alipay.createCalls()).toEqual([]);
  expect(await payJobCount(denied)).toBe(0);
  const rows = await payOrders(allowed);
  expect(rows.map((row) => [row.user_id, row.biz_ref])).toEqual([
    [allowed.subject.user_id, bizRef],
  ]);
  expect(allowed.channels.alipay.createCalls()).toHaveLength(1);
}, 60_000);

// 3xxxx answers are stored by platform idempotency (pay-orders.controller.ts header), so whether a
// replay consults the hook again is not part of the rule; every other step of placing an order is.
it('[AC-B2-15z#9] 同一幂等键不绕过：拒绝 30901 按既有语义存储，同键回放答同样字节；对象后来归属本人，同键也不下单', async () => {
  const f = await fixture(s);
  await enable(f);
  let belongs = false;
  const spies = arrange(() => Promise.resolve(belongs));
  const key = `pay-${randomUUID()}`;
  const body = createBody(randomUUID(), 'wechat_pay');
  await withHttp(f, async (send) => {
    const first = await send('create', { body, key });
    await answer(first, 30901, NOT_SELLABLE);
    const replay = await send('create', { body, key });
    expect(replay.statusCode).toBe(first.statusCode);
    expect(replay.body).toBe(first.body);
    belongs = true;
    const later = await send('create', { body, key });
    expect(later.statusCode).toBe(first.statusCode);
    expect(later.body).toBe(first.body);
    await nothingPlaced(f, spies);
  });
}, 60_000);
