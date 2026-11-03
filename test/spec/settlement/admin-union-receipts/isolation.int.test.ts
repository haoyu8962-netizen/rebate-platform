// B2-04zr rule tests, what the placeholder ledger_type must not touch (claude-independent, SPEC_REF
// 6f50a051): specs/ledger-rules.md §7 第 3 条 (UNION_RECEIPT:* entries are REBATE_CREDIT 占位 on platform
// subjects); 编排裁定 D10-538 — after an entry and a reversal the real daily check of
// db/invariants/ledger reports no difference, including 05 (UNION_RECEIPT is not an order voucher)
// and with the receivable below 0; getOrderNets and the members' balances do not change. BR-WDR-18 —
// W does not change. The order is the credited order of ../admin-recon-restore/kit.ts: N = 1000, so
// its receivable is 1000. Requests go through the real admin entry (kit.ts). Top-level it() only
// (规划/11 §4.3).
import { expect, it } from 'vitest';
import {
  available,
  fixture as restoreFixture,
  netsOf,
  seedOrder,
} from '../admin-recon-restore/kit.ts';
import {
  TODAY,
  balanceOf,
  entryBody,
  everything,
  expectCleanBooks,
  fixture,
  idOf,
  receiptOf,
  seedWatermark,
  suite,
  withReceiptAdmin,
} from './kit.ts';

const s = suite();

it('[AC-B2-04zr#34] 不污染其他账：录入与红冲后 db/invariants/ledger 01–09 都没有差异；订单的 getOrderNets（应收净额 1000）与受益人余额不变，只有 UNION_RECEIVABLE:taobao 余额随回款变（1000 → 600 → 1000）', async () => {
  const f = await restoreFixture(s);
  const order = await seedOrder(f);
  const members = order.people.map((person) => person.userId);
  const nets = await netsOf(f, order.orderKey);
  expect(nets.union_receivable_net_fen).toBe(1000n);
  await expectCleanBooks(f, TODAY);
  const balances = await Promise.all(members.map((id) => available(f, id)));

  await withReceiptAdmin(f, async (h) => {
    const id = idOf(await receiptOf(await h.create(entryBody({ amount_fen: 400 }))));
    expect(await balanceOf(f, 'UNION_RECEIVABLE:taobao')).toBe(600n);
    await expectCleanBooks(f, TODAY);
    expect(await netsOf(f, order.orderKey)).toEqual(nets);
    expect(await Promise.all(members.map((member) => available(f, member)))).toEqual(balances);

    await receiptOf(await h.reverse(id));
    expect(await balanceOf(f, 'UNION_RECEIVABLE:taobao')).toBe(1000n);
    await expectCleanBooks(f, TODAY);
    expect(await netsOf(f, order.orderKey)).toEqual(nets);
    expect(await Promise.all(members.map((member) => available(f, member)))).toEqual(balances);
  });
});

it('[AC-B2-04zr#35] 多收后应收为负（1000 − 5000 = −4000）日终校验同样没有差异；别的平台的记录也一样', async () => {
  const f = await restoreFixture(s);
  await seedOrder(f);
  await withReceiptAdmin(f, async (h) => {
    await receiptOf(await h.create(entryBody({ amount_fen: 5000 })));
    expect(await balanceOf(f, 'UNION_RECEIVABLE:taobao')).toBe(-4000n);
    await receiptOf(await h.create(entryBody({ platform: 'douyin', amount_fen: 700 })));
    expect(await balanceOf(f, 'UNION_RECEIVABLE:douyin')).toBe(-700n);
    await expectCleanBooks(f, TODAY);
  });
});

it('[AC-B2-04zr#36] 不动 W：录入与红冲都不改 payout_watermarks（既有水位行不变，也不新增行）', async () => {
  const f = fixture(s);
  await seedWatermark(f, 5_000_000n);
  await withReceiptAdmin(f, async (h) => {
    const { watermarks } = await everything(f);
    expect(watermarks).toHaveLength(1);

    const id = idOf(await receiptOf(await h.create(entryBody())));
    expect((await everything(f)).watermarks).toEqual(watermarks);

    await receiptOf(await h.reverse(id));
    expect((await everything(f)).watermarks).toEqual(watermarks);
  });
});
