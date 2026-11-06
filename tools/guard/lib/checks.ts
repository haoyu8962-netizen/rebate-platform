// The guard checks as functions returning a CheckResult. The CLIs in tools/guard/*.ts and
// run.ts are thin wrappers around these.
//
// Two roots are involved (规划/11 §2.4):
// - `root`: the tree under inspection (a task worktree, the main checkout, the verify copy);
// - trustedRoot(): where gate data is read from (task `paths`, protected-path list, risk map
//   for risk levels, banned-term list), so a branch cannot weaken its own gate.
// Checks that verify the consistency of the inspected tree itself (risk-map coverage, the
// AGENTS.md table, the embedded workflow copy) read both sides from `root`.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonFile } from '../../lib/fsx.ts';
import { changedBetweenCommits, changedFiles, listTree, showFile, tryGit } from '../../lib/git.ts';
import type { Change } from '../../lib/git.ts';
import { loadCodexImplMechanical } from '../../lib/codex-impl-tasks.ts';
import { loadLegacyTasks, ruleTestScope } from '../../lib/legacy-tasks.ts';
import { specRepo, trustedRoot } from '../../lib/paths.ts';
import { loadTask, parseTaskFile, TASK_ID_PATTERN } from '../../lib/task-file.ts';
import { checkAgentsPairs } from './agents-pair.ts';
import { extractTable, renderRiskTable } from './agents-table.ts';
import { parseAllow, parseTerms, scanText } from './banned-terms.ts';
import type { AllowEntry, Term } from './banned-terms.ts';
import { result, skipped } from './cli.ts';
import type { CheckResult } from './cli.ts';
import { scanFilesForHiddenUnicode } from './hidden-unicode.ts';
import { LEDGER_FILE, ledgerOverwriteProblems } from './ledger-overwrite.ts';
import { checkLockfile } from './lockfile.ts';
import { MIGRATIONS_DIR, migrationSequenceProblems } from './migration-sequence.ts';
import { checkPaths } from './path-guard.ts';
import type { PathGuardResult } from './path-guard.ts';
import { compareEmbedded, compareEmbeddedScript } from './protected-sync.ts';
import { findProtectedHits, gitReaders, loadProtected, splitFragment } from './protected.ts';
import type { ProtectedHit } from './protected.ts';
import { checkCoverage } from './risk-map-coverage.ts';
import { loadRiskMap } from './risk.ts';
import { lintSchema } from './schema-lint.ts';
import {
  MECHANICAL_TRAILER,
  MECHANICAL_VALUE,
  mechanicalProblems,
  parseRangeLog,
} from './mechanical.ts';
import { authorProblems, checkAuthorPaths } from './spec-base.ts';
import { checkSpecRef } from './spec-ref.ts';
import { addOnlyViolations, propTimeoutChecks, scanTree } from './test-guard.ts';
import type { Finding } from './test-guard.ts';
import { listTreeFiles } from './tree.ts';
import type { TreeListing } from './tree.ts';

export const SCHEMA_DIR = 'tools/agent/schemas';
export const PROTECTED_WORKFLOW = '.github/workflows/protected-paths.yml';
export const OWNER_APPROVAL_SCRIPT = 'tools/guard/lib/owner-approval.mjs';

/** schema-lint: explicit files (absolute or relative to the current directory), or the schema dir. */
export function schemaLintCheck(root: string, explicit: readonly string[] = []): CheckResult {
  const name = 'schema-lint';
  let files: { label: string; path: string }[];
  if (explicit.length > 0) {
    files = explicit.map((f) => ({ label: f, path: f }));
  } else {
    const dir = join(root, SCHEMA_DIR);
    if (!existsSync(dir)) return skipped(name, `${SCHEMA_DIR} does not exist yet`);
    files = readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .map((f) => ({ label: `${SCHEMA_DIR}/${f}`, path: join(dir, f) }));
    if (files.length === 0) return skipped(name, `${SCHEMA_DIR} contains no schema yet`);
  }
  const problems: string[] = [];
  for (const file of files) {
    try {
      problems.push(...lintSchema(readJsonFile(file.path), file.label));
    } catch (err) {
      problems.push(`${file.label}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return result(name, problems);
}

export function agentsPairCheck(root: string, tree: TreeListing): CheckResult {
  return result('agents-pair', checkAgentsPairs(root, tree.files));
}

export function riskMapCoverageCheck(root: string): CheckResult {
  const { problems, notices } = checkCoverage(root, loadRiskMap(root));
  return result('risk-map-coverage', problems, notices);
}

export function agentsTableCheck(root: string): CheckResult {
  const name = 'agents-table';
  const file = join(root, 'AGENTS.md');
  if (!existsSync(file)) return result(name, ['AGENTS.md is missing']);
  const expected = renderRiskTable(loadRiskMap(root));
  let actual: string;
  try {
    actual = extractTable(readFileSync(file, 'utf8'));
  } catch (err) {
    return result(name, [err instanceof Error ? err.message : String(err)]);
  }
  return result(
    name,
    actual === expected
      ? []
      : [
          'the 分工 table in AGENTS.md differs from ops/risk-map.yaml (run: node tools/guard/agents-table.ts --write)',
        ],
  );
}

export function protectedSyncCheck(root: string): CheckResult {
  const name = 'protected-sync';
  const workflow = join(root, PROTECTED_WORKFLOW);
  if (!existsSync(workflow)) return skipped(name, `${PROTECTED_WORKFLOW} does not exist yet`);
  const source = readJsonFile(join(root, 'tools', 'guard', 'protected-paths.json'));
  const text = readFileSync(workflow, 'utf8');
  const scriptFile = join(root, OWNER_APPROVAL_SCRIPT);
  const scriptProblems = existsSync(scriptFile)
    ? compareEmbeddedScript(readFileSync(scriptFile, 'utf8'), text)
    : [`${OWNER_APPROVAL_SCRIPT} is missing, so its embedded copy cannot be compared`];
  return result(
    name,
    [...compareEmbedded(source, text), ...scriptProblems].map((p) => `${PROTECTED_WORKFLOW}: ${p}`),
  );
}

function formatFinding(f: Finding): string {
  return `${f.file}:${f.line}: [${f.rule}] ${f.message}`;
}

export function testGuardStatic(root: string, tree: TreeListing): Finding[] {
  return scanTree(root, tree.files);
}

export function testGuardCheck(
  root: string,
  tree: TreeListing,
  base?: string,
): CheckResult & { findings: Finding[]; add_only_violations: ProtectedHit[] } {
  const findings = testGuardStatic(root, tree);
  const changes = base === undefined ? [] : changedFiles(base, { cwd: root });
  const addOnly =
    base === undefined ? [] : addOnlyViolations(changes, loadProtected(trustedRoot()));
  // CT-06zzzm (D10-750): explicit timeouts of property tests, in git mode only (test-guard.ts).
  if (base !== undefined) {
    const readOr = (read: () => string): string | null => {
      try {
        return read();
      } catch {
        return null;
      }
    };
    findings.push(
      ...propTimeoutChecks(
        changes,
        (p) => readOr(() => showFile(root, base, p)),
        (p) => readOr(() => readFileSync(join(root, p), 'utf8')),
      ),
    );
  }
  const problems = [...findings.map(formatFinding), ...addOnly.map(addOnlyProblem)];
  return { ...result('test-guard', problems), findings, add_only_violations: addOnly };
}

/** The test-guard problem line for a changed class 1 (add-only) test asset. */
export function addOnlyProblem(hit: ProtectedHit): string {
  return `${hit.path}: [add-only] existing test asset ${hit.change} (matches ${hit.rule})`;
}

/**
 * Turns the problems selected by `waived` into warnings (printed, not failing); the check fails
 * only when other problems remain. guard-git uses it for an owner-approved head (规划/11 §4.4):
 * every protected-paths problem and the add-only problems of test-guard; nothing else.
 */
export function waiveProblems(
  check: CheckResult,
  waived: (problem: string) => boolean,
  note: string,
): CheckResult {
  const warnings = check.problems.filter(waived);
  if (warnings.length === 0) return check;
  const problems = check.problems.filter((p) => !waived(p));
  return {
    ...check,
    status: problems.length === 0 ? 'pass' : 'fail',
    problems,
    notices: [...check.notices, note],
    warnings: [...(check.warnings ?? []), ...warnings],
  };
}

export function hiddenUnicodeCheck(root: string, tree: TreeListing): CheckResult {
  const { problems, notices } = scanFilesForHiddenUnicode(root, tree.files);
  return result('hidden-unicode', problems, notices);
}

/** Every URL in pnpm-lock.yaml is a clean https://registry.npmjs.org/ URL (规划/11 §8). */
export function lockfileCheck(root: string): CheckResult {
  const { problems, notices } = checkLockfile(root);
  return result('lockfile-urls', problems, notices);
}

/**
 * The planning repository is required wherever the inspected tree is a git checkout (host,
 * CI). The verify container has neither `.git` nor the planning repository: there the checks
 * that need it are skipped with a notice.
 */
export function specRepoRequired(root: string, allowMissing: boolean): boolean {
  return !allowMissing && existsSync(join(root, '.git'));
}

export function specRefCheck(root: string, opts: { requireSpecRepo: boolean }): CheckResult {
  return checkSpecRef(root, specRepo(), opts);
}

function loadTermConfig(): { terms: Term[]; allow: AllowEntry[] } {
  const dir = join(trustedRoot(), 'tools', 'guard');
  const allowFile = join(dir, 'banned-terms.allow.txt');
  return {
    terms: parseTerms(readFileSync(join(dir, 'banned-terms.txt'), 'utf8')),
    allow: existsSync(allowFile) ? parseAllow(readFileSync(allowFile, 'utf8')) : [],
  };
}

/** Scans `规划/**` of the planning repository at the SPEC_REF of `root`, through git only. */
export function bannedTermsSpecCheck(
  root: string,
  opts: { requireSpecRepo: boolean },
): CheckResult {
  const name = 'banned-terms';
  const repo = specRepo();
  if (!existsSync(repo)) {
    const notice = `planning repository not found at ${repo}; 规划/ not scanned`;
    return opts.requireSpecRepo ? result(name, [notice]) : skipped(name, notice);
  }
  const refFile = join(root, 'SPEC_REF');
  if (!existsSync(refFile)) return result(name, ['SPEC_REF is missing']);
  const ref = readFileSync(refFile, 'utf8').trim();
  if (!/^[0-9a-f]{40}$/.test(ref)) return result(name, ['SPEC_REF is not a commit id']);
  const { terms, allow } = loadTermConfig();
  const files = listTree(repo, ref, '规划');
  if (files.length === 0) return result(name, [`no files under 规划/ at ${ref}`]);
  const problems: string[] = [];
  for (const file of files) {
    const content = showFile(repo, ref, file);
    if (content.includes('\0')) continue;
    for (const hit of scanText(file, content, terms, allow)) {
      problems.push(`${hit.file}:${hit.line}: banned term "${hit.term}": ${hit.excerpt}`);
    }
  }
  return result(name, problems, [
    `scanned ${files.length} files under 规划/ at ${ref.slice(0, 12)}`,
  ]);
}

/** Scans the given files (task briefs); allow entries apply by the path as given. */
export function bannedTermsFilesCheck(files: readonly string[]): CheckResult {
  const { terms, allow } = loadTermConfig();
  const problems: string[] = [];
  for (const file of files) {
    let content: string;
    try {
      content = readFileSync(file, 'utf8');
    } catch {
      problems.push(`${file}: cannot be read`);
      continue;
    }
    for (const hit of scanText(file, content, terms, allow)) {
      problems.push(`${hit.file}:${hit.line}: banned term "${hit.term}": ${hit.excerpt}`);
    }
  }
  return result('banned-terms', problems);
}

export type PathGuardOutcome = { check: CheckResult; detail: PathGuardResult };

/** Path guard for a diff of `root` against `base`; `allowed` are the task's path globs. */
export function pathGuardCheck(
  root: string,
  base: string,
  allowed: readonly string[],
  taskType: string | undefined,
): PathGuardOutcome {
  const changes = changedFiles(base, { cwd: root });
  const hits = findProtectedHits(changes, loadProtected(trustedRoot()), gitReaders(root, base), {
    taskType,
  });
  const detail = checkPaths(changes, allowed, hits);
  const notices = [
    ...detail.out_of_scope_ops_docs.map(
      // TODO(规划/11 §2.3): revert out-of-scope ops/ and docs/ changes automatically and record
      // them — blocked on the orchestrator scripts in tools/ops (report only for now).
      (p) => `${p}: out-of-scope change under ops/ or docs/ (to be reverted by the orchestrator)`,
    ),
    ...detail.protected_hits.map((h) => `${h.path}: protected path, class ${h.class}`),
  ];
  return {
    check: result(
      'path-guard',
      detail.violations.map((v) => `${v.path}: ${v.reason}`),
      notices,
    ),
    detail,
  };
}

/**
 * Path guard of a task branch in guard-git (`run.ts git --task`), from `from` (the spec_commit or
 * the base) to HEAD plus the working tree. Without a commit marked `Couli-Mechanical:
 * contract-codegen` in the range it is pathGuardCheck, unchanged. With one (ops/approvals.yaml
 * id 31): every unmarked commit and the working tree are held to the ledger `paths`, each marked
 * commit to the mechanical rules (lib/mechanical.ts); a merge commit in the range fails closed.
 * `allowed` is the trusted list's `mechanical_paths` (tools/guard/codex-impl-tasks.json).
 */
export function taskPathGuardCheck(
  root: string,
  from: string,
  task: { paths: readonly string[]; type: string; mechanical_paths: readonly string[] },
  allowed: readonly string[] = loadCodexImplMechanical(trustedRoot()),
): CheckResult {
  const whole = pathGuardCheck(root, from, task.paths, task.type);
  const log = tryGit(
    [
      'log',
      '-z',
      `--format=%H%x1f%P%x1f%(trailers:key=${MECHANICAL_TRAILER},valueonly,separator=%x1e)`,
      `${from}..HEAD`,
      '--',
    ],
    { cwd: root },
  );
  if (log.status !== 0) {
    return result('path-guard', [`cannot list the commits ${from.slice(0, 12)}..HEAD`]);
  }
  const commits = parseRangeLog(log.stdout);
  const marked = commits.filter((c) => c.mechanical.length > 0);
  if (marked.length === 0) return whole.check;

  const problems: string[] = [];
  const unmarked: Change[] = [];
  for (const commit of commits) {
    const label = `commit ${commit.sha.slice(0, 12)}`;
    if (commit.parents.length !== 1) {
      problems.push(
        `${label}: a merge or root commit next to a ${MECHANICAL_TRAILER} commit (rebase the branch; fail-closed)`,
      );
      continue;
    }
    const parent = commit.parents[0] ?? '';
    const changes = changedBetweenCommits(parent, commit.sha, { cwd: root });
    if (commit.mechanical.length === 0) {
      unmarked.push(...changes);
      continue;
    }
    if (commit.mechanical.some((v) => v !== MECHANICAL_VALUE)) {
      problems.push(
        `${label}: ${MECHANICAL_TRAILER} must be exactly "${MECHANICAL_VALUE}" (got "${commit.mechanical.join(', ')}")`,
      );
      continue;
    }
    const show = (ref: string) => (path: string) => {
      const res = tryGit(['show', `${ref}:${path}`], { cwd: root });
      return res.status === 0 ? res.stdout : null;
    };
    problems.push(
      ...mechanicalProblems(label, changes, {
        ledger: task.mechanical_paths,
        allowed,
        before: show(parent),
        after: show(commit.sha),
      }),
    );
  }
  unmarked.push(...changedFiles('HEAD', { cwd: root }));
  const detail = checkPaths(unmarked, task.paths, []);
  problems.unshift(...detail.violations.map((v) => `${v.path}: ${v.reason}`));
  return result('path-guard', problems, [
    `${marked.length} commit(s) marked ${MECHANICAL_TRAILER}: ${MECHANICAL_VALUE} checked against the mechanical_paths ` +
      '(ops/approvals.yaml id 31); every other commit and the working tree against the task paths',
    ...detail.out_of_scope_ops_docs.map(
      (p) => `${p}: out-of-scope change under ops/ or docs/ (to be reverted by the orchestrator)`,
    ),
    ...whole.detail.protected_hits.map((h) => `${h.path}: protected path, class ${h.class}`),
  ]);
}

/** Class 1 of the trusted protected-path list: every rule-test asset (fragments removed). */
export function ruleTestAssets(): string[] {
  return loadProtected(trustedRoot()).class1_add_only.map((g) => splitFragment(g).glob);
}

/**
 * The rule-test author's part of a task branch, base..spec_commit (规划/11 §2.3 step 3; owner
 * decision 2026-10-02): only rule-test assets (class 1 of the trusted protected-path list), the
 * ops/tasks ledger and NotImplemented skeleton shells inside the task paths (lib/spec-base.ts).
 */
export function authorPathsCheck(
  root: string,
  base: string,
  specCommit: string,
  task: { id: string; tester: string; paths: readonly string[]; test_paths: readonly string[] },
): CheckResult {
  // The task's test_paths. Only a ledger of the switch baseline (tools/guard/legacy-tasks.json,
  // read from the trusted root) may have none and keep the old scope (all rule-test assets);
  // any other task without test_paths gets no rule-test asset at all (CR2-02, fail-closed).
  const legacyList = loadLegacyTasks(trustedRoot());
  const legacy = legacyList.has(task.id);
  const testPaths = task.test_paths;
  const taskPaths = task.paths;
  const testAssets = ruleTestScope(
    { id: task.id, test_paths: [...testPaths] },
    legacyList,
    ruleTestAssets(),
  );
  const changes = changedBetweenCommits(base, specCommit, { cwd: root });
  const show = (ref: string, path: string): string | null => {
    const res = tryGit(['show', `${ref}:${path}`], { cwd: root });
    return res.status === 0 ? res.stdout : null;
  };
  const problems = authorProblems(changes, {
    taskPaths,
    testAssets,
    contentAtSpec: (path) => show(specCommit, path),
    contentAtBase: (path) => show(base, path),
    // CR3-02: a legacy ledger's skeletons were written under the old rule (the NotImplemented
    // keyword); the statement-by-statement check applies to the other tasks.
    legacySkeleton: legacy,
  });
  if (testPaths.length === 0 && !legacy && task.tester !== 'none') {
    problems.unshift(
      `task ${task.id} has no test_paths and is not a ledger of the switch baseline ` +
        '(tools/guard/legacy-tasks.json): add test_paths to its ledger',
    );
  }
  return result('path-guard-author', problems, [
    `${changes.length} path(s) changed by the rule-test commits ${base.slice(0, 12)}..${specCommit.slice(0, 12)}`,
  ]);
}

/**
 * Path guard of a rule-test run (`path-guard.ts --author`): the working tree of `root` against
 * `base` may only hold rule-test assets and NotImplemented skeleton shells inside the task
 * paths (lib/spec-base.ts checkAuthorPaths; default split of 2026-10-05, ops/approvals.yaml
 * id 19). Out-of-scope ops/ and docs/ changes are reported apart, as in pathGuardCheck.
 */
export function authorWorktreeCheck(
  root: string,
  base: string,
  taskPaths: readonly string[],
  taskType: string | undefined,
  testPaths: readonly string[],
  taskId?: string,
): PathGuardOutcome {
  // A legacy ledger (tools/guard/legacy-tasks.json) without test_paths keeps the old scope, all
  // rule-test assets; any other task without test_paths gets none (CR-06, CR2-02, CR3-01).
  const legacyList = loadLegacyTasks(trustedRoot());
  const legacy = taskId !== undefined && legacyList.has(taskId);
  const protectedList = loadProtected(trustedRoot());
  const changes = changedFiles(base, { cwd: root });
  const hits = findProtectedHits(changes, protectedList, gitReaders(root, base), { taskType });
  // Only the task's own test_paths (CR-06): no test_paths, no rule-test asset is allowed.
  const detail = checkAuthorPaths(
    changes,
    {
      taskPaths,
      testAssets: ruleTestScope(
        { id: taskId ?? '', test_paths: [...testPaths] },
        legacyList,
        protectedList.class1_add_only.map((g) => splitFragment(g).glob),
      ),
      legacySkeleton: legacy,
      contentAtSpec: (path) => {
        const file = join(root, path);
        return existsSync(file) ? readFileSync(file, 'utf8') : null;
      },
      contentAtBase: (path) => {
        const res = tryGit(['show', `${base}:${path}`], { cwd: root });
        return res.status === 0 ? res.stdout : null;
      },
    },
    hits,
  );
  if (testPaths.length === 0 && !legacy) {
    detail.ok = false;
    detail.violations.unshift({
      path: 'ops/tasks',
      reason: 'the task has no test_paths: add them to the ledger before the test phase (CR-06)',
    });
  }
  return {
    check: result(
      'path-guard-author',
      detail.violations.map((v) => `${v.path}: ${v.reason}`),
      [
        ...detail.out_of_scope_ops_docs.map(
          (p) =>
            `${p}: out-of-scope change under ops/ or docs/ (to be reverted by the orchestrator)`,
        ),
        ...detail.protected_hits.map((h) => `${h.path}: protected path, class ${h.class}`),
      ],
    ),
    detail,
  };
}

function assertBase(base: string): void {
  if (base === '' || base.startsWith('-')) throw new Error(`invalid base: "${base}"`);
}

/**
 * Where the inspected branch forked from `base`: their merge base, so a branch behind the base
 * is held to its own changes only; `base` itself when git cannot tell (unrelated histories, a
 * base that is not a commit), which then counts every difference as the branch's.
 */
export function forkPoint(root: string, base: string): { ref: string; notice: string | null } {
  assertBase(base);
  const resolved = tryGit(['rev-parse', '--verify', '--quiet', `${base}^{commit}`], { cwd: root });
  const merge = tryGit(['merge-base', base, 'HEAD'], { cwd: root });
  const sha = merge.stdout.trim();
  if (resolved.status !== 0 || merge.status !== 0 || !/^[0-9a-f]{40,64}$/.test(sha)) {
    return {
      ref: base,
      notice: `no merge base of ${base.slice(0, 12)} and HEAD; compared with ${base.slice(0, 12)} itself`,
    };
  }
  if (sha === resolved.stdout.trim()) return { ref: sha, notice: null };
  return {
    ref: sha,
    notice: `the branch forked from ${sha.slice(0, 12)}, behind ${base.slice(0, 12)}: compared with the fork point`,
  };
}

/**
 * ledger-overwrite (CT-06q): a task file that exists at the fork point keeps its id, type and
 * title, a done one stays done, and none is deleted or renamed (lib/ledger-overwrite.ts). Not
 * waived by the owner label.
 */
export function ledgerOverwriteCheck(root: string, base: string): CheckResult {
  const name = 'ledger-overwrite';
  const fork = forkPoint(root, base);
  const changes = changedFiles(fork.ref, { cwd: root }).filter(
    (c) => LEDGER_FILE.test(c.path) || (c.oldPath !== undefined && LEDGER_FILE.test(c.oldPath)),
  );
  const problems = ledgerOverwriteProblems(changes, {
    before: (path) => {
      const res = tryGit(['show', `${fork.ref}:${path}`], { cwd: root });
      return res.status === 0 ? res.stdout : null;
    },
    after: (path) => {
      const file = join(root, path);
      return existsSync(file) ? readFileSync(file, 'utf8') : null;
    },
  });
  return result(name, problems, [
    ...(fork.notice === null ? [] : [fork.notice]),
    `${changes.length} task file(s) changed since ${fork.ref.slice(0, 12)}`,
  ]);
}

/**
 * migration-sequence (CT-06q): the migrations the inspected tree adds to `base` (the base tip,
 * not the fork point: what was merged meanwhile counts) continue its numbering without a gap,
 * a repeat or a number the base already has (lib/migration-sequence.ts). Not waived by the
 * owner label.
 */
export function migrationSequenceCheck(root: string, base: string): CheckResult {
  const name = 'migration-sequence';
  assertBase(base);
  const listing = tryGit(
    ['-c', 'core.quotepath=false', 'ls-tree', '-z', base, `${MIGRATIONS_DIR}/`],
    { cwd: root },
  );
  if (listing.status !== 0) {
    return result(name, [
      `cannot list ${MIGRATIONS_DIR} at ${base.slice(0, 12)}: ${listing.stderr.trim()}`,
    ]);
  }
  const prefix = `${MIGRATIONS_DIR}/`;
  const baseNames: string[] = [];
  for (const entry of listing.stdout.split('\0')) {
    // "<mode> <type> <object>\t<path>": only blobs directly under the directory are migrations.
    const tab = entry.indexOf('\t');
    if (tab === -1) continue;
    const [, type] = entry.slice(0, tab).split(' ');
    const path = entry.slice(tab + 1);
    if (type === 'blob' && path.startsWith(prefix)) baseNames.push(path.slice(prefix.length));
  }
  const headNames = listTreeFiles(root)
    .files.filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'))
    .map((p) => p.slice(prefix.length));
  const { problems, notices } = migrationSequenceProblems(baseNames, headNames);
  // The tree listing leaves symbolic links out, so a link named like a migration would pass
  // unseen (Codex review r1, S2): every entry of the directory that is not a regular file or a
  // directory is refused by name, whether git tracks or ignores it.
  const dir = join(root, MIGRATIONS_DIR);
  if (existsSync(dir)) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() || entry.isDirectory()) continue;
      problems.push(
        `${prefix}${entry.name}: 不是普通文件（${entry.isSymbolicLink() ? '符号链接' : '特殊文件'}），迁移只能是普通文件`,
      );
    }
  }
  return result(name, problems, notices);
}

export type ProtectedOutcome = { check: CheckResult; hits: ProtectedHit[] };

export function protectedPathsCheck(
  root: string,
  base: string,
  taskType: string | undefined,
): ProtectedOutcome {
  const hits = findProtectedHits(
    changedFiles(base, { cwd: root }),
    loadProtected(trustedRoot()),
    gitReaders(root, base),
    { taskType },
  );
  return {
    check: result(
      'protected-paths',
      hits.map((h) => `${h.path}: class ${h.class} (${h.rule}) ${h.change}`),
    ),
    hits,
  };
}

/** Task definition from the trusted root: a branch cannot widen its own `paths`. */
export function trustedTask(id: string): {
  paths: string[];
  type: string;
  test_paths: string[];
  mechanical_paths: string[];
  tester: string;
} {
  const task = loadTask(id, trustedRoot());
  return {
    paths: task.paths,
    type: task.type,
    test_paths: task.test_paths,
    mechanical_paths: task.mechanical_paths,
    tester: task.tester,
  };
}

export type GuardTask = {
  paths: string[];
  test_paths: string[];
  mechanical_paths: string[];
  tester: string;
  type: string;
  source: 'trusted' | 'head';
  notice: string | null;
};

/**
 * Task definition for `run.ts git --task <id>` (owner decision 2026-10-02, ops/approvals.yaml
 * id 17): from the trusted root as before; only when the trusted root has no
 * `ops/tasks/<id>.yaml` AND the pull request itself adds that file (absent at `base`, present
 * in the committed `HEAD` of `root`) is the ledger read from the head. The id comes from the
 * task branch name, so a branch can only bring the ledger of its own task, never change one
 * that is already on the base; every other guard still reads the trusted root.
 */
export function guardTask(id: string, root: string, base: string): GuardTask {
  if (!TASK_ID_PATTERN.test(id)) throw new Error(`invalid task id: "${id}"`);
  if (base === '' || base.startsWith('-')) throw new Error(`invalid base: "${base}"`);
  const rel = `ops/tasks/${id}.yaml`;
  const trustedFile = join(trustedRoot(), rel);
  if (existsSync(trustedFile)) return { ...trustedTask(id), source: 'trusted', notice: null };
  const atBase = tryGit(['cat-file', '-e', `${base}:${rel}`], { cwd: root });
  if (atBase.status === 0) {
    throw new Error(
      `task file not found: ${trustedFile} (the base has ${rel}; the trusted copy is stale)`,
    );
  }
  const atHead = tryGit(['show', `HEAD:${rel}`], { cwd: root });
  if (atHead.status !== 0) {
    throw new Error(`task file not found: ${trustedFile}, and HEAD does not add ${rel}`);
  }
  const task = parseTaskFile(atHead.stdout, rel);
  return {
    paths: task.paths,
    test_paths: task.test_paths,
    mechanical_paths: task.mechanical_paths,
    tester: task.tester,
    type: task.type,
    source: 'head',
    notice:
      `task ${id}: no ${rel} on the base; the ledger is the one this pull request adds ` +
      '(read from HEAD, ops/approvals.yaml id 17)',
  };
}
