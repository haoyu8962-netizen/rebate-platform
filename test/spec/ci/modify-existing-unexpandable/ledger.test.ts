import { afterEach, expect, it } from 'vitest';
import { findRule, ruleHash } from '../../../../tools/ops/spec.ts';
import { checkTask } from '../../../../tools/ops/task.ts';
import { memorySpec } from '../../../../tools/ops/test-helpers.ts';
import {
  type Fields,
  SLOW,
  TASK,
  blockRecord,
  branch,
  check,
  cleanup,
  makeRepo,
  trusted,
  write,
} from '../modify-existing-support/kit.ts';
import { BR, FILE, TITLE, eachBlock, entry, source, taskLedger } from './kit.ts';

afterEach(cleanup);

const before = eachBlock(1);
const after = eachBlock(2);
const spec = memorySpec({
  '规划/05_里程碑与任务拆分.md': '| 任务 | 内容 |\n| --- | --- |\n| T9-01 | 演示任务 |\n',
  '规划/08_业务规则/01_DEMO.md': [
    '| 编号 | 规则 | 状态 | 影响面 |',
    '| --- | --- | --- | --- |',
    `| ${BR} | **演示规则**<br>返回二次验证摘要 | 已确认 | packages/demo |`,
    '',
    `#### ${BR} 细则 · 演示规则`,
    '',
    '- 状态：已确认',
    '- 例：二次验证成功时返回摘要',
    '',
  ].join('\n'),
});

const requireRuleChange = /rule_change/;
const requireNote = /\bnote\b|备注/i;
const overturned = 'D10-2558';
const basis = '规划/02 §12.3 约束二次验证响应';

const invalid: {
  label: string;
  declaration: Fields;
  record: Record<string, unknown>;
  diagnostic: RegExp;
}[] = [
  {
    label: 'flake_fix',
    declaration: { reason: 'flake_fix', br: undefined },
    record: {
      reason: 'flake_fix',
      br: undefined,
      mutation: undefined,
      loops: { runs: 100, all_green: true, where: 'local container' },
    },
    diagnostic: requireRuleChange,
  },
  {
    label: 'tighten_only',
    declaration: { reason: 'tighten_only', br: undefined },
    record: { reason: 'tighten_only', br: undefined },
    diagnostic: requireRuleChange,
  },
  {
    label: 'ruling_correction',
    declaration: { reason: 'ruling_correction', br: undefined, overturned, basis },
    record: { reason: 'ruling_correction', br: undefined, overturned, basis },
    diagnostic: requireRuleChange,
  },
  {
    label: '缺 note',
    declaration: { note: undefined },
    record: { br: [BR] },
    diagnostic: requireNote,
  },
  {
    label: 'note 只有空格',
    declaration: { note: '   ' },
    record: { br: [BR] },
    diagnostic: requireNote,
  },
];

function expectNamedProblem(problems: string[], diagnostic: RegExp): void {
  const problem = problems.find((p) => p.includes(FILE) && p.includes(TITLE) && diagnostic.test(p));
  expect(problem, problems.join('\n')).toBeDefined();
}

it.each(invalid)(
  '[AC-CT-06zzzzzzzc#7] 台账检查拒绝 $label 并点名整块登记',
  ({ declaration, diagnostic }) => {
    const ledger = taskLedger(entry(TITLE, declaration), ruleHash(findRule(BR, spec)));
    const root = trusted('invalid-whole-block-task', ledger);
    write(root, { [FILE]: source([before]) });
    expectNamedProblem(checkTask(TASK, { root, spec }), diagnostic);
  },
);

it.each(invalid)(
  '[AC-CT-06zzzzzzzc#8] 证据检查拒绝 $label 并点名整块登记',
  ({ declaration, record, diagnostic }) => {
    const repo = makeRepo('invalid-whole-block-evidence', { [FILE]: source([before]) });
    const ledger = taskLedger(entry(TITLE, declaration));
    const trustedDir = trusted('invalid-whole-block-evidence', ledger);
    const commit = branch(repo, 'invalid-whole-block', { [FILE]: source([after]) }, [
      blockRecord(FILE, TITLE, before, after, record),
    ]);
    expectNamedProblem(check(repo, commit, trustedDir).problems, diagnostic);
  },
  SLOW,
);
