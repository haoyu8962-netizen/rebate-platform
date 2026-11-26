// B2-17 backfill of the link table (claude-independent): BR-FUND-24 ⑨ 「同一差错单对同一受益用户至多关联一张
// 已执行、未被红冲的调账单」 for the forms executed before the migration, with §12.1 of the task (编排
// D10-3237 (一), D10-3239): migration *_adjustment-recon-diffs.sql carries, after the link table, one
// INSERT … SELECT that gives every APPROVED form that is not a reversal and was not reversed one row
// per ref { ref_type: recon_diff, ref_id } naming (case-insensitively) an existing ledger_mismatch
// diff of the same app — reversed_by_adjust_id NULL, user_id the form's member, created_at the
// form's reviewed_at; it changes no diff and no form, and refs that are not objects or whose ref_id
// is not a UUID are skipped without an error. The statement is taken from the file and run once as
// couli_app on forms seeded the way earlier filings left them (one execution in this file).
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  ago,
  allForms,
  fixture,
  member,
  newAppId,
  seedForm,
  suite,
  type AdjustFixture,
  type Ref,
} from '../admin-adjustments/kit.ts';
import {
  allLinkCount,
  migrationText,
  OK,
  runBackfill,
  sqlStatements,
  theBackfill,
} from './kit-backfill.ts';
import {
  diffRef,
  diffsOf,
  linkOf,
  linksOf,
  schemaReady,
  seedTicket,
  sortedLinks,
  type LinkRow,
} from './kit.ts';

const s = suite();

/** The position of the first statement matching `pattern` (-1 when none does). */
function positionOf(statements: readonly string[], pattern: RegExp): number {
  return statements.findIndex((statement) => pattern.test(statement));
}

it('[AC-B2-17#38] 迁移 *_adjustment-recon-diffs.sql 里恰有一条回填语句 INSERT INTO app.adjustment_recon_diffs … SELECT …（去掉注释后只有这一条语句往关联表插入），按 APPROVED 与 ledger_mismatch 取行；它排在建关联表与部分唯一索引 adjustment_recon_diffs_active_key 之后（冲突时以该索引的唯一冲突失败）', async () => {
  const f = fixture(s);
  await schemaReady(f.db);
  const statement = theBackfill();
  expect(statement).toContain('APPROVED');
  expect(statement).toContain('ledger_mismatch');
  const statements = sqlStatements(migrationText());
  const insert = statements.indexOf(statement);
  const table = positionOf(statements, /^create\s+table\s+app\.adjustment_recon_diffs\b/iu);
  const index = positionOf(
    statements,
    /^create\s+unique\s+index\s+adjustment_recon_diffs_active_key\b/iu,
  );
  expect(table, '建关联表').toBeGreaterThanOrEqual(0);
  expect(index, '建部分唯一索引').toBeGreaterThanOrEqual(0);
  expect(insert, '回填在建表之后').toBeGreaterThan(table);
  expect(insert, '回填在部分唯一索引之后').toBeGreaterThan(index);
});

it('[AC-B2-17#39] 在库里执行回填语句：已批准、不是红冲单、没被红冲的调账单，对 refs 里每张同一应用存在的 ledger_mismatch 差错单各恰一行（reversed_by_adjust_id 空、user_id = 会员、created_at = reviewed_at；一张单两张差错单 → 两行；大写 ref_id 也回填；closed 的差错单也回填）；不回填：已被红冲的原单、红冲单、PENDING / REJECTED、别的应用的差错单、不存在的 id、platform_restore / appeal_restore、ref_type 不是 recon_diff、非对象元素与非 UUID 的 ref_id（语句不报错）；执行前后两个应用的 recon_diffs、admin_adjustments 逐行相同', async () => {
  const f = fixture(s);
  await schemaReady(f.db);
  const statement = theBackfill();
  const otherApp = newAppId();
  const g: AdjustFixture = { ...f, appId: otherApp };
  const u1 = await member(f, { available: 5000n });
  const u2 = await member(f, { available: 5000n });
  const u3 = await member(f, { available: 5000n });
  const ub = await member(f, { available: 5000n, appId: otherApp });
  const expected: LinkRow[] = [];

  // Two diffs on one form, one of them also on another member's form.
  const d1 = await seedTicket(f);
  const d2 = await seedTicket(f);
  const f1 = await seedForm(f, {
    userId: u1,
    refs: [diffRef(d1), diffRef(d2)],
    createdAt: ago(f, 300),
  });
  const f2 = await seedForm(f, {
    userId: u2,
    refs: [diffRef(d1)],
    createdAt: ago(f, 290),
  });
  expected.push(linkOf(f, f1.adjust_id, d1.id, u1, null, f1.reviewed_at!));
  expected.push(linkOf(f, f1.adjust_id, d2.id, u1, null, f1.reviewed_at!));
  expected.push(linkOf(f, f2.adjust_id, d1.id, u2, null, f2.reviewed_at!));

  // An upper-case ref_id; a closed diff (the diff's status is not a condition).
  const d3 = await seedTicket(f);
  const upper: Ref = { ref_type: 'recon_diff', ref_id: d3.id.toUpperCase() };
  const f3 = await seedForm(f, {
    userId: u1,
    refs: [upper],
    createdAt: ago(f, 280),
  });
  expected.push(linkOf(f, f3.adjust_id, d3.id, u1, null, f3.reviewed_at!));
  const d4 = await seedTicket(f, { status: 'closed' });
  const f4 = await seedForm(f, {
    userId: u3,
    refs: [diffRef(d4)],
    createdAt: ago(f, 270),
  });
  expected.push(linkOf(f, f4.adjust_id, d4.id, u3, null, f4.reviewed_at!));

  // Diffs of other types.
  const d5 = await seedTicket(f, { type: 'platform_restore', source: 'R1' });
  const d6 = await seedTicket(f, { type: 'appeal_restore', source: 'R3' });
  await seedForm(f, { userId: u1, refs: [diffRef(d5), diffRef(d6)] });

  // A reversed original and its reversal (whose refs are [] by the table's CHECK); a later form of
  // the same member on the same diff is backfilled.
  const d7 = await seedTicket(f);
  const gone = await seedForm(f, {
    userId: u2,
    refs: [diffRef(d7)],
    createdAt: ago(f, 265),
  });
  await seedForm(f, {
    userId: u2,
    reverses: gone,
    createdAt: ago(f, 264),
  });
  const f7 = await seedForm(f, {
    userId: u2,
    refs: [diffRef(d7)],
    createdAt: ago(f, 260),
  });
  expected.push(linkOf(f, f7.adjust_id, d7.id, u2, null, f7.reviewed_at!));

  // Not executed.
  const d8 = await seedTicket(f);
  await seedForm(f, { userId: u3, refs: [diffRef(d8)], status: 'PENDING' });
  const d9 = await seedTicket(f);
  await seedForm(f, { userId: u3, refs: [diffRef(d9)], status: 'REJECTED' });

  // Refs that are not recon_diff refs.
  const d10 = await seedTicket(f);
  const notDiffs: Ref[] = [
    { ref_type: 'withdrawal', ref_id: d10.id },
    { ref_type: 'order', ref_id: d10.id },
  ];
  await seedForm(f, { userId: u1, refs: notDiffs });

  // Another app: its diff named from this app is skipped; its own form on it is backfilled.
  const foreign = await seedTicket(g);
  await seedForm(f, { userId: u3, refs: [diffRef(foreign)] });
  const fb = await seedForm(g, {
    userId: ub,
    refs: [diffRef(foreign)],
    createdAt: ago(f, 240),
  });
  const otherExpected = [linkOf(g, fb.adjust_id, foreign.id, ub, null, fb.reviewed_at!)];

  // Elements that are not objects, a ref_id that is not a UUID, an id that names nothing.
  const d12 = await seedTicket(f);
  const junk = ['fixture-ref', 42, null] as unknown as Ref[];
  const mixed: Ref[] = [
    ...junk,
    { ref_type: 'recon_diff', ref_id: 'not-a-uuid' },
    { ref_type: 'recon_diff', ref_id: randomUUID() },
    diffRef(d12),
  ];
  const f12 = await seedForm(f, {
    userId: u3,
    refs: mixed,
    createdAt: ago(f, 250),
  });
  expected.push(linkOf(f, f12.adjust_id, d12.id, u3, null, f12.reviewed_at!));
  await seedForm(f, {
    userId: u1,
    refs: ['fixture-ref'] as unknown as Ref[],
    reason: 'OTHER',
  });

  const before = {
    forms: await allForms(f),
    diffs: await diffsOf(f),
    otherForms: await allForms(g),
    otherDiffs: await diffsOf(g),
  };
  expect(await linksOf(f), '回填前没有关联行').toEqual([]);

  expect(await runBackfill(f.db, statement), '回填语句不报错').toEqual(OK);

  expect(await linksOf(f)).toEqual(sortedLinks(expected));
  expect(await linksOf(f, otherApp)).toEqual(otherExpected);
  const total = expected.length + otherExpected.length;
  expect(await allLinkCount(f.db), '别的应用没有行').toBe(total);
  const after = {
    forms: await allForms(f),
    diffs: await diffsOf(f),
    otherForms: await allForms(g),
    otherDiffs: await diffsOf(g),
  };
  expect(after, '回填不改差错单与调账单').toEqual(before);
});
