// B2-04zzf 第 2 次规则测试（money r1 S2，编排 D10-918 ②）：已退件数增加而没有新结算记录时等联盟佣金（开
// CLAWBACK_NO_COMMISSION 待处理）；之后来一条金额不变、结算时间变化的新结算记录，R9 结果无变化——这时只推基线，
// 还要在同一事务关闭那张待处理（同 R9 扣回出口的 closeAnsweredRights），否则之后普通 R10 也不关，订单一直显示待处理。
//
// 依据（08 06_FUND，SPEC_REF b79958d）：
// - BR-FUND-08 正文 ③：「③都没有 → 不写扣回，order_rights 置 WAIT_COMMISSION，订单进待处理表并告警，等联盟的新佣金或
//   应扣佣金，不按我方估算先扣（负责人 2026-10-03 资金规则对齐决-03 选 A）。」
// - BR-FUND-06：「联盟新佣金与应扣佣金都没有时，order_rights 置 WAIT_COMMISSION（仍阻止入账），等联盟回传新佣金后按 R7/R9
//   处理并关闭（入账后新结算记录回应待佣金维权见 BR-FUND-08 细则 D10-474 ②，按 R10 SETTLE_ADJUST 处理）」；BR-FUND-08 细则
//   D10-474 ②：「…按结算调整（R10 SETTLE_ADJUST，BR-CALC-23 (a)）处理，并在同一事务关闭该待佣金维权记录」。
// - BR-FUND-01 细则「已处置退件数」（D10-870）：「BR-FUND-08 ③ 等联盟佣金（WAIT_COMMISSION）时不推进，下一条新结算记录
//   仍按 R9 处理并关闭那张待处理」；R9 重算差额为 0（无变化）也是按 R9 处理，同额新结算同样关闭那张
//   CLAWBACK_NO_COMMISSION 待处理（编排 D10-918 ② / D10-919）。
//
// #11 走生产装配的 worker（pdd，预留 0、会员本人 50%：1000 → 800 是 R10 各扣 100）。
// #12 走 B2-04l 维权 harness（真实维权命令、真实入账、真实 clawback；N 1000、预留 1500 → B 850）：前半段是第 2 条
//   （等佣金的维权被同额新结算记录回应、同一次同步退件也增加 → 无变化：维权按现有口径关闭、基线推进，之后无内容变化的
//   同步不再走 R9）；后半段与新行为成对：同一订单再退一件而无新结算 → 再等联盟佣金、开待处理；同额新结算记录来时
//   R9 无变化 → 待处理关闭、基线推进。新结算记录经 settlement 的结算记录端口写成决定金额的 API 记录。
// Task-local AC labels ([AC-B2-04zzf#n]) identify this task's acceptance points, not business rules.
import type { DB } from '@couli/db';
import { createTestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { expect, it } from 'vitest';
import {
  lockOrderKey,
  type OrderStatusSource,
  type OrderUpdateChange,
} from '../../../../apps/api/src/modules/orders/index.ts';
import type { ClawbackResult } from '../../../../apps/api/src/modules/settlement/clawback/index.ts';
import { createSettlementRecords } from '../../../../apps/api/src/modules/settlement/settlements/index.ts';
import { TIMEOUT as HARNESS_TIMEOUT, type Harness, type SeededOrder } from '../clawback/kit.ts';
import {
  TIMEOUT,
  creditedWith,
  databaseFixture,
  settled,
  touched,
  withSync,
} from '../credit-refund-baseline/kit.ts';
import { LATER } from '../rights-credit/kit.ts';
import { harness as rightsHarness } from '../rights/kit.ts';
import { SETTLED_LATER } from '../settle-diff-sync/kit.ts';
import {
  ALERT_WAIT,
  ROLES,
  alertsFor,
  baselineOf,
  clawbackKeysOf,
  clawedBackEvents,
  creditedApiOnly,
  pendingOf,
} from './kit.ts';

const p = databaseFixture(createTestDatabase);

const WAIT_REASON = 'CLAWBACK_NO_COMMISSION';
const OPEN = { reason: WAIT_REASON, status: 'open' };
const RESOLVED = { reason: WAIT_REASON, status: 'resolved' };
/** A day after LATER (the second round of #12). */
const LATER_2 = '2032-07-27T10:00:00+08:00';

/** CLAWBACK_NO_COMMISSION rows of one sub-order, as { reason, status }. */
async function waitRows(appId: string, subOrderId: string) {
  return (await pendingOf(p.db, appId, subOrderId)).filter((r) => r.reason === WAIT_REASON);
}

/** The open ones of waitRows. */
async function openWaits(appId: string, subOrderId: string) {
  return (await waitRows(appId, subOrderId)).filter((r) => r.status === 'open');
}

interface RecordAtSpec {
  readonly refundedAfter: number;
  readonly settleFen: bigint;
  /** The union's settlement time as reported (an equal amount at another time is a new record). */
  readonly reportedAt: Date;
}

/**
 * The orders sync step on one transaction (as ./kit.ts syncWithRecord, with the reported settlement
 * time): order_key lock, the API record through settlement's record port, the orders columns
 * (settle_commission_fen, refunded_quantity, row_version + 1), then the clawback's onUpdated.
 */
async function syncRecordAt(
  db: Kysely<DB>,
  h: Harness,
  o: SeededOrder,
  spec: RecordAtSpec,
): Promise<ClawbackResult> {
  const clawback = h.boot();
  const records = createSettlementRecords({ clock: h.clock });
  return db.transaction().execute(async (trx) => {
    await lockOrderKey(trx, o.platform, o.subOrderId);
    const before = await trx
      .selectFrom('orders')
      .selectAll()
      .where('app_id', '=', h.appId)
      .where('order_id', '=', o.orderId)
      .executeTakeFirstOrThrow();
    const written = await records.recordApi(trx, {
      appId: h.appId,
      orderId: o.orderId,
      commissionFen: spec.settleFen,
      reportedSettledAt: spec.reportedAt,
      orderSettledAt: before.settled_at,
    });
    expect(written).toMatchObject({ inserted: true });
    await trx
      .updateTable('orders')
      .set({
        settle_commission_fen: spec.settleFen,
        refunded_quantity: spec.refundedAfter,
        row_version: before.row_version + 1,
        updated_at: h.clock.now(),
      })
      .where('app_id', '=', h.appId)
      .where('order_id', '=', o.orderId)
      .execute();
    const change: OrderUpdateChange = {
      app_id: h.appId,
      order_id: o.orderId,
      attr_at: before.attr_at,
      from_status: before.platform_status,
      to_status: before.platform_status,
      rule: 'P15',
      received_at: before.received_at,
      est_before: before.est_commission_fen,
      est_after: before.est_commission_fen,
      settle_commission_fen: spec.settleFen,
      attributed_now: false,
    };
    const source: OrderStatusSource = { event: 'PLATFORM_SETTLED', raw_status: 'synthetic' };
    return clawback.onUpdated(trx, change, source);
  });
}

it(
  '[AC-B2-04zzf#11] 已退 0 → 1 而无新结算记录 → 等联盟佣金、开 CLAWBACK_NO_COMMISSION 待处理；随后同额新结算记录（1000、结算时间变）→ R9 无变化、钱不动，同一次同步关闭待处理、基线推到 1；之后新结算 800 → R10 ADJ:3 各扣 100，不再有待处理',
  async () => {
    await withSync(p.db, async (w, logs) => {
      const { app, o, read } = await creditedWith(p.db, w, { quantity: 4, refunded_quantity: 0 });
      const orderId = (await o.row()).order_id;
      const before = await read.money();

      await o.sync(settled(1000n, { ...touched(1), refunded_quantity: 1 }));

      expect((await o.records()).map((r) => r.seq)).toEqual([1]);
      expect(await waitRows(app.appId, o.subOrderId)).toEqual([OPEN]);
      expect(logs).toContainEqual(
        expect.objectContaining({ level: 40, alert: ALERT_WAIT, app_id: app.appId }),
      );
      expect(await baselineOf(p.db, app.appId, orderId)).toBeNull();

      await o.sync(
        settled(1000n, { ...touched(2), refunded_quantity: 1, settled_at: SETTLED_LATER }),
      );

      expect((await o.records()).map((r) => r.seq)).toEqual([1, 2]);
      expect(await read.money()).toEqual(before);
      expect(await o.row()).toMatchObject({
        rebate_status: 'CREDITED',
        booked_base_fen: 1000n,
        booked_n_fen: 1000n,
        refunded_quantity: 1,
        refunded_quantity_at_credit: 0,
      });
      expect(await waitRows(app.appId, o.subOrderId)).toEqual([RESOLVED]);
      expect(await baselineOf(p.db, app.appId, orderId)).toBe(1);

      await o.sync(
        settled(800n, { ...touched(3), refunded_quantity: 1, settled_at: SETTLED_LATER }),
      );

      await read.adjustment(3, 100n, 100n);
      expect(clawbackKeysOf(await read.lines())).toEqual([]);
      expect(await o.row()).toMatchObject({
        rebate_status: 'CREDITED',
        booked_base_fen: 800n,
        booked_n_fen: 800n,
      });
      expect((await read.history()).map((r) => r.event)).toEqual(['SETTLE_NEGATIVE_DIFF']);
      expect(await clawedBackEvents(p.db, app.appId)).toEqual([]);
      expect(await waitRows(app.appId, o.subOrderId)).toEqual([RESOLVED]);
      expect(await baselineOf(p.db, app.appId, orderId)).toBe(1);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zzf#12] 等佣金的维权 + 同一次同步已退 0 → 1 且同额新结算记录：无变化，维权按现有口径关闭（SUCCEEDED、rights_pending 解除、待处理关闭）、基线推到 1，之后无内容变化的同步不走 R9；再退一件（1 → 2）而无新结算 → 等联盟佣金、开待处理、基线仍 1；同额新结算记录来时 R9 无变化 → 待处理关闭、基线推到 2，钱始终不动',
  async () => {
    const h = await rightsHarness(p.db);
    const o = await creditedApiOnly(p.db, h, { quantity: 3, refunded: 0 });
    expect(await h.record(o, { deductionFen: null })).toEqual({ kind: 'applied' });
    const waiting = await h.onlyRights(o);
    expect(waiting).toMatchObject({ status: 'WAIT_COMMISSION' });
    expect((await h.read(o)).rights_pending).toBe(true);
    expect(await waitRows(h.appId, o.subOrderId)).toEqual([OPEN]);

    const balancesOf = () => Promise.all(ROLES.map((role) => h.balance(o.user(role))));
    const keys = await h.orderVoucherKeys(o);
    const balances = await balancesOf();
    const expectMoneyUnchanged = async () => {
      expect(await h.orderVoucherKeys(o)).toEqual(keys);
      expect(await balancesOf()).toEqual(balances);
      expect(await h.read(o)).toMatchObject({
        rebate_status: 'CREDITED',
        booked_base_fen: 850n,
        booked_n_fen: 1000n,
        refunded_quantity_at_credit: 0,
      });
    };

    // 第 2 条：维权被同额新结算记录回应，同一次同步已退 0 → 1。
    h.clock.set(LATER);
    const answered = await syncRecordAt(p.db, h, o, {
      refundedAfter: 1,
      settleFen: 1000n,
      reportedAt: new Date(LATER),
    });

    expect(answered).toMatchObject({ outcome: 'no_change' });
    await expectMoneyUnchanged();
    expect(await h.onlyRights(o)).toMatchObject({ id: waiting.id, status: 'SUCCEEDED' });
    expect((await h.read(o)).rights_pending).toBe(false);
    expect(await waitRows(h.appId, o.subOrderId)).toEqual([RESOLVED]);
    expect(await baselineOf(p.db, h.appId, o.orderId)).toBe(1);

    const quiet = await h.sync(o, { event: 'PLATFORM_SETTLED' });

    expect(quiet.result).toMatchObject({ outcome: 'skipped' });
    expect(await openWaits(h.appId, o.subOrderId)).toEqual([]);
    expect(await baselineOf(p.db, h.appId, o.orderId)).toBe(1);

    // 与新行为成对：再退一件而无新结算 → 等联盟佣金；同额新结算记录来时 R9 无变化 → 关闭待处理。
    h.clock.set(LATER_2);
    const waitAlerts = alertsFor(h, o, ALERT_WAIT).length;
    const again = await h.sync(o, { event: 'PLATFORM_SETTLED', refundedQuantityAfter: 2 });

    expect(again.result).toMatchObject({ outcome: 'wait_commission' });
    await expectMoneyUnchanged();
    expect(alertsFor(h, o, ALERT_WAIT)).toHaveLength(waitAlerts + 1);
    expect(await openWaits(h.appId, o.subOrderId)).toEqual([OPEN]);
    expect(await baselineOf(p.db, h.appId, o.orderId)).toBe(1);

    const unchanged = await syncRecordAt(p.db, h, o, {
      refundedAfter: 2,
      settleFen: 1000n,
      reportedAt: new Date(LATER_2),
    });

    expect(unchanged).toMatchObject({ outcome: 'no_change' });
    await expectMoneyUnchanged();
    expect(await h.read(o)).toMatchObject({ refunded_quantity: 2, rights_pending: false });
    expect(await h.onlyRights(o)).toMatchObject({ id: waiting.id, status: 'SUCCEEDED' });
    expect(await waitRows(h.appId, o.subOrderId)).toEqual([RESOLVED, RESOLVED]);
    expect(await baselineOf(p.db, h.appId, o.orderId)).toBe(2);
  },
  HARNESS_TIMEOUT,
);
