import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { CLI_TIMEOUT, writeFiles } from '../../../../tools/ops/test-helpers.ts';
import {
  FROZEN_TEST,
  NEW_TEST,
  NEW_TITLE,
  ROOT,
  TASK,
  TIGHTER_BLOCK,
  cleanup,
  commit,
  fixture,
  removeLedger,
  ruleTestCommit,
} from './kit.ts';

afterEach(cleanup);

// Simulate a ready image and store, and copy a canned report into the offline red mount.
// The real test-guard, red-check and evidence-check still run.
const DOCKER_STUB = [
  '#!/bin/bash',
  'set -eu',
  'if [[ "$1" == run && "${@: -1}" == red ]]; then',
  '  for arg in "$@"; do',
  '    case "$arg" in',
  '      *:/out) cp "$EVIDENCE_SHAPE_TEST_REPORT" "${arg%:/out}/spec-unit.json"; exit 0 ;;',
  '    esac',
  '  done',
  '  exit 2',
  'fi',
  'exit 0',
  '',
].join('\n');

function runRed(fx: ReturnType<typeof fixture>, status: 'dry-run' | 'failed' | 'passed') {
  const trusted = realpathSync(ROOT);
  const runs = join(fx.root, 'runs');
  const docker = join(fx.root, 'bin', 'docker');
  const report = join(fx.root, 'fixture-report.json');
  writeFiles(fx.root, {
    'bin/docker': status === 'dry-run' ? '#!/bin/bash\nexit 2\n' : DOCKER_STUB,
    'fixture-report.json': JSON.stringify({
      testResults: [
        {
          name: `/work/repo/${NEW_TEST}`,
          assertionResults: [
            {
              fullName: NEW_TITLE,
              status,
              failureMessages: status === 'failed' ? ['AssertionError: expected 1 to be 2'] : [],
            },
          ],
        },
      ],
    }),
  });
  chmodSync(docker, 0o755);

  const result = spawnSync(
    'bash',
    [
      join(trusted, 'tools/ops/verify-container.sh'),
      TASK,
      '--worktree',
      fx.repo,
      '--red',
      '--base',
      fx.base,
      ...(status === 'dry-run' ? ['--dry-run'] : []),
    ],
    {
      cwd: trusted,
      encoding: 'utf8',
      timeout: CLI_TIMEOUT,
      env: {
        ...process.env,
        PATH: `${join(fx.root, 'bin')}:${process.env['PATH'] ?? ''}`,
        COULI_RUNS: runs,
        COULI_TRUSTED_ROOT: trusted,
        COULI_VERIFY_HOST_SERVICES: '',
        EVIDENCE_SHAPE_TEST_REPORT: report,
      },
    },
  );
  return { result, redDir: join(runs, TASK, 'red', '1') };
}

it(
  '[AC-CT-06#10] includes the evidence-check arguments in the red dry-run plan',
  () => {
    const fx = fixture('dry-run');
    const spec = ruleTestCommit(fx.repo);
    const { result, redDir } = runRed(fx, 'dry-run');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trimEnd().split('\n')).toHaveLength(1);
    const plan = JSON.parse(result.stdout) as { evidence_shape?: string[] };
    expect(plan).toHaveProperty('evidence_shape', expect.any(Array));
    const args = plan.evidence_shape ?? [];
    expect(args).toEqual(expect.arrayContaining(['--early', '--json']));
    for (const [flag, value] of [
      ['--pr', realpathSync(fx.repo)],
      ['--task', TASK],
      ['--base', fx.base],
      ['--spec', spec],
    ] as const) {
      expect(args, flag).toContain(flag);
      expect(args[args.indexOf(flag) + 1], flag).toBe(value);
    }
    expect(existsSync(redDir)).toBe(false);
  },
  CLI_TIMEOUT,
);

it(
  '[AC-CT-06#11] records evidence problems while a valid red verdict still exits zero',
  () => {
    const fx = fixture('red-with-shape-problem');
    const spec = ruleTestCommit(fx.repo, { [FROZEN_TEST]: TIGHTER_BLOCK });
    const { result, redDir } = runRed(fx, 'failed');
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ exit_code: 0, commit: spec });

    const report = join(redDir, 'evidence-shape.json');
    expect(existsSync(report)).toBe(true);
    expect(JSON.parse(readFileSync(report, 'utf8'))).toMatchObject({
      task: TASK,
      base: fx.base,
      spec,
      problems: [expect.stringContaining(FROZEN_TEST)],
    });
    expect(readFileSync(join(redDir, 'log.txt'), 'utf8').trimEnd().split('\n').at(-1)).toMatch(
      /evidence shape: 1 problem\(s\)$/,
    );
  },
  CLI_TIMEOUT,
);

it(
  '[AC-CT-06#12] logs an unreadable spec ledger and keeps the failing red verdict',
  () => {
    const fx = fixture('red-without-ledger');
    ruleTestCommit(fx.repo);
    removeLedger(fx.repo);
    const spec = commit(fx.repo, 'remove fixture ledger before the red run');
    const { result, redDir } = runRed(fx, 'passed');
    expect(result.status, result.stderr).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ exit_code: 1, commit: spec });

    const log = readFileSync(join(redDir, 'log.txt'), 'utf8').trimEnd().split('\n');
    expect(log.filter((line) => line.includes('evidence shape:'))).toEqual([
      expect.stringMatching(/evidence shape: not checked \(exit 2\)$/),
    ]);
    const report = join(redDir, 'evidence-shape.json');
    if (existsSync(report)) expect(readFileSync(report, 'utf8').trim()).toBe('');
  },
  CLI_TIMEOUT,
);
