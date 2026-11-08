import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { databaseFixture } from '../open-requote/kit.ts';
import {
  ACTIVE_PID,
  MAX_TTL_SEC,
  SHOP,
  compose,
  refusal,
  setup,
  shopJump,
  shopLink,
} from './kit.ts';

// B1-06zg 第 9、10 条：同 (app, 账号, pid, relation_id, shopRef) 在 expire_at 内复用上次结果、不再调
// convertShop，不跨用户；同 Idempotency-Key 重放返回同一结果、不再调 convertShop。复用不越过开关与授权。
const database = databaseFixture(createTestDatabase);
const TTL_MS = MAX_TTL_SEC * 1000;

it('[AC-B1-06zg#31] expire_at 之内换幂等键再点：复用同一跳转、不再转链；缓存键是账号 + pid + relation_id + shopRef', async () => {
  const f = await setup(database());
  await f.bind('active');
  const open = compose(f);
  const first = shopJump(await open(), shopLink(SHOP.shopRef, 'rel-A'));
  f.clock.advanceMs(TTL_MS - 1000);
  const second = shopJump(await open(), shopLink(SHOP.shopRef, 'rel-A'));
  expect(second).toEqual(first);
  expect(f.convertShop).toHaveBeenCalledTimes(1);
  expect(f.cache.put).toHaveBeenCalledWith(
    expect.objectContaining({
      appId: f.appId,
      platform: 'taobao',
      unionAccountId: f.account,
      pid: ACTIVE_PID.self_buy,
      relationId: 'rel-A',
      shopRef: SHOP.shopRef,
    }),
    first,
  );
});

it('[AC-B1-06zg#32] 过了 expire_at 再点：重新转链，新 expire_at 从当前时刻起算', async () => {
  const f = await setup(database());
  await f.bind('active');
  const open = compose(f);
  const first = shopJump(await open(), shopLink(SHOP.shopRef, 'rel-A'));
  f.clock.advanceMs(TTL_MS + 1);
  const second = shopJump(await open(), shopLink(SHOP.shopRef, 'rel-A'));
  expect(f.convertShop).toHaveBeenCalledTimes(2);
  expect(new Date(second.expire_at).getTime()).toBe(f.clock.now().getTime() + TTL_MS);
  expect(second.expire_at).not.toBe(first.expire_at);
});

it('[AC-B1-06zg#33] 不跨用户：A 转过的店铺 B 再进要用 B 的身份再转一次；A 在期内再进仍复用自己的', async () => {
  const f = await setup(database());
  await f.bind('active', f.a, 'rel-A');
  await f.bind('active', f.b, 'rel-B');
  const open = compose(f);
  const ofA = shopJump(await open(), shopLink(SHOP.shopRef, 'rel-A'));
  f.opener(f.b);
  f.clock.advanceMs(1000);
  shopJump(await open(), shopLink(SHOP.shopRef, 'rel-B'));
  expect(f.convertShop).toHaveBeenCalledTimes(2);
  expect(f.convertShop.mock.calls[1]![1].claims).toMatchObject({
    userId: f.b,
    relationId: 'rel-B',
  });
  f.opener(f.a);
  f.clock.advanceMs(1000);
  expect(shopJump(await open(), shopLink(SHOP.shopRef, 'rel-A'))).toEqual(ofA);
  expect(f.convertShop).toHaveBeenCalledTimes(2);
});

it('[AC-B1-06zg#34] 同一用户换一家店：按新 shopRef 再转链，不复用上一家店的跳转', async () => {
  const f = await setup(database());
  await f.bind('active');
  const open = compose(f);
  shopJump(await open(), shopLink(SHOP.shopRef, 'rel-A'));
  f.shopOf.mockResolvedValue({ shopRef: '1002', shopName: '合成另一家店' });
  const other = await open(f.request({ productKey: 'tb:synthetic_other_item' }));
  shopJump(other, shopLink('1002', 'rel-A'));
  expect(f.convertShop).toHaveBeenCalledTimes(2);
  expect(f.convertShop.mock.calls[1]![0]).toEqual({ shopRef: '1002', shopName: '合成另一家店' });
});

it('[AC-B1-06zg#35] relation_id 在期内变了（重新绑定）不复用旧跳转', async () => {
  const f = await setup(database());
  await f.bind('active');
  const open = compose(f);
  shopJump(await open(), shopLink(SHOP.shopRef, 'rel-A'));
  await f.db
    .updateTable('union_bindings')
    .set({ relation_id: 'rel-A-new' })
    .where('app_id', '=', f.appId)
    .where('user_id', '=', f.a)
    .execute();
  f.clock.advanceMs(1000);
  shopJump(await open(), shopLink(SHOP.shopRef, 'rel-A-new'));
  expect(f.convertShop).toHaveBeenCalledTimes(2);
});

it.each([
  ['invalid', 30102],
  ['released', 30101],
  ['blocked', 30153],
] as const)(
  '[AC-B1-06zg#36] 期内已有跳转后绑定变 %s：授权拒绝 %i 先于复用，不下发旧跳转',
  async (status, code) => {
    const f = await setup(database());
    await f.bind('active');
    const open = compose(f);
    shopJump(await open(), shopLink(SHOP.shopRef, 'rel-A'));
    await f.setBinding(status);
    f.clock.advanceMs(1000);
    await refusal(await open(), f, code);
    expect(f.convertShop).toHaveBeenCalledTimes(1);
  },
);

it.each([
  { key: 'shop.entry.enabled.taobao', value: false, code: 30146, status: 422 },
  { key: 'convert.enabled.taobao', value: false, code: 50301, status: 503 },
] as const)(
  '[AC-B1-06zg#37] 期内已有跳转后 $key 关闭：回 $code，不下发旧跳转',
  async ({ key, value, code, status }) => {
    const f = await setup(database());
    await f.bind('active');
    const open = compose(f);
    shopJump(await open(), shopLink(SHOP.shopRef, 'rel-A'));
    f.config.set(key, value);
    f.clock.advanceMs(1000);
    await refusal(await open(), f, code, status);
  },
);

it('[AC-B1-06zg#38] 同 Idempotency-Key 重放返回同一结果，不再转链（缓存清空、跳转过期也一样）', async () => {
  const f = await setup(database());
  await f.bind('active');
  const open = compose(f);
  const request = f.request();
  const first = await open(request);
  shopJump(first, shopLink(SHOP.shopRef, 'rel-A'));
  f.cache.entries.clear();
  f.clock.advanceMs(TTL_MS + 1);
  expect(await open(request)).toEqual(first);
  expect(f.convertShop).toHaveBeenCalledTimes(1);
  const stored = [...f.execute.mock.calls, ...f.executeInTransaction.mock.calls];
  expect(stored.length).toBeGreaterThan(0);
  for (const [entry] of stored)
    expect(entry).toMatchObject({ appId: f.appId, key: request.idempotencyKey });
});
