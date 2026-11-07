// B1-08zi（D10-814 ② ③）：orders 的件数两列 quantity / refunded_quantity 的写入计划。
// 本次报文没给（缺键或 null）→ 沿用库内值；给了且不小于库内值（库内为空也算）→ 写新值；小于库内值 → 不写、
// 保留库内值并给出告警。只看这两个字段：不看平台，不用淘宝 refund_tag / item_num、拼多多 return_status 推算。
// 只有数量变化时 commission_version 不加 1（BR-CALC-15 / D10-578），两列也不进 OrderSyncColumns。
// Task-local AC labels ([AC-B1-08zi#n]) identify this task's acceptance points, not business rules.
import { propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import {
  planOrderQuantities,
  planOrderSyncColumns,
  type OrderQuantityColumns,
  type OrderSyncColumns,
  type OrderUpdatePlan,
} from '../../../../apps/api/src/modules/orders/domain/update-plan.ts';
import type { UnionOrder } from '../../../../apps/api/src/modules/union/index.ts';

const PAID_AT = new Date('2026-10-30T02:00:01.000Z');
const MODIFIED_AT = new Date('2026-10-30T02:30:02.000Z');

const EMPTY: OrderQuantityColumns = { quantity: null, refunded_quantity: null };

it('[AC-B1-08zi#8] 首次入库（库内两列为空）：报文给的件数与已退件数原样写入，无告警', () => {
  expect(planOrderQuantities(EMPTY, { quantity: 3, refunded_quantity: 1 })).toEqual({
    quantity: 3,
    refunded_quantity: 1,
    alerts: [],
  });
  expect(planOrderQuantities(EMPTY, { quantity: 2, refunded_quantity: 0 })).toEqual({
    quantity: 2,
    refunded_quantity: 0,
    alerts: [],
  });
});

it('[AC-B1-08zi#9] 本次没给（缺键或 null）→ 沿用库内值；库内为空就仍为空', () => {
  const stored: OrderQuantityColumns = { quantity: 4, refunded_quantity: 2 };
  expect(planOrderQuantities(stored, {})).toEqual({ ...stored, alerts: [] });
  expect(planOrderQuantities(stored, { quantity: null, refunded_quantity: null })).toEqual({
    ...stored,
    alerts: [],
  });
  expect(planOrderQuantities(stored, { quantity: 4 })).toEqual({ ...stored, alerts: [] });
  expect(planOrderQuantities(stored, { refunded_quantity: null, quantity: 5 })).toEqual({
    quantity: 5,
    refunded_quantity: 2,
    alerts: [],
  });
  expect(planOrderQuantities(EMPTY, {})).toEqual({ ...EMPTY, alerts: [] });
});

it('[AC-B1-08zi#10] 已退件数只增不减：增加写新值；相等照旧；变小不写、保留旧值并告警', () => {
  const stored: OrderQuantityColumns = { quantity: 4, refunded_quantity: 2 };
  expect(planOrderQuantities(stored, { quantity: 4, refunded_quantity: 3 })).toEqual({
    quantity: 4,
    refunded_quantity: 3,
    alerts: [],
  });
  expect(planOrderQuantities(stored, { quantity: 4, refunded_quantity: 2 })).toEqual({
    ...stored,
    alerts: [],
  });
  expect(planOrderQuantities(stored, { quantity: 4, refunded_quantity: 1 })).toEqual({
    ...stored,
    alerts: ['refunded_quantity_decreased'],
  });
  expect(planOrderQuantities(stored, { refunded_quantity: 0 })).toEqual({
    ...stored,
    alerts: ['refunded_quantity_decreased'],
  });
});

it('[AC-B1-08zi#11] 件数同样只增不减；两列都变小时两条告警按 quantity、refunded_quantity 的顺序', () => {
  const stored: OrderQuantityColumns = { quantity: 4, refunded_quantity: 2 };
  expect(planOrderQuantities(stored, { quantity: 3, refunded_quantity: 2 })).toEqual({
    ...stored,
    alerts: ['quantity_decreased'],
  });
  expect(planOrderQuantities(stored, { quantity: 1, refunded_quantity: 0 })).toEqual({
    ...stored,
    alerts: ['quantity_decreased', 'refunded_quantity_decreased'],
  });
  // 两列各自判定：件数变小被拒不妨碍已退件数增加写入。
  expect(planOrderQuantities(stored, { quantity: 3, refunded_quantity: 3 })).toEqual({
    quantity: 4,
    refunded_quantity: 3,
    alerts: ['quantity_decreased'],
  });
});

it('[AC-B1-08zi#12] 淘宝 / 拼多多的报文不给两列：refund_tag、item_num、return_status 都不参与推算', () => {
  const taobao: Pick<UnionOrder, 'quantity' | 'refunded_quantity'> & Partial<UnionOrder> = {
    platform: 'taobao',
    refund_tag: 1,
    item_num: 3,
    tk_status: 13,
  };
  const pdd: Pick<UnionOrder, 'quantity' | 'refunded_quantity'> & Partial<UnionOrder> = {
    platform: 'pdd',
    return_status: 2,
    order_status: 4,
  };
  for (const incoming of [taobao, pdd]) {
    expect(planOrderQuantities(EMPTY, incoming)).toEqual({ ...EMPTY, alerts: [] });
    expect(planOrderQuantities({ quantity: 2, refunded_quantity: 1 }, incoming)).toEqual({
      quantity: 2,
      refunded_quantity: 1,
      alerts: [],
    });
  }
});

/** One column worked out by hand: missing keeps, never below a stored value. */
function oracle(stored: number | null, reported: number | null | undefined) {
  if (reported === undefined || reported === null) return { value: stored, decreased: false };
  if (stored !== null && reported < stored) return { value: stored, decreased: true };
  return { value: reported, decreased: false };
}

it('[AC-B1-08zi#13] 任意库内值与报文：结果不小于库内值，只取库内值或报文值，告警恰在变小时出现', () => {
  const stored = fc.option(fc.integer({ min: 0, max: 50 }), { nil: null });
  const reported = fc.oneof(
    fc.constant(undefined),
    fc.constant(null),
    fc.integer({ min: 0, max: 50 }),
  );
  expect(() =>
    fc.assert(
      fc.property(stored, stored, reported, reported, (sq, sr, rq, rr) => {
        const incoming: { quantity?: number | null; refunded_quantity?: number | null } = {};
        if (rq !== undefined) incoming.quantity = rq;
        if (rr !== undefined) incoming.refunded_quantity = rr;
        const plan = planOrderQuantities({ quantity: sq, refunded_quantity: sr }, incoming);
        const q = oracle(sq, rq);
        const r = oracle(sr, rr);
        const alerts = [
          ...(q.decreased ? ['quantity_decreased'] : []),
          ...(r.decreased ? ['refunded_quantity_decreased'] : []),
        ];
        expect(plan).toEqual({ quantity: q.value, refunded_quantity: r.value, alerts });
        return true;
      }),
      propParams(),
    ),
  ).not.toThrow();
}, 900_000);

it('[AC-B1-08zi#14] 只有已退件数变化、佣金不变：commission_version 不加 1，同步列集合不含两列', () => {
  const current: OrderSyncColumns = {
    pay_amount_fen: 4560n,
    est_commission_fen: 123n,
    commission_version: 2,
    settle_commission_fen: null,
    received_at: null,
    platform_received_at: null,
    deposit_paid_at: null,
    paid_at: PAID_AT,
    settled_at: null,
    platform_modified_at: MODIFIED_AT,
    parent_order_id: null,
    raw_item_id: '100012345678',
    content_hash: 'synthetic-hash',
    raw_payload_id: 7n,
  };
  const incoming: UnionOrder = {
    platform: 'jd',
    order_id: '3123456789012345',
    item_id: '100012345678',
    paid_fen: 4560n,
    commission_fen: 123n,
    sub_order_id: '2026103012345678901',
    parent_order_id: null,
    raw_status: '16',
    paid_at: PAID_AT,
    modified_at: new Date('2026-10-30T03:00:00.000Z'),
    est_commission_fen: 123n,
    settle_commission_fen: null,
    raw_payload_id: '8',
    quantity: 3,
    refunded_quantity: 1,
  };
  const plan: OrderUpdatePlan = {
    kind: 'update',
    platform_status: 'PAID',
    received_at: null,
    history: [],
    pending: null,
    rule: 'P15',
  };
  const quantities = planOrderQuantities({ quantity: 3, refunded_quantity: 0 }, incoming);
  expect(quantities).toEqual({ quantity: 3, refunded_quantity: 1, alerts: [] });
  const columns = planOrderSyncColumns(current, incoming, plan);
  expect(columns.commission_version).toBe(2);
  expect(Object.keys(columns)).not.toContain('quantity');
  expect(Object.keys(columns)).not.toContain('refunded_quantity');
  expect(Object.keys(columns)).not.toContain('refunded_quantity_at_credit');
});
