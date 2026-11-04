// Task ledger files `ops/tasks/<id>.yaml` (规划/11 §2.1; format: planning repo
// docs/templates/task-ledger.md). Shape validation only: cross-file rules (id prefix exists in
// 规划/05, impl != tester for funds, line cap, dependency state) live in tools/ops.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { valueChangeRefusal, valueSkeleton } from '../guard/lib/test-blocks.ts';
import { repoRoot } from './paths.ts';
import { parseYamlLite } from './yaml-lite.ts';

export type TaskFile = {
  id: string;
  repo: 'rebate-platform' | 'ios' | 'android' | 'harmony';
  title: string;
  type: 'impl' | 'contract' | 'migration' | 'deps' | 'test-change' | 'guard-change' | 'sync';
  refs: string[];
  refs_hash: Record<string, string>;
  /**
   * Contract tasks only: the 规划/04 sections the brief quotes (e.g. "2", "6.1"); optional,
   * [] when absent (owner decision 2026-10-02, ops/approvals.yaml id 17).
   */
  contract_sections: string[];
  deps: string[];
  paths: string[];
  /**
   * Where the rule-test author may write the task's rule tests (globs inside class 1 of the
   * protected paths); optional, [] when absent. The test phase of a task with a rule-test author
   * needs it (default split of 2026-10-05, ops/approvals.yaml id 19; 规划/11 §2.3 step 2).
   */
  test_paths: string[];
  /**
   * Codex implementation ledgers only (ops/approvals.yaml id 31): the generated or marker files
   * a Claude commit marked `Couli-Mechanical: contract-codegen` may change in the same pull
   * request (remove `x-implementation: planned` from the contract and regenerate). Never handed
   * to Codex and never part of `paths`; optional, [] when absent. Allowed values: the
   * `mechanical_paths` of tools/guard/codex-impl-tasks.json (task.ts check).
   */
  mechanical_paths: string[];
  /**
   * CT-06r: red-run exemptions the task declares for tests of a rule-test file that existed at
   * the base, whose block is unchanged, in a file that red-check would otherwise judge as a whole
   * only because it may read a test-support file (a fixture, helper or data file inside
   * test_paths) the task changed: such a test (a structural assertion that holds for the old
   * data too) cannot be shown red for a valid reason. Each entry names the file (inside
   * test_paths), the test's full name as the red report gives it and a reason of at least 10
   * characters; the rule-test reviewer confirms them in the evidence
   * (spec_test_review.red_exempt_confirmed, tools/ci/evidence-check.ts). Optional, [] when absent.
   * Read from the trusted root like test_paths, so a declaration goes through a ledger PR first.
   */
  red_exempt: RedExemptDeclaration[];
  /**
   * CT-06zzzc (orchestrator ruling D10-623, after F1-02zzzb): the rule-test files whose code
   * outside the tests the task changes (an import, a row group taken out of a top-level table, a
   * fixture's value) and for which the ledger's `red_exempt` declarations must still apply. Without
   * an entry such a file is judged as a whole and its declarations do not apply (CT-06r). Each
   * entry names the file (inside test_paths, existing at the base: tools/ops/task.ts) and a reason
   * of at least RED_EXEMPT_REASON_MIN characters; red-check lists the changed lines outside the
   * tests for the rule-test reviewer (spec_test_review.red_exempt_confirmed). Read from the trusted
   * root like red_exempt. Optional, [] when absent.
   */
  red_exempt_outside: RedExemptOutsideDeclaration[];
  /**
   * CT-06zxc (orchestrator ruling D10-347): literal renames the task makes inside rule-test files
   * that existed at the base (a queue job name 'freeze-expiry' → 'freeze_expiry' its frozen tests
   * must follow). red-check replaces every `from` by its `to` in the base content of such a file,
   * in ledger order, before comparing it with the head: what differs only by these renames counts
   * as unchanged (tools/guard/lib/red-check.ts). Literal strings only (no pattern), read from the
   * trusted root like red_exempt, so a rename goes through a ledger PR first. Optional, [] when
   * absent.
   */
  renames: RenameDeclaration[];
  /**
   * CT-06zxe (orchestrator ruling D10-371, after B2-15l): expected values the task changes inside
   * a top-level helper of a rule-test file that existed at the base (`diff_fen: AMOUNT` →
   * `diff_fen: -AMOUNT` in `onlyAnomaly`). red-check replaces `from` by `to` inside that helper of
   * the base (after the renames) and, when the code outside the tests is then the head's, needs
   * only the tests that call the helper red (tools/guard/lib/red-check.ts). Read from the trusted
   * root like renames. Optional, [] when absent.
   */
  expected_values: ExpectedValueDeclaration[];
  impl: 'codex' | 'claude';
  /**
   * Who writes the rule tests. `claude-independent` (owner decision 2026-10-21, ops/approvals.yaml
   * id 36): a fresh Claude context through tools/agent/claude-run.sh, when Codex is not available;
   * never the implementing context.
   */
  tester: 'codex' | 'claude' | 'claude-independent' | 'none';
  accept: string[];
  /**
   * `void` (D10-190, 2026-10-23): the task was cancelled — never implemented, no PR, no evidence.
   * It is not dispatched, not counted as done, and does not satisfy a dependency.
   */
  status: 'todo' | 'done' | 'void';
  pr: number | null;
};

/** One declared red-run exemption (CT-06r). */
export type RedExemptDeclaration = {
  /** The rule-test file, repository-relative, inside the task's test_paths. */
  file: string;
  /** The test's full name as the red reporter writes it (`describe > … > title`). */
  test: string;
  /** Why the test cannot be shown red (at least RED_EXEMPT_REASON_MIN characters). */
  reason: string;
};

/** One file whose changed code outside the tests the ledger declares (CT-06zzzc, D10-623). */
export type RedExemptOutsideDeclaration = {
  /** The rule-test file, repository-relative, inside the task's test_paths, existing at the base. */
  file: string;
  /** Why its code outside the tests changes (at least RED_EXEMPT_REASON_MIN characters). */
  reason: string;
};

/** One declared literal rename (CT-06zxc, D10-347): every `from` of a base becomes `to`. */
export type RenameDeclaration = {
  /** The string literal the base has, quotes included (RENAME_LITERAL; not a pattern). */
  from: string;
  /** The string literal it became, with the same quote, different from `from`. */
  to: string;
};

/**
 * One registered expected-value change (CT-06zxe, D10-371): in the top-level helper `helper` of
 * `file`, the one occurrence of `from` became `to`.
 */
export type ExpectedValueDeclaration = {
  /** The rule-test file, repository-relative, inside the task's test_paths (tools/ops/task.ts). */
  file: string;
  /** The name of a top-level function / const arrow function of that file. */
  helper: string;
  /** One line of the helper as at the base (after the renames), literal text, not a pattern. */
  from: string;
  /** What it became: the same value skeleton as `from` (EXPECTED_VALUE_SHAPE). */
  to: string;
};

/**
 * The most expected values a task may register (CT-06zxe). Like renames, the section is left out
 * of the task file's line limit (tools/ops/task.ts countedLines) and has its own, by entries.
 */
export const EXPECTED_VALUES_MAX = 20;

/** The longest `from` / `to` of an expected value (one line of a helper). */
export const EXPECTED_VALUE_LENGTH_MAX = 200;

/**
 * The shape of an expected-value change (CT-06zxe): `from` and `to` have the same value skeleton
 * (tools/guard/lib/test-blocks.ts valueSkeleton: number and string literals replaced by one
 * placeholder, unary minus signs dropped, whitespace and comments kept). Only a value may change
 * (`AMOUNT` → `-AMOUNT`, `500n` → `-500n`, `'open'` → `'closed'`): an assertion cannot be removed,
 * a call or a name cannot be swapped, the structure cannot change; a tagged template (sql`…`) is
 * not a value. The values that differ must stand as an object property value (`{ key: <value> }`)
 * of an expectation's object or the expected argument of an expect chain's matcher
 * (`expect(…).toBe(<value>)`), never inside a query call (`.where(`, `.selectFrom(`, `sql(` …), a
 * fixture's or a query's input object, a ternary branch, a type annotation, a non-matcher
 * `.toString(` (CT-06zxh) or a function body between the value and the matcher, called at once or
 * not (CT-06zxi, D10-388: `toEqual((() => { const input = { amount: 1 }; … })())`):
 * test-blocks.ts valueChangeRefusal, the same function red-check runs on
 * the whole helper, where a one-line fragment shows its context. What a literal means (an
 * expectation, or a query argument that makes the assertion vacuous) the shape cannot tell: the
 * affected tests must still be red on the old code, and the rule-test reviewer confirms every
 * entry (spec_test_review.expected_values_confirmed, tools/ci/evidence-check.ts).
 */
export const EXPECTED_VALUE_SHAPE =
  'the same value skeleton (only literals and unary minus signs may differ; a tagged template is not a literal)';

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * The most renames a task may declare (CT-06zxc). A rename is a whole ledger PR's worth of trust
 * (every frozen test it touches is compared after it), so a task names a handful; 20 is far above
 * the three of B1-03w and still readable by the rule-test reviewer. Like red_exempt, the section is
 * left out of the task file's line limit (tools/ops/task.ts countedLines; CT-06zxc review r1 S2-2),
 * so it has its own, by entries.
 */
export const RENAMES_MAX = 20;

/** The least a rename's string content (without its quotes) may hold (CT-06zxc review r1 S2-1). */
export const RENAME_CONTENT_MIN = 3;

/**
 * One quoted name literal (CT-06zxc reviews r1 / r2 S2-1): the same quote `'`, `"` or a backtick
 * at both ends and between them only name characters (RENAME_NAME_CHARS: letters, digits and
 * `_ . : / @ -`), at least RENAME_CONTENT_MIN of them. Code cannot be written into a rename (no
 * parenthesis, blank, operator, comma, quote, backslash or `${`): `')).toBe('` or `' + '` is
 * refused. What the shape cannot tell is the meaning of a real literal swapped for another
 * (`'foo'` → `'bar'` may change an expected value): that is caught by the rule-test reviewer, who
 * confirms every pair that hits, and every file it leaves out, in `renames_confirmed`
 * (tools/ci/evidence-check.ts). D10-379: the content holds at least one ASCII letter, so a number
 * (`'500'`, `'-500'`, `'1.5'`, a date) is never a rename: renaming `'500'` to `'-500'` in a frozen
 * money test would take it out of red-check; changed expected values go through D10-371 instead.
 */
export const RENAME_NAME_CHARS = 'A-Za-z0-9_.:/@-';
const RENAME_LITERAL = new RegExp(`^(['"\`])([${RENAME_NAME_CHARS}]*)\\1$`);

/** The least a red-exemption reason may say (CT-06r: a non-empty reason of ≥ 10 characters). */
export const RED_EXEMPT_REASON_MIN = 10;
/**
 * The most declarations a task may make (CT-06t): the section is left out of the task file's
 * line limit (tools/ops/task.ts countedLines), so it has its own, by entries.
 * 2026-10-24 编排裁定 D10-344：由 20 提到 50（B1-03w 改名冻结测试 40 条）；豁免仍须规则测试评审方在证据里确认。
 */
// CT-06zzzb (D10-620): raised from 50 to 150. The cap only bounds the task file's length (the section is
// not counted in the 40-line limit); every exemption is still checked one by one by the orchestrator and
// red-check still judges every test that is not exempt, so a higher cap does not weaken the red run.
// CT-06zzzc (D10-624): raised from 150 to 300, for the same reason as D10-620 (red_exempt_outside
// shares the cap).
export const RED_EXEMPT_MAX = 300;

export const TASK_REPOS = ['rebate-platform', 'ios', 'android', 'harmony'] as const;
export const TASK_TYPES = [
  'impl',
  'contract',
  'migration',
  'deps',
  'test-change',
  'guard-change',
  'sync',
] as const;
export const TASK_IMPLS = ['codex', 'claude'] as const;
export const TASK_TESTERS = ['codex', 'claude', 'claude-independent', 'none'] as const;
export const TASK_STATUSES = ['todo', 'done', 'void'] as const;

/** A section number of 规划/04 as written in its headings: "2", "6.1", "10.2". */
export const CONTRACT_SECTION_PATTERN = /^[1-9][0-9]*(\.[1-9][0-9]*)*$/;

/** Task ids become file names, branch names and run directories: 规划/05 ids plus a suffix. */
export const TASK_ID_PATTERN = /^[A-Z][A-Z0-9]*-[0-9]+[a-z]*$/;

const KNOWN_KEYS = new Set([
  'id',
  'repo',
  'title',
  'type',
  'refs',
  'refs_hash',
  'contract_sections',
  'deps',
  'paths',
  'test_paths',
  'mechanical_paths',
  'red_exempt',
  'red_exempt_outside',
  'renames',
  'expected_values',
  'impl',
  'tester',
  'accept',
  'status',
  'pr',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value);
}

function stringList(
  doc: Record<string, unknown>,
  key: string,
  problems: string[],
  opts: { nonEmpty: boolean },
): string[] {
  const value = doc[key];
  if (!Array.isArray(value)) {
    problems.push(`${key}: must be a list of strings`);
    return [];
  }
  const out: string[] = [];
  value.forEach((item, index) => {
    if (typeof item !== 'string' || item === '') {
      problems.push(`${key}[${index}]: must be a non-empty string`);
    } else {
      out.push(item);
    }
  });
  if (opts.nonEmpty && value.length === 0) problems.push(`${key}: must not be empty`);
  return out;
}

function pathProblem(glob: string): string | null {
  if (/[\u0000-\u001f\u007f]/.test(glob)) return 'must not contain control characters';
  if (glob.startsWith('/')) return 'must be relative to the repository root';
  if (glob.includes('\\')) return 'must use "/" separators';
  if (glob.split('/').some((seg) => seg === '..' || seg === '.')) {
    return 'must not contain "." or ".." segments';
  }
  if (glob.endsWith('/')) return 'must name files (end with a file name or a wildcard)';
  return null;
}

/**
 * The `red_exempt` list (CT-06r): a list of mappings `file` / `test` / `reason`, each a non-empty
 * string, the file a repository-relative path, the reason at least RED_EXEMPT_REASON_MIN
 * characters once trimmed, and no file + test named twice. Whether the file lies inside
 * test_paths and the task has a rule-test author is checked by tools/ops/task.ts.
 */
function redExemptList(value: unknown, problems: string[]): RedExemptDeclaration[] {
  if (!Array.isArray(value)) {
    problems.push('red_exempt: must be a list of mappings (file / test / reason)');
    return [];
  }
  if (value.length > RED_EXEMPT_MAX) {
    problems.push(
      `red_exempt: ${value.length} entries, the limit is ${RED_EXEMPT_MAX} (CT-06t; the section is not counted in the file's line limit, so it has its own)`,
    );
  }
  const out: RedExemptDeclaration[] = [];
  const seen = new Set<string>();
  value.forEach((item, index) => {
    if (!isRecord(item)) {
      problems.push(`red_exempt[${index}]: must be a mapping (file / test / reason)`);
      return;
    }
    for (const key of Object.keys(item)) {
      if (!['file', 'test', 'reason'].includes(key)) {
        problems.push(`red_exempt[${index}].${key}: unknown field`);
      }
    }
    const file = item['file'];
    const test = item['test'];
    const reason = item['reason'];
    let ok = true;
    if (typeof file !== 'string' || file === '') {
      problems.push(`red_exempt[${index}].file: must be a non-empty repository path`);
      ok = false;
    } else {
      const problem = pathProblem(file);
      if (problem !== null) {
        problems.push(`red_exempt[${index}].file: "${file}" ${problem}`);
        ok = false;
      }
    }
    if (typeof test !== 'string' || test.trim() === '') {
      problems.push(`red_exempt[${index}].test: must be the test's full name (non-empty)`);
      ok = false;
    }
    if (typeof reason !== 'string' || reason.trim().length < RED_EXEMPT_REASON_MIN) {
      problems.push(
        `red_exempt[${index}].reason: must say why the test cannot be shown red (at least ${RED_EXEMPT_REASON_MIN} characters)`,
      );
      ok = false;
    }
    if (!ok) return;
    const key = `${file as string}\u0000${test as string}`;
    if (seen.has(key)) {
      problems.push(
        `red_exempt[${index}]: "${file as string} > ${test as string}" is declared twice`,
      );
      return;
    }
    seen.add(key);
    out.push({ file: file as string, test: test as string, reason: reason as string });
  });
  return out;
}

/**
 * The `red_exempt_outside` list (CT-06zzzc, D10-623): a list of mappings `file` / `reason`, the
 * file a repository-relative path named once, the reason at least RED_EXEMPT_REASON_MIN
 * characters once trimmed, at most RED_EXEMPT_MAX entries (the section is not counted in the
 * line limit either). Whether the file is a rule-test file of test_paths that exists at the base
 * and the task has a rule-test author is checked by tools/ops/task.ts.
 */
function redExemptOutsideList(value: unknown, problems: string[]): RedExemptOutsideDeclaration[] {
  const label = 'red_exempt_outside';
  if (!Array.isArray(value)) {
    problems.push(`${label}: must be a list of mappings (file / reason)`);
    return [];
  }
  if (value.length > RED_EXEMPT_MAX) {
    problems.push(
      `${label}: ${value.length} entries, the limit is ${RED_EXEMPT_MAX} (CT-06zzzc; the section is not counted in the file's line limit, so it has its own)`,
    );
  }
  const out: RedExemptOutsideDeclaration[] = [];
  const seen = new Set<string>();
  value.forEach((item, index) => {
    if (!isRecord(item)) {
      problems.push(`${label}[${index}]: must be a mapping (file / reason)`);
      return;
    }
    for (const key of Object.keys(item)) {
      if (!['file', 'reason'].includes(key)) {
        problems.push(`${label}[${index}].${key}: unknown field`);
      }
    }
    const file = item['file'];
    const reason = item['reason'];
    let ok = true;
    if (typeof file !== 'string' || file === '') {
      problems.push(`${label}[${index}].file: must be a non-empty repository path`);
      ok = false;
    } else {
      const problem = pathProblem(file);
      if (problem !== null) {
        problems.push(`${label}[${index}].file: "${file}" ${problem}`);
        ok = false;
      }
    }
    if (typeof reason !== 'string' || reason.trim().length < RED_EXEMPT_REASON_MIN) {
      problems.push(
        `${label}[${index}].reason: must say why the code outside the tests changes (at least ${RED_EXEMPT_REASON_MIN} characters)`,
      );
      ok = false;
    }
    if (!ok) return;
    if (seen.has(file as string)) {
      problems.push(`${label}[${index}]: "${file as string}" is declared twice`);
      return;
    }
    seen.add(file as string);
    out.push({ file: file as string, reason: reason as string });
  });
  return out;
}

/** Why `value` is not one quoted name literal (RENAME_LITERAL), or null. */
function renameLiteralProblem(value: string): string | null {
  const m = RENAME_LITERAL.exec(value);
  if (m === null) {
    return `must be one quoted name literal (the same quote ', " or \` at both ends; inside only ${RENAME_NAME_CHARS})`;
  }
  if ((m[2] ?? '').length < RENAME_CONTENT_MIN) {
    return `must hold at least ${RENAME_CONTENT_MIN} characters between its quotes`;
  }
  if (!/[A-Za-z]/.test(m[2] ?? '')) {
    return 'must hold at least one ASCII letter between its quotes (D10-379: a number is not a name)';
  }
  return null;
}

/**
 * The `renames` list (CT-06zxc, D10-347; review r1 S2-1): a list of mappings with exactly the
 * keys `from` / `to`, each one quoted name literal (RENAME_LITERAL, at least
 * RENAME_CONTENT_MIN characters inside), both with the same quote, `from` ≠ `to`, no `from` named
 * twice, at most RENAMES_MAX entries. The values are literal text: red-check never reads them as
 * a pattern.
 */
function renameList(value: unknown, problems: string[]): RenameDeclaration[] {
  if (!Array.isArray(value)) {
    problems.push('renames: must be a list of mappings (from / to)');
    return [];
  }
  if (value.length > RENAMES_MAX) {
    problems.push(`renames: ${value.length} entries, the limit is ${RENAMES_MAX}`);
  }
  const out: RenameDeclaration[] = [];
  const seen = new Set<string>();
  value.forEach((item, index) => {
    if (!isRecord(item)) {
      problems.push(`renames[${index}]: must be a mapping (from / to)`);
      return;
    }
    for (const key of Object.keys(item)) {
      if (key !== 'from' && key !== 'to') problems.push(`renames[${index}].${key}: unknown field`);
    }
    let ok = true;
    for (const key of ['from', 'to'] as const) {
      const v = item[key];
      if (typeof v !== 'string' || v === '') {
        problems.push(`renames[${index}].${key}: must be a non-empty string`);
        ok = false;
        continue;
      }
      const problem = renameLiteralProblem(v);
      if (problem !== null) {
        problems.push(`renames[${index}].${key}: ${JSON.stringify(v)} ${problem}`);
        ok = false;
      }
    }
    if (!ok) return;
    const from = item['from'] as string;
    const to = item['to'] as string;
    if (from[0] !== to[0]) {
      problems.push(`renames[${index}]: from and to must use the same quote`);
      return;
    }
    if (from === to) {
      problems.push(`renames[${index}]: from and to are the same (${from})`);
      return;
    }
    if (seen.has(from)) {
      problems.push(`renames[${index}].from: ${from} is renamed twice`);
      return;
    }
    seen.add(from);
    out.push({ from, to });
  });
  return out;
}

/**
 * The `expected_values` list (CT-06zxe, D10-371): mappings with exactly `file` / `helper` /
 * `from` / `to`; `file` a repository path, `helper` an identifier, `from` / `to` non-empty single
 * lines of at most EXPECTED_VALUE_LENGTH_MAX characters, different, with the same value skeleton
 * (EXPECTED_VALUE_SHAPE); no file + helper + from twice; at most EXPECTED_VALUES_MAX entries.
 * Whether the file lies inside test_paths is checked by tools/ops/task.ts.
 */
function expectedValueList(value: unknown, problems: string[]): ExpectedValueDeclaration[] {
  const label = 'expected_values';
  if (!Array.isArray(value)) {
    problems.push(`${label}: must be a list of mappings (file / helper / from / to)`);
    return [];
  }
  if (value.length > EXPECTED_VALUES_MAX) {
    problems.push(`${label}: ${value.length} entries, the limit is ${EXPECTED_VALUES_MAX}`);
  }
  const out: ExpectedValueDeclaration[] = [];
  const seen = new Set<string>();
  value.forEach((item, index) => {
    const at = `${label}[${index}]`;
    if (!isRecord(item)) {
      problems.push(`${at}: must be a mapping (file / helper / from / to)`);
      return;
    }
    for (const key of Object.keys(item)) {
      if (!['file', 'helper', 'from', 'to'].includes(key)) {
        problems.push(`${at}.${key}: unknown field`);
      }
    }
    const { file, helper, from, to } = item;
    let ok = true;
    if (typeof file !== 'string' || file === '') {
      problems.push(`${at}.file: must be a non-empty repository path`);
      ok = false;
    } else {
      const problem = pathProblem(file);
      if (problem !== null) {
        problems.push(`${at}.file: "${file}" ${problem}`);
        ok = false;
      }
    }
    if (typeof helper !== 'string' || !IDENTIFIER.test(helper)) {
      problems.push(`${at}.helper: must be the name (an identifier) of a top-level helper`);
      ok = false;
    }
    for (const [key, v] of [
      ['from', from],
      ['to', to],
    ] as const) {
      if (typeof v !== 'string' || v.trim() === '') {
        problems.push(`${at}.${key}: must be a non-empty source snippet`);
        ok = false;
      } else if (/[\n\r\u2028\u2029]/.test(v)) {
        problems.push(`${at}.${key}: must be a single line`);
        ok = false;
      } else if (v.length > EXPECTED_VALUE_LENGTH_MAX) {
        problems.push(`${at}.${key}: longer than ${EXPECTED_VALUE_LENGTH_MAX} characters`);
        ok = false;
      }
    }
    if (!ok) return;
    const f = from as string;
    const t = to as string;
    if (f === t) {
      problems.push(`${at}: from and to are the same`);
      return;
    }
    const skeleton = valueSkeleton(f);
    if (skeleton === null || skeleton !== valueSkeleton(t)) {
      problems.push(
        `${at}: from ${JSON.stringify(f)} and to ${JSON.stringify(t)} must have ${EXPECTED_VALUE_SHAPE}`,
      );
      return;
    }
    const refusal = valueChangeRefusal(f, t);
    if (refusal !== null) {
      problems.push(`${at}: from ${JSON.stringify(f)} → to ${JSON.stringify(t)}: ${refusal}`);
      return;
    }
    const key = `${file as string}\u0000${helper as string}\u0000${f}`;
    if (seen.has(key)) {
      problems.push(
        `${at}: ${file as string} / ${helper as string} / ${JSON.stringify(f)} is registered twice`,
      );
      return;
    }
    seen.add(key);
    out.push({ file: file as string, helper: helper as string, from: f, to: t });
  });
  return out;
}

/** Parses and validates one task file; throws a single Error listing every problem found. */
export function parseTaskFile(text: string, fileName: string): TaskFile {
  const label = basename(fileName);
  let doc: unknown;
  try {
    doc = parseYamlLite(text);
  } catch (err) {
    throw new Error(`${label}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isRecord(doc)) throw new Error(`${label}: the document must be a mapping`);

  const problems: string[] = [];
  for (const key of Object.keys(doc)) {
    if (!KNOWN_KEYS.has(key)) problems.push(`${key}: unknown field`);
  }
  for (const key of KNOWN_KEYS) {
    if (
      key !== 'pr' &&
      key !== 'contract_sections' &&
      key !== 'test_paths' &&
      key !== 'mechanical_paths' &&
      key !== 'red_exempt' &&
      key !== 'red_exempt_outside' &&
      key !== 'renames' &&
      key !== 'expected_values' &&
      !Object.hasOwn(doc, key)
    ) {
      problems.push(`${key}: missing`);
    }
  }

  const id = doc['id'];
  if (typeof id !== 'string' || !TASK_ID_PATTERN.test(id)) {
    if (Object.hasOwn(doc, 'id')) problems.push('id: must look like "B2-03" or "B2-03a"');
  } else if (label.replace(/\.ya?ml$/, '') !== id) {
    problems.push(`id: "${id}" does not match the file name "${label}"`);
  }

  const repo = doc['repo'];
  if (Object.hasOwn(doc, 'repo') && !oneOf(repo, TASK_REPOS)) {
    problems.push(`repo: must be one of ${TASK_REPOS.join(' / ')}`);
  }

  const title = doc['title'];
  if (Object.hasOwn(doc, 'title')) {
    if (typeof title !== 'string' || title.trim() === '' || title.includes('\n')) {
      problems.push('title: must be a single non-empty line');
    }
  }

  const type = doc['type'];
  if (Object.hasOwn(doc, 'type') && !oneOf(type, TASK_TYPES)) {
    problems.push(`type: must be one of ${TASK_TYPES.join(' / ')}`);
  }

  const refs = Object.hasOwn(doc, 'refs')
    ? stringList(doc, 'refs', problems, { nonEmpty: false })
    : [];
  const deps = Object.hasOwn(doc, 'deps')
    ? stringList(doc, 'deps', problems, { nonEmpty: false })
    : [];
  const paths = Object.hasOwn(doc, 'paths')
    ? stringList(doc, 'paths', problems, { nonEmpty: true })
    : [];
  const testPaths = Object.hasOwn(doc, 'test_paths')
    ? stringList(doc, 'test_paths', problems, { nonEmpty: true })
    : [];
  for (const glob of testPaths) {
    const problem = pathProblem(glob);
    if (problem) problems.push(`test_paths: "${glob}" ${problem}`);
  }
  const mechanicalPaths = Object.hasOwn(doc, 'mechanical_paths')
    ? stringList(doc, 'mechanical_paths', problems, { nonEmpty: true })
    : [];
  for (const glob of mechanicalPaths) {
    const problem = pathProblem(glob);
    if (problem) problems.push(`mechanical_paths: "${glob}" ${problem}`);
  }
  const redExempt = Object.hasOwn(doc, 'red_exempt')
    ? redExemptList(doc['red_exempt'], problems)
    : [];
  const redExemptOutside = Object.hasOwn(doc, 'red_exempt_outside')
    ? redExemptOutsideList(doc['red_exempt_outside'], problems)
    : [];
  const renames = Object.hasOwn(doc, 'renames') ? renameList(doc['renames'], problems) : [];
  const expectedValues = Object.hasOwn(doc, 'expected_values')
    ? expectedValueList(doc['expected_values'], problems)
    : [];
  const accept = Object.hasOwn(doc, 'accept')
    ? stringList(doc, 'accept', problems, { nonEmpty: true })
    : [];

  const contractSections = Object.hasOwn(doc, 'contract_sections')
    ? stringList(doc, 'contract_sections', problems, { nonEmpty: true })
    : [];
  if (Object.hasOwn(doc, 'contract_sections') && type !== 'contract') {
    problems.push('contract_sections: only a contract task names 规划/04 sections');
  }
  for (const section of contractSections) {
    if (!CONTRACT_SECTION_PATTERN.test(section)) {
      problems.push(
        `contract_sections: "${section}" is not a 规划/04 section number such as "6.1"`,
      );
    }
  }

  for (const dep of deps) {
    if (!TASK_ID_PATTERN.test(dep)) problems.push(`deps: "${dep}" is not a task id`);
  }
  for (const glob of paths) {
    const problem = pathProblem(glob);
    if (problem) problems.push(`paths: "${glob}" ${problem}`);
  }

  const refsHash: Record<string, string> = {};
  if (Object.hasOwn(doc, 'refs_hash')) {
    const raw = doc['refs_hash'];
    if (!isRecord(raw)) {
      problems.push('refs_hash: must be a mapping of reference id to hash');
    } else {
      for (const [key, value] of Object.entries(raw)) {
        if (typeof value !== 'string' || value === '') {
          problems.push(`refs_hash.${key}: must be a non-empty string`);
        } else {
          refsHash[key] = value;
        }
      }
    }
  }

  const impl = doc['impl'];
  if (Object.hasOwn(doc, 'impl') && !oneOf(impl, TASK_IMPLS)) {
    problems.push(`impl: must be one of ${TASK_IMPLS.join(' / ')}`);
  }
  const tester = doc['tester'];
  if (Object.hasOwn(doc, 'tester') && !oneOf(tester, TASK_TESTERS)) {
    problems.push(`tester: must be one of ${TASK_TESTERS.join(' / ')}`);
  }
  const status = doc['status'];
  if (Object.hasOwn(doc, 'status') && !oneOf(status, TASK_STATUSES)) {
    problems.push(`status: must be one of ${TASK_STATUSES.join(' / ')}`);
  }

  const pr = doc['pr'] ?? null;
  if (pr !== null && (typeof pr !== 'number' || !Number.isInteger(pr) || pr <= 0)) {
    problems.push('pr: must be a positive integer or null');
  }

  if (problems.length > 0) {
    throw new Error(`${label}: invalid task file\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  }
  return {
    id: id as string,
    repo: repo as TaskFile['repo'],
    title: title as string,
    type: type as TaskFile['type'],
    refs,
    refs_hash: refsHash,
    contract_sections: contractSections,
    deps,
    paths,
    test_paths: testPaths,
    mechanical_paths: mechanicalPaths,
    red_exempt: redExempt,
    red_exempt_outside: redExemptOutside,
    renames,
    expected_values: expectedValues,
    impl: impl as TaskFile['impl'],
    tester: tester as TaskFile['tester'],
    accept,
    status: status as TaskFile['status'],
    pr: pr as number | null,
  };
}

/** Reads `<root>/ops/tasks/<id>.yaml` (root defaults to this checkout). */
export function loadTask(id: string, root: string = repoRoot()): TaskFile {
  if (!TASK_ID_PATTERN.test(id)) throw new Error(`invalid task id: "${id}"`);
  const file = join(root, 'ops', 'tasks', `${id}.yaml`);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    throw new Error(`task file not found: ${file}`);
  }
  return parseTaskFile(text, file);
}

/** Ids of the task files directly under `<root>/ops/tasks` (the `archive/` tree is excluded). */
export function listTaskIds(root: string = repoRoot()): string[] {
  const dir = join(root, 'ops', 'tasks');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.yaml'))
    .map((entry) => entry.name.slice(0, -'.yaml'.length))
    .sort();
}
