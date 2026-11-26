// B2-17 rule-test helpers of the second writing (claude-independent, SPEC_REF 1025764b): fixtures
// that kit.ts does not have, for the cases added after the first spec review (编排 D10-2997).
// - seedLink: a link row as an earlier filing left it (written directly as couli_app, unreversed),
//   next to a form seeded with ../admin-adjustments/kit.ts seedForm;
// - holdLinks: the link rows of one form held FOR UPDATE from the suite's second pool (couli_app
//   has UPDATE on reversed_by_adjust_id, §9.2 (a)), so a reversal that must mark them waits there;
// - rowOf: a recon_diffs row of any app (the fixture's diffNow reads only the fixture's app).
// No real data. The new table does not exist before the migration: every caller first asserts it
// does (kit.ts schemaReady), so these never meet a missing relation.
import { sql } from 'kysely';
import { expect } from 'vitest';
import type { AdjustFixture, HeldLock } from '../admin-adjustments/kit.ts';
import type { DiffRow } from '../admin-recon-diffs/kit.ts';

/** An unreversed link row of (form, diff, member) written directly (an earlier filing's row). */
export async function seedLink(
  f: AdjustFixture,
  adjustId: string,
  diffId: string,
  userId: string,
  at: Date = f.clock.now(),
): Promise<void> {
  await sql`INSERT INTO app.adjustment_recon_diffs
    (app_id, adjust_id, recon_diff_id, user_id, reversed_by_adjust_id, created_at)
    VALUES (${f.appId}, ${adjustId}, ${diffId}, ${userId}, NULL, ${at})`.execute(f.db);
}

/** Holds every link row of the form FOR UPDATE from the suite's second pool until release(). */
export async function holdLinks(f: AdjustFixture, adjustId: string): Promise<HeldLock> {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  let locked!: () => void;
  const ready = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const done = f.s
    .holder()
    .transaction()
    .execute(async (trx) => {
      const rows = await sql`SELECT recon_diff_id FROM app.adjustment_recon_diffs
        WHERE app_id = ${f.appId} AND adjust_id = ${adjustId} FOR UPDATE`.execute(trx);
      expect(rows.rows.length, `调账单 ${adjustId} 的关联行`).toBeGreaterThan(0);
      locked();
      await gate;
    });
  await Promise.race([ready, done]);
  return {
    async release() {
      open();
      await done;
    },
  };
}

/** One recon_diffs row of `appId` as it is now (every column). */
export async function rowOf(f: AdjustFixture, appId: string, id: string): Promise<DiffRow> {
  const row = await f.db
    .selectFrom('recon_diffs')
    .selectAll()
    .where('app_id', '=', appId)
    .where('id', '=', id)
    .executeTakeFirst();
  expect(row, `recon_diffs ${appId} ${id}`).toBeDefined();
  return row!;
}
