// CT-06zzzzzzza (FU-VERIFY-FULL-SHARDED, D10-2443 ② ③): one "test machine full verify" verdict for
// a tree from its verify-fast run and the test:int segments that verify-container.sh --int-shard
// ran on that same tree.
//
//   node tools/ops/verify-sharded-summary.ts <id> --tree <tree> [--runs <dir>] [--workflow <path>]
//                                            [--json]
//
// Reads <runs>/<id>/verify-fast/*/result.json and <runs>/<id>/int-shard/*/result.json, keeps only
// those whose `tree` is --tree (results of another tree never count: D10-2443 ②) and, per kind and
// segment, the one that finished last (finished_at; the higher run number on a tie). The segments
// are those of tools/ci/int-shards.ts on --workflow (default the trusted root's
// .github/workflows/ci.yml). Green when, and only when, there is a verify-fast with exit 0, every
// segment has a result with exit 0, every segment reports the same int_files_total and that total
// equals the sum of the segments' files. Otherwise red, each reason in `problems`.
//
// Output: one JSON document on stdout (with or without --json, which is accepted for the callers
// that name the format); the problems also go to stderr, one per line:
//   { task, tree, status, fast: { run, exit_code, started_at, finished_at } | null,
//     segments: [{ segment, run, exit_code, files, tests, duration_s }],
//     totals: { files, tests, int_files_total }, problems: [] }
// Exit codes: 0 green, 1 red, 2 usage, or the workflow cannot be read or has not CI's shape.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readIntShards, type IntShards } from '../ci/int-shards.ts';
import { runsDir, trustedRoot } from '../lib/paths.ts';
import { runMain, TASK_ID, UsageError } from './cli.ts';

type Run = { run: number; started_at: string; finished_at: string; exit_code: number };
type ShardRun = Run & { segment: string; files: number; tests: number; int_files_total: number };

export type ShardedSummary = {
  task: string;
  tree: string;
  status: 'green' | 'red';
  fast: Run | null;
  segments: {
    segment: string;
    run: number;
    exit_code: number;
    files: number;
    tests: number;
    duration_s: number;
  }[];
  totals: { files: number; tests: number; int_files_total: number | null };
  problems: string[];
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isCount(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

function isTime(v: unknown): v is string {
  return typeof v === 'string' && !Number.isNaN(Date.parse(v));
}

/** The result.json documents under <dir>/<n>/ (n a run number), with their run numbers. */
function results(dir: string): { run: number; doc: unknown }[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: { run: number; doc: unknown }[] = [];
  for (const name of names) {
    if (!/^[1-9][0-9]*$/.test(name)) continue;
    let text: string;
    try {
      text = readFileSync(join(dir, name, 'result.json'), 'utf8');
    } catch {
      continue; // a run still in progress, or one that stopped without a result
    }
    let doc: unknown;
    try {
      doc = JSON.parse(text);
    } catch {
      doc = null;
    }
    out.push({ run: Number(name), doc });
  }
  return out;
}

function later<T extends Run>(a: T | undefined, b: T): T {
  if (a === undefined) return b;
  const ta = Date.parse(a.finished_at);
  const tb = Date.parse(b.finished_at);
  if (tb !== ta) return tb > ta ? b : a;
  return b.run > a.run ? b : a;
}

/** The verdict for `tree` from the runs of task `task` under `runs`. */
export function summarize(
  task: string,
  tree: string,
  runs: string,
  shards: IntShards,
): ShardedSummary {
  const problems: string[] = [];
  const base = join(runs, task);

  let fast: Run | undefined;
  for (const { run, doc } of results(join(base, 'verify-fast'))) {
    if (!isRecord(doc) || doc['tree'] !== tree) continue;
    const { exit_code, started_at, finished_at } = doc;
    if (!Number.isInteger(exit_code) || !isTime(started_at) || !isTime(finished_at)) {
      problems.push(`verify-fast run ${String(run)}: result.json of this tree is malformed`);
      continue;
    }
    fast = later(fast, { run, exit_code: exit_code as number, started_at, finished_at });
  }

  const ids = shards.segments.map((s) => s.id);
  const bySegment = new Map<string, ShardRun>();
  for (const { run, doc } of results(join(base, 'int-shard'))) {
    if (!isRecord(doc) || doc['tree'] !== tree) continue;
    const { segment, exit_code, files, tests, int_files_total, started_at, finished_at } = doc;
    if (
      typeof segment !== 'string' ||
      !Number.isInteger(exit_code) ||
      !isCount(files) ||
      !isCount(tests) ||
      !isCount(int_files_total) ||
      !isTime(started_at) ||
      !isTime(finished_at)
    ) {
      problems.push(`int-shard run ${String(run)}: result.json of this tree is malformed`);
      continue;
    }
    if (!ids.includes(segment)) continue; // not a segment of this workflow
    const entry: ShardRun = {
      run,
      segment,
      exit_code: exit_code as number,
      files,
      tests,
      int_files_total,
      started_at,
      finished_at,
    };
    bySegment.set(segment, later(bySegment.get(segment), entry));
  }

  if (fast === undefined) problems.push(`missing verify-fast result for this tree`);
  else if (fast.exit_code !== 0) {
    problems.push(`verify-fast run ${String(fast.run)} exit ${String(fast.exit_code)}`);
  }

  const segments: ShardedSummary['segments'] = [];
  const present: ShardRun[] = [];
  for (const id of ids) {
    const s = bySegment.get(id);
    if (s === undefined) {
      problems.push(`missing segment ${id}`);
      continue;
    }
    present.push(s);
    segments.push({
      segment: id,
      run: s.run,
      exit_code: s.exit_code,
      files: s.files,
      tests: s.tests,
      duration_s: Math.max(
        0,
        Math.round((Date.parse(s.finished_at) - Date.parse(s.started_at)) / 1000),
      ),
    });
    if (s.exit_code !== 0)
      problems.push(`segment ${id} (run ${String(s.run)}) exit ${String(s.exit_code)}`);
  }

  const files = present.reduce((sum, s) => sum + s.files, 0);
  const tests = present.reduce((sum, s) => sum + s.tests, 0);
  const declared = [...new Set(present.map((s) => s.int_files_total))];
  const intTotal = declared.length === 1 ? (declared[0] ?? null) : null;
  if (declared.length > 1) {
    problems.push(
      `the segments disagree on int_files_total: ${present
        .map((s) => `${s.segment}=${String(s.int_files_total)}`)
        .join(', ')}`,
    );
  } else if (intTotal !== null && present.length === ids.length && files !== intTotal) {
    problems.push(
      `the segments ran ${String(files)} files in sum, int_files_total is ${String(intTotal)}`,
    );
  }

  return {
    task,
    tree,
    status: problems.length === 0 ? 'green' : 'red',
    fast: fast ?? null,
    segments,
    totals: { files, tests, int_files_total: intTotal },
    problems,
  };
}

function main(argv: string[]): number {
  let task: string | null = null;
  let tree: string | null = null;
  let runs: string | null = null;
  let workflow: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (arg === '--json') continue;
    if (arg === '--tree' || arg === '--runs' || arg === '--workflow') {
      const value = argv[i + 1];
      if (value === undefined || value === '' || value.startsWith('--')) {
        throw new UsageError(`${arg} needs a value`);
      }
      if (arg === '--tree') tree = value;
      else if (arg === '--runs') runs = value;
      else workflow = value;
      i += 1;
    } else if (arg.startsWith('-')) {
      throw new UsageError(`unknown option ${arg}`);
    } else if (task === null) {
      task = arg;
    } else {
      throw new UsageError(`one task id only (got ${task} and ${arg})`);
    }
  }
  if (task === null || !TASK_ID.test(task)) {
    throw new UsageError(
      'verify-sharded-summary.ts <id> --tree <tree> [--runs <dir>] [--workflow <path>] [--json]',
    );
  }
  if (tree === null || !/^[0-9a-f]{40,64}$/.test(tree))
    throw new UsageError('--tree <git tree hash> is required');
  const path = workflow ?? join(trustedRoot(), '.github', 'workflows', 'ci.yml');
  let shards: IntShards;
  try {
    shards = readIntShards(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new UsageError(
      `cannot read the segments of ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const summary = summarize(task, tree, runs ?? runsDir(), shards);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  for (const p of summary.problems) process.stderr.write(`verify-sharded-summary: ${p}\n`);
  return summary.status === 'green' ? 0 : 1;
}

if (import.meta.main) runMain(main);
