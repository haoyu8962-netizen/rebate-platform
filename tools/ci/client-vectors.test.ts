// client-vectors.ts against fixture directories under .tmp/client-vectors-<pid>/, removed afterwards.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import {
  InputError,
  MANIFEST_FORMAT,
  compare,
  isValidRelPath,
  main,
  parseManifest,
  renderManifest,
  scanDir,
  verifiedManifest,
} from './client-vectors.ts';

const REPO = resolve(import.meta.dirname, '../..');
const SCRATCH = join(REPO, '.tmp', `client-vectors-${process.pid}`);

afterAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
});

let count = 0;

function write(root: string, rel: string, data: string | Buffer): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), data);
}

/** A vector directory with the given files and, unless `manifest` is false, a written manifest. */
function fixture(files: Record<string, string | Buffer>, manifest = true): string {
  const dir = join(SCRATCH, `dir-${String(++count)}`);
  mkdirSync(dir, { recursive: true });
  for (const [rel, data] of Object.entries(files)) write(dir, rel, data);
  if (manifest) expect(run(['--write', '--dir', dir]).code).toBe(0);
  return dir;
}

type Run = { code: number; out: string; err: string };

function run(args: string[], cwd = SCRATCH): Run {
  let out = '';
  let err = '';
  const code = main(args, { out: (s) => (out += s), err: (s) => (err += s) }, cwd);
  return { code, out, err };
}

const hex = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

const BASE = {
  'login-vectors.json': '{"version": 1}\n',
  'order-vectors.json': '{\n  "a": [1,2]\n}\n',
  'sub/visual-vectors.json': Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d]),
  'README.md': '# not a vector\n',
};

it('--write lists every file except the root manifest.json and README.md, by raw bytes', () => {
  const dir = fixture(BASE);
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as unknown;
  expect(manifest).toEqual({
    format: MANIFEST_FORMAT,
    algorithm: 'sha256',
    files: {
      'login-vectors.json': { sha256: hex(BASE['login-vectors.json']), bytes: 15 },
      'order-vectors.json': { sha256: hex(BASE['order-vectors.json']), bytes: 17 },
      'sub/visual-vectors.json': { sha256: hex(BASE['sub/visual-vectors.json']), bytes: 5 },
    },
  });
  expect(Object.keys((manifest as { files: object }).files)).toEqual([
    'login-vectors.json',
    'order-vectors.json',
    'sub/visual-vectors.json',
  ]);
  // A second --write is byte-identical (stable output).
  const first = readFileSync(join(dir, 'manifest.json'));
  expect(run(['--write', '--dir', dir]).code).toBe(0);
  expect(readFileSync(join(dir, 'manifest.json')).equals(first)).toBe(true);
});

it('consistent manifest and files -> --check exit 0, PASS', () => {
  const dir = fixture(BASE);
  const r = run(['--check', '--dir', dir]);
  expect(r).toMatchObject({ code: 0, err: '' });
  expect(r.out).toContain('PASS client-vectors: 3 个文件');
});

it('--dir defaults to specs/client under the current directory', () => {
  const root = join(SCRATCH, `root-${String(++count)}`);
  write(root, 'specs/client/a-vectors.json', '{}\n');
  expect(run(['--write'], root).code).toBe(0);
  expect(run(['--check'], root).code).toBe(0);
});

it('a changed file -> exit 1 with the sha256 problem (and bytes when the size changed)', () => {
  const sameSize = fixture(BASE);
  write(sameSize, 'login-vectors.json', '{"version": 2}\n');
  const a = run(['--check', '--dir', sameSize]);
  expect(a.code).toBe(1);
  expect(a.out).toContain('FAIL client-vectors');
  expect(a.err).toContain('login-vectors.json: 清单 sha256');
  expect(a.err).not.toContain('字节');
  const longer = fixture(BASE);
  // Reformatting alone (same JSON value) is a change: the hash is over raw bytes.
  write(longer, 'order-vectors.json', '{\n  "a": [1, 2]\n}\n');
  const b = run(['--check', '--dir', longer]);
  expect(b.code).toBe(1);
  expect(b.err).toContain('order-vectors.json: 清单 sha256');
  expect(b.err).toContain('order-vectors.json: 清单 17 字节，文件实为 18 字节');
});

it('an extra file not in the manifest -> exit 1 (unlisted), also inside a subdirectory', () => {
  const dir = fixture(BASE);
  write(dir, 'new-vectors.json', '{}\n');
  write(dir, 'sub/deeper/x.json', '{}\n');
  const r = run(['--check', '--dir', dir]);
  expect(r.code).toBe(1);
  expect(r.err).toContain('new-vectors.json: 目录里有，清单里没有');
  expect(r.err).toContain('sub/deeper/x.json: 目录里有，清单里没有');
});

it('a file listed in the manifest but missing -> exit 1 (missing-file)', () => {
  const dir = fixture(BASE);
  rmSync(join(dir, 'order-vectors.json'));
  const r = run(['--check', '--dir', dir]);
  expect(r.code).toBe(1);
  expect(r.err).toContain('order-vectors.json: 清单里有，目录里没有该文件');
});

it('a broken or missing manifest is an input error (exit 2)', () => {
  const good = JSON.parse(renderManifest({ 'a.json': { sha256: hex('x'), bytes: 1 } })) as Record<
    string,
    unknown
  >;
  const bad: string[] = [
    '{"format": ',
    '[]',
    JSON.stringify({ ...good, extra: 1 }),
    JSON.stringify({ ...good, format: 'other/1' }),
    JSON.stringify({ ...good, algorithm: 'sha1' }),
    JSON.stringify({ ...good, files: [] }),
    JSON.stringify({ ...good, files: { 'a.json': { sha256: 'ABC', bytes: 1 } } }),
    JSON.stringify({ ...good, files: { 'a.json': { sha256: hex('x'), bytes: -1 } } }),
    JSON.stringify({ ...good, files: { 'a.json': { sha256: hex('x'), bytes: 1, n: 2 } } }),
    JSON.stringify({ ...good, files: { '../a.json': { sha256: hex('x'), bytes: 1 } } }),
    JSON.stringify({ ...good, files: { 'manifest.json': { sha256: hex('x'), bytes: 1 } } }),
  ];
  for (const text of bad) {
    const dir = fixture({ 'a.json': 'x' }, false);
    write(dir, 'manifest.json', text);
    const r = run(['--check', '--dir', dir]);
    expect({ text, code: r.code }).toEqual({ text, code: 2 });
    expect(r.err).toContain('CLIENT-VECTORS 输入错误');
  }
  const none = fixture({ 'a.json': 'x' }, false);
  expect(run(['--check', '--dir', none]).code).toBe(2);
});

it('bad arguments, a missing directory or a symlink in it are input errors (exit 2)', () => {
  const dir = fixture(BASE);
  for (const args of [
    [],
    ['--check', '--write', '--dir', dir],
    ['--check', '--dir'],
    ['--check', '--bogus'],
    ['--check', '--dir', join(SCRATCH, 'nowhere')],
  ]) {
    const r = run(args);
    expect({ args, code: r.code }).toEqual({ args, code: 2 });
  }
  symlinkSync(join(dir, 'login-vectors.json'), join(dir, 'link.json'));
  const r = run(['--check', '--dir', dir]);
  expect(r.code).toBe(2);
  expect(r.err).toContain('不是普通文件');
});

it('pure helpers: isValidRelPath, compare, parseManifest, verifiedManifest', () => {
  expect(isValidRelPath('a/b.json')).toBe(true);
  for (const p of ['', '/a', 'a//b', './a', 'a/../b', 'a\\b', 'manifest.json', 'README.md']) {
    expect({ p, ok: isValidRelPath(p) }).toEqual({ p, ok: false });
  }
  const e = { sha256: hex('x'), bytes: 1 };
  expect(compare({ a: e }, { a: e })).toEqual([]);
  expect(compare({ a: e }, {}).map((p) => p.kind)).toEqual(['missing-file']);
  expect(compare({}, { a: e }).map((p) => p.kind)).toEqual(['unlisted-file']);
  expect(compare({ a: e }, { a: { sha256: hex('y'), bytes: 2 } }).map((p) => p.kind)).toEqual([
    'sha256',
    'bytes',
  ]);
  expect(() => parseManifest('{', 'x')).toThrow(InputError);
  const dir = fixture(BASE);
  expect(Object.keys(verifiedManifest(dir).files)).toEqual(Object.keys(scanDir(dir)));
  write(dir, 'login-vectors.json', 'changed');
  expect(() => verifiedManifest(dir)).toThrow(/不一致/);
});

it('manifest keys such as __proto__ and toString are ordinary paths (missing-file), not dropped', () => {
  const dir = fixture({ 'a.json': 'x' });
  const entry = `{"sha256": "${hex('x')}", "bytes": 1}`;
  write(
    dir,
    'manifest.json',
    `{"format": "${MANIFEST_FORMAT}", "algorithm": "sha256", "files": ` +
      `{"a.json": ${entry}, "__proto__": ${entry}, "toString": ${entry}}}\n`,
  );
  const parsed = parseManifest(readFileSync(join(dir, 'manifest.json'), 'utf8'), 'x');
  expect(Object.keys(parsed.files).sort()).toEqual(['__proto__', 'a.json', 'toString']);
  const r = run(['--check', '--dir', dir]);
  expect(r.code).toBe(1);
  expect(r.err).toContain('__proto__: 清单里有，目录里没有该文件');
  expect(r.err).toContain('toString: 清单里有，目录里没有该文件');
  // An inherited member of the directory scan is not mistaken for a file either.
  expect(compare(parsed.files, {}).map((p) => p.kind)).toEqual([
    'missing-file',
    'missing-file',
    'missing-file',
  ]);
});
