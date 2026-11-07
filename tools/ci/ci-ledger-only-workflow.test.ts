// CT-06zzzv (FU-CI-LEDGER-ONLY-FAST, D10-935): the structure of .github/workflows/ci.yml around
// the ledger-only fast path, read from the real file. The job ledger-only-detect runs the BASE
// copy of tools/ci/ledger-only.ts against the PR checkout; the eleven heavy verify jobs are skipped
// when it says only=true; verify-static and guard-git always run; ci-gate accepts those skips only
// when the detection itself succeeded and said only=true.
//
// The run scripts of ledger-only-detect and of the ci-gate Summarise step are extracted from the
// YAML and executed with bash, with every `${{ <expression> }}` of their env replaced by a value
// chosen per scenario. The parser is line-based (no YAML dependency), like check-workflows.ts.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { checkWorkflows } from './check-workflows.ts';

const REPO = resolve(import.meta.dirname, '../..');
const CI = readFileSync(join(REPO, '.github/workflows/ci.yml'), 'utf8');
const LINES = CI.split('\n');
const SCRATCH = join(REPO, '.tmp', `ci-ledger-only-workflow-${process.pid}`);

const DETECT = 'ledger-only-detect';
const HEAVY = [
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
] as const;
// The output key is spelled from its parts: test-guard (no-skip-only) matches the dot-only text.
const ONLY_OUTPUT = ['outputs', 'only'].join('.');
const SKIP_IF_ONLY = `needs.${DETECT}.${ONLY_OUTPUT} != 'true'`;
const BASE_SHA = 'b'.repeat(40);
const HEAD_SHA = 'a'.repeat(40);

// --- line-based YAML helpers -------------------------------------------------------------------

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
  const quoted = /^(['"])(.*)\1$/.exec(withoutComment);
  return quoted ? (quoted[2] ?? '') : withoutComment;
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
  const re = new RegExp(`^ {${indent}}${key.replace(/[-]/g, '\\-')}:(\\s.*)?$`);
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
  // Drop trailing blank lines.
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

function jobIf(id: string): string {
  const e = entry(requireJob(id), 'if', 4);
  return e === null ? '' : value(e).replace(/\s+/g, ' ');
}

function jobNeeds(id: string): string[] {
  const e = entry(requireJob(id), 'needs', 4);
  if (e === null) return [];
  const inline = scalar(e.inline);
  if (inline.startsWith('[')) {
    return inline
      .replace(/^\[|\]$/g, '')
      .split(',')
      .map((s) => scalar(s))
      .filter(Boolean);
  }
  if (inline !== '') return [inline];
  return e.block.filter((l) => /^\s*-\s+/.test(l)).map((l) => scalar(l.replace(/^\s*-\s+/, '')));
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

type Step = {
  id: string | null;
  name: string | null;
  uses: string | null;
  run: string | null;
  if: string | null;
  workingDirectory: string | null;
  with: Record<string, string>;
  env: Record<string, string>;
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
      if: get('if'),
      workingDirectory: get('working-directory'),
      with: mapping(entry(lines, 'with', 8)),
      env: mapping(entry(lines, 'env', 8)),
    };
  });
}

/** `${{ expr }}` -> expr, or null when the value is not a single expression. */
function expressionOf(text: string): string | null {
  const m = /^\$\{\{\s*(.+?)\s*\}\}$/.exec(text.trim());
  return m ? (m[1] ?? null) : null;
}

/** Replaces every `${{ expr }}` in `text` by `values[expr]`; an unknown expression throws. */
function expand(text: string, values: Record<string, string>): string {
  return text.replace(/\$\{\{\s*(.+?)\s*\}\}/g, (_, expr: string) => {
    const v = values[expr];
    if (v === undefined) throw new Error(`no scenario value for \${{ ${expr} }}`);
    return v;
  });
}

function stepEnv(step: Step, values: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(step.env)) env[k] = expand(v, values);
  return env;
}

afterAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
});

// --- 1. ledger-only-detect ---------------------------------------------------------------------

it('[CT-06zzzv] ledger-only-detect exists, runs on pull_request only and exposes its `only` output', () => {
  const body = requireJob(DETECT);
  expect(
    body.some((l) => /^ {4}name:/.test(l)),
    'jobs carry no name:',
  ).toBe(false);
  expect(jobIf(DETECT)).toContain("github.event_name == 'pull_request'");
  expect(jobIf(DETECT)).not.toContain('||');
  const outputs = mapping(entry(body, 'outputs', 4));
  const onlyExpr = expressionOf(Object.entries(outputs).find(([k]) => k === 'only')?.[1] ?? '');
  expect(onlyExpr?.split('.'), `${ONLY_OUTPUT} is a step output`).toEqual([
    'steps',
    expect.stringMatching(/^[A-Za-z0-9_-]+$/),
    ...ONLY_OUTPUT.split('.'),
  ]);
  const stepId = (onlyExpr ?? '').split('.')[1];
  expect(
    steps(DETECT).some((s) => s.id === stepId && s.run !== null),
    `a run step with id \`${String(stepId)}\` produces ${ONLY_OUTPUT}`,
  ).toBe(true);
});

it('[CT-06zzzv] ledger-only-detect checks out the PR head with history and the base sha at base/', () => {
  const all = steps(DETECT);
  const checkouts = all.filter((s) => (s.uses ?? '').startsWith('actions/checkout@'));
  const pr = checkouts.find(
    (s) => expressionOf(s.with['ref'] ?? '') === 'github.event.pull_request.head.sha',
  );
  const base = checkouts.find(
    (s) => expressionOf(s.with['ref'] ?? '') === 'github.event.pull_request.base.sha',
  );
  expect(pr, 'a checkout of github.event.pull_request.head.sha').toBeDefined();
  expect(base, 'a checkout of github.event.pull_request.base.sha').toBeDefined();
  expect(pr?.with['fetch-depth'], 'the PR checkout has full history for base...head').toBe('0');
  expect(pr?.with['path'] ?? '', 'the PR checkout has its own path').toMatch(/\S/);
  expect(pr?.with['path']).not.toBe('base');
  expect(base?.with['path']).toBe('base');
  expect(pr?.with['persist-credentials']).toBe('false');
  expect(base?.with['persist-credentials']).toBe('false');
  // Nothing of the PR is installed or executed: the base script uses Node built-ins only.
  for (const s of all) expect(s.run ?? '').not.toMatch(/\bpnpm\b|\bnpm\b|\bnpx\b/);
});

it('[CT-06zzzv] ledger-only-detect runs node base/tools/ci/ledger-only.ts, never the PR copy', () => {
  const runs = steps(DETECT).flatMap((s) => (s.run === null ? [] : [s.run]));
  const text = runs.join('\n');
  expect(text).toContain('node base/tools/ci/ledger-only.ts');
  // Every mention of the script is the base copy.
  const mentions = [...text.matchAll(/(\S*)tools\/ci\/ledger-only\.ts/g)].map((m) => m[1] ?? '');
  expect(mentions.length).toBeGreaterThan(0);
  for (const prefix of mentions) expect(prefix).toMatch(/(^|\/|")base\/$/);
  expect(text).toContain('--repo');
  expect(text).toContain('--base');
  expect(text).toContain('--head');
});

type DetectRun = {
  status: number | null;
  out: string;
  output: string;
  baseArgs: string[] | null;
  prRan: boolean;
  workspace: string;
  prPath: string;
};

let detectCount = 0;

/** Runs the run steps of ledger-only-detect in a scratch workspace with stub scripts. */
function runDetect(withBaseScript: boolean): DetectRun {
  const workspace = join(SCRATCH, `detect-${++detectCount}`);
  const all = steps(DETECT);
  const prStep = all.find(
    (s) => expressionOf(s.with['ref'] ?? '') === 'github.event.pull_request.head.sha',
  );
  const prPath = prStep?.with['path'] ?? 'pr';
  const stub = (marker: string): string =>
    [
      "import { appendFileSync, writeFileSync } from 'node:fs';",
      `writeFileSync(new URL('./${marker}.json', import.meta.url), JSON.stringify(process.argv.slice(2)));`,
      "appendFileSync(process.env['GITHUB_OUTPUT'] ?? '/dev/null', 'only=true\\n');",
      "console.log('only=true');",
      '',
    ].join('\n');
  for (const dir of [join(workspace, 'base'), join(workspace, prPath)]) {
    mkdirSync(join(dir, 'tools/ci'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), '{ "type": "module" }\n');
  }
  writeFileSync(join(workspace, prPath, 'tools/ci/ledger-only.ts'), stub('ran-pr'));
  if (withBaseScript)
    writeFileSync(join(workspace, 'base/tools/ci/ledger-only.ts'), stub('ran-base'));
  const output = join(workspace, 'github-output');
  writeFileSync(output, '');
  const values: Record<string, string> = {
    'github.event.pull_request.base.sha': BASE_SHA,
    'github.event.pull_request.head.sha': HEAD_SHA,
    'github.event.pull_request.number': '7',
    'github.event.pull_request.head.ref': 'chore/x',
    'github.event_name': 'pull_request',
    'github.workspace': workspace,
    'github.token': 'not-a-real-token',
    'github.repository': 'o/r',
  };
  let status: number | null = 0;
  let out = '';
  for (const s of all) {
    if (s.run === null) continue;
    const res = spawnSync(
      'bash',
      ['--noprofile', '--norc', '-eo', 'pipefail', '-c', expand(s.run, values)],
      {
        cwd: s.workingDirectory === null ? workspace : join(workspace, s.workingDirectory),
        encoding: 'utf8',
        env: {
          PATH: process.env['PATH'] ?? '',
          HOME: workspace,
          GITHUB_WORKSPACE: workspace,
          GITHUB_OUTPUT: output,
          GITHUB_EVENT_NAME: 'pull_request',
          ...stepEnv(s, values),
        },
      },
    );
    out += `${res.stdout}\n${res.stderr}`;
    status = res.status;
    if (status !== 0) break;
  }
  const baseMarker = join(workspace, 'base/tools/ci/ran-base.json');
  return {
    status,
    out,
    output: readFileSync(output, 'utf8'),
    baseArgs: existsSync(baseMarker)
      ? (JSON.parse(readFileSync(baseMarker, 'utf8')) as string[])
      : null,
    prRan: existsSync(join(workspace, prPath, 'tools/ci/ran-pr.json')),
    workspace,
    prPath,
  };
}

function outputOnly(output: string): string[] {
  return output.split('\n').filter((l) => l.startsWith('only='));
}

it('[CT-06zzzv] ledger-only-detect passes --repo <PR checkout> --base <base sha> --head <head sha> to the base script', () => {
  const r = runDetect(true);
  expect(r.status, r.out).toBe(0);
  expect(r.prRan, 'the PR copy of the script never runs').toBe(false);
  expect(r.baseArgs, 'the base copy ran').not.toBeNull();
  const args = r.baseArgs ?? [];
  const arg = (flag: string): string | undefined => args[args.indexOf(flag) + 1];
  expect(args).toContain('--repo');
  expect(resolve(r.workspace, arg('--repo') ?? '')).toBe(join(r.workspace, r.prPath));
  expect(arg('--base')).toBe(BASE_SHA);
  expect(arg('--head')).toBe(HEAD_SHA);
  expect(outputOnly(r.output)).toEqual(['only=true']);
});

it('[CT-06zzzv] ledger-only-detect without the base script outputs only=false and does not fail', () => {
  const r = runDetect(false);
  expect(r.status, r.out).toBe(0);
  expect(r.prRan, 'the PR copy of the script never runs').toBe(false);
  expect(outputOnly(r.output)).toEqual(['only=false']);
});

// --- 2. the eleven heavy jobs ------------------------------------------------------------------

it.each(HEAVY)('[CT-06zzzv] %s needs ledger-only-detect and is skipped when only=true', (id) => {
  const needs = jobNeeds(id);
  expect(needs).toContain(DETECT);
  expect(needs).toContain('verify-reuse');
  const cond = jobIf(id);
  expect(cond).toContain('!cancelled()');
  expect(cond).toContain("needs.verify-reuse.outputs.reuse != 'true'");
  expect(cond).toContain(SKIP_IF_ONLY);
  expect(cond).not.toContain('||');
  expect(cond).not.toMatch(/\balways\(\)/);
});

// --- 3. verify-static and guard-git always run -------------------------------------------------

it('[CT-06zzzv] verify-static and guard-git carry no ledger-only condition', () => {
  for (const id of ['verify-static', 'guard-git']) {
    expect(jobIf(id), id).not.toContain('ledger-only');
    expect(jobIf(id), id).not.toContain(SKIP_IF_ONLY);
  }
  expect(jobIf('verify-static')).toContain('!cancelled()');
  expect(jobIf('verify-static')).toContain("needs.verify-reuse.outputs.reuse != 'true'");
  expect(jobIf('guard-git')).toContain("github.event_name == 'pull_request'");
});

it('[CT-06zzzv] verify-static runs node tools/ops/task.ts check with COULI_SPEC_REPO, after install, on every event', () => {
  const all = steps('verify-static');
  const at = all.findIndex((s) => /(^|\s)node tools\/ops\/task\.ts check(\s|$)/.test(s.run ?? ''));
  expect(at, 'a step runs node tools/ops/task.ts check').toBeGreaterThanOrEqual(0);
  const step = all[at];
  expect(step?.env['COULI_SPEC_REPO'] ?? '', 'the step sets COULI_SPEC_REPO').toMatch(/\S/);
  expect(step?.env['COULI_SPEC_REPO']).toContain('spec-repo');
  expect(step?.if, 'the step runs on every event').toBeNull();
  const install = all.findIndex((s) => (s.run ?? '').includes('pnpm install --frozen-lockfile'));
  const planning = all.findIndex((s) => s.with['path'] === '.tmp/spec-repo');
  expect(install).toBeGreaterThanOrEqual(0);
  expect(at).toBeGreaterThan(install);
  expect(at).toBeGreaterThan(planning);
});

// --- 4. ci-gate --------------------------------------------------------------------------------

it('[CT-06zzzv] ci-gate needs ledger-only-detect besides every job it needed before', () => {
  const needs = jobNeeds('ci-gate');
  for (const id of [DETECT, 'verify-static', ...HEAVY, 'guard-git', 'verify-reuse'])
    expect(needs, id).toContain(id);
  expect(jobIf('ci-gate')).toBe('always()');
});

type Result = 'success' | 'failure' | 'skipped' | 'cancelled';
type Gate = {
  event?: string;
  detect?: { result: Result; output: string };
  reuse?: { result: Result; reuse: string };
  heavy?: Result | Partial<Record<(typeof HEAVY)[number], Result>>;
  heavyDefault?: Result;
  static?: Result;
  guard?: Result;
};

function summarise(): Step {
  const step = steps('ci-gate').find((s) => s.name === 'Summarise');
  expect(step, 'ci-gate has a Summarise step').toBeDefined();
  expect(step?.run ?? '').toMatch(/\S/);
  return step as Step;
}

function gateValues(g: Gate): Record<string, string> {
  const heavyDefault = typeof g.heavy === 'string' ? g.heavy : (g.heavyDefault ?? 'success');
  const per = typeof g.heavy === 'object' ? g.heavy : {};
  const values: Record<string, string> = {
    'github.event_name': g.event ?? 'pull_request',
    'needs.verify-static.result': g.static ?? 'success',
    'needs.guard-git.result': g.guard ?? 'success',
    'needs.verify-reuse.result': g.reuse?.result ?? 'skipped',
    'needs.verify-reuse.outputs.reuse': g.reuse?.reuse ?? '',
    [`needs.${DETECT}.result`]: g.detect?.result ?? 'success',
    [`needs.${DETECT}.${ONLY_OUTPUT}`]: g.detect?.output ?? 'false',
  };
  for (const id of HEAVY) values[`needs.${id}.result`] = per[id] ?? heavyDefault;
  return values;
}

function runGate(g: Gate): { status: number | null; out: string } {
  const step = summarise();
  const res = spawnSync(
    'bash',
    ['--noprofile', '--norc', '-eo', 'pipefail', '-c', step.run ?? ''],
    {
      encoding: 'utf8',
      env: { PATH: process.env['PATH'] ?? '', ...stepEnv(step, gateValues(g)) },
    },
  );
  return { status: res.status, out: `${res.stdout}\n${res.stderr}` };
}

it('[CT-06zzzv] the Summarise env reads the result and the `only` output of ledger-only-detect', () => {
  const exprs = Object.values(summarise().env).map(expressionOf);
  expect(exprs).toContain(`needs.${DETECT}.result`);
  expect(exprs).toContain(`needs.${DETECT}.${ONLY_OUTPUT}`);
  for (const id of ['verify-static', ...HEAVY, 'guard-git', 'verify-reuse'])
    expect(exprs, id).toContain(`needs.${id}.result`);
  expect(exprs).toContain('needs.verify-reuse.outputs.reuse');
  expect(exprs).toContain('github.event_name');
});

const ONLY_OK = { result: 'success', output: 'true' } as const;

const GATE_CASES: [string, Gate, number][] = [
  // The ledger-only fast path.
  [
    'only=true, 11 heavy skipped, static and guard success',
    { detect: ONLY_OK, heavy: 'skipped' },
    0,
  ],
  [
    'only=true, some heavy jobs ran and succeeded, the rest skipped',
    {
      detect: ONLY_OK,
      heavyDefault: 'skipped',
      heavy: { 'verify-unit': 'success', 'verify-int-2': 'success' },
    },
    0,
  ],
  [
    'only=true but detect failure',
    { detect: { result: 'failure', output: 'true' }, heavy: 'skipped' },
    1,
  ],
  [
    'only=true but detect cancelled',
    { detect: { result: 'cancelled', output: 'true' }, heavy: 'skipped' },
    1,
  ],
  [
    'only=true but detect skipped',
    { detect: { result: 'skipped', output: 'true' }, heavy: 'skipped' },
    1,
  ],
  [
    'only=false with the heavy jobs skipped',
    { detect: { result: 'success', output: 'false' }, heavy: 'skipped' },
    1,
  ],
  [
    'only empty with the heavy jobs skipped',
    { detect: { result: 'success', output: '' }, heavy: 'skipped' },
    1,
  ],
  [
    'only=TRUE (not exactly true) with the heavy jobs skipped',
    { detect: { result: 'success', output: 'TRUE' }, heavy: 'skipped' },
    1,
  ],
  [
    'only=false, one heavy job skipped',
    { detect: { result: 'success', output: 'false' }, heavy: { 'verify-props-sha-3': 'skipped' } },
    1,
  ],
  [
    'only=true but verify-static skipped',
    { detect: ONLY_OK, heavy: 'skipped', static: 'skipped' },
    1,
  ],
  [
    'only=true but verify-static failure',
    { detect: ONLY_OK, heavy: 'skipped', static: 'failure' },
    1,
  ],
  ['only=true but guard-git skipped', { detect: ONLY_OK, heavy: 'skipped', guard: 'skipped' }, 1],
  ['only=true but guard-git failure', { detect: ONLY_OK, heavy: 'skipped', guard: 'failure' }, 1],
  [
    'only=true but one heavy job failed',
    { detect: ONLY_OK, heavyDefault: 'skipped', heavy: { 'verify-int-1': 'failure' } },
    1,
  ],
  [
    'only=true but one heavy job cancelled',
    { detect: ONLY_OK, heavyDefault: 'skipped', heavy: { 'verify-spec-2': 'cancelled' } },
    1,
  ],
  // The behaviour before this change.
  [
    'a full run: everything success, only=false',
    { detect: { result: 'success', output: 'false' } },
    0,
  ],
  ['a full run: everything success, only=true', { detect: ONLY_OK }, 0],
  [
    'label event reuse: all twelve verify jobs skipped, reuse success/true',
    {
      detect: { result: 'success', output: 'false' },
      reuse: { result: 'success', reuse: 'true' },
      heavy: 'skipped',
      static: 'skipped',
    },
    0,
  ],
  [
    'label event reuse with the detection failed: reuse still counts',
    {
      detect: { result: 'failure', output: '' },
      reuse: { result: 'success', reuse: 'true' },
      heavy: 'skipped',
      static: 'skipped',
    },
    0,
  ],
  [
    'reuse=true but verify-reuse failed: skipped jobs fail',
    {
      detect: { result: 'success', output: 'false' },
      reuse: { result: 'failure', reuse: 'true' },
      heavy: 'skipped',
      static: 'skipped',
    },
    1,
  ],
  [
    'push to main: detection skipped, everything success, guard skipped',
    { event: 'push', detect: { result: 'skipped', output: '' }, guard: 'skipped' },
    0,
  ],
  [
    'push to main: detection skipped and the heavy jobs skipped',
    {
      event: 'push',
      detect: { result: 'skipped', output: '' },
      guard: 'skipped',
      heavy: 'skipped',
    },
    1,
  ],
  [
    'pull_request with guard-git skipped',
    { detect: { result: 'success', output: 'false' }, guard: 'skipped' },
    1,
  ],
];

it.each(GATE_CASES.map(([name, gate, exit]) => ({ name, gate, exit })))(
  '[CT-06zzzv] ci-gate Summarise: $name -> exit $exit',
  ({ gate, exit }) => {
    const r = runGate(gate);
    expect(r.status, r.out).toBe(exit);
  },
);

// --- 5. the workflow rules still hold ----------------------------------------------------------

it('[CT-06zzzv] check-workflows reports no problem for the workflows as they are', () => {
  expect(checkWorkflows(REPO)).toEqual([]);
});
