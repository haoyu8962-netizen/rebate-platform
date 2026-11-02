// B2-03r · 有结算记录的单与结算到达（BR-FUND-04 ④、BR-FUND-05、BR-FUND-18；编排方案 C）：
// 账单比的是 b_settle 与当前版本的 base，所以有结算记录的单 R7 不推版本；账单不减未关闭应扣，入账金额由
// R5 减 open（已有）。只有预估的单先 R7 推到 v2，联盟结算记录带着扣减到达时，账单比到的正是 v2。
// 「有结算记录」的判据（编排认可）：orders.settle_commission_fen 非空，或 order_settlements 有行，任一成立就不推版本：
// 京东的结算额只由账单导入写这张表，列恒空（changes/20261101-京东结算佣金只由账单导入）；planOrderSyncColumns 在
// SETTLED 时写列，可以没有结算行。金额全部手写，见 kit.ts 头部。
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { T1, T2, TIMEOUT, amountsAt, databaseFixture, harness, storedVersions } from './kit.ts';

const p = databaseFixture(createTestDatabase);

it(
  '[AC-B2-03r#11] 有结算记录的单 R7（结算 1000，应扣 400）：钱包与订单页下降到 255；版本不动、没有新金额行、结算列不动，refresh 调用与现在相同（不带第三参）',
  async () => {
    const h = await harness(p.db);
    const o = await h.settled();

    await h.deduct(o, 400n);

    const wallet = await h.walletOf(o.user('self'));
    expect(wallet.pending_credit_fen).toBe(255n);
    expect((await h.walletOf(o.user('direct'))).pending_credit_fen).toBe(51n);
    expect((await h.walletOf(o.user('indirect'))).pending_credit_fen).toBe(25n);
    expect((await h.appTotals()).total_waiting_fen).toBe(331n);
    expect(await h.figureOf(o.user('self'), o)).toMatchObject({
      b_est: 510n,
      est_rebate_fen: 255n,
    });

    expect(await storedVersions(p.db, o)).toEqual({ amounts: [1], totals: [1] });
    expect(await h.read(o)).toMatchObject({
      rebate_status: 'WAITING',
      commission_version: 1,
      est_commission_fen: 1000n,
      settle_commission_fen: 1000n,
    });
    expect(h.refresh).toHaveBeenCalledTimes(1);
    expect(h.refreshValues()).toEqual([undefined]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-03r#12] 有结算记录的单 R7 后月结：账单仍进候选（b_settle 850 与当前 base 850，不减未关闭应扣、不报差错），R5 按结算 1000 扣 400 预留 15% 入账：B 510，三人 255 / 51 / 25、平台 269，booked 510 / 600；入账后钱包不再计这笔，订单页实得 255，不再减一次',
  async () => {
    const h = await harness(p.db);
    const o = await h.settled();

    await h.deduct(o, 400n);
    expect((await h.walletOf(o.user('self'))).pending_credit_fen).toBe(255n);

    const bill = await h.runBill(o);

    expect(bill.validations).toEqual([
      expect.objectContaining({ orderId: o.orderId, result: 'candidate', settleSeq: 1 }),
    ]);
    expect(bill.items).toEqual([
      expect.objectContaining({ order_id: o.orderId, settle_seq: 1, b_settle_fen: 850n }),
    ]);
    expect(bill.diffs).toEqual([]);

    expect(await h.credit(o)).toMatchObject({
      outcome: 'credited',
      bCreditFen: 510n,
      bookedNFen: 600n,
      platformCreditFen: 269n,
    });
    expect(await h.balance(o.user('self'))).toBe(255n);
    expect(await h.balance(o.user('direct'))).toBe(51n);
    expect(await h.balance(o.user('indirect'))).toBe(25n);
    expect(await h.read(o)).toMatchObject({
      rebate_status: 'CREDITED',
      booked_base_fen: 510n,
      booked_n_fen: 600n,
      commission_version: 1,
    });
    expect((await h.walletOf(o.user('self'))).pending_credit_fen).toBe(0n);
    expect(await h.figureOf(o.user('self'), o)).toMatchObject({
      est_rebate_fen: null,
      actual_fen: 255n,
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-03r#13] 结算记录在、订单结算列为空（京东账单导入）：R7 也不推版本，账单仍进候选；钱包与订单页按预估 1000 − 400',
  async () => {
    const h = await harness(p.db);
    const o = await h.waiting({ platform: 'jd' });
    await h.settlement(o, { fen: 1000n });

    await h.deduct(o, 400n);

    expect((await h.walletOf(o.user('self'))).pending_credit_fen).toBe(255n);
    expect(await h.figureOf(o.user('self'), o)).toMatchObject({ est_rebate_fen: 255n });
    expect(await storedVersions(p.db, o)).toEqual({ amounts: [1], totals: [1] });
    expect(await h.read(o)).toMatchObject({
      commission_version: 1,
      settle_commission_fen: null,
    });
    expect(h.refreshValues()).toEqual([undefined]);

    const bill = await h.runBill(o);

    expect(bill.validations).toEqual([
      expect.objectContaining({ orderId: o.orderId, result: 'candidate', settleSeq: 1 }),
    ]);
    expect(bill.diffs).toEqual([]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-03r#29] 结算列有值、没有结算行（预估 3000，结算列 1000）：R7 也不推版本、不写新行，refresh 调用与现在相同；钱包与订单页按结算优先 1000 − 400 = 600 → 255 / 51 / 25，不是 3000 − 400',
  async () => {
    const h = await harness(p.db);
    const o = await h.waiting({ estFen: 3000n, settleFen: 1000n, platformStatus: 'SETTLED' });

    await h.deduct(o, 400n);

    expect((await h.walletOf(o.user('self'))).pending_credit_fen).toBe(255n);
    expect((await h.walletOf(o.user('direct'))).pending_credit_fen).toBe(51n);
    expect((await h.walletOf(o.user('indirect'))).pending_credit_fen).toBe(25n);
    expect(await h.figureOf(o.user('self'), o)).toMatchObject({
      b_est: 510n,
      est_rebate_fen: 255n,
    });
    expect(await storedVersions(p.db, o)).toEqual({ amounts: [1], totals: [1] });
    expect(await h.read(o)).toMatchObject({
      rebate_status: 'WAITING',
      commission_version: 1,
      est_commission_fen: 3000n,
      settle_commission_fen: 1000n,
    });
    expect(h.refreshValues()).toEqual([undefined]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-03r#14] 只有预估的单先 R7（应扣 400，v2 base 510）、再到联盟结算记录 600（回应这条维权）：结算到达不推版本、不写新行；账单不报 amount_mismatch，b_settle 510 与当前 base 510 进候选；R5 不再扣 400，按 600 入账：B 510，255 / 51 / 25、平台 269',
  async () => {
    const h = await harness(p.db);
    const o = await h.waiting();

    await h.deduct(o, 400n, 'rights-1', T1);
    expect((await h.read(o)).commission_version).toBe(2);

    await h.unionSync(o, { settleAfter: 600n, seq: 1, at: T2 });

    expect(await h.read(o)).toMatchObject({
      rebate_status: 'WAITING',
      commission_version: 2,
      est_commission_fen: 1000n,
      settle_commission_fen: 600n,
    });
    expect(await storedVersions(p.db, o)).toEqual({ amounts: [1, 2], totals: [1, 2] });
    expect((await h.rightsRows(o))[0]?.answered_at).toEqual(new Date(T2));
    expect((await h.walletOf(o.user('self'))).pending_credit_fen).toBe(255n);
    expect(await h.figureOf(o.user('self'), o)).toMatchObject({
      b_est: 510n,
      est_rebate_fen: 255n,
    });

    const bill = await h.runBill(o);

    expect(bill.validations).toEqual([
      expect.objectContaining({ orderId: o.orderId, result: 'candidate', settleSeq: 1 }),
    ]);
    expect(bill.items).toEqual([
      expect.objectContaining({ order_id: o.orderId, settle_seq: 1, b_settle_fen: 510n }),
    ]);
    expect(bill.diffs).toEqual([]);

    expect(await h.credit(o)).toMatchObject({
      outcome: 'credited',
      bCreditFen: 510n,
      bookedNFen: 600n,
      platformCreditFen: 269n,
    });
    expect(await h.balance(o.user('self'))).toBe(255n);
    expect(await h.balance(o.user('direct'))).toBe(51n);
    expect(await h.balance(o.user('indirect'))).toBe(25n);
    expect(await amountsAt(p.db, o, 2)).toEqual([
      ['self', 510n, 255n],
      ['direct', 510n, 51n],
      ['indirect', 510n, 25n],
    ]);
  },
  TIMEOUT,
);
