// CT-06zzzzzi (D10-1662) 新条目 3: red-check does not treat a support entry as a test to run; it
// does not change the red verdict, and the notes list each support file on a line of its own with
// `scope: support` (as red_exempt_outside files are listed). The ledger is read by parseTaskFile,
// so the entries are exactly what red-check gets from the trusted ledger.
import { expect, it } from 'vitest';
import { checkRedReports } from '../../../../tools/guard/lib/red-check.ts';
import {
  HELPER_TEST,
  MONEY_KIT,
  ROOT,
  SUPPORT,
  T2,
  block,
  ledger,
  parse,
  redReport,
  support,
} from './kit.ts';

const NEW = 'test/spec/identity/step-up-digest/digest.test.ts';
const NEW_TEST = '[AC-B1-02zzzb#1] the step-up token binds the summary';
const RED = 'AssertionError: expected undefined to be "withdraw:100"';
const task = (entries: Parameters<typeof ledger>[0]) =>
  parse(
    ledger(entries, {
      tester: 'codex',
      paths: ['apps/api/src/modules/identity/**'],
      testPaths: ['test/spec/identity/step-up-digest/**'],
    }),
  );
const run = (t: ReturnType<typeof task>, status: 'failed' | 'passed') =>
  checkRedReports(
    [redReport(NEW, [status === 'failed' ? [NEW_TEST, status, RED] : [NEW_TEST, status]])],
    [NEW],
    ROOT,
    new Map(),
    t.red_exempt,
    t.red_exempt_rows,
    t.modify_existing,
  );

it('[CT-06zzzzzi#23] support entries are not tests of the red run: the verdict is the new test’s, and each support file is listed on its own line with scope: support', () => {
  const t = task([support(SUPPORT), support(MONEY_KIT)]);
  const result = run(t, 'failed');
  expect(result.problems).toEqual([]);
  expect(result.ok).toBe(true);
  expect(result.red).toEqual([`${NEW} > ${NEW_TEST}`]);
  expect(result.exempt?.some((e) => e.file === SUPPORT || e.file === MONEY_KIT)).toBe(false);
  for (const file of [SUPPORT, MONEY_KIT]) {
    const lines = result.notes.filter((n) => n.includes(file) && n.includes('scope: support'));
    expect(lines, `${file}\n${result.notes.join('\n')}`).toHaveLength(1);
  }
  expect(result.notes.some((n) => n.includes(SUPPORT) && n.includes(MONEY_KIT))).toBe(false);
});

it('[CT-06zzzzzi#24] a support entry does not let a green new test pass, and is not itself a problem', () => {
  const result = run(task([support(SUPPORT)]), 'passed');
  expect(result.ok).toBe(false);
  expect(result.problems.some((p) => p.file === NEW && p.test === NEW_TEST)).toBe(true);
  expect(result.problems.some((p) => p.file === SUPPORT)).toBe(false);
});

it('[CT-06zzzzzi#25] next to a support entry, a block entry of a file that is not expected is still redundant', () => {
  const result = run(task([support(SUPPORT), block(HELPER_TEST, T2)]), 'failed');
  expect(result.ok).toBe(false);
  expect(result.problems).toHaveLength(1);
  expect(result.problems[0]).toMatchObject({ file: HELPER_TEST, test: T2 });
  expect(result.problems[0]?.reason).toMatch(/redundant/);
});

it('[CT-06zzzzzi#26] without support entries red-check is unchanged: a block entry of a file that is not expected is redundant', () => {
  const result = run(task([block(HELPER_TEST, T2)]), 'failed');
  expect(result.ok).toBe(false);
  expect(result.problems).toEqual([
    {
      file: HELPER_TEST,
      test: T2,
      reason: expect.stringMatching(/not an expected rule-test file .*redundant/),
    },
  ]);
  expect(result.red).toEqual([`${NEW} > ${NEW_TEST}`]);
});
