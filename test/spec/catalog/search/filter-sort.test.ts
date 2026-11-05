import { expect, it } from 'vitest';
import { candidate, fixture } from './kit.ts';

it('[AC-B1-05d#1] 价格区间比较券后价且包含两端，只向联盟传券前价下限', async () => {
  const f = fixture();
  f.pages.set(1, {
    items: [
      candidate('below', 999n),
      candidate('min', 1000n, 9000n),
      candidate('max', 2000n, 8000n),
      candidate('above', 2001n),
    ],
    hasMore: false,
  });
  const result = await f.run({ price_min_fen: 1000, price_max_fen: 2000 });
  expect(result.items.map((card) => card.title)).toEqual(['synthetic-min', 'synthetic-max']);
  expect(f.search).toHaveBeenCalledExactlyOnceWith({
    appId: 'synthetic-app',
    platform: 'taobao',
    keyword: '合成纸巾',
    pageNo: 1,
    pageSize: 3,
    sort: 'relevance',
    priceMinFen: 1000,
    promotionSlot: 'synthetic-query-pid',
  });
  expect(result.has_more).toBe(false);
});

it.each([1, 1000, 10_000_000])('[AC-B1-05d#2] min=max=%i 合法且边界价格能返回', async (value) => {
  const f = fixture();
  f.pages.set(1, { items: [candidate('equal', BigInt(value))], hasMore: false });
  const result = await f.run({ price_min_fen: value, price_max_fen: value });
  expect(result.items.map((card) => card.final_price_fen)).toEqual([value]);
});

it.each([
  { price_min_fen: 0 },
  { price_max_fen: 0 },
  { price_min_fen: -1 },
  { price_max_fen: -1 },
  { price_min_fen: 10_000_001 },
  { price_max_fen: 10_000_001 },
  { price_min_fen: 1.5 },
  { price_max_fen: 1.5 },
  { price_min_fen: 2001, price_max_fen: 2000 },
])('[AC-B1-05d#3] 非法价格范围 %j 返回 20001 且不查联盟', async (query) => {
  const f = fixture();
  await expect(f.run(query)).rejects.toMatchObject({ code: 20001 });
  expect(f.search).not.toHaveBeenCalled();
  expect(f.materialFeed).not.toHaveBeenCalled();
  expect(f.register).not.toHaveBeenCalled();
});

it('[AC-B1-05d#4] 只有上限时不得透传上限，也不得把上限当下限', async () => {
  const f = fixture();
  f.pages.set(1, {
    items: [candidate('coupon', 2000n, 8000n), candidate('too-much', 2001n)],
    hasMore: false,
  });
  const result = await f.run({ price_max_fen: 2000 });
  expect(result.items.map((card) => card.title)).toEqual(['synthetic-coupon']);
  expect(f.search).toHaveBeenCalledExactlyOnceWith({
    appId: 'synthetic-app',
    platform: 'taobao',
    keyword: '合成纸巾',
    pageNo: 1,
    pageSize: 3,
    sort: 'relevance',
    promotionSlot: 'synthetic-query-pid',
  });
});

it.each([true, false, undefined])(
  '[AC-B1-05d#5] has_coupon=%s：true 只留有券，其余保留有券和无券',
  async (hasCoupon) => {
    const f = fixture();
    f.pages.set(1, { items: [candidate('none'), candidate('coupon', 1000n, 1n)], hasMore: false });
    const result = await f.run(hasCoupon === undefined ? {} : { has_coupon: hasCoupon });
    expect(result.items.map((card) => card.title)).toEqual(
      hasCoupon === true ? ['synthetic-coupon'] : ['synthetic-none', 'synthetic-coupon'],
    );
    if (hasCoupon === true)
      expect(f.search).toHaveBeenCalledWith(expect.objectContaining({ hasCoupon: true }));
  },
);

it('[AC-B1-05d#6] 券后价升序只排当页，相同价格保留相关性次序，不为排序拉后页', async () => {
  const f = fixture();
  f.pages.set(1, {
    items: [candidate('high', 3000n), candidate('tie-z', 2000n, 1n), candidate('tie-a', 2000n)],
    hasMore: true,
  });
  f.pages.set(2, { items: [candidate('cheapest', 1n)], hasMore: false });
  const result = await f.run({ sort: 'final_price_asc' });
  expect(result.items.map((card) => card.title)).toEqual([
    'synthetic-tie-z',
    'synthetic-tie-a',
    'synthetic-high',
  ]);
  expect(f.search.mock.calls.map(([input]) => [input.pageNo, input.sort])).toEqual([
    [1, 'relevance'],
  ]);
  expect(result.has_more).toBe(true);
});

it('[AC-B1-05d#7] BR-PRICE-15：返利排序按单值返利降序，不请求联盟按返利排序', async () => {
  const f = fixture();
  const highRate = candidate('max-only');
  f.pages.set(1, {
    items: [
      { ...highRate, item: { ...highRate.item, commission_rate_bp: 9000n } },
      candidate('min-winner'),
      candidate('zero-min'),
    ],
    hasMore: true,
  });
  f.quotes.set('synthetic-max-only', { min: 20n, max: 900n });
  f.quotes.set('synthetic-min-winner', { min: 30n, max: 40n });
  f.quotes.set('synthetic-zero-min', { min: 0n, max: 950n });
  const result = await f.run({ sort: 'rebate_desc' });
  expect(result.items.map((card) => card.title)).toEqual([
    'synthetic-zero-min',
    'synthetic-max-only',
    'synthetic-min-winner',
  ]);
  expect(f.search.mock.calls.map(([input]) => input.sort)).toEqual(['relevance']);
});

it.each(['relevance', 'sales_desc'] as const)(
  '[AC-B1-05d#8] %s 保留联盟次序，不悄悄按价格重排',
  async (sort) => {
    const f = fixture();
    f.pages.set(1, { items: [candidate('high', 3000n), candidate('low', 1000n)], hasMore: false });
    const result = await f.run({ sort });
    expect(result.items.map((card) => card.title)).toEqual(['synthetic-high', 'synthetic-low']);
    expect(f.search).toHaveBeenCalledWith(expect.objectContaining({ sort }));
  },
);

it.each(['final_price_asc', 'rebate_desc'] as const)(
  '[AC-B1-05d#9] 补拉结果也参与本次 %s 排序',
  async (sort) => {
    const f = fixture();
    f.pages.set(1, { items: [candidate('high', 3000n), candidate('zero')], hasMore: true });
    f.pages.set(2, {
      items: [candidate('low', 1000n), candidate('middle', 2000n)],
      hasMore: false,
    });
    f.quotes.set('synthetic-zero', { min: 0n, max: 0n });
    f.quotes.set('synthetic-high', { min: 1n, max: 2n });
    f.quotes.set('synthetic-low', { min: 30n, max: 40n });
    f.quotes.set('synthetic-middle', { min: 20n, max: 30n });
    const result = await f.run({ sort });
    expect(result.items.map((card) => card.title)).toEqual([
      'synthetic-low',
      'synthetic-middle',
      'synthetic-high',
    ]);
    expect(f.search.mock.calls.map(([input]) => input.pageNo)).toEqual([1, 2]);
  },
);

it('[AC-B1-05d#10] 异常价格在筛选和排序前排除，经统一入口告警且不登记链接', async () => {
  const f = fixture();
  const zeroed = candidate('anomaly');
  const invalid = candidate('invalid');
  f.pages.set(1, {
    items: [
      {
        ...zeroed,
        item: {
          ...zeroed.item,
          price_status: 'anomaly',
          price_fen: 0n,
          coupon_fen: 0n,
          final_price_fen: 0n,
        },
      },
      { ...invalid, item: { ...invalid.item, final_price_fen: 999n } },
      candidate('good', 1000n, 100n),
    ],
    hasMore: false,
  });
  const result = await f.run({ sort: 'final_price_asc', price_min_fen: 1, has_coupon: true });
  expect(result.items.map((card) => card.title)).toEqual(['synthetic-good']);
  expect(f.warn.mock.calls.filter(([event]) => event.code === 'PRICE_ANOMALY')).toHaveLength(2);
  expect(f.register.mock.calls.map(([input]) => input.item.title)).toEqual(['synthetic-good']);
  expect(f.quote.mock.calls.map(([item]) => item.title)).toEqual(['synthetic-good']);
});
