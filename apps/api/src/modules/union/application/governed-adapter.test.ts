import { expect, it, vi } from 'vitest';
import {
  createResilienceRegistry,
  type QuotaLimiter,
  type Scheduler,
} from '../../platform/index.ts';
import {
  createGovernedAdapter,
  makeUnionItem,
  UnionError,
  UnionIdentity,
  type CallCtx,
  type UnionAdapter,
  type UnionEndpoint,
  type UnionErrorCode,
} from '../index.ts';

// Local unit-test identifiers; not AC-LINK / AC-ORD acceptance.
const online: CallCtx = { appId: 'app-a', requestId: 'req-1', purpose: 'online' };
const endpoint: UnionEndpoint = {
  platform: 'jd',
  mode: 'replay',
  baseUrl: 'http://wiremock:8080/jd',
  quotaKey: 'account:jd',
};
const quota: QuotaLimiter = { bucketKey: 'account:jd', tryAcquire: () => true };
/**
 * Time stands still: backoff waits (under the 3 s online timeout) resolve at once, the timeout
 * wait only ends when it is cancelled. Every attempt therefore falls in one breaker window.
 */
const scheduler: Scheduler = {
  now: () => 0,
  sleep: (ms, signal) =>
    ms < 3000
      ? Promise.resolve()
      : new Promise<void>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
};
const item = makeUnionItem(
  {
    platform: 'jd',
    itemId: 'item-A',
    skuId: null,
    title: 'unit',
    price_fen: '100',
    coupon_fen: '0',
    final_price_fen: '100',
    commission_percent: '1',
  },
  { now: () => new Date('2026-10-06T00:00:00Z') },
);

function failingAdapter(
  code: UnionErrorCode,
  outcome: () => 'throw' | 'ok' = () => 'throw',
): { adapter: UnionAdapter; attempts: () => number } {
  let attempts = 0;
  const read = async (): Promise<typeof item> => {
    attempts += 1;
    if (outcome() === 'throw') throw new UnionError(code, 'synthetic', 'jd');
    return item;
  };
  return {
    attempts: () => attempts,
    adapter: {
      platform: 'jd',
      searchItems: async () => ({ items: [await read()], nextCursor: null }),
      getItem: read,
      resolveLink: async () => ({ item: { platform: 'jd', itemId: 'item-A' } }),
      convert: async () => ({ kind: 'url', url: 'https://example.invalid/result' }),
      listOrders: async () => ({ items: [], nextCursor: null }),
    },
  };
}

it.each(['item_unavailable', 'link_unrecognized', 'upstream_rejected'] as const)(
  '[AC-B1-04b-UNIT#1] 业务拒绝 %s 不重试',
  async (code) => {
    const { adapter, attempts } = failingAdapter(code);
    const port = createGovernedAdapter(adapter, { endpoint, scheduler, quota });
    await expect(port.getItem({ platform: 'jd', itemId: 'item-A' }, online)).rejects.toMatchObject({
      code,
    });
    expect(attempts()).toBe(1);
  },
);

it.each(['upstream_unavailable', 'rate_limited'] as const)(
  '[AC-B1-04b-UNIT#2] 依赖故障 %s 按幂等读重试两次',
  async (code) => {
    const { adapter, attempts } = failingAdapter(code);
    const port = createGovernedAdapter(adapter, { endpoint, scheduler, quota });
    await expect(port.getItem({ platform: 'jd', itemId: 'item-A' }, online)).rejects.toMatchObject({
      code,
    });
    expect(attempts()).toBe(3);
  },
);

it('[AC-B1-14d-UNIT#1] 在线重试次数取登记表 union.search 行；离线仍按 unionPolicy(offline)', async () => {
  const resilience = createResilienceRegistry({ 'union.search': { retries: { maxRetries: 0 } } });
  const { adapter, attempts } = failingAdapter('upstream_unavailable');
  const port = createGovernedAdapter(adapter, { endpoint, scheduler, quota, resilience });
  const ref = { platform: 'jd', itemId: 'item-A' } as const;
  await expect(port.getItem(ref, online)).rejects.toMatchObject({ code: 'upstream_unavailable' });
  expect(attempts()).toBe(1);
  const offline: CallCtx = { ...online, purpose: 'order_sync' };
  await expect(port.getItem(ref, offline)).rejects.toMatchObject({ code: 'upstream_unavailable' });
  expect(attempts()).toBe(4);
});

it('[AC-B1-04b-UNIT#3] 业务拒绝不计入熔断：大量拒绝之后调用仍到达适配器', async () => {
  let calls = 0;
  const { adapter } = failingAdapter('item_unavailable', () => (++calls <= 30 ? 'throw' : 'ok'));
  const port = createGovernedAdapter(adapter, { endpoint, scheduler, quota });
  for (let i = 0; i < 30; i += 1) {
    await expect(port.getItem({ platform: 'jd', itemId: 'item-A' }, online)).rejects.toMatchObject({
      code: 'item_unavailable',
    });
  }
  await expect(port.getItem({ platform: 'jd', itemId: 'item-A' }, online)).resolves.toBe(item);
});

it('[AC-B1-04b-UNIT#4] 依赖故障计入熔断：达到阈值后熔断', async () => {
  const { adapter, attempts } = failingAdapter('upstream_unavailable');
  const port = createGovernedAdapter(adapter, { endpoint, scheduler, quota });
  for (let i = 0; i < 7; i += 1) {
    await expect(port.getItem({ platform: 'jd', itemId: 'item-A' }, online)).rejects.toThrow();
  }
  const before = attempts();
  await expect(port.getItem({ platform: 'jd', itemId: 'item-A' }, online)).rejects.toMatchObject({
    code: 'circuit_open',
  });
  expect(attempts()).toBe(before);
});

it('[AC-B1-04i-UNIT#1] 详情端口按幂等读包装：依赖故障重试，缺省时不出现', async () => {
  let attempts = 0;
  const { adapter } = failingAdapter('upstream_unavailable');
  const order = { platform: 'jd' as const, order_id: 'o-1', paid_fen: 1n, commission_fen: 0n };
  const port = createGovernedAdapter(
    {
      ...adapter,
      getPddOrderDetail: async () => {
        attempts += 1;
        if (attempts === 1) throw new UnionError('rate_limited', 'synthetic', 'jd');
        return order;
      },
    },
    { endpoint, scheduler, quota },
  );
  expect(await port.getPddOrderDetail!('o-1', online)).toBe(order);
  expect(attempts).toBe(2);
  expect(createGovernedAdapter(adapter, { endpoint, scheduler, quota }).getPddOrderDetail).toBe(
    undefined,
  );
});

const sync: CallCtx = { appId: 'app-a', requestId: 'req-2', purpose: 'order_sync' };

it('[AC-B1-04w-UNIT#1] 调用方传入的 gateUpstream 不会传给未声明逐请求计量的端口', async () => {
  const seen: CallCtx[] = [];
  const { adapter } = failingAdapter('upstream_unavailable', () => 'ok');
  const port = createGovernedAdapter(
    {
      ...adapter,
      listOrders: async (_win, _opt, call) => {
        seen.push(call);
        return { items: [], nextCursor: null };
      },
    },
    { endpoint, scheduler, quota },
  );
  const forged = vi.fn(async () => {
    throw new Error('forged gate');
  });
  const window = { from: '2026-10-06T00:00:00Z', to: '2026-10-06T01:00:00Z' };
  await port.listOrders(window, {}, { ...sync, gateUpstream: forged });
  expect(seen).toHaveLength(1);
  expect(seen[0]).not.toHaveProperty('gateUpstream');
  expect(seen[0]!.signal).toBeInstanceOf(AbortSignal);
  expect(forged).not.toHaveBeenCalled();
});

it('[AC-B1-04w-UNIT#2] 逐请求计量：每次门控请求扣一个 token；调用方取消后不再发下一次请求', async () => {
  const take = vi.fn(() => true);
  const controller = new AbortController();
  let sent = 0;
  const { adapter } = failingAdapter('upstream_unavailable', () => 'ok');
  const port = createGovernedAdapter(
    {
      ...adapter,
      listOrdersMetering: 'per_request',
      listOrders: async (_win, _opt, call) => {
        expect(call.signal).toBeUndefined();
        const gate = call.gateUpstream!;
        for (let i = 0; i < 3; i += 1) {
          await gate(async (signal) => {
            expect(signal).toBeInstanceOf(AbortSignal);
            sent += 1;
            if (sent === 2) controller.abort(new Error('caller stopped'));
          });
        }
        return { items: [], nextCursor: null };
      },
    },
    { endpoint, scheduler, quota: { bucketKey: quota.bucketKey, tryAcquire: take } },
  );
  const window = { from: '2026-10-06T00:00:00Z', to: '2026-10-06T01:00:00Z' };
  await expect(port.listOrders(window, {}, { ...sync, signal: controller.signal })).rejects.toThrow(
    'caller stopped',
  );
  expect(sent).toBe(2);
  expect(take).toHaveBeenCalledTimes(2);
});

it('[AC-B1-04z-UNIT#1] 维权 / 违规逐请求计量：opt 原样透传，每次门控请求扣一个 token，伪造的 gateUpstream 被换掉', async () => {
  const take = vi.fn(() => true);
  const seen: unknown[] = [];
  const { adapter } = failingAdapter('upstream_unavailable', () => 'ok');
  const forged = vi.fn(async () => {
    throw new Error('forged gate');
  });
  const port = createGovernedAdapter(
    {
      ...adapter,
      listRefundsMetering: 'per_request',
      listPunishmentsMetering: 'per_request',
      listRefunds: async (_win, call, ...opt) => {
        seen.push(opt);
        expect(call.signal).toBeUndefined();
        await call.gateUpstream!(async () => undefined);
        await call.gateUpstream!(async () => undefined);
        return { items: [], nextCursor: null };
      },
      listPunishments: async (_win, call, ...opt) => {
        seen.push(opt);
        await call.gateUpstream!(async () => undefined);
        return { items: [], nextCursor: null };
      },
    },
    { endpoint, scheduler, quota: { bucketKey: quota.bucketKey, tryAcquire: take } },
  );
  const window = { from: '2026-10-06T00:00:00Z', to: '2026-10-06T01:00:00Z' };
  const caller = { ...sync, gateUpstream: forged };
  await port.listRefunds!(window, caller, { cursor: 'c-1', timeBasis: 'settle' });
  await port.listRefunds!(window, caller);
  await port.listPunishments!(window, caller, { cursor: 'c-2' });
  expect(seen).toEqual([[{ cursor: 'c-1', timeBasis: 'settle' }], [], [{ cursor: 'c-2' }]]);
  expect(take).toHaveBeenCalledTimes(5);
  expect(forged).not.toHaveBeenCalled();
});

it('[AC-B1-04z-UNIT#2] 未声明逐请求计量的维权端口整体按幂等读治理，opt 照样透传', async () => {
  const take = vi.fn(() => true);
  const seen: unknown[] = [];
  const { adapter } = failingAdapter('upstream_unavailable', () => 'ok');
  const port = createGovernedAdapter(
    {
      ...adapter,
      listRefunds: async (_win, call, ...opt) => {
        seen.push(opt);
        expect(call).not.toHaveProperty('gateUpstream');
        expect(call.signal).toBeInstanceOf(AbortSignal);
        return { items: [], nextCursor: null };
      },
    },
    { endpoint, scheduler, quota: { bucketKey: quota.bucketKey, tryAcquire: take } },
  );
  const window = { from: '2026-10-06T00:00:00Z', to: '2026-10-06T01:00:00Z' };
  await port.listRefunds!(window, sync, { cursor: 'c-3' });
  expect(seen).toEqual([[{ cursor: 'c-3' }]]);
  expect(take).toHaveBeenCalledTimes(1);
});

class ShopIdentity extends UnionIdentity {
  constructor() {
    super({
      appId: 'app-a',
      userId: 'user-a',
      platform: 'taobao',
      promotionSlot: 'mm_1_2_3',
      relationId: 'rel-a',
    });
  }
}

const taobaoEndpoint: UnionEndpoint = {
  platform: 'taobao',
  mode: 'replay',
  baseUrl: 'http://wiremock:8080/taobao',
  quotaKey: 'account:taobao',
};

it.each(['upstream_unavailable', 'rate_limited'] as const)(
  '[AC-B1-04zzt-UNIT#10] convertShop 按写操作：%s 只调一次；调用方 purpose 非 online 也只取 online 令牌',
  async (code) => {
    const take = vi.fn<QuotaLimiter['tryAcquire']>(() => true);
    const purposes: string[] = [];
    let attempts = 0;
    const port = createGovernedAdapter(
      {
        platform: 'taobao',
        searchItems: async () => ({ items: [], nextCursor: null }),
        getItem: async () => item,
        resolveLink: async () => ({ item: { platform: 'taobao', item_id: 'x' } }),
        convert: async () => ({ kind: 'url', url: 'https://s.click.taobao.com/x' }),
        listOrders: async () => ({ items: [], nextCursor: null }),
        shopConvertSources: ['dataoke'],
        convertShop: async (_req, _who, call) => {
          attempts += 1;
          purposes.push(call.purpose);
          throw new UnionError(code, 'synthetic', 'taobao');
        },
      },
      {
        endpoint: taobaoEndpoint,
        scheduler,
        quota: { bucketKey: taobaoEndpoint.quotaKey, tryAcquire: take },
      },
    );
    const req = { shopRef: '1', shopName: 'shop' };
    await expect(port.convertShop!(req, new ShopIdentity(), sync)).rejects.toMatchObject({ code });
    expect(attempts).toBe(1);
    expect(purposes).toEqual(['online']);
    expect(take.mock.calls).toEqual([['online']]);
  },
);
