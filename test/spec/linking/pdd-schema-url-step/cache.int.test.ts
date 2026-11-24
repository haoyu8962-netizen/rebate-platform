import { createTestDatabase } from '@couli/db/testing';
import { expect, it, vi } from 'vitest';
import { createLinkConvert } from '../../../../apps/api/src/modules/linking/application/link-convert.ts';
import { createRedisJumpCache } from '../../../../apps/api/src/modules/linking/infra/jump-cache.ts';
import type { RedisNamespace } from '../../../../apps/api/src/modules/platform/index.ts';
import { databaseFixture, fixture, validate } from '../convert/kit.ts';

const database = databaseFixture(createTestDatabase);

it('[AC-B1-06zp#3] 旧版仅 H5 的缓存未过期也要重新转链，新缓存命中时保留回包 scheme 与网页', async () => {
  const f = await fixture(database(), 'pdd');
  const store = new Map<string, string>();
  const redis: RedisNamespace = {
    get: async (key) => store.get(key) ?? null,
    set: async (key, value) => {
      store.set(key, value);
    },
    eval: async () => null,
  };
  const cache = createRedisJumpCache(redis, f.f.clock, f.options.logger);
  const put = vi.spyOn(cache, 'put');
  const options = { ...f.options, cache };
  const request = () => f.request({ installed: 'true' });

  // 先通过购买用例取得同一商品、推广位及授权的缓存身份。
  const initial = await createLinkConvert(options).convert(request());
  expect(initial).toMatchObject({ status: 200, envelope: { code: 0 } });
  expect(f.convert).toHaveBeenCalledTimes(1);
  expect(put).toHaveBeenCalledTimes(1);
  const [key, value] = put.mock.calls[0]!;
  const legacyKey = { ...key, variant: 'ios:true' };
  const legacyValue = {
    ...value,
    variant: legacyKey.variant,
    jump: {
      ...value.jump,
      primary: { type: 'h5' as const, value: 'https://example.test/old-purchase' },
      fallbacks: [],
    },
  };
  store.clear();
  await cache.put(legacyKey, legacyValue);
  expect(await cache.get(legacyKey)).toEqual(legacyValue);

  const schemaUrl = 'pinduoduo://synthetic/landing?opaque=app%2fdata';
  const mobileUrl = 'https://example.test/new-purchase?opaque=web%2fdata';
  f.convert.mockResolvedValueOnce({ kind: 'url', url: mobileUrl, schema_url: schemaUrl });
  const refreshed = await createLinkConvert(options).convert(request());
  expect(refreshed).toMatchObject({ status: 200, envelope: { code: 0 } });
  expect(f.convert).toHaveBeenCalledTimes(2);
  expect(put).toHaveBeenCalledTimes(3);
  expect(put.mock.lastCall?.[0].variant).toEqual(expect.any(String));
  expect(put.mock.lastCall?.[0].variant).not.toBe(legacyKey.variant);
  const steps = {
    primary: { type: 'scheme', value: schemaUrl },
    fallbacks: [{ type: 'h5', value: mobileUrl }],
  };
  expect(refreshed.envelope.data).toMatchObject({ jump: steps });
  await validate(refreshed.envelope, 'ConvertLinkResponse');

  // 缓存命中使用独立服务实例与新的幂等键。
  const cached = await createLinkConvert(options).convert(request());
  expect(cached).toMatchObject({ status: 200, envelope: { code: 0, data: { jump: steps } } });
  expect(f.convert).toHaveBeenCalledTimes(2);
  expect(put).toHaveBeenCalledTimes(3);
  expect(await f.logs()).toEqual([
    expect.objectContaining({ cache_hit: false }),
    expect.objectContaining({ cache_hit: false }),
    expect.objectContaining({ cache_hit: true }),
  ]);
}, 60_000);
