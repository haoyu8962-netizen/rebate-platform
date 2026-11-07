import { expect, it, vi } from 'vitest';
import { FixedClock } from '../../../platform/index.ts';
import {
  UnionError,
  UnionIdentity,
  type IdentityClaims,
  type UnionEndpoint,
} from '../../domain/types.ts';
import { DataokeClient } from '../dataoke/dataoke-client.ts';
import type { UnionTransport, UnionTransportResponse } from '../replay.ts';
import {
  isShopLink,
  mapShopConvert,
  SHOP_LINK_HOSTS,
  shopConvertParameters,
} from './shop-convert.ts';
import { TaobaoUnionAdapter } from './taobao-adapter.ts';

// 合成值，不是录制。规则测试在 test/spec/union/taobao-shop-convert/**，这里补白名单严格度
// （评审 S2 (a)）、淘口令字段名、不发请求与只调一次的细节。
const LINK = 'https://s.click.taobao.com/t?e=unit-shop-link';
const SLOT = 'mm_9_8_7';
const RELATION = 'unit-relation';

class UnitIdentity extends UnionIdentity {
  constructor(claims: Partial<IdentityClaims> = {}) {
    super({
      appId: 'unit-app',
      userId: 'unit-user',
      platform: 'taobao',
      promotionSlot: SLOT,
      relationId: RELATION,
      ...claims,
    });
  }
}

const req = { shopRef: '123456', shopName: 'unit shop' };

function exchange(data: Record<string, unknown>, status = 200) {
  const response: UnionTransportResponse = { status, headers: {}, body: '{}' };
  return { data, response };
}

function failure(run: () => unknown): UnionError {
  try {
    run();
  } catch (error) {
    if (error instanceof UnionError) return error;
    throw error;
  }
  throw new Error('expected a UnionError');
}

it('[AC-B1-04zzt-UNIT#1] 白名单只有 s.click.taobao.com，按主机全等', () => {
  expect([...SHOP_LINK_HOSTS]).toEqual(['s.click.taobao.com']);
  expect(isShopLink(LINK)).toBe(true);
  expect(isShopLink('https://s.click.taobao.com/abc')).toBe(true);
  expect(isShopLink('https://s.click.taobao.com/?e=x')).toBe(true);
});

it.each([
  ['the shop own page', 'https://shop123456.taobao.com/'],
  ['the shop own page with a path', 'https://shop123456.taobao.com/index.htm?spm=x'],
  ['another taobao.com subdomain', 'https://uland.taobao.com/coupon?e=x'],
  ['the taobao.com apex', 'https://taobao.com/t?e=x'],
  ['a click subdomain look-alike', 'https://a.s.click.taobao.com/t?e=x'],
  ['a trailing dot host', 'https://s.click.taobao.com./t?e=x'],
  ['a bare host', 'https://s.click.taobao.com'],
  ['a bare host with a slash', 'https://s.click.taobao.com/'],
  ['user info', 'https://user@s.click.taobao.com/t?e=x'],
  ['user and password', 'https://user:pw@s.click.taobao.com/t?e=x'],
  ['an explicit port', 'https://s.click.taobao.com:8443/t?e=x'],
  ['http', 'http://s.click.taobao.com/t?e=x'],
  ['an inner space', 'https://s.click.taobao.com/t?e=a b'],
  ['a trailing no-break space', 'https://s.click.taobao.com/t?e=x\u00a0'],
])(
  '[AC-B1-04zzt-UNIT#2] shopLinks 为 %s → upstream_unavailable，错误不带链接原文',
  (_label, link) => {
    expect(isShopLink(link)).toBe(false);
    const error = failure(() => mapShopConvert(exchange({ shopLinks: link })));
    expect(error.code).toBe('upstream_unavailable');
    expect(error.message).not.toContain(link);
    expect(error.message).not.toContain('taobao.com');
  },
);

it.each([
  ['tpwd only', { tpwd: 'lower' }, 'lower'],
  ['Tpwd only', { Tpwd: 'upper' }, 'upper'],
  ['both: tpwd wins', { tpwd: 'lower', Tpwd: 'upper' }, 'lower'],
  ['empty tpwd falls back to Tpwd', { tpwd: '', Tpwd: 'upper' }, 'upper'],
  ['neither', {}, undefined],
  ['non-string', { tpwd: 7, Tpwd: { x: 1 } }, undefined],
])('[AC-B1-04zzt-UNIT#3] 淘口令字段名大小写：%s', (_label, fields, expected) => {
  const result = mapShopConvert(exchange({ shopLinks: LINK, ...fields }));
  if (expected === undefined) expect(result).toEqual({ url: LINK });
  else expect(result).toEqual({ url: LINK, tpwd: expected });
  expect(result).not.toHaveProperty('Tpwd');
});

it.each([199, 301, 404])(
  '[AC-B1-04zzt-UNIT#4] HTTP %s → upstream_unavailable；2xx 照常',
  (status) => {
    const error = failure(() => mapShopConvert(exchange({ shopLinks: LINK, tpwd: 't' }, status)));
    expect(error.code).toBe('upstream_unavailable');
    expect(mapShopConvert(exchange({ shopLinks: LINK }, 204))).toEqual({ url: LINK });
  },
);

it('[AC-B1-04zzt-UNIT#5] 参数：relationId 必带，pid / relationId 缺即 invalid_identity，错误不带它们', () => {
  expect(shopConvertParameters(req, new UnitIdentity())).toEqual({
    sellerId: '123456',
    pid: SLOT,
    shopName: 'unit shop',
    relationId: RELATION,
  });
  for (const claims of [{ relationId: null }, { promotionSlot: '' }, { relationId: ' ' }]) {
    const error = failure(() => shopConvertParameters(req, new UnitIdentity(claims)));
    expect(error.code).toBe('invalid_identity');
    expect(error.message).not.toContain(SLOT);
    expect(error.message).not.toContain(RELATION);
  }
});

const endpoint: UnionEndpoint = {
  platform: 'taobao',
  mode: 'live',
  baseUrl: 'https://unit-taobao.invalid/router/rest',
  quotaKey: 'unit-taobao',
};

function adapter(reply: UnionTransportResponse) {
  const clock = new FixedClock('2026-11-07T00:00:00.000Z');
  const credentials = vi.fn(async () => ({ appKey: 'unit-key', appSecret: 'unit-secret' }));
  const transport = vi.fn<UnionTransport>(async () => reply);
  const orderSource = new DataokeClient({
    credentials,
    transport,
    clock,
    random: () => 1,
    baseUrl: 'https://unit-dataoke.invalid',
  });
  const port = new TaobaoUnionAdapter({
    credentials: async () => ({ appKey: 'tb', appSecret: 'tb-secret' }),
    transport: vi.fn<UnionTransport>(),
    clock,
    endpoint,
    orderSource,
  });
  return { port, credentials, transport };
}

const ctx = { appId: 'unit-app', requestId: 'unit-req', purpose: 'online' as const };
const ok = {
  status: 200,
  headers: {},
  body: JSON.stringify({ code: 0, data: { shopLinks: LINK } }),
};

it.each([
  ['relationId null', { relationId: null }],
  ['pid missing', { promotionSlot: '' }],
])('[AC-B1-04zzt-UNIT#6] %s → 不取凭据、不发请求', async (_label, claims) => {
  const { port, credentials, transport } = adapter(ok);
  await expect(port.convertShop(req, new UnitIdentity(claims), ctx)).rejects.toMatchObject({
    code: 'invalid_identity',
  });
  expect(credentials).not.toHaveBeenCalled();
  expect(transport).not.toHaveBeenCalled();
  await expect(port.convertShop(req, new UnitIdentity(), ctx)).resolves.toEqual({ url: LINK });
  expect(transport).toHaveBeenCalledTimes(1);
});

it.each([
  ['shop own page', { code: 0, data: { shopLinks: 'https://shop123456.taobao.com/' } }],
  ['outer code -1', { code: -1, data: { shopLinks: LINK } }],
])('[AC-B1-04zzt-UNIT#7] 上游失败（%s）只调一次，不返回地址', async (_label, body) => {
  const { port, transport } = adapter({ status: 200, headers: {}, body: JSON.stringify(body) });
  await expect(port.convertShop(req, new UnitIdentity(), ctx)).rejects.toMatchObject({
    code: 'upstream_unavailable',
  });
  expect(transport).toHaveBeenCalledTimes(1);
});
