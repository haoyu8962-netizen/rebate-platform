import { expect, it, vi } from 'vitest';
import type { QuotaLimiter, Scheduler } from '../../../../apps/api/src/modules/platform/index.ts';
import { createGovernedAdapter } from '../../../../apps/api/src/modules/union/application/governed-adapter.ts';
import {
  UnionError,
  type CallCtx,
  type ShopConvertReq,
  type ShopConvertResult,
  type UnionAdapter,
  type UnionErrorCode,
  type UnionIdentity,
} from '../../../../apps/api/src/modules/union/domain/types.ts';
import {
  callShop,
  converted,
  ctx,
  endpoint,
  envelope,
  identity,
  response,
  setup,
  SHOP_LINK,
  shopReq,
  TestIdentity,
  TPWD,
  unionFailure,
} from './kit.ts';

// 治理口径：convertShop 经 governed-adapter 显式包装——在线、按写操作不重试（上游失败只调一次），
// 每次取一个 purpose online 的配额令牌；身份必须是服务端构造、同 app、同平台的（同商品转链）。
// shopConvertSources 原样透传；适配器没有的，包装上也没有。

// 注入固定调度器：退避立即结束，超时只等待取消；不读宿主时钟、不监听端口。
const scheduler: Scheduler = {
  now: () => 0,
  sleep: (ms, signal) =>
    ms < 3000
      ? Promise.resolve()
      : new Promise<void>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
};

function govern(raw: UnionAdapter, take: QuotaLimiter['tryAcquire'] = () => true): UnionAdapter {
  return createGovernedAdapter(raw, {
    endpoint,
    scheduler,
    quota: { bucketKey: endpoint.quotaKey, tryAcquire: take },
  });
}

function basicPorts(): UnionAdapter {
  return {
    platform: 'taobao',
    searchItems: async () => ({ items: [], nextCursor: null }),
    getItem: async () => {
      throw new UnionError('upstream_unavailable', 'synthetic read failure', 'taobao');
    },
    resolveLink: async () => ({ item: { platform: 'taobao', item_id: 'synthetic' } }),
    convert: async () => ({ kind: 'url', url: 'https://s.click.taobao.com/synthetic-item' }),
    listOrders: async () => ({ items: [], nextCursor: null }),
  };
}

interface ShopCall {
  readonly self: unknown;
  readonly req: ShopConvertReq;
  readonly who: UnionIdentity;
  readonly ctx: CallCtx;
}

const ANSWER: ShopConvertResult = { url: SHOP_LINK, tpwd: TPWD };

/** A taobao adapter that offers convertShop and records every call it receives. */
function shopAdapter(answer: () => Promise<ShopConvertResult> = async () => ANSWER) {
  const calls: ShopCall[] = [];
  const adapter: UnionAdapter = {
    ...basicPorts(),
    shopConvertSources: ['dataoke'],
    convertShop(req, who, call) {
      calls.push({ self: this, req, who, ctx: call });
      return answer();
    },
  };
  return { adapter, calls };
}

it('[AC-B1-04zzt#20] 治理包装保留适配器的 convertShop 与 shopConvertSources；适配器没有时包装上也没有', () => {
  const capable = govern(shopAdapter().adapter);
  expect(capable.convertShop).toBeTypeOf('function');
  expect(capable.shopConvertSources).toEqual(['dataoke']);
  const bare = govern(basicPorts());
  expect(bare.convertShop).toBeUndefined();
  expect(bare.shopConvertSources).toBeUndefined();
});

it('[AC-B1-04zzt#21] 治理包装下的 convertShop：原样传请求与身份、以原适配器为 this、换上配置的 URL 与新的 signal，取一个 online 配额令牌，结果原样返回', async () => {
  const fake = shopAdapter();
  const purposes: string[] = [];
  const governed = govern(fake.adapter, (purpose) => {
    purposes.push(purpose);
    return true;
  });
  const caller: CallCtx = Object.freeze({
    ...ctx,
    baseUrl: 'https://untrusted.invalid',
    headers: { injected: 'no' },
  });
  expect(await callShop(governed, shopReq, identity, caller)).toEqual(ANSWER);
  expect(fake.calls).toHaveLength(1);
  const call = fake.calls[0]!;
  expect(call.self).toBe(fake.adapter);
  expect(call.req).toEqual(shopReq);
  expect(call.who).toBe(identity);
  expect(call.ctx).toMatchObject({
    appId: ctx.appId,
    requestId: ctx.requestId,
    purpose: 'online',
    baseUrl: endpoint.baseUrl,
    headers: {},
    signal: expect.any(AbortSignal),
  });
  expect(purposes).toEqual(['online']);
  expect(caller).not.toHaveProperty('signal');
});

it.each(['upstream_unavailable', 'rate_limited'] as UnionErrorCode[])(
  '[AC-B1-04zzt#22] convertShop 遇 %s 按写操作不重试：适配器只被调一次、只取一个令牌（同包装下的幂等读会重试）',
  async (code) => {
    const fake = shopAdapter(async () => {
      throw new UnionError(code, 'synthetic dependency failure', 'taobao');
    });
    const take = vi.fn<QuotaLimiter['tryAcquire']>(() => true);
    const governed = govern(fake.adapter, take);
    await expect(callShop(governed)).rejects.toMatchObject({ code });
    expect(fake.calls).toHaveLength(1);
    expect(take.mock.calls).toEqual([['online']]);

    // 对照：同一包装下的幂等读遇到依赖故障会重试（说明「只调一次」来自写操作口径）。
    take.mockClear();
    const read = governed.getItem({ platform: 'taobao', item_id: 'synthetic' }, ctx);
    await expect(read).rejects.toMatchObject({ code: 'upstream_unavailable' });
    expect(take.mock.calls.length).toBeGreaterThan(1);
  },
);

it('[AC-B1-04zzt#23] 配额不足时 convertShop 不访问适配器：quota_exceeded；配额足时照常到达', async () => {
  const refused = shopAdapter();
  await expect(callShop(govern(refused.adapter, () => false))).rejects.toMatchObject({
    code: 'quota_exceeded',
  });
  expect(refused.calls).toHaveLength(0);

  const allowed = shopAdapter();
  expect(await callShop(govern(allowed.adapter))).toEqual(ANSWER);
  expect(allowed.calls).toHaveLength(1);
});

it.each([
  ['another app', () => new TestIdentity({ appId: 'another-synthetic-app' })],
  ['a pdd identity', () => new TestIdentity({ platform: 'pdd' })],
  [
    'a forged object with the identity prototype',
    () =>
      Object.assign(Object.create(TestIdentity.prototype) as object, {
        claims: identity.claims,
      }) as UnionIdentity,
  ],
])(
  '[AC-B1-04zzt#24] 治理包装拒绝 %s 的身份：invalid_identity，不取令牌、不访问适配器；同 app 的服务端身份照常到达',
  async (_label, make: () => UnionIdentity) => {
    const fake = shopAdapter();
    const take = vi.fn<QuotaLimiter['tryAcquire']>(() => true);
    const governed = govern(fake.adapter, take);
    await unionFailure(() => callShop(governed, shopReq, make()), 'invalid_identity');
    expect(fake.calls).toHaveLength(0);
    expect(take).not.toHaveBeenCalled();

    expect(await callShop(governed, shopReq, identity)).toEqual(ANSWER);
    expect(fake.calls).toHaveLength(1);
  },
);

it('[AC-B1-04zzt#25] 真实淘宝适配器经治理包装：convertShop 到达大淘客传输一次并带治理层的 signal', async () => {
  const h = setup();
  const governed = govern(h.adapter);
  const result = await converted(() => callShop(governed));
  expect(result.url).toBe(SHOP_LINK);
  expect(h.dataokeTransport).toHaveBeenCalledTimes(1);
  expect(h.dataokeTransport.mock.calls[0]![0].signal).toBeInstanceOf(AbortSignal);
});

it.each([
  ['HTTP 503', () => response(envelope(), 503)],
  ['outer code -1', () => response({ code: -1, msg: 'synthetic', data: {} })],
  ['outer code 10014 (throttled)', () => response({ code: 10014, msg: 'synthetic', data: {} })],
])(
  '[AC-B1-04zzt#26] 真实淘宝适配器经治理包装遇 %s：失败、大淘客传输只发一次（写操作不重试）',
  async (_label, answer) => {
    const h = setup({ reply: answer() });
    let failure: unknown;
    try {
      await callShop(govern(h.adapter));
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(UnionError);
    expect(failure).toMatchObject({ platform: 'taobao' });
    expect(h.dataokeTransport).toHaveBeenCalledTimes(1);
  },
);
