// CT-06zzzzzk: exercise the public modify_existing / scope: support evidence gate.
// The existing fixture helpers create isolated git repositories under .tmp/; these source
// strings are gate input, never executed. No production parser or classification helper is used
// to calculate an expected result.
import { expect } from 'vitest';
import {
  type Repo,
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

const FILE = 'test/spec/identity/step-up-nested/kit.ts';
const LEAF = '{ a: number }';
const PAD = Array.from({ length: 18 }, () => '// CT-06zzzzzk fixture padding');

export type Shape = readonly [name: string, type: string];
export type Position = (type: string, index: number) => string;

/** Each contains exactly one leaf to edit, including both sides of the tuple comma. */
export const SHAPES: readonly Shape[] = [
  ['first tuple element', `[${LEAF}]`],
  ['later tuple element', `[string, ${LEAF}]`],
  ['array suffix', `${LEAF}[]`],
  ['Array argument', `Array<${LEAF}>`],
  ['union arm', `A | ${LEAF}`],
  ['intersection arm', `A & ${LEAF}`],
  ['Promise argument', `Promise<${LEAF}>`],
  ['second Record argument', `Record<string, ${LEAF}>`],
  ['object member type', `{ x: ${LEAF} }`],
];

type Fixture = { repo: Repo; trusted: string; base: string };

function fixture(name: string, lines: readonly string[]): Fixture {
  const base = [
    ...PAD,
    'type A = { id: string };',
    'declare const raw: never;',
    'declare function f(value: unknown): void;',
    ...lines,
    '',
  ].join('\n');
  const text = ledger([support(FILE)], {
    testPaths: ['test/spec/identity/step-up-nested-new/**'],
  });
  expect(refusal(text), 'the support ledger is valid').toBe('');
  return {
    repo: makeRepo(`nested-type-${name}`, { [FILE]: base }),
    trusted: trusted(`nested-type-${name}`, text),
    base,
  };
}

function judge(f: Fixture, head: string, name: string, allowed: boolean, inserted: string): void {
  expect(head, name).not.toBe(f.base);
  const sha = branch(f.repo, 'nested-type', { [FILE]: head }, [supportRecord(FILE, f.base, head)]);
  const report = check(f.repo, sha, f.trusted);
  const why = `${name}\n${report.problems.join('\n')}`;
  // Soft assertions let all positive controls and both separators run even on the old code.
  expect.soft(report.ok, why).toBe(allowed);
  if (allowed) {
    expect.soft(report.problems, why).toEqual([]);
  } else {
    const line = lineOf(head, inserted);
    expect(line, name).toBeGreaterThan(18);
    expect.soft(lineProblem(report, FILE, [line]), why).toBeDefined();
  }
}

/**
 * The only base -> head edit is inside one existing object type. Optional / required heads
 * differ only by `?`, and each head is checked independently from the same merge base.
 * Prefix/suffix separators are inserted on the member's own line, pinning its diagnostic line.
 */
export function typeCases(
  name: string,
  position: Position,
  shapes: readonly Shape[] = SHAPES,
  separators: readonly (readonly [prefix: string, suffix: string])[] = [
    [';', ''],
    [',', ''],
  ],
  expressions: readonly string[] = [],
): void {
  const rows = shapes.map(([label, type], index) => ({ label, line: position(type, index) }));
  const f = fixture(name, [...rows.map(({ line }) => line), ...expressions]);
  for (const expression of expressions) {
    const inserted = ', b: 2';
    const changed = replaceOnce(expression, '{ a: 1 }', `{ a: 1\n${inserted}\n }`);
    judge(f, replaceOnce(f.base, expression, changed), `${name}: P2 ${expression}`, true, inserted);
  }
  for (const { label, line } of rows) {
    for (const [prefix, suffix] of separators) {
      for (const optional of [true, false]) {
        const inserted = `${prefix} b${optional ? '?' : ''}: string${suffix}`;
        const changed = replaceOnce(line, LEAF, `{ a: number\n${inserted}\n }`);
        judge(
          f,
          replaceOnce(f.base, line, changed),
          `${name}: ${label}: ${inserted}`,
          optional,
          inserted,
        );
      }
    }
  }
}

/** A tuple, generic, member type, union and array recur at every level. */
export function deepShape(depth: number): Shape {
  let type = `[${LEAF}]`;
  for (let level = 0; level < depth; level += 1) {
    type = `[string, Promise<{ x: Array<A | ${type}> }>]`;
  }
  return [`mixed nesting depth ${depth}`, type];
}

/** The original single-line reproduction, without newline-based member separation. */
export function inlineTupleCases(): void {
  const line = 'type Row = [{ a: number }];';
  const f = fixture('inline-tuple', [line]);
  for (const separator of [';', ',']) {
    for (const optional of [true, false]) {
      const inserted = `${separator} b${optional ? '?' : ''}: string`;
      const head = replaceOnce(f.base, LEAF, `{ a: number${inserted} }`);
      judge(f, head, `single-line tuple: ${inserted}`, optional, inserted);
    }
  }
}
