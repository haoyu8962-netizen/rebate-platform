// B2-09l overview rule tests, 开关与限额 (claude-independent, SPEC_REF 6f50a051): contracts/openapi.yaml
// adminGetPayoutOverview — payout_enabled and queue_paused (BR-WDR-12 ①), single_cap_fen and
// daily_cap_fen (BR-WDR-18), watermark_usable_bp, and per channel enabled and paused; channels are
// alipay, bank_card, wechat, in that order; read fresh, with the configuration defaults EXECUTE uses
// (payout-execute.ts PAYOUT_EXECUTE_DEFAULTS, judgement.ts defaultPayoutChannelConfig), no second copy:
// a changed value moves the overview and EXECUTE together, an unreadable one falls back the same way.
// Requests go through the real admin entry (batch-harness.ts). Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import {
  PLENTY,
  W_JUST_ENOUGH,
  W_JUST_SHORT,
  approved,
  channelOf,
  expectExecuted,
  expectRejected,
  fixture,
  payee,
  seedW,
  setSwitch,
  suite,
  viewOf,
  withBatchAdmin,
} from './batch-harness.ts';

const s = suite();

const CLOSED = { paused: false, watermark: null, forecast_withdrawal_fen: 0, water_level: null };

it('[AC-B2-09l#58] 形状与默认值：没有配置时 payout_enabled、未暂停，单笔 ¥5,000、当日 ¥50,000、可用 9000、今日 0；channels 恰好 alipay、bank_card、wechat 按这个顺序，只有 alipay 开通；as_of 是注入时钟', async () => {
  const f = fixture(s);
  await withBatchAdmin(f, async (h) => {
    const { as_of: asOf, ...view } = await viewOf(await h.overview());

    expect(Date.parse(asOf)).toBe(f.clock.now().getTime());
    expect(view).toEqual({
      payout_enabled: true,
      queue_paused: false,
      single_cap_fen: 500_000,
      daily_cap_fen: 5_000_000,
      daily_sent_fen: 0,
      watermark_usable_bp: 9000,
      channels: [
        { channel: 'alipay', enabled: true, ...CLOSED },
        { channel: 'bank_card', enabled: false, ...CLOSED },
        { channel: 'wechat', enabled: false, ...CLOSED },
      ],
    });
  });
});

it('[AC-B2-09l#59] 读配置且每次读新值：改了开关、限额与通道配置，下一次读就是新值，不缓存、不写死', async () => {
  const f = fixture(s);
  await withBatchAdmin(f, async (h) => {
    await viewOf(await h.overview());

    await setSwitch(f, 'payout.enabled', false);
    await setSwitch(f, 'payout.queue_paused', true);
    await setSwitch(f, 'payout.single_cap_fen', 123_457);
    await setSwitch(f, 'payout.daily_cap_fen', 7_654_321);
    await setSwitch(f, 'payout.watermark_usable_bp', 8123);
    await setSwitch(f, 'payout.channel_enabled.alipay', false);
    await setSwitch(f, 'payout.channel_enabled.bank_card', true);
    await setSwitch(f, 'payout.channel_paused.bank_card', true);
    await setSwitch(f, 'payout.channel_enabled.wechat', true);

    const view = await viewOf(await h.overview());

    expect(view).toMatchObject({
      payout_enabled: false,
      queue_paused: true,
      single_cap_fen: 123_457,
      daily_cap_fen: 7_654_321,
      watermark_usable_bp: 8123,
    });
    expect(view.channels.map(({ channel, enabled, paused }) => [channel, enabled, paused])).toEqual(
      [
        ['alipay', false, false],
        ['bank_card', true, true],
        ['wechat', true, false],
      ],
    );
  });
});

it('[AC-B2-09l#60] 和 EXECUTE 一起变：可用比例改成 5000，概览显示 5000，W=13,719 原本够的 net 12,347 被拒；银行卡开通后概览 enabled，EXECUTE 不再 channel_disabled；payout.enabled 关时概览 false、EXECUTE payout_disabled', async () => {
  const f = fixture(s);
  await withBatchAdmin(f, async (h) => {
    const who = await payee(f, h);
    const w = await approved(f, h, who);
    await seedW(f, { fen: W_JUST_ENOUGH });
    await setSwitch(f, 'payout.watermark_usable_bp', 5000);
    expect((await viewOf(await h.overview())).watermark_usable_bp).toBe(5000);
    await expectRejected(await h.execute([w.id]), 'watermark_usable_exceeded', 'alipay');

    const bank = await approved(f, h, who, { method: 'bank_card' });
    expect(channelOf(await viewOf(await h.overview()), 'bank_card').enabled).toBe(false);
    await expectExecuted(await h.execute([bank.id]), { left: [[bank.id, 'channel_disabled']] });
    await setSwitch(f, 'payout.channel_enabled.bank_card', true);
    await seedW(f, { fen: PLENTY, channel: 'bank_card' });
    expect(channelOf(await viewOf(await h.overview()), 'bank_card').enabled).toBe(true);
    await expectExecuted(await h.execute([bank.id]), { paying: [bank.id] });

    await setSwitch(f, 'payout.enabled', false);
    expect((await viewOf(await h.overview())).payout_enabled).toBe(false);
    await expectRejected(await h.execute([w.id]), 'payout_disabled');
  });
});

it('[AC-B2-09l#61] 读不懂的配置值按同一套默认（不是 null 也不报错）：开关、可用比例、限额都回到默认；EXECUTE 同样按 9000 判：W=13,718 拒绝，W=13,719 通过', async () => {
  const f = fixture(s);
  await withBatchAdmin(f, async (h) => {
    await setSwitch(f, 'payout.enabled', 'nope');
    await setSwitch(f, 'payout.queue_paused', 'nope');
    await setSwitch(f, 'payout.watermark_usable_bp', 20_000);
    await setSwitch(f, 'payout.single_cap_fen', 0);
    await setSwitch(f, 'payout.daily_cap_fen', -1);
    await setSwitch(f, 'payout.channel_enabled.wechat', 'maybe');
    await setSwitch(f, 'payout.channel_paused.alipay', 'maybe');

    const view = await viewOf(await h.overview());

    expect(view).toMatchObject({
      payout_enabled: true,
      queue_paused: false,
      single_cap_fen: 500_000,
      daily_cap_fen: 5_000_000,
      watermark_usable_bp: 9000,
    });
    expect(channelOf(view, 'wechat').enabled).toBe(false);
    expect(channelOf(view, 'alipay').paused).toBe(false);

    const w = await approved(f, h, await payee(f, h));
    await seedW(f, { fen: W_JUST_SHORT, ageMs: 120_000 });
    await expectRejected(await h.execute([w.id]), 'watermark_usable_exceeded', 'alipay');
    await seedW(f, { fen: W_JUST_ENOUGH, ageMs: 60_000 });
    await expectExecuted(await h.execute([w.id]), { paying: [w.id] });
  });
});
