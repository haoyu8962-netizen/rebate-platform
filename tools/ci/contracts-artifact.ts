// CONTRACTS-ARTIFACT (CT-05a, 05 CT-05 方案 B, D10-1229): the read-only contracts distribution
// artifact. For one commit it takes every tracked file under contracts/ and specs/ of that commit
// (from the commit's tree, never the working tree: dirty edits and untracked files are not seen)
// and writes
//
//   <out>/manifest.json         {"commit": <40-hex>, "files": {<path>: <sha256 hex>}}, keys in
//                               code-unit order, JSON.stringify(…, null, 2) plus a trailing newline;
//                               the same commit always gives byte-identical text
//   <out>/snapshot/<path>       the committed bytes, unchanged (no format conversion: the clients
//                               still turn YAML into JSON with their own sync.sh)
//
//   node tools/ci/contracts-artifact.ts --commit <sha> --out <dir> [--repo <dir>]
//
// --repo defaults to the current directory. <dir> may be missing or an empty directory; a
// non-empty one is refused (nothing is overwritten). Exit codes: 0 written, 1 input error (the
// commit does not exist, the output directory is not empty), 2 bad arguments.
//
// contracts.yml runs this on every push to main (job contracts-artifact) and uploads <out> as an
// Actions artifact; tools/ops/contracts-tag.ts puts the sha256 of the same manifest text into the
// annotation of the contracts-v0.9.<n> tag. Node built-in modules only.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const ARTIFACT_ROOTS = ['contracts', 'specs'] as const;

export class InputError extends Error {
  override name = 'InputError';
}

export type ArtifactFile = { path: string; bytes: Uint8Array };

const COMMIT_ID = /^[0-9a-f]{40}$/;
const MAX_BUFFER = 256 * 1024 * 1024;

// Variables git sets while running hooks; they would point commands at another repository.
const LOCATION_VARS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_PREFIX',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
];

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of LOCATION_VARS) delete env[name];
  env['GIT_OPTIONAL_LOCKS'] = '0';
  env['GIT_TERMINAL_PROMPT'] = '0';
  return env;
}

type RawResult = { status: number; stdout: Buffer; stderr: string };

/** Runs git in `repoDir` with binary stdout; throws only when git cannot be started. */
function gitRaw(repoDir: string, args: readonly string[]): RawResult {
  const res = spawnSync('git', [...args], { cwd: repoDir, env: gitEnv(), maxBuffer: MAX_BUFFER });
  if (res.error) throw new Error(`cannot run git ${args.join(' ')}: ${res.error.message}`);
  return {
    status: res.status ?? 1,
    stdout: res.stdout,
    stderr: res.stderr.toString('utf8'),
  };
}

/** The lowercase hex sha256 of `bytes`. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function inRoots(path: string): boolean {
  return ARTIFACT_ROOTS.some(
    (root) => path.startsWith(`${root}/`) && path.length > root.length + 1,
  );
}

/** The manifest.json text for `commit` and `files` (input order does not matter). */
export function buildManifest(commit: string, files: ReadonlyArray<ArtifactFile>): string {
  if (!COMMIT_ID.test(commit)) {
    throw new InputError(`commit must be 40 lowercase hex characters: ${JSON.stringify(commit)}`);
  }
  const seen = new Set<string>();
  for (const f of files) {
    if (!inRoots(f.path)) {
      throw new InputError(
        `path outside ${ARTIFACT_ROOTS.join('/, ')}/: ${JSON.stringify(f.path)}`,
      );
    }
    if (seen.has(f.path)) throw new InputError(`duplicate path: ${f.path}`);
    seen.add(f.path);
  }
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const table: Record<string, string> = {};
  for (const f of sorted) table[f.path] = sha256Hex(f.bytes);
  return `${JSON.stringify({ commit, files: table }, null, 2)}\n`;
}

/** The full commit id `commit` names in `repoDir`; InputError when it names no commit. */
export function resolveCommit(repoDir: string, commit: string): string {
  if (commit === '' || commit.startsWith('-')) {
    throw new InputError(`not a commit: ${JSON.stringify(commit)}`);
  }
  const res = gitRaw(repoDir, [
    'rev-parse',
    '--verify',
    '--quiet',
    '--end-of-options',
    `${commit}^{commit}`,
  ]);
  const id = res.stdout.toString('utf8').trim();
  if (res.status !== 0 || !COMMIT_ID.test(id)) {
    throw new InputError(`commit not found in ${repoDir}: ${commit}`);
  }
  return id;
}

/**
 * Every tracked file under contracts/ and specs/ of `commit`, in path order, with the bytes of
 * the commit's tree (blobs read by object id; the working tree and the index are never read).
 */
export function collectFiles(repoDir: string, commit: string): ArtifactFile[] {
  const id = resolveCommit(repoDir, commit);
  const listed = gitRaw(repoDir, [
    'ls-tree',
    '-r',
    '-z',
    '--full-tree',
    id,
    '--',
    ...ARTIFACT_ROOTS,
  ]);
  if (listed.status !== 0) {
    throw new InputError(`git ls-tree ${id} failed: ${listed.stderr.trim()}`);
  }
  const entries: Array<{ path: string; oid: string }> = [];
  for (const record of listed.stdout.toString('utf8').split('\0')) {
    if (record === '') continue;
    // <mode> SP <type> SP <object> TAB <path>
    const tab = record.indexOf('\t');
    const meta = record.slice(0, tab).split(' ');
    const path = record.slice(tab + 1);
    if (tab < 0 || meta.length !== 3) throw new Error(`unexpected git ls-tree line: ${record}`);
    // Submodule entries (type commit) have no bytes in this repository; they are not files.
    if (meta[1] !== 'blob' || !inRoots(path)) continue;
    entries.push({ path, oid: meta[2] ?? '' });
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return entries.map(({ path, oid }) => {
    const blob = gitRaw(repoDir, ['cat-file', 'blob', oid]);
    if (blob.status !== 0)
      throw new Error(`git cat-file blob ${oid} (${path}): ${blob.stderr.trim()}`);
    return { path, bytes: new Uint8Array(blob.stdout) };
  });
}

/** Writes `<outDir>/manifest.json` and `<outDir>/snapshot/<path>` for `commit`. */
export function writeArtifact(
  repoDir: string,
  commit: string,
  outDir: string,
): { manifestText: string; count: number } {
  if (existsSync(outDir)) {
    if (!statSync(outDir).isDirectory())
      throw new InputError(`output is not a directory: ${outDir}`);
    if (readdirSync(outDir).length > 0) {
      throw new InputError(`output directory is not empty: ${outDir}`);
    }
  }
  const id = resolveCommit(repoDir, commit);
  const files = collectFiles(repoDir, id);
  const manifestText = buildManifest(id, files);
  const snapshot = resolve(outDir, 'snapshot');
  for (const f of files) {
    const target = resolve(snapshot, f.path);
    if (!target.startsWith(`${snapshot}/`)) throw new InputError(`unsafe path: ${f.path}`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, f.bytes);
  }
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'manifest.json'), manifestText);
  return { manifestText, count: files.length };
}

class UsageError extends Error {}

function parseArgs(argv: readonly string[]): { commit: string; out: string; repo: string } {
  const values: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (arg !== '--commit' && arg !== '--out' && arg !== '--repo') {
      throw new UsageError(`unknown argument: ${arg}`);
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new UsageError(`${arg} needs a value`);
    if (values[arg] !== undefined) throw new UsageError(`${arg} given twice`);
    values[arg] = value;
    i++;
  }
  const commit = values['--commit'];
  const out = values['--out'];
  if (commit === undefined || out === undefined)
    throw new UsageError('--commit and --out are required');
  return { commit, out, repo: values['--repo'] ?? process.cwd() };
}

const USAGE =
  'usage: node tools/ci/contracts-artifact.ts --commit <sha> --out <dir> [--repo <dir>]';

/** CLI entry; returns the exit code (0 written, 1 input error, 2 bad arguments). */
export function main(argv: string[]): number {
  let args: { commit: string; out: string; repo: string };
  try {
    args = parseArgs(argv);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    console.error(`contracts-artifact: ${err.message}\n${USAGE}`);
    return 2;
  }
  try {
    const res = writeArtifact(resolve(args.repo), args.commit, resolve(args.out));
    const manifest = JSON.parse(res.manifestText) as { commit: string };
    console.log(
      `contracts-artifact: ${String(res.count)} files of ${manifest.commit} written to ${resolve(args.out)} ` +
        `(manifest sha256 ${sha256Hex(Buffer.from(res.manifestText, 'utf8'))})`,
    );
    return 0;
  } catch (err) {
    if (!(err instanceof InputError)) throw err;
    console.error(`contracts-artifact: ${err.message}`);
    return 1;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    console.error(`contracts-artifact: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 2;
  }
}
