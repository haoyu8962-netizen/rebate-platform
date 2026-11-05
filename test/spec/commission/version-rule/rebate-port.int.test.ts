// B2-03s · rebate 按 commission_moved 走（BR-CALC-15、BR-CALC-02，D10-578）：真实 rebate 与 commission，change 由测试给定。
// 列是手写的，所以能造出报文走不到的情形：基数相同而 N 不同（比前后基数看不出来，只有 commission_moved 知道）、
// 预估变了而版本没动（比前后 est 会误判）。默认单：预留 1500，self 5000 / direct 1000 / indirect 500。
// 手算：N 1000 → B 850 → 425 / 85 / 42；N 1001 → B 850（850.85 向下取整），份额相同，合计 552，利润 1001 − 552 = 449；
// N 800 → B 680 → 340 / 68 / 34，合计 442，利润 358。
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  TIMEOUT,
  amountsAt,
  databaseFixture,
  moneyRows,
  orderRow,
  portHarness,
  storedVersions,
  totalsAt,
} from './kit.ts';

const p = databaseFixture(createTestDatabase);

const WAITING_SETTLED = {
  rebateStatus: 'WAITING',
  platformStatus: 'SETTLED',
  estFen: 1000n,
  settleFen: 1000n,
  patch: { received_at: new Date('2026-10-25T01:00:00.000Z'), settle_period: '2026-10' },
} as const;

const CREDITED = {
  rebateStatus: 'CREDITED',
  platformStatus: 'SETTLED',
  estFen: 1000n,
  settleFen: 1000n,
  patch: { booked_base_fen: 850n, booked_n_fen: 1000n },
} as const;

it(
  '[AC-B2-03s#27][BR-CALC-15][BR-CALC-02] WAITING 单基数相同而 N 不同：commission_moved 为 true 就 revalue，新版本行按新 N，n_total 与利润跟着变',
  async () => {
    const h = await portHarness(p.db);
    const o = await h.order(WAITING_SETTLED);

    await h.sync(o, { settleAfter: 1001n, moved: true });

    expect(await amountsAt(p.db, o, 2)).toEqual([
      ['self', 850n, 425n],
      ['direct', 850n, 85n],
      ['indirect', 850n, 42n],
    ]);
    expect(await totalsAt(p.db, o, 2)).toEqual({
      n_total_fen: 1001n,
      pre_base_deduct_fen: 151n,
      base_fen: 850n,
      user_share_total_fen: 552n,
      tlj_redpacket_fen: 0n,
      platform_est_profit_fen: 449n,
    });
    expect(await orderRow(p.db, o)).toMatchObject({
      rebate_status: 'WAITING',
      commission_version: 2,
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-03s#28][BR-CALC-15] WAITING 单预估变了、commission_moved 为 false：不调 refresh，比 est 前后不算数',
  async () => {
    const h = await portHarness(p.db);
    const o = await h.order({ ...WAITING_SETTLED, commissionVersion: 2 });
    await h.version(o, {
      version: 2,
      nTotalFen: 1000n,
      baseFen: 850n,
      amounts: [425n, 85n, 42n],
    });

    await h.sync(o, { estAfter: 3000n, moved: false });

    expect(h.refresh).not.toHaveBeenCalled();
    expect(await storedVersions(p.db, o)).toEqual({ amounts: [1, 2], totals: [1, 2] });
    expect(await orderRow(p.db, o)).toMatchObject({
      est_commission_fen: 3000n,
      commission_version: 2,
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-03s#29][BR-CALC-23][BR-CALC-15] CREDITED 单 commission_moved 为 true：同一事务调一次 refresh，只带订单引用，新行按新 N；credited_noop，状态、booked、分录不动',
  async () => {
    const h = await portHarness(p.db);
    const o = await h.order(CREDITED);
    const money = await moneyRows(p.db, o.appId);

    const trx = await h.sync(o, { settleAfter: 800n, moved: true });

    expect(h.refresh.mock.calls).toEqual([
      [trx, { appId: o.appId, orderId: o.orderId, attrAt: o.attrAt }],
    ]);
    expect(h.outcomes('credited_noop')).toBe(1);
    expect(await amountsAt(p.db, o, 2)).toEqual([
      ['self', 680n, 340n],
      ['direct', 680n, 68n],
      ['indirect', 680n, 34n],
    ]);
    expect(await totalsAt(p.db, o, 2)).toEqual({
      n_total_fen: 800n,
      pre_base_deduct_fen: 120n,
      base_fen: 680n,
      user_share_total_fen: 442n,
      tlj_redpacket_fen: 0n,
      platform_est_profit_fen: 358n,
    });
    expect(await orderRow(p.db, o)).toMatchObject({
      rebate_status: 'CREDITED',
      booked_base_fen: 850n,
      booked_n_fen: 1000n,
      commission_version: 2,
    });
    expect(await moneyRows(p.db, o.appId)).toEqual(money);
  },
  TIMEOUT,
);

it(
  '[AC-B2-03s#34][BR-CALC-02][BR-CALC-27][BR-CALC-23] CREDITED 单基数相同而 N 不同：commission_moved 为 true，受益人份额不变，n_total、基数前扣除与利润按新 N，不是复制；入账与账本不动',
  async () => {
    const h = await portHarness(p.db);
    const o = await h.order(CREDITED);
    const money = await moneyRows(p.db, o.appId);

    await h.sync(o, { settleAfter: 1001n, moved: true });

    expect(await amountsAt(p.db, o, 2)).toEqual([
      ['self', 850n, 425n],
      ['direct', 850n, 85n],
      ['indirect', 850n, 42n],
    ]);
    expect(await totalsAt(p.db, o, 2)).toEqual({
      n_total_fen: 1001n,
      pre_base_deduct_fen: 151n,
      base_fen: 850n,
      user_share_total_fen: 552n,
      tlj_redpacket_fen: 0n,
      platform_est_profit_fen: 449n,
    });
    expect(await orderRow(p.db, o)).toMatchObject({
      rebate_status: 'CREDITED',
      booked_base_fen: 850n,
      booked_n_fen: 1000n,
      commission_version: 2,
    });
    expect(await moneyRows(p.db, o.appId)).toEqual(money);
  },
  TIMEOUT,
);

it(
  '[AC-B2-03s#30][BR-CALC-23][BR-CALC-15] CREDITED 单预估变了、commission_moved 为 false：只 credited_noop，不调 refresh，没有新行',
  async () => {
    const h = await portHarness(p.db);
    const o = await h.order({ ...CREDITED, commissionVersion: 2 });
    await h.version(o, {
      version: 2,
      nTotalFen: 1000n,
      baseFen: 850n,
      amounts: [425n, 85n, 42n],
    });

    await h.sync(o, { estAfter: 2000n, moved: false });

    expect(h.refresh).not.toHaveBeenCalled();
    expect(h.outcomes('credited_noop')).toBe(1);
    expect(await storedVersions(p.db, o)).toEqual({ amounts: [1, 2], totals: [1, 2] });
  },
  TIMEOUT,
);
