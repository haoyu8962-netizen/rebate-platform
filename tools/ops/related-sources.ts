// The source files of a branch for `vitest related` (tools/ops/verify-container.sh --related;
// CT-06zzzzv, FU-RED-RUNS-TEST-GUARD, D10-1292 step 1): the files the branch changed, without the
// test files, test/**, ops/**, docs/** and *.md. Everything else stays, non-TS files included (a
// .sql seed or a .json the tests read): Vitest simply finds no related test for a file nothing
// imports. What Vitest cannot see is recorded beside them (classifySources, round 2 ⑥).
//
//   node tools/ops/related-sources.ts --base <ref> --cwd <dir> [--tree <tree-ish>] [--json]
//
// Read-only. Diffs (`git diff --name-status -z -M`) from the merge base of <ref> and HEAD in <dir>
// to HEAD, or with --tree to that tree (verify-container passes the snapshot tree it runs, so
// uncommitted and untracked files count; round 2 ④). Prints the source files, sorted, one per
// line; --json prints { sources, data_sources, removed_or_renamed, force_all } instead.
// Exit codes: 0 printed (possibly nothing), 2 usage or git error.
import { parseArgs } from 'node:util';
import { changedBetweenCommits, git } from '../lib/git.ts';
import { runMain, UsageError } from './cli.ts';

const TEST_FILE = /\.(test\.ts|test\.tsx)$/; // also *.int.test.ts
const DROPPED_DIRS = ['test/', 'ops/', 'docs/'];
/** Extensions Vitest follows through imports; any other source is data read some other way. */
const IMPORTABLE = /\.(ts|tsx|mts|cts|js|mjs|cjs|jsx)$/;
/** Files whose change makes Vitest run everything, or leaves the selection undecidable. */
const FORCE_ALL = [
  /^package\.json$/,
  /^pnpm-lock\.yaml$/,
  /^pnpm-workspace\.yaml$/,
  /^tsconfig.*\.json$/,
  /^vitest.*\.config\.[^/]+$/,
  /^vite.*\.config\.[^/]+$/,
];

function isSource(f: string): boolean {
  return (
    f !== '' &&
    !TEST_FILE.test(f) &&
    !f.endsWith('.md') &&
    !DROPPED_DIRS.some((dir) => f.startsWith(dir))
  );
}

function basename(f: string): string {
  return f.slice(f.lastIndexOf('/') + 1);
}

/** The changed files that `vitest related` gets: sorted, without duplicates. */
export function relatedSources(changed: readonly string[]): string[] {
  return [...new Set(changed.filter(isSource))].sort();
}

/** One `git diff --name-status -M` entry (the Change shape of tools/lib/git.ts). */
export type StatusEntry = { status: string; path: string; oldPath?: string };

export type SourceClasses = {
  /** Sources Vitest cannot import (.sql, .yaml, .csv …): tests that read them are not selected. */
  data_sources: string[];
  /** Deleted sources and the old paths of renamed ones: tests still naming them are not selected. */
  removed_or_renamed: string[];
  /** A change to package.json, the lockfile, the workspace file, tsconfig*, vitest* or vite* config. */
  force_all: boolean;
};

/**
 * What `vitest related` cannot see among the source files of `git diff --name-status -M` entries
 * (the Change shape of tools/lib/git.ts). Recorded only; the selection does not change.
 */
export function classifySources(entries: readonly StatusEntry[]): SourceClasses {
  const data = new Set<string>();
  const removed = new Set<string>();
  let forceAll = false;
  for (const e of entries) {
    if (e.status === 'R' && e.oldPath !== undefined && isSource(e.oldPath)) removed.add(e.oldPath);
    if (!isSource(e.path)) continue;
    if (e.status === 'D') removed.add(e.path);
    else if (!IMPORTABLE.test(e.path)) data.add(e.path);
    if (FORCE_ALL.some((re) => re.test(basename(e.path)))) forceAll = true;
  }
  return {
    data_sources: [...data].sort(),
    removed_or_renamed: [...removed].sort(),
    force_all: forceAll,
  };
}

function main(argv: string[]): number {
  const { values } = parseArgs({
    args: argv,
    options: {
      base: { type: 'string' },
      cwd: { type: 'string' },
      tree: { type: 'string' },
      json: { type: 'boolean' },
    },
  });
  if (values.base === undefined || values.base === '' || values.cwd === undefined) {
    throw new UsageError(
      'related-sources.ts --base <ref> --cwd <dir> [--tree <tree-ish>] [--json]',
    );
  }
  if (values.base.startsWith('-')) throw new UsageError(`invalid --base: ${values.base}`);
  if (values.tree !== undefined && (values.tree === '' || values.tree.startsWith('-'))) {
    throw new UsageError(`invalid --tree: ${values.tree}`);
  }
  const cwd = values.cwd;
  // The branch's own changes: from its merge base with <ref> (as `<ref>...HEAD`), also with --tree,
  // so that a base that moved on does not bring its own changes in.
  const from = git(['merge-base', values.base, 'HEAD'], { cwd });
  const entries = changedBetweenCommits(from, values.tree ?? 'HEAD', { cwd });
  const sources = relatedSources(entries.map((e) => e.path));
  if (values.json === true) {
    process.stdout.write(`${JSON.stringify({ sources, ...classifySources(entries) })}\n`);
  } else if (sources.length > 0) {
    process.stdout.write(`${sources.join('\n')}\n`);
  }
  return 0;
}

if (import.meta.main) runMain(main);
