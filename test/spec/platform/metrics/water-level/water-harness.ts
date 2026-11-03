// B2-09j rule-test kit (规划/08 BR-WDR-18「W < 1.5P 时告警财务」及其例子; 编排裁定 D10-592). The worker
// exports one gauge, couli_payout_water_low{app_id}: 1 when W < 1.5P, 0 when not low, and no sample
// at all when there is no conclusion (no W, or W older than 2 hours). Only the alipay channel counts.
// The metric name, the label, the +08:00 window of the clock and the fixture's amounts are written
// out here, independent of the code under test; no formula is restated: the expected values are the
// worked examples of BR-WDR-18. W rows are written directly (B2-09i pins the entry). The Prometheus
// text reader comes from B1-01zzh's kit, the user helper from B1-01zzi's kit (read only, not
// changed). The test database comes from the int tests (@couli/db/testing is allowed in
// *.int.test.ts only).
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { expect } from 'vitest';
import type { Clock } from '../../../../../apps/api/src/modules/platform/clock/index.ts';
import { insertUser, mentions } from '../../fund-metrics/kit.ts';
import { samples } from '../kit.ts';

// ---- the metric --------------------------------------------------------------------------------

export const WATER_LOW_METRIC = 'couli_payout_water_low';
/** The one label of the gauge. */
export const LABEL = 'app_id';

/** Whether the text mentions the metric at all (a sample, HELP or TYPE line). */
export function mentionsWaterLow(text: string): boolean {
  return new RegExp(`(^|[\\s{])${WATER_LOW_METRIC}([\\s{]|$)`, 'm').test(text);
}

/** The gauge as { app_id: value }; every series carries exactly the label app_id, once each. */
export function waterLowGauge(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const sample of samples(text).filter((s) => s.name === WATER_LOW_METRIC)) {
    expect(Object.keys(sample.labels), `${WATER_LOW_METRIC} labels`).toEqual([LABEL]);
    const appId = sample.labels[LABEL]!;
    expect(Object.hasOwn(out, appId), `${WATER_LOW_METRIC}{${LABEL}="${appId}"} twice`).toBe(false);
    out[appId] = sample.value;
  }
  return out;
}

/** The family's `# HELP` text (trimmed); fails when the line is missing. */
export function waterLowHelp(text: string): string {
  const match = new RegExp(`^# HELP ${WATER_LOW_METRIC} (.*)$`, 'm').exec(text);
  expect(match, `# HELP ${WATER_LOW_METRIC}`).not.toBeNull();
  return match![1]!.trim();
}

/** A query behind the gauge: W from payout_watermarks, or P from withdrawals by channel. */
export function isWaterLowRead(query: string): boolean {
  return isWatermarkRead(query) || isForecastRead(query);
}

export function isWatermarkRead(query: string): boolean {
  return mentions(query, 'payout_watermarks');
}

export function isForecastRead(query: string): boolean {
  return mentions(query, 'withdrawals') && /\bpayout_channel\b/.test(query);
}

/** One app's W: selects the balance for a given app_id. A list of the apps is not this read. */
export function isAppWatermarkRead(query: string): boolean {
  return (
    isWatermarkRead(query) && /\bavailable_fen\b/.test(query) && /\bapp_id"?\s*=\s*\$\d/.test(query)
  );
}

// ---- time --------------------------------------------------------------------------------------

/**
 * The injected clock's instant: 2031-04-05 14:07:08 at +08:00. The database's own now() is years
 * earlier on purpose.
 */
export const NOW = '2031-04-05T06:07:08.000Z';
export const NOW_MS = Date.parse(NOW);

export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;

/** The default cache age: 5 minutes (as review-overdue, 规划/02 §13 common granularity). */
export const TTL_MS = 300_000;

/** 2031-04-05 00:00 at +08:00: the window's exclusive end (the current day never counts). */
export const WINDOW_END = '2031-04-04T16:00:00.000Z';
/** 2031-03-29 00:00 at +08:00: the window's inclusive start, seven complete days earlier. */
export const WINDOW_START = '2031-03-28T16:00:00.000Z';
/** Somewhere inside the window. */
export const IN_WINDOW = '2031-04-01T04:00:00.000Z';

/** An ISO instant shifted by milliseconds. */
export function shift(instant: string, ms: number): string {
  return new Date(Date.parse(instant) + ms).toISOString();
}

/** W read half an hour before NOW: fresh. */
export const FRESH = shift(NOW, -30 * MINUTE_MS);

/** A clock standing at one instant. */
export function clockAt(instant: string): Clock {
  return { now: () => new Date(instant) };
}

// ---- BR-WDR-18's worked example ----------------------------------------------------------------

/** 近 7 日申请合计 ¥49,000: P = ¥21,000, 1.5P = ¥31,500. */
export const EXAMPLE_TOTAL_FEN = 4_900_000n;
/** W = ¥30,000 < ¥31,500. */
export const W_30000 = 3_000_000n;
/** W = ¥31,500: exactly 1.5P, not low. */
export const W_31500 = 3_150_000n;
/** W = ¥31,499.99: one fen below 1.5P. */
export const W_31499_99 = 3_149_999n;
/** W = ¥20,000 < P: EXECUTE already refuses, and the 1.5P line holds as well. */
export const W_20000 = 2_000_000n;

// ---- stand-in rows -----------------------------------------------------------------------------

/**
 * One row answering every query behind the gauge on B1-01zzi's recordingDb: the app list (app_id),
 * W (available_fen, measured_at, entered_by) and P (total, the seven-day sum as PostgreSQL's text).
 */
export function waterRow(
  appId: string,
  availableFen: bigint,
  totalFen: bigint,
  measuredAt: string = FRESH,
): Record<string, unknown> {
  return {
    app_id: appId,
    available_fen: availableFen,
    measured_at: new Date(measuredAt),
    entered_by: 'finance:synthetic',
    total: totalFen.toString(),
  };
}

// ---- database fixtures -------------------------------------------------------------------------

export type Channel = 'alipay' | 'bank_card' | 'wechat';

export async function insertWatermark(
  db: Kysely<DB>,
  row: {
    readonly appId: string;
    readonly fen: bigint;
    readonly measuredAt?: string;
    readonly channel?: Channel;
    /** When the row was entered; the column's default when not given. */
    readonly createdAt?: string;
  },
): Promise<void> {
  await sql`INSERT INTO app.payout_watermarks
      (id, app_id, channel, available_fen, measured_at, entered_by, created_at)
    VALUES (${randomUUID()}, ${row.appId}, ${row.channel ?? 'alipay'}, ${row.fen},
      ${row.measuredAt ?? FRESH}::timestamptz, 'finance:synthetic',
      COALESCE(${row.createdAt ?? null}::timestamptz, now()))`.execute(db);
}

export async function insertApplication(
  db: Kysely<DB>,
  row: {
    readonly appId: string;
    /** amount_fen, the amount P is computed from. */
    readonly amountFen: bigint;
    readonly createdAt?: string;
    readonly channel?: Channel;
    readonly status?: 'PENDING_REVIEW' | 'FAILED' | 'REJECTED';
    /** net_fen = amount_fen − fee_fen. */
    readonly feeFen?: bigint;
  },
): Promise<void> {
  const id = randomUUID();
  const user = await insertUser(db, row.appId);
  const channel = row.channel ?? 'alipay';
  const status = row.status ?? 'PENDING_REVIEW';
  const fee = row.feeFen ?? 0n;
  const createdAt = row.createdAt ?? IN_WINDOW;
  await sql`INSERT INTO app.withdrawals
      (id, app_id, user_id, amount_fen, fee_fen, tax_fen, net_fen, income_type, payout_method,
       payee_name, payee_account_cipher, payee_hmac, bank_name, wechat_app_id, status, out_biz_no,
       payout_channel, reject_reason_code, created_at, updated_at)
    VALUES (${id}, ${row.appId}, ${user}, ${row.amountFen}, ${fee}, ${0n}, ${row.amountFen - fee},
      'SERVICE_FEE', ${channel}, 'synthetic', ${Buffer.from('synthetic-cipher')}, ${'a'.repeat(64)},
      ${channel === 'bank_card' ? 'synthetic-bank' : null},
      ${channel === 'wechat' ? 'wx_synthetic' : null}, ${status}, ${id.replaceAll('-', '')},
      ${channel}, ${status === 'REJECTED' ? 'OTHER' : null}, ${createdAt}::timestamptz,
      ${createdAt}::timestamptz)`.execute(db);
}

/** One app of the worked example: ¥49,000 applied for in the window, W as given, fresh. */
export async function seedExample(db: Kysely<DB>, appId: string, fen: bigint): Promise<void> {
  await insertApplication(db, { appId, amountFen: EXAMPLE_TOTAL_FEN });
  await insertWatermark(db, { appId, fen });
}

/** One app with `totalFen` applied for in the window, W as given, fresh. */
export async function seedWindowTotal(
  db: Kysely<DB>,
  appId: string,
  totalFen: bigint,
  fen: bigint,
): Promise<void> {
  await insertApplication(db, { appId, amountFen: totalFen });
  await insertWatermark(db, { appId, fen });
}

/** Every row of the two tables the gauge reads. */
export async function tableSnapshot(db: Kysely<DB>): Promise<unknown[]> {
  const watermarks =
    await sql`SELECT to_jsonb(w) AS row FROM app.payout_watermarks w ORDER BY id`.execute(db);
  const withdrawals =
    await sql`SELECT to_jsonb(w) AS row FROM app.withdrawals w ORDER BY id`.execute(db);
  return [...watermarks.rows, ...withdrawals.rows];
}
