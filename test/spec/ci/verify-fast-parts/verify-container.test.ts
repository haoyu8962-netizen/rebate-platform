import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  CLI_TIMEOUT,
  fixtureGit,
  removeDir,
  scratchDir,
  writeFiles,
} from '../../../../tools/ops/test-helpers.ts';
import {
  FAST_STEPS,
  ROOT,
  TASK,
  fastJobs,
  job,
  packageJson,
  specCommand,
  unitCommand,
  workflow,
} from './kit.ts';

const PART_ARGS = ['--fast-part', 'base'];
const INT_REST = "pnpm test:int --log-order=stream --filter='!@couli/spec-tests'";

let base: string;
let trusted: string;
let worktree: string;
beforeAll(() => {
  base = scratchDir('fast parts container');
  trusted = join(base, 'trusted checkout');
  worktree = join(base, 'task checkout');
  writeFiles(trusted, {
    'package.json': packageJson(),
    '.github/workflows/ci.yml': workflow(
      ...fastJobs(2),
      job(
        'verify-int-1',
        'pnpm test:int --log-order=stream --filter=@couli/spec-tests -- --shard=1/1',
        INT_REST,
      ),
    ),
  });
  // The real script requires its own location to be the trusted root.
  const script = 'tools/ops/verify-container.sh';
  mkdirSync(join(trusted, 'tools', 'ops'), { recursive: true });
  cpSync(join(ROOT, script), join(trusted, script));
  for (const dir of ['tools/ci', 'tools/lib']) {
    cpSync(join(ROOT, dir), join(trusted, dir), { recursive: true });
  }
  writeFiles(worktree, {
    'package.json': packageJson({ 'verify:fast': 'pnpm run lint && pnpm run test' }),
    '.github/workflows/ci.yml': workflow(...fastJobs(3, '@fixture/other')),
  });
  fixtureGit(worktree, ['init', '-q']);
  fixtureGit(worktree, ['add', '.']);
  fixtureGit(worktree, ['commit', '-qm', 'fixture snapshot']);
  writeFiles(base, {
    'bin/docker': '#!/bin/sh\nprintf "%s\\n" "$*" >> "$FAST_PART_TEST_DOCKER_LOG"\nexit 99\n',
  });
  chmodSync(join(base, 'bin/docker'), 0o755);
});
afterAll(() => removeDir(base));

function dryRun(...args: string[]) {
  const dockerLog = join(base, 'docker.log');
  const script = join(trusted, 'tools/ops/verify-container.sh');
  const cli = spawnSync('bash', [script, TASK, '--worktree', worktree, ...args, '--dry-run'], {
    cwd: worktree,
    encoding: 'utf8',
    timeout: 5_000,
    env: {
      ...process.env,
      PATH: `${join(base, 'bin')}:${process.env['PATH'] ?? ''}`,
      COULI_RUNS: join(base, 'runs'),
      COULI_TRUSTED_ROOT: trusted,
      FAST_PART_TEST_DOCKER_LOG: dockerLog,
    },
  });
  expect(existsSync(dockerLog), 'dry-run does not call Docker').toBe(false);
  return cli;
}

function plan(cli: ReturnType<typeof dryRun>): unknown {
  expect(cli.status, cli.stderr).toBe(0);
  expect(cli.stdout.trimEnd().split('\n')).toHaveLength(1);
  return JSON.parse(cli.stdout) as unknown;
}

it.each([
  ['base', ['pnpm run typecheck', unitCommand(), 'pnpm run guard:static']],
  ['spec-1', [specCommand(1, 2)]],
  ['spec-2', [specCommand(2, 2)]],
] as const)(
  '[AC-CT-06zzzzzzzb#5] dry-run prints only the trusted commands for %s',
  (part, commands) => {
    expect(plan(dryRun('--fast-part', part))).toHaveProperty('fast_part', { part, commands });
  },
  CLI_TIMEOUT,
);

it(
  '[AC-CT-06zzzzzzzb#6] whole fast dry-run lists the trusted verify:fast steps in execution order',
  () => {
    expect(plan(dryRun('--fast'))).toMatchObject({ script: 'verify:fast', steps: FAST_STEPS });
  },
  CLI_TIMEOUT,
);

it(
  '[AC-CT-06zzzzzzzb#7] rejects missing or unknown parts including one defined only by the task checkout',
  () => {
    expect(plan(dryRun(...PART_ARGS))).toHaveProperty('fast_part.part', 'base');
    for (const args of [['--fast-part'], ['--fast-part', 'spec-3'], ['--fast-part', 'unknown']]) {
      const cli = dryRun(...args);
      expect(cli.status, cli.stderr).toBe(2);
    }
  },
  CLI_TIMEOUT,
);

const conflicts = [
  ['--fast', []],
  ['--red', []],
  ['--related', []],
  ['--browser', []],
  ['--tests', ['test/spec']],
  ['--int-shard', ['1']],
  ['--base', ['HEAD']],
] as const;

it.each(conflicts)(
  '[AC-CT-06zzzzzzzb#8] rejects a fast part combined with %s in either order',
  (flag, values) => {
    expect(plan(dryRun(...PART_ARGS))).toHaveProperty('fast_part.part', 'base');
    const other = [flag, ...values];
    for (const args of [
      [...PART_ARGS, ...other],
      [...other, ...PART_ARGS],
    ]) {
      const cli = dryRun(...args);
      expect(cli.status, cli.stderr).toBe(2);
    }
  },
  CLI_TIMEOUT,
);
