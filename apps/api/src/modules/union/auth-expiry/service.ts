// Site (站长) union authorization: the daily check, its probe retry, the expiry job, call-side
// failures and alert delivery (B1-22b; BR-ID-24 ①②④, 12 §7.2, task §9 判定口径; D10-179).
//
// Two independent checks per account and check run (one run per App at its union.auth_probe_cron
// time, +08:00; see ./schedule.ts for the day arithmetic):
// - expiry: auth_expires_at reached → expired (cause time, no probe, no refresh). Otherwise the
//   remaining days give the status (expiring once the largest node is reached) and at most one
//   UNION_AUTH_EXPIRING per run: the smallest node reached, when alert_stage is none or that node
//   is below the node already alerted (skipped nodes are never sent late). A refresher (none
//   exists today) is tried first when ≤ 7 days remain; success renews auth_expires_at
//   (+90 days, estimated, when the platform returns none), auth_renewed_at, alert_stage none.
// - probe: one call per account and run through the injected SiteAuthProbe. ok / auth_invalid /
//   transient write last_probe_*; unsupported writes nothing. auth_invalid → expired (cause
//   probe). transient → nothing changes; one probe_retry 30 minutes later, whose transient is a
//   warn line `union_auth_probe_failed` only. ok while expired before auth_expires_at (judged
//   invalid by a probe or a call) → active / expiring again, alert_stage = the smallest node
//   already reached (no EXPIRING resent), none when no node is reached.
// Entering expired (status not yet expired) plans one UNION_AUTH_EXPIRED unless alert_stage is
// already expired; the alert port keys it by the entry instant, so a later re-entry alerts again.
// impl-addenda B1-22b (D10-164): a platform whose reauth_mode is none (pdd; jd unless
// attr.jd.user_key_mode = private_position; options.reauthModes overrides) has no site
// authorization to expire: its probe writes last_probe_* only; no time check, refresh, alert or
// status change, and a call-side failure is ignored with a warn line.
//
// Every status / alert_stage change, its notify_logs rows (alerts.plan) and the deliver_alerts job
// commit in one transaction on the account row locked FOR UPDATE; the job sends after commit, at
// least once, and the notify_logs status keeps it from sending twice. No phones configured: a warn
// `union_auth_alert_phones_missing`, the stage still advances, nothing is planned. Alert lines
// (`union_auth_expiring` warn, `union_auth_expired` error) are written after commit, flat fields
// only, never phones, ciphertext or credentials.
//
// Job chain (queue union-auth, exclusive, worker only): seed() sends each App's next check slot
// (singletonKey per App and +08:00 minute); handle() runs that App's check and sends the next slot.
// heal() resends those next slots, a deliver_alerts job for every account with queued alerts,
// an expiry_due job for every account expiring within 24 hours and the hour jobs (B1-22zd, below);
// it never rejects.
//
// B1-22zd (BR-ID-24 细则「授权时长与续期」; D10-2585, D10-2587, D10-2758, D10-2771, D10-2777):
// - Skip rule: day and hour nodes whose lead is not below the total of the authorization
//   (auth_renewed_at → auth_expires_at; unknown when auth_renewed_at is null) are skipped for the
//   status, the alert and the hour jobs (./schedule.ts).
// - Hour nodes (union.auth_alert_hours): one `hour_alert` job per live node (./hour-alerts.ts),
//   planned on a new authorization (callback, manual entry, refresh; after the commit, best effort,
//   within the queue's largest delay) and backfilled by each daily check and each heal for the nodes
//   before the next check; the smallest node already due whose job was lost (hour_alert_key does
//   not carry it) is sent at once by both. At its instant the job plans one UNION_AUTH_EXPIRING
//   with stage h<N> (only in the alert dedupe key; alert_stage is never written by it) and puts the
//   account into expiring. It does nothing when the authorization changed since it was planned
//   (expiry or renewal instant differ), the account is expired (judged by a call or a probe), the
//   node is no longer live, or a smaller live hour node is already due (never sent late). Due
//   at or after the expiry → expired at once (EXPIRED only).
// - Repeat of an hour job: union_accounts.hour_alert_key ('<expiry ms>:h<N>', written only by the
//   hour job, on the locked row, together with its alert and status) marks the node handled; a
//   repeat or a late job of the same node, or of a larger node of the same authorization, finds it
//   and does nothing, phones configured or not (hourNodeHandled). The notify_logs dedupe key still
//   keeps the reminder itself from being planned twice. Without phones the backend alert line is
//   written inside the transaction, before the mark commits: at least once, never lost to a commit
//   whose result did not come back.
import { createHash } from 'node:crypto';
import type { DB } from '@couli/db';
import { sql, type Kysely, type Transaction, type Updateable } from 'kysely';
import type { ConfigValue, ContentReader } from '../../content/index.ts';
import type {
  Clock,
  FieldCrypto,
  JobQueue,
  ReceivedJob,
  RootLogger,
} from '../../platform/index.ts';
import {
  REGISTERED_PLATFORMS,
  isRegisteredPlatform,
  type RegisteredPlatform,
} from '../domain/types.ts';
import {
  DEFAULT_ALERT_DAYS,
  DEFAULT_PROBE_TIME,
  authStatusAt,
  authTotalMs,
  dueNode,
  hourNodeAt,
  liveDayNodes,
  liveHourNodes,
  nextCheckSlot,
  parseAlertDays,
  parseProbeCron,
  reachedNode,
  remainingDays,
  type ProbeTime,
} from './schedule.ts';
import {
  HOUR_JOB_MAX_DELAY_SECONDS,
  JOB_HOUR_ALERT,
  UNION_AUTH_QUEUE,
  alertHoursOf,
  hourAlertMark,
  hourNodeHandled,
  sendHourAlerts,
} from './hour-alerts.ts';
import { normalizeAlertPhone } from './phone.ts';

export { UNION_AUTH_QUEUE };
export type UnionAuthQueue = typeof UNION_AUTH_QUEUE;
export type SiteAuthProbeResult =
  | { kind: 'ok' }
  | { kind: 'auth_invalid'; error: string }
  | { kind: 'transient'; error: string }
  | { kind: 'unsupported' };
export interface SiteAuthAccount {
  appId: string;
  platform: RegisteredPlatform;
  unionAccountId: string;
}
export interface SiteAuthProbe {
  probe(account: SiteAuthAccount): Promise<SiteAuthProbeResult>;
}
export interface SiteAuthRefresher {
  refresh(
    account: SiteAuthAccount,
  ): Promise<{ ok: true; expiresAt: Date | null } | { ok: false; error: string }>;
}
/** One alert to record: one notify_logs row per phone id, on the caller's transaction. */
export interface SiteAuthAlertPlanInput {
  appId: string;
  unionAccountId: string;
  platform: RegisteredPlatform;
  authExpiresAt: Date | null;
  stage: string;
  code: 'UNION_AUTH_EXPIRING' | 'UNION_AUTH_EXPIRED';
  phoneIds: readonly string[];
}
/**
 * The alert port the monitor needs, implemented by notification's createSiteAuthAlertPort and
 * handed in by app.module. Declared here (the consumer owns the port) so union never imports
 * notification: notification → linking → union would close a dependency cycle.
 */
export interface SiteAuthAlerts {
  plan(trx: Transaction<DB>, plan: SiteAuthAlertPlanInput): Promise<number>;
  deliver(
    appId: string,
    unionAccountId: string,
    phones: readonly { phoneId: string; phone: string }[],
  ): Promise<void>;
  pending?(): Promise<readonly { appId: string; unionAccountId: string; oldestPlannedAt: Date }[]>;
}
/** How a platform's site authorization is renewed (D10-164): oauth, manual key entry, or none. */
export type SiteAuthReauthMode = 'oauth' | 'manual' | 'none';
export interface SiteAuthMonitorOptions {
  db: Kysely<DB>;
  clock: Clock;
  queue: JobQueue;
  logger: RootLogger;
  crypto: FieldCrypto;
  config: Pick<ContentReader, 'configValue'>;
  probe: SiteAuthProbe;
  refresher?: SiteAuthRefresher;
  alerts: SiteAuthAlerts;
  /** Registry override of the derived reauth_mode per platform. */
  reauthModes?: Partial<Record<RegisteredPlatform, SiteAuthReauthMode>>;
}
export interface SiteAuthMonitor {
  dailyCheck(): Promise<void>;
  probeRetry(appId: string, unionAccountId: string): Promise<void>;
  expiryDue(appId: string, unionAccountId: string, expiresAt: string): Promise<void>;
  reportAuthFailure(input: SiteAuthAccount & { error: string }): Promise<void>;
  deliverAlerts(appId: string, unionAccountId: string): Promise<void>;
  seed(): Promise<void>;
  handle(job: ReceivedJob): Promise<void>;
  heal(): Promise<void>;
}

const PHONE_CONTEXT = 'union.auth_alert_phones';
const KEY_PHONES = 'union.auth_alert_phones';
const KEY_DAYS = 'union.auth_alert_days';
const KEY_CRON = 'union.auth_probe_cron';
const KEY_JD_MODE = 'attr.jd.user_key_mode';
const JOB_DAILY = 'daily_check';
const JOB_RETRY = 'probe_retry';
const JOB_DUE = 'expiry_due';
const JOB_DELIVER = 'deliver_alerts';
const RETRY_DELAY_SECONDS = 1800;
const DUE_WINDOW_MS = 86_400_000;
const REFRESH_DAYS = 7;
const ESTIMATE_MS = 90 * 86_400_000;
const ERROR_MAX = 500;
const PLATFORMS: RegisteredPlatform[] = [...REGISTERED_PLATFORMS];
const SAFE_KEY_PART = /^[A-Za-z0-9._+-]{1,80}$/;

type AccountPatch = Updateable<DB['union_accounts']>;
type Cause = 'time' | 'probe' | 'call';
type Effect = () => void;

interface AccountRow {
  readonly id: string;
  readonly app_id: string;
  readonly platform: string;
  readonly auth_status: string;
  readonly auth_expires_at: Date | null;
  readonly alert_stage: string;
  readonly auth_renewed_at: Date | null;
  readonly row_version: number;
  readonly hour_alert_key: string | null;
}

interface AlertPhone {
  readonly phoneId: string;
  readonly phone: string;
}

interface AppContext {
  readonly appId: string;
  readonly nodes: readonly number[];
  readonly hours: readonly number[];
  readonly probeTime: ProbeTime;
  readonly phones: readonly AlertPhone[];
  readonly modes: Map<string, Promise<SiteAuthReauthMode>>;
}

const ACCOUNT_COLUMNS = [
  'id',
  'app_id',
  'platform',
  'auth_status',
  'auth_expires_at',
  'alert_stage',
  'auth_renewed_at',
  'row_version',
  'hour_alert_key',
] as const;

/**
 * The authorization version of a row: a probe answered for one version is applied only to the
 * same version (a reauthorization, refresh or any other write meanwhile makes it stale).
 */
function authVersion(row: AccountRow): string {
  return [
    row.row_version,
    row.auth_status,
    iso(row.auth_expires_at),
    iso(row.auth_renewed_at),
    row.alert_stage,
  ].join('|');
}

// ——— Alert phones (also used by B1-22d's writer) ———

/** The config value of a phone list: the whole list encrypted under one context (BR-ID-33). */
export function encodeAlertPhones(crypto: FieldCrypto, phones: readonly string[]): ConfigValue {
  return { cipher: crypto.encrypt(JSON.stringify(phones), PHONE_CONTEXT) };
}

/** The phone list of a config value; anything but an encrypted string array throws. */
export function decodeAlertPhones(crypto: FieldCrypto, value: ConfigValue): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('union: union.auth_alert_phones is not an encrypted phone list');
  }
  const cipher = (value as { cipher?: unknown }).cipher;
  if (typeof cipher !== 'string') {
    throw new Error('union: union.auth_alert_phones is not an encrypted phone list');
  }
  const parsed: unknown = JSON.parse(crypto.decrypt(cipher, PHONE_CONTEXT));
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) {
    throw new Error('union: union.auth_alert_phones is not an encrypted phone list');
  }
  return [...(parsed as string[])];
}

/** The HMAC id of a phone, normalised first (BR-ID-05); an invalid phone throws. */
export function alertPhoneId(crypto: FieldCrypto, phone: string): string {
  const normalized = normalizeAlertPhone(phone);
  if (normalized === null) throw new Error('union: invalid alert phone');
  return crypto.blindIndex(normalized, PHONE_CONTEXT);
}

// ——— Helpers ———

/** A Date of the same kind as `like` at `ms` (no wall clock, no `new Date`). */
function dateAt(like: Date, ms: number): Date {
  const result = structuredClone(like);
  result.setTime(ms);
  return result;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function clip(text: string): string {
  return text.length > ERROR_MAX ? text.slice(0, ERROR_MAX) : text;
}

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

/** A singletonKey-safe form of an App id (raw when already safe, else a short hash). */
function appKey(appId: string): string {
  return SAFE_KEY_PART.test(appId)
    ? appId
    : `h${createHash('sha256').update(appId).digest('hex').slice(0, 24)}`;
}

function stringField(payload: ReceivedJob['payload'], key: string): string {
  const value = payload[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`union-auth job payload lacks ${key}`);
  }
  return value;
}

function integerField(payload: ReceivedJob['payload'], key: string): number {
  const value = payload[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`union-auth job payload lacks ${key}`);
  }
  return value;
}

export function createSiteAuthMonitor(options: SiteAuthMonitorOptions): SiteAuthMonitor {
  const { clock, queue, logger, crypto, config, probe, refresher, alerts } = options;
  const db = options.db.withSchema('app');
  /** union.auth_probe_cron missing or invalid: one warn per instance. */
  let cronWarned = false;

  // ——— Configuration ———

  async function loadPhones(appId: string): Promise<AlertPhone[]> {
    const item = await config.configValue(appId, KEY_PHONES);
    if (item === null) return [];
    let phones: string[];
    try {
      phones = decodeAlertPhones(crypto, item.value);
    } catch (error) {
      logger.error(
        { app_id: appId, key: KEY_PHONES, error_name: errorName(error) },
        'union_auth_alert_phones_unreadable',
      );
      return [];
    }
    const result: AlertPhone[] = [];
    const seen = new Set<string>();
    let invalid = 0;
    for (const phone of phones) {
      const normalized = normalizeAlertPhone(phone);
      if (normalized === null) {
        invalid += 1;
        continue;
      }
      const phoneId = crypto.blindIndex(normalized, PHONE_CONTEXT);
      if (seen.has(phoneId)) continue;
      seen.add(phoneId);
      result.push({ phoneId, phone: normalized });
    }
    if (invalid > 0) {
      logger.warn({ app_id: appId, key: KEY_PHONES, invalid }, 'union_auth_alert_phones_invalid');
    }
    return result;
  }

  async function probeTimeOf(appId: string): Promise<ProbeTime> {
    const item = await config.configValue(appId, KEY_CRON);
    const time = parseProbeCron(item?.value ?? null);
    if (time !== null) return time;
    if (!cronWarned) {
      cronWarned = true;
      logger.warn(
        { app_id: appId, key: KEY_CRON, fallback: '0 9 * * *' },
        'union_auth_probe_cron_invalid',
      );
    }
    return DEFAULT_PROBE_TIME;
  }

  async function appContext(appId: string): Promise<AppContext> {
    const days = await config.configValue(appId, KEY_DAYS);
    const probeTime = await probeTimeOf(appId);
    const phones = await loadPhones(appId);
    return {
      appId,
      nodes: parseAlertDays(days?.value ?? null) ?? DEFAULT_ALERT_DAYS,
      hours: await alertHoursOf(config, appId),
      probeTime,
      phones,
      modes: new Map(),
    };
  }

  function reauthModeOf(ctx: AppContext, platform: string): Promise<SiteAuthReauthMode> {
    const cached = ctx.modes.get(platform);
    if (cached !== undefined) return cached;
    const resolve = async (): Promise<SiteAuthReauthMode> => {
      if (!isRegisteredPlatform(platform)) return 'none';
      const override = options.reauthModes?.[platform];
      if (override !== undefined) return override;
      if (platform === 'taobao') return 'oauth';
      if (platform === 'jd') {
        const item = await config.configValue(ctx.appId, KEY_JD_MODE);
        return item?.value === 'private_position' ? 'manual' : 'none';
      }
      return 'none';
    };
    const mode = resolve();
    ctx.modes.set(platform, mode);
    return mode;
  }

  // ——— Account rows ———

  function lockRow(
    trx: Transaction<DB>,
    appId: string,
    unionAccountId: string,
    platform?: string,
  ): Promise<AccountRow | undefined> {
    let query = trx
      .withSchema('app')
      .selectFrom('union_accounts')
      .select(ACCOUNT_COLUMNS)
      .where('app_id', '=', appId)
      .where('id', '=', unionAccountId)
      .where('platform', 'in', PLATFORMS);
    if (platform !== undefined) query = query.where('platform', '=', platform);
    return query.forUpdate().executeTakeFirst();
  }

  async function applyPatch(
    trx: Transaction<DB>,
    row: AccountRow,
    patch: AccountPatch,
    now: Date,
  ): Promise<void> {
    if (Object.keys(patch).length === 0) return;
    await trx
      .withSchema('app')
      .updateTable('union_accounts')
      .set({ ...patch, updated_at: now, row_version: sql<number>`row_version + 1` })
      .where('app_id', '=', row.app_id)
      .where('id', '=', row.id)
      .execute();
  }

  // ——— Alerts ———

  async function alert(
    trx: Transaction<DB>,
    ctx: Pick<AppContext, 'phones'>,
    row: AccountRow,
    stage: string,
    authExpiresAt: Date | null,
    cause: Cause | null,
    effects: Effect[],
    now: Date,
    /** Hour nodes: a repeat that planned no new row (phones configured) writes no alert line. */
    quietRepeat = false,
  ): Promise<void> {
    const platform = row.platform as RegisteredPlatform;
    const fields = {
      app_id: row.app_id,
      platform: row.platform,
      union_account_id: row.id,
      stage,
      auth_expires_at: iso(authExpiresAt),
      phones_configured: ctx.phones.length > 0,
    };
    if (ctx.phones.length === 0) {
      effects.push(() =>
        logger.warn(
          { app_id: row.app_id, platform: row.platform, union_account_id: row.id, stage },
          'union_auth_alert_phones_missing',
        ),
      );
    } else {
      const added = await alerts.plan(trx, {
        appId: row.app_id,
        unionAccountId: row.id,
        platform,
        authExpiresAt,
        stage,
        code: cause === null ? 'UNION_AUTH_EXPIRING' : 'UNION_AUTH_EXPIRED',
        phoneIds: ctx.phones.map((p) => p.phoneId),
      });
      if (added === 0 && quietRepeat) return;
      if (added > 0) {
        await queue.send(
          UNION_AUTH_QUEUE,
          JOB_DELIVER,
          { app_id: row.app_id, union_account_id: row.id },
          { trx, singletonKey: `union-auth:deliver:${row.id}:${stage}:${now.getTime()}` },
        );
      }
    }
    effects.push(() => {
      if (cause === null) logger.warn(fields, 'union_auth_expiring');
      else logger.error({ ...fields, cause }, 'union_auth_expired');
    });
  }

  /** Enter expired on the locked row: status and stage into `patch`, EXPIRED planned once. */
  async function expire(
    trx: Transaction<DB>,
    ctx: Pick<AppContext, 'phones'>,
    row: AccountRow,
    cause: Cause,
    patch: AccountPatch,
    effects: Effect[],
    now: Date,
  ): Promise<void> {
    if (row.auth_status === 'expired' && row.alert_stage === 'expired') return;
    patch.auth_status = 'expired';
    patch.alert_stage = 'expired';
    if (row.alert_stage === 'expired') return;
    await alert(trx, ctx, row, 'expired', row.auth_expires_at, cause, effects, now);
  }

  /** One transaction on the locked row; effects (log lines) only after it committed. */
  async function onRow<T>(
    appId: string,
    unionAccountId: string,
    platform: string | undefined,
    work: (
      trx: Transaction<DB>,
      row: AccountRow,
      patch: AccountPatch,
      effects: Effect[],
    ) => Promise<T>,
  ): Promise<T | undefined> {
    const effects: Effect[] = [];
    const result = await options.db.transaction().execute(async (trx) => {
      const row = await lockRow(trx, appId, unionAccountId, platform);
      if (row === undefined) return undefined;
      const patch: AccountPatch = {};
      const value = await work(trx, row, patch, effects);
      await applyPatch(trx, row, patch, clock.now());
      return value;
    });
    for (const effect of effects) effect();
    return result;
  }

  async function expireByTime(ctx: Pick<AppContext, 'phones'>, row: AccountRow): Promise<void> {
    const now = clock.now();
    await onRow(row.app_id, row.id, undefined, async (trx, locked, patch, effects) => {
      const expires = locked.auth_expires_at;
      if (expires === null || now.getTime() < expires.getTime()) return;
      await expire(trx, ctx, locked, 'time', patch, effects, now);
    });
  }

  // ——— Refresh ———

  async function refresh(
    ctx: AppContext,
    account: SiteAuthAccount,
    seen: AccountRow,
    now: Date,
    sent: Set<string>,
  ): Promise<void> {
    if (refresher === undefined) return;
    let outcome: Awaited<ReturnType<SiteAuthRefresher['refresh']>>;
    try {
      outcome = await refresher.refresh(account);
    } catch (error) {
      outcome = { ok: false, error: errorName(error) };
    }
    const fields = {
      app_id: account.appId,
      platform: account.platform,
      union_account_id: account.unionAccountId,
    };
    if (!outcome.ok) {
      logger.warn({ ...fields, reason: clip(outcome.error) }, 'union_auth_refresh_failed');
      return;
    }
    const estimated = outcome.expiresAt === null;
    const expiresAt = outcome.expiresAt ?? dateAt(now, now.getTime() + ESTIMATE_MS);
    const renewed = await onRow(
      account.appId,
      account.unionAccountId,
      undefined,
      async (_trx, row, patch) => {
        // Renewed or expired meanwhile: the newer state wins.
        if (row.auth_status === 'expired') return false;
        if (row.auth_expires_at?.getTime() !== seen.auth_expires_at?.getTime()) return false;
        patch.auth_expires_at = expiresAt;
        patch.auth_expires_estimated = estimated;
        patch.auth_renewed_at = now;
        patch.auth_renewed_by = null;
        patch.auth_status = 'active';
        patch.alert_stage = 'none';
        return true;
      },
    );
    if (renewed === true) {
      logger.info(
        { ...fields, auth_expires_at: expiresAt.toISOString(), estimated },
        'union_auth_refreshed',
      );
      // The hour nodes of the new authorization, after the renewal committed and best effort
      // (a failed send never undoes it; the daily backfill and heal send them again).
      try {
        await sendHourAlerts(queue, {
          trx: null,
          target: {
            appId: account.appId,
            unionAccountId: account.unionAccountId,
            expiresAt,
            renewedAt: now,
          },
          hours: ctx.hours,
          nowMs: now.getTime(),
          sent,
        });
      } catch (error) {
        logger.warn({ ...fields, error_name: errorName(error) }, 'union_auth_hour_schedule_failed');
      }
    }
  }

  // ——— The per-account check ———

  function totalOf(row: AccountRow, expires: Date): number | null {
    return authTotalMs(expires.getTime(), row.auth_renewed_at?.getTime() ?? null);
  }

  /** active / expiring of a not yet expired row (skipped nodes never count). */
  function statusOf(
    ctx: AppContext,
    row: AccountRow,
    expires: Date,
    nowMs: number,
  ): 'active' | 'expiring' {
    return authStatusAt({
      expiresMs: expires.getTime(),
      renewedMs: row.auth_renewed_at?.getTime() ?? null,
      nowMs,
      days: ctx.nodes,
      hours: ctx.hours,
      probeTime: ctx.probeTime,
    });
  }

  /** One hour node of one authorization at its instant (see the header). */
  async function hourAlert(
    appId: string,
    unionAccountId: string,
    node: number,
    expiresMs: number,
    renewedMs: number | null,
  ): Promise<void> {
    const ctx = await appContext(appId);
    const now = clock.now();
    const nowMs = now.getTime();
    await onRow(appId, unionAccountId, undefined, async (trx, row, patch, effects) => {
      const expires = row.auth_expires_at;
      // Another authorization since the job was planned: nothing to do.
      if (expires === null || expires.getTime() !== expiresMs) return;
      if ((row.auth_renewed_at?.getTime() ?? null) !== renewedMs) return;
      if ((await reauthModeOf(ctx, row.platform)) === 'none') return;
      // Judged invalid by a call or a probe (or already expired): no EXPIRING, no status change.
      if (row.auth_status === 'expired') return;
      if (nowMs >= expiresMs) {
        await expire(trx, ctx, row, 'time', patch, effects, now);
        return;
      }
      const live = liveHourNodes(ctx.hours, authTotalMs(expiresMs, renewedMs));
      if (!live.includes(node)) return;
      const dueMs = hourNodeAt(expiresMs, node);
      if (nowMs < dueMs) return;
      // A smaller node is already due: the larger one is never sent late.
      if (live.some((other) => other < node && hourNodeAt(expiresMs, other) <= nowMs)) return;
      // Handled already (a repeat or a late job of this node, or a smaller node of this
      // authorization went out, configured nodes changed or not): the mark, written below in this
      // same transaction on the locked row, is the only dedupe the backend alert line needs.
      if (hourNodeHandled(row.hour_alert_key, expiresMs, node)) return;
      patch.hour_alert_key = hourAlertMark(expiresMs, node);
      if (row.auth_status !== 'expiring') patch.auth_status = 'expiring';
      const lines: Effect[] = [];
      await alert(trx, ctx, row, `h${node}`, expires, null, lines, now, true);
      if (ctx.phones.length === 0) {
        // No phones: the alert line is the whole reminder and nothing else records it, so it is
        // written before the mark commits (key committed ⇒ line written; a failed or lost commit
        // retries and may write it twice, never zero times).
        for (const line of lines) line();
      } else {
        // Phones: the planned notify_logs rows and the deliver job commit with the mark.
        effects.push(...lines);
      }
    });
  }

  /** Reads the Clock again: already due (e.g. during a slow probe) → expired at once. */
  async function scheduleExpiry(ctx: AppContext, row: AccountRow): Promise<void> {
    const expires = row.auth_expires_at;
    if (expires === null) return;
    const left = expires.getTime() - clock.now().getTime();
    if (left > DUE_WINDOW_MS) return;
    if (left <= 0) {
      await expireByTime(ctx, row);
      return;
    }
    try {
      await queue.send(
        UNION_AUTH_QUEUE,
        JOB_DUE,
        { app_id: row.app_id, union_account_id: row.id, expires_at: expires.toISOString() },
        {
          trx: null,
          singletonKey: `union-auth:due:${row.id}:${expires.getTime()}`,
          delaySeconds: Math.ceil(left / 1000),
        },
      );
    } catch (error) {
      logger.warn(
        { app_id: row.app_id, union_account_id: row.id, error_name: errorName(error) },
        'union_auth_expiry_schedule_failed',
      );
    }
  }

  /**
   * Daily check and heal: the hour jobs of the nodes due before the next check, and the smallest
   * node already due that the account has not handled (its job was lost), at once.
   */
  async function backfillHours(
    ctx: AppContext,
    row: AccountRow,
    sent: Set<string>,
    event = 'union_auth_hour_schedule_failed',
  ): Promise<void> {
    const expires = row.auth_expires_at;
    if (expires === null || row.auth_status === 'expired' || ctx.hours.length === 0) return;
    const now = clock.now();
    if (now.getTime() >= expires.getTime()) return;
    try {
      if ((await reauthModeOf(ctx, row.platform)) === 'none') return;
      await sendHourAlerts(queue, {
        trx: null,
        target: {
          appId: row.app_id,
          unionAccountId: row.id,
          expiresAt: expires,
          renewedAt: row.auth_renewed_at,
        },
        hours: ctx.hours,
        nowMs: now.getTime(),
        untilMs: nextCheckSlot(now.getTime(), ctx.probeTime).dueMs,
        sent,
        catchUp: { doneMark: row.hour_alert_key },
      });
    } catch (error) {
      logger.warn(
        { app_id: row.app_id, union_account_id: row.id, error_name: errorName(error) },
        event,
      );
    }
  }

  async function checkAccount(
    ctx: AppContext,
    seen: AccountRow,
    mode: 'daily' | 'retry',
  ): Promise<void> {
    /** Hour job keys sent by this run (refresh and backfill never send one twice). */
    const sent = new Set<string>();
    if (!isRegisteredPlatform(seen.platform)) return;
    const now = clock.now();
    const nowMs = now.getTime();
    const managed = (await reauthModeOf(ctx, seen.platform)) !== 'none';
    const seenExpiry = managed ? seen.auth_expires_at : null;
    if (seenExpiry !== null && nowMs >= seenExpiry.getTime()) {
      await expireByTime(ctx, seen);
      return;
    }
    const account: SiteAuthAccount = {
      appId: seen.app_id,
      platform: seen.platform,
      unionAccountId: seen.id,
    };
    if (
      mode === 'daily' &&
      managed &&
      seenExpiry !== null &&
      seen.auth_status !== 'expired' &&
      remainingDays(seenExpiry.getTime(), nowMs, ctx.probeTime) <= REFRESH_DAYS
    ) {
      await refresh(ctx, account, seen, now, sent);
    }
    // The version the probe answers for, read after any refresh above.
    const before = await db
      .selectFrom('union_accounts')
      .select(ACCOUNT_COLUMNS)
      .where('app_id', '=', seen.app_id)
      .where('id', '=', seen.id)
      .executeTakeFirst();
    if (before === undefined) return;
    const answered = await probe.probe(account);
    const checked = await onRow(
      seen.app_id,
      seen.id,
      undefined,
      async (trx, row, patch, effects) => {
        // The probe took time: judge expiry and alerts at the Clock read again here, under the lock.
        const judgedAt = clock.now();
        const judgedMs = judgedAt.getTime();
        // Stale probe (the row changed while it ran: reauthorized, refreshed, judged by a call or
        // the expiry job): its result is dropped entirely — no last_probe_* (they would describe
        // the old authorization), no status change, no alert, no retry; the expiry check of this
        // run still applies to the current row and the next run probes the new authorization.
        const stale = authVersion(row) !== authVersion(before);
        const result: SiteAuthProbeResult = stale ? { kind: 'unsupported' } : answered;
        if (stale && answered.kind !== 'unsupported') {
          effects.push(() =>
            logger.info(
              {
                app_id: row.app_id,
                platform: row.platform,
                union_account_id: row.id,
                probe_kind: answered.kind,
              },
              'union_auth_probe_discarded',
            ),
          );
        }
        if (result.kind !== 'unsupported') {
          patch.last_probe_at = judgedAt;
          patch.last_probe_ok = result.kind === 'ok';
          patch.last_probe_error = result.kind === 'ok' ? null : clip(result.error);
        }
        const expires = managed ? row.auth_expires_at : null;
        if (!managed) {
          // reauth_mode none: the probe result is recorded only.
        } else if (expires !== null && judgedMs >= expires.getTime()) {
          await expire(trx, ctx, row, 'time', patch, effects, judgedAt);
        } else if (result.kind === 'auth_invalid') {
          await expire(trx, ctx, row, 'probe', patch, effects, judgedAt);
        } else if (row.auth_status === 'expired') {
          if (result.kind === 'ok') {
            // Judged invalid before its expiry, now valid again: no alert, no node resent.
            if (expires === null) {
              patch.auth_status = 'active';
              patch.alert_stage = 'none';
            } else {
              const left = remainingDays(expires.getTime(), judgedMs, ctx.probeTime);
              const days = liveDayNodes(ctx.nodes, totalOf(row, expires));
              const node = reachedNode(left, days);
              patch.auth_status = statusOf(ctx, row, expires, judgedMs);
              patch.alert_stage = node === null ? 'none' : `d${node}`;
            }
          }
        } else if (expires !== null) {
          const left = remainingDays(expires.getTime(), judgedMs, ctx.probeTime);
          const days = liveDayNodes(ctx.nodes, totalOf(row, expires));
          const status = statusOf(ctx, row, expires, judgedMs);
          if (status !== row.auth_status) patch.auth_status = status;
          const node = dueNode(left, days, row.alert_stage);
          if (node !== null) {
            patch.alert_stage = `d${node}`;
            await alert(trx, ctx, row, `d${node}`, expires, null, effects, judgedAt);
          }
        }
        if (result.kind === 'transient') {
          if (mode === 'daily') {
            await queue.send(
              UNION_AUTH_QUEUE,
              JOB_RETRY,
              { app_id: row.app_id, union_account_id: row.id },
              {
                trx,
                singletonKey: `union-auth:retry:${row.id}:${judgedMs}`,
                delaySeconds: RETRY_DELAY_SECONDS,
              },
            );
          } else {
            effects.push(() =>
              logger.warn(
                {
                  app_id: row.app_id,
                  platform: row.platform,
                  union_account_id: row.id,
                  probe_error: clip(result.error),
                },
                'union_auth_probe_failed',
              ),
            );
          }
        }
        return {
          ...row,
          auth_expires_at: expires,
          auth_status: patch.auth_status ?? row.auth_status,
        };
      },
    );
    if (mode === 'daily' && checked !== undefined) {
      await scheduleExpiry(ctx, checked);
      await backfillHours(ctx, checked, sent);
    }
  }

  async function accountsOf(appId: string): Promise<AccountRow[]> {
    return db
      .selectFrom('union_accounts')
      .select(ACCOUNT_COLUMNS)
      .where('app_id', '=', appId)
      .where('platform', 'in', PLATFORMS)
      .orderBy('id')
      .execute();
  }

  async function appIds(): Promise<string[]> {
    const rows = await db
      .selectFrom('union_accounts')
      .select('app_id')
      .distinct()
      .where('platform', 'in', PLATFORMS)
      .orderBy('app_id')
      .execute();
    return rows.map((row) => row.app_id);
  }

  /** One App's check run: each account once; a failed account is a warn line, the rest go on. */
  async function checkApp(appId: string): Promise<void> {
    const ctx = await appContext(appId);
    for (const row of await accountsOf(appId)) {
      try {
        await checkAccount(ctx, row, 'daily');
      } catch (error) {
        logger.warn(
          {
            app_id: appId,
            platform: row.platform,
            union_account_id: row.id,
            error_name: errorName(error),
          },
          'union_auth_check_failed',
        );
      }
    }
  }

  // ——— Job chain ———

  async function sendNextSlot(appId: string): Promise<void> {
    const time = await probeTimeOf(appId);
    const now = clock.now();
    const slot = nextCheckSlot(now.getTime(), time);
    await queue.send(
      UNION_AUTH_QUEUE,
      JOB_DAILY,
      { app_id: appId },
      {
        trx: null,
        singletonKey: `union-auth:daily:${appKey(appId)}:${slot.label}`,
        delaySeconds: Math.max(1, Math.ceil((slot.dueMs - now.getTime()) / 1000)),
      },
    );
  }

  async function healDeliveries(): Promise<void> {
    if (alerts.pending === undefined) return;
    for (const item of await alerts.pending()) {
      try {
        await queue.send(
          UNION_AUTH_QUEUE,
          JOB_DELIVER,
          { app_id: item.appId, union_account_id: item.unionAccountId },
          {
            trx: null,
            singletonKey: `union-auth:deliver:${item.unionAccountId}:heal:${item.oldestPlannedAt.getTime()}`,
          },
        );
      } catch (error) {
        logger.warn(
          {
            app_id: item.appId,
            union_account_id: item.unionAccountId,
            error_name: errorName(error),
          },
          'union_auth_heal_failed',
        );
      }
    }
  }

  async function healExpiries(): Promise<void> {
    const now = clock.now();
    const rows = await db
      .selectFrom('union_accounts')
      .select(ACCOUNT_COLUMNS)
      .where('platform', 'in', PLATFORMS)
      .where('auth_status', '!=', 'expired')
      .where('auth_expires_at', 'is not', null)
      .where('auth_expires_at', '<=', dateAt(now, now.getTime() + DUE_WINDOW_MS))
      .orderBy('app_id')
      .orderBy('id')
      .execute();
    const contexts = new Map<string, AppContext>();
    for (const row of rows) {
      const expires = row.auth_expires_at;
      if (expires === null) continue;
      let ctx = contexts.get(row.app_id);
      if (ctx === undefined) {
        ctx = {
          appId: row.app_id,
          nodes: [],
          hours: [],
          probeTime: DEFAULT_PROBE_TIME,
          phones: [],
          modes: new Map(),
        };
        contexts.set(row.app_id, ctx);
      }
      if ((await reauthModeOf(ctx, row.platform)) === 'none') continue;
      const left = Math.max(0, Math.ceil((expires.getTime() - now.getTime()) / 1000));
      await queue.send(
        UNION_AUTH_QUEUE,
        JOB_DUE,
        { app_id: row.app_id, union_account_id: row.id, expires_at: expires.toISOString() },
        {
          trx: null,
          singletonKey: `union-auth:due:${row.id}:${expires.getTime()}`,
          delaySeconds: left,
        },
      );
    }
  }

  /**
   * Heal: the hour jobs of every account not expired whose hour nodes may fall before its App's
   * next check (a job lost after a new authorization comes back within minutes, not the next day).
   */
  async function healHours(): Promise<void> {
    const now = clock.now();
    const rows = await db
      .selectFrom('union_accounts')
      .select(ACCOUNT_COLUMNS)
      .where('platform', 'in', PLATFORMS)
      .where('auth_status', '!=', 'expired')
      .where('auth_expires_at', '>', now)
      .where(
        'auth_expires_at',
        '<=',
        dateAt(now, now.getTime() + HOUR_JOB_MAX_DELAY_SECONDS * 1000 + DUE_WINDOW_MS),
      )
      .orderBy('app_id')
      .orderBy('id')
      .execute();
    const contexts = new Map<string, AppContext>();
    const sent = new Set<string>();
    for (const row of rows) {
      let ctx = contexts.get(row.app_id);
      if (ctx === undefined) {
        try {
          ctx = {
            appId: row.app_id,
            nodes: [],
            hours: await alertHoursOf(config, row.app_id),
            probeTime: await probeTimeOf(row.app_id),
            phones: [],
            modes: new Map(),
          };
        } catch (error) {
          logger.warn(
            { app_id: row.app_id, union_account_id: row.id, error_name: errorName(error) },
            'union_auth_heal_failed',
          );
          continue;
        }
        contexts.set(row.app_id, ctx);
      }
      await backfillHours(ctx, row, sent, 'union_auth_heal_failed');
    }
  }

  // ——— Public operations ———

  const monitor: SiteAuthMonitor = {
    async dailyCheck() {
      for (const appId of await appIds()) await checkApp(appId);
    },

    async probeRetry(appId, unionAccountId) {
      const row = await db
        .selectFrom('union_accounts')
        .select(ACCOUNT_COLUMNS)
        .where('app_id', '=', appId)
        .where('id', '=', unionAccountId)
        .where('platform', 'in', PLATFORMS)
        .executeTakeFirst();
      if (row === undefined) return;
      await checkAccount(await appContext(appId), row, 'retry');
    },

    async expiryDue(appId, unionAccountId, expiresAt) {
      const due = Date.parse(expiresAt);
      if (Number.isNaN(due)) return;
      const phones = await loadPhones(appId);
      const ctx: AppContext = {
        appId,
        nodes: [],
        hours: [],
        probeTime: DEFAULT_PROBE_TIME,
        phones,
        modes: new Map(),
      };
      const now = clock.now();
      await onRow(appId, unionAccountId, undefined, async (trx, row, patch, effects) => {
        const expires = row.auth_expires_at;
        // Renewed (or never set) since the job was planned, or not yet due: nothing to do.
        if (expires === null || expires.getTime() !== due || now.getTime() < due) return;
        if ((await reauthModeOf(ctx, row.platform)) === 'none') return;
        await expire(trx, ctx, row, 'time', patch, effects, now);
      });
    },

    async reportAuthFailure(input) {
      const phones = await loadPhones(input.appId);
      const ctx: AppContext = {
        appId: input.appId,
        nodes: [],
        hours: [],
        probeTime: DEFAULT_PROBE_TIME,
        phones,
        modes: new Map(),
      };
      const now = clock.now();
      await onRow(
        input.appId,
        input.unionAccountId,
        input.platform,
        async (trx, row, patch, effects) => {
          if ((await reauthModeOf(ctx, row.platform)) === 'none') {
            effects.push(() =>
              logger.warn(
                {
                  app_id: row.app_id,
                  platform: row.platform,
                  union_account_id: row.id,
                  reason: 'reauth_mode_none',
                },
                'union_auth_failure_ignored',
              ),
            );
            return;
          }
          await expire(trx, ctx, row, 'call', patch, effects, now);
        },
      );
    },

    async deliverAlerts(appId, unionAccountId) {
      const phones = await loadPhones(appId);
      await alerts.deliver(
        appId,
        unionAccountId,
        phones.map((p) => ({ phoneId: p.phoneId, phone: p.phone })),
      );
    },

    async seed() {
      let failure: { readonly error: unknown } | null = null;
      for (const appId of await appIds()) {
        try {
          await sendNextSlot(appId);
        } catch (error) {
          failure ??= { error };
        }
      }
      if (failure !== null) throw failure.error;
    },

    async handle(job) {
      const appId = stringField(job.payload, 'app_id');
      switch (job.name) {
        case JOB_DAILY: {
          await checkApp(appId);
          try {
            await sendNextSlot(appId);
          } catch (error) {
            logger.warn(
              { queue: UNION_AUTH_QUEUE, app_id: appId, error_name: errorName(error) },
              'union_auth_continue_failed',
            );
          }
          return;
        }
        case JOB_RETRY:
          return monitor.probeRetry(appId, stringField(job.payload, 'union_account_id'));
        case JOB_DUE:
          return monitor.expiryDue(
            appId,
            stringField(job.payload, 'union_account_id'),
            stringField(job.payload, 'expires_at'),
          );
        case JOB_DELIVER:
          return monitor.deliverAlerts(appId, stringField(job.payload, 'union_account_id'));
        case JOB_HOUR_ALERT: {
          const renewed = job.payload['renewed_ms'];
          return hourAlert(
            appId,
            stringField(job.payload, 'union_account_id'),
            integerField(job.payload, 'hours'),
            integerField(job.payload, 'expires_ms'),
            renewed === null ? null : integerField(job.payload, 'renewed_ms'),
          );
        }
        default:
          throw new Error(`unknown union-auth job: ${job.name}`);
      }
    },

    async heal() {
      try {
        for (const appId of await appIds()) {
          try {
            await sendNextSlot(appId);
          } catch (error) {
            logger.warn(
              { queue: UNION_AUTH_QUEUE, app_id: appId, error_name: errorName(error) },
              'union_auth_heal_failed',
            );
          }
        }
        await healDeliveries();
        await healExpiries();
      } catch (error) {
        logger.warn(
          { queue: UNION_AUTH_QUEUE, error_name: errorName(error) },
          'union_auth_heal_failed',
        );
      }
      // Separately, so a failure above never keeps the hour jobs from coming back.
      try {
        await healHours();
      } catch (error) {
        logger.warn(
          { queue: UNION_AUTH_QUEUE, error_name: errorName(error) },
          'union_auth_heal_failed',
        );
      }
    },
  };
  return monitor;
}
