// CT-06zzzzzzzb (FU-VERIFY-FAST-PROFILE): unit tests of tools/ci/fast-parts.ts — verify:fast cut
// into base / spec-1 … spec-N as ci.yml runs it, and the steps of verify:fast.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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
const TESTED = [
  '      - id: tested',
  '        run: |',
  "          tree=$(git rev-parse 'HEAD^{tree}')",
  '          echo "tree=$tree" >> "$GITHUB_OUTPUT"',
  '          echo "$tree" > "$RUNNER_TEMP/verified-tree.txt"',
];
const CI = workflow(
  job(
    'verify-unit',
    ...TESTED,
    '      - uses: actions/checkout@v0 # a uses step is not a run step',
    '        with:',
    '          persist-credentials: false',
    '',
    run('pnpm install --frozen-lockfile'),
    run('pnpm build'),
    '      # turbo run test in a comment is not a command',
    run(UNIT),
    '        env:',
    '          X: turbo run test',
    run('pnpm --filter @couli/api run smoke:entries'),
  ),
  job('verify-spec-1', ...TESTED, run('pnpm install --frozen-lockfile'), run(spec(1, 2))),
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

it('compares run steps as written: another quoting of the exclusion or a quoted value is refused (r5)', () => {
  const bad = [
    ['verify-unit', CI.replace(UNIT, UNIT.replace(/'/g, '"'))],
    ['verify-unit', CI.replace(UNIT, UNIT.replace(/'/g, ''))],
    ['verify-unit', CI.replace(run(UNIT), `${run(UNIT)} # a comment`)],
    ['verify-spec-2', CI.replace(run(spec(2, 2)), `      - run: "${spec(2, 2)}"`)],
    ['verify-spec-2', CI.replace(run(spec(2, 2)), `      - run: '${spec(2, 2)}'`)],
  ] as const;
  for (const [id, ci] of bad) {
    expect(() => readFastParts(ci, pkg(FAST)), ci).toThrow(new RegExp(`^job ${id}: `));
  }
});

it('accepts the current .github/workflows/ci.yml as is, with the same parts (r5)', () => {
  const ci = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');
  const fast = readFileSync(join(ROOT, 'package.json'), 'utf8');
  const parts = readFastParts(ci, fast);
  expect(parts.n).toBe(2);
  expect(parts.parts.map((p) => p.id)).toEqual(['base', 'spec-1', 'spec-2']);
  expect(parts.parts[0]?.commands).toEqual(
    verifyFastSteps(fast).map((s) => (s === 'pnpm run test' ? UNIT : s)),
  );
  expect(parts.parts[1]?.commands).toEqual([spec(1, 2)]);
  expect(parts.parts[2]?.commands).toEqual([spec(2, 2)]);
});

it(
  'refuses any run step not in the trusted list, naming the job and the step (money r2, r5)',
  () => {
    const bad = [
      // money r2: the original command kept, a second turbo test hidden by a backslash newline.
      [
        'verify-unit',
        CI.replace(
          run(UNIT),
          `${run(UNIT)}\n      - run: |\n          pnpm exec turbo run \\\n          test --env-mode=loose --filter=@couli/spec-tests`,
        ),
      ],
      // A backslash continuation of a trusted step inside a block scalar.
      [
        'verify-spec-1',
        CI.replace(
          run(spec(1, 2)),
          `      - run: |\n          pnpm --filter @couli/spec-tests run \\\n          test --shard=1/2`,
        ),
      ],
      // Chaining with `;` or `&&`, and an environment prefix.
      ['verify-unit', CI.replace(run('pnpm build'), run('pnpm build; pnpm exec turbo run test'))],
      ['verify-spec-2', CI.replace(run(spec(2, 2)), run(`${spec(2, 2)} && pnpm run test`))],
      ['verify-spec-1', CI.replace(run(spec(1, 2)), run(`PROP_RUNS=1 ${spec(1, 2)}`))],
      // One more step that is not in the list.
      [
        'verify-unit',
        CI.replace(run('pnpm build'), `${run('pnpm build')}\n${run('pnpm run lint')}`),
      ],
      ['verify-spec-2', CI.replace(run(spec(2, 2)), `${run('echo hi')}\n${run(spec(2, 2))}`)],
      // One more line in the tested block.
      [
        'verify-unit',
        CI.replace(
          '          echo "$tree" > "$RUNNER_TEMP/verified-tree.txt"',
          '          echo "$tree" > "$RUNNER_TEMP/verified-tree.txt"\n          pnpm exec turbo run test',
        ),
      ],
      // The other job's step, and a quoted key.
      ['verify-spec-1', CI.replace(run(spec(1, 2)), `${run(spec(1, 2))}\n${run('pnpm build')}`)],
      ['verify-unit', CI.replace(run('pnpm build'), `      - "run": pnpm exec turbo run test`)],
    ] as const;
    for (const [id, ci] of bad) {
      expect(() => readFastParts(ci, pkg(FAST)), ci).toThrow(new RegExp(`^job ${id}: `));
    }
    // Flow mappings and anchors, where this line reading could miss a step, are refused too.
    for (const ci of [
      CI.replace(run('pnpm build'), `      - { run: pnpm build }`),
      CI.replace(run('pnpm build'), `      - run: *alias`),
    ]) {
      expect(() => readFastParts(ci, pkg(FAST)), ci).toThrow(/^job verify-unit: /);
    }
    // The CLI exits 2 and names the job and the step as written.
    writeFiles(base, { 'bs.yml': bad[0][1], 'package.json': pkg(FAST) });
    const cli = spawnSync(
      process.execPath,
      [CLI, '--workflow', join(base, 'bs.yml'), '--package-json', join(base, 'package.json')],
      { encoding: 'utf8' },
    );
    expect(cli.status).toBe(2);
    expect(cli.stderr).toMatch(/^fast-parts: job verify-unit: .*pnpm exec turbo run \\\\/);
    expect(cli.stdout).toBe('');
  },
  CLI_TIMEOUT,
);

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

it(
  'rejects a test command in a block scalar or continued on further lines, naming the job (money r1 ①)',
  () => {
    const blocks = [
      // A folded block: CI runs `… --shard=1/2 --project=unit` as one command.
      [
        'verify-spec-1',
        CI.replace(
          run(spec(1, 2)),
          `      - run: >-\n          ${spec(1, 2)}\n          --project=unit`,
        ),
      ],
      ['verify-spec-1', CI.replace(run(spec(1, 2)), `      - run: |\n          ${spec(1, 2)}`)],
      ['verify-spec-2', CI.replace(run(spec(2, 2)), `      - run: >+2\n            ${spec(2, 2)}`)],
      ['verify-unit', CI.replace(run(UNIT), `      - run: |-\n          ${UNIT}`)],
      // A plain scalar continued on the next, deeper line.
      [
        'verify-spec-2',
        CI.replace(run(spec(2, 2)), `${run(spec(2, 2))}\n          --project=unit`),
      ],
      ['verify-unit', CI.replace(run(UNIT), `${run(UNIT)}\n          --filter=@couli/api`)],
      // A value that starts on the line after `run:`, and a double-quoted value over two lines.
      ['verify-spec-1', CI.replace(run(spec(1, 2)), `      - run:\n          ${spec(1, 2)}`)],
      [
        'verify-spec-1',
        CI.replace(run(spec(1, 2)), `      - run: "${spec(1, 2)}\n          --project=unit"`),
      ],
    ] as const;
    for (const [id, ci] of blocks) {
      expect(() => readFastParts(ci, pkg(FAST)), ci).toThrow(new RegExp(`^job ${id}: `));
    }
    // Blocks without a test command (the `tested` step) and a sibling `env:` stay accepted.
    expect(readFastParts(CI, pkg(FAST)).n).toBe(2);
    // The CLI exits 2 and names the job.
    writeFiles(base, { 'block.yml': blocks[0][1], 'package.json': pkg(FAST) });
    const cli = spawnSync(
      process.execPath,
      [CLI, '--workflow', join(base, 'block.yml'), '--package-json', join(base, 'package.json')],
      { encoding: 'utf8' },
    );
    expect(cli.status).toBe(2);
    expect(cli.stderr).toMatch(/^fast-parts: job verify-spec-1: /);
    expect(cli.stdout).toBe('');
  },
  CLI_TIMEOUT,
);

it('requires a root test script over the whole workspace before matching verify-unit (money r1 ②)', () => {
  const filtered = "turbo run test --env-mode=loose --filter='!@couli/spec-tests'";
  for (const test of [
    filtered,
    'turbo run test --env-mode=loose --filter=@couli/api',
    'turbo run test --env-mode=loose --affected',
    'turbo run test --env-mode=loose --concurrency=1',
    'turbo run lint',
    'vitest run',
  ]) {
    // verify-unit follows the root script, so only the root check can refuse it.
    const ci = CI.replace(UNIT, `pnpm exec ${test} --filter='!@couli/spec-tests'`);
    expect(() => readFastParts(ci, pkg(FAST, test)), test).toThrow(/root `test` script/);
  }
  expect(readFastParts(CI, pkg(FAST, ' turbo run test --env-mode=loose ')).n).toBe(2);
  // Another root script with a matching verify-unit command passes the root check but not the
  // trusted list (r5).
  for (const test of ['turbo run test', 'turbo run test --env-mode=strict']) {
    const ci = CI.replace(UNIT, `pnpm exec ${test} --filter='!@couli/spec-tests'`);
    expect(() => readFastParts(ci, pkg(FAST, test)), test).toThrow(/^job verify-unit: /);
  }
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
