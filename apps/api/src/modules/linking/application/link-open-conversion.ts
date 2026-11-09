// B1-06e: linking open, third stage — the server-side conversion of jd and pdd through the governed
// union adapter (the demo adapter until real conversion is admitted), and the jump plan by
// platform × client × installed (BR-ATTR-27 default matrix).
// - UnionIdentity is built here only, from the opened link's frozen identity snapshot: the active
//   pid of the snapshot's pid_scene (purpose convert) and the snapshot owner's attr_code — jd
//   subUnionId = n_{attr_code}, pdd custom_parameters.uid = attr_code (BR-ATTR-05/06). No user_id
//   ever leaves linking; request fields are never read for identity.
// - no_rebate (BR-ID-18, BR-ATTR-08): self_buy pid, no user key, no attr_code lookup. A share link
//   opened by anyone but the sharer ignores no_rebate and keeps the sharer's attribution.
// - convert.enabled.<platform> off, taobao before B1-06f, a missing attr_code or no active pid →
//   50301 (with a warning for the last two); any adapter failure (timeout, circuit, quota, error)
//   → 50303 carrying the unpromoted product page for the explicit no-rebate purchase (BR-PRICE-08).
// - B1-19d (BR-ATTR-07, BR-ID-17): an input carrying unionAccountId (the Pinduoduo composition's
//   account in use) converts only with that account's active slot; none → 50301, never another
//   account's. Without it the scene's slot app-wide, as before.
// - B1-22n (BR-ATTR-05 细则 ⑦ before ⑧, D10-239 T3a): createConversionPrecheck builds the same
//   identity without converting, so an open's authorization hook (link-open-pdd-auth.ts) stops a
//   jd / pdd open with no usable slot (or attr_code, or a jd user key mode not served) at 50301
//   before any cache, price or union call. Cache reads and keys are unchanged (R-12).
import { bridge, type components } from '@couli/contracts-ts';
import type { Clock } from '../../platform/index.ts';
import {
  UnionIdentity,
  type ItemRef,
  type UnionPidService,
  type UnionRegistry,
} from '../../union/index.ts';
import {
  CONVERT_CACHE_TTL_SEC,
  MAX_CONVERT_CACHE_TTL_SEC,
  intSetting,
  isSwitchOn,
} from '../domain/rules.ts';
import type { AttrCodeReader, Caller, CallerContext, LinkingConfigReader } from '../ports.ts';
import { storedLinkCode } from '../infra/link-code.ts';
import {
  convertOffReasonKey,
  convertPausedData,
  type ConvertPausedData,
} from './convert-paused.ts';
import { attrCodeOf, clickCodeOn } from './link-registration.ts';
import type { LinkOpenOwnerResult } from './link-open-owner.ts';
import {
  openScopedAttrCodes,
  openScopedConfig,
  openScopedPids,
  type LinkOpenReadPlan,
} from './link-open-reads.ts';
import type {
  LinkOpenConversionInput,
  LinkOpenJump,
  LinkOpenRequoteInput,
} from './link-open-requote.ts';

/** Internal adapter identity; only attr_code is carried in platform attribution parameters. */
export interface JdPddIdentity extends UnionIdentity {
  readonly subUnionId?: string;
  readonly custom_parameters?: Readonly<{ app: 'n'; uid?: string; sc: string; lk?: string }>;
}

/** Read from contracts/apps.json by the composition root; no platform scheme literals here. */
export interface LinkOpenApps {
  readonly apps: Readonly<
    Record<
      'jd' | 'pdd',
      {
        readonly status: string;
        readonly ios: { readonly query_schemes: readonly string[] };
        readonly android: { readonly packages: readonly string[] };
        readonly harmony: { readonly query_schemes: readonly string[] };
      }
    >
  >;
}

export interface LinkConversionOptions {
  readonly clock: Clock;
  readonly callerContext: CallerContext;
  readonly attrCodes?: AttrCodeReader;
  readonly config: LinkingConfigReader;
  readonly pids: Pick<UnionPidService, 'getActivePid'>;
  readonly registry: Pick<UnionRegistry, 'get'>;
  readonly logger: { warn(fields: Readonly<Record<string, unknown>>, message: string): void };
  /**
   * B1-06w: contracts/apps.json as the composition root read it; the app scheme of a platform is
   * taken from it only. Omitted: the generated snapshot of the same file (@couli/contracts-ts).
   */
  readonly apps?: LinkOpenApps;
}

export interface JdPddConversionInput extends LinkOpenConversionInput {
  readonly client: LinkOpenRequoteInput['client'];
  readonly idempotencyKey: string;
  readonly traceId: string;
}

/** The plan's usable period after a conversion (BR-ATTR-05 ②, contract JumpPlan.expire_at). */
const URL_LIFETIME_FALLBACK_SEC = MAX_CONVERT_CACHE_TTL_SEC;

export interface LinkConversion {
  convert(input: JdPddConversionInput): Promise<LinkOpenJump>;
  /** The convert switch and platform admission, checked before any cache or price work. */
  admit(owner: LinkOpenOwnerResult): Promise<void>;
  /** The jump-plan dimensions a cached jump belongs to (client and installed). */
  variant(input: Pick<JdPddConversionInput, 'client' | 'installed'>): string;
  /**
   * B1-06m: pre-reads, before the open's transaction, every setting, active pid and attr_code
   * admit and convert may read for the plan's identities (link-open-reads.ts).
   */
  prepare(plan: LinkOpenReadPlan): Promise<void>;
}

/** Internal failure payload for the explicit no-rebate action, not a new HTTP error field. */
export interface LinkConversionFailure extends Error {
  readonly code: 50303;
  readonly noRebateUrl: string;
}

/** Conversion is paused for this request (BR-PROD-10, BR-ATTR-06/08); never a cache bypass. */
export interface LinkConversionPaused extends Error {
  readonly code: 50301;
  /**
   * B1-06zl: the error data { platform, reason } — set only when convert.enabled.<platform> is off
   * (reason from convert.off_reason.<platform>); every other pause carries none.
   */
  readonly data?: ConvertPausedData;
}

const ATTR_CODE = /^[0-9a-z]{8}$/;
const JD_USER_KEY_MODE = 'attr.jd.user_key_mode';
const CLICK_CODE = { jd: 'attr.click_code.jd', pdd: 'attr.click_code.pdd' } as const;

function paused(message: string, data?: ConvertPausedData): LinkConversionPaused {
  return Object.assign(new Error(message), {
    code: 50301 as const,
    ...(data === undefined ? {} : { data }),
  });
}

function failed(message: string, noRebateUrl: string): LinkConversionFailure {
  return Object.assign(new Error(message), { code: 50303 as const, noRebateUrl });
}

/**
 * The only subclass linking builds; the adapter accepts nothing else (isServerIdentity). Also the
 * identity of the Pinduoduo authority query (B1-06v, link-open-pdd-auth.ts), built the same way.
 */
export class LinkingUnionIdentity extends UnionIdentity implements JdPddIdentity {
  // `declare`: no own property unless set below (a pdd identity carries no subUnionId key at all;
  // a jd one no custom_parameters key), B1-19d.
  declare readonly subUnionId?: string;
  declare readonly custom_parameters?: Readonly<{
    app: 'n';
    uid?: string;
    sc: string;
    lk?: string;
  }>;

  constructor(input: {
    readonly appId: string;
    readonly platform: 'jd' | 'pdd';
    readonly promotionSlot: string;
    /** The attribution key the adapter sees as its user claim: attr_code, never a user_id. */
    readonly userKey: string;
    readonly subUnionId?: string;
    readonly customParameters?: Readonly<{ app: 'n'; uid?: string; sc: string; lk?: string }>;
  }) {
    super({
      appId: input.appId,
      userId: input.userKey,
      platform: input.platform,
      promotionSlot: input.promotionSlot,
      relationId: null,
    });
    if (input.subUnionId !== undefined) this.subUnionId = input.subUnionId;
    if (input.customParameters !== undefined) {
      this.custom_parameters = Object.freeze({ ...input.customParameters });
    }
    Object.freeze(this);
  }
}

/** BR-ATTR-05 ①: a share link opened by anyone but the sharer keeps the sharer's attribution. */
export function effectiveNoRebate(
  caller: Pick<Caller, 'userId'>,
  owner: LinkOpenOwnerResult,
  requested: boolean | undefined,
): boolean {
  const snapshot = owner.identitySnapshot;
  const sharedByOther = snapshot.pid_scene === 'share' && snapshot.user_id !== caller.userId;
  return requested === true && !sharedByOther;
}

/** The demo item reference the adapter looks up; only the link's stored raw item id. */
export function itemRefOf(platform: 'jd' | 'pdd', rawItemId: string): ItemRef {
  return platform === 'jd' ? { platform, itemId: rawItemId } : { platform, goods_sign: rawItemId };
}

/** RFC 3986 scheme syntax; anything else in apps.json is not used as a scheme. */
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]{0,63}$/;

/**
 * The platform app's scheme as contracts/apps.json declares it (the iOS query scheme, else the
 * Harmony one); null when it declares none, and then no scheme step is built (B1-06w: never a
 * platform literal here). Candidates stay unverified (CAP-JD-11 / CAP-PDD-11); production
 * admission of each path is link-open-wiring.ts's.
 */
export function appSchemeOf(apps: LinkOpenApps | undefined, platform: 'jd' | 'pdd'): string | null {
  const declared =
    apps === undefined
      ? [...bridge.apps[platform].ios_query_schemes, ...bridge.apps[platform].harmony_query_schemes]
      : [...apps.apps[platform].ios.query_schemes, ...apps.apps[platform].harmony.query_schemes];
  const scheme = declared.find((entry) => typeof entry === 'string' && SCHEME.test(entry));
  return scheme ?? null;
}

/**
 * Launch paths derived from the converted URL. The app scheme comes from contracts/apps.json
 * (candidates, unverified: CAP-JD-11 / CAP-PDD-11); production admission of each path is separate.
 * TODO(规划/11 §4.5): 拼多多以转链返回的 schema_url 为准 — blocked on CAP-PDD-11 实测。
 * Also the Pinduoduo auth-url's paths of its authorization page (B1-06g).
 */
export function pathsOf(platform: 'jd' | 'pdd', url: string, scheme: string | null): LinkJumpPaths {
  const encoded = encodeURIComponent(url);
  return {
    scheme:
      scheme === null
        ? null
        : platform === 'jd'
          ? `${scheme}://virtual?params=${encodeURIComponent(
              JSON.stringify({ category: 'jump', des: 'm', url }),
            )}`
          : `${scheme}://com.xunmeng.pinduoduo/?url=${encoded}`,
    universalLink: url,
    h5: url,
  };
}

/** The readers the conversion identity is built from (as LinkConversionOptions names them). */
type IdentityReaders = Pick<LinkConversionOptions, 'config' | 'pids' | 'attrCodes' | 'logger'>;

/** The same readers, open-scoped by the caller (attrCodes undefined: none wired). */
interface IdentityDeps {
  readonly config: LinkConversionOptions['config'];
  readonly pids: LinkConversionOptions['pids'];
  readonly attrCodes: AttrCodeReader | undefined;
  readonly logger: LinkConversionOptions['logger'];
}

/**
 * The server-built UnionIdentity of one conversion (BR-ATTR-05/06/08): the slot, the attr_code,
 * the jd user key mode and the lk. Shared by convert and the pre-re-check check (B1-22n) so both
 * judge one identity; any failure is a paused (50301) one.
 */
function createIdentityBuilder(deps: IdentityDeps) {
  const { config, pids, attrCodes, logger } = deps;

  /**
   * B1-08s: the lk a non-no_rebate conversion of this link carries — the link's own stored code
   * (or, for an open's renewed snapshot, the new link's code: input.linkCode),
   * only for jd / pdd while attr.click_code.<platform> is JSON true (read through the open's
   * pre-read inside an open); null otherwise.
   */
  async function injectedLinkCode(
    owner: LinkOpenOwnerResult,
    renewedCode: string | null | undefined,
  ): Promise<string | null> {
    const { link } = owner;
    const platform = link.platform;
    const lk = renewedCode !== undefined ? renewedCode : storedLinkCode(link);
    if (lk === null || (platform !== 'jd' && platform !== 'pdd')) return null;
    const value = await config.configValue(link.app_id, CLICK_CODE[platform]);
    return clickCodeOn(value?.value) ? lk : null;
  }

  async function identityFor(
    owner: LinkOpenOwnerResult,
    platform: 'jd' | 'pdd',
    noRebate: boolean,
    traceId: string,
    unionAccountId: string | undefined,
    renewedCode?: string | null,
  ): Promise<LinkingUnionIdentity> {
    const { link, identitySnapshot } = owner;
    const appId = link.app_id;
    const pidScene = noRebate ? 'self_buy' : identitySnapshot.pid_scene;
    const row = await pids.getActivePid({
      appId,
      platform,
      pidScene: pidScene as Parameters<typeof pids.getActivePid>[0]['pidScene'],
      purpose: 'convert',
      ...(unionAccountId === undefined ? {} : { unionAccountId }),
    });
    if (
      row === null ||
      (unionAccountId !== undefined && row.union_account_id !== unionAccountId) ||
      row.status !== 'active' ||
      row.app_id !== appId ||
      row.platform !== platform ||
      row.pid_scene !== pidScene ||
      row.pid === ''
    ) {
      logger.warn(
        { event: 'linking.open.no_active_pid', app_id: appId, platform, pid_scene: pidScene },
        'linking: no active promotion slot for conversion',
      );
      throw paused('linking: no active promotion slot');
    }
    if (noRebate) {
      return new LinkingUnionIdentity({
        appId,
        platform,
        promotionSlot: row.pid,
        userKey: 'no_rebate',
        ...(platform === 'pdd' ? { customParameters: { app: 'n', sc: 'self_buy' } } : {}),
      });
    }
    const attrCode = await attrCodeOf(attrCodes, appId, identitySnapshot.user_id);
    if (attrCode === null || !ATTR_CODE.test(attrCode)) {
      logger.warn(
        { event: 'linking.open.attr_code_unavailable', app_id: appId, platform, trace_id: traceId },
        'linking: attr_code unavailable for conversion',
      );
      throw paused('linking: attr_code unavailable');
    }
    if (platform === 'jd') {
      const mode = (await config.configValue(appId, JD_USER_KEY_MODE))?.value ?? 'sub_union_id';
      if (mode !== 'sub_union_id') {
        // TODO(规划/11 §4.5): 京东降级 private_position / claim_only — blocked on CAP-JD-05。
        logger.warn(
          { event: 'linking.open.jd_user_key_mode', app_id: appId, mode: String(mode) },
          'linking: jd user key mode not served',
        );
        throw paused('linking: jd user key mode not served');
      }
    }
    // B1-08s (BR-ATTR-15, BR-ATTR-06): the lk of this conversion's link, while the switch is JSON
    // true now; otherwise byte for byte the identity without it.
    const lk = await injectedLinkCode(owner, renewedCode);
    return platform === 'jd'
      ? new LinkingUnionIdentity({
          appId,
          platform,
          promotionSlot: row.pid,
          userKey: attrCode,
          subUnionId: lk === null ? `n_${attrCode}` : `n_${attrCode}_${lk}`,
        })
      : new LinkingUnionIdentity({
          appId,
          platform,
          promotionSlot: row.pid,
          userKey: attrCode,
          customParameters:
            lk === null
              ? { app: 'n', uid: attrCode, sc: pidScene }
              : { app: 'n', uid: attrCode, sc: pidScene, lk },
        });
  }

  return { identityFor };
}

/** B1-22n: one open's identity check before its re-check (see createConversionPrecheck). */
export interface ConversionPrecheckInput {
  readonly owner: LinkOpenOwnerResult;
  /** The effective no_rebate (BR-ATTR-05 ①). */
  readonly noRebate: boolean;
  readonly traceId: string;
  /** The account in use (the Pinduoduo composition); absent: the scene's slot app-wide (jd). */
  readonly unionAccountId?: string;
}

/**
 * B1-22n (BR-ATTR-05 细则 ⑦ before ⑧; D10-239 T3a): builds, without converting, the identity the
 * conversion of this open would use — the scene's active slot (self_buy for no_rebate) of the
 * account in use, the attr_code and the jd user key mode, all local reads — so a jd / pdd open
 * with none stops with 50301 before any cache, price or union call. Throws the conversion's paused
 * failure; other platforms pass. The conversion itself checks again (unchanged).
 */
export function createConversionPrecheck(options: IdentityReaders) {
  const { identityFor } = createIdentityBuilder({
    config: openScopedConfig(options.config),
    pids: openScopedPids(options.pids),
    attrCodes: openScopedAttrCodes(options.attrCodes),
    logger: options.logger,
  });
  return async function precheck(input: ConversionPrecheckInput): Promise<void> {
    const { owner } = input;
    const platform = owner.link.platform;
    if (platform !== 'jd' && platform !== 'pdd') return;
    await identityFor(owner, platform, input.noRebate, input.traceId, input.unionAccountId);
  };
}

// TODO(规划/11 §4.5): 真实转链 — blocked on 推广位 / siteId。
export function createLinkOpenConversion(options: LinkConversionOptions): LinkConversion {
  const { clock, callerContext, registry, logger } = options;
  const config = openScopedConfig(options.config);
  const pids = openScopedPids(options.pids);
  const attrCodes = openScopedAttrCodes(options.attrCodes);
  const { identityFor } = createIdentityBuilder({ config, pids, attrCodes, logger });

  /** Every read of admit and convert for these identities; failures surface when used. */
  async function prepare(plan: LinkOpenReadPlan): Promise<void> {
    const { appId, platform } = plan;
    const reads: Promise<unknown>[] = [
      config.configValue(appId, CONVERT_CACHE_TTL_SEC),
      config.configValue(appId, `convert.enabled.${platform}`),
      // B1-06zl: the off reason a switched-off admit answers with.
      config.configValue(appId, convertOffReasonKey(platform)),
    ];
    if (platform === 'jd' || platform === 'pdd') {
      reads.push(config.configValue(appId, JD_USER_KEY_MODE));
      reads.push(config.configValue(appId, CLICK_CODE[platform]));
      for (const identity of plan.identities) {
        const pidScene = identity.noRebate ? 'self_buy' : identity.pidScene;
        reads.push(
          pids.getActivePid({
            appId,
            platform,
            pidScene: pidScene as Parameters<typeof pids.getActivePid>[0]['pidScene'],
            purpose: 'convert',
          }),
        );
        if (!identity.noRebate) reads.push(attrCodeOf(attrCodes, appId, identity.userId));
      }
    }
    await Promise.allSettled(reads);
  }

  /**
   * This conversion's jump expiry: now + link.convert_cache_ttl_sec (default and ceiling 900 s;
   * 0 or invalid falls back to 900). links.expire_at only describes the copy issued at
   * registration and is never reused here. The demo / governed adapter reports no URL expiry
   * yet; when one is reported the shorter of the two applies.
   */
  async function jumpExpiry(appId: string): Promise<string> {
    const configured = intSetting(
      (await config.configValue(appId, CONVERT_CACHE_TTL_SEC))?.value,
      URL_LIFETIME_FALLBACK_SEC,
    );
    const sec =
      configured > 0 && configured <= MAX_CONVERT_CACHE_TTL_SEC
        ? configured
        : URL_LIFETIME_FALLBACK_SEC;
    // Every Clock returns a fresh Date, so moving this one is local.
    const at = clock.now();
    at.setTime(at.getTime() + sec * 1000);
    return at.toISOString();
  }

  async function switchOn(appId: string, key: string): Promise<boolean> {
    const value = await config.configValue(appId, key);
    return isSwitchOn(value?.value);
  }

  async function admit(owner: LinkOpenOwnerResult): Promise<void> {
    const { platform, app_id: appId } = owner.link;
    if (platform !== 'jd' && platform !== 'pdd') {
      // TODO(规划/11 §4.5): 淘宝百川打开指令 — blocked on B1-06f。
      throw paused('linking: platform conversion not available');
    }
    if (!(await switchOn(appId, `convert.enabled.${platform}`))) {
      throw paused(
        'linking: platform conversion switched off',
        await convertPausedData(config, appId, platform),
      );
    }
  }

  function variant(input: Pick<JdPddConversionInput, 'client' | 'installed'>): string {
    const client = input.client === 'web' ? 'h5' : input.client;
    const installed = client === 'h5' ? 'unknown' : (input.installed ?? 'unknown');
    return `${client}:${installed}`;
  }

  async function convert(input: JdPddConversionInput): Promise<LinkOpenJump> {
    const { owner } = input;
    await admit(owner);
    const { link } = owner;
    const platform = link.platform as 'jd' | 'pdd';
    const caller = await callerContext.current();
    const noRebate = effectiveNoRebate(caller, owner, input.noRebate);
    const identity = await identityFor(
      owner,
      platform,
      noRebate,
      input.traceId,
      input.unionAccountId,
      input.linkCode,
    );
    let noRebateUrl = '';
    try {
      noRebateUrl =
        link.product_key === null ? '' : noRebateProductUrl(link.product_key, input.item);
    } catch {
      noRebateUrl = '';
    }
    // Alerted only when the conversion fails and no unpromoted page can stand in for it.
    const failedConversion = (message: string) => {
      if (noRebate && noRebateUrl === '') {
        logger.warn(
          { event: 'linking.open.no_rebate_page_unavailable', app_id: link.app_id, platform },
          'linking: no unpromoted product page for the no-rebate purchase',
        );
      }
      return failed(message, noRebateUrl);
    };
    if (link.raw_item_id === null || link.raw_item_id === '') {
      throw failedConversion('linking: link has no raw item id to convert');
    }
    let url: string;
    try {
      const result = await registry
        .get(platform)
        .convert(
          { item: itemRefOf(platform, link.raw_item_id), idempotencyKey: input.idempotencyKey },
          identity,
          { appId: link.app_id, requestId: input.traceId, purpose: 'online' },
        );
      if (result.kind !== 'url') throw new Error('linking: unexpected conversion result');
      url = result.url;
    } catch {
      // No retry here: one adapter call per conversion (governance owns retries and circuits).
      throw failedConversion('linking: conversion failed');
    }
    return buildDefaultLinkJump({
      platform,
      client: input.client,
      installed: input.installed ?? 'unknown',
      paths: pathsOf(platform, url, appSchemeOf(options.apps, platform)),
      expireAt: await jumpExpiry(link.app_id),
    });
  }

  return { convert, admit, variant, prepare };
}

/** Normalized adapter paths, not vendor response payloads. */
export interface LinkJumpPaths {
  /** null: apps.json declares no scheme for the platform, so no scheme step exists. */
  readonly scheme: string | null;
  readonly universalLink: string;
  readonly h5: string;
}

type Step = components['schemas']['JumpStep'];

/** Default matrix for non-production/demo; production capability admission is separate. */
export function buildDefaultLinkJump(input: {
  readonly platform: 'jd' | 'pdd';
  readonly client: LinkOpenRequoteInput['client'];
  readonly installed?: components['schemas']['InstalledState'];
  readonly paths: LinkJumpPaths;
  readonly expireAt: string;
}): LinkOpenJump {
  const { platform, client, paths } = input;
  const schemes: Step[] = paths.scheme === null ? [] : [{ type: 'scheme', value: paths.scheme }];
  const universal: Step = { type: 'universal_link', value: paths.universalLink };
  const h5: Step = { type: 'h5', value: paths.h5 };
  // H5 (and web) cannot detect installed apps: fixed to the browser page (BR-ATTR-27 ①).
  if (client === 'h5' || client === 'web') {
    return { primary: h5, fallbacks: [], expire_at: input.expireAt };
  }
  const installedSteps: Step[] =
    platform === 'jd' && (client === 'ios' || client === 'android')
      ? [...schemes, universal, h5]
      : [...schemes, h5];
  const notInstalled: Step[] = [h5];
  const installed = input.installed ?? 'unknown';
  let steps: Step[];
  if (installed === 'true') steps = installedSteps;
  else if (installed === 'false') steps = notInstalled;
  else {
    // unknown: the installed column, then the not-installed column (deduplicated tail).
    steps = [...installedSteps];
    for (const step of notInstalled) {
      const last = steps.at(-1);
      if (last === undefined || last.type !== step.type || last.value !== step.value) {
        steps.push(step);
      }
    }
  }
  const [primary, ...fallbacks] = steps as [Step, ...Step[]];
  return { primary, fallbacks, expire_at: input.expireAt };
}

const PRODUCT_KEY = /^(jd|pdd):([0-9]{1,20})$/;
/** BR-PROD-03 default jd item mode: jd:i_<B segment>; the page needs the numeric sku instead. */
const JD_ITEM_KEY = /^jd:i_[0-9A-Za-z]{1,128}$/;
const DIGITS = /^[0-9]{1,20}$/;

function pageOf(platform: 'jd' | 'pdd', id: string): string {
  return platform === 'jd'
    ? `https://item.jd.com/${id}.html`
    : `https://mobile.yangkeduo.com/goods.html?goods_id=${id}`;
}

/**
 * Canonical unpromoted product page for the explicit no-rebate action (BR-PRICE-08); never a
 * pasted or converted URL. A numeric key builds it directly. A default item-mode jd key
 * (jd:i_<B>) carries no sku, so the numeric skuId of the latest re-check item of the same
 * platform is used; the union DTO exposes no product-page URL field to prefer over it.
 */
export function noRebateProductUrl(
  productKey: string,
  item?: Pick<ItemRef, 'platform' | 'skuId'> | null,
): string {
  const match = typeof productKey === 'string' ? PRODUCT_KEY.exec(productKey) : null;
  if (match !== null) return pageOf(match[1] as 'jd' | 'pdd', match[2]!);
  if (
    typeof productKey === 'string' &&
    JD_ITEM_KEY.test(productKey) &&
    item?.platform === 'jd' &&
    typeof item.skuId === 'string' &&
    DIGITS.test(item.skuId)
  ) {
    return pageOf('jd', item.skuId);
  }
  throw new Error('linking: not a product key with an unpromoted page');
}
