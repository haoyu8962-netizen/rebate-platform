// CT-06zzzzz (D10-1319 / D10-1334): verify-container.sh <id> [--worktree <dir>] --tests <path>…
// — the named test files or directories of the worktree's snapshot tree (uncommitted and untracked
// files count), expanded to *.test.ts / *.test.tsx, grouped by the trusted red-plan.ts, run in the
// same isolation as --red (unit groups `--network none` without database URLs; integration groups
// on the run's internal network with a one-shot PostgreSQL and Redis, TEST_PG_ADMIN_URL and
// TEST_REDIS_URL only), summed up by the trusted tools/ops/tests-report.ts into tests/<n>/tests.json.
// Never result.json (never evidence), never the verify slot, no test-guard, no red-check.
//
// A stub `docker` first on PATH records every call (JSON lines, with the environment it hands to
// the container) and answers like a healthy daemon with the image and the store in place. A test
// container (a `docker run` that mounts a directory on /out) writes into that directory what the
// case file STUB_TESTS_SPEC says ({ exit, files: { <name>: { text } | { symlink } | { fifo } |
// { dir } } }; a file already there is left as it is) and exits with `exit`.
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { repoRoot } from '../lib/paths.ts';
import { loadRedProjects, planRed } from './red-plan.ts';
import {
  CLI_TIMEOUT,
  fixtureGit,
  OPS_DIR,
  removeDir,
  scratchDir,
  writeFiles,
} from './test-helpers.ts';

const SCRIPT = join(OPS_DIR, 'verify-container.sh');
const ID = 'T1-07';
const RUN_ROOT = '/work/repo';
/** Put into the script's environment: no container may ever see it. */
const HOST_SECRET = ['couli', 'host', 'marker', '7f3a'].join('-');
const JUDGE_TIMEOUT = 120_000;
/** Another run's slot id in a lock fixture: 32 hex digits, built at run time. */
const OTHER_HOLDER_ID = Array.from({ length: 32 }, (_, i) => (i % 16).toString(16)).join('');

const T = {
  one: 'test/spec/alpha/one.test.ts',
  two: 'test/spec/alpha/two.test.ts',
  helper: 'test/spec/alpha/helper.ts',
  three: 'test/spec/alpha/three.int.test.ts',
  four: 'test/spec/beta/four.test.ts',
  page: 'test/spec/ui/page.browser.test.tsx',
  five: 'packages/testing/src/five.test.ts',
  app: 'apps/api/src/six.test.ts',
  data: 'test/spec/fixtures/data.json',
  // Supplement (tests-projects.json): package tests, and one file no project takes.
  apiUnit: 'apps/api/src/modules/x/x.test.ts',
  apiInt: 'apps/api/src/modules/x/x.int.test.ts',
  tool: 'tools/ops/y.test.ts',
  infra: 'infra/scan/z.test.ts',
};

/** The --tests project table (trusted root), read when a test needs it. */
const TESTS_TABLE = join(repoRoot(), 'tools', 'ops', 'verify-image', 'tests-projects.json');

let base = '';
let runs = '';

beforeAll(() => {
  base = scratchDir('verify-tests');
  runs = join(base, 'runs');
});
afterAll(() => removeDir(base));

// --- fixtures -------------------------------------------------------------------------------------

/** A committed workspace the container path accepts, with test files of every kind. */
function workspace(name: string): { repo: string; head: string; tree: string } {
  const root = JSON.parse(readFileSync(join(repoRoot(), 'package.json'), 'utf8')) as {
    packageManager: string;
  };
  const repo = join(base, name);
  writeFiles(repo, {
    'package.json': `${JSON.stringify(
      { name, private: true, packageManager: root.packageManager, scripts: { verify: 'true' } },
      null,
      2,
    )}\n`,
    'pnpm-workspace.yaml': 'packages: []\n',
    'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
    [T.one]: "it('[AC-T-01] a', () => {});\n",
    [T.two]: "it('[AC-T-02] c', () => {});\n",
    [T.helper]: 'export const h = 1;\n',
    [T.three]: "it('[AC-T-03] d', () => {});\n",
    [T.four]: "it('[AC-T-04] e', () => {});\n",
    [T.page]: "it('[AC-T-05] page', () => {});\n",
    [T.five]: "it('five', () => {});\n",
    [T.app]: "it('six', () => {});\n",
    [T.data]: '{}\n',
    [T.apiUnit]: "it('api unit', () => {});\n",
    [T.apiInt]: "it('api int', () => {});\n",
    [T.tool]: "it('tool', () => {});\n",
    [T.infra]: "it('infra', () => {});\n",
    'docs/a.md': '# a\n',
  });
  fixtureGit(repo, ['init', '-q', '-b', 'main']);
  fixtureGit(repo, ['add', '-A']);
  fixtureGit(repo, ['commit', '-q', '-m', 'fixture']);
  return {
    repo,
    head: fixtureGit(repo, ['rev-parse', 'HEAD']),
    tree: fixtureGit(repo, ['rev-parse', 'HEAD^{tree}']),
  };
}

let shared: { repo: string; head: string; tree: string } | null = null;
function sharedWorkspace(): { repo: string; head: string; tree: string } {
  shared ??= workspace('tests-shared');
  return shared;
}

/** `git status --porcelain=v1 -z --untracked-files=all`, byte for byte. */
function porcelain(repo: string): string {
  const res = spawnSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
    cwd: repo,
    encoding: 'utf8',
  });
  if (res.status !== 0) throw new Error(`git status failed: ${res.stderr}`);
  return res.stdout;
}

// --- the stub docker --------------------------------------------------------------------------------

const STUB = String.raw`'use strict';
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
const env = {};
args.forEach((a, i) => {
  if (args[i - 1] !== '-e') return;
  const eq = a.indexOf('=');
  if (eq === -1) env[a] = process.env[a] ?? null;
  else env[a.slice(0, eq)] = a.slice(eq + 1);
});
fs.appendFileSync(process.env.STUB_DOCKER_LOG, JSON.stringify({ args, env }) + '\n');
function answer(text, code) {
  if (text !== '') fs.writeSync(1, text + '\n');
  process.exit(code);
}
if (process.env.STUB_DOCKER_DOWN === '1') answer('', 1);
if (args[0] === 'version') answer('28.0.1', 0);
if (args[0] === 'run' && args.includes('-d')) answer('0123456789ab', 0);
if (args[0] === 'inspect') answer('true', 0);
if (args[0] === 'exec' && args.includes('redis-cli')) answer('PONG', 0);
const mount = args.find((a, i) => args[i - 1] === '-v' && a.split(':')[1] === '/out');
if (args[0] === 'run' && mount) {
  const spec = process.env.STUB_TESTS_SPEC
    ? JSON.parse(fs.readFileSync(process.env.STUB_TESTS_SPEC, 'utf8'))
    : { exit: 0, files: {} };
  const out = mount.split(':')[0];
  // auto: every group of the run's plan.json (beside out/) green, one passing test per file.
  if (spec.auto) {
    const plan = JSON.parse(fs.readFileSync(out + '/../plan.json', 'utf8'));
    spec.files = spec.files || {};
    for (const g of plan.groups) {
      spec.files[g.name + '.exit'] = { text: '0\n' };
      spec.files[g.name + '.seconds'] = { text: '2\n' };
      spec.files[g.name + '.vitest-report.json'] = {
        text: JSON.stringify({
          numTotalTests: g.files.length,
          numFailedTests: 0,
          numPassedTests: g.files.length,
          success: true,
          testResults: g.files.map((f) => ({
            name: '/work/repo/' + g.dir + '/' + f,
            status: 'passed',
            message: '',
            assertionResults: [{ ancestorTitles: [], title: 'ok', fullName: 'ok', status: 'passed' }],
          })),
        }),
      };
    }
  }
  for (const [file, how] of Object.entries(spec.files || {})) {
    const p = out + '/' + file;
    let there = true;
    try {
      fs.lstatSync(p);
    } catch {
      there = false;
    }
    if (there) continue;
    if (typeof how.text === 'string') fs.writeFileSync(p, how.text);
    else if (typeof how.symlink === 'string') fs.symlinkSync(how.symlink, p);
    else if (how.fifo) spawnSync('mkfifo', [p]);
    else if (how.dir) fs.mkdirSync(p);
  }
  answer('', spec.exit ?? 0);
}
answer('', 0);
`;

type DockerCall = { args: string[]; env: Record<string, string | null> };
type OutFile = { text: string } | { symlink: string } | { fifo: true } | { dir: true };
type ContainerSpec = { exit?: number; files: Record<string, OutFile>; auto?: boolean };
type Run = {
  status: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  calls: DockerCall[];
};

let stubBin = '';
let stubRuns = 0;

function stubDocker(): string {
  if (stubBin !== '') return stubBin;
  stubBin = join(base, 'stub-bin');
  writeFiles(stubBin, { 'docker-stub.cjs': STUB });
  const docker = join(stubBin, 'docker');
  writeFileSync(
    docker,
    `#!/bin/sh\nexec '${process.execPath}' '${join(stubBin, 'docker-stub.cjs')}' "$@"\n`,
  );
  chmodSync(docker, 0o755);
  return stubBin;
}

function scriptEnv(runsDir: string, log: string, extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of [
    'COULI_VERIFY_MEMORY',
    'PROP_RUNS',
    'PROP_SEED',
    'COULI_VERIFY_TIMEOUT_SECS',
    'COULI_VERIFY_HOST_SERVICES',
    'COULI_VERIFY_VITEST_MAX_WORKERS',
    'COULI_VERIFY_SLOT_WAIT_SECS',
  ]) {
    Reflect.deleteProperty(env, name);
  }
  Object.assign(env, {
    PATH: `${stubDocker()}:${process.env['PATH'] ?? ''}`,
    COULI_RUNS: runsDir,
    COULI_TRUSTED_ROOT: repoRoot(),
    COULI_VERIFY_PREFIX: 'couli-teststest',
    COULI_VERIFY_SLOT_DIR: join(runsDir, 'slot'),
    STUB_DOCKER_LOG: log,
    // Host credentials and other variables: no container may get them.
    GH_TOKEN: HOST_SECRET,
    AWS_SECRET_ACCESS_KEY: HOST_SECRET,
    COULI_TESTS_HOST_ONLY: HOST_SECRET,
    ...extra,
  });
  return env;
}

function readCalls(log: string): DockerCall[] {
  return existsSync(log)
    ? readFileSync(log, 'utf8')
        .split('\n')
        .filter((l) => l !== '')
        .map((l) => JSON.parse(l) as DockerCall)
    : [];
}

/** A synchronous run (usage errors, --dry-run): the stub docker answers, every call is recorded. */
function run(args: string[], extra: Record<string, string> = {}, runsDir = runs) {
  stubRuns += 1;
  const log = join(base, `calls-${String(stubRuns)}.jsonl`);
  const res = spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: scriptEnv(runsDir, log, extra),
    timeout: 60_000,
    killSignal: 'SIGKILL',
  });
  return {
    status: res.status ?? -1,
    stdout: res.stdout,
    stderr: res.stderr,
    calls: readCalls(log),
  };
}

/**
 * A real run against the stub docker in its own process group; past `limitMs` the whole group is
 * killed (a host that reads a FIFO from out/ would hang) and timedOut is true.
 */
function runStubbed(
  args: string[],
  runsDir: string,
  spec: ContainerSpec | null,
  opts: { limitMs?: number; env?: Record<string, string> } = {},
): Promise<Run> {
  stubRuns += 1;
  const log = join(base, `calls-${String(stubRuns)}.jsonl`);
  const env = scriptEnv(runsDir, log, opts.env ?? {});
  if (spec !== null) {
    const specFile = join(base, `spec-${String(stubRuns)}.json`);
    writeFileSync(specFile, JSON.stringify(spec));
    env['STUB_TESTS_SPEC'] = specFile;
  }
  return new Promise((resolve) => {
    const child = spawn('bash', [SCRIPT, ...args], { env, detached: true, stdio: 'pipe' });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-(child.pid ?? 0), 'SIGKILL');
      } catch {
        // already gone
      }
    }, opts.limitMs ?? 60_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ status: code ?? -1, stdout, stderr, timedOut, calls: readCalls(log) });
    });
  });
}

// --- reading the calls -------------------------------------------------------------------------------

function mountsOf(args: readonly string[]): string[] {
  return args.flatMap((a, i) => (args[i - 1] === '-v' || args[i - 1] === '--volume' ? [a] : []));
}

/** The test containers: the docker runs that mount a directory on /out. */
function testContainers(calls: readonly DockerCall[]): DockerCall[] {
  return calls.filter(
    (c) => c.args[0] === 'run' && mountsOf(c.args).some((m) => m.split(':')[1] === '/out'),
  );
}

function valueAfter(args: readonly string[], flag: string): string | undefined {
  const at = args.indexOf(flag);
  return at === -1 ? undefined : args[at + 1];
}

function hasPair(args: readonly string[], flag: string, value: string): boolean {
  return args.some((a, i) => a === flag && args[i + 1] === value);
}

/** What every test container must look like, database or not. */
function expectIsolated(c: DockerCall): void {
  const label = c.args.join(' ');
  const mounts = mountsOf(c.args);
  expect(mounts.map((m) => m.split(':')[1]).sort(), label).toEqual(['/out', '/src', '/store']);
  for (const target of ['/src', '/store']) {
    const m = mounts.find((x) => x.split(':')[1] === target) ?? '';
    expect(m.endsWith(':ro'), `${target} read-only: ${m}`).toBe(true);
  }
  expect(
    c.args.some((a) => a.includes('docker.sock')),
    label,
  ).toBe(false);
  for (const flag of [
    '--mount',
    '--volumes-from',
    '--privileged',
    '--env-file',
    '--pid',
    '--ipc',
  ]) {
    expect(
      c.args.some((a) => a === flag || a.startsWith(`${flag}=`)),
      `${flag}: ${label}`,
    ).toBe(false);
  }
  // The same hardening as every other test container.
  expect(c.args, label).toContain('--read-only');
  expect(c.args, label).toContain('--init');
  expect(hasPair(c.args, '--cap-drop', 'ALL'), label).toBe(true);
  expect(hasPair(c.args, '--security-opt', 'no-new-privileges'), label).toBe(true);
  // A trusted inline script through bash -c: not the image's entrypoint, no VERIFY_SCRIPT.
  expect(hasPair(c.args, 'bash', '-c'), label).toBe(true);
  expect(c.args, label).not.toContain('couli-verify-entrypoint');
  expect(Object.keys(c.env), label).not.toContain('VERIFY_SCRIPT');
  expect(
    c.args.some((a) => a.startsWith('VERIFY_SCRIPT')),
    label,
  ).toBe(false);
  // No host credential or other host variable.
  expect(JSON.stringify(c), label).not.toContain(HOST_SECRET);
  for (const key of Object.keys(c.env)) {
    expect(key, label).not.toMatch(/TOKEN|SECRET|AWS|^GH_|GITHUB|SSH|NPM_/);
  }
}

function expectOffline(c: DockerCall): void {
  const label = c.args.join(' ');
  expect(
    c.args.filter((a) => a === '--network'),
    label,
  ).toHaveLength(1);
  expect(valueAfter(c.args, '--network'), label).toBe('none');
  for (const key of ['TEST_PG_ADMIN_URL', 'TEST_REDIS_URL']) {
    expect(Object.keys(c.env), label).not.toContain(key);
    expect(
      c.args.some((a) => a.includes(key)),
      label,
    ).toBe(false);
  }
  expect(
    c.args.some((a) => a.includes('postgres://') || a.includes('redis://')),
    label,
  ).toBe(false);
}

// --- reports ----------------------------------------------------------------------------------------

type ReportTest = { ancestors?: string[]; title: string; status: string };
type ReportFile = { rel: string; status: string; tests: ReportTest[]; message?: string };

function vitestReport(files: ReportFile[]): string {
  const all = files.flatMap((f) => f.tests);
  return JSON.stringify({
    numTotalTests: all.length,
    numFailedTests: all.filter((t) => t.status === 'failed').length,
    numPassedTests: all.filter((t) => t.status === 'passed').length,
    success: all.every((t) => t.status !== 'failed'),
    testResults: files.map((f) => ({
      name: `${RUN_ROOT}/${f.rel}`,
      status: f.status,
      message: f.message ?? '',
      assertionResults: f.tests.map((t) => ({
        ancestorTitles: t.ancestors ?? [],
        title: t.title,
        fullName: [...(t.ancestors ?? []), t.title].join(' '),
        status: t.status,
      })),
    })),
  });
}

const UNIT_GREEN = vitestReport([
  {
    rel: T.one,
    status: 'passed',
    tests: [
      { ancestors: ['one'], title: '[AC-T-01] a', status: 'passed' },
      { title: '[AC-T-01] b', status: 'passed' },
    ],
  },
  { rel: T.two, status: 'passed', tests: [{ title: '[AC-T-02] c', status: 'passed' }] },
]);
const UNIT_RED = vitestReport([
  {
    rel: T.one,
    status: 'failed',
    tests: [
      { ancestors: ['one'], title: '[AC-T-01] a', status: 'failed' },
      { title: '[AC-T-01] b', status: 'passed' },
    ],
  },
  { rel: T.two, status: 'passed', tests: [{ title: '[AC-T-02] c', status: 'passed' }] },
]);
const INT_GREEN = vitestReport([
  { rel: T.three, status: 'passed', tests: [{ title: '[AC-T-03] d', status: 'passed' }] },
]);
const INT_LOAD_ERROR = vitestReport([
  { rel: T.three, status: 'failed', tests: [], message: 'Error: cannot load\n    at x' },
]);
const TESTING_GREEN = vitestReport([
  { rel: T.five, status: 'passed', tests: [{ title: 'five', status: 'passed' }] },
]);

function group(
  name: string,
  exit: string | null,
  seconds: string | null,
  report: string | null,
): Record<string, OutFile> {
  const files: Record<string, OutFile> = {};
  if (exit !== null) files[`${name}.exit`] = { text: `${exit}\n` };
  if (seconds !== null) files[`${name}.seconds`] = { text: `${seconds}\n` };
  if (report !== null) files[`${name}.vitest-report.json`] = { text: report };
  return files;
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

function closingLine(stderr: string): string {
  return stderr.trimEnd().split('\n').at(-1) ?? '';
}

function closingPattern(exit: number, status: string, files: number, tests: number): RegExp {
  return new RegExp(
    `^verify-container: ${ID} run 1 \\(container, tests\\) exit ${String(exit)} \\(${status}: ${String(files)} file\\(s\\), ${String(tests)} test\\(s\\)\\); log: (.+)/${ID}/tests/1/log\\.txt; summary: \\1/${ID}/tests/1/tests\\.json$`,
  );
}

const testsArgs = (repo: string, ...paths: string[]) => [
  ID,
  '--worktree',
  repo,
  '--tests',
  ...paths,
];

// --- arguments ----------------------------------------------------------------------------------------

it(
  '[CT-06zzzzz] --tests needs at least one path: none at the end, or the next argument an option, exits 2 naming --tests',
  () => {
    const ws = sharedWorkspace();
    for (const args of [
      [ID, '--worktree', ws.repo, '--tests'],
      [ID, '--worktree', ws.repo, '--tests', '--dry-run'],
      [ID, '--tests', '--worktree', ws.repo],
    ]) {
      const res = run(args);
      expect(res.status, args.join(' ')).toBe(2);
      expect(res.stderr, args.join(' ')).toContain('--tests');
      // Refused by --tests itself, not as an unknown option.
      expect(res.stderr, args.join(' ')).not.toContain('unknown option');
      expect(res.stdout, args.join(' ')).toBe('');
      expect(res.calls, args.join(' ')).toEqual([]);
    }
    expect(existsSync(join(runs, ID))).toBe(false);
  },
  CLI_TIMEOUT,
);

it(
  '[CT-06zzzzz] --tests: a path that is absolute, has "..", starts with "-", is empty or leaves [A-Za-z0-9_./@-] exits 2 naming --tests, before anything runs',
  () => {
    const ws = sharedWorkspace();
    for (const bad of [
      '/abs/x.test.ts',
      '../x.test.ts',
      'test/../x.test.ts',
      'test/spec/..',
      '-x.test.ts',
      '',
      'test/spec/a b.test.ts',
      'test/spec/名字.test.ts',
      'test/spec/$(id).test.ts',
      'test/spec/a;b.test.ts',
      'test/spec/*.test.ts',
    ]) {
      for (const args of [
        [...testsArgs(ws.repo, T.one, bad), '--dry-run'],
        testsArgs(ws.repo, bad, T.one),
      ]) {
        const res = run(args);
        expect(res.status, `'${bad}'`).toBe(2);
        expect(res.stderr, `'${bad}'`).toContain('--tests');
        expect(res.stderr, `'${bad}'`).not.toContain('unknown option');
        expect(res.stdout, `'${bad}'`).toBe('');
        expect(res.calls, `'${bad}'`).toEqual([]);
      }
    }
    expect(existsSync(join(runs, ID))).toBe(false);
  },
  CLI_TIMEOUT * 4,
);

it(
  '[CT-06zzzzz] --tests takes at most 200 paths: 200 plan, 201 exit 2 naming --tests',
  () => {
    const ws = sharedWorkspace();
    const twoHundred = Array.from({ length: 200 }, () => 'test/spec/alpha');
    const ok = run([...testsArgs(ws.repo, ...twoHundred), '--dry-run']);
    expect(ok.status, ok.stderr).toBe(0);
    // Sorted without duplicates.
    expect((JSON.parse(ok.stdout) as { files: string[] }).files).toEqual([T.one, T.three, T.two]);
    const tooMany = run([...testsArgs(ws.repo, ...twoHundred, T.four), '--dry-run']);
    expect(tooMany.status).toBe(2);
    expect(tooMany.stderr).toContain('--tests');
    expect(tooMany.stdout).toBe('');
    const tooManyReal = run(testsArgs(ws.repo, ...twoHundred, T.four));
    expect(tooManyReal.status).toBe(2);
    expect(tooManyReal.calls).toEqual([]);
    expect(existsSync(join(runs, ID))).toBe(false);
  },
  CLI_TIMEOUT,
);

it(
  '[CT-06zzzzz] --tests together with --fast, --red, --related, --browser or --base is a usage error (either order)',
  () => {
    const ws = sharedWorkspace();
    for (const other of [['--fast'], ['--red'], ['--related'], ['--browser'], ['--base', 'main']]) {
      for (const args of [
        [ID, '--worktree', ws.repo, '--tests', T.one, ...other, '--dry-run'],
        [ID, '--worktree', ws.repo, ...other, '--tests', T.one, '--dry-run'],
        [ID, '--worktree', ws.repo, '--tests', T.one, ...other],
      ]) {
        const res = run(args);
        expect(res.status, args.join(' ')).toBe(2);
        expect(res.stdout, args.join(' ')).toBe('');
        expect(res.stderr, args.join(' ')).toMatch(/^verify-container: /m);
        expect(res.stderr, args.join(' ')).not.toContain('unknown option');
        expect(res.calls, args.join(' ')).toEqual([]);
      }
    }
    expect(existsSync(join(runs, ID))).toBe(false);
  },
  CLI_TIMEOUT * 2,
);

it(
  '[CT-06zzzzz] --tests needs a worktree that is the top of its own git work tree with a commit (exit 2 otherwise)',
  () => {
    const plain = join(base, 'tests-plain');
    writeFiles(plain, {
      'package.json': '{"name":"plain","private":true}\n',
      [T.one]: "it('x', () => {});\n",
    });
    const noCommit = join(base, 'tests-no-commit');
    writeFiles(noCommit, {
      'package.json': '{"name":"none","private":true}\n',
      [T.one]: "it('x', () => {});\n",
    });
    fixtureGit(noCommit, ['init', '-q', '-b', 'main']);
    for (const wt of [plain, noCommit, join(sharedWorkspace().repo, 'test')]) {
      for (const extra of [['--dry-run'], []]) {
        const res = run([ID, '--worktree', wt, '--tests', T.one, ...extra]);
        expect(res.status, `${wt} ${extra.join(' ')}`).toBe(2);
        expect(res.stdout, wt).toBe('');
        expect(res.stderr, wt).toContain('--tests');
        expect(res.stderr, wt).not.toContain('unknown option');
        expect(res.calls, wt).toEqual([]);
      }
    }
    expect(existsSync(join(runs, ID))).toBe(false);
  },
  CLI_TIMEOUT,
);

it(
  '[CT-06zzzzz] the script header and the usage line name --tests',
  () => {
    const header = readFileSync(SCRIPT, 'utf8').split('\nset -')[0] ?? '';
    expect(header).toMatch(/^#.*--tests/m);
    const res = run(['-h']);
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/usage: verify-container\.sh .*--tests/);
  },
  CLI_TIMEOUT,
);

// --- --dry-run: expansion and grouping --------------------------------------------------------------

type DryPlan = {
  script: string;
  commit: string;
  tree: string;
  files: string[];
  plan: { name: string; database: boolean; browser: boolean; files: string[] }[];
};

it(
  '[CT-06zzzzz] --tests --dry-run: directories and files of the snapshot tree (uncommitted and untracked included) expand to their test files, sorted, without duplicates, grouped by red-plan',
  () => {
    const ws = workspace('tests-dry');
    // An untracked new test file, an untracked helper, and an uncommitted change.
    writeFiles(ws.repo, {
      'test/spec/beta/new.test.ts': "it('[AC-T-06] new', () => {});\n",
      'test/spec/beta/util.ts': 'export {};\n',
      [T.one]: "it('[AC-T-01] a changed', () => {});\n",
    });
    const before = porcelain(ws.repo);
    const res = run([
      ...testsArgs(ws.repo, 'test/spec/alpha', T.one, 'test/spec/beta', 'packages/testing'),
      '--dry-run',
    ]);
    expect(res.status, res.stderr).toBe(0);
    const plan = JSON.parse(res.stdout) as DryPlan;
    expect(plan.script).toBe('tests');
    expect(plan.commit).toBe(ws.head);
    expect(plan.tree).toMatch(/^[0-9a-f]{40}$/);
    // The snapshot tree, not HEAD's: the work tree's changes are in it.
    expect(plan.tree).not.toBe(ws.tree);
    expect(plan.files).toEqual([
      T.five,
      T.one,
      T.three,
      T.two,
      T.four,
      'test/spec/beta/new.test.ts',
    ]);
    const byName = new Map(plan.plan.map((g) => [g.name, g]));
    expect([...byName.keys()].sort()).toEqual(['spec-int', 'spec-unit', 'testing-unit']);
    expect(byName.get('spec-unit')).toMatchObject({
      database: false,
      browser: false,
      files: [
        'spec/alpha/one.test.ts',
        'spec/alpha/two.test.ts',
        'spec/beta/four.test.ts',
        'spec/beta/new.test.ts',
      ],
    });
    expect(byName.get('spec-int')).toMatchObject({
      database: true,
      files: ['spec/alpha/three.int.test.ts'],
    });
    expect(byName.get('testing-unit')).toMatchObject({
      database: false,
      files: ['src/five.test.ts'],
    });
    // Nothing started, no run directory, the index and the work tree untouched.
    expect(res.calls).toEqual([]);
    expect(existsSync(join(runs, ID))).toBe(false);
    expect(porcelain(ws.repo)).toBe(before);
    // Not --red's or --related's fields.
    expect(plan).not.toHaveProperty('red_files');
    expect(plan).not.toHaveProperty('test_guard');
    expect(plan).not.toHaveProperty('sources');
  },
  CLI_TIMEOUT,
);

it(
  "[CT-06zzzzz] --tests --dry-run: a single test file is itself; the plan is red-plan's groups",
  () => {
    const ws = sharedWorkspace();
    const res = run([...testsArgs(ws.repo, T.three), '--dry-run']);
    expect(res.status, res.stderr).toBe(0);
    const plan = JSON.parse(res.stdout) as DryPlan;
    expect(plan).toMatchObject({
      script: 'tests',
      commit: ws.head,
      tree: ws.tree,
      files: [T.three],
    });
    expect(plan.plan).toEqual([
      {
        name: 'spec-int',
        dir: 'test',
        config: 'vitest.integration.config.ts',
        database: true,
        browser: false,
        files: ['spec/alpha/three.int.test.ts'],
      },
    ]);
  },
  CLI_TIMEOUT,
);

it(
  '[CT-06zzzzz] --tests: a path that is not in the snapshot tree exits 2 naming it',
  () => {
    const ws = sharedWorkspace();
    for (const missing of ['test/spec/nope', 'test/spec/alpha/nope.test.ts', 'test/spec/alph']) {
      for (const extra of [['--dry-run'], []]) {
        const res = run([...testsArgs(ws.repo, T.one, missing), ...extra]);
        expect(res.status, missing).toBe(2);
        expect(res.stderr, missing).toContain(missing);
        expect(res.stdout, missing).toBe('');
        expect(
          res.calls.filter((c) => c.args[0] === 'run'),
          missing,
        ).toEqual([]);
      }
    }
    // A git-ignored or never-added path is not in the tree either: an ignored test file.
    const ws2 = workspace('tests-ignored');
    writeFiles(ws2.repo, {
      '.gitignore': 'test/spec/ignored/\n',
      'test/spec/ignored/x.test.ts': "it('x', () => {});\n",
    });
    const ignored = run([...testsArgs(ws2.repo, 'test/spec/ignored'), '--dry-run']);
    expect(ignored.status).toBe(2);
    expect(ignored.stderr).toContain('test/spec/ignored');
  },
  CLI_TIMEOUT * 2,
);

it(
  '[CT-06zzzzz] --tests: a path that holds no *.test.ts / *.test.tsx file exits 2 naming it',
  () => {
    const ws = sharedWorkspace();
    for (const empty of [T.helper, 'test/spec/fixtures', T.data, 'docs']) {
      const res = run([...testsArgs(ws.repo, T.one, empty), '--dry-run']);
      expect(res.status, empty).toBe(2);
      expect(res.stderr, empty).toContain(empty);
      expect(res.stdout, empty).toBe('');
    }
  },
  CLI_TIMEOUT,
);

it(
  '[CT-06zzzzz] --tests: a test file no project of tests-projects.json takes (infra/…) exits 2 listing it',
  () => {
    const ws = sharedWorkspace();
    for (const extra of [['--dry-run'], []]) {
      const res = run([...testsArgs(ws.repo, T.one, T.infra), ...extra]);
      expect(res.status).toBe(2);
      expect(res.stderr).toContain(T.infra);
      expect(res.stdout).toBe('');
      expect(res.calls.filter((c) => c.args[0] === 'run')).toEqual([]);
    }
    // Through a directory as well.
    const dir = run([...testsArgs(ws.repo, 'infra'), '--dry-run']);
    expect(dir.status).toBe(2);
    expect(dir.stderr).toContain(T.infra);
  },
  CLI_TIMEOUT,
);

it(
  '[CT-06zzzzz] --tests: a browser test (*.browser.test.tsx, project browser: true) exits 2 pointing to --browser',
  () => {
    const ws = sharedWorkspace();
    for (const args of [
      [...testsArgs(ws.repo, T.page), '--dry-run'],
      [...testsArgs(ws.repo, T.one, 'test/spec/ui'), '--dry-run'],
      testsArgs(ws.repo, T.page),
    ]) {
      const res = run(args);
      expect(res.status, args.join(' ')).toBe(2);
      expect(res.stderr, args.join(' ')).toContain('--browser');
      expect(res.stdout, args.join(' ')).toBe('');
      expect(res.calls.filter((c) => c.args[0] === 'run')).toEqual([]);
    }
  },
  CLI_TIMEOUT,
);

// --- real runs against the stub docker --------------------------------------------------------------

it(
  '[CT-06zzzzz] --tests, unit tests only, green: one --network none container without database URLs, mounting only /src, /store, /out; tests.json, no result.json, the closing line',
  async () => {
    const ws = sharedWorkspace();
    const runsDir = join(base, 'r-unit-green');
    const res = await runStubbed(testsArgs(ws.repo, T.one, T.two), runsDir, {
      exit: 0,
      files: group('spec-unit', '0', '5', UNIT_GREEN),
    });
    expect(res.timedOut).toBe(false);
    expect(res.status, res.stderr).toBe(0);

    const containers = testContainers(res.calls);
    expect(containers).toHaveLength(1);
    const c = containers[0] as DockerCall;
    expectIsolated(c);
    expectOffline(c);
    // No services for unit tests.
    expect(res.calls.some((x) => x.args[0] === 'network' && x.args[1] === 'create')).toBe(false);
    expect(res.calls.some((x) => x.args[0] === 'run' && x.args.includes('-d'))).toBe(false);
    // The --tests mode runs neither test-guard nor red-check.
    expect(res.stderr).not.toContain('test-guard');
    expect(res.stderr).not.toContain('red-check');

    const vdir = join(realpathSync(runsDir), ID, 'tests', '1');
    expect(
      readFileSync(join(vdir, 'files.txt'), 'utf8')
        .split('\n')
        .filter((l) => l !== ''),
    ).toEqual([T.one, T.two]);
    expect(
      ((readJson(join(vdir, 'plan.json'))['groups'] as { name: string }[] | undefined) ?? []).map(
        (g) => g.name,
      ),
    ).toEqual(['spec-unit']);
    expect(existsSync(join(vdir, 'log.txt'))).toBe(true);
    expect(statSync(join(vdir, 'out')).mode & 0o7777).toBe(0o1733);
    // Never evidence: no result.json, and nothing left half-written.
    expect(existsSync(join(vdir, 'result.json'))).toBe(false);
    expect(readdirSync(vdir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    const summary = readJson(join(vdir, 'tests.json'));
    expect(summary).toMatchObject({
      status: 'green',
      files: 2,
      tests: 3,
      duration_s: 5,
      failed: [],
      load_errors: [],
      commit: ws.head,
      tree: ws.tree,
      paths: [T.one, T.two],
    });
    expect(summary['groups']).toEqual([
      {
        name: 'spec-unit',
        database: false,
        files: 2,
        tests: 3,
        exit: 0,
        duration_s: 5,
        failed: [],
        load_errors: [],
        status: 'green',
      },
    ]);
    expect(closingLine(res.stderr)).toMatch(closingPattern(0, 'green', 2, 3));
  },
  JUDGE_TIMEOUT,
);

it(
  '[CT-06zzzzz] --tests, integration tests only: the one-shot PostgreSQL and Redis on the internal network; the container on that network with TEST_PG_ADMIN_URL and TEST_REDIS_URL only',
  async () => {
    const ws = sharedWorkspace();
    const runsDir = join(base, 'r-int-green');
    const res = await runStubbed(testsArgs(ws.repo, T.three), runsDir, {
      exit: 0,
      files: group('spec-int', '0', '7', INT_GREEN),
    });
    expect(res.timedOut).toBe(false);
    expect(res.status, res.stderr).toBe(0);
    const create = res.calls.find((x) => x.args[0] === 'network' && x.args[1] === 'create');
    expect(create, JSON.stringify(res.calls.map((x) => x.args.slice(0, 2)))).toBeDefined();
    expect(create?.args).toContain('--internal');
    const net = create?.args.at(-1) ?? '';
    // PostgreSQL and Redis start on that network.
    const services = res.calls.filter((x) => x.args[0] === 'run' && x.args.includes('-d'));
    expect(services).toHaveLength(2);
    for (const s of services) expect(valueAfter(s.args, '--network')).toBe(net);

    const containers = testContainers(res.calls);
    expect(containers).toHaveLength(1);
    const c = containers[0] as DockerCall;
    expectIsolated(c);
    expect(valueAfter(c.args, '--network')).toBe(net);
    expect(c.env['TEST_PG_ADMIN_URL']).toMatch(/^postgres:\/\/postgres:[^@\s]+@pg:5432\/postgres$/);
    expect(c.env['TEST_REDIS_URL']).toBe('redis://redis:6379/0');
    // The only database addresses it gets.
    const urls = Object.entries(c.env).filter(([, v]) => /^(postgres|redis):\/\//.test(v ?? ''));
    expect(urls.map(([k]) => k).sort()).toEqual(['TEST_PG_ADMIN_URL', 'TEST_REDIS_URL']);

    const vdir = join(realpathSync(runsDir), ID, 'tests', '1');
    expect(existsSync(join(vdir, 'result.json'))).toBe(false);
    const summary = readJson(join(vdir, 'tests.json'));
    expect(summary).toMatchObject({ status: 'green', files: 1, tests: 1, paths: [T.three] });
    expect(summary['groups']).toMatchObject([{ name: 'spec-int', database: true, exit: 0 }]);
    // The one-shot password stays out of tests.json.
    const password = /^postgres:\/\/postgres:([^@]+)@/.exec(c.env['TEST_PG_ADMIN_URL'] ?? '')?.[1];
    expect(password).toBeTruthy();
    expect(readFileSync(join(vdir, 'tests.json'), 'utf8')).not.toContain(password ?? '');
    expect(closingLine(res.stderr)).toMatch(closingPattern(0, 'green', 1, 1));
  },
  JUDGE_TIMEOUT,
);

it(
  '[CT-06zzzzz] --tests, unit and integration groups: two containers — the database one on the internal network, the other still --network none; both get COULI_VERIFY_MEMORY',
  async () => {
    const ws = sharedWorkspace();
    const runsDir = join(base, 'r-both-green');
    const res = await runStubbed(
      testsArgs(ws.repo, 'test/spec/alpha', T.five),
      runsDir,
      {
        exit: 0,
        files: {
          ...group('spec-unit', '0', '5', UNIT_GREEN),
          ...group('spec-int', '0', '7', INT_GREEN),
          ...group('testing-unit', '0', '3', TESTING_GREEN),
        },
      },
      { env: { COULI_VERIFY_MEMORY: '9g' } },
    );
    expect(res.timedOut).toBe(false);
    expect(res.status, res.stderr).toBe(0);
    const net =
      res.calls.find((x) => x.args[0] === 'network' && x.args[1] === 'create')?.args.at(-1) ?? '';
    expect(net).not.toBe('');
    const containers = testContainers(res.calls);
    expect(containers).toHaveLength(2);
    const db = containers.filter((c) => valueAfter(c.args, '--network') === net);
    const offline = containers.filter((c) => valueAfter(c.args, '--network') === 'none');
    expect(db).toHaveLength(1);
    expect(offline).toHaveLength(1);
    for (const c of containers) {
      expectIsolated(c);
      expect(hasPair(c.args, '--memory', '9g'), c.args.join(' ')).toBe(true);
      expect(hasPair(c.args, '--memory-swap', '9g'), c.args.join(' ')).toBe(true);
    }
    expectOffline(offline[0] as DockerCall);
    expect(db[0]?.env['TEST_PG_ADMIN_URL']).toMatch(/^postgres:\/\//);

    const vdir = join(realpathSync(runsDir), ID, 'tests', '1');
    const summary = readJson(join(vdir, 'tests.json'));
    expect(summary).toMatchObject({
      status: 'green',
      files: 4,
      tests: 5,
      duration_s: 15,
      failed: [],
      load_errors: [],
      paths: ['test/spec/alpha', T.five],
    });
    const groups = (summary['groups'] as { name: string; database: boolean }[] | undefined) ?? [];
    expect(groups.map((g) => [g.name, g.database]).sort()).toEqual([
      ['spec-int', true],
      ['spec-unit', false],
      ['testing-unit', false],
    ]);
    expect(
      readFileSync(join(vdir, 'files.txt'), 'utf8')
        .split('\n')
        .filter((l) => l !== ''),
    ).toEqual([T.five, T.one, T.three, T.two]);
    expect(existsSync(join(vdir, 'result.json'))).toBe(false);
    expect(closingLine(res.stderr)).toMatch(closingPattern(0, 'green', 4, 5));
  },
  JUDGE_TIMEOUT,
);

it(
  '[CT-06zzzzz] --tests red: exit 1, every red test on stdout as "file > full name" and the load-error file, the same in log.txt; tests.json red; still no result.json',
  async () => {
    const ws = sharedWorkspace();
    const runsDir = join(base, 'r-red');
    const res = await runStubbed(testsArgs(ws.repo, 'test/spec/alpha'), runsDir, {
      exit: 0,
      files: {
        ...group('spec-unit', '1', '5', UNIT_RED),
        ...group('spec-int', '1', '7', INT_LOAD_ERROR),
      },
    });
    expect(res.timedOut).toBe(false);
    expect(res.status, res.stderr).toBe(1);
    const lines = res.stdout.split('\n');
    expect(lines).toContain(`${T.one} > one > [AC-T-01] a`);
    expect(lines.filter((l) => l.startsWith(T.three))).toHaveLength(1);
    expect(res.stdout).toContain('cannot load');
    expect(res.stdout).not.toContain('[AC-T-01] b');
    const vdir = join(realpathSync(runsDir), ID, 'tests', '1');
    const log = readFileSync(join(vdir, 'log.txt'), 'utf8');
    expect(log).toContain(`${T.one} > one > [AC-T-01] a`);
    const summary = readJson(join(vdir, 'tests.json'));
    expect(summary).toMatchObject({
      status: 'red',
      files: 3,
      tests: 3,
      failed: [{ file: T.one, test: 'one > [AC-T-01] a' }],
      load_errors: [{ file: T.three, message: 'Error: cannot load' }],
      commit: ws.head,
      tree: ws.tree,
      paths: ['test/spec/alpha'],
    });
    expect(existsSync(join(vdir, 'result.json'))).toBe(false);
    expect(closingLine(res.stderr)).toMatch(closingPattern(1, 'red', 3, 3));
  },
  JUDGE_TIMEOUT,
);

it(
  '[CT-06zzzzz] --tests does not take the verify slot: another run holding it does not hold this one up',
  async () => {
    const ws = sharedWorkspace();
    const runsDir = join(base, 'r-slot');
    const lock = join(runsDir, 'slot', 'slot.lock');
    mkdirSync(lock, { recursive: true });
    const owner = `pid=${String(process.pid)}\ntask=OTHER-1\nmode=verify:fast\nstarted_at=2026-11-12T00:00:00Z\ntoken=${OTHER_HOLDER_ID}\n`;
    writeFileSync(join(lock, 'owner'), owner);
    const res = await runStubbed(
      testsArgs(ws.repo, T.one, T.two),
      runsDir,
      { exit: 0, files: group('spec-unit', '0', '5', UNIT_GREEN) },
      { env: { COULI_VERIFY_SLOT_WAIT_SECS: '1' }, limitMs: 30_000 },
    );
    expect(res.timedOut).toBe(false);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stderr).not.toContain('verify slot');
    expect(readFileSync(join(lock, 'owner'), 'utf8')).toBe(owner);
    expect(existsSync(join(realpathSync(runsDir), ID, 'tests', '1', 'tests.json'))).toBe(true);
  },
  JUDGE_TIMEOUT,
);

// Exit 2, no tests.json and no result.json: nothing trustworthy came out of the container. Each case
// names the text it must print (verify-container's own, or the first lines of tests-report's).
const outsideDir = () => join(base, 'outside');
const ENV_ERRORS: {
  what: string;
  spec: () => ContainerSpec;
  messages: RegExp[];
  limitMs?: number;
}[] = [
  {
    what: 'the container exits non-zero',
    spec: () => ({ exit: 3, files: group('spec-unit', '0', '5', UNIT_GREEN) }),
    messages: [/exit 3\b/],
  },
  {
    what: 'spec-unit.exit is missing',
    spec: () => ({ exit: 0, files: group('spec-unit', null, '5', UNIT_GREEN) }),
    messages: [/spec-unit\.exit/],
  },
  {
    what: 'spec-unit.seconds is missing',
    spec: () => ({ exit: 0, files: group('spec-unit', '0', null, UNIT_GREEN) }),
    messages: [/spec-unit\.seconds/],
  },
  {
    what: 'spec-unit.exit is 124 (time limit)',
    spec: () => ({ exit: 0, files: group('spec-unit', '124', '600', UNIT_GREEN) }),
    messages: [/spec-unit/, /time limit|timed out/i],
  },
  {
    what: 'spec-unit.exit is 124 and its report has a red test (the time limit wins)',
    spec: () => ({ exit: 0, files: group('spec-unit', '124', '600', UNIT_RED) }),
    messages: [/spec-unit/, /time limit|timed out/i],
  },
  {
    what: 'spec-unit.exit is not a number (abc)',
    spec: () => ({ exit: 0, files: group('spec-unit', 'abc', '5', UNIT_GREEN) }),
    messages: [/spec-unit\.exit/],
  },
  {
    what: 'spec-unit.exit is a symbolic link (to a file that says 0)',
    spec: () => {
      writeFiles(outsideDir(), { 'exit-zero': '0\n' });
      const files = group('spec-unit', '0', '5', UNIT_GREEN);
      files['spec-unit.exit'] = { symlink: join(outsideDir(), 'exit-zero') };
      return { exit: 0, files };
    },
    messages: [/spec-unit\.exit/],
  },
  {
    what: 'spec-unit.exit is a FIFO (the host must not hang)',
    limitMs: 30_000,
    spec: () => {
      const files = group('spec-unit', '0', '5', UNIT_GREEN);
      files['spec-unit.exit'] = { fifo: true };
      return { exit: 0, files };
    },
    messages: [/spec-unit\.exit/],
  },
  {
    what: 'spec-unit.exit is a directory',
    spec: () => {
      const files = group('spec-unit', '0', '5', UNIT_GREEN);
      files['spec-unit.exit'] = { dir: true };
      return { exit: 0, files };
    },
    messages: [/spec-unit\.exit/],
  },
  {
    what: 'the report is missing',
    spec: () => ({ exit: 0, files: group('spec-unit', '0', '5', null) }),
    messages: [/spec-unit\.vitest-report\.json/],
  },
  {
    what: 'the report is a symbolic link (to a green report)',
    spec: () => {
      writeFiles(outsideDir(), { 'green.json': UNIT_GREEN });
      const files = group('spec-unit', '0', '5', null);
      files['spec-unit.vitest-report.json'] = { symlink: join(outsideDir(), 'green.json') };
      return { exit: 0, files };
    },
    messages: [/spec-unit\.vitest-report\.json/],
  },
  {
    what: 'the report is not the expected shape',
    spec: () => ({ exit: 0, files: group('spec-unit', '1', '5', '{"testResults":"x"}') }),
    messages: [/testResults/],
  },
  {
    what: 'Vitest exited 7 but the report has nothing red',
    spec: () => ({ exit: 0, files: group('spec-unit', '7', '5', UNIT_GREEN) }),
    messages: [/spec-unit/, /\b7\b/],
  },
];

ENV_ERRORS.forEach((c, i) => {
  it(
    `[CT-06zzzzz] --tests: ${c.what} → exit 2, no tests.json, no result.json, its own message`,
    async () => {
      const ws = sharedWorkspace();
      const runsDir = join(base, `r-env-${String(i)}`);
      const res = await runStubbed(testsArgs(ws.repo, T.one, T.two), runsDir, c.spec(), {
        limitMs: c.limitMs,
      });
      expect(res.timedOut, 'the run hung and was killed').toBe(false);
      expect(res.status, res.stderr).toBe(2);
      for (const m of c.messages) expect(res.stderr).toMatch(m);
      // The test container did run (the error is about what it left behind).
      expect(testContainers(res.calls)).toHaveLength(1);
      const vdir = join(realpathSync(runsDir), ID, 'tests', '1');
      expect(existsSync(join(vdir, 'tests.json'))).toBe(false);
      expect(existsSync(join(vdir, 'result.json'))).toBe(false);
      // No closing line with a verdict.
      expect(closingLine(res.stderr)).not.toMatch(/\(container, tests\) exit [01]\b/);
    },
    JUDGE_TIMEOUT,
  );
});

it(
  '[CT-06zzzzz] --tests without Docker stops with exit 2 and no tests.json',
  async () => {
    const ws = sharedWorkspace();
    const runsDir = join(base, 'r-no-docker');
    const res = await runStubbed(testsArgs(ws.repo, T.one), runsDir, null, {
      env: { STUB_DOCKER_DOWN: '1' },
    });
    expect(res.timedOut).toBe(false);
    expect(res.status).toBe(2);
    expect(res.stderr).not.toContain('unknown option');
    // It got as far as asking Docker.
    expect(res.calls.some((c) => c.args[0] === 'version')).toBe(true);
    expect(res.stderr).toMatch(/Docker is not available/);
    expect(testContainers(res.calls)).toEqual([]);
    const vdir = join(runsDir, ID, 'tests', '1');
    expect(existsSync(join(vdir, 'tests.json'))).toBe(false);
    expect(existsSync(join(vdir, 'result.json'))).toBe(false);
  },
  JUDGE_TIMEOUT,
);

// --- documentation ------------------------------------------------------------------------------------

it('[CT-06zzzzz] tools/ops/README.md documents --tests, tests-report.ts and tests.json, that it is no gate, and the test machine entry', () => {
  const readme = readFileSync(join(OPS_DIR, 'README.md'), 'utf8');
  for (const word of [
    '--tests',
    'tests-report.ts',
    'tests.json',
    '指定测试',
    '不是门禁',
    'scripts/test-run.sh',
  ]) {
    expect(readme, word).toContain(word);
  }
});

// --- supplement: --tests plans with tests-projects.json (package unit and integration tests) ----------

type Group = {
  name: string;
  dir: string;
  config: string;
  database: boolean;
  browser: boolean;
  files: string[];
};

it(
  '[CT-06zzzzz] --tests --dry-run plans with tests-projects.json: apps/api unit and integration files, tools files; red-projects.json groups unchanged',
  () => {
    const ws = sharedWorkspace();
    const res = run([...testsArgs(ws.repo, 'apps/api/src', 'tools', T.one, T.three), '--dry-run']);
    expect(res.status, res.stderr).toBe(0);
    const plan = JSON.parse(res.stdout) as { files: string[]; plan: Group[] };
    expect(plan.files).toEqual([T.app, T.apiInt, T.apiUnit, T.one, T.three, T.tool].sort());
    const at = (dir: string, config: string) =>
      plan.plan.find((g) => g.dir === dir && g.config === config);
    expect(at('apps/api', 'vitest.config.ts')).toMatchObject({
      database: false,
      browser: false,
      files: ['src/modules/x/x.test.ts', 'src/six.test.ts'],
    });
    expect(at('apps/api', 'vitest.integration.config.ts')).toMatchObject({
      database: true,
      browser: false,
      files: ['src/modules/x/x.int.test.ts'],
    });
    expect(at('tools', 'vitest.config.ts')).toMatchObject({
      database: false,
      files: ['ops/y.test.ts'],
    });
    expect(at('test', 'vitest.config.ts')).toMatchObject({
      name: 'spec-unit',
      files: ['spec/alpha/one.test.ts'],
    });
    expect(at('test', 'vitest.integration.config.ts')).toMatchObject({
      name: 'spec-int',
      database: true,
      files: ['spec/alpha/three.int.test.ts'],
    });
    expect(plan.plan).toHaveLength(5);
    // Exactly what red-plan makes of that list with the trusted tests-projects.json.
    expect(plan.plan).toEqual(planRed(plan.files, loadRedProjects(TESTS_TABLE)).groups);
    expect(res.calls).toEqual([]);
  },
  CLI_TIMEOUT,
);

it(
  '[CT-06zzzzz] --tests: a single apps/api integration file is a database group; a single tools file a unit group',
  () => {
    const ws = sharedWorkspace();
    const int = run([...testsArgs(ws.repo, T.apiInt), '--dry-run']);
    expect(int.status, int.stderr).toBe(0);
    expect((JSON.parse(int.stdout) as { plan: Group[] }).plan).toMatchObject([
      {
        dir: 'apps/api',
        config: 'vitest.integration.config.ts',
        database: true,
        browser: false,
        files: ['src/modules/x/x.int.test.ts'],
      },
    ]);
    const tool = run([...testsArgs(ws.repo, T.tool), '--dry-run']);
    expect(tool.status, tool.stderr).toBe(0);
    expect((JSON.parse(tool.stdout) as { plan: Group[] }).plan).toMatchObject([
      { dir: 'tools', config: 'vitest.config.ts', database: false, files: ['ops/y.test.ts'] },
    ]);
  },
  CLI_TIMEOUT,
);

it(
  '[CT-06zzzzz] --tests on apps/api unit + integration and tools: the integration group in the database container on the internal network, the unit groups in the --network none one; green tests.json',
  async () => {
    const ws = sharedWorkspace();
    const runsDir = join(base, 'r-packages');
    const res = await runStubbed(testsArgs(ws.repo, 'apps/api/src/modules/x', T.tool), runsDir, {
      exit: 0,
      files: {},
      auto: true,
    });
    expect(res.timedOut).toBe(false);
    expect(res.status, res.stderr).toBe(0);
    const net =
      res.calls.find((x) => x.args[0] === 'network' && x.args[1] === 'create')?.args.at(-1) ?? '';
    expect(net).not.toBe('');
    const containers = testContainers(res.calls);
    expect(containers).toHaveLength(2);
    const db = containers.find((c) => valueAfter(c.args, '--network') === net);
    const offline = containers.find((c) => valueAfter(c.args, '--network') === 'none');
    expect(db).toBeDefined();
    expect(offline).toBeDefined();
    for (const c of containers) expectIsolated(c);
    expectOffline(offline as DockerCall);
    expect(db?.env['TEST_PG_ADMIN_URL']).toMatch(/^postgres:\/\//);

    const vdir = join(realpathSync(runsDir), ID, 'tests', '1');
    const plan = readJson(join(vdir, 'plan.json')) as { groups?: Group[] };
    expect(plan.groups).toEqual(
      planRed([T.apiInt, T.apiUnit, T.tool], loadRedProjects(TESTS_TABLE)).groups,
    );
    const summary = readJson(join(vdir, 'tests.json'));
    expect(summary).toMatchObject({
      status: 'green',
      files: 3,
      tests: 3,
      duration_s: 6,
      failed: [],
      load_errors: [],
      paths: ['apps/api/src/modules/x', T.tool],
    });
    const groups = (summary['groups'] as { database: boolean; files: number }[] | undefined) ?? [];
    expect(groups.map((g) => [g.database, g.files]).sort()).toEqual([
      [false, 1],
      [false, 1],
      [true, 1],
    ]);
    expect(existsSync(join(vdir, 'result.json'))).toBe(false);
    expect(closingLine(res.stderr)).toMatch(closingPattern(0, 'green', 3, 3));
  },
  JUDGE_TIMEOUT,
);
