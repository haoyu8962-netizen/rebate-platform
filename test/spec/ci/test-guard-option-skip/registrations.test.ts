import { expect, it } from 'vitest';
import { scanFile } from '../../../../tools/guard/lib/test-guard.ts';

const unit = 'apps/api/src/modules/platform/http/client.test.ts';
const ruleTest = 'test/spec/platform/response.test.ts';
const funds = 'packages/money/src/round.test.ts';
const attribution = 'apps/api/src/modules/linking/claim.test.ts';
const tsx = 'apps/admin/src/pages/w.test.tsx';
const handler = '() => {}';
const title = "'sample'";
const blocked = ['no-skip-only'];
const unreadable = ['no-retry', 'no-skip-only'];

// Build the fixture's calls so the guard's existing line rules can scan this test file too.
function call(callee: string, ...args: string[]): string {
  return `${callee}(${args.join(', ')});`;
}

function registration(callee: string, ...args: string[]): string {
  return call(callee, title, ...args);
}

function expectRules(source: string, expected: readonly string[], file = unit): void {
  const rules = scanFile(file, source)
    .map((finding) => finding.rule)
    .sort();
  expect(rules, `${file}\n${source}`).toEqual(expected);
}

function expectUnreadableOptions(source: string): void {
  expectRules(source, unreadable);
  expectRules(source, unreadable, ruleTest);
  expectRules(source, blocked, funds);
  expectRules(source, blocked, attribution);
}

it('[AC-CT-06zzzzzzzl#1] checks the registration after a typed or tagged table', () => {
  const setup = 'type Row = [number, number];\nconst rows: Row[] = [[1, 2]];\n';
  expectRules(setup + registration('it.each<Row>(rows)', '{ skip: true }', handler), blocked);
  expectRules(setup + registration('it.each<Row>(rows)', '{ skip: false }', handler), []);

  for (const table of ['it.each`a | b\n${1} | ${2}`', 'it.for`a | b\n${1} | ${2}`']) {
    expectRules(call(table, '`sample ${value}`', '{ todo: true }', handler), blocked);
    expectRules(call(table, '`sample ${value}`', '{ todo: false }', handler), []);
  }
});

it('[AC-CT-06zzzzzzzl#2] reads options before a same-file named callback', () => {
  const callbacks = [
    'function verifyCredit() {}',
    'const verifyCredit = async () => {};',
    'const verifyCredit = function () {};',
  ];
  const check = registration('it', 'options', 'verifyCredit');

  for (const callback of callbacks) {
    expectRules(`const options = { skip: true };\n${callback}\n${check}`, blocked, funds);
    expectRules(`const options = { skip: false };\n${callback}\n${check}`, [], funds);
    expectRules(`${callback}\n${registration('it', 'verifyCredit')}`, [], funds);
  }
});

it('[AC-CT-06zzzzzzzl#3] resolves options and callbacks in the scope of the registration', () => {
  const check = registration('it', 'options', 'verifyCredit');
  const suite = (options: string): string =>
    registration('describe', `() => {\n${options}${check}\nfunction verifyCredit() {}\n}`);

  expectRules(
    'const options = { timeout: 1000 };\n' + suite('const options = { skip: true };\n'),
    blocked,
  );
  expectRules(
    'const options = { timeout: 1000 };\n' +
      suite('') +
      '\nfunction other() { const options = { skip: true }; return options; }',
    [],
  );
  expectRules('const options = { skip: true };\n' + suite('const options = { timeout: 1 };\n'), []);
});

it('[AC-CT-06zzzzzzzl#4] still checks registrations after an apostrophe in JSX text', () => {
  const setup = "const view = <p>it's here</p>;\nfunction verify() {}\n";
  const check = registration('it', 'options', 'verify');

  expectRules("import { options } from './fixture.ts';\n" + setup + check, unreadable, tsx);
  expectRules(setup + 'const options = { timeout: 1 };\n' + check, [], tsx);
});

it('[AC-CT-06zzzzzzzl#5] reads an option key with a comment before its colon', () => {
  expectRules(registration('it', '{ skip /* reason */: true }', handler), blocked, ruleTest);
  expectRules(registration('it', '{ skip /* reason */: false }', handler), [], ruleTest);
});

it('[AC-CT-06zzzzzzzl#6] flags a multiline fails chain and ignores sample text and data', () => {
  const skipSample = JSON.stringify(registration('it', '{ skip: true }', handler));
  const retrySample = JSON.stringify(registration('it', '{ retry: 2 }', handler));
  const failsSample = JSON.stringify(registration('it.fails', handler));
  const data = [
    `const skipSample = ${skipSample};`,
    `const retrySample = ${retrySample};`,
    `const failsSample = ${failsSample};`,
    'const result = { fails: 2 };',
    registration('it', '() => { consume(skipSample, retrySample, failsSample, result.fails); }'),
  ].join('\n');

  expectRules(
    'function verifyCredit() {}\n' + registration('test\n  .concurrent\n  .fails', 'verifyCredit'),
    blocked,
  );
  expectRules(data, []);
});

it('[AC-CT-06zzzzzzzl#7] checks a registration made directly through a derived API', () => {
  for (const factory of ['test.extend({})', 'test.override({})', 'test.scoped({})']) {
    expectRules(registration(factory, '{ skip: true, retry: 2 }', handler), unreadable);
    expectRules(registration(factory, '{ skip: false, retry: 0 }', handler), []);
    const setup = `const derived = ${factory};\nconst options = { fails: true };\n`;
    expectRules(setup + registration('derived', 'options', handler), blocked);
    expectRules(setup + registration('derived', handler), []);
  }
});

it('[AC-CT-06zzzzzzzl#8] follows Vitest imports and aliases by binding', () => {
  const sources = [
    ["import { it as spec } from 'vitest';", 'spec'],
    ["import * as v from 'vitest';", 'v.test'],
    ['const spec = it;', 'spec'],
    ['const spec = enabled ? it : localTest;', 'spec'],
    ['const spec = enabled ? localTest : it;', 'spec'],
  ] as const;

  for (const [setup, callee] of sources) {
    const check = registration(callee, 'options', handler);
    expectRules(`${setup}\nconst options = { only: true };\n${check}`, blocked);
    expectRules(`${setup}\nconst options = { only: false };\n${check}`, []);
  }
});

it('[AC-CT-06zzzzzzzl#9] uses custom-call rules for non-Vitest bindings', () => {
  const sameNames = [
    'function test(value: string) { return value.length; }\n' + registration('test'),
    `function wrapper(it: (value: string) => void) { ${registration('it')} }`,
    "import { suite } from './kit.ts';\n" + call('suite'),
    "import { fixture as spec } from './kit.ts';\n" + registration('spec', 'externalHandler'),
  ];
  const shadowed =
    "import { it as spec } from 'vitest';\n" +
    `function helper(spec: (value: string) => void) { ${registration('spec')} }\n`;

  for (const source of sameNames) expectRules(source, []);
  expectRules(shadowed + registration('spec'), blocked);
  expectRules(shadowed + registration('spec', handler), []);
});

it('[AC-CT-06zzzzzzzl#10] recognizes the allowed modifiers and hook calls', () => {
  const modifiers = [
    'it.concurrent',
    'test.sequential',
    'suite.shuffle',
    'test.describe',
    'test.suite',
  ];
  for (const callee of modifiers) {
    expectRules(registration(callee, '{ skip: true }', handler), blocked);
    expectRules(registration(callee, '{ skip: false }', handler), []);
  }

  const hooks = ['beforeEach', 'afterEach', 'beforeAll', 'afterAll', 'aroundEach', 'aroundAll'];
  for (const hook of hooks) {
    expectRules("import { test } from 'vitest';\n" + call(`test.${hook}`, handler), []);
  }
});

it('[AC-CT-06zzzzzzzl#11] flags forbidden dot and bracket modifiers without a call', () => {
  for (const modifier of ['skip', 'only', 'todo', 'fails', 'skipIf', 'runIf']) {
    const dot = `it.${modifier}`;
    const bracket = `it['${modifier}']`;
    const conditional = modifier === 'skipIf' || modifier === 'runIf';
    expectRules(`const alias = ${dot};`, blocked);
    expectRules(`const alias = ${bracket};`, blocked);
    expectRules(registration(conditional ? `${dot}(true)` : dot, handler), blocked);
    expectRules(registration(conditional ? `${bracket}(true)` : bracket, handler), blocked);
  }
  expectRules('const alias = enabled ? it : it.skip;\n' + registration('alias', handler), blocked);
  expectRules('const alias = it.concurrent;\n' + registration('alias', handler), []);
});

it('[AC-CT-06zzzzzzzl#12] flags unknown chain members and dynamic subscripts', () => {
  const cases = [
    registration('it.prop([1])', handler),
    registration("it['unknown']", handler),
    "const key = 'concurrent';\n" + registration('it[key]', handler),
    "import * as v from 'vitest';\n" + registration('v.test.concurrent.mystery', handler),
  ];

  for (const source of cases) expectRules(source, blocked, attribution);
  expectRules(registration("it['concurrent']", handler), [], attribution);
});

it('[AC-CT-06zzzzzzzl#13] flags test APIs used as values outside supported aliases', () => {
  const cases = [
    'const { skip } = it;',
    'let alias;\nalias = it;',
    'register(it);',
    'const methods = { it };',
    'const methods = { method: it };',
    'const methods = [it];',
    "import { it } from 'vitest';\nexport { it };",
    'export default it;',
    'const alias = it;\nexport { alias };',
  ];

  for (const source of cases) expectRules(source, blocked, ruleTest);
  expectRules('const alias = it;\n' + registration('alias', handler), [], ruleTest);
});

it('[AC-CT-06zzzzzzzl#14] requires a readable callback for each test or suite registration', () => {
  const cases = [
    call('it'),
    registration('it'),
    registration('it', '{ timeout: 5 }'),
    registration('it', '{ timeout: 5 }', '1000'),
    "import { check } from './fixture.ts';\n" + registration('it', 'check'),
    "import { check } from './fixture.ts';\n" + registration('it', '{ timeout: 5 }', 'check'),
    registration('it.each([1, 2])'),
    registration('suite', '{ timeout: 5 }'),
  ];

  for (const source of cases) expectRules(source, blocked);
  expectRules('const timeout = 90_000;\n' + registration('it', 'async () => {}', 'timeout'), []);
  expectRules(registration('it', handler, '60 * 1000'), []);
});

it('[AC-CT-06zzzzzzzl#15] preserves existing registration shapes with a callback', () => {
  const setup = "import { it, describe } from 'vitest';\n";
  const namedOptions = 'const options = { timeout: 1000 };\n';
  const namedHandler = 'function check() {}\n';
  const suiteEach = ['describe', 'each([1, 2])'].join('.');
  for (const callee of ['it', 'it.each([1, 2])', 'describe', suiteEach]) {
    expectRules(setup + registration(callee, handler), []);
    expectRules(setup + registration(callee, handler, '1000'), []);
    expectRules(setup + registration(callee, '{ timeout: 1000 }', handler), []);
    expectRules(setup + namedOptions + registration(callee, 'options', handler), []);
    expectRules(setup + namedHandler + registration(callee, 'check'), []);
  }
  expectRules(setup + namedOptions + registration(suiteEach, 'options'), blocked);
});

it('[AC-CT-06zzzzzzzl#16] checks only local const options that stay readable at all uses', () => {
  const check = registration('it', 'options', handler);
  const declaration = 'const options = { timeout: 1 };';
  const setups = [
    'let options = { timeout: 1 };',
    'var options = { timeout: 1 };',
    `export ${declaration}`,
    `${declaration}\nexport { options };`,
    `${declaration}\noptions.skip = true;`,
    `${declaration}\nObject.assign(options, { skip: true });`,
    `${declaration}\nconsume(options);`,
  ];

  for (const setup of setups) expectUnreadableOptions(`${setup}\n${check}`);
  for (const annotation of ['as const', 'satisfies { timeout: number }']) {
    const safe = [
      `const options = { timeout: 1 } ${annotation};`,
      'const copy = { ...options };',
      check,
      call('it', "'sample again'", 'options', '() => { consume(options.timeout, copy); }'),
    ].join('\n');
    expectRules(safe, []);
  }
});

it('[AC-CT-06zzzzzzzl#17] reports unreadable arguments and spreads by file type', () => {
  const cases = [
    "import { options } from './fixture.ts';\n" + registration('it', 'options', handler),
    `function helper(options: object) { ${registration('it', 'options', handler)} }`,
    'const { options } = defaults;\n' + registration('it', 'options', handler),
    'const options = defaults;\n' + registration('it', 'options', handler),
    registration('it', 'makeOptions()', handler),
    registration('it', 'settings.options', handler),
    registration('it', 'enabled ? fast : slow', handler),
    `const args = [${title}, { skip: true }, ${handler}] as const;\n${call('it', '...args')}`,
  ];

  for (const source of cases) expectUnreadableOptions(source);
  expectRules(registration('it', '{ timeout: 1 }', handler), []);
});

it('[AC-CT-06zzzzzzzl#18] flags unreadable test option properties and non-literal values', () => {
  expectUnreadableOptions(
    'const defaults = { timeout: 1 };\n' + registration('it', '{ ...defaults }', handler),
  );
  expectUnreadableOptions("const key = 'skip';\n" + registration('it', '{ [key]: true }', handler));
  expectUnreadableOptions(registration('it', '{ __proto__: { skip: true } }', handler));

  for (const property of ['get skip() { return false; }', 'only() { return false; }']) {
    expectRules(registration('it', `{ ${property} }`, handler), blocked);
  }
  const safe = "{ ['timeout']: 1, ['skip']: false, get metadata() { return true; } }";
  expectRules(registration('it', safe, handler), []);
});

it('[AC-CT-06zzzzzzzl#19] checks custom calls with literal titles, options and callbacks', () => {
  const setup = "import { fixtureTest } from './kit.ts';\n";
  expectRules(setup + registration('fixtureTest', '{ skip: true, retry: 2 }', handler), unreadable);
  expectRules(setup + registration('fixtureTest', '{ skip: false, retry: 0 }', handler), []);
  const spreadAndComputedKey = '{ ...defaults, [key]: true }';
  expectRules(setup + registration('fixtureTest', spreadAndComputedKey, handler), []);
  const options = '{ skip: true, retry: 2 }';
  expectRules(setup + call('fixtureTest', 'name', options, handler), []);
  expectRules(
    setup + `const options = ${options};\n` + registration('fixtureTest', 'options', handler),
    [],
  );
  expectRules(setup + 'function check() {}\n' + registration('fixtureTest', options, 'check'), []);
  expectRules(setup + registration('fixtureTest\n  .fails.each([1, 2])', handler), blocked);
});

it('[AC-CT-06zzzzzzzl#20] reports a syntax error once and stops checking options', () => {
  const valid = registration('it', '{ timeout: 1 }', handler);
  const invalid = registration('it', '{ retry: 2 }', '() => {');

  expectRules(valid, []);
  expectRules(`${registration('it', '{ retry: 2 }', handler)}\n${invalid}`, blocked);
});

it('[AC-CT-06zzzzzzzl#21] deduplicates by line and rule and keeps legacy line checks', () => {
  const skipped = registration(['it', 'skip'].join('.'), '{ only: true, retry: 2 }', handler);
  const focused = registration('it', '{ only: true, retry: 3 }', handler);
  expectRules(`${skipped} ${focused}`, unreadable);

  expectRules(registration(['x', 'it'].join(''), handler), blocked, funds);
  expectRules('const policy = { retry: 2 };', ['no-retry'], funds);
  expectRules('const policy = { retry: 2 };', ['no-retry'], attribution);
  expectRules('const policy = { retry: 2 };', []);
});

it('[AC-CT-06zzzzzzzl#22] requires a literal zero for retry in readable options', () => {
  for (const key of ['retry', "'retry'", "['retry']"]) {
    expectRules(registration('it', `{ ${key}: 0 + 1 }`, handler), ['no-retry']);
    expectRules(registration('it', `{ ${key}: 0 }`, handler), []);
  }
  expectRules('const retry = 0;\n' + registration('it', '{ retry }', handler), ['no-retry']);
});
