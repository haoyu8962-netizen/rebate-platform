// Task ledger checks (规划/11 §2.1, planning docs/templates/task-ledger.md).
//
//   node tools/ops/task.ts check [id...]     validate ops/tasks/*.yaml
//   node tools/ops/task.ts show <id> --json  task fields plus the computed risk
//   node tools/ops/task.ts hash <id>         print the refs_hash block to paste
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { matchesAny } from '../lib/glob.ts';
import { RULE_TEST_FILE } from '../guard/lib/red-check.ts';
import {
  isCodexFirst,
  loadCodexImplForbidden,
  loadCodexImplMechanical,
  loadCodexImplTasks,
} from '../lib/codex-impl-tasks.ts';
import { loadLegacyTasks, needsTestPaths } from '../lib/legacy-tasks.ts';
import { repoRoot } from '../lib/paths.ts';
import { listTaskIds, parseTaskFile } from '../lib/task-file.ts';
import type { TaskFile } from '../lib/task-file.ts';
import { assertTaskId, CheckError, runGuard, runMain, TASK_ID, UsageError } from './cli.ts';
import { globsMayOverlap, literalPrefix } from './overlap.ts';
import { findRule, ruleHash, taskIdKnown } from './spec.ts';
import type { SpecSource } from './spec.ts';

export const MAX_TASK_LINES = 40;

/**
 * The lines of a task file that count towards MAX_TASK_LINES (CT-06t, orchestrator ruling of
 * 2026-10-19, option A): the `red_exempt` section is left out — the `red_exempt:` line and the
 * indented lines that follow it up to the next top-level line — because yaml-lite writes one
 * declaration as three lines (file / test / reason) and the section has its own limit
 * (RED_EXEMPT_MAX entries, tools/lib/task-file.ts). Everything under that key must parse as
 * such declarations, so nothing else can hide there; an indented comment line in the section
 * still counts (CT-06zxh).
 */
export function countedLines(text: string): number {
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  let count = 0;
  let inExempt = false;
  for (const line of lines) {
    // CT-06zxc (review r1 S2-2): the `renames` section likewise (RENAMES_MAX entries, each a
    // from / to mapping of string literals: nothing else parses there); CT-06zxe: and the
    // `expected_values` section (EXPECTED_VALUES_MAX entries of file / helper / from / to);
    // CT-06zzzc (D10-623): and the `red_exempt_outside` section (RED_EXEMPT_MAX entries of file /
    // reason); CT-06zzze (D10-657): and the `red_exempt_rows` section (RED_EXEMPT_MAX entries of
    // file / test / reason, as red_exempt); CT-06zzzg (D10-701): and the `modify_existing` section
    // (RED_EXEMPT_MAX entries together with red_exempt, of file / test / reason / ruling / note).
    if (
      /^(red_exempt|red_exempt_outside|red_exempt_rows|modify_existing|renames|expected_values):/.test(
        line,
      )
    ) {
      inExempt = true;
      continue;
    }
    if (inExempt && /^[ \t]/.test(line)) {
      // CT-06zxh: an indented comment line inside such a section is no declaration: it counts.
      if (/^[ \t]+#/.test(line)) count += 1;
      continue;
    }
    inExempt = false;
    count += 1;
  }
  return count;
}

export type RiskLevel = 'RV0' | 'RV1' | 'RV2';
export type RiskReport = {
  risk: RiskLevel;
  ask: boolean;
  paths: { path: string; risk: RiskLevel; rule: string | null; protected: null | 1 | 2 | 3 }[];
};

export type CheckOptions = {
  root?: string;
  spec?: SpecSource;
  /** Injected by tests; defaults to the guard in the trusted root. */
  risk?: (paths: readonly string[]) => RiskReport;
  /** Injected by tests: many sets at once; defaults to `risk` per set, or the trusted guard. */
  riskSets?: (sets: readonly (readonly string[])[]) => RiskReport[];
  /** Told when the combined guard call is unusable (the check then asks per task). */
  onRiskFallback?: (reason: string) => void;
};

/** The guard calls checkTasks and the status board batch (batchRisk). */
export function riskSources(opts: {
  risk?: (paths: readonly string[]) => RiskReport;
  riskSets?: (sets: readonly (readonly string[])[]) => RiskReport[];
  onRiskFallback?: (reason: string) => void;
}): RiskSources {
  const one = opts.risk;
  const many =
    opts.riskSets ?? (one ? (sets: readonly (readonly string[])[]) => sets.map(one) : undefined);
  return { many, one, onFallback: opts.onRiskFallback };
}

/** Risk level of a set of paths, computed by the trusted guard (规划/11 §1.2). */
export function riskOfPaths(paths: readonly string[]): RiskReport {
  const res = runGuard('risk-of-paths.ts', ['--json', '--stdin'], { input: paths.join('\n') });
  if (res.status !== 0) {
    throw new Error(`risk-of-paths.ts exited ${res.status}: ${res.stderr.trim()}`);
  }
  const parsed = JSON.parse(res.stdout) as RiskReport;
  if (!['RV0', 'RV1', 'RV2'].includes(parsed.risk)) {
    throw new Error(`risk-of-paths.ts returned an unknown risk: ${String(parsed.risk)}`);
  }
  return parsed;
}

/** Risk reports of many path sets from one call of the trusted guard (`risk-of-paths.ts --sets`). */
export function riskOfPathSets(sets: readonly (readonly string[])[]): RiskReport[] {
  const res = runGuard('risk-of-paths.ts', ['--sets'], { input: JSON.stringify(sets) });
  if (res.status !== 0) {
    throw new Error(`risk-of-paths.ts --sets exited ${res.status}: ${res.stderr.trim()}`);
  }
  const parsed = JSON.parse(res.stdout) as unknown;
  if (!Array.isArray(parsed) || parsed.length !== sets.length) {
    throw new Error(`risk-of-paths.ts --sets did not answer one report per set`);
  }
  for (const report of parsed as RiskReport[]) {
    if (!['RV0', 'RV1', 'RV2'].includes(report?.risk)) {
      throw new Error(`risk-of-paths.ts --sets returned an unknown risk: ${String(report?.risk)}`);
    }
  }
  return parsed as RiskReport[];
}

export type RiskSources = {
  /** One report per set, in order (default: the trusted guard, riskOfPathSets). */
  many?: ((sets: readonly (readonly string[])[]) => RiskReport[]) | undefined;
  /** One set (default: the trusted guard, riskOfPaths). */
  one?: ((paths: readonly string[]) => RiskReport) | undefined;
  /** Told once when the combined call is unusable and every set is asked on its own. */
  onFallback?: ((reason: string) => void) | undefined;
};

/**
 * Risk of many path sets from one call of the trusted guard. risk-of-paths.ts runs as a process of
 * its own, and one call per task (one Node start-up each) made the whole-ledger check outgrow its
 * test timeout once the ledger passed a hundred tasks. The guard computes every report itself
 * (`--sets`), so its aggregation is not repeated here. A set asked about that was not in `sets`, or
 * every set when the combined call fails, is asked on its own as before.
 */
export function batchRisk(
  sets: readonly (readonly string[])[],
  sources: RiskSources = {},
): (paths: readonly string[]) => RiskReport {
  const many = sources.many ?? riskOfPathSets;
  const one = sources.one ?? riskOfPaths;
  const key = (paths: readonly string[]): string => JSON.stringify(paths);
  // undefined: not asked yet; null: the combined call is unusable.
  let answers: Map<string, RiskReport> | null | undefined;
  return (paths) => {
    if (answers === undefined) {
      answers = null;
      const unique = [...new Map(sets.map((set) => [key(set), set])).values()];
      try {
        const reports = unique.length > 0 ? many(unique) : [];
        if (reports.length !== unique.length) throw new Error('not one report per set');
        answers = new Map(unique.map((set, i) => [key(set), reports[i]!]));
      } catch (err) {
        sources.onFallback?.(err instanceof Error ? err.message : String(err));
      }
    }
    return answers?.get(key(paths)) ?? one(paths);
  };
}

function tasksDir(root: string): string {
  return join(root, 'ops', 'tasks');
}

/** Ids of archived tasks (`ops/tasks/archive/<yyyymm>/<id>.yaml`), all of them done. */
export function archivedTaskIds(root: string = repoRoot()): string[] {
  const dir = join(tasksDir(root), 'archive');
  if (!existsSync(dir)) return [];
  const ids: string[] = [];
  for (const month of readdirSync(dir, { withFileTypes: true })) {
    if (!month.isDirectory()) continue;
    for (const f of readdirSync(join(dir, month.name))) {
      if (f.endsWith('.yaml')) ids.push(f.slice(0, -'.yaml'.length));
    }
  }
  return ids.sort();
}

export function readTaskText(id: string, root: string = repoRoot()): string {
  const file = join(tasksDir(root), `${id}.yaml`);
  if (!existsSync(file)) throw new CheckError(`ops/tasks/${id}.yaml does not exist`);
  return readFileSync(file, 'utf8');
}

export function readTask(id: string, root: string = repoRoot()): TaskFile {
  return parseTaskFile(readTaskText(id, root), `${id}.yaml`);
}

/** The current `refs_hash` values for a task, from the planning text at SPEC_REF. */
export function computeRefsHash(
  refs: readonly string[],
  spec?: SpecSource,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const ref of refs) out[ref] = ruleHash(findRule(ref, spec));
  return out;
}

/** Class 1 of the protected paths (the rule-test assets) of `root`, fragments removed. */
export function ruleTestGlobs(root: string): string[] {
  const file = join(root, 'tools', 'guard', 'protected-paths.json');
  const raw = JSON.parse(readFileSync(file, 'utf8')) as { class1_add_only?: unknown };
  if (!Array.isArray(raw.class1_add_only)) throw new Error(`${file}: class1_add_only missing`);
  return raw.class1_add_only.map((g) => String(g).replace(/#.*$/, ''));
}

/** True when every path `glob` can match lies inside one of `globs` (by its literal prefix). */
export function insideGlobs(glob: string, globs: readonly string[]): boolean {
  const prefix = literalPrefix(glob);
  if (prefix === glob) return matchesAny(glob, globs);
  // Everything the glob matches lies below `dir`: inside when a `**` glob covers that directory.
  const dir = prefix.slice(0, prefix.lastIndexOf('/') + 1);
  return (
    dir !== '' && matchesAny(`${dir}__file__`, globs) && matchesAny(`${dir}__dir__/__file__`, globs)
  );
}

/** The contract source; a task that may change it regenerates the files below (CT-06n). */
export const CONTRACT_SOURCE = 'contracts/openapi.yaml';

/** Regenerated from contracts/openapi.yaml whenever a `x-implementation: planned` marker changes (CT-06zxd). */
export const PLANNED_OPERATIONS_GENERATED = 'packages/contracts-ts/src/planned-operations.gen.ts';

/**
 * Files regenerated from contracts/openapi.yaml whenever an operation is added or removed
 * (planned ones included): the contract types and the three route tables of apps/api. A ledger
 * whose `paths` reach contracts/openapi.yaml must also cover these (CT-06n; CT-15n, CT-02i, CT-22a
 * and CT-22b had to extend their ledgers mid-run, #563, #605). route-schemas.gen.ts is left out:
 * it lists implemented operations only and belongs to the task that implements them.
 * planned-operations.gen.ts (F1-06zu, #1445) lists the operations still marked planned, so it also
 * changes when a ledger only removes planned markers: for it alone `mechanical_paths` reaching the
 * contract triggers the rule as well (CT-06zxd).
 */
export const CONTRACT_GENERATED = [
  'packages/contracts-ts/src/openapi.gen.ts',
  'apps/api/src/modules/platform/http/auth-routes.gen.ts',
  'apps/api/src/modules/platform/validation/signing-routes.gen.ts',
  'apps/api/src/modules/risk/application/min-version-routes.gen.ts',
  PLANNED_OPERATIONS_GENERATED,
] as const;

/**
 * Open ledgers written before CT-06n whose `paths` reach contracts/openapi.yaml without covering
 * every file of CONTRACT_GENERATED except planned-operations.gen.ts. Frozen: ledgers are not
 * rewritten by a guard task, and a new ledger never joins the list (tools/ops/task.test.ts). Done
 * ledgers are not checked at all.
 */
export const CONTRACT_GENERATED_EXEMPT: ReadonlySet<string> = new Set([
  'B1-08l',
  'B1-08m',
  'B1-11e',
  'B1-11j',
  'B1-13d',
  'B1-13h',
  'CT-04b',
  'CT-07a',
  'F1-09d',
  'F1-09e',
  'F1-09f',
]);

/**
 * Open ledgers written before CT-06zxd whose `paths` or `mechanical_paths` reach
 * contracts/openapi.yaml without covering planned-operations.gen.ts, exempt from that one file
 * only. `task.ts check` on main at c5f973f3 found none (the only such open ledger, CT-02x, covers
 * `packages/contracts-ts/**`), so the list is empty. Frozen like CONTRACT_GENERATED_EXEMPT: a new
 * ledger never joins it, it lists the file instead (tools/ops/task.test.ts).
 */
export const PLANNED_OPERATIONS_GEN_EXEMPT: ReadonlySet<string> = new Set<string>([]);

/**
 * The files of CONTRACT_GENERATED an open task misses: [] unless the task is todo and reaches
 * contracts/openapi.yaml. The three route tables and openapi.gen.ts are required only when `paths`
 * reach it: a Codex implementation that names the contract in `mechanical_paths` only removes
 * planned markers, which leaves them unchanged (they list planned operations too). That does change
 * planned-operations.gen.ts, so it is required when either `paths` or `mechanical_paths` reach the
 * contract. Coverage counts `paths` and `mechanical_paths`, literally or by glob (e.g.
 * `packages/contracts-ts/**`). Exemptions (by id) are applied by checkTask.
 */
export function missingContractGenerated(
  task: Pick<TaskFile, 'status' | 'paths' | 'mechanical_paths'>,
): string[] {
  if (task.status !== 'todo') return [];
  const inPaths = matchesAny(CONTRACT_SOURCE, task.paths);
  if (!inPaths && !matchesAny(CONTRACT_SOURCE, task.mechanical_paths)) return [];
  const covered = [...task.paths, ...task.mechanical_paths];
  return CONTRACT_GENERATED.filter(
    (file) => (inPaths || file === PLANNED_OPERATIONS_GENERATED) && !matchesAny(file, covered),
  );
}

/** True when `path` is a regular file (not a directory or a symbolic link). */
function regularFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

/** All problems of one task file; an empty list means the file is valid. */
export function checkTask(id: string, opts: CheckOptions = {}): string[] {
  const root = opts.root ?? repoRoot();
  const problems: string[] = [];
  const text = readTaskText(id, root);

  const lines = countedLines(text);
  if (lines > MAX_TASK_LINES) {
    problems.push(
      `${lines} lines, the limit is ${MAX_TASK_LINES} (规划/11 §5.1; the red_exempt section is not counted, CT-06t, nor the renames section, CT-06zxc, nor expected_values, CT-06zxe, nor red_exempt_outside, CT-06zzzc, nor red_exempt_rows, CT-06zzze, nor modify_existing, CT-06zzzg)`,
    );
  }

  let task: TaskFile;
  try {
    task = parseTaskFile(text, `${id}.yaml`);
  } catch (err) {
    problems.push(err instanceof Error ? err.message : String(err));
    return problems;
  }

  if (task.id !== id) problems.push(`id "${task.id}" does not match the file name ${id}.yaml`);

  const prefix = task.id.replace(/[a-z]+$/, '');
  try {
    if (!taskIdKnown(prefix, opts.spec)) {
      problems.push(`task id prefix ${prefix} is not a task row of 规划/05 at SPEC_REF`);
    }
  } catch (err) {
    problems.push(`cannot read 规划/05 at SPEC_REF: ${err instanceof Error ? err.message : err}`);
  }

  for (const ref of task.refs) {
    let expected: string;
    try {
      expected = ruleHash(findRule(ref, opts.spec));
    } catch (err) {
      problems.push(`refs: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const recorded = task.refs_hash[ref];
    if (recorded === undefined) {
      problems.push(`refs_hash: missing entry for ${ref} (expected ${expected})`);
    } else if (recorded !== expected) {
      problems.push(
        `refs_hash: ${ref} is ${recorded} but the text at SPEC_REF hashes to ${expected} (task is stale)`,
      );
    }
  }
  for (const key of Object.keys(task.refs_hash)) {
    if (!task.refs.includes(key)) problems.push(`refs_hash: ${key} is not listed in refs`);
  }

  const known = new Set([...listTaskIds(root), ...archivedTaskIds(root)]);
  for (const dep of task.deps) {
    if (dep === task.id) problems.push(`deps: a task cannot depend on itself`);
    else if (!known.has(dep)) problems.push(`deps: ${dep} is not in ops/tasks`);
  }

  // test_paths (2026-10-05): only the rule-test author's assets, i.e. inside class 1 of the
  // protected paths, and only for a task that has a rule-test author. A task with a rule-test
  // author needs them, unless its ledger existed at the switch baseline (CR2-02).
  // CR3-03: a ledger written after the switch follows the default split: the Opus subagent
  // implements (impl: claude; a handover is recorded at run time, never in the ledger) and the
  // rule tests are Codex's or there are none.
  // Owner 2026-10-06 (ops/approvals.yaml id 23): a task of tools/guard/codex-impl-tasks.json may
  // instead name impl: codex with tester: claude (Claude writes the rule tests first, Codex
  // implements); every other new ledger keeps the default split.
  // Owner 2026-10-17 (ops/approvals.yaml id 34): implementation is back with Claude and the list
  // is frozen (no new entry; tools/lib/codex-impl-tasks.test.ts), so a new ledger outside it must
  // name impl: claude; a listed ledger already started finishes as a Codex implementation.
  const legacy = loadLegacyTasks(root);
  const codexFirst = isCodexFirst(task, loadCodexImplTasks(root));
  if (codexFirst) {
    // Claude review S2-1: the list is per split task, but a suffix says nothing about content; a
    // Codex-first ledger may only be implementation work outside funds, attribution, payout,
    // migrations, contracts, clients and gates (tools/guard/codex-impl-tasks.json forbidden_paths).
    if (task.type !== 'impl') {
      problems.push(
        `type: a Codex implementation (tools/guard/codex-impl-tasks.json) is for type impl only, not ${task.type}`,
      );
    }
    const forbidden = loadCodexImplForbidden(root);
    if (forbidden.length === 0) {
      problems.push(
        'paths: tools/guard/codex-impl-tasks.json has no forbidden_paths; a Codex implementation is refused (fail-closed)',
      );
    }
    for (const glob of task.paths) {
      const hit = forbidden.find((f) => globsMayOverlap(glob, f));
      if (hit !== undefined) {
        problems.push(
          `paths: "${glob}" reaches "${hit}", which stays with the default split (ops/approvals.yaml id 19), not a Codex implementation`,
        );
      }
    }
  }
  // ops/approvals.yaml id 31: the mechanical commit of a Codex implementation (planned markers
  // removed from the contract, files regenerated) is Claude's and stays outside `paths`, so
  // forbidden_paths do not apply to it; only the files the list names are allowed.
  if (task.mechanical_paths.length > 0) {
    if (!codexFirst) {
      problems.push(
        'mechanical_paths: only a Codex implementation ledger (tools/guard/codex-impl-tasks.json) names them; a Claude implementation lists those files in paths',
      );
    } else {
      const allowed = loadCodexImplMechanical(root);
      if (allowed.length === 0) {
        problems.push(
          'mechanical_paths: tools/guard/codex-impl-tasks.json has no mechanical_paths; none is allowed (fail-closed)',
        );
      }
      for (const glob of task.mechanical_paths) {
        if (allowed.length > 0 && !insideGlobs(glob, allowed)) {
          problems.push(
            `mechanical_paths: "${glob}" is not one of the mechanical_paths of tools/guard/codex-impl-tasks.json (ops/approvals.yaml id 31)`,
          );
        }
      }
    }
  }
  if (!legacy.has(task.id) && !codexFirst) {
    if (task.impl !== 'claude') {
      problems.push(
        `impl: must be claude for a task written after the switch of 2026-10-05 (a Codex handover is recorded at run time, not in the ledger)`,
      );
    }
    // claude-independent: a fresh Claude context writes the rule tests while Codex is not
    // available (owner decision 2026-10-21, ops/approvals.yaml id 36).
    if (task.tester !== 'codex' && task.tester !== 'claude-independent' && task.tester !== 'none') {
      problems.push(
        `tester: must be codex or none for a task written after the switch of 2026-10-05`,
      );
    }
  }
  if (task.test_paths.length === 0 && needsTestPaths(task, legacy)) {
    problems.push(
      `test_paths: required for a task with a rule-test author (tester: ${task.tester}); only the ledgers listed in tools/guard/legacy-tasks.json may omit it`,
    );
  }
  if (task.test_paths.length > 0) {
    if (task.tester === 'none') {
      problems.push(
        'test_paths: a task without a rule-test author (tester: none) has no test_paths',
      );
    }
    let class1: string[] = [];
    try {
      class1 = ruleTestGlobs(root);
    } catch (err) {
      problems.push(`test_paths: ${err instanceof Error ? err.message : String(err)}`);
    }
    for (const glob of task.test_paths) {
      if (class1.length > 0 && !insideGlobs(glob, class1)) {
        problems.push(
          `test_paths: "${glob}" is not inside the rule-test assets (class 1 of tools/guard/protected-paths.json)`,
        );
      }
    }
  }

  // CT-06r: declared red-run exemptions name rule-test files of the task's own test_paths, and
  // only a task with a rule-test author has a red run to exempt from (the shape, the reason
  // length and duplicates are checked by parseTaskFile).
  if (task.red_exempt.length > 0) {
    if (task.tester === 'none') {
      problems.push(
        'red_exempt: a task without a rule-test author (tester: none) has no red run to exempt from',
      );
    }
    for (const entry of task.red_exempt) {
      if (!RULE_TEST_FILE.test(entry.file)) {
        problems.push(`red_exempt: "${entry.file}" is not a rule-test file (*.test.ts)`);
      } else if (!matchesAny(entry.file, task.test_paths)) {
        problems.push(`red_exempt: "${entry.file}" is not inside the task's test_paths`);
      }
    }
  }

  // CT-06zzzc (D10-623): the files whose changed code outside the tests the ledger declares are
  // rule-test files of the task's own test_paths that exist at the base — the trusted root this
  // check reads the ledger from (a file the task adds is new: every test of it must be red
  // anyway) — and only a task with a rule-test author has a red run they matter to.
  if (task.red_exempt_outside.length > 0) {
    if (task.tester === 'none') {
      problems.push(
        'red_exempt_outside: a task without a rule-test author (tester: none) has no red run to exempt from',
      );
    }
    for (const entry of task.red_exempt_outside) {
      if (!RULE_TEST_FILE.test(entry.file)) {
        problems.push(`red_exempt_outside: "${entry.file}" is not a rule-test file (*.test.ts)`);
      } else if (!matchesAny(entry.file, task.test_paths)) {
        problems.push(`red_exempt_outside: "${entry.file}" is not inside the task's test_paths`);
      } else if (!regularFile(join(root, entry.file))) {
        problems.push(
          `red_exempt_outside: "${entry.file}" does not exist at the base (the trusted root): only a rule-test file that existed before the task can keep its declared exemptions`,
        );
      } else if (
        !task.red_exempt.some((d) => d.file === entry.file) &&
        !task.red_exempt_rows.some((d) => d.file === entry.file)
      ) {
        problems.push(
          `red_exempt_outside: "${entry.file}" has no red_exempt or red_exempt_rows declaration: there is nothing for the entry to apply`,
        );
      }
    }
  }

  // CT-06zzze (D10-657): declared kept rows of a split .each table name rule-test files of the
  // task's own test_paths that exist at the base (a new file has no base table: every test of it
  // must be red), and only a task with a rule-test author has a red run they matter to (the shape,
  // the reason length and duplicates are checked by parseTaskFile).
  if (task.red_exempt_rows.length > 0) {
    if (task.tester === 'none') {
      problems.push(
        'red_exempt_rows: a task without a rule-test author (tester: none) has no red run to exempt from',
      );
    }
    for (const file of new Set(task.red_exempt_rows.map((d) => d.file))) {
      if (!RULE_TEST_FILE.test(file)) {
        problems.push(`red_exempt_rows: "${file}" is not a rule-test file (*.test.ts)`);
      } else if (!matchesAny(file, task.test_paths)) {
        problems.push(`red_exempt_rows: "${file}" is not inside the task's test_paths`);
      } else if (!regularFile(join(root, file))) {
        problems.push(
          `red_exempt_rows: "${file}" does not exist at the base (the trusted root): only a table of a rule-test file that existed before the task can keep rows`,
        );
      }
    }
  }

  // CT-06zzzg (D10-701): declared changes of frozen tests that stay green name rule-test files
  // (class 1) of the task that exist at the base (the trusted root): a new file has no frozen test
  // to change. Unlike red_exempt, a task without a rule-test author (tester: none) may declare
  // them too: a test-change task that only fixes a flaky frozen test or tightens one (FU-B209R-
  // FLAKE, B2-09v) has no rule-test author and no red run, yet evidence-check's add-only rule for
  // class 1 after spec_commit (spec_commit is the base for such a task) is what the entries open.
  // Such a task has no test_paths (above), so its files must lie inside its paths instead; a task
  // with a rule-test author names files of its test_paths. The shape, the note length, duplicates
  // and the cap shared with red_exempt are checked by parseTaskFile.
  if (task.modify_existing.length > 0) {
    const scope = task.tester === 'none' ? task.paths : task.test_paths;
    const scopeName = task.tester === 'none' ? 'paths (tester: none)' : 'test_paths';
    let class1: string[] = [];
    try {
      class1 = ruleTestGlobs(root);
    } catch (err) {
      problems.push(`modify_existing: ${err instanceof Error ? err.message : String(err)}`);
    }
    for (const file of new Set(task.modify_existing.map((d) => d.file))) {
      if (!RULE_TEST_FILE.test(file)) {
        problems.push(`modify_existing: "${file}" is not a rule-test file (*.test.ts)`);
      } else if (!matchesAny(file, scope)) {
        problems.push(`modify_existing: "${file}" is not inside the task's ${scopeName}`);
      } else if (!matchesAny(file, class1)) {
        problems.push(
          `modify_existing: "${file}" is not a rule-test asset (class 1 of tools/guard/protected-paths.json)`,
        );
      } else if (!regularFile(join(root, file))) {
        problems.push(
          `modify_existing: "${file}" does not exist at the base (the trusted root): only a frozen test of a rule-test file that existed before the task can be changed`,
        );
      }
    }
  }

  // CT-06zxe (D10-371): registered expected values name rule-test files of the task's own
  // test_paths, and only a task with a rule-test author has a red run they matter to.
  if (task.expected_values.length > 0) {
    if (task.tester === 'none') {
      problems.push(
        'expected_values: a task without a rule-test author (tester: none) has no red run to register them for',
      );
    }
    for (const entry of task.expected_values) {
      if (!RULE_TEST_FILE.test(entry.file)) {
        problems.push(`expected_values: "${entry.file}" is not a rule-test file (*.test.ts)`);
      } else if (!matchesAny(entry.file, task.test_paths)) {
        problems.push(`expected_values: "${entry.file}" is not inside the task's test_paths`);
      }
    }
  }

  const missingGenerated = missingContractGenerated(task).filter((file) =>
    file === PLANNED_OPERATIONS_GENERATED
      ? !PLANNED_OPERATIONS_GEN_EXEMPT.has(task.id)
      : !CONTRACT_GENERATED_EXEMPT.has(task.id),
  );
  if (missingGenerated.length > 0) {
    const field = matchesAny(CONTRACT_SOURCE, task.paths) ? 'paths' : 'mechanical_paths';
    problems.push(
      `${field}: reach "${CONTRACT_SOURCE}", so the ledger must also cover the files regenerated from it (CT-06n, CT-06zxd); add: ${missingGenerated.join(', ')}`,
    );
  }

  if (task.paths.length === 0) {
    problems.push('paths: must not be empty');
  } else if (task.type === 'impl' || task.type === 'migration') {
    // Hard rule 3 (规划/11 §0) and §2.3 step 3: RV2 work needs rule tests written
    // by the other model.
    try {
      const report = (opts.risk ?? riskOfPaths)(task.paths);
      if (report.risk === 'RV2') {
        if (task.tester === 'none') {
          problems.push('tester: RV2 tasks need a rule-test author (规划/11 §2.3 step 3)');
        } else if (task.tester === task.impl) {
          problems.push(
            `tester: must differ from impl (${task.impl}) for RV2 tasks (规划/11 §0 rule 3)`,
          );
        }
      }
    } catch (err) {
      problems.push(`risk: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return problems;
}

export type CheckResult = { id: string; problems: string[] };

export function checkTasks(ids: readonly string[] = [], opts: CheckOptions = {}): CheckResult[] {
  const root = opts.root ?? repoRoot();
  const wanted = ids.length > 0 ? [...ids] : listTaskIds(root);
  // One guard call for the whole ledger instead of one per task (batchRisk): the path sets of
  // the tasks whose risk checkTask asks for.
  const risk = batchRisk(
    wanted.flatMap((id) => {
      try {
        const task = readTask(id, root);
        return task.type === 'impl' || task.type === 'migration' ? [task.paths] : [];
      } catch {
        return [];
      }
    }),
    riskSources(opts),
  );
  const results: CheckResult[] = [];
  for (const id of wanted) {
    try {
      results.push({ id, problems: checkTask(id, { ...opts, risk }) });
    } catch (err) {
      results.push({ id, problems: [err instanceof Error ? err.message : String(err)] });
    }
  }
  // Files that are not `<id>.yaml` would silently stay out of the ledger.
  if (ids.length === 0) {
    const dir = tasksDir(root);
    if (existsSync(dir)) {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (entry.name !== 'archive') {
            results.push({ id: entry.name, problems: ['unexpected directory in ops/tasks'] });
          }
        } else if (!entry.name.endsWith('.yaml') || !TASK_ID.test(entry.name.slice(0, -5))) {
          results.push({ id: entry.name, problems: ['file name is not <task id>.yaml'] });
        }
      }
    }
  }
  return results;
}

export type TaskView = TaskFile & {
  risk: RiskLevel;
  ask: boolean;
  risk_paths: RiskReport['paths'];
};

export function showTask(id: string, opts: CheckOptions = {}): TaskView {
  const task = readTask(id, opts.root ?? repoRoot());
  const report = (opts.risk ?? riskOfPaths)(task.paths);
  return { ...task, risk: report.risk, ask: report.ask, risk_paths: report.paths };
}

function main(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { json: { type: 'boolean', default: false } },
    allowPositionals: true,
  });
  const [cmd, ...rest] = positionals;
  if (cmd === 'check') {
    const results = checkTasks(
      rest.map((id) => assertTaskId(id)),
      {
        onRiskFallback: (reason) =>
          console.error(`notice: risk asked per task (${reason.split('\n')[0]})`),
      },
    );
    const failed = results.filter((r) => r.problems.length > 0);
    if (values.json) {
      console.log(JSON.stringify({ ok: failed.length === 0, tasks: results }, null, 2));
    }
    for (const r of failed) {
      for (const p of r.problems) console.error(`ops/tasks/${r.id}: ${p}`);
    }
    console.error(
      failed.length === 0
        ? `台账检查通过：${results.length} 个任务`
        : `台账检查失败：${failed.length} / ${results.length} 个任务有问题`,
    );
    return failed.length === 0 ? 0 : 1;
  }
  if (cmd === 'show') {
    if (!values.json) throw new UsageError('show needs --json');
    console.log(JSON.stringify(showTask(assertTaskId(rest[0])), null, 2));
    return 0;
  }
  if (cmd === 'hash') {
    const task = readTask(assertTaskId(rest[0]));
    const hashes = computeRefsHash(task.refs);
    if (values.json) {
      console.log(JSON.stringify(hashes, null, 2));
    } else {
      console.log('refs_hash:');
      for (const [ref, hash] of Object.entries(hashes)) {
        // An all-digit hash would be read back as a number: quote it.
        const scalar = /^[0-9]+(e[0-9]+)?$/.test(hash) ? `'${hash}'` : hash;
        console.log(`  ${ref}: ${scalar}`);
      }
    }
    return 0;
  }
  throw new UsageError('expected: check [id...] | show <id> --json | hash <id>');
}

if (import.meta.main) runMain(main);
