// B3-04c · BR-AI-04 / BR-AI-01 / BR-AI-05: get_rebate_quote (model tool), the deterministic
// resolve_link runner (parse_input URL → parsing → quote card) and register_links (one link row
// with the quote snapshot, never a conversion: TRADE-03). resolve_link and register_links are not
// model tools; only get_rebate_quote is a ToolHandler. Identity comes only from ToolCallContext.
import {
  ctaKeyFor,
  type CatalogCardEntry,
  type CatalogCardInput,
  type ProductCard,
} from '../../../catalog/index.ts';
import {
  ParsingError,
  type Candidate,
  type ParsedUrlProduct,
  type ParsingErrorCode,
  UNRECOGNIZED,
} from '../../../parsing/index.ts';
import type { CallCtx } from '../../../union/index.ts';
import { wrapUntrusted } from '../../guard/index.ts';
import type { ToolOutcome } from '../../orchestrator/index.ts';
import type { UnnumberedCard } from '../../stream/run/index.ts';
import type { ToolCallContext, ToolDefinition, ToolHandler } from '../registry/index.ts';

/** Server-side lookup only: earlier turns are eligible; ordinals use the latest product list. */
export type QuoteReference = { readonly card_id: string } | { readonly ref_ordinal: number };

export type QuoteReferenceResult =
  | { readonly kind: 'product'; readonly productKey: string }
  | { readonly kind: 'invalid_args' }
  | { readonly kind: 'clarify' };

/** Official token parsing boundary; failures reject with ParsingError. No third-party fallback. */
export interface TokenParser {
  parseToken(raw: string, context: CallCtx): Promise<ParsedUrlProduct>;
}

export interface RebateQuoteDeps {
  /** Absent means token parsing is unavailable (30132); supplied by the composition root. */
  readonly tokens?: TokenParser;
  /** Bound parsing.parseUrl (its ParsingOptions are supplied by the composition root). */
  readonly parsing: {
    parseUrl(url: string, context: CallCtx): Promise<ParsedUrlProduct>;
  };
  readonly catalog: {
    /** Fresh catalog lookup; never a model-supplied or previously displayed price snapshot. */
    readProduct(productKey: string, context: ToolCallContext): Promise<ParsedUrlProduct>;
    /** Request-scoped viewer and registrar. Use active_query and deferLink before filtering. */
    cards(context: ToolCallContext): CatalogCardEntry;
  };
  readonly references: {
    resolve(reference: QuoteReference, context: ToolCallContext): Promise<QuoteReferenceResult>;
  };
  /**
   * B3-05i: the core's cardReference (orchestrator/core/card-references.ts), injected by the
   * composition root. index addresses this call's ToolOutcome.cards; the core replaces the whole
   * string value with the delivered frame's card_id. Called only when a card goes out. Optional
   * so callers without a numbering owner (the deterministic runner) still work; without it the
   * model view carries no card_id and the card cannot be referenced later.
   */
  readonly cardReference?: (context: ToolCallContext, index: number) => string;
}

/** Internal outcomes for B3-05e, not new public error codes or fabricated wire cards. */
export type LinkQuoteOutcome =
  | Extract<ToolOutcome, { readonly kind: 'ok' }>
  | {
      readonly kind: 'parse_error';
      readonly error_code: ParsingErrorCode;
      readonly cards: readonly [];
    }
  | { readonly kind: 'price_unavailable'; readonly cards: readonly [] }
  | { readonly kind: 'no_card'; readonly cards: readonly [] };

export interface LinkQuoteRunner {
  /** Internal URL/token runner; deterministic token wiring is a separate task. */
  run(candidate: Candidate, context: ToolCallContext): Promise<LinkQuoteOutcome>;
}

type QuoteResult =
  | Extract<ToolOutcome, { readonly kind: 'ok' }>
  | { readonly kind: 'price_unavailable' }
  | { readonly kind: 'no_card' };

type AgentBasis = 'normal' | 'price_compare_risk' | 'amount_unknown' | 'login_required';

function toolName(): 'get_rebate_quote' {
  return 'get_rebate_quote';
}

/** Purpose of the request is an active query; the inherited link entry_source is agent. */
function entrySource(): string {
  return 'agent';
}

/** Card frame fallback (04 §8.3 sample wording): no numbers, no link, no title. */
function fallbackText(): string {
  return '已查到该商品的返利，请在商品页查看。';
}

/** BR-AI-10: every Agent product card carries the commission disclosure key. */
function commissionDisclosureKey(): string {
  return 'agent.disclaimer.commission';
}

/** 04 §8.3 card_id pattern (c1, c2…); the lookup itself stays server-side (references port). */
function isCardId(value: unknown): value is string {
  return typeof value === 'string' && /^c[1-9][0-9]{0,15}$/u.test(value);
}

/**
 * BR-PROD-02 format step only: `<key_prefix>:<stable_id>`, prefix 2–3 lower-case letters,
 * stable_id 1–124 printable ASCII without `#`, `/`, `?`. Prefix registration, aliases and the
 * platform switch are checked by the catalog lookup that follows.
 */
function isProductKeyFormat(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[a-z]{2,3}:[\x21\x22\x24-\x2E\x30-\x3E\x40-\x7E]{1,124}$/u.test(value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function rejected(): ToolOutcome {
  return { kind: 'rejected', modelView: { error: 'invalid_args' } };
}

/** Generic failure view: no message, amount or stack reaches the model. */
function failed(error: 'tool_failed' | 'price_unavailable' | 'no_card'): ToolOutcome {
  return { kind: 'failed', modelView: { error } };
}

/** Closed schema for the registry (BR-AI-03): exactly one of the three reference forms. */
function definition(): ToolDefinition {
  return {
    name: toolName(),
    description:
      '查询一个商品的返利。只能用本会话出现过的 card_id、最近商品列表的序号 ref_ordinal，' +
      '或情境入口给出的 product_key（原样，不得修改）三者之一；不要编造链接或商品 ID。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      minProperties: 1,
      maxProperties: 1,
      properties: {
        card_id: { type: 'string', pattern: '^c[1-9][0-9]{0,15}$' },
        ref_ordinal: { type: 'integer', minimum: 1 },
        product_key: { type: 'string', minLength: 3, maxLength: 128 },
      },
    },
  };
}

type ParsedArgs =
  | { readonly kind: 'reference'; readonly reference: QuoteReference }
  | { readonly kind: 'context'; readonly productKey: string }
  | { readonly kind: 'invalid' };

/**
 * BR-AI-05: one reference per call. A product_key is accepted only when it is byte-equal to the
 * server-side scenario entry and both are well formed; any extra or model-invented field rejects.
 */
function parseArgs(args: unknown, ctx: ToolCallContext): ParsedArgs {
  if (!isRecord(args)) return { kind: 'invalid' };
  const keys = Object.keys(args);
  if (keys.length !== 1) return { kind: 'invalid' };
  const key = keys[0];
  const value = args[key as string];
  if (key === 'card_id') {
    return isCardId(value)
      ? { kind: 'reference', reference: { card_id: value } }
      : { kind: 'invalid' };
  }
  if (key === 'ref_ordinal') {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
      ? { kind: 'reference', reference: { ref_ordinal: value } }
      : { kind: 'invalid' };
  }
  if (key === 'product_key') {
    const trusted = ctx.context?.['product_key'];
    if (!isProductKeyFormat(trusted) || !isProductKeyFormat(value) || value !== trusted) {
      return { kind: 'invalid' };
    }
    return { kind: 'context', productKey: trusted };
  }
  return { kind: 'invalid' };
}

function isAgentBasis(value: unknown): value is AgentBasis {
  return (
    value === 'normal' ||
    value === 'price_compare_risk' ||
    value === 'amount_unknown' ||
    value === 'login_required'
  );
}

function isFen(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * BR-AI-04 required fields: prices, rebate_basis, availability, quoted_at and source are never
 * null; no_rebate is filtered here (no card); the rebate bounds are required except for
 * amount_unknown / login_required, where null stays unknown and is never turned into 0.
 */
function isDeliverable(card: Readonly<Record<string, unknown>>): boolean {
  const basis = card['rebate_basis'];
  if (!isAgentBasis(basis)) return false;
  if (!isText(card['product_key'])) return false;
  if (!isFen(card['price_fen']) || !isFen(card['coupon_fen']) || !isFen(card['final_price_fen'])) {
    return false;
  }
  if (basis === 'normal' || basis === 'price_compare_risk') {
    if (!isFen(card['rebate_min_fen']) || !isFen(card['rebate_max_fen'])) return false;
  }
  return isText(card['availability']) && isText(card['quoted_at']) && isText(card['source']);
}

/** Unnumbered Agent product_card (04 §8.3): card_id is assigned later by stream/run. */
function agentProduct(card: ProductCard): Record<string, unknown> {
  const disclaimers = [...card.disclaimer_keys];
  if (!disclaimers.includes(commissionDisclosureKey())) disclaimers.push(commissionDisclosureKey());
  return {
    product_key: card.product_key,
    item_ref: card.item_ref,
    platform: card.platform,
    shop_type: card.shop_type ?? null,
    title: card.title,
    image: card.image,
    shop_name: card.shop_name ?? null,
    price_fen: card.price_fen,
    coupon_fen: card.coupon_fen,
    final_price_fen: card.final_price_fen,
    est_net_price_fen: card.est_net_price_fen,
    rebate_min_fen: card.rebate_min_fen,
    rebate_max_fen: card.rebate_max_fen,
    rebate_basis: card.rebate_basis,
    benefit_tags: [...card.benefit_tags],
    // A directly referenced product, not a relaxed search result (BR-AI-24).
    match_tag: 'matched',
    spec_text: null,
    is_presale: card.is_presale,
    // Taolijin and material lines belong to B3-07.
    tlj: null,
    link_id: card.link_id,
    // BR-TEXT-12: the buy button follows the card's final rebate_basis (same rule as catalog).
    cta: { text_key: ctaKeyFor(card.rebate_basis) },
    quoted_at: card.quoted_at,
    stale: card.stale,
    age_sec: card.age_sec,
    source: card.source,
    disclaimer_keys: disclaimers,
    // BR-AI-10 / BR-TEXT-17: null on Agent relevance cards in MVP.
    ad_label: null,
    availability: card.availability,
  };
}

/**
 * BR-AI-05: the model sees card_id (a whole-value core reference to outcome.cards[index]), the
 * title (untrusted, escaped), platform and benefit_tags only.
 */
function modelView(
  deps: RebateQuoteDeps,
  ctx: ToolCallContext,
  card: ProductCard,
  index: number,
): unknown {
  const reference = deps.cardReference;
  return {
    products: [
      {
        ...(reference === undefined ? {} : { card_id: reference(ctx, index) }),
        title: wrapUntrusted(card.title ?? ''),
        platform: card.platform,
        benefit_tags: card.benefit_tags.filter((tag) => typeof tag === 'string'),
      },
    ],
  };
}

/**
 * Shared by both entries: one fetched snapshot → one prepared card (active_query, deferred link)
 * → required-field filter → register_links (commit: one links row with the quote snapshot, no
 * conversion) → rebate_quote card. A registration failure rejects; no half card, no link_id.
 */
async function quoteProduct(
  deps: RebateQuoteDeps,
  product: ParsedUrlProduct,
  ctx: ToolCallContext,
): Promise<QuoteResult> {
  const input: CatalogCardInput = {
    scene: 'active_query',
    deferLink: true,
    item: product.item,
    ref: product.ref,
    entrySource: entrySource(),
    stale: false,
  };
  const result = await deps.catalog.cards(ctx).assemble(input);
  if (result.kind === 'price_unavailable') return { kind: 'price_unavailable' };
  if (result.kind !== 'prepared') return { kind: 'no_card' };
  if (!isDeliverable(result.card)) return { kind: 'no_card' };
  const card = await result.commit();
  if (!isDeliverable(card) || !isText(card.link_id)) return { kind: 'no_card' };
  const productKey = card.product_key as string;
  const wire: UnnumberedCard = {
    type: 'rebate_quote',
    schema_version: 1,
    data: { product: agentProduct(card), material: null, tlj_kind: 'unknown' },
    fallback_text: fallbackText(),
  };
  // The quote card is the only entry of outcome.cards: its reference index is its position there.
  const cards = [wire];
  return {
    kind: 'ok',
    modelView: modelView(deps, ctx, card, cards.indexOf(wire)),
    cards,
    trace: { link_registrations: [{ link_id: card.link_id, product_key: productKey, ok: true }] },
  };
}

/** Union call context for parsing, built from the session only (no model argument). */
function callCtx(ctx: ToolCallContext): CallCtx {
  return { appId: ctx.appId, requestId: ctx.runId, purpose: 'online', signal: ctx.signal };
}

/** Model arguments: exactly one of card_id, ref_ordinal, or the unchanged context product_key. */
export function createRebateQuoteHandler(deps: RebateQuoteDeps): ToolHandler {
  async function run(
    args: Readonly<Record<string, unknown>>,
    ctx: ToolCallContext,
  ): Promise<ToolOutcome> {
    const parsed = parseArgs(args, ctx);
    if (parsed.kind === 'invalid') return rejected();
    try {
      let productKey: string;
      if (parsed.kind === 'context') {
        productKey = parsed.productKey;
      } else {
        const resolved = await deps.references.resolve(parsed.reference, ctx);
        if (resolved.kind === 'invalid_args') return rejected();
        if (resolved.kind === 'clarify') {
          return { kind: 'ok', modelView: { error: 'clarify' }, cards: [] };
        }
        productKey = resolved.productKey;
      }
      const product = await deps.catalog.readProduct(productKey, ctx);
      const outcome = await quoteProduct(deps, product, ctx);
      if (outcome.kind === 'ok') return outcome;
      return failed(outcome.kind);
    } catch {
      // Includes a failed fresh lookup or link registration: never fall back to an earlier card.
      return failed('tool_failed');
    }
  }

  return { name: toolName(), definition: definition(), audience: 'all', run };
}

/**
 * Resolves one candidate to a single product snapshot. URL candidates go only to parseUrl, token
 * candidates only to the injected TokenParser; without that port token parsing is unavailable and
 * yields 30132 (BR-AI-04: no third-party fallback). The raw text never leaves this function except
 * as the parser argument. Non-ParsingError failures (timeouts, aborts) propagate to the caller.
 */
async function parseCandidate(
  deps: RebateQuoteDeps,
  candidate: Candidate,
  ctx: ToolCallContext,
): Promise<{ readonly kind: 'product'; readonly product: ParsedUrlProduct } | ParseFailure> {
  const tokens = deps.tokens;
  if (candidate.kind !== 'url' && tokens === undefined) {
    return { kind: 'parse_error', error_code: UNRECOGNIZED, cards: [] };
  }
  try {
    const product =
      candidate.kind === 'url' || tokens === undefined
        ? await deps.parsing.parseUrl(candidate.raw, callCtx(ctx))
        : await tokens.parseToken(candidate.raw, callCtx(ctx));
    return { kind: 'product', product };
  } catch (error) {
    if (error instanceof ParsingError) {
      return { kind: 'parse_error', error_code: error.code, cards: [] };
    }
    throw error;
  }
}

type ParseFailure = Extract<LinkQuoteOutcome, { readonly kind: 'parse_error' }>;

export function createLinkQuoteRunner(deps: RebateQuoteDeps): LinkQuoteRunner {
  return {
    async run(candidate, ctx) {
      const parsed = await parseCandidate(deps, candidate, ctx);
      if (parsed.kind === 'parse_error') return parsed;
      // Same flow as a URL: the card is built from this one parsed snapshot (BR-AI-04).
      const outcome = await quoteProduct(deps, parsed.product, ctx);
      if (outcome.kind === 'ok') return outcome;
      return { kind: outcome.kind, cards: [] };
    },
  };
}
