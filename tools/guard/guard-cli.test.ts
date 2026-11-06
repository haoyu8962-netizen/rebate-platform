// End-to-end tests of the guard command lines against fixture trees and repositories.
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { repoRoot } from '../lib/paths.ts';
import { renderRiskTable, TABLE_BEGIN, TABLE_END } from './lib/agents-table.ts';
import { cleanupFixtures, fixtureGit, makeRepo, makeTree, writeFiles } from './lib/fixture-kit.ts';
import { loadRiskMap } from './lib/risk.ts';
import * as fx from './lib/test-guard.fixtures.ts';

const GUARD_DIR = join(repoRoot(), 'tools', 'guard');
let trusted = '';

const LEDGER_TASK = [
  'id: B2-02a',
  'repo: rebate-platform',
  'title: ledger：凭证与分录写入',
  'type: impl',
  'refs: [BR-FUND-13]',
  'refs_hash:',
  '  BR-FUND-13: 0123456789ab',
  'deps: []',
  'paths:',
  '  - "apps/api/src/modules/ledger/**"',
  'impl: codex',
  'tester: claude',
  'accept:',
  '  - "pnpm verify"',
  'status: todo',
  'pr: null',
  '',
].join('\n');

const DEPS_TASK = LEDGER_TASK.replace('id: B2-02a', 'id: D1-01')
  .replace('type: impl', 'type: deps')
  .replace('  - "apps/api/src/modules/ledger/**"', '  - "package.json"\n  - "pnpm-lock.yaml"');

/** A task of the default split of 2026-10-05: Codex writes its rule tests into test_paths. */
const AUTHOR_TASK = LEDGER_TASK.replace('id: B2-02a', 'id: B2-02b')
  .replace('impl: codex', 'impl: claude')
  .replace('tester: claude', 'tester: codex\ntest_paths:\n  - "test/spec/ledger/**"');
/** CT-06r: the same task with two declared red exemptions in the trusted ledger. */
const DECLARED_TASK = AUTHOR_TASK.replace('id: B2-02b', 'id: B2-02e').replace(
  'test_paths:\n  - "test/spec/ledger/**"',
  'test_paths:\n  - "test/spec/ledger/**"\nred_exempt:\n  - file: test/spec/ledger/post.test.ts\n    test: "[AC-2] keeps"\n    reason: structural, holds for the old csv too\n  - file: test/spec/ledger/post.test.ts\n    test: "[AC-1] posts"\n    reason: declared although the test changed (must not apply)',
);
/** CT-06zxc: the same task with a declared literal rename in the trusted ledger. */
const RENAMES_TASK = AUTHOR_TASK.replace('id: B2-02b', 'id: B2-02f').replace(
  'test_paths:\n  - "test/spec/ledger/**"',
  'test_paths:\n  - "test/spec/ledger/**"\nrenames:\n  - from: "\'post-job\'"\n    to: "\'post_job\'"',
);
/** CT-06zxe: the same task with a registered expected value in the trusted ledger. */
const VALUES_TASK = AUTHOR_TASK.replace('id: B2-02b', 'id: B2-02g').replace(
  'test_paths:\n  - "test/spec/ledger/**"',
  "test_paths:\n  - \"test/spec/ledger/**\"\nexpected_values:\n  - file: test/spec/ledger/anomaly.test.ts\n    helper: onlyAnomaly\n    from: '  expect(diff).toBe(AMOUNT);'\n    to: '  expect(diff).toBe(-AMOUNT);'",
);
const OLD_LEDGER_TASK = AUTHOR_TASK.replace('id: B2-02b', 'id: B2-02c').replace(
  'test_paths:\n  - "test/spec/ledger/**"\n',
  '',
);
/** A new task (not a ledger of the switch baseline) that omits test_paths (CR2-02). */
const NEW_NO_TEST_PATHS_TASK = OLD_LEDGER_TASK.replace('id: B2-02c', 'id: B2-02d');
const NO_TESTER_TASK = LEDGER_TASK.replace('id: B2-02a', 'id: N1-01').replace(
  'tester: claude',
  'tester: none',
);

/**
 * A Codex implementation of an interface (ops/approvals.yaml id 31): Codex implements in the
 * content module, Claude's mechanical commit removes the planned marker and regenerates.
 */
const MECHANICAL_TASK = LEDGER_TASK.replace('id: B2-02a', 'id: F1-02e').replace(
  '  - "apps/api/src/modules/ledger/**"',
  '  - "apps/api/src/modules/content/**"\ntest_paths:\n  - "test/spec/content/**"\nmechanical_paths:\n  - "contracts/openapi.yaml"\n  - "apps/api/src/route-schemas.gen.ts"',
);

const APPROVALS = [
  'source: "规划/11 §7.3"',
  'spec_ref: cbd8f06fa7ab14631f1e7f4dd9106fda8bef749b',
  'approvals:',
  '  - id: 0',
  '    row: 0',
  '    title: "技术栈锁定"',
  '    granted: true',
  '    date: "2026-10-01"',
  '    note: ""',
  '  - id: 1',
  '    row: 1',
  '    title: "建仓库"',
  '    granted: false',
  '    date: "2026-10-01"',
  '    note: ""',
  '',
].join('\n');

function guard(
  name: string,
  args: string[],
  opts: { cwd?: string; input?: string; env?: Record<string, string> } = {},
): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [join(GUARD_DIR, name), ...args], {
    cwd: opts.cwd ?? trusted,
    input: opts.input ?? '',
    encoding: 'utf8',
    env: {
      ...process.env,
      COULI_TRUSTED_ROOT: trusted,
      COULI_SPEC_REPO: '/nonexistent/planning-repo',
      ...opts.env,
    },
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

function json<T>(stdout: string): T {
  return JSON.parse(stdout) as T;
}

function workRepo(): { root: string; base: string } {
  return makeRepo({
    'apps/api/src/modules/ledger/post.ts': 'export const post = 1;\n',
    'apps/api/src/modules/orders/sync.ts': 'export const sync = 1;\n',
    'test/spec/ledger/post.test.ts': "it('posts', () => {});\n",
    'package.json': JSON.stringify({ name: 'x', scripts: { test: 'vitest run' } }, null, 2),
    'pnpm-lock.yaml': 'lockfileVersion: 9\n',
    'turbo.json': '{}\n',
    'docs/notes.md': '# notes\n',
  });
}

beforeAll(() => {
  trusted = makeTree({
    'ops/tasks/B2-02a.yaml': LEDGER_TASK,
    'ops/tasks/D1-01.yaml': DEPS_TASK,
    'ops/tasks/B2-02b.yaml': AUTHOR_TASK,
    'ops/tasks/B2-02e.yaml': DECLARED_TASK,
    'ops/tasks/B2-02f.yaml': RENAMES_TASK,
    'ops/tasks/B2-02g.yaml': VALUES_TASK,
    'ops/tasks/B2-02c.yaml': OLD_LEDGER_TASK,
    'ops/tasks/N1-01.yaml': NO_TESTER_TASK,
    'ops/tasks/B2-02d.yaml': NEW_NO_TEST_PATHS_TASK,
    // The fixture's own switch-baseline list: B2-02a stands for a ledger written before
    // 2026-10-05 (no test_paths, old scope); B2-02d is not on it.
    'tools/guard/legacy-tasks.json': JSON.stringify({ baseline: 'fixture', tasks: ['B2-02a'] }),
    'ops/approvals.yaml': APPROVALS,
    'ops/tasks/F1-02e.yaml': MECHANICAL_TASK,
    'tools/guard/codex-impl-tasks.json': JSON.stringify({
      approval: 23,
      tasks: ['F1-02e'],
      forbidden_paths: ['contracts/**'],
      mechanical_paths: [
        'contracts/openapi.yaml',
        'apps/api/src/route-schemas.gen.ts',
        'packages/contracts-ts/src/openapi.gen.ts',
      ],
    }),
  });
  for (const file of [
    'tools/guard/protected-paths.json',
    'tools/guard/banned-terms.txt',
    'tools/guard/banned-terms.allow.txt',
    'ops/risk-map.yaml',
  ]) {
    mkdirSync(dirname(join(trusted, file)), { recursive: true });
    copyFileSync(join(repoRoot(), file), join(trusted, file));
  }
});

afterAll(cleanupFixtures);

describe('risk-of-paths.ts', () => {
  it('prints the report as JSON and always exits 0', () => {
    const res = guard('risk-of-paths.ts', [
      '--json',
      'packages/money/src/index.ts',
      'docs/README.md',
      'turbo.json',
    ]);
    expect(res.status).toBe(0);
    expect(json(res.stdout)).toEqual({
      risk: 'RV2',
      ask: true,
      paths: [
        {
          path: 'packages/money/src/index.ts',
          risk: 'RV2',
          rule: 'packages/money/**',
          protected: null,
        },
        { path: 'docs/README.md', risk: 'RV0', rule: 'docs/**', protected: null },
        { path: 'turbo.json', risk: 'RV2', rule: 'default', protected: 2 },
      ],
    });
  });

  it('reads newline- or NUL-separated paths from stdin', () => {
    const lines = guard('risk-of-paths.ts', ['--json', '--stdin'], {
      input: 'docs/a.md\ndocs/中 文.md\n',
    });
    expect(json<{ risk: string; paths: unknown[] }>(lines.stdout)).toMatchObject({ risk: 'RV0' });
    const nul = guard('risk-of-paths.ts', ['--json', '--stdin'], {
      input: 'docs/a.md\0contracts/openapi.yaml\0',
    });
    expect(json<{ risk: string; paths: unknown[] }>(nul.stdout).risk).toBe('RV1');
    expect(json<{ paths: unknown[] }>(nul.stdout).paths).toHaveLength(2);
  });

  it('--sets answers one report per set, each as a call of its own, paths kept intact', () => {
    const sets = [
      ['docs/a.md', 'packages/money/src/index.ts'],
      ['docs/README.md', 'turbo.json'],
      ['docs/a.md\ndocs/b.md', 'docs/c\u0000d.md'],
      [],
    ];
    const res = guard('risk-of-paths.ts', ['--sets'], { input: JSON.stringify(sets) });
    expect(res.status).toBe(0);
    const reports = json<{ risk: string; ask: boolean; paths: unknown[] }[]>(res.stdout);
    expect(reports).toHaveLength(sets.length);
    for (const [i, set] of sets.slice(0, 2).entries()) {
      expect(reports[i]).toEqual(json(guard('risk-of-paths.ts', ['--json', ...set]).stdout));
    }
    expect(reports[0]).toMatchObject({ risk: 'RV2', ask: false });
    expect(reports[1]).toMatchObject({ risk: 'RV2', ask: true });
    // A newline or NUL inside a path stays inside that path: two rows, not four.
    expect(reports[2]?.paths).toHaveLength(2);
    expect(reports[3]).toEqual({ risk: 'RV2', ask: false, paths: [] });
  });

  it('--sets rejects input that is not an array of string arrays, and other arguments', () => {
    for (const input of ['not json', '{"a":1}', '[["docs/a.md", 1]]', '["docs/a.md"]']) {
      expect(guard('risk-of-paths.ts', ['--sets'], { input }).status).toBe(2);
    }
    expect(guard('risk-of-paths.ts', ['--sets', '--json'], { input: '[]' }).status).toBe(2);
    expect(guard('risk-of-paths.ts', ['--sets', 'docs/a.md'], { input: '[]' }).status).toBe(2);
  });

  it('prints a readable table without --json and rejects wrong usage with exit 2', () => {
    const res = guard('risk-of-paths.ts', ['docs/a.md']);
    expect(res.stdout).toBe('RV0  docs/a.md  (docs/**)\nrisk: RV0\n');
    expect(guard('risk-of-paths.ts', []).status).toBe(2);
    expect(guard('risk-of-paths.ts', ['--stdin', 'x']).status).toBe(2);
    expect(guard('risk-of-paths.ts', ['--nope']).status).toBe(2);
  });
});

describe('path-guard.ts, protected-paths.ts, test-guard.ts, run.ts git', () => {
  type PathGuardJson = {
    ok: boolean;
    violations: { path: string; reason: string }[];
    out_of_scope_ops_docs: string[];
    protected_hits: { path: string; class: number }[];
  };

  it('passes a change that stays inside the task paths', () => {
    const { root, base } = workRepo();
    writeFiles(root, {
      'apps/api/src/modules/ledger/post.ts': 'export const post = 2;\n',
      'apps/api/src/modules/ledger/新 文件.ts': 'export {};\n',
    });
    const res = guard('path-guard.ts', [
      '--task',
      'B2-02a',
      '--base',
      base,
      '--cwd',
      root,
      '--json',
    ]);
    expect(res.status).toBe(0);
    expect(json<PathGuardJson>(res.stdout)).toEqual({
      ok: true,
      violations: [],
      out_of_scope_ops_docs: [],
      protected_hits: [],
    });
    expect(guard('run.ts', ['git', '--base', base, '--task', 'B2-02a', '--cwd', root]).status).toBe(
      0,
    );
  });

  it('fails on out-of-scope changes and reports ops/docs and protected hits separately', () => {
    const { root, base } = workRepo();
    writeFiles(root, {
      'apps/api/src/modules/ledger/post.ts': 'export const post = 2;\n',
      'apps/api/src/modules/orders/sync.ts': 'export const sync = 2;\n',
      'docs/notes.md': '# changed\n',
      'turbo.json': '{ "tasks": {} }\n',
      'scratch file.txt': 'x\n',
    });
    const res = guard('path-guard.ts', [
      '--task',
      'B2-02a',
      '--base',
      base,
      '--cwd',
      root,
      '--json',
    ]);
    expect(res.status).toBe(1);
    expect(json<PathGuardJson>(res.stdout)).toEqual({
      ok: false,
      violations: [
        { path: 'apps/api/src/modules/orders/sync.ts', reason: 'modified outside the task paths' },
        { path: 'scratch file.txt', reason: 'untracked file outside the task paths' },
        { path: 'turbo.json', reason: 'modified outside the task paths' },
      ],
      out_of_scope_ops_docs: ['docs/notes.md'],
      protected_hits: [{ path: 'turbo.json', class: 2 }],
    });
    expect(res.stderr).toContain('turbo.json: modified outside the task paths');
  });

  it('accepts --paths with brace groups and uses the current directory by default', () => {
    const { root, base } = workRepo();
    writeFiles(root, { 'test/spec/ledger/new.test.ts': "it('new', () => {});\n" });
    const args = ['--paths', 'docs/**,test/{spec,acceptance}/**', '--base', base];
    expect(guard('path-guard.ts', args, { cwd: join(root, 'docs') }).status).toBe(0);
    expect(
      guard('path-guard.ts', ['--paths', 'docs/**', '--base', base], { cwd: root }).status,
    ).toBe(1);
  });

  it('[CR-05, CR-06] --author: only the task test_paths and per-function NotImplemented shells', () => {
    const { root, base } = workRepo();
    writeFiles(root, {
      'test/spec/ledger/new.test.ts': "it('new', () => {});\n",
      // Another area's rule tests are not this task's test_paths.
      'test/spec/money/other.test.ts': "it('other', () => {});\n",
      // A shell next to a real implementation in one file, the keyword only in a comment.
      'apps/api/src/modules/ledger/post.ts': [
        'export const post = 1;',
        "export function plan(a: number): never {\n  void a;\n  throw new Error('NotImplemented: plan');\n}",
        '// NotImplemented',
        'export function book(a: number): number {\n  return a + 1;\n}',
        '',
      ].join('\n'),
      'docs/notes.md': '# changed\n',
    });
    const res = guard('path-guard.ts', [
      '--task',
      'B2-02b',
      '--base',
      base,
      '--cwd',
      root,
      '--json',
      '--author',
    ]);
    expect(res.status).toBe(1);
    const out = json<PathGuardJson>(res.stdout);
    expect(out.violations.map((v) => v.path)).toEqual([
      'apps/api/src/modules/ledger/post.ts',
      'test/spec/money/other.test.ts',
    ]);
    expect(out.violations[0]?.reason).toContain('book: does not end with throw new NotImplemented');
    expect(out.out_of_scope_ops_docs).toEqual(['docs/notes.md']);

    // Without test_paths in the ledger the test phase is refused outright.
    const old = guard('path-guard.ts', [
      '--task',
      'B2-02c',
      '--base',
      base,
      '--cwd',
      root,
      '--json',
      '--author',
    ]);
    expect(old.status).toBe(1);
    expect(json<PathGuardJson>(old.stdout).violations[0]?.reason).toContain(
      'the task has no test_paths',
    );
  });

  it('[CR-16] red-check --json prints exactly one JSON document, also when it skips', () => {
    const { root, base } = workRepo();
    const skip = guard('red-check.ts', ['--task', 'N1-01', '--report', '/nonexistent', '--json']);
    expect(skip.status).toBe(0);
    expect(json<{ required: boolean }>(skip.stdout)).toMatchObject({ required: false, ok: true });
    expect(skip.stderr).toContain('SKIP red-check');

    writeFiles(root, { 'test/spec/ledger/new.test.ts': "it('new', () => {});\n" });
    const reportFile = join(root, '..', 'red-report.json');
    writeFileSync(
      reportFile,
      JSON.stringify({
        testResults: [
          {
            name: `${root}/test/spec/ledger/new.test.ts`,
            assertionResults: [
              { fullName: 'new', status: 'failed', failureMessages: ['Error: NotImplemented'] },
            ],
          },
        ],
      }),
    );
    const res = guard('red-check.ts', [
      '--task',
      'B2-02b',
      '--report',
      reportFile,
      '--cwd',
      root,
      '--base',
      base,
      '--root',
      root,
      '--json',
    ]);
    expect(res.status, res.stderr).toBe(0);
    expect(json<{ ok: boolean; expected: string[] }>(res.stdout)).toMatchObject({
      ok: true,
      expected: ['test/spec/ledger/new.test.ts'],
    });
    expect(res.stderr).toContain('PASS red-check');
  });

  it('[CT-06p] red-check --base / --head-tree: a file that existed at the base needs only its changed tests red', () => {
    const t = (title: string, body: string): string => `it('${title}', () => {\n  ${body}\n});\n`;
    const vitest = "import { expect, it } from 'vitest';\n";
    const file = 'test/spec/ledger/post.test.ts';
    const { root, base } = makeRepo({
      [file]:
        vitest + t('[AC-1] posts', 'expect(1).toBe(1);') + t('[AC-2] keeps', 'expect(2).toBe(2);'),
    });
    // The task changes the assertion of [AC-1] only; the head tree is what the red run ran.
    writeFiles(root, {
      [file]:
        vitest + t('[AC-1] posts', 'expect(1).toBe(3);') + t('[AC-2] keeps', 'expect(2).toBe(2);'),
    });
    fixtureGit(root, ['commit', '-qam', 'test(spec): change [AC-1]']);
    const tree = fixtureGit(root, ['rev-parse', 'HEAD^{tree}']);
    // A later edit of the work tree is not what ran: --head-tree is read, not the work tree.
    writeFiles(root, {
      [file]:
        vitest + t('[AC-1] posts', 'expect(1).toBe(1);') + t('[AC-2] keeps', 'expect(9).toBe(9);'),
    });
    const list = join(root, '..', `expected-${Date.now()}.txt`);
    writeFileSync(list, `${file}\n`);
    const reportFile = join(root, '..', `red-report-${Date.now()}.json`);
    writeFileSync(
      reportFile,
      JSON.stringify({
        reporter: 'couli-red-reporter',
        testResults: [
          {
            name: `${root}/${file}`,
            assertionResults: [
              {
                fullName: '[AC-1] posts',
                status: 'failed',
                failures: [{ causes: [{ name: 'AssertionError', message: 'expected 1 to be 3' }] }],
              },
              { fullName: '[AC-2] keeps', status: 'passed', failures: [] },
            ],
          },
        ],
      }),
    );
    const args = [
      '--task',
      'B2-02b',
      '--report',
      reportFile,
      '--expected-list',
      list,
      '--root',
      root,
      '--json',
    ];
    const res = guard('red-check.ts', [
      ...args,
      '--cwd',
      root,
      '--base',
      base,
      '--head-tree',
      tree,
    ]);
    expect(res.status, res.stderr).toBe(0);
    expect(json<{ ok: boolean; red: string[]; exempt: unknown[] }>(res.stdout)).toMatchObject({
      ok: true,
      red: [`${file} > [AC-1] posts`],
      exempt: [{ file, test: '[AC-2] keeps', status: 'passed' }],
    });
    expect(res.stderr).toContain('1 unchanged test(s) of files that existed at the base exempt');
    // Without the base every test must be red, as before.
    const old = guard('red-check.ts', args);
    expect(old.status).toBe(1);
    expect(old.stderr).toContain('[AC-2] keeps: green on the skeleton: the test has no teeth');
    // A base that cannot be read: the old rule, said in the notes.
    const bad = guard('red-check.ts', [
      ...args,
      '--cwd',
      root,
      '--base',
      'no-such-ref',
      '--head-tree',
      tree,
    ]);
    expect(bad.status).toBe(1);
    expect(json<{ notes: string[] }>(bad.stdout).notes[0]).toContain(
      'cannot compare with the base no-such-ref',
    );
    expect(guard('red-check.ts', [...args, '--head-tree', tree]).status).toBe(2);
  });

  it("[CT-06r] red-check: the trusted ledger's red_exempt lets a declared, unchanged test of a file that reads a changed data file pass", () => {
    const t = (title: string, body: string): string => `it('${title}', () => {\n  ${body}\n});\n`;
    const vitest = "import { expect, it } from 'vitest';\n";
    const file = 'test/spec/ledger/post.test.ts';
    const csv = 'test/spec/ledger/expected.csv';
    const keeps = t(
      '[AC-2] keeps',
      "expect(readFileSync('./expected.csv', 'utf8')).toMatch(/a,b/);",
    );
    const { root, base } = makeRepo({
      [file]: vitest + t('[AC-1] posts', 'expect(1).toBe(1);') + keeps,
      [csv]: 'a,b\n1,2\n',
    });
    // The task changes the assertion of [AC-1] and the data file the test file reads.
    writeFiles(root, {
      [file]: vitest + t('[AC-1] posts', 'expect(1).toBe(3);') + keeps,
      [csv]: 'a,b\n1,2\n3,4\n',
    });
    fixtureGit(root, ['commit', '-qam', 'test(spec): change [AC-1] and the csv']);
    const tree = fixtureGit(root, ['rev-parse', 'HEAD^{tree}']);
    const list = join(root, '..', `expected-${Date.now()}.txt`);
    writeFileSync(list, `${file}\n`);
    const reportFile = join(root, '..', `red-report-declared-${Date.now()}.json`);
    writeFileSync(
      reportFile,
      JSON.stringify({
        reporter: 'couli-red-reporter',
        testResults: [
          {
            name: `${root}/${file}`,
            assertionResults: [
              {
                fullName: '[AC-1] posts',
                status: 'failed',
                failures: [{ causes: [{ name: 'AssertionError', message: 'expected 1 to be 3' }] }],
              },
              { fullName: '[AC-2] keeps', status: 'passed', failures: [] },
            ],
          },
        ],
      }),
    );
    const args = (task: string): string[] => [
      '--task',
      task,
      '--report',
      reportFile,
      '--expected-list',
      list,
      '--root',
      root,
      '--json',
      '--cwd',
      root,
      '--base',
      base,
      '--head-tree',
      tree,
    ];
    // B2-02b declares nothing: the file reads the changed csv, so every test must be red (CT-06p).
    const undeclared = guard('red-check.ts', args('B2-02b'));
    expect(undeclared.status).toBe(1);
    expect(undeclared.stderr).toContain(
      '[AC-2] keeps: green on the skeleton: the test has no teeth (the file may read a test-support file the task changed and the ledger does not declare this test exempt)',
    );
    // B2-02e declares [AC-2] keeps (unchanged: exempt) and [AC-1] posts (changed: no effect).
    const res = guard('red-check.ts', args('B2-02e'));
    expect(res.status, res.stderr).toBe(0);
    expect(
      json<{ ok: boolean; red: string[]; exempt: unknown[]; notes: string[] }>(res.stdout),
    ).toMatchObject({
      ok: true,
      red: [`${file} > [AC-1] posts`],
      exempt: [
        {
          file,
          test: '[AC-2] keeps',
          status: 'passed',
          declared: true,
          reason: 'structural, holds for the old csv too',
        },
      ],
    });
    expect(res.stderr).toContain(
      "[AC-2] keeps: unchanged since the base, exempt by the task's declaration (green; reason: structural, holds for the old csv too); needs the rule-test reviewer's confirmation",
    );
    expect(res.stderr).toContain(
      '[AC-1] posts: declared exempt, but the declaration does not apply: the test is new or changed since the base',
    );
    expect(res.stderr).toContain(
      "1 unchanged test(s) of files that existed at the base exempt (1 by the ledger's red_exempt declarations: the rule-test reviewer must confirm them)",
    );
    // Without the base the declarations do not apply: every test must be red, as before.
    const old = guard('red-check.ts', args('B2-02e').slice(0, 9));
    expect(old.status).toBe(1);
    expect(old.stderr).toContain('[AC-2] keeps: green on the skeleton: the test has no teeth');
  });

  it("[CT-06zxc] red-check: a file that differs from its base only by the trusted ledger's renames is not expected", () => {
    const t = (title: string, body: string): string => `it('${title}', () => {\n  ${body}\n});\n`;
    const vitest = "import { expect, it } from 'vitest';\n";
    const file = 'test/spec/ledger/post.test.ts';
    const renamed = 'test/spec/ledger/job.test.ts';
    const job = (name: string): string =>
      `${vitest}const JOB = '${name}';\n${t('[AC-3] job', `expect(send('${name}')).toBe(JOB);`)}`;
    const { root, base } = makeRepo({
      [file]: vitest + t('[AC-1] posts', 'expect(1).toBe(1);'),
      [renamed]: job('post-job'),
    });
    writeFiles(root, {
      [file]: vitest + t('[AC-1] posts', 'expect(1).toBe(3);'),
      [renamed]: job('post_job'),
    });
    fixtureGit(root, ['commit', '-qam', 'test(spec): change [AC-1], rename the job']);
    const tree = fixtureGit(root, ['rev-parse', 'HEAD^{tree}']);
    // --print-expected leaves the renamed-only file out (B2-02f), keeps it without renames.
    const printed = (task: string) =>
      guard('red-check.ts', ['--task', task, '--cwd', root, '--base', base, '--print-expected']);
    const left = printed('B2-02f');
    expect(left.status, left.stderr).toBe(0);
    expect(left.stdout).toBe(`${file}\n`);
    expect(left.stderr).toContain(
      `${renamed}: unchanged after the ledger's renames (D10-347: "'post-job'" → "'post_job'" ×2), left out of the expected list`,
    );
    expect(printed('B2-02b').stdout).toBe(`${renamed}\n${file}\n`);
    // An older expected list that still names it: left out of the check too, said in the notes.
    const list = join(root, '..', `expected-renamed-${Date.now()}.txt`);
    writeFileSync(list, `${file}\n${renamed}\n`);
    const reportFile = join(root, '..', `red-report-renamed-${Date.now()}.json`);
    writeFileSync(
      reportFile,
      JSON.stringify({
        reporter: 'couli-red-reporter',
        testResults: [
          {
            name: `${root}/${file}`,
            assertionResults: [
              {
                fullName: '[AC-1] posts',
                status: 'failed',
                failures: [{ causes: [{ name: 'AssertionError', message: 'expected 1 to be 3' }] }],
              },
            ],
          },
          {
            name: `${root}/${renamed}`,
            assertionResults: [
              {
                fullName: '[AC-3] job',
                status: 'failed',
                failures: [{ causes: [{ name: 'Error', message: 'unknown job post_job' }] }],
              },
            ],
          },
        ],
      }),
    );
    const args = (task: string): string[] => [
      '--task',
      task,
      '--report',
      reportFile,
      '--expected-list',
      list,
      '--root',
      root,
      '--json',
      '--cwd',
      root,
      '--base',
      base,
      '--head-tree',
      tree,
    ];
    const res = guard('red-check.ts', args('B2-02f'));
    expect(res.status, res.stderr).toBe(0);
    const doc = json<{ ok: boolean; expected: string[]; red: string[]; notes: string[] }>(
      res.stdout,
    );
    expect(doc).toMatchObject({ ok: true, expected: [file], red: [`${file} > [AC-1] posts`] });
    expect(doc.notes[0]).toContain(`${renamed}: unchanged after the ledger's renames`);
    // Without the declaration the file is changed: its test is red for no valid reason.
    const without = guard('red-check.ts', args('B2-02b'));
    expect(without.status).toBe(1);
    expect(without.stderr).toContain(`${renamed} > [AC-3] job: red for an unrecognised reason`);
  });

  it("[CT-06zxe] red-check: with the trusted ledger's expected value only the tests calling the helper must be red", () => {
    const vitest = "import { expect, it } from 'vitest';\n";
    const file = 'test/spec/ledger/anomaly.test.ts';
    const source = (sign: string): string =>
      `${vitest}const AMOUNT = 500n;\nfunction onlyAnomaly(diff: bigint) {\n  expect(diff).toBe(${sign}AMOUNT);\n}\n` +
      "it('[AC-1] calls it', () => {\n  onlyAnomaly(post());\n});\n" +
      "it('[AC-2] does not', () => {\n  expect(post()).toBeDefined();\n});\n";
    const { root, base } = makeRepo({ [file]: source('') });
    writeFiles(root, { [file]: source('-') });
    fixtureGit(root, ['commit', '-qam', 'test(spec): diff_fen is expected - actual']);
    const tree = fixtureGit(root, ['rev-parse', 'HEAD^{tree}']);
    const reportFile = join(root, '..', `red-report-values-${Date.now()}.json`);
    const failed = (fullName: string) => ({
      fullName,
      status: 'failed',
      failures: [{ causes: [{ name: 'AssertionError', message: 'expected 500n to be -500n' }] }],
    });
    writeFileSync(
      reportFile,
      JSON.stringify({
        reporter: 'couli-red-reporter',
        testResults: [
          {
            name: `${root}/${file}`,
            assertionResults: [
              failed('[AC-1] calls it'),
              { fullName: '[AC-2] does not', status: 'passed' },
            ],
          },
        ],
      }),
    );
    const args = (task: string): string[] => [
      '--task',
      task,
      '--report',
      reportFile,
      '--root',
      root,
      '--json',
      '--cwd',
      root,
      '--base',
      base,
      '--head-tree',
      tree,
    ];
    const res = guard('red-check.ts', args('B2-02g'));
    expect(res.status, res.stderr).toBe(0);
    const doc = json<{ ok: boolean; red: string[]; notes: string[]; exempt: unknown[] }>(
      res.stdout,
    );
    expect(doc).toMatchObject({
      ok: true,
      red: [`${file} > [AC-1] calls it`],
      exempt: [{ file, test: '[AC-2] does not', status: 'passed' }],
    });
    expect(doc.notes.join('\n')).toContain(
      `${file}: compared with its base after the registered expected values (D10-371: ${file} / onlyAnomaly: "  expect(diff).toBe(AMOUNT);" → "  expect(diff).toBe(-AMOUNT);"); tests calling the changed helper(s), which must be red: [AC-1] calls it`,
    );
    // Without the registration the helper change judges the whole file: [AC-2] must be red too.
    const without = guard('red-check.ts', args('B2-02b'));
    expect(without.status).toBe(1);
    expect(without.stderr).toContain(`${file} > [AC-2] does not: green on the skeleton`);
  });

  it('rejects wrong usage with exit 2', () => {
    const { root, base } = workRepo();
    expect(guard('path-guard.ts', ['--task', 'B2-02a', '--cwd', root]).status).toBe(2);
    expect(guard('path-guard.ts', ['--base', base, '--cwd', root]).status).toBe(2);
    expect(
      guard('path-guard.ts', ['--task', 'B2-02a', '--paths', 'a/**', '--base', base]).status,
    ).toBe(2);
    expect(guard('path-guard.ts', ['--task', 'B9-99', '--base', base, '--cwd', root]).status).toBe(
      2,
    );
    expect(
      guard('path-guard.ts', ['--task', 'B2-02a', '--base', 'no-such-ref', '--cwd', root]).status,
    ).toBe(2);
  });

  it('reads the task from the trusted root, not from the worktree', () => {
    const { root, base } = workRepo();
    writeFiles(root, {
      'ops/tasks/B2-02a.yaml': LEDGER_TASK.replace('apps/api/src/modules/ledger/**', '**'),
      'apps/api/src/modules/orders/sync.ts': 'export const sync = 3;\n',
    });
    const res = guard('path-guard.ts', [
      '--task',
      'B2-02a',
      '--base',
      base,
      '--cwd',
      root,
      '--json',
    ]);
    expect(res.status).toBe(1);
    expect(json<PathGuardJson>(res.stdout).out_of_scope_ops_docs).toEqual([
      'ops/tasks/B2-02a.yaml',
    ]);
  });

  it('lists protected hits by class and exits 1', () => {
    const { root, base } = workRepo();
    writeFiles(root, {
      'test/spec/ledger/post.test.ts': "it('posts differently', () => {});\n",
      'test/spec/ledger/added.test.ts': "it('added', () => {});\n",
      'package.json': JSON.stringify({ name: 'x', scripts: { test: 'true' } }, null, 2),
      'pnpm-lock.yaml': 'lockfileVersion: 9\npackages: {}\n',
      'packages/money/AGENTS.md': '# rules\n',
    });
    const res = guard('protected-paths.ts', ['--base', base, '--cwd', root, '--json']);
    expect(res.status).toBe(1);
    expect(
      json<{ ok: boolean; class1: string[]; class2: string[]; class3: string[] }>(res.stdout),
    ).toMatchObject({
      ok: false,
      class1: ['test/spec/ledger/post.test.ts'],
      class2: ['package.json', 'pnpm-lock.yaml'],
      class3: ['packages/money/AGENTS.md'],
    });
  });

  it('allows the lock file and dependency edits in a deps task', () => {
    const { root, base } = workRepo();
    writeFiles(root, {
      'package.json': JSON.stringify(
        { name: 'x', scripts: { test: 'vitest run' }, dependencies: { zod: '4.6.5' } },
        null,
        2,
      ),
      'pnpm-lock.yaml': 'lockfileVersion: 9\npackages: {}\n',
    });
    expect(guard('protected-paths.ts', ['--base', base, '--cwd', root]).status).toBe(1);
    const deps = guard('protected-paths.ts', [
      '--base',
      base,
      '--cwd',
      root,
      '--task-type',
      'deps',
    ]);
    expect(deps.status).toBe(0);
    expect(deps.stdout).toBe('PASS protected-paths\n');
    expect(guard('run.ts', ['git', '--base', base, '--task', 'D1-01', '--cwd', root]).status).toBe(
      0,
    );
    expect(guard('protected-paths.ts', ['--base', base, '--task-type', 'nope']).status).toBe(2);
    expect(guard('protected-paths.ts', ['--cwd', root]).status).toBe(2);
  });

  it('test-guard reports static findings and modified test assets', () => {
    const { root, base } = workRepo();
    writeFiles(root, {
      'test/spec/ledger/post.test.ts': "describe('ledger', () => {});\n",
      'apps/api/src/modules/ledger/post.test.ts': fx.LISTEN,
    });
    const res = guard('test-guard.ts', ['--base', base, '--cwd', root, '--json']);
    expect(res.status).toBe(1);
    const out = json<{
      ok: boolean;
      findings: { file: string; rule: string }[];
      add_only_violations: { path: string }[];
    }>(res.stdout);
    expect(out.ok).toBe(false);
    expect(out.findings.map((f) => `${f.file}:${f.rule}`)).toEqual([
      'apps/api/src/modules/ledger/post.test.ts:unit-no-listen',
      'test/spec/ledger/post.test.ts:rule-tests-top-level-it',
    ]);
    expect(out.add_only_violations.map((v) => v.path)).toEqual(['test/spec/ledger/post.test.ts']);
    expect(guard('test-guard.ts', ['--cwd', root]).status).toBe(1);
  });

  it('[CT-06zzzm] test-guard --base reports prop-timeout for an added test/spec file only; the static mode does not', () => {
    const { root, base } = workRepo();
    writeFiles(root, {
      'test/spec/demo/prop.test.ts': fx.propFile(fx.propBlock('[AC-1] p', '')),
      'test/spec/demo/ok.test.ts': fx.propFile(fx.propBlock('[AC-2] q', ', 900_000')),
    });
    const res = guard('test-guard.ts', ['--base', base, '--cwd', root, '--json']);
    expect(res.status).toBe(1);
    const out = json<{ findings: { file: string; line: number; rule: string; message: string }[] }>(
      res.stdout,
    );
    expect(out.findings).toEqual([
      {
        file: 'test/spec/demo/prop.test.ts',
        line: 4,
        rule: 'prop-timeout',
        message:
          'propParams() 的用例须写显式超时 ≥ 900_000：补 `}, 900_000);`，见 D10-750 (no timeout argument)',
      },
    ]);
    expect(guard('test-guard.ts', ['--cwd', root]).status).toBe(0);
  });

  it('run.ts git prints one line per check and fails when any check fails', () => {
    const { root, base } = workRepo();
    writeFiles(root, { 'turbo.json': '{ "x": 1 }\n' });
    const withTask = guard('run.ts', ['git', '--base', base, '--task', 'B2-02a', '--cwd', root]);
    expect(withTask.status).toBe(1);
    expect(withTask.stdout).toBe(
      [
        'FAIL path-guard (1 problem)',
        'PASS ledger-overwrite',
        'PASS migration-sequence',
        'FAIL protected-paths (1 problem)',
        'PASS test-guard',
        'guard git: 3 passed, 2 failed, 0 skipped',
        '',
      ].join('\n'),
    );
    const withoutTask = guard('run.ts', ['git', '--base', base, '--cwd', root]);
    expect(withoutTask.stdout.split('\n').slice(0, 3)).toEqual([
      'PASS ledger-overwrite',
      'PASS migration-sequence',
      'FAIL protected-paths (1 problem)',
    ]);
    expect(guard('run.ts', ['git', '--cwd', root]).status).toBe(2);
    expect(guard('run.ts', ['git', '--base', base, '--cwd', makeTree()]).status).toBe(2);
    expect(guard('run.ts', ['bogus']).status).toBe(2);
  });
});

describe('run.ts static and the single-purpose guards', () => {
  function staticTree(extra: Record<string, string> = {}): string {
    const table = renderRiskTable(loadRiskMap(repoRoot()));
    const root = makeTree({
      'AGENTS.md': `# AGENTS\n\n${TABLE_BEGIN}\n${table}\n${TABLE_END}\n`,
      'CLAUDE.md': '@AGENTS.md\n',
      SPEC_REF: 'cbd8f06fa7ab14631f1e7f4dd9106fda8bef749b\n',
      'ops/risk-map.yaml': readFileSync(join(repoRoot(), 'ops', 'risk-map.yaml'), 'utf8'),
      'tools/guard/protected-paths.json': readFileSync(
        join(GUARD_DIR, 'protected-paths.json'),
        'utf8',
      ),
      'packages/money/src/index.test.ts': "it('works', () => {});\n",
      ...extra,
    });
    return root;
  }

  it('passes on a consistent tree without .git, skipping what needs the planning repository', () => {
    const res = guard('run.ts', ['static', '--cwd', staticTree()]);
    expect(res.stdout.split('\n')).toEqual([
      `SKIP schema-lint (tools/agent/schemas does not exist yet)`,
      'PASS agents-pair',
      'PASS risk-map-coverage',
      'PASS agents-table',
      'SKIP protected-sync (.github/workflows/protected-paths.yml does not exist yet)',
      'PASS test-guard',
      'PASS hidden-unicode',
      expect.stringMatching(/^(PASS|SKIP) lockfile-urls/),
      expect.stringMatching(/^SKIP spec-ref \(planning repository not found/),
      expect.stringMatching(/^SKIP banned-terms \(planning repository not found/),
      'guard static: 6 passed, 0 failed, 4 skipped',
      '',
    ]);
    expect(res.status).toBe(0);
    expect(res.stderr).toContain('no .git directory');
  });

  it('needs no git binary on a tree without .git (verify image)', () => {
    const root = staticTree();
    const res = guard('run.ts', ['static'], { cwd: root, env: { PATH: makeTree() } });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('guard static: 6 passed, 0 failed, 4 skipped');
  });

  it('accepts the argument separator that pnpm forwards', () => {
    const res = guard('run.ts', ['static', '--', '--cwd', staticTree()]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('PASS agents-pair');
  });

  it('fails with one line per failed check', () => {
    const zeroWidth = String.fromCodePoint(0x200b);
    const root = staticTree({
      'packages/extra/src/index.ts': `export const x = 1;${zeroWidth}\n`,
      'apps/api/AGENTS.md': '# nested rules\n',
      'tools/agent/schemas/impl.schema.json': JSON.stringify({ type: 'object', properties: {} }),
      '.github/workflows/protected-paths.yml':
        '# BEGIN protected-paths.json\n# { "class1_add_only": [] }\n# END protected-paths.json\n',
      'packages/money/src/index.test.ts': fx.RETRY_OPTION,
    });
    const res = guard('run.ts', ['static', '--cwd', root]);
    expect(res.status).toBe(1);
    expect(res.stdout.split('\n').slice(0, 7)).toEqual([
      'FAIL schema-lint (2 problems)',
      'FAIL agents-pair (1 problem)',
      'FAIL risk-map-coverage (1 problem)',
      'PASS agents-table',
      'FAIL protected-sync (2 problems)',
      'FAIL test-guard (1 problem)',
      'FAIL hidden-unicode (1 problem)',
    ]);
    expect(res.stderr).toContain('packages/extra/src/index.ts:1:20: U+200B ZERO WIDTH SPACE');
    expect(res.stderr).toContain('apps/api/AGENTS.md: no sibling CLAUDE.md');
  });

  it('requires the planning repository in a git checkout unless told otherwise', () => {
    const { root } = makeRepo({ SPEC_REF: 'cbd8f06fa7ab14631f1e7f4dd9106fda8bef749b\n' });
    expect(guard('spec-ref.ts', ['--cwd', root]).status).toBe(1);
    expect(guard('spec-ref.ts', ['--cwd', root, '--allow-missing-spec']).stdout).toMatch(
      /^SKIP spec-ref/,
    );
    expect(guard('banned-terms.ts', ['--spec', '--cwd', root]).status).toBe(1);
    expect(guard('banned-terms.ts', ['--spec', '--cwd', root, '--allow-missing-spec']).status).toBe(
      0,
    );
  });

  it('spec-ref and banned-terms --spec read the planning repository at SPEC_REF only', () => {
    const spec = makeRepo({
      '规划/02_系统架构.md': '数据访问 | 不要引入 Prisma 或第二种数据访问方式\n队列用 BullMQ\n',
      '规划/08_业务规则/README.md': '没有问题\n',
      'README.md': '参考文档里可以提 Prisma\n',
    });
    fixtureGit(spec.root, ['update-ref', 'refs/remotes/origin/main', spec.base]);
    // The working tree of the planning repository is never read.
    writeFiles(spec.root, { '规划/02_系统架构.md': '已清理\n' });
    const root = makeTree({ SPEC_REF: `${spec.base}\n` });
    const env = { COULI_SPEC_REPO: spec.root };
    expect(guard('spec-ref.ts', ['--cwd', root], { env }).stdout).toBe('PASS spec-ref\n');
    const res = guard('banned-terms.ts', ['--spec', '--cwd', root], { env });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('规划/02_系统架构.md:2: banned term "BullMQ"');
    expect(res.stderr).not.toContain('Prisma');
    expect(res.stdout).toBe('FAIL banned-terms (1 problem)\n');
  });

  it('banned-terms --file scans task briefs', () => {
    const dir = makeTree({
      'brief.md': '# 任务\n事件写 outbox 表\n',
      'clean.md': '# 任务\n同一事务入队\n',
    });
    expect(guard('banned-terms.ts', ['--file', join(dir, 'clean.md')]).status).toBe(0);
    const bad = guard('banned-terms.ts', ['--file', join(dir, 'clean.md'), join(dir, 'brief.md')]);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('brief.md:2: banned term "outbox"');
    expect(guard('banned-terms.ts', ['--file', join(dir, 'missing.md')]).status).toBe(1);
    expect(guard('banned-terms.ts', []).status).toBe(2);
    expect(guard('banned-terms.ts', ['--spec', '--file', 'x']).status).toBe(2);
  });

  it('approvals --require answers from ops/approvals.yaml of the trusted root', () => {
    expect(guard('approvals.ts', ['--require', '0']).status).toBe(0);
    expect(guard('approvals.ts', ['--require', '1']).status).toBe(1);
    expect(guard('approvals.ts', ['--require', '7']).status).toBe(1);
    expect(json(guard('approvals.ts', ['--require', '0', '--json']).stdout)).toMatchObject({
      id: 0,
      granted: true,
    });
    expect(guard('approvals.ts', ['--require', 'yes']).status).toBe(2);
    expect(guard('approvals.ts', []).status).toBe(2);
    const empty = makeTree();
    expect(
      guard('approvals.ts', ['--require', '0'], { env: { COULI_TRUSTED_ROOT: empty } }).status,
    ).toBe(1);
    const broken = makeTree({ 'ops/approvals.yaml': 'approvals: yes\n' });
    expect(
      guard('approvals.ts', ['--require', '0'], { env: { COULI_TRUSTED_ROOT: broken } }).status,
    ).toBe(2);
  });

  it('schema-lint checks explicit files and the schema directory', () => {
    const good = {
      type: 'object',
      additionalProperties: false,
      required: ['a'],
      properties: { a: { type: 'string' } },
    };
    const root = makeTree({
      'tools/agent/schemas/good.schema.json': JSON.stringify(good),
      'bad.json': JSON.stringify({ ...good, required: [] }),
    });
    expect(guard('schema-lint.ts', ['--cwd', root]).stdout).toBe('PASS schema-lint\n');
    const bad = guard('schema-lint.ts', [join(root, 'bad.json')]);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('property "a" is missing from "required"');
    const none = guard('schema-lint.ts', ['--cwd', makeTree()]);
    expect(none.status).toBe(0);
    expect(none.stderr).toContain('does not exist yet');
  });

  it('agents-table --write fills the markers and --check verifies them', () => {
    const root = makeTree({
      'AGENTS.md': `# AGENTS\n\n${TABLE_BEGIN}\n${TABLE_END}\n\n## next\n`,
      'ops/risk-map.yaml': readFileSync(join(repoRoot(), 'ops', 'risk-map.yaml'), 'utf8'),
    });
    expect(guard('agents-table.ts', ['--check', '--cwd', root]).status).toBe(1);
    expect(guard('agents-table.ts', ['--write', '--cwd', root]).status).toBe(0);
    expect(guard('agents-table.ts', ['--check', '--cwd', root]).status).toBe(0);
    const text = readFileSync(join(root, 'AGENTS.md'), 'utf8');
    expect(text).toContain('| `packages/money/**` | Claude | Codex | Claude + Codex | RV2 |');
    expect(text.endsWith(`${TABLE_END}\n\n## next\n`)).toBe(true);
    expect(guard('agents-table.ts', ['--cwd', root]).status).toBe(2);
    rmSync(join(root, 'AGENTS.md'));
    writeFileSync(join(root, 'AGENTS.md'), '# no markers\n');
    expect(guard('agents-table.ts', ['--write', '--cwd', root]).status).toBe(2);
    expect(guard('agents-table.ts', ['--check', '--cwd', root]).status).toBe(1);
  });

  it('the remaining single-purpose guards report through their own exit code', () => {
    // 故意不登记的示例模块，勿用真实模块名（payout 已登记，B2-05a；对账等模块以后也会登记）。
    const root = staticTree({
      'apps/api/src/modules/zz-unregistered-example/index.ts': 'export {};\n',
    });
    expect(guard('agents-pair.ts', ['--cwd', root]).stdout).toBe('PASS agents-pair\n');
    expect(guard('risk-map-coverage.ts', ['--cwd', root]).status).toBe(1);
    expect(guard('protected-sync.ts', ['--cwd', root]).status).toBe(0);
    expect(guard('hidden-unicode.ts', ['--cwd', root]).stdout).toBe('PASS hidden-unicode\n');
    expect(guard('hidden-unicode.ts', ['--cwd', root, 'extra']).status).toBe(2);
  });
});

describe('run.ts git --pr-number: owner approval (规划/11 §4.4, owner decision 2026-10-02)', () => {
  const FAKE_GITHUB = join(repoRoot(), 'tools', 'ci', 'testing', 'fake-github.ts');
  let routeCount = 0;

  /** A committed head that changes a class 2 file and modifies an add-only test asset. */
  function approvedChange(extra: Record<string, string> = {}): {
    root: string;
    base: string;
    head: string;
  } {
    const { root, base } = workRepo();
    writeFiles(root, {
      'turbo.json': '{ "x": 1 }\n',
      'test/spec/ledger/post.test.ts': "it('posts, rewritten', () => {});\n",
      ...extra,
    });
    fixtureGit(root, ['add', '-A']);
    fixtureGit(root, ['commit', '-q', '-m', 'test-change']);
    return { root, base, head: fixtureGit(root, ['rev-parse', 'HEAD']) };
  }

  /** run.ts git with fetch answered from canned routes for PR #7 of o/r (owner account `o`). */
  function guardWithPr(
    root: string,
    args: string[],
    pr: { head: string; labels: string[]; labeledBy?: string },
  ): { status: number | null; stdout: string; stderr: string } {
    const routes = {
      '/repos/o/r/pulls/7': {
        status: 200,
        body: { head: { sha: pr.head }, labels: pr.labels.map((name) => ({ name })) },
      },
      '/repos/o/r/issues/7/events?per_page=100&page=1': {
        status: 200,
        body: pr.labels.map((name) => ({
          event: 'labeled',
          label: { name },
          actor: { login: pr.labeledBy ?? 'o' },
        })),
      },
    };
    const file = join(root, '..', `routes-${process.pid}-${++routeCount}.json`);
    writeFileSync(file, JSON.stringify(routes));
    const res = spawnSync(
      process.execPath,
      ['--import', FAKE_GITHUB, join(GUARD_DIR, 'run.ts'), 'git', ...args, '--cwd', root],
      {
        cwd: trusted,
        encoding: 'utf8',
        env: {
          ...process.env,
          COULI_TRUSTED_ROOT: trusted,
          COULI_SPEC_REPO: '/nonexistent/planning-repo',
          COULI_FAKE_GITHUB: file,
          GITHUB_API_URL: 'https://api.github.invalid',
          GITHUB_REPOSITORY: 'o/r',
          GITHUB_REPOSITORY_OWNER: 'o',
          GH_TOKEN: 'not-a-real-token',
        },
      },
    );
    rmSync(file, { force: true });
    return { status: res.status, stdout: res.stdout, stderr: res.stderr };
  }

  const label = (sha: string): string => `owner-approved-${sha.slice(0, 12)}`;

  it('a valid label turns protected-path and add-only problems into warnings', () => {
    const { root, base, head } = approvedChange();
    const without = guard('run.ts', ['git', '--base', base, '--cwd', root]);
    expect(without.status).toBe(1);
    const res = guardWithPr(root, ['--base', base, '--pr-number', '7'], {
      head,
      labels: [label(head)],
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toBe(
      [
        'PASS ledger-overwrite',
        'PASS migration-sequence',
        'PASS protected-paths (2 warnings, owner-approved)',
        'PASS test-guard (1 warning, owner-approved)',
        'guard git: 4 passed, 0 failed, 0 skipped',
        '',
      ].join('\n'),
    );
    // Still printed, as warnings.
    expect(res.stderr).toContain('protected-paths: warning: turbo.json: class 2');
    expect(res.stderr).toContain(
      'protected-paths: warning: test/spec/ledger/post.test.ts: class 1',
    );
    expect(res.stderr).toContain(
      'test-guard: warning: test/spec/ledger/post.test.ts: [add-only] existing test asset',
    );
    expect(res.stderr).toContain(`label \`${label(head)}\` added by the owner account o`);
  });

  it('a label for an older head or added by another account changes nothing', () => {
    const { root, base, head } = approvedChange();
    const stale = guardWithPr(root, ['--base', base, '--pr-number', '7'], {
      head,
      labels: [label(base)],
    });
    expect(stale.status).toBe(1);
    expect(stale.stdout.split('\n').slice(2, 4)).toEqual([
      'FAIL protected-paths (2 problems)',
      'FAIL test-guard (1 problem)',
    ]);
    expect(stale.stderr).toContain(`does not carry the label \`${label(head)}\``);

    const byBot = guardWithPr(root, ['--base', base, '--pr-number', '7'], {
      head,
      labels: [label(head)],
      labeledBy: 'ci-bot',
    });
    expect(byBot.status).toBe(1);
    expect(byBot.stderr).toContain('was added by `ci-bot`, not by the owner account');

    // The PR moved on: the label for the new head does not approve the checked commit.
    const moved = guardWithPr(root, ['--base', base, '--pr-number', '7'], {
      head: 'e'.repeat(40),
      labels: [label('e'.repeat(40))],
    });
    expect(moved.status).toBe(1);
    expect(moved.stderr).toContain(`not the checked head ${head}`);
  });

  it('every other guard problem still fails with a valid label', () => {
    const { root, base, head } = approvedChange({
      'apps/api/src/modules/ledger/post.test.ts': fx.FOCUSED_TEST,
      'apps/api/src/modules/orders/sync.ts': 'export const sync = 2;\n',
    });
    const res = guardWithPr(root, ['--base', base, '--task', 'B2-02a', '--pr-number', '7'], {
      head,
      labels: [label(head)],
    });
    expect(res.status).toBe(1);
    expect(res.stdout.split('\n').slice(0, 6)).toEqual([
      'FAIL path-guard (3 problems)',
      'PASS ledger-overwrite',
      'PASS migration-sequence',
      'PASS protected-paths (2 warnings, owner-approved)',
      'FAIL test-guard (1 problem)',
      'guard git: 3 passed, 2 failed, 0 skipped',
    ]);
    expect(res.stderr).toContain('test-guard: warning: test/spec/ledger/post.test.ts: [add-only]');
    expect(res.stderr).toContain('apps/api/src/modules/ledger/post.test.ts:1: [no-skip-only]');
  });

  it('a valid label waives neither ledger-overwrite nor migration-sequence (CT-06q)', () => {
    const doneTask = NO_TESTER_TASK.replace('status: todo\npr: null', 'status: done\npr: 5');
    const { root, base } = makeRepo({
      'ops/tasks/N1-01.yaml': doneTask,
      'db/migrations/0001_init.sql': '-- Up Migration\nselect 1;\n',
      'turbo.json': '{}\n',
    });
    writeFiles(root, {
      'ops/tasks/N1-01.yaml': doneTask
        .replace('title: ledger：凭证与分录写入', 'title: 另一个任务')
        .replace('status: done\npr: 5', 'status: todo\npr: null'),
      'db/migrations/0001_again.sql': '-- Up Migration\nselect 2;\n',
      'turbo.json': '{ "x": 1 }\n',
    });
    fixtureGit(root, ['add', '-A']);
    fixtureGit(root, ['commit', '-q', '-m', 'overwrite and collide']);
    const head = fixtureGit(root, ['rev-parse', 'HEAD']);
    const res = guardWithPr(root, ['--base', base, '--pr-number', '7'], {
      head,
      labels: [label(head)],
    });
    expect(res.status).toBe(1);
    expect(res.stdout).toBe(
      [
        'FAIL ledger-overwrite (1 problem)',
        'FAIL migration-sequence (1 problem)',
        'PASS protected-paths (1 warning, owner-approved)',
        'PASS test-guard',
        'guard git: 2 passed, 2 failed, 0 skipped',
        '',
      ].join('\n'),
    );
    expect(res.stderr).toContain(
      'ledger-overwrite: ops/tasks/N1-01.yaml: N1-01 已存在且为 done，新任务请换编号（title 「ledger：凭证与分录写入」→「另一个任务」；status done → todo）',
    );
    expect(res.stderr).toContain(
      'migration-sequence: db/migrations/0001_again.sql: 0001 已被 0001_init.sql 占用，请改为 0002',
    );
  });

  it('an approval binds to a clean commit only, and the PR number is validated', () => {
    const { root, base, head } = approvedChange();
    writeFiles(root, { 'docs/notes.md': '# uncommitted\n' });
    const dirty = guardWithPr(root, ['--base', base, '--pr-number', '7'], {
      head,
      labels: [label(head)],
    });
    expect(dirty.status).toBe(1);
    expect(dirty.stderr).toContain('uncommitted changes');
    expect(guard('run.ts', ['git', '--base', base, '--cwd', root, '--pr-number', 'x']).status).toBe(
      2,
    );
  });
});

describe('run.ts git --task: the path guard starts at spec_commit (owner decision 2026-10-02)', () => {
  const SKELETON =
    "export function post(): number {\n  throw new Error('NotImplemented: post');\n}\n";

  function commitAll(root: string, message: string): string {
    fixtureGit(root, ['add', '-A']);
    fixtureGit(root, ['commit', '-q', '-m', message]);
    return fixtureGit(root, ['rev-parse', 'HEAD']);
  }

  /**
   * A task branch of B2-02a (paths apps/api/src/modules/ledger/**): rule-test commit(s), then
   * the implementation, then the evidence file naming `spec_commit` (default: the rule-test
   * commit). `author` overrides the rule-test author's files.
   */
  function taskBranch(
    opts: {
      author?: Record<string, string>;
      authorRemove?: string[];
      implementer?: Record<string, string>;
      evidence?: (spec: string) => unknown;
    } = {},
  ): { root: string; base: string; spec: string; head: string } {
    const { root, base } = workRepo();
    writeFiles(
      root,
      opts.author ?? {
        'test/spec/ledger/rule.test.ts': "it('[BR-FUND-13] rule', () => { expect(1).toBe(1); });\n",
        'test/properties/ledger/rule.prop.test.ts': "it('[BR-FUND-13] prop', () => {});\n",
        'apps/api/src/modules/ledger/post.ts': SKELETON,
        'ops/tasks/B2-02a.yaml': LEDGER_TASK.replace('status: todo', 'status: doing'),
      },
    );
    for (const path of opts.authorRemove ?? []) fixtureGit(root, ['rm', '-q', path]);
    const spec = commitAll(root, 'test(spec): rule tests and skeleton');
    writeFiles(
      root,
      opts.implementer ?? {
        'apps/api/src/modules/ledger/post.ts': 'export function post(): number {\n  return 2;\n}\n',
        'apps/api/src/modules/ledger/post.test.ts': "it('unit', () => { expect(2).toBe(2); });\n",
      },
    );
    const implemented = commitAll(root, 'feat(ledger): implement');
    const evidence = opts.evidence ? opts.evidence(spec) : { task: 'B2-02a', spec_commit: spec };
    if (evidence === undefined) return { root, base, spec, head: implemented };
    writeFiles(root, { 'ops/evidence/B2-02a.json': `${JSON.stringify(evidence, null, 2)}\n` });
    const head = commitAll(root, 'ops(evidence)');
    return { root, base, spec, head };
  }

  const runGit = (root: string, base: string) =>
    guard('run.ts', ['git', '--base', base, '--task', 'B2-02a', '--cwd', root]);

  it('a valid spec_commit: rule tests before it are the author’s, the rest the implementer’s', () => {
    const { root, base, spec } = taskBranch();
    const res = runGit(root, base);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toBe(
      [
        'PASS path-guard',
        'PASS path-guard-author',
        'PASS ledger-overwrite',
        'PASS migration-sequence',
        'PASS protected-paths',
        'PASS test-guard',
        'guard git: 6 passed, 0 failed, 0 skipped',
        '',
      ].join('\n'),
    );
    expect(res.stderr).toContain(
      `path-guard: notice: implementer scope starts at spec_commit ${spec.slice(0, 12)}`,
    );
    // The evidence file itself is an ops/ change of the implementer range: reported, not failing.
    expect(res.stderr).toContain('ops/evidence/B2-02a.json: out-of-scope change under ops/');
  });

  it('an abbreviated spec_commit is accepted once it resolves on the branch', () => {
    const { root, base } = taskBranch({
      evidence: (spec) => ({ task: 'B2-02a', spec_commit: spec.slice(0, 7) }),
    });
    expect(runGit(root, base).status).toBe(0);
  });

  it('missing evidence file: one range from the base, as before (rule tests fail)', () => {
    const { root, base } = taskBranch({ evidence: () => undefined });
    const res = runGit(root, base);
    expect(res.status).toBe(1);
    expect(res.stdout.split('\n')[0]).toBe('FAIL path-guard (2 problems)');
    expect(res.stdout).not.toContain('path-guard-author');
    expect(res.stderr).toContain(
      'path-guard: notice: implementer scope starts at the base: no ops/evidence/B2-02a.json at the head',
    );
    expect(res.stderr).toContain('test/spec/ledger/rule.test.ts: added outside the task paths');
  });

  it('a spec_commit that is not an ancestor of the head is not used', () => {
    const { root, base, head } = taskBranch({ evidence: () => undefined });
    // A commit on another branch, not reachable from the head.
    fixtureGit(root, ['switch', '-q', '-c', 'side', base]);
    writeFiles(root, { 'docs/side.md': '# side\n' });
    const side = commitAll(root, 'side');
    fixtureGit(root, ['switch', '-q', '--detach', head]);
    writeFiles(root, {
      'ops/evidence/B2-02a.json': JSON.stringify({ task: 'B2-02a', spec_commit: side }),
    });
    commitAll(root, 'ops(evidence) pointing elsewhere');
    const res = runGit(root, base);
    expect(res.status).toBe(1);
    expect(res.stdout.split('\n')[0]).toBe('FAIL path-guard (2 problems)');
    expect(res.stderr).toContain(`spec_commit ${side} is not an ancestor of the head`);
  });

  it('a spec_commit that is not a descendant of the base is not used', () => {
    const { root, base } = taskBranch({ evidence: () => undefined });
    // The base moved: the branch is rebased onto a newer main commit, but the evidence still
    // names the original base (an ancestor of the new base) as spec_commit.
    fixtureGit(root, ['switch', '-q', '-c', 'newmain', base]);
    writeFiles(root, { 'docs/notes.md': '# main moved\n' });
    const newBase = commitAll(root, 'main moved');
    fixtureGit(root, ['switch', '-q', '-c', 'task', 'main']);
    fixtureGit(root, ['rebase', '-q', newBase]);
    writeFiles(root, {
      'ops/evidence/B2-02a.json': JSON.stringify({ task: 'B2-02a', spec_commit: base }),
    });
    commitAll(root, 'ops(evidence) naming the old base');
    const res = runGit(root, newBase);
    expect(res.status).toBe(1);
    expect(res.stdout.split('\n')[0]).toBe('FAIL path-guard (2 problems)');
    expect(res.stderr).toContain(`is not a descendant of the base ${newBase}`);
  });

  it('an evidence file of another task or without a commit id is not used', () => {
    const other = taskBranch({ evidence: (spec) => ({ task: 'B2-03a', spec_commit: spec }) });
    const wrongTask = runGit(other.root, other.base);
    expect(wrongTask.status).toBe(1);
    expect(wrongTask.stderr).toContain('task is "B2-03a", not "B2-02a"');
    const bogus = taskBranch({ evidence: () => ({ task: 'B2-02a', spec_commit: 'HEAD~1' }) });
    const notId = runGit(bogus.root, bogus.base);
    expect(notId.status).toBe(1);
    expect(notId.stderr).toContain('spec_commit is not a commit id');
  });

  it('rule-test commits touching implementation or other paths fail path-guard-author', () => {
    const { root, base } = taskBranch({
      author: {
        'test/spec/ledger/rule.test.ts': "it('[BR-FUND-13] rule', () => { expect(1).toBe(1); });\n",
        // Implementation inside the task paths: no NotImplemented skeleton.
        'apps/api/src/modules/ledger/post.ts': 'export function post(): number {\n  return 2;\n}\n',
        // Another module, outside the task paths.
        'apps/api/src/modules/orders/sync.ts': 'export const sync = 2;\n',
      },
      implementer: { 'apps/api/src/modules/ledger/more.ts': 'export const more = 1;\n' },
    });
    const res = runGit(root, base);
    expect(res.status).toBe(1);
    expect(res.stdout.split('\n').slice(0, 2)).toEqual([
      'PASS path-guard',
      'FAIL path-guard-author (2 problems)',
    ]);
    expect(res.stderr).toContain(
      'path-guard-author: apps/api/src/modules/ledger/post.ts: implementation path changed in a ' +
        'rule-test commit (before spec_commit) but it is not a NotImplemented skeleton shell',
    );
    expect(res.stderr).toContain(
      'path-guard-author: apps/api/src/modules/orders/sync.ts: changed in a rule-test commit ' +
        "(before spec_commit) outside the rule-test author's paths",
    );
  });

  it('[CR3-02] B1-01s shape: a legacy ledger passes with constants in its skeleton; a new task does not', () => {
    const skeleton = [
      "export const DAY_PARTITIONED_TABLES: readonly string[] = Object.freeze(['link_logs']);",
      'const DAYS_AHEAD = 14;',
      "export function post(): never {\n  throw new Error('NotImplemented: post');\n}",
      '',
    ].join('\n');
    const branch = (task: string): { root: string; base: string } => {
      const { root, base } = workRepo();
      writeFiles(root, {
        'test/spec/ledger/rule.test.ts': "it('[BR-FUND-13] rule', () => { expect(1).toBe(1); });\n",
        'apps/api/src/modules/ledger/post.ts': skeleton,
      });
      const spec = commitAll(root, 'test(spec): rule tests and skeleton');
      writeFiles(root, {
        [`ops/evidence/${task}.json`]: `${JSON.stringify({ task, spec_commit: spec }, null, 2)}\n`,
      });
      commitAll(root, 'ops(evidence)');
      return { root, base };
    };
    // B2-02a is on the fixture's legacy list (no test_paths, old scope, old skeleton rule).
    const legacy = branch('B2-02a');
    const ok = guard('run.ts', [
      'git',
      '--base',
      legacy.base,
      '--task',
      'B2-02a',
      '--cwd',
      legacy.root,
    ]);
    expect(ok.stdout).toContain('PASS path-guard-author');
    // B2-02b is a new task (test_paths test/spec/ledger/**): the same skeleton is refused.
    const fresh = branch('B2-02b');
    const bad = guard('run.ts', [
      'git',
      '--base',
      fresh.base,
      '--task',
      'B2-02b',
      '--cwd',
      fresh.root,
    ]);
    expect(bad.status).toBe(1);
    expect(bad.stdout).toContain('FAIL path-guard-author');
    expect(bad.stderr).toContain('executable top-level code is not a skeleton');
  });

  it('[CR3-01] B1-02b shape: a legacy ledger without test_paths gets the old scope in red-check', () => {
    const { root, base } = workRepo();
    writeFiles(root, { 'test/spec/money/new.test.ts': "it('[BR-X] new', () => {});\n" });
    const res = guard('red-check.ts', [
      '--task',
      'B2-02a',
      '--cwd',
      root,
      '--base',
      base,
      '--print-expected',
    ]);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout.trim()).toBe('test/spec/money/new.test.ts');
    // A new task without test_paths has nothing in scope.
    expect(
      guard('red-check.ts', [
        '--task',
        'B2-02d',
        '--cwd',
        root,
        '--base',
        base,
        '--print-expected',
      ]).stdout.trim(),
    ).toBe('');
  });

  it('[CR2-02] a new task without test_paths gets no rule-test asset in its rule-test commits', () => {
    const { root, base } = workRepo();
    writeFiles(root, {
      'test/spec/money/other.test.ts': "it('[BR-X] other', () => { expect(1).toBe(1); });\n",
      'apps/api/src/modules/ledger/post.ts': SKELETON,
    });
    const spec = commitAll(root, 'test(spec): rule tests and skeleton');
    writeFiles(root, {
      'ops/evidence/B2-02d.json': `${JSON.stringify({ task: 'B2-02d', spec_commit: spec }, null, 2)}\n`,
    });
    commitAll(root, 'ops(evidence)');
    const res = guard('run.ts', ['git', '--base', base, '--task', 'B2-02d', '--cwd', root]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain(
      'task B2-02d has no test_paths and is not a ledger of the switch baseline',
    );
    expect(res.stderr).toContain('test/spec/money/other.test.ts: changed in a rule-test commit');
  });

  it('a rule-test commit may not remove implementation files', () => {
    const { root, base } = taskBranch({
      author: { 'test/spec/ledger/rule.test.ts': "it('[BR-FUND-13] rule', () => {});\n" },
      authorRemove: ['apps/api/src/modules/ledger/post.ts'],
    });
    const res = runGit(root, base);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain(
      'path-guard-author: apps/api/src/modules/ledger/post.ts: removed in a rule-test commit',
    );
  });

  it('rule tests added after spec_commit are still implementer overreach', () => {
    const { root, base } = taskBranch({
      implementer: {
        'apps/api/src/modules/ledger/post.ts': 'export function post(): number {\n  return 2;\n}\n',
        'test/spec/ledger/late.test.ts': "it('[BR-FUND-13] late', () => {});\n",
      },
    });
    const res = runGit(root, base);
    expect(res.status).toBe(1);
    expect(res.stdout.split('\n').slice(0, 2)).toEqual([
      'FAIL path-guard (1 problem)',
      'PASS path-guard-author',
    ]);
    expect(res.stderr).toContain('test/spec/ledger/late.test.ts: added outside the task paths');
  });
});

describe('run.ts git --task: a ledger the pull request adds (owner decision 2026-10-02)', () => {
  const NEW_TASK = LEDGER_TASK.replace('id: B2-02a', 'id: CT-09')
    .replace('type: impl', 'type: contract')
    .replace('  - "apps/api/src/modules/ledger/**"', '  - "contracts/**"');

  function commitAll(root: string, message: string): string {
    fixtureGit(root, ['add', '-A']);
    fixtureGit(root, ['commit', '-q', '-m', message]);
    return fixtureGit(root, ['rev-parse', 'HEAD']);
  }

  const runGit = (root: string, base: string, id: string) =>
    guard('run.ts', ['git', '--base', base, '--task', id, '--cwd', root]);

  it('no ledger in the trusted root: the one the PR adds is read from HEAD', () => {
    const { root, base } = workRepo();
    writeFiles(root, {
      'ops/tasks/CT-09.yaml': NEW_TASK,
      'contracts/enums/x.yaml': 'x: 1\n',
    });
    commitAll(root, 'task CT-09');
    const res = runGit(root, base, 'CT-09');
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout.split('\n')[0]).toBe('PASS path-guard');
    expect(res.stderr).toContain(
      'path-guard: notice: task CT-09: no ops/tasks/CT-09.yaml on the base; the ledger is the one this pull request adds',
    );
  });

  it('the head ledger still bounds the paths', () => {
    const { root, base } = workRepo();
    writeFiles(root, {
      'ops/tasks/CT-09.yaml': NEW_TASK,
      'apps/api/src/modules/orders/sync.ts': 'export const sync = 2;\n',
    });
    commitAll(root, 'task CT-09 overreach');
    const res = runGit(root, base, 'CT-09');
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('apps/api/src/modules/orders/sync.ts');
  });

  it('a ledger only in the working tree, or nowhere, is not used', () => {
    const { root, base } = workRepo();
    expect(runGit(root, base, 'CT-09').status).toBe(2);
    writeFiles(root, { 'ops/tasks/CT-09.yaml': NEW_TASK });
    const res = runGit(root, base, 'CT-09');
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('HEAD does not add ops/tasks/CT-09.yaml');
  });

  it('a ledger already on the base is never read from the head', () => {
    const { root } = workRepo();
    writeFiles(root, { 'ops/tasks/CT-09.yaml': NEW_TASK });
    const base = commitAll(root, 'ledger on base');
    writeFiles(root, { 'contracts/enums/x.yaml': 'x: 1\n' });
    commitAll(root, 'work');
    const res = runGit(root, base, 'CT-09');
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('the trusted copy is stale');
  });

  it('a trusted ledger wins over a widened copy at the head', () => {
    const { root, base } = workRepo();
    writeFiles(root, {
      'ops/tasks/B2-02a.yaml': LEDGER_TASK.replace(
        '  - "apps/api/src/modules/ledger/**"',
        '  - "apps/api/src/modules/ledger/**"\n  - "apps/api/src/modules/orders/**"',
      ),
      'apps/api/src/modules/orders/sync.ts': 'export const sync = 2;\n',
    });
    commitAll(root, 'widen');
    const res = runGit(root, base, 'B2-02a');
    expect(res.status).toBe(1);
    expect(res.stderr).not.toContain('the ledger is the one this pull request adds');
    expect(res.stderr).toContain('apps/api/src/modules/orders/sync.ts');
  });
});

describe('run.ts git --task: mechanical contract commits of a Codex implementation (ops/approvals.yaml id 31)', () => {
  const OPENAPI = [
    'paths:',
    '  /v1/a:',
    '    get:',
    '      operationId: getA',
    '      x-implementation: planned',
    '      responses: {}',
    '  /v1/b:',
    '    get:',
    '      operationId: getB',
    '      x-implementation: planned',
    '      responses: {}',
    '',
  ].join('\n');
  const MARK =
    '\n\nCouli-Mechanical: contract-codegen\nCo-Authored-By: Claude <noreply@anthropic.com>';

  function commitAll(root: string, message: string): string {
    fixtureGit(root, ['add', '-A']);
    fixtureGit(root, ['commit', '-q', '-m', message]);
    return fixtureGit(root, ['rev-parse', 'HEAD']);
  }

  /**
   * Base → rule tests (spec_commit) → the Codex implementation → `mechanical` (Claude's commit,
   * marked unless `unmarked`) → evidence.
   */
  function branch(opts: {
    implementer?: Record<string, string>;
    mechanical?: Record<string, string>;
    message?: string;
  }): { root: string; base: string } {
    const { root, base } = makeRepo({
      'contracts/openapi.yaml': OPENAPI,
      'apps/api/src/route-schemas.gen.ts': 'export const S = {};\n',
      'packages/contracts-ts/src/openapi.gen.ts': 'export type P = {};\n',
      'apps/api/src/modules/content/a.ts': 'export const a = 1;\n',
    });
    writeFiles(root, { 'test/spec/content/a.test.ts': "it('[F1-02e] a', () => {});\n" });
    const spec = commitAll(root, 'test(spec): F1-02e rule tests');
    writeFiles(
      root,
      opts.implementer ?? { 'apps/api/src/modules/content/a.ts': 'export const a = 2;\n' },
    );
    commitAll(root, 'F1-02e: implementation by Codex');
    if (opts.mechanical) {
      writeFiles(root, opts.mechanical);
      commitAll(root, opts.message ?? `chore(contracts): F1-02e leaves planned${MARK}`);
    }
    writeFiles(root, {
      'ops/evidence/F1-02e.json': JSON.stringify({ task: 'F1-02e', spec_commit: spec }),
    });
    commitAll(root, 'chore(ops): F1-02e evidence');
    return { root, base };
  }
  const run = (root: string, base: string) =>
    guard('run.ts', ['git', '--base', base, '--task', 'F1-02e', '--cwd', root]);
  const leavePlanned = {
    'contracts/openapi.yaml': OPENAPI.replace('      x-implementation: planned\n', ''),
    'apps/api/src/route-schemas.gen.ts': 'export const S = { getA: {} };\n',
  };

  it('a marked commit that only removes planned and regenerates passes; the rest stays in paths', () => {
    const { root, base } = branch({ mechanical: leavePlanned });
    const res = run(root, base);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout.split('\n')[0]).toBe('PASS path-guard');
    expect(res.stderr).toContain('1 commit(s) marked Couli-Mechanical: contract-codegen');
  });

  it('a Codex (unmarked) commit that touches the contract is refused', () => {
    const { root, base } = branch({
      implementer: {
        'apps/api/src/modules/content/a.ts': 'export const a = 2;\n',
        'contracts/openapi.yaml': OPENAPI.replace('      x-implementation: planned\n', ''),
      },
    });
    const res = run(root, base);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('contracts/openapi.yaml: modified outside the task paths');
  });

  it('a Codex commit touching the contract is refused even when a marked commit exists', () => {
    const { root, base } = branch({
      implementer: {
        'apps/api/src/modules/content/a.ts': 'export const a = 2;\n',
        'contracts/openapi.yaml': OPENAPI.replace('operationId: getB', 'operationId: getBB'),
      },
      mechanical: {
        'contracts/openapi.yaml': OPENAPI.replace(
          'operationId: getB',
          'operationId: getBB',
        ).replace('      x-implementation: planned\n', ''),
      },
    });
    const res = run(root, base);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('contracts/openapi.yaml: modified outside the task paths');
  });

  it('a marked commit that removes one more line than planned is refused', () => {
    const { root, base } = branch({
      mechanical: {
        'contracts/openapi.yaml': OPENAPI.replace(
          '      x-implementation: planned\n      responses: {}\n',
          '',
        ),
      },
    });
    const res = run(root, base);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(
      /contracts\/openapi\.yaml: line 6 .*only "x-implementation: planned" lines may be removed/,
    );
  });

  it('a marked commit that edits code or a path outside mechanical_paths is refused', () => {
    const { root, base } = branch({
      mechanical: {
        ...leavePlanned,
        'apps/api/src/modules/content/a.ts': 'export const a = 3;\n',
        'packages/contracts-ts/src/openapi.gen.ts': 'export type P = { a: 1 };\n',
      },
    });
    const res = run(root, base);
    expect(res.status).toBe(1);
    // Code is not a mechanical path; the generated client is in the trusted list but not in the ledger.
    expect(res.stderr).toContain('apps/api/src/modules/content/a.ts: outside the mechanical_paths');
    expect(res.stderr).toContain(
      'packages/contracts-ts/src/openapi.gen.ts: outside the mechanical_paths',
    );
  });

  it('a wrong trailer value is refused; without the trailer the commit is held to paths', () => {
    const wrong = branch({
      mechanical: leavePlanned,
      message: 'chore(contracts): leaves planned\n\nCouli-Mechanical: anything',
    });
    const wrongRes = run(wrong.root, wrong.base);
    expect(wrongRes.status).toBe(1);
    expect(wrongRes.stderr).toContain('Couli-Mechanical must be exactly "contract-codegen"');
    const plain = branch({ mechanical: leavePlanned, message: 'chore(contracts): leaves planned' });
    const plainRes = run(plain.root, plain.base);
    expect(plainRes.status).toBe(1);
    expect(plainRes.stderr).toContain('contracts/openapi.yaml: modified outside the task paths');
  });

  it('a ledger without mechanical_paths gets no mechanical commit', () => {
    const { root, base } = branch({ mechanical: { 'apps/api/src/modules/content/b.ts': '' } });
    const res = guard('run.ts', ['git', '--base', base, '--task', 'B2-02a', '--cwd', root]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('the task ledger names no mechanical_paths');
  });

  it("post-run's path-guard.ts keeps the task paths only (a marked commit does not widen it)", () => {
    const { root, base } = branch({ mechanical: leavePlanned });
    const res = guard('path-guard.ts', ['--task', 'F1-02e', '--base', base, '--cwd', root]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('contracts/openapi.yaml: modified outside the task paths');
  });
});

describe('run.ts git: ledger-overwrite and migration-sequence (CT-06q, 2026-10-18)', () => {
  const UP = '-- Up Migration\n';
  const TODO_TASK = NO_TESTER_TASK; // id N1-01, status todo, pr null
  const DONE_TASK = NO_TESTER_TASK.replace('status: todo\npr: null', 'status: done\npr: 5');
  /** The overwrite of #778: the same id, another title, type and status. */
  const OVERWRITE = DONE_TASK.replace('title: ledger：凭证与分录写入', 'title: 后台首页配置页')
    .replace('type: impl', 'type: contract')
    .replace('status: done\npr: 5', 'status: todo\npr: null');

  function repo(extra: Record<string, string> = {}): { root: string; base: string } {
    return makeRepo({
      'ops/tasks/N1-01.yaml': DONE_TASK,
      'ops/tasks/B2-02a.yaml': LEDGER_TASK, // todo
      'db/migrations/0001_init.sql': `${UP}select 1;\n`,
      'db/migrations/0002_second.sql': `${UP}select 2;\n`,
      'db/migrations/README.md': 'not a migration\n',
      'docs/notes.md': '# notes\n',
      ...extra,
    });
  }

  function commitAll(root: string, message: string): string {
    fixtureGit(root, ['add', '-A']);
    fixtureGit(root, ['commit', '-q', '-m', message]);
    return fixtureGit(root, ['rev-parse', 'HEAD']);
  }

  const runGit = (root: string, base: string, ...args: string[]) =>
    guard('run.ts', ['git', '--base', base, '--cwd', root, ...args]);
  const lines = (stdout: string, n: number) => stdout.split('\n').slice(0, n);

  it('an untouched base passes both with their notices', () => {
    const { root, base } = repo();
    writeFiles(root, { 'docs/notes.md': '# changed\n' });
    const res = runGit(root, base);
    expect(res.status, res.stderr).toBe(0);
    expect(lines(res.stdout, 2)).toEqual(['PASS ledger-overwrite', 'PASS migration-sequence']);
    expect(res.stderr).toContain('ledger-overwrite: notice: 0 task file(s) changed since');
    expect(res.stderr).toContain('migration-sequence: notice: no migration added (base max 0002)');
  });

  it('overwriting a done task file with another task fails, label or not; a new id passes', () => {
    const { root, base } = repo();
    writeFiles(root, { 'ops/tasks/N1-01.yaml': OVERWRITE });
    const res = runGit(root, base);
    expect(res.status).toBe(1);
    expect(lines(res.stdout, 1)).toEqual(['FAIL ledger-overwrite (1 problem)']);
    expect(res.stderr).toContain(
      'ledger-overwrite: ops/tasks/N1-01.yaml: N1-01 已存在且为 done，新任务请换编号（type 「impl」→「contract」；title 「ledger：凭证与分录写入」→「后台首页配置页」；status done → todo）',
    );
    // The same task under a new id, next to the untouched done one: fine (an added file).
    const { root: ok, base: okBase } = repo();
    writeFiles(ok, { 'ops/tasks/N1-02.yaml': OVERWRITE.replace('id: N1-01', 'id: N1-02') });
    expect(runGit(ok, okBase).status).toBe(0);
    // Also with --task (a task branch), the check runs the same way.
    const withTask = runGit(root, base, '--task', 'B2-02a');
    expect(withTask.status).toBe(1);
    expect(lines(withTask.stdout, 2)).toEqual([
      'PASS path-guard',
      'FAIL ledger-overwrite (1 problem)',
    ]);
  });

  it('moving a task forward is allowed: status done, pr, paths, deps; a revert is not', () => {
    const { root, base } = repo();
    writeFiles(root, {
      'ops/tasks/B2-02a.yaml': LEDGER_TASK.replace('status: todo\npr: null', 'status: done\npr: 9')
        .replace('deps: []', 'deps: [N1-01]')
        .replace(
          '  - "apps/api/src/modules/ledger/**"',
          '  - "apps/api/src/modules/ledger/**"\n  - "docs/ledger.md"',
        ),
      'ops/tasks/N1-01.yaml': `${DONE_TASK}# 2026-10-18 补注：评审见 #5。\n`,
    });
    const ok = runGit(root, base);
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stderr).toContain('ledger-overwrite: notice: 2 task file(s) changed since');
    writeFiles(root, { 'ops/tasks/N1-01.yaml': TODO_TASK });
    const reverted = runGit(root, base);
    expect(reverted.status).toBe(1);
    expect(reverted.stderr).toContain(
      'ledger-overwrite: ops/tasks/N1-01.yaml: N1-01 已存在且为 done，新任务请换编号（status done → todo）',
    );
  });

  it('a todo task keeps its title and type; deleting or renaming a task file fails', () => {
    const { root, base } = repo();
    writeFiles(root, {
      'ops/tasks/B2-02a.yaml': LEDGER_TASK.replace('type: impl', 'type: contract'),
    });
    const retyped = runGit(root, base);
    expect(retyped.status).toBe(1);
    expect(retyped.stderr).toContain(
      'ledger-overwrite: ops/tasks/B2-02a.yaml: B2-02a 已存在（status todo），不得改 id / type / title',
    );
    writeFiles(root, { 'ops/tasks/B2-02a.yaml': LEDGER_TASK });
    rmSync(join(root, 'ops/tasks/N1-01.yaml'));
    const deleted = runGit(root, base);
    expect(deleted.status).toBe(1);
    expect(deleted.stderr).toContain(
      'ledger-overwrite: ops/tasks/N1-01.yaml: N1-01 已存在，台账文件不得删除',
    );
    // Deleted and re-added (staged) under a new id with the same content: git sees a rename.
    writeFiles(root, { 'ops/tasks/N1-03.yaml': DONE_TASK.replace('id: N1-01', 'id: N1-03') });
    fixtureGit(root, ['add', '-A']);
    const renamed = runGit(root, base);
    expect(renamed.status).toBe(1);
    expect(renamed.stderr).toContain(
      'ledger-overwrite: ops/tasks/N1-01.yaml: N1-01 已存在，台账文件不得改名或移动（改成了 ops/tasks/N1-03.yaml）',
    );
  });

  it('a branch behind the base is held to the fork point, not to what the base changed since', () => {
    const { root, base: fork } = repo({ 'ops/tasks/N1-01.yaml': TODO_TASK });
    // The branch: a docs change only, committed.
    writeFiles(root, { 'docs/notes.md': '# branch\n' });
    const head = commitAll(root, 'branch');
    // The base moved on: N1-01 done there (a landing of another PR).
    fixtureGit(root, ['checkout', '-q', '-b', 'base', fork]);
    writeFiles(root, {
      'ops/tasks/N1-01.yaml': DONE_TASK,
      'db/migrations/0003_third.sql': `${UP}select 3;\n`,
    });
    const tip = commitAll(root, 'base moves');
    fixtureGit(root, ['checkout', '-q', 'main']);
    expect(fixtureGit(root, ['rev-parse', 'HEAD'])).toBe(head);
    // (protected-paths and test-guard see the base's new migration as deleted: --base is the
    // fork point for them, as before; only the two checks of this block are read here.)
    const res = runGit(root, tip);
    expect(lines(res.stdout, 2)).toEqual(['PASS ledger-overwrite', 'PASS migration-sequence']);
    expect(res.stderr).toContain(
      `ledger-overwrite: notice: the branch forked from ${fork.slice(0, 12)}, behind ${tip.slice(0, 12)}: compared with the fork point`,
    );
    expect(res.stderr).toContain('ledger-overwrite: notice: 0 task file(s) changed since');
    // The migration the base gained meanwhile is not the branch's either, but it does count as
    // taken: a 0003 of the branch now collides, and its next number is 0004.
    expect(res.stderr).toContain('migration-sequence: notice: no migration added (base max 0003)');
    writeFiles(root, { 'db/migrations/0003_mine.sql': `${UP}select 33;\n` });
    const collided = runGit(root, tip);
    expect(collided.status).toBe(1);
    expect(collided.stderr).toContain(
      'migration-sequence: db/migrations/0003_mine.sql: 0003 已被 0003_third.sql 占用，请改为 0004',
    );
    // What the branch itself did to a task file is still judged (against the fork point).
    rmSync(join(root, 'db/migrations/0003_mine.sql'));
    writeFiles(root, { 'ops/tasks/N1-01.yaml': TODO_TASK.replace('type: impl', 'type: sync') });
    const own = runGit(root, tip);
    expect(own.status).toBe(1);
    expect(own.stderr).toContain(
      'ledger-overwrite: ops/tasks/N1-01.yaml: N1-01 已存在（status todo），不得改 id / type / title',
    );
  });

  it('migrations: the next number passes, a taken number, a gap and a repeat fail (untracked files count)', () => {
    const { root, base } = repo();
    writeFiles(root, { 'db/migrations/0003_next.sql': `${UP}select 3;\n` });
    const next = runGit(root, base);
    expect(next.status, next.stderr).toBe(0);
    expect(next.stderr).toContain(
      'migration-sequence: notice: 1 migration(s) added after base max 0002: 0003_next.sql',
    );
    writeFiles(root, { 'db/migrations/0004_more.sql': `${UP}select 4;\n` });
    expect(runGit(root, base).status).toBe(0);
    rmSync(join(root, 'db/migrations/0004_more.sql'));
    writeFiles(root, { 'db/migrations/0005_gap.sql': `${UP}select 5;\n` });
    const gap = runGit(root, base);
    expect(gap.status).toBe(1);
    expect(gap.stderr).toContain(
      'migration-sequence: db/migrations/0005_gap.sql: 迁移号 0005 与 base 主干最大号 0002 不连号（本 PR 新增的迁移须依次为 0003…），请改为 0004',
    );
    rmSync(join(root, 'db/migrations/0005_gap.sql'));
    writeFiles(root, { 'db/migrations/0003_twice.sql': `${UP}select 3;\n` });
    const twice = runGit(root, base);
    expect(twice.status).toBe(1);
    expect(twice.stderr).toContain(
      'migration-sequence: db/migrations/0003_twice.sql: 0003 已被 0003_next.sql（本 PR 新增） 占用，请改为 0004',
    );
    rmSync(join(root, 'db/migrations/0003_twice.sql'));
    rmSync(join(root, 'db/migrations/0003_next.sql'));
    writeFiles(root, { 'db/migrations/0002_again.sql': `${UP}select 2;\n` });
    const taken = runGit(root, base);
    expect(taken.status).toBe(1);
    expect(lines(taken.stdout, 2)).toEqual([
      'PASS ledger-overwrite',
      'FAIL migration-sequence (1 problem)',
    ]);
    expect(taken.stderr).toContain(
      'migration-sequence: db/migrations/0002_again.sql: 0002 已被 0002_second.sql 占用，请改为 0003',
    );
  });

  it('the rename hotfix (ops/approvals.yaml id 32) passes; a malformed new name or a file in a subdirectory is judged by name only', () => {
    const { root, base } = repo({ 'db/migrations/0002_other.sql': `${UP}select 22;\n` });
    fixtureGit(root, ['mv', 'db/migrations/0002_other.sql', 'db/migrations/0003_other.sql']);
    // (protected-paths still reports the rename of a class 1 file: the hotfix needs the label.)
    const fixed = runGit(root, base);
    expect(lines(fixed.stdout, 2)).toEqual(['PASS ledger-overwrite', 'PASS migration-sequence']);
    expect(fixed.stderr).toContain(
      'migration-sequence: notice: 1 migration(s) added after base max 0002: 0003_other.sql',
    );
    writeFiles(root, { 'db/migrations/0004_Bad.sql': `${UP}select 4;\n` });
    const bad = runGit(root, base);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain(
      'migration-sequence: db/migrations/0004_Bad.sql: 新增的迁移文件名不是 NNNN_kebab-name.sql',
    );
    rmSync(join(root, 'db/migrations/0004_Bad.sql'));
    // Not directly under db/migrations: not a migration of this check (protected-paths and the
    // migration gate have their say).
    writeFiles(root, { 'db/migrations/sub/0002_x.sql': `${UP}select 0;\n` });
    expect(lines(runGit(root, base).stdout, 2)).toEqual([
      'PASS ledger-overwrite',
      'PASS migration-sequence',
    ]);
  });

  it('a symbolic link in db/migrations is refused, named, whatever it points to (Codex r1, S2)', () => {
    const { root, base } = repo();
    symlinkSync('0002_second.sql', join(root, 'db/migrations/0002_again.sql'));
    const res = runGit(root, base);
    expect(res.status).toBe(1);
    expect(lines(res.stdout, 2)).toEqual([
      'PASS ledger-overwrite',
      'FAIL migration-sequence (1 problem)',
    ]);
    expect(res.stderr).toContain(
      'migration-sequence: db/migrations/0002_again.sql: 不是普通文件（符号链接），迁移只能是普通文件',
    );
    // Staged, the link is still not a migration file.
    fixtureGit(root, ['add', '-A']);
    expect(runGit(root, base).stderr).toContain(
      'db/migrations/0002_again.sql: 不是普通文件（符号链接）',
    );
  });

  it('a base that is not a commit fails both checks as internal errors', () => {
    const { root } = repo();
    const res = runGit(root, 'no-such-ref');
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('ledger-overwrite: internal error:');
    expect(res.stderr).toContain('migration-sequence: cannot list db/migrations at no-such-ref');
  });
});
