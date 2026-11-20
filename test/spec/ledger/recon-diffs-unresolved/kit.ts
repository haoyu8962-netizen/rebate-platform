// B2-02zc rule-test kit (claude-independent, SPEC_REF d49d8aa5): 08 BR-FUND-19 细则「账务自检异常」
// 第 4 条「同一个未解决的异常不按会计日重复：差错单未结案期间，之后各会计日再查出同一差异，不新
// 生成差错单、不新增冻结记录；去重的做法由工程定」and 正文「同一个未解决的差异（差错单未结案）在
// 之后的会计日再被查出时，不再新生成差错单、不再新增冻结记录」. Engineering's way (编排 D10-2224 B ①,
// ops/tasks/B2-02zc.yaml): migration `<NNNN>_recon-diffs-unresolved-internal-key.sql` adds the
// partial unique index recon_diffs_unresolved_internal_key (app_id, type, ref_id) WHERE type =
// 'ledger_mismatch' AND status IN ('open', 'processing'); registerReconDiffOnce reads the unresolved
// row back on that conflict (inserted = false, never rewritten); the daily-check executor and the
// credit post-check already hold only on inserted. Concluded (adjusted / written_off / closed) →
// the same difference opens a new ticket again. External differences (union_mismatch, …) stay one
// per (app_id, type, period, ref_id). Scope (编排 D10-2280): recon_diffs and withdraw_holds only.
// Real pieces: PostgreSQL through @couli/db/testing as couli_app. The executor's ports and fixtures
// come from the read-only kits of daily-check-execute / recon-diffs / ledger-owned. No real data.
import { readdirSync, readFileSync } from 'node:fs';
import type { DB } from '@couli/db';
import { sql, type Kysely, type Selectable } from 'kysely';
import { expect } from 'vitest';
import { seedHandler } from '../../db/settlement/ledger-owned/kit.ts';

/** The third checked day (D = 2032-06-15 and D+1 = 2032-06-16 come from the executor kit). */
export const THIRD_DAY = '2032-06-17';
/** 01:00 +08:00 of the day after D+1 / D+2: the scheduled runs of those days. */
export const RUN_NEXT = '2032-06-16T17:00:00.000Z';
export const RUN_THIRD = '2032-06-17T17:00:00.000Z';
/** The moment a ticket is concluded in the fixtures (between the D+1 and D+2 runs). */
export const CONCLUDED_AT = '2032-06-17T03:00:00.000Z';

export const INDEX = 'recon_diffs_unresolved_internal_key';
export const UNRESOLVED = ['open', 'processing'] as const;
export const CONCLUDED = ['adjusted', 'written_off', 'closed'] as const;
export type Concluded = (typeof CONCLUDED)[number];

type DiffRow = Selectable<DB['recon_diffs']>;

/**
 * Moves a ticket the way the console would leave it (status, handler of the same app; closed_at
 * only for a concluded status) and returns the stored row. Only the columns couli_app may update.
 */
export async function moveTo(
  db: Kysely<DB>,
  diff: DiffRow,
  status: 'processing' | Concluded,
  at: string,
): Promise<DiffRow> {
  const handler = await seedHandler(db, diff.app_id);
  await db
    .updateTable('recon_diffs')
    .set({
      status,
      handler_id: handler,
      closed_at: status === 'processing' ? null : at,
      updated_at: at,
    })
    .where('id', '=', diff.id)
    .execute();
  const rows = await db.selectFrom('recon_diffs').selectAll().where('id', '=', diff.id).execute();
  expect(rows, `recon diff ${diff.id} moved to ${status}`).toHaveLength(1);
  expect(rows[0]!.status).toBe(status);
  return rows[0]!;
}

/**
 * Polls until backend `waiter` waits on `holder` (true) or `done()` turns true first (false): a
 * contender that never waits must not hang the test, it simply reports no wait.
 */
export async function waitsOn(
  db: Kysely<DB>,
  waiter: number,
  holder: number,
  done: () => boolean,
): Promise<boolean> {
  for (let attempt = 0; attempt < 2000; attempt += 1) {
    if (done()) return false;
    const result = await sql<{ blocked: boolean }>`
      SELECT ${holder} = ANY(pg_blocking_pids(${waiter})) AS blocked`.execute(db);
    if (result.rows[0]?.blocked === true) return true;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return false;
}

/**
 * The migration that adds the index, located by its file-name suffix (no number reserved), with
 * comments stripped and quotes removed. A missing file is an assertion failure.
 */
export function unresolvedMigrationSource(): string {
  const directory = new URL('../../../../db/migrations/', import.meta.url);
  const names = readdirSync(directory).filter((name) =>
    /^\d{4}_recon-diffs-unresolved-internal-key\.sql$/u.test(name),
  );
  expect(names, '按后缀定位迁移，不预留编号').toHaveLength(1);
  return readFileSync(new URL(names[0]!, directory), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/--[^\n]*/gu, '')
    .replace(/"/gu, '');
}
