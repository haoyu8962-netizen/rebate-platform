// tokens-lag.ts: the pure verdicts, then the CLI against fixture git repositories under
// .tmp/tokens-lag-<pid>/ (a planning repository with a dated token history, a platform repository
// with a dated contracts/ history and an H5 snapshot), removed afterwards.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import {
  DAY_MS,
  InputError,
  contractMismatch,
  distinctVersions,
  githubWarning,
  judgeClientVectors,
  judgeContract,
  judgeTokens,
  main,
  parseContractLock,
  readmeSourceCommit,
  tokenVersion,
} from './tokens-lag.ts';
import type { Report, TokenRevision } from './tokens-lag.ts';

const REPO = resolve(import.meta.dirname, '../..');
const SCRATCH = join(REPO, '.tmp', `tokens-lag-${process.pid}`);
const T0 = Date.parse('2026-01-01T00:00:00Z');
const HOUR_MS = 3_600_000;
const TOKENS = 'design/tokens/design-tokens.json';

afterAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------
// Pure verdicts
// ---------------------------------------------------------------------------------------------

const rev = (commit: string, days: number, version: string): TokenRevision => ({
  commit,
  time: T0 + days * DAY_MS,
  version,
});

it('distinctVersions keeps first appearances in order', () => {
  expect(
    distinctVersions([rev('a', 0, '0.1.0'), rev('b', 1, '0.1.0'), rev('c', 2, '0.2.0')]),
  ).toEqual(['0.1.0', '0.2.0']);
});

it('judgeTokens: the newest version, locked at the newest commit, is not behind', () => {
  const v = judgeTokens({
    history: [rev('a', 0, '0.1.0'), rev('b', 3, '0.2.0')],
    lockedVersion: '0.2.0',
    lockedTime: T0 + 3 * DAY_MS,
    containsLatest: true,
  });
  expect(v).toEqual({
    latestVersion: '0.2.0',
    versionsBehind: 0,
    msBehind: 0,
    versionLag: false,
    timeLag: false,
  });
});

it('judgeTokens: counts distinct versions, not semver steps', () => {
  const v = judgeTokens({
    history: [
      rev('a', 0, '0.1.0'),
      rev('b', 1, '0.1.0'),
      rev('c', 2, '0.5.0'),
      rev('d', 3, '2.0.0'),
    ],
    lockedVersion: '0.1.0',
    lockedTime: T0 + DAY_MS,
    containsLatest: false,
  });
  expect(v.versionsBehind).toBe(2);
  expect(v.versionLag).toBe(true);
  expect(v.timeLag).toBe(false);
});

it('judgeTokens: same version, 7 days behind warns; 6 days 23 hours does not', () => {
  const history = [rev('a', 0, '0.1.0'), rev('b', 7, '0.1.0')];
  const at7 = judgeTokens({
    history,
    lockedVersion: '0.1.0',
    lockedTime: T0,
    containsLatest: false,
  });
  expect(at7.versionLag).toBe(false);
  expect(at7.timeLag).toBe(true);
  const at6d23h = judgeTokens({
    history,
    lockedVersion: '0.1.0',
    lockedTime: T0 + HOUR_MS,
    containsLatest: false,
  });
  expect(at6d23h.timeLag).toBe(false);
  expect(at6d23h.msBehind).toBe(7 * DAY_MS - HOUR_MS);
});

it('judgeTokens: a lock that contains the newest token commit has no time lag', () => {
  const v = judgeTokens({
    history: [rev('a', 0, '0.1.0'), rev('b', 30, '0.1.0')],
    lockedVersion: '0.1.0',
    lockedTime: T0,
    containsLatest: true,
  });
  expect(v.msBehind).toBe(0);
  expect(v.timeLag).toBe(false);
});

it('judgeTokens: a version that never appeared is an input error', () => {
  expect(() =>
    judgeTokens({
      history: [rev('a', 0, '0.1.0')],
      lockedVersion: '9.9.9',
      lockedTime: T0,
      containsLatest: false,
    }),
  ).toThrow(InputError);
});

it('judgeContract: 7 days behind warns, 6 days 23 hours or containing the trunk does not', () => {
  const trunkTime = T0 + 7 * DAY_MS;
  expect(judgeContract({ found: true, lockedTime: T0, trunkTime, containsTrunk: false })).toEqual({
    msBehind: 7 * DAY_MS,
    timeLag: true,
  });
  expect(
    judgeContract({ found: true, lockedTime: T0 + HOUR_MS, trunkTime, containsTrunk: false })
      .timeLag,
  ).toBe(false);
  expect(judgeContract({ found: true, lockedTime: T0, trunkTime, containsTrunk: true })).toEqual({
    msBehind: 0,
    timeLag: false,
  });
  expect(
    judgeContract({ found: false, lockedTime: null, trunkTime, containsTrunk: false }),
  ).toEqual({ msBehind: null, timeLag: false });
});

it('contractMismatch: needs two or more locks and differing commits', () => {
  expect(contractMismatch([{ name: 'android', commit: 'a' }])).toBeNull();
  expect(
    contractMismatch([
      { name: 'android', commit: 'a' },
      { name: 'ios', commit: 'a' },
    ]),
  ).toBeNull();
  expect(
    contractMismatch([
      { name: 'android', commit: 'a' },
      { name: 'ios', commit: 'b' },
    ]),
  ).toHaveLength(2);
});

it('parseContractLock: reads both commits and rejects bad JSON, missing fields and other paths', () => {
  const c = 'a'.repeat(40);
  const t = 'b'.repeat(40);
  expect(
    parseContractLock(
      JSON.stringify({
        rebate_platform: { repo: '../rebate-platform', commit: c },
        design_tokens: { repo: '../couli', commit: t, path: TOKENS },
        files: {},
      }),
      'x',
    ),
  ).toEqual({ contractCommit: c, tokensCommit: t, files: {} });
  expect(
    parseContractLock(
      JSON.stringify({ rebate_platform: { commit: c }, design_tokens: { commit: t } }),
      'x',
    ).files,
  ).toBeNull();
  expect(() => parseContractLock('{', 'x')).toThrow(InputError);
  expect(() => parseContractLock(JSON.stringify({ design_tokens: { commit: t } }), 'x')).toThrow(
    /rebate_platform\.commit/,
  );
  expect(() =>
    parseContractLock(
      JSON.stringify({ rebate_platform: { commit: c }, design_tokens: { commit: 'abc' } }),
      'x',
    ),
  ).toThrow(/design_tokens\.commit/);
  expect(() =>
    parseContractLock(
      JSON.stringify({
        rebate_platform: { commit: c },
        design_tokens: { commit: t, path: 'other.json' },
      }),
      'x',
    ),
  ).toThrow(/design_tokens\.path/);
});

it('tokenVersion and readmeSourceCommit read the H5 lock', () => {
  expect(tokenVersion('{"metadata":{"version":"0.4.0"}}', 'x')).toBe('0.4.0');
  expect(() => tokenVersion('{"metadata":{}}', 'x')).toThrow(InputError);
  const c = 'c'.repeat(40);
  expect(
    readmeSourceCommit(`| a | b |\n| \`design-tokens.json\` | 版本 0.4.0，来源提交 ${c}。 |\n`),
  ).toBe(c);
  expect(() => readmeSourceCommit('| `design-tokens.json` | 没有提交 |\n')).toThrow(InputError);
  expect(() => readmeSourceCommit('nothing\n')).toThrow(InputError);
});

it('githubWarning escapes the workflow-command data', () => {
  expect(githubWarning('a%b\nc')).toBe('::warning title=TOKENS-LAG::a%25b%0Ac');
});

// ---------------------------------------------------------------------------------------------
// Fixture repositories
// ---------------------------------------------------------------------------------------------

let fixtureCount = 0;

function git(cwd: string, args: string[], at?: number): string {
  const date = at === undefined ? {} : { GIT_AUTHOR_DATE: iso(at), GIT_COMMITTER_DATE: iso(at) };
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
    { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', ...date } },
  );
  if (res.status !== 0) throw new Error(`git ${args.join(' ')}: ${res.stderr}`);
  return res.stdout.trim();
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function write(root: string, rel: string, text: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}

function newRepo(kind: string): string {
  const dir = join(SCRATCH, `${kind}-${String(++fixtureCount)}`);
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  return dir;
}

/** Writes (or, for null, deletes) the files and commits at the given time. */
function commit(dir: string, files: Record<string, string | null>, at: number): string {
  for (const [rel, text] of Object.entries(files)) {
    if (text === null) rmSync(join(dir, rel));
    else write(dir, rel, text);
  }
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', `at ${iso(at)}`], at);
  return git(dir, ['rev-parse', 'HEAD']);
}

let tokenEdit = 0;
const tokens = (version: string): string =>
  `${JSON.stringify({ metadata: { version, edit: ++tokenEdit } }, null, 2)}\n`;

/** A planning repository; each step is a token revision (`version`) or another file. */
/** A planning repository; each step is a token revision (`version`), raw token-file text (`raw`,
 * null deletes the file) or a change to another file. */
function planning(steps: { at: number; version?: string; raw?: string | null }[]): {
  dir: string;
  commits: string[];
} {
  const dir = newRepo('planning');
  const commits = steps.map((s, i) =>
    commit(
      dir,
      s.raw !== undefined
        ? { [TOKENS]: s.raw }
        : s.version === undefined
          ? { [`notes/${String(i)}.md`]: 'x\n' }
          : { [TOKENS]: tokens(s.version) },
      s.at,
    ),
  );
  return { dir, commits };
}

/** A platform repository whose contracts/ changed at the given times. */
function platform(times: number[]): { dir: string; commits: string[] } {
  const dir = newRepo('platform');
  const commits = times.map((at, i) => commit(dir, { 'contracts/x.json': `${String(i)}\n` }, at));
  return { dir, commits };
}

function lockFile(
  contract: string,
  tokensCommit: string,
  files: Record<string, unknown> = {},
): string {
  const path = join(SCRATCH, `lock-${String(++fixtureCount)}.json`);
  write(
    SCRATCH,
    `lock-${String(fixtureCount)}.json`,
    JSON.stringify({
      rebate_platform: { repo: '../rebate-platform', commit: contract },
      design_tokens: { repo: '../couli', commit: tokensCommit, path: TOKENS },
      files,
    }),
  );
  return path;
}

type Run = { code: number; report: Report | null; stderr: string };

function run(args: string[], env: NodeJS.ProcessEnv = {}): Run {
  let out = '';
  let err = '';
  const code = main(args, env, { out: (s) => (out += s), err: (s) => (err += s) }, SCRATCH);
  return { code, report: out === '' ? null : (JSON.parse(out) as Report), stderr: err };
}

const kinds = (r: Run): string[] =>
  (r.report?.warnings ?? []).map((w) => `${w.lock ?? '*'}:${w.kind}`);

// ---------------------------------------------------------------------------------------------
// CLI scenarios
// ---------------------------------------------------------------------------------------------

it('not behind: a lock at the newest token revision and the contract trunk -> exit 0', () => {
  const p = planning([
    { at: T0, version: '0.1.0' },
    { at: T0 + DAY_MS, version: '0.2.0' },
  ]);
  const f = platform([T0, T0 + DAY_MS]);
  const lock = lockFile(f.commits[1] ?? '', p.commits[1] ?? '');
  const r = run(['--planning', p.dir, '--platform', f.dir, '--lock', `android=${lock}`]);
  expect(r.code).toBe(0);
  expect(kinds(r)).toEqual([]);
  const l = r.report?.locks[0];
  expect(l?.tokens).toMatchObject({
    version: '0.2.0',
    latest_version: '0.2.0',
    versions_behind: 0,
    days_behind: 0,
  });
  expect(l?.contract).toMatchObject({ found: true, days_behind: 0 });
  expect(r.stderr).toContain('无告警');
});

it('a lock on a later non-token commit contains the newest revision and is not behind', () => {
  const p = planning([{ at: T0, version: '0.1.0' }, { at: T0 + 30 * DAY_MS }]);
  const f = platform([T0]);
  const lock = lockFile(f.commits[0] ?? '', p.commits[1] ?? '');
  const r = run(['--planning', p.dir, '--platform', f.dir, '--lock', `ios=${lock}`]);
  expect(r.code).toBe(0);
  expect(r.report?.locks[0]?.tokens.version).toBe('0.1.0');
});

it('one version behind -> tokens-version warning, exit 1', () => {
  const p = planning([
    { at: T0, version: '0.1.0' },
    { at: T0 + DAY_MS, version: '0.2.0' },
  ]);
  const f = platform([T0]);
  const lock = lockFile(f.commits[0] ?? '', p.commits[0] ?? '');
  const r = run(['--planning', p.dir, '--platform', f.dir, '--lock', `android=${lock}`]);
  expect(r.code).toBe(1);
  expect(kinds(r)).toEqual(['android:tokens-version']);
  expect(r.report?.locks[0]?.tokens).toMatchObject({ versions_behind: 1, days_behind: 1 });
  expect(r.stderr).toContain('落后源最新 0.2.0 1 个版本');
});

it('two versions behind', () => {
  const p = planning([
    { at: T0, version: '0.1.0' },
    { at: T0 + HOUR_MS, version: '0.1.0' },
    { at: T0 + 2 * HOUR_MS, version: '0.2.0' },
    { at: T0 + 3 * HOUR_MS, version: '0.3.0' },
  ]);
  const f = platform([T0]);
  const lock = lockFile(f.commits[0] ?? '', p.commits[1] ?? '');
  const r = run(['--planning', p.dir, '--platform', f.dir, '--lock', `harmony=${lock}`]);
  expect(r.code).toBe(1);
  expect(kinds(r)).toEqual(['harmony:tokens-version']);
  expect(r.report?.locks[0]?.tokens.versions_behind).toBe(2);
});

it('same version 7 days behind warns; 6 days 23 hours does not', () => {
  const p = planning([
    { at: T0, version: '0.1.0' },
    { at: T0 + HOUR_MS, version: '0.1.0' },
    { at: T0 + 7 * DAY_MS, version: '0.1.0' },
  ]);
  const f = platform([T0]);
  const seven = run([
    '--planning',
    p.dir,
    '--platform',
    f.dir,
    '--lock',
    `android=${lockFile(f.commits[0] ?? '', p.commits[0] ?? '')}`,
  ]);
  expect(seven.code).toBe(1);
  expect(kinds(seven)).toEqual(['android:tokens-days']);
  expect(seven.report?.locks[0]?.tokens).toMatchObject({ versions_behind: 0, days_behind: 7 });
  const almost = run([
    '--planning',
    p.dir,
    '--platform',
    f.dir,
    '--lock',
    `android=${lockFile(f.commits[0] ?? '', p.commits[1] ?? '')}`,
  ]);
  expect(almost.code).toBe(0);
  expect(almost.report?.locks[0]?.tokens.days_behind).toBe(6);
});

it('client contract locks that disagree -> 三端契约锁不一致, listing each client', () => {
  const p = planning([{ at: T0, version: '0.1.0' }]);
  const f = platform([T0, T0 + HOUR_MS]);
  const r = run([
    '--planning',
    p.dir,
    '--platform',
    f.dir,
    '--lock',
    `android=${lockFile(f.commits[0] ?? '', p.commits[0] ?? '')}`,
    '--lock',
    `harmony=${lockFile(f.commits[1] ?? '', p.commits[0] ?? '')}`,
    '--lock',
    `ios=${lockFile(f.commits[1] ?? '', p.commits[0] ?? '')}`,
  ]);
  expect(r.code).toBe(1);
  expect(kinds(r)).toEqual(['*:contract-mismatch']);
  const msg = r.report?.warnings[0]?.message ?? '';
  expect(msg).toContain('三端契约锁不一致');
  for (const name of ['android', 'harmony', 'ios']) expect(msg).toContain(`${name}=`);
});

it('contract lock 7 days behind the contracts/ trunk -> contract-days; a later non-contract commit is not', () => {
  const p = planning([{ at: T0, version: '0.1.0' }]);
  const f = platform([T0, T0 + 7 * DAY_MS]);
  const behind = run([
    '--planning',
    p.dir,
    '--platform',
    f.dir,
    '--lock',
    `ios=${lockFile(f.commits[0] ?? '', p.commits[0] ?? '')}`,
  ]);
  expect(behind.code).toBe(1);
  expect(kinds(behind)).toEqual(['ios:contract-days']);
  expect(behind.report?.locks[0]?.contract?.days_behind).toBe(7);
  const later = commit(f.dir, { 'README.md': 'x\n' }, T0 + 20 * DAY_MS);
  const ahead = run([
    '--planning',
    p.dir,
    '--platform',
    f.dir,
    '--lock',
    `ios=${lockFile(later, p.commits[0] ?? '')}`,
  ]);
  expect(ahead.code).toBe(0);
  expect(ahead.report?.platform?.contracts_commit).toBe(f.commits[1]);
});

it('a contract commit this repository does not have -> warning 找不到该提交, not an input error', () => {
  const p = planning([{ at: T0, version: '0.1.0' }]);
  const f = platform([T0]);
  const r = run([
    '--planning',
    p.dir,
    '--platform',
    f.dir,
    '--lock',
    `android=${lockFile('f'.repeat(40), p.commits[0] ?? '')}`,
  ]);
  expect(r.code).toBe(1);
  expect(kinds(r)).toEqual(['android:contract-missing']);
  expect(r.report?.warnings[0]?.message).toContain('找不到该提交');
  expect(r.report?.locks[0]?.contract).toMatchObject({ found: false, days_behind: null });
});

function h5Platform(version: string, source: string, snapshot = tokens(version)): string {
  const dir = newRepo('h5');
  commit(
    dir,
    {
      'contracts/design-tokens.json': snapshot,
      'contracts/README.md': `| 文件 | 说明 |\n| \`design-tokens.json\` | 令牌版本 ${version}，来源提交 ${source}。 |\n`,
    },
    T0,
  );
  return dir;
}

it('--h5 reads the snapshot version and the README source commit', () => {
  const p = planning([
    { at: T0, version: '0.4.0' },
    { at: T0 + 10 * DAY_MS, version: '0.5.0' },
  ]);
  const fresh = run([
    '--planning',
    p.dir,
    '--platform',
    h5Platform('0.5.0', p.commits[1] ?? ''),
    '--h5',
  ]);
  expect(fresh.code).toBe(0);
  expect(fresh.report?.locks).toEqual([
    expect.objectContaining({ name: 'h5', source: 'h5-snapshot', contract: null }),
  ]);
  expect(fresh.report?.platform).toBeNull();
  const stale = run([
    '--planning',
    p.dir,
    '--platform',
    h5Platform('0.4.0', p.commits[0] ?? ''),
    '--h5',
  ]);
  expect(stale.code).toBe(1);
  expect(kinds(stale)).toEqual(['h5:tokens-version', 'h5:tokens-days']);
  expect(stale.report?.locks[0]?.tokens).toMatchObject({
    commit: p.commits[0],
    version: '0.4.0',
    latest_version: '0.5.0',
    versions_behind: 1,
    days_behind: 10,
  });
  const mismatch = run([
    '--planning',
    p.dir,
    '--platform',
    h5Platform('0.4.0', p.commits[1] ?? ''),
    '--h5',
  ]);
  // The verdict follows the source commit (0.5.0, current); the snapshot only warns.
  expect(mismatch.code).toBe(1);
  expect(kinds(mismatch)).toEqual(['h5:snapshot-mismatch']);
  expect(mismatch.report?.locks[0]?.tokens.version).toBe('0.5.0');
});

it('--h5: a snapshot version missing from the source history, or unreadable, only warns (exit 1)', () => {
  const p = planning([
    { at: T0, version: '0.4.0' },
    { at: T0 + DAY_MS, version: '0.4.1' },
  ]);
  for (const snapshot of [tokens('0.5.0'), '{"metadata": ', '{"metadata": {}}\n']) {
    const r = run([
      '--planning',
      p.dir,
      '--platform',
      h5Platform('0.4.1', p.commits[1] ?? '', snapshot),
      '--h5',
    ]);
    expect({ snapshot, code: r.code, kinds: kinds(r) }).toEqual({
      snapshot,
      code: 1,
      kinds: ['h5:snapshot-mismatch'],
    });
    expect(r.report?.locks[0]?.tokens).toMatchObject({ version: '0.4.1', versions_behind: 0 });
  }
});

it('--h5: a README source commit missing from the planning ref, or no source commit, is exit 2', () => {
  const p = planning([{ at: T0, version: '0.4.0' }]);
  const other = planning([{ at: T0, version: '0.4.0' }]);
  const notOnRef = run([
    '--planning',
    p.dir,
    '--platform',
    h5Platform('0.4.0', other.commits[0] ?? ''),
    '--h5',
  ]);
  expect(notOnRef.code).toBe(2);
  expect(notOnRef.stderr).toContain('不在规划仓库');
  const dir = newRepo('h5');
  commit(
    dir,
    {
      'contracts/design-tokens.json': tokens('0.4.0'),
      'contracts/README.md': '| `design-tokens.json` | 没有来源提交 |\n',
    },
    T0,
  );
  const noSource = run(['--planning', p.dir, '--platform', dir, '--h5']);
  expect(noSource.code).toBe(2);
  expect(noSource.stderr).toContain('来源提交');
});

it('the newest token revision deleted, broken or without metadata.version is exit 2', () => {
  for (const raw of [null, '{"metadata": ', '{"metadata": {}}\n']) {
    const p = planning([
      { at: T0, version: '0.1.0' },
      { at: T0 + DAY_MS, raw },
    ]);
    const r = run([
      '--planning',
      p.dir,
      '--platform',
      h5Platform('0.1.0', p.commits[0] ?? ''),
      '--h5',
    ]);
    expect({ raw, code: r.code, out: r.report }).toEqual({ raw, code: 2, out: null });
    expect(r.stderr).toContain('最新的令牌提交');
  }
});

it('an older unreadable token revision is a source-invalid warning and not counted as a version', () => {
  const p = planning([
    { at: T0, version: '0.1.0' },
    { at: T0 + HOUR_MS, raw: '{"metadata": ' },
    { at: T0 + 2 * HOUR_MS, raw: null },
    { at: T0 + 3 * HOUR_MS, version: '0.1.0' },
  ]);
  const r = run([
    '--planning',
    p.dir,
    '--platform',
    h5Platform('0.1.0', p.commits[3] ?? ''),
    '--h5',
  ]);
  expect(r.code).toBe(1);
  expect(kinds(r)).toEqual(['*:source-invalid', '*:source-invalid']);
  expect(r.report?.planning.versions.map((v) => v.version)).toEqual(['0.1.0']);
  expect(r.report?.locks[0]?.tokens.versions_behind).toBe(0);
  const messages = (r.report?.warnings ?? []).map((w) => w.message).join('\n');
  expect(messages).toContain(p.commits[1]?.slice(0, 12));
  expect(messages).toContain(p.commits[2]?.slice(0, 12));
});

it('input errors exit 2: missing field, broken JSON, missing file, unknown commit, bad arguments', () => {
  const p = planning([{ at: T0, version: '0.1.0' }]);
  const f = platform([T0]);
  const base = ['--planning', p.dir, '--platform', f.dir];
  write(
    SCRATCH,
    'missing-field.json',
    JSON.stringify({ rebate_platform: { commit: f.commits[0] } }),
  );
  write(SCRATCH, 'broken.json', '{"rebate_platform": ');
  const cases: string[][] = [
    [...base, '--lock', `android=${join(SCRATCH, 'missing-field.json')}`],
    [...base, '--lock', `android=${join(SCRATCH, 'broken.json')}`],
    [...base, '--lock', `android=${join(SCRATCH, 'no-such.lock')}`],
    [...base, '--lock', `android=${lockFile(f.commits[0] ?? '', 'e'.repeat(40))}`],
    [...base, '--lock', `android=${lockFile(f.commits[0] ?? '', f.commits[0] ?? '')}`],
    ['--planning', join(SCRATCH, 'nowhere'), '--h5'],
    [...base],
    [...base, '--lock', 'android'],
    [...base, '--h5', '--now', 'yesterday'],
    [...base, '--planning-ref', 'no-such-ref', '--h5'],
  ];
  for (const args of cases) {
    const r = run(args);
    expect({ args, code: r.code, out: r.report }).toEqual({ args, code: 2, out: null });
    expect(r.stderr).toContain('TOKENS-LAG 输入错误');
  }
});

it('GITHUB_ACTIONS=true adds one ::warning line per warning on stderr; stdout stays JSON', () => {
  const p = planning([
    { at: T0, version: '0.1.0' },
    { at: T0 + 8 * DAY_MS, version: '0.2.0' },
  ]);
  const f = platform([T0]);
  const args = [
    '--planning',
    p.dir,
    '--platform',
    f.dir,
    '--lock',
    `android=${lockFile(f.commits[0] ?? '', p.commits[0] ?? '')}`,
  ];
  const gha = run(args, { GITHUB_ACTIONS: 'true' });
  expect(gha.code).toBe(1);
  const lines = gha.stderr.split('\n').filter((l) => l.startsWith('::warning title=TOKENS-LAG::'));
  expect(lines).toHaveLength(2);
  expect(gha.report?.warnings).toHaveLength(2);
  const local = run(args);
  expect(local.stderr).not.toContain('::warning');
});

it('--now sets the reported lock age only', () => {
  const p = planning([{ at: T0, version: '0.1.0' }]);
  const f = platform([T0]);
  const lock = lockFile(f.commits[0] ?? '', p.commits[0] ?? '');
  const r = run([
    '--planning',
    p.dir,
    '--platform',
    f.dir,
    '--lock',
    `android=${lock}`,
    '--now',
    iso(T0 + 40 * DAY_MS),
  ]);
  expect(r.code).toBe(0);
  expect(r.report?.now).toBe(iso(T0 + 40 * DAY_MS));
  expect(r.report?.locks[0]?.tokens.age_days).toBe(40);
});

// ---------------------------------------------------------------------------------------------
// --client-vectors (DSX-42)
// ---------------------------------------------------------------------------------------------

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
const VECTORS = { 'login-vectors.json': '{"login": 1}\n', 'order-vectors.json': '{"order": 1}\n' };

/** A specs/client fixture directory with a manifest matching its files. */
function vectorsDir(files: Record<string, string> = VECTORS): string {
  const dir = join(SCRATCH, `client-${String(++fixtureCount)}`);
  const entries: Record<string, { sha256: string; bytes: number }> = {};
  for (const [rel, text] of Object.entries(files)) {
    write(dir, rel, text);
    entries[rel] = { sha256: sha(text), bytes: Buffer.byteLength(text) };
  }
  write(
    dir,
    'manifest.json',
    JSON.stringify({
      format: 'couli-client-vectors-manifest/1',
      algorithm: 'sha256',
      files: entries,
    }),
  );
  return dir;
}

const lockedAll = (): Record<string, string> => ({
  'contracts/x.json': 'a'.repeat(64),
  'specs/client/login-vectors.json': sha(VECTORS['login-vectors.json']),
  'specs/client/order-vectors.json': sha(VECTORS['order-vectors.json']),
});

it('judgeClientVectors: matched, mismatched (also unknown paths), unlocked and disagreements', () => {
  const manifest = { 'a.json': 'h-a', 'b.json': 'h-b', 'c.json': 'h-c' };
  const r = judgeClientVectors(manifest, [
    {
      name: 'android',
      files: {
        'specs/client/a.json': 'h-a',
        'specs/client/b.json': 'x',
        'contracts/a.json': 'h-a',
      },
    },
    { name: 'ios', files: { 'specs/client/b.json': 'y', 'specs/client/z.json': 'h-z' } },
    { name: 'harmony', files: null },
  ]);
  expect(r.locks).toEqual([
    {
      name: 'android',
      matched: ['a.json'],
      mismatched: [{ path: 'b.json', locked: 'x', manifest: 'h-b' }],
      unlocked: ['c.json'],
    },
    {
      name: 'ios',
      matched: [],
      mismatched: [
        { path: 'b.json', locked: 'y', manifest: 'h-b' },
        { path: 'z.json', locked: 'h-z', manifest: null },
      ],
      unlocked: ['a.json', 'c.json'],
    },
    { name: 'harmony', matched: [], mismatched: [], unlocked: ['a.json', 'b.json', 'c.json'] },
  ]);
  expect(r.disagreements).toEqual([
    {
      path: 'b.json',
      locks: [
        { name: 'android', sha256: 'x' },
        { name: 'ios', sha256: 'y' },
      ],
    },
  ]);
});

it('--client-vectors: locks matching the manifest -> no client-vectors warning, exit 0', () => {
  const p = planning([{ at: T0, version: '0.1.0' }]);
  const f = platform([T0]);
  const dir = vectorsDir();
  const lock = (): string => lockFile(f.commits[0] ?? '', p.commits[0] ?? '', lockedAll());
  const r = run([
    '--planning',
    p.dir,
    '--platform',
    f.dir,
    '--client-vectors',
    dir,
    '--lock',
    `android=${lock()}`,
    '--lock',
    `ios=${lock()}`,
  ]);
  expect(r.code).toBe(0);
  expect(kinds(r)).toEqual([]);
  expect(r.report?.client_vectors).toMatchObject({
    dir,
    manifest: {
      'login-vectors.json': sha(VECTORS['login-vectors.json']),
      'order-vectors.json': sha(VECTORS['order-vectors.json']),
    },
    disagreements: [],
  });
  expect(r.report?.client_vectors?.locks.map((l) => [l.name, l.matched.length])).toEqual([
    ['android', 2],
    ['ios', 2],
  ]);
  expect(r.stderr).toContain('一致 2、不一致 0、未锁 0');
});

it('--client-vectors: a differing hash -> client-vectors-mismatch per lock and -disagree across locks', () => {
  const p = planning([{ at: T0, version: '0.1.0' }]);
  const f = platform([T0]);
  const dir = vectorsDir();
  const changed = { ...lockedAll(), 'specs/client/order-vectors.json': 'b'.repeat(64) };
  const r = run([
    '--planning',
    p.dir,
    '--platform',
    f.dir,
    '--client-vectors',
    dir,
    '--lock',
    `android=${lockFile(f.commits[0] ?? '', p.commits[0] ?? '', lockedAll())}`,
    '--lock',
    `harmony=${lockFile(f.commits[0] ?? '', p.commits[0] ?? '', changed)}`,
  ]);
  expect(r.code).toBe(1);
  expect(kinds(r)).toEqual(['harmony:client-vectors-mismatch', '*:client-vectors-disagree']);
  const [mismatch, disagree] = r.report?.warnings ?? [];
  expect(mismatch?.message).toContain('specs/client/order-vectors.json（锁 bbbbbbbbbbbb');
  expect(disagree?.message).toContain('specs/client/order-vectors.json 不一致');
  expect(disagree?.message).toContain('android=');
  expect(disagree?.message).toContain('harmony=bbbbbbbbbbbb');
  expect(r.report?.client_vectors?.locks[1]?.mismatched).toEqual([
    {
      path: 'order-vectors.json',
      locked: 'b'.repeat(64),
      manifest: sha(VECTORS['order-vectors.json']),
    },
  ]);
});

it('--client-vectors: a lock without specs/client keys -> client-vectors-unlocked only (warning, exit 1)', () => {
  const p = planning([{ at: T0, version: '0.1.0' }]);
  const f = platform([T0]);
  const dir = vectorsDir();
  const partial = { 'specs/client/login-vectors.json': sha(VECTORS['login-vectors.json']) };
  const r = run([
    '--planning',
    p.dir,
    '--platform',
    f.dir,
    '--client-vectors',
    dir,
    '--lock',
    `android=${lockFile(f.commits[0] ?? '', p.commits[0] ?? '', { 'contracts/x.json': 'a'.repeat(64) })}`,
    '--lock',
    `ios=${lockFile(f.commits[0] ?? '', p.commits[0] ?? '', partial)}`,
  ]);
  expect(r.code).toBe(1);
  expect(kinds(r)).toEqual(['android:client-vectors-unlocked', 'ios:client-vectors-unlocked']);
  expect(r.report?.warnings[0]?.message).toContain('2 个共享向量没锁');
  expect(r.report?.warnings[1]?.message).toContain('specs/client/order-vectors.json');
  expect(r.report?.warnings[1]?.message).not.toContain('login-vectors');
});

it('--client-vectors: without the option the files table is ignored and client_vectors is null', () => {
  const p = planning([{ at: T0, version: '0.1.0' }]);
  const f = platform([T0]);
  const changed = { 'specs/client/order-vectors.json': 'b'.repeat(64) };
  const r = run([
    '--planning',
    p.dir,
    '--platform',
    f.dir,
    '--lock',
    `android=${lockFile(f.commits[0] ?? '', p.commits[0] ?? '', changed)}`,
  ]);
  expect(r.code).toBe(0);
  expect(r.report?.client_vectors).toBeNull();
});

it('--client-vectors: a missing, broken or stale manifest is an input error (exit 2)', () => {
  const p = planning([{ at: T0, version: '0.1.0' }]);
  const f = platform([T0]);
  const stale = vectorsDir();
  write(stale, 'login-vectors.json', '{"login": 2}\n');
  const broken = vectorsDir();
  write(broken, 'manifest.json', '{"format": ');
  for (const dir of [join(SCRATCH, 'no-client-dir'), stale, broken]) {
    const r = run([
      '--planning',
      p.dir,
      '--platform',
      f.dir,
      '--client-vectors',
      dir,
      '--lock',
      `android=${lockFile(f.commits[0] ?? '', p.commits[0] ?? '', lockedAll())}`,
    ]);
    expect({ dir, code: r.code, out: r.report }).toEqual({ dir, code: 2, out: null });
    expect(r.stderr).toContain('TOKENS-LAG 输入错误');
  }
});

it('--client-vectors: lock keys like specs/client/toString are unknown paths -> mismatch, exit 1', () => {
  const judged = judgeClientVectors({ 'a.json': 'h-a' }, [
    {
      name: 'android',
      files: JSON.parse(
        '{"specs/client/toString": "x", "specs/client/__proto__": "y", "specs/client/a.json": "h-a"}',
      ) as Record<string, unknown>,
    },
  ]);
  expect(judged.locks[0]?.mismatched).toEqual([
    { path: '__proto__', locked: 'y', manifest: null },
    { path: 'toString', locked: 'x', manifest: null },
  ]);
  expect(judged.locks[0]?.matched).toEqual(['a.json']);
  const p = planning([{ at: T0, version: '0.1.0' }]);
  const f = platform([T0]);
  const dir = vectorsDir();
  const r = run([
    '--planning',
    p.dir,
    '--platform',
    f.dir,
    '--client-vectors',
    dir,
    '--lock',
    `android=${lockFile(f.commits[0] ?? '', p.commits[0] ?? '', {
      ...lockedAll(),
      'specs/client/toString': 'c'.repeat(64),
      'specs/client/constructor': 'd'.repeat(64),
    })}`,
  ]);
  expect(r.code).toBe(1);
  expect(kinds(r)).toEqual(['android:client-vectors-mismatch']);
  expect(r.report?.warnings[0]?.message).toContain('specs/client/toString（清单里没有）');
  expect(r.report?.warnings[0]?.message).toContain('specs/client/constructor（清单里没有）');
});
