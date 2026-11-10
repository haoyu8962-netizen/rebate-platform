// CONTRACTS-TAG (CT-05a, 05 CT-05 方案 B, D10-1229): run locally by the orchestrator after a
// contract change has landed on main. CI only produces the read-only artifact (contracts.yml,
// job contracts-artifact); no workflow asks for write permission, so the tag is made here.
//
//   node tools/ops/contracts-tag.ts [--commit <sha>] [--remote <name>] [--dry-run] [--repo <dir>]
//
// --remote defaults to origin and --repo to this repository. The target is refs/remotes/<remote>/
// main (fetch first: the script itself never fetches), or --commit, which must be that commit or
// one of its ancestors. Only tags shaped contracts-v0.9.<n> (n a non-negative decimal integer
// without leading zeros) count; the local tag list is read.
//
//   - a contracts tag already points at the target          -> print it, exit 0
//   - contracts/ and specs/ are the same as at the commit of
//     the newest contracts tag (largest n)                   -> nothing to tag, exit 0
//   - otherwise an annotated tag contracts-v0.9.<largest n + 1> (n = 0 when there is none) on the
//     target, its message carrying `commit: <40-hex>` and `manifest-sha256: <sha256 of the
//     manifest.json text tools/ci/contracts-artifact.ts builds for the target>`, then
//     `git push <remote> refs/tags/<name>`. A failed push exits 1 and deletes the local tag; it
//     is never retried under another name.
//
// --dry-run prints the decision and creates or pushes nothing. Exit codes: 0 done or nothing to
// do, 1 refused or failed (no remote main, target not on it, unknown commit, push rejected), 2 bad
// arguments. Node built-in modules only.
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import {
  ARTIFACT_ROOTS,
  InputError,
  buildManifest,
  collectFiles,
  resolveCommit,
  sha256Hex,
} from '../ci/contracts-artifact.ts';

export const TAG_PREFIX = 'contracts-v0.9.';

const TAG_N = /^(0|[1-9][0-9]*)$/;
const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** n of `contracts-v0.9.<n>`, or null for any other shape. */
export function parseTagN(name: string): number | null {
  if (!name.startsWith(TAG_PREFIX)) return null;
  const rest = name.slice(TAG_PREFIX.length);
  if (!TAG_N.test(rest)) return null;
  const n = Number(rest);
  return Number.isSafeInteger(n) ? n : null;
}

/** The valid tag with the largest n, or null. */
function newest(names: readonly string[]): { name: string; n: number } | null {
  let best: { name: string; n: number } | null = null;
  for (const name of names) {
    const n = parseTagN(name);
    if (n !== null && (best === null || n > best.n)) best = { name, n };
  }
  return best;
}

/** The tag after the largest valid one; contracts-v0.9.0 when there is none. */
export function nextTag(existing: readonly string[]): string {
  const best = newest(existing);
  return `${TAG_PREFIX}${String(best === null ? 0 : best.n + 1)}`;
}

export type Decision =
  | { action: 'exists'; tag: string }
  | { action: 'unchanged'; since: string }
  | { action: 'create'; tag: string };

export function decide(input: {
  tagsAtTarget: readonly string[];
  latest: { name: string } | null;
  contractsChanged: boolean;
  existing: readonly string[];
}): Decision {
  const atTarget = newest(input.tagsAtTarget);
  if (atTarget !== null) return { action: 'exists', tag: atTarget.name };
  if (input.latest !== null && !input.contractsChanged) {
    return { action: 'unchanged', since: input.latest.name };
  }
  return { action: 'create', tag: nextTag(input.existing) };
}

// ---------------------------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------------------------

const LOCATION_VARS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_PREFIX',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
];

type GitResult = { status: number; stdout: string; stderr: string };

function git(repo: string, args: readonly string[]): GitResult {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of LOCATION_VARS) delete env[name];
  env['GIT_TERMINAL_PROMPT'] = '0';
  const res = spawnSync('git', [...args], {
    cwd: repo,
    env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error) throw new Error(`cannot run git ${args.join(' ')}: ${res.error.message}`);
  return { status: res.status ?? 1, stdout: res.stdout, stderr: res.stderr };
}

class Refused extends Error {}
class UsageError extends Error {}

function mustGit(repo: string, args: readonly string[]): string {
  const res = git(repo, args);
  if (res.status !== 0) throw new Refused(`git ${args.join(' ')} failed: ${res.stderr.trim()}`);
  return res.stdout;
}

/** Valid contracts tags (local) with the commit each one points at. */
function contractTags(repo: string): Array<{ name: string; n: number; commit: string }> {
  const names = mustGit(repo, ['tag', '-l', `${TAG_PREFIX}*`])
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const out: Array<{ name: string; n: number; commit: string }> = [];
  for (const name of names) {
    const n = parseTagN(name);
    if (n === null) continue;
    const commit = mustGit(repo, ['rev-parse', '--verify', `refs/tags/${name}^{commit}`]).trim();
    out.push({ name, n, commit });
  }
  return out;
}

/** Whether contracts/ or specs/ differ between two commits. */
function contractsDiffer(repo: string, from: string, to: string): boolean {
  const pathspecs = ARTIFACT_ROOTS.map((root) => `:(top)${root}`);
  const res = git(repo, ['diff', '--quiet', '--no-ext-diff', from, to, '--', ...pathspecs]);
  if (res.status === 0) return false;
  if (res.status === 1) return true;
  throw new Refused(`git diff ${from} ${to} failed: ${res.stderr.trim()}`);
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

type Args = { commit: string | null; remote: string; dryRun: boolean; repo: string | null };

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { commit: null, remote: 'origin', dryRun: false, repo: null };
  const seen = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (seen.has(arg)) throw new UsageError(`${arg} given twice`);
    seen.add(arg);
    if (arg === '--dry-run') {
      args.dryRun = true;
      continue;
    }
    if (arg !== '--commit' && arg !== '--remote' && arg !== '--repo') {
      throw new UsageError(`unknown argument: ${arg}`);
    }
    const value = argv[i + 1];
    if (value === undefined || value === '' || value.startsWith('-')) {
      throw new UsageError(`${arg} needs a value`);
    }
    i++;
    if (arg === '--commit') args.commit = value;
    else if (arg === '--repo') args.repo = value;
    else {
      if (!REMOTE_NAME.test(value)) throw new UsageError(`not a remote name: ${value}`);
      args.remote = value;
    }
  }
  return args;
}

const USAGE =
  'usage: node tools/ops/contracts-tag.ts [--commit <sha>] [--remote <name>] [--dry-run] [--repo <dir>]';

function run(args: Args, repo: string): number {
  const mainRef = `refs/remotes/${args.remote}/main`;
  const mainRes = git(repo, ['rev-parse', '--verify', '--quiet', `${mainRef}^{commit}`]);
  const mainId = mainRes.stdout.trim();
  if (mainRes.status !== 0 || mainId === '') {
    throw new Refused(`${mainRef} not found (git fetch ${args.remote} first)`);
  }
  let target = mainId;
  if (args.commit !== null) {
    target = resolveCommit(repo, args.commit);
    const anc = git(repo, ['merge-base', '--is-ancestor', target, mainId]);
    if (anc.status === 1) {
      throw new Refused(`${target} is not ${args.remote}/main (${mainId}) or an ancestor of it`);
    }
    if (anc.status !== 0) throw new Refused(`git merge-base failed: ${anc.stderr.trim()}`);
  }

  const tags = contractTags(repo);
  const latest = tags.reduce<(typeof tags)[number] | null>(
    (best, t) => (best === null || t.n > best.n ? t : best),
    null,
  );
  const decision = decide({
    tagsAtTarget: tags.filter((t) => t.commit === target).map((t) => t.name),
    latest,
    contractsChanged: latest === null ? true : contractsDiffer(repo, latest.commit, target),
    existing: tags.map((t) => t.name),
  });

  if (decision.action === 'exists') {
    console.log(`contracts-tag: ${target} already carries ${decision.tag}; nothing to do`);
    return 0;
  }
  if (decision.action === 'unchanged') {
    console.log(
      `contracts-tag: contracts/ and specs/ at ${target} are unchanged since ${decision.since}; nothing to tag`,
    );
    return 0;
  }

  const manifestText = buildManifest(target, collectFiles(repo, target));
  const manifestSha = sha256Hex(Buffer.from(manifestText, 'utf8'));
  const tag = decision.tag;
  if (args.dryRun) {
    console.log(
      `contracts-tag: would create ${tag} on ${target} (manifest-sha256 ${manifestSha}) ` +
        `and push it to ${args.remote}; --dry-run, nothing created`,
    );
    return 0;
  }

  const message = `${tag}\n\ncommit: ${target}\nmanifest-sha256: ${manifestSha}\n`;
  mustGit(repo, ['tag', '-a', '--cleanup=verbatim', '-m', message, tag, target]);
  const push = git(repo, ['push', args.remote, `refs/tags/${tag}:refs/tags/${tag}`]);
  if (push.status !== 0) {
    const del = git(repo, ['tag', '-d', tag]);
    const cleanup =
      del.status === 0 ? 'local tag removed' : `could not remove local tag: ${del.stderr.trim()}`;
    console.error(
      `contracts-tag: push of ${tag} to ${args.remote} failed (${cleanup}); not retried:\n${push.stderr.trim()}`,
    );
    return 1;
  }
  console.log(`contracts-tag: created ${tag} on ${target} and pushed it to ${args.remote}`);
  return 0;
}

/** CLI entry; returns the exit code (see the header). */
export function main(argv: string[], opts: { repo?: string } = {}): number {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    console.error(`contracts-tag: ${err.message}\n${USAGE}`);
    return 2;
  }
  const repo = resolve(args.repo ?? opts.repo ?? resolve(import.meta.dirname, '../..'));
  try {
    return run(args, repo);
  } catch (err) {
    if (!(err instanceof Refused) && !(err instanceof InputError)) throw err;
    console.error(`contracts-tag: ${err.message}`);
    return 1;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    console.error(`contracts-tag: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 2;
  }
}
