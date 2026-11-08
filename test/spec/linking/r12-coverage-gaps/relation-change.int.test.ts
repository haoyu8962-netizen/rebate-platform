// B1-04zzzzi (R-12 coverage gap): BR-ATTR-05 细则「缓存键」— 身份含归因参数（淘宝为绑定的联盟账号与
// relation_id）；归因参数有任何变化时旧条目不得命中。The frozen open-taobao case covers a change
// after the 15-minute TTL only; here the relation_id changes within the TTL. The Taobao open is
// composed as in the frozen kit, over the real Redis jump cache of the assembled admin entry.
import { expect, it, vi } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import { redisOf } from '../../admin/step-up/kit.ts';
import { codeJump, compose, setup as openSetup } from '../open-taobao/kit.ts';
import {
  createRedisJumpCache,
  LINK_JUMP_REDIS_NAMESPACE,
} from '../../../../apps/api/src/modules/linking/infra/jump-cache.ts';
import type {
  LinkOpenCacheKey,
  LinkOpenCachedJump,
} from '../../../../apps/api/src/modules/linking/index.ts';
import { setup } from '../admin-union-bindings/kit.ts';

const h = useHarness();

async function scenario() {
  const open = await openSetup(h.db);
  await open.bind('active');
  const s = await setup(h, {
    appId: open.appId,
    userId: open.a,
    now: open.f.clock.now().toISOString(),
  });
  const redis = (await redisOf(s.f)).namespace(LINK_JUMP_REDIS_NAMESPACE);
  const real = createRedisJumpCache(redis, open.f.clock, { warn: vi.fn() });
  const reader = createRedisJumpCache(redis, open.f.clock, { warn: vi.fn() });
  const cache = {
    get: vi.fn((key: LinkOpenCacheKey) => real.get(key)),
    put: vi.fn((key: LinkOpenCacheKey, value: LinkOpenCachedJump) => real.put(key, value)),
  };
  const purchase = compose(open, { cache });
  const lastLog = async () => (await open.logs()).at(-1);
  return { open, cache, reader, purchase, lastLog };
}

const CHANGES = [
  ['同一绑定行的 relation_id 被改写', 'update'],
  ['释放后以新 relation_id 重新绑定', 'rebind'],
] as const;

it.each(CHANGES)(
  '[AC-B1-04zzzzi#3] 有效期内 relation_id 变化（%s）：不命中旧 relation 的缓存，按新 relation 重新出指令并写入',
  async (_label, change) => {
    const { open, cache, reader, purchase, lastLog } = await scenario();
    codeJump(await purchase(), open, 'self_buy', 'rel-A');
    expect(await lastLog()).toMatchObject({ cache_hit: false, result_code: 0 });
    expect(cache.put).toHaveBeenCalledTimes(1);
    const key = cache.put.mock.calls[0]![0];
    const old = (await reader.get(key))!;
    expect(JSON.stringify(old)).toContain('rel-A');

    // Still well within the TTL (seconds, not 15 minutes).
    open.f.clock.advanceMs(3001);
    if (change === 'update') {
      await open.db
        .updateTable('union_bindings')
        .set({ relation_id: 'rel-A-next' })
        .where('app_id', '=', open.appId)
        .where('user_id', '=', open.a)
        .execute();
    } else {
      await open.db
        .updateTable('union_bindings')
        .set({
          status: 'released',
          released_at: open.f.clock.now(),
          cooldown_until: open.f.clock.now(),
        })
        .where('app_id', '=', open.appId)
        .where('user_id', '=', open.a)
        .execute();
      await open.bind('active', open.a, 'rel-A-next');
    }
    // The old entry is still alive under the same key: a miss here comes from the identity.
    expect(await reader.get(key)).toEqual(old);
    const getsBefore = cache.get.mock.calls.length;

    const data = codeJump(await purchase(), open, 'self_buy', 'rel-A-next');
    expect(JSON.stringify(data)).not.toContain('"rel-A"');
    expect(await lastLog()).toMatchObject({ cache_hit: false, result_code: 0 });
    expect(cache.get.mock.calls.length).toBeGreaterThan(getsBefore);
    expect(cache.put).toHaveBeenCalledTimes(2);
    const rewritten = (await reader.get(key))!;
    expect(JSON.stringify(rewritten)).toContain('rel-A-next');
    expect(JSON.stringify(rewritten)).not.toContain('"rel-A"');

    // The new identity's entry is then a hit.
    open.f.clock.advanceMs(3001);
    codeJump(await purchase(), open, 'self_buy', 'rel-A-next');
    expect(await lastLog()).toMatchObject({ cache_hit: true, result_code: 0 });
    expect(cache.put).toHaveBeenCalledTimes(2);
  },
);

it('[AC-B1-04zzzzi#4] 对照：有效期内 relation_id 不变时命中同一缓存条目，不重新写入', async () => {
  const { open, cache, reader, purchase, lastLog } = await scenario();
  codeJump(await purchase(), open, 'self_buy', 'rel-A');
  expect(await lastLog()).toMatchObject({ cache_hit: false, result_code: 0 });
  expect(cache.put).toHaveBeenCalledTimes(1);
  const key = cache.put.mock.calls[0]![0];
  const stored = (await reader.get(key))!;
  for (let i = 0; i < 2; i += 1) {
    open.f.clock.advanceMs(3001);
    codeJump(await purchase(), open, 'self_buy', 'rel-A');
    expect(await lastLog()).toMatchObject({ cache_hit: true, result_code: 0 });
  }
  expect(cache.put).toHaveBeenCalledTimes(1);
  expect(await reader.get(key)).toEqual(stored);
});
