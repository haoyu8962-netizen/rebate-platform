// CT-06zzzzzt (FU-EACH-KIT-TABLE-ANNOTATED; orchestrator ruling D10-2148) rule-test kit. In-memory
// text fixtures only: no git, no process, no database, no port, no network.
//
// A modify_existing `.each` / `.for` block whose table is one name imported from a same-directory
// kit (`./<name>.ts`, CT-06zzzzi / CT-06zzzzzr) is expanded row by row also when the kit gives the
// name a top-level type annotation between the name and the `=`: `export const NAME: T[] = [ … ]`
// (after B2-02za's texts.ts `export const AMOUNT_VECTORS: T[] = [ … ]`). The annotation is skipped,
// whatever it holds (`=`, `=>`, `<…>`, `[…]`, `(…)`, `{…}`); everything else is as before: rows
// that are not literal, a `let` / `var`, the result of a call, a kit of another directory, a kit
// that re-exports the name still cannot be expanded for certain. The expansion is the one of the
// same table without the annotation, row by row.
//
// This task adds no export: compareModifiedBlocks already takes `modules` (CT-06zzzzzr), through
// which the kit of each side is read; red-check and evidence-check share it (exportedTable).
// The guard reads the kit as text and checks no type: an annotation need not fit its rows.
import type {
  ImportedModules,
  ModifiedComparison,
} from '../../../../tools/guard/lib/test-blocks.ts';
import { compareModifiedBlocks } from '../../../../tools/guard/lib/test-blocks.ts';

/** Repository path → content on one side (a path that is not a key does not exist there). */
export type Tree = Record<string, string>;

export const DIR = 'test/spec/identity/zzannotated';
/** The compared rule-test file. */
export const FILE = `${DIR}/sms.int.test.ts`;
/** Its same-directory kit. */
export const KIT = `${DIR}/kit.ts`;
/** A test-support file in a sibling directory. */
export const OTHER_KIT = 'test/spec/identity/zzannotated-other/kit.ts';
/** A module the same-directory kit re-exports from. */
export const SECOND = `${DIR}/tables.ts`;

/** The rows of ACTIONS (string rows: `%s`) and of PAIRS (object rows: `$a`, `$b`). */
export const ACTIONS_ROWS = "'payout_account_change', 'phone_change'";
export const PAIRS_ROWS = "{ a: 1, b: 'card' }, { a: 2, b: 'bank' }";

export const S1 = '[AC-S#1] sends a login code';
export const ACTIONS_TITLE = '[AC-S#2] %s needs a bound phone';
export const PAIRS_TITLE = '[AC-S#3] $a pays by $b';
export const ACTIONS_NAMES = [
  '[AC-S#2] payout_account_change needs a bound phone',
  '[AC-S#2] phone_change needs a bound phone',
] as const;
export const PAIRS_NAMES = ['[AC-S#3] 1 pays by card', '[AC-S#3] 2 pays by bank'] as const;
/** Every declared row (the shared callbacks of both tables changed at the head). */
export const NAMES: readonly string[] = [...ACTIONS_NAMES, ...PAIRS_NAMES];

/** A kit table: `value` is `[<rows>]` unless given whole (a call). */
export type Table = {
  name: string;
  rows?: string;
  value?: string;
  asConst?: boolean;
  keyword?: 'const' | 'let' | 'var';
};

/**
 * The declaration of `t`: `export <keyword> <name>[: <annotation>] = <value>[ as const];` — without
 * `annotation`, the same declaration bare.
 */
export function decl(t: Table, annotation?: string): string {
  const typed = annotation === undefined ? '' : `: ${annotation}`;
  const value = t.value ?? `[${t.rows ?? ''}]`;
  const asConst = t.asConst === true ? ' as const' : '';
  return `export ${t.keyword ?? 'const'} ${t.name}${typed} = ${value}${asConst};`;
}

/** A kit: `before` lines, the table declarations, then a helper. */
export function kit(decls: readonly string[], before: readonly string[] = []): string {
  return [
    ...before,
    ...decls,
    '',
    'export function send(action: string, token?: string) {',
    '  return { action, token };',
    '}',
    '',
  ].join('\n');
}

export const KIT_IMPORT = "import { ACTIONS, PAIRS, send } from './kit.ts';";

/**
 * The rule-test file: a plain test, `it.each(ACTIONS)`, `it.each(PAIRS)`; at the head (`head`)
 * both shared callbacks send the step-up token.
 */
export function ruleFile(head: boolean, importLine: string = KIT_IMPORT): string {
  const token = head ? ", 'step-up'" : '';
  return [
    "import { expect, it } from 'vitest';",
    importLine,
    '',
    `it('${S1}', () => {`,
    "  expect(send('login').action).toBe('login');",
    '});',
    '',
    `it.each(ACTIONS)('${ACTIONS_TITLE}', (action) => {`,
    `  expect(send(action${token}).action).toBe(action);`,
    '});',
    '',
    `it.each(PAIRS)('${PAIRS_TITLE}', ({ a, b }) => {`,
    '  expect(a).toBeGreaterThan(0);',
    `  expect(send(b${token}).action).toBe(b);`,
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

/** compareModifiedBlocks on the rule file (base → head) declaring every row, over the trees. */
export function compare(base: Tree, head: Tree = base, importLine?: string): ModifiedComparison {
  return compareModifiedBlocks(
    ruleFile(false, importLine),
    ruleFile(true, importLine),
    NAMES,
    undefined,
    modules(base, head),
  );
}

/** A kit tree holding the ACTIONS and PAIRS declarations (and `before` lines). */
export function kitTree(actions: string, pairs: string, before: readonly string[] = []): Tree {
  return { [KIT]: kit([actions, pairs], before) };
}

/** The plain control: both tables declared without an annotation, as CT-06zzzzzr expands them. */
export const ACTIONS: Table = { name: 'ACTIONS', rows: ACTIONS_ROWS };
export const PAIRS: Table = { name: 'PAIRS', rows: PAIRS_ROWS };
export const PLAIN = kitTree(decl({ ...ACTIONS, asConst: true }), decl(PAIRS));
