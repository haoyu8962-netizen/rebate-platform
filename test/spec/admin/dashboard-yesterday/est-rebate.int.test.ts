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
  AGG_AGAIN_AT,
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
  setEstFen,
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

it(
  '[AC-B1-34q#18] BR-CALC-02 / BR-CALC-08 取整：预留后与各份额都向下取整到分，不四舍五入',
  async () => {
    const { db } = world;
    const app = newApp('est-floor');
    const rules = await rulesOf(db, app);

    // O1 N=1007, reserve 1500: B = floor(1007 × 8500 / 10000) = floor(855.95) = 855 (round: 856);
    //    self 5000 → floor(427.5) = 427 (round: 428), direct 1000 → floor(85.5) = 85 (round: 86),
    //    indirect 500 → floor(42.75) = 42 (round: 43); users 554 (round: 557).
    await orderOf(db, app, rules, {
      paidAt: D_NOON,
      estFen: 1007n,
      people: [
        { userId: randomUUID(), role: 'self', ratioBp: 5000 },
        { userId: randomUUID(), role: 'direct', ratioBp: 1000 },
        { userId: randomUUID(), role: 'indirect', ratioBp: 500 },
      ],
    });
    // O2 N=1013, reserve 1500: B = floor(1013 × 8500 / 10000) = floor(861.05) = 861;
    //    self 3333 → floor(861 × 3333 / 10000) = floor(286.9713) = 286 (round: 287).
    await orderOf(db, app, rules, {
      paidAt: D_NOON,
      estFen: 1013n,
      people: [{ userId: randomUUID(), role: 'self', ratioBp: 3333 }],
    });

    await aggregate(db, app, D, AGG_AT);

    // 554 + 286 = 840.
    expect(await rowOf(db, app, D)).toMatchObject({ orders: 2n, est_rebate_fen: 840n });
  },
  TIMEOUT,
);

it(
  '[AC-B1-34q#19] BR-CALC-02 有效佣金：settle_commission_fen=0 非空即取 0，不退回预估；预估再变、重聚合仍为 0',
  async () => {
    const { db } = world;
    const app = newApp('est-settle-zero');
    const rules = await rulesOf(db, app);
    // Settle 0 present: N = 0 → B = max(0, floor(0 × 8500 / 10000) − 0) = 0 → self 0
    // (the estimate 2000 would give B = 1700, self 850; after the change 3000 → 2550, 1275).
    const zero = await orderOf(db, app, rules, { paidAt: D_NOON, estFen: 2000n, settleFen: 0n });
    // Reference: N=1000, B=850, self 5000 → 425.
    await orderOf(db, app, rules, { paidAt: D_NOON });

    await aggregate(db, app, D, AGG_AT);
    expect(await rowOf(db, app, D)).toMatchObject({
      orders: 2n,
      est_rebate_fen: 425n,
      as_of: AGG_AT,
    });

    await setEstFen(db, app, zero, 3000n);
    await aggregate(db, app, D, AGG_AGAIN_AT);
    expect(await rowOf(db, app, D)).toMatchObject({
      orders: 2n,
      est_rebate_fen: 425n,
      as_of: AGG_AGAIN_AT,
    });
  },
  TIMEOUT,
);

it(
  '[AC-B1-34q#20] BR-CALC-02 基数下限 0：有效佣金为负或 0、淘礼金扣减等于或超过预留后金额的单贡献 0，汇总照写',
  async () => {
    const { db } = world;
    const app = newApp('est-floor-zero');
    const rules = await rulesOf(db, app);
    // N = −100 (estimate): N ≤ 0 is taken as 0 → B = max(0, 0 − 0) = 0 → 0.
    await orderOf(db, app, rules, { paidAt: D_NOON, estFen: -100n });
    // N = 0 (estimate): B = 0 → 0.
    await orderOf(db, app, rules, { paidAt: D_NOON, estFen: 0n });
    // Settle −50 present (estimate 1000 ignored): N = −50 → 0 → B = 0 → 0.
    await orderOf(db, app, rules, { paidAt: D_NOON, estFen: 1000n, settleFen: -50n });
    // N=1000, reserve 1500, tlj 800 < 850: B = 850 − 800 = 50;
    //    self 5000 → 25, direct 1000 → 5, indirect 500 → floor(2.5) = 2; users 32.
    await orderOf(db, app, rules, {
      paidAt: D_NOON,
      tljDeductFen: 800n,
      people: [
        { userId: randomUUID(), role: 'self', ratioBp: 5000 },
        { userId: randomUUID(), role: 'direct', ratioBp: 1000 },
        { userId: randomUUID(), role: 'indirect', ratioBp: 500 },
      ],
    });
    // tlj 850 = 850: B = max(0, 0) = 0 → 0.
    await orderOf(db, app, rules, { paidAt: D_NOON, tljDeductFen: 850n });
    // tlj 900 > 850: B = max(0, 850 − 900) = max(0, −50) = 0 → 0 (never −25).
    await orderOf(db, app, rules, { paidAt: D_NOON, tljDeductFen: 900n });
    // Reference: N=1000, B=850, self 5000 → 425.
    await orderOf(db, app, rules, { paidAt: D_NOON });

    await aggregate(db, app, D, AGG_AT);

    // 0 + 0 + 0 + 32 + 0 + 0 + 425 = 457; the row is written (rowOf asserts exactly one).
    expect(await rowOf(db, app, D)).toMatchObject({
      orders: 7n,
      est_rebate_fen: 457n,
      as_of: AGG_AT,
    });
  },
  TIMEOUT,
);
