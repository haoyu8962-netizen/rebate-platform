// Required check `evidence-check` (规划/11 §3.2): an RV2 pull request carries a complete
// evidence file, the rule-test commit is an ancestor whose rule tests were not changed since,
// and the verified tree is the tree being merged.
//
//   node tools/ci/evidence-check.ts --pr <dir> --base <sha> --head <sha> --head-ref <branch>
//     [--pr-number <n>] [--json]
//
// Runs from the BASE copy of the repository (CI checks out `tools/ci` of the base branch, the
// way guard-git does), with the PR checkout as data: the risk map and the protected-path list
// come from this script's own checkout, never from the PR.
//
// What is checked, per risk level (computed by tools/guard/lib/risk.ts from the changed paths):
//   RV0 / RV1  pass; an evidence file for the task, when present, is validated all the same.
//   RV2        ops/evidence/<id>.json must exist at the head (id from the branch `task/<id>`):
//              task id, spec_ref = SPEC_REF of the head, spec_commit is an ancestor of the head
//              and no class 1 test asset changed between it and the head, the review of the
//              side other than the implementer passes with no open S0 / S1, every recorded
//              directory tree hash equals the head's, long-run result bound to one of those trees.
//              Reviews (owner decision 2026-10-09, ops/approvals.yaml id 27): the required entry
//              is the one of the side that did not implement. Ledger impl: claude (Opus
//              implemented): the codex entry (pass, open_s0_s1 0, checklist complete); a claude
//              entry is optional and validated when present. Ledger impl: codex (ops/approvals.yaml
//              id 23): the claude entry; a codex entry is optional and validated when present.
//              A ledger that cannot be read requires both (fail-closed). A PR commit carrying the
//              handover marker without a handover record counts as impl: codex. The handover of
//              规划/11 §2.5 is handled below.
//              Independent Claude (owner decision 2026-10-21, ops/approvals.yaml id 36): when Codex
//              is not available, a fresh Claude context (tools/agent/claude-run.sh) may stand in
//              for either side: an entry with reviewer "claude-independent" satisfies a required
//              codex or claude entry, with the same conditions (pass, open_s0_s1 0, checklist
//              complete). An entry must say truthfully which engine produced it: every entry
//              carries `engine`, equal to its reviewer ("codex", "claude-independent", "claude"),
//              and a codex / claude-independent entry the model of that engine (gpt-6-astra,
//              claude-opus-5-5), so a Claude review cannot be filed as Codex's.
//              Handover (规划/11 §2.5, CR-09): when Opus used up its rounds and Codex implemented
//              once, the evidence carries `handover` and only the Claude review of the handover
//              implementation must pass (Codex never reviews its own code). Allowed only when the
//              task ledger's paths are below RV2, no money / attribution implementation path
//              changed and the changed paths outside the rule-test assets, the task's own ledger
//              and evidence files and docs/** are below RV2 (RV2 不换家, hard rule 3); otherwise
//              the handover is refused. guard-git's path guard keeps every change inside the
//              ledger paths independently of this check.
//              Full verification (owner decision 2026-10-06, ops/approvals.yaml id 21): the
//              required CI checks of the pull request on its head (ci-gate: verify-fast,
//              verify-int, guard-git; contracts-gate; longrun-props) are the verification, so no
//              container run of `verify` is required here. The workflows and the verify recipe are
//              protected paths (.github/** class 3, package.json scripts and verify configs class
//              2), so a pull request cannot weaken what CI runs without an owner label.
//              Runs (CR-02): a container run of the full `verify` script (`script: "verify"`) may
//              still be listed and then must be green on the head tree; `verify:fast` (the
//              implementer's own check) and `host` are refused as evidence. A container red run
//              (`script: "red"`,
//              tools/ops/verify-container.sh --red) must have passed red-check (exit 0), list its
//              red tests and have verified the spec_commit tree.
//              Red run (CR2-05, CR3-03): every task except one without a rule-test author
//              (tester: none) and the legacy ledgers (tools/guard/legacy-tasks.json) needs a valid container red run: script red, exit 0 (red-check passed), on the
//              spec_commit tree, its `expected` list covering every rule-test file the task
//              added inside its test_paths (base..spec_commit), each with a red test.
//              Declared red exemptions (CT-06r): when the trusted ledger declares `red_exempt`
//              entries (unchanged tests of a data-driven rule-test file that may read a changed
//              test-support file, which red-check lets pass on the skeleton), the evidence's
//              `spec_test_review` must record the rule-test reviewer's confirmation:
//              `red_exempt_confirmed: true`, `reviewer` the side that did not write the rule
//              tests (ledger tester codex → claude, claude → codex), `last_verdict: pass`; also
//              "claude-independent" for either (ops/approvals.yaml id 36), and for a ledger tester
//              claude-independent the reviewer is claude or another claude-independent call.
//              Every expected file still needs a red test; MONEY_PATHS are unchanged.
//              CT-06zzzc (D10-623): a ledger with `red_exempt_outside` (files whose changed code
//              outside the tests keeps their red_exempt in force; red-check lists the changed
//              lines) needs the same confirmation, red_exempt_confirmed true.
//              Declared renames (CT-06zxc, D10-347): a rule-test file whose base, with the
//              ledger's literal `renames` applied, is its spec_commit content is unchanged and
//              not expected (red-check leaves it out of the red run the same way). When a
//              declared rename hits the base of a rule-test file of the task (or leaves one out),
//              `spec_test_review` must record the rule-test reviewer's confirmation as for
//              red_exempt (reviewer, last_verdict pass) with `renames_confirmed: { pairs: [{ from,
//              to }] — exactly the pairs that hit, in ledger order —, left_out: [files] — exactly
//              the files left out }` (review r1 S2-1); no hit, nothing required.
//              Registered expected values (CT-06zxe, D10-371): when an entry of the ledger's
//              `expected_values` applies to the base of a rule-test file of the task (after the
//              renames; red-check then needs only the tests calling that helper red),
//              `spec_test_review` must record the rule-test reviewer's confirmation as for
//              red_exempt with `expected_values_confirmed: { entries: [{ file, helper, from, to
//              }] }` — exactly the entries that apply, in ledger order; no hit, nothing required.
//              A hit is an entry that can be applied to the base, whether or not red-check then
//              judges the file by the helpers' impact (the head may not make that change, or may
//              change more outside the tests: the file is judged whole, the confirmation is still
//              asked — one more confirmation, never a looser check).
//              The expected list is unchanged by them (such a file still needs a red test).
//              CI records (`mode: ci`) in the evidence file are refused (CR2-06): nothing a copied
//              record says can be checked against a run; the CI checks count by themselves.
//              Owner waiver (owner decision 2026-10-02, ops/approvals.yaml id 12): on a branch
//              that is not task/<id> (test-change and gate-change PRs), the evidence file is
//              not required when the PR carries a valid owner approval label for the head (the
//              label check of the protected-paths workflow, tools/guard/lib/owner-approval.mjs;
//              looked up only with --pr-number) AND no changed path is a money / attribution
//              implementation path (MONEY_PATHS). Touching one keeps the requirement exactly as
//              before. Task branches are never waived.
//   Migration rename hotfix (ops/approvals.yaml id 32): on branch fix/migration-<NNNN>-collision a
//              change that only renames colliding migrations exactly (and replaces their file names
//              in non-SQL text and db/schema.sql) needs no task branch and no evidence file; the
//              conditions are in migrationRename. Protected paths and their label are unchanged.
// It prevents omissions, not malice (规划/11 §3.2). Exit codes: 0 ok, 1 failed, 2 usage.
//
// TODO(规划/11 §3.2): `run_attempt` > 1 on funds paths (不许重跑到绿) needs the Actions API and
//   a remote — blocked on GitHub remote.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { git, tryGit } from '../lib/git.ts';
import type { Change } from '../lib/git.ts';
import { loadLegacyTasks } from '../lib/legacy-tasks.ts';
import { parseTaskFile } from '../lib/task-file.ts';
import type { ExpectedValueDeclaration, RenameDeclaration, TaskFile } from '../lib/task-file.ts';
import {
  expectedRuleTests,
  expectedValuesHit,
  renamedOnlyFiles,
  renamesHit,
} from '../guard/lib/red-check.ts';
import { matchesAny } from '../lib/glob.ts';
import { loadProtected, splitFragment } from '../guard/lib/protected.ts';
import type { ProtectedConfig } from '../guard/lib/protected.ts';
import { ownerApprovalFromEnv } from '../guard/lib/owner-approval-env.ts';
import type { OwnerApproval } from '../guard/lib/owner-approval-env.ts';
import { loadRiskMap, riskOfPaths } from '../guard/lib/risk.ts';
import { COMMIT_ID, isAncestor } from '../guard/lib/spec-base.ts';
import type { RiskLevel } from '../guard/lib/risk.ts';

/**
 * Money and attribution implementation paths (owner decision 2026-10-02): a PR touching any of
 * them needs the evidence file even with an owner approval label. Matched case-insensitively.
 */
export const MONEY_PATHS: readonly string[] = [
  'packages/money/src/**',
  'packages/domain/src/**',
  'apps/api/src/modules/{ledger,commission,settlement,payout,withdrawals,reconciliation,orders,linking,union,payment}/**',
  'db/migrations/**',
];

/**
 * Branch of a pure migration rename hotfix (ops/approvals.yaml id 32): `fix/migration-<NNNN>-collision`,
 * NNNN the migration number that two merged migrations share.
 */
export const MIGRATION_RENAME_BRANCH = /^fix\/migration-([0-9]{4})-collision$/;
const MIGRATION_FILE = /^db\/migrations\/([0-9]{4})_[a-z0-9]+(?:-[a-z0-9]+)*\.sql$/;

export type MigrationRename = {
  /** The branch is `fix/migration-<NNNN>-collision`. */
  branch: boolean;
  /** Every condition holds: the change is a pure rename of colliding migrations. */
  ok: boolean;
  problems: string[];
  renames: { from: string; to: string }[];
};

/** Migration file numbers directly under db/migrations at `ref` (null when a name is malformed). */
function migrationNumbers(prDir: string, ref: string): { numbers: number[]; bad: string[] } {
  const res = tryGit(
    ['-c', 'core.quotepath=false', 'ls-tree', '-z', '--name-only', `${ref}`, 'db/migrations/'],
    { cwd: prDir },
  );
  const names = res.status === 0 ? res.stdout.split('\0').filter((f) => f !== '') : [];
  const numbers: number[] = [];
  const bad: string[] = [];
  for (const name of names) {
    const m = MIGRATION_FILE.exec(name);
    if (m === null) bad.push(name);
    else numbers.push(Number(m[1]));
  }
  return { numbers: numbers.sort((a, b) => a - b), bad };
}

/**
 * Pure migration rename hotfix (ops/approvals.yaml id 32, 规划/11 §7.3 第 11 项): two parallel
 * lines merged migrations with the same number (2026-10-09 two 0025, #381; 2026-10-16 two 0031),
 * so packages/db migrations.test is red on main and every PR's ci-gate fails, while a rename on a
 * non-task branch was refused here (db/migrations is a MONEY_PATHS entry) and a task branch needs a
 * ledger PR first, which cannot pass ci-gate either. Allowed, all of:
 * - the branch is `fix/migration-<NNNN>-collision` and the merge base has at least two migrations
 *   numbered NNNN;
 * - every changed migration is an exact rename (git rename with 100% similarity and the same blob)
 *   of a db/migrations/NNNN_*.sql file to another well-formed migration file name: no migration is
 *   added, deleted or edited, and nothing else under db/migrations changes;
 * - after the renames the migration numbers at the head are 1..n with no duplicate and no gap;
 * - any other changed file is a modified text file (not .sql except db/schema.sql, not under a
 *   money / attribution implementation path) whose head content is exactly its base content with
 *   every renamed file name replaced by its new name (a file-name reference, nothing else).
 * Then no task branch and no evidence file are required. guard-git and protected-paths are
 * unchanged: db/migrations stays a protected path and needs the owner approval label.
 */
export function migrationRename(
  prDir: string,
  mergeBase: string,
  head: string,
  headRef: string,
): MigrationRename {
  const branch = MIGRATION_RENAME_BRANCH.exec(headRef);
  const result: MigrationRename = { branch: branch !== null, ok: false, problems: [], renames: [] };
  if (branch === null) return result;
  const number = Number(branch[1]);
  const problems = result.problems;

  const before = migrationNumbers(prDir, mergeBase);
  if (before.numbers.filter((n) => n === number).length < 2) {
    problems.push(`the merge base has no two migrations numbered ${branch[1]}`);
  }

  // -M100%: only exact renames pair up; an edited rename shows as a deletion and an addition.
  const out = tryGit(
    [
      '-c',
      'core.quotepath=false',
      'diff',
      '--name-status',
      '-z',
      '-M100%',
      '--no-ext-diff',
      mergeBase,
      head,
      '--',
    ],
    { cwd: prDir },
  );
  if (out.status !== 0) {
    problems.push(`git diff ${mergeBase}..${head} failed`);
    return result;
  }
  const fields = out.stdout.split('\0');
  const modified: string[] = [];
  for (let i = 0; i < fields.length;) {
    const status = fields[i++] ?? '';
    if (status === '') continue;
    const code = status[0] ?? '';
    if (code === 'R') {
      const from = fields[i++] ?? '';
      const to = fields[i++] ?? '';
      const fromFile = MIGRATION_FILE.exec(from);
      const same =
        treeOf(prDir, mergeBase, from) !== null &&
        treeOf(prDir, mergeBase, from) === treeOf(prDir, head, to);
      if (fromFile === null || Number(fromFile[1]) !== number) {
        problems.push(`${from} → ${to}: only a migration numbered ${branch[1]} may be renamed`);
      } else if (MIGRATION_FILE.exec(to) === null) {
        problems.push(`${from} → ${to}: the new name is not db/migrations/NNNN_kebab-name.sql`);
      } else if (status !== 'R100' || !same) {
        problems.push(`${from} → ${to}: the content changed (only the file name may change)`);
      } else {
        result.renames.push({ from, to });
      }
    } else if (code === 'C') {
      const from = fields[i++] ?? '';
      const to = fields[i++] ?? '';
      problems.push(`${from} → ${to}: a copy is not a rename`);
    } else {
      const path = fields[i++] ?? '';
      if (code === 'M' && !path.startsWith('db/migrations/')) modified.push(path);
      else if (path.startsWith('db/migrations/')) {
        problems.push(
          `${path} (${code}): a migration may only be renamed, not added, deleted or edited`,
        );
      } else {
        problems.push(
          `${path} (${code}): only migration renames and file-name references may change`,
        );
      }
    }
  }
  if (result.renames.length === 0) problems.push('no migration was renamed');

  const after = migrationNumbers(prDir, head);
  for (const name of after.bad) {
    problems.push(`${name}: not a migration file name (NNNN_kebab-name.sql)`);
  }
  const expected = after.numbers.map((_, i) => i + 1);
  if (after.numbers.join(',') !== expected.join(',')) {
    problems.push(
      `after the rename the migration numbers are not 1..${after.numbers.length} without a ` +
        `duplicate or a gap (${after.numbers.map((n) => String(n).padStart(4, '0')).join(', ')})`,
    );
  }

  const names = result.renames.map(({ from, to }) => ({
    from: from.slice('db/migrations/'.length),
    to: to.slice('db/migrations/'.length),
  }));
  for (const path of modified) {
    const lower = path.toLowerCase();
    if (lower.endsWith('.sql') && path !== 'db/schema.sql') {
      problems.push(`${path}: SQL content may not change`);
      continue;
    }
    if (matchesAny(lower, MONEY_PATHS)) {
      problems.push(`${path}: a money / attribution implementation path may not change`);
      continue;
    }
    const was = showOrNull(prDir, mergeBase, path);
    const now = showOrNull(prDir, head, path);
    let rewritten = was;
    for (const { from, to } of names) rewritten = rewritten?.split(from).join(to) ?? null;
    if (was === null || now === null || rewritten !== now || was === now) {
      problems.push(
        `${path}: changes other than replacing the renamed file names (${names
          .map((n) => `${n.from} → ${n.to}`)
          .join(', ')})`,
      );
    }
  }
  result.ok = problems.length === 0;
  return result;
}

export type EvidenceReport = {
  ok: boolean;
  risk: RiskLevel;
  task: string | null;
  evidence_file: string | null;
  problems: string[];
  notices: string[];
  /** RV2 on a non-task branch touching no MONEY_PATHS: an owner approval would waive evidence. */
  waivable: boolean;
  /** The evidence requirement was waived by the owner approval. */
  waived: boolean;
  /** Changed paths that are money / attribution implementation paths. */
  money_paths: string[];
  /** A pure migration rename hotfix (ops/approvals.yaml id 32): no task branch, no evidence. */
  migration_rename: boolean;
};

export type EvidenceInput = {
  /** PR checkout (full history). */
  prDir: string;
  base: string;
  head: string;
  headRef: string;
  /** The checkout whose risk map and protected-path list are used (this script's own). */
  trusted: string;
  /** Owner approval of the PR for `head`, when it was looked up (see ownerApprovalFromEnv). */
  approval?: OwnerApproval | null;
};

const SHA = /^[0-9a-f]{40,64}$/;
const SHORT_SHA = /^[0-9a-f]{7,64}$/;
const TASK_ID = /^[A-Z][A-Z0-9]*-[0-9]+[a-z]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Paths changed between two commits, both sides of a rename included. */
export function changedBetween(
  prDir: string,
  from: string,
  to: string,
): { path: string; status: string }[] {
  const out = git(
    [
      '-c',
      'core.quotepath=false',
      'diff',
      '--name-status',
      '-z',
      '-M',
      '--no-ext-diff',
      from,
      to,
      '--',
    ],
    { cwd: prDir },
  );
  const fields = out.split('\0');
  const changes: { path: string; status: string }[] = [];
  for (let i = 0; i < fields.length;) {
    const status = fields[i++] ?? '';
    if (status === '') continue;
    const code = status[0] ?? '';
    if (code === 'R' || code === 'C') {
      const oldPath = fields[i++] ?? '';
      const path = fields[i++] ?? '';
      changes.push({ path, status: code === 'R' ? 'R' : 'A' });
      if (code === 'R') changes.push({ path: oldPath, status: 'D' });
    } else {
      changes.push({ path: fields[i++] ?? '', status: code });
    }
  }
  return changes;
}

function showOrNull(prDir: string, ref: string, path: string): string | null {
  const res = tryGit(['show', `${ref}:${path}`], { cwd: prDir });
  return res.status === 0 ? res.stdout : null;
}

function treeOf(prDir: string, ref: string, path?: string): string | null {
  const spec = path === undefined ? `${ref}^{tree}` : `${ref}:${path}`;
  const res = tryGit(['rev-parse', '--verify', '--quiet', spec], { cwd: prDir });
  const value = res.stdout.trim();
  return res.status === 0 && SHA.test(value) ? value : null;
}

/**
 * Tree of the head commit WITHOUT the evidence file itself: the verification ran before the
 * evidence was written (its `tree` is in the file), so the file cannot be part of the tree it
 * describes. A throwaway index in the git directory; the real index is not touched.
 */
export function headTreeWithoutEvidence(
  prDir: string,
  head: string,
  evidencePath: string,
): string | null {
  const gitDir = tryGit(['rev-parse', '--absolute-git-dir'], { cwd: prDir }).stdout.trim();
  if (gitDir === '') return null;
  const index = join(gitDir, `couli-evidence-index.${process.pid}`);
  const env = { ...process.env, GIT_INDEX_FILE: index, GIT_OPTIONAL_LOCKS: '0' };
  const run = (args: string[]): string | null => {
    const res = spawnSync('git', args, { cwd: prDir, env, encoding: 'utf8' });
    return res.status === 0 ? res.stdout.trim() : null;
  };
  try {
    if (run(['read-tree', head]) === null) return null;
    run(['update-index', '--force-remove', '--', evidencePath]);
    const tree = run(['write-tree']);
    return tree !== null && SHA.test(tree) ? tree : null;
  } finally {
    rmSync(index, { force: true });
    rmSync(`${index}.lock`, { force: true });
  }
}

function class1Hits(prDir: string, from: string, to: string, cfg: ProtectedConfig): string[] {
  const globs = cfg.class1_add_only.map((g) => splitFragment(g).glob);
  return changedBetween(prDir, from, to)
    .filter((c) => c.status !== 'A' && matchesAny(c.path, globs))
    .map((c) => `${c.path} (${c.status})`);
}

// TODO(规划/11 §3.2, §4.5): accept `mode: ci` records (browser tests) once the CI evidence archive
// rebate-private/ci-evidence/<run_id>/ is connected: bind run_url, run_id, run_attempt, workflow,
// job, commit, tree and report_sha256 to the archived run and report, parse the report (tests
// that ran, failure causes, skipped count) and an allow-list of browser jobs — blocked on the
// archive (records-from-junit.ts) and the browser workflow (Codex review CR2-06).
export const CI_REFUSED =
  'CI 证据归档未接入，暂不接受 mode: ci 记录（规划/11 §3.2；Codex 评审 CR2-06）';

/**
 * Whether the evidence may record a handover (规划/11 §2.5): computed in checkEvidence from the
 * ledger (trusted root, else the head) and the changed paths; absent means refused.
 */
export type HandoverPolicy = {
  allowed: boolean;
  reason: string;
  /** The ledger's implementation paths: the handover commit must change only these. */
  paths: readonly string[];
};

/** Subject marker of the handover implementation commit (tools/agent/README.md §11 item 2). */
export const HANDOVER_MARKER = '(handover, Codex)';

/** Files changed by a single-parent commit; null for a merge, a root commit or an unknown id. */
function commitFiles(prDir: string, commit: string): string[] | null {
  const parents = tryGit(['rev-list', '--parents', '-n', '1', commit, '--'], { cwd: prDir });
  if (parents.status !== 0 || parents.stdout.trim().split(' ').length !== 2) return null;
  const res = tryGit(
    [
      '-c',
      'core.quotepath=false',
      'diff-tree',
      '-r',
      '-z',
      '--name-only',
      '--no-commit-id',
      '--no-renames',
      commit,
      '--',
    ],
    { cwd: prDir },
  );
  return res.status === 0 ? res.stdout.split('\0').filter((f) => f !== '') : null;
}

/** What the red-run requirement of a task needs (CR2-05). */
export type RedRequirement = {
  required: boolean;
  /** Rule-test files the task added inside its test_paths, base..spec_commit. */
  expected: string[];
  /**
   * CT-06r: the red exemptions the trusted ledger declares (`red_exempt`) and who wrote the rule
   * tests; absent or 0 declared: no confirmation required.
   */
  declared?: { count: number; tester: TaskFile['tester']; outside?: number };
  /**
   * CT-06zxc (review r1 S2-1): the ledger's renames that hit a rule-test file of the task (in
   * ledger order) and the files they leave out of the expected list; absent when none hit: no
   * confirmation required.
   */
  renames?: { hit: RenameDeclaration[]; left_out: string[]; tester: TaskFile['tester'] };
  /**
   * CT-06zxe (D10-371): the ledger's registered expected values that apply to a rule-test file of
   * the task (in ledger order); absent when none: no confirmation required.
   */
  expectedValues?: { hit: ExpectedValueDeclaration[]; tester: TaskFile['tester'] };
};

/** Who produced a review: the reviewer values an evidence entry may carry. */
export const REVIEWERS = ['codex', 'claude', 'claude-independent'] as const;

/**
 * The model each engine runs (tools/agent/codex-run.sh MODEL): an entry of that engine must name
 * it (#1046 r1 S2), so an independent Claude review cannot pass for a Codex one by its fields.
 */
export const ENGINE_MODELS: Readonly<Record<string, string>> = {
  codex: 'gpt-6-astra',
  'claude-independent': 'claude-opus-5-5',
};

/**
 * ops/approvals.yaml id 36: every review entry (and spec_test_review) names the engine that
 * produced it, equal to its reviewer, and a codex / claude-independent entry the model of that
 * engine (ENGINE_MODELS). Returns the problem or null.
 */
export function engineProblem(entry: Record<string, unknown>): string | null {
  const reviewer = entry['reviewer'];
  const engine = entry['engine'];
  if (!Object.hasOwn(entry, 'engine')) {
    return (
      `must be ${JSON.stringify(reviewer)} (every review entry names the engine that produced it, ` +
      'ops/approvals.yaml id 36)'
    );
  }
  if (!(REVIEWERS as readonly unknown[]).includes(engine)) {
    return `must be one of ${REVIEWERS.join(', ')} (got ${JSON.stringify(engine)})`;
  }
  if (engine !== reviewer) {
    return (
      `engine ${String(engine)} does not match reviewer ${JSON.stringify(reviewer)}: record ` +
      'the review under the engine that produced it (an independent Claude review is ' +
      'reviewer "claude-independent", never codex; ops/approvals.yaml id 36)'
    );
  }
  const model = ENGINE_MODELS[String(engine)];
  if (model !== undefined && entry['model'] !== model) {
    return (
      `engine ${String(engine)} runs ${model}: the entry must say model "${model}" ` +
      `(got ${JSON.stringify(entry['model'])})`
    );
  }
  return null;
}

/**
 * Who may review the rule tests of a ledger tester (CT-06r): the other side (codex → claude,
 * claude → codex), or a fresh independent Claude context (ops/approvals.yaml id 36); the tests of
 * an independent Claude call are reviewed by the orchestrator's Claude or another such call.
 */
export function specTestReviewers(tester: TaskFile['tester']): string[] {
  if (tester === 'claude') return ['codex', 'claude-independent'];
  if (tester === 'claude-independent') return ['claude', 'claude-independent'];
  return ['claude', 'claude-independent'];
}

/**
 * Whether `value` confirms exactly these renames (CT-06zxc): a mapping with only `pairs` (the
 * pairs that hit, each `{ from, to }`, in ledger order) and `left_out` (the files left out of the
 * expected list, any order), nothing missing and nothing more.
 */
export function renamesConfirmed(
  value: unknown,
  pairs: readonly RenameDeclaration[],
  leftOut: readonly string[],
): boolean {
  if (!isRecord(value)) return false;
  if (Object.keys(value).some((k) => k !== 'pairs' && k !== 'left_out')) return false;
  const got = value['pairs'];
  const files = value['left_out'];
  if (!Array.isArray(got) || !Array.isArray(files)) return false;
  if (got.length !== pairs.length) return false;
  const pairOk = got.every((g, i) => {
    const want = pairs[i];
    return (
      isRecord(g) &&
      want !== undefined &&
      Object.keys(g).length === 2 &&
      g['from'] === want.from &&
      g['to'] === want.to
    );
  });
  if (!pairOk) return false;
  if (!files.every((f) => typeof f === 'string')) return false;
  const a = [...(files as string[])].sort();
  const b = [...leftOut].sort();
  return a.length === b.length && a.every((f, i) => f === b[i]);
}

/**
 * Whether `value` confirms exactly these expected values (CT-06zxe): a mapping with only
 * `entries`, each `{ file, helper, from, to }` equal to the entry that applies, in ledger order.
 */
export function expectedValuesConfirmed(
  value: unknown,
  entries: readonly ExpectedValueDeclaration[],
): boolean {
  if (!isRecord(value)) return false;
  if (Object.keys(value).some((k) => k !== 'entries')) return false;
  const got = value['entries'];
  if (!Array.isArray(got) || got.length !== entries.length) return false;
  return got.every((g, i) => {
    const want = entries[i];
    return (
      isRecord(g) &&
      want !== undefined &&
      Object.keys(g).length === 4 &&
      g['file'] === want.file &&
      g['helper'] === want.helper &&
      g['from'] === want.from &&
      g['to'] === want.to
    );
  });
}

/** Validates one evidence document against the PR; returns the problems found. */
export function evidenceProblems(
  doc: unknown,
  ctx: {
    prDir: string;
    head: string;
    task: string;
    cfg: ProtectedConfig;
    /** The red-run requirement (absent: required, no expected files: fail-closed). */
    red?: RedRequirement;
    /** Whether a handover may be recorded (absent: refused, the normal reviews required). */
    handover?: HandoverPolicy;
    /**
     * Who implemented, from the task ledger's `impl` (ops/approvals.yaml id 27: the side that did
     * not implement must review). `unknown` (ledger unreadable) requires both reviews.
     * Absent: claude (the default split, Opus implements).
     */
    implementer?: 'claude' | 'codex' | 'unknown';
    /** Why the implementer is what it is, for the error message (absent: the implementer). */
    implementerWhy?: string;
  },
): string[] {
  const problems: string[] = [];
  if (!isRecord(doc)) return ['evidence is not a JSON object'];
  const at = (field: string, message: string): void => {
    problems.push(`${field}: ${message}`);
  };

  if (doc['task'] !== ctx.task)
    at('task', `must be "${ctx.task}" (got ${JSON.stringify(doc['task'])})`);

  const specRefHead = (showOrNull(ctx.prDir, ctx.head, 'SPEC_REF') ?? '').trim();
  if (typeof doc['spec_ref'] !== 'string' || !SHA.test(doc['spec_ref'])) {
    at('spec_ref', 'must be the 40-hex planning commit');
  } else if (doc['spec_ref'] !== specRefHead) {
    at('spec_ref', `differs from SPEC_REF of the head (${specRefHead || 'missing'})`);
  }

  const specCommit = doc['spec_commit'];
  if (typeof specCommit !== 'string' || !SHORT_SHA.test(specCommit)) {
    at('spec_commit', 'must be the rule-test commit id');
  } else {
    if (!isAncestor(ctx.prDir, specCommit, ctx.head)) {
      at('spec_commit', `${specCommit} is not an ancestor of the head ${ctx.head}`);
    } else {
      const changed = class1Hits(ctx.prDir, specCommit, ctx.head, ctx.cfg);
      if (changed.length > 0) {
        at('spec_commit', `rule tests changed after the rule-test commit: ${changed.join(', ')}`);
      }
    }
  }

  const evidencePath = `ops/evidence/${ctx.task}.json`;
  const headTree = headTreeWithoutEvidence(ctx.prDir, ctx.head, evidencePath);
  const runs = doc['runs'];
  if (!Array.isArray(runs)) {
    at('runs', 'must be a list (empty when no container run is recorded)');
  } else {
    let verifiedRed = false;
    const red = ctx.red ?? { required: true, expected: [] };
    runs.forEach((run, i) => {
      if (!isRecord(run)) {
        at(`runs[${i}]`, 'must be an object');
        return;
      }
      const mode = run['mode'];
      const exit = run['exit_code'];
      const tree = run['tree'];
      if (mode === 'ci') {
        at(`runs[${i}].mode`, CI_REFUSED);
        return;
      }
      if (mode === 'host') {
        at(`runs[${i}].mode`, 'host results are not accepted (规划/11 §2.3 第 7 步, §8)');
        return;
      }
      if (mode !== 'container') {
        at(`runs[${i}].mode`, 'must be container or ci');
        return;
      }
      if (typeof exit !== 'number') at(`runs[${i}].exit_code`, 'must be a number');
      if (typeof tree !== 'string' || !SHA.test(tree)) at(`runs[${i}].tree`, 'must be a tree hash');
      const script = run['script'];
      if (script === 'verify') {
        // Optional since the required CI checks are the verification; a listed run must not
        // pretend: green, on the head tree (without the evidence file).
        if (exit !== 0 || tree !== headTree) {
          at(
            `runs[${i}]`,
            `a listed container verify run must have exit code 0 on the head tree ${headTree ?? '(unknown)'} ` +
              '(or leave it out: the required CI checks are the full verification, ops/approvals.yaml id 21)',
          );
        }
      } else if (script === 'red') {
        // The isolated red run (verify-container.sh --red): red-check passed on the spec_commit tree.
        const specTree =
          typeof specCommit === 'string' && SHORT_SHA.test(specCommit)
            ? treeOf(ctx.prDir, specCommit)
            : null;
        if (exit !== 0)
          at(`runs[${i}].exit_code`, 'a red run counts only when red-check passed (0)');
        if (specTree === null || tree !== specTree) {
          at(
            `runs[${i}].tree`,
            `a red run must have run on the spec_commit tree ${specTree ?? '(unknown)'}`,
          );
        }
        const redTests = run['red_tests'];
        const listed = run['expected'];
        const before = problems.length;
        if (!Array.isArray(redTests) || redTests.length === 0) {
          at(`runs[${i}].red_tests`, 'must list the tests that were red');
        }
        // Coverage (CR2-05): every rule-test file the task added ran and has a red test.
        for (const file of red.expected) {
          if (!Array.isArray(listed) || !listed.includes(file)) {
            at(`runs[${i}].expected`, `does not cover ${file}, a rule-test file the task added`);
          } else if (
            !Array.isArray(redTests) ||
            !redTests.some((t) => typeof t === 'string' && t.startsWith(`${file} > `))
          ) {
            at(`runs[${i}].red_tests`, `no red test of ${file}`);
          }
        }
        if (problems.length === before && exit === 0 && specTree !== null && tree === specTree) {
          verifiedRed = true;
        }
      } else if (script === 'verify:fast') {
        at(
          `runs[${i}].script`,
          "verify:fast is the implementer's own check, not the verification (only `verify` counts)",
        );
      } else {
        at(
          `runs[${i}].script`,
          'must be verify or red (tools/ops/verify-container.sh result.json)',
        );
      }
    });
    // CT-06r: declared red exemptions need the rule-test reviewer's confirmation on record.
    if (
      red.required &&
      red.declared !== undefined &&
      (red.declared.count > 0 || (red.declared.outside ?? 0) > 0)
    ) {
      const reviewers = specTestReviewers(red.declared.tester);
      // The message names the usual side; an independent Claude confirmation is accepted too.
      const reviewer = reviewers[0] ?? 'claude';
      const field = 'spec_test_review';
      const outside =
        (red.declared.outside ?? 0) > 0
          ? ` and ${red.declared.outside} file(s) whose code outside the tests changed (red_exempt_outside, CT-06zzzc)`
          : '';
      const want = `the ledger declares ${red.declared.count} red exemption(s) (red_exempt, CT-06r)${outside}: the rule-test reviewer (${reviewer}) must confirm them in ${field} (reviewer ${reviewer}, last_verdict pass, red_exempt_confirmed true)`;
      const review = doc[field];
      if (!isRecord(review)) {
        at(field, want);
      } else {
        if (!reviewers.includes(String(review['reviewer']))) at(`${field}.reviewer`, want);
        const engine = engineProblem(review);
        if (engine !== null) at(`${field}.engine`, engine);
        if (review['last_verdict'] !== 'pass') at(`${field}.last_verdict`, want);
        if (review['red_exempt_confirmed'] !== true) at(`${field}.red_exempt_confirmed`, want);
      }
    }
    // CT-06zxc (review r1 S2-1): renames that hit a rule-test file need the rule-test reviewer's
    // confirmation, pair by pair and file by file: `renames_confirmed` lists exactly the pairs
    // that hit and the files left out, so a rename cannot slip through unseen.
    if (red.required && red.renames !== undefined) {
      const reviewers = specTestReviewers(red.renames.tester);
      const reviewer = reviewers[0] ?? 'claude';
      const field = 'spec_test_review';
      const pairs = red.renames.hit.map((r) => ({ from: r.from, to: r.to }));
      const leftOut = [...red.renames.left_out].sort();
      const want = `the ledger's renames hit ${pairs.length} pair(s) and leave ${leftOut.length} file(s) out of the expected list (renames, CT-06zxc): the rule-test reviewer (${reviewer}) must confirm them in ${field} (reviewer ${reviewer}, last_verdict pass, renames_confirmed { pairs: ${JSON.stringify(pairs)}, left_out: ${JSON.stringify(leftOut)} })`;
      const review = doc[field];
      if (!isRecord(review)) {
        at(field, want);
      } else {
        if (!reviewers.includes(String(review['reviewer']))) at(`${field}.reviewer`, want);
        const engine = engineProblem(review);
        if (engine !== null) at(`${field}.engine`, engine);
        if (review['last_verdict'] !== 'pass') at(`${field}.last_verdict`, want);
        if (!renamesConfirmed(review['renames_confirmed'], pairs, leftOut)) {
          at(`${field}.renames_confirmed`, want);
        }
      }
    }
    // CT-06zxe (D10-371): registered expected values that apply need the rule-test reviewer's
    // confirmation entry by entry (only an expected value changed; the affected tests are right).
    if (red.required && red.expectedValues !== undefined) {
      const reviewers = specTestReviewers(red.expectedValues.tester);
      const reviewer = reviewers[0] ?? 'claude';
      const field = 'spec_test_review';
      const entries = red.expectedValues.hit.map((e) => ({
        file: e.file,
        helper: e.helper,
        from: e.from,
        to: e.to,
      }));
      const want = `the ledger's expected_values apply ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} (CT-06zxe, D10-371): the rule-test reviewer (${reviewer}) must confirm them in ${field} (reviewer ${reviewer}, last_verdict pass, expected_values_confirmed { entries: ${JSON.stringify(entries)} })`;
      const review = doc[field];
      if (!isRecord(review)) {
        at(field, want);
      } else {
        if (!reviewers.includes(String(review['reviewer']))) at(`${field}.reviewer`, want);
        const engine = engineProblem(review);
        if (engine !== null) at(`${field}.engine`, engine);
        if (review['last_verdict'] !== 'pass') at(`${field}.last_verdict`, want);
        if (!expectedValuesConfirmed(review['expected_values_confirmed'], entries)) {
          at(`${field}.expected_values_confirmed`, want);
        }
      }
    }
    if (red.required && red.expected.length === 0) {
      at(
        'runs',
        'the task added no rule-test file inside its test_paths before spec_commit: nothing was shown red',
      );
    } else if (red.required && !verifiedRed) {
      at(
        'runs',
        'no valid red run (container, script red, red-check passed on the spec_commit tree, ' +
          'covering every rule-test file the task added): the rule tests were never shown red ' +
          '(规划/11 §2.3 第 3 步; tools/ops/verify-container.sh --red)',
      );
    }
  }

  // Handover (规划/11 §2.5 超限换家; tools/agent/README.md §11 item 2, CR-09): after Opus used up
  // its implementation rounds, Codex implemented once and the reviewing side switched to Claude —
  // Codex never reviews its own implementation. Only for a task below RV2 that changes no money /
  // attribution implementation path (RV2 不换家, hard rule 3; ctx.handover). The evidence names the
  // handover commit: a single-parent commit after spec_commit on the head that changes paths of
  // the task ledger only (and its ledger file) and whose subject carries the handover marker. Every
  // Claude review (other than spec-test) bound to that commit or a later ancestor of the head must
  // pass with the funds checklist, and after it only the task's evidence and ledger files change.
  // A Codex entry is the review from before the handover and is not checked. Any defect keeps the
  // normal reviews required.
  const handover = doc['handover'];
  let handoverCommit: string | null = null;
  if (handover !== undefined) {
    const policy = ctx.handover ?? { allowed: false, reason: 'no handover policy', paths: [] };
    if (!isRecord(handover)) {
      at('handover', 'must be an object {implementer, commit, note}');
    } else if (!policy.allowed) {
      at(
        'handover',
        `not allowed: ${policy.reason} (规划/11 §2.5 RV2 不换家, hard rule 3); the normal reviews ` +
          'stay required (drop the handover record and record the reviews)',
      );
    } else {
      let valid = true;
      if (handover['implementer'] !== 'codex') {
        at('handover.implementer', 'must be "codex"');
        valid = false;
      }
      const note = handover['note'];
      if (typeof note !== 'string' || note.trim() === '') {
        at('handover.note', 'must say why');
        valid = false;
      }
      const commit = handover['commit'];
      const spec = doc['spec_commit'];
      if (typeof commit !== 'string' || !COMMIT_ID.test(commit)) {
        at('handover.commit', 'must be the handover implementation commit id');
      } else if (!isAncestor(ctx.prDir, commit, ctx.head)) {
        at('handover.commit', `${commit} is not an ancestor of the head ${ctx.head}`);
      } else if (
        typeof spec !== 'string' ||
        !COMMIT_ID.test(spec) ||
        !isAncestor(ctx.prDir, spec, commit) ||
        isAncestor(ctx.prDir, commit, spec)
      ) {
        at('handover.commit', `${commit} is not after the rule-test commit`);
      } else {
        const files = commitFiles(ctx.prDir, commit);
        const ledgerFile = `ops/tasks/${ctx.task}.yaml`;
        const outside = (files ?? []).filter(
          (f) => f !== ledgerFile && !matchesAny(f, policy.paths),
        );
        if (files === null) {
          at('handover.commit', `${commit} must be a single-parent commit`);
        } else if (!files.some((f) => matchesAny(f, policy.paths))) {
          at('handover.commit', `${commit} changes no implementation path of the task ledger`);
        } else if (outside.length > 0) {
          at(
            'handover.commit',
            `${commit} changes paths outside the task ledger: ${outside.join(', ')}`,
          );
        } else if (
          !tryGit(['log', '-1', '--format=%s', commit, '--'], { cwd: ctx.prDir }).stdout.includes(
            HANDOVER_MARKER,
          )
        ) {
          at(
            'handover.commit',
            `${commit} subject does not carry the handover marker "${HANDOVER_MARKER}"`,
          );
        } else if (valid) {
          handoverCommit = commit;
        }
      }
    }
  }

  const reviews = doc['reviews'];
  if (!Array.isArray(reviews)) {
    at('reviews', 'must be a list');
  } else if (handoverCommit !== null) {
    const from = handoverCommit;
    const own = [`ops/evidence/${ctx.task}.json`, `ops/tasks/${ctx.task}.yaml`];
    const bound = reviews.filter(
      (r): r is Record<string, unknown> & { commit: string } =>
        isRecord(r) &&
        (r['reviewer'] === 'claude' || r['reviewer'] === 'claude-independent') &&
        r['review_type'] !== 'spec-test' &&
        typeof r['commit'] === 'string' &&
        COMMIT_ID.test(r['commit']) &&
        isAncestor(ctx.prDir, from, r['commit']) &&
        isAncestor(ctx.prDir, r['commit'], ctx.head),
    );
    if (bound.length === 0) {
      at(
        'reviews',
        `missing the claude review of the handover implementation (an entry whose commit is ${from} ` +
          'or a later ancestor of the head; 规划/11 §2.5)',
      );
    }
    for (const entry of bound) {
      const engine = engineProblem(entry);
      if (engine !== null) at('reviews.claude.engine', engine);
      if (entry['verdict'] !== 'pass') at('reviews.claude.verdict', 'must be pass');
      if (entry['open_s0_s1'] !== 0) at('reviews.claude.open_s0_s1', 'must be 0');
      if (entry['checklist_complete'] !== true) {
        at(
          'reviews.claude.checklist_complete',
          'must be true after a handover (the funds checklist of the Codex review, 规划/11 §3.3)',
        );
      }
      const later = changedBetween(ctx.prDir, entry.commit, ctx.head)
        .map((c) => c.path)
        .filter((p) => !own.includes(p));
      if (later.length > 0) {
        at(
          'reviews.claude.commit',
          `changed after the Claude review ${entry.commit}: ${[...new Set(later)].join(', ')}`,
        );
      }
    }
  } else {
    // ops/approvals.yaml id 27 (2026-10-09): the side that did not implement must review; the
    // implementer's own entry is optional and checked when present.
    const implementer = ctx.implementer ?? 'claude';
    const why = ctx.implementerWhy ?? `implementer: ${implementer}`;
    const required = new Set(
      implementer === 'claude'
        ? ['codex']
        : implementer === 'codex'
          ? ['claude']
          : ['claude', 'codex'],
    );
    // ops/approvals.yaml id 36: an independent Claude entry stands in for a required side that
    // has no entry of its own (Codex not available); it is checked like a Codex entry.
    const independent = reviews.filter(
      (r): r is Record<string, unknown> => isRecord(r) && r['reviewer'] === 'claude-independent',
    );
    let standIns = 0;
    for (const reviewer of ['claude', 'codex']) {
      const entry = reviews.find((r) => isRecord(r) && r['reviewer'] === reviewer);
      if (!isRecord(entry)) {
        if (required.has(reviewer)) {
          if (standIns < independent.length) {
            standIns += 1;
            continue;
          }
          at(
            'reviews',
            `missing the ${reviewer} review (${why}; the side that did not ` +
              'implement reviews, ops/approvals.yaml id 27, 规划/11 §3.2; when Codex is not ' +
              'available an independent Claude review, reviewer "claude-independent", ' +
              'stands in, ops/approvals.yaml id 36)',
          );
        }
        continue;
      }
      const engine = engineProblem(entry);
      if (engine !== null) at(`reviews.${reviewer}.engine`, engine);
      if (entry['verdict'] !== 'pass') at(`reviews.${reviewer}.verdict`, 'must be pass');
      if (entry['open_s0_s1'] !== 0) at(`reviews.${reviewer}.open_s0_s1`, 'must be 0');
      if (reviewer === 'codex' && entry['checklist_complete'] !== true) {
        at('reviews.codex.checklist_complete', 'must be true (资金评审清单必填, 规划/11 §3.3)');
      }
    }
    if (required.size === 2 && standIns === 2) {
      at(
        'reviews',
        'both sides are independent Claude entries: an unreadable ledger needs at least one ' +
          'review of its own side (claude or codex) besides an independent Claude stand-in',
      );
    }
    // Every independent Claude entry is checked, stand-in or not (an extra one may not fail).
    for (const entry of independent) {
      const field = 'reviews.claude-independent';
      const engine = engineProblem(entry);
      if (engine !== null) at(`${field}.engine`, engine);
      if (entry['verdict'] !== 'pass') at(`${field}.verdict`, 'must be pass');
      if (entry['open_s0_s1'] !== 0) at(`${field}.open_s0_s1`, 'must be 0');
      if (entry['checklist_complete'] !== true) {
        at(`${field}.checklist_complete`, 'must be true (资金评审清单必填, 规划/11 §3.3)');
      }
    }
  }

  const trees = doc['trees'];
  const treeValues: string[] = [];
  if (!isRecord(trees) || Object.keys(trees).length === 0) {
    at('trees', 'must map each protected code directory to its tree hash');
  } else {
    for (const [path, value] of Object.entries(trees)) {
      const actual = treeOf(ctx.prDir, ctx.head, path);
      if (typeof value !== 'string' || !SHA.test(value)) {
        at(`trees["${path}"]`, 'must be a tree hash');
      } else if (actual === null) {
        at(`trees["${path}"]`, 'path does not exist at the head');
      } else if (actual !== value) {
        at(`trees["${path}"]`, `recorded ${value}, head has ${actual}`);
      } else {
        treeValues.push(value);
      }
    }
  }

  const longrun = doc['longrun'];
  if (!isRecord(longrun)) {
    at('longrun', 'must be an object (长跑属性测试, 规划/11 §3.2)');
  } else {
    if (longrun['passed'] !== true) at('longrun.passed', 'must be true');
    if (typeof longrun['tree'] !== 'string' || !treeValues.includes(longrun['tree'])) {
      at('longrun.tree', 'must equal one of the tree hashes recorded in `trees`');
    }
  }
  return problems;
}

/**
 * Who implemented (ops/approvals.yaml id 27): the ledger's impl (anything but codex = Opus, the
 * default split), unknown when the ledger cannot be read. A commit on the PR (merge base..head)
 * carrying the handover marker while the evidence records no handover means Codex implemented
 * although the ledger says claude (dispatch.sh records a handover only in the runtime state), so
 * the Claude review is then required (Codex review of this change, S1).
 */
function implementerOf(
  input: EvidenceInput,
  ledger: TaskFile | null,
  mergeBase: string,
  doc: unknown,
): { implementer: 'claude' | 'codex' | 'unknown'; implementerWhy?: string } {
  if (ledger === null) return { implementer: 'unknown' };
  if (ledger.impl === 'codex') return { implementer: 'codex' };
  if (isRecord(doc) && doc['handover'] !== undefined) return { implementer: 'claude' };
  const marked = tryGit(['log', '--format=%h %s', `${mergeBase}..${input.head}`], {
    cwd: input.prDir,
  })
    .stdout.split('\n')
    .filter((line) => line.includes(HANDOVER_MARKER))
    .map((line) => line.split(' ')[0] ?? '');
  if (marked.length === 0) return { implementer: 'claude' };
  return {
    implementer: 'codex',
    implementerWhy:
      `${marked.join(', ')} carries the handover marker "${HANDOVER_MARKER}", so Codex ` +
      'implemented (规划/11 §2.5, CR-09)',
  };
}

/** The task ledger from the trusted root, or from the head when the PR adds it; null if unreadable. */
function readLedger(input: EvidenceInput, task: string): TaskFile | null {
  const rel = `ops/tasks/${task}.yaml`;
  const trustedFile = join(input.trusted, rel);
  try {
    return existsSync(trustedFile)
      ? parseTaskFile(readFileSync(trustedFile, 'utf8'), rel)
      : parseTaskFile(showOrNull(input.prDir, input.head, rel) ?? '', rel);
  } catch {
    return null;
  }
}

/**
 * Whether a handover may be recorded (规划/11 §2.5 RV2 不换家, hard rule 3): the ledger is readable,
 * the risk of its paths (as task.ts and dispatch.sh compute it) is below RV2, the pull request
 * changes no money / attribution implementation path, and the changed paths outside the
 * rule-test assets (class 1), the task's own ledger and evidence files and docs/** are below RV2.
 * The PR risk as a whole is not used: test/** and ops/evidence/** make every task PR RV2.
 */
export function handoverPolicy(
  input: EvidenceInput,
  task: string,
  changed: readonly string[],
  riskMap: ReturnType<typeof loadRiskMap>,
  cfg: ProtectedConfig,
): HandoverPolicy {
  const ledger = readLedger(input, task);
  if (ledger === null) {
    return { allowed: false, reason: `ops/tasks/${task}.yaml could not be read`, paths: [] };
  }
  const refuse = (reason: string): HandoverPolicy => ({
    allowed: false,
    reason,
    paths: ledger.paths,
  });
  const risk = riskOfPaths(ledger.paths, riskMap, cfg).risk;
  if (risk === 'RV2') return refuse('the task ledger paths are RV2');
  const money = changed.filter((p) => matchesAny(p.toLowerCase(), MONEY_PATHS));
  if (money.length > 0) {
    return refuse(`money / attribution implementation paths changed (${money.join(', ')})`);
  }
  const testAssets = cfg.class1_add_only.map((g) => splitFragment(g).glob);
  const own = [`ops/tasks/${task}.yaml`, `ops/evidence/${task}.json`];
  const rest = changed.filter(
    (p) => !own.includes(p) && !matchesAny(p, testAssets) && !matchesAny(p, ['docs/**']),
  );
  if (rest.length > 0) {
    const high = riskOfPaths(rest, riskMap, cfg).paths.filter((p) => p.risk === 'RV2');
    if (high.length > 0) {
      return refuse(`changed paths are RV2 (${high.map((p) => p.path).join(', ')})`);
    }
  }
  return { allowed: true, reason: `task risk ${risk}`, paths: ledger.paths };
}

/**
 * Whether the task needs a red run, and which rule-test files it must cover (CR2-05). The ledger
 * comes from the trusted root, or from the head when the PR adds it; the switch-baseline list
 * from the trusted root. A ledger that cannot be read requires the red run with no expected
 * file, which fails (fail-closed).
 */
export function redRequirement(
  input: EvidenceInput,
  task: string,
  mergeBase: string,
  evidenceText: string,
): RedRequirement {
  const ledger = readLedger(input, task);
  if (ledger === null) return { required: true, expected: [] };
  const legacy = loadLegacyTasks(input.trusted);
  // CR3-03: only a task without a rule-test author, or a legacy ledger, is exempt.
  if (ledger.tester === 'none' || legacy.has(ledger.id)) return { required: false, expected: [] };
  let specCommit: unknown;
  try {
    specCommit = (JSON.parse(evidenceText) as Record<string, unknown>)['spec_commit'];
  } catch {
    specCommit = null;
  }
  if (typeof specCommit !== 'string' || !SHORT_SHA.test(specCommit)) {
    return { required: true, expected: [] };
  }
  const changes = changedBetween(input.prDir, mergeBase, specCommit).map((c) => ({
    path: c.path,
    status: c.status as Change['status'],
  }));
  // CT-06zxc (D10-347): a rule-test file that differs from its base only by the ledger's literal
  // renames is unchanged, as red-check.ts leaves it out of the red run: no red test is wanted.
  const all = expectedRuleTests(changes, ledger.test_paths);
  const read = {
    base: (p: string) => showOrNull(input.prDir, mergeBase, p),
    head: (p: string) => showOrNull(input.prDir, specCommit as string, p),
  };
  const leftOut = renamedOnlyFiles(all, read, ledger.renames).map((r) => r.file);
  const left = new Set(leftOut);
  // Review r1 S2-1: renames that hit a rule-test file of the task need the reviewer's confirmation.
  const hit = renamesHit(all, read, ledger.renames);
  // CT-06zxe (D10-371): registered expected values that apply need the reviewer's confirmation.
  const expected = all.filter((f) => !left.has(f));
  const values = expectedValuesHit(expected, read, ledger.renames, ledger.expected_values);
  return {
    required: true,
    expected,
    ...(ledger.red_exempt.length > 0 || ledger.red_exempt_outside.length > 0
      ? {
          declared: {
            count: ledger.red_exempt.length,
            tester: ledger.tester,
            // CT-06zzzc (D10-623): files whose changed code outside the tests the reviewer confirms.
            ...(ledger.red_exempt_outside.length > 0
              ? { outside: ledger.red_exempt_outside.length }
              : {}),
          },
        }
      : {}),
    ...(hit.length > 0 || leftOut.length > 0
      ? { renames: { hit, left_out: leftOut, tester: ledger.tester } }
      : {}),
    ...(values.length > 0 ? { expectedValues: { hit: values, tester: ledger.tester } } : {}),
  };
}

export function checkEvidence(input: EvidenceInput): EvidenceReport {
  const problems: string[] = [];
  const notices: string[] = [];
  const cfg = loadProtected(input.trusted);
  const riskMap = loadRiskMap(input.trusted);
  for (const [name, ref] of [
    ['base', input.base],
    ['head', input.head],
  ] as const) {
    if (!SHORT_SHA.test(ref)) throw new Error(`--${name} must be a commit id`);
    if (
      tryGit(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: input.prDir })
        .status !== 0
    ) {
      throw new Error(`--${name} ${ref} is not a commit in ${input.prDir}`);
    }
  }
  const mergeBase = git(['merge-base', input.base, input.head], { cwd: input.prDir });
  const changed = changedBetween(input.prDir, mergeBase, input.head).map((c) => c.path);
  const risk = riskOfPaths(changed, riskMap, cfg).risk;
  const branch = /^task\/(.+)$/.exec(input.headRef);
  const task = branch !== null && TASK_ID.test(branch[1] ?? '') ? (branch[1] ?? null) : null;
  const evidencePath = task === null ? null : `ops/evidence/${task}.json`;
  const text = evidencePath === null ? null : showOrNull(input.prDir, input.head, evidencePath);
  const moneyPaths = changed.filter((p) => matchesAny(p.toLowerCase(), MONEY_PATHS));
  const waivable = risk === 'RV2' && task === null && moneyPaths.length === 0;
  const approval = input.approval ?? null;
  let waived = false;
  const rename = migrationRename(input.prDir, mergeBase, input.head, input.headRef);
  if (rename.branch && !rename.ok) {
    for (const problem of rename.problems) {
      notices.push(`not a pure migration rename hotfix (ops/approvals.yaml id 32): ${problem}`);
    }
  }

  if (risk !== 'RV2') {
    notices.push(`risk ${risk}: no evidence file required (${changed.length} changed path(s))`);
  } else if (task === null && rename.ok) {
    notices.push(
      `pure migration rename hotfix on branch "${input.headRef}" (${rename.renames
        .map((r) => `${r.from} → ${r.to}`)
        .join(', ')}): no task branch and no evidence file required (ops/approvals.yaml id 32); ` +
        'db/migrations stays a protected path (protected-paths, guard-git)',
    );
  } else if (task === null && waivable && approval?.approved === true) {
    waived = true;
    notices.push(
      `RV2 change on branch "${input.headRef}": evidence file waived by the owner approval ` +
        `(${approval.reason}); no money / attribution implementation path changed`,
    );
  } else if (task === null) {
    problems.push(
      `RV2 change on branch "${input.headRef}": the branch must be task/<id> so that ` +
        'ops/evidence/<id>.json can be checked',
    );
    if (moneyPaths.length > 0) {
      problems.push(
        `money / attribution implementation paths changed (${moneyPaths.join(', ')}): an owner ` +
          'approval label does not waive the evidence file',
      );
    } else if (approval !== null) {
      problems.push(`owner approval: no (${approval.reason})`);
    } else {
      notices.push(
        'an owner approval label for the head would waive the evidence file (no money / ' +
          'attribution implementation path changed); it is looked up only with --pr-number',
      );
    }
  } else if (text === null) {
    problems.push(`RV2 change without ${evidencePath} at the head (规划/11 §3.2 证据文件)`);
  }

  if (text !== null && task !== null) {
    const red = redRequirement(input, task, mergeBase, text);
    let doc: unknown;
    try {
      doc = JSON.parse(text);
    } catch (err) {
      doc = undefined;
      problems.push(
        `${evidencePath}: not valid JSON (${err instanceof Error ? err.message : String(err)})`,
      );
    }
    if (doc !== undefined) {
      problems.push(
        ...evidenceProblems(doc, {
          prDir: input.prDir,
          head: input.head,
          task,
          cfg,
          red,
          handover: handoverPolicy(input, task, changed, riskMap, cfg),
          ...implementerOf(input, readLedger(input, task), mergeBase, doc),
        }).map((p) => `${evidencePath}: ${p}`),
      );
    }
  }
  return {
    ok: problems.length === 0,
    risk,
    task,
    evidence_file: evidencePath,
    problems,
    notices,
    waivable,
    waived,
    money_paths: moneyPaths,
    migration_rename: task === null && rename.ok,
  };
}

async function main(argv: readonly string[]): Promise<number> {
  const values = new Map<string, string>();
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (arg === '--json') {
      json = true;
      continue;
    }
    const value = argv[i + 1];
    if (
      !['--pr', '--base', '--head', '--head-ref', '--pr-number'].includes(arg) ||
      value === undefined
    ) {
      throw new Error(
        'usage: evidence-check.ts --pr <dir> --base <sha> --head <sha> --head-ref <branch> ' +
          '[--pr-number <n>] [--json]',
      );
    }
    values.set(arg, value);
    i++;
  }
  const prDir = values.get('--pr');
  const base = values.get('--base');
  const head = values.get('--head');
  const headRef = values.get('--head-ref');
  if (prDir === undefined || base === undefined || head === undefined || headRef === undefined) {
    throw new Error('--pr, --base, --head and --head-ref are required');
  }
  const prNumber = values.get('--pr-number');
  if (prNumber !== undefined && !/^[1-9][0-9]*$/.test(prNumber)) {
    throw new Error('--pr-number must be a pull request number');
  }
  const input: EvidenceInput = {
    prDir: resolve(prDir),
    base,
    head,
    headRef,
    trusted: resolve(import.meta.dirname, '../..'),
  };
  let report = checkEvidence(input);
  // The API is asked only when an approval could change the outcome.
  if (!report.ok && report.waivable && prNumber !== undefined) {
    const fullHead = git(['rev-parse', '--verify', `${head}^{commit}`], { cwd: input.prDir });
    const approval = await ownerApprovalFromEnv(prNumber, fullHead);
    report = checkEvidence({ ...input, approval });
  }
  if (json) console.log(JSON.stringify(report, null, 2));
  for (const notice of report.notices) console.error(`evidence-check: notice: ${notice}`);
  for (const problem of report.problems) console.error(`evidence-check: ${problem}`);
  console.error(
    report.ok ? 'evidence-check: ok' : `evidence-check: ${report.problems.length} problem(s)`,
  );
  return report.ok ? 0 : 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(`evidence-check: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 2;
    },
  );
}
