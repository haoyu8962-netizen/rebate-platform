// B1-05zg rule-test kit (D10-664 S-08; 08 BR-TEXT-12 细则「购买按钮」2026-11-05 v3). The server
// sends the buy button as cta.text_key and the client never decides it: rebate_basis = normal
// with one amount → btn.buy.rebate (with or without a coupon), amount_unknown →
// btn.buy.rebate_unknown, login_required → rebate_login_to_view, no_rebate → btn.buy.no_rebate;
// btn.buy.coupon and btn.buy.rebate_suffix are kept in the dictionary but no longer sent.
// The entries are driven through the existing rule-test kits (read only, not changed here).
import { vi } from 'vitest';
import {
  createFavoriteCardPort,
  favoriteCardView,
  type FavoriteCardPortOptions,
} from '../../../../apps/api/src/modules/catalog/index.ts';
import { fixture as detailFixture, PRODUCT_KEY, productRef, RAW_ID } from '../detail/kit.ts';
import type { ParityQuoter } from '../entry-quote-parity/kit.ts';

/** Kept in the dictionary since 2026-11-05 but never sent on a card. */
export const RETIRED_KEYS: readonly string[] = ['btn.buy.coupon', 'btn.buy.rebate_suffix'];

/** The fields that decide and show the buy button of a card (any card shape). */
export function button(card: object) {
  const fields = card as Record<string, unknown>;
  return {
    rebate_basis: fields['rebate_basis'],
    coupon_fen: fields['coupon_fen'],
    cta: fields['cta'],
  };
}

/**
 * A favorite's card (GET /v1/me/favorites; catalog/favorites/card-port.ts over getProduct in
 * retrieval mode), on the detail kit's ports with the given quoter. The stored product_refs row
 * carries the same raw ID the detail fake answers, so the card is priced, not invalid.
 */
export async function viaFavorites(q: ParityQuoter) {
  const d = detailFixture();
  d.readProductRef.mockResolvedValue(productRef({ rawItemId: RAW_ID }));
  const { viewerContext, cards, ...detail } = d.options;
  void viewerContext;
  void cards;
  const options: FavoriteCardPortOptions = {
    ...detail,
    quoter: q.quoter,
    registrar: { register: d.register },
    sourceLinks: { entrySource: d.entrySource },
    logger: { warn: vi.fn() },
    products: {
      read: async () => ({ title: '合成详情商品', image: null, shopName: null, shopType: null }),
    },
  };
  const viewer = await d.current();
  const outcome = await createFavoriteCardPort(options).fetch({
    viewer,
    platform: 'taobao',
    productKey: PRODUCT_KEY,
  });
  return { view: favoriteCardView(outcome), register: d.register };
}
