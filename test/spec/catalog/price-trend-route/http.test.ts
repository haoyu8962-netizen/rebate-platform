import { afterEach, expect, it, vi } from 'vitest';
import { contractAuthOf } from '../../../../apps/api/src/modules/platform/index.ts';
import { assertContract, contract, fixture, headers, snapshotRows } from './kit.ts';

let app: Awaited<ReturnType<typeof fixture>>['app'] | undefined;
afterEach(async () => {
  try {
    await app?.close();
  } finally {
    app = undefined;
    vi.restoreAllMocks();
  }
});

it.each(['missing-colon', 'tb:', 'TB:route001', 'tb:has space', 'jd:route002', 'unknown:route003'])(
  '[AC-B1-29b#12] 商品键形状或平台不匹配（%s）按详情口径返回 20001',
  async (key) => {
    const f = await fixture();
    app = f.app;
    const response = await f.request(key, 'platform=taobao');
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 20001, data: { fields: ['product_key'] } });
    expect(f.read).not.toHaveBeenCalled();
    await assertContract(response, 'ErrorEnvelope');
  },
  30_000,
);

it.each(['app_id=synthetic_forged', 'user_id=synthetic-user', 'window_days=60'])(
  '[AC-B1-29b#13] 契约拒绝额外 query 字段（%s），不能覆盖服务端范围',
  async (extra) => {
    const f = await fixture();
    app = f.app;
    const response = await f.request('tb:route001', `platform=taobao&${extra}`);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 20001 });
    expect(f.read).not.toHaveBeenCalled();
    await assertContract(response, 'ErrorEnvelope');
  },
  30_000,
);

it('[AC-B1-29b#1] 游客读取真实用例结果，金额序列化为整数且完整信封符合契约', async () => {
  const f = await fixture();
  app = f.app;
  const response = await f.request();
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({
    code: 0,
    msg: '',
    data: {
      status: 'ok',
      points: [
        { date: '2030-10-16', final_price_fen: 3290 },
        { date: '2030-10-17', final_price_fen: 2990 },
      ],
      start_date: '2030-10-16',
      window_days: 30,
      source_key: 'price_trend.source.general',
      mode_price_fen: 2990,
    },
    trace_id: '01920000-0000-7000-8000-00000000d029',
  });
  expect(response.headers['x-trace-id']).toBe('01920000-0000-7000-8000-00000000d029');
  expect(f.read).toHaveBeenCalledTimes(1);
  expect(f.read.mock.calls[0]?.[1]).toEqual({
    appId: 'synthetic_trend',
    platform: 'taobao',
    productKey: 'tb:route001',
  });
  await assertContract(response, 'ProductPriceTrendResponse');
}, 30_000);

it('[AC-B1-29b#2] auth none：登录凭据和游客返回同样结果，传入用例的参数不含用户标识', async () => {
  const f = await fixture();
  app = f.app;
  const guest = await f.request();
  expect(guest.statusCode).toBe(200);
  const member = await f.request('tb:route001', 'platform=taobao', {
    authorization: await f.memberAuthorization(),
    'x-user-id': 'synthetic-untrusted-user',
  });
  expect(member.statusCode).toBe(200);
  for (const response of [guest, member]) {
    expect(response.json<{ data: unknown }>().data).toEqual({
      status: 'ok',
      points: [
        { date: '2030-10-16', final_price_fen: 3290 },
        { date: '2030-10-17', final_price_fen: 2990 },
      ],
      start_date: '2030-10-16',
      window_days: 30,
      source_key: 'price_trend.source.general',
      mode_price_fen: 2990,
    });
  }
  expect(f.read.mock.calls.map(([, query]) => query)).toEqual([
    { appId: 'synthetic_trend', platform: 'taobao', productKey: 'tb:route001' },
    { appId: 'synthetic_trend', platform: 'taobao', productKey: 'tb:route001' },
  ]);
  expect(contractAuthOf('GET', '/v1/products/:product_key/price-trend')).toBe('none');
  await assertContract(member, 'ProductPriceTrendResponse');
}, 30_000);

it('[AC-B1-29b#3] auth none 不要求有效登录凭据', async () => {
  const f = await fixture();
  app = f.app;
  const response = await f.request('tb:route001', 'platform=taobao', {
    authorization: 'Bearer synthetic-invalid-credential',
  });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ code: 0, data: { status: 'ok' } });
  await assertContract(response, 'ProductPriceTrendResponse');
}, 30_000);

it.each(['', 'platform=', 'platform=unknown', 'platform=ios', 'platform=TAOBAO'])(
  '[AC-B1-29b#4] 缺失或非法 platform（%s）返回 400/20001 和 fields，不调用用例',
  async (query) => {
    const f = await fixture();
    app = f.app;
    const response = await f.request('tb:route001', query);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 20001, data: { fields: ['platform'] } });
    expect(f.read).not.toHaveBeenCalled();
    expect(f.rows).not.toHaveBeenCalled();
    await assertContract(response, 'ErrorEnvelope');
  },
  30_000,
);

it.each(['x', 'tb'])(
  '[AC-B1-29b#5] product_key 短于契约长度下限（%s）返回 400/20001 和 fields',
  async (key) => {
    const f = await fixture();
    app = f.app;
    const response = await f.request(key);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 20001, data: { fields: ['product_key'] } });
    expect(f.read).not.toHaveBeenCalled();
    await assertContract(response, 'ErrorEnvelope');
  },
  30_000,
);

it.each([
  ['taobao', 'tb:route001'],
  ['jd', 'jd:route002'],
  ['pdd', 'pdd:route003'],
  ['meituan', 'mt:route004'],
  ['vip', 'vip:route005'],
  ['douyin', 'dy:route006'],
  ['kuaishou', 'ks:route008'],
  ['suning', 'sn:route009'],
])(
  '[AC-B1-29b#6] 平台枚举 %s 与 URL 解码后的路径 %s 原样传到用例',
  async (platform, key) => {
    const f = await fixture();
    app = f.app;
    const response = await f.request(key, `platform=${platform}`);
    expect(response.statusCode).toBe(200);
    expect(f.read).toHaveBeenCalledTimes(1);
    expect(f.read.mock.calls[0]?.[1]).toEqual({
      appId: 'synthetic_trend',
      platform,
      productKey: key,
    });
    expect(f.keyStability).toHaveBeenCalledExactlyOnceWith(platform);
    await assertContract(response, 'ProductPriceTrendResponse');
  },
  30_000,
);

it('[AC-B1-29b#7] 同一应用实例按每次请求的 app_id 隔离读取，不缓存首个请求范围', async () => {
  const f = await fixture();
  app = f.app;
  const first = await f.request();
  expect(first.statusCode).toBe(200);
  const second = await f.request('jd:route002', 'platform=jd', { 'x-app-id': 'synthetic_other' });
  expect(second.statusCode).toBe(200);
  expect(f.read.mock.calls.map(([, query]) => query)).toEqual([
    { appId: 'synthetic_trend', platform: 'taobao', productKey: 'tb:route001' },
    { appId: 'synthetic_other', platform: 'jd', productKey: 'jd:route002' },
  ]);
  expect(
    f.rows.mock.calls.map(([{ appId, platform, productKey }]) => ({ appId, platform, productKey })),
  ).toEqual([
    { appId: 'synthetic_trend', platform: 'taobao', productKey: 'tb:route001' },
    { appId: 'synthetic_other', platform: 'jd', productKey: 'jd:route002' },
  ]);
  expect(f.configValue.mock.calls).toEqual([
    ['synthetic_trend', 'price_trend.min_distinct_days'],
    ['synthetic_other', 'price_trend.min_distinct_days'],
  ]);
}, 30_000);

it.each(['unknown-product', 'too-few-days', 'unstable-platform'] as const)(
  '[AC-B1-29b#8] 用例给出 no_data（%s）时完整保留空 points 和 null start_date',
  async (scenario) => {
    const f = await fixture();
    app = f.app;
    if (scenario === 'unknown-product') f.rows.mockResolvedValue([]);
    if (scenario === 'too-few-days') f.rows.mockResolvedValue(snapshotRows().slice(0, 1));
    if (scenario === 'unstable-platform') f.keyStability.mockResolvedValue('stable_24h');
    const response = await f.request();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ code: 0 });
    expect(response.json<{ data: unknown }>().data).toEqual({
      status: 'no_data',
      points: [],
      start_date: null,
      window_days: 30,
      source_key: 'price_trend.source.general',
      mode_price_fen: null,
    });
    expect(f.read).toHaveBeenCalledTimes(1);
    await assertContract(response, 'ProductPriceTrendResponse');
  },
  30_000,
);

it('[AC-B1-29b#9] 保留用例的有券 source_key、零价与大额整数，不截断或转字符串', async () => {
  const f = await fixture();
  app = f.app;
  f.rows.mockResolvedValue(
    snapshotRows(100n).map((row, index) => ({
      ...row,
      finalPriceFen: index === 0 ? 0n : 9007199254740991n,
    })),
  );
  const response = await f.request();
  expect(response.statusCode).toBe(200);
  expect(response.json<{ data: unknown }>().data).toEqual({
    status: 'ok',
    points: [
      { date: '2030-10-16', final_price_fen: 0 },
      { date: '2030-10-17', final_price_fen: 9007199254740991 },
    ],
    start_date: '2030-10-16',
    window_days: 30,
    source_key: 'price_trend.source',
    mode_price_fen: 9007199254740991,
  });
  await assertContract(response, 'ProductPriceTrendResponse');
}, 30_000);

it.each([9007199254740992n, 9007199254740993n])(
  '[AC-B1-29b#14] 金额超过安全整数上限（%s）返回 50001，不输出不安全或舍入的价格',
  async (amount) => {
    const f = await fixture();
    app = f.app;
    f.rows.mockResolvedValue(
      snapshotRows().map((row, index) => ({
        ...row,
        finalPriceFen: index === 0 ? 3290n : amount,
      })),
    );
    const response = await f.request();
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      code: 50001,
      msg: '服务端错误',
      trace_id: '01920000-0000-7000-8000-00000000d029',
    });
    expect(f.read).toHaveBeenCalledTimes(1);
    await assertContract(response, 'ErrorEnvelope');
  },
  30_000,
);

it('[AC-B1-29b#10] 价格走势与商品详情独立：详情不嵌走势、不额外调用 getPriceTrend', async () => {
  const f = await fixture();
  app = f.app;
  const trend = await f.request();
  expect(trend.statusCode).toBe(200);
  expect(f.detail).not.toHaveBeenCalled();
  expect(f.read).toHaveBeenCalledTimes(1);
  f.read.mockClear();
  f.rows.mockClear();
  const detail = await app.inject({
    method: 'GET',
    url: '/v1/products/tb%3Aroute001?item_ref=synthetic-reference',
    headers,
  });
  expect(detail.statusCode).toBe(200);
  // B1-28d: getProduct gained an optional favorited (04 §6.3; CT-22b, B1-28c); this request is a
  // guest's, so favorited, when present, must be false. Every other field is compared as before.
  const detailData = detail.json<{ data: Record<string, unknown> }>().data;
  if ('favorited' in detailData) expect(detailData.favorited).toBe(false);
  const detailRest = { ...detailData };
  delete detailRest.favorited;
  expect(detailRest).toEqual({
    product_key: 'tb:route001',
    item_ref: 'synthetic-reference',
    platform: 'taobao',
    title: '合成详情商品',
    image: null,
    price_fen: 3990,
    coupon_fen: 1000,
    final_price_fen: 2990,
    est_net_price_fen: null,
    rebate_min_fen: 100,
    rebate_max_fen: 200,
    rebate_basis: 'normal',
    benefit_tags: [],
    is_presale: false,
    link_id: '01920000-0000-7000-8000-000000000029',
    cta: { text_key: 'btn.buy.coupon' },
    quoted_at: '2030-10-17T12:00:00+08:00',
    stale: false,
    age_sec: 0,
    source: 'taobao_union',
    disclaimer_keys: ['price_basis'],
    availability: 'ok',
  });
  expect(f.detail).toHaveBeenCalledExactlyOnceWith({
    product_key: 'tb:route001',
    item_ref: 'synthetic-reference',
  });
  expect(f.read).not.toHaveBeenCalled();
  expect(f.rows).not.toHaveBeenCalled();
  await assertContract(detail, 'ProductResponse');
}, 30_000);

it('[AC-B1-29b#11] api 入口恰好注册一次 getProductPriceTrend 且契约去掉 planned', async () => {
  const f = await fixture();
  app = f.app;
  expect(f.routes.filter((route) => route === 'GET /v1/products/:product_key/price-trend')).toEqual(
    ['GET /v1/products/:product_key/price-trend'],
  );
  const operation = (await contract()).paths['/v1/products/{product_key}/price-trend']?.get;
  expect(operation).toMatchObject({
    operationId: 'getProductPriceTrend',
    'x-auth': 'none',
    security: [],
  });
  expect(operation).not.toHaveProperty('x-implementation');
}, 30_000);
