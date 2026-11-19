// Validates the `-o` file of a Codex run against its output schema (规划/11 §2.4 "成败判定")
// and, for review outputs, the rules of 规划/11 §3.1 and §3.3.
//
//   node validate-output.ts --schema <file> --file <json> [--money] [--refs <BR-…,BR-…>]
//                           [--allowed-paths <glob,glob>] [--rewrite] [--out-of-scope-log <md>]
//                           [--diff-base <ref> --cwd <dir>] [--json]
//
// Always: Ajv2020 strict validation against --schema.
// Review outputs (the schema has `findings`): non-empty summary; every finding and every
//   `out_of_scope` entry has a concrete scenario, a `file:line` and a stable key
//   `<file>#<function>#<rule id>` (the rule id may contain `#`); no key is in both lists. Only
//   `findings` decide the verdict: `pass` with an S0 / S1 finding is invalid, S0 / S1 entries
//   of `out_of_scope` never count.
// --refs (spec-test reviews; the task's BR refs, 规划/11 §2.5 owner decision 2026-10-02): a
//   finding whose `rule` cites only BR ids outside the refs belongs in `out_of_scope`. It is
//   reported as a warning and does not count toward the verdict (it neither forces `fail` nor
//   makes a `pass` contradictory).
// --allowed-paths <glob,glob> (spec-test reviews; the task's `paths`, owner decision 2026-10-02,
//   ops/approvals.yaml id 14): a finding counts toward the verdict only when it concerns
//   behaviour testable within the task's allowed paths plus the rule-test locations (class 1 of
//   tools/guard/protected-paths.json, read from this script's checkout). A finding whose `file`
//   lies outside both, or whose text cites repository paths that all lie outside both, is out
//   of scope, and so is a finding whose `rule` starts with the reviewer's scope marker
//   `[out-of-scope]`. Like the --refs case, it is reported as a warning and never counts.
// --rewrite (with a schema-valid, rule-valid review): writes the review back to --file with every
//   out-of-scope finding moved to `out_of_scope` and `verdict` recomputed from the in-scope
//   S0 / S1 findings only (fail when there is one, else pass).
// --out-of-scope-log <file> (with a valid review): appends every `out_of_scope` entry (the
//   reviewer's and the moved ones) whose key is not in the file yet to that Markdown file
//   (created when missing; codex-run.sh passes <runs>/<id>/out-of-scope.md), so later tasks can
//   turn them into rule tests.
// --money (资金评审清单必填): the seven checklist items are present exactly once, each with a
//   `file:line` and a note; with --diff-base every cited line lies inside the diff hunks of
//   that file (working tree of --cwd compared with the base ref, untracked files included).
//   An `na` item may carry no position (file "" and line 0); an `na` position outside the diff
//   is a warning, not an error (D10-2086).
//
// Exit codes: 0 valid, 1 invalid (problems on stderr, or as JSON with --json), 2 usage or
// internal error.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { readJsonFile, writeFileAtomic } from '../lib/fsx.ts';
import { git } from '../lib/git.ts';
import { matchesAny, splitTopLevelCommas } from '../lib/glob.ts';

export const CHECKLIST_ITEMS = [
  'rounding',
  'sign',
  'idempotency',
  'concurrency',
  'partial_refund',
  'clock',
  'app_id',
] as const;

export type Finding = {
  severity: 'S0' | 'S1' | 'S2';
  key: string;
  file: string;
  line: number;
  rule: string;
  scenario: string;
  suggestion: string;
};

export type ChecklistEntry = {
  item: (typeof CHECKLIST_ITEMS)[number];
  status: 'ok' | 'issue' | 'na';
  file: string;
  line: number;
  note: string;
};

export type ReviewOutput = {
  verdict: 'pass' | 'fail';
  summary: string;
  findings: Finding[];
  /** Findings about rules outside the task refs; they never count toward the verdict. */
  out_of_scope: Finding[];
  checklist: ChecklistEntry[];
};

/** Inclusive line range on the new side of a diff hunk (old side for pure deletions). */
export type LineRange = { start: number; end: number };

/** Answers whether `file:line` lies inside the diff; `reason` explains a negative answer. */
export type LineChecker = (file: string, line: number) => { ok: boolean; reason: string };

export type Report = { ok: boolean; errors: string[]; warnings: string[] };

/** What a spec-test finding is measured against (规划/11 §3.3, owner decisions 2026-10-02). */
export type ReviewScope = {
  /** The task's BR refs; a finding citing only other BR ids is out of scope. */
  refs?: readonly string[];
  /** The task's paths plus the rule-test locations; a finding about other paths is out of scope. */
  paths?: readonly string[];
};

export type ReviewOptions = {
  money: boolean;
  lineChecker?: LineChecker;
  refs?: readonly string[];
  paths?: readonly string[];
};

class UsageError extends Error {}

/** Ajv2020 strict validation; returns one message per violation (empty when valid). */
export function schemaErrors(schema: unknown, data: unknown): string[] {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    throw new Error('schema is not a JSON object');
  }
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  const validate = ajv.compile(schema);
  if (validate(data)) return [];
  return (validate.errors ?? []).map(
    (e) => `schema: ${e.instancePath === '' ? '(root)' : e.instancePath} ${e.message ?? e.keyword}`,
  );
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Extracts the citable line ranges from unified diff text of ONE file. */
export function parseHunks(diffText: string): LineRange[] {
  const ranges: LineRange[] = [];
  for (const line of diffText.split('\n')) {
    const m = HUNK_HEADER.exec(line);
    if (m === null) continue;
    const oldStart = Number(m[1]);
    const oldCount = m[2] === undefined ? 1 : Number(m[2]);
    const newStart = Number(m[3]);
    const newCount = m[4] === undefined ? 1 : Number(m[4]);
    if (newCount > 0) ranges.push({ start: newStart, end: newStart + newCount - 1 });
    else if (oldCount > 0) ranges.push({ start: oldStart, end: oldStart + oldCount - 1 });
  }
  return ranges;
}

function isSafeRelativePath(file: string): boolean {
  if (file === '' || isAbsolute(file) || file.includes('\\') || file.includes('\0')) return false;
  return !file.split('/').some((segment) => segment === '..' || segment === '');
}

function gitOrNull(args: readonly string[], cwd: string): string | null {
  try {
    return git(args, { cwd });
  } catch {
    return null;
  }
}

/** Builds a LineChecker from `git diff <base>` in `cwd` (untracked files count as all-new). */
export function gitLineChecker(base: string, cwd: string): LineChecker {
  if (gitOrNull(['rev-parse', '--verify', '--quiet', `${base}^{commit}`], cwd) === null) {
    throw new Error(`--diff-base ${base}: not a commit in ${cwd}`);
  }
  const cache = new Map<string, LineRange[] | string>();
  const rangesOf = (file: string): LineRange[] | string => {
    if (!isSafeRelativePath(file)) return 'not a repository-relative path';
    const inBase = gitOrNull(['cat-file', '-e', `${base}:${file}`], cwd) !== null;
    const tracked = gitOrNull(['ls-files', '--error-unmatch', '--', file], cwd) !== null;
    const onDisk = existsSync(join(cwd, file));
    if (!inBase && !tracked) {
      if (!onDisk) return 'file exists neither in the base ref nor in the worktree';
      // New, still untracked file: every line is part of the change.
      const lines = readFileSync(join(cwd, file), 'utf8').split('\n').length;
      return [{ start: 1, end: lines }];
    }
    const diff = gitOrNull(['diff', '--no-color', '--no-ext-diff', '-U3', base, '--', file], cwd);
    if (diff === null) return 'git diff failed';
    const ranges = parseHunks(diff);
    return ranges.length > 0 ? ranges : 'file is not changed in the diff';
  };
  return (file, line) => {
    let ranges = cache.get(file);
    if (ranges === undefined) {
      ranges = rangesOf(file);
      cache.set(file, ranges);
    }
    if (typeof ranges === 'string') return { ok: false, reason: ranges };
    const hit = ranges.some((r) => line >= r.start && line <= r.end);
    return { ok: hit, reason: hit ? '' : 'line is outside the diff hunks of this file' };
  };
}

// `<file>#<function>#<rule id>`: the file is everything before the first `#` and the function
// has no `#`; the rule id may itself contain `#` (an AC id such as `AC-F1-02r#18`, D10-234) but
// neither starts nor ends with one.
const KEY_PATTERN = /^[^#\s]+#[^#\s]+#[^#\s](?:\S*[^#\s])?$/;
const BR_ID = /BR-[A-Z]+-[0-9]+/g;

/** BR ids a finding's `rule` cites, when none of them is in `refs` (else an empty list). */
export function outsideRefs(rule: string, refs: readonly string[]): string[] {
  const cited = [...new Set(rule.match(BR_ID) ?? [])];
  return cited.length > 0 && !cited.some((id) => refs.includes(id)) ? cited : [];
}

/** The reviewer's own scope flag: a finding whose `rule` starts with it is out of scope. */
export const SCOPE_MARKER = '[out-of-scope]';

const REPO_PATH =
  /(?<![\w./@-])((?:apps|packages|db|contracts|test|specs|tools|ops|docs|\.github)\/[A-Za-z0-9_.@*{}\/-]*[A-Za-z0-9_*}\/-])/g;

/** Repository paths named in a text (`file:line` suffixes and trailing slashes dropped). */
export function citedPaths(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(REPO_PATH)) {
    const path = (m[1] ?? '').replace(/\/+$/, '');
    if (path !== '') out.add(path);
  }
  return [...out];
}

/** True when `path` (a file or a directory) lies inside one of `globs`. */
export function insidePaths(path: string, globs: readonly string[]): boolean {
  return matchesAny(path, globs) || matchesAny(`${path.replace(/\/+$/, '')}/x`, globs);
}

/** Why a finding is outside the review scope (empty when it is in scope). */
export function scopeReasons(f: Finding, scope: ReviewScope): string[] {
  const reasons: string[] = [];
  if (scope.refs !== undefined && scope.refs.length > 0) {
    const outside = outsideRefs(f.rule, scope.refs);
    if (outside.length > 0) {
      reasons.push(
        `rule cites ${outside.join(', ')}, outside the task refs (${scope.refs.join(', ')})`,
      );
    }
  }
  if (f.rule.trim().toLowerCase().startsWith(SCOPE_MARKER)) {
    reasons.push(`the reviewer marked it ${SCOPE_MARKER}`);
  }
  if (scope.paths !== undefined && scope.paths.length > 0) {
    const paths = scope.paths;
    if (!insidePaths(f.file, paths)) {
      reasons.push(
        `file ${f.file} is outside the task's allowed paths and the rule-test locations`,
      );
    } else {
      const cited = citedPaths(`${f.rule}\n${f.scenario}\n${f.suggestion}`);
      if (cited.length > 0 && !cited.some((p) => insidePaths(p, paths))) {
        reasons.push(
          `it cites only paths outside the task's allowed paths and the rule-test locations (${cited.join(', ')})`,
        );
      }
    }
  }
  return reasons;
}

const isBlocking = (f: Finding): boolean => f.severity === 'S0' || f.severity === 'S1';

/** Checks of 规划/11 §3.1 / §3.3 on a schema-valid review output. */
export function reviewProblems(
  review: ReviewOutput,
  opts: ReviewOptions,
): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (review.summary.trim() === '')
    errors.push('summary: empty (an empty conclusion is not a pass)');

  const checkEntry = (f: Finding, at: string): void => {
    if (f.scenario.trim() === '') errors.push(`${at}: scenario is empty (规划/11 §3.1)`);
    if (f.file.trim() === '' || f.line < 1) errors.push(`${at}: needs file and line >= 1`);
    if (!KEY_PATTERN.test(f.key)) {
      errors.push(`${at}: key must be "<file>#<function>#<rule id>" without spaces`);
    } else if (f.key.slice(0, f.key.indexOf('#')) !== f.file) {
      errors.push(`${at}: key must start with the same path as "file"`);
    }
  };
  review.findings.forEach((f, i) => checkEntry(f, `findings[${i}]`));
  review.out_of_scope.forEach((f, i) => checkEntry(f, `out_of_scope[${i}]`));
  const inScopeKeys = new Set(review.findings.map((f) => f.key));
  review.out_of_scope.forEach((f, i) => {
    if (inScopeKeys.has(f.key)) {
      errors.push(`out_of_scope[${i}]: key ${f.key} is also listed in findings`);
    }
  });

  // Findings outside the task scope (refs, allowed paths, reviewer's marker) do not count.
  const misplaced = misplacedFindings(review, opts);
  for (const [i, reasons] of misplaced) {
    warnings.push(
      `findings[${i}]: ${reasons.join('; ')}; it belongs in out_of_scope and does not count toward the verdict`,
    );
  }
  const blocking = review.findings.filter((f, i) => isBlocking(f) && !misplaced.has(i));
  if (review.verdict === 'pass' && blocking.length > 0) {
    // A contradictory review is not a usable output: the merge gate reads `verdict` alone
    // (规划/11 §3.2 评审无 S0 / S1), so "pass" must never carry blocking findings.
    errors.push(
      `verdict is "pass" but ${blocking.length} S0/S1 finding(s) are listed (a pass cannot carry blocking findings)`,
    );
  }
  if (
    review.verdict === 'fail' &&
    blocking.length === 0 &&
    review.findings.some((f, i) => isBlocking(f) && misplaced.has(i))
  ) {
    warnings.push(
      'verdict is "fail" only because of S0/S1 findings outside the task scope: within the task scope (refs, allowed paths) this review is a pass',
    );
  }

  if (opts.money) {
    for (const item of CHECKLIST_ITEMS) {
      const entries = review.checklist.filter((c) => c.item === item);
      if (entries.length !== 1) {
        errors.push(`checklist: "${item}" must appear exactly once (found ${entries.length})`);
      }
    }
    review.checklist.forEach((c, i) => {
      const at = `checklist[${i}] (${c.item})`;
      // An `na` item carries no position (file "" and line 0, review-money.md); an `na` position
      // outside the diff is dropped with a warning instead of invalidating the review (D10-2086).
      const na = c.status === 'na';
      if (na && c.file === '' && c.line === 0) {
        // No position: nothing to check against the diff.
      } else if (c.file.trim() === '' || c.line < 1) {
        errors.push(`${at}: needs file and line >= 1 (规划/11 §3.3)`);
      } else if (opts.lineChecker !== undefined) {
        const result = opts.lineChecker(c.file, c.line);
        if (!result.ok && na) {
          warnings.push(
            `${at}: status "na" cites ${c.file}:${c.line}, ${result.reason}; the position is dropped and does not invalidate the review`,
          );
        } else if (!result.ok) {
          errors.push(`${at}: ${c.file}:${c.line} ${result.reason}`);
        }
      }
      if (c.note.trim() === '') errors.push(`${at}: note is empty (state what was checked)`);
    });
    if (review.checklist.some((c) => c.status === 'issue') && review.findings.length === 0) {
      errors.push('checklist: an item has status "issue" but there is no finding');
    }
  }
  return { errors, warnings };
}

/** Index of each out-of-scope entry of `findings` with its reasons. */
function misplacedFindings(review: ReviewOutput, scope: ReviewScope): Map<number, string[]> {
  const out = new Map<number, string[]>();
  review.findings.forEach((f, i) => {
    const reasons = scopeReasons(f, scope);
    if (reasons.length > 0) out.set(i, reasons);
  });
  return out;
}

/**
 * The review as the gate reads it: out-of-scope findings moved to `out_of_scope` and the verdict
 * recomputed from the in-scope S0 / S1 findings only. `moved` lists the moved entries.
 */
export function normalizeReview(
  review: ReviewOutput,
  scope: ReviewScope,
): { review: ReviewOutput; moved: { finding: Finding; reasons: string[] }[] } {
  const misplaced = misplacedFindings(review, scope);
  const moved = [...misplaced].map(([i, reasons]) => ({
    finding: review.findings[i] as Finding,
    reasons,
  }));
  const findings = review.findings.filter((_, i) => !misplaced.has(i));
  return {
    review: {
      ...review,
      verdict: findings.some(isBlocking) ? 'fail' : 'pass',
      findings,
      out_of_scope: [...review.out_of_scope, ...moved.map((m) => m.finding)],
    },
    moved,
  };
}

/**
 * Appends the out-of-scope entries whose key is not yet in `file` (Markdown, created when
 * missing). `reasons` maps a key to why it was moved; the others were listed by the reviewer.
 * Returns the number of entries appended.
 */
export function appendOutOfScope(
  file: string,
  entries: readonly Finding[],
  reasons: ReadonlyMap<string, string[]>,
  context: { source: string; at: string },
): number {
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const line = (text: string): string => text.replace(/\s+/g, ' ').trim();
  const fresh = entries.filter(
    (f, i) =>
      !existing.includes(`- \`${f.key}\``) && entries.findIndex((g) => g.key === f.key) === i,
  );
  if (fresh.length === 0) return 0;
  const parts: string[] = [];
  if (existing === '') {
    parts.push(
      `# ${basename(dirname(resolve(file)))}: out-of-scope review findings`,
      '',
      'Appended by tools/agent/validate-output.ts (规划/11 §3.3; owner decisions 2026-10-02).',
      'Entries do not count toward the review verdict of this task; each is a candidate rule test',
      'for a later task (the task whose paths contain the behaviour). One entry per key.',
      '',
    );
  }
  parts.push(`## ${context.at} ${context.source}`, '');
  for (const f of fresh) {
    const why = reasons.get(f.key);
    parts.push(
      `- \`${f.key}\` ${f.severity} — ${line(f.rule)} — \`${f.file}:${f.line}\``,
      `  - source: ${why === undefined ? 'listed in out_of_scope by the reviewer' : `moved from findings: ${line(why.join('; '))}`}`,
      `  - scenario: ${line(f.scenario)}`,
      `  - suggestion: ${line(f.suggestion)}`,
    );
  }
  parts.push('');
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(
    file,
    `${existing !== '' && !existing.endsWith('\n') ? '\n' : ''}${parts.join('\n')}\n`,
  );
  return fresh.length;
}

/** Rule-test locations: class 1 (add-only test assets) of the protected-path list in `root`. */
export function ruleTestLocations(root: string): string[] {
  const doc = readJsonFile(join(root, 'tools', 'guard', 'protected-paths.json'));
  const list =
    typeof doc === 'object' && doc !== null
      ? (doc as Record<string, unknown>)['class1_add_only']
      : undefined;
  if (!Array.isArray(list) || !list.every((g) => typeof g === 'string')) {
    throw new Error('protected-paths.json: class1_add_only must be a list of globs');
  }
  return (list as string[]).map((g) =>
    g.lastIndexOf('#') > 0 ? g.slice(0, g.lastIndexOf('#')) : g,
  );
}

function isReviewSchema(schema: unknown): boolean {
  if (typeof schema !== 'object' || schema === null) return false;
  const properties = (schema as { properties?: unknown }).properties;
  return typeof properties === 'object' && properties !== null && 'findings' in properties;
}

/** Full validation of one output document. */
export function validateOutput(schema: unknown, data: unknown, opts: ReviewOptions): Report {
  const errors = schemaErrors(schema, data);
  const warnings: string[] = [];
  if (errors.length === 0 && isReviewSchema(schema)) {
    const problems = reviewProblems(data as ReviewOutput, opts);
    errors.push(...problems.errors);
    warnings.push(...problems.warnings);
  } else if (errors.length === 0 && opts.money) {
    throw new UsageError('--money applies to review outputs only');
  }
  return { ok: errors.length === 0, errors, warnings };
}

type CliArgs = {
  schema: string;
  file: string;
  money: boolean;
  json: boolean;
  rewrite: boolean;
  refs: string[];
  allowedPaths: string[];
  outOfScopeLog?: string;
  diffBase?: string;
  cwd?: string;
};

function parseArgs(argv: readonly string[]): CliArgs {
  const values = new Map<string, string>();
  const switches = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (arg === '--money' || arg === '--json' || arg === '--rewrite') {
      switches.add(arg);
    } else if (
      [
        '--schema',
        '--file',
        '--diff-base',
        '--cwd',
        '--refs',
        '--allowed-paths',
        '--out-of-scope-log',
      ].includes(arg)
    ) {
      const value = argv[i + 1];
      if (value === undefined) throw new UsageError(`${arg} needs a value`);
      values.set(arg, value);
      i += 1;
    } else {
      throw new UsageError(`unknown argument: ${arg}`);
    }
  }
  const schema = values.get('--schema');
  const file = values.get('--file');
  if (schema === undefined || file === undefined) {
    throw new UsageError('--schema <file> and --file <json> are required');
  }
  const diffBase = values.get('--diff-base');
  const cwd = values.get('--cwd');
  if ((diffBase === undefined) !== (cwd === undefined)) {
    throw new UsageError('--diff-base and --cwd must be given together');
  }
  const refs = (values.get('--refs') ?? '')
    .split(',')
    .map((r) => r.trim())
    .filter((r) => r !== '');
  for (const ref of refs) {
    if (!/^[A-Za-z0-9-]+$/.test(ref)) throw new UsageError(`--refs: invalid rule id "${ref}"`);
  }
  const allowedPaths = splitTopLevelCommas(values.get('--allowed-paths') ?? '')
    .map((g) => g.trim())
    .filter((g) => g !== '');
  for (const glob of allowedPaths) {
    if (!/^[A-Za-z0-9_.@*{},/-]+$/.test(glob) || glob.startsWith('/') || glob.includes('..')) {
      throw new UsageError(`--allowed-paths: invalid path glob "${glob}"`);
    }
  }
  if (values.has('--allowed-paths') && allowedPaths.length === 0) {
    throw new UsageError('--allowed-paths is empty');
  }
  const parsed: CliArgs = {
    schema,
    file,
    money: switches.has('--money'),
    json: switches.has('--json'),
    rewrite: switches.has('--rewrite'),
    refs,
    allowedPaths,
  };
  const log = values.get('--out-of-scope-log');
  if (log !== undefined) parsed.outOfScopeLog = log;
  return diffBase !== undefined && cwd !== undefined ? { ...parsed, diffBase, cwd } : parsed;
}

function main(argv: readonly string[]): number {
  const args = parseArgs(argv);
  if (!existsSync(args.file)) throw new UsageError(`--file ${args.file}: no such file`);
  const schema = readJsonFile(args.schema);
  // Rule-test locations come from this script's own checkout (the trusted copy), never the PR.
  const scopePaths =
    args.allowedPaths.length > 0
      ? [...args.allowedPaths, ...ruleTestLocations(resolve(import.meta.dirname, '..', '..'))]
      : [];

  let report: Report;
  let data: unknown;
  let parseError = '';
  try {
    data = JSON.parse(readFileSync(args.file, 'utf8'));
  } catch (error) {
    parseError = error instanceof Error ? error.message : String(error);
  }
  const opts: ReviewOptions = { money: args.money };
  if (parseError !== '') {
    report = { ok: false, errors: [`output is not valid JSON: ${parseError}`], warnings: [] };
  } else {
    const lineChecker =
      args.money && args.diffBase !== undefined && args.cwd !== undefined
        ? gitLineChecker(args.diffBase, args.cwd)
        : undefined;
    if (lineChecker !== undefined) opts.lineChecker = lineChecker;
    if (args.refs.length > 0) opts.refs = args.refs;
    if (scopePaths.length > 0) opts.paths = scopePaths;
    report = validateOutput(schema, data, opts);
  }

  const isReview = report.ok && isReviewSchema(schema);
  if ((args.rewrite || args.outOfScopeLog !== undefined) && !isReviewSchema(schema)) {
    throw new UsageError('--rewrite and --out-of-scope-log apply to review outputs only');
  }
  if (isReview && (args.rewrite || args.outOfScopeLog !== undefined)) {
    const raw = data as ReviewOutput;
    const { review, moved } = normalizeReview(raw, opts);
    if (args.rewrite) {
      if (review.verdict !== raw.verdict) {
        report.warnings.push(
          `verdict: the reviewer wrote "${raw.verdict}", recomputed "${review.verdict}" from the in-scope S0/S1 findings`,
        );
      }
      if (moved.length > 0 || review.verdict !== raw.verdict) {
        writeFileAtomic(args.file, `${JSON.stringify(review, null, 2)}\n`);
        report.warnings.push(
          `rewrote ${args.file}: ${moved.length} finding(s) moved to out_of_scope, verdict ${review.verdict}`,
        );
      }
    }
    if (args.outOfScopeLog !== undefined) {
      const reasons = new Map(moved.map((m) => [m.finding.key, m.reasons]));
      const added = appendOutOfScope(args.outOfScopeLog, review.out_of_scope, reasons, {
        source: `review ${basename(args.file)}`,
        at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
      });
      if (added > 0) {
        report.warnings.push(
          `appended ${added} out-of-scope entr${added === 1 ? 'y' : 'ies'} to ${args.outOfScopeLog}`,
        );
      }
    }
  }

  if (args.json) process.stdout.write(`${JSON.stringify(report)}\n`);
  for (const warning of report.warnings) process.stderr.write(`warning: ${warning}\n`);
  for (const problem of report.errors) process.stderr.write(`invalid: ${problem}\n`);
  if (report.ok) process.stderr.write('validate-output: ok\n');
  return report.ok ? 0 : 1;
}

if (import.meta.main) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`validate-output.ts: ${message}\n`);
    process.exitCode = 2;
  }
}
