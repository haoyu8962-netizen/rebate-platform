// Unit tests for the review canary applier (CT-06zzzza; FU-REVIEW-CANARY, D10-886 / D10-1011).
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  type AddedLine,
  type Landing,
  type MutationList,
  changedSymbols,
  compileCheck,
  globToRegExp,
  isMoneyPath,
  judge,
  orderMutations,
  parseAddedLines,
  readList,
  selectMutation,
} from './apply.ts';
import { REPO } from '../testing/fixture.ts';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const LIST = readList(join(import.meta.dirname, 'mutations.json'));

function added(entries: Record<string, string[]>): Map<string, AddedLine[]> {
  return new Map(
    Object.entries(entries).map(([f, lines]) => [
      f,
      lines.map((text, i) => ({ line: i + 1, text })),
    ]),
  );
}

/** Applies in memory: records every write and undo. */
function memory() {
  const log: string[] = [];
  return {
    log,
    write: (l: Landing) => {
      log.push(`write ${l.mutation_id}`);
      return () => log.push(`undo ${l.mutation_id}`);
    },
  };
}

it('[CT-06zzzza] the shipped list keeps the 21 drafted mutations, at least 2 per category', () => {
  expect(LIST.mutations).toHaveLength(21);
  const per = new Map<string, number>();
  for (const m of LIST.mutations) per.set(m.category, (per.get(m.category) ?? 0) + 1);
  expect(per.size).toBe(8);
  for (const count of per.values()) expect(count).toBeGreaterThanOrEqual(2);
  expect(
    JSON.parse(readFileSync(join(import.meta.dirname, 'mutations.json'), 'utf8')),
  ).not.toHaveProperty('open_points');
  for (const m of LIST.mutations) expect(() => new RegExp(m.pattern)).not.toThrow();
});

it('[CT-06zzzza] globs: ** at any depth, braces with slashes, excludes of tests and generated files', () => {
  const g = globToRegExp('{apps/api/src,packages/domain/src}/**/*.ts');
  expect(g.test('apps/api/src/modules/ledger/x.ts')).toBe(true);
  expect(g.test('packages/domain/src/x.ts')).toBe(true);
  expect(g.test('packages/money/src/x.ts')).toBe(false);
  expect(globToRegExp('**/*.test.ts').test('apps/api/src/a.test.ts')).toBe(true);
  expect(globToRegExp('**/*.gen.ts').test('a.gen.ts')).toBe(true);
});

it('[CT-06zzzza] only added lines count, with new-file line numbers', () => {
  const diff = [
    'diff --git a/packages/p/src/a.ts b/packages/p/src/a.ts',
    '--- a/packages/p/src/a.ts',
    '+++ b/packages/p/src/a.ts',
    '@@ -3,1 +3,2 @@',
    '-const old = x === 1;',
    '+const neu = x === 2;',
    '+const two = 2;',
    'diff --git a/gone.ts b/gone.ts',
    '--- a/gone.ts',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-const g = a === b;',
    '',
  ].join('\n');
  const files = parseAddedLines(diff);
  expect(files.get('packages/p/src/a.ts')).toEqual([
    { line: 3, text: 'const neu = x === 2;' },
    { line: 4, text: 'const two = 2;' },
  ]);
  expect(files.has('gone.ts')).toBe(false);
  // A pattern that matches only a removed line lands nowhere.
  const res = selectMutation({
    list: LIST,
    added: added({ 'packages/p/src/a.ts': ['const two = 2;'] }),
    round: 1,
    compiles: null,
    ...memory(),
  });
  expect(res.mutation_id).toBeNull();
});

it('[CT-06zzzza] money paths try the seven categories first, rotated by round; generic last', () => {
  const ids = (round: number, money: boolean) =>
    orderMutations(LIST.mutations, round, money).map((m) => m.id);
  expect(ids(1, true)[0]).toBe('ROUND-01');
  expect(ids(2, true)[0]).toBe('ROUND-02');
  expect(ids(1, true).slice(-3)).toEqual(['GEN-01', 'GEN-02', 'GEN-03']);
  expect(ids(2, true).slice(-3)).toEqual(['GEN-02', 'GEN-03', 'GEN-01']);
  // Elsewhere the whole list is rotated: round 19 starts at the first generic one.
  expect(ids(19, false)[0]).toBe('GEN-01');
  const file = 'apps/api/src/modules/ledger/post.ts';
  const lines = ['  const left = subFen(total, paid);', '  if (left > 0n) return left;'];
  const r1 = selectMutation({
    list: LIST,
    added: added({ [file]: lines }),
    round: 1,
    compiles: null,
    ...memory(),
  });
  const r2 = selectMutation({
    list: LIST,
    added: added({ [file]: lines }),
    round: 5,
    compiles: null,
    ...memory(),
  });
  expect(r1).toMatchObject({
    mutation_id: 'SIGN-01',
    line: 1,
    after: '  const left = subFen(paid, total);',
  });
  expect(r2).toMatchObject({
    mutation_id: 'SIGN-02',
    line: 2,
    after: '  if (left >= 0n) return left;',
  });
});

it('[CT-06zzzza] tests, generated files and migrations are never a landing; nothing left is n/a', () => {
  const res = selectMutation({
    list: LIST,
    added: added({
      'apps/api/src/modules/ledger/post.test.ts': ['if (a) throw new Error("x");', 'x === y'],
      'packages/p/src/types.gen.ts': ['a === b'],
      'db/migrations/0001_x.sql': ['a === b'],
    }),
    round: 1,
    compiles: null,
    ...memory(),
  });
  expect(res).toMatchObject({ mutation_id: null });
  expect('reason' in res && res.reason).toContain('no added lines');
});

it('[CT-06zzzza] a mutation that does not compile is undone and the next usable one is applied', () => {
  const file = 'apps/api/src/modules/ledger/post.ts';
  const mem = memory();
  const res = selectMutation({
    list: LIST,
    added: added({
      [file]: ['  const v = mulDivFloor(a, b, c);', '  const left = subFen(total, paid);'],
    }),
    round: 1,
    compiles: (l) => l.mutation_id !== 'ROUND-01',
    ...mem,
  });
  expect(res).toMatchObject({ mutation_id: 'SIGN-01', compile: 'ok' });
  expect('tried' in res && res.tried.map((t) => t.mutation_id)).toEqual(['ROUND-01']);
  expect(mem.log).toEqual(['write ROUND-01', 'undo ROUND-01', 'write SIGN-01']);
});

it('[CT-06zzzza] hit: S0 / S1 in the mutated file within 15 lines or naming the changed symbol', () => {
  const landing: Landing = {
    mutation_id: 'ROUND-01',
    category: 'rounding',
    file: 'apps/api/src/x.ts',
    line: 100,
    before: 'const f = mulDivFloor(a, b, c);',
    after: 'const f = mulDivCeil(a, b, c);',
  };
  const f = (severity: string, file: string, line: number, scenario = 'x') => ({
    severity,
    key: 'k',
    file,
    line,
    rule: 'r',
    scenario,
    suggestion: 's',
  });
  expect(judge(landing, { findings: [f('S1', 'apps/api/src/x.ts', 115)] })).toEqual({
    hit: true,
    s0s1_count: 1,
  });
  expect(judge(landing, { findings: [f('S1', 'apps/api/src/x.ts', 116)] }).hit).toBe(false);
  expect(
    judge(landing, { findings: [f('S0', 'apps/api/src/x.ts', 300, 'mulDivCeil rounds up')] }).hit,
  ).toBe(true);
  expect(judge(landing, { findings: [f('S2', 'apps/api/src/x.ts', 100)] })).toEqual({
    hit: false,
    s0s1_count: 0,
  });
  expect(judge(landing, { findings: [f('S1', 'apps/api/src/y.ts', 100)] }).hit).toBe(false);
});

it('[CT-06zzzza] an empty list or a list without landings records n/a with a reason', () => {
  const empty: MutationList = { version: 1, exclude_globs: [], mutations: [] };
  const res = selectMutation({
    list: empty,
    added: added({ 'a.ts': ['x'] }),
    round: 1,
    compiles: null,
    ...memory(),
  });
  expect(res).toMatchObject({
    mutation_id: null,
    reason: 'no mutation of the list lands on the added lines',
  });
});

it('[CT-06zzzza] r1 S2: every MONEY_PATHS module of evidence-check tries the money categories first', () => {
  for (const f of [
    'apps/api/src/modules/withdrawals/a.ts',
    'apps/api/src/modules/orders/a.ts',
    'apps/api/src/modules/reconciliation/a.ts',
    'apps/api/src/modules/linking/a.ts',
    'apps/api/src/modules/union/a.ts',
    'apps/api/src/modules/payment/a.ts',
    'apps/api/src/modules/ledger/a.ts',
    'packages/domain/src/a.ts',
    'packages/money/src/a.ts',
  ])
    expect(isMoneyPath(f), f).toBe(true);
  expect(isMoneyPath('apps/api/src/modules/catalog/a.ts')).toBe(false);
  expect(isMoneyPath('packages/p/src/a.ts')).toBe(false);
  // Round 2 on a withdrawals-only change: ROUND-01 (last of the money rotation) before GEN-03.
  const res = selectMutation({
    list: LIST,
    added: added({
      'apps/api/src/modules/withdrawals/a.ts': [
        '  const v = mulDivFloor(a, b, c);',
        '  const same = x === y;',
      ],
    }),
    round: 2,
    compiles: null,
    ...memory(),
  });
  expect(res).toMatchObject({ mutation_id: 'ROUND-01', line: 1 });
});

it('[CT-06zzzza] r1 S2: no identifier changed (an operator) means the line window alone decides', () => {
  const before = 'export const ok = (x: number): boolean => x === 1;';
  const after = 'export const ok = (x: number): boolean => x !== 1;';
  expect(changedSymbols(before, after)).toEqual([]);
  // Keywords never count as changed symbols; real identifiers still do.
  expect(changedSymbols('return true;', 'return false;')).toEqual([]);
  expect(changedSymbols('const f = mulDivFloor(a);', 'const f = mulDivCeil(a);')).toEqual([
    'mulDivFloor',
    'mulDivCeil',
  ]);
  const landing: Landing = {
    mutation_id: 'GEN-03',
    category: 'generic',
    file: 'packages/p/src/b.ts',
    line: 10,
    before,
    after,
  };
  const finding = (line: number) => ({
    severity: 'S1',
    key: 'k',
    file: 'packages/p/src/b.ts',
    line,
    rule: 'const number boolean export',
    scenario: 'an unrelated const of type number',
    suggestion: 's',
  });
  expect(judge(landing, { findings: [finding(210)] })).toEqual({ hit: false, s0s1_count: 1 });
  expect(judge(landing, { findings: [finding(20)] }).hit).toBe(true);
});

type CompileEnv = { trusted: string; worktree: string; from: string };

/** A fake tsc: records that it ran (in its own root's ran.txt) and exits 0. */
function fakeTsc(root: string): void {
  const bin = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
  mkdirSync(dirname(bin), { recursive: true });
  // CommonJS like the real package, whatever the enclosing package.json says.
  writeFileSync(join(dirname(bin), '..', 'package.json'), '{"type":"commonjs"}\n');
  writeFileSync(
    bin,
    `require('node:fs').writeFileSync(${JSON.stringify(join(root, 'ran.txt'))}, 'ran');\n`,
  );
}

function compileEnv(name: string): CompileEnv {
  const root = join(
    REPO,
    '.tmp',
    `canary-apply-${name}-${process.pid}-${randomBytes(4).toString('hex')}`,
  );
  dirs.push(root);
  const e = {
    trusted: join(root, 'trusted'),
    worktree: join(root, 'wt'),
    from: join(root, 'reviewed'),
  };
  mkdirSync(join(e.worktree, 'packages', 'p', 'src'), { recursive: true });
  mkdirSync(e.trusted, { recursive: true });
  writeFileSync(join(e.worktree, 'packages', 'p', 'tsconfig.json'), '{}\n');
  writeFileSync(join(e.worktree, 'packages', 'p', 'src', 'b.ts'), 'x !== 1\n');
  // The reviewed worktree carries a compiler of its own: it must never run.
  fakeTsc(e.from);
  return e;
}

const LANDED: Landing = {
  mutation_id: 'GEN-03',
  category: 'generic',
  file: 'packages/p/src/b.ts',
  line: 1,
  before: 'x === 1',
  after: 'x !== 1',
};

it('[CT-06zzzza] r1 S1: the compile check runs the trusted root tsc, never the reviewed worktree one', () => {
  const e = compileEnv('trusted');
  fakeTsc(e.trusted);
  const c = compileCheck(e.worktree, e.trusted, e.from);
  expect(c.check).not.toBeNull();
  expect(c.check?.(LANDED)).toBe(true);
  expect(existsSync(join(e.trusted, 'ran.txt'))).toBe(true);
  expect(existsSync(join(e.from, 'ran.txt'))).toBe(false);
  // The mutated line is back in place after the baseline run.
  expect(readFileSync(join(e.worktree, 'packages', 'p', 'src', 'b.ts'), 'utf8')).toBe('x !== 1\n');
});

it('[CT-06zzzza] r1 S1: without a trusted typescript the check is unavailable; nothing else is tried', () => {
  const e = compileEnv('missing');
  for (const trusted of [undefined, e.trusted]) {
    const c = compileCheck(e.worktree, trusted, e.from);
    expect(c.check).toBeNull();
    expect(c.reason).toMatch(trusted === undefined ? /no trusted root/ : /trusted root/);
  }
  expect(existsSync(join(e.from, 'ran.txt'))).toBe(false);
  const c = compileCheck(e.worktree, e.trusted, e.from);
  const res = selectMutation({
    list: LIST,
    added: added({ 'packages/p/src/b.ts': ['x === 1'] }),
    round: 1,
    compiles: c.check,
    ...(c.reason === undefined ? {} : { compileUnavailable: c.reason }),
    ...memory(),
  });
  expect(res).toMatchObject({ mutation_id: 'GEN-03' });
  expect('compile' in res && res.compile).toMatch(
    /^unavailable: no typescript in the trusted root/,
  );
});
