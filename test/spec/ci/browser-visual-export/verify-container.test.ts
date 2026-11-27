import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  CLI_TIMEOUT,
  removeDir,
  scratchDir,
  writeFiles,
} from '../../../../tools/ops/test-helpers.ts';
import { runBrowser } from './kit.ts';

const REPORT = {
  'summary-app.json': Buffer.from('{"overThreshold":["account-light"]}\n'),
  'summary-admin.json': Buffer.from('{"overThreshold":[]}\n'),
  'summary-app.txt': Buffer.from('OVER\taccount-light\n'),
  'pages/account-light.json': Buffer.from('{"overThreshold":true,"diffPercent":8.5}\n'),
  'images/account-light.actual.png': Buffer.from([137, 80, 78, 71, 0, 255, 13, 10]),
  'images/account-light.diff.png': Buffer.from([137, 80, 78, 71, 255, 0, 10, 13]),
};

let root = '';
afterEach(() => {
  if (root !== '') removeDir(root);
  root = '';
});

function fixture(withReport: boolean): string {
  root = scratchDir('browser-visual-export');
  const report = join(root, 'generated report');
  if (withReport) {
    for (const [name, bytes] of Object.entries(REPORT)) {
      const file = join(report, name);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, bytes);
    }
  }
  return report;
}

function exportedFiles(runDir: string) {
  const out = join(runDir, 'out');
  const report = readdirSync(out, { withFileTypes: true }).find(
    (entry) => entry.name === 'visual-baseline',
  );
  if (report === undefined) return {};
  expect(report.isDirectory(), 'visual-baseline must not itself be a link').toBe(true);
  const dir = join(out, report.name);
  return Object.fromEntries(
    readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((entry) => !entry.isDirectory())
      .map((entry) => {
        const file = join(entry.parentPath, entry.name);
        return [relative(dir, file), entry.isFile() ? readFileSync(file) : null];
      }),
  );
}

function expectVerdict({ cli, log }: ReturnType<typeof runBrowser>, exitCode: number) {
  expect(cli.status, `${cli.stderr}\n${log}`).toBe(exitCode);
}

function expectCounts(
  { log, runDir }: ReturnType<typeof runBrowser>,
  exitCode: number,
  files: number,
  summaries: number,
) {
  const resultPath = join(runDir, 'result.json');
  expect(existsSync(resultPath), log).toBe(true);
  expect(JSON.parse(readFileSync(resultPath, 'utf8')) as unknown).toMatchObject({
    script: 'browser',
    exit_code: exitCode,
    visual_baseline: { files, summaries },
  });
  const loggedCounts = log
    .split('\n')
    .filter((line) => /visual[-_ ]baseline|截图比对/iu.test(line))
    .map((line) => line.replace(/^\[[^\]]+\]\s*/u, '').replaceAll(runDir, ''))
    .map((line) => (line.match(/\b\d+\b/gu) ?? []).sort());
  expect(loggedCounts, log).toContainEqual([String(files), String(summaries)].sort());
}

it.each([
  ['passing projects with a screenshot', 0, true, 0],
  ['a failed project with a screenshot', 17, true, 17],
  ['passing projects without a screenshot', 0, false, 1],
  ['a failed project without a screenshot', 17, false, 17],
] as const)(
  '[AC-CT-06zzzzzzzo#1] exports the complete report and preserves the verdict for %s',
  (_scenario, projectExit, screenshot, exitCode) => {
    fixture(true);
    const run = runBrowser(root, projectExit, screenshot);
    expectVerdict(run, exitCode);
    expect(existsSync(join(run.runDir, 'out/screenshots/page.png'))).toBe(screenshot);
    expect(existsSync(join(run.runDir, 'out/build-smoke.vitest-report.json'))).toBe(true);
    expect(exportedFiles(run.runDir)).toEqual(REPORT);
    expectCounts(run, exitCode, 6, 2);
  },
  CLI_TIMEOUT,
);

it(
  '[AC-CT-06zzzzzzzo#2] records zero files and summaries when the project did not create a report directory',
  () => {
    fixture(false);
    const run = runBrowser(root, 0);
    expectVerdict(run, 0);
    expectCounts(run, 0, 0, 0);
    expect(exportedFiles(run.runDir)).toEqual({});
  },
  CLI_TIMEOUT,
);

it(
  '[AC-CT-06zzzzzzzo#3] omits file, directory and dangling links from the exported report',
  () => {
    const report = fixture(true);
    const outside = join(root, 'outside the report');
    writeFiles(outside, { 'private.json': '{"fixture":"outside"}\n' });
    symlinkSync(join(outside, 'private.json'), join(report, 'summary-linked.json'));
    symlinkSync(outside, join(report, 'linked folder'), 'dir');
    symlinkSync('missing.png', join(report, 'images', 'dangling.png'));

    const run = runBrowser(root, 0);
    expectVerdict(run, 0);
    expect(exportedFiles(run.runDir)).toEqual(REPORT);
    expectCounts(run, 0, 6, 2);
  },
  CLI_TIMEOUT,
);

it(
  '[AC-CT-06zzzzzzzo#4] never traverses a report directory that is itself a symbolic link',
  () => {
    const report = fixture(false);
    const outside = join(root, 'outside the report');
    writeFiles(outside, { 'summary-outside.json': '{"fixture":"outside"}\n' });
    symlinkSync(outside, report, 'dir');

    const run = runBrowser(root, 0);
    expectVerdict(run, 0);
    expectCounts(run, 0, 0, 0);
    expect(exportedFiles(run.runDir)).toEqual({});
  },
  CLI_TIMEOUT,
);
