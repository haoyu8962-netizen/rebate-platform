// Ledger-only pull requests (CT-06zzzv, FU-CI-LEDGER-ONLY-FAST, D10-935): does a pull request
// change nothing but task ledgers, ops/tasks/<id>.yaml, or (D10-1024 E, CT-06zzzze) docs, any
// path under the top-level docs/ directory? When it does, ci.yml skips the heavy
// verify jobs (verify-unit, verify-spec-*, verify-props-*, verify-props-sha-*, verify-int-*);
// verify-static (which runs `node tools/ops/task.ts check`) and guard-git still run.
//
//   node tools/ci/ledger-only.ts --repo <PR checkout> --base <sha> --head <sha>
//
// Runs from the BASE copy of the repository (job ledger-only-detect checks out the base sha at
// base/, the way guard-git and evidence-check do), with the PR checkout as data, so a branch
// cannot change the decision that lets it skip its own tests. Node built-ins only: nothing is
// installed and nothing of the PR is executed.
//
// The decision: every path of `git diff --raw -M base...head` (the merge-base diff, so a main
// that moved on, or main merged into the PR, does not count as the PR's change) — both sides of
// a rename, deleted paths too — matches ops/tasks/<one path segment>.yaml or docs/<anything> (a
// rename between the two counts too) and is a regular file (or absent on one side), and at least
// one path changed. Anything else is only=false: another path (ops/evidence, any other ops/ file,
// a sub-directory of ops/tasks, .yml, tools, test, apps, .github, a docs/ below another
// directory such as apps/docs/, docs.md, README.md, `docs` itself as a file, ...), no change at
// all, a symbolic link or submodule, an argument that is not a full commit sha, a --repo that is
// not the top of a git repository, or any git error. test/, tools/, packages/ and apps/ do not read
// the real docs/ (checked for D10-1024); docs/research is untrusted and may not be imported, and
// that depcruise rule is checked by verify-static, which always runs.
//
// Output: stdout carries exactly one line `only=true` or `only=false`; the reason and the changed
// paths go to stderr. With GITHUB_OUTPUT set, `only=<value>` is appended to that file. The exit
// code is always 0: a failure is reported as only=false, which runs every job.
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

export type LedgerOnlyResult = {
  /** True only when at least one path changed and every changed path is a task ledger or a doc. */
  ledgerOnly: boolean;
  /** Every changed path of base...head, both sides of a rename; [] when none or on an error. */
  paths: string[];
  /** Why; names the first paths that are neither task ledgers nor docs. Never empty. */
  reason: string;
};

const LEDGER = /^ops\/tasks\/[^/]+\.yaml$/;
/** Anything below the top-level docs/ directory (D10-1024 E). */
const DOCS = /^docs\/./;
const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/** Modes of a side of a change that may be a ledger or a doc: a regular file, or absent. */
const FILE_MODES = new Set(['100644', '100755']);
const ABSENT_MODE = '000000';
const MAX_BUFFER = 256 * 1024 * 1024;
const MAX_LISTED = 10;

// Variables git sets while running hooks; they would redirect commands aimed at --repo.
const LOCATION_VARS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_PREFIX',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
];

/** True for exactly ops/tasks/<id>.yaml: one path segment below ops/tasks, ending in .yaml. */
export function isLedgerPath(path: string): boolean {
  return LEDGER.test(path);
}

/** True for a path below the top-level docs/ directory: docs/<at least one character>. */
export function isDocsPath(path: string): boolean {
  return DOCS.test(path);
}

/** A path the fast path may skip the heavy jobs for: a task ledger or a doc. */
function isFastPath(path: string): boolean {
  return isLedgerPath(path) || isDocsPath(path);
}

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of LOCATION_VARS) delete env[name];
  env['GIT_OPTIONAL_LOCKS'] = '0';
  env['GIT_TERMINAL_PROMPT'] = '0';
  return env;
}

class DetectError extends Error {}

function git(repo: string, args: readonly string[]): string {
  const res = spawnSync('git', ['-C', repo, ...args], {
    env: gitEnv(),
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
  });
  if (res.error) throw new DetectError(`cannot run git ${args[0] ?? ''}: ${res.error.message}`);
  if (res.status !== 0) {
    throw new DetectError(
      `git ${args.join(' ')} failed with exit code ${String(res.status)}: ${res.stderr.trim()}`,
    );
  }
  return res.stdout;
}

type Change = { status: string; paths: string[]; modes: string[] };

/** Parses `git diff --raw -z` output: `:<mode> <mode> <sha> <sha> <status>\0<path>\0[<path>\0]`. */
function parseRaw(out: string): Change[] {
  const fields = out.split('\0');
  if (fields[fields.length - 1] === '') fields.pop();
  const changes: Change[] = [];
  for (let i = 0; i < fields.length;) {
    const head = fields[i++] ?? '';
    const m = /^:(\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ ([A-Z])(\d*)$/.exec(head);
    if (!m)
      throw new DetectError(`cannot parse git diff --raw output near ${JSON.stringify(head)}`);
    const status = m[3] ?? '';
    const count = status === 'R' || status === 'C' ? 2 : 1;
    const paths = fields.slice(i, i + count);
    i += count;
    if (paths.length !== count || paths.some((p) => p === '')) {
      throw new DetectError('git diff --raw output ends in the middle of an entry');
    }
    changes.push({ status, paths, modes: [m[1] ?? '', m[2] ?? ''] });
  }
  return changes;
}

function sideOk(mode: string): boolean {
  return mode === ABSENT_MODE || FILE_MODES.has(mode);
}

function listed(paths: readonly string[]): string {
  const shown = paths.slice(0, MAX_LISTED).join(', ');
  return paths.length > MAX_LISTED ? `${shown} and ${paths.length - MAX_LISTED} more` : shown;
}

function diffPaths(input: { repo: string; base: string; head: string }): Change[] {
  for (const [name, sha] of [
    ['base', input.base],
    ['head', input.head],
  ] as const) {
    if (!FULL_SHA.test(sha)) throw new DetectError(`--${name} is not a full commit sha: ${sha}`);
  }
  const repo = resolve(input.repo);
  if (!existsSync(repo) || !statSync(repo).isDirectory()) {
    throw new DetectError(`--repo is not a directory: ${repo}`);
  }
  // The checkout itself, never a repository that merely encloses the directory.
  const top = git(repo, ['rev-parse', '--show-toplevel']).trim();
  if (top === '' || realpathSync(top) !== realpathSync(repo)) {
    throw new DetectError(`--repo is not the top of a git work tree: ${repo}`);
  }
  for (const sha of [input.base, input.head]) {
    git(repo, ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`]);
  }
  const out = git(repo, [
    '-c',
    'core.quotePath=false',
    'diff',
    '--raw',
    '-z',
    '-M',
    '--no-ext-diff',
    '--no-textconv',
    '--no-relative',
    `${input.base}...${input.head}`,
    '--',
  ]);
  return parseRaw(out);
}

/** Decides whether base...head in `repo` changes task ledgers or docs and nothing else; never throws. */
export function detectLedgerOnly(input: {
  repo: string;
  base: string;
  head: string;
}): LedgerOnlyResult {
  let changes: Change[];
  try {
    changes = diffPaths(input);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ledgerOnly: false,
      paths: [],
      reason: `cannot decide, so not ledger-only: ${message}`,
    };
  }
  const paths = [...new Set(changes.flatMap((c) => c.paths))];
  if (paths.length === 0) {
    return { ledgerOnly: false, paths, reason: 'base...head changes no path' };
  }
  const others = paths.filter((p) => !isFastPath(p));
  if (others.length > 0) {
    return {
      ledgerOnly: false,
      paths,
      reason: `changes paths that are neither task ledgers (ops/tasks/<id>.yaml) nor docs (docs/**): ${listed(others)}`,
    };
  }
  const notFiles = changes.filter((c) => !c.modes.every(sideOk)).flatMap((c) => c.paths);
  if (notFiles.length > 0) {
    return {
      ledgerOnly: false,
      paths,
      reason: `a ledger or docs path is not a regular file on one side: ${listed([...new Set(notFiles)])}`,
    };
  }
  return {
    ledgerOnly: true,
    paths,
    reason: `changes ${paths.length} task ledger or docs path(s) and nothing else`,
  };
}

function decide(argv: string[]): LedgerOnlyResult {
  let values: { repo?: string | undefined; base?: string | undefined; head?: string | undefined };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: { repo: { type: 'string' }, base: { type: 'string' }, head: { type: 'string' } },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ledgerOnly: false, paths: [], reason: `usage: ${message}` };
  }
  const { repo, base, head } = values;
  if (repo === undefined || base === undefined || head === undefined) {
    return {
      ledgerOnly: false,
      paths: [],
      reason: 'usage: node tools/ci/ledger-only.ts --repo <PR checkout> --base <sha> --head <sha>',
    };
  }
  return detectLedgerOnly({ repo, base, head });
}

function main(argv: string[]): void {
  let result: LedgerOnlyResult;
  try {
    result = decide(argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    result = { ledgerOnly: false, paths: [], reason: `internal error: ${message}` };
  }
  const line = `only=${String(result.ledgerOnly)}`;
  console.error(`ledger-only: ${result.reason}`);
  for (const path of result.paths) console.error(`  ${path}`);
  const output = process.env['GITHUB_OUTPUT'];
  if (output !== undefined && output !== '') {
    try {
      appendFileSync(output, `${line}\n`);
    } catch (error) {
      // No output means only is empty, which ci.yml treats as false.
      const message = error instanceof Error ? error.message : String(error);
      console.error(`ledger-only: cannot append to GITHUB_OUTPUT: ${message}`);
    }
  }
  console.log(line);
  process.exitCode = 0;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) {
  main(process.argv.slice(2));
}
