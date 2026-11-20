// CT-06zzzzzv (D10-2152), the evidence side: a changed row of the qualifying for…of table declared
// in modify_existing is located by compareModifiedBlocks (which evidence-check uses for a frozen
// file's change) with the row text before and after; when it is the file's only change, nothing
// else differs, red-check leaves the file out as modifiedOnlyFiles says and evidence-check wants a
// red test of exactly the files red-check runs. Every form still judged as a whole table keeps the
// declared row unlocated or something else different, and the file expected, in both.
//
// D10-2163: under the title with the body the changed row is located by its full name after the
// change (the base's name does not let the change through, and the file stays expected).
import { expect, it } from 'vitest';
import {
  ALL_WHOLE,
  B_BASE,
  B_LEDGER_BASE,
  B_LEDGER_HEAD,
  B_PLAIN,
  B_STEP_BASE,
  B_STEP_HEAD,
  F,
  N_GET,
  N_STEP,
  NEW,
  NEW_HEAD,
  Q_BASE,
  Q_LEDGER,
  Q_PLAIN,
  UUID_A,
  bLinkName,
  compareModifiedBlocks,
  expectedRedFiles,
  linkName,
  modifiedOnlyFiles,
  reader,
  ruleTestsLeftOut,
  treesOf,
} from './kit.ts';

const sorted = (list: readonly string[]): string[] => [...list].sort();

/** Whether compareModifiedBlocks lets the declared names through (every one found, changed, nothing else differs). */
const clean = (compared: ReturnType<typeof compareModifiedBlocks>): boolean =>
  compared.ok && compared.outside === null && compared.blocks.every((b) => b.found && b.changed);

it('[CT-06zzzzzv#11] compareModifiedBlocks locates the declared changed row by its expanded full name: found, changed, its row text before (withdraw) and after (phone_change), nothing else differs; an unchanged or run-time row named instead does not let the change through', () => {
  const compared = compareModifiedBlocks(Q_BASE, Q_PLAIN, [N_STEP]);
  expect(compared).toMatchObject({
    ok: true,
    outside: null,
    blocks: [{ test: N_STEP, headTest: N_STEP, found: true, changed: true }],
  });
  const block = compared.ok ? compared.blocks[0] : undefined;
  const before = block?.found === true ? block.before : '';
  const after = block?.found === true ? block.after : '';
  expect(before).toContain("action: 'withdraw'");
  expect(before).not.toContain('phone_change');
  expect(after).toContain("action: 'phone_change'");
  expect(after).not.toContain("'withdraw'");
  // The changed row left undeclared: naming an unchanged row or the run-time row's name instead.
  expect(clean(compareModifiedBlocks(Q_BASE, Q_PLAIN, [N_GET]))).toBe(false);
  expect(clean(compareModifiedBlocks(Q_BASE, Q_PLAIN, [linkName(UUID_A)]))).toBe(false);
});

it('[CT-06zzzzzv#12] the changed row as the file’s only change, declared: modifiedOnlyFiles leaves the file out, and evidence-check’s expected list is red-check’s (the new file alone); without the trusted entry both keep it', () => {
  const read = reader({ [F]: Q_BASE }, { [F]: Q_PLAIN, [NEW]: NEW_HEAD });
  expect(modifiedOnlyFiles([F], read, Q_LEDGER.modify_existing)).toEqual([
    { file: F, tests: [N_STEP] },
  ]);
  const files = [F, NEW];
  const left = ruleTestsLeftOut(files, read, Q_LEDGER);
  expect(left.expected).toEqual([NEW]);
  expect(left.modifiedLeftOut).toEqual([F]);
  const wanted = expectedRedFiles(files, read, Q_LEDGER, Q_LEDGER.modify_existing);
  expect(wanted).toEqual([NEW]);
  expect(sorted(expectedRedFiles(files, read, Q_LEDGER, []))).toEqual(sorted(files));
});

it('[CT-06zzzzzv#13] every form judged as a whole table: the declared row does not let the change through compareModifiedBlocks, the file is not left out, and red-check and evidence-check agree file for file', () => {
  // The control (#12).
  const q = reader({ [F]: Q_BASE }, { [F]: Q_PLAIN, [NEW]: NEW_HEAD });
  expect(expectedRedFiles([F, NEW], q, Q_LEDGER, Q_LEDGER.modify_existing)).toEqual([NEW]);
  expect(ALL_WHOLE.length).toBeGreaterThanOrEqual(11);
  const files = [F, NEW];
  for (const c of ALL_WHOLE) {
    const declared = c.ledger.modify_existing.map((d) => ('test' in d ? d.test : ''));
    expect(clean(compareModifiedBlocks(c.base, c.plain, declared)), c.name).toBe(false);
    const t = treesOf(c, c.plain);
    const read = reader(t.base, { ...t.head, [NEW]: NEW_HEAD });
    expect(modifiedOnlyFiles([F], read, c.ledger.modify_existing), c.name).toEqual([]);
    const wanted = expectedRedFiles(files, read, c.ledger, c.ledger.modify_existing);
    const red = ruleTestsLeftOut(files, read, c.ledger).expected;
    expect(sorted(wanted), c.name).toEqual(sorted(files));
    expect(sorted(wanted), c.name).toEqual(sorted(red));
  }
});

it('[CT-06zzzzzv#21] under the title with the body the changed row is located by its full name after the change (row text withdraw → phone_change), the file left out by both checks; by the base’s name it is not located, and both keep the file', () => {
  // By the name after the change.
  const compared = compareModifiedBlocks(B_BASE, B_PLAIN, [B_STEP_HEAD]);
  expect(clean(compared)).toBe(true);
  const block = compared.ok ? compared.blocks[0] : undefined;
  const before = block?.found === true ? block.before : '';
  const after = block?.found === true ? block.after : '';
  expect(before).toContain("action: 'withdraw'");
  expect(before).not.toContain('phone_change');
  expect(after).toContain("action: 'phone_change'");
  expect(after).not.toContain("'withdraw'");
  const read = reader({ [F]: B_BASE }, { [F]: B_PLAIN, [NEW]: NEW_HEAD });
  const files = [F, NEW];
  expect(modifiedOnlyFiles([F], read, B_LEDGER_HEAD.modify_existing)).toEqual([
    { file: F, tests: [B_STEP_HEAD] },
  ]);
  const left = ruleTestsLeftOut(files, read, B_LEDGER_HEAD);
  expect(left.expected).toEqual([NEW]);
  expect(left.modifiedLeftOut).toEqual([F]);
  expect(expectedRedFiles(files, read, B_LEDGER_HEAD, B_LEDGER_HEAD.modify_existing)).toEqual([
    NEW,
  ]);
  // By the base's name (or an unchanged / run-time row's): not located, the file kept by both.
  expect(clean(compareModifiedBlocks(B_BASE, B_PLAIN, [B_STEP_BASE]))).toBe(false);
  expect(clean(compareModifiedBlocks(B_BASE, B_PLAIN, [bLinkName(UUID_A)]))).toBe(false);
  expect(modifiedOnlyFiles([F], read, B_LEDGER_BASE.modify_existing)).toEqual([]);
  const kept = ruleTestsLeftOut(files, read, B_LEDGER_BASE).expected;
  const wanted = expectedRedFiles(files, read, B_LEDGER_BASE, B_LEDGER_BASE.modify_existing);
  expect(sorted(kept)).toEqual(sorted(files));
  expect(sorted(wanted)).toEqual(sorted(kept));
});
