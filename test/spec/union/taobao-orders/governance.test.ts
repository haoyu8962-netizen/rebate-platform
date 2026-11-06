import { expect, it, vi } from 'vitest';
import type { QuotaLimiter } from '../../../../apps/api/src/modules/platform/index.ts';
import type {
  UnionAdapter,
  UpstreamGate,
} from '../../../../apps/api/src/modules/union/domain/types.ts';
import { collect, ctx, govern, positionOf, rowOf, setup, walk, win, windowAnswer } from './kit.ts';

// 计量照拼多多（B1-04w）：listOrdersMetering = 'per_request'，每个上游请求经 CallCtx.gateUpstream 各取
// 一个配额（用途 order_sync），取消信号是该次尝试的；调用方伪造的 gateUpstream 被包装层换掉。
// raw_payload_id 照 B1-04p / B1-08e：取传输回传的该页归档行 id，没有为 null。

const W0 = '2026-10-30 10:00:00';
const pages = [[rowOf(1)], [rowOf(2)], [rowOf(3)]];
const ids = pages.flat().map((input) => input.trade_id);

it('[AC-B1-04f#44] 适配器声明 listOrdersMetering = per_request', () => {
  const adapter: UnionAdapter = setup().adapter;
  expect(adapter.listOrdersMetering).toBe('per_request');
});

it('[AC-B1-04f#45] 每个上游请求前恰取一次配额（order_sync），每次尝试的取消信号各不相同', async () => {
  const events: string[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  const answer = windowAnswer({ [W0]: pages });
  const s = setup((q, signal) => {
    events.push(`request:${q.positionIndex ?? 'first'}`);
    signals.push(signal);
    return answer(q, signal);
  });
  const take = vi.fn<QuotaLimiter['tryAcquire']>((purpose) => {
    events.push(`quota:${purpose}`);
    return true;
  });
  const { orders } = await collect(govern(s.adapter, take));
  expect(orders.map((order) => order.order_id)).toEqual(ids);
  expect(events).toEqual([
    'quota:order_sync',
    'request:first',
    'quota:order_sync',
    `request:${positionOf(0, 0)}`,
    'quota:order_sync',
    `request:${positionOf(0, 1)}`,
  ]);
  expect(signals.every((signal) => signal instanceof AbortSignal)).toBe(true);
  expect(new Set(signals).size).toBe(3);
});

it.each([1, 2])(
  '[AC-B1-04f#46] 配额只够 %i 次时传输层恰收到这么多次，以 quota_exceeded 结束，不从首页重来',
  async (budget) => {
    let remaining = budget;
    const s = setup(windowAnswer({ [W0]: pages }));
    const take = vi.fn<QuotaLimiter['tryAcquire']>(() => remaining-- > 0);
    await expect(walk(govern(s.adapter, take))).rejects.toMatchObject({ code: 'quota_exceeded' });
    expect(s.transport).toHaveBeenCalledTimes(budget);
    expect(s.requests.map((q) => q.positionIndex)).toEqual(
      [undefined, positionOf(0, 0)].slice(0, budget),
    );
    expect(take).toHaveBeenCalledTimes(budget + 1);
  },
);

it('[AC-B1-04f#47] 推广位清单为空时不发请求，也不取配额', async () => {
  const s = setup(windowAnswer({ [W0]: pages }), { slots: [] });
  const take = vi.fn<QuotaLimiter['tryAcquire']>(() => true);
  const { rejection } = await import('./kit.ts');
  await rejection(() => govern(s.adapter, take).listOrders(win, {}, ctx), 'adapter_unimplemented');
  expect(s.transport).not.toHaveBeenCalled();
  expect(take).not.toHaveBeenCalled();
  expect(s.orderSlots).toHaveBeenCalledTimes(1);
});

it('[AC-B1-04f#48] 调用方伪造的 gateUpstream 被包装层换掉，翻页不绕过配额', async () => {
  const s = setup(windowAnswer({ [W0]: pages }));
  const take = vi.fn<QuotaLimiter['tryAcquire']>(() => true);
  const forged = vi.fn(() => {
    throw new Error('forged gate must not run');
  });
  const caller = { ...ctx, gateUpstream: forged as unknown as UpstreamGate };
  const { orders } = await collect(govern(s.adapter, take), win, {}, caller);
  expect(orders.map((order) => order.order_id)).toEqual(ids);
  expect(forged).not.toHaveBeenCalled();
  expect(take).toHaveBeenCalledTimes(s.transport.mock.calls.length);
  expect(s.transport).toHaveBeenCalledTimes(3);
});

it('[AC-B1-04f#49] raw_payload_id 取该页响应的归档行 id（各页各自的），未归档为 null', async () => {
  const archived = setup(
    windowAnswer({ [W0]: [[rowOf(1), rowOf(2)], [rowOf(3)]] }, (_w, index) => `${9001 + index}`),
  );
  const { orders } = await collect(archived.adapter);
  expect(orders.map((order) => [order.order_id, order.raw_payload_id])).toEqual([
    [rowOf(1).trade_id, '9001'],
    [rowOf(2).trade_id, '9001'],
    [rowOf(3).trade_id, '9002'],
  ]);

  const plain = setup(windowAnswer({ [W0]: [[rowOf(1)]] }));
  const result = await collect(plain.adapter);
  expect(result.orders.map((order) => order.raw_payload_id)).toEqual([null]);
});
