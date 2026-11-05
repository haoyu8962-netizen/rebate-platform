// Unit tests of the test-block comparison of the red check (CT-06p; red check, 规划/11 §2.3
// step 3; orchestrator ruling of 2026-10-18 14:1x).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  type ComparedBlock,
  type Module,
  type ModuleImport,
  type PathKind,
  TestParseError,
  compareEachRows,
  compareOutsideChanged,
  formatEachTitle,
  formatObjectTitle,
  TITLE_VALUE_TRUNCATE,
  compareTestFile,
  cook,
  listedDirectories,
  mayImportRuleTest,
  mayReadSupport,
  parseTestFile,
  relativeClosure,
  tokenize,
  unchangedTest,
  helperImpact,
  helperNamedInLiteral,
  valueChangeRefusal,
  topLevelHelpers,
  valueSkeleton,
} from './test-blocks.ts';

const HEADER = "import { describe, expect, it } from 'vitest';";
const src = (...lines: string[]): string => `${[HEADER, ...lines].join('\n')}\n`;
const test = (title: string, body = 'expect(1).toBe(1);'): string =>
  `it('${title}', () => {\n  ${body}\n});`;

function blocksOf(base: string, head: string): ComparedBlock[] {
  const c = compareTestFile(base, head);
  if (c.whole) throw new Error(`judged as a whole: ${c.reason}`);
  return c.blocks;
}

/** Title → changed, for the head blocks. */
function changes(base: string, head: string): Record<string, boolean> {
  return Object.fromEntries(blocksOf(base, head).map((b) => [b.title, b.changed]));
}

function whole(base: string, head: string): string {
  const c = compareTestFile(base, head);
  if (!c.whole) throw new Error('compared test by test');
  return c.reason;
}

it('[CT-06p] tokenize: comments and spacing drop out, line breaks, literals and regexes stay', () => {
  const tokens = tokenize("a = /x\\/(/g; // c\nb /* d */ = 'q' / 2;");
  expect(tokens.map((t) => [t.kind, t.text, t.nl])).toEqual([
    ['id', 'a', false],
    ['punct', '=', false],
    ['re', '/x\\/(/g', false],
    ['punct', ';', false],
    ['id', 'b', true],
    ['punct', '=', false],
    ['str', "'q'", false],
    ['punct', '/', false],
    ['num', '2', false],
    ['punct', ';', false],
  ]);
  const tpl = tokenize('`a${f(`b${c}`)}d`')[0];
  expect(tpl?.kind).toBe('tpl');
  expect(tpl?.parts).toEqual(['a', 'd']);
  // A regex after `)` is read as a division: a bracket in it breaks the bracket balance, and the
  // file is then judged as a whole (parseTestFile throws), never misread.
  expect(() => parseTestFile(src('if (x) /\\(/.test(y);'))).toThrow(TestParseError);
  expect(() => tokenize("it('unterminated\n")).toThrow(TestParseError);
  expect(() => tokenize('`open ${x')).toThrow(TestParseError);
  expect(() => tokenize('/* open')).toThrow(TestParseError);
});

it('[CT-06p] cook: string escapes decode exactly; an undecidable escape gives null', () => {
  expect(cook(String.raw`a\n\t\'\"\\\x41\u0042\u{43}`, false)).toBe('a\n\t\'"\\ABC');
  expect(cook('a\\\nb', false)).toBe('ab');
  expect(cook('a\r\nb', true)).toBe('a\nb');
  expect(cook(String.raw`\1`, false)).toBeNull();
  expect(cook(String.raw`\x4`, false)).toBeNull();
  expect(cook(String.raw`\08`, false)).toBeNull();
});

it('[CT-06p] parseTestFile: test blocks are the it / test calls imported from vitest', () => {
  const parsed = parseTestFile(
    [
      "import { describe, it as spec, test, type TestContext } from 'vitest';",
      "import { it as other } from './helpers.ts';",
      'const re = /x/;',
      "spec('[AC-1] plain', () => { expect(re.test('x')).toBe(true); });",
      "test.concurrent('[AC-2] concurrent', () => {});",
      'spec.each([[1], [2]])(\'[AC-3] row %i\', (n) => { spec("inner", () => {}); });',
      "spec.each<[number, string]>([[1, 'a']])('[AC-4] typed $0', () => {});",
      "spec.each`\n  a\n  ${1}\n`('[AC-5] tagged $a', () => {});",
      "other('not vitest', () => {});",
      'const fixtures = spec.extend({ db: async ({}, use) => use(1) });',
      "describe('suite', () => {",
      "  spec(`[AC-6] ${'x'} in suite`, () => {});",
      "  describe.each(['p'])('inner %s', () => { spec('[AC-7] deep', () => {}); });",
      '});',
      'spec(name, () => {});',
    ].join('\n'),
  );
  expect(parsed.blocks.map((b) => b.title)).toEqual([
    '[AC-1] plain',
    '[AC-2] concurrent',
    '[AC-3] row *',
    '[AC-4] typed *',
    '[AC-5] tagged *',
    'suite > [AC-6] * in suite',
    'suite > inner * > [AC-7] deep',
    '*',
  ]);
  // The fixture definition (it.extend) and the foreign `it` stay in the shared rest.
  expect(parsed.shared).toContain('spec . extend');
  expect(parsed.shared).toContain("other ( 'not vitest'");
  const [plain, , row, typed, , suite, deep, wild] = parsed.blocks;
  expect(plain?.pattern.test('[AC-1] plain')).toBe(true);
  expect(plain?.pattern.test('some suite > [AC-1] plain')).toBe(true); // unknown suite prefix
  expect(plain?.pattern.test('[AC-1] plain!')).toBe(false);
  expect(row?.pattern.test('[AC-3] row 2')).toBe(true);
  expect(typed?.pattern.test('[AC-4] typed 1')).toBe(true);
  expect(suite?.pattern.test('suite > [AC-6] x in suite')).toBe(true);
  expect(suite?.pattern.test('[AC-6] x in suite')).toBe(false);
  expect(deep?.pattern.test('suite > inner p > [AC-7] deep')).toBe(true);
  expect(wild?.pattern.test('anything at all')).toBe(true);
});

it('[CT-06p] real red-reporter names map to exactly their own block (vitest 5.0.1 run of a probe file)', () => {
  // The probe file ran under vitest 5.0.1 with the trusted red reporter: plain, template, each
  // (%i %s, $name %#), tagged-template each, a loop, describe and describe.each, .for, escapes.
  const dir = join(import.meta.dirname, 'red-check-fixtures');
  const source = readFileSync(join(dir, 'ct06p-probe.ts.txt'), 'utf8');
  const report = JSON.parse(readFileSync(join(dir, 'ct06p-probe-red.json'), 'utf8')) as {
    testResults: { assertionResults: { fullName: string }[] }[];
  };
  const names = report.testResults[0]?.assertionResults.map((t) => t.fullName) ?? [];
  expect(names).toHaveLength(15);
  const { blocks } = parseTestFile(source);
  for (const name of names) {
    expect(
      blocks.filter((b) => b.pattern.test(name)).map((b) => b.title),
      name,
    ).toHaveLength(1);
  }
  const same = blocksOf(source, source);
  expect(names.every((n) => unchangedTest(n, same))).toBe(true);
});

it('[CT-06p] B1-12f shape: an assertion changed in two tests marks only those two', () => {
  const base = src(test('[AC-1] a'), test('[AC-2] b'), test('[AC-3] c'), test('[AC-4] d'));
  const head = src(
    test('[AC-1] a', '// a new column\n  expect(2).toBe(2);'),
    test('[AC-2] b'),
    test('[AC-3] c'),
    test('[AC-4] d', 'expect([1, 2]).toEqual([1, 2]);'),
  );
  expect(changes(base, head)).toEqual({
    '[AC-1] a': true,
    '[AC-2] b': false,
    '[AC-3] c': false,
    '[AC-4] d': true,
  });
});

it('[CT-06p] comments and indentation do not count; a line break, a literal or a regex does', () => {
  const base = src(test('[AC-1] a', 'expect(f(1, 2)).toBe(3);'), test('[AC-2] b'));
  expect(
    changes(
      base,
      src(
        test('[AC-1] a', '/* why */ expect(f(1,   2)).toBe(3); // same'),
        '// a comment between tests',
        test('[AC-2] b'),
      ),
    ),
  ).toEqual({ '[AC-1] a': false, '[AC-2] b': false });
  const line = src(test('[AC-1] a', 'expect(f(1, 2))\n    .toBe(3);'), test('[AC-2] b'));
  expect(changes(base, line)['[AC-1] a']).toBe(true);
  const literal = src(test('[AC-1] a', "expect(f(1, 2)).toBe('3 ');"), test('[AC-2] b'));
  expect(changes(base, literal)['[AC-1] a']).toBe(true);
  const re = (r: string): string => src(test('[AC-1] a', `expect('x').toMatch(${r});`));
  expect(changes(re('/x/'), re('/x /'))['[AC-1] a']).toBe(true);
  // A regex the lexer reads as a division (after the `)` of an `if`) keeps its spaces: a line
  // with a division is compared with its exact spacing (Codex review r3, S2).
  const after = (r: string): string =>
    src(test('[AC-1] a', `if (true) ${r}.test('a  b') || expect.fail('mismatch');`));
  expect(changes(after('/a b/'), after('/a  b/'))['[AC-1] a']).toBe(true);
  expect(changes(after('/a b/'), after('/a b/'))['[AC-1] a']).toBe(false);
  const division = (d: string): string => src(test('[AC-1] a', `expect(${d}).toBe(2);`));
  expect(changes(division('4 / 2'), division('4  /  2'))['[AC-1] a']).toBe(true);
  expect(changes(division('4 / 2'), division('4 / /* two */ 2'))['[AC-1] a']).toBe(true);
  expect(changes(division('4 / 2'), division('4 / 2'))['[AC-1] a']).toBe(false);
});

it('[CT-06p] a new test, inserted anywhere, is the only changed block', () => {
  const base = src(test('[AC-1] a'), test('[AC-2] b'));
  expect(changes(base, src(test('[AC-1] a'), test('[AC-9] new'), test('[AC-2] b')))).toEqual({
    '[AC-1] a': false,
    '[AC-9] new': true,
    '[AC-2] b': false,
  });
  expect(changes(base, src(test('[AC-1] a'), test('[AC-2] b'), test('[AC-9] new')))).toEqual({
    '[AC-1] a': false,
    '[AC-2] b': false,
    '[AC-9] new': true,
  });
});

it('[CT-06p] a renamed test is new; moved tests and duplicates count as changed', () => {
  const base = src(test('[AC-1] a'), test('[AC-2] b'), test('[AC-3] c'));
  // Renamed: the old title is gone, the new one is a new block.
  expect(changes(base, src(test('[AC-1] a'), test('[AC-2] b2'), test('[AC-3] c')))).toEqual({
    '[AC-1] a': false,
    '[AC-2] b2': true,
    '[AC-3] c': false,
  });
  // Moved: the order of the unchanged tests is kept by the longest run; the moved one changed.
  expect(changes(base, src(test('[AC-3] c'), test('[AC-1] a'), test('[AC-2] b')))).toEqual({
    '[AC-3] c': true,
    '[AC-1] a': false,
    '[AC-2] b': false,
  });
  // Two identical copies: neither has a unique counterpart.
  const dup = blocksOf(
    src(test('[AC-1] a'), test('[AC-1] a')),
    src(test('[AC-1] a'), test('[AC-1] a')),
  );
  expect(dup.map((b) => b.changed)).toEqual([true, true]);
});

it('[CT-06p] describe: moving a test into or between suites changes it; a renamed suite changes the file', () => {
  const base = src(
    test('[AC-1] a'),
    "describe('one', () => {",
    test('[AC-2] b'),
    '});',
    "describe('two', () => {",
    test('[AC-3] c'),
    '});',
  );
  const moved = src(
    "describe('one', () => {",
    test('[AC-1] a'),
    test('[AC-2] b'),
    '});',
    "describe('two', () => {",
    test('[AC-3] c'),
    '});',
  );
  expect(changes(base, moved)).toEqual({
    'one > [AC-1] a': true,
    'one > [AC-2] b': false,
    'two > [AC-3] c': false,
  });
  const across = src(
    test('[AC-1] a'),
    "describe('one', () => {",
    '});',
    "describe('two', () => {",
    test('[AC-2] b'),
    test('[AC-3] c'),
    '});',
  );
  expect(changes(base, across)['two > [AC-2] b']).toBe(true);
  // Two describes with the same header are different suites (Codex review r1, S2).
  const twins = (first: string, second: string): string =>
    src(
      "describe('same', () => {",
      'const k = 1;',
      first,
      '});',
      "describe('same', () => {",
      'const k = 2;',
      second,
      '});',
    );
  expect(changes(twins(test('[AC-1] a'), ''), twins('', test('[AC-1] a')))).toEqual({
    'same > [AC-1] a': true,
  });
  expect(whole(base, base.replace("describe('two'", "describe('three'"))).toContain(
    'code outside the tests changed',
  );
});

it('[CT-06p] a changed row of an inline it.each table changes every case; a top-level table changes the file', () => {
  const each = (rows: string): string =>
    src(
      test('[AC-1] a'),
      `it.each(${rows})('[AC-2] row %s', (n) => {\n  expect(n).toBeTruthy();\n});`,
    );
  expect(changes(each('[[1], [2]]'), each('[[1], [3]]'))).toEqual({
    '[AC-1] a': false,
    '[AC-2] row *': true,
  });
  const table = (rows: string): string =>
    src(`const rows = ${rows};`, test('[AC-1] a'), "it.each(rows)('[AC-2] row %s', () => {});");
  expect(whole(table('[[1], [2]]'), table('[[1], [3]]'))).toContain('code outside the tests');
});

it('[CT-06p] imports, helpers, hooks and loops are shared: any change there changes the file', () => {
  const base = src('const helper = () => 1;', 'beforeEach(() => {});', test('[AC-1] a'));
  expect(whole(base, base.replace('() => 1', '() => 2'))).toContain('code outside the tests');
  expect(
    whole(base, base.replace('beforeEach(() => {});', 'beforeEach(() => { x(); });')),
  ).toContain('code outside the tests');
  expect(
    whole(base, base.replace(HEADER, "import { describe, expect, it, vi } from 'vitest';")),
  ).toContain('code outside the tests');
  expect(whole(base, `${base}const extra = 1;\n`)).toContain('code outside the tests');
  // A loop that generates tests: its header is shared.
  const loop = (xs: string): string =>
    src(`for (const x of ${xs}) {`, '  it(`[AC-1] ${x}`, () => { expect(x).toBeTruthy(); });', '}');
  expect(whole(loop("['a']"), loop("['a', 'b']"))).toContain('code outside the tests');
  expect(changes(loop("['a']"), loop("['a']"))).toEqual({ '[AC-1] *': false });
  // A block moved into another loop (or branch, function …) with the same text is a different
  // block: its place in the shared rest changed (Codex review r2, S2).
  const loops = (first: string, second: string): string =>
    src('for (const n of [1]) {', first, '}', 'for (const n of [2, 3]) {', second, '}');
  const inLoop = 'it(`[AC-1] case ${n}`, () => {\n  expect(n).toBeGreaterThan(0);\n});';
  expect(changes(loops(inLoop, ''), loops('', inLoop))).toEqual({ '[AC-1] case *': true });
  expect(changes(loops(inLoop, ''), loops(inLoop, ''))).toEqual({ '[AC-1] case *': false });
});

it('[CT-06p] a file that cannot be read as tests is judged as a whole', () => {
  const ok = src(test('[AC-1] a'));
  expect(whole("it('open\n", ok)).toContain('at the base cannot be read');
  expect(whole(ok, `${ok}const x = <div>don't</div>;\n`)).toContain('cannot be read as tests');
  expect(whole(ok, `${ok}f(;\n`.replace('f(;', 'f(]'))).toContain('cannot be read as tests');
});

it('[CT-06p] unchangedTest: exactly one matching block, and that block unchanged', () => {
  const base = src(test('[AC-1] a'), 'it(`[AC-2] ${n} b`, () => {});');
  const same = blocksOf(base, base);
  expect(unchangedTest('[AC-1] a', same)).toBe(true);
  expect(unchangedTest('[AC-2] 7 b', same)).toBe(true);
  expect(unchangedTest('[AC-3] unknown', same)).toBe(false);
  expect(unchangedTest('', same)).toBe(false);
  // A block whose title is not a literal matches every name: nothing it could share is exempt.
  const wild = src(test('[AC-1] a'), 'it(name, () => {});');
  const ambiguous = blocksOf(wild, wild);
  expect(unchangedTest('[AC-1] a', ambiguous)).toBe(false);
  // A changed block that matches keeps the test required even if another block matches too.
  const changed = blocksOf(
    base,
    src(test('[AC-1] a', 'expect(2).toBe(2);'), 'it(`[AC-2] ${n} b`, () => {});'),
  );
  expect(unchangedTest('[AC-1] a', changed)).toBe(false);
  expect(unchangedTest('[AC-2] x b', changed)).toBe(true);
});

const mod = (path: string, text: string): Module => {
  const [closure] = relativeClosure(
    path,
    (p) => (p === path ? text : null),
    () => true,
  );
  return closure as Module;
};

it('[CT-06p] relativeClosure follows relative code files the test code names, within the walk', () => {
  const files: Record<string, string> = {
    'test/spec/a/x.test.ts':
      "import { h } from './helpers.ts';\nimport { y } from '../../../apps/api/src/y.ts';\nconst u = new URL('./data.csv', import.meta.url);",
    'test/spec/a/helpers.ts': "export { k } from './deep/k.js';",
    'test/spec/a/deep/k.ts': 'export const k = 1;',
    'apps/api/src/y.ts': 'export const y = 1;',
  };
  const closure = relativeClosure(
    'test/spec/a/x.test.ts',
    (p) => files[p] ?? null,
    (p) => p.startsWith('test/'),
  );
  expect(closure.map((m) => m.path)).toEqual([
    'test/spec/a/x.test.ts',
    'test/spec/a/helpers.ts',
    'test/spec/a/deep/k.ts',
  ]);
});

it('[CT-06p] mayReadSupport: a support file named, loaded, listed or named after the test counts', () => {
  const file = 'test/spec/l/rules.test.ts';
  const plain = mod(file, "import { it } from 'vitest';\nit('x', () => {});");
  expect(mayReadSupport(file, 'test/spec/m/expected.csv', [plain])).toBeNull();
  expect(
    mayReadSupport(file, 'test/spec/l/expected.csv', [
      mod(file, "const u = new URL('./expected.csv', import.meta.url);"),
    ]),
  ).toContain('names expected.csv');
  expect(
    mayReadSupport(file, 'test/spec/l/expected.csv', [mod(file, "load(`${dir}/${'expected'}`);")]),
  ).toContain('names expected');
  expect(
    mayReadSupport(file, 'test/spec/l/rows.csv', [
      mod(file, 'for (const f of readdirSync(here)) load(f);'),
    ]),
  ).toContain('readdirSync');
  expect(
    mayReadSupport(file, 'test/spec/l/rows.csv', [
      mod(file, 'const m = await import(`./${n}.ts`);'),
    ]),
  ).toContain('computed name');
  expect(
    mayReadSupport(file, 'test/spec/l/rows.csv', [
      mod(file, 'const r = createRequire(import.meta.url);'),
    ]),
  ).toContain('createRequire');
  expect(
    mayReadSupport(file, 'test/spec/l/helpers.ts', [plain, mod('test/spec/l/helpers.ts', '')]),
  ).toContain('loads test/spec/l/helpers.ts');
  expect(mayReadSupport(file, 'test/spec/l/__snapshots__/rules.test.ts.snap', [plain])).toContain(
    'named after it',
  );
  expect(
    mayReadSupport(file, 'test/spec/l/__screenshots__/rules.test.ts/x.png', [plain]),
  ).toContain('named after it');
  // CT-06r (B1-12g): a same-named test in another directory is another test, not a snapshot.
  expect(mayReadSupport(file, 'test/spec/other/rules.test.ts', [plain])).toBeNull();
  expect(
    mayReadSupport(file, 'test/spec/other/__snapshots__/rules.test.ts.snap', [plain]),
  ).toBeNull();
  expect(mayReadSupport(file, 'test/spec/l/sub/rules.test.ts.snap', [plain])).toContain(
    'named after it',
  );
  expect(mayReadSupport(file, 'test/spec/l/rows.csv', [mod(file, "it('open\n")])).toContain(
    'cannot be read as code',
  );
  // A literal dynamic import is fine; an unrelated word is fine.
  expect(
    mayReadSupport(file, 'test/spec/l/rows.csv', [
      mod(file, "await import('./other.ts'); 'rowsx';"),
    ]),
  ).toBeNull();
});

// CT-06r (after B1-12g): directory listings are resolved statically; only a listing of a directory
// that holds the support file (or one that cannot be resolved) makes the test file read it.
const FIXTURES = join(import.meta.dirname, 'red-check-fixtures');
const listed = (path: string, text: string) => listedDirectories(tokenize(text), path);

it('[CT-06r] listedDirectories resolves literals, constants, path.join / resolve / dirname, URLs and function parameters', () => {
  const file = 'test/spec/platform/queue/contract.test.ts';
  // The B1-12g shape: constants from import.meta.url, a recursive helper called twice.
  expect(
    listed(
      file,
      `import path from 'node:path';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const API_SRC = path.resolve(HERE, '../../../../apps/api/src');
const QUEUE_DIR = path.join(API_SRC, 'modules/platform/queue');
function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return tsFiles(full);
    return [full];
  });
}
const a = tsFiles(API_SRC);
const b = tsFiles(QUEUE_DIR);
`,
    ),
  ).toEqual({ dirs: ['apps/api/src', 'apps/api/src/modules/platform/queue'], unresolved: null });
  // Literals, __dirname, import.meta.dirname, new URL, join / resolve with literal segments, a
  // parenthesised expression, .pathname of a URL, an arrow function parameter.
  expect(
    listed(
      'test/spec/a/x.test.ts',
      `const ROOT = new URL('../../', import.meta.url);
const D1 = join(__dirname, 'data');
const D2 = resolve(import.meta.dirname, '..', 'shared');
readdirSync(D1, { withFileTypes: true });
readdirSync((D2));
readdirSync(new URL('./seeds/', ROOT).pathname);
readdirSync(fileURLToPath(new URL('./pages', import.meta.url)));
const list = (p: string) => { for (const e of readdirSync(new URL(p, ROOT))) use(e); };
list('./db/migrations');
`,
    ),
  ).toEqual({
    dirs: [
      'test/db/migrations',
      'test/seeds',
      'test/spec/a/data',
      'test/spec/a/pages',
      'test/spec/shared',
    ],
    unresolved: null,
  });
  // Not resolved: a computed directory, a parameter never called from outside, a bare literal
  // without ./ (the working directory is unknown), a path above the repository, a listing inside a
  // template expression, a call without arguments.
  const cases: [string, string][] = [
    ['readdirSync(process.cwd());', 'cannot be resolved statically'],
    // Codex review r1, S2: a file-system path literal is relative to the working directory, which
    // is not known — not to the module.
    ["readdirSync('./fixtures');", 'cannot be resolved statically'],
    ["readdirSync('./test/spec/a/data');", 'cannot be resolved statically'],
    ["readdirSync(join('./x', 'data'));", 'cannot be resolved statically'],
    ["function f(d) { return readdirSync(d); }\nf('./data');", 'cannot be resolved statically'],
    // Codex review r1, S2: a constant whose initialiser goes on past the resolved part is unknown.
    [
      "const D = new URL('./unused/', import.meta.url).pathname.replace('unused', 'data');\nreaddirSync(D);",
      'cannot be resolved statically',
    ],
    ["const D = join(__dirname, 'a') + '/b';\nreaddirSync(D);", 'cannot be resolved statically'],
    ["const D = join(__dirname, 'a').slice(1);\nreaddirSync(D);", 'cannot be resolved statically'],
    // Codex review r3, S2: a name declared twice (a same-named local elsewhere) is no constant.
    [
      "const D = join(__dirname, 'data');\nfunction unused() { const D = join(__dirname, 'other'); }\nreaddirSync(D);",
      'cannot be resolved statically',
    ],
    // Codex review r3, S2: a recursive call that may leave the listed tree is not resolved.
    [
      "function scan(d, up) { const rows = readdirSync(d); if (up) scan(dirname(d), false); return rows; }\nscan(join(__dirname, 'data'), true);",
      'cannot be resolved statically',
    ],
    [
      "function scan(d) { for (const n of readdirSync(d)) scan(join(__dirname, n)); }\nscan(join(__dirname, 'data'));",
      'cannot be resolved statically',
    ],
    // Codex review r2, S2: a reassigned name is no constant.
    [
      "let D = join(__dirname, 'a');\nD = somewhere();\nreaddirSync(D);",
      'cannot be resolved statically',
    ],
    [
      'function f(d) { return readdirSync(d); }',
      'in f() on a directory that cannot be resolved statically',
    ],
    ["readdirSync('db/migrations');", 'cannot be resolved statically'],
    ["readdirSync(join(__dirname, '../../../../../..'));", 'cannot be resolved statically'],
    ['const x = `${readdirSync(dir).length}`;', 'inside a template expression'],
    ['opendirSync();', 'without a directory'],
    [
      'function f(d) { return readdirSync(d); }\nf(dirOf(x));',
      'in f() on a directory that cannot be resolved statically',
    ],
  ];
  for (const [text, reason] of cases) {
    const r = listed('test/spec/a/x.test.ts', text);
    expect(r.unresolved, text).toContain(reason);
  }
  // A recursive call stays in the tree: the parameter itself, join(param, …), a local const of it.
  for (const body of [
    'scan(d)',
    'scan(join(d, n))',
    'scan(path.join(d, n))',
    'const full = path.join(d, n); scan(full)',
  ]) {
    expect(
      listed(
        'test/spec/a/x.test.ts',
        `function scan(d) { for (const n of readdirSync(d)) { ${body}; } }\nscan(join(__dirname, 'data'));`,
      ),
      body,
    ).toEqual({ dirs: ['test/spec/a/data'], unresolved: null });
  }
  // Codex review r2, S2: a parameter shadows a same-named constant; the call site decides.
  expect(
    listed(
      'test/spec/a/x.test.ts',
      "const dir = join(__dirname, 'unused');\nfunction load(dir) { return readdirSync(dir); }\nload(join(__dirname, 'data'));",
    ),
  ).toEqual({ dirs: ['test/spec/a/data'], unresolved: null });
  // … and a call site inside another function whose parameter shadows the constant is unresolved.
  expect(
    listed(
      'test/spec/a/x.test.ts',
      "const dir = join(__dirname, 'unused');\nfunction load(d) { return readdirSync(d); }\nfunction outer(dir) { return load(dir); }",
    ).unresolved,
  ).toContain('cannot be resolved statically');
  // The repository root: `new URL('../../../', import.meta.url)` from test/spec/a resolves to ''.
  expect(
    listed(
      'test/spec/a/x.test.ts',
      "readdirSync(new URL('../../../', import.meta.url), { recursive: true });",
    ),
  ).toEqual({ dirs: [''], unresolved: null });
  // A resolved call next to an unresolved one: the resolved directory is kept, the reason too.
  const mixed = listed(
    'test/spec/a/x.test.ts',
    "readdirSync(join(__dirname, 'data')); readdirSync(somewhere);",
  );
  expect(mixed.dirs).toEqual(['test/spec/a/data']);
  expect(mixed.unresolved).toContain('cannot be resolved statically');
  // No listing at all.
  expect(listed('test/spec/a/x.test.ts', "it('x', () => {});")).toEqual({
    dirs: [],
    unresolved: null,
  });
});

it('[CT-06r] mayReadSupport: a listed directory counts only for the files it holds; an unresolved listing counts for everything', () => {
  const file = 'test/spec/l/rules.test.ts';
  const lists = mod(
    file,
    "const D = join(__dirname, 'data');\nfor (const f of readdirSync(D)) load(f);",
  );
  expect(lists.lists).toEqual(['test/spec/l/data']);
  expect(mayReadSupport(file, 'test/spec/l/data/rows.csv', [lists])).toBe(
    `${file} lists test/spec/l/data, which holds test/spec/l/data/rows.csv`,
  );
  expect(mayReadSupport(file, 'test/spec/l/data/deep/rows.csv', [lists])).toContain(
    'lists test/spec/l/data',
  );
  expect(mayReadSupport(file, 'test/spec/l/other.csv', [lists])).toBeNull();
  expect(mayReadSupport(file, 'test/spec/l/rows.csv', [lists])).toBeNull();
  // The word rule of CT-06p is untouched: a support file named like a literal still counts.
  expect(mayReadSupport(file, 'test/spec/l/data.csv', [lists])).toContain('names data');
  // Codex review r2, S2: a listing of the repository root ('') holds every file.
  const root = mod(
    file,
    "for (const f of readdirSync(new URL('../../../', import.meta.url), { recursive: true })) load(f);",
  );
  expect(root.lists).toEqual(['']);
  expect(mayReadSupport(file, 'test/spec/m/other.csv', [root])).toBe(
    `${file} lists , which holds test/spec/m/other.csv`,
  );
  const vague = mod(file, 'for (const f of readdirSync(here)) load(f);');
  expect(mayReadSupport(file, 'test/spec/m/other.csv', [vague])).toBe(
    `${file} may read test/spec/m/other.csv: it uses readdirSync(…) on a directory that cannot be resolved statically`,
  );
});

it('[CT-06r] the two B1-12g files: a same-named test elsewhere and a listing of apps/api/src no longer make them whole', () => {
  const read = (p: string): string => readFileSync(join(FIXTURES, `b112g-${p}.txt`), 'utf8');
  const files: Record<string, string> = {
    'test/spec/platform/events/contract.test.ts': read('events-contract.test.ts'),
    'test/spec/platform/queue/contract.test.ts': read('queue-contract.test.ts'),
    'test/spec/platform/events/kit.ts': read('events-kit.ts'),
    'test/spec/platform/queue/kit.ts': read('queue-kit.ts'),
    'test/spec/platform/db/kit.ts': read('db-kit.ts'),
  };
  const closureOf = (file: string) =>
    relativeClosure(
      file,
      (p) => files[p] ?? null,
      (p) => p.startsWith('test/'),
    );
  // What B1-12g changed inside its test_paths besides each file itself.
  const supports = [
    'test/spec/platform/events/contract.test.ts',
    'test/spec/platform/queue/contract.test.ts',
    ...[
      'consumer.int.test.ts',
      'db-kit.ts',
      'delivery.int.test.ts',
      'fixtures.ts',
      'render.test.ts',
      'templates.int.test.ts',
      'wiring.test.ts',
      'worker-kit.ts',
    ].map((n) => `test/spec/notification/risk-state-message/${n}`),
  ];
  const events = 'test/spec/platform/events/contract.test.ts';
  const queue = 'test/spec/platform/queue/contract.test.ts';
  const eventsClosure = closureOf(events);
  const queueClosure = closureOf(queue);
  expect(eventsClosure.map((m) => m.path)).toEqual([
    events,
    'test/spec/platform/events/kit.ts',
    'test/spec/platform/queue/kit.ts',
  ]);
  expect(queueClosure.map((m) => m.path)).toEqual([
    queue,
    'test/spec/platform/db/kit.ts',
    'test/spec/platform/queue/kit.ts',
  ]);
  // ① events/contract.test.ts: queue/contract.test.ts is another test, not its snapshot.
  for (const s of supports) {
    if (s !== events) expect(mayReadSupport(events, s, eventsClosure), s).toBeNull();
  }
  // ② queue/contract.test.ts lists apps/api/src and its queue module only.
  expect(queueClosure[0]?.lists).toEqual(['apps/api/src', 'apps/api/src/modules/platform/queue']);
  expect(queueClosure[0]?.dynamic).toBeNull();
  for (const s of supports) {
    if (s !== queue) expect(mayReadSupport(queue, s, queueClosure), s).toBeNull();
  }
  // A file under the listed tree would still count.
  expect(
    mayReadSupport(queue, 'apps/api/src/modules/platform/queue/zz-added.ts', queueClosure),
  ).toBe(
    `${queue} lists apps/api/src, which holds apps/api/src/modules/platform/queue/zz-added.ts`,
  );
});

// CT-06w (B1-12g red/4): the two platform contract tests import `./kit.ts` of their own
// directory; the task changed test/spec/identity/step-up-verify/kit.ts. The name rule matched
// the basename `kit.ts` and judged 27 unchanged tests whole.
const B112G_R4_FILES = (): Record<string, string> => {
  const read = (p: string): string => readFileSync(join(FIXTURES, `b112g-${p}.txt`), 'utf8');
  return {
    // The implementation modules the fixtures import (outside the test code: not followed).
    ...Object.fromEntries(B112G_IMPL.map((p) => [p, ''])),
    'test/spec/platform/events/contract.test.ts': read('events-contract.test.ts'),
    'test/spec/platform/queue/contract.test.ts': read('queue-contract.test.ts'),
    'test/spec/platform/events/kit.ts': read('events-kit.ts'),
    'test/spec/platform/queue/kit.ts': read('queue-kit.ts'),
    'test/spec/platform/db/kit.ts': read('db-kit.ts'),
    'test/spec/identity/step-up-verify/kit.ts': read('identity-step-up-verify-kit.ts'),
  };
};
const B112G_IMPL = [
  'events/index.ts',
  'logging/redaction.ts',
  'logging/logger.ts',
  'queue/index.ts',
  'db/index.ts',
  'config/index.ts',
].map((p) => `apps/api/src/modules/platform/${p}`);
/** What B1-12g changed inside its test_paths at red/4 (couli-runs/B1-12g/red/4). */
const B112G_R4_SUPPORTS = [
  'test/spec/platform/events/contract.test.ts',
  'test/spec/platform/queue/contract.test.ts',
  'test/spec/platform/idempotency/abandon-route/http-kit.ts',
  'test/spec/identity/identity-level/http-kit.ts',
  'test/spec/identity/sms-codes/http-kit.ts',
  'test/spec/identity/step-up-verify/kit.ts',
  ...[
    'consumer.int.test.ts',
    'db-kit.ts',
    'delivery.int.test.ts',
    'fixtures.ts',
    'reauth.int.test.ts',
    'render.test.ts',
    'templates.int.test.ts',
    'wiring.test.ts',
    'worker-kit.ts',
  ].map((n) => `test/spec/notification/risk-state-message/${n}`),
];

it('[CT-06w] the two B1-12g files (red/4): `./kit.ts` of their own directory is not the identity kit the task changed', () => {
  const files = B112G_R4_FILES();
  const closureOf = (file: string) =>
    relativeClosure(
      file,
      (p) => files[p] ?? null,
      (p) => p.startsWith('test/'),
    );
  const events = 'test/spec/platform/events/contract.test.ts';
  const queue = 'test/spec/platform/queue/contract.test.ts';
  const eventsClosure = closureOf(events);
  const queueClosure = closureOf(queue);
  // The imports resolve to the files of their own directories; a package stays unresolved.
  const resolved = (c: readonly Module[]) =>
    Object.fromEntries((c[0] as Module).imports.map((i) => [i.spec, i.resolved]));
  expect(resolved(eventsClosure)).toMatchObject({
    './kit.ts': 'test/spec/platform/events/kit.ts',
    '../queue/kit.ts': 'test/spec/platform/queue/kit.ts',
    vitest: null,
  });
  expect(resolved(queueClosure)).toMatchObject({
    './kit.ts': 'test/spec/platform/queue/kit.ts',
    '../db/kit.ts': 'test/spec/platform/db/kit.ts',
  });
  expect((eventsClosure[0] as Module).imports.find((i) => i.spec === 'vitest')?.why).toBe(
    'a package (a bare specifier; tsconfig paths are not used by Vitest here)',
  );
  // The identity kit is in neither closure.
  expect(eventsClosure.map((m) => m.path)).toEqual([
    events,
    'test/spec/platform/events/kit.ts',
    'test/spec/platform/queue/kit.ts',
  ]);
  expect(queueClosure.map((m) => m.path)).toEqual([
    queue,
    'test/spec/platform/db/kit.ts',
    'test/spec/platform/queue/kit.ts',
  ]);
  // The kits are closed (no file-system access, import.meta, mock, listing or unread import).
  for (const m of [...eventsClosure.slice(1), ...queueClosure.slice(1)]) {
    expect([m.path, m.closed, m.opaque]).toEqual([m.path, true, null]);
  }
  // The roots (r6): events/contract.test.ts is closed; queue/contract.test.ts reads apps/api/src
  // itself (readdirSync / readFileSync from import.meta.url) — not closed, but those reads are
  // judged on its own text by the name and listing rules, so it masks nothing either way
  // (unjudged null) and the closure-wide fallback does not apply.
  expect([eventsClosure[0]?.closed, eventsClosure[0]?.unjudged]).toEqual([true, null]);
  expect([queueClosure[0]?.closed, queueClosure[0]?.unjudged, queueClosure[0]?.lists]).toEqual([
    false,
    null,
    ['apps/api/src', 'apps/api/src/modules/platform/queue'],
  ]);
  // The 27 unchanged tests of red/4: neither file may read any changed support file.
  for (const s of B112G_R4_SUPPORTS) {
    if (s !== events) expect(mayReadSupport(events, s, eventsClosure), s).toBeNull();
    if (s !== queue) expect(mayReadSupport(queue, s, queueClosure), s).toBeNull();
  }
});

it('[CT-06w] the same `./kit.ts` that the task did change still makes the file whole', () => {
  const files = B112G_R4_FILES();
  const events = 'test/spec/platform/events/contract.test.ts';
  const closure = relativeClosure(
    events,
    (p) => files[p] ?? null,
    (p) => p.startsWith('test/'),
  );
  expect(mayReadSupport(events, 'test/spec/platform/events/kit.ts', closure)).toBe(
    'it loads test/spec/platform/events/kit.ts',
  );
  expect(mayReadSupport(events, 'test/spec/platform/queue/kit.ts', closure)).toBe(
    'it loads test/spec/platform/queue/kit.ts',
  );
  // A support file the closure does not follow (data) counts through the resolved import.
  const file = 'test/spec/l/rules.test.ts';
  const rows: Record<string, string> = {
    [file]: "import rows from './rows.json';",
    'test/spec/l/rows.json': '[]',
  };
  const data = relativeClosure(
    file,
    (p) => rows[p] ?? null,
    (p) => p.startsWith('test/'),
  );
  expect(mayReadSupport(file, 'test/spec/l/rows.json', data)).toBe(
    `${file} imports test/spec/l/rows.json (./rows.json)`,
  );
  // A code file that `follow` keeps out of the closure counts the same way.
  const kept = relativeClosure(
    file,
    (p) => ({ [file]: "import { k } from './kit.ts';", 'test/spec/l/kit.ts': '' })[p] ?? null,
    () => false,
  );
  expect(kept.map((m) => m.path)).toEqual([file]);
  expect(mayReadSupport(file, 'test/spec/l/kit.ts', kept)).toBe(
    `${file} imports test/spec/l/kit.ts (./kit.ts)`,
  );
});

it('[CT-06w] an import that cannot be resolved keeps the name rules, and the reason says so', () => {
  const file = 'test/spec/l/rules.test.ts';
  const support = 'test/spec/identity/step-up-verify/kit.ts';
  // A package whose specifier carries the name: not a repository file, so it counts as before.
  const pkg = mod(file, "import { k } from 'fixtures-pkg/kit.ts';");
  expect(mayReadSupport(file, support, [pkg])).toBe(
    `${file} names kit.ts in an unresolved import fixtures-pkg/kit.ts (a package (a bare specifier; tsconfig paths are not used by Vitest here))`,
  );
  // A relative import of a file that does not exist at the head.
  const gone = mod(file, "import { k } from './kit.ts';");
  expect((gone.imports[0] as ModuleImport).resolved).toBeNull();
  expect(mayReadSupport(file, support, [gone])).toBe(
    `${file} names kit.ts in an unresolved import ./kit.ts (no file at test/spec/l/kit.ts)`,
  );
  // The word rule the same way (an extension-less specifier).
  const word = mod(file, "import { k } from 'fixtures-pkg/kit';");
  expect(mayReadSupport(file, support, [word])).toBe(
    `${file} names kit in an unresolved import fixtures-pkg/kit (a package (a bare specifier; tsconfig paths are not used by Vitest here))`,
  );
  // One that leaves the repository.
  const out = mod('test/x.test.ts', "import { k } from '../../kit.ts';");
  expect(mayReadSupport('test/x.test.ts', support, [out])).toBe(
    `test/x.test.ts names kit.ts in an unresolved import ../../kit.ts (it leaves the repository)`,
  );
  // A template specifier, vi.mock and new URL are not imports: the name rules apply unchanged.
  const files: Record<string, string> = { 'test/spec/l/kit.ts': '' };
  const other = (text: string) =>
    relativeClosure(
      file,
      (p) => (p === file ? text : (files[p] ?? null)),
      (p) => p.startsWith('test/'),
    );
  expect(mayReadSupport(file, support, other('const m = await import(`./kit.ts`);'))).toBe(
    `${file} names kit.ts`,
  );
  expect(mayReadSupport(file, support, other("vi.mock('./kit.ts', () => ({}));"))).toBe(
    `${file} names kit.ts`,
  );
  expect(mayReadSupport(file, support, other("new URL('./kit.ts', import.meta.url);"))).toBe(
    `${file} names kit.ts`,
  );
  // The name elsewhere in the file (a comment, another literal) still counts even when the
  // import of the same name resolves to another file.
  expect(
    mayReadSupport(file, support, other("import { k } from './kit.ts'; // see kit.ts of identity")),
  ).toBe(`${file} names kit.ts`);
  expect(
    mayReadSupport(file, support, other("import { k } from './kit.ts';\nload('../identity/kit');")),
  ).toBe(`${file} names kit`);
  // Resolved to another file, nothing else names it: not this support file.
  expect(mayReadSupport(file, support, other("import { k } from './kit.ts';"))).toBeNull();
  expect(mayReadSupport(file, support, other("import { k } from './kit';"))).toBeNull();
  expect(mayReadSupport(file, support, other("export * from './kit.js';"))).toBeNull();
  expect(mayReadSupport(file, support, other("const k = await import('./kit.ts');"))).toBeNull();
  expect(mayReadSupport(file, support, other("import './kit.ts?raw';"))).toBeNull();
});

it('[CT-06w] `#…` imports resolve through the nearest package.json where one entry is certain; a bare specifier is a package', () => {
  const file = 'test/spec/l/rules.test.ts';
  const support = 'test/spec/identity/step-up-verify/kit.ts';
  const base: Record<string, string> = {
    'test/kits/kit.ts': '',
    'test/kits/data/kit.ts': '',
    'test/other/kit.ts': '',
    'test/support/kit.ts': '',
    'test/package.json': JSON.stringify({
      imports: {
        '#kits/*': './kits/*.ts',
        '#one': './kits/kit.ts',
        '#cond': { default: './kits/kit.ts' },
        '#pkg': 'some-package',
        '#up': '../tsconfig.json',
        // Codex reviews r1, r2: Node and Vite's resolver rank two matching patterns differently
        // (longest prefix vs longest key): not decided here.
        '#same/*': './other/kit.ts',
        '#same/*.ts': './support/kit.ts',
        '#folder/': './other/',
        // Codex review r1: only the first `#` belongs to the specifier, the rest is a fragment.
        '#kit.ts': './support/kit.ts',
        '#kit.ts#preview': './other/kit.ts',
      },
    }),
    // tsconfig paths are not consulted (Vitest does not enable them here).
    'tsconfig.json': JSON.stringify({
      compilerOptions: { baseUrl: '.', paths: { '@kits/*': ['test/kits/*'] } },
    }),
  };
  const closure = (text: string, files = base) =>
    relativeClosure(
      file,
      (p) => (p === file ? text : (files[p] ?? null)),
      (p) => p.startsWith('test/'),
    );
  const imports = (text: string, files = base) =>
    (closure(text, files)[0] as Module).imports.map((i) => [i.spec, i.resolved, i.why]);
  expect(
    imports(
      [
        "import { a } from '#kits/kit';",
        "import { b } from '#one';",
        "import { c } from '#cond';",
        "import { d } from '#none';",
        "import { e } from '#pkg';",
        "import { f } from '#same/kit.ts';",
        "import { g } from '#kit.ts#preview';",
        "import { h } from '#one?raw';",
        "import { i } from '#folder/kit.ts';",
        "import { j } from '#up';",
        "import { k } from '#kits/';",
      ].join('\n'),
    ),
  ).toEqual([
    ['#kits/kit', 'test/kits/kit.ts', null],
    ['#one', 'test/kits/kit.ts', null],
    ['#cond', null, 'test/package.json imports #cond is conditional'],
    ['#none', null, 'test/package.json maps no imports entry to #none'],
    ['#pkg', null, 'test/package.json imports #pkg is not a plain ./ path'],
    ['#same/kit.ts', null, 'test/package.json cannot decide the imports entry for #same/kit.ts'],
    ['#kit.ts#preview', 'test/support/kit.ts', null],
    ['#one?raw', 'test/kits/kit.ts', null],
    [
      '#folder/kit.ts',
      null,
      'test/package.json cannot decide the imports entry for #folder/kit.ts',
    ],
    ['#up', null, 'test/package.json imports #up is not a plain ./ path'],
    ['#kits/', null, 'test/package.json cannot decide the imports entry for #kits/'],
  ]);
  // `#same/kit.ts` is undecided and names the support file: whole; `#kit.ts#preview` loads it.
  expect(
    mayReadSupport(file, 'test/support/kit.ts', closure("import { f } from '#same/kit.ts';")),
  ).toBe(
    `${file} names kit.ts in an unresolved import #same/kit.ts (test/package.json cannot decide the imports entry for #same/kit.ts)`,
  );
  expect(
    mayReadSupport(file, 'test/support/kit.ts', closure("import { g } from '#kit.ts#preview';")),
  ).toBe('it loads test/support/kit.ts');
  expect(imports("import { a } from '@kits/kit';\nimport { b } from 'vitest';")).toEqual([
    ['@kits/kit', null, 'a package (a bare specifier; tsconfig paths are not used by Vitest here)'],
    ['vitest', null, 'a package (a bare specifier; tsconfig paths are not used by Vitest here)'],
  ]);
  expect(mayReadSupport(file, support, closure("import { a } from '@kits/kit';"))).toBe(
    `${file} names kit in an unresolved import @kits/kit (a package (a bare specifier; tsconfig paths are not used by Vitest here))`,
  );
  // Resolved elsewhere: not the identity kit; a resolved `#` import is followed.
  const c = closure("import { a } from '#kits/kit';\nimport { b } from '#kits/data/kit';");
  expect(c.map((m) => m.path)).toEqual([file, 'test/kits/kit.ts', 'test/kits/data/kit.ts']);
  expect(mayReadSupport(file, support, c)).toBeNull();
  expect(mayReadSupport(file, 'test/kits/kit.ts', c)).toBe('it loads test/kits/kit.ts');
  // A package.json that cannot be parsed: unresolved, conservative.
  const broken = { ...base, 'test/package.json': '{ imports: }' };
  expect(imports("import { a } from '#one';", broken)).toEqual([
    ['#one', null, 'test/package.json cannot be parsed'],
  ]);
  expect(mayReadSupport(file, support, closure("import { a } from '#kit.ts';", broken))).toBe(
    `${file} names kit.ts in an unresolved import #kit.ts (test/package.json cannot be parsed)`,
  );
  // Codex review r2: a nearer package.json that is not a regular file (a symbolic link) stops the
  // search — the runtime would read it, the gate cannot.
  const linked: Record<string, string> = {
    ...base,
    'test/spec/l/package.json': '../../../config/imports.json',
  };
  const kinds = (p: string): PathKind =>
    p === 'test/spec/l/package.json' ? 'other' : linked[p] === undefined ? 'absent' : 'file';
  const viaLink = relativeClosure(
    file,
    (p) => (p === file ? "import { a } from '#kit.ts';" : (linked[p] ?? null)),
    (p) => p.startsWith('test/'),
    kinds,
  );
  expect((viaLink[0] as Module).imports[0]?.why).toBe(
    'test/spec/l/package.json is not a regular file',
  );
  expect(mayReadSupport(file, 'test/spec/l/support/kit.ts', viaLink)).toBe(
    `${file} names kit.ts in an unresolved import #kit.ts (test/spec/l/package.json is not a regular file)`,
  );
});

it('[CT-06w] a relative import resolves only where one file is certain (Codex reviews r1, r2)', () => {
  const file = 'test/spec/a/rules.test.ts';
  const support = 'test/spec/identity/step-up-verify/kit.ts';
  const closure = (text: string, files: Record<string, string>, kindOf?: (p: string) => PathKind) =>
    relativeClosure(
      file,
      (p) => (p === file ? text : (files[p] ?? null)),
      (p) => p.startsWith('test/'),
      kindOf,
    );
  const why = (text: string, files: Record<string, string>, kindOf?: (p: string) => PathKind) =>
    (closure(text, files, kindOf)[0] as Module).imports.map((i) => i.resolved ?? i.why);
  /** An in-memory tree with directories and `other` paths (symbolic links) marked. */
  const tree = (files: Record<string, string>, dirs: string[] = [], others: string[] = []) => {
    const kindOf = (p: string): PathKind =>
      others.includes(p)
        ? 'other'
        : dirs.includes(p)
          ? 'dir'
          : files[p] === undefined
            ? 'absent'
            : 'file';
    return { files, kindOf };
  };
  // `./kit` with both kit.js and kit.ts: Vite picks one by its extension order; not certain here.
  expect(
    why("import { k } from './kit';", { 'test/spec/a/kit.js': '', 'test/spec/a/kit.ts': '' }),
  ).toEqual(['test/spec/a/kit is ambiguous (test/spec/a/kit.js, test/spec/a/kit.ts)']);
  // `./kit` with only kit.ts: that file; a directory with only index.ts: that file; both: ambiguous.
  expect(why("import { k } from './kit';", { 'test/spec/a/kit.ts': '' })).toEqual([
    'test/spec/a/kit.ts',
  ]);
  const dirIndex = tree({ 'test/spec/a/kit/index.ts': '' }, ['test/spec/a/kit']);
  expect(why("import { k } from './kit';", dirIndex.files, dirIndex.kindOf)).toEqual([
    'test/spec/a/kit/index.ts',
  ]);
  const both = tree({ 'test/spec/a/kit.ts': '', 'test/spec/a/kit/index.ts': '' }, [
    'test/spec/a/kit',
  ]);
  expect(why("import { k } from './kit';", both.files, both.kindOf)).toEqual([
    'test/spec/a/kit is ambiguous (test/spec/a/kit.ts, test/spec/a/kit/index.ts)',
  ]);
  // Without kinds, a directory is unknown to the in-memory tree: its index is not found.
  expect(why("import { k } from './kit';", { 'test/spec/a/kit/index.ts': '' })).toEqual([
    'no file at test/spec/a/kit',
  ]);
  // A directory with a package.json: its entry decides, not resolved here.
  const pkgDir = tree(
    { 'test/spec/a/kit/package.json': '{"main":"./kit.ts"}', 'test/spec/a/kit/index.ts': '' },
    ['test/spec/a/kit'],
  );
  expect(why("import { k } from './kit';", pkgDir.files, pkgDir.kindOf)).toEqual([
    'test/spec/a/kit is a package directory (test/spec/a/kit/package.json)',
  ]);
  // Codex review r2: `./kit?raw` with a file called `kit` next to kit.ts loads `kit` itself.
  expect(
    why("import raw from './kit?raw';", { 'test/spec/a/kit': 'rows', 'test/spec/a/kit.ts': '' }),
  ).toEqual(['test/spec/a/kit']);
  expect(
    mayReadSupport(
      file,
      'test/spec/a/kit',
      closure("import raw from './kit?raw';", {
        'test/spec/a/kit': 'rows',
        'test/spec/a/kit.ts': '',
      }),
    ),
  ).toBe(`${file} imports test/spec/a/kit (./kit?raw)`);
  // `./kit.js`: the .js file when it exists, else the .ts file; `./kit.jsx` is not rewritten.
  expect(
    why("import { k } from './kit.js';", { 'test/spec/a/kit.js': '', 'test/spec/a/kit.ts': '' }),
  ).toEqual(['test/spec/a/kit.js']);
  expect(why("import { k } from './kit.js';", { 'test/spec/a/kit.ts': '' })).toEqual([
    'test/spec/a/kit.ts',
  ]);
  expect(why("import { k } from './kit.jsx';", { 'test/spec/a/kit.tsx': '' })).toEqual([
    'no file at test/spec/a/kit.jsx',
  ]);
  // In each uncertain case the name rules apply as before.
  expect(
    mayReadSupport(
      file,
      support,
      closure("import { k } from './kit';", {
        'test/spec/a/kit.js': '',
        'test/spec/a/kit.ts': '',
      }),
    ),
  ).toBe(
    `${file} names kit in an unresolved import ./kit (test/spec/a/kit is ambiguous (test/spec/a/kit.js, test/spec/a/kit.ts))`,
  );
  // Codex reviews r1, r2: a path that is a directory or `other` (a symbolic link, a path whose
  // spelling is not the tree's) is no file, and a candidate of kind `other` on the way makes the
  // whole resolution uncertain — a rejected candidate is not an absent one.
  const links = tree(
    {
      'test/spec/a/kit.json/data/kit.json': '{}',
      'test/spec/a/link.ts': '../real/kit.ts',
      'test/spec/a/kit.js': '../real/kit.js',
      'test/spec/a/kit.ts': '',
      'test/spec/real/kit.ts': '',
      'test/spec/real/kit.js': '',
    },
    ['test/spec/a/kit.json'],
    ['test/spec/a/link.ts', 'test/spec/a/kit.js', 'test/spec/a/alias/kit.json'],
  );
  expect(why("import data from './kit.json';", links.files, links.kindOf)).toEqual([
    'test/spec/a/kit.json is a directory',
  ]);
  expect(
    mayReadSupport(
      file,
      'test/spec/a/kit.json/data/kit.json',
      closure("import data from './kit.json';", links.files, links.kindOf),
    ),
  ).toBe(
    `${file} names kit.json in an unresolved import ./kit.json (test/spec/a/kit.json is a directory)`,
  );
  expect(why("import { k } from './link.ts';", links.files, links.kindOf)).toEqual([
    'test/spec/a/link.ts is not a regular file',
  ]);
  expect(
    mayReadSupport(
      file,
      'test/spec/real/kit.ts',
      closure("import { k } from './link.ts';", links.files, links.kindOf),
    ),
  ).toBe('test/spec/a/link.ts names kit.ts'); // the closure still follows the link's own text
  // `./kit` where kit.js is a link and kit.ts a file: Vite would follow the link; not decided.
  expect(why("import { k } from './kit';", links.files, links.kindOf)).toEqual([
    'test/spec/a/kit.js is not a regular file',
  ]);
  expect(
    mayReadSupport(
      file,
      'test/spec/real/kit.js',
      closure("import { k } from './kit';", links.files, links.kindOf),
    ),
  ).toBe(
    `${file} names kit in an unresolved import ./kit (test/spec/a/kit.js is not a regular file)`,
  );
  // A path through a directory link (a work tree spelling that is not the tree's).
  expect(why("import data from './alias/kit.json';", links.files, links.kindOf)).toEqual([
    'test/spec/a/alias/kit.json is not a regular file',
  ]);
  // Without kinds the in-memory tree is all files (the tests above).
  expect(why("import data from './kit.json';", links.files)).toEqual([
    'no file at test/spec/a/kit.json',
  ]);
});

it('[CT-06w] only the import and export syntax makes a string an import specifier (Codex reviews r1, r2)', () => {
  const file = 'test/spec/a/rules.test.ts';
  const files: Record<string, string> = {
    'test/spec/a/data/rows.json': '[]',
    'test/spec/a/kit.ts': '',
  };
  const closure = (text: string) =>
    relativeClosure(
      file,
      (p) => (p === file ? text : (files[p] ?? null)),
      (p) => p.startsWith('test/'),
    );
  const specs = (text: string) => (closure(text)[0] as Module).imports.map((i) => i.spec);
  // Imports and re-exports in every spelling.
  expect(
    specs(
      [
        "import './kit.ts';",
        "import k from './kit.ts';",
        "import * as ns from './kit.ts';",
        "import k2, { a } from './kit.ts';",
        "import type { T } from './kit.ts';",
        "export * from './kit.ts';",
        "export * as all from './kit.ts';",
        "export { a } from './kit.ts';",
        "const m = await import('./kit.ts');",
        "import('./data/rows.json', { with: { type: 'json' } });",
      ].join('\n'),
    ),
  ).toEqual([...Array<string>(9).fill('./kit.ts'), './data/rows.json']);
  // Not imports: member calls, object keys, a string after a `from` variable, template expressions.
  expect(
    specs("const reader = { import: (p: string) => p };\nreader.import('./data/rows.json');"),
  ).toEqual([]);
  expect(specs("reader?.import('./data/rows.json');")).toEqual([]);
  expect(specs("x.from('./data/rows.json');")).toEqual([]);
  expect(specs("const q = { from: './data/rows.json' };")).toEqual([]);
  expect(specs("const from = '';\nconst u = `${from}${'./data/rows.json'}`;")).toEqual([]);
  expect(specs("const u = `${a}${from}${'./data/rows.json'}`;")).toEqual([]);
  expect(specs("const m = `${await import('./kit.ts')}`;")).toEqual([]);
  expect(specs("import.meta.resolve('./kit.ts');")).toEqual([]);
  expect(specs("vi.importActual('./kit.ts');")).toEqual([]);
  // The task changed test/data/rows.json: the member call and the template read it by a computed
  // path; nothing is masked, the name rule still fires (Codex reviews r1, r2).
  expect(
    mayReadSupport(
      file,
      'test/data/rows.json',
      closure(
        "const reader = { import: (p: string) => readFileSync(new URL(p, new URL('../../', import.meta.url)), 'utf8') };\nreader.import('./data/rows.json');",
      ),
    ),
  ).toBe(`${file} names rows.json`);
  expect(
    mayReadSupport(
      file,
      'test/data/rows.json',
      closure(
        "const from = '';\nreadFileSync(new URL(`${from}${'./data/rows.json'}`, new URL('../../', import.meta.url)), 'utf8');",
      ),
    ),
  ).toBe(`${file} names rows.json`);
});

it('[CT-06w] `#…` entries the runtime may expand differently stay unresolved (Codex review r3)', () => {
  const file = 'test/spec/l/rules.test.ts';
  const files: Record<string, string> = {
    'test/other/kit.ts': '',
    'test/other/index.ts': '',
    'test/support/kit.ts': '',
    'test/data/kit.json': '{}',
    'test/package.json': JSON.stringify({
      imports: {
        // Vite's resolver builds an unescaped RegExp from a pattern: `#k.t.*` matches `#kit.ts`.
        '#kit.*': './other/kit.ts',
        '#k.t.*': './support/kit.ts',
        // A folder value: the resolver appends the rest; a literal `*` in an exact entry's value.
        '#kits/*': './other/',
        '#star': './other/*/kit.ts',
        // A query the loader strips.
        '#kit.json': './data/kit.json?raw',
        // Plain entries resolve.
        '#plain/*': './support/*.ts',
        '#exact': './support/kit.ts',
      },
    }),
  };
  const imports = (text: string) =>
    (
      relativeClosure(
        file,
        (p) => (p === file ? text : (files[p] ?? null)),
        (p) => p.startsWith('test/'),
      )[0] as Module
    ).imports.map((i) => [i.spec, i.resolved, i.why]);
  expect(
    imports(
      [
        "import { a } from '#kit.ts';",
        "import { b } from '#kits/kit.ts';",
        "import { c } from '#star';",
        "import { d } from '#kit.json';",
        "import { e } from '#plain/kit';",
        "import { f } from '#exact';",
      ].join('\n'),
    ),
  ).toEqual([
    ['#kit.ts', null, 'test/package.json cannot decide the imports entry for #kit.ts'],
    ['#kits/kit.ts', null, 'test/package.json cannot decide the imports entry for #kits/kit.ts'],
    ['#star', null, 'test/package.json imports #star is not a plain ./ path'],
    ['#kit.json', null, 'test/package.json cannot decide the imports entry for #kit.json'],
    ['#plain/kit', 'test/support/kit.ts', null],
    ['#exact', 'test/support/kit.ts', null],
  ]);
});

it('[CT-06w] an import resolved to a file the closure does not follow keeps the name rules (Codex review r3)', () => {
  const file = 'test/spec/a/rules.browser.test.ts';
  const files: Record<string, string> = {
    'test/spec/a/theme.css': "@import '../real/theme.css';",
    'test/spec/a/kit': "export * from '../real/kit.ts';",
    'test/spec/a/rows.json': '[]',
    'test/spec/real/theme.css': '',
    'test/spec/real/kit.ts': '',
    'apps/api/src/x.ts': '',
  };
  const closure = (text: string) =>
    relativeClosure(
      file,
      (p) => (p === file ? text : (files[p] ?? null)),
      (p) => p.startsWith('test/'),
    );
  // A style sheet (its @import is not read here), an extension-less module (not code to the
  // closure), a data file, a module outside the test code: resolved, not followed, still named.
  const css = closure("import './theme.css';");
  expect((css[0] as Module).imports[0]?.resolved).toBe('test/spec/a/theme.css');
  expect(css.map((m) => m.path)).toEqual([file]);
  expect(mayReadSupport(file, 'test/spec/real/theme.css', css)).toBe(
    `${file} names theme.css in an unresolved import ./theme.css (test/spec/a/theme.css is not followed by the closure)`,
  );
  expect(mayReadSupport(file, 'test/spec/real/kit.ts', closure("import { k } from './kit';"))).toBe(
    `${file} names kit in an unresolved import ./kit (test/spec/a/kit is not followed by the closure)`,
  );
  expect(
    mayReadSupport(file, 'test/other/rows.json', closure("import rows from './rows.json';")),
  ).toBe(
    `${file} names rows.json in an unresolved import ./rows.json (test/spec/a/rows.json is not followed by the closure)`,
  );
  expect(
    mayReadSupport(
      file,
      'test/spec/real/x.ts',
      closure("import { x } from '../../../apps/api/src/x.ts';"),
    ),
  ).toBe(
    `${file} names x.ts in an unresolved import ../../../apps/api/src/x.ts (apps/api/src/x.ts is not followed by the closure)`,
  );
  // The resolved file itself as the support file still counts by its path.
  expect(mayReadSupport(file, 'test/spec/a/theme.css', css)).toBe(
    `${file} imports test/spec/a/theme.css (./theme.css)`,
  );
});

it('[CT-06w] only an import of a closed module is skipped by the name rules (Codex review r4)', () => {
  const file = 'test/spec/a/rules.test.ts';
  const support = 'test/spec/real/kit.ts';
  const files: Record<string, string> = {
    'test/spec/a/bridge': "export { n } from '../real/kit.ts';",
    'test/spec/a/__mocks__/kit.ts': '',
    'test/spec/a/payload.txt': 'rows',
    'apps/api/src/x.ts': '',
    'test/spec/a/plain.ts': "import { x } from '../../../apps/api/src/x.ts';\nexport const n = x;",
    'test/spec/a/chain.ts': "export { n } from './plain.ts';",
    'test/spec/real/kit.ts': '',
  };
  const closure = (text: string, kit: string) =>
    relativeClosure(
      file,
      (p) => (p === file ? text : p === 'test/spec/a/kit.ts' ? kit : (files[p] ?? null)),
      (p) => p.startsWith('test/'),
    );
  const root = "import { n } from './kit.ts';";
  const why = (kit: string) => mayReadSupport(file, support, closure(root, kit));
  const prefix = `${file} names kit.ts in an unresolved import ./kit.ts (test/spec/a/kit.ts is not closed: `;
  // A helper that reads a file by a path built from import.meta.url, with no name literal.
  expect(
    why(
      "import { readFileSync } from 'node:fs';\nexport const n = readFileSync(new URL(import.meta.url.replace('/a/', '/real/')), 'utf8');",
    ),
  ).toBe(`${prefix}it uses readFileSync)`);
  expect(why('export const n = import.meta.url;')).toBe(`${prefix}it uses import.meta)`);
  expect(why("import fs from 'fs';\nexport const n = fs;")).toBe(`${prefix}it uses fs)`);
  expect(why("import { vi } from 'vitest';\nvi.mock('./x.ts');\nexport const n = 1;")).toBe(
    `${prefix}it uses vi.mock)`,
  );
  // A listing (its directory resolved or not) and a dynamic load.
  expect(
    why(
      "import { readdirSync } from 'node:fs';\nexport const n = readdirSync(new URL('../d%61ta/', import.meta.url));",
    ),
  ).toBe(`${prefix}it lists test/spec/d%61ta)`);
  expect(why("export const n = await import(`./${'x'}.ts`);")).toBe(
    `${prefix}it imports a module by a computed name)`,
  );
  // A two-step re-export through an extension-less module the closure does not read.
  expect(why("export { n } from './bridge';")).toBe(
    `${prefix}it imports test/spec/a/bridge, which is not read here)`,
  );
  expect(why("export { n } from './gone.ts';")).toBe(
    `${prefix}it imports ./gone.ts, which cannot be resolved)`,
  );
  // A raw import of a file not read here.
  expect(why("import raw from './payload.txt?raw';\nexport const n = raw;")).toBe(
    `${prefix}it imports test/spec/a/payload.txt, which is not read here)`,
  );
  // Closed: a plain module, a chain of plain modules, implementation and package imports.
  expect(why('export const n = 1;')).toBeNull();
  expect(why("export { n } from './chain.ts';")).toBeNull();
  expect(
    why(
      "import { it } from 'vitest';\nimport { x } from '../../../apps/api/src/x.ts';\nexport const n = [it, x];",
    ),
  ).toBeNull();
  // The closure records why a module is not closed, transitively.
  const c = closure(root, "export { n } from './bridge';");
  expect(c.map((m) => [m.path, m.closed, m.opaque])).toEqual([
    [file, false, 'it imports test/spec/a/kit.ts, which is not closed'],
    ['test/spec/a/kit.ts', false, 'it imports test/spec/a/bridge, which is not read here'],
  ]);
  // `vi.mock(import('./kit.ts'))` is a mock, not a load: the specifier keeps the name rules.
  expect(
    mayReadSupport(
      file,
      'test/spec/a/__mocks__/kit.ts',
      closure(
        "import { vi } from 'vitest';\nvi.mock(import('./kit.ts'));\nimport { n } from './kit.ts';",
        'export const n = 1;',
      ),
    ),
  ).toBe(`${file} names kit.ts`);
});

it('[CT-06w] execution, absolute or template loads and mocks keep a module open; a mocking root masks nothing (Codex review r5)', () => {
  const file = 'test/spec/a/rules.test.ts';
  const support = 'test/spec/real/kit.ts';
  const files: Record<string, string> = {
    'test/spec/a/bridge.ts': 'export const n = 1;',
    'test/spec/a/__mocks__/bridge.ts': "export { n } from '../../real/kit.ts';",
    'test/spec/a/__mocks__/kit.ts': '',
    'test/spec/real/bridge.ts': "export { n } from './kit.ts';",
    'test/spec/real/kit.ts': '',
    'test/package.json': JSON.stringify({ imports: { '#payload': './spec/real/kit.ts' } }),
  };
  const closure = (text: string, kit: string) =>
    relativeClosure(
      file,
      (p) => (p === file ? text : p === 'test/spec/a/kit.ts' ? kit : (files[p] ?? null)),
      (p) => p.startsWith('test/'),
    );
  const root = "import { n } from './kit.ts';";
  const why = (kit: string) => mayReadSupport(file, support, closure(root, kit));
  const prefix = `${file} names kit.ts in an unresolved import ./kit.ts (test/spec/a/kit.ts is not closed: `;
  // A helper that runs a process, evaluates code or starts a worker.
  expect(
    why(
      "import { execFileSync } from 'node:child_process';\nexport const n = execFileSync('cat', ['spec/real/' + ['ki', 't.ts'].join('')], { encoding: 'utf8' });",
    ),
  ).toBe(`${prefix}it uses execFileSync)`);
  expect(why('export const n = eval("process.getBuiltinModule(\'fs\')");')).toBe(
    `${prefix}it uses eval)`,
  );
  expect(why("export const n = new Worker(new URL('./w.ts', import.meta.url));")).toBe(
    `${prefix}it uses Worker)`,
  );
  expect(why("import vm from 'node:vm';\nexport const n = vm;")).toBe(`${prefix}it uses node:vm)`);
  expect(why("export const n = await import('node:fs');")).toBe(`${prefix}it uses node:fs)`);
  // A workspace package is test code the closure does not follow, not a package.
  expect(why("import { x } from '@couli/money';\nexport const n = x;")).toBe(
    `${prefix}it imports @couli/money, a workspace package not read here)`,
  );
  // An absolute specifier (Vite resolves it against the project root) is not a package.
  expect(why("export { n } from '/spec/real/bridge.ts';")).toBe(
    `${prefix}it imports /spec/real/bridge.ts, which cannot be resolved)`,
  );
  // A template specifier and an import inside a template expression are loads not in `imports`.
  expect(why('export const n = (await import(`#payload`)).n;')).toBe(
    `${prefix}it imports a module by a template)`,
  );
  expect(why("export const n = `${(await import('#payload')).n}`;")).toBe(
    `${prefix}it imports inside a template)`,
  );
  // A helper that mocks through the `vitest` namespace or any `.mock(` call.
  expect(
    why(
      "import { vitest } from 'vitest';\nvitest.mock('./bridge.ts');\nexport { n } from './bridge.ts';",
    ),
  ).toBe(`${prefix}it uses vitest.mock)`);
  expect(
    why(
      "import { vi as m } from 'vitest';\nm.mock('./bridge.ts');\nexport { n } from './bridge.ts';",
    ),
  ).toBe(`${prefix}it uses m.mock)`);
  // `spy.mock.calls` is a property, not a mock registration: still closed.
  expect(
    why(
      "import { vi } from 'vitest';\nconst spy = vi.fn();\nexport const n = spy.mock.calls.length;",
    ),
  ).toBeNull();
  // A root that mocks (in any spelling) masks nothing: its imports may be redirected.
  for (const mocking of [
    "vi.mock((import('./kit.ts')));",
    "vi.mock(await import('./kit.ts'));",
    "vi.mock('./bridge.ts');",
    "vitest.doMock('./bridge.ts');",
  ]) {
    const c = closure(
      `import { vi, vitest } from 'vitest';\n${mocking}\nimport { n } from './kit.ts';`,
      "export { n } from './bridge.ts';",
    );
    expect(mayReadSupport(file, support, c), mocking).toBe(
      `${file} names kit.ts in an unresolved import ./kit.ts (${file} mocks modules (${c[0]?.mocking}))`,
    );
    expect(mayReadSupport(file, 'test/spec/a/__mocks__/kit.ts', c), mocking).toBe(
      `${file} names kit.ts in an unresolved import ./kit.ts (${file} mocks modules (${c[0]?.mocking}))`,
    );
  }
});

// The old rules of CT-06p / CT-06r, as on origin/main before CT-06w: the support file is named
// anywhere in a module's text, or its stem is a word of a literal.
const oldNameRule = (closure: readonly Module[], support: string): boolean => {
  const name = support.slice(support.lastIndexOf('/') + 1);
  const stem = name.includes('.') ? name.slice(0, name.lastIndexOf('.')) : name;
  const word = new RegExp(
    `(?<![\\w$.-])${stem.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}(?![\\w$-])`,
    'u',
  );
  return closure.some(
    (m) => m.text.includes(name) || (m.literals ?? []).some((l) => word.test(l.text)),
  );
};

// A module text for each clause of the closed definition that makes a module open (CT-06w).
const OPEN_MODULES: [string, string][] = [
  [
    'a file-system API',
    "import { readFileSync } from 'node:fs';\nexport const n = readFileSync('x', 'utf8');",
  ],
  ['import.meta', 'export const n = import.meta.url;'],
  ['a mock', "import { vi } from 'vitest';\nvi.mock('./x.ts');\nexport const n = 1;"],
  [
    'a process',
    "import { spawnSync } from 'node:child_process';\nexport const n = spawnSync('cat');",
  ],
  ['eval', "export const n = eval('1');"],
  ['a Worker', "export const n = new Worker('w.js');"],
  ['a listing', "import { readdirSync } from 'node:fs';\nexport const n = readdirSync('.');"],
  ['a computed import', 'export const n = await import(`./${"x"}.ts`);'],
  ['a template specifier', 'export const n = await import(`./x.ts`);'],
  ['an absolute specifier', "export { n } from '/spec/a/other.ts';"],
  ['an unresolved import', "export { n } from './missing.ts';"],
  ['a workspace package', "import { x } from '@couli/testing';\nexport const n = x;"],
  ['a file not read here', "import raw from './data.txt?raw';\nexport const n = raw;"],
  ['unreadable code', "it('open"],
  ['vm', "import vm from 'node:vm';\nexport const n = vm;"],
  ['worker_threads', "import { Worker as W } from 'node:worker_threads';\nexport const n = W;"],
  ['module', "import m from 'node:module';\nexport const n = m;"],
  ['require', "export const n = require('./x.cjs');"],
  ['glob', "export const n = globSync('*.ts');"],
  ['Function', "export const n = new Function('return 1')();"],
  ['getBuiltinModule', "export const n = process.getBuiltinModule('node:fs');"],
  ['process.binding', "export const n = process.binding('fs');"],
  ['wasi', "import { WASI } from 'node:wasi';\nexport const n = WASI;"],
  [
    'vitest.doMock',
    "import { vitest } from 'vitest';\nvitest.doMock('./x.ts');\nexport const n = 1;",
  ],
  ['a .mock( call', "export const n = helper.mock('./x.ts');"],
  ['an import inside a template', "export const n = `${await import('./other.ts')}`;"],
  // Codex review r6: capabilities spelled another way.
  [
    'fetch (browser mode: Vite serves the work tree)',
    "export const n = async () => (await fetch('/spec/real/' + ['ki', 't.ts'].join(''))).text();",
  ],
  ['XMLHttpRequest', 'export const n = new XMLHttpRequest();'],
  ['WebSocket', 'export const n = WebSocket;'],
  ['document', "export const n = document.createElement('script');"],
  ['process by a computed key', "export const n = process['getBuilt' + 'inModule'];"],
  ['process as a value', "export const n = Reflect.get(process, 'x');"],
  ['globalThis by a computed key', "export const n = globalThis[['ev', 'al'].join('')];"],
  [
    'a capability name as a key',
    "export const n = (o: Record<string, unknown>) => o['readFileSync'];",
  ],
  ['a module name built from pieces', "export const n = 'node:f' + 's';"],
  ['the Function constructor', 'export const n = (() => 0).constructor;'],
  ['getPrototypeOf', 'export const n = Object.getPrototypeOf(() => 0);'],
  ['vi?.doMock', "import { vi } from 'vitest';\nvi?.doMock('./x.ts');\nexport const n = 1;"],
  [
    'vi by a computed key',
    "import { vi } from 'vitest';\nvi['do' + 'Mock']('./x.ts');\nexport const n = 1;",
  ],
  [
    'a destructured mock',
    "import { vi } from 'vitest';\nconst { doMock } = vi;\ndoMock('./x.ts');\nexport const n = 1;",
  ],
  ['vi as a value', "import { vi } from 'vitest';\nexport const n = Reflect.get(vi, 'x');"],
  [
    'browser commands',
    "import { commands } from '@vitest/browser/context';\nexport const n = commands;",
  ],
  ['node:inspector', "import { Session } from 'node:inspector';\nexport const n = Session;"],
  // Codex review r7.
  ['a destructured constructor', 'const { constructor: C } = () => 0;\nexport const n = C;'],
  ['a constructor shorthand', 'const { constructor } = () => 0;\nexport const n = constructor;'],
  [
    'a capability name after +',
    "const empty = '';\nexport const n = Reflect.get(() => 0, empty + 'constructor');",
  ],
  [
    'node:inspector/promises',
    "import { Session } from 'node:inspector/promises';\nexport const n = Session;",
  ],
  ['node:test', "import t from 'node:test';\nexport const n = t;"],
  [
    'an aliased optional mock call',
    "import { vi as v } from 'vitest';\nv.doMock?.('./x.ts');\nexport const n = 1;",
  ],
  // Codex review r8: an ordinary package that reads files, or any package not known not to.
  [
    'a package that reads files (prettier)',
    "import { resolveConfig } from 'prettier';\nexport const n = () => resolveConfig('x.ts');",
  ],
  ['typescript', "import ts from 'typescript';\nexport const n = ts;"],
  ['an unknown package', "import x from 'some-package';\nexport const n = x;"],
  ['vitest/node', "import { createVitest } from 'vitest/node';\nexport const n = createVitest;"],
  // Codex review r9: file APIs of listed packages, and a subpath that is not listed.
  [
    'a file snapshot',
    "import { expect } from 'vitest';\nexport const n = (v: string) => expect(v).toMatchFileSnapshot('./fixtures/out.txt');",
  ],
  [
    "Kysely's migration loader",
    "import { FileMigrationProvider } from 'kysely';\nexport const n = FileMigrationProvider;",
  ],
  ['kysely/migration', "import { Migrator } from 'kysely/migration';\nexport const n = Migrator;"],
  // Codex review r10: file APIs of an allowed surface.
  ['process.loadEnvFile', "export const n = () => process.loadEnvFile('fixtures/x.env');"],
  ['a process property not listed', 'export const n = process.report;'],
  [
    'a test attachment',
    "import type { TestContext } from 'vitest';\nexport const n = (ctx: TestContext) => ctx.annotate('in', { path: 'fixtures/x.txt' });",
  ],
  ['recordArtifact', 'export const n = (ctx: { recordArtifact: unknown }) => ctx.recordArtifact;'],
];

it('[CT-06w] fallback: a closure with one module that is not closed judges exactly like the old code (orchestrator ruling 2026-10-19)', () => {
  const file = 'test/spec/a/rules.test.ts';
  const support = 'test/spec/identity/step-up-verify/kit.ts';
  const base: Record<string, string> = {
    'test/spec/a/kit.ts': "export { n } from './deep/kit.ts';",
    'test/spec/a/deep/kit.ts': 'export const n = 1;',
    'test/spec/a/other.ts': 'export const o = 2;',
    'apps/api/src/x.ts': '',
  };
  const closure = (
    files: Record<string, string>,
    text = "import { n } from './kit.ts';\nimport { o } from './other.ts';",
  ) =>
    relativeClosure(
      file,
      (p) => (p === file ? text : (files[p] ?? null)),
      (p) => p.startsWith('test/'),
    );
  // All closed: the specifier is exempt (the one relaxation); the old rule would have fired.
  const closed = closure(base);
  expect(closed.map((m) => m.closed)).toEqual([true, true, true, true]);
  expect(oldNameRule(closed, support)).toBe(true);
  expect(mayReadSupport(file, support, closed)).toBeNull();
  // One module anywhere in the closure not closed (the deepest one here, in every way the
  // definition names): the judgement falls back to the old rules — whole, as the old code.
  const open = OPEN_MODULES;
  for (const [what, deep] of open) {
    const c = closure({ ...base, 'test/spec/a/deep/kit.ts': deep, 'test/spec/a/data.txt': '' });
    expect(
      c.map((m) => m.path),
      what,
    ).toEqual([file, 'test/spec/a/kit.ts', 'test/spec/a/other.ts', 'test/spec/a/deep/kit.ts']);
    expect(
      c.slice(1, 2).map((m) => m.closed),
      what,
    ).toEqual([false]);
    expect(oldNameRule(c, support), what).toBe(true);
    const why = mayReadSupport(file, support, c);
    expect(why, what).toMatch(
      /^test\/spec\/a\/rules\.test\.ts names kit\.ts in an unresolved import \.\/kit\.ts \(test\/spec\/a\/kit\.ts is not closed: /,
    );
  }
  // A root that mocks: whole, as the old code, whatever its imports resolve to.
  const mocking = closure(
    base,
    "import { vi } from 'vitest';\nvi.mock('./other.ts');\nimport { n } from './kit.ts';",
  );
  expect(oldNameRule(mocking, support)).toBe(true);
  expect(mayReadSupport(file, support, mocking)).toBe(
    `${file} names kit.ts in an unresolved import ./kit.ts (${file} mocks modules (it uses vi.mock))`,
  );
  // And where the old rule would not fire, neither does the new one (no new whole judgements
  // from the exemption itself; a closed closure without the name is free either way).
  const free = closure(base, "import { o } from './other.ts';");
  expect(oldNameRule(free, support)).toBe(false);
  expect(mayReadSupport(file, support, free)).toBeNull();
});

it('[CT-06w] fallback, closure-wide: a module the file loads that is not closed, or a way of the file itself no rule judges, masks no specifier (orchestrator ruling 2026-10-19, r6)', () => {
  const file = 'test/spec/a/rules.test.ts';
  const support = 'test/spec/identity/step-up-verify/kit.ts';
  const base: Record<string, string> = {
    'test/spec/a/kit.ts': 'export const n = 1;',
    'test/spec/a/other.ts': 'export const o = 2;',
    'test/spec/a/data.txt': '',
    'apps/api/src/x.ts': '',
  };
  const root = "import { n } from './kit.ts';\nimport { o } from './other.ts';";
  const closure = (files: Record<string, string>, text = root) =>
    relativeClosure(
      file,
      (p) => (p === file ? text : (files[p] ?? null)),
      (p) => p.startsWith('test/'),
    );
  const at = (c: readonly Module[], p: string) => c.find((m) => m.path === p);
  // All closed: the specifier is exempt (the one relaxation).
  expect(mayReadSupport(file, support, closure(base))).toBeNull();
  // A module the specifier does not name (a sibling) not closed, in every way the definition
  // names: ./kit.ts itself is closed, yet the specifier counts — whole, as the old code.
  for (const [what, sibling] of OPEN_MODULES) {
    const c = closure({ ...base, 'test/spec/a/other.ts': sibling });
    expect(
      [at(c, 'test/spec/a/kit.ts')?.closed, at(c, 'test/spec/a/other.ts')?.closed],
      what,
    ).toEqual([true, false]);
    expect(oldNameRule(c, support), what).toBe(true);
    expect(mayReadSupport(file, support, c), what).toMatch(
      /^test\/spec\/a\/rules\.test\.ts names kit\.ts in an unresolved import \.\/kit\.ts \(test\/spec\/a\/other\.ts is not closed: /,
    );
  }
  // The rule-test file itself, with a way to files that no rule here judges on its own text:
  // whole, as the old code (a mock: its own reason, as before).
  const unjudged: [string, string][] = [
    ['eval', "export const e = eval('1');"],
    ['Function', "export const e = new Function('return 1')();"],
    ['a process', "import { execSync } from 'node:child_process';\nexecSync('cat');"],
    ['a Worker', "export const w = new Worker('w.js');"],
    ['vm', "import vm from 'node:vm';\nexport const v = vm;"],
    ['getBuiltinModule', "export const f = process.getBuiltinModule('node:fs');"],
    ['require', "export const r = require('./x.cjs');"],
    ['a computed import', 'export const d = await import(`./${"x"}.ts`);'],
    ['a template specifier', 'export const d = await import(`./x.ts`);'],
    ['an absolute specifier', "import '/spec/a/other.ts';"],
    ['an unresolved import', "import './missing.ts';"],
    ['a workspace package', "import '@couli/testing';"],
    ['a file not read here', "import raw from './data.txt?raw';"],
    ['a mock', "import { vi } from 'vitest';\nvi.mock('./other.ts');"],
  ];
  for (const [what, own] of unjudged) {
    const c = closure(base, `${root}\n${own}`);
    expect(c[0]?.unjudged, what).not.toBeNull();
    expect(oldNameRule(c, support), what).toBe(true);
    expect(mayReadSupport(file, support, c), what).toMatch(
      /^test\/spec\/a\/rules\.test\.ts names kit\.ts in an unresolved import \.\/kit\.ts \(test\/spec\/a\/rules\.test\.ts (is not closed|mocks modules)/,
    );
  }
  // Its own file-system reads, path helpers, import.meta and listings resolved statically are
  // judged on its own text by the name and listing rules, as before CT-06w (B1-12g:
  // queue/contract.test.ts reads apps/api/src this way): they block nothing …
  const head =
    "import path from 'node:path';\nimport { fileURLToPath } from 'node:url';\n" +
    "import { readFileSync, readdirSync, statSync } from 'node:fs';\n" +
    'const HERE = path.dirname(fileURLToPath(import.meta.url));\n';
  const reads = closure(
    base,
    `${root}\n${head}export const l = readdirSync(path.resolve(HERE, '../../../apps/api/src'));\n` +
      'export const t = l.map((f) => statSync(f) && readFileSync(f, "utf8"));',
  );
  expect([reads[0]?.closed, reads[0]?.unjudged, reads[0]?.lists]).toEqual([
    false,
    null,
    ['apps/api/src'],
  ]);
  expect(mayReadSupport(file, support, reads)).toBeNull();
  // … but a listing of the support file's directory, or its name in another literal, still
  // makes the file whole.
  const listing = closure(
    base,
    `${root}\n${head}export const l = readdirSync(path.resolve(HERE, '../identity/step-up-verify'));`,
  );
  expect(mayReadSupport(file, support, listing)).toBe(
    `${file} lists test/spec/identity/step-up-verify, which holds ${support}`,
  );
  const named = closure(
    base,
    `${root}\n${head}export const t = readFileSync(path.join(HERE, '../identity/step-up-verify/kit.ts'));`,
  );
  expect(mayReadSupport(file, support, named)).toBe(`${file} names kit.ts`);
});

it('[CT-06w] Codex review r6: a fetch helper, a capability by a string key, an optional mock and a from variable before a string', () => {
  const support = 'test/spec/real/kit.ts';
  const judge = (file: string, files: Record<string, string>) =>
    mayReadSupport(
      file,
      support,
      relativeClosure(
        file,
        (p) => files[p] ?? null,
        (p) => p.startsWith('test/'),
      ),
    );
  // Browser mode: the helper fetches the support file from the Vite server.
  const browser = 'test/spec/a/rules.browser.test.ts';
  expect(
    judge(browser, {
      [browser]:
        "import { it, expect } from 'vitest';\nimport { read } from './kit.ts';\nit('[AC-1#1] old', async () => { expect(await read()).toContain('n = 1'); });",
      'test/spec/a/kit.ts':
        "export async function read() { return (await fetch('/spec/real/' + ['ki', 't.ts'].join('') + '?raw')).text(); }\n",
    }),
  ).toBe(
    `${browser} names kit.ts in an unresolved import ./kit.ts (test/spec/a/kit.ts is not closed: it uses fetch)`,
  );
  // process['getBuiltinModule'] and a string key: the helper is not closed.
  const file = 'test/spec/a/rules.test.ts';
  expect(
    judge(file, {
      [file]:
        "import { it, expect } from 'vitest';\nimport { read } from './kit.ts';\nit('[AC-2#1] old', () => { expect(read()).toContain('n = 1'); });",
      'test/spec/a/kit.ts':
        "const io = process['getBuiltinModule']('node:f' + 's') as { 'readFileSync': (p: string, e: 'utf8') => string };\nexport const read = () => io['readFileSync']('spec/real/' + ['ki', 't.ts'].join(''), 'utf8');\n",
    }),
  ).toMatch(
    /^test\/spec\/a\/rules\.test\.ts names kit\.ts in an unresolved import \.\/kit\.ts \(test\/spec\/a\/kit\.ts is not closed: it uses /,
  );
  // vi?.doMock in the rule-test file: it mocks, nothing is masked.
  expect(
    judge(file, {
      [file]:
        "import { it, expect, vi } from 'vitest';\nvi?.doMock('./' + ['ki', 't.ts'].join(''));\nconst { n } = await import('./kit.ts');\nit('[AC-3#1] old', () => { expect(n).toBe(1); });",
      'test/spec/a/kit.ts': 'export const n = 0;\n',
      'test/spec/a/__mocks__/kit.ts': "export { n } from '../../real/kit.ts';\n",
    }),
  ).toBe(
    `${file} names kit.ts in an unresolved import ./kit.ts (${file} mocks modules (it uses vi.doMock))`,
  );
  // `void from` and a string on the next line (ASI): no import, the literal is a name.
  const asi =
    "import { readFileSync } from 'node:fs';\nimport { it, expect } from 'vitest';\nit('[AC-4#1] old', () => {\n  const from = 0;\n  void from\n  './kit.ts'.split(',').forEach((p) => { expect(readFileSync('spec/real/' + p.slice(2), 'utf8')).toContain('n = 1'); });\n});";
  const files: Record<string, string> = {
    [file]: asi,
    'test/spec/a/kit.ts': 'export const n = 0;\n',
  };
  const closure = relativeClosure(
    file,
    (p) => files[p] ?? null,
    (p) => p.startsWith('test/'),
  );
  expect((closure[0] as Module).imports.map((i) => i.spec)).toEqual(['node:fs', 'vitest']);
  expect(mayReadSupport(file, support, closure)).toBe(`${file} names kit.ts`);
});

it('[CT-06w] import and export declarations are read forward from the keyword (Codex review r6)', () => {
  const file = 'test/spec/a/rules.test.ts';
  const specs = (text: string) =>
    (
      relativeClosure(
        file,
        (p) => (p === file ? text : p === 'test/spec/a/kit.ts' ? '' : null),
        (p) => p.startsWith('test/'),
      )[0] as Module
    ).imports.map((i) => i.spec);
  for (const text of [
    "import from from './kit.ts';",
    "import type from './kit.ts';",
    "export type { T } from './kit.ts';",
    "import { 'a-b' as c } from './kit.ts';",
    "export * as 'x' from './kit.ts';",
    "import j from './kit.ts' with { type: 'json' };",
    "import k, * as ns from './kit.ts';",
    "import {\n  a,\n  b,\n} from\n'./kit.ts';",
    "if (x) { await import('./kit.ts'); }",
    "import type T from './kit.ts';",
    "import type, { a } from './kit.ts';",
    "export type * as T from './kit.ts';",
  ]) {
    expect(specs(text), text).toEqual(['./kit.ts']);
  }
  for (const text of [
    "const from = 0;\nvoid from\n'./kit.ts'.split(',');",
    "export { a }\n'./kit.ts'.split(',');",
    "declare module 'm' { export * from './kit.ts'; }",
    "function f() { const from = 1; return from\n'./kit.ts'; }",
    "import x = require('./kit.ts');",
    "export default from\n'./kit.ts';",
    "const anchor = 0, from = 0;\nexport { anchor }\nvoid from\n'./kit.ts'.split(',');",
    "export type T = typeof from\n'./kit.ts';",
  ]) {
    expect(specs(text), text).toEqual([]);
  }
});

it('[CT-06w] Codex review r7: constructor in any spelling but a definition, a mock call on any receiver, an export clause ends at its brace', () => {
  const file = 'test/spec/a/rules.test.ts';
  const support = 'test/spec/real/kit.ts';
  const closureOf = (files: Record<string, string>) =>
    relativeClosure(
      file,
      (p) => files[p] ?? null,
      (p) => p.startsWith('test/'),
    );
  const root =
    "import { it, expect } from 'vitest';\nimport { read } from './kit.ts';\nit('[AC-r7#1] old', async () => { expect(await read()).toContain('export const'); });";
  // A helper that takes the Function constructor by destructuring.
  expect(
    mayReadSupport(
      file,
      support,
      closureOf({
        [file]: root,
        'test/spec/a/kit.ts':
          'const { constructor: C } = () => 0;\nexport const read = () => C(\'return process.getBuiltinModule("fs").readFileSync("spec/real/" + "ki" + "t.ts", "utf8")\')();\n',
      }),
    ),
  ).toBe(
    `${file} names kit.ts in an unresolved import ./kit.ts (test/spec/a/kit.ts is not closed: it uses constructor)`,
  );
  // A class with a constructor definition and a spy's .mock.calls stay closed.
  const closed = closureOf({
    [file]: root,
    'test/spec/a/kit.ts':
      "import { vi } from 'vitest';\nexport class A {\n  x: number;\n  constructor(x: number) {\n    this.x = x;\n  }\n}\nconst spy = vi.fn();\nexport const read = async () => String(spy.mock.calls.length);\n",
  });
  expect(closed.map((m) => [m.path, m.closed, m.opaque])).toEqual([
    [file, true, null],
    ['test/spec/a/kit.ts', true, null],
  ]);
  expect(mayReadSupport(file, support, closed)).toBeNull();
  // `vi as v` and `v.doMock?.(…)` in the rule-test file: it mocks.
  expect(
    mayReadSupport(
      file,
      support,
      closureOf({
        [file]:
          "import { it, expect, vi as v } from 'vitest';\nv.doMock?.('./' + ['ki', 't.ts'].join(''));\nconst { n } = await import('./kit.ts');\nit('[AC-r7#1] old', () => { expect(n).toBeGreaterThanOrEqual(0); });",
        'test/spec/a/kit.ts': 'export const n = -1;\n',
      }),
    ),
  ).toBe(
    `${file} names kit.ts in an unresolved import ./kit.ts (${file} mocks modules (it uses v.doMock))`,
  );
  // `export { anchor }`, then `void from` and a string: the string is a name, not an import.
  const asi = closureOf({
    [file]:
      "import { it, expect } from 'vitest';\nimport { readFileSync } from 'node:fs';\nconst anchor = 0, from = 0;\nexport { anchor }\nvoid from\n'./kit.ts'.split(',').forEach((p) => {\n  it('[AC-r7#1] old', () => {\n    expect(readFileSync('spec/real/' + p, 'utf8')).toContain('export const');\n  });\n});",
    'test/spec/a/kit.ts': 'export const n = -1;\n',
  });
  expect((asi[0] as Module).imports.map((i) => i.spec)).toEqual(['vitest', 'node:fs']);
  expect(mayReadSupport(file, support, asi)).toBe(`${file} names kit.ts`);
});

it('[CT-06w] Codex review r8: only known pure packages keep a module closed; a package that reads files does not', () => {
  const file = 'test/spec/ct06w-format/rules.test.ts';
  const helper = 'test/spec/ct06w-format/package.ts';
  const closureOf = (files: Record<string, string>) =>
    relativeClosure(
      file,
      (p) => files[p] ?? null,
      (p) => p.startsWith('test/'),
    );
  const root =
    "import { expect, it } from 'vitest';\nimport { style } from './package.ts';\nit('[AC-r8#1] semi setting', async () => { expect((await style())?.semi).toBe(false); });";
  // prettier's resolveConfig reads fixtures/package.json: the helper is not closed.
  const read = closureOf({
    [file]: root,
    [helper]:
      "import { resolveConfig } from 'prettier';\nexport const style = () => resolveConfig('spec/ct06w-format/fixtures/input.ts', { useCache: false, editorconfig: false });\n",
  });
  expect([read[1]?.path, read[1]?.closed, read[1]?.opaque]).toEqual([
    helper,
    false,
    'it imports prettier, a package not known to read no files',
  ]);
  expect(mayReadSupport(file, 'test/spec/ct06w-format/fixtures/package.json', read)).toBe(
    `${file} names package in an unresolved import ./package.ts (${helper} is not closed: it imports prettier, a package not known to read no files)`,
  );
  // Built-ins and known pure packages keep it closed (subpaths too, except vitest's).
  const pure = closureOf({
    [file]: root,
    [helper]:
      "import fc from 'fast-check';\nimport { createHash } from 'node:crypto';\nimport path from 'path';\nimport { createRoot } from 'react-dom/client';\nimport { sql } from 'kysely';\nexport const style = async () => [fc, createHash, path, createRoot, sql].length;\n",
  });
  expect(pure.map((m) => m.closed)).toEqual([true, true]);
  expect(mayReadSupport(file, 'test/spec/ct06w-format/fixtures/package.json', pure)).toBeNull();
});

it('[CT-06w] Codex review r9: a file snapshot helper and a migration loader keep the closure open', () => {
  const closureOf = (file: string, files: Record<string, string>) =>
    relativeClosure(
      file,
      (p) => files[p] ?? null,
      (p) => p.startsWith('test/'),
    );
  const snapshot = 'test/spec/r9-snapshot/render.test.ts';
  const snap = closureOf(snapshot, {
    [snapshot]:
      "import { it } from 'vitest';\nimport { matchOutput } from './render.ts';\nit('[AC-r9#1] current output', async () => { await matchOutput('ok\\n'); });",
    'test/spec/r9-snapshot/render.ts':
      "import { basename } from 'node:path';\nimport { expect } from 'vitest';\nexport async function matchOutput(value: string) {\n  const name = basename(expect.getState().testPath!).replace(/\\.test\\.ts$/, '.txt');\n  await expect(value).toMatchFileSnapshot(`./fixtures/${name}`);\n}\n",
  });
  expect(mayReadSupport(snapshot, 'test/spec/r9-snapshot/fixtures/render.txt', snap)).toBe(
    `${snapshot} names render in an unresolved import ./render.ts (test/spec/r9-snapshot/render.ts is not closed: it uses toMatchFileSnapshot)`,
  );
  const migrations = 'test/spec/r9-migrations/rules.test.ts';
  const mig = closureOf(migrations, {
    [migrations]:
      "import { expect, it } from 'vitest';\nimport { promises as fs } from 'node:fs';\nimport path from 'node:path';\nimport { fileURLToPath } from 'node:url';\nimport { load } from './seed.ts';\nconst options = { fs, path, migrationFolder: fileURLToPath(new URL('./fixtures/', import.meta.url)) };\nit('[AC-r9#3] migration exports', async () => { expect(Object.keys(await load(options))).toHaveLength(1); });",
    'test/spec/r9-migrations/seed.ts':
      "import { FileMigrationProvider, type FileMigrationProviderProps } from 'kysely/migration';\nexport function load(options: FileMigrationProviderProps) {\n  return new FileMigrationProvider(options).getMigrations();\n}\n",
  });
  expect(mayReadSupport(migrations, 'test/spec/r9-migrations/fixtures/seed.mjs', mig)).toMatch(
    /^test\/spec\/r9-migrations\/rules\.test\.ts names seed in an unresolved import \.\/seed\.ts \(test\/spec\/r9-migrations\/seed\.ts is not closed: it /,
  );
});

it('[CT-06w] Codex review r10: process.loadEnvFile and a test attachment keep the closure open; listed process properties do not', () => {
  const closureOf = (file: string, files: Record<string, string>) =>
    relativeClosure(
      file,
      (p) => files[p] ?? null,
      (p) => p.startsWith('test/'),
    );
  const env = 'test/spec/r10-env/config.test.ts';
  expect(
    mayReadSupport(
      env,
      'test/spec/r10-env/fixtures/config.env',
      closureOf(env, {
        [env]:
          "import { expect, it } from 'vitest';\nimport { loadExpected } from './config.ts';\nit('[AC-r10#1] existing value', () => { expect(loadExpected()).toBe('ready'); });",
        'test/spec/r10-env/config.ts':
          "import { basename, dirname, join } from 'node:path';\nimport { expect } from 'vitest';\nexport function loadExpected() {\n  const testPath = expect.getState().testPath!;\n  const name = basename(testPath).replace(/\\.test\\.ts$/, '.env');\n  delete process.env['CT06W_EXPECTED'];\n  process.loadEnvFile(join(dirname(testPath), 'fixtures', name));\n  return process.env['CT06W_EXPECTED'];\n}\n",
      }),
    ),
  ).toBe(
    `${env} names config in an unresolved import ./config.ts (test/spec/r10-env/config.ts is not closed: it uses process.loadEnvFile)`,
  );
  const report = 'test/spec/r10-attachment/report.test.ts';
  expect(
    mayReadSupport(
      report,
      'test/spec/r10-attachment/fixtures/report.txt',
      closureOf(report, {
        [report]:
          "import { expect, it } from 'vitest';\nimport { attachFixture } from './report.ts';\nit('[AC-r10#3] existing attachment', async (ctx) => { expect((await attachFixture(ctx)).attachment?.contentType).toBe('text/plain'); });",
        'test/spec/r10-attachment/report.ts':
          "import { basename, dirname, join } from 'node:path';\nimport { expect, type TestContext } from 'vitest';\nexport async function attachFixture(ctx: TestContext) {\n  const testPath = expect.getState().testPath!;\n  const name = basename(testPath).replace(/\\.test\\.ts$/, '.txt');\n  return ctx.annotate('input fixture', { path: join(dirname(testPath), 'fixtures', name) });\n}\n",
      }),
    ),
  ).toBe(
    `${report} names report in an unresolved import ./report.ts (test/spec/r10-attachment/report.ts is not closed: it uses annotate)`,
  );
  // process.pid / process.env and the like stay closed (the B1-12g queue kit reads process.pid).
  const plain = closureOf(env, {
    [env]:
      "import { it } from 'vitest';\nimport { loadExpected } from './config.ts';\nit('x', () => loadExpected());",
    'test/spec/r10-env/config.ts':
      "export const loadExpected = () => [process.pid, process.env['X'], process.platform, process.stdout].length;\n",
  });
  expect(plain.map((m) => m.closed)).toEqual([true, true]);
});

it('[CT-06zxe] valueSkeleton: only literals and unary minus signs may differ', () => {
  const same = (a: string, b: string): boolean =>
    valueSkeleton(a) !== null && valueSkeleton(a) === valueSkeleton(b);
  expect(same('    diff_fen: AMOUNT,', '    diff_fen: -AMOUNT,')).toBe(true);
  expect(same('diff_fen: order.amount_fen,', 'diff_fen: -order.amount_fen,')).toBe(true);
  expect(same('toBe(500n)', 'toBe(-1_500n)')).toBe(true);
  expect(same("status: 'open',", 'status: "closed",')).toBe(true);
  expect(same('x: `a`,', "x: 'b',")).toBe(true);
  expect(same('[1, 2]', '[-1, 0x2]')).toBe(true);
  // A binary minus, another name, a removed or added call, spacing, comments, a template with
  // an expression, an unreadable snippet.
  expect(same('a + 1', 'a - 1')).toBe(false);
  expect(same('a 1', 'a - 1')).toBe(false);
  expect(same('f(x) 1', 'f(x) - 1')).toBe(false);
  expect(same('AMOUNT', 'OTHER')).toBe(false);
  expect(same('AMOUNT', '1n')).toBe(false);
  expect(same('expect(a).toBe(1);', 'expect(a);')).toBe(false);
  expect(same('x: -1', 'x:  1')).toBe(false);
  expect(same('x: 1 // a', 'x: 1 // b')).toBe(false);
  expect(same('`a${b}`', '`a${c}`')).toBe(false);
  expect(valueSkeleton("'unterminated")).toBeNull();
});

it('[CT-06zxe] topLevelHelpers: function declarations and const arrow / function expressions with a block body', () => {
  const source = [
    "import { it } from 'vitest';",
    'async function a(x: number): Promise<{ v: number }> { return { v: x }; }',
    'export function b<T>(x: T) { return x; }',
    'function* g() { yield 1; }',
    'const c = async (x: number) => { return x; };',
    'export const d: (x: number) => number = (x) => { return x; };',
    'const e = function (y) { return y; };',
    'const f = x => { return x; }',
    'const expr = (x: number) => x + 1;',
    'const table = [1, 2];',
    'function twice() {}',
    'function twice() {}',
    "it('t', () => { function inner() {} });",
  ].join('\n');
  const { helpers, twice } = topLevelHelpers(source);
  expect([...helpers.keys()]).toEqual(['a', 'b', 'g', 'c', 'd', 'e', 'f']);
  expect([...twice]).toEqual(['twice']);
  const a = helpers.get('a');
  expect(source.slice(a?.start, a?.end)).toBe(
    'async function a(x: number): Promise<{ v: number }> { return { v: x }; }',
  );
  const d = helpers.get('d');
  expect(source.slice(d?.start, d?.end)).toBe(
    'export const d: (x: number) => number = (x) => { return x; }',
  );
});

it('[CT-06zxe] helperImpact: the test blocks naming a changed helper, through other helpers too; any other use is refused', () => {
  const source = [
    "import { describe, it } from 'vitest';",
    'function only() { return 1; }',
    'function viaOnly() { return only(); }',
    'const viaVia = () => { return viaOnly(); };',
    'function unrelated() { return 2; }',
    "describe('s', () => {",
    "  it('direct', () => { only(); });",
    "  it('through two helpers', () => { viaVia(); });",
    "  it('as a value', () => { [1].map(only); });",
    "  it('none', () => { unrelated(); });",
    '});',
  ].join('\n');
  expect(helperImpact(source, ['only'])).toEqual({
    ok: true,
    closure: ['only', 'viaOnly', 'viaVia'],
    affected: [true, true, true, false],
  });
  expect(helperImpact(source, ['unrelated'])).toEqual({
    ok: true,
    closure: ['unrelated'],
    affected: [false, false, false, true],
  });
  for (const use of [
    'beforeEach(() => { only(); });',
    'const result = only();',
    'export { viaOnly };',
    'const table = [viaVia];',
  ]) {
    const r = helperImpact(
      source.replace("describe('s', () => {", `${use}\ndescribe('s', () => {`),
      ['only'],
    );
    expect(r.ok).toBe(false);
  }
  expect(helperImpact('it(', ['only'])).toMatchObject({ ok: false });
});

it("[CT-06zxe] helperImpact: a use inside a template's ${…} counts where the template stands (review r1 S1-1)", () => {
  const source = [
    "import { it, expect } from 'vitest';",
    'function h() { expect(1).toBe(1); }',
    'function g() { return `${h()}`; }',
    'function k() { return `a${`b${h()}`}`; }',
    "it('[AC-X#1] through a helper', () => { g(); });",
    "it('[AC-X#2] directly', () => { void `${h()}`; });",
    "it('[AC-X#3] a call', () => { h(); });",
    "it('[AC-X#4] nested templates', () => { k(); });",
    "it('[AC-X#5] none', () => { void `${1}`; });",
  ].join('\n');
  expect(helperImpact(source, ['h'])).toEqual({
    ok: true,
    closure: ['h', 'g', 'k'],
    affected: [true, true, true, true, false],
  });
  // In a hook, a describe body or a top-level statement, inside ${…} too: the whole file.
  for (const use of [
    'beforeEach(() => { void `${h()}`; });',
    'const label = `${g()}`;',
    "describe('s', () => { const t = `${h()}`; });",
  ]) {
    expect(helperImpact(`${use}\n${source}`, ['h'])).toMatchObject({ ok: false });
  }
});

it('[CT-06zxe] valueSkeleton: a tagged template is not a value (review r1 S2-1 ①)', () => {
  const same = (a: string, b: string): boolean =>
    valueSkeleton(a) !== null && valueSkeleton(a) === valueSkeleton(b);
  expect(
    same("sql`select * from app.pay_anomaly where status = 'open'`", 'sql`select 1 where false`'),
  ).toBe(false);
  expect(same('db.sql`a`', 'db.sql`b`')).toBe(false);
  expect(same('f()`a`', 'f()`b`')).toBe(false);
  expect(same('x[0]`a`', 'x[0]`b`')).toBe(false);
  expect(same('sql<Row>`a`', 'sql<Row>`b`')).toBe(false);
  // Untagged templates stay values (after an operator, a keyword, a bracket).
  expect(same('x: `a`,', 'x: `b`,')).toBe(true);
  expect(same('return `a`;', 'return `b`;')).toBe(true);
  expect(same('toBe(`a`)', 'toBe(`b`)')).toBe(true);
});

it("[CT-06zxe] valueChangeRefusal: only an object property value or a matcher's expected argument may change (review r1 S2-1 ③)", () => {
  for (const [from, to] of [
    ['    diff_fen: AMOUNT,', '    diff_fen: -AMOUNT,'],
    ['diff_fen: order.amount_fen,', 'diff_fen: -order.amount_fen,'],
    ["status: 'open',", "status: 'closed',"],
    ["'a-b': 1,", "'a-b': 2,"],
    ['expect(x).toBe(500n);', 'expect(x).toBe(-1500n);'],
    ['.length).toBeGreaterThanOrEqual(1);', '.length).toBeGreaterThanOrEqual(2);'],
    ['expect(x).not.toEqual([1, { a: 2 }]);', 'expect(x).not.toEqual([3, { a: 4 }]);'],
    ['expect(rows).toMatchObject({ n: 1 })', 'expect(rows).toMatchObject({ n: 2 })'],
    ['toHaveLength(1);', 'toHaveLength(2);'],
  ] as const) {
    expect(valueChangeRefusal(from, to), `${from} → ${to}`).toBeNull();
  }
  for (const [from, to] of [
    [".where('status', '=', 'open')", ".where('status', '<>', 'open')"],
    [".where('status', '=', 'open')", ".where('status', '=', 'closed')"],
    [".where({ status: 'open' })", ".where({ status: 'closed' })"],
    [".selectFrom('app.a').where('n', '>', 1)", ".selectFrom('app.b').where('n', '>', 1)"],
    ["sql('select 1')", "sql('select 2')"],
    ['.set({ n: 1 }).execute()', '.set({ n: 2 }).execute()'],
    ['const n = 1;', 'const n = 2;'],
    ['f(1)', 'f(2)'],
    ['x(toBe(1))', 'x(toBe(2))'],
    ['expect(f(1)).toBe(2)', 'expect(f(3)).toBe(2)'],
    ['[1, 2]', '[1, 3]'],
    ['1);', '2);'],
  ] as const) {
    expect(valueChangeRefusal(from, to), `${from} → ${to}`).not.toBeNull();
  }
  expect(valueChangeRefusal("'unterminated", 'x')).toBe('it cannot be tokenized');
});

it('[CT-06zxh] valueChangeRefusal: a property value of an expectation only, a matcher at the end of an expect chain only (review r2 S2-2)', () => {
  for (const [from, to] of [
    // B2-15l, the whole helper: inside toMatchObject({…}) of expect(diffs[0]).
    [
      'function h() {\n  expect(diffs[0]).toMatchObject({\n    expected_fen: 0n,\n    diff_fen: AMOUNT,\n  });\n}',
      'function h() {\n  expect(diffs[0]).toMatchObject({\n    expected_fen: 0n,\n    diff_fen: -AMOUNT,\n  });\n}',
    ],
    ['expect(x).toEqual([{ a: 1 }]);', 'expect(x).toEqual([{ a: 2 }]);'],
    [
      'expect(x).toEqual(expect.objectContaining({ a: 1 }));',
      'expect(x).toEqual(expect.objectContaining({ a: 2 }));',
    ],
    [
      'expect(x).toEqual(expect.not.objectContaining({ a: 1 }));',
      'expect(x).toEqual(expect.not.objectContaining({ a: 2 }));',
    ],
    ['expect.soft(x).toBe(1);', 'expect.soft(x).toBe(2);'],
    ['expect.poll(() => x()).toBe(1);', 'expect.poll(() => x()).toBe(2);'],
    ['expect(x, "m").not.toBe(1);', 'expect(x, "m").not.toBe(2);'],
    ['await expect(p).resolves.toBe(1);', 'await expect(p).resolves.toBe(2);'],
    ["await expect(p).rejects.toThrow('a');", "await expect(p).rejects.toThrow('b');"],
    ['expect<number>(x).toBe(1);', 'expect<number>(x).toBe(2);'],
    ['expect(x).toEqual({ a: { b: 1 } });', 'expect(x).toEqual({ a: { b: 2 } });'],
    ['expect(x).toEqual(({ a: 1 }));', 'expect(x).toEqual(({ a: 2 }));'],
    // A fragment that begins before its context: the whole helper decides.
    ['{ a: 1 }', '{ a: 2 }'],
    ['.not.toBe(1)', '.not.toBe(2)'],
    ['not.toBe(1)', 'not.toBe(2)'],
  ] as const) {
    expect(valueChangeRefusal(from, to), `${from} → ${to}`).toBeNull();
  }
  for (const [from, to, why] of [
    // A ternary's false branch, a type annotation (no `{` or `,` before the key).
    ['const lim = strict ? 1 : 0;', 'const lim = strict ? 1 : 99;', 'outside an object property'],
    ["let s: 'open' = x;", "let s: 'closed' = x;", 'outside an object property'],
    [
      'insertOrder({ a: c ? 1 : 2 });',
      'insertOrder({ a: c ? 1 : 3 });',
      'outside an object property',
    ],
    ["(a, s: 'open') => a", "(a, s: 'closed') => a", 'outside an object property'],
    // A fixture's input, a query object, the actual side, a returned object.
    [
      "insertOrder(db, { status: 'open' })",
      "insertOrder(db, { status: 'closed' })",
      'insertOrder( call',
    ],
    [
      "const q = { text: 'select 1 where a = 1' };",
      "const q = { text: 'select 1 where false' };",
      'outside any expectation',
    ],
    ['expect(f({ amount: 1 })).toBe(3);', 'expect(f({ amount: 2 })).toBe(3);', 'f( call'],
    ['expect({ a: 1 }).toEqual(x);', 'expect({ a: 2 }).toEqual(x);', 'expect( call'],
    ['expect.soft({ a: 1 }).toEqual(x);', 'expect.soft({ a: 2 }).toEqual(x);', 'soft( call'],
    [
      'function h() { return { a: 1 }; }',
      'function h() { return { a: 2 }; }',
      'outside any expectation',
    ],
    [
      'expect(x).toEqual(rows.map((r) => ({ a: 1 })));',
      'expect(x).toEqual(rows.map((r) => ({ a: 2 })));',
      'map( call',
    ],
    [
      'expect(x).toEqual(f()({ a: 1 }));',
      'expect(x).toEqual(f()({ a: 2 }));',
      'the argument of a call',
    ],
    // Not a matcher of an expect chain.
    ['n.toString(16)', 'n.toString(2)', 'outside an object property'],
    ['n.toFixed(2)', 'n.toFixed(0)', 'outside an object property'],
    ['expect(n.toFixed(2)).toBe(x)', 'expect(n.toFixed(0)).toBe(x)', 'outside an object property'],
    ['a.not.toBe(1)', 'a.not.toBe(2)', 'outside an object property'],
    ['other(x).toBe(1)', 'other(x).toBe(2)', 'outside an object property'],
    ['vi.expect.soft(x).toBe(1)', 'vi.expect.soft(x).toBe(2)', 'outside an object property'],
    ['x.expect(y).toBe(1)', 'x.expect(y).toBe(2)', 'outside an object property'],
  ] as const) {
    expect(valueChangeRefusal(from, to), `${from} → ${to}`).toContain(why);
  }
});

it('[CT-06zxi] valueChangeRefusal: a value inside a function body between it and the matcher is no expected value (D10-388)', () => {
  const body = 'inside a function body';
  for (const [from, to] of [
    // The review r2 probe of CT-06zxh: an IIFE's local input, arrow and function, with and
    // without grouping parentheses.
    [
      'expect(actual).toEqual((() => { const input = { amount: 1 }; return makeExpected(input); })());',
      'expect(actual).toEqual((() => { const input = { amount: 2 }; return makeExpected(input); })());',
    ],
    [
      'expect(actual).toEqual((function () { const input = { amount: 1 }; return makeExpected(input); })());',
      'expect(actual).toEqual((function () { const input = { amount: 2 }; return makeExpected(input); })());',
    ],
    [
      'expect(actual).toEqual(function () { const input = { amount: 1 }; return makeExpected(input); }());',
      'expect(actual).toEqual(function () { const input = { amount: 2 }; return makeExpected(input); }());',
    ],
    [
      'expect(actual).toEqual((() => { return { amount: 1 }; })());',
      'expect(actual).toEqual((() => { return { amount: 2 }; })());',
    ],
    // An expression body called at once, with and without its grouping parentheses.
    [
      'expect(x).toEqual((() => ({ amount: 1 }))());',
      'expect(x).toEqual((() => ({ amount: 2 }))());',
    ],
    ['expect(x).toEqual(((v) => ({ a: 1 }))(0));', 'expect(x).toEqual(((v) => ({ a: 2 }))(0));'],
    ['expect(x).toEqual((() => [{ a: 1 }])());', 'expect(x).toEqual((() => [{ a: 2 }])());'],
    [
      'expect(x).toEqual({ b: ((v) => ({ a: 1 }))(0) });',
      'expect(x).toEqual({ b: ((v) => ({ a: 2 }))(0) });',
    ],
    // Not called: a function body, a method's body, an arrow in an array.
    [
      'expect(x).toEqual(() => { return { a: 1 }; });',
      'expect(x).toEqual(() => { return { a: 2 }; });',
    ],
    ['expect(x).toEqual(() => { return [1]; });', 'expect(x).toEqual(() => { return [2]; });'],
    [
      'expect(x).toEqual({ m() { return { a: 1 }; } });',
      'expect(x).toEqual({ m() { return { a: 2 }; } });',
    ],
    ['expect(x).toEqual([() => 1]);', 'expect(x).toEqual([() => 2]);'],
    [
      'expect(x).toEqual(expect.objectContaining({ f: () => ({ a: 1 }) }));',
      'expect(x).toEqual(expect.objectContaining({ f: () => ({ a: 2 }) }));',
    ],
    // The whole helper, as red-check checks it.
    [
      'function h() {\n  expect(a).toEqual((() => {\n    const input = {\n      amount: 1,\n    };\n    return make(input);\n  })());\n}',
      'function h() {\n  expect(a).toEqual((() => {\n    const input = {\n      amount: 2,\n    };\n    return make(input);\n  })());\n}',
    ],
  ] as const) {
    expect(valueChangeRefusal(from, to), `${from} → ${to}`).toContain(body);
  }
  // Still accepted: an asymmetric matcher's object, nested objects and arrays, an arrow before a
  // `,` of the same object, B2-15l's whole helper.
  for (const [from, to] of [
    [
      'expect(x).toEqual(expect.objectContaining({ a: { b: 1 } }));',
      'expect(x).toEqual(expect.objectContaining({ a: { b: 2 } }));',
    ],
    ['expect(x).toEqual([{ a: [{ b: 1 }] }]);', 'expect(x).toEqual([{ a: [{ b: 2 }] }]);'],
    ['expect(x).toEqual({ f: () => y, b: 1 });', 'expect(x).toEqual({ f: () => y, b: 2 });'],
    ['expect(x).toEqual([() => y, 1]);', 'expect(x).toEqual([() => y, 2]);'],
    ['expect.poll(() => x()).toEqual({ a: 1 });', 'expect.poll(() => x()).toEqual({ a: 2 });'],
    ['await expect(p).resolves.toEqual({ a: 1 });', 'await expect(p).resolves.toEqual({ a: 2 });'],
    ['expect(x).toEqual({ a: { b: 1 } });', 'expect(x).toEqual({ a: { b: 2 } });'],
    [
      'async function h() {\n  expect(diffs[0]).toMatchObject({\n    expected_fen: 0n,\n    diff_fen: AMOUNT,\n  });\n}',
      'async function h() {\n  expect(diffs[0]).toMatchObject({\n    expected_fen: 0n,\n    diff_fen: -AMOUNT,\n  });\n}',
    ],
    [
      'const h = async () => {\n  expect(rows).toMatchObject({\n    diff_fen: order.amount_fen,\n  });\n};',
      'const h = async () => {\n  expect(rows).toMatchObject({\n    diff_fen: -order.amount_fen,\n  });\n};',
    ],
  ] as const) {
    expect(valueChangeRefusal(from, to), `${from} → ${to}`).toBeNull();
  }
});

it('[CT-06zxh] helperNamedInLiteral: a string, template or regex literal naming the closure outside the changed helpers (review r2 S2-1)', () => {
  const head = [
    "import { it, expect } from 'vitest';",
    'function h() { expect(1).toBe(1); }',
    'function g() { h(); }',
  ].join('\n');
  const named = (rest: string, names = ['h', 'g']): string | null =>
    helperNamedInLiteral(`${head}\n${rest}`, names, ['h']);
  // The review r2 probes: eval, a key after a dynamic import of the file itself.
  expect(named("it('[A#1]', () => { eval('h()'); });\nit('[A#2]', () => { h(); });")).toContain(
    'a literal names "h"',
  );
  expect(
    named(
      "it('[A#1]', async () => { const m = await import('./x.test.ts'); m['h' as 'h'](); });\nit('[A#2]', () => { h(); });",
    ),
  ).toContain('a literal names "h"');
  for (const rest of [
    "it('[A#1]', () => { void 'call g'; });", // a caller of h
    'it(\'[A#1]\', () => { void "h"; });',
    "it('[A#1]', () => { void `run h now`; });",
    "it('[A#1]', () => { void `${1} h`; });",
    "it('[A#1]', () => { void `${'h'}`; });", // a string inside ${…}
    "it('[A#1]', () => { void /h\\(/; });",
    "it('h works', () => { h(); });", // a test title
    "const T = 'g';",
  ]) {
    expect(named(rest), rest).not.toBeNull();
  }
  for (const rest of [
    "it('[A#1]', () => { h(); void 'hx gh $h_'; });", // not as a whole word
    "it('[A#1]', () => { void `${h()}`; });", // an identifier inside ${…} (helperImpact)
    "it('[A#1]', () => { void 'k'; });",
  ]) {
    expect(named(rest), rest).toBeNull();
  }
  // Inside the changed helper itself it is no call by a string; inside a caller it is.
  expect(
    helperNamedInLiteral(
      "function h() { expect('h').toBe('h'); }\nit('[A#1]', () => { h(); });",
      ['h'],
      ['h'],
    ),
  ).toBeNull();
  expect(
    helperNamedInLiteral(
      "function h() { expect(1).toBe(1); }\nfunction g() { void 'h'; h(); }\nit('[A#1]', () => { g(); });",
      ['h', 'g'],
      ['h'],
    ),
  ).toContain('a literal names "h"');
  expect(helperNamedInLiteral("it('", ['h'], ['h'])).toContain('cannot be read');
});

it('[AC-CT-06zzz#1] mayImportRuleTest counts only an explicit import of the sibling', () => {
  const file = 'test/spec/m/a.int.test.ts';
  const sibling = 'test/spec/m/b.int.test.ts';
  const loaded = mod(sibling, '');
  // Loaded by the closure, or a resolved specifier in any of its modules.
  expect(mayImportRuleTest(sibling, [mod(file, ''), loaded])).toBe(`it loads ${sibling}`);
  // The sibling exists but the closure does not follow it: only the resolved specifier shows it.
  const importing = relativeClosure(
    file,
    (p) => (p === file ? "import './b.int.test.ts';" : p === sibling ? '' : null),
    () => false,
  );
  expect(mayImportRuleTest(sibling, importing)).toBe(
    `${file} imports ${sibling} (./b.int.test.ts)`,
  );
  // A module that cannot be tokenized may import it: its imports cannot be read.
  const unreadable = mod(file, "const s = 'unterminated;");
  expect(unreadable.literals).toBeNull();
  expect(mayImportRuleTest(sibling, [unreadable])).toBe(`${file} cannot be tokenized`);
  // A name in the text, a computed import and a listing are mayReadSupport's rules, not these.
  const computed = mod(
    file,
    "await import(`./${name}`); const n = 'b.int.test.ts'; readdirSync('.');",
  );
  expect(mayImportRuleTest(sibling, [computed])).toBeNull();
  expect(mayReadSupport(file, sibling, [computed])).not.toBeNull();
});

// CT-06zzzc (D10-623): compareOutsideChanged, for a file listed in red_exempt_outside.
const OUT_BASE = [
  HEADER,
  "import { a } from './a.ts';",
  '',
  'const GROUPS = [',
  "  ['alpha', 1],",
  "  ['bridge_origins', 2],",
  "  ['gamma', 3],",
  '];',
  '',
  "describe('cfg', () => {",
  "  it('[AC-1] one', () => {",
  '    expect(a(1)).toBe(1);',
  '  });',
  '',
  '  for (const [name, n] of GROUPS) {',
  '    it(`[AC-2] group ${name}`, () => {',
  '      expect(a(n)).toBe(n);',
  '    });',
  '  }',
  '',
  "  it('[AC-3] three', () => {",
  '    expect(a(3)).toBe(3);',
  '  });',
  '});',
  '',
].join('\n');

function outside(base: string, head: string): { changed: Record<string, boolean>; lines: string } {
  const c = compareOutsideChanged(base, head);
  if (c.whole) throw new Error(`judged as a whole: ${c.reason}`);
  return {
    changed: Object.fromEntries(c.blocks.map((b) => [b.title, b.changed])),
    lines: c.lines,
  };
}

it('[CT-06zzzc] compareOutsideChanged: an import and a removed table row change no test block; the head lines are listed', () => {
  const head = OUT_BASE.replace(
    "import { a } from './a.ts';",
    "import { a } from './a.ts';\nimport { sign } from './sign.ts';",
  ).replace("  ['bridge_origins', 2],\n", '');
  // compareTestFile judges the whole file (code outside the tests changed).
  expect(compareTestFile(OUT_BASE, head)).toMatchObject({ whole: true, outside: true });
  expect(outside(OUT_BASE, head)).toEqual({
    changed: {
      'cfg > [AC-1] one': false,
      'cfg > [AC-2] group *': false,
      'cfg > [AC-3] three': false,
    },
    // L3: the import added; L7: the row removed (shown at the lines of the tokens around it).
    lines: 'L3, L7',
  });
  // A changed block is changed; a fixture value spanning lines is a range.
  const body = head
    .replace('expect(a(3)).toBe(3);', 'expect(a(3)).toBe(4);')
    .replace("const GROUPS = [\n  ['alpha', 1],", "const GROUPS = [\n  ['alpha',\n    7],");
  expect(outside(OUT_BASE, body)).toEqual({
    changed: {
      'cfg > [AC-1] one': false,
      'cfg > [AC-2] group *': false,
      'cfg > [AC-3] three': true,
    },
    lines: 'L3, L6-8',
  });
  // Identical files: nothing listed, nothing changed.
  expect(outside(OUT_BASE, OUT_BASE).lines).toBe('');
});

it('[CT-06zzzc] compareOutsideChanged: a block wrapped, led by new code, moved past an unchanged statement or into another loop is changed', () => {
  const wrapped = OUT_BASE.replace(
    "  it('[AC-1] one', () => {\n    expect(a(1)).toBe(1);\n  });",
    "  if (a(0)) {\n  it('[AC-1] one', () => {\n    expect(a(1)).toBe(1);\n  });\n  }",
  );
  expect(outside(OUT_BASE, wrapped).changed['cfg > [AC-1] one']).toBe(true);
  const led = OUT_BASE.replace("  it('[AC-1] one'", "  if (a(0)) it('[AC-1] one'");
  expect(outside(OUT_BASE, led).changed['cfg > [AC-1] one']).toBe(true);
  // The loop's head changed: the block inside it is changed (it runs over other rows).
  const loop = OUT_BASE.replace('of GROUPS)', 'of GROUPS.slice(1))');
  expect(outside(OUT_BASE, loop).changed).toMatchObject({
    'cfg > [AC-1] one': false,
    'cfg > [AC-2] group *': true,
  });
  // [AC-1] moved past the (unchanged) loop: changed, though its text and describe are the same.
  const block1 = "  it('[AC-1] one', () => {\n    expect(a(1)).toBe(1);\n  });\n";
  const moved = OUT_BASE.replace(block1, '').replace(
    "  it('[AC-3] three'",
    `${block1}\n  it('[AC-3] three'`,
  );
  expect(outside(OUT_BASE, moved).changed).toMatchObject({
    'cfg > [AC-1] one': true,
    'cfg > [AC-3] three': false,
  });
  // A file that cannot be tokenized is judged as a whole.
  expect(compareOutsideChanged(OUT_BASE, `${OUT_BASE}\nconst s = 'open`)).toMatchObject({
    whole: true,
  });
});

it('[CT-06zzzc] compareOutsideChanged: the code ending an enclosing statement counts (do-while condition, IIFE arguments; Codex review r1 S2)', () => {
  const body = "    it('[AC-9] loop', () => {\n      expect(a(n)).toBe(n);\n    });";
  const doWhile = (cond: string, tail = ''): string =>
    OUT_BASE.replace(
      "  it('[AC-3] three'",
      `  let n = 0;\n  do {\n${body}\n    n += 1;\n  } while (${cond})${tail};\n\n  it('[AC-3] three'`,
    );
  const base = doWhile('n < 2');
  // The condition changed: the block inside the loop is changed (it must be red).
  expect(outside(base, doWhile('n < 3')).changed).toMatchObject({
    'cfg > [AC-1] one': false,
    'cfg > [AC-9] loop': true,
    'cfg > [AC-3] three': false,
  });
  // Unchanged condition, a change elsewhere outside the tests: the block stays unchanged.
  const elsewhere = doWhile('n < 2').replace("  ['gamma', 3],\n", '');
  expect(outside(base, elsewhere).changed['cfg > [AC-9] loop']).toBe(false);
  // A body-less do-while around the block itself: its condition counts as well.
  const bare = (cond: string): string =>
    OUT_BASE.replace(
      "  it('[AC-3] three', () => {\n    expect(a(3)).toBe(3);\n  });",
      `  do it('[AC-3] three', () => {\n    expect(a(3)).toBe(3);\n  })\n  while (${cond});`,
    );
  expect(outside(bare('a(0)'), bare('a(1)')).changed['cfg > [AC-3] three']).toBe(true);
  expect(outside(bare('a(0)'), bare('a(0)')).changed['cfg > [AC-3] three']).toBe(false);
  // IIFE tails: the arguments of `}).call(…)` and `})(…)`.
  const iife = (args: string, call = '.call'): string =>
    OUT_BASE.replace(
      "  it('[AC-3] three', () => {\n    expect(a(3)).toBe(3);\n  });",
      `  (function (k) {\n  it('[AC-3] three', () => {\n    expect(a(k)).toBe(3);\n  });\n  })${call}(${args});`,
    );
  expect(outside(iife('this, 3'), iife('this, 4')).changed['cfg > [AC-3] three']).toBe(true);
  expect(outside(iife('this, 3'), iife('this, 3')).changed['cfg > [AC-3] three']).toBe(false);
  expect(outside(iife('3', ''), iife('4', '')).changed['cfg > [AC-3] three']).toBe(true);
  expect(outside(iife('3', ''), iife('3', '')).changed['cfg > [AC-3] three']).toBe(false);
  // A block statement ends at its line break: a statement after the loop is not its tail.
  const after = (stmt: string): string =>
    OUT_BASE.replace('    });\n  }\n', `    });\n  }\n  ${stmt}\n`);
  expect(outside(after('const z = 1'), after('const z = 2')).changed).toMatchObject({
    'cfg > [AC-2] group *': false,
  });
});

it('[CT-06zzzd] formatEachTitle: the known placeholders as Vitest 5 formats them, null for the rest', () => {
  expect(formatEachTitle('case %s', ['x'], 0)).toBe('case x');
  expect(formatEachTitle('%# %$ %s %d %i', ['a', 2.5, 3], 4)).toBe('4 5 a 2.5 3');
  expect(formatEachTitle('%s %s %s %s', [-0, null, undefined, false], 0)).toBe(
    '-0 null undefined false',
  );
  expect(formatEachTitle('%d', [-0], 0)).toBe('0');
  expect(formatEachTitle('no placeholder', ['x'], 0)).toBe('no placeholder');
  for (const t of ['%o', '%O', '%j', '%f', '%c', '%%', '50% off', '$a', '%']) {
    expect(formatEachTitle(t, [1], 0), t).toBeNull();
  }
  expect(formatEachTitle('%s %s', ['x'], 0)).toBeNull();
  expect(formatEachTitle('%d', ['1'], 0)).toBeNull();
  expect(formatEachTitle('%i', [1.5], 0)).toBeNull();
});

it('[CT-06zzzd] formatObjectTitle: $name of literal fields as Vitest 5.0.5 formats them (truncation at 40), null otherwise', () => {
  type Field =
    Parameters<typeof formatObjectTitle>[1] extends ReadonlyMap<string, infer F> ? F : never;
  const f = (entries: Record<string, unknown>) =>
    new Map<string, Field>(
      Object.entries(entries).map(([k, v]): [string, Field] =>
        v === CODE ? [k, { literal: false }] : [k, { literal: true, value: v as string }],
      ),
    );
  const CODE = Symbol('code');
  expect(TITLE_VALUE_TRUNCATE).toBe(40);
  expect(formatObjectTitle('$label：$hit', f({ label: '弱', hit: true, header: CODE }), 0)).toBe(
    '弱：true',
  );
  expect(formatObjectTitle('%# %$ $n', f({ n: -0 }), 2)).toBe('2 3 -0');
  expect(formatObjectTitle('$n $z', f({ n: 1.5, z: null }), 0)).toBe('1.5 null');
  // 40 characters stay; 41 become 39 and "…"; a high surrogate at the cut is dropped too.
  expect(formatObjectTitle('$s', f({ s: 'b'.repeat(40) }), 0)).toBe('b'.repeat(40));
  expect(formatObjectTitle('$s', f({ s: 'b'.repeat(41) }), 0)).toBe(`${'b'.repeat(39)}…`);
  expect(formatObjectTitle('$s', f({ s: `${'b'.repeat(37)}😀${'b'.repeat(5)}` }), 0)).toBe(
    `${'b'.repeat(37)}😀…`,
  );
  expect(formatObjectTitle('$s', f({ s: `${'b'.repeat(38)}😀${'b'.repeat(5)}` }), 0)).toBe(
    `${'b'.repeat(38)}…`,
  );
  // Key regex as Vitest's: CJK letters continue a key.
  expect(formatObjectTitle('$label下', f({ label: 'x' }), 0)).toBeNull();
  for (const t of ['$header', '$missing', '$a.b', '$0', '$a$b', '$label %s', '%%', '%o $label']) {
    expect(formatObjectTitle(t, f({ label: 'x', header: CODE, a: 'y' }), 0), t).toBeNull();
  }
  expect(formatObjectTitle('$u', f({ u: undefined }), 0)).toBeNull();
});

// CT-06zzze (D10-657, after B1-05zc): a split .each table keeps rows of the base table.
const ROWS_AC9 = test('[AC-9] other');
const ROWS_BASE = src(
  test('[AC-0] plain'),
  '',
  "it.each(['feed', 'pool', 'search', null])(",
  "  '[AC-8] source %s inherits',",
  '  async (source) => {',
  '    expect(await f(source)).toBe(1);',
  '  },',
  ');',
  '',
  ROWS_AC9,
);
/** The rows search and null moved out to a new block with a new title (the B1-05zc shape). */
const ROWS_SPLIT = [
  "it.each(['search', null])(",
  "  '[AC-8] source %s single',",
  '  async (source) => {',
  '    expect(await f(source)).toBe(2);',
  '  },',
  ');',
  '',
].join('\n');
const rowsHead = (table = "['feed', 'pool']", base = ROWS_BASE): string =>
  base
    .replace("['feed', 'pool', 'search', null]", table)
    .replace(ROWS_AC9, `${ROWS_SPLIT}\n${ROWS_AC9}`);
const NEW_BLOCK =
  '① no .each / .for block of the base has the same title template and callback under the same describes';

it('[CT-06zzze] compareEachRows: a base .each table with rows removed keeps its rows, under the same title template and callback', () => {
  expect(compareEachRows(ROWS_BASE, rowsHead())).toEqual([
    null,
    {
      ok: true,
      names: ['[AC-8] source feed inherits', '[AC-8] source pool inherits'],
      removed: 2,
    },
    { ok: false, reason: NEW_BLOCK },
    null,
  ]);
  // Keeping the last rows, or one row only, is a subsequence too.
  expect(compareEachRows(ROWS_BASE, rowsHead("['search', null]"))?.[1]).toEqual({
    ok: true,
    names: ['[AC-8] source search inherits', '[AC-8] source null inherits'],
    removed: 2,
  });
  expect(compareEachRows(ROWS_BASE, rowsHead("['pool']"))?.[1]).toEqual({
    ok: true,
    names: ['[AC-8] source pool inherits'],
    removed: 3,
  });
  // A side that cannot be read as tests: null.
  expect(compareEachRows(ROWS_BASE, 'it(')).toBeNull();
});

it('[CT-06zzze] compareEachRows ①: one character of the title template or the callback, the call before the table, or two twins refuse', () => {
  const kept = (head: string) => compareEachRows(ROWS_BASE, head)?.[1];
  expect(
    kept(rowsHead().replace("'[AC-8] source %s inherits'", "'[AC-8] source %s inherit'")),
  ).toEqual({ ok: false, reason: NEW_BLOCK });
  expect(kept(rowsHead().replace('f(source)).toBe(1)', 'f(source)).toBe(3)'))).toEqual({
    ok: false,
    reason: NEW_BLOCK,
  });
  expect(kept(rowsHead().replace('async (source)', '(source)'))).toEqual({
    ok: false,
    reason: NEW_BLOCK,
  });
  const typed = kept(rowsHead().replace("it.each(['feed'", "it.each<string | null>(['feed'"));
  expect(typed?.ok).toBe(false);
  expect(typed?.ok === false && typed.reason).toMatch(
    /^① the call before the table differs from the base's \("it \. each" → "it \. each < string \| null >"\)$/,
  );
  const concurrent = kept(rowsHead().replace("it.each(['feed'", "it.concurrent.each(['feed'"));
  expect(concurrent?.ok === false && concurrent.reason).toMatch(/^① the call before the table/);
  // The same title template and callback twice at the head: not one to one.
  const twice = rowsHead().replace(
    ROWS_AC9,
    `${ROWS_SPLIT.replace("'[AC-8] source %s single'", "'[AC-8] source %s inherits'").replace('toBe(2)', 'toBe(1)')}\n${ROWS_AC9}`,
  );
  expect(compareEachRows(ROWS_BASE, twice)?.[1]).toEqual({
    ok: false,
    reason:
      '① 1 block(s) of the base and 2 of the head have this title template and callback under the same describes: not one to one',
  });
});

it('[CT-06zzze] compareEachRows ③: a changed, added or reordered row, nothing removed, or a moved block refuse', () => {
  const kept = (table: string) => compareEachRows(ROWS_BASE, rowsHead(table))?.[1];
  expect(kept("['feeds', 'pool']")).toEqual({
    ok: false,
    reason:
      '③ the head table is not the base table with rows removed: row "\'feeds\'" is changed, added or moved',
  });
  expect(kept("['feed', 'pool', 'extra']")).toEqual({
    ok: false,
    reason:
      '③ the head table is not the base table with rows removed: row "\'extra\'" is changed, added or moved',
  });
  expect(kept("['pool', 'feed']")).toEqual({
    ok: false,
    reason:
      '③ the head table is not the base table with rows removed: row "\'feed\'" is changed, added or moved',
  });
  // The whole table kept but the block moved after [AC-9]: nothing removed.
  const whole = ROWS_BASE.replace(/it\.each[\s\S]*?\n\);\n/, '').replace(
    ROWS_AC9,
    `${ROWS_AC9}\n\n${/it\.each[\s\S]*?\n\);/.exec(ROWS_BASE)?.[0] ?? ''}`,
  );
  expect(compareEachRows(ROWS_BASE, whole)?.[2]).toEqual({
    ok: false,
    reason: '③ no row of the base table was removed (the block changed elsewhere)',
  });
  // Rows removed and the block moved past an unchanged test: refused.
  const moved = whole.replace("['feed', 'pool', 'search', null]", "['feed', 'pool']");
  expect(compareEachRows(ROWS_BASE, moved)?.[2]).toEqual({
    ok: false,
    reason: '③ the block moved among the blocks whose text is as at the base',
  });
});

it('[CT-06zzze] compareEachRows ②: a table by name, a title following the index, a modifier refuse; object rows with as const under a describe qualify', () => {
  const named = src(
    "const SOURCES = ['feed', 'pool', 'search', null] as const;",
    ROWS_BASE.slice(src().length),
  ).replace("it.each(['feed', 'pool', 'search', null])", 'it.each(SOURCES)');
  const namedHead = named
    .replace('it.each(SOURCES)', "it.each(['feed', 'pool'])")
    .replace(ROWS_AC9, `${ROWS_SPLIT}\n${ROWS_AC9}`);
  expect(compareEachRows(named, namedHead)?.[1]).toEqual({
    ok: false,
    reason: '② the base table is not an inline array of literal rows',
  });
  expect(compareEachRows(ROWS_BASE, rowsHead('[...SOURCES]'))?.[1]).toEqual({
    ok: false,
    reason: '② the head table is not an inline array of literal rows',
  });
  // %# moves with the index: the kept row null is #3 at the base, #2 at the head.
  const indexed = ROWS_BASE.replace("'[AC-8] source %s inherits'", "'[AC-8] #%# source %s'");
  expect(compareEachRows(indexed, rowsHead("['feed', 'pool', null]", indexed))?.[1]).toEqual({
    ok: false,
    reason:
      '② row 2 is named "[AC-8] #2 source null", at the base "[AC-8] #3 source null" (a title that follows the index)',
  });
  // A modifier makes no name certain.
  // Built from parts: the test guard rejects the literal modifier in a test file (no-skip-only).
  const skipped = ROWS_BASE.replace("it.each(['feed'", ['it', 'skip', "each(['feed'"].join('.'));
  expect(compareEachRows(skipped, rowsHead("['feed', 'pool']", skipped))?.[1]).toEqual({
    ok: false,
    reason:
      '② the full names of the rows are not certain (a title, describe or placement Vitest names in a way not read here, or a modifier)',
  });
  // The B1-05zc disclaimer shape: object rows, `as const`, a $name title, inside a describe.
  const OBJ_BASE = src(
    "describe('d', () => {",
    '  it.each([',
    "    { basis: 'normal' as const, tail: ['a'] },",
    "    { basis: 'risk' as const, tail: ['b'] },",
    "    { basis: 'none' as const, tail: [] },",
    "  ])('[AC-10] $basis keys', async ({ basis, tail }) => {",
    '    expect(await g(basis)).toEqual(tail);',
    '  });',
    '});',
  );
  const OBJ_HEAD = OBJ_BASE.replace("    { basis: 'risk' as const, tail: ['b'] },\n", '');
  expect(compareEachRows(OBJ_BASE, OBJ_HEAD)).toEqual([
    { ok: true, names: ['d > [AC-10] normal keys', 'd > [AC-10] none keys'], removed: 1 },
  ]);
  // `as const` is read for compareEachRows only: CT-06zzzd's names are unchanged.
  const same = compareOutsideChanged(OBJ_BASE, OBJ_BASE);
  expect(same.whole === false && same.blocks[0]?.names).toBeNull();
});
