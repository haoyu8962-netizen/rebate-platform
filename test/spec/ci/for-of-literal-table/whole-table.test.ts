// CT-06zzzzzv (D10-2152) 「照旧整表判 changed」: every other way of writing the table is judged as
// before — the whole table changed, so its rows whose text is the base's are no unchanged tests and,
// green on the skeleton, are problems. One test per kind; each first runs the qualifying form as
// the control (the same rows, the same change, the same ledger). D10-2163 adds: a table imported
// from the same-directory kit, for…in, a declared changed row with no row at its index in the base
// or with the base's text, and a changed row's full name that another row or test also has.
import { expect, it } from 'vitest';
import {
  BODY_CHANGED_CASE,
  DECLARED_NOT_CHANGED,
  DUPLICATE_NAME,
  F,
  FOR_IN,
  KIT_TABLE,
  NEW,
  NEW_HEAD,
  NON_LITERAL_ROW,
  NOT_INLINE,
  OTHER_FORMS,
  Q_BASE,
  Q_HEAD,
  Q_LEDGER,
  ROWS_MOVED,
  RUNTIME_ROW_CHANGED,
  type WholeCase,
  expectedRedFiles,
  judgeCase,
  judgeF,
  modifiedOnlyFiles,
  qTests,
  reader,
  ruleTestsLeftOut,
  treesOf,
} from './kit.ts';

/** The control: the qualifying for…of table passes (#1). */
const qualifies = (): void => {
  const { result } = judgeF(Q_BASE, Q_HEAD, Q_LEDGER, qTests());
  expect(result.problems, 'the control (qualifying for…of table)').toEqual([]);
  expect(result.ok, 'the control (qualifying for…of table)').toBe(true);
};

/** The case is judged as a whole table: the file stays expected and its unchanged rows, green, are problems. */
const wholeTable = (c: WholeCase): void => {
  const { expected, result } = judgeCase(c);
  expect(expected, c.name).toEqual([F]);
  expect(result.ok, c.name).toBe(false);
  for (const name of c.unchanged) {
    expect(
      result.problems.some((p) => p.file === F && p.test === name),
      `${c.name}: ${name}\n${JSON.stringify(result.problems, null, 2)}`,
    ).toBe(true);
  }
};

it('[CT-06zzzzzv#5] a table that is no inline literal — a top-level const, the result of a call — is judged as a whole table', () => {
  qualifies();
  expect(NOT_INLINE.length).toBeGreaterThanOrEqual(2);
  for (const c of NOT_INLINE) wholeTable(c);
});

it('[CT-06zzzzzv#6] a spread in the table, or a changed row with a non-literal field (path: SEARCH from the kit, declared), makes the whole table changed', () => {
  qualifies();
  expect(NON_LITERAL_ROW.length).toBeGreaterThanOrEqual(2);
  for (const c of NON_LITERAL_ROW) wholeTable(c);
});

it('[CT-06zzzzzv#7] any changed token of the loop body makes the whole table changed', () => {
  qualifies();
  wholeTable(BODY_CHANGED_CASE);
});

it('[CT-06zzzzzv#8] rows added, removed or swapped make the whole table changed', () => {
  qualifies();
  expect(ROWS_MOVED.length).toBeGreaterThanOrEqual(3);
  for (const c of ROWS_MOVED) wholeTable(c);
});

it('[CT-06zzzzzv#9] the run-time row (randomUUID() in its title) with its text changed makes the whole table changed', () => {
  qualifies();
  wholeTable(RUNTIME_ROW_CHANGED);
});

it('[CT-06zzzzzv#10] a loop that is not top-level (inside a describe), not for…of (forEach), or makes two it per row is judged as a whole table', () => {
  qualifies();
  expect(OTHER_FORMS.length).toBeGreaterThanOrEqual(3);
  for (const c of OTHER_FORMS) wholeTable(c);
});

it('[CT-06zzzzzv#17] a table imported from the same-directory kit (for (const route of ROUTES), the step-up row changed in the kit, both kits in the trees) is judged as a whole table, and red-check and evidence-check agree on the file', () => {
  qualifies();
  expect(KIT_TABLE.kit?.base).not.toBe(KIT_TABLE.kit?.head);
  wholeTable(KIT_TABLE);
  const t = treesOf(KIT_TABLE);
  const read = reader(t.base, { ...t.head, [NEW]: NEW_HEAD });
  const files = [F, NEW];
  expect(modifiedOnlyFiles([F], read, KIT_TABLE.ledger.modify_existing)).toEqual([]);
  const red = ruleTestsLeftOut(files, read, KIT_TABLE.ledger).expected;
  const wanted = expectedRedFiles(files, read, KIT_TABLE.ledger, KIT_TABLE.ledger.modify_existing);
  expect(red).toContain(F);
  expect([...wanted].sort()).toEqual([...red].sort());
});

it('[CT-06zzzzzv#18] for…in over the inline array instead of for…of is judged as a whole table', () => {
  qualifies();
  wholeTable(FOR_IN);
});

it('[CT-06zzzzzv#19] a row declared changed that has no row at its index in the base (a row added), or whose text is the base’s (declared all the same), makes the whole table changed', () => {
  qualifies();
  expect(DECLARED_NOT_CHANGED.length).toBeGreaterThanOrEqual(2);
  for (const c of DECLARED_NOT_CHANGED) wholeTable(c);
});

it('[CT-06zzzzzv#20] a changed row whose full name after the change is another row’s of the table or another test’s of the file makes the whole table changed', () => {
  qualifies();
  expect(DUPLICATE_NAME.length).toBeGreaterThanOrEqual(2);
  for (const c of DUPLICATE_NAME) wholeTable(c);
});
