import { accountingDate, settlementBillPeriod } from '@couli/domain';
import { expect, it, vi } from 'vitest';
import type { QuotaLimiter } from '../../../apps/api/src/modules/platform/index.ts';
import { createGovernedAdapter, UnionError } from '../../../apps/api/src/modules/union/index.ts';
import { DemoUnionAdapter } from '../../../apps/api/src/modules/union/infra/demo/demo-adapter.ts';
import { ManualScheduler } from '../../spec/platform/http/kit.ts';
import {
  PAID,
  RECEIVED,
  REFUNDED,
  START,
  demoStream,
  replayClock,
  streamRows,
  syntheticOrder,
} from './stream-fixture.ts';

it('[AC-QA-03a#1] 同种子、时钟与窗口重放及重建适配器均确定；跨页不丢单、不串 app，种子影响订单标识', async () => {
  const time = replayClock();
  time.moveTo('2026-11-01T00:00:00+08:00');
  const inputs = Array.from({ length: 31 }, (_, i) => syntheticOrder(`order-${i}`));
  inputs.push(syntheticOrder('foreign', 'another-app'));
  const win = { from: START, to: time.clock.now().toISOString() };
  const adapter = demoStream(time.clock, inputs);
  const rows = await streamRows(adapter, win);
  expect(rows).toHaveLength(31 * 3);
  expect(await streamRows(adapter, win)).toEqual(rows);
  expect(await streamRows(demoStream(time.clock, inputs), win)).toEqual(rows);
  const paid = rows.filter((row) => row.raw_status === 'demo:paid');
  expect(new Set(paid.map((row) => row.sub_order_id)).size).toBe(31);
  const different = await streamRows(demoStream(time.clock, inputs, 'another-seed'), win);
  expect(different.map((row) => row.sub_order_id)).not.toEqual(rows.map((row) => row.sub_order_id));
  const foreign = await streamRows(adapter, win, 'another-app');
  expect(foreign).toHaveLength(3);
  expect(foreign.some((row) => rows.some((ours) => ours.sub_order_id === row.sub_order_id))).toBe(
    false,
  );
  expect(await streamRows(adapter, win, 'unconfigured-app')).toEqual([]);
});

it('[AC-QA-03a#2] BR-FUND-02 合成下单→收货→全退序列：时间来自领域输入，收货不伪造结算佣金', async () => {
  const time = replayClock();
  time.advanceReplayMs(86_400_000);
  expect(accountingDate(time.clock.now())).toBe('2026-11-01');
  expect(settlementBillPeriod(time.clock.now())).toBe('2026-10');
  const input = syntheticOrder();
  const rows = await streamRows(demoStream(time.clock, [input]), {
    from: START,
    to: time.clock.now().toISOString(),
  });
  expect(rows.map((row) => row.raw_status)).toEqual([
    'demo:paid',
    'demo:received',
    'demo:refunded',
  ]);
  expect(new Set(rows.map((row) => row.sub_order_id)).size).toBe(1);
  expect(rows.map((row) => row.modified_at?.toISOString())).toEqual(
    [PAID, RECEIVED, REFUNDED].map((iso) => new Date(iso).toISOString()),
  );
  expect(rows[0]!.received_at).toBeNull();
  for (const row of rows) {
    expect(row).toMatchObject({
      platform: 'pdd',
      goods_sign: input.item.goods_sign,
      promotion_slot: input.promotionSlot,
      attr_params: input.attrParams,
      settle_commission_fen: null,
      settled_at: null,
      raw_payload_id: null,
    });
    expect(row.paid_at).toEqual(new Date(PAID));
    expect(typeof row.paid_fen).toBe('bigint');
    expect(typeof row.commission_fen).toBe('bigint');
    expect(row).not.toHaveProperty('order_status');
    expect(row).not.toHaveProperty('validCode');
    expect(row).not.toHaveProperty('promotion_amount');
  }
  expect(rows[0]!.est_commission_fen).toBeGreaterThan(0n);
  expect(rows[1]!.est_commission_fen).toBeGreaterThan(0n);
  // Synthetic PDD fixtures explicitly supply a known zero fee, never guess a missing fee.
  expect(rows[0]!.service_fee_fen).toBe(0n);
  expect(rows[1]!.service_fee_fen).toBe(0n);
  expect(rows[1]!.received_at).toEqual(new Date(RECEIVED));
  expect(rows[2]!.received_at).toEqual(new Date(RECEIVED));
});

it('[AC-QA-03a#3] 半开窗口边界、注入时钟限制与跨窗口重试：未来收货不能提前出现', async () => {
  const time = replayClock();
  time.moveTo(PAID);
  const adapter = demoStream(time.clock, [syntheticOrder()]);
  const end = '2026-11-01T00:00:00+08:00';
  expect(await streamRows(adapter, { from: START, to: PAID })).toEqual([]);
  const paid = await streamRows(adapter, { from: PAID, to: end });
  expect(paid.map((row) => row.raw_status)).toEqual(['demo:paid']);
  time.moveTo(RECEIVED);
  const received = await streamRows(adapter, { from: RECEIVED, to: end });
  expect(received.map((row) => row.raw_status)).toEqual(['demo:received']);
  expect(await streamRows(adapter, { from: PAID, to: RECEIVED })).toEqual(paid);
  expect(received[0]!.sub_order_id).toBe(paid[0]!.sub_order_id);
  // Explicit opt-in only, and the existing production constructor guard must remain in force.
  expect(await streamRows(demoStream(time.clock, []), { from: START, to: end })).toEqual([]);
  await expect(
    new DemoUnionAdapter({
      platform: 'pdd',
      seed: 'synthetic',
      clock: time.clock,
      environment: 'test',
    }).listOrders(
      { from: START, to: end },
      {},
      { appId: 'qa03a-stream', requestId: 'synthetic-unconfigured', purpose: 'order_sync' },
    ),
  ).rejects.toMatchObject({ code: 'adapter_unimplemented' });
  expect(
    () =>
      new DemoUnionAdapter({
        platform: 'pdd',
        seed: 'synthetic',
        clock: time.clock,
        environment: 'prod',
      }),
  ).toThrow();
});

it.each(['pdd', 'jd', 'taobao'] as const)(
  '[AC-QA-03a#6] %s 显式空订单流返回成功空页，且只扣一次外层配额',
  async (platform) => {
    const time = replayClock();
    time.moveTo(RECEIVED);
    const take = vi.fn<QuotaLimiter['tryAcquire']>(() => true);
    const adapter = createGovernedAdapter(demoStream(time.clock, [], 'synthetic-empty', platform), {
      endpoint: {
        platform,
        mode: 'demo',
        baseUrl: 'https://demo.invalid',
        quotaKey: 'qa03a-empty-stream',
      },
      scheduler: new ManualScheduler(),
      quota: { bucketKey: 'qa03a-empty-stream', tryAcquire: take },
    });
    const outcome = await adapter
      .listOrders(
        { from: START, to: '2026-11-01T00:00:00+08:00' },
        {},
        { appId: 'qa03a-stream', requestId: 'synthetic-empty', purpose: 'order_sync' },
      )
      .then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => {
          if (error instanceof UnionError && error.code === 'adapter_unimplemented') {
            return { ok: false as const, code: error.code };
          }
          throw error;
        },
      );
    expect(take.mock.calls).toEqual([['order_sync']]);
    expect(outcome).toMatchObject({ ok: true, value: { items: [], nextCursor: null } });
  },
);

it.each(['jd', 'taobao'] as const)(
  '[AC-QA-03a#5] %s 演示流同样只返回统一 DTO 与合成事件标签',
  async (platform) => {
    const time = replayClock();
    time.advanceReplayMs(86_400_000);
    const input = {
      ...syntheticOrder(),
      item:
        platform === 'jd'
          ? { platform, itemId: 'synthetic-product' }
          : { platform, item_id: 'synthetic-product' },
    };
    const rows = await streamRows(
      demoStream(time.clock, [input], 'synthetic-cross-platform', platform),
      { from: START, to: time.clock.now().toISOString() },
    );
    expect(rows.map((row) => row.raw_status)).toEqual([
      'demo:paid',
      'demo:received',
      'demo:refunded',
    ]);
    for (const row of rows) {
      expect(row).toMatchObject({
        ...input.item,
        attr_params: input.attrParams,
        promotion_slot: input.promotionSlot,
        settle_commission_fen: null,
      });
    }
  },
);
