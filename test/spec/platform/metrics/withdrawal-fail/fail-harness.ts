// B2-09zj rule-test kit (规划/08 BR-WDR-24 前两项及其例子; 编排裁定 D10-1157, D10-1170, D10-1186,
// D10-1203; ops/tasks/B2-09zj.yaml 口径).
// The worker exports three gauges, each labelled app_id only:
//   couli_withdrawals_w6_today    W6 transitions in the current +08:00 day of the injected clock;
//   couli_withdrawals_w5w6_today  W5 plus W6 transitions in that day (W8, W10, W11 not counted);
//   couli_withdrawals_w6_streak   the app's W5 / W6 ordered by (updated_at, id) and cut into runs
//                                 of consecutive W6 (a W5 ends a run); the length of the longest
//                                 run whose last W6 has updated_at ∈ (now − 24h, now] of the
//                                 injected clock, counted whole (a run may reach back before the
//                                 window); 0 when there is no such run. Not cut at the day
//                                 (D10-1203, replacing D10-1186 ② and D10-1202).
// What counts (D10-1157, D10-1170): W6 = withdrawals.status FAILED with manual_resolution empty (W10
// judged FAILED carries manual_resolution failed); W5 = status PAID_API with manual_resolution empty
// and no payout_attempts row of kind transfer with result fail (W10 judged paid carries
// manual_resolution paid; W11, written off after W9, has that failed transfer); PAID_MANUAL (W8) never
// counts; W9's transfer attempt also fails but the withdrawal goes back to APPROVED, so it is no W6.
// The transition instant of both W5 and W6 is withdrawals.updated_at (D10-1186: terminal rows are
// never updated again), not paid_at and not any attempt's at.
// The metric names (the ledger's suggestion, pinned here), the label, the day boundaries and the
// fixtures are written out here, independent of the code under test. Time helpers come from B2-09j's
// kit, the Prometheus text reader from B1-01zzh's, the user helper from B1-01zzi's (all read only,
// not changed). The test database comes from the int tests (@couli/db/testing is allowed in
// *.int.test.ts only); attempt rows are written on a couli_payout handle (couli_app may only read
// payout_attempts).
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { expect } from 'vitest';
import { insertUser } from '../../fund-metrics/kit.ts';
import { samples } from '../kit.ts';
import { HOUR_MS, NOW, shift } from '../water-level/water-harness.ts';

// ---- the metrics -------------------------------------------------------------------------------

export const W6_TODAY_METRIC = 'couli_withdrawals_w6_today';
export const W5W6_TODAY_METRIC = 'couli_withdrawals_w5w6_today';
export const W6_STREAK_METRIC = 'couli_withdrawals_w6_streak';
/** The one label of every gauge. */
export const LABEL = 'app_id';

export type FailKey = 'w6Today' | 'w5w6Today' | 'w6Streak';
export const FAIL_KEYS: readonly FailKey[] = ['w6Today', 'w5w6Today', 'w6Streak'];

/** Snapshot key → metric name. */
export const METRIC_OF: Readonly<Record<FailKey, string>> = {
  w6Today: W6_TODAY_METRIC,
  w5w6Today: W5W6_TODAY_METRIC,
  w6Streak: W6_STREAK_METRIC,
};

export const FAIL_METRIC_NAMES: readonly string[] = FAIL_KEYS.map((key) => METRIC_OF[key]);

/** The three gauges' values: snapshot key → app_id → value. */
export type FailValues = Readonly<Record<FailKey, Readonly<Record<string, number>>>>;

/** Whether the text mentions `metric` at all (a sample, HELP or TYPE line). */
export function mentionsMetric(text: string, metric: string): boolean {
  return new RegExp(`(^|[\\s{])${metric}([\\s{]|$)`, 'm').test(text);
}

/** Whether the text mentions any of the three gauges. */
export function mentionsAnyFail(text: string): boolean {
  return FAIL_METRIC_NAMES.some((metric) => mentionsMetric(text, metric));
}

/** One gauge as { app_id: value }; every series carries exactly the label app_id, once each. */
export function gaugeOf(text: string, metric: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const sample of samples(text).filter((s) => s.name === metric)) {
    expect(Object.keys(sample.labels), `${metric} labels`).toEqual([LABEL]);
    const appId = sample.labels[LABEL]!;
    expect(Object.hasOwn(out, appId), `${metric}{${LABEL}="${appId}"} twice`).toBe(false);
    out[appId] = sample.value;
  }
  return out;
}

/** The three gauges read back from a text exposition. */
export function failFromText(text: string): FailValues {
  return {
    w6Today: gaugeOf(text, W6_TODAY_METRIC),
    w5w6Today: gaugeOf(text, W5W6_TODAY_METRIC),
    w6Streak: gaugeOf(text, W6_STREAK_METRIC),
  };
}

/** A family's `# HELP` text (trimmed); fails when the line is missing. */
export function helpOf(text: string, metric: string): string {
  const match = new RegExp(`^# HELP ${metric} (.*)$`, 'm').exec(text);
  expect(match, `# HELP ${metric}`).not.toBeNull();
  return match![1]!.trim();
}

/** One app's three values; an app without a sample reads as 0 (both are allowed for 0). */
export function valuesOf(values: FailValues, appId: string): Record<FailKey, number> {
  return {
    w6Today: values.w6Today[appId] ?? 0,
    w5w6Today: values.w5w6Today[appId] ?? 0,
    w6Streak: values.w6Streak[appId] ?? 0,
  };
}

/** Every value is a count: a non-negative integer; and W6 today never exceeds W5 + W6 today. */
export function expectCounts(values: FailValues, where: string): void {
  for (const key of FAIL_KEYS) {
    for (const [appId, value] of Object.entries(values[key])) {
      expect(Number.isInteger(value) && value >= 0, `${where}: ${key}[${appId}] = ${value}`).toBe(
        true,
      );
    }
  }
  for (const [appId, w6] of Object.entries(values.w6Today)) {
    expect(w6, `${where}: w6Today[${appId}] <= w5w6Today[${appId}]`).toBeLessThanOrEqual(
      values.w5w6Today[appId] ?? 0,
    );
  }
}

// ---- time --------------------------------------------------------------------------------------

/** 2031-04-05 00:00 at +08:00: the start of NOW's day (NOW is 2031-04-05 14:07:08 at +08:00). */
export const TODAY_START = '2031-04-04T16:00:00.000Z';
/** 2031-04-06 00:00 at +08:00: the start of the next day. */
export const NEXT_DAY_START = '2031-04-05T16:00:00.000Z';
/** 2031-04-04 22:00 at +08:00: yesterday evening. */
export const YESTERDAY_EVENING = '2031-04-04T14:00:00.000Z';

/** 24 hours: the streak's window. */
export const DAY_MS = 24 * HOUR_MS;

/** NOW shifted by whole minutes. */
export function minutesFromNow(minutes: number): string {
  return shift(NOW, minutes * 60_000);
}

// ---- database fixtures -------------------------------------------------------------------------

export interface FailHandles {
  /** couli_app: users and withdrawals. */
  readonly db: Kysely<DB>;
  /** couli_payout: attempt rows. */
  readonly payout: Kysely<DB>;
}

/**
 * How a withdrawal ended up (BR-WDR-08's transitions). Only W5 and W6 count; the others are written
 * as they look after their own transition, with attempts that would mislead a reader of the wrong
 * columns (W9 and W10 failed carry a fail attempt; W8 and W10 paid carry paid_at; W11 is PAID_API
 * with manual_resolution empty, like a W5, but carries the failed transfer that sent it to W9).
 */
export type Outcome =
  | 'W5'
  | 'W6'
  | 'W8'
  | 'W10_PAID'
  | 'W10_FAILED'
  | 'W9'
  | 'W11'
  | 'PAYING'
  | 'REJECTED'
  | 'PENDING_REVIEW';

/** Every outcome that is neither W5 nor W6. */
export const NOT_COUNTED: readonly Outcome[] = [
  'W8',
  'W10_PAID',
  'W10_FAILED',
  'W9',
  'W11',
  'PAYING',
  'REJECTED',
  'PENDING_REVIEW',
];

export interface OutcomeRow {
  readonly appId: string;
  readonly outcome: Outcome;
  /**
   * The transition's instant, written to withdrawals.updated_at for every outcome (D10-1186). By
   * default also paid_at for W5 / W8 / W10 paid / W11; the last fail attempt's at for W6 / W10 failed;
   * the fail attempt and hold_at for W9; the unknown transfer attempt for PAYING.
   */
  readonly at: string;
  /**
   * W6 only. 'transfer' (default): the transfer attempt failed. 'query': the transfer was unknown an
   * hour before the failure and a query failed.
   */
  readonly via?: 'transfer' | 'query';
  /**
   * W5: the success transfer attempt's at; W6: the fail attempt's at (transfer or query). Default
   * `at`; ignored for the other outcomes.
   */
  readonly attemptAt?: string;
  /** W5 only: paid_at when it differs from `at` (ignored for the other outcomes). */
  readonly paidAt?: string;
  /** Default: two hours before `at`. */
  readonly createdAt?: string;
}

interface Attempt {
  readonly kind: 'transfer' | 'query';
  readonly result: 'success' | 'fail' | 'unknown';
  readonly at: string;
}

interface Shape {
  readonly status: string;
  readonly paidAt: string | null;
  readonly manualResolution: 'paid' | 'failed' | null;
  readonly needsManual: boolean;
  readonly manualPaid: boolean;
  readonly holdAt: string | null;
  readonly rejected: boolean;
  readonly attempts: readonly Attempt[];
}

function shapeOf(row: OutcomeRow): Shape {
  const base: Shape = {
    status: 'PENDING_REVIEW',
    paidAt: null,
    manualResolution: null,
    needsManual: false,
    manualPaid: false,
    holdAt: null,
    rejected: false,
    attempts: [],
  };
  const hourBefore = shift(row.at, -HOUR_MS);
  switch (row.outcome) {
    case 'W5':
      return {
        ...base,
        status: 'PAID_API',
        paidAt: row.paidAt ?? row.at,
        attempts: [{ kind: 'transfer', result: 'success', at: row.attemptAt ?? row.at }],
      };
    case 'W6': {
      const failedAt = row.attemptAt ?? row.at;
      return {
        ...base,
        status: 'FAILED',
        attempts:
          row.via === 'query'
            ? [
                { kind: 'transfer', result: 'unknown', at: shift(failedAt, -HOUR_MS) },
                { kind: 'query', result: 'fail', at: failedAt },
              ]
            : [{ kind: 'transfer', result: 'fail', at: failedAt }],
      };
    }
    case 'W11':
      // The transfer failed (W9 sent it back to APPROVED, the hold cleared again by W11), then a
      // query proved the channel paid: PAID_API with manual_resolution empty.
      return {
        ...base,
        status: 'PAID_API',
        paidAt: row.at,
        attempts: [
          { kind: 'transfer', result: 'fail', at: hourBefore },
          { kind: 'query', result: 'success', at: row.at },
        ],
      };
    case 'W8':
      // Returned by W9 first (its transfer failed), then paid by hand.
      return {
        ...base,
        status: 'PAID_MANUAL',
        paidAt: row.at,
        manualPaid: true,
        attempts: [{ kind: 'transfer', result: 'fail', at: hourBefore }],
      };
    case 'W10_PAID':
      return {
        ...base,
        status: 'PAID_API',
        paidAt: row.at,
        manualResolution: 'paid',
        needsManual: true,
        attempts: [{ kind: 'transfer', result: 'unknown', at: hourBefore }],
      };
    case 'W10_FAILED':
      return {
        ...base,
        status: 'FAILED',
        manualResolution: 'failed',
        needsManual: true,
        attempts: [
          { kind: 'transfer', result: 'unknown', at: hourBefore },
          { kind: 'query', result: 'fail', at: row.at },
        ],
      };
    case 'W9':
      return {
        ...base,
        status: 'APPROVED',
        holdAt: row.at,
        attempts: [{ kind: 'transfer', result: 'fail', at: row.at }],
      };
    case 'PAYING':
      return {
        ...base,
        status: 'PAYING',
        attempts: [{ kind: 'transfer', result: 'unknown', at: row.at }],
      };
    case 'REJECTED':
      return { ...base, status: 'REJECTED', rejected: true };
    case 'PENDING_REVIEW':
      return base;
  }
}

/** One withdrawal (alipay) with its attempt rows, satisfying every CHECK; returns its id. */
export async function insertOutcome(h: FailHandles, row: OutcomeRow): Promise<string> {
  const id = randomUUID();
  const user = await insertUser(h.db, row.appId);
  const s = shapeOf(row);
  const outBizNo = id.replaceAll('-', '');
  const createdAt = row.createdAt ?? shift(row.at, -2 * HOUR_MS);
  const updatedAt = row.at;
  await sql`INSERT INTO app.withdrawals
      (id, app_id, user_id, amount_fen, fee_fen, tax_fen, net_fen, income_type, payout_method,
       payee_name, payee_account_cipher, payee_hmac, status, out_biz_no, payout_channel, paid_at,
       manual_entry_by, manual_confirm_by, reject_reason_code, needs_manual, manual_resolution,
       hold_reason, hold_at, created_at, updated_at)
    VALUES (${id}, ${row.appId}, ${user}, ${100_000n}, ${0n}, ${0n}, ${100_000n}, 'SERVICE_FEE',
      'alipay', 'synthetic', ${Buffer.from('synthetic-cipher')}, ${'a'.repeat(64)}, ${s.status},
      ${outBizNo}, 'alipay', ${s.paidAt}::timestamptz,
      ${s.manualPaid ? randomUUID() : null}::uuid, ${s.manualPaid ? randomUUID() : null}::uuid,
      ${s.rejected ? 'OTHER' : null}, ${s.needsManual}, ${s.manualResolution},
      ${s.holdAt === null ? null : 'payer_side_after_transfer'}, ${s.holdAt}::timestamptz,
      ${createdAt}::timestamptz, ${updatedAt}::timestamptz)`.execute(h.db);
  for (const attempt of s.attempts) {
    await sql`INSERT INTO app.payout_attempts
        (id, app_id, withdrawal_id, kind, request, result, at)
      VALUES (${randomUUID()}, ${row.appId}, ${id}, ${attempt.kind},
        ${JSON.stringify({ out_biz_no: outBizNo })}::jsonb, ${attempt.result},
        ${attempt.at}::timestamptz)`.execute(h.payout);
  }
  return id;
}

/** Every row of the two tables the gauges read. */
export async function tableSnapshot(db: Kysely<DB>): Promise<unknown[]> {
  const withdrawals =
    await sql`SELECT to_jsonb(w) AS row FROM app.withdrawals w ORDER BY id`.execute(db);
  const attempts =
    await sql`SELECT to_jsonb(a) AS row FROM app.payout_attempts a ORDER BY id`.execute(db);
  return [...withdrawals.rows, ...attempts.rows];
}

// ---- the expected values, from the outcomes themselves ------------------------------------------

/** The start of the +08:00 day containing `instant`, as epoch milliseconds. */
export function dayStartMs(instant: string): number {
  const offset = 8 * HOUR_MS;
  return Math.floor((Date.parse(instant) + offset) / DAY_MS) * DAY_MS - offset;
}

/**
 * BR-WDR-24 applied to one app's outcomes by hand, read at `now` (D10-1186 ①, D10-1203): only W5 and
 * W6 count, each at its `at` (= updated_at); today = the +08:00 day containing `now`, [00:00, next
 * 00:00); the streak: every W5 / W6 with `at` ≤ now in the order of `at`, cut into runs of
 * consecutive W6 (a W5 ends a run); the longest run whose last W6 has `at` ∈ (now − 24h, now],
 * counted whole however far back it reaches; 0 without such a run. Instants must be distinct (so
 * the order by (updated_at, id) is the order of `at`); the tests never put a row after the instant
 * they read at when they use this.
 */
export function expectedOf(
  rows: readonly OutcomeRow[],
  now: string = NOW,
): Record<FailKey, number> {
  const nowMs = Date.parse(now);
  const dayStart = dayStartMs(now);
  const counted = rows
    .filter((row) => row.outcome === 'W5' || row.outcome === 'W6')
    .map((row) => ({ outcome: row.outcome, ms: Date.parse(row.at) }))
    .filter((row) => row.ms <= nowMs)
    .sort((x, y) => x.ms - y.ms);
  const inDay = counted.filter((row) => row.ms >= dayStart && row.ms < dayStart + DAY_MS);
  // The runs of consecutive W6, each with its length and its last W6's instant.
  const runs: { length: number; lastMs: number }[] = [];
  let current: { length: number; lastMs: number } | null = null;
  for (const row of counted) {
    if (row.outcome === 'W5') {
      current = null;
      continue;
    }
    if (current === null) {
      current = { length: 0, lastMs: row.ms };
      runs.push(current);
    }
    current.length += 1;
    current.lastMs = row.ms;
  }
  const streak = runs
    .filter((run) => run.lastMs > nowMs - DAY_MS)
    .reduce((longest, run) => Math.max(longest, run.length), 0);
  return {
    w6Today: inDay.filter((row) => row.outcome === 'W6').length,
    w5w6Today: inDay.length,
    w6Streak: streak,
  };
}
