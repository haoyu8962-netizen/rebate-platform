// B1-07a: parse_input core (规划/04 §8.5; 08 BR-PROD-03, BR-PROD-08 ⑤, BR-PRICE-08, BR-ATTR-29).
// Up to three links or passwords per message; each URL is classified by the platform link pattern
// table, handed to the governed union adapter's resolveLink, keyed by @couli/domain's
// deriveProductKey and carded through catalog's single card entry (active query, entry_source
// parse). One card per resolved key per message. Error split:
// - 30132: no concrete product identified — no candidate at all, password parsing off or not
//   recognized (including a stage pending permission: adapter_unimplemented), a union_host-only
//   page (home, store), or resolveLink refusing the link;
// - 30131: the platform or link is unsupported (no table hit, a platform without union adapter or
//   derivation rule), or a recognized product whose product_key cannot be derived;
// - 30141: the union says the item is delisted at detail (or the demo adapter's delisted scenario);
// - 50301: a union dependency failure (upstream unavailable, throttled, governor timeout, breaker
//   open, quota exhausted). In parseInput it is that hit's own result: other hits still card.
// The user's original URL or password is only the input hit: it never becomes canonicalUrl, a card
// field or an open target (BR-PRICE-08, BR-ATTR-27). No convert call happens here (TRADE-03).
import type { components } from '@couli/contracts-ts';
import type { Logger } from 'pino';
import { deriveProductKey, ProductKeyUnderivable } from '@couli/domain';
import type {
  Catalog,
  CatalogCardEntry,
  PriceSnapshotRecorder,
  ProductCard,
  ProductRef,
} from '../../catalog/index.ts';
import {
  GovernanceError,
  getLinkPatterns,
  type Clock,
  type GovernanceErrorCode,
  type LinkPatternsSpec,
} from '../../platform/index.ts';
import {
  DemoUnionError,
  isPlatform,
  isRegisteredPlatform,
  UnionError,
  type CallCtx,
  type UnionErrorCode,
  type ItemRef,
  type Platform,
  type RegisteredPlatform,
  type UnionAdapter,
  type UnionItemDetail,
} from '../../union/index.ts';
import { extractCandidates, type Candidate } from '../domain/candidates.ts';
import { classifyParsingUrl } from '../domain/link-patterns.ts';
import type { ParsingConfigReader } from '../ports.ts';

export type ParsingHit = components['schemas']['InputHit'];

/** The parse error codes this module decides (contracts/error-codes.yaml). */
export type ParsingErrorCode = 30131 | 30132 | 30141 | 50301;

export const UNSUPPORTED = 30131;
export const UNRECOGNIZED = 30132;
export const OFF_SHELF = 30141;
/** error-codes.yaml 50301 without reason (maintenance): the platform dependency is down. */
export const DEPENDENCY_DOWN = 50301;
/**
 * error-codes.yaml 50001: a non-business failure while one hit was handled (a database or other
 * internal fault). parseInput reports it as that hit's own result and logs a warning, so the
 * other hits of the message still card (B1-07b).
 */
export const INTERNAL_FAILURE = 50001;

/** Rejection of parseUrl; parseInput reports the same codes as typed results instead. */
export class ParsingError extends Error {
  readonly code: ParsingErrorCode;
  constructor(code: ParsingErrorCode, message: string) {
    super(message);
    this.name = 'ParsingError';
    this.code = code;
  }
}

export interface ParsingOptions {
  readonly config: Pick<ParsingConfigReader, 'configValue'>;
  readonly catalog: Pick<Catalog, 'listPlatforms' | 'resolveProductKey'>;
  readonly cards: CatalogCardEntry;
  readonly clock: Clock;
  /** Supplied adapters must already pass through union governance. */
  readonly getGovernedAdapter: (
    platform: RegisteredPlatform,
  ) => Pick<UnionAdapter, 'resolveLink' | 'getItem'>;
  /** Omission uses platform.getLinkPatterns(); overrides are synthetic test fixtures. */
  readonly linkPatterns?: LinkPatternsSpec;
  /** Warning sink of a hit isolated by a non-business failure (flat fields only, no input text). */
  readonly logger?: Pick<Logger, 'warn'>;
  /**
   * B1-17c: the price history hook (BR-WATCH-19 (1), source_kind quote). Absent, parsing behaves
   * exactly as before. Present, every successful union detail of a hit (a fresh getItem answer;
   * the query carries no viewer identity) is handed to record() once (not awaited; a throw is
   * swallowed; the results never change).
   */
  readonly priceHistory?: PriceSnapshotRecorder;
}

/** Internal D33 result; price_unavailable is deliberately not a fabricated wire card. */
export type ParsingResult =
  | { readonly kind: 'card'; readonly hit: ParsingHit; readonly card: ProductCard }
  | { readonly kind: 'error'; readonly hit: ParsingHit | null; readonly error_code: number }
  | {
      readonly kind: 'price_unavailable';
      readonly hit: ParsingHit;
      readonly productKey: string;
    };

export interface ParsingService {
  parseInput(text: string, context: CallCtx): Promise<readonly ParsingResult[]>;
}

export interface ParsedUrlProduct {
  readonly item: UnionItemDetail;
  readonly ref: ProductRef;
}

const TPWD_SWITCH = 'parse.tpwd.enabled';
const JD_MODE = 'product_key.jd.mode';
/** BR-PROD-03 解析行: MVP passwords are taobao's (京口令 has no official parse interface). */
const TPWD_PLATFORM: RegisteredPlatform = 'taobao';

/** Union refusals that mean "no concrete product" (business answers, not dependency failures). */
const UNRECOGNIZED_UNION_CODES: ReadonlySet<UnionErrorCode> = new Set<UnionErrorCode>([
  'link_unrecognized',
  'adapter_unimplemented',
  'upstream_rejected',
  'invalid_dto',
]);

/** Union dependency failures (02 §6.2: retried and counted by the breaker before reaching us). */
const DEPENDENCY_UNION_CODES: ReadonlySet<UnionErrorCode> = new Set<UnionErrorCode>([
  'upstream_unavailable',
  'rate_limited',
]);

/**
 * B1-04zzzx (D10-967 ③): our own refused credentials / API permission and an invalid site-owner
 * authorization. Not retried nor counted by the breaker (union classifies them as refusals), but
 * they say nothing about this hit: the temporary code (BR-PROD-05 结果分类 ③), never 50001.
 */
const MISCONFIGURED_UNION_CODES: ReadonlySet<UnionErrorCode> = new Set<UnionErrorCode>([
  'upstream_misconfigured',
  'site_auth_invalid',
]);

/** Governor outcomes that mean the dependency is unavailable; invalid_policy is a config bug. */
const DEPENDENCY_GOVERNANCE_CODES: ReadonlySet<GovernanceErrorCode> = new Set<GovernanceErrorCode>([
  'timeout',
  'circuit_open',
  'quota_exceeded',
]);

type Step<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: ParsingErrorCode };

const fail = (code: ParsingErrorCode): { readonly ok: false; readonly code: ParsingErrorCode } => ({
  ok: false,
  code,
});

/** A resolved candidate whose key is derived but whose detail is not fetched yet. */
interface Identified {
  readonly platform: Platform;
  readonly adapter: Pick<UnionAdapter, 'resolveLink' | 'getItem'>;
  readonly ref: ItemRef;
  readonly productKey: string;
}

/**
 * Maps an error from a governed union call to its parse code; null means rethrow (a programming
 * or configuration fault, not an answer about this hit). `notFound` is the item_unavailable code
 * of the stage: 30132 at resolveLink (no concrete product), 30141 at detail (delisted).
 */
function unionRefusal(error: unknown, notFound: ParsingErrorCode): ParsingErrorCode | null {
  if (error instanceof UnionError) {
    if (error.code === 'item_unavailable') return notFound;
    if (DEPENDENCY_UNION_CODES.has(error.code) || MISCONFIGURED_UNION_CODES.has(error.code)) {
      return DEPENDENCY_DOWN;
    }
    return UNRECOGNIZED_UNION_CODES.has(error.code) ? UNRECOGNIZED : null;
  }
  if (error instanceof DemoUnionError) {
    // The demo delisted scenario is explicit at every stage (resolve, detail, convert).
    return error.code === 'demo_delisted' ? OFF_SHELF : UNRECOGNIZED;
  }
  if (error instanceof GovernanceError) {
    return DEPENDENCY_GOVERNANCE_CODES.has(error.code) ? DEPENDENCY_DOWN : null;
  }
  return null;
}

function nonEmpty(value: string | null | undefined): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** BR-PROD-05 raw_item_id: the platform's own identifier used later for detail and convert. */
function rawItemIdOf(source: ItemRef, jdMode: string): string | undefined {
  switch (source.platform) {
    case 'taobao':
      return nonEmpty(source.item_id);
    case 'jd':
      return jdMode === 'sku' ? nonEmpty(source.skuId) : nonEmpty(source.itemId);
    case 'pdd':
      return nonEmpty(source.goods_sign) ?? nonEmpty(source.goods_id);
    default:
      return undefined;
  }
}

/** Shared by parseInput and parseUrl: everything up to (not including) the card. */
function createResolver(options: ParsingOptions) {
  const { config, catalog, clock } = options;
  const patterns = (): LinkPatternsSpec => options.linkPatterns ?? getLinkPatterns();

  async function jdModeOf(appId: string): Promise<string> {
    const entry = await config.configValue(appId, JD_MODE);
    // Absent means item (BR-PROD-03); any other value fails closed in deriveProductKey.
    return entry === null ? 'item' : String(entry.value);
  }

  async function tpwdEnabled(appId: string): Promise<boolean> {
    const entry = await config.configValue(appId, TPWD_SWITCH);
    // The seed value is true; an explicit false (or "false"/"off") turns the stage off (02 §14).
    if (entry === null) return true;
    return entry.value === true || entry.value === 'true' || entry.value === 'on';
  }

  /** Classifies a URL candidate into its hit, or the error with its hit (null: no table hit). */
  function classify(raw: string): { hit: ParsingHit | null; category: string | null } {
    const match = classifyParsingUrl(raw, patterns());
    if (match === null || !isPlatform(match.platform)) return { hit: null, category: null };
    return { hit: { platform: match.platform, kind: 'url', raw }, category: match.category };
  }

  /** resolveLink through the governed adapter, then derive and alias-resolve the key. */
  async function identify(
    platform: Platform,
    raw: string,
    context: CallCtx,
  ): Promise<Step<Identified & { readonly resolvedKey: string; readonly jdMode: string }>> {
    if (!isRegisteredPlatform(platform)) return fail(UNSUPPORTED);
    let adapter: Pick<UnionAdapter, 'resolveLink' | 'getItem'>;
    try {
      adapter = options.getGovernedAdapter(platform);
    } catch (error: unknown) {
      if (error instanceof UnionError && error.code === 'adapter_unimplemented') {
        return fail(UNSUPPORTED);
      }
      throw error;
    }
    let ref: ItemRef;
    try {
      ref = (await adapter.resolveLink(raw, context)).item;
    } catch (error: unknown) {
      const code = unionRefusal(error, UNRECOGNIZED);
      if (code === null) throw error;
      return fail(code);
    }
    const platforms = await catalog.listPlatforms();
    const row = platforms.find((candidate) => candidate.code === ref.platform);
    if (row === undefined) return fail(UNSUPPORTED);
    const jdMode = ref.platform === 'jd' ? await jdModeOf(context.appId) : 'item';
    let productKey: string;
    try {
      productKey = deriveProductKey(
        {
          platform: ref.platform,
          keyPrefix: row.key_prefix,
          ...(ref.platform === 'jd' ? { jdMode: jdMode as 'item' | 'sku' } : {}),
        },
        ref,
      );
    } catch (error: unknown) {
      if (error instanceof ProductKeyUnderivable) return fail(UNSUPPORTED);
      throw error;
    }
    const resolvedKey = await catalog.resolveProductKey(productKey);
    return {
      ok: true,
      value: { platform: ref.platform, adapter, ref, productKey, resolvedKey, jdMode },
    };
  }

  /** Fetches the detail by the union-identified reference and builds the product_refs shape. */
  async function detail(
    identified: Identified & { readonly jdMode: string },
    context: CallCtx,
  ): Promise<Step<ParsedUrlProduct>> {
    let item: UnionItemDetail;
    try {
      item = await identified.adapter.getItem(identified.ref, context);
    } catch (error: unknown) {
      const code = unionRefusal(error, OFF_SHELF);
      if (code === null) throw error;
      return fail(code);
    }
    const rawItemId =
      (item.platform === identified.platform ? rawItemIdOf(item, identified.jdMode) : undefined) ??
      rawItemIdOf(identified.ref, identified.jdMode);
    if (rawItemId === undefined) return fail(UNSUPPORTED);
    const ref: ProductRef = {
      appId: context.appId,
      platform: identified.platform,
      productKey: identified.productKey,
      rawItemId,
      rawFetchedAt: item.quoted_at,
      receivedAt: clock.now().toISOString(),
      // Never the user's URL: it may carry another promoter's parameters (BR-PRICE-08).
      canonicalUrl: null,
      title: item.title,
      shopId: null,
      shopType: null,
      source: 'parse',
    };
    return { ok: true, value: { item, ref } };
  }

  return { classify, identify, detail, tpwdEnabled };
}

/**
 * B1-06i port: resolves and derives a product by URL without registering a card or converting a
 * link. Rejects with ParsingError (code 30131 / 30132 / 30141) on the same split as parseInput.
 */
export async function parseUrl(
  options: ParsingOptions,
  url: string,
  context: CallCtx,
): Promise<ParsedUrlProduct> {
  const resolver = createResolver(options);
  const { hit, category } = resolver.classify(url);
  if (hit === null) throw new ParsingError(UNSUPPORTED, 'parsing: link or platform not supported');
  if (category === 'union_host') {
    throw new ParsingError(UNRECOGNIZED, 'parsing: no concrete product on this page');
  }
  const identified = await resolver.identify(hit.platform, url, context);
  if (!identified.ok) throw new ParsingError(identified.code, 'parsing: link not resolved');
  const product = await resolver.detail(identified.value, context);
  if (!product.ok) throw new ParsingError(product.code, 'parsing: product detail not available');
  return product.value;
}

/**
 * B3-04h port: the official password parse for Agent quotes (TokenParser of agent tools/quote).
 * Same steps and error split as parseInput's tpwd branch: taobao only, the parse.tpwd.enabled
 * switch read first (off: 30132 before any union call), then the governed resolveLink, key
 * derivation and detail. Non-business faults are rethrown, as in parseUrl. No card, no dedup, no
 * convert. Third-party password parsing is never used here (BR-AI-04: parse.third_party.enabled
 * is not read).
 * TODO(规划/11 §4.5): 真实口令识别 — blocked on 淘宝口令权限包与录制（followups F-31）
 */
export async function parseToken(
  options: ParsingOptions,
  raw: string,
  context: CallCtx,
): Promise<ParsedUrlProduct> {
  const resolver = createResolver(options);
  if (!(await resolver.tpwdEnabled(context.appId))) {
    throw new ParsingError(UNRECOGNIZED, 'parsing: password parsing is off');
  }
  const identified = await resolver.identify(TPWD_PLATFORM, raw, context);
  if (!identified.ok) throw new ParsingError(identified.code, 'parsing: password not resolved');
  const product = await resolver.detail(identified.value, context);
  if (!product.ok) throw new ParsingError(product.code, 'parsing: product detail not available');
  return product.value;
}

/** Shared pure-code use case for the later HTTP and Agent entry points. */
export function createParsing(options: ParsingOptions): ParsingService {
  const resolver = createResolver(options);

  /** The candidate's hit, or the typed result it ends with before any I/O. */
  function hitOf(
    candidate: Candidate,
  ): { readonly hit: ParsingHit } | { readonly result: ParsingResult } {
    if (candidate.kind === 'tpwd') {
      return { hit: { platform: TPWD_PLATFORM, kind: 'tpwd', raw: candidate.raw } };
    }
    const classified = resolver.classify(candidate.raw);
    if (classified.hit === null) {
      return { result: { kind: 'error', hit: null, error_code: UNSUPPORTED } };
    }
    if (classified.category === 'union_host') {
      return { result: { kind: 'error', hit: classified.hit, error_code: UNRECOGNIZED } };
    }
    return { hit: classified.hit };
  }

  async function parseCandidate(
    candidate: Candidate,
    hit: ParsingHit,
    context: CallCtx,
    seen: Set<string>,
  ): Promise<ParsingResult | null> {
    if (candidate.kind === 'tpwd' && !(await resolver.tpwdEnabled(context.appId))) {
      return { kind: 'error', hit, error_code: UNRECOGNIZED };
    }
    const identified = await resolver.identify(hit.platform, candidate.raw, context);
    if (!identified.ok) return { kind: 'error', hit, error_code: identified.code };
    // BR-PROD-08 ⑤: one card per (platform, resolved key) within this message. The key is taken
    // only once a candidate has carded (or got its typed price_unavailable result): a failed
    // earlier candidate of the same key leaves room for a later one.
    const dedupKey = `${identified.value.platform}\u0000${identified.value.resolvedKey}`;
    if (seen.has(dedupKey)) return null;
    const product = await resolver.detail(identified.value, context);
    if (!product.ok) return { kind: 'error', hit, error_code: product.code };
    if (options.priceHistory !== undefined) {
      const { item } = product.value;
      try {
        void Promise.resolve(
          options.priceHistory.record({
            appId: context.appId,
            platform: item.platform,
            productKey: identified.value.resolvedKey,
            skuKey: item.skuId ?? null,
            sourceKind: 'quote',
            outcome: 'ok',
            priceFen: item.price_fen,
            couponFen: item.coupon_fen,
            finalPriceFen: item.final_price_fen,
            priceStatus: item.price_status ?? 'ok',
            inStock: true,
            fresh: true,
            userScoped: false,
            goodsSignPlan: null,
          }),
        ).catch(() => undefined);
      } catch {
        // History failure must not fail this hit or prevent later hits from being processed.
      }
    }
    const result = await options.cards.assemble({
      item: product.value.item,
      ref: product.value.ref,
      entrySource: 'parse',
      stale: false,
      scene: 'active_query',
    });
    switch (result.kind) {
      case 'card':
        seen.add(dedupKey);
        return { kind: 'card', hit, card: result.card };
      case 'price_unavailable':
        seen.add(dedupKey);
        return { kind: 'price_unavailable', hit, productKey: product.value.ref.productKey };
      default:
        throw new Error('parsing: the active-query card entry skipped an item');
    }
  }

  async function parseInput(text: string, context: CallCtx): Promise<readonly ParsingResult[]> {
    const candidates = extractCandidates(text);
    if (candidates.length === 0) return [{ kind: 'error', hit: null, error_code: UNRECOGNIZED }];
    // Request-scoped: dedup never leaks across messages or apps.
    const seen = new Set<string>();
    const results: ParsingResult[] = [];
    // Sequential, in text order: the fourth candidate is never read (BR-AI-01 parse_input row).
    for (const candidate of candidates) {
      const early = hitOf(candidate);
      if ('result' in early) {
        results.push(early.result);
        continue;
      }
      let result: ParsingResult | null;
      try {
        result = await parseCandidate(candidate, early.hit, context, seen);
      } catch (error: unknown) {
        // A non-business failure (database, configuration read, card registration, a programming
        // fault) ends only this hit: earlier cards are kept and later candidates still run. Flat
        // fields only: never the input text, the raw link or the error message (it may echo them).
        options.logger?.warn(
          {
            event: 'parse_hit_failed',
            platform: early.hit.platform,
            kind: early.hit.kind,
            error_class: error instanceof Error ? error.name : typeof error,
          },
          'parsing: hit failed with a non-business error',
        );
        result = { kind: 'error', hit: early.hit, error_code: INTERNAL_FAILURE };
      }
      if (result !== null) results.push(result);
    }
    return results;
  }

  return { parseInput };
}
