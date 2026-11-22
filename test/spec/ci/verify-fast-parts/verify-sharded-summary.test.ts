import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  CLI_TIMEOUT,
  removeDir,
  runCli,
  scratchDir,
  writeFiles,
} from '../../../../tools/ops/test-helpers.ts';
import { TASK, fastJobs, job, packageJson, specCommand, unitCommand, workflow } from './kit.ts';

const TREE = 'a'.repeat(40);
const OTHER_TREE = 'b'.repeat(40);
const STARTED = '2026-11-22T10:00:00Z';
const EARLY = '2026-11-22T10:00:10Z';
const MIDDLE = '2026-11-22T10:00:20Z';
const LATE = '2026-11-22T10:00:30Z';
const LATEST = '2026-11-22T10:00:40Z';
const INT_NUMBERED = 'pnpm test:int --log-order=stream --filter=@couli/spec-tests -- --shard=1/1';
const INT_REST = "pnpm test:int --log-order=stream --filter='!@couli/spec-tests'";
const PARTS = ['base', 'spec-1', 'spec-2'] as const;
type Part = (typeof PARTS)[number];

let base: string;
beforeEach(() => {
  base = scratchDir('fast parts summary');
  writeWorkflow(2);
  writeFiles(base, { 'root package.json': packageJson() });
  for (const [run, segment, command] of [
    [1, '1', INT_NUMBERED],
    [2, 'rest', INT_REST],
  ] as const) {
    writeResult('int-shard', run, {
      script: 'int-shard',
      segment,
      command,
      files: 2,
      tests: 8,
      int_files_total: 4,
    });
  }
});
afterEach(() => removeDir(base));

function writeWorkflow(n: number): void {
  writeFiles(base, {
    'root CI.yml': workflow(...fastJobs(n), job('verify-int-1', INT_NUMBERED, INT_REST)),
  });
}

function writeResult(directory: string, run: number, overrides: object): void {
  const result = {
    mode: 'container',
    commit: 'c'.repeat(40),
    tree: TREE,
    exit_code: 0,
    started_at: STARTED,
    finished_at: EARLY,
    ...overrides,
  };
  writeFiles(base, {
    [`runs/${TASK}/${directory}/${String(run)}/result.json`]: JSON.stringify(result),
  });
}

function whole(run: number, finished_at: string, exit_code = 0, tree = TREE): void {
  writeResult('verify-fast', run, { script: 'verify:fast', finished_at, exit_code, tree });
}

function part(run: number, name: Part, finished_at: string, exit_code = 0, tree = TREE): void {
  const commands =
    name === 'base'
      ? ['pnpm run typecheck', unitCommand(), 'pnpm run guard:static']
      : [specCommand(name === 'spec-1' ? 1 : 2, 2)];
  const started = exit_code === 0 ? commands : commands.slice(0, 1);
  writeResult('fast-part', run, {
    script: 'fast-part',
    fast_part: { part: name, commands },
    finished_at,
    exit_code,
    tree,
    steps: started.map((command) => ({ command, started_at: STARTED, finished_at, exit_code })),
  });
}

function report(exit: number, ...flags: string[]) {
  const cli = runCli('verify-sharded-summary.ts', [
    TASK,
    '--tree',
    TREE,
    '--runs',
    join(base, 'runs'),
    '--workflow',
    join(base, 'root CI.yml'),
    '--package-json',
    join(base, 'root package.json'),
    '--json',
    ...flags,
  ]);
  expect(cli.status, cli.stderr || cli.stdout).toBe(exit);
  return JSON.parse(cli.stdout) as { problems: string[] };
}

function missingPart(name: string): RegExp {
  return new RegExp(`(?:missing|缺).*fast-part ${name}\\b`, 'i');
}

it(
  '[AC-CT-06zzzzzzzb#9] groups only same-tree parts, selecting each by finish time and the group by its latest finish',
  () => {
    whole(1, MIDDLE, 17);
    part(1, 'spec-2', LATE);
    part(2, 'base', EARLY);
    part(3, 'spec-1', EARLY);
    part(4, 'spec-2', EARLY, 1);
    part(5, 'spec-2', LATEST, 1, OTHER_TREE);
    const summary = report(0);
    expect(summary).toMatchObject({
      task: TASK,
      tree: TREE,
      status: 'green',
      fast: {
        mode: 'parts',
        parts: expect.arrayContaining([
          { part: 'base', run: 2, exit_code: 0, started_at: STARTED, finished_at: EARLY },
          { part: 'spec-1', run: 3, exit_code: 0, started_at: STARTED, finished_at: EARLY },
          { part: 'spec-2', run: 1, exit_code: 0, started_at: STARTED, finished_at: LATE },
        ]),
      },
      scope: 'fast+test:int',
      not_covered: ['test:browser', 'db:check'],
      totals: { files: 4, tests: 16, int_files_total: 4 },
      problems: [],
    });
    expect(summary).toHaveProperty('fast.parts.length', 3);
  },
  CLI_TIMEOUT,
);

it(
  '[AC-CT-06zzzzzzzb#10] reports each failure in a newer complete group despite older passing evidence',
  () => {
    whole(1, MIDDLE);
    part(1, 'base', EARLY);
    part(2, 'spec-1', EARLY);
    part(3, 'spec-2', EARLY);
    part(4, 'spec-1', LATE, 17);
    part(5, 'spec-2', LATEST, 124);
    const summary = report(1);
    expect(summary).toMatchObject({
      status: 'red',
      fast: {
        mode: 'parts',
        parts: expect.arrayContaining([
          { part: 'base', run: 1, exit_code: 0 },
          { part: 'spec-1', run: 4, exit_code: 17 },
          { part: 'spec-2', run: 5, exit_code: 124 },
        ]),
      },
    });
    expect(summary).toHaveProperty('fast.parts.length', 3);
    expect(summary.problems).toHaveLength(2);
    expect(summary.problems).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/\bspec-1\b/),
        expect.stringMatching(/\bspec-2\b/),
      ]),
    );
  },
  CLI_TIMEOUT,
);

it.each([
  ['newer', LATEST, 0, 124, 0],
  ['tied', LATE, 17, 0, 1],
] as const)(
  '[AC-CT-06zzzzzzzb#11] uses the whole result when it is %s by completion time',
  (_when, finish, wholeExit, partExit, expectedExit) => {
    whole(1, finish, wholeExit);
    part(1, 'base', EARLY);
    part(2, 'spec-1', EARLY);
    part(3, 'spec-2', LATE, partExit);
    expect(report(expectedExit)).toMatchObject({
      status: expectedExit === 0 ? 'green' : 'red',
      fast: {
        mode: 'whole',
        run: 1,
        exit_code: wholeExit,
        started_at: STARTED,
        finished_at: finish,
        parts: expect.any(Array),
      },
      problems: expectedExit === 0 ? [] : [expect.stringMatching(/verify-fast|verify:fast/)],
    });
  },
  CLI_TIMEOUT,
);

it(
  '[AC-CT-06zzzzzzzb#12] keeps the latest eligible whole run when a newer group is incomplete',
  () => {
    whole(1, MIDDLE);
    whole(2, EARLY, 17);
    whole(3, LATEST, 17, OTHER_TREE);
    part(1, 'base', LATE, 124);
    part(2, 'spec-1', LATEST);
    expect(report(0)).toMatchObject({
      status: 'green',
      fast: { mode: 'whole', run: 1, exit_code: 0, parts: expect.any(Array) },
      problems: [],
    });
  },
  CLI_TIMEOUT,
);

it(
  '[AC-CT-06zzzzzzzb#13] lists every missing part and the missing whole result without borrowing evidence from another tree',
  () => {
    whole(1, LATE, 0, OTHER_TREE);
    part(1, 'base', EARLY);
    part(2, 'spec-1', MIDDLE, 0, OTHER_TREE);
    const summary = report(1);
    expect(summary).toMatchObject({ status: 'red' });
    expect(summary.problems).toEqual(
      expect.arrayContaining([
        expect.stringMatching(missingPart('spec-1')),
        expect.stringMatching(missingPart('spec-2')),
        expect.stringMatching(/verify-fast|verify:fast/),
      ]),
    );
    expect(summary.problems).not.toEqual(
      expect.arrayContaining([expect.stringMatching(missingPart('base'))]),
    );
  },
  CLI_TIMEOUT,
);

it(
  '[AC-CT-06zzzzzzzb#14] keeps fast null with no evidence and names all parts required by the selected workflow',
  () => {
    writeWorkflow(3);
    const summary = report(1);
    expect(summary).toMatchObject({ status: 'red', fast: null });
    expect(summary.problems).toEqual(
      expect.arrayContaining([
        ...[...PARTS, 'spec-3'].map((name) => expect.stringMatching(missingPart(name))),
        expect.stringMatching(/verify-fast|verify:fast/),
      ]),
    );
  },
  CLI_TIMEOUT,
);

it.each([
  [0, 'fast+test:int+test:browser', ['db:check']],
  [17, 'fast+test:int', ['test:browser', 'db:check']],
] as const)(
  '[AC-CT-06zzzzzzzb#15] preserves browser scope rules for a browser exit of %i with fast-part evidence',
  (exit_code, scope, not_covered) => {
    PARTS.forEach((name, index) => part(index + 1, name, EARLY));
    writeResult('browser', 1, { script: 'browser', exit_code, finished_at: LATE });
    writeResult('browser', 2, { script: 'browser', tree: OTHER_TREE, finished_at: LATEST });
    expect(report(0)).toMatchObject({
      status: 'green',
      fast: { mode: 'parts' },
      browser: null,
      scope: 'fast+test:int',
      not_covered: ['test:browser', 'db:check'],
    });
    expect(report(0, '--browser')).toMatchObject({
      status: 'green',
      fast: { mode: 'parts' },
      browser: { run: 1, exit_code },
      scope,
      not_covered,
      problems: [],
    });
  },
  CLI_TIMEOUT,
);
