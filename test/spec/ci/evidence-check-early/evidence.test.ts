import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { CLI_TIMEOUT, fixtureGit as git, writeFiles } from '../../../../tools/ops/test-helpers.ts';
import {
  BLOCK_ENTRY,
  FROZEN_SOURCE,
  FROZEN_TEST,
  KIT,
  KIT_SOURCE,
  MANIFEST,
  SUPPORT_ENTRY,
  TASK,
  TIGHTER_BLOCK,
  checkShape,
  cleanup,
  commit,
  earlyArgs,
  evidence,
  fixture,
  ruleTestCommit,
  writeLedger,
} from './kit.ts';

afterEach(cleanup);

it('[AC-CT-06#1] reports undeclared edits across class 1 paths', () => {
  const { repo, base } = fixture('unregistered');
  const spec = ruleTestCommit(repo, {
    [FROZEN_TEST]: TIGHTER_BLOCK,
    [MANIFEST]: '{"tests":[]}\n',
  });
  const report = checkShape(earlyArgs(repo, 'main', spec), 1, { base, spec });
  for (const file of [FROZEN_TEST, MANIFEST]) {
    const problem = report.problems.find((item) => item.includes(file));
    expect(problem, file).toMatch(/undeclared|not (?:declared|registered)|modify_existing/iu);
  }
});

it('[AC-CT-06#2] limits the comparison and ledger to the rule-test commit', () => {
  const { repo } = fixture('declared');
  const spec = ruleTestCommit(repo, { [FROZEN_TEST]: TIGHTER_BLOCK }, BLOCK_ENTRY);

  // HEAD loses the declaration and adds an undeclared change after the rule-test commit.
  writeLedger(repo);
  writeFiles(repo, { [KIT]: 'export const fixtureValue = 2;\n' });
  commit(repo, 'post-spec changes');

  // This helper edit on main would be outside the declared block in a tip-to-tip diff.
  git(repo, ['switch', '-q', 'main']);
  writeFiles(repo, { [FROZEN_TEST]: FROZEN_SOURCE.replace('return 1', 'return 2') });
  const base = commit(repo, 'main advances independently');
  git(repo, ['switch', '-q', `task/${TASK}`]);

  const report = checkShape(earlyArgs(repo, 'main', spec.slice(0, 12)), 0, { base, spec });
  expect(report.problems).toEqual([]);
  expect(report.notes.join('\n')).toMatch(/(?:owner|approval).*label|label.*owner|负责人.*标签/iu);
});

it('[AC-CT-06#3] reports a change outside a declared block', () => {
  const { repo, base } = fixture('outside-block');
  const outside = TIGHTER_BLOCK.replace('return 1', 'return 2');
  const spec = ruleTestCommit(repo, { [FROZEN_TEST]: outside }, BLOCK_ENTRY);
  const report = checkShape(earlyArgs(repo, 'main', spec), 1, { base, spec });
  expect(report.problems).toHaveLength(1);
  expect(report.problems[0]).toContain(FROZEN_TEST);
  expect(report.problems[0]).toMatch(/outside.*block/iu);
});

it('[AC-CT-06#4] lets a support entry add an import and notes a declaration with no file change', () => {
  const { repo, base } = fixture('support-import');
  const spec = ruleTestCommit(
    repo,
    {
      [KIT]: `import { basename } from 'node:path';\n${KIT_SOURCE}`,
      [`ops/evidence/${TASK}.json`]: 'invalid evidence ignored in early mode\n',
    },
    `${SUPPORT_ENTRY}\n${BLOCK_ENTRY}`,
  );
  const report = checkShape(earlyArgs(repo, 'main', spec), 0, { base, spec });
  expect(report.problems).toEqual([]);
  const unchanged =
    /un(?:touched|changed|modified)|no (?:matching )?(?:change|diff)|not (?:changed|modified)/iu;
  expect(report.notes.filter((note) => note.includes(FROZEN_TEST))).toEqual(
    expect.arrayContaining([expect.stringMatching(unchanged)]),
  );
});

it('[AC-CT-06#5] reports a function inserted into a frozen support file', () => {
  const { repo, base } = fixture('support-function');
  const spec = ruleTestCommit(
    repo,
    { [KIT]: `${KIT_SOURCE}\nexport function extra() {\n  return 1;\n}\n` },
    SUPPORT_ENTRY,
  );
  const report = checkShape(earlyArgs(repo, 'main', spec), 1, { base, spec });
  expect(report.problems).toHaveLength(1);
  expect(report.problems[0]).toContain(KIT);
  expect(report.problems[0]).toMatch(/function|allow.?list|token/iu);
});

it('[AC-CT-06#6] reports a frozen deletion and rename despite declarations', () => {
  const { repo, base } = fixture('delete-and-rename');
  const renamed = 'test/spec/identity/evidence-shape/renamed-kit.ts';
  rmSync(join(repo, FROZEN_TEST));
  git(repo, ['mv', KIT, renamed]);
  const spec = ruleTestCommit(repo, {}, `${BLOCK_ENTRY}\n${SUPPORT_ENTRY}`);
  const report = checkShape(earlyArgs(repo, 'main', spec), 1, { base, spec });
  expect(report.problems.find((problem) => problem.includes(FROZEN_TEST))).toMatch(/delet|remov/iu);
  expect(
    report.problems.find((problem) => problem.includes(renamed) || problem.includes(KIT)),
  ).toMatch(/renam|delet|remov/iu);
});

it('[AC-CT-06#7] allows a new test without evidence while land still requires evidence for RV2', () => {
  const { repo, base } = fixture('add-only');
  const spec = ruleTestCommit(repo);
  writeFiles(repo, { 'packages/money/src/fixture.ts': 'export const fixtureAmount = 1;\n' });
  const head = commit(repo, 'RV2 implementation without evidence');
  const land = evidence([
    '--pr',
    repo,
    '--base',
    base,
    '--head',
    head,
    '--head-ref',
    `task/${TASK}`,
    '--json',
  ]);
  expect(land.status, land.stderr).toBe(1);
  expect(JSON.parse(land.stdout)).toMatchObject({ ok: false, risk: 'RV2' });
  expect(land.stderr).toContain(`without ops/evidence/${TASK}.json`);

  const early = checkShape(earlyArgs(repo, 'main', spec), 0, { base, spec });
  expect(early.problems).toEqual([]);
});

it(
  '[AC-CT-06#8] distinguishes usage and unreadable inputs from a valid early invocation',
  () => {
    const { repo, base } = fixture('usage');
    const spec = ruleTestCommit(repo);
    const args = earlyArgs(repo, 'main', spec);
    for (const flag of ['--pr', '--task', '--base', '--spec']) {
      const missing = args.filter((arg, index) => arg !== flag && args[index - 1] !== flag);
      expect(evidence(missing).status, `missing ${flag}`).toBe(2);
    }
    for (const conflict of [
      ['--head', spec],
      ['--head-ref', `task/${TASK}`],
      ['--pr-number', '1'],
      ['--unknown'],
    ]) {
      expect(evidence([...args, ...conflict]).status, conflict.join(' ')).toBe(2);
    }
    expect(evidence(earlyArgs(repo, 'unknown-base', spec)).status).toBe(2);
    expect(evidence(earlyArgs(repo, 'main', '0'.repeat(40))).status).toBe(2);
    // The base commit has no ledger, even though the worktree's HEAD has one.
    expect(evidence(earlyArgs(repo, 'main', base)).status).toBe(2);
    expect(evidence(args).status).toBe(0);
  },
  CLI_TIMEOUT,
);

it('[AC-CT-06#9] ends the human-readable output with the problem count', () => {
  const { repo } = fixture('text');
  const spec = ruleTestCommit(repo, { [FROZEN_TEST]: TIGHTER_BLOCK });
  const result = evidence(earlyArgs(repo, 'main', spec));
  expect(result.status, result.stderr).toBe(1);
  const output = `${result.stdout}\n${result.stderr}`.trimEnd();
  expect(output).toContain(FROZEN_TEST);
  expect(output.split('\n').at(-1)).toBe('evidence shape: 1 problem(s)');
});
