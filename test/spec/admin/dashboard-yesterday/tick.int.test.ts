// B1-34q: one scheduler tick (task brief §9 item 7, D10-1401): D falls due at D+1 00:10:00 +08:00;
// the apps are those with an admin account (admin_users); the window is the last 7 due days, every
// missing day in it is aggregated, oldest first; a stored row is never recomputed by a tick; a gap
// before the window is left alone; one failing app does not stop the others and leaves an error
// line admin_dashboard_day_failed with the app, the day and the error class only.
// The ticks are called directly with a controllable clock; nothing waits on real time.
import { expect, it } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  D,
  D_NOON,
  FAILURE_TOKEN,
  SteppingClock,
  TIMEOUT,
  adminOf,
  aggregate,
  at,
  captureLogs,
  daysOf,
  failLinksOf,
  failureLines,
  linkLog,
  newApp,
  rowOf,
  rowsOf,
  tick,
  useDatabase,
  userOf,
} from './kit.ts';

const world = useDatabase();

/** D+1 00:09:59.999 +08:00: D is not due yet, D−1 is. */
const BEFORE_DUE = '2032-06-15T16:09:59.999Z';
/** D+1 00:10:00.000 +08:00: D falls due. */
const DUE = '2032-06-15T16:10:00.000Z';

it(
  '[AC-B1-34q#10] D 在 D+1 00:10:00 +08:00 到期：00:09:59.999 的 tick 不聚合 D（聚合 D−1），00:10:00 的 tick 聚合 D',
  async () => {
    const { db } = world;
    const app = newApp('due');
    await adminOf(db, app);
    await linkLog(db, app, D_NOON);
    const logs = captureLogs();
    const clock = new FixedClock(BEFORE_DUE);

    await tick(db, clock, logs.logger);
    const early = await daysOf(db, app);
    expect(early).toContain('2032-06-14');
    expect(early).not.toContain(D);

    clock.set(DUE);
    await tick(db, clock, logs.logger);
    expect(await rowOf(db, app, D)).toEqual({
      day: D,
      links: 1n,
      orders: 0n,
      est_rebate_fen: 0n,
      new_users: 0n,
      as_of: DUE,
    });
  },
  TIMEOUT,
);

it(
  '[AC-B1-34q#11] app 列表取有后台账号（admin_users）的 app：没有后台账号的 app 不写；有账号无数据的 app 写全 0 行',
  async () => {
    const { db } = world;
    const listed = newApp('listed');
    const bare = newApp('bare');
    const unlisted = newApp('unlisted');
    await adminOf(db, listed);
    await adminOf(db, bare);
    await linkLog(db, listed, D_NOON);
    await userOf(db, listed, D_NOON);
    await linkLog(db, unlisted, D_NOON);
    await userOf(db, unlisted, D_NOON);
    const logs = captureLogs();

    await tick(db, new FixedClock(DUE), logs.logger);

    expect(await rowOf(db, listed, D)).toMatchObject({ links: 1n, new_users: 1n, as_of: DUE });
    expect(await rowOf(db, bare, D)).toEqual({
      day: D,
      links: 0n,
      orders: 0n,
      est_rebate_fen: 0n,
      new_users: 0n,
      as_of: DUE,
    });
    expect(await rowsOf(db, unlisted)).toEqual([]);
  },
  TIMEOUT,
);

it(
  '[AC-B1-34q#12] 窗口为最近 7 个到期日：缺哪天补哪天、从最早的缺口开始；已有的行不重算；窗口外的缺口不补',
  async () => {
    const { db } = world;
    const app = newApp('gaps');
    await adminOf(db, app);
    await linkLog(db, app, at('2032-06-12', '12:00:00.000'));
    // Stored before the tick: 06-03 (outside the window) and 06-10, 06-12 inside it.
    const stored = '2032-06-15T17:00:00.000Z';
    for (const day of ['2032-06-03', '2032-06-10', '2032-06-12']) {
      await aggregate(db, app, day, stored);
    }
    // A convert of 06-12 after its row was stored: a tick must not pick it up.
    await linkLog(db, app, at('2032-06-12', '13:00:00.000'));

    // 06-16 02:00 +08:00: the newest due day is 06-15, the window 06-09 … 06-15. The clock moves
    // one second after every read, so the as_of order is the aggregation order.
    const start = '2032-06-15T18:00:00.000Z';
    const logs = captureLogs();
    await tick(db, new SteppingClock(start, 1_000), logs.logger);

    const rows = await rowsOf(db, app);
    expect(rows.map((row) => row.day)).toEqual([
      '2032-06-03',
      '2032-06-09',
      '2032-06-10',
      '2032-06-11',
      '2032-06-12',
      '2032-06-13',
      '2032-06-14',
      '2032-06-15',
    ]);
    const byDay = new Map(rows.map((row) => [row.day, row]));
    expect(byDay.get('2032-06-03')?.as_of).toBe(stored);
    expect(byDay.get('2032-06-10')?.as_of).toBe(stored);
    expect(byDay.get('2032-06-12')).toMatchObject({ links: 1n, as_of: stored });

    const gaps = ['2032-06-09', '2032-06-11', '2032-06-13', '2032-06-14', '2032-06-15'];
    const filled = gaps.map((day) => byDay.get(day)?.as_of ?? '');
    for (const asOf of filled) expect(asOf >= start, `as_of ${asOf}`).toBe(true);
    // Oldest gap first: strictly increasing as_of in day order.
    for (let i = 1; i < filled.length; i += 1) {
      expect(filled[i]! > filled[i - 1]!, `as_of ${filled.join(', ')}`).toBe(true);
    }
  },
  TIMEOUT,
);

it(
  '[AC-B1-34q#13] 一个 app 失败不挡其他 app：失败写错误日志 admin_dashboard_day_failed，只带 app_id、日期、错误类别',
  async () => {
    const { db } = world;
    const failing = newApp('failing');
    const healthy = newApp('healthy');
    await adminOf(db, failing);
    await adminOf(db, healthy);
    await linkLog(db, failing, D_NOON);
    await linkLog(db, healthy, D_NOON);
    // Every link_logs read of the failing app throws SyntheticLinkFailure.
    const broken = db.withPlugin(failLinksOf(failing));
    const logs = captureLogs();

    await tick(broken, new FixedClock(DUE), logs.logger, broken);

    expect(await rowOf(db, healthy, D)).toMatchObject({ links: 1n, as_of: DUE });
    expect(await rowsOf(db, failing)).toEqual([]);

    const window = [
      '2032-06-09',
      '2032-06-10',
      '2032-06-11',
      '2032-06-12',
      '2032-06-13',
      '2032-06-14',
      '2032-06-15',
    ];
    const lines = failureLines(logs.lines());
    expect(lines.length, 'no admin_dashboard_day_failed error line').toBeGreaterThan(0);
    for (const line of lines) {
      const text = JSON.stringify(line);
      expect(line['app_id']).toBe(failing);
      expect(
        Object.values(line).some((value) => window.includes(String(value))),
        `no day of the window in ${text}`,
      ).toBe(true);
      expect(text).toContain('SyntheticLinkFailure');
      expect(text).not.toContain(FAILURE_TOKEN);
      expect(Object.keys(line).filter((key) => /fen|amount/iu.test(key))).toEqual([]);
    }
  },
  TIMEOUT,
);
