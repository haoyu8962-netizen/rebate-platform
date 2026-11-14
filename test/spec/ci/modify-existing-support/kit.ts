// CT-06zzzzzi (D10-1662) rule-test kit: modify_existing file-level support entries (scope: support,
// no test field) for frozen shared fixtures and top-level helpers. The ledger shape, the evidence
// record and the assertion-line rule are the task brief's (couli-runs/CT-06zzzzzi/brief.md, 新条目
// 1–3). Fixture git repositories live under <repo>/.tmp/ (git-ignored), never under /tmp; no
// database, no port, no network.
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { type EvidenceReport, checkEvidence } from '../../../../tools/ci/evidence-check.ts';
import { type TaskFile, parseTaskFile } from '../../../../tools/lib/task-file.ts';

export const REPO = resolve(import.meta.dirname, '../../../..');
/** Per-test time limit of the cases that build git fixtures (many git calls each). */
export const SLOW = 120_000;

export const TASK = 'T9-01s';
export const BR = 'BR-ID-08';
export const RULING = 'D10-1660';
export const NOTE = 'shared fixture adds the step-up summary; no assertion changes';
export const SPEC_REF = 'c'.repeat(40);

/** Not a money or attribution test (isMoneyOrAttributionTest is false). */
export const SUPPORT = 'test/spec/identity/step-up/http-kit.ts';
/** Not a money or attribution test either: the ruling_correction cases. */
export const SUPPORT_RC = 'test/spec/identity/reverify-gates/kit.ts';
/** Money or attribution tests (a payout directory; test/properties/**; test/replay/**). */
export const MONEY_KIT = 'test/spec/payout/apply/kit.ts';
export const PROP = 'test/properties/domain/payout/withdrawal-sequences.ts';
export const REPLAY = 'test/replay/qa-03c/fixtures.ts';
/** A frozen rule-test file with a top-level helper and two it blocks (money: payout). */
export const HELPER_TEST = 'test/spec/payout/risk-flags/apply.int.test.ts';
export const T1 = '[AC-B9-01#1] applies';
export const T2 = '[AC-B9-01#2] refuses';

// ---------------------------------------------------------------------------------------------
// Scratch directories and git.

const dirs: string[] = [];

/** A fresh directory under <repo>/.tmp/; removed by cleanup(). */
export function scratch(name: string): string {
  const dir = join(
    REPO,
    '.tmp',
    `modify-existing-support-${name}-${process.pid}-${randomBytes(4).toString('hex')}`,
  );
  mkdirSync(dir, { recursive: true });
  dirs.push(dir);
  return dir;
}

export function cleanup(): void {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export function git(cwd: string, args: string[]): string {
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

export function write(root: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
}

/** sha256 of a file's content, lower-case hex (the record's before_sha256 / after_sha256). */
export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** 1-based number of the first line of `text` that contains `needle`. */
export function lineOf(text: string, needle: string): number {
  const index = text.split('\n').findIndex((line) => line.includes(needle));
  if (index < 0) throw new Error(`fixture: "${needle}" not found`);
  return index + 1;
}

// ---------------------------------------------------------------------------------------------
// Fixture sources. Eighteen comment lines first, so that every changed line is at line 19 or
// later (a two-digit number that the evidence path, ruling ids and BR ids do not contain alone).

const PAD = ['// fixture (CT-06zzzzzi)', ...Array.from({ length: 17 }, () => '// padding')];

/** The shared step-up fixture (SUPPORT) at the base. */
export const SUPPORT_BASE = [
  ...PAD,
  "import { expect } from 'vitest';",
  '',
  'export function stepUpToken(userId: string) {',
  "  return { userId, purpose: 'payout' };",
  '}',
  '',
  'export async function expectStepUpRefused(call: () => Promise<unknown>) {',
  "  await expect(call()).rejects.toThrow('STEP_UP_REQUIRED');",
  '}',
  '',
  'export function expectSummary(token: { summary?: string }) {',
  '  expect(token.summary)',
  "    .toBe('withdraw:100');",
  '}',
  '',
].join('\n');

/** The same fixture at the head: the token now carries the summary (no assertion line touched). */
export const SUPPORT_HEAD = SUPPORT_BASE.replace(
  "export function stepUpToken(userId: string) {\n  return { userId, purpose: 'payout' };",
  "export function stepUpToken(userId: string, summary = 'withdraw:100') {\n  return { userId, purpose: 'payout', summary };",
);

/** SUPPORT_BASE with `line` inserted right after the `return` line of stepUpToken. */
export function supportWith(line: string, text: string = SUPPORT_BASE): string {
  const anchor = "  return { userId, purpose: 'payout' };";
  if (!text.includes(anchor)) throw new Error('fixture: anchor missing');
  return text.replace(anchor, `${anchor}\n${line}`);
}

/** A plain kit with one factory; `summary` adds the summary parameter and field. */
export function kitSource(fn: string, summary: boolean): string {
  return [
    ...PAD,
    `export function ${fn}(id: string${summary ? ", summary = 'withdraw:100'" : ''}) {`,
    `  return { id${summary ? ', summary' : ''} };`,
    '}',
    '',
  ].join('\n');
}

export const itBlock = (title: string, body: string): string =>
  `it('${title}', async () => {\n  ${body}\n});`;
export const T1_BASE = itBlock(T1, 'expect(applyInput(100).amount).toBe(100);');
export const T1_HEAD = itBlock(T1, 'expect(applyInput(100).amount).toBe(101);');
export const T2_BASE = itBlock(T2, 'expect(applyInput(0).amount).toBe(0);');
export const T2_HEAD = itBlock(
  T2,
  "expect(applyInput(0, 'withdraw:0').summary).toBe('withdraw:0');",
);

const HELPER_PLAIN = 'function applyInput(amount: number) {\n  return { amount };\n}';
const HELPER_SUMMARY =
  "function applyInput(amount: number, summary = 'withdraw:100') {\n  return { amount, summary };\n}";

/** HELPER_TEST: `helper` the top-level helper's text, then the two blocks. */
export function helperTest(
  opts: { helper?: string; t1?: string; t2?: string; summary?: boolean } = {},
): string {
  const helper = opts.helper ?? (opts.summary === true ? HELPER_SUMMARY : HELPER_PLAIN);
  return [
    ...PAD,
    "import { expect, it } from 'vitest';",
    '',
    helper,
    '',
    opts.t1 ?? T1_BASE,
    '',
    opts.t2 ?? T2_BASE,
    '',
  ].join('\n');
}

/** The helper with an assertion line added inside it (before its return). */
export const HELPER_ASSERTING =
  'function applyInput(amount: number) {\n  expect(amount).toBeGreaterThan(-1);\n  return { amount };\n}';

/** Every file of the fixture repository at the base. */
export const BASE_FILES: Record<string, string> = {
  [SUPPORT]: SUPPORT_BASE,
  [SUPPORT_RC]: kitSource('reverifyGate', false),
  [MONEY_KIT]: kitSource('applyKit', false),
  [PROP]: kitSource('withdrawalSequence', false),
  [REPLAY]: kitSource('replayFixture', false),
  [HELPER_TEST]: helperTest(),
  'test/spec/identity/step-up/sms.int.test.ts':
    "import { expect, it } from 'vitest';\nit('[AC-B1-02#1] sms', () => {\n  expect(1).toBe(1);\n});\n",
};

// ---------------------------------------------------------------------------------------------
// Ledgers.

export type Fields = Record<string, string | readonly string[] | undefined>;

function yamlValue(value: string | readonly string[]): string {
  if (typeof value !== 'string') return `[${value.join(', ')}]`;
  if (value.includes("'")) throw new Error(`fixture: no quote in ledger values (${value})`);
  return `'${value}'`;
}

/** One modify_existing list item (keys in the given order; undefined values left out). */
export function entryYaml(fields: Fields): string {
  const pairs = Object.entries(fields).filter(
    (p): p is [string, string | readonly string[]] => p[1] !== undefined,
  );
  return pairs
    .map(([key, value], i) => `${i === 0 ? '  - ' : '    '}${key}: ${yamlValue(value)}`)
    .join('\n');
}

/** A file-level support entry (rule_change, br [BR-ID-08] unless `extra` says otherwise). */
export const support = (file: string, extra: Fields = {}): Fields => ({
  file,
  scope: 'support',
  reason: 'rule_change',
  br: [BR],
  ruling: RULING,
  note: NOTE,
  ...extra,
});

/** A block-level entry as before (file + test). */
export const block = (file: string, test: string, extra: Fields = {}): Fields => ({
  file,
  test,
  reason: 'rule_change',
  br: [BR],
  ruling: RULING,
  note: NOTE,
  ...extra,
});

export type LedgerOptions = {
  id?: string;
  refs?: readonly string[];
  /** refs_hash values (default: a fixed 12-hex value per ref). */
  refsHash?: Record<string, string>;
  tester?: string;
  paths?: readonly string[];
  testPaths?: readonly string[];
  /** Number of red_exempt entries (each a distinct test of the sms file). */
  redExempt?: number;
};

/** A test-change ledger (impl claude, tester none unless said) with these modify_existing items. */
export function ledger(entries: readonly Fields[] | null, opts: LedgerOptions = {}): string {
  const refs = opts.refs ?? [BR];
  const hash =
    opts.refsHash ??
    Object.fromEntries(refs.map((r, i) => [r, '0123456789abcdef'.slice(i, i + 12)]));
  const exempt = opts.redExempt ?? 0;
  return [
    `id: ${opts.id ?? TASK}`,
    'repo: rebate-platform',
    'title: support entries fixture',
    'type: test-change',
    `refs: [${refs.join(', ')}]`,
    refs.length === 0
      ? 'refs_hash: {}'
      : `refs_hash:\n${refs.map((r) => `  ${r}: ${hash[r] ?? ''}`).join('\n')}`,
    'deps: []',
    'paths:',
    ...(opts.paths ?? ['test/**']).map((p) => `  - '${p}'`),
    ...(opts.testPaths === undefined
      ? []
      : ['test_paths:', ...opts.testPaths.map((p) => `  - '${p}'`)]),
    'impl: claude',
    `tester: ${opts.tester ?? 'none'}`,
    'accept:',
    "  - 'pnpm verify'",
    'status: todo',
    ...(exempt === 0
      ? []
      : [
          'red_exempt:',
          ...Array.from(
            { length: exempt },
            (_, i) =>
              `  - file: 'test/spec/identity/step-up/sms.int.test.ts'\n    test: '[AC-E9-01#${i}] e'\n    reason: 'unchanged structural test'`,
          ),
        ]),
    ...(entries === null ? [] : ['modify_existing:', ...entries.map(entryYaml)]),
    '',
  ].join('\n');
}

export function parse(text: string, id: string = TASK): TaskFile {
  return parseTaskFile(text, `ops/tasks/${id}.yaml`);
}

/** The error parseTaskFile throws for `text`, or '' when it parses. */
export function refusal(text: string, id: string = TASK): string {
  try {
    parse(text, id);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  return '';
}

/** A parsed entry as a plain record (the type of a support entry is the implementation's). */
export function asRecord(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

// ---------------------------------------------------------------------------------------------
// evidence-check fixtures (after tools/ci/evidence-check.test.ts modRepo / modBranch / modCheck).

export type Repo = { dir: string; base: string; files: Record<string, string>; n: number };

export function makeRepo(name: string, files: Record<string, string> = BASE_FILES): Repo {
  const dir = join(scratch(name), 'repo');
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  write(dir, { SPEC_REF: `${SPEC_REF}\n`, ...files });
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'base']);
  return { dir, base: git(dir, ['rev-parse', 'HEAD']), files: { ...files }, n: 0 };
}

/** A trusted root: this repository's protected paths and risk map, plus the task ledger. */
export function trusted(name: string, ledgerText: string): string {
  const dir = scratch(`trusted-${name}`);
  for (const file of ['tools/guard/protected-paths.json', 'ops/risk-map.yaml']) {
    write(dir, { [file]: readFileSync(join(REPO, file), 'utf8') });
  }
  write(dir, {
    'tools/guard/legacy-tasks.json': JSON.stringify({ baseline: 'fixture', tasks: [] }),
    [`ops/tasks/${TASK}.yaml`]: ledgerText,
  });
  return dir;
}

export const OMIT = 'omit';

/**
 * A task branch from the base with `changes` (null removes a file) and its evidence, whose
 * modify_existing list is `records` (OMIT: no such key); returns the head.
 */
export function branch(
  repo: Repo,
  name: string,
  changes: Record<string, string | null>,
  records: unknown,
): string {
  repo.n += 1;
  git(repo.dir, ['checkout', '-q', '-B', `${name}-${repo.n}`, repo.base]);
  for (const [file, text] of Object.entries(changes)) {
    if (text === null) rmSync(join(repo.dir, file));
    else write(repo.dir, { [file]: text });
  }
  git(repo.dir, ['add', '-A']);
  git(repo.dir, ['commit', '-q', '--allow-empty', '-m', `test: ${name}`]);
  const tree = git(repo.dir, ['rev-parse', 'HEAD:test']);
  const doc = {
    task: TASK,
    spec_ref: SPEC_REF,
    spec_commit: repo.base,
    runs: [],
    reviews: [
      {
        reviewer: 'codex',
        engine: 'codex',
        model: 'gpt-6-astra',
        verdict: 'pass',
        open_s0_s1: 0,
        checklist_complete: true,
      },
    ],
    trees: { test: tree },
    longrun: { runs: 1000000, seed: 1, passed: true, tree },
    ...(records === OMIT ? {} : { modify_existing: records }),
  };
  write(repo.dir, { [`ops/evidence/${TASK}.json`]: `${JSON.stringify(doc, null, 2)}\n` });
  git(repo.dir, ['add', '-A']);
  git(repo.dir, ['commit', '-q', '-m', 'evidence']);
  return git(repo.dir, ['rev-parse', 'HEAD']);
}

export const ownerApproval = (head: string) => ({
  label: `owner-approved-${head.slice(0, 12)}`,
  approved: true,
  actor: 'o',
  reason: `label \`owner-approved-${head.slice(0, 12)}\` added by the owner account o`,
});

/** checkEvidence on the fixture: with the owner label (default), without a lookup, or not the owner's. */
export function check(
  repo: Repo,
  head: string,
  trustedDir: string,
  approval: 'owner' | 'none' | 'other' = 'owner',
): EvidenceReport {
  return checkEvidence({
    prDir: repo.dir,
    base: repo.base,
    head,
    headRef: `task/${TASK}`,
    trusted: trustedDir,
    ...(approval === 'none'
      ? {}
      : approval === 'owner'
        ? { approval: ownerApproval(head) }
        : {
            approval: {
              label: `owner-approved-${head.slice(0, 12)}`,
              approved: false,
              actor: 'ci-bot',
              reason: 'added by `ci-bot`',
            },
          }),
  });
}

export const REVERSE_RED = [
  'test/spec/identity/step-up/sms.int.test.ts > [AC-B1-02#1] sms',
] as const;
export const MUTATION = [
  { mutant: 'the implementation put back to the old rule (BR-ID-08 before)', result: 'killed' },
];

/** A support record for `file` from its base and head content (rule_change, br [BR-ID-08]). */
export function supportRecord(
  file: string,
  base: string,
  head: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const record: Record<string, unknown> = {
    file,
    scope: 'support',
    reason: 'rule_change',
    before_sha256: sha256(base),
    after_sha256: sha256(head),
    reverse_red: [...REVERSE_RED],
    br: [BR],
    ...extra,
  };
  return Object.fromEntries(Object.entries(record).filter(([, v]) => v !== undefined));
}

/** A block record as before (rule_change: mutation and br). */
export function blockRecord(
  file: string,
  test: string,
  before: string,
  after: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const record: Record<string, unknown> = {
    file,
    test,
    reason: 'rule_change',
    before,
    after,
    mutation: MUTATION,
    br: [BR],
    ...extra,
  };
  return Object.fromEntries(Object.entries(record).filter(([, v]) => v !== undefined));
}

export const problemsOf = (report: EvidenceReport): string => report.problems.join('\n');

/**
 * The problem that refuses an assertion line: it names `file`, says assertion (or 断言) and
 * names one of `lines` as a number of its own (not part of a longer number or a hex id).
 */
export function assertionProblem(
  report: EvidenceReport,
  file: string,
  lines: readonly number[],
): string | undefined {
  return report.problems.find(
    (p) =>
      p.includes(file) &&
      /assert|断言/i.test(p) &&
      lines.some((n) => new RegExp(`(?<![0-9A-Fa-f])${n}(?![0-9A-Fa-f])`).test(p)),
  );
}

// ---------------------------------------------------------------------------------------------
// red-check report (the trusted red reporter's shape, after tools/guard/lib/red-check.test.ts).

export const ROOT = '/work/repo';
export type RedTest = [name: string, status: string, cause?: string];

export function redReport(name: string, tests: RedTest[]) {
  const causesOf = (cause: string) => {
    const at = cause.indexOf(': ');
    return [{ name: cause.slice(0, at), message: cause.slice(at + 2) }];
  };
  return {
    reporter: 'couli-red-reporter',
    testResults: [
      {
        name: `${ROOT}/${name}`,
        status: 'failed',
        message: '',
        failures: [],
        assertionResults: tests.map(([fullName, status, cause]) => ({
          fullName,
          title: fullName,
          status,
          failureMessages: cause === undefined ? [] : [cause],
          failures: cause === undefined ? [] : [{ causes: causesOf(cause) }],
        })),
      },
    ],
  };
}

// ---------------------------------------------------------------------------------------------
// Round 2 (review-claude-1 S1-1): a branch whose rule-test commit comes after the base.

/**
 * A task branch base → rule-test commit with `spec` (the evidence's spec_commit) → a commit with
 * `later` (may be empty) → the evidence, whose modify_existing list is `records` (OMIT: no such
 * key); null removes a file. Returns the head and the rule-test commit.
 */
export function branchVia(
  repo: Repo,
  name: string,
  spec: Record<string, string | null>,
  later: Record<string, string | null>,
  records: unknown,
): { head: string; spec: string } {
  repo.n += 1;
  git(repo.dir, ['checkout', '-q', '-B', `${name}-${repo.n}`, repo.base]);
  const apply = (changes: Record<string, string | null>, message: string): string => {
    for (const [file, text] of Object.entries(changes)) {
      if (text === null) rmSync(join(repo.dir, file));
      else write(repo.dir, { [file]: text });
    }
    git(repo.dir, ['add', '-A']);
    git(repo.dir, ['commit', '-q', '--allow-empty', '-m', message]);
    return git(repo.dir, ['rev-parse', 'HEAD']);
  };
  const specCommit = apply(spec, `test: ${name} (rule tests)`);
  apply(later, `feat: ${name}`);
  const tree = git(repo.dir, ['rev-parse', 'HEAD:test']);
  const doc = {
    task: TASK,
    spec_ref: SPEC_REF,
    spec_commit: specCommit,
    runs: [],
    reviews: [
      {
        reviewer: 'codex',
        engine: 'codex',
        model: 'gpt-6-astra',
        verdict: 'pass',
        open_s0_s1: 0,
        checklist_complete: true,
      },
    ],
    trees: { test: tree },
    longrun: { runs: 1000000, seed: 1, passed: true, tree },
    ...(records === OMIT ? {} : { modify_existing: records }),
  };
  write(repo.dir, { [`ops/evidence/${TASK}.json`]: `${JSON.stringify(doc, null, 2)}\n` });
  git(repo.dir, ['add', '-A']);
  git(repo.dir, ['commit', '-q', '-m', 'evidence']);
  return { head: git(repo.dir, ['rev-parse', 'HEAD']), spec: specCommit };
}
