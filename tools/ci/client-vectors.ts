// CLIENT-VECTORS (DSX-42, D10-683; 规划/05 §3.11): the distribution manifest of the shared client
// vectors in specs/client/, the single source the three clients (android, harmony, ios) lock.
//
//   node tools/ci/client-vectors.ts --check [--dir <specs/client dir>]
//   node tools/ci/client-vectors.ts --write [--dir <specs/client dir>]
//
//   --dir    the vector directory; default specs/client under the current directory.
//   --check  every file of the directory (recursively; except the root's manifest.json and
//            README.md) has exactly one manifest entry and vice versa, and each entry's sha256 and
//            bytes equal those of the file's raw bytes.
//   --write  recomputes the manifest from the directory and writes it back (atomically).
//
// Manifest (specs/client/manifest.json), keys sorted, paths relative to the directory with `/`:
//   {"format": "couli-client-vectors-manifest/1", "algorithm": "sha256",
//    "files": {"<relative path>": {"sha256": "<64 lowercase hex>", "bytes": <integer>}}}
// The client contract.lock `files` table locks each entry under the key `specs/client/<path>`
// with the same sha256 (tokens-lag.ts --client-vectors compares the two).
//
// Output: stdout one line (`PASS client-vectors: …` / `FAIL client-vectors: …` / `WROTE …`);
// stderr one line per problem. Exit codes: 0 consistent (or written), 1 manifest and directory
// disagree, 2 input error (bad arguments, missing directory, missing or malformed manifest, a
// directory entry that is not a regular file).
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeFileAtomic } from '../lib/fsx.ts';

export const DEFAULT_DIR = 'specs/client';
export const MANIFEST_NAME = 'manifest.json';
export const README_NAME = 'README.md';
export const MANIFEST_FORMAT = 'couli-client-vectors-manifest/1';
/** The key prefix of these files in a client contract.lock `files` table. */
export const LOCK_PREFIX = 'specs/client/';

export class InputError extends Error {
  override name = 'InputError';
}

export type Entry = { sha256: string; bytes: number };
export type Manifest = { format: string; algorithm: 'sha256'; files: Record<string, Entry> };

const HEX64 = /^[0-9a-f]{64}$/;
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const byCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** obj[key] when it is an own property, else undefined (never an inherited member). */
export function ownEntry<T>(obj: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(obj, key) ? obj[key] : undefined;
}

export function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** A relative path a manifest may list: `/`-separated, no empty, `.` or `..` segment. */
export function isValidRelPath(p: string): boolean {
  if (p === '' || p.includes('\\') || p.includes('\0')) return false;
  if (p === MANIFEST_NAME || p === README_NAME) return false;
  return p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The vector files of the directory with their sha256 and size, keyed by relative path. */
export function scanDir(dir: string): Record<string, Entry> {
  let rootStat;
  try {
    rootStat = lstatSync(dir);
  } catch {
    throw new InputError(`目录不存在：${dir}`);
  }
  if (!rootStat.isDirectory()) throw new InputError(`不是目录：${dir}`);
  const found: [string, Entry][] = [];
  const walk = (abs: string, rel: string): void => {
    for (const name of readdirSync(abs).sort(byCodePoint)) {
      const childRel = rel === '' ? name : `${rel}/${name}`;
      if (rel === '' && (name === MANIFEST_NAME || name === README_NAME)) continue;
      const childAbs = join(abs, name);
      const st = lstatSync(childAbs);
      if (st.isDirectory()) walk(childAbs, childRel);
      else if (st.isFile()) {
        const data = readFileSync(childAbs);
        found.push([childRel, { sha256: sha256(data), bytes: data.length }]);
      } else throw new InputError(`${childRel} 不是普通文件（不收符号链接等）`);
    }
  };
  walk(dir, '');
  found.sort(([a], [b]) => byCodePoint(a, b));
  return Object.fromEntries(found);
}

export function parseManifest(text: string, label: string): Manifest {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    throw new InputError(`${label}: 不是合法 JSON（${err instanceof Error ? err.message : ''}）`);
  }
  if (!isObj(doc)) throw new InputError(`${label}: 顶层不是对象`);
  const keys = Object.keys(doc).sort(byCodePoint);
  if (keys.join(',') !== 'algorithm,files,format') {
    throw new InputError(
      `${label}: 顶层键应恰好是 format、algorithm、files，实为 ${keys.join('、')}`,
    );
  }
  if (doc['format'] !== MANIFEST_FORMAT) {
    throw new InputError(`${label}: format 应为 ${MANIFEST_FORMAT}`);
  }
  if (doc['algorithm'] !== 'sha256') throw new InputError(`${label}: algorithm 应为 sha256`);
  const files = doc['files'];
  if (!isObj(files)) throw new InputError(`${label}: files 不是对象`);
  // Object.fromEntries defines own data properties, so keys such as "__proto__" stay ordinary
  // paths (plain assignment would hit the prototype setter and drop the entry).
  const out: [string, Entry][] = [];
  for (const [path, entry] of Object.entries(files)) {
    if (!isValidRelPath(path))
      throw new InputError(`${label}: 不合法的路径 ${JSON.stringify(path)}`);
    const ok =
      isObj(entry) &&
      Object.keys(entry).sort(byCodePoint).join(',') === 'bytes,sha256' &&
      typeof entry['sha256'] === 'string' &&
      HEX64.test(entry['sha256']) &&
      Number.isSafeInteger(entry['bytes']) &&
      (entry['bytes'] as number) >= 0;
    if (!ok) {
      throw new InputError(
        `${label}: ${path} 应为 {"sha256": <64 位小写十六进制>, "bytes": <非负整数>}`,
      );
    }
    out.push([path, { sha256: entry['sha256'] as string, bytes: entry['bytes'] as number }]);
  }
  return { format: MANIFEST_FORMAT, algorithm: 'sha256', files: Object.fromEntries(out) };
}

export function readManifest(dir: string): Manifest {
  const path = join(dir, MANIFEST_NAME);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new InputError(`读不了清单 ${path}`);
  }
  return parseManifest(text, path);
}

export function renderManifest(files: Record<string, Entry>): string {
  const sorted = Object.fromEntries(
    Object.keys(files)
      .sort(byCodePoint)
      .map((k) => [k, { sha256: files[k]?.sha256, bytes: files[k]?.bytes }]),
  );
  return `${JSON.stringify({ format: MANIFEST_FORMAT, algorithm: 'sha256', files: sorted }, null, 2)}\n`;
}

export type Problem = {
  path: string;
  kind: 'missing-file' | 'unlisted-file' | 'sha256' | 'bytes';
  message: string;
};

/** Compares a manifest with the scanned directory; [] when they agree. */
export function compare(manifest: Record<string, Entry>, actual: Record<string, Entry>): Problem[] {
  const problems: Problem[] = [];
  const paths = [...new Set([...Object.keys(manifest), ...Object.keys(actual)])].sort(byCodePoint);
  for (const path of paths) {
    const m = ownEntry(manifest, path);
    const a = ownEntry(actual, path);
    if (a === undefined) {
      problems.push({ path, kind: 'missing-file', message: `${path}: 清单里有，目录里没有该文件` });
    } else if (m === undefined) {
      problems.push({ path, kind: 'unlisted-file', message: `${path}: 目录里有，清单里没有` });
    } else {
      if (m.sha256 !== a.sha256) {
        problems.push({
          path,
          kind: 'sha256',
          message: `${path}: 清单 sha256 ${m.sha256.slice(0, 12)}，文件实为 ${a.sha256.slice(0, 12)}`,
        });
      }
      if (m.bytes !== a.bytes) {
        problems.push({
          path,
          kind: 'bytes',
          message: `${path}: 清单 ${String(m.bytes)} 字节，文件实为 ${String(a.bytes)} 字节`,
        });
      }
    }
  }
  return problems;
}

/** The manifest of the directory, after checking that it matches the files (else InputError). */
export function verifiedManifest(dir: string): Manifest {
  const manifest = readManifest(dir);
  const problems = compare(manifest.files, scanDir(dir));
  if (problems.length > 0) {
    throw new InputError(
      `${join(dir, MANIFEST_NAME)} 与目录里的文件不一致（先跑 client-vectors.ts --check）：` +
        problems.map((p) => p.message).join('；'),
    );
  }
  return manifest;
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

const USAGE =
  'usage: node tools/ci/client-vectors.ts (--check | --write) [--dir <specs/client 目录>]';

export function main(
  argv: readonly string[],
  io: { out: (s: string) => void; err: (s: string) => void } = {
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
  },
  cwd: string = process.cwd(),
): number {
  let mode: 'check' | 'write' | null = null;
  let dir = resolve(cwd, DEFAULT_DIR);
  try {
    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i];
      if (arg === '--check' || arg === '--write') {
        const m = arg === '--check' ? 'check' : 'write';
        if (mode !== null && mode !== m)
          throw new InputError(`--check 与 --write 只能给一个\n${USAGE}`);
        mode = m;
      } else if (arg === '--dir') {
        const v = argv[++i];
        if (v === undefined || v.startsWith('--')) throw new InputError(`--dir 缺少取值\n${USAGE}`);
        dir = resolve(cwd, v);
      } else throw new InputError(`未知参数 ${String(arg)}\n${USAGE}`);
    }
    if (mode === null) throw new InputError(`要给 --check 或 --write\n${USAGE}`);
    const actual = scanDir(dir);
    if (mode === 'write') {
      writeFileAtomic(join(dir, MANIFEST_NAME), renderManifest(actual));
      io.out(`WROTE ${join(dir, MANIFEST_NAME)}: ${String(Object.keys(actual).length)} 个文件\n`);
      return 0;
    }
    const problems = compare(readManifest(dir).files, actual);
    if (problems.length === 0) {
      io.out(`PASS client-vectors: ${String(Object.keys(actual).length)} 个文件与清单一致\n`);
      return 0;
    }
    for (const p of problems) io.err(`${p.message}\n`);
    io.out(
      `FAIL client-vectors: 清单与文件不一致 ${String(problems.length)} 处（改完向量跑 --write 更新清单）\n`,
    );
    return 1;
  } catch (err) {
    if (!(err instanceof InputError)) throw err;
    io.err(`CLIENT-VECTORS 输入错误：${err.message}\n`);
    return 2;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    process.stderr.write(
      `CLIENT-VECTORS 内部错误：${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(2);
  }
}
