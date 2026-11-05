import { expect, it } from 'vitest';
import {
  orderContentHash,
  planOrderSyncColumns,
} from '../../../../apps/api/src/modules/orders/index.ts';
import type {
  OrderSyncColumns,
  OrderUpdatePlan,
} from '../../../../apps/api/src/modules/orders/index.ts';
import { at, ATTR, order, RECEIVED, SETTLED } from '../attribution/kit.ts';

const current: OrderSyncColumns = {
  pay_amount_fen: 10000n,
  est_commission_fen: 789n,
  commission_version: 7,
  settle_commission_fen: 450n,
  received_at: at(RECEIVED),
  platform_received_at: null,
  deposit_paid_at: at('2026-10-14T01:02:03Z'),
  paid_at: at(ATTR),
  settled_at: at(SETTLED),
  platform_modified_at: at('2026-10-17T05:06:07Z'),
  parent_order_id: 'old-parent',
  raw_item_id: 'old-item',
  content_hash: 'old-hash',
  raw_payload_id: 101n,
};
const plan: OrderUpdatePlan = {
  kind: 'update',
  platform_status: 'PAID',
  received_at: at(RECEIVED),
  history: [],
  pending: null,
  rule: 'P15',
};

it.each([null, 789n])(
  '[AC-B1-08i#10] 预估佣金 %s：null 保留，实际变化才递增版本，整数分不丢精度',
  (amount) => {
    const next = planOrderSyncColumns(current, order({ est_commission_fen: amount }), plan);
    expect(next.est_commission_fen).toBe(amount ?? 789n);
    expect(next.commission_version).toBe(amount === null || amount === 789n ? 7 : 8);
  },
);

it.each([0n, 123n, 9007199254740993n])(
  '[AC-B1-08i#10] 已结算单只来新预估 %s：est 存档、版本保持 7（D10-578 ①），整数分不丢精度',
  (amount) => {
    const next = planOrderSyncColumns(current, order({ est_commission_fen: amount }), plan);
    expect(next.est_commission_fen).toBe(amount);
    expect(next.commission_version).toBe(7);
  },
);

it.each(['PAID', 'RECEIVED', 'SETTLED'] as const)(
  '[AC-B1-08i#11] 结算佣金仅迁移后 SETTLED 可写：%s',
  (state) => {
    const next = planOrderSyncColumns(current, order({ settle_commission_fen: 0n }), {
      ...plan,
      platform_status: state,
    });
    expect(next.settle_commission_fen).toBe(state === 'SETTLED' ? 0n : 450n);
  },
);

it('[AC-B1-08i#12] null 金额与时间不覆盖已有值；缺失预估不借用 commission_fen', () => {
  const next = planOrderSyncColumns(
    current,
    order({
      est_commission_fen: null,
      commission_fen: 9999n,
      settle_commission_fen: null,
      deposit_paid_at: null,
      paid_at: null,
      received_at: null,
      settled_at: null,
      modified_at: null,
    }),
    { ...plan, platform_status: 'SETTLED' },
  );
  expect(next).toMatchObject({
    pay_amount_fen: 12345n,
    est_commission_fen: 789n,
    commission_version: 7,
    settle_commission_fen: 450n,
    deposit_paid_at: current.deposit_paid_at,
    paid_at: current.paid_at,
    received_at: current.received_at,
    settled_at: current.settled_at,
    platform_modified_at: current.platform_modified_at,
  });
});

it('[AC-B1-08i#13] 后到收货时间只存 platform_received_at，新值再次到达可更新', () => {
  const changed = at('2026-10-16T12:13:14Z');
  const first = planOrderSyncColumns(current, order({ received_at: changed }), plan);
  expect(first).toMatchObject({ received_at: at(RECEIVED), platform_received_at: changed });
  const second = planOrderSyncColumns(
    first,
    order({ received_at: at('2026-10-16T14:15:16Z') }),
    plan,
  );
  expect(second).toMatchObject({
    received_at: at(RECEIVED),
    platform_received_at: at('2026-10-16T14:15:16Z'),
  });
});

it('[AC-B1-08i#14] 同步列使用归一字段及共同 hash，不包含返利或身份列', () => {
  const incoming = order({
    paid_fen: 0n,
    parent_order_id: 'new-parent',
    goods_id: null,
    goods_sign: 'sign-item',
    raw_payload_id: '202',
    modified_at: at('2026-10-17T07:08:09Z'),
  });
  const next = planOrderSyncColumns(current, incoming, plan);
  expect(next).toMatchObject({
    pay_amount_fen: 0n,
    parent_order_id: 'new-parent',
    raw_item_id: 'sign-item',
    raw_payload_id: 202n,
    content_hash: orderContentHash(incoming),
    platform_modified_at: incoming.modified_at,
  });
  expect(Object.keys(next).sort()).toEqual(Object.keys(current).sort());
});
