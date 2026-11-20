// App session tokens (规划/08 BR-ID-07; 规划/02 §12.1 access_token row) and the token stages of the
// rejection order (BR-ID-01 判定顺序 ② 令牌 10001 / 10002 → ③ App 来源 10403).
//
// access_token: a JWT signed with ES256 (jose; algorithms pinned to ES256, curve P-256), header
// { alg, kid, typ: JWT }, claims uid, app_id, sid, device_id, scp plus iss / aud / iat / exp, valid
// ACCESS_TOKEN_TTL_SECONDS from the injected Clock. Verification looks the header's kid up among the
// local public keys (current + previous, JWT_VERIFY_KEYS_JSON; never a remote key set), checks
// issuer, audience, typ and expiry with a clock tolerance of 0 against the same Clock (expired from
// the second exp names; orchestrator ruling B1-02h §9.5 #6), and every jose failure becomes 10002.
// refresh_token: 32 random bytes (base64url); only its SHA-256 (hex) is stored, expiring
// REFRESH_TOKEN_TTL_MS after issue (rotation and reuse detection are B1-02k).
//
// The signing key comes through a small key port (TokenKeyProvider, ADR-0001 §2 自有 KeyProvider
// 接口): this task reads it from loadConfig's JWT_* variables (platform/config/jwt.ts) and, in
// local / test without them, generates one ephemeral key pair per process; staging / prod without
// them refuse to start. KMS signing (`sign(bytes)` returning DER, converted to R‖S) is a later
// task (§9.5 #3).
// B1-02zj (D10-255 ①): a process that only verifies (stream) builds createTokenVerifyKeyProvider
// (JWT_KEY_ID + public keys, never a private key) and createTokenVerifyService, which verifies
// exactly like createTokenService (shared createTokenVerifiers) and refuses to sign.
//
// createTokenCheck is the RequestCheck app.module places right after the signature check (①) at
// the platform's pre-parsing registration point, so it answers before any body is read or
// validated (20001) and before idempotency (1xxxx are never recorded, BR-ID-10 细则). Per matched
// route, by the contract's x-auth (platform auth-routes, planned operations included):
//   - outside the contract: nothing is read, nothing is checked (no Authorization, no ③);
//   - none: Authorization is never read (a refresh with an expired access token is not 10002);
//   - optional: no Authorization → anonymous; with one it must be valid (10002);
//   - login / phone / realname: no Authorization → 10001; malformed (not `Bearer <token>`, empty,
//     repeated: the registration point hands every value of a repeated header as an array, also
//     over real HTTP where Node keeps only the first), bad signature, unknown kid, wrong issuer /
//     audience, expired, claims missing, or
//     a session that does not exist or is revoked → 10002. The session (sessions, by app_id and
//     sid) is read on every request, so a revocation applies to the next one (§9.3 #2).
//   - admin / super (admin console levels, admin_auth_level; an admin_token, never an app token):
//     fail closed with 10001 whether or not Authorization is sent; nothing is read (no header, no
//     session, no ③). No app token can satisfy them and the admin token check does not exist yet.
//   ③ with a token: X-App-Id must equal the token's app_id; without one, on a contract x-signed
//   route: X-App-Id must equal the app_id of the device stage ① verified. Missing, repeated or
//   different → 10403 (§9.5 #8). Unsigned anonymous requests have no ③ here (§9.5 #2).
// On success the verified claims are attached as the request's principal (platform
// token-context); nothing in it comes from a header.
// h5_token (B1-02f, BR-ID-32): a token that is not an access token but verifies as aud=h5 is
// accepted with its own rules (createTokenCheck's comment): live issuing session (10002), routes
// outside its scope 10403, read_only only GET (10403 h5_read_only), both also on x-auth none. The
// step_up_token (aud=step_up) is signed here (signScopedToken) and never accepted by this check. The session scope is not enforced here:
// deletion_only passes ② ③ and the 10405 of x-session-scopes is stage ④a (B1-03c).
// Nothing here logs; tokens and keys never leave these functions except as the issued strings.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for type-only imports,
// relative imports with `.ts`, no decorators.
import {
  createHash,
  createPublicKey,
  generateKeyPair,
  randomBytes,
  type KeyObject,
} from 'node:crypto';
import { promisify } from 'node:util';
import type { errorCodes, SessionScope } from '@couli/contracts-ts';
import { SignJWT, errors, jwtVerify, type JWTPayload } from 'jose';
import {
  RequestRejection,
  contractAuthOf,
  isContractSignedRoute,
  isJwtKeyId,
  parseP256PrivateKeyPem,
  parseP256PublicKeyPem,
  type AppEnv,
  type Clock,
  type JwtKeyConfig,
  type RequestCheck,
  type RequestCheckInput,
  type TokenPrincipal,
} from '../../platform/index.ts';
import { STEP_UP_FAILURE, STEP_UP_PHONE_BINDING_CLAIM } from '../domain/step-up-digest.ts';

/** BR-ID-07: an access token is valid for 2 hours. */
export const ACCESS_TOKEN_TTL_SECONDS = 2 * 60 * 60;
/** BR-ID-07: a refresh token is valid for 30 days from its issue (rotation restarts it, B1-02k). */
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Orchestrator ruling B1-02h §9.3 #9: 32 random bytes. */
const REFRESH_TOKEN_BYTES = 32;
/** Who issues App access tokens (the api entry; admin tokens get their own key and issuer). */
const ISSUER = 'couli-api';
/** App tokens; the read-only h5_token of BR-ID-32 (aud=h5) is a different audience (B1-02f). */
const AUDIENCE = 'app';
/** BR-ID-32: the h5_token audience (B1-02f); same issuer and keys as the access token. */
export const H5_AUDIENCE = 'h5';
/** BR-ID-08: the step_up_token audience (B1-02f); same issuer and keys as the access token. */
export const STEP_UP_AUDIENCE = 'step_up';
/** Scopes of an h5_token (contract H5TokenScope; BR-ID-32 细则「只读作用域」). */
export type H5Scope = 'standard' | 'read_only';
const H5_SCOPES: ReadonlySet<unknown> = new Set<H5Scope>(['standard', 'read_only']);
/**
 * Paths an h5_token never reaches (BR-ID-32: withdrawal, payout account, phone change, deletion,
 * the labor agreement (BR-WDR-31), and every /v1/auth/** route including the h5-token exchange
 * itself). The four sensitive
 * operations sit under these prefixes; x-signed routes are refused through the signing table.
 */
const H5_EXCLUDED_PREFIXES: readonly string[] = Object.freeze([
  '/v1/withdrawals',
  '/v1/me/payout-account',
  '/v1/me/phone',
  '/v1/me/deletion',
  // BR-WDR-31 (B1-13h): native App only, the GET included (contract getLaborAgreement).
  '/v1/me/labor-agreement',
]);
const H5_EXCLUDED_AUTH_PREFIX = '/v1/auth/';
/** Fallback text of 10403 data.reason=h5_read_only (contracts/texts.default.json). */
export const H5_READ_ONLY_MSG = '暂时无法操作，请稍后再试';
const SCOPES: ReadonlySet<unknown> = new Set<SessionScope>(['full', 'deletion_only']);
/** Upper bound of a claim's length: the ids are UUIDs, app_id is short, sid is opaque. */
const MAX_CLAIM_LENGTH = 128;

type TokenCode = 10001 | 10002 | 10403;

/**
 * HTTP status (contracts/error-codes.yaml `http`; `satisfies` fails the build when the generated
 * catalogue disagrees) and fallback text (`msg`; clients show their dictionary text error.<code>)
 * of the token stages: the first clause of the contract `meaning`. Fixed texts, never a value.
 */
export const TOKEN_REJECTIONS = Object.freeze({
  10001: Object.freeze({ http: 401, msg: '未登录' }),
  10002: Object.freeze({ http: 401, msg: 'access_token 过期' }),
  10403: Object.freeze({ http: 403, msg: 'App 或请求来源不被允许（含令牌作用域越权）' }),
} as const) satisfies {
  readonly [C in TokenCode]: Pick<(typeof errorCodes)[C], 'http'> & { readonly msg: string };
};

/** The global error filter answers these with their status and { code, msg, trace_id }, no data. */
export class TokenRejection extends RequestRejection {
  declare readonly code: TokenCode;

  constructor(code: TokenCode) {
    super(code, TOKEN_REJECTIONS[code].http, TOKEN_REJECTIONS[code].msg);
    this.name = 'TokenRejection';
  }
}

/** 10403 with data.reason=h5_read_only: a read_only h5_token on a method other than GET. */
export class H5ReadOnlyRejection extends TokenRejection {
  readonly data = Object.freeze({ reason: 'h5_read_only' as const });

  constructor() {
    super(10403);
    this.name = 'H5ReadOnlyRejection';
  }
}

/** The verified claims of an h5_token (BR-ID-32): the session it was issued from and its scope. */
export interface H5Claims {
  readonly uid: string;
  readonly app_id: string;
  readonly sid: string;
  readonly device_id: string;
  readonly scp: H5Scope;
}

/** Local signing port; KMS sign(bytes) is deferred per B1-02h §9.5. */
export interface TokenKeyProvider {
  readonly kid: string;
  readonly privateKey: KeyObject;
  readonly publicKeys: ReadonlyMap<string, KeyObject>;
}

export interface TokenService {
  issueAccess(principal: TokenPrincipal): Promise<string>;
  /** jose ES256 only, local kid lookup, issuer/audience checked, Clock, zero tolerance; 10002. */
  verifyAccess(token: string): Promise<TokenPrincipal>;
  issueRefresh(): { token: string; hash: string; expireAt: Date };
  /**
   * h5_token (aud=h5, B1-02f): same keys, issuer, typ and Clock as verifyAccess, expiry from its
   * own exp (the lifetime is configurable); 10002 on any failure. Optional so that hand-built
   * services of other tests keep compiling; the token check treats its absence as «no h5_token».
   */
  verifyH5?(token: string): Promise<H5Claims>;
}

/**
 * Signs a short-lived token of another audience (h5_token, step_up_token; B1-02f) with the access
 * token's key, issuer and header: ES256, { alg, kid, typ: JWT }, iat / exp in seconds.
 */
export async function signScopedToken(
  keys: TokenKeyProvider,
  input: {
    readonly audience: typeof H5_AUDIENCE | typeof STEP_UP_AUDIENCE;
    readonly claims: Readonly<Record<string, string>>;
    readonly issuedAt: number;
    readonly ttlSeconds: number;
  },
): Promise<string> {
  return new SignJWT({ ...input.claims })
    .setProtectedHeader({ alg: 'ES256', kid: keys.kid, typ: 'JWT' })
    .setIssuer(ISSUER)
    .setAudience(input.audience)
    .setIssuedAt(input.issuedAt)
    .setExpirationTime(input.issuedAt + input.ttlSeconds)
    .sign(keys.privateKey);
}

/** Verified step-up claims; sid deliberately does not participate in the business binding. */
export interface StepUpClaims {
  readonly uid: string;
  readonly app_id: string;
  readonly device_id: string;
  readonly action: string;
  readonly jti: string;
  readonly exp: number;
  /**
   * B1-02zzzb: the business digest claim (`summary`, BR-ID-08 细则「绑定业务摘要」) when it is a
   * string, else null. Compared by the business inside its lock, never here.
   */
  readonly summary: string | null;
  /**
   * B1-20b (Codex money r1 S0 #2): the phone binding claim of a phone_change token issued by SMS
   * (domain/step-up-digest.ts phoneChangeBinding) when it is a string, else null. Compared by the
   * phone change inside its users row lock, never here.
   */
  readonly phone_binding: string | null;
}

/** Same local keys / issuer as access tokens, but a separate audience and rejection code. */
export function createStepUpTokenVerifier(
  keys: Pick<TokenKeyProvider, 'publicKeys'>,
  clock: Clock,
) {
  const publicKeys = new Map(keys.publicKeys);
  return async (token: string): Promise<StepUpClaims> => {
    const reject = () =>
      new RequestRejection(STEP_UP_FAILURE.code, STEP_UP_FAILURE.status, STEP_UP_FAILURE.msg);
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(
        token,
        (header) => {
          const key = header.kid === undefined ? undefined : publicKeys.get(header.kid);
          if (key === undefined) throw new errors.JWKSNoMatchingKey();
          return key;
        },
        {
          algorithms: ['ES256'],
          issuer: ISSUER,
          audience: STEP_UP_AUDIENCE,
          typ: 'JWT',
          requiredClaims: ['iat', 'exp'],
          clockTolerance: 0,
          currentDate: clock.now(),
        },
      ));
    } catch (error) {
      if (error instanceof errors.JOSEError) throw reject();
      throw error;
    }
    const { uid, app_id, device_id, action, jti, exp } = payload;
    if (
      payload.aud !== STEP_UP_AUDIENCE ||
      !isClaim(uid) ||
      !isClaim(app_id) ||
      !isClaim(device_id) ||
      !isClaim(action) ||
      !isClaim(jti) ||
      typeof exp !== 'number' ||
      !Number.isSafeInteger(exp * 1000)
    ) {
      throw reject();
    }
    const summary = typeof payload['summary'] === 'string' ? payload['summary'] : null;
    const binding = payload[STEP_UP_PHONE_BINDING_CLAIM];
    const phone_binding = typeof binding === 'string' ? binding : null;
    return Object.freeze({ uid, app_id, device_id, action, jti, exp, summary, phone_binding });
  };
}

/** The claims of a verified h5_token payload, or null when one is missing or malformed. */
function h5ClaimsOf(payload: JWTPayload): H5Claims | null {
  const { uid, app_id: appId, sid, device_id: deviceId, scp } = payload;
  if (!isClaim(uid) || !isClaim(appId) || !isClaim(sid) || !isClaim(deviceId)) return null;
  if (!H5_SCOPES.has(scp)) return null;
  return Object.freeze({ uid, app_id: appId, sid, device_id: deviceId, scp: scp as H5Scope });
}

const generateEcKeyPair = promisify(generateKeyPair);

function isP256PrivateKey(key: unknown): key is KeyObject {
  const candidate = key as Partial<KeyObject> | null;
  return (
    typeof candidate === 'object' &&
    candidate !== null &&
    candidate.type === 'private' &&
    candidate.asymmetricKeyType === 'ec' &&
    candidate.asymmetricKeyDetails?.namedCurve === 'prime256v1'
  );
}

/** Missing JWT configuration is allowed only in local/test; staging/prod reject at startup. */
export async function createTokenKeyProvider(
  appEnv: AppEnv,
  config: JwtKeyConfig | null,
): Promise<TokenKeyProvider> {
  if (config === null) {
    if (appEnv !== 'local' && appEnv !== 'test') {
      throw new Error(
        `JWT_PRIVATE_KEY_PEM and JWT_KEY_ID must be set when APP_ENV=${appEnv}: access tokens are signed with a configured key outside local and test`,
      );
    }
    // One key pair per process: tokens of an earlier run fail with 10002 after a restart.
    const pair = await generateEcKeyPair('ec', { namedCurve: 'prime256v1' });
    const kid = `ephemeral-${randomBytes(8).toString('hex')}`;
    return Object.freeze({
      kid,
      privateKey: pair.privateKey,
      publicKeys: new Map([[kid, pair.publicKey]]),
    });
  }
  // loadConfig validated these already; a hand-built configuration is checked again here.
  const privateKey = parseP256PrivateKeyPem(config.privateKeyPem);
  if (privateKey === null || !isJwtKeyId(config.kid)) {
    throw new Error(
      'JWT_PRIVATE_KEY_PEM / JWT_KEY_ID: a P-256 PKCS#8 private key and a well-formed key id are required',
    );
  }
  const publicKeys = new Map<string, KeyObject>([[config.kid, createPublicKey(privateKey)]]);
  for (const [kid, pem] of Object.entries(config.verificationKeys)) {
    const key = parseP256PublicKeyPem(pem);
    if (kid === config.kid || !isJwtKeyId(kid) || key === null) {
      throw new Error(
        'JWT_VERIFY_KEYS_JSON: every previous key needs its own well-formed key id and a P-256 SPKI public key',
      );
    }
    publicKeys.set(kid, key);
  }
  return Object.freeze({ kid: config.kid, privateKey, publicKeys });
}

function isClaim(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_CLAIM_LENGTH;
}

/** The five claims of a verified payload, or null when one is missing or malformed. */
function principalOf(payload: JWTPayload): TokenPrincipal | null {
  const { uid, app_id: appId, sid, device_id: deviceId, scp } = payload;
  if (!isClaim(uid) || !isClaim(appId) || !isClaim(sid) || !isClaim(deviceId)) return null;
  if (!SCOPES.has(scp)) return null;
  return Object.freeze({
    uid,
    app_id: appId,
    sid,
    device_id: deviceId,
    scp: scp as SessionScope,
  });
}

/** `instant` plus `ms` as a new Date (the Clock's instant is never modified). */
function later(instant: Date, ms: number): Date {
  const result = structuredClone(instant);
  result.setTime(instant.getTime() + ms);
  return result;
}

/**
 * verifyAccess / verifyH5 over a snapshot of `source` (changing the provider's map later cannot
 * add a verification key): shared by the signing service and the verify-only one (B1-02zj), so
 * both judge every token alike.
 */
function createTokenVerifiers(
  clock: Clock,
  source: ReadonlyMap<string, KeyObject>,
): {
  access(token: string): Promise<TokenPrincipal>;
  h5(token: string): Promise<H5Claims>;
} {
  const publicKeys: ReadonlyMap<string, KeyObject> = new Map(source);
  const resolveKey = (header: { kid?: unknown }): KeyObject => {
    const key = typeof header.kid === 'string' ? publicKeys.get(header.kid) : undefined;
    if (key === undefined) throw new errors.JWKSNoMatchingKey();
    return key;
  };
  return {
    async access(token) {
      let payload: JWTPayload;
      try {
        ({ payload } = await jwtVerify(token, resolveKey, {
          algorithms: ['ES256'],
          issuer: ISSUER,
          audience: AUDIENCE,
          typ: 'JWT',
          requiredClaims: ['iat', 'exp'],
          maxTokenAge: ACCESS_TOKEN_TTL_SECONDS,
          clockTolerance: 0,
          currentDate: clock.now(),
        }));
      } catch (error) {
        // Every jose refusal (format, algorithm, key, signature, claims, expiry) is one answer.
        if (error instanceof errors.JOSEError) throw new TokenRejection(10002);
        throw error;
      }
      const principal = principalOf(payload);
      if (principal === null) throw new TokenRejection(10002);
      return principal;
    },
    async h5(token) {
      let payload: JWTPayload;
      try {
        ({ payload } = await jwtVerify(token, resolveKey, {
          algorithms: ['ES256'],
          issuer: ISSUER,
          audience: H5_AUDIENCE,
          typ: 'JWT',
          requiredClaims: ['iat', 'exp'],
          clockTolerance: 0,
          currentDate: clock.now(),
        }));
      } catch (error) {
        if (error instanceof errors.JOSEError) throw new TokenRejection(10002);
        throw error;
      }
      const claims = h5ClaimsOf(payload);
      if (claims === null) throw new TokenRejection(10002);
      return claims;
    },
  };
}

export function createTokenService(deps: { clock: Clock; keys: TokenKeyProvider }): TokenService {
  const { clock, keys } = deps;
  if (typeof clock?.now !== 'function') throw new TypeError('createTokenService needs the clock');
  if (
    typeof keys?.kid !== 'string' ||
    !isJwtKeyId(keys.kid) ||
    !isP256PrivateKey(keys.privateKey) ||
    !(keys.publicKeys instanceof Map)
  ) {
    throw new TypeError('createTokenService needs a key id, a P-256 private key and public keys');
  }
  // A token signed under a kid missing from the verification keys would fail its own check.
  if (!keys.publicKeys.has(keys.kid)) {
    throw new TypeError(
      'createTokenService needs the public key of the signing key id among the verification keys',
    );
  }
  const { kid, privateKey } = keys;
  const verify = createTokenVerifiers(clock, keys.publicKeys);
  return {
    async issueAccess(principal) {
      const claims = principalOf({ ...principal });
      if (claims === null)
        throw new TypeError('issueAccess needs uid, app_id, sid, device_id, scp');
      const issuedAt = Math.floor(clock.now().getTime() / 1000);
      return new SignJWT({ ...claims })
        .setProtectedHeader({ alg: 'ES256', kid, typ: 'JWT' })
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setIssuedAt(issuedAt)
        .setExpirationTime(issuedAt + ACCESS_TOKEN_TTL_SECONDS)
        .sign(privateKey);
    },
    verifyAccess: verify.access,
    issueRefresh() {
      const token = randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
      return {
        token,
        hash: createHash('sha256').update(token).digest('hex'),
        expireAt: later(clock.now(), REFRESH_TOKEN_TTL_MS),
      };
    },
    verifyH5: verify.h5,
  };
}

/**
 * The verification keys of a verify-only process (B1-02zj, D10-255 ①): the shape of platform's
 * JwtVerifyKeyConfig (JWT_KEY_ID, its SPKI public key, JWT_VERIFY_KEYS_JSON). No private key.
 */
export interface TokenVerifyKeyConfig {
  readonly kid: string;
  readonly publicKeyPem: string;
  readonly verificationKeys: Readonly<Record<string, string>>;
}

/** Verify-only key port (D10-255 ①): the public keys by kid, never a private key. */
export interface TokenVerifyKeyProvider {
  readonly kid: string;
  readonly publicKeys: ReadonlyMap<string, KeyObject>;
}

/**
 * The verification half of a signing configuration (a hand-built AppConfig with `jwt` but without
 * `jwtVerify`): JWT_KEY_ID, the public key derived from the private key, JWT_VERIFY_KEYS_JSON.
 * The private key never leaves this function. A private key that does not parse is refused.
 */
export function verifyKeyConfigOf(config: JwtKeyConfig): TokenVerifyKeyConfig {
  const privateKey = parseP256PrivateKeyPem(config.privateKeyPem);
  if (privateKey === null) {
    throw new Error('JWT_PRIVATE_KEY_PEM: a P-256 PKCS#8 private key is required');
  }
  return Object.freeze({
    kid: config.kid,
    publicKeyPem: createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString(),
    verificationKeys: config.verificationKeys,
  });
}

/**
 * The verify-only keys of a process that never signs (stream, ...). Staging / prod without a
 * configuration refuse to start, naming JWT_PUBLIC_KEY_PEM; a hand-built configuration is checked
 * again (P-256 SPKI, well-formed kids, previous kids distinct from the current one).
 * Local / test without one: an ephemeral public key whose private half is discarded at once, so
 * nothing verifies (the process has no signer to trust); the module wiring keeps its existing
 * ephemeral signer for that case instead (identity.module.ts).
 */
export async function createTokenVerifyKeyProvider(
  appEnv: AppEnv,
  config: TokenVerifyKeyConfig | null,
): Promise<TokenVerifyKeyProvider> {
  if (config === null) {
    if (appEnv !== 'local' && appEnv !== 'test') {
      throw new Error(
        `JWT_PUBLIC_KEY_PEM (or JWT_PRIVATE_KEY_PEM) and JWT_KEY_ID must be set when APP_ENV=${appEnv}: access tokens are verified with a configured key outside local and test`,
      );
    }
    const pair = await generateEcKeyPair('ec', { namedCurve: 'prime256v1' });
    const kid = `ephemeral-${randomBytes(8).toString('hex')}`;
    return Object.freeze({ kid, publicKeys: new Map([[kid, pair.publicKey]]) });
  }
  const current = parseP256PublicKeyPem(config.publicKeyPem);
  if (current === null || !isJwtKeyId(config.kid)) {
    throw new Error(
      'JWT_PUBLIC_KEY_PEM / JWT_KEY_ID: a P-256 SPKI public key and a well-formed key id are required',
    );
  }
  const publicKeys = new Map<string, KeyObject>([[config.kid, current]]);
  for (const [kid, pem] of Object.entries(config.verificationKeys)) {
    const key = parseP256PublicKeyPem(pem);
    if (kid === config.kid || !isJwtKeyId(kid) || key === null) {
      throw new Error(
        'JWT_VERIFY_KEYS_JSON: every previous key needs its own well-formed key id and a P-256 SPKI public key',
      );
    }
    publicKeys.set(kid, key);
  }
  return Object.freeze({ kid: config.kid, publicKeys });
}

/** True for a key port that can sign (a P-256 private key next to the public keys). */
export function isSigningKeyProvider(
  keys: TokenKeyProvider | TokenVerifyKeyProvider,
): keys is TokenKeyProvider {
  return isP256PrivateKey((keys as Partial<TokenKeyProvider>).privateKey);
}

/** Thrown by a verify-only token service asked to sign (never a fallback key). */
export class TokenSigningUnavailable extends Error {
  constructor() {
    super('this process only verifies access tokens: it holds no signing key (D10-255)');
    this.name = 'TokenSigningUnavailable';
  }
}

/**
 * A TokenService that verifies exactly like createTokenService (ES256, local kid lookup, issuer,
 * audience, typ, Clock, zero tolerance; 10002) but never signs: issueAccess rejects.
 */
export function createTokenVerifyService(deps: {
  clock: Clock;
  keys: TokenVerifyKeyProvider;
}): TokenService {
  const { clock, keys } = deps;
  if (typeof clock?.now !== 'function') {
    throw new TypeError('createTokenVerifyService needs the clock');
  }
  if (
    typeof keys?.kid !== 'string' ||
    !isJwtKeyId(keys.kid) ||
    !(keys.publicKeys instanceof Map) ||
    !keys.publicKeys.has(keys.kid)
  ) {
    throw new TypeError(
      'createTokenVerifyService needs a key id and public keys that include its key',
    );
  }
  const verify = createTokenVerifiers(clock, keys.publicKeys);
  return {
    issueAccess() {
      return Promise.reject(new TokenSigningUnavailable());
    },
    verifyAccess: verify.access,
    issueRefresh() {
      throw new TokenSigningUnavailable();
    },
    verifyH5: verify.h5,
  };
}

export interface SessionLookup {
  /** Each authenticated request reads its current session, scoped by app_id. */
  find(
    appId: string,
    sid: string,
  ): Promise<{
    revoked_at: Date | null;
  } | null>;
}

/** `Bearer <token>` (RFC 6750 §2.1; the scheme is case-insensitive, RFC 9110 §11.1). */
const BEARER = /^Bearer ([A-Za-z0-9\-._~+/]+=*)$/i;

function headerValue(request: RequestCheckInput, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === 'string' ? value : undefined;
}

/** The checks createTokenCheck built: bootstrap asks whether an entry's plan contains one. */
const TOKEN_CHECKS = new WeakSet<RequestCheck>();

/**
 * True for a stage ② ③ check built by createTokenCheck (bootstrap's route guard: an entry whose
 * plan has none refuses a contract route that needs a token; the same way as risk's
 * isSignatureCheck for stage ①).
 */
export function isTokenCheck(check: unknown): boolean {
  return typeof check === 'function' && TOKEN_CHECKS.has(check as RequestCheck);
}

/** True for a route an h5_token may never call (BR-ID-32), judged on the matched template. */
export function isOutsideH5Scope(method: string, template: string): boolean {
  if (isContractSignedRoute(method, template)) return true;
  if (template.startsWith(H5_EXCLUDED_AUTH_PREFIX)) return true;
  return H5_EXCLUDED_PREFIXES.some(
    (prefix) => template === prefix || template.startsWith(`${prefix}/`),
  );
}

/** GET is all a read_only h5_token may call (BR-ID-32「只能调用 GET 接口」; HEAD included). */
function isReadMethod(method: string): boolean {
  return method.toUpperCase() === 'GET';
}

/**
 * Stages ② and ③ after signature, before body validation, using the full contract auth table.
 * An h5_token (aud=h5, B1-02f, BR-ID-32) is accepted where an access token is, with its own rules:
 * its session (sid) must still be live (10002); a route outside its scope (isOutsideH5Scope) is
 * 10403; a read_only token on a method other than GET is 10403 with data.reason=h5_read_only
 * (both also on an x-auth none route when the token is a valid h5_token), raised through
 * `readOnlyRejection` (the entry passes an error the global filter writes back with its data;
 * the default carries the data on the error only). The principal is the token's uid / app_id / sid / device_id.
 */
export function createTokenCheck(deps: {
  tokens: TokenService;
  sessions: SessionLookup;
  readOnlyRejection?: (request: RequestCheckInput) => Error;
}): RequestCheck {
  const { tokens, sessions } = deps;
  if (typeof tokens?.verifyAccess !== 'function' || typeof sessions?.find !== 'function') {
    throw new TypeError('createTokenCheck needs the token service and the session lookup');
  }
  const readOnlyRejection = deps.readOnlyRejection ?? (() => new H5ReadOnlyRejection());

  const bearer = (authorization: string | string[]): string | undefined =>
    typeof authorization === 'string' ? BEARER.exec(authorization)?.[1] : undefined;

  /** The h5 claims of a token that is not an access token, or the access token's rejection. */
  const h5Claims = async (token: string, refusal: unknown): Promise<H5Claims> => {
    if (!(refusal instanceof TokenRejection) || typeof tokens.verifyH5 !== 'function') {
      throw refusal;
    }
    try {
      return await tokens.verifyH5(token);
    } catch (error) {
      // Neither an access token nor an h5_token: the access token's answer (10002).
      if (error instanceof TokenRejection) throw refusal;
      throw error;
    }
  };

  /** Stage ②: the verified claims of a live session (and the h5 claims of an h5_token), or 10002. */
  const authenticate = async (
    authorization: string | string[],
  ): Promise<{ principal: TokenPrincipal; h5?: H5Claims }> => {
    const token = bearer(authorization);
    if (token === undefined) throw new TokenRejection(10002);
    let principal: TokenPrincipal;
    let h5: H5Claims | undefined;
    try {
      principal = await tokens.verifyAccess(token);
    } catch (refusal) {
      h5 = await h5Claims(token, refusal);
      principal = Object.freeze({
        uid: h5.uid,
        app_id: h5.app_id,
        sid: h5.sid,
        device_id: h5.device_id,
        scp: 'full' as const,
      });
    }
    const session = await sessions.find(principal.app_id, principal.sid);
    if (session === null || session.revoked_at !== null) throw new TokenRejection(10002);
    return h5 === undefined ? { principal } : { principal, h5 };
  };

  /**
   * x-auth none never reads a token, except to refuse a valid h5_token outside its scope or a
   * read_only one on a method other than GET: the h5 claims of a valid h5_token, else undefined.
   */
  const h5ClaimsIfAny = async (
    authorization: string | string[] | undefined,
  ): Promise<H5Claims | undefined> => {
    if (authorization === undefined || typeof tokens.verifyH5 !== 'function') return undefined;
    const token = bearer(authorization);
    if (token === undefined) return undefined;
    try {
      return await tokens.verifyH5(token);
    } catch (error) {
      if (error instanceof TokenRejection) return undefined;
      throw error;
    }
  };

  /** BR-ID-32: the scope of an h5_token on a route (outside its scope 10403, read_only only GET). */
  const enforceH5Scope = (request: RequestCheckInput, template: string, h5: H5Claims): void => {
    if (isOutsideH5Scope(request.method, template)) throw new TokenRejection(10403);
    if (h5.scp === 'read_only' && !isReadMethod(request.method)) throw readOnlyRejection(request);
  };

  const check: RequestCheck = async (request) => {
    const template = request.routeTemplate;
    const auth = template === undefined ? undefined : contractAuthOf(request.method, template);
    // Outside the contract: no Authorization is read and no stage applies.
    if (auth === undefined || template === undefined) return;
    // Admin levels: an app token never satisfies them and there is no admin token check yet, so
    // fail closed before reading Authorization or any session (bootstrap also refuses the routes).
    if (auth === 'admin' || auth === 'super') throw new TokenRejection(10001);
    if (auth === 'none') {
      // BR-ID-32: a valid h5_token is refused (10403, not ignored) on the routes outside its scope,
      // and a read_only one on a method other than GET (h5_read_only), so it cannot write through
      // an anonymous route either. Without a valid h5_token nothing changes (no session is read).
      if (!isReadMethod(request.method) || isOutsideH5Scope(request.method, template)) {
        const h5 = await h5ClaimsIfAny(request.headers['authorization']);
        if (h5 !== undefined) enforceH5Scope(request, template, h5);
      }
    } else {
      const authorization = request.headers['authorization'];
      if (authorization !== undefined) {
        const { principal, h5 } = await authenticate(authorization);
        // ③ after login, app_id comes from the token only (BR-ID-07).
        if (headerValue(request, 'x-app-id') !== principal.app_id) throw new TokenRejection(10403);
        if (h5 !== undefined) enforceH5Scope(request, template, h5);
        request.principal = principal;
        return;
      }
      if (auth !== 'optional') throw new TokenRejection(10001);
    }
    // ③ before login: a signed request's X-App-Id must be its verified device's app (BR-ID-07).
    if (isContractSignedRoute(request.method, template)) {
      const device = request.verifiedDevice;
      if (device === undefined || headerValue(request, 'x-app-id') !== device.appId) {
        throw new TokenRejection(10403);
      }
    }
  };
  TOKEN_CHECKS.add(check);
  return check;
}
