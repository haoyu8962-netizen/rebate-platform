// CT-06zzzzzr (D10-2120 ① / D10-2125) (A): a rule-test file with both kinds of declared change —
// outside the tests covered by red_exempt_outside or a support entry, inside the tests only
// declared modify_existing blocks, every other test unchanged and red_exempt — is left out of the
// expected list with a note; one test more that is neither, a new, removed or moved test, or an
// uncovered change outside the tests keeps it expected and judged as before.
import { expect, it } from 'vitest';
import {
  B1,
  B2,
  B2_ALT,
  B3,
  KEPT,
  LEFT_OUT,
  MIX,
  MIX_BASE,
  MIX_HEAD,
  MIX_LEDGER,
  MOD,
  NEW,
  NEW_HEAD,
  OUT,
  T1,
  T2,
  T3,
  T4,
  T5,
  T_NEW,
  exemptOf,
  judge,
  ledger,
  mixedOf,
  mixedOnlyNote,
  modifiedOnlyFiles,
  modifiedOnlyNote,
  modifyOf,
  outsideOf,
  outsideOnlyFiles,
  outsideOnlyNote,
  reader,
  redRun,
  ruleTestBaselines,
  ruleTestsLeftOut,
  testFile,
} from './kit.ts';

const caseOf = (name: string) => {
  const c = KEPT.find((k) => k.name.startsWith(name));
  if (c === undefined) throw new Error(`fixture: no case "${name}"`);
  return c;
};

// --- mixedOnlyFiles ---

it('[CT-06zzzzzr#1] the B1-02zzzb (A) shape — an import inserted outside the tests (red_exempt_outside), T2 a declared changed modify_existing block, T1 / T3 unchanged and red_exempt — is left out; neither outsideOnlyFiles nor modifiedOnlyFiles leaves it out alone', () => {
  const read = reader({ [MIX]: MIX_BASE }, { [MIX]: MIX_HEAD });
  const l = MIX_LEDGER;
  expect(outsideOnlyFiles([MIX], read, [], [], l.red_exempt_outside, l.red_exempt)).toEqual([]);
  expect(modifiedOnlyFiles([MIX], read, l.modify_existing)).toEqual([]);
  const left = mixedOf([MIX], read, l);
  expect(left).toHaveLength(1);
  expect(left[0]).toMatchObject({ file: MIX, tests: [T2], exempt: 2 });
  expect(left[0]?.lines).not.toBe('');
});

it('[CT-06zzzzzr#2] the change outside the tests may be covered by red_exempt_outside, by a modify_existing scope: support entry of the file, or by both', () => {
  expect(LEFT_OUT.length).toBeGreaterThanOrEqual(3);
  for (const c of LEFT_OUT) {
    const left = mixedOf([MIX], reader(c.base, c.head), c.ledger);
    expect(
      left.map((r) => [r.file, r.tests]),
      c.name,
    ).toEqual([[MIX, [T2]]]);
  }
});

it('[CT-06zzzzzr#3] anything else keeps the file expected: an undeclared unchanged test, a new, removed or moved test, an uncovered change outside the tests, a changed test declared red_exempt only, a changed block not declared, a redundant or dangling modify_existing entry', () => {
  expect(KEPT.length).toBeGreaterThanOrEqual(11);
  for (const c of KEPT) {
    const read = reader(c.base, c.head);
    expect(mixedOf([MIX], read, c.ledger), c.name).toEqual([]);
    expect(ruleTestsLeftOut([MIX], read, c.ledger).expected, c.name).toEqual([MIX]);
  }
});

it('[CT-06zzzzzr#4] a file that did not exist at the base, or is not listed by any declaration, is never left out', () => {
  const read = reader({ [MIX]: MIX_BASE }, { [MIX]: MIX_HEAD, [NEW]: NEW_HEAD });
  expect(mixedOf([NEW], read, MIX_LEDGER)).toEqual([]);
  expect(mixedOf([MIX, NEW], read, ledger())).toEqual([]);
  expect(mixedOf([MIX, NEW], read, MIX_LEDGER).map((r) => r.file)).toEqual([MIX]);
});

// --- the note and the expected list ---

it('[CT-06zzzzzr#5] the note names the file, its declared blocks, that it is not run and not judged, and what evidence-check still requires (red_exempt_confirmed, modify_existing)', () => {
  const read = reader({ [MIX]: MIX_BASE }, { [MIX]: MIX_HEAD });
  const [r] = mixedOf([MIX], read, MIX_LEDGER);
  expect(r).toBeDefined();
  const note = r === undefined ? '' : mixedOnlyNote(r);
  for (const part of [MIX, T2, 'not run, not judged', 'red_exempt_confirmed', 'modify_existing']) {
    expect(note, part).toContain(part);
  }
  const left = ruleTestsLeftOut([MIX], read, MIX_LEDGER);
  expect(left.expected).toEqual([]);
  expect(left.notes.filter((n) => n.includes(MIX))).toEqual([note]);
  expect(left.modifiedLeftOut).toEqual([MIX]);
});

it('[CT-06zzzzzr#6] next to a new rule-test file the red run is the new file’s alone: the mixed file is not run, its modify_existing entry is not redundant, the verdict is ok', () => {
  const read = reader({ [MIX]: MIX_BASE }, { [MIX]: MIX_HEAD, [NEW]: NEW_HEAD });
  const outcomes = {
    [MIX]: [
      [T1, 'passed'],
      [T2, 'passed'],
      [T3, 'passed'],
    ] as const,
    [NEW]: [[T_NEW, 'failed']] as const,
  };
  const { expected, result } = judge([MIX, NEW], read, MIX_LEDGER, outcomes);
  expect(expected).toEqual([NEW]);
  expect(result.problems).toEqual([]);
  expect(result.ok).toBe(true);
  expect(result.red).toEqual([`${NEW} > ${T_NEW}`]);
  expect(result.problems.some((p) => p.file === MIX)).toBe(false);
  // Today's verdict for the same run with the mixed file expected: nothing shown red.
  const today = redRun([MIX, NEW], read, MIX_LEDGER, outcomes);
  expect(today.problems.map((p) => p.file)).toContain(MIX);
});

it('[CT-06zzzzzr#7] the order outsideOnlyFiles → modifiedOnlyFiles → mixedOnlyFiles: each file left out gets its own note once, and only the new file is expected', () => {
  const base = {
    [MIX]: MIX_BASE,
    [OUT]: MIX_BASE,
    [MOD]: MIX_BASE,
  };
  const head = {
    [MIX]: MIX_HEAD,
    [OUT]: testFile([B1, B2, B3], true),
    [MOD]: testFile([B1, B2_ALT, B3], false),
    [NEW]: NEW_HEAD,
  };
  const read = reader(base, head);
  const l = ledger({
    red_exempt_outside: [outsideOf(MIX), outsideOf(OUT)],
    red_exempt: [
      exemptOf(MIX, T1),
      exemptOf(MIX, T3),
      exemptOf(OUT, T1),
      exemptOf(OUT, T2),
      exemptOf(OUT, T3),
    ],
    modify_existing: [modifyOf(MIX, T2), modifyOf(MOD, T2)],
  });
  const files = [MIX, MOD, NEW, OUT];
  const left = ruleTestsLeftOut(files, read, l);
  expect(left.expected).toEqual([NEW]);
  expect([...left.modifiedLeftOut].sort()).toEqual([MIX, MOD].sort());
  const out = outsideOnlyFiles(files, read, [], [], l.red_exempt_outside, l.red_exempt);
  const mod = modifiedOnlyFiles(files, read, l.modify_existing);
  const mix = mixedOf(files, read, l);
  expect(out.map((r) => r.file)).toEqual([OUT]);
  expect(mod.map((r) => r.file)).toEqual([MOD]);
  expect(mix.map((r) => r.file)).toEqual([MIX]);
  const want = [
    ...out.map(outsideOnlyNote),
    ...mod.map(modifiedOnlyNote),
    ...mix.map(mixedOnlyNote),
  ];
  expect([...left.notes].sort()).toEqual([...want].sort());
});

// --- what should be red is still red (D10-2125 ②) ---

it('[CT-06zzzzzr#8] one more unchanged test (T4) that is neither red_exempt nor modify_existing: the file stays expected and T4 green is a problem', () => {
  const c = caseOf('an unchanged test (T4)');
  const read = reader(c.base, c.head);
  const { expected, result } = judge([MIX], read, c.ledger, {
    [MIX]: [
      [T1, 'passed'],
      [T2, 'passed'],
      [T3, 'passed'],
      [T4, 'passed'],
    ],
  });
  expect(expected).toEqual([MIX]);
  expect(result.ok).toBe(false);
  expect(result.problems).toContainEqual({
    file: MIX,
    test: T4,
    reason: expect.stringMatching(/green on the skeleton/),
  });
  expect(result.problems.some((p) => p.test === T1 || p.test === T2 || p.test === T3)).toBe(false);
});

it('[CT-06zzzzzr#9] a new test (T5) next to the declared ones: the file stays expected; T5 red passes, T5 green is a problem', () => {
  const c = caseOf('a new test (T5)');
  const read = reader(c.base, c.head);
  const run = (status: 'passed' | 'failed') =>
    judge([MIX], read, c.ledger, {
      [MIX]: [
        [T1, 'passed'],
        [T2, 'passed'],
        [T3, 'passed'],
        [T5, status],
      ],
    });
  const red = run('failed');
  expect(red.expected).toEqual([MIX]);
  expect(red.result.problems).toEqual([]);
  expect(red.result.ok).toBe(true);
  expect(red.result.red).toEqual([`${MIX} > ${T5}`]);
  const green = run('passed');
  expect(green.expected).toEqual([MIX]);
  expect(green.result.ok).toBe(false);
  expect(green.result.problems).toContainEqual({
    file: MIX,
    test: T5,
    reason: expect.stringMatching(/green on the skeleton/),
  });
});

it('[CT-06zzzzzr#10] the change outside the tests covered by neither red_exempt_outside nor a support entry: the file stays expected and is judged as a whole (every test must be red)', () => {
  const c = caseOf('the change outside the tests covered by neither');
  const read = reader(c.base, c.head);
  expect(mixedOf([MIX], read, c.ledger)).toEqual([]);
  const baselines = ruleTestBaselines(
    [MIX],
    [],
    [],
    read,
    [],
    [],
    [],
    [],
    c.ledger.modify_existing,
  );
  expect(baselines.get(MIX)?.kind).toBe('whole');
  const { expected, result } = judge([MIX], read, c.ledger, {
    [MIX]: [
      [T1, 'passed'],
      [T2, 'passed'],
      [T3, 'passed'],
    ],
  });
  expect(expected).toEqual([MIX]);
  expect(result.ok).toBe(false);
  for (const t of [T1, T3]) {
    expect(
      result.problems.some((p) => p.file === MIX && p.test === t),
      t,
    ).toBe(true);
  }
});
