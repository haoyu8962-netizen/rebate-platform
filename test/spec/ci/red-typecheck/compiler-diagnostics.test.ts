import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { repoRoot } from '../../../../tools/lib/paths.ts';
import {
  CLI_TIMEOUT,
  fixtureGit,
  removeDir,
  scratchDir,
  writeFiles,
} from '../../../../tools/ops/test-helpers.ts';

const TASK = 'CT-06zzzzzzzn';
const FIRST = 'test/spec/ci/red-typecheck/fixture-object.test.ts';
const SECOND = 'test/spec/ci/red-typecheck/fixture-argument.test.ts';
const FIRST_TITLE = '[AC-CT-06zzzzzzzn] checks the object value';
const SECOND_TITLE = '[AC-CT-06zzzzzzzn] checks the parsed argument';

// The image and store are ready. The real red-check reads the fixture Vitest report.
// Docker returns the configured compiler output and status without running a compiler.
const DOCKER_STUB = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const [action, ...args] = process.argv.slice(2);
const fixture = JSON.parse(fs.readFileSync(process.env.RED_DIAGNOSTICS_FIXTURE, 'utf8'));
const command = args.join(' ');
const buildTest = /\btsc\s+(?:-b|--build)\s+(?:--pretty false\s+)?(?:\.\/)?test\b/;
if ((action === 'run' || action === 'exec') && buildTest.test(command)) {
  fs.writeSync(1, fixture.stdout);
  process.exit(fixture.exitCode);
}
if ((action === 'run' || action === 'exec') &&
    (process.env.RED_PLAN || command.includes('couli-verify-entrypoint red'))) {
  fs.writeFileSync(path.join(fixture.out, 'spec-unit.json'), JSON.stringify(fixture.report));
  fs.writeFileSync(path.join(fixture.out, 'spec-unit.exit'), '1\n');
}
if (action === 'run' && args.includes(fixture.out + ':/out') && args.includes('-d')) {
  fs.writeSync(1, args[args.indexOf('--name') + 1] + '\n');
}
`;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) removeDir(root);
});

function readText(file: string): string {
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

function readJson(file: string): unknown {
  return JSON.parse(readText(file) || 'null') as unknown;
}

type RedResult = {
  typecheck?: {
    errors: { code: number | string }[];
  };
};

function runRed(exitCode: number, stdout: string) {
  const root = realpathSync(scratchDir(`red-diagnostics-${exitCode}`));
  roots.push(root);
  const trusted = realpathSync(repoRoot());
  const repo = join(root, 'fixture worktree');
  const runs = join(root, 'runs');
  const runDir = join(runs, TASK, 'red', '1');
  const ledger = `ops/tasks/${TASK}.yaml`;
  writeFiles(repo, {
    'package.json': readFileSync(join(trusted, 'package.json'), 'utf8'),
    'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
    'pnpm-workspace.yaml': 'packages: []\n',
    'test/tsconfig.json': '{"compilerOptions":{"noEmit":true}}\n',
    [ledger]: readFileSync(join(trusted, ledger), 'utf8'),
  });
  fixtureGit(repo, ['init', '-qb', 'main', '--object-format=sha1']);
  fixtureGit(repo, ['add', '.']);
  fixtureGit(repo, ['-c', 'commit.gpgSign=false', 'commit', '-qm', 'base']);
  fixtureGit(repo, ['switch', '-qc', `task/${TASK}`]);
  writeFiles(repo, {
    [FIRST]: [
      "import { expect, it } from 'vitest';",
      `it('${FIRST_TITLE}', () => {`,
      "  const source = { value: 'wrong' };",
      '  const candidate: { value: number } = source;',
      '  expect(candidate.value).toBe(2);',
      '});',
      '',
    ].join('\n'),
    [SECOND]: [
      "import { expect, it } from 'vitest';",
      `it('${SECOND_TITLE}', () => {`,
      '  const candidate = parseInt(1);',
      '  expect(candidate).toBe(2);',
      '});',
      '',
    ].join('\n'),
  });

  const report = {
    numTotalTests: 2,
    numPassedTests: 0,
    numFailedTests: 2,
    success: false,
    testResults: [
      { file: FIRST, title: FIRST_TITLE },
      { file: SECOND, title: SECOND_TITLE },
    ].map(({ file, title }) => ({
      name: `/work/repo/${file}`,
      status: 'failed',
      message: '',
      assertionResults: [
        {
          ancestorTitles: [],
          title,
          fullName: title,
          status: 'failed',
          failureMessages: ['AssertionError: expected fixture value to be 2'],
        },
      ],
    })),
  };
  const bin = join(root, 'bin');
  const fixture = join(root, 'fixture.json');
  const blockHostCompiler = '#!/bin/sh\nexit 96\n';
  writeFiles(root, {
    'bin/docker': '#!/bin/sh\nexec node "${0%/*}/docker.cjs" "$@"\n',
    'bin/docker.cjs': DOCKER_STUB,
    'bin/pnpm': blockHostCompiler,
    'bin/tsc': blockHostCompiler,
    'fixture.json': JSON.stringify({ out: join(runDir, 'out'), report, exitCode, stdout }),
  });
  for (const file of ['docker', 'pnpm', 'tsc']) chmodSync(join(bin, file), 0o755);

  const cli = spawnSync(
    'bash',
    [
      join(trusted, 'tools/ops/verify-container.sh'),
      TASK,
      '--worktree',
      repo,
      '--red',
      '--base',
      'main',
    ],
    {
      cwd: trusted,
      encoding: 'utf8',
      timeout: CLI_TIMEOUT,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env['PATH'] ?? ''}`,
        COULI_RUNS: runs,
        COULI_TRUSTED_ROOT: trusted,
        COULI_VERIFY_HOST_SERVICES: '',
        RED_DIAGNOSTICS_FIXTURE: fixture,
      },
    },
  );
  return {
    status: cli.status,
    output: [cli.error?.message, cli.stderr, readText(join(runDir, 'log.txt'))]
      .filter(Boolean)
      .join('\n'),
    redCheck: readJson(join(runDir, 'red-check.json')),
    result: readJson(join(runDir, 'result.json')) as RedResult | null,
  };
}

it(
  '[AC-CT-06zzzzzzzn#5] fails red when the compiler exits 137 without output',
  () => {
    const red = runRed(137, '');
    expect(red.redCheck, red.output).toMatchObject({ ok: true });
    expect(red.status, red.output).toBeGreaterThan(0);
    expect(red.result, red.output).toMatchObject({
      exit_code: red.status,
      typecheck: { exit_code: 137 },
    });
  },
  CLI_TIMEOUT,
);

it(
  '[AC-CT-06zzzzzzzn#6] fails red on a global compiler diagnostic without a file location',
  () => {
    const red = runRed(1, "error TS5083: Cannot read file 'test/tsconfig.json'.\n");
    expect(red.redCheck, red.output).toMatchObject({ ok: true });
    expect(red.status, red.output).toBeGreaterThan(0);
    expect(red.result, red.output).toMatchObject({
      exit_code: red.status,
      typecheck: { exit_code: 1 },
    });
  },
  CLI_TIMEOUT,
);

it(
  '[AC-CT-06zzzzzzzn#7] records both file diagnostics in order across continuation lines',
  () => {
    const red = runRed(
      2,
      [
        `${FIRST}(4,9): error TS2322: Type '{ value: string; }' is not assignable to type '{ value: number; }'.`,
        "  Types of property 'value' are incompatible.",
        "    Type 'string' is not assignable to type 'number'.",
        `${SECOND}(3,30): error TS2345: Argument of type 'number' is not assignable to parameter of type 'string'.`,
        '',
      ].join('\n'),
    );
    expect(red.redCheck, red.output).toMatchObject({ ok: true });
    expect(red.status, red.output).toBeGreaterThan(0);
    const errors = red.result?.typecheck?.errors;
    expect(errors, red.output).toEqual([
      expect.objectContaining({ file: FIRST, line: 4, col: 9 }),
      expect.objectContaining({ file: SECOND, line: 3, col: 30 }),
    ]);
    expect(String(errors?.[0]?.code)).toMatch(/^(?:TS)?2322$/);
    expect(String(errors?.[1]?.code)).toMatch(/^(?:TS)?2345$/);
  },
  CLI_TIMEOUT,
);
