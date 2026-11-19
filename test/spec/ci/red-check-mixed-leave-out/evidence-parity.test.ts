// CT-06zzzzzr (D10-2125) (A): evidence-check wants a red test of exactly the files red-check runs
// (the same functions, the same order); a file red-check leaves out by mixedOnlyFiles is no longer
// required to show a red test. The modify_existing entries come from the trusted ledger only.
import { expect, it } from 'vitest';
import {
  KEPT,
  LEFT_OUT,
  MIX,
  MIX_BASE,
  MIX_HEAD,
  MIX_LEDGER,
  NEW,
  NEW_HEAD,
  expectedRedFiles,
  reader,
  ruleTestsLeftOut,
} from './kit.ts';

const sorted = (list: readonly string[]): string[] => [...list].sort();

it('[CT-06zzzzzr#11] evidence-check no longer wants a red test of the mixed file: its expected list is red-check’s, file for file', () => {
  const read = reader({ [MIX]: MIX_BASE }, { [MIX]: MIX_HEAD, [NEW]: NEW_HEAD });
  const files = [MIX, NEW];
  const wanted = expectedRedFiles(files, read, MIX_LEDGER, MIX_LEDGER.modify_existing);
  expect(wanted).toEqual([NEW]);
  expect(sorted(wanted)).toEqual(sorted(ruleTestsLeftOut(files, read, MIX_LEDGER).expected));
});

it('[CT-06zzzzzr#12] red-check and evidence-check agree on every scenario: left out (red_exempt_outside, support entry, both) and kept (judged as before)', () => {
  const files = [MIX, NEW];
  for (const c of LEFT_OUT) {
    const read = reader(c.base, { ...c.head, [NEW]: NEW_HEAD });
    const wanted = expectedRedFiles(files, read, c.ledger, c.ledger.modify_existing);
    const red = ruleTestsLeftOut(files, read, c.ledger).expected;
    expect(wanted, c.name).toEqual([NEW]);
    expect(sorted(wanted), c.name).toEqual(sorted(red));
  }
  for (const c of KEPT) {
    const read = reader(c.base, { ...c.head, [NEW]: NEW_HEAD });
    const wanted = expectedRedFiles(files, read, c.ledger, c.ledger.modify_existing);
    const red = ruleTestsLeftOut(files, read, c.ledger).expected;
    expect(sorted(wanted), c.name).toEqual(sorted(files));
    expect(sorted(wanted), c.name).toEqual(sorted(red));
  }
});

it('[CT-06zzzzzr#13] without the trusted ledger’s modify_existing entries (a ledger the PR head adds) evidence-check leaves the mixed file in', () => {
  const read = reader({ [MIX]: MIX_BASE }, { [MIX]: MIX_HEAD, [NEW]: NEW_HEAD });
  const files = [MIX, NEW];
  expect(expectedRedFiles(files, read, MIX_LEDGER, MIX_LEDGER.modify_existing)).toEqual([NEW]);
  expect(sorted(expectedRedFiles(files, read, MIX_LEDGER, []))).toEqual(sorted(files));
});
