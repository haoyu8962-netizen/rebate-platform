import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { GovernanceError } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  UnionError,
  UnionIdentity,
  type UnionAdapter,
} from '../../../../apps/api/src/modules/union/index.ts';
import { databaseFixture } from '../open-requote/kit.ts';
import {
  ACTIVE_PID,
  ITEM_REF,
  MAX_TTL_SEC,
  PRODUCT_KEY,
  SECOND_PID,
  SHOP,
  compose,
  noAuthState,
  refusal,
  setup,
  shopJump,
  shopLink,
  untouched,
} from './kit.ts';

// B1-06zg 第 7、8 条：身份与淘宝 open 同一构造（本人 active 绑定的 relation_id + 该绑定账号的
// self_buy 推广位，BR-ATTR-05 / BR-ATTR-08 进店例外），jump 组装，任何转链失败 → 50303 且不带
// 任何店铺地址（BR-PRICE-21 细则「确保转链」）；不登记 link、不写 link_logs / 报价快照。
const database = databaseFixture(createTestDatabase);

it.each(['true', 'false', 'unknown'] as const)(
  '[AC-B1-06zg#22] installed=%s 成功：primary 百川 openByUrl、fallbacks 同址 h5，expire_at = now + 900s 默认',
  async (installed) => {
    const f = await setup(database());
    await f.bind('active');
    const result = await compose(f)(f.request({ body: { installed } }));
    const jump = shopJump(result, shopLink(SHOP.shopRef, 'rel-A'));
    expect(new Date(jump.expire_at).getTime()).toBe(f.clock.now().getTime() + MAX_TTL_SEC * 1000);
    expect(f.convertShop).toHaveBeenCalledTimes(1);
    await noAuthState(result, f);
  },
);

it('[AC-B1-06zg#23] 身份按当前用户注入：本人 active relation_id + 该绑定账号的 self_buy 推广位，服务端构造的 UnionIdentity', async () => {
  const f = await setup(database());
  await f.bind('active');
  await compose(f)();
  expect(f.get).toHaveBeenCalledWith('taobao');
  expect(f.getActivePid).toHaveBeenCalledWith(
    expect.objectContaining({
      appId: f.appId,
      platform: 'taobao',
      pidScene: 'self_buy',
      unionAccountId: f.account,
    }),
  );
  for (const [query] of f.getActivePid.mock.calls) expect(query.pidScene).toBe('self_buy');
  expect(f.shopOf).toHaveBeenCalledExactlyOnceWith(f.appId, PRODUCT_KEY, ITEM_REF);
  expect(f.convertShop).toHaveBeenCalledTimes(1);
  const [req, identity, ctx] = f.convertShop.mock.calls[0]!;
  expect(req).toEqual({ shopRef: SHOP.shopRef, shopName: SHOP.shopName });
  expect(identity).toBeInstanceOf(UnionIdentity);
  expect(identity.claims).toEqual({
    appId: f.appId,
    userId: f.a,
    platform: 'taobao',
    promotionSlot: ACTIVE_PID.self_buy,
    relationId: 'rel-A',
  });
  expect(ctx).toMatchObject({ appId: f.appId });
});

it('[AC-B1-06zg#24] 只认当前用户本 app 的 active 绑定：忽略本人 released、同 app 他人与他 app 绑定', async () => {
  const f = await setup(database());
  await f.bind('released', f.a, 'rel-old');
  await f.bind('active', f.a, 'rel-A');
  await f.bind('active', f.b, 'rel-B');
  const foreign = await setup(database());
  await foreign.bind('active', foreign.a, 'rel-foreign');
  const result = await compose(f)();
  shopJump(result, shopLink(SHOP.shopRef, 'rel-A'));
  expect(f.convertShop.mock.calls[0]![1].claims).toMatchObject({
    userId: f.a,
    relationId: 'rel-A',
  });
  for (const relation of ['rel-old', 'rel-B', 'rel-foreign'])
    expect(JSON.stringify(f.convertShop.mock.calls)).not.toContain(relation);
});

it('[AC-B1-06zg#25] 另一用户进同一店铺：身份换成该用户自己的 relation_id，不沿用前一用户', async () => {
  const f = await setup(database());
  await f.bind('active', f.a, 'rel-A');
  await f.bind('active', f.b, 'rel-B');
  f.opener(f.b);
  const result = await compose(f)();
  shopJump(result, shopLink(SHOP.shopRef, 'rel-B'));
  expect(f.convertShop.mock.calls[0]![1].claims).toMatchObject({
    userId: f.b,
    relationId: 'rel-B',
  });
});

it('[AC-B1-06zg#26] 成功进店不登记 link、不写 link_logs / link_open_attempts，也不签发授权 state', async () => {
  const f = await setup(database());
  await f.bind('active');
  const result = await compose(f)();
  shopJump(result, shopLink(SHOP.shopRef, 'rel-A'));
  expect(await f.footprint()).toEqual({ links: [], logs: [], attempts: [] });
  expect(await f.sessions()).toEqual([]);
});

it.each([
  [600, 600],
  [1, 1],
  [MAX_TTL_SEC, MAX_TTL_SEC],
  [1200, MAX_TTL_SEC],
  [0, MAX_TTL_SEC],
  [-5, MAX_TTL_SEC],
] as const)(
  '[AC-B1-06zg#27] link.convert_cache_ttl_sec=%i → expire_at = now + %i 秒（上限 900）',
  async (configured, effective) => {
    const f = await setup(database());
    await f.bind('active');
    f.config.set('link.convert_cache_ttl_sec', configured);
    const jump = shopJump(await compose(f)(), shopLink(SHOP.shopRef, 'rel-A'));
    expect(new Date(jump.expire_at).getTime()).toBe(f.clock.now().getTime() + effective * 1000);
  },
);

const failures: readonly [string, () => Error][] = [
  ['upstream_unavailable', () => new UnionError('upstream_unavailable', 'synthetic', 'taobao')],
  ['rate_limited', () => new UnionError('rate_limited', 'synthetic', 'taobao')],
  ['upstream_rejected', () => new UnionError('upstream_rejected', 'synthetic', 'taobao')],
  ['invalid_identity', () => new UnionError('invalid_identity', 'synthetic', 'taobao')],
  ['invalid_dto', () => new UnionError('invalid_dto', 'synthetic', 'taobao')],
  ['adapter_unimplemented', () => new UnionError('adapter_unimplemented', 'synthetic', 'taobao')],
  ['timeout', () => new GovernanceError('timeout', 'union.taobao', 'synthetic')],
  ['circuit_open', () => new GovernanceError('circuit_open', 'union.taobao', 'synthetic')],
  ['quota_exceeded', () => new GovernanceError('quota_exceeded', 'union.taobao', 'synthetic')],
  ['plain error', () => new Error('synthetic failure')],
];

it.each(failures)(
  '[AC-B1-06zg#28] convertShop 失败 %s → 50303：只提示，不带任何店铺地址，不回退无推广参数店铺页',
  async (_label, error) => {
    const f = await setup(database());
    await f.bind('active');
    f.convertShop.mockRejectedValue(error());
    const result = await compose(f)();
    await refusal(result, f, 50303, 503);
    expect(f.convertShop).toHaveBeenCalledTimes(1);
    await noAuthState(result, f);
  },
);

it('[AC-B1-06zg#29] 适配器声明来源却没有 convertShop → 50303，不外跳', async () => {
  const f = await setup(database());
  await f.bind('active');
  const declaredOnly = { platform: 'taobao', shopConvertSources: ['dataoke'] };
  const registry = { get: () => declaredOnly as unknown as UnionAdapter };
  const result = await compose(f, { registry })();
  await refusal(result, f, 50303, 503);
});

it('[AC-B1-06zg#30] 50303 之后不缓存失败：换幂等键再点会重新转链，成功即出跳转', async () => {
  const f = await setup(database());
  await f.bind('active');
  const outage = new UnionError('upstream_unavailable', 'synthetic', 'taobao');
  f.convertShop.mockRejectedValueOnce(outage);
  const open = compose(f);
  await refusal(await open(), f, 50303, 503);
  shopJump(await open(), shopLink(SHOP.shopRef, 'rel-A'));
  expect(f.convertShop).toHaveBeenCalledTimes(2);
});

it('[AC-B1-06zg#39] 同 app 双账号：默认账号 A、本人绑定账号 B → 按 B 查 self_buy 推广位，convertShop 精确收到 B 的 pid 与本人 relation_id，不混用 A 的推广位', async () => {
  const f = await setup(database());
  const bound = await f.addAccount();
  await f.bind('active', f.a, 'rel-A', bound);
  const result = await compose(f)();
  const jump = shopJump(result, shopLink(SHOP.shopRef, 'rel-A'));
  expect(f.convertShop).toHaveBeenCalledTimes(1);
  const [req, identity] = f.convertShop.mock.calls[0]!;
  expect(req).toEqual({ shopRef: SHOP.shopRef, shopName: SHOP.shopName });
  expect(identity.claims).toEqual({
    appId: f.appId,
    userId: f.a,
    platform: 'taobao',
    promotionSlot: SECOND_PID.self_buy,
    relationId: 'rel-A',
  });
  // Queried on B, the account of the caller's binding; never a slot of A by its account.
  expect(f.getActivePid).toHaveBeenCalledWith(
    expect.objectContaining({
      appId: f.appId,
      platform: 'taobao',
      pidScene: 'self_buy',
      unionAccountId: bound,
    }),
  );
  for (const [query] of f.getActivePid.mock.calls) {
    expect(query.pidScene).toBe('self_buy');
    expect(query.unionAccountId).not.toBe(f.account);
  }
  const passed = JSON.stringify([f.convertShop.mock.calls, jump]);
  for (const pid of Object.values(ACTIVE_PID)) expect(passed).not.toContain(pid);
  expect(f.cache.put).toHaveBeenCalledWith(
    expect.objectContaining({
      appId: f.appId,
      unionAccountId: bound,
      pid: SECOND_PID.self_buy,
      relationId: 'rel-A',
      shopRef: SHOP.shopRef,
    }),
    jump,
  );
  for (const [key] of f.cache.put.mock.calls) {
    expect(key.unionAccountId).toBe(bound);
    expect(key.pid).toBe(SECOND_PID.self_buy);
  }
});

it('[AC-B1-06zg#40] 同 app 双账号：本人绑定账号 B 没有 active self_buy 推广位 → 50301，不借默认账号 A 的推广位', async () => {
  const f = await setup(database());
  const bound = await f.addAccount({
    share: SECOND_PID.share,
    agent: SECOND_PID.agent,
    query: SECOND_PID.query,
    fallback: SECOND_PID.fallback,
    taolijin: SECOND_PID.taolijin,
  });
  await f.bind('active', f.a, 'rel-A', bound);
  const result = await compose(f)();
  await refusal(result, f, 50301, 503);
  await noAuthState(result, f);
  untouched(f);
  expect(f.getActivePid).toHaveBeenCalledWith(
    expect.objectContaining({ pidScene: 'self_buy', unionAccountId: bound }),
  );
  expect(JSON.stringify(result)).not.toContain(ACTIVE_PID.self_buy);
});
