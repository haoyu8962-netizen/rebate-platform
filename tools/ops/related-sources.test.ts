// CT-06zzzzv (FU-RED-RUNS-TEST-GUARD, D10-1292 step 1): the changed files of a branch → the source
// files that verify-container.sh --related hands to `vitest related`.
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { classifySources, relatedSources } from './related-sources.ts';
import {
  CLI_TIMEOUT,
  fixtureGit,
  removeDir,
  runCli,
  scratchDir,
  writeFiles,
} from './test-helpers.ts';

const KEPT = [
  'apps/api/src/modules/content/domain/config-registry.ts',
  'db/seeds/0001_config-defaults.sql',
  'db/migrations/0136_x.sql',
  'packages/money/src/a.ts',
];

const DROPPED = [
  'test/spec/x/y.test.ts',
  'apps/api/src/a.test.ts',
  'apps/api/src/a.int.test.ts',
  'apps/h5/src/A.test.tsx',
  'ops/tasks/X.yaml',
  'docs/a.md',
  'README.md',
];

it('[CT-06zzzzv] relatedSources keeps the source files (TS and non-TS alike)', () => {
  expect(relatedSources(KEPT)).toEqual([...KEPT].sort());
});

it('[CT-06zzzzv] relatedSources drops test files, test/**, ops/**, docs/** and *.md', () => {
  for (const file of DROPPED) expect(relatedSources([file]), file).toEqual([]);
  expect(relatedSources(DROPPED)).toEqual([]);
  expect(relatedSources([])).toEqual([]);
});

it('[CT-06zzzzv] relatedSources: the prefixes are whole leading directories, *.md anywhere', () => {
  // ops/ and test/ deeper in a path are ordinary directories; *.md is dropped at any depth.
  expect(
    relatedSources([
      'tools/ops/verify-container.sh',
      'packages/testing/src/a.ts',
      'packages/money/README.md',
      'apps/api/src/modules/content/AGENTS.md',
    ]),
  ).toEqual(['packages/testing/src/a.ts', 'tools/ops/verify-container.sh']);
});

it('[CT-06zzzzv] relatedSources sorts and removes duplicates, leaving its input untouched', () => {
  const input = [...DROPPED, ...KEPT].reverse();
  const before = [...input];
  const out = relatedSources([...input, ...KEPT, KEPT[0] ?? '']);
  expect(out).toEqual([...KEPT].sort());
  expect(new Set(out).size).toBe(out.length);
  expect(input).toEqual(before);
});

// --- CLI ------------------------------------------------------------------------------------------

let dir = '';
let repo = '';

beforeAll(() => {
  dir = scratchDir('related-sources');
  repo = `${dir}/repo`;
  writeFiles(repo, {
    'package.json': '{"name":"fixture","private":true}\n',
    'apps/api/src/modules/content/domain/config-registry.ts': 'export const keys = [];\n',
    'packages/money/src/a.ts': 'export const a = 1;\n',
    'packages/money/src/b.ts': 'export const b = 1;\n',
  });
  fixtureGit(repo, ['init', '-q', '-b', 'main']);
  fixtureGit(repo, ['add', '-A']);
  fixtureGit(repo, ['commit', '-q', '-m', 'base']);
  fixtureGit(repo, ['checkout', '-q', '-b', 'task']);
  writeFiles(repo, {
    'apps/api/src/modules/content/domain/config-registry.ts': "export const keys = ['x'];\n",
    'db/seeds/0001_config-defaults.sql': 'select 1;\n',
    'packages/money/src/名字.ts': 'export const n = 1;\n',
    'test/spec/x/y.test.ts': 'export {};\n',
    'apps/api/src/a.test.ts': 'export {};\n',
    'docs/a.md': '# a\n',
    'ops/tasks/X.yaml': 'id: X\n',
  });
  fixtureGit(repo, ['add', '-A']);
  fixtureGit(repo, ['commit', '-q', '-m', 'task']);
  // A later commit on main: not part of the branch (<ref>...HEAD diffs from the merge base).
  fixtureGit(repo, ['checkout', '-q', 'main']);
  writeFiles(repo, { 'packages/money/src/b.ts': 'export const b = 2;\n' });
  fixtureGit(repo, ['commit', '-q', '-am', 'main moves on']);
  fixtureGit(repo, ['checkout', '-q', 'task']);
});
afterAll(() => removeDir(dir));

function lines(text: string): string[] {
  return text.split('\n').filter((l) => l !== '');
}

it(
  '[CT-06zzzzv] related-sources CLI prints the source files changed since the merge base, one per line',
  () => {
    const res = runCli('related-sources.ts', ['--base', 'main', '--cwd', repo]);
    expect(res.status, res.stderr).toBe(0);
    // Sorted, unquoted (git -z: a non-ASCII name comes out as it is), without the tests, docs/,
    // ops/ and without main's later change to b.ts.
    expect(lines(res.stdout)).toEqual([
      'apps/api/src/modules/content/domain/config-registry.ts',
      'db/seeds/0001_config-defaults.sql',
      'packages/money/src/名字.ts',
    ]);
    // Read-only: the fixture's work tree and branch are as they were.
    expect(fixtureGit(repo, ['status', '--porcelain'])).toBe('');
    expect(fixtureGit(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('task');
  },
  CLI_TIMEOUT,
);

it(
  '[CT-06zzzzv] related-sources CLI prints nothing when the branch changed no source file',
  () => {
    const head = fixtureGit(repo, ['rev-parse', 'HEAD']);
    const res = runCli('related-sources.ts', ['--base', head, '--cwd', repo]);
    expect(res.status, res.stderr).toBe(0);
    expect(lines(res.stdout)).toEqual([]);
  },
  CLI_TIMEOUT,
);

it(
  '[CT-06zzzzv] related-sources CLI exits 2 when git fails (unknown base, not a repository)',
  () => {
    const bad = runCli('related-sources.ts', ['--base', 'no-such-ref', '--cwd', repo]);
    expect(bad.status).toBe(2);
    expect(bad.stdout).toBe('');
    const plain = `${dir}/plain`;
    writeFiles(plain, { 'a.ts': 'export {};\n' });
    // GIT_CEILING_DIRECTORIES: git must not find the repository that holds .tmp/.
    const notRepo = runCli('related-sources.ts', ['--base', 'main', '--cwd', plain], {
      GIT_CEILING_DIRECTORIES: dir,
    });
    expect(notRepo.status).toBe(2);
    expect(notRepo.stdout).toBe('');
  },
  CLI_TIMEOUT,
);

// --- CT-06zzzzv round 2 (D10-1337 ⑥): what vitest related cannot see, recorded beside the sources --
// classifySources takes the `git diff --name-status -z -M` entries (the shape of tools/lib/git.ts
// Change: status A / M / D / R, R with oldPath) and gives, among the source files only (the
// relatedSources filter), the data files nothing imports, the deleted files and the old paths of
// renames, and whether a file that makes Vitest run everything changed.

type Entry = { status: string; path: string; oldPath?: string };

const ENTRIES: Entry[] = [
  { status: 'M', path: 'apps/api/src/modules/content/domain/config-registry.ts' },
  { status: 'M', path: 'db/seeds/0001_config-defaults.sql' },
  { status: 'A', path: 'contracts/events/order.yaml' },
  { status: 'M', path: 'specs/commission-examples.csv' },
  { status: 'A', path: 'apps/h5/src/Page.tsx' },
  { status: 'A', path: 'packages/a/src/x.mts' },
  { status: 'A', path: 'packages/a/src/x.cts' },
  { status: 'A', path: 'packages/a/src/x.js' },
  { status: 'A', path: 'packages/a/src/x.mjs' },
  { status: 'A', path: 'packages/a/src/x.cjs' },
  { status: 'A', path: 'packages/a/src/x.jsx' },
  { status: 'D', path: 'packages/money/src/old.ts' },
  {
    status: 'R',
    path: 'packages/money/src/renamed.ts',
    oldPath: 'packages/money/src/before.ts',
  },
  // Not source files: never listed.
  { status: 'D', path: 'apps/api/src/gone.test.ts' },
  { status: 'M', path: 'ops/tasks/X.yaml' },
  { status: 'A', path: 'docs/a.md' },
  { status: 'M', path: 'test/spec/fixtures/a.sql' },
];

function sorted(list: readonly string[] | undefined): string[] {
  return [...(list ?? [])].sort();
}

it('[CT-06zzzzv] classifySources: data_sources are the source files with an extension Vitest cannot import', () => {
  const out = classifySources(ENTRIES);
  expect(sorted(out.data_sources)).toEqual([
    'contracts/events/order.yaml',
    'db/seeds/0001_config-defaults.sql',
    'specs/commission-examples.csv',
  ]);
  // .ts .tsx .mts .cts .js .mjs .cjs .jsx are importable; ops/, docs/, test/ are no sources.
  for (const f of out.data_sources) expect(f, f).not.toMatch(/\.(ts|tsx|mts|cts|js|mjs|cjs|jsx)$/);
});

it('[CT-06zzzzv] classifySources: removed_or_renamed are the deleted source files and the old paths of renames', () => {
  const out = classifySources(ENTRIES);
  expect(sorted(out.removed_or_renamed)).toEqual([
    'packages/money/src/before.ts',
    'packages/money/src/old.ts',
  ]);
  // The new path of a rename is an ordinary source; a deleted test file is not a source.
  expect(out.removed_or_renamed).not.toContain('packages/money/src/renamed.ts');
  expect(out.removed_or_renamed).not.toContain('apps/api/src/gone.test.ts');
  expect(out.force_all).toBe(false);
});

it('[CT-06zzzzv] classifySources: force_all when package.json, the lockfile, the workspace file, tsconfig*.json, vitest*.config.* or vite*.config.* changed', () => {
  const plain: Entry = { status: 'M', path: 'packages/money/src/a.ts' };
  expect(classifySources([plain]).force_all).toBe(false);
  expect(classifySources([]).force_all).toBe(false);
  for (const path of [
    'package.json',
    'apps/api/package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'tsconfig.json',
    'tsconfig.base.json',
    'packages/money/tsconfig.build.json',
    'apps/api/vitest.config.ts',
    'packages/money/vitest.int.config.mts',
    'apps/h5/vite.config.ts',
  ]) {
    expect(classifySources([plain, { status: 'M', path }]).force_all, path).toBe(true);
  }
  // A plain file whose name only looks alike does not.
  expect(
    classifySources([plain, { status: 'M', path: 'packages/money/src/package-json.ts' }]).force_all,
  ).toBe(false);
});

it('[CT-06zzzzv] classifySources: nothing to report for TS-only modifications', () => {
  const out = classifySources([
    { status: 'M', path: 'packages/money/src/a.ts' },
    { status: 'A', path: 'apps/api/src/b.ts' },
  ]);
  expect(out.data_sources).toEqual([]);
  expect(out.removed_or_renamed).toEqual([]);
  expect(out.force_all).toBe(false);
});

// --- CT-06zzzzv round 2 (D10-1337 ④): --tree <tree-ish> diffs the tree that actually runs ----------

/** The tree of the fixture's work tree, uncommitted and untracked files included (as verify-container). */
function worktreeTree(cwd: string): string {
  const idx = join(dir, `index-${String(Date.now())}.tmp`);
  const env = { ...process.env, GIT_INDEX_FILE: idx };
  const gitIdx = (args: string[]) => {
    const res = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
    if (res.status !== 0) throw new Error(`git ${args.join(' ')}: ${res.stderr}`);
    return res.stdout.trim();
  };
  gitIdx(['read-tree', 'HEAD']);
  gitIdx(['add', '-A', '.']);
  const tree = gitIdx(['write-tree']);
  rmSync(idx, { force: true });
  return tree;
}

it(
  '[CT-06zzzzv] related-sources CLI --tree: uncommitted and untracked source files of that tree count; without --tree only commits do',
  () => {
    const wt = `${dir}/dirty`;
    writeFiles(wt, {
      'package.json': '{"name":"fixture","private":true}\n',
      'packages/money/src/a.ts': 'export const a = 1;\n',
      'packages/money/src/b.ts': 'export const b = 1;\n',
    });
    fixtureGit(wt, ['init', '-q', '-b', 'main']);
    fixtureGit(wt, ['add', '-A']);
    fixtureGit(wt, ['commit', '-q', '-m', 'base']);
    const forkPoint = fixtureGit(wt, ['rev-parse', 'HEAD']);
    fixtureGit(wt, ['checkout', '-q', '-b', 'task']);
    // Nothing committed on the branch: one tracked change, one new file, one test file.
    writeFiles(wt, {
      'packages/money/src/a.ts': 'export const a = 2;\n',
      'db/seeds/0002_new.sql': 'select 2;\n',
      'packages/money/src/a.test.ts': 'export {};\n',
    });
    const tree = worktreeTree(wt);

    const committedOnly = runCli('related-sources.ts', ['--base', forkPoint, '--cwd', wt]);
    expect(committedOnly.status, committedOnly.stderr).toBe(0);
    expect(lines(committedOnly.stdout)).toEqual([]);

    const res = runCli('related-sources.ts', ['--base', forkPoint, '--tree', tree, '--cwd', wt]);
    expect(res.status, res.stderr).toBe(0);
    expect(lines(res.stdout)).toEqual(['db/seeds/0002_new.sql', 'packages/money/src/a.ts']);
    // Read-only: the real index and the work tree are untouched.
    // (Nothing staged: the uncommitted changes stay in the work tree only.)
    expect(fixtureGit(wt, ['diff', '--cached', '--name-only'])).toBe('');
  },
  CLI_TIMEOUT,
);

it(
  '[CT-06zzzzv] related-sources CLI --tree: an unknown tree or one that starts with "-" exits 2',
  () => {
    const head = fixtureGit(repo, ['rev-parse', 'HEAD']);
    const bad = runCli('related-sources.ts', [
      '--base',
      head,
      '--tree',
      '0000000000000000000000000000000000000000',
      '--cwd',
      repo,
    ]);
    expect(bad.status).toBe(2);
    expect(bad.stdout).toBe('');
    // Refused for the tree, not because --tree is unknown.
    expect(bad.stderr).not.toMatch(/unknown option/i);
    const dash = runCli('related-sources.ts', ['--base', head, '--tree=--output=x', '--cwd', repo]);
    expect(dash.status).toBe(2);
    expect(dash.stdout).toBe('');
    expect(dash.stderr).not.toMatch(/unknown option/i);
  },
  CLI_TIMEOUT,
);
