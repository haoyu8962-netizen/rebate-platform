// B1-05zc (D10-641): both quote ports (commission's real quoter and catalog's demo quoter) price a
// taobao item as one amount; rebate.taobao.compare_rate_ratio_bp is not read at all (5000, another
// value, a malformed value or no entry give the same card), and a price_compare_risk context is
// refused instead of being quoted as a range. The configuration item itself stays in content's
// registry (D10-641); only the quote stops reading it.
import { expect, it } from 'vitest';
import { createCardAssembler } from '../../../../apps/api/src/modules/catalog/index.ts';
import { COMMISSION_QUOTE_CONFIG_KEYS } from '../../../../apps/api/src/modules/commission/application/types.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  compareContext,
  COMPARE_KEY,
  NOW,
  type ConfigValue,
  observed,
  QUOTER_KINDS,
  quoterOf,
  readKeys,
  SINGLE,
  SINGLE_QUOTE,
  tbItem,
  tbRef,
  viewer,
} from './kit.ts';

it.each(QUOTER_KINDS)(
  '[AC-B1-05zc#5] BR-PRICE-07：报价器收到 price_compare_risk 口径一律拒绝，不当区间算、不读比价系数（%s 报价器）',
  async (kind) => {
    for (const platform of ['taobao', 'jd', 'pdd'] as const) {
      // Constructed outside the rejection assertion.
      const q = quoterOf(kind);
      await expect(
        q.quoter.quote(tbItem({ platform }), viewer(), compareContext()),
        platform,
      ).rejects.toThrow(TypeError);
      expect(readKeys(q.config), platform).not.toContain(COMPARE_KEY);
    }
  },
);

it.each(QUOTER_KINDS)(
  '[AC-B1-05zc#6] BR-PRICE-07 / BR-CALC-20：省略 context 的淘宝报价（游客自购、无来源）也是单值（%s 报价器）',
  async (kind) => {
    const q = quoterOf(kind);
    await expect(
      q.quoter.quote(tbItem(), viewer({ userId: null, deviceId: null })),
    ).resolves.toEqual(SINGLE_QUOTE);
    expect(readKeys(q.config)).not.toContain(COMPARE_KEY);
  },
);

const COMPARE_SETTINGS: readonly {
  readonly name: string;
  readonly value: ConfigValue | undefined;
}[] = [
  { name: '比价系数 5000（旧占位值）', value: 5000 },
  { name: '比价系数 2500', value: 2500 },
  { name: '比价系数 0', value: 0 },
  { name: '没有比价系数', value: undefined },
  { name: '比价系数为字符串', value: '5000' },
  { name: '比价系数越界', value: -1 },
];

it.each(QUOTER_KINDS)(
  '[AC-B1-05zc#7] BR-PRICE-07：比价系数配置为任何值或缺失，淘宝搜索卡金额都不变、也不拒绝报价（%s 报价器）',
  async (kind) => {
    for (const setting of COMPARE_SETTINGS) {
      const q = quoterOf(kind);
      if (setting.value === undefined) q.config.values.delete(COMPARE_KEY);
      else q.config.values.set(COMPARE_KEY, setting.value);
      const who = viewer();
      const assembler = createCardAssembler({
        clock: new FixedClock(NOW),
        viewerContext: { current: async () => who },
        quoter: q.quoter,
        registrar: { register: async () => ({ linkId: 'synthetic-parity-link' }) },
        sourceLinks: { entrySource: async () => null },
        itemRefs: { issue: () => 'synthetic-item-ref' },
      });
      const outcome = await observed(() =>
        assembler.assemble({
          item: tbItem(),
          ref: tbRef(who.appId, 'search'),
          entrySource: 'search',
          stale: false,
        }),
      );
      expect(outcome, setting.name).toMatchObject({ outcome: 'returned', value: SINGLE });
      expect(readKeys(q.config), setting.name).not.toContain(COMPARE_KEY);
    }
  },
);

it('[AC-B1-05zc#8] BR-PRICE-07：commission 报价（含 open 预读）读取的配置键不再含比价系数', () => {
  const keys: readonly string[] = COMMISSION_QUOTE_CONFIG_KEYS;
  expect(keys).not.toContain(COMPARE_KEY);
  expect([...keys].sort()).toEqual([
    'commission.platforms',
    'tech_fee_bp',
    'union.pdd.account_level_factor_bp',
    'union.pdd.self_buy_factor_bp',
  ]);
});
