// F1-02zb: console app-version save — field/format validation (D2–D4) and the BR-ID-01 pre-save
// store check (08 10_ID l.196–198; task §9.2 Z1–Z4, §9.7, §9.8). Pure: no database, clock or logging.
//
// Version comparison follows the same algorithm as platform's compareClientVersions (MAJOR.MINOR.
// PATCH, decimal without leading zeros, components of any length compared numerically). It is
// re-implemented here so this domain module needs no value import from platform (task §9.2 #6);
// the unit test cross-checks the two.

import { isIPv6 } from 'node:net';

export interface AppVersionStoreListing {
  readonly store: string;
  readonly listed_version: string | null;
}

/** Persisted business fields; confirmations belong to the current save request. */
export interface AppVersionSaveRow {
  readonly platform: 'ios' | 'android' | 'harmony';
  readonly channel: 'appstore' | 'official' | 'huawei' | 'agc';
  readonly latest_version: string;
  readonly min_supported_version: string | null;
  readonly recommended_version: string | null;
  readonly update_title: string;
  readonly update_notes: string;
  readonly store_url: string;
  readonly default_store: string;
  readonly store_listings: readonly AppVersionStoreListing[];
}

export interface AppVersionSaveInput extends AppVersionSaveRow {
  readonly confirmed_stores: readonly string[];
}

export type AppVersionSaveField = keyof AppVersionSaveInput;

export type AppVersionSaveValidation =
  | { readonly ok: true; readonly store_table_empty: boolean }
  | {
      readonly ok: false;
      readonly fields: readonly AppVersionSaveField[];
      readonly store_table_empty: boolean;
    };

export type AppVersionSaveCheck =
  | { readonly ok: true; readonly confirmed: readonly string[] }
  | { readonly ok: false; readonly fields: readonly AppVersionSaveField[] };

export type AppVersionMinimum = Pick<AppVersionSaveRow, 'min_supported_version'>;

const SEMANTIC_VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const STORE_KEY = /^[a-z0-9_]{1,32}$/;
const URI_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
/** Any whitespace or control character (C0, DEL, C1) makes the URL unusable as a jump target. */
const URI_FORBIDDEN = /[\s\u0000-\u001f\u007f-\u009f]/u;

/** D3: the manageable platforms and the channels each one may carry. */
const CHANNELS_BY_PLATFORM: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['ios', new Set(['appstore'])],
  ['android', new Set(['official', 'huawei'])],
  ['harmony', new Set(['agc'])],
]);

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isVersion(value: unknown): value is string {
  return typeof value === 'string' && SEMANTIC_VERSION.test(value);
}

function isVersionOrNull(record: Record<string, unknown>, key: string): boolean {
  return hasOwn(record, key) && (record[key] === null || isVersion(record[key]));
}

/**
 * §9.8: store_url is a store's app-detail page; only these schemes may be saved. Adding one is a
 * change here plus a unit test.
 */
export const APP_VERSION_STORE_URL_SCHEMES: readonly string[] = Object.freeze([
  'https',
  'market',
  'appmarket',
  'itms-apps',
]);

/**
 * Authority `[userinfo@]host[:port]`: host non-empty after stripping both; port all digits. A
 * bracketed host must be an IPv6 literal (node:net isIPv6) without a zone id (`%` rejected).
 */
function isAuthority(authority: string): boolean {
  const hostPort = authority.slice(authority.lastIndexOf('@') + 1);
  let host: string;
  let port: string | null;
  if (hostPort.startsWith('[')) {
    const close = hostPort.indexOf(']');
    if (close < 0) return false;
    host = hostPort.slice(1, close);
    if (host.includes('%') || !isIPv6(host)) return false;
    const tail = hostPort.slice(close + 1);
    if (tail.length > 0 && !tail.startsWith(':')) return false;
    port = tail.length > 0 ? tail.slice(1) : null;
  } else {
    const colon = hostPort.indexOf(':');
    host = colon < 0 ? hostPort : hostPort.slice(0, colon);
    port = colon < 0 ? null : hostPort.slice(colon + 1);
  }
  if (host.length === 0) return false;
  return port === null || /^[0-9]+$/u.test(port);
}

/**
 * §9.8 / §9.12: scheme in APP_VERSION_STORE_URL_SCHEMES, no whitespace or control characters;
 * https must be `https://<non-empty host>`; any written authority (`//`) must have a non-empty
 * host and a numeric port, and a bracketed host must be a zone-free IPv6 literal. Judged on the raw string (WHATWG URL would read `https:///x` as host x).
 */
export function isStoreUrl(value: unknown): boolean {
  if (typeof value !== 'string' || URI_FORBIDDEN.test(value)) return false;
  const scheme = URI_SCHEME.exec(value);
  if (scheme === null) return false;
  const name = scheme[0].slice(0, -1).toLowerCase();
  if (!APP_VERSION_STORE_URL_SCHEMES.includes(name)) return false;
  const rest = value.slice(scheme[0].length);
  if (rest.length === 0) return false;
  if (!rest.startsWith('//')) return name !== 'https';
  const authority = rest.slice(2).split(/[/?#]/u, 1)[0] ?? '';
  return isAuthority(authority);
}

function isStoreKey(value: unknown, storeKeys: ReadonlySet<string>): value is string {
  if (typeof value !== 'string' || !STORE_KEY.test(value)) return false;
  return storeKeys.size === 0 || storeKeys.has(value);
}

function isStoreListings(value: unknown, storeKeys: ReadonlySet<string>): boolean {
  if (!Array.isArray(value)) return false;
  const seen = new Set<string>();
  for (const item of value as unknown[]) {
    if (!isRecord(item)) return false;
    if (!isStoreKey(item['store'], storeKeys) || seen.has(item['store'])) return false;
    if (!isVersionOrNull(item, 'listed_version')) return false;
    seen.add(item['store']);
  }
  return true;
}

function isStringArray(value: unknown): boolean {
  return Array.isArray(value) && (value as unknown[]).every((item) => typeof item === 'string');
}

/** F1-02zb D2–D4: shape/format only; storeKeys are scoped by the caller to platform/channel. */
export function validateAppVersionSave(
  input: unknown,
  storeKeys: readonly string[],
): AppVersionSaveValidation {
  const keys = new Set(storeKeys);
  const storeTableEmpty = keys.size === 0;
  const record: Record<string, unknown> = isRecord(input) ? input : {};
  const fields: AppVersionSaveField[] = [];

  const channels =
    typeof record['platform'] === 'string'
      ? CHANNELS_BY_PLATFORM.get(record['platform'])
      : undefined;
  if (channels === undefined) {
    // §9.7: an invalid platform skips the channel pairing; fields is exactly ['platform'].
    fields.push('platform');
  } else if (typeof record['channel'] !== 'string' || !channels.has(record['channel'])) {
    fields.push('channel');
  }
  if (!isVersion(record['latest_version'])) fields.push('latest_version');
  if (!isVersionOrNull(record, 'min_supported_version')) fields.push('min_supported_version');
  if (!isVersionOrNull(record, 'recommended_version')) fields.push('recommended_version');
  if (typeof record['update_title'] !== 'string') fields.push('update_title');
  if (typeof record['update_notes'] !== 'string') fields.push('update_notes');
  if (!isStoreUrl(record['store_url'])) fields.push('store_url');
  if (!isStoreKey(record['default_store'], keys)) fields.push('default_store');
  if (!isStoreListings(record['store_listings'], keys)) fields.push('store_listings');
  if (!isStringArray(record['confirmed_stores'])) fields.push('confirmed_stores');

  return fields.length === 0
    ? { ok: true, store_table_empty: storeTableEmpty }
    : { ok: false, fields, store_table_empty: storeTableEmpty };
}

/** Numeric order of two decimal integers written without leading zeros. */
function compareNumbers(left: string, right: string): -1 | 0 | 1 {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** Numeric MAJOR.MINOR.PATCH order of two validated versions; throws on malformed input. */
export function compareAppVersions(left: string, right: string): -1 | 0 | 1 {
  const a = SEMANTIC_VERSION.exec(left);
  const b = SEMANTIC_VERSION.exec(right);
  if (a === null || b === null) throw new TypeError('version must be MAJOR.MINOR.PATCH');
  for (let index = 1; index <= 3; index += 1) {
    const order = compareNumbers(a[index]!, b[index]!);
    if (order !== 0) return order;
  }
  return 0;
}

/** Z4: the same raise predicate used by the save check and the caller's step-up selection. */
export function isMinSupportedRaise(
  before: AppVersionMinimum | null,
  after: AppVersionMinimum,
): boolean {
  const next = after.min_supported_version;
  if (next === null) return false;
  const previous = before === null ? null : before.min_supported_version;
  return previous === null || compareAppVersions(next, previous) > 0;
}

function listingMap(listings: readonly AppVersionStoreListing[]): Map<string, string | null> {
  return new Map(listings.map((listing) => [listing.store, listing.listed_version]));
}

/** Any store added, removed or with a changed listed version; reordering alone is no change. */
function listingsChanged(
  before: readonly AppVersionStoreListing[],
  after: readonly AppVersionStoreListing[],
): boolean {
  const previous = listingMap(before);
  const next = listingMap(after);
  if (previous.size !== next.size) return true;
  for (const [store, version] of next) {
    if (!previous.has(store) || previous.get(store) !== version) return true;
  }
  return false;
}

function meetsMinimum(version: string | null | undefined, minimum: string): boolean {
  return typeof version === 'string' && compareAppVersions(version, minimum) >= 0;
}

/** BR-ID-01 / Z1–Z3: inputs have passed validation; failures map to 20001 data.fields. */
export function checkAppVersionSave(
  before: AppVersionSaveRow | null,
  after: AppVersionSaveInput,
): AppVersionSaveCheck {
  const minimum = after.min_supported_version;
  if (minimum === null) return { ok: true, confirmed: [] };

  // Versions are canonical (no leading zeros), so string inequality is numeric inequality.
  const minChanged = before === null || before.min_supported_version !== minimum;
  const defaultChanged = before === null || before.default_store !== after.default_store;
  const storesChanged =
    before === null || listingsChanged(before.store_listings, after.store_listings);
  if (!isMinSupportedRaise(before, after) && !defaultChanged && !storesChanged) {
    return { ok: true, confirmed: [] };
  }

  // Rule ①: the default store must be listed at or above the post-save minimum.
  const listed = listingMap(after.store_listings);
  if (!meetsMinimum(listed.get(after.default_store), minimum)) {
    const fields: AppVersionSaveField[] = [];
    if (minChanged) fields.push('min_supported_version');
    if (defaultChanged) fields.push('default_store');
    if (storesChanged) fields.push('store_listings');
    return { ok: false, fields };
  }

  // Rule ②: every other store that is unknown or below the minimum needs this save's confirmation.
  const confirmedNow = new Set(after.confirmed_stores);
  const lagging = after.store_listings
    .filter((listing) => listing.store !== after.default_store)
    .filter((listing) => !meetsMinimum(listing.listed_version, minimum))
    .map((listing) => listing.store);
  if (lagging.some((store) => !confirmedNow.has(store))) {
    return { ok: false, fields: ['confirmed_stores'] };
  }
  return { ok: true, confirmed: lagging };
}
