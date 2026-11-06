// price_unavailable 卡的 link_id 形状待契约同步（BR-PRICE-01 与 ProductCard.link_id 必填冲突），由后续契约任务与 B1-07a 覆盖。
// Only priced cards. Filtering/refill, cache storage/eligibility and link persistence belong to callers.
import { expect, it } from 'vitest';
import {
  amounts,
  compareQuote,
  fen,
  fixture,
  item,
  QUOTED_AT,
  quote,
  ref,
  request,
  viewer,
} from './kit.ts';

// B1-05zc (D10-641): a taobao search card is one amount (normal, min = max) with rebate_estimate.
// B1-05zg (D10-664 S-08, BR-TEXT-12 v3): a normal card with a coupon now carries btn.buy.rebate.
it('[AC-B1-05f#1] BR-PRICE-01/06：保留三个价格字段，只透传报价端口的本人份额（淘宝搜索卡单值，有券按钮 btn.buy.rebate）', async () => {
  const f = fixture();
  const input = request();
  const card = await f.service.assemble(input);
  expect(amounts(card)).toEqual({
    price: 12000n,
    coupon: 2000n,
    final: 10000n,
    min: 433n,
    max: 433n,
    net: 9567n,
  });
  expect(f.quoted).toHaveBeenCalledExactlyOnceWith(input.item, viewer(), {
    buyType: 'self',
    entrySource: 'search',
    rebateBasis: 'normal',
  });
  expect(card).toMatchObject({
    product_key: input.ref.productKey,
    platform: 'taobao',
    title: '合成商品',
    image: null,
    is_presale: false,
    availability: 'ok',
    source: 'taobao_union',
    rebate_basis: 'normal',
    cta: { text_key: 'btn.buy.rebate' },
    link_id: 'registered-link',
    item_ref: 'opaque-item-ref',
  });
  expect(card.disclaimer_keys).toEqual(['price_basis', 'rebate_estimate']);
  expect(Array.isArray(card.benefit_tags)).toBe(true);
});

it('[AC-B1-05f#2] 带价卡使用登记返回的 link_id，item_ref 使用原始取价身份', async () => {
  const f = fixture();
  const input = request();
  await f.service.assemble(input);
  expect(f.register).toHaveBeenCalledExactlyOnceWith({
    viewer: viewer(),
    ref: input.ref,
    item: input.item,
    quote: quote(),
    entrySource: 'search',
  });
  expect(f.issue).toHaveBeenCalledExactlyOnceWith({
    appId: 'card-app-a',
    platform: 'taobao',
    productKey: 'tb:synthetic',
    rawItemId: 'synthetic-item',
    fetchedAt: QUOTED_AT,
  });
});

it('[AC-B1-05f#3] BR-PRICE-11：相同 DTO 每次按当前查看者报价，不缓存整卡', async () => {
  const f = fixture();
  const input = request();
  const first = await f.service.assemble(input);
  f.current.mockResolvedValue(viewer({ userId: null, deviceId: 'guest-device' }));
  // B1-05zc: answers the requested basis (as the kit fixture does), so an assembler that still asks
  // for price_compare_risk gets the old 101–203 range and fails the assertions, not a basis check.
  f.quoted.mockImplementation(async (_item, _viewer, context) =>
    context?.rebateBasis === 'normal'
      ? quote({ rebateMinFen: 203n, rebateMaxFen: 203n, estNetPriceFen: 9797n })
      : compareQuote({ rebateMinFen: 101n, rebateMaxFen: 203n, estNetPriceFen: 9899n }),
  );
  f.register.mockResolvedValue({ linkId: 'second-link' });
  f.clock.advanceMs(1000);
  const second = await f.service.assemble(input);
  // B1-05zc (D10-641): both quotes are single amounts on the normal basis.
  expect(fen(first.rebate_min_fen)).toBe(433n);
  expect(fen(second.rebate_min_fen)).toBe(203n);
  expect(fen(second.rebate_max_fen)).toBe(203n);
  expect(fen(second.est_net_price_fen)).toBe(9797n);
  expect(second.link_id).toBe('second-link');
  expect(f.current).toHaveBeenCalledTimes(2);
  expect(f.quoted).toHaveBeenLastCalledWith(
    input.item,
    viewer({ userId: null, deviceId: 'guest-device' }),
    {
      buyType: 'self',
      entrySource: 'search',
      rebateBasis: 'normal',
    },
  );
  expect(f.register).toHaveBeenCalledTimes(2);
  expect(second.quoted_at).toBe(first.quoted_at);
  expect(second.age_sec).toBe(301);
});

it.each([
  { elapsed: 0, stale: false, age: 0 },
  { elapsed: 299999, stale: false, age: 299 },
  { elapsed: 300000, stale: true, age: 300 },
  { elapsed: 301000, stale: false, age: 301 },
  { elapsed: 7200000, stale: true, age: 7200 },
])(
  '[AC-B1-05f#4] BR-PRICE-11：原时间不改写，经过 $elapsed ms 时年龄为 $age 秒',
  async ({ elapsed, stale, age }) => {
    const f = fixture();
    f.clock.set(QUOTED_AT);
    f.clock.advanceMs(elapsed);
    const card = await f.service.assemble(request({ stale }));
    expect(card.quoted_at).toBe(QUOTED_AT);
    expect(card.age_sec).toBe(age);
    expect(card.stale).toBe(stale);
  },
);

it('[AC-B1-05f#5] BR-PRICE-11：age 在报价完成后取响应时刻，不取请求开始时刻', async () => {
  const f = fixture();
  f.clock.set(QUOTED_AT);
  f.quoted.mockImplementation(async () => {
    f.clock.advanceMs(2200);
    return quote();
  });
  const card = await f.service.assemble(request());
  expect(card.age_sec).toBe(2);
  expect(card.quoted_at).toBe(QUOTED_AT);
});

it('[AC-B1-05f#24] BR-PRICE-11：UTC 取价时间转成同一时刻的 +08:00，年龄不变', async () => {
  const f = fixture();
  const utcQuotedAt = '2026-10-06T02:00:00.000Z';
  const card = await f.service.assemble(
    request({
      item: item({ quoted_at: utcQuotedAt }),
      ref: ref({ rawFetchedAt: utcQuotedAt, receivedAt: utcQuotedAt }),
      stale: true,
    }),
  );
  expect(card.quoted_at).toBe('2026-10-06T10:00:00+08:00');
  expect(card.age_sec).toBe(300);
  expect(card.stale).toBe(true);
});

it.each(['search', 'feed', 'agent', 'parse', 'rebate_quote', 'tlj_pool'])(
  '[AC-B1-05f#6] BR-PRICE-08：$0 上限为零统一 no_rebate，由调用方决定是否过滤',
  async (entrySource) => {
    const f = fixture();
    f.quoted.mockResolvedValue(quote({ rebateMinFen: 0n, rebateMaxFen: 0n, estNetPriceFen: null }));
    const card = await f.service.assemble(request({ entrySource }));
    expect(card.rebate_basis).toBe('no_rebate');
    expect(fen(card.rebate_min_fen)).toBe(0n);
    expect(fen(card.rebate_max_fen)).toBe(0n);
    expect(card.est_net_price_fen).toBeNull();
    expect(card.cta).toEqual({ text_key: 'btn.buy.no_rebate' });
    expect(card.no_rebate_cause ?? null).toBeNull();
    expect(card.disclaimer_keys).not.toContain('rebate_compare');
    expect(card.disclaimer_keys).not.toContain('rebate_estimate');
    // Registrar must see no_rebate so its later implementation can avoid a quote snapshot.
    expect(f.register).toHaveBeenCalledWith(
      expect.objectContaining({
        quote: expect.objectContaining({ rebateBasis: 'no_rebate' }),
      }),
    );
  },
);

// B1-05zc (D10-641): the card asks for one amount; a quoter answering a compare range (here 0–1)
// is refused, so no range card is shown and no link is registered.
it('[AC-B1-05f#7] BR-PRICE-07：报价端口回比价区间（0–1）时拒绝出卡，不下发区间也不登记', async () => {
  const f = fixture();
  f.quoted.mockResolvedValue(
    compareQuote({ rebateMinFen: 0n, rebateMaxFen: 1n, estNetPriceFen: null }),
  );
  await expect(f.service.assemble(request())).rejects.toThrow();
  expect(f.register).not.toHaveBeenCalled();
});

// B1-05zg (D10-664 S-08, BR-TEXT-12 v3): with or without a coupon the same btn.buy.rebate.
it('[AC-B1-05f#8] 无券正常返利与有券同用 btn.buy.rebate 购买按钮，JSON 金额保留安全整数上界', async () => {
  const f = fixture();
  const large = item({
    price_fen: 9007199254740991n,
    coupon_fen: 0n,
    final_price_fen: 9007199254740991n,
  });
  f.quoted.mockResolvedValue(
    quote({
      rebateBasis: 'normal',
      rebateMinFen: 1n,
      rebateMaxFen: 1n,
      estNetPriceFen: 9007199254740990n,
    }),
  );
  const card = await f.service.assemble(request({ item: large, entrySource: 'pool' }));
  expect(amounts(card)).toEqual({
    price: 9007199254740991n,
    coupon: 0n,
    final: 9007199254740991n,
    min: 1n,
    max: 1n,
    net: 9007199254740990n,
  });
  expect(card.cta).toEqual({ text_key: 'btn.buy.rebate' });
  // BR-PRICE-03: a no-coupon card carries exactly one of price_basis and price_basis.general.
  expect(
    card.disclaimer_keys.filter((key) => key === 'price_basis' || key === 'price_basis.general'),
  ).toHaveLength(1);
  expect(card.disclaimer_keys).not.toContain('rebate_compare');
});

it('[AC-B1-05f#9] 登记失败不能返回伪造 link_id 或半成品卡', async () => {
  const f = fixture();
  const error = new Error('synthetic registration failure');
  f.register.mockRejectedValue(error);
  await expect(f.service.assemble(request())).rejects.toBe(error);
});

it('[AC-B1-05f#10] 报价失败不能登记零值报价冒充成功', async () => {
  const f = fixture();
  const error = new Error('synthetic quote failure');
  f.quoted.mockRejectedValue(error);
  await expect(f.service.assemble(request())).rejects.toBe(error);
  expect(f.register).not.toHaveBeenCalled();
});

it.each(['jd', 'pdd'] as const)(
  '[AC-B1-05f#11] $0 使用对应联盟来源且不生成淘宝区间',
  async (platform) => {
    const f = fixture();
    const card = await f.service.assemble(
      request({
        item: item({ platform }),
        ref: ref({ platform, productKey: `${platform}:synthetic` }),
      }),
    );
    expect(card.platform).toBe(platform);
    expect(card.source).toBe(`${platform}_union`);
    expect(card.rebate_basis).toBe('normal');
    expect(fen(card.rebate_min_fen)).toBe(433n);
    expect(fen(card.rebate_max_fen)).toBe(433n);
    expect(card.disclaimer_keys).not.toContain('rebate_compare');
  },
);
