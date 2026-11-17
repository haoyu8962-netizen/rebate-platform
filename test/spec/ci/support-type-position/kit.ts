// CT-06zzzzzn: exercise the public support evidence gate with source text, never execute it.
// Reuse only fixture / evidence helpers; expected P2 / P3 decisions come from the task brief.
import { expect } from 'vitest';
import {
  branch,
  check,
  ledger,
  lineOf,
  lineProblem,
  makeRepo,
  refusal,
  replaceOnce,
  support,
  supportRecord,
  trusted,
} from '../modify-existing-support/kit.ts';

export { SLOW, cleanup } from '../modify-existing-support/kit.ts';

const FILE = 'test/spec/identity/step-up-type-position/kit.ts';
const LEAF = '{ a: number }';

/** Each row contains exactly one edited leaf; every head starts from the same base. */
export function positionCases(
  name: string,
  rows: readonly string[],
  values: readonly string[] = [],
  inline = false,
): void {
  const base = [
    ...Array.from({ length: 18 }, () => '// CT-06zzzzzn fixture padding'),
    'type A = number;',
    'type B = void;',
    'declare const cond: boolean;',
    'declare const raw: never;',
    'declare const items: number[];',
    ...rows,
    ...values,
    '',
  ].join('\n');
  const text = ledger([support(FILE)], {
    testPaths: ['test/spec/identity/step-up-type-position-new/**'],
  });
  expect(refusal(text), 'valid support ledger').toBe('');
  const repo = makeRepo(`type-position-${name}`, { [FILE]: base });
  const trustedDir = trusted(`type-position-${name}`, text);

  const judge = (row: string, changed: string, allowed: boolean, inserted: string): void => {
    const head = replaceOnce(base, row, changed);
    expect(head, row).not.toBe(base);
    const sha = branch(repo, 'type-position', { [FILE]: head }, [supportRecord(FILE, base, head)]);
    const report = check(repo, sha, trustedDir);
    const why = `${name}: ${changed}\n${report.problems.join('\n')}`;
    // Run all controls even when the old classifier incorrectly allows a required member.
    expect.soft(report.ok, why).toBe(allowed);
    if (allowed) {
      expect.soft(report.problems, why).toEqual([]);
    } else {
      const line = lineOf(head, inserted);
      expect(line, why).toBeGreaterThan(18);
      expect.soft(lineProblem(report, FILE, [line]), why).toBeDefined();
    }
  };

  for (const row of rows) {
    judge(row, replaceOnce(row, LEAF, '{ a?: number }'), true, 'a?: number');
    for (const separator of [',', ';']) {
      for (const optional of [true, false]) {
        const inserted = `${separator} b${optional ? '?' : ''}: string`;
        const replacement = inline ? `{ a: number${inserted} }` : `{ a: number\n${inserted}\n }`;
        judge(row, replaceOnce(row, LEAF, replacement), optional, inserted);
      }
    }
  }
  for (const row of values) {
    const inserted = ', b: 2';
    judge(row, replaceOnce(row, '{ a: 1 }', `{ a: 1\n${inserted}\n }`), true, inserted);
  }
}

/** The same contextual word is an operand before both type operators. */
export function operandCases(name: string, keywordControl: string): void {
  positionCases(
    `operand-${name}`,
    [
      `declare const ${name}: never; const asserted = ${name} as [{ a: number }];`,
      `const checked = ${name} satisfies [string, { a: number }];`,
    ],
    [keywordControl],
  );
}
