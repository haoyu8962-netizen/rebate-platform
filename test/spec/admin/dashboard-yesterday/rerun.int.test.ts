// B1-34q: the stored row is the figures at its aggregation instant (01 F-ADM-26 ② 取值时刻为聚合时刻):
// later changes leave it as it is; aggregating (app, D) again overwrites the four figures and
// as_of with the new instant, still one row (task brief §9 items 4 and 6).
// Fund rule tests: top-level it only (规划/11 §4.3).
import { expect, it } from 'vitest';
import {
  AGG_AGAIN_AT,
  AGG_AT,
  D,
  D_LAST,
  D_NOON,
  D_START,
  TIMEOUT,
  aggregate,
  linkLog,
  newApp,
  orderOf,
  rowsOf,
  rulesOf,
  setStatus,
  useDatabase,
  userOf,
} from './kit.ts';

const world = useDatabase();

it(
  '[AC-B1-34q#9] 聚合后订单状态再变、数据再增，已存的行不变；重跑按新的聚合时刻覆盖四个数与 as_of，不新增行',
  async () => {
    const { db } = world;
    const app = newApp('rerun');
    const rules = await rulesOf(db, app);
    // Two ESTIMATED + PAID orders, N=1000, B=850, self 5000 → 425 each.
    await orderOf(db, app, rules, { paidAt: D_NOON });
    const second = await orderOf(db, app, rules, { paidAt: D_NOON });
    await linkLog(db, app, D_NOON);
    await userOf(db, app, D_NOON);

    await aggregate(db, app, D, AGG_AT);
    const first = {
      day: D,
      links: 1n,
      orders: 2n,
      est_rebate_fen: 850n,
      new_users: 1n,
      as_of: AGG_AT,
    };
    expect(await rowsOf(db, app)).toEqual([first]);

    // After the aggregation: the second order is voided, a WAITING order paid in D arrives,
    // one more convert and one more registration land in D.
    await setStatus(db, app, second, 'VOID', 'INVALID');
    await orderOf(db, app, rules, {
      paidAt: D_LAST,
      rebateStatus: 'WAITING',
      platformStatus: 'RECEIVED',
    });
    await linkLog(db, app, D_LAST);
    await userOf(db, app, D_START);
    expect(await rowsOf(db, app)).toEqual([first]);

    await aggregate(db, app, D, AGG_AGAIN_AT);
    // Orders 3 (the voided one is still paid in D); estimated: only the first order, 425.
    expect(await rowsOf(db, app)).toEqual([
      {
        day: D,
        links: 2n,
        orders: 3n,
        est_rebate_fen: 425n,
        new_users: 2n,
        as_of: AGG_AGAIN_AT,
      },
    ]);
  },
  TIMEOUT,
);
