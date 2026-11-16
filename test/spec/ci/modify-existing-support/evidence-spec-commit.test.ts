// CT-06zzzzzi (D10-1662) round 2, review-claude-1 S1-1: the rule-test author changes a support
// file in the rule-test commit (base..spec_commit), the usual flow of a task with a rule-test
// author. A support entry's file is judged from the merge base to the head, the two ends of its
// sha256 record: an assertion line outside the blocks changed or removed in the rule-test commit is
// refused naming the file and the line, and a block changed there still needs its own block entry.
// Data changes outside the blocks in that commit pass. The fixture's spec_commit is not the base.
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  BASE_FILES,
  HELPER_TEST,
  type Repo,
  SLOW,
  SUPPORT,
  SUPPORT_BASE,
  SUPPORT_HEAD,
  T1,
  T1_HEAD,
  T2,
  T2_BASE,
  T2_HEAD,
  assertionProblem,
  block,
  blockRecord,
  branchVia,
  check,
  cleanup,
  helperTest,
  ledger,
  lineOf,
  makeRepo,
  problemsOf,
  support,
  supportRecord,
  trusted,
} from './kit.ts';

let repo: Repo;
beforeAll(() => {
  repo = makeRepo('spec-commit');
});
afterAll(cleanup);

/**
 * The data change of SUPPORT_HEAD (stepUpToken gets the step-up summary, tokens only inserted),
 * applicable to any variant.
 */
const DATA_FROM =
  "export function stepUpToken(userId: string) {\n  return { userId, purpose: 'payout' };";
const DATA_TO =
  "export function stepUpToken(userId: string, stepUp?: string) {\n  return { userId, purpose: 'payout', stepUp };";
const withData = (text: string): string => {
  if (!text.includes(DATA_FROM)) throw new Error('fixture: data anchor missing');
  return text.replace(DATA_FROM, DATA_TO);
};

const REJECTS = "  await expect(call()).rejects.toThrow('STEP_UP_REQUIRED');";
const TO_BE = "    .toBe('withdraw:100');";
const SUMMARY_HELPER =
  "export function expectSummary(token: { summary?: string }) {\n  expect(token.summary)\n    .toBe('withdraw:100');\n}\n";
const HELPER_BASE = BASE_FILES[HELPER_TEST] ?? '';

it(
  '[CT-06zzzzzi#27] an assertion line outside the blocks removed or changed in the rule-test commit (spec_commit after the base) is refused, naming the file and the line',
  () => {
    expect(withData(SUPPORT_BASE)).toBe(SUPPORT_HEAD);
    const dir = trusted('spec-assert', ledger([support(SUPPORT)]));
    // [name, the file at the rule-test commit, the file at the head, lines one of which is named]
    const cases: [string, string, string, number[]][] = [
      [
        'assertion replaced in the rule-test commit',
        SUPPORT_BASE.replace(REJECTS, '  await call();'),
        SUPPORT_BASE.replace(REJECTS, '  await call();'),
        [lineOf(SUPPORT_BASE, REJECTS)],
      ],
      [
        'expected value changed in the rule-test commit',
        SUPPORT_BASE.replace(TO_BE, "    .toBe('withdraw:200');"),
        SUPPORT_BASE.replace(TO_BE, "    .toBe('withdraw:200');"),
        [lineOf(SUPPORT_BASE, TO_BE)],
      ],
      [
        'asserting helper removed in the rule-test commit',
        SUPPORT_BASE.replace(SUMMARY_HELPER, ''),
        SUPPORT_BASE.replace(SUMMARY_HELPER, ''),
        [lineOf(SUPPORT_BASE, '  expect(token.summary)'), lineOf(SUPPORT_BASE, TO_BE)],
      ],
      // The rule-test commit changes the assertion, a later commit only data: spec_commit → head
      // holds no assertion line, merge base → head does.
      [
        'expected value changed in the rule-test commit, data changed after it',
        SUPPORT_BASE.replace(TO_BE, "    .toBe('withdraw:200');"),
        withData(SUPPORT_BASE.replace(TO_BE, "    .toBe('withdraw:200');")),
        [lineOf(SUPPORT_BASE, TO_BE)],
      ],
    ];
    for (const [name, specText, headText, lines] of cases) {
      expect(specText, name).not.toBe(SUPPORT_BASE);
      const later = headText === specText ? {} : { [SUPPORT]: headText };
      const { head, spec } = branchVia(
        repo,
        `spec-assert-${cases.findIndex((c) => c[0] === name)}`,
        { [SUPPORT]: specText },
        later,
        [supportRecord(SUPPORT, SUPPORT_BASE, headText)],
      );
      expect(spec, name).not.toBe(repo.base);
      const report = check(repo, head, dir);
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
  '[CT-06zzzzzi#28] a block changed in the rule-test commit (spec_commit after the base) without its own block entry is refused, naming the block',
  () => {
    const supportOnly = trusted('spec-block', ledger([support(HELPER_TEST)]));
    // Helper and block 2 changed in the rule-test commit, nothing after it.
    const changed = helperTest({ summary: true, t2: T2_HEAD });
    const a = branchVia(repo, 'spec-block-a', { [HELPER_TEST]: changed }, {}, [
      supportRecord(HELPER_TEST, HELPER_BASE, changed),
    ]);
    expect(a.spec).not.toBe(repo.base);
    const ra = check(repo, a.head, supportOnly);
    expect(ra.ok).toBe(false);
    const na = ra.problems.find((p) => p.includes(T2));
    expect(na, problemsOf(ra)).toBeDefined();
    expect(na).toMatch(/not declared|undeclared|outside the declared blocks/);
    expect(problemsOf(ra)).toContain(HELPER_TEST);
    // Block 2 changed in the rule-test commit, the helper only after it.
    const blockOnly = helperTest({ t2: T2_HEAD });
    const b = branchVia(
      repo,
      'spec-block-b',
      { [HELPER_TEST]: blockOnly },
      { [HELPER_TEST]: changed },
      [supportRecord(HELPER_TEST, HELPER_BASE, changed)],
    );
    const rb = check(repo, b.head, supportOnly);
    expect(rb.ok).toBe(false);
    const nb = rb.problems.find((p) => p.includes(T2));
    expect(nb, problemsOf(rb)).toBeDefined();
    expect(nb).toMatch(/not declared|undeclared|outside the declared blocks/);
    expect(problemsOf(rb)).toContain(HELPER_TEST);
    // Block 2 declared, block 1 changed too in the rule-test commit: block 1 is named.
    const both = trusted('spec-block-both', ledger([support(HELPER_TEST), block(HELPER_TEST, T2)]));
    const twoBlocks = helperTest({ summary: true, t1: T1_HEAD, t2: T2_HEAD });
    const c = branchVia(repo, 'spec-block-c', { [HELPER_TEST]: twoBlocks }, {}, [
      supportRecord(HELPER_TEST, HELPER_BASE, twoBlocks),
      blockRecord(HELPER_TEST, T2, T2_BASE, T2_HEAD),
    ]);
    const rc = check(repo, c.head, both);
    expect(rc.ok).toBe(false);
    const nc = rc.problems.find((p) => p.includes(T1));
    expect(nc, problemsOf(rc)).toBeDefined();
    expect(nc).toMatch(/not declared|undeclared|outside the declared blocks/);
    expect(problemsOf(rc)).toContain(HELPER_TEST);
  },
  SLOW,
);

it(
  '[CT-06zzzzzi#29] data changes outside the blocks in the rule-test commit (spec_commit after the base) pass, with a declared block changed there too',
  () => {
    const dir = trusted('spec-data', ledger([support(SUPPORT)]));
    // Data changed in the rule-test commit only.
    const a = branchVia(repo, 'spec-data-a', { [SUPPORT]: SUPPORT_HEAD }, {}, [
      supportRecord(SUPPORT, SUPPORT_BASE, SUPPORT_HEAD),
    ]);
    expect(a.spec).not.toBe(repo.base);
    expect(check(repo, a.head, dir).problems).toEqual([]);
    // Data changed in the rule-test commit and again after it.
    const more = `${SUPPORT_HEAD}export const SUMMARY = 'withdraw:100';\n`;
    const b = branchVia(repo, 'spec-data-b', { [SUPPORT]: SUPPORT_HEAD }, { [SUPPORT]: more }, [
      supportRecord(SUPPORT, SUPPORT_BASE, more),
    ]);
    expect(check(repo, b.head, dir).problems).toEqual([]);
    // A test file: the helper and the declared block 2 changed in the rule-test commit.
    const both = trusted('spec-data-both', ledger([support(HELPER_TEST), block(HELPER_TEST, T2)]));
    const changed = helperTest({ summary: true, t2: T2_HEAD });
    const records = [
      supportRecord(HELPER_TEST, HELPER_BASE, changed),
      blockRecord(HELPER_TEST, T2, T2_BASE, T2_HEAD),
    ];
    const c = branchVia(repo, 'spec-data-c', { [HELPER_TEST]: changed }, {}, records);
    expect(check(repo, c.head, both).problems).toEqual([]);
    // The declared block in the rule-test commit, the helper after it.
    const d = branchVia(
      repo,
      'spec-data-d',
      { [HELPER_TEST]: helperTest({ t2: T2_HEAD }) },
      { [HELPER_TEST]: changed },
      records,
    );
    expect(check(repo, d.head, both).problems).toEqual([]);
  },
  SLOW,
);
