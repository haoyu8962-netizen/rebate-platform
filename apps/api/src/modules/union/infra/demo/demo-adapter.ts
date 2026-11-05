// Demo union adapter (规划/11 §4.5 没有真实录制时): one synthetic catalog per platform and seed,
// shared shape for jd, pdd and taobao. Everything it returns is the unified domain DTO of
// domain/types.ts; it never imitates an upstream field name, signature, payload or error code,
// and its data is never AC-LINK / AC-ORD evidence. Links are https://demo.invalid/… only.
// APP_ENV=prod refuses to construct it (same rule as replay in infra/endpoints.ts).
import { createHash } from 'node:crypto';
import { addFen, mulDivFloor, splitByBp, subFen } from '@couli/money';
import { GovernanceError, type Clock } from '../../../platform/index.ts';
import {
  isRegisteredPlatform,
  isServerIdentity,
  UnionError,
  type BindReq,
  type BindResult,
  type CallCtx,
  type ChannelCategoriesReq,
  type ChannelRankingCategory,
  type ChannelRankingPage,
  type ChannelRankingReq,
  type ConvertReq,
  type ConvertResult,
  type IdentityClaims,
  type ItemRef,
  type MaterialReq,
  type OrderQueryOpt,
  type Page,
  type PddAuthority,
  type PddAuthorityUrl,
  type RegisteredPlatform,
  type ResolvedLink,
  type SearchQuery,
  type TimeWindow,
  type UnionAdapter,
  type UnionEndpoint,
  type UnionEnvironment,
  type UnionIdentity,
  type UnionItem,
  type UnionItemDetail,
  type UnionOrder,
} from '../../domain/types.ts';
import {
  mapTaobaoPrice,
  type TaobaoPriceOptions,
  type TaobaoPriceSettingsReader,
  type TaobaoPriceWarning,
  type TaobaoPromotion,
} from '../../domain/taobao-price.ts';
import { normalizeItemImages, type ItemImages } from '../../domain/item-images.ts';

/** Internal demo scenarios in CallCtx.scenario; never vendor response codes or payloads.
 * timeout -> Error.code=timeout; rate_limit -> Error.code=quota_exceeded (both GovernanceError);
 * delisted -> Error.code=demo_delisted for detail/resolve/convert, empty search/feed;
 * coupon_expired -> coupon_fen=0, final_price_fen=price_fen;
 * no_commission -> commission_rate_bp=0. Scenarios affect only the current call.
 * Taobao prices go through mapTaobaoPrice (BR-PRICE-02, D33): coupon_expired removes the coupon
 * items from the synthetic promotion detail; price_anomaly makes the detail disagree with the
 * promotion final price by one fen (calc_diff); unknown_promo adds an unlisted promotion name
 * (unknown_promo under the default switch). These two are Taobao-only scenarios.
 * pdd_unauthorized (Pinduoduo only, B1-06v) -> queryPddAuthority answers authorized=false; without
 * it the demo authority query answers authorized=true (orchestrator ruling D7-7: no demo dead loop).
 */
export type DemoScenario =
  | 'timeout'
  | 'rate_limit'
  | 'delisted'
  | 'coupon_expired'
  | 'no_commission'
  | 'price_anomaly'
  | 'unknown_promo'
  | 'pdd_unauthorized';

const SCENARIOS: readonly DemoScenario[] = [
  'timeout',
  'rate_limit',
  'delisted',
  'coupon_expired',
  'no_commission',
  'price_anomaly',
  'unknown_promo',
  'pdd_unauthorized',
];
const TAOBAO_ONLY_SCENARIOS: readonly DemoScenario[] = ['price_anomaly', 'unknown_promo'];
/** B1-06v: the authority query answers "not filed" (only queryPddAuthority reads it). */
const PDD_ONLY_SCENARIOS: readonly DemoScenario[] = ['pdd_unauthorized'];

export interface DemoUnionOptions {
  readonly platform: RegisteredPlatform;
  readonly seed: string;
  readonly clock: Clock;
  /** Supplied by validated application config; prod must reject before serving data. */
  readonly environment: UnionEnvironment;
  /** Receives PRICE_CALC_DIFF / PRICE_PROMO_UNKNOWN events (name only, no item data). */
  readonly warn?: (warning: TaobaoPriceWarning) => void;
  /**
   * B1-22q: Taobao price settings, read with ctx.appId for every price mapping and passed to
   * mapTaobaoPrice as its options. Without it the BR-PRICE-02 defaults apply.
   */
  readonly taobaoPriceSettings?: TaobaoPriceSettingsReader;
}

/** Optional argument of createUnionRegistry: endpoints with mode=demo get a DemoUnionAdapter. */
export interface DemoUnionRegistryOptions {
  readonly endpoints: readonly UnionEndpoint[];
  readonly seed: string;
  readonly clock: Clock;
  readonly environment: UnionEnvironment;
  readonly warn?: (warning: TaobaoPriceWarning) => void;
  /** B1-22q: handed to every demo adapter as DemoUnionOptions.taobaoPriceSettings. */
  readonly taobaoPriceSettings?: TaobaoPriceSettingsReader;
}

export type DemoUnionErrorCode = 'demo_delisted' | 'demo_unknown_scenario';

/** Demo-only failures; not new HTTP error codes and not any platform's error code. */
export class DemoUnionError extends Error {
  readonly code: DemoUnionErrorCode;
  readonly platform: RegisteredPlatform;

  constructor(code: DemoUnionErrorCode, message: string, platform: RegisteredPlatform) {
    super(message);
    this.name = 'DemoUnionError';
    this.code = code;
    this.platform = platform;
  }
}

const DEMO_ENVIRONMENTS: readonly UnionEnvironment[] = ['local', 'test', 'staging'];
const CATALOG_SIZE = 24;
const SEARCH_PAGE_SIZE = 10;
const FEED_PAGE_SIZE = 8;
const DEMO_HOST = 'demo.invalid';
const BP = 10_000n;
/** Synthetic prices are PRICE_CEILING_FEN scaled by a seeded ratio of 200–10 000 bp (998–49 900 fen). */
const PRICE_CEILING_FEN = 49_900n;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** A synthetic name outside every default list; used only by the unknown_promo scenario. */
const DEMO_UNLISTED_TITLE = '演示清单外优惠';
const DETAIL_TEXT = '演示商品详情：合成数据，仅供开发联调，不对应任何平台的真实商品。';
/** B1-22p: synthetic categories every demo material channel offers (not any platform's). */
const DEMO_CHANNEL_CATEGORIES: readonly ChannelRankingCategory[] = Object.freeze(
  [
    { categoryId: 'demo-cat-1', name: '演示类目 一' },
    { categoryId: 'demo-cat-2', name: '演示类目 二' },
    { categoryId: 'demo-cat-3', name: '演示类目 三' },
  ].map((category) => Object.freeze(category)),
);
/** B1-22p: same page bound as the ranking port. */
const DEMO_RANKING_MAX_PAGE_SIZE = 50;

/** B1-22p: a synthetic sales text from a digest; one position in seven has none (null). */
function demoSalesText(hex: string): string | null {
  const n = Number.parseInt(hex.slice(0, 6), 16);
  if (n % 7 === 0) return null;
  return `演示销量 ${String(100 + (n % 9_900))}+`;
}

interface CatalogEntry {
  /** The identifier that appears in a demo link: item_id, itemId or goods_sign. */
  readonly linkId: string;
  readonly ref: ItemRef;
  readonly title: string;
  readonly price_fen: bigint;
  /** Coupon as a share of the price; amounts are derived through @couli/money only. */
  readonly coupon_bp: bigint;
  readonly commission_rate_bp: bigint;
  /** Taobao only: synthetic promotion detail (domain structure, not a platform payload). */
  readonly promotions?: readonly DemoPromotion[];
  /** B1-22s: detail-only image fields, already through normalizeItemImages. */
  readonly images: ItemImages;
}

/** B1-22s: synthetic image layouts by catalog position (raw main present, raw gallery size). */
const DEMO_IMAGE_LAYOUTS: readonly { readonly main: boolean; readonly gallery: number }[] = [
  // Position 0 (the first search result) has no images at all, so its detail keeps the search
  // fields plus description only (B1-04o DATA#5).
  { main: false, gallery: 0 },
  { main: true, gallery: 1 },
  { main: true, gallery: 3 },
  // 12 raw entries, truncated to 9 by normalizeItemImages.
  { main: true, gallery: 12 },
  // Main image only, no gallery.
  { main: true, gallery: 0 },
  { main: true, gallery: 9 },
  // Gallery without a main image.
  { main: false, gallery: 5 },
  // Gallery that repeats an entry and also lists the main image (dedup keeps the first).
  { main: true, gallery: -1 },
];

/**
 * B1-22s: deterministic synthetic images of one catalog item, unique per item (the path carries
 * the link identifier) and only under https://demo.invalid/; never a platform image address.
 */
function demoImages(platform: RegisteredPlatform, linkId: string, index: number): ItemImages {
  const layout = DEMO_IMAGE_LAYOUTS[index % DEMO_IMAGE_LAYOUTS.length]!;
  const base = `https://${DEMO_HOST}/${platform}/images/${encodeURIComponent(linkId)}`;
  const main = `${base}/main.jpg`;
  const at = (n: number): string => `${base}/${String(n)}.jpg`;
  const gallery =
    layout.gallery < 0
      ? [at(1), main, at(2), at(1), at(3)]
      : Array.from({ length: layout.gallery }, (_, n) => at(n + 1));
  return normalizeItemImages({
    ...(layout.main ? { main_image_url: main } : {}),
    image_urls: gallery,
  });
}

/** Times are offsets from the injected fetch time, so the detail never ages out. */
interface DemoPromotion {
  readonly title: string;
  readonly amount_fen: bigint;
  readonly id?: string;
  readonly start_offset_ms?: number;
  readonly end_offset_ms?: number;
}

/**
 * Taobao promotion detail built from the seeded ratios; every title is in the default lists of
 * BR-PRICE-02, so normal searches and feeds never produce an anomaly.
 */
function taobaoPromotions(
  index: number,
  hash: string,
  price: bigint,
  couponBp: bigint,
): readonly DemoPromotion[] {
  const promotions: DemoPromotion[] = [];
  if (couponBp > 0n) {
    promotions.push({
      title: index % 2 === 0 ? '商品券' : '店铺券',
      amount_fen: mulDivFloor(price, couponBp, BP),
      id: `demo-coupon-${hash.slice(0, 8)}`,
      ...(index % 4 === 1 ? { start_offset_ms: -HOUR_MS, end_offset_ms: DAY_MS } : {}),
    });
    if (index % 6 === 1) {
      promotions.push({
        title: '店铺券',
        amount_fen: mulDivFloor(price, 100n, BP),
        id: `demo-coupon-${hash.slice(8, 16)}`,
      });
    }
  }
  if (index % 4 === 2 || index % 4 === 3) {
    promotions.push({
      title: index % 4 === 2 ? '百亿补贴' : '限时优惠',
      amount_fen: mulDivFloor(price, 500n, BP),
      start_offset_ms: -HOUR_MS,
      end_offset_ms: DAY_MS,
    });
  }
  if (index % 5 === 1) {
    promotions.push({ title: '88VIP', amount_fen: mulDivFloor(price, 500n, BP) });
  }
  return Object.freeze(promotions.map((promotion) => Object.freeze(promotion)));
}

function digest(parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('\u0000'), 'utf8').digest('hex');
}

/** A seeded ratio in basis points: lowBp + (hex mod span); ratios only, never an amount. */
function seededBp(hex: string, lowBp: bigint, span: bigint): bigint {
  return lowBp + (BigInt(`0x${hex}`) % span);
}

/** `count` decimal digits taken from a hex digest, first digit 1–9. */
function digits(hex: string, count: number): string {
  const text = BigInt(`0x${hex}`).toString(10);
  const body = text.slice(-count).padStart(count, '0');
  return `${String(1 + (Number.parseInt(hex.slice(0, 2), 16) % 9))}${body.slice(1)}`;
}

function filled(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function buildCatalog(platform: RegisteredPlatform, seed: string): readonly CatalogEntry[] {
  const entries: CatalogEntry[] = [];
  for (let index = 0; index < CATALOG_SIZE; index++) {
    const hash = digest(['demo-catalog', platform, seed, String(index)]);
    const serial = String(index).padStart(3, '0');
    // Index suffix keeps stable ids unique within a catalog whatever the hash.
    const stable = `${digits(hash.slice(0, 16), 9)}${serial}`;
    let ref: ItemRef;
    let linkId: string;
    if (platform === 'taobao') {
      // BR-PROD-03 branches: with and without a "-" prefix segment.
      linkId = index % 2 === 0 ? stable : `dm${hash.slice(16, 22)}-${stable}`;
      ref = Object.freeze({ platform, item_id: linkId });
    } else if (platform === 'jd') {
      linkId = `dm${hash.slice(16, 26)}_${stable}`;
      ref = Object.freeze({
        platform,
        itemId: linkId,
        skuId: `${digits(hash.slice(26, 42), 10)}${serial}`,
      });
    } else {
      linkId = `dm${hash.slice(16, 40)}`;
      ref = Object.freeze({ platform, goods_id: stable, goods_sign: linkId });
    }
    // Amounts come from @couli/money (AGENTS.md: money only through packages/money); the seed
    // only picks ratios. Coupon 1%–30% of the price, so it always stays below the price.
    const price = mulDivFloor(PRICE_CEILING_FEN, seededBp(hash.slice(42, 50), 200n, 9_801n), BP);
    const couponBp = index % 3 === 0 ? 0n : seededBp(hash.slice(50, 54), 100n, 2_901n);
    const commission = index % 5 === 0 ? 0n : seededBp(hash.slice(54, 58), 50n, 2_950n);
    entries.push(
      Object.freeze({
        linkId,
        ref,
        title: `演示商品 ${hash.slice(58, 64)} ${String(index + 1).padStart(2, '0')}`,
        price_fen: price,
        coupon_bp: couponBp,
        commission_rate_bp: commission,
        ...(platform === 'taobao'
          ? { promotions: taobaoPromotions(index, hash, price, couponBp) }
          : {}),
        images: demoImages(platform, linkId, index),
      }),
    );
  }
  return Object.freeze(entries);
}

/** Synthetic domain DTOs only; not AC-LINK / AC-ORD evidence (规划/11 §4.5).
 * Demo URLs use https://demo.invalid/<platform>/<encoded raw item identifier>.
 * Titles explicitly contain “演示”; no platform transport or recordings are involved.
 */
export class DemoUnionAdapter implements UnionAdapter {
  readonly platform: RegisteredPlatform;
  readonly #seed: string;
  readonly #clock: Clock;
  readonly #catalog: readonly CatalogEntry[];
  readonly #feed: readonly CatalogEntry[];
  readonly #byLinkId: ReadonlyMap<string, CatalogEntry>;
  readonly #warn: ((warning: TaobaoPriceWarning) => void) | undefined;
  readonly #priceSettings: TaobaoPriceSettingsReader | undefined;

  constructor(options: DemoUnionOptions) {
    const { platform, seed, clock, environment } = options;
    if (!DEMO_ENVIRONMENTS.includes(environment)) {
      throw new UnionError(
        'unsafe_mode',
        `The demo union adapter refuses to start in ${String(environment)}`,
        isRegisteredPlatform(platform) ? platform : null,
      );
    }
    if (!isRegisteredPlatform(platform)) {
      throw new UnionError('invalid_endpoint', 'Demo adapter platform is not registered');
    }
    if (!filled(seed)) throw new UnionError('invalid_endpoint', 'Demo seed must be non-empty');
    this.platform = platform;
    this.#seed = seed;
    this.#clock = clock;
    this.#warn = options.warn;
    this.#priceSettings = options.taobaoPriceSettings;
    this.#catalog = buildCatalog(platform, seed);
    // The feed walks the same catalog in a different order, so every feed item has a detail.
    this.#feed = Object.freeze([...this.#catalog].reverse());
    this.#byLinkId = new Map(this.#catalog.map((entry) => [entry.linkId, entry]));
  }

  async searchItems(q: SearchQuery, ctx: CallCtx): Promise<Page<UnionItem>> {
    const scenario = this.#scenario(ctx);
    if (typeof q !== 'object' || q === null || !filled(q.keyword)) {
      throw this.#invalid('search keyword must be a non-empty string');
    }
    const matches = this.#catalog.filter((entry) => entry.title.includes(q.keyword));
    const price = await this.#priceOptions(ctx);
    return this.#page(matches, q.cursor, SEARCH_PAGE_SIZE, scenario, price);
  }

  async getItem(ref: ItemRef, ctx: CallCtx): Promise<UnionItemDetail> {
    const scenario = this.#scenario(ctx);
    const entry = this.#lookup(ref);
    if (scenario === 'delisted') throw this.#delisted();
    const price = await this.#priceOptions(ctx);
    return Object.freeze({
      ...this.#item(entry, scenario, price),
      description: DETAIL_TEXT,
      ...entry.images,
    });
  }

  async resolveLink(raw: string, ctx: CallCtx): Promise<ResolvedLink> {
    const scenario = this.#scenario(ctx);
    const entry = this.#parseLink(raw);
    if (scenario === 'delisted') throw this.#delisted();
    return Object.freeze({ item: entry.ref });
  }

  async convert(req: ConvertReq, identity: UnionIdentity, ctx: CallCtx): Promise<ConvertResult> {
    // Only linking's server-built identity counts (BR-ATTR-05, BR-AI-03); identity-looking
    // fields on the request, the item or the context are never read.
    const claims = this.#claims(identity, ctx);
    const scenario = this.#scenario(ctx);
    if (typeof req !== 'object' || req === null) throw this.#invalid('convert request missing');
    const entry = this.#lookup(req.item);
    if (scenario === 'delisted') throw this.#delisted();
    if (this.platform === 'taobao') {
      // 02 §5.1: no server-side conversion; echo what the client SDK needs.
      return Object.freeze({
        kind: 'baichuan',
        item: entry.ref,
        promotionSlot: claims.promotionSlot,
        relationId: claims.relationId as string,
      });
    }
    // Varies with every identity claim (user and promotion slot included) without exposing them.
    const tag = digest([
      'demo-convert',
      this.platform,
      claims.appId,
      claims.userId,
      claims.promotionSlot,
      claims.relationId ?? '',
    ]).slice(0, 20);
    return Object.freeze({ kind: 'url', url: `${this.#link(entry)}?ref=${tag}` });
  }

  async bindPublisher(req: BindReq, ctx: CallCtx): Promise<BindResult> {
    this.#scenario(ctx);
    if (typeof req !== 'object' || req === null || !filled(req.authorizationCode)) {
      throw this.#invalid('authorizationCode must be a non-empty string');
    }
    if (!filled(ctx.appId)) throw this.#invalid('bind requires the calling app');
    // App-scoped: the same synthetic code under two brands gives two relation ids.
    const tag = digest(['demo-bind', this.platform, ctx.appId, this.#seed, req.authorizationCode]);
    return Object.freeze({ relationId: `demo-relation-${tag.slice(0, 16)}` });
  }

  async materialFeed(req: MaterialReq, ctx: CallCtx): Promise<Page<UnionItem>> {
    const scenario = this.#scenario(ctx);
    if (typeof req !== 'object' || req === null) throw this.#invalid('feed request missing');
    const price = await this.#priceOptions(ctx);
    return this.#page(this.#feed, req.cursor, FEED_PAGE_SIZE, scenario, price);
  }

  /**
   * B1-22p: deterministic synthetic categories of any material channel (non-prod only). The
   * demo catalog is split into DEMO_CHANNEL_CATEGORIES.length categories by index, so every
   * category has items. Never a capability claim (CAP-*-10).
   */
  async channelCategories(
    req: ChannelCategoriesReq,
    ctx: CallCtx,
  ): Promise<readonly ChannelRankingCategory[]> {
    this.#scenario(ctx);
    this.#channelId(req);
    return DEMO_CHANNEL_CATEGORIES;
  }

  /**
   * B1-22p: deterministic synthetic channel pages (non-prod only). The channel's own order is a
   * seeded permutation of the demo catalog per channel id; a category keeps the positions of
   * its items in that order. Items are the same DTO materialFeed returns; salesText is a
   * synthetic sales text or null. pageNo past the end answers an empty page.
   */
  async channelRanking(req: ChannelRankingReq, ctx: CallCtx): Promise<ChannelRankingPage> {
    const scenario = this.#scenario(ctx);
    const channelId = this.#channelId(req);
    const { categoryId, pageNo, pageSize } = req;
    if (typeof pageNo !== 'number' || !Number.isInteger(pageNo) || pageNo < 1) {
      throw this.#invalid('pageNo must be an integer from 1');
    }
    if (
      typeof pageSize !== 'number' ||
      !Number.isInteger(pageSize) ||
      pageSize < 1 ||
      pageSize > DEMO_RANKING_MAX_PAGE_SIZE
    ) {
      throw this.#invalid('pageSize is out of range');
    }
    let slot: number | null = null;
    if (categoryId !== null) {
      const found =
        typeof categoryId === 'string'
          ? DEMO_CHANNEL_CATEGORIES.findIndex((category) => category.categoryId === categoryId)
          : -1;
      if (found < 0) throw this.#invalid('unknown channel category');
      slot = found;
    }
    if (scenario === 'delisted') return Object.freeze({ items: Object.freeze([]), hasMore: false });
    const ranked = this.#catalog
      .map((entry, index) => ({
        entry,
        index,
        key: digest(['demo-channel-rank', this.platform, this.#seed, channelId, entry.linkId]),
      }))
      .filter(({ index }) => slot === null || index % DEMO_CHANNEL_CATEGORIES.length === slot)
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const offset = (pageNo - 1) * pageSize;
    const slice = offset < ranked.length ? ranked.slice(offset, offset + pageSize) : [];
    const price = await this.#priceOptions(ctx);
    return Object.freeze({
      items: Object.freeze(
        slice.map(({ entry, key }) =>
          Object.freeze({
            item: this.#item(entry, scenario, price),
            salesText: demoSalesText(key),
          }),
        ),
      ),
      hasMore: offset + pageSize < ranked.length,
    });
  }

  /**
   * B1-06v: the demo Pinduoduo authority (备案) query of a server-built identity: authorized unless
   * the call carries the pdd_unauthorized scenario. Synthetic; never a capability claim (CAP-PDD-05).
   */
  async queryPddAuthority(identity: UnionIdentity, ctx: CallCtx): Promise<PddAuthority> {
    this.#claims(identity, ctx);
    const scenario = this.#scenario(ctx);
    if (this.platform !== 'pdd') {
      throw new UnionError(
        'adapter_unimplemented',
        `Demo union adapter for ${this.platform} has no authority query`,
        this.platform,
      );
    }
    return Object.freeze({ authorized: scenario !== 'pdd_unauthorized' });
  }

  /**
   * B1-06zf (FU-PDD-AUTH-LINK): the demo Pinduoduo filing link of a server-built identity — an
   * obvious demo address (https://demo.invalid/…), never an imitation of a Pinduoduo payload.
   * Synthetic; never a capability claim (CAP-PDD-05).
   */
  async pddAuthorityUrl(identity: UnionIdentity, ctx: CallCtx): Promise<PddAuthorityUrl> {
    const claims = this.#claims(identity, ctx);
    this.#scenario(ctx);
    if (this.platform !== 'pdd') {
      throw new UnionError(
        'adapter_unimplemented',
        `Demo union adapter for ${this.platform} has no authority link`,
        this.platform,
      );
    }
    // Varies with the identity (app, user key, slot) without exposing any of it.
    const tag = digest([
      'demo-authority',
      this.platform,
      this.#seed,
      claims.appId,
      claims.userId,
      claims.promotionSlot,
    ]).slice(0, 20);
    const base = `https://${DEMO_HOST}/${this.platform}/authority`;
    // D10-662: schema_url is an obvious demo App scheme (never a platform scheme); the two web
    // fields stay https on the demo host, all three distinct.
    return Object.freeze({
      url: `${base}/page/${tag}`,
      schema_url: `couli-demo://${this.platform}/authority/${tag}`,
      mobile_short_url: `${base}/m/${tag}`,
    });
  }

  async listOrders(win: TimeWindow, opt: OrderQueryOpt, ctx: CallCtx): Promise<Page<UnionOrder>> {
    void win;
    void opt;
    void ctx;
    // TODO(规划/11 §4.5): 演示订单流 — blocked on 订单同步任务（不在 B1-04o 范围，演示数据也不得进入对账）
    throw new UnionError(
      'adapter_unimplemented',
      `Demo union adapter for ${this.platform} has no order feed`,
      this.platform,
    );
  }

  /**
   * B1-22q: the calling app's BR-PRICE-02 settings, read again on every call that maps Taobao
   * prices (no cache); undefined (08 defaults) without a settings port or for other platforms.
   */
  async #priceOptions(ctx: CallCtx): Promise<TaobaoPriceOptions | undefined> {
    if (this.platform !== 'taobao' || this.#priceSettings === undefined) return undefined;
    return this.#priceSettings.read(ctx.appId);
  }

  /** Reads CallCtx.scenario; timeout and rate limit fail the call before any other work. */
  #scenario(ctx: CallCtx): DemoScenario | undefined {
    const scenario = ctx.scenario;
    if (scenario === undefined) return undefined;
    if (
      !(SCENARIOS as readonly string[]).includes(scenario) ||
      (this.platform !== 'taobao' &&
        (TAOBAO_ONLY_SCENARIOS as readonly string[]).includes(scenario)) ||
      (this.platform !== 'pdd' && (PDD_ONLY_SCENARIOS as readonly string[]).includes(scenario))
    ) {
      throw new DemoUnionError('demo_unknown_scenario', 'Unknown demo scenario', this.platform);
    }
    const dependency = `union:demo:${this.platform}`;
    if (scenario === 'timeout') {
      throw new GovernanceError('timeout', dependency, 'Demo scenario: dependency timed out');
    }
    if (scenario === 'rate_limit') {
      throw new GovernanceError('quota_exceeded', dependency, 'Demo scenario: quota exhausted');
    }
    return scenario as DemoScenario;
  }

  #claims(identity: UnionIdentity, ctx: CallCtx): IdentityClaims {
    const reject = (): UnionError =>
      new UnionError(
        'invalid_identity',
        'convert requires a complete server-side identity of the same app and platform',
        this.platform,
      );
    if (!isServerIdentity(identity)) throw reject();
    const claims = identity.claims;
    if (
      !filled(claims.appId) ||
      claims.appId !== ctx.appId ||
      claims.platform !== this.platform ||
      !filled(claims.userId) ||
      !filled(claims.promotionSlot)
    ) {
      throw reject();
    }
    const relationOk =
      this.platform === 'taobao'
        ? filled(claims.relationId)
        : claims.relationId === null || filled(claims.relationId);
    if (!relationOk) throw reject();
    return claims;
  }

  #page(
    entries: readonly CatalogEntry[],
    cursor: string | undefined,
    size: number,
    scenario: DemoScenario | undefined,
    price: TaobaoPriceOptions | undefined,
  ): Page<UnionItem> {
    let offset = 0;
    if (cursor !== undefined) {
      const match = typeof cursor === 'string' ? /^demo-([1-9][0-9]{0,3})$/.exec(cursor) : null;
      offset = match === null ? -1 : Number(match[1]);
      if (offset <= 0 || offset >= entries.length) throw this.#invalid('unknown cursor');
    }
    if (scenario === 'delisted') return Object.freeze({ items: [], nextCursor: null });
    const slice = entries.slice(offset, offset + size);
    const next = offset + size;
    return Object.freeze({
      items: Object.freeze(slice.map((entry) => this.#item(entry, scenario, price))),
      nextCursor: next < entries.length ? `demo-${String(next)}` : null,
    });
  }

  #item(
    entry: CatalogEntry,
    scenario: DemoScenario | undefined,
    price: TaobaoPriceOptions | undefined,
  ): UnionItem {
    const now = this.#clock.now();
    if (entry.promotions !== undefined) return this.#taobaoItem(entry, scenario, now, price);
    // coupon_fen = floor(price * bp / 10000); final_price_fen = price - coupon (the remainder).
    const couponBp = scenario === 'coupon_expired' ? 0n : entry.coupon_bp;
    const split = splitByBp(entry.price_fen, [couponBp]);
    return Object.freeze({
      ...entry.ref,
      title: entry.title,
      price_fen: entry.price_fen,
      coupon_fen: split.shares[0] ?? 0n,
      final_price_fen: split.remainder,
      commission_rate_bp: scenario === 'no_commission' ? 0n : entry.commission_rate_bp,
      quoted_at: now.toISOString(),
    });
  }

  /** Taobao: the synthetic detail goes through the same pure mapping as live data would. */
  #taobaoItem(
    entry: CatalogEntry,
    scenario: DemoScenario | undefined,
    now: Date,
    price: TaobaoPriceOptions | undefined,
  ): UnionItem {
    const nowMs = now.getTime();
    const source = entry.promotions ?? [];
    const kept =
      scenario === 'coupon_expired'
        ? source.filter((promotion) => promotion.id === undefined)
        : [...source];
    if (scenario === 'unknown_promo') {
      kept.push({ title: DEMO_UNLISTED_TITLE, amount_fen: mulDivFloor(entry.price_fen, 100n, BP) });
    }
    const promotions: TaobaoPromotion[] = kept.map((promotion) => ({
      title: promotion.title,
      amount_fen: promotion.amount_fen,
      ...(promotion.id === undefined ? {} : { id: promotion.id }),
      ...(promotion.start_offset_ms === undefined
        ? {}
        : { start_ms: nowMs + promotion.start_offset_ms }),
      ...(promotion.end_offset_ms === undefined ? {} : { end_ms: nowMs + promotion.end_offset_ms }),
    }));
    let total = 0n;
    for (const promotion of kept) total = addFen(total, promotion.amount_fen);
    let promotionFinal = subFen(entry.price_fen, total);
    // One fen off: the detail no longer reconciles with the promotion final price.
    if (scenario === 'price_anomaly') promotionFinal = subFen(promotionFinal, 1n);
    const result = mapTaobaoPrice(
      { discount_fen: entry.price_fen, promotion_final_fen: promotionFinal, promotions },
      nowMs,
      price,
    );
    if (this.#warn !== undefined) for (const warning of result.warnings) this.#warn(warning);
    return Object.freeze({
      ...entry.ref,
      title: entry.title,
      price_fen: result.price_fen,
      coupon_fen: result.coupon_fen,
      final_price_fen: result.final_price_fen,
      commission_rate_bp: scenario === 'no_commission' ? 0n : entry.commission_rate_bp,
      quoted_at: now.toISOString(),
      ...(result.coupon_ids === undefined ? {} : { coupon_ids: result.coupon_ids }),
      price_status: result.price_status,
      ...(result.price_anomaly_reason === undefined
        ? {}
        : { price_anomaly_reason: result.price_anomaly_reason }),
    });
  }

  /** A catalog item of this platform; every identifier present must match it. */
  #lookup(ref: ItemRef): CatalogEntry {
    if (typeof ref !== 'object' || ref === null || ref.platform !== this.platform) {
      throw this.#invalid('item is not a demo item of this platform');
    }
    const linkId =
      this.platform === 'taobao'
        ? ref.item_id
        : this.platform === 'jd'
          ? ref.itemId
          : ref.goods_sign;
    const entry = typeof linkId === 'string' ? this.#byLinkId.get(linkId) : undefined;
    if (entry === undefined) throw this.#invalid('item is not in the demo catalog');
    const known = entry.ref;
    for (const field of ['item_id', 'itemId', 'skuId', 'goods_id', 'goods_sign'] as const) {
      const value = ref[field];
      if (value !== undefined && value !== null && value !== known[field]) {
        throw this.#invalid('item identifiers do not match the demo catalog');
      }
    }
    return entry;
  }

  #link(entry: CatalogEntry): string {
    return `https://${DEMO_HOST}/${this.platform}/${encodeURIComponent(entry.linkId)}`;
  }

  #parseLink(raw: string): CatalogEntry {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw this.#invalid('not a demo link');
    }
    const segments = url.pathname.split('/');
    const extra = [...url.searchParams.keys()].filter((key) => key !== 'ref');
    if (
      url.protocol !== 'https:' ||
      url.hostname !== DEMO_HOST ||
      url.port !== '' ||
      url.username !== '' ||
      url.password !== '' ||
      url.hash !== '' ||
      extra.length > 0 ||
      segments.length !== 3 ||
      segments[1] !== this.platform
    ) {
      throw this.#invalid('not a demo link of this platform');
    }
    let linkId: string;
    try {
      linkId = decodeURIComponent(segments[2] ?? '');
    } catch {
      throw this.#invalid('not a demo link of this platform');
    }
    const entry = this.#byLinkId.get(linkId);
    if (entry === undefined) throw this.#invalid('link does not point at a demo item');
    return entry;
  }

  /** B1-22p: any non-empty channel id; the port has already checked the whitelist. */
  #channelId(req: { readonly channelId: string }): string {
    if (typeof req !== 'object' || req === null || !filled(req.channelId)) {
      throw this.#invalid('channelId must be a non-empty string');
    }
    return req.channelId;
  }

  #invalid(message: string): UnionError {
    return new UnionError('invalid_dto', `Demo ${this.platform}: ${message}`, this.platform);
  }

  #delisted(): DemoUnionError {
    return new DemoUnionError('demo_delisted', 'Demo scenario: item delisted', this.platform);
  }
}
