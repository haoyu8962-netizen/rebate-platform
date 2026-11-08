import { expect, it } from 'vitest';
import { IDEMPOTENCY_KEY, PATH, PRODUCT_KEY, body, data, traceId, withHttp } from './http-kit.ts';
import { validate } from './kit.ts';

// B1-06zg: openProductShop is x-auth login, x-signed, x-idempotent and version-gated like the
// open (contracts/openapi.yaml; brief 编排者说明 第 1、10 条). ShopOpenRequest has no scene, no
// no_rebate and no identity field (BR-ATTR-05 / BR-ATTR-08 / BR-ID-18 进店例外).

it('[AC-B1-06zg#1] POST shop/open 已注册：path 解码后的 product_key、契约 body、客户端、trace 与幂等键交给用例，响应过契约', async () => {
  await withHttp(async ({ send, open }) => {
    const response = await send(body);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ code: 0, msg: 'ok', trace_id: traceId, data });
    await validate(response.json(), 'ShopOpenResponse');
    expect(open).toHaveBeenCalledExactlyOnceWith({
      productKey: PRODUCT_KEY,
      body,
      idempotencyKey: IDEMPOTENCY_KEY,
      traceId,
      client: 'ios',
    });
  });
}, 30_000);

it('[AC-B1-06zg#2] installed 缺省按 unknown 交给用例；item_ref 可省', async () => {
  await withHttp(async ({ send, open }) => {
    const response = await send({ platform: 'taobao' });
    expect(response.statusCode).toBe(200);
    expect(open).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        productKey: PRODUCT_KEY,
        body: { platform: 'taobao', installed: 'unknown' },
      }),
    );
  });
}, 30_000);

it.each([
  { code: 30146, status: 422, data: { platform: 'taobao', reason: 'shop_entry_disabled' } },
  { code: 30146, status: 422, data: { platform: 'taobao', reason: 'shop_unavailable' } },
  { code: 30153, status: 422, data: undefined },
  { code: 30101, status: 422, data: { reason: 'auth_unavailable' } },
  { code: 50301, status: 503, data: undefined },
  { code: 50303, status: 503, data: undefined },
])(
  '[AC-B1-06zg#3] 用例拒绝 $code 原样透传 HTTP $status 与信封',
  async ({ code, status, data: refusal }) => {
    await withHttp(async ({ send, open }) => {
      const envelope = {
        code,
        msg: 'synthetic refusal',
        trace_id: traceId,
        ...(refusal === undefined ? {} : { data: refusal }),
      };
      open.mockResolvedValueOnce({ status, envelope });
      const response = await send(body);
      expect(response.statusCode).toBe(status);
      expect(response.json()).toEqual(envelope);
      await validate(response.json(), 'ErrorEnvelope');
    });
  },
  30_000,
);

it.each([
  ['缺 platform', {}],
  ['未知 platform', { platform: 'synthetic' }],
  ['带 scene', { ...body, scene: 'detail' }],
  ['带 no_rebate', { ...body, no_rebate: true }],
  ['带 no_rebate_reason', { ...body, no_rebate_reason: 'auth_declined' }],
  ['带 user_id', { ...body, user_id: 'synthetic-attacker' }],
  ['带 pid', { ...body, pid: 'mm_9_9_9' }],
  ['带 relation_id', { ...body, relation_id: 'rel-attacker' }],
  ['带 shop_ref', { ...body, shop_ref: '9999' }],
  ['带 url', { ...body, url: 'https://shop.example.test/9999' }],
  ['installed 布尔', { ...body, installed: true }],
  ['item_ref 空串', { ...body, item_ref: '' }],
])(
  '[AC-B1-06zg#4] 非法 body（%s）→ 20001，不进入用例',
  async (_label, input) => {
    await withHttp(async ({ send, open }) => {
      const response = await send(input);
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: 20001 });
      await validate(response.json(), 'ErrorEnvelope');
      expect(open).not.toHaveBeenCalled();
    });
  },
  30_000,
);

it('[AC-B1-06zg#5] 未登录 10001，真实 token 检查挡在用例之前', async () => {
  await withHttp(async ({ send, open }) => {
    const response = await send(body, { authorization: undefined });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 10001 });
    expect(open).not.toHaveBeenCalled();
  });
}, 30_000);

it.each([
  ['缺 X-Sign', { 'x-sign': undefined }],
  ['X-Sign 不匹配', { 'x-sign': 'f'.repeat(64) }],
])(
  '[AC-B1-06zg#6] 签名失败（%s）→ 10401，不进入用例（H5 无签名不可用）',
  async (_label, headers) => {
    await withHttp(async ({ send, open }) => {
      const response = await send(body, headers);
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ code: 10401 });
      expect(open).not.toHaveBeenCalled();
    });
  },
  30_000,
);

it('[AC-B1-06zg#7] 缺 Idempotency-Key → 20001，不进入用例', async () => {
  await withHttp(async ({ send, open }) => {
    const response = await send(body, { 'idempotency-key': undefined });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 20001 });
    expect(open).not.toHaveBeenCalled();
  });
}, 30_000);

it('[AC-B1-06zg#8] 版本门禁：低于最低支持版本 → 10405，不进入用例', async () => {
  await withHttp(async ({ send, open, minimum }) => {
    minimum('9.0.0');
    const response = await send(body);
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      code: 10405,
      data: { min_supported_version: '9.0.0' },
    });
    expect(open).not.toHaveBeenCalled();
  });
}, 30_000);

it('[AC-B1-06zg#9] 路径参数 product_key 按 URL 编码传入，用例收到解码后的原值', async () => {
  await withHttp(async ({ send, open }) => {
    const key = 'tb:synthetic_中文+key';
    const response = await send(body, {}, `/v1/products/${encodeURIComponent(key)}/shop/open`);
    expect(response.statusCode).toBe(200);
    expect(open).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ productKey: key }));
    expect(PATH).toBe('/v1/products/tb%3Asynthetic_shop_item/shop/open');
  });
}, 30_000);
