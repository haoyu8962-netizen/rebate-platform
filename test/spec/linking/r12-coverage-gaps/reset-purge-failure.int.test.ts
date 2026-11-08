// B1-04zzzzi (R-12 coverage gap): BR-ATTR-05 细则「缓存键」— 后台重置绑定时尽力清除该用户的转链缓存，
// 清除失败不影响重置；缓存不替代授权校验（重置后 open 先按绑定答 30101，读不到缓存外跳）。
// The reset runs through the assembled admin entry (HTTP, real database and Redis). Only the
// Redis reply to the purge's own write is refused (an error reply, as a read-only replica gives);
// every other Redis command passes through, so the cached entries really stay alive.
import { expect, it, vi } from 'vitest';
import { apiRequire, useHarness } from '../../admin/auth/kit.ts';
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
import { accepted, current, REASON, setup } from '../admin-union-bindings/kit.ts';

const h = useHarness();
const CANARY = 'synthetic-redis-refusal-canary';
const CACHED_URL = 'https://example.invalid/synthetic-cached-jump';

type Call = (this: unknown, ...args: unknown[]) => Promise<unknown>;
const { Redis } = apiRequire('ioredis') as { Redis: { prototype: { call: Call } } };

/** Refuses only SETs of a per-user generation key in the jump-cache namespace. */
function refusePurgeWrites() {
  const original = Redis.prototype.call;
  const refused: string[] = [];
  const spy = vi.spyOn(Redis.prototype, 'call').mockImplementation(function (
    this: unknown,
    ...args: unknown[]
  ) {
    const [command, key] = args;
    if (
      typeof command === 'string' &&
      command.toUpperCase() === 'SET' &&
      typeof key === 'string' &&
      key.startsWith(`${LINK_JUMP_REDIS_NAMESPACE}:`) &&
      key.includes(':g:')
    ) {
      refused.push(key);
      return Promise.reject(Object.assign(new Error(CANARY), { name: 'ReplyError' }));
    }
    return original.apply(this, args);
  });
  return { spy, refused };
}

it('[AC-B1-04zzzzi#1] reset 清转链缓存失败：重置照常生效（状态、审计），只记一条不带敏感值的 warn，之后 open 30101 不读旧缓存外跳', async () => {
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
  // A synthetic entry of the same user beside the one the open itself caches.
  const extra: LinkOpenCacheKey = {
    appId: s.appId,
    userId: s.userId,
    platform: 'taobao',
    productKey: 'tb:synthetic_other',
    rawItemId: '456',
    pid: 'mm_1_2_3',
    pidScene: 'self_buy',
    noRebate: false,
  };
  const stored = {
    jump: {
      primary: { type: 'h5' as const, value: CACHED_URL },
      fallbacks: [],
      expire_at: new Date(open.f.clock.now().getTime() + 600_000).toISOString(),
    },
    fetchedAt: open.f.clock.now().toISOString(),
  };
  await real.put(extra, stored);

  const purchase = compose(open, { cache });
  codeJump(await purchase(), open);
  expect(cache.put).toHaveBeenCalledTimes(1);
  const key = cache.put.mock.calls[0]![0];
  const instruction = (await reader.get(key))!;
  expect(instruction).not.toBeNull();
  // Control: within the TTL the same identity is a hit.
  open.f.clock.advanceMs(3001);
  codeJump(await purchase(), open);
  expect((await open.logs()).at(-1)).toMatchObject({ cache_hit: true, result_code: 0 });

  const row = (await s.rows())[0]!;
  const auditsBefore = await s.audits();
  const token = await s.issue();
  const linesBefore = s.f.lines.length;
  const { spy, refused } = refusePurgeWrites();
  let response: Awaited<ReturnType<typeof s.post>>;
  try {
    response = await s.post(
      'reset',
      { reason: REASON, expected_row_version: row.row_version },
      { token },
    );
  } finally {
    spy.mockRestore();
  }
  // The purge was attempted and refused (else this case proves nothing).
  expect(refused.length).toBeGreaterThanOrEqual(1);

  // The reset stands: response, row and audit as on any reset.
  const data = await accepted(response);
  expect(data).toMatchObject({ platform: 'taobao', status: 'released', reason: REASON });
  expect(await current(s, row.id)).toMatchObject({
    status: 'released',
    reason: REASON,
    released_at: expect.any(Date),
    cooldown_until: expect.any(Date),
  });
  const audits = await s.audits();
  expect(audits).toHaveLength(auditsBefore.length + 1);
  expect(audits.at(-1)).toMatchObject({ action: 'union_binding_reset' });

  // Exactly one warn about the failed purge, flat fields only, no sensitive value.
  const logged = s.f.lines
    .slice(linesBefore)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const warns = logged.filter((line) => line['event'] === 'linking.admin.jump_cache_purge_failed');
  expect(warns).toHaveLength(1);
  const warn = warns[0]!;
  expect(warn).toMatchObject({ level: 40, app_id: s.appId, platform: 'taobao' });
  expect(typeof warn['reason']).toBe('string');
  const text = JSON.stringify(warn);
  for (const secret of [
    s.userId,
    'rel-A',
    CANARY,
    CACHED_URL,
    REASON,
    token,
    open.row.link_id,
    ...refused,
  ]) {
    expect(text).not.toContain(secret);
  }

  // The purge really failed: both cached entries are still readable ...
  expect(await reader.get(key)).toEqual(instruction);
  expect(await reader.get(extra)).toEqual(stored);
  // ... yet the open answers 30101 from the binding and never hands out a cached jump.
  open.f.clock.advanceMs(3001);
  const attemptsBefore = await open.attempts();
  const putsBefore = cache.put.mock.calls.length;
  const result = await purchase();
  expect(result).toMatchObject({ status: 422, envelope: { code: 30101 } });
  expect(result.envelope.data ?? {}).not.toHaveProperty('jump');
  const serialized = JSON.stringify(result);
  for (const leaked of ['rel-A', CACHED_URL, '"sdk"', 'taoke']) {
    expect(serialized).not.toContain(leaked);
  }
  expect(await open.attempts()).toEqual(attemptsBefore);
  expect(cache.put.mock.calls.length).toBe(putsBefore);
  expect((await open.logs()).at(-1)).not.toMatchObject({ cache_hit: true });
});

it('[AC-B1-04zzzzi#2] reset 清缓存失败后有效期内以新 relation_id 重新绑定：不命中旧条目，按新身份重新出指令', async () => {
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
  codeJump(await purchase(), open);
  const key = cache.put.mock.calls[0]![0];
  const instruction = (await reader.get(key))!;
  expect(JSON.stringify(instruction)).toContain('rel-A');

  const row = (await s.rows())[0]!;
  const token = await s.issue();
  const { spy, refused } = refusePurgeWrites();
  let response: Awaited<ReturnType<typeof s.post>>;
  try {
    response = await s.post(
      'reset',
      { reason: REASON, expected_row_version: row.row_version },
      { token },
    );
  } finally {
    spy.mockRestore();
  }
  expect(refused.length).toBeGreaterThanOrEqual(1);
  await accepted(response);
  expect(await reader.get(key)).toEqual(instruction);

  // Rebound within the TTL (synthetic row, cooldown not under test) under a new relation_id.
  await open.bind('active', open.a, 'rel-A-rebound');
  open.f.clock.advanceMs(3001);
  const putsBefore = cache.put.mock.calls.length;
  codeJump(await purchase(), open, 'self_buy', 'rel-A-rebound');
  expect((await open.logs()).at(-1)).toMatchObject({ cache_hit: false, result_code: 0 });
  expect(cache.put.mock.calls.length).toBe(putsBefore + 1);
  expect(JSON.stringify(await reader.get(key))).toContain('rel-A-rebound');
});
