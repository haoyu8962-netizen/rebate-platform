import { afterEach, expect, it } from 'vitest';
import { checkEarly } from '../../../../tools/ci/evidence-check.ts';
import { compareModifiedBlocks } from '../../../../tools/guard/lib/test-blocks.ts';
import {
  SLOW,
  TASK,
  blockRecord,
  branch,
  check,
  cleanup,
  makeRepo,
  trusted,
} from '../modify-existing-support/kit.ts';
import {
  BR,
  FILE,
  LITERAL_ROWS,
  OUTSIDE,
  TITLE,
  eachBlock,
  entry,
  source,
  taskLedger,
} from './kit.ts';

afterEach(cleanup);

const baseBlock = eachBlock(1);
const headBlock = eachBlock(2);
const base = source([baseBlock]);
const head = source([headBlock]);

const forTitle = '[AC-DEMO-01#1] keeps %s response';
const forBlock = (expected: number): string =>
  [
    "it.for([...(['alpha', 'beta'] as const).map((label, i) => [label, i + 1] as const)])(",
    `  '${forTitle}', ([, value]) => {`,
    `    expect(value).toBe(${expected});`,
    '  },',
    ');',
  ].join('\n');

it.each([
  { method: '.each', test: TITLE, before: baseBlock, after: headBlock },
  { method: '.for', test: forTitle, before: forBlock(1), after: forBlock(2) },
])(
  '[AC-CT-06zzzzzzzc#1] $method 接受基线标题原文以及整块前后源码',
  ({ test, before, after }) => {
    const ledger = taskLedger(entry(test));
    const repo = makeRepo('whole-block', { [FILE]: source([before]) });
    const trustedDir = trusted('whole-block', ledger);
    const record = blockRecord(FILE, test, before, after, { br: [BR] });
    const commit = branch(
      repo,
      'whole-block',
      { [FILE]: source([after]), [`ops/tasks/${TASK}.yaml`]: ledger },
      [record],
    );
    const early = checkEarly({
      prDir: repo.dir,
      task: TASK,
      base: repo.base,
      spec: commit,
      trusted: trustedDir,
    });
    const evidence = check(repo, commit, trustedDir);
    const problems = { early: early.problems, evidence: evidence.problems };
    expect(problems).toEqual({ early: [], evidence: [] });
  },
  SLOW,
);

const useExpandedNames =
  /(?:use|please|declare|register|list|name each|请|须|应|逐行|改用).*(?:full names?|Vitest|展开)|(?:full names?|Vitest|展开).*(?:逐行|登记|instead)/i;

it.each([
  {
    label: '模板占位符差一个字',
    test: TITLE.replace('$label', '$labeL'),
    before: base,
    after: head,
  },
  {
    label: '展不开的表尝试只登记某一行',
    test: TITLE.replace('$label', 'alpha'),
    before: base,
    after: head,
  },
  {
    label: '两个块的标题模板原文相同',
    test: TITLE,
    before: source([baseBlock, baseBlock]),
    after: source([headBlock, baseBlock]),
    diagnostic: /two|multiple|ambiguous|2 .*blocks|多个|重复|歧义/i,
  },
  {
    label: '基线的表能展开',
    test: TITLE,
    before: source([eachBlock(1, LITERAL_ROWS)]),
    after: source([eachBlock(2, LITERAL_ROWS)]),
    diagnostic: useExpandedNames,
  },
  {
    label: '头提交的标题模板已改',
    test: TITLE,
    before: base,
    after: source([eachBlock(2, 'rows', TITLE.replace('response', 'reply'))]),
  },
])('[AC-CT-06zzzzzzzc#2] 拒绝登记 $label', ({ test, before, after, diagnostic }) => {
  // 同一夹具也校验准确标题能命中。
  const exact = compareModifiedBlocks(base, head, [TITLE]);
  const refused = compareModifiedBlocks(before, after, [test]);
  expect({ exact, refused }).toMatchObject({
    exact: { ok: true, outside: null, blocks: [{ test: TITLE, found: true, changed: true }] },
    refused: {
      ok: true,
      blocks: [
        {
          test,
          found: false,
          ...(diagnostic === undefined ? {} : { reason: expect.stringMatching(diagnostic) }),
        },
      ],
    },
  });
});

it('[AC-CT-06zzzzzzzc#3] 以基线认定整块登记，头提交把表改成字面量仍按整块比较', () => {
  const literalHead = eachBlock(2, LITERAL_ROWS);
  expect(compareModifiedBlocks(base, source([literalHead]), [TITLE])).toMatchObject({
    ok: true,
    outside: null,
    blocks: [{ test: TITLE, found: true, changed: true, before: baseBlock, after: literalHead }],
  });
});

it('[AC-CT-06zzzzzzzc#4] 可展开的表仍可按 Vitest 展开全名登记每行', () => {
  const before = source([eachBlock(1, LITERAL_ROWS)]);
  const after = source([eachBlock(2, LITERAL_ROWS)]);
  const rows = ['alpha', 'beta'].map((label) => TITLE.replace('$label', label));
  const individual = compareModifiedBlocks(before, after, rows);
  const whole = compareModifiedBlocks(before, after, [TITLE]);
  expect({ individual, whole }).toMatchObject({
    individual: {
      ok: true,
      outside: null,
      blocks: rows.map((test) => ({ test, found: true, changed: true })),
    },
    whole: {
      ok: true,
      blocks: [{ test: TITLE, found: false, reason: expect.stringMatching(useExpandedNames) }],
    },
  });
});

it.each([
  {
    label: '相邻用例也被修改',
    after: source([headBlock], 1),
    diagnostic: OUTSIDE,
  },
  {
    label: '顶层表定义也被修改',
    after: head.replace('value: i + 1', 'value: i + 2'),
    diagnostic: /outside the tests|top.level|测试块外|顶层/i,
  },
])('[AC-CT-06zzzzzzzc#5] 整块登记之外的改动仍被拒绝 $label', ({ after, diagnostic }) => {
  const compared = compareModifiedBlocks(base, after, [TITLE]);
  expect(compared).toMatchObject({
    ok: true,
    outside:
      typeof diagnostic === 'string'
        ? expect.stringContaining(diagnostic)
        : expect.stringMatching(diagnostic),
    blocks: [{ test: TITLE, found: true, changed: true }],
  });
});

it(
  '[AC-CT-06zzzzzzzc#6] 证据只写回调内的片段会被拒绝',
  () => {
    const repo = makeRepo('partial-record', { [FILE]: base });
    const trustedDir = trusted('partial-record', taskLedger(entry()));
    const commit = branch(repo, 'partial-record', { [FILE]: head }, [
      blockRecord(FILE, TITLE, 'expect(value).toBe(1);', 'expect(value).toBe(2);', { br: [BR] }),
    ]);
    expect(check(repo, commit, trustedDir).problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining('modify_existing[0].before'),
        expect.stringContaining('modify_existing[0].after'),
      ]),
    );
  },
  SLOW,
);
