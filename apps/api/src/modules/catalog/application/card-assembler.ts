// B1-05f: CardAssembler (one priced ProductCard per call) and a non-production demo quoter.
// Amounts stay integer fen (bigint) until the JSON boundary; arithmetic only via @couli/money.
import type { components } from '@couli/contracts-ts';
import { applyReserve, fenToJsonNumber, mulDivFloor, subFen } from '@couli/money';
import type { Clock } from '../../platform/index.ts';
import {
  isPriceAnomaly,
  type UnionEnvironment,
  type UnionItem,
  type UnionItemDetail,
  type UnionMode,
} from '../../union/index.ts';
import {
  ageSeconds,
  benefitTagsFor,
  ctaKeyFor,
  disclaimerKeysFor,
  quoteBasisFor,
  toPlusEight,
  unionSourceFor,
  zonedInstantMs,
  type CardBasis,
  type QuoteBasis,
} from '../domain/card.ts';
import type { ProductRef } from '../domain/types.ts';
import type {
  CatalogConfigReader,
  LinkRegistrar,
  RebateQuote,
  RebateQuoter,
  SourceLinkReader,
  Viewer,
  ViewerContext,
} from '../ports.ts';
import type { ItemRefService } from './item-ref.ts';

export type ProductCard = components['schemas']['ProductCard'];

/** entry_source is opaque text in links, not a new contract enumeration. */
export interface CardQuoteContext {
  readonly buyType: 'self';
  readonly entrySource: string | null;
  readonly rebateBasis: 'normal' | 'price_compare_risk';
}

/** Optional third argument keeps the B1-05c port compatible; card calls always supply it. */
export interface CardRebateQuoter extends RebateQuoter {
  quote(item: UnionItem, viewer: Viewer, context?: CardQuoteContext): Promise<RebateQuote>;
}

export interface AssembleCardInput {
  /** B1-04zzf：搜索行可只带 UnionItem 字段；图片字段可选，缺省时卡片 image 为 null。 */
  readonly item: UnionItemDetail;
  readonly ref: ProductRef;
  readonly entrySource: string | null;
  /** Detail/derived requests read the originating link in the server's app scope. */
  readonly sourceLinkId?: string;
  readonly stale: boolean;
}

export interface CardAssemblerOptions {
  readonly clock: Clock;
  readonly viewerContext: ViewerContext;
  readonly quoter: CardRebateQuoter;
  readonly registrar: LinkRegistrar;
  readonly sourceLinks: SourceLinkReader;
  readonly itemRefs: Pick<ItemRefService, 'issue'>;
}

/** A priced card before its link registration: no link_id yet. */
export type UnlinkedCard = Omit<ProductCard, 'link_id'>;

/**
 * A priced card whose link is not registered yet. `commit` registers the link with
 * the quote snapshot and returns the deliverable card; an uncommitted card writes no links row.
 */
export interface PreparedCard {
  readonly card: UnlinkedCard;
  commit(): Promise<ProductCard>;
}

export interface CardAssembler {
  /** Only priced cards here; caller owns filtering, refill and cache eligibility. */
  assemble(input: AssembleCardInput): Promise<ProductCard>;
  /**
   * Same steps up to the link registration, which waits for `commit`: a caller that drops the
   * candidate afterwards (filtered, over the page limit, a losing duplicate) registers nothing.
   */
  prepare(input: AssembleCardInput): Promise<PreparedCard>;
}

/** Contract ItemRef maxLength: a longer token is never issued, so no card goes out without one. */
const ITEM_REF_MAX_LENGTH = 1024;

function invalidQuote(reason: string): never {
  throw new TypeError(`card: rebate quote rejected (${reason})`);
}

/**
 * BR-PRICE-01 / D33: a priced card needs a valid price state. The only predicate is union's
 * isPriceAnomaly (price_status = anomaly, or price > 0, 0 ≤ coupon < price, final > 0 and
 * final = price − coupon failing). Filtering anomalies is the caller's job; one that slips through
 * fails here rather than being shown as 0 yuan.
 */
function assertPriced(item: UnionItem): void {
  if (isPriceAnomaly(item)) {
    throw new TypeError('card: price fields violate BR-PRICE-01; caller must not assemble a card');
  }
}

/**
 * The quoter owns every amount (BR-PRICE-06 「不得另写估算逻辑」); this only checks the result's
 * shape and applies BR-PRICE-08: rebate_max_fen = 0 is no_rebate (no estimated net price), while
 * min = 0 < max stays a price_compare_risk range (BR-PRICE-07).
 */
function settleQuote(quote: RebateQuote, expected: QuoteBasis): RebateQuote {
  const { rebateMinFen: min, rebateMaxFen: max, estNetPriceFen: net } = quote;
  if (min === null || max === null) invalidQuote('a priced card needs both rebate bounds');
  if (min < 0n || min > max) invalidQuote('bounds out of order');
  if (max === 0n) {
    return { rebateMinFen: 0n, rebateMaxFen: 0n, estNetPriceFen: null, rebateBasis: 'no_rebate' };
  }
  if (quote.rebateBasis !== expected) invalidQuote('basis differs from the requested one');
  if (expected === 'normal' && min !== max) invalidQuote('a normal quote has min = max');
  if (net !== null && net < 0n) invalidQuote('negative estimated net price');
  return { rebateMinFen: min, rebateMaxFen: max, estNetPriceFen: net, rebateBasis: expected };
}

function json(fen: bigint): number {
  return fenToJsonNumber(fen);
}

function nullableJson(fen: bigint | null): number | null {
  return fen === null ? null : fenToJsonNumber(fen);
}

/**
 * Builds one priced ProductCard per call. Nothing is cached: the viewer, the entry source, the
 * quote, the link registration and the age are taken anew on every call (BR-PRICE-11).
 * Order: viewer → entry source → quote → item_ref → link registration → age at response time.
 * A failing quote, item_ref or registration rejects the call; no half-built card or invented
 * link_id ever leaves this function.
 */
export function createCardAssembler(options: CardAssemblerOptions): CardAssembler {
  const { clock, viewerContext, quoter, registrar, sourceLinks, itemRefs } = options;

  async function entrySourceOf(input: AssembleCardInput, viewer: Viewer): Promise<string | null> {
    // Detail, watch and other derived requests inherit the originating card's link record,
    // read in the server-side app scope; an unreadable or foreign link gives null (→ risk).
    if (input.sourceLinkId === undefined) return input.entrySource;
    return sourceLinks.entrySource(viewer.appId, input.sourceLinkId);
  }

  async function prepare(input: AssembleCardInput): Promise<PreparedCard> {
    const { item, ref } = input;
    assertPriced(item);
    if (item.platform !== ref.platform) {
      throw new TypeError('card: union item and product ref name different platforms');
    }
    const source = unionSourceFor(item.platform);
    const quotedAtMs = zonedInstantMs(item.quoted_at);

    const viewer = await viewerContext.current();
    if (viewer.appId !== ref.appId) {
      throw new TypeError('card: product ref belongs to another app scope');
    }
    const entrySource = await entrySourceOf(input, viewer);
    const basis = quoteBasisFor(item.platform, entrySource);
    const context: CardQuoteContext = { buyType: 'self', entrySource, rebateBasis: basis };
    const quote = settleQuote(await quoter.quote(item, viewer, context), basis);

    const itemRef = itemRefs.issue({
      appId: ref.appId,
      platform: ref.platform,
      productKey: ref.productKey,
      rawItemId: ref.rawItemId,
      fetchedAt: ref.rawFetchedAt,
    });
    if (itemRef.length === 0 || itemRef.length > ITEM_REF_MAX_LENGTH) {
      throw new TypeError('card: item_ref exceeds the contract length; card not issued');
    }

    const cardBasis = quote.rebateBasis as CardBasis;
    const card: UnlinkedCard = {
      product_key: ref.productKey,
      item_ref: itemRef,
      platform: item.platform,
      shop_type: ref.shopType,
      title: item.title,
      // B1-04zzf：只用适配器经 normalizeItemImages 清洗后的主图；不从 image_urls 补，不伪造。
      image: item.main_image_url ?? null,
      price_fen: json(item.price_fen),
      coupon_fen: json(item.coupon_fen),
      final_price_fen: json(item.final_price_fen),
      est_net_price_fen: nullableJson(quote.estNetPriceFen),
      rebate_min_fen: nullableJson(quote.rebateMinFen),
      rebate_max_fen: nullableJson(quote.rebateMaxFen),
      rebate_basis: cardBasis,
      benefit_tags: benefitTagsFor(item.coupon_fen),
      is_presale: false,
      cta: { text_key: ctaKeyFor(cardBasis, item.coupon_fen) },
      quoted_at: toPlusEight(quotedAtMs),
      stale: input.stale,
      // Response instant: read after the quote and registration (BR-PRICE-11).
      age_sec: ageSeconds(quotedAtMs, clock.now().getTime()),
      source,
      disclaimer_keys: disclaimerKeysFor(cardBasis, item.coupon_fen),
      availability: 'ok',
    };
    let committed: Promise<ProductCard> | undefined;
    const commit = (): Promise<ProductCard> => {
      // Once per prepared card: a repeated commit never registers a second link.
      committed ??= (async () => {
        const { linkId } = await registrar.register({ viewer, ref, item, quote, entrySource });
        // Response instant: read after the quote and registration (BR-PRICE-11).
        return { ...card, link_id: linkId, age_sec: ageSeconds(quotedAtMs, clock.now().getTime()) };
      })();
      return committed;
    };
    return { card, commit };
  }

  async function assemble(input: AssembleCardInput): Promise<ProductCard> {
    return (await prepare(input)).commit();
  }

  return { assemble, prepare };
}

/** Synthetic non-production rule schema; no defaults or production rule/level storage. */
export interface DemoQuoteRule {
  readonly reserve_bp: number;
  readonly self_share_bp: number;
}

export interface DemoRebateQuoterOptions {
  readonly appEnv: UnionEnvironment;
  readonly unionMode: UnionMode;
  readonly config: CatalogConfigReader;
  /** Explicit synthetic config key, value DemoQuoteRule; never a commission_rules writer. */
  readonly ruleConfigKey: string;
}

const BP = 10000n;
const TECH_FEE_KEY = 'tech_fee_bp';
const COMPARE_RATIO_KEY = 'rebate.taobao.compare_rate_ratio_bp';

function missingConfig(key: string): never {
  throw new Error(`demo quoter: config missing or malformed (${key})`);
}

/** A basis-point config value: a safe integer in 0..10000, returned as bigint. */
function bpValue(value: unknown, key: string): bigint {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 10000) {
    missingConfig(key);
  }
  return BigInt(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Demo / replay quoter for non-production environments only. The formula is BR-CALC-20 with
 * synthetic rule values; every step floors (@couli/money): gross = ⌊final × rate⌋,
 * fee = ⌊gross × tech_fee⌋, N = gross − fee, after-reserve (BR-CALC-02), self = ⌊after × share⌋.
 * The range lower bound redoes the same steps at ⌊rate × compare_rate_ratio_bp⌋ (BR-PRICE-07),
 * it does not halve the upper result. est_net_price_fen = final − rebate_min_fen (BR-PRICE-09);
 * rebate_max_fen = 0 is no_rebate without a net price (BR-PRICE-08). Configuration is read on
 * every call, in the viewer's app scope; a missing key is refused, never defaulted.
 */
export function createDemoRebateQuoter(options: DemoRebateQuoterOptions): CardRebateQuoter {
  const { appEnv, unionMode, config, ruleConfigKey } = options;
  if (appEnv === 'prod' || (unionMode !== 'demo' && unionMode !== 'replay')) {
    throw new Error(
      `demo quoter forbidden: needs a non-prod APP_ENV and union demo/replay mode (got ${appEnv}/${unionMode})`,
    );
  }

  async function read(appId: string, key: string): Promise<unknown> {
    const entry = await config.configValue(appId, key);
    if (entry === null) missingConfig(key);
    return entry.value;
  }

  async function rule(appId: string): Promise<{ reserveBp: bigint; selfShareBp: bigint }> {
    const value = await read(appId, ruleConfigKey);
    if (!isRecord(value)) missingConfig(ruleConfigKey);
    return {
      reserveBp: bpValue(value['reserve_bp'], ruleConfigKey),
      selfShareBp: bpValue(value['self_share_bp'], ruleConfigKey),
    };
  }

  async function techFee(appId: string, platform: string): Promise<bigint> {
    const value = await read(appId, TECH_FEE_KEY);
    if (!isRecord(value) || !Object.hasOwn(value, platform)) missingConfig(TECH_FEE_KEY);
    return bpValue(value[platform], TECH_FEE_KEY);
  }

  async function quote(
    item: UnionItem,
    viewer: Viewer,
    context?: CardQuoteContext,
  ): Promise<RebateQuote> {
    const basis = context?.rebateBasis ?? quoteBasisFor(item.platform, null);
    if (basis === 'price_compare_risk' && item.platform !== 'taobao') {
      throw new TypeError('demo quoter: compare range exists only on taobao (BR-PRICE-07)');
    }
    const { reserveBp, selfShareBp } = await rule(viewer.appId);
    const feeBp = await techFee(viewer.appId, item.platform);
    const final = item.final_price_fen;

    const self = (rateBp: bigint): bigint => {
      const gross = mulDivFloor(final, rateBp, BP);
      const n = subFen(gross, mulDivFloor(gross, feeBp, BP));
      return mulDivFloor(applyReserve(n, reserveBp).after_reserve_fen, selfShareBp, BP);
    };

    const max = self(item.commission_rate_bp);
    let min = max;
    if (basis === 'price_compare_risk') {
      const ratioBp = bpValue(await read(viewer.appId, COMPARE_RATIO_KEY), COMPARE_RATIO_KEY);
      min = self(mulDivFloor(item.commission_rate_bp, ratioBp, BP));
    }
    if (max === 0n) {
      return { rebateMinFen: 0n, rebateMaxFen: 0n, estNetPriceFen: null, rebateBasis: 'no_rebate' };
    }
    return {
      rebateMinFen: min,
      rebateMaxFen: max,
      estNetPriceFen: subFen(final, min),
      rebateBasis: basis,
    };
  }

  return { quote };
}
