// Pure card rules (no I/O, no clock reads). Amounts are integer fen (bigint); arithmetic, when
// any, goes through @couli/money. Rules: BR-PRICE-07 (one basis, D10-641), BR-PRICE-17
// (disclaimer_keys order), BR-PRICE-21 (cta by state), BR-PRICE-11 (quoted_at / age_sec).
import type { Platform } from '../../union/index.ts';

/**
 * Rebate basis a priced card can carry before the zero-cap check (BR-PRICE-07 / 08). The contract
 * keeps price_compare_risk for compatibility, but since D10-641 no pre-order quote produces it.
 */
export type QuoteBasis = 'normal' | 'price_compare_risk';

/**
 * BR-PRICE-07 / BR-CALC-16 (D10-641): before an order every card quotes one amount from the union
 * commission field — normal on every platform and from every entry source (search, parse,
 * feed, pool, detail, rank, agent, share, a watch, null or an unrecognised name alike). The
 * entry source is still recorded on the link; it no longer decides the basis, so nothing is
 * passed in.
 */
export function quoteBasisFor(): 'normal' {
  return 'normal';
}

export type CardBasis = QuoteBasis | 'no_rebate';

/**
 * BR-PRICE-17 / BR-PRICE-03: the price-basis key goes first — price_basis when the card shows a
 * coupon price (coupon_fen > 0), price_basis.general when it only shows the selling price; then
 * rebate_estimate for any card with a rebate (D10-641: rebate_compare is no longer issued);
 * no_rebate adds no rebate key.
 */
export function disclaimerKeysFor(basis: CardBasis, couponFen: bigint): string[] {
  const priceKey = couponFen > 0n ? 'price_basis' : 'price_basis.general';
  if (basis === 'no_rebate') return [priceKey];
  return [priceKey, 'rebate_estimate'];
}

/** Every rebate_basis a delivered card can end up with (contract ProductCard.rebate_basis). */
export type CtaBasis = CardBasis | 'amount_unknown' | 'login_required';

/**
 * BR-TEXT-12 购买按钮 (2026-11-05 v3): the server sends the button key and it depends on the final
 * rebate_basis only — never on the coupon (有券无券同一句). price_compare_risk is no longer
 * produced but keeps the single-amount button; btn.buy.coupon / btn.buy.rebate_suffix are retired.
 */
export function ctaKeyFor(basis: CtaBasis): string {
  switch (basis) {
    case 'normal':
    case 'price_compare_risk':
      return 'btn.buy.rebate';
    case 'amount_unknown':
      return 'btn.buy.rebate_unknown';
    case 'login_required':
      return 'rebate_login_to_view';
    case 'no_rebate':
      return 'btn.buy.no_rebate';
  }
}

/** Server-generated labels (contract ProductCard.benefit_tags); 有券 only when coupon_fen > 0. */
export function benefitTagsFor(couponFen: bigint): string[] {
  return couponFen > 0n ? ['有券'] : [];
}

export type UnionSource = 'taobao_union' | 'jd_union' | 'pdd_union';

/** BR-PRICE-16 price source; only the three union platforms have priced cards. */
export function unionSourceFor(platform: Platform): UnionSource {
  if (platform === 'taobao' || platform === 'jd' || platform === 'pdd') return `${platform}_union`;
  throw new TypeError('card: no union price source for this platform');
}

/** ISO 8601 instant with an explicit offset (Z or ±hh:mm); a local time without zone is refused. */
const ZONED_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;

const PLUS_EIGHT = new Intl.DateTimeFormat('en', {
  timeZone: '+08:00',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/** Epoch milliseconds of a zoned ISO instant, or a TypeError (BR-PRICE-11 only accepts zoned). */
export function zonedInstantMs(value: string): number {
  const ms = ZONED_INSTANT.test(value) ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(ms)) {
    throw new TypeError('card: quoted_at must be an ISO 8601 instant with an explicit offset');
  }
  return ms;
}

/**
 * BR-PRICE-11: quoted_at is shown in +08:00. The instant itself is never changed: the same
 * moment, re-expressed with the +08:00 offset; milliseconds appear only when non-zero.
 */
export function toPlusEight(epochMs: number): string {
  const parts = PLUS_EIGHT.formatToParts(epochMs);
  const part = (type: Intl.DateTimeFormatPartTypes, width: number): string =>
    parts.find((p) => p.type === type)!.value.padStart(width, '0');
  const millis = ((epochMs % 1000) + 1000) % 1000;
  const fraction = millis === 0 ? '' : `.${String(millis).padStart(3, '0')}`;
  return (
    `${part('year', 4)}-${part('month', 2)}-${part('day', 2)}` +
    `T${part('hour', 2)}:${part('minute', 2)}:${part('second', 2)}${fraction}+08:00`
  );
}

/** BR-PRICE-11 age_sec: whole seconds from quoted_at to the response instant, never negative. */
export function ageSeconds(quotedAtMs: number, responseMs: number): number {
  const elapsed = responseMs - quotedAtMs;
  return elapsed <= 0 ? 0 : Math.floor(elapsed / 1000);
}
