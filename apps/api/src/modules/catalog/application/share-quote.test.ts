// B1-15w unit tests: the buy_type=share quote of POST /v1/shares over a recording quoter.
import { describe, expect, it } from 'vitest';
import type { UnionItem } from '../../union/index.ts';
import type { RebateQuote } from '../ports.ts';
import type { CardRebateQuoter } from './card-assembler.ts';
import { quoteShare, settleShareQuote } from './share-quote.ts';

const VIEWER = { appId: 'synthetic_app', userId: 'u-1', deviceId: 'd-1' };

type Basis = RebateQuote['rebateBasis'];

function answer(min: bigint | null, max: bigint, basis: Basis): RebateQuote {
  return { rebateMinFen: min, rebateMaxFen: max, estNetPriceFen: null, rebateBasis: basis };
}

function item(platform: UnionItem['platform']): UnionItem {
  return {
    platform,
    item_id: '1',
    title: '演示商品',
    price_fen: 5990n,
    coupon_fen: 1000n,
    final_price_fen: 4990n,
    commission_rate_bp: 1000n,
    quoted_at: '2026-10-30T01:58:30.000Z',
  };
}

function recording(result: RebateQuote) {
  const calls: unknown[][] = [];
  const quoter = {
    quote(...args: unknown[]) {
      calls.push(args);
      return Promise.resolve(result);
    },
  } as unknown as CardRebateQuoter;
  return { quoter, calls };
}

describe('share quote (B1-15w)', () => {
  it('[AC-B1-15w] quotes buy_type=share for the viewer with the share entry (normal basis)', async () => {
    const { quoter, calls } = recording({
      rebateMinFen: 180n,
      rebateMaxFen: 180n,
      estNetPriceFen: 4810n,
      rebateBasis: 'normal',
    });
    const quote = await quoteShare(quoter, item('taobao'), VIEWER);
    expect(calls).toEqual([
      [item('taobao'), VIEWER, { buyType: 'share', entrySource: 'share', rebateBasis: 'normal' }],
    ]);
    expect(quote).toEqual({
      estPromo: { rebate_min_fen: 180, rebate_max_fen: 180, rebate_basis: 'normal' },
      quotedAt: '2026-10-30T09:58:30+08:00',
      quotedAtMs: Date.parse('2026-10-30T01:58:30.000Z'),
    });
  });

  it('[AC-B1-15w] BR-PRICE-08: a zero upper bound is no_rebate; malformed answers are refused', () => {
    const zero = settleShareQuote(answer(0n, 0n, 'normal'), 'normal');
    expect(zero).toEqual({ rebate_min_fen: 0, rebate_max_fen: 0, rebate_basis: 'no_rebate' });
    expect(() => settleShareQuote(answer(null, 1n, 'normal'), 'normal')).toThrow(TypeError);
    expect(() => settleShareQuote(answer(5n, 1n, 'normal'), 'normal')).toThrow(TypeError);
    const other = answer(1n, 2n, 'price_compare_risk');
    expect(() => settleShareQuote(other, 'normal')).toThrow(TypeError);
  });

  it('[AC-B1-05zc] D10-641: a normal share quote is one amount; a range is refused', () => {
    expect(() => settleShareQuote(answer(1n, 2n, 'normal'), 'normal')).toThrow(TypeError);
    expect(settleShareQuote(answer(2n, 2n, 'normal'), 'normal')).toEqual({
      rebate_min_fen: 2,
      rebate_max_fen: 2,
      rebate_basis: 'normal',
    });
  });
});
