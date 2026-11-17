// CT-06zzzzzp (D10-2007 / D10-2015 / D10-2016). Each top-level case holds regressions of the
// classifier before this task plus controls the change must keep. Expected decisions are the
// P1–P4 rules as D10-2007 tightens them, not the classifier's current output; only "refused" and
// the line of the inserted token are pinned, never the wording of a problem.
import { afterAll, expect, it } from 'vitest';
import {
  SLOW,
  appended,
  cleanup,
  fixture,
  strayAnnotations,
  straySeparators,
  trailingSeparators,
} from './kit.ts';

afterAll(cleanup);

const LEAF = '{ a: number }';
const MEMBER = 'a: number';

/**
 * The type positions of D10-2007 A, each holding the object type LEAF once; `annotations` are
 * further annotations of the row (a variable's, a parameter's, a return type), `members` further
 * member annotations (an interface body), `body` the interface body of a defaulted type parameter.
 */
const POSITIONS: readonly {
  row: string;
  annotations?: readonly string[];
  members?: readonly string[];
  body?: string;
}[] = [
  { row: 'type T1 = { a: number };' },
  { row: 'let v1: { a: number };', annotations: ['v1: { a: number }'] },
  { row: 'function p1(y: { a: number }) { void y; }', annotations: ['y: { a: number }'] },
  {
    row: 'interface I1 { m(x: { a: number }): void }',
    annotations: ['x: { a: number }', '): void'],
  },
  {
    row: 'class D1<U> { m(x: { a: number }): void; m(x: unknown) { void x; } }',
    annotations: ['x: { a: number }', '): void'],
  },
  { row: 'type F1 = () => { a: number };' },
  { row: 'type R1<T> = T extends () => { a: number } ? T : never;' },
  {
    row: 'interface J1<T = { a: number }> { value: T; }',
    members: ['value: T'],
    body: '{ value: T; }',
  },
];
const ROWS = POSITIONS.map((p) => p.row);

it(
  '[AC-CT-06zzzzzp#1] a lone separator between a member name and its colon is refused in every type position, while optional members and trailing separators stay allowed',
  () => {
    const judge = fixture('separators', ROWS).judge;
    for (const { row, members = [], body } of POSITIONS) {
      for (const member of [MEMBER, ...members]) {
        for (const [edit, inserted] of straySeparators(row, member)) judge(edit, false, inserted);
      }
      // Controls (A3): the same position, legal TypeScript.
      for (const [edit, inserted] of appended(row, LEAF, true)) judge(edit, true, inserted);
      for (const [edit, inserted] of trailingSeparators(row, LEAF)) judge(edit, true, inserted);
      if (body !== undefined) {
        const inserted = 'b?: string;';
        judge([row, body, replaceTail(body, `\n${inserted}\n }`)], true, inserted);
      }
    }
  },
  SLOW,
);

it(
  '[AC-CT-06zzzzzp#2] ?: or a second annotation inserted into an annotation is refused in every type position, while optional members stay allowed',
  () => {
    const judge = fixture('annotations', ROWS).judge;
    for (const { row, annotations = [], members = [] } of POSITIONS) {
      for (const annotated of [MEMBER, ...members, ...annotations]) {
        for (const [edit, inserted] of strayAnnotations(row, annotated)) {
          judge(edit, false, inserted);
        }
      }
      for (const [edit, inserted] of appended(row, LEAF, true)) judge(edit, true, inserted);
    }
  },
  SLOW,
);

it(
  '[AC-CT-06zzzzzp#3] the object type of a class field annotation permits only optional member additions',
  () => {
    const rows = ['class C1 { x: { a: number } }', 'class C2 { y: { a: number }; }'];
    const judge = fixture('class-field', rows).judge;
    for (const row of rows) {
      for (const [edit, inserted] of appended(row, LEAF, false)) judge(edit, false, inserted);
      for (const [edit, inserted] of appended(row, LEAF, true)) judge(edit, true, inserted);
    }
  },
  SLOW,
);

it(
  '[AC-CT-06zzzzzp#4] an optional method signature parameter type permits only optional members; unannotated m?(x) / m(x) keep their reading',
  () => {
    const annotated = 'type M1 = { m?(x: { a: number }): void };';
    // Unannotated signatures cannot be told from a block's code: whatever the gate decides on
    // an edit there, it decides the same on the same edit of the same tokens in a block.
    const twins: readonly (readonly [type: string, block: string])[] = [
      ['type M2 = { m?(x): string };', 'if (cond) { m?(x): string }'],
      ['type M3 = { m(x) };', 'if (cond) { m(x) }'],
    ];
    const f = fixture('optional-method', [annotated, ...twins.flat()]);
    for (const [edit, inserted] of appended(annotated, LEAF, false)) f.judge(edit, false, inserted);
    for (const [edit, inserted] of appended(annotated, LEAF, true)) f.judge(edit, true, inserted);
    for (const [type, block] of twins) {
      for (const to of ['(x\n: string\n)', '(x\n, y?: string\n)']) {
        const asType = f.decide([type, '(x)', to]);
        const asBlock = f.decide([block, '(x)', to]);
        expect
          .soft(asType.ok, `${asType.why}\n--- block twin ---\n${asBlock.why}`)
          .toBe(asBlock.ok);
      }
    }
  },
  SLOW,
);

it(
  '[AC-CT-06zzzzzp#5] a function body or if block right after an interface or enum is judged as without that declaration',
  () => {
    // Each declaration-led row stands after a statement ending in `;`, so only its own
    // declaration precedes the body; the controls have none.
    const led = [
      'interface X1 { a: number } function g1() { ping(); }',
      'interface X2 { a: number }\nfunction g2() { ping(); }',
      'interface X3 { a: number }\nif (c3) { ping(); }',
      'interface X4 { a: number } if (c4) { ping(); }',
      'enum E5 { A }\nfunction g5() { ping(); }',
      'enum E6 { A } if (c6) { ping(); }',
    ];
    const controls = ['function g0() { ping(); }', 'if (c0) { ping(); }'];
    const rows = [
      'declare const c0: boolean;',
      'declare const c3: boolean;',
      'declare const c4: boolean;',
      'declare const c6: boolean;',
      ...[...led, ...controls].flatMap((row) => [row, 'ping();']),
    ];
    const judge = fixture('header-keyword', rows).judge;
    const body = '{ ping(); }';
    for (const row of [...led, ...controls]) {
      // A call statement between existing statements (P1).
      judge([row, body, '{ ping();\nping();\n }'], true, 'ping();');
      // A required-member-shaped label statement is no P1 statement.
      judge([row, body, '{ ping();\nb: 1;\n }'], false, 'b: 1;');
    }
  },
  SLOW,
);

/** `body` (`{ … }`) with its closing ` }` replaced by `tail`. */
function replaceTail(body: string, tail: string): string {
  if (!body.endsWith(' }')) throw new Error(`fixture: "${body}" does not end in " }"`);
  return `${body.slice(0, -2)}${tail}`;
}
