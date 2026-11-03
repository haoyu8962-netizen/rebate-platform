// B2-09l overview access rule tests (claude-independent, SPEC_REF 6f50a051): contracts/openapi.yaml
// adminGetPayoutOverview — any of payout.execute or fund.view, a super admin holds every point; no
// step-up; reading writes no audit record and no row; only the app of the console. Requests go through
// the real admin entry (batch-harness.ts). Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import {
  EXECUTE,
  FORECAST_SOURCE,
  PLENTY,
  VIEW,
  answer,
  approved,
  audits,
  channelOf,
  denied,
  fixture,
  ofNet,
  otherApp,
  payee,
  seedHistory,
  seedReview,
  seedSent,
  seedW,
  setSwitch,
  suite,
  viewOf,
  withBatchAdmin,
  world,
} from './batch-harness.ts';

const s = suite();

it('[AC-B2-09l#74] 权限：只持 payout.execute 能读、只持 fund.view 能读、超管能读，都不要 step-up；两个都没有（只持 withdraw.review、别的权限点、没有权限点）→ 10403；不带令牌 → 10001', async () => {
  const f = fixture(s);
  await withBatchAdmin(f, async (h) => {
    const readers = [
      await h.caller([EXECUTE]),
      await h.caller([VIEW]),
      await h.caller([], { superAdmin: true }),
    ];
    for (const reader of readers) {
      const view = await viewOf(await h.overview(reader));
      expect(view.channels).toHaveLength(3);
    }
    for (const outsider of [h.reviewer, h.cashier, await h.caller([])]) {
      await denied(await h.overview(outsider));
    }
    await answer(await h.overview(null), 10001);
  });
});

it('[AC-B2-09l#75] 只读：有批次、任务、W 和尝试的数据下读取，不写审计、不写任何表（幂等记录也没有）', async () => {
  const f = fixture(s);
  await withBatchAdmin(f, async (h) => {
    const who = await payee(f, h);
    await seedHistory(f, h, who, FORECAST_SOURCE);
    await seedW(f, { fen: PLENTY });
    const row = await approved(f, h, who);
    await seedSent(f, row, 'transfer', 'pending');
    await setSwitch(f, 'payout.channel_enabled.wechat', true);
    const before = await world(f);

    await viewOf(await h.overview());
    await viewOf(await h.overview(h.viewer));

    expect(await world(f)).toEqual(before);
    expect(await audits(f)).toEqual([]);
  });
});

it('[AC-B2-09l#76] 只读本 app：别的 app 的 W、P、今日发出和开关都不进本 app 的概览', async () => {
  const f = fixture(s);
  const other = otherApp(f);
  await withBatchAdmin(f, async (h) => {
    const outsider = await payee(other, h);
    await seedHistory(other, h, outsider, FORECAST_SOURCE);
    await seedW(other, { fen: PLENTY });
    const sent = await seedReview(other, h, outsider, {
      status: 'PAYING',
      execute_seq: 1,
      ...ofNet(80_021n),
    });
    await seedSent(other, sent, 'transfer', 'success');
    await setSwitch(other, 'payout.enabled', false);
    await setSwitch(other, 'payout.watermark_usable_bp', 1234);
    await setSwitch(other, 'payout.channel_enabled.wechat', true);

    const view = await viewOf(await h.overview());

    expect(view.payout_enabled).toBe(true);
    expect(view.watermark_usable_bp).toBe(9000);
    expect(view.daily_sent_fen).toBe(0);
    const alipay = channelOf(view, 'alipay');
    expect(alipay.watermark).toBeNull();
    expect(alipay.forecast_withdrawal_fen).toBe(0);
    expect(alipay.water_level).toBeNull();
    expect(channelOf(view, 'wechat').enabled).toBe(false);
  });
});
