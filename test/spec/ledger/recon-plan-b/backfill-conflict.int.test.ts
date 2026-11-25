// B2-17 the backfill refuses duplicates (claude-independent): BR-FUND-24 ⑨ 「同一差错单对同一受益用户至多
// 关联一张已执行、未被红冲的调账单」 with §12.1 ⑤ of the task (编排 D10-3237 (一), D10-3239): when two
// executed, not reversed forms of one member already link the same ledger_mismatch diff (one of them
// naming it in upper case), the migration's backfill statement fails with the unique violation of
// adjustment_recon_diffs_active_key and inserts nothing, not even the rows of other, unrelated forms
// (the migration fails as a whole; the file header says to settle such groups by hand first). The
// statement is taken from the file and run once in this file's database as couli_app.
import { expect, it } from 'vitest';
import { allForms, fixture, member, seedForm, suite } from '../admin-adjustments/kit.ts';
import { ACTIVE_CONFLICT, allLinkCount, runBackfill, theBackfill } from './kit-backfill.ts';
import { diffRef, diffsOf, linksOf, schemaReady, seedTicket } from './kit.ts';

const s = suite();

it('[AC-B2-17#41] 同一（应用、差错单、会员）有两张都满足回填条件的调账单（其中一张 ref_id 大写）→ 回填语句失败 23505 adjustment_recon_diffs_active_key，关联表仍为空（别的调账单的行也不插）；差错单与调账单不变', async () => {
  const f = fixture(s);
  await schemaReady(f.db);
  const statement = theBackfill();
  const u1 = await member(f, { available: 5000n });
  const u2 = await member(f, { available: 5000n });
  const twice = await seedTicket(f);
  const fine = await seedTicket(f);
  await seedForm(f, { userId: u1, refs: [diffRef(twice)] });
  await seedForm(f, {
    userId: u1,
    refs: [{ ref_type: 'recon_diff', ref_id: twice.id.toUpperCase() }],
  });
  await seedForm(f, { userId: u2, refs: [diffRef(fine)] });
  const before = { forms: await allForms(f), diffs: await diffsOf(f) };

  expect(await runBackfill(f.db, statement), '唯一冲突').toEqual(ACTIVE_CONFLICT);
  expect(await linksOf(f)).toEqual([]);
  expect(await allLinkCount(f.db), '什么都不插').toBe(0);
  expect({ forms: await allForms(f), diffs: await diffsOf(f) }).toEqual(before);
});
