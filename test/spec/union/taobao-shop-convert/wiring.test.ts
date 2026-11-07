import { expect, it, vi } from 'vitest';
import { FixedClock, type Scheduler } from '../../../../apps/api/src/modules/platform/index.ts';
import { createGovernedAdapter } from '../../../../apps/api/src/modules/union/application/governed-adapter.ts';
import type {
  UnionAdapter,
  UnionEndpoint,
} from '../../../../apps/api/src/modules/union/domain/types.ts';
import type {
  DataokeCredentials,
  DataokeRandom,
} from '../../../../apps/api/src/modules/union/infra/dataoke/dataoke-client.ts';
import {
  JdUnionAdapter,
  type JdCredentials,
} from '../../../../apps/api/src/modules/union/infra/jd/jd-adapter.ts';
import {
  PddUnionAdapter,
  type PddCredentials,
} from '../../../../apps/api/src/modules/union/infra/pdd/pdd-adapter.ts';
import { createUnionRegistry } from '../../../../apps/api/src/modules/union/infra/registry.ts';
import type { UnionTransport } from '../../../../apps/api/src/modules/union/infra/replay.ts';
import type { TaobaoCredentials } from '../../../../apps/api/src/modules/union/infra/taobao/taobao-adapter.ts';
import {
  callShop,
  converted,
  ctx,
  DATAOKE_APP_KEY,
  DATAOKE_SECRET,
  endpoint,
  envelope,
  expectNothingSent,
  instant,
  RELATION_ID,
  response,
  SELF_SLOT,
  setup,
  SHOP_LINK,
  SHOP_NAME,
  SHOP_PATH,
  SHOP_REF,
  SHOP_VERSION,
  TAOBAO_APP_KEY,
  TAOBAO_SECRET,
  unionFailure,
} from './kit.ts';

// 声明口径：shopConvertSources = ['dataoke'] 只在淘宝 live 且注入了大淘客客户端时声明；京东、拼多多、
// demo 与未实现占位都不实现 convertShop（方法缺省）。

const clock = new FixedClock(instant);

it('[AC-B1-04zzt#30] 淘宝 live 注入大淘客客户端：声明 shopConvertSources = ["dataoke"] 并能转链；没注入：不声明，convertShop 不可用且不取不发', async () => {
  const wired = setup();
  expect(wired.adapter.shopConvertSources).toEqual(['dataoke']);
  const result = await converted(() => callShop(wired.adapter));
  expect(result.url).toBe(SHOP_LINK);
  expect(wired.dataokeTransport).toHaveBeenCalledTimes(1);

  const bare = setup({ withSource: false });
  const port: UnionAdapter = bare.adapter;
  expect(port.shopConvertSources).toBeUndefined();
  if (port.convertShop !== undefined) {
    await unionFailure(() => callShop(port), 'adapter_unimplemented');
  }
  expectNothingSent(bare);
});

// ---- registry ---------------------------------------------------------------------------------

const REGISTRY_GATEWAY = 'https://dataoke-shop-registry.invalid/gateway';

function liveEndpoints(): readonly UnionEndpoint[] {
  return [
    {
      platform: 'jd',
      mode: 'live',
      baseUrl: 'https://jd-shop.invalid/router',
      quotaKey: 'fake:jd',
    },
    {
      platform: 'pdd',
      mode: 'replay',
      baseUrl: 'https://pdd-shop.invalid/router',
      quotaKey: 'fake:pdd',
    },
    endpoint,
  ];
}

function registryWith(withSource: boolean) {
  const taobao = {
    credentials: vi.fn<() => Promise<TaobaoCredentials>>(async () => ({
      appKey: TAOBAO_APP_KEY,
      appSecret: TAOBAO_SECRET,
    })),
    transport: vi.fn<UnionTransport>(async () => response({})),
  };
  const orderSource = {
    credentials: vi.fn<() => Promise<DataokeCredentials>>(async () => ({
      appKey: DATAOKE_APP_KEY,
      appSecret: DATAOKE_SECRET,
    })),
    transport: vi.fn<UnionTransport>(async () => response(envelope())),
    random: vi.fn<DataokeRandom>().mockReturnValue(42),
    baseUrl: REGISTRY_GATEWAY,
  };
  const registry = createUnionRegistry({
    endpoints: liveEndpoints(),
    environment: 'staging',
    seed: 'fake-taobao-shop-convert',
    clock,
    taobaoLive: { ...taobao, ...(withSource ? { orderSource } : {}) },
  });
  return { registry, taobao, orderSource };
}

it('[AC-B1-04zzt#31] 注册表 taobaoLive + orderSource：淘宝适配器声明 ["dataoke"]，convertShop 经该网关的 /api/dels/shop/convert 转链', async () => {
  const { registry, taobao, orderSource } = registryWith(true);
  const adapter = registry.get('taobao');
  expect(adapter.shopConvertSources).toEqual(['dataoke']);
  const result = await converted(() => callShop(adapter));
  expect(result.url).toBe(SHOP_LINK);
  expect(orderSource.transport).toHaveBeenCalledTimes(1);
  const request = orderSource.transport.mock.calls[0]![0];
  expect(request.method).toBe('GET');
  const url = new URL(request.url);
  expect(`${url.origin}${url.pathname}`).toBe(`${REGISTRY_GATEWAY}${SHOP_PATH}`);
  expect(url.searchParams.get('version')).toBe(SHOP_VERSION);
  expect(url.searchParams.get('sellerId')).toBe(SHOP_REF);
  expect(url.searchParams.get('pid')).toBe(SELF_SLOT);
  expect(url.searchParams.get('shopName')).toBe(SHOP_NAME);
  expect(url.searchParams.get('relationId')).toBe(RELATION_ID);
  expect(request.archive).toEqual({ appId: ctx.appId, kind: 'convert' });
  expect(taobao.transport).not.toHaveBeenCalled();
  expect(taobao.credentials).not.toHaveBeenCalled();
});

it('[AC-B1-04zzt#32] 注册表 taobaoLive 没有 orderSource：不声明 shopConvertSources，convertShop 不可用且不取不发；有 orderSource 才声明', async () => {
  const off = registryWith(false);
  const adapter = off.registry.get('taobao');
  expect(adapter.shopConvertSources).toBeUndefined();
  if (adapter.convertShop !== undefined) {
    await unionFailure(() => callShop(adapter), 'adapter_unimplemented');
  }
  expect(off.orderSource.transport).not.toHaveBeenCalled();
  expect(off.orderSource.credentials).not.toHaveBeenCalled();
  expect(off.taobao.transport).not.toHaveBeenCalled();
  expect(off.taobao.credentials).not.toHaveBeenCalled();

  const on = registryWith(true);
  expect(on.registry.get('taobao').shopConvertSources).toEqual(['dataoke']);
});

// ---- other platforms --------------------------------------------------------------------------

const scheduler: Scheduler = {
  now: () => 0,
  sleep: (ms, signal) =>
    ms < 3000
      ? Promise.resolve()
      : new Promise<void>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
};

function govern(raw: UnionAdapter, at: UnionEndpoint): UnionAdapter {
  return createGovernedAdapter(raw, {
    endpoint: at,
    scheduler,
    quota: { bucketKey: at.quotaKey, tryAcquire: () => true },
  });
}

function demoEndpoints(): readonly UnionEndpoint[] {
  return (['jd', 'pdd', 'taobao'] as const).map((platform): UnionEndpoint => ({
    platform,
    mode: 'demo',
    baseUrl: null,
    quotaKey: `fake-shop-demo:${platform}`,
  }));
}

function otherAdapters(): readonly (readonly [string, UnionAdapter])[] {
  const jdEndpoint: UnionEndpoint = liveEndpoints()[0]!;
  const pddEndpoint: UnionEndpoint = { ...liveEndpoints()[1]!, mode: 'live' };
  const jd = new JdUnionAdapter({
    credentials: vi.fn<() => Promise<JdCredentials>>(async () => ({
      appKey: 'fake-jd-shop-key',
      appSecret: 'jds-jds-jds-jds',
    })),
    transport: vi.fn<UnionTransport>(async () => response({})),
    clock,
    endpoint: jdEndpoint,
  });
  const pdd = new PddUnionAdapter({
    credentials: vi.fn<() => Promise<PddCredentials>>(async () => ({
      clientId: 'fake-pdd-shop-client',
      clientSecret: 'pds-pds-pds-pds',
    })),
    transport: vi.fn<UnionTransport>(async () => response({})),
    clock,
    endpoint: pddEndpoint,
  });
  const demo = createUnionRegistry({
    endpoints: demoEndpoints(),
    environment: 'staging',
    seed: 'fake-shop-demo',
    clock,
  });
  const placeholder = createUnionRegistry();
  const demoTaobaoEndpoint = demoEndpoints()[2]!;
  return [
    ['jd live', jd],
    ['pdd live', pdd],
    ['jd demo', demo.get('jd')],
    ['pdd demo', demo.get('pdd')],
    ['taobao demo', demo.get('taobao')],
    ['governed taobao demo', govern(demo.get('taobao'), demoTaobaoEndpoint)],
    ['jd placeholder', placeholder.get('jd')],
    ['pdd placeholder', placeholder.get('pdd')],
    ['taobao placeholder', placeholder.get('taobao')],
  ];
}

it('[AC-B1-04zzt#33] 京东 / 拼多多 live、三个平台的 demo 与未实现占位都不实现 convertShop、不声明 shopConvertSources；淘宝 live 有大淘客客户端时（含治理包装后）两者都有', async () => {
  for (const [label, adapter] of otherAdapters()) {
    expect(adapter.convertShop, `${label} convertShop`).toBeUndefined();
    expect(adapter.shopConvertSources, `${label} shopConvertSources`).toBeUndefined();
  }

  const h = setup();
  const governed = govern(h.adapter, endpoint);
  expect(governed.shopConvertSources).toEqual(['dataoke']);
  const result = await converted(() => callShop(governed));
  expect(result.url).toBe(SHOP_LINK);
  expect(h.dataokeTransport).toHaveBeenCalledTimes(1);
});
