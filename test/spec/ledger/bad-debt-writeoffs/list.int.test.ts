// B2-12f list (claude-independent): contracts/openapi.yaml adminListBadDebtWriteoffs — the app's
// candidates, created_at descending then id descending; each row AdminBadDebtWriteoff with
// candidate_fen as generated, available_fen / frozen_fen the member's balance now, negative_days the
// current accounting day minus negative_since (derived), approve_blocked true only for a PENDING
// candidate whose member has frozen money while ledger.bad_debt_require_no_frozen.enabled is on;
// filters status and user_id with AND (a user_id that names nothing is an empty page); page /
// page_size ≤ 200 (a page past the last one is items=[]); total is the count of the filter set; a
// value outside an enum or pattern is 20001 with data.fields naming the parameter; reading writes no
// audit record. ⑪: the list is also the 人工追偿清单. Round 2 (review r1): negative_days across
// the +08:00 midnight at instants whose UTC date differs, written out by hand (#35). Top-level it()
// only (规划/11 §4.3).
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  DAY,
  SINCE,
  audits,
  candidateNow,
  credit,
  fixture,
  invalid,
  moneyOf,
  negativeMember,
  newAppId,
  newestFirst,
  pageOf,
  rowView,
  seedCandidate,
  suite,
  withWriteoffAdmin,
  type AdjustFixture,
  type CandidateRow,
  type Member,
} from './kit.ts';

const s = suite();

interface Seeded {
  readonly a: Member;
  readonly b: Member;
  readonly c: Member;
  readonly d: Member;
  readonly e: Member;
  readonly rows: Record<'a' | 'b' | 'c' | 'd' | 'e', CandidateRow>;
  readonly foreign: CandidateRow;
}

/**
 * Five candidates of the app and one of another app:
 * a PENDING (−800 since 2026-11-16, then +500 → −300), b APPROVED (−300 written off, frozen 500),
 * c CANCELLED (now +1000), d PENDING (−1000, frozen 1000: blocked), e PENDING (−50) with d's
 * created_at; the other app's is the newest of all.
 */
async function seedAll(f: AdjustFixture): Promise<Seeded> {
  const at = (iso: string) => new Date(iso);
  const a = await negativeMember(f, { available: -800n, since: '2026-11-16' });
  const rowA = await seedCandidate(f, a, { createdAt: at('2027-02-15T18:00:00.000Z') });
  await credit(f, a, 500n);
  const b = await negativeMember(f, { available: -300n, since: '2026-11-10', frozen: 500n });
  const rowB = await seedCandidate(f, b, {
    status: 'APPROVED',
    createdAt: at('2027-02-16T18:00:00.000Z'),
  });
  const c = await negativeMember(f, { available: -200n, since: '2026-11-12' });
  const rowC = await seedCandidate(f, c, {
    status: 'CANCELLED',
    createdAt: at('2027-02-17T18:00:00.000Z'),
  });
  await credit(f, c, 1200n);
  const d = await negativeMember(f, { available: -1000n, since: SINCE, frozen: 1000n });
  const rowD = await seedCandidate(f, d, { createdAt: at('2027-02-18T18:00:00.000Z') });
  const e = await negativeMember(f, { available: -50n, since: SINCE });
  const rowE = await seedCandidate(f, e, { createdAt: at('2027-02-18T18:00:00.000Z') });
  const stranger = await negativeMember(f, {
    available: -900n,
    since: SINCE,
    appId: newAppId(),
  });
  const foreign = await seedCandidate(f, stranger, { createdAt: at('2027-02-19T01:00:00.000Z') });
  return { a, b, c, d, e, rows: { a: rowA, b: rowB, c: rowC, d: rowD, e: rowE }, foreign };
}

/** The view of every seeded candidate (balances read now), by candidate id. */
async function views(f: AdjustFixture, seeded: Seeded): Promise<Map<string, unknown>> {
  const out = new Map<string, unknown>();
  for (const key of ['a', 'b', 'c', 'd', 'e'] as const) {
    const m = seeded[key];
    const row = await candidateNow(f, seeded.rows[key].id);
    const money = await moneyOf(f, m);
    const blocked = row.status === 'PENDING' && money.frozen > 0n;
    out.set(row.id, rowView(row, m, money, { day: DAY, blocked }));
  }
  return out;
}

function pick(all: Map<string, unknown>, ids: readonly string[]): unknown[] {
  return ids.map((id) => all.get(id));
}

it('[AC-B2-12f#26] 默认第一页：只列本 app 的五张候选单，created_at 倒序、同一时刻按 id 倒序；每行 candidate_fen 是生成时金额，available / frozen 是现在的余额，negative_days = 当天会计日 − negative_since，approve_blocked 只在 PENDING 且有冻结时为 true（开关默认 on）；page 1、page_size 20、total 5', async () => {
  const f = fixture(s);
  await withWriteoffAdmin(f, async (h) => {
    const seeded = await seedAll(f);
    const all = await views(f, seeded);
    const rows = Object.values(seeded.rows);
    const page = await pageOf(await h.list({}));
    expect({ page: page.page, page_size: page.page_size, total: page.total }).toEqual({
      page: 1,
      page_size: 20,
      total: 5,
    });
    expect(page.items).toEqual(pick(all, newestFirst(rows)));
    expect(page.items.map((item) => item['id'])).not.toContain(seeded.foreign.id);
    expect(all.get(seeded.rows.a.id)).toMatchObject({
      candidate_fen: 800,
      available_fen: -300,
      frozen_fen: 0,
      negative_since: '2026-11-16',
      negative_days: 95,
      approve_blocked: false,
    });
    expect(all.get(seeded.rows.b.id)).toMatchObject({
      status: 'APPROVED',
      available_fen: 0,
      frozen_fen: 500,
      approve_blocked: false,
    });
    expect(all.get(seeded.rows.d.id)).toMatchObject({
      negative_days: 91,
      frozen_fen: 1000,
      approve_blocked: true,
    });
  });
});

it('[AC-B2-12f#27] 筛选与分页：status=PENDING 三张、APPROVED 一张；user_id 只看该会员；status 与 user_id 同时给按 AND；不认识的 user_id 是空页；page_size=2 分三页，total 始终是筛选集的数，越过最后一页 items=[]；读不写审计', async () => {
  const f = fixture(s);
  await withWriteoffAdmin(f, async (h) => {
    const seeded = await seedAll(f);
    const all = await views(f, seeded);
    const rows = Object.values(seeded.rows);
    const ordered = newestFirst(rows);
    const pending = newestFirst(rows.filter((row) => row.status === 'PENDING'));

    const byStatus = await pageOf(await h.list({ status: 'PENDING' }));
    expect(byStatus.total).toBe(3);
    expect(byStatus.items).toEqual(pick(all, pending));
    const approved = await pageOf(await h.list({ status: 'APPROVED' }));
    expect(approved.items).toEqual(pick(all, [seeded.rows.b.id]));
    expect(approved.total).toBe(1);
    const ofC = await pageOf(await h.list({ user_id: seeded.c.userId }));
    expect(ofC.items).toEqual(pick(all, [seeded.rows.c.id]));
    expect(ofC.total).toBe(1);
    const both = await pageOf(await h.list({ status: 'PENDING', user_id: seeded.b.userId }));
    expect({ items: both.items, total: both.total }).toEqual({ items: [], total: 0 });
    const nobody = await pageOf(await h.list({ user_id: randomUUID() }));
    expect({ items: nobody.items, total: nobody.total }).toEqual({ items: [], total: 0 });

    const pages: unknown[][] = [];
    for (const page of ['1', '2', '3', '4']) {
      const sent = await pageOf(await h.list({ page, page_size: '2' }));
      expect({ page: sent.page, page_size: sent.page_size, total: sent.total }).toEqual({
        page: Number(page),
        page_size: 2,
        total: 5,
      });
      pages.push(sent.items);
    }
    expect(pages).toEqual([
      pick(all, ordered.slice(0, 2)),
      pick(all, ordered.slice(2, 4)),
      pick(all, ordered.slice(4)),
      [],
    ]);
    expect(await audits(f)).toEqual([]);
  });
});

it('[AC-B2-12f#28] 参数不合契约 → 20001 data.fields 指明参数：page_size 201、page 0、status 小写 pending、user_id 不是 uuid；之后合法查询照常', async () => {
  const f = fixture(s);
  await withWriteoffAdmin(f, async (h) => {
    const m = await negativeMember(f, { available: -800n, since: SINCE });
    const row = await seedCandidate(f, m);
    await invalid(await h.list({ page_size: '201' }), ['page_size']);
    await invalid(await h.list({ page: '0' }), ['page']);
    await invalid(await h.list({ status: 'pending' }), ['status']);
    await invalid(await h.list({ user_id: 'not-a-uuid' }), ['user_id']);
    const page = await pageOf(await h.list({ page_size: '200' }));
    expect(page.items).toEqual([
      rowView(row, m, await moneyOf(f, m), { day: DAY, blocked: false }),
    ]);
    expect(await audits(f)).toEqual([]);
  });
});

it('[AC-B2-12f#35] negative_days 按北京时间 00:00 日切：negative_since 2026-11-20 的候选单，2027-02-18T15:59:30Z（北京 02-18 23:59:30）列出 90 天；一分钟后 2027-02-18T16:00:30Z（北京 02-19 00:00:30，UTC 仍是 02-18）列出 91 天', async () => {
  const f = fixture(s, '2027-02-18T15:59:30.000Z');
  await withWriteoffAdmin(f, async (h) => {
    const m = await negativeMember(f, { available: -800n, since: '2026-11-20' });
    const row = await seedCandidate(f, m, { createdAt: new Date('2027-02-17T16:01:00.000Z') });
    const money = await moneyOf(f, m);

    const before = await pageOf(await h.list({}));
    expect(before.items).toEqual([rowView(row, m, money, { day: '2027-02-18', blocked: false })]);
    expect(before.items[0]).toMatchObject({ negative_since: '2026-11-20', negative_days: 90 });

    f.clock.set('2027-02-18T16:00:30.000Z');
    const after = await pageOf(await h.list({}));
    expect(after.items).toEqual([rowView(row, m, money, { day: '2027-02-19', blocked: false })]);
    expect(after.items[0]).toMatchObject({ negative_since: '2026-11-20', negative_days: 91 });
  });
});
