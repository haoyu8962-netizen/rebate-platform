// BR-FUND-02 / E-22（读法 A）：淘宝订单经真实适配器映射（合成行，假传输），再经真实 taobao.csv 与订单的
// 首态 / 更新判定：12 → 已付款；14 → 淘宝报文没有确认收货时间，首入与更新都停在已付款、收货事件进待处理
// NO_RECEIVED_AT（R4 守卫，不进 WAITING）；3 → 视为已收货，received_at 取结算时间 tk_earning_time（首入
// P12 补写三条 history，更新 P5），之后 settlement 才能按 R4 进 WAITING；13 → 失效。received_at 从不取同步
// 时间（适配器的注入时钟）。
import { expect, it } from 'vitest';
import { planImportState } from '../../../../apps/api/src/modules/orders/domain/import-state.ts';
import { mapPlatformStatus } from '../../../../apps/api/src/modules/orders/domain/status-map.ts';
import {
  planOrderUpdate,
  type UpdateStateInput,
} from '../../../../apps/api/src/modules/orders/domain/update-plan.ts';
import type { UnionOrder } from '../../../../apps/api/src/modules/union/domain/types.ts';
import { EARNING_AT, SYNC_AT, taobaoMap, taobaoOrder } from './taobao-sync-kit.ts';

const PAID_ESTIMATED: UpdateStateInput = {
  platform_status: 'PAID',
  rebate_status: 'ESTIMATED',
  received_at: null,
};

/** The first-import decision of the order (its own received and settled times). */
function firstImport(order: UnionOrder) {
  return planImportState(eventOf(order), order.received_at ?? null, order.settled_at ?? null);
}

/** The mapped event of the order's raw status; an unmapped code fails as an assertion. */
function eventOf(order: UnionOrder) {
  const mapped = mapPlatformStatus(taobaoMap(), order.raw_status ?? null);
  expect(mapped.kind, `tk_status ${order.raw_status}`).toBe('event');
  if (mapped.kind !== 'event') throw new Error('unreachable');
  return mapped.event;
}

it('[AC-B1-04zzb#6] tk_status 12：首次入库落已付款一条 history，不进待处理', async () => {
  taobaoMap();
  const order = await taobaoOrder('12');
  expect(order.raw_status).toBe('12');
  expect(firstImport(order)).toEqual({
    kind: 'insert',
    platform_status: 'PAID',
    received_at: null,
    history: [{ from_status: null, event: 'PLATFORM_PAID', to_status: 'PAID' }],
    pending: null,
  });
});

it('[AC-B1-04zzb#7] E-22：tk_status 14 没有收货时间——首入与更新都仍是已付款、待处理 NO_RECEIVED_AT，不用同步时间', async () => {
  taobaoMap();
  const order = await taobaoOrder('14');
  expect(order.raw_status).toBe('14');
  expect(order.received_at ?? null).toBeNull();
  expect(order.settled_at ?? null).toBeNull();
  expect(eventOf(order)).toBe('PLATFORM_RECEIVED');

  expect(firstImport(order)).toEqual({
    kind: 'insert',
    platform_status: 'PAID',
    received_at: null,
    history: [{ from_status: null, event: 'PLATFORM_PAID', to_status: 'PAID' }],
    pending: 'NO_RECEIVED_AT',
  });

  const update = planOrderUpdate(PAID_ESTIMATED, order, taobaoMap(), false);
  expect(update).toMatchObject({
    kind: 'update',
    platform_status: 'PAID',
    received_at: null,
    history: [],
    pending: 'NO_RECEIVED_AT',
  });
  expect(update.platform_status).not.toBe('RECEIVED');
  expect(update.received_at).not.toEqual(SYNC_AT);
});

it('[AC-B1-04zzb#8] tk_status 3：视为已收货，received_at 取 tk_earning_time；首入补写 PAID、RECEIVED、SETTLED，更新走 P5', async () => {
  taobaoMap();
  const order = await taobaoOrder('3');
  expect(order.raw_status).toBe('3');
  expect(order.received_at ?? null).toBeNull();
  expect(order.settled_at).toEqual(EARNING_AT);
  expect(eventOf(order)).toBe('PLATFORM_SETTLED');

  expect(firstImport(order)).toEqual({
    kind: 'insert',
    platform_status: 'SETTLED',
    received_at: EARNING_AT,
    history: [
      { from_status: null, event: 'PLATFORM_PAID', to_status: 'PAID' },
      { from_status: 'PAID', event: 'PLATFORM_RECEIVED', to_status: 'RECEIVED' },
      { from_status: 'RECEIVED', event: 'PLATFORM_SETTLED', to_status: 'SETTLED' },
    ],
    pending: null,
  });

  const update = planOrderUpdate(PAID_ESTIMATED, order, taobaoMap(), false);
  expect(update).toMatchObject({
    kind: 'update',
    platform_status: 'SETTLED',
    received_at: EARNING_AT,
    pending: null,
    rule: 'P5',
    history: [
      { from_status: 'PAID', event: 'PLATFORM_RECEIVED', to_status: 'RECEIVED' },
      { from_status: 'RECEIVED', event: 'PLATFORM_SETTLED', to_status: 'SETTLED' },
    ],
  });
  expect(update.received_at).not.toEqual(SYNC_AT);
});

it('[AC-B1-04zzb#9] E-22：先来 14（停在已付款、待处理），之后 3 到来按 P5 进已结算，received_at = 结算时间', async () => {
  taobaoMap();
  const received = await taobaoOrder('14');
  const afterReceived = planOrderUpdate(PAID_ESTIMATED, received, taobaoMap(), false);
  expect(afterReceived).toMatchObject({ platform_status: 'PAID', pending: 'NO_RECEIVED_AT' });

  const settled = await taobaoOrder('3');
  const afterSettled = planOrderUpdate(
    {
      platform_status: afterReceived.platform_status,
      rebate_status: 'ESTIMATED',
      received_at: afterReceived.received_at,
    },
    settled,
    taobaoMap(),
    false,
  );
  expect(afterSettled).toMatchObject({
    kind: 'update',
    platform_status: 'SETTLED',
    received_at: EARNING_AT,
    rule: 'P5',
    pending: null,
  });
});

it('[AC-B1-04zzb#10] tk_status 13（关闭）：首入与自已付款更新都进失效', async () => {
  taobaoMap();
  const order = await taobaoOrder('13');
  expect(order.raw_status).toBe('13');
  expect(eventOf(order)).toBe('PLATFORM_INVALID');
  expect(firstImport(order)).toMatchObject({
    kind: 'insert',
    platform_status: 'INVALID',
    pending: null,
  });
  const update = planOrderUpdate(PAID_ESTIMATED, order, taobaoMap(), false);
  expect(update).toMatchObject({ kind: 'update', platform_status: 'INVALID', pending: null });
});
