// B1-34q (D10-1464 ①): the lag gauge of the workbench's daily rows. For every app with an admin
// account (admin_users), lag = the days between the newest due accounting day (D falls due at
// D+1 00:10:00 +08:00, written out by hand below) and the app's newest app.admin_dashboard_days
// stat_date; 0 when the newest row is the newest due day; an app without any row is 7 behind (the
// tick's window: the most it can be asked to fill). Holes before the newest row do not count.
// Read through readDashboardDayLag(db, now) of platform/metrics/dashboard-day-lag.ts (loaded by
// URL, its export asserted first, as the kit does); the registry, index and entry wiring are not
// used here. The rows are stored through aggregateDashboardDay at instants after each day fell due.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { expect, it } from 'vitest';
import { TIMEOUT, adminOf, aggregate, newApp, useDatabase } from './kit.ts';

const world = useDatabase();

const ROOT = new URL('../../../../', import.meta.url);

/** A storing instant after every day used here fell due (2032-06-18 01:00 +08:00). */
const STORED = '2032-06-17T17:00:00.000Z';
/** 2032-06-16 02:00 +08:00: the newest due day is 2032-06-15. */
const NOW = '2032-06-15T18:00:00.000Z';

interface LagSample {
  readonly appId: string;
  readonly lagDays: number;
}

type ReadLag = (db: Kysely<DB>, now: Date) => Promise<readonly LagSample[]>;

async function lags(db: Kysely<DB>, now: string): Promise<readonly LagSample[]> {
  const path = 'apps/api/src/modules/platform/metrics/dashboard-day-lag.ts';
  const loaded = (await import(new URL(path, ROOT).href)) as Record<string, unknown>;
  const read = loaded['readDashboardDayLag'];
  expect(typeof read, `${path} does not export readDashboardDayLag`).toBe('function');
  return (read as ReadLag)(db, new Date(now));
}

/** The app's samples (an app has exactly one when listed). */
async function lagOf(db: Kysely<DB>, appId: string, now: string): Promise<number[]> {
  return (await lags(db, now)).filter((s) => s.appId === appId).map((s) => s.lagDays);
}

async function store(db: Kysely<DB>, appId: string, days: readonly string[]): Promise<void> {
  for (const day of days) await aggregate(db, appId, day, STORED);
}

it(
  '[AC-B1-34q#21] 落后天数：最新一行比最近到期日早 3 天时为 3（中间的空洞不另算），补齐到最近到期日后回 0',
  async () => {
    const { db } = world;
    const app = newApp('lag');
    await adminOf(db, app);
    await store(db, app, ['2032-06-10', '2032-06-12']);

    // Newest due 06-15, newest row 06-12: 3 days behind.
    expect(await lagOf(db, app, NOW)).toEqual([3]);

    await store(db, app, ['2032-06-13', '2032-06-14', '2032-06-15']);
    expect(await lagOf(db, app, NOW)).toEqual([0]);
  },
  TIMEOUT,
);

it(
  '[AC-B1-34q#22] 到期边界 D+1 00:10:00 +08:00：最新一行为 06-14 时，06-16 00:09:59.999 为 0，00:10:00.000 为 1',
  async () => {
    const { db } = world;
    const app = newApp('lag-edge');
    await adminOf(db, app);
    await store(db, app, ['2032-06-13', '2032-06-14']);

    // 2032-06-16 00:09:59.999 +08:00: 06-15 is not due yet, the newest due day is 06-14.
    expect(await lagOf(db, app, '2032-06-15T16:09:59.999Z')).toEqual([0]);
    // 2032-06-16 00:10:00.000 +08:00: 06-15 falls due.
    expect(await lagOf(db, app, '2032-06-15T16:10:00.000Z')).toEqual([1]);
  },
  TIMEOUT,
);

it(
  '[AC-B1-34q#23] 每个有后台账号的 app 各一个值、互不串：落后 2、追平 0、一行都没有按窗口 7；无后台账号的 app 没有值',
  async () => {
    const { db } = world;
    const behind = newApp('lag-behind');
    const current = newApp('lag-current');
    const blank = newApp('lag-blank');
    const unlisted = newApp('lag-unlisted');
    await adminOf(db, behind);
    await adminOf(db, current);
    await adminOf(db, blank);
    await store(db, behind, ['2032-06-13']);
    await store(db, current, ['2032-06-15']);
    await store(db, unlisted, ['2032-06-10']);

    const samples = await lags(db, NOW);
    const of = (appId: string) => samples.filter((s) => s.appId === appId).map((s) => s.lagDays);
    expect(of(behind)).toEqual([2]);
    expect(of(current)).toEqual([0]);
    expect(of(blank)).toEqual([7]);
    expect(of(unlisted)).toEqual([]);
  },
  TIMEOUT,
);
