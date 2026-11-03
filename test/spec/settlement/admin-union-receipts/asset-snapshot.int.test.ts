// B2-04zr rule tests, 垫资 (claude-independent, SPEC_REF 6f50a051): 08 BR-FUND-20, BR-FUND-18; 编排裁定
// D10-589 ② — the asset snapshot's 已入账未回款 follows the entries dated ≤ D. A collection entered late
// is not backdated: its voucher's accounting day is the injected Clock, not receipt_date, so the
// exposure falls from the day it is entered, a snapshot already written does not change and a day
// before the entry still shows the whole receivable, even when the snapshot of that day runs late.
// The same goes for the reversal. The snapshot runner is ledger's real createAssetSnapshot
// (../../ledger/asset-snapshot/kit.ts setup, its waiting source a stub); requests go through the real
// admin entry (kit.ts). Top-level it() only (规划/11 §4.3).
import { sql } from 'kysely';
import { expect, it } from 'vitest';
import { input, setup } from '../../ledger/asset-snapshot/kit.ts';
import {
  CASH_ENTRY,
  entryBody,
  fixture,
  idOf,
  receiptKey,
  receiptOf,
  reversalKey,
  seedReceivable,
  suite,
  voucherOf,
  withReceiptAdmin,
  type ReceiptFixture,
} from './kit.ts';

const s = suite();

/** Runs the snapshot of the +08:00 day before `nominal` (D+1 00:01 +08:00). */
async function runSnapshot(f: ReceiptFixture, nominal: string): Promise<void> {
  const { runner } = setup(nominal);
  await runner.run(f.db, input(f.appId, nominal));
}

/** The per-platform 已入账未回款 of the app's snapshot of `day`. */
function receivablesOn(f: ReceiptFixture, day: string) {
  return f.db
    .selectFrom('asset_snapshot_receivables as r')
    .innerJoin('asset_snapshots as a', (join) =>
      join.onRef('a.id', '=', 'r.asset_snapshot_id').onRef('a.app_id', '=', 'r.app_id'),
    )
    .select(['r.platform', 'r.union_receivable_fen'])
    .where('r.app_id', '=', f.appId)
    .where('a.snapshot_date', '=', sql<Date>`${day}::date`)
    .orderBy('r.platform')
    .execute();
}

function taobao(fen: bigint) {
  return [{ platform: 'taobao', union_receivable_fen: fen }];
}

it('[AC-B2-04zr#39] 依 D10-589 ②：10-29 补录 receipt_date=10-20 的回款 1,150,000：凭证会计日 10-29；已写的 10-26 快照仍 1,200,000，迟跑的 10-27、10-28 快照也是 1,200,000，10-29 快照 50,000；10-30 红冲：红冲凭证会计日 10-30，10-29 快照仍 50,000，10-30 快照回到 1,200,000', async () => {
  const f = fixture(s, { instant: '2026-10-19T02:00:00.000Z' });
  await seedReceivable(f, 'taobao', 1_200_000n);
  await runSnapshot(f, '2026-10-26T16:01:00.000Z');
  expect(await receivablesOn(f, '2026-10-26')).toEqual(taobao(1_200_000n));

  await withReceiptAdmin(f, async (h) => {
    f.clock.set('2026-10-29T02:00:00.000Z');
    const enterer = await h.caller([CASH_ENTRY]);
    const id = idOf(
      await receiptOf(
        await h.create(entryBody({ receipt_date: '2026-10-20', amount_fen: 1_150_000 }), {
          caller: enterer,
        }),
      ),
    );
    expect((await voucherOf(f, receiptKey('taobao', id))).day).toBe('2026-10-29');

    expect(await receivablesOn(f, '2026-10-26')).toEqual(taobao(1_200_000n));
    await runSnapshot(f, '2026-10-27T16:01:00.000Z');
    expect(await receivablesOn(f, '2026-10-27')).toEqual(taobao(1_200_000n));
    await runSnapshot(f, '2026-10-28T16:01:00.000Z');
    expect(await receivablesOn(f, '2026-10-28')).toEqual(taobao(1_200_000n));
    await runSnapshot(f, '2026-10-29T16:01:00.000Z');
    expect(await receivablesOn(f, '2026-10-29')).toEqual(taobao(50_000n));

    f.clock.set('2026-10-30T02:00:00.000Z');
    const reverser = await h.caller([CASH_ENTRY]);
    await receiptOf(await h.reverse(id, undefined, { caller: reverser }));
    expect((await voucherOf(f, reversalKey('taobao', id))).day).toBe('2026-10-30');

    expect(await receivablesOn(f, '2026-10-29')).toEqual(taobao(50_000n));
    await runSnapshot(f, '2026-10-30T16:01:00.000Z');
    expect(await receivablesOn(f, '2026-10-30')).toEqual(taobao(1_200_000n));
    expect(await receivablesOn(f, '2026-10-26')).toEqual(taobao(1_200_000n));
  });
});
