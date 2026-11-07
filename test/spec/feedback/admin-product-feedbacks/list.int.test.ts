// B1-28s list rule tests (claude-independent, SPEC_REF 18f0015e): adminListProductFeedbacks
// (GET /admin/v1/product-feedbacks, CT-26x, 编排 D10-757; 08 BR-ID-30 细则「商品反馈记录」). Only the
// caller's app's records (another app's never show and never count); each item exactly the
// contract's 12 fields, values as stored (amounts integer fen, null and empty kept, times to the
// millisecond), user_id null for a guest record and the submitter's UID otherwise, never a phone
// number, nickname, device identifier or app_id; filters platform, reason and the created_at window
// [from, to) combine with AND, times with any offset; from not earlier than to → 20001
// data.fields=[from, to], a value outside an enum or not a date-time → 20001 naming it; created_at
// descending, equal times in one server-internal order so pages neither repeat nor skip; page_size
// ≤ 200 (default 20), a page past the last is items=[]; total counts the filter set. Rows are written
// directly into app.product_feedbacks (kit.ts); requests go through the real admin entry.
// Top-level it() only (规划/11 §4.3).
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  ITEM_KEYS,
  REASONS,
  ago,
  fixture,
  invalid,
  newestFirst,
  normalize,
  page,
  seedFeedback,
  seedFeedbacks,
  seedMember,
  suite,
  view,
  withFeedbackAdmin,
  type Feedback,
  type FeedbackAdmin,
  type FeedbackSeed,
} from './kit.ts';

const s = suite();

/** 2^53 − 1: the largest fen a JSON integer carries exactly. */
const BIG = 9_007_199_254_740_991n;
const HOUR = 3_600_000;

/** The window of the filter tests: 2026-11-06 10:00 to 20:00 +08:00. */
const FROM = '2026-11-06T10:00:00+08:00';
const TO = '2026-11-06T20:00:00+08:00';
/** The same instants written in UTC. */
const FROM_Z = '2026-11-06T02:00:00Z';
const TO_Z = '2026-11-06T12:00:00.000Z';
const FROM_MS = Date.parse(FROM);
const TO_MS = Date.parse(TO);

async function expectList(
  h: FeedbackAdmin,
  query: Record<string, string>,
  expected: readonly Feedback[],
): Promise<void> {
  const got = await page(await h.list(query));
  expect(got.total, JSON.stringify(query)).toBe(expected.length);
  expect(got.items.map(normalize), JSON.stringify(query)).toEqual(newestFirst(expected).map(view));
}

it('[AC-B1-28s#4] app 隔离：只列本 app 的反馈，别的 app 的记录（同平台、同原因、同设备与同一 user_id、时间更新）不出现、不计入 total，筛选下也不出现；别的 app 的后台只看到它自己的', async () => {
  const f = fixture(s);
  const other = fixture(s);
  const device = randomUUID();
  const uid = randomUUID();
  const own = await seedFeedbacks(f, [
    { createdAt: ago(f, 50), deviceId: device, platform: 'jd', reason: 'rebate' },
    { createdAt: ago(f, 40), deviceId: device, userId: uid, platform: 'jd', reason: 'price' },
    { createdAt: ago(f, 30), platform: 'taobao', reason: 'info' },
  ]);
  const foreign = await seedFeedbacks(other, [
    { createdAt: ago(f, 45), deviceId: device, platform: 'jd', reason: 'rebate' },
    { createdAt: ago(f, 10), deviceId: device, userId: uid, platform: 'jd', reason: 'price' },
    { createdAt: ago(f, 5), platform: 'taobao', reason: 'info' },
    { createdAt: ago(f, 1), platform: 'pdd', reason: 'other' },
  ]);
  await withFeedbackAdmin(f, async (h) => {
    await expectList(h, {}, own);
    await expectList(h, { platform: 'jd' }, own.slice(0, 2));
    await expectList(h, { platform: 'pdd' }, []);
    await expectList(h, { reason: 'other' }, []);
    await expectList(h, { from: ago(f, 20).toISOString() }, []);
    const body = (await h.list({ page_size: '200' })).body;
    for (const row of foreign) expect(body, row.id).not.toContain(row.id);
    expect(body).not.toContain(other.appId);
  });
  await withFeedbackAdmin(other, async (h) => {
    await expectList(h, {}, foreign);
    const body = (await h.list({ page_size: '200' })).body;
    for (const row of own) expect(body, row.id).not.toContain(row.id);
  });
});

it('[AC-B1-28s#5] 字段：每项恰为契约 12 个字段；游客记录 user_id 为 null、登录用户记录为其 UID；金额（0、2^53−1）、时间（到毫秒）、可空字段（null、空串、1024 字符的 item_ref、100 字的说明）原样；整份响应查不到手机号、昵称、手机号摘要、device_id 与 app_id', async () => {
  const f = fixture(s);
  const member = await seedMember(f);
  const first = randomUUID();
  const second = randomUUID();
  const rows = await seedFeedbacks(f, [
    {
      deviceId: first,
      userId: null,
      platform: 'pdd',
      productKey: 'pdd:1234567890',
      itemRef: null,
      shownFinalPriceFen: 2990n,
      shownRebateFen: null,
      quotedAt: new Date('2026-11-05T02:00:00.123Z'),
      reason: 'price',
      note: null,
      createdAt: new Date('2026-11-05T02:01:00.456Z'),
    },
    {
      deviceId: first,
      userId: member.id,
      platform: 'taobao',
      productKey: 'tb:6543210',
      itemRef: `opaque-${'r'.repeat(1017)}`,
      shownFinalPriceFen: BIG,
      shownRebateFen: 0n,
      quotedAt: new Date('2026-11-05T02:20:00.007Z'),
      reason: 'rebate',
      note: '返'.repeat(100),
      createdAt: new Date('2026-11-05T02:21:00.999Z'),
    },
    {
      deviceId: second,
      userId: member.id,
      platform: 'jd',
      productKey: 'jd:100012345678',
      itemRef: 'a',
      shownFinalPriceFen: 0n,
      shownRebateFen: 120n,
      quotedAt: new Date('2026-11-05T03:00:00.000Z'),
      reason: 'info',
      note: '',
      createdAt: new Date('2026-11-05T03:00:00.001Z'),
    },
    {
      deviceId: second,
      userId: null,
      platform: 'douyin',
      productKey: 'dy:synthetic-77',
      reason: 'other',
      note: '页面信息不对',
      createdAt: new Date('2026-11-05T04:00:00.000Z'),
    },
  ]);
  expect(rows[1]!.itemRef).toHaveLength(1024);
  await withFeedbackAdmin(f, async (h) => {
    const sent = await h.list();
    const got = await page(sent);
    expect(got.total).toBe(4);
    for (const item of got.items) {
      expect(Object.keys(item).sort(), JSON.stringify(item)).toEqual([...ITEM_KEYS]);
    }
    expect(got.items.map(normalize)).toEqual(newestFirst(rows).map(view));
    const byId = new Map(got.items.map((item) => [item['id'], item]));
    expect(byId.get(rows[0]!.id)?.['user_id']).toBeNull();
    expect(byId.get(rows[3]!.id)?.['user_id']).toBeNull();
    expect(byId.get(rows[1]!.id)?.['user_id']).toBe(member.id);
    expect(byId.get(rows[2]!.id)?.['user_id']).toBe(member.id);
    expect(byId.get(rows[1]!.id)?.['shown_final_price_fen']).toBe(Number(BIG));
    expect(byId.get(rows[1]!.id)?.['shown_rebate_fen']).toBe(0);
    expect(byId.get(rows[0]!.id)?.['shown_rebate_fen']).toBeNull();
    expect(byId.get(rows[0]!.id)?.['item_ref']).toBeNull();
    expect(byId.get(rows[0]!.id)?.['note']).toBeNull();
    expect(byId.get(rows[2]!.id)?.['note']).toBe('');
    for (const value of [f.appId, first, second, member.nickname, member.phone, member.phoneHmac]) {
      expect(sent.body, value).not.toContain(value);
    }
  });
});

it('[AC-B1-28s#6] 筛选：platform、reason 各自生效且可组合（AND）；from 含、to 不含（恰在 from 的在、早 1 毫秒的不在；恰在 to 的不在、早 1 毫秒的在），只给一端也可；+08:00 与 UTC 写法同一时刻结果相同；与分页组合时 total 为筛选集合数；没有命中是空页', async () => {
  const f = fixture(s);
  const [r0, r1, r2, r3, r4, r5, r6, r7] = await seedFeedbacks(f, [
    { platform: 'jd', reason: 'price', createdAt: new Date(FROM_MS - 1) },
    { platform: 'jd', reason: 'rebate', createdAt: new Date(FROM_MS) },
    { platform: 'taobao', reason: 'rebate', createdAt: new Date(FROM_MS + HOUR) },
    { platform: 'jd', reason: 'rebate', createdAt: new Date(TO_MS - 1) },
    { platform: 'jd', reason: 'rebate', createdAt: new Date(TO_MS) },
    { platform: 'pdd', reason: 'info', createdAt: new Date(TO_MS + HOUR) },
    { platform: 'taobao', reason: 'other', createdAt: new Date(FROM_MS + 2 * HOUR) },
    { platform: 'jd', reason: 'price', createdAt: new Date(FROM_MS + 3 * HOUR) },
  ]);
  const all = [r0!, r1!, r2!, r3!, r4!, r5!, r6!, r7!];
  const other = fixture(s);
  await seedFeedbacks(other, [
    { platform: 'jd', reason: 'rebate', createdAt: new Date(FROM_MS + HOUR / 2) },
    { platform: 'jd', reason: 'rebate', createdAt: new Date(FROM_MS) },
  ]);
  const jd = [r0!, r1!, r3!, r4!, r7!];
  await withFeedbackAdmin(f, async (h) => {
    const cases: [Record<string, string>, Feedback[]][] = [
      [{}, all],
      [{ platform: 'jd' }, jd],
      [{ platform: 'taobao' }, [r2!, r6!]],
      [{ reason: 'rebate' }, [r1!, r2!, r3!, r4!]],
      [{ reason: 'price' }, [r0!, r7!]],
      [{ platform: 'jd', reason: 'rebate' }, [r1!, r3!, r4!]],
      [{ platform: 'taobao', reason: 'price' }, []],
      [{ platform: 'vip' }, []],
      [{ from: FROM }, [r1!, r2!, r3!, r4!, r5!, r6!, r7!]],
      [{ from: FROM_Z }, [r1!, r2!, r3!, r4!, r5!, r6!, r7!]],
      [{ to: TO }, [r0!, r1!, r2!, r3!, r6!, r7!]],
      [{ to: TO_Z }, [r0!, r1!, r2!, r3!, r6!, r7!]],
      [{ from: FROM, to: TO }, [r1!, r2!, r3!, r6!, r7!]],
      [{ from: FROM_Z, to: TO_Z }, [r1!, r2!, r3!, r6!, r7!]],
      [{ from: TO }, [r4!, r5!]],
      [{ to: FROM }, [r0!]],
      [{ from: new Date(TO_MS - 1).toISOString(), to: TO }, [r3!]],
      [{ platform: 'jd', reason: 'rebate', from: FROM, to: TO }, [r1!, r3!]],
      [{ platform: 'jd', reason: 'price', from: FROM, to: TO }, [r7!]],
      [{ platform: 'pdd', reason: 'info', from: FROM, to: TO }, []],
    ];
    for (const [query, expected] of cases) await expectList(h, query, expected);

    const second = await page(await h.list({ platform: 'jd', page: '2', page_size: '2' }));
    expect({ page: second.page, page_size: second.page_size, total: second.total }).toEqual({
      page: 2,
      page_size: 2,
      total: 5,
    });
    expect(second.items.map(normalize)).toEqual(newestFirst(jd).slice(2, 4).map(view));
    const last = await page(
      await h.list({ reason: 'rebate', from: FROM, to: TO, page: '2', page_size: '2' }),
    );
    expect({ total: last.total, ids: last.items.map((item) => item['id']) }).toEqual({
      total: 3,
      ids: [r1!.id],
    });
  });
});

it('[AC-B1-28s#7] 参数被拒：from 等于 to（含不同写法的同一时刻）或晚于 to → 20001 data.fields=[from, to]（带其他筛选也一样）；平台、原因不在枚举内（含大小写不同）→ 20001 指名该参数；from / to 不是带时区的日期时间 → 20001 指名该参数；page_size 0 或超过 200、page 0 → 20001 指名该参数；from 早 to 1 毫秒可以', async () => {
  const f = fixture(s);
  const row = await seedFeedback(f, { createdAt: new Date(FROM_MS) });
  const RANGE = ['from', 'to'];
  await withFeedbackAdmin(f, async (h) => {
    await invalid(await h.list({ from: FROM, to: FROM }), RANGE);
    await invalid(await h.list({ from: FROM, to: FROM_Z }), RANGE);
    await invalid(await h.list({ from: TO, to: FROM }), RANGE);
    await invalid(await h.list({ from: '2026-11-06T10:00:00.001+08:00', to: FROM }), RANGE);
    await invalid(
      await h.list({ platform: 'jd', reason: 'price', from: TO_Z, to: FROM_Z, page: '1' }),
      RANGE,
    );
    for (const [query, field] of [
      [{ platform: 'amazon' }, 'platform'],
      [{ platform: 'JD' }, 'platform'],
      [{ reason: 'refund' }, 'reason'],
      [{ reason: 'PRICE' }, 'reason'],
      [{ from: 'yesterday' }, 'from'],
      [{ to: '2026-11-06' }, 'to'],
      [{ page_size: '201' }, 'page_size'],
      [{ page_size: '0' }, 'page_size'],
      [{ page: '0' }, 'page'],
    ] as const) {
      await invalid(await h.list(query), [field]);
    }
    const edge = await page(
      await h.list({ from: FROM, to: '2026-11-06T10:00:00.001+08:00', page_size: '200' }),
    );
    expect({ page_size: edge.page_size, total: edge.total }).toEqual({ page_size: 200, total: 1 });
    expect(edge.items.map(normalize)).toEqual([view(row)]);
  });
});

it('[AC-B1-28s#8] 排序与分页：created_at 降序；12 条同一 created_at 的记录按 page_size 3、5 翻完所有页恰好得到全集，不重不漏，三种页长得到同一顺序；每页 page / page_size / total 照实；最后一页之后是 items=[]（total 不变）', async () => {
  const f = fixture(s);
  const tie = ago(f, 60);
  const later = await seedFeedback(f, { createdAt: new Date(tie.getTime() + 10 * 60_000) });
  const tied = await seedFeedbacks(
    f,
    Array.from({ length: 12 }, (_, i): FeedbackSeed => ({
      createdAt: tie,
      platform: i % 2 === 0 ? 'jd' : 'taobao',
      reason: REASONS[i % REASONS.length]!,
    })),
  );
  const earlier = await seedFeedback(f, { createdAt: new Date(tie.getTime() - 10 * 60_000) });
  const everything = [later, ...tied, earlier];
  const byId = new Map(everything.map((row) => [row.id, row]));
  const TOTAL = everything.length;
  await withFeedbackAdmin(f, async (h) => {
    const walk = async (size: number): Promise<string[]> => {
      const seen: Record<string, unknown>[] = [];
      const pages = Math.ceil(TOTAL / size);
      for (let n = 1; n <= pages; n += 1) {
        const got = await page(await h.list({ page: String(n), page_size: String(size) }));
        expect({ page: got.page, page_size: got.page_size, total: got.total }).toEqual({
          page: n,
          page_size: size,
          total: TOTAL,
        });
        const length = Math.min(size, TOTAL - (n - 1) * size);
        expect(got.items, `page ${n} of ${size}`).toHaveLength(length);
        seen.push(...got.items);
      }
      const past = await page(await h.list({ page: String(pages + 1), page_size: String(size) }));
      expect(past).toEqual({ items: [], page: pages + 1, page_size: size, total: TOTAL });
      const order = seen.map((item) => String(item['id']));
      expect(new Set(order).size, `page_size ${size}: no repeats`).toBe(TOTAL);
      expect([...order].sort()).toEqual(everything.map((row) => row.id).sort());
      for (const item of seen) {
        expect(normalize(item)).toEqual(view(byId.get(String(item['id']))!));
      }
      const times = seen.map((item) => Date.parse(String(item['created_at'])));
      for (let i = 1; i < times.length; i += 1) {
        expect(times[i]!, `created_at descending at ${i}`).toBeLessThanOrEqual(times[i - 1]!);
      }
      expect(order[0]).toBe(later.id);
      expect(order[TOTAL - 1]).toBe(earlier.id);
      return order;
    };
    const byThree = await walk(3);
    const byFive = await walk(5);
    const whole = (await page(await h.list({ page_size: '200' }))).items.map((item) =>
      String(item['id']),
    );
    expect(byFive).toEqual(byThree);
    expect(whole).toEqual(byThree);
  });
});

it('[AC-B1-28s#9] 页长：默认 page 1 / page_size 20；page_size 200 一页取 200 条、第 2 页取剩下 1 条、第 3 页为空，total 恒为 201；page_size 1 的第 201 页是最早的一条；page_size 201 → 20001 [page_size]', async () => {
  const f = fixture(s);
  const rows = await seedFeedbacks(
    f,
    Array.from({ length: 201 }, (_, i): FeedbackSeed => ({ createdAt: ago(f, 1 + i) })),
  );
  const order = newestFirst(rows).map((row) => row.id);
  await withFeedbackAdmin(f, async (h) => {
    const first = await page(await h.list());
    expect({ page: first.page, page_size: first.page_size, total: first.total }).toEqual({
      page: 1,
      page_size: 20,
      total: 201,
    });
    expect(first.items.map((item) => item['id'])).toEqual(order.slice(0, 20));
    const big = await page(await h.list({ page: '1', page_size: '200' }));
    expect({ page_size: big.page_size, total: big.total }).toEqual({ page_size: 200, total: 201 });
    expect(big.items.map((item) => item['id'])).toEqual(order.slice(0, 200));
    const rest = await page(await h.list({ page: '2', page_size: '200' }));
    expect({ total: rest.total, ids: rest.items.map((item) => item['id']) }).toEqual({
      total: 201,
      ids: order.slice(200),
    });
    expect(await page(await h.list({ page: '3', page_size: '200' }))).toEqual({
      items: [],
      page: 3,
      page_size: 200,
      total: 201,
    });
    const oldest = await page(await h.list({ page: '201', page_size: '1' }));
    expect(oldest.items.map(normalize)).toEqual([view(newestFirst(rows)[200]!)]);
    await invalid(await h.list({ page_size: '201' }), ['page_size']);
  });
});
