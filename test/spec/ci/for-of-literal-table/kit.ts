// CT-06zzzzzv (FU-FOR-OF-LITERAL-TABLE-ROWS; orchestrator ruling D10-2152 as revised by D10-2163)
// rule-test kit. In-memory text fixtures only: no git, no process, no database, no port, no network.
//
// The one form compared row by row: a top-level `for (const x of [ … ])` over an inline array
// literal (the table itself no name, import or call result), as many rows as the base in the same
// order, whose body is token for token the base's and makes one `it` per row (after B1-02zzzc's
// test/spec/risk/risk-state/http.int.test.ts [AC-B1-03h#17]). Rows are judged by their source text:
// - A row whose text is the base's at the same index, character for character, is an unchanged
//   test, whether its fields are literals or not (`path: SEARCH` imported from the kit,
//   `` `/v1/links/${randomUUID()}/open` ``): taken by its index (exempt by itself in a file compared
//   test by test; declarable in red_exempt where declarations apply). A row whose full name cannot
//   be told from the row (a run-time value in its title) can only be taken so.
// - A changed row must be literal throughout (its title told from the row), exist at the same index
//   in the base with a different text, and be declared row by row in modify_existing, `test` its
//   full name AFTER the change (a title such as `${JSON.stringify(route.body)}` follows the row; the
//   base's name is not taken, no retitle_to); its row text before and after goes into the evidence.
//   Undeclared (or declared by the base's name), it must be red as before.
// - A changed row's new full name that another row or another test of the file also has: whole.
// Anything else is judged as before, the whole table changed: a table that is no inline literal
// (a local const, a table imported from the same-directory kit, a call), a spread in the table, a
// changed row with a non-literal field, a changed token of the loop body, rows added, removed or
// swapped, a row declared changed that has no row at its index in the base or whose text is the
// base's, a duplicated full name, a loop that is not top-level or not for…of (inside a describe,
// for…in, forEach), a body that makes more than one `it` per row.
//
// This task adds no export: ruleTestsLeftOut, ruleTestBaselines, checkRedReports,
// modifiedOnlyFiles, compareModifiedBlocks and expectedRedFiles already exist and are the
// functions red-check and evidence-check call.
import type { BaselineReader, RedResult } from '../../../../tools/guard/lib/red-check.ts';
import type { Change } from '../../../../tools/lib/git.ts';
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
/** A row with a non-literal field: SEARCH imported from the same-directory kit (D10-2163). */
export const ROW_SEARCH = "{ method: 'GET', path: SEARCH, body: undefined }";
/** ROW_SEARCH changed at the head (still non-literal: path: SEARCH). */
export const ROW_SEARCH_HEAD = "{ method: 'GET', path: SEARCH, body: { q: 'phone' } }";
/** ROW_STEP changed so that its full name is ROW_GET's (N_GET). */
export const ROW_STEP_AS_GET =
  "{ method: 'GET', path: '/v1/orders', body: { action: 'phone_change', code: '123456' } }";
/** ROW_STEP changed so that its full name is the plain test N_ME's. */
export const ROW_STEP_AS_ME =
  "{ method: 'PUT', path: '/v1/me', body: { action: 'phone_change', code: '123456' } }";

/** The full names the rows produce (the title template is TITLE_2 below). */
export const N_GET = '[AC-F#2] GET /v1/orders returns 10006';
export const N_CONSENT = '[AC-F#2] POST /v1/consents returns 10006';
export const N_STEP = '[AC-F#2] POST /v1/auth/step-up returns 10006';
export const N_EXTRA = '[AC-F#2] DELETE /v1/me/sessions returns 10006';
/** ROW_SEARCH's full name (SEARCH is '/v1/search' in the kit; not told from the row). */
export const N_SEARCH = '[AC-F#2] GET /v1/search returns 10006';
/** A plain test of the file whose name the template also makes for ROW_STEP_AS_ME. */
export const N_ME = '[AC-F#2] PUT /v1/me returns 10006';
/** The run-time row's full name in one run (`uuid` the value randomUUID() gave). */
export const linkName = (uuid: string, verb: 'open' | 'visit' = 'open'): string =>
  `[AC-F#2] POST /v1/links/${uuid}/${verb} returns 10006`;
/** The for…in loop's test of index `i` (its title made from the key). */
export const rowName = (i: number): string => `[AC-F#2] row ${String(i)} returns 10006`;

/**
 * The full name of a row under the title with the body (TITLE_BODY, as B1-02zzzc writes it:
 * `${route.method} ${route.path} ${JSON.stringify(route.body)}`): it follows the row's data.
 */
export const bodyName = (method: string, path: string, body: unknown): string =>
  `[AC-F#2] ${method} ${path} ${JSON.stringify(body)} returns 10006`;
export const B_GET = bodyName('GET', '/v1/orders', {});
export const B_CONSENT = bodyName('POST', '/v1/consents', { type: 'privacy', accepted: false });
export const bLinkName = (uuid: string): string => bodyName('POST', `/v1/links/${uuid}/open`, {});
/** ROW_STEP's full name at the base (withdraw) … */
export const B_STEP_BASE = bodyName('POST', '/v1/auth/step-up', {
  action: 'withdraw',
  code: '123456',
});
/** … and ROW_STEP_HEAD's at the head (phone_change): the name changes with the row. */
export const B_STEP_HEAD = bodyName('POST', '/v1/auth/step-up', {
  action: 'phone_change',
  code: '123456',
});
/** The second test per row of the two-its form. */
export const writesNoRow = (name: string): string =>
  name.replace('[AC-F#2]', '[AC-F#3]').replace(' returns 10006', ' writes no row');

/** Two values randomUUID() may give in two runs. */
export const UUID_A = '0193a6f2-5c1e-7d40-8b2a-3f9e1c7d4a01';
export const UUID_B = '0193a6f2-5c1e-7d40-8b2a-3f9e1c7d4a02';

const TITLE_2 = `[AC-F#2] \${route.method} \${route.path} returns 10006`;
const TITLE_3 = `[AC-F#3] \${route.method} \${route.path} writes no row`;
const TITLE_BODY = `[AC-F#2] \${route.method} \${route.path} \${JSON.stringify(route.body)} returns 10006`;
const TITLE_IN = `[AC-F#2] row \${k} returns 10006`;
const BODY_IN = 'expect(await send(k)).toBe(10006);';
export const BODY = 'expect(await send(route.method, route.path, route.body)).toBe(10006);';
/** BODY with one token more (a changed loop body). */
export const BODY_CHANGED =
  "expect(await send(route.method, route.path, route.body, 'banned')).toBe(10006);";
const BODY_3 = 'expect(await written(route.path)).toEqual([]);';

/**
 * How the table loop is written: `for-of` the qualifying form; `const` / `call` a table by name or
 * from a call; `kit` a table imported from the same-directory kit (`for (const route of ROUTES)`,
 * the rows in kitFile); 'describe' the loop inside a describe; `forEach` the array's forEach;
 * `for-in` for…in over the inline array (its title made from the key); `two-its` two `it` per row.
 */
export type Form =
  'for-of' | 'const' | 'call' | 'kit' | 'describe' | 'forEach' | 'for-in' | 'two-its';

export type Shape = {
  rows: readonly string[];
  form?: Form;
  /** The loop's title: `plain` (method and path, the default) or `body` (TITLE_BODY). */
  title?: 'plain' | 'body';
  /** Names imported from ./kit.ts besides send and written (SEARCH). */
  kitImports?: readonly string[];
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
  const title = shape.title === 'body' ? TITLE_BODY : TITLE_2;
  switch (shape.form ?? 'for-of') {
    case 'for-of':
      return [
        'for (const route of [',
        ...rowLines(shape.rows, '  '),
        ']) {',
        ...itLines('  ', title, body),
        '}',
      ];
    case 'const':
      return [
        'const ROUTES = [',
        ...rowLines(shape.rows, '  '),
        '];',
        '',
        'for (const route of ROUTES) {',
        ...itLines('  ', title, body),
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
        ...itLines('  ', title, body),
        '}',
      ];
    case 'kit':
      return ['for (const route of ROUTES) {', ...itLines('  ', title, body), '}'];
    case 'describe':
      return [
        `${'describe'}('${SUITE}', () => {`,
        '  for (const route of [',
        ...rowLines(shape.rows, '    '),
        '  ]) {',
        ...itLines('    ', title, body),
        '  }',
        '});',
      ];
    case 'forEach':
      return [
        '[',
        ...rowLines(shape.rows, '  '),
        '].forEach((route) => {',
        ...itLines('  ', title, body),
        '});',
      ];
    case 'for-in':
      return [
        'for (const k in [',
        ...rowLines(shape.rows, '  '),
        ']) {',
        ...itLines('  ', TITLE_IN, BODY_IN),
        '}',
      ];
    case 'two-its':
      return [
        'for (const route of [',
        ...rowLines(shape.rows, '  '),
        ']) {',
        ...itLines('  ', title, body),
        '',
        ...itLines('  ', TITLE_3, BODY_3),
        '}',
      ];
  }
}

/** The rule-test file of `shape`. */
export function testFile(shape: Shape): string {
  const fromKit = [
    ...(shape.kitImports ?? []),
    ...(shape.form === 'kit' ? ['ROUTES'] : []),
    'send',
    'written',
  ];
  return [
    "import { randomUUID } from 'node:crypto';",
    "import { describe, expect, it } from 'vitest';",
    `import { ${fromKit.join(', ')} } from './kit.ts';`,
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

/** The same-directory kit F imports from. */
export const KIT = `${DIR}/kit.ts`;

/** The kit's text: SEARCH always, `export const ROUTES = [ rows ]` when `rows` is given. */
export function kitFile(rows?: readonly string[]): string {
  return [
    "import { randomUUID } from 'node:crypto';",
    '',
    "export const SEARCH = '/v1/search';",
    '',
    ...(rows === undefined ? [] : ['export const ROUTES = [', ...rowLines(rows, '  '), '];', '']),
  ].join('\n');
}

/** A plain test named N_ME, as one header entry. */
export const IT_ME = [
  `it('${N_ME}', async () => {`,
  "  expect(await send('PUT', '/v1/me', {})).toBe(10006);",
  '});',
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

/**
 * The qualifying form under the title with the body (D10-2163 ①): the changed row's full name
 * changes with it (B_STEP_BASE → B_STEP_HEAD).
 */
export const B_BASE = testFile({ rows: BASE_ROWS, title: 'body' });
export const B_HEAD = testFile({ rows: HEAD_ROWS, title: 'body', added: true });
export const B_PLAIN = testFile({ rows: HEAD_ROWS, title: 'body' });
/** The changed row declared by its full name after the change … */
export const B_LEDGER_HEAD = ledger({ modify_existing: [modifyOf(F, B_STEP_HEAD)] });
/** … and by the base's name (not taken). */
export const B_LEDGER_BASE = ledger({ modify_existing: [modifyOf(F, B_STEP_BASE)] });
export const bTests = (uuid: string = UUID_A): string[] => [
  T1,
  B_GET,
  B_CONSENT,
  bLinkName(uuid),
  B_STEP_HEAD,
  T_NEW,
];

/**
 * The qualifying form with rows holding non-literal fields (D10-2163 ②): ROW_SEARCH (SEARCH from
 * the kit) and ROW_LINK unchanged at their indexes, ROW_STEP changed and declared (Q_LEDGER).
 */
export const NL_BASE_ROWS = [ROW_GET, ROW_SEARCH, ROW_CONSENT, ROW_LINK, ROW_STEP] as const;
export const NL_HEAD_ROWS = [ROW_GET, ROW_SEARCH, ROW_CONSENT, ROW_LINK, ROW_STEP_HEAD] as const;
export const NL_BASE = testFile({ rows: NL_BASE_ROWS, kitImports: ['SEARCH'] });
export const NL_HEAD = testFile({ rows: NL_HEAD_ROWS, kitImports: ['SEARCH'], added: true });
export const nlTests = (uuid: string = UUID_A): string[] => [
  T1,
  N_GET,
  N_SEARCH,
  N_CONSENT,
  linkName(uuid),
  N_STEP,
  T_NEW,
];

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
  /** The changed row(s) declared in modify_existing (the step-up row unless said otherwise). */
  ledger: Ledger;
  /** The same-directory kit KIT at the base and at the head, when the case has one. */
  kit?: { base: string; head: string };
};

/** What a case changes from the defaults (the step-up row declared, GET and consent unchanged). */
type CaseOptions = {
  /** Full names declared in modify_existing (default: the step-up row's). */
  declared?: readonly string[];
  /** The unchanged tests that must be problems (default: GET's and consent's). */
  unchanged?: readonly string[];
  /** Tests of the file before T1 (header tests). */
  before?: readonly string[];
  kit?: { base: string; head: string };
};

function wholeCase(
  name: string,
  base: Shape,
  head: Shape,
  loopTests: readonly string[],
  prefix = '',
  o: CaseOptions = {},
): WholeCase {
  const p = (n: string): string => `${prefix}${n}`;
  return {
    name,
    base: testFile(base),
    head: testFile({ ...head, added: true }),
    plain: testFile(head),
    tests: [...(o.before ?? []), T1, ...loopTests.map(p), T_NEW],
    unchanged: [...(o.unchanged ?? [N_GET, N_CONSENT].map(p))],
    ledger: ledger({
      modify_existing: (o.declared ?? [p(N_STEP)]).map((n) => modifyOf(F, n)),
    }),
    ...(o.kit === undefined ? {} : { kit: o.kit }),
  };
}

/** The base and head trees of a case (F, and its kit when it has one); `head` F's head text. */
export function treesOf(c: WholeCase, head: string = c.head): { base: Tree; head: Tree } {
  return {
    base: { [F]: c.base, ...(c.kit === undefined ? {} : { [KIT]: c.kit.base }) },
    head: { [F]: head, ...(c.kit === undefined ? {} : { [KIT]: c.kit.head }) },
  };
}

/**
 * The case's red run (its head with T_NEW, T_NEW alone red). When its kit changed, the task's
 * changes and test_paths say so, as red-check passes them (F and the kit modified, DIR/**).
 */
export function judgeCase(c: WholeCase): { expected: string[]; result: RedResult } {
  const t = treesOf(c);
  const kitChanged = c.kit !== undefined && c.kit.base !== c.kit.head;
  const changes: Change[] = kitChanged
    ? [
        { path: F, status: 'M' },
        { path: KIT, status: 'M' },
      ]
    : [];
  return judge(
    [F],
    reader(t.base, t.head),
    c.ledger,
    outcomesOf(c.tests),
    changes,
    kitChanged ? [`${DIR}/**`] : [],
  );
}

const LOOP = headNames(UUID_A);

/** 表不是内联字面量: a top-level const, the result of a call (the kit import: KIT_TABLE). */
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

/**
 * 表从同目录 kit 导入 (D10-2163 ③): `for (const route of ROUTES)`, ROUTES exported by KIT (both
 * sides' kits in the trees), the step-up row changed in the kit.
 */
export const KIT_TABLE: WholeCase = wholeCase(
  'the table imported from the same-directory kit (for (const route of ROUTES))',
  { form: 'kit', rows: [] },
  { form: 'kit', rows: [] },
  LOOP,
  '',
  { kit: { base: kitFile(BASE_ROWS), head: kitFile(HEAD_ROWS) } },
);

/**
 * 改了的行含非字面量 (D10-2163 ②) and a spread in the table (its rows not known from the table):
 * ROW_SEARCH (path: SEARCH, from the kit) changed and declared next to the step-up row.
 * (D10-2163: an unchanged row is taken by its index whatever its fields — NL_BASE / NL_HEAD.)
 */
export const NON_LITERAL_ROW: readonly WholeCase[] = [
  wholeCase(
    'the table holds a spread (...EXTRAS)',
    { rows: [...BASE_ROWS, '...EXTRAS'], header: [`const EXTRAS = [${ROW_EXTRA}];`] },
    { rows: [...HEAD_ROWS, '...EXTRAS'], header: [`const EXTRAS = [${ROW_EXTRA}];`] },
    [...LOOP, N_EXTRA],
  ),
  wholeCase(
    'the row with a non-literal field (path: SEARCH) changed, declared',
    { rows: NL_BASE_ROWS, kitImports: ['SEARCH'] },
    {
      rows: [ROW_GET, ROW_SEARCH_HEAD, ROW_CONSENT, ROW_LINK, ROW_STEP_HEAD],
      kitImports: ['SEARCH'],
    },
    [N_GET, N_SEARCH, N_CONSENT, linkName(UUID_A), N_STEP],
    '',
    { declared: [N_SEARCH, N_STEP], kit: { base: kitFile(), head: kitFile() } },
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

/** for…in instead of for…of (D10-2163 ④): the title made from the key, row 3 declared. */
export const FOR_IN: WholeCase = wholeCase(
  'for…in instead of for…of',
  { form: 'for-in', rows: BASE_ROWS },
  { form: 'for-in', rows: HEAD_ROWS },
  [0, 1, 2, 3].map(rowName),
  '',
  { declared: [rowName(3)], unchanged: [rowName(0), rowName(1)] },
);

/**
 * 改了的行在基线同下标不存在或行文本其实相同 (D10-2163 ⑥): a declared changed row with no row at its
 * index in the base (ROW_EXTRA added at the end); a declared row whose text is the base's (ROW_GET).
 */
export const DECLARED_NOT_CHANGED: readonly WholeCase[] = [
  wholeCase(
    'a declared changed row has no row at its index in the base (ROW_EXTRA added, declared)',
    { rows: BASE_ROWS },
    { rows: [...HEAD_ROWS, ROW_EXTRA] },
    [...LOOP, N_EXTRA],
    '',
    { declared: [N_STEP, N_EXTRA] },
  ),
  wholeCase(
    'a declared changed row whose text is the base’s (ROW_GET declared next to the step-up row)',
    { rows: BASE_ROWS },
    { rows: HEAD_ROWS },
    LOOP,
    '',
    { declared: [N_STEP, N_GET], unchanged: [N_CONSENT] },
  ),
];

/**
 * 改后全名重名 (D10-2163 ⑥): the changed row's full name is another row's (N_GET) or another test's
 * of the file (N_ME, a plain test above T1).
 */
export const DUPLICATE_NAME: readonly WholeCase[] = [
  wholeCase(
    'the changed row’s full name after the change is another row’s (GET /v1/orders)',
    { rows: BASE_ROWS },
    { rows: [ROW_GET, ROW_CONSENT, ROW_LINK, ROW_STEP_AS_GET] },
    [N_GET, N_CONSENT, linkName(UUID_A), N_GET],
    '',
    { declared: [N_GET], unchanged: [N_CONSENT] },
  ),
  wholeCase(
    'the changed row’s full name after the change is another test’s of the file (PUT /v1/me)',
    { rows: BASE_ROWS, header: [IT_ME] },
    { rows: [ROW_GET, ROW_CONSENT, ROW_LINK, ROW_STEP_AS_ME], header: [IT_ME] },
    [N_GET, N_CONSENT, linkName(UUID_A), N_ME],
    '',
    { declared: [N_ME], before: [N_ME] },
  ),
];

/** Every case judged as a whole table whose change lies in F itself (KIT_TABLE's lies in the kit). */
export const ALL_WHOLE: readonly WholeCase[] = [
  ...NOT_INLINE,
  ...NON_LITERAL_ROW,
  BODY_CHANGED_CASE,
  ...ROWS_MOVED,
  RUNTIME_ROW_CHANGED,
  ...OTHER_FORMS,
  FOR_IN,
  ...DECLARED_NOT_CHANGED,
  ...DUPLICATE_NAME,
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
 * what is left, a report of the expected files only (their outcomes from `outcomes`). `changes`
 * and `scope` are the task's changes and test_paths (none unless a support file such as the kit
 * changed).
 */
export function judge(
  files: readonly string[],
  read: BaselineReader,
  l: Ledger,
  outcomes: Readonly<Record<string, readonly Outcome[]>>,
  changes: readonly Change[] = [],
  scope: readonly string[] = [],
): { expected: string[]; result: RedResult } {
  const left = ruleTestsLeftOut(files, read, l);
  const baselines = ruleTestBaselines(
    left.expected,
    changes,
    scope,
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
