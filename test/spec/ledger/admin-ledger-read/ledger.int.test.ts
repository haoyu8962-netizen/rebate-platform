// B2-02u ledger list rule tests (claude-independent, SPEC_REF 39756e36): contracts/openapi.yaml
// adminListLedgerEntries; 08 BR-FUND-13, BR-FUND-15, BR-FUND-16; D10-1057. Only the entries of the
// user's USER_BALANCE account in the console's app, both sub-accounts, one row per entry; booked_at
// then entry_id descending; amount_fen signed from the user's view (the same sign as GET
// /v1/wallet/ledger gives the same entry); balance_after_fen as stored; voucher fields from
// ledger_vouchers; link by biz_type (ORDER_CREDIT / ORDER_CLAWBACK / ORDER_SETTLE_ADJUST → order,
// withdrawal → withdrawal, admin_adjustment → adjustment, bad_debt_writeoff → writeoff, anything
// else → null; an order is named by its order key or its order_id). All 13 ledger types. Filters ledger_type / sub_type / sub_account / accounting_date_from–to (inclusive, the
// voucher's accounting date) / ref (exact biz_id) combine; page / page_size (≤ 200) / total.
// Requests go through the real admin entry (kit.ts). Top-level it() only (规划/11 §4.3).
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { getWalletLedger } from '../../../../apps/api/src/modules/ledger/application/wallet-ledger.ts';
import {
  AT_1,
  AT_2,
  AT_4,
  LEDGER_TYPES,
  NOW,
  credit,
  fieldsError,
  fixture,
  openMember,
  orderLinksByKey,
  pageOf,
  post,
  seedAllTypes,
  seedStory,
  shown,
  storyRows,
  suite,
  withLedgerAdmin,
  type Fixture,
  type Story,
} from './kit.ts';

const s = suite();

async function story(f: Fixture): Promise<Story> {
  return seedStory(f, { a: await openMember(f), b: await openMember(f) });
}

it('[AC-B2-02u#9] 流水：只含该用户余额账户 available 与 frozen 两子户的分录（不含平台科目、同 app 别的用户），booked_at 倒序、同一时刻 entry_id 倒序、同一凭证的分录相邻；金额按用户视角带符号，balance_after_fen 原值，voucher 四字段取凭证，link 按 biz_type 映射', async () => {
  const f = fixture(s);
  const st = await story(f);
  const rows = await storyRows(f, st);
  // v4 and v5 share one instant: v5 was posted later, so its entries have the larger ids.
  const want = [...rows.v5, ...rows.v4, ...rows.v3, ...rows.v2, ...rows.v1];
  await withLedgerAdmin(f, async (h) => {
    const page = await pageOf(await h.ledger({ user_id: st.a.userId }));
    expect(page.items).toEqual(want);
    expect({ page: page.page, page_size: page.page_size, total: page.total }).toEqual({
      page: 1,
      page_size: 20,
      total: 6,
    });
    // Hand-written user-view amounts of the story (credit positive, debit negative); the two
    // WITHDRAW_FREEZE entries follow their entry ids, checked by the equality above.
    const lines = page.items.map(
      (item) =>
        `${String(item['ledger_type'])}|${String(item['sub_account'])}|${String(item['amount_fen'])}`,
    );
    expect([lines[0], lines[1], lines[4], lines[5]]).toEqual([
      'CLAWBACK|available|-100',
      'ADMIN_ADJUST|available|200',
      'REFERRAL_CREDIT|available|300',
      'REBATE_CREDIT|available|1000',
    ]);
    expect([lines[2], lines[3]].sort()).toEqual([
      'WITHDRAW_FREEZE|available|-500',
      'WITHDRAW_FREEZE|frozen|500',
    ]);
    expect(page.items.map((item) => item['link'])).toEqual([
      null,
      { type: 'adjustment', id: st.v4.bizId },
      { type: 'withdrawal', id: st.v3.bizId },
      { type: 'withdrawal', id: st.v3.bizId },
      null,
      null,
    ]);
    // The neighbour's ledger is only its own entry.
    const neighbour = await pageOf(await h.ledger({ user_id: st.b.userId }));
    expect(neighbour.total).toBe(1);
    expect(neighbour.items.map((item) => [item['ledger_type'], item['amount_fen']])).toEqual([
      ['REBATE_CREDIT', 700],
    ]);
  });
});

it('[AC-B2-02u#10] 流水符号与用户侧一致：available 子户上的每条分录，后台 amount_fen 与 balance_after_fen 与 GET /v1/wallet/ledger 的查询对同一分录给出的相同', async () => {
  const f = fixture(s);
  const st = await story(f);
  const user = await getWalletLedger(
    f.db,
    { appId: f.appId, userId: st.a.userId, limit: 50 },
    {
      withdrawals: { readPaid: async () => [], readPaidAt: async () => null },
      orders: { readOrderIds: async () => new Map<string, string>() },
    },
  );
  const userSide = user.items.map((item) => [item.amount_fen, item.balance_after_fen]);
  expect(userSide).toHaveLength(5);
  await withLedgerAdmin(f, async (h) => {
    const page = await pageOf(await h.ledger({ user_id: st.a.userId, sub_account: 'available' }));
    expect(page.items.map((item) => [item['amount_fen'], item['balance_after_fen']])).toEqual(
      userSide,
    );
  });
});

it('[AC-B2-02u#11] 筛选：ledger_type、sub_type、sub_account、accounting_date_from / to（闭区间，按凭证会计日）、ref（凭证 biz_id 精确匹配）各自生效且可组合，total 随筛选', async () => {
  const f = fixture(s);
  const st = await story(f);
  const rows = await storyRows(f, st);
  const user_id = st.a.userId;
  const cases: [Record<string, string>, Record<string, unknown>[]][] = [
    [{ ledger_type: 'WITHDRAW_FREEZE' }, rows.v3],
    [{ ledger_type: 'REBATE_CREDIT' }, rows.v1],
    [{ sub_type: 'DIRECT' }, rows.v2],
    [{ sub_type: 'FULL' }, rows.v5],
    [{ sub_account: 'frozen' }, rows.v3.filter((row) => row['sub_account'] === 'frozen')],
    [
      { sub_account: 'available' },
      [...rows.v5, ...rows.v4, ...rows.v3, ...rows.v2, ...rows.v1].filter(
        (row) => row['sub_account'] === 'available',
      ),
    ],
    [
      { accounting_date_from: '2026-10-28', accounting_date_to: '2026-10-28' },
      [...rows.v3, ...rows.v2],
    ],
    [{ accounting_date_from: '2026-10-29' }, [...rows.v5, ...rows.v4]],
    [{ accounting_date_to: '2026-10-27' }, rows.v1],
    [
      { accounting_date_from: '2026-10-27', accounting_date_to: '2026-10-28' },
      [...rows.v3, ...rows.v2, ...rows.v1],
    ],
    [{ accounting_date_from: '2026-10-30' }, []],
    [{ ref: st.v3.bizId }, rows.v3],
    [{ ref: st.v4.bizId }, rows.v4],
    // Exact match only: a prefix of the biz_id is no match.
    [{ ref: st.v3.bizId.slice(0, 8) }, []],
    [
      { ledger_type: 'WITHDRAW_FREEZE', sub_account: 'available' },
      rows.v3.filter((row) => row['sub_account'] === 'available'),
    ],
    [{ ledger_type: 'REBATE_CREDIT', accounting_date_from: '2026-10-28' }, []],
    [
      { ref: st.v4.bizId, accounting_date_from: '2026-10-29', accounting_date_to: '2026-10-29' },
      rows.v4,
    ],
    [{ ledger_type: 'ADMIN_ADJUST', sub_type: 'FULL' }, []],
  ];
  await withLedgerAdmin(f, async (h) => {
    for (const [filter, want] of cases) {
      const page = await pageOf(await h.ledger({ user_id, ...filter }));
      expect(page.items, JSON.stringify(filter)).toEqual(want);
      expect(page.total, JSON.stringify(filter)).toBe(want.length);
    }
  });
});

it('[AC-B2-02u#12] 分页：page / page_size 切片按同一顺序不重不漏，total 是全部条数，超出末页 items 为空；不带时 page=1、page_size=20；page_size=200 可用', async () => {
  const f = fixture(s);
  const st = await story(f);
  const rows = await storyRows(f, st);
  const all = [...rows.v5, ...rows.v4, ...rows.v3, ...rows.v2, ...rows.v1];
  const user_id = st.a.userId;
  await withLedgerAdmin(f, async (h) => {
    const seen: Record<string, unknown>[] = [];
    for (const page of [1, 2, 3]) {
      const got = await pageOf(await h.ledger({ user_id, page: String(page), page_size: '2' }));
      expect({ page: got.page, page_size: got.page_size, total: got.total }).toEqual({
        page,
        page_size: 2,
        total: 6,
      });
      expect(got.items).toHaveLength(2);
      seen.push(...got.items);
    }
    expect(seen).toEqual(all);
    const past = await pageOf(await h.ledger({ user_id, page: '4', page_size: '2' }));
    expect({ items: past.items, page: past.page, total: past.total }).toEqual({
      items: [],
      page: 4,
      total: 6,
    });
    const filtered = await pageOf(
      await h.ledger({ user_id, sub_account: 'available', page: '2', page_size: '3' }),
    );
    expect(filtered.items).toEqual(
      all.filter((row) => row['sub_account'] === 'available').slice(3),
    );
    expect(filtered.total).toBe(5);
    const wide = await pageOf(await h.ledger({ user_id, page_size: '200' }));
    expect({ items: wide.items, page_size: wide.page_size }).toEqual({
      items: all,
      page_size: 200,
    });
  });
});

it('[AC-B2-02u#13] 流水的拒绝：缺 user_id、不是 UUID、不存在、别的 app 的用户 → 20001 [user_id]；page_size 超过 200 → [page_size]；accounting_date_from 晚于 to → [accounting_date_from, accounting_date_to]；sub_account / ledger_type 不在枚举 → 指名该参数', async () => {
  const f = fixture(s);
  const a = await openMember(f);
  await credit(f, a, 100n);
  const other = fixture(s);
  const stranger = await openMember(other);
  await credit(other, stranger, 500n);
  await withLedgerAdmin(f, async (h) => {
    await fieldsError(await h.ledger({}), ['user_id']);
    await fieldsError(await h.ledger({ user_id: 'not-a-user-id' }), ['user_id']);
    await fieldsError(await h.ledger({ user_id: randomUUID() }), ['user_id']);
    await fieldsError(await h.ledger({ user_id: stranger.userId }), ['user_id']);
    await fieldsError(await h.ledger({ user_id: a.userId, page_size: '201' }), ['page_size']);
    await fieldsError(
      await h.ledger({
        user_id: a.userId,
        accounting_date_from: '2026-10-29',
        accounting_date_to: '2026-10-28',
      }),
      ['accounting_date_from', 'accounting_date_to'],
    );
    await fieldsError(await h.ledger({ user_id: a.userId, sub_account: 'pending' }), [
      'sub_account',
    ]);
    await fieldsError(await h.ledger({ user_id: a.userId, ledger_type: 'PAY_RECEIPT' }), [
      'ledger_type',
    ]);
    // The same user in its own console's app is fine.
    expect((await pageOf(await h.ledger({ user_id: a.userId }))).total).toBe(1);
  });
});

/** voucher.voucher_id of a ledger item. */
function voucherOf(item: Record<string, unknown>): string {
  return (item['voucher'] as { voucher_id: string }).voucher_id;
}

it('[AC-B2-02u#14] 流水覆盖用户余额账户上的全部 13 种 ledger_type（含 SHARE_CREDIT、REFERRAL_CREDIT/INDIRECT、REWARD/invite、SETTLE_ADJUST、WITHDRAW_PAID、WITHDRAW_RETURN、WITHDRAW_FEE、TAX_WITHHOLD、BAD_DEBT_WRITEOFF）：每条分录原样出现、一条不丢，金额按用户视角带符号；按每一种 ledger_type 筛选只得该类型的全部分录', async () => {
  const f = fixture(s);
  const a = await openMember(f);
  const all = await seedAllTypes(f, a);
  const want: Record<string, unknown>[] = [];
  for (const v of [...all.vouchers].reverse()) want.push(...(await shown(f, a, v.posted, v.link)));
  expect(want).toHaveLength(18);
  await withLedgerAdmin(f, async (h) => {
    const page = await pageOf(await h.ledger({ user_id: a.userId, page_size: '200' }));
    expect(orderLinksByKey(page.items, all.orderIds)).toEqual(want);
    expect(page.total).toBe(18);
    expect([...new Set(page.items.map((item) => String(item['ledger_type'])))].sort()).toEqual(
      [...LEDGER_TYPES].sort(),
    );
    // Hand-written user-view amounts (credit positive, debit negative), as a multiset.
    const lines = page.items.map((item) =>
      [item['ledger_type'], item['sub_type'], item['sub_account'], item['amount_fen']]
        .map(String)
        .join('|'),
    );
    expect([...lines].sort()).toEqual(
      [
        'REBATE_CREDIT|null|available|5000',
        'SHARE_CREDIT|null|available|800',
        'REFERRAL_CREDIT|DIRECT|available|300',
        'REFERRAL_CREDIT|INDIRECT|available|120',
        'REWARD|invite|available|200',
        'SETTLE_ADJUST|SETTLE_DIFF|available|90',
        'CLAWBACK|PART_REFUND|available|-150',
        'WITHDRAW_FREEZE|null|available|-1000',
        'WITHDRAW_FREEZE|null|frozen|1000',
        'WITHDRAW_FEE|null|frozen|-20',
        'TAX_WITHHOLD|null|frozen|-100',
        'WITHDRAW_PAID|null|frozen|-880',
        'WITHDRAW_FREEZE|null|available|-300',
        'WITHDRAW_FREEZE|null|frozen|300',
        'WITHDRAW_RETURN|null|frozen|-300',
        'WITHDRAW_RETURN|null|available|300',
        'ADMIN_ADJUST|OTHER|available|50',
        'BAD_DEBT_WRITEOFF|null|available|60',
      ].sort(),
    );
    // The latest entry: available after every movement is 5470 (hand sum of the plan).
    expect([page.items[0]?.['ledger_type'], page.items[0]?.['balance_after_fen']]).toEqual([
      'BAD_DEBT_WRITEOFF',
      5_470,
    ]);
    for (const type of LEDGER_TYPES) {
      const only = await pageOf(
        await h.ledger({ user_id: a.userId, ledger_type: type, page_size: '200' }),
      );
      const wantType = want.filter((row) => row['ledger_type'] === type);
      expect(wantType.length, type).toBeGreaterThan(0);
      expect(orderLinksByKey(only.items, all.orderIds), type).toEqual(wantType);
      expect(only.total, type).toBe(wantType.length);
    }
  });
});

it('[AC-B2-02u#15] link 按凭证 biz_type 映射：ORDER_CREDIT、ORDER_CLAWBACK、ORDER_SETTLE_ADJUST → order（该订单），withdrawal → withdrawal，admin_adjustment → adjustment，bad_debt_writeoff → writeoff（id 为凭证 biz_id）；映射不到的（INVITE_REWARD 等）→ null', async () => {
  const f = fixture(s);
  const a = await openMember(f);
  const all = await seedAllTypes(f, a);
  await withLedgerAdmin(f, async (h) => {
    const page = await pageOf(await h.ledger({ user_id: a.userId, page_size: '200' }));
    const items = orderLinksByKey(page.items, all.orderIds);
    for (const v of all.vouchers) {
      const own = items.filter((item) => voucherOf(item) === v.posted.voucherId);
      expect(own.length, v.posted.bizType).toBeGreaterThan(0);
      for (const item of own) expect(item['link'], v.posted.bizType).toEqual(v.link);
    }
    // The link type of each biz_type, hand-written.
    const typeOf = new Map<string, unknown>();
    for (const item of items) {
      const voucher = item['voucher'] as { biz_type: string };
      const link = item['link'] as { type: string } | null;
      typeOf.set(voucher.biz_type, link === null ? null : link.type);
    }
    expect(Object.fromEntries(typeOf)).toEqual({
      ORDER_CREDIT: 'order',
      ORDER_SETTLE_ADJUST: 'order',
      ORDER_CLAWBACK: 'order',
      withdrawal: 'withdrawal',
      admin_adjustment: 'adjustment',
      bad_debt_writeoff: 'writeoff',
      INVITE_REWARD: null,
      FIXTURE: null,
    });
  });
});

it('[AC-B2-02u#16] 排序先按 booked_at 倒序、同一时刻再按 entry_id 倒序：后写入但 booked_at 较早的分录（entry_id 更大）排在先写入、booked_at 较晚的分录之后；同一凭证的分录相邻；分页按同一顺序切片', async () => {
  const f = fixture(s);
  const a = await openMember(f);
  // Written x1 (AT_2), y (AT_1), x2 (AT_2), z (AT_1): y and z have larger ids than x1.
  f.clock.set(AT_2);
  const x1 = await credit(f, a, 100n);
  f.clock.set(AT_1);
  const y = await credit(f, a, 200n);
  f.clock.set(AT_2);
  const x2 = await credit(f, a, 300n);
  f.clock.set(AT_1);
  const withdrawalId = randomUUID();
  const z = await post(f, a, {
    ledgerType: 'WITHDRAW_FREEZE',
    lines: [
      { sub: 'available', fen: 50n },
      { sub: 'frozen', fen: -50n },
    ],
    bizType: 'withdrawal',
    bizId: withdrawalId,
  });
  f.clock.set(NOW);
  const rows = {
    x1: await shown(f, a, x1, null),
    y: await shown(f, a, y, null),
    x2: await shown(f, a, x2, null),
    z: await shown(f, a, z, { type: 'withdrawal', id: withdrawalId }),
  };
  // The fixture really has an earlier booked_at under a larger entry id.
  expect(BigInt(String(rows.y[0]?.['entry_id']))).toBeGreaterThan(
    BigInt(String(rows.x1[0]?.['entry_id'])),
  );
  const want = [...rows.x2, ...rows.x1, ...rows.z, ...rows.y];
  await withLedgerAdmin(f, async (h) => {
    const page = await pageOf(await h.ledger({ user_id: a.userId }));
    expect(page.items).toEqual(want);
    expect(page.items.map(voucherOf)).toEqual([
      x2.voucherId,
      x1.voucherId,
      z.voucherId,
      z.voucherId,
      y.voucherId,
    ]);
    const second = await pageOf(await h.ledger({ user_id: a.userId, page: '2', page_size: '2' }));
    expect(second.items).toEqual(want.slice(2, 4));
  });
});

it('[AC-B2-02u#17] 会计日筛选按凭证 accounting_date（+08:00 日切）闭区间：UTC 仍是 10-28、北京时间已是 10-29 00:30 的凭证算 10-29，北京时间 10-28 23:59:59 的算 10-28', async () => {
  const f = fixture(s);
  const a = await openMember(f);
  // 2026-10-28 23:59:59 +08:00: accounting date 2026-10-28.
  f.clock.set('2026-10-28T15:59:59.000Z');
  const e1 = await credit(f, a, 100n);
  // 2026-10-29 00:30 +08:00 (still 2026-10-28 in UTC): accounting date 2026-10-29.
  f.clock.set('2026-10-28T16:30:00.000Z');
  const e2 = await credit(f, a, 200n);
  f.clock.set(AT_4);
  const e3 = await credit(f, a, 300n);
  f.clock.set(NOW);
  const r1 = await shown(f, a, e1, null);
  const r2 = await shown(f, a, e2, null);
  const r3 = await shown(f, a, e3, null);
  const user_id = a.userId;
  await withLedgerAdmin(f, async (h) => {
    const page = await pageOf(await h.ledger({ user_id }));
    expect(page.items).toEqual([...r3, ...r2, ...r1]);
    expect(page.items.map((item) => item['accounting_date'])).toEqual([
      '2026-10-29',
      '2026-10-29',
      '2026-10-28',
    ]);
    const cases: [Record<string, string>, Record<string, unknown>[]][] = [
      [{ accounting_date_from: '2026-10-29', accounting_date_to: '2026-10-29' }, [...r3, ...r2]],
      [{ accounting_date_from: '2026-10-28', accounting_date_to: '2026-10-28' }, r1],
      [{ accounting_date_to: '2026-10-28' }, r1],
      [{ accounting_date_from: '2026-10-29' }, [...r3, ...r2]],
      [
        { accounting_date_from: '2026-10-28', accounting_date_to: '2026-10-29' },
        [...r3, ...r2, ...r1],
      ],
    ];
    for (const [filter, want] of cases) {
      const got = await pageOf(await h.ledger({ user_id, ...filter }));
      expect(got.items, JSON.stringify(filter)).toEqual(want);
      expect(got.total, JSON.stringify(filter)).toBe(want.length);
    }
  });
});
