// CT-05a: tools/ops/contracts-tag.ts, run locally by the orchestrator after a contract change has
// landed. It puts an annotated tag contracts-v0.9.<n> on the contract commit at <remote>/main (or
// on a given commit that is an ancestor of it) and pushes refs/tags/<name>; it does nothing when
// the target already carries such a tag or when contracts/ and specs/ have not changed since the
// newest one. The annotation carries the commit id and the sha256 of the manifest that
// tools/ci/contracts-artifact.ts produces for the same commit.
//
// The pure parts (parseTagN, nextTag, decide) first, then main against fixtures under
// <repo>/.tmp/contracts-tag-<pid>/: a bare repository as the remote and a clone of it.
// Git runs without the user's global or system configuration (GIT_CONFIG_GLOBAL=/dev/null).
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { buildManifest, collectFiles, sha256Hex, writeArtifact } from '../ci/contracts-artifact.ts';
import { TAG_PREFIX, decide, main, nextTag, parseTagN } from './contracts-tag.ts';
import type { Decision } from './contracts-tag.ts';

const REPO = resolve(import.meta.dirname, '../..');
const SCRATCH = join(REPO, '.tmp', `contracts-tag-${process.pid}`);

beforeAll(() => {
  vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null');
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
});

afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(SCRATCH, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------
// Pure parts
// ---------------------------------------------------------------------------------------------

it('[CT-05a#30] TAG_PREFIX is contracts-v0.9.', () => {
  expect(TAG_PREFIX).toBe('contracts-v0.9.');
});

it('[CT-05a#31] parseTagN accepts contracts-v0.9.<non-negative integer without leading zeros>', () => {
  expect(parseTagN('contracts-v0.9.0')).toBe(0);
  expect(parseTagN('contracts-v0.9.1')).toBe(1);
  expect(parseTagN('contracts-v0.9.10')).toBe(10);
  expect(parseTagN('contracts-v0.9.123')).toBe(123);
});

it('[CT-05a#32] parseTagN rejects every other shape', () => {
  for (const bad of [
    '',
    'contracts-v0.9.',
    'contracts-v0.9.01',
    'contracts-v0.9.00',
    'contracts-v1.0.0',
    'contracts-v0.8.1',
    'contracts-v0.9.-1',
    'contracts-v0.9.3-rc',
    'contracts-v0.9.3.1',
    'contracts-v0.9.1a',
    'contracts-v0.9. 1',
    'contracts-v0.9.1 ',
    ' contracts-v0.9.1',
    'refs/tags/contracts-v0.9.1',
    'xcontracts-v0.9.1',
    'contracts-v0.9.+1',
    'contracts-v0.9.1e3',
    'v0.9.1',
  ]) {
    expect(parseTagN(bad), JSON.stringify(bad)).toBeNull();
  }
});

it('[CT-05a#33] nextTag: contracts-v0.9.0 when there is no valid tag, otherwise the largest n + 1', () => {
  expect(nextTag([])).toBe('contracts-v0.9.0');
  expect(nextTag(['contracts-v0.9.0'])).toBe('contracts-v0.9.1');
  expect(nextTag(['contracts-v0.9.3', 'contracts-v0.9.1'])).toBe('contracts-v0.9.4');
});

it('[CT-05a#34] nextTag compares numerically (.10 is after .9)', () => {
  expect(nextTag(['contracts-v0.9.9', 'contracts-v0.9.10', 'contracts-v0.9.2'])).toBe(
    'contracts-v0.9.11',
  );
  expect(nextTag(['contracts-v0.9.10', 'contracts-v0.9.9'])).toBe('contracts-v0.9.11');
});

it('[CT-05a#35] nextTag ignores tags of any other shape', () => {
  expect(
    nextTag(['contracts-v0.9.01', 'contracts-v1.0.0', 'contracts-v0.9.3-rc', 'other', 'v9']),
  ).toBe('contracts-v0.9.0');
  expect(nextTag(['contracts-v0.9.2', 'contracts-v0.9.99-rc', 'contracts-v0.9.050'])).toBe(
    'contracts-v0.9.3',
  );
});

it('[CT-05a#36] decide: a valid tag at the target -> exists, with the largest n among them', () => {
  const d: Decision = decide({
    tagsAtTarget: ['contracts-v0.9.2', 'contracts-v0.9.10', 'contracts-v0.9.9', 'contracts-v2'],
    latest: { name: 'contracts-v0.9.10' },
    contractsChanged: true,
    existing: ['contracts-v0.9.2', 'contracts-v0.9.9', 'contracts-v0.9.10'],
  });
  expect(d).toEqual({ action: 'exists', tag: 'contracts-v0.9.10' });
  // exists wins even when nothing else would say so.
  expect(
    decide({
      tagsAtTarget: ['contracts-v0.9.0'],
      latest: null,
      contractsChanged: false,
      existing: ['contracts-v0.9.0'],
    }),
  ).toEqual({ action: 'exists', tag: 'contracts-v0.9.0' });
});

it('[CT-05a#37] decide: only invalid tags at the target do not count as exists', () => {
  expect(
    decide({
      tagsAtTarget: ['contracts-v0.9.01', 'contracts-v0.9.3-rc'],
      latest: null,
      contractsChanged: true,
      existing: ['contracts-v0.9.01', 'contracts-v0.9.3-rc'],
    }),
  ).toEqual({ action: 'create', tag: 'contracts-v0.9.0' });
});

it('[CT-05a#38] decide: no tag at the target, contracts unchanged since the latest tag -> unchanged', () => {
  expect(
    decide({
      tagsAtTarget: [],
      latest: { name: 'contracts-v0.9.4' },
      contractsChanged: false,
      existing: ['contracts-v0.9.3', 'contracts-v0.9.4'],
    }),
  ).toEqual({ action: 'unchanged', since: 'contracts-v0.9.4' });
});

it('[CT-05a#39] decide: contracts changed, or no tag at all -> create the next tag', () => {
  expect(
    decide({
      tagsAtTarget: [],
      latest: { name: 'contracts-v0.9.4' },
      contractsChanged: true,
      existing: ['contracts-v0.9.3', 'contracts-v0.9.4', 'contracts-v0.9.07'],
    }),
  ).toEqual({ action: 'create', tag: 'contracts-v0.9.5' });
  expect(decide({ tagsAtTarget: [], latest: null, contractsChanged: false, existing: [] })).toEqual(
    { action: 'create', tag: 'contracts-v0.9.0' },
  );
  expect(decide({ tagsAtTarget: [], latest: null, contractsChanged: true, existing: [] })).toEqual({
    action: 'create',
    tag: 'contracts-v0.9.0',
  });
});

// ---------------------------------------------------------------------------------------------
// Fixtures: a bare remote and a clone
// ---------------------------------------------------------------------------------------------

let fixtureCount = 0;

function git(cwd: string, args: string[]): string {
  const res = spawnSync(
    'git',
    [
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@example.invalid',
      '-c',
      'commit.gpgSign=false',
      '-c',
      'tag.gpgSign=false',
      ...args,
    ],
    {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    },
  );
  if (res.status !== 0) throw new Error(`git ${args.join(' ')}: ${res.stderr}`);
  return res.stdout.trim();
}

function put(root: string, rel: string, text: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}

type Fixture = { bare: string; clone: string };

/** A bare remote with one commit on main and a clone of it with a local identity. */
function fixture(): Fixture & { first: string } {
  const base = join(SCRATCH, `f-${String(++fixtureCount)}`);
  const bare = join(base, 'remote.git');
  const clone = join(base, 'clone');
  mkdirSync(bare, { recursive: true });
  git(bare, ['init', '-q', '--bare', '-b', 'main']);
  git(base, ['clone', '-q', bare, clone]);
  // main (the code under test) creates annotated tags in the clone: give it an identity there.
  git(clone, ['config', 'user.name', 'fixture']);
  git(clone, ['config', 'user.email', 'fixture@example.invalid']);
  git(clone, ['config', 'tag.gpgSign', 'false']);
  git(clone, ['config', 'commit.gpgSign', 'false']);
  git(clone, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  const first = landed(
    { bare, clone },
    {
      'contracts/openapi.yaml': 'openapi: 3.1.0\nversion: 1\n',
      'specs/commission-examples.csv': 'a,b\r\n1,2\r\n',
      'README.md': '# r\n',
    },
  );
  return { bare, clone, first };
}

/** Commits in the clone without pushing. */
function localCommit(f: Fixture, files: Record<string, string>): string {
  for (const [rel, text] of Object.entries(files)) put(f.clone, rel, text);
  git(f.clone, ['add', '-A']);
  git(f.clone, ['commit', '-q', '-m', `c${String(++fixtureCount)}`]);
  return git(f.clone, ['rev-parse', 'HEAD']);
}

/** Commits in the clone, pushes main and fetches, so origin/main is the new commit. */
function landed(f: Fixture, files: Record<string, string>): string {
  const c = localCommit(f, files);
  git(f.clone, ['push', '-q', 'origin', 'HEAD:refs/heads/main']);
  git(f.clone, ['fetch', '-q', 'origin']);
  expect(git(f.clone, ['rev-parse', 'refs/remotes/origin/main'])).toBe(c);
  return c;
}

function localTags(f: Fixture): string[] {
  return git(f.clone, ['tag', '-l']).split('\n').filter(Boolean).sort();
}

function remoteTags(f: Fixture): string[] {
  return git(f.bare, ['tag', '-l']).split('\n').filter(Boolean).sort();
}

function tagCommit(dir: string, tag: string): string {
  return git(dir, ['rev-parse', `refs/tags/${tag}^{commit}`]);
}

/** The sha256 of the manifest contracts-artifact builds for `commit`. */
function manifestSha(dir: string, commitId: string): string {
  return sha256Hex(new TextEncoder().encode(buildManifest(commitId, collectFiles(dir, commitId))));
}

type Ran = { code: number; output: string };

/** Runs main with --repo <clone> followed by the given arguments, capturing anything it prints. */
function run(f: Fixture, args: string[]): Ran {
  let output = '';
  const capture = (...parts: unknown[]): void => {
    output += `${parts.map(String).join(' ')}\n`;
  };
  const spies = [
    vi.spyOn(console, 'log').mockImplementation(capture),
    vi.spyOn(console, 'info').mockImplementation(capture),
    vi.spyOn(console, 'error').mockImplementation(capture),
    vi.spyOn(console, 'warn').mockImplementation(capture),
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }),
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }),
  ];
  try {
    const code = main(['--repo', f.clone, ...args]);
    return { code, output };
  } finally {
    for (const s of spies) s.mockRestore();
  }
}

// ---------------------------------------------------------------------------------------------
// CLI scenarios
// ---------------------------------------------------------------------------------------------

it('[CT-05a#40] first run: annotated tag contracts-v0.9.0 on origin/main, pushed to the remote', () => {
  const f = fixture();
  const r = run(f, []);
  expect(r.code, r.output).toBe(0);
  expect(localTags(f)).toEqual(['contracts-v0.9.0']);
  expect(remoteTags(f)).toEqual(['contracts-v0.9.0']);
  expect(tagCommit(f.clone, 'contracts-v0.9.0')).toBe(f.first);
  expect(tagCommit(f.bare, 'contracts-v0.9.0')).toBe(f.first);
  // Annotated, not lightweight.
  expect(git(f.clone, ['cat-file', '-t', 'refs/tags/contracts-v0.9.0'])).toBe('tag');
  expect(git(f.bare, ['cat-file', '-t', 'refs/tags/contracts-v0.9.0'])).toBe('tag');
});

it('[CT-05a#41] the annotation has commit: <40-hex id> and manifest-sha256: <sha256 of the artifact manifest>', () => {
  const f = fixture();
  expect(run(f, []).code).toBe(0);
  const body = git(f.clone, ['tag', '-l', '--format=%(contents)', 'contracts-v0.9.0']);
  const lines = body.split('\n').map((l) => l.trim());
  expect(lines).toContain(`commit: ${f.first}`);
  expect(f.first).toMatch(/^[0-9a-f]{40}$/);
  const shaLine = lines.find((l) => l.startsWith('manifest-sha256: '));
  expect(shaLine).toBeDefined();
  const sha = (shaLine ?? '').slice('manifest-sha256: '.length);
  expect(sha).toMatch(/^[0-9a-f]{64}$/);
  // Same generation function as the artifact: buildManifest over collectFiles ...
  expect(sha).toBe(manifestSha(f.clone, f.first));
  // ... and the manifest.json the artifact writer puts on disk for the same commit.
  const out = join(SCRATCH, `artifact-${String(++fixtureCount)}`);
  writeArtifact(f.clone, f.first, out);
  expect(sha).toBe(sha256Hex(readFileSync(join(out, 'manifest.json'))));
});

it('[CT-05a#42] a change under contracts/ after the latest tag -> the next number', () => {
  const f = fixture();
  expect(run(f, []).code).toBe(0);
  const c2 = landed(f, { 'contracts/openapi.yaml': 'openapi: 3.1.0\nversion: 2\n' });
  const r = run(f, []);
  expect(r.code, r.output).toBe(0);
  expect(localTags(f)).toEqual(['contracts-v0.9.0', 'contracts-v0.9.1']);
  expect(remoteTags(f)).toEqual(['contracts-v0.9.0', 'contracts-v0.9.1']);
  expect(tagCommit(f.bare, 'contracts-v0.9.1')).toBe(c2);
  const body = git(f.clone, ['tag', '-l', '--format=%(contents)', 'contracts-v0.9.1']);
  expect(body).toContain(`commit: ${c2}`);
  expect(body).toContain(`manifest-sha256: ${manifestSha(f.clone, c2)}`);
});

it('[CT-05a#43] a change under specs/ only also counts as a contract change', () => {
  const f = fixture();
  expect(run(f, []).code).toBe(0);
  const c2 = landed(f, { 'specs/commission-examples.csv': 'a,b\r\n1,3\r\n' });
  expect(run(f, []).code).toBe(0);
  expect(remoteTags(f)).toEqual(['contracts-v0.9.0', 'contracts-v0.9.1']);
  expect(tagCommit(f.bare, 'contracts-v0.9.1')).toBe(c2);
});

it('[CT-05a#44] only files outside contracts/ and specs/ changed -> unchanged, exit 0, no tag made or pushed', () => {
  const f = fixture();
  expect(run(f, []).code).toBe(0);
  landed(f, { 'README.md': '# changed\n', 'contractsx/a.yaml': 'x\n', 'docs/specs/a.md': 'x\n' });
  const r = run(f, []);
  expect(r.code, r.output).toBe(0);
  expect(localTags(f)).toEqual(['contracts-v0.9.0']);
  expect(remoteTags(f)).toEqual(['contracts-v0.9.0']);
});

it('[CT-05a#45] the target already carries a contracts tag -> exists, exit 0, no second tag', () => {
  const f = fixture();
  expect(run(f, []).code).toBe(0);
  const r = run(f, []);
  expect(r.code, r.output).toBe(0);
  expect(localTags(f)).toEqual(['contracts-v0.9.0']);
  expect(remoteTags(f)).toEqual(['contracts-v0.9.0']);
  expect(git(f.clone, ['tag', '--points-at', f.first])).toBe('contracts-v0.9.0');
});

it('[CT-05a#46] the default target is origin/main, not the local HEAD', () => {
  const f = fixture();
  const ahead = localCommit(f, { 'contracts/openapi.yaml': 'openapi: 3.1.0\nversion: local\n' });
  expect(run(f, []).code).toBe(0);
  expect(tagCommit(f.clone, 'contracts-v0.9.0')).toBe(f.first);
  expect(git(f.clone, ['tag', '--points-at', ahead])).toBe('');
});

it('[CT-05a#47] --commit that is an ancestor of origin/main is tagged; a later run tags origin/main next', () => {
  const f = fixture();
  const c2 = landed(f, { 'contracts/openapi.yaml': 'openapi: 3.1.0\nversion: 2\n' });
  expect(run(f, ['--commit', f.first]).code).toBe(0);
  expect(remoteTags(f)).toEqual(['contracts-v0.9.0']);
  expect(tagCommit(f.bare, 'contracts-v0.9.0')).toBe(f.first);
  expect(run(f, []).code).toBe(0);
  expect(remoteTags(f)).toEqual(['contracts-v0.9.0', 'contracts-v0.9.1']);
  expect(tagCommit(f.bare, 'contracts-v0.9.1')).toBe(c2);
});

it('[CT-05a#48] --commit that is not an ancestor of origin/main is refused with exit 1 and no tag', () => {
  const f = fixture();
  const ahead = localCommit(f, { 'contracts/openapi.yaml': 'openapi: 3.1.0\nversion: local\n' });
  const r = run(f, ['--commit', ahead]);
  expect(r.code, r.output).toBe(1);
  expect(localTags(f)).toEqual([]);
  expect(remoteTags(f)).toEqual([]);
  // A side branch off an older commit is not an ancestor either.
  git(f.clone, ['checkout', '-q', '-b', 'side', f.first]);
  const side = localCommit(f, { 'specs/side.csv': 'x\n' });
  expect(run(f, ['--commit', side]).code).toBe(1);
  expect(localTags(f)).toEqual([]);
  expect(remoteTags(f)).toEqual([]);
});

it('[CT-05a#49] --commit naming no commit fails without a tag', () => {
  const f = fixture();
  const r = run(f, ['--commit', 'f'.repeat(40)]);
  expect(r.code).not.toBe(0);
  expect(localTags(f)).toEqual([]);
  expect(remoteTags(f)).toEqual([]);
});

it('[CT-05a#50] --dry-run prints the decision but creates and pushes nothing', () => {
  const f = fixture();
  const r = run(f, ['--dry-run']);
  expect(r.code, r.output).toBe(0);
  expect(r.output).toContain('contracts-v0.9.0');
  expect(localTags(f)).toEqual([]);
  expect(remoteTags(f)).toEqual([]);
  // Also when a next tag would follow an existing one.
  expect(run(f, []).code).toBe(0);
  landed(f, { 'contracts/openapi.yaml': 'openapi: 3.1.0\nversion: 2\n' });
  const r2 = run(f, ['--dry-run']);
  expect(r2.code, r2.output).toBe(0);
  expect(r2.output).toContain('contracts-v0.9.1');
  expect(localTags(f)).toEqual(['contracts-v0.9.0']);
  expect(remoteTags(f)).toEqual(['contracts-v0.9.0']);
});

it('[CT-05a#51] a push that fails (remote path does not exist) exits non-zero and leaves no local tag', () => {
  const f = fixture();
  const missing = join(SCRATCH, `missing-${String(++fixtureCount)}.git`);
  git(f.clone, ['remote', 'add', 'broken', missing]);
  // broken/main exists locally, so the failure can only come from the push.
  git(f.clone, ['update-ref', 'refs/remotes/broken/main', f.first]);
  const r = run(f, ['--remote', 'broken']);
  expect(r.code, r.output).not.toBe(0);
  expect(localTags(f)).toEqual([]);
  expect(remoteTags(f)).toEqual([]);
});

it('[CT-05a#52] a push rejected by the remote hook exits non-zero, keeps no local tag and does not retry under another name', () => {
  const f = fixture();
  const hook = join(f.bare, 'hooks', 'pre-receive');
  mkdirSync(dirname(hook), { recursive: true });
  writeFileSync(hook, '#!/bin/sh\necho "tags are rejected here" >&2\nexit 1\n');
  chmodSync(hook, 0o755);
  const r = run(f, []);
  expect(r.code, r.output).not.toBe(0);
  expect(localTags(f)).toEqual([]);
  expect(remoteTags(f)).toEqual([]);
});

it('[CT-05a#53] tags of other shapes do not affect the numbering, even at the target', () => {
  const f = fixture();
  for (const t of ['contracts-v0.9.01', 'contracts-v1.0.0', 'contracts-v0.9.3-rc']) {
    git(f.clone, ['tag', '-a', '-m', t, t, f.first]);
  }
  const c2 = landed(f, { 'contracts/openapi.yaml': 'openapi: 3.1.0\nversion: 2\n' });
  git(f.clone, ['tag', '-a', '-m', 'rc', 'contracts-v0.9.7-rc', c2]);
  const r = run(f, []);
  expect(r.code, r.output).toBe(0);
  expect(remoteTags(f)).toEqual(['contracts-v0.9.0']);
  expect(tagCommit(f.bare, 'contracts-v0.9.0')).toBe(c2);
});

it('[CT-05a#54] the latest tag is the numerically largest: unchanged since .10 even though .9 differs', () => {
  const f = fixture();
  const c2 = landed(f, { 'contracts/openapi.yaml': 'openapi: 3.1.0\nversion: 2\n' });
  landed(f, { 'README.md': '# only docs\n' });
  git(f.clone, ['tag', '-a', '-m', 'nine', 'contracts-v0.9.9', f.first]);
  git(f.clone, ['tag', '-a', '-m', 'ten', 'contracts-v0.9.10', c2]);
  const r = run(f, []);
  expect(r.code, r.output).toBe(0);
  expect(localTags(f)).toEqual(['contracts-v0.9.10', 'contracts-v0.9.9']);
  expect(remoteTags(f)).toEqual([]);
});

it('[CT-05a#55] after .9 and .10 a contract change gets .11', () => {
  const f = fixture();
  const c2 = landed(f, { 'contracts/openapi.yaml': 'openapi: 3.1.0\nversion: 2\n' });
  git(f.clone, ['tag', '-a', '-m', 'nine', 'contracts-v0.9.9', f.first]);
  git(f.clone, ['tag', '-a', '-m', 'ten', 'contracts-v0.9.10', c2]);
  const c3 = landed(f, { 'contracts/openapi.yaml': 'openapi: 3.1.0\nversion: 3\n' });
  const r = run(f, []);
  expect(r.code, r.output).toBe(0);
  expect(remoteTags(f)).toEqual(['contracts-v0.9.11']);
  expect(tagCommit(f.bare, 'contracts-v0.9.11')).toBe(c3);
});

it('[CT-05a#56] the repository can also be given through opts.repo', () => {
  const f = fixture();
  const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  let code: number;
  try {
    code = main([], { repo: f.clone });
  } finally {
    spy.mockRestore();
    out.mockRestore();
  }
  expect(code).toBe(0);
  expect(remoteTags(f)).toEqual(['contracts-v0.9.0']);
});

it('[CT-05a#57] invalid arguments exit 2 and create nothing', () => {
  const f = fixture();
  expect(run(f, ['--bogus']).code).toBe(2);
  expect(run(f, ['--commit']).code).toBe(2);
  expect(run(f, ['--remote']).code).toBe(2);
  expect(run(f, ['extra-positional']).code).toBe(2);
  expect(localTags(f)).toEqual([]);
  expect(remoteTags(f)).toEqual([]);
});
