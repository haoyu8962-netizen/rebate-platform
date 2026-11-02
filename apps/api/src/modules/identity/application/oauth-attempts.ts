// Third-party authorization attempts (规划/08 BR-ID-04 细则「授权尝试」「提交时先校验、后消费」
// 「用途隔离」, BR-ID-08 细则; 04 §6.1 POST /v1/auth/oauth-attempts; orchestrator ruling B1-02f
// §9.2: Redis, no table, no migration).
//
// issue(): purpose=login needs no login; step_up and payout_bind need the token's principal
// (10001). step_up needs `action` and is issued only to an account without a bound phone
// (users.phone_hmac set → 20001 fields=[provider], BR-ID-08); payout_bind is WeChat only and
// carries no action (20001; the contract schema already refuses both). The attempt is bound to the
// provider, the purpose, the request's verified device (stage ①) and, for step_up and payout_bind,
// the user (step_up also the action); purpose=reverify (BR-WDR-01 细则) needs the token's principal
// and a provider among the identities frozen at flagging (otherwise 20001 fields=[provider], an
// account with a bound phone included) and is bound to the user; its nonce is 32 random bytes in hex (≥ 128 bits). Lifetime
// auth.oauth_attempt_ttl_sec of the app (default 600 s), judged on the injected Clock; the Redis
// TTL only collects the key.
//
// consume(): first read and compare everything — present, not expired, not used, provider,
// purpose, device_id, uid, action — and answer 20004 leaving the attempt exactly as it was when
// anything differs (another device, user, action or purpose cannot burn it). Only then one atomic
// compare-and-set turns the unused value into a used one: of concurrent consumers, also in other
// processes, exactly one wins, the others get 20004. Nothing is restored afterwards.
// Redis unavailable (or the handle closed) → 50001 for both, never an in-memory fallback.
//
// Keys (namespace `oauth`): `a:<app_id>:<attempt_id>` → JSON of the attempt. Nothing is logged:
// the nonce is a credential of the authorization.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for types, `.ts`
// relative imports, no decorators.
import { randomBytes } from 'node:crypto';
import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import {
  RedisUnavailableError,
  newUuidV7,
  type Clock,
  type RedisHandle,
  type RedisNamespace,
  type TokenPrincipal,
} from '../../platform/index.ts';
import { trustedIdentitiesOf } from '../domain/reverify.ts';
import { configuredSeconds, instantPlus } from './config-seconds.ts';
import type { SmsConfigReader } from './sms-codes.ts';

export interface OauthAttemptBinding {
  readonly app_id: string;
  readonly provider: Schema<'LoginProvider'>;
  readonly purpose: Schema<'OauthAttemptPurpose'>;
  readonly device_id: string;
  readonly uid?: string;
  readonly action?: Schema<'StepUpAction'>;
}

export interface OauthAttemptCommand {
  readonly body: Schema<'CreateOauthAttemptRequest'>;
  readonly verifiedDevice: { readonly appId: string; readonly deviceId: string };
  readonly principal?: TokenPrincipal;
}

export type OauthAttemptResult =
  | { readonly code: 0; readonly data: Schema<'OauthAttemptData'> }
  | { readonly code: 10001 | 10403 | 20004 | 50001 }
  | { readonly code: 20001; readonly data: { readonly fields: readonly string[] } };

export interface OauthAttemptService {
  issue(command: OauthAttemptCommand): Promise<OauthAttemptResult>;
  /** Compare every binding before atomic consumption; failure must leave the attempt intact. */
  consume(
    binding: OauthAttemptBinding & { readonly attempt_id: string },
  ): Promise<
    | { readonly code: 0; readonly data: { readonly nonce: string } }
    | { readonly code: 20004 | 50001 }
  >;
}

export interface OauthAttemptOptions {
  readonly db: Kysely<DB>;
  readonly redis: RedisHandle;
  readonly clock: Clock;
  readonly config: SmsConfigReader;
}

/** Configuration key of the attempt lifetime (BR-ID-04 细则). */
export const OAUTH_ATTEMPT_TTL_KEY = 'auth.oauth_attempt_ttl_sec';
/** BR-ID-04 细则: an attempt is valid for 600 seconds unless the app configures otherwise. */
export const OAUTH_ATTEMPT_DEFAULT_TTL_SECONDS = 600;
/** Orchestrator ruling B1-02f §10: 32 random bytes (256 bits), hex. */
const NONCE_BYTES = 32;
const NAMESPACE = 'oauth';

/**
 * Compare-and-set of one attempt: KEYS[1] the attempt, ARGV[1] the TTL (platform/redis), ARGV[2]
 * the unused value exactly as read, ARGV[3] the used value. 1 when this call consumed it.
 */
const CONSUME_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if current ~= ARGV[2] then return 0 end
redis.call('SET', KEYS[1], ARGV[3], 'EX', ARGV[1])
return 1
`;

/** The stored attempt (JSON). uid / action are null when the purpose binds none. */
interface StoredAttempt {
  readonly provider: string;
  readonly purpose: string;
  readonly device_id: string;
  readonly uid: string | null;
  readonly action: string | null;
  readonly nonce: string;
  readonly expire_at: number;
  readonly used: boolean;
}

function attemptKey(appId: string, attemptId: string): string {
  return `a:${appId}:${attemptId}`;
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isNullableText(value: unknown): value is string | null {
  return value === null || isText(value);
}

/** The stored attempt, or null for a value this service did not write. */
function parseAttempt(raw: string): StoredAttempt | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (
    !isText(record['provider']) ||
    !isText(record['purpose']) ||
    !isText(record['device_id']) ||
    !isNullableText(record['uid']) ||
    !isNullableText(record['action']) ||
    !isText(record['nonce']) ||
    typeof record['expire_at'] !== 'number' ||
    !Number.isSafeInteger(record['expire_at']) ||
    typeof record['used'] !== 'boolean'
  ) {
    return null;
  }
  return record as unknown as StoredAttempt;
}

function serialize(attempt: StoredAttempt): string {
  return JSON.stringify({
    provider: attempt.provider,
    purpose: attempt.purpose,
    device_id: attempt.device_id,
    uid: attempt.uid,
    action: attempt.action,
    nonce: attempt.nonce,
    expire_at: attempt.expire_at,
    used: attempt.used,
  });
}

function matches(attempt: StoredAttempt, binding: OauthAttemptBinding): boolean {
  return (
    attempt.provider === binding.provider &&
    attempt.purpose === binding.purpose &&
    attempt.device_id === binding.device_id &&
    attempt.uid === (binding.uid ?? null) &&
    attempt.action === (binding.action ?? null)
  );
}

export function createOauthAttemptService(options: OauthAttemptOptions): OauthAttemptService {
  const { db, redis, clock, config } = options;
  // Acquired per call: a closed handle throws here, and that is a 50001 like any Redis failure.
  const store = (): RedisNamespace => redis.namespace(NAMESPACE);

  /** Whether the user has a bound phone; null when the user row does not exist. */
  async function phoneBound(appId: string, uid: string): Promise<boolean | null> {
    const row = await db
      .selectFrom('users')
      .select('phone_hmac')
      .where('app_id', '=', appId)
      .where('id', '=', uid)
      .executeTakeFirst();
    return row === undefined ? null : row.phone_hmac !== null;
  }

  /** The third-party identities frozen when the account was flagged; null without a user row. */
  async function trustedProviders(appId: string, uid: string): Promise<readonly string[] | null> {
    const row = await db
      .selectFrom('users')
      .select(['reverify_flagged_at', 'reverify_trusted'])
      .where('app_id', '=', appId)
      .where('id', '=', uid)
      .executeTakeFirst();
    if (row === undefined) return null;
    return row.reverify_flagged_at === null
      ? []
      : trustedIdentitiesOf(row.reverify_trusted).providers;
  }

  const service: OauthAttemptService = {
    async issue(command: OauthAttemptCommand): Promise<OauthAttemptResult> {
      const { body, verifiedDevice, principal } = command;
      const { provider, purpose } = body;
      if (purpose !== 'login' && principal === undefined) return { code: 10001 };
      // The token and the signing device must be of one app (BR-ID-07): otherwise a user of one
      // app would get an attempt stored under another app's keys. Every key and binding below
      // uses this checked app_id.
      const appId = verifiedDevice.appId;
      if (principal !== undefined && principal.app_id !== appId) return { code: 10403 };
      if (purpose === 'step_up' && body.action === undefined) {
        return { code: 20001, data: { fields: ['action'] } };
      }
      if (purpose === 'payout_bind') {
        if (provider !== 'wechat') return { code: 20001, data: { fields: ['provider'] } };
        if (body.action !== undefined) return { code: 20001, data: { fields: ['action'] } };
      }
      let uid: string | null = null;
      if (purpose !== 'login' && principal !== undefined) {
        uid = principal.uid;
        if (purpose === 'step_up') {
          const bound = await phoneBound(appId, principal.uid);
          // A token whose user row is gone does not identify a user.
          if (bound === null) return { code: 10001 };
          // BR-ID-08: an account with a bound phone verifies by SMS.
          if (bound) return { code: 20001, data: { fields: ['provider'] } };
        }
        if (purpose === 'reverify') {
          const trusted = await trustedProviders(appId, principal.uid);
          if (trusted === null) return { code: 10001 };
          if (!trusted.includes(provider)) return { code: 20001, data: { fields: ['provider'] } };
        }
      }
      const ttlSeconds = await configuredSeconds(
        config,
        appId,
        OAUTH_ATTEMPT_TTL_KEY,
        OAUTH_ATTEMPT_DEFAULT_TTL_SECONDS,
      );
      const now = clock.now();
      const expireAt = instantPlus(now, ttlSeconds * 1000);
      const attemptId = newUuidV7(now);
      const nonce = randomBytes(NONCE_BYTES).toString('hex');
      const attempt: StoredAttempt = {
        provider,
        purpose,
        device_id: verifiedDevice.deviceId,
        uid,
        action: purpose === 'step_up' ? (body.action ?? null) : null,
        nonce,
        expire_at: expireAt.getTime(),
        used: false,
      };
      try {
        await store().set(attemptKey(appId, attemptId), serialize(attempt), ttlSeconds);
      } catch (error) {
        if (error instanceof RedisUnavailableError) return { code: 50001 };
        throw error;
      }
      return {
        code: 0,
        data: { attempt_id: attemptId, nonce, expire_at: expireAt.toISOString() },
      };
    },

    async consume(binding) {
      const key = attemptKey(binding.app_id, binding.attempt_id);
      try {
        const namespace = store();
        const raw = await namespace.get(key);
        if (raw === null) return { code: 20004 };
        const attempt = parseAttempt(raw);
        const nowMs = clock.now().getTime();
        if (
          attempt === null ||
          attempt.used ||
          nowMs >= attempt.expire_at ||
          !matches(attempt, binding)
        ) {
          return { code: 20004 };
        }
        const remainingSeconds = Math.max(1, Math.ceil((attempt.expire_at - nowMs) / 1000));
        const consumed = await namespace.eval(CONSUME_SCRIPT, {
          keys: [key],
          args: [raw, serialize({ ...attempt, used: true })],
          ttlSeconds: remainingSeconds,
        });
        if (consumed !== 1) return { code: 20004 };
        return { code: 0, data: { nonce: attempt.nonce } };
      } catch (error) {
        if (error instanceof RedisUnavailableError) return { code: 50001 };
        throw error;
      }
    },
  };
  return Object.freeze(service);
}
