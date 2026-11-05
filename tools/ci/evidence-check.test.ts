// evidence-check.ts against a fixture repository: an RV2 branch with and without a complete
// evidence file, an RV0 branch, and each field that must make the check fail.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  CI_REFUSED,
  checkEvidence,
  engineProblem,
  evidenceProblems,
  handoverPolicy,
  headTreeWithoutEvidence,
  redRequirement,
  specTestReviewers,
} from './evidence-check.ts';
import type { HandoverPolicy, RedRequirement } from './evidence-check.ts';
import { loadProtected } from '../guard/lib/protected.ts';
import { loadRiskMap } from '../guard/lib/risk.ts';

const REPO = resolve(import.meta.dirname, '../..');
const SCRATCH = join(REPO, '.tmp', `ci-evidence-${process.pid}`);
const SPEC_REF = 'c'.repeat(40);

function git(cwd: string, args: string[]): string {
  const res = spawnSync(
    'git',
    [
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@example.invalid',
      '-c',
      'core.hooksPath=/dev/null',
      ...args,
    ],
    { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } },
  );
  if (res.status !== 0) throw new Error(`git ${args.join(' ')}: ${res.stderr}`);
  return res.stdout.trim();
}

function write(root: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
}

let repo = '';
let base = '';
let specCommit = '';
let specTree = '';
/** Trusted root of the fixture: risk map and protected paths of this repository, plus a ledger of
 * B2-01a written under the default split of 2026-10-05 (tester codex, test_paths) and an empty
 * switch-baseline list, so the red run is required (CR2-05). */
let TRUSTED = '';
const FLOOR = 'test/spec/money/floor.test.ts';
const RED = { required: true, expected: [FLOOR] };
let headTree = '';
let moneyTree = '';

type Evidence = Record<string, unknown>;

/** A complete, correct evidence document for the head commit of `branch`. */
function evidence(extra: Evidence = {}): Evidence {
  return {
    task: 'B2-01a',
    spec_ref: SPEC_REF,
    spec_commit: specCommit,
    red_tests: ['money: rounds down'],
    runs: [
      {
        mode: 'container',
        script: 'red',
        exit_code: 0,
        commit: null,
        tree: specTree,
        prop_seed: 1,
        red_tests: [`${FLOOR} > floors`],
        expected: [FLOOR],
      },
      {
        mode: 'container',
        script: 'verify',
        exit_code: 0,
        commit: null,
        tree: headTree,
        prop_seed: 1,
      },
    ],
    reviews: [
      { reviewer: 'claude', engine: 'claude', verdict: 'pass', open_s0_s1: 0 },
      {
        reviewer: 'codex',
        engine: 'codex',
        model: 'gpt-6-astra',
        verdict: 'pass',
        open_s0_s1: 0,
        checklist_complete: true,
      },
    ],
    trees: { 'packages/money': moneyTree },
    longrun: { runs: 1000000, seed: 1, passed: true, tree: moneyTree },
    ...extra,
  };
}

/** Adds a commit on top of HEAD with the evidence file and returns its sha. */
function commitEvidence(doc: Evidence | string): string {
  write(repo, {
    'ops/evidence/B2-01a.json': typeof doc === 'string' ? doc : `${JSON.stringify(doc, null, 2)}\n`,
  });
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '--allow-empty', '-m', 'evidence']);
  return git(repo, ['rev-parse', 'HEAD']);
}

beforeAll(() => {
  repo = join(SCRATCH, 'repo');
  mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-q', '-b', 'main']);
  write(repo, {
    SPEC_REF: `${SPEC_REF}\n`,
    'packages/money/src/index.ts': 'export const a = 1;\n',
    'docs/README.md': '# docs\n',
    'test/spec/money/round.test.ts': 'it("rounds", () => {});\n',
  });
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'base']);
  base = git(repo, ['rev-parse', 'HEAD']);
  git(repo, ['checkout', '-q', '-b', 'task/B2-01a']);
  // The rule-test commit, then the implementation.
  write(repo, { 'test/spec/money/floor.test.ts': 'it("floors", () => {});\n' });
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'test(spec): floor']);
  specCommit = git(repo, ['rev-parse', 'HEAD']);
  specTree = git(repo, ['rev-parse', `${specCommit}^{tree}`]);
  TRUSTED = join(SCRATCH, 'trusted');
  for (const file of ['tools/guard/protected-paths.json', 'ops/risk-map.yaml']) {
    write(TRUSTED, { [file]: readFileSync(join(REPO, file), 'utf8') });
  }
  write(TRUSTED, {
    'tools/guard/legacy-tasks.json': JSON.stringify({ baseline: 'fixture', tasks: [] }),
    'ops/tasks/B2-01a.yaml': [
      'id: B2-01a',
      'repo: rebate-platform',
      'title: money fixture',
      'type: impl',
      'refs: []',
      'refs_hash: {}',
      'deps: []',
      'paths:',
      "  - 'packages/money/src/**'",
      'test_paths:',
      "  - 'test/spec/money/**'",
      'impl: claude',
      'tester: codex',
      'accept:',
      "  - 'pnpm verify'",
      'status: todo',
      'pr: null',
      '',
    ].join('\n'),
  });
  write(repo, { 'packages/money/src/index.ts': 'export const a = 2;\n' });
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'impl (handover, Codex)']);
});

afterAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
});

function check(head: string, headRef = 'task/B2-01a') {
  return checkEvidence({ prDir: repo, base, head, headRef, trusted: TRUSTED });
}

it('an RV2 branch without an evidence file fails; with a complete one it passes', () => {
  const impl = git(repo, ['rev-parse', 'HEAD']);
  const missing = check(impl);
  expect(missing.ok).toBe(false);
  expect(missing.risk).toBe('RV2');
  expect(missing.problems.join('\n')).toContain('without ops/evidence/B2-01a.json');

  // The verification ran on the implementation tree; the evidence file is committed on top
  // and is excluded when the head tree is compared (it cannot describe itself).
  headTree = git(repo, ['rev-parse', `${impl}^{tree}`]);
  moneyTree = git(repo, ['rev-parse', `${impl}:packages/money`]);
  const head = commitEvidence(evidence());
  expect(headTreeWithoutEvidence(repo, head, 'ops/evidence/B2-01a.json')).toBe(headTree);
  expect(git(repo, ['rev-parse', `${head}^{tree}`])).not.toBe(headTree);

  const good = check(head);
  expect(good.problems).toEqual([]);
  expect(good).toMatchObject({ ok: true, risk: 'RV2', task: 'B2-01a' });

  // A branch name that is not task/<id> cannot be checked.
  const noTask = check(head, 'feature/x');
  expect(noTask.ok).toBe(false);
  expect(noTask.problems.join('\n')).toContain('task/<id>');
});

it('every field of the evidence can fail the check', () => {
  const head = git(repo, ['rev-parse', 'HEAD']);
  const cfg = loadProtected(REPO);
  const problemsOf = (doc: unknown): string =>
    evidenceProblems(doc, { prDir: repo, head, task: 'B2-01a', cfg, red: RED }).join('\n');
  const otherTree = git(repo, ['rev-parse', `${base}^{tree}`]);
  const cases: [string, Evidence | string, RegExp][] = [
    ['task', evidence({ task: 'B2-02' }), /task: must be "B2-01a"/],
    ['spec_ref', evidence({ spec_ref: 'd'.repeat(40) }), /spec_ref: differs from SPEC_REF/],
    ['spec_commit not an ancestor', evidence({ spec_commit: 'e'.repeat(40) }), /not an ancestor/],
    [
      'host run',
      evidence({ runs: [{ mode: 'host', exit_code: 0, tree: headTree }] }),
      /host results are not accepted/,
    ],
    [
      'failed run',
      evidence({ runs: [{ mode: 'container', script: 'verify', exit_code: 1, tree: headTree }] }),
      /a listed container verify run must have exit code 0/,
    ],
    [
      'other tree',
      evidence({ runs: [{ mode: 'container', script: 'verify', exit_code: 0, tree: otherTree }] }),
      /a listed container verify run must have exit code 0/,
    ],
    ['runs not a list', evidence({ runs: 'ci' }), /runs: must be a list/],
    [
      'missing codex review',
      evidence({
        reviews: [{ reviewer: 'claude', engine: 'claude', verdict: 'pass', open_s0_s1: 0 }],
      }),
      /missing the codex review/,
    ],
    ['no reviews at all', evidence({ reviews: [] }), /reviews: missing the codex review/],
    [
      'open S0',
      evidence({
        reviews: [
          { reviewer: 'claude', engine: 'claude', verdict: 'pass', open_s0_s1: 1 },
          {
            reviewer: 'codex',
            engine: 'codex',
            model: 'gpt-6-astra',
            verdict: 'pass',
            open_s0_s1: 0,
            checklist_complete: true,
          },
        ],
      }),
      /reviews.claude.open_s0_s1: must be 0/,
    ],
    [
      'checklist',
      evidence({
        reviews: [
          { reviewer: 'claude', engine: 'claude', verdict: 'pass', open_s0_s1: 0 },
          {
            reviewer: 'codex',
            engine: 'codex',
            model: 'gpt-6-astra',
            verdict: 'pass',
            open_s0_s1: 0,
            checklist_complete: false,
          },
        ],
      }),
      /checklist_complete: must be true/,
    ],
    ['tree mismatch', evidence({ trees: { 'packages/money': otherTree } }), /recorded .* head has/],
    [
      'tree path missing',
      evidence({ trees: { 'packages/nope': moneyTree } }),
      /does not exist at the head/,
    ],
    [
      'longrun failed',
      evidence({ longrun: { passed: false, tree: moneyTree } }),
      /longrun.passed: must be true/,
    ],
    [
      'longrun tree',
      evidence({ longrun: { passed: true, tree: otherTree } }),
      /longrun.tree: must equal/,
    ],
    ['not an object', '[]', /not a JSON object/],
  ];
  for (const [name, doc, pattern] of cases) {
    const parsed = typeof doc === 'string' ? JSON.parse(doc) : doc;
    expect(problemsOf(parsed), name).toMatch(pattern);
  }
  expect(problemsOf(evidence())).toBe('');
});

it('[CR-09] after a handover the evidence names the handover commit and only the Claude review of it must pass', () => {
  const head = git(repo, ['rev-parse', 'HEAD']); // the evidence commit
  const impl = git(repo, ['rev-list', '--reverse', `${specCommit}..${head}`]).split('\n')[0]!;
  const cfg = loadProtected(REPO);
  const allowed: HandoverPolicy = {
    allowed: true,
    reason: 'task risk RV1',
    paths: ['packages/money/src/**'],
  };
  const problemsOf = (
    doc: unknown,
    opts: { handover?: HandoverPolicy | undefined; at?: string } = {},
  ): string => {
    const policy = 'handover' in opts ? opts.handover : allowed;
    return evidenceProblems(doc, {
      prDir: repo,
      head: opts.at ?? head,
      task: 'B2-01a',
      cfg,
      red: RED,
      ...(policy === undefined ? {} : { handover: policy }),
    }).join('\n');
  };
  const codexBefore = {
    reviewer: 'codex',
    engine: 'codex',
    model: 'gpt-6-astra',
    verdict: 'fail',
    open_s0_s1: 1,
    checklist_complete: true,
  };
  const claudePass = {
    reviewer: 'claude',
    engine: 'claude',
    verdict: 'pass',
    open_s0_s1: 0,
    checklist_complete: true,
    commit: impl,
  };
  const handover = {
    implementer: 'codex',
    commit: impl,
    note: 'Opus implementation rounds used up',
  };

  // Without a handover both reviews must pass.
  expect(problemsOf(evidence({ reviews: [claudePass, codexBefore] }))).toMatch(
    /reviews.codex.verdict: must be pass/,
  );
  // With a valid handover the earlier Codex review is not checked; the Claude review of the
  // handover commit (or of a later ancestor of the head) still is.
  for (const commit of [impl, head]) {
    expect(
      problemsOf(evidence({ handover, reviews: [{ ...claudePass, commit }, codexBefore] })),
    ).toBe('');
  }
  expect(problemsOf(evidence({ handover, reviews: [codexBefore] }))).toMatch(
    /reviews: missing the claude review of the handover implementation/,
  );
  // A Claude review not bound to the handover commit (none, or from before it) does not count.
  const unbound = {
    reviewer: 'claude',
    engine: 'claude',
    verdict: 'pass',
    open_s0_s1: 0,
    checklist_complete: true,
  };
  for (const review of [unbound, { ...claudePass, commit: specCommit }]) {
    expect(problemsOf(evidence({ handover, reviews: [review, codexBefore] }))).toMatch(
      /reviews: missing the claude review of the handover implementation/,
    );
  }
  expect(
    problemsOf(
      evidence({ handover, reviews: [{ ...claudePass, verdict: 'fail', open_s0_s1: 1 }] }),
    ),
  ).toMatch(/reviews.claude.verdict: must be pass[\s\S]*reviews.claude.open_s0_s1: must be 0/);
  // Every bound Claude review counts (a failing later round fails), spec-test reviews do not, and
  // the Claude review carries the funds checklist the Codex one carried.
  expect(
    problemsOf(
      evidence({
        handover,
        reviews: [claudePass, { ...claudePass, commit: head, verdict: 'fail' }, codexBefore],
      }),
    ),
  ).toMatch(/reviews.claude.verdict: must be pass/);
  expect(
    problemsOf(evidence({ handover, reviews: [{ ...claudePass, review_type: 'spec-test' }] })),
  ).toMatch(/reviews: missing the claude review of the handover implementation/);
  const noChecklist = { ...claudePass, checklist_complete: false };
  expect(problemsOf(evidence({ handover, reviews: [noChecklist, codexBefore] }))).toMatch(
    /reviews.claude.checklist_complete: must be true after a handover/,
  );

  // RV2 不换家: without an allowing policy the handover is refused and both reviews stay required.
  for (const policy of [
    undefined,
    { allowed: false, reason: 'the task ledger paths are RV2', paths: allowed.paths },
  ]) {
    const text = problemsOf(evidence({ handover, reviews: [claudePass, codexBefore] }), {
      handover: policy,
    });
    expect(text).toMatch(/handover: not allowed: .*RV2 不换家/);
    expect(text).toMatch(/reviews.codex.verdict: must be pass/);
  }

  // A commit mixing ledger and other paths, and a merge commit, on a side branch.
  git(repo, ['checkout', '-q', '-b', 'handover-shapes', head]);
  write(repo, {
    'packages/money/src/index.ts': 'export const a = 3;\n',
    'docs/README.md': '# x\n',
  });
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'mixed']);
  const mixed = git(repo, ['rev-parse', 'HEAD']);
  git(repo, ['checkout', '-q', '-b', 'handover-side', impl]);
  write(repo, { 'packages/money/src/side.ts': 'export {};\n' });
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'side']);
  git(repo, ['checkout', '-q', 'handover-shapes']);
  const side = git(repo, ['rev-parse', 'handover-side']);
  git(repo, ['merge', '-q', '--no-ff', '-m', 'merge', 'handover-side']);
  const merge = git(repo, ['rev-parse', 'HEAD']);
  write(repo, { 'packages/money/src/index.ts': 'export const a = 4;\n' });
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'an Opus fix']);
  const unmarked = git(repo, ['rev-parse', 'HEAD']);
  const ledgerCommit = (ledger: string): string => {
    write(repo, {
      'packages/money/src/index.ts': `export const a = '${ledger}';\n`,
      [ledger]: 'id: x\n',
    });
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', `with ${ledger} (handover, Codex)`]);
    return git(repo, ['rev-parse', 'HEAD']);
  };
  const ownLedger = ledgerCommit('ops/tasks/B2-01a.yaml');
  const otherLedger = ledgerCommit('ops/tasks/B9-01a.yaml');
  git(repo, ['checkout', '-q', 'task/B2-01a']);

  // The handover commit may also change the task's own ledger file, no other one.
  const at = (commit: string): string =>
    problemsOf(
      evidence({ handover: { ...handover, commit }, reviews: [{ ...claudePass, commit }] }),
      { at: commit },
    );
  expect(at(ownLedger)).not.toMatch(/handover|reviews/);
  expect(at(otherLedger)).toMatch(
    /handover.commit: .* changes paths outside the task ledger: ops\/tasks\/B9-01a.yaml/,
  );

  // A Claude review of a commit off the head's history does not count; a change after the review
  // other than the task's evidence and ledger files fails.
  expect(problemsOf(evidence({ handover, reviews: [{ ...claudePass, commit: side }] }))).toMatch(
    /reviews: missing the claude review of the handover implementation/,
  );
  expect(problemsOf(evidence({ handover, reviews: [claudePass] }), { at: mixed })).toMatch(
    /reviews.claude.commit: changed after the Claude review .*: docs\/README.md, packages\/money\/src\/index.ts/,
  );

  // The handover commit must be a single-parent implementation commit after the rule-test commit
  // on the head, changing paths of the task ledger only; any defect falls back to both reviews.
  const cases: [unknown, RegExp][] = [
    [{ ...handover, commit: specCommit }, /handover.commit: .* is not after the rule-test commit/],
    [{ ...handover, commit: base }, /handover.commit: .* is not after the rule-test commit/],
    [
      { ...handover, commit: 'not-a-sha' },
      /handover.commit: must be the handover implementation commit id/,
    ],
    [{ ...handover, commit: 'f'.repeat(40) }, /handover.commit: .* is not an ancestor of the head/],
    [
      { ...handover, commit: head },
      /handover.commit: .* changes no implementation path of the task ledger/,
    ],
    [
      { ...handover, commit: mixed },
      /handover.commit: .* changes paths outside the task ledger: docs\/README.md/,
    ],
    [{ ...handover, commit: merge }, /handover.commit: .* must be a single-parent commit/],
    [{ ...handover, commit: unmarked }, /handover.commit: .* does not carry the handover marker/],
    [{ ...handover, implementer: 'claude' }, /handover.implementer: must be "codex"/],
    [{ ...handover, note: ' ' }, /handover.note: must say why/],
    ['codex', /handover: must be an object/],
  ];
  for (const [value, pattern] of cases) {
    const reviews = [{ ...claudePass, commit: unmarked }, codexBefore];
    const text = problemsOf(evidence({ handover: value, reviews }), { at: unmarked });
    expect(text, JSON.stringify(value)).toMatch(pattern);
    expect(text, JSON.stringify(value)).toMatch(/reviews.codex.verdict: must be pass/);
  }
});

it('[CR-09] checkEvidence refuses a handover on a money task and accepts one on an RV1 task', () => {
  // Money task (packages/money/src/**, RV2): a handover record never replaces the Codex review.
  const impl = git(repo, ['rev-list', '--reverse', `${specCommit}..task/B2-01a`]).split('\n')[0]!;
  git(repo, ['checkout', '-q', '-b', 'handover-money', 'task/B2-01a']);
  const moneyHead = commitEvidence(
    evidence({
      handover: { implementer: 'codex', commit: impl, note: 'rounds used up' },
      reviews: [
        {
          reviewer: 'claude',
          engine: 'claude',
          verdict: 'pass',
          open_s0_s1: 0,
          checklist_complete: true,
          commit: impl,
        },
      ],
    }),
  );
  git(repo, ['checkout', '-q', 'task/B2-01a']);
  const money = check(moneyHead);
  expect(money).toMatchObject({ ok: false, risk: 'RV2' });
  expect(money.problems.join('\n')).toMatch(/handover: not allowed: the task ledger paths are RV2/);
  expect(money.problems.join('\n')).toMatch(/missing the codex review/);

  // RV1 task (packages/evals/**): rule-test commit, Codex handover implementation, evidence.
  write(TRUSTED, {
    'ops/tasks/B3-01z.yaml': [
      'id: B3-01z',
      'repo: rebate-platform',
      'title: evals fixture',
      'type: impl',
      'refs: []',
      'refs_hash: {}',
      'deps: []',
      'paths:',
      "  - 'packages/evals/**'",
      'test_paths:',
      "  - 'test/spec/evals-z/**'",
      'impl: claude',
      'tester: codex',
      'accept:',
      "  - 'pnpm verify'",
      'status: todo',
      'pr: null',
      '',
    ].join('\n'),
  });
  const GATE = 'test/spec/evals-z/gate.test.ts';
  git(repo, ['checkout', '-q', '-b', 'task/B3-01z', base]);
  write(repo, { [GATE]: 'it("gates", () => {});\n' });
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'test(spec): gate']);
  const spec = git(repo, ['rev-parse', 'HEAD']);
  write(repo, { 'packages/evals/src/index.ts': 'export const gate = 1;\n' });
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'impl (handover, Codex)']);
  const handoverCommit = git(repo, ['rev-parse', 'HEAD']);
  const evalsTree = git(repo, ['rev-parse', 'HEAD:packages/evals']);
  const claude = {
    reviewer: 'claude',
    engine: 'claude',
    verdict: 'pass',
    open_s0_s1: 0,
    checklist_complete: true,
    commit: handoverCommit,
  };
  const doc = (reviews: unknown[]) => ({
    task: 'B3-01z',
    spec_ref: SPEC_REF,
    spec_commit: spec,
    red_tests: ['gates'],
    runs: [
      {
        mode: 'container',
        script: 'red',
        exit_code: 0,
        commit: null,
        tree: git(repo, ['rev-parse', `${spec}^{tree}`]),
        prop_seed: 1,
        red_tests: [`${GATE} > gates`],
        expected: [GATE],
      },
    ],
    reviews,
    handover: { implementer: 'codex', commit: handoverCommit, note: 'rounds used up' },
    trees: { 'packages/evals': evalsTree },
    longrun: { runs: 1000000, seed: 1, passed: true, tree: evalsTree },
  });
  const commitDoc = (value: unknown): string => {
    write(repo, { 'ops/evidence/B3-01z.json': `${JSON.stringify(value, null, 2)}\n` });
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', 'evidence']);
    return git(repo, ['rev-parse', 'HEAD']);
  };
  const codexFail = {
    reviewer: 'codex',
    engine: 'codex',
    model: 'gpt-6-astra',
    verdict: 'fail',
    open_s0_s1: 1,
  };
  const good = check(commitDoc(doc([claude, codexFail])), 'task/B3-01z');
  expect(good.problems).toEqual([]);
  // The rule tests make the pull request RV2, so the Claude review carries the checklist.
  expect(good).toMatchObject({ ok: true, risk: 'RV2', task: 'B3-01z' });
  const noChecklist = check(
    commitDoc(doc([{ ...claude, checklist_complete: false }, codexFail])),
    'task/B3-01z',
  );
  expect(noChecklist.problems.join('\n')).toMatch(/reviews.claude.checklist_complete/);
  git(repo, ['checkout', '-q', 'task/B2-01a']);

  // Variants on top of the handover commit, each with the same evidence.
  const variant = (name: string, files: Record<string, string>) => {
    git(repo, ['checkout', '-q', '-b', name, handoverCommit]);
    write(repo, files);
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', name]);
    const head = commitDoc(doc([claude, codexFail]));
    git(repo, ['checkout', '-q', 'task/B2-01a']);
    return check(head, 'task/B3-01z').problems.join('\n');
  };
  // A money / attribution path changed (RV2 不换家) refuses the handover.
  const moneyVariant = variant('b3z-money', { 'packages/money/src/m.ts': 'export {};\n' });
  expect(moneyVariant).toMatch(
    /handover: not allowed: money \/ attribution implementation paths changed/,
  );
  expect(moneyVariant).toMatch(/reviews.codex.verdict: must be pass/);
  // So does any other RV2 path outside the rule tests, the task's own files and docs.
  expect(variant('b3z-db', { 'packages/db/src/x.ts': 'export {};\n' })).toMatch(
    /handover: not allowed: changed paths are RV2 \(packages\/db\/src\/x.ts\)/,
  );
  // A change after the bound Claude review fails.
  expect(
    variant('b3z-later', { 'packages/evals/src/index.ts': 'export const gate = 2;\n' }),
  ).toMatch(
    /reviews.claude.commit: changed after the Claude review .*: packages\/evals\/src\/index.ts/,
  );
  // The ledger comes from the trusted root: the head rewriting it changes nothing.
  const rewritten = readFileSync(join(TRUSTED, 'ops/tasks/B3-01z.yaml'), 'utf8').replace(
    'packages/evals/**',
    'packages/db/**',
  );
  expect(variant('b3z-ledger', { 'ops/tasks/B3-01z.yaml': rewritten })).toBe('');
  // An unreadable ledger refuses the handover.
  const unreadable = handoverPolicy(
    { prDir: repo, base, head: handoverCommit, headRef: 'task/B3-01y', trusted: TRUSTED },
    'B3-01y',
    ['packages/evals/src/index.ts'],
    loadRiskMap(TRUSTED),
    loadProtected(TRUSTED),
  );
  expect(unreadable).toMatchObject({
    allowed: false,
    reason: 'ops/tasks/B3-01y.yaml could not be read',
  });
});

it('rule tests changed after the rule-test commit fail the check', () => {
  git(repo, ['checkout', '-q', '-b', 'task/B2-01b', 'task/B2-01a']);
  write(repo, { 'test/spec/money/floor.test.ts': 'it("floors differently", () => {});\n' });
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'weaken the rule test']);
  const head = git(repo, ['rev-parse', 'HEAD']);
  const cfg = loadProtected(REPO);
  const problems = evidenceProblems(evidence(), {
    prDir: repo,
    head,
    task: 'B2-01a',
    cfg,
    red: RED,
  });
  expect(problems.join('\n')).toContain('rule tests changed after the rule-test commit');
  expect(problems.join('\n')).toContain('test/spec/money/floor.test.ts (M)');
  git(repo, ['checkout', '-q', 'task/B2-01a']);
});

it('an RV0 branch needs no evidence file', () => {
  git(repo, ['checkout', '-q', '-b', 'task/D0-01', base]);
  write(repo, { 'docs/README.md': '# docs, updated\n' });
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'docs']);
  const head = git(repo, ['rev-parse', 'HEAD']);
  const report = check(head, 'task/D0-01');
  expect(report).toMatchObject({ ok: true, risk: 'RV0', task: 'D0-01', problems: [] });
  expect(report.notices.join('\n')).toContain('no evidence file required');
  git(repo, ['checkout', '-q', 'task/B2-01a']);
});

it('the CLI exits 1 on a failure and 2 on bad usage', () => {
  const script = join(REPO, 'tools/ci/evidence-check.ts');
  const head = git(repo, ['rev-parse', 'HEAD~1']); // the implementation commit, no evidence
  const failed = spawnSync(
    process.execPath,
    [script, '--pr', repo, '--base', base, '--head', head, '--head-ref', 'task/B2-01a', '--json'],
    { encoding: 'utf8' },
  );
  expect(failed.status).toBe(1);
  expect(JSON.parse(failed.stdout)).toMatchObject({ ok: false, risk: 'RV2' });
  const usage = spawnSync(process.execPath, [script, '--pr', repo], { encoding: 'utf8' });
  expect(usage.status).toBe(2);
});

/** A branch from the base with one commit writing `files`; returns its head. */
function branchFromBase(name: string, files: Record<string, string>): string {
  git(repo, ['checkout', '-q', '-b', name, base]);
  write(repo, files);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', name]);
  const head = git(repo, ['rev-parse', 'HEAD']);
  git(repo, ['checkout', '-q', 'task/B2-01a']);
  return head;
}

const approved = (head: string) => ({
  label: `owner-approved-${head.slice(0, 12)}`,
  approved: true,
  actor: 'o',
  reason: `label \`owner-approved-${head.slice(0, 12)}\` added by the owner account o`,
});

it('owner waiver: a non-task RV2 branch outside the money paths passes with a valid approval', () => {
  const head = branchFromBase('chore/gate-fix', { 'tools/guard/new-guard.ts': 'export {};\n' });
  const input = { prDir: repo, base, head, headRef: 'chore/gate-fix', trusted: TRUSTED };
  const waived = checkEvidence({ ...input, approval: approved(head) });
  expect(waived).toMatchObject({ ok: true, risk: 'RV2', task: null, waivable: true, waived: true });
  expect(waived.notices.join('\n')).toContain('evidence file waived by the owner approval');

  const noApproval = checkEvidence(input);
  expect(noApproval).toMatchObject({ ok: false, waivable: true, waived: false });
  expect(noApproval.notices.join('\n')).toContain('looked up only with --pr-number');

  const refused = checkEvidence({
    ...input,
    approval: { ...approved(head), approved: false, actor: 'ci-bot', reason: 'added by `ci-bot`' },
  });
  expect(refused).toMatchObject({ ok: false, waived: false });
  expect(refused.problems.join('\n')).toContain('owner approval: no (added by `ci-bot`)');
});

it('owner waiver: touching a money / attribution implementation path still needs evidence', () => {
  const cases: [string, Record<string, string>][] = [
    ['chore/money', { 'packages/money/src/index.ts': 'export const a = 3;\n' }],
    ['chore/domain', { 'packages/domain/src/period.ts': 'export {};\n' }],
    ['chore/ledger', { 'apps/api/src/modules/ledger/post.ts': 'export {};\n' }],
    ['chore/union', { 'apps/api/src/modules/union/adapter.ts': 'export {};\n' }],
    ['chore/migration', { 'db/migrations/0002_x.sql': 'select 1;\n' }],
  ];
  for (const [branch, files] of cases) {
    const head = branchFromBase(branch, { 'tools/x.ts': 'export {};\n', ...files });
    const report = checkEvidence({
      prDir: repo,
      base,
      head,
      headRef: branch,
      trusted: TRUSTED,
      approval: approved(head),
    });
    expect(report, branch).toMatchObject({ ok: false, waivable: false, waived: false });
    expect(report.money_paths, branch).toEqual(Object.keys(files));
    expect(report.problems.join('\n'), branch).toContain(
      'an owner approval label does not waive the evidence file',
    );
  }
  // A module that is not on the list and not in the risk map (here: growth) is waivable.
  // (identity, catalog, then notification, were the example until they got their own RV1 entries in ops/risk-map.yaml.)
  const growth = branchFromBase('chore/growth', {
    'apps/api/src/modules/growth/index.ts': 'export {};\n',
  });
  expect(
    checkEvidence({
      prDir: repo,
      base,
      head: growth,
      headRef: 'chore/growth',
      trusted: TRUSTED,
      approval: approved(growth),
    }),
  ).toMatchObject({ ok: true, waived: true, money_paths: [] });
});

it('owner waiver: task branches are unchanged', () => {
  const head = git(repo, ['rev-parse', 'task/B2-01a~1']); // the implementation, no evidence
  const report = checkEvidence({
    prDir: repo,
    base,
    head,
    headRef: 'task/B2-01a',
    trusted: TRUSTED,
    approval: approved(head),
  });
  expect(report).toMatchObject({ ok: false, task: 'B2-01a', waivable: false, waived: false });
  expect(report.problems.join('\n')).toContain('without ops/evidence/B2-01a.json');
});

it('the CLI looks the approval up with --pr-number, exactly like the protected-paths workflow', () => {
  const head = branchFromBase('chore/cli-waiver', { 'tools/y.ts': 'export {};\n' });
  const script = join(REPO, 'tools/ci/evidence-check.ts');
  const run = (labels: string[], labeledBy = 'o', liveHead = head) => {
    const routes = join(SCRATCH, `routes-${labels.join('-')}-${labeledBy}-${liveHead}.json`);
    writeFileSync(
      routes,
      JSON.stringify({
        '/repos/o/r/pulls/7': {
          status: 200,
          body: { head: { sha: liveHead }, labels: labels.map((name) => ({ name })) },
        },
        '/repos/o/r/issues/7/events?per_page=100&page=1': {
          status: 200,
          body: labels.map((name) => ({
            event: 'labeled',
            label: { name },
            actor: { login: labeledBy },
          })),
        },
      }),
    );
    const res = spawnSync(
      process.execPath,
      [
        '--import',
        join(REPO, 'tools/ci/testing/fake-github.ts'),
        script,
        '--pr',
        repo,
        '--base',
        base,
        '--head',
        head.slice(0, 12),
        '--head-ref',
        'chore/cli-waiver',
        '--pr-number',
        '7',
        '--json',
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          COULI_FAKE_GITHUB: routes,
          GITHUB_API_URL: 'https://api.github.invalid',
          GITHUB_REPOSITORY: 'o/r',
          GITHUB_REPOSITORY_OWNER: 'o',
          GH_TOKEN: 'not-a-real-token',
        },
      },
    );
    return { status: res.status, report: JSON.parse(res.stdout) as Record<string, unknown> };
  };
  const label = `owner-approved-${head.slice(0, 12)}`;
  expect(run([label])).toMatchObject({ status: 0, report: { ok: true, waived: true } });
  expect(run([`owner-approved-${base.slice(0, 12)}`])).toMatchObject({
    status: 1,
    report: { ok: false, waived: false },
  });
  expect(run([label], 'ci-bot')).toMatchObject({ status: 1, report: { ok: false } });
  expect(run([label], 'o', 'e'.repeat(40))).toMatchObject({ status: 1, report: { ok: false } });
});

it('[CR-02] a verify:fast record never stands in for the full verification', () => {
  const head = git(repo, ['rev-parse', 'HEAD']);
  const cfg = loadProtected(REPO);
  const problemsOf = (doc: unknown): string =>
    evidenceProblems(doc, { prDir: repo, head, task: 'B2-01a', cfg, red: RED }).join('\n');
  // Fast passed on the very tree, the full verification never ran: refused.
  const fastOnly = problemsOf(
    evidence({
      runs: [{ mode: 'container', script: 'verify:fast', exit_code: 0, tree: headTree }],
    }),
  );
  expect(fastOnly).toContain("verify:fast is the implementer's own check");
  // Fast passed, a listed full verification failed: refused.
  expect(
    problemsOf(
      evidence({
        runs: [
          { mode: 'container', script: 'verify:fast', exit_code: 0, tree: headTree },
          { mode: 'container', script: 'verify', exit_code: 1, tree: headTree },
        ],
      }),
    ),
  ).toContain('a listed container verify run must have exit code 0');
  // A record without a script cannot prove which one ran.
  expect(
    problemsOf(evidence({ runs: [{ mode: 'container', exit_code: 0, tree: headTree }] })),
  ).toContain('must be verify or red');
});

it('[CR2-06] CI records are refused until the CI evidence archive is connected', () => {
  const head = git(repo, ['rev-parse', 'HEAD']);
  const cfg = loadProtected(REPO);
  const ci = {
    mode: 'ci',
    phase: 'green',
    run_id: 102,
    run_url: 'https://github.com/o/r/actions/runs/102',
    run_attempt: 1,
    workflow: 'browser',
    job: 'playwright',
    commit: head,
    tree: headTree,
    report_sha256: 'a'.repeat(64),
    spec_commit: specCommit,
    conclusion: 'success',
    skipped: 0,
    exit_code: 0,
  };
  const doc = evidence();
  const problems = evidenceProblems(
    { ...doc, runs: [...(doc['runs'] as Evidence[]), ci] },
    { prDir: repo, head, task: 'B2-01a', cfg, red: RED },
  );
  expect(problems).toEqual([`runs[2].mode: ${CI_REFUSED}`]);
  expect(CI_REFUSED).toContain('CI 证据归档未接入，暂不接受');
});

it('[CR2-05] a task whose rule tests Codex writes needs a valid red run covering its new rule tests', () => {
  const head = git(repo, ['rev-parse', 'HEAD']);
  const cfg = loadProtected(REPO);
  const problemsOf = (runs: Evidence[], red = RED): string =>
    evidenceProblems(evidence({ runs }), { prDir: repo, head, task: 'B2-01a', cfg, red }).join(
      '\n',
    );
  const [redRun, verifyRun] = evidence()['runs'] as [Evidence, Evidence];
  expect(problemsOf([redRun, verifyRun])).toBe('');
  // The red run left out: "never red, straight to green" is refused.
  expect(problemsOf([verifyRun])).toContain('no valid red run');
  // A red run that failed red-check, ran on another tree, or skipped a new rule-test file.
  expect(problemsOf([{ ...redRun, exit_code: 1 }, verifyRun])).toContain('red-check passed');
  expect(problemsOf([{ ...redRun, tree: headTree }, verifyRun])).toContain(
    'must have run on the spec_commit tree',
  );
  expect(problemsOf([{ ...redRun, expected: [] }, verifyRun])).toContain(`does not cover ${FLOOR}`);
  expect(
    problemsOf([{ ...redRun, red_tests: ['test/spec/money/round.test.ts > rounds'] }, verifyRun]),
  ).toContain(`no red test of ${FLOOR}`);
  // Required, but the task added no rule-test file at all.
  expect(problemsOf([redRun, verifyRun], { required: true, expected: [] })).toContain(
    'the task added no rule-test file',
  );
  // Not required for a ledger of the switch baseline.
  expect(problemsOf([verifyRun], { required: false, expected: [] })).toBe('');
});

it('[CR2-05] the requirement comes from the trusted ledger and the switch-baseline list', () => {
  const head = git(repo, ['rev-parse', 'HEAD']);
  const text = JSON.stringify({ task: 'B2-01a', spec_commit: specCommit });
  const input = { prDir: repo, base, head, headRef: 'task/B2-01a', trusted: TRUSTED };
  expect(redRequirement(input, 'B2-01a', base, text)).toEqual({
    required: true,
    expected: [FLOOR],
  });
  // The real repository lists B2-01a among the switch-baseline ledgers (written by Claude).
  expect(redRequirement({ ...input, trusted: REPO }, 'B2-01a', base, text)).toEqual({
    required: false,
    expected: [],
  });
  // CR3-03: a new task with tester: claude is not exempt; only tester none or a legacy ledger.
  const claudeTrusted = join(SCRATCH, 'trusted-claude-tester');
  for (const file of [
    'tools/guard/protected-paths.json',
    'ops/risk-map.yaml',
    'tools/guard/legacy-tasks.json',
  ]) {
    write(claudeTrusted, { [file]: readFileSync(join(TRUSTED, file), 'utf8') });
  }
  write(claudeTrusted, {
    'ops/tasks/B2-01a.yaml': readFileSync(join(TRUSTED, 'ops/tasks/B2-01a.yaml'), 'utf8')
      .replace('impl: claude', 'impl: codex')
      .replace('tester: codex', 'tester: claude'),
  });
  expect(redRequirement({ ...input, trusted: claudeTrusted }, 'B2-01a', base, text)).toEqual({
    required: true,
    expected: [FLOOR],
  });
  // An unreadable ledger requires the red run with nothing to cover: fails closed.
  expect(redRequirement(input, 'B9-99', base, text)).toEqual({ required: true, expected: [] });
  // The full check: evidence without the red run fails.
  const doc = evidence();
  const runs = doc['runs'] as Evidence[];
  const noRed = commitEvidence({ ...doc, runs: runs.slice(1) });
  expect(check(noRed).problems.join('\n')).toContain('no valid red run');
});

it("[CT-06r] declared red exemptions need the rule-test reviewer's confirmation in spec_test_review", () => {
  const head = git(repo, ['rev-parse', 'HEAD']);
  const cfg = loadProtected(REPO);
  const declared = (tester: 'codex' | 'claude', count = 2) => ({
    ...RED,
    declared: { count, tester },
  });
  const problemsOf = (doc: Evidence, red: RedRequirement = declared('codex')): string =>
    evidenceProblems(doc, { prDir: repo, head, task: 'B2-01a', cfg, red }).join('\n');
  const want =
    'the ledger declares 2 red exemption(s) (red_exempt, CT-06r): the rule-test reviewer (claude) must confirm them in spec_test_review (reviewer claude, last_verdict pass, red_exempt_confirmed true)';
  const confirmed = {
    reviewer: 'claude',
    engine: 'claude',
    rounds: 1,
    last_verdict: 'pass',
    red_exempt_confirmed: true,
    note: 'the 2 declared structural tests are no weakening',
  };
  // Confirmed by the side that did not write the rule tests: fine.
  expect(problemsOf(evidence({ spec_test_review: confirmed }))).toBe('');
  // No review record, the wrong reviewer, a verdict other than pass, not confirmed or not true.
  expect(problemsOf(evidence())).toBe(`spec_test_review: ${want}`);
  expect(problemsOf(evidence({ spec_test_review: 'pass' }))).toBe(`spec_test_review: ${want}`);
  expect(
    problemsOf(
      evidence({
        spec_test_review: {
          ...confirmed,
          reviewer: 'codex',
          engine: 'codex',
          model: 'gpt-6-astra',
        },
      }),
    ),
  ).toBe(`spec_test_review.reviewer: ${want}`);
  expect(problemsOf(evidence({ spec_test_review: { ...confirmed, last_verdict: 'fail' } }))).toBe(
    `spec_test_review.last_verdict: ${want}`,
  );
  expect(
    problemsOf(evidence({ spec_test_review: { ...confirmed, red_exempt_confirmed: 'yes' } })),
  ).toBe(`spec_test_review.red_exempt_confirmed: ${want}`);
  const unconfirmed = { ...confirmed, red_exempt_confirmed: undefined };
  expect(problemsOf(evidence({ spec_test_review: unconfirmed }))).toBe(
    `spec_test_review.red_exempt_confirmed: ${want}`,
  );
  // Claude wrote the rule tests: Codex is the reviewer who confirms.
  expect(
    problemsOf(
      evidence({
        spec_test_review: {
          ...confirmed,
          reviewer: 'codex',
          engine: 'codex',
          model: 'gpt-6-astra',
        },
      }),
      declared('claude'),
    ),
  ).toBe('');
  // Nothing declared, or the red run not required: no confirmation asked for.
  expect(problemsOf(evidence(), declared('codex', 0))).toBe('');
  expect(problemsOf(evidence(), RED)).toBe('');
  expect(
    problemsOf(evidence({ runs: [] }), {
      required: false,
      expected: [],
      declared: { count: 2, tester: 'codex' },
    }),
  ).toBe('');

  // The requirement reads the declarations from the trusted ledger.
  const declaredTrusted = join(SCRATCH, 'trusted-declared');
  for (const file of [
    'tools/guard/protected-paths.json',
    'ops/risk-map.yaml',
    'tools/guard/legacy-tasks.json',
  ]) {
    write(declaredTrusted, { [file]: readFileSync(join(TRUSTED, file), 'utf8') });
  }
  write(declaredTrusted, {
    'ops/tasks/B2-01a.yaml': `${readFileSync(join(TRUSTED, 'ops/tasks/B2-01a.yaml'), 'utf8').trimEnd()}
red_exempt:
  - file: ${FLOOR}
    test: 'floors the format'
    reason: structural, holds for the old data too
`,
  });
  const text = JSON.stringify({ task: 'B2-01a', spec_commit: specCommit });
  const input = { prDir: repo, base, head, headRef: 'task/B2-01a', trusted: declaredTrusted };
  expect(redRequirement(input, 'B2-01a', base, text)).toEqual({
    required: true,
    expected: [FLOOR],
    declared: { count: 1, tester: 'codex' },
  });
  expect(redRequirement({ ...input, trusted: TRUSTED }, 'B2-01a', base, text)).toEqual(RED);
  // The full check: the declared exemption without the confirmation fails, with it passes.
  const branch = git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const run = (doc: Evidence) =>
    checkEvidence({ ...input, head: commitEvidence(doc) }).problems.join('\n');
  expect(run(evidence())).toContain('spec_test_review: the ledger declares 1 red exemption(s)');
  expect(run(evidence({ spec_test_review: confirmed }))).toBe('');
  git(repo, ['reset', '-q', '--hard', head]);
  expect(git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(branch);
});

it('[CT-06zzzc] a ledger with red_exempt_outside needs the same confirmation (red_exempt_confirmed)', () => {
  const head = git(repo, ['rev-parse', 'HEAD']);
  const cfg = loadProtected(REPO);
  const problemsOf = (doc: Evidence, red: RedRequirement): string =>
    evidenceProblems(doc, { prDir: repo, head, task: 'B2-01a', cfg, red }).join('\n');
  const red = { ...RED, declared: { count: 2, tester: 'codex' as const, outside: 1 } };
  const want =
    'the ledger declares 2 red exemption(s) (red_exempt, CT-06r) and 1 file(s) whose code outside the tests changed (red_exempt_outside, CT-06zzzc): the rule-test reviewer (claude) must confirm them in spec_test_review (reviewer claude, last_verdict pass, red_exempt_confirmed true)';
  const confirmed = {
    reviewer: 'claude',
    engine: 'claude',
    rounds: 1,
    last_verdict: 'pass',
    red_exempt_confirmed: true,
    note: 'the listed lines outside the tests only follow the contract',
  };
  expect(problemsOf(evidence(), red)).toBe(`spec_test_review: ${want}`);
  expect(
    problemsOf(
      evidence({ spec_test_review: { ...confirmed, red_exempt_confirmed: undefined } }),
      red,
    ),
  ).toBe(`spec_test_review.red_exempt_confirmed: ${want}`);
  expect(problemsOf(evidence({ spec_test_review: confirmed }), red)).toBe('');
  // Even with no red_exempt entry counted, the listing alone asks for the confirmation.
  expect(
    problemsOf(evidence(), { ...RED, declared: { count: 0, tester: 'codex', outside: 1 } }),
  ).toContain('spec_test_review: the ledger declares 0 red exemption(s)');

  // The requirement reads the section from the trusted ledger.
  const trusted = join(SCRATCH, 'trusted-outside');
  for (const file of [
    'tools/guard/protected-paths.json',
    'ops/risk-map.yaml',
    'tools/guard/legacy-tasks.json',
  ]) {
    write(trusted, { [file]: readFileSync(join(TRUSTED, file), 'utf8') });
  }
  write(trusted, {
    'ops/tasks/B2-01a.yaml': `${readFileSync(join(TRUSTED, 'ops/tasks/B2-01a.yaml'), 'utf8').trimEnd()}
red_exempt:
  - file: ${FLOOR}
    test: 'floors the format'
    reason: structural, holds for the old data too
red_exempt_outside:
  - file: ${FLOOR}
    reason: an import added for the new contract
`,
  });
  const text = JSON.stringify({ task: 'B2-01a', spec_commit: specCommit });
  const input = { prDir: repo, base, head, headRef: 'task/B2-01a', trusted };
  expect(redRequirement(input, 'B2-01a', base, text)).toEqual({
    required: true,
    expected: [FLOOR],
    declared: { count: 1, tester: 'codex', outside: 1 },
  });
});

it('[CT-06zzze] a ledger with red_exempt_rows needs red_exempt_rows_confirmed from the rule-test reviewer', () => {
  const head = git(repo, ['rev-parse', 'HEAD']);
  const cfg = loadProtected(REPO);
  const problemsOf = (doc: Evidence, red: RedRequirement): string =>
    evidenceProblems(doc, { prDir: repo, head, task: 'B2-01a', cfg, red }).join('\n');
  const red = { ...RED, rows: { count: 3, tester: 'codex' as const } };
  const want =
    'the ledger declares 3 kept row(s) of split .each tables (red_exempt_rows, CT-06zzze): the rule-test reviewer (claude) must confirm them one by one in spec_test_review (reviewer claude, last_verdict pass, red_exempt_rows_confirmed true)';
  const confirmed = {
    reviewer: 'claude',
    engine: 'claude',
    rounds: 1,
    last_verdict: 'pass',
    red_exempt_rows_confirmed: true,
    note: 'the kept rows are the base cases; the moved rows are red in their new tests',
  };
  expect(problemsOf(evidence({ spec_test_review: confirmed }), red)).toBe('');
  expect(problemsOf(evidence(), red)).toBe(`spec_test_review: ${want}`);
  // red_exempt_confirmed does not stand in for it, nor a value other than true.
  for (const value of [undefined, 'yes', 1]) {
    expect(
      problemsOf(
        evidence({
          spec_test_review: {
            ...confirmed,
            red_exempt_rows_confirmed: value,
            red_exempt_confirmed: true,
          },
        }),
        red,
      ),
    ).toBe(`spec_test_review.red_exempt_rows_confirmed: ${want}`);
  }
  // The rule-test author cannot confirm them; nor a verdict other than pass.
  expect(
    problemsOf(
      evidence({
        spec_test_review: {
          ...confirmed,
          reviewer: 'codex',
          engine: 'codex',
          model: 'gpt-6-astra',
        },
      }),
      red,
    ),
  ).toContain(`spec_test_review.reviewer: ${want}`);
  expect(
    problemsOf(evidence({ spec_test_review: { ...confirmed, last_verdict: 'fail' } }), red),
  ).toBe(`spec_test_review.last_verdict: ${want}`);
  // With red_exempt too, both confirmations are needed.
  const both = { ...red, declared: { count: 1, tester: 'codex' as const } };
  expect(problemsOf(evidence({ spec_test_review: confirmed }), both)).toContain(
    'spec_test_review.red_exempt_confirmed: the ledger declares 1 red exemption(s)',
  );
  expect(
    problemsOf(evidence({ spec_test_review: { ...confirmed, red_exempt_confirmed: true } }), both),
  ).toBe('');
  // Without rows nothing more is asked.
  expect(problemsOf(evidence(), RED)).toBe('');

  // The requirement reads the section from the trusted ledger.
  const trusted = join(SCRATCH, 'trusted-rows');
  for (const file of [
    'tools/guard/protected-paths.json',
    'ops/risk-map.yaml',
    'tools/guard/legacy-tasks.json',
  ]) {
    write(trusted, { [file]: readFileSync(join(TRUSTED, file), 'utf8') });
  }
  write(trusted, {
    'ops/tasks/B2-01a.yaml': `${readFileSync(join(TRUSTED, 'ops/tasks/B2-01a.yaml'), 'utf8').trimEnd()}
red_exempt_rows:
  - file: ${FLOOR}
    test: 'floors 1'
    reason: the kept rows are the base cases
  - file: ${FLOOR}
    test: 'floors 2'
    reason: the kept rows are the base cases
`,
  });
  const text = JSON.stringify({ task: 'B2-01a', spec_commit: specCommit });
  const input = { prDir: repo, base, head, headRef: 'task/B2-01a', trusted };
  expect(redRequirement(input, 'B2-01a', base, text)).toEqual({
    required: true,
    expected: [FLOOR],
    rows: { count: 2, tester: 'codex' },
  });
});

it('[CT-06zzzd] a file listed in red_exempt_outside whose every test is unchanged and declared is left out of the expected list; the confirmation is still required', () => {
  const ETAG = 'test/spec/money/etag.test.ts';
  const source = (extra: string, body = 'expect(1).toBe(1);'): string =>
    [
      "import { expect, it } from 'vitest';",
      extra,
      "it('[AC-1] a', () => { expect(2).toBe(2); });",
      `it('[AC-2] b', () => { ${body} });`,
      '',
    ].join('\n');
  git(repo, ['checkout', '-q', '-b', 'ct06zzzd-base', base]);
  write(repo, { [ETAG]: source('') });
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'ct06zzzd-base']);
  const frozen = git(repo, ['rev-parse', 'HEAD']);
  const spec = (extra: string, body?: string): string => {
    git(repo, ['checkout', '-q', '-B', 'ct06zzzd-spec', frozen]);
    write(repo, { [ETAG]: source(extra, body) });
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', 'ct06zzzd-spec']);
    const sha = git(repo, ['rev-parse', 'HEAD']);
    git(repo, ['checkout', '-q', 'task/B2-01a']);
    return sha;
  };
  const importOnly = spec("import { sign } from './sign.ts';");
  const alsoChanged = spec("import { sign } from './sign.ts';", 'expect(sign(1)).toBe(1);');
  const trustedWith = (name: string, sections: string): string => {
    const dir = join(SCRATCH, name);
    for (const file of [
      'tools/guard/protected-paths.json',
      'ops/risk-map.yaml',
      'tools/guard/legacy-tasks.json',
    ]) {
      write(dir, { [file]: readFileSync(join(TRUSTED, file), 'utf8') });
    }
    write(dir, {
      'ops/tasks/B2-01a.yaml': `${readFileSync(join(TRUSTED, 'ops/tasks/B2-01a.yaml'), 'utf8').trimEnd()}
${sections}`,
    });
    return dir;
  };
  const exempt = `red_exempt:
  - file: ${ETAG}
    test: '[AC-1] a'
    reason: structural, holds for the old data too
  - file: ${ETAG}
    test: '[AC-2] b'
    reason: structural, holds for the old data too
`;
  const outside = `red_exempt_outside:
  - file: ${ETAG}
    reason: an import for the contract type only
`;
  const listed = trustedWith('trusted-ct06zzzd', exempt + outside);
  const notListed = trustedWith('trusted-ct06zzzd-not', exempt);
  const req = (head: string, trusted: string) =>
    redRequirement(
      { prDir: repo, base: frozen, head, headRef: 'task/B2-01a', trusted },
      'B2-01a',
      frozen,
      JSON.stringify({ task: 'B2-01a', spec_commit: head }),
    );
  // Listed, every test unchanged and declared: left out; the confirmation is still asked for.
  const left = req(importOnly, listed);
  expect(left).toEqual({
    required: true,
    expected: [],
    declared: { count: 2, tester: 'codex', outside: 1 },
  });
  // Not listed: expected as before (and red-check fails it: every test declared).
  expect(req(importOnly, notListed)).toEqual({
    required: true,
    expected: [ETAG],
    declared: { count: 2, tester: 'codex' },
  });
  // Listed, but a test changed: expected as before (the changed test must be red).
  expect(req(alsoChanged, listed)).toMatchObject({ expected: [ETAG] });
  // The coverage rule is unchanged: with the file left out the evidence passes once confirmed.
  const head = git(repo, ['rev-parse', 'HEAD']);
  const cfg = loadProtected(REPO);
  const problemsOf = (doc: Evidence): string =>
    // The task's other rule-test file (FLOOR) still needs its red test.
    evidenceProblems(doc, {
      prDir: repo,
      head,
      task: 'B2-01a',
      cfg,
      red: { ...left, expected: [...left.expected, FLOOR] },
    }).join('\n');
  const confirmed = {
    reviewer: 'claude',
    engine: 'claude',
    rounds: 1,
    last_verdict: 'pass',
    red_exempt_confirmed: true,
    note: 'import only; every test unchanged and declared',
  };
  expect(problemsOf(evidence({ spec_test_review: confirmed }))).toBe('');
  expect(problemsOf(evidence())).toContain(
    'spec_test_review: the ledger declares 2 red exemption(s)',
  );
  // The file kept in the list without a red test: the coverage rule still catches it.
  expect(
    evidenceProblems(evidence({ spec_test_review: confirmed }), {
      prDir: repo,
      head,
      task: 'B2-01a',
      cfg,
      red: { ...left, expected: [FLOOR, ETAG] },
    }).join('\n'),
  ).toContain(`does not cover ${ETAG}, a rule-test file the task added`);
});

it('[legacy flow] a legacy ledger needs no red run and no test_paths, but still the full container verify', () => {
  // A B1-01s-shape ledger: Codex implements, Claude wrote the rule tests, no test_paths; listed
  // on the trusted legacy list.
  const legacyTrusted = join(SCRATCH, 'trusted-legacy');
  for (const file of ['tools/guard/protected-paths.json', 'ops/risk-map.yaml']) {
    write(legacyTrusted, { [file]: readFileSync(join(REPO, file), 'utf8') });
  }
  write(legacyTrusted, {
    'tools/guard/legacy-tasks.json': JSON.stringify({ baseline: 'fixture', tasks: ['B2-01a'] }),
    'ops/tasks/B2-01a.yaml': readFileSync(join(TRUSTED, 'ops/tasks/B2-01a.yaml'), 'utf8')
      .replace('impl: claude', 'impl: codex')
      .replace('tester: codex', 'tester: claude')
      .replace("test_paths:\n  - 'test/spec/money/**'\n", ''),
  });
  const doc = evidence();
  const runs = doc['runs'] as Evidence[];
  const head = commitEvidence({ ...doc, runs: runs.slice(1) });
  const input = { prDir: repo, base, head, headRef: 'task/B2-01a', trusted: legacyTrusted };
  expect(checkEvidence(input).problems).toEqual([]);
  // The required CI checks are the full verification (ops/approvals.yaml id 21): no container
  // verify run is needed, an empty run list passes for a ledger without a red-run requirement.
  const noVerify = commitEvidence({ ...doc, runs: runs.slice(0, 1) });
  expect(checkEvidence({ ...input, head: noVerify }).problems).toEqual([]);
  const noRuns = commitEvidence({ ...doc, runs: [] });
  expect(checkEvidence({ ...input, head: noRuns }).problems).toEqual([]);
});

it('[approvals 27] the side that did not implement reviews; the other entry is optional', () => {
  const head = git(repo, ['rev-parse', 'HEAD']);
  const cfg = loadProtected(REPO);
  const problemsOf = (doc: unknown, implementer?: 'claude' | 'codex' | 'unknown'): string =>
    evidenceProblems(doc, {
      prDir: repo,
      head,
      task: 'B2-01a',
      cfg,
      red: RED,
      ...(implementer === undefined ? {} : { implementer }),
    }).join('\n');
  const codexPass = {
    reviewer: 'codex',
    engine: 'codex',
    model: 'gpt-6-astra',
    verdict: 'pass',
    open_s0_s1: 0,
    checklist_complete: true,
  };
  const claudePass = { reviewer: 'claude', engine: 'claude', verdict: 'pass', open_s0_s1: 0 };
  // Opus implemented (absent or explicit claude): the Codex review alone is enough.
  expect(problemsOf(evidence({ reviews: [codexPass] }))).toBe('');
  expect(problemsOf(evidence({ reviews: [codexPass] }), 'claude')).toBe('');
  // A missing or failing Codex review still fails.
  expect(problemsOf(evidence({ reviews: [claudePass] }))).toMatch(/missing the codex review/);
  expect(problemsOf(evidence({ reviews: [{ ...codexPass, open_s0_s1: 1 }] }))).toMatch(
    /reviews.codex.open_s0_s1: must be 0/,
  );
  expect(problemsOf(evidence({ reviews: [{ ...codexPass, checklist_complete: false }] }))).toMatch(
    /reviews.codex.checklist_complete: must be true/,
  );
  // A Claude entry that is present is still validated.
  expect(
    problemsOf(evidence({ reviews: [{ ...claudePass, verdict: 'fail' }, codexPass] })),
  ).toMatch(/reviews.claude.verdict: must be pass/);
  // Codex implemented: the Claude review is required, the Codex one optional (checked if present).
  expect(problemsOf(evidence({ reviews: [codexPass] }), 'codex')).toMatch(
    /reviews: missing the claude review \(implementer: codex/,
  );
  expect(problemsOf(evidence({ reviews: [claudePass] }), 'codex')).toBe('');
  expect(
    problemsOf(evidence({ reviews: [claudePass, { ...codexPass, verdict: 'fail' }] }), 'codex'),
  ).toMatch(/reviews.codex.verdict: must be pass/);
  // Unknown implementer (ledger unreadable): both are required.
  expect(problemsOf(evidence({ reviews: [codexPass] }), 'unknown')).toMatch(
    /missing the claude review/,
  );
  expect(problemsOf(evidence({ reviews: [claudePass] }), 'unknown')).toMatch(
    /missing the codex review/,
  );
  expect(problemsOf(evidence({ reviews: [claudePass, codexPass] }), 'unknown')).toBe('');

  // A handover commit on the head without a handover record: Codex implemented although the
  // ledger says claude, so the Claude review stays required (Codex review CR-27-01). The fixture's
  // implementation commit carries the handover marker.
  const onlyCodex = commitEvidence(evidence({ reviews: [codexPass] }));
  expect(check(onlyCodex).problems.join('\n')).toMatch(
    /missing the claude review \(\w+ carries the handover marker/,
  );
  // Through checkEvidence the implementer comes from the trusted ledger: the same implementation
  // committed without the marker passes with the Codex review alone.
  const branchBack = git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
  git(repo, ['checkout', '-q', '-b', 'approvals-27-plain', specCommit]);
  write(repo, { 'packages/money/src/index.ts': 'export const a = 2;\n' });
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'impl']);
  const plain = commitEvidence(evidence({ reviews: [codexPass] }));
  expect(check(plain).problems).toEqual([]);
  const codexTrusted = join(SCRATCH, 'trusted-codex-impl');
  for (const file of [
    'tools/guard/protected-paths.json',
    'ops/risk-map.yaml',
    'tools/guard/legacy-tasks.json',
  ]) {
    write(codexTrusted, { [file]: readFileSync(join(TRUSTED, file), 'utf8') });
  }
  write(codexTrusted, {
    'ops/tasks/B2-01a.yaml': readFileSync(join(TRUSTED, 'ops/tasks/B2-01a.yaml'), 'utf8')
      .replace('impl: claude', 'impl: codex')
      .replace('tester: codex', 'tester: claude'),
  });
  const input = {
    prDir: repo,
    base,
    head: plain,
    headRef: 'task/B2-01a',
    trusted: codexTrusted,
  };
  expect(checkEvidence(input).problems.join('\n')).toMatch(/missing the claude review/);
  const onlyClaude = commitEvidence(evidence({ reviews: [claudePass] }));
  expect(checkEvidence({ ...input, head: onlyClaude }).problems).toEqual([]);
  git(repo, ['checkout', '-q', branchBack]);
});

it('[approvals 36] an independent Claude review stands in for the missing side, recorded under its own engine', () => {
  const head = git(repo, ['rev-parse', 'HEAD']);
  const cfg = loadProtected(REPO);
  const problemsOf = (doc: unknown, implementer?: 'claude' | 'codex' | 'unknown'): string =>
    evidenceProblems(doc, {
      prDir: repo,
      head,
      task: 'B2-01a',
      cfg,
      red: RED,
      ...(implementer === undefined ? {} : { implementer }),
    }).join('\n');
  const independent = {
    reviewer: 'claude-independent',
    engine: 'claude-independent',
    model: 'claude-opus-5-5',
    verdict: 'pass',
    open_s0_s1: 0,
    checklist_complete: true,
  };
  const codexPass = {
    reviewer: 'codex',
    engine: 'codex',
    model: 'gpt-6-astra',
    verdict: 'pass',
    open_s0_s1: 0,
    checklist_complete: true,
  };
  const claudePass = { reviewer: 'claude', engine: 'claude', verdict: 'pass', open_s0_s1: 0 };
  // Opus implemented and Codex was not available: the independent Claude review is enough.
  expect(problemsOf(evidence({ reviews: [independent] }))).toBe('');
  expect(problemsOf(evidence({ reviews: [independent] }), 'claude')).toBe('');
  // Codex implemented: it stands in for the Claude review as well.
  expect(problemsOf(evidence({ reviews: [independent] }), 'codex')).toBe('');
  // Ledger unreadable: one side of its own is still needed besides one stand-in.
  expect(problemsOf(evidence({ reviews: [claudePass, independent] }), 'unknown')).toBe('');
  expect(problemsOf(evidence({ reviews: [codexPass, independent] }), 'unknown')).toBe('');
  expect(problemsOf(evidence({ reviews: [independent] }), 'unknown')).toMatch(
    /missing the codex review/,
  );
  expect(problemsOf(evidence({ reviews: [independent, { ...independent }] }), 'unknown')).toMatch(
    /both sides are independent Claude entries/,
  );
  // The same conditions as a Codex entry: pass, no open S0 / S1, the funds checklist complete.
  expect(problemsOf(evidence({ reviews: [{ ...independent, verdict: 'fail' }] }))).toMatch(
    /reviews.claude-independent.verdict: must be pass/,
  );
  expect(problemsOf(evidence({ reviews: [{ ...independent, open_s0_s1: 1 }] }))).toMatch(
    /reviews.claude-independent.open_s0_s1: must be 0/,
  );
  expect(
    problemsOf(evidence({ reviews: [{ ...independent, checklist_complete: false }] })),
  ).toMatch(/reviews.claude-independent.checklist_complete: must be true/);
  // An extra independent entry next to a passing Codex review is checked all the same.
  expect(
    problemsOf(evidence({ reviews: [codexPass, { ...independent, verdict: 'fail' }] })),
  ).toMatch(/reviews.claude-independent.verdict: must be pass/);
  // No stand-in, no review: the message says how to record one.
  expect(problemsOf(evidence({ reviews: [] }))).toMatch(
    /missing the codex review[\s\S]*reviewer "claude-independent"/,
  );
});

it("[approvals 36] an independent Claude review is never filed as Codex's: engine and model are bound to the reviewer", () => {
  const head = git(repo, ['rev-parse', 'HEAD']);
  const cfg = loadProtected(REPO);
  const problemsOf = (doc: unknown): string =>
    evidenceProblems(doc, { prDir: repo, head, task: 'B2-01a', cfg, red: RED }).join('\n');
  const codexPass = {
    reviewer: 'codex',
    engine: 'codex',
    model: 'gpt-6-astra',
    verdict: 'pass',
    open_s0_s1: 0,
    checklist_complete: true,
  };
  expect(problemsOf(evidence({ reviews: [codexPass] }))).toBe('');
  // #1046 r1 S2: every entry names its engine; a codex entry without one is refused.
  const noEngine: Evidence = { ...codexPass };
  delete noEngine['engine'];
  expect(problemsOf(evidence({ reviews: [noEngine] }))).toMatch(
    /reviews.codex.engine: must be "codex" \(every review entry names the engine/,
  );
  // A Claude review recorded as Codex's is refused, by its engine or by its model.
  expect(
    problemsOf(evidence({ reviews: [{ ...codexPass, engine: 'claude-independent' }] })),
  ).toMatch(/reviews.codex.engine: engine claude-independent does not match reviewer "codex"/);
  expect(problemsOf(evidence({ reviews: [{ ...codexPass, model: 'claude-opus-5-5' }] }))).toMatch(
    /reviews.codex.engine: engine codex runs gpt-6-astra: the entry must say model "gpt-6-astra"/,
  );
  const noModel: Evidence = { ...codexPass };
  delete noModel['model'];
  expect(problemsOf(evidence({ reviews: [noModel] }))).toMatch(/must say model "gpt-6-astra"/);
  expect(problemsOf(evidence({ reviews: [{ ...codexPass, engine: 'gpt' }] }))).toMatch(
    /reviews.codex.engine: must be one of codex, claude, claude-independent/,
  );
  // An independent Claude entry: its own engine and claude-opus-5-5.
  const independent = {
    ...codexPass,
    reviewer: 'claude-independent',
    engine: 'claude-independent',
    model: 'claude-opus-5-5',
  };
  expect(problemsOf(evidence({ reviews: [independent] }))).toBe('');
  expect(problemsOf(evidence({ reviews: [{ ...independent, model: 'gpt-6-astra' }] }))).toMatch(
    /reviews.claude-independent.engine: engine claude-independent runs claude-opus-5-5/,
  );
  expect(problemsOf(evidence({ reviews: [{ ...independent, engine: 'codex' }] }))).toMatch(
    /reviews.claude-independent.engine: engine codex does not match/,
  );
  // The orchestrator's Claude subagent: engine claude, no model bound.
  expect(engineProblem({ reviewer: 'claude', engine: 'claude' })).toBeNull();
  expect(engineProblem({ reviewer: 'claude' })).toMatch(/must be "claude"/);
});

it('[approvals 36] rule-test reviewers: an independent Claude context confirms red exemptions for any author', () => {
  expect(specTestReviewers('codex')).toEqual(['claude', 'claude-independent']);
  expect(specTestReviewers('claude')).toEqual(['codex', 'claude-independent']);
  expect(specTestReviewers('claude-independent')).toEqual(['claude', 'claude-independent']);
  const head = git(repo, ['rev-parse', 'HEAD']);
  const cfg = loadProtected(REPO);
  const problemsOf = (doc: Evidence, tester: 'codex' | 'claude' | 'claude-independent'): string =>
    evidenceProblems(doc, {
      prDir: repo,
      head,
      task: 'B2-01a',
      cfg,
      red: { ...RED, declared: { count: 1, tester } },
    }).join('\n');
  const confirmed = {
    reviewer: 'claude-independent',
    engine: 'claude-independent',
    model: 'claude-opus-5-5',
    rounds: 1,
    last_verdict: 'pass',
    red_exempt_confirmed: true,
  };
  for (const tester of ['codex', 'claude', 'claude-independent'] as const) {
    expect(problemsOf(evidence({ spec_test_review: confirmed }), tester), tester).toBe('');
  }
  // Tests of an independent Claude call: the orchestrator's Claude may confirm, Codex is not listed.
  expect(
    problemsOf(
      evidence({ spec_test_review: { ...confirmed, reviewer: 'claude', engine: 'claude' } }),
      'claude-independent',
    ),
  ).toBe('');
  expect(
    problemsOf(
      evidence({ spec_test_review: { ...confirmed, reviewer: 'codex', engine: 'codex' } }),
      'claude-independent',
    ),
  ).toMatch(/spec_test_review.reviewer: .*reviewer \(claude\)/);
  // The engine of the confirmation must match its reviewer too.
  expect(
    problemsOf(evidence({ spec_test_review: { ...confirmed, reviewer: 'claude' } }), 'codex'),
  ).toMatch(/spec_test_review.engine: engine claude-independent does not match reviewer "claude"/);
});

it('[approvals 36] after a handover an independent Claude review of the handover commit counts as the Claude review', () => {
  const head = git(repo, ['rev-parse', 'HEAD']);
  const impl = git(repo, ['rev-list', '--reverse', `${specCommit}..${head}`]).split('\n')[0]!;
  const cfg = loadProtected(REPO);
  const handover = {
    implementer: 'codex',
    commit: impl,
    note: 'Opus implementation rounds used up',
  };
  const problemsOf = (reviews: unknown[]): string =>
    evidenceProblems(evidence({ handover, reviews }), {
      prDir: repo,
      head,
      task: 'B2-01a',
      cfg,
      red: RED,
      handover: { allowed: true, reason: 'task risk RV1', paths: ['packages/money/src/**'] },
    }).join('\n');
  const bound = {
    reviewer: 'claude-independent',
    engine: 'claude-independent',
    model: 'claude-opus-5-5',
    verdict: 'pass',
    open_s0_s1: 0,
    checklist_complete: true,
    commit: impl,
  };
  expect(problemsOf([bound])).toBe('');
  expect(problemsOf([{ ...bound, verdict: 'fail' }])).toMatch(
    /reviews.claude.verdict: must be pass/,
  );
  expect(problemsOf([{ ...bound, engine: 'codex' }])).toMatch(/reviews.claude.engine/);
  expect(problemsOf([{ ...bound, commit: specCommit }])).toMatch(
    /missing the claude review of the handover implementation/,
  );
});

it('[approvals 32] a pure migration rename hotfix needs no task branch and no evidence; anything more is refused', () => {
  const back = git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const UP = '-- Up Migration\n';
  // Main after two lines both merged a 0002 (the 0025 / 0031 collisions of 2026-10-09 / -16).
  git(repo, ['checkout', '-q', '-b', 'mig-main', base]);
  write(repo, {
    'db/migrations/0001_init.sql': `${UP}create table app.a (id int);\n`,
    'db/migrations/0002_favorites.sql': `${UP}create table app.f (id int);\n`,
    'db/migrations/0002_commission-rules.sql': `${UP}create table app.c (id int);\n`,
    'db/schema.sql': '-- applied: 0001_init.sql, 0002_commission-rules.sql, 0002_favorites.sql\n',
    'docs/migrations.md': 'see db/migrations/0002_favorites.sql\n',
    'tools/x.ts': "export const file = '0002_favorites.sql';\n",
  });
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'collision']);
  const mainHead = git(repo, ['rev-parse', 'HEAD']);

  /** A branch from mig-main: `mv` renames (git mv), then `files` written, then `rm` removed. */
  const hotfix = (
    name: string,
    change: { mv?: [string, string][]; files?: Record<string, string>; rm?: string[] },
  ): string => {
    git(repo, ['checkout', '-q', '-B', `${name}-work`, mainHead]);
    for (const [from, to] of change.mv ?? []) git(repo, ['mv', from, to]);
    write(repo, change.files ?? {});
    for (const path of change.rm ?? []) git(repo, ['rm', '-q', path]);
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '--allow-empty', '-m', name]);
    return git(repo, ['rev-parse', 'HEAD']);
  };
  const run = (head: string, headRef = 'fix/migration-0002-collision') =>
    checkEvidence({ prDir: repo, base: mainHead, head, headRef, trusted: TRUSTED });
  const MV: [string, string] = [
    'db/migrations/0002_favorites.sql',
    'db/migrations/0003_favorites.sql',
  ];
  const REFS = {
    'db/schema.sql': '-- applied: 0001_init.sql, 0002_commission-rules.sql, 0003_favorites.sql\n',
    'docs/migrations.md': 'see db/migrations/0003_favorites.sql\n',
  };

  // Positive: the rename alone, and the rename with its file-name references updated.
  const plain = hotfix('plain', { mv: [MV] });
  const plainReport = run(plain);
  expect(plainReport.problems).toEqual([]);
  expect(plainReport).toMatchObject({ ok: true, risk: 'RV2', task: null, migration_rename: true });
  expect(plainReport.notices.join('\n')).toContain('pure migration rename hotfix');
  const withRefs = hotfix('refs', { mv: [MV], files: REFS });
  expect(run(withRefs)).toMatchObject({ ok: true, migration_rename: true });

  const refused = (head: string, needle: string, headRef?: string): void => {
    const report = run(head, headRef);
    expect(report, needle).toMatchObject({ ok: false, migration_rename: false });
    expect(report.notices.join('\n'), needle).toContain(needle);
  };
  // The branch name does not match: the normal rule (task branch / money path) applies.
  const wrongBranch = run(plain, 'fix/migration-0031-renames');
  expect(wrongBranch).toMatchObject({ ok: false, migration_rename: false });
  expect(wrongBranch.problems.join('\n')).toContain('task/<id>');
  refused(plain, 'no two migrations numbered 0005', 'fix/migration-0005-collision');
  // The SQL content changed along with the rename: no longer an exact rename (a deletion and an
  // addition under -M100%).
  refused(
    hotfix('edited', {
      mv: [MV],
      files: { 'db/migrations/0003_favorites.sql': `${UP}create table app.f (id bigint);\n` },
    }),
    'db/migrations/0003_favorites.sql (A): a migration may only be renamed',
  );
  // A migration added, or deleted.
  refused(
    hotfix('added', { mv: [MV], files: { 'db/migrations/0004_more.sql': `${UP}select 1;\n` } }),
    'db/migrations/0004_more.sql (A): a migration may only be renamed',
  );
  refused(
    hotfix('deleted', { rm: ['db/migrations/0002_favorites.sql'] }),
    'db/migrations/0002_favorites.sql (D)',
  );
  // An existing migration edited in place.
  refused(
    hotfix('in-place', {
      mv: [MV],
      files: { 'db/migrations/0001_init.sql': `${UP}create table app.a (id bigint);\n` },
    }),
    'db/migrations/0001_init.sql (M)',
  );
  // Still a duplicate, or a gap, after the rename.
  refused(
    hotfix('still-dup', {
      mv: [['db/migrations/0002_favorites.sql', 'db/migrations/0001_favorites.sql']],
    }),
    'without a duplicate or a gap (0001, 0001, 0002)',
  );
  refused(
    hotfix('gap', {
      mv: [['db/migrations/0002_favorites.sql', 'db/migrations/0004_favorites.sql']],
    }),
    'without a duplicate or a gap (0001, 0002, 0004)',
  );
  // A migration of another number renamed, or a malformed new name.
  refused(
    hotfix('other', { mv: [['db/migrations/0001_init.sql', 'db/migrations/0003_init.sql']] }),
    'only a migration numbered 0002 may be renamed',
  );
  refused(
    hotfix('bad-name', {
      mv: [['db/migrations/0002_favorites.sql', 'db/migrations/0003_Fav.sql']],
    }),
    'the new name is not db/migrations/NNNN_kebab-name.sql',
  );
  // Another code path changed, even only by the file name; a reference file changed beyond the name.
  refused(
    hotfix('code', {
      mv: [MV],
      files: { 'tools/x.ts': "export const file = '0003_favorites.sql';\n", 'tools/y.ts': '' },
    }),
    'tools/y.ts (A): only migration renames and file-name references may change',
  );
  refused(
    hotfix('docs-extra', {
      mv: [MV],
      files: { 'docs/migrations.md': 'see db/migrations/0003_favorites.sql (moved)\n' },
    }),
    'docs/migrations.md: changes other than replacing the renamed file names',
  );
  refused(
    hotfix('money', {
      mv: [MV],
      files: { 'packages/money/src/index.ts': 'export const a = 9;\n' },
    }),
    'packages/money/src/index.ts',
  );
  refused(hotfix('nothing', {}), 'no migration was renamed');
  git(repo, ['checkout', '-q', back]);
});

it('[CT-06zxc] a rule-test file that differs from its base only by the ledger renames is not expected', () => {
  const ROUND = 'test/spec/money/round.test.ts';
  const renamedTrusted = join(SCRATCH, 'trusted-renames');
  for (const file of [
    'tools/guard/protected-paths.json',
    'ops/risk-map.yaml',
    'tools/guard/legacy-tasks.json',
  ]) {
    write(renamedTrusted, { [file]: readFileSync(join(TRUSTED, file), 'utf8') });
  }
  write(renamedTrusted, {
    'ops/tasks/B2-01a.yaml': `${readFileSync(join(TRUSTED, 'ops/tasks/B2-01a.yaml'), 'utf8').trimEnd()}
renames:
  - from: '"rounds"'
    to: '"rounds_half_up"'
`,
  });
  const onlyRenamed = branchFromBase('ct06zxc-renamed', {
    [ROUND]: 'it("rounds_half_up", () => {});\n',
    [FLOOR]: 'it("floors", () => {});\n',
  });
  const alsoChanged = branchFromBase('ct06zxc-changed', {
    [ROUND]: 'it("rounds_half_up", () => { expect(1).toBe(1); });\n',
    [FLOOR]: 'it("floors", () => {});\n',
  });
  const head = git(repo, ['rev-parse', 'HEAD']);
  const req = (spec: string, trusted: string) =>
    redRequirement(
      { prDir: repo, base, head, headRef: 'task/B2-01a', trusted },
      'B2-01a',
      base,
      JSON.stringify({ task: 'B2-01a', spec_commit: spec }),
    );
  const pair = { from: '"rounds"', to: '"rounds_half_up"' };
  // Renamed only: left out, as red-check leaves it out of the red run; the rename is to confirm.
  expect(req(onlyRenamed, renamedTrusted)).toEqual({
    ...RED,
    renames: { hit: [pair], left_out: [ROUND], tester: 'codex' },
  });
  // Without the declaration: expected as before, nothing to confirm.
  expect(req(onlyRenamed, TRUSTED)).toEqual({ required: true, expected: [FLOOR, ROUND] });
  // Another change next to the rename: expected as before, the rename that hit still to confirm.
  expect(req(alsoChanged, renamedTrusted)).toEqual({
    required: true,
    expected: [FLOOR, ROUND],
    renames: { hit: [pair], left_out: [], tester: 'codex' },
  });
  // A declared rename that hits no rule-test file of the task: nothing to confirm.
  const missTrusted = join(SCRATCH, 'trusted-renames-miss');
  for (const file of [
    'tools/guard/protected-paths.json',
    'ops/risk-map.yaml',
    'tools/guard/legacy-tasks.json',
  ]) {
    write(missTrusted, { [file]: readFileSync(join(TRUSTED, file), 'utf8') });
  }
  write(missTrusted, {
    'ops/tasks/B2-01a.yaml': `${readFileSync(join(TRUSTED, 'ops/tasks/B2-01a.yaml'), 'utf8').trimEnd()}
renames:
  - from: '"never-there"'
    to: '"never_there"'
`,
  });
  expect(req(onlyRenamed, missTrusted)).toEqual({ required: true, expected: [FLOOR, ROUND] });
});

it('[CT-06zxe] registered expected values that apply to a rule-test file are to confirm; the expected list is unchanged', () => {
  const ANOMALY = 'test/spec/money/anomaly.test.ts';
  const source = (sign: string): string =>
    [
      "import { expect, it } from 'vitest';",
      'const AMOUNT = 500n;',
      'function onlyAnomaly(diff: bigint) {',
      `  expect(diff).toBe(${sign}AMOUNT);`,
      '}',
      "it('[AC-1] calls it', () => { onlyAnomaly(-AMOUNT); });",
      "it('[AC-2] does not', () => { expect(1).toBe(1); });",
      '',
    ].join('\n');
  // The frozen file at its own base commit, then the rule-test commit that changes the value.
  git(repo, ['checkout', '-q', '-b', 'ct06zxe-base', base]);
  write(repo, { [ANOMALY]: source('') });
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'ct06zxe-base']);
  const frozen = git(repo, ['rev-parse', 'HEAD']);
  write(repo, { [ANOMALY]: source('-') });
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'ct06zxe-spec']);
  const spec = git(repo, ['rev-parse', 'HEAD']);
  git(repo, ['checkout', '-q', 'task/B2-01a']);
  const entry = {
    file: ANOMALY,
    helper: 'onlyAnomaly',
    from: '  expect(diff).toBe(AMOUNT);',
    to: '  expect(diff).toBe(-AMOUNT);',
  };
  const trustedWith = (name: string, entries: string): string => {
    const dir = join(SCRATCH, name);
    for (const file of [
      'tools/guard/protected-paths.json',
      'ops/risk-map.yaml',
      'tools/guard/legacy-tasks.json',
    ]) {
      write(dir, { [file]: readFileSync(join(TRUSTED, file), 'utf8') });
    }
    write(dir, {
      'ops/tasks/B2-01a.yaml': `${readFileSync(join(TRUSTED, 'ops/tasks/B2-01a.yaml'), 'utf8').trimEnd()}
expected_values:${entries}
`,
    });
    return dir;
  };
  const yaml = (e: typeof entry): string =>
    `\n  - file: ${e.file}\n    helper: ${e.helper}\n    from: '${e.from}'\n    to: '${e.to}'`;
  const req = (trusted: string) =>
    redRequirement(
      { prDir: repo, base: frozen, head: spec, headRef: 'task/B2-01a', trusted },
      'B2-01a',
      frozen,
      JSON.stringify({ task: 'B2-01a', spec_commit: spec }),
    );
  // The entry applies: still expected (its caller must be red), the entry is to confirm.
  expect(req(trustedWith('trusted-values', yaml(entry)))).toEqual({
    required: true,
    expected: [ANOMALY],
    expectedValues: { hit: [entry], tester: 'codex' },
  });
  // Without the field, or with an entry that does not apply: nothing to confirm.
  expect(req(TRUSTED)).toEqual({ required: true, expected: [ANOMALY] });
  expect(req(trustedWith('trusted-values-miss', yaml({ ...entry, helper: 'nope' })))).toEqual({
    required: true,
    expected: [ANOMALY],
  });
});

it("[CT-06zxe] registered expected values that apply need the rule-test reviewer's confirmation, entry by entry", () => {
  const head = git(repo, ['rev-parse', 'HEAD']);
  const cfg = loadProtected(REPO);
  const entries = [
    {
      file: 'test/spec/payment/result/notify.int.test.ts',
      helper: 'onlyAnomaly',
      from: '    diff_fen: AMOUNT,',
      to: '    diff_fen: -AMOUNT,',
    },
    {
      file: 'test/spec/payment/result/closed-query.int.test.ts',
      helper: 'onlyAnomaly',
      from: '    diff_fen: order.amount_fen,',
      to: '    diff_fen: -order.amount_fen,',
    },
  ];
  const registered = (tester: 'codex' | 'claude' = 'codex'): RedRequirement => ({
    ...RED,
    expectedValues: { hit: entries, tester },
  });
  const problemsOf = (doc: Evidence, red: RedRequirement = registered()): string =>
    evidenceProblems(doc, { prDir: repo, head, task: 'B2-01a', cfg, red }).join('\n');
  const want = `the ledger's expected_values apply 2 entries (CT-06zxe, D10-371): the rule-test reviewer (claude) must confirm them in spec_test_review (reviewer claude, last_verdict pass, expected_values_confirmed { entries: ${JSON.stringify(entries)} })`;
  const confirmed = {
    reviewer: 'claude',
    engine: 'claude',
    rounds: 1,
    last_verdict: 'pass',
    expected_values_confirmed: { entries },
  };
  expect(problemsOf(evidence({ spec_test_review: confirmed }))).toBe('');
  // Missing review or field, the wrong reviewer, a verdict other than pass.
  expect(problemsOf(evidence())).toBe(`spec_test_review: ${want}`);
  expect(
    problemsOf(
      evidence({ spec_test_review: { ...confirmed, expected_values_confirmed: undefined } }),
    ),
  ).toBe(`spec_test_review.expected_values_confirmed: ${want}`);
  expect(
    problemsOf(
      evidence({
        spec_test_review: {
          ...confirmed,
          reviewer: 'codex',
          engine: 'codex',
          model: 'gpt-6-astra',
        },
      }),
    ),
  ).toBe(`spec_test_review.reviewer: ${want}`);
  expect(problemsOf(evidence({ spec_test_review: { ...confirmed, last_verdict: 'fail' } }))).toBe(
    `spec_test_review.last_verdict: ${want}`,
  );
  // Not exactly the entries: true alone, one missing, swapped, changed, an extra key.
  for (const bad of [
    true,
    { entries: entries.slice(0, 1) },
    { entries: [...entries].reverse() },
    { entries: [entries[0], { ...entries[1], to: '    diff_fen: order.amount_fen,' }] },
    { entries, note: 'x' },
    { entries: [{ ...entries[0], tests: [] }, entries[1]] },
  ]) {
    expect(
      problemsOf(evidence({ spec_test_review: { ...confirmed, expected_values_confirmed: bad } })),
      JSON.stringify(bad),
    ).toBe(`spec_test_review.expected_values_confirmed: ${want}`);
  }
  // Claude wrote the rule tests: Codex confirms.
  expect(
    problemsOf(
      evidence({
        spec_test_review: {
          ...confirmed,
          reviewer: 'codex',
          engine: 'codex',
          model: 'gpt-6-astra',
        },
      }),
      registered('claude'),
    ),
  ).toBe('');
  // None applies, or the red run not required: nothing asked for.
  expect(problemsOf(evidence(), RED)).toBe('');
  expect(
    problemsOf(evidence({ runs: [] }), {
      required: false,
      expected: [],
      expectedValues: { hit: entries, tester: 'codex' },
    }),
  ).toBe('');
});

it("[CT-06zxc] renames that hit need the rule-test reviewer's confirmation, pair by pair and file by file", () => {
  const head = git(repo, ['rev-parse', 'HEAD']);
  const cfg = loadProtected(REPO);
  const pairs = [
    { from: "'freeze-expiry'", to: "'freeze_expiry'" },
    { from: "'daily-alerts'", to: "'daily_alerts'" },
  ];
  const LEFT = 'test/spec/money/scheduling.test.ts';
  const renamed = (tester: 'codex' | 'claude' = 'codex'): RedRequirement => ({
    ...RED,
    renames: { hit: pairs, left_out: [LEFT], tester },
  });
  const problemsOf = (doc: Evidence, red: RedRequirement = renamed()): string =>
    evidenceProblems(doc, { prDir: repo, head, task: 'B2-01a', cfg, red }).join('\n');
  const want = `the ledger's renames hit 2 pair(s) and leave 1 file(s) out of the expected list (renames, CT-06zxc): the rule-test reviewer (claude) must confirm them in spec_test_review (reviewer claude, last_verdict pass, renames_confirmed { pairs: ${JSON.stringify(pairs)}, left_out: ${JSON.stringify([LEFT])} })`;
  const confirmed = {
    reviewer: 'claude',
    engine: 'claude',
    rounds: 1,
    last_verdict: 'pass',
    renames_confirmed: { pairs, left_out: [LEFT] },
  };
  expect(problemsOf(evidence({ spec_test_review: confirmed }))).toBe('');
  // Missing review or field, the wrong reviewer, a verdict other than pass.
  expect(problemsOf(evidence())).toBe(`spec_test_review: ${want}`);
  expect(
    problemsOf(evidence({ spec_test_review: { ...confirmed, renames_confirmed: undefined } })),
  ).toBe(`spec_test_review.renames_confirmed: ${want}`);
  expect(
    problemsOf(
      evidence({
        spec_test_review: {
          ...confirmed,
          reviewer: 'codex',
          engine: 'codex',
          model: 'gpt-6-astra',
        },
      }),
    ),
  ).toBe(`spec_test_review.reviewer: ${want}`);
  expect(problemsOf(evidence({ spec_test_review: { ...confirmed, last_verdict: 'fail' } }))).toBe(
    `spec_test_review.last_verdict: ${want}`,
  );
  // Not exactly the pairs and files: true alone, a pair missing, swapped, changed, a file missing.
  for (const bad of [
    true,
    { pairs, left_out: [] },
    { pairs: pairs.slice(0, 1), left_out: [LEFT] },
    { pairs: [...pairs].reverse(), left_out: [LEFT] },
    { pairs: [pairs[0], { ...pairs[1], to: "'daily_alert'" }], left_out: [LEFT] },
    { pairs, left_out: [LEFT, FLOOR] },
    { pairs, left_out: [LEFT], note: 'x' },
    { pairs: [{ ...pairs[0], note: 'x' }, pairs[1]], left_out: [LEFT] },
  ]) {
    expect(
      problemsOf(evidence({ spec_test_review: { ...confirmed, renames_confirmed: bad } })),
      JSON.stringify(bad),
    ).toBe(`spec_test_review.renames_confirmed: ${want}`);
  }
  // Claude wrote the rule tests: Codex confirms.
  expect(
    problemsOf(
      evidence({
        spec_test_review: {
          ...confirmed,
          reviewer: 'codex',
          engine: 'codex',
          model: 'gpt-6-astra',
        },
      }),
      renamed('claude'),
    ),
  ).toBe('');
  // No renames hit, or the red run not required: nothing asked for.
  expect(problemsOf(evidence(), RED)).toBe('');
  expect(
    problemsOf(evidence({ runs: [] }), {
      required: false,
      expected: [],
      renames: { hit: pairs, left_out: [LEFT], tester: 'codex' },
    }),
  ).toBe('');
});
