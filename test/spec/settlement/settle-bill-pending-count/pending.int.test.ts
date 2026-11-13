// B2-09zm / CT-24zzj, SPEC_REF 62b5c99, BR-FUND-04 月结账单状态 / D10-444 / D10-1402.
// Contract: AdminSettleBillAwaitingConfirm, AdminSettleBillStatus, listAdminSettleBills,
// AdminDashboardTodo. Real PG and admin HTTP entry; synthetic rows, existing B2-09d kit.
// Each test must fail on the unimplemented filter or count, never on a missing import.
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { expect, it } from 'vitest';
import {
  listAdminSettleBills,
  type AdminSettleBillListQuery,
} from '../../../../apps/api/src/modules/settlement/application/admin-settle-bills.ts';
import { countSettleBillPending } from '../../../../apps/api/src/modules/settlement/index.ts';
import {
  GENERATING,
  ago,
  allAudits,
  answer,
  fixture,
  footprint,
  later,
  page,
  reject,
  seedBatch,
  seedBill,
  suite,
  withSettleAdmin,
  type Fixture,
  type Page,
} from '../admin-settle-bills/kit.ts';

const s = suite();

function ids(result: Page): unknown[] {
  return result.items.map((item) => item['bill_id']);
}

function list(f: Fixture, query: AdminSettleBillListQuery) {
  return listAdminSettleBills({ db: f.db, now: () => f.clock.now() }, f.appId, query);
}

/** Two pending bills; every excluded branch has a bill of its own. */
async function seedMatrix(f: Fixture): Promise<void> {
  const pending = await seedBill(f, '2026-11');
  await seedBatch(f, pending);
  await seedBatch(f, pending, { platform: 'jd' }); // count bills, not DRAFT batches
  const mixed = await seedBill(f, '2026-10');
  await seedBatch(f, mixed);
  await seedBatch(f, mixed, { platform: 'jd', status: 'CONFIRMED' });
  const generating = await seedBill(f, '2026-09', GENERATING);
  await seedBatch(f, generating); // DRAFT alone cannot override generated_at=null
  const cancelled = await seedBill(f, '2026-08');
  await seedBatch(f, cancelled, { status: 'CANCELLED' });
  await seedBill(f, '2026-07'); // issued with no batches is not pending
  const states = ['CONFIRMED', 'EXECUTING', 'DONE', 'PARTIAL', 'CONFIRMED', 'CANCELLED'];
  for (const [index, status] of states.entries()) {
    const bill = await seedBill(f, `2026-0${6 - index}`);
    await seedBatch(f, bill); // old-round DRAFT never counts
    await seedBatch(f, bill, {
      kind: 'supplement',
      status,
      settle_mode: index === 0 ? 'SCHEDULED' : 'IMMEDIATE',
      created_at: ago(f, 5),
    });
  }
}

it('[AC-B2-09zm#1] 同一数据集的 HTTP 列表、total 与导出计数一致；只含最近一轮有 DRAFT 的已生成账单，混合批次算一张，排除生成中、空轮、全驳回及轮外 DRAFT', async () => {
  const f = fixture(s);
  await seedMatrix(f);
  const before = await footprint(f);
  await withSettleAdmin(f, async (h) => {
    const filtered = await page(await h.list({ awaiting_confirm: 'true' }));
    expect(ids(filtered)).toEqual(['2026-11', '2026-10']);
    expect(filtered.total).toBe(2);
    expect(filtered.items.map((item) => item['status'])).toEqual(['issued', 'issued']);
    expect(await countSettleBillPending(f.db, f.appId)).toBe(filtered.total);
    expect(await list(f, { awaiting_confirm: true })).toEqual(filtered);
  });
  expect(await footprint(f)).toEqual(before);
  expect(await allAudits(f)).toEqual([]);
});

it('[AC-B2-09zm#2] 主批次 DONE 后新增补充 DRAFT 从 0 变 1；补充轮全部驳回后回到 issued 但计数变 0，不能回退到较早轮的 DRAFT', async () => {
  const f = fixture(s);
  const bill = await seedBill(f, '2026-09');
  await seedBatch(f, bill, { status: 'DONE' });
  await withSettleAdmin(f, async (h) => {
    const check = async (expected: string[]) => {
      const data = await page(await h.list({ awaiting_confirm: 'true' }));
      expect(ids(data)).toEqual(expected);
      expect(data.total).toBe(expected.length);
      expect(await countSettleBillPending(f.db, f.appId)).toBe(data.total);
    };
    await check([]);
    await seedBatch(f, bill, { kind: 'supplement', created_at: ago(f, 20) });
    await check(['2026-09']);
    const latest = await seedBatch(f, bill, { kind: 'supplement', created_at: ago(f, 10) });
    await check(['2026-09']);
    await reject(f, latest);
    expect(ids(await page(await h.list({ status: 'issued' })))).toEqual(['2026-09']);
    await check([]);
  });
});

it('[AC-B2-09zm#3] awaiting_confirm 与 status、月份范围取交集；false 与缺省保持全量和原筛选结果', async () => {
  const f = fixture(s);
  await seedMatrix(f);
  await withSettleAdmin(f, async (h) => {
    const all = await page(await h.list());
    expect(all.total).toBe(11);
    expect(await page(await h.list({ awaiting_confirm: 'false' }))).toEqual(all);
    for (const status of ['issued', 'settled', 'scheduled', 'settling', 'generating']) {
      expect(await page(await h.list({ status, awaiting_confirm: 'false' }))).toEqual(
        await page(await h.list({ status })),
      );
      const data = await page(await h.list({ status, awaiting_confirm: 'true' }));
      const expected = status === 'issued' ? ['2026-11', '2026-10'] : [];
      expect(ids(data), status).toEqual(expected);
      expect(data.total, status).toBe(expected.length);
    }
    for (const [range, expected] of [
      [{ bill_from: '2026-11' }, ['2026-11']],
      [{ bill_to: '2026-10' }, ['2026-10']],
      [{ bill_from: '2026-10', bill_to: '2026-10' }, ['2026-10']],
      [{ bill_from: '2026-01', bill_to: '2026-09' }, []],
    ] as const) {
      const data = await page(await h.list({ ...range, awaiting_confirm: 'true' }));
      expect(ids(data)).toEqual(expected);
      expect(data.total).toBe(expected.length);
    }
    expect(await countSettleBillPending(f.db, f.appId)).toBe(2);
  });
});

it('[AC-B2-09zm#4] 过滤先于分页：page_size=1、缺省 20、越界页的 total 都为 23，计数不受页长截断', async () => {
  const f = fixture(s);
  const months = Array.from(
    { length: 23 },
    (_, index) => `${2025 + Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`,
  );
  for (const month of months) await seedBatch(f, await seedBill(f, month));
  await seedBill(f, '2026-12'); // newest bill has no candidate; must not consume a page slot
  const descending = [...months].reverse();
  await withSettleAdmin(f, async (h) => {
    const first = await page(await h.list({ awaiting_confirm: 'true' }));
    expect(ids(first)).toEqual(descending.slice(0, 20));
    expect(first.total).toBe(23);
    const count = await countSettleBillPending(f.db, f.appId);
    expect(count).toBe(first.total);
    for (const n of [1, 2, 23, 24]) {
      const data = await page(
        await h.list({ awaiting_confirm: 'true', page: String(n), page_size: '1' }),
      );
      expect(data).toMatchObject({ page: n, page_size: 1, total: count });
      expect(ids(data)).toEqual(descending.slice(n - 1, n));
    }
  });
});

it('[AC-B2-09zm#5] 跨 app 的同月批次不串用，另一应用独有待确认月份不泄露；空 app 计数为 0', async () => {
  const f = fixture(s);
  const foreign = fixture(s);
  const empty = fixture(s);
  await seedBatch(f, await seedBill(f, '2026-09'));
  await seedBill(f, '2026-10');
  await seedBatch(foreign, await seedBill(foreign, '2026-09'), { status: 'DONE' });
  await seedBatch(foreign, await seedBill(foreign, '2026-10'));
  await seedBatch(foreign, await seedBill(foreign, '2026-11'));
  for (const [app, expected] of [
    [f, ['2026-09']],
    [foreign, ['2026-11', '2026-10']],
    [empty, []],
  ] as const) {
    await withSettleAdmin(app, async (h) => {
      const data = await page(await h.list({ awaiting_confirm: 'true' }));
      expect(ids(data)).toEqual(expected);
      expect(data.total).toBe(expected.length);
      expect(await countSettleBillPending(app.db, app.appId)).toBe(data.total);
    });
  }
});

it('[AC-B2-09zm#6] 最近一轮沿用状态口径：所有 main 合轮；补充按平台与创建时刻合轮；同刻按最大 batch_id 决胜，不能只取最新一条批次', async () => {
  const f = fixture(s);
  const main = await seedBill(f, '2026-01');
  await seedBatch(f, main, { created_at: ago(f, 40) });
  await seedBatch(f, main, { platform: 'jd', status: 'DONE', created_at: ago(f, 10) });
  await seedBatch(f, main, { kind: 'supplement', status: 'DONE', created_at: ago(f, 20) });

  // Distinct UUIDs with known order, independent of insertion order.
  const low = () => `00000000${randomUUID().slice(8)}`;
  const high = () => `ffffffff${randomUUID().slice(8)}`;
  const grouped = await seedBill(f, '2026-02');
  await seedBatch(f, grouped, {
    kind: 'supplement',
    batch_id: low(),
    created_at: ago(f, 10),
  });
  await seedBatch(f, grouped, {
    kind: 'supplement',
    batch_id: high(),
    status: 'DONE',
    created_at: ago(f, 10),
  });

  for (const [month, draftWins] of [
    ['2026-03', false],
    ['2026-04', true],
  ] as const) {
    const bill = await seedBill(f, month);
    await seedBatch(f, bill, {
      kind: 'supplement',
      platform: 'jd',
      batch_id: high(),
      status: draftWins ? 'DRAFT' : 'DONE',
      created_at: ago(f, 10),
    });
    await seedBatch(f, bill, {
      kind: 'supplement',
      platform: 'taobao',
      batch_id: low(),
      status: draftWins ? 'DONE' : 'DRAFT',
      created_at: ago(f, 10),
    });
  }
  const separate = await seedBill(f, '2026-05');
  await seedBatch(f, separate, { kind: 'supplement', created_at: ago(f, 20) });
  await seedBatch(f, separate, {
    kind: 'supplement',
    status: 'DONE',
    created_at: ago(f, 10),
  });
  await withSettleAdmin(f, async (h) => {
    const data = await page(await h.list({ awaiting_confirm: 'true' }));
    expect(ids(data)).toEqual(['2026-04', '2026-02', '2026-01']);
    expect(data.total).toBe(3);
    expect(await countSettleBillPending(f.db, f.appId)).toBe(data.total);
  });
});

it('[AC-B2-09zm#7] 判定不受定时到期影响，计数可在 PG 只读事务反复调用；列表与计数不改表也不写审计', async () => {
  const f = fixture(s);
  await seedBatch(f, await seedBill(f, '2026-09'));
  const bill = await seedBill(f, '2026-10');
  await seedBatch(f, bill);
  const due = later(f, 5);
  await seedBatch(f, bill, {
    kind: 'supplement',
    status: 'CONFIRMED',
    settle_mode: 'SCHEDULED',
    scheduled_at: due,
    created_at: ago(f, 10),
  });
  const before = await footprint(f);
  await f.db.transaction().execute(async (trx) => {
    await sql`SET TRANSACTION READ ONLY`.execute(trx);
    for (const instant of [ago(f, 1), due, later(f, 60)]) {
      f.clock.set(instant);
      const count = await countSettleBillPending(trx, f.appId);
      expect(count).toBe(1);
      const data = await listAdminSettleBills({ db: trx, now: () => f.clock.now() }, f.appId, {
        awaiting_confirm: true,
      });
      expect(data.items.map((item) => item.bill_id)).toEqual(['2026-09']);
      expect(data.total).toBe(count);
    }
  });
  expect(await footprint(f)).toEqual(before);
  expect(await allAudits(f)).toEqual([]);
});

it('[AC-B2-09zm#8] HTTP 非布尔 awaiting_confirm 返回 20001 且 fields 精确指名；合法 true 必须真正筛掉无候选账单', async () => {
  const f = fixture(s);
  await seedBill(f, '2026-10');
  await seedBatch(f, await seedBill(f, '2026-09'));
  await withSettleAdmin(f, async (h) => {
    for (const value of ['yes', 'DRAFT', 'null', '1']) {
      await answer(await h.list({ awaiting_confirm: value }), 20001, {
        fields: ['awaiting_confirm'],
      });
    }
    const data = await page(await h.list({ awaiting_confirm: 'true' }));
    expect(ids(data)).toEqual(['2026-09']);
    expect(data.total).toBe(1);
  });
});

it('[AC-B2-09zm#9] 只有无候选 issued、generating 或轮外 DRAFT 的应用以及完全空应用，返回数字 0', async () => {
  const f = fixture(s);
  const empty = fixture(s);
  await seedBill(f, '2026-01');
  await seedBatch(f, await seedBill(f, '2026-02'), { status: 'CANCELLED' });
  await seedBatch(f, await seedBill(f, '2026-03', GENERATING));
  const old = await seedBill(f, '2026-04');
  await seedBatch(f, old);
  await seedBatch(f, old, { kind: 'supplement', status: 'DONE', created_at: ago(f, 5) });
  for (const app of [f, empty]) {
    const count = await countSettleBillPending(app.db, app.appId);
    expect(count).toBe(0);
    expect(await list(app, { awaiting_confirm: true })).toEqual({
      items: [],
      page: 1,
      page_size: 20,
      total: count,
    });
  }
});

it('[AC-B2-09zm#10] PG 创建时刻的微秒差不能被 Date 毫秒截断而合轮，时间顺序优先于 batch_id', async () => {
  const f = fixture(s);
  for (const [month, latestDraft] of [
    ['2026-08', false],
    ['2026-09', true],
  ] as const) {
    const bill = await seedBill(f, month);
    await seedBatch(f, bill, {
      kind: 'supplement',
      batch_id: `ffffffff${randomUUID().slice(8)}`,
      status: latestDraft ? 'DONE' : 'DRAFT',
      created_at: '2026-10-30T01:55:00.000001Z',
    });
    await seedBatch(f, bill, {
      kind: 'supplement',
      batch_id: `00000000${randomUUID().slice(8)}`,
      status: latestDraft ? 'DRAFT' : 'DONE',
      created_at: '2026-10-30T01:55:00.000002Z',
    });
  }
  await withSettleAdmin(f, async (h) => {
    const data = await page(await h.list({ awaiting_confirm: 'true' }));
    expect(ids(data)).toEqual(['2026-09']);
    expect(data.total).toBe(1);
    expect(await countSettleBillPending(f.db, f.appId)).toBe(data.total);
  });
});
