import { expect, it } from 'vitest';
import { modifiedOnlyFiles } from '../../../../tools/guard/lib/red-check.ts';
import {
  compareModifiedBlocks,
  compareTestFileRows,
  namesWholeBlock,
} from '../../../../tools/guard/lib/test-blocks.ts';
import {
  type ModifyExistingBlockDeclaration,
  wholeBlockEntryProblem,
} from '../../../../tools/lib/task-file.ts';
import { modifyOf, reader } from '../red-check-mixed-leave-out/kit.ts';

const FILE = 'test/spec/demo/admin-pids/access.int.test.ts';
const TITLE = '[AC-DEMO#2] ${ action } \\u52a8态码只能消耗一次';
const EACH_TITLE = '[AC-DEMO#5] ${action} 检查超管标记 %s';
const ROWS = "['create', 'update', 'activate', 'retire']";
const LOOP_HEADER = 'for (const action of WRITES)';
const SETUP = 'const tier = 1;';

function testBlock(title: string, assertion: string, callee = 'it'): string {
  return `${callee}(\`${title}\`, () => {\n    ${assertion}\n  });`;
}

function loop(header: string, ...statements: string[]): string {
  return `${header} {\n  ${statements.join('\n  ')}\n}`;
}

function source(...statements: string[]): string {
  return [
    "import { describe, expect, it, test } from 'vitest';",
    `const WRITES = ${ROWS};`,
    'const enabled = true;',
    ...statements,
    '',
  ].join('\n');
}

function leftOut(base: string, head: string, declaration: ModifyExistingBlockDeclaration) {
  return modifiedOnlyFiles([FILE], reader({ [FILE]: base }, { [FILE]: head }), [declaration]);
}

const before = testBlock(TITLE, 'expect(action.length).toBeGreaterThan(0);');
const after = testBlock(TITLE, 'expect(WRITES).toContain(action);');
const first = testBlock('[AC-DEMO#1] ${action} 检查操作等级', 'expect(tier).toBe(1);');
const each = [
  `it.each([false, true])(\`${EACH_TITLE}\`, (isSuper) => {`,
  "    expect(typeof isSuper).toBe('boolean');",
  '  });',
].join('\n');
const last = testBlock('[AC-DEMO#3] ${action} 检查操作名称', 'expect(action).toMatch(/^\\w+$/);');
const base = source(loop(LOOP_HEADER, SETUP, first, each, before, last));
const head = source(loop(LOOP_HEADER, SETUP, first, each, after, last));
const entry = { ...modifyOf(FILE, TITLE), note: '调整动态码断言，操作表与其余用例保持原样。' };

it('[AC-CT-06zzzzzzzj#1] 具名表整块登记覆盖该块所有展开用例', () => {
  expect(namesWholeBlock(base, TITLE)).toBe(true);
  const comparison = compareModifiedBlocks(base, head, [TITLE]);
  expect(comparison).toMatchObject({
    ok: true,
    outside: null,
    blocks: [{ test: TITLE, found: true, before, after, changed: true, whole: { head: 2 } }],
  });
  const block = comparison.ok ? comparison.blocks[0] : undefined;
  const whole = block?.found === true ? block.whole : undefined;
  for (const action of ['create', 'update', 'activate', 'retire']) {
    expect(whole?.produces(`[AC-DEMO#2] ${action} 动态码只能消耗一次`), action).toBe(true);
    expect(whole?.produces(`[AC-DEMO#1] ${action} 检查操作等级`), action).toBe(false);
    expect(whole?.produces(`[AC-DEMO#3] ${action} 检查操作名称`), action).toBe(false);
  }
  expect(compareModifiedBlocks(base, base, [TITLE])).toMatchObject({
    ok: true,
    outside: null,
    blocks: [{ test: TITLE, found: true, changed: false }],
  });
  expect(leftOut(base, head, entry)).toEqual([{ file: FILE, tests: [TITLE] }]);

  for (const sibling of [first, each, last]) {
    const changed = head.replace(sibling, sibling.replace('expect(', 'expect.soft('));
    expect(compareModifiedBlocks(base, changed, [TITLE]), sibling).not.toMatchObject({
      ok: true,
      outside: null,
      blocks: [{ found: true, changed: true }],
    });
    expect(leftOut(base, changed, entry), sibling).toEqual([]);
  }
});

it('[AC-CT-06zzzzzzzj#2] 内联表改块体可整块登记，只改行仍按全名登记', () => {
  const title = '[AC-DEMO#4] 记录令牌过期时间（${expiresAt}）';
  const oldHeader = "for (const expiresAt of ['2027-02-01T00:00:00Z', null])";
  const newHeader = "for (const expiresAt of ['2027-03-01T00:00:00Z', null])";
  const oldBlock = testBlock(title, 'expect(expiresAt).not.toBeUndefined();', 'test');
  const newBlock = testBlock(title, "expect(expiresAt ?? '').toMatch(/^(2027|$)/);", 'test');
  const inlineBase = source(loop(oldHeader, oldBlock));
  const bodyChanged = source(loop(oldHeader, newBlock));
  const rowChanged = source(loop(newHeader, oldBlock));
  const rowTitle = '[AC-DEMO#4] 记录令牌过期时间（2027-03-01T00:00:00Z）';

  expect(namesWholeBlock(inlineBase, title)).toBe(true);
  const expectedBlock = {
    test: title,
    found: true,
    before: oldBlock,
    after: newBlock,
    changed: true,
    whole: { head: 0 },
  };
  expect(compareModifiedBlocks(inlineBase, bodyChanged, [title])).toMatchObject({
    ok: true,
    outside: null,
    blocks: [expectedBlock],
  });
  const inlineEntry = modifyOf(FILE, title);
  expect(leftOut(inlineBase, bodyChanged, inlineEntry)).toEqual([{ file: FILE, tests: [title] }]);
  expect(compareModifiedBlocks(inlineBase, rowChanged, [rowTitle])).toMatchObject({
    ok: true,
    outside: null,
    blocks: [{ test: rowTitle, found: true, changed: true }],
  });
  expect(compareModifiedBlocks(inlineBase, rowChanged, [title])).toMatchObject({
    ok: true,
    blocks: [{ test: title, found: false }],
  });
  expect(leftOut(inlineBase, rowChanged, inlineEntry)).toEqual([]);
});

it('[AC-CT-06zzzzzzzj#3] 循环头或未登记语句有改动时仍判整文件', () => {
  expect(leftOut(base, head, entry)).toEqual([{ file: FILE, tests: [TITLE] }]);

  const changedHeader = head.replace('of WRITES)', 'of WRITES.slice(1))');
  const changedStatement = head.replace(SETUP, 'const tier = 2;');
  for (const changed of [changedHeader, changedStatement]) {
    expect(compareTestFileRows(base, changed, [TITLE])).toMatchObject({ whole: true });
    expect(compareModifiedBlocks(base, changed, [TITLE])).not.toMatchObject({
      ok: true,
      outside: null,
      blocks: [{ found: true, changed: true }],
    });
    expect(leftOut(base, changed, entry)).toEqual([]);
  }
});

it('[AC-CT-06zzzzzzzj#4] 按模板原文字面匹配，拒绝差一个字符和重复命中', () => {
  expect(namesWholeBlock(base, TITLE)).toBe(true);
  const mismatches = [
    TITLE.replace('${ action }', '${ action}'),
    TITLE.replace('\\u52a8', '动'),
    TITLE.replace('一次', '两次'),
  ];
  for (const mismatch of mismatches) {
    expect(namesWholeBlock(base, mismatch), mismatch).toBe(false);
    expect(compareModifiedBlocks(base, head, [mismatch]), mismatch).toMatchObject({
      ok: true,
      blocks: [{ test: mismatch, found: false }],
    });
  }
  const retitled = head.replace('${ action }', '${ action}');
  expect(compareModifiedBlocks(base, retitled, [TITLE])).toMatchObject({
    ok: true,
    blocks: [{ test: TITLE, found: false }],
  });
  const duplicateInLoop = source(loop(LOOP_HEADER, SETUP, first, each, before, before, last));
  const duplicateInFile = source(head, loop(LOOP_HEADER, after));
  const missing = { ok: true, blocks: [{ test: TITLE, found: false }] };
  for (const duplicate of [duplicateInLoop, duplicateInFile]) {
    expect(namesWholeBlock(duplicate, TITLE)).toBe(false);
    expect(compareModifiedBlocks(duplicate, head, [TITLE])).toMatchObject(missing);
    expect(compareModifiedBlocks(base, duplicate, [TITLE])).toMatchObject(missing);
  }
});

it('[AC-CT-06zzzzzzzj#5] 整块登记沿用 rule_change 和非空 note 的门槛', () => {
  const problem = (declaration: ModifyExistingBlockDeclaration) =>
    namesWholeBlock(base, declaration.test) ? wholeBlockEntryProblem(declaration) : null;

  expect(problem({ ...entry, reason: 'tighten_only' })).toEqual(
    expect.stringContaining('rule_change'),
  );
  const { note, ...withoutNote } = entry;
  expect(problem(withoutNote)).toEqual(expect.stringContaining('note'));
  expect(problem({ ...withoutNote, note: '  ' })).toEqual(expect.stringContaining('note'));
  expect(problem({ ...withoutNote, note })).toBeNull();
});

it('[AC-CT-06zzzzzzzj#6] 只接受顶层循环体内直接调用的普通测试', () => {
  expect(leftOut(base, head, entry)).toEqual([{ file: FILE, tests: [TITLE] }]);

  const suite = (body: string) => `${'describe'}('group', () => {\n${body}\n});`;
  const cases = [
    ['嵌套循环', (block: string) => loop(LOOP_HEADER, loop('for (const i of [0])', block))],
    ['循环内 describe', (block: string) => loop(LOOP_HEADER, suite(block))],
    ['describe 内循环', (block: string) => suite(loop(LOOP_HEADER, block))],
    ['条件循环', (block: string) => `if (enabled) ${loop(LOOP_HEADER, block)}`],
    ['条件调用', (block: string) => loop(LOOP_HEADER, `if (enabled) ${block}`)],
    ['带修饰符', (block: string) => loop(LOOP_HEADER, block.replace(/^it\(/, 'it.concurrent('))],
  ] as const;
  for (const [name, wrap] of cases) {
    const otherBase = source(wrap(before));
    const otherHead = source(wrap(after));
    expect(namesWholeBlock(otherBase, TITLE), name).toBe(false);
    expect(compareModifiedBlocks(otherBase, otherHead, [TITLE]), name).not.toMatchObject({
      ok: true,
      blocks: [{ found: true }],
    });
    expect(leftOut(otherBase, otherHead, entry), name).toEqual([]);
  }
});

it('[AC-CT-06zzzzzzzj#11] 同一循环内的 it.each 与普通 it 各按自己的标题模板整块登记', () => {
  const eachAfter = each.replace(
    "expect(typeof isSuper).toBe('boolean');",
    'expect([false, true]).toContain(isSuper);',
  );
  const mixedBase = source(loop(LOOP_HEADER, each, before));
  const mixedHead = source(loop(LOOP_HEADER, eachAfter, after));
  const tableEntry = { ...modifyOf(FILE, EACH_TITLE), note: '调整超管标记断言，表格行保持原样。' };
  const tableBlock = {
    test: EACH_TITLE,
    found: true,
    before: each,
    after: eachAfter,
    changed: true,
    whole: { head: 0 },
  };
  const plainBlock = { test: TITLE, found: true, before, after, changed: true, whole: { head: 1 } };

  expect(namesWholeBlock(mixedBase, TITLE)).toBe(true);
  expect(namesWholeBlock(mixedBase, EACH_TITLE)).toBe(true);
  expect(compareModifiedBlocks(mixedBase, mixedHead, [EACH_TITLE, TITLE])).toMatchObject({
    ok: true,
    outside: null,
    blocks: [tableBlock, plainBlock],
  });

  for (const [declaration, block] of [
    [tableEntry, tableBlock],
    [entry, plainBlock],
  ] as const) {
    expect(compareModifiedBlocks(mixedBase, mixedHead, [declaration.test])).toMatchObject({
      ok: true,
      outside: expect.any(String),
      blocks: [block],
    });
    expect(leftOut(mixedBase, mixedHead, declaration)).toEqual([]);
  }
  const read = reader({ [FILE]: mixedBase }, { [FILE]: mixedHead });
  expect(modifiedOnlyFiles([FILE], read, [tableEntry, entry])).toEqual([
    { file: FILE, tests: [EACH_TITLE, TITLE] },
  ]);

  const tableOnlyBase = source(loop(LOOP_HEADER, each.replace(EACH_TITLE, TITLE)));
  expect(namesWholeBlock(tableOnlyBase, TITLE)).toBe(true);
  expect(compareModifiedBlocks(tableOnlyBase, mixedHead, [TITLE])).toMatchObject({
    ok: true,
    blocks: [{ test: TITLE, found: false }],
  });
});
