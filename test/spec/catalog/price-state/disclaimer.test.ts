import { expect, it } from 'vitest';
import { createCardAssembler } from '../../../../apps/api/src/modules/catalog/index.ts';
import { input, item, observed, ports } from './kit.ts';

// Existing public assembly must agree with the new common entry. Each case includes the new
// no-coupon branch, so all cases are assertion-red on B1-05f (not green regression-only tests).
it.each([
  { basis: 'normal' as const, source: 'feed', tail: ['rebate_estimate'] },
  { basis: 'no_rebate' as const, source: 'search', tail: [] },
])(
  '[AC-B1-05i#10] BR-PRICE-03/17：已有出卡器的 $basis 有券/无券口径键精确且顺序不变',
  async ({ basis, source, tail }) => {
    const f = ports();
    const assembler = createCardAssembler(f.options);
    if (basis === 'no_rebate') {
      f.quote.mockResolvedValue({
        rebateMinFen: 0n,
        rebateMaxFen: 0n,
        estNetPriceFen: null,
        rebateBasis: 'no_rebate',
      });
    }
    for (const coupon of [true, false]) {
      const value = item({
        coupon_fen: coupon ? 2000n : 0n,
        final_price_fen: coupon ? 10000n : 12000n,
      });
      const result = await observed(() => assembler.assemble(input(value, 'retrieval', source)));
      expect(result).toMatchObject({
        outcome: 'returned',
        value: {
          rebate_basis: basis,
          disclaimer_keys: [coupon ? 'price_basis' : 'price_basis.general', ...tail],
        },
      });
    }
  },
);

// B1-05zc (D10-641): search and parse cards (the old price_compare_risk sources) are normal with
// rebate_estimate, never rebate_compare.
it.each(['search', 'parse'])(
  '[AC-B1-05i#10] BR-PRICE-03/17：已有出卡器的 %s 来源 normal 有券/无券口径键精确且顺序不变（单值，rebate_estimate）',
  async (source) => {
    const f = ports();
    const assembler = createCardAssembler(f.options);
    for (const coupon of [true, false]) {
      const value = item({
        coupon_fen: coupon ? 2000n : 0n,
        final_price_fen: coupon ? 10000n : 12000n,
      });
      const result = await observed(() => assembler.assemble(input(value, 'retrieval', source)));
      expect(result).toMatchObject({
        outcome: 'returned',
        value: {
          rebate_basis: 'normal',
          disclaimer_keys: [coupon ? 'price_basis' : 'price_basis.general', 'rebate_estimate'],
        },
      });
    }
  },
);
