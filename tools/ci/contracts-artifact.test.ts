// CT-05a: tools/ci/contracts-artifact.ts, the read-only contracts distribution artifact. For one
// commit it lists every tracked file under contracts/ and specs/ of that commit, reads each one
// with `git show <commit>:<path>` (never the working tree) and writes manifest.json
// ({commit, files: {path: sha256}}, keys sorted, 2-space indent, trailing newline, byte-identical
// across runs) plus snapshot/<path> with the raw bytes.
//
// The pure parts (sha256Hex, buildManifest) first, then collectFiles / writeArtifact / main
// against fixture git repositories under <repo>/.tmp/contracts-artifact-<pid>/, removed afterwards.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import {
  ARTIFACT_ROOTS,
  InputError,
  buildManifest,
  collectFiles,
  main,
  sha256Hex,
  writeArtifact,
} from './contracts-artifact.ts';

const REPO = resolve(import.meta.dirname, '../..');
const SCRATCH = join(REPO, '.tmp', `contracts-artifact-${process.pid}`);
const SCRIPT = join(REPO, 'tools/ci/contracts-artifact.ts');
const SHA_A = 'a'.repeat(40);
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

afterAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------
// Fixture repositories
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
      'core.hooksPath=/dev/null',
      '-c',
      'commit.gpgSign=false',
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

/** The raw bytes of `<commit>:<path>`, read with git directly. */
function blob(dir: string, commitId: string, path: string): Buffer {
  const res = spawnSync('git', ['cat-file', 'blob', `${commitId}:${path}`], {
    cwd: dir,
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  });
  if (res.status !== 0) throw new Error(`git cat-file ${path}: ${String(res.stderr)}`);
  return res.stdout;
}

function put(root: string, rel: string, content: string | Uint8Array): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content);
}

function newRepo(): string {
  const dir = join(SCRATCH, `repo-${String(++fixtureCount)}`);
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'core.autocrlf', 'false']);
  return dir;
}

/** Writes (or, for null, deletes) the files and commits them; returns the commit id. */
function commit(dir: string, files: Record<string, string | Uint8Array | null>): string {
  for (const [rel, content] of Object.entries(files)) {
    if (content === null) rmSync(join(dir, rel));
    else put(dir, rel, content);
  }
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '--allow-empty', '-m', `c${String(fixtureCount)}`]);
  return git(dir, ['rev-parse', 'HEAD']);
}

function outDir(): string {
  return join(SCRATCH, `out-${String(++fixtureCount)}`);
}

/** Every file under `root`, as sorted relative paths with forward slashes. */
function listTree(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else found.push(relative(root, full).split('\\').join('/'));
    }
  };
  walk(root);
  return found.sort();
}

const BINARY = new Uint8Array([0x00, 0xff, 0xfe, 0x80, 0x0d, 0x0a, 0xc3, 0x28, 0x00, 0x7f]);
const CRLF = 'line one\r\nline two\r\n';

/** A repository with files inside and outside contracts/ and specs/ at one commit. */
function standardRepo(): { dir: string; commit: string } {
  const dir = newRepo();
  const c = commit(dir, {
    'contracts/openapi.yaml': 'openapi: 3.1.0\n',
    'contracts/errors/codes.yaml': 'codes: []\n',
    'contracts/blob.bin': BINARY,
    'specs/commission-examples.csv': CRLF,
    'specs/deep/nested/x.json': '{"a":1}\n',
    'README.md': '# readme\n',
    'contractsx/not-me.yaml': 'x\n',
    'docs/contracts/not-me.yaml': 'x\n',
    'specsy.txt': 'x\n',
  });
  return { dir, commit: c };
}

const EXPECTED_PATHS = [
  'contracts/blob.bin',
  'contracts/errors/codes.yaml',
  'contracts/openapi.yaml',
  'specs/commission-examples.csv',
  'specs/deep/nested/x.json',
];

// ---------------------------------------------------------------------------------------------
// Pure parts
// ---------------------------------------------------------------------------------------------

it('[CT-05a#1] ARTIFACT_ROOTS is exactly contracts and specs', () => {
  expect([...ARTIFACT_ROOTS]).toEqual(['contracts', 'specs']);
});

it('[CT-05a#2] sha256Hex gives the lowercase hex sha256 of the bytes', () => {
  expect(sha256Hex(new Uint8Array())).toBe(
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  );
  expect(sha256Hex(enc('abc'))).toBe(
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
  expect(sha256Hex(BINARY)).toBe(hex(BINARY));
});

it('[CT-05a#3] buildManifest: commit, files keyed by path in sorted order, 2-space JSON and a trailing newline', () => {
  const files = [
    { path: 'specs/b.csv', bytes: enc('b') },
    { path: 'contracts/z.yaml', bytes: enc('z') },
    { path: 'contracts/a.yaml', bytes: enc('a') },
    { path: 'contracts/A.yaml', bytes: enc('A') },
  ];
  const text = buildManifest(SHA_A, files);
  const expected = {
    commit: SHA_A,
    files: {
      'contracts/A.yaml': hex(enc('A')),
      'contracts/a.yaml': hex(enc('a')),
      'contracts/z.yaml': hex(enc('z')),
      'specs/b.csv': hex(enc('b')),
    },
  };
  expect(text).toBe(`${JSON.stringify(expected, null, 2)}\n`);
  // Key order in the text itself is sorted (JSON.parse would hide an unsorted text).
  expect(Object.keys((JSON.parse(text) as { files: object }).files)).toEqual([
    'contracts/A.yaml',
    'contracts/a.yaml',
    'contracts/z.yaml',
    'specs/b.csv',
  ]);
  expect(Object.keys(JSON.parse(text) as object)).toEqual(['commit', 'files']);
});

it('[CT-05a#4] buildManifest does not depend on the input order and an empty list gives files {}', () => {
  const files = [
    { path: 'contracts/a.yaml', bytes: enc('1') },
    { path: 'specs/x.csv', bytes: enc('2') },
    { path: 'contracts/b/c.yaml', bytes: enc('3') },
  ];
  expect(buildManifest(SHA_A, [...files].reverse())).toBe(buildManifest(SHA_A, files));
  expect(buildManifest(SHA_A, [])).toBe(
    `${JSON.stringify({ commit: SHA_A, files: {} }, null, 2)}\n`,
  );
});

it('[CT-05a#5] buildManifest rejects a commit that is not 40 lowercase hex characters', () => {
  const one = [{ path: 'contracts/a.yaml', bytes: enc('a') }];
  for (const bad of ['', 'a'.repeat(39), 'a'.repeat(41), 'A'.repeat(40), 'g'.repeat(40), 'HEAD']) {
    expect(() => buildManifest(bad, one), `commit ${JSON.stringify(bad)}`).toThrow(InputError);
  }
});

it('[CT-05a#6] buildManifest rejects duplicate paths and paths outside contracts/ and specs/', () => {
  expect(() =>
    buildManifest(SHA_A, [
      { path: 'contracts/a.yaml', bytes: enc('a') },
      { path: 'contracts/a.yaml', bytes: enc('b') },
    ]),
  ).toThrow(InputError);
  for (const bad of ['README.md', 'contractsx/a.yaml', 'specs', 'contracts', 'docs/contracts/a']) {
    expect(() => buildManifest(SHA_A, [{ path: bad, bytes: enc('a') }]), `path ${bad}`).toThrow(
      InputError,
    );
  }
  expect(new InputError('x')).toBeInstanceOf(Error);
});

// ---------------------------------------------------------------------------------------------
// collectFiles
// ---------------------------------------------------------------------------------------------

it('[CT-05a#7] collectFiles returns exactly the tracked contracts/ and specs/ files of the commit, sorted, with their committed bytes', () => {
  const { dir, commit: c } = standardRepo();
  const files = collectFiles(dir, c);
  expect(files.map((f) => f.path)).toEqual(EXPECTED_PATHS);
  const byPath = new Map(files.map((f) => [f.path, f.bytes]));
  expect(Buffer.from(byPath.get('contracts/openapi.yaml') ?? [])).toEqual(
    Buffer.from('openapi: 3.1.0\n'),
  );
  expect(Buffer.from(byPath.get('specs/deep/nested/x.json') ?? [])).toEqual(
    Buffer.from('{"a":1}\n'),
  );
});

it('[CT-05a#8] collectFiles keeps binary, non-UTF-8 and CRLF bytes exactly', () => {
  const { dir, commit: c } = standardRepo();
  const byPath = new Map(collectFiles(dir, c).map((f) => [f.path, f.bytes]));
  expect(Buffer.from(byPath.get('contracts/blob.bin') ?? [])).toEqual(Buffer.from(BINARY));
  expect(Buffer.from(byPath.get('specs/commission-examples.csv') ?? [])).toEqual(Buffer.from(CRLF));
});

it('[CT-05a#9] collectFiles ignores the working tree: dirty edits, staged edits, deletions and untracked files', () => {
  const { dir, commit: c } = standardRepo();
  const before = collectFiles(dir, c);
  // Dirty edit, staged edit, deletion in the working tree, untracked files in both roots.
  put(dir, 'contracts/openapi.yaml', 'openapi: DIRTY\n');
  put(dir, 'specs/deep/nested/x.json', '{"staged":true}\n');
  git(dir, ['add', 'specs/deep/nested/x.json']);
  rmSync(join(dir, 'contracts/errors/codes.yaml'));
  put(dir, 'contracts/untracked.yaml', 'new\n');
  put(dir, 'specs/untracked.csv', 'new\n');
  const after = collectFiles(dir, c);
  expect(after.map((f) => f.path)).toEqual(EXPECTED_PATHS);
  expect(after.map((f) => Buffer.from(f.bytes))).toEqual(before.map((f) => Buffer.from(f.bytes)));
});

it('[CT-05a#10] collectFiles reads the named commit, not HEAD', () => {
  const dir = newRepo();
  const c1 = commit(dir, { 'contracts/a.yaml': 'v1\n', 'specs/s.csv': 's\n' });
  const c2 = commit(dir, {
    'contracts/a.yaml': 'v2\n',
    'contracts/b.yaml': 'added\n',
    'specs/s.csv': null,
  });
  const at1 = collectFiles(dir, c1);
  expect(at1.map((f) => f.path)).toEqual(['contracts/a.yaml', 'specs/s.csv']);
  expect(Buffer.from(at1[0]?.bytes ?? [])).toEqual(Buffer.from('v1\n'));
  const at2 = collectFiles(dir, c2);
  expect(at2.map((f) => f.path)).toEqual(['contracts/a.yaml', 'contracts/b.yaml']);
  expect(Buffer.from(at2[0]?.bytes ?? [])).toEqual(Buffer.from('v2\n'));
});

it('[CT-05a#11] collectFiles of a commit without contracts/ or specs/ is empty', () => {
  const dir = newRepo();
  const c = commit(dir, { 'README.md': 'x\n' });
  expect(collectFiles(dir, c)).toEqual([]);
});

it('[CT-05a#12] collectFiles throws InputError for a commit that does not exist', () => {
  const { dir } = standardRepo();
  expect(() => collectFiles(dir, 'f'.repeat(40))).toThrow(InputError);
});

it('[CT-05a#13] collectFiles on this repository lists the same contracts/ and specs/ files as git ls-tree at HEAD', () => {
  const head = git(REPO, ['rev-parse', 'HEAD']);
  const tracked = git(REPO, [
    'ls-tree',
    '-r',
    '--name-only',
    '-z',
    head,
    '--',
    'contracts',
    'specs',
  ])
    .split('\0')
    .filter(Boolean)
    .sort();
  const files = collectFiles(REPO, head);
  expect(files.map((f) => f.path)).toEqual(tracked);
  expect(tracked).toContain('contracts/openapi.yaml');
});

// ---------------------------------------------------------------------------------------------
// writeArtifact
// ---------------------------------------------------------------------------------------------

it('[CT-05a#14] writeArtifact writes manifest.json and snapshot/<path> with the original bytes, and nothing else', () => {
  const { dir, commit: c } = standardRepo();
  const out = outDir();
  const res = writeArtifact(dir, c, out);
  expect(res.count).toBe(EXPECTED_PATHS.length);
  const manifestText = readFileSync(join(out, 'manifest.json'), 'utf8');
  expect(res.manifestText).toBe(manifestText);
  expect(manifestText).toBe(buildManifest(c, collectFiles(dir, c)));
  expect(listTree(out)).toEqual(['manifest.json', ...EXPECTED_PATHS.map((p) => `snapshot/${p}`)]);
  const manifest = JSON.parse(manifestText) as { commit: string; files: Record<string, string> };
  expect(manifest.commit).toBe(c);
  expect(Object.keys(manifest.files)).toEqual(EXPECTED_PATHS);
  for (const p of EXPECTED_PATHS) {
    const bytes = readFileSync(join(out, 'snapshot', p));
    expect(bytes, p).toEqual(blob(dir, c, p));
    expect(manifest.files[p], p).toBe(hex(bytes));
  }
  expect(readFileSync(join(out, 'snapshot/contracts/blob.bin'))).toEqual(Buffer.from(BINARY));
  expect(readFileSync(join(out, 'snapshot/specs/commission-examples.csv'))).toEqual(
    Buffer.from(CRLF),
  );
});

it('[CT-05a#15] two runs for the same commit give byte-identical manifests and snapshots', () => {
  const { dir, commit: c } = standardRepo();
  const out1 = outDir();
  const out2 = outDir();
  const r1 = writeArtifact(dir, c, out1);
  // A dirty working tree in between changes nothing.
  put(dir, 'contracts/openapi.yaml', 'openapi: DIRTY\n');
  put(dir, 'specs/extra.csv', 'untracked\n');
  const r2 = writeArtifact(dir, c, out2);
  expect(r2.manifestText).toBe(r1.manifestText);
  expect(readFileSync(join(out2, 'manifest.json'))).toEqual(
    readFileSync(join(out1, 'manifest.json')),
  );
  const tree1 = listTree(out1);
  expect(listTree(out2)).toEqual(tree1);
  for (const rel of tree1) {
    expect(readFileSync(join(out2, rel)), rel).toEqual(readFileSync(join(out1, rel)));
  }
});

it('[CT-05a#16] writeArtifact accepts an existing empty directory', () => {
  const { dir, commit: c } = standardRepo();
  const out = outDir();
  mkdirSync(out, { recursive: true });
  const res = writeArtifact(dir, c, out);
  expect(res.count).toBe(EXPECTED_PATHS.length);
  expect(existsSync(join(out, 'manifest.json'))).toBe(true);
});

it('[CT-05a#17] writeArtifact refuses a non-empty output directory and leaves it untouched', () => {
  const { dir, commit: c } = standardRepo();
  const out = outDir();
  put(out, 'keep.txt', 'mine\n');
  expect(() => writeArtifact(dir, c, out)).toThrow(InputError);
  expect(listTree(out)).toEqual(['keep.txt']);
  expect(readFileSync(join(out, 'keep.txt'), 'utf8')).toBe('mine\n');
});

it('[CT-05a#18] writeArtifact throws InputError for a commit that does not exist', () => {
  const { dir } = standardRepo();
  expect(() => writeArtifact(dir, 'f'.repeat(40), outDir())).toThrow(InputError);
});

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

it('[CT-05a#19] main: --commit --out --repo writes the artifact and returns 0', () => {
  const { dir, commit: c } = standardRepo();
  const out = outDir();
  expect(main(['--commit', c, '--out', out, '--repo', dir])).toBe(0);
  expect(readFileSync(join(out, 'manifest.json'), 'utf8')).toBe(
    buildManifest(c, collectFiles(dir, c)),
  );
  expect(listTree(join(out, 'snapshot'))).toEqual(EXPECTED_PATHS);
});

it('[CT-05a#20] main returns 1 for a commit that does not exist and for a non-empty output directory', () => {
  const { dir, commit: c } = standardRepo();
  expect(main(['--commit', 'f'.repeat(40), '--out', outDir(), '--repo', dir])).toBe(1);
  const out = outDir();
  put(out, 'keep.txt', 'mine\n');
  expect(main(['--commit', c, '--out', out, '--repo', dir])).toBe(1);
  expect(listTree(out)).toEqual(['keep.txt']);
});

it('[CT-05a#21] main returns 2 when --commit or --out (or its value) is missing', () => {
  const { dir, commit: c } = standardRepo();
  const out = outDir();
  expect(main(['--out', out, '--repo', dir])).toBe(2);
  expect(main(['--commit', c, '--repo', dir])).toBe(2);
  expect(main(['--commit', c, '--out'])).toBe(2);
  expect(main(['--out', out, '--commit'])).toBe(2);
  expect(main([])).toBe(2);
  expect(existsSync(out)).toBe(false);
});

it('[CT-05a#22] run as a script, the exit code is what main returns', () => {
  const { dir, commit: c } = standardRepo();
  const out = outDir();
  const ok = spawnSync(process.execPath, [SCRIPT, '--commit', c, '--out', out, '--repo', dir], {
    encoding: 'utf8',
  });
  expect(ok.status, ok.stderr).toBe(0);
  expect(readFileSync(join(out, 'manifest.json'), 'utf8')).toBe(
    buildManifest(c, collectFiles(dir, c)),
  );
  const missing = spawnSync(process.execPath, [SCRIPT, '--repo', dir], { encoding: 'utf8' });
  expect(missing.status).toBe(2);
  const nonEmpty = spawnSync(
    process.execPath,
    [SCRIPT, '--commit', c, '--out', out, '--repo', dir],
    { encoding: 'utf8' },
  );
  expect(nonEmpty.status).toBe(1);
});
