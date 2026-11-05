// B2-12c reads (claude-independent): adminListAdjustments (fund.adjust or fund.view, read only;
// filters reason_code / status / user_id combine with AND; created_at then adjust_id descending;
// page / page_size ≤ 200, a page past the last is items=[]; total is the filter set's count; a value
// outside an enum or pattern → 20001 data.fields; a user_id of nothing of the app → an empty page;
// 「已红冲」 from reversed_by_adjust_id) and adminGetAdjustment (balance_preview only for a PENDING form —
// amount the current available, 0 when it is not above 0 — and for an APPROVED form that is not a
// reversal, not reversed and whose member is not deleted — previewing its reversal; unknown or of
// another app → 20001 fields=[adjust_id]). Reading writes no audit record. Forms are seeded with
// their real vouchers (kit.ts); another app's forms never show.
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  ADJUST,
  answer,
  audits,
  fixture,
  formView,
  freeze,
  invalid,
  member,
  newAppId,
  newestFirst,
  normalizeForm,
  seedForm,
  seedPrefill,
  shift,
  suite,
  withAdjustAdmin,
  type AdjustFixture,
  type AdminSent,
  type FormRow,
} from './kit.ts';

const s = suite();

interface Page {
  readonly items: Record<string, unknown>[];
  readonly page: number;
  readonly page_size: number;
  readonly total: number;
}

async function pageOf(sent: AdminSent): Promise<Page> {
  const body = await answer(sent, 0);
  const data = body.data as Page;
  expect(Array.isArray(data.items), sent.body).toBe(true);
  return { ...data, items: data.items.map(normalizeForm) };
}

async function ids(sent: AdminSent): Promise<unknown[]> {
  return (await pageOf(sent)).items.map((item) => item['adjust_id']);
}

/** Seven forms of two members over five instants (two at the same instant) and one of another app. */
async function seedSeven(f: AdjustFixture) {
  const a = await member(f, { available: 50_000n });
  const b = await member(f, { available: 50_000n, status: 'deleting' });
  const f1 = await seedForm(f, {
    userId: a,
    direction: 'increase',
    amount: 500n,
    reason: 'RECON_FIX',
    createdAt: new Date(f.clock.now().getTime() - 50 * 60_000),
  });
  const f2 = await seedForm(f, {
    userId: a,
    reverses: f1,
    note: '整笔冲回',
    createdAt: new Date(f.clock.now().getTime() - 40 * 60_000),
  });
  const f3 = await seedForm(f, {
    userId: b,
    direction: 'decrease',
    amount: 10_000n,
    reason: 'PAYOUT_RECOVERY',
    contra: 'CASH_ALIPAY',
    refs: [
      { ref_type: 'withdrawal', ref_id: randomUUID() },
      { ref_type: 'recon_diff', ref_id: randomUUID() },
    ],
    createdAt: new Date(f.clock.now().getTime() - 30 * 60_000),
  });
  const f4 = await seedPrefill(f, b, {
    createdAt: new Date(f.clock.now().getTime() - 20 * 60_000),
  });
  const f5 = await seedPrefill(f, a, {
    status: 'REJECTED',
    createdAt: new Date(f.clock.now().getTime() - 10 * 60_000),
  });
  const tie = new Date(f.clock.now().getTime() - 5 * 60_000);
  const f6 = await seedForm(f, {
    userId: a,
    direction: 'increase',
    amount: 66n,
    reason: 'OTHER',
    contra: 'UNION_RECEIVABLE',
    platform: 'jd',
    refs: [],
    note: '客服处理说明：活动补发',
    createdAt: tie,
  });
  const f7 = await seedForm(f, {
    userId: a,
    direction: 'decrease',
    amount: 77n,
    reason: 'OTHER',
    contra: 'BAD_DEBT',
    createdAt: tie,
  });
  const otherApp = newAppId();
  const stranger = await member(f, { appId: otherApp, available: 1000n });
  const foreign = await seedForm(f, { userId: stranger, appId: otherApp });
  return { a, b, f1, f2, f3, f4, f5, f6, f7, all: [f1, f2, f3, f4, f5, f6, f7], foreign, stranger };
}

function reversedBy(rows: readonly FormRow[], row: FormRow): string | null {
  return rows.find((other) => other.reverses_adjust_id === row.adjust_id)?.adjust_id ?? null;
}

it('[AC-B2-12c#31] 列表：只列本 app 的单，created_at 倒序、同一时刻 adjust_id 倒序；每行与库一致（金额、单据、科目、说明、状态、经办人与时刻），原单的 reversed_by_adjust_id 指向红冲单；按原因码、状态、会员筛选（AND），total 为筛选集合数；待批数 = status=PENDING 的 total；读不写审计', async () => {
  const f = fixture(s);
  await withAdjustAdmin(f, async (h) => {
    const seeded = await seedSeven(f);
    const order = newestFirst(seeded.all);

    const all = await pageOf(await h.list());
    expect(all).toMatchObject({ page: 1, page_size: 20, total: 7 });
    expect(all.items).toEqual(
      order.map((id) => {
        const row = seeded.all.find((r) => r.adjust_id === id)!;
        return formView(row, reversedBy(seeded.all, row));
      }),
    );
    expect(all.items.find((item) => item['adjust_id'] === seeded.f1.adjust_id)).toMatchObject({
      reversed_by_adjust_id: seeded.f2.adjust_id,
    });

    const pick = (rows: readonly FormRow[]) => newestFirst(rows);
    const cases: [Record<string, string>, readonly FormRow[]][] = [
      [{ status: 'PENDING' }, [seeded.f4]],
      [{ status: 'REJECTED' }, [seeded.f5]],
      [{ reason_code: 'ACCOUNT_CLOSED' }, [seeded.f4, seeded.f5]],
      [{ reason_code: 'OTHER' }, [seeded.f6, seeded.f7]],
      [{ user_id: seeded.a }, [seeded.f1, seeded.f2, seeded.f5, seeded.f6, seeded.f7]],
      [{ user_id: seeded.a, status: 'APPROVED' }, [seeded.f1, seeded.f2, seeded.f6, seeded.f7]],
      [{ user_id: seeded.b, reason_code: 'PAYOUT_RECOVERY', status: 'APPROVED' }, [seeded.f3]],
      [{ user_id: seeded.b, reason_code: 'OTHER' }, []],
      [{ status: 'CANCELLED' }, []],
      [{ user_id: seeded.stranger }, []],
      [{ user_id: randomUUID() }, []],
    ];
    for (const [query, expected] of cases) {
      const page = await pageOf(await h.list(query));
      expect(
        page.items.map((item) => item['adjust_id']),
        JSON.stringify(query),
      ).toEqual(pick(expected));
      expect(page.total, JSON.stringify(query)).toBe(expected.length);
    }
    expect(await audits(f)).toEqual([]);
  });
});

it('[AC-B2-12c#32] 列表分页：page_size=2 依次取 4 页、第 5 页 items=[]（total 仍 7），翻页不重不漏；page_size 超 200、page 0、枚举外的状态或原因码、user_id 不是 UUID → 20001 fields 指明参数', async () => {
  const f = fixture(s);
  await withAdjustAdmin(f, async (h) => {
    const seeded = await seedSeven(f);
    const order = newestFirst(seeded.all);
    const seen: unknown[] = [];
    for (let page = 1; page <= 4; page += 1) {
      const got = await pageOf(await h.list({ page: String(page), page_size: '2' }));
      expect(got).toMatchObject({ page, page_size: 2, total: 7 });
      seen.push(...got.items.map((item) => item['adjust_id']));
    }
    expect(seen).toEqual(order);
    const past = await pageOf(await h.list({ page: '5', page_size: '2' }));
    expect(past).toMatchObject({ items: [], page: 5, page_size: 2, total: 7 });
    expect(await ids(await h.list({ page_size: '200' }))).toEqual(order);

    for (const [query, field] of [
      [{ page_size: '201' }, 'page_size'],
      [{ page: '0' }, 'page'],
      [{ status: 'DONE' }, 'status'],
      [{ reason_code: 'REFUND' }, 'reason_code'],
      [{ user_id: 'not-a-uuid' }, 'user_id'],
    ] as const) {
      await invalid(await h.list(query), [field]);
    }
  });
});

it('[AC-B2-12c#33] 详情 balance_preview：待批的注销预填单按当前 available 预览（2000 → 0；−300 与 0 时金额 0、前后不变）；已执行、未红冲、非红冲单、会员未注销的预览其整笔红冲（+500 原单、available 200 → −300；−10000 原单、available −7000 → 3000）；其余（已红冲的、红冲单、已驳回的、已注销会员的已执行单）为 null；adjustment 与列表行一致', async () => {
  const f = fixture(s);
  await withAdjustAdmin(f, async (h) => {
    const closing = await member(f, { available: 2000n, status: 'deleting' });
    const negative = await member(f, { status: 'deleting' });
    await shift(f, negative, -300n);
    const empty = await member(f, { status: 'deleting' });
    const a = await member(f);
    const b = await member(f, { available: 3000n });
    const gone = await member(f, { available: 1000n, status: 'deleted' });

    const pendingFull = await seedPrefill(f, closing);
    const pendingNegative = await seedPrefill(f, negative);
    const pendingEmpty = await seedPrefill(f, empty);
    const up = await seedForm(f, { userId: a, direction: 'increase', amount: 500n });
    await freeze(f, a, 300n);
    const down = await seedForm(f, {
      userId: b,
      direction: 'decrease',
      amount: 10_000n,
      reason: 'PAYOUT_RECOVERY',
      contra: 'CASH_ALIPAY',
      refs: [
        { ref_type: 'withdrawal', ref_id: randomUUID() },
        { ref_type: 'recon_diff', ref_id: randomUUID() },
      ],
    });
    const reversedOriginal = await seedForm(f, { userId: b, direction: 'increase', amount: 40n });
    const reversal = await seedForm(f, { userId: b, reverses: reversedOriginal });
    const rejected = await seedPrefill(f, a, { status: 'REJECTED' });
    const ofGone = await seedForm(f, { userId: gone, direction: 'increase', amount: 100n });

    const preview = (direction: string, amount: number, before: number, after: number) => ({
      direction,
      amount_fen: amount,
      available_before_fen: before,
      available_after_fen: after,
    });
    const cases: [FormRow, string | null, unknown][] = [
      [pendingFull, null, preview('decrease', 2000, 2000, 0)],
      [pendingNegative, null, preview('decrease', 0, -300, -300)],
      [pendingEmpty, null, preview('decrease', 0, 0, 0)],
      [up, null, preview('decrease', 500, 200, -300)],
      [down, null, preview('increase', 10_000, -7000, 3000)],
      [reversedOriginal, reversal.adjust_id, null],
      [reversal, null, null],
      [rejected, null, null],
      [ofGone, null, null],
    ];
    for (const [row, reversedById, expected] of cases) {
      const body = await answer(await h.detail(row.adjust_id), 0);
      const data = body.data as Record<string, unknown>;
      expect(Object.keys(data).sort(), row.adjust_id).toEqual(['adjustment', 'balance_preview']);
      expect(normalizeForm(data['adjustment']), row.adjust_id).toEqual(formView(row, reversedById));
      expect(data['balance_preview'], `${row.reason_code} ${row.status}`).toEqual(expected);
    }
    expect(await audits(f)).toEqual([]);
  });
});

it('[AC-B2-12c#34] 详情：不存在的 adjust_id、别的 app 的单、不是 UUID → 20001 fields=[adjust_id]（不是 404）；fund.adjust 也能读，两个读权限点都没有 → 10403；读不写审计', async () => {
  const f = fixture(s);
  await withAdjustAdmin(f, async (h) => {
    const userId = await member(f);
    const own = await seedForm(f, { userId, direction: 'increase', amount: 100n });
    const otherApp = newAppId();
    const foreign = await seedForm(f, {
      userId: await member(f, { appId: otherApp }),
      appId: otherApp,
    });
    for (const id of [randomUUID(), foreign.adjust_id, 'not-a-uuid']) {
      await invalid(await h.detail(id), ['adjust_id']);
    }
    const reader = await h.caller([ADJUST]);
    const body = await answer(await h.detail(own.adjust_id, reader), 0);
    expect(normalizeForm((body.data as Record<string, unknown>)['adjustment'])).toEqual(
      formView(own),
    );
    const nobody = await h.caller(['fund.recon']);
    await answer(await h.detail(own.adjust_id, nobody), 10403, {
      reason: 'admin_permission_denied',
    });
    await answer(await h.list({}, nobody), 10403, { reason: 'admin_permission_denied' });
    expect(await audits(f)).toEqual([]);
  });
});
