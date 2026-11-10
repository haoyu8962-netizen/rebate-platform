// CT-06zzzzq (D10-1221 / D10-1222, couli-runs/CI-shard/plan.md): the integration tests of
// .github/workflows/ci.yml run in six jobs, verify-int-1 … verify-int-6, read from the real file.
//
// Pinned here:
//   1. Job i (i = 1..6) runs `pnpm test:int --log-order=stream --filter=@couli/spec-tests --
//      --shard=i/6`, once, with the env of the integration job (TEST_REDIS_URL, PROP_RUNS 2000).
//      All six commands are the same text but for i, so they share one N = 6. Vitest shards by
//      file (BaseSequencer.shard): it sorts the test files of the package by the SHA-1 of their
//      path and cuts that one list into N contiguous ranges, range i going to `--shard=i/N`; for
//      one N and the same file set, the ranges i = 1..N are pairwise disjoint and their union is
//      the whole list. So no spec-test file runs twice and none is left out — provided every i in
//      1..N appears exactly once and nothing else (filter, flags, config) differs between them.
//   2. Only @couli/spec-tests is sharded: @couli/db (2 files) and @couli/api (5 files) would fail
//      under `--shard=i/6` (passWithNoTests is false and vitest refuses more shards than files,
//      plan §1.3). They, and every later package with a test:int, run once, unsharded, in the
//      lightest shard by `pnpm test:int --log-order=stream --filter='!@couli/spec-tests'`. No
//      other test:int command exists (one with neither the spec-tests filter nor its negation
//      would run the spec tests a second time); the old `--shard=1/2` / `2/2` are gone.
//   3. The lightest shard: plan §2.2 simulates the vitest hash split of the 2019 spec files into
//      six shards with summed test times of 45 / 38 / 30 / 25 / 29 / 28 minutes, so shard 4 is the
//      lightest. The browser tests, the build smoke, db:check and their set-up (playwright and apt
//      caches, the Chromium / font install, the wait for the network to settle, the screenshot-
//      baseline upload), until now in verify-int-1 only, are in verify-int-4 only.
//   4. verify-reuse lists exactly the sixteen verify jobs in both of its job lists (push path and
//      label path); ci-gate needs verify-int-1 … -6 and judges each of them in Summarise.
//   5. Locally nothing is sharded: tools/ops/verify-container.sh still runs `pnpm verify`, whose one
//      `pnpm run test:int` runs every package's integration tests in one go.
//
// The line-based YAML helpers are those of ci-concurrency-workflow.test.ts (no YAML dependency).
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { checkWorkflows } from './check-workflows.ts';

const REPO = resolve(import.meta.dirname, '../..');
const CI = readFileSync(join(REPO, '.github/workflows/ci.yml'), 'utf8');
const LINES = CI.split('\n');

/** The number of spec-test shards. */
const N = 6;
const SHARDS = [1, 2, 3, 4, 5, 6] as const;
/** The lightest shard by the simulation of plan §2.2 (45 / 38 / 30 / 25 / 29 / 28 minutes). */
const LIGHTEST = 4;
const INT_JOBS = SHARDS.map((i) => `verify-int-${String(i)}`);
const LIGHTEST_JOB = `verify-int-${String(LIGHTEST)}`;
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
  ...INT_JOBS,
];

const shardCommand = (i: number): string =>
  `pnpm test:int --log-order=stream --filter=@couli/spec-tests -- --shard=${String(i)}/${String(N)}`;
const OTHERS_COMMAND = "pnpm test:int --log-order=stream --filter='!@couli/spec-tests'";
/** The env of every test:int step, as the integration job had it (D10-210). */
const INT_ENV = { TEST_REDIS_URL: 'redis://127.0.0.1:6379/0', PROP_RUNS: '2000' };

/** The steps that only the lightest shard runs: the tail that used to be in verify-int-1. */
const TAIL_STEP_NAMES = [
  'Read the pinned playwright version',
  'Cache the playwright browsers',
  'Read the runner image for the apt cache',
  'Restore the apt .deb cache',
  'Install Chromium and the CJK fonts for the browser tests',
  'Save the apt .deb cache',
  'Wait for the integration containers and the host network to settle',
  'Upload the screenshot-baseline report (DSX-50)',
];
const TAIL_RUNS = [
  'pnpm --filter @couli/spec-tests run test:browser',
  'pnpm --filter @couli/spec-tests run test:smoke',
  'pnpm db:check',
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

function jobIf(id: string): string {
  const e = entry(requireJob(id), 'if', 4);
  return e === null ? '' : value(e).replace(/\s+/g, ' ');
}

type Step = {
  id: string | null;
  name: string | null;
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

type IntRun = { job: string; step: number; command: string; env: Record<string, string> };

/** Every command line of every job of ci.yml that runs a `test:int` script. */
function intRuns(): IntRun[] {
  const out: IntRun[] = [];
  for (const job of jobIds()) {
    const body = jobBody(job) ?? [];
    if (!body.some((l) => /^ {4}steps:\s*$/.test(l))) continue;
    steps(job).forEach((s, step) => {
      for (const command of commandLines(s.run))
        if (/\btest:int\b/.test(command)) out.push({ job, step, command, env: s.env });
    });
  }
  return out;
}

/** The index of the step of `job` whose name or run matches, or -1. */
function stepIndex(job: string, pred: (s: Step) => boolean): number {
  return steps(job).findIndex(pred);
}

// --- 1. the six jobs and the spec-test shards ---------------------------------------------------

it('[CT-06zzzzq] ci.yml has exactly the int jobs verify-int-1 … verify-int-6, each listed on its own (no matrix)', () => {
  const ints = jobIds().filter((id) => /^verify-int\b/.test(id));
  expect(ints).toEqual(INT_JOBS);
  for (const id of INT_JOBS)
    expect(entry(requireJob(id), 'strategy', 4), `${id} has no strategy / matrix`).toBeNull();
});

it.each(SHARDS.map((i) => ({ i })))(
  '[CT-06zzzzq] verify-int-$i runs the spec-test shard $i/6 once, verbatim, with TEST_REDIS_URL and PROP_RUNS 2000',
  ({ i }) => {
    const job = `verify-int-${String(i)}`;
    const mine = intRuns().filter((r) => r.job === job && r.command === shardCommand(i));
    expect(mine.length, `${job} runs \`${shardCommand(i)}\` exactly once`).toBe(1);
    expect(mine[0]?.env).toEqual(INT_ENV);
    // The step as text, as tools/ops/verify-container*.test.ts read it.
    expect(CI).toContain(
      `      - run: ${shardCommand(i)}\n        env:\n          TEST_REDIS_URL: redis://127.0.0.1:6379/0\n          PROP_RUNS: '2000'\n`,
    );
  },
);

it('[CT-06zzzzq] the sharded test:int commands are 1/6 … 6/6, each exactly once, in the job of the same number, the rest of the command identical (one N: disjoint shards whose union is every spec-test file)', () => {
  const sharded = intRuns().filter((r) => /--shard=/.test(r.command));
  const parsed = sharded.map((r) => {
    const m = /^(.*) --shard=(\d+)\/(\d+)$/.exec(r.command);
    expect(m, `\`${r.command}\` ends with --shard=i/N`).not.toBeNull();
    return { job: r.job, rest: m?.[1] ?? '', i: Number(m?.[2]), n: Number(m?.[3]) };
  });
  // The same text but for i: the same package filter and flags, and the same N.
  expect(new Set(parsed.map((p) => p.rest))).toEqual(
    new Set(['pnpm test:int --log-order=stream --filter=@couli/spec-tests --']),
  );
  expect(new Set(parsed.map((p) => p.n))).toEqual(new Set([N]));
  // Every i in 1..N exactly once: with one N, vitest's ranges i/N are disjoint and cover the list.
  expect(parsed.map((p) => p.i).sort((a, b) => a - b)).toEqual([...SHARDS]);
  for (const p of parsed)
    expect(p.job, `shard ${String(p.i)}/${String(N)}`).toBe(`verify-int-${String(p.i)}`);
});

it("[CT-06zzzzq] every other package's test:int runs once, unsharded, in the lightest shard verify-int-4, with the same env", () => {
  const others = intRuns().filter((r) => r.command.includes('!@couli/spec-tests'));
  expect(others.map((r) => r.command)).toEqual([OTHERS_COMMAND]);
  expect(others[0]?.job).toBe(LIGHTEST_JOB);
  expect(others[0]?.env).toEqual(INT_ENV);
});

it('[CT-06zzzzq] no test:int command in ci.yml runs the spec tests outside the six shards: every one is a shard command or the negated filter; the old 1/2 and 2/2 are gone', () => {
  const runs = intRuns();
  expect(runs.length, 'six shard commands and one for the other packages').toBe(N + 1);
  const allowed = new Set([...SHARDS.map(shardCommand), OTHERS_COMMAND]);
  for (const r of runs) expect(allowed.has(r.command), `${r.job}: \`${r.command}\``).toBe(true);
  for (const r of runs) {
    expect(r.command, r.job).not.toMatch(/--shard=1\/2\b/);
    expect(r.command, r.job).not.toMatch(/--shard=2\/2\b/);
  }
  expect(CI).not.toContain('pnpm test:int --log-order=stream -- --shard=1/2');
  expect(CI).not.toContain('pnpm test:int --log-order=stream -- --shard=2/2');
  // Each job runs its own shard and nothing else, but for the lightest one's extra command.
  for (const job of INT_JOBS) {
    const mine = runs.filter((r) => r.job === job).map((r) => r.command);
    const i = Number(job.slice('verify-int-'.length));
    expect(mine, job).toEqual(
      job === LIGHTEST_JOB
        ? expect.arrayContaining([shardCommand(i), OTHERS_COMMAND])
        : [shardCommand(i)],
    );
    expect(mine.length, job).toBe(job === LIGHTEST_JOB ? 2 : 1);
  }
});

// --- 2. the tail: browser tests, smoke, db:check in the lightest shard only -------------------

it.each(TAIL_STEP_NAMES.map((name) => ({ name })))(
  '[CT-06zzzzq] the step "$name" is in verify-int-4 only, once',
  ({ name }) => {
    const where = jobIds().filter((job) => {
      const body = jobBody(job) ?? [];
      return body.some((l) => /^ {4}steps:\s*$/.test(l)) && steps(job).some((s) => s.name === name);
    });
    expect(where).toEqual([LIGHTEST_JOB]);
    expect(steps(LIGHTEST_JOB).filter((s) => s.name === name).length).toBe(1);
  },
);

it.each(TAIL_RUNS.map((command) => ({ command })))(
  '[CT-06zzzzq] `$command` runs in verify-int-4 only, once',
  ({ command }) => {
    const where: string[] = [];
    for (const job of jobIds()) {
      const body = jobBody(job) ?? [];
      if (!body.some((l) => /^ {4}steps:\s*$/.test(l))) continue;
      for (const s of steps(job))
        for (const c of commandLines(s.run)) if (c === command) where.push(job);
    }
    expect(where).toEqual([LIGHTEST_JOB]);
  },
);

it('[CT-06zzzzq] in verify-int-4 both test:int commands come before the wait for the network, which comes before the browser tests, the smoke and db:check', () => {
  const runs = (c: string) => (s: Step) => commandLines(s.run).includes(c);
  const shard = stepIndex(LIGHTEST_JOB, runs(shardCommand(LIGHTEST)));
  const others = stepIndex(LIGHTEST_JOB, runs(OTHERS_COMMAND));
  const wait = stepIndex(
    LIGHTEST_JOB,
    (s) => s.name === 'Wait for the integration containers and the host network to settle',
  );
  const browser = stepIndex(LIGHTEST_JOB, runs(TAIL_RUNS[0] ?? ''));
  const smoke = stepIndex(LIGHTEST_JOB, runs(TAIL_RUNS[1] ?? ''));
  const check = stepIndex(LIGHTEST_JOB, runs(TAIL_RUNS[2] ?? ''));
  for (const [what, at] of Object.entries({ shard, others, wait, browser, smoke, check }))
    expect(at, what).toBeGreaterThanOrEqual(0);
  expect(shard).toBeLessThan(wait);
  expect(others).toBeLessThan(wait);
  expect(wait).toBeLessThan(browser);
  expect(browser).toBeLessThan(smoke);
  expect(smoke).toBeLessThan(check);
});

// --- 3. every shard is a full integration job -------------------------------------------------

it.each(INT_JOBS.map((job) => ({ job })))(
  '[CT-06zzzzq] $job: needs, if, runner, Redis service, build and the verified-<job>-<tree> record as the other int jobs',
  ({ job }) => {
    const body = requireJob(job);
    expect(new Set(listItems(entry(body, 'needs', 4)))).toEqual(
      new Set(['verify-reuse', 'ledger-only-detect']),
    );
    const cond = jobIf(job);
    expect(cond).toContain('!cancelled()');
    expect(cond).toContain("needs.verify-reuse.outputs.reuse != 'true'");
    expect(cond).toContain("needs.verify-reuse.outputs.moved != 'true'");
    expect(cond).toContain(`needs.ledger-only-detect.${['outputs', 'only'].join('.')} != 'true'`);
    expect(cond, 'the same if as verify-int-1').toBe(jobIf('verify-int-1'));
    expect(entry(body, 'runs-on', 4)?.inline).toBe('ubuntu-latest');
    expect(Number(entry(body, 'timeout-minutes', 4)?.inline)).toBeGreaterThan(0);
    expect(body.join('\n')).toContain('        image: redis:7.4.11-alpine\n');
    expect(body.join('\n')).toContain('          - 127.0.0.1:6379:6379\n');
    const all = steps(job);
    const tested = all.findIndex((s) => s.id === 'tested');
    const install = all.findIndex((s) =>
      commandLines(s.run).includes('pnpm install --frozen-lockfile'),
    );
    const build = all.findIndex((s) => commandLines(s.run).includes('pnpm build'));
    const redis = all.findIndex((s) => s.name === 'Configure the one-shot Redis');
    const test = all.findIndex((s) => commandLines(s.run).some((c) => /\btest:int\b/.test(c)));
    for (const [what, at] of Object.entries({ tested, install, build, redis, test }))
      expect(at, `${job}: ${what}`).toBeGreaterThanOrEqual(0);
    expect(tested).toBeLessThan(install);
    expect(install).toBeLessThan(build);
    expect(redis).toBeLessThan(test);
    const last = all[all.length - 1];
    expect(last?.uses ?? '').toMatch(/^actions\/upload-artifact@/);
    expect(last?.with['name']).toBe(`verified-${job}-\${{ steps.tested.outputs.tree }}`);
  },
);

// --- 4. verify-reuse and ci-gate --------------------------------------------------------------

it('[CT-06zzzzq] verify-reuse: the push-path list and the label-path loop both name exactly the sixteen verify jobs, verify-int-1 … -6 among them', () => {
  const find = steps('verify-reuse').find((s) => s.id === 'find');
  expect(find?.run, 'verify-reuse has the find step').toBeTruthy();
  const lines = commandLines(find?.run ?? null);
  const push = lines.filter((l) => /^jobs='/.test(l));
  const label = lines.filter((l) => /^for job in verify-.*; do$/.test(l));
  expect(push.length, "one jobs='…' line").toBe(1);
  expect(label.length, 'one for job in verify-…; do line (the label path)').toBe(1);
  const names = [
    (/^jobs='(.*)'$/.exec(push[0] ?? '')?.[1] ?? '').split(/\s+/),
    (/^for job in (.*); do$/.exec(label[0] ?? '')?.[1] ?? '').split(/\s+/),
  ];
  for (const list of names) {
    expect(list.length, 'no duplicates').toBe(new Set(list).size);
    expect(new Set(list)).toEqual(new Set(VERIFY_JOBS));
    expect(list.filter((j) => j.startsWith('verify-int'))).toEqual(INT_JOBS);
  }
});

it('[CT-06zzzzq] ci-gate needs verify-int-1 … -6 and no other int job', () => {
  const needs = listItems(entry(requireJob('ci-gate'), 'needs', 4));
  expect(needs.filter((j) => j.startsWith('verify-int')).sort()).toEqual([...INT_JOBS].sort());
  expect(new Set(needs)).toEqual(
    new Set([...VERIFY_JOBS, 'guard-git', 'verify-reuse', 'ledger-only-detect']),
  );
});

function summarise(): Step {
  const s = steps('ci-gate').find((x) => x.name === 'Summarise');
  expect(s?.run, 'ci-gate has the step Summarise with a run script').toBeTruthy();
  return s as Step;
}

it('[CT-06zzzzq] ci-gate Summarise reads INT1 … INT6 from verify-int-1 … -6, logs and judges each like the other heavy jobs', () => {
  const s = summarise();
  const intVars = Object.keys(s.env).filter((k) => /^INT\d+$/.test(k));
  expect(intVars.sort()).toEqual(SHARDS.map((i) => `INT${String(i)}`).sort());
  const lines = commandLines(s.run);
  for (const i of SHARDS) {
    const v = `INT${String(i)}`;
    expect(s.env[v]).toBe(`\${{ needs.verify-int-${String(i)}.result }}`);
    expect(lines, v).toContain(
      `[ "$${v}" = success ] || reused "$${v}" || ledger_only "$${v}" || exit 1`,
    );
    const echo = lines.find((l) => l.startsWith('echo '));
    expect(echo ?? '', `the summary line shows verify-int-${String(i)}`).toContain(
      `verify-int-${String(i)}=\${${v}}`,
    );
  }
});

/** Runs Summarise on a pull_request event with no reuse and no ledger-only skip. */
function runGate(results: Record<string, string>): { status: number | null; out: string } {
  const s = summarise();
  const values: Record<string, string> = {
    'github.event_name': 'pull_request',
    'needs.verify-reuse.result': 'skipped',
    'needs.verify-reuse.outputs.reuse': '',
    'needs.ledger-only-detect.result': 'success',
    [`needs.ledger-only-detect.${['outputs', 'only'].join('.')}`]: 'false',
    'needs.guard-git.result': 'success',
  };
  for (const j of VERIFY_JOBS) values[`needs.${j}.result`] = results[j] ?? 'success';
  const env: Record<string, string> = {};
  for (const [k, text] of Object.entries(s.env)) {
    const m = /^\$\{\{\s*(.+?)\s*\}\}$/.exec(text.trim());
    const v = m ? values[m[1] ?? ''] : undefined;
    if (v === undefined) throw new Error(`no scenario value for ${k}: ${text}`);
    env[k] = v;
  }
  const res = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', s.run ?? ''], {
    encoding: 'utf8',
    env: { PATH: process.env['PATH'] ?? '', ...env },
  });
  return { status: res.status, out: `${res.stdout}\n${res.stderr}` };
}

it('[CT-06zzzzq] ci-gate Summarise passes when all sixteen verify jobs succeeded', () => {
  const r = runGate({});
  expect(r.status, r.out).toBe(0);
});

it.each(
  INT_JOBS.flatMap((job) =>
    (['failure', 'cancelled', 'skipped'] as const).map((result) => ({ job, result })),
  ),
)(
  '[CT-06zzzzq] ci-gate Summarise fails when $job is $result and every other job succeeded',
  ({ job, result }) => {
    const r = runGate({ [job]: result });
    expect(r.status, r.out).toBe(1);
  },
);

it('[CT-06zzzzq] check-workflows reports no problem for the workflows as they are', () => {
  expect(checkWorkflows(REPO)).toEqual([]);
});

// --- 5. locally nothing is sharded --------------------------------------------------------------

it('[CT-06zzzzq] the local verify (tools/ops/verify-container.sh) still runs test:int once, in full, unsharded', () => {
  const script = readFileSync(join(REPO, 'tools/ops/verify-container.sh'), 'utf8');
  const entrypoint = readFileSync(join(REPO, 'tools/ops/verify-image/entrypoint.sh'), 'utf8');
  const root = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  // verify-container.sh runs the entrypoint's `verify`, which runs `pnpm run verify` by default.
  expect(script).toContain('couli-verify-entrypoint verify');
  expect(script).not.toMatch(/--shard\b/);
  expect(entrypoint).toContain('script="${VERIFY_SCRIPT:-verify}"');
  expect(entrypoint).toMatch(/pnpm run "\$script"/);
  expect(entrypoint).not.toMatch(/--shard\b/);
  // The root verify: one test:int, the root turbo script over every package, nothing appended.
  const verify = root.scripts['verify'] ?? '';
  const parts = verify.split('&&').map((p) => p.trim());
  expect(parts.filter((p) => /\btest:int\b/.test(p))).toEqual(['pnpm run test:int']);
  expect(verify).not.toMatch(/--shard\b/);
  expect(root.scripts['test:int']).toBe('turbo run test:int --env-mode=loose');
});
