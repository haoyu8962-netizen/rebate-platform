import { propRuns, propSeed } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import {
  ctx,
  detailRow,
  detailSetup,
  ITEM_ID,
  promotion,
  ref,
  type Row,
} from '../taobao-goods/kit.ts';

// Task-local AC labels ([AC-B1-04zj#n]) identify this task's acceptance points, not business rules.
// BR-PRICE-01: a yuan string with more than two decimals (trailing zeros count as decimals) is a
// missing field, never rounded or truncated. On the Taobao detail path the missing amount goes to
// mapTaobaoPrice, which reports price_status 'anomaly' with reason 'missing_field' (three prices 0).
// Every row below is built so that a truncating parser would see a consistent, valid price: the
// detail must still come back, but as a missing-field anomaly, and never with the truncated price.
// Synthetic bodies only (the frozen taobao-goods kit); no network, no listening port.

interface Truncated {
  readonly price_fen: bigint;
  readonly coupon_fen: bigint;
  readonly final_price_fen: bigint;
}

/** Canonical two-decimal yuan string of a non-negative fen amount (test-side, no float). */
function yuan(fen: bigint): string {
  return `${fen / 100n}.${(fen % 100n).toString().padStart(2, '0')}`;
}

async function expectMissingField(row: Row, truncated: Truncated): Promise<void> {
  const { adapter } = detailSetup([row]);
  const detail = await adapter.getItem(ref, ctx);
  expect(detail).toMatchObject({
    platform: 'taobao',
    item_id: ITEM_ID,
    title: '合成详情商品',
    price_fen: 0n,
    coupon_fen: 0n,
    final_price_fen: 0n,
    price_status: 'anomaly',
    price_anomaly_reason: 'missing_field',
  });
  expect(detail).not.toHaveProperty('coupon_ids');
  expect(detail).not.toMatchObject(truncated);
}

it.each([
  {
    zk: '19.999',
    fee: '3.33',
    final: '16.66',
    truncated: { price_fen: 1999n, coupon_fen: 333n, final_price_fen: 1666n },
  },
  {
    zk: '59.900',
    fee: '10.00',
    final: '49.90',
    truncated: { price_fen: 5990n, coupon_fen: 1000n, final_price_fen: 4990n },
  },
  {
    zk: '7.005',
    fee: '2.00',
    final: '5.00',
    truncated: { price_fen: 700n, coupon_fen: 200n, final_price_fen: 500n },
  },
])(
  '[AC-B1-04zj#1][BR-PRICE-01] zk_final_price 超过两位小数（$zk）视为缺失 → missing_field 异常，不出截断价',
  async ({ zk, fee, final, truncated }) => {
    const row = detailRow({
      price: { zk_final_price: zk, final_promotion_price: final },
      promotions: [promotion('商品券', fee, 'syn-coupon-0001')],
    });
    await expectMissingField(row, truncated);
  },
);

it('[AC-B1-04zj#2][BR-PRICE-01] zk_final_price 超过两位小数且没有优惠明细（12.3450）→ missing_field 异常', async () => {
  const row = detailRow({
    price: { zk_final_price: '12.3450', final_promotion_price: '12.34' },
    promotions: [],
  });
  await expectMissingField(row, { price_fen: 1234n, coupon_fen: 0n, final_price_fen: 1234n });
});

it.each([
  {
    zk: '10.00',
    fee: '3.00',
    final: '7.005',
    truncated: { price_fen: 1000n, coupon_fen: 300n, final_price_fen: 700n },
  },
  {
    zk: '19.99',
    fee: '3.33',
    final: '16.669',
    truncated: { price_fen: 1999n, coupon_fen: 333n, final_price_fen: 1666n },
  },
  {
    zk: '59.90',
    fee: '19.40',
    final: '40.500',
    truncated: { price_fen: 5990n, coupon_fen: 1940n, final_price_fen: 4050n },
  },
])(
  '[AC-B1-04zj#3][BR-PRICE-01] final_promotion_price 超过两位小数（$final）视为缺失 → missing_field 异常，不出截断价',
  async ({ zk, fee, final, truncated }) => {
    const row = detailRow({
      price: { zk_final_price: zk, final_promotion_price: final },
      promotions: [promotion('商品券', fee, 'syn-coupon-0001')],
    });
    await expectMissingField(row, truncated);
  },
);

it.each([
  {
    zk: '59.90',
    fee: '40.500',
    final: '19.40',
    truncated: { price_fen: 5990n, coupon_fen: 4050n, final_price_fen: 1940n },
  },
  {
    zk: '30.00',
    fee: '0.001',
    final: '30.00',
    truncated: { price_fen: 3000n, coupon_fen: 0n, final_price_fen: 3000n },
  },
  {
    zk: '19.99',
    fee: '3.339',
    final: '16.66',
    truncated: { price_fen: 1999n, coupon_fen: 333n, final_price_fen: 1666n },
  },
])(
  '[AC-B1-04zj#4][BR-PRICE-01] 券项 promotion_fee 超过两位小数（$fee）视为缺失 → missing_field 异常，不出截断价',
  async ({ zk, fee, final, truncated }) => {
    const row = detailRow({
      price: { zk_final_price: zk, final_promotion_price: final },
      promotions: [promotion('商品券', fee, 'syn-coupon-0001')],
    });
    await expectMissingField(row, truncated);
  },
);

it('[AC-B1-04zj#5][BR-PRICE-01] 会员项 promotion_fee 超过两位小数（5.005）也视为缺失，不按截断值加回', async () => {
  const row = detailRow({
    price: { zk_final_price: '59.90', final_promotion_price: '44.90' },
    promotions: [
      promotion('商品券', '10.00', 'syn-coupon-0001'),
      promotion('88VIP', '5.005', 'syn-member-0001'),
    ],
  });
  await expectMissingField(row, { price_fen: 5990n, coupon_fen: 1000n, final_price_fen: 4990n });
});

it('[AC-B1-04zj#6][BR-PRICE-01] 任一价格字段在合法两位小数后再追加任意数字（含 0）→ 一律 missing_field，不截断', async () => {
  const amounts = fc
    .bigInt({ min: 2n, max: 999_999_999n })
    .chain((price) => fc.tuple(fc.constant(price), fc.bigInt({ min: 1n, max: price - 1n })));
  const extra = fc
    .array(fc.integer({ min: 0, max: 9 }), { minLength: 1, maxLength: 4 })
    .map((digits) => digits.join(''));
  const target = fc.constantFrom('zk_final_price', 'final_promotion_price', 'promotion_fee');
  await fc.assert(
    fc.asyncProperty(amounts, extra, target, async ([price, coupon], tail, field) => {
      const final = price - coupon;
      // Two-decimal strings always carry a ".", so the tail lengthens the decimals only.
      const zk = yuan(price) + (field === 'zk_final_price' ? tail : '');
      const promotionFinal = yuan(final) + (field === 'final_promotion_price' ? tail : '');
      const fee = yuan(coupon) + (field === 'promotion_fee' ? tail : '');
      const row = detailRow({
        price: { zk_final_price: zk, final_promotion_price: promotionFinal },
        promotions: [promotion('商品券', fee, 'syn-coupon-0001')],
      });
      await expectMissingField(row, {
        price_fen: price,
        coupon_fen: coupon,
        final_price_fen: final,
      });
    }),
    // Every run builds a detail adapter fixture, so PROP_RUNS is scaled by 1/100 with a floor of 50
    // and the seed is PROP_SEED as it is (same as #2682 / D10-902).
    { numRuns: Math.max(50, Math.floor(propRuns() / 100)), seed: propSeed() },
  );
}, 900_000);
