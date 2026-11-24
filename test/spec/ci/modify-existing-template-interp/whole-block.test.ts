import { expect, it } from 'vitest';
import { compareModifiedBlocks, namesWholeBlock } from '../../../../tools/guard/lib/test-blocks.ts';
import { wholeBlockEntryProblem } from '../../../../tools/lib/task-file.ts';

const TITLE = '[AC-DEMO-01#1] ${source} 时间 %s 保留秒字段';
const LITERAL_ROWS = '[0, undefined, null]';

function tableBlock(
  titleExpression: string,
  minimum: number,
  method: 'each' | 'for' = 'each',
  rows = LITERAL_ROWS,
): string {
  return [
    `it.${method}(${rows})(${titleExpression}, (absent) => {`,
    `    expect(absent ?? 0).toBeGreaterThanOrEqual(${minimum});`,
    '  });',
  ].join('\n');
}

function loop(block: string): string {
  return `for (const source of sources) {\n  ${block}\n}`;
}

function source(...blocks: string[]): string {
  return [
    "import { expect, it } from 'vitest';",
    "const sources = ['detail', 'increment'] as const;",
    ...blocks,
    '',
  ].join('\n');
}

const before = tableBlock(`\`${TITLE}\``, -1);
const after = tableBlock(`\`${TITLE}\``, 0);
const base = source(loop(before));
const head = source(loop(after));

it('[AC-CT-06zzzzzzzd#1] .each 按插值模板原文比较整块', () => {
  expect(namesWholeBlock(base, TITLE)).toBe(true);
  expect(compareModifiedBlocks(base, head, [TITLE])).toMatchObject({
    ok: true,
    outside: null,
    blocks: [{ test: TITLE, found: true, before, after, changed: true, whole: { head: 0 } }],
  });
  expect(compareModifiedBlocks(base, base, [TITLE])).toMatchObject({
    ok: true,
    outside: null,
    blocks: [
      { test: TITLE, found: true, before, after: before, changed: false, whole: { head: 0 } },
    ],
  });
});

it('[AC-CT-06zzzzzzzd#2] .for 逐字匹配插值模板原文', () => {
  const title = '[AC-DEMO-01#1] ${ source } \\u65f6间 %s 保留秒字段';
  const forBase = source(loop(tableBlock(`\`${title}\``, -1, 'for')));
  const forHead = source(loop(tableBlock(`\`${title}\``, 0, 'for')));

  const mismatches = [
    title.replace('秒字段', '秒字断'),
    title.replace('${ source }', '${ src }'),
    title.replace('${ source }', '${source}'),
    title.replace(' %s', '  %s'),
    title.replace('${ source }', 'detail'),
    title.replace('\\u65f6', '时'),
  ];
  for (const test of mismatches) {
    expect(namesWholeBlock(forBase, test), test).toBe(false);
  }
  expect(compareModifiedBlocks(forBase, forHead, mismatches)).toMatchObject({
    ok: true,
    blocks: mismatches.map((test) => ({ test, found: false })),
  });
  const retitledHead = forHead.replace('${ source }', '${source}');
  expect(compareModifiedBlocks(forBase, retitledHead, [title])).toMatchObject({
    ok: true,
    blocks: [{ test: title, found: false }],
  });
  expect(namesWholeBlock(forBase, title)).toBe(true);
  expect(compareModifiedBlocks(forBase, forHead, [title])).toMatchObject({
    ok: true,
    outside: null,
    blocks: [{ test: title, found: true, changed: true, whole: { head: 0 } }],
  });
});

it('[AC-CT-06zzzzzzzd#3] 普通标题与无插值模板沿用旧规则', () => {
  const plain = '[AC-DEMO-01#2] 普通标题';
  const runtimeTemplate = '[AC-DEMO-01#3] `运行时表` %s';
  const rawRuntimeTemplate = '[AC-DEMO-01#3] \\`运行时表\\` %s';
  const literalTemplate = '[AC-DEMO-01#4] 字面量表 %s';
  const rowNames = ['0', '1'].map((value) => literalTemplate.replace('%s', value));
  const fixture = (interpolatedBlock: string, minimum: number) =>
    source(
      loop(interpolatedBlock),
      `it('${plain}', () => { expect(1).toBeGreaterThanOrEqual(${minimum}); });`,
      tableBlock(`\`${rawRuntimeTemplate}\``, minimum, 'each', 'Array.from([0, 1])'),
      tableBlock(`\`${literalTemplate}\``, minimum, 'each', '[0, 1]'),
    );
  const mixedBase = fixture(before, -1);
  const mixedHead = fixture(after, 0);

  expect(namesWholeBlock(mixedBase, plain)).toBe(false);
  expect(namesWholeBlock(mixedBase, runtimeTemplate)).toBe(true);
  expect(namesWholeBlock(mixedBase, rawRuntimeTemplate)).toBe(false);
  expect(compareModifiedBlocks(mixedBase, mixedHead, [rawRuntimeTemplate])).toMatchObject({
    ok: true,
    blocks: [{ test: rawRuntimeTemplate, found: false }],
  });
  expect(namesWholeBlock(mixedBase, literalTemplate)).toBe(false);
  expect(compareModifiedBlocks(mixedBase, mixedHead, [literalTemplate])).toMatchObject({
    ok: true,
    blocks: [{ test: literalTemplate, found: false }],
  });
  const names = [plain, runtimeTemplate, ...rowNames, TITLE];
  expect(compareModifiedBlocks(mixedBase, mixedHead, names)).toMatchObject({
    ok: true,
    outside: null,
    blocks: names.map((test) => ({ test, found: true, changed: true })),
  });
});

it('[AC-CT-06zzzzzzzd#4] 基线或头提交有同原文的两块时拒绝', () => {
  const duplicate = source(loop(before), loop(after));
  expect(namesWholeBlock(duplicate, TITLE)).toBe(false);
  expect(compareModifiedBlocks(duplicate, head, [TITLE])).toMatchObject({
    ok: true,
    blocks: [{ test: TITLE, found: false }],
  });
  expect(compareModifiedBlocks(base, duplicate, [TITLE])).toMatchObject({
    ok: true,
    blocks: [{ test: TITLE, found: false }],
  });
  expect(namesWholeBlock(base, TITLE)).toBe(true);
});

it('[AC-CT-06zzzzzzzd#5] 带插值的整块申报仍拒绝 tighten_only', () => {
  const entry = {
    file: 'test/spec/demo/pdd-times.test.ts',
    test: TITLE,
    reason: 'tighten_only' as const,
    ruling: 'D10-2698',
    note: '调整时间字段的断言，输入表与标题保持原样。',
  };
  const problem = namesWholeBlock(base, entry.test) ? wholeBlockEntryProblem(entry) : null;
  expect(problem).toEqual(expect.stringContaining('rule_change'));
});

it('[AC-CT-06zzzzzzzd#6] 循环内的普通 it 拒绝按插值模板原文申报', () => {
  const tableTitle = '[AC-DEMO-01#2] ${source} 表格时间 %s 保留秒字段';
  const fixture = (minimum: number) =>
    source(
      loop(
        [
          tableBlock(`\`${tableTitle}\``, minimum),
          `  it(\`${TITLE}\`, () => { expect(1).toBeGreaterThanOrEqual(${minimum}); });`,
        ].join('\n'),
      ),
    );
  const mixedBase = fixture(-1);
  const mixedHead = fixture(0);
  const missing = { ok: true, blocks: [{ test: TITLE, found: false }] };

  expect(compareModifiedBlocks(base, mixedHead, [TITLE])).toMatchObject(missing);
  expect(namesWholeBlock(mixedBase, TITLE)).toBe(false);
  expect(compareModifiedBlocks(mixedBase, mixedHead, [TITLE])).toMatchObject(missing);
  expect(namesWholeBlock(mixedBase, tableTitle)).toBe(true);
  expect(compareModifiedBlocks(mixedBase, mixedHead, [tableTitle])).toMatchObject({
    ok: true,
    blocks: [{ test: tableTitle, found: true, changed: true, whole: { head: 0 } }],
  });
});
