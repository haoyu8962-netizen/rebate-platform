// B2-09j: payout's water level port against PostgreSQL (BR-WDR-18「W < 1.5P 时告警财务」及其例子,
// D10-592). Per app_id, alipay only: 1 when W < 1.5P, 0 when not low, no key when there is no
// conclusion (no W, or W older than 2 hours). A session whose every transaction is READ ONLY runs
// the port, so any write fails in PostgreSQL itself, and the rows are compared before and after.
// "Now" is the injected clock only: the database's own now() is years before the fixture's times.
import { createDb, destroyDb } from '@couli/db';
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { readPayoutWaterLow } from '../../../../../apps/api/src/modules/payout/index.ts';
import { createMetricsRegistry } from '../../../../../apps/api/src/modules/platform/metrics/index.ts';
import { readOnlyUrl } from '../kit.ts';
import {
  EXAMPLE_TOTAL_FEN,
  FRESH,
  HOUR_MS,
  IN_WINDOW,
  MINUTE_MS,
  NOW,
  WINDOW_END,
  WINDOW_START,
  W_20000,
  W_30000,
  W_31499_99,
  W_31500,
  clockAt,
  insertApplication,
  insertWatermark,
  seedExample,
  seedWindowTotal,
  shift,
  tableSnapshot,
  waterLowGauge,
} from './water-harness.ts';

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

it('[AC-B2-09j#4] BR-WDR-18 的例子：近 7 日申请合计 ¥49,000（P=¥21,000）。W=¥30,000 值 1；W=¥31,500（恰为 1.5P）值 0；W=¥31,499.99 值 1', async () => {
  const t = await open();
  try {
    await seedExample(t.db, 'water_30000', W_30000);
    await seedExample(t.db, 'water_31500', W_31500);
    await seedExample(t.db, 'water_31499_99', W_31499_99);

    expect(await readPayoutWaterLow(t.readOnly, clockAt(NOW))).toEqual({
      waterLow: { water_30000: 1, water_31500: 0, water_31499_99: 1 },
    });
  } finally {
    await t.close();
  }
}, 60_000);

it('[AC-B2-09j#5] W < P 也是 1：W=¥20,000 时打款已被拒，1.5P 这条线同样成立', async () => {
  const t = await open();
  try {
    await seedExample(t.db, 'water_20000', W_20000);

    expect(await readPayoutWaterLow(t.readOnly, clockAt(NOW))).toEqual({
      waterLow: { water_20000: 1 },
    });
  } finally {
    await t.close();
  }
}, 60_000);

it('[AC-B2-09j#6] 不下结论没有样本：没有 W 行的 app、W 过期的 app（低或不低都一样）没有样本，恰好 2 小时还有样本、多 1 毫秒没有；别的 app 不受影响', async () => {
  const t = await open();
  try {
    const twoHoursAgo = shift(NOW, -2 * HOUR_MS);
    const justStale = shift(twoHoursAgo, -1);
    // Applications but no W: nothing to compare.
    await insertApplication(t.db, { appId: 'water_no_w', amountFen: EXAMPLE_TOTAL_FEN });
    // Past the limit by one millisecond, whether the old W would read low or not.
    await insertApplication(t.db, { appId: 'water_stale_low', amountFen: EXAMPLE_TOTAL_FEN });
    await insertWatermark(t.db, { appId: 'water_stale_low', fen: W_30000, measuredAt: justStale });
    await insertApplication(t.db, { appId: 'water_stale_high', amountFen: EXAMPLE_TOTAL_FEN });
    await insertWatermark(t.db, { appId: 'water_stale_high', fen: W_31500, measuredAt: justStale });
    // Exactly at the limit: still a conclusion.
    await insertApplication(t.db, { appId: 'water_edge', amountFen: EXAMPLE_TOTAL_FEN });
    await insertWatermark(t.db, { appId: 'water_edge', fen: W_30000, measuredAt: twoHoursAgo });
    await insertApplication(t.db, { appId: 'water_edge_high', amountFen: EXAMPLE_TOTAL_FEN });
    await insertWatermark(t.db, {
      appId: 'water_edge_high',
      fen: W_31500,
      measuredAt: twoHoursAgo,
    });
    // Unaffected next to all of them.
    await seedExample(t.db, 'water_fresh', W_30000);

    expect(await readPayoutWaterLow(t.readOnly, clockAt(NOW))).toEqual({
      waterLow: { water_edge: 1, water_edge_high: 0, water_fresh: 1 },
    });
    // One millisecond later the edge rows are stale too.
    expect(await readPayoutWaterLow(t.readOnly, clockAt(shift(NOW, 1)))).toEqual({
      waterLow: { water_fresh: 1 },
    });
  } finally {
    await t.close();
  }
}, 60_000);

it('[AC-B2-09j#7] 多 app：各算各的 W 和 P，每个 app 一个样本（一个 app 有多行 W 也只一个样本）', async () => {
  const t = await open();
  try {
    // ¥49,000 applied for: 1.5P = ¥31,500, so ¥30,000 is low.
    await seedExample(t.db, 'water_big_low', W_30000);
    await insertWatermark(t.db, {
      appId: 'water_big_low',
      fen: W_30000,
      measuredAt: shift(FRESH, -MINUTE_MS),
    });
    // ¥7,000 applied for: 1.5P = ¥4,500. The same ¥30,000 is not low here; with the applications
    // of both apps added up it would be.
    await insertApplication(t.db, { appId: 'water_small_high', amountFen: 700_000n });
    await insertWatermark(t.db, { appId: 'water_small_high', fen: W_30000 });
    // ¥7,000 applied for and W one fen below ¥4,500: low on its own W, which another app's W hides.
    await insertApplication(t.db, { appId: 'water_small_low', amountFen: 700_000n });
    await insertWatermark(t.db, { appId: 'water_small_low', fen: 449_999n });

    expect(await readPayoutWaterLow(t.readOnly, clockAt(NOW))).toEqual({
      waterLow: { water_big_low: 1, water_small_high: 0, water_small_low: 1 },
    });
  } finally {
    await t.close();
  }
}, 60_000);

it('[AC-B2-09j#8] 只看 alipay：wechat / bank_card 的 W 和提现都不影响结论；只有别的通道有 W、或 alipay 的 W 过期而别的通道新鲜，都没有样本', async () => {
  const t = await open();
  try {
    // Other channels' applications would make this W low; their W, newer and 0, would too.
    await seedExample(t.db, 'water_other_apps', W_31500);
    await insertApplication(t.db, {
      appId: 'water_other_apps',
      amountFen: 70_000_000n,
      channel: 'wechat',
    });
    await insertApplication(t.db, {
      appId: 'water_other_apps',
      amountFen: 70_000_000n,
      channel: 'bank_card',
    });
    await insertWatermark(t.db, {
      appId: 'water_other_apps',
      fen: 0n,
      channel: 'wechat',
      measuredAt: shift(FRESH, MINUTE_MS),
    });
    // Another channel's newer, larger W would make this one not low.
    await seedExample(t.db, 'water_other_w_high', W_30000);
    await insertWatermark(t.db, {
      appId: 'water_other_w_high',
      fen: 999_999_999n,
      channel: 'bank_card',
      measuredAt: shift(FRESH, MINUTE_MS),
    });
    // Only other channels have a W: no conclusion for alipay.
    await insertApplication(t.db, {
      appId: 'water_wechat_only',
      amountFen: EXAMPLE_TOTAL_FEN,
      channel: 'wechat',
    });
    await insertWatermark(t.db, { appId: 'water_wechat_only', fen: W_30000, channel: 'wechat' });
    // alipay's W is stale; another channel's fresh W does not stand in for it.
    await insertApplication(t.db, { appId: 'water_alipay_stale', amountFen: EXAMPLE_TOTAL_FEN });
    await insertWatermark(t.db, {
      appId: 'water_alipay_stale',
      fen: W_30000,
      measuredAt: shift(NOW, -3 * HOUR_MS),
    });
    await insertWatermark(t.db, { appId: 'water_alipay_stale', fen: W_30000, channel: 'wechat' });
    // Applications on another channel only: alipay's own P is 0, so its W is not low.
    await insertWatermark(t.db, { appId: 'water_wechat_applied', fen: W_30000 });
    await insertApplication(t.db, {
      appId: 'water_wechat_applied',
      amountFen: EXAMPLE_TOTAL_FEN,
      channel: 'wechat',
    });

    expect(await readPayoutWaterLow(t.readOnly, clockAt(NOW))).toEqual({
      waterLow: { water_other_apps: 0, water_other_w_high: 1, water_wechat_applied: 0 },
    });
  } finally {
    await t.close();
  }
}, 60_000);

it('[AC-B2-09j#9] 取的是最新一行 W，端口不缓存：较新的 W 决定结论，再录一行更新的 W 下一次读就跟着变', async () => {
  const t = await open();
  try {
    await insertApplication(t.db, { appId: 'water_latest', amountFen: EXAMPLE_TOTAL_FEN });
    // Written in the opposite order of their measuring times: measured_at decides, not the insert.
    await insertWatermark(t.db, { appId: 'water_latest', fen: W_31500, measuredAt: FRESH });
    await insertWatermark(t.db, {
      appId: 'water_latest',
      fen: W_30000,
      measuredAt: shift(FRESH, -MINUTE_MS),
    });
    expect(await readPayoutWaterLow(t.readOnly, clockAt(NOW))).toEqual({
      waterLow: { water_latest: 0 },
    });

    await insertWatermark(t.db, {
      appId: 'water_latest',
      fen: W_30000,
      measuredAt: shift(FRESH, MINUTE_MS),
    });
    expect(await readPayoutWaterLow(t.readOnly, clockAt(NOW))).toEqual({
      waterLow: { water_latest: 1 },
    });
  } finally {
    await t.close();
  }
}, 60_000);

it('[AC-B2-09j#10] P 的口径同 BR-WDR-18：近 7 个完整自然日（+08:00，含起点、不含当日）的 amount_fen，不含 REJECTED；FAILED 计入', async () => {
  const t = await open();
  try {
    // Together ¥49,000 of amount_fen (P = ¥21,000), so 1.5P = ¥31,500 for both apps below: a row
    // that should not count would make ¥31,500 low, one that is missing (or net_fen in place of
    // amount_fen) would make ¥31,499.99 not low.
    const seed = async (appId: string, fen: bigint): Promise<void> => {
      await insertApplication(t.db, { appId, amountFen: 2_000_000n, createdAt: WINDOW_START });
      await insertApplication(t.db, { appId, amountFen: 1_900_000n, feeFen: 100_000n });
      await insertApplication(t.db, { appId, amountFen: 1_000_000n, status: 'FAILED' });
      await insertApplication(t.db, {
        appId,
        amountFen: 9_000_000n,
        createdAt: shift(WINDOW_START, -1),
      });
      await insertApplication(t.db, { appId, amountFen: 9_000_000n, createdAt: WINDOW_END });
      await insertApplication(t.db, {
        appId,
        amountFen: 9_000_000n,
        createdAt: IN_WINDOW,
        status: 'REJECTED',
      });
      await insertWatermark(t.db, { appId, fen });
    };
    await seed('water_p_below', W_31499_99);
    await seed('water_p_exact', W_31500);

    expect(await readPayoutWaterLow(t.readOnly, clockAt(NOW))).toEqual({
      waterLow: { water_p_below: 1, water_p_exact: 0 },
    });
  } finally {
    await t.close();
  }
}, 60_000);

it('[AC-B2-09j#11] 有 W、近 7 日没有提现时 P=0：下结论「不低」（W=0 也是 0，0 < 0 不成立），不是没有样本', async () => {
  const t = await open();
  try {
    await insertWatermark(t.db, { appId: 'water_no_p', fen: W_30000 });
    await insertWatermark(t.db, { appId: 'water_no_p_zero', fen: 0n });

    expect(await readPayoutWaterLow(t.readOnly, clockAt(NOW))).toEqual({
      waterLow: { water_no_p: 0, water_no_p_zero: 0 },
    });
  } finally {
    await t.close();
  }
}, 60_000);

it('[AC-B2-09j#12] 只读、只用注入时钟：只读事务可跑、两张表的行前后不变；W 的新旧只看注入时钟（库的 now() 早好几年）；worker registry 以该端口渲染出同样的值', async () => {
  const t = await open();
  try {
    await seedExample(t.db, 'water_low', W_30000);
    await seedExample(t.db, 'water_high', W_31500);
    // The session really is read-only: the port cannot write behind the test's back.
    await expect(
      insertWatermark(t.readOnly, { appId: 'water_low', fen: 1n }),
      'fixture session must be read-only',
    ).rejects.toThrow(/read-only/);
    const before = await tableSnapshot(t.db);

    const clock = clockAt(NOW);
    expect(await readPayoutWaterLow(t.readOnly, clock)).toEqual({
      waterLow: { water_low: 1, water_high: 0 },
    });
    expect(await tableSnapshot(t.db), 'rows unchanged by the read').toEqual(before);

    // Three hours after the reading by the injected clock: stale, whatever the database thinks.
    expect(await readPayoutWaterLow(t.readOnly, clockAt(shift(FRESH, 3 * HOUR_MS)))).toEqual({
      waterLow: {},
    });

    const registry = createMetricsRegistry({
      entry: 'worker',
      collectWaterLow: () => readPayoutWaterLow(t.readOnly, clock),
    });
    expect(waterLowGauge(await registry.render())).toEqual({ water_low: 1, water_high: 0 });
  } finally {
    await t.close();
  }
}, 60_000);

it('[AC-B2-09j#25] P 的舍入是 round_half_up(合计 / 7) × 3：Σ=4,900,004 日均 700,000.57 入为 700,001、P=2,100,003、1.5P=3,150,004.5，W=3,150,004 值 1、W=3,150,005 值 0；Σ=4,900,003 日均 700,000.43 舍为 700,000、P=2,100,000、1.5P=3,150,000，W=3,149,999 值 1、W=3,150,000 值 0', async () => {
  const t = await open();
  try {
    // Rounds up: flooring the average gives P = 2,100,000 and misses the first of these.
    await seedWindowTotal(t.db, 'water_round_up_below', 4_900_004n, 3_150_004n);
    await seedWindowTotal(t.db, 'water_round_up_above', 4_900_004n, 3_150_005n);
    // Rounds down: taking the ceiling gives P = 2,100,003 and alerts on the second of these.
    await seedWindowTotal(t.db, 'water_round_down_below', 4_900_003n, 3_149_999n);
    await seedWindowTotal(t.db, 'water_round_down_exact', 4_900_003n, 3_150_000n);

    expect(await readPayoutWaterLow(t.readOnly, clockAt(NOW))).toEqual({
      waterLow: {
        water_round_up_below: 1,
        water_round_up_above: 0,
        water_round_down_below: 1,
        water_round_down_exact: 0,
      },
    });
  } finally {
    await t.close();
  }
}, 60_000);

it('[AC-B2-09j#26] 1.5P 不是整数时不截断：七日合计 7 分，P=3、1.5P=4.5；W=4 值 1（4 < 4.5）、W=5 值 0', async () => {
  const t = await open();
  try {
    await seedWindowTotal(t.db, 'water_half_below', 7n, 4n);
    await seedWindowTotal(t.db, 'water_half_above', 7n, 5n);

    expect(await readPayoutWaterLow(t.readOnly, clockAt(NOW))).toEqual({
      waterLow: { water_half_below: 1, water_half_above: 0 },
    });
  } finally {
    await t.close();
  }
}, 60_000);

it('[AC-B2-09j#28] 取数时间相同时按 created_at 较晚的一行（录错更正）：W=¥30,000 更正为 W=¥31,500 值 0，写入先后颠倒也一样；W=¥31,500 更正为 W=¥30,000 值 1', async () => {
  const t = await open();
  try {
    const entered = shift(FRESH, MINUTE_MS);
    const corrected = shift(FRESH, 2 * MINUTE_MS);
    const seed = async (
      appId: string,
      rows: readonly (readonly [fen: bigint, createdAt: string])[],
    ): Promise<void> => {
      await insertApplication(t.db, { appId, amountFen: EXAMPLE_TOTAL_FEN });
      for (const [fen, createdAt] of rows) {
        await insertWatermark(t.db, { appId, fen, measuredAt: FRESH, createdAt });
      }
    };
    await seed('water_fix_up', [
      [W_30000, entered],
      [W_31500, corrected],
    ]);
    // Written in the opposite order: created_at decides, not the insert.
    await seed('water_fix_up_reversed', [
      [W_31500, corrected],
      [W_30000, entered],
    ]);
    // The other direction: neither the larger nor the smaller W wins as such.
    await seed('water_fix_down', [
      [W_31500, entered],
      [W_30000, corrected],
    ]);

    expect(await readPayoutWaterLow(t.readOnly, clockAt(NOW))).toEqual({
      waterLow: { water_fix_up: 0, water_fix_up_reversed: 0, water_fix_down: 1 },
    });
  } finally {
    await t.close();
  }
}, 60_000);
