// CT-06zzzzzzzb (FU-VERIFY-FAST-PROFILE): unit tests of tools/ci/fast-parts.ts — verify:fast cut
// into base / spec-1 … spec-N as ci.yml runs it, and the steps of verify:fast.
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { CLI_TIMEOUT, removeDir, scratchDir, writeFiles } from '../ops/test-helpers.ts';
import { readFastParts, verifyFastSteps } from './fast-parts.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const CLI = join(ROOT, 'tools/ci/fast-parts.ts');
const UNIT = "pnpm exec turbo run test --env-mode=loose --filter='!@couli/spec-tests'";
const spec = (i: number, n: number) =>
  `pnpm --filter @couli/spec-tests run test --shard=${String(i)}/${String(n)}`;

function job(id: string, ...steps: string[]): string {
  return [`  ${id}:`, '    runs-on: ubuntu-latest', '    steps:', ...steps].join('\n');
}
const run = (cmd: string) => `      - run: ${cmd}`;
const workflow = (...jobs: string[]) => ['name: CI', 'on: push', 'jobs:', ...jobs, ''].join('\n');
const pkg = (fast: string, test = 'turbo run test --env-mode=loose') =>
  JSON.stringify({ scripts: { test, 'verify:fast': fast } });

const FAST = 'pnpm run typecheck && pnpm run test && pnpm run guard:static';
const CI = workflow(
  job(
    'verify-unit',
    '      - id: tested',
    '        run: |',
    "          tree=$(git rev-parse 'HEAD^{tree}')",
    run('pnpm build'),
    '      # turbo run test in a comment is not a command',
    run(UNIT),
    '        env:',
    '          X: turbo run test',
  ),
  job('verify-spec-1', run('pnpm install --frozen-lockfile'), run(spec(1, 2))),
  job('verify-spec-2', run(spec(2, 2))),
  job('verify-props-1', run(`${spec(1, 3)} --logHeapUsage`)),
);

let base = '';
beforeAll(() => {
  base = scratchDir('fast-parts-unit');
});
afterAll(() => removeDir(base));

it('cuts verify:fast into base and the spec shards, ignoring other jobs, comments and env values', () => {
  expect(readFastParts(CI, pkg(FAST))).toEqual({
    n: 2,
    parts: [
      { id: 'base', commands: ['pnpm run typecheck', UNIT, 'pnpm run guard:static'] },
      { id: 'spec-1', commands: [spec(1, 2)] },
      { id: 'spec-2', commands: [spec(2, 2)] },
    ],
  });
});

it('accepts a double-quoted or unquoted exclusion and a quoted run value', () => {
  for (const unit of [
    'pnpm exec turbo run test --env-mode=loose --filter="!@couli/spec-tests"',
    'pnpm exec turbo run test --env-mode=loose --filter=!@couli/spec-tests',
  ]) {
    const ci = CI.replace(UNIT, unit);
    expect(readFastParts(ci, pkg(FAST)).parts[0]?.commands[1]).toBe(unit);
  }
  const quoted = CI.replace(`- run: ${spec(2, 2)}`, `- run: "${spec(2, 2)}"`);
  expect(readFastParts(quoted, pkg(FAST)).parts[2]?.commands).toEqual([spec(2, 2)]);
});

it('rejects a mismatched quote, an empty shard count and a workflow without jobs', () => {
  const bad = [
    CI.replace(UNIT, `pnpm exec turbo run test --env-mode=loose --filter='!@couli/spec-tests"`),
    CI.replace(spec(1, 2), 'pnpm --filter @couli/spec-tests run test --shard=1/0').replace(
      spec(2, 2),
      'pnpm --filter @couli/spec-tests run test --shard=2/0',
    ),
    'name: CI\n',
  ];
  for (const ci of bad) expect(() => readFastParts(ci, pkg(FAST))).toThrow();
});

it('verifyFastSteps splits on && and refuses quotes, a single & and an empty step', () => {
  expect(verifyFastSteps(pkg(' a  &&b && c '))).toEqual(['a', 'b', 'c']);
  for (const fast of ["pnpm run 'x'", 'pnpm run a & pnpm run b', 'a && && b', 'a &&', '  ']) {
    expect(() => verifyFastSteps(pkg(fast)), fast).toThrow();
  }
  expect(() => verifyFastSteps('not json')).toThrow();
  expect(() => verifyFastSteps('{"scripts":[]}')).toThrow();
});

it(
  'CLI: --steps prints the steps; bad arguments and unreadable files exit 2',
  () => {
    writeFiles(base, { 'package.json': pkg(FAST), 'ci.yml': CI });
    const steps = spawnSync(
      process.execPath,
      [CLI, '--steps', '--package-json', join(base, 'package.json')],
      { encoding: 'utf8' },
    );
    expect(steps.status, steps.stderr).toBe(0);
    expect(JSON.parse(steps.stdout)).toEqual({
      steps: ['pnpm run typecheck', 'pnpm run test', 'pnpm run guard:static'],
    });
    for (const args of [
      ['--workflow'],
      ['--bogus', 'x'],
      ['--steps', '--workflow', join(base, 'ci.yml')],
      ['--workflow', join(base, 'missing.yml'), '--package-json', join(base, 'package.json')],
    ]) {
      const cli = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
      expect(cli.status, args.join(' ')).toBe(2);
      expect(cli.stderr, args.join(' ')).toMatch(/^fast-parts: /);
      expect(cli.stdout).toBe('');
    }
  },
  CLI_TIMEOUT,
);
