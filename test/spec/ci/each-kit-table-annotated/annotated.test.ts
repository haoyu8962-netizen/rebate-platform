// CT-06zzzzzt (D10-2148): a same-directory kit table with a top-level type annotation between its
// name and the `=` (`export const NAME: T[] = [ … ]`) is expanded row by row exactly as the same
// table without the annotation; every other condition of CT-06zzzzi / CT-06zzzzzr holds as before
// (a non-literal row, a `let` / `var`, the result of a call, a kit of another directory, a kit that
// re-exports the name: the rows still cannot be expanded for certain). See ./kit.ts.
import { expect, it } from 'vitest';
import type { ModifiedComparison } from '../../../../tools/guard/lib/test-blocks.ts';
import {
  ACTIONS,
  ACTIONS_NAMES,
  ACTIONS_ROWS,
  KIT,
  NAMES,
  OTHER_KIT,
  PAIRS,
  PAIRS_NAMES,
  PLAIN,
  SECOND,
  type Table,
  type Tree,
  compare,
  decl,
  kit,
  kitTree,
} from './kit.ts';

/** Type declarations a kit may hold before its tables (the guard checks no type). */
const TYPES = [
  "type Action = 'payout_account_change' | 'phone_change';",
  'type Pair = { a: number; b: string };',
  'type Foo<T = string> = T;',
] as const;

/** Every name of `names` is found (its row expanded) and changed; else the reason, shown. */
const expanded = (r: ModifiedComparison, names: readonly string[], label: string): void => {
  expect(r.ok, `${label}: ${r.ok ? '' : r.reason}`).toBe(true);
  if (!r.ok) return;
  for (const name of names) {
    const b = r.blocks.find((x) => x.test === name);
    expect(b === undefined ? 'missing' : b.found ? 'found' : b.reason, `${label}: ${name}`).toBe(
      'found',
    );
    if (b?.found === true) expect(b.changed, `${label}: ${name}`).toBe(true);
  }
};

/** Every name of `names` is not found, for a reason matching `why`. */
const refused = (
  r: ModifiedComparison,
  names: readonly string[],
  why: RegExp,
  label: string,
): void => {
  expect(r.ok, `${label}: ${r.ok ? '' : r.reason}`).toBe(true);
  if (!r.ok) return;
  for (const name of names) {
    const b = r.blocks.find((x) => x.test === name);
    expect(b?.found, `${label}: ${name}`).toBe(false);
    if (b !== undefined && !b.found) expect(b.reason, `${label}: ${name}`).toMatch(why);
  }
};

/**
 * ACTIONS and PAIRS annotated as given expand row by row, and the comparison is the one of the same
 * kit without the two annotations (the control, expanded as CT-06zzzzzr expands it).
 */
const sameAsBare = (
  label: string,
  actions: readonly [Table, string],
  pairs: readonly [Table, string],
  before: readonly string[] = TYPES,
): void => {
  const plain = compare(kitTree(decl(actions[0]), decl(pairs[0]), before));
  expanded(plain, NAMES, `${label} (without the annotations)`);
  const typed = compare(kitTree(decl(actions[0], actions[1]), decl(pairs[0], pairs[1]), before));
  expanded(typed, NAMES, label);
  expect(typed, label).toEqual(plain);
};

const CANNOT = /cannot be expanded for certain/;

/** PAIRS annotated and literal: the rows that must expand next to a refused ACTIONS. */
const PAIRS_TYPED = decl(PAIRS, 'readonly Pair[]');

/** ACTIONS refused for `why`, PAIRS (annotated, literal) expanded, in the same comparison. */
const refusedNextToTyped = (label: string, base: Tree, importLine?: string): void => {
  const r = compare(base, base, importLine);
  refused(r, ACTIONS_NAMES, CANNOT, label);
  expanded(r, PAIRS_NAMES, `${label} (PAIRS)`);
};

it('[CT-06zzzzzt#1] T[], readonly T[] and Array<T> between the name and the `=`: the table expands row by row, as the same table without the annotation', () => {
  // The control of CT-06zzzzzr: no annotation at all.
  expanded(compare(PLAIN), NAMES, 'no annotation');
  sameAsBare('T[]', [ACTIONS, 'Action[]'], [PAIRS, 'Pair[]']);
  sameAsBare(
    'string[] / object type[]',
    [ACTIONS, 'string[]'],
    [PAIRS, '{ a: number; b: string }[]'],
  );
  sameAsBare('readonly T[]', [ACTIONS, 'readonly Action[]'], [PAIRS, 'readonly Pair[]']);
  sameAsBare('Array<T>', [ACTIONS, 'Array<Action>'], [PAIRS, 'Array<Pair>']);
});

it('[CT-06zzzzzt#2] ReadonlyArray<{ a: number; b: string }> (on one line or over several) between the name and the `=`: the table expands as without it', () => {
  sameAsBare(
    'ReadonlyArray<…>',
    [ACTIONS, 'ReadonlyArray<string>'],
    [PAIRS, 'ReadonlyArray<{ a: number; b: string }>'],
  );
  sameAsBare(
    'ReadonlyArray<{ … }> over several lines',
    [ACTIONS, 'ReadonlyArray<\n  Action\n>'],
    [PAIRS, 'ReadonlyArray<{\n  a: number;\n  b: string;\n}>'],
  );
});

it('[CT-06zzzzzt#3] an annotation together with `as const`: the table expands as the same `as const` table without the annotation', () => {
  sameAsBare(
    'readonly T[] … as const',
    [{ ...ACTIONS, asConst: true }, 'readonly Action[]'],
    [{ ...PAIRS, asConst: true }, 'readonly Pair[]'],
  );
  sameAsBare(
    'ReadonlyArray<{ … }> … as const',
    [{ ...ACTIONS, asConst: true }, "ReadonlyArray<'payout_account_change' | 'phone_change'>"],
    [{ ...PAIRS, asConst: true }, 'ReadonlyArray<{ readonly a: number; readonly b: string }>'],
  );
  sameAsBare(
    'readonly (literal union)[] … as const, Array<T> without',
    [{ ...ACTIONS, asConst: true }, "readonly ('payout_account_change' | 'phone_change')[]"],
    [PAIRS, 'Array<Pair>'],
  );
});

it('[CT-06zzzzzt#4] an `=` inside the annotation does not end it: Record<string, (x: number) => string>[], Foo<T = string>[], a generic function type with a default type parameter', () => {
  sameAsBare(
    'Foo<T = string>[] / Record<string, (x: number) => string>[]',
    [ACTIONS, 'Foo<T = string>[]'],
    [PAIRS, 'Record<string, (x: number) => string>[]'],
  );
  sameAsBare(
    'Array<string | (<T = string>(x: T) => T)> / ReadonlyArray<{ …; f?: (x?: number) => void }>',
    [ACTIONS, 'Array<string | (<T = string>(x: T) => T)>'],
    [PAIRS, 'ReadonlyArray<{ a: number; b: string; f?: (x?: number) => void }>'],
  );
  sameAsBare(
    'the same with `as const`',
    [{ ...ACTIONS, asConst: true }, 'readonly Foo<T = string>[]'],
    [{ ...PAIRS, asConst: true }, 'readonly Record<string, (x: number) => string>[]'],
  );
});

it('[CT-06zzzzzt#5] brackets inside the annotation are not the table: a tuple type `[…]`, nested generics closing with `>>`', () => {
  sameAsBare(
    'tuple types',
    [{ ...ACTIONS, asConst: true }, "readonly ['payout_account_change', 'phone_change']"],
    [PAIRS, '[{ a: number; b: string }, { a: number; b: string }]'],
  );
  sameAsBare(
    'nested generics',
    [ACTIONS, 'Array<Extract<Action, string>>'],
    [PAIRS, 'ReadonlyArray<Readonly<Pair>>'],
  );
});

it('[CT-06zzzzzt#6] annotated but a row is not literal (a name, a call, a spread) or a method follows the literal: still cannot be expanded for certain', () => {
  const cases: [string, Tree][] = [
    [
      'a row that is a name',
      kitTree(
        decl(
          { name: 'ACTIONS', rows: "PAYOUT, 'phone_change'", asConst: true },
          'readonly Action[]',
        ),
        PAIRS_TYPED,
        [...TYPES, "const PAYOUT = 'payout_account_change';"],
      ),
    ],
    [
      'a row that is a call',
      kitTree(
        decl({ name: 'ACTIONS', rows: "payout(), 'phone_change'" }, 'Action[]'),
        PAIRS_TYPED,
        [...TYPES, "function payout(): Action {\n  return 'payout_account_change';\n}"],
      ),
    ],
    [
      'a spread row',
      kitTree(decl({ name: 'ACTIONS', rows: '...BOUND' }, 'readonly Action[]'), PAIRS_TYPED, [
        ...TYPES,
        `const BOUND = [${ACTIONS_ROWS}] as const;`,
      ]),
    ],
    [
      'a method called on the literal',
      kitTree(
        decl({ name: 'ACTIONS', value: `[${ACTIONS_ROWS}].slice()` }, 'string[]'),
        PAIRS_TYPED,
        TYPES,
      ),
    ],
  ];
  for (const [label, tree] of cases) refusedNextToTyped(label, tree);
});

it('[CT-06zzzzzt#7] annotated but a let, a var or the result of a call: still cannot be expanded for certain', () => {
  const cases: [string, Tree][] = [
    ['a let', kitTree(decl({ ...ACTIONS, keyword: 'let' }, 'string[]'), PAIRS_TYPED, TYPES)],
    ['a var', kitTree(decl({ ...ACTIONS, keyword: 'var' }, 'Action[]'), PAIRS_TYPED, TYPES)],
    [
      'the result of a call',
      kitTree(decl({ name: 'ACTIONS', value: 'actions()' }, 'readonly Action[]'), PAIRS_TYPED, [
        ...TYPES,
        `function actions() {\n  return [${ACTIONS_ROWS}] as const;\n}`,
      ]),
    ],
    [
      'the result of a call, an `=` in the annotation',
      kitTree(decl({ name: 'ACTIONS', value: 'actions()' }, 'Foo<T = string>[]'), PAIRS_TYPED, [
        ...TYPES,
        `function actions() {\n  return [${ACTIONS_ROWS}];\n}`,
      ]),
    ],
  ];
  for (const [label, tree] of cases) refusedNextToTyped(label, tree);
});

it('[CT-06zzzzzt#8] annotated but in a kit of another directory, or re-exported by the kit (export { … } from, export * from): still cannot be expanded for certain', () => {
  const typedActions = decl(ACTIONS, 'readonly Action[]');
  const second = [...TYPES, typedActions, ''].join('\n');
  // ACTIONS from a sibling directory's kit, PAIRS (and send) from the same-directory kit.
  refusedNextToTyped(
    'a kit of another directory',
    {
      [OTHER_KIT]: kit([typedActions], TYPES),
      [KIT]: kit([PAIRS_TYPED], TYPES),
    },
    "import { ACTIONS } from '../zzannotated-other/kit.ts';\nimport { PAIRS, send } from './kit.ts';",
  );
  refusedNextToTyped('export { ACTIONS } from a second module', {
    [KIT]: kit(["export { ACTIONS } from './tables.ts';", PAIRS_TYPED], TYPES),
    [SECOND]: second,
  });
  refusedNextToTyped('export * from a second module', {
    [KIT]: kit(["export * from './tables.ts';", PAIRS_TYPED], TYPES),
    [SECOND]: second,
  });
});

it('[CT-06zzzzzt#9] annotated tables, each side read from its own kit: a row added to the head kit makes its rows not apply; the other table, unchanged, still expands', () => {
  const base = kitTree(decl(ACTIONS, 'readonly Action[]'), PAIRS_TYPED, TYPES);
  const head = kitTree(
    decl({ name: 'ACTIONS', rows: `${ACTIONS_ROWS}, 'withdraw'` }, 'readonly Action[]'),
    PAIRS_TYPED,
    TYPES,
  );
  const r = compare(base, head);
  refused(r, ACTIONS_NAMES, /rows added or removed/, 'a row added at the head');
  expanded(r, PAIRS_NAMES, 'a row added at the head (PAIRS)');
});
