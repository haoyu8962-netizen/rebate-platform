// CT-06zzzzzw (D10-2168 ②; FU-SUPPORT-TOKENS-ANGLE-COMMA-MEMBER-START,
// FU-SUPPORT-TOKENS-QMARK-ANGLE-MEMBER-END, FU-SUPPORT-TOKENS-INSERTED-BRACE-INTERIOR). Each
// top-level case holds insertions the classifier before this task lets through (illegal
// TypeScript: none is an optional member appended to the type) plus controls the change must keep
// (legal optional members). Every refusal is pinned in a type alias `type T = { … }` and in an
// interface body; only "refused" and the line of the inserted member are pinned, never the
// wording of a problem.
import { afterAll, it } from 'vitest';
import { SLOW, cleanup, fixture, shapes } from './kit.ts';

afterAll(cleanup);

/** The optional member A and B insert, on a line of its own. */
const MEMBER = 'b?: string';

/** The body lines of a member `a`, where inside it and after its end the member is inserted. */
type Shape = {
  tag: string;
  lines: readonly string[];
  /** Text ending a line inside the member (inserting there is refused). */
  inside: readonly string[];
  /** Text ending the member's last line (inserting there stays allowed). */
  end: string;
};

/** Each refused insertion inside the member and the allowed one after it, alias and interface. */
function judgeShapes(name: string, list: readonly Shape[], extra: readonly Shape[] = []): void {
  const all = [...list, ...extra];
  const judge = fixture(
    name,
    all.flatMap((s) => shapes(s.tag, s.lines)),
  );
  for (const { tag, lines, inside, end } of all) {
    for (const row of shapes(tag, lines)) {
      for (const after of inside) judge([row, after, MEMBER], false);
      judge([row, end, MEMBER], true);
    }
  }
}

it(
  '[AC-CT-06zzzzzw#1] a member inserted after a comma inside the angles of type arguments is refused, in a type alias and an interface body; after the member ends it stays allowed',
  () => {
    judgeShapes('angle-comma', [
      // `a: Map<K, keyof V>` over three lines: after `Map<K,` and between `keyof` and `V`.
      {
        tag: 'Map',
        lines: ['a: Map<K,', '  keyof', '  V>'],
        inside: ['Map<K,', 'keyof'],
        end: 'V>',
      },
      { tag: 'Rec', lines: ['a: Record<K,', '  V>'], inside: ['Record<K,'], end: 'V>' },
      // Nested type arguments: the comma of the inner Map, the member ends at `>>`.
      { tag: 'Nest', lines: ['a: Promise<Map<K,', '  V>>'], inside: ['Map<K,'], end: 'V>>' },
    ]);
  },
  SLOW,
);

it(
  '[AC-CT-06zzzzzw#2] a member inserted after the ? of a conditional type is refused, in a type alias and an interface body; after the member ends, and after an untyped optional member a?, it stays allowed',
  () => {
    judgeShapes(
      'conditional',
      [{ tag: 'Cond', lines: ['a: X extends Y ?', '  Z : W'], inside: ['?'], end: 'Z : W' }],
      // Control only: `{ a? }` ends at its `?` (allowed before this task, kept).
      [{ tag: 'Opt', lines: ['a?'], inside: [], end: 'a?' }],
    );
  },
  SLOW,
);

it(
  '[AC-CT-06zzzzzw#3] a member inserted after the type parameters <U> of a generic function type is refused, in a type alias and an interface body; after the member ends it stays allowed',
  () => {
    judgeShapes('generic-function', [
      { tag: 'Gen', lines: ['a: <U>', '  (x: U) => U'], inside: ['<U>'], end: '=> U' },
    ]);
  },
  SLOW,
);

it(
  '[AC-CT-06zzzzzw#4] an inserted optional member whose type is a new object type is refused when that object type breaks the member syntax, in a type alias and an interface body; legal object types stay allowed',
  () => {
    const rows = shapes('Obj', ['a: number;']);
    const judge = fixture('brace-interior', rows);
    const refused = [
      'b?: { x: void: string }',
      'b?: { x;: number }',
      'b?: { x,: number }',
      'b?: { x:?: number }',
    ];
    const allowed = [
      'b?: { x: number }',
      'b?: { x?: number; y: string }',
      'b?: { x: number, }',
      'b?: { readonly x: number }',
      'b?: { [k: string]: number }',
      'b?: { m(): void }',
      'b?: { (x: number): string }',
      'b?: { x: { y: number } }',
      'b?: {}',
      // Over several lines.
      'b?: {\n    x: number;\n  }',
    ];
    for (const row of rows) {
      for (const inserted of refused) judge([row, 'a: number;', inserted], false);
      for (const inserted of allowed) judge([row, 'a: number;', inserted], true);
    }
  },
  SLOW,
);
