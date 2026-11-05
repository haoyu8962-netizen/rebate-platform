// price_unavailable 卡的 link_id 形状待契约同步（BR-PRICE-01 与 ProductCard.link_id 必填冲突），由后续契约任务与 B1-07a 覆盖。
// Synthetic non-prod rules, never a real platform recording or a production rule/level implementation.
import { expect, it, vi } from 'vitest';
import type { CatalogConfigReader } from '../../../../apps/api/src/modules/catalog/index.ts';
import type { CardQuoteContext } from '../../../../apps/api/src/modules/catalog/application/card-assembler.ts';
import { demoFactory, item, viewer } from './kit.ts';

const RULE_KEY = 'demo.catalog.quote';
const COMPARE_KEY = 'rebate.taobao.compare_rate_ratio_bp';
// B1-05zc (D10-641): a taobao search card asks for the normal basis; the compare range is gone.
const context: CardQuoteContext = {
  buyType: 'self',
  entrySource: 'search',
  rebateBasis: 'normal',
};

function configuration() {
  type ConfigValue = NonNullable<Awaited<ReturnType<CatalogConfigReader['configValue']>>>['value'];
  const values = new Map<string, ConfigValue>([
    [RULE_KEY, { reserve_bp: 1234, self_share_bp: 4567 }],
    ['tech_fee_bp', { taobao: 1379, jd: 1000, pdd: 0 }],
    // Kept on purpose (the old 5000 placeholder): the demo quoter must not read it.
    [COMPARE_KEY, 5000],
  ]);
  const configValue = vi.fn<CatalogConfigReader['configValue']>(async (_appId, key) => {
    const value = values.get(key);
    return value === undefined ? null : { value, version: 1 };
  });
  return { values, configValue };
}

it.each([
  { appEnv: 'local', unionMode: 'demo' },
  { appEnv: 'test', unionMode: 'replay' },
  { appEnv: 'staging', unionMode: 'demo' },
] as const)(
  '[AC-B1-05f#16] $appEnv/$unionMode 演示报价逐步向下取整，淘宝无来源报价也是单值、不读比价系数',
  async ({ appEnv, unionMode }) => {
    const create = demoFactory();
    const config = configuration();
    const quoter = create({ appEnv, unionMode, config, ruleConfigKey: RULE_KEY });
    const product = item({
      price_fen: 11000n,
      coupon_fen: 997n,
      final_price_fen: 10003n,
      commission_rate_bp: 1235n,
    });
    // B1-05zc (D10-641): no context (guest, no entry source) — one amount, no lower bound.
    const result = await quoter.quote(product, viewer({ userId: null }));
    // gross=1235, fee=170, N=1065, after reserve=933, self=426 (the old lower bound was 212).
    expect(result.rebateMinFen).toBe(426n);
    expect(result.rebateMaxFen).toBe(426n);
    // Net = 10003 - 426.
    expect(result.estNetPriceFen).toBe(9577n);
    expect(result.rebateBasis).toBe('normal');
    expect(config.configValue).toHaveBeenCalledWith('card-app-a', RULE_KEY);
    expect(config.configValue).toHaveBeenCalledWith('card-app-a', 'tech_fee_bp');
    expect(config.configValue).not.toHaveBeenCalledWith('card-app-a', COMPARE_KEY);
  },
);

it.each([
  { appEnv: 'prod', unionMode: 'demo' },
  { appEnv: 'prod', unionMode: 'replay' },
  { appEnv: 'prod', unionMode: 'live' },
  { appEnv: 'local', unionMode: 'live' },
  { appEnv: 'test', unionMode: 'live' },
  { appEnv: 'staging', unionMode: 'live' },
] as const)('[AC-B1-05f#17] $appEnv/$unionMode 装配演示报价时拒绝启动', ({ appEnv, unionMode }) => {
  const create = demoFactory();
  // A blanket NotImplemented must not satisfy the refusal scenario.
  expect(() =>
    create({ appEnv, unionMode, config: configuration(), ruleConfigKey: RULE_KEY }),
  ).toThrow(/unsafe|forbidden|prod|live|演示|生产/iu);
});

it.each(['taobao', 'jd', 'pdd'] as const)(
  '[AC-B1-05f#18] 正常 $0 报价 min=max，使用该平台技术服务费',
  async (platform) => {
    const create = demoFactory();
    const config = configuration();
    config.values.set(RULE_KEY, { reserve_bp: 1000, self_share_bp: 5000 });
    const quoter = create({ appEnv: 'test', unionMode: 'demo', config, ruleConfigKey: RULE_KEY });
    const result = await quoter.quote(item({ platform }), viewer(), {
      ...context,
      entrySource: 'pool',
      rebateBasis: 'normal',
    });
    // gross=1000; fee TB=137/JD=100/PDD=0; reserve then self gives 388/405/450.
    const expected = { taobao: 388n, jd: 405n, pdd: 450n }[platform];
    expect(result.rebateMinFen).toBe(expected);
    expect(result.rebateMaxFen).toBe(expected);
    const expectedNet = { taobao: 9612n, jd: 9595n, pdd: 9550n }[platform];
    expect(result.estNetPriceFen).toBe(expectedNet);
    expect(result.rebateBasis).toBe('normal');
  },
);

it('[AC-B1-05f#19] 配置与应用切换即时影响演示报价，不缓存上个请求的结果；比价系数变更不影响金额', async () => {
  const create = demoFactory();
  const config = configuration();
  config.values.set('tech_fee_bp', { taobao: 0 });
  config.values.set(RULE_KEY, { reserve_bp: 0, self_share_bp: 10000 });
  const quoter = create({ appEnv: 'test', unionMode: 'demo', config, ruleConfigKey: RULE_KEY });
  // B1-05zc (D10-641): taobao quotes without context are single amounts; the rule change is what
  // the second quote must see, the compare ratio change must not matter.
  const first = await quoter.quote(item(), viewer());
  config.values.set(COMPARE_KEY, 2500);
  config.values.set(RULE_KEY, { reserve_bp: 0, self_share_bp: 5000 });
  const second = await quoter.quote(item(), viewer({ appId: 'card-app-b' }));
  expect(first.rebateMinFen).toBe(1000n);
  expect(first.rebateMaxFen).toBe(1000n);
  expect(second.rebateMinFen).toBe(500n);
  expect(second.rebateMaxFen).toBe(500n);
  expect(config.configValue).toHaveBeenCalledWith('card-app-b', RULE_KEY);
  expect(config.configValue).not.toHaveBeenCalledWith(expect.anything(), COMPARE_KEY);
});

it.each([RULE_KEY, 'tech_fee_bp'])(
  '[AC-B1-05f#20] 缺少 %s 时拒绝报价，不臆造演示规则',
  async (missing) => {
    const create = demoFactory();
    const config = configuration();
    config.values.delete(missing);
    const quoter = create({ appEnv: 'test', unionMode: 'demo', config, ruleConfigKey: RULE_KEY });
    await expect(quoter.quote(item(), viewer(), context)).rejects.toThrow(
      /config|missing|rule|配置|缺少/iu,
    );
  },
);

it('[AC-B1-05f#21] BR-PRICE-07/08：一分返利也是单值 1–1，零上限为无返利', async () => {
  const create = demoFactory();
  const config = configuration();
  config.values.set('tech_fee_bp', { taobao: 0 });
  config.values.set(RULE_KEY, { reserve_bp: 0, self_share_bp: 10000 });
  const quoter = create({ appEnv: 'test', unionMode: 'demo', config, ruleConfigKey: RULE_KEY });
  const tiny = item({
    price_fen: 1n,
    coupon_fen: 0n,
    final_price_fen: 1n,
    commission_rate_bp: 10000n,
  });
  // B1-05zc (D10-641): no context — the old code gave a 0–1 compare range here.
  const positive = await quoter.quote(tiny, viewer());
  expect(positive.rebateMinFen).toBe(1n);
  expect(positive.rebateMaxFen).toBe(1n);
  expect(positive.estNetPriceFen).toBe(0n);
  expect(positive.rebateBasis).toBe('normal');
  const zero = await quoter.quote({ ...tiny, commission_rate_bp: 0n }, viewer(), context);
  expect(zero.rebateMinFen).toBe(0n);
  expect(zero.rebateMaxFen).toBe(0n);
  expect(zero.rebateBasis).toBe('no_rebate');
  expect(zero.estNetPriceFen).toBeNull();
});

it('[AC-B1-05f#23] BR-CALC-20：预留步向下取整，本人全额份额保留一分差异', async () => {
  const create = demoFactory();
  const config = configuration();
  config.values.set('tech_fee_bp', { taobao: 0 });
  config.values.set(RULE_KEY, { reserve_bp: 1234, self_share_bp: 10000 });
  const quoter = create({ appEnv: 'test', unionMode: 'demo', config, ruleConfigKey: RULE_KEY });
  const result = await quoter.quote(item(), viewer(), {
    ...context,
    entrySource: 'pool',
    rebateBasis: 'normal',
  });
  // gross=N=1000; floor(1000 * 8766 / 10000)=876, not rounded 877; self=876.
  expect(result.rebateMinFen).toBe(876n);
  expect(result.rebateMaxFen).toBe(876n);
});

it.each(['jd', 'pdd'] as const)(
  '[AC-B1-05f#20] tech_fee_bp 仅含淘宝时拒绝 $0 报价，不补平台默认值',
  async (platform) => {
    const create = demoFactory();
    const config = configuration();
    config.values.set('tech_fee_bp', { taobao: 0 });
    const quoter = create({ appEnv: 'test', unionMode: 'demo', config, ruleConfigKey: RULE_KEY });
    await expect(
      quoter.quote(item({ platform }), viewer(), { ...context, rebateBasis: 'normal' }),
    ).rejects.toThrow(/config|missing|rule|配置|缺少/iu);
  },
);
