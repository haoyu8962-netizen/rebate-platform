// B1-15w: POST /v1/shares (contract createShare, CT-15t; BR-ATTR-10 细则「分享页与分享赚入口页」
// 「淘宝分享实现」, BR-TEXT-20 细则「分享页文案」, BR-PRICE-06, BR-INV-19; orchestrator rulings D10-424 /
// D10-426). Rule tests: test/spec/linking/shares/**.
// With the caller (the sharer) as the identity it registers a new link of scene / pid_scene share,
// converts it in real time and answers the share link, the copy and the share quote in one response.
// Order of one request (x-auth phone, x-signed, x-min-version-gate are the global guard's):
//   login (10001) → platform idempotency (standard mode: the same key with the same body replays the
//   stored answer — 0 and 3xxxx — without running anything; any other result is not stored) →
//   identified minor (verified birth date under 18 at the injected clock, BR-ID-26) → 30413
//   data.reason=self_minor → convert.enabled.<platform> (50301 maintenance) → the platform
//   authorization of the sharer (Taobao active binding, else 30101 with auth_url / state /
//   auth_methods; Pinduoduo filing, else 30111 with auth_jump — the states issued by the auth-url
//   service, link_id empty; JD none) → Taobao: share.taobao_enabled off → 50301
//   data.reason=not_launched, on → the sharer's relation_id (below) → the share identity from local reads (active share slot, attr_code, jd user key mode; none → 50301) →
//   the product (item_ref / product_refs and one governed union detail: 20001 / 30131 / 30141 /
//   30143 / 50303, as POST /v1/links/convert) → the buy_type=share quote of the sharer (catalog's
//   quoter port; failing → 50303) → one transaction: the share link inserted (lk while
//   attr.click_code.<platform> is on), the conversion with the link's identity, share_materials
//   (share_url = the converted short link, app_id the link's own) and the convert log.
//   The platform refusing the conversion → 30121, a temporary failure → 50303, off shelf → 30141:
//   the transaction rolls back, so no link and no material is left; the failure is logged after it.
// Taobao (B1-06zd, D10-510, default off; off is D10-426's 50301 data.reason=not_launched,
// data.platform=taobao): the sharer's active binding gives the relation_id (none usable → 50301)
// and the account whose active share slot converts (BR-ATTR-07); both are frozen on the link. The
// share_url is short_url else coupon_click_url, links.promo_url coupon_click_url else short_url
// (written once, at the injected clock), tpwd the conversion's, never null (promo-prefetch.ts). No
// usable promotion link or no token → 50303, adapter_unimplemented → 50301 not_launched, the rest
// as above: the transaction rolls back, never the original link instead (BR-ATTR-10). The
// conversion's price is not read (BR-PRICE-12).
// poster_url is always null.
// TODO(规划/11 §4.5): 海报出图 — blocked on TECH-13 出图 worker 与 OSS 凭据
// images (B1-15z, BR-ATTR-10 素材图): shareImages of this request's one union detail; the addresses
// are passed on unchanged, never fetched, rehosted or edited, and written to no business table.
// D10-439: the idempotent answer retained by the platform module holds them and is no business
// table, so the stored answer stays whole and a replay answers the same images.
// source_link_id is only part of the idempotent body: the card's link is never read or changed.
// est_promo is only in this response (BR-PRICE-06); the copy never carries an earnings amount.
// Logs carry flat fields only: never the token, the item_ref, the share_url or a user identity.
import type { components } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import {
  ProductKeyInvalid,
  ProductKeyPlatformUnsupported,
  isAtLeastAge,
  splitProductKey,
} from '@couli/domain';
import type { Kysely } from 'kysely';
import {
  RAW_ID_MAX_AGE_MS,
  quoteShare,
  type CardRebateQuoter,
  type Catalog,
  type ItemRefService,
  type RequestRawRef,
  type ShareQuote,
} from '../../catalog/index.ts';
import {
  newUuidV7,
  type AppEnv,
  type Clock,
  type HandlerResult,
  type Idempotency,
} from '../../platform/index.ts';
import {
  DemoUnionError,
  UnionError,
  isPriceAnomaly,
  isRegisteredPlatform,
  type CallCtx,
  type ConvertResult,
  type ItemRef,
  type RegisteredPlatform,
  type UnionItemDetail,
  type UnionPidRow,
  type UnionPidService,
  type UnionRegistry,
} from '../../union/index.ts';
import { renderShareCopy, type ShareCopy } from '../domain/share-copy.ts';
import { SHARE_TAOBAO_SWITCH_KEY, isSwitchOn } from '../domain/rules.ts';
import { storedLinkCode } from '../infra/link-code.ts';
import { recordPddPidFiling } from '../infra/pdd-pid-filings.ts';
import { insertShareMaterial } from '../infra/share-material-store.ts';
import type { AttrCodeReader, Caller, CallerContext, LinkingConfigReader } from '../ports.ts';
import { detailFailure } from './link-convert.ts';
import { LinkingUnionIdentity, itemRefOf } from './link-open-conversion.ts';
import {
  attrCodeOf,
  insertConvertLink,
  linkCodeIssue,
  resolveSnapshot,
  type IdentitySnapshot,
  type PendingOpenLink,
} from './link-registration.ts';
import {
  PDD,
  activatePddBinding,
  pddAuthorityIdentity,
  queryPddAuthority,
} from './pdd-authority.ts';
import {
  TaobaoPromotionIdentity,
  activeTaobaoRelation,
  taobaoPromotionOf,
  writePromoUrl,
  type ActiveTaobaoRelation,
} from './promo-prefetch.ts';
import { createUnionAuthReads, type AuthClient } from './union-auth-reads.ts';
import type { UnionAuthUrlService } from './union-auth-url.ts';

type Body = components['schemas']['CreateShareRequest'];
type ShareMaterials = components['schemas']['ShareMaterials'];
type Client = 'ios' | 'android' | 'harmony' | 'h5' | 'web';

export interface CreateShareInput {
  readonly body: Body;
  readonly idempotencyKey: string;
  readonly traceId: string;
  /** X-Platform as the route schema checked it. */
  readonly client: Client;
}

interface Warn {
  warn(fields: Readonly<Record<string, unknown>>, message: string): void;
}

export interface SharesOptions {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly appEnv: AppEnv;
  readonly logger: Warn;
  readonly callerContext: CallerContext;
  readonly attrCodes?: AttrCodeReader;
  readonly config: LinkingConfigReader;
  readonly pids: Pick<UnionPidService, 'getActivePid'>;
  readonly registry: Pick<UnionRegistry, 'get'>;
  readonly idempotency: Pick<Idempotency, 'execute'>;
  /** catalog: platforms, product_refs and the raw-ID order (as the convert's). */
  readonly products: Catalog;
  readonly itemRefs: Pick<ItemRefService, 'verify'>;
  readonly quoter: CardRebateQuoter;
  /** The auth-url service of this request: the 30101 / 30111 states (link_id empty). */
  readonly authUrl: UnionAuthUrlService;
  /** identity's realname reader: the verified birth date (YYYY-MM-DD), or null. */
  readonly verifiedBirthDate: (appId: string, userId: string) => Promise<string | null>;
  /** B1-08s test seam: the lk source; production omits it. */
  readonly linkCode?: () => string;
}

/** HTTP injection token. The controller takes identity from CallerContext, never body fields. */
export class SharesService {
  create(input: CreateShareInput): Promise<HandlerResult> {
    void input;
    return Promise.reject(new Error('linking: shares service is not composed in this process'));
  }
}

const PATH = '/v1/shares';
const SCENE = 'share' as const;
const PID_SCENE = 'share' as const;
/** BR-PRICE-07 来源判定表: the share entry. */
const ENTRY_SOURCE = 'share';
/** BR-INV-19 / BR-ID-26: a verified user under this age gets 30413. */
const SHARER_MIN_AGE = 18;
const ATTR_CODE = /^[0-9a-z]{8}$/;
const JD_USER_KEY_MODE = 'attr.jd.user_key_mode';
const URL_MAX = 2048;
/** BR-ATTR-10 素材图: the images of one share (contract ShareMaterials.images maxItems). */
const SHARE_IMAGES_MAX = 9;
/** BR-PROD-10: as the convert, a share resolves products like parsing and detail do. */
const CAPABILITIES = Object.freeze({ parseEnabled: true, searchEnabled: false });

/**
 * BR-PRICE-17 price-basis lines: the texts of contracts/texts.default.json price_basis and
 * price_basis.general (BR-TEXT-14 fallback texts; the server keeps no text overrides).
 */
export const SHARE_PRICE_BASIS = Object.freeze({
  withCoupon: '券后价按单件计算，不含运费及会员价等优惠，以下单页为准',
  general: '价格按单件计算，不含运费及会员价等优惠，以下单页为准',
});

/** Fallback texts (contracts/texts.default.json error.<code>); clients show the dictionary's. */
const MESSAGES: Readonly<Record<number, string>> = {
  0: '',
  10001: '请先登录',
  20001: '填写内容有误，请检查',
  30101: '购买前需完成淘宝授权，用于识别你的订单',
  30111: '购买前需完成拼多多授权',
  30121: '京东这个商品暂不支持返利',
  30131: '不支持该链接或平台',
  30141: '商品已下架',
  30143: '商品信息已失效，请重新搜索',
  30153: '该平台返利已被停用，请联系客服',
  30413: '未满 18 周岁，暂不开放邀请与分享',
  50001: '出了点问题，请稍后再试',
  50301: '该平台维护中，请稍后再试',
  50303: '暂时无法确认价格，请稍后再试',
};

/** HTTP status per contracts/error-codes.yaml for every code this operation answers. */
const STATUS: Readonly<Record<number, number>> = {
  0: 200,
  10001: 401,
  20001: 400,
  30101: 422,
  30111: 422,
  30121: 422,
  30131: 422,
  30141: 422,
  30143: 422,
  30153: 422,
  30413: 422,
  50001: 500,
  50301: 503,
  50303: 503,
};

const NOT_LAUNCHED_MSG = '该平台返利即将开放';

interface Refusal {
  readonly code: number;
  readonly data?: Readonly<Record<string, unknown>>;
}

const NOT_LAUNCHED: Refusal = { code: 50301, data: { reason: 'not_launched', platform: 'taobao' } };

/** A refusal raised inside the share transaction: it rolls the link and its material back. */
class ShareAbort extends Error {
  readonly refusal: Refusal;
  readonly msg: string | undefined;

  constructor(refusal: Refusal, msg?: string) {
    super(`linking: share not generated (${refusal.code})`);
    this.name = 'ShareAbort';
    this.refusal = refusal;
    this.msg = msg;
  }
}

/** What the share registers and converts: resolved before the transaction. */
interface ShareTarget {
  readonly platform: RegisteredPlatform;
  readonly productKey: string;
  readonly rawItemId: string;
  readonly rawFetchedAt: string;
  readonly item: UnionItemDetail;
}

/** The conversion identity's local parts (the lk comes from the inserted link). */
interface JdPddShareParts {
  readonly platform: 'jd' | 'pdd';
  readonly promotionSlot: string;
  readonly attrCode: string;
}

/** Taobao's: the sharer's relation_id instead of an lk (the identity carries no click code). */
interface TaobaoShareParts {
  readonly platform: 'taobao';
  readonly promotionSlot: string;
  readonly attrCode: string;
  readonly relationId: string;
}

type ShareIdentityParts = JdPddShareParts | TaobaoShareParts;

/** What a share's conversion gives: the Taobao promotion link is only set for Taobao. */
interface ShareConversion {
  readonly shareUrl: string;
  readonly tpwd: string | null;
  readonly promoUrl: string | null;
}

function isWebUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value === '' || value.length > URL_MAX) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * The share link of a conversion: the converted short link (Pinduoduo's mobile / short URL when
 * the union returns one, else the promotion URL); null when the result carries none.
 */
export function shareUrlOf(platform: 'jd' | 'pdd', result: ConvertResult): string | null {
  if (result.kind !== 'url') return null;
  const short = platform === 'pdd' ? [result.mobile_short_url, result.short_url] : [];
  return [...short, result.url].find(isWebUrl) ?? null;
}

/** union's item reference of a raw item ID. */
function shareItemRef(platform: RegisteredPlatform, rawItemId: string): ItemRef {
  return platform === 'taobao' ? { platform, item_id: rawItemId } : itemRefOf(platform, rawItemId);
}

/**
 * B1-15z (BR-ATTR-10 素材图): the response images of a union detail: main image first, then the
 * gallery in the union's order; deduplicated before the cut, so a repeat never takes a place; at
 * most 9, addresses unchanged; [] when the detail has none. The detail is only read.
 */
export function shareImages(
  item: Pick<UnionItemDetail, 'main_image_url' | 'image_urls'>,
): ShareMaterials['images'] {
  const { main_image_url: main, image_urls: gallery = [] } = item;
  const urls = new Set(main === undefined ? gallery : [main, ...gallery]);
  return [...urls].slice(0, SHARE_IMAGES_MAX).map((url) => ({ url }));
}

/**
 * A conversion failure → share code (contract createShare): the platform refusing the conversion
 * → 30121 (not retryable); the product gone → 30141; anything else (timeout, rate limit, breaker,
 * upstream unavailable, an unexpected answer) → 50303.
 */
export function conversionRefusal(error: unknown): 30121 | 30141 | 50303 {
  if (error instanceof UnionError) {
    if (error.code === 'upstream_rejected') return 30121;
    if (error.code === 'item_unavailable') return 30141;
    return 50303;
  }
  if (error instanceof DemoUnionError && error.code === 'demo_delisted') return 30141;
  return 50303;
}

/** The Taobao adapter on its default source: there is no conversion to retry. */
function isUnimplemented(error: unknown): boolean {
  return error instanceof UnionError && error.code === 'adapter_unimplemented';
}

/**
 * What the transaction writes for a conversion; null when it carries no share link, or for Taobao
 * no promotion link or no token (BR-ATTR-10: nothing is generated).
 */
export function shareConversion(
  platform: RegisteredPlatform,
  result: ConvertResult,
): ShareConversion | null {
  if (platform === 'taobao') {
    const promotion = taobaoPromotionOf(result);
    return promotion === null || promotion.tpwd === null ? null : promotion;
  }
  const shareUrl = shareUrlOf(platform, result);
  return shareUrl === null ? null : { shareUrl, tpwd: null, promoUrl: null };
}

/** BR-INV-19 / BR-ID-26: verified and under 18 at the instant; unverified users count as adults. */
export function isIdentifiedMinor(birthDate: string | null, at: Date): boolean {
  return birthDate !== null && !isAtLeastAge(birthDate, SHARER_MIN_AGE, at);
}

/** links.link_id is a uuid column: any other source_link_id is never queried. */
const LINK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** BR-PROD-05: a raw ID is usable only when obtained ≤ 1800 s ago. */
export function isFreshRaw(obtainedAt: string, nowMs: number): boolean {
  const at = Date.parse(obtainedAt);
  return Number.isFinite(at) && nowMs - at <= RAW_ID_MAX_AGE_MS;
}

/** The links columns a step-① raw ID is read from. */
export interface LinkRawRow {
  readonly product_key: string | null;
  readonly raw_item_id: string | null;
  readonly raw_fetched_at: Date | string | null;
}

/**
 * BR-PROD-05 ①: a links row's raw ID as catalog's request reference (source 'link'); null when the
 * row is missing, has no product key or raw ID, or its raw ID is not fresh.
 */
export function linkRawRef(
  row: LinkRawRow | undefined,
  appId: string,
  platform: RegisteredPlatform,
  nowMs: number,
): RequestRawRef | null {
  if (row === undefined || row.product_key === null || row.raw_item_id === null) return null;
  const at = row.raw_fetched_at;
  if (row.raw_item_id === '' || at === null) return null;
  const fetchedAt = typeof at === 'string' ? at : at.toISOString();
  if (!isFreshRaw(fetchedAt, nowMs)) return null;
  return {
    appId,
    platform,
    productKey: row.product_key,
    rawItemId: row.raw_item_id,
    fetchedAt,
    source: 'link',
  };
}

function envelope(code: number, traceId: string, data?: unknown, msg?: string): HandlerResult {
  return {
    status: STATUS[code] ?? 500,
    envelope: {
      code,
      msg: msg ?? MESSAGES[code] ?? MESSAGES[50001]!,
      ...(data === undefined ? {} : { data }),
      trace_id: traceId,
    },
  };
}

function refused(code: number, data?: Readonly<Record<string, unknown>>): Refusal {
  return data === undefined ? { code } : { code, data };
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

class ComposedShares extends SharesService {
  readonly #options: SharesOptions;

  constructor(options: SharesOptions) {
    super();
    this.#options = options;
  }

  override async create(input: CreateShareInput): Promise<HandlerResult> {
    const { callerContext, idempotency } = this.#options;
    const caller = await callerContext.current();
    const userId = caller.userId;
    // x-auth phone: the guard already refused anyone else; a direct caller gets the same answer.
    if (userId === null) return envelope(10001, input.traceId);
    const response = await idempotency.execute(
      {
        appId: caller.appId,
        actor: { userId, deviceId: caller.deviceId, phoneHmac: null },
        method: 'POST',
        path: PATH,
        key: input.idempotencyKey,
        // The whole contract body: the same key with any other body is 20901.
        body: input.body,
        traceId: input.traceId,
      },
      () => this.#handle(caller, userId, input),
    );
    // Handler and replay alike: the stored body is the answer (a replay keeps its trace_id).
    const parsed = JSON.parse(response.body) as HandlerResult['envelope'];
    return { status: response.status, envelope: parsed };
  }

  async #handle(caller: Caller, userId: string, input: CreateShareInput): Promise<HandlerResult> {
    const { clock } = this.#options;
    const startMs = clock.now().getTime();
    const body = input.body;
    const platform: string = body.platform;
    const fail = async (refusal: Refusal, msg?: string): Promise<HandlerResult> => {
      await this.#logRefusal(caller, input, refusal.code, startMs);
      return envelope(refusal.code, input.traceId, refusal.data, msg);
    };

    if (!isRegisteredPlatform(platform)) return fail(refused(30131));

    // BR-INV-19: an identified minor is refused before anything else is judged.
    const birthDate = await this.#options.verifiedBirthDate(caller.appId, userId);
    if (isIdentifiedMinor(birthDate, clock.now())) {
      return fail(refused(30413, { reason: 'self_minor' }));
    }
    const switchValue = await this.#options.config.configValue(
      caller.appId,
      `convert.enabled.${platform}`,
    );
    if (!isSwitchOn(switchValue?.value)) {
      return fail(refused(50301, { reason: 'maintenance', platform }));
    }

    let accountId: string | undefined;
    let relation: ActiveTaobaoRelation | null = null;
    if (platform === 'taobao') {
      const refusal = await this.#taobaoAuthorization(caller, userId, input);
      if (refusal !== null) return fail(refusal);
      const enabled = await this.#options.config.configValue(caller.appId, SHARE_TAOBAO_SWITCH_KEY);
      if (!isSwitchOn(enabled?.value)) return fail(NOT_LAUNCHED, NOT_LAUNCHED_MSG);
      relation = await activeTaobaoRelation(this.#options.db, caller.appId, userId);
      if (relation === null) {
        this.#options.logger.warn(
          { event: 'linking.share.relation_unavailable', app_id: caller.appId, platform },
          'linking: active taobao binding without a usable relation_id',
        );
        return fail(refused(50301));
      }
      accountId = relation.unionAccountId;
    }

    if (platform === PDD) {
      const decided = await this.#pddAuthorization(caller, userId, input);
      if ('code' in decided) return fail(decided);
      accountId = decided.accountId;
    }

    // ⑦ before ⑧: the share identity from local reads, before any union call.
    const local = await this.#identityParts(
      caller,
      userId,
      platform,
      accountId,
      relation,
      input.traceId,
    );
    if ('code' in local) return fail(local);
    const { snapshot, parts } = local;

    const resolution = await this.#resolve(caller.appId, userId, body, platform, input.traceId);
    if ('code' in resolution) return fail(resolution);
    const target = resolution;

    let quote: ShareQuote;
    try {
      quote = await quoteShare(this.#options.quoter, target.item, {
        appId: caller.appId,
        userId,
        deviceId: caller.deviceId,
      });
    } catch (error) {
      this.#options.logger.warn(
        {
          event: 'linking.share.quote_failed',
          app_id: caller.appId,
          platform,
          error_name: errorName(error),
        },
        'linking: share quote failed; no share generated',
      );
      return fail(refused(50303));
    }

    let generated: { readonly linkId: string; readonly shareUrl: string; tpwd: string | null };
    try {
      generated = await this.#generate(caller, input, target, snapshot, parts, startMs);
    } catch (error) {
      if (error instanceof ShareAbort) return fail(error.refusal, error.msg);
      throw error;
    }

    const quotedAt = clock.now();
    quotedAt.setTime(quote.quotedAtMs);
    const copy: ShareCopy = renderShareCopy(
      {
        platform: target.platform,
        title: target.item.title,
        priceFen: target.item.price_fen,
        couponFen: target.item.coupon_fen,
        finalPriceFen: target.item.final_price_fen,
        quotedAt,
        shareUrl: generated.shareUrl,
        tpwd: generated.tpwd,
      },
      SHARE_PRICE_BASIS,
    );
    const data: ShareMaterials = {
      link_id: generated.linkId,
      share_url: generated.shareUrl,
      tpwd: generated.tpwd,
      // TODO(规划/11 §4.5): 海报出图 — blocked on TECH-13 出图 worker 与 OSS 凭据
      poster_url: null,
      images: shareImages(target.item),
      copy,
      est_promo: quote.estPromo,
      quoted_at: quote.quotedAt,
    };
    return envelope(0, input.traceId, data);
  }

  /** Taobao: the sharer's active binding, else the auth-url state as 30101 (never a link). */
  async #taobaoAuthorization(
    caller: Caller,
    userId: string,
    input: CreateShareInput,
  ): Promise<Refusal | null> {
    const { db, clock, config, appEnv, pids } = this.#options;
    const reads = createUnionAuthReads({ db, clock, config, appEnv, pids });
    const { status } = await reads.binding(caller.appId, userId, 'taobao');
    if (status === 'active') return null;
    return this.#authRefusal('taobao', input);
  }

  /**
   * Pinduoduo filing of the sharer (as the Pinduoduo open, link-open-pdd-auth.ts, for the share
   * scene): active → allowed; blocked → 30153 (banned 10001); the site authorization of the account
   * in use expired → 50301 maintenance; otherwise the union authority query with the share
   * identity — authorized → the binding written active, not filed (or no share slot) → 30111 with
   * auth_jump, the query failing → 50303. Answers the account the conversion uses.
   * B1-06zi (BR-ID-22 「授权状态按 (user_id, pid) 记录」): an authorized answer whose activation
   * leaves the binding active also records the share slot's filing (app.union_pdd_pid_filings,
   * insert-if-absent, filed_at = the clock) in the activation's transaction.
   */
  async #pddAuthorization(
    caller: Caller,
    userId: string,
    input: CreateShareInput,
  ): Promise<Refusal | { readonly accountId: string }> {
    const { db, clock, config, appEnv, pids, attrCodes, logger, registry } = this.#options;
    const appId = caller.appId;
    const reads = createUnionAuthReads({ db, clock, config, appEnv, pids });
    const { status, accountId: bound } = await reads.binding(appId, userId, PDD);
    if (status === 'blocked') {
      if (await reads.userBanned(appId, userId)) return refused(10001);
      return refused(30153);
    }
    const accountId = await reads.authAccountId(appId, PDD, bound);
    if (accountId === null || !(await reads.siteAuthAvailable(appId, PDD, accountId))) {
      return refused(50301, { reason: 'maintenance', platform: PDD });
    }
    if (status === 'active') return { accountId };

    const identity = await pddAuthorityIdentity(
      { pids, attrCodes, logger },
      {
        appId,
        userId,
        pidScene: PID_SCENE,
        unionAccountId: accountId,
        traceId: input.traceId,
        events: 'linking.share',
      },
    );
    // D10-262 / D10-263: no active share slot → not queried, not filed.
    if (identity === 'no_pid') return this.#authRefusal(PDD, input);
    if (identity === 'no_attr_code') return refused(50301);
    const authorized = await queryPddAuthority(
      { registry, logger },
      { appId, identity, traceId: input.traceId, events: 'linking.share' },
    );
    if (authorized === null) return refused(50303);
    if (!authorized) return this.#authRefusal(PDD, input);
    const values = { appId, userId, accountId, custom: JSON.stringify(identity.custom_parameters) };
    const written = await db.transaction().execute(async (trx) => {
      const decided = await activatePddBinding(trx, clock, values);
      if (decided.kind === 'active') {
        await recordPddPidFiling(trx, {
          appId,
          userId,
          pid: identity.claims.promotionSlot,
          unionAccountId: accountId,
          filedAt: clock.now(),
        });
      }
      return decided;
    });
    if (written.kind === 'blocked') return refused(30153);
    if (written.kind === 'banned') return refused(10001);
    return { accountId: written.accountId };
  }

  /**
   * 30101 (Taobao: auth_url, state, auth_methods) or 30111 (Pinduoduo: auth_jump) from the
   * auth-url service's one-time state (uid + device record, link_id empty, 10 minutes). Its own
   * refusals pass through (10001, 30153, 50301 maintenance); Taobao's site authorization being
   * unavailable is 30101 data.reason=auth_unavailable.
   */
  async #authRefusal(platform: 'taobao' | 'pdd', input: CreateShareInput): Promise<Refusal> {
    const issued = await this.#options.authUrl.get({
      platform,
      // Only logged by the service on a mismatch; the device record decides the client.
      reportedClient: input.client as AuthClient,
      traceId: input.traceId,
    });
    const answer = issued.envelope as { code: number; data?: Record<string, unknown> };
    const data = answer.data ?? {};
    if (answer.code === 0 && platform === 'taobao') {
      const { auth_url: authUrl, state, auth_methods: methods } = data;
      return refused(30101, { auth_url: authUrl, state, auth_methods: methods });
    }
    if (answer.code === 0) return refused(30111, { auth_jump: data['auth_jump'] });
    const unavailable = data['reason'] === 'auth_unavailable';
    if ((answer.code === 30101 || answer.code === 30102) && unavailable) {
      return refused(30101, { reason: 'auth_unavailable' });
    }
    return answer.data === undefined ? refused(answer.code) : refused(answer.code, answer.data);
  }

  /**
   * The new link's identity snapshot (BR-ATTR-05/06/08: the caller, scene share → pid_scene share)
   * and the conversion identity's local parts: the active share slot (Pinduoduo: of the account
   * in use), the attr_code and the jd user key mode. Any of them missing → 50301 with a warning.
   * Taobao: the slot of the binding's account is the snapshot's too, with the relation_id.
   */
  async #identityParts(
    caller: Caller,
    userId: string,
    platform: RegisteredPlatform,
    accountId: string | undefined,
    relation: ActiveTaobaoRelation | null,
    traceId: string,
  ): Promise<Refusal | { snapshot: IdentitySnapshot; parts: ShareIdentityParts }> {
    const { pids, attrCodes, config, logger } = this.#options;
    const appId = caller.appId;
    const snapshot = await resolveSnapshot({
      caller,
      attrCodes,
      pids,
      platform,
      scene: SCENE,
      agentSessionId: null,
    });
    const row: UnionPidRow | null = await pids.getActivePid({
      appId,
      platform,
      pidScene: PID_SCENE,
      purpose: 'convert',
      ...(accountId === undefined ? {} : { unionAccountId: accountId }),
    });
    if (
      row === null ||
      (accountId !== undefined && row.union_account_id !== accountId) ||
      row.status !== 'active' ||
      row.app_id !== appId ||
      row.platform !== platform ||
      row.pid_scene !== PID_SCENE ||
      row.pid === ''
    ) {
      logger.warn(
        { event: 'linking.share.no_active_pid', app_id: appId, platform, pid_scene: PID_SCENE },
        'linking: no active share promotion slot',
      );
      return refused(50301);
    }
    const attrCode = await attrCodeOf(attrCodes, appId, userId);
    if (attrCode === null || !ATTR_CODE.test(attrCode)) {
      logger.warn(
        {
          event: 'linking.share.attr_code_unavailable',
          app_id: appId,
          platform,
          trace_id: traceId,
        },
        'linking: attr_code unavailable for the share conversion',
      );
      return refused(50301);
    }
    if (platform === 'jd') {
      const mode = (await config.configValue(appId, JD_USER_KEY_MODE))?.value ?? 'sub_union_id';
      if (mode !== 'sub_union_id') {
        // TODO(规划/11 §4.5): 京东降级 private_position / claim_only — blocked on CAP-JD-05。
        logger.warn(
          { event: 'linking.share.jd_user_key_mode', app_id: appId, mode: String(mode) },
          'linking: jd user key mode not served',
        );
        return refused(50301);
      }
    }
    if (platform === 'taobao') {
      if (relation === null) return refused(50301);
      const { relationId } = relation;
      return {
        snapshot: { ...snapshot, pid: row.pid, relation_id: relationId },
        parts: { platform, promotionSlot: row.pid, attrCode, relationId },
      };
    }
    return { snapshot, parts: { platform, promotionSlot: row.pid, attrCode } };
  }

  /**
   * The product of the request (as POST /v1/links/convert by product_key): the platform's key
   * prefix, the item_ref (unusable → ignored; another product's → 20001), the raw-ID order and one
   * governed union detail (the quote snapshot, the copy's fields, est_promo's item, the images).
   * BR-PROD-05 ①: without a fresh item_ref (BR-PROD-11: it is optional — a share page opened from
   * the favorites carries only platform and product_key) the raw ID of a fresh links row of this
   * product is used (linkRawRef): the source card's link, else the sharer's latest own link of the
   * product; then ② product_refs. Only when none is fresh is the product 30143.
   */
  async #resolve(
    appId: string,
    userId: string,
    body: Body,
    platform: RegisteredPlatform,
    traceId: string,
  ): Promise<Refusal | ShareTarget> {
    const { products, itemRefs, registry } = this.#options;
    const productKey = body.product_key;
    try {
      const rows = await products.listPlatforms();
      const split = splitProductKey(
        productKey,
        rows.map((row) => ({
          platform: row.code,
          keyPrefix: row.key_prefix,
          parseEnabled: true,
          searchEnabled: true,
        })),
        platform,
      );
      if (split.platform !== platform) return refused(20001, { fields: ['product_key'] });
    } catch (error) {
      if (error instanceof ProductKeyInvalid) return refused(20001, { fields: ['product_key'] });
      if (error instanceof ProductKeyPlatformUnsupported) return refused(30131);
      throw error;
    }

    // BR-PROD-11: unusable tokens are ignored (null); a same-app token of another product is 20001.
    let token;
    try {
      token = itemRefs.verify({ itemRef: body.item_ref ?? null, appId, productKey });
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === 20001) {
        return refused(20001, { fields: ['item_ref'] });
      }
      throw error;
    }
    const nowMs = this.#options.clock.now().getTime();
    let requestRef = token;
    if (token === null || !isFreshRaw(token.fetchedAt, nowMs)) {
      const sourceLinkId = body.source_link_id;
      const linked = await this.#linkRawRef(appId, userId, platform, productKey, sourceLinkId);
      if (linked !== null) requestRef = linked;
    }

    let rawItemId: string;
    let canonical: string;
    try {
      const taken = await products.takeRawItemId({
        appId,
        platform,
        productKey,
        requestRef,
        fallbackEnabled: false,
        capabilities: CAPABILITIES,
        // TODO(规划/11 §4.5): 按 product_key 重新解析原串（BR-PROD-05 第③步）— blocked on
        // 联盟按键反查接口（CAP-TB / CAP-JD / CAP-PDD 实测）；在此之前按「引用失效」30143 处理。
        reparse: () => Promise.resolve({ kind: 'ref_expired' }),
      });
      rawItemId = taken.rawItemId;
      canonical = await products.resolveProductKey(productKey);
    } catch (error) {
      return this.#detailRefusal(error, productKey);
    }

    const ref = shareItemRef(platform, rawItemId);
    const context: CallCtx = { appId, requestId: traceId, purpose: 'online' };
    let item: UnionItemDetail;
    try {
      item = await registry.get(platform).getItem(ref, context);
    } catch (error) {
      return this.#detailRefusal(error, productKey);
    }
    if (item.platform !== platform) return refused(30143);
    // D33: a price anomaly never gets a link.
    if (isPriceAnomaly(item)) return refused(50303);
    return { platform, productKey: canonical, rawItemId, rawFetchedAt: item.quoted_at, item };
  }

  /**
   * BR-PROD-05 ① links.raw_item_id: the source card's link when the request names one of this
   * product in the app, else the caller's own most recently fetched link of the product (the card
   * the share page was opened from, or the favorites' search card). Read only; null when the row
   * is missing, not fresh (≤ 1800 s) or carries no raw ID. catalog re-checks app, platform, key and
   * freshness before using it.
   */
  async #linkRawRef(
    appId: string,
    userId: string,
    platform: RegisteredPlatform,
    productKey: string,
    sourceLinkId: string | undefined,
  ): Promise<RequestRawRef | null> {
    const nowMs = this.#options.clock.now().getTime();
    const scope = this.#options.db
      .selectFrom('links')
      .select(['product_key', 'raw_item_id', 'raw_fetched_at'])
      .where('app_id', '=', appId)
      .where('platform', '=', platform)
      .where('product_key', '=', productKey)
      .where('raw_item_id', 'is not', null)
      .where('raw_fetched_at', 'is not', null);
    if (sourceLinkId !== undefined && LINK_ID.test(sourceLinkId)) {
      const source = await scope.where('link_id', '=', sourceLinkId).executeTakeFirst();
      const ref = linkRawRef(source, appId, platform, nowMs);
      if (ref !== null) return ref;
    }
    const own = await scope
      .where('user_id', '=', userId)
      .orderBy('raw_fetched_at', 'desc')
      .limit(1)
      .executeTakeFirst();
    return linkRawRef(own, appId, platform, nowMs);
  }

  #detailRefusal(error: unknown, productKey: string): Refusal {
    const resolution = detailFailure(error, productKey);
    if (resolution.kind === 'refused') return refused(resolution.code);
    throw resolution.kind === 'fault' ? resolution.error : error;
  }

  /**
   * One transaction: the share link (the module's single links insert), its conversion with the
   * link's identity, share_materials, Taobao's promo_url and the convert log. A conversion that
   * fails, or answers no share link (Taobao: or no token), throws ShareAbort: everything rolls back.
   */
  async #generate(
    caller: Caller,
    input: CreateShareInput,
    target: ShareTarget,
    snapshot: IdentitySnapshot,
    parts: ShareIdentityParts,
    startMs: number,
  ): Promise<{ readonly linkId: string; readonly shareUrl: string; tpwd: string | null }> {
    const { db, clock, config, registry, logger } = this.#options;
    const appId = caller.appId;
    const { item } = target;
    // B1-08s: the share link gets an lk while attr.click_code.<platform> is on (read before).
    // The logger alerts an exhausted lk issuance (linking.link_code.exhausted).
    const linkCode = this.#options.linkCode;
    const codeOptions = linkCode === undefined ? { logger } : { linkCode, logger };
    const issue = await linkCodeIssue(
      config,
      { appId, platform: target.platform, userId: caller.userId },
      codeOptions,
    );
    const now = clock.now();
    const pending: PendingOpenLink = {
      now,
      caller,
      linkId: newUuidV7(now),
      snapshot,
      shopId: null,
      values: {
        platform: target.platform,
        productKey: target.productKey,
        rawItemId: target.rawItemId,
        rawFetchedAt: target.rawFetchedAt,
        scene: SCENE,
        subScene: null,
        entrySource: ENTRY_SOURCE,
        quotedFinalPriceFen: item.final_price_fen,
        quotedCouponFen: item.coupon_fen,
        quotedCouponId:
          item.coupon_ids === undefined || item.coupon_ids === '' ? null : item.coupon_ids,
        quotedAt: item.quoted_at,
        agentCardId: null,
      },
    };
    return db.transaction().execute(async (trx) => {
      const row = await insertConvertLink(trx, pending, issue);
      const identity =
        parts.platform === 'taobao'
          ? new TaobaoPromotionIdentity({ appId, ...parts })
          : shareIdentity(appId, parts, storedLinkCode(row));
      const request = {
        item: shareItemRef(parts.platform, target.rawItemId),
        idempotencyKey: input.idempotencyKey,
      };
      const context: CallCtx = { appId, requestId: input.traceId, purpose: 'online' };
      let result: ConvertResult;
      try {
        result = await registry.get(parts.platform).convert(request, identity, context);
      } catch (error) {
        const unlaunched = parts.platform === 'taobao' && isUnimplemented(error);
        const code = unlaunched ? 50301 : conversionRefusal(error);
        logger.warn(
          {
            event: 'linking.share.convert_failed',
            app_id: appId,
            platform: parts.platform,
            result_code: code,
            error_name: errorName(error),
          },
          'linking: share conversion failed; nothing generated',
        );
        if (unlaunched) throw new ShareAbort(NOT_LAUNCHED, NOT_LAUNCHED_MSG);
        throw new ShareAbort(refused(code));
      }
      const converted = shareConversion(parts.platform, result);
      if (converted === null) {
        logger.warn(
          { event: 'linking.share.no_share_url', app_id: appId, platform: parts.platform },
          'linking: share conversion answered no share link or token; nothing generated',
        );
        throw new ShareAbort(refused(50303));
      }
      await insertShareMaterial(trx, {
        appId: row.app_id,
        linkId: row.link_id,
        shareUrl: converted.shareUrl,
        tpwd: converted.tpwd,
      });
      if (converted.promoUrl !== null) {
        await writePromoUrl(trx, {
          appId: row.app_id,
          linkId: row.link_id,
          promoUrl: converted.promoUrl,
          at: clock.now(),
        });
      }
      await this.#writeLog(trx, caller, input, {
        linkId: row.link_id,
        code: 0,
        productKey: target.productKey,
        rawItemId: target.rawItemId,
        pid: snapshot.pid,
        quotedPriceFen: item.final_price_fen,
        startMs,
      });
      return { linkId: row.link_id, shareUrl: converted.shareUrl, tpwd: converted.tpwd };
    });
  }

  /** BR-ATTR-14: a refused share is logged too, with no link (nothing was generated). */
  async #logRefusal(
    caller: Caller,
    input: CreateShareInput,
    code: number,
    startMs: number,
  ): Promise<void> {
    await this.#writeLog(this.#options.db, caller, input, {
      linkId: null,
      code,
      productKey: input.body.product_key,
      rawItemId: null,
      pid: null,
      quotedPriceFen: null,
      startMs,
    });
  }

  async #writeLog(
    executor: Kysely<DB>,
    caller: Caller,
    input: CreateShareInput,
    entry: {
      readonly linkId: string | null;
      readonly code: number;
      readonly productKey: string | null;
      readonly rawItemId: string | null;
      readonly pid: string | null;
      readonly quotedPriceFen: bigint | null;
      readonly startMs: number;
    },
  ): Promise<void> {
    const now = this.#options.clock.now();
    await executor
      .insertInto('link_logs')
      .values({
        app_id: caller.appId,
        link_id: entry.linkId,
        event: 'convert',
        user_id: caller.userId,
        opener_user_id: caller.userId,
        platform: input.body.platform,
        product_key: entry.productKey,
        raw_item_id: entry.rawItemId,
        scene: SCENE,
        pid_scene: PID_SCENE,
        pid: entry.pid,
        client: input.client,
        quoted_price_fen: entry.quotedPriceFen,
        result_code: entry.code,
        latency_ms: Math.max(0, now.getTime() - entry.startMs),
        created_at: now,
      })
      .execute();
  }
}

/**
 * The conversion identity of a share (BR-ATTR-05/06/08, as the open's): the share slot, the
 * sharer's attr_code — jd subUnionId n_{attr_code}[_{lk}], pdd custom_parameters {app, uid, sc,
 * lk?} — and the share link's lk when it has one (BR-ATTR-15). Never a user_id. Taobao: the
 * sharer's relation_id instead (TaobaoPromotionIdentity).
 */
export function shareIdentity(
  appId: string,
  parts: JdPddShareParts,
  lk: string | null,
): LinkingUnionIdentity {
  const { platform, promotionSlot, attrCode } = parts;
  return platform === 'jd'
    ? new LinkingUnionIdentity({
        appId,
        platform,
        promotionSlot,
        userKey: attrCode,
        subUnionId: lk === null ? `n_${attrCode}` : `n_${attrCode}_${lk}`,
      })
    : new LinkingUnionIdentity({
        appId,
        platform,
        promotionSlot,
        userKey: attrCode,
        customParameters:
          lk === null
            ? { app: 'n', uid: attrCode, sc: PID_SCENE }
            : { app: 'n', uid: attrCode, sc: PID_SCENE, lk },
      });
}

export function createShares(options: SharesOptions): SharesService {
  return new ComposedShares(options);
}
