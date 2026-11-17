// CT-06zzzzzk spec-test r1: P3 also permits optional marks and non-tail members.
// Keep the first-round fixtures and #1–#9 unchanged; source strings are gate input only.
import { afterAll, expect, it } from 'vitest';
import {
  SLOW,
  branch,
  check,
  cleanup,
  ledger,
  lineAt,
  lineProblem,
  makeRepo,
  refusal,
  replaceOnce,
  support,
  supportRecord,
  trusted,
} from '../modify-existing-support/kit.ts';

afterAll(cleanup);

const FILE = 'test/spec/identity/step-up-nested/kit.ts';
const PAD = Array.from({ length: 18 }, () => '// CT-06zzzzzk member-position padding');
const SHAPES = [
  ['first tuple element', (leaf: string) => `[${leaf}]`],
  ['generic argument', (leaf: string) => `Promise<${leaf}>`],
] as const;

function fixture(name: string, declaration: string) {
  const base = [...PAD, declaration, ''].join('\n');
  const text = ledger([support(FILE)], {
    testPaths: ['test/spec/identity/step-up-nested-new/**'],
  });
  expect(refusal(text), 'the support ledger is valid').toBe('');
  return {
    base,
    repo: makeRepo(`nested-member-${name}`, { [FILE]: base }),
    trusted: trusted(`nested-member-${name}`, text),
  };
}

function judge(
  f: ReturnType<typeof fixture>,
  head: string,
  name: string,
  allowed: boolean,
  insertedLine: string,
): void {
  expect(head, name).not.toBe(f.base);
  const sha = branch(f.repo, 'nested-member', { [FILE]: head }, [
    supportRecord(FILE, f.base, head),
  ]);
  const report = check(f.repo, sha, f.trusted);
  const why = `${name}\n${report.problems.join('\n')}`;
  // Continue through both shapes and both sides of the optional/required pair on failure.
  expect.soft(report.ok, why).toBe(allowed);
  if (allowed) {
    expect.soft(report.problems, why).toEqual([]);
  } else {
    const line = lineAt(head, insertedLine);
    expect(line, name).toBeGreaterThan(18);
    expect.soft(lineProblem(report, FILE, [line]), why).toBeDefined();
  }
}

it(
  '[AC-CT-06zzzzzk#10] adding only ? to an existing member in the first tuple element or a generic argument passes',
  () => {
    for (const [label, shape] of SHAPES) {
      const f = fixture(`optional-mark-${label}`, `type Row = ${shape('{ a: number }')};`);
      const head = replaceOnce(f.base, 'a: number', 'a?: number');
      // Exactly one inserted token: this must use annotation(), not whole-member parsing.
      expect(head).toBe(replaceOnce(f.base, 'a:', 'a?:'));
      judge(f, head, `${label}: existing member becomes optional`, true, '');
    }
  },
  SLOW,
);

function memberCases(position: 'before' | 'between'): void {
  for (const [label, shape] of SHAPES) {
    for (const separator of [';', ',']) {
      const leaf = `{\n  a: number${separator}\n  c: string\n}`;
      const f = fixture(`${position}-${label}-${separator}`, `type Row = ${shape(leaf)};`);
      const anchor = position === 'before' ? `  a: number${separator}` : '  c: string';
      for (const optional of [true, false]) {
        const inserted = `  b${optional ? '?' : ''}: string${separator}`;
        const head = replaceOnce(f.base, anchor, `${inserted}\n${anchor}`);
        // Each head starts at the same base; only the inserted member's ? differs.
        judge(f, head, `${label}: ${position}: ${inserted}`, optional, inserted);
      }
    }
  }
}

it(
  '[AC-CT-06zzzzzk#11] before existing nested members, optional members pass and required members are refused at the inserted file and line',
  () => {
    memberCases('before');
  },
  SLOW,
);

it(
  '[AC-CT-06zzzzzk#12] between existing nested members, optional members pass and required members are refused at the inserted file and line',
  () => {
    memberCases('between');
  },
  SLOW,
);
