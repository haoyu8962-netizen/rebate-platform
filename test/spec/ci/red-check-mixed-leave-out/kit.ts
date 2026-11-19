// CT-06zzzzzr (FU-RED-CHECK-MIXED-LEAVE-OUT; orchestrator rulings D10-2120 ①, D10-2125) rule-test
// kit. In-memory text fixtures only: no git, no process, no database, no port, no network.
//
// (A) A rule-test file that existed at the base is left out of the expected list (not run, not
//     judged, one note) when, at once: its changes outside the tests are covered (red_exempt_outside
//     or a modify_existing `scope: support` entry of the file); every changed block is a declared
//     modify_existing block, found and changed; every other test is unchanged and declared in
//     red_exempt; no test is added, removed or moved. red-check and evidence-check call the same
//     functions, so evidence-check no longer wants a red test of such a file. Anything else is
//     judged as before.
// (B) A modify_existing `.each` / `.for` block whose table is one name imported from a same-
//     directory test-support file (`./<name>.ts`) that exports it at its top level as
//     `export const NAME = [ literals ]` (`as const` or not) is expanded row by row, the base from
//     the base's kit, the head from the head's. A table from another directory, re-exported, not a
//     const, the result of a call or with a non-literal row still cannot be expanded.
//
// The exports this task adds (skeletons throw NotImplemented until implemented):
//   tools/guard/lib/red-check.ts   MixedOnly, mixedOnlyFiles, mixedOnlyNote,
//                                  LeftOutRuleTests, ruleTestsLeftOut
//   tools/ci/evidence-check.ts     expectedRedFiles
// (B) adds no export: modifiedOnlyFiles and ruleTestBaselines already get a reader of the base and
// the head, through which the kit of each side is read.
import type { BaselineReader, RedResult } from '../../../../tools/guard/lib/red-check.ts';
import {
  checkRedReports,
  mixedOnlyFiles,
  ruleTestBaselines,
  ruleTestsLeftOut,
} from '../../../../tools/guard/lib/red-check.ts';
import type {
  ModifyExistingBlockDeclaration,
  ModifyExistingSupportDeclaration,
  RedExemptDeclaration,
  RedExemptOutsideDeclaration,
  TaskFile,
} from '../../../../tools/lib/task-file.ts';

export {
  type LeftOutRuleTests,
  type MixedOnly,
  checkRedReports,
  mixedOnlyFiles,
  mixedOnlyNote,
  modifiedOnlyFiles,
  modifiedOnlyNote,
  outsideOnlyFiles,
  outsideOnlyNote,
  ruleTestBaselines,
  ruleTestsLeftOut,
} from '../../../../tools/guard/lib/red-check.ts';
export { expectedRedFiles } from '../../../../tools/ci/evidence-check.ts';

// ---------------------------------------------------------------------------------------------
// Readers and ledgers.

/** Repository path → content on one side (a path that is not a key does not exist there). */
export type Tree = Record<string, string>;

/** A reader of the base and the head trees. */
export function reader(base: Tree, head: Tree): BaselineReader {
  return {
    base: (p) => base[p] ?? null,
    head: (p) => head[p] ?? null,
  };
}

/** The parts of the trusted ledger the red run reads. */
export type Ledger = Pick<
  TaskFile,
  | 'renames'
  | 'expected_values'
  | 'red_exempt_outside'
  | 'red_exempt'
  | 'red_exempt_rows'
  | 'modify_existing'
>;

export function ledger(parts: Partial<Ledger> = {}): Ledger {
  return {
    renames: [],
    expected_values: [],
    red_exempt_outside: [],
    red_exempt: [],
    red_exempt_rows: [],
    modify_existing: [],
    ...parts,
  };
}

export const RULING = 'D10-2125';
export const BR = 'BR-ID-08';

export const outsideOf = (file: string): RedExemptOutsideDeclaration => ({
  file,
  reason: 'imports the step-up token the rewritten bind test sends',
});

export const exemptOf = (file: string, test: string): RedExemptDeclaration => ({
  file,
  test,
  reason: 'unchanged frozen test, green on the old code by construction',
});

export const modifyOf = (file: string, test: string): ModifyExistingBlockDeclaration => ({
  file,
  test,
  reason: 'rule_change',
  ruling: RULING,
  note: 'the bind now carries the step-up token (BR-ID-08 changed)',
  br: [BR],
});

export const supportOf = (file: string): ModifyExistingSupportDeclaration => ({
  file,
  scope: 'support',
  reason: 'rule_change',
  ruling: RULING,
  note: 'the file imports the step-up token helper; no assertion changes outside the tests',
  br: [BR],
});

// ---------------------------------------------------------------------------------------------
// (A) The mixed file and its neighbours (after B1-02zzzb's payout-account/concurrency.int.test.ts:
// an import inserted outside the tests, one declared block rewritten, the other tests unchanged).

export const DIR = 'test/spec/identity/zzmix';
export const MIX = `${DIR}/concurrency.int.test.ts`;
/** Changed outside the tests only, every test unchanged and declared (outsideOnlyFiles). */
export const OUT = `${DIR}/outside-only.int.test.ts`;
/** Changed in a declared block only (modifiedOnlyFiles). */
export const MOD = `${DIR}/modified-only.int.test.ts`;
/** A new rule-test file of the task. */
export const NEW = `${DIR}/step-up-bind.int.test.ts`;

export const T1 = '[AC-M#1] keeps one payout account per user';
export const T2 = '[AC-M#2] refuses a concurrent second bind';
export const T3 = '[AC-M#3] writes one audit row per bind';
export const T4 = '[AC-M#4] unbinds on account deletion';
export const T5 = '[AC-M#5] binds after the step-up';
export const T_NEW = '[AC-B1-02zzzb#1] the step-up token binds the payout account';

const block = (title: string, body: string): string =>
  `it('${title}', async () => {\n  ${body}\n});`;

export const B1 = block(T1, 'expect(await seed(1)).toBe(1);');
export const B2 = block(T2, "expect(await bind(2)).toBe('refused');");
/** T2 rewritten: it sends the step-up token (the declared modify_existing block). */
export const B2_HEAD = block(T2, "expect(await bind(2, await stepUp())).toBe('refused');");
/** T2 rewritten differently (the modified-only file). */
export const B2_ALT = block(T2, "expect(await bind(2, 'second')).toBe('refused');");
export const B3 = block(T3, 'expect(await seed(3)).toBe(3);');
/** T3 changed (not declared in modify_existing). */
export const B3_HEAD = block(T3, 'expect(await seed(3)).toBe(4);');
export const B4 = block(T4, 'expect(await seed(4)).toBe(4);');
export const B5 = block(T5, "expect(await bind(5, await stepUp())).toBe('bound');");

export const IMPORTS =
  "import { expect, it } from 'vitest';\nimport { bind, seed } from './kit.ts';";
/** The line inserted outside the tests: an import declaration with a binding of a new name. */
export const IMPORT_STEP_UP = "import { stepUp } from './step-up.ts';";

/** A rule-test file: the imports (with the step-up import when `stepUp`), then the blocks. */
export function testFile(blocks: readonly string[], stepUp: boolean): string {
  return [IMPORTS, ...(stepUp ? [IMPORT_STEP_UP] : []), '', ...blocks.flatMap((b) => [b, ''])].join(
    '\n',
  );
}

export const MIX_BASE = testFile([B1, B2, B3], false);
export const MIX_HEAD = testFile([B1, B2_HEAD, B3], true);

export const NEW_HEAD = [
  "import { expect, it } from 'vitest';",
  "import { bind } from './kit.ts';",
  '',
  block(T_NEW, "expect(await bind(9, 'token')).toBe('bound');"),
  '',
].join('\n');

/** The mixed file's ledger: listed in red_exempt_outside, T1 / T3 exempt, T2 modify_existing. */
export const MIX_LEDGER = ledger({
  red_exempt_outside: [outsideOf(MIX)],
  red_exempt: [exemptOf(MIX, T1), exemptOf(MIX, T3)],
  modify_existing: [modifyOf(MIX, T2)],
});

/** One scenario of the mixed file: its base, its head and the trusted ledger. */
export type Case = { name: string; base: Tree; head: Tree; ledger: Ledger };

const mixCase = (name: string, head: string, l: Ledger = MIX_LEDGER, base = MIX_BASE): Case => ({
  name,
  base: { [MIX]: base },
  head: { [MIX]: head },
  ledger: l,
});

/** Scenarios in which the mixed file is left out of the expected list. */
export const LEFT_OUT: readonly Case[] = [
  mixCase('covered by red_exempt_outside', MIX_HEAD),
  mixCase(
    'covered by a modify_existing scope: support entry of the file',
    MIX_HEAD,
    ledger({
      red_exempt: [exemptOf(MIX, T1), exemptOf(MIX, T3)],
      modify_existing: [supportOf(MIX), modifyOf(MIX, T2)],
    }),
  ),
  mixCase(
    'covered by both',
    MIX_HEAD,
    ledger({
      red_exempt_outside: [outsideOf(MIX)],
      red_exempt: [exemptOf(MIX, T1), exemptOf(MIX, T3)],
      modify_existing: [supportOf(MIX), modifyOf(MIX, T2)],
    }),
  ),
];

/** Scenarios in which the mixed file stays expected and is judged as before. */
export const KEPT: readonly Case[] = [
  mixCase(
    'an unchanged test (T4) neither red_exempt nor modify_existing',
    testFile([B1, B2_HEAD, B3, B4], true),
    MIX_LEDGER,
    testFile([B1, B2, B3, B4], false),
  ),
  mixCase('a new test (T5)', testFile([B1, B2_HEAD, B3, B5], true)),
  mixCase(
    'the change outside the tests covered by neither red_exempt_outside nor a support entry',
    MIX_HEAD,
    ledger({
      red_exempt: [exemptOf(MIX, T1), exemptOf(MIX, T3)],
      modify_existing: [modifyOf(MIX, T2)],
    }),
  ),
  mixCase(
    'a test removed (T3)',
    testFile([B1, B2_HEAD], true),
    ledger({
      red_exempt_outside: [outsideOf(MIX)],
      red_exempt: [exemptOf(MIX, T1)],
      modify_existing: [modifyOf(MIX, T2)],
    }),
  ),
  mixCase('two tests swapped (T1 and T3 moved)', testFile([B3, B2_HEAD, B1], true)),
  mixCase('a changed test (T3) declared red_exempt only', testFile([B1, B2_HEAD, B3_HEAD], true)),
  mixCase(
    'the changed block (T2) not declared in modify_existing',
    MIX_HEAD,
    ledger({
      red_exempt_outside: [outsideOf(MIX)],
      red_exempt: [exemptOf(MIX, T1), exemptOf(MIX, T3)],
    }),
  ),
  mixCase(
    'a modify_existing entry (T1) whose block is the base’s',
    MIX_HEAD,
    ledger({
      red_exempt_outside: [outsideOf(MIX)],
      red_exempt: [exemptOf(MIX, T3)],
      modify_existing: [modifyOf(MIX, T2), modifyOf(MIX, T1)],
    }),
  ),
  mixCase(
    'a modify_existing entry naming no test',
    MIX_HEAD,
    ledger({
      red_exempt_outside: [outsideOf(MIX)],
      red_exempt: [exemptOf(MIX, T1), exemptOf(MIX, T3)],
      modify_existing: [modifyOf(MIX, T2), modifyOf(MIX, '[AC-M#9] no such test')],
    }),
  ),
];

/** mixedOnlyFiles with the parts of `l` it takes. */
export function mixedOf(
  files: readonly string[],
  read: BaselineReader,
  l: Ledger,
): ReturnType<typeof mixedOnlyFiles> {
  return mixedOnlyFiles(
    files,
    read,
    l.renames,
    l.expected_values,
    l.red_exempt_outside,
    l.red_exempt,
    l.modify_existing,
  );
}

// ---------------------------------------------------------------------------------------------
// The red run (the trusted red reporter's shape, after tools/guard/lib/red-check.test.ts).

export const ROOT = '/work/repo';
export const RED_CAUSE = { name: 'AssertionError', message: "expected undefined to be 'bound'" };
export type Outcome = readonly [name: string, status: 'passed' | 'failed'];

/** One red reporter report of the given files and their tests. */
export function report(files: Readonly<Record<string, readonly Outcome[]>>): unknown {
  return {
    reporter: 'couli-red-reporter',
    testResults: Object.entries(files).map(([file, tests]) => ({
      name: `${ROOT}/${file}`,
      status: tests.some(([, s]) => s === 'failed') ? 'failed' : 'passed',
      message: '',
      failures: [],
      assertionResults: tests.map(([fullName, status]) => ({
        fullName,
        title: fullName,
        status,
        failureMessages: status === 'failed' ? [`${RED_CAUSE.name}: ${RED_CAUSE.message}`] : [],
        failures: status === 'failed' ? [{ causes: [RED_CAUSE] }] : [],
      })),
    })),
  };
}

/**
 * The red run as red-check runs it: the expected list after ruleTestsLeftOut, the baselines of
 * what is left, a report of the expected files only (their outcomes from `outcomes`).
 */
export function judge(
  files: readonly string[],
  read: BaselineReader,
  l: Ledger,
  outcomes: Readonly<Record<string, readonly Outcome[]>>,
): { expected: string[]; result: RedResult } {
  const left = ruleTestsLeftOut(files, read, l);
  const result = redRun(left.expected, read, l, outcomes, left.modifiedLeftOut);
  return { expected: left.expected, result };
}

/** checkRedReports on `expected` with the baselines ruleTestBaselines gives for `l`. */
export function redRun(
  expected: readonly string[],
  read: BaselineReader,
  l: Ledger,
  outcomes: Readonly<Record<string, readonly Outcome[]>>,
  modifiedLeftOut: readonly string[] = [],
): RedResult {
  const baselines = ruleTestBaselines(
    expected,
    [],
    [],
    read,
    l.renames,
    l.expected_values,
    l.red_exempt_outside,
    l.red_exempt_rows,
    l.modify_existing,
  );
  const ran = Object.fromEntries(
    Object.entries(outcomes).filter(([file]) => expected.includes(file)),
  );
  return checkRedReports(
    [report(ran)],
    expected,
    ROOT,
    baselines,
    l.red_exempt,
    l.red_exempt_rows,
    l.modify_existing,
    modifiedLeftOut,
  );
}

// ---------------------------------------------------------------------------------------------
// (B) An `.each` table imported from a same-directory kit (after B1-02zzzb's
// step-up-bound-phone/sms.int.test.ts: `it.each(ACTIONS)`, ACTIONS exported by ./kit.ts).

export const BDIR = 'test/spec/identity/zzbound';
export const SMS = `${BDIR}/sms.int.test.ts`;
export const SMS_KIT = `${BDIR}/kit.ts`;
/** A test-support file in a sibling directory. */
export const OTHER_KIT = 'test/spec/identity/zzother/kit.ts';
/** A module the same-directory kit re-exports from. */
export const ACTIONS_MODULE = `${BDIR}/actions.ts`;

export const ACTIONS_DECL =
  "export const ACTIONS = ['payout_account_change', 'phone_change'] as const;";
export const ACTIONS_BARE = "export const ACTIONS = ['payout_account_change', 'phone_change'];";

/** The kit: `before` lines, the ACTIONS line, then a helper. */
export function smsKit(decl: string = ACTIONS_DECL, before: readonly string[] = []): string {
  return [
    ...before,
    decl,
    '',
    'export function send(action: string, token?: string) {',
    '  return { action, token };',
    '}',
    '',
  ].join('\n');
}

export const SMS_IMPORT = "import { ACTIONS, send } from './kit.ts';";
export const S1 = '[AC-S#1] sends a login code';
export const S2_TITLE = '[AC-S#2] %s needs a bound phone';
export const S2_ROWS = [
  '[AC-S#2] payout_account_change needs a bound phone',
  '[AC-S#2] phone_change needs a bound phone',
] as const;
export const S3 = '[AC-B1-02zzzb#2] the code request carries the step-up token';

/**
 * The sms rule-test file: a plain test, then `it.each(ACTIONS)`; at the head (`head`) the shared
 * callback sends the step-up token; `added` appends a new test.
 */
export function smsFile(
  opts: { importLine?: string; head?: boolean; added?: boolean } = {},
): string {
  const body =
    opts.head === true
      ? "  expect(send(action, 'step-up').token).toBe('step-up');"
      : '  expect(send(action).action).toBe(action);';
  return [
    "import { expect, it } from 'vitest';",
    opts.importLine ?? SMS_IMPORT,
    '',
    `it('${S1}', () => {`,
    "  expect(send('login').action).toBe('login');",
    '});',
    '',
    `it.each(ACTIONS)('${S2_TITLE}', (action) => {`,
    body,
    '});',
    '',
    ...(opts.added === true
      ? [
          `it('${S3}', () => {`,
          "  expect(send('withdraw', 'step-up').token).toBe('step-up');",
          '});',
          '',
        ]
      : []),
  ].join('\n');
}

/** Every row of the table declared in modify_existing (the shared callback changed). */
export const SMS_LEDGER = ledger({ modify_existing: S2_ROWS.map((t) => modifyOf(SMS, t)) });

/** The sms red run: S1 and the rows green, S3 (when added) red. */
export function smsOutcomes(added: boolean): Record<string, readonly Outcome[]> {
  return {
    [SMS]: [
      [S1, 'passed'],
      ...S2_ROWS.map((t): Outcome => [t, 'passed']),
      ...(added ? [[S3, 'failed'] as const] : []),
    ],
  };
}
