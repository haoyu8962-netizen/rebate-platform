import { expect, it } from 'vitest';
import type {
  ShopConvertReq,
  UnionIdentity,
} from '../../../../apps/api/src/modules/union/domain/types.ts';
import {
  callShop,
  converted,
  ctx,
  DATAOKE_APP_KEY,
  DATAOKE_SECRET,
  expectNothingSent,
  identity,
  PUBLIC_KEYS,
  refusal,
  RELATION_ID,
  SELF_SLOT,
  setup,
  SHARE_SLOT,
  SHOP_LINK,
  SHOP_NAME,
  SHOP_REF,
  SHOP_VERSION,
  shopReq,
  shopRequest,
  TestIdentity,
  unionFailure,
  USER_ID,
} from './kit.ts';

// 入参口径：sellerId = shopRef、pid = 身份推广位、shopName 必填、relationId = 身份 relation_id；
// 进店没有「无返利」路径，relationId 为 null 也拒绝。入参不合格不取凭据、不发请求。

const BUSINESS_KEYS = ['sellerId', 'pid', 'shopName', 'relationId'];

it('[AC-B1-04zzt#1] 经大淘客 GET /api/dels/shop/convert v1.0.0：sellerId = shopRef、pid = 身份推广位、shopName 原样、relationId = 身份 relation_id；不带 authId，只走大淘客客户端', async () => {
  const h = setup();
  const signal = new AbortController().signal;
  const result = await converted(() => callShop(h.adapter, shopReq, identity, { ...ctx, signal }));
  expect(result.url).toBe(SHOP_LINK);
  const { request, fields } = shopRequest(h);
  expect(fields).toMatchObject({
    appKey: DATAOKE_APP_KEY,
    version: SHOP_VERSION,
    sellerId: SHOP_REF,
    pid: SELF_SLOT,
    shopName: SHOP_NAME,
    relationId: RELATION_ID,
  });
  expect(Object.keys(fields).sort()).toEqual([...PUBLIC_KEYS, ...BUSINESS_KEYS].sort());
  expect(request.signal).toBe(signal);
  expect(h.dataokeCredentials).toHaveBeenCalledTimes(1);
  expect(h.taobaoCredentials).not.toHaveBeenCalled();
  expect(h.taobaoTransport).not.toHaveBeenCalled();
  for (const marker of [USER_ID, DATAOKE_SECRET]) {
    expect(request.url).not.toContain(marker);
    expect(JSON.stringify(request.headers)).not.toContain(marker);
  }
});

it('[AC-B1-04zzt#2] 归档照商品转链口径：传输请求挂 { appId, kind: convert }，URL 里只有 signRan 不含密钥', async () => {
  const h = setup();
  await converted(() => callShop(h.adapter));
  const { request, fields } = shopRequest(h);
  expect(request.archive).toEqual({ appId: ctx.appId, kind: 'convert' });
  expect(fields.signRan).toBeTypeOf('string');
  expect(request.url).not.toContain(DATAOKE_SECRET);
});

it.each([
  ['a one-digit id', '7'],
  ['an id past the safe-integer range', '6543210987654321098765'],
  ['an ordinary seller id', '2208765432101'],
])('[AC-B1-04zzt#3] sellerId 是 shopRef 原样（%s）', async (_label, shopRef) => {
  const h = setup();
  await converted(() => callShop(h.adapter, { shopRef, shopName: SHOP_NAME }));
  expect(shopRequest(h).fields.sellerId).toBe(shopRef);
});

it.each([
  ['Chinese with an inner space', '合成 旗舰店'],
  ['URL-special characters', 'A&B=C+D%E#F?G/H'],
  ['plain ascii', 'synthetic-shop'],
])('[AC-B1-04zzt#4] shopName 原样上送（%s）', async (_label, shopName) => {
  const h = setup();
  await converted(() => callShop(h.adapter, { shopRef: SHOP_REF, shopName }));
  expect(shopRequest(h).fields.shopName).toBe(shopName);
});

it.each([SELF_SLOT, SHARE_SLOT])(
  '[AC-B1-04zzt#5] pid 取身份里的推广位（%s），union 不另选',
  async (promotionSlot) => {
    const h = setup();
    await converted(() => callShop(h.adapter, shopReq, new TestIdentity({ promotionSlot })));
    const { fields } = shopRequest(h);
    expect(fields.pid).toBe(promotionSlot);
    expect(fields.relationId).toBe(RELATION_ID);
  },
);

it('[AC-B1-04zzt#6] relationId 为 null（无返利身份）→ 业务拒绝，不取凭据、不发请求；带 relation_id 的身份照常转链', async () => {
  const h = setup();
  await refusal(() => callShop(h.adapter, shopReq, new TestIdentity({ relationId: null })));
  expectNothingSent(h);
  await converted(() => callShop(h.adapter, shopReq, identity));
  expect(shopRequest(h).fields.relationId).toBe(RELATION_ID);
});

it.each([
  ['empty string', ''],
  ['blank', '   '],
  ['number', 77],
  ['object', { relation: RELATION_ID }],
  ['undefined', undefined],
])('[AC-B1-04zzt#7] relationId 为%s → 业务拒绝，不取凭据、不发请求', async (_label, relationId) => {
  const h = setup();
  const who = new TestIdentity({ relationId: relationId as unknown as string | null });
  await refusal(() => callShop(h.adapter, shopReq, who));
  expectNothingSent(h);
  await converted(() => callShop(h.adapter, shopReq, identity));
});

it.each([
  ['a pdd identity', () => new TestIdentity({ platform: 'pdd' })],
  ['an empty promotion slot', () => new TestIdentity({ promotionSlot: '' })],
  ['a blank promotion slot', () => new TestIdentity({ promotionSlot: '   ' })],
  [
    'a forged object with the identity prototype',
    () =>
      Object.assign(Object.create(TestIdentity.prototype) as object, {
        claims: identity.claims,
      }) as UnionIdentity,
  ],
])(
  '[AC-B1-04zzt#8] %s → invalid_identity，不取凭据、不发请求',
  async (_label, make: () => UnionIdentity) => {
    const h = setup();
    await unionFailure(() => callShop(h.adapter, shopReq, make()), 'invalid_identity');
    expectNothingSent(h);
    await converted(() => callShop(h.adapter, shopReq, identity));
  },
);

it.each([
  ['empty', ''],
  ['zero', '0'],
  ['a leading zero', '0123'],
  ['negative', '-1'],
  ['a decimal', '12.5'],
  ['an exponent', '1e5'],
  ['a leading space', ' 123'],
  ['a trailing space', '123 '],
  ['letters', 'abc'],
  ['full-width digits', String.fromCodePoint(0xff11, 0xff12, 0xff13)],
  ['a number', 123],
  ['null', null],
  ['undefined', undefined],
])('[AC-B1-04zzt#9] shopRef 为%s → invalid_dto，不取凭据、不发请求', async (_label, shopRef) => {
  const h = setup();
  const bad = { shopRef, shopName: SHOP_NAME } as unknown as ShopConvertReq;
  await unionFailure(() => callShop(h.adapter, bad), 'invalid_dto');
  expectNothingSent(h);
  await converted(() => callShop(h.adapter, shopReq));
});

it.each([
  ['empty', ''],
  ['spaces', '   '],
  ['an ideographic space', String.fromCodePoint(0x3000)],
  ['tab and newline', '\t\n'],
  ['a number', 42],
  ['null', null],
  ['undefined', undefined],
])('[AC-B1-04zzt#10] shopName 为%s → invalid_dto，不取凭据、不发请求', async (_label, shopName) => {
  const h = setup();
  const bad = { shopRef: SHOP_REF, shopName } as unknown as ShopConvertReq;
  await unionFailure(() => callShop(h.adapter, bad), 'invalid_dto');
  expectNothingSent(h);
  await converted(() => callShop(h.adapter, shopReq));
});
