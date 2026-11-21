import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  CLI_TIMEOUT,
  fixtureGit,
  removeDir,
  scratchDir,
  writeFiles,
} from '../../../../tools/ops/test-helpers.ts';

const ROOT = resolve(import.meta.dirname, '../../../..');
const TASK = 'CT-06zzzzzzza';
const FIRST = 'pnpm test:int --log-order=stream --filter=@couli/spec-tests -- --shard=1/6';
const REST = "pnpm test:int --log-order=stream --filter='!@couli/spec-tests'";
const WORKTREE_WORKFLOW = [
  'jobs:',
  ...Array.from({ length: 7 }, (_, i) => {
    const id = i + 1;
    return `  verify-int-${id}:
    runs-on: ubuntu-latest
    steps:
      - run: pnpm test:int --log-order=grouped --filter=@couli/spec-tests -- --shard=${id}/7`;
  }),
  `      - run: ${REST.replace('--log-order=stream', '--log-order=grouped')}`,
  '',
].join('\n');

let base: string;
let worktree: string;
beforeAll(() => {
  base = scratchDir('int-shard container');
  worktree = join(base, 'task worktree');
  writeFiles(worktree, {
    'package.json': '{"name":"int-shard-fixture","private":true}\n',
    '.github/workflows/ci.yml': WORKTREE_WORKFLOW,
  });
  fixtureGit(worktree, ['init', '-q']);
  fixtureGit(worktree, ['add', '.']);
  fixtureGit(worktree, ['commit', '-qm', 'fixture snapshot']);
  writeFiles(base, {
    'bin/docker': '#!/bin/sh\nprintf "%s\\n" "$*" >> "$SHARD_TEST_DOCKER_LOG"\nexit 99\n',
  });
  chmodSync(join(base, 'bin/docker'), 0o755);
});
afterAll(() => removeDir(base));

function dryRun(...args: string[]) {
  const dockerLog = join(base, 'docker.log');
  const script = join(ROOT, 'tools/ops/verify-container.sh');
  const argv = [script, TASK, '--worktree', worktree, ...args, '--dry-run'];
  const result = spawnSync('bash', argv, {
    cwd: worktree,
    encoding: 'utf8',
    timeout: 10_000,
    env: {
      PATH: `${join(base, 'bin')}:${process.env['PATH'] ?? ''}`,
      COULI_RUNS: join(base, 'runs'),
      COULI_TRUSTED_ROOT: realpathSync(ROOT),
      SHARD_TEST_DOCKER_LOG: dockerLog,
    },
  });
  expect(existsSync(dockerLog), '--dry-run does not invoke Docker').toBe(false);
  return result;
}

it.each(['1', 'rest'])(
  '[AC-CT-06zzzzzzza#4] dry-run uses the trusted CI command for segment %s',
  (segment) => {
    const command = segment === '1' ? FIRST : REST;
    const cli = dryRun('--int-shard', segment);
    expect(cli.status, cli.stderr).toBe(0);
    expect(cli.stdout.trimEnd().split('\n')).toHaveLength(1);
    expect(JSON.parse(cli.stdout)).toHaveProperty('int_shard', { segment, command });
    expect(existsSync(join(base, 'runs', TASK, 'int-shard'))).toBe(false);
  },
  CLI_TIMEOUT,
);

it(
  '[AC-CT-06zzzzzzza#5] rejects segments absent from the trusted workflow, even if present in the task worktree',
  () => {
    const valid = dryRun('--int-shard', '1');
    expect(valid.status, valid.stderr).toBe(0);

    expect(dryRun('--int-shard', '7').status).toBe(2);
    expect(dryRun('--int-shard', '0').status).toBe(2);
    expect(dryRun('--int-shard', 'bogus').status).toBe(2);
    expect(dryRun('--int-shard').status).toBe(2);
  },
  CLI_TIMEOUT,
);

it.each(['--fast', '--red', '--related', '--browser', '--tests'])(
  '[AC-CT-06zzzzzzza#6] rejects a shard combined with %s in either argument order',
  (flag) => {
    const valid = dryRun('--int-shard', '1');
    expect(valid.status, valid.stderr).toBe(0);

    const other = flag === '--tests' ? [flag, 'test/spec'] : [flag];
    const otherOnly = dryRun(...other);
    for (const args of [
      ['--int-shard', '1', ...other],
      [...other, '--int-shard', '1'],
    ]) {
      const cli = dryRun(...args);
      expect(cli.status, cli.stderr).toBe(2);
      expect(cli.stderr).toMatch(/--int-shard|mutually exclusive|at most one|runs alone/i);
      expect(cli.stderr.trim()).not.toBe(otherOnly.stderr.trim());
    }
  },
  CLI_TIMEOUT,
);
