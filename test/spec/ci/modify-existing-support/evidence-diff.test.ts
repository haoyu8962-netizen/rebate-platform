// CT-06zzzzzi (D10-1662) 新条目 2: what a support entry lets through. Its file's differences
// outside the it blocks pass, unless a changed line (removed at the base or added at the head)
// holds an assertion call: expect( / expectTypeOf( / assert( / assert.<name>( / .to<Upper…>( /
// .rejects / .resolves, whitespace allowed between the parts; the refusal names the file and the
// line. A changed block still needs its own block entry. A file without a support entry is judged
// exactly as before.
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  BASE_FILES,
  HELPER_ASSERTING,
  HELPER_TEST,
  OMIT,
  type Repo,
  SLOW,
  SUPPORT,
  SUPPORT_BASE,
  SUPPORT_HEAD,
  T1,
  T1_BASE,
  T1_HEAD,
  T2,
  T2_BASE,
  T2_HEAD,
  assertionProblem,
  block,
  blockRecord,
  branch,
  check,
  cleanup,
  helperTest,
  ledger,
  lineOf,
  makeRepo,
  problemsOf,
  support,
  supportRecord,
  supportWith,
  trusted,
} from './kit.ts';

let repo: Repo;
beforeAll(() => {
  repo = makeRepo('diff');
});
afterAll(cleanup);

/** A branch changing SUPPORT to `head`, with its (correct) support record. */
const supportBranch = (name: string, head: string): string =>
  branch(repo, name, { [SUPPORT]: head }, [supportRecord(SUPPORT, SUPPORT_BASE, head)]);

it(
  '[CT-06zzzzzi#19] an added line outside the blocks holding an assertion call is refused, naming the file and the line; other added lines pass',
  () => {
    const dir = trusted('added', ledger([support(SUPPORT)]));
    // Lines that only look alike: no assertion call (expected =, asserted =, toTotal( without a dot).
    const plain = supportWith('  const expected = userId;\n  const asserted = toTotal(expected);');
    expect(check(repo, supportBranch('added-plain', plain), dir).problems).toEqual([]);
    const forms = [
      '  expect(userId);',
      '  expect (userId);',
      '  expectTypeOf(userId);',
      '  assert(userId);',
      '  assert.equal(userId, 1);',
      '  assert . ok (userId);',
      '  userId.toBe(1);',
      '  userId.toEqual(1);',
      '  userId . toEqual (1);',
      '  userId.toStrictEqual(1);',
      '  userId.toThrow();',
      '  userId.toMatchObject({});',
      '  userId.toHaveBeenCalledWith(1);',
      '  void userId.rejects;',
      '  void userId . resolves;',
      '  void userId.resolves;',
    ];
    for (const form of forms) {
      const head = supportWith(form);
      const line = lineOf(head, form);
      expect(line, form).toBeGreaterThan(18);
      const report = check(repo, supportBranch(`added-${forms.indexOf(form)}`, head), dir);
      expect(report.ok, form).toBe(false);
      expect(
        assertionProblem(report, SUPPORT, [line]),
        `${form}\n${problemsOf(report)}`,
      ).toBeDefined();
    }
  },
  SLOW,
);

it(
  '[CT-06zzzzzi#20] a removed or changed assertion line outside the blocks is refused, naming the file and the line',
  () => {
    const dir = trusted('removed', ledger([support(SUPPORT)]));
    const rejects = "  await expect(call()).rejects.toThrow('STEP_UP_REQUIRED');";
    const toBe = "    .toBe('withdraw:100');";
    const cases: [string, string, number[]][] = [
      // Replaced in place: the base line and the head line have the same number.
      [
        'assertion replaced',
        SUPPORT_BASE.replace(rejects, '  await call();'),
        [lineOf(SUPPORT_BASE, rejects)],
      ],
      [
        'expected value changed',
        SUPPORT_BASE.replace(toBe, "    .toBe('withdraw:200');"),
        [lineOf(SUPPORT_BASE, toBe)],
      ],
      // The whole helper removed: the assertion lines are gone (base lines).
      [
        'helper removed',
        SUPPORT_BASE.replace(
          "export function expectSummary(token: { summary?: string }) {\n  expect(token.summary)\n    .toBe('withdraw:100');\n}\n",
          '',
        ),
        [lineOf(SUPPORT_BASE, '  expect(token.summary)'), lineOf(SUPPORT_BASE, toBe)],
      ],
    ];
    for (const [name, head, lines] of cases) {
      expect(head, name).not.toBe(SUPPORT_BASE);
      const report = check(repo, supportBranch(`removed-${name.replace(/ /g, '-')}`, head), dir);
      expect(report.ok, name).toBe(false);
      expect(
        assertionProblem(report, SUPPORT, lines),
        `${name}\n${problemsOf(report)}`,
      ).toBeDefined();
    }
  },
  SLOW,
);

it(
  '[CT-06zzzzzi#21] in a test file, a support entry covers the top-level code only: an assertion added to a helper is refused, a changed block needs its own block entry',
  () => {
    const supportOnly = trusted('helper-support', ledger([support(HELPER_TEST)]));
    // An assertion added to the top-level helper.
    const asserting = helperTest({ helper: HELPER_ASSERTING });
    const line = lineOf(asserting, '  expect(amount).toBeGreaterThan(-1);');
    const a = check(
      repo,
      branch(repo, 'helper-assert', { [HELPER_TEST]: asserting }, [
        supportRecord(HELPER_TEST, BASE_FILES[HELPER_TEST] ?? '', asserting),
      ]),
      supportOnly,
    );
    expect(a.ok).toBe(false);
    expect(assertionProblem(a, HELPER_TEST, [line]), problemsOf(a)).toBeDefined();
    // The helper changed without an assertion and block 2 changed: no block entry for block 2.
    const changed = helperTest({ summary: true, t2: T2_HEAD });
    const b = check(
      repo,
      branch(repo, 'helper-block', { [HELPER_TEST]: changed }, [
        supportRecord(HELPER_TEST, BASE_FILES[HELPER_TEST] ?? '', changed),
      ]),
      supportOnly,
    );
    expect(b.ok).toBe(false);
    const named = b.problems.find((p) => p.includes(HELPER_TEST) && p.includes(T2));
    expect(named, problemsOf(b)).toBeDefined();
    expect(named).toMatch(/not declared|undeclared|outside the declared blocks/);
    // Block 2 declared, block 1 changed too: block 1 is named.
    const both = trusted('helper-both', ledger([support(HELPER_TEST), block(HELPER_TEST, T2)]));
    const twoBlocks = helperTest({ summary: true, t1: T1_HEAD, t2: T2_HEAD });
    const c = check(
      repo,
      branch(repo, 'helper-two-blocks', { [HELPER_TEST]: twoBlocks }, [
        supportRecord(HELPER_TEST, BASE_FILES[HELPER_TEST] ?? '', twoBlocks),
        blockRecord(HELPER_TEST, T2, T2_BASE, T2_HEAD),
      ]),
      both,
    );
    expect(c.ok).toBe(false);
    const one = c.problems.find((p) => p.includes(HELPER_TEST) && p.includes(T1));
    expect(one, problemsOf(c)).toBeDefined();
    expect(one).toMatch(/not declared|undeclared|outside the declared blocks/);
    // The positive control: the same change with block 1 unchanged passes.
    const fine = helperTest({ summary: true, t1: T1_BASE, t2: T2_HEAD });
    const d = check(
      repo,
      branch(repo, 'helper-fine', { [HELPER_TEST]: fine }, [
        supportRecord(HELPER_TEST, BASE_FILES[HELPER_TEST] ?? '', fine),
        blockRecord(HELPER_TEST, T2, T2_BASE, T2_HEAD),
      ]),
      both,
    );
    expect(d.problems).toEqual([]);
  },
  SLOW,
);

it(
  '[CT-06zzzzzi#22] without a support entry nothing changes: a fixture change is refused, a block entry still covers only its block, and a block change alone still passes',
  () => {
    // No modify_existing at all: the fixture change after spec_commit is refused as before.
    const none = trusted('regress-none', ledger(null));
    const plain = check(
      repo,
      branch(repo, 'regress-none', { [SUPPORT]: SUPPORT_HEAD }, OMIT),
      none,
    );
    expect(plain.ok).toBe(false);
    expect(plain.approval_wanted).toBe(false);
    expect(problemsOf(plain)).toContain('rule tests changed after the rule-test commit:');
    expect(problemsOf(plain)).toContain(`${SUPPORT} (M)`);
    // Block entries only.
    const blocks = trusted('regress-blocks', ledger([block(HELPER_TEST, T2)]));
    const record = [blockRecord(HELPER_TEST, T2, T2_BASE, T2_HEAD)];
    const onlyBlock = branch(
      repo,
      'regress-block',
      { [HELPER_TEST]: helperTest({ t2: T2_HEAD }) },
      record,
    );
    expect(check(repo, onlyBlock, blocks).problems).toEqual([]);
    const withHelper = branch(
      repo,
      'regress-helper',
      { [HELPER_TEST]: helperTest({ summary: true, t2: T2_HEAD }) },
      record,
    );
    const outside = check(repo, withHelper, blocks);
    expect(outside.ok).toBe(false);
    expect(problemsOf(outside)).toMatch(
      /apply\.int\.test\.ts \(M\) \[declared in modify_existing, but changed outside the declared blocks/,
    );
    // A fixture without an entry next to a declared block: the fixture is refused.
    const fixture = branch(
      repo,
      'regress-fixture',
      { [HELPER_TEST]: helperTest({ t2: T2_HEAD }), [SUPPORT]: SUPPORT_HEAD },
      record,
    );
    const f = check(repo, fixture, blocks);
    expect(f.ok).toBe(false);
    expect(problemsOf(f)).toContain(`${SUPPORT} (M)`);
  },
  SLOW,
);
