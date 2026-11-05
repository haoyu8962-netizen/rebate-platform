// B2-03q · refresh，CREDITED（D10-565；B2-03s 起按 D10-578、BR-CALC-23 (a)）：结算额变化推版本时按新 N 重算当前版本的
// 金额行与 totals，排在任何扣回之前；不改余额、不写分录、booked 不变。订单都先经真实 B2-04m 入账。
// 默认单（credit kit）：N=1000、预留 1500，booked 850 / 1000，入账 425 / 85 / 42；快照 v1 建在预估 4333 上，
// B=3683，份额 1841 / 368 / 184，n_total 4444（故意与入账额不同）；冻结补贴 111。
// 结算额变成 800：B=680，340 / 68 / 34，合计 442，n_total 911，基数前扣除 231，利润 469。
// BR-FUND-08 例：已入账 617 / 123 / 494，booked 1234，退款 1/2，联盟新 B=617 → 新应得 308 / 61 / 248，
// CLAWBACK 309、62，平台凭证 246。
import type { DB } from '@couli/db';
import { createTestDatabase } from '@couli/db/testing';
import type { Transaction } from 'kysely';
import { expect, it } from 'vitest';
import {
  planOrderSyncColumns,
  type OrderUpdatePlan,
} from '../../../../apps/api/src/modules/orders/index.ts';
import { order as unionOrder } from '../../orders/attribution/kit.ts';
import {
  LATER,
  TIMEOUT,
  amountRows,
  amountsAt,
  clawbackKey,
  creditedFixture,
  databaseFixture,
  fixture,
  moneyRows,
  orderRow,
  platformClawbackKey,
  platformDecreaseLines,
  receivable,
  storedVersions,
  syncColumns,
  totalsAt,
  userClawbackLines,
  type PortOrder,
} from './kit.ts';

const p = databaseFixture(createTestDatabase);

const FOR_BR_FUND_08 = {
  settleFen: 1234n,
  reserveBp: 0,
  people: [
    { role: 'self', ratioBp: 5000 },
    { role: 'direct', ratioBp: 1000 },
  ],
  patch: { quantity: 2 },
} as const;

type Harness = Awaited<ReturnType<typeof creditedFixture>>;

interface SettleSync {
  readonly settleAfter: bigint;
  readonly refundedQuantityAfter?: number;
}

const SETTLED_SYNC: OrderUpdatePlan = {
  kind: 'update',
  platform_status: 'SETTLED',
  received_at: null,
  history: [],
  pending: null,
  rule: null,
};

/**
 * One sync whose report carries a settlement amount. syncColumns writes the estimate only, so the
 * commission columns come from the real column plan here, and so does commission_moved
 * (BR-CALC-15): the version moves only because the plan says so, as in update-step.
 */
async function settleColumns(
  trx: Transaction<DB>,
  o: PortOrder,
  { settleAfter, ...rest }: SettleSync,
) {
  const { change, source } = await syncColumns(trx, o, { event: 'PLATFORM_SETTLED', ...rest });
  const current = await orderRow(trx, o);
  const columns = planOrderSyncColumns(
    current,
    unionOrder({ est_commission_fen: null, settle_commission_fen: settleAfter }),
    SETTLED_SYNC,
  );
  await trx
    .updateTable('orders')
    .set({
      settle_commission_fen: columns.settle_commission_fen,
      commission_version: columns.commission_version,
    })
    .where('app_id', '=', o.appId)
    .where('order_id', '=', o.orderId)
    .execute();
  return {
    change: {
      ...change,
      settle_commission_fen: columns.settle_commission_fen,
      commission_moved: columns.commission_version !== current.commission_version,
    },
    source,
  };
}

/** One sync on one transaction: the columns, then settlement's rebate, then the clawback. */
async function syncSettlement(h: Harness, o: Parameters<Harness['target']>[0], spec: SettleSync) {
  const clawback = h.boot();
  return p.db.transaction().execute(async (trx) => {
    const { change, source } = await settleColumns(trx, h.target(o), spec);
    await h.rebate.onUpdated(trx, change, source);
    return clawback.onUpdated(trx, change, source);
  });
}

it(
  '[AC-B2-03q#31][BR-CALC-23][BR-CALC-15] 结算额变化（②）：真实 rebate 与 clawback 走完不抛错，当前版本的金额行与 totals 按新 N 重算，不是复制上一版本',
  async () => {
    const h = await creditedFixture(p.db);
    const o = await h.credited();
    const target = h.target(o);

    const result = await syncSettlement(h, o, { settleAfter: 800n });

    expect(result).toEqual({ outcome: 'skipped', reason: 'not_reverse' });
    expect(await amountsAt(p.db, target, 1)).toEqual([
      ['self', 3683n, 1841n],
      ['direct', 3683n, 368n],
      ['indirect', 3683n, 184n],
    ]);
    expect(await amountsAt(p.db, target, 2)).toEqual([
      ['self', 680n, 340n],
      ['direct', 680n, 68n],
      ['indirect', 680n, 34n],
    ]);
    expect(await totalsAt(p.db, target, 2)).toEqual({
      n_total_fen: 911n,
      pre_base_deduct_fen: 231n,
      base_fen: 680n,
      user_share_total_fen: 442n,
      tlj_redpacket_fen: 0n,
      platform_est_profit_fen: 469n,
    });
    expect(await storedVersions(p.db, target)).toEqual({ amounts: [1, 2], totals: [1, 2] });
  },
  TIMEOUT,
);

it(
  '[AC-B2-03q#32][BR-CALC-23][BR-CALC-15] 结算额变化只推版本和金额行：booked 不变、余额不变、没有新分录，已入账的不动',
  async () => {
    const h = await creditedFixture(p.db);
    const o = await h.credited();
    const money = await moneyRows(p.db, h.appId);

    await syncSettlement(h, o, { settleAfter: 800n });

    expect(await h.rebateColumns(o)).toMatchObject({
      rebate_status: 'CREDITED',
      booked_base_fen: 850n,
      booked_n_fen: 1000n,
    });
    expect(await moneyRows(p.db, h.appId)).toEqual(money);
    expect(await h.clawbackKeys(o)).toEqual([]);
    expect(await h.balance(o.user('self'))).toBe(425n);
    expect(await h.balance(o.user('direct'))).toBe(85n);
    expect(await h.balance(o.user('indirect'))).toBe(42n);
    expect((await h.read(o)).commission_version).toBe(2);
  },
  TIMEOUT,
);

it(
  '[AC-B2-03q#33][BR-FUND-08] 结算额变化之后再部分退款：refresh 加真实 createClawbackOrder 不抛错，金额与 BR-FUND-08 例一致',
  async () => {
    const h = await creditedFixture(p.db);
    const o = await h.credited(FOR_BR_FUND_08);
    const target = h.target(o);
    expect(await h.balance(o.user('self'))).toBe(617n);
    expect(await h.balance(o.user('direct'))).toBe(123n);
    expect((await h.nets(o)).platform_net_fen).toBe(494n);
    expect(await h.rebateColumns(o)).toMatchObject({
      booked_base_fen: 1234n,
      booked_n_fen: 1234n,
    });

    // 结算额两次变化把版本推到 2、3（②）；两次都先 refresh，再由 clawback 读当前版本。
    await syncSettlement(h, o, { settleAfter: 5000n });
    expect(await amountsAt(p.db, target, 2)).toEqual([
      ['self', 5000n, 2500n],
      ['direct', 5000n, 500n],
    ]);
    const clawback = h.boot();
    const result = await p.db.transaction().execute(async (trx) => {
      const { change, source } = await settleColumns(trx, target, {
        settleAfter: 617n,
        refundedQuantityAfter: 1,
      });
      await h.rebate.onUpdated(trx, change, source);
      return clawback.apply(trx, {
        appId: h.appId,
        orderId: o.orderId,
        cause: 'PARTIAL_REFUND',
        ref: { kind: 'commission' },
        newCommissionFen: 617n,
        rightsDeductFen: null,
      });
    });

    expect(await amountsAt(p.db, target, 3)).toEqual([
      ['self', 617n, 308n],
      ['direct', 617n, 61n],
    ]);
    const id = 'C3';
    expect(result).toEqual({
      outcome: 'clawed_back',
      transition: 'R9',
      orderKey: o.orderKey,
      rightsEventId: id,
      bookedBaseFen: 617n,
      bookedNFen: 617n,
    });
    expect(await h.voucherLines(clawbackKey(o, 'self', id))).toEqual(
      userClawbackLines(o, 'self', 309n),
    );
    expect(await h.voucherLines(clawbackKey(o, 'direct', id))).toEqual(
      userClawbackLines(o, 'direct', 62n),
    );
    expect(await h.voucherLines(platformClawbackKey(o, id))).toEqual(
      platformDecreaseLines(o, 246n),
    );
    expect(await h.balance(o.user('self'))).toBe(308n);
    expect(await h.balance(o.user('direct'))).toBe(61n);
    expect(await h.netOf(o, 'self')).toBe(308n);
    expect(await h.netOf(o, 'direct')).toBe(61n);
    expect((await h.nets(o)).platform_net_fen).toBe(248n);
    expect(await h.orderSubjectNet(o, receivable(o))).toBe(617n);
    expect(await h.read(o)).toMatchObject({
      rebate_status: 'CREDITED',
      booked_base_fen: 617n,
      booked_n_fen: 617n,
      commission_version: 3,
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-03q#34][BR-FUND-01] R9：退款未给新佣金时走 WAIT_COMMISSION，结算额不算新佣金（归 R10）；v2 行来自结算变化，按新 N，也不因版本前进抛错',
  async () => {
    const h = await creditedFixture(p.db);
    const o = await h.credited();

    const result = await syncSettlement(h, o, { settleAfter: 800n, refundedQuantityAfter: 1 });

    expect(result).toMatchObject({ outcome: 'wait_commission', orderKey: o.orderKey });
    expect(await h.clawbackKeys(o)).toEqual([]);
    expect(await storedVersions(p.db, h.target(o))).toEqual({ amounts: [1, 2], totals: [1, 2] });
    expect(await amountsAt(p.db, h.target(o), 2)).toEqual([
      ['self', 680n, 340n],
      ['direct', 680n, 68n],
      ['indirect', 680n, 34n],
    ]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-03q#35] 已入账单 refresh 本身什么账都不动：orders、分录、余额、义务、事件逐行相同，只多当前版本的行',
  async () => {
    const h = await creditedFixture(p.db);
    const o = await h.credited();
    const target = h.target(o);
    await h.move(o, { estAfter: 2000n });
    const before = await h.state();

    await p.db
      .transaction()
      .execute((trx) =>
        h.estimates.refresh(trx, { appId: h.appId, orderId: o.orderId, attrAt: o.attrAt }),
      );

    expect(await h.state()).toEqual(before);
    expect(await storedVersions(p.db, target)).toEqual({ amounts: [1, 2], totals: [1, 2] });
  },
  TIMEOUT,
);

it(
  '[AC-B2-03q#36] 已入账单同一版本 refresh 两次：不报错、不多行，第一次的行不变',
  async () => {
    const h = await creditedFixture(p.db);
    const o = await h.credited();
    const target = h.target(o);
    await h.move(o, { estAfter: 2000n });
    const ref = { appId: h.appId, orderId: o.orderId, attrAt: o.attrAt };

    await p.db.transaction().execute((trx) => h.estimates.refresh(trx, ref));
    const rows = await amountRows(p.db, target);
    h.clock.set(LATER);
    await p.db.transaction().execute((trx) => h.estimates.refresh(trx, ref));

    expect(await amountRows(p.db, target)).toEqual(rows);
    expect(await storedVersions(p.db, target)).toEqual({ amounts: [1, 2], totals: [1, 2] });
  },
  TIMEOUT,
);

it(
  '[AC-B2-03q#37][BR-FUND-01] 上一版本 = 库内最大版本：跳号时不补中间版本，N 已知按新 N 重算，后来的没收按 0 算，null 面额保持 null',
  async () => {
    const f = await fixture(p.db);
    const o = await f.order({
      rebateStatus: 'CREDITED',
      platformStatus: 'SETTLED',
      estFen: 9000n,
      settleFen: 8000n,
      commissionVersion: 4,
      redpacketFen: null,
      patch: { booked_base_fen: 1700n, booked_n_fen: 2000n },
    });
    await f.version(o, {
      version: 2,
      nTotalFen: 2000n,
      baseFen: 1700n,
      amounts: [850n, 170n, 85n],
      redpacketFen: null,
    });
    await f.event(o, 'direct', 'forfeited', 'banned');

    await f.refresh(o);

    expect(await storedVersions(p.db, o)).toEqual({ amounts: [1, 2, 4], totals: [1, 2, 4] });
    expect(await amountsAt(p.db, o, 4)).toEqual([
      ['self', 6800n, 3400n],
      ['direct', 6800n, 0n],
      ['indirect', 6800n, 340n],
    ]);
    expect(await totalsAt(p.db, o, 4)).toEqual({
      n_total_fen: 8000n,
      pre_base_deduct_fen: 1200n,
      base_fen: 6800n,
      user_share_total_fen: 3740n,
      tlj_redpacket_fen: null,
      platform_est_profit_fen: null,
    });
  },
  TIMEOUT,
);
