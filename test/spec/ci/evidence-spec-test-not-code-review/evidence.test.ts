import { afterAll, beforeAll, expect, it } from 'vitest';
import { ENGINE_MODELS, evidenceProblems } from '../../../../tools/ci/evidence-check.ts';
import { loadProtected } from '../../../../tools/guard/lib/protected.ts';
import { repoRoot } from '../../../../tools/lib/paths.ts';
import {
  fixtureGit as git,
  removeDir,
  scratchDir,
  writeFiles,
} from '../../../../tools/ops/test-helpers.ts';

const task = 'CT-06zzzzzzzk';
const specRef = 'c'.repeat(40);
const moneyPath = 'packages/money';
const cfg = loadProtected(repoRoot());
let prDir: string;
let head: string;
let moneyTree: string;

const codexMoney = {
  reviewer: 'codex',
  review_type: 'money',
  engine: 'codex',
  model: ENGINE_MODELS['codex'],
  verdict: 'pass',
  open_s0_s1: 0,
  checklist_complete: true,
};
const independentMoney = {
  ...codexMoney,
  reviewer: 'claude-independent',
  engine: 'claude-independent',
  model: ENGINE_MODELS['claude-independent'],
};

beforeAll(() => {
  prDir = scratchDir('evidence-spec-test-not-code-review');
  git(prDir, ['init', '-q', '-b', 'fixture', '--object-format=sha1']);
  writeFiles(prDir, {
    SPEC_REF: `${specRef}\n`,
    [`${moneyPath}/src/fixture.ts`]: 'export const fixtureAmount = 1;\n',
  });
  git(prDir, ['add', '-A']);
  git(prDir, ['-c', 'commit.gpgSign=false', 'commit', '-qm', 'evidence fixture']);
  head = git(prDir, ['rev-parse', 'HEAD']);
  moneyTree = git(prDir, ['rev-parse', `${head}:${moneyPath}`]);
});

afterAll(() => {
  if (prDir !== undefined) removeDir(prDir);
});

function problemsOf(reviews: (typeof codexMoney)[]): string[] {
  return evidenceProblems(
    {
      task,
      spec_ref: specRef,
      spec_commit: head,
      runs: [],
      reviews,
      trees: { [moneyPath]: moneyTree },
      longrun: { passed: true, tree: moneyTree },
    },
    { prDir, head, task, cfg, red: { required: false, expected: [] }, implementer: 'claude' },
  );
}

it('[AC-CT-06zzzzzzzk#1] Claude 实现需要 Codex 代码评审，Codex 的规则测试评审可与它并存', () => {
  const specTest = { ...codexMoney, review_type: 'spec-test' };

  expect(problemsOf([specTest, codexMoney])).toEqual([]);
  expect(problemsOf([specTest])).toEqual([
    expect.stringMatching(/^reviews: missing the codex (?:code )?review\b/u),
  ]);
});

it('[AC-CT-06zzzzzzzk#2] 独立 Claude 只有代码评审可以替补 Codex', () => {
  const specTest = { ...independentMoney, review_type: 'spec-test' };

  expect(problemsOf([independentMoney])).toEqual([]);
  expect(problemsOf([specTest])).toEqual([
    expect.stringMatching(/^reviews: missing the codex (?:code )?review\b/u),
  ]);
});
