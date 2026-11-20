// Guard runner.
//   run.ts static [--cwd <dir>] [--allow-missing-spec]
//     Checks that need no git history (part of `pnpm verify:fast`, also run in the verify
//     container, which has no .git and no planning repository).
//   run.ts git --base <ref> [--task <id>] [--cwd <dir>] [--pr-number <n>]
//     Checks of a diff against <ref>; run on the host by the orchestrator or by CI.
//     With --pr-number (CI job guard-git), when protected-paths or the add-only part of
//     test-guard has problems, the owner approval of that pull request is looked up for the
//     checked commit (HEAD of --cwd, which must be clean) through the GitHub API, exactly as the
//     protected-paths workflow does (lib/owner-approval.mjs, 规划/11 §4.4). Approved: those
//     problems are printed as warnings and do not fail; every other problem still fails.
//     Not approved, or the API cannot be read: unchanged, the problems fail.
//     With --task (a task/<id> branch), the path guard is split at the spec_commit of
//     ops/evidence/<id>.json at HEAD once it is verified to be an ancestor of HEAD and a
//     descendant of --base (owner decision 2026-10-02, ops/approvals.yaml id 14):
//     path-guard checks spec_commit..HEAD (plus the working tree) against the task paths, and
//     path-guard-author checks --base..spec_commit against the rule-test author's paths
//     (lib/spec-base.ts). Without a usable spec_commit, path-guard runs from --base as before.
//     protected-paths and test-guard always run from --base.
//     ledger-overwrite and migration-sequence (CT-06q, 2026-10-18) run on every branch: a task
//     file ops/tasks/<id>.yaml that exists at the fork point (merge base of --base and HEAD)
//     keeps its id, type and title, a done one stays done, none is deleted or renamed
//     (lib/ledger-overwrite.ts); the migrations db/migrations/NNNN_*.sql the tree adds to
//     --base are numbered max(base) + 1, + 2, … with no gap, repeat or number the base has
//     (lib/migration-sequence.ts). The owner label waives neither.
//     Commits of that range marked `Couli-Mechanical: contract-codegen` (ops/approvals.yaml id 31)
//     are held to the ledger's mechanical_paths instead (planned markers removed from the
//     contract, files regenerated; lib/mechanical.ts), every other commit to the task paths
//     (lib/checks.ts taskPathGuardCheck). path-guard.ts (post-run.sh) keeps the task paths only.
//     The task ledger comes from the trusted root; only when the trusted root has no
//     ops/tasks/<id>.yaml and the PR adds it (absent at --base, present at HEAD) is the head's
//     copy used (owner decision 2026-10-02, ops/approvals.yaml id 17, lib/checks.ts guardTask).
// One summary line per check on stdout, details on stderr, exit 1 when any check failed.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tryGit } from '../lib/git.ts';
import {
  addOnlyProblem,
  agentsPairCheck,
  authorPathsCheck,
  agentsTableCheck,
  bannedTermsSpecCheck,
  hiddenUnicodeCheck,
  ledgerOverwriteCheck,
  lockfileCheck,
  migrationSequenceCheck,
  protectedPathsCheck,
  protectedSyncCheck,
  riskMapCoverageCheck,
  schemaLintCheck,
  specRefCheck,
  specRepoRequired,
  testGuardCheck,
  guardTask,
  taskPathGuardCheck,
  waiveProblems,
} from './lib/checks.ts';
import { UsageError, parseArgs, report, resolveRoot, runCli } from './lib/cli.ts';
import type { CheckResult } from './lib/cli.ts';
import { ownerApprovalFromEnv } from './lib/owner-approval-env.ts';
import type { OwnerApproval } from './lib/owner-approval-env.ts';
import { resolveSpecBase } from './lib/spec-base.ts';
import type { SpecBase } from './lib/spec-base.ts';
import { listTreeFiles } from './lib/tree.ts';
import { ledgerWritersCheck } from './ledger-writers.ts';

function runCheck(name: string, run: () => CheckResult): CheckResult {
  try {
    return run();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { name, status: 'fail', problems: [`internal error: ${message}`], notices: [] };
  }
}

function reportAll(label: string, results: CheckResult[]): number {
  let failed = 0;
  let skippedCount = 0;
  for (const check of results) {
    if (report(check) !== 0) failed++;
    if (check.status === 'skip') skippedCount++;
  }
  const passed = results.length - failed - skippedCount;
  process.stdout.write(`${label}: ${passed} passed, ${failed} failed, ${skippedCount} skipped\n`);
  return failed === 0 ? 0 : 1;
}

function runAll(label: string, checks: [name: string, run: () => CheckResult][]): number {
  return reportAll(
    label,
    checks.map(([name, run]) => runCheck(name, run)),
  );
}

/** The committed head of `root`, or the reason an approval cannot be bound to it. */
function cleanHead(root: string): { head: string } | { reason: string } {
  const head = tryGit(['rev-parse', '--verify', 'HEAD^{commit}'], { cwd: root });
  if (head.status !== 0) return { reason: `${root} has no HEAD commit` };
  const status = tryGit(['status', '--porcelain', '--untracked-files=all'], { cwd: root });
  if (status.status !== 0 || status.stdout.trim() !== '') {
    return { reason: `${root} has uncommitted changes: an approval binds to a commit only` };
  }
  return { head: head.stdout.trim() };
}

function runStatic(argv: string[]): number {
  const args = parseArgs(argv, { values: ['cwd'], flags: ['allow-missing-spec'] });
  if (args.rest.length > 0) throw new UsageError(`unexpected argument "${args.rest[0]}"`);
  const root = resolveRoot(args.values.get('cwd'));
  if (!existsSync(join(root, '.git'))) {
    console.error(
      `guard: notice: no .git directory at ${root}: files are listed by walking the tree, and ` +
        'checks that need the planning repository are skipped when it is not available',
    );
  }
  const tree = listTreeFiles(root);
  const spec = { requireSpecRepo: specRepoRequired(root, args.flags.has('allow-missing-spec')) };
  return runAll('guard static', [
    ['schema-lint', () => schemaLintCheck(root)],
    ['agents-pair', () => agentsPairCheck(root, tree)],
    ['risk-map-coverage', () => riskMapCoverageCheck(root)],
    ['agents-table', () => agentsTableCheck(root)],
    ['protected-sync', () => protectedSyncCheck(root)],
    ['test-guard', () => testGuardCheck(root, tree)],
    ['hidden-unicode', () => hiddenUnicodeCheck(root, tree)],
    ['ledger-writers', () => ledgerWritersCheck(root, tree)],
    ['lockfile-urls', () => lockfileCheck(root)],
    ['spec-ref', () => specRefCheck(root, spec)],
    ['banned-terms', () => bannedTermsSpecCheck(root, spec)],
  ]);
}

async function runGit(argv: string[]): Promise<number> {
  const args = parseArgs(argv, { values: ['base', 'task', 'cwd', 'pr-number'] });
  if (args.rest.length > 0) throw new UsageError(`unexpected argument "${args.rest[0]}"`);
  const base = args.values.get('base');
  if (base === undefined) throw new UsageError('--base is required');
  const prNumber = args.values.get('pr-number');
  if (prNumber !== undefined && !/^[1-9][0-9]*$/.test(prNumber)) {
    throw new UsageError('--pr-number must be a pull request number');
  }
  const root = resolveRoot(args.values.get('cwd'));
  if (!existsSync(join(root, '.git'))) {
    throw new Error(`${root} is not a git work tree: the git guards run on the host only`);
  }
  const taskId = args.values.get('task');
  const task = taskId === undefined ? null : guardTask(taskId, root, base);
  const results: CheckResult[] = [];
  const ledgerNotes = task?.notice ? [task.notice] : [];
  if (task && taskId !== undefined) {
    // The implementer's scope starts at the verified spec_commit of the task's evidence file;
    // the commits before it are the rule-test author's (lib/spec-base.ts). Without a usable
    // spec_commit: one range from the base, as before (fails closed on rule tests).
    let spec: SpecBase;
    try {
      spec = resolveSpecBase(root, base, 'HEAD', taskId);
    } catch (err) {
      spec = {
        ok: false,
        reason: `internal error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (spec.ok) {
      const specCommit = spec.specCommit;
      const note =
        `implementer scope starts at spec_commit ${specCommit.slice(0, 12)} (${spec.evidenceFile}, ` +
        'an ancestor of the head and a descendant of the base); the commits before it are ' +
        "checked as the rule-test author's (path-guard-author)";
      results.push(
        runCheck('path-guard', () => {
          const check = taskPathGuardCheck(root, specCommit, task);
          return { ...check, notices: [...ledgerNotes, note, ...check.notices] };
        }),
      );
      results.push(
        runCheck('path-guard-author', () =>
          authorPathsCheck(root, base, specCommit, { id: taskId ?? '', ...task }),
        ),
      );
    } else {
      const note = `implementer scope starts at the base: ${spec.reason}`;
      results.push(
        runCheck('path-guard', () => {
          const check = taskPathGuardCheck(root, base, task);
          return { ...check, notices: [...ledgerNotes, note, ...check.notices] };
        }),
      );
    }
  }
  // CT-06q: a task file that exists at the fork point is not turned into another task, and the
  // migrations added to the base continue its numbering (lib/ledger-overwrite.ts,
  // lib/migration-sequence.ts). Neither is waived by the owner label.
  results.push(runCheck('ledger-overwrite', () => ledgerOverwriteCheck(root, base)));
  results.push(runCheck('migration-sequence', () => migrationSequenceCheck(root, base)));
  results.push(
    runCheck('protected-paths', () => protectedPathsCheck(root, base, task?.type).check),
  );
  let addOnly = new Set<string>();
  results.push(
    runCheck('test-guard', () => {
      const check = testGuardCheck(root, listTreeFiles(root), base);
      addOnly = new Set(check.add_only_violations.map(addOnlyProblem));
      return check;
    }),
  );

  // Only the protected-path problems and the add-only test-asset problems can be approved.
  const waivable = (check: CheckResult, problem: string): boolean =>
    !problem.startsWith('internal error:') &&
    (check.name === 'protected-paths' || (check.name === 'test-guard' && addOnly.has(problem)));
  const needsApproval = results.some((c) => c.problems.some((p) => waivable(c, p)));
  if (prNumber !== undefined && needsApproval) {
    const head = cleanHead(root);
    const approval: OwnerApproval =
      'head' in head
        ? await ownerApprovalFromEnv(prNumber, head.head)
        : { label: '-', approved: false, actor: null, reason: head.reason };
    for (let i = 0; i < results.length; i++) {
      const check = results[i];
      if (check === undefined || !check.problems.some((p) => waivable(check, p))) continue;
      results[i] = approval.approved
        ? waiveProblems(
            check,
            (p) => waivable(check, p),
            `owner approval of PR #${prNumber}: ${approval.reason}; the problems below are ` +
              'reported as warnings (规划/11 §4.4)',
          )
        : {
            ...check,
            notices: [
              ...check.notices,
              `owner approval of PR #${prNumber}: no (${approval.reason})`,
            ],
          };
    }
  }
  return reportAll('guard git', results);
}

runCli(
  'run.ts static [--cwd <dir>] [--allow-missing-spec] | ' +
    'run.ts git --base <ref> [--task <id>] [--cwd <dir>] [--pr-number <n>]',
  (argv) => {
    const [mode, ...tail] = argv;
    // `pnpm guard:git -- --base <ref>` forwards the separator as an argument.
    const rest = tail[0] === '--' ? tail.slice(1) : tail;
    if (mode === 'static') return runStatic(rest);
    if (mode === 'git') return runGit(rest);
    throw new UsageError('the first argument must be "static" or "git"');
  },
);
