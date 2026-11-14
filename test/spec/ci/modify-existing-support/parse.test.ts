// CT-06zzzzzi (D10-1662) 新条目 1: parseTaskFile and tools/ops/task.ts check read a modify_existing
// entry without `test` and with `scope: support` (a file-level entry for a frozen shared fixture
// or top-level helper). Refusals are matched on stable keywords and the named entry / file only.
import { afterAll, expect, it } from 'vitest';
import { findRuleInText, ruleHash } from '../../../../tools/ops/spec.ts';
import { checkTask } from '../../../../tools/ops/task.ts';
import { fixedRisk, memorySpec } from '../../../../tools/ops/test-helpers.ts';
import {
  BR,
  HELPER_TEST,
  MONEY_KIT,
  NOTE,
  PROP,
  REPLAY,
  RULING,
  SUPPORT,
  SUPPORT_RC,
  T2,
  asRecord,
  block,
  cleanup,
  ledger,
  parse,
  refusal,
  scratch,
  support,
  write,
} from './kit.ts';

afterAll(cleanup);

it('[CT-06zzzzzi#1] a support entry (file, scope: support, reason, br, ruling, note; no test) parses, under test/spec, test/properties and test/replay', () => {
  const text = ledger([support(SUPPORT), support(MONEY_KIT), support(PROP), support(REPLAY)]);
  expect(refusal(text)).toBe('');
  const entries = parse(text).modify_existing.map(asRecord);
  expect(entries.map((e) => e['file'])).toEqual([SUPPORT, MONEY_KIT, PROP, REPLAY]);
  for (const e of entries) {
    expect(e).toMatchObject({
      scope: 'support',
      reason: 'rule_change',
      br: [BR],
      ruling: RULING,
      note: NOTE,
    });
    expect(e['test'], `${String(e['file'])}: a support entry names no test`).toBeUndefined();
    expect(e['retitle_to']).toBeUndefined();
  }
});

it('[CT-06zzzzzi#2] a support entry of a file that is not a money or attribution test may use every reason, judged as a block entry', () => {
  const tight = ledger([support(SUPPORT, { reason: 'tighten_only', br: undefined })]);
  expect(refusal(tight)).toBe('');
  expect(asRecord(parse(tight).modify_existing[0])).toMatchObject({
    file: SUPPORT,
    scope: 'support',
    reason: 'tighten_only',
  });
  expect(asRecord(parse(tight).modify_existing[0])['br']).toBeUndefined();
  const flake = ledger([support(SUPPORT, { reason: 'flake_fix', br: undefined })]);
  expect(refusal(flake)).toBe('');
  const rc = ledger([
    support(SUPPORT_RC, {
      reason: 'ruling_correction',
      br: undefined,
      overturned: 'D10-1500',
      basis: '规划/02 §12.3',
    }),
  ]);
  expect(refusal(rc)).toBe('');
  expect(asRecord(parse(rc).modify_existing[0])).toMatchObject({
    file: SUPPORT_RC,
    scope: 'support',
    reason: 'ruling_correction',
    overturned: 'D10-1500',
    basis: '规划/02 §12.3',
  });
});

it('[CT-06zzzzzi#3] one file may carry a support entry and block entries side by side; ledger order is kept', () => {
  const text = ledger([support(HELPER_TEST), block(HELPER_TEST, T2)]);
  expect(refusal(text)).toBe('');
  const [first, second] = parse(text).modify_existing.map(asRecord);
  expect(first).toMatchObject({ file: HELPER_TEST, scope: 'support' });
  expect(first?.['test']).toBeUndefined();
  expect(second).toMatchObject({ file: HELPER_TEST, test: T2, reason: 'rule_change' });
  expect(second?.['scope']).toBeUndefined();
});

it('[CT-06zzzzzi#4] scope must be support; an entry with neither test nor scope is still refused', () => {
  expect(refusal(ledger([support(SUPPORT)]))).toBe('');
  for (const scope of ['all', 'block', 'file', '']) {
    expect(refusal(ledger([support(SUPPORT, { scope })])), scope).toMatch(
      /modify_existing\[0\]\.scope/,
    );
  }
  expect(refusal(ledger([support(SUPPORT, { scope: ['support'] })]))).toMatch(
    /modify_existing\[0\]\.scope/,
  );
  expect(refusal(ledger([support(SUPPORT, { scope: undefined })]))).toMatch(
    /modify_existing\[0\]\.(test|scope)/,
  );
});

it('[CT-06zzzzzi#5] an entry with both test and scope is refused', () => {
  expect(refusal(ledger([support(HELPER_TEST)]))).toBe('');
  const both = refusal(ledger([support(HELPER_TEST, { test: T2 })]));
  expect(both).toMatch(/modify_existing\[0\]/);
  expect(both).toMatch(/\b(test|scope)\b/);
});

it('[CT-06zzzzzi#6] a support entry may not carry retitle_to', () => {
  expect(refusal(ledger([support(HELPER_TEST)]))).toBe('');
  const renamed = refusal(ledger([support(HELPER_TEST, { retitle_to: '[AC-B9-01#2] renamed' })]));
  expect(renamed).toMatch(/modify_existing\[0\]/);
  expect(renamed).toMatch(/retitle_to/);
});

it('[CT-06zzzzzi#7] a support entry names a file under test/spec, test/properties or test/replay only', () => {
  expect(refusal(ledger([support(SUPPORT)]))).toBe('');
  for (const file of [
    'test/acceptance/payout/kit.ts',
    'test/smoke/kit.ts',
    'test/specx/identity/kit.ts',
    'packages/testing/src/kit.ts',
    'tools/ci/kit.ts',
  ]) {
    const message = refusal(ledger([support(file)]));
    expect(message, file).toMatch(/modify_existing\[0\]\.file/);
    expect(message, file).toContain(file);
  }
});

it('[CT-06zzzzzi#8] a file has at most one support entry', () => {
  expect(refusal(ledger([support(SUPPORT), support(MONEY_KIT)]))).toBe('');
  for (const second of [
    support(SUPPORT),
    support(SUPPORT, { reason: 'tighten_only', br: undefined }),
  ]) {
    const message = refusal(ledger([support(SUPPORT), second]));
    expect(message).toMatch(/modify_existing\[1\]/);
    expect(message).toContain(SUPPORT);
  }
});

it('[CT-06zzzzzi#9] reason, br, ruling, note, overturned and basis of a support entry are checked as for a block entry', () => {
  expect(refusal(ledger([support(SUPPORT)]))).toBe('');
  const rc = {
    reason: 'ruling_correction',
    br: undefined,
    overturned: 'D10-1500',
    basis: '规划/02 §12.3',
  };
  expect(refusal(ledger([support(SUPPORT_RC, rc)]))).toBe('');
  const cases: [string, string, RegExp][] = [
    [
      'reason unknown',
      ledger([support(SUPPORT, { reason: 'refactor' })]),
      /modify_existing\[0\]\.reason/,
    ],
    [
      'rule_change without br',
      ledger([support(SUPPORT, { br: undefined })]),
      /modify_existing\[0\]\.br/,
    ],
    ['br empty', ledger([support(SUPPORT, { br: [] })]), /modify_existing\[0\]\.br/],
    [
      'br not a BR id',
      ledger([support(SUPPORT, { br: ['BR-ID-8x1'] })]),
      /modify_existing\[0\]\.br/,
    ],
    ['br twice', ledger([support(SUPPORT, { br: [BR, BR] })]), /modify_existing\[0\]\.br/],
    [
      'br outside refs',
      ledger([support(SUPPORT, { br: [BR, 'BR-ID-09'] })]),
      /modify_existing\[0\]\.br: .*BR-ID-09/,
    ],
    [
      'tighten_only with br',
      ledger([support(SUPPORT, { reason: 'tighten_only' })]),
      /modify_existing\[0\]\.br/,
    ],
    [
      'flake_fix with br',
      ledger([support(SUPPORT, { reason: 'flake_fix' })]),
      /modify_existing\[0\]\.br/,
    ],
    [
      'ruling not D10-<n>',
      ledger([support(SUPPORT, { ruling: 'D10-x' })]),
      /modify_existing\[0\]\.ruling/,
    ],
    [
      'ruling missing',
      ledger([support(SUPPORT, { ruling: undefined })]),
      /modify_existing\[0\]\.ruling/,
    ],
    ['note too short', ledger([support(SUPPORT, { note: 'short' })]), /modify_existing\[0\]\.note/],
    ['note missing', ledger([support(SUPPORT, { note: undefined })]), /modify_existing\[0\]\.note/],
    [
      'ruling_correction without overturned',
      ledger([support(SUPPORT_RC, { ...rc, overturned: undefined })]),
      /modify_existing\[0\]\.overturned/,
    ],
    [
      'overturned is the ruling',
      ledger([support(SUPPORT_RC, { ...rc, overturned: RULING })]),
      /modify_existing\[0\]\.overturned/,
    ],
    [
      'ruling_correction without basis',
      ledger([support(SUPPORT_RC, { ...rc, basis: undefined })]),
      /modify_existing\[0\]\.basis/,
    ],
    [
      'basis not 规划/ or docs/adr/',
      ledger([support(SUPPORT_RC, { ...rc, basis: '08 BR-ID-08' })]),
      /modify_existing\[0\]\.basis/,
    ],
    [
      'ruling_correction with br',
      ledger([support(SUPPORT_RC, { ...rc, br: [BR] })]),
      /modify_existing\[0\]\.br/,
    ],
    [
      'rule_change with overturned',
      ledger([support(SUPPORT, { overturned: 'D10-1500' })]),
      /modify_existing\[0\]\.overturned/,
    ],
    [
      'rule_change with basis',
      ledger([support(SUPPORT, { basis: '规划/02 §12.3' })]),
      /modify_existing\[0\]\.basis/,
    ],
    [
      'unknown field',
      ledger([support(SUPPORT, { mutation: 'x' })]),
      /modify_existing\[0\]\.mutation/,
    ],
  ];
  for (const [name, text, want] of cases) {
    expect(refusal(text), name).toMatch(want);
  }
});

it('[CT-06zzzzzi#10] a support entry of a money or attribution test accepts rule_change only', () => {
  for (const file of [MONEY_KIT, PROP, REPLAY, HELPER_TEST]) {
    expect(refusal(ledger([support(file)])), file).toBe('');
    for (const reason of ['tighten_only', 'flake_fix']) {
      const message = refusal(ledger([support(file, { reason, br: undefined })]));
      expect(message, `${file} ${reason}`).toMatch(/modify_existing\[0\]/);
      expect(message, `${file} ${reason}`).toMatch(/money|attribution|rule_change/i);
    }
    const rc = refusal(
      ledger([
        support(file, {
          reason: 'ruling_correction',
          br: undefined,
          overturned: 'D10-1500',
          basis: '规划/02 §12.3',
        }),
      ]),
    );
    expect(rc, `${file} ruling_correction`).toMatch(/modify_existing\[0\]\.file/);
    expect(rc, `${file} ruling_correction`).toContain(file);
  }
});

it('[CT-06zzzzzi#11] support entries count towards modify_existing + red_exempt ≤ RED_EXEMPT_MAX', () => {
  const blocks = (n: number) =>
    Array.from({ length: n }, (_, i) => block(HELPER_TEST, `[AC-B9-01#${i + 10}] t`));
  expect(refusal(ledger([...blocks(299), support(SUPPORT)]))).toBe('');
  expect(refusal(ledger([...blocks(300), support(SUPPORT)]))).toMatch(
    /modify_existing: 301 entries/,
  );
  expect(refusal(ledger([...blocks(149), support(SUPPORT)], { redExempt: 150 }))).toBe('');
  expect(
    refusal(ledger([...blocks(149), support(SUPPORT), support(MONEY_KIT)], { redExempt: 150 })),
  ).toMatch(/modify_existing: 301 entries/);
});

// tools/ops/task.ts check: the synthetic planning text of tools/ops/task.test.ts (a BR and a task
// row), a scratch root with the protected-path list and the frozen fixture at the base.
const RULES_08 = [
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
const PLAN_05 = ['| 任务 | 内容 |', '| --- | --- |', '| X1-02 | 演示任务 |', ''].join('\n');
const SPEC = memorySpec({
  '规划/08_业务规则/01_DEMO.md': RULES_08,
  '规划/05_里程碑与任务拆分.md': PLAN_05,
});

it('[CT-06zzzzzi#12] task.ts check accepts a support entry of a fixture (not *.test.ts) that exists at the base, and refuses one that does not', () => {
  const rule = findRuleInText(RULES_08, 'BR-DEMO-01', 'demo.md');
  expect(rule).not.toBeNull();
  const hash = rule === null ? '' : ruleHash(rule);
  const root = scratch('task-check');
  const KIT = 'test/spec/demo/kit.ts';
  const MISSING = 'test/spec/demo/missing-kit.ts';
  const opts = {
    refs: ['BR-DEMO-01'],
    refsHash: { 'BR-DEMO-01': hash },
    paths: ['test/spec/demo/**'],
  };
  const entry = (file: string) => support(file, { br: ['BR-DEMO-01'] });
  write(root, {
    'tools/guard/protected-paths.json': JSON.stringify({
      class1_add_only: ['test/spec/**', 'test/properties/**', 'test/replay/**'],
      class2_verify_config: [],
      class3_gates: [],
    }),
    [KIT]: 'export const kit = 1;\n',
    'ops/tasks/X1-02sa.yaml': ledger([entry(KIT)], { ...opts, id: 'X1-02sa' }),
    'ops/tasks/X1-02sb.yaml': ledger([entry(MISSING)], { ...opts, id: 'X1-02sb' }),
  });
  const run = (id: string) => checkTask(id, { root, spec: SPEC, risk: fixedRisk('RV1') });
  expect(run('X1-02sa')).toEqual([]);
  const missing = run('X1-02sb').join('\n');
  expect(missing).toContain(MISSING);
  expect(missing).toMatch(/does not exist at the base/);
});

it('[CT-06zzzzzi#13] block entries read as before: same shape, a money test may still use tighten_only, a duplicate is still refused', () => {
  const text = ledger([
    block(HELPER_TEST, T2),
    block(HELPER_TEST, '[AC-B9-01#1] applies', { reason: 'tighten_only', br: undefined }),
  ]);
  expect(refusal(text)).toBe('');
  expect(parse(text).modify_existing).toEqual([
    { file: HELPER_TEST, test: T2, reason: 'rule_change', ruling: RULING, note: NOTE, br: [BR] },
    {
      file: HELPER_TEST,
      test: '[AC-B9-01#1] applies',
      reason: 'tighten_only',
      ruling: RULING,
      note: NOTE,
    },
  ]);
  expect(refusal(ledger([block(HELPER_TEST, T2), block(HELPER_TEST, T2)]))).toMatch(
    /modify_existing\[1\]: .* is declared twice/,
  );
  expect(refusal(ledger([block(HELPER_TEST, T2, { br: undefined })]))).toMatch(
    /modify_existing\[0\]\.br/,
  );
});
