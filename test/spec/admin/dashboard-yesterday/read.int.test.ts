// B1-34q: readDashboardYesterday from admin's index.ts (task brief §9 item 8, D10-1403 Q3):
// yesterday = the accounting day before the one of `now` (+08:00, written out by hand); that row
// when it exists, else the app's newest row not later than yesterday with its own date and as_of
// (never a row of today or later), else null; only the app's own rows. The rows are stored through
// aggregateDashboardDay at instants after each day fell due.
import { expect, it } from 'vitest';
import {
  D,
  D_NOON,
  TIMEOUT,
  aggregate,
  at,
  linkLog,
  newApp,
  readYesterday,
  useDatabase,
  userOf,
} from './kit.ts';

const world = useDatabase();

/** 06-16 09:00 +08:00: today is 06-16, yesterday is D = 06-15. */
const NOW = '2032-06-16T01:00:00.000Z';

it(
  '[AC-B1-34q#14] 有昨天（accountingDate(now) 的前一天）那行就返回它：date、四个数与 as_of 照存',
  async () => {
    const { db } = world;
    const app = newApp('read');
    await linkLog(db, app, D_NOON);
    await linkLog(db, app, D_NOON);
    await userOf(db, app, D_NOON);
    await aggregate(db, app, '2032-06-13', '2032-06-13T17:00:00.000Z');
    await aggregate(db, app, D, '2032-06-15T17:30:00.000Z');
    await aggregate(db, app, '2032-06-16', '2032-06-16T17:00:00.000Z');

    expect(await readYesterday(db, app, NOW)).toEqual({
      date: D,
      links: 2n,
      orders: 0n,
      est_rebate_fen: 0n,
      new_users: 1n,
      as_of: new Date('2032-06-15T17:30:00.000Z'),
    });
  },
  TIMEOUT,
);

it(
  '[AC-B1-34q#15] 昨天按 now 的 +08:00 会计日取：06-15 23:59:59.999 读 06-14 的行，06-16 00:00:00.000 读 06-15 的行',
  async () => {
    const { db } = world;
    const app = newApp('read-edge');
    await aggregate(db, app, '2032-06-14', '2032-06-16T17:00:00.000Z');
    await aggregate(db, app, D, '2032-06-16T17:00:01.000Z');

    // 2032-06-15 23:59:59.999 +08:00.
    expect(await readYesterday(db, app, '2032-06-15T15:59:59.999Z')).toMatchObject({
      date: '2032-06-14',
    });
    // 2032-06-16 00:00:00.000 +08:00.
    expect(await readYesterday(db, app, '2032-06-15T16:00:00.000Z')).toMatchObject({ date: D });
  },
  TIMEOUT,
);

it(
  '[AC-B1-34q#16] 没有昨天那行：返回不晚于昨天的最新一行，date 与 as_of 如实；今天及以后的行不返回',
  async () => {
    const { db } = world;
    const app = newApp('read-fallback');
    await linkLog(db, app, at('2032-06-13', '08:00:00.000'));
    await aggregate(db, app, '2032-06-12', '2032-06-12T17:00:00.000Z');
    await aggregate(db, app, '2032-06-13', '2032-06-13T18:00:00.000Z');
    // Rows of today (06-16) and of 06-17 exist; yesterday (06-15) and 06-14 do not.
    await aggregate(db, app, '2032-06-16', '2032-06-17T17:00:00.000Z');
    await aggregate(db, app, '2032-06-17', '2032-06-17T17:00:00.000Z');

    expect(await readYesterday(db, app, NOW)).toEqual({
      date: '2032-06-13',
      links: 1n,
      orders: 0n,
      est_rebate_fen: 0n,
      new_users: 0n,
      as_of: new Date('2032-06-13T18:00:00.000Z'),
    });
  },
  TIMEOUT,
);

it(
  '[AC-B1-34q#17] 一行都没有返回 null，别的 app 的行不读；聚合过的空 app 返回真 0 行而不是 null',
  async () => {
    const { db } = world;
    const never = newApp('read-never');
    const neighbour = newApp('read-neighbour');
    const empty = newApp('read-empty');
    await linkLog(db, neighbour, D_NOON);
    await aggregate(db, neighbour, D, '2032-06-15T17:00:00.000Z');
    await aggregate(db, empty, D, '2032-06-15T17:00:00.000Z');

    expect(await readYesterday(db, never, NOW)).toBeNull();
    expect(await readYesterday(db, empty, NOW)).toEqual({
      date: D,
      links: 0n,
      orders: 0n,
      est_rebate_fen: 0n,
      new_users: 0n,
      as_of: new Date('2032-06-15T17:00:00.000Z'),
    });
  },
  TIMEOUT,
);
