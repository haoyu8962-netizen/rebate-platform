import { afterAll, describe, expect, it } from 'vitest';
import { repoRoot } from '../../lib/paths.ts';
import { cleanupFixtures, makeTree } from './fixture-kit.ts';
import { loadProtected } from './protected.ts';
import * as fx from './test-guard.fixtures.ts';
import type { Change } from '../../lib/git.ts';
import {
  PROP_TIMEOUT_MIN,
  addOnlyViolations,
  isFundsTestFile,
  propTimeoutChecks,
  propTimeoutFindings,
  scanFile,
  scanTree,
  testTitles,
} from './test-guard.ts';

afterAll(cleanupFixtures);

function rules(file: string, text: string): string[] {
  return scanFile(file, text).map((f) => f.rule);
}

describe('test files', () => {
  const unit = 'packages/money/src/round.test.ts';
  const integration = 'packages/db/src/ledger.int.test.ts';

  it.each([
    ['skipped test', fx.SKIPPED_TEST],
    ['focused suite', fx.FOCUSED_TEST],
    ['chained skip', fx.CHAINED_SKIP],
    ['conditional skip', fx.CONDITIONAL_SKIP],
    ['todo', fx.TODO_TEST],
    ['x-prefixed test', fx.X_PREFIXED_TEST],
    ['skip through the test context', fx.CONTEXT_SKIP],
  ])('flags a %s', (_name, text) => {
    expect(rules(unit, text)).toEqual(['no-skip-only']);
    expect(rules(integration, text)).toEqual(['no-skip-only']);
  });

  it('flags retry options but accepts an explicit zero', () => {
    expect(rules(unit, fx.RETRY_OPTION)).toEqual(['no-retry']);
    expect(rules(unit, fx.RETRY_SHORTHAND)).toEqual(['no-retry']);
    expect(rules(unit, fx.RETRY_ZERO)).toEqual([]);
  });

  it('keeps refusing any retry key in funds and attribution test files', () => {
    for (const file of [
      unit,
      'packages/domain/src/settle.test.ts',
      'apps/api/src/modules/ledger/post.test.ts',
      'apps/api/src/modules/withdrawals/request.test.ts',
      'test/spec/money/round.test.ts',
      'test/properties/money/split.prop.test.ts',
      'test/spec/payout/timeout.test.ts',
      'test/acceptance/search.test.ts',
      'test/replay/orders.test.ts',
    ]) {
      expect(isFundsTestFile(file)).toBe(true);
      expect(scanFile(file, fx.RETRY_FIELD).filter((f) => f.rule === 'no-retry')).toHaveLength(5);
    }
  });

  describe('other test files: only Vitest retry options', () => {
    const files = [
      'apps/api/src/modules/platform/http/http.test.ts',
      'test/spec/platform/http/policy.test.ts',
      'tools/agent/dispatch.test.ts',
    ];

    it('accepts retry as an ordinary field name', () => {
      for (const file of files) {
        expect(isFundsTestFile(file)).toBe(false);
        expect(rules(file, fx.RETRY_FIELD)).toEqual([]);
      }
    });

    it('flags the retry option of it, test, describe and suite, with their modifiers', () => {
      const [file = ''] = files;
      expect(rules(file, fx.RETRY_OPTION)).toEqual(['no-retry']);
      expect(rules(file, fx.RETRY_SHORTHAND)).toEqual(['no-retry']);
      expect(rules(file, fx.RETRY_ZERO)).toEqual([]);
      expect(scanFile(file, fx.RETRY_OPTION_MULTILINE).map((f) => `${f.line}:${f.rule}`)).toEqual([
        '5:no-retry',
      ]);
      expect(scanFile(file, fx.RETRY_OPTION_CHAINS).map((f) => `${f.line}:${f.rule}`)).toEqual([
        '1:no-retry',
        '2:no-retry',
        '3:no-retry',
        '4:no-retry',
        '6:no-retry',
      ]);
      expect(scanFile(file, fx.RETRY_NESTED).map((f) => f.line)).toEqual([2]);
    });

    it('flags the retry option of extended and imported test functions', () => {
      const [file = ''] = files;
      expect(scanFile(file, fx.RETRY_EXTENDED_TEST).map((f) => `${f.line}:${f.rule}`)).toEqual([
        '2:no-retry',
      ]);
      expect(scanFile(file, fx.RETRY_IMPORTED_TEST).map((f) => `${f.line}:${f.rule}`)).toEqual([
        '2:no-retry',
      ]);
    });

    it('reads options kept in a local object and refuses options it cannot read', () => {
      const [file = ''] = files;
      expect(rules(file, fx.OPTIONS_VARIABLE_LOCAL)).toEqual([]);
      expect(scanFile(file, fx.OPTIONS_VARIABLE_RETRY).map((f) => `${f.line}:${f.rule}`)).toEqual([
        '1:no-retry',
      ]);
      expect(
        scanFile(file, fx.OPTIONS_VARIABLE_IMPORTED).map((f) => `${f.line}:${f.rule}`),
      ).toEqual(['2:no-retry']);
      expect(rules(file, fx.OPTIONS_SPREAD)).toEqual(['no-retry']);
    });
  });

  it('keeps the superuser URL out of test files, except to assert it is absent', () => {
    expect(rules(unit, fx.ADMIN_URL_READ)).toEqual(['admin-url-only-in-global-setup']);
    expect(rules(integration, fx.ADMIN_URL_READ)).toEqual(['admin-url-only-in-global-setup']);
    expect(rules(integration, fx.ADMIN_URL_ABSENT)).toEqual([]);
    expect(rules(integration, fx.ADMIN_URL_ABSENT_AND_READ)).toEqual([
      'admin-url-only-in-global-setup',
    ]);
  });

  it.each([
    ['pg', fx.IMPORT_PG],
    ['a pg subpath', fx.IMPORT_PG_SUBPATH],
    ['pg-boss through dynamic import', fx.IMPORT_PG_BOSS],
    ['testcontainers', fx.IMPORT_TESTCONTAINERS],
    ['a testcontainers module', fx.IMPORT_TESTCONTAINERS_MODULE],
    ['@couli/db/testing', fx.IMPORT_DB_TESTING],
    ['pg through require', fx.REQUIRE_PG],
  ])('forbids %s in unit tests only', (_name, text) => {
    expect(rules(unit, text)).toEqual(['unit-no-db']);
    expect(rules(integration, text)).toEqual([]);
  });

  it('does not confuse similarly named modules', () => {
    expect(rules(unit, fx.IMPORT_HARMLESS)).toEqual([]);
  });

  it('forbids listening on a port in unit tests only', () => {
    expect(rules(unit, fx.LISTEN)).toEqual(['unit-no-listen']);
    expect(rules(integration, fx.LISTEN)).toEqual([]);
  });

  it('reports file and line', () => {
    expect(scanFile(unit, `\n\n${fx.SKIPPED_TEST}`)).toEqual([
      {
        file: unit,
        line: 3,
        rule: 'no-skip-only',
        message: 'tests must not be skipped, focused or left as todo',
      },
    ]);
  });

  it('ignores files that are not tests', () => {
    expect(
      rules('packages/money/src/round.ts', fx.SKIPPED_TEST + fx.IMPORT_PG + fx.LISTEN),
    ).toEqual([]);
  });
});

describe('vitest configs and package scripts', () => {
  it('accepts the strict settings', () => {
    expect(rules('vitest.shared.ts', fx.CONFIG_STRICT)).toEqual([]);
    expect(rules('tools/vitest.config.ts', fx.CONFIG_STRICT)).toEqual([]);
  });

  it('flags retry, passWithNoTests and allowOnly', () => {
    expect(rules('test/vitest.longrun.config.ts', fx.CONFIG_RETRY)).toEqual(['no-retry']);
    expect(rules('packages/db/vitest.integration.config.ts', fx.CONFIG_PASS_EMPTY)).toEqual([
      'no-pass-with-no-tests',
    ]);
    expect(rules('vitest.shared.ts', fx.CONFIG_ALLOW_ONLY)).toEqual(['no-skip-only']);
  });

  it('flags weakening flags in package scripts and reports the line', () => {
    const text = JSON.stringify(
      {
        name: 'x',
        scripts: {
          build: 'tsc -b',
          test: 'vitest run --passWithNoTests',
          'test:int': 'vitest run --retry=2',
        },
      },
      null,
      2,
    );
    const findings = scanFile('packages/x/package.json', text);
    expect(findings.map((f) => `${f.line}:${f.rule}`)).toEqual([
      '5:no-pass-with-no-tests',
      '6:no-pass-with-no-tests',
    ]);
    expect(rules('package.json', JSON.stringify({ scripts: { test: 'vitest run' } }))).toEqual([]);
    expect(rules('package.json', '{ nope')).toEqual(['package-json']);
  });
});

describe('rule tests under test/spec and test/properties', () => {
  it('forbids describe blocks', () => {
    expect(rules('test/spec/money/round.test.ts', fx.DESCRIBE_BLOCK)).toEqual([
      'rule-tests-top-level-it',
    ]);
    expect(rules('test/properties/split.test.ts', fx.DESCRIBE_EACH)).toEqual([
      'rule-tests-top-level-it',
    ]);
    expect(rules('test/spec/money/round.test.ts', fx.TOP_LEVEL_IT)).toEqual([]);
    expect(rules('packages/money/src/round.test.ts', fx.DESCRIBE_BLOCK)).toEqual([]);
  });

  it('forbids mocking the money package and the ledger', () => {
    expect(rules('test/spec/a.test.ts', fx.MOCK_MONEY)).toEqual(['rule-tests-no-funds-mock']);
    expect(rules('test/spec/a.test.ts', fx.MOCK_MONEY_RELATIVE)).toEqual([
      'rule-tests-no-funds-mock',
    ]);
    expect(rules('test/properties/a.test.ts', fx.MOCK_LEDGER)).toEqual([
      'rule-tests-no-funds-mock',
    ]);
    expect(rules('test/spec/a.test.ts', fx.MOCK_OTHER)).toEqual([]);
    expect(rules('test/spec/reference/split.ref.ts', fx.MOCK_MONEY)).toEqual([
      'rule-tests-no-funds-mock',
    ]);
  });
});

describe('acceptance tests', () => {
  const file = 'test/acceptance/search.test.ts';

  it('requires an AC id in every title', () => {
    expect(rules(file, fx.AC_TITLED + fx.AC_TITLED_SUFFIX + fx.AC_EACH_TITLED)).toEqual([]);
    expect(rules(file, fx.AC_UNTITLED)).toEqual(['acceptance-title']);
    expect(rules(file, fx.AC_EACH_UNTITLED)).toEqual(['acceptance-title']);
    expect(rules(file, fx.AC_DYNAMIC_TITLE)).toEqual(['acceptance-title']);
    expect(rules('test/spec/search.test.ts', fx.AC_UNTITLED)).toEqual([]);
  });

  it('extracts titles with their lines', () => {
    expect(testTitles(`${fx.AC_TITLED}\n${fx.AC_EACH_TITLED}${fx.AC_DYNAMIC_TITLE}`)).toEqual([
      { line: 1, title: '[AC-S1-03] 搜索返回商品卡片' },
      { line: 3, title: '[AC-S1-04] page %i' },
      { line: 4, title: null },
    ]);
  });
});

describe('scanTree', () => {
  it('reads only the relevant files of a tree', () => {
    const root = makeTree({
      'packages/a/src/a.test.ts': fx.SKIPPED_TEST,
      'packages/a/src/a.ts': fx.SKIPPED_TEST,
      'packages/a/package.json': JSON.stringify({
        scripts: { test: 'vitest run --passWithNoTests' },
      }),
      'vitest.shared.ts': fx.CONFIG_RETRY,
      'test/spec/b.test.ts': fx.DESCRIBE_BLOCK,
      'docs/readme.md': fx.SKIPPED_TEST,
    });
    const files = [
      'docs/readme.md',
      'packages/a/package.json',
      'packages/a/src/a.test.ts',
      'packages/a/src/a.ts',
      'test/spec/b.test.ts',
      'vitest.shared.ts',
    ];
    expect(scanTree(root, files).map((f) => `${f.file}:${f.rule}`)).toEqual([
      'packages/a/package.json:no-pass-with-no-tests',
      'packages/a/src/a.test.ts:no-skip-only',
      'test/spec/b.test.ts:rule-tests-top-level-it',
      'vitest.shared.ts:no-retry',
    ]);
  });
});

describe('addOnlyViolations', () => {
  it('reports modified, deleted and renamed test assets but not new ones', () => {
    const cfg = loadProtected(repoRoot());
    const hits = addOnlyViolations(
      [
        { path: 'test/spec/money/new.test.ts', status: '?' },
        { path: 'test/spec/money/round.test.ts', status: 'M' },
        { path: 'test/replay/case-1.json', status: 'D' },
        { path: 'tools/guard/run.ts', status: 'M' },
      ],
      cfg,
    );
    expect(hits.map((h) => h.path)).toEqual([
      'test/replay/case-1.json',
      'test/spec/money/round.test.ts',
    ]);
  });
});

describe('[CT-06zzzm] prop-timeout: propParams() tests need an explicit timeout ≥ 900_000 (git mode only)', () => {
  const FILE = 'test/spec/demo/prop.test.ts';
  const FIX = 'propParams() 的用例须写显式超时 ≥ 900_000：补 `}, 900_000);`，见 D10-750';
  const found = (text: string) =>
    propTimeoutFindings(FILE, text, null).map((f) => [f.line, f.message]);
  const line = (text: string, needle: string): number =>
    text.slice(0, text.indexOf(needle)).split('\n').length;

  it('[CT-06zzzm] 900_000, 1_000_000 and { timeout: 900_000 } pass; so does the options-second form', () => {
    expect(PROP_TIMEOUT_MIN).toBe(900_000);
    for (const tail of [', 900_000', ', 900000', ', 1_000_000', ', { timeout: 900_000 }']) {
      expect(found(fx.propFile(fx.propBlock('[AC-1] p', tail))), tail).toEqual([]);
    }
    expect(
      found(fx.propFile(fx.propBlock('[AC-1] p', ', { timeout: 900_000, concurrent: true }'))),
    ).toEqual([]);
    expect(found(fx.propFile(fx.PROP_OPTIONS_SECOND))).toEqual([]);
  });

  it('[CT-06zzzm] no third argument, 60_000, a name, a spread or no timeout key: a finding at the block line naming the fix', () => {
    const cases: [string, string][] = [
      ['', 'no timeout argument'],
      [', 60_000', 'the timeout 60_000 is too small'],
      [', TIMEOUT', 'the timeout `TIMEOUT` is not a number literal'],
      [', 15 * 60_000', 'the timeout `15 * 60_000` is not a number literal'],
      [', { timeout: 60_000 }', 'the timeout 60_000 is too small'],
      [', { timeout: LONG }', 'the timeout `LONG` is not a number literal'],
      [', { ...opts, timeout: 900_000 }', 'the options object spreads another object'],
      [', { concurrent: true }', 'the options object has no timeout'],
    ];
    for (const [tail, why] of cases) {
      const text = fx.propFile(fx.PROP_PLAIN('[AC-0] plain'), fx.propBlock('[AC-1] p', tail));
      expect(found(text), tail).toEqual([[line(text, "it('[AC-1] p'"), `${FIX} (${why})`]]);
    }
    // A direct call in the body, propParams() inside another argument; a chain (.concurrent).
    expect(found(fx.propFile(fx.PROP_DIRECT))).toEqual([[4, `${FIX} (no timeout argument)`]]);
    expect(found(fx.propFile(fx.PROP_AS_ARGUMENT))).toEqual([
      [4, `${FIX} (the timeout 30_000 is too small)`],
    ]);
    expect(found(fx.propFile(fx.PROP_CONCURRENT))).toEqual([
      [4, `${FIX} (the timeout 899_999 is too small)`],
    ]);
  });

  it('[CT-06zzzm] .each: the argument after the callback of the call after the table', () => {
    expect(found(fx.propFile(fx.PROP_EACH(', 900_000')))).toEqual([]);
    expect(found(fx.propFile(fx.PROP_EACH('')))).toEqual([[4, `${FIX} (no timeout argument)`]]);
    expect(found(fx.propFile(fx.PROP_EACH(', 5_000')))).toEqual([
      [4, `${FIX} (the timeout 5_000 is too small)`],
    ]);
  });

  it('[CT-06zzzm] a block without propParams() is not reported; neither is the static mode', () => {
    const text = fx.propFile(fx.PROP_PLAIN('[AC-0] plain'), fx.propBlock('[AC-1] p', ''));
    expect(found(fx.propFile(fx.PROP_PLAIN('[AC-0] plain')))).toEqual([]);
    expect(scanFile(FILE, text).filter((f) => f.rule === 'prop-timeout')).toEqual([]);
  });

  it('[CT-06zzzm] git mode: added files whole, modified files only in their new or changed blocks; other paths and removals not at all', () => {
    const bad = fx.propBlock('[AC-1] p', '');
    const base = fx.propFile(fx.PROP_PLAIN('[AC-0] plain'), bad);
    const files: Record<string, { base: string | null; head: string }> = {
      // New: the old-style block is reported.
      'test/spec/demo/new.test.ts': { base: null, head: base },
      // Modified next to the untouched old block: nothing reported.
      'test/spec/demo/frozen.test.ts': {
        base,
        head: fx.propFile(fx.PROP_PLAIN('[AC-0] plain'), bad, fx.PROP_PLAIN('[AC-2] new')),
      },
      // Modified, a new property test without a timeout: reported.
      'test/spec/demo/grown.test.ts': {
        base,
        head: fx.propFile(fx.PROP_PLAIN('[AC-0] plain'), bad, fx.propBlock('[AC-3] new', '')),
      },
      // Modified in the old block itself: reported.
      'test/spec/demo/touched.test.ts': {
        base,
        head: fx.propFile(fx.PROP_PLAIN('[AC-0] plain'), bad.replace('n === n', 'n + 0 === n')),
      },
      // Code outside the tests changed: judged whole.
      'test/spec/demo/import.test.ts': {
        base,
        head: base.replace(
          "import fc from 'fast-check';",
          "import fc from 'fast-check';\nimport { x } from './x.ts';",
        ),
      },
      // Not under test/spec, and a test-support file: not checked.
      'test/properties/demo/p.test.ts': { base: null, head: base },
      'test/spec/demo/kit.ts': { base: null, head: base },
    };
    const changes: Change[] = [
      { path: 'test/spec/demo/new.test.ts', status: 'A' },
      { path: 'test/spec/demo/frozen.test.ts', status: 'M' },
      { path: 'test/spec/demo/grown.test.ts', status: 'M' },
      { path: 'test/spec/demo/touched.test.ts', status: 'M' },
      { path: 'test/spec/demo/import.test.ts', status: 'M' },
      { path: 'test/spec/demo/untracked.test.ts', status: '?' },
      { path: 'test/spec/demo/gone.test.ts', status: 'D' },
      { path: 'test/properties/demo/p.test.ts', status: 'A' },
      { path: 'test/spec/demo/kit.ts', status: 'A' },
    ];
    files['test/spec/demo/untracked.test.ts'] = { base: null, head: base };
    const got = propTimeoutChecks(
      changes,
      (p) => files[p]?.base ?? null,
      (p) => files[p]?.head ?? null,
    );
    expect(got.map((f) => [f.file, f.rule])).toEqual([
      ['test/spec/demo/new.test.ts', 'prop-timeout'],
      ['test/spec/demo/grown.test.ts', 'prop-timeout'],
      ['test/spec/demo/touched.test.ts', 'prop-timeout'],
      ['test/spec/demo/import.test.ts', 'prop-timeout'],
      ['test/spec/demo/untracked.test.ts', 'prop-timeout'],
    ]);
    const grown = got.find((f) => f.file === 'test/spec/demo/grown.test.ts');
    const head = files['test/spec/demo/grown.test.ts']?.head ?? '';
    expect(grown?.line).toBe(line(head, "it('[AC-3] new'"));
    expect(grown?.message).toBe(`${FIX} (no timeout argument)`);
  });
});

describe('[CT-06zzzm] Codex r1: comments and strings, commented timeouts', () => {
  const FILE = 'test/spec/demo/prop.test.ts';
  const FIX = 'propParams() 的用例须写显式超时 ≥ 900_000：补 `}, 900_000);`，见 D10-750';
  const found = (text: string) =>
    propTimeoutFindings(FILE, text, null).map((f) => [f.line, f.message]);

  it('[CT-06zzzm] propParams() in a comment or a string is no call; inside ${…} of a template it is', () => {
    expect(found(fx.propFile(fx.PROP_IN_COMMENT))).toEqual([]);
    expect(found(fx.propFile(fx.PROP_IN_STRING))).toEqual([]);
    expect(found(fx.propFile(fx.PROP_IN_INTERPOLATION))).toEqual([
      [4, `${FIX} (no timeout argument)`],
    ]);
  });

  it('[CT-06zzzm] a timeout with comments around it passes; a commented one below the minimum still fails', () => {
    for (const tail of [
      ', 900_000 /* 高次数运行 */',
      ', /* 高次数运行 */ 900_000',
      ', 900_000 // 高次数运行\n',
      ', { timeout: 900_000 /* 高次数运行 */ }',
      ', { /* 高次数 */ timeout: /* 运行 */ 900_000 }',
    ]) {
      expect(found(fx.propFile(fx.propBlock('[AC-1] p', tail))), tail).toEqual([]);
    }
    for (const tail of [', 60_000 /* 高次数运行 */', ', { timeout: 60_000 /* 高次数运行 */ }']) {
      expect(found(fx.propFile(fx.propBlock('[AC-1] p', tail))), tail).toEqual([
        [4, `${FIX} (the timeout 60_000 is too small)`],
      ]);
    }
  });
});
