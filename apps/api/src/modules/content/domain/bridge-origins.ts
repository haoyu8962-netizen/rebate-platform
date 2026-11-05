// The signed bridge_origins whitelist of GET /v1/config (F1-02zzzb; D10-608 / 610 / 612; 规划/04
// §10.1, 03 §5.1 / §5.2). Contract ConfigBridgeOrigins: { jws }, a JWS compact serialization with
// header {alg: "ES256", kid, typ: "couli-bridge-origins+jws"}, payload {v: 1, app_id, env, version,
// origins} and the raw 64-byte R‖S signature (not DER).
//
// - The config item bridge_origins stores the unsigned {origins: string[]}. Saving requires the
//   canonical form (bridgeOriginsSaveProblem); signing reads a stored value leniently (each entry
//   normalized: lowercase host, default port 443 dropped) but never signs an entry that is not an
//   https origin without path, query, fragment, credentials or wildcard, nor a list that lacks the
//   h5_base_url origin. Such a value, or no row at all, signs [origin of h5_base_url].
// - version is the config item's version (0 without a row), so it grows with every save; the
//   default list of a stored but unusable value keeps that row's version.
// - Signatures are cached per signer (one kid) by the exact payload, i.e. per (app_id, env, version,
//   origins): the same version is signed once.
// - The signature is deterministic ES256 (RFC 6979, @noble/curves p256, D10-621): sha256 of the
//   ASCII signing input, no extra entropy, raw r‖s. The same key and payload give byte-identical
//   JWS across restarts and instances, so the /v1/config ETag stays stable. The private scalar is
//   derived in process from the KeyObject and never logged or written anywhere.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for type-only imports.
import type { KeyObject } from 'node:crypto';
import { p256 } from '@noble/curves/nist.js';

export interface BridgeOriginsInput {
  readonly appId: string;
  readonly env: 'local' | 'test' | 'staging' | 'prod';
  readonly h5BaseUrl: string;
  readonly item: { readonly version: number; readonly value: unknown } | null;
}

export interface BridgeOriginsKey {
  readonly kid: string;
  readonly privateKey: KeyObject;
}

export const BRIDGE_ORIGINS_KEY = 'bridge_origins';
export const BRIDGE_ORIGINS_JWS_TYPE = 'couli-bridge-origins+jws';

/** Most distinct payloads one signer keeps (oldest dropped first). */
const CACHE_LIMIT = 1024;

/**
 * The normalized https origin of `text` when it is one (no credentials, path, query, fragment or
 * wildcard), else null. `https://H5.Example.Test:443` → `https://h5.example.test`.
 */
export function httpsOrigin(text: unknown): string | null {
  if (typeof text !== 'string' || text.includes('*') || /[?#\s\\]/.test(text)) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname === '' ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    return null;
  }
  return url.origin;
}

/** The https origin of h5_base_url (any path allowed), or null. */
export function h5Origin(h5BaseUrl: unknown): string | null {
  if (typeof h5BaseUrl !== 'string') return null;
  let url: URL;
  try {
    url = new URL(h5BaseUrl);
  } catch {
    return null;
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname === '' ||
    url.username !== '' ||
    url.password !== ''
  ) {
    return null;
  }
  return url.origin;
}

function originsOf(value: unknown): readonly unknown[] | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const origins = (value as { origins?: unknown }).origins;
  return Array.isArray(origins) && origins.length > 0 ? origins : null;
}

/**
 * The origins a stored value signs (normalized, duplicates dropped, order kept), or null when it is
 * not usable for `home` (the h5_base_url origin).
 */
export function storedBridgeOrigins(value: unknown, home: string): string[] | null {
  const entries = originsOf(value);
  if (entries === null) return null;
  const origins: string[] = [];
  for (const entry of entries) {
    const origin = httpsOrigin(entry);
    if (origin === null) return null;
    if (!origins.includes(origin)) origins.push(origin);
  }
  return origins.includes(home) ? origins : null;
}

/**
 * Whether a written bridge_origins value is acceptable (save-time check): exactly {origins}, a
 * non-empty array of distinct canonical https origins (each equal to its normalized form: lowercase
 * host, no trailing slash, no :443) that contains the h5_base_url origin. False when `h5BaseUrl` has
 * no https origin.
 */
export function bridgeOriginsSaveValid(value: unknown, h5BaseUrl: unknown): boolean {
  const home = h5Origin(h5BaseUrl);
  const entries = originsOf(value);
  if (home === null || entries === null) return false;
  if (Object.keys(value as object).length !== 1) return false;
  const seen = new Set<string>();
  for (const entry of entries) {
    if (typeof entry !== 'string' || httpsOrigin(entry) !== entry || seen.has(entry)) return false;
    seen.add(entry);
  }
  return seen.has(home);
}

function base64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

/** The 32-byte private scalar of a P-256 private KeyObject (in process only). */
function p256Scalar(privateKey: KeyObject): Uint8Array {
  const d = privateKey.export({ format: 'jwk' }).d;
  const scalar = typeof d === 'string' ? Buffer.from(d, 'base64url') : null;
  if (scalar?.length !== 32) {
    throw new Error('bridge origins: the signing key must be a P-256 private key');
  }
  return new Uint8Array(scalar);
}

/**
 * Deterministic ES256 (RFC 6979 nonce, HMAC-DRBG over sha256): sha256(`signingInput`) signed with
 * `scalar`, returned as the 64-byte r‖s of JWS. No extra entropy and no low-S normalization, so the
 * output equals the RFC 6979 A.2.5 vectors and verifies as ES256 everywhere.
 */
export function deterministicEs256(signingInput: Uint8Array, scalar: Uint8Array): Uint8Array {
  return p256.sign(signingInput, scalar, { prehash: true, lowS: false, format: 'compact' });
}

export class BridgeOriginsSigner {
  readonly #kid: string;
  readonly #scalar: Uint8Array;
  readonly #header: string;
  readonly #cache = new Map<string, string>();

  constructor(key: BridgeOriginsKey) {
    const details = key.privateKey.asymmetricKeyDetails;
    if (
      key.privateKey.type !== 'private' ||
      key.privateKey.asymmetricKeyType !== 'ec' ||
      details?.namedCurve !== 'prime256v1'
    ) {
      throw new Error('bridge origins: the signing key must be a P-256 private key');
    }
    if (key.kid === '') throw new Error('bridge origins: the signing key needs a kid');
    this.#kid = key.kid;
    this.#scalar = p256Scalar(key.privateKey);
    this.#header = base64url(
      JSON.stringify({ alg: 'ES256', kid: key.kid, typ: BRIDGE_ORIGINS_JWS_TYPE }),
    );
  }

  get kid(): string {
    return this.#kid;
  }

  /**
   * Whether `item` (the stored row) is used as is; false means the default list is signed. A
   * missing row is not "unusable": callers report only a present row that is not used.
   */
  static usable(item: BridgeOriginsInput['item'], h5BaseUrl: string): boolean {
    const home = h5Origin(h5BaseUrl);
    return item !== null && home !== null && storedBridgeOrigins(item.value, home) !== null;
  }

  sign(input: BridgeOriginsInput): { jws: string } {
    const home = h5Origin(input.h5BaseUrl);
    if (home === null) throw new Error('bridge origins: h5_base_url has no https origin');
    const stored = input.item === null ? null : storedBridgeOrigins(input.item.value, home);
    const version = input.item?.version ?? 0;
    if (!Number.isSafeInteger(version) || version < 0) {
      throw new Error('bridge origins: config item version is not a non-negative integer');
    }
    const payload = JSON.stringify({
      v: 1,
      app_id: input.appId,
      env: input.env,
      version,
      origins: stored ?? [home],
    });
    const cached = this.#cache.get(payload);
    if (cached !== undefined) return { jws: cached };
    const signingInput = `${this.#header}.${base64url(payload)}`;
    const signature = Buffer.from(
      deterministicEs256(Buffer.from(signingInput, 'ascii'), this.#scalar),
    ).toString('base64url');
    const jws = `${signingInput}.${signature}`;
    if (this.#cache.size >= CACHE_LIMIT) {
      const oldest = this.#cache.keys().next().value;
      if (oldest !== undefined) this.#cache.delete(oldest);
    }
    this.#cache.set(payload, jws);
    return { jws };
  }
}
