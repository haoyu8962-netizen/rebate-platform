import { expect, it } from 'vitest';
import {
  checkRedReports,
  ruleTestBaselines,
  ruleTestsLeftOut,
} from '../../../../tools/guard/lib/red-check.ts';
import {
  type Outcome,
  ROOT,
  ledger,
  modifyOf,
  reader,
  report,
} from '../red-check-mixed-leave-out/kit.ts';

const DIR = 'test/spec/demo/admin-permissions';
const A = `${DIR}/refusals.int.test.ts`;
const B = `${DIR}/writes.int.test.ts`;
const KIT = `${DIR}/kit.ts`;
const DATA = `${DIR}/roles.json`;
const A_TITLE = '[AC-DEMO#1] 拒绝缺少权限的请求';
const B_KEPT = '[AC-DEMO#2] 已有权限点保持可读';
const B_DECLARED = '[AC-DEMO#3] 按新规则拒绝越权操作';
const B_CHANGED = '[AC-DEMO#4] 缺少动态码时拒绝写入';
const IMPORTS = "import { expect, it } from 'vitest';";
const A_BASE = `${IMPORTS}
const denied = 10403;
it('${A_TITLE}', () => { expect(denied).toBeGreaterThan(0); });
`;
const A_HEAD = A_BASE.replace('toBeGreaterThan(0)', 'toBe(10403)');
const KIT_BASE = [
  "import { createRequire } from 'node:module';",
  "const load = createRequire(new URL('apps/api/package.json', import.meta.url));",
  "export const readPermission = () => load('./permissions.cjs').canRead();",
  '',
].join('\n');

function run(options: {
  changed: 'passed' | 'failed';
  kitChanged?: boolean;
  dataChanged?: boolean;
  importsA?: boolean;
  outsideA?: boolean;
}) {
  const bBase = [
    IMPORTS,
    "import { readPermission } from './kit.ts';",
    ...(options.importsA === true ? ["import './refusals.int.test.ts';"] : []),
    `it('${B_KEPT}', () => { expect(readPermission()).toBe(true); });`,
    `it('${B_DECLARED}', () => { expect(10403).toBeGreaterThan(0); });`,
    `it('${B_CHANGED}', () => { expect(10003).toBeGreaterThan(0); });`,
    '',
  ].join('\n');
  const bHead = bBase
    .replace('expect(10403).toBeGreaterThan(0)', 'expect(10403).toBe(10403)')
    .replace('expect(10003).toBeGreaterThan(0)', 'expect(10003).toBe(10003)');
  const base = { [A]: A_BASE, [B]: bBase, [KIT]: KIT_BASE, [DATA]: '{}' };
  const head = {
    [A]: options.outsideA === true ? A_HEAD.replace('denied = 10403', 'denied = 10404') : A_HEAD,
    [B]: bHead,
    [KIT]: options.kitChanged === true ? KIT_BASE.replace('canRead()', 'canRead(true)') : KIT_BASE,
    [DATA]: options.dataChanged === true ? '{"allowed":true}' : '{}',
  };
  const changedFiles = [
    A,
    B,
    ...(options.kitChanged === true ? [KIT] : []),
    ...(options.dataChanged === true ? [DATA] : []),
  ];
  const read = reader(base, head);
  const task = ledger({ modify_existing: [modifyOf(A, A_TITLE), modifyOf(B, B_DECLARED)] });
  const left = ruleTestsLeftOut([A, B], read, task);
  const baselines = ruleTestBaselines(
    left.expected,
    changedFiles.map((path) => ({ path, status: 'M' as const })),
    [`${DIR}/**`],
    read,
    task.renames,
    task.expected_values,
    task.red_exempt_outside,
    task.red_exempt_rows,
    task.modify_existing,
  );
  const outcomes: Record<string, Outcome[]> = {
    [B]: [
      [B_KEPT, 'passed'],
      [B_DECLARED, 'passed'],
      [B_CHANGED, options.changed],
    ],
  };
  if (left.expected.includes(A)) outcomes[A] = [[A_TITLE, 'passed']];
  const result = checkRedReports(
    [report(outcomes)],
    left.expected,
    ROOT,
    baselines,
    task.red_exempt,
    task.red_exempt_rows,
    task.modify_existing,
    left.modifiedLeftOut,
  );
  return { left, baselines, result };
}

it('[AC-CT-06zzzzzzzj#7] A 的改动全在登记块时，B 未改的用例照旧豁免，未经登记的新改动仍须先红', () => {
  const { left, baselines, result } = run({ changed: 'failed' });
  expect(left.expected).toEqual([B]);
  expect(left.modifiedLeftOut).toEqual([A]);
  expect(baselines.get(B)?.kind).toBe('tests');
  expect(result.problems).toEqual([]);
  expect(result.ok).toBe(true);
  expect(result.red).toEqual([`${B} > ${B_CHANGED}`]);
  expect(result.exempt).toContainEqual({ file: B, test: B_KEPT, status: 'passed' });
  expect(result.exempt).toContainEqual(
    expect.objectContaining({ file: B, test: B_DECLARED, modified: true }),
  );
  expect(result.notes).toContainEqual(expect.stringContaining(`${B} > ${B_KEPT}: unchanged`));

  const green = run({ changed: 'passed' }).result;
  expect(green.ok).toBe(false);
  expect(green.problems).toEqual([
    { file: B, test: B_CHANGED, reason: expect.stringContaining('green on the skeleton') },
  ]);
});

it('[AC-CT-06zzzzzzzj#8] 真正的支撑文件改动仍让 B 整文件重判，包括经 createRequire 可能读到的文件', () => {
  expect(run({ changed: 'failed' }).baselines.get(B)?.kind).toBe('tests');

  for (const [options, path] of [
    [{ kitChanged: true }, KIT],
    [{ dataChanged: true }, DATA],
  ] as const) {
    const { left, baselines, result } = run({ ...options, changed: 'failed' });
    expect(left.modifiedLeftOut).toEqual([A]);
    expect(baselines.get(B)).toMatchObject({
      kind: 'support',
      reason: expect.stringContaining(path),
    });
    if (path === DATA) {
      expect(baselines.get(B)).toMatchObject({ reason: expect.stringContaining('createRequire') });
    }
    expect(result.problems).toContainEqual({
      file: B,
      test: B_KEPT,
      reason: expect.stringContaining('green on the skeleton'),
    });
    expect(result.exempt).not.toContainEqual(expect.objectContaining({ file: B, test: B_KEPT }));
  }
});

it('[AC-CT-06zzzzzzzj#9] A 虽已移出先红名单，B 显式导入 A 仍触发整文件判定', () => {
  expect(run({ changed: 'failed' }).baselines.get(B)?.kind).toBe('tests');

  const { left, baselines, result } = run({ changed: 'failed', importsA: true });
  expect(left.modifiedLeftOut).toEqual([A]);
  expect(baselines.get(B)).toMatchObject({
    kind: 'support',
    reason: expect.stringContaining(`it loads ${A}`),
  });
  expect(result.problems).toContainEqual({
    file: B,
    test: B_KEPT,
    reason: expect.stringContaining('green on the skeleton'),
  });
  expect(result.exempt).not.toContainEqual(expect.objectContaining({ file: B, test: B_KEPT }));
});

it('[AC-CT-06zzzzzzzj#10] A 有块外改动时留在先红名单，B 经同一个 kit 仍可逐块判定', () => {
  const eligible = run({ changed: 'failed' });
  const ineligible = run({ changed: 'failed', outsideA: true });

  expect(ineligible.left.expected).toEqual([A, B]);
  expect(ineligible.left.modifiedLeftOut).toEqual([]);
  expect(ineligible.baselines.get(A)?.kind).toBe('whole');
  expect(ineligible.result.problems).toContainEqual({
    file: A,
    test: A_TITLE,
    reason: expect.stringContaining('green on the skeleton'),
  });
  expect(ineligible.baselines.get(B)?.kind).toBe('tests');
  const kept = { file: B, test: B_KEPT, status: 'passed' };
  expect(ineligible.result.exempt).toContainEqual(kept);
  expect(eligible.result.exempt).toContainEqual(kept);
});
