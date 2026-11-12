// CT-06zzzzv (FU-RED-RUNS-TEST-GUARD, D10-1292 step 1): a Vitest JSON report of
// `vitest related` → the related.json summary of verify-container.sh --related.
import { spawnSync } from 'node:child_process';
import { mkdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { printableLine, summarizeRelated } from './related-report.ts';
import { CLI_TIMEOUT, OPS_DIR, removeDir, runCli, scratchDir } from './test-helpers.ts';

const ROOT = '/w/repo';
const SOURCES = ['apps/api/src/modules/content/domain/config-registry.ts'];

type Assertion = {
  ancestorTitles: string[];
  title: string;
  fullName: string;
  status: string;
};
type FileResult = {
  name: string;
  status: string;
  message: string;
  assertionResults: Assertion[];
};

function assertion(ancestorTitles: string[], title: string, status: string): Assertion {
  // Vitest's own fullName joins with a space; the summary joins with " > ".
  return { ancestorTitles, title, fullName: [...ancestorTitles, title].join(' '), status };
}

function file(rel: string, status: string, assertions: Assertion[], message = ''): FileResult {
  return { name: `${ROOT}/${rel}`, status, message, assertionResults: assertions };
}

function report(testResults: FileResult[]): Record<string, unknown> {
  const all = testResults.flatMap((r) => r.assertionResults);
  return {
    numTotalTests: all.length,
    numFailedTests: all.filter((a) => a.status === 'failed').length,
    numPassedTests: all.filter((a) => a.status === 'passed').length,
    success: testResults.every((r) => r.status === 'passed'),
    testResults,
  };
}

function opts(overCapAt = 1500, durationSeconds = 42) {
  return { sources: SOURCES, durationSeconds, overCapAt, root: ROOT };
}

const GREEN = report([
  file('test/spec/content/config-items/registry.test.ts', 'passed', [
    assertion(['registry'], '[BR-CONTENT-01] lists every key', 'passed'),
    assertion([], '[BR-CONTENT-01] keys are unique', 'passed'),
  ]),
  file('apps/api/src/modules/content/domain/config-registry.test.ts', 'passed', [
    assertion([], 'loads', 'passed'),
  ]),
]);

// Two failed assertions in one file (listed out of order), one passing beside them, and a
// second file that only passes.
const TWO_FAILED = report([
  file('test/spec/content/config-items/registry.test.ts', 'failed', [
    assertion(['registry', 'keys'], '[BR-CONTENT-01] z: no unknown key', 'failed'),
    assertion(['registry'], '[BR-CONTENT-01] still fine', 'passed'),
    assertion(['registry', 'keys'], '[BR-CONTENT-01] a: the frozen list', 'failed'),
  ]),
  file('packages/money/src/a.test.ts', 'passed', [assertion([], 'adds', 'passed')]),
]);

it('[CT-06zzzzv] summarizeRelated: an all-green report is green with nothing failed', () => {
  expect(summarizeRelated(GREEN, opts())).toEqual({
    sources: SOURCES,
    related_files: 2,
    tests: 3,
    duration_s: 42,
    over_cap: false,
    failed: [],
    load_errors: [],
    status: 'green',
  });
});

it('[CT-06zzzzv] summarizeRelated: two failed assertions give two full names (" > ") with repository-relative paths, sorted', () => {
  const summary = summarizeRelated(TWO_FAILED, opts());
  expect(summary.status).toBe('red');
  expect(summary.failed).toEqual([
    {
      file: 'test/spec/content/config-items/registry.test.ts',
      test: 'registry > keys > [BR-CONTENT-01] a: the frozen list',
    },
    {
      file: 'test/spec/content/config-items/registry.test.ts',
      test: 'registry > keys > [BR-CONTENT-01] z: no unknown key',
    },
  ]);
  // A file with failed assertions is not a load error.
  expect(summary.load_errors).toEqual([]);
  expect(summary.related_files).toBe(2);
  expect(summary.tests).toBe(4);
});

it('[CT-06zzzzv] summarizeRelated: failed tests are sorted by file, then by name; a test outside describe is its title', () => {
  const summary = summarizeRelated(
    report([
      file('test/spec/z.test.ts', 'failed', [assertion([], 'b', 'failed')]),
      file('apps/api/src/a.test.ts', 'failed', [
        assertion(['outer'], 'y', 'failed'),
        assertion([], 'x', 'failed'),
      ]),
    ]),
    opts(),
  );
  expect(summary.failed.map((f) => `${f.file} > ${f.test}`)).toEqual([
    'apps/api/src/a.test.ts > outer > y',
    'apps/api/src/a.test.ts > x',
    'test/spec/z.test.ts > b',
  ]);
});

it('[CT-06zzzzv] summarizeRelated: a file that failed without a failed test is a load error (first line of its message), status red', () => {
  const summary = summarizeRelated(
    report([
      file('test/spec/a.test.ts', 'passed', [assertion([], 'ok', 'passed')]),
      file(
        'test/spec/content/broken.test.ts',
        'failed',
        [],
        "Error: Cannot find module '../x.ts'\n    at load (file.js:1:1)",
      ),
    ]),
    opts(),
  );
  expect(summary.status).toBe('red');
  expect(summary.failed).toEqual([]);
  expect(summary.load_errors).toEqual([
    { file: 'test/spec/content/broken.test.ts', message: "Error: Cannot find module '../x.ts'" },
  ]);
  expect(summary.related_files).toBe(2);
});

it('[CT-06zzzzv] summarizeRelated: a load error message is cut to 300 characters; a failed file whose tests all passed is a load error too', () => {
  const long = 'E'.repeat(400);
  const summary = summarizeRelated(
    report([
      file('test/spec/long.test.ts', 'failed', [], `${long}\nsecond line`),
      file('test/spec/hook.test.ts', 'failed', [assertion([], 'ok', 'passed')], 'afterAll failed'),
    ]),
    opts(),
  );
  expect(summary.status).toBe('red');
  expect(summary.failed).toEqual([]);
  const byFile = new Map(summary.load_errors.map((e) => [e.file, e.message]));
  expect(byFile.get('test/spec/long.test.ts')).toBe('E'.repeat(300));
  expect(byFile.get('test/spec/hook.test.ts')).toBe('afterAll failed');
  expect(summary.load_errors).toHaveLength(2);
});

it('[CT-06zzzzv] summarizeRelated: over_cap only when the related files exceed the cap (equal is not over)', () => {
  // GREEN has two related files.
  expect(summarizeRelated(GREEN, opts(2)).over_cap).toBe(false);
  expect(summarizeRelated(GREEN, opts(1)).over_cap).toBe(true);
  expect(summarizeRelated(GREEN, opts(3)).over_cap).toBe(false);
  // over_cap changes nothing else: still green, every file counted.
  expect(summarizeRelated(GREEN, opts(1))).toMatchObject({ status: 'green', related_files: 2 });
});

it('[CT-06zzzzv] summarizeRelated throws on a report that is not the expected shape', () => {
  const good = TWO_FAILED as { testResults: FileResult[] };
  const firstFile = good.testResults[0] as FileResult;
  const bad: unknown[] = [
    null,
    'report',
    [],
    {},
    { ...TWO_FAILED, numTotalTests: '4' },
    { ...TWO_FAILED, numFailedTests: undefined },
    { ...TWO_FAILED, testResults: {} },
    { ...TWO_FAILED, testResults: [{ ...firstFile, name: 7 }] },
    { ...TWO_FAILED, testResults: [{ ...firstFile, assertionResults: 'x' }] },
    { ...TWO_FAILED, testResults: [{ ...firstFile, status: undefined }] },
    {
      ...TWO_FAILED,
      testResults: [
        { ...firstFile, assertionResults: [{ title: 'x', status: 'failed', ancestorTitles: 'a' }] },
      ],
    },
  ];
  for (const doc of bad) expect(() => summarizeRelated(doc, opts()), JSON.stringify(doc)).toThrow();
});

// --- CLI ------------------------------------------------------------------------------------------

let dir = '';

beforeAll(() => {
  dir = scratchDir('related-report');
});
afterAll(() => removeDir(dir));

function writeJson(name: string, doc: unknown): string {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(doc));
  return path;
}

function sourcesFile(name: string, sources: string[]): string {
  const path = join(dir, name);
  writeFileSync(path, sources.map((s) => `${s}\n`).join(''));
  return path;
}

function cli(reportPath: string, extra: string[] = []) {
  return runCli('related-report.ts', [
    '--report',
    reportPath,
    '--sources',
    sourcesFile('sources.txt', SOURCES),
    '--duration',
    '7',
    '--root',
    ROOT,
    ...extra,
  ]);
}

it(
  '[CT-06zzzzv] related-report CLI: green prints the summary on stdout and exits 0',
  () => {
    const res = cli(writeJson('green.json', GREEN));
    expect(res.status, res.stderr).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual({
      sources: SOURCES,
      related_files: 2,
      tests: 3,
      duration_s: 7,
      over_cap: false,
      failed: [],
      load_errors: [],
      status: 'green',
    });
  },
  CLI_TIMEOUT,
);

it(
  '[CT-06zzzzv] related-report CLI: red exits 1 and lists every red test and load-error file on stderr',
  () => {
    const red = report([
      ...(TWO_FAILED as { testResults: FileResult[] }).testResults,
      file('test/spec/content/broken.test.ts', 'failed', [], 'SyntaxError: bad\n  at x'),
    ]);
    const res = cli(writeJson('red.json', red));
    expect(res.status, res.stderr).toBe(1);
    const summary = JSON.parse(res.stdout) as { status: string; failed: unknown[] };
    expect(summary.status).toBe('red');
    expect(summary.failed).toHaveLength(2);
    expect(res.stderr).toContain(
      'test/spec/content/config-items/registry.test.ts > registry > keys > [BR-CONTENT-01] a: the frozen list',
    );
    expect(res.stderr).toContain(
      'test/spec/content/config-items/registry.test.ts > registry > keys > [BR-CONTENT-01] z: no unknown key',
    );
    expect(res.stderr).toContain('test/spec/content/broken.test.ts');
    expect(res.stderr).not.toContain('packages/money/src/a.test.ts');
  },
  CLI_TIMEOUT,
);

it(
  '[CT-06zzzzv] related-report CLI: --over-cap defaults to 1500 and can be given',
  () => {
    const many = (n: number) =>
      report(
        Array.from({ length: n }, (_, i) =>
          file(`test/spec/many/f${String(i)}.test.ts`, 'passed', [assertion([], 'ok', 'passed')]),
        ),
      );
    const atCap = cli(writeJson('at-cap.json', many(1500)));
    expect(atCap.status, atCap.stderr).toBe(0);
    expect(JSON.parse(atCap.stdout)).toMatchObject({ related_files: 1500, over_cap: false });
    const overCap = cli(writeJson('over-cap.json', many(1501)));
    expect(overCap.status, overCap.stderr).toBe(0);
    expect(JSON.parse(overCap.stdout)).toMatchObject({
      related_files: 1501,
      over_cap: true,
      status: 'green',
    });
    const given = cli(writeJson('given.json', GREEN), ['--over-cap', '1']);
    expect(given.status, given.stderr).toBe(0);
    expect(JSON.parse(given.stdout)).toMatchObject({ over_cap: true });
  },
  CLI_TIMEOUT,
);

it(
  '[CT-06zzzzv] related-report CLI exits 2 on a malformed report or bad usage',
  () => {
    const notJson = join(dir, 'not-json.json');
    writeFileSync(notJson, '{ not json');
    expect(cli(notJson).status).toBe(2);
    expect(cli(writeJson('shape.json', { testResults: 'x' })).status).toBe(2);
    expect(cli(join(dir, 'missing.json')).status).toBe(2);
    // No --report at all.
    const noReport = runCli('related-report.ts', [
      '--sources',
      sourcesFile('sources-2.txt', SOURCES),
      '--duration',
      '7',
      '--root',
      ROOT,
    ]);
    expect(noReport.status).toBe(2);
  },
  CLI_TIMEOUT,
);

// --- CT-06zzzzv round 2 (D10-1337 ⑤): sources changed, but Vitest selected no related test --------

const EMPTY = report([]);

it('[CT-06zzzzv] summarizeRelated: a report without test files is no_related_tests, not green', () => {
  const summary = summarizeRelated(EMPTY, opts());
  expect(summary).toMatchObject({
    sources: SOURCES,
    related_files: 0,
    tests: 0,
    failed: [],
    load_errors: [],
    over_cap: false,
  });
  expect(summary.status).toBe('no_related_tests');
});

it(
  '[CT-06zzzzv] related-report CLI: an empty report exits 0 with status no_related_tests',
  () => {
    const res = cli(writeJson('empty.json', EMPTY));
    expect(res.status, res.stderr).toBe(0);
    expect(JSON.parse(res.stdout)).toMatchObject({
      related_files: 0,
      tests: 0,
      status: 'no_related_tests',
    });
  },
  CLI_TIMEOUT,
);

// --- CT-06zzzzv round 2 (D10-1337 ②): the report comes from a directory untrusted code writes ------
// --report must be a regular file (lstat: not a symbolic link, not a directory, not a FIFO) of at
// most 256 MiB; --max-report-bytes <n> lowers that limit (the tests use it). Anything else: exit 2.

/** Like runCli, with a time limit: a CLI that opens a FIFO would hang. */
function cliBounded(args: string[]) {
  const res = spawnSync(process.execPath, [join(OPS_DIR, 'related-report.ts'), ...args], {
    encoding: 'utf8',
    timeout: 15_000,
    killSignal: 'SIGKILL',
  });
  return { status: res.status ?? -1, stdout: res.stdout, stderr: res.stderr, signal: res.signal };
}

function reportArgs(reportPath: string, extra: string[] = []): string[] {
  return [
    '--report',
    reportPath,
    '--sources',
    sourcesFile('sources-guard.txt', SOURCES),
    '--duration',
    '7',
    '--root',
    ROOT,
    ...extra,
  ];
}

it(
  '[CT-06zzzzv] related-report CLI: a report that is a symbolic link exits 2, even to a valid report',
  () => {
    const target = writeJson('link-target.json', GREEN);
    const link = join(dir, 'link.json');
    symlinkSync(target, link);
    const res = cliBounded(reportArgs(link));
    expect(res.status, res.stderr).toBe(2);
    expect(res.stdout).toBe('');
    // The target itself is accepted.
    expect(cliBounded(reportArgs(target)).status).toBe(0);
  },
  CLI_TIMEOUT,
);

it(
  '[CT-06zzzzv] related-report CLI: a report that is a directory or a FIFO exits 2 without hanging',
  () => {
    const asDir = join(dir, 'dir-report.json');
    mkdirSync(asDir);
    const d = cliBounded(reportArgs(asDir));
    expect(d.signal).toBeNull();
    expect(d.status).toBe(2);
    const fifo = join(dir, 'fifo-report.json');
    const mk = spawnSync('mkfifo', [fifo]);
    expect(mk.status).toBe(0);
    const f = cliBounded(reportArgs(fifo));
    expect(f.signal, 'related-report hung on a FIFO').toBeNull();
    expect(f.status).toBe(2);
    expect(f.stdout).toBe('');
  },
  CLI_TIMEOUT,
);

it(
  '[CT-06zzzzv] related-report CLI: --max-report-bytes caps the report size (equal passes, one byte over exits 2)',
  () => {
    const path = writeJson('sized.json', GREEN);
    const size = statSync(path).size;
    const at = cliBounded(reportArgs(path, ['--max-report-bytes', String(size)]));
    expect(at.status, at.stderr).toBe(0);
    const over = cliBounded(reportArgs(path, ['--max-report-bytes', String(size - 1)]));
    expect(over.status).toBe(2);
    expect(over.stdout).toBe('');
    // Without the option the default (256 MiB) lets an ordinary report through.
    expect(cliBounded(reportArgs(path)).status).toBe(0);
    // Not a count: usage error.
    expect(cliBounded(reportArgs(path, ['--max-report-bytes', 'x'])).status).toBe(2);
  },
  CLI_TIMEOUT,
);

// --- CT-06zzzzv round 2 (D10-1337 ③): the lines printed for red tests are cleaned -------------------
// Each printed line (file > test, the load errors): control characters \x00-\x1f, \x7f, U+2028 and
// U+2029 as visible escapes (one entry is one line), at most 500 characters (longer ones end in
// "…"), at most 200 lines and then "… and <N> more in related.json". The JSON keeps the full text.

/** True when `text` has a raw control character other than the newline between lines. */
function hasRawControl(text: string): boolean {
  return [...text].some((ch) => {
    const code = ch.charCodeAt(0);
    return (code < 0x20 && code !== 0x0a) || code === 0x7f || code === 0x2028 || code === 0x2029;
  });
}

it(
  '[CT-06zzzzv] related-report CLI: a test name with a newline, a tab, ESC and U+2028 prints on one line, escaped; the JSON keeps it',
  () => {
    const title = 'bad\nname\twith \u001b[31mred\u001b[0m and\u2028more';
    const res = cli(
      writeJson(
        'control.json',
        report([file('test/spec/ctl.test.ts', 'failed', [assertion(['suite'], title, 'failed')])]),
      ),
    );
    expect(res.status, res.stderr).toBe(1);
    expect(hasRawControl(res.stderr)).toBe(false);
    const printed = res.stderr.split('\n').filter((l) => l.startsWith('test/spec/ctl.test.ts'));
    expect(printed).toHaveLength(1);
    const line = printed[0] ?? '';
    expect(line).toContain('suite > bad\\nname\\twith ');
    expect(line).toMatch(/\\(x1b|u001b)\[31mred/i);
    expect(line).toMatch(/and\\u2028more/i);
    // No other line carries a piece of the name.
    expect(res.stderr.split('\n').filter((l) => l.includes('name'))).toHaveLength(1);
    const summary = JSON.parse(res.stdout) as { failed: { test: string }[] };
    expect(summary.failed).toEqual([{ file: 'test/spec/ctl.test.ts', test: `suite > ${title}` }]);
  },
  CLI_TIMEOUT,
);

it(
  '[CT-06zzzzv] related-report CLI: a load-error message with control characters prints on one line, escaped',
  () => {
    const res = cli(
      writeJson(
        'control-load.json',
        report([
          file(
            'test/spec/broken.test.ts',
            'failed',
            [],
            '\u001b[31mError\u001b[0m: bad\r\u0000import\u2029x\nsecond line',
          ),
        ]),
      ),
    );
    expect(res.status, res.stderr).toBe(1);
    expect(hasRawControl(res.stderr)).toBe(false);
    const printed = res.stderr.split('\n').filter((l) => l.includes('test/spec/broken.test.ts'));
    expect(printed).toHaveLength(1);
    expect(printed[0]).toMatch(/\\(x1b|u001b)\[31mError/i);
    expect(printed[0]).toContain('\\r');
    expect(printed[0]).toMatch(/\\(x00|u0000)import/i);
    expect(printed[0]).not.toContain('second line');
  },
  CLI_TIMEOUT,
);

it(
  '[CT-06zzzzv] related-report CLI: a printed line is cut to 500 characters and ends in "…"; the JSON keeps the whole name',
  () => {
    const title = `long ${'x'.repeat(2000)}`;
    const res = cli(
      writeJson(
        'long-name.json',
        report([file('test/spec/long.test.ts', 'failed', [assertion([], title, 'failed')])]),
      ),
    );
    expect(res.status, res.stderr).toBe(1);
    const printed = res.stderr.split('\n').filter((l) => l.startsWith('test/spec/long.test.ts'));
    expect(printed).toHaveLength(1);
    const line = printed[0] ?? '';
    expect(line.endsWith('…')).toBe(true);
    expect(line.length).toBeLessThanOrEqual(501);
    expect(line.length).toBeGreaterThanOrEqual(499);
    expect(line.startsWith('test/spec/long.test.ts > long xxx')).toBe(true);
    // A short line is not touched.
    const short = cli(
      writeJson(
        'short-name.json',
        report([file('test/spec/short.test.ts', 'failed', [assertion([], 'short', 'failed')])]),
      ),
    );
    expect(short.stderr.split('\n')).toContain('test/spec/short.test.ts > short');
    const summary = JSON.parse(res.stdout) as { failed: { test: string }[] };
    expect(summary.failed[0]?.test).toBe(title);
  },
  CLI_TIMEOUT,
);

it(
  '[CT-06zzzzv] related-report CLI: 201 red tests print exactly 200 lines and one "… and 1 more in related.json"',
  () => {
    const many = Array.from({ length: 201 }, (_, i) =>
      assertion([], `t${String(i).padStart(3, '0')}`, 'failed'),
    );
    const res = cli(
      writeJson('many-red.json', report([file('test/spec/many.test.ts', 'failed', many)])),
    );
    expect(res.status, res.stderr).toBe(1);
    const lines = res.stderr.split('\n').filter((l) => l !== '');
    expect(lines.filter((l) => l.startsWith('test/spec/many.test.ts > '))).toHaveLength(200);
    expect(lines).toContain('… and 1 more in related.json');
    expect(lines.filter((l) => l.startsWith('… and '))).toHaveLength(1);
    // The JSON has all 201.
    const summary = JSON.parse(res.stdout) as { failed: unknown[] };
    expect(summary.failed).toHaveLength(201);
    // 200 exactly: no summary line.
    const two = cli(
      writeJson(
        'two-hundred-red.json',
        report([file('test/spec/many.test.ts', 'failed', many.slice(0, 200))]),
      ),
    );
    const twoLines = two.stderr.split('\n').filter((l) => l !== '');
    expect(twoLines.filter((l) => l.startsWith('test/spec/many.test.ts > '))).toHaveLength(200);
    expect(twoLines.filter((l) => l.startsWith('… and '))).toHaveLength(0);
  },
  CLI_TIMEOUT,
);

// --- CT-06zzzzz ⑤ (D10-1350): bidirectional controls and C1 controls are escaped too ---------------
// U+202A–U+202E, U+2066–U+2069 (they reorder what a terminal shows) and U+0080–U+009F (C1; U+0085 is
// a line break to some readers) become visible escapes like the existing ones: ‮, \x85.

const BIDI = [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069].map((c) =>
  String.fromCharCode(c),
);
const C1 = Array.from({ length: 0x20 }, (_, i) => String.fromCharCode(0x80 + i));

function hasBidiOrC1(text: string): boolean {
  return [...text].some((ch) => BIDI.includes(ch) || C1.includes(ch));
}

it('[CT-06zzzzz] printableLine escapes U+202A–U+202E, U+2066–U+2069 as \\uXXXX and U+0080–U+009F as \\xHH', () => {
  for (const ch of BIDI) {
    const code = ch.charCodeAt(0).toString(16);
    const line = printableLine(`a${ch}b`);
    expect(hasBidiOrC1(line), code).toBe(false);
    expect(line.toLowerCase(), code).toBe(`a\\u${code}b`);
  }
  for (const ch of C1) {
    const code = ch.charCodeAt(0).toString(16).padStart(2, '0');
    const line = printableLine(`a${ch}b`);
    expect(hasBidiOrC1(line), code).toBe(false);
    expect(line.toLowerCase(), code).toBe(`a\\x${code}b`);
  }
  // Neighbours stay as they are: U+00A0, U+00E9, U+2029's neighbour U+202F, U+2065, U+206A, CJK.
  for (const ch of [' ', 'é', ' ', '⁥', '⁪', '名']) {
    expect(printableLine(`a${ch}b`)).toBe(`a${ch}b`);
  }
});

it(
  '[CT-06zzzzz] related-report CLI: a red test named with U+202E and U+0085 is one line on stderr, escaped, without the raw characters; the JSON keeps it',
  () => {
    const title = 'evil‮desrever and\u0085next line ⁦iso⁩';
    const res = cli(
      writeJson(
        'bidi-c1.json',
        report([file('test/spec/bidi.test.ts', 'failed', [assertion(['s'], title, 'failed')])]),
      ),
    );
    expect(res.status, res.stderr).toBe(1);
    expect(hasBidiOrC1(res.stderr)).toBe(false);
    expect(hasRawControl(res.stderr)).toBe(false);
    const printed = res.stderr.split('\n').filter((l) => l.startsWith('test/spec/bidi.test.ts'));
    expect(printed).toHaveLength(1);
    const line = (printed[0] ?? '').toLowerCase();
    expect(line).toContain('evil\\u202edesrever');
    expect(line).toContain('and\\x85next line');
    expect(line).toContain('\\u2066iso\\u2069');
    // Nothing of the name spills onto another line.
    expect(res.stderr.split('\n').filter((l) => l.includes('next line'))).toHaveLength(1);
    const summary = JSON.parse(res.stdout) as { failed: { test: string }[] };
    expect(summary.failed).toEqual([{ file: 'test/spec/bidi.test.ts', test: `s > ${title}` }]);
  },
  CLI_TIMEOUT,
);

it(
  '[CT-06zzzzz] related-report CLI: a load-error message with U+202E and U+0085 prints on one line, escaped',
  () => {
    const res = cli(
      writeJson(
        'bidi-c1-load.json',
        report([
          file('test/spec/bidi-load.test.ts', 'failed', [], 'Error: ‮kcatta\u0085 x\nsecond'),
        ]),
      ),
    );
    expect(res.status, res.stderr).toBe(1);
    expect(hasBidiOrC1(res.stderr)).toBe(false);
    const printed = res.stderr.split('\n').filter((l) => l.includes('test/spec/bidi-load.test.ts'));
    expect(printed).toHaveLength(1);
    expect((printed[0] ?? '').toLowerCase()).toContain('error: \\u202ekcatta\\x85 x');
  },
  CLI_TIMEOUT,
);
