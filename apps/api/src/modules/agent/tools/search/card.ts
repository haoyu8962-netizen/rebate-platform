// B3-04b · BR-AI-04 / BR-AI-11: turns catalog's priced card into the Agent stream's product_card
// (contracts/agent-stream.schema.json $defs.product_card). Every field is present; a card missing
// required data is refused here (null), never patched with 0, a cache or a model value.
import { ctaKeyFor, type ProductCard, type UnlinkedCard } from '../../../catalog/index.ts';

type Tlj = NonNullable<ProductCard['tlj']>;

/** The Agent product card: ProductCard narrowed to the stream contract, no card_id yet. */
export interface AgentProductCard {
  readonly product_key: string;
  readonly item_ref: string | null;
  readonly platform: ProductCard['platform'];
  readonly shop_type: string | null;
  readonly title: string | null;
  readonly image: string | null;
  readonly shop_name: string | null;
  readonly price_fen: number;
  readonly coupon_fen: number;
  readonly final_price_fen: number;
  readonly est_net_price_fen: number | null;
  readonly rebate_min_fen: number | null;
  readonly rebate_max_fen: number | null;
  readonly rebate_basis: 'normal' | 'price_compare_risk' | 'amount_unknown' | 'login_required';
  readonly benefit_tags: readonly string[];
  readonly match_tag: 'matched' | 'relaxed' | 'spec_unconfirmed';
  readonly spec_text: string | null;
  /** BR-PROD-04: copied from the catalog card; absent there is null (agent-stream CT-26v). */
  readonly price_spec_hint?: ProductCard['price_spec_hint'] | null;
  readonly is_presale: boolean;
  readonly tlj: Tlj | null;
  readonly link_id: string;
  readonly cta: ProductCard['cta'];
  readonly quoted_at: string;
  readonly stale: boolean;
  readonly age_sec: number;
  readonly source: ProductCard['source'];
  readonly disclaimer_keys: readonly string[];
  readonly ad_label: string | null;
  readonly availability: ProductCard['availability'];
}

/** A validated card before its link is registered. */
export type AgentUnlinkedCard = Omit<AgentProductCard, 'link_id'>;

export interface NormalizeOptions {
  readonly productKey: string;
  readonly nowMs: number;
  readonly maxAgeSec: number;
  /** BR-AI-11: guest viewer on a platform whose agent.guest_login_to_view switch is on. */
  readonly loginToView: boolean;
}

function fen(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function nullableFen(value: unknown): number | null | undefined {
  if (value === null) return null;
  return fen(value) ? value : undefined;
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** A catalog price_spec_hint value; anything else (absent included) is null, never invented. */
function priceSpecHintOf(value: unknown): 'price_from' | 'spec_uncertain' | null {
  return value === 'price_from' || value === 'spec_uncertain' ? value : null;
}

/**
 * BR-AI-04: required fields (prices, rebate_basis, availability, quoted_at, source) are never null;
 * no_rebate is filtered here; quoted_at stays the upstream fetch time and age_sec is recomputed on
 * the injected clock against the search cache age cap. BR-AI-11: with the guest login_to_view switch
 * the raw rebate is kept for sorting; maskLoginToView hides it once the cards are chosen.
 */
export function normalizeCard(
  card: UnlinkedCard,
  options: NormalizeOptions,
): AgentUnlinkedCard | null {
  const raw = card as Readonly<Record<string, unknown>>;
  if (card.product_key !== options.productKey) return null;
  const { price_fen, coupon_fen, final_price_fen } = card;
  if (!fen(price_fen) || !fen(coupon_fen) || !fen(final_price_fen)) return null;
  if (typeof card.quoted_at !== 'string' || typeof card.source !== 'string') return null;
  if (typeof card.availability !== 'string' || typeof card.rebate_basis !== 'string') return null;

  const quotedMs = Date.parse(card.quoted_at);
  if (!Number.isFinite(quotedMs)) return null;
  const ageSec = Math.max(0, Math.floor((options.nowMs - quotedMs) / 1000));
  if (ageSec > options.maxAgeSec) return null;

  let basis: AgentProductCard['rebate_basis'];
  let rebateMin: number | null;
  let rebateMax: number | null;
  let estNet = nullableFen(card.est_net_price_fen);
  if (estNet === undefined) return null;
  if (card.rebate_basis === 'no_rebate') return null;
  if (options.loginToView) {
    // Raw rebate stays for sorting (rebate_desc); maskLoginToView hides it after selection.
    // Bounds the quote could not give are null here (sorted last), never a reason to drop.
    const known =
      (card.rebate_basis === 'normal' || card.rebate_basis === 'price_compare_risk') &&
      fen(card.rebate_min_fen) &&
      fen(card.rebate_max_fen);
    basis = known ? (card.rebate_basis as 'normal' | 'price_compare_risk') : 'login_required';
    rebateMin = known ? card.rebate_min_fen : null;
    rebateMax = known ? card.rebate_max_fen : null;
  } else if (card.rebate_basis === 'login_required') {
    basis = 'login_required';
    rebateMin = null;
    rebateMax = null;
    // The net price would reveal the hidden rebate.
    estNet = null;
  } else if (card.rebate_basis === 'amount_unknown') {
    if (card.rebate_min_fen !== null || card.rebate_max_fen !== null) return null;
    basis = 'amount_unknown';
    rebateMin = null;
    rebateMax = null;
  } else if (card.rebate_basis === 'normal' || card.rebate_basis === 'price_compare_risk') {
    if (!fen(card.rebate_min_fen) || !fen(card.rebate_max_fen)) return null;
    basis = card.rebate_basis;
    rebateMin = card.rebate_min_fen;
    rebateMax = card.rebate_max_fen;
  } else {
    return null;
  }

  const tlj = (raw['tlj'] ?? null) as Tlj | null;
  const benefitTags = Array.isArray(card.benefit_tags) ? [...card.benefit_tags] : [];
  const ctaKey = typeof card.cta?.text_key === 'string' ? card.cta.text_key : '';
  if (tlj === null && (benefitTags.includes('taolijin') || ctaKey.startsWith('claim_tlj'))) {
    return null;
  }
  const disclaimers = Array.isArray(card.disclaimer_keys) ? [...card.disclaimer_keys] : [];
  if (disclaimers.length === 0) return null;
  const match = raw['match_tag'];

  return {
    product_key: options.productKey,
    item_ref: textOrNull(card.item_ref),
    platform: card.platform,
    shop_type: textOrNull(raw['shop_type']),
    title: textOrNull(card.title),
    image: textOrNull(card.image),
    shop_name: textOrNull(raw['shop_name']),
    price_fen,
    coupon_fen,
    final_price_fen,
    est_net_price_fen: estNet,
    rebate_min_fen: rebateMin,
    rebate_max_fen: rebateMax,
    rebate_basis: basis,
    benefit_tags: benefitTags,
    // B3-04d decides match_tag / spec_text; until then the catalog value or the plain default.
    match_tag: match === 'relaxed' || match === 'spec_unconfirmed' ? match : 'matched',
    spec_text: textOrNull(raw['spec_text']),
    // B1-05zh (BR-PROD-04): the catalog decision, unchanged and independent of match_tag.
    price_spec_hint: priceSpecHintOf(raw['price_spec_hint']),
    is_presale: card.is_presale === true,
    tlj,
    // BR-TEXT-12: the buy button follows the final basis here (login_to_view masking re-keys it).
    cta: { text_key: ctaKeyFor(basis) },
    quoted_at: card.quoted_at,
    stale: card.stale === true,
    age_sec: ageSec,
    source: card.source,
    disclaimer_keys: disclaimers,
    // BR-TEXT-17: Agent search cards are natural results, never a promoted slot.
    ad_label: null,
    availability: card.availability,
  };
}

/**
 * BR-AI-11: applied to a selected guest card after sorting, never before. The card becomes
 * login_required without rebate amounts, and without the net price that would reveal them; its
 * buy button becomes the login_required one (BR-TEXT-12).
 */
export function maskLoginToView<T extends AgentUnlinkedCard>(card: T): T {
  return {
    ...card,
    rebate_basis: 'login_required',
    rebate_min_fen: null,
    rebate_max_fen: null,
    est_net_price_fen: null,
    // BR-TEXT-12: the button follows the masked basis.
    cta: { text_key: ctaKeyFor('login_required') },
  };
}
