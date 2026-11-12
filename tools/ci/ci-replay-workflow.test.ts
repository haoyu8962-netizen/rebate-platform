// CT-06zzzzza (D10-1372, QA-03 prerequisite): the replay tests get a CI job of their own,
// verify-replay, read from the real .github/workflows/ci.yml.
//
// Pinned here:
//   1. verify-replay runs `test:replay` (the test/package.json script, through pnpm), once, and no
//      other job runs it. It has the integration set-up of verify-int-1: a Docker runner
//      (ubuntu-latest; Testcontainers starts the one-shot PostgreSQL), the same Redis service, the
//      same "Configure the one-shot Redis" step before the tests, TEST_REDIS_URL on the test step,
//      install before the tests. It needs no verify-int job, so it runs beside them.
//   1a. (D10-1389) test/vitest.replay.config.ts keeps passWithNoTests false, so verify-replay first
//      checks whether test/replay holds any *.test.ts file (at any depth). None: the check prints a
//      GitHub notice and the test:replay step is skipped (job green, "no scenarios" visible). Some:
//      test:replay runs. The test step is gated on the check's output; the check's script is taken
//      from ci.yml and run in fixture checkouts under .tmp/ (README.md, provenance.json and other
//      non-*.test.ts files count as none; a *.test.ts outside test/replay does not count).
//   2. It is not required (yet): ci-gate neither needs nor judges it, and ci-gate's needs and
//      Summarise are as on main. verify-reuse's two job lists (push path, label path) are as on
//      main: the sixteen verify jobs, without verify-replay (reuse and its judgement unchanged).
//
// The line-based YAML helpers are those of ci-int-shards-workflow.test.ts (no YAML dependency).
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { afterAll, expect, it } from 'vitest';

const REPO = resolve(import.meta.dirname, '../..');
const CI = readFileSync(join(REPO, '.github/workflows/ci.yml'), 'utf8');
const LINES = CI.split('\n');
const SCRATCH = join(REPO, '.tmp', `ci-replay-workflow-${process.pid}`);
afterAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
});

const JOB = 'verify-replay';
/** A reference integration job: verify-replay copies its services and Redis set-up. */
const REF = 'verify-int-1';

/** The sixteen verify jobs of main (verify-reuse's lists, ci-gate's needs). */
const VERIFY_JOBS = [
  'verify-static',
  'verify-unit',
  'verify-spec-1',
  'verify-spec-2',
  'verify-props-1',
  'verify-props-2',
  'verify-props-3',
  'verify-props-sha-1',
  'verify-props-sha-2',
  'verify-props-sha-3',
  'verify-int-1',
  'verify-int-2',
  'verify-int-3',
  'verify-int-4',
  'verify-int-5',
  'verify-int-6',
];
/** ci-gate's needs on main, in file order. */
const MAIN_GATE_NEEDS = [...VERIFY_JOBS, 'guard-git', 'verify-reuse', 'ledger-only-detect'];
/** The env names of ci-gate's Summarise on main. */
const MAIN_SUMMARISE_ENV = [
  'STATIC',
  'UNIT',
  'SPEC1',
  'SPEC2',
  'PROPS1',
  'PROPS2',
  'PROPS3',
  'PROPSSHA1',
  'PROPSSHA2',
  'PROPSSHA3',
  'INT1',
  'INT2',
  'INT3',
  'INT4',
  'INT5',
  'INT6',
  'GUARD',
  'REUSE_RESULT',
  'REUSE',
  'EVENT',
  'LEDGER_RESULT',
  'LEDGER_ONLY',
];

// --- line-based YAML helpers (as in ci-concurrency-workflow.test.ts) ----------------------------

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function isBlankOrComment(line: string): boolean {
  const t = line.trim();
  return t === '' || t.startsWith('#');
}

/** Removes a trailing ` # comment` and surrounding quotes from a scalar value. */
function scalar(value: string): string {
  const withoutComment = value.replace(/\s+#.*$/, '').trim();
  const single = /^'(.*)'$/.exec(withoutComment);
  if (single) return (single[1] ?? '').replace(/''/g, "'");
  const double = /^"(.*)"$/.exec(withoutComment);
  return double ? (double[1] ?? '') : withoutComment;
}

/** Every job id under `jobs:`, in file order. */
function jobIds(): string[] {
  const jobsAt = LINES.findIndex((l) => l === 'jobs:');
  expect(jobsAt, 'ci.yml has jobs').toBeGreaterThanOrEqual(0);
  const ids: string[] = [];
  for (const l of LINES.slice(jobsAt + 1)) {
    const m = /^ {2}([A-Za-z0-9_-]+):\s*(#.*)?$/.exec(l);
    if (m) ids.push(m[1] ?? '');
  }
  return ids;
}

/** The lines of the job `id` (without its id line), or null when there is no such job. */
function jobBody(id: string): string[] | null {
  const jobsAt = LINES.findIndex((l) => l === 'jobs:');
  if (jobsAt < 0) return null;
  const at = LINES.findIndex(
    (l, i) => i > jobsAt && new RegExp(`^ {2}${id.replace(/[-]/g, '\\-')}:\\s*(#.*)?$`).test(l),
  );
  if (at < 0) return null;
  const body: string[] = [];
  for (let i = at + 1; i < LINES.length; i++) {
    const line = LINES[i] ?? '';
    if (!isBlankOrComment(line) && indentOf(line) <= 2) break;
    body.push(line);
  }
  return body;
}

function requireJob(id: string): string[] {
  const body = jobBody(id);
  expect(body, `ci.yml has a job \`${id}\``).not.toBeNull();
  return body ?? [];
}

type Entry = { inline: string; block: string[] };

/** Key `key` at indentation `indent` within `lines`: its inline value and its block lines. */
function entry(lines: string[], key: string, indent: number): Entry | null {
  const re = new RegExp(`^ {${String(indent)}}${key.replace(/[-]/g, '\\-')}:(\\s.*)?$`);
  const at = lines.findIndex((l) => re.test(l));
  if (at < 0) return null;
  const line = lines[at] ?? '';
  const inline = line.slice(line.indexOf(':') + 1).trim();
  const block: string[] = [];
  for (let i = at + 1; i < lines.length; i++) {
    const l = lines[i] ?? '';
    if (l.trim() !== '' && indentOf(l) <= indent) break;
    block.push(l);
  }
  while (block.length > 0 && (block[block.length - 1] ?? '').trim() === '') block.pop();
  return { inline, block };
}

/** A block scalar (`|`, `>-`, ...) as text, de-indented; a folded one is joined with spaces. */
function blockText(e: Entry): string {
  const nonBlank = e.block.filter((l) => l.trim() !== '');
  const indent = Math.min(...nonBlank.map(indentOf));
  const lines = e.block.map((l) => l.slice(indent));
  if (e.inline.startsWith('>'))
    return lines
      .map((l) => l.trim())
      .filter(Boolean)
      .join(' ');
  return lines.join('\n');
}

function value(e: Entry): string {
  if (/^[|>][-+]?\s*(#.*)?$/.test(e.inline)) return blockText(e);
  return scalar(e.inline);
}

function mapping(e: Entry | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (e === null) return out;
  const indent = Math.min(...e.block.filter((l) => !isBlankOrComment(l)).map(indentOf));
  for (const l of e.block) {
    if (isBlankOrComment(l) || indentOf(l) !== indent) continue;
    const m = /^\s*([A-Za-z0-9_-]+):\s*(.*)$/.exec(l);
    if (m) out[m[1] ?? ''] = scalar(m[2] ?? '');
  }
  return out;
}

/** The `- name` items of a block list (e.g. `needs:` written one per line). */
function listItems(e: Entry | null): string[] {
  if (e === null) return [];
  if (e.inline.startsWith('['))
    return e.inline
      .replace(/^\[|\]$/g, '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  return e.block
    .map((l) => l.trim())
    .filter((l) => l.startsWith('- '))
    .map((l) => scalar(l.slice(2)));
}

type Step = {
  id: string | null;
  name: string | null;
  if: string | null;
  uses: string | null;
  run: string | null;
  env: Record<string, string>;
  with: Record<string, string>;
};

/** The steps of a job, each a small record of the keys this test needs. */
function steps(id: string): Step[] {
  const body = requireJob(id);
  const at = body.findIndex((l) => /^ {4}steps:\s*$/.test(l));
  expect(at, `job \`${id}\` has steps`).toBeGreaterThanOrEqual(0);
  const items: string[][] = [];
  for (const line of body.slice(at + 1)) {
    if (/^ {6}- /.test(line)) items.push([line.replace(/^ {6}- /, '        ')]);
    else if (items.length > 0 && (line.trim() === '' || indentOf(line) >= 8)) {
      items[items.length - 1]?.push(line);
    } else if (items.length > 0 && !isBlankOrComment(line) && indentOf(line) <= 4) break;
  }
  return items.map((lines) => {
    const get = (key: string): string | null => {
      const e = entry(lines, key, 8);
      return e === null ? null : value(e);
    };
    return {
      id: get('id'),
      name: get('name'),
      if: get('if'),
      uses: get('uses'),
      run: get('run'),
      env: mapping(entry(lines, 'env', 8)),
      with: mapping(entry(lines, 'with', 8)),
    };
  });
}

/** The non-comment command lines of a run script. */
function commandLines(run: string | null): string[] {
  return (run ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'));
}

/** Every command line of every job that runs the test:replay script, with its job and step env. */
function replayRuns(): { job: string; command: string; env: Record<string, string> }[] {
  const out: { job: string; command: string; env: Record<string, string> }[] = [];
  for (const job of jobIds()) {
    const body = jobBody(job) ?? [];
    if (!body.some((l) => /^ {4}steps:\s*$/.test(l))) continue;
    for (const s of steps(job))
      for (const command of commandLines(s.run))
        if (/\btest:replay\b/.test(command)) out.push({ job, command, env: s.env });
  }
  return out;
}

/** The `services:` block of a job, as lines. */
function services(id: string): string[] {
  const e = entry(requireJob(id), 'services', 4);
  expect(e, `job \`${id}\` has services`).not.toBeNull();
  return e?.block ?? [];
}

// --- 1. the job ---------------------------------------------------------------------------------

it('[CT-06zzzzza] ci.yml has a job verify-replay', () => {
  expect(jobIds()).toContain(JOB);
  expect(jobIds().filter((id) => id === JOB)).toHaveLength(1);
});

it('[CT-06zzzzza] verify-replay runs test:replay through pnpm exactly once, and no other job runs it', () => {
  const runs = replayRuns();
  expect(
    runs.map((r) => r.job),
    'test:replay runs in verify-replay only, once',
  ).toEqual([JOB]);
  const command = runs[0]?.command ?? '';
  // `pnpm test:replay …`, `pnpm run test:replay …` or `pnpm --filter @couli/spec-tests run
  // test:replay …`: the script of test/package.json, not a hand-written vitest command.
  expect(command).toMatch(/^pnpm\s(?:.*\s)?(?:run\s)?test:replay\b/);
  expect(command).not.toMatch(/--shard\b/);
  expect(command).not.toMatch(/\btest:int\b/);
});

it('[CT-06zzzzza] verify-replay runs on a Docker runner as the int jobs: ubuntu-latest, never ubuntu-slim, with a time limit', () => {
  const body = requireJob(JOB);
  const runsOn = entry(body, 'runs-on', 4)?.inline;
  expect(runsOn).toBe(entry(requireJob(REF), 'runs-on', 4)?.inline);
  expect(runsOn).toBe('ubuntu-latest');
  expect(Number(entry(body, 'timeout-minutes', 4)?.inline)).toBeGreaterThan(0);
  expect(entry(body, 'strategy', 4), 'no matrix').toBeNull();
});

it('[CT-06zzzzza] verify-replay has the services of verify-int-1 (the one-shot Redis), line for line', () => {
  const strip = (lines: string[]): string[] => lines.filter((l) => !isBlankOrComment(l));
  expect(strip(services(JOB))).toEqual(strip(services(REF)));
});

it('[CT-06zzzzza] verify-replay installs, configures the one-shot Redis as verify-int-1 does, then runs test:replay with TEST_REDIS_URL', () => {
  const all = steps(JOB);
  const runsReplay = (s: Step): boolean =>
    commandLines(s.run).some((c) => /\btest:replay\b/.test(c));
  const checkout = all.findIndex((s) => (s.uses ?? '').startsWith('actions/checkout@'));
  const install = all.findIndex((s) =>
    commandLines(s.run).includes('pnpm install --frozen-lockfile'),
  );
  const redis = all.findIndex((s) => s.name === 'Configure the one-shot Redis');
  const test = all.findIndex(runsReplay);
  for (const [what, at] of Object.entries({ checkout, install, redis, test }))
    expect(at, `${JOB}: ${what}`).toBeGreaterThanOrEqual(0);
  expect(checkout).toBeLessThan(install);
  expect(install).toBeLessThan(test);
  expect(redis).toBeLessThan(test);
  // The Redis step is verify-int-1's: same script, same env.
  const ref = steps(REF).find((s) => s.name === 'Configure the one-shot Redis');
  expect(ref, `${REF} has the Redis step`).toBeDefined();
  expect(all[redis]?.run).toBe(ref?.run);
  expect(all[redis]?.env).toEqual(ref?.env);
  // The test step gets the Redis URL of the integration jobs.
  const refTest = steps(REF).find((s) => commandLines(s.run).some((c) => /\btest:int\b/.test(c)));
  expect(refTest?.env['TEST_REDIS_URL']).toBe('redis://127.0.0.1:6379/0');
  expect(all[test]?.env['TEST_REDIS_URL']).toBe(refTest?.env['TEST_REDIS_URL']);
});

it('[CT-06zzzzza] verify-replay sets no variable beyond verify-int-1: the same job env, and only TEST_REDIS_URL on the test step', () => {
  // The PostgreSQL comes as in the int jobs: the global setup starts it (Testcontainers). Any
  // database variable would show up as a difference here; the services are compared above.
  const jobEnv = (id: string): Record<string, string> => mapping(entry(requireJob(id), 'env', 4));
  expect(jobEnv(JOB)).toEqual(jobEnv(REF));
  const test = steps(JOB).find((s) => commandLines(s.run).some((c) => /\btest:replay\b/.test(c)));
  expect(test?.env).toEqual({ TEST_REDIS_URL: 'redis://127.0.0.1:6379/0' });
  expect(services(JOB).join('\n')).not.toMatch(/image:\s*\S*postgres/);
});

it('[CT-06zzzzza] verify-replay needs no verify job: it runs beside verify-int-1 … -6, not after them', () => {
  const needs = listItems(entry(requireJob(JOB), 'needs', 4));
  for (const n of needs) expect(n, `${JOB} needs ${n}`).not.toMatch(/^verify-(?!reuse$)/);
  for (const n of needs) expect(['verify-reuse', 'ledger-only-detect']).toContain(n);
  // No job waits for verify-replay (in particular not ci-gate).
  for (const id of jobIds()) {
    if (id === JOB) continue;
    expect(listItems(entry(requireJob(id), 'needs', 4)), `${id} needs`).not.toContain(JOB);
  }
});

// --- 1a. no scenarios: the check before test:replay (D10-1389) --------------------------------

/** The test:replay step's `if:` as one comparison of a step output: `steps.<id>.outputs.<key> == 'v'`. */
type Gate = { id: string; key: string; op: '==' | '!='; value: string };

function gateOf(cond: string | null): Gate | null {
  if (cond === null) return null;
  const bare = (/^\$\{\{\s*([\s\S]*?)\s*\}\}$/.exec(cond.trim())?.[1] ?? cond).trim();
  const m =
    /^steps\.([A-Za-z0-9_-]+)\.outputs\.([A-Za-z0-9_-]+)\s*(==|!=)\s*(?:'([^']*)'|(true|false))$/.exec(
      bare,
    );
  if (!m) return null;
  return {
    id: m[1] ?? '',
    key: m[2] ?? '',
    op: m[3] === '!=' ? '!=' : '==',
    value: m[4] ?? m[5] ?? '',
  };
}

/** The check step and the gate of the test:replay step; asserts their shape and order. */
function replayCheck(): { check: Step; gate: Gate } {
  const all = steps(JOB);
  const test = all.findIndex((s) => commandLines(s.run).some((c) => /\btest:replay\b/.test(c)));
  expect(test, `${JOB} runs test:replay`).toBeGreaterThanOrEqual(0);
  const cond = all[test]?.if ?? null;
  expect(cond, 'the test:replay step has an `if:`').not.toBeNull();
  const gate = gateOf(cond);
  expect(
    gate,
    `the test:replay step's if: is one comparison of a step output (got: ${String(cond)})`,
  ).not.toBeNull();
  const at = all.findIndex((s) => s.id === gate?.id);
  expect(at, `${JOB} has a step with id \`${String(gate?.id)}\``).toBeGreaterThanOrEqual(0);
  const checkout = all.findIndex((s) => (s.uses ?? '').startsWith('actions/checkout@'));
  expect(checkout).toBeGreaterThanOrEqual(0);
  expect(checkout, 'the check runs after the checkout').toBeLessThan(at);
  expect(at, 'the check runs before test:replay').toBeLessThan(test);
  const check = all[at] as Step;
  expect(check.run, 'the check step is a run script').toBeTruthy();
  expect(check.if, 'the check step itself always runs').toBeNull();
  expect(check.run ?? '').toContain('test/replay');
  expect(check.run ?? '').toContain('GITHUB_OUTPUT');
  return { check, gate: gate as Gate };
}

/** Lines of a $GITHUB_OUTPUT file as key -> value (`k=v` and `k<<DELIM` forms). */
function readOutputs(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = readFileSync(file, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const heredoc = /^([^=<]+)<<(.+)$/.exec(line);
    if (heredoc) {
      const body: string[] = [];
      for (i++; i < lines.length && lines[i] !== heredoc[2]; i++) body.push(lines[i] ?? '');
      out[heredoc[1] ?? ''] = body.join('\n');
      continue;
    }
    const at = line.indexOf('=');
    if (at > 0) out[line.slice(0, at)] = line.slice(at + 1);
  }
  return out;
}

let fixtures = 0;

/**
 * Runs the check step's script, as GitHub runs a bash step, in a fixture checkout under .tmp/ that
 * holds exactly `files` (paths relative to the checkout). Returns whether the test:replay step
 * would then run, and what the check printed.
 */
function runCheck(files: string[]): { status: number | null; runs: boolean; out: string } {
  const { check, gate } = replayCheck();
  for (const v of Object.values(check.env))
    expect(v, 'the check step env needs no expression').not.toContain('${{');
  const dir = join(SCRATCH, `case-${String(++fixtures)}`);
  const root = join(dir, 'checkout');
  mkdirSync(root, { recursive: true });
  for (const f of files) {
    mkdirSync(dirname(join(root, f)), { recursive: true });
    writeFileSync(join(root, f), f.endsWith('.json') ? '{}\n' : '// fixture\n');
  }
  const output = join(dir, 'github-output');
  writeFileSync(output, '');
  const res = spawnSync(
    'bash',
    ['--noprofile', '--norc', '-eo', 'pipefail', '-c', check.run ?? ''],
    {
      cwd: root,
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        PATH: process.env['PATH'] ?? '',
        HOME: dir,
        CI: 'true',
        GITHUB_ACTIONS: 'true',
        GITHUB_WORKSPACE: root,
        GITHUB_OUTPUT: output,
        RUNNER_TEMP: dir,
        ...check.env,
      },
    },
  );
  const got = readOutputs(output)[gate.key];
  const runs = gate.op === '==' ? got === gate.value : got !== gate.value;
  return { status: res.status, runs, out: `${res.stdout}\n${res.stderr}` };
}

it('[CT-06zzzzza] verify-replay checks test/replay for *.test.ts before test:replay, and test:replay is gated on that check', () => {
  const { gate } = replayCheck();
  expect(gate.key).not.toBe('');
});

it.each([
  { what: 'only README.md (as on main)', files: ['test/replay/README.md'] },
  {
    what: 'README.md, provenance.json and other non-*.test.ts files, at any depth',
    files: [
      'test/replay/README.md',
      'test/replay/provenance.json',
      'test/replay/union/demo/provenance.json',
      'test/replay/union/demo/response.json',
      'test/replay/union/demo/scenario.ts',
      'test/replay/union/demo/notes.md',
      'test/replay/union/demo/x.test.ts.orig',
      'test/replay/union/demo/x.spec.ts',
      'test/replay/union/demo/x.test.js',
      'test/replay/union/demo/x.int.test.tsx',
    ],
  },
  {
    what: 'a *.test.ts outside test/replay only',
    files: ['test/replay/README.md', 'test/spec/a.test.ts', 'test/acceptance/b.test.ts'],
  },
])(
  '[CT-06zzzzza] no scenario — $what: the check passes, prints a GitHub notice, and test:replay is skipped',
  ({ files }) => {
    const r = runCheck(files);
    expect(r.status, r.out).toBe(0);
    expect(r.runs, `test:replay is skipped\n${r.out}`).toBe(false);
    expect(r.out).toMatch(/^::notice\b/m);
  },
);

it.each([
  { what: 'one *.test.ts at the top', files: ['test/replay/README.md', 'test/replay/a.test.ts'] },
  {
    what: 'one *.test.ts three levels deep',
    files: ['test/replay/README.md', 'test/replay/union/demo/order/paid.test.ts'],
  },
  {
    what: 'one *.test.ts in a directory with a space and Chinese in its name',
    files: ['test/replay/provenance.json', 'test/replay/联盟 演示/回放.test.ts'],
  },
  {
    what: 'an integration-style *.int.test.ts',
    files: ['test/replay/union/a.int.test.ts'],
  },
])('[CT-06zzzzza] some scenario — $what: the check passes and test:replay runs', ({ files }) => {
  const r = runCheck(files);
  expect(r.status, r.out).toBe(0);
  expect(r.runs, `test:replay runs\n${r.out}`).toBe(true);
});

// --- 2. not required: ci-gate and verify-reuse as on main ----------------------------------------

it('[CT-06zzzzza] ci-gate needs exactly the jobs it needs on main, in order, and not verify-replay', () => {
  const needs = listItems(entry(requireJob('ci-gate'), 'needs', 4));
  expect(needs).toEqual(MAIN_GATE_NEEDS);
  expect(needs).not.toContain(JOB);
});

it('[CT-06zzzzza] ci-gate Summarise neither reads nor judges verify-replay; its env is as on main', () => {
  const s = steps('ci-gate').find((x) => x.name === 'Summarise');
  expect(s?.run, 'ci-gate has the step Summarise').toBeTruthy();
  expect(Object.keys(s?.env ?? {})).toEqual(MAIN_SUMMARISE_ENV);
  for (const v of Object.values(s?.env ?? {})) expect(v).not.toContain(JOB);
  expect(s?.run ?? '').not.toContain(JOB);
  expect(s?.run ?? '').not.toMatch(/\bREPLAY\b/);
  expect(requireJob('ci-gate').join('\n')).not.toContain(JOB);
});

it('[CT-06zzzzza] verify-reuse: both job lists are the sixteen verify jobs of main, without verify-replay', () => {
  const find = steps('verify-reuse').find((s) => s.id === 'find');
  expect(find?.run, 'verify-reuse has the find step').toBeTruthy();
  const lines = commandLines(find?.run ?? null);
  const push = lines.filter((l) => /^jobs='/.test(l));
  const label = lines.filter((l) => /^for job in verify-.*; do$/.test(l));
  expect(push.length).toBe(1);
  expect(label.length).toBe(1);
  const lists = [
    (/^jobs='(.*)'$/.exec(push[0] ?? '')?.[1] ?? '').split(/\s+/),
    (/^for job in (.*); do$/.exec(label[0] ?? '')?.[1] ?? '').split(/\s+/),
  ];
  for (const list of lists) {
    expect(new Set(list)).toEqual(new Set(VERIFY_JOBS));
    expect(list).not.toContain(JOB);
  }
  expect(requireJob('verify-reuse').join('\n')).not.toContain(JOB);
});
