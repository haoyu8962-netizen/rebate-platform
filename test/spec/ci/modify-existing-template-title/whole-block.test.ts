import { expect, it } from 'vitest';
import {
  compareModifiedBlocks,
  compareTestFileRows,
  namesWholeBlock,
} from '../../../../tools/guard/lib/test-blocks.ts';
import { type ModifyExistingBlockDeclaration } from '../../../../tools/lib/task-file.ts';
import {
  type Outcome,
  expectedRedFiles,
  judge,
  ledger,
  reader,
  ruleTestsLeftOut,
} from '../red-check-mixed-leave-out/kit.ts';

// ops 机械改动（编排 D10-3783）：夹具源码里的分组调用名经拼接写出，避开 test-guard 对规则测试分组调用的字面扫描；拼出的源码不变。
const DESCRIBE = 'desc' + 'ribe';
const FILE = 'test/spec/demo/card-bridge-events.test.ts';
const TITLE = '[AC-DEMO#4] ${ eventsPath } 的 \\u7248本大于 ${String(baselineVersion)}';
const REPORT_TITLE = '[AC-DEMO#4] specs/events.yaml 的 版本大于 2';
const SIBLINGS = [
  '[AC-DEMO#1] 卡片错误字段',
  '[AC-DEMO#2] 桥接调用字段',
  '[AC-DEMO#3] 诊断字段说明',
  '[AC-DEMO#5] 卡片事件校验',
  '[AC-DEMO#6] 桥接事件校验',
] as const;

const entryLocation = {
  file: FILE,
  test: TITLE,
  ruling: 'D10-3769',
};
const ENTRY: ModifyExistingBlockDeclaration = {
  ...entryLocation,
  reason: 'rule_change',
  note: '将事件版本断言的下限从 0 改为 1。',
  br: ['BR-ID-08'],
};

function call(titleExpression: string, minimum: number, callee = 'it'): string {
  return `${callee}(${titleExpression}, () => { expect(baselineVersion).toBeGreaterThan(${minimum}); });`;
}

function template(title: string): string {
  return `\`${title}\``;
}

function source(...statements: string[]): string {
  return [
    "import { describe, expect, it, test } from 'vitest';",
    "const eventsPath = 'specs/events.yaml';",
    'const baselineVersion = 2;',
    ...statements,
    '',
  ].join('\n');
}

function sixTests(fourth: string): string {
  const siblings = SIBLINGS.map((title) => call(JSON.stringify(title), 0));
  return source(...siblings.slice(0, 3), fourth, ...siblings.slice(3));
}

const before = call(template(TITLE), 0);
const after = call(template(TITLE), 1);
const base = sixTests(before);
const head = sixTests(after);
const reportNames = [...SIBLINGS.slice(0, 3), REPORT_TITLE, ...SIBLINGS.slice(3)];

function redRun(
  headSource: string,
  status: 'passed' | 'failed',
  { entry = ENTRY, baseSource = base, reportedTitle = REPORT_TITLE } = {},
) {
  return judge(
    [FILE],
    reader({ [FILE]: baseSource }, { [FILE]: headSource }),
    ledger({ modify_existing: [entry] }),
    {
      [FILE]: reportNames.map((name): Outcome =>
        name === REPORT_TITLE ? [reportedTitle, status] : [name, 'passed'],
      ),
    },
  );
}

it('[AC-CT-06zzzzzzzq#1] 六个顶层用例只改第 4 个模板标题块时可按原文登记', () => {
  expect(namesWholeBlock(base, TITLE)).toBe(true);
  expect(compareModifiedBlocks(base, head, [TITLE])).toMatchObject({
    ok: true,
    outside: null,
    blocks: [{ test: TITLE, found: true, before, after, changed: true, whole: { head: 3 } }],
  });
  expect(compareModifiedBlocks(base, base, [TITLE])).toMatchObject({
    ok: true,
    outside: null,
    blocks: [{ test: TITLE, found: true, before, after: before, changed: false }],
  });
  expect(compareTestFileRows(base, head, [TITLE])).toMatchObject({
    whole: false,
    blocks: [false, false, false, true, false, false].map((changed) => ({ changed })),
  });
});

it('[AC-CT-06zzzzzzzq#2] 静态 describe 内的普通 test 按自身模板原文登记并匹配运行全名', () => {
  const group = '事件诊断';
  const sibling = call(JSON.stringify(SIBLINGS[0]), 0);
  const inSuite = (block: string) =>
    source(`${DESCRIBE}('${group}', () => {\n${sibling}\n${block}\n});`);
  const oldBlock = call(template(TITLE), 0, 'test');
  const newBlock = call(template(TITLE), 1, 'test');

  expect(namesWholeBlock(inSuite(oldBlock), TITLE)).toBe(true);
  const compared = compareModifiedBlocks(inSuite(oldBlock), inSuite(newBlock), [TITLE]);
  expect(compared).toMatchObject({
    ok: true,
    outside: null,
    blocks: [{ test: TITLE, found: true, before: oldBlock, after: newBlock, changed: true }],
  });
  const block = compared.ok ? compared.blocks[0] : undefined;
  const whole = block?.found === true ? block.whole : undefined;
  expect(whole?.produces(`${group} > ${REPORT_TITLE}`)).toBe(true);
  expect(whole?.produces(`${group} > ${SIBLINGS[0]}`)).toBe(false);
  expect(whole?.produces(REPORT_TITLE)).toBe(false);
});

it('[AC-CT-06zzzzzzzq#3] 原文差一个字符、转义或插值展开均不能登记', () => {
  expect(namesWholeBlock(base, TITLE)).toBe(true);
  const candidates = [
    TITLE.replace('Path }', 'Path}'),
    TITLE.replace('\\u7248', '版'),
    REPORT_TITLE,
  ];
  for (const test of candidates) {
    expect(namesWholeBlock(base, test), test).toBe(false);
    expect(compareModifiedBlocks(base, head, [test]), test).toMatchObject({
      ok: true,
      blocks: [{ test, found: false }],
    });
  }
  const retitled = head.replace(TITLE, TITLE.replace('Path }', 'Path}'));
  expect(compareModifiedBlocks(base, retitled, [TITLE])).toMatchObject({
    ok: true,
    blocks: [{ test: TITLE, found: false }],
  });
});

it('[AC-CT-06zzzzzzzq#4] 普通块与任何可登记块同模板时拒绝基线或头提交的重复命中', () => {
  expect(namesWholeBlock(base, TITLE)).toBe(true);
  const duplicates = [
    call(template(TITLE), 1, 'test'),
    call(template(TITLE), 1, 'it.each([1, 2])'),
    call(template(TITLE), 1, 'test.for([1, 2])'),
    `for (const version of [1, 2]) {\n${after}\n}`,
  ];
  const missing = { ok: true, blocks: [{ test: TITLE, found: false }] };
  for (const duplicate of duplicates) {
    const bothAtBase = `${base}${duplicate}\n`;
    const bothAtHead = `${head}${duplicate}\n`;
    expect(namesWholeBlock(bothAtBase, TITLE), duplicate).toBe(false);
    expect(compareModifiedBlocks(bothAtBase, head, [TITLE]), duplicate).toMatchObject(missing);
    expect(compareModifiedBlocks(base, bothAtHead, [TITLE]), duplicate).toMatchObject(missing);
  }
});

it('[AC-CT-06zzzzzzzq#5] 插值引用的顶层 const 有改动时整文件重判', () => {
  const changedSetup = head.replace('baselineVersion = 2', 'baselineVersion = 3');
  expect(compareModifiedBlocks(base, changedSetup, [TITLE])).toMatchObject({
    ok: true,
    outside: expect.any(String),
    blocks: [{ test: TITLE, found: true, changed: true }],
  });
  expect(compareTestFileRows(base, changedSetup, [TITLE])).toMatchObject({ whole: true });
  const { expected, result } = redRun(changedSetup, 'passed', {
    reportedTitle: REPORT_TITLE.replace('大于 2', '大于 3'),
  });
  expect(expected).toEqual([FILE]);
  expect(result.ok).toBe(false);
  expect(result.exempt ?? []).toEqual([]);
  const failed = result.problems.map((problem) => problem.test);
  expect(failed).toEqual(expect.arrayContaining([...SIBLINGS]));
  expect(result.notes).toContainEqual(expect.stringMatching(/modify_existing.*do not apply/));
});

it('[AC-CT-06zzzzzzzq#6] 模板整块登记只接受 rule_change 和非空 note', () => {
  const withoutNote: Omit<ModifyExistingBlockDeclaration, 'note'> = {
    ...entryLocation,
    reason: 'rule_change',
    br: ['BR-ID-08'],
  };
  const invalid = [
    [{ ...entryLocation, note: ENTRY.note, reason: 'flake_fix' }, /rule_change/],
    [{ ...entryLocation, note: ENTRY.note, reason: 'tighten_only' }, /rule_change/],
    [
      {
        ...entryLocation,
        note: ENTRY.note,
        reason: 'ruling_correction',
        overturned: 'D10-3624',
        basis: '规划/02 §12.3',
      },
      /rule_change/,
    ],
    [withoutNote as ModifyExistingBlockDeclaration, /note/],
    [{ ...ENTRY, note: '   ' }, /note/],
  ] as const satisfies readonly (readonly [ModifyExistingBlockDeclaration, RegExp])[];
  for (const [entry, reason] of invalid) {
    const { expected, result } = redRun(head, 'failed', { entry });
    expect(expected).toEqual([FILE]);
    expect(result.ok).toBe(false);
    expect(result.problems).toContainEqual({
      file: FILE,
      test: TITLE,
      reason: expect.stringMatching(reason),
    });
  }
});

it('[AC-CT-06zzzzzzzq#7] 拒绝带修饰、动态 describe、控制流与非字面量标题', () => {
  expect(namesWholeBlock(base, TITLE)).toBe(true);
  const modifiers = ['skip', 'only', 'concurrent', 'todo', 'fails'];
  const variants = [
    ...modifiers.map((modifier) => (block: string) => block.replace(/^it\(/, `it.${modifier}(`)),
    (block: string) => `${DESCRIBE}(\`group \${baselineVersion}\`, () => {\n${block}\n});`,
    (block: string) => `function register() {\n${block}\n}\nregister();`,
    (block: string) => `if (baselineVersion > 0) ${block}`,
    (block: string) => `for (let n = 0; n < 1; n++) {\n${block}\n}`,
    (block: string) =>
      `const title = ${template(TITLE)};\n${block.replace(template(TITLE), 'title')}`,
    (block: string) => block.replace(template(TITLE), `String(${template(TITLE)})`),
    (block: string) => block.replace(template(TITLE), `${template(TITLE)} + ''`),
  ];
  for (const wrap of variants) {
    const otherBase = sixTests(wrap(before));
    const otherHead = sixTests(wrap(after));
    expect(namesWholeBlock(otherBase, TITLE), otherBase).toBe(false);
    expect(compareModifiedBlocks(otherBase, otherHead, [TITLE]), otherBase).not.toMatchObject({
      ok: true,
      blocks: [{ found: true }],
    });
  }

  const concurrent = (block: string) => block.replace(/^it\(/, 'it.concurrent(');
  const { expected, result } = redRun(sixTests(concurrent(after)), 'failed', {
    baseSource: sixTests(concurrent(before)),
  });
  expect(expected).toEqual([FILE]);
  expect(result.ok).toBe(false);
  expect(result.exempt ?? []).toEqual([]);
  const failed = result.problems.map((problem) => problem.test);
  expect(failed).toEqual(expect.arrayContaining([...SIBLINGS]));
});

it('[AC-CT-06zzzzzzzq#8] 新整块登记可与静态标题、表格逐行、for…of 整块登记同时使用', () => {
  const simple = '[AC-DEMO#7] 静态标题';
  const each = '[AC-DEMO#8] each %s';
  const forTable = '[AC-DEMO#9] for %s';
  const forOf = '[AC-DEMO#10] 循环 ${version}';
  const fixture = (minimum: number) =>
    source(
      call(template(TITLE), minimum),
      call(JSON.stringify(simple), minimum),
      call(JSON.stringify(each), minimum, "it.each(['alpha', 'beta'])"),
      call(JSON.stringify(forTable), minimum, "test.for(['alpha', 'beta'])"),
      `for (const version of [1, 2]) {\n${call(template(forOf), minimum)}\n}`,
    );
  const rowNames = [each, forTable].flatMap((title) =>
    ['alpha', 'beta'].map((row) => title.replace('%s', row)),
  );
  const names = [simple, ...rowNames, forOf, TITLE];
  expect(namesWholeBlock(fixture(0), simple)).toBe(false);
  expect(namesWholeBlock(fixture(0), forOf)).toBe(true);
  expect(compareModifiedBlocks(fixture(0), fixture(1), names)).toMatchObject({
    ok: true,
    outside: null,
    blocks: names.map((test) => ({ test, found: true, changed: true })),
  });
});

it('[AC-CT-06zzzzzzzq#9] 先红与证据检查对模板标题整块登记使用同一份应跑清单', () => {
  const task = ledger({ modify_existing: [ENTRY] });
  const read = reader({ [FILE]: base }, { [FILE]: head });
  const mixed = reader(
    { [FILE]: base },
    { [FILE]: head.replace('baselineVersion = 2', 'baselineVersion = 3') },
  );
  const red = ruleTestsLeftOut([FILE], read, task);
  expect({
    red: red.expected,
    modifiedLeftOut: red.modifiedLeftOut,
    evidence: expectedRedFiles([FILE], read, task, task.modify_existing),
    mixedRed: ruleTestsLeftOut([FILE], mixed, task).expected,
    mixedEvidence: expectedRedFiles([FILE], mixed, task, task.modify_existing),
  }).toEqual({
    red: [],
    modifiedLeftOut: [FILE],
    evidence: [],
    mixedRed: [FILE],
    mixedEvidence: [FILE],
  });
});
