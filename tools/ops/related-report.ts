// A Vitest JSON report of `vitest related` → the summary that tools/ops/verify-container.sh
// --related writes to related/<n>/related.json (CT-06zzzzv, FU-RED-RUNS-TEST-GUARD, D10-1292 step 1).
//
//   node tools/ops/related-report.ts --report <vitest json> --sources <file, one path per line>
//                                    --duration <seconds> --root <repository root in the report>
//                                    [--over-cap <n>, default 1500]
//                                    [--max-report-bytes <n>, default 256 MiB]
//
// Prints the summary (JSON) on stdout: the source files, the number of related test files and of
// tests, the duration, over_cap (more related files than the reference cap: only recorded, step 1
// runs them all), the failed tests (file > full name), the files that failed to load and the
// status: green, red, or no_related_tests (sources, but Vitest selected no test file; round 2 ⑤).
// Exit codes: 0 green or no_related_tests, 1 red (the red tests and load-error files also on
// stderr, cleaned: one escaped line each, at most 500 characters, at most 200 lines; round 2 ③),
// 2 usage, or a report that is not a regular file of at most --max-report-bytes (it comes from a
// directory untrusted code writes; round 2 ②) or not the expected shape.
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { runMain, UsageError } from './cli.ts';

export const DEFAULT_OVER_CAP = 1500;
export const DEFAULT_MAX_REPORT_BYTES = 256 * 1024 * 1024;
const MESSAGE_MAX = 300;
/** Printed lines: at most this many characters each, and at most this many lines. */
const LINE_MAX = 500;
const LINES_MAX = 200;

export type RelatedFailure = { file: string; test: string };
export type RelatedLoadError = { file: string; message: string };

export type RelatedSummary = {
  sources: string[];
  related_files: number;
  tests: number;
  duration_s: number;
  over_cap: boolean;
  failed: RelatedFailure[];
  load_errors: RelatedLoadError[];
  status: 'green' | 'red' | 'no_related_tests';
};

type Assertion = { ancestorTitles: string[]; title: string; status: string };
type FileResult = { name: string; status: string; message: string; assertions: Assertion[] };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isCount(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

function str(v: unknown, what: string): string {
  if (typeof v !== 'string') throw new Error(`report: ${what} is not a string`);
  return v;
}

function parseAssertion(v: unknown, where: string): Assertion {
  if (!isRecord(v)) throw new Error(`report: ${where} is not an object`);
  const titles = v['ancestorTitles'];
  if (!Array.isArray(titles) || !titles.every((t) => typeof t === 'string')) {
    throw new Error(`report: ${where}.ancestorTitles is not a list of strings`);
  }
  return {
    ancestorTitles: titles as string[],
    title: str(v['title'], `${where}.title`),
    status: str(v['status'], `${where}.status`),
  };
}

function parseFile(v: unknown, i: number): FileResult {
  const where = `testResults[${String(i)}]`;
  if (!isRecord(v)) throw new Error(`report: ${where} is not an object`);
  const assertions = v['assertionResults'];
  if (!Array.isArray(assertions))
    throw new Error(`report: ${where}.assertionResults is not a list`);
  return {
    name: str(v['name'], `${where}.name`),
    status: str(v['status'], `${where}.status`),
    message: str(v['message'], `${where}.message`),
    assertions: assertions.map((a, j) =>
      parseAssertion(a, `${where}.assertionResults[${String(j)}]`),
    ),
  };
}

/** The test file's path relative to the repository root of the report. */
function relative(name: string, root: string): string {
  const prefix = root.endsWith('/') ? root : `${root}/`;
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

function compare(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/** Summarizes a Vitest `--reporter=json` report; throws when it is not the expected shape. */
export function summarizeRelated(
  report: unknown,
  opts: { sources: string[]; durationSeconds: number; overCapAt: number; root: string },
): RelatedSummary {
  if (!isRecord(report)) throw new Error('report: not a JSON object');
  const results = report['testResults'];
  if (!Array.isArray(results)) throw new Error('report: testResults is not a list');
  const total = report['numTotalTests'];
  if (!isCount(total)) throw new Error('report: numTotalTests is not a count');
  if (!isCount(report['numFailedTests'])) throw new Error('report: numFailedTests is not a count');
  const files = results.map((r, i) => parseFile(r, i));

  const failed: RelatedFailure[] = [];
  const loadErrors: RelatedLoadError[] = [];
  for (const f of files) {
    const file = relative(f.name, opts.root);
    const red = f.assertions.filter((a) => a.status === 'failed');
    for (const a of red) failed.push({ file, test: [...a.ancestorTitles, a.title].join(' > ') });
    if (f.status === 'failed' && red.length === 0) {
      loadErrors.push({ file, message: (f.message.split('\n')[0] ?? '').slice(0, MESSAGE_MAX) });
    }
  }
  failed.sort((a, b) => compare(a.file, b.file) || compare(a.test, b.test));
  loadErrors.sort((a, b) => compare(a.file, b.file));

  return {
    sources: [...opts.sources],
    related_files: files.length,
    tests: total,
    duration_s: opts.durationSeconds,
    over_cap: files.length > opts.overCapAt,
    failed,
    load_errors: loadErrors,
    status:
      files.length === 0
        ? 'no_related_tests'
        : failed.length === 0 && loadErrors.length === 0
          ? 'green'
          : 'red',
  };
}

/**
 * One printed line: control characters (C0 U+0000–U+001F, U+007F, C1 U+0080–U+009F), the line and
 * paragraph separators and the bidirectional controls (U+202A–U+202E, U+2066–U+2069; they reorder
 * what a terminal shows; CT-06zzzzz ⑤) become visible escapes, so that one entry is one line that
 * reads as it is; then at most LINE_MAX characters, a cut line ending in "…". related.json keeps
 * the original text.
 */
export function printableLine(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (ch === '\n') out += '\\n';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\r') out += '\\r';
    else if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      out += `\\x${code.toString(16).padStart(2, '0')}`;
    } else if (
      code === 0x2028 ||
      code === 0x2029 ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
    ) {
      out += `\\u${code.toString(16)}`;
    } else out += ch;
  }
  return out.length > LINE_MAX ? `${out.slice(0, LINE_MAX - 1)}…` : out;
}

/**
 * The lines printed for a red summary: each red test, then each load error; at most LINES_MAX,
 * then one line naming the file that has the rest (`where`; tests-report.ts passes tests.json).
 */
export function redLines(
  summary: Pick<RelatedSummary, 'failed' | 'load_errors'>,
  where = 'related.json',
): string[] {
  const all = [
    ...summary.failed.map((f) => `${f.file} > ${f.test}`),
    ...summary.load_errors.map((e) => `${e.file} (failed to load: ${e.message})`),
  ];
  const shown = all.slice(0, LINES_MAX).map(printableLine);
  if (all.length > LINES_MAX) {
    shown.push(`… and ${String(all.length - LINES_MAX)} more in ${where}`);
  }
  return shown;
}

/**
 * Reads the report only when it is a regular file (not a symbolic link, FIFO, device or
 * directory) of at most `maxBytes`: it comes from a directory the tests' code could write.
 */
export function readReport(path: string, maxBytes: number): string {
  const st = lstatSync(path);
  if (!st.isFile()) throw new Error(`report: ${path} is not a regular file`);
  if (st.size > maxBytes) {
    throw new Error(`report: ${path} has ${String(st.size)} bytes, more than ${String(maxBytes)}`);
  }
  // O_NOFOLLOW and O_NONBLOCK: a file swapped for a link or a FIFO after the lstat is not
  // followed and cannot block the open; the descriptor is checked again.
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const fst = fstatSync(fd);
    if (!fst.isFile() || fst.size > maxBytes) {
      throw new Error(`report: ${path} is not a regular file of at most ${String(maxBytes)} bytes`);
    }
    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
}

export function count(value: string | undefined, flag: string, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback;
  if (value === undefined || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new UsageError(`${flag} must be a non-negative integer: ${String(value)}`);
  }
  return Number(value);
}

function main(argv: string[]): number {
  const { values } = parseArgs({
    args: argv,
    options: {
      report: { type: 'string' },
      sources: { type: 'string' },
      duration: { type: 'string' },
      root: { type: 'string' },
      'over-cap': { type: 'string' },
      'max-report-bytes': { type: 'string' },
    },
  });
  if (
    values.report === undefined ||
    values.sources === undefined ||
    values.root === undefined ||
    values.root === ''
  ) {
    throw new UsageError(
      'related-report.ts --report <vitest json> --sources <file> --duration <seconds> --root <dir> [--over-cap <n>] [--max-report-bytes <n>]',
    );
  }
  const durationSeconds = count(values.duration, '--duration');
  const overCapAt = count(values['over-cap'], '--over-cap', DEFAULT_OVER_CAP);
  const maxBytes = count(
    values['max-report-bytes'],
    '--max-report-bytes',
    DEFAULT_MAX_REPORT_BYTES,
  );
  const sources = readFileSync(values.sources, 'utf8')
    .split('\n')
    .filter((l) => l !== '');
  const report: unknown = JSON.parse(readReport(values.report, maxBytes));
  const summary = summarizeRelated(report, {
    sources,
    durationSeconds,
    overCapAt,
    root: values.root,
  });
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (summary.status !== 'red') return 0;
  process.stderr.write(`${redLines(summary).join('\n')}\n`);
  return 1;
}

if (import.meta.main) runMain(main);
