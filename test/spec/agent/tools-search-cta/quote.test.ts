// B1-05zg (D10-664 S-08): 查返利（get_rebate_quote 的链接报价）的 normal 单值卡，购买按钮有券、无券都是
// btn.buy.rebate（08 BR-TEXT-12 细则「购买按钮」2026-11-05 v3）。走 test/spec/agent/tools-quote/kit.ts
// 的真实 createCatalogCardEntry（只读，不改那个 kit）。
import { expect, it } from 'vitest';
import { createLinkQuoteRunner } from '../../../../apps/api/src/modules/agent/tools/quote/index.ts';
import { candidate, context, fixture, productOf } from '../tools-quote/kit.ts';

function button(product: Record<string, unknown>) {
  return {
    rebate_basis: product['rebate_basis'],
    coupon_fen: product['coupon_fen'],
    cta: product['cta'],
  };
}

it('[AC-B1-05zg#11] BR-TEXT-12：查返利 normal 单值卡有券、无券的购买按钮都是 btn.buy.rebate', async () => {
  const f = fixture();
  const withCoupon = await createLinkQuoteRunner(f.deps).run(candidate, context());
  expect(withCoupon.kind).toBe('ok');
  f.setProduct({
    ...f.current,
    item: { ...f.current.item, coupon_fen: 0n, final_price_fen: 3990n },
  });
  const plain = await createLinkQuoteRunner(f.deps).run(candidate, context());
  expect(plain.kind).toBe('ok');
  expect([button(productOf(withCoupon.cards)), button(productOf(plain.cards))]).toEqual([
    { rebate_basis: 'normal', coupon_fen: 1000, cta: { text_key: 'btn.buy.rebate' } },
    { rebate_basis: 'normal', coupon_fen: 0, cta: { text_key: 'btn.buy.rebate' } },
  ]);
});
