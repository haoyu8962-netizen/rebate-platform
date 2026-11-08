import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import type { UnionAdapter } from '../../../../apps/api/src/modules/union/index.ts';
import { expectOpaqueState } from '../auth-url/kit.ts';
import { databaseFixture } from '../open-requote/kit.ts';
import {
  ITEM_REF,
  PRODUCT_KEY,
  compose,
  noAuthState,
  refusal,
  setup,
  untouched,
  type Binding,
  type Fixture,
} from './kit.ts';

// B1-06zg 链路与先后（编排者说明 第 1–7、11 条；BR-PRICE-21 细则「进店」；BR-ID-02 进店行；
// BR-ID-18 进店例外：没有无返利进店）. Each refusal answers before any later stage runs.
const database = databaseFixture(createTestDatabase);

const unauthorized = [
  ['absent', 30101],
  ['unbound', 30101],
  ['pending_auth', 30101],
  ['released', 30101],
  ['invalid', 30102],
] as const;

it('[AC-B1-06zg#10] 未登录 10001 先于开关与授权：进店全关、未绑定也只回 10001', async () => {
  const f = await setup(database());
  f.config.delete('shop.entry.enabled.taobao');
  f.config.set('convert.enabled.taobao', false);
  f.opener(null);
  const result = await compose(f)();
  await refusal(result, f, 10001, 401);
  await noAuthState(result, f);
  untouched(f);
});

it.each([
  ['未配置', undefined],
  ['false', false],
  ['字符串 "true"', 'true'],
  ['数字 1', 1],
  ['null', null],
] as const)(
  '[AC-B1-06zg#11] shop.entry.enabled.taobao %s 不是严格 true → 30146 shop_entry_disabled，先于 50301 与授权',
  async (_label, value) => {
    const f = await setup(database());
    await f.bind('unbound');
    if (value === undefined) f.config.delete('shop.entry.enabled.taobao');
    else f.config.set('shop.entry.enabled.taobao', value);
    f.config.set('convert.enabled.taobao', false);
    const result = await compose(f)();
    await refusal(result, f, 30146);
    expect(result.envelope.data).toMatchObject({ reason: 'shop_entry_disabled' });
    await noAuthState(result, f);
    untouched(f);
    expect(f.resolve).not.toHaveBeenCalled();
  },
);

it.each(['未配置', '空串', '适配器不声明的来源', '适配器不声明任何来源'] as const)(
  '[AC-B1-06zg#12] shop.entry.source.taobao %s → 30146 shop_entry_disabled，不调 shopOf / convertShop',
  async (kind) => {
    const f = await setup(database());
    await f.bind('active');
    if (kind === '未配置') f.config.delete('shop.entry.source.taobao');
    if (kind === '空串') f.config.set('shop.entry.source.taobao', '');
    if (kind === '适配器不声明的来源') f.config.set('shop.entry.source.taobao', 'official');
    const registry =
      kind === '适配器不声明任何来源'
        ? {
            get: () =>
              ({ platform: 'taobao', convertShop: f.convertShop }) as unknown as UnionAdapter,
          }
        : f.options.registry;
    const result = await compose(f, { registry })();
    await refusal(result, f, 30146);
    expect(result.envelope.data).toMatchObject({ reason: 'shop_entry_disabled' });
    untouched(f);
  },
);

it.each(['jd', 'pdd'] as const)(
  '[AC-B1-06zg#13] %s 开关与来源都配了，但适配器不声明 shopConvertSources → 30146 shop_entry_disabled',
  async (platform) => {
    const f = await setup(database(), platform);
    await f.bind('active');
    const registry = { get: () => ({ platform }) as unknown as UnionAdapter };
    const result = await compose(f, { registry })(
      f.request({ productKey: `${platform}:synthetic_shop_item` }),
    );
    await refusal(result, f, 30146);
    expect(result.envelope.data).toMatchObject({ reason: 'shop_entry_disabled' });
    untouched(f);
  },
);

it.each([
  ['未配置', undefined],
  ['false', false],
] as const)(
  '[AC-B1-06zg#14] convert.enabled.taobao %s → 50301（同 open），先于授权：未绑定也不签发 state',
  async (_label, value) => {
    const f = await setup(database());
    await f.bind('unbound');
    if (value === undefined) f.config.delete('convert.enabled.taobao');
    else f.config.set('convert.enabled.taobao', value);
    const result = await compose(f)();
    await refusal(result, f, 50301, 503);
    await noAuthState(result, f);
    untouched(f);
    expect(f.resolve).not.toHaveBeenCalled();
  },
);

it('[AC-B1-06zg#15] blocked → 30153：没有无返利进店，不签发授权、不读店铺、不转链', async () => {
  const f = await setup(database());
  await f.bind('blocked');
  const result = await compose(f)();
  await refusal(result, f, 30153);
  await noAuthState(result, f);
  untouched(f);
});

it.each(unauthorized)(
  '[AC-B1-06zg#16] 本人绑定 %s → %i：签发 10 分钟一次性 state（不绑 link），不读店铺、不转链；同幂等键重放不再签发',
  async (status, code) => {
    const f = await setup(database());
    await f.bind(status);
    const open = compose(f);
    const request = f.request();
    const result = await open(request);
    await refusal(result, f, code);
    expect(result.envelope.data).toMatchObject({
      auth_url: expect.any(String),
      state: expect.any(String),
      auth_methods: ['web_code'],
    });
    const issued = result.envelope.data as { auth_url: string; state: string };
    const url = new URL(issued.auth_url);
    expect(url.protocol).toBe('https:');
    expect(url.searchParams.get('state')).toBe(issued.state);
    expectOpaqueState(issued.state, f.a, f.device);
    expect(await f.sessions()).toEqual([
      expect.objectContaining({
        state: issued.state,
        app_id: f.appId,
        user_id: f.a,
        device_id: f.device,
        platform: 'taobao',
        mode: 'bind',
        link_id: null,
        client: 'ios',
        auth_methods: ['web_code'],
        expire_at: new Date(f.clock.now().getTime() + 600_000),
        used_at: null,
      }),
    ]);
    untouched(f);
    expect(await open(request)).toEqual(result);
    expect(await f.sessions()).toHaveLength(1);
    untouched(f);
  },
);

it.each(unauthorized)(
  '[AC-B1-06zg#17] 站长授权失效时本人 %s → %i reason=auth_unavailable，无 state、无授权入口',
  async (status, code) => {
    const f = await setup(database());
    await f.bind(status);
    await f.expireAccount();
    const result = await compose(f)();
    await refusal(result, f, code);
    expect(result.envelope.data).toEqual({ reason: 'auth_unavailable' });
    await noAuthState(result, f);
    untouched(f);
  },
);

it.each(['missing', 'invalid_pid', 'other_account', 'other_scene'] as const)(
  '[AC-B1-06zg#18] 该账号 active self_buy 推广位 %s → 50301 并告警，不读店铺、不转链',
  async (kind) => {
    const f = await setup(database());
    await f.bind('active');
    const original = f.getActivePid.getMockImplementation()!;
    f.getActivePid.mockImplementation(async (query) => {
      if (kind === 'missing') return null;
      const row = await original(query);
      if (row === null) return null;
      if (kind === 'invalid_pid') return { ...row, pid: 'synthetic-invalid-pid' };
      if (kind === 'other_account') return { ...row, union_account_id: randomUUID() };
      return { ...row, pid_scene: 'share' };
    });
    const result = await compose(f)();
    await refusal(result, f, 50301, 503);
    await noAuthState(result, f);
    untouched(f);
    if (kind !== 'other_account') {
      expect(f.warn).toHaveBeenCalledWith(
        expect.objectContaining({ app_id: f.appId, platform: 'taobao' }),
        expect.any(String),
      );
    }
  },
);

it('[AC-B1-06zg#19] 授权与推广位都通过后才读店铺：shopOf 收到本 app、路径 product_key 与 item_ref；null → 30146 shop_unavailable，不转链', async () => {
  const f = await setup(database());
  await f.bind('active');
  f.shopOf.mockResolvedValue(null);
  const result = await compose(f)();
  await refusal(result, f, 30146);
  expect(result.envelope.data).toMatchObject({ reason: 'shop_unavailable' });
  expect(f.shopOf).toHaveBeenCalledExactlyOnceWith(f.appId, PRODUCT_KEY, ITEM_REF);
  expect(f.convertShop).not.toHaveBeenCalled();
});

it.each([
  ['blocked', 30153],
  ['invalid', 30102],
  ['unbound', 30101],
] as const)(
  '[AC-B1-06zg#20] %s 授权拒绝 %i 先于店铺读取：shopOf 返回 null 也不回 30146',
  async (status, code) => {
    const f = await setup(database());
    await f.bind(status as Binding);
    f.shopOf.mockResolvedValue(null);
    const result = await compose(f)();
    await refusal(result, f, code);
    untouched(f);
  },
);

it('[AC-B1-06zg#21] 站长授权失效时本人 active 仍放行（同 open），转链用本人 relation_id', async () => {
  const f: Fixture = await setup(database());
  await f.bind('active');
  await f.expireAccount();
  const result = await compose(f)();
  expect(result).toMatchObject({ status: 200, envelope: { code: 0 } });
  expect(f.convertShop).toHaveBeenCalledTimes(1);
  expect(f.convertShop.mock.calls[0]![1].claims.relationId).toBe('rel-A');
  await noAuthState(result, f);
});
