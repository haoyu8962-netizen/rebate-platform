// B2-09zj: payout's payout failure port against PostgreSQL (BR-WDR-24 前两项及其例子; D10-1157,
// D10-1170, D10-1186, D10-1203; ops/tasks/B2-09zj.yaml 口径). Per app_id: today's W6 count and
// W5 + W6 count (the +08:00 day of the injected clock, by transition time), and the streak
// (D10-1203): the app's W5 / W6 ordered by (updated_at, id), cut into runs of consecutive W6 (a W5
// ends a run); the length of the longest run whose last W6 has updated_at ∈ (now − 24h, now],
// counted whole (it may reach back before the window), 0 without such a run; not cut at the day,
// not persisted. The transition time of W5 and W6 alike is
// withdrawals.updated_at (D10-1186), not paid_at and not any attempt's at. W6 = FAILED without a
// manual resolution; W5 = PAID_API without a manual resolution and without a failed transfer
// attempt; W8, W9, W10 (paid or failed), W11 and withdrawals still in flight never count, neither in
// the day nor in the run, and do not break the run. An app without any count may have no sample: 0
// and no sample are read alike. A session whose every transaction is READ ONLY runs the port, so any
// write fails in PostgreSQL itself. "Now" is the injected clock only: the database's own now() is
// years before the fixture.
import { randomUUID } from 'node:crypto';
import { createDb, destroyDb } from '@couli/db';
import { createTestDatabase } from '@couli/db/testing';
import { propParams } from '@couli/testing';
import fc from 'fast-check';
import { sql } from 'kysely';
import { expect, it } from 'vitest';
import { readPayoutWithdrawalFail } from '../../../../../apps/api/src/modules/payout/index.ts';
import { createMetricsRegistry } from '../../../../../apps/api/src/modules/platform/metrics/index.ts';
import { insertUser } from '../../fund-metrics/kit.ts';
import { readOnlyUrl } from '../kit.ts';
import { HOUR_MS, MINUTE_MS, NOW, clockAt, shift } from '../water-level/water-harness.ts';
import {
  DAY_MS,
  NEXT_DAY_START,
  NOT_COUNTED,
  TODAY_START,
  YESTERDAY_EVENING,
  expectCounts,
  expectedOf,
  failFromText,
  insertOutcome,
  minutesFromNow,
  tableSnapshot,
  valuesOf,
  type FailHandles,
  type Outcome,
  type OutcomeRow,
} from './fail-harness.ts';

async function open() {
  const database = await createTestDatabase();
  const db = createDb({ connectionString: database.urlFor('couli_app'), max: 2 });
  const payout = createDb({ connectionString: database.urlFor('couli_payout'), max: 2 });
  const readOnly = createDb({ connectionString: readOnlyUrl(database), max: 2 });
  const handles: FailHandles = { db, payout };
  return {
    handles,
    db,
    readOnly,
    async close() {
      await destroyDb(readOnly);
      await destroyDb(payout);
      await destroyDb(db);
      await database.drop();
    },
  };
}

type Port = Awaited<ReturnType<typeof readPayoutWithdrawalFail>>;

/** One read of the port at `instant`, checked for well-formed counts. */
async function readAt(readOnly: Parameters<typeof readPayoutWithdrawalFail>[0], instant: string) {
  const values: Port = await readPayoutWithdrawalFail(readOnly, clockAt(instant));
  expectCounts(values, `at ${instant}`);
  return values;
}

/** Inserts the rows one after another. */
async function seed(handles: FailHandles, rows: readonly OutcomeRow[]): Promise<void> {
  for (const row of rows) await insertOutcome(handles, row);
}

/** `count` rows of one outcome, one minute apart from `first`. */
function series(appId: string, outcome: Outcome, first: string, count: number): OutcomeRow[] {
  return Array.from({ length: count }, (_, i) => ({
    appId,
    outcome,
    at: shift(first, i * MINUTE_MS),
  }));
}

/** Rows of one app at whole hours from NOW (negative: before). */
function slow(appId: string, list: readonly (readonly [Outcome, number])[]): OutcomeRow[] {
  return list.map(([outcome, hours]) => ({ appId, outcome, at: shift(NOW, hours * HOUR_MS) }));
}

it('[AC-B2-09zj#12] 08 的例子：当日 30 笔 W5/W6 中 1 笔 W6 → W6 1、W5+W6 30；10 笔中 1 笔 → 1、10；10 笔里最后 3 笔连续 W6 → 3、10、最长连续 3（分母不足仍可按连续告警）；只有第一笔是 W6、之后全是 W5 时最长连续为 1', async () => {
  const t = await open();
  try {
    // 01:00 +08:00 the W6, from 02:00 the W5s: one W6 alone, never two in a row.
    await seed(t.handles, [
      { appId: 'fail_example_30', outcome: 'W6', at: shift(TODAY_START, HOUR_MS) },
      ...series('fail_example_30', 'W5', shift(TODAY_START, 2 * HOUR_MS), 29),
      { appId: 'fail_example_10', outcome: 'W6', at: shift(TODAY_START, HOUR_MS) },
      ...series('fail_example_10', 'W5', shift(TODAY_START, 2 * HOUR_MS), 9),
      ...series('fail_example_10_run', 'W5', shift(TODAY_START, HOUR_MS), 7),
      ...series('fail_example_10_run', 'W6', shift(TODAY_START, 3 * HOUR_MS), 3),
    ]);

    const values = await readAt(t.readOnly, NOW);
    expect(valuesOf(values, 'fail_example_30'), '1 W6 in 30').toEqual({
      w6Today: 1,
      w5w6Today: 30,
      w6Streak: 1,
    });
    expect(valuesOf(values, 'fail_example_10'), '1 W6 in 10').toEqual({
      w6Today: 1,
      w5w6Today: 10,
      w6Streak: 1,
    });
    expect(valuesOf(values, 'fail_example_10_run'), '3 W6 in a row closing 10').toEqual({
      w6Today: 3,
      w5w6Today: 10,
      w6Streak: 3,
    });
  } finally {
    await t.close();
  }
}, 120_000);

it('[AC-B2-09zj#13] 只计 W5 / W6：W10 判 FAILED（manual_resolution failed，带查询失败记录）、W9（转账失败但回到 APPROVED）、仍在 PAYING 的单不算 W6、不接长连续；W8（PAID_MANUAL）与 W10 判成功（manual_resolution paid）不算 W5、不打断连续（W6、W8、W6、W10 判成功、W6 的最长连续为 3）；只有这些单（含 W11、REJECTED、PENDING_REVIEW）的 app 三个值都是 0', async () => {
  const t = await open();
  try {
    await seed(t.handles, [
      // One W6 at 10:07 +08:00, then fail-looking outcomes that are no W6.
      { appId: 'fail_excl_failish', outcome: 'W6', at: minutesFromNow(-240) },
      { appId: 'fail_excl_failish', outcome: 'W10_FAILED', at: minutesFromNow(-180) },
      { appId: 'fail_excl_failish', outcome: 'W9', at: minutesFromNow(-120) },
      { appId: 'fail_excl_failish', outcome: 'PAYING', at: minutesFromNow(-60) },
      // Three W6 with paid-looking outcomes between them that are no W5.
      { appId: 'fail_excl_paidish', outcome: 'W6', at: minutesFromNow(-240) },
      { appId: 'fail_excl_paidish', outcome: 'W8', at: minutesFromNow(-210) },
      { appId: 'fail_excl_paidish', outcome: 'W6', at: minutesFromNow(-180) },
      { appId: 'fail_excl_paidish', outcome: 'W10_PAID', at: minutesFromNow(-150) },
      { appId: 'fail_excl_paidish', outcome: 'W6', at: minutesFromNow(-120) },
      // Nothing but outcomes that never count.
      ...NOT_COUNTED.map((outcome, i) => ({
        appId: 'fail_excl_only',
        outcome,
        at: minutesFromNow(-300 + 30 * i),
      })),
    ]);

    const values = await readAt(t.readOnly, NOW);
    expect(valuesOf(values, 'fail_excl_failish'), 'W6, then W10 failed / W9 / PAYING').toEqual({
      w6Today: 1,
      w5w6Today: 1,
      w6Streak: 1,
    });
    expect(valuesOf(values, 'fail_excl_paidish'), 'W6, W8, W6, W10 paid, W6').toEqual({
      w6Today: 3,
      w5w6Today: 3,
      w6Streak: 3,
    });
    expect(valuesOf(values, 'fail_excl_only'), `only ${NOT_COUNTED.join(', ')}`).toEqual({
      w6Today: 0,
      w5w6Today: 0,
      w6Streak: 0,
    });
  } finally {
    await t.close();
  }
}, 120_000);

it('[AC-B2-09zj#14] 自然日按 +08:00 与注入时钟（updated_at 取时）：00:00 +08:00 前 1 毫秒的 W5 / W6 不计入当日，恰好 00:00 的计入；时钟到次日 00:00 前 1 毫秒仍是同一天，到次日 00:00 当日计数清零；时钟在前一天最后 1 毫秒时，计入的是前一天那两笔；连续不按当日切、只看段尾是否在 24 小时内（D10-1203）：次日 00:00 前 1 毫秒时前一天 23:59:59.999 那笔恰在 now − 24h 上，段尾出窗 → 0，当日 00:00 那笔仍在窗内 → 1；次日 00:00 时当日 00:00 那笔也恰在 now − 24h 上 → 0；只有 W5 的为 0；updated_at 恰为 now 的计入', async () => {
  const t = await open();
  try {
    const justBefore = shift(TODAY_START, -1);
    await seed(t.handles, [
      { appId: 'fail_day_w6_before', outcome: 'W6', at: justBefore },
      { appId: 'fail_day_w6_start', outcome: 'W6', at: TODAY_START },
      { appId: 'fail_day_w5_before', outcome: 'W5', at: justBefore },
      { appId: 'fail_day_w5_start', outcome: 'W5', at: TODAY_START },
    ]);
    const apps = [
      'fail_day_w6_before',
      'fail_day_w6_start',
      'fail_day_w5_before',
      'fail_day_w5_start',
    ] as const;
    const today = {
      fail_day_w6_before: { w6Today: 0, w5w6Today: 0 },
      fail_day_w6_start: { w6Today: 1, w5w6Today: 1 },
      fail_day_w5_before: { w6Today: 0, w5w6Today: 0 },
      fail_day_w5_start: { w6Today: 0, w5w6Today: 1 },
    };
    // At NOW (14:07:08 +08:00) both W6 lie within the last 24 hours.
    const streakAtNow = {
      fail_day_w6_before: 1,
      fail_day_w6_start: 1,
      fail_day_w5_before: 0,
      fail_day_w5_start: 0,
    };
    // At 23:59:59.999 the W6 of 23:59:59.999 the day before is exactly now − 24h: its run ends
    // outside the window, so it no longer counts (D10-1203); 00:00 today is still inside.
    const streakAtDayEnd = {
      fail_day_w6_before: 0,
      fail_day_w6_start: 1,
      fail_day_w5_before: 0,
      fail_day_w5_start: 0,
    };
    for (const [instant, streak] of [
      [NOW, streakAtNow],
      [shift(NEXT_DAY_START, -1), streakAtDayEnd],
    ] as const) {
      const values = await readAt(t.readOnly, instant);
      for (const app of apps) {
        expect(valuesOf(values, app), `${app} at ${instant}`).toEqual({
          ...today[app],
          w6Streak: streak[app],
        });
      }
    }

    // The next day's 00:00: the day is empty, and 00:00 the day before is exactly now − 24h; both
    // lone W6 end outside the window (D10-1203), a lone W5 is 0.
    const nextDay = await readAt(t.readOnly, NEXT_DAY_START);
    const streakNextDay = {
      fail_day_w6_before: 0,
      fail_day_w6_start: 0,
      fail_day_w5_before: 0,
      fail_day_w5_start: 0,
    };
    for (const app of apps) {
      expect(valuesOf(nextDay, app), `${app} on the next day`).toEqual({
        w6Today: 0,
        w5w6Today: 0,
        w6Streak: streakNextDay[app],
      });
    }

    // The previous day's last millisecond: only the two rows of that day count for it.
    const previous = await readAt(t.readOnly, justBefore);
    const day = (app: string) => {
      const v = valuesOf(previous, app);
      return { w6Today: v.w6Today, w5w6Today: v.w5w6Today };
    };
    expect(day('fail_day_w6_before'), 'W6 at 23:59:59.999').toEqual({ w6Today: 1, w5w6Today: 1 });
    expect(day('fail_day_w5_before'), 'W5 at 23:59:59.999').toEqual({ w6Today: 0, w5w6Today: 1 });
    expect(day('fail_day_w6_start'), 'W6 of the next day').toEqual({ w6Today: 0, w5w6Today: 0 });
    expect(day('fail_day_w5_start'), 'W5 of the next day').toEqual({ w6Today: 0, w5w6Today: 0 });
    // updated_at equal to the clock is inside (now − 24h, now].
    expect(valuesOf(previous, 'fail_day_w6_before').w6Streak, 'W6 exactly at now').toBe(1);
  } finally {
    await t.close();
  }
}, 120_000);

/** One W5 / W6 of #15: minutes from NOW of updated_at, of paid_at and the attempt, of created_at. */
type Timed = readonly [outcome: 'W5' | 'W6', updated: number, other: number, created: number];

/** Rows whose updated_at, paid_at / attempt at and created_at are set apart. */
function timed(appId: string, list: readonly Timed[]): OutcomeRow[] {
  return list.map(([outcome, updated, other, created]) => ({
    appId,
    outcome,
    at: minutesFromNow(updated),
    attemptAt: minutesFromNow(other),
    paidAt: minutesFromNow(other),
    createdAt: minutesFromNow(created),
  }));
}

it('[AC-B2-09zj#15] 迁移时间一律取 withdrawals.updated_at（D10-1186）：W6 的失败尝试 at、W5 的 paid_at 与转账尝试 at 落在别的日子都不影响——updated_at 恰为 00:00 +08:00 的计入当日（尝试 at / paid_at 在前 1 毫秒），updated_at 在 00:00 前 1 毫秒的不计（尝试 at / paid_at 恰为 00:00 或其后）；查询失败与转账未知都在昨天、updated_at 在今天的 W6 算今天；连续按 updated_at 排序，不按建单时间、paid_at 或尝试 at', async () => {
  const t = await open();
  try {
    const justBefore = shift(TODAY_START, -1);
    await seed(t.handles, [
      // The query failed at 22:00 yesterday (the transfer unknown at 21:00), updated_at 09:00 today.
      {
        appId: 'fail_src_w6_query_today',
        outcome: 'W6',
        via: 'query',
        at: shift(TODAY_START, 9 * HOUR_MS),
        attemptAt: YESTERDAY_EVENING,
        createdAt: shift(TODAY_START, -20 * HOUR_MS),
      },
      // updated_at exactly 00:00, the failure 1 ms before.
      {
        appId: 'fail_src_w6_updated_start',
        outcome: 'W6',
        at: TODAY_START,
        attemptAt: justBefore,
        createdAt: shift(TODAY_START, -HOUR_MS),
      },
      // updated_at 1 ms before 00:00, the failure exactly at 00:00.
      {
        appId: 'fail_src_w6_updated_before',
        outcome: 'W6',
        at: justBefore,
        attemptAt: TODAY_START,
        createdAt: shift(TODAY_START, -HOUR_MS),
      },
      // updated_at exactly 00:00, paid_at 1 ms before, the transfer 2 s before.
      {
        appId: 'fail_src_w5_updated_start',
        outcome: 'W5',
        at: TODAY_START,
        paidAt: justBefore,
        attemptAt: shift(TODAY_START, -2_000),
        createdAt: shift(TODAY_START, -HOUR_MS),
      },
      // updated_at 1 ms before 00:00, paid_at exactly 00:00, the transfer 2 s after.
      {
        appId: 'fail_src_w5_updated_before',
        outcome: 'W5',
        at: justBefore,
        paidAt: TODAY_START,
        attemptAt: shift(TODAY_START, 2_000),
        createdAt: shift(TODAY_START, -HOUR_MS),
      },
      // By updated_at W6, W5, W6, W5, W6 (run 1); by attempt / paid_at or by created_at the three
      // W6 come first in a row (run 3).
      ...timed('fail_src_order_split', [
        ['W6', -300, -400, -600],
        ['W5', -240, -30, -500],
        ['W6', -180, -395, -590],
        ['W5', -120, -20, -490],
        ['W6', -60, -390, -580],
      ]),
      // By updated_at W5, W6, W6, W6, W5 (run 3); by attempt / paid_at or by created_at the W6
      // alternate with the W5 (run 1).
      ...timed('fail_src_order_together', [
        ['W5', -300, -280, -800],
        ['W6', -240, -350, -900],
        ['W6', -180, -250, -700],
        ['W6', -120, -150, -500],
        ['W5', -60, -200, -600],
      ]),
    ]);

    const values = await readAt(t.readOnly, NOW);
    const day = (app: string) => {
      const v = valuesOf(values, app);
      return { w6Today: v.w6Today, w5w6Today: v.w5w6Today };
    };
    expect(day('fail_src_w6_query_today'), 'query failed yesterday, updated today').toEqual({
      w6Today: 1,
      w5w6Today: 1,
    });
    expect(day('fail_src_w6_updated_start'), 'W6 updated at 00:00').toEqual({
      w6Today: 1,
      w5w6Today: 1,
    });
    expect(day('fail_src_w6_updated_before'), 'W6 updated at 23:59:59.999').toEqual({
      w6Today: 0,
      w5w6Today: 0,
    });
    expect(valuesOf(values, 'fail_src_w6_updated_before').w6Streak, 'still in 24 hours').toBe(1);
    expect(day('fail_src_w5_updated_start'), 'W5 updated at 00:00').toEqual({
      w6Today: 0,
      w5w6Today: 1,
    });
    expect(day('fail_src_w5_updated_before'), 'W5 updated at 23:59:59.999').toEqual({
      w6Today: 0,
      w5w6Today: 0,
    });
    expect(valuesOf(values, 'fail_src_order_split'), 'W6, W5, W6, W5, W6 by updated_at').toEqual({
      w6Today: 3,
      w5w6Today: 5,
      w6Streak: 1,
    });
    expect(valuesOf(values, 'fail_src_order_together'), 'W5, W6, W6, W6, W5 by updated_at').toEqual(
      {
        w6Today: 3,
        w5w6Today: 5,
        w6Streak: 3,
      },
    );
  } finally {
    await t.close();
  }
}, 120_000);

it('[AC-B2-09zj#16] 连续 W6 = 按 (updated_at, id) 排序、遇 W5 断开成段，段尾 W6 落在 (now − 24h, now] 的段中最长一段的整段长度（D10-1203）：W5 之后 3 次 W6 为 3；W6、W6、W6、W5 仍为 3；W6×3 后立刻（恰在 now）来 W5 → 3；W6、W6、W5、W6、W6 为 2（W5 打断，两段不相加）；W6、W5、W6×3、W5、W6×2 取中间那段 3；跨过 00:00 +08:00 照样连成一段（不按当日切）；夹着 W8 / W10 判成功 / W11 / W10 判失败 / W9 不断也不长；没有 W5 的 5 次 W6 为 5；各 app 各算各的（交错的 2 次与 1 次不合成 3）；跨天慢速三连：t−50h、t−26h、t−2h 各一笔 W6、其间没有 W5 → 3（段往窗口前延伸、整段计数），更早的 W5 截止、其前的 W6 不计，夹着 W11 / W9 / W10 判失败 / W8 照样为 3；三连之后在 t−1h 或下次采集前的 t−1min 来一笔 W5 → 仍为 3（段尾 t−2h 在窗口内）', async () => {
  const t = await open();
  try {
    const w6At = (appId: string, minutes: readonly number[]): OutcomeRow[] =>
      minutes.map((m) => ({ appId, outcome: 'W6' as const, at: minutesFromNow(m) }));
    await seed(t.handles, [
      { appId: 'fail_run_3', outcome: 'W5', at: minutesFromNow(-300) },
      ...w6At('fail_run_3', [-180, -120, -60]),
      ...w6At('fail_run_3_then_w5', [-240, -180, -120]),
      { appId: 'fail_run_3_then_w5', outcome: 'W5', at: minutesFromNow(-60) },
      // Three W6 a minute apart, the W5 right after them, exactly at the clock.
      ...w6At('fail_run_3_then_w5_at_once', [-3, -2, -1]),
      { appId: 'fail_run_3_then_w5_at_once', outcome: 'W5', at: NOW },
      ...w6At('fail_run_broken', [-300, -240]),
      { appId: 'fail_run_broken', outcome: 'W5', at: minutesFromNow(-180) },
      ...w6At('fail_run_broken', [-120, -60]),
      ...w6At('fail_run_middle', [-480]),
      { appId: 'fail_run_middle', outcome: 'W5', at: minutesFromNow(-420) },
      ...w6At('fail_run_middle', [-360, -300, -240]),
      { appId: 'fail_run_middle', outcome: 'W5', at: minutesFromNow(-180) },
      ...w6At('fail_run_middle', [-120, -60]),
      // W5 19:00, W6 21:00 and 22:00 yesterday, W6 01:00 today (+08:00): all after 14:07:08
      // yesterday, so within the 24 hours.
      { appId: 'fail_run_cross_day', outcome: 'W5', at: shift(YESTERDAY_EVENING, -3 * HOUR_MS) },
      { appId: 'fail_run_cross_day', outcome: 'W6', at: shift(YESTERDAY_EVENING, -HOUR_MS) },
      { appId: 'fail_run_cross_day', outcome: 'W6', at: YESTERDAY_EVENING },
      { appId: 'fail_run_cross_day', outcome: 'W6', at: shift(TODAY_START, HOUR_MS) },
      { appId: 'fail_run_between', outcome: 'W5', at: minutesFromNow(-330) },
      { appId: 'fail_run_between', outcome: 'W6', at: minutesFromNow(-300) },
      { appId: 'fail_run_between', outcome: 'W8', at: minutesFromNow(-270) },
      { appId: 'fail_run_between', outcome: 'W6', at: minutesFromNow(-240) },
      { appId: 'fail_run_between', outcome: 'W10_PAID', at: minutesFromNow(-210) },
      { appId: 'fail_run_between', outcome: 'W6', at: minutesFromNow(-180) },
      { appId: 'fail_run_between', outcome: 'W11', at: minutesFromNow(-150) },
      { appId: 'fail_run_between', outcome: 'W6', at: minutesFromNow(-120) },
      { appId: 'fail_run_between', outcome: 'W10_FAILED', at: minutesFromNow(-90) },
      { appId: 'fail_run_between', outcome: 'W9', at: minutesFromNow(-60) },
      ...series('fail_run_only_w6', 'W6', minutesFromNow(-300), 5),
      { appId: 'fail_run_app_a', outcome: 'W6', at: minutesFromNow(-180) },
      { appId: 'fail_run_app_b', outcome: 'W6', at: minutesFromNow(-120) },
      { appId: 'fail_run_app_a', outcome: 'W6', at: minutesFromNow(-60) },
      // Slow failures over days (D10-1203): W6 80 hours ago (a run of 1 ending outside the window),
      // a W5 60 hours ago that ends it, then W6 at t − 50h, t − 26h, t − 2h with no W5 between: one
      // run of 3 whose last W6 is within the 24 hours, counted whole.
      ...slow('fail_run_slow', [
        ['W6', -80],
        ['W5', -60],
        ['W6', -50],
        ['W6', -26],
        ['W6', -2],
      ]),
      // The same three W6 with outcomes between them that neither count nor break.
      ...slow('fail_run_slow_between', [
        ['W5', -60],
        ['W6', -50],
        ['W11', -40],
        ['W8', -30],
        ['W6', -26],
        ['W9', -10],
        ['W10_FAILED', -5],
        ['W6', -2],
      ]),
      // The same, then a W5 an hour ago: the run ended at t − 2h, inside the window, so it stays 3.
      ...slow('fail_run_slow_then_w5', [
        ['W5', -60],
        ['W6', -50],
        ['W6', -26],
        ['W6', -2],
        ['W5', -1],
      ]),
      // money r3 S1: the same three, then a W5 one minute before the clock (before the next
      // scrape): still 3, the run's last W6 at t − 2h is inside the window.
      ...slow('fail_run_slow_then_w5_soon', [
        ['W5', -60],
        ['W6', -50],
        ['W6', -26],
        ['W6', -2],
      ]),
      { appId: 'fail_run_slow_then_w5_soon', outcome: 'W5', at: minutesFromNow(-1) },
    ]);

    const values = await readAt(t.readOnly, NOW);
    const run = (app: string) => valuesOf(values, app).w6Streak;
    expect(run('fail_run_3'), 'W5 then 3 W6').toBe(3);
    expect(run('fail_run_3_then_w5'), '3 W6 then W5').toBe(3);
    expect(run('fail_run_3_then_w5_at_once'), '3 W6 then W5 at once, at now').toBe(3);
    expect(run('fail_run_broken'), 'W6, W6, W5, W6, W6').toBe(2);
    expect(run('fail_run_middle'), 'W6, W5, 3 W6, W5, 2 W6').toBe(3);
    expect(run('fail_run_cross_day'), 'over midnight').toBe(3);
    expect(valuesOf(values, 'fail_run_cross_day'), 'only one of them today').toEqual({
      w6Today: 1,
      w5w6Today: 1,
      w6Streak: 3,
    });
    expect(run('fail_run_between'), 'W8 / W10 / W11 / W9 in between').toBe(4);
    expect(valuesOf(values, 'fail_run_between'), 'only the W5 and the four W6 count').toEqual({
      w6Today: 4,
      w5w6Today: 5,
      w6Streak: 4,
    });
    expect(run('fail_run_only_w6'), 'never a W5').toBe(5);
    expect(run('fail_run_app_a'), 'app a').toBe(2);
    expect(run('fail_run_app_b'), 'app b').toBe(1);
    // NOW − 2h is 12:07:08 +08:00: today; the others are days back.
    expect(valuesOf(values, 'fail_run_slow'), 'slow W6, no W5 between: the whole run 3').toEqual({
      w6Today: 1,
      w5w6Today: 1,
      w6Streak: 3,
    });
    expect(run('fail_run_slow_between'), 'slow W6 with W11 / W8 / W9 / W10 between').toBe(3);
    expect(valuesOf(values, 'fail_run_slow_then_w5'), 'then a W5 at t − 1h: still 3').toEqual({
      w6Today: 1,
      w5w6Today: 2,
      w6Streak: 3,
    });
    expect(
      valuesOf(values, 'fail_run_slow_then_w5_soon'),
      'then a W5 at t − 1min, before the next scrape: still 3',
    ).toEqual({
      w6Today: 1,
      w5w6Today: 2,
      w6Streak: 3,
    });
  } finally {
    await t.close();
  }
}, 120_000);

const COUNTED_OR_NOT: readonly Outcome[] = [
  'W5',
  'W6',
  'W8',
  'W10_PAID',
  'W10_FAILED',
  'W9',
  'W11',
];

/** Minutes before NOW on and around the 24-hour edge, and NOW itself. */
const EDGE_MINUTES = [0, 24 * 60 - 1, 24 * 60, 24 * 60 + 1] as const;

/**
 * How far back the property's rows go: well beyond the 24 hours, so runs reaching back before the
 * window (counted whole) and runs ending outside it (not counted) both show.
 */
const PROP_SPAN_MINUTES = 72 * 60;

it('[AC-B2-09zj#17] 任意序列（fast-check）：W5 / W6 / W8 / W10 / W9 / W11 在近 72 小时内（含恰为当前时刻与 24 小时边界上下，W6 偏多以出现跨天连败）的任意次序与时刻、任意建单时间、任意偏离 updated_at 的 paid_at / 尝试 at、任意写入次序下，在当前时刻与其后 0～12 小时内的任一时刻读，三个值都等于按 BR-WDR-24 与 D10-1186、D10-1203 手算的结果（updated_at 取时；当日按 +08:00；连续：W5 / W6 按时间排序、遇 W5 断开成段，段尾 W6 落在 (now − 24h, now] 的段中最长一段的整段长度，没有则 0）', async () => {
  const t = await open();
  try {
    let run = 0;
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(
          fc.record({
            outcome: fc.oneof(
              { arbitrary: fc.constant<Outcome>('W6'), weight: 2 },
              { arbitrary: fc.constantFrom(...COUNTED_OR_NOT), weight: 3 },
            ),
            via: fc.constantFrom('transfer' as const, 'query' as const),
            minutesBefore: fc.oneof(
              fc.integer({ min: 0, max: PROP_SPAN_MINUTES }),
              fc.constantFrom(...EDGE_MINUTES),
            ),
            createdBefore: fc.integer({ min: 1, max: 3 * 24 * 60 }),
            otherShift: fc.integer({ min: -26 * 60, max: 26 * 60 }),
            insertRank: fc.integer(),
          }),
          { selector: (item) => item.minutesBefore, minLength: 1, maxLength: 10 },
        ),
        fc.integer({ min: 0, max: 12 * 60 }),
        async (items, laterMinutes) => {
          run += 1;
          const appId = `fail_prop_${run}`;
          const rows: OutcomeRow[] = items.map((item) => {
            const at = minutesFromNow(-item.minutesBefore);
            // paid_at and the attempt's at drift from updated_at, up to a day and more each way.
            const other = shift(at, item.otherShift * MINUTE_MS);
            return {
              appId,
              outcome: item.outcome,
              at,
              via: item.via,
              attemptAt: other,
              paidAt: other,
              createdAt: shift(at, -item.createdBefore * MINUTE_MS),
            };
          });
          const order = items
            .map((item, i) => ({ rank: item.insertRank, i }))
            .sort((x, y) => x.rank - y.rank || x.i - y.i);
          for (const { i } of order) await insertOutcome(t.handles, rows[i]!);

          const label = `${appId}: ${items
            .map((item) => `${item.outcome}@-${item.minutesBefore}m(${item.otherShift}m)`)
            .join(', ')}`;
          for (const instant of [NOW, minutesFromNow(laterMinutes)]) {
            const values = await readAt(t.readOnly, instant);
            expect(valuesOf(values, appId), `${label} read at ${instant}`).toEqual(
              expectedOf(rows, instant),
            );
          }
          return true;
        },
      ),
      { ...propParams() },
    );
  } finally {
    await t.close();
  }
}, 3_600_000);

it('[AC-B2-09zj#18] 只读、只用注入时钟、不缓存：只读事务可跑、两张表的行前后不变；当日只看注入时钟（库的 now() 早好几年）；再落一笔 W6 下一次读就跟上；worker registry 以该端口渲染出同样的值', async () => {
  const t = await open();
  try {
    await seed(t.handles, [
      { appId: 'fail_clock', outcome: 'W5', at: minutesFromNow(-120) },
      { appId: 'fail_clock', outcome: 'W6', at: minutesFromNow(-60) },
    ]);
    // The session really is read-only: the port cannot write behind the test's back.
    await expect(
      insertOutcome(
        { db: t.readOnly, payout: t.readOnly },
        {
          appId: 'fail_clock',
          outcome: 'PENDING_REVIEW',
          at: NOW,
        },
      ),
      'fixture session must be read-only',
    ).rejects.toThrow(/read-only/);
    const before = await tableSnapshot(t.db);

    const clock = clockAt(NOW);
    const first = await readPayoutWithdrawalFail(t.readOnly, clock);
    expect(valuesOf(first, 'fail_clock')).toEqual({ w6Today: 1, w5w6Today: 2, w6Streak: 1 });
    expect(await tableSnapshot(t.db), 'rows unchanged by the read').toEqual(before);

    // Another W6 lands: the next read follows at once.
    await insertOutcome(t.handles, { appId: 'fail_clock', outcome: 'W6', at: minutesFromNow(-30) });
    const second = await readAt(t.readOnly, NOW);
    expect(valuesOf(second, 'fail_clock')).toEqual({ w6Today: 2, w5w6Today: 3, w6Streak: 2 });

    const registry = createMetricsRegistry({
      entry: 'worker',
      collectWithdrawalFail: () => readPayoutWithdrawalFail(t.readOnly, clock),
    });
    const rendered = failFromText(await registry.render());
    expect(valuesOf(rendered, 'fail_clock'), 'rendered by the worker registry').toEqual({
      w6Today: 2,
      w5w6Today: 3,
      w6Streak: 2,
    });
  } finally {
    await t.close();
  }
}, 120_000);

// ---- W11 (编排裁定 D10-1170) ---------------------------------------------------------------------
// W11 never counts: neither in the day's W6 nor in W5 + W6, and in the run it neither counts nor
// breaks. A W11 withdrawal looks like a W5 by status and manual_resolution alone (PAID_API, empty);
// what tells it apart is its transfer attempt with result fail (W4 allows no earlier transfer and
// BR-WDR-14 forbids a resubmission, so a withdrawal has at most one transfer attempt).

/**
 * One W11 withdrawal (alipay) satisfying every CHECK: its transfer attempt failed at `failedAt`,
 * W9 sent it back to APPROVED (the hold is cleared again by W11), a query proved the channel paid
 * and W11 wrote it off as PAID_API at `paidAt` (paid_at, updated_at and the query success attempt's
 * at), manual_resolution empty, needs_manual false. Returns its id.
 */
async function insertW11(
  h: FailHandles,
  appId: string,
  failedAt: string,
  paidAt: string,
): Promise<string> {
  const id = randomUUID();
  const user = await insertUser(h.db, appId);
  const outBizNo = id.replaceAll('-', '');
  await sql`INSERT INTO app.withdrawals
      (id, app_id, user_id, amount_fen, fee_fen, tax_fen, net_fen, income_type, payout_method,
       payee_name, payee_account_cipher, payee_hmac, status, out_biz_no, payout_channel, paid_at,
       proof_file, needs_manual, manual_resolution, hold_reason, hold_at, created_at, updated_at)
    VALUES (${id}, ${appId}, ${user}, ${100_000n}, ${0n}, ${0n}, ${100_000n}, 'SERVICE_FEE',
      'alipay', 'synthetic', ${Buffer.from('synthetic-cipher')}, ${'a'.repeat(64)}, 'PAID_API',
      ${outBizNo}, 'alipay', ${paidAt}::timestamptz, 'synthetic-proof', false, NULL, NULL, NULL,
      ${shift(failedAt, -2 * HOUR_MS)}::timestamptz, ${paidAt}::timestamptz)`.execute(h.db);
  const attempts = [
    { kind: 'transfer', result: 'fail', at: failedAt },
    { kind: 'query', result: 'success', at: paidAt },
  ] as const;
  for (const attempt of attempts) {
    await sql`INSERT INTO app.payout_attempts
        (id, app_id, withdrawal_id, kind, request, result, at)
      VALUES (${randomUUID()}, ${appId}, ${id}, ${attempt.kind},
        ${JSON.stringify({ out_biz_no: outBizNo })}::jsonb, ${attempt.result},
        ${attempt.at}::timestamptz)`.execute(h.payout);
  }
  return id;
}

it('[AC-B2-09zj#26] W11 不进分母也不进分子（D10-1170）：同一 app 当日 W5 / W6 若干外加一笔当日核销的 W11（PAID_API、manual_resolution 为空、有一条 transfer / fail 尝试，失败与 paid_at 都在当日），三个值与没有这笔 W11 的同样序列相同', async () => {
  const t = await open();
  try {
    const baseline = (appId: string): OutcomeRow[] => [
      { appId, outcome: 'W5', at: minutesFromNow(-300) },
      { appId, outcome: 'W6', at: minutesFromNow(-240) },
      { appId, outcome: 'W5', at: minutesFromNow(-200) },
      { appId, outcome: 'W6', at: minutesFromNow(-150) },
    ];
    await seed(t.handles, [...baseline('fail_w11_day'), ...baseline('fail_w11_day_without')]);
    // Transfer failed at 11:47, written off at 12:37 (+08:00): both today, both after the last W6.
    await insertW11(t.handles, 'fail_w11_day', minutesFromNow(-140), minutesFromNow(-90));

    const values = await readAt(t.readOnly, NOW);
    const without = valuesOf(values, 'fail_w11_day_without');
    expect(without, 'the same sequence without the W11').toEqual({
      w6Today: 2,
      w5w6Today: 4,
      w6Streak: 1,
    });
    const withW11 = valuesOf(values, 'fail_w11_day');
    expect(withW11.w5w6Today, 'W11 is no W5: not in W5 + W6 today').toBe(without.w5w6Today);
    expect(withW11.w6Today, 'W11 is no W6: not in W6 today').toBe(without.w6Today);
    expect(withW11, 'all three as without the W11').toEqual(without);
  } finally {
    await t.close();
  }
}, 120_000);

it('[AC-B2-09zj#27] W11 不打断连续（D10-1170、D10-1186）：按迁移时间 W6、W6、W11、W6 的最长连续为 3；对照：同一位置换成 W5 时最长连续为 2', async () => {
  const t = await open();
  try {
    const w6At = [-240, -180, -60].map((m) => minutesFromNow(m));
    await seed(t.handles, [
      ...w6At.map((at) => ({ appId: 'fail_w11_run', outcome: 'W6' as const, at })),
      ...w6At.map((at) => ({ appId: 'fail_w11_run_w5', outcome: 'W6' as const, at })),
      // The control: a W5 where the other app has its W11.
      { appId: 'fail_w11_run_w5', outcome: 'W5', at: minutesFromNow(-120) },
    ]);
    // Between the second and the third W6: transfer failed at -150, written off at -120.
    await insertW11(t.handles, 'fail_w11_run', minutesFromNow(-150), minutesFromNow(-120));

    const values = await readAt(t.readOnly, NOW);
    expect(valuesOf(values, 'fail_w11_run').w6Streak, 'W6, W6, W11, W6').toBe(3);
    expect(valuesOf(values, 'fail_w11_run'), 'W11 counted nowhere').toEqual({
      w6Today: 3,
      w5w6Today: 3,
      w6Streak: 3,
    });
    expect(valuesOf(values, 'fail_w11_run_w5').w6Streak, 'W6, W6, W5, W6').toBe(2);
    expect(valuesOf(values, 'fail_w11_run_w5'), 'the W5 counts').toEqual({
      w6Today: 3,
      w5w6Today: 4,
      w6Streak: 2,
    });
  } finally {
    await t.close();
  }
}, 120_000);

// ---- W5 through a query (D10-1170's discriminator) --------------------------------------------
// W5 asks only for the absence of a transfer attempt with result fail, not for a transfer attempt
// with result success: a transfer answered unknown and a later query answered success also reach
// PAID_API with manual_resolution empty, the transition (updated_at) at the query success's instant.

/**
 * One W5 reached through a query (alipay) satisfying every CHECK: its transfer attempt was unknown
 * at `unknownAt`, a query answered success at `paidAt`, the withdrawal went PAYING → PAID_API with
 * paid_at = updated_at = `paidAt`, manual_resolution empty, needs_manual false; no attempt has
 * result fail. Returns its id.
 */
async function insertQueryW5(
  h: FailHandles,
  appId: string,
  unknownAt: string,
  paidAt: string,
): Promise<string> {
  const id = randomUUID();
  const user = await insertUser(h.db, appId);
  const outBizNo = id.replaceAll('-', '');
  await sql`INSERT INTO app.withdrawals
      (id, app_id, user_id, amount_fen, fee_fen, tax_fen, net_fen, income_type, payout_method,
       payee_name, payee_account_cipher, payee_hmac, status, out_biz_no, payout_channel, paid_at,
       needs_manual, manual_resolution, hold_reason, hold_at, created_at, updated_at)
    VALUES (${id}, ${appId}, ${user}, ${100_000n}, ${0n}, ${0n}, ${100_000n}, 'SERVICE_FEE',
      'alipay', 'synthetic', ${Buffer.from('synthetic-cipher')}, ${'a'.repeat(64)}, 'PAID_API',
      ${outBizNo}, 'alipay', ${paidAt}::timestamptz, false, NULL, NULL, NULL,
      ${shift(unknownAt, -2 * HOUR_MS)}::timestamptz, ${paidAt}::timestamptz)`.execute(h.db);
  const attempts = [
    { kind: 'transfer', result: 'unknown', at: unknownAt },
    { kind: 'query', result: 'success', at: paidAt },
  ] as const;
  for (const attempt of attempts) {
    await sql`INSERT INTO app.payout_attempts
        (id, app_id, withdrawal_id, kind, request, result, at)
      VALUES (${randomUUID()}, ${appId}, ${id}, ${attempt.kind},
        ${JSON.stringify({ out_biz_no: outBizNo })}::jsonb, ${attempt.result},
        ${attempt.at}::timestamptz)`.execute(h.payout);
  }
  return id;
}

it('[AC-B2-09zj#28] 查询成功形成的 W5 照样是 W5（D10-1170：只要求没有 transfer / fail 尝试，不要求有 transfer / success）：transfer 返回 unknown、之后 query 返回 success 进 PAID_API（manual_resolution 为空、没有 result = fail 的尝试、updated_at 与 paid_at 取查询成功时刻）的单夹在 W6、W6 与 W6、W6 之间，updated_at 在当日时计入当日 W5+W6、把连续 W6 打断为 2；对照：updated_at 落在前一天（+08:00）时不计入当日分母，但仍在 24 小时内打断连续', async () => {
  const t = await open();
  try {
    // Today: W6 at 09:07, 10:07 (+08:00); the transfer unknown at 08:07, before them all, the query
    // success at 10:47; then W6 at 11:37, 12:27.
    const todayApp = 'fail_query_w5_today';
    const w6Today: OutcomeRow[] = [-300, -240, -150, -100].map((m) => ({
      appId: todayApp,
      outcome: 'W6' as const,
      at: minutesFromNow(m),
    }));
    await seed(t.handles, w6Today);
    await insertQueryW5(t.handles, todayApp, minutesFromNow(-360), minutesFromNow(-200));

    // The control: W6 at 19:00 and 20:00 yesterday; the transfer unknown at 22:00 yesterday, the
    // query success at 23:59:59.999 yesterday; then W6 at 01:00 and 02:00 today. All of them lie
    // within the 24 hours before NOW (14:07:08 +08:00).
    const yesterdayApp = 'fail_query_w5_yesterday';
    const w6AroundIt: OutcomeRow[] = [
      shift(YESTERDAY_EVENING, -3 * HOUR_MS),
      shift(YESTERDAY_EVENING, -2 * HOUR_MS),
      shift(TODAY_START, HOUR_MS),
      shift(TODAY_START, 2 * HOUR_MS),
    ].map((at) => ({ appId: yesterdayApp, outcome: 'W6' as const, at }));
    await seed(t.handles, w6AroundIt);
    await insertQueryW5(t.handles, yesterdayApp, YESTERDAY_EVENING, shift(TODAY_START, -1));

    const values = await readAt(t.readOnly, NOW);
    const today = valuesOf(values, todayApp);
    expect(today.w5w6Today, 'the query W5 is in W5 + W6 today').toBe(5);
    expect(today.w6Streak, 'the query W5 breaks the run').toBe(2);
    expect(today, 'W6 4, W5 + W6 5, run 2').toEqual({ w6Today: 4, w5w6Today: 5, w6Streak: 2 });

    const yesterday = valuesOf(values, yesterdayApp);
    expect(yesterday.w5w6Today, 'updated yesterday: not in W5 + W6 today').toBe(2);
    expect(yesterday.w6Streak, 'updated yesterday: still breaks the run').toBe(2);
    expect(yesterday, 'W6 2, W5 + W6 2, run 2').toEqual({ w6Today: 2, w5w6Today: 2, w6Streak: 2 });
  } finally {
    await t.close();
  }
}, 120_000);

// ---- the 24-hour window of the streak (编排裁定 D10-1186 ①, D10-1203) -------------------------------

it('[AC-B2-09zj#29] 连续的 24 小时边界只看段尾（D10-1203：段尾 W6 的 updated_at ∈ (now − 24h, now] 的段整段计数）：段尾恰为 now − 24h 的段不计、now − 24h + 1 毫秒的计（单笔或 3 笔、之后有没有 W5 都一样），时钟后移 1 毫秒随之不计；一段跨过窗口下界、段尾在窗口内时整段计数（W6×5 跨边界、之后有没有 W5 都为 5，时钟后移 1 毫秒仍为 5）；段尾在窗口外的段不计、之后没有 W5 也一样（30 小时前的 4 连败单独为 0，之后窗口内来 W5、W6 → 1）；24 小时外 2 笔 W6 + 24 小时内 1 笔 W6、其间没有 W5 → 3，其间有 W5（窗口内或窗口外）→ 1；跨下界的长段与窗口内的短段取长段；恰为 now 的 W6 计入', async () => {
  const t = await open();
  try {
    const edge = shift(NOW, -DAY_MS);
    const at = (appId: string, list: readonly (readonly ['W5' | 'W6', number])[]): OutcomeRow[] =>
      list.map(([outcome, ms]) => ({ appId, outcome, at: shift(NOW, ms) }));
    const acrossEdge = [-26 * HOUR_MS, -25 * HOUR_MS, -DAY_MS, -DAY_MS + 1, -23 * HOUR_MS];
    const runToEdge = [-26 * HOUR_MS, -25 * HOUR_MS, -DAY_MS];
    const runToEdgeIn = [-26 * HOUR_MS, -25 * HOUR_MS, -DAY_MS + 1];
    await seed(t.handles, [
      // A lone W6 whose run ends exactly on the edge, 1 ms after it, or exactly at the clock.
      { appId: 'fail_window_edge_out', outcome: 'W6', at: edge },
      { appId: 'fail_window_edge_in', outcome: 'W6', at: shift(edge, 1) },
      { appId: 'fail_window_now', outcome: 'W6', at: NOW },
      // A run of 3 ending exactly on the edge: out, with a W5 after it or without.
      ...at('fail_window_run_edge_out', [
        ...runToEdge.map((ms) => ['W6', ms] as const),
        ['W5', -HOUR_MS],
      ]),
      ...at(
        'fail_window_run_edge_out_open',
        runToEdge.map((ms) => ['W6', ms] as const),
      ),
      // A run of 3 ending 1 ms after the edge: in, counted whole (two of its W6 lie before it).
      ...at('fail_window_run_edge_in', [
        ...runToEdgeIn.map((ms) => ['W6', ms] as const),
        ['W5', -HOUR_MS],
      ]),
      ...at(
        'fail_window_run_edge_in_open',
        runToEdgeIn.map((ms) => ['W6', ms] as const),
      ),
      // Five W6 across the edge, the last at t − 23h, then a W5: the whole run of 5.
      ...at('fail_window_split_w5', [
        ...acrossEdge.map((ms) => ['W6', ms] as const),
        ['W5', -HOUR_MS],
      ]),
      // The same five W6 with no W5 at all: 5 as well.
      ...at(
        'fail_window_split',
        acrossEdge.map((ms) => ['W6', ms] as const),
      ),
      // Four W6 in a row 30 hours ago, then W5, W6 within the window: the old run ends outside.
      ...series('fail_window_old_run', 'W6', shift(NOW, -30 * HOUR_MS), 4),
      { appId: 'fail_window_old_run', outcome: 'W5', at: minutesFromNow(-120) },
      { appId: 'fail_window_old_run', outcome: 'W6', at: minutesFromNow(-60) },
      // The same four W6 30 hours ago and nothing after them: their run ends outside, 0.
      ...series('fail_window_stale', 'W6', shift(NOW, -30 * HOUR_MS), 4),
      // A run of 3 reaching back before the window (last W6 at t − 20h), a W5, a run of 2: 3.
      ...at('fail_window_reach_back', [
        ['W6', -30 * HOUR_MS],
        ['W6', -28 * HOUR_MS],
        ['W6', -20 * HOUR_MS],
        ['W5', -10 * HOUR_MS],
        ['W6', -5 * HOUR_MS],
        ['W6', -4 * HOUR_MS],
      ]),
      // Two W6 outside the window, one inside, no W5: one run of 3 ending inside.
      ...at('fail_window_tail', [
        ['W6', -30 * HOUR_MS],
        ['W6', -26 * HOUR_MS],
        ['W6', -2 * HOUR_MS],
      ]),
      // The same with a W5 before the one inside (outside the window, or inside it): the two old W6
      // form a run ending outside, the one inside a run of 1.
      ...at('fail_window_tail_cut_out', [
        ['W6', -30 * HOUR_MS],
        ['W6', -26 * HOUR_MS],
        ['W5', -25 * HOUR_MS],
        ['W6', -2 * HOUR_MS],
      ]),
      ...at('fail_window_tail_cut_in', [
        ['W6', -30 * HOUR_MS],
        ['W6', -26 * HOUR_MS],
        ['W5', -3 * HOUR_MS],
        ['W6', -2 * HOUR_MS],
      ]),
    ]);

    const run = (values: Port, app: string) => valuesOf(values, app).w6Streak;
    const atNow = await readAt(t.readOnly, NOW);
    expect(run(atNow, 'fail_window_edge_out'), 'lone W6 exactly now − 24h: out').toBe(0);
    expect(run(atNow, 'fail_window_edge_in'), 'lone W6 now − 24h + 1 ms: in').toBe(1);
    expect(run(atNow, 'fail_window_now'), 'exactly now').toBe(1);
    expect(run(atNow, 'fail_window_run_edge_out'), 'run of 3 ending on the edge, then W5').toBe(0);
    expect(run(atNow, 'fail_window_run_edge_out_open'), 'run of 3 ending on the edge').toBe(0);
    expect(run(atNow, 'fail_window_run_edge_in'), 'run of 3 ending 1 ms inside, then W5').toBe(3);
    expect(run(atNow, 'fail_window_run_edge_in_open'), 'run of 3 ending 1 ms inside').toBe(3);
    expect(run(atNow, 'fail_window_split_w5'), 'run of 5 across the edge, then W5').toBe(5);
    expect(run(atNow, 'fail_window_split'), 'run of 5 across the edge').toBe(5);
    expect(run(atNow, 'fail_window_old_run'), 'the old run of 4 ends outside').toBe(1);
    expect(run(atNow, 'fail_window_stale'), 'the old run of 4 alone, no W5 after it').toBe(0);
    expect(run(atNow, 'fail_window_reach_back'), 'the whole run reaching back, not 2').toBe(3);
    expect(valuesOf(atNow, 'fail_window_tail'), '2 W6 outside + 1 inside, no W5').toEqual({
      w6Today: 1,
      w5w6Today: 1,
      w6Streak: 3,
    });
    expect(run(atNow, 'fail_window_tail_cut_out'), 'a W5 outside the window cuts the run').toBe(1);
    expect(run(atNow, 'fail_window_tail_cut_in'), 'a W5 inside the window cuts the run').toBe(1);
    // The edge is 14:07:08 yesterday (+08:00): in the window, not in the day.
    expect(valuesOf(atNow, 'fail_window_edge_in'), 'yesterday, inside the window').toEqual({
      w6Today: 0,
      w5w6Today: 0,
      w6Streak: 1,
    });
    expect(valuesOf(atNow, 'fail_window_now'), 'exactly now, today').toEqual({
      w6Today: 1,
      w5w6Today: 1,
      w6Streak: 1,
    });

    const later = await readAt(t.readOnly, shift(NOW, 1));
    expect(run(later, 'fail_window_edge_out'), '1 ms later: still out').toBe(0);
    expect(run(later, 'fail_window_edge_in'), '1 ms later: now on the edge, out').toBe(0);
    expect(run(later, 'fail_window_run_edge_in'), '1 ms later: its last W6 on the edge').toBe(0);
    expect(run(later, 'fail_window_run_edge_in_open'), '1 ms later: out, no W5 alike').toBe(0);
    expect(run(later, 'fail_window_split_w5'), '1 ms later: last W6 still inside').toBe(5);
    expect(run(later, 'fail_window_split'), '1 ms later: still the whole run').toBe(5);
    expect(run(later, 'fail_window_now'), '1 ms later: still inside').toBe(1);
  } finally {
    await t.close();
  }
}, 120_000);
