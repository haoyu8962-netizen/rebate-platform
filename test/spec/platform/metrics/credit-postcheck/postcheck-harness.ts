// B2-02v rule-test kit (规划/08 BR-FUND-19 末句「不一致 5 分钟内告警」; 编排裁定 D10-1038, D10-1180,
// D10-1185). The worker exports one gauge, couli_credit_postcheck_mismatch_open{app_id}: the
// recon_diffs rows with type ledger_mismatch, status open or processing, ref_type voucher and a ref_id
// starting with `credit_postcheck:`, per app_id; an app without such a row has no sample (not 0). The metric
// name, the label, the prefix, the 30-second cache and the fixture's rows are written out here,
// independent of the code under test. The Prometheus text reader comes from B1-01zzh's kit (read
// only, not changed). The test database comes from the int tests (@couli/db/testing is allowed in
// *.int.test.ts only).
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { expect } from 'vitest';
import { samples } from '../kit.ts';

// ---- the metric --------------------------------------------------------------------------------

export const CREDIT_POSTCHECK_METRIC = 'couli_credit_postcheck_mismatch_open';
/** The one label of the gauge. */
export const LABEL = 'app_id';
/** The ref_id prefix of the diffs the post-credit confirmation registers (B2-02t). */
export const REF_PREFIX = 'credit_postcheck:';
/** The cache age: 30 seconds, not the common 5 minutes (D10-1038). */
export const TTL_MS = 30_000;

/** Whether the text mentions the metric at all (a sample, HELP or TYPE line). */
export function mentionsCreditPostcheck(text: string): boolean {
  return new RegExp(`(^|[\\s{])${CREDIT_POSTCHECK_METRIC}([\\s{]|$)`, 'm').test(text);
}

/** The gauge as { app_id: value }; every series carries exactly the label app_id, once each. */
export function creditPostcheckGauge(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const sample of samples(text).filter((s) => s.name === CREDIT_POSTCHECK_METRIC)) {
    expect(Object.keys(sample.labels), `${CREDIT_POSTCHECK_METRIC} labels`).toEqual([LABEL]);
    const appId = sample.labels[LABEL]!;
    expect(Object.hasOwn(out, appId), `${CREDIT_POSTCHECK_METRIC}{${LABEL}="${appId}"} twice`).toBe(
      false,
    );
    out[appId] = sample.value;
  }
  return out;
}

/** The family's `# HELP` text (trimmed); fails when the line is missing. */
export function creditPostcheckHelp(text: string): string {
  const match = new RegExp(`^# HELP ${CREDIT_POSTCHECK_METRIC} (.*)$`, 'm').exec(text);
  expect(match, `# HELP ${CREDIT_POSTCHECK_METRIC}`).not.toBeNull();
  return match![1]!.trim();
}

// ---- database fixtures -------------------------------------------------------------------------

export type DiffStatus = 'open' | 'processing' | 'adjusted' | 'written_off' | 'closed';

/** The resolved statuses: none of them is counted (open and processing are, D10-1185). */
export const RESOLVED: readonly DiffStatus[] = ['adjusted', 'written_off', 'closed'];

/** Every recon_diffs type but ledger_mismatch (db/schema.sql recon_diffs_type_check). */
export const OTHER_TYPES: readonly string[] = [
  'union_mismatch',
  'channel_mismatch',
  'platform_restore',
  'month_end_unbalanced',
  'settle_amount_mismatch',
  'settle_missing',
  'appeal_restore',
  'estimate_changed_after_credit',
  'pay_mismatch',
  'pay_anomaly',
  'blacklist_after_credit',
];

export interface DiffFixture {
  readonly appId: string;
  readonly type?: string;
  readonly status?: DiffStatus;
  readonly refType?: string;
  readonly refId?: string;
}

/** A ref_id of the post-credit confirmation, on a voucher of its own. */
export function postcheckRefId(): string {
  return `${REF_PREFIX}${randomUUID()}`;
}

/** One recon_diffs row; by default one the gauge counts. Returns its id. */
export async function insertDiff(db: Kysely<DB>, row: DiffFixture): Promise<string> {
  const id = randomUUID();
  const refId = row.refId ?? postcheckRefId();
  const status = row.status ?? 'open';
  const at = '2031-04-05T06:07:08.000Z';
  const closedAt = status === 'open' || status === 'processing' ? null : at;
  await sql`INSERT INTO app.recon_diffs
      (id, app_id, type, source, period, ref_type, ref_id, expected_fen, actual_fen, diff_fen,
       status, closed_at, dedupe_key, resolution, created_at, updated_at)
    VALUES (${id}, ${row.appId}, ${row.type ?? 'ledger_mismatch'}, 'R3', '2031-04-05',
      ${row.refType ?? 'voucher'}, ${refId}, ${425n}, ${424n}, ${1n}, ${status},
      ${closedAt}::timestamptz, ${`R3:${refId}`}, '{}'::jsonb, ${at}::timestamptz,
      ${at}::timestamptz)`.execute(db);
  return id;
}

/** Sets one diff's status, as the closing of a diff does. */
export async function setDiffStatus(db: Kysely<DB>, id: string, status: DiffStatus): Promise<void> {
  await sql`UPDATE app.recon_diffs SET status = ${status} WHERE id = ${id}`.execute(db);
}

/** Every row of recon_diffs, for "the read changes nothing". */
export async function diffSnapshot(db: Kysely<DB>): Promise<unknown[]> {
  return (await sql`SELECT to_jsonb(d) AS row FROM app.recon_diffs d ORDER BY id`.execute(db)).rows;
}
