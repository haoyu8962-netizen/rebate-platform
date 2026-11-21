import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  CLI_TIMEOUT,
  removeDir,
  runCli,
  scratchDir,
  writeFiles,
} from '../../../../tools/ops/test-helpers.ts';

const ROOT = resolve(import.meta.dirname, '../../../..');
const CLI = 'verify-sharded-summary.ts';
const TASK = 'CT-06zzzzzzza';
const TREE = 'a'.repeat(40);
const OTHER_TREE = 'b'.repeat(40);
const STARTED = '2026-11-22T10:00:00Z';
const FINISHED = '2026-11-22T10:00:10Z';
const LATER = '2026-11-22T10:00:20Z';
const REST = "pnpm test:int --log-order=stream --filter='!@couli/spec-tests'";

const WORKFLOW = `jobs:
  verify-int-1:
    runs-on: ubuntu-latest
    steps:
      - run: pnpm test:int --log-order=stream --filter=@couli/spec-tests -- --shard=1/2
  verify-int-2:
    runs-on: ubuntu-latest
    steps:
      - run: pnpm test:int --log-order=stream --filter=@couli/spec-tests -- --shard=2/2
      - run: ${REST}
`;

let base: string;
beforeEach(() => {
  base = scratchDir('int-shard-summary');
  writeFiles(base, { 'ci.yml': WORKFLOW });
});
afterEach(() => removeDir(base));

type RunOverrides = {
  tree?: string;
  exit_code?: number;
  started_at?: string;
  finished_at?: string;
};
type SegmentOverrides = RunOverrides & {
  files?: number;
  tests?: number;
  int_files_total?: number;
};

const COMMON = {
  mode: 'container',
  commit: 'c'.repeat(40),
  tree: TREE,
  exit_code: 0,
  started_at: STARTED,
  finished_at: FINISHED,
};

function writeResult(mode: 'verify-fast' | 'int-shard', run: number, result: object): void {
  writeFiles(base, {
    [`runs/${TASK}/${mode}/${run}/result.json`]: JSON.stringify(result),
  });
}

function fast(run: number, overrides: RunOverrides = {}): void {
  writeResult('verify-fast', run, {
    ...COMMON,
    script: 'verify:fast',
    prop_seed: 20261001,
    prop_runs: null,
    ...overrides,
  });
}

function shard(run: number, segment: string, overrides: SegmentOverrides = {}): void {
  const command =
    segment === 'rest'
      ? REST
      : `pnpm test:int --log-order=stream --filter=@couli/spec-tests -- --shard=${segment}/2`;
  writeResult('int-shard', run, {
    ...COMMON,
    script: 'int-shard',
    segment,
    command,
    files: 2,
    tests: 8,
    int_files_total: 6,
    ...overrides,
  });
}

function summarize(...args: string[]) {
  expect(existsSync(join(ROOT, 'tools/ops', CLI)), 'sharded summary CLI exists').toBe(true);
  return runCli(CLI, [TASK, '--runs', join(base, 'runs'), '--json', ...args]);
}

function report(exit: number) {
  const cli = summarize('--tree', TREE, '--workflow', join(base, 'ci.yml'));
  expect(cli.status, cli.stderr || cli.stdout).toBe(exit);
  return JSON.parse(cli.stdout) as { problems: string[] };
}

it(
  '[AC-CT-06zzzzzzza#10] reports a green tree with ordered segments, durations and counts',
  () => {
    fast(1);
    shard(1, 'rest', { files: 1, tests: 4, finished_at: '2026-11-22T10:00:02Z' });
    shard(2, '2', { files: 2, tests: 9, finished_at: '2026-11-22T10:00:05Z' });
    shard(3, '1', { files: 3, tests: 11 });

    expect(report(0)).toMatchObject({
      task: TASK,
      tree: TREE,
      status: 'green',
      fast: expect.anything(),
      segments: [
        { segment: '1', exit_code: 0, files: 3, tests: 11, duration_s: 10 },
        { segment: '2', exit_code: 0, files: 2, tests: 9, duration_s: 5 },
        { segment: 'rest', exit_code: 0, files: 1, tests: 4, duration_s: 2 },
      ],
      totals: { files: 6, tests: 24, int_files_total: 6 },
      problems: [],
    });
  },
  CLI_TIMEOUT,
);

it(
  '[AC-CT-06zzzzzzza#11] selects by finished_at after restricting both kinds of run to the requested tree',
  () => {
    fast(1, { finished_at: LATER });
    fast(8, { exit_code: 1, started_at: '2026-11-22T10:00:05Z' });
    fast(9, { tree: OTHER_TREE, exit_code: 1, finished_at: '2026-11-22T11:00:00Z' });
    shard(1, '1', { finished_at: LATER });
    shard(2, '2');
    shard(3, 'rest');
    shard(8, '1', { files: 0, exit_code: 1, started_at: '2026-11-22T10:00:05Z' });
    shard(9, 'rest', { tree: OTHER_TREE, files: 0, exit_code: 1, finished_at: LATER });

    expect(report(0)).toMatchObject({
      status: 'green',
      segments: [
        { segment: '1', exit_code: 0, duration_s: 20 },
        { segment: '2', exit_code: 0 },
        { segment: 'rest', exit_code: 0 },
      ],
      totals: { files: 6, tests: 24, int_files_total: 6 },
      problems: [],
    });
  },
  CLI_TIMEOUT,
);

it(
  '[AC-CT-06zzzzzzza#12] reports each missing or failed result without borrowing results from another tree',
  () => {
    fast(1, { tree: OTHER_TREE });
    shard(1, '1');
    shard(2, '2', { tree: OTHER_TREE });
    shard(3, 'rest', { exit_code: 124 });

    const timedOut = expect.objectContaining({ segment: 'rest', exit_code: 124 });
    const summary = report(1);
    expect(summary).toMatchObject({
      task: TASK,
      tree: TREE,
      status: 'red',
      segments: expect.arrayContaining([timedOut]),
      problems: expect.arrayContaining([
        expect.stringMatching(/fast/i),
        expect.stringMatching(/\b2\b/),
        expect.stringMatching(/rest/i),
      ]),
    });
    expect(summary.problems.length).toBeGreaterThanOrEqual(3);
  },
  CLI_TIMEOUT,
);

it(
  '[AC-CT-06zzzzzzza#13] uses the latest failure instead of an earlier green run of the same tree',
  () => {
    fast(1);
    fast(2, { exit_code: 17, finished_at: LATER });
    shard(1, '1');
    shard(2, '2');
    shard(3, 'rest');
    shard(4, '1', { exit_code: 124, finished_at: LATER });

    const problems = [expect.stringMatching(/fast/i), expect.stringMatching(/\b1\b/)];
    const summary = report(1);
    expect(summary).toMatchObject({
      status: 'red',
      segments: [
        { segment: '1', exit_code: 124 },
        { segment: '2', exit_code: 0 },
        { segment: 'rest', exit_code: 0 },
      ],
      problems: expect.arrayContaining(problems),
    });
    expect(summary.problems).toHaveLength(2);
  },
  CLI_TIMEOUT,
);

it(
  '[AC-CT-06zzzzzzza#14] rejects disagreement about the total even when the file sum matches two segments',
  () => {
    fast(1);
    shard(1, '1');
    shard(2, '2', { int_files_total: 7 });
    shard(3, 'rest');

    const totalProblem = expect.stringMatching(/total|总数|总量|总文件|总计/i);
    expect(report(1)).toMatchObject({
      status: 'red',
      problems: expect.arrayContaining([totalProblem]),
    });
  },
  CLI_TIMEOUT,
);

it.each([5, 7])(
  '[AC-CT-06zzzzzzza#15] rejects a common total of %i when six files actually ran',
  (total) => {
    fast(1);
    shard(1, '1', { int_files_total: total });
    shard(2, '2', { int_files_total: total });
    shard(3, 'rest', { int_files_total: total });

    expect(report(1)).toMatchObject({
      status: 'red',
      totals: { files: 6, tests: 24, int_files_total: total },
      problems: expect.arrayContaining([expect.stringMatching(/files?|文件/i)]),
    });
  },
  CLI_TIMEOUT,
);

it(
  '[AC-CT-06zzzzzzza#16] returns usage error for a missing tree or an unreadable or invalid workflow',
  () => {
    const workflow = join(base, 'ci.yml');
    expect(summarize('--workflow', workflow).status).toBe(2);
    expect(summarize('--tree', TREE, '--workflow', join(base, 'missing.yml')).status).toBe(2);
    writeFiles(base, { 'ci.yml': WORKFLOW.replace(`      - run: ${REST}\n`, '') });
    expect(summarize('--tree', TREE, '--workflow', workflow).status).toBe(2);
  },
  CLI_TIMEOUT,
);
