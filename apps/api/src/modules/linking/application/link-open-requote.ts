// B1-06k: linking open, second stage — the price re-check (BR-PRICE-12/13/14/20, D33), the open
// link_logs event (BR-ATTR-14) and the open attempt (link_open_attempts, BR-ATTR-21 ①). An
// application-stage boundary, not an HTTP response: amounts keep B1-06d's lossless decimal-string
// representation; the later HTTP adapter owns wire serialization.
// Flow per request: CallerContext → platform idempotency (same key → the first result, nothing
// re-run) → B1-06d owner stage → single flight of the opened link_id (3000 ms from the first
// arrival, inclusive: the price conclusion, errors included, is shared; the card is shared per
// opener; the conversion per identity key) → link_logs (every open, failures too) and, on
// success, link_open_attempts in the same transaction.
// - old is always the opened card's quoted_final_price_fen; amount_unknown only converts.
// - new comes from prices.fetch, assembled through catalog's active_query entry (the quote is
//   catalog's); link.open.requote_after_sec > 0 lets a snapshot younger than N seconds (by its
//   original quoted_at) stand as new, without rebate amounts (no fresh quote exists then).
// - a changed snapshot (final price, coupon amount or coupon IDs, D33) answers with the card's
//   link. Inside the re-check catalog's registrar (B1-06c) only reserves it with the opened
//   link's identity snapshot and scene (a share link keeps the sharer, BR-PRICE-12 2026-10-07);
//   the row is written in the open's transaction with the log and attempt, and never when the
//   snapshot is unchanged or the conversion fails. A share link opened by anyone but the sharer
//   shows no rebate (BR-ATTR-10). B1-08s: the row is written right after its conversion; the
//   answered jump carries exactly the lk the row was stored with (converted again otherwise).
// - off-shelf 30141 > coupon_gone > price_changed; taolijin claimed out 30602; anomalies,
//   price_unavailable, fetch or assembly failures → the requote-failed branch: the identity's
//   conversion cache (≤ link.convert_cache_ttl_sec, at most 900 s) with requote_failed, else 50303.
//   A failed conversion after a good price is 50303 too.
// B1-06p: an explicit no_rebate open (BR-PRICE-13 2026-10-08) does not need the re-check: on its
//   failure it still converts without attribution (or jumps to the unpromoted page), with
//   requote_failed=true, no rebate and no snapshot; 50303 only when no page can be built. The
//   owner stage registers no link for such an open (link-open-owner.ts), so it commits none.
// - conversion and its cache are ports; the cache key is the frozen identity's owner (never the
//   opener or links.user_id), app, platform, product, pid, pid_scene and no_rebate.
// B1-06e: the conversion port may admit first (convert.enabled.<platform> → 50301 before any
// cache or price work), names the jump-plan variant (client × installed) that keys and guards the
// cache, and fails with 50301 (paused) or 50303 (with the unpromoted page used only by an explicit
// no_rebate purchase). A cached jump past its jump.expire_at is never reused. A share link opened
// by anyone but the sharer ignores no_rebate (BR-ATTR-05 ①); no_rebate never renews the snapshot.
// B1-06m: one database transaction per open (platform idempotency executeInTransaction): the
// owner stage's claim or new link, the renewed link, the open log and the attempt commit with the
// key's completed record, or not at all. A result the key does not store (not 0 and not 3xxxx,
// e.g. 50303) rolls that transaction back and its open log is written after it, on its own. In a
// flight window the requote-failed branch looks the identity's cache up once, so a first 50303 is
// not turned into a cached jump by a later open; a shared conversion past its jump.expire_at is
// converted again. The idempotent request body is the whole contract body (installed, no_rebate,
// no_rebate_reason, spm).
// The transaction never takes a second pooled connection: settings, active pids and attr_codes
// are read before it (link-open-reads.ts); the log of a rolled-back result is wholly the opened
// link's as committed (its identity, pid and expiry), the opener in opener_user_id.
// B1-06f: authorization stays out of this core. A conversion port may decide it (authorize, after
// admit and before any cache or price work, inside the open's transaction); a refusal (30101 /
// 30102 / 30153) is stored and logged like any 3xxxx result and carries the port's error data.
// B1-06v: the Pinduoduo filing check (link-open-pdd-auth.ts) refuses with 30111 (stored, data
// auth_jump or reason), 50301 (data reason=maintenance when the site authorization this open
// depends on has expired) or 50303 (its authority query failed); the last two are not stored, roll
// the open back and still carry their error data.
import type { components, Scene } from '@couli/contracts-ts';
import { scene as SCENES } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Kysely, Selectable, Transaction } from 'kysely';
import type { AssembleCardInput, CatalogCardEntry } from '../../catalog/index.ts';
import { newUuidV7, type Idempotency, type HandlerResult } from '../../platform/index.ts';
import {
  CONVERT_CACHE_TTL_SEC,
  DEFAULT_PRICE_CHANGE_MIN_FEN,
  DEFAULT_PRICE_CHANGE_RATIO_BP,
  DEFAULT_REQUOTE_AFTER_SEC,
  LinkingError,
  MAX_CONVERT_CACHE_TTL_SEC,
  PDD_PRECHECK_SWITCH,
  PRICE_CHANGE_MIN_FEN,
  PRICE_CHANGE_RATIO_BP,
  REQUOTE_AFTER_SEC,
  SINGLE_FLIGHT_MS,
  couponGone,
  pidSceneOf,
  couponIdsOf,
  decideOpenOwner,
  intSetting,
  isSwitchOn,
  priceChanged,
  quoteSnapshotChanged,
} from '../domain/rules.ts';
import { hasUnresolvedBindingConflict } from '../infra/binding-conflicts.ts';
import { storedLinkCode } from '../infra/link-code.ts';
import type { Caller } from '../ports.ts';
import type { Platform, UnionItem } from '../../union/index.ts';
import { pausedDataOf } from './convert-paused.ts';
import {
  attrCodeOf,
  clickCodeKey,
  clickCodeOn,
  insertConvertLink,
  drawFreeLinkCode,
  insertPendingOpenLink,
  linkCodeIssue,
  type DrawnLinkCode,
  type LinkCodeIssue,
  resolveSnapshot,
  openRegistrationScope,
  type IdentitySnapshot,
  type OpenRegistrationScope,
  type PendingOpenLink,
} from './link-registration.ts';
import {
  createLinkOpenOwner,
  noRebateApplies,
  readSnapshot,
  type LinkOpenOwnerOptions,
  type LinkOpenOwnerResult,
} from './link-open-owner.ts';
import {
  openScopedAttrCodes,
  openScopedConfig,
  openScopedPids,
  withOpenReads,
  type LinkOpenReadIdentity,
  type LinkOpenReadPlan,
} from './link-open-reads.ts';

export type LinkOpenJump = components['schemas']['JumpPlan'];

/** Only normalized catalog input, never fabricated platform payloads. */
export type LinkOpenPrice =
  | { readonly kind: 'off_shelf' }
  | { readonly kind: 'tlj_empty' }
  | { readonly kind: 'available'; readonly input: AssembleCardInput };

export interface LinkOpenCacheKey {
  readonly appId: string;
  /** The frozen identity's owner, not necessarily the opener or links.user_id. */
  readonly userId: string | null;
  readonly platform: string;
  readonly productKey: string | null;
  readonly rawItemId: string | null;
  readonly pid: string | null;
  readonly pidScene: string;
  readonly noRebate: boolean;
  /** The jump-plan variant (client × installed) when the conversion port names one. */
  readonly variant?: string;
  /**
   * B1-08s: the lk the conversion injects (BR-ATTR-15); absent — not even undefined — when none is
   * injected, so such a key is exactly the key before lk existed.
   */
  readonly linkCode?: string;
}

export interface LinkOpenCachedJump {
  readonly jump: LinkOpenJump;
  readonly fetchedAt: string;
  /** The jump-plan variant the jump was built for; a mismatch is a miss. */
  readonly variant?: string;
  /**
   * B1-06f: the conversion port's cache tag when the jump was built (LinkOpenConversionPort
   * cacheTag); a mismatch is a miss and the entry is rebuilt. The key itself is unchanged.
   */
  readonly tag?: string;
}

export interface LinkOpenConversionInput {
  readonly owner: LinkOpenOwnerResult;
  /** The latest re-check item of this flight, when one was fetched (BR-PRICE-08 page source). */
  readonly item?: AssembleCardInput['item'];
  readonly noRebate: boolean;
  readonly installed: components['schemas']['OpenLinkRequest']['installed'];
  readonly client: LinkOpenRequoteInput['client'];
  readonly idempotencyKey: string;
  readonly traceId: string;
  /**
   * B1-08s (BR-ATTR-15): the lk of the link this conversion answers for when that is not
   * owner.link — an open's renewed snapshot (null: the new link has none). Absent: owner.link's lk.
   */
  readonly linkCode?: string | null;
  /**
   * B1-19d (BR-ATTR-07, BR-ID-17): the union account this open's authorization settled on (set
   * by the Pinduoduo composition); the conversion then reads only that account's active slot.
   * Absent: the scene's slot app-wide, as before. The re-check core never sets or reads it.
   */
  readonly unionAccountId?: string;
}

/** no_rebate_reason values only the server decides (contracts/enums/trade.yaml). */
export type LinkOpenServerNoRebateReason = 'binding_blocked' | 'relation_conflict';

/** B1-06f: a conversion port's authorization of one open (see LinkOpenConversionPort.authorize). */
export type LinkOpenAuthorization =
  | {
      readonly kind: 'allowed';
      /** Overrides the client's no_rebate_reason in the open log (BR-ID-18). */
      readonly noRebateReason?: LinkOpenServerNoRebateReason;
    }
  | {
      readonly kind: 'refused';
      /** 10001: the state cannot be bound to the caller's user and device (rolled back). */
      readonly code: 10001 | 30101 | 30102 | 30111 | 30153 | 50301 | 50303;
      /** The error envelope's data (contracts/error-codes.yaml); absent when it defines none. */
      readonly data?: Readonly<Record<string, unknown>>;
      /**
       * B1-06z: present when the refusal still lies on the server's no-rebate path (a blocked
       * user's no_rebate purchase): the failure log carries the server's reason, not the client's.
       */
      readonly noRebateReason?: LinkOpenServerNoRebateReason;
    };

export interface LinkOpenAuthorizationInput {
  readonly caller: Caller;
  readonly owner: LinkOpenOwnerResult;
  /** The effective no_rebate (BR-ATTR-05 ①: ignored on another user's share link). */
  readonly noRebate: boolean;
  readonly client: LinkOpenRequoteInput['client'];
  /** B1-06v: the request's installed (default unknown), for an authorization jump plan. */
  readonly installed: components['schemas']['InstalledState'];
  /** B1-06v: the request's trace id (the request id of an upstream query). */
  readonly traceId: string;
  /** The open's transaction: a state issued here commits or rolls back with the open. */
  readonly executor: Kysely<DB>;
}

/** The conversion port: convert, plus the optional admission and plan variant (B1-06e). */
export interface LinkOpenConversionPort {
  convert(input: LinkOpenConversionInput): Promise<LinkOpenJump>;
  /** The client is passed so an admission may depend on it (B1-06w: prod verified paths). */
  admit?(owner: LinkOpenOwnerResult, client: LinkOpenConversionInput['client']): Promise<void>;
  variant?(input: Pick<LinkOpenConversionInput, 'client' | 'installed'>): string;
  /**
   * B1-06m: pre-reads what admit and convert may read, before the open's transaction (no read
   * inside it may take a second pooled connection; link-open-reads.ts).
   */
  prepare?(plan: LinkOpenReadPlan): Promise<void>;
  /**
   * B1-06f: the platform authorization of this open, after admit and before any cache or price
   * work. It may throw a paused (50301) failure like admit. Absent: every open is allowed.
   */
  authorize?(input: LinkOpenAuthorizationInput): Promise<LinkOpenAuthorization>;
  /**
   * B1-06f: what a cached jump of this open must have been built with, read after authorize
   * (Taobao: the snapshot user's active relation_id, BR-ID-17 — never a jump of an earlier
   * binding). Stored with the entry and compared on read; absent or undefined: no tag.
   */
  cacheTag?(owner: LinkOpenOwnerResult, noRebate: boolean): string | undefined;
}

export interface LinkOpenRequoteOptions extends LinkOpenOwnerOptions {
  readonly catalog: CatalogCardEntry;
  readonly prices: { fetch(owner: LinkOpenOwnerResult): Promise<LinkOpenPrice> };
  readonly conversion: LinkOpenConversionPort;
  readonly cache: {
    get(key: LinkOpenCacheKey): Promise<LinkOpenCachedJump | null>;
    put(key: LinkOpenCacheKey, value: LinkOpenCachedJump): Promise<void>;
  };
  readonly idempotency: Pick<Idempotency, 'executeInTransaction'>;
  /**
   * B1-06w: the single-flight windows shared by every service built with it. The composition
   * root builds one per process (the service itself is built per request); omitted, the service
   * keeps its own.
   */
  readonly flights?: LinkOpenFlights;
  // TODO(规划/11 §4.5): 拼多多比价预判开关打开的分支 — blocked on CAP-PDD-04。
  // B1-06m: catalog, prices, conversion and cache are called while the open holds its transaction
  // connection; their implementations must not take another pooled database connection then.
}

/** Opaque process-wide single-flight state (B1-06w); see LinkOpenRequoteOptions.flights. */
export interface LinkOpenFlights {
  readonly windows: Map<string, unknown>;
}

export function createLinkOpenFlights(): LinkOpenFlights {
  return { windows: new Map() };
}

export interface LinkOpenRequoteInput {
  readonly linkId: string;
  readonly idempotencyKey: string;
  readonly traceId: string;
  /** Server-resolved client; not copied from an untrusted body. */
  readonly client: 'ios' | 'android' | 'harmony' | 'h5' | 'web';
  readonly installed?: components['schemas']['OpenLinkRequest']['installed'];
  readonly noRebate?: boolean;
  /** BR-ID-18: only meaningful with no_rebate=true; default auth_declined. */
  readonly noRebateReason?: components['schemas']['OpenLinkRequest']['no_rebate_reason'];
  /** The tapped button's page.module.slot (03 §4.7); only part of the idempotent request body. */
  readonly spm?: string;
}

/**
 * The idempotent request body of an open: every contract field of the request, defaults applied,
 * so the same key with any other body answers 20901.
 */
export function openRequestBody(input: LinkOpenRequoteInput): Record<string, string | boolean> {
  return {
    installed: input.installed ?? 'unknown',
    no_rebate: input.noRebate === true,
    ...(input.noRebateReason === undefined ? {} : { no_rebate_reason: input.noRebateReason }),
    ...(input.spm === undefined ? {} : { spm: input.spm }),
  };
}

/** A conversion result is reusable only before its jump.expire_at (BR-ATTR-05 ②). */
export function jumpUsable(jump: LinkOpenJump, nowMs: number): boolean {
  const expireMs = Date.parse(jump.expire_at);
  return Number.isFinite(expireMs) && nowMs < expireMs;
}

export type LinkOpenRequoteResult = Omit<
  components['schemas']['OpenLinkResult'],
  'old_final_price_fen' | 'new_final_price_fen' | 'new_rebate_min_fen' | 'new_rebate_max_fen'
> & {
  readonly old_final_price_fen: string | null;
  readonly new_final_price_fen: string | null;
  readonly new_rebate_min_fen: string | null;
  readonly new_rebate_max_fen: string | null;
};

export type LinkOpenRequoteOutcome =
  | { readonly code: 0; readonly data: LinkOpenRequoteResult }
  | {
      readonly code: number;
      readonly data: null;
      /** B1-06f: the error envelope's data of an authorization refusal, when it defines one. */
      readonly error?: Readonly<Record<string, unknown>>;
    };

/** Codes whose error envelope carries data from the open (contracts/error-codes.yaml). */
const ERROR_DATA_CODES: ReadonlySet<number> = new Set([30101, 30102, 30111, 30153, 50301]);

export interface LinkOpenRequoteService {
  open(input: LinkOpenRequoteInput): Promise<LinkOpenRequoteOutcome>;
}

/**
 * B1-06i: what POST /v1/links/convert registers, resolved before the transaction (item_ref or
 * product_refs and one union detail, or the by-URL parse). Never carries the item_ref itself.
 */
export interface LinkConvertTarget {
  readonly platform: Platform;
  readonly productKey: string;
  readonly rawItemId: string;
  /** The union response's quote instant of rawItemId (BR-PROD-05 raw_fetched_at). */
  readonly rawFetchedAt: string;
  /** The quote snapshot the new link freezes (BR-PRICE-12). */
  readonly item: UnionItem;
  readonly shopId: string | null;
  /** BR-PRICE-07 来源判定表: the entry the product came from. */
  readonly entrySource: string;
}

/** The convert's resolution: a target, a refusal before registration, or an unexpected fault. */
export type LinkConvertResolution =
  | { readonly kind: 'target'; readonly target: LinkConvertTarget }
  | {
      readonly kind: 'refused';
      readonly code: number;
      readonly data?: Readonly<Record<string, unknown>>;
      /** The requested product key, when one was given (for the failure log). */
      readonly productKey: string | null;
    }
  | { readonly kind: 'fault'; readonly error: unknown };

export interface LinkConvertRequoteInput {
  /** The request's platform, for the log of a refusal before registration. */
  readonly platform: string;
  readonly idempotencyKey: string;
  readonly traceId: string;
  readonly client: LinkOpenRequoteInput['client'];
  readonly installed: components['schemas']['InstalledState'];
  readonly spm?: string;
  /** The idempotent request body: the whole contract body, defaults applied. */
  readonly body: Readonly<Record<string, unknown>>;
  /**
   * Called once per request before the transaction, after the login check (no database
   * connection is held then). Never rejects: a fault is returned and rethrown inside the handler,
   * so a replayed key still answers its stored result.
   */
  resolve(caller: Caller): Promise<LinkConvertResolution>;
}

export type LinkConvertRequoteOutcome = (
  | {
      readonly code: 0;
      readonly data: LinkOpenRequoteResult & { readonly link_id: string };
    }
  | {
      readonly code: number;
      readonly data: null;
      readonly error?: Readonly<Record<string, unknown>>;
    }
) & {
  /** The answered envelope's trace_id: a replay keeps the first request's (stored as it was). */
  readonly traceId?: string;
};

/** B1-06i: the open core with the convert entry (link-convert.ts). */
export interface LinkOpenConvertingService extends LinkOpenRequoteService {
  convert(input: LinkConvertRequoteInput): Promise<LinkConvertRequoteOutcome>;
}

type LinkRow = Selectable<DB['links']>;
type Availability = components['schemas']['Availability'];

/** The re-check's price conclusion, shared by every open of the link inside the flight window. */
type PriceConclusion =
  | { readonly kind: 'off_shelf' }
  | { readonly kind: 'tlj_empty' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'fresh' }
  | { readonly kind: 'available'; readonly input: AssembleCardInput };

/** The re-quoted card of one opener: amounts from the item, rebates and link from catalog. */
type CardConclusion =
  | { readonly kind: 'failed' }
  | {
      readonly kind: 'card';
      readonly finalFen: bigint;
      readonly couponFen: bigint;
      readonly couponIds: string | null;
      readonly rebateMinFen: string | null;
      readonly rebateMaxFen: string | null;
      readonly linkId: string;
      /**
       * The renewed snapshot's link. Every open answering with it writes it in its own transaction
       * if absent, so no open refers to a link another open rolled back.
       */
      readonly pending: PendingOpenLink | null;
      readonly quotedAt: string;
    };

type Converted =
  | { readonly kind: 'ok'; readonly jump: LinkOpenJump; readonly cacheHit: boolean }
  | { readonly kind: 'failed'; readonly code: number; readonly noRebateUrl: string | null };

/** A failed conversion's code: 50301 when the port paused it, otherwise 50303. */
function conversionFailure(error: unknown): Extract<Converted, { kind: 'failed' }> {
  const code = (error as { code?: unknown } | null)?.code;
  const url = (error as { noRebateUrl?: unknown } | null)?.noRebateUrl;
  return {
    kind: 'failed',
    code: code === 50301 ? 50301 : 50303,
    noRebateUrl: code === 50303 && typeof url === 'string' && url !== '' ? url : null,
  };
}

interface Flight {
  readonly arrivedAtMs: number;
  /** Started by the first priced open of the window (amount_unknown never fetches). */
  price: Promise<PriceConclusion> | null;
  readonly cards: Map<string, Promise<CardConclusion>>;
  readonly conversions: Map<string, Promise<Converted>>;
  /** The requote-failed branch's cache lookup per identity key: one answer per window. */
  readonly fallbacks: Map<string, Promise<LinkOpenJump | null>>;
}

interface Settled {
  readonly code: number;
  /**
   * The link the log and attempt are written for. A renewed snapshot's link is already written
   * in the open's transaction (B1-08s: before the answer, so its jump carries the stored lk).
   */
  readonly linkId: string;
  readonly quotedPriceFen: bigint | null;
  readonly cacheHit: boolean;
  readonly data: Omit<LinkOpenRequoteResult, 'attempt_id'> | null;
  /** B1-06f: the refusal's error data (authorization). */
  readonly error?: Readonly<Record<string, unknown>>;
  /** B1-06f: the server's no_rebate_reason, overriding the client's in the log. */
  readonly noRebateReason?: LinkOpenServerNoRebateReason;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MESSAGES: Readonly<Record<number, string>> = {
  0: 'ok',
  50301: 'convert_paused',
  30101: 'auth_required',
  30102: 'auth_invalid',
  30111: 'auth_required',
  30153: 'binding_blocked',
  30131: 'unsupported',
  30141: 'off_shelf',
  30143: 'ref_expired',
  30602: 'tlj_claimed_out',
  50303: 'requote_failed',
};

/** HTTP status per contracts/error-codes.yaml for every code an open can answer. */
const STATUS: Readonly<Record<number, number>> = {
  0: 200,
  10001: 401,
  20001: 400,
  20901: 409,
  20903: 409,
  30101: 422,
  30102: 422,
  30111: 422,
  30131: 422,
  30141: 422,
  30143: 422,
  30144: 404,
  30153: 422,
  30602: 422,
  40901: 409,
  50001: 500,
  50301: 503,
  50303: 503,
};

function fenString(value: number | null): string | null {
  return value === null ? null : BigInt(value).toString();
}

/** The re-check's quote instant as the union item gives it (catalog already validated it). */
function instantOf(value: string): string {
  if (!Number.isFinite(Date.parse(value))) {
    throw new TypeError('linking: re-check quoted_at is not an instant');
  }
  return value;
}

/** The stored scene of the opened link (B1-06d already checked it against the enum). */
function storedSceneOf(link: LinkRow): Scene {
  if (!(SCENES as readonly string[]).includes(link.scene)) {
    throw new TypeError('linking: stored link scene is outside the contract enum');
  }
  return link.scene as Scene;
}

/**
 * BR-ATTR-05 ① / BR-ATTR-10: a share link opened by anyone but the sharer converts with the
 * sharer's identity and the buyer earns nothing from it, so the opener's quote is not shown.
 */
function rebatesShown(
  caller: Caller,
  owner: LinkOpenOwnerResult,
  min: string | null,
  max: string | null,
): { readonly min: string | null; readonly max: string | null } {
  const { identitySnapshot } = owner;
  const sharedByOther =
    identitySnapshot.pid_scene === 'share' && identitySnapshot.user_id !== caller.userId;
  return sharedByOther ? { min: '0', max: '0' } : { min, max };
}

/** BR-ATTR-05 ①: a share link opened by anyone but the sharer keeps the sharer's attribution. */
function effectiveNoRebate(caller: Caller, owner: LinkOpenOwnerResult, requested?: boolean) {
  const { identitySnapshot } = owner;
  const sharedByOther =
    identitySnapshot.pid_scene === 'share' && identitySnapshot.user_id !== caller.userId;
  return requested === true && !sharedByOther;
}

/**
 * B1-08s: the lk pre-drawn for each pending renewed link (shared by the opens of one flight);
 * null when the link gets none.
 */
const PENDING_LINK_CODES = new WeakMap<PendingOpenLink, Promise<DrawnLinkCode | null>>();

function openerKey(caller: Caller): string {
  return caller.userId !== null ? `u:${caller.userId}` : `d:${caller.deviceId ?? ''}`;
}

export function createLinkOpenRequote(options: LinkOpenRequoteOptions): LinkOpenConvertingService {
  const { db, clock, callerContext, catalog, prices, conversion, cache, idempotency } = options;
  // B1-06m: inside the open's transaction these readers answer only from the pre-reads.
  const config = openScopedConfig(options.config);
  const pids = openScopedPids(options.pids);
  const attrCodes = openScopedAttrCodes(options.attrCodes);
  const owners = createLinkOpenOwner({
    ...options,
    config,
    pids,
    ...(attrCodes === undefined ? {} : { attrCodes }),
  });
  const flights = (options.flights ?? createLinkOpenFlights()).windows as Map<string, Flight>;

  async function setting(appId: string, key: string, fallback: number): Promise<number> {
    const value = await config.configValue(appId, key);
    return intSetting(value?.value, fallback);
  }

  function variantOf(input: LinkOpenRequoteInput): string | undefined {
    return conversion.variant?.({ client: input.client, installed: input.installed ?? 'unknown' });
  }

  /**
   * B1-08s: the lk this open's conversion injects — as link-open-conversion.ts decides it: jd /
   * pdd, not no_rebate (input.noRebate is already effective here), the link's stored lk, and
   * attr.click_code.<platform> JSON true (pre-read before the transaction). Null otherwise.
   */
  async function linkCodeOf(
    owner: LinkOpenOwnerResult,
    input: LinkOpenRequoteInput,
    renewedCode: string | null | undefined,
  ): Promise<string | null> {
    const { link } = owner;
    const platform = link.platform;
    const lk = renewedCode !== undefined ? renewedCode : storedLinkCode(link);
    if (input.noRebate === true || lk === null) return null;
    if (platform !== 'jd' && platform !== 'pdd') return null;
    const value = await config.configValue(link.app_id, clickCodeKey(platform));
    return clickCodeOn(value?.value) ? lk : null;
  }

  /** B1-08s: how a renewed snapshot's link draws its lk; null when it gets none. */
  function pendingIssue(pending: PendingOpenLink): Promise<LinkCodeIssue | null> {
    return linkCodeIssue(
      config,
      {
        appId: pending.caller.appId,
        platform: pending.values.platform,
        userId: pending.snapshot.user_id,
      },
      options,
    );
  }

  /**
   * B1-08s: the lk a renewed snapshot's link is converted with first, drawn (and checked free)
   * once per pending link however many opens of the flight answer with it (they share the card).
   * Only a candidate: writeRenewedLink settles the stored code and the jump follows it.
   */
  function renewedLinkCode(
    pending: PendingOpenLink,
    executor: Kysely<DB>,
  ): Promise<DrawnLinkCode | null> {
    let code = PENDING_LINK_CODES.get(pending);
    if (code === undefined) {
      code = pendingIssue(pending).then((issue) =>
        issue === null
          ? null
          : drawFreeLinkCode(
              executor,
              { appId: pending.caller.appId, platform: pending.values.platform },
              issue,
            ),
      );
      PENDING_LINK_CODES.set(pending, code);
    }
    return code;
  }

  /**
   * B1-08s (BR-ATTR-15): writes an open's renewed link in the open's transaction, its lk settled
   * by the (app_id, lk) unique key — the pre-drawn code, a redraw after a collision since (another
   * link took it between the draw and this insert), NULL after 4 (alerted), or the code an earlier
   * open of the flight wrote the link with — and answers with a jump whose code is exactly that
   * lk: when it is not the code `converted` carries, the open converts again with the stored one
   * (its own cache key); a failure of that conversion fails the open (nothing is committed). A
   * jump carrying any other code is never answered.
   */
  async function writeRenewedLink(
    flight: Flight,
    owner: LinkOpenOwnerResult,
    input: LinkOpenRequoteInput,
    item: AssembleCardInput['item'],
    pending: PendingOpenLink,
    drawn: DrawnLinkCode | null,
    converted: Extract<Converted, { kind: 'ok' }>,
    executor: Kysely<DB>,
  ): Promise<Converted> {
    const issue = drawn === null ? null : await pendingIssue(pending);
    const written = await insertPendingOpenLink(executor, pending, issue, drawn ?? undefined);
    const carried = await linkCodeOf(owner, input, drawn?.code ?? null);
    const stored = await linkCodeOf(owner, input, written.lk);
    if (stored === carried) return converted;
    return sharedConversion(flight, owner, input, item, written.lk);
  }

  async function cacheKeyOf(
    owner: LinkOpenOwnerResult,
    input: LinkOpenRequoteInput,
    renewedCode?: string | null,
  ): Promise<LinkOpenCacheKey> {
    const { link, identitySnapshot } = owner;
    const noRebate = input.noRebate === true;
    const variant = variantOf(input);
    const linkCode = await linkCodeOf(owner, input, renewedCode);
    return {
      appId: link.app_id,
      userId: identitySnapshot.user_id,
      platform: link.platform,
      productKey: link.product_key,
      rawItemId: link.raw_item_id,
      pid: identitySnapshot.pid,
      pidScene: identitySnapshot.pid_scene,
      noRebate,
      ...(variant === undefined ? {} : { variant }),
      ...(linkCode === null ? {} : { linkCode }),
    };
  }

  function cacheTagOf(owner: LinkOpenOwnerResult, input: LinkOpenRequoteInput): string | undefined {
    return conversion.cacheTag?.(owner, input.noRebate === true);
  }

  /** The in-flight name of one cache identity and tag (a changed tag never shares a jump). */
  function flightName(key: LinkOpenCacheKey, tag: string | undefined): string {
    return JSON.stringify(tag === undefined ? key : { ...key, tag });
  }

  /**
   * A cached jump of exactly this identity, plan variant and port tag, no older than the
   * configured TTL (≤ 900 s) and still before its jump.expire_at (BR-ATTR-05 ②: the URL's usable
   * period).
   */
  async function cached(
    appId: string,
    key: LinkOpenCacheKey,
    tag: string | undefined,
  ): Promise<LinkOpenJump | null> {
    const ttlSec = Math.min(
      await setting(appId, CONVERT_CACHE_TTL_SEC, MAX_CONVERT_CACHE_TTL_SEC),
      MAX_CONVERT_CACHE_TTL_SEC,
    );
    const entry = await cache.get(key);
    if (entry === null) return null;
    const fetchedMs = Date.parse(entry.fetchedAt);
    if (!Number.isFinite(fetchedMs)) return null;
    if ((entry.variant ?? undefined) !== key.variant) return null;
    if ((entry.tag ?? undefined) !== tag) return null;
    const nowMs = clock.now().getTime();
    const expireMs = Date.parse(entry.jump.expire_at);
    if (!Number.isFinite(expireMs) || nowMs >= expireMs) return null;
    const age = nowMs - fetchedMs;
    return age >= 0 && age <= ttlSec * 1000 ? entry.jump : null;
  }

  /** Cache first, else a real-time conversion that refreshes the cache; null when it failed. */
  async function convertFor(
    owner: LinkOpenOwnerResult,
    input: LinkOpenRequoteInput,
    item: AssembleCardInput['item'] | undefined,
    renewedCode?: string | null,
  ): Promise<Converted> {
    const noRebate = input.noRebate === true;
    const key = await cacheKeyOf(owner, input, renewedCode);
    const tag = cacheTagOf(owner, input);
    const hit = await cached(owner.link.app_id, key, tag);
    if (hit !== null) return { kind: 'ok', jump: hit, cacheHit: true };
    let jump: LinkOpenJump;
    try {
      jump = await conversion.convert({
        owner,
        ...(item === undefined ? {} : { item }),
        noRebate,
        installed: input.installed ?? 'unknown',
        client: input.client,
        idempotencyKey: input.idempotencyKey,
        traceId: input.traceId,
        ...(renewedCode === undefined ? {} : { linkCode: renewedCode }),
      });
    } catch (error) {
      return conversionFailure(error);
    }
    const variant = key.variant;
    await cache.put(key, {
      jump,
      fetchedAt: clock.now().toISOString(),
      ...(variant === undefined ? {} : { variant }),
      ...(tag === undefined ? {} : { tag }),
    });
    return { kind: 'ok', jump, cacheHit: false };
  }

  /** BR-PRICE-20 and the fetch: one conclusion per flight, failures folded into 'failed'. */
  async function concludePrice(owner: LinkOpenOwnerResult): Promise<PriceConclusion> {
    const after = await setting(owner.link.app_id, REQUOTE_AFTER_SEC, DEFAULT_REQUOTE_AFTER_SEC);
    const quotedAt = owner.link.quoted_at;
    if (after > 0 && quotedAt !== null) {
      const age = clock.now().getTime() - quotedAt.getTime();
      if (age >= 0 && age <= after * 1000) return { kind: 'fresh' };
    }
    let price: LinkOpenPrice;
    try {
      price = await prices.fetch(owner);
    } catch {
      return { kind: 'failed' };
    }
    if (price.kind === 'available') return { kind: 'available', input: price.input };
    return price;
  }

  /** catalog's active-query entry: anomalies and assembly failures fail closed. */
  async function concludeCard(
    owner: LinkOpenOwnerResult,
    input: AssembleCardInput,
  ): Promise<CardConclusion> {
    // TODO(规划/11 §4.5): 拼多多比价预判开关打开的分支（以本次转链身份取预判，结果只对本次点击有效，
    // no_rebate 与他人打开分享链接不取） — blocked on CAP-PDD-04。开关打开时暂按关闭处理。
    if (owner.link.platform === 'pdd') {
      const precheck = await config.configValue(owner.link.app_id, PDD_PRECHECK_SWITCH);
      void isSwitchOn(precheck?.value);
    }
    const { link, identitySnapshot } = owner;
    const scope: OpenRegistrationScope = {
      owner: { appId: link.app_id, userId: identitySnapshot.user_id, deviceId: link.device_id },
      snapshot: identitySnapshot,
      scene: storedSceneOf(link),
      subScene: link.sub_scene,
      agentCardId: link.agent_card_id,
      pending: null,
    };
    let result;
    try {
      result = await openRegistrationScope.run(scope, () =>
        catalog.assemble({
          ...input,
          entrySource: link.entry_source,
          scene: 'active_query',
        }),
      );
    } catch {
      return { kind: 'failed' };
    }
    if (result.kind !== 'card') return { kind: 'failed' };
    const pending = scope.pending?.linkId === result.card.link_id ? scope.pending : null;
    const { item } = input;
    return {
      kind: 'card',
      finalFen: item.final_price_fen,
      couponFen: item.coupon_fen,
      couponIds: couponIdsOf(item.coupon_ids),
      rebateMinFen: fenString(result.card.rebate_min_fen),
      rebateMaxFen: fenString(result.card.rebate_max_fen),
      linkId: result.card.link_id,
      pending,
      quotedAt: instantOf(item.quoted_at),
    };
  }

  function flightFor(owner: LinkOpenOwnerResult, linkId: string, nowMs: number): Flight {
    for (const [key, flight] of flights) {
      if (nowMs - flight.arrivedAtMs > SINGLE_FLIGHT_MS) flights.delete(key);
    }
    const key = `${owner.link.app_id}\u0000${linkId}`;
    const current = flights.get(key);
    if (current !== undefined && nowMs - current.arrivedAtMs <= SINGLE_FLIGHT_MS) return current;
    const flight: Flight = {
      arrivedAtMs: nowMs,
      price: null,
      cards: new Map(),
      conversions: new Map(),
      fallbacks: new Map(),
    };
    flights.set(key, flight);
    return flight;
  }

  async function sharedConversion(
    flight: Flight,
    owner: LinkOpenOwnerResult,
    input: LinkOpenRequoteInput,
    item?: AssembleCardInput['item'],
    renewedCode?: string | null,
  ): Promise<Converted> {
    const key = flightName(await cacheKeyOf(owner, input, renewedCode), cacheTagOf(owner, input));
    const pending = flight.conversions.get(key);
    if (pending !== undefined) {
      const shared = await pending;
      // A jump that expired since the flight converted it is never reused: convert again (the
      // flight's price conclusion stays).
      if (shared.kind !== 'ok' || jumpUsable(shared.jump, clock.now().getTime())) return shared;
      if (flight.conversions.get(key) !== pending)
        return sharedConversion(flight, owner, input, item, renewedCode);
    }
    const fresh = convertFor(owner, input, item, renewedCode);
    flight.conversions.set(key, fresh);
    return fresh;
  }

  function failure(code: number, owner: LinkOpenOwnerResult): Settled {
    return {
      code,
      linkId: owner.link.link_id,
      quotedPriceFen: owner.link.quoted_final_price_fen,
      cacheHit: false,
      data: null,
    };
  }

  /**
   * A failed conversion: 50301 / 50303 for the open, except an explicit no_rebate purchase whose
   * conversion failed, which jumps to the unpromoted product page (BR-PRICE-08) — never cached.
   */
  async function conversionFallback(
    converted: Extract<Converted, { kind: 'failed' }>,
    owner: LinkOpenOwnerResult,
    input: LinkOpenRequoteInput,
  ): Promise<LinkOpenJump | null> {
    if (converted.code !== 50303 || input.noRebate !== true || converted.noRebateUrl === null) {
      return null;
    }
    // Issued now, like a converted plan: never the registration-time links.expire_at.
    const configured = await setting(
      owner.link.app_id,
      CONVERT_CACHE_TTL_SEC,
      MAX_CONVERT_CACHE_TTL_SEC,
    );
    const sec =
      configured > 0 && configured <= MAX_CONVERT_CACHE_TTL_SEC
        ? configured
        : MAX_CONVERT_CACHE_TTL_SEC;
    // Every Clock returns a fresh Date, so moving this one is local.
    const expireAt = clock.now();
    expireAt.setTime(expireAt.getTime() + sec * 1000);
    return {
      primary: { type: 'h5', value: converted.noRebateUrl },
      fallbacks: [],
      expire_at: expireAt.toISOString(),
    };
  }

  /**
   * BR-PRICE-13 failure branch: this identity's fresh cache with requote_failed, else 50303. An
   * explicit no_rebate purchase does not need the re-check (BR-PRICE-13, 2026-10-08): it converts
   * on the self_buy slot without user parameters, else jumps to the unpromoted page.
   */
  async function requoteFailed(
    flight: Flight,
    owner: LinkOpenOwnerResult,
    input: LinkOpenRequoteInput,
    item?: AssembleCardInput['item'],
  ): Promise<Settled> {
    if (input.noRebate === true) return noRebateAfterFailedRequote(flight, owner, input, item);
    // One lookup per identity key and window: a first 50303 is not turned into a cached jump by
    // a conversion another open stored meanwhile; a reused jump still has to be usable now.
    const key = await cacheKeyOf(owner, input);
    const tag = cacheTagOf(owner, input);
    const name = flightName(key, tag);
    let lookup = flight.fallbacks.get(name);
    if (lookup === undefined) {
      lookup = cached(owner.link.app_id, key, tag);
      flight.fallbacks.set(name, lookup);
    }
    const found = await lookup;
    const jump = found !== null && jumpUsable(found, clock.now().getTime()) ? found : null;
    if (jump === null) return failure(50303, owner);
    return {
      code: 0,
      linkId: owner.link.link_id,
      quotedPriceFen: owner.link.quoted_final_price_fen,
      cacheHit: true,
      data: {
        jump,
        price_changed: false,
        old_final_price_fen: owner.old_final_price_fen,
        new_final_price_fen: null,
        new_link_id: owner.new_link_id,
        requote_failed: true,
        new_rebate_min_fen: null,
        new_rebate_max_fen: null,
        no_rebate_cause: null,
        availability: 'ok',
        quoted_at: null,
      },
    };
  }

  /**
   * BR-PRICE-13 (2026-10-08) with BR-ID-18 / BR-PRICE-08: the no_rebate open after a failed
   * re-check — no quote snapshot, no price-change prompt, no rebate shown, requote_failed=true;
   * the no-rebate conversion (its own cache key, never the attributed one), or when that fails
   * the unpromoted product page; 50303 only when neither exists. The effective no_rebate already
   * excludes another user's share link (BR-ATTR-05 ①).
   */
  async function noRebateAfterFailedRequote(
    flight: Flight,
    owner: LinkOpenOwnerResult,
    input: LinkOpenRequoteInput,
    item: AssembleCardInput['item'] | undefined,
  ): Promise<Settled> {
    const converted = await sharedConversion(flight, owner, input, item);
    const fallback =
      converted.kind === 'failed' ? await conversionFallback(converted, owner, input) : null;
    if (converted.kind === 'failed' && fallback === null) return failure(converted.code, owner);
    return {
      code: 0,
      linkId: owner.link.link_id,
      quotedPriceFen: owner.link.quoted_final_price_fen,
      cacheHit: converted.kind === 'ok' && converted.cacheHit,
      data: {
        jump: converted.kind === 'ok' ? converted.jump : fallback!,
        price_changed: false,
        old_final_price_fen: owner.old_final_price_fen,
        new_final_price_fen: null,
        new_link_id: owner.new_link_id,
        requote_failed: true,
        new_rebate_min_fen: '0',
        new_rebate_max_fen: '0',
        no_rebate_cause: null,
        availability: 'ok',
        quoted_at: null,
      },
    };
  }

  /**
   * BR-ID-18: the server's no_rebate_reason of an open on the no-rebate path — relation_conflict
   * while the requesting user (never the snapshot user) has an unresolved 30151 conflict on the
   * link's platform, ahead of the port's own reason (binding_blocked). Read on the open's
   * transaction; only the log takes it, never the idempotent request body.
   */
  async function serverNoRebateReason(
    caller: Caller,
    owner: LinkOpenOwnerResult,
    input: LinkOpenRequoteInput,
    executor: Kysely<DB>,
    portReason: LinkOpenServerNoRebateReason | undefined,
  ): Promise<LinkOpenServerNoRebateReason | undefined> {
    if (input.noRebate !== true || caller.userId === null) return portReason;
    const { link } = owner;
    const conflicted = await hasUnresolvedBindingConflict(
      executor,
      link.app_id,
      caller.userId,
      link.platform,
    );
    return conflicted ? 'relation_conflict' : portReason;
  }

  async function settle(
    caller: Caller,
    owner: LinkOpenOwnerResult,
    input: LinkOpenRequoteInput,
    nowMs: number,
    executor: Kysely<DB>,
  ): Promise<Settled> {
    // BR-PROD-10: a paused platform answers 50301 before any cache or price work.
    if (conversion.admit !== undefined) {
      try {
        await conversion.admit(owner, input.client);
      } catch (error) {
        if (conversionFailure(error).code !== 50301) return failure(50303, owner);
        // B1-06zl: the switched-off pause carries { platform, reason } (BR-PROD-10, BR-TEXT-14);
        // every other pause (no verified path, no slot) answers without data, as before.
        const data = pausedDataOf(error);
        return { ...failure(50301, owner), ...(data === undefined ? {} : { error: { ...data } }) };
      }
    }
    // B1-06f: the port's authorization, before any cache or price work (an unauthorized open
    // neither fetches a price nor reuses a cached jump).
    let reason: LinkOpenServerNoRebateReason | undefined;
    if (conversion.authorize !== undefined) {
      let decided: LinkOpenAuthorization;
      try {
        decided = await conversion.authorize({
          caller,
          owner,
          noRebate: input.noRebate === true,
          client: input.client,
          installed: input.installed ?? 'unknown',
          traceId: input.traceId,
          executor,
        });
      } catch (error) {
        if ((error as { code?: unknown } | null)?.code === 50301) return failure(50301, owner);
        throw error;
      }
      if (decided.kind === 'refused') {
        const refusedReason =
          decided.noRebateReason === undefined
            ? undefined
            : await serverNoRebateReason(caller, owner, input, executor, decided.noRebateReason);
        return {
          ...failure(decided.code, owner),
          ...(decided.data === undefined ? {} : { error: decided.data }),
          ...(refusedReason === undefined ? {} : { noRebateReason: refusedReason }),
        };
      }
      reason = decided.noRebateReason;
    }
    reason = await serverNoRebateReason(caller, owner, input, executor, reason);
    const settled = await settleAuthorized(caller, owner, input, nowMs, executor);
    return reason === undefined ? settled : { ...settled, noRebateReason: reason };
  }

  async function settleAuthorized(
    caller: Caller,
    owner: LinkOpenOwnerResult,
    input: LinkOpenRequoteInput,
    nowMs: number,
    executor: Kysely<DB>,
  ): Promise<Settled> {
    const flight = flightFor(owner, input.linkId, nowMs);
    const link: LinkRow = owner.link;

    // BR-PRICE-13: amount_unknown has no snapshot; it only converts.
    if (owner.old_final_price_fen === null) {
      const converted = await sharedConversion(flight, owner, input);
      if (converted.kind === 'failed') return failure(converted.code, owner);
      return {
        code: 0,
        linkId: link.link_id,
        quotedPriceFen: null,
        cacheHit: converted.cacheHit,
        data: {
          jump: converted.jump,
          price_changed: false,
          old_final_price_fen: null,
          new_final_price_fen: null,
          new_link_id: owner.new_link_id,
          requote_failed: false,
          new_rebate_min_fen: null,
          new_rebate_max_fen: null,
          no_rebate_cause: null,
          availability: 'ok',
          quoted_at: null,
        },
      };
    }
    const oldFen = BigInt(owner.old_final_price_fen);

    flight.price ??= concludePrice(owner);
    const price = await flight.price;
    switch (price.kind) {
      case 'off_shelf':
        return failure(30141, owner);
      case 'tlj_empty':
        return failure(30602, owner);
      case 'failed':
        return requoteFailed(flight, owner, input);
      case 'fresh': {
        // BR-PRICE-20: the snapshot stands as new; conversion is still real time.
        const converted = await sharedConversion(flight, owner, input);
        const fallback =
          converted.kind === 'failed' ? await conversionFallback(converted, owner, input) : null;
        if (converted.kind === 'failed' && fallback === null) return failure(converted.code, owner);
        return {
          code: 0,
          linkId: link.link_id,
          quotedPriceFen: link.quoted_final_price_fen,
          cacheHit: converted.kind === 'ok' && converted.cacheHit,
          data: {
            jump: converted.kind === 'ok' ? converted.jump : fallback!,
            price_changed: false,
            old_final_price_fen: owner.old_final_price_fen,
            new_final_price_fen: owner.old_final_price_fen,
            new_link_id: owner.new_link_id,
            requote_failed: false,
            new_rebate_min_fen: input.noRebate === true ? '0' : null,
            new_rebate_max_fen: input.noRebate === true ? '0' : null,
            no_rebate_cause: null,
            availability: 'ok',
            quoted_at: link.quoted_at === null ? null : link.quoted_at.toISOString(),
          },
        };
      }
      case 'available':
        break;
    }

    // Rebates follow the opener's quote; the renewed link follows the opened link's identity.
    const cardKey = JSON.stringify([
      openerKey(caller),
      owner.identitySnapshot,
      link.scene,
      link.sub_scene,
      link.agent_card_id,
    ]);
    let pendingCard = flight.cards.get(cardKey);
    if (pendingCard === undefined) {
      pendingCard = concludeCard(owner, price.input);
      flight.cards.set(cardKey, pendingCard);
    }
    const card = await pendingCard;
    if (card.kind === 'failed') return requoteFailed(flight, owner, input, price.input.item);

    const snapshot = {
      finalFen: oldFen,
      couponFen: link.quoted_coupon_fen,
      couponIds: couponIdsOf(link.quoted_coupon_id),
    };
    const current = {
      finalFen: card.finalFen,
      couponFen: card.couponFen,
      couponIds: card.couponIds,
    };
    const minFen = await setting(link.app_id, PRICE_CHANGE_MIN_FEN, DEFAULT_PRICE_CHANGE_MIN_FEN);
    const ratioBp = Math.min(
      await setting(link.app_id, PRICE_CHANGE_RATIO_BP, DEFAULT_PRICE_CHANGE_RATIO_BP),
      10000,
    );
    const changed = priceChanged(oldFen, card.finalFen, BigInt(minFen), BigInt(ratioBp));
    const availability: Availability = couponGone(snapshot, current) ? 'coupon_gone' : 'ok';
    // BR-PRICE-08: a no_rebate purchase never writes a quote snapshot, so it never renews.
    const renewed = input.noRebate !== true && quoteSnapshotChanged(snapshot, current);

    // B1-08s: a renewed snapshot converts for its new link, so it carries that link's own lk
    // (pre-drawn now); never the opened link's code. The link is then written and the jump made
    // to carry the code it was stored with (writeRenewedLink).
    const pending = renewed ? card.pending : null;
    const drawn = pending === null ? undefined : await renewedLinkCode(pending, executor);
    const renewedCode = drawn === undefined ? undefined : (drawn?.code ?? null);
    let converted = await sharedConversion(flight, owner, input, price.input.item, renewedCode);
    const fallback =
      converted.kind === 'failed' ? await conversionFallback(converted, owner, input) : null;
    if (converted.kind === 'failed' && fallback === null) return failure(converted.code, owner);
    if (pending !== null && drawn !== undefined && converted.kind === 'ok') {
      converted = await writeRenewedLink(
        flight,
        owner,
        input,
        price.input.item,
        pending,
        drawn,
        converted,
        executor,
      );
      if (converted.kind === 'failed') return failure(converted.code, owner);
    }
    const effective = renewed ? card.linkId : link.link_id;
    const rebates =
      input.noRebate === true
        ? { min: '0', max: '0' }
        : rebatesShown(caller, owner, card.rebateMinFen, card.rebateMaxFen);
    return {
      code: 0,
      linkId: effective,
      quotedPriceFen: renewed ? card.finalFen : link.quoted_final_price_fen,
      cacheHit: converted.kind === 'ok' && converted.cacheHit,
      data: {
        jump: converted.kind === 'ok' ? converted.jump : fallback!,
        price_changed: changed,
        old_final_price_fen: owner.old_final_price_fen,
        new_final_price_fen: card.finalFen.toString(),
        new_link_id: renewed ? card.linkId : owner.new_link_id,
        requote_failed: false,
        new_rebate_min_fen: rebates.min,
        new_rebate_max_fen: rebates.max,
        no_rebate_cause: null,
        availability,
        quoted_at: card.quotedAt,
      },
    };
  }

  /**
   * BR-ATTR-14 open log, and on success the attempt, through `executor`: the open's transaction
   * for a stored result, the db handle for the log of one that is not. (A renewed snapshot's link
   * is written before, in settleAuthorized, so the answered jump carries its stored lk; B1-08s.)
   * B1-06i: a convert writes its own event (event=convert, with the request's spm) instead of
   * open; logLinkId null is the log of a convert whose registered link was rolled back.
   */
  async function record(
    executor: Kysely<DB>,
    caller: Caller,
    subject: { readonly link: LinkRow; readonly identitySnapshot: IdentitySnapshot },
    input: LinkOpenRequoteInput,
    settled: Settled,
    startMs: number,
    logLinkId: string | null,
    event: 'open' | 'convert' = 'open',
  ): Promise<string | null> {
    const now = clock.now();
    const { link, identitySnapshot } = subject;
    const attemptId = settled.code === 0 ? newUuidV7(now) : null;
    await executor
      .insertInto('link_logs')
      .values({
        app_id: link.app_id,
        link_id: logLinkId,
        event,
        ...(event === 'convert' ? { spm: input.spm ?? null } : {}),
        user_id: identitySnapshot.user_id,
        opener_user_id: caller.userId,
        platform: link.platform,
        product_key: link.product_key,
        raw_item_id: link.raw_item_id,
        scene: link.scene,
        pid_scene: identitySnapshot.pid_scene,
        pid: identitySnapshot.pid,
        client: input.client,
        cache_hit: settled.cacheHit,
        expired: startMs > link.expire_at.getTime(),
        quoted_price_fen: settled.quotedPriceFen,
        no_rebate: input.noRebate === true,
        no_rebate_reason:
          input.noRebate === true
            ? (settled.noRebateReason ?? input.noRebateReason ?? 'auth_declined')
            : null,
        agent_session_id: identitySnapshot.agent_session_id,
        result_code: settled.code,
        latency_ms: Math.max(0, now.getTime() - startMs),
        created_at: now,
      })
      .execute();
    if (attemptId !== null) {
      await executor
        .insertInto('link_open_attempts')
        .values({
          attempt_id: attemptId,
          app_id: link.app_id,
          link_id: settled.linkId,
          user_id: caller.userId,
          opened_at: now,
          created_at: now,
          updated_at: now,
        })
        .execute();
    }
    return attemptId;
  }

  /** The codes platform idempotency stores (0 and 3xxxx); any other rolls the open back. */
  function stored(code: number): boolean {
    return code === 0 || (code >= 30000 && code <= 39999);
  }

  /** The log of a result not stored: after the rollback, outside any transaction. */
  async function logOpened(
    caller: Caller,
    input: LinkOpenRequoteInput,
    settled: Settled,
    start: number,
  ): Promise<void> {
    const opened = await db
      .selectFrom('links')
      .selectAll()
      .where('app_id', '=', caller.appId)
      .where('link_id', '=', input.linkId)
      .executeTakeFirst();
    if (opened === undefined) return;
    const subject = { link: opened, identitySnapshot: readSnapshot(opened) };
    const failed: Settled = {
      code: settled.code,
      linkId: opened.link_id,
      quotedPriceFen: opened.quoted_final_price_fen,
      cacheHit: settled.cacheHit,
      data: null,
      ...(settled.noRebateReason === undefined ? {} : { noRebateReason: settled.noRebateReason }),
    };
    await record(db, caller, subject, input, failed, start, opened.link_id);
  }

  /**
   * Every identity the owner stage can settle on for this link (a lost guest claim included),
   * with the no_rebate the open would then use.
   */
  function readIdentities(
    caller: Caller,
    link: LinkRow,
    snapshot: IdentitySnapshot,
    requestedNoRebate: boolean | undefined,
  ): {
    readonly identities: LinkOpenReadIdentity[];
    readonly registers: string[];
    /** The owner stage reads the caller's attr_code (a claim or a new link). */
    readonly callerAttr: boolean;
  } {
    const scene = storedSceneOf(link);
    const identities: LinkOpenReadIdentity[] = [];
    const registers: string[] = [];
    const add = (userId: string | null, pidScene: string) => {
      const sharedByOther = pidScene === 'share' && userId !== caller.userId;
      identities.push({ userId, pidScene, noRebate: requestedNoRebate === true && !sharedByOther });
    };
    // B1-06p: the owner stage registers nothing for an applicable no_rebate (link-open-owner.ts).
    const registersFor = (snapshotUserId: string | null) =>
      !noRebateApplies(
        caller.userId,
        { pid_scene: snapshot.pid_scene, user_id: snapshotUserId },
        requestedNoRebate,
      );
    const decide = (rowUserId: string | null, snapshotUserId: string | null) =>
      decideOpenOwner({
        pidScene: link.pid_scene,
        scene,
        snapshotUserId,
        rowUserId,
        callerUserId: caller.userId,
      });
    const first = decide(link.user_id, snapshot.user_id);
    const outcomes: { decision: ReturnType<typeof decide>; snapshotUserId: string | null }[] = [
      { decision: first, snapshotUserId: snapshot.user_id },
    ];
    // A claim lost to another opener decides again as another user's link.
    const other = 'claimed-by-another-opener';
    if (first.kind === 'claim')
      outcomes.push({ decision: decide(other, other), snapshotUserId: other });
    for (const { decision, snapshotUserId } of outcomes) {
      if (decision.kind === 'use') add(snapshot.user_id, snapshot.pid_scene);
      if (decision.kind === 'claim') add(caller.userId, snapshot.pid_scene);
      if (decision.kind === 'register') {
        const pidScene = pidSceneOf(decision.scene);
        if (registersFor(snapshotUserId)) registers.push(pidScene);
        add(caller.userId, pidScene);
      }
    }
    return { identities, registers, callerAttr: first.kind === 'claim' || registers.length > 0 };
  }

  /**
   * B1-06m: before the transaction, every setting, active pid and attr_code the open may read —
   * the owner stage's (claim or new link), the re-check's and the conversion's.
   */
  async function prepareReads(caller: Caller, input: LinkOpenRequoteInput): Promise<void> {
    const appId = caller.appId;
    // Settled from the start: a setting read that rejects while the link is still being read must
    // not surface as an unhandled rejection (it fails again where the open uses it).
    const reads: Promise<unknown>[] = [
      Promise.allSettled(
        [
          REQUOTE_AFTER_SEC,
          PRICE_CHANGE_MIN_FEN,
          PRICE_CHANGE_RATIO_BP,
          CONVERT_CACHE_TTL_SEC,
          PDD_PRECHECK_SWITCH,
        ].map((key) => config.configValue(appId, key)),
      ),
    ];
    const link = await db
      .selectFrom('links')
      .selectAll()
      .where('app_id', '=', appId)
      .where('link_id', '=', input.linkId)
      .executeTakeFirst();
    let plan: ReturnType<typeof readIdentities> | null = null;
    if (link !== undefined) {
      try {
        plan = readIdentities(caller, link, readSnapshot(link), input.noRebate);
      } catch {
        plan = null; // a malformed link fails in the owner stage, which reads nothing more
      }
    }
    if (link !== undefined && plan !== null) {
      const { platform } = link;
      // B1-08s: the lk switch the owner stage, a renewed snapshot and the cache key read.
      if (platform === 'jd' || platform === 'pdd') {
        reads.push(config.configValue(appId, clickCodeKey(platform)));
      }
      if (plan.callerAttr) {
        reads.push(attrCodeOf(attrCodes, appId, caller.userId));
      }
      for (const pidScene of plan.registers) {
        reads.push(
          pids.getActivePid({
            appId,
            platform: platform as Parameters<typeof pids.getActivePid>[0]['platform'],
            pidScene: pidScene as Parameters<typeof pids.getActivePid>[0]['pidScene'],
            purpose: 'convert',
          }),
        );
      }
      if (conversion.prepare !== undefined) {
        reads.push(
          conversion.prepare({
            appId,
            platform,
            callerUserId: caller.userId,
            identities: plan.identities,
          }),
        );
      }
    }
    // A read that failed fails again where the open uses it, as it did when read in place.
    await Promise.allSettled(reads);
  }

  async function handle(
    caller: Caller,
    request: LinkOpenRequoteInput,
    trx: Transaction<DB>,
    afterRollback: { log?: () => Promise<unknown> },
  ): Promise<HandlerResult> {
    const start = clock.now().getTime();
    const envelope = (code: number, data: unknown = null): HandlerResult => ({
      status: STATUS[code] ?? 500,
      envelope: { code, msg: MESSAGES[code] ?? 'error', data, trace_id: request.traceId },
    });
    let owner: LinkOpenOwnerResult;
    try {
      owner = await owners.open(
        { linkId: request.linkId, noRebate: request.noRebate === true },
        trx,
      );
    } catch (error) {
      if (error instanceof LinkingError) return envelope(error.code);
      throw error;
    }
    // BR-ATTR-05 ①: the request's no_rebate is ignored on another user's share link.
    const noRebate = effectiveNoRebate(caller, owner, request.noRebate);
    const { noRebate: _requested, noRebateReason: _reason, ...rest } = request;
    void _requested;
    void _reason;
    const input: LinkOpenRequoteInput = {
      ...rest,
      noRebate,
      ...(noRebate && request.noRebateReason !== undefined
        ? { noRebateReason: request.noRebateReason }
        : {}),
    };
    const settled = await settle(caller, owner, input, start, trx);
    if (!stored(settled.code)) {
      // The transaction rolls back (a claim or a registered link with it), so the log is written
      // once the rollback is done (BR-ATTR-14: failures are logged), wholly for the opened link
      // as committed — its identity, pid and expiry, never those of a rolled-back new link — with
      // the opener as opener_user_id.
      afterRollback.log = () => logOpened(caller, input, settled, start);
      return envelope(settled.code, settled.error ?? null);
    }
    const attemptId = await record(trx, caller, owner, input, settled, start, settled.linkId);
    if (settled.code !== 0 || settled.data === null || attemptId === null) {
      return envelope(settled.code, settled.error ?? null);
    }
    return envelope(0, { attempt_id: attemptId, ...settled.data });
  }

  async function open(input: LinkOpenRequoteInput): Promise<LinkOpenRequoteOutcome> {
    // An unknown link ID is 30144 (B1-06d) and never reaches the idempotency path.
    if (typeof input.linkId !== 'string' || !UUID.test(input.linkId)) {
      return { code: 30144, data: null };
    }
    const caller = await callerContext.current();
    // B1-06w: a caller with neither a user nor a verified device has no idempotency subject;
    // without one the open can only ask for login (10001), never reach the idempotency store.
    if (caller.userId === null && caller.deviceId === null) return { code: 10001, data: null };
    const afterRollback: { log?: () => Promise<unknown> } = {};
    // B1-06m: the reads first, then one transaction that takes no second pooled connection.
    const response = await withOpenReads(
      () => prepareReads(caller, input),
      () =>
        idempotency.executeInTransaction(
          {
            appId: caller.appId,
            actor: { userId: caller.userId, deviceId: caller.deviceId, phoneHmac: null },
            method: 'POST',
            path: `/v1/links/${input.linkId}/open`,
            key: input.idempotencyKey,
            body: openRequestBody(input),
            traceId: input.traceId,
          },
          (trx) => {
            delete afterRollback.log;
            return handle(caller, input, trx, afterRollback);
          },
        ),
    );
    // Handler and replay alike: the stored body is the result, so a replay equals the first.
    const parsed = JSON.parse(response.body) as { code: number; data?: unknown };
    if (response.source === 'handler' && !stored(parsed.code) && afterRollback.log !== undefined) {
      await afterRollback.log();
    }
    if (parsed.code === 0 && parsed.data !== null && parsed.data !== undefined) {
      return { code: 0, data: parsed.data as LinkOpenRequoteResult };
    }
    if (
      ERROR_DATA_CODES.has(parsed.code) &&
      typeof parsed.data === 'object' &&
      parsed.data !== null &&
      !Array.isArray(parsed.data)
    ) {
      return { code: parsed.code, data: null, error: parsed.data as Record<string, unknown> };
    }
    return { code: parsed.code, data: null };
  }

  // ---- B1-06i: POST /v1/links/convert — register the caller's H5 link, then open it ----

  /** What the convert prepared before its transaction. */
  interface ConvertPrepared {
    resolution: LinkConvertResolution;
    snapshot:
      | { readonly ok: true; readonly value: IdentitySnapshot }
      | { readonly ok: false; readonly error: unknown }
      | null;
  }

  const CONVERT_SCENE: Scene = 'h5';

  /**
   * Before the transaction: the resolution (catalog, item_ref, union, parsing — none of them on
   * the open's connection), the new link's identity (BR-ATTR-05/08: the caller, scene h5 →
   * self_buy) and every read the open stages may need for it (B1-06m).
   */
  async function prepareConvert(
    caller: Caller,
    input: LinkConvertRequoteInput,
    prepared: ConvertPrepared,
  ): Promise<void> {
    const appId = caller.appId;
    const settings = Promise.allSettled(
      [
        REQUOTE_AFTER_SEC,
        PRICE_CHANGE_MIN_FEN,
        PRICE_CHANGE_RATIO_BP,
        CONVERT_CACHE_TTL_SEC,
        PDD_PRECHECK_SWITCH,
      ].map((key) => config.configValue(appId, key)),
    );
    try {
      prepared.resolution = await input.resolve(caller);
    } catch (error) {
      prepared.resolution = { kind: 'fault', error };
    }
    const { resolution } = prepared;
    if (resolution.kind === 'target') {
      const { platform } = resolution.target;
      try {
        prepared.snapshot = {
          ok: true,
          value: await resolveSnapshot({
            caller,
            attrCodes,
            pids,
            platform,
            scene: CONVERT_SCENE,
            agentSessionId: null,
          }),
        };
      } catch (error) {
        prepared.snapshot = { ok: false, error };
      }
      // B1-08s: the lk switch the new link's registration reads in the transaction.
      const clickCode =
        platform === 'jd' || platform === 'pdd'
          ? [config.configValue(appId, clickCodeKey(platform))]
          : [];
      await Promise.allSettled(clickCode);
      if (conversion.prepare !== undefined) {
        await Promise.allSettled([
          conversion.prepare({
            appId,
            platform,
            callerUserId: caller.userId,
            identities: [
              { userId: caller.userId, pidScene: pidSceneOf(CONVERT_SCENE), noRebate: false },
            ],
          }),
        ]);
      }
    }
    await settings;
  }

  /** The convert log of a refusal before any link exists (BR-ATTR-14: failures are logged). */
  async function logUnregistered(
    executor: Kysely<DB>,
    caller: Caller,
    input: LinkConvertRequoteInput,
    code: number,
    productKey: string | null,
    startMs: number,
  ): Promise<void> {
    const now = clock.now();
    await executor
      .insertInto('link_logs')
      .values({
        app_id: caller.appId,
        link_id: null,
        event: 'convert',
        user_id: caller.userId,
        opener_user_id: caller.userId,
        platform: input.platform,
        product_key: productKey,
        scene: CONVERT_SCENE,
        pid_scene: pidSceneOf(CONVERT_SCENE),
        spm: input.spm ?? null,
        client: input.client,
        result_code: code,
        latency_ms: Math.max(0, now.getTime() - startMs),
        created_at: now,
      })
      .execute();
  }

  async function handleConvert(
    caller: Caller,
    input: LinkConvertRequoteInput,
    prepared: ConvertPrepared,
    trx: Transaction<DB>,
    afterRollback: { log?: () => Promise<unknown> },
  ): Promise<HandlerResult> {
    const start = clock.now().getTime();
    const envelope = (code: number, data: unknown = null): HandlerResult => ({
      status: STATUS[code] ?? 500,
      envelope: { code, msg: MESSAGES[code] ?? 'error', data, trace_id: input.traceId },
    });
    const { resolution, snapshot } = prepared;
    if (resolution.kind === 'fault') throw resolution.error;
    if (resolution.kind === 'refused') {
      const { code, productKey } = resolution;
      if (stored(code)) await logUnregistered(trx, caller, input, code, productKey, start);
      else afterRollback.log = () => logUnregistered(db, caller, input, code, productKey, start);
      return envelope(code, resolution.data ?? null);
    }
    if (snapshot === null) throw new Error('linking: convert identity was not prepared');
    if (!snapshot.ok) throw snapshot.error;
    const { target } = resolution;
    const { item } = target;
    const now = clock.now();
    // The caller's own H5 link (BR-ATTR-08: scene h5 → self_buy), through the module's single
    // links insert, in this transaction: it commits with the convert's log and attempt or not at all.
    const linkId = newUuidV7(now);
    // B1-08s: the caller's new link gets an lk while the switch is on (pre-read by prepareConvert).
    const issue = await linkCodeIssue(
      config,
      { appId: caller.appId, platform: target.platform, userId: caller.userId },
      options,
    );
    await insertConvertLink(
      trx,
      {
        now,
        caller,
        linkId,
        snapshot: snapshot.value,
        shopId: target.shopId,
        values: {
          platform: target.platform,
          productKey: target.productKey,
          rawItemId: target.rawItemId,
          rawFetchedAt: target.rawFetchedAt,
          scene: CONVERT_SCENE,
          subScene: null,
          entrySource: target.entrySource,
          quotedFinalPriceFen: item.final_price_fen,
          quotedCouponFen: item.coupon_fen,
          quotedCouponId:
            item.coupon_ids === undefined || item.coupon_ids === '' ? null : item.coupon_ids,
          quotedAt: item.quoted_at,
          agentCardId: null,
        },
      },
      issue,
    );
    let owner: LinkOpenOwnerResult;
    try {
      owner = await owners.open({ linkId, noRebate: false }, trx);
    } catch (error) {
      if (error instanceof LinkingError) {
        const code = error.code;
        afterRollback.log = () =>
          logUnregistered(db, caller, input, code, target.productKey, start);
        return envelope(code);
      }
      throw error;
    }
    const openInput: LinkOpenRequoteInput = {
      linkId,
      idempotencyKey: input.idempotencyKey,
      traceId: input.traceId,
      client: input.client,
      installed: input.installed,
      noRebate: false,
      ...(input.spm === undefined ? {} : { spm: input.spm }),
    };
    const settled = await settle(caller, owner, openInput, start, trx);
    if (!stored(settled.code)) {
      // The registered link rolls back with the transaction: the log keeps its product and
      // identity, with no link_id (nothing to refer to).
      const failed: Settled = {
        code: settled.code,
        linkId,
        quotedPriceFen: owner.link.quoted_final_price_fen,
        cacheHit: settled.cacheHit,
        data: null,
      };
      afterRollback.log = () =>
        record(db, caller, owner, openInput, failed, start, null, 'convert');
      return envelope(settled.code, settled.error ?? null);
    }
    const attemptId = await record(
      trx,
      caller,
      owner,
      openInput,
      settled,
      start,
      settled.linkId,
      'convert',
    );
    if (settled.code !== 0 || settled.data === null || attemptId === null) {
      return envelope(settled.code, settled.error ?? null);
    }
    return envelope(0, { link_id: linkId, attempt_id: attemptId, ...settled.data });
  }

  async function convert(input: LinkConvertRequoteInput): Promise<LinkConvertRequoteOutcome> {
    const caller = await callerContext.current();
    // x-auth login: no guest registers or converts (BR-ATTR-05 ④), nothing is read or logged.
    if (caller.userId === null) return { code: 10001, data: null };
    const afterRollback: { log?: () => Promise<unknown> } = {};
    const prepared: ConvertPrepared = {
      resolution: { kind: 'fault', error: new Error('linking: convert was not resolved') },
      snapshot: null,
    };
    const response = await withOpenReads(
      () => prepareConvert(caller, input, prepared),
      () =>
        idempotency.executeInTransaction(
          {
            appId: caller.appId,
            actor: { userId: caller.userId, deviceId: caller.deviceId, phoneHmac: null },
            method: 'POST',
            path: '/v1/links/convert',
            key: input.idempotencyKey,
            body: input.body,
            traceId: input.traceId,
          },
          (trx) => {
            delete afterRollback.log;
            return handleConvert(caller, input, prepared, trx, afterRollback);
          },
        ),
    );
    const parsed = JSON.parse(response.body) as {
      code: number;
      data?: unknown;
      trace_id?: unknown;
    };
    if (response.source === 'handler' && !stored(parsed.code) && afterRollback.log !== undefined) {
      await afterRollback.log();
    }
    // A replay answers the stored response as it was, its trace_id included.
    const traceId = typeof parsed.trace_id === 'string' ? parsed.trace_id : input.traceId;
    if (parsed.code === 0 && parsed.data !== null && parsed.data !== undefined) {
      return {
        code: 0,
        data: parsed.data as LinkOpenRequoteResult & { link_id: string },
        traceId,
      };
    }
    if (
      (ERROR_DATA_CODES.has(parsed.code) || parsed.code === 20001) &&
      typeof parsed.data === 'object' &&
      parsed.data !== null &&
      !Array.isArray(parsed.data)
    ) {
      return {
        code: parsed.code,
        data: null,
        error: parsed.data as Record<string, unknown>,
        traceId,
      };
    }
    return { code: parsed.code, data: null, traceId };
  }

  return { open, convert };
}
