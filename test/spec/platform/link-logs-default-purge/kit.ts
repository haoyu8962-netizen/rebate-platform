// Helpers of the CT-13l rule tests (expired rows of the link_logs DEFAULT partition). Basis: BR-ID-30
// 正文（每日 04:00（+08:00）删除任务；删除条件 created_at < 运行当日 00:00（+08:00）− 留存天数）and ②
// (link_logs：90 天，按日分区删除); BR-ATTR-14 默认值（被工单引用的记录在分区删除前复制到
// link_log_evidence); I1b of apps/api/src/modules/platform/maintenance/index.ts (the cutoff of
// app.drop_expired_day_partitions for link_logs); orchestrator rulings D10-1623 / D10-1624 / D10-1625 /
// D10-1649 / D10-1693.
//
// Contract the tests hold the implementation to (SQL objects are created by the implementation's
// migration, never by these tests):
// - `app.purge_expired_link_logs_default(p_now timestamptz) RETURNS bigint`, result read under the
//   alias `deleted`. Deletes exactly the rows of the DEFAULT partition app.link_logs_default whose
//   created_at < cutoff, where cutoff is word for word the one app.drop_expired_day_partitions uses
//   for link_logs: 00:00 (+08:00) of p_now's +08:00 calendar day − 90 days (strictly earlier rows
//   only; the session TimeZone changes nothing). Returns the number of deleted rows.
// - Rows of the DEFAULT partition at or after the cutoff — future dates beyond the pre-created day
//   partitions included — stay as they are; rows of day partitions (even expired ones not yet
//   dropped) are not touched: dropping those is app.drop_expired_day_partitions' job.
// - Before deleting, in the same transaction, every expired DEFAULT row whose id appears in some
//   app.claim_items.evidence_link_log_ids (whatever the item's decision) is copied into
//   app.link_log_evidence, column by column equal to its link_logs row (as the partition drop of
//   CT-13m does); unreferenced rows are deleted without a copy. When the copy fails the call fails
//   and no DEFAULT row is deleted.
// - No other table changes: link_open_attempts, links, claims, claim_items, and the evidence rows
//   that were already there.
// - Grants: only couli_maint may EXECUTE it (couli_app, couli_payout, couli_readonly → 42501).
// - Maintenance (section I of the maintenance module, worker): see ./maintenance-schedule.test.ts.
//
// Every helper reports a rejection as a value (`failed <SQLSTATE>`), so a scenario on a database
// without the migration fails on its assertions. Only *.int.test.ts files may import
// @couli/db/testing: they pass createTestDatabase in (through withWorld of the CT-13m kit).
import { randomUUID } from 'node:crypto';

import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { expect } from 'vitest';

import { failure } from '../../linking/link-log-evidence/kit.ts';

/** The function under test, as to_regprocedure reads it. */
export const SIGNATURE = 'app.purge_expired_link_logs_default(timestamp with time zone)';

/** 2026-10-09 04:00 (+08:00): a run of the daily deletion task. */
export const NOW = '2026-10-08T20:00:00.000Z';

/** 2026-07-11 00:00 (+08:00) = 00:00 of NOW's +08:00 day (10-09) − 90 days, counted by hand. */
export const CUTOFF = '2026-07-10T16:00:00.000Z';

/** Fixed instant for created_at / updated_at of fixture rows that no rule looks at. */
const FIXTURE_AT = '2026-01-04T00:00:00.000Z';

/** Asserts that the migration created the function (a clear first red without it). */
export async function requireFunction(db: Kysely<DB>): Promise<void> {
  const result = await sql<{ present: boolean }>`
    SELECT to_regprocedure(${SIGNATURE}::text) IS NOT NULL AS present
  `.execute(db);
  const present = result.rows[0]?.present;
  expect(present, 'CT-13l: app.purge_expired_link_logs_default(timestamptz) missing').toBe(true);
}

/**
 * app.purge_expired_link_logs_default(now) as `db` in its own transaction (session TimeZone `zone`
 * when given; a 5 s session lock_timeout so that a lock wait ends even if the function sets none):
 * the deleted count (bigint), or `failed <code>`.
 */
export async function purgeDefault(
  db: Kysely<DB>,
  now: string,
  zone?: string,
): Promise<bigint | string> {
  try {
    return await db.transaction().execute(async (trx) => {
      if (zone !== undefined) {
        await sql`SELECT set_config('TimeZone', ${zone}, true)`.execute(trx);
      }
      await sql`SELECT set_config('lock_timeout', '5s', true)`.execute(trx);
      const result = await sql<{ deleted: bigint | null }>`
        SELECT app.purge_expired_link_logs_default(${now}::timestamptz) AS deleted
      `.execute(trx);
      const deleted = result.rows[0]?.deleted;
      if (deleted === undefined) return 'no row';
      if (deleted === null) return 'NULL result';
      return deleted;
    });
  } catch (error) {
    return failure(error);
  }
}

/** id (text) and the partition (relname) of every link_logs row, by id. */
export async function placement(db: Kysely<DB>): Promise<Array<{ id: string; part: string }>> {
  const result = await sql<{ id: string; part: string }>`
    SELECT l.id::text AS id, c.relname::text AS part
    FROM app.link_logs l JOIN pg_class c ON c.oid = l.tableoid
    ORDER BY l.id, l.created_at
  `.execute(db);
  return result.rows.map((r) => ({ id: r.id, part: r.part }));
}

/** Every link_logs row as jsonb (timestamps under UTC) with its partition, by id. */
export async function allLinkLogs(db: Kysely<DB>): Promise<Array<Record<string, unknown>>> {
  return db.transaction().execute(async (trx) => {
    await sql`SET LOCAL TIME ZONE 'UTC'`.execute(trx);
    const result = await sql<{ row: Record<string, unknown> }>`
      SELECT to_jsonb(l) || jsonb_build_object('partition', c.relname::text) AS row
      FROM app.link_logs l JOIN pg_class c ON c.oid = l.tableoid
      ORDER BY l.id, l.created_at
    `.execute(trx);
    return result.rows.map((r) => r.row);
  });
}

/** The rows of the DEFAULT partition only, as jsonb (timestamps under UTC), by id. */
export async function defaultRows(db: Kysely<DB>): Promise<Array<Record<string, unknown>>> {
  return db.transaction().execute(async (trx) => {
    await sql`SET LOCAL TIME ZONE 'UTC'`.execute(trx);
    const result = await sql<{ row: Record<string, unknown> }>`
      SELECT to_jsonb(l) AS row
      FROM app.link_logs l
      WHERE l.tableoid = 'app.link_logs_default'::regclass
      ORDER BY l.id, l.created_at
    `.execute(trx);
    return result.rows.map((r) => r.row);
  });
}

/** Tables a DEFAULT purge must leave alone (link_log_evidence: rows that were already there). */
export type OtherTable = 'link_open_attempts' | 'links' | 'claims' | 'claim_items';

/** Every row of app.<table> as jsonb (timestamps under UTC), in a stable order; or `failed <code>`. */
export async function tableRows(
  db: Kysely<DB>,
  table: OtherTable | 'link_log_evidence',
): Promise<Array<Record<string, unknown>> | string> {
  try {
    return await db.transaction().execute(async (trx) => {
      await sql`SET LOCAL TIME ZONE 'UTC'`.execute(trx);
      const result = await sql<{ row: Record<string, unknown> }>`
        SELECT to_jsonb(t) AS row FROM ${sql.table(`app.${table}`)} t ORDER BY to_jsonb(t)::text
      `.execute(trx);
      return result.rows.map((r) => r.row);
    });
  } catch (error) {
    return failure(error);
  }
}

/** A links row of app `couli`, as couli_app; returns its link_id. */
export async function seedLink(app: Kysely<DB>): Promise<string> {
  const linkId = randomUUID();
  await sql`
    INSERT INTO app.links (app_id, link_id, platform, scene, expire_at, created_at, updated_at)
    VALUES ('couli', ${linkId}::uuid, 'demo', 'self', '2027-01-01T00:00:00Z'::timestamptz,
            ${FIXTURE_AT}::timestamptz, ${FIXTURE_AT}::timestamptz)
  `.execute(app);
  return linkId;
}

/** A link_open_attempts row of `linkId` opened (and created) at `openedAt`, as couli_app. */
export async function seedAttempt(
  app: Kysely<DB>,
  linkId: string,
  openedAt: string,
): Promise<void> {
  await sql`
    INSERT INTO app.link_open_attempts (attempt_id, app_id, link_id, opened_at, created_at,
                                        updated_at)
    VALUES (${randomUUID()}::uuid, 'couli', ${linkId}::uuid, ${openedAt}::timestamptz,
            ${openedAt}::timestamptz, ${openedAt}::timestamptz)
  `.execute(app);
}

/** The labels (keys of `byLabel`) of `ids`, in the order of `ids`; unknown ids as `?<id>`. */
export function labelsOf(
  ids: readonly string[],
  byLabel: Readonly<Record<string, string>>,
): string[] {
  const byId = new Map(Object.entries(byLabel).map(([label, id]) => [id, label]));
  return ids.map((id) => byId.get(id) ?? `?${id}`);
}

/** `link_logs_pYYYYMMDD` of a 'YYYY-MM-DD' day. */
export function dayPartition(day: string): string {
  return `link_logs_p${day.replaceAll('-', '')}`;
}
