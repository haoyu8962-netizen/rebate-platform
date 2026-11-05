// B1-08i 源码旁单元测试：规则测试未覆盖的判定细节（纯函数，不连库）。
import { describe, expect, it } from 'vitest';
import { FixedClock } from '../../platform/index.ts';
import type { UnionOrder } from '../../union/index.ts';
import type { PlatformStatusEvent, StatusMap } from './status-map.ts';
import {
  planOrderSyncColumns,
  planOrderUpdate,
  reportedSettleFen,
  type OrderSyncColumns,
} from './update-plan.ts';

const at = (iso: string) => new FixedClock(iso).now();
const RECEIVED = '2026-10-16T03:04:05.000Z';
const SETTLED = '2026-10-17T04:05:06.000Z';

const map: StatusMap = {
  platform: 'pdd',
  entries: new Map(
    (
      [
        ['paid', 'PLATFORM_PAID'],
        ['received', 'PLATFORM_RECEIVED'],
        ['settled', 'PLATFORM_SETTLED'],
        ['invalid', 'PLATFORM_INVALID'],
      ] as [string, PlatformStatusEvent][]
    ).map(([code, event]) => [code, { event, source: 'unit', verified: false, note: '' }]),
  ),
};

function order(patch: Partial<UnionOrder> = {}): UnionOrder {
  // Synthetic normalized DTO; codes are test labels, not platform recordings.
  return {
    platform: 'pdd',
    order_id: 'unit-order',
    sub_order_id: 'unit-child',
    parent_order_id: null,
    promotion_slot: 'slot-ours',
    attr_params: { relation_id: null, sub_union_id: null, custom_parameters: null },
    raw_status: 'paid',
    goods_id: 'unit-item',
    paid_fen: 100n,
    commission_fen: 10n,
    est_commission_fen: 10n,
    settle_commission_fen: null,
    deposit_paid_at: null,
    paid_at: at('2026-10-15T16:00:00.000Z'),
    received_at: null,
    settled_at: null,
    modified_at: null,
    raw_payload_id: '7',
    ...patch,
  };
}

describe('planOrderUpdate', () => {
  it('[AC-B1-08i#U1] P14 缺收货时间只走 P2 一步，规则记实际走过的 P2；P3 缺时间不迁移、规则为空', () => {
    const p14 = planOrderUpdate(
      { platform_status: 'DEPOSIT_PAID', rebate_status: 'ESTIMATED', received_at: null },
      order({ raw_status: 'received' }),
      map,
      true,
    );
    expect(p14).toMatchObject({ platform_status: 'PAID', rule: 'P2', pending: 'NO_RECEIVED_AT' });
    const p3 = planOrderUpdate(
      { platform_status: 'PAID', rebate_status: 'ESTIMATED', received_at: null },
      order({ raw_status: 'received' }),
      map,
      true,
    );
    expect(p3).toMatchObject({ platform_status: 'PAID', rule: null, history: [] });
  });

  it('[AC-B1-08i#U2] P4 自 RECEIVED 不受收货时间守卫；P9 到 SETTLED 缺收货时取结算时间', () => {
    const p4 = planOrderUpdate(
      { platform_status: 'RECEIVED', rebate_status: 'WAITING', received_at: null },
      order({ raw_status: 'settled' }),
      map,
      true,
    );
    expect(p4).toMatchObject({ platform_status: 'SETTLED', rule: 'P4', pending: null });
    const p9 = planOrderUpdate(
      { platform_status: 'INVALID', rebate_status: 'VOID', received_at: null },
      order({ raw_status: 'settled', settled_at: at(SETTLED) }),
      map,
      true,
    );
    expect(p9).toMatchObject({ platform_status: 'SETTLED', rule: 'P9', received_at: at(SETTLED) });
    expect(p9.history).toHaveLength(1);
  });

  it('[AC-B1-08i#U3] 非法与倒退带上映射事件（待处理说明用），表外码事件为空', () => {
    const backward = planOrderUpdate(
      { platform_status: 'SETTLED', rebate_status: 'CREDITED', received_at: at(RECEIVED) },
      order({ raw_status: 'paid' }),
      map,
      true,
    );
    expect(backward).toMatchObject({ kind: 'pending', rule: 'P10', event: 'PLATFORM_PAID' });
    const unmapped = planOrderUpdate(
      { platform_status: 'PAID', rebate_status: 'ESTIMATED', received_at: null },
      order({ raw_status: null }),
      map,
      true,
    );
    expect(unmapped).toMatchObject({ kind: 'update', pending: 'UNMAPPED_STATUS', event: null });
  });
});

describe('planOrderSyncColumns', () => {
  const current: OrderSyncColumns = {
    pay_amount_fen: 100n,
    est_commission_fen: null,
    commission_version: 0,
    settle_commission_fen: null,
    received_at: null,
    platform_received_at: null,
    deposit_paid_at: null,
    paid_at: at('2026-10-15T16:00:00.000Z'),
    settled_at: null,
    platform_modified_at: null,
    parent_order_id: null,
    raw_item_id: 'kept-item',
    content_hash: 'old',
    raw_payload_id: 6n,
  };
  const plan = {
    kind: 'update' as const,
    platform_status: 'PAID' as const,
    received_at: null,
    history: [],
    pending: null,
    rule: 'P15',
  };

  it('[AC-B1-08i#U4] 库内预估为空时首个非空值递增版本；商品号全空保留库内值；未归档页写 null', () => {
    const next = planOrderSyncColumns(
      current,
      order({ est_commission_fen: 5n, goods_id: null, raw_payload_id: null }),
      plan,
    );
    expect(next).toMatchObject({
      est_commission_fen: 5n,
      commission_version: 1,
      raw_item_id: 'kept-item',
      raw_payload_id: null,
    });
  });

  it('[AC-B1-08i#U5] 收货时间与库内相同不写 platform_received_at', () => {
    const next = planOrderSyncColumns(
      { ...current, received_at: at(RECEIVED) },
      order({ received_at: at(RECEIVED) }),
      plan,
    );
    expect(next).toMatchObject({ received_at: at(RECEIVED), platform_received_at: null });
  });

  const settledPlan = { ...plan, platform_status: 'SETTLED' as const };

  it('[AC-B2-04zj#U1] 结算额只在迁移后 SETTLED 且报文有值时算数，0 与负数也算；没有 STATEMENT 时列取它', () => {
    expect(reportedSettleFen(order({ settle_commission_fen: 0n }), settledPlan)).toBe(0n);
    expect(reportedSettleFen(order({ settle_commission_fen: -5n }), settledPlan)).toBe(-5n);
    expect(reportedSettleFen(order({ settle_commission_fen: null }), settledPlan)).toBeNull();
    expect(reportedSettleFen(order({ settle_commission_fen: 9n }), plan)).toBeNull();
    expect(
      planOrderSyncColumns(current, order({ settle_commission_fen: 9n }), settledPlan)
        .settle_commission_fen,
    ).toBe(9n);
  });

  it('[AC-B2-04zj#U2] 有 STATEMENT 金额时列取它（含 0），报文不覆盖；都没有保留库内值', () => {
    const paid = { ...current, settle_commission_fen: 7n };
    const incoming = order({ settle_commission_fen: 9n });
    expect(planOrderSyncColumns(paid, incoming, settledPlan, 3n).settle_commission_fen).toBe(3n);
    expect(planOrderSyncColumns(paid, incoming, settledPlan, 0n).settle_commission_fen).toBe(0n);
    expect(
      planOrderSyncColumns(paid, order({ settle_commission_fen: null }), settledPlan)
        .settle_commission_fen,
    ).toBe(7n);
  });

  const row = (est: bigint | null, settle: bigint | null): OrderSyncColumns => ({
    ...current,
    est_commission_fen: est,
    settle_commission_fen: settle,
    commission_version: 3,
  });

  it('[AC-B2-03s#U1] 结算后只来新预估：est 存档，版本不动；结算额首次到达且与预估不同：+1', () => {
    expect(
      planOrderSyncColumns(row(10n, 8n), order({ est_commission_fen: 15n }), settledPlan),
    ).toMatchObject({ est_commission_fen: 15n, commission_version: 3 });
    expect(
      planOrderSyncColumns(row(10n, null), order({ settle_commission_fen: 8n }), settledPlan),
    ).toMatchObject({ settle_commission_fen: 8n, commission_version: 4 });
  });

  it('[AC-B2-03s#U2] 库内 N 为空时结算到达 +1；STATEMENT 已在列上时报文不动 N，不 +1；缺预估不前进', () => {
    expect(
      planOrderSyncColumns(
        row(null, null),
        order({ est_commission_fen: null, settle_commission_fen: 8n }),
        settledPlan,
      ).commission_version,
    ).toBe(4);
    expect(
      planOrderSyncColumns(row(10n, 9n), order({ settle_commission_fen: 8n }), settledPlan, 9n)
        .commission_version,
    ).toBe(3);
    expect(
      planOrderSyncColumns(row(10n, null), order({ est_commission_fen: null }), plan)
        .commission_version,
    ).toBe(3);
  });
});
