// CT-06zzzzzv (FU-FOR-OF-LITERAL-TABLE-ROWS; orchestrator ruling D10-2152) rule-test kit. In-memory
// text fixtures only: no git, no process, no database, no port, no network.
//
// The one form compared row by row: a top-level `for (const x of [ … ])` over an inline array of
// literal rows (read as an `.each` table is), whose body is token for token the base's and makes
// one `it` per row (after B1-02zzzc's test/spec/risk/risk-state/http.int.test.ts [AC-B1-03h#17]).
// - A row whose text is the base's, character for character, is an unchanged test (exempt by
//   itself in a file compared test by test; declarable in red_exempt where declarations apply).
// - A changed row is declared row by row in modify_existing (`test` its expanded full name); its
//   row text before and after goes into the evidence. Undeclared, it must be red as before.
// - A row whose title holds a run-time value (`${randomUUID()}`: its full name cannot be told from
//   the row) is not known by name: only while its row text is unchanged, by its index in the table.
// Anything else is judged as before, the whole table changed: a table that is no inline literal
// (a const, a call), a row that is no literal (a name, a spread), a changed token of the loop body,
// rows added, removed or swapped, a changed run-time row, a loop that is not top-level or not
// for…of, a body that makes more than one `it` per row.
//
// This task adds no export: ruleTestsLeftOut, ruleTestBaselines, checkRedReports,
// modifiedOnlyFiles, compareModifiedBlocks and expectedRedFiles already exist and are the
// functions red-check and evidence-check call.
import type { BaselineReader, RedResult } from '../../../../tools/guard/lib/red-check.ts';
import {
  checkRedReports,
  ruleTestBaselines,
  ruleTestsLeftOut,
} from '../../../../tools/guard/lib/red-check.ts';
import type {
  ModifyExistingBlockDeclaration,
  RedExemptDeclaration,
  RedExemptOutsideDeclaration,
  TaskFile,
} from '../../../../tools/lib/task-file.ts';

export {
  checkRedReports,
  modifiedOnlyFiles,
  ruleTestBaselines,
  ruleTestsLeftOut,
} from '../../../../tools/guard/lib/red-check.ts';
export { compareModifiedBlocks } from '../../../../tools/guard/lib/test-blocks.ts';
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

export const RULING = 'D10-2152';
export const BR = 'BR-ID-31';

export const exemptOf = (file: string, test: string): RedExemptDeclaration => ({
  file,
  test,
  reason: 'unchanged frozen row of the whitelist table, green on the old code by construction',
});

export const outsideOf = (file: string): RedExemptOutsideDeclaration => ({
  file,
  reason: 'imports the step-up helper the new phone-change test of the file uses',
});

export const modifyOf = (file: string, test: string): ModifyExistingBlockDeclaration => ({
  file,
  test,
  reason: 'rule_change',
  ruling: RULING,
  note: 'the step-up row now asks for phone_change instead of withdraw (BR-ID-31 changed)',
  br: [BR],
});

// ---------------------------------------------------------------------------------------------
// The rule-test file (after B1-02zzzc's http.int.test.ts): a plain test, the table loop, and at
// the head (`added`) a new test of the task.

export const DIR = 'test/spec/risk/zzforof';
export const F = `${DIR}/http.int.test.ts`;
/** A new rule-test file of the task, next to F. */
export const NEW = `${DIR}/step-up-phone.int.test.ts`;

export const SUITE = 'a banned user';
export const T1 = '[AC-F#1] a whitelisted search is let through';
export const T_NEW = '[AC-B1-F#1] a banned user cannot step up for a phone change';

/** Table rows (raw text, as written inside the array). */
export const ROW_GET = "{ method: 'GET', path: '/v1/orders', body: {} }";
export const ROW_CONSENT =
  "{ method: 'POST', path: '/v1/consents', body: { type: 'privacy', accepted: false } }";
/** The row whose title holds a run-time value (its path is made with randomUUID()). */
export const ROW_LINK = `{ method: 'POST', path: \`/v1/links/\${randomUUID()}/open\`, body: {} }`;
/** ROW_LINK with its text changed. */
export const ROW_LINK_HEAD = ROW_LINK.replace('/open', '/visit');
export const ROW_STEP =
  "{ method: 'POST', path: '/v1/auth/step-up', body: { action: 'withdraw', code: '123456' } }";
/** ROW_STEP changed at the head (withdraw → phone_change; its title stays the same). */
export const ROW_STEP_HEAD =
  "{ method: 'POST', path: '/v1/auth/step-up', body: { action: 'phone_change', code: '123456' } }";
export const ROW_EXTRA = "{ method: 'DELETE', path: '/v1/me/sessions', body: {} }";

/** The full names the rows produce (the title template is TITLE_2 below). */
export const N_GET = '[AC-F#2] GET /v1/orders returns 10006';
export const N_CONSENT = '[AC-F#2] POST /v1/consents returns 10006';
export const N_STEP = '[AC-F#2] POST /v1/auth/step-up returns 10006';
export const N_EXTRA = '[AC-F#2] DELETE /v1/me/sessions returns 10006';
/** The run-time row's full name in one run (`uuid` the value randomUUID() gave). */
export const linkName = (uuid: string, verb: 'open' | 'visit' = 'open'): string =>
  `[AC-F#2] POST /v1/links/${uuid}/${verb} returns 10006`;
/** The second test per row of the two-its form. */
export const writesNoRow = (name: string): string =>
  name.replace('[AC-F#2]', '[AC-F#3]').replace(' returns 10006', ' writes no row');

/** Two values randomUUID() may give in two runs. */
export const UUID_A = '0193a6f2-5c1e-7d40-8b2a-3f9e1c7d4a01';
export const UUID_B = '0193a6f2-5c1e-7d40-8b2a-3f9e1c7d4a02';

const TITLE_2 = `[AC-F#2] \${route.method} \${route.path} returns 10006`;
const TITLE_3 = `[AC-F#3] \${route.method} \${route.path} writes no row`;
export const BODY = 'expect(await send(route.method, route.path, route.body)).toBe(10006);';
/** BODY with one token more (a changed loop body). */
export const BODY_CHANGED =
  "expect(await send(route.method, route.path, route.body, 'banned')).toBe(10006);";
const BODY_3 = 'expect(await written(route.path)).toEqual([]);';

/**
 * How the table loop is written: `for-of` the qualifying form; `const` / `call` a table by name or
 * from a call; 'describe' the loop inside a describe; `forEach` the array's forEach; `two-its` two
 * `it` per row.
 */
export type Form = 'for-of' | 'const' | 'call' | 'describe' | 'forEach' | 'two-its';

export type Shape = {
  rows: readonly string[];
  form?: Form;
  /** Lines between the imports and the first test (consts the rows name). */
  header?: readonly string[];
  /** The loop body's assertion line (BODY when absent). */
  body?: string;
  /** The step-up import inserted outside the tests. */
  stepUp?: boolean;
  /** T_NEW appended. */
  added?: boolean;
};

const itLines = (indent: string, title: string, body: string): string[] => [
  `${indent}it(\`${title}\`, async () => {`,
  `${indent}  ${body}`,
  `${indent}});`,
];

const rowLines = (rows: readonly string[], indent: string): string[] =>
  rows.map((r) => `${indent}${r},`);

function loopLines(shape: Shape): string[] {
  const body = shape.body ?? BODY;
  switch (shape.form ?? 'for-of') {
    case 'for-of':
      return [
        'for (const route of [',
        ...rowLines(shape.rows, '  '),
        ']) {',
        ...itLines('  ', TITLE_2, body),
        '}',
      ];
    case 'const':
      return [
        'const ROUTES = [',
        ...rowLines(shape.rows, '  '),
        '];',
        '',
        'for (const route of ROUTES) {',
        ...itLines('  ', TITLE_2, body),
        '}',
      ];
    case 'call':
      return [
        'function routes() {',
        '  return [',
        ...rowLines(shape.rows, '    '),
        '  ];',
        '}',
        '',
        'for (const route of routes()) {',
        ...itLines('  ', TITLE_2, body),
        '}',
      ];
    case 'describe':
      return [
        `${'describe'}('${SUITE}', () => {`,
        '  for (const route of [',
        ...rowLines(shape.rows, '    '),
        '  ]) {',
        ...itLines('    ', TITLE_2, body),
        '  }',
        '});',
      ];
    case 'forEach':
      return [
        '[',
        ...rowLines(shape.rows, '  '),
        '].forEach((route) => {',
        ...itLines('  ', TITLE_2, body),
        '});',
      ];
    case 'two-its':
      return [
        'for (const route of [',
        ...rowLines(shape.rows, '  '),
        ']) {',
        ...itLines('  ', TITLE_2, body),
        '',
        ...itLines('  ', TITLE_3, BODY_3),
        '}',
      ];
  }
}

/** The rule-test file of `shape`. */
export function testFile(shape: Shape): string {
  return [
    "import { randomUUID } from 'node:crypto';",
    "import { describe, expect, it } from 'vitest';",
    "import { send, written } from './kit.ts';",
    ...(shape.stepUp === true ? ["import { stepUp } from './step-up.ts';"] : []),
    '',
    ...(shape.header ?? []).flatMap((l) => [l, '']),
    `it('${T1}', async () => {`,
    "  expect(await send('GET', '/v1/search', undefined)).toBe(200);",
    '});',
    '',
    ...loopLines(shape),
    '',
    ...(shape.added === true
      ? [
          `it('${T_NEW}', async () => {`,
          "  expect(await send('POST', '/v1/auth/step-up', { action: 'phone_change' })).toBe(10006);",
          '});',
          '',
        ]
      : []),
  ].join('\n');
}

export const NEW_HEAD = [
  "import { expect, it } from 'vitest';",
  "import { send } from './kit.ts';",
  '',
  "it('[AC-B1-F#2] the phone change asks for a step-up', async () => {",
  "  expect(await send('POST', '/v1/me/phone', {})).toBe(10012);",
  '});',
  '',
].join('\n');

// ---------------------------------------------------------------------------------------------
// The qualifying form: ROW_STEP changed, every other row (ROW_LINK included) the base's.

export const BASE_ROWS = [ROW_GET, ROW_CONSENT, ROW_LINK, ROW_STEP] as const;
export const HEAD_ROWS = [ROW_GET, ROW_CONSENT, ROW_LINK, ROW_STEP_HEAD] as const;
/** The rows' full names at the head, in table order, in a run where randomUUID() gave `uuid`. */
export const headNames = (uuid: string): string[] => [N_GET, N_CONSENT, linkName(uuid), N_STEP];

export const Q_BASE = testFile({ rows: BASE_ROWS });
/** The head with the new test T_NEW. */
export const Q_HEAD = testFile({ rows: HEAD_ROWS, added: true });
/** The head without a new test: the changed row is the file's only change. */
export const Q_PLAIN = testFile({ rows: HEAD_ROWS });
/** The changed row declared in modify_existing, by its expanded full name. */
export const Q_LEDGER = ledger({ modify_existing: [modifyOf(F, N_STEP)] });
/** The report's tests at the head (T_NEW last), in a run where randomUUID() gave `uuid`. */
export const qTests = (uuid: string = UUID_A): string[] => [T1, ...headNames(uuid), T_NEW];

// ---------------------------------------------------------------------------------------------
// The forms still judged as a whole table (D10-2152 「照旧整表判 changed」).

export type WholeCase = {
  name: string;
  base: string;
  /** The head with T_NEW. */
  head: string;
  /** The head without T_NEW. */
  plain: string;
  /** The report's tests at the head (T1, the loop's tests, T_NEW), randomUUID() → UUID_A. */
  tests: string[];
  /** Rows whose text is the base's: no longer exempt once the whole table is changed. */
  unchanged: string[];
  /** The changed step-up row declared in modify_existing. */
  ledger: Ledger;
};

function wholeCase(
  name: string,
  base: Shape,
  head: Shape,
  loopTests: readonly string[],
  prefix = '',
): WholeCase {
  const p = (n: string): string => `${prefix}${n}`;
  return {
    name,
    base: testFile(base),
    head: testFile({ ...head, added: true }),
    plain: testFile(head),
    tests: [T1, ...loopTests.map(p), T_NEW],
    unchanged: [N_GET, N_CONSENT].map(p),
    ledger: ledger({ modify_existing: [modifyOf(F, p(N_STEP))] }),
  };
}

const LOOP = headNames(UUID_A);

/** 表不是内联字面量: a top-level const, the result of a call. */
export const NOT_INLINE: readonly WholeCase[] = [
  wholeCase(
    'the table is a top-level const (for (const route of ROUTES))',
    { form: 'const', rows: BASE_ROWS },
    { form: 'const', rows: HEAD_ROWS },
    LOOP,
  ),
  wholeCase(
    'the table is the result of a call (for (const route of routes()))',
    { form: 'call', rows: BASE_ROWS },
    { form: 'call', rows: HEAD_ROWS },
    LOOP,
  ),
];

/** 行里有非字面量: a row that is a name, a spread row. */
export const NON_LITERAL_ROW: readonly WholeCase[] = [
  wholeCase(
    'a row is a name (EXTRA)',
    { rows: [...BASE_ROWS, 'EXTRA'], header: [`const EXTRA = ${ROW_EXTRA};`] },
    { rows: [...HEAD_ROWS, 'EXTRA'], header: [`const EXTRA = ${ROW_EXTRA};`] },
    [...LOOP, N_EXTRA],
  ),
  wholeCase(
    'a row is a spread (...EXTRAS)',
    { rows: [...BASE_ROWS, '...EXTRAS'], header: [`const EXTRAS = [${ROW_EXTRA}];`] },
    { rows: [...HEAD_ROWS, '...EXTRAS'], header: [`const EXTRAS = [${ROW_EXTRA}];`] },
    [...LOOP, N_EXTRA],
  ),
];

/** 循环体任何 token 改了. */
export const BODY_CHANGED_CASE: WholeCase = wholeCase(
  'a token of the loop body changed',
  { rows: BASE_ROWS },
  { rows: HEAD_ROWS, body: BODY_CHANGED },
  LOOP,
);

/** 行有增删或换序. */
export const ROWS_MOVED: readonly WholeCase[] = [
  wholeCase('a row added at the end', { rows: BASE_ROWS }, { rows: [...HEAD_ROWS, ROW_EXTRA] }, [
    ...LOOP,
    N_EXTRA,
  ]),
  wholeCase(
    'a row removed (ROW_LINK)',
    { rows: BASE_ROWS },
    { rows: [ROW_GET, ROW_CONSENT, ROW_STEP_HEAD] },
    [N_GET, N_CONSENT, N_STEP],
  ),
  wholeCase(
    'two rows swapped (ROW_GET and ROW_CONSENT)',
    { rows: BASE_ROWS },
    { rows: [ROW_CONSENT, ROW_GET, ROW_LINK, ROW_STEP_HEAD] },
    [N_CONSENT, N_GET, linkName(UUID_A), N_STEP],
  ),
];

/** 含运行期值的行其行文本改了. */
export const RUNTIME_ROW_CHANGED: WholeCase = wholeCase(
  'the text of the run-time row changed (open → visit)',
  { rows: BASE_ROWS },
  { rows: [ROW_GET, ROW_CONSENT, ROW_LINK_HEAD, ROW_STEP_HEAD] },
  [N_GET, N_CONSENT, linkName(UUID_A, 'visit'), N_STEP],
);

/** for 不在顶层或不是 for…of, and a body that makes two `it` per row. */
export const OTHER_FORMS: readonly WholeCase[] = [
  wholeCase(
    'the loop inside a describe',
    { form: 'describe', rows: BASE_ROWS },
    { form: 'describe', rows: HEAD_ROWS },
    LOOP,
    `${SUITE} > `,
  ),
  wholeCase(
    'the array’s forEach instead of for…of',
    { form: 'forEach', rows: BASE_ROWS },
    { form: 'forEach', rows: HEAD_ROWS },
    LOOP,
  ),
  wholeCase(
    'two it per row',
    { form: 'two-its', rows: BASE_ROWS },
    { form: 'two-its', rows: HEAD_ROWS },
    LOOP.flatMap((n) => [n, writesNoRow(n)]),
  ),
];

export const ALL_WHOLE: readonly WholeCase[] = [
  ...NOT_INLINE,
  ...NON_LITERAL_ROW,
  BODY_CHANGED_CASE,
  ...ROWS_MOVED,
  RUNTIME_ROW_CHANGED,
  ...OTHER_FORMS,
];

// ---------------------------------------------------------------------------------------------
// The red run (the trusted red reporter's shape, after tools/guard/lib/red-check.test.ts).

export const ROOT = '/work/repo';
export const RED_CAUSE = { name: 'AssertionError', message: 'expected 200 to be 10006' };
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

/** F's outcomes: every test in `tests` green except those in `red`. */
export function outcomesOf(
  tests: readonly string[],
  red: readonly string[] = [T_NEW],
): Record<string, readonly Outcome[]> {
  return { [F]: tests.map((t): Outcome => [t, red.includes(t) ? 'failed' : 'passed']) };
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
  const baselines = ruleTestBaselines(
    left.expected,
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
    Object.entries(outcomes).filter(([file]) => left.expected.includes(file)),
  );
  const result = checkRedReports(
    [report(ran)],
    left.expected,
    ROOT,
    baselines,
    l.red_exempt,
    l.red_exempt_rows,
    l.modify_existing,
    left.modifiedLeftOut,
  );
  return { expected: left.expected, result };
}

/** F alone, base `base`, head `head`, judged with `l` and the outcomes of `tests`. */
export function judgeF(
  base: string,
  head: string,
  l: Ledger,
  tests: readonly string[],
  red: readonly string[] = [T_NEW],
): { expected: string[]; result: RedResult } {
  return judge([F], reader({ [F]: base }, { [F]: head }), l, outcomesOf(tests, red));
}
