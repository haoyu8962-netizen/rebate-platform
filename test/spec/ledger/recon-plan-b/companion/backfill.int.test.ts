import { expect, it } from 'vitest';
import { ago, fixture, member, seedForm, suite } from '../../admin-adjustments/kit.ts';
import { OK, runBackfill, theBackfill } from '../kit-backfill.ts';
import { diffRef, linkOf, linksOf, schemaReady, seedTicket } from '../kit.ts';

const s = suite();

it('[AC-B2-17b#8] 存量已批准调账单的创建与批准时间不同时，迁移回填的关联行以批准时间作为 created_at', async () => {
  const f = fixture(s);
  await schemaReady(f.db);
  const userId = await member(f, { available: 5_000n });
  const diff = await seedTicket(f);
  const createdAt = ago(f, 100);
  const reviewedAt = ago(f, 90);
  const form = await seedForm(f, { userId, refs: [diffRef(diff)], amount: 500n, createdAt });
  const timestamps = await f.db
    .updateTable('admin_adjustments')
    .set({ reviewed_at: reviewedAt })
    .where('app_id', '=', f.appId)
    .where('adjust_id', '=', form.adjust_id)
    .returning(['created_at', 'reviewed_at'])
    .executeTakeFirstOrThrow();
  expect(timestamps).toEqual({ created_at: createdAt, reviewed_at: reviewedAt });
  expect(await linksOf(f)).toEqual([]);

  expect(await runBackfill(f.db, theBackfill())).toEqual(OK);
  expect(await linksOf(f)).toEqual([linkOf(f, form.adjust_id, diff.id, userId, null, reviewedAt)]);
});
