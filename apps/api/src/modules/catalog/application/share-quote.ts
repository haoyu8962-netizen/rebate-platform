// B1-15w: the share quote of POST /v1/shares (BR-PRICE-06: buy_type=share, shown only to the
// sharer on the share page; BR-PRICE-07 (D10-641): one amount, basis normal; BR-PRICE-08:
// rebate_max_fen = 0 is no_rebate; BR-PRICE-11: quoted_at is the union response's receipt time).
// The amounts are the process quoter's (catalog's CardRebateQuoter port: commission's real quoter
// in prod / live, the demo quoter elsewhere); nothing here estimates. The quoter is called with the
// sharer as the viewer and buy_type share, over the same union item the share link freezes, so
// est_promo, quoted_at and the link's quote snapshot come from one response.
// Also compiled by the `test` project: erasable syntax only, `import type` for types.
import type { components } from '@couli/contracts-ts';
import { fenToJsonNumber } from '@couli/money';
import type { UnionItem } from '../../union/index.ts';
import { quoteBasisFor, toPlusEight, zonedInstantMs, type QuoteBasis } from '../domain/card.ts';
import type { RebateQuote, Viewer } from '../ports.ts';
import type { CardRebateQuoter } from './card-assembler.ts';

export type ShareEstPromo = components['schemas']['ShareEstPromo'];

/** The quote context of a share (the commission quoter reads buyType 'self' | 'share'). */
export interface ShareQuoteContext {
  readonly buyType: 'share';
  readonly entrySource: string | null;
  readonly rebateBasis: QuoteBasis;
}

export interface ShareQuote {
  /** est_promo of the response, JSON integers of fen. */
  readonly estPromo: ShareEstPromo;
  /** quoted_at of the union item, +08:00 (as on cards). */
  readonly quotedAt: string;
  /** The same instant in epoch milliseconds (the copy's 取价 date). */
  readonly quotedAtMs: number;
}

/** BR-PRICE-07 来源判定表: the entry_source of a share link. */
export const SHARE_ENTRY_SOURCE = 'share';

type ShareQuoteFn = (
  item: UnionItem,
  viewer: Viewer,
  context: ShareQuoteContext,
) => Promise<RebateQuote>;

function invalidQuote(reason: string): never {
  throw new TypeError(`share quote: rebate quote rejected (${reason})`);
}

/**
 * The quoter's answer checked for shape (both bounds, 0 ≤ min ≤ max) and BR-PRICE-08 applied:
 * rebate_max_fen = 0 is no_rebate with 0 / 0. Any other basis must be the requested one, and a
 * normal quote has min = max (D10-641: no range before an order).
 */
export function settleShareQuote(quote: RebateQuote, expected: QuoteBasis): ShareEstPromo {
  const { rebateMinFen: min, rebateMaxFen: max } = quote;
  if (min === null || max === null) invalidQuote('a share quote needs both rebate bounds');
  if (min < 0n || min > max) invalidQuote('bounds out of order');
  if (max === 0n) return { rebate_min_fen: 0, rebate_max_fen: 0, rebate_basis: 'no_rebate' };
  if (quote.rebateBasis !== expected) invalidQuote('basis differs from the requested one');
  if (expected === 'normal' && min !== max) invalidQuote('a normal quote has min = max');
  return {
    rebate_min_fen: fenToJsonNumber(min),
    rebate_max_fen: fenToJsonNumber(max),
    rebate_basis: expected,
  };
}

/**
 * One buy_type=share quote of the item for the viewer (the sharer). Rejects when the quoter
 * rejects or answers out of shape; the caller decides the answer (no price can be confirmed).
 */
export async function quoteShare(
  quoter: CardRebateQuoter,
  item: UnionItem,
  viewer: Viewer,
): Promise<ShareQuote> {
  const quotedAtMs = zonedInstantMs(item.quoted_at);
  const basis = quoteBasisFor();
  const context: ShareQuoteContext = {
    buyType: 'share',
    entrySource: SHARE_ENTRY_SOURCE,
    rebateBasis: basis,
  };
  // CardQuoteContext names buyType 'self' only; the port's quoters read 'share' as well.
  const quote = quoter.quote.bind(quoter) as unknown as ShareQuoteFn;
  const estPromo = settleShareQuote(await quote(item, viewer, context), basis);
  return { estPromo, quotedAt: toPlusEight(quotedAtMs), quotedAtMs };
}
