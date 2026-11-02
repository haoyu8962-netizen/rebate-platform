// Contract operation `refreshToken` (POST /v1/auth/refresh; 04 §6.1; 规划/08 BR-ID-07 and its 细则
// 「作用域 scp」「还没被轮换的 refresh_token 由会话绑定设备以外的设备提交」; 04 §3.2 sessions /
// refresh_tokens; migration 0013). The controller runs it after the request signature ① and the
// device-source check ③, so the verified device's app and id are the only identity read here.
//
// One PostgreSQL transaction per attempt, in this order (orchestrator ruling B1-02k §9.2):
//   0. lock the refresh token row: (app_id = the verified device's app, token_hash = SHA-256 hex of
//      the presented token) SELECT … FOR UPDATE. No row → 10404, nothing revoked (an unknown token
//      or a token of another app touches no session).
//   1. read its session: revoked, or the token expired (expire_at ≤ the Clock's now) → 10404.
//      Expiry is not reuse: nothing is revoked, the hook is not called.
//   2. the verified device is not the session's device → leaked: revoke the whole sid
//      ('refresh_reuse'), run afterRevoked in the same transaction, 10404 — rotated or not, and
//      nothing is issued.
//   3. not rotated yet → rotate: rotated_at = now on the old row (`rotated_at IS NULL`; 0 rows →
//      step 4), a new row with parent_hash = the old hash and expire_at = now + 30 days, the scope
//      judged again from this request (computed before the transaction, see below), the same sid,
//      an access token; then the new
//      pair together with the successor row's token_hash (`successor_hash`, kept inside the entry
//      only), encrypted under the context 'identity.refresh_grace', is written to Redis
//      `refresh_grace:<old hash>` for 30 seconds BEFORE the transaction commits, so a failed Redis
//      write rolls the whole rotation back (50001; the old token still rotates next time).
//   4. rotated → the grace of BR-ID-07: now − rotated_at ≤ 30 s, the direct successor (the row
//      whose parent_hash is this hash, locked FOR UPDATE so a concurrent rotation of it is waited
//      for) not rotated, and a Redis entry → the stored pair is decrypted and returned as it was
//      (its session_scope too, not judged again), nothing revoked. Any condition failing → revoke
//      the whole sid ('refresh_reuse') + afterRevoked + 10404. A failed Redis read is 50001 and
//      revokes nothing: only a missing entry counts as reuse. The entry's successor_hash must equal
//      the committed direct successor's token_hash: a late SET of a rolled-back rotation can
//      overwrite the entry with a pair that was never stored, so a mismatch is a cache
//      inconsistency, not reuse — 50001, nothing revoked or issued, a warn 'refresh_grace_mismatch'
//      with 8-character hash prefixes.
//   5. a concurrent second rotation: the row lock serialises the two requests, so the later one
//      reads the committed rotated_at and goes to step 4; the (app_id, parent_hash) unique
//      constraint is the second guard — a 23505 on it rolls the attempt back and the request is
//      tried once more, where it sees the token rotated.
// The scope (sessionScope over the minimum-version reader) is judged once per request BEFORE the
// first transaction opens and handed in: the reader runs on its own database handle, so a call
// inside the transaction would borrow a second connection from the same pool while this one is
// held (pool exhaustion under concurrent refreshes). Inside the transaction only `trx`, the token
// service, FieldCrypto and Redis are used. A failed read is 50001 with no transaction opened.
// Every other failure (Redis, the hook, the database) rolls back and is answered 50001. devices.last_login_sid is never touched. Log lines carry the app and at most the
// first 8 characters of a hash, never a token.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for type-only imports.
import { createHash } from 'node:crypto';
import type { ClientPlatform, Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';
import {
  newUuidV7,
  type Clock,
  type FieldCrypto,
  type RedisHandle,
  type RootLogger,
  type TokenPrincipal,
} from '../../platform/index.ts';
import type { TokenService } from './access-tokens.ts';
import { recordRefreshActivity } from './reverify-activity.ts';
import { sessionScope, type MinimumVersionReader } from './session-scope.ts';
import type { AfterSessionsRevoked, SessionRevokeReason } from './revoke-sessions.ts';
import { accessExpiry, revokeSession } from './sessions.ts';

/** Input is assembled after signature and device/app source checks. */
export interface RefreshCommand {
  refresh_token: string;
  verifiedDevice: { deviceId: string; appId: string };
  platform: ClientPlatform;
  channel?: string;
  version?: string;
}

export type RefreshPair = Schema<'TokenPair'>;
export type RefreshResult = { code: 0; data: RefreshPair } | { code: 10404 | 50001 };

export interface RefreshOptions {
  db: Kysely<DB>;
  clock: Clock;
  tokens: TokenService;
  crypto: FieldCrypto;
  redis: RedisHandle;
  versions: MinimumVersionReader;
  logger: RootLogger;
  afterRevoked?: AfterSessionsRevoked;
}

export interface RefreshService {
  refresh(command: RefreshCommand): Promise<RefreshResult>;
}

/** BR-ID-07: a rotated token is answered again for 30 seconds (inclusive). */
const GRACE_MS = 30_000;
/** The Redis lifetime of a grace entry, whole seconds. */
const GRACE_TTL_SECONDS = 30;
/** Redis namespace of the grace entries; the key is the rotated token's hash. */
const GRACE_NAMESPACE = 'refresh_grace';
/** FieldCrypto context of a grace entry. */
const GRACE_CONTEXT = 'identity.refresh_grace';
const REUSE_REASON: SessionRevokeReason = 'refresh_reuse';
const UNIQUE_VIOLATION = '23505';
/** (app_id, parent_hash) UNIQUE of app.refresh_tokens (0013): a token has one direct successor. */
const PARENT_CONSTRAINT = 'refresh_tokens_parent_hash_key';
const SCOPES: ReadonlySet<unknown> = new Set(['full', 'deletion_only']);

type Answer = RefreshResult;

/** A 23505 on the single-successor constraint: another rotation of the same token committed. */
function isParentConflict(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { code, constraint } = error as { code?: unknown; constraint?: unknown };
  return code === UNIQUE_VIOLATION && constraint === PARENT_CONSTRAINT;
}

/** Only the error's class name and SQLSTATE: a driver error's detail can carry key values. */
function errorFields(error: unknown): { error_name: string; error_code?: string } {
  const name = error instanceof Error ? error.name : typeof error;
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? { error_name: name, error_code: code } : { error_name: name };
}

/** A grace entry: the pair as answered plus the committed successor's token_hash. */
interface GraceEntry {
  pair: RefreshPair;
  successorHash: string;
}

/** A decrypted grace entry; anything else is a failure (50001), never a reuse. */
function parseEntry(plaintext: string): GraceEntry {
  const value = JSON.parse(plaintext) as Record<string, unknown> | null;
  if (
    typeof value !== 'object' ||
    value === null ||
    typeof value.access_token !== 'string' ||
    typeof value.access_expires_at !== 'string' ||
    typeof value.refresh_token !== 'string' ||
    typeof value.refresh_expires_at !== 'string' ||
    !SCOPES.has(value.session_scope) ||
    typeof value.successor_hash !== 'string'
  ) {
    throw new Error('identity: a malformed refresh grace entry');
  }
  return {
    pair: {
      access_token: value.access_token,
      access_expires_at: value.access_expires_at,
      refresh_token: value.refresh_token,
      refresh_expires_at: value.refresh_expires_at,
      session_scope: value.session_scope as RefreshPair['session_scope'],
    },
    successorHash: value.successor_hash,
  };
}

export function createRefreshService(options: RefreshOptions): RefreshService {
  const { db, clock, tokens, crypto, redis, versions, logger, afterRevoked } = options;

  /** Step 2 / 4 failing: the whole sid is revoked in this transaction, then 10404. */
  async function reuse(
    trx: Transaction<DB>,
    appId: string,
    sid: string,
    tokenHash: string,
    cause: string,
  ): Promise<Answer> {
    const revoked = await revokeSession(trx, { app_id: appId, sid, reason: REUSE_REASON }, clock);
    if (revoked && afterRevoked !== undefined) await afterRevoked(trx, [sid], { app_id: appId });
    logger.warn(
      { app_id: appId, token_hash_prefix: tokenHash.slice(0, 8), cause },
      'refresh_reuse_revoked',
    );
    return { code: 10404 };
  }

  /** Step 3. Null when the row turned out rotated already (0 rows updated). */
  async function rotate(
    trx: Transaction<DB>,
    command: RefreshCommand,
    session: { sid: string; user_id: string; device_id: string },
    tokenHash: string,
    now: Date,
    scp: TokenPrincipal['scp'],
  ): Promise<RefreshPair | null> {
    const appId = command.verifiedDevice.appId;
    const marked = await trx
      .updateTable('refresh_tokens')
      .set({ rotated_at: now, updated_at: now })
      .where('app_id', '=', appId)
      .where('token_hash', '=', tokenHash)
      .where('rotated_at', 'is', null)
      .executeTakeFirst();
    if (marked.numUpdatedRows === 0n) return null;
    const issued = tokens.issueRefresh();
    await trx
      .insertInto('refresh_tokens')
      .values({
        id: newUuidV7(now),
        app_id: appId,
        sid: session.sid,
        token_hash: issued.hash,
        parent_hash: tokenHash,
        rotated_at: null,
        expire_at: issued.expireAt,
        created_at: now,
        updated_at: now,
      })
      .execute();
    // BR-WDR-01 细则「判定」: a refresh overwrites the account's two values and never judges (and
    // leaves an account in deletion alone, BR-ID-28 细则「待加验记录」).
    await recordRefreshActivity(trx, {
      app_id: appId,
      user_id: session.user_id,
      device_id: session.device_id,
      now,
    });
    const accessToken = await tokens.issueAccess({
      uid: session.user_id,
      app_id: appId,
      sid: session.sid,
      device_id: session.device_id,
      scp,
    });
    const pair: RefreshPair = {
      access_token: accessToken,
      access_expires_at: accessExpiry(accessToken, now).toISOString(),
      refresh_token: issued.token,
      refresh_expires_at: issued.expireAt.toISOString(),
      session_scope: scp,
    };
    // Before the commit: a failed write throws and rolls the rotation back.
    await redis
      .namespace(GRACE_NAMESPACE)
      .set(
        tokenHash,
        crypto.encrypt(JSON.stringify({ ...pair, successor_hash: issued.hash }), GRACE_CONTEXT),
        GRACE_TTL_SECONDS,
      );
    return pair;
  }

  /** Step 4: the grace of a rotated token, or reuse. */
  async function grace(
    trx: Transaction<DB>,
    appId: string,
    sid: string,
    tokenHash: string,
    rotatedAt: Date,
    now: Date,
  ): Promise<Answer> {
    if (now.getTime() - rotatedAt.getTime() > GRACE_MS) {
      return reuse(trx, appId, sid, tokenHash, 'grace_elapsed');
    }
    const successor = await trx
      .selectFrom('refresh_tokens')
      .select(['token_hash', 'rotated_at'])
      .where('app_id', '=', appId)
      .where('parent_hash', '=', tokenHash)
      .forUpdate()
      .executeTakeFirst();
    if (successor === undefined || successor.rotated_at !== null) {
      return reuse(trx, appId, sid, tokenHash, 'successor_rotated');
    }
    // A failed read throws (50001, nothing revoked); only a missing entry is reuse.
    const stored = await redis.namespace(GRACE_NAMESPACE).get(tokenHash);
    if (stored === null) return reuse(trx, appId, sid, tokenHash, 'grace_entry_missing');
    const { pair, successorHash } = parseEntry(crypto.decrypt(stored, GRACE_CONTEXT));
    if (successorHash !== successor.token_hash) {
      // Not reuse: the entry does not describe the committed successor (a late write of a
      // rolled-back rotation). Nothing is revoked and nothing is issued.
      logger.warn(
        {
          app_id: appId,
          token_hash_prefix: tokenHash.slice(0, 8),
          cached_successor_prefix: successorHash.slice(0, 8),
          stored_successor_prefix: successor.token_hash.slice(0, 8),
        },
        'refresh_grace_mismatch',
      );
      return { code: 50001 };
    }
    logger.info({ app_id: appId, token_hash_prefix: tokenHash.slice(0, 8) }, 'refresh_grace_hit');
    return { code: 0, data: pair };
  }

  async function attempt(
    command: RefreshCommand,
    tokenHash: string,
    scp: TokenPrincipal['scp'],
  ): Promise<Answer> {
    const appId = command.verifiedDevice.appId;
    return db.transaction().execute(async (trx): Promise<Answer> => {
      const token = await trx
        .selectFrom('refresh_tokens')
        .select(['sid', 'rotated_at', 'expire_at'])
        .where('app_id', '=', appId)
        .where('token_hash', '=', tokenHash)
        .forUpdate()
        .executeTakeFirst();
      if (token === undefined) return { code: 10404 };
      const session = await trx
        .selectFrom('sessions')
        .select(['sid', 'user_id', 'device_id', 'revoked_at'])
        .where('app_id', '=', appId)
        .where('sid', '=', token.sid)
        .executeTakeFirst();
      const now = clock.now();
      if (
        session === undefined ||
        session.revoked_at !== null ||
        token.expire_at.getTime() <= now.getTime()
      ) {
        return { code: 10404 };
      }
      if (session.device_id !== command.verifiedDevice.deviceId) {
        return reuse(trx, appId, session.sid, tokenHash, 'device_mismatch');
      }
      let rotatedAt = token.rotated_at;
      if (rotatedAt === null) {
        const pair = await rotate(trx, command, session, tokenHash, now, scp);
        if (pair !== null) {
          logger.info(
            { app_id: appId, token_hash_prefix: tokenHash.slice(0, 8), scp: pair.session_scope },
            'refresh_rotated',
          );
          return { code: 0, data: pair };
        }
        const current = await trx
          .selectFrom('refresh_tokens')
          .select('rotated_at')
          .where('app_id', '=', appId)
          .where('token_hash', '=', tokenHash)
          .executeTakeFirstOrThrow();
        rotatedAt = current.rotated_at;
        if (rotatedAt === null)
          throw new Error('identity: a refresh token neither rotated nor not');
      }
      return grace(trx, appId, session.sid, tokenHash, rotatedAt, now);
    });
  }

  async function settle(
    command: RefreshCommand,
    tokenHash: string,
    scp: TokenPrincipal['scp'],
    retried: boolean,
  ): Promise<Answer> {
    try {
      return await attempt(command, tokenHash, scp);
    } catch (error) {
      if (!retried && isParentConflict(error)) {
        logger.info(
          { app_id: command.verifiedDevice.appId, token_hash_prefix: tokenHash.slice(0, 8) },
          'refresh_concurrent_rotation',
        );
        return settle(command, tokenHash, scp, true);
      }
      logger.error(
        {
          app_id: command.verifiedDevice.appId,
          token_hash_prefix: tokenHash.slice(0, 8),
          ...errorFields(error),
        },
        'refresh_failed',
      );
      return { code: 50001 };
    }
  }

  return {
    async refresh(command) {
      const tokenHash = createHash('sha256').update(command.refresh_token).digest('hex');
      // Judged before any transaction: the reader must never wait for a pool connection while
      // this request already holds one.
      let scp: TokenPrincipal['scp'];
      try {
        scp = await sessionScope(
          {
            appId: command.verifiedDevice.appId,
            platform: command.platform,
            ...(command.channel === undefined ? {} : { channel: command.channel }),
            ...(command.version === undefined ? {} : { version: command.version }),
          },
          versions,
        );
      } catch (error) {
        logger.error(
          {
            app_id: command.verifiedDevice.appId,
            token_hash_prefix: tokenHash.slice(0, 8),
            ...errorFields(error),
          },
          'refresh_scope_failed',
        );
        return { code: 50001 };
      }
      return settle(command, tokenHash, scp, false);
    },
  };
}
