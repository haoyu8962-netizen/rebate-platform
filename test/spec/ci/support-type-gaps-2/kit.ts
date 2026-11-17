// D10-1989: source fixtures go through the public evidence gate; never execute their code.
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

const FILE = 'test/spec/identity/step-up-type-gaps-2/kit.ts';

type Judge = (
  from: string,
  to: string,
  allowed: boolean,
  inserted: string,
  reason?: string,
) => void;

/** Each edit is independent, from the same base, with valid file-level support evidence. */
export function fixture(name: string, rows: readonly string[]): Judge {
  const base = [
    ...Array.from({ length: 18 }, () => '// CT-06zzzzzo fixture padding'),
    'declare const raw: never;',
    'declare const cond: boolean;',
    'declare function ping(): void;',
    'let dup = 1;',
    ...rows,
    '',
  ].join('\n');
  const text = ledger([support(FILE)], {
    testPaths: ['test/spec/identity/step-up-type-gaps-2-new/**'],
  });
  expect(refusal(text), 'valid support ledger').toBe('');
  const repo = makeRepo(`type-gaps-2-${name}`, { [FILE]: base });
  const trustedDir = trusted(`type-gaps-2-${name}`, text);

  return (from, to, allowed, inserted, reason): void => {
    const head = replaceOnce(base, from, to);
    expect(head, from).not.toBe(base);
    const sha = branch(repo, 'type-gaps-2', { [FILE]: head }, [supportRecord(FILE, base, head)]);
    const report = check(repo, sha, trustedDir);
    const why = `${name}: ${to}\n${report.problems.join('\n')}`;
    // Continue through the controls even when a regression fails on the old classifier.
    expect.soft(report.ok, why).toBe(allowed);
    if (allowed) {
      expect.soft(report.problems, why).toEqual([]);
    } else {
      const line = lineOf(head, inserted);
      expect(line, why).toBeGreaterThan(18);
      const problem = lineProblem(report, FILE, [line]);
      expect.soft(problem, why).toBeDefined();
      if (reason !== undefined) {
        expect.soft(problem, why).toEqual(expect.stringContaining(reason));
        if (reason === 'an index') {
          expect.soft(problem, why).not.toEqual(expect.stringContaining('an existing array'));
        }
      }
    }
  };
}

/** P3: adding ? is allowed; required/optional members differ only by the optional marker. */
export function typeMembers(judge: Judge, row: string, leaf = '{ a: number }'): void {
  const optional = replaceOnce(leaf, ':', '?:');
  judge(row, replaceOnce(row, leaf, optional), true, optional);
  for (const separator of [',', ';']) {
    for (const optional of [true, false]) {
      const member = `b${optional ? '?' : ''}: string`;
      const inserted = leaf.endsWith('; }') ? `${member}${separator}` : `${separator} ${member}`;
      const changed = replaceOnce(leaf, ' }', `\n${inserted}\n }`);
      judge(row, replaceOnce(row, leaf, changed), optional, inserted);
    }
  }
}

/** P2 permits a value object's appended property, with no optional marker. */
export function valueMember(judge: Judge, row: string): void {
  const inserted = ', b: 2';
  judge(row, replaceOnce(row, '{ a: 1 }', `{ a: 1\n${inserted}\n }`), true, inserted);
}
