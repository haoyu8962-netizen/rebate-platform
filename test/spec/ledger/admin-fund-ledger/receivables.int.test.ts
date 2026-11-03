// B2-04zs rule tests, 已入账未回款 (claude-independent, SPEC_REF 6f50a051): 08 BR-FUND-20; contracts/openapi.yaml
// adminGetFundLedger; 编排裁定 D10-589 — computed when read from all the posted entries, not from the
// last asset snapshot and with no accounting-day cut (the asset snapshot cuts at D, this does not).
// receivables: the balance of UNION_RECEIVABLE:{platform} (debit positive) per platform, ordered by
// platform code, only platforms with at least one entry, below 0 after a collection above the
// receivable; union_receivable_total_fen their algebraic sum; as_of the injected clock at the reading.
// Collections and reversals go through the real POST /admin/v1/union-receipts (B2-04zr). The snapshot
// runner is ledger's real createAssetSnapshot (../asset-snapshot/kit.ts setup). Top-level it() only
// (规划/11 §4.3).
import { sql } from 'kysely';
import { expect, it } from 'vitest';
import { input, platform, setup } from '../asset-snapshot/kit.ts';
import {
  NOW,
  entryBody,
  fixture,
  idOf,
  overview,
  receiptOf,
  seedReceivable,
  suite,
  withFundAdmin,
} from './kit.ts';

const s = suite();

function taobao(fen: number) {
  return [{ platform: 'taobao', union_receivable_fen: fen }];
}

it('[AC-B2-04zs#4] 没有任何分录：receivables=[]，三个合计都是 0，水位部分 watermark、water_level 为 null，P 为 0；as_of 是注入时钟的读取时刻', async () => {
  const f = fixture(s);
  await withFundAdmin(f, async (h) => {
    const view = await overview(await h.read());
    expect(view).toEqual({
      as_of: view.as_of,
      receivables: [],
      union_receivable_total_fen: 0,
      negative_total_fen: 0,
      negative_user_count: 0,
      watermark: null,
      forecast_withdrawal_fen: 0,
      water_level: null,
    });
    expect(Date.parse(view.as_of)).toBe(Date.parse(NOW));
  });
});

it('[AC-B2-04zs#5] as_of 跟着注入时钟走：时钟前进 97 分钟后再读，as_of 随之变化，每次都是读取时刻', async () => {
  const f = fixture(s);
  await withFundAdmin(f, async (h) => {
    expect(Date.parse((await overview(await h.read())).as_of)).toBe(Date.parse(NOW));
    f.clock.set('2026-10-29T09:37:00.000Z');
    expect(Date.parse((await overview(await h.read())).as_of)).toBe(
      Date.parse('2026-10-29T09:37:00.000Z'),
    );
  });
});

it('[AC-B2-04zs#6] 08 BR-FUND-20 的例子：应收 1,200,000、回款 1,150,000 → 50,000；红冲回到 1,200,000；红冲后重新录入 1,100,000 → 100,000；每一步当天立刻体现', async () => {
  const f = fixture(s);
  await seedReceivable(f, 'taobao', 1_200_000n);
  await withFundAdmin(f, async (h) => {
    const before = await overview(await h.read());
    expect(before.receivables).toEqual(taobao(1_200_000));
    expect(before.union_receivable_total_fen).toBe(1_200_000);

    const id = idOf(await receiptOf(await h.create(entryBody({ amount_fen: 1_150_000 }))));
    const collected = await overview(await h.read());
    expect(collected.receivables).toEqual(taobao(50_000));
    expect(collected.union_receivable_total_fen).toBe(50_000);

    await receiptOf(await h.reverse(id));
    const reversed = await overview(await h.read());
    expect(reversed.receivables).toEqual(taobao(1_200_000));
    expect(reversed.union_receivable_total_fen).toBe(1_200_000);

    await receiptOf(await h.create(entryBody({ amount_fen: 1_100_000 })));
    const again = await overview(await h.read());
    expect(again.receivables).toEqual(taobao(100_000));
    expect(again.union_receivable_total_fen).toBe(100_000);
  });
});

it('[AC-B2-04zs#7] 多平台各算各的，按 platform code 排序，合计是代数和；一个平台的回款不动别的平台', async () => {
  const f = fixture(s);
  await seedReceivable(f, 'taobao', 864_000n);
  await seedReceivable(f, 'pdd', 20_000n);
  await seedReceivable(f, 'jd', 151_000n);
  await seedReceivable(f, 'douyin', 7_000n);
  await withFundAdmin(f, async (h) => {
    const view = await overview(await h.read());
    expect(view.receivables).toEqual([
      { platform: 'douyin', union_receivable_fen: 7_000 },
      { platform: 'jd', union_receivable_fen: 151_000 },
      { platform: 'pdd', union_receivable_fen: 20_000 },
      { platform: 'taobao', union_receivable_fen: 864_000 },
    ]);
    expect(view.union_receivable_total_fen).toBe(1_042_000);

    await receiptOf(await h.create(entryBody({ platform: 'jd', amount_fen: 51_000 })));
    const after = await overview(await h.read());
    expect(after.receivables).toEqual([
      { platform: 'douyin', union_receivable_fen: 7_000 },
      { platform: 'jd', union_receivable_fen: 100_000 },
      { platform: 'pdd', union_receivable_fen: 20_000 },
      { platform: 'taobao', union_receivable_fen: 864_000 },
    ]);
    expect(after.union_receivable_total_fen).toBe(991_000);
  });
});

it('[AC-B2-04zs#8] 多收为负且负值计入合计（taobao 1,000、jd 400 − 1,000 = −600 → 合计 400）；平台科目的负值不算用户负余额', async () => {
  const f = fixture(s);
  await seedReceivable(f, 'taobao', 1_000n);
  await seedReceivable(f, 'jd', 400n);
  await withFundAdmin(f, async (h) => {
    await receiptOf(await h.create(entryBody({ platform: 'jd', amount_fen: 1_000 })));
    const view = await overview(await h.read());
    expect(view.receivables).toEqual([
      { platform: 'jd', union_receivable_fen: -600 },
      { platform: 'taobao', union_receivable_fen: 1_000 },
    ]);
    expect(view.union_receivable_total_fen).toBe(400);
    expect(view.negative_total_fen).toBe(0);
    expect(view.negative_user_count).toBe(0);
  });
});

it('[AC-B2-04zs#9] 只有回款没有应收：receivables 只有该平台且为负，合计同为负', async () => {
  const f = fixture(s);
  await withFundAdmin(f, async (h) => {
    await receiptOf(await h.create(entryBody({ platform: 'pdd', amount_fen: 700 })));
    const view = await overview(await h.read());
    expect(view.receivables).toEqual([{ platform: 'pdd', union_receivable_fen: -700 }]);
    expect(view.union_receivable_total_fen).toBe(-700);
  });
});

it('[AC-B2-04zs#10] 有分录才出现：回款与应收相抵为 0 的平台仍列出 0；开了 UNION_RECEIVABLE 账户但没有分录的平台不出现；现金与收入科目都不进 receivables', async () => {
  const f = fixture(s);
  await seedReceivable(f, 'taobao', 1_000n);
  await platform(f.db, 'UNION_RECEIVABLE:pdd', f.appId);
  await withFundAdmin(f, async (h) => {
    await receiptOf(await h.create(entryBody({ amount_fen: 1_000 })));
    const view = await overview(await h.read());
    expect(view.receivables).toEqual(taobao(0));
    expect(view.union_receivable_total_fen).toBe(0);
  });
});

/** The per-platform 已入账未回款 of the app's snapshot of `day`, as stored. */
function snapshotOn(f: ReturnType<typeof fixture>, day: string) {
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

it('[AC-B2-04zs#11] 和资产快照对比（快照按 D 截断、本接口不截断）：10-29 录入回款 1,150,000 后迟跑 10-28 的快照仍是 1,200,000，本接口当场就是 50,000；10-29 的快照跑完两者才一致', async () => {
  const f = fixture(s, { instant: '2026-10-19T02:00:00.000Z' });
  await seedReceivable(f, 'taobao', 1_200_000n);
  await withFundAdmin(f, async (h) => {
    f.clock.set('2026-10-29T02:00:00.000Z');
    await receiptOf(await h.create(entryBody({ amount_fen: 1_150_000 })));

    const late = '2026-10-28T16:01:00.000Z';
    await setup(late).runner.run(f.db, input(f.appId, late));
    expect(await snapshotOn(f, '2026-10-28')).toEqual([
      { platform: 'taobao', union_receivable_fen: 1_200_000n },
    ]);
    const view = await overview(await h.read());
    expect(view.receivables).toEqual(taobao(50_000));
    expect(view.union_receivable_total_fen).toBe(50_000);

    const next = '2026-10-29T16:01:00.000Z';
    await setup(next).runner.run(f.db, input(f.appId, next));
    expect(await snapshotOn(f, '2026-10-29')).toEqual([
      { platform: 'taobao', union_receivable_fen: 50_000n },
    ]);
    expect((await overview(await h.read())).receivables).toEqual(taobao(50_000));
  });
});

it('[AC-B2-04zs#12] 不按读取时刻的会计日截断：凭证会计日晚于读取时刻（10-30 过账、时钟回到 10-29 读）的分录同样计入', async () => {
  const f = fixture(s);
  await seedReceivable(f, 'taobao', 1_000n);
  f.clock.set('2026-10-30T08:00:00.000Z');
  await seedReceivable(f, 'taobao', 200n);
  f.clock.set(NOW);
  await withFundAdmin(f, async (h) => {
    const view = await overview(await h.read());
    expect(view.receivables).toEqual(taobao(1_200));
    expect(view.union_receivable_total_fen).toBe(1_200);
  });
});
