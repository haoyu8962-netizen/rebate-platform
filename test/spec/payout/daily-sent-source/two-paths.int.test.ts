// B2-09o (claude-independent, SPEC_REF 6f50a051; D10-602 (a), 08 BR-WDR-13 ③): the overview's
// daily_sent_fen and the sum the payout process's daily_cap review judges are one number. Each test
// reads S from GET /admin/v1/payout-overview, then drives the real transfer job at cap = S + n − 1
// (held, daily_cap) and cap = S + n (passes), on the same database, app and clock
// (two-paths-harness.ts). The hand-written S comes last: it keeps the comparison from being vacuous,
// the comparison itself is what catches one side changing alone. Nets are divisible neither by 3 nor
// by 7, and so are the expected sums. Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import { FAIL_STEP, UNKNOWN_STEP, scripted, successStep, type Channel } from '../process/kit.ts';
import {
  TODAY_START,
  TOMORROW_START,
  YESTERDAY_END,
  expectReviewAgrees,
  seedDay,
  seedOtherApp,
  twoPathsSuite,
  withTwoPaths,
  type SentSeed,
} from './two-paths-harness.ts';

const s = twoPathsSuite();

/** The waiting withdrawal of most tests: amount 4,541 = net 4,133 + fee 307 + tax 101. */
const WAITING = { net: 4_133n, fee: 307n, tax: 101n };

it('[AC-B2-09o#1] 同一批混合数据：计入 12,347 + 30,011 + 7,012 = 49,370，其余都不计，概览的 S 正好卡在 daily_cap 的放行线上', async () => {
  await withTwoPaths(s, async (t) => {
    await seedDay(t, { net: 12_347n, result: 'pending', at: TODAY_START });
    await seedDay(t, { net: 30_011n, result: 'success', channel: 'bank_card' });
    await seedDay(t, { net: 7_012n, result: 'unknown' });
    await seedDay(t, { net: 99_991n, result: 'fail' });
    await seedDay(t, { net: 50_021n, result: 'unknown', kind: 'query' });
    await seedDay(t, { net: 70_001n, result: 'pending', at: YESTERDAY_END });
    await seedOtherApp(t, 80_021n);

    const sent = await expectReviewAgrees(t, WAITING);
    expect(sent).toBe(49_370);
  });
});

interface OneRowCase {
  readonly label: string;
  readonly row?: SentSeed;
  readonly otherApp?: boolean;
  readonly own?: Channel;
  readonly sent: number;
}

/** Each row differs from the base day in one condition only; a counted one moves S by its 30,011. */
const ONE_ROW: readonly OneRowCase[] = [
  {
    label: 'transfer pending 计入',
    row: { net: 30_011n, result: 'pending' },
    sent: 42_358,
  },
  {
    label: 'transfer success 计入',
    row: { net: 30_011n, result: 'success' },
    sent: 42_358,
  },
  {
    label: 'transfer unknown 计入',
    row: { net: 30_011n, result: 'unknown' },
    sent: 42_358,
  },
  {
    label: 'transfer fail 不计',
    row: { net: 30_011n, result: 'fail' },
    sent: 12_347,
  },
  {
    label: 'query pending 不计',
    row: { net: 30_011n, result: 'pending', kind: 'query' },
    sent: 12_347,
  },
  {
    label: 'query success 不计',
    row: { net: 30_011n, result: 'success', kind: 'query' },
    sent: 12_347,
  },
  {
    label: 'query unknown 不计',
    row: { net: 30_011n, result: 'unknown', kind: 'query' },
    sent: 12_347,
  },
  {
    label: '银行卡已发 + 支付宝待发，跨通道计入',
    row: { net: 30_011n, result: 'pending', channel: 'bank_card' },
    own: 'alipay',
    sent: 42_358,
  },
  {
    label: '支付宝已发 + 银行卡待发，跨通道计入',
    row: { net: 30_011n, result: 'pending', channel: 'alipay' },
    own: 'bank_card',
    sent: 42_358,
  },
  {
    label: '今日 00:00:00（+08:00）计入',
    row: { net: 30_011n, result: 'pending', at: TODAY_START },
    sent: 42_358,
  },
  {
    label: '今日 00:00:00 的前一刻不计（这一刻按 UTC 还是当天）',
    row: { net: 30_011n, result: 'pending', at: YESTERDAY_END },
    sent: 12_347,
  },
  {
    label: '次日 00:00:00（+08:00）不计',
    row: { net: 30_011n, result: 'pending', at: TOMORROW_START },
    sent: 12_347,
  },
  {
    label: '别的 app 同一时刻的 success 不计',
    otherApp: true,
    sent: 12_347,
  },
];

it.each(ONE_ROW)(
  '[AC-B2-09o#2] 基础一笔 12,347，只多一种情况：$label → 概览 S = $sent，复核同数',
  async ({ row, otherApp, own, sent }) => {
    await withTwoPaths(s, async (t) => {
      await seedDay(t, { net: 12_347n, result: 'pending' });
      if (row !== undefined) await seedDay(t, row);
      if (otherApp === true) await seedOtherApp(t, 30_011n);

      const read = await expectReviewAgrees(t, {
        ...WAITING,
        ...(own === undefined ? {} : { channel: own }),
      });
      expect(read).toBe(sent);
    });
  },
);

it('[AC-B2-09o#3] 两边都按 net_fen：已发一笔 net 30,011（fee 9,001、tax 5,003，amount 44,015）、待发 net 4,133（amount 4,541）→ S = 30,011，cap 按 net 卡线', async () => {
  await withTwoPaths(s, async (t) => {
    await seedDay(t, { net: 30_011n, fee: 9_001n, tax: 5_003n, result: 'success' });

    const sent = await expectReviewAgrees(t, WAITING);
    expect(sent).toBe(30_011);
  });
});

it('[AC-B2-09o#4] 打款进程自己写下的尝试两边同数：success 12,347 + unknown 30,011 计入，fail 7,012 不计 → S = 42,358', async () => {
  await withTwoPaths(s, async (t) => {
    const { f } = t;
    const paid = await f.seedWithdrawal({ net: 12_347n, fee: 211n, tax: 89n });
    const lost = await f.seedWithdrawal({ net: 30_011n, fee: 211n, tax: 89n });
    const failed = await f.seedWithdrawal({ net: 7_012n, fee: 211n, tax: 89n });
    const channel = scripted({
      [paid.outBizNo]: [successStep('CHANNEL_ORDER_B209O')],
      [lost.outBizNo]: [UNKNOWN_STEP],
      [failed.outBizNo]: [FAIL_STEP],
    });
    const job = f.job(channel.channel);
    for (const w of [paid, lost, failed]) await job(f.jobOf(w));
    expect(channel.transfers()).toHaveLength(3);

    const sent = await expectReviewAgrees(t, WAITING);
    expect(sent).toBe(42_358);
  });
});
