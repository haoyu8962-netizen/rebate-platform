// B1-08zi（D10-814 ④ ⑥，BR-FUND-01「R9 与 R9b 的判定」）：京东 CREDITED 订单经 settlement 真实的同步更新入口
// （clawback onUpdated；入账由 B2-04m 真实入账服务完成，见 ../clawback/kit.ts）。入账时已退 1 件 → 定格 1；同步
// 带来已退 1 → 2，开关 orders.jd.refunded_quantity_r9_enabled 经入口的 config 端口读取：
// - 未配置、false：不作为 R9 触发——不扣回、不写凭证、余额与 booked 不变、不进待处理，写一条带 alert 字段的告警；
//   其余判定照常（同一次同步带来新结算记录的，照 R10 走 SETTLE_ADJUST，不是 R9 的 CLAWBACK）。
// - true：照现行 R9——没有新佣金来源 → ③ WAIT_COMMISSION（AC-B2-04s#41 同口径）；带新结算 600 → R9 按 600 扣回
//   （sub_type PART_REFUND）。
// 只把判定函数写好而没接进 onUpdated 的实现，在未配置 / false 两例上仍按 R9 走，必须红。
// 金额（kit 默认）：N 1000、reserve 1500 → B 850，self 5000 / direct 1000 / indirect 500 → 425 / 85 / 42，平台 448。
// N 600 → B 510、预留 90 → 255 / 51 / 25，平台 179 + 90 = 269：扣回 170 / 34 / 17，平台差额 179。
// Task-local AC labels ([AC-B1-08zi#n]) identify this task's acceptance points, not business rules.
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  lockOrderKey,
  type OrderStatusSource,
  type OrderUpdateChange,
} from '../../../../apps/api/src/modules/orders/index.ts';
import type { ClawbackResult } from '../../../../apps/api/src/modules/settlement/clawback/index.ts';
import { createSettlementRecords } from '../../../../apps/api/src/modules/settlement/settlements/index.ts';
import {
  TIMEOUT,
  clawbackKey,
  databaseFixture,
  harness,
  platformClawbackKey,
  platformDecreaseLines,
  receivable,
  userClawbackLines,
  type Harness,
  type SeededOrder,
} from '../clawback/kit.ts';

const p = databaseFixture(createTestDatabase);

const SWITCH = 'orders.jd.refunded_quantity_r9_enabled';
const ROLES = ['self', 'direct', 'indirect'] as const;

/** A jd order credited by the real credit service with 1 of 3 items already refunded. */
async function creditedJd(h: Harness): Promise<SeededOrder> {
  const o = await h.credited({ platform: 'jd', patch: { quantity: 3, refunded_quantity: 1 } });
  expect(await h.read(o)).toMatchObject({
    rebate_status: 'CREDITED',
    quantity: 3,
    refunded_quantity: 1,
    refunded_quantity_at_credit: 1,
  });
  return o;
}

/**
 * A jd order whose only settlement record is an API one (no STATEMENT), so a later API record of
 * the sync decides the amount (BR-FUND-09); credited by the real credit service with 1 item refunded.
 */
async function creditedJdApiOnly(h: Harness): Promise<SeededOrder> {
  const o = await h.order({
    platform: 'jd',
    seqs: [],
    patch: { quantity: 3, refunded_quantity: 1, settle_commission_fen: 1000n },
  });
  await p.db
    .insertInto('order_settlements')
    .values({
      app_id: h.appId,
      order_id: o.orderId,
      seq: 1,
      source: 'API',
      settle_commission_fen: 1000n,
      settled_at: o.attrAt,
      content_hash: randomUUID(),
      created_at: o.attrAt,
    })
    .execute();
  expect(await h.credit(o)).toMatchObject({ outcome: 'credited' });
  expect(await h.read(o)).toMatchObject({
    rebate_status: 'CREDITED',
    booked_base_fen: 850n,
    booked_n_fen: 1000n,
    refunded_quantity: 1,
    refunded_quantity_at_credit: 1,
  });
  return o;
}

/** Everything a clawback of this order may write, for before / after comparisons. */
async function money(h: Harness, o: SeededOrder) {
  return {
    keys: await h.orderVoucherKeys(o),
    lines: (await h.lines()).filter((l) => l.uniq_key.startsWith(`${o.orderKey}:`)),
    balances: await Promise.all(ROLES.map((role) => h.balance(o.user(role)))),
    rebate: await h.rebateColumns(o),
    obligations: await h.orderObligations(o),
    candidates: await h.candidates(o),
    pending: await h.pendingRows(o),
    diffs: await h.reconDiffs(),
    clawedBack: (await h.published()).filter((e) => e.name === 'order.clawed_back'),
  };
}

/** Warn lines (pino level 40) carrying an `alert` field and app_id that name this sub-order. */
function alertsFor(h: Harness, o: SeededOrder): Record<string, unknown>[] {
  return h.logs.filter(
    (line) =>
      line['level'] === 40 &&
      typeof line['alert'] === 'string' &&
      line['app_id'] === h.appId &&
      Object.values(line).some(
        (v) => typeof v === 'string' && (v === o.orderId || v.includes(o.subOrderId)),
      ),
  );
}

function setSwitch(h: Harness, value: boolean | undefined): void {
  if (value === undefined) h.configValues.delete(SWITCH);
  else h.configValues.set(SWITCH, value);
}

/**
 * The orders sync step on one transaction, with a new union settlement amount: order_key lock, the
 * API settlement record through settlement's record port (the record that decides the amount on
 * this transaction), the orders columns (settle_commission_fen, refunded_quantity, row_version + 1),
 * then onUpdated with the change, as ../clawback/kit.ts sync does for the other columns.
 */
async function syncSettlement(
  h: Harness,
  o: SeededOrder,
  refundedAfter: number,
  settleFen: bigint,
): Promise<ClawbackResult> {
  const clawback = h.boot();
  const records = createSettlementRecords({ clock: h.clock });
  return p.db.transaction().execute(async (trx) => {
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
      commissionFen: settleFen,
      reportedSettledAt: null,
      orderSettledAt: before.settled_at,
    });
    expect(written).toMatchObject({ inserted: true, seq: 2 });
    await trx
      .updateTable('orders')
      .set({
        settle_commission_fen: settleFen,
        refunded_quantity: refundedAfter,
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
      settle_commission_fen: settleFen,
      attributed_now: false,
    };
    const source: OrderStatusSource = { event: 'PLATFORM_SETTLED', raw_status: 'synthetic' };
    return clawback.onUpdated(trx, change, source);
  });
}

/** The order's lines of one ledger_type. */
async function linesOfType(h: Harness, o: SeededOrder, type: string) {
  return (await h.lines()).filter(
    (l) => l.uniq_key.startsWith(`${o.orderKey}:`) && l.ledger_type === type,
  );
}

it.each([
  ['未配置', undefined],
  ['false', false],
] as const)(
  '[AC-B1-08zi#32] 京东 CREDITED、已退 1 → 2、开关%s：onUpdated 不扣回，凭证、分录、余额、booked、义务与待处理都不变，写告警',
  async (_name, value) => {
    const h = await harness(p.db);
    const o = await creditedJd(h);
    setSwitch(h, value);
    const before = await money(h, o);
    expect(alertsFor(h, o)).toEqual([]);

    const { result } = await h.sync(o, { event: 'PLATFORM_SETTLED', refundedQuantityAfter: 2 });

    expect(result).toMatchObject({ outcome: 'skipped' });
    expect(await money(h, o)).toEqual(before);
    expect(before.rebate).toMatchObject({
      rebate_status: 'CREDITED',
      booked_base_fen: 850n,
      booked_n_fen: 1000n,
    });
    expect(await h.read(o)).toMatchObject({
      refunded_quantity: 2,
      refunded_quantity_at_credit: 1,
    });
    expect(h.openPending).not.toHaveBeenCalled();
    expect(h.configGet).toHaveBeenCalledWith(h.appId, SWITCH);
    expect(alertsFor(h, o).length).toBeGreaterThan(0);
  },
  TIMEOUT,
);

it(
  '[AC-B1-08zi#33] 京东 CREDITED、已退 1 → 2、开关 true：照现行 R9，无新佣金来源 → ③ WAIT_COMMISSION（待处理 CLAWBACK_NO_COMMISSION），不写凭证',
  async () => {
    const h = await harness(p.db);
    const o = await creditedJd(h);
    setSwitch(h, true);
    const keys = await h.orderVoucherKeys(o);

    const { result } = await h.sync(o, { event: 'PLATFORM_SETTLED', refundedQuantityAfter: 2 });

    expect(result).toMatchObject({ outcome: 'wait_commission', orderKey: o.orderKey });
    expect(await h.orderVoucherKeys(o)).toEqual(keys);
    expect(await h.pendingRows(o)).toEqual([
      expect.objectContaining({ reason: 'CLAWBACK_NO_COMMISSION', status: 'open' }),
    ]);
    expect(await h.read(o)).toMatchObject({
      rebate_status: 'CREDITED',
      booked_base_fen: 850n,
      booked_n_fen: 1000n,
      refunded_quantity: 2,
      refunded_quantity_at_credit: 1,
    });
    expect(h.configGet).toHaveBeenCalledWith(h.appId, SWITCH);
  },
  TIMEOUT,
);

it(
  '[AC-B1-08zi#34] 京东 CREDITED、同一次同步已退 1 → 2 且新结算 600、开关 true：R9 按 600 扣回 170 / 34 / 17 + 平台 179（PART_REFUND），不走 R10',
  async () => {
    const h = await harness(p.db);
    const o = await creditedJdApiOnly(h);
    setSwitch(h, true);

    const result = await syncSettlement(h, o, 2, 600n);

    const row = await h.read(o);
    const id = `C${String(row.commission_version)}`;
    expect(result).toMatchObject({
      outcome: 'clawed_back',
      transition: 'R9',
      orderKey: o.orderKey,
      rightsEventId: id,
      bookedBaseFen: 510n,
      bookedNFen: 600n,
    });
    expect(await h.clawbackKeys(o)).toEqual(
      [...ROLES.map((role) => clawbackKey(o, role, id)), platformClawbackKey(o, id)].sort(),
    );
    expect(await h.voucherLines(clawbackKey(o, 'self', id))).toEqual(
      userClawbackLines(o, 'self', 170n),
    );
    expect(await h.voucherLines(clawbackKey(o, 'direct', id))).toEqual(
      userClawbackLines(o, 'direct', 34n),
    );
    expect(await h.voucherLines(clawbackKey(o, 'indirect', id))).toEqual(
      userClawbackLines(o, 'indirect', 17n),
    );
    expect(await h.voucherLines(platformClawbackKey(o, id))).toEqual(
      platformDecreaseLines(o, 179n),
    );
    for (const key of await h.clawbackKeys(o)) {
      expect(await h.voucherTypes(key), key).toEqual(['CLAWBACK|PART_REFUND']);
    }
    expect(await linesOfType(h, o, 'SETTLE_ADJUST')).toEqual([]);
    expect(await Promise.all(ROLES.map((role) => h.balance(o.user(role))))).toEqual([
      255n,
      51n,
      25n,
    ]);
    expect(await h.orderSubjectNet(o, receivable(o))).toBe(600n);
    expect(row).toMatchObject({
      rebate_status: 'CREDITED',
      booked_base_fen: 510n,
      booked_n_fen: 600n,
      diff_reason_code: 'PART_REFUND',
      refunded_quantity: 2,
      refunded_quantity_at_credit: 1,
    });
  },
  TIMEOUT,
);

it(
  '[AC-B1-08zi#35] 京东 CREDITED、同一次同步已退 1 → 2 且新结算 600、开关 false：已退件数不触发 R9，其余判定照常 → R10 SETTLE_ADJUST，没有 CLAWBACK，写告警',
  async () => {
    const h = await harness(p.db);
    const o = await creditedJdApiOnly(h);
    setSwitch(h, false);

    const result = await syncSettlement(h, o, 2, 600n);

    expect(result).toMatchObject({
      outcome: 'settle_adjusted',
      transition: 'R10',
      bookedBaseFen: 510n,
      bookedNFen: 600n,
    });
    expect(await h.clawbackKeys(o)).toEqual([]);
    expect(await linesOfType(h, o, 'CLAWBACK')).toEqual([]);
    const adjusted = await linesOfType(h, o, 'SETTLE_ADJUST');
    expect(adjusted.length).toBeGreaterThan(0);
    expect(adjusted.every((l) => l.uniq_key.endsWith(':ADJ:2'))).toBe(true);
    expect(await Promise.all(ROLES.map((role) => h.balance(o.user(role))))).toEqual([
      255n,
      51n,
      25n,
    ]);
    expect(await h.read(o)).toMatchObject({
      rebate_status: 'CREDITED',
      booked_base_fen: 510n,
      booked_n_fen: 600n,
      refunded_quantity: 2,
      refunded_quantity_at_credit: 1,
    });
    expect((await h.read(o)).diff_reason_code).not.toBe('PART_REFUND');
    expect((await h.published()).filter((e) => e.name === 'order.clawed_back')).toEqual([]);
    expect(h.configGet).toHaveBeenCalledWith(h.appId, SWITCH);
    expect(alertsFor(h, o).length).toBeGreaterThan(0);
  },
  TIMEOUT,
);
