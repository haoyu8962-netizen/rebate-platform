// Source snippets that the test guard must flag. They live in a file that is not itself a
// test file, so the guard does not flag its own test suite.
export const SKIPPED_TEST = "it.skip('later', () => {});\n";
export const FOCUSED_TEST = "describe.only('x', () => {});\n";
export const CHAINED_SKIP = "it.skip.each([1, 2])('n %i', () => {});\n";
export const CONDITIONAL_SKIP = "it.skipIf(process.platform === 'darwin')('x', () => {});\n";
export const TODO_TEST = "it.todo('write me');\n";
export const X_PREFIXED_TEST = "xit('disabled', () => {});\n";
export const CONTEXT_SKIP = "it('x', (ctx) => {\n  ctx.skip();\n});\n";
export const RETRY_OPTION = "it('flaky', { retry: 3 }, () => {});\n";
export const RETRY_ZERO = "it('steady', { retry: 0 }, () => {});\n";
export const RETRY_SHORTHAND = "it('flaky', { retry }, () => {});\n";
// `retry` as an ordinary field name (a retry policy under test), not a Vitest option.
export const RETRY_FIELD = [
  'const policy = { retry: { maxRetries: 2 } };',
  "const governor = createGovernor('union', { retry: policy.retry }, deps);",
  'function withRetry(retry: Partial<RetryPolicy>) {',
  '  return { ...policy, retry };',
  '}',
  "it('keeps the retry policy', () => {",
  '  expect(withRetry({ retry: 1 } as never)).toEqual({ retry: { maxRetries: 2 } });',
  '});',
  '',
].join('\n');
export const RETRY_OPTION_MULTILINE = [
  'it(',
  "  'flaky', // don't retry (comment with a quote)",
  '  {',
  '    timeout: 5_000,',
  '    /* the option */ retry: 2,',
  '  },',
  '  () => {',
  "    expect(/can't/.test('a')).toBe(false);",
  '  },',
  ');',
  '',
].join('\n');
export const RETRY_OPTION_CHAINS = [
  "describe.concurrent('suite', { retry: 1 }, () => {});",
  "test.each([1, 2])('n %i', { retry: 1 }, () => {});",
  "test.for([1])('n', { retry: { count: 2 } }, () => {});",
  "suite.sequential('s', { 'retry': 1 }, () => {});",
  'it.each`a',
  "${1}`('t', { retry: 1 }, () => {});",
  '',
].join('\n');
export const RETRY_NESTED =
  "describe('s', () => {\n  it('t', { timeout: 1, retry: 4 }, () => {});\n});\n";
export const RETRY_EXTENDED_TEST =
  "const myTest = test.extend({ db: async ({}, use) => use(1) });\nmyTest('t', { retry: 2 }, () => {});\n";
export const RETRY_IMPORTED_TEST =
  "import { myTest } from './kit.ts';\nmyTest('t', { retry: 2 }, async () => {});\n";
export const OPTIONS_VARIABLE_LOCAL =
  "const LONG = { timeout: 60_000 };\nit('t', LONG, () => {});\nit('u', () => {}, 5_000);\n";
export const OPTIONS_VARIABLE_RETRY =
  "const OPTS: TestOptions = { timeout: 1, retry: 3 } as const;\nit('t', OPTS, () => {});\n";
export const OPTIONS_VARIABLE_IMPORTED =
  "import { OPTS } from './kit.ts';\nit('t', OPTS, () => {});\n";
export const OPTIONS_SPREAD = "it('t', { ...base, timeout: 1 }, () => {});\n";
export const ADMIN_URL_READ = "const url = process.env['TEST_PG_ADMIN_URL'];\n";
export const ADMIN_URL_ABSENT = "expect(process.env['TEST_PG_ADMIN_URL']).toBeUndefined();\n";
export const ADMIN_URL_ABSENT_AND_READ =
  'expect(process.env.TEST_PG_ADMIN_URL).toBeUndefined(); connect(process.env.TEST_PG_ADMIN_URL);\n';
export const LISTEN = 'await app.listen(3100);\n';
export const IMPORT_PG = "import pg from 'pg';\n";
export const IMPORT_PG_SUBPATH = "import { Pool } from 'pg/lib/index.js';\n";
export const IMPORT_PG_BOSS = "const { PgBoss } = await import('pg-boss');\n";
export const IMPORT_TESTCONTAINERS = "import { GenericContainer } from 'testcontainers';\n";
export const IMPORT_TESTCONTAINERS_MODULE = "import { X } from '@testcontainers/postgresql';\n";
export const IMPORT_DB_TESTING = "import { createTestDatabase } from '@couli/db/testing';\n";
export const REQUIRE_PG = "const pg = require('pg');\n";
export const IMPORT_HARMLESS = "import { pgTable } from './pg-helpers.ts';\nimport x from 'pgx';\n";
export const DESCRIBE_BLOCK = "describe('round', () => {\n  it('x', () => {});\n});\n";
export const DESCRIBE_EACH = "describe.each([1])('n', () => {});\n";
export const TOP_LEVEL_IT = "it('rounds half up', () => {});\n";
export const MOCK_MONEY = "vi.mock('@couli/money');\n";
export const MOCK_MONEY_RELATIVE = "vi.doMock('../../packages/money/src/index.ts', () => ({}));\n";
export const MOCK_LEDGER = "vi.mock('../../apps/api/src/modules/ledger/index.ts');\n";
export const MOCK_OTHER = "vi.mock('./clock.ts');\n";
export const AC_TITLED = "it('[AC-S1-03] 搜索返回商品卡片', () => {});\n";
export const AC_TITLED_SUFFIX = 'test("[AC-S2-26#2] 并发提现只成功一笔", () => {});\n';
export const AC_UNTITLED = "it('搜索返回商品卡片', () => {});\n";
export const AC_EACH_TITLED = "it.each([[1], [2]])('[AC-S1-04] page %i', () => {});\n";
export const AC_EACH_UNTITLED = "it.each([[1], [2]])('page %i', () => {});\n";
export const AC_DYNAMIC_TITLE = 'it(title, () => {});\n';
export const CONFIG_STRICT =
  'export default { test: { passWithNoTests: false, allowOnly: false, retry: 0 } };\n';
export const CONFIG_RETRY = 'export default { test: { retry: 2 } };\n';
export const CONFIG_PASS_EMPTY = 'export default { test: { passWithNoTests: true } };\n';
export const CONFIG_ALLOW_ONLY = 'export default { test: { allowOnly: true } };\n';

// CT-06zzzm (D10-750): property tests calling propParams() and their explicit timeouts.
const PROP_HEADER = [
  "import fc from 'fast-check';",
  "import { expect, it } from 'vitest';",
  "import { propParams } from '@couli/testing';",
  '',
].join('\n');
/** A rule-test file with the given blocks. */
export const propFile = (...blocks: string[]): string => `${PROP_HEADER}${blocks.join('\n\n')}\n`;
/** A test block calling propParams() as fc.assert's second argument, then `tail` (`, 900_000`). */
export const propBlock = (title: string, tail: string): string =>
  [
    `it('${title}', () => {`,
    '  fc.assert(',
    '    fc.property(fc.integer(), (n) => n === n),',
    '    propParams(),',
    '  );',
    `}${tail});`,
  ].join('\n');
export const PROP_PLAIN = (title: string): string =>
  `it('${title}', () => {\n  expect(1).toBe(1);\n});`;
export const PROP_DIRECT = [
  "it('[AC-1] direct', async () => {",
  '  const params = propParams();',
  '  await fc.assert(fc.asyncProperty(fc.nat(), async (n) => n >= 0), params);',
  '});',
].join('\n');
export const PROP_AS_ARGUMENT = [
  "it('[AC-1] argument', () => {",
  '  run(fc.nat(), { ...propParams(), numRuns: 1 });',
  '}, 30_000);',
].join('\n');
export const PROP_OPTIONS_SECOND = [
  "it('[AC-1] options', { timeout: 900_000 }, () => {",
  '  fc.assert(fc.property(fc.nat(), (n) => n >= 0), propParams());',
  '});',
].join('\n');
export const PROP_EACH = (tail: string): string =>
  [
    "it.each([1, 2])('[AC-1] row %i', (k) => {",
    '  fc.assert(fc.property(fc.nat(), (n) => n + k > n), propParams());',
    `}${tail});`,
  ].join('\n');
export const PROP_CONCURRENT = [
  "it.concurrent('[AC-1] concurrent', async () => {",
  '  await fc.assert(fc.asyncProperty(fc.nat(), async (n) => n >= 0), propParams());',
  '}, 899_999);',
].join('\n');
// Codex r1 S2 (CT-06zzzm): the name in a comment or a string is no call; inside `${…}` it is.
export const PROP_IN_COMMENT = [
  "it('[AC-1] comment', () => {",
  '  // 不需要 propParams()，这里只跑一次',
  '  /* propParams() 也不要 */',
  '  expect(1).toBe(1);',
  '});',
].join('\n');
export const PROP_IN_STRING = [
  "it('[AC-1] string', () => {",
  '  expect(\'propParams()\').toBe("propParams()");',
  '  expect(`propParams() is ${1}`).toBeTruthy();',
  '});',
].join('\n');
export const PROP_IN_INTERPOLATION = [
  "it('[AC-1] interpolation', () => {",
  '  expect(`${JSON.stringify(propParams())}`).toBeTruthy();',
  '});',
].join('\n');

// CT-06zzzzzzzl (D10-3170): test registrations and their options, read on the syntax tree. Each
// case: a name, the test file it is scanned as, the source and its findings as `line:rule`.
export const UNIT_TEST_FILE = 'apps/api/src/modules/platform/http/client.test.ts';
export const FUNDS_TEST_FILE = 'packages/money/src/round.test.ts';
export const TSX_TEST_FILE = 'apps/admin/src/pages/w.test.tsx';
export type RegistrationCase = [name: string, file: string, source: string, findings: string[]];
function unit(name: string, source: string, findings: string[]): RegistrationCase {
  return [name, UNIT_TEST_FILE, source, findings];
}
function funds(name: string, source: string, findings: string[]): RegistrationCase {
  return [name, FUNDS_TEST_FILE, source, findings];
}
const lines = (...source: string[]): string => source.join('\n');
const SKIP_ONLY = 'no-skip-only';
const BOTH = (line: number): string[] => [`${line}:no-retry`, `${line}:no-skip-only`];

export const REGISTRATION_CASES: RegistrationCase[] = [
  // 3.1 what is the test API: by binding, not by name
  unit(
    'a named import from vitest',
    lines("import { it } from 'vitest';", "it('s', { skip: true }, () => {});"),
    [`2:${SKIP_ONLY}`],
  ),
  unit(
    'an aliased import from vitest',
    lines("import { it as spec } from 'vitest';", "spec('s', { only: true }, () => {});"),
    [`2:${SKIP_ONLY}`],
  ),
  unit(
    'a namespace import from vitest',
    lines("import * as v from 'vitest';", "v.test('s', { only: true }, () => {});"),
    [`2:${SKIP_ONLY}`],
  ),
  unit(
    'other members of the vitest namespace',
    lines("import * as v from 'vitest';", 'v.expect(1).toBe(1);', 'v.vi.fn();'),
    [],
  ),
  unit('an undeclared global describe', "describe('s', { todo: true }, () => {});", [
    `1:${SKIP_ONLY}`,
  ]),
  unit('an undeclared global suite without a callback', 'const s = suite();', [`1:${SKIP_ONLY}`]),
  unit('a const alias', lines('const spec = it;', "spec('s', { skip: true }, () => {});"), [
    `2:${SKIP_ONLY}`,
  ]),
  unit(
    'a const alias of an extend of an extend',
    lines(
      'const base = it.extend({});',
      'const extended = base.extend({});',
      'const options = { fails: true };',
      "extended('s', options, () => {});",
    ),
    [`3:${SKIP_ONLY}`],
  ),
  unit(
    'a conditional alias with the API in one branch',
    lines('const spec = enabled ? localTest : suite;', "spec('s', { skip: true }, () => {});"),
    [`2:${SKIP_ONLY}`],
  ),
  unit(
    'a local function named test',
    lines('function test(p: string) { return /x/.test(p); }', "expect(test('a')).toBe(true);"),
    [],
  ),
  unit(
    'suite imported from a kit',
    lines("import { suite } from './kit.ts';", 'const s = suite();', 'await s.kit.db.close();'),
    [],
  ),
  unit(
    'a parameter named it, called in the custom-call shape',
    lines(
      'function wrap(it: (t: string, o: object, f: () => void) => void) {',
      "  it('a', { skip: false }, () => {});",
      "  it('b', { skip: true }, () => {});",
      '}',
    ),
    [`3:${SKIP_ONLY}`],
  ),
  unit(
    'an inner options binding shadows the outer one',
    lines(
      'const options = { timeout: 1000 };',
      "describe('d', () => {",
      '  const options = { skip: true };',
      "  it('s', options, verifyCredit);",
      '  function verifyCredit() {}',
      '});',
    ),
    [`3:${SKIP_ONLY}`],
  ),
  unit(
    'the outer options binding stays clean',
    lines(
      'const options = { timeout: 1000 };',
      "describe('d', () => {",
      "  it('s', options, () => {});",
      '});',
      'function other() { const options = { skip: true }; return options; }',
    ),
    [],
  ),

  // 3.2 chains
  unit(
    'the modifiers',
    lines(
      "describe.concurrent('s', () => {});",
      "suite.shuffle('s', () => {});",
      "test.sequential('s', () => {});",
      "test.describe('s', () => {});",
      "test.suite('s', () => {});",
      "it['concurrent']('s', () => {});",
    ),
    [],
  ),
  unit(
    'tables, also tagged and typed',
    lines(
      "it.each([1])('s %i', () => {});",
      "test.for([1])('s', () => {});",
      "describe.each([1])('s', () => {});",
      'it.each`a',
      "${1}`('s', () => {});",
      "it.each<number>([1])('s', { skip: true }, () => {});",
    ),
    [`6:${SKIP_ONLY}`],
  ),
  unit(
    'derived test functions called directly',
    lines(
      "test.extend({})('s', () => {});",
      "test.override({})('s', () => {});",
      "test.scoped({})('s', { todo: true }, () => {});",
    ),
    [`3:${SKIP_ONLY}`],
  ),
  unit(
    'hooks',
    lines(
      "import { test } from 'vitest';",
      'test.beforeEach(async () => {});',
      'test.afterAll(() => {});',
    ),
    [],
  ),
  unit(
    'forbidden members on describe, suite and test, called or not',
    lines(
      "describe.fails('s', () => {});",
      "suite['todo']('s', () => {});",
      "describe.skipIf(true)('s', () => {});",
      'const a = describe.only;',
      "const b = suite['skip'];",
      'const c = test.runIf;',
      "import * as v from 'vitest';",
      'const d = v.describe.skip;',
    ),
    [1, 2, 3, 4, 5, 6, 8].map((line) => `${line}:${SKIP_ONLY}`),
  ),
  unit(
    'a multiline fails chain',
    lines('function check() {}', 'test', '  .concurrent', "  .fails('s', check);"),
    [`2:${SKIP_ONLY}`],
  ),
  unit(
    'unknown members and computed subscripts',
    lines(
      "it.prop([1])('s', () => {});",
      "describe.mystery('s', () => {});",
      "const k = 'only';",
      "suite[k]('s', () => {});",
      "import * as v from 'vitest';",
      "v[k]('s', () => {});",
      "v.test.concurrent.mystery('s', () => {});",
    ),
    [1, 2, 4, 6, 7].map((line) => `${line}:${SKIP_ONLY}`),
  ),
  unit(
    'the API used as a value',
    lines(
      'const { only } = describe;',
      'let t;',
      't = suite;',
      'register(test);',
      'const m = { describe };',
      'const n = [suite];',
      'export default test;',
      'export const spec = it;',
      'let late = it;',
      "late('s', () => {});",
      'register(it.each([1]));',
      'const e = it.each;',
      'register(e);',
    ),
    [1, 3, 4, 5, 6, 7, 8, 9, 11, 13].map((line) => `${line}:${SKIP_ONLY}`),
  ),
  unit(
    'the vitest namespace and imports used as values',
    lines(
      "import * as v from 'vitest';",
      "import { describe } from 'vitest';",
      'register(v);',
      'const { it: spec } = v;',
      'export { describe };',
    ),
    [3, 4, 5].map((line) => `${line}:${SKIP_ONLY}`),
  ),
  unit('an exported const alias', lines('const spec = it;', 'export { spec };'), [
    `2:${SKIP_ONLY}`,
  ]),
  unit(
    'uses the guard follows',
    lines(
      'type T = typeof it;',
      "const r = it('s', () => {});",
      'const spec = it.concurrent;',
      "spec('s', () => {});",
    ),
    [],
  ),

  // 3.3 the arguments of a registration
  unit(
    'a callback with a timeout',
    lines(
      'const T = 90_000;',
      "it('s', async () => {}, T);",
      "it('s', function () {}, 60 * 1000);",
    ),
    [],
  ),
  unit(
    'named callbacks of this file',
    lines(
      'function check() {}',
      'const verify = async () => {};',
      "it('s', check);",
      "it('s', verify);",
      "it.each(ROWS)('s %s', check);",
      "it('s', { timeout: 1 }, check);",
    ),
    [],
  ),
  unit(
    'a let callback',
    lines('let check = () => {};', "it('s', check);", "it('s', { timeout: 1 }, check);"),
    [`2:${SKIP_ONLY}`, `3:${SKIP_ONLY}`],
  ),
  unit(
    'const options used only in ways that leave them alone',
    lines(
      'const SLOW = { timeout: 1 } as const;',
      'const copy = { ...SLOW };',
      "it('a', SLOW, () => {});",
      "it('b', (SLOW), () => { expect(SLOW.timeout).toBe(1); consume(SLOW['timeout'], copy); });",
      'type Slow = typeof SLOW;',
    ),
    [],
  ),
  unit(
    'const options with satisfies',
    lines('const O = { skip: true } satisfies object;', "it('s', O, () => {});"),
    [`1:${SKIP_ONLY}`],
  ),
  ...[
    'options.skip = true;',
    'Object.assign(options, { skip: true });',
    'consume(options);',
    'delete options.timeout;',
    'options.timeout++;',
    '[options.timeout] = [2];',
    'options.toString();',
    'export { options };',
    'const holder = { options };',
  ].map((use) =>
    unit(
      `options used as: ${use}`,
      lines('const options = { timeout: 1 };', use, "it('s', options, () => {});"),
      BOTH(3),
    ),
  ),
  unit(
    'let options',
    lines('let options = { timeout: 1 };', "it('s', options, () => {});"),
    BOTH(2),
  ),
  unit(
    'var options',
    lines('var options = { timeout: 1 };', "it('s', options, () => {});"),
    BOTH(2),
  ),
  unit(
    'exported options',
    lines('export const options = { timeout: 1 };', "it('s', options, () => {});"),
    BOTH(2),
  ),
  funds(
    'let options in a funds file',
    lines('let options = { timeout: 1 };', "it('s', options, () => {});"),
    [`2:${SKIP_ONLY}`],
  ),
  unit(
    'imported options',
    lines("import { options } from './kit.ts';", "it('s', options, () => {});"),
    BOTH(2),
  ),
  unit(
    'options of a parameter',
    "function helper(options: object) { it('s', options, () => {}); }",
    BOTH(1),
  ),
  unit(
    'destructured options',
    lines('const { options } = defaults;', "it('s', options, () => {});"),
    BOTH(2),
  ),
  unit(
    'options from another initializer',
    lines('const options = defaults;', "it('s', options, () => {});"),
    BOTH(2),
  ),
  unit(
    'options from a call, a member or a conditional',
    lines(
      "it('s', makeOptions(), () => {});",
      "it('s', settings.options, () => {});",
      "it('s', enabled ? fast : slow, () => {});",
    ),
    [...BOTH(1), ...BOTH(2), ...BOTH(3)],
  ),
  unit(
    'spread arguments',
    lines("const args = ['s', { skip: true }, () => {}] as const;", 'it(...args);'),
    BOTH(2),
  ),
  unit(
    'registrations without a readable callback',
    lines(
      "it('s');",
      "it('s', { timeout: 5 });",
      "it('s', { timeout: 5 }, 1000);",
      "import { h } from './h.ts';",
      "it('s', h);",
      "it('s', { timeout: 5 }, h);",
      "it.each([1])('s');",
      'it`s`;',
      'it();',
    ),
    [1, 2, 3, 5, 6, 7, 8, 9].map((line) => `${line}:${SKIP_ONLY}`),
  ),

  // 3.4 the options object
  unit(
    'the four options as the literal false',
    "it('s', { skip: false, only: false, todo: false, fails: false }, () => {});",
    [],
  ),
  unit(
    'the four options as anything else',
    lines(
      'const flag = false;',
      "it('a', { skip: true }, () => {});",
      "it('b', { only: flag }, () => {});",
      "it('c', { todo: !true }, () => {});",
      "it('d', { fails }, () => {});",
      "it('e', { skip() { return false; } }, () => {});",
      "it('f', { get only() { return false; } }, () => {});",
    ),
    [2, 3, 4, 5, 6, 7].map((line) => `${line}:${SKIP_ONLY}`),
  ),
  unit(
    'quoted and literal computed keys, a comment before the colon',
    lines(
      "it('a', { 'skip': true }, () => {});",
      'it(\'b\', { ["only"]: true }, () => {});',
      "it('c', { skip /* why */: true }, () => {});",
      "it('d', { 'todo': false, ['fails']: false }, () => {});",
    ),
    [1, 2, 3].map((line) => `${line}:${SKIP_ONLY}`),
  ),
  unit(
    'retry',
    lines(
      "it('a', { retry: 0 }, () => {});",
      "it('b', { retry: 1 }, () => {});",
      'const retry = 0;',
      "it('c', { retry }, () => {});",
      "it('d', { ['retry']: 0 + 1 }, () => {});",
    ),
    ['2:no-retry', '4:no-retry', '5:no-retry'],
  ),
  unit(
    'unreadable options properties',
    lines(
      'const defaults = { timeout: 1 };',
      "it('a', { ...defaults }, () => {});",
      "const k = 'skip';",
      "it('b', { [k]: true }, () => {});",
      "it('c', { __proto__: { skip: true } }, () => {});",
    ),
    [...BOTH(2), ...BOTH(4), ...BOTH(5)],
  ),
  funds(
    'unreadable options properties in a funds file',
    lines(
      'const defaults = { timeout: 1 };',
      "it('a', { ...defaults }, () => {});",
      "it('c', { __proto__: { skip: true } }, () => {});",
    ),
    [`2:${SKIP_ONLY}`, `3:${SKIP_ONLY}`],
  ),
  unit(
    'other keys',
    "it('s', { timeout: 1, ['tags']: [], get metadata() { return 1; } }, () => {});",
    [],
  ),

  // 3.5 calls whose root is not the test API
  unit(
    'a custom call with a literal title, an options object and a function literal',
    lines(
      "import { fixtureTest } from './kit.ts';",
      "fixtureTest('a', { skip: true, retry: 2 }, () => {});",
      "fixtureTest('b', { skip: false, retry: 0, ...defaults, [key]: true }, () => {});",
      'fixtureTest(name, { skip: true }, () => {});',
      "fixtureTest('c', options, () => {});",
      "fixtureTest('d', { skip: true }, check);",
    ),
    ['2:no-retry', `2:${SKIP_ONLY}`],
  ),
  unit(
    'fails in the call chain of any root',
    lines(
      "import { fixtureTest } from './kit.ts';",
      'fixtureTest',
      "  .fails('s', () => {});",
      "helpers.fails.each([1])('s', () => {});",
    ),
    [`2:${SKIP_ONLY}`, `4:${SKIP_ONLY}`],
  ),
  unit(
    'fails as data',
    lines('const fails = run();', 'expect(fails.calls).toBe(1);', 'expect(r.fails).toBe(2);'),
    [],
  ),

  // Codex money review r1 of CT-06zzzzzzzl (D10-3220)
  unit(
    'a function of this file with overload signatures as the callback',
    lines(
      'function check(): void;',
      'function check(label: string): void;',
      "function check(label?: string) { expect(label ?? '默认').toBeTruthy(); }",
      "it('核对回调', check);",
      "it('核对回调', { timeout: 1 }, check);",
    ),
    [],
  ),
  unit(
    'overload signatures without a body, or two bodies',
    lines(
      'declare function sig(): void;',
      "it('a', sig);",
      'function twice() {}',
      'function twice() {}',
      "it('b', twice);",
    ),
    [`2:${SKIP_ONLY}`, `5:${SKIP_ONLY}`],
  ),
  unit(
    'options written through a non-null or type assertion',
    lines(
      'const options: { timeout: number; skip?: boolean } = { timeout: 1000 };',
      'function check() {}',
      'options.skip! = true;',
      "it('核对入账', options, check);",
    ),
    BOTH(4),
  ),
  unit(
    'options written through as or parentheses',
    lines(
      'const a = { timeout: 1 };',
      'const b = { timeout: 1 };',
      '(a.skip as unknown) = true;',
      '((b).retry)!++;',
      "it('a', a, () => {});",
      "it('b', b, () => {});",
    ),
    [...BOTH(5), ...BOTH(6)],
  ),
  unit(
    'options read through a non-null assertion',
    lines(
      'const SLOW = { timeout: 1 };',
      "it('a', SLOW, () => { expect(SLOW.timeout!).toBe(1); });",
    ),
    [],
  ),
  unit(
    'the test API re-exported from vitest',
    lines(
      "export { test as sharedTest } from 'vitest';",
      "export { expect, vi, describe } from 'vitest';",
      "export * as v from 'vitest';",
      "export * from 'vitest';",
      "export type { TestContext } from 'vitest';",
      "export { type it } from 'vitest';",
      "export { other } from './kit.ts';",
    ),
    [`1:${SKIP_ONLY}`, `2:${SKIP_ONLY}`, `3:${SKIP_ONLY}`, `4:${SKIP_ONLY}`],
  ),
  unit(
    'fails behind a type assertion in the call chain',
    lines(
      "import { fixtureTest } from './kit.ts';",
      'function check() {}',
      "(fixtureTest.fails as typeof fixtureTest)('核对结果', check);",
      "(fixtureTest.fails satisfies unknown as typeof fixtureTest)('核对结果', check);",
      "(<typeof fixtureTest>fixtureTest.fails)('核对结果', check);",
    ),
    [`3:${SKIP_ONLY}`, `4:${SKIP_ONLY}`, `5:${SKIP_ONLY}`],
  ),
  unit(
    'describe, suite and test through a namespace: forbidden, unknown and value uses',
    lines(
      "import * as v from 'vitest';",
      'v.describe.skip;',
      "v.suite['only']('s', () => {});",
      "v.test.prop([1])('s', () => {});",
      'register(v.describe);',
      'register(suite);',
      'const { only } = test;',
    ),
    [2, 3, 4, 5, 6, 7].map((line) => `${line}:${SKIP_ONLY}`),
  ),

  // 3.6 other
  unit('a syntax error', "it('s', { retry: 2 }, () => {", [`1:${SKIP_ONLY}`]),
  unit(
    'samples in strings and comments',
    lines(
      'const s = "it(\'x\', { skip: true }, () => {});";',
      "// it('y', { only: true }, () => {});",
      "/* it('z', { retry: 2 }, () => {}); */",
      "it('y', () => { scan(s); });",
    ),
    [],
  ),
  [
    'an apostrophe in JSX text',
    TSX_TEST_FILE,
    lines("const v = <p>it's here</p>;", "it('s', { todo: true }, () => {});"),
    [`2:${SKIP_ONLY}`],
  ],
];
