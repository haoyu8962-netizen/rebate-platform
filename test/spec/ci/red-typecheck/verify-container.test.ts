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
const RULE = 'test/spec/ci/red-typecheck/fixture.test.ts';
const TITLE = '[AC-CT-06zzzzzzzn] checks the fixture value';
const BAD_ASSIGNMENT = "const candidate: number = 'wrong';";
const DIAGNOSTIC = `${RULE}(3,9): error TS2322: Type 'string' is not assignable to type 'number'.`;

// Simulate Docker's ready image and store, Vitest reports and compiler stdout. The shell script,
// red-check and early evidence check are real. Match the compiler command at the Docker boundary
// so the fixture can model a command in docker run or docker exec without invoking either payload.
const DOCKER_STUB = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const [action, ...args] = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(process.env.RED_TYPECHECK_FIXTURE, 'utf8'));
const out = path.join(config.runDir, 'out');
const runtimeFile = path.join(config.runDir, 'fixture-runtime.json');
const readJson = (file) => {
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  return text ? JSON.parse(text) : null;
};
const flag = (name) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const sourceMount = args.find((arg, i) => args[i - 1] === '-v' && arg.endsWith(':/src:ro'));
const outputMount = args.includes(out + ':/out');
const savedRuntime = readJson(runtimeFile);
const runtime = action === 'run' && sourceMount
  ? { name: flag('--name'), source: sourceMount.slice(0, -8), network: flag('--network') }
  : action === 'exec' && args.includes(savedRuntime?.name) ? savedRuntime : null;

const command = args.join(' ');
const buildTest = /\btsc\s+(?:-b|--build)\s+(?:--pretty false\s+)?(?:\.\/)?test\b/;
if ((action === 'run' || action === 'exec') && buildTest.test(command)) {
  const source = runtime && fs.readFileSync(path.join(runtime.source, config.rule), 'utf8');
  const verdict = readJson(path.join(config.runDir, 'red-check.json'));
  const shape = readJson(path.join(config.runDir, 'evidence-shape.json'));
  fs.appendFileSync(config.compilerCalls, JSON.stringify({
    network: runtime?.network,
    sameSnapshot: runtime !== null && runtime.source === savedRuntime?.source,
    redPassed: verdict?.ok === true,
    shapeChecked: shape?.task === config.task,
  }) + '\n');
  if (source && source.includes(config.badAssignment)) {
    fs.writeSync(1, config.diagnostic + '\n');
    process.exit(2);
  }
  process.exit(0);
}

const isRed = process.env.RED_PLAN || command.includes('couli-verify-entrypoint red');
const isTests = args.includes('couli-tests');
if (runtime !== null && (outputMount || action === 'exec') && (isRed || isTests)) {
  if (isRed) fs.writeFileSync(runtimeFile, JSON.stringify(runtime));
  if (config.report === 'malformed' && isRed) {
    fs.writeFileSync(path.join(out, 'spec-unit.json'), '{\n');
    process.exit(0);
  }
  const failed = isRed && config.report === 'failed';
  const status = failed ? 'failed' : 'passed';
  const report = {
    numTotalTests: 1,
    numPassedTests: failed ? 0 : 1,
    numFailedTests: failed ? 1 : 0,
    success: !failed,
    testResults: [{
      name: '/work/repo/' + config.rule,
      status,
      message: '',
      assertionResults: [{
        ancestorTitles: [], title: config.title, fullName: config.title, status,
        failureMessages: failed ? ['AssertionError: expected fixture value to be 2'] : [],
      }],
    }],
  };
  const reportName = isTests ? 'spec-unit.vitest-report.json' : 'spec-unit.json';
  fs.writeFileSync(path.join(out, reportName), JSON.stringify(report));
  fs.writeFileSync(path.join(out, 'spec-unit.exit'), failed ? '1\n' : '0\n');
  if (isTests) fs.writeFileSync(path.join(out, 'spec-unit.seconds'), '1\n');
}
if (action === 'run' && outputMount && runtime !== null && args.includes('-d')) {
  fs.writeFileSync(runtimeFile, JSON.stringify(runtime));
  fs.writeSync(1, runtime.name + '\n');
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

function run(
  mode: 'red' | 'tests' | 'fast',
  source: 'typed' | 'type-error',
  report: 'failed' | 'passed' | 'malformed',
) {
  const root = realpathSync(scratchDir(`red-typecheck-${mode}-${source}-${report}`));
  roots.push(root);
  const trusted = realpathSync(repoRoot());
  const repo = join(root, 'fixture worktree');
  const runs = join(root, 'runs');
  const runDir = join(runs, TASK, mode === 'fast' ? 'verify-fast' : mode, '1');
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
    [RULE]: [
      "import { expect, it } from 'vitest';",
      `it('${TITLE}', () => {`,
      `  ${source === 'type-error' ? BAD_ASSIGNMENT : 'const candidate: number = 1;'}`,
      `  expect(candidate).toBe(${report === 'passed' ? "'wrong'" : '2'});`,
      '});',
      '',
    ].join('\n'),
  });

  const bin = join(root, 'bin');
  const docker = join(bin, 'docker');
  const fixture = join(root, 'fixture.json');
  const compilerCalls = join(root, 'compiler.jsonl');
  const hostCalls = join(root, 'host-compiler');
  const blockHostCompiler =
    '#!/bin/sh\nprintf "%s\\n" "$0" >> "$RED_TYPECHECK_HOST_CALLS"\nexit 96\n';
  writeFiles(root, {
    'bin/docker': '#!/bin/sh\nexec node "${0%/*}/docker.cjs" "$@"\n',
    'bin/docker.cjs': DOCKER_STUB,
    'bin/pnpm': blockHostCompiler,
    'bin/tsc': blockHostCompiler,
    'fixture.json': JSON.stringify({
      runDir,
      report,
      compilerCalls,
      task: TASK,
      rule: RULE,
      title: TITLE,
      badAssignment: BAD_ASSIGNMENT,
      diagnostic: DIAGNOSTIC,
    }),
  });
  for (const file of [docker, join(bin, 'pnpm'), join(bin, 'tsc')]) chmodSync(file, 0o755);

  const extra = mode === 'red' ? ['--base', 'main'] : mode === 'tests' ? [RULE] : [];
  const cli = spawnSync(
    'bash',
    [
      join(trusted, 'tools/ops/verify-container.sh'),
      TASK,
      '--worktree',
      repo,
      `--${mode}`,
      ...extra,
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
        COULI_VERIFY_SLOT_DIR: join(root, 'slot'),
        RED_TYPECHECK_FIXTURE: fixture,
        RED_TYPECHECK_HOST_CALLS: hostCalls,
      },
    },
  );
  const log = readText(join(runDir, 'log.txt'));
  return {
    status: cli.status,
    output: [cli.error?.message, cli.stderr, log].filter(Boolean).join('\n'),
    log,
    compilerCalls: readText(compilerCalls)
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as unknown),
    hostCalls: readText(hostCalls),
    result: readJson(join(runDir, 'result.json')),
    redCheck: readJson(join(runDir, 'red-check.json')),
    tests: readJson(join(runDir, 'tests.json')),
  };
}

const OFFLINE_CALL = { network: 'none', sameSnapshot: true, redPassed: true, shapeChecked: true };

it(
  '[AC-CT-06zzzzzzzn#1] rejects a valid red run when the new rule test has a TypeScript error',
  () => {
    const red = run('red', 'type-error', 'failed');
    expect(red.redCheck, red.output).toMatchObject({ ok: true, expected: [RULE] });
    expect(red.hostCalls).toBe('');
    expect(red.compilerCalls, red.output).toEqual([OFFLINE_CALL]);
    expect(red.status, red.output).toBeGreaterThan(0);
    expect(red.result).toMatchObject({
      exit_code: red.status,
      typecheck: {
        exit_code: 2,
        errors: [expect.objectContaining({ file: RULE, line: 3, col: 9, code: expect.anything() })],
      },
    });
    const result = red.result as { typecheck: { errors: { code: number | string }[] } };
    expect(String(result.typecheck.errors[0]?.code)).toMatch(/^(?:TS)?2322$/);
    const lastLine = red.log.trimEnd().split('\n').at(-1);
    expect(lastLine).toContain(RULE);
    expect(lastLine).toContain('TS2322');
  },
  CLI_TIMEOUT,
);

it(
  '[AC-CT-06zzzzzzzn#2] passes valid red with clean types [AC-CT-06zzzzzzzn#3] skips compilation after red failures [AC-CT-06zzzzzzzn#4] keeps --tests and --fast unchanged',
  () => {
    const rejected = run('red', 'type-error', 'passed');
    expect(rejected.redCheck, rejected.output).toMatchObject({ ok: false });
    expect(rejected.status, rejected.output).toBe(1);
    expect(rejected.result).toMatchObject({ exit_code: 1 });
    const malformed = run('red', 'type-error', 'malformed');
    expect(malformed.status, malformed.output).toBe(2);
    expect(malformed.output).toContain('red-check failed to run (exit 2)');
    expect(malformed.result).toBeNull();

    const tests = run('tests', 'type-error', 'passed');
    expect(tests.status, tests.output).toBe(0);
    expect(tests.tests).toMatchObject({ status: 'green' });
    const fast = run('fast', 'type-error', 'passed');
    expect(fast.status, fast.output).toBe(0);
    expect(fast.result).toMatchObject({ script: 'verify:fast', exit_code: 0 });
    for (const other of [rejected, malformed, tests, fast]) {
      expect(other.compilerCalls, other.output).toEqual([]);
      expect(other.hostCalls).toBe('');
    }

    const red = run('red', 'typed', 'failed');
    expect(red.redCheck, red.output).toMatchObject({ ok: true, expected: [RULE] });
    expect(red.status, red.output).toBe(0);
    expect(red.hostCalls).toBe('');
    expect(red.compilerCalls, red.output).toEqual([OFFLINE_CALL]);
    expect(red.result).toMatchObject({ exit_code: 0, typecheck: { exit_code: 0, errors: [] } });
  },
  CLI_TIMEOUT * 2,
);
