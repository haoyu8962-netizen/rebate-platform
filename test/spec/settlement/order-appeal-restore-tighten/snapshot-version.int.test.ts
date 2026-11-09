// B2-09ge regression rule test (claude-independent, 编排 D10-1135): 08 BR-CALC-10 (R12 时点), BR-FUND-22 R12.
// R12 makes up the snapshot of an order with no commission_splits row, whatever orders.commission_version
// says: the sync moves that column on a VOID order that never had a snapshot (planOrderSyncColumns,
// BR-CALC-15), so commission_version >= 1 does not mean a snapshot exists. Skipping on the version left
// the order restored with nothing to settle against ('settlement credit: order has no commission snapshot').
// Real pieces: the admin restore entry and the settle handler the production worker registered.
// Synthetic: the order as ../order-appeal-restore/kit.ts seeds it, then the columns the sync's CAS would
// have written while it was VOID (below), written directly. The commission's amount tables stay empty,
// as they do on that path: the sync's refresh writes nothing for an order without a snapshot.
// Expected amounts by hand: BR-CALC-02 B = floor(N × (10000 − reserve_bp) / 10000), BR-CALC-04
// floor(B × ratio / 10000); the platform gets N less the shares. Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import {
  available,
  fixture,
  netOf,
  netsOf,
  suite,
  withRestoreAdmin,
  type RestoreFixture,
} from '../admin-recon-restore/kit.ts';
import {
  PAID_AT,
  RECEIVED_AT,
  TIMEOUT,
  pendingOf,
  seedAppealDiff,
  seedRules,
  seedVoid,
  settleOrder,
  splitsOf,
  withWorker,
  type VoidOrder,
} from '../order-appeal-restore/kit.ts';
import { orderRow, platformRestored } from '../platform-restore/kit.ts';

const s = suite();

/** What the sync reports for the order while it is VOID. */
const SYNCED_EST = 1000n;

/**
 * The sync's CAS on a VOID order whose commission moved (est 800 → 1000): commission_version 0 → 1 with
 * row_version + 1 (update-step.ts, planOrderSyncColumns). No snapshot is made on this path. The returned
 * order carries the new amount, which the producer would read when it registers the difference.
 */
async function moveCommissionWhileVoid(f: RestoreFixture, order: VoidOrder): Promise<VoidOrder> {
  const before = await orderRow(f, order.orderId);
  expect(before).toMatchObject({
    rebate_status: 'VOID',
    reason: 'BLACKLIST',
    commission_version: 0,
    est_commission_fen: 800n,
  });
  await f.db
    .updateTable('orders')
    .set({
      est_commission_fen: SYNCED_EST,
      commission_version: 1,
      row_version: before.row_version + 1,
      updated_at: f.clock.now(),
    })
    .where('app_id', '=', f.appId)
    .where('order_id', '=', order.orderId)
    .execute();
  expect(await orderRow(f, order.orderId)).toMatchObject({
    rebate_status: 'VOID',
    commission_version: 1,
    est_commission_fen: SYNCED_EST,
  });
  expect(await splitsOf(f, order.orderId), 'no snapshot before the restore').toEqual([]);
  return { ...order, commissionFen: SYNCED_EST };
}

/** The order's stored amount rows (BR-CALC-27), as the settlement's version read needs them. */
function amountsOf(f: RestoreFixture, orderId: string) {
  return f.db
    .selectFrom('commission_split_amounts')
    .select(['commission_version', 'user_id', 'role', 'base_fen', 'amount_fen'])
    .where('app_id', '=', f.appId)
    .where('order_id', '=', orderId)
    .execute();
}

it(
  '[AC-B2-09ge#1] 主线：作废期间同步改过佣金（commission_version 1）而从未有快照的已结算单，撤销的订单申诉经后台入口恢复后回 WAITING，同事务补 commission_splits（commission_version 不是「有快照」的依据）；之后走 worker 真实 settle 入口能入账、不抛 no commission snapshot：N 1000、预留 1500 → B 850，self 5000 → 425 入账、平台 575',
  async () => {
    const f = await fixture(s);
    await seedRules(f, { ownBp: 5000, reserveBp: 1500 });
    const order = await moveCommissionWhileVoid(
      f,
      await seedVoid(f, {
        est: 800n,
        settle: 1000n,
        platformStatus: 'SETTLED',
        receivedAt: RECEIVED_AT,
      }),
    );
    const diff = await seedAppealDiff(f, order);

    await withRestoreAdmin(f, async (h) => {
      const data = await platformRestored(await h.restore(diff.id));
      expect(data.rebate_status_after).toBe('WAITING');
      expect(data.restored_fen).toBe(0);
      expect(await orderRow(f, order.orderId)).toMatchObject({
        rebate_status: 'WAITING',
        settle_period: '2026-10',
        commission_version: 1,
      });
      const splits = await splitsOf(f, order.orderId);
      expect(splits, 'R12 made the snapshot on version 1').toHaveLength(1);
      expect(splits[0]).toMatchObject({
        rule_version_id: f.ruleVersionId,
        order_type: 'self',
        paid_at: PAID_AT,
        paid_at_source: 'platform',
        raw_n_fen: 1000n,
        reserve_bp: 1500,
        reserve_fen: 150n,
        base_fen: 850n,
      });
      expect(JSON.parse(JSON.stringify(splits[0]!.beneficiaries))).toMatchObject([
        { user_id: order.userId, role: 'self', ratio_bp: 5000 },
      ]);
      expect(await amountsOf(f, order.orderId)).toEqual([
        {
          commission_version: 1,
          user_id: order.userId,
          role: 'self',
          base_fen: 850n,
          amount_fen: 425n,
        },
      ]);
      expect(await pendingOf(f, order.orderId)).toEqual([]);

      const item = await withWorker(f, (worker) =>
        settleOrder(f, worker, order, { adminId: h.operator.id, settleFen: 850n }),
      );
      expect(item).toEqual({ result: 'credited', skip_reason: null });
      expect(await orderRow(f, order.orderId)).toMatchObject({
        rebate_status: 'CREDITED',
        commission_version: 1,
        booked_base_fen: 850n,
        booked_n_fen: 1000n,
      });
      expect(await available(f, order.userId!)).toBe(425n);
      const nets = await netsOf(f, order.orderKey);
      expect(netOf(nets, order.userId!, 'self')).toBe(425n);
      expect(nets.platform_net_fen).toBe(575n);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-09ge#1] 已付款未结算的同形单（PAID、est 800 → 1000、commission_version 1、无快照）恢复回 ESTIMATED，同事务按同步后的预估补快照：N 1000 而不是 800，预留 1500 → B 850，commission_version 仍是 1，无待处理行',
  async () => {
    const f = await fixture(s);
    await seedRules(f, { ownBp: 5000, reserveBp: 1500 });
    const order = await moveCommissionWhileVoid(f, await seedVoid(f, { est: 800n }));
    const diff = await seedAppealDiff(f, order);

    await withRestoreAdmin(f, async (h) => {
      const data = await platformRestored(await h.restore(diff.id));
      expect(data.rebate_status_after).toBe('ESTIMATED');
      expect(await orderRow(f, order.orderId)).toMatchObject({
        rebate_status: 'ESTIMATED',
        commission_version: 1,
      });
      const splits = await splitsOf(f, order.orderId);
      expect(splits).toHaveLength(1);
      expect(splits[0]).toMatchObject({
        rule_version_id: f.ruleVersionId,
        raw_n_fen: 1000n,
        reserve_bp: 1500,
        reserve_fen: 150n,
        base_fen: 850n,
      });
      expect(await amountsOf(f, order.orderId)).toEqual([
        {
          commission_version: 1,
          user_id: order.userId,
          role: 'self',
          base_fen: 850n,
          amount_fen: 425n,
        },
      ]);
      expect(await pendingOf(f, order.orderId)).toEqual([]);
    });
  },
  TIMEOUT,
);
