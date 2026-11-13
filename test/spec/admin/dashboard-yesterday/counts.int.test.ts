// B1-34q: the three counts of one (app, accounting day) — 01 F-ADM-26 ② 转链数、成交订单数、新增用户数
// (D10-1403 Q2: link_logs of event=convert only) — and the zero row of an app without data.
// D = 2032-06-15; its bounds at +08:00 are written out in ./kit.ts.
import { expect, it } from 'vitest';
import {
  AGG_AT,
  D,
  D_LAST,
  D_NEXT,
  D_NOON,
  D_PREV_LAST,
  D_START,
  TIMEOUT,
  aggregate,
  linkLog,
  newApp,
  orderOf,
  rowOf,
  rowsOf,
  rulesOf,
  useDatabase,
  userOf,
} from './kit.ts';

const world = useDatabase();

it(
  '[AC-B1-34q#1] F-ADM-26 ② 转链数：本 app、event=convert、created_at ∈ [D 00:00, D+1 00:00) +08:00',
  async () => {
    const { db } = world;
    const app = newApp('links');
    const other = newApp('links-other');
    // Counted: the first and the last millisecond of D, and its noon.
    await linkLog(db, app, D_START);
    await linkLog(db, app, D_NOON);
    await linkLog(db, app, D_LAST);
    // Not counted: the neighbouring days' edges, the other events, another app.
    await linkLog(db, app, D_PREV_LAST);
    await linkLog(db, app, D_NEXT);
    await linkLog(db, app, D_NOON, 'precompute');
    await linkLog(db, app, D_NOON, 'register');
    await linkLog(db, app, D_NOON, 'open');
    await linkLog(db, other, D_NOON);

    await aggregate(db, app, D, AGG_AT);

    expect(await rowOf(db, app, D)).toMatchObject({ links: 3n });
    // Aggregating one app writes no row of another.
    expect(await rowsOf(db, other)).toEqual([]);
  },
  TIMEOUT,
);

it(
  '[AC-B1-34q#2] F-ADM-26 ② 成交订单数：paid_at 落在 D 的子订单，不看现状态（之后作废、扣回、未归属也计）',
  async () => {
    const { db } = world;
    const app = newApp('orders');
    const other = newApp('orders-other');
    const rules = await rulesOf(db, app);
    const otherRules = await rulesOf(db, other);
    // Counted (5): paid in D, whatever their status is now.
    await orderOf(db, app, rules, { paidAt: D_START });
    await orderOf(db, app, rules, {
      paidAt: D_NOON,
      rebateStatus: 'VOID',
      platformStatus: 'INVALID',
    });
    await orderOf(db, app, rules, {
      paidAt: D_NOON,
      rebateStatus: 'CLAWED_BACK',
      platformStatus: 'INVALID',
    });
    await orderOf(db, app, rules, {
      paidAt: D_NOON,
      rebateStatus: 'UNATTRIBUTED',
      platformStatus: 'PAID',
    });
    await orderOf(db, app, rules, {
      paidAt: D_LAST,
      rebateStatus: 'CREDITED',
      platformStatus: 'SETTLED',
    });
    // Not counted: not paid (deposit only), paid on the neighbouring days, another app.
    await orderOf(db, app, rules, { paidAt: null, platformStatus: 'DEPOSIT_PAID' });
    await orderOf(db, app, rules, { paidAt: D_PREV_LAST });
    await orderOf(db, app, rules, { paidAt: D_NEXT });
    await orderOf(db, other, otherRules, { paidAt: D_NOON });

    await aggregate(db, app, D, AGG_AT);

    expect(await rowOf(db, app, D)).toMatchObject({ orders: 5n });
  },
  TIMEOUT,
);

it(
  '[AC-B1-34q#3] F-ADM-26 ② 新增用户数：created_at 落在 D 的 users 行，已注销（status=deleted）的也计',
  async () => {
    const { db } = world;
    const app = newApp('users');
    const other = newApp('users-other');
    // Counted (3).
    await userOf(db, app, D_START);
    await userOf(db, app, D_LAST);
    await userOf(db, app, D_NOON, 'deleted');
    // Not counted.
    await userOf(db, app, D_PREV_LAST);
    await userOf(db, app, D_NEXT);
    await userOf(db, other, D_NOON);

    await aggregate(db, app, D, AGG_AT);

    expect(await rowOf(db, app, D)).toMatchObject({ new_users: 3n });
  },
  TIMEOUT,
);

it(
  '[AC-B1-34q#4] D10-1403：没有任何数据的 app 也写一行，四个数为真 0、as_of 为聚合时刻；没聚合的日子没有行',
  async () => {
    const { db } = world;
    const app = newApp('empty');

    await aggregate(db, app, D, AGG_AT);

    expect(await rowsOf(db, app)).toEqual([
      { day: D, links: 0n, orders: 0n, est_rebate_fen: 0n, new_users: 0n, as_of: AGG_AT },
    ]);
  },
  TIMEOUT,
);
