import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  CLI_TIMEOUT,
  removeDir,
  scratchDir,
  writeFiles,
} from '../../../../tools/ops/test-helpers.ts';
import {
  FAST_STEPS,
  ROOT,
  ROOT_TEST,
  SPEC_PACKAGE,
  fastJobs,
  job,
  packageJson,
  specCommand,
  unitCommand,
  workflow,
} from './kit.ts';

const PARSER = join(ROOT, 'tools/ci/fast-parts.ts');
const UNIT = unitCommand();
const FIRST = specCommand(1, 2);
const SECOND = specCommand(2, 2);
const WORKFLOW = workflow(...fastJobs(2));
const PACKAGE_JSON = packageJson();

type Parser = {
  readFastParts: (workflowText: string, packageJsonText: string) => unknown;
  verifyFastSteps: (packageJsonText: string) => string[];
};

let base: string;
beforeEach(() => {
  base = scratchDir('fast-parts');
});
afterEach(() => removeDir(base));

async function loadParser(): Promise<Parser> {
  expect(existsSync(PARSER), 'fast-parts module exists').toBe(true);
  return (await import(/* @vite-ignore */ pathToFileURL(PARSER).href)) as Parser;
}

function runParser(...args: string[]) {
  return spawnSync(process.execPath, [PARSER, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 5_000,
  });
}

function runFixture(workflowText: string, packageJsonText: string) {
  const workflowFile = 'fixture CI.yml';
  const packageFile = 'fixture package.json';
  writeFiles(base, { [workflowFile]: workflowText, [packageFile]: packageJsonText });
  return runParser(
    '--workflow',
    join(base, workflowFile),
    '--package-json',
    join(base, packageFile),
  );
}

function expectCliParts(cli: ReturnType<typeof runParser>, expected: unknown): void {
  expect(cli.status, cli.stderr).toBe(0);
  expect(cli.stdout.trimEnd().split('\n')).toHaveLength(1);
  expect(JSON.parse(cli.stdout)).toEqual(expected);
}

function expectCliRejection(cli: ReturnType<typeof runParser>): void {
  expect(cli.status, cli.stderr || cli.stdout).toBe(2);
  expect(cli.stderr.trim()).not.toBe('');
}

it(
  '[AC-CT-06zzzzzzzb#1] derives the three current CI parts and keeps every non-test verify:fast step in place',
  async () => {
    const { readFastParts, verifyFastSteps } = await loadParser();
    expect(readFastParts).toBeTypeOf('function');
    expect(verifyFastSteps).toBeTypeOf('function');

    const ci = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');
    const pkg = readFileSync(join(ROOT, 'package.json'), 'utf8');
    const manifest = JSON.parse(pkg) as { scripts: { 'verify:fast': string } };
    const steps = manifest.scripts['verify:fast'].split(' && ').map((step) => step.trim());
    const expected = {
      n: 2,
      parts: [
        { id: 'base', commands: steps.map((step) => (step === 'pnpm run test' ? UNIT : step)) },
        { id: 'spec-1', commands: [FIRST] },
        { id: 'spec-2', commands: [SECOND] },
      ],
    };
    expect(verifyFastSteps(pkg)).toEqual(steps);
    expect(readFastParts(ci, pkg)).toEqual(expected);
    expectCliParts(runParser(), expected);
  },
  CLI_TIMEOUT,
);

it(
  '[AC-CT-06zzzzzzzb#2] derives the package and shard count from the selected files and orders parts by shard index',
  async () => {
    const { readFastParts, verifyFastSteps } = await loadParser();
    expect(readFastParts).toBeTypeOf('function');
    expect(verifyFastSteps).toBeTypeOf('function');

    const pkg = '@fixture/rules';
    const unit = unitCommand(pkg);
    const first = specCommand(1, 3, pkg);
    const second = specCommand(2, 3, pkg);
    const third = specCommand(3, 3, pkg);
    const ci = workflow(
      job('verify-spec-3', third),
      job('verify-unit', 'pnpm build', `  ${unit}  `),
      job('verify-spec-1', first),
      job('verify-spec-2', second),
    );
    const manifest = packageJson({ 'verify:fast': `  ${FAST_STEPS.join('  &&  ')}  ` });
    const expected = {
      n: 3,
      parts: [
        { id: 'base', commands: ['pnpm run typecheck', unit, 'pnpm run guard:static'] },
        { id: 'spec-1', commands: [first] },
        { id: 'spec-2', commands: [second] },
        { id: 'spec-3', commands: [third] },
      ],
    };
    expect(verifyFastSteps(manifest)).toEqual(FAST_STEPS);
    expect(readFastParts(ci, manifest)).toEqual(expected);
    expectCliParts(runFixture(ci, manifest), expected);
  },
  CLI_TIMEOUT,
);

it.each([
  ['verify:fast is absent', WORKFLOW, '{"scripts":{"test":"turbo run test --env-mode=loose"}}'],
  ['verify:fast has no root test step', WORKFLOW, packageJson({ 'verify:fast': 'pnpm run lint' })],
  [
    'verify:fast has two root test steps',
    WORKFLOW,
    packageJson({ 'verify:fast': 'pnpm run test && pnpm run test' }),
  ],
  ['the root test script is absent', WORKFLOW, packageJson({ test: null })],
  [
    'the root test script and unit command differ',
    WORKFLOW,
    packageJson({ test: ROOT_TEST + ' --affected' }),
  ],
  [
    'the verify-unit job is absent',
    WORKFLOW.replace('verify-unit:', 'not-verify-unit:'),
    PACKAGE_JSON,
  ],
  [
    'the verify-unit job has no turbo test command',
    WORKFLOW.replace(UNIT, 'pnpm build'),
    PACKAGE_JSON,
  ],
  [
    'the verify-unit job has two turbo test commands',
    WORKFLOW.replace(UNIT, `${UNIT}\n      - run: ${UNIT}`),
    PACKAGE_JSON,
  ],
  [
    'the verify-unit command has no exclusion',
    WORKFLOW.replace(UNIT, `pnpm exec ${ROOT_TEST}`),
    PACKAGE_JSON,
  ],
  [
    'the verify-unit command excludes two packages',
    WORKFLOW.replace(UNIT, `${UNIT} --filter='!@fixture/other'`),
    PACKAGE_JSON,
  ],
  [
    'the verify-unit exclusion names a different package',
    WORKFLOW.replace(UNIT, unitCommand('@fixture/other')),
    PACKAGE_JSON,
  ],
  [
    'the verify-unit command adds a project argument',
    WORKFLOW.replace(UNIT, `${UNIT} --project=unit`),
    PACKAGE_JSON,
  ],
  [
    'every spec command adds a project argument',
    WORKFLOW.replace(FIRST, `${FIRST} --project=unit`).replace(SECOND, `${SECOND} --project=unit`),
    PACKAGE_JSON,
  ],
  [
    'every spec command adds another filter',
    WORKFLOW.replace(FIRST, `${FIRST} --filter=@fixture/other`).replace(
      SECOND,
      `${SECOND} --filter=@fixture/other`,
    ),
    PACKAGE_JSON,
  ],
  [
    'one spec command targets a different package',
    WORKFLOW.replace(SECOND, specCommand(2, 2, '@fixture/other')),
    PACKAGE_JSON,
  ],
  [
    'a spec job is missing',
    workflow(job('verify-unit', UNIT), job('verify-spec-1', FIRST)),
    PACKAGE_JSON,
  ],
  [
    'the verify-spec-2 job has no shard command',
    WORKFLOW.replace(SECOND, `pnpm --filter ${SPEC_PACKAGE} run test`),
    PACKAGE_JSON,
  ],
  [
    'one spec job runs its shard twice',
    WORKFLOW.replace(SECOND, `${SECOND}\n      - run: ${SECOND}`),
    PACKAGE_JSON,
  ],
  [
    'a numbered spec job is declared twice',
    workflow(...fastJobs(2), job('verify-spec-1', FIRST)),
    PACKAGE_JSON,
  ],
  ['one spec job repeats the other shard index', WORKFLOW.replace(SECOND, FIRST), PACKAGE_JSON],
  [
    'the shard indices are swapped between job names',
    workflow(job('verify-unit', UNIT), job('verify-spec-1', SECOND), job('verify-spec-2', FIRST)),
    PACKAGE_JSON,
  ],
  ['the shard denominators disagree', WORKFLOW.replace(SECOND, specCommand(2, 3)), PACKAGE_JSON],
  [
    'a named shard is outside the declared count',
    workflow(...fastJobs(2), job('verify-spec-3', specCommand(3, 2))),
    PACKAGE_JSON,
  ],
] as const)(
  '[AC-CT-06zzzzzzzb#3] rejects an unequal test set or invalid layout when %s',
  async (_reason, ci, manifest) => {
    const { readFastParts } = await loadParser();
    expect(readFastParts).toBeTypeOf('function');
    expect(() => readFastParts(ci, manifest)).toThrow();
    expectCliRejection(runFixture(ci, manifest));
  },
  CLI_TIMEOUT,
);

it.each([
  ['a semicolon', 'pnpm run lint; pnpm run test'],
  ['a pipe', 'pnpm run lint | cat'],
  ['a shell OR', 'pnpm run lint || true'],
  ['a variable expansion', 'pnpm run $SCRIPT'],
  ['a backtick expansion', 'pnpm run `echo lint`'],
  ['output redirection', 'pnpm run lint > lint.log'],
  ['input redirection', 'pnpm run lint < lint.txt'],
  ['an embedded newline', 'pnpm run lint\npnpm run test'],
] as const)(
  '[AC-CT-06zzzzzzzb#4] rejects a verify:fast step containing %s',
  async (_reason, unsafeStep) => {
    const { verifyFastSteps, readFastParts } = await loadParser();
    expect(verifyFastSteps).toBeTypeOf('function');
    expect(readFastParts).toBeTypeOf('function');
    const manifest = packageJson({ 'verify:fast': `pnpm run test && ${unsafeStep}` });
    expect(() => verifyFastSteps(manifest)).toThrow();
    expect(() => readFastParts(WORKFLOW, manifest)).toThrow();
    expectCliRejection(runFixture(WORKFLOW, manifest));
  },
  CLI_TIMEOUT,
);
