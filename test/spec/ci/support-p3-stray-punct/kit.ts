// CT-06zzzzzp (D10-2007 / D10-2015): source fixtures go through the public evidence gate of
// ../modify-existing-support/kit.ts; their code is gate input, never executed, and no production
// parser or classification helper computes an expected result. Expected decisions are the P1–P4
// rules of the support whitelist as D10-2007 tightens them, not the classifier's current output.
import { expect } from 'vitest';
import {
  branch,
  check,
  ledger,
  lineProblem,
  makeRepo,
  refusal,
  replaceOnce,
  support,
  supportRecord,
  trusted,
} from '../modify-existing-support/kit.ts';

export { SLOW, cleanup } from '../modify-existing-support/kit.ts';

const FILE = 'test/spec/identity/step-up-p3-stray/kit.ts';
/** Comment lines first: every edited line is past this one. */
const PAD = 18;

/** One edit from the base: in the base line(s) `row`, the text `from` (once in it) becomes `to`. */
export type Edit = readonly [row: string, from: string, to: string];
/** An edit and the trimmed text of the line it inserts (the line a refusal must name). */
export type Case = readonly [edit: Edit, inserted: string];

export type Fixture = {
  /** Allowed with no problem, or refused by a problem naming the line `inserted`. */
  judge: (edit: Edit, allowed: boolean, inserted: string) => void;
  /** The gate's decision on one edit, with no expectation of its own. */
  decide: (edit: Edit) => { ok: boolean; why: string };
};

/** 1-based number of the one line of `text` whose trimmed text is `line`. */
export function insertedLine(text: string, line: string): number {
  const found = text.split('\n').flatMap((l, i) => (l.trim() === line ? [i + 1] : []));
  if (found.length !== 1) throw new Error(`fixture: line "${line}" found ${found.length} times`);
  return found[0] as number;
}

/** Each edit is independent, from the same base, with valid file-level support evidence. */
export function fixture(name: string, rows: readonly string[]): Fixture {
  const base = [
    ...Array.from({ length: PAD }, () => '// CT-06zzzzzp fixture padding'),
    'declare const raw: never;',
    'declare const cond: boolean;',
    'declare function ping(): void;',
    'let dup = 1;',
    ...rows,
    '',
  ].join('\n');
  const text = ledger([support(FILE)], {
    testPaths: ['test/spec/identity/step-up-p3-stray-new/**'],
  });
  expect(refusal(text), 'valid support ledger').toBe('');
  const repo = makeRepo(`p3-stray-${name}`, { [FILE]: base });
  const trustedDir = trusted(`p3-stray-${name}`, text);

  const run = (edit: Edit) => {
    const [row, from, to] = edit;
    const head = replaceOnce(base, row, replaceOnce(row, from, to));
    expect(head, `${name}: ${from}`).not.toBe(base);
    const sha = branch(repo, 'p3-stray', { [FILE]: head }, [supportRecord(FILE, base, head)]);
    const report = check(repo, sha, trustedDir);
    const why = `${name}: ${row}\n  ${JSON.stringify(from)} -> ${JSON.stringify(to)}\n${report.problems.join('\n')}`;
    return { head, report, why };
  };

  return {
    judge: (edit, allowed, inserted) => {
      const { head, report, why } = run(edit);
      // Continue through the controls even when a regression fails on the old classifier.
      expect.soft(report.ok, why).toBe(allowed);
      if (allowed) {
        expect.soft(report.problems, why).toEqual([]);
      } else {
        const line = insertedLine(head, inserted);
        expect(line, why).toBeGreaterThan(PAD);
        expect.soft(lineProblem(report, FILE, [line]), why).toBeDefined();
      }
    },
    decide: (edit) => {
      const { report, why } = run(edit);
      return { ok: report.ok, why };
    },
  };
}

function split(annotated: string): [name: string, type: string] {
  const at = annotated.indexOf(': ');
  if (at < 0) throw new Error(`fixture: "${annotated}" holds no annotation`);
  return [annotated.slice(0, at), annotated.slice(at + 2)];
}

/**
 * A1 (illegal TypeScript): a lone `;` / `,` inserted between a member's name and its colon,
 * `{ a;: number }` / `{ a,: number }`, on a line of its own.
 */
export function straySeparators(row: string, member: string): Case[] {
  const [name, type] = split(member);
  return [';', ','].map((separator): Case => [
    [row, member, `${name}\n${separator}\n: ${type}`],
    separator,
  ]);
}

/**
 * A2 (illegal TypeScript): `?:` or a second annotation inserted into the annotation `name: T`,
 * `x:?: T` / `x: void: T`. The inserted line comes before the kept `: T`, so whichever colon the
 * alignment keeps, the first inserted token stands on that line.
 */
export function strayAnnotations(row: string, annotated: string): Case[] {
  const [name, type] = split(annotated);
  const extra = type === 'void' ? 'string' : 'void';
  return [
    [[row, annotated, `${name}\n:?\n: ${type}`], ':?'],
    [[row, annotated, `${name}\n: ${extra}\n: ${type}`], `: ${extra}`],
  ];
}

/** Members appended to the object type `leaf` (`{ … }`), each on a line of its own. */
export function appended(row: string, leaf: string, optional: boolean): Case[] {
  return [';', ','].map((separator): Case => {
    const inserted = `${separator} b${optional ? '?' : ''}: string`;
    return [[row, leaf, replaceOnce(leaf, ' }', `\n${inserted}\n }`)], inserted];
  });
}

/** A3 (P4, legal TypeScript): a trailing `;` / `,` after the last member of `leaf`. */
export function trailingSeparators(row: string, leaf: string): Case[] {
  return [';', ','].map((separator): Case => [
    [row, leaf, replaceOnce(leaf, ' }', `\n${separator}\n }`)],
    separator,
  ]);
}
