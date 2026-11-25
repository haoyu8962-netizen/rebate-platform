// Admin site re-authorization sessions (B1-22c; BR-ID-24 ③ and 细则「后台告警手机号与重新授权会话」;
// 编排裁定 D10-152 ⑤, D10-159, D10-164, D10-176). union is the only writer of union_accounts,
// union_credentials and admin_union_auth_sessions. Use-case layer only: HTTP (admin auth, step-up,
// 20001 mapping) is B1-22d; the platform OAuth ports are injected (no real platform is called).
//
// start: one new session per call (several pending sessions per account are allowed: early
// renewal). The state is 32 random bytes (base64url, 43 characters) handed to the provider for
// the authorize URL; only its SHA-256 is stored. The session and its `union.reauth_start` audit
// row are written in one transaction.
//
// callback (no admin identity; the state finds the session), in this order:
//   unknown hash, already used (used_at set) or not pending → invalid, nothing written;
//   now ≥ expires_at → expired (finished_at = now), no exchange;
//   platform error or missing code → failed with the platform error (≤ 200 characters);
//   otherwise the session is claimed by one conditional UPDATE (status pending, used_at null,
//   not expired; it stays pending with used_at set, B1-22a CHECK), so of two concurrent callbacks
//   only one exchanges the code. The exchange runs outside any transaction. Its failure marks the
//   session failed with an error category only. Its success rotates the current credential
//   (FieldCrypto, contexts union_credentials.access / .refresh), renews the account, marks the
//   session succeeded and appends `union.reauth_succeeded`, all in one transaction: an audit
//   failure rolls everything back (the session is then marked failed, best effort).
//
// expireStale / result never treat a claimed session (used_at set, still pending) as expired:
// its exchange may still be running and will finish it. Every step after the claim fails the
// session on error (failed, error = category); a claim that still has not finished 30 minutes
// after used_at (the callback process died) is failed as `stalled` by expireStale and result.
//
// B1-22zd (BR-ID-24 ③ 细则「授权时长与续期」「记录与显示」; D10-2584, D10-2587, D10-2758): the new
// credential row also gets the provider's validity periods (token.durations: Taobao re_expires_in
// and r1 / r2 / w1 / w2_expires_in, seconds; only whole numbers ≥ 0 are kept, anything else and a
// provider without them is NULL), never logged or audited; and, after the renewal committed, the
// hour alert jobs of the new authorization are sent when a queue is handed in (./hour-alerts.ts).
// Best effort: a send that fails (e.g. the queue is not running) never undoes the renewal; it is
// one warn line `union_auth_hour_schedule_failed` (flat ids only) and the daily check backfills.
//
// Plain tokens, codes, states and authorize URLs never reach the database, audit rows, errors or
// logs (the only log line is the one above). Time comes only from the injected Clock.
import { createHash, randomBytes as nodeRandomBytes } from 'node:crypto';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { ContentReader } from '../../content/index.ts';
import {
  newUuidV7,
  type Clock,
  type FieldCrypto,
  type JobQueue,
  type RootLogger,
} from '../../platform/index.ts';
import { isRegisteredPlatform, type RegisteredPlatform } from '../domain/types.ts';
import type { UnionAuditWriter } from '../pids/service.ts';
import { alertHoursOf, sendHourAlerts } from './hour-alerts.ts';

export type ReauthMode = 'oauth' | 'manual' | 'none';

/** Validity periods a provider answered with (seconds), as parsed by the provider. */
export interface SiteOAuthDurations {
  readonly reExpiresIn: number | null;
  readonly r1ExpiresIn: number | null;
  readonly r2ExpiresIn: number | null;
  readonly w1ExpiresIn: number | null;
  readonly w2ExpiresIn: number | null;
}

/** The token of an exchange; `durations` only from a provider that reads them (Taobao). */
export interface SiteOAuthToken {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  readonly durations?: SiteOAuthDurations;
}

export interface SiteOAuthProvider {
  authorizeUrl(input: {
    appId: string;
    unionAccountId: string;
    state: string;
    expiresAt: Date;
  }): Promise<string>;
  exchange(input: { appId: string; unionAccountId: string; code: string }): Promise<SiteOAuthToken>;
}

export interface SiteReauthOptions {
  db: Kysely<DB>;
  clock: Clock;
  crypto: FieldCrypto;
  auditWriter: (db: Kysely<DB>) => UnionAuditWriter;
  config: Pick<ContentReader, 'configValue'>;
  modes?: Partial<Readonly<Record<RegisteredPlatform, ReauthMode>>>;
  oauth: Partial<Readonly<Record<RegisteredPlatform, SiteOAuthProvider>>>;
  randomBytes?: (n: number) => Buffer;
  /** Sends the hour alert jobs of a new authorization; absent → the daily check backfills them. */
  queue?: Pick<JobQueue, 'send'>;
  /** Receives the warn line of a failed hour job send. */
  logger?: Pick<RootLogger, 'warn'>;
}

export type SiteReauthErrorCode =
  'account_not_found' | 'reauth_unsupported' | 'reauth_manual' | 'provider_missing';

const ERROR_MESSAGES: Readonly<Record<SiteReauthErrorCode, string>> = {
  account_not_found: 'union account not found in this app',
  reauth_unsupported: 'platform has no site authorization to renew',
  reauth_manual: 'platform site credential is renewed by manual entry',
  provider_missing: 'no OAuth provider registered for the platform',
};

/** Refusal of start (not an HTTP error code; B1-22d maps it). */
export class SiteReauthError extends Error {
  readonly code: SiteReauthErrorCode;

  constructor(code: SiteReauthErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'SiteReauthError';
    this.code = code;
  }
}

export interface SiteReauth {
  reauthMode(appId: string, platform: RegisteredPlatform): Promise<ReauthMode>;
  start(input: {
    appId: string;
    unionAccountId: string;
    adminId: string;
    reason: string | null;
    ip: string | null;
  }): Promise<{ sessionId: string; authUrl: string; expiresAt: Date }>;
  callback(input: { state: string; code: string | null; error: string | null }): Promise<{
    sessionId: string | null;
    status: 'succeeded' | 'failed' | 'expired' | 'invalid';
  }>;
  result(input: { appId: string; unionAccountId: string; sessionId: string }): Promise<{
    status: 'pending' | 'succeeded' | 'failed' | 'expired';
    error: string | null;
    finishedAt: Date | null;
  } | null>;
  expireStale(): Promise<number>;
}

/** BR-ID-24 细则: state single use, valid 10 minutes (the authorize URL too). */
const SESSION_TTL_MS = 10 * 60 * 1000;
/** BR-ID-24 细则: no expiry returned → authorization time + 90 days, flagged as estimated. */
const ESTIMATED_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const STATE_BYTES = 32;
const ERROR_MAX = 200;
const JD_MODE_KEY = 'attr.jd.user_key_mode';
const ACCESS_CONTEXT = 'union_credentials.access';
const REFRESH_CONTEXT = 'union_credentials.refresh';
/** Error categories recorded on failed sessions; never the platform's raw text or a token. */
const MISSING_CODE = 'missing_code';
const EXCHANGE_FAILED = 'exchange_failed';
const FINALIZE_FAILED = 'finalize_failed';
const CALLBACK_FAILED = 'callback_failed';
const STALLED = 'stalled';
/**
 * A claimed session (used_at set, still pending) whose callback never finished — the process or
 * the database went away after the claim — is failed once this long has passed since the claim, so
 * the admin page never polls a session that stays pending for ever. Longer than any exchange plus
 * the session lifetime (代理补全的默认, Codex money review B1-22c r1).
 */
const STALLED_AFTER_MS = 30 * 60 * 1000;
/** int4 upper bound of the duration columns; a larger number is not stored (NULL). */
const DURATION_MAX = 2_147_483_647;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** D10-164: platform registry default (09 CAP-*-12); jd is derived from attr.jd.user_key_mode. */
const DEFAULT_MODES: Readonly<Record<Exclude<RegisteredPlatform, 'jd'>, ReauthMode>> = {
  taobao: 'oauth',
  pdd: 'none',
};

type SessionStatus = 'pending' | 'succeeded' | 'failed' | 'expired';
type CallbackResult = Awaited<ReturnType<SiteReauth['callback']>>;

/** `instant` plus `ms` as a new Date (the Clock's instant is never modified). */
function later(instant: Date, ms: number): Date {
  const result = structuredClone(instant);
  result.setTime(instant.getTime() + ms);
  return result;
}

function sha256(state: string): Buffer {
  return createHash('sha256').update(state).digest();
}

/** Platform error string cut to ≤ 200 UTF-16 units without splitting a surrogate pair. */
function truncate(value: string): string {
  if (value.length <= ERROR_MAX) return value;
  const cut = value.slice(0, ERROR_MAX);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

/** A stored duration: a whole number of seconds 0 – int4 max, else null. */
function duration(value: unknown): number | null {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= DURATION_MAX
    ? value
    : null;
}

export function createSiteReauth(options: SiteReauthOptions): SiteReauth {
  const { db, clock, crypto, config } = options;
  const entropy = options.randomBytes ?? nodeRandomBytes;
  const app = () => db.withSchema('app');

  async function reauthMode(appId: string, platform: RegisteredPlatform): Promise<ReauthMode> {
    const registered = options.modes?.[platform];
    if (registered !== undefined) return registered;
    if (platform !== 'jd') return DEFAULT_MODES[platform];
    const row = await config.configValue(appId, JD_MODE_KEY);
    return row?.value === 'private_position' ? 'manual' : 'none';
  }

  /** Expired, unused, still pending → expired; returns the rows changed (0 or 1). */
  async function markExpired(id: string, now: Date): Promise<boolean> {
    const result = await app()
      .updateTable('admin_union_auth_sessions')
      .set({ status: 'expired', finished_at: now, updated_at: now })
      .where('id', '=', id)
      .where('status', '=', 'pending')
      .where('used_at', 'is', null)
      .where('expires_at', '<=', now)
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  /** A claimed session (used_at set, still pending) → failed with an error category. */
  async function failClaimed(id: string, error: string): Promise<void> {
    const now = clock.now();
    await app()
      .updateTable('admin_union_auth_sessions')
      .set({ status: 'failed', error, finished_at: now, updated_at: now })
      .where('id', '=', id)
      .where('status', '=', 'pending')
      .where('used_at', 'is not', null)
      .execute();
  }

  /** Claimed sessions pending for STALLED_AFTER_MS since used_at → failed (`stalled`). */
  async function failStalled(now: Date, id: string | null): Promise<void> {
    let query = app()
      .updateTable('admin_union_auth_sessions')
      .set({ status: 'failed', error: STALLED, finished_at: now, updated_at: now })
      .where('status', '=', 'pending')
      .where('used_at', 'is not', null)
      .where('used_at', '<=', later(now, -STALLED_AFTER_MS));
    if (id !== null) query = query.where('id', '=', id);
    await query.execute();
  }

  async function finish(
    session: { id: string; app_id: string; union_account_id: string; created_by: string },
    token: SiteOAuthToken,
  ): Promise<void> {
    const durations = token.durations;
    const renewal = await db.transaction().execute(async (trx) => {
      const tx = trx.withSchema('app');
      const now = clock.now();
      const account = await tx
        .selectFrom('union_accounts')
        .select(['auth_expires_at', 'auth_expires_estimated', 'auth_status', 'alert_stage'])
        .select('row_version')
        .where('app_id', '=', session.app_id)
        .where('id', '=', session.union_account_id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const estimated = token.expiresAt === null;
      const expiresAt = token.expiresAt ?? later(now, ESTIMATED_TTL_MS);

      await tx
        .updateTable('union_credentials')
        .set({ is_current: false, updated_at: now })
        .where('app_id', '=', session.app_id)
        .where('union_account_id', '=', session.union_account_id)
        .where('is_current', '=', true)
        .execute();
      await tx
        .insertInto('union_credentials')
        .values({
          id: newUuidV7(now),
          app_id: session.app_id,
          union_account_id: session.union_account_id,
          access_token_cipher: Buffer.from(crypto.encrypt(token.accessToken, ACCESS_CONTEXT)),
          refresh_token_cipher:
            token.refreshToken === null
              ? null
              : Buffer.from(crypto.encrypt(token.refreshToken, REFRESH_CONTEXT)),
          expires_at: expiresAt,
          is_current: true,
          re_expires_in_s: duration(durations?.reExpiresIn),
          r1_expires_in_s: duration(durations?.r1ExpiresIn),
          r2_expires_in_s: duration(durations?.r2ExpiresIn),
          w1_expires_in_s: duration(durations?.w1ExpiresIn),
          w2_expires_in_s: duration(durations?.w2ExpiresIn),
          created_at: now,
          updated_at: now,
        })
        .execute();

      const renewed = await tx
        .updateTable('union_accounts')
        .set({
          auth_expires_at: expiresAt,
          auth_expires_estimated: estimated,
          auth_renewed_at: now,
          auth_renewed_by: session.created_by,
          auth_status: 'active',
          alert_stage: 'none',
          row_version: account.row_version + 1,
          updated_at: now,
        })
        .where('app_id', '=', session.app_id)
        .where('id', '=', session.union_account_id)
        .where('row_version', '=', account.row_version)
        .executeTakeFirst();
      if (renewed.numUpdatedRows !== 1n) throw new Error('union account changed concurrently');

      const done = await tx
        .updateTable('admin_union_auth_sessions')
        .set({ status: 'succeeded', finished_at: now, updated_at: now })
        .where('id', '=', session.id)
        .where('status', '=', 'pending')
        .where('used_at', 'is not', null)
        .executeTakeFirst();
      if (done.numUpdatedRows !== 1n) throw new Error('reauth session is no longer claimed');

      await options.auditWriter(trx).append({
        appId: session.app_id,
        actor: session.created_by,
        action: 'union.reauth_succeeded',
        target: session.union_account_id,
        before: {
          auth_expires_at: iso(account.auth_expires_at),
          auth_status: account.auth_status,
          alert_stage: account.alert_stage,
          auth_expires_estimated: account.auth_expires_estimated,
        },
        after: {
          auth_expires_at: expiresAt.toISOString(),
          auth_status: 'active',
          alert_stage: 'none',
          auth_expires_estimated: estimated,
        },
        ip: null,
      });
      return { expiresAt, renewedAt: now };
    });

    // The new authorization is committed and the session succeeded above; reading the hour nodes
    // and sending their jobs come only now, in one failure-isolated step (money r1 S1-④, B1-22ze):
    // a config read or queue failure never blocks the re-authorization, and the daily backfill and
    // the heal (./service.ts) send the jobs again.
    const queue = options.queue;
    if (queue === undefined) return;
    try {
      const hours = await alertHoursOf(config, session.app_id);
      await sendHourAlerts(queue, {
        trx: null,
        target: {
          appId: session.app_id,
          unionAccountId: session.union_account_id,
          expiresAt: renewal.expiresAt,
          renewedAt: renewal.renewedAt,
        },
        hours,
        clock,
      });
    } catch (error) {
      options.logger?.warn(
        {
          app_id: session.app_id,
          union_account_id: session.union_account_id,
          error_name: error instanceof Error ? error.name : typeof error,
        },
        'union_auth_hour_schedule_failed',
      );
    }
  }

  return {
    reauthMode,

    async start(input) {
      if (typeof input.unionAccountId !== 'string' || !UUID.test(input.unionAccountId)) {
        throw new SiteReauthError('account_not_found');
      }
      const account = await app()
        .selectFrom('union_accounts')
        .select(['id', 'platform'])
        .where('app_id', '=', input.appId)
        .where('id', '=', input.unionAccountId)
        .executeTakeFirst();
      if (account === undefined) throw new SiteReauthError('account_not_found');
      if (!isRegisteredPlatform(account.platform)) throw new SiteReauthError('reauth_unsupported');
      const mode = await reauthMode(input.appId, account.platform);
      if (mode === 'none') throw new SiteReauthError('reauth_unsupported');
      if (mode === 'manual') throw new SiteReauthError('reauth_manual');
      const provider = options.oauth[account.platform];
      if (provider === undefined) throw new SiteReauthError('provider_missing');

      const now = clock.now();
      const expiresAt = later(now, SESSION_TTL_MS);
      const state = entropy(STATE_BYTES).toString('base64url');
      const sessionId = newUuidV7(now);
      // The provider only builds a URL; it runs before the transaction so no lock waits on it.
      const authUrl = await provider.authorizeUrl({
        appId: input.appId,
        unionAccountId: account.id,
        state,
        expiresAt,
      });
      await db.transaction().execute(async (trx) => {
        await trx
          .withSchema('app')
          .insertInto('admin_union_auth_sessions')
          .values({
            id: sessionId,
            app_id: input.appId,
            union_account_id: account.id,
            state_hash: sha256(state),
            created_by: input.adminId,
            expires_at: expiresAt,
            used_at: null,
            status: 'pending',
            error: null,
            created_at: now,
            updated_at: now,
            finished_at: null,
          })
          .execute();
        await options.auditWriter(trx).append({
          appId: input.appId,
          actor: input.adminId,
          action: 'union.reauth_start',
          target: account.id,
          before: null,
          after: { session_id: sessionId, reason: input.reason },
          ip: input.ip,
        });
      });
      return { sessionId, authUrl, expiresAt };
    },

    async callback(input): Promise<CallbackResult> {
      const invalid: CallbackResult = { sessionId: null, status: 'invalid' };
      if (typeof input.state !== 'string') return invalid;
      const session = await app()
        .selectFrom('admin_union_auth_sessions')
        .select(['id', 'app_id', 'union_account_id', 'created_by', 'expires_at', 'used_at'])
        .select('status')
        .where('state_hash', '=', sha256(input.state))
        .executeTakeFirst();
      if (session === undefined || session.used_at !== null || session.status !== 'pending') {
        return invalid;
      }
      const now = clock.now();
      if (now.getTime() >= session.expires_at.getTime()) {
        return (await markExpired(session.id, now))
          ? { sessionId: session.id, status: 'expired' }
          : invalid;
      }

      const platformError =
        typeof input.error === 'string' && input.error.length > 0 ? truncate(input.error) : null;
      const code = typeof input.code === 'string' && input.code.length > 0 ? input.code : null;
      // Claim: only one caller turns used_at from null to now (status stays pending until done).
      const claim = app()
        .updateTable('admin_union_auth_sessions')
        .where('id', '=', session.id)
        .where('status', '=', 'pending')
        .where('used_at', 'is', null)
        .where('expires_at', '>', now);
      if (platformError !== null || code === null) {
        const failed = await claim
          .set({
            status: 'failed',
            used_at: now,
            finished_at: now,
            error: platformError ?? MISSING_CODE,
            updated_at: now,
          })
          .executeTakeFirst();
        return failed.numUpdatedRows > 0n ? { sessionId: session.id, status: 'failed' } : invalid;
      }
      const claimed = await claim.set({ used_at: now, updated_at: now }).executeTakeFirst();
      if (claimed.numUpdatedRows === 0n) return invalid;

      let platform: { platform: string };
      try {
        platform = await app()
          .selectFrom('union_accounts')
          .select('platform')
          .where('app_id', '=', session.app_id)
          .where('id', '=', session.union_account_id)
          .executeTakeFirstOrThrow();
      } catch (error) {
        // The claim is committed: never leave it pending (a retry would only see `invalid`).
        await failClaimed(session.id, CALLBACK_FAILED).catch(() => undefined);
        throw error;
      }
      const provider = isRegisteredPlatform(platform.platform)
        ? options.oauth[platform.platform]
        : undefined;
      let token: Awaited<ReturnType<SiteOAuthProvider['exchange']>>;
      try {
        if (provider === undefined) throw new SiteReauthError('provider_missing');
        token = await provider.exchange({
          appId: session.app_id,
          unionAccountId: session.union_account_id,
          code,
        });
      } catch {
        // The provider's error may quote the code or a token: only the category is kept.
        await failClaimed(session.id, EXCHANGE_FAILED);
        return { sessionId: session.id, status: 'failed' };
      }

      try {
        await finish(session, token);
      } catch (error) {
        // Nothing of the rotation was committed; the claimed session must not stay pending.
        await failClaimed(session.id, FINALIZE_FAILED).catch(() => undefined);
        throw error;
      }
      return { sessionId: session.id, status: 'succeeded' };
    },

    async result(input) {
      if (typeof input.sessionId !== 'string' || !UUID.test(input.sessionId)) return null;
      if (typeof input.unionAccountId !== 'string' || !UUID.test(input.unionAccountId)) {
        return null;
      }
      const row = await app()
        .selectFrom('admin_union_auth_sessions')
        .select(['id', 'status', 'error', 'finished_at', 'expires_at', 'used_at'])
        .where('app_id', '=', input.appId)
        .where('union_account_id', '=', input.unionAccountId)
        .where('id', '=', input.sessionId)
        .executeTakeFirst();
      if (row === undefined) return null;
      const now = clock.now();
      if (
        row.status === 'pending' &&
        row.used_at !== null &&
        now.getTime() - row.used_at.getTime() >= STALLED_AFTER_MS
      ) {
        await failStalled(now, row.id);
        const current = await app()
          .selectFrom('admin_union_auth_sessions')
          .select(['status', 'error', 'finished_at'])
          .where('id', '=', row.id)
          .executeTakeFirstOrThrow();
        return {
          status: current.status as SessionStatus,
          error: current.error,
          finishedAt: current.finished_at,
        };
      }
      if (
        row.status === 'pending' &&
        row.used_at === null &&
        now.getTime() >= row.expires_at.getTime()
      ) {
        if (await markExpired(row.id, now)) {
          return { status: 'expired', error: null, finishedAt: now };
        }
        // Changed concurrently (claimed, finished or expired): report what is stored now.
        const current = await app()
          .selectFrom('admin_union_auth_sessions')
          .select(['status', 'error', 'finished_at'])
          .where('id', '=', row.id)
          .executeTakeFirstOrThrow();
        return {
          status: current.status as SessionStatus,
          error: current.error,
          finishedAt: current.finished_at,
        };
      }
      return { status: row.status as SessionStatus, error: row.error, finishedAt: row.finished_at };
    },

    async expireStale() {
      const now = clock.now();
      // Stalled claims are failed, not expired, and are not part of the returned count.
      await failStalled(now, null);
      const result = await app()
        .updateTable('admin_union_auth_sessions')
        .set({ status: 'expired', finished_at: now, updated_at: now })
        .where('status', '=', 'pending')
        .where('used_at', 'is', null)
        .where('expires_at', '<=', now)
        .executeTakeFirst();
      return Number(result.numUpdatedRows);
    },
  };
}
