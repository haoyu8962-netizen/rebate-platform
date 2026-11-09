// B2-09ze rule-test kit (规划/08 BR-WDR-18 ② and 细则「多通道的 W」; 编排裁定 D10-805 ④, D10-807). The
// worker exports one gauge, couli_payout_water_stale{app_id}: 1 when the app has enterprise Alipay
// withdrawals waiting to be executed (status APPROVED, payout_channel alipay; the waiting
// withdrawals of other channels do not count against Alipay's W) and the enterprise Alipay channel has no fresh
// W (no row, or the latest row older than BR-WDR-18 ②'s 2 hours), 0 when that W is fresh; an app
// without waiting enterprise Alipay withdrawals is never 1 (0 or no sample, the implementation's choice). "Fresh" has one source: the
// same judgement as EXECUTE's judgeWatermark (D10-807 ①); the tests compare the two, they do not
// restate the limit beyond BR-WDR-18's own example times. The metric name and label are written out
// here, independent of the code under test. Time, W rows and the read-only snapshot come from
// B2-09j's kit, the Prometheus text reader from B1-01zzh's, the user helper from B1-01zzi's (all read
// only, not changed). The test database comes from the int tests (@couli/db/testing is allowed in
// *.int.test.ts only).
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { expect } from 'vitest';
import { insertUser } from '../../fund-metrics/kit.ts';
import { samples } from '../kit.ts';
import { HOUR_MS, NOW, shift, type Channel } from '../water-level/water-harness.ts';

// ---- the metric --------------------------------------------------------------------------------

export const WATER_STALE_METRIC = 'couli_payout_water_stale';
/** The one label of the gauge. */
export const LABEL = 'app_id';

/** Whether the text mentions the metric at all (a sample, HELP or TYPE line). */
export function mentionsWaterStale(text: string): boolean {
  return new RegExp(`(^|[\\s{])${WATER_STALE_METRIC}([\\s{]|$)`, 'm').test(text);
}

/** The gauge as { app_id: value }; every series carries exactly the label app_id, once each. */
export function waterStaleGauge(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const sample of samples(text).filter((s) => s.name === WATER_STALE_METRIC)) {
    expect(Object.keys(sample.labels), `${WATER_STALE_METRIC} labels`).toEqual([LABEL]);
    const appId = sample.labels[LABEL]!;
    expect(Object.hasOwn(out, appId), `${WATER_STALE_METRIC}{${LABEL}="${appId}"} twice`).toBe(
      false,
    );
    out[appId] = sample.value;
  }
  return out;
}

/** The family's `# HELP` text (trimmed); fails when the line is missing. */
export function waterStaleHelp(text: string): string {
  const match = new RegExp(`^# HELP ${WATER_STALE_METRIC} (.*)$`, 'm').exec(text);
  expect(match, `# HELP ${WATER_STALE_METRIC}`).not.toBeNull();
  return match![1]!.trim();
}

/**
 * "Never 1" for an app without waiting withdrawals: either no sample or the value 0 (D10-805 ④
 * leaves the choice to the implementation).
 */
export function expectNotAlerting(
  gauge: Readonly<Record<string, number>>,
  appId: string,
  where: string,
): void {
  const value = Object.hasOwn(gauge, appId) ? gauge[appId] : undefined;
  expect([undefined, 0], `${where}: ${appId} is 0 or has no sample, got ${value}`).toContain(value);
}

// ---- database fixtures -------------------------------------------------------------------------

export type WithdrawalStatus =
  'PENDING_REVIEW' | 'APPROVED' | 'REJECTED' | 'PAYING' | 'PAID_API' | 'PAID_MANUAL' | 'FAILED';

/** Every status but APPROVED: none of them waits to be executed. */
export const NOT_WAITING: readonly WithdrawalStatus[] = [
  'PENDING_REVIEW',
  'REJECTED',
  'PAYING',
  'PAID_API',
  'PAID_MANUAL',
  'FAILED',
];

/** One withdrawal satisfying every CHECK of app.withdrawals (APPROVED, alipay, an hour old). */
export async function insertWithdrawal(
  db: Kysely<DB>,
  row: {
    readonly appId: string;
    readonly status?: WithdrawalStatus;
    readonly channel?: Channel;
    readonly createdAt?: string;
  },
): Promise<void> {
  const id = randomUUID();
  const user = await insertUser(db, row.appId);
  const channel = row.channel ?? 'alipay';
  const status = row.status ?? 'APPROVED';
  const paid = status === 'PAID_API' || status === 'PAID_MANUAL';
  const manual = status === 'PAID_MANUAL';
  const createdAt = row.createdAt ?? shift(NOW, -HOUR_MS);
  await sql`INSERT INTO app.withdrawals
      (id, app_id, user_id, amount_fen, fee_fen, tax_fen, net_fen, income_type, payout_method,
       payee_name, payee_account_cipher, payee_hmac, bank_name, wechat_app_id, status, out_biz_no,
       payout_channel, paid_at, manual_entry_by, manual_confirm_by, reject_reason_code, created_at,
       updated_at)
    VALUES (${id}, ${row.appId}, ${user}, ${100_000n}, ${0n}, ${0n}, ${100_000n}, 'SERVICE_FEE',
      ${channel}, 'synthetic', ${Buffer.from('synthetic-cipher')}, ${'a'.repeat(64)},
      ${channel === 'bank_card' ? 'synthetic-bank' : null},
      ${channel === 'wechat' ? 'wx_synthetic' : null}, ${status}, ${id.replaceAll('-', '')},
      ${channel}, ${paid ? createdAt : null}::timestamptz, ${manual ? randomUUID() : null}::uuid,
      ${manual ? randomUUID() : null}::uuid, ${status === 'REJECTED' ? 'OTHER' : null},
      ${createdAt}::timestamptz, ${createdAt}::timestamptz)`.execute(db);
}
