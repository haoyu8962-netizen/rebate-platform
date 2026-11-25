// Persistent backend alerts of the site authorization (B1-22ze; BR-ID-24 ② 细则「后台告警的持久
// 记录」, 04 §3.2 union_auth_alerts; owner 2026-11-25 D10-2970 ③, D10-3063 / D10-3064 (i), D10-3074).
//
// The backend alert is one row of app.union_auth_alerts, written by the monitor's alert()
// (./service.ts) with INSERT … ON CONFLICT DO NOTHING on the transaction that also writes the
// account's alert_stage / hour_alert_key / status and the notify_logs rows, phones or not. A row
// actually inserted queues one `alert_log` job in that same transaction (payload only app_id,
// union_account_id, alert_id; singletonKey per alert id); the job reads the row and writes the pino
// lines that used to be written around the commit (union_auth_alert_phones_missing warn when no
// phones were configured, then union_auth_expiring warn / union_auth_expired error, same flat
// fields). So the record is exactly once (the unique key) and the line at least once (a failing
// job is retried by the queue; the record is never touched again: the table is append-only).
//
// alert_key is the notify_logs dedupe key without the account and the phone (notification's
// siteAuthAlertKey): '<auth_expires_at ISO | none>:<stage>', and for expired the instant the
// account entered expired appended — a renewal (new expiry) or a later re-entry is a new row.
//
// Until db.gen.ts is regenerated from the migration the table is reached through `sql` templates
// with the local row type below (no generated type is assumed).
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { JobPayload } from '../../platform/index.ts';

export const JOB_ALERT_LOG = 'alert_log';

export type AlertCause = 'time' | 'probe' | 'call';

/** One row of app.union_auth_alerts. */
export interface AuthAlertRecord {
  readonly id: string;
  readonly app_id: string;
  readonly union_account_id: string;
  readonly platform: string;
  readonly stage: string;
  readonly alert_key: string;
  readonly auth_expires_at: Date | null;
  readonly entered_at: Date | null;
  readonly phones_configured: boolean;
  readonly cause: string | null;
  readonly created_at: Date;
}

/** What alert() records (the row less id, alert_key and created_at). */
export interface AuthAlertInput {
  readonly appId: string;
  readonly unionAccountId: string;
  readonly platform: string;
  readonly stage: string;
  readonly authExpiresAt: Date | null;
  /** expired only: the cause and the instant expired was entered. */
  readonly expired: { readonly cause: AlertCause; readonly enteredAt: Date } | null;
  readonly phonesConfigured: boolean;
}

/** The alert's dedupe key within its account and stage (see the header). */
export function authAlertKey(input: Pick<AuthAlertInput, 'stage' | 'authExpiresAt' | 'expired'>) {
  const expires = input.authExpiresAt === null ? 'none' : input.authExpiresAt.toISOString();
  const base = `${expires}:${input.stage}`;
  return input.expired === null ? base : `${base}:${input.expired.enteredAt.toISOString()}`;
}

/** The singletonKey of the alert_log job of one alert row. */
export function alertLogSingletonKey(alertId: string): string {
  return `union-auth:alert-log:${alertId}`;
}

/** The alert_log job payload: identifiers only (no phone, token or field of the alert). */
export function alertLogPayload(
  record: Pick<AuthAlertRecord, 'id' | 'app_id' | 'union_account_id'>,
) {
  return {
    app_id: record.app_id,
    union_account_id: record.union_account_id,
    alert_id: record.id,
  } satisfies JobPayload;
}

export interface AlertLogLine {
  readonly level: 'warn' | 'error';
  readonly fields: Readonly<Record<string, string | boolean | null>>;
  readonly msg: 'union_auth_alert_phones_missing' | 'union_auth_expiring' | 'union_auth_expired';
}

/** The pino lines of one alert row, in order (fields as before B1-22ze, read from the row). */
export function alertLogLines(record: AuthAlertRecord): AlertLogLine[] {
  const lines: AlertLogLine[] = [];
  if (!record.phones_configured) {
    lines.push({
      level: 'warn',
      fields: {
        app_id: record.app_id,
        platform: record.platform,
        union_account_id: record.union_account_id,
        stage: record.stage,
      },
      msg: 'union_auth_alert_phones_missing',
    });
  }
  const fields = {
    app_id: record.app_id,
    platform: record.platform,
    union_account_id: record.union_account_id,
    stage: record.stage,
    auth_expires_at: record.auth_expires_at === null ? null : record.auth_expires_at.toISOString(),
    phones_configured: record.phones_configured,
  };
  if (record.cause === null) {
    lines.push({ level: 'warn', fields, msg: 'union_auth_expiring' });
  } else {
    lines.push({
      level: 'error',
      fields: { ...fields, cause: record.cause },
      msg: 'union_auth_expired',
    });
  }
  return lines;
}

/**
 * Record one alert on the caller's transaction; the new row, or null when the same alert
 * (account, stage, alert_key) is already recorded.
 */
export async function insertAuthAlert(
  trx: Transaction<DB>,
  input: AuthAlertInput,
  now: Date,
): Promise<AuthAlertRecord | null> {
  const result = await sql<AuthAlertRecord>`
    INSERT INTO app.union_auth_alerts (
      id, app_id, union_account_id, platform, stage, alert_key,
      auth_expires_at, entered_at, phones_configured, cause, created_at
    ) VALUES (
      ${randomUUID()}, ${input.appId}, ${input.unionAccountId}, ${input.platform}, ${input.stage},
      ${authAlertKey(input)}, ${input.authExpiresAt}, ${input.expired?.enteredAt ?? null},
      ${input.phonesConfigured}, ${input.expired?.cause ?? null}, ${now}
    )
    ON CONFLICT (app_id, union_account_id, stage, alert_key) DO NOTHING
    RETURNING *
  `.execute(trx);
  return result.rows[0] ?? null;
}

/** The alert row an alert_log job names (undefined when there is none). */
export async function readAuthAlert(
  db: Kysely<DB>,
  appId: string,
  unionAccountId: string,
  alertId: string,
): Promise<AuthAlertRecord | undefined> {
  const result = await sql<AuthAlertRecord>`
    SELECT * FROM app.union_auth_alerts
    WHERE app_id = ${appId} AND union_account_id = ${unionAccountId} AND id = ${alertId}
  `.execute(db);
  return result.rows[0];
}
