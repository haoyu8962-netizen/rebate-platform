// B2-04zs rule tests, app 隔离 (claude-independent, SPEC_REF 6f50a051): contracts/openapi.yaml
// adminGetFundLedger — every figure is limited to the app of the console: the receivables, the negative
// balances, W and the withdrawals of another app never count, with the same platform and channel.
// Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import {
  byNobody,
  clawback,
  fixture,
  openMember,
  overview,
  seedForecastOf2100000,
  seedReceivable,
  seedWatermark,
  seedWithdrawal,
  suite,
  watermarkOf,
  withFundAdmin,
} from './kit.ts';

const s = suite();

/** Everything of another app the reading must not see, on the same platform and channel. */
async function seedOtherApp(other: ReturnType<typeof fixture>): Promise<void> {
  await seedReceivable(other, 'taobao', 9_000_000n);
  await clawback(other, await openMember(other), 8_000n);
  await seedForecastOf2100000(other);
  await seedWatermark(other, { fen: 70_000_000n, ageMs: 60_000 });
}

it('[AC-B2-04zs#35] 本 app 什么都没有、别的 app 都有：receivables=[]、合计 0、负余额 0、W 为 null、P=0、结论 null', async () => {
  const f = fixture(s);
  await seedOtherApp(fixture(s));
  await withFundAdmin(f, async (h) => {
    const view = await overview(await h.read());
    expect(view.receivables).toEqual([]);
    expect(view.union_receivable_total_fen).toBe(0);
    expect(view.negative_total_fen).toBe(0);
    expect(view.negative_user_count).toBe(0);
    expect(view.watermark).toBeNull();
    expect(view.forecast_withdrawal_fen).toBe(0);
    expect(view.water_level).toBeNull();
  });
});

it('[AC-B2-04zs#36] 两个 app 都有数据：只算本 app 的应收 1,000、负余额 300、W 5,000、P 6（合计 11）', async () => {
  const f = fixture(s);
  await seedOtherApp(fixture(s));
  await seedReceivable(f, 'taobao', 1_000n);
  await clawback(f, await openMember(f), 300n);
  await seedWithdrawal(f, { amountFen: 11n, createdAt: '2026-10-25T04:00:00.000Z' });
  const measuredAt = await seedWatermark(f, { fen: 5_000n });
  await withFundAdmin(f, async (h) => {
    const view = await overview(await h.read());
    expect(view.receivables).toEqual([{ platform: 'taobao', union_receivable_fen: 1_000 }]);
    expect(view.union_receivable_total_fen).toBe(1_000);
    expect(view.negative_total_fen).toBe(300);
    expect(view.negative_user_count).toBe(1);
    expect(watermarkOf(view)).toEqual(byNobody(5_000, measuredAt));
    expect(view.forecast_withdrawal_fen).toBe(6);
    expect(view.water_level).toBe('normal');
  });
});
