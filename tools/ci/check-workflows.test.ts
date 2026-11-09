// Runs the workflow checker against the real files, then against mutated copies to prove that
// every rule can fail.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import {
  checkWorkflows,
  extractEmbeddedProtectedPaths,
  SELF_HOSTED_JOBS,
  SELF_HOSTED_ROUTE,
} from './check-workflows.ts';

const REPO = resolve(import.meta.dirname, '../..');
const SCRATCH = join(REPO, '.tmp', `ci-check-workflows-${process.pid}`);
const PINNED_CHECKOUT = 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1';

let fixtureCount = 0;

/** Copies the real workflows and ruleset into a scratch root and applies one mutation. */
function fixture(mutate: (edit: (file: string, fn: (text: string) => string) => void) => void) {
  const root = join(SCRATCH, String(++fixtureCount));
  mkdirSync(join(root, 'ops'), { recursive: true });
  cpSync(join(REPO, '.github'), join(root, '.github'), { recursive: true });
  cpSync(join(REPO, 'ops/branch-protection.json'), join(root, 'ops/branch-protection.json'));
  mutate((file, fn) => {
    const path = join(root, file);
    const before = readFileSync(path, 'utf8');
    const after = fn(before);
    if (after === before) throw new Error(`mutation of ${file} changed nothing`);
    writeFileSync(path, after);
  });
  return root;
}

function codes(root: string): string[] {
  return [...new Set(checkWorkflows(root).map((p) => p.code))].sort();
}

afterAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
});

it('accepts the real workflows and ruleset export', () => {
  expect(checkWorkflows(REPO)).toEqual([]);
});

it('every required context in the ruleset is a job of exactly one real workflow', () => {
  const ruleset = JSON.parse(readFileSync(join(REPO, 'ops/branch-protection.json'), 'utf8')) as {
    bypass_actors: unknown[];
    rules: { type: string; parameters?: { required_status_checks?: { context: string }[] } }[];
  };
  const contexts = ruleset.rules
    .filter((rule) => rule.type === 'required_status_checks')
    .flatMap((rule) => rule.parameters?.required_status_checks ?? [])
    .map((check) => check.context);
  expect(ruleset.bypass_actors).toEqual([]);
  expect(contexts.sort()).toEqual(
    [
      'ci-gate',
      'contracts-gate',
      'evidence-check',
      'gitleaks',
      'longrun-props',
      'protected-paths',
    ].sort(),
  );
});

it('the embedded protected-paths list parses and carries the three classes', () => {
  const text = readFileSync(join(REPO, '.github/workflows/protected-paths.yml'), 'utf8');
  const embedded = extractEmbeddedProtectedPaths(text);
  const parsed = JSON.parse(embedded ?? 'null') as Record<string, string[]>;
  expect(Object.keys(parsed).sort()).toEqual([
    'class1_add_only',
    'class2_verify_config',
    'class3_gates',
  ]);
  expect(parsed['class3_gates']).toContain('.github/**');
});

it('rejects an action pinned to a tag instead of a commit SHA', () => {
  const root = fixture((edit) =>
    edit('.github/workflows/ci.yml', (t) => t.replace(PINNED_CHECKOUT, 'actions/checkout@v7')),
  );
  expect(codes(root)).toEqual(['unpinned-action']);
});

it('rejects a pinned action without a version comment', () => {
  const root = fixture((edit) =>
    edit('.github/workflows/gitleaks.yml', (t) => t.replace(' # v7.0.1', '')),
  );
  expect(codes(root)).toEqual(['unpinned-action']);
});

it('rejects workflow-level paths filters', () => {
  const root = fixture((edit) =>
    edit('.github/workflows/contracts.yml', (t) =>
      t.replace('  pull_request:\n', "  pull_request:\n    paths: ['contracts/**']\n"),
    ),
  );
  expect(codes(root)).toEqual(['workflow-paths']);
});

it('rejects a job name that is used in two workflows', () => {
  const root = fixture((edit) =>
    edit('.github/workflows/contracts.yml', (t) => t.replace('  contracts-detect:', '  gitleaks:')),
  );
  expect(codes(root)).toContain('duplicate-job');
});

it('rejects a required context that no job reports', () => {
  const root = fixture((edit) =>
    edit('.github/workflows/ci.yml', (t) => t.replace('  ci-gate:', '  ci-summary:')),
  );
  expect(codes(root)).toEqual(['required-context']);
});

it('rejects a required summary job that can be skipped', () => {
  const root = fixture((edit) =>
    edit('.github/workflows/ci.yml', (t) =>
      t.replace(
        '    if: always()\n    needs:\n      - verify-static',
        '    if: success()\n    needs:\n      - verify-static',
      ),
    ),
  );
  expect(codes(root)).toEqual(['required-job-condition']);
});

it('rejects a checkout in the pull_request_target workflow', () => {
  const root = fixture((edit) =>
    edit('.github/workflows/protected-paths.yml', (t) =>
      t.replace('    steps:\n', `    steps:\n      - uses: ${PINNED_CHECKOUT}\n`),
    ),
  );
  expect(codes(root)).toEqual(['prt-checkout', 'prt-uses']);
});

it('rejects a second pull_request_target workflow', () => {
  const root = fixture((edit) =>
    edit('.github/workflows/gitleaks.yml', (t) =>
      t.replace('  pull_request:\n', '  pull_request_target:\n'),
    ),
  );
  expect(codes(root)).toContain('prt-count');
});

it('rejects an embedded protected-paths list that is not valid JSON', () => {
  const root = fixture((edit) =>
    edit('.github/workflows/protected-paths.yml', (t) =>
      t.replace('"class3_gates": [', '"class3_gates": [,'),
    ),
  );
  expect(codes(root)).toEqual(['protected-json']);
});

it('rejects an embedded protected-paths list with an empty class', () => {
  const root = fixture((edit) =>
    edit('.github/workflows/protected-paths.yml', (t) =>
      t.replace(/"class1_add_only": \[[^\]]*\]/, '"class1_add_only": []'),
    ),
  );
  expect(codes(root)).toEqual(['protected-json']);
});

it('rejects a ruleset with bypass actors', () => {
  const root = fixture((edit) =>
    edit('ops/branch-protection.json', (t) =>
      t.replace(
        '"bypass_actors": []',
        '"bypass_actors": [{ "actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "always" }]',
      ),
    ),
  );
  expect(codes(root)).toEqual(['ruleset']);
});

it('rejects a required check that is not pinned to the Actions integration', () => {
  const root = fixture((edit) =>
    edit('ops/branch-protection.json', (t) =>
      t.replace('{ "context": "gitleaks", "integration_id": 15368 }', '{ "context": "gitleaks" }'),
    ),
  );
  expect(codes(root)).toEqual(['ruleset']);
});

it('rejects ubuntu-slim runners', () => {
  const root = fixture((edit) =>
    edit('.github/workflows/gitleaks.yml', (t) =>
      t.replace('runs-on: ubuntu-latest', 'runs-on: ubuntu-slim'),
    ),
  );
  expect(codes(root)).toEqual(['runs-on']);
});

it('rejects write permissions and permission shorthands', () => {
  const write = fixture((edit) =>
    edit('.github/workflows/ci.yml', (t) => t.replace('  contents: read', '  contents: write')),
  );
  const shorthand = fixture((edit) =>
    edit('.github/workflows/ci.yml', (t) =>
      t.replace('permissions:\n  contents: read', 'permissions: write-all'),
    ),
  );
  // ci.yml carries routed jobs (ADR-0004), so the routed-job read-only rule fires as well.
  expect([codes(write), codes(shorthand)]).toEqual([
    ['permissions', 'self-hosted-permissions'],
    ['permissions', 'self-hosted-permissions'],
  ]);
});

// ADR-0004 §2.6 (CT-06zzzzp): the self-hosted route.
const ROUTE_LINE = `    runs-on: ${SELF_HOSTED_ROUTE}\n`;

/** Text of the job block `id` (from its id line to the next job id line). */
function jobBlock(text: string, id: string): string {
  const start = text.indexOf(`\n  ${id}:\n`);
  if (start < 0) throw new Error(`job ${id} not found`);
  const next = text.slice(start + 1).search(/\n {2}[A-Za-z_][A-Za-z0-9_-]*:\s*(#.*)?\n/);
  return next < 0 ? text.slice(start) : text.slice(start, start + 1 + next + 1);
}

/** Replaces `from` with `to` inside the job block `id` only (exactly once). */
function inJob(text: string, id: string, from: string, to: string): string {
  const block = jobBlock(text, id);
  if (block.split(from).length !== 2) throw new Error(`${from} is not unique in ${id}`);
  return text.replace(block, block.replace(from, to));
}

it('the real ci.yml routes exactly the allowlisted jobs, every other job is ubuntu-latest', () => {
  expect(SELF_HOSTED_JOBS).toEqual({
    'ci.yml': ['verify-props-sha-1', 'verify-props-sha-2', 'verify-props-sha-3'],
  });
  expect(SELF_HOSTED_ROUTE).toBe(
    "${{ (vars.SELF_HOSTED_CI == 'on' && (github.event_name == 'push' || github.event.pull_request.head.repo.full_name == github.repository)) && fromJSON('[\"self-hosted\",\"couli-ci\"]') || 'ubuntu-latest' }}",
  );
  const text = readFileSync(join(REPO, '.github/workflows/ci.yml'), 'utf8');
  const routed = text
    .split('\n')
    .map((line, i, all) => ({ line, i, all }))
    .filter(({ line }) => line === ROUTE_LINE.slice(0, -1))
    .map(({ i, all }) => {
      for (let k = i - 1; k >= 0; k--) {
        const id = /^ {2}([A-Za-z_][A-Za-z0-9_-]*):\s*$/.exec(all[k] ?? '');
        if (id) return id[1];
      }
      return null;
    });
  expect(routed).toEqual(['verify-props-sha-1', 'verify-props-sha-2', 'verify-props-sha-3']);
  expect(checkWorkflows(REPO)).toEqual([]);
});

it('accepts a copy where the allowlisted jobs route and everything else is ubuntu-latest', () => {
  // Same as the real repo, plus an unrelated edit, to show the fixture path itself is clean.
  const root = fixture((edit) =>
    edit('.github/workflows/gitleaks.yml', (t) =>
      t.replace('runs-on: ubuntu-latest', "runs-on: 'ubuntu-latest'"),
    ),
  );
  expect(checkWorkflows(root)).toEqual([]);
});

it('rejects the routing expression with one character changed', () => {
  const variants = [
    SELF_HOSTED_ROUTE.replace("== 'on'", "== 'On'"),
    SELF_HOSTED_ROUTE.replace(' || ', ' ||  '),
    SELF_HOSTED_ROUTE.replace('couli-ci', 'couli_ci'),
    SELF_HOSTED_ROUTE.replace("'push'", "'pusH'"),
  ];
  const results = variants.map((variant) => {
    if (variant === SELF_HOSTED_ROUTE) throw new Error('variant equals the route');
    const root = fixture((edit) =>
      edit('.github/workflows/ci.yml', (t) =>
        inJob(t, 'verify-props-sha-2', ROUTE_LINE, `    runs-on: ${variant}\n`),
      ),
    );
    return codes(root);
  });
  // A broken expression is no longer the route: an unknown runs-on, and its runner label stands
  // outside the fixed expression.
  expect(results).toEqual(variants.map(() => ['runs-on', 'self-hosted-text']));
});

it('rejects the routing expression on a job that is not allowlisted', () => {
  const ciJob = fixture((edit) =>
    edit('.github/workflows/ci.yml', (t) =>
      inJob(t, 'verify-props-1', '    runs-on: ubuntu-latest\n', ROUTE_LINE),
    ),
  );
  const otherFile = fixture((edit) =>
    edit('.github/workflows/gitleaks.yml', (t) =>
      t.replace('    runs-on: ubuntu-latest\n', ROUTE_LINE),
    ),
  );
  expect([codes(ciJob), codes(otherFile)]).toEqual([['self-hosted-job'], ['self-hosted-job']]);
});

it('rejects self-hosted anywhere outside the routing expression', () => {
  const flowList = fixture((edit) =>
    edit('.github/workflows/gitleaks.yml', (t) =>
      t.replace('    runs-on: ubuntu-latest\n', '    runs-on: [self-hosted]\n'),
    ),
  );
  const blockList = fixture((edit) =>
    edit('.github/workflows/gitleaks.yml', (t) =>
      t.replace(
        '    runs-on: ubuntu-latest\n',
        '    runs-on:\n      - Self-Hosted\n      - couli-ci\n',
      ),
    ),
  );
  const comment = fixture((edit) =>
    edit('.github/workflows/ci.yml', (t) =>
      inJob(t, 'verify-props-sha-1', ROUTE_LINE, `    # runs on the self-hosted VM\n${ROUTE_LINE}`),
    ),
  );
  const trailing = fixture((edit) =>
    edit('.github/workflows/ci.yml', (t) =>
      inJob(
        t,
        'verify-props-sha-1',
        ROUTE_LINE,
        `    runs-on: ${SELF_HOSTED_ROUTE} # self-hosted\n`,
      ),
    ),
  );
  const step = fixture((edit) =>
    edit('.github/workflows/ci.yml', (t) =>
      inJob(
        t,
        'verify-props-1',
        '      - run: pnpm install --frozen-lockfile\n',
        '      - run: pnpm install --frozen-lockfile\n      - run: echo self-hosted\n',
      ),
    ),
  );
  expect([codes(flowList), codes(blockList), codes(comment), codes(trailing), codes(step)]).toEqual(
    [
      ['runs-on', 'self-hosted-text'],
      ['runs-on', 'self-hosted-text'],
      ['self-hosted-text'],
      ['runs-on', 'self-hosted-text'],
      ['self-hosted-text'],
    ],
  );
});

it('rejects write permissions on a routed job, at job level or workflow level', () => {
  const jobLevel = fixture((edit) =>
    edit('.github/workflows/ci.yml', (t) =>
      inJob(
        t,
        'verify-props-sha-3',
        '    timeout-minutes: 40\n',
        '    timeout-minutes: 40\n    permissions:\n      contents: write\n',
      ),
    ),
  );
  const workflowLevel = fixture((edit) =>
    edit('.github/workflows/ci.yml', (t) =>
      t.replace(
        'permissions:\n  contents: read\n',
        'permissions:\n  contents: read\n  checks: write\n',
      ),
    ),
  );
  // The repo-wide no-write rule (`permissions`) fires as well; the routed-job rule is separate.
  expect([codes(jobLevel), codes(workflowLevel)]).toEqual([
    ['permissions', 'self-hosted-permissions'],
    ['permissions', 'self-hosted-permissions'],
  ]);
  const routedLines = checkWorkflows(workflowLevel)
    .filter((p) => p.code === 'self-hosted-permissions')
    .map((p) => p.message);
  expect(routedLines.length).toBe(3);
});

it('rejects a routed job that references secrets', () => {
  const dotted = fixture((edit) =>
    edit('.github/workflows/ci.yml', (t) =>
      inJob(
        t,
        'verify-props-sha-1',
        "          PROP_RUNS: '100000'\n",
        "          PROP_RUNS: '100000'\n          TOKEN: ${{ secrets.NPM_TOKEN }}\n",
      ),
    ),
  );
  const indexed = fixture((edit) =>
    edit('.github/workflows/ci.yml', (t) =>
      inJob(
        t,
        'verify-props-sha-2',
        "          PROP_RUNS: '100000'\n",
        "          PROP_RUNS: '100000'\n          TOKEN: ${{ SECRETS['NPM_TOKEN'] }}\n",
      ),
    ),
  );
  const inherited = fixture((edit) =>
    edit('.github/workflows/ci.yml', (t) =>
      t.replace(
        'env:\n  NODE_OPTIONS: --max-old-space-size=8192\n',
        'env:\n  NODE_OPTIONS: --max-old-space-size=8192\n  TOKEN: ${{ secrets.NPM_TOKEN }}\n',
      ),
    ),
  );
  const unrouted = fixture((edit) =>
    edit('.github/workflows/ci.yml', (t) =>
      inJob(
        t,
        'verify-props-1',
        "          PROP_RUNS: '100000'\n",
        "          PROP_RUNS: '100000'\n          TOKEN: ${{ secrets.NPM_TOKEN }}\n",
      ),
    ),
  );
  // Top-level env written after the jobs block is inherited all the same (Codex r1 S2).
  const inheritedAfterJobs = fixture((edit) =>
    edit(
      '.github/workflows/ci.yml',
      (t) =>
        `${t.replace('env:\n  NODE_OPTIONS: --max-old-space-size=8192\n', '').replace(/\n*$/, '\n')}` +
        'env:\n  NODE_OPTIONS: --max-old-space-size=8192\n  TOKEN: ${{ secrets.NPM_TOKEN }}\n',
    ),
  );
  expect(codes(inheritedAfterJobs)).toEqual(['self-hosted-secrets']);
  expect([codes(dotted), codes(indexed), codes(inherited), codes(unrouted)]).toEqual([
    ['self-hosted-secrets'],
    ['self-hosted-secrets'],
    ['self-hosted-secrets'],
    [],
  ]);
});

it('rejects the routing expression in a pull_request_target or workflow_run workflow', () => {
  const prt = fixture((edit) =>
    edit('.github/workflows/protected-paths.yml', (t) =>
      t.replace('    runs-on: ubuntu-latest\n', ROUTE_LINE),
    ),
  );
  const workflowRun = fixture((edit) =>
    edit('.github/workflows/ci.yml', (t) =>
      t.replace(
        'on:\n  pull_request:\n',
        'on:\n  workflow_run:\n    workflows: [contracts]\n  pull_request:\n',
      ),
    ),
  );
  expect(codes(prt)).toEqual(['self-hosted-job', 'self-hosted-trigger']);
  expect(codes(workflowRun)).toEqual(['self-hosted-trigger']);
});

it('still rejects ubuntu-slim and other runners on routed and unrouted jobs', () => {
  const routedJob = fixture((edit) =>
    edit('.github/workflows/ci.yml', (t) =>
      inJob(t, 'verify-props-sha-1', ROUTE_LINE, '    runs-on: ubuntu-slim\n'),
    ),
  );
  const variable = fixture((edit) =>
    edit('.github/workflows/ci.yml', (t) =>
      inJob(t, 'verify-props-sha-1', ROUTE_LINE, '    runs-on: ${{ vars.RUNNER }}\n'),
    ),
  );
  const twice = fixture((edit) =>
    edit('.github/workflows/ci.yml', (t) =>
      inJob(t, 'verify-props-sha-1', ROUTE_LINE, `${ROUTE_LINE}    runs-on: ubuntu-latest\n`),
    ),
  );
  expect([codes(routedJob), codes(variable)]).toEqual([['runs-on'], ['runs-on']]);
  expect(codes(twice)).toContain('runs-on');
});

it('CLI exit codes: 0 for the real repo, 1 for a broken copy, 2 for bad usage', () => {
  const broken = fixture((edit) =>
    edit('.github/workflows/ci.yml', (t) => t.replace(PINNED_CHECKOUT, 'actions/checkout@main')),
  );
  const run = (args: string[]) =>
    spawnSync(process.execPath, [join(REPO, 'tools/ci/check-workflows.ts'), ...args], {
      encoding: 'utf8',
    });
  const ok = run(['--json']);
  const bad = run(['--root', broken, '--json']);
  const usage = run(['--nope']);
  expect([ok.status, bad.status, usage.status]).toEqual([0, 1, 2]);
  expect(JSON.parse(ok.stdout)).toEqual({ ok: true, problems: [] });
  expect((JSON.parse(bad.stdout) as { ok: boolean }).ok).toBe(false);
}, 60_000);
