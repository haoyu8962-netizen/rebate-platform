// CT-06zzzzzzza (FU-VERIFY-FULL-SHARDED, D10-2443 ② ③): the segments of `pnpm test:int` as CI runs
// them, read from .github/workflows/ci.yml itself (no second list), for
// tools/ops/verify-container.sh --int-shard and tools/ops/verify-sharded-summary.ts.
//
//   node tools/ci/int-shards.ts [--workflow <path>]       (default .github/workflows/ci.yml of
//                                                         this checkout)
//     one JSON line { n, segments: [{ id, command }] }: the segments "1" … "N" (the command of the
//     job verify-int-<i>, `pnpm test:int … --filter=@couli/spec-tests -- --shard=<i>/<N>`) and
//     "rest" (the one `pnpm test:int … --filter='!@couli/spec-tests'`), each command as written in
//     the workflow (surrounding blanks removed). Exit 0; 2 when the workflow cannot be read or its
//     shape is not that one: an index missing or repeated, a job verify-int-<i> whose command is
//     not shard <i>, different N, numbered commands that differ beyond the index, no or more than
//     one rest command, a verify-int job without a test:int command, any other test:int command.
//   node tools/ci/int-shards.ts --count-int-files <dir>
//     { int_files_total }: the integration test files test:int covers in the snapshot <dir>, read
//     with the include of each package's vitest.integration.config.ts (INT_INCLUDE below, the
//     same patterns; packages are the directories whose package.json has a `test:int` script).
//   node tools/ci/int-shards.ts --sum-reports <dir>
//     { files, tests }: the Vitest JSON reports *.vitest-report.json in <dir> (written by the code
//     under test: regular files only, no links, at most 256 MiB each, shape checked), the number of
//     test files (testResults entries) and of tests (numTotalTests) summed over them. Exit 2 on a
//     report that is not a regular file or not of that shape.
//
// Node built-in modules only; the line-based YAML reading is that of
// tools/ci/ci-int-shards-workflow.test.ts (no YAML dependency).
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

export type IntSegment = { id: string; command: string };
export type IntShards = { n: number; segments: IntSegment[] };

const SPEC_FILTER = '--filter=@couli/spec-tests';
const REST_FILTER = /(?:^|\s)--filter=(['"]?)!@couli\/spec-tests\1(?=\s|$)/;
const SHARD = /--shard=(\d+)\/(\d+)/g;
const INT_JOB = /^verify-int-(\d+)$/;

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function isBlankOrComment(line: string): boolean {
  const t = line.trim();
  return t === '' || t.startsWith('#');
}

/** Removes a trailing ` # comment` and surrounding quotes from a scalar value. */
function scalar(value: string): string {
  const withoutComment = value.replace(/\s+#.*$/, '').trim();
  const single = /^'(.*)'$/.exec(withoutComment);
  if (single) return (single[1] ?? '').replace(/''/g, "'");
  const double = /^"(.*)"$/.exec(withoutComment);
  return double ? (double[1] ?? '') : withoutComment;
}

type Job = { id: string; lines: string[] };

/** The jobs under `jobs:`, in file order (a repeated id stays repeated). */
function jobsOf(text: string): Job[] {
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex((l) => /^jobs:\s*(#.*)?$/.test(l));
  if (at < 0) throw new Error('the workflow has no top-level `jobs:`');
  const jobs: Job[] = [];
  let current: Job | null = null;
  for (const line of lines.slice(at + 1)) {
    if (isBlankOrComment(line)) continue;
    if (indentOf(line) === 0) break;
    const head = /^ {2}([A-Za-z0-9_-]+):\s*(#.*)?$/.exec(line);
    if (head) {
      current = { id: head[1] ?? '', lines: [] };
      jobs.push(current);
    } else if (current && indentOf(line) > 2) {
      current.lines.push(line);
    }
  }
  return jobs;
}

/** The test:int commands of a job's lines: `run:` values and lines of `run: |` blocks. */
function testIntCommands(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    if (isBlankOrComment(line) || !line.includes('test:int')) continue;
    const keyed = /^\s*(?:-\s+)?([A-Za-z0-9_-]+):(?:\s+(.*))?$/.exec(line);
    let command: string;
    if (keyed) {
      if (keyed[1] !== 'run') continue;
      command = scalar(keyed[2] ?? '');
    } else {
      command = line.trim().replace(/^-\s+/, '');
    }
    if (!/^pnpm (?:run )?test:int(?:\s|$)/.test(command)) {
      throw new Error(`a test:int command that is not \`pnpm test:int …\`: ${command}`);
    }
    out.push(command);
  }
  return out;
}

/** The segments of `pnpm test:int` in the workflow text; throws when its shape is not CI's. */
export function readIntShards(workflowText: string): IntShards {
  const jobs = jobsOf(workflowText);
  const numbered = new Map<number, string>();
  const rest: string[] = [];
  let n: number | null = null;
  let template: string | null = null;
  for (const job of jobs) {
    const m = INT_JOB.exec(job.id);
    const index = m ? Number(m[1]) : null;
    if (index !== null && numbered.has(index)) throw new Error(`job ${job.id} appears twice`);
    const own: string[] = [];
    for (const command of testIntCommands(job.lines)) {
      if (REST_FILTER.test(command)) {
        if (command.includes('--shard=')) throw new Error(`a sharded rest command: ${command}`);
        rest.push(command);
        continue;
      }
      const shards = [...command.matchAll(SHARD)];
      if (!command.split(/\s+/).includes(SPEC_FILTER) || shards.length !== 1) {
        throw new Error(
          `a test:int command that is neither a spec-test shard nor rest: ${command}`,
        );
      }
      if (index === null) throw new Error(`a spec-test shard outside a verify-int job (${job.id})`);
      const i = Number(shards[0]?.[1]);
      const total = Number(shards[0]?.[2]);
      if (i !== index) {
        throw new Error(`job ${job.id} runs shard ${String(i)}, not ${String(index)}`);
      }
      if (n === null) n = total;
      else if (total !== n)
        throw new Error(`shard counts differ: ${String(n)} and ${String(total)}`);
      const shape = command.replace(SHARD, '--shard=<i>/$2');
      if (template === null) template = shape;
      else if (shape !== template) {
        throw new Error(`the shard commands differ beyond the index: ${template} / ${shape}`);
      }
      own.push(command);
    }
    if (index === null) continue;
    if (own.length === 0) throw new Error(`job ${job.id} has no spec-test test:int command`);
    if (own.length > 1) throw new Error(`job ${job.id} has ${String(own.length)} shard commands`);
    numbered.set(index, own[0] ?? '');
  }
  if (n === null || numbered.size === 0) throw new Error('no verify-int-<i> job');
  if (n < 1) throw new Error(`a shard count of ${String(n)}`);
  for (let i = 1; i <= n; i++) {
    if (!numbered.has(i)) throw new Error(`shard ${String(i)}/${String(n)} is missing`);
  }
  for (const i of numbered.keys()) {
    if (i < 1 || i > n) throw new Error(`job verify-int-${String(i)} is outside 1..${String(n)}`);
  }
  if (rest.length !== 1) {
    throw new Error(
      `expected one rest command (--filter='!@couli/spec-tests'), found ${String(rest.length)}`,
    );
  }
  const segments: IntSegment[] = [];
  for (let i = 1; i <= n; i++) segments.push({ id: String(i), command: numbered.get(i) ?? '' });
  segments.push({ id: 'rest', command: rest[0] ?? '' });
  return { n, segments };
}

// --- the test:int files of a snapshot ------------------------------------------------------------

/**
 * The include of each package's vitest.integration.config.ts: @couli/spec-tests (test/) names its
 * own, every other package takes the default of integrationConfig (vitest.shared.ts). A path is
 * relative to the package directory.
 */
const INT_INCLUDE: Record<string, RegExp[]> = {
  '@couli/spec-tests': [
    /^spec\/(?:.+\/)?[^/]+\.int\.test\.ts$/,
    /^acceptance\/(?:.+\/)?[^/]+\.test\.ts$/,
    /^smoke\/(?:.+\/)?[^/]+\.int\.test\.ts$/,
  ],
};
const DEFAULT_INT_INCLUDE = [/^src\/(?:.+\/)?[^/]+\.int\.test\.ts$/];
/** Directories Vitest never collects from (configDefaults.exclude and BASE_EXCLUDE) or git skips. */
const SKIP_DIRS = new Set(['node_modules', 'dist', '.tmp', '.git', '.turbo', 'cypress']);

function walk(dir: string, rel: string, out: string[]): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    // Directory entries are not followed through links (Dirent reports the link itself).
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || /^\.(?:idea|cache|output|temp)$/.test(e.name)) continue;
      walk(join(dir, e.name), rel === '' ? e.name : `${rel}/${e.name}`, out);
    } else if (e.isFile()) {
      out.push(rel === '' ? e.name : `${rel}/${e.name}`);
    }
  }
}

/** The number of test:int files in the snapshot directory `root`. */
export function countIntFiles(root: string): number {
  const files: string[] = [];
  walk(root, '', files);
  const packages: { dir: string; include: RegExp[] }[] = [];
  for (const f of files) {
    if (!f.endsWith('/package.json')) continue;
    let pkg: unknown;
    try {
      pkg = JSON.parse(readFileSync(join(root, f), 'utf8'));
    } catch {
      continue;
    }
    if (typeof pkg !== 'object' || pkg === null) continue;
    const { name, scripts } = pkg as { name?: unknown; scripts?: unknown };
    if (typeof scripts !== 'object' || scripts === null) continue;
    if (typeof (scripts as Record<string, unknown>)['test:int'] !== 'string') continue;
    const include =
      (typeof name === 'string' ? INT_INCLUDE[name] : undefined) ?? DEFAULT_INT_INCLUDE;
    packages.push({ dir: f.slice(0, -'/package.json'.length), include });
  }
  let total = 0;
  for (const { dir, include } of packages) {
    const prefix = `${dir}/`;
    for (const f of files) {
      if (!f.startsWith(prefix)) continue;
      const inside = f.slice(prefix.length);
      // A file of a nested package belongs to that package only.
      if (
        packages.some((p) => p.dir !== dir && p.dir.startsWith(prefix) && f.startsWith(`${p.dir}/`))
      ) {
        continue;
      }
      if (include.some((re) => re.test(inside))) total += 1;
    }
  }
  return total;
}

// --- the Vitest JSON reports of a segment ---------------------------------------------------------

const MAX_REPORT_BYTES = 256 * 1024 * 1024;

function isCount(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

/** Files and tests summed over the reports *.vitest-report.json in `dir`. */
export function sumReports(dir: string): { files: number; tests: number } {
  let files = 0;
  let tests = 0;
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.vitest-report.json')) continue;
    const path = join(dir, name);
    const st = lstatSync(path);
    if (!st.isFile()) throw new Error(`report ${name} is not a regular file`);
    if (st.size > MAX_REPORT_BYTES)
      throw new Error(`report ${name} is larger than ${String(MAX_REPORT_BYTES)} bytes`);
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let text: string;
    try {
      if (!fstatSync(fd).isFile()) throw new Error(`report ${name} is not a regular file`);
      text = readFileSync(fd, 'utf8');
    } finally {
      closeSync(fd);
    }
    const doc = JSON.parse(text) as unknown;
    const results =
      typeof doc === 'object' && doc !== null
        ? (doc as Record<string, unknown>)['testResults']
        : undefined;
    const total =
      typeof doc === 'object' && doc !== null
        ? (doc as Record<string, unknown>)['numTotalTests']
        : undefined;
    if (!Array.isArray(results) || !isCount(total)) {
      throw new Error(`report ${name}: not a Vitest JSON report (testResults, numTotalTests)`);
    }
    files += results.length;
    tests += total;
  }
  return { files, tests };
}

// --- command line ----------------------------------------------------------------------------------

function main(argv: string[]): number {
  const usage =
    'usage: int-shards.ts [--workflow <path>] | --count-int-files <dir> | --sum-reports <dir>';
  let workflow: string | null = null;
  let countDir: string | null = null;
  let reportsDir: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (value === undefined || value === '' || value.startsWith('--')) throw new Error(usage);
    if (flag === '--workflow' && workflow === null) workflow = value;
    else if (flag === '--count-int-files' && countDir === null) countDir = value;
    else if (flag === '--sum-reports' && reportsDir === null) reportsDir = value;
    else throw new Error(usage);
    i += 1;
  }
  if ([workflow, countDir, reportsDir].filter((v) => v !== null).length > 1) throw new Error(usage);
  let out: unknown;
  if (countDir !== null) out = { int_files_total: countIntFiles(countDir) };
  else if (reportsDir !== null) out = sumReports(reportsDir);
  else {
    const path = workflow ?? resolve(import.meta.dirname, '../../.github/workflows/ci.yml');
    out = readIntShards(readFileSync(path, 'utf8'));
  }
  process.stdout.write(`${JSON.stringify(out)}\n`);
  return 0;
}

if (import.meta.main) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`int-shards: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 2;
  }
}
