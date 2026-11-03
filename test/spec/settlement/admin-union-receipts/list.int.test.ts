// B2-04zr list rule tests (claude-independent, SPEC_REF 6f50a051): contracts/openapi.yaml
// adminListUnionReceipts — fund.view or a super admin, no step-up, reading writes no audit record;
// only the records of the console's app; filters platform, date_from, date_to (collection days, both
// inclusive), AND; 20001 data.fields; order receipt_date, created_at, receipt_id, all descending;
// page and page_size ≤ 200, total the count of the filter set, a page past the last one is items=[];
// created_by_name and reversed_by_name the account's current name (display_name, else the username),
// null when there is none; a reversed record stays with its amount. Rows are seeded through the real
// ledger, so this file needs neither write. Requests go through the real admin entry (kit.ts).
// Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import {
  CASH_ENTRY,
  answer,
  audits,
  denied,
  everything,
  fieldsError,
  fixture,
  idsOf,
  nameOf,
  pageOf,
  seedReceipt,
  seedReversal,
  suite,
  viewOf,
  withReceiptAdmin,
} from './kit.ts';

const s = suite();

const T0 = new Date('2026-10-20T01:00:00.000Z');
const T1 = new Date('2026-10-20T02:00:00.000Z');
const T2 = new Date('2026-10-20T03:00:00.000Z');

it('[AC-B2-04zr#40] 权限：只持 fund.view 与超管都能读且不要 step-up；只持 fund.cash_entry、没有权限点 → 10403；不带令牌 → 10001', async () => {
  const f = fixture(s);
  const row = await seedReceipt(f);
  await withReceiptAdmin(f, async (h) => {
    expect(await idsOf(await h.list())).toEqual([row.receipt_id]);
    const root = await h.caller([], { superAdmin: true });
    expect(await idsOf(await h.list({}, root))).toEqual([row.receipt_id]);
    await denied(await h.list({}, h.operator));
    await denied(await h.list({}, await h.caller([])));
    await answer(await h.list({}, null), 10001);
  });
});

it('[AC-B2-04zr#41] 每行字段照契约：平台、回款日、金额、method、cash_account、voucher_id、备注、创建人与姓名、红冲三列与红冲人姓名；R1 无操作人的记录 created_by、created_by_name 都为空；红冲后金额不变、仍在列', async () => {
  const f = fixture(s);
  await withReceiptAdmin(f, async (h) => {
    const entered = await seedReceipt(f, {
      platform: 'taobao',
      amountFen: 1_150_000n,
      receiptDate: '2026-10-20',
      note: '10 月账单回款',
      createdBy: h.operator.id,
    });
    const confirmed = await seedReceipt(f, {
      platform: 'jd',
      amountFen: 151_000n,
      receiptDate: '2026-10-18',
    });
    const reversed = await seedReversal(
      f,
      await seedReceipt(f, {
        platform: 'taobao',
        amountFen: 115_000n,
        receiptDate: '2026-10-16',
        createdBy: h.operator.id,
      }),
      h.operator.id,
      T2,
    );
    expect(reversed.reversal_voucher_id).not.toBeNull();

    const page = await pageOf(await h.list());
    expect(page.page).toBe(1);
    expect(page.page_size).toBe(20);
    expect(page.total).toBe(3);
    expect(page.items).toEqual([
      viewOf(entered, { createdBy: nameOf(h.operator) }),
      viewOf(confirmed),
      viewOf(reversed, { createdBy: nameOf(h.operator), reversedBy: nameOf(h.operator) }),
    ]);
    expect(page.items[1]).toMatchObject({
      method: 'R1_RECON',
      created_by: null,
      created_by_name: null,
    });
    expect(page.items[2]).toMatchObject({
      amount_fen: 115_000,
      reversed_at: T2.getTime(),
      reversed_by: h.operator.id,
      reversal_voucher_id: reversed.reversal_voucher_id,
    });
  });
});

it('[AC-B2-04zr#42] 操作人姓名是账号当前的：display_name 优先，没有时取用户名；账号改名后列表跟着变，记录行不变', async () => {
  const f = fixture(s);
  await withReceiptAdmin(f, async (h) => {
    const named = await h.caller([CASH_ENTRY], { displayName: '合成财务甲' });
    const plain = await h.caller([CASH_ENTRY]);
    const row = await seedReversal(f, await seedReceipt(f, { createdBy: named.id }), plain.id, T2);

    const [first] = (await pageOf(await h.list())).items;
    expect(first).toMatchObject({
      created_by: named.id,
      created_by_name: '合成财务甲',
      reversed_by: plain.id,
      reversed_by_name: plain.loginName,
    });

    await f.db
      .updateTable('admin_users')
      .set({ display_name: '合成财务乙' })
      .where('app_id', '=', f.appId)
      .where('id', '=', named.id)
      .execute();
    const [renamed] = (await pageOf(await h.list())).items;
    expect(renamed).toEqual(viewOf(row, { createdBy: '合成财务乙', reversedBy: plain.loginName }));
  });
});

it('[AC-B2-04zr#43] 筛选 platform、date_from、date_to 按回款日闭区间，可组合；没有命中是空页不是错；total 是筛选集的数', async () => {
  const f = fixture(s);
  const a = await seedReceipt(f, { platform: 'taobao', receiptDate: '2026-10-10' });
  const b = await seedReceipt(f, { platform: 'jd', receiptDate: '2026-10-15' });
  const c = await seedReceipt(f, { platform: 'taobao', receiptDate: '2026-10-20' });
  const d = await seedReceipt(f, { platform: 'taobao', receiptDate: '2026-10-21' });
  await withReceiptAdmin(f, async (h) => {
    expect(await idsOf(await h.list({ platform: 'jd' }))).toEqual([b.receipt_id]);
    expect(await idsOf(await h.list({ date_from: '2026-10-15' }))).toEqual([
      d.receipt_id,
      c.receipt_id,
      b.receipt_id,
    ]);
    expect(await idsOf(await h.list({ date_to: '2026-10-15' }))).toEqual([
      b.receipt_id,
      a.receipt_id,
    ]);
    expect(await idsOf(await h.list({ date_from: '2026-10-11', date_to: '2026-10-20' }))).toEqual([
      c.receipt_id,
      b.receipt_id,
    ]);
    expect(await idsOf(await h.list({ date_from: '2026-10-20', date_to: '2026-10-20' }))).toEqual([
      c.receipt_id,
    ]);
    const both = await pageOf(
      await h.list({ platform: 'taobao', date_from: '2026-10-15', date_to: '2026-10-20' }),
    );
    expect(both.items.map((item) => item['receipt_id'])).toEqual([c.receipt_id]);
    expect(both.total).toBe(1);

    const none = await pageOf(await h.list({ platform: 'pdd' }));
    expect(none.items).toEqual([]);
    expect(none.total).toBe(0);
  });
});

it('[AC-B2-04zr#44] 参数校验：platform 不在枚举、日期格式不对 → 20001 data.fields 恰为该参数；date_from 晚于 date_to → data.fields=[date_from, date_to]；page_size 超 200 或为 0 → [page_size]，恰好 200 可以', async () => {
  const f = fixture(s);
  await seedReceipt(f);
  await withReceiptAdmin(f, async (h) => {
    await fieldsError(await h.list({ platform: 'nope' }), ['platform']);
    await fieldsError(await h.list({ date_from: '20261020' }), ['date_from']);
    await fieldsError(await h.list({ date_to: '2026-02-30' }), ['date_to']);
    await fieldsError(await h.list({ date_from: '2026-10-21', date_to: '2026-10-20' }), [
      'date_from',
      'date_to',
    ]);
    await fieldsError(await h.list({ page_size: '201' }), ['page_size']);
    await fieldsError(await h.list({ page_size: '0' }), ['page_size']);
    const widest = await pageOf(await h.list({ page_size: '200' }));
    expect(widest.page_size).toBe(200);
    expect(widest.items).toHaveLength(1);
  });
});

it('[AC-B2-04zr#45] 排序：receipt_date 倒序，同日 created_at 倒序，同时刻 receipt_id 倒序', async () => {
  const f = fixture(s);
  const laterDay = await seedReceipt(f, { receiptDate: '2026-10-22', createdAt: T0 });
  const laterCreated = await seedReceipt(f, { receiptDate: '2026-10-20', createdAt: T2 });
  const ties = [
    await seedReceipt(f, { receiptDate: '2026-10-20', createdAt: T1 }),
    await seedReceipt(f, { receiptDate: '2026-10-20', createdAt: T1 }),
    await seedReceipt(f, { receiptDate: '2026-10-20', createdAt: T1 }),
  ];
  const earlierDay = await seedReceipt(f, { receiptDate: '2026-10-19', createdAt: T2 });
  // uuid order is hex text order; the ids are random, so the tie's order is sorted here.
  const tied = ties.map((row) => row.receipt_id).sort((a, b) => (a < b ? 1 : -1));
  await withReceiptAdmin(f, async (h) => {
    expect(await idsOf(await h.list())).toEqual([
      laterDay.receipt_id,
      laterCreated.receipt_id,
      ...tied,
      earlierDay.receipt_id,
    ]);
  });
});

it('[AC-B2-04zr#46] 翻页：page_size=2 共 5 条分 3 页、不重不漏，每页 total=5；超过末页 items=[]、total 不变', async () => {
  const f = fixture(s);
  const rows = [];
  for (const day of ['2026-10-05', '2026-10-04', '2026-10-03', '2026-10-02', '2026-10-01']) {
    rows.push(await seedReceipt(f, { receiptDate: day }));
  }
  const ids = rows.map((row) => row.receipt_id);
  await withReceiptAdmin(f, async (h) => {
    for (const [page, expected] of [
      [1, ids.slice(0, 2)],
      [2, ids.slice(2, 4)],
      [3, ids.slice(4)],
      [4, []],
    ] as const) {
      const data = await pageOf(await h.list({ page: String(page), page_size: '2' }));
      expect(data.page).toBe(page);
      expect(data.page_size).toBe(2);
      expect(data.total).toBe(5);
      expect(data.items.map((item) => item['receipt_id'])).toEqual(expected);
    }
  });
});

it('[AC-B2-04zr#47] 只读本 app：别的 app 同平台同日的记录不出现、不计入 total；读取不写审计，也不改任何东西', async () => {
  const f = fixture(s);
  const other = fixture(s);
  await seedReceipt(other);
  const mine = await seedReceipt(f);
  await withReceiptAdmin(f, async (h) => {
    const before = await everything(f);
    const page = await pageOf(await h.list());
    expect(page.items.map((item) => item['receipt_id'])).toEqual([mine.receipt_id]);
    expect(page.total).toBe(1);
    expect(await everything(f)).toEqual(before);
    expect(await audits(f)).toEqual([]);
  });
});
