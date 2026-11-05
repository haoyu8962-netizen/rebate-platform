import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  databaseFixture,
  fixture,
  reprice,
  service,
  source,
  stored,
  success,
  unknownPricePddLink,
  USER_A,
  USER_B,
} from './kit.ts';

const database = databaseFixture(createTestDatabase);

it.each([
  [2990n, 3090n, true],
  [2990n, 2890n, true],
  [2990n, 3080n, false],
  [2990n, 2900n, false],
  [1000n, 950n, true],
  [1000n, 1050n, true],
  [1000n, 951n, false],
  [1000n, 1049n, false],
  [300000n, 300100n, true],
  [300000n, 299900n, true],
  [2990n, 2990n, false],
  // New price remains JSON-safe for catalog, old must retain the original bigint exactly.
  [9007199254740993n, 9007199254740991n, false],
] as const)(
  '[AC-B1-06k#1] BR-PRICE-13：%s → %s 阈值含等号、涨跌对称、两阈值取或 = %s',
  async (old, next, changed) => {
    const db = database();
    const f = fixture(db);
    const original = await source(f, old);
    reprice(f, next);
    const result = success(await service(f).open(f.request(original.link_id)));
    expect(result).toMatchObject({
      old_final_price_fen: old.toString(),
      new_final_price_fen: next.toString(),
      price_changed: changed,
      requote_failed: false,
      availability: 'ok',
      new_rebate_min_fen: '229',
      new_rebate_max_fen: '229',
    });
    if (old !== next) {
      expect(result.new_link_id).toEqual(expect.any(String));
      expect(result.new_link_id).not.toBe(original.link_id);
      expect(await stored(db, result.new_link_id!)).toMatchObject({
        quoted_final_price_fen: next,
        quoted_coupon_fen: 0n,
        quoted_at: f.clock.now(),
        user_id: USER_A,
      });
    }
    expect(await stored(db, original.link_id)).toEqual(original);
    expect(f.assemble).toHaveBeenCalledWith(expect.objectContaining({ scene: 'active_query' }));
    expect(f.quote).toHaveBeenCalledTimes(1);
  },
);

it('[AC-B1-06k#2] BR-PRICE-12：取消后再次打开旧卡仍比旧价，新卡才比新快照', async () => {
  const db = database();
  const f = fixture(db);
  const original = await source(f);
  const s = service(f);
  reprice(f, 3090n);
  const first = success(await s.open(f.request(original.link_id)));
  f.clock.advanceMs(3001);
  const oldAgain = success(await s.open(f.request(original.link_id)));
  expect(oldAgain).toMatchObject({ old_final_price_fen: '2990', price_changed: true });
  const fresh = success(await s.open(f.request(first.new_link_id!)));
  expect(fresh).toMatchObject({
    old_final_price_fen: '3090',
    new_final_price_fen: '3090',
    price_changed: false,
  });
  expect(await stored(db, original.link_id)).toEqual(original);
});

it('[AC-B1-06k#3] BR-PRICE-12/G-08：他人非分享卡新建归属后，比较基准仍取原卡', async () => {
  const db = database();
  const f = fixture(db, { userId: USER_B });
  const original = await source(f);
  reprice(f, 3080n);
  const result = success(await service(f).open(f.request(original.link_id)));
  expect(result).toMatchObject({
    old_final_price_fen: '2990',
    new_final_price_fen: '3080',
    price_changed: false,
  });
  expect(result.new_link_id).not.toBeNull();
  expect(await stored(db, result.new_link_id!)).toMatchObject({
    user_id: USER_B,
    quoted_final_price_fen: 3080n,
  });
  expect(await stored(db, original.link_id)).toEqual(original);
});

it.each([undefined, 0])(
  '[AC-B1-06k#4] BR-PRICE-20：requote_after_sec=%s，刚登记的快照也实时取价，链接缓存不免复核',
  async (setting) => {
    const f = fixture(database());
    if (setting !== undefined) f.config.set('link.open.requote_after_sec', setting);
    const original = await source(f, 2990n, { quoted_at: f.clock.now().toISOString() });
    const s = service(f);
    const first = success(await s.open(f.request(original.link_id)));
    f.clock.advanceMs(3001);
    reprice(f, 3090n);
    const second = success(await s.open(f.request(original.link_id)));
    expect(first.new_final_price_fen).toBe('2990');
    expect(second).toMatchObject({ new_final_price_fen: '3090', price_changed: true });
    expect(f.fetch).toHaveBeenCalledTimes(2);
    expect(f.configValue).toHaveBeenCalledWith('register-app', 'link.open.requote_after_sec');
  },
);

it.each([
  [150n, true],
  [149n, false],
  [-150n, true],
] as const)(
  '[AC-B1-06k#5] BR-PRICE-13：阈值经配置读取，差价 %s 的判定为 %s',
  async (diff, changed) => {
    const f = fixture(database());
    f.config.set('link.price_change.min_fen', 200);
    f.config.set('link.price_change.ratio_bp', 1000);
    const original = await source(f, 1500n);
    reprice(f, 1500n + diff);
    const result = success(await service(f).open(f.request(original.link_id)));
    expect(result.price_changed).toBe(changed);
    expect(f.configValue).toHaveBeenCalledWith('register-app', 'link.price_change.min_fen');
    expect(f.configValue).toHaveBeenCalledWith('register-app', 'link.price_change.ratio_bp');
  },
);

it.each([0n, 180n])(
  '[AC-B1-06k#6] BR-PRICE-13：返利改为 %s 分由 catalog 报价下发，保留独立的价格判定',
  async (rebate) => {
    const f = fixture(database());
    const original = await source(f);
    const s = service(f);
    expect(success(await s.open(f.request(original.link_id))).new_rebate_max_fen).toBe('229');
    f.clock.advanceMs(3001);
    // B1-05zc (D10-641): the taobao search card's re-check asks for the normal basis and gets one
    // amount; price_compare_risk is never the answer of a pre-order quote.
    f.quote.mockResolvedValue({
      rebateMinFen: rebate,
      rebateMaxFen: rebate,
      estNetPriceFen: null,
      rebateBasis: rebate === 0n ? 'no_rebate' : 'normal',
    });
    const result = success(await s.open(f.request(original.link_id)));
    expect(result).toMatchObject({
      price_changed: false,
      requote_failed: false,
      new_rebate_min_fen: rebate.toString(),
      new_rebate_max_fen: rebate.toString(),
    });
    expect(result).not.toHaveProperty('rebate_basis');
    expect(f.quote).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ rebateBasis: 'normal' }),
    );
  },
);

it('[AC-B1-06k#7] BR-PRICE-13：拼多多 amount_unknown 不取价、不报价，只转链并签发尝试', async () => {
  const db = database();
  const f = fixture(db);
  const original = await unknownPricePddLink(db);
  f.fetch.mockRejectedValue(new Error('synthetic: amount_unknown must not fetch'));
  const result = success(await service(f).open(f.request(original.link_id)));
  expect(result).toMatchObject({
    old_final_price_fen: null,
    new_final_price_fen: null,
    new_rebate_min_fen: null,
    new_rebate_max_fen: null,
    quoted_at: null,
    price_changed: false,
    requote_failed: false,
    attempt_id: expect.any(String),
    jump: expect.any(Object),
  });
  expect(f.fetch).not.toHaveBeenCalled();
  expect(f.assemble).not.toHaveBeenCalled();
  expect(f.convert).toHaveBeenCalledTimes(1);
});

it.each([undefined, false])(
  '[AC-B1-06k#8] 拼多多预判开关 %s：仅走普通实时取价与 catalog 报价，不伪造比价结论',
  async (enabled) => {
    const f = fixture(database());
    if (enabled !== undefined) f.config.set('rebate.pdd.compare_precheck.enabled', enabled);
    const original = await source(f, 2990n, { platform: 'pdd' });
    const result = success(await service(f).open(f.request(original.link_id)));
    expect(result).toMatchObject({ new_rebate_min_fen: '229', new_rebate_max_fen: '229' });
    expect(result.no_rebate_cause ?? null).toBeNull();
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(f.convert).toHaveBeenCalledTimes(1);
    expect(f.configValue).toHaveBeenCalledWith(
      'register-app',
      'rebate.pdd.compare_precheck.enabled',
    );
  },
);
