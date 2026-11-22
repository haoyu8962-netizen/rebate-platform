import { type Fields, block, ledger } from '../modify-existing-support/kit.ts';

export const FILE = 'test/spec/demo/step-up.test.ts';
export const TITLE = '[AC-DEMO-01#1] keeps $label response';
export const OUTSIDE = '[AC-DEMO-01#2] keeps summary response';
export const NOTE = 'alpha now uses the new response and beta already meets the new expectation';
export const RULING = 'D10-2559';
export const BR = 'BR-DEMO-01';

const RUNTIME_ROWS =
  "[...(['alpha', 'beta'] as const).map((label, i) => ({ label, value: i + 1 }))]";
export const LITERAL_ROWS = "[{ label: 'alpha', value: 1 }, { label: 'beta', value: 2 }]";

export function eachBlock(expected: number, rows = 'rows', title = TITLE): string {
  return [
    `it.each(${rows})(${JSON.stringify(title)}, ({ value }) => {`,
    `  expect(value).toBe(${expected});`,
    '});',
  ].join('\n');
}

export function source(blocks: readonly string[], summaryMinimum = 0): string {
  return [
    "import { expect, it } from 'vitest';",
    `const rows = ${RUNTIME_ROWS};`,
    ...blocks,
    `it('${OUTSIDE}', () => {`,
    `  expect(1).toBeGreaterThanOrEqual(${summaryMinimum});`,
    '});',
    '',
  ].join('\n');
}

export function entry(test = TITLE, extra: Fields = {}): Fields {
  return block(FILE, test, { br: [BR], ruling: RULING, note: NOTE, ...extra });
}

export function taskLedger(declaration: Fields, hash?: string): string {
  return ledger([declaration], {
    refs: [BR],
    ...(hash === undefined ? {} : { refsHash: { [BR]: hash } }),
    paths: ['test/spec/demo/**'],
  });
}
