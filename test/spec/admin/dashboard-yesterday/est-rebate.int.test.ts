// B1-34q: 预估返利合计 of one (app, D) — 01 F-ADM-26 ②: among the sub-orders paid in D, those still
// rebate_status=ESTIMATED and platform_status≠DEPOSIT_PAID at the aggregation instant (BR-TEXT-21
// ESTIMATED; D10-1403 Q1), the sum of the beneficiaries' shares, platform reserve and retain left
// out. Shares follow BR-CALC-02 (effective union commission: settle_commission_fen when present,
// else est_commission_fen; less the open rights deduction, as the wallet prices it; B =
// max(0, floor(N × (10000 − reserve_bp) / 10000) − tlj_deduct_fen); each role floor(B × ratio_bp /
// 10000); a forfeited role's share is the platform's). Every amount is worked out by hand below.
// Fund rule tests: top-level it only (规划/11 §4.3).
import { randomUUID } from 'node:crypto';
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
  newApp,
  openRightsDeduction,
  orderOf,
  rowOf,
  rulesOf,
  useDatabase,
} from './kit.ts';

const world = useDatabase();

it(
  '[AC-B1-34q#5] BR-CALC-02 份额计价：多受益人、结算佣金覆盖预估、forfeited、淘礼金扣减、未结维权扣减、取整',
  async () => {
    const { db } = world;
    const app = newApp('est-mix');
    const rules = await rulesOf(db, app);
    const self = randomUUID();
    const direct = randomUUID();
    const indirect = randomUUID();

    // O1 N=1000, reserve 1500: B = floor(1000 × 8500 / 10000) = 850;
    //    self 5000 → 425, direct 1000 → 85, indirect 500 → floor(42.5) = 42; users 552.
    await orderOf(db, app, rules, {
      paidAt: D_NOON,
      people: [
        { userId: self, role: 'self', ratioBp: 5000 },
        { userId: direct, role: 'direct', ratioBp: 1000 },
        { userId: indirect, role: 'indirect', ratioBp: 500 },
      ],
    });
    // O2 est 2000 but settle 1200 present: N = 1200, B = floor(1200 × 8500 / 10000) = 1020;
    //    self 5000 → 510 (the estimate would give B = 1700, 850).
    await orderOf(db, app, rules, { paidAt: D_NOON, estFen: 2000n, settleFen: 1200n });
    // O3 ESTIMATED + RECEIVED (no received_at, BR-FUND-01 R4 guard), est 600:
    //    B = floor(600 × 8500 / 10000) = 510; self → 255.
    await orderOf(db, app, rules, { paidAt: D_NOON, estFen: 600n, platformStatus: 'RECEIVED' });
    // O4 N=1000, B=850: self 425 counted; direct forfeited in the snapshot (85 → platform);
    //    indirect forfeited by a later event (42 → platform); users 425.
    await orderOf(db, app, rules, {
      paidAt: D_NOON,
      people: [
        { userId: self, role: 'self', ratioBp: 5000 },
        { userId: direct, role: 'direct', ratioBp: 1000, initialStatus: 'forfeited' },
        {
          userId: indirect,
          role: 'indirect',
          ratioBp: 500,
          forfeitedEvent: { reason: 'banned', at: new Date(D_START) },
        },
      ],
    });
    // O5 tlj normal deduction 100: B = 850 − 100 = 750; self → 375.
    await orderOf(db, app, rules, { paidAt: D_NOON, tljDeductFen: 100n });
    // O6 open rights deduction 400: N = 1000 − 400 = 600, B = 510; self → 255.
    const o6 = await orderOf(db, app, rules, { paidAt: D_NOON });
    await openRightsDeduction(db, app, o6, 400n);
    // O7 reserve 2000, est 999: B = floor(999 × 8000 / 10000) = floor(799.2) = 799;
    //    self → floor(399.5) = 399.
    await orderOf(db, app, rules, { paidAt: D_NOON, estFen: 999n, reserveBp: 2000 });

    await aggregate(db, app, D, AGG_AT);

    // 552 + 510 + 255 + 425 + 375 + 255 + 399 = 2771.
    expect(await rowOf(db, app, D)).toMatchObject({ orders: 7n, est_rebate_fen: 2771n });
  },
  TIMEOUT,
);

it(
  '[AC-B1-34q#6] F-ADM-26 ② ≠DEPOSIT_PAID：ESTIMATED + RECEIVED 计入（钱包 estimated_fen 限 =PAID，不计；两者在此不同）',
  async () => {
    const { db } = world;
    const app = newApp('est-received');
    const rules = await rulesOf(db, app);
    // ESTIMATED + RECEIVED, N=1000: B = 850; self 5000 → 425.
    await orderOf(db, app, rules, { paidAt: D_NOON, platformStatus: 'RECEIVED' });

    await aggregate(db, app, D, AGG_AT);

    expect(await rowOf(db, app, D)).toMatchObject({ orders: 1n, est_rebate_fen: 425n });
  },
  TIMEOUT,
);

it(
  '[AC-B1-34q#7] BR-TEXT-21 ESTIMATED：DEPOSIT_PAID、WAITING、CREDITED、VOID、UNATTRIBUTED、CLAWED_BACK 不计',
  async () => {
    const { db } = world;
    const app = newApp('est-excluded');
    const rules = await rulesOf(db, app);
    // The one counted order: ESTIMATED + PAID, N=1000, B=850, self → 425.
    await orderOf(db, app, rules, { paidAt: D_NOON });
    // Paid in D, each worth 425 if it were counted.
    const excluded = [
      ['ESTIMATED', 'DEPOSIT_PAID'],
      ['WAITING', 'RECEIVED'],
      ['WAITING', 'SETTLED'],
      ['CREDITED', 'SETTLED'],
      ['VOID', 'INVALID'],
      ['UNATTRIBUTED', 'PAID'],
      ['CLAWED_BACK', 'INVALID'],
    ] as const;
    for (const [rebateStatus, platformStatus] of excluded) {
      await orderOf(db, app, rules, { paidAt: D_NOON, rebateStatus, platformStatus });
    }

    await aggregate(db, app, D, AGG_AT);

    expect(await rowOf(db, app, D)).toMatchObject({ orders: 8n, est_rebate_fen: 425n });
  },
  TIMEOUT,
);

it(
  '[AC-B1-34q#8] F-ADM-26 ② 只取 paid_at 落在 D（+08:00）的本 app 子订单：首尾毫秒计入，相邻两天与别的 app 不计',
  async () => {
    const { db } = world;
    const app = newApp('est-bounds');
    const other = newApp('est-bounds-other');
    const rules = await rulesOf(db, app);
    const otherRules = await rulesOf(db, other);
    // Counted: ESTIMATED + PAID at D 00:00:00.000 and D 23:59:59.999 +08:00, 425 each.
    await orderOf(db, app, rules, { paidAt: D_START });
    await orderOf(db, app, rules, { paidAt: D_LAST });
    // Not counted, 425 each if they were.
    await orderOf(db, app, rules, { paidAt: D_PREV_LAST });
    await orderOf(db, app, rules, { paidAt: D_NEXT });
    await orderOf(db, app, rules, { paidAt: null });
    await orderOf(db, other, otherRules, { paidAt: D_NOON });

    await aggregate(db, app, D, AGG_AT);

    expect(await rowOf(db, app, D)).toMatchObject({ orders: 2n, est_rebate_fen: 850n });
  },
  TIMEOUT,
);
