// GET /v1/config (task F1-02c; contract getConfig → Config, 04 §10.1): which config_items keys
// the response is assembled from, the shape each value must have (the contract's schema of the
// part it fills), the keys' planned defaults and the per-caller derivations (platform_status,
// search_status, the two derived flags, agent availability, the h5_release bucket, claim days).
// Pure: values come in as read, the caller supplies the viewer and the link pattern table, and
// every rejected value is reported through `report` (the caller logs it).
//
// Also compiled by the `test` project: erasable syntax only, `import type` for type-only imports.
import { createHash } from 'node:crypto';
import ajvFormats from 'ajv-formats';
import type { Schema } from '@couli/contracts-ts';
import { addFen, parseFen, subFen } from '@couli/money';
import type { ConfigReport, ConfigValues } from './config-values.ts';
import { isDedicatedConfigKey } from './dedicated-config-keys.ts';
import { deriveInviteEligibilityDays } from './invite-eligibility.ts';

export type ClientConfig = Schema<'Config'>;
type PlatformCode = Schema<'PlatformCode'>;
type PurchaseStatus = Schema<'PlatformPurchaseStatus'>;
type SearchStatus = Schema<'PlatformSearchStatus'>;
type HelpLinkTarget = Schema<'HelpLinkTarget'>;

/** Every PlatformCode of the contract: both derived maps cover all of them. */
export const PLATFORM_CODES = [
  'taobao',
  'jd',
  'pdd',
  'meituan',
  'vip',
  'douyin',
  'eleme',
  'kuaishou',
  'suning',
] as const satisfies readonly PlatformCode[];

/** Keys whose absence or wrong shape fails the whole response (no planned default). */
export const REQUIRED_CONFIG_KEYS = [
  'h5_base_url',
  'h5_release.stable',
  'kf',
  'legal.privacy.version',
  'legal.privacy.min_version',
  'legal.agreement.version',
] as const;

/** Keys that fall back to their default when absent or of the wrong shape. */
const OPTIONAL_CONFIG_KEYS = [
  'h5_release.canary',
  'share_domains',
  'dict_version',
  'features.flags',
  'texts',
  'invite.backfill_hours',
  'invite.bind_phone_guide',
  'invite.before_buy_tip',
  'jump_tip',
  'clipboard',
  // F1-02zzzb: bridge_origins is not read here: the service reads its row afresh and signs it.
  'auth_tips',
  'compliance',
  'display',
  'external_page.nav_host_sample_bp',
  'external_page.union_host_block',
  'earnings.dashboard.enabled',
  // F1-02zzze (D10-691): sources of the derived flags product_feedback / jd_plus_note.
  'feedback.enabled',
  'detail.jd_plus_note.enabled',
  'external_hosts',
  'app_update.recheck_interval_sec',
  'help_links',
  'agent.enabled',
  'agent.whitelist_only',
  'agent.whitelist_user_ids',
  'agent.filing_text',
  'agent.examples',
  'agent.guest_daily_quota',
  'agent.require_phone',
  'claim.window_hours',
  // F1-02h: not the same-named keys lkg_max_age_sec / bridge_disabled_methods.
  'config.lkg_max_age_sec',
  'bridge.disabled_methods',
  // F1-02zp (BR-INV-24): invite.reward_* is derived from these, never read from same-named keys.
  'growth.invite_reward.enabled',
  'growth.invite_reward.amount_fen',
  // F1-02zze (BR-INV-24): invite.eligibility_days; never the same-named invite.eligibility_days.
  'growth.invite_reward.eligibility_days',
  // F1-02zr (L24): delivered only when present and int32 >= 1; written by agreement publishing.
  'legal.agreement.min_version',
] as const;

/** Every config_items key GET /v1/config reads (link_patterns is not one: platform's table). */
/** F1-02zzj: a dedicated-port key (./dedicated-config-keys.ts) is never read here. */
export const CLIENT_CONFIG_KEYS: readonly string[] = [
  ...REQUIRED_CONFIG_KEYS,
  ...OPTIONAL_CONFIG_KEYS,
  ...PLATFORM_CODES.flatMap((p) => [
    `convert.enabled.${p}`,
    `convert.off_reason.${p}`,
    `search.enabled.${p}`,
  ]),
].filter((key) => !isDedicatedConfigKey(key));

/** The h5_release bucket count: percent_bp is in 1/10000. */
export const H5_BUCKETS = 10_000;
const INT32_MAX = 2_147_483_647;

/** Values as read and the report channel (moved to config-values.ts by F1-02zze; re-exported). */
export type { ConfigReport, ConfigValues } from './config-values.ts';

export interface ConfigViewer {
  readonly appId: string;
  /** null for a guest. */
  readonly userId: string | null;
}

export const INVITE_REWARD_ENABLED_KEY = 'growth.invite_reward.enabled';
export const INVITE_REWARD_AMOUNT_KEY = 'growth.invite_reward.amount_fen';
/** BR-INV-24: the per-party amount when growth.invite_reward.amount_fen is absent or malformed. */
export const INVITE_REWARD_DEFAULT_AMOUNT_FEN = 1000;

export interface InviteRewardInput {
  readonly values: ConfigValues;
  /** undefined: port not installed; null: available budget could not be calculated. */
  readonly availableBudgetFen: number | null | undefined;
  readonly report: ConfigReport;
}

/**
 * Whether the reward switch is on: only JSON true (absent or any other value is off). The caller
 * asks the budget port only when this holds; reporting a malformed switch is left to
 * deriveInviteReward.
 */
export function inviteRewardSwitchOn(values: ConfigValues): boolean {
  return values.get(INVITE_REWARD_ENABLED_KEY) === true;
}

/**
 * BR-INV-24 ① / ⑨ / F1-02zp: derive the two always-delivered invitation reward fields.
 * reward_enabled = switch is JSON true, and the total available budget (fen; growth computes total
 * budget minus occupied minus paid) is a safe integer of at least both parties' amounts.
 * reward_amount_fen = the per-party amount (int32 range), else the 08 default, even when off.
 */
export function deriveInviteReward(
  input: InviteRewardInput,
): Required<Pick<Schema<'ConfigInvite'>, 'reward_enabled' | 'reward_amount_fen'>> {
  const { values, availableBudgetFen, report } = input;
  if (values.has(INVITE_REWARD_ENABLED_KEY) && !isBoolean(values.get(INVITE_REWARD_ENABLED_KEY))) {
    report.invalid(INVITE_REWARD_ENABLED_KEY);
  }
  let amount = INVITE_REWARD_DEFAULT_AMOUNT_FEN;
  if (values.has(INVITE_REWARD_AMOUNT_KEY)) {
    const value = values.get(INVITE_REWARD_AMOUNT_KEY);
    if (intIn(0, INT32_MAX)(value)) amount = value;
    else report.invalid(INVITE_REWARD_AMOUNT_KEY);
  }
  return {
    reward_enabled:
      inviteRewardSwitchOn(values) &&
      typeof availableBudgetFen === 'number' &&
      Number.isSafeInteger(availableBudgetFen) &&
      budgetCoversBothParties(availableBudgetFen, amount),
    reward_amount_fen: amount,
  };
}

/** available − (amount + amount) ≥ 0, in bigint fen through @couli/money (hard rule 1). */
function budgetCoversBothParties(availableFen: number, amountFen: number): boolean {
  const perParty = parseFen(amountFen);
  return subFen(parseFen(availableFen), addFen(perParty, perParty)) >= 0n;
}

export interface ClientConfigInput {
  readonly values: ConfigValues;
  readonly viewer: ConfigViewer;
  /** Guest bucketing subject (the X-Device-Id header), used only when there is no user. */
  readonly deviceId: string | null;
  /** platform's getLinkPatterns(), sent as is. */
  readonly linkPatterns: NonNullable<ClientConfig['link_patterns']>;
  /** features.rank_platforms, derived from platform's material channel whitelist (F1-02h). */
  readonly rankPlatforms: readonly PlatformCode[];
  /**
   * F1-02zp: the total available invitation reward budget in fen, as the budget port answered
   * (null: could not be calculated); absent when the port is not installed or was not asked.
   */
  readonly inviteRewardBudgetFen?: number | null;
  /**
   * F1-02zzzb: the signed bridge_origins whitelist (domain/bridge-origins.ts), which needs the
   * validated h5_base_url and the signing key, so ClientConfigService fills it after this build.
   * Absent: an empty placeholder JWS that no client accepts (direct domain callers only).
   */
  readonly bridgeOrigins?: ClientConfig['bridge_origins'];
  readonly report: ConfigReport;
}

// ---- shape checks (the contract schema of the part each key fills) ----

// The contract's `format: uri`, exactly as ajv-formats (the response validator) reads it.
const isUri = ajvFormats.default.get('uri') as (value: string) => boolean;

type Check<T> = (value: unknown) => value is T;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function hasExactly(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((k) => Object.hasOwn(value, k));
}
function intIn(min: number, max: number): Check<number> {
  return (value): value is number =>
    typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}
const isString: Check<string> = (value): value is string => typeof value === 'string';
const isNonEmptyString: Check<string> = (value): value is string =>
  typeof value === 'string' && value !== '';
const isBoolean: Check<boolean> = (value): value is boolean => typeof value === 'boolean';
const isUriString: Check<string> = (value): value is string =>
  typeof value === 'string' && isUri(value);
const isFreeForm: Check<Record<string, unknown>> = isPlainObject;
// Contract ConfigClipboard: an object whose consent_version, when present, is a string of 1..64
// characters counted as Unicode code points (as ajv's minLength / maxLength count them).
// Other fields pass through as-is.
const CONSENT_VERSION_MAX = 64;
const isConfigClipboard: Check<Record<string, unknown>> = (
  value,
): value is Record<string, unknown> => {
  if (!isPlainObject(value)) return false;
  if (!Object.hasOwn(value, 'consent_version')) return true;
  const version = value['consent_version'];
  if (typeof version !== 'string') return false;
  const length = [...version].length;
  return length >= 1 && length <= CONSENT_VERSION_MAX;
};
function arrayOf<T>(item: Check<T>): Check<T[]> {
  return (value): value is T[] => Array.isArray(value) && value.every((v) => item(v));
}
function dictOf<T>(item: Check<T>): Check<Record<string, T>> {
  return (value): value is Record<string, T> =>
    isPlainObject(value) && Object.values(value).every((v) => item(v));
}
const isKf: Check<{ url: string }> = (value): value is { url: string } =>
  isPlainObject(value) && hasExactly(value, ['url']) && isUriString(value['url']);
const isHelpLinkTarget: Check<HelpLinkTarget> = (value): value is HelpLinkTarget =>
  isPlainObject(value) &&
  hasExactly(value, ['route', 'params']) &&
  value['route'] === 'Help' &&
  isPlainObject(value['params']) &&
  hasExactly(value['params'], ['article_id']) &&
  isNonEmptyString(value['params']['article_id']);

interface Canary {
  readonly version: string;
  readonly percent_bp: number;
}
const isCanary: Check<Canary> = (value): value is Canary =>
  isPlainObject(value) &&
  hasExactly(value, ['version', 'percent_bp']) &&
  isNonEmptyString(value['version']) &&
  intIn(0, H5_BUCKETS)(value['percent_bp']);

const isVersion = intIn(1, INT32_MAX);

/** The contract's bridge method name (`namespace.method`). */
const BRIDGE_METHOD = /^[a-z][a-zA-Z0-9]*\.[a-z][a-zA-Z0-9]*$/;
const isBridgeMethods: Check<string[]> = (value): value is string[] =>
  Array.isArray(value) &&
  value.every((v) => typeof v === 'string' && BRIDGE_METHOD.test(v)) &&
  new Set(value).size === value.length;

/**
 * F1-02zzq (04 §10.1 nickname): the nickname limits /v1/config always sends. Values only from
 * 08 BR-ID-39 (nickname 1–16 characters) and 05 B1-20 (at most 3 successful changes per calendar
 * month); a server constant, never read from config_items (no key, same-named or not, overrides it).
 */
export const NICKNAME_LIMITS: Readonly<Schema<'ConfigNickname'>> = Object.freeze({
  min_len: 1,
  max_len: 16,
  monthly_limit: 3,
});

/** 04 §10.1: the proxy default of lkg_max_age_sec (7 days). */
export const LKG_MAX_AGE_DEFAULT_SEC = 604_800;

// ---- derivations ----

/** convert.enabled is on for JSON true or 'on' (the switch reading linking uses too). */
export function isSwitchOn(value: unknown): boolean {
  return value === true || value === 'on';
}

/** on when convert is on; else maintenance only for off_reason exactly 'maintenance'. */
export function purchaseStatus(enabled: unknown, offReason: unknown): PurchaseStatus {
  if (isSwitchOn(enabled)) return 'on';
  return offReason === 'maintenance' ? 'maintenance' : 'not_launched';
}

/** Only JSON true opens search. */
export function searchStatus(enabled: unknown): SearchStatus {
  return enabled === true ? 'on' : 'off';
}

/**
 * Agent availability (BR-ID-03 / BR-AI-12): agent.enabled is JSON true, and either the
 * whitelist is off (only JSON false turns it off) or the user is in the list. A guest is never
 * in the list.
 */
export function agentOpen(input: {
  readonly enabled: unknown;
  readonly whitelistOnly: boolean;
  readonly whitelist: readonly string[];
  readonly userId: string | null;
}): boolean {
  if (input.enabled !== true) return false;
  if (!input.whitelistOnly) return true;
  return input.userId !== null && input.whitelist.includes(input.userId);
}

/**
 * The caller's h5 bucket in [0, 10000): the first 8 bytes of sha256(UTF-8(appId + ':' +
 * subject)) as a big-endian unsigned number, mod 10000.
 */
export function h5Bucket(appId: string, subject: string): number {
  const digest = createHash('sha256').update(`${appId}:${subject}`, 'utf8').digest();
  return Number(digest.readBigUInt64BE(0) % BigInt(H5_BUCKETS));
}

/** claim.window_hours rounded down to days; null below one day or for anything but 1..int32. */
export function windowDays(hours: unknown): number | null {
  if (!intIn(1, INT32_MAX)(hours)) return null;
  const days = Math.floor(hours / 24);
  return days < 1 ? null : days;
}

// ---- assembly ----

/**
 * The Config of one caller, or `undefined` when a required key is absent or of the wrong shape
 * (every such key is reported; the caller answers 50001).
 */
export function buildClientConfig(input: ClientConfigInput): ClientConfig | undefined {
  const { values, viewer, report } = input;
  let failed = false;

  function required<T>(key: string, check: Check<T>): T | undefined {
    const value = values.get(key);
    if (values.has(key) && check(value)) return value;
    report.missing(key);
    failed = true;
    return undefined;
  }
  function optional<T>(key: string, check: Check<T>, fallback: T): T {
    if (!values.has(key)) return fallback;
    const value = values.get(key);
    if (check(value)) return value;
    report.invalid(key);
    return fallback;
  }
  /** A switch read by its own rule; a non-boolean value is reported but still read by the rule. */
  function switchValue(key: string, accepts: (value: unknown) => boolean = isBoolean): unknown {
    if (!values.has(key)) return undefined;
    const value = values.get(key);
    if (!accepts(value)) report.invalid(key);
    return value;
  }

  const h5BaseUrl = required('h5_base_url', isUriString);
  const stable = required('h5_release.stable', isNonEmptyString);
  const kf = required('kf', isKf);
  const privacyVersion = required('legal.privacy.version', isVersion);
  const privacyMin = required('legal.privacy.min_version', isVersion);
  const agreementVersion = required('legal.agreement.version', isVersion);
  // L24: optional, absent (or malformed, reported) means not delivered; never compared to version.
  const agreementMin = optional<number | undefined>(
    'legal.agreement.min_version',
    isVersion,
    undefined,
  );

  // A null canary means "no canary" (not reported); any other wrong shape is reported.
  const canaryValue = values.get('h5_release.canary');
  const canary =
    canaryValue === null || canaryValue === undefined
      ? null
      : optional<Canary | null>('h5_release.canary', isCanary, null);

  const platformStatus = {} as Record<PlatformCode, PurchaseStatus>;
  const searchStatuses = {} as Record<PlatformCode, SearchStatus>;
  for (const platform of PLATFORM_CODES) {
    platformStatus[platform] = purchaseStatus(
      switchValue(`convert.enabled.${platform}`, (v) => isBoolean(v) || v === 'on'),
      switchValue(
        `convert.off_reason.${platform}`,
        (v) => v === 'maintenance' || v === 'not_launched',
      ),
    );
    searchStatuses[platform] = searchStatus(switchValue(`search.enabled.${platform}`));
  }

  const flags: Record<string, boolean> = {
    ...optional('features.flags', dictOf(isBoolean), {}),
    // Derived keys win over a same-named entry of the base dictionary.
    'external_page.union_host_block': switchValue('external_page.union_host_block') !== false,
    'earnings.dashboard.visible': switchValue('earnings.dashboard.enabled') !== false,
    product_feedback: switchValue('feedback.enabled') !== false,
    jd_plus_note: switchValue('detail.jd_plus_note.enabled') !== false,
  };

  const whitelistOnly = switchValue('agent.whitelist_only') !== false;
  const agent = {
    enabled: agentOpen({
      enabled: switchValue('agent.enabled'),
      whitelistOnly,
      whitelist: optional('agent.whitelist_user_ids', arrayOf(isString), []),
      userId: viewer.userId,
    }),
    whitelist_only: whitelistOnly,
    filing_text: optional('agent.filing_text', isString, ''),
    examples: optional('agent.examples', arrayOf(isString), []),
    guest_daily_quota: optional('agent.guest_daily_quota', intIn(0, INT32_MAX), 3),
    require_phone: switchValue('agent.require_phone') === true,
  };

  const hours = values.get('claim.window_hours');
  if (values.has('claim.window_hours') && hours !== null && !intIn(-INT32_MAX, INT32_MAX)(hours)) {
    report.invalid('claim.window_hours');
  }

  const config: ClientConfig = {
    dict_version: optional('dict_version', isString, '0'),
    h5_base_url: h5BaseUrl ?? '',
    h5_release: { version: releaseVersion(stable ?? '', canary, input) },
    share_domains: optional('share_domains', arrayOf(isString), []),
    features: {
      flags,
      platform_status: platformStatus,
      search_status: searchStatuses,
      rank_platforms: [...input.rankPlatforms],
    },
    texts: optional('texts', dictOf(isString), {}),
    legal: {
      privacy: { version: privacyVersion ?? 1, min_version: privacyMin ?? 1 },
      agreement: {
        version: agreementVersion ?? 1,
        ...(agreementMin === undefined ? {} : { min_version: agreementMin }),
      },
    },
    invite: {
      // Always false in the MVP (BR-INV-06); never read from config_items.
      required: false,
      backfill_hours: optional('invite.backfill_hours', intIn(0, INT32_MAX), 168),
      bind_phone_guide: optional('invite.bind_phone_guide', isBoolean, true),
      before_buy_tip: optional('invite.before_buy_tip', isBoolean, true),
      ...deriveInviteReward({
        values,
        availableBudgetFen: input.inviteRewardBudgetFen,
        report,
      }),
      eligibility_days: deriveInviteEligibilityDays(values, report),
    },
    agent,
    kf: kf ?? { url: '' },
    jump_tip: optional('jump_tip', isFreeForm, {}),
    clipboard: optional('clipboard', isConfigClipboard, {}),
    bridge_origins: input.bridgeOrigins ?? { jws: '' },
    auth_tips: optional('auth_tips', isFreeForm, {}),
    compliance: optional('compliance', isFreeForm, {}),
    display: optional('display', isFreeForm, {}),
    external_page: {
      nav_host_sample_bp: optional('external_page.nav_host_sample_bp', intIn(0, H5_BUCKETS), 1000),
    },
    link_patterns: input.linkPatterns,
    external_hosts: optional('external_hosts', arrayOf(isNonEmptyString), []),
    app_update: {
      recheck_interval_sec: optional('app_update.recheck_interval_sec', intIn(1, INT32_MAX), 1800),
    },
    help_links: optional('help_links', dictOf(isHelpLinkTarget), {}),
    claim: { window_days: windowDays(hours) },
    lkg_max_age_sec: optional(
      'config.lkg_max_age_sec',
      intIn(1, INT32_MAX),
      LKG_MAX_AGE_DEFAULT_SEC,
    ),
    bridge_disabled_methods: [...optional('bridge.disabled_methods', isBridgeMethods, [])],
    // F1-02zzq: always sent, a fresh copy of the constant (never from config_items).
    nickname: { ...NICKNAME_LIMITS },
  };
  return failed ? undefined : config;
}

/** stable, unless the caller's bucket (user_id, else the guest's device) is below percent_bp. */
function releaseVersion(
  stable: string,
  canary: Canary | null,
  input: Pick<ClientConfigInput, 'viewer' | 'deviceId'>,
): string {
  if (canary === null) return stable;
  const subject = input.viewer.userId ?? input.deviceId;
  if (subject === null || subject === '') return stable;
  return h5Bucket(input.viewer.appId, subject) < canary.percent_bp ? canary.version : stable;
}
