// B1-05zg (D10-664 S-08): 购买按钮按 08 BR-TEXT-12 细则「购买按钮」（2026-11-05 v3 改定）由服务端在
// cta.text_key 下发：rebate_basis = normal 且单一金额 → btn.buy.rebate（有券、无券同一句）；
// no_rebate → btn.buy.no_rebate（照旧）；btn.buy.coupon、btn.buy.rebate_suffix 保留不用、不再下发；
// benefit_tags 不变（有券才带「有券」）。走真实 createCardAssembler（test/spec/catalog/card/kit.ts，只读）。
import { propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import { fixture, item, quote, ref, request } from '../card/kit.ts';
import { button, RETIRED_KEYS } from './kit.ts';

/** The kit's taobao item without a coupon: price = final (BR-PRICE-01 holds). */
function plainItem() {
  return item({ coupon_fen: 0n, final_price_fen: 12000n });
}

it('[AC-B1-05zg#1] BR-TEXT-12：normal 单值卡有券、无券同为 btn.buy.rebate，no_rebate 仍为 btn.buy.no_rebate，有券标签不变', async () => {
  const f = fixture();
  const normalCoupon = await f.service.assemble(request());
  const normalPlain = await f.service.assemble(request({ item: plainItem() }));
  f.quoted.mockResolvedValue(quote({ rebateMinFen: 0n, rebateMaxFen: 0n, estNetPriceFen: null }));
  const noneCoupon = await f.service.assemble(request());
  const nonePlain = await f.service.assemble(request({ item: plainItem() }));
  expect(
    [normalCoupon, normalPlain, noneCoupon, nonePlain].map((card) => ({
      ...button(card),
      benefit_tags: card.benefit_tags,
    })),
  ).toEqual([
    {
      rebate_basis: 'normal',
      coupon_fen: 2000,
      cta: { text_key: 'btn.buy.rebate' },
      benefit_tags: ['有券'],
    },
    {
      rebate_basis: 'normal',
      coupon_fen: 0,
      cta: { text_key: 'btn.buy.rebate' },
      benefit_tags: [],
    },
    {
      rebate_basis: 'no_rebate',
      coupon_fen: 2000,
      cta: { text_key: 'btn.buy.no_rebate' },
      benefit_tags: ['有券'],
    },
    {
      rebate_basis: 'no_rebate',
      coupon_fen: 0,
      cta: { text_key: 'btn.buy.no_rebate' },
      benefit_tags: [],
    },
  ]);
});

const ENTRY_SOURCES = [
  'search',
  'feed',
  'pool',
  'parse',
  'detail',
  'rank',
  'agent',
  'rebate_quote',
  'tlj_pool',
  null,
] as const;

it('[AC-B1-05zg#2] 属性 BR-TEXT-12：任意平台、来源、券额与返利额，按钮只看返利状态（有返利 btn.buy.rebate，归零 btn.buy.no_rebate），从不下发 btn.buy.coupon / btn.buy.rebate_suffix', async () => {
  let checked = 0;
  await fc.assert(
    fc.asyncProperty(
      fc.constantFrom('taobao', 'jd', 'pdd'),
      fc.constantFrom(...ENTRY_SOURCES),
      fc.bigInt({ min: 1n, max: 100_000_000n }),
      fc.bigInt({ min: 0n, max: 100_000_000n }),
      fc.bigInt({ min: 0n, max: 100_000_000n }),
      async (platform, entrySource, price, couponPick, rebatePick) => {
        const coupon = couponPick % price;
        const final = price - coupon;
        const rebate = rebatePick % (final + 1n);
        const f = fixture();
        f.quoted.mockResolvedValue(
          rebate === 0n
            ? quote({ rebateMinFen: 0n, rebateMaxFen: 0n, estNetPriceFen: null })
            : quote({ rebateMinFen: rebate, rebateMaxFen: rebate, estNetPriceFen: final - rebate }),
        );
        const card = await f.service.assemble(
          request({
            item: item({ platform, price_fen: price, coupon_fen: coupon, final_price_fen: final }),
            ref: ref({ platform, productKey: `${platform}:synthetic` }),
            entrySource,
          }),
        );
        expect(button(card)).toEqual({
          rebate_basis: rebate === 0n ? 'no_rebate' : 'normal',
          coupon_fen: Number(coupon),
          cta: { text_key: rebate === 0n ? 'btn.buy.no_rebate' : 'btn.buy.rebate' },
        });
        expect(RETIRED_KEYS).not.toContain(card.cta.text_key);
        expect(card.benefit_tags).toEqual(coupon > 0n ? ['有券'] : []);
        checked += 1;
        return true;
      },
    ),
    propParams(),
  );
  expect(checked).toBeGreaterThan(0);
}, 900_000);
