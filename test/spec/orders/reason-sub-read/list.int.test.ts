// B1-09y · 用户侧订单列表（GET /v1/orders 背后的共享查询）回填 reason_sub（D10-850 ②；契约 CT-24zx
// OrderSummary.reason_sub 可选可空；08 BR-TEXT-05「子原因 reason_sub」）。
// - 每单回填 orders.reason_sub；为 null 时不输出该键。
// - 父编码不是 PUNISH / REFUND / RIGHTS（含 null）时，库里有值也不输出。
// - 库里的值不属于当前父编码或不在 order_reason_sub 枚举内：不输出，并 warn 一次（alert 码 +
//   父编码 / 子原因编码，不带订单号 / 用户 / 金额）。
// - 只读：不写任何表，不改 reason / display_status / 金额；可见性规则不变。
// 每个用例都带一条合法子原因的对照单，所以在现实现（不读 reason_sub）上红在断言。
import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { at, fixture } from '../list-detail/kit.ts';
import { validate } from '../list-detail/schema-kit.ts';
import {
  BAD_PAIRS,
  OTHER_PARENTS,
  SUB_PARENTS,
  VALID_PAIRS,
  alertsFor,
  captureLogger,
  expectAlertsPrivate,
  itemOf,
  loggedQueries,
  voided,
} from './kit.ts';

// The global setup provides the migrated template; all fixture and query access is couli_app.
let database: TestDatabase | undefined;
let db: Kysely<DB>;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 4 });
}, 180_000);
afterAll(async () => {
  try {
    if (db) await destroyDb(db);
  } finally {
    await database?.drop();
  }
}, 30_000);

it('[AC-B1-09y#1] 自购列表：子原因表的 15 个 (父编码, 子原因) 每单原样回填 reason_sub，reason 不变，过契约，不告警', async () => {
  const f = await fixture(db);
  const log = captureLogger();
  const rows = [];
  for (const pair of VALID_PAIRS) {
    rows.push({ pair, row: await f.seed(voided(pair.reason, pair.reason_sub)) });
  }
  const q = await loggedQueries(f, log);
  const page = await q.list(f.subject, { scope: 'self', limit: 50 });
  expect(page.items).toHaveLength(VALID_PAIRS.length);
  for (const { pair, row } of rows) {
    const item = itemOf(page.items, row.order_id);
    expect(item).toHaveProperty('reason_sub', pair.reason_sub);
    expect(item.reason).toBe(pair.reason);
    expect(item.display_status).toBe('INVALID');
  }
  await validate({ code: 0, msg: '', trace_id: randomUUID(), data: page }, 'OrderListResponse');
  expect(log.alerts()).toEqual([]);
});

it('[AC-B1-09y#2] reason_sub 为 null 时列表项不输出该键（父编码 PUNISH / REFUND / RIGHTS / OTHER / null 都一样），同页合法单照常带', async () => {
  const f = await fixture(db);
  const log = captureLogger();
  const control = await f.seed(voided('PUNISH', 'FAKE_TRADE'));
  const nulls = [];
  for (const reason of [...SUB_PARENTS, 'OTHER']) nulls.push(await f.seed(voided(reason, null)));
  nulls.push(await f.seed({ reason: null, reason_sub: null }));
  const q = await loggedQueries(f, log);
  const page = await q.list(f.subject, { scope: 'self' });
  expect(page.items).toHaveLength(nulls.length + 1);
  expect(itemOf(page.items, control.order_id)).toHaveProperty('reason_sub', 'FAKE_TRADE');
  for (const row of nulls) {
    const item = itemOf(page.items, row.order_id);
    expect(item).not.toHaveProperty('reason_sub');
    expect(Object.keys(item)).not.toContain('reason_sub');
    expect(item.reason).toBe(row.reason);
  }
  await validate({ code: 0, msg: '', trace_id: randomUUID(), data: page }, 'OrderListResponse');
  expect(log.alerts()).toEqual([]);
});

it.each([...OTHER_PARENTS, null])(
  '[AC-B1-09y#3] 父编码 %s 不是 PUNISH / REFUND / RIGHTS：库里有子原因也不输出，同页合法单照常带',
  async (reason) => {
    const f = await fixture(db);
    const log = captureLogger();
    const control = await f.seed(voided('RIGHTS', 'AFTER_SALE'));
    const stored = [];
    for (const sub of ['FAKE_TRADE', 'IN_SALE', 'AFTER_SALE', 'PUNISH_ORDER']) {
      stored.push(
        await f.seed(reason === null ? { reason: null, reason_sub: sub } : voided(reason, sub)),
      );
    }
    const q = await loggedQueries(f, log);
    const page = await q.list(f.subject, { scope: 'self' });
    expect(page.items).toHaveLength(stored.length + 1);
    expect(itemOf(page.items, control.order_id)).toHaveProperty('reason_sub', 'AFTER_SALE');
    for (const row of stored) {
      const item = itemOf(page.items, row.order_id);
      expect(item).not.toHaveProperty('reason_sub');
      expect(item.reason).toBe(reason);
    }
    await validate({ code: 0, msg: '', trace_id: randomUUID(), data: page }, 'OrderListResponse');
  },
  30_000,
);

it('[AC-B1-09y#4] 库里的值不属于当前父编码或不在枚举内：不输出，每单 warn 恰一次（alert 码 + 父编码 / 子原因编码），不带订单号 / 用户 / 金额', async () => {
  const f = await fixture(db);
  const log = captureLogger();
  const control = await f.seed(voided('REFUND', 'IN_SALE'));
  const bad = [];
  for (const pair of BAD_PAIRS) {
    bad.push({ pair, row: await f.seed(voided(pair.reason, pair.reason_sub)) });
  }
  const q = await loggedQueries(f, log);
  const page = await q.list(f.subject, { scope: 'self', limit: 50 });
  expect(page.items).toHaveLength(BAD_PAIRS.length + 1);
  expect(itemOf(page.items, control.order_id)).toHaveProperty('reason_sub', 'IN_SALE');
  for (const { pair, row } of bad) {
    const item = itemOf(page.items, row.order_id);
    expect(item, `${pair.reason}/${pair.reason_sub}`).not.toHaveProperty('reason_sub');
    expect(item.reason).toBe(pair.reason);
    const label = `${pair.reason}/${pair.reason_sub}`;
    expect(alertsFor(log, pair.reason, pair.reason_sub), label).toHaveLength(1);
  }
  // One alert per bad order and none for the valid control.
  expect(log.alerts()).toHaveLength(BAD_PAIRS.length);
  expect(alertsFor(log, 'REFUND', 'IN_SALE')).toEqual([]);
  expectAlertsPrivate(log, [control, ...bad.map(({ row }) => row)]);
  await validate({ code: 0, msg: '', trace_id: randomUUID(), data: page }, 'OrderListResponse');
});

it.each(['same', 'other'] as const)(
  '[AC-B1-09y#5] 分享列表（%s 商品）同样回填 reason_sub；脱敏单号与他商品裁剪不变，null 不输出',
  async (kind) => {
    const f = await fixture(db);
    const log = captureLogger();
    const link = await f.link('jd:i_12345');
    const share = (patch: Parameters<typeof f.seed>[0]) =>
      f.seed({
        buy_type: 'share',
        link_id: link,
        product_key: kind === 'same' ? 'jd:i_12345' : 'jd:i_99999',
        parent_order_id: '3712345678901234567',
        ...patch,
      });
    const punished = await share(voided('PUNISH', 'SHOP_TK'));
    const refunded = await share(voided('REFUND', 'AFTER_SETTLE'));
    const none = await share(voided('RIGHTS', null));
    const q = await loggedQueries(f, log);
    const page = await q.list(f.subject, { scope: 'share' });
    expect(page.items).toHaveLength(3);
    for (const [row, sub] of [
      [punished, 'SHOP_TK'],
      [refunded, 'AFTER_SETTLE'],
      [none, null],
    ] as const) {
      const item = itemOf(page.items, row.order_id);
      if (sub === null) expect(item).not.toHaveProperty('reason_sub');
      else expect(item).toHaveProperty('reason_sub', sub);
      expect(item).toMatchObject({
        masked_order_no: '3712****67',
        is_other_product: kind !== 'same',
        reason: row.reason,
      });
      expect(item).not.toHaveProperty('order_no');
      if (kind === 'other') expect(item).toMatchObject({ title: null, image_url: null });
    }
    await validate({ code: 0, msg: '', trace_id: randomUUID(), data: page }, 'OrderListResponse');
    expect(log.alerts()).toEqual([]);
  },
  30_000,
);

it('[AC-B1-09y#6] 只回填：其余字段与 reason_sub=null 的孪生单逐字段相同；列表与详情读不写任何列、不加状态历史', async () => {
  const f = await fixture(db);
  const log = captureLogger();
  const figures = { est_rebate_fen: 150n, actual_fen: 0n, clawback_fen: 150n, b_est: 300n };
  const twins = [];
  for (const [reason, sub] of [
    ['PUNISH', 'MARKET_DISRUPT'],
    ['REFUND', 'IN_SALE'],
    ['RIGHTS', 'AFTER_SALE'],
  ] as const) {
    const withSub = await f.seed({ ...voided(reason, sub), quantity: 2 }, figures);
    const without = await f.seed({ ...voided(reason, null), quantity: 2 }, figures);
    twins.push({ sub, withSub, without });
  }
  const snapshot = async () => ({
    orders: await db
      .selectFrom('orders')
      .selectAll()
      .where('app_id', '=', f.subject.app_id)
      .orderBy('order_id')
      .execute(),
    history: await db
      .selectFrom('order_status_history')
      .select(({ fn }) => fn.countAll<string>().as('n'))
      .where('app_id', '=', f.subject.app_id)
      .executeTakeFirstOrThrow(),
  });
  const before = await snapshot();
  const q = await loggedQueries(f, log);
  const page = await q.list(f.subject, { scope: 'self' });
  for (const { sub, withSub, without } of twins) {
    const a = itemOf(page.items, withSub.order_id) as Record<string, unknown>;
    const b = itemOf(page.items, without.order_id) as Record<string, unknown>;
    expect(a).toHaveProperty('reason_sub', sub);
    expect(b).not.toHaveProperty('reason_sub');
    const strip = (item: Record<string, unknown>) => {
      const { order_id, order_no, paid_at, reason_sub, ...rest } = item;
      void order_id;
      void order_no;
      void paid_at;
      void reason_sub;
      return rest;
    };
    expect(strip(a)).toEqual(strip(b));
    expect(a).toMatchObject({ display_status: 'INVALID', est_rebate_fen: 150, quantity: 2 });
    expect(await q.get(f.subject, withSub.order_id)).toHaveProperty('reason_sub', sub);
    expect(await q.get(f.subject, without.order_id)).not.toHaveProperty('reason_sub');
  }
  expect(await snapshot()).toEqual(before);
});

it('[AC-B1-09y#7] 筛选、搜索、按月与翻页的每一页都回填；列值改了下一次读跟着变（不缓存首读）', async () => {
  const f = await fixture(db);
  const log = captureLogger();
  const expected = new Map<string, string | null>();
  const platforms = ['jd', 'taobao', 'pdd'] as const;
  for (const [index, platform] of platforms.entries()) {
    for (const pair of [...VALID_PAIRS.slice(index * 4, index * 4 + 4), null]) {
      const row = await f.seed({
        ...voided(pair?.reason ?? 'PUNISH', pair?.reason_sub ?? null),
        platform,
        title: `Sub Reason Item ${index}`,
        paid_at: at(`2027-12-1${index}T03:00:00.000Z`),
      });
      expected.set(row.order_id, pair?.reason_sub ?? null);
    }
  }
  const q = await loggedQueries(f, log);
  let carried = 0;
  const check = (items: readonly { order_id: string }[]) => {
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(expected.has(item.order_id)).toBe(true);
      const sub = expected.get(item.order_id) ?? null;
      if (sub === null) expect(item).not.toHaveProperty('reason_sub');
      else {
        expect(item).toHaveProperty('reason_sub', sub);
        carried += 1;
      }
    }
  };
  check((await q.list(f.subject, { scope: 'self', status_group: 'no_rebate' })).items);
  check((await q.list(f.subject, { scope: 'self', platform: 'taobao' })).items);
  check((await q.list(f.subject, { scope: 'self', q: 'sub reason item 1' })).items);
  check((await q.list(f.subject, { scope: 'self', paid_month: '2027-12' })).items);
  check((await q.list(f.subject, { scope: 'self', display_status: 'INVALID' })).items);
  const seen: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page += 1) {
    const result = await q.list(f.subject, {
      scope: 'self',
      limit: 2,
      ...(cursor === undefined ? {} : { cursor }),
    });
    check(result.items);
    seen.push(...result.items.map((item) => item.order_id));
    if (result.next_cursor === null) break;
    cursor = result.next_cursor;
  }
  expect([...seen].sort()).toEqual([...expected.keys()].sort());
  expect(carried).toBeGreaterThan(0);

  // settlement rewrites the column (B2-04zze): the next read follows, both ways.
  const subbed = [...expected.entries()].filter(([, sub]) => sub !== null).map(([id]) => id);
  const refined = subbed.at(0) ?? '';
  const cleared = subbed.at(1) ?? '';
  expect(refined).not.toBe('');
  expect(cleared).not.toBe('');
  await db
    .updateTable('orders')
    .set({ reason: 'PUNISH', reason_sub: 'RISK_ORDER' })
    .where('app_id', '=', f.subject.app_id)
    .where('order_id', '=', refined)
    .execute();
  await db
    .updateTable('orders')
    .set({ reason_sub: null })
    .where('app_id', '=', f.subject.app_id)
    .where('order_id', '=', cleared)
    .execute();
  const after = await q.list(f.subject, { scope: 'self', limit: 50 });
  expect(itemOf(after.items, refined)).toHaveProperty('reason_sub', 'RISK_ORDER');
  expect(itemOf(after.items, cleared)).not.toHaveProperty('reason_sub');
  expect(log.alerts()).toEqual([]);
}, 30_000);

it('[AC-B1-09y#8] 可见性不变：他人、别的 App、未归因单带子原因也不进列表；本人合法单照常回填', async () => {
  const f = await fixture(db);
  const log = captureLogger();
  const otherUser = await f.user();
  const otherAppUser = await f.user('foreign-app');
  const mine = await f.seed(voided('PUNISH', 'PROXY_BUY'));
  const hidden = [
    await f.seed({ ...voided('PUNISH', 'FAKE_TRADE'), user_id: otherUser }),
    await f.seed({ ...voided('REFUND', 'IN_SALE'), app_id: 'foreign-app', user_id: otherAppUser }),
    await f.seed({ reason: 'RIGHTS', reason_sub: 'AFTER_SALE', rebate_status: 'UNATTRIBUTED' }),
  ];
  const q = await loggedQueries(f, log);
  const page = await q.list(f.subject, { scope: 'self' });
  expect(page.items.map((item) => item.order_id)).toEqual([mine.order_id]);
  expect(itemOf(page.items, mine.order_id)).toHaveProperty('reason_sub', 'PROXY_BUY');
  for (const row of hidden) expect(await q.get(f.subject, row.order_id)).toBeNull();
  expect(log.alerts()).toEqual([]);
});
