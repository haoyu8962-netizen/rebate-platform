// B2-09ze: payout's stale W port against PostgreSQL (BR-WDR-18 ② and 细则「多通道的 W」; D10-805 ④,
// D10-807). Per app_id, enterprise Alipay only: 1 when the app has enterprise Alipay withdrawals
// waiting to be executed (APPROVED, payout_channel alipay; other channels' do not count) and no
// fresh W (no row, or the latest row past BR-WDR-18 ②'s limit), 0 when the W is fresh; an app
// without waiting enterprise Alipay withdrawals is never 1. "Fresh" is the same judgement as EXECUTE's
// judgeWatermark (D10-807 ①): at exactly 2 hours, 2 hours + 1 ms and without any W the gauge is 1
// exactly when judgeWatermark says watermark_stale. A session whose every transaction is READ ONLY
// runs the port, so any write fails in PostgreSQL itself. "Now" is the injected clock only: the
// database's own now() is years before the fixture's times.
import { createDb, destroyDb } from '@couli/db';
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  judgeWatermark,
  readPayoutWaterStale,
} from '../../../../../apps/api/src/modules/payout/index.ts';
import { createMetricsRegistry } from '../../../../../apps/api/src/modules/platform/metrics/index.ts';
import { readOnlyUrl } from '../kit.ts';
import {
  EXAMPLE_TOTAL_FEN,
  FRESH,
  HOUR_MS,
  MINUTE_MS,
  NOW,
  W_30000,
  WINDOW_START,
  clockAt,
  insertApplication,
  insertWatermark,
  shift,
  tableSnapshot,
} from '../water-level/water-harness.ts';
import {
  NOT_WAITING,
  expectNotAlerting,
  insertWithdrawal,
  waterStaleGauge,
} from './stale-harness.ts';

async function open() {
  const database = await createTestDatabase();
  const db = createDb({ connectionString: database.urlFor('couli_app'), max: 2 });
  const readOnly = createDb({ connectionString: readOnlyUrl(database), max: 2 });
  return {
    db,
    readOnly,
    async close() {
      await destroyDb(readOnly);
      await destroyDb(db);
      await database.drop();
    },
  };
}

it('[AC-B2-09ze#12]有待执行的提现（APPROVED）：没有 W 值 1，W 新鲜值 0；W 的金额不影响（W=0、W 低于 1.5P 只要新鲜都是 0）', async () => {
  const t = await open();
  try {
    await insertWithdrawal(t.db, { appId: 'stale_no_w' });
    await insertWithdrawal(t.db, { appId: 'stale_fresh' });
    await insertWatermark(t.db, { appId: 'stale_fresh', fen: W_30000 });
    // A W of 0 is fresh all the same: the amount is couli_payout_water_low's business.
    await insertWithdrawal(t.db, { appId: 'stale_fresh_zero' });
    await insertWatermark(t.db, { appId: 'stale_fresh_zero', fen: 0n });
    // BR-WDR-18's example: ¥49,000 applied for, W = ¥30,000 < 1.5P: low, but fresh.
    await insertWithdrawal(t.db, { appId: 'stale_fresh_low' });
    await insertApplication(t.db, { appId: 'stale_fresh_low', amountFen: EXAMPLE_TOTAL_FEN });
    await insertWatermark(t.db, { appId: 'stale_fresh_low', fen: W_30000 });

    const { waterStale } = await readPayoutWaterStale(t.readOnly, clockAt(NOW));
    expect(waterStale['stale_no_w'], 'waiting withdrawals, no W').toBe(1);
    expect(waterStale['stale_fresh'], 'waiting withdrawals, fresh W').toBe(0);
    expect(waterStale['stale_fresh_zero'], 'waiting withdrawals, fresh W of 0').toBe(0);
    expect(waterStale['stale_fresh_low'], 'waiting withdrawals, fresh but low W').toBe(0);
    expect(
      Object.values(waterStale).every((value) => value === 0 || value === 1),
      'values are 0 or 1',
    ).toBe(true);
  } finally {
    await t.close();
  }
}, 60_000);

it('[AC-B2-09ze#13]新鲜与否与 judgeWatermark 同源（D10-807 ①）：t_W 距今恰好 2 小时、2 小时 + 1 ms、没有 W 三种时刻（另加超前 4 分钟），gauge 为 1 当且仅当 judgeWatermark 判 watermark_stale；恰好 2 小时值 0，多 1 ms 值 1，没有 W 值 1', async () => {
  const t = await open();
  try {
    const cases: readonly { readonly appId: string; readonly measuredAt: string | null }[] = [
      { appId: 'stale_edge', measuredAt: shift(NOW, -2 * HOUR_MS) },
      { appId: 'stale_edge_past', measuredAt: shift(NOW, -2 * HOUR_MS - 1) },
      { appId: 'stale_none', measuredAt: null },
      // Entered within the 5 minutes of clock skew D10-241 accepts: fresh.
      { appId: 'stale_ahead', measuredAt: shift(NOW, 4 * MINUTE_MS) },
    ];
    for (const { appId, measuredAt } of cases) {
      await insertWithdrawal(t.db, { appId });
      if (measuredAt !== null) await insertWatermark(t.db, { appId, fen: W_30000, measuredAt });
    }

    const expected: readonly (readonly [string, Readonly<Record<string, number>>])[] = [
      [NOW, { stale_edge: 0, stale_edge_past: 1, stale_none: 1, stale_ahead: 0 }],
      // One millisecond later the edge row is past the limit too.
      [shift(NOW, 1), { stale_edge: 1, stale_edge_past: 1, stale_none: 1, stale_ahead: 0 }],
    ];
    for (const [now, values] of expected) {
      const { waterStale } = await readPayoutWaterStale(t.readOnly, clockAt(now));
      for (const { appId, measuredAt } of cases) {
        // EXECUTE's own judgement of the same reading; nothing else of it can refuse here.
        const verdict = judgeWatermark({
          now: new Date(now),
          reading:
            measuredAt === null
              ? null
              : { availableFen: W_30000, measuredAt: new Date(measuredAt) },
          forecastFen: 0n,
          batchNetFen: 0n,
          payingNetFen: 0n,
          paidSinceNetFen: 0n,
          usableBp: 10_000,
        });
        const stale = !verdict.ok && verdict.reason === 'watermark_stale';
        expect(
          waterStale[appId] === 1,
          `${appId} at ${now}: gauge agrees with judgeWatermark`,
        ).toBe(stale);
      }
      expect(waterStale, `at ${now}`).toEqual(values);
    }
  } finally {
    await t.close();
  }
}, 60_000);

it('[AC-B2-09ze#14]没有待执行的提现不为 1：只有 PENDING_REVIEW / REJECTED / PAYING / PAID_API / PAID_MANUAL / FAILED 的 app，没有 W 或 W 过期都不为 1；只有 W 没有提现的 app 也不为 1', async () => {
  const t = await open();
  try {
    for (const status of NOT_WAITING) {
      const noW = `stale_only_${status.toLowerCase()}`;
      await insertWithdrawal(t.db, { appId: noW, status });
      const old = `stale_only_${status.toLowerCase()}_old_w`;
      await insertWithdrawal(t.db, { appId: old, status });
      await insertWatermark(t.db, {
        appId: old,
        fen: W_30000,
        measuredAt: shift(NOW, -3 * HOUR_MS),
      });
    }
    await insertWatermark(t.db, {
      appId: 'stale_w_only',
      fen: W_30000,
      measuredAt: shift(NOW, -3 * HOUR_MS),
    });
    // Next to them, an app that does alert: the port is read, not just silent.
    await insertWithdrawal(t.db, { appId: 'stale_waiting' });

    const { waterStale } = await readPayoutWaterStale(t.readOnly, clockAt(NOW));
    expect(waterStale['stale_waiting'], 'waiting withdrawals, no W').toBe(1);
    for (const status of NOT_WAITING) {
      expectNotAlerting(waterStale, `stale_only_${status.toLowerCase()}`, `${status}, no W`);
      expectNotAlerting(
        waterStale,
        `stale_only_${status.toLowerCase()}_old_w`,
        `${status}, W 3 hours old`,
      );
    }
    expectNotAlerting(waterStale, 'stale_w_only', 'no withdrawals, W 3 hours old');
  } finally {
    await t.close();
  }
}, 60_000);

it('[AC-B2-09ze#15]只看企业支付宝的 W（各通道分别取，细则「多通道的 W」）：只有 wechat / bank_card 有新鲜 W 时值 1；alipay 的 W 过期而别的通道新鲜也值 1；alipay 新鲜而别的通道过期值 0', async () => {
  const t = await open();
  try {
    await insertWithdrawal(t.db, { appId: 'stale_wechat_w' });
    await insertWatermark(t.db, { appId: 'stale_wechat_w', fen: W_30000, channel: 'wechat' });
    await insertWithdrawal(t.db, { appId: 'stale_bank_w' });
    await insertWatermark(t.db, { appId: 'stale_bank_w', fen: W_30000, channel: 'bank_card' });
    await insertWithdrawal(t.db, { appId: 'stale_alipay_old' });
    await insertWatermark(t.db, {
      appId: 'stale_alipay_old',
      fen: W_30000,
      measuredAt: shift(NOW, -3 * HOUR_MS),
    });
    await insertWatermark(t.db, { appId: 'stale_alipay_old', fen: W_30000, channel: 'wechat' });
    await insertWithdrawal(t.db, { appId: 'stale_alipay_fresh' });
    await insertWatermark(t.db, { appId: 'stale_alipay_fresh', fen: W_30000 });
    await insertWatermark(t.db, {
      appId: 'stale_alipay_fresh',
      fen: W_30000,
      channel: 'bank_card',
      measuredAt: shift(NOW, -3 * HOUR_MS),
    });

    const { waterStale } = await readPayoutWaterStale(t.readOnly, clockAt(NOW));
    expect(waterStale['stale_wechat_w'], 'only a wechat W').toBe(1);
    expect(waterStale['stale_bank_w'], 'only a bank_card W').toBe(1);
    expect(waterStale['stale_alipay_old'], 'alipay stale, wechat fresh').toBe(1);
    expect(waterStale['stale_alipay_fresh'], 'alipay fresh, bank_card stale').toBe(0);
  } finally {
    await t.close();
  }
}, 60_000);

it('[AC-B2-09ze#23]待执行的提现只计与 W 同一通道的单（withdrawals.payout_channel = alipay，细则「多通道的 W」）：只有 wechat / bank_card 的 APPROVED 单时，企业支付宝 W 缺失或过期都不为 1；企业支付宝自己有 APPROVED 单时按 W 判（缺失值 1、新鲜值 0）', async () => {
  const t = await open();
  try {
    // Only another channel's withdrawals wait: enterprise Alipay has nothing to execute.
    await insertWithdrawal(t.db, { appId: 'stale_wechat_only_no_w', channel: 'wechat' });
    await insertWithdrawal(t.db, { appId: 'stale_bank_only_no_w', channel: 'bank_card' });
    await insertWithdrawal(t.db, { appId: 'stale_wechat_only_old_w', channel: 'wechat' });
    await insertWatermark(t.db, {
      appId: 'stale_wechat_only_old_w',
      fen: W_30000,
      measuredAt: shift(NOW, -3 * HOUR_MS),
    });
    await insertWithdrawal(t.db, { appId: 'stale_bank_only_old_w', channel: 'bank_card' });
    await insertWatermark(t.db, {
      appId: 'stale_bank_only_old_w',
      fen: W_30000,
      measuredAt: shift(NOW, -3 * HOUR_MS),
    });
    // Alipay's own withdrawal is past waiting (PAYING); the waiting one is wechat's.
    await insertWithdrawal(t.db, { appId: 'stale_alipay_paying_wechat_waiting', status: 'PAYING' });
    await insertWithdrawal(t.db, {
      appId: 'stale_alipay_paying_wechat_waiting',
      channel: 'wechat',
    });
    // Enterprise Alipay has a waiting withdrawal of its own: judged by its W.
    await insertWithdrawal(t.db, { appId: 'stale_mixed_no_w', channel: 'wechat' });
    await insertWithdrawal(t.db, { appId: 'stale_mixed_no_w' });
    await insertWithdrawal(t.db, { appId: 'stale_mixed_old_w', channel: 'bank_card' });
    await insertWithdrawal(t.db, { appId: 'stale_mixed_old_w' });
    await insertWatermark(t.db, {
      appId: 'stale_mixed_old_w',
      fen: W_30000,
      measuredAt: shift(NOW, -3 * HOUR_MS),
    });
    await insertWithdrawal(t.db, { appId: 'stale_mixed_fresh', channel: 'bank_card' });
    await insertWithdrawal(t.db, { appId: 'stale_mixed_fresh' });
    await insertWatermark(t.db, { appId: 'stale_mixed_fresh', fen: W_30000 });

    const { waterStale } = await readPayoutWaterStale(t.readOnly, clockAt(NOW));
    expectNotAlerting(waterStale, 'stale_wechat_only_no_w', 'only wechat waiting, no W');
    expectNotAlerting(waterStale, 'stale_bank_only_no_w', 'only bank_card waiting, no W');
    expectNotAlerting(waterStale, 'stale_wechat_only_old_w', 'only wechat waiting, alipay W old');
    expectNotAlerting(waterStale, 'stale_bank_only_old_w', 'only bank_card waiting, alipay W old');
    expectNotAlerting(
      waterStale,
      'stale_alipay_paying_wechat_waiting',
      'alipay PAYING, wechat waiting, no W',
    );
    expect(waterStale['stale_mixed_no_w'], 'alipay and wechat waiting, no W').toBe(1);
    expect(waterStale['stale_mixed_old_w'], 'alipay and bank_card waiting, alipay W old').toBe(1);
    expect(waterStale['stale_mixed_fresh'], 'alipay and bank_card waiting, alipay W fresh').toBe(0);
  } finally {
    await t.close();
  }
}, 60_000);

it('[AC-B2-09ze#16]取的是最新一行 W（按 measured_at，不按写入先后），端口不缓存：较新的新鲜 W 盖过旧行；再录一行新鲜 W 下一次读就从 1 变 0；早于近 7 日窗口建的待执行单同样算', async () => {
  const t = await open();
  try {
    // The fresh row was written first, the old one after: measured_at decides.
    await insertWithdrawal(t.db, { appId: 'stale_latest' });
    await insertWatermark(t.db, { appId: 'stale_latest', fen: W_30000, measuredAt: FRESH });
    await insertWatermark(t.db, {
      appId: 'stale_latest',
      fen: W_30000,
      measuredAt: shift(NOW, -5 * HOUR_MS),
    });
    // Only an old row so far; a waiting withdrawal created long before the forecast window.
    await insertWithdrawal(t.db, {
      appId: 'stale_reentered',
      createdAt: shift(WINDOW_START, -30 * 24 * HOUR_MS),
    });
    await insertWatermark(t.db, {
      appId: 'stale_reentered',
      fen: W_30000,
      measuredAt: shift(NOW, -3 * HOUR_MS),
    });

    expect(await readPayoutWaterStale(t.readOnly, clockAt(NOW))).toEqual({
      waterStale: { stale_latest: 0, stale_reentered: 1 },
    });

    // Finance enters W again: the next read follows at once.
    await insertWatermark(t.db, { appId: 'stale_reentered', fen: W_30000, measuredAt: FRESH });
    expect(await readPayoutWaterStale(t.readOnly, clockAt(NOW))).toEqual({
      waterStale: { stale_latest: 0, stale_reentered: 0 },
    });
  } finally {
    await t.close();
  }
}, 60_000);

it('[AC-B2-09ze#17]多 app 各算各的：一个 app 的 W 不顶替另一个 app 的；一个 app 有多笔待执行单也只一个样本', async () => {
  const t = await open();
  try {
    await insertWithdrawal(t.db, { appId: 'stale_app_waiting' });
    await insertWithdrawal(t.db, { appId: 'stale_app_waiting' });
    await insertWithdrawal(t.db, { appId: 'stale_app_waiting' });
    // Another app's fresh W does not count for stale_app_waiting.
    await insertWatermark(t.db, { appId: 'stale_app_other', fen: W_30000 });
    await insertWithdrawal(t.db, { appId: 'stale_app_fresh' });
    await insertWithdrawal(t.db, { appId: 'stale_app_fresh' });
    await insertWatermark(t.db, { appId: 'stale_app_fresh', fen: W_30000 });

    const { waterStale } = await readPayoutWaterStale(t.readOnly, clockAt(NOW));
    expect(waterStale['stale_app_waiting'], 'three waiting withdrawals, no own W').toBe(1);
    expect(waterStale['stale_app_fresh'], 'two waiting withdrawals, own fresh W').toBe(0);
    expectNotAlerting(waterStale, 'stale_app_other', 'a W but no withdrawals');
  } finally {
    await t.close();
  }
}, 60_000);

it('[AC-B2-09ze#18]只读、只用注入时钟：只读事务可跑、两张表的行前后不变；W 的新旧只看注入时钟（库的 now() 早好几年，按库时钟 3 小时前的 W 还在未来）；worker registry 以该端口渲染出同样的值', async () => {
  const t = await open();
  try {
    await insertWithdrawal(t.db, { appId: 'stale_clock_old' });
    await insertWatermark(t.db, {
      appId: 'stale_clock_old',
      fen: W_30000,
      measuredAt: shift(NOW, -3 * HOUR_MS),
    });
    await insertWithdrawal(t.db, { appId: 'stale_clock_fresh' });
    await insertWatermark(t.db, { appId: 'stale_clock_fresh', fen: W_30000 });
    // The session really is read-only: the port cannot write behind the test's back.
    await expect(
      insertWatermark(t.readOnly, { appId: 'stale_clock_old', fen: 1n }),
      'fixture session must be read-only',
    ).rejects.toThrow(/read-only/);
    const before = await tableSnapshot(t.db);

    const clock = clockAt(NOW);
    expect(await readPayoutWaterStale(t.readOnly, clock)).toEqual({
      waterStale: { stale_clock_old: 1, stale_clock_fresh: 0 },
    });
    expect(await tableSnapshot(t.db), 'rows unchanged by the read').toEqual(before);

    // Three hours after the fresh reading by the injected clock: both are stale now.
    expect(await readPayoutWaterStale(t.readOnly, clockAt(shift(FRESH, 3 * HOUR_MS)))).toEqual({
      waterStale: { stale_clock_old: 1, stale_clock_fresh: 1 },
    });

    const registry = createMetricsRegistry({
      entry: 'worker',
      collectWaterStale: () => readPayoutWaterStale(t.readOnly, clock),
    });
    expect(waterStaleGauge(await registry.render())).toEqual({
      stale_clock_old: 1,
      stale_clock_fresh: 0,
    });
  } finally {
    await t.close();
  }
}, 60_000);

/** An older alipay withdrawal still APPROVED, then a newer alipay one past or short of waiting. */
async function insertWaitingThenNewer(db: Parameters<typeof insertWithdrawal>[0], appId: string) {
  await insertWithdrawal(db, { appId, createdAt: shift(NOW, -3 * HOUR_MS) });
  await insertWithdrawal(db, {
    appId,
    status: 'PENDING_REVIEW',
    createdAt: shift(NOW, -10 * MINUTE_MS),
  });
}

it('[AC-B2-09ze#24]判断依据是「存在待执行（APPROVED）的企业支付宝单」，不是「取该 app / 通道最新一笔提现看状态」：较早一笔 alipay 仍 APPROVED、之后又来一笔较新的 alipay PENDING_REVIEW，alipay 没有 W 或最新 W 已过期（距注入时钟 2 小时 + 1 ms）时，样本都存在且值 1', async () => {
  const t = await open();
  try {
    await insertWaitingThenNewer(t.db, 'stale_newer_pending_no_w');
    await insertWaitingThenNewer(t.db, 'stale_newer_pending_old_w');
    // NOW is 2031-04-05T06:07:08.000Z; two hours and one millisecond before it, by hand.
    await insertWatermark(t.db, {
      appId: 'stale_newer_pending_old_w',
      fen: W_30000,
      measuredAt: '2031-04-05T04:07:07.999Z',
    });
    // The same shape with a W exactly two hours old: fresh, so the port is judging W, not silent.
    await insertWaitingThenNewer(t.db, 'stale_newer_pending_edge_w');
    await insertWatermark(t.db, {
      appId: 'stale_newer_pending_edge_w',
      fen: W_30000,
      measuredAt: '2031-04-05T04:07:08.000Z',
    });

    const { waterStale } = await readPayoutWaterStale(t.readOnly, clockAt(NOW));
    for (const [appId, where] of [
      ['stale_newer_pending_no_w', 'older APPROVED, newer PENDING_REVIEW, no W'],
      ['stale_newer_pending_old_w', 'older APPROVED, newer PENDING_REVIEW, W 2 h + 1 ms old'],
    ] as const) {
      expect(Object.hasOwn(waterStale, appId), `${where}: ${appId} has a sample`).toBe(true);
      expect(waterStale[appId], where).toBe(1);
    }
    expect(
      waterStale['stale_newer_pending_edge_w'],
      'older APPROVED, newer PENDING_REVIEW, W exactly 2 h old',
    ).toBe(0);
  } finally {
    await t.close();
  }
}, 60_000);
