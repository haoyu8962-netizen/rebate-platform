import { expect, it } from 'vitest';
import { FixedClock } from '../../../platform/index.ts';
import type { CallCtx, OrderQueryOpt, TimeWindow, UnionOrder } from '../../domain/types.ts';
import { createUnionRegistry } from '../registry.ts';
import { DemoUnionAdapter } from './demo-adapter.ts';
import { DEMO_ORDER_PAGE_SIZE, type DemoOrderSeed } from './demo-order-stream.ts';

// Local unit-test identifiers; synthetic demo data only.
const ctx: CallCtx = { appId: 'unit-app', requestId: 'unit-request', purpose: 'order_sync' };
const PAID = '2026-10-05T10:00:00+08:00';
const RECEIVED = '2026-10-08T20:00:00+08:00';
const REFUNDED = '2026-10-20T11:00:00+08:00';
const win: TimeWindow = { from: '2026-10-01T00:00:00+08:00', to: '2026-11-01T00:00:00+08:00' };

function seed(overrides: Partial<DemoOrderSeed> = {}): DemoOrderSeed {
  return {
    key: 'unit-order',
    appId: ctx.appId,
    item: { platform: 'pdd', goods_sign: 'unit-goods' },
    promotionSlot: 'unit-slot',
    attrParams: { relation_id: null, custom_parameters: 'unit-params', sub_union_id: null },
    paidAt: PAID,
    receivedAt: RECEIVED,
    refundedAt: REFUNDED,
    ...overrides,
  };
}

function adapter(orderStream: readonly DemoOrderSeed[], now = '2026-11-01T00:00:00+08:00') {
  return new DemoUnionAdapter({
    platform: 'pdd',
    seed: 'unit-seed',
    clock: new FixedClock(now),
    environment: 'test',
    orderStream,
  });
}

async function all(port: DemoUnionAdapter, range: TimeWindow, opt: OrderQueryOpt = {}) {
  const rows: UnionOrder[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await port.listOrders(range, cursor === undefined ? opt : { ...opt, cursor }, ctx);
    rows.push(...page.items);
    if (page.nextCursor === null) return rows;
    cursor = page.nextCursor;
  }
}

it('[AC-QA-03a-UNIT#1] 装配出的演示端点仍报 adapter_unimplemented，prod 拿不到合成订单流', async () => {
  const clock = new FixedClock('2026-11-01T00:00:00+08:00');
  const registry = createUnionRegistry({
    endpoints: (['jd', 'pdd', 'taobao'] as const).map((platform) => ({
      platform,
      mode: 'demo' as const,
      baseUrl: null,
      quotaKey: `unit:${platform}`,
    })),
    seed: 'unit-seed',
    clock,
    environment: 'test',
  });
  for (const platform of ['jd', 'pdd', 'taobao'] as const) {
    await expect(registry.get(platform).listOrders(win, {}, ctx)).rejects.toMatchObject({
      code: 'adapter_unimplemented',
    });
  }
  expect(
    () =>
      new DemoUnionAdapter({
        platform: 'pdd',
        seed: 'unit-seed',
        clock,
        environment: 'prod',
        orderStream: [seed()],
      }),
  ).toThrow(expect.objectContaining({ code: 'unsafe_mode' }));
});

it('[AC-QA-03a-UNIT#2] 每个版本金额相同、为整数分且冻结；只带统一 DTO 字段', async () => {
  const rows = await all(adapter([seed()]), win);
  expect(rows.map((row) => row.raw_status)).toEqual([
    'demo:paid',
    'demo:received',
    'demo:refunded',
  ]);
  const first = rows[0]!;
  expect(first.paid_fen).toBeGreaterThan(0n);
  expect(first.commission_fen).toBeGreaterThan(0n);
  expect(first.commission_fen).toBeLessThan(first.paid_fen);
  for (const row of rows) {
    expect(Object.isFrozen(row)).toBe(true);
    expect(Object.isFrozen(row.attr_params)).toBe(true);
    expect(row).toMatchObject({
      order_id: first.sub_order_id,
      paid_fen: first.paid_fen,
      commission_fen: first.commission_fen,
      est_commission_fen: first.commission_fen,
      service_fee_fen: 0n,
      parent_order_id: null,
      deposit_paid_at: null,
      settled_at: null,
      settle_commission_fen: null,
      raw_payload_id: null,
    });
    expect(Object.keys(row).sort()).toEqual(
      [
        'platform',
        'goods_sign',
        'order_id',
        'paid_fen',
        'commission_fen',
        'service_fee_fen',
        'sub_order_id',
        'parent_order_id',
        'promotion_slot',
        'attr_params',
        'raw_status',
        'deposit_paid_at',
        'paid_at',
        'received_at',
        'settled_at',
        'modified_at',
        'est_commission_fen',
        'settle_commission_fen',
        'raw_payload_id',
      ].sort(),
    );
  }
  // Non-PDD rows carry no PDD-only service fee field.
  const jd = new DemoUnionAdapter({
    platform: 'jd',
    seed: 'unit-seed',
    clock: new FixedClock('2026-11-01T00:00:00+08:00'),
    environment: 'test',
    orderStream: [seed({ item: { platform: 'jd', itemId: 'unit-item' } })],
  });
  for (const row of await all(jd, win)) expect(row).not.toHaveProperty('service_fee_fen');
});

it('[AC-QA-03a-UNIT#3] 分页游标绑定窗口：换窗口或篡改即拒绝，翻页按时间与键稳定排序', async () => {
  const seeds = Array.from({ length: DEMO_ORDER_PAGE_SIZE + 5 }, (_, i) =>
    seed({ key: `k-${String(i).padStart(2, '0')}`, refundedAt: null }),
  );
  const port = adapter(seeds);
  const first = await port.listOrders(win, {}, ctx);
  expect(first.items).toHaveLength(DEMO_ORDER_PAGE_SIZE);
  expect(first.nextCursor).not.toBeNull();
  const cursor = first.nextCursor!;
  await expect(
    port.listOrders({ ...win, to: '2026-10-31T00:00:00+08:00' }, { cursor }, ctx),
  ).rejects.toMatchObject({ code: 'invalid_dto' });
  await expect(port.listOrders(win, { cursor: `${cursor}0` }, ctx)).rejects.toMatchObject({
    code: 'invalid_dto',
  });
  await expect(
    port.listOrders(win, { cursor: cursor.replace(/-(\d+)-/, '-999-') }, ctx),
  ).rejects.toMatchObject({ code: 'invalid_dto' });
  const rows = await all(port, win);
  expect(rows).toHaveLength(seeds.length * 2);
  const times = rows.map((row) => row.modified_at!.getTime());
  expect(times).toEqual([...times].sort((a, b) => a - b));
  expect(rows.slice(0, seeds.length).every((row) => row.raw_status === 'demo:paid')).toBe(true);
});

it('[AC-QA-03a-UNIT#4] 按付款时间查询给出时钟下最新版本；淘宝 settle 口径为空', async () => {
  const port = adapter([seed()], '2026-10-10T00:00:00+08:00');
  const byPay = await all(
    port,
    { from: PAID, to: '2026-10-05T10:00:01+08:00' },
    {
      queryMode: 'pay_time',
    },
  );
  expect(byPay.map((row) => row.raw_status)).toEqual(['demo:received']);
  expect(byPay[0]!.received_at).toEqual(new Date(RECEIVED));
  expect(await all(port, { from: RECEIVED, to: win.to }, { queryMode: 'pay_time' })).toEqual([]);
  const taobao = new DemoUnionAdapter({
    platform: 'taobao',
    seed: 'unit-seed',
    clock: new FixedClock('2026-11-01T00:00:00+08:00'),
    environment: 'test',
    orderStream: [seed({ item: { platform: 'taobao', item_id: 'unit-item' } })],
  });
  expect(await all(taobao, win, { timeBasis: 'settle' })).toEqual([]);
  expect((await all(taobao, win, { timeBasis: 'pay' })).map((row) => row.raw_status)).toEqual([
    'demo:refunded',
  ]);
  expect(await all(taobao, win)).toHaveLength(3);
});

it('[AC-QA-03a-UNIT#5] 不合法的种子、窗口与场景被拒绝', async () => {
  const bad: Partial<DemoOrderSeed>[] = [
    { key: '' },
    { appId: ' ' },
    { promotionSlot: '' },
    { item: { platform: 'jd', itemId: 'x' } },
    { item: { platform: 'pdd' } },
    { paidAt: '2026-10-05T10:00:00' },
    { receivedAt: PAID },
    { refundedAt: RECEIVED },
    {
      attrParams: { relation_id: 1, custom_parameters: null, sub_union_id: null } as never,
    },
  ];
  for (const overrides of bad) {
    expect(() => adapter([seed(overrides)])).toThrow(
      expect.objectContaining({ code: 'invalid_dto' }),
    );
  }
  expect(() => adapter([seed(), seed()])).toThrow(expect.objectContaining({ code: 'invalid_dto' }));
  // The same key under another app is a different order.
  expect(() => adapter([seed(), seed({ appId: 'unit-app-2' })])).not.toThrow();
  const port = adapter([seed()]);
  await expect(port.listOrders({ from: win.to, to: win.from }, {}, ctx)).rejects.toMatchObject({
    code: 'invalid_dto',
  });
  await expect(port.listOrders({ from: 'yesterday', to: win.to }, {}, ctx)).rejects.toMatchObject({
    code: 'invalid_dto',
  });
  await expect(port.listOrders(win, {}, { ...ctx, scenario: 'timeout' })).rejects.toMatchObject({
    code: 'timeout',
  });
});

it('[AC-QA-03a-UNIT#7] 不传订单流报 adapter_unimplemented；显式传空流给成功空页', async () => {
  const clock = new FixedClock('2026-11-01T00:00:00+08:00');
  for (const platform of ['jd', 'pdd', 'taobao'] as const) {
    const base = { platform, seed: 'unit-seed', clock, environment: 'test' as const };
    await expect(new DemoUnionAdapter(base).listOrders(win, {}, ctx)).rejects.toMatchObject({
      code: 'adapter_unimplemented',
    });
    await expect(
      new DemoUnionAdapter({ ...base, orderStream: [] }).listOrders(win, {}, ctx),
    ).resolves.toEqual({ items: [], nextCursor: null });
  }
});
