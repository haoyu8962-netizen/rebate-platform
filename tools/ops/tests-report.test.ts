// CT-06zzzzz (D10-1319 / D10-1334): tools/ops/tests-report.ts — the trusted summary of a
// verify-container.sh --tests run. For every group of the plan (red-plan.ts output) it reads
// <out>/<group>.exit, <group>.seconds and <group>.vitest-report.json (written by untrusted code:
// regular files only, small files at most 32 bytes holding an integer) and prints
//   { files, tests, duration_s, failed: [{file, test}], load_errors: [{file, message}],
//     groups: [{ name, database, files, tests, exit, duration_s, failed, load_errors, status }],
//     status }
// Exit 0 green, 1 red (each red test / load-error file on stderr, cleaned as related-report.ts does,
// at most 200 lines, then "… and <N> more in tests.json"), 2 usage, a missing or irregular file, a
// report of the wrong shape, a group that ran past the time limit (124), or a group that failed
// while its report shows nothing red.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { CLI_TIMEOUT, OPS_DIR, removeDir, scratchDir } from './test-helpers.ts';

const ROOT = '/work/repo';

type PlanGroup = { name: string; dir: string; database: boolean; files: string[] };
type Test = { ancestors?: string[]; title: string; status: string };
type ReportFile = { rel: string; status: string; tests: Test[]; message?: string };
type OutFile = { text: string } | { symlink: string } | { fifo: true } | { dir: true };

const UNIT: PlanGroup = {
  name: 'spec-unit',
  dir: 'test',
  database: false,
  files: ['spec/alpha/one.test.ts', 'spec/alpha/two.test.ts'],
};
/** spec-unit planned with one.test.ts only: for the cases whose report lists just that file. */
const UNIT_ONE: PlanGroup = { ...UNIT, files: ['spec/alpha/one.test.ts'] };
const INT: PlanGroup = {
  name: 'spec-int',
  dir: 'test',
  database: true,
  files: ['spec/alpha/three.int.test.ts'],
};
const TESTING: PlanGroup = {
  name: 'testing-unit',
  dir: 'packages/testing',
  database: false,
  files: ['src/five.test.ts'],
};

/** A Vitest `--reporter=json` report as the container writes it (absolute paths under ROOT). */
function vitestReport(files: ReportFile[]): string {
  const all = files.flatMap((f) => f.tests);
  return JSON.stringify({
    numTotalTests: all.length,
    numFailedTests: all.filter((t) => t.status === 'failed').length,
    numPassedTests: all.filter((t) => t.status === 'passed').length,
    success: all.every((t) => t.status !== 'failed'),
    testResults: files.map((f) => ({
      name: `${ROOT}/${f.rel}`,
      status: f.status,
      message: f.message ?? '',
      assertionResults: f.tests.map((t) => ({
        ancestorTitles: t.ancestors ?? [],
        title: t.title,
        fullName: [...(t.ancestors ?? []), t.title].join(' '),
        status: t.status,
      })),
    })),
  });
}

const UNIT_GREEN = vitestReport([
  {
    rel: 'test/spec/alpha/one.test.ts',
    status: 'passed',
    tests: [
      { ancestors: ['one'], title: '[AC-T-01] a', status: 'passed' },
      { title: '[AC-T-01] b', status: 'passed' },
    ],
  },
  {
    rel: 'test/spec/alpha/two.test.ts',
    status: 'passed',
    tests: [{ title: '[AC-T-02] c', status: 'passed' }],
  },
]);
const UNIT_RED = vitestReport([
  {
    rel: 'test/spec/alpha/one.test.ts',
    status: 'failed',
    tests: [
      { ancestors: ['one'], title: '[AC-T-01] a', status: 'failed' },
      { title: '[AC-T-01] b', status: 'passed' },
    ],
  },
  {
    rel: 'test/spec/alpha/two.test.ts',
    status: 'passed',
    tests: [{ title: '[AC-T-02] c', status: 'passed' }],
  },
]);
const INT_GREEN = vitestReport([
  {
    rel: 'test/spec/alpha/three.int.test.ts',
    status: 'passed',
    tests: [{ title: '[AC-T-03] d', status: 'passed' }],
  },
]);
const INT_LOAD_ERROR = vitestReport([
  {
    rel: 'test/spec/alpha/three.int.test.ts',
    status: 'failed',
    tests: [],
    message: "Error: Cannot find module '../x.ts'\n    at load (file.js:1:1)",
  },
]);
const TESTING_GREEN = vitestReport([
  {
    rel: 'packages/testing/src/five.test.ts',
    status: 'passed',
    tests: [{ title: 'five', status: 'passed' }],
  },
]);

let dir = '';
let cases = 0;

beforeAll(() => {
  dir = scratchDir('tests-report');
});
afterAll(() => removeDir(dir));

/** Group files for one group: exit code, seconds and report as text (null leaves one out). */
function groupFiles(
  name: string,
  exit: string | null,
  seconds: string | null,
  report: string | null,
): Record<string, OutFile> {
  const files: Record<string, OutFile> = {};
  if (exit !== null) files[`${name}.exit`] = { text: `${exit}\n` };
  if (seconds !== null) files[`${name}.seconds`] = { text: `${seconds}\n` };
  if (report !== null) files[`${name}.vitest-report.json`] = { text: report };
  return files;
}

/** A plan file and an out directory holding `files`; returns the CLI arguments. */
function setup(
  groups: PlanGroup[],
  files: Record<string, OutFile>,
  extra: string[] = [],
): string[] {
  cases += 1;
  const caseDir = join(dir, `case-${String(cases)}`);
  const out = join(caseDir, 'out');
  mkdirSync(out, { recursive: true });
  const plan = join(caseDir, 'plan.json');
  writeFileSync(
    plan,
    JSON.stringify({
      groups: groups.map((g) => ({
        name: g.name,
        dir: g.dir,
        config: g.database ? 'vitest.integration.config.ts' : 'vitest.config.ts',
        database: g.database,
        browser: false,
        files: g.files,
      })),
    }),
  );
  for (const [name, how] of Object.entries(files)) {
    const p = join(out, name);
    if ('text' in how) writeFileSync(p, how.text);
    else if ('symlink' in how) symlinkSync(how.symlink, p);
    else if ('fifo' in how) expect(spawnSync('mkfifo', [p]).status).toBe(0);
    else mkdirSync(p);
  }
  return ['--plan', plan, '--out', out, '--root', ROOT, ...extra];
}

/** The CLI with a time limit: one that opens a FIFO would hang. */
function cli(args: string[]) {
  const res = spawnSync(process.execPath, [join(OPS_DIR, 'tests-report.ts'), ...args], {
    encoding: 'utf8',
    timeout: 15_000,
    killSignal: 'SIGKILL',
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: res.status ?? -1, stdout: res.stdout, stderr: res.stderr, signal: res.signal };
}

type Summary = {
  files: number;
  tests: number;
  duration_s: number;
  failed: { file: string; test: string }[];
  load_errors: { file: string; message: string }[];
  groups: Record<string, unknown>[];
  status: string;
};

// --- green, red, load errors ------------------------------------------------------------------------

it(
  '[CT-06zzzzz] tests-report CLI: all groups green → exit 0, the summary on stdout (totals and one entry per plan group, in plan order)',
  () => {
    const args = setup([UNIT, INT, TESTING], {
      ...groupFiles('spec-unit', '0', '5', UNIT_GREEN),
      ...groupFiles('spec-int', '0', '7', INT_GREEN),
      ...groupFiles('testing-unit', '0', '3', TESTING_GREEN),
    });
    const res = cli(args);
    expect(res.status, res.stderr).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual({
      files: 4,
      tests: 5,
      duration_s: 15,
      failed: [],
      load_errors: [],
      groups: [
        {
          name: 'spec-unit',
          database: false,
          files: 2,
          tests: 3,
          exit: 0,
          duration_s: 5,
          failed: [],
          load_errors: [],
          status: 'green',
        },
        {
          name: 'spec-int',
          database: true,
          files: 1,
          tests: 1,
          exit: 0,
          duration_s: 7,
          failed: [],
          load_errors: [],
          status: 'green',
        },
        {
          name: 'testing-unit',
          database: false,
          files: 1,
          tests: 1,
          exit: 0,
          duration_s: 3,
          failed: [],
          load_errors: [],
          status: 'green',
        },
      ],
      status: 'green',
    });
    // Nothing red to list.
    expect(res.stderr.split('\n').filter((l) => l.includes(' > '))).toEqual([]);
  },
  CLI_TIMEOUT,
);

it(
  '[CT-06zzzzz] tests-report CLI: a red test and a load error → exit 1; files relative to --root; each on stderr ("file > full name", the load-error file)',
  () => {
    const args = setup([UNIT, INT], {
      ...groupFiles('spec-unit', '1', '5', UNIT_RED),
      ...groupFiles('spec-int', '1', '7', INT_LOAD_ERROR),
    });
    const res = cli(args);
    expect(res.status, res.stderr).toBe(1);
    const summary = JSON.parse(res.stdout) as Summary;
    expect(summary.status).toBe('red');
    expect(summary.failed).toEqual([
      { file: 'test/spec/alpha/one.test.ts', test: 'one > [AC-T-01] a' },
    ]);
    expect(summary.load_errors).toEqual([
      { file: 'test/spec/alpha/three.int.test.ts', message: "Error: Cannot find module '../x.ts'" },
    ]);
    expect(summary).toMatchObject({ files: 3, tests: 3, duration_s: 12 });
    expect(summary.groups).toEqual([
      {
        name: 'spec-unit',
        database: false,
        files: 2,
        tests: 3,
        exit: 1,
        duration_s: 5,
        failed: [{ file: 'test/spec/alpha/one.test.ts', test: 'one > [AC-T-01] a' }],
        load_errors: [],
        status: 'red',
      },
      {
        name: 'spec-int',
        database: true,
        files: 1,
        tests: 0,
        exit: 1,
        duration_s: 7,
        failed: [],
        load_errors: [
          {
            file: 'test/spec/alpha/three.int.test.ts',
            message: "Error: Cannot find module '../x.ts'",
          },
        ],
        status: 'red',
      },
    ]);
    const lines = res.stderr.split('\n');
    expect(lines).toContain('test/spec/alpha/one.test.ts > one > [AC-T-01] a');
    const load = lines.filter((l) => l.startsWith('test/spec/alpha/three.int.test.ts'));
    expect(load).toHaveLength(1);
    expect(load[0]).toContain("Cannot find module '../x.ts'");
    // The green test and the absolute container path are not listed.
    expect(res.stderr).not.toContain('[AC-T-01] b');
    expect(res.stderr).not.toContain(`${ROOT}/`);
  },
  CLI_TIMEOUT,
);

it(
  '[CT-06zzzzz] tests-report CLI: one red group among green ones makes the whole run red; the green group stays green',
  () => {
    const args = setup([UNIT, TESTING], {
      ...groupFiles('spec-unit', '1', '5', UNIT_RED),
      ...groupFiles('testing-unit', '0', '3', TESTING_GREEN),
    });
    const res = cli(args);
    expect(res.status, res.stderr).toBe(1);
    const summary = JSON.parse(res.stdout) as Summary;
    expect(summary.status).toBe('red');
    expect(summary.groups.map((g) => [g['name'], g['status']])).toEqual([
      ['spec-unit', 'red'],
      ['testing-unit', 'green'],
    ]);
  },
  CLI_TIMEOUT,
);

// --- exit 2: the time limit, a failed group with nothing red ------------------------------------------

it(
  '[CT-06zzzzz] tests-report CLI: a group whose exit is 124 → exit 2 naming the group and the time limit, also when its report has a red test',
  () => {
    for (const report of [UNIT_GREEN, UNIT_RED]) {
      const res = cli(setup([UNIT], groupFiles('spec-unit', '124', '600', report)));
      expect(res.status, res.stderr).toBe(2);
      expect(res.stdout).toBe('');
      expect(res.stderr).toContain('spec-unit');
      expect(res.stderr).toMatch(/time limit|timed out/i);
    }
    // One timed-out group among green ones is enough.
    const mixed = cli(
      setup([UNIT, TESTING], {
        ...groupFiles('spec-unit', '0', '5', UNIT_GREEN),
        ...groupFiles('testing-unit', '124', '600', TESTING_GREEN),
      }),
    );
    expect(mixed.status, mixed.stderr).toBe(2);
    expect(mixed.stdout).toBe('');
    expect(mixed.stderr).toContain('testing-unit');
  },
  CLI_TIMEOUT,
);

it(
  '[CT-06zzzzz] tests-report CLI: a group that exited non-zero while its report has no failed test and no load error → exit 2 naming the group and its exit code',
  () => {
    const res = cli(setup([UNIT], groupFiles('spec-unit', '7', '5', UNIT_GREEN)));
    expect(res.status, res.stderr).toBe(2);
    expect(res.stdout).toBe('');
    expect(res.stderr).toContain('spec-unit');
    expect(res.stderr).toMatch(/\b7\b/);
    expect(res.stderr).not.toMatch(/time limit|timed out/i);
  },
  CLI_TIMEOUT,
);

// --- exit 2: the files in out/ (untrusted code writes there) ------------------------------------------

it(
  '[CT-06zzzzz] tests-report CLI: a missing <group>.exit, .seconds or .vitest-report.json → exit 2 naming that file',
  () => {
    const missing: [string, Record<string, OutFile>][] = [
      ['spec-unit.exit', groupFiles('spec-unit', null, '5', UNIT_GREEN)],
      ['spec-unit.seconds', groupFiles('spec-unit', '0', null, UNIT_GREEN)],
      ['spec-unit.vitest-report.json', groupFiles('spec-unit', '0', '5', null)],
    ];
    for (const [name, files] of missing) {
      const res = cli(setup([UNIT], files));
      expect(res.status, `${name}: ${res.stderr}`).toBe(2);
      expect(res.stdout, name).toBe('');
      expect(res.stderr, name).toContain(name);
    }
    // A second group's file missing is just as fatal.
    const second = cli(
      setup([UNIT, TESTING], {
        ...groupFiles('spec-unit', '0', '5', UNIT_GREEN),
        ...groupFiles('testing-unit', '0', '3', null),
      }),
    );
    expect(second.status, second.stderr).toBe(2);
    expect(second.stderr).toContain('testing-unit.vitest-report.json');
  },
  CLI_TIMEOUT,
);

it(
  '[CT-06zzzzz] tests-report CLI: .exit, .seconds or the report as a symbolic link (to a valid file), a FIFO or a directory → exit 2 without hanging',
  () => {
    const valid = join(dir, 'valid');
    mkdirSync(valid, { recursive: true });
    writeFileSync(join(valid, 'zero'), '0\n');
    writeFileSync(join(valid, 'report.json'), UNIT_GREEN);
    const targets: Record<string, string> = {
      'spec-unit.exit': join(valid, 'zero'),
      'spec-unit.seconds': join(valid, 'zero'),
      'spec-unit.vitest-report.json': join(valid, 'report.json'),
    };
    for (const [name, target] of Object.entries(targets)) {
      for (const how of [{ symlink: target }, { fifo: true }, { dir: true }] as OutFile[]) {
        const files = groupFiles('spec-unit', '0', '5', UNIT_GREEN);
        files[name] = how;
        const label = `${name} as ${Object.keys(how)[0] ?? ''}`;
        const res = cli(setup([UNIT], files));
        expect(res.signal, `${label}: tests-report hung`).toBeNull();
        expect(res.status, `${label}: ${res.stderr}`).toBe(2);
        expect(res.stdout, label).toBe('');
        expect(res.stderr, label).toContain(name);
      }
    }
  },
  CLI_TIMEOUT * 3,
);

it(
  '[CT-06zzzzz] tests-report CLI: .exit and .seconds must hold an integer (whitespace aside) in at most 32 bytes',
  () => {
    // Exact file contents (no trailing newline added).
    const exact = (exit: string, seconds: string) => ({
      'spec-unit.exit': { text: exit },
      'spec-unit.seconds': { text: seconds },
      'spec-unit.vitest-report.json': { text: UNIT_GREEN },
    });
    // 31 spaces and one digit: 32 bytes, accepted; so is a digit with a newline.
    const okExact = cli(setup([UNIT], exact(`${' '.repeat(31)}0`, '5')));
    expect(okExact.status, okExact.stderr).toBe(0);
    const okLine = cli(setup([UNIT], exact('0\n', ` 5 \n`)));
    expect(okLine.status, okLine.stderr).toBe(0);
    expect((JSON.parse(okLine.stdout) as Summary).duration_s).toBe(5);
    for (const [label, files, name] of [
      ['33 bytes', exact(`${' '.repeat(32)}0`, '5'), 'spec-unit.exit'],
      ['abc', exact('abc\n', '5'), 'spec-unit.exit'],
      ['empty', exact('', '5'), 'spec-unit.exit'],
      ['1.5', exact('1.5\n', '5'), 'spec-unit.exit'],
      ['0 1', exact('0 1\n', '5'), 'spec-unit.exit'],
      ['seconds abc', exact('0\n', 'abc\n'), 'spec-unit.seconds'],
      ['seconds 33 bytes', exact('0\n', `${' '.repeat(32)}5`), 'spec-unit.seconds'],
    ] as [string, Record<string, OutFile>, string][]) {
      const res = cli(setup([UNIT], files));
      expect(res.status, `${label}: ${res.stderr}`).toBe(2);
      expect(res.stdout, label).toBe('');
      expect(res.stderr, label).toContain(name);
    }
  },
  CLI_TIMEOUT * 2,
);

it(
  '[CT-06zzzzz] tests-report CLI: a report that is not JSON or not the expected shape → exit 2',
  () => {
    const notJson = cli(setup([UNIT], groupFiles('spec-unit', '1', '5', '{ not json')));
    expect(notJson.status, notJson.stderr).toBe(2);
    expect(notJson.stdout).toBe('');
    const shape = cli(setup([UNIT], groupFiles('spec-unit', '1', '5', '{"testResults":"x"}')));
    expect(shape.status, shape.stderr).toBe(2);
    expect(shape.stdout).toBe('');
    // The shape check of related-report.ts (reused, not copied) names what is wrong.
    expect(shape.stderr).toContain('testResults');
    const noCount = cli(
      setup(
        [UNIT],
        groupFiles('spec-unit', '0', '5', JSON.stringify({ testResults: [], numFailedTests: 0 })),
      ),
    );
    expect(noCount.status, noCount.stderr).toBe(2);
    expect(noCount.stderr).toContain('numTotalTests');
  },
  CLI_TIMEOUT,
);

it(
  '[CT-06zzzzz] tests-report CLI: --max-report-bytes caps each report (equal passes, one byte over exits 2)',
  () => {
    const size = Buffer.byteLength(UNIT_GREEN);
    const at = cli(
      setup([UNIT], groupFiles('spec-unit', '0', '5', UNIT_GREEN), [
        '--max-report-bytes',
        String(size),
      ]),
    );
    expect(at.status, at.stderr).toBe(0);
    const over = cli(
      setup([UNIT], groupFiles('spec-unit', '0', '5', UNIT_GREEN), [
        '--max-report-bytes',
        String(size - 1),
      ]),
    );
    expect(over.status, over.stderr).toBe(2);
    expect(over.stdout).toBe('');
    expect(over.stderr).toContain('spec-unit.vitest-report.json');
    // The second group's report is capped as well.
    const second = cli(
      setup(
        [TESTING, UNIT],
        {
          ...groupFiles('testing-unit', '0', '3', TESTING_GREEN),
          ...groupFiles('spec-unit', '0', '5', UNIT_GREEN),
        },
        ['--max-report-bytes', String(size - 1)],
      ),
    );
    expect(second.status, second.stderr).toBe(2);
    // Not a count: usage error.
    const bad = cli(
      setup([UNIT], groupFiles('spec-unit', '0', '5', UNIT_GREEN), ['--max-report-bytes', 'x']),
    );
    expect(bad.status).toBe(2);
    expect(bad.stdout).toBe('');
  },
  CLI_TIMEOUT,
);

it(
  '[CT-06zzzzz] tests-report CLI: usage errors (no --plan, --out or --root; a plan that is not { groups: [...] }) exit 2',
  () => {
    const args = setup([UNIT], groupFiles('spec-unit', '0', '5', UNIT_GREEN));
    const value = (flag: string) => args[args.indexOf(flag) + 1] ?? '';
    const without = (flag: string) => {
      const i = args.indexOf(flag);
      return [...args.slice(0, i), ...args.slice(i + 2)];
    };
    expect(cli(args).status).toBe(0);
    for (const flag of ['--plan', '--out', '--root']) {
      const res = cli(without(flag));
      expect(res.status, flag).toBe(2);
      expect(res.stdout, flag).toBe('');
    }
    expect(cli([...without('--root'), '--root', '']).status).toBe(2);
    for (const doc of ['{}', '{"groups":"x"}', 'not json', '{"groups":[{"name":7}]}']) {
      writeFileSync(value('--plan'), doc);
      const res = cli(args);
      expect(res.status, doc).toBe(2);
      expect(res.stdout, doc).toBe('');
    }
  },
  CLI_TIMEOUT,
);

// --- the lines on stderr: cleaned exactly as related-report.ts cleans them -------------------------

/** True when `text` has a raw control (C0 but the newline, DEL, C1), U+2028/9 or a bidi control. */
function hasRaw(text: string): boolean {
  return [...text].some((ch) => {
    const c = ch.charCodeAt(0);
    return (
      (c < 0x20 && c !== 0x0a) ||
      (c >= 0x7f && c <= 0x9f) ||
      c === 0x2028 ||
      c === 0x2029 ||
      (c >= 0x202a && c <= 0x202e) ||
      (c >= 0x2066 && c <= 0x2069)
    );
  });
}

it(
  '[CT-06zzzzz] tests-report CLI: a red test named with a newline, ESC, U+2028, U+202E, U+2066 and U+0085 is one escaped line on stderr; the JSON keeps it',
  () => {
    const title = 'bad\nname \u001b[31mred \u2028sep \u202Eevil \u2066iso\u2069 \u0085nel';
    const report = vitestReport([
      {
        rel: 'test/spec/alpha/one.test.ts',
        status: 'failed',
        tests: [{ ancestors: ['s'], title, status: 'failed' }],
      },
    ]);
    const res = cli(setup([UNIT_ONE], groupFiles('spec-unit', '1', '5', report)));
    expect(res.status, res.stderr).toBe(1);
    expect(hasRaw(res.stderr)).toBe(false);
    const printed = res.stderr
      .split('\n')
      .filter((l) => l.startsWith('test/spec/alpha/one.test.ts > '));
    expect(printed).toHaveLength(1);
    const line = (printed[0] ?? '').toLowerCase();
    expect(line).toContain('s > bad\\nname ');
    expect(line).toMatch(/\\(x1b|u001b)\[31mred/);
    expect(line).toContain('\\u2028sep');
    expect(line).toContain('\\u202eevil');
    expect(line).toContain('\\u2066iso\\u2069');
    expect(line).toContain('\\x85nel');
    expect(res.stderr.split('\n').filter((l) => l.includes('name'))).toHaveLength(1);
    const summary = JSON.parse(res.stdout) as Summary;
    expect(summary.failed).toEqual([{ file: 'test/spec/alpha/one.test.ts', test: `s > ${title}` }]);
  },
  CLI_TIMEOUT,
);

it(
  '[CT-06zzzzz] tests-report CLI: a load-error message with control and bidi characters is one escaped line',
  () => {
    const report = vitestReport([
      {
        rel: 'test/spec/alpha/three.int.test.ts',
        status: 'failed',
        tests: [],
        message: '\u001b[31mError\u001b[0m: \u202Ekcatta\u0085 x\r\u0000y\nsecond line',
      },
    ]);
    const res = cli(setup([INT], groupFiles('spec-int', '1', '5', report)));
    expect(res.status, res.stderr).toBe(1);
    expect(hasRaw(res.stderr)).toBe(false);
    const printed = res.stderr
      .split('\n')
      .filter((l) => l.includes('test/spec/alpha/three.int.test.ts'));
    expect(printed).toHaveLength(1);
    const line = (printed[0] ?? '').toLowerCase();
    expect(line).toContain('\\u202ekcatta\\x85 x\\r');
    expect(line).toMatch(/\\(x00|u0000)y/);
    expect(line).not.toContain('second line');
  },
  CLI_TIMEOUT,
);

it(
  '[CT-06zzzzz] tests-report CLI: a printed line is cut to 500 characters ending in "…"; the JSON keeps the whole name',
  () => {
    const title = `long ${'x'.repeat(2000)}`;
    const report = vitestReport([
      {
        rel: 'test/spec/alpha/one.test.ts',
        status: 'failed',
        tests: [{ title, status: 'failed' }],
      },
    ]);
    const res = cli(setup([UNIT_ONE], groupFiles('spec-unit', '1', '5', report)));
    expect(res.status, res.stderr).toBe(1);
    const printed = res.stderr
      .split('\n')
      .filter((l) => l.startsWith('test/spec/alpha/one.test.ts'));
    expect(printed).toHaveLength(1);
    const line = printed[0] ?? '';
    expect(line.endsWith('…')).toBe(true);
    expect(line.length).toBeLessThanOrEqual(501);
    expect(line.length).toBeGreaterThanOrEqual(499);
    const summary = JSON.parse(res.stdout) as Summary;
    expect(summary.failed[0]?.test).toBe(title);
  },
  CLI_TIMEOUT,
);

it(
  '[CT-06zzzzz] tests-report CLI: 201 red tests across two groups print exactly 200 lines and "… and 1 more in tests.json"; 200 print no such line',
  () => {
    const red = (rel: string, n: number, prefix: string) =>
      vitestReport([
        {
          rel,
          status: 'failed',
          tests: Array.from({ length: n }, (_, i) => ({
            title: `${prefix}${String(i).padStart(3, '0')}`,
            status: 'failed',
          })),
        },
      ]);
    const many = cli(
      setup([UNIT_ONE, TESTING], {
        ...groupFiles('spec-unit', '1', '5', red('test/spec/alpha/one.test.ts', 150, 'u')),
        ...groupFiles('testing-unit', '1', '3', red('packages/testing/src/five.test.ts', 51, 't')),
      }),
    );
    expect(many.status, many.stderr).toBe(1);
    const lines = many.stderr.split('\n').filter((l) => l !== '');
    const listed = lines.filter(
      (l) =>
        l.startsWith('test/spec/alpha/one.test.ts > ') ||
        l.startsWith('packages/testing/src/five.test.ts > '),
    );
    expect(listed).toHaveLength(200);
    expect(lines).toContain('… and 1 more in tests.json');
    expect(lines.filter((l) => l.startsWith('… and '))).toHaveLength(1);
    expect((JSON.parse(many.stdout) as Summary).failed).toHaveLength(201);

    const exactly = cli(
      setup([UNIT_ONE, TESTING], {
        ...groupFiles('spec-unit', '1', '5', red('test/spec/alpha/one.test.ts', 150, 'u')),
        ...groupFiles('testing-unit', '1', '3', red('packages/testing/src/five.test.ts', 50, 't')),
      }),
    );
    expect(exactly.status, exactly.stderr).toBe(1);
    const two = exactly.stderr.split('\n').filter((l) => l !== '');
    expect(two.filter((l) => l.includes(' > '))).toHaveLength(200);
    expect(two.filter((l) => l.startsWith('… and '))).toHaveLength(0);
  },
  CLI_TIMEOUT,
);

// --- round 3, S2 (D10-1388): every planned test file must have run, and nothing else -----------------
// The tree under test chooses the Vitest config: a narrowed include, passWithNoTests or a
// describe.skip of a whole file could leave planned files out while the run still reads green. Per
// group, the report's test files (relative to --root) are compared with the plan's (dir/file).

it(
  "[CT-06zzzzz] tests-report CLI: a planned file missing from its group's report (exit 0) → exit 2 naming the group and the missing file",
  () => {
    const onlyOne = vitestReport([
      {
        rel: 'test/spec/alpha/one.test.ts',
        status: 'passed',
        tests: [{ title: '[AC-T-01] a', status: 'passed' }],
      },
    ]);
    const res = cli(setup([UNIT], groupFiles('spec-unit', '0', '5', onlyOne)));
    expect(res.status, res.stderr).toBe(2);
    expect(res.stdout).toBe('');
    expect(res.stderr).toContain('spec-unit');
    expect(res.stderr).toContain('spec/alpha/two.test.ts');
    // The file that did run is not named as missing.
    expect(res.stderr).not.toContain('spec/alpha/one.test.ts');
    // Also next to a green group, and whatever the other group did.
    const mixed = cli(
      setup([TESTING, UNIT], {
        ...groupFiles('testing-unit', '0', '3', TESTING_GREEN),
        ...groupFiles('spec-unit', '0', '5', onlyOne),
      }),
    );
    expect(mixed.status, mixed.stderr).toBe(2);
    expect(mixed.stderr).toContain('spec/alpha/two.test.ts');
  },
  CLI_TIMEOUT,
);

it(
  '[CT-06zzzzz] tests-report CLI: more than 20 planned files missing → at most 20 named, the rest as a count',
  () => {
    const planned = Array.from(
      { length: 26 },
      (_, i) => `spec/many/f${String(i).padStart(2, '0')}.test.ts`,
    );
    const group: PlanGroup = { ...UNIT, files: planned };
    const report = vitestReport([
      {
        rel: `test/${planned[0] ?? ''}`,
        status: 'passed',
        tests: [{ title: 'ok', status: 'passed' }],
      },
    ]);
    const res = cli(setup([group], groupFiles('spec-unit', '0', '5', report)));
    expect(res.status, res.stderr).toBe(2);
    expect(res.stdout).toBe('');
    const named = planned.slice(1).filter((f) => res.stderr.includes(f));
    expect(named.length).toBeGreaterThanOrEqual(1);
    expect(named.length).toBeLessThanOrEqual(20);
    // 25 missing: 20 named, 5 counted.
    expect(res.stderr).toMatch(/\b5\b/);
  },
  CLI_TIMEOUT,
);

it(
  '[CT-06zzzzz] tests-report CLI: a group whose report has every planned file but 0 tests (and no load error) → exit 2 naming the group',
  () => {
    const empty = vitestReport([
      { rel: 'test/spec/alpha/one.test.ts', status: 'passed', tests: [] },
      { rel: 'test/spec/alpha/two.test.ts', status: 'passed', tests: [] },
    ]);
    const res = cli(
      setup([UNIT, TESTING], {
        ...groupFiles('spec-unit', '0', '5', empty),
        ...groupFiles('testing-unit', '0', '3', TESTING_GREEN),
      }),
    );
    expect(res.status, res.stderr).toBe(2);
    expect(res.stdout).toBe('');
    expect(res.stderr).toContain('spec-unit');
    expect(res.stderr).not.toContain('testing-unit');
  },
  CLI_TIMEOUT,
);

it(
  '[CT-06zzzzz] tests-report CLI: a report with a test file the group did not plan → exit 2 naming that file',
  () => {
    const extra = vitestReport([
      {
        rel: 'test/spec/alpha/one.test.ts',
        status: 'passed',
        tests: [{ title: 'a', status: 'passed' }],
      },
      {
        rel: 'test/spec/alpha/two.test.ts',
        status: 'passed',
        tests: [{ title: 'c', status: 'passed' }],
      },
      {
        rel: 'test/spec/elsewhere/other.test.ts',
        status: 'passed',
        tests: [{ title: 'o', status: 'passed' }],
      },
    ]);
    const res = cli(setup([UNIT], groupFiles('spec-unit', '0', '5', extra)));
    expect(res.status, res.stderr).toBe(2);
    expect(res.stdout).toBe('');
    expect(res.stderr).toContain('spec/elsewhere/other.test.ts');
    // Another group's planned file in this group's report is just as foreign.
    const swapped = cli(
      setup([UNIT, TESTING], {
        ...groupFiles(
          'spec-unit',
          '0',
          '5',
          vitestReport([
            {
              rel: 'test/spec/alpha/one.test.ts',
              status: 'passed',
              tests: [{ title: 'a', status: 'passed' }],
            },
            {
              rel: 'test/spec/alpha/two.test.ts',
              status: 'passed',
              tests: [{ title: 'c', status: 'passed' }],
            },
            {
              rel: 'packages/testing/src/five.test.ts',
              status: 'passed',
              tests: [{ title: 'five', status: 'passed' }],
            },
          ]),
        ),
        ...groupFiles('testing-unit', '0', '3', TESTING_GREEN),
      }),
    );
    expect(swapped.status, swapped.stderr).toBe(2);
    expect(swapped.stderr).toContain('packages/testing/src/five.test.ts');
  },
  CLI_TIMEOUT,
);

it(
  '[CT-06zzzzz] tests-report CLI: a load error is still red (exit 1), not a missing file, even when its group then has 0 tests',
  () => {
    const res = cli(setup([INT], groupFiles('spec-int', '1', '5', INT_LOAD_ERROR)));
    expect(res.status, res.stderr).toBe(1);
    expect((JSON.parse(res.stdout) as Summary).status).toBe('red');
  },
  CLI_TIMEOUT,
);

it('[CT-06zzzzz] tests-report.ts reuses the parsing and cleaning of related-report.ts (imports it, no copy)', () => {
  // A copy would drift from related-report's checks and cleaning; the module imports them instead.
  const text = readFileSync(join(OPS_DIR, 'tests-report.ts'), 'utf8');
  expect(text).toMatch(/from '\.\/related-report\.ts'/);
  expect(text).not.toMatch(
    /function (printableLine|redLines|summarizeRelated|parseFile|parseAssertion)\b/,
  );
});
