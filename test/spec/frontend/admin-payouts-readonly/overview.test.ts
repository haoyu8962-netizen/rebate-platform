// @vitest-environment jsdom
import { cleanup, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  CARD_SHOWN,
  LEVEL_SHOWN,
  VIEW,
  VIEW_EXECUTE,
  createPayoutServer,
  overview,
  overviewWith,
  pausedOverview,
  type Overview,
} from './fixtures.ts';
import {
  CHANNEL_TITLE,
  FIELD,
  FLOW_TIMEOUT,
  MULTI_TIMEOUT,
  TAB,
  card,
  everyGrant,
  exactTexts,
  mount,
  openTab,
  settled,
  values,
} from './helpers.ts';

// F1-08ba ②: the cards of 打款队列 from adminGetPayoutOverview (GET /admin/v1/payout-overview; BR-WDR-17
// switches, BR-WDR-18 W, P, limits and usable share). Every figure comes from the answer, never a
// fixed number: amounts through @couli/money (BR-TEXT-10 admin: ¥, thousands, two decimals), times
// in Beijing time YYYY-MM-DD HH:mm:ss, watermark_usable_bp as a percentage with two decimals. A
// missing W (watermark null) shows 未录入, never ¥0.00; water_level null shows no conclusion at all.
// Each field is a label beside its value (see FIELD); W, t_W, P and the conclusion are those of the
// enterprise Alipay channel, shown once; the three channel cards show 开通 and 暂停.

/** Opens 打款队列 over `answer` and waits for the overview read to finish. */
async function cardsOf(answer: Overview): Promise<HTMLElement> {
  const server = createPayoutServer({ overview: answer, permissions: VIEW_EXECUTE });
  await mount(server, everyGrant(VIEW_EXECUTE));
  const panel = await openTab(TAB.queue);
  await waitFor(() => expect(server.overviewReads()).toHaveLength(1));
  await settled(server);
  return panel;
}

/** Shown elements of `panel` that are a water level conclusion as a whole. */
function conclusions(panel: HTMLElement): string[] {
  return exactTexts(panel, [LEVEL_SHOWN.low, LEVEL_SHOWN.normal]);
}

/** 开通 / 暂停 of each channel card, alipay, bank_card, wechat. */
function channelStates(panel: HTMLElement): string[][] {
  return (['alipay', 'bank_card', 'wechat'] as const).map((channel) => {
    const own = card(panel, CHANNEL_TITLE[channel]);
    return [...values(own, FIELD.enabled), ...values(own, FIELD.paused)];
  });
}

it(
  '[AC-F1-08ba-OVERVIEW#1] 概览样例：可用余额 W ¥30,000.00、取数时间 2026-11-14 09:00:00、预计提现 P ¥21,000.00、水位结论「水位低」、可用比例 90.00%、今日已发出 ¥1,234.56、单日限额 ¥50,000.00、单笔上限 ¥5,000.00、打款开关已开启、队列运行状态运行中；通道卡 企业支付宝 已开通 / 未暂停，银行卡 未开通 / 未暂停，微信零钱 已开通 / 已暂停',
  { timeout: FLOW_TIMEOUT },
  async () => {
    const panel = await cardsOf(overview());
    await waitFor(() => expect(values(panel, FIELD.available)).toEqual(['¥30,000.00']));
    expect(values(panel, FIELD.measuredAt), 't_W').toEqual(['2026-11-1409:00:00']);
    expect(values(panel, FIELD.forecast), 'P').toEqual(['¥21,000.00']);
    expect(values(panel, FIELD.level), 'conclusion').toEqual([LEVEL_SHOWN.low]);
    expect(values(panel, FIELD.usable), 'usable share').toEqual(['90.00%']);
    expect(values(panel, FIELD.dailySent), 'sent today').toEqual(['¥1,234.56']);
    expect(values(panel, FIELD.dailyCap), 'daily cap').toEqual(['¥50,000.00']);
    expect(values(panel, FIELD.singleCap), 'single cap').toEqual(['¥5,000.00']);
    expect(values(panel, FIELD.payout), 'payout switch').toEqual([CARD_SHOWN.payoutOn]);
    expect(values(panel, FIELD.queue), 'queue').toEqual([CARD_SHOWN.queueRunning]);
    expect(channelStates(panel), 'channel cards').toEqual([
      [CARD_SHOWN.channelOn, CARD_SHOWN.channelRunning],
      [CARD_SHOWN.channelOff, CARD_SHOWN.channelRunning],
      [CARD_SHOWN.channelOn, CARD_SHOWN.channelPaused],
    ]);
  },
);

it(
  '[AC-F1-08ba-OVERVIEW#2] 另一组开关与阈值（打款关闭、队列暂停、企业支付宝通道暂停且无 W）：可用余额显示「未录入」而不是 ¥0.00，不显示水位高低结论，P ¥0.00、可用比例 85.00%、今日已发出 ¥0.00、单日限额 ¥40,000.00、单笔上限 ¥3,000.00、打款开关已关闭、队列运行状态已暂停；企业支付宝 已开通 / 已暂停',
  { timeout: FLOW_TIMEOUT },
  async () => {
    const panel = await cardsOf(pausedOverview());
    await waitFor(() => expect(values(panel, FIELD.available)).toEqual([CARD_SHOWN.unentered]));
    expect(conclusions(panel), 'no conclusion').toEqual([]);
    expect(values(panel, FIELD.forecast), 'P').toEqual(['¥0.00']);
    expect(values(panel, FIELD.usable), 'usable share').toEqual(['85.00%']);
    expect(values(panel, FIELD.dailySent), 'sent today').toEqual(['¥0.00']);
    expect(values(panel, FIELD.dailyCap), 'daily cap').toEqual(['¥40,000.00']);
    expect(values(panel, FIELD.singleCap), 'single cap').toEqual(['¥3,000.00']);
    expect(values(panel, FIELD.payout), 'payout switch').toEqual([CARD_SHOWN.payoutOff]);
    expect(values(panel, FIELD.queue), 'queue').toEqual([CARD_SHOWN.queuePaused]);
    expect(channelStates(panel), 'channel cards').toEqual([
      [CARD_SHOWN.channelOn, CARD_SHOWN.channelPaused],
      [CARD_SHOWN.channelOff, CARD_SHOWN.channelRunning],
      [CARD_SHOWN.channelOn, CARD_SHOWN.channelPaused],
    ]);
  },
);

it(
  '[AC-F1-08ba-OVERVIEW#3] 水位结论只照 water_level：normal 显示「正常」；W 已录入但 water_level 为 null（超过时效）时仍显示 W 与取数时间，不显示「水位低」或「正常」',
  { timeout: MULTI_TIMEOUT },
  async () => {
    const watermark = overview().channels[0]!.watermark;
    let panel = await cardsOf(overviewWith(watermark, 'normal'));
    await waitFor(() => expect(values(panel, FIELD.level)).toEqual([LEVEL_SHOWN.normal]));
    expect(values(panel, FIELD.available), 'W').toEqual(['¥30,000.00']);
    cleanup();

    panel = await cardsOf(overviewWith(watermark, null));
    await waitFor(() => expect(values(panel, FIELD.available)).toEqual(['¥30,000.00']));
    expect(values(panel, FIELD.measuredAt), 't_W still shown').toEqual(['2026-11-1409:00:00']);
    expect(conclusions(panel), 'no conclusion').toEqual([]);
  },
);

it(
  '[AC-F1-08ba-OVERVIEW#4] 只持 fund.view 进「打款队列」：照常读 payout-overview（一次、不带参数）并显示同样的卡片值',
  { timeout: FLOW_TIMEOUT },
  async () => {
    const server = createPayoutServer({ permissions: VIEW });
    await mount(server, everyGrant(VIEW));
    const panel = await openTab(TAB.queue);
    await waitFor(() => expect(values(panel, FIELD.available)).toEqual(['¥30,000.00']));
    await settled(server);
    expect(server.overviewReads().map((read) => read.query)).toEqual([{}]);
    expect(values(panel, FIELD.dailyCap), 'daily cap').toEqual(['¥50,000.00']);
    expect(values(panel, FIELD.level), 'conclusion').toEqual([LEVEL_SHOWN.low]);
  },
);
