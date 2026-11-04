import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { listTaskIds, loadTask } from '../lib/task-file.ts';
import { ruleHash, findRuleInText } from './spec.ts';
import {
  batchRisk,
  checkTask,
  checkTasks,
  computeRefsHash,
  CONTRACT_GENERATED,
  CONTRACT_GENERATED_EXEMPT,
  PLANNED_OPERATIONS_GEN_EXEMPT,
  PLANNED_OPERATIONS_GENERATED,
  MAX_TASK_LINES,
  countedLines,
  missingContractGenerated,
  showTask,
} from './task.ts';
import type { CheckOptions, RiskReport } from './task.ts';
import {
  CLI_TIMEOUT,
  fixedRisk,
  memorySpec,
  removeDir,
  runCli,
  scratchDir,
  taskYaml,
  writeFiles,
} from './test-helpers.ts';

const RULES = [
  '| 编号 | 规则 | 状态 | 影响面 |',
  '| --- | --- | --- | --- |',
  '| BR-DEMO-01 | **演示规则**<br>金额用整数分 | 已确认 | packages/demo |',
  '',
  '#### BR-DEMO-01 细则 · 演示规则',
  '',
  '- 状态：已确认',
  '- 例：1 分',
  '',
].join('\n');
const PLAN = [
  '| 任务 | 内容 |',
  '| --- | --- |',
  '| X1-01 | 演示任务 |',
  '| X1-02 | 第二个 |',
  '',
].join('\n');
const spec = memorySpec({
  '规划/08_业务规则/01_DEMO.md': RULES,
  '规划/05_里程碑与任务拆分.md': PLAN,
});
const demoRule = findRuleInText(RULES, 'BR-DEMO-01', 'demo.md');
const HASH = demoRule ? ruleHash(demoRule) : '';
const good = (fields: Record<string, string> = {}): string =>
  taskYaml({ refs_hash: `\n  BR-DEMO-01: ${HASH}`, ...fields });

let root = '';
const opts = (risk: 'RV0' | 'RV1' | 'RV2' = 'RV2'): CheckOptions => ({
  root,
  spec,
  risk: fixedRisk(risk),
});

beforeAll(() => {
  root = scratchDir('task');
  writeFiles(root, {
    'ops/tasks/X1-01.yaml': good(),
    'ops/tasks/X1-01a.yaml': good({ id: 'X1-01a', deps: '[X1-01, X1-02]' }),
    'ops/tasks/archive/202609/X1-02.yaml': good({ id: 'X1-02', status: 'done' }),
    'ops/tasks/X1-01b.yaml': good({ id: 'X1-01b', refs_hash: '\n  BR-DEMO-01: aaaaaaaaaaaa' }),
    'ops/tasks/X1-01c.yaml': good({ id: 'X1-01c', refs: '[BR-DEMO-01, BR-DEMO-07]' }),
    'ops/tasks/X9-01.yaml': good({ id: 'X9-01' }),
    'ops/tasks/X1-01d.yaml': good({ id: 'X1-01d', deps: '[X1-77]' }),
    'ops/tasks/X1-01e.yaml': good({ id: 'X1-01e', tester: 'codex' }),
    'ops/tasks/X1-01f.yaml': good({ id: 'X1-01f', tester: 'none' }),
    'ops/tasks/X1-01g.yaml': `${good({ id: 'X1-01g' })}${'# padding\n'.repeat(MAX_TASK_LINES)}`,
    'ops/tasks/X1-01h.yaml': good({ id: 'X1-01zz' }),
    'ops/tasks/X1-01i.yaml': good({ id: 'X1-01i', type: 'feature', paths: '[]' }),
    'ops/tasks/X1-01j.yaml': good({ id: 'X1-01j', refs_hash: '{}' }),
    // The fixture's switch-baseline ledgers: these may omit test_paths (CR2-02).
    'tools/guard/legacy-tasks.json': JSON.stringify({
      baseline: 'fixture',
      tasks: [
        'X1-01',
        'X1-01a',
        'X1-01b',
        'X1-01c',
        'X1-01d',
        'X1-01e',
        'X1-01f',
        'X1-01g',
        'X1-01h',
        'X1-01i',
        'X1-01j',
        'X1-02',
        'X9-01',
      ],
    }),
  });
});

afterAll(() => removeDir(root));

it('accepts a valid task and a split task whose dependency is archived', () => {
  expect(checkTask('X1-01', opts())).toEqual([]);
  expect(checkTask('X1-01a', opts())).toEqual([]);
  expect(computeRefsHash(['BR-DEMO-01'], spec)).toEqual({ 'BR-DEMO-01': HASH });
});

it('flags a stale hash, an unknown reference and a missing hash entry', () => {
  expect(checkTask('X1-01b', opts()).join('\n')).toMatch(
    new RegExp(`BR-DEMO-01 is aaaaaaaaaaaa but the text at SPEC_REF hashes to ${HASH}`),
  );
  expect(checkTask('X1-01c', opts()).join('\n')).toMatch(/BR-DEMO-07: not found/);
  expect(checkTask('X1-01j', opts()).join('\n')).toMatch(/refs_hash: missing entry for BR-DEMO-01/);
});

it('flags an id that 规划/05 does not know and a missing dependency', () => {
  expect(checkTask('X9-01', opts())).toEqual([
    'task id prefix X9-01 is not a task row of 规划/05 at SPEC_REF',
  ]);
  expect(checkTask('X1-01d', opts())).toEqual(['deps: X1-77 is not in ops/tasks']);
});

it('requires another model as rule-test author for RV2 implementation work', () => {
  expect(checkTask('X1-01e', opts('RV2')).join('\n')).toMatch(/tester: must differ from impl/);
  expect(checkTask('X1-01f', opts('RV2')).join('\n')).toMatch(/RV2 tasks need a rule-test author/);
  expect(checkTask('X1-01e', opts('RV1'))).toEqual([]);
  expect(checkTask('X1-01f', opts('RV0'))).toEqual([]);
});

it('flags the line limit, a wrong file name and shape errors', () => {
  expect(checkTask('X1-01g', opts()).join('\n')).toMatch(/lines, the limit is 40/);
  expect(checkTask('X1-01h', opts()).join('\n')).toMatch(/does not match the file name/);
  const shape = checkTask('X1-01i', opts()).join('\n');
  expect(shape).toMatch(/type: must be one of/);
  expect(shape).toMatch(/paths: must not be empty/);
});

it('checks every file of the ledger and reports the failing ones', () => {
  const results = checkTasks([], opts());
  const failed = results.filter((r) => r.problems.length > 0).map((r) => r.id);
  expect(results).toHaveLength(12);
  expect(failed).toEqual([
    'X1-01b',
    'X1-01c',
    'X1-01d',
    'X1-01e',
    'X1-01f',
    'X1-01g',
    'X1-01h',
    'X1-01i',
    'X1-01j',
    'X9-01',
  ]);
  expect(checkTasks(['X1-99'], opts())[0]?.problems).toEqual([
    'ops/tasks/X1-99.yaml does not exist',
  ]);
});

it('[CT-06t] the red_exempt section is not counted in the line limit; it has its own limit of 50 entries', () => {
  const entries = (n: number): string =>
    Array.from(
      { length: n },
      (_, i) =>
        `\n  - file: 'test/spec/demo/rules.test.ts'\n    test: '[AC-${i + 1}] structural case ${i + 1}'\n    reason: structural, holds for the old data too`,
    ).join('');
  // A body of exactly MAX_TASK_LINES - 5 = 35 lines (the B2-01l shape) plus 13 declarations.
  const body = (fields: Record<string, string>): string => {
    const base = good({
      impl: 'claude',
      tester: 'codex',
      test_paths: "\n  - 'test/spec/demo/**'",
      ...fields,
    });
    const have = countedLines(base);
    return `${'# padding\n'.repeat(MAX_TASK_LINES - 5 - have)}${base}`;
  };
  const thirteen = body({ id: 'X1-02d', red_exempt: entries(13) });
  expect(thirteen.split('\n').length - 1).toBe(MAX_TASK_LINES - 5 + 13 * 3 + 1);
  expect(countedLines(thirteen)).toBe(MAX_TASK_LINES - 5);
  writeFiles(root, {
    'tools/guard/protected-paths.json': JSON.stringify({
      class1_add_only: ['test/spec/**', 'test/properties/**'],
      class2_verify_config: [],
      class3_gates: [],
    }),
    'ops/tasks/X1-02d.yaml': thirteen,
    // 151 declarations: over the section's own limit (150 since CT-06zzzb).
    'ops/tasks/X1-02e.yaml': body({ id: 'X1-02e', red_exempt: entries(151) }),
    // 41 body lines without red_exempt: still over the line limit.
    'ops/tasks/X1-02f.yaml': `${'# padding\n'.repeat(6)}${body({ id: 'X1-02f' })}`,
    // An entry that is not file / test / reason hides nothing in the section.
    'ops/tasks/X1-02g.yaml': body({
      id: 'X1-02g',
      red_exempt: `${entries(1)}\n  - note: a stray mapping\n  - 'test/spec/demo/rules.test.ts'`,
    }),
  });
  try {
    expect(checkTask('X1-02d', opts('RV1'))).toEqual([]);
    expect(loadTask('X1-02d', root).red_exempt).toHaveLength(13);
    expect(checkTask('X1-02e', opts('RV1')).join('\n')).toContain(
      'red_exempt: 151 entries, the limit is 150',
    );
    const long = checkTask('X1-02f', opts('RV1')).join('\n');
    expect(long).toMatch(/41 lines, the limit is 40/);
    expect(long).toContain('the red_exempt section is not counted');
    const mixed = checkTask('X1-02g', opts('RV1')).join('\n');
    expect(mixed).toContain('red_exempt[1].note: unknown field');
    expect(mixed).toContain('red_exempt[1].file: must be a non-empty repository path');
    expect(mixed).toContain('red_exempt[2]: must be a mapping (file / test / reason)');
  } finally {
    for (const id of ['X1-02d', 'X1-02e', 'X1-02f', 'X1-02g'])
      removeDir(`${root}/ops/tasks/${id}.yaml`);
  }
  // countedLines: the section ends at the next top-level line; a comment line counts.
  expect(
    countedLines(
      'id: X\nred_exempt:\n  - file: a\n    test: b\n    reason: cccccccccc\n# c\nstatus: todo\n',
    ),
  ).toBe(3);
  expect(countedLines('id: X\nstatus: todo')).toBe(2);
});

it('[CT-06zxh] an indented comment line inside the red_exempt / renames / expected_values sections still counts', () => {
  for (const key of ['red_exempt', 'renames', 'expected_values']) {
    const text = `id: X\n${key}:\n  # a note\n  - file: a\n    # another\n    test: b\n\t# a tab\nstatus: todo\n`;
    expect(countedLines(text), key).toBe(5);
    expect(countedLines(text.replace(/^[ \t]+#.*\n/gm, '')), key).toBe(2);
  }
  // A reason that merely contains `#` is part of a declaration.
  expect(countedLines("id: X\nred_exempt:\n  - reason: 'a # b'\nstatus: todo\n")).toBe(2);
});

it('[CT-06zxc] the renames section is not counted in the line limit either; it has its own limit of 20 entries', () => {
  const pairs = (n: number): string =>
    Array.from(
      { length: n },
      (_, i) => `\n  - from: "'job-${i + 1}'"\n    to: "'job_${i + 1}'"`,
    ).join('');
  const body = (fields: Record<string, string>): string => {
    const base = good({
      impl: 'claude',
      tester: 'codex',
      test_paths: "\n  - 'test/spec/demo/**'",
      ...fields,
    });
    return `${'# padding\n'.repeat(MAX_TASK_LINES - countedLines(base))}${base}`;
  };
  // A body of exactly MAX_TASK_LINES lines (the B1-03w shape) plus 20 renames (40 more lines).
  const full = body({ id: 'X1-02za', renames: pairs(20) });
  expect(countedLines(full)).toBe(MAX_TASK_LINES);
  expect(full.split('\n').length - 1).toBe(MAX_TASK_LINES + 20 * 2 + 1);
  writeFiles(root, {
    'tools/guard/protected-paths.json': JSON.stringify({
      class1_add_only: ['test/spec/**', 'test/properties/**'],
      class2_verify_config: [],
      class3_gates: [],
    }),
    'ops/tasks/X1-02za.yaml': full,
    // Both sections next to each other, neither counted.
    'ops/tasks/X1-02zb.yaml': body({
      id: 'X1-02zb',
      renames: pairs(3),
      red_exempt:
        "\n  - file: 'test/spec/demo/rules.test.ts'\n    test: '[AC-1] a'\n    reason: structural, holds for the old data too",
    }),
    // 21 renames: over the section's own limit.
    'ops/tasks/X1-02zc.yaml': body({ id: 'X1-02zc', renames: pairs(21) }),
    // Something other than a rename hides nothing in the section.
    'ops/tasks/X1-02zd.yaml': body({
      id: 'X1-02zd',
      renames: `${pairs(1)}\n  - note: a stray mapping\n  - 'toBe(100)'`,
    }),
  });
  try {
    expect(checkTask('X1-02za', opts('RV1'))).toEqual([]);
    expect(loadTask('X1-02za', root).renames).toHaveLength(20);
    expect(checkTask('X1-02zb', opts('RV1'))).toEqual([]);
    expect(checkTask('X1-02zc', opts('RV1')).join('\n')).toContain(
      'renames: 21 entries, the limit is 20',
    );
    const stray = checkTask('X1-02zd', opts('RV1')).join('\n');
    expect(stray).toContain('renames[1].note: unknown field');
    expect(stray).toContain('renames[2]: must be a mapping (from / to)');
  } finally {
    for (const id of ['X1-02za', 'X1-02zb', 'X1-02zc', 'X1-02zd'])
      removeDir(`${root}/ops/tasks/${id}.yaml`);
  }
  // countedLines: the section ends at the next top-level line.
  expect(
    countedLines(`id: X\nrenames:\n  - from: "'aaa'"\n    to: "'bbb'"\n# c\nstatus: todo\n`),
  ).toBe(3);
});

it('[CT-06r] red_exempt names rule-test files inside test_paths of a task with a rule-test author', () => {
  const entry = (file: string): string =>
    `\n  - file: '${file}'\n    test: '[AC-1] a'\n    reason: structural, holds for the old data too`;
  writeFiles(root, {
    'tools/guard/protected-paths.json': JSON.stringify({
      class1_add_only: ['test/spec/**', 'test/properties/**'],
      class2_verify_config: [],
      class3_gates: [],
    }),
    'ops/tasks/X1-02a.yaml': good({
      id: 'X1-02a',
      impl: 'claude',
      tester: 'codex',
      test_paths: "\n  - 'test/spec/demo/**'",
      red_exempt: entry('test/spec/demo/rules.test.ts'),
    }),
    // Outside test_paths; not a rule-test file; no rule-test author.
    'ops/tasks/X1-02b.yaml': good({
      id: 'X1-02b',
      impl: 'claude',
      tester: 'codex',
      test_paths: "\n  - 'test/spec/demo/**'",
      red_exempt: entry('test/spec/other/rules.test.ts') + entry('test/spec/demo/expected.csv'),
    }),
    'ops/tasks/X1-02c.yaml': good({
      id: 'X1-02c',
      impl: 'claude',
      tester: 'none',
      red_exempt: entry('test/spec/demo/rules.test.ts'),
    }),
  });
  try {
    expect(checkTask('X1-02a', opts('RV1'))).toEqual([]);
    expect(loadTask('X1-02a', root).red_exempt).toEqual([
      {
        file: 'test/spec/demo/rules.test.ts',
        test: '[AC-1] a',
        reason: 'structural, holds for the old data too',
      },
    ]);
    expect(checkTask('X1-02b', opts('RV1'))).toEqual([
      `red_exempt: "test/spec/other/rules.test.ts" is not inside the task's test_paths`,
      'red_exempt: "test/spec/demo/expected.csv" is not a rule-test file (*.test.ts)',
    ]);
    expect(checkTask('X1-02c', opts('RV1'))).toContain(
      'red_exempt: a task without a rule-test author (tester: none) has no red run to exempt from',
    );
  } finally {
    for (const id of ['X1-02a', 'X1-02b', 'X1-02c']) removeDir(`${root}/ops/tasks/${id}.yaml`);
  }
});

it('[CT-06zxe] expected_values name rule-test files inside test_paths of a task with a rule-test author; the section is not counted in the line limit', () => {
  const entry = (file: string, i = 0): string =>
    `\n  - file: '${file}'\n    helper: onlyAnomaly\n    from: '    diff_fen: AMOUNT${i},'\n    to: '    diff_fen: -AMOUNT${i},'`;
  const entries = (n: number): string =>
    Array.from({ length: n }, (_, i) => entry('test/spec/demo/rules.test.ts', i)).join('');
  const body = (fields: Record<string, string>): string => {
    const base = good({
      impl: 'claude',
      tester: 'codex',
      test_paths: "\n  - 'test/spec/demo/**'",
      ...fields,
    });
    return `${'# padding\n'.repeat(MAX_TASK_LINES - countedLines(base))}${base}`;
  };
  // A body of exactly MAX_TASK_LINES lines plus 20 entries (80 more lines).
  const full = body({ id: 'X1-02ea', expected_values: entries(20) });
  expect(countedLines(full)).toBe(MAX_TASK_LINES);
  writeFiles(root, {
    'tools/guard/protected-paths.json': JSON.stringify({
      class1_add_only: ['test/spec/**', 'test/properties/**'],
      class2_verify_config: [],
      class3_gates: [],
    }),
    'ops/tasks/X1-02ea.yaml': full,
    // 21 entries: over the section's own limit.
    'ops/tasks/X1-02eb.yaml': body({ id: 'X1-02eb', expected_values: entries(21) }),
    // Outside test_paths; not a rule-test file.
    'ops/tasks/X1-02ec.yaml': good({
      id: 'X1-02ec',
      impl: 'claude',
      tester: 'codex',
      test_paths: "\n  - 'test/spec/demo/**'",
      expected_values: entry('test/spec/other/rules.test.ts') + entry('test/spec/demo/kit.ts'),
    }),
    // No rule-test author.
    'ops/tasks/X1-02ed.yaml': good({
      id: 'X1-02ed',
      impl: 'claude',
      tester: 'none',
      expected_values: entry('test/spec/demo/rules.test.ts'),
    }),
  });
  try {
    expect(checkTask('X1-02ea', opts('RV1'))).toEqual([]);
    expect(loadTask('X1-02ea', root).expected_values[0]).toEqual({
      file: 'test/spec/demo/rules.test.ts',
      helper: 'onlyAnomaly',
      from: '    diff_fen: AMOUNT0,',
      to: '    diff_fen: -AMOUNT0,',
    });
    expect(checkTask('X1-02eb', opts('RV1')).join('\n')).toContain(
      'expected_values: 21 entries, the limit is 20',
    );
    expect(checkTask('X1-02ec', opts('RV1'))).toEqual([
      `expected_values: "test/spec/other/rules.test.ts" is not inside the task's test_paths`,
      'expected_values: "test/spec/demo/kit.ts" is not a rule-test file (*.test.ts)',
    ]);
    expect(checkTask('X1-02ed', opts('RV1'))).toContain(
      'expected_values: a task without a rule-test author (tester: none) has no red run to register them for',
    );
  } finally {
    for (const id of ['X1-02ea', 'X1-02eb', 'X1-02ec', 'X1-02ed'])
      removeDir(`${root}/ops/tasks/${id}.yaml`);
  }
  expect(
    countedLines(
      "id: X\nexpected_values:\n  - file: a\n    helper: h\n    from: 'a: 1'\n    to: 'a: 2'\n# c\nstatus: todo\n",
    ),
  ).toBe(3);
});

it('[ops/approvals.yaml id 19] test_paths stay inside the rule-test assets of a task with a tester', () => {
  writeFiles(root, {
    'tools/guard/protected-paths.json': JSON.stringify({
      class1_add_only: ['test/spec/**', 'test/properties/**', 'specs/commission-examples.csv'],
      class2_verify_config: [],
      class3_gates: [],
    }),
    // A new ledger (not on the switch-baseline list) with a rule-test author and no test_paths.
    'ops/tasks/X1-01n.yaml': good({ id: 'X1-01n', tester: 'codex', impl: 'claude' }),
    // A new ledger with the old roles (CR3-03).
    'ops/tasks/X1-01o.yaml': good({
      id: 'X1-01o',
      impl: 'codex',
      tester: 'claude',
      test_paths: "\n  - 'test/spec/demo/**'",
    }),
    'ops/tasks/X1-01k.yaml': good({
      id: 'X1-01k',
      impl: 'claude',
      tester: 'codex',
      test_paths: "\n  - 'test/spec/demo/**'\n  - 'test/properties/demo/*.test.ts'",
    }),
    'ops/tasks/X1-01l.yaml': good({
      id: 'X1-01l',
      impl: 'claude',
      tester: 'codex',
      test_paths:
        "\n  - 'packages/demo/src/**'\n  - 'test/sp*'\n  - 'specs/commission-examples.csv'",
    }),
    'ops/tasks/X1-01m.yaml': good({
      id: 'X1-01m',
      impl: 'claude',
      tester: 'none',
      test_paths: "\n  - 'test/spec/demo/**'",
    }),
  });
  try {
    expect(checkTask('X1-01k', opts('RV1'))).toEqual([]);
    expect(loadTask('X1-01k', root).test_paths).toEqual([
      'test/spec/demo/**',
      'test/properties/demo/*.test.ts',
    ]);
    // An older ledger without the field still parses (test_paths: []).
    expect(loadTask('X1-01', root).test_paths).toEqual([]);
    expect(checkTask('X1-01l', opts('RV1'))).toEqual([
      'test_paths: "packages/demo/src/**" is not inside the rule-test assets (class 1 of tools/guard/protected-paths.json)',
      'test_paths: "test/sp*" is not inside the rule-test assets (class 1 of tools/guard/protected-paths.json)',
    ]);
    expect(checkTask('X1-01m', opts('RV1')).join('\n')).toContain(
      'a task without a rule-test author (tester: none) has no test_paths',
    );
    // CR2-02: a new task that omits test_paths is refused; a switch-baseline ledger is not.
    expect(checkTask('X1-01n', opts('RV1')).join('\n')).toContain(
      'test_paths: required for a task with a rule-test author (tester: codex)',
    );
    expect(checkTask('X1-01', opts('RV1'))).toEqual([]);
    // CR3-03: a new ledger cannot take the old roles; a legacy one keeps them.
    expect(checkTask('X1-01o', opts('RV1'))).toEqual([
      'impl: must be claude for a task written after the switch of 2026-10-05 (a Codex handover is recorded at run time, not in the ledger)',
      'tester: must be codex or none for a task written after the switch of 2026-10-05',
    ]);
    expect(checkTask('X1-01e', opts('RV1'))).toEqual([]);
  } finally {
    for (const id of ['X1-01k', 'X1-01l', 'X1-01m', 'X1-01n', 'X1-01o']) {
      removeDir(`${root}/ops/tasks/${id}.yaml`);
    }
  }
});

// A stand-in for the trusted guard: one report per set, counting the calls.
function countingGuard(): {
  manyCalls: string[][][];
  oneCalls: string[][];
  many: (sets: readonly (readonly string[])[]) => RiskReport[];
  one: (paths: readonly string[]) => RiskReport;
} {
  const report = (paths: readonly string[]): RiskReport => ({
    risk: paths.some((p) => p.startsWith('apps/')) ? 'RV1' : 'RV0',
    ask: false,
    paths: paths.map((path) => ({ path, risk: 'RV0', rule: null, protected: null })),
  });
  const g = {
    manyCalls: [] as string[][][],
    oneCalls: [] as string[][],
    many: (sets: readonly (readonly string[])[]) => {
      g.manyCalls.push(sets.map((s) => [...s]));
      return sets.map(report);
    },
    one: (paths: readonly string[]) => {
      g.oneCalls.push([...paths]);
      return report(paths);
    },
  };
  return g;
}

it('batchRisk asks the guard once for all distinct sets and hands back its report per set', () => {
  const g = countingGuard();
  const lookup = batchRisk([['docs/a.md'], ['apps/x/**', 'docs/a.md'], ['docs/a.md']], g);
  expect(lookup(['apps/x/**', 'docs/a.md'])).toEqual(g.one(['apps/x/**', 'docs/a.md']));
  expect(lookup(['docs/a.md']).risk).toBe('RV0');
  expect(g.manyCalls).toEqual([[['docs/a.md'], ['apps/x/**', 'docs/a.md']]]);
  // A set the batch was not asked about goes to the guard on its own.
  g.oneCalls.length = 0;
  expect(lookup(['apps/y/**']).risk).toBe('RV1');
  expect(g.oneCalls).toEqual([['apps/y/**']]);
});

it('batchRisk asks every set on its own when the combined call fails or is not one report per set', () => {
  for (const broken of [
    () => {
      throw new Error('guard failed');
    },
    () => [] as RiskReport[],
  ]) {
    const g = countingGuard();
    const reasons: string[] = [];
    const lookup = batchRisk([['docs/a.md'], ['apps/x/**']], {
      many: broken,
      one: g.one,
      onFallback: (r) => reasons.push(r),
    });
    expect(lookup(['docs/a.md']).risk).toBe('RV0');
    expect(lookup(['apps/x/**']).risk).toBe('RV1');
    expect(g.oneCalls).toEqual([['docs/a.md'], ['apps/x/**']]);
    expect(reasons).toHaveLength(1);
  }
});

it('checkTasks asks the guard once, for the implementation tasks only', () => {
  const own = scratchDir('task-batch');
  writeFiles(own, {
    'ops/tasks/X1-01.yaml': good(),
    'ops/tasks/X1-01a.yaml': good({ id: 'X1-01a', paths: "\n  - 'apps/x/**'" }),
    'ops/tasks/X1-01b.yaml': good({ id: 'X1-01b', type: 'migration', paths: "\n  - 'db/m/**'" }),
    'ops/tasks/X1-01c.yaml': good({ id: 'X1-01c', type: 'contract', paths: "\n  - 'docs/x/**'" }),
  });
  try {
    const g = countingGuard();
    const ids = ['X1-01', 'X1-01a', 'X1-01b', 'X1-01c'];
    const results = checkTasks(ids, { root: own, spec, riskSets: g.many, risk: g.one });
    expect(results.map((r) => r.id)).toEqual(ids);
    expect(g.manyCalls).toEqual([[['packages/demo/src/**'], ['apps/x/**'], ['db/m/**']]]);
    expect(g.oneCalls).toEqual([]);
  } finally {
    removeDir(own);
  }
});

it('shows a task together with its computed risk', () => {
  const view = showTask('X1-01', opts('RV1'));
  expect(view.id).toBe('X1-01');
  expect(view.risk).toBe('RV1');
  expect(view.risk_paths).toEqual([
    { path: 'packages/demo/src/**', risk: 'RV1', rule: null, protected: null },
  ]);
});

// The cases below use the real ledger, the real guard and the planning repository at SPEC_REF.

// The whole ledger (over 1000 tasks) takes 24–30 s on a loaded test machine; D10-438 gives this
// one case 90 s.
const LEDGER_CHECK_TIMEOUT = 90_000;

it(
  'the real ledger passes `task.ts check`',
  () => {
    const res = runCli('task.ts', ['check', '--json']);
    expect(res.stderr).toContain('台账检查通过');
    expect(res.status).toBe(0);
    const doc = JSON.parse(res.stdout) as { ok: boolean; tasks: { id: string }[] };
    expect(doc.ok).toBe(true);
    expect(doc.tasks.map((t) => t.id)).toEqual(listTaskIds());
  },
  LEDGER_CHECK_TIMEOUT,
);

it(
  '`task.ts show <id> --json` prints a real task together with its computed risk',
  () => {
    // Whatever the ledger holds today; archived tasks leave it (规划/11 §2.1).
    const id = listTaskIds()[0];
    if (id === undefined) {
      expect(runCli('task.ts', ['show', 'ZZ-99', '--json']).status).toBe(1);
      return;
    }
    const task = loadTask(id);
    const res = runCli('task.ts', ['show', id, '--json']);
    expect(res.status).toBe(0);
    const doc = JSON.parse(res.stdout) as { risk: string; risk_paths: { path: string }[] };
    expect(doc).toMatchObject({ id, impl: task.impl, tester: task.tester, paths: task.paths });
    expect(doc.risk).toMatch(/^RV[012]$/);
    expect(doc.risk_paths.map((p) => p.path)).toEqual(task.paths);
    // The money package is funds code: never below RV2 (规划/11 §1.1).
    if (task.paths.some((p) => p.startsWith('packages/money/'))) expect(doc.risk).toBe('RV2');
  },
  CLI_TIMEOUT,
);

it(
  'rejects bad usage with exit code 2',
  () => {
    expect(runCli('task.ts', ['show', 'B2-01a']).status).toBe(2);
    expect(runCli('task.ts', ['check', '../etc']).status).toBe(2);
    expect(runCli('task.ts', ['frobnicate']).status).toBe(2);
  },
  CLI_TIMEOUT,
);

it('[ops/approvals.yaml id 23] a listed row and its split tasks may name impl: codex with tester: claude; nothing else changes', () => {
  writeFiles(root, {
    'tools/guard/protected-paths.json': JSON.stringify({
      class1_add_only: ['test/spec/**'],
      class2_verify_config: [],
      class3_gates: [],
    }),
    'tools/guard/codex-impl-tasks.json': JSON.stringify({
      approval: 23,
      tasks: ['X1-02'],
      forbidden_paths: ['packages/money/**', 'db/**', 'apps/api/src/modules/commission/**'],
    }),
    'ops/tasks/X1-02i.yaml': good({
      id: 'X1-02i',
      impl: 'codex',
      tester: 'claude',
      test_paths: "\n  - 'test/spec/demo/**'",
      paths: "\n  - 'apps/api/src/**'",
    }),
    // Listed, Codex-first pair, but reaching a forbidden path or not an impl task (S2-1).
    'ops/tasks/X1-02g.yaml': good({
      id: 'X1-02g',
      impl: 'codex',
      tester: 'claude',
      test_paths: "\n  - 'test/spec/demo/**'",
      paths: "\n  - 'packages/money/src/**'",
    }),
    'ops/tasks/X1-02h.yaml': good({
      id: 'X1-02h',
      type: 'migration',
      impl: 'codex',
      tester: 'claude',
      test_paths: "\n  - 'test/spec/demo/**'",
      paths: "\n  - 'db/migrations/**'",
    }),
    // Listed row X1-02, split task with the Codex-first pair.
    'ops/tasks/X1-02c.yaml': good({
      id: 'X1-02c',
      impl: 'codex',
      tester: 'claude',
      test_paths: "\n  - 'test/spec/demo/**'",
    }),
    // Listed row, but the pair is not the Codex-first one.
    'ops/tasks/X1-02d.yaml': good({
      id: 'X1-02d',
      impl: 'codex',
      tester: 'codex',
      test_paths: "\n  - 'test/spec/demo/**'",
    }),
    // Listed row, Codex-first pair, but no test_paths: Claude's rule tests still need them.
    'ops/tasks/X1-02e.yaml': good({ id: 'X1-02e', impl: 'codex', tester: 'claude' }),
    // Listed row keeping the default split is still fine (a withdrawn exception, 规划/11 §2.5).
    'ops/tasks/X1-02f.yaml': good({
      id: 'X1-02f',
      impl: 'claude',
      tester: 'codex',
      test_paths: "\n  - 'test/spec/demo/**'",
    }),
    // Row X1-01 is not listed: the Codex-first pair stays refused.
    'ops/tasks/X1-01p.yaml': good({
      id: 'X1-01p',
      impl: 'codex',
      tester: 'claude',
      test_paths: "\n  - 'test/spec/demo/**'",
    }),
  });
  try {
    expect(checkTask('X1-02c', opts('RV2'))).toEqual([]);
    expect(checkTask('X1-02c', opts('RV1'))).toEqual([]);
    expect(checkTask('X1-02d', opts('RV1'))).toEqual([
      'impl: must be claude for a task written after the switch of 2026-10-05 (a Codex handover is recorded at run time, not in the ledger)',
    ]);
    expect(checkTask('X1-02e', opts('RV1')).join('\n')).toContain(
      'test_paths: required for a task with a rule-test author (tester: claude)',
    );
    expect(checkTask('X1-02f', opts('RV2'))).toEqual([]);
    expect(checkTask('X1-01p', opts('RV1'))).toEqual([
      'impl: must be claude for a task written after the switch of 2026-10-05 (a Codex handover is recorded at run time, not in the ledger)',
      'tester: must be codex or none for a task written after the switch of 2026-10-05',
    ]);
    expect(checkTask('X1-02g', opts('RV2'))).toEqual([
      'paths: "packages/money/src/**" reaches "packages/money/**", which stays with the default split (ops/approvals.yaml id 19), not a Codex implementation',
    ]);
    // A glob that may reach a forbidden module is refused too.
    expect(checkTask('X1-02i', opts('RV2')).join('\n')).toContain(
      'reaches "apps/api/src/modules/commission/**"',
    );
    const migration = checkTask('X1-02h', opts('RV2')).join('\n');
    expect(migration).toContain(
      'a Codex implementation (tools/guard/codex-impl-tasks.json) is for type impl only, not migration',
    );
    expect(migration).toContain('paths: "db/migrations/**" reaches "db/**"');
    // Without forbidden_paths the list lets nothing through (fail-closed).
    writeFiles(root, {
      'tools/guard/codex-impl-tasks.json': JSON.stringify({ approval: 23, tasks: ['X1-02'] }),
    });
    expect(checkTask('X1-02c', opts('RV1')).join('\n')).toContain('has no forbidden_paths');
    // A broken list lists nothing (fail-closed).
    writeFiles(root, { 'tools/guard/codex-impl-tasks.json': '{ broken' });
    expect(checkTask('X1-02c', opts('RV1')).join('\n')).toContain('impl: must be claude');
  } finally {
    for (const id of [
      'X1-02c',
      'X1-02d',
      'X1-02e',
      'X1-02f',
      'X1-02g',
      'X1-02h',
      'X1-02i',
      'X1-01p',
    ]) {
      removeDir(`${root}/ops/tasks/${id}.yaml`);
    }
    removeDir(`${root}/tools/guard/codex-impl-tasks.json`);
  }
});

it('[ops/approvals.yaml id 31] mechanical_paths: only on a Codex implementation ledger, only the listed files, outside forbidden_paths', () => {
  writeFiles(root, {
    'tools/guard/protected-paths.json': JSON.stringify({
      class1_add_only: ['test/spec/**'],
      class2_verify_config: [],
      class3_gates: [],
    }),
    'tools/guard/codex-impl-tasks.json': JSON.stringify({
      approval: 23,
      tasks: ['X1-02'],
      forbidden_paths: ['contracts/**', 'packages/contracts-ts/**'],
      mechanical_paths: [
        'contracts/openapi.yaml',
        'packages/contracts-ts/src/openapi.gen.ts',
        'apps/api/src/modules/platform/validation/route-schemas.gen.ts',
      ],
    }),
    // Codex implementation with the contract and generated files as mechanical paths: the
    // whitelist accepts them; since CT-06zxd the missing planned-operations.gen.ts is reported.
    'ops/tasks/X1-02m.yaml': good({
      id: 'X1-02m',
      impl: 'codex',
      tester: 'claude',
      test_paths: "\n  - 'test/spec/demo/**'",
      paths: "\n  - 'apps/api/src/modules/content/**'",
      mechanical_paths:
        "\n  - 'contracts/openapi.yaml'\n  - 'packages/contracts-ts/src/openapi.gen.ts'\n  - 'apps/api/src/modules/platform/validation/route-schemas.gen.ts'",
    }),
    // A mechanical path not on the list, or a wider glob over the contracts.
    'ops/tasks/X1-02n.yaml': good({
      id: 'X1-02n',
      impl: 'codex',
      tester: 'claude',
      test_paths: "\n  - 'test/spec/demo/**'",
      paths: "\n  - 'apps/api/src/modules/content/**'",
      mechanical_paths: "\n  - 'contracts/**'\n  - 'apps/api/src/modules/content/a.ts'",
    }),
    // The contract in paths is still refused for a Codex implementation.
    'ops/tasks/X1-02o.yaml': good({
      id: 'X1-02o',
      impl: 'codex',
      tester: 'claude',
      test_paths: "\n  - 'test/spec/demo/**'",
      paths: "\n  - 'apps/api/src/modules/content/**'\n  - 'contracts/openapi.yaml'",
    }),
    // A Claude implementation names the files in paths, not mechanical_paths.
    'ops/tasks/X1-01q.yaml': good({
      id: 'X1-01q',
      impl: 'claude',
      tester: 'codex',
      test_paths: "\n  - 'test/spec/demo/**'",
      mechanical_paths: "\n  - 'contracts/openapi.yaml'",
    }),
  });
  try {
    expect(checkTask('X1-02m', opts('RV1'))).toEqual([
      'mechanical_paths: reach "contracts/openapi.yaml", so the ledger must also cover the files regenerated from it (CT-06n, CT-06zxd); add: packages/contracts-ts/src/planned-operations.gen.ts',
    ]);
    expect(checkTask('X1-02n', opts('RV1'))).toEqual([
      'mechanical_paths: "contracts/**" is not one of the mechanical_paths of tools/guard/codex-impl-tasks.json (ops/approvals.yaml id 31)',
      'mechanical_paths: "apps/api/src/modules/content/a.ts" is not one of the mechanical_paths of tools/guard/codex-impl-tasks.json (ops/approvals.yaml id 31)',
      'mechanical_paths: reach "contracts/openapi.yaml", so the ledger must also cover the files regenerated from it (CT-06n, CT-06zxd); add: packages/contracts-ts/src/planned-operations.gen.ts',
    ]);
    expect(checkTask('X1-02o', opts('RV1'))).toEqual([
      'paths: "contracts/openapi.yaml" reaches "contracts/**", which stays with the default split (ops/approvals.yaml id 19), not a Codex implementation',
      'paths: reach "contracts/openapi.yaml", so the ledger must also cover the files regenerated from it (CT-06n, CT-06zxd); add: packages/contracts-ts/src/openapi.gen.ts, apps/api/src/modules/platform/http/auth-routes.gen.ts, apps/api/src/modules/platform/validation/signing-routes.gen.ts, apps/api/src/modules/risk/application/min-version-routes.gen.ts, packages/contracts-ts/src/planned-operations.gen.ts',
    ]);
    expect(checkTask('X1-01q', opts('RV1'))).toEqual([
      'mechanical_paths: only a Codex implementation ledger (tools/guard/codex-impl-tasks.json) names them; a Claude implementation lists those files in paths',
      'mechanical_paths: reach "contracts/openapi.yaml", so the ledger must also cover the files regenerated from it (CT-06n, CT-06zxd); add: packages/contracts-ts/src/planned-operations.gen.ts',
    ]);
    // A list without mechanical_paths allows none (fail-closed).
    writeFiles(root, {
      'tools/guard/codex-impl-tasks.json': JSON.stringify({
        approval: 23,
        tasks: ['X1-02'],
        forbidden_paths: ['contracts/**'],
      }),
    });
    expect(checkTask('X1-02m', opts('RV1')).join('\n')).toContain(
      'tools/guard/codex-impl-tasks.json has no mechanical_paths; none is allowed (fail-closed)',
    );
  } finally {
    for (const id of ['X1-02m', 'X1-02n', 'X1-02o', 'X1-01q']) {
      removeDir(`${root}/ops/tasks/${id}.yaml`);
    }
    removeDir(`${root}/tools/guard/codex-impl-tasks.json`);
  }
});

it('[CT-06n] an open ledger whose paths reach contracts/openapi.yaml covers the files regenerated from it', () => {
  const ROUTES =
    "\n  - 'apps/api/src/modules/platform/http/auth-routes.gen.ts'\n  - 'apps/api/src/modules/platform/validation/signing-routes.gen.ts'\n  - 'apps/api/src/modules/risk/application/min-version-routes.gen.ts'";
  const PLANNED = "\n  - 'packages/contracts-ts/src/planned-operations.gen.ts'";
  const contractTask = (id: string, fields: Record<string, string>): string =>
    taskYaml({
      id,
      type: 'contract',
      impl: 'claude',
      tester: 'none',
      refs: '[]',
      refs_hash: '{}',
      ...fields,
    });
  const ids = ['X1-01s', 'X1-01t', 'X1-01u', 'X1-01v', 'X1-01w', 'B1-08l', 'B1-08z'];
  writeFiles(root, {
    // Literal paths: all five generated files listed.
    'ops/tasks/X1-01s.yaml': contractTask('X1-01s', {
      paths: `\n  - 'contracts/openapi.yaml'\n  - 'packages/contracts-ts/src/openapi.gen.ts'${ROUTES}${PLANNED}`,
    }),
    // Globs cover them as well; a glob over contracts/ triggers the rule like the literal path.
    'ops/tasks/X1-01t.yaml': contractTask('X1-01t', {
      paths:
        "\n  - 'contracts/**'\n  - 'packages/contracts-ts/**'\n  - 'apps/api/src/modules/{platform,risk}/**'",
    }),
    // The route tables missing: refused with the list of what to add.
    'ops/tasks/X1-01u.yaml': contractTask('X1-01u', {
      paths:
        "\n  - 'contracts/openapi.yaml'\n  - 'packages/contracts-ts/**'\n  - 'apps/api/src/modules/platform/validation/route-schemas.gen.ts'",
    }),
    // A done ledger is history: not checked.
    'ops/tasks/X1-01v.yaml': contractTask('X1-01v', {
      status: 'done',
      pr: '7',
      paths: "\n  - 'contracts/openapi.yaml'",
    }),
    // No contract in paths: nothing to cover.
    'ops/tasks/X1-01w.yaml': contractTask('X1-01w', { paths: "\n  - 'contracts/README.md'" }),
    // An open ledger of the frozen exemption list, and a sibling that is not on it.
    // (It lists planned-operations.gen.ts: CONTRACT_GENERATED_EXEMPT does not cover that file.)
    'ops/tasks/B1-08l.yaml': contractTask('B1-08l', {
      paths: `\n  - 'contracts/openapi.yaml'${PLANNED}`,
    }),
    'ops/tasks/B1-08z.yaml': contractTask('B1-08z', { paths: "\n  - 'contracts/openapi.yaml'" }),
  });
  const withB1 = memorySpec({
    '规划/08_业务规则/01_DEMO.md': RULES,
    '规划/05_里程碑与任务拆分.md': `${PLAN}| B1-08 | 第三个 |\n`,
  });
  const o: CheckOptions = { root, spec: withB1, risk: fixedRisk('RV1') };
  const message = (missing: readonly string[]): string =>
    `paths: reach "contracts/openapi.yaml", so the ledger must also cover the files regenerated from it (CT-06n, CT-06zxd); add: ${missing.join(', ')}`;
  try {
    expect(checkTask('X1-01s', o)).toEqual([]);
    expect(checkTask('X1-01t', o)).toEqual([]);
    // planned-operations.gen.ts is covered by packages/contracts-ts/**; the route tables are not.
    expect(checkTask('X1-01u', o)).toEqual([message(CONTRACT_GENERATED.slice(1, 4))]);
    expect(checkTask('X1-01v', o)).toEqual([]);
    expect(checkTask('X1-01w', o)).toEqual([]);
    expect(checkTask('B1-08l', o)).toEqual([]);
    expect(checkTask('B1-08z', o)).toEqual([message(CONTRACT_GENERATED)]);
    // Only `paths` trigger the route tables and openapi.gen.ts (a mechanical commit only removes
    // planned markers, which leaves them unchanged; CT-06zxd keeps planned-operations.gen.ts, see
    // the next test); `mechanical_paths` still count as coverage.
    expect(
      missingContractGenerated({
        status: 'todo',
        paths: ['apps/api/src/modules/content/**'],
        mechanical_paths: ['contracts/openapi.yaml', PLANNED_OPERATIONS_GENERATED],
      }),
    ).toEqual([]);
    expect(
      missingContractGenerated({
        status: 'todo',
        paths: ['contracts/openapi.yaml', 'apps/api/src/modules/{platform,risk}/**'],
        mechanical_paths: [
          'packages/contracts-ts/src/openapi.gen.ts',
          'packages/contracts-ts/src/planned-operations.gen.ts',
        ],
      }),
    ).toEqual([]);
  } finally {
    for (const id of ids) removeDir(`${root}/ops/tasks/${id}.yaml`);
  }
});

it('[CT-06n] the exemption list is frozen at the open ledgers written before the check', () => {
  // A new ledger never joins it: it lists the generated files instead.
  expect([...CONTRACT_GENERATED_EXEMPT]).toEqual([
    'B1-08l',
    'B1-08m',
    'B1-11e',
    'B1-11j',
    'B1-13d',
    'B1-13h',
    'CT-04b',
    'CT-07a',
    'F1-09d',
    'F1-09e',
    'F1-09f',
  ]);
});

it('[CT-06zxd] planned-operations.gen.ts: required when paths or mechanical_paths reach the contract', () => {
  const contractTask = (id: string, fields: Record<string, string>): string =>
    taskYaml({
      id,
      type: 'contract',
      impl: 'claude',
      tester: 'none',
      refs: '[]',
      refs_hash: '{}',
      ...fields,
    });
  const ALL_BUT_PLANNED =
    "\n  - 'contracts/openapi.yaml'\n  - 'packages/contracts-ts/src/openapi.gen.ts'\n  - 'apps/api/src/modules/{platform,risk}/**'";
  const ids = ['X1-01x', 'X1-01y', 'X1-01z', 'X1-01za', 'B1-08m'];
  writeFiles(root, {
    // A new todo ledger that misses only planned-operations.gen.ts: refused.
    'ops/tasks/X1-01x.yaml': contractTask('X1-01x', { paths: ALL_BUT_PLANNED }),
    // Listed literally: accepted.
    'ops/tasks/X1-01y.yaml': contractTask('X1-01y', {
      paths: `${ALL_BUT_PLANNED}\n  - 'packages/contracts-ts/src/planned-operations.gen.ts'`,
    }),
    // Covered by a glob: accepted.
    'ops/tasks/X1-01z.yaml': contractTask('X1-01z', {
      paths: `${ALL_BUT_PLANNED}\n  - 'packages/contracts-ts/src/*.gen.ts'`,
    }),
    // A done ledger is history: not checked.
    'ops/tasks/X1-01za.yaml': contractTask('X1-01za', {
      status: 'done',
      pr: '7',
      paths: ALL_BUT_PLANNED,
    }),
    // On CONTRACT_GENERATED_EXEMPT, which does not reach planned-operations.gen.ts.
    'ops/tasks/B1-08m.yaml': contractTask('B1-08m', { paths: "\n  - 'contracts/openapi.yaml'" }),
  });
  const withB1 = memorySpec({
    '规划/08_业务规则/01_DEMO.md': RULES,
    '规划/05_里程碑与任务拆分.md': `${PLAN}| B1-08 | 第三个 |\n`,
  });
  const o: CheckOptions = { root, spec: withB1, risk: fixedRisk('RV1') };
  try {
    expect(checkTask('X1-01x', o)).toEqual([
      `paths: reach "contracts/openapi.yaml", so the ledger must also cover the files regenerated from it (CT-06n, CT-06zxd); add: ${PLANNED_OPERATIONS_GENERATED}`,
    ]);
    expect(checkTask('X1-01y', o)).toEqual([]);
    expect(checkTask('X1-01z', o)).toEqual([]);
    expect(checkTask('X1-01za', o)).toEqual([]);
    expect(checkTask('B1-08m', o)).toEqual([
      `paths: reach "contracts/openapi.yaml", so the ledger must also cover the files regenerated from it (CT-06n, CT-06zxd); add: ${PLANNED_OPERATIONS_GENERATED}`,
    ]);
    // Removing planned markers changes it (codegen.ts renders the planned operationIds), so a
    // contract named in mechanical_paths only triggers it too; the route tables stay untouched.
    expect(
      missingContractGenerated({
        status: 'todo',
        paths: ['apps/api/src/modules/content/**'],
        mechanical_paths: ['contracts/openapi.yaml'],
      }),
    ).toEqual([PLANNED_OPERATIONS_GENERATED]);
    expect(
      missingContractGenerated({
        status: 'todo',
        paths: ['apps/api/src/modules/content/**'],
        mechanical_paths: ['contracts/openapi.yaml', 'packages/contracts-ts/**'],
      }),
    ).toEqual([]);
    expect(
      missingContractGenerated({
        status: 'done',
        paths: ['apps/api/src/modules/content/**'],
        mechanical_paths: ['contracts/openapi.yaml'],
      }),
    ).toEqual([]);
  } finally {
    for (const id of ids) removeDir(`${root}/ops/tasks/${id}.yaml`);
  }
});

it('[CT-06zxd] a Codex ledger naming the contract in mechanical_paths only is refused either way under the real whitelist', () => {
  // The trusted whitelist (tools/guard/codex-impl-tasks.json, frozen, class 3) lists three files and
  // not planned-operations.gen.ts. Such a ledger cannot pass: without the file this rule refuses it,
  // with it the whitelist does. Never silently accepted; the fix is a class-3 task on the whitelist
  // (owner approval label), not a ledger edit (tools/ops/README.md).
  const WHITELIST = [
    'contracts/openapi.yaml',
    'packages/contracts-ts/src/openapi.gen.ts',
    'apps/api/src/modules/platform/validation/route-schemas.gen.ts',
  ];
  const real = JSON.parse(
    readFileSync(new URL('../guard/codex-impl-tasks.json', import.meta.url), 'utf8'),
  ) as { mechanical_paths?: string[] };
  expect(real.mechanical_paths).toEqual(WHITELIST);
  writeFiles(root, {
    'tools/guard/protected-paths.json': JSON.stringify({
      class1_add_only: ['test/spec/**'],
      class2_verify_config: [],
      class3_gates: [],
    }),
    'tools/guard/codex-impl-tasks.json': JSON.stringify({
      approval: 23,
      tasks: ['X1-02'],
      forbidden_paths: ['contracts/**', 'packages/contracts-ts/**'],
      mechanical_paths: WHITELIST,
    }),
    // The whole whitelist, without planned-operations.gen.ts: refused by this rule.
    'ops/tasks/X1-02p.yaml': good({
      id: 'X1-02p',
      impl: 'codex',
      tester: 'claude',
      test_paths: "\n  - 'test/spec/demo/**'",
      paths: "\n  - 'apps/api/src/modules/content/**'",
      mechanical_paths: WHITELIST.map((f) => `\n  - '${f}'`).join(''),
    }),
    // With planned-operations.gen.ts added: refused by the whitelist.
    'ops/tasks/X1-02q.yaml': good({
      id: 'X1-02q',
      impl: 'codex',
      tester: 'claude',
      test_paths: "\n  - 'test/spec/demo/**'",
      paths: "\n  - 'apps/api/src/modules/content/**'",
      mechanical_paths: [...WHITELIST, PLANNED_OPERATIONS_GENERATED]
        .map((f) => `\n  - '${f}'`)
        .join(''),
    }),
  });
  try {
    expect(checkTask('X1-02p', opts('RV1'))).toEqual([
      `mechanical_paths: reach "contracts/openapi.yaml", so the ledger must also cover the files regenerated from it (CT-06n, CT-06zxd); add: ${PLANNED_OPERATIONS_GENERATED}`,
    ]);
    expect(checkTask('X1-02q', opts('RV1'))).toEqual([
      `mechanical_paths: "${PLANNED_OPERATIONS_GENERATED}" is not one of the mechanical_paths of tools/guard/codex-impl-tasks.json (ops/approvals.yaml id 31)`,
    ]);
  } finally {
    for (const id of ['X1-02p', 'X1-02q']) removeDir(`${root}/ops/tasks/${id}.yaml`);
    removeDir(`${root}/tools/guard/codex-impl-tasks.json`);
  }
});

it('[CT-06zxd] the planned-operations.gen.ts exemption list is frozen (empty: no open ledger missed it)', () => {
  // A new ledger never joins it: it lists planned-operations.gen.ts instead.
  expect([...PLANNED_OPERATIONS_GEN_EXEMPT]).toEqual([]);
  expect(CONTRACT_GENERATED).toContain(PLANNED_OPERATIONS_GENERATED);
});

it('[approvals 36] tester: claude-independent passes check on a new ledger; RV2 still needs tester != impl', () => {
  writeFiles(root, {
    'tools/guard/protected-paths.json': JSON.stringify({
      class1_add_only: ['test/spec/**'],
      class2_verify_config: [],
      class3_gates: [],
    }),
    'ops/tasks/X1-01q.yaml': good({
      id: 'X1-01q',
      impl: 'claude',
      tester: 'claude-independent',
      test_paths: "\n  - 'test/spec/demo/**'",
    }),
    'ops/tasks/X1-01r.yaml': good({ id: 'X1-01r', impl: 'claude', tester: 'claude-independent' }),
  });
  expect(checkTask('X1-01q', opts('RV2'))).toEqual([]);
  expect(checkTask('X1-01q', opts('RV1'))).toEqual([]);
  // A rule-test author needs test_paths, whoever it is.
  expect(checkTask('X1-01r', opts('RV1')).join('\n')).toContain(
    'test_paths: required for a task with a rule-test author (tester: claude-independent)',
  );
});
