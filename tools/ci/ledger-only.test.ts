// CT-06zzzv (FU-CI-LEDGER-ONLY-FAST, D10-935): tools/ci/ledger-only.ts decides whether a pull
// request changes nothing but task ledgers (ops/tasks/<id>.yaml), so ci.yml may skip the heavy
// verify jobs. It runs from the trusted base copy against the PR checkout, and every doubt
// (another path, no change at all, a git error) must come out as only=false.
//
// Fixture: a git repository under .tmp/ with one base commit and one branch per scenario. Both the
// exported function and the command line are exercised. The module is loaded at run time, so this
// file still loads while ledger-only.ts does not exist and each test fails on an assertion.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';

const REPO = resolve(import.meta.dirname, '../..');
const SCRIPT = join(REPO, 'tools/ci/ledger-only.ts');
const SCRATCH = join(REPO, '.tmp', `ci-ledger-only-${process.pid}`);

type LedgerOnlyResult = { ledgerOnly: boolean; paths: string[]; reason: string };
type LedgerOnlyModule = {
  detectLedgerOnly: (input: { repo: string; base: string; head: string }) => LedgerOnlyResult;
  isLedgerPath: (path: string) => boolean;
};

let loaded: Partial<LedgerOnlyModule> | null = null;
async function load(): Promise<Partial<LedgerOnlyModule>> {
  if (loaded === null) {
    try {
      loaded = (await import(pathToFileURL(SCRIPT).href)) as Partial<LedgerOnlyModule>;
    } catch {
      loaded = {};
    }
  }
  return loaded;
}

async function detect(): Promise<LedgerOnlyModule['detectLedgerOnly']> {
  const mod = await load();
  expect(mod.detectLedgerOnly, 'tools/ci/ledger-only.ts exports detectLedgerOnly').toBeTypeOf(
    'function',
  );
  return mod.detectLedgerOnly as LedgerOnlyModule['detectLedgerOnly'];
}

const GIT_ENV = {
  PATH: process.env['PATH'] ?? '',
  HOME: SCRATCH,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CEILING_DIRECTORIES: SCRATCH,
};

function git(cwd: string, args: string[]): string {
  const res = spawnSync(
    'git',
    [
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@example.invalid',
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { cwd, encoding: 'utf8', env: GIT_ENV },
  );
  if (res.status !== 0) throw new Error(`git ${args.join(' ')}: ${res.stderr}`);
  return res.stdout.trim();
}

function write(root: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
}

type Cli = { status: number | null; stdout: string; stderr: string; output: string | null };

/** Runs the command line from a neutral directory (so only --repo can point at the fixture). */
function cli(args: string[], opts: { githubOutput?: string; preOutput?: string } = {}): Cli {
  const env: Record<string, string> = { ...GIT_ENV };
  if (opts.githubOutput !== undefined) {
    writeFileSync(opts.githubOutput, opts.preOutput ?? '');
    env['GITHUB_OUTPUT'] = opts.githubOutput;
  }
  const res = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: SCRATCH,
    encoding: 'utf8',
    env,
  });
  return {
    status: res.status,
    stdout: res.stdout,
    stderr: res.stderr,
    output:
      opts.githubOutput !== undefined && existsSync(opts.githubOutput)
        ? readFileSync(opts.githubOutput, 'utf8')
        : null,
  };
}

function onlyLines(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('only='));
}

// --- fixture -----------------------------------------------------------------------------------

const BASE_FILES: Record<string, string> = {
  'ops/tasks/A1-01.yaml': 'id: A1-01\nstatus: todo\n',
  'ops/tasks/A1-02.yaml': 'id: A1-02\nstatus: todo\n',
  'ops/tasks/README.md': '# tasks\n',
  'ops/approvals.yaml': 'approvals: []\n',
  'ops/evidence/A1-01.json': '{}\n',
  'tools/ci/x.ts': 'export const x = 1;\n',
  'test/x.test.ts': 'export {};\n',
  'apps/x.ts': 'export const a = 1;\n',
  '.github/workflows/ci.yml': 'name: ci\n',
  'docs/A1-05.yaml': 'id: A1-05\nnote: a yaml file outside ops/tasks\n',
  // CT-06zzzze: docs/** joins the fast path, so the non-ledger yaml outside ops/tasks used by the
  // rename case lives in notes/; docs/ gets a sub-directory for the docs cases.
  'notes/A1-05.yaml': 'id: A1-05\nnote: a yaml file outside ops/tasks and docs\n',
  'docs/guide/intro.md': '# intro\n',
  'AGENTS.md': '# agents\n',
  'README.md': '# fixture\n',
  'package.json': '{ "name": "fixture" }\n',
};

type Mutation = {
  write?: Record<string, string>;
  remove?: string[];
  move?: [string, string][];
  /** Symbolic links to create: [path, target]. */
  link?: [string, string][];
};

type Case = { name: string; expected: boolean; change: Mutation };

const LEDGER_EDIT = { 'ops/tasks/A1-01.yaml': 'id: A1-01\nstatus: done\n' };

/** Paths that are not task ledgers, each changed together with one ledger edit. */
const OTHER_PATHS: [string, string][] = [
  ['ops/evidence/A1-01.json', '{ "task": "A1-01" }\n'],
  ['ops/evidence/X1-01.json', '{}\n'],
  ['ops/approvals.yaml', 'approvals: [1]\n'],
  ['ops/tasks/README.md', '# tasks, edited\n'],
  ['ops/tasks/sub/X1-01.yaml', 'id: X1-01\n'],
  ['ops/tasks/X1-01.yml', 'id: X1-01\n'],
  ['ops/tasks/X1-01.yaml.bak', 'id: X1-01\n'],
  ['ops/tasks.yaml', 'id: X1-01\n'],
  ['apps/ops/tasks/X1-01.yaml', 'id: X1-01\n'],
  ['tools/ci/x.ts', 'export const x = 2;\n'],
  ['test/x.test.ts', 'export const t = 1;\n'],
  ['apps/x.ts', 'export const a = 2;\n'],
  ['.github/workflows/ci.yml', 'name: ci2\n'],
  ['README.md', '# fixture, edited\n'],
  ['package.json', '{ "name": "fixture2" }\n'],
];

const CASES: Case[] = [
  // 1-4: only ledgers change.
  {
    name: 'adds one ledger ops/tasks/X1-01.yaml',
    expected: true,
    change: { write: { 'ops/tasks/X1-01.yaml': 'id: X1-01\n' } },
  },
  {
    name: 'modifies several ledgers',
    expected: true,
    change: { write: { ...LEDGER_EDIT, 'ops/tasks/A1-02.yaml': 'id: A1-02\nstatus: done\n' } },
  },
  {
    name: 'renames a ledger to another ledger',
    expected: true,
    change: { move: [['ops/tasks/A1-01.yaml', 'ops/tasks/A1-09.yaml']] },
  },
  { name: 'only deletes ledgers', expected: true, change: { remove: ['ops/tasks/A1-02.yaml'] } },
  {
    name: 'adds, modifies and deletes ledgers at once',
    expected: true,
    change: {
      write: { ...LEDGER_EDIT, 'ops/tasks/X1-02.yaml': 'id: X1-02\n' },
      remove: ['ops/tasks/A1-02.yaml'],
    },
  },
  // 5: any other path next to a ledger edit.
  ...OTHER_PATHS.map(([path, text]): Case => ({
    name: `a ledger edit plus ${path}`,
    expected: false,
    change: { write: { ...LEDGER_EDIT, [path]: text } },
  })),
  {
    name: 'a ledger edit plus a deleted tools file',
    expected: false,
    change: { write: LEDGER_EDIT, remove: ['tools/ci/x.ts'] },
  },
  {
    name: 'only ops/evidence changes',
    expected: false,
    change: { write: { 'ops/evidence/A1-01.json': '{ "task": "A1-01" }\n' } },
  },
  // 6: a rename with one side outside ops/tasks/<id>.yaml.
  {
    name: 'renames a ledger out of ops/tasks',
    expected: false,
    change: { move: [['ops/tasks/A1-01.yaml', 'ops/archive/A1-01.yaml']] },
  },
  {
    name: 'renames a ledger to .yml',
    expected: false,
    change: { move: [['ops/tasks/A1-01.yaml', 'ops/tasks/A1-01.yml']] },
  },
  {
    name: 'renames a ledger into a subdirectory of ops/tasks',
    expected: false,
    change: { move: [['ops/tasks/A1-01.yaml', 'ops/tasks/old/A1-01.yaml']] },
  },
  {
    name: 'renames a non-ledger file into ops/tasks',
    expected: false,
    change: { move: [['notes/A1-05.yaml', 'ops/tasks/A1-05.yaml']] },
  },
  // 7: no change between base and head (the head is an empty commit).
  { name: 'an empty commit (no change at all)', expected: false, change: {} },
];

// CT-06zzzze (D10-1024 E): docs/** joins task ledgers on the fast path. A path counts only when
// it lies below the top-level directory docs/ (both sides of a rename, deletions too) and is a
// regular file there; `docs` itself as a file or a symbolic link, a link below docs/, and every
// look-alike (docs.md, doc/, apps/docs/, tools/docs/, ...) are not docs.
const DOC_EDIT = { 'docs/guide/intro.md': '# intro, edited\n' };

/** Paths that are neither docs/** nor task ledgers, each changed together with one docs edit. */
const NOT_DOCS: [string, string][] = [
  ['docs.md', '# docs.md\n'],
  ['doc/x.md', '# doc\n'],
  ['apps/docs/x.md', '# apps docs\n'],
  ['tools/docs/x', 'x\n'],
  ['ops/docs/x.md', '# ops docs\n'],
  ['packages/x/docs/y.md', '# package docs\n'],
  ['README.md', '# fixture, edited\n'],
  ['AGENTS.md', '# agents, edited\n'],
];

const DOC_CASES: Case[] = [
  { name: 'modifies a file under docs/', expected: true, change: { write: DOC_EDIT } },
  {
    name: 'adds a file in a new docs/ sub-directory',
    expected: true,
    change: { write: { 'docs/a/b/c.md': '# deep\n' } },
  },
  {
    name: 'deletes a file under docs/',
    expected: true,
    change: { remove: ['docs/guide/intro.md'] },
  },
  {
    name: 'renames a file within docs/',
    expected: true,
    change: { move: [['docs/guide/intro.md', 'docs/handbook/start.md']] },
  },
  {
    name: 'adds, modifies and deletes docs at once',
    expected: true,
    change: {
      write: { 'docs/new.md': '# new\n', 'docs/A1-05.yaml': 'id: A1-05\nnote: edited\n' },
      remove: ['docs/guide/intro.md'],
    },
  },
  {
    name: 'a docs edit plus a ledger edit',
    expected: true,
    change: { write: { ...DOC_EDIT, ...LEDGER_EDIT } },
  },
  {
    name: 'a deleted docs file plus a new ledger',
    expected: true,
    change: {
      write: { 'ops/tasks/X1-03.yaml': 'id: X1-03\n' },
      remove: ['docs/guide/intro.md'],
    },
  },
  {
    name: 'renames docs/A1-05.yaml to the ledger ops/tasks/A1-05.yaml',
    expected: true,
    change: { move: [['docs/A1-05.yaml', 'ops/tasks/A1-05.yaml']] },
  },
  ...NOT_DOCS.map(([path, text]): Case => ({
    name: `a docs edit plus ${path}`,
    expected: false,
    change: { write: { ...DOC_EDIT, [path]: text } },
  })),
  {
    name: 'a docs edit, a ledger edit and README.md',
    expected: false,
    change: { write: { ...DOC_EDIT, ...LEDGER_EDIT, 'README.md': '# fixture, edited\n' } },
  },
  { name: 'only docs.md changes', expected: false, change: { write: { 'docs.md': '# x\n' } } },
  {
    name: 'renames a docs file out of docs/',
    expected: false,
    change: { move: [['docs/guide/intro.md', 'guide/intro.md']] },
  },
  {
    name: 'renames README.md into docs/',
    expected: false,
    change: { move: [['README.md', 'docs/README.md']] },
  },
  {
    name: 'docs itself becomes a regular file',
    expected: false,
    change: {
      remove: ['docs/A1-05.yaml', 'docs/guide/intro.md'],
      write: { docs: 'not a directory\n' },
    },
  },
  {
    name: 'docs itself becomes a symbolic link',
    expected: false,
    change: { remove: ['docs/A1-05.yaml', 'docs/guide/intro.md'], link: [['docs', 'ops/tasks']] },
  },
  {
    name: 'adds a symbolic link under docs/',
    expected: false,
    change: { link: [['docs/link.md', '../README.md']] },
  },
];

let repo = '';
let base = '';
const heads = new Map<string, string>();
/** main moved on after the PR branched: a tools change that is not part of the PR. */
let movedBase = '';
let branchHead = '';
let mergedHead = '';
let mixedAfterMove = '';

function commitCase(name: string, change: Mutation, from: string): string {
  git(repo, ['checkout', '-q', '--detach', from]);
  // Removals first, so a removed directory can be replaced by a file or a link of the same name.
  for (const path of change.remove ?? []) git(repo, ['rm', '-q', '--', path]);
  for (const [from, to] of change.move ?? []) {
    mkdirSync(dirname(join(repo, to)), { recursive: true });
    git(repo, ['mv', '--', from, to]);
  }
  if (change.write) write(repo, change.write);
  for (const [path, target] of change.link ?? []) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    symlinkSync(target, join(repo, path));
  }
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '--allow-empty', '-m', name]);
  return git(repo, ['rev-parse', 'HEAD']);
}

// About sixty fixture commits (four git processes each) since CT-06zzzze added the docs cases: the
// 10 s default hook limit was exceeded even with this file alone, so the hook gets its own limit.
const FIXTURE_TIMEOUT_MS = 120_000;

beforeAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
  repo = join(SCRATCH, 'repo');
  mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-q', '-b', 'main']);
  write(repo, BASE_FILES);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'base']);
  base = git(repo, ['rev-parse', 'HEAD']);

  for (const c of [...CASES, ...DOC_CASES]) heads.set(c.name, commitCase(c.name, c.change, base));

  // Merge-base semantics: the PR changes one ledger; main then gets a tools change.
  branchHead = commitCase('pr: ledger only', { write: LEDGER_EDIT }, base);
  movedBase = commitCase('main: tools change', { write: { 'tools/ci/x.ts': 'moved\n' } }, base);
  // The PR branch brings main in (a merge commit), still changing nothing but the ledger itself.
  git(repo, ['checkout', '-q', '--detach', branchHead]);
  git(repo, ['merge', '-q', '--no-edit', '--no-ff', movedBase]);
  mergedHead = git(repo, ['rev-parse', 'HEAD']);
  // And a PR that does change tools itself, judged against the moved base.
  mixedAfterMove = commitCase(
    'pr: ledger and test',
    { write: { ...LEDGER_EDIT, 'test/x.test.ts': 'export const t = 2;\n' } },
    base,
  );
  git(repo, ['checkout', '-q', '--detach', base]);
}, FIXTURE_TIMEOUT_MS);

afterAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
});

function headOf(name: string): string {
  const head = heads.get(name);
  if (head === undefined) throw new Error(`no fixture commit for ${name}`);
  return head;
}

// --- the exported function ---------------------------------------------------------------------

it.each(CASES)('[CT-06zzzv] detectLedgerOnly: $name -> only=$expected', async (c) => {
  const detectLedgerOnly = await detect();
  const result = detectLedgerOnly({ repo, base, head: headOf(c.name) });
  expect(result.ledgerOnly).toBe(c.expected);
  expect(Array.isArray(result.paths)).toBe(true);
  expect(typeof result.reason).toBe('string');
});

it('[CT-06zzzv] detectLedgerOnly lists both sides of a rename and every offending path', async () => {
  const detectLedgerOnly = await detect();
  const renamed = detectLedgerOnly({
    repo,
    base,
    head: headOf('renames a ledger to another ledger'),
  });
  expect(renamed.ledgerOnly).toBe(true);
  expect(renamed.paths).toEqual(
    expect.arrayContaining(['ops/tasks/A1-01.yaml', 'ops/tasks/A1-09.yaml']),
  );
  const out = detectLedgerOnly({ repo, base, head: headOf('renames a ledger out of ops/tasks') });
  expect(out.ledgerOnly).toBe(false);
  expect(out.paths).toEqual(
    expect.arrayContaining(['ops/tasks/A1-01.yaml', 'ops/archive/A1-01.yaml']),
  );
  const mixed = detectLedgerOnly({
    repo,
    base,
    head: headOf('a ledger edit plus ops/evidence/A1-01.json'),
  });
  expect(mixed.ledgerOnly).toBe(false);
  expect(mixed.paths).toEqual(
    expect.arrayContaining(['ops/tasks/A1-01.yaml', 'ops/evidence/A1-01.json']),
  );
  expect(mixed.reason).toContain('ops/evidence/A1-01.json');
});

it('[CT-06zzzv] detectLedgerOnly: head equal to base is no change, only=false', async () => {
  const detectLedgerOnly = await detect();
  const result = detectLedgerOnly({ repo, base, head: base });
  expect(result.ledgerOnly).toBe(false);
  expect(result.paths).toEqual([]);
  expect(result.reason).not.toBe('');
});

it('[CT-06zzzv] detectLedgerOnly diffs base...head (merge base), not base..head', async () => {
  const detectLedgerOnly = await detect();
  // main moved on with a tools change after the PR branched: the PR is still ledger-only.
  expect(detectLedgerOnly({ repo, base: movedBase, head: branchHead }).ledgerOnly).toBe(true);
  // The PR merged main into itself: the merge base is main's tip, the diff is the ledger.
  expect(detectLedgerOnly({ repo, base: movedBase, head: mergedHead }).ledgerOnly).toBe(true);
  // A PR that changes a test itself stays false against the moved base.
  expect(detectLedgerOnly({ repo, base: movedBase, head: mixedAfterMove }).ledgerOnly).toBe(false);
});

it('[CT-06zzzv] detectLedgerOnly turns git errors into only=false with a reason, never a throw', async () => {
  const detectLedgerOnly = await detect();
  const plain = join(SCRATCH, 'not-a-repo');
  mkdirSync(plain, { recursive: true });
  const head = headOf('adds one ledger ops/tasks/X1-01.yaml');
  const inputs = [
    { repo, base: '0'.repeat(40), head },
    { repo, base, head: 'f'.repeat(40) },
    { repo, base, head: 'not-a-sha' },
    { repo: plain, base, head },
    { repo: join(SCRATCH, 'does-not-exist'), base, head },
  ];
  for (const input of inputs) {
    let result: LedgerOnlyResult | undefined;
    expect(() => {
      result = detectLedgerOnly(input);
    }, JSON.stringify(input)).not.toThrow();
    expect(result?.ledgerOnly, JSON.stringify(input)).toBe(false);
    expect(result?.reason, JSON.stringify(input)).toMatch(/\S/);
  }
});

it('[CT-06zzzv] isLedgerPath accepts exactly ops/tasks/<id>.yaml', async () => {
  const mod = await load();
  expect(mod.isLedgerPath, 'tools/ci/ledger-only.ts exports isLedgerPath').toBeTypeOf('function');
  const isLedgerPath = mod.isLedgerPath as LedgerOnlyModule['isLedgerPath'];
  for (const path of [
    'ops/tasks/X1-01.yaml',
    'ops/tasks/CT-06zzzv.yaml',
    'ops/tasks/B2-04zzb.yaml',
  ])
    expect(isLedgerPath(path), path).toBe(true);
  for (const path of [
    'ops/tasks/README.md',
    'ops/tasks/sub/X1-01.yaml',
    'ops/tasks/X1-01.yml',
    'ops/tasks/X1-01.yaml.bak',
    'ops/tasks.yaml',
    'ops/tasks/',
    'ops/evidence/X1-01.json',
    'ops/approvals.yaml',
    'apps/ops/tasks/X1-01.yaml',
    '/ops/tasks/X1-01.yaml',
    './ops/tasks/X1-01.yaml',
    'xops/tasks/X1-01.yaml',
    'tools/ci/ledger-only.ts',
    '.github/workflows/ci.yml',
    'README.md',
  ])
    expect(isLedgerPath(path), path).toBe(false);
});

// --- the command line --------------------------------------------------------------------------

it.each(CASES)('[CT-06zzzv] CLI: $name -> prints only=$expected, exit 0', (c) => {
  const res = cli(['--repo', repo, '--base', base, '--head', headOf(c.name)]);
  expect(res.status, res.stderr).toBe(0);
  expect(onlyLines(res.stdout)).toEqual([`only=${String(c.expected)}`]);
});

it('[CT-06zzzv] CLI: base...head merge-base semantics and head equal to base', () => {
  const moved = cli(['--repo', repo, '--base', movedBase, '--head', branchHead]);
  expect(moved.status, moved.stderr).toBe(0);
  expect(onlyLines(moved.stdout)).toEqual(['only=true']);
  const same = cli(['--repo', repo, '--base', base, '--head', base]);
  expect(same.status, same.stderr).toBe(0);
  expect(onlyLines(same.stdout)).toEqual(['only=false']);
});

it('[CT-06zzzv] CLI: git errors print only=false, exit 0, and explain on stderr', () => {
  const plain = join(SCRATCH, 'not-a-repo-cli');
  mkdirSync(plain, { recursive: true });
  const head = headOf('adds one ledger ops/tasks/X1-01.yaml');
  for (const args of [
    ['--repo', repo, '--base', '0'.repeat(40), '--head', head],
    ['--repo', repo, '--base', base, '--head', 'not-a-sha'],
    ['--repo', plain, '--base', base, '--head', head],
    ['--repo', join(SCRATCH, 'does-not-exist'), '--base', base, '--head', head],
  ]) {
    const out = join(SCRATCH, 'gh-output-error');
    const res = cli(args, { githubOutput: out });
    expect(res.status, args.join(' ')).toBe(0);
    expect(onlyLines(res.stdout), args.join(' ')).toEqual(['only=false']);
    expect(res.stderr.trim(), args.join(' ')).not.toBe('');
    expect(res.output, args.join(' ')).toBe('only=false\n');
  }
});

it('[CT-06zzzv] CLI appends only=<value> to GITHUB_OUTPUT and keeps what was there', () => {
  const out = join(SCRATCH, 'gh-output');
  const yes = cli(['--repo', repo, '--base', base, '--head', headOf('modifies several ledgers')], {
    githubOutput: out,
    preOutput: 'earlier=1\n',
  });
  expect(yes.status, yes.stderr).toBe(0);
  expect(yes.output).toBe('earlier=1\nonly=true\n');
  expect(onlyLines(yes.stdout)).toEqual(['only=true']);

  const no = cli(
    ['--repo', repo, '--base', base, '--head', headOf('a ledger edit plus tools/ci/x.ts')],
    { githubOutput: out, preOutput: '' },
  );
  expect(no.status, no.stderr).toBe(0);
  expect(no.output).toBe('only=false\n');
  expect(onlyLines(no.stdout)).toEqual(['only=false']);
});

it('[CT-06zzzv] CLI without GITHUB_OUTPUT still prints the result and leaves the repo untouched', () => {
  const before = git(repo, ['status', '--porcelain']);
  const head = git(repo, ['rev-parse', 'HEAD']);
  const res = cli(['--repo', repo, '--base', base, '--head', headOf('only deletes ledgers')]);
  expect(res.status, res.stderr).toBe(0);
  expect(onlyLines(res.stdout)).toEqual(['only=true']);
  expect(git(repo, ['status', '--porcelain'])).toBe(before);
  expect(git(repo, ['rev-parse', 'HEAD'])).toBe(head);
});

// --- CT-06zzzze: docs/** on the fast path ------------------------------------------------------

it.each(DOC_CASES)('[CT-06zzzze] detectLedgerOnly: $name -> only=$expected', async (c) => {
  const detectLedgerOnly = await detect();
  const result = detectLedgerOnly({ repo, base, head: headOf(c.name) });
  expect(result.ledgerOnly, result.reason).toBe(c.expected);
  expect(Array.isArray(result.paths)).toBe(true);
  expect(result.reason).toMatch(/\S/);
});

it.each(DOC_CASES)('[CT-06zzzze] CLI: $name -> prints only=$expected, exit 0', (c) => {
  const res = cli(['--repo', repo, '--base', base, '--head', headOf(c.name)]);
  expect(res.status, res.stderr).toBe(0);
  expect(onlyLines(res.stdout)).toEqual([`only=${String(c.expected)}`]);
});

it('[CT-06zzzze] detectLedgerOnly lists the docs paths and names the offending path', async () => {
  const detectLedgerOnly = await detect();
  const renamed = detectLedgerOnly({ repo, base, head: headOf('renames a file within docs/') });
  expect(renamed.ledgerOnly, renamed.reason).toBe(true);
  expect(renamed.paths).toEqual(
    expect.arrayContaining(['docs/guide/intro.md', 'docs/handbook/start.md']),
  );
  const mixed = detectLedgerOnly({ repo, base, head: headOf('a docs edit plus a ledger edit') });
  expect(mixed.ledgerOnly, mixed.reason).toBe(true);
  expect(mixed.paths).toEqual(
    expect.arrayContaining(['docs/guide/intro.md', 'ops/tasks/A1-01.yaml']),
  );
  const other = detectLedgerOnly({ repo, base, head: headOf('a docs edit plus apps/docs/x.md') });
  expect(other.ledgerOnly).toBe(false);
  expect(other.paths).toEqual(expect.arrayContaining(['docs/guide/intro.md', 'apps/docs/x.md']));
  expect(other.reason).toContain('apps/docs/x.md');
});
