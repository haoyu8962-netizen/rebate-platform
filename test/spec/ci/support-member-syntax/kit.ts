// CT-06zzzzzw (D10-2168 ②): source fixtures go through the public evidence gate of
// ../modify-existing-support/kit.ts, after ../support-p3-stray-punct/kit.ts; their code is gate
// input, never executed, and no production parser or classification helper computes an expected
// result. Expected decisions are the support whitelist's P3 (an optional member appended to an
// interface body or a type literal) as the three FUs merged here tighten it, not the classifier's
// current output: only "refused" and the line of the inserted member are pinned.
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

const FILE = 'test/spec/identity/step-up-member-syntax/kit.ts';
/** Comment lines first: every edited line is past them. */
const PAD = 18;
/** Type names the rows use (no lower-case name an insertion uses: x, y, k, m, b). */
const HEADER = [
  'type K = string;',
  'type V = number;',
  'type X = string;',
  'type Y = string;',
  'type Z = number;',
  'type W = boolean;',
];

/**
 * One insertion from the base: in the base row `row` (found once in the base), right after the
 * text `after` (found once in the row, the end of a line), a line break and the line(s)
 * `inserted`, indented by two spaces.
 */
export type Insert = readonly [row: string, after: string, inserted: string];

/** Allowed with no problem, or refused by a problem naming the (one) inserted line. */
export type Judge = (insert: Insert, allowed: boolean) => void;

/** 1-based number of the one line of `text` whose trimmed text is `line`. */
export function insertedLine(text: string, line: string): number {
  const found = text.split('\n').flatMap((l, i) => (l.trim() === line ? [i + 1] : []));
  if (found.length !== 1) throw new Error(`fixture: line "${line}" found ${found.length} times`);
  return found[0] as number;
}

/**
 * The type alias `type T<tag> = { … };` and the interface `interface I<tag> { … }`, each with
 * the body `lines` (indented by two spaces).
 */
export function shapes(tag: string, lines: readonly string[]): [alias: string, body: string] {
  const inner = lines.map((l) => `  ${l}`).join('\n');
  return [`type T${tag} = {\n${inner}\n};`, `interface I${tag} {\n${inner}\n}`];
}

/** Each insertion is independent, from the same base, with valid file-level support evidence. */
export function fixture(name: string, rows: readonly string[]): Judge {
  const base = [
    ...Array.from({ length: PAD }, () => '// CT-06zzzzzw fixture padding'),
    ...HEADER,
    ...rows,
    '',
  ].join('\n');
  const text = ledger([support(FILE)], {
    testPaths: ['test/spec/identity/step-up-member-syntax-new/**'],
  });
  expect(refusal(text), 'valid support ledger').toBe('');
  const repo = makeRepo(`member-syntax-${name}`, { [FILE]: base });
  const trustedDir = trusted(`member-syntax-${name}`, text);

  return ([row, after, inserted], allowed) => {
    const head = replaceOnce(base, row, replaceOnce(row, after, `${after}\n  ${inserted}`));
    const sha = branch(repo, 'member-syntax', { [FILE]: head }, [supportRecord(FILE, base, head)]);
    const report = check(repo, sha, trustedDir);
    const why = `${name}: ${row}\n  after ${JSON.stringify(after)} inserted ${JSON.stringify(inserted)}\n${report.problems.join('\n')}`;
    // Continue through the controls even when a regression fails on the old classifier.
    expect.soft(report.ok, why).toBe(allowed);
    if (allowed) {
      expect.soft(report.problems, why).toEqual([]);
    } else {
      if (inserted.includes('\n')) throw new Error('fixture: a refused insertion is one line');
      const line = insertedLine(head, inserted);
      expect(line, why).toBeGreaterThan(PAD + HEADER.length);
      expect.soft(lineProblem(report, FILE, [line]), why).toBeDefined();
    }
  };
}
