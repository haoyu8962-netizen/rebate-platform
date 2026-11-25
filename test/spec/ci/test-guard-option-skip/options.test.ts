import { expect, it } from 'vitest';
import { scanFile } from '../../../../tools/guard/lib/test-guard.ts';

const unit = 'apps/api/src/modules/platform/http/client.test.ts';
const funds = 'packages/money/src/round.test.ts';
const attribution = 'apps/api/src/modules/linking/claim.test.ts';
const forbiddenOptions = ['skip', 'only', 'todo', 'fails'];

function registration(callee: string, options?: string): string {
  const args = options === undefined ? '' : `${options}, `;
  return `${callee}('[AC-FIXTURE-1] sample', ${args}() => {});`;
}

function rules(file: string, source: string): string[] {
  return scanFile(file, source).map((finding) => finding.rule);
}

it('[AC-CT-06zzzzzzze#1] checks all four test APIs in unit, rule, integration, funds and attribution files', () => {
  const files = [
    unit,
    'test/spec/platform/response.test.ts',
    'apps/api/src/modules/platform/http/client.int.test.ts',
    funds,
    attribution,
  ];

  for (const file of files) {
    for (const api of ['it', 'test', 'describe', 'suite']) {
      for (const option of forbiddenOptions) {
        const permitted = registration(api, `{ ${option}: false }`);
        const forbidden = registration(api, `{ ${option}: true }`);

        expect(rules(file, permitted), `${file}: ${permitted}`).not.toContain('no-skip-only');
        expect(rules(file, forbidden), `${file}: ${forbidden}`).toContain('no-skip-only');
      }
    }
  }
});

it('[AC-CT-06zzzzzzze#2] requires a literal false instead of a false-valued expression or shorthand', () => {
  for (const option of forbiddenOptions) {
    const binding = `const ${option} = false;\n`;

    for (const property of [`${option}: ${option}`, `${option}: !true`, option]) {
      const source = binding + registration('it', `{ ${property} }`);
      expect(rules(unit, source), source).toEqual(['no-skip-only']);
    }
  }
});

it('[AC-CT-06zzzzzzze#3] checks quoted and computed literal option keys', () => {
  for (const option of forbiddenOptions) {
    for (const key of [`'${option}'`, `"${option}"`, `['${option}']`]) {
      const permitted = registration('test', `{ ${key}: false }`);
      const forbidden = registration('test', `{ ${key}: true }`);

      expect(rules(unit, permitted), permitted).toEqual([]);
      expect(rules(unit, forbidden), forbidden).toEqual(['no-skip-only']);
    }
  }
});

it('[AC-CT-06zzzzzzze#4] checks the final call in test modifier chains', () => {
  const callees = ['test.each([1, 2])', 'it.for([1, 2])', 'test.concurrent.each([1, 2])'];
  for (const callee of callees) {
    const permitted = registration(callee, '{ timeout: 1000, only: false }');
    const forbidden = registration(callee, '{ timeout: 1000, only: true }');

    expect(rules(unit, permitted), permitted).toEqual([]);
    expect(rules(unit, forbidden), forbidden).toEqual(['no-skip-only']);
  }
});

it('[AC-CT-06zzzzzzze#5] follows extended test functions when they receive named options', () => {
  const setups = [
    'const extended = test.extend({});\n',
    'const base = it.extend({});\nconst extended = base.extend({});\n',
  ];
  const call = registration('extended', 'options');

  for (const setup of setups) {
    const permitted = setup + 'const options = { fails: false };\n' + call;
    const forbidden = setup + 'const options = { fails: true };\n' + call;

    expect(rules(unit, permitted), permitted).toEqual([]);
    expect(rules(unit, forbidden), forbidden).toEqual(['no-skip-only']);
  }
});

it('[AC-CT-06zzzzzzze#6] checks an imported test function with the existing custom-call shape', () => {
  const setup = "import { fixtureTest } from './kit.ts';\n";
  const permitted = setup + registration('fixtureTest', '{ fails: false }');
  const forbidden = setup + registration('fixtureTest', '{ fails: true }');

  expect(rules(unit, permitted)).toEqual([]);
  expect(rules(unit, forbidden)).toEqual(['no-skip-only']);
});

it('[AC-CT-06zzzzzzze#7] reads named options declared as a local object literal', () => {
  const call = registration('it', 'options');
  const permitted = 'const options = { skip: false, timeout: 1000 };\n' + call;
  const forbidden = 'const options = { skip: true, timeout: 1000 };\n' + call;

  expect(rules(unit, permitted)).toEqual([]);
  expect(rules(unit, forbidden)).toEqual(['no-skip-only']);
});

it('[AC-CT-06zzzzzzze#8] refuses unreadable options from spreads and external variables', () => {
  const sources = [
    'const defaults = { timeout: 1000 };\n' + registration('it', '{ ...defaults, skip: false }'),
    "import { options } from './kit.ts';\n" + registration('it', 'options'),
  ];

  for (const source of sources) {
    expect(rules(unit, source), source).toContain('no-retry');
    expect(rules(unit, source), source).toContain('no-skip-only');
    expect(rules(funds, source), source).toContain('no-skip-only');
  }
});

it('[AC-CT-06zzzzzzze#9] refuses the fails modifier on its own and in a modifier chain', () => {
  const callees = [
    ['it', 'fails'],
    ['test', 'fails'],
    ['it.concurrent', 'fails'],
    ['test', 'fails', 'each([1, 2])'],
  ];

  for (const parts of callees) {
    const source = registration(parts.join('.'));
    expect(rules(unit, source), source).toEqual(['no-skip-only']);
    expect(rules(funds, source), source).toEqual(['no-skip-only']);
  }
});

it('[AC-CT-06zzzzzzze#10] preserves timeout options and the existing retry scopes', () => {
  const timeoutOption = registration('it', '{ timeout: 1000 }');
  const zeroRetry = registration('it', '{ retry: 0 }');
  const retryOption = registration('it', '{ retry: 2 }');
  const ordinaryField = 'const policy = { skip: true, retry: 2 };\n';
  const flaggedTest = registration('it', '{ skip: true }');

  for (const file of [unit, funds, attribution]) {
    expect(rules(file, timeoutOption)).toEqual([]);
    expect(rules(file, zeroRetry)).toEqual([]);
    expect(rules(file, retryOption)).toEqual(['no-retry']);
  }

  expect(rules(unit, ordinaryField + flaggedTest)).toEqual(['no-skip-only']);
  expect(rules(funds, ordinaryField + flaggedTest)).toEqual(['no-retry', 'no-skip-only']);
  expect(rules(attribution, ordinaryField + flaggedTest)).toEqual(['no-retry', 'no-skip-only']);
});
