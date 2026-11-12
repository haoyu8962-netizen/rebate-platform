// Admin union accounts (B1-22d; BR-ID-24 ③ and 细则「后台联盟账号列表」「后台告警手机号与重新授权会话」
// 「各平台 reauth_mode 的取法」「none 与 manual 平台的到期、探测与提醒」; 编排裁定 D10-152, D10-159,
// D10-164, D10-176, D10-196; contract tag admin-unions, 04 §6.6 union-accounts). union is the only
// writer of union_accounts and union_credentials. The controller has already checked the
// admin_token, the permission point union.account_auth and (start, credential) the totp step-up;
// the app and the admin are the guard's actor, never request fields.
//
// - list: every account of the app (platform, then account_name), with the derived reauth_mode
//   (the injected SiteReauth.reauthMode, the platform registry of B1-22c — no second switch here),
//   alert_phones_configured (union.auth_alert_phones decodes to a non-empty list) and
//   auth_expires_estimated as stored; never alert_stage or a credential.
//   列表页的「待处理」口径（B1-22zc，D10-1401）是 domain/auth-pending.ts 的 isUnionAuthPending
//   （auth_status ∈ {expiring, expired}）；list 原样返回全部行，不按它筛选，工作台卡
//   union_auth_expiring 的计数（auth-pending-count.ts）用同一判定。
// - start / result / callback: B1-22c createSiteReauth; SiteReauthError and the callback's
//   `invalid` are mapped to the contract's 20001 (data.fields, data.reason=manual_mode). The
//   callback only finishes a session of the signed-in admin of the same app; a session that is no
//   longer pending is answered as it is. The audit actions of the contract
//   (union_account_reauthorize_start / union_account_reauthorize) are given by the audit writer
//   handed to createSiteReauth (reauthAuditWriter below), so B1-22c keeps its own names.
// - putCredential (reauth_mode manual only): the plaintext only goes into FieldCrypto
//   (union_credentials.access); the current credential is rotated, auth_expires_at is the given
//   expiry or now + the platform's registered Key validity (estimated), auth_renewed_at / by,
//   auth_status (from the new expiry and union.auth_alert_days, as B1-22b judges it) and
//   alert_stage none are written, and an audit row union_account_credential (never the
//   credential) is appended, all in one transaction on the account row locked FOR UPDATE. The union
//   is not called; the next daily probe checks the new credential.
//
// Plain credentials, codes, states and tokens never reach errors, audit rows, responses or logs.
// Time comes only from the injected Clock. Pure module (no decorators, erasable syntax).
import { createHash } from 'node:crypto';
import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Kysely, Selectable } from 'kysely';
import type { ContentReader } from '../../content/index.ts';
import { newUuidV7, type Clock, type FieldCrypto, type RootLogger } from '../../platform/index.ts';
import { SiteReauthError, type ReauthMode, type SiteReauth } from '../auth-expiry/reauth.ts';
import {
  DEFAULT_ALERT_DAYS,
  DEFAULT_PROBE_TIME,
  parseAlertDays,
  parseProbeCron,
  remainingDays,
  statusFor,
} from '../auth-expiry/schedule.ts';
import { decodeAlertPhones } from '../auth-expiry/service.ts';
import { validAdminUnionReason } from '../domain/admin-reason.ts';
import { isRegisteredPlatform, type RegisteredPlatform } from '../domain/types.ts';
import type { UnionAuditWriter } from '../pids/service.ts';

export type AdminUnionAccount = Schema<'AdminUnionAccount'>;
export type AdminUnionReauthSession = Schema<'AdminUnionReauthSession'>;
export type AdminUnionReauthResult = Schema<'AdminUnionReauthResult'>;

/** The signed-in admin of the request. */
export interface AdminUnionAccountActor {
  readonly appId: string;
  readonly adminId: string;
  readonly ip: string | null;
}

/** Platform registry: validity in days of a manually entered station-owner credential. */
export type ManualKeyValidity = Partial<Readonly<Record<RegisteredPlatform, number>>>;

/**
 * D10-196: the Key validity of each platform's manual credential, registered per platform (not
 * fixed in the use case). Documented 365 days for the JD 推客授权 Key (CAP-JD-12, pending
 * measurement); taobao and pdd have no manual credential today and carry the same documented
 * default should the registry ever make them manual.
 */
export const MANUAL_KEY_VALIDITY_DAYS: Readonly<Record<RegisteredPlatform, number>> = Object.freeze(
  { jd: 365, pdd: 365, taobao: 365 },
);

export interface AdminUnionAccountsOptions {
  /** Absent in isolated HTTP unit tests: every call fails closed. */
  readonly db: Kysely<DB> | undefined;
  readonly clock: Clock;
  readonly crypto: FieldCrypto | undefined;
  readonly config: (db: Kysely<DB>, clock: Clock) => Pick<ContentReader, 'configValue'>;
  readonly auditWriter: (db: Kysely<DB>) => UnionAuditWriter;
  readonly reauth: SiteReauth | null;
  /** Overrides of MANUAL_KEY_VALIDITY_DAYS per platform (whole days ≥ 1). */
  readonly keyValidityDays?: ManualKeyValidity;
  /** Receives one flat error line when union.auth_alert_phones cannot be read. */
  readonly logger?: Pick<RootLogger, 'error'>;
}

/** Refusal mapped to 20001 with data.fields (and data.reason=manual_mode when set). */
export class AdminUnionAccountFieldsError extends Error {
  readonly fields: readonly string[];
  readonly reason: 'manual_mode' | null;

  constructor(fields: readonly string[], reason: 'manual_mode' | null) {
    super(`union account: invalid ${fields.join(', ')}`);
    this.name = 'AdminUnionAccountFieldsError';
    this.fields = fields;
    this.reason = reason;
  }
}

/** Contract audit actions of the B1-22c session writes (its own names stay as they are). */
const REAUTH_ACTIONS: Readonly<Record<string, string>> = Object.freeze({
  'union.reauth_start': 'union_account_reauthorize_start',
  'union.reauth_succeeded': 'union_account_reauthorize',
});

/** The audit writer handed to createSiteReauth: B1-22c's actions under the contract's names. */
export function reauthAuditWriter(
  writer: (db: Kysely<DB>) => UnionAuditWriter,
): (db: Kysely<DB>) => UnionAuditWriter {
  return (db) => {
    const bound = writer(db);
    return {
      append: (input) =>
        bound.append({ ...input, action: REAUTH_ACTIONS[input.action] ?? input.action }),
    };
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_MS = 86_400_000;
const CREDENTIAL_MAX = 512;
const ACCESS_CONTEXT = 'union_credentials.access';
const KEY_PHONES = 'union.auth_alert_phones';
const KEY_DAYS = 'union.auth_alert_days';
const KEY_CRON = 'union.auth_probe_cron';
const ACTION_CREDENTIAL = 'union_account_credential';
/** contract date-time (RFC 3339). */
const DATE_TIME = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/;

const ACCOUNT_COLUMNS = [
  'id',
  'platform',
  'account_name',
  'status',
  'sync_start_at',
  'auth_expires_at',
  'auth_expires_estimated',
  'auth_status',
  'auth_renewed_at',
  'auth_renewed_by',
  'last_probe_at',
  'last_probe_ok',
  'last_probe_error',
] as const;

type AccountRow = Pick<Selectable<DB['union_accounts']>, (typeof ACCOUNT_COLUMNS)[number]>;

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

/** A Date of the same kind as `like` at `ms` (no wall clock, no `new Date`). */
function dateAt(like: Date, ms: number): Date {
  const result = structuredClone(like);
  result.setTime(ms);
  return result;
}

function sha256(state: string): Buffer {
  return createHash('sha256').update(state).digest();
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function optionalReason(value: unknown): string | null {
  if (value === undefined) return null;
  // D10-427 ①: 1–200 characters without a Cc control character, else 20001 [reason].
  if (typeof value !== 'string' || !validAdminUnionReason(value)) {
    throw new AdminUnionAccountFieldsError(['reason'], null);
  }
  return value;
}

function toAccount(row: AccountRow, mode: ReauthMode, phones: boolean): AdminUnionAccount {
  return {
    union_account_id: row.id,
    platform: row.platform as AdminUnionAccount['platform'],
    account_name: row.account_name,
    status: row.status,
    sync_start_at: iso(row.sync_start_at),
    auth_expires_at: iso(row.auth_expires_at),
    auth_expires_estimated: row.auth_expires_estimated,
    auth_status: row.auth_status as AdminUnionAccount['auth_status'],
    auth_renewed_at: iso(row.auth_renewed_at),
    auth_renewed_by: row.auth_renewed_by,
    last_probe_at: iso(row.last_probe_at),
    last_probe_ok: row.last_probe_ok,
    last_probe_error: row.last_probe_error,
    alert_phones_configured: phones,
    reauth_mode: mode,
  };
}

export class AdminUnionAccounts {
  readonly #db: Kysely<DB> | undefined;
  readonly #clock: Clock;
  readonly #crypto: FieldCrypto | undefined;
  readonly #config: (db: Kysely<DB>, clock: Clock) => Pick<ContentReader, 'configValue'>;
  readonly #auditWriter: (db: Kysely<DB>) => UnionAuditWriter;
  readonly #reauth: SiteReauth | null;
  readonly #validity: Readonly<Record<RegisteredPlatform, number>>;
  readonly #logger: Pick<RootLogger, 'error'> | undefined;

  constructor(options: AdminUnionAccountsOptions) {
    this.#db = options.db;
    this.#clock = options.clock;
    this.#crypto = options.crypto;
    this.#config = options.config;
    this.#auditWriter = options.auditWriter;
    this.#reauth = options.reauth;
    this.#validity = { ...MANUAL_KEY_VALIDITY_DAYS, ...options.keyValidityDays };
    this.#logger = options.logger;
  }

  async list(appId: string): Promise<AdminUnionAccount[]> {
    const db = this.#database();
    const rows = await db
      .withSchema('app')
      .selectFrom('union_accounts')
      .select(ACCOUNT_COLUMNS)
      .where('app_id', '=', appId)
      .orderBy('platform')
      .orderBy('account_name')
      .orderBy('id')
      .execute();
    const phones = await this.#phonesConfigured(appId);
    const modes = new Map<string, Promise<ReauthMode>>();
    const modeOf = (platform: string): Promise<ReauthMode> => {
      let mode = modes.get(platform);
      if (mode === undefined) {
        mode = this.#reauthMode(appId, platform);
        modes.set(platform, mode);
      }
      return mode;
    };
    const items: AdminUnionAccount[] = [];
    for (const row of rows) items.push(toAccount(row, await modeOf(row.platform), phones));
    return items;
  }

  async start(
    actor: AdminUnionAccountActor,
    unionAccountId: string,
    body: Schema<'AdminUnionReauthorizeRequest'>,
  ): Promise<AdminUnionReauthSession> {
    const reason = optionalReason((body as { reason?: unknown }).reason);
    const reauth = this.#siteReauth();
    let started: Awaited<ReturnType<SiteReauth['start']>>;
    try {
      started = await reauth.start({
        appId: actor.appId,
        unionAccountId,
        adminId: actor.adminId,
        reason,
        ip: actor.ip,
      });
    } catch (error) {
      if (error instanceof SiteReauthError) {
        if (error.code === 'account_not_found' || error.code === 'reauth_unsupported') {
          throw new AdminUnionAccountFieldsError(['union_account_id'], null);
        }
        if (error.code === 'reauth_manual') {
          throw new AdminUnionAccountFieldsError(['union_account_id'], 'manual_mode');
        }
      }
      // provider_missing (no site OAuth adapter on this entry) or a failure: fails closed.
      throw error;
    }
    return {
      session_id: started.sessionId,
      auth_url: started.authUrl,
      expires_at: started.expiresAt.toISOString(),
    };
  }

  async result(
    actor: AdminUnionAccountActor,
    unionAccountId: string,
    sessionId: string,
  ): Promise<AdminUnionReauthResult> {
    const reauth = this.#siteReauth();
    if ((await this.#account(actor.appId, unionAccountId)) === undefined) {
      throw new AdminUnionAccountFieldsError(['union_account_id'], null);
    }
    if (!isUuid(sessionId)) throw new AdminUnionAccountFieldsError(['session_id'], null);
    // B1-22c's result expires an unused session past expires_at (and fails a stalled claim).
    const found = await reauth.result({ appId: actor.appId, unionAccountId, sessionId });
    if (found === null) throw new AdminUnionAccountFieldsError(['session_id'], null);
    return this.#session(actor.appId, sessionId);
  }

  async callback(
    actor: AdminUnionAccountActor,
    body: Schema<'AdminUnionOAuthCallbackRequest'>,
  ): Promise<AdminUnionReauthResult> {
    const input = body as { state?: unknown; code?: unknown; error?: unknown };
    if (typeof input.state !== 'string' || input.state.length === 0) {
      throw new AdminUnionAccountFieldsError(['state'], null);
    }
    const code = typeof input.code === 'string' && input.code.length > 0 ? input.code : null;
    const error = typeof input.error === 'string' && input.error.length > 0 ? input.error : null;
    if ((code === null) === (error === null) || Object.keys(input).length !== 2) {
      throw new AdminUnionAccountFieldsError(['code'], null);
    }
    const reauth = this.#siteReauth();
    // Only a session the signed-in admin started in this app; any other is an unknown state.
    const session = await this.#database()
      .withSchema('app')
      .selectFrom('admin_union_auth_sessions')
      .select(['id', 'status', 'used_at'])
      .where('state_hash', '=', sha256(input.state))
      .where('app_id', '=', actor.appId)
      .where('created_by', '=', actor.adminId)
      .executeTakeFirst();
    if (session === undefined) throw new AdminUnionAccountFieldsError(['state'], null);
    if (session.status === 'pending' && session.used_at === null) {
      // `invalid` here means a concurrent callback got the session first: answered as it is now.
      await reauth.callback({ state: input.state, code, error });
    }
    return this.#session(actor.appId, session.id);
  }

  async putCredential(
    actor: AdminUnionAccountActor,
    unionAccountId: string,
    body: Schema<'AdminUnionCredentialRequest'>,
  ): Promise<AdminUnionAccount> {
    const input = body as { credential?: unknown; expires_at?: unknown; reason?: unknown };
    const credential = input.credential;
    if (
      typeof credential !== 'string' ||
      credential.length === 0 ||
      credential.length > CREDENTIAL_MAX ||
      credential.trim() !== credential
    ) {
      throw new AdminUnionAccountFieldsError(['credential'], null);
    }
    const now = this.#clock.now();
    let given: Date | null = null;
    if (input.expires_at !== undefined) {
      const ms = typeof input.expires_at === 'string' ? Date.parse(input.expires_at) : NaN;
      if (
        typeof input.expires_at !== 'string' ||
        !DATE_TIME.test(input.expires_at) ||
        !Number.isFinite(ms) ||
        ms <= now.getTime()
      ) {
        throw new AdminUnionAccountFieldsError(['expires_at'], null);
      }
      given = dateAt(now, ms);
    }
    const reason = optionalReason(input.reason);

    const db = this.#database();
    const account = await this.#account(actor.appId, unionAccountId);
    if (
      account === undefined ||
      (await this.#reauthMode(actor.appId, account.platform)) !== 'manual'
    ) {
      throw new AdminUnionAccountFieldsError(['union_account_id'], null);
    }
    const crypto = this.#crypto;
    if (crypto === undefined) throw new Error('union: credential entry needs the field cipher');
    const platform = account.platform as RegisteredPlatform;
    const validityDays = this.#validity[platform];
    if (!Number.isInteger(validityDays) || validityDays < 1) {
      throw new Error('union: no manual Key validity registered for the platform');
    }
    const estimated = given === null;
    const expiresAt = given ?? dateAt(now, now.getTime() + validityDays * DAY_MS);
    const authStatus = await this.#statusFor(actor.appId, expiresAt, now);

    await db.transaction().execute(async (trx) => {
      const tx = trx.withSchema('app');
      const locked = await tx
        .selectFrom('union_accounts')
        .select(['auth_expires_at', 'auth_expires_estimated', 'auth_status', 'alert_stage'])
        .select('row_version')
        .where('app_id', '=', actor.appId)
        .where('id', '=', account.id)
        .forUpdate()
        .executeTakeFirstOrThrow();

      await tx
        .updateTable('union_credentials')
        .set({ is_current: false, updated_at: now })
        .where('app_id', '=', actor.appId)
        .where('union_account_id', '=', account.id)
        .where('is_current', '=', true)
        .execute();
      await tx
        .insertInto('union_credentials')
        .values({
          id: newUuidV7(now),
          app_id: actor.appId,
          union_account_id: account.id,
          access_token_cipher: Buffer.from(crypto.encrypt(credential, ACCESS_CONTEXT)),
          refresh_token_cipher: null,
          expires_at: expiresAt,
          is_current: true,
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
          auth_renewed_by: actor.adminId,
          auth_status: authStatus,
          alert_stage: 'none',
          row_version: locked.row_version + 1,
          updated_at: now,
        })
        .where('app_id', '=', actor.appId)
        .where('id', '=', account.id)
        .where('row_version', '=', locked.row_version)
        .executeTakeFirst();
      if (renewed.numUpdatedRows !== 1n) throw new Error('union account changed concurrently');

      await this.#auditWriter(trx).append({
        appId: actor.appId,
        actor: actor.adminId,
        action: ACTION_CREDENTIAL,
        target: account.id,
        before: {
          auth_expires_at: iso(locked.auth_expires_at),
          auth_expires_estimated: locked.auth_expires_estimated,
          auth_status: locked.auth_status,
          alert_stage: locked.alert_stage,
        },
        after: {
          auth_expires_at: expiresAt.toISOString(),
          auth_expires_estimated: estimated,
          auth_status: authStatus,
          alert_stage: 'none',
          reason,
        },
        ip: actor.ip,
      });
    });

    const row = await this.#account(actor.appId, account.id);
    if (row === undefined) throw new Error('union account disappeared after the credential entry');
    return toAccount(row, 'manual', await this.#phonesConfigured(actor.appId));
  }

  #database(): Kysely<DB> {
    if (this.#db === undefined) throw new Error('union: account administration needs the database');
    return this.#db;
  }

  #siteReauth(): SiteReauth {
    if (this.#reauth === null) {
      throw new Error('union: account re-authorization needs the database and the field cipher');
    }
    return this.#reauth;
  }

  async #account(appId: string, unionAccountId: string): Promise<AccountRow | undefined> {
    const db = this.#database();
    if (!isUuid(unionAccountId)) return undefined;
    return db
      .withSchema('app')
      .selectFrom('union_accounts')
      .select(ACCOUNT_COLUMNS)
      .where('app_id', '=', appId)
      .where('id', '=', unionAccountId)
      .executeTakeFirst();
  }

  /** The registry's reauth_mode (B1-22c SiteReauth); none for an unregistered platform. */
  async #reauthMode(appId: string, platform: string): Promise<ReauthMode> {
    if (!isRegisteredPlatform(platform)) return 'none';
    return this.#siteReauth().reauthMode(appId, platform);
  }

  async #phonesConfigured(appId: string): Promise<boolean> {
    const item = await this.#reader().configValue(appId, KEY_PHONES);
    if (item === null) return false;
    const crypto = this.#crypto;
    try {
      if (crypto === undefined) throw new Error('union: alert phones need the field cipher');
      return decodeAlertPhones(crypto, item.value).length > 0;
    } catch (error) {
      this.#logger?.error(
        { app_id: appId, key: KEY_PHONES, error_name: errorName(error) },
        'union_auth_alert_phones_unreadable',
      );
      return false;
    }
  }

  /** active / expiring for a new expiry, as the B1-22b daily check judges it. */
  async #statusFor(appId: string, expiresAt: Date, now: Date): Promise<'active' | 'expiring'> {
    const reader = this.#reader();
    const days = parseAlertDays((await reader.configValue(appId, KEY_DAYS))?.value ?? null);
    const time = parseProbeCron((await reader.configValue(appId, KEY_CRON))?.value ?? null);
    const left = remainingDays(expiresAt.getTime(), now.getTime(), time ?? DEFAULT_PROBE_TIME);
    return statusFor(left, days ?? DEFAULT_ALERT_DAYS);
  }

  /**
   * A fresh reader per call (B1-22g): the content reader caches, and the alert phones change on
   * this same entry through AdminUnionAlertPhonesService, so the list reads them as they are now.
   */
  #reader(): Pick<ContentReader, 'configValue'> {
    return this.#config(this.#database(), this.#clock);
  }

  async #session(appId: string, sessionId: string): Promise<AdminUnionReauthResult> {
    const row = await this.#database()
      .withSchema('app')
      .selectFrom('admin_union_auth_sessions')
      .select(['id', 'union_account_id', 'status', 'error', 'expires_at', 'finished_at'])
      .where('app_id', '=', appId)
      .where('id', '=', sessionId)
      .executeTakeFirstOrThrow();
    return {
      session_id: row.id,
      union_account_id: row.union_account_id,
      status: row.status as AdminUnionReauthResult['status'],
      error: row.error,
      expires_at: row.expires_at.toISOString(),
      finished_at: iso(row.finished_at),
    };
  }
}
