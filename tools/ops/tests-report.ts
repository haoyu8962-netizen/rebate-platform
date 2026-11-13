// The Vitest JSON reports of a verify-container.sh --tests run → the summary that the script
// writes to tests/<n>/tests.json (CT-06zzzzz, D10-1319 / D10-1334). Never evidence: no result.json.
//
//   node tools/ops/tests-report.ts --plan <plan.json> --out <out directory>
//                                  --root <repository root in the reports>
//                                  [--max-report-bytes <n>, default 256 MiB]
//
// For every group of the plan (red-plan.ts output, { groups: [{ name, database, files, … }] }) it
// reads <out>/<group>.exit and <group>.seconds (regular files, not links, at most 32 bytes, an
// integer once whitespace is removed) and <group>.vitest-report.json (the checks, the parsing and
// the cleaning of related-report.ts, imported from there: a regular file of at most
// --max-report-bytes, opened without following links or blocking, then its shape). The out
// directory is written by the tests' own code: nothing there is trusted further than that.
//
// Prints the summary (JSON) on stdout:
//   { files, tests, duration_s, failed: [{ file, test }], load_errors: [{ file, message }],
//     groups: [{ name, database, files, tests, exit, duration_s, failed, load_errors, status }],
//     status }
// with the files relative to --root, the groups in plan order, the totals summed over them and
// status green or red. Exit codes: 0 green; 1 red (each red test "file > full name" and each file
// that failed to load on stderr, cleaned as related-report.ts cleans them, at most 200 lines, then
// "… and <N> more in tests.json"); 2 usage, a missing or irregular out/ file, a report of the
// wrong shape, a group that ran past the time limit (exit 124, whatever its report says), a group
// whose Vitest exited non-zero while its report shows nothing red, or a report that does not hold
// exactly the group's planned files (D10-1388: the tree under test chooses the Vitest config, and
// a narrowed include, passWithNoTests or a whole-file describe.skip must not read green): a planned
// file (<dir>/<file>) missing from the report (at most MISSING_NAMED named, the rest as a count),
// a test file in the report that the group did not plan, a planned file that ran no test (none of
// its assertionResults is passed or failed: a whole-file describe.skip or a file of it.todo is
// still listed, its tests counted; CT-06zzzzzf), or a group with 0 tests and no file that failed
// to load (a file that failed to load counts as run). Nothing is printed on stdout with exit 2.
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { runMain, UsageError } from './cli.ts';
import {
  count,
  DEFAULT_MAX_REPORT_BYTES,
  printableLine,
  readReport,
  redLines,
  relative,
  summarizeRelated,
  type RelatedFailure,
  type RelatedLoadError,
  type RelatedSummary,
} from './related-report.ts';

/** The exit and seconds files: at most this many bytes. */
const SMALL_MAX = 32;
/** A group name names files in out/: a plain word. */
const GROUP_NAME = /^[a-z0-9][a-z0-9-]*$/;
/** The exit code the container script records for a group that ran past the time limit. */
const TIMED_OUT = 124;
/** At most this many missing (or unplanned) files are named on stderr; the rest as a count. */
const MISSING_NAMED = 20;

/** `files`: the group's planned test files relative to the repository root (<dir>/<file>). */
type PlanGroup = { name: string; database: boolean; files: string[] };

export type TestsGroup = {
  name: string;
  database: boolean;
  files: number;
  tests: number;
  exit: number;
  duration_s: number;
  failed: RelatedFailure[];
  load_errors: RelatedLoadError[];
  status: 'green' | 'red';
};

export type TestsSummary = {
  files: number;
  tests: number;
  duration_s: number;
  failed: RelatedFailure[];
  load_errors: RelatedLoadError[];
  groups: TestsGroup[];
  status: 'green' | 'red';
};

/** What the run left in out/ cannot be trusted: exit 2 with this message. */
class OutError extends Error {}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function readPlan(file: string): PlanGroup[] {
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new UsageError(`--plan ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const groups = isRecord(doc) ? doc['groups'] : undefined;
  if (!Array.isArray(groups) || groups.length === 0) {
    throw new UsageError(`--plan ${file}: not { groups: [...] } with at least one group`);
  }
  const seen = new Set<string>();
  return groups.map((g, i) => {
    const name = isRecord(g) ? g['name'] : undefined;
    const dir = isRecord(g) ? g['dir'] : undefined;
    const files = isRecord(g) ? g['files'] : undefined;
    if (
      !isRecord(g) ||
      typeof name !== 'string' ||
      !GROUP_NAME.test(name) ||
      typeof dir !== 'string' ||
      dir === '' ||
      typeof g['database'] !== 'boolean' ||
      !Array.isArray(files) ||
      !files.every((f) => typeof f === 'string')
    ) {
      throw new UsageError(
        `--plan ${file}: groups[${String(i)}] needs a plain name, a dir, a boolean database and files`,
      );
    }
    if (seen.has(name)) throw new UsageError(`--plan ${file}: group ${name} appears twice`);
    seen.add(name);
    return { name, database: g['database'], files: files.map((f: string) => `${dir}/${f}`) };
  });
}

/** <out>/<name>: a regular file (no link, FIFO or directory) of at most SMALL_MAX bytes. */
function readSmall(out: string, name: string): number {
  const path = join(out, name);
  let size: number;
  try {
    const st = lstatSync(path);
    if (!st.isFile()) throw new OutError(`${name} is not a regular file`);
    size = st.size;
  } catch (err) {
    if (err instanceof OutError) throw err;
    throw new OutError(`${name} is missing`);
  }
  if (size > SMALL_MAX) throw new OutError(`${name} has more than ${String(SMALL_MAX)} bytes`);
  // O_NOFOLLOW and O_NONBLOCK: a file swapped for a link or a FIFO after the lstat is not followed
  // and cannot block the open; the descriptor is checked again.
  let text: string;
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    throw new OutError(`${name} cannot be opened as a regular file`);
  }
  try {
    const fst = fstatSync(fd);
    if (!fst.isFile() || fst.size > SMALL_MAX) {
      throw new OutError(`${name} is not a regular file of at most ${String(SMALL_MAX)} bytes`);
    }
    text = readFileSync(fd, 'utf8').trim();
  } finally {
    closeSync(fd);
  }
  if (!/^[0-9]{1,9}$/.test(text)) throw new OutError(`${name} does not hold an integer`);
  return Number(text);
}

/** "<n> <what>: a, b, … and <k> more", the names cleaned, at most MISSING_NAMED of them. */
function nameFiles(files: readonly string[], what: string): string {
  const named = files.slice(0, MISSING_NAMED).map((f) => printableLine(f));
  const rest = files.length - named.length;
  return `${String(files.length)} ${what}: ${named.join(', ')}${rest > 0 ? ` … and ${String(rest)} more` : ''}`;
}

/** The test files of a report (shape already checked by summarizeRelated), relative to `root`. */
function reportFiles(report: unknown, root: string): Set<string> {
  const results = isRecord(report) ? report['testResults'] : undefined;
  const files = new Set<string>();
  if (!Array.isArray(results)) return files;
  for (const r of results) {
    const name = isRecord(r) ? r['name'] : undefined;
    if (typeof name === 'string') files.add(relative(name, root));
  }
  return files;
}

/** A test whose status is one of these ran; skipped, todo, pending and the like did not. */
const RAN = new Set(['passed', 'failed']);

/**
 * The test files of a report (shape already checked by summarizeRelated: each testResults entry
 * has a string name and a list of assertionResults with a string status), relative to `root` as
 * reportFiles makes them, that have at least one test that ran (passed or failed).
 */
function filesWithTestsRun(report: unknown, root: string): Set<string> {
  const results = isRecord(report) ? report['testResults'] : undefined;
  const files = new Set<string>();
  if (!Array.isArray(results)) return files;
  for (const r of results) {
    const name = isRecord(r) ? r['name'] : undefined;
    const assertions = isRecord(r) ? r['assertionResults'] : undefined;
    if (typeof name !== 'string' || !Array.isArray(assertions)) continue;
    const ran = assertions.some((a) => {
      const status = isRecord(a) ? a['status'] : undefined;
      return typeof status === 'string' && RAN.has(status);
    });
    if (ran) {
      files.add(relative(name, root));
    }
  }
  return files;
}

function judgeGroup(g: PlanGroup, out: string, root: string, maxBytes: number): TestsGroup {
  const exit = readSmall(out, `${g.name}.exit`);
  const seconds = readSmall(out, `${g.name}.seconds`);
  if (exit === TIMED_OUT) {
    throw new OutError(
      `group ${g.name} ran past the time limit (exit ${String(TIMED_OUT)}): its tests have no result`,
    );
  }
  const reportName = `${g.name}.vitest-report.json`;
  let text: string;
  try {
    text = readReport(join(out, reportName), maxBytes);
  } catch (err) {
    const code = isRecord(err) ? err['code'] : undefined;
    if (code === 'ENOENT') throw new OutError(`${reportName} is missing`);
    throw new OutError(`${reportName}: ${err instanceof Error ? err.message : String(err)}`);
  }
  let report: unknown;
  try {
    report = JSON.parse(text);
  } catch {
    throw new OutError(`${reportName} is not JSON`);
  }
  let s: RelatedSummary;
  try {
    s = summarizeRelated(report, {
      sources: [],
      durationSeconds: seconds,
      overCapAt: Number.MAX_SAFE_INTEGER,
      root,
    });
  } catch (err) {
    throw new OutError(`${reportName}: ${err instanceof Error ? err.message : String(err)}`);
  }
  // Exactly the planned files ran (a file that failed to load counts as run): the tree under
  // test chooses the Vitest config, which could leave planned files out or run others.
  const ran = reportFiles(report, root);
  const planned = new Set(g.files);
  const missing = [...planned].filter((f) => !ran.has(f)).sort();
  if (missing.length > 0) {
    throw new OutError(
      `group ${g.name}: ${nameFiles(missing, 'planned test file(s) not in its report (not run)')}`,
    );
  }
  const unplanned = [...ran].filter((f) => !planned.has(f)).sort();
  if (unplanned.length > 0) {
    throw new OutError(
      `group ${g.name}: ${nameFiles(unplanned, 'test file(s) in its report that it did not plan')}`,
    );
  }
  // Every planned file ran at least one test (CT-06zzzzzf): a whole-file describe.skip or a file of
  // it.todo is still listed in the report, its tests counted, the file passed and Vitest exits 0.
  // A file that failed to load counts as run (it is red, among load_errors).
  const testsRan = filesWithTestsRun(report, root);
  const loadFailed = new Set(s.load_errors.map((e) => e.file));
  const noTestRun = [...planned].filter((f) => !testsRan.has(f) && !loadFailed.has(f)).sort();
  if (noTestRun.length > 0) {
    throw new OutError(
      `group ${g.name}: ${nameFiles(noTestRun, 'planned test file(s) that ran no test (every test skipped, todo or the like)')}`,
    );
  }
  const red = s.failed.length > 0 || s.load_errors.length > 0;
  if (exit !== 0 && !red) {
    throw new OutError(
      `group ${g.name}: Vitest exited ${String(exit)} but its report has no failed test and no file that failed to load (an unhandled error?)`,
    );
  }
  if (s.tests === 0 && s.load_errors.length === 0) {
    throw new OutError(`group ${g.name}: its report has 0 tests (and no file that failed to load)`);
  }
  return {
    name: g.name,
    database: g.database,
    files: s.related_files,
    tests: s.tests,
    exit,
    duration_s: seconds,
    failed: s.failed,
    load_errors: s.load_errors,
    status: red ? 'red' : 'green',
  };
}

/** Sums up the groups of `plan` from what the run left in `out`; throws when it cannot be trusted. */
export function summarizeTests(
  plan: readonly PlanGroup[],
  out: string,
  root: string,
  maxBytes: number,
): TestsSummary {
  const groups = plan.map((g) => judgeGroup(g, out, root, maxBytes));
  const sum = (f: (g: TestsGroup) => number) => groups.reduce((n, g) => n + f(g), 0);
  return {
    files: sum((g) => g.files),
    tests: sum((g) => g.tests),
    duration_s: sum((g) => g.duration_s),
    failed: groups.flatMap((g) => g.failed),
    load_errors: groups.flatMap((g) => g.load_errors),
    groups,
    status: groups.some((g) => g.status === 'red') ? 'red' : 'green',
  };
}

function main(argv: string[]): number {
  const { values } = parseArgs({
    args: argv,
    options: {
      plan: { type: 'string' },
      out: { type: 'string' },
      root: { type: 'string' },
      'max-report-bytes': { type: 'string' },
    },
  });
  if (
    values.plan === undefined ||
    values.out === undefined ||
    values.out === '' ||
    values.root === undefined ||
    values.root === ''
  ) {
    throw new UsageError(
      'tests-report.ts --plan <plan.json> --out <dir> --root <dir> [--max-report-bytes <n>]',
    );
  }
  const maxBytes = count(
    values['max-report-bytes'],
    '--max-report-bytes',
    DEFAULT_MAX_REPORT_BYTES,
  );
  const plan = readPlan(values.plan);
  let summary: TestsSummary;
  try {
    summary = summarizeTests(plan, values.out, values.root, maxBytes);
  } catch (err) {
    if (!(err instanceof OutError)) throw err;
    process.stderr.write(`tests-report: ${err.message}\n`);
    return 2;
  }
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (summary.status !== 'red') return 0;
  process.stderr.write(`${redLines(summary, 'tests.json').join('\n')}\n`);
  return 1;
}

if (import.meta.main) runMain(main);
