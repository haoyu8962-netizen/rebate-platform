// CT-06zzzzzu (FU-EACH-KIT-TABLE-BIGINT; orchestrator ruling D10-2150) rule-test kit. In-memory
// text fixtures only: no git, no process, no database, no port, no network.
//
// After B2-02za's `test/spec/notification/balance-corrected/texts.ts`, whose
// `export const AMOUNT_VECTORS: [string, bigint, bigint, string, string][] = [ … ]` holds `990n`,
// `123_456n`, `-1234n`, `2_000_000n`: the rows of a same-directory kit table (exportedTable,
// CT-06zzzzi / CT-06zzzzzr / CT-06zzzzzt) are read as the rows of the same table written inline in
// the `.each` call (compareEachRows' reading): a BigInt literal (`990n`, `0n`, `-1234n`) is a
// literal there too, and the full name of every row is the one the inline table gives it, row by
// row. A number or BigInt literal written with `_` separators in the places the language allows
// (`1_000`, `1_000.5`, `123_456n`, `2_000_000n`) has the value without the `_` (the full names are
// those of the table written without them); the row's text (`raw`, the compared row text) stays
// the source as written. Inline tables read the separators alike. A `_` anywhere else (first,
// last, twice in a row, next to the point, to the `e`, in a radix prefix, before the `n`) is no
// literal, as before; so is a row that is a name, a call or a spread.
//
// This task adds no export: compareModifiedBlocks already takes `modules` (CT-06zzzzzr), through
// which the kit of each side is read; red-check and evidence-check share it (exportedTable).
import type {
  ImportedModules,
  ModifiedComparison,
} from '../../../../tools/guard/lib/test-blocks.ts';
import { compareModifiedBlocks } from '../../../../tools/guard/lib/test-blocks.ts';

/** Repository path → content on one side (a path that is not a key does not exist there). */
export type Tree = Record<string, string>;

export const DIR = 'test/spec/notification/zzbigint';
/** The compared rule-test file. */
export const FILE = `${DIR}/texts.int.test.ts`;
/** Its same-directory kit. */
export const KIT = `${DIR}/kit.ts`;

export const S1 = '[AC-V#1] sends the correction notice';
/** VECTORS: tuple rows `[label, before, after]`. */
export const VECTORS_TITLE = '[AC-V#2] %s corrects %s to %s';
/** AMOUNTS: object rows `{ label, amount }`. */
export const AMOUNTS_TITLE = '[AC-V#3] $label pays $amount';

/** The full name Vitest gives a VECTORS row whose items print as given. */
export function vectorName(label: string, before: string, after: string): string {
  return `[AC-V#2] ${label} corrects ${before} to ${after}`;
}

/** The full name Vitest gives an AMOUNTS row whose amount prints as given. */
export function amountName(label: string, amount: string): string {
  return `[AC-V#3] ${label} pays ${amount}`;
}

/** The two tables, each as the source text of its rows (one string per row, as written). */
export type Tables = { vectors: readonly string[]; amounts: readonly string[] };

/** BigInt rows, positive, negative and zero, next to a number (no separator). */
export const BIG: Tables = {
  vectors: ["['raise', 990n, 1234n]", "['lower', -1234n, 0n]", "['mixed', 7, -1n]"],
  amounts: [
    "{ label: 'credit', amount: 990n }",
    "{ label: 'debit', amount: -1234n }",
    "{ label: 'none', amount: 0n }",
  ],
};
export const BIG_NAMES: readonly string[] = [
  vectorName('raise', '990n', '1234n'),
  vectorName('lower', '-1234n', '0n'),
  vectorName('mixed', '7', '-1n'),
  amountName('credit', '990n'),
  amountName('debit', '-1234n'),
  amountName('none', '0n'),
];

/** Number and BigInt literals with `_` separators (B2-02za's `123_456n`, `2_000_000n` …). */
export const SEP: Tables = {
  vectors: [
    "['raise', 123_456n, 2_000_000n]",
    "['lower', -1_234n, 1_000]",
    "['half', 1_000.5, -2_000_000n]",
  ],
  amounts: [
    "{ label: 'credit', amount: 123_456n }",
    "{ label: 'debit', amount: -2_000_000n }",
    "{ label: 'part', amount: 1_000.5 }",
  ],
};
/** The same values written without separators. */
export const PLAIN: Tables = {
  vectors: [
    "['raise', 123456n, 2000000n]",
    "['lower', -1234n, 1000]",
    "['half', 1000.5, -2000000n]",
  ],
  amounts: [
    "{ label: 'credit', amount: 123456n }",
    "{ label: 'debit', amount: -2000000n }",
    "{ label: 'part', amount: 1000.5 }",
  ],
};
/** The full names of SEP and of PLAIN alike (the values without the `_`). */
export const SEP_NAMES: readonly string[] = [
  vectorName('raise', '123456n', '2000000n'),
  vectorName('lower', '-1234n', '1000'),
  vectorName('half', '1000.5', '-2000000n'),
  amountName('credit', '123456n'),
  amountName('debit', '-2000000n'),
  amountName('part', '1000.5'),
];
/** The VECTORS names of SEP_NAMES (its first three). */
export const SEP_VECTOR_NAMES: readonly string[] = SEP_NAMES.slice(0, 3);
/** The AMOUNTS names of SEP_NAMES (its last three). */
export const SEP_AMOUNT_NAMES: readonly string[] = SEP_NAMES.slice(3);

/**
 * The text compareModifiedBlocks appends to a found row's block (`\n// .each row <k> of <n>:
 * <raw>`), for every row of `t`, VECTORS first: what each declared name's `before` / `after` ends
 * with when it is that row.
 */
export function rowTags(t: Tables): string[] {
  const tag = (rows: readonly string[]) =>
    rows.map((r, k) => `\n// .each row ${k + 1} of ${rows.length}: ${r}`);
  return [...tag(t.vectors), ...tag(t.amounts)];
}

/** How a kit declares a table: a type annotation between the name and the `=`, `as const`. */
export type Form = { annotation?: string; asConst?: boolean };

/** The declaration `export const <name>[: <annotation>] = [<rows>][ as const];`. */
export function decl(name: string, rows: readonly string[], form: Form = {}): string {
  const typed = form.annotation === undefined ? '' : `: ${form.annotation}`;
  const asConst = form.asConst === true ? ' as const' : '';
  return `export const ${name}${typed} = [${rows.join(', ')}]${asConst};`;
}

/** The declaration forms every kit table must expand alike in. */
export const FORMS: readonly (readonly [string, Form, Form])[] = [
  ['bare', {}, {}],
  ['as const', { asConst: true }, { asConst: true }],
  [
    'annotated as B2-02za annotates AMOUNT_VECTORS',
    { annotation: '[string, bigint | number, bigint | number][]' },
    { annotation: 'Array<{ label: string; amount: bigint | number }>' },
  ],
];

/** A kit: `before` lines, the table declarations, then a helper. */
export function kit(decls: readonly string[], before: readonly string[] = []): string {
  return [
    ...before,
    ...decls,
    '',
    'export function send(kind: string, token?: string) {',
    '  return { kind, token };',
    '}',
    '',
  ].join('\n');
}

/** A kit tree declaring VECTORS and AMOUNTS of `t` (in the forms given, after `before`). */
export function kitTree(
  t: Tables,
  vectors: Form = {},
  amounts: Form = {},
  before: readonly string[] = [],
): Tree {
  return {
    [KIT]: kit([decl('VECTORS', t.vectors, vectors), decl('AMOUNTS', t.amounts, amounts)], before),
  };
}

/** A kit tree holding the helper only (the rule file's tables inline). */
export const HELPER_ONLY: Tree = { [KIT]: kit([]) };

/**
 * The rule-test file: a plain test, `it.each(<VECTORS>)`, `it.each(<AMOUNTS>)` — the names
 * imported from ./kit.ts, or with `inline` the same tables written in the calls. At the head
 * (`head`) both shared callbacks send a token.
 */
export function ruleFile(head: boolean, inline?: Tables): string {
  const token = head ? ", 'corrected'" : '';
  const vectors = inline === undefined ? 'VECTORS' : `[${inline.vectors.join(', ')}]`;
  const amounts = inline === undefined ? 'AMOUNTS' : `[${inline.amounts.join(', ')}]`;
  const importLine =
    inline === undefined
      ? "import { AMOUNTS, VECTORS, send } from './kit.ts';"
      : "import { send } from './kit.ts';";
  return [
    "import { expect, it } from 'vitest';",
    importLine,
    '',
    `it('${S1}', () => {`,
    "  expect(send('notice').kind).toBe('notice');",
    '});',
    '',
    `it.each(${vectors})('${VECTORS_TITLE}', (label, before, after) => {`,
    `  expect(send(label${token}).kind).toBe(label);`,
    '  expect([before, after]).toHaveLength(2);',
    '});',
    '',
    `it.each(${amounts})('${AMOUNTS_TITLE}', ({ label, amount }) => {`,
    `  expect(send(label${token}).kind).toBe(label);`,
    '  expect(amount).toBeDefined();',
    '});',
    '',
  ].join('\n');
}

/** The reader of the base and the head trees. */
export function modules(base: Tree, head: Tree = base): ImportedModules {
  return {
    file: FILE,
    base: (p) => base[p] ?? null,
    head: (p) => head[p] ?? null,
  };
}

/**
 * compareModifiedBlocks on the rule file reading both tables from the kit (base → head; the
 * callbacks changed at the head unless `callbacks` is false), declaring `names`.
 */
export function compareKit(
  names: readonly string[],
  base: Tree,
  head: Tree = base,
  callbacks = true,
): ModifiedComparison {
  return compareModifiedBlocks(
    ruleFile(false),
    ruleFile(callbacks),
    names,
    undefined,
    modules(base, head),
  );
}

/**
 * compareModifiedBlocks on the rule file holding both tables inline (base → head; the callbacks
 * changed at the head unless `callbacks` is false), declaring `names`.
 */
export function compareInline(
  names: readonly string[],
  base: Tables,
  head: Tables = base,
  callbacks = true,
): ModifiedComparison {
  return compareModifiedBlocks(
    ruleFile(false, base),
    ruleFile(callbacks, head),
    names,
    undefined,
    modules(HELPER_ONLY),
  );
}
