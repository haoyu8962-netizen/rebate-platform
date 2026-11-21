// CT-06zzzzzzza (FU-VERIFY-FULL-SHARDED, D10-2443 ② ③): unit tests of
// tools/ops/verify-sharded-summary.ts — one verdict for a tree from its verify-fast run and the
// --int-shard segments of the same tree.
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { IntShards } from '../ci/int-shards.ts';
import { CLI_TIMEOUT, removeDir, runCli, scratchDir, writeFiles } from './test-helpers.ts';
import { notCoveredSteps, summarize } from './verify-sharded-summary.ts';

const TASK = 'V1-01';
const TREE = '1'.repeat(40);
const OTHER = '2'.repeat(40);
const SHARDS: IntShards = {
  n: 1,
  segments: [
    { id: '1', command: 'pnpm test:int --filter=@couli/spec-tests -- --shard=1/1' },
    { id: 'rest', command: "pnpm test:int --filter='!@couli/spec-tests'" },
  ],
};
const WORKFLOW = `jobs:
  verify-int-1:
    steps:
      - run: ${SHARDS.segments[0]?.command ?? ''}
      - run: ${SHARDS.segments[1]?.command ?? ''}
`;

let base = '';
let runs = '';
beforeEach(() => {
  base = scratchDir('sharded-summary-unit');
  runs = join(base, 'runs');
  writeFiles(base, { 'ci.yml': WORKFLOW });
});
afterEach(() => removeDir(base));

function put(kind: 'verify-fast' | 'int-shard' | 'browser', run: number, doc: unknown): void {
  writeFiles(runs, {
    [`${TASK}/${kind}/${String(run)}/result.json`]:
      typeof doc === 'string' ? doc : JSON.stringify(doc),
  });
}
const times = { started_at: '2026-11-22T00:00:00Z', finished_at: '2026-11-22T00:01:30Z' };
const ROOT_VERIFY =
  'pnpm run verify:fast && pnpm run test:int && pnpm --filter @couli/spec-tests run test:browser' +
  ' && pnpm --filter @couli/spec-tests run test:smoke && pnpm run db:check';
const fast = (run: number, extra: object = {}) =>
  put('verify-fast', run, { script: 'verify:fast', tree: TREE, exit_code: 0, ...times, ...extra });
const seg = (run: number, segment: string, extra: object = {}) =>
  put('int-shard', run, {
    script: 'int-shard',
    segment,
    tree: TREE,
    exit_code: 0,
    files: 2,
    tests: 7,
    int_files_total: 4,
    ...times,
    ...extra,
  });

it('[CT-06zzzzzzza] green: fast and every segment exit 0, totals agree and add up', () => {
  fast(1);
  seg(1, '1');
  seg(2, 'rest', { files: 2, tests: 3 });
  expect(summarize(TASK, TREE, runs, SHARDS)).toEqual({
    task: TASK,
    tree: TREE,
    status: 'green',
    fast: { run: 1, exit_code: 0, ...times },
    segments: [
      { segment: '1', run: 1, exit_code: 0, files: 2, tests: 7, duration_s: 90 },
      { segment: 'rest', run: 2, exit_code: 0, files: 2, tests: 3, duration_s: 90 },
    ],
    totals: { files: 4, tests: 10, int_files_total: 4 },
    problems: [],
    scope: 'fast+test:int',
    not_covered: [],
    browser: null,
  });
});

it('[CT-06zzzzzzza] other trees, unknown segments and runs without result.json are left out', () => {
  fast(1);
  seg(1, '1');
  seg(2, 'rest');
  fast(3, { tree: OTHER, exit_code: 1, finished_at: '2026-11-23T00:00:00Z' });
  seg(4, 'rest', { tree: OTHER, exit_code: 1, finished_at: '2026-11-23T00:00:00Z' });
  seg(5, '2', { exit_code: 1 }); // not a segment of this workflow
  writeFiles(runs, { [`${TASK}/int-shard/6/log.txt`]: 'still running\n' });
  writeFiles(runs, { [`${TASK}/int-shard/notes/result.json`]: '{}' });
  expect(summarize(TASK, TREE, runs, SHARDS).status).toBe('green');
});

it('[CT-06zzzzzzza] the latest run of a segment decides; a tie goes to the higher run number', () => {
  fast(1);
  seg(1, '1', { exit_code: 1, finished_at: '2026-11-22T00:05:00Z' });
  seg(2, '1');
  seg(3, 'rest');
  seg(4, 'rest', { exit_code: 1 });
  const s = summarize(TASK, TREE, runs, SHARDS);
  expect(s.status).toBe('red');
  expect(s.segments.map((x) => [x.segment, x.run, x.exit_code])).toEqual([
    ['1', 1, 1],
    ['rest', 4, 1],
  ]);
  expect(s.problems).toEqual(['segment 1 (run 1) exit 1', 'segment rest (run 4) exit 1']);
});

it('[CT-06zzzzzzza] red with one problem per reason', () => {
  seg(1, '1', { int_files_total: 5 });
  expect(summarize(TASK, TREE, runs, SHARDS).problems).toEqual([
    'missing verify-fast result for this tree',
    'missing segment rest',
  ]);
  fast(1, { exit_code: 2 });
  seg(2, 'rest');
  expect(summarize(TASK, TREE, runs, SHARDS).problems).toEqual([
    'verify-fast run 1 exit 2',
    'the segments disagree on int_files_total: 1=5, rest=4',
  ]);
  seg(3, '1', { files: 1 });
  expect(summarize(TASK, TREE, runs, SHARDS).problems).toEqual([
    'verify-fast run 1 exit 2',
    'the segments ran 3 files in sum, int_files_total is 4',
  ]);
  put('int-shard', 4, { tree: TREE, segment: 'rest', exit_code: 0 });
  put('verify-fast', 2, '{not json');
  expect(summarize(TASK, TREE, runs, SHARDS).problems).toContain(
    'int-shard run 4: result.json of this tree is malformed',
  );
});

it(
  '[CT-06zzzzzzza] CLI: exit 0 green / 1 red with the JSON on stdout; 2 for usage or a bad workflow',
  () => {
    const args = (...extra: string[]) => [
      TASK,
      '--runs',
      runs,
      '--workflow',
      join(base, 'ci.yml'),
      ...extra,
    ];
    fast(1);
    seg(1, '1');
    const red = runCli('verify-sharded-summary.ts', args('--tree', TREE, '--json'));
    expect(red.status, red.stderr).toBe(1);
    expect(JSON.parse(red.stdout)).toMatchObject({
      status: 'red',
      problems: ['missing segment rest'],
    });
    expect(red.stderr).toContain('missing segment rest');
    seg(2, 'rest');
    const green = runCli('verify-sharded-summary.ts', args('--tree', TREE));
    expect(green.status, green.stderr).toBe(0);
    expect(JSON.parse(green.stdout)).toMatchObject({ status: 'green', totals: { files: 4 } });

    writeFiles(base, { 'bad.yml': 'jobs:\n  build:\n    steps: []\n' });
    for (const bad of [
      [TASK, '--runs', runs, '--workflow', join(base, 'ci.yml')],
      args('--tree', 'not-a-tree'),
      args('--tree'),
      ['bad id', '--tree', TREE, '--runs', runs, '--workflow', join(base, 'ci.yml')],
      args('--tree', TREE, '--bogus'),
      [TASK, '--tree', TREE, '--runs', runs, '--workflow', join(base, 'bad.yml')],
      [TASK, '--tree', TREE, '--runs', runs, '--workflow', join(base, 'missing.yml')],
    ]) {
      const res = runCli('verify-sharded-summary.ts', bad);
      expect(res.status, bad.join(' ')).toBe(2);
      expect(res.stdout, bad.join(' ')).toBe('');
    }
  },
  CLI_TIMEOUT,
);

it('[CT-06zzzzzzza] notCoveredSteps: the root verify steps besides verify:fast and test:int', () => {
  expect(notCoveredSteps(JSON.stringify({ scripts: { verify: ROOT_VERIFY } }))).toEqual([
    'test:browser',
    'test:smoke',
    'db:check',
  ]);
  expect(() => notCoveredSteps('{}')).toThrow(/verify/);
  expect(() =>
    notCoveredSteps(JSON.stringify({ scripts: { verify: 'pnpm run test:int' } })),
  ).toThrow(/verify:fast/);
  expect(() => notCoveredSteps('{not json')).toThrow();
});

it('[CT-06zzzzzzza] scope and not_covered; --browser of the same tree with exit 0 covers test:browser', () => {
  const steps = ['test:browser', 'test:smoke', 'db:check'];
  fast(1);
  seg(1, '1');
  seg(2, 'rest');
  const plain = summarize(TASK, TREE, runs, SHARDS, { notCovered: steps, browser: false });
  expect(plain).toMatchObject({ status: 'green', scope: 'fast+test:int', browser: null });
  expect(plain.not_covered).toEqual(steps);

  put('browser', 1, { script: 'browser', tree: TREE, exit_code: 0, ...times });
  put('browser', 2, {
    script: 'browser',
    tree: OTHER,
    exit_code: 1,
    finished_at: '2026-11-23T00:00:00Z',
    started_at: times.started_at,
  });
  const covered = summarize(TASK, TREE, runs, SHARDS, { notCovered: steps, browser: true });
  expect(covered).toMatchObject({
    status: 'green',
    scope: 'fast+test:int+test:browser',
    browser: { run: 1, exit_code: 0 },
  });
  expect(covered.not_covered).toEqual(['test:smoke', 'db:check']);
  // Without --browser the browser run is not read.
  expect(
    summarize(TASK, TREE, runs, SHARDS, { notCovered: steps, browser: false }).not_covered,
  ).toEqual(steps);

  // The latest browser run of the tree failed: test:browser stays uncovered; status is unchanged.
  put('browser', 3, {
    script: 'browser',
    tree: TREE,
    exit_code: 1,
    ...times,
    finished_at: '2026-11-22T00:09:00Z',
  });
  const failed = summarize(TASK, TREE, runs, SHARDS, { notCovered: steps, browser: true });
  expect(failed).toMatchObject({
    status: 'green',
    scope: 'fast+test:int',
    browser: { run: 3, exit_code: 1 },
  });
  expect(failed.not_covered).toEqual(steps);
});

it(
  '[CT-06zzzzzzza] CLI: not_covered from --package-json; one without a usable verify script exits 2',
  () => {
    writeFiles(base, {
      'package.json': JSON.stringify({ scripts: { verify: ROOT_VERIFY } }),
      'bad-package.json': JSON.stringify({ scripts: { verify: 'pnpm run lint' } }),
    });
    fast(1);
    seg(1, '1');
    seg(2, 'rest');
    put('browser', 1, { script: 'browser', tree: TREE, exit_code: 0, ...times });
    const args = (pkg: string, ...extra: string[]) => [
      TASK,
      '--tree',
      TREE,
      '--runs',
      runs,
      '--workflow',
      join(base, 'ci.yml'),
      '--package-json',
      join(base, pkg),
      ...extra,
    ];
    const ok = runCli('verify-sharded-summary.ts', args('package.json'));
    expect(ok.status, ok.stderr).toBe(0);
    expect(JSON.parse(ok.stdout)).toMatchObject({
      scope: 'fast+test:int',
      not_covered: ['test:browser', 'test:smoke', 'db:check'],
    });
    const withBrowser = runCli('verify-sharded-summary.ts', args('package.json', '--browser'));
    expect(withBrowser.status, withBrowser.stderr).toBe(0);
    expect(JSON.parse(withBrowser.stdout)).toMatchObject({
      scope: 'fast+test:int+test:browser',
      not_covered: ['test:smoke', 'db:check'],
    });
    // The default (with --workflow): this checkout's root package.json.
    const own = runCli('verify-sharded-summary.ts', args('package.json').slice(0, -2));
    expect(own.status, own.stderr).toBe(0);
    expect(JSON.parse(own.stdout)).toMatchObject({
      not_covered: ['test:browser', 'test:smoke', 'db:check'],
    });
    for (const pkg of ['bad-package.json', 'missing.json']) {
      const res = runCli('verify-sharded-summary.ts', args(pkg));
      expect(res.status, pkg).toBe(2);
      expect(res.stdout, pkg).toBe('');
    }
  },
  CLI_TIMEOUT,
);
