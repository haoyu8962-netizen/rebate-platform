// Tests for the output schemas and validate-output.ts (规划/11 §2.4 schema 写法, §3.1, §3.3).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { AGENT_DIR, type Fixture, gitIn, makeFixture, REPO } from './testing/fixture.ts';
import {
  appendOutOfScope,
  CHECKLIST_ITEMS,
  citedPaths,
  gitLineChecker,
  type LineChecker,
  normalizeReview,
  outsideRefs,
  ruleTestLocations,
  SCOPE_MARKER,
  scopeReasons,
  parseHunks,
  type ReviewOutput,
  reviewProblems,
  schemaErrors,
  validateOutput,
} from './validate-output.ts';

const IMPL_SCHEMA_FILE = join(AGENT_DIR, 'schemas', 'impl.schema.json');
const REVIEW_SCHEMA_FILE = join(AGENT_DIR, 'schemas', 'review.schema.json');
const implSchema: unknown = JSON.parse(readFileSync(IMPL_SCHEMA_FILE, 'utf8'));
const reviewSchema: unknown = JSON.parse(readFileSync(REVIEW_SCHEMA_FILE, 'utf8'));

const fixtures: Fixture[] = [];
afterEach(() => {
  for (const fx of fixtures.splice(0)) fx.cleanup();
});

function validImpl(): Record<string, unknown> {
  return {
    task_done: true,
    files_changed: ['packages/money/src/split.ts'],
    commands: [{ cmd: 'pnpm verify:fast', exit_code: 0 }],
    tests_passed: true,
    deps_needed: [],
    outside_needed: [{ cmd: 'pnpm db:migrate', reason: 'new migration' }],
    blocked_reason: '',
    notes: '',
  };
}

function validReview(file = 'src/a.ts', line = 1): ReviewOutput {
  return {
    verdict: 'fail',
    summary: 'Checked the split function against BR-CALC-21; one rounding defect.',
    findings: [
      {
        severity: 'S0',
        key: `${file}#split#BR-CALC-21`,
        file,
        line,
        rule: 'BR-CALC-21',
        scenario: 'base 101 fen at 5000 bp yields 51 instead of 50',
        suggestion: 'Use floor division.',
      },
    ],
    out_of_scope: [],
    checklist: CHECKLIST_ITEMS.map((item) => ({
      item,
      status: item === 'rounding' ? 'issue' : 'ok',
      file,
      line,
      note: `verified ${item}`,
    })),
  };
}

type SchemaNode = {
  type?: string;
  properties?: Record<string, SchemaNode>;
  required?: string[];
  additionalProperties?: unknown;
  items?: SchemaNode;
  enum?: unknown[];
};

const ALLOWED_KEYWORDS = [
  'type',
  'enum',
  'properties',
  'items',
  'required',
  'additionalProperties',
];

/** Collects violations of the strict rule: closed objects, every property required. */
function strictRuleViolations(node: SchemaNode, path: string): string[] {
  const problems: string[] = [];
  for (const keyword of Object.keys(node)) {
    if (!ALLOWED_KEYWORDS.includes(keyword)) problems.push(`${path}: keyword ${keyword}`);
  }
  if (node.type === 'object') {
    if (node.additionalProperties !== false) problems.push(`${path}: additionalProperties`);
    const names = Object.keys(node.properties ?? {}).sort();
    if (JSON.stringify(names) !== JSON.stringify([...(node.required ?? [])].sort())) {
      problems.push(`${path}: required`);
    }
    for (const name of names) {
      problems.push(...strictRuleViolations(node.properties?.[name] ?? {}, `${path}.${name}`));
    }
  }
  if (node.items !== undefined) problems.push(...strictRuleViolations(node.items, `${path}[]`));
  return problems;
}

it('both schemas close every object and require every property', () => {
  expect(strictRuleViolations(implSchema as SchemaNode, 'impl')).toEqual([]);
  expect(strictRuleViolations(reviewSchema as SchemaNode, 'review')).toEqual([]);
});

it('schemas carry exactly the agreed fields', () => {
  const impl = implSchema as SchemaNode;
  expect(Object.keys(impl.properties ?? {})).toEqual([
    'task_done',
    'files_changed',
    'commands',
    'tests_passed',
    'deps_needed',
    'outside_needed',
    'blocked_reason',
    'notes',
  ]);
  const review = reviewSchema as SchemaNode;
  expect(Object.keys(review.properties ?? {})).toEqual([
    'verdict',
    'summary',
    'findings',
    'out_of_scope',
    'checklist',
  ]);
  expect(review.required).toEqual(['verdict', 'summary', 'findings', 'out_of_scope', 'checklist']);
  for (const list of ['findings', 'out_of_scope']) {
    const items = review.properties?.[list]?.items;
    expect(items?.additionalProperties).toBe(false);
    expect(items?.required).toEqual([
      'severity',
      'key',
      'file',
      'line',
      'rule',
      'scenario',
      'suggestion',
    ]);
    expect(Object.keys(items?.properties ?? {})).toEqual(items?.required);
  }
  const checklistItem = review.properties?.['checklist']?.items?.properties ?? {};
  expect(Object.keys(checklistItem)).toEqual(['item', 'status', 'file', 'line', 'note']);
  expect(checklistItem['item']?.enum).toEqual([...CHECKLIST_ITEMS]);
  expect(checklistItem['line']?.type).toBe('integer');
});

it('schemaErrors accepts valid outputs and names each violation', () => {
  expect(schemaErrors(implSchema, validImpl())).toEqual([]);
  expect(schemaErrors(reviewSchema, validReview())).toEqual([]);

  const extra = { ...validImpl(), surprise: 1 };
  expect(schemaErrors(implSchema, extra).join('\n')).toContain('additional properties');

  const missing = validImpl();
  delete missing['notes'];
  expect(schemaErrors(implSchema, missing).join('\n')).toContain("required property 'notes'");

  const wrongType = { ...validImpl(), commands: [{ cmd: 'x', exit_code: '0' }] };
  expect(schemaErrors(implSchema, wrongType).join('\n')).toContain('/commands/0/exit_code');

  const badEnum = { ...validReview(), verdict: 'maybe' };
  expect(schemaErrors(reviewSchema, badEnum).join('\n')).toContain('/verdict');
  const fractionalLine = validReview();
  (fractionalLine.findings[0] as { line: number }).line = 1.5;
  expect(schemaErrors(reviewSchema, fractionalLine).join('\n')).toContain('must be integer');
});

it('schemaErrors refuses a schema that strict mode does not accept', () => {
  expect(() => schemaErrors({ type: 'object', unknownKeyword: true }, {})).toThrow(/strict mode/);
});

it('parseHunks returns the new-side ranges, and the old side for pure deletions', () => {
  const diff = [
    'diff --git a/src/a.ts b/src/a.ts',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1,3 +1,4 @@ header',
    ' context',
    '+added',
    '@@ -20 +21 @@',
    '-old',
    '+new',
    '@@ -40,2 +41,0 @@',
    '-gone',
    '-gone too',
  ].join('\n');
  expect(parseHunks(diff)).toEqual([
    { start: 1, end: 4 },
    { start: 21, end: 21 },
    { start: 40, end: 41 },
  ]);
  expect(parseHunks('')).toEqual([]);
});

it('every finding needs a scenario, a file:line and a stable key', () => {
  expect(reviewProblems(validReview(), { money: false }).errors).toEqual([]);

  const review = validReview();
  const finding = review.findings[0];
  if (finding === undefined) throw new Error('fixture has no finding');
  finding.scenario = '  ';
  finding.line = 0;
  finding.key = 'src/other.ts#split';
  const errors = reviewProblems(review, { money: false }).errors.join('\n');
  expect(errors).toContain('findings[0]: scenario is empty');
  expect(errors).toContain('findings[0]: needs file and line >= 1');
  expect(errors).toContain('findings[0]: key must be "<file>#<function>#<rule id>"');

  const otherFile = validReview();
  const second = otherFile.findings[0];
  if (second === undefined) throw new Error('fixture has no finding');
  second.key = 'src/other.ts#split#BR-CALC-21';
  expect(reviewProblems(otherFile, { money: false }).errors.join('\n')).toContain(
    'key must start with the same path as "file"',
  );

  expect(
    reviewProblems({ ...validReview(), summary: '' }, { money: false }).errors.join('\n'),
  ).toContain('summary: empty');
});

it('[D10-234] a rule id that carries its own # (an AC id) is a valid key; missing parts are not', () => {
  const withKey = (key: string): string => {
    const review = validReview();
    const finding = review.findings[0];
    if (finding === undefined) throw new Error('fixture has no finding');
    finding.key = key;
    return reviewProblems(review, { money: false }).errors.join('\n');
  };
  const file = validReview().findings[0]?.file ?? '';
  expect(file).not.toBe('');
  // The case of F1-02zzi: rule id AC-F1-02r#18 plus a suffix, so four `#`-separated parts.
  expect(withKey(`${file}#AC-F1-02r#18#agreement-prefix-oracle`)).toBe('');
  expect(withKey(`${file}#split#AC-B1-01zzj-DEPS#7`)).toBe('');
  const malformed = 'key must be "<file>#<function>#<rule id>"';
  // No file part, no function part, no rule id, a rule id that starts or ends with `#`, spaces.
  for (const key of [
    '#split#BR-CALC-21',
    `${file}##BR-CALC-21`,
    `${file}#split`,
    `${file}#split#`,
    `${file}#split##18`,
    `${file}#split#AC-F1-02r#`,
    `${file}#split#AC-F1-02r #18`,
  ]) {
    expect(withKey(key), key).toContain(malformed);
  }
  // The file part ends at the first `#`: a key naming another file is still refused.
  expect(withKey('src/other.ts#split#AC-F1-02r#18')).toContain(
    'key must start with the same path as "file"',
  );
});

it('a pass verdict next to S0/S1 findings is an error, not a usable output', () => {
  const result = reviewProblems({ ...validReview(), verdict: 'pass' }, { money: false });
  expect(result.warnings).toEqual([]);
  expect(result.errors.join('\n')).toContain('verdict is "pass" but 1 S0/S1');
  const s2Only = {
    ...validReview(),
    verdict: 'pass' as const,
    findings: validReview().findings.map((f) => ({ ...f, severity: 'S2' as const })),
  };
  expect(reviewProblems(s2Only, { money: false }).errors).toEqual([]);
});

it('[规划/11 §2.5] out_of_scope entries are checked like findings and never decide the verdict', () => {
  const finding = validReview().findings[0];
  if (finding === undefined) throw new Error('fixture has no finding');
  const elsewhere = {
    ...finding,
    key: 'src/a.ts#split#BR-FUND-03',
    rule: 'BR-FUND-03',
  };
  // An S0 outside the scope next to a pass verdict is fine: it does not count.
  const pass = {
    ...validReview(),
    verdict: 'pass' as const,
    findings: [],
    out_of_scope: [elsewhere],
  };
  expect(reviewProblems(pass, { money: false })).toEqual({ errors: [], warnings: [] });
  const sloppy = {
    ...pass,
    out_of_scope: [{ ...elsewhere, scenario: ' ', key: 'other.ts#x#BR-FUND-03' }, finding],
    findings: [{ ...finding, severity: 'S2' as const }],
  };
  const errors = reviewProblems(sloppy, { money: false }).errors.join('\n');
  expect(errors).toContain('out_of_scope[0]: scenario is empty');
  expect(errors).toContain('out_of_scope[0]: key must start with the same path as "file"');
  expect(errors).toContain(`out_of_scope[1]: key ${finding.key} is also listed in findings`);
});

it('[规划/11 §2.5] with --refs, findings about rules outside the refs do not count toward the verdict', () => {
  expect(outsideRefs('BR-FUND-03', ['BR-CALC-01'])).toEqual(['BR-FUND-03']);
  expect(outsideRefs('BR-CALC-01 via BR-FUND-03', ['BR-CALC-01'])).toEqual([]);
  expect(outsideRefs('mutation-floor-to-round', ['BR-CALC-01'])).toEqual([]);
  const finding = validReview().findings[0];
  if (finding === undefined) throw new Error('fixture has no finding');
  const misplaced = { ...finding, key: 'src/a.ts#split#BR-FUND-03', rule: 'BR-FUND-03' };
  const refs = ['BR-CALC-01', 'BR-CALC-08'];
  // A pass that only carries a misplaced S0 is not contradictory, but the misplacement is named.
  const pass = { ...validReview(), verdict: 'pass' as const, findings: [misplaced], checklist: [] };
  const passed = reviewProblems(pass, { money: false, refs });
  expect(passed.errors).toEqual([]);
  expect(passed.warnings.join('\n')).toContain(
    'findings[0]: rule cites BR-FUND-03, outside the task refs (BR-CALC-01, BR-CALC-08)',
  );
  // A fail that rests only on misplaced findings is flagged as a pass within the refs.
  const failed = reviewProblems({ ...pass, verdict: 'fail' }, { money: false, refs });
  expect(failed.warnings.join('\n')).toContain(
    'within the task scope (refs, allowed paths) this review is a pass',
  );
  // Without --refs nothing changes: the pass is contradictory.
  expect(reviewProblems(pass, { money: false }).errors.join('\n')).toContain(
    'verdict is "pass" but 1 S0/S1',
  );
  // An in-scope S0 next to a pass stays an error with --refs.
  const inScope = { ...finding, key: 'src/a.ts#split#BR-CALC-01', rule: 'BR-CALC-01' };
  expect(
    reviewProblems({ ...pass, findings: [inScope] }, { money: false, refs }).errors.join('\n'),
  ).toContain('verdict is "pass" but 1 S0/S1');
});

it('money review: seven items exactly once, each with file:line and a note', () => {
  expect(reviewProblems(validReview(), { money: true }).errors).toEqual([]);
  // The checklist is only mandatory for money reviews.
  expect(reviewProblems({ ...validReview(), checklist: [] }, { money: false }).errors).toEqual([]);

  const empty = reviewProblems({ ...validReview(), checklist: [] }, { money: true }).errors;
  expect(empty).toHaveLength(7);
  expect(empty[0]).toContain('"rounding" must appear exactly once (found 0)');

  const duplicated = validReview();
  const first = duplicated.checklist[0];
  if (first === undefined) throw new Error('fixture has no checklist');
  duplicated.checklist.push({ ...first });
  expect(reviewProblems(duplicated, { money: true }).errors.join('\n')).toContain(
    '"rounding" must appear exactly once (found 2)',
  );

  const sloppy = validReview();
  const clock = sloppy.checklist.find((c) => c.item === 'clock');
  const appId = sloppy.checklist.find((c) => c.item === 'app_id');
  if (clock === undefined || appId === undefined) throw new Error('fixture has no checklist');
  clock.file = '';
  appId.note = ' ';
  const errors = reviewProblems(sloppy, { money: true }).errors.join('\n');
  expect(errors).toContain('(clock): needs file and line >= 1');
  expect(errors).toContain('(app_id): note is empty');

  const issueWithoutFinding = { ...validReview(), findings: [] };
  expect(reviewProblems(issueWithoutFinding, { money: true }).errors.join('\n')).toContain(
    'status "issue" but there is no finding',
  );
});

it('money review: every cited line is checked against the diff', () => {
  const onlyLineOne: LineChecker = (file, line) =>
    file === 'src/a.ts' && line === 1
      ? { ok: true, reason: '' }
      : { ok: false, reason: 'line is outside the diff hunks of this file' };
  expect(reviewProblems(validReview(), { money: true, lineChecker: onlyLineOne }).errors).toEqual(
    [],
  );
  const errors = reviewProblems(validReview('src/a.ts', 99), {
    money: true,
    lineChecker: onlyLineOne,
  }).errors;
  expect(errors).toHaveLength(7);
  expect(errors[0]).toContain('src/a.ts:99 line is outside the diff hunks of this file');
});

it('gitLineChecker follows the real diff of the worktree against the base', () => {
  const fx = makeFixture('linecheck');
  fixtures.push(fx);
  const lines = Array.from({ length: 40 }, (_, i) => `export const v${i} = ${i};`);
  writeFileSync(join(fx.worktree, 'src', 'big.ts'), `${lines.join('\n')}\n`);
  writeFileSync(join(fx.worktree, 'src', 'gone.ts'), 'export const gone = 1;\n');
  gitIn(fx.worktree, ['add', '.']);
  gitIn(fx.worktree, ['commit', '-q', '-m', 'more files']);
  const base = gitIn(fx.worktree, ['rev-parse', 'HEAD']);

  lines[29] = 'export const v29 = 2900;';
  writeFileSync(join(fx.worktree, 'src', 'big.ts'), `${lines.join('\n')}\n`);
  rmSync(join(fx.worktree, 'src', 'gone.ts'));
  mkdirSync(join(fx.worktree, 'src', '新目录'));
  writeFileSync(join(fx.worktree, 'src', '新目录', 'new.ts'), 'one\ntwo\nthree\n');

  const check = gitLineChecker(base, fx.worktree);
  expect(check('src/big.ts', 30)).toEqual({ ok: true, reason: '' });
  expect(check('src/big.ts', 27).ok).toBe(true); // context line of the hunk
  expect(check('src/big.ts', 5)).toEqual({
    ok: false,
    reason: 'line is outside the diff hunks of this file',
  });
  expect(check('src/a.ts', 1)).toEqual({ ok: false, reason: 'file is not changed in the diff' });
  expect(check('src/新目录/new.ts', 3).ok).toBe(true); // untracked file: all lines are new
  expect(check('src/新目录/new.ts', 9).ok).toBe(false);
  expect(check('src/gone.ts', 1).ok).toBe(true); // deleted file: old side
  expect(check('src/missing.ts', 1).reason).toContain('exists neither');
  expect(check('../outside.ts', 1).reason).toContain('not a repository-relative path');
  expect(check('/etc/passwd', 1).reason).toContain('not a repository-relative path');
  expect(() => gitLineChecker('no-such-ref', fx.worktree)).toThrow(/not a commit/);
});

it('validateOutput applies review rules only to review schemas', () => {
  expect(validateOutput(implSchema, validImpl(), { money: false })).toEqual({
    ok: true,
    errors: [],
    warnings: [],
  });
  expect(validateOutput(reviewSchema, validReview(), { money: true }).ok).toBe(true);
  expect(
    validateOutput(reviewSchema, { ...validReview(), checklist: [] }, { money: true }).ok,
  ).toBe(false);
  expect(() => validateOutput(implSchema, validImpl(), { money: true })).toThrow(/review outputs/);
});

function runCli(args: readonly string[]): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const res = spawnSync(process.execPath, [join(AGENT_DIR, 'validate-output.ts'), ...args], {
    encoding: 'utf8',
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

it('CLI: exit 0 valid, 1 invalid, 2 usage or internal error', { timeout: 60_000 }, () => {
  const fx = makeFixture('validate-cli');
  fixtures.push(fx);
  const good = join(fx.root, 'good.json');
  const bad = join(fx.root, 'bad.json');
  const broken = join(fx.root, 'broken.json');
  const review = join(fx.root, 'review.json');
  writeFileSync(good, JSON.stringify(validImpl()));
  writeFileSync(bad, JSON.stringify({ ...validImpl(), extra: true }));
  writeFileSync(broken, '{"task_done": tru');
  writeFileSync(review, JSON.stringify(validReview('src/a.ts', 1)));

  expect(runCli(['--schema', IMPL_SCHEMA_FILE, '--file', good]).status).toBe(0);

  const invalid = runCli(['--schema', IMPL_SCHEMA_FILE, '--file', bad, '--json']);
  expect(invalid.status).toBe(1);
  expect(JSON.parse(invalid.stdout)).toMatchObject({ ok: false });
  expect(invalid.stderr).toContain('invalid: schema:');

  const unparsable = runCli(['--schema', IMPL_SCHEMA_FILE, '--file', broken]);
  expect(unparsable.status).toBe(1);
  expect(unparsable.stderr).toContain('output is not valid JSON');

  expect(runCli(['--schema', IMPL_SCHEMA_FILE]).status).toBe(2);
  expect(runCli(['--schema', IMPL_SCHEMA_FILE, '--file', join(fx.root, 'none.json')]).status).toBe(
    2,
  );
  expect(runCli(['--schema', join(fx.root, 'none.json'), '--file', good]).status).toBe(2);
  expect(runCli(['--schema', IMPL_SCHEMA_FILE, '--file', good, '--money']).status).toBe(2);
  expect(runCli(['--schema', IMPL_SCHEMA_FILE, '--file', good, '--diff-base', 'HEAD']).status).toBe(
    2,
  );
  expect(runCli(['--schema', IMPL_SCHEMA_FILE, '--file', good, '--bogus']).status).toBe(2);
  expect(runCli(['--schema', IMPL_SCHEMA_FILE, '--file', good, '--refs', 'BR 1']).status).toBe(2);
  // --refs: a pass whose only S0 cites a rule outside the refs is valid, with a warning.
  const scoped = join(fx.root, 'scoped.json');
  const base = validReview('src/a.ts', 1);
  writeFileSync(
    scoped,
    JSON.stringify({
      ...base,
      verdict: 'pass',
      checklist: [],
      findings: base.findings.map((f) => ({
        ...f,
        key: 'src/a.ts#split#BR-FUND-03',
        rule: 'BR-FUND-03',
      })),
    }),
  );
  const scopedArgs = ['--schema', REVIEW_SCHEMA_FILE, '--file', scoped];
  expect(runCli(scopedArgs).status).toBe(1);
  const withRefs = runCli([...scopedArgs, '--refs', 'BR-CALC-01,BR-CALC-08']);
  expect(withRefs.status).toBe(0);
  expect(withRefs.stderr).toContain('warning: findings[0]: rule cites BR-FUND-03');

  // Money review against the real diff: src/a.ts is unchanged in the fixture worktree.
  const moneyArgs = ['--schema', REVIEW_SCHEMA_FILE, '--file', review, '--money'];
  expect(runCli(moneyArgs).status).toBe(0);
  const outside = runCli([...moneyArgs, '--diff-base', fx.baseSha, '--cwd', fx.worktree]);
  expect(outside.status).toBe(1);
  expect(outside.stderr).toContain('src/a.ts:1 file is not changed in the diff');
  writeFileSync(join(fx.worktree, 'src', 'a.ts'), 'export const a = 3;\n');
  expect(runCli([...moneyArgs, '--diff-base', fx.baseSha, '--cwd', fx.worktree]).status).toBe(0);
});

// Spec-test review scope by paths (owner decision 2026-10-02, ops/approvals.yaml id 14).
function specFinding(
  over: Partial<ReviewOutput['findings'][number]>,
): ReviewOutput['findings'][number] {
  const file = over.file ?? 'test/spec/money/a.test.ts';
  return {
    severity: 'S1',
    key: `${file}#-#BR-CALC-01-clause-1`,
    file,
    line: 3,
    rule: 'BR-CALC-01',
    scenario: 'mulDivFloor(101n, 5000n, 10000n) is not asserted, so a round() passes',
    suggestion: 'add the exact-fen example',
    ...over,
  };
}

const SCOPE_PATHS = ['packages/money/src/**', ...ruleTestLocations(REPO)];

it('[规划/11 §3.3] spec-test scope: rule-test locations come from class 1 of the protected paths', () => {
  expect(ruleTestLocations(REPO)).toEqual(
    expect.arrayContaining(['test/spec/**', 'test/properties/**', 'packages/testing/**']),
  );
  expect(citedPaths('see db/migrations/0001_init.sql:12 and `packages/db/src/`.')).toEqual([
    'db/migrations/0001_init.sql',
    'packages/db/src',
  ]);
  expect(citedPaths('no repository path, only BR-CALC-01 and a.b/c')).toEqual([]);
});

it('[规划/11 §3.3] findings about behaviour outside the allowed paths are out of scope', () => {
  const scope = { refs: ['BR-CALC-01'], paths: SCOPE_PATHS };
  // In scope: a rule-test file, an implementation file of the task, citations inside the paths.
  expect(scopeReasons(specFinding({}), scope)).toEqual([]);
  expect(
    scopeReasons(
      specFinding({
        file: 'packages/money/src/index.ts',
        key: 'packages/money/src/index.ts#mulDivFloor#BR-CALC-01',
        scenario: 'packages/money/src/index.ts and db/migrations/0001.sql disagree',
      }),
      scope,
    ),
  ).toEqual([]);
  // The file lies outside the task paths and the rule-test locations (db/migrations/** is class 1
  // since CT-06d, so another path stands in).
  expect(
    scopeReasons(
      specFinding({
        file: 'apps/api/src/main.ts',
        key: 'apps/api/src/main.ts#-#BR-CALC-01',
      }),
      scope,
    )[0],
  ).toContain('file apps/api/src/main.ts is outside the task');
  // A rule-test location, but every cited path is another module.
  expect(
    scopeReasons(
      specFinding({ scenario: 'amount columns in packages/db/src/schema.ts may be numeric' }),
      scope,
    )[0],
  ).toContain('cites only paths outside the task');
  // The reviewer's own marker.
  expect(scopeReasons(specFinding({ rule: `${SCOPE_MARKER} BR-CALC-01 CI lint` }), scope)).toEqual([
    `the reviewer marked it ${SCOPE_MARKER}`,
  ]);
});

it('[规划/11 §3.3] out-of-scope findings are moved and the verdict is recomputed from in-scope S0/S1', () => {
  const scope = { refs: ['BR-CALC-01'], paths: SCOPE_PATHS };
  const outside = specFinding({
    file: 'apps/api/src/modules/settlement/run.ts',
    key: 'apps/api/src/modules/settlement/run.ts#-#BR-CALC-01',
  });
  const s2 = specFinding({ severity: 'S2', key: 'test/spec/money/a.test.ts#-#weak-name' });
  const review: ReviewOutput = {
    verdict: 'fail',
    summary: 'BR-CALC-01#1 → t1.',
    findings: [outside, s2],
    out_of_scope: [],
    checklist: [],
  };
  // Valid with a warning: the fail rests only on an out-of-scope S1.
  const problems = reviewProblems(review, { money: false, ...scope });
  expect(problems.errors).toEqual([]);
  expect(problems.warnings.join('\n')).toContain(
    'findings[0]: file apps/api/src/modules/settlement/run.ts is outside the task',
  );
  const normalized = normalizeReview(review, scope);
  expect(normalized.review.verdict).toBe('pass');
  expect(normalized.review.findings).toEqual([s2]);
  expect(normalized.review.out_of_scope).toEqual([outside]);
  expect(normalized.moved.map((m) => m.finding.key)).toEqual([outside.key]);
  // An in-scope S1 keeps the fail, and a pass next to it is still contradictory.
  const inScope = specFinding({});
  expect(normalizeReview({ ...review, findings: [outside, inScope] }, scope).review.verdict).toBe(
    'fail',
  );
  expect(
    reviewProblems(
      { ...review, verdict: 'pass', findings: [outside, inScope] },
      {
        money: false,
        ...scope,
      },
    ).errors.join('\n'),
  ).toContain('verdict is "pass" but 1 S0/S1');
});

it('[规划/11 §3.3] out-of-scope entries are appended once per key to the run-state file', () => {
  const fx = makeFixture('oos-log');
  fixtures.push(fx);
  const file = join(fx.run, 'out-of-scope.md');
  const a = specFinding({ file: 'db/x.sql', key: 'db/x.sql#-#BR-CALC-01' });
  const b = specFinding({
    file: 'db/y.sql',
    key: 'db/y.sql#-#BR-CALC-01',
    scenario: 'multi\nline',
  });
  const at = { source: 'review review-codex.json', at: '2026-10-02T00:00:00Z' };
  expect(appendOutOfScope(file, [a], new Map([[a.key, ['moved']]]), at)).toBe(1);
  expect(appendOutOfScope(file, [a, b, b], new Map(), at)).toBe(1);
  expect(appendOutOfScope(file, [a, b], new Map(), at)).toBe(0);
  const text = readFileSync(file, 'utf8');
  expect(text.startsWith(`# ${'T1-01'}: out-of-scope review findings`)).toBe(true);
  expect(text.split('- `db/x.sql#-#BR-CALC-01`').length).toBe(2);
  expect(text).toContain('  - source: moved from findings: moved');
  expect(text).toContain('  - source: listed in out_of_scope by the reviewer');
  expect(text).toContain('  - scenario: multi line');
});

it('CLI: --allowed-paths, --rewrite and --out-of-scope-log', { timeout: 60_000 }, () => {
  const fx = makeFixture('validate-scope');
  fixtures.push(fx);
  const file = join(fx.root, 'review.json');
  const log = join(fx.run, 'out-of-scope.md');
  const outside = specFinding({
    file: 'packages/db/src/schema.ts',
    key: 'packages/db/src/schema.ts#-#BR-CALC-01',
  });
  const raw = {
    verdict: 'fail',
    summary: 'BR-CALC-01#1 → t1.',
    findings: [outside],
    out_of_scope: [
      specFinding({ file: 'db/z.sql', key: 'db/z.sql#-#BR-CALC-26', rule: 'BR-CALC-26' }),
    ],
    checklist: [],
  };
  writeFileSync(file, JSON.stringify(raw));
  const args = [
    '--schema',
    REVIEW_SCHEMA_FILE,
    '--file',
    file,
    '--allowed-paths',
    'packages/money/src/**',
  ];
  // Without --rewrite the file is untouched; the warning names the misplaced finding.
  const checked = runCli(args);
  expect(checked.status, checked.stderr).toBe(0);
  expect(checked.stderr).toContain('warning: findings[0]: file packages/db/src/schema.ts');
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(raw);

  const rewritten = runCli([...args, '--rewrite', '--out-of-scope-log', log]);
  expect(rewritten.status, rewritten.stderr).toBe(0);
  expect(rewritten.stderr).toContain('recomputed "pass"');
  const after = JSON.parse(readFileSync(file, 'utf8')) as ReviewOutput;
  expect(after.verdict).toBe('pass');
  expect(after.findings).toEqual([]);
  expect(after.out_of_scope.map((f) => f.key)).toEqual(['db/z.sql#-#BR-CALC-26', outside.key]);
  const text = readFileSync(log, 'utf8');
  expect(text).toContain(`- \`${outside.key}\` S1`);
  expect(text).toContain('- `db/z.sql#-#BR-CALC-26` S1');
  // Idempotent: a second run appends nothing and leaves the review as it is.
  expect(runCli([...args, '--rewrite', '--out-of-scope-log', log]).status).toBe(0);
  expect(readFileSync(log, 'utf8')).toBe(text);

  // An invalid review is neither rewritten nor logged.
  const contradictory = { ...raw, verdict: 'pass', findings: [specFinding({})] };
  writeFileSync(file, JSON.stringify(contradictory));
  const rejected = runCli([...args, '--rewrite', '--out-of-scope-log', join(fx.run, 'other.md')]);
  expect(rejected.status).toBe(1);
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(contradictory);
  expect(existsSync(join(fx.run, 'other.md'))).toBe(false);

  // Usage errors.
  expect(runCli([...args.slice(0, 4), '--allowed-paths', '../x/**']).status).toBe(2);
  expect(runCli([...args.slice(0, 4), '--allowed-paths', ',']).status).toBe(2);
  const impl = join(fx.root, 'impl.json');
  writeFileSync(impl, JSON.stringify(validImpl()));
  expect(runCli(['--schema', IMPL_SCHEMA_FILE, '--file', impl, '--rewrite']).status).toBe(2);
});

// CT-06zzzzzq (D10-2086 ②): an `na` checklist item carries no position; an `na` position
// outside the diff is a warning, every other position check stays an error.
function naChecklistReview(
  status: 'ok' | 'issue' | 'na',
  at: { file: string; line: number },
): ReviewOutput {
  const review = validReview('src/a.ts', 1);
  const clock = review.checklist.find((c) => c.item === 'clock');
  if (clock === undefined) throw new Error('fixture has no checklist');
  Object.assign(clock, { status, ...at });
  return review;
}

function recordingChecker(): { check: LineChecker; calls: string[] } {
  const calls: string[] = [];
  const check: LineChecker = (file, line) => {
    calls.push(`${file}:${line}`);
    return file === 'src/a.ts' && line === 1
      ? { ok: true, reason: '' }
      : { ok: false, reason: 'line is outside the diff hunks of this file' };
  };
  return { check, calls };
}

it('[CT-06zzzzzq] money review: an na item without a position gives no error and no warning, and is not checked', () => {
  const { check, calls } = recordingChecker();
  const review = naChecklistReview('na', { file: '', line: 0 });
  expect(reviewProblems(review, { money: true, lineChecker: check })).toEqual({
    errors: [],
    warnings: [],
  });
  expect(calls).not.toContain(':0');
  expect(calls).toHaveLength(CHECKLIST_ITEMS.length - 1);
  expect(reviewProblems(review, { money: true })).toEqual({ errors: [], warnings: [] });
});

it('[CT-06zzzzzq] money review: an na item outside the diff gives no error and exactly one warning', () => {
  const { check } = recordingChecker();
  const result = reviewProblems(naChecklistReview('na', { file: 'src/b.ts', line: 42 }), {
    money: true,
    lineChecker: check,
  });
  expect(result.errors).toEqual([]);
  expect(result.warnings).toHaveLength(1);
  expect(result.warnings[0]).toContain('(clock)');
  expect(result.warnings[0]).toContain('src/b.ts:42');
  expect(result.warnings[0]).toContain('line is outside the diff hunks of this file');
  // Inside the diff: nothing to report.
  expect(
    reviewProblems(naChecklistReview('na', { file: 'src/a.ts', line: 1 }), {
      money: true,
      lineChecker: check,
    }),
  ).toEqual({ errors: [], warnings: [] });
});

it('[CT-06zzzzzq] money review: an na item with half a position is still an error', () => {
  const { check, calls } = recordingChecker();
  for (const at of [
    { file: 'src/a.ts', line: 0 },
    { file: '', line: 1 },
    { file: ' ', line: 0 },
    { file: '', line: -1 },
  ]) {
    const result = reviewProblems(naChecklistReview('na', at), { money: true, lineChecker: check });
    expect(result.errors, `${at.file}:${at.line}`).toEqual([
      'checklist[5] (clock): needs file and line >= 1 (规划/11 §3.3)',
    ]);
    expect(result.warnings, `${at.file}:${at.line}`).toEqual([]);
  }
  expect(calls.filter((c) => c !== 'src/a.ts:1')).toEqual([]);
});

it('[CT-06zzzzzq] money review: ok and issue items outside the diff or without a position are errors as before', () => {
  for (const status of ['ok', 'issue'] as const) {
    const { check } = recordingChecker();
    const outside = reviewProblems(naChecklistReview(status, { file: 'src/b.ts', line: 42 }), {
      money: true,
      lineChecker: check,
    });
    expect(outside.errors, status).toEqual([
      'checklist[5] (clock): src/b.ts:42 line is outside the diff hunks of this file',
    ]);
    expect(outside.warnings, status).toEqual([]);

    const none = reviewProblems(naChecklistReview(status, { file: '', line: 0 }), {
      money: true,
      lineChecker: check,
    });
    expect(none.errors, status).toEqual([
      'checklist[5] (clock): needs file and line >= 1 (规划/11 §3.3)',
    ]);
    expect(none.warnings, status).toEqual([]);
  }
});
