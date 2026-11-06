// B1-09t · 订单列表项原样下发 orders.is_price_compare（BR-CALC-16，S-18，契约 CT-26p OrderSummary.is_price_compare）。
// 本单只「原样下发」：列为 true → 列表项 true；false → false；null（平台字段未核实、服务端不置位）→ null。
// 置位逻辑不在本单；本人自购单与分享单都照列下发；金额与 display_status 不因该字段改变；
// Agent 订单类工具的卡片（card_order_status）不带该字段。
import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { withHttp } from '../list-detail/http-kit.ts';
import { at, fixture, queries } from '../list-detail/kit.ts';
import { validate } from '../list-detail/schema-kit.ts';

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

const FLAGS = [true, false, null] as const;
type Flag = (typeof FLAGS)[number];

function itemOf<T extends { order_id: string }>(items: readonly T[], orderId: string): T {
  const found = items.find((item) => item.order_id === orderId);
  expect(found, `list item ${orderId}`).toBeDefined();
  return found as T;
}

it('[AC-B1-09t#1] 自购列表项原样带 is_price_compare：true / false / null 各自照列下发，键必须在', async () => {
  const f = await fixture(db);
  const rows = new Map<Flag, string>();
  for (const flag of FLAGS) rows.set(flag, (await f.seed({ is_price_compare: flag })).order_id);
  const q = await queries(f.deps);
  const page = await q.list(f.subject, { scope: 'self' });
  expect(page.items).toHaveLength(3);
  for (const flag of FLAGS) {
    const item = itemOf(page.items, rows.get(flag)!);
    expect(item).toHaveProperty('is_price_compare', flag);
  }
  await validate({ code: 0, msg: '', trace_id: randomUUID(), data: page }, 'OrderListResponse');
});

it.each(['same', 'other'] as const)(
  '[AC-B1-09t#2] 分享列表项（%s 商品）同样原样带 is_price_compare，投影裁剪不影响该字段',
  async (kind) => {
    const f = await fixture(db);
    const link = await f.link('jd:i_12345');
    const rows = new Map<Flag, string>();
    for (const flag of FLAGS) {
      const row = await f.seed({
        buy_type: 'share',
        link_id: link,
        product_key: kind === 'same' ? 'jd:i_12345' : 'jd:i_99999',
        parent_order_id: '3712345678901234567',
        is_price_compare: flag,
      });
      rows.set(flag, row.order_id);
    }
    const q = await queries(f.deps);
    const page = await q.list(f.subject, { scope: 'share' });
    expect(page.items).toHaveLength(3);
    for (const flag of FLAGS) {
      const item = itemOf(page.items, rows.get(flag)!);
      expect(item).toMatchObject({
        masked_order_no: '3712****67',
        is_other_product: kind !== 'same',
      });
      expect(item).toHaveProperty('is_price_compare', flag);
      expect(item).not.toHaveProperty('order_no');
    }
    await validate({ code: 0, msg: '', trace_id: randomUUID(), data: page }, 'OrderListResponse');
  },
);

it('[AC-B1-09t#3] 列表与详情的 is_price_compare 一致；标识不改金额、display_status、原因与其余投影', async () => {
  const f = await fixture(db);
  const figures = { est_rebate_fen: 150n, actual_fen: 150n, b_est: 300n };
  const ids = new Map<Flag, string>();
  for (const flag of FLAGS) {
    const row = await f.seed({ is_price_compare: flag, reason: 'BLACKLIST', quantity: 2 }, figures);
    ids.set(flag, row.order_id);
  }
  const q = await queries(f.deps);
  const page = await q.list(f.subject, { scope: 'self' });
  const shapes = [];
  for (const flag of FLAGS) {
    const orderId = ids.get(flag)!;
    const item = itemOf(page.items, orderId);
    const detail = await q.get(f.subject, orderId);
    expect(detail).not.toBeNull();
    expect(item).toHaveProperty('is_price_compare', flag);
    expect(item.is_price_compare).toBe(detail!.is_price_compare);
    expect(item.est_rebate_fen).toBe(150);
    expect(item.est_rebate_fen).toBe(detail!.est_rebate_fen);
    expect(item.display_status).toBe(detail!.display_status);
    const { order_id, order_no, paid_at, is_price_compare, ...rest } = item as Record<
      string,
      unknown
    >;
    void order_id;
    void order_no;
    void paid_at;
    void is_price_compare;
    shapes.push(rest);
  }
  // Every other field of the list item is the same whichever flag the row carries.
  expect(shapes).toHaveLength(3);
  expect(shapes[1]).toEqual(shapes[0]);
  expect(shapes[2]).toEqual(shapes[0]);
  expect(shapes[0]).toMatchObject({
    reason: 'BLACKLIST',
    pay_amount_fen: 12345,
    est_rebate_fen: 150,
    quantity: 2,
  });
});

it('[AC-B1-09t#4] 列值改了（订单同步按报文更新）后列表跟着变：null→true 加上，true→false 撤下，不缓存首读', async () => {
  const f = await fixture(db);
  const later = await f.seed({ is_price_compare: null });
  const revoked = await f.seed({ is_price_compare: true });
  const q = await queries(f.deps);
  const before = await q.list(f.subject, { scope: 'self' });
  expect(itemOf(before.items, later.order_id)).toHaveProperty('is_price_compare', null);
  expect(itemOf(before.items, revoked.order_id)).toHaveProperty('is_price_compare', true);
  for (const [orderId, flag] of [
    [later.order_id, true],
    [revoked.order_id, false],
  ] as const) {
    await db
      .updateTable('orders')
      .set({ is_price_compare: flag })
      .where('app_id', '=', f.subject.app_id)
      .where('order_id', '=', orderId)
      .execute();
  }
  const after = await q.list(f.subject, { scope: 'self' });
  expect(itemOf(after.items, later.order_id)).toHaveProperty('is_price_compare', true);
  expect(itemOf(after.items, revoked.order_id)).toHaveProperty('is_price_compare', false);
  // Only the tag moves: the status and amounts read the same before and after.
  for (const orderId of [later.order_id, revoked.order_id]) {
    const { is_price_compare: was, ...beforeRest } = itemOf(before.items, orderId) as Record<
      string,
      unknown
    >;
    const { is_price_compare: now, ...afterRest } = itemOf(after.items, orderId) as Record<
      string,
      unknown
    >;
    void was;
    void now;
    expect(afterRest).toEqual(beforeRest);
  }
});

it('[AC-B1-09t#5] 筛选、搜索与翻页的每一页都照列下发 is_price_compare', async () => {
  const f = await fixture(db);
  const seeded = new Map<string, Flag>();
  const platforms = ['jd', 'taobao', 'pdd'] as const;
  for (const [index, platform] of platforms.entries()) {
    for (const flag of FLAGS) {
      const row = await f.seed({
        platform,
        is_price_compare: flag,
        title: `Compare Item ${index}`,
        paid_at: at(`2027-12-1${index}T03:00:00.000Z`),
      });
      seeded.set(row.order_id, flag);
    }
  }
  const q = await queries(f.deps);
  const check = (items: readonly { order_id: string }[]) => {
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(seeded.has(item.order_id)).toBe(true);
      expect(item).toHaveProperty('is_price_compare', seeded.get(item.order_id));
    }
  };
  check((await q.list(f.subject, { scope: 'self', status_group: 'estimating' })).items);
  check((await q.list(f.subject, { scope: 'self', platform: 'taobao' })).items);
  check((await q.list(f.subject, { scope: 'self', q: 'compare item 1' })).items);
  check((await q.list(f.subject, { scope: 'self', paid_month: '2027-12' })).items);
  check((await q.list(f.subject, { scope: 'self', display_status: 'PAID' })).items);
  // Two-item pages until the end: every row comes back once, each with its own column value.
  const seen: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page += 1) {
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
  expect([...seen].sort()).toEqual([...seeded.keys()].sort());
});

it('[AC-B1-09t#6] HTTP GET /v1/orders 的 data.items 带 is_price_compare 且过契约；Agent 订单卡不带该字段', async () => {
  const f = await fixture(db);
  const link = await f.link('jd:i_12345');
  const self = await f.seed({ is_price_compare: true });
  const share = await f.seed({ buy_type: 'share', link_id: link, is_price_compare: false });
  const unset = await f.seed({ is_price_compare: null });
  const q = await queries(f.deps);
  await withHttp(q, f.subject, async (send) => {
    const selfBody = (await send('/v1/orders?scope=self')).json() as {
      data: { items: { order_id: string }[] };
    };
    expect(itemOf(selfBody.data.items, self.order_id)).toHaveProperty('is_price_compare', true);
    expect(itemOf(selfBody.data.items, unset.order_id)).toHaveProperty('is_price_compare', null);
    const shareResponse = await send('/v1/orders?scope=share');
    expect(shareResponse.statusCode).toBe(200);
    const shareBody = shareResponse.json() as { data: { items: { order_id: string }[] } };
    expect(itemOf(shareBody.data.items, share.order_id)).toHaveProperty('is_price_compare', false);
  });
  // BR-CALC-16 细则「标识」: the AI assistant's order card never shows the tag.
  const cards = await q.searchForAgent(f.subject, {
    date_from: '2027-12-01',
    date_to: '2027-12-31',
  });
  expect(cards.orders.map((card) => card.order_id).sort()).toEqual(
    [self.order_id, share.order_id, unset.order_id].sort(),
  );
  for (const card of cards.orders) expect(card).not.toHaveProperty('is_price_compare');
  const own = await q.findOwnByNumber(f.subject, { order_no: self.parent_order_id! });
  expect(own.map((card) => card.order_id)).toEqual([self.order_id]);
  for (const card of own) expect(card).not.toHaveProperty('is_price_compare');
}, 30_000);
