// CT-06zzzzzzza (FU-VERIFY-FULL-SHARDED): unit tests of tools/ci/int-shards.ts — the test:int
// segments of ci.yml, the test:int file count of a snapshot and the sum of Vitest JSON reports.
import { spawnSync } from 'node:child_process';
import { readFileSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { CLI_TIMEOUT, removeDir, scratchDir, writeFiles } from '../ops/test-helpers.ts';
import {
  countIntFiles,
  expectedReports,
  readIntShards,
  segmentReports,
  sumReports,
} from './int-shards.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const CLI = join(ROOT, 'tools/ci/int-shards.ts');
const shard = (i: number, n: number) =>
  `pnpm test:int --log-order=stream --filter=@couli/spec-tests -- --shard=${String(i)}/${String(n)}`;
const REST = "pnpm test:int --log-order=stream --filter='!@couli/spec-tests'";

function job(id: string, ...steps: string[]): string {
  return [`  ${id}:`, '    runs-on: ubuntu-latest', '    steps:', ...steps].join('\n');
}
const run = (cmd: string) => `      - run: ${cmd}`;
const workflow = (...jobs: string[]) => ['name: CI', 'on: push', 'jobs:', ...jobs, ''].join('\n');

let base = '';
beforeAll(() => {
  base = scratchDir('int-shards-unit');
});
afterAll(() => removeDir(base));

function cli(...args: string[]) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: 'utf8' });
}

it('[CT-06zzzzzzza] the real ci.yml: n = 6, segments 1…6 then rest, the commands as written', () => {
  const doc = readIntShards(readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8'));
  expect(doc.n).toBe(6);
  expect(doc.segments.map((s) => s.id)).toEqual(['1', '2', '3', '4', '5', '6', 'rest']);
  expect(doc.segments[0]?.command).toBe(shard(1, 6));
  expect(doc.segments[6]?.command).toBe(REST);
});

it('[CT-06zzzzzzza] reads run values, quoted values, block lines and ignores comments and other keys', () => {
  const text = workflow(
    job(
      'verify-int-2',
      '      # pnpm test:int --filter=@couli/spec-tests -- --shard=9/2 (a comment)',
      '      - name: pnpm test:int is mentioned in a name only',
      '      - run: |',
      `          ${shard(2, 2)}`,
    ),
    job('verify-int-1', `      - run: "${shard(1, 2)}"  # shard one`),
    job('verify-other', run(REST), run('pnpm test')),
  );
  expect(readIntShards(text)).toEqual({
    n: 2,
    segments: [
      { id: '1', command: shard(1, 2) },
      { id: '2', command: shard(2, 2) },
      { id: 'rest', command: REST },
    ],
  });
});

it('[CT-06zzzzzzza] the same text in a multi-line env value or a with: block is not a command', () => {
  const text = workflow(
    job(
      'verify-int-1',
      '      - name: diagnostics',
      '        env:',
      '          OLD_REST: |',
      `            ${REST}`,
      '          OLD_SHARD: >-',
      `            ${shard(1, 1)} -- --bail`,
      '        run: echo keep',
      '      - uses: some/action@v1',
      '        with:',
      '          script: |',
      `            ${REST}`,
      '      - run: >',
      `          ${shard(1, 1)}`,
    ),
    job(
      'verify-other',
      '      - env:',
      `          X: ${REST}`,
      '        run: |',
      '          echo a',
      `          ${REST}`,
    ),
  );
  expect(readIntShards(text)).toEqual({
    n: 1,
    segments: [
      { id: '1', command: shard(1, 1) },
      { id: 'rest', command: REST },
    ],
  });
  // With the run step gone, a rest command kept only in an env value does not count.
  const envOnly = workflow(
    job(
      'verify-int-1',
      run(shard(1, 1)),
      '      - env:',
      '          OLD: |',
      `            ${REST}`,
      '        run: echo x',
    ),
  );
  expect(() => readIntShards(envOnly)).toThrow(/one rest command/);
});

it.each([
  ['no jobs', 'name: x\n'],
  ['no verify-int job', workflow(job('build', run(REST)))],
  [
    'a test:int command of neither kind',
    workflow(job('verify-int-1', run(shard(1, 1)), run('pnpm test:int'))),
  ],
  [
    'a shard outside a verify-int job',
    workflow(job('verify-int-1', run(shard(1, 1)), run(REST)), job('other', run(shard(1, 1)))),
  ],
  [
    'two shard commands in one job',
    workflow(job('verify-int-1', run(shard(1, 1)), run(shard(1, 1)), run(REST))),
  ],
  [
    'a test:int command behind another command',
    workflow(job('verify-int-1', run(`cd x && ${shard(1, 1)}`), run(REST))),
  ],
  [
    'a sharded rest command',
    workflow(job('verify-int-1', run(shard(1, 1)), run(`${REST} -- --shard=1/1`))),
  ],
])('[CT-06zzzzzzza] rejects %s', (_why, text) => {
  expect(() => readIntShards(text)).toThrow();
});

it(
  '[CT-06zzzzzzza] CLI: one JSON line, exit 0; a bad workflow, a missing file or bad flags exit 2',
  () => {
    writeFiles(base, {
      'ok.yml': workflow(job('verify-int-1', run(shard(1, 1)), run(REST))),
      'bad.yml': workflow(job('verify-int-1', run(shard(1, 1)))),
    });
    const ok = cli('--workflow', join(base, 'ok.yml'));
    expect(ok.status, ok.stderr).toBe(0);
    expect(JSON.parse(ok.stdout)).toEqual({
      n: 1,
      segments: [
        { id: '1', command: shard(1, 1) },
        { id: 'rest', command: REST },
      ],
    });
    for (const args of [
      ['--workflow', join(base, 'bad.yml')],
      ['--workflow', join(base, 'missing.yml')],
      ['--workflow'],
      ['--bogus', 'x'],
      ['--workflow', join(base, 'ok.yml'), '--sum-reports', base],
    ]) {
      const res = cli(...args);
      expect(res.status, args.join(' ')).toBe(2);
      expect(res.stdout).toBe('');
      expect(res.stderr).toMatch(/^int-shards: /);
    }
  },
  CLI_TIMEOUT,
);

it('[CT-06zzzzzzza] countIntFiles: each test:int package with its include, nothing else', () => {
  const snap = join(base, 'snapshot');
  writeFiles(snap, {
    'package.json': JSON.stringify({ scripts: { 'test:int': 'turbo run test:int' } }),
    'test/package.json': JSON.stringify({
      name: '@couli/spec-tests',
      scripts: { 'test:int': 'v' },
    }),
    'test/spec/a/x.int.test.ts': '',
    'test/spec/y.int.test.ts': '',
    'test/spec/a/z.test.ts': '', // a unit rule test: not test:int
    'test/acceptance/b/w.test.ts': '',
    'test/smoke/s.int.test.ts': '',
    'test/smoke/t.smoke.test.ts': '',
    'test/other/o.int.test.ts': '',
    'test/spec/node_modules/p/q.int.test.ts': '',
    'test/.tmp/r.int.test.ts': '',
    'apps/api/package.json': JSON.stringify({ name: '@couli/api', scripts: { 'test:int': 'v' } }),
    'apps/api/src/m/a.int.test.ts': '',
    'apps/api/src/m/b.test.ts': '',
    'apps/api/test/c.int.test.ts': '',
    'packages/money/package.json': JSON.stringify({ name: '@couli/money', scripts: { test: 'v' } }),
    'packages/money/src/d.int.test.ts': '',
    'packages/db/package.json': JSON.stringify({ name: '@couli/db', scripts: { 'test:int': 'v' } }),
    'packages/db/src/e.int.test.ts': '',
    'packages/db/dist/f.int.test.ts': '',
  });
  symlinkSync(join(snap, 'apps/api/src'), join(snap, 'apps/api/src/m/loop'));
  // test: x, y, w, s (4); api: a (1); db: e (1). The link is not followed.
  expect(countIntFiles(snap)).toBe(6);
  const res = cli('--count-int-files', snap);
  expect(res.status, res.stderr).toBe(0);
  expect(JSON.parse(res.stdout)).toEqual({ int_files_total: 6 });
});

it('[CT-06zzzzzzza] sumReports: files and tests over the reports; a link or a wrong shape is refused', () => {
  const out = join(base, 'out');
  const report = (files: number, tests: number) =>
    JSON.stringify({
      numTotalTests: tests,
      numFailedTests: 0,
      testResults: Array.from({ length: files }, (_, i) => ({
        name: `/r/${String(i)}.int.test.ts`,
      })),
    });
  writeFiles(out, {
    'test.vitest-report.json': report(3, 10),
    'apps-api.vitest-report.json': report(2, 5),
    'notes.txt': 'not a report',
  });
  expect(sumReports(out)).toEqual({ files: 5, tests: 15 });
  const res = cli('--sum-reports', out);
  expect(res.status, res.stderr).toBe(0);
  expect(JSON.parse(res.stdout)).toEqual({ files: 5, tests: 15 });

  const linked = join(base, 'out-link');
  writeFiles(linked, { 'real.json': report(1, 1) });
  symlinkSync(join(linked, 'real.json'), join(linked, 'x.vitest-report.json'));
  expect(() => sumReports(linked)).toThrow(/regular file/);

  const shape = join(base, 'out-shape');
  writeFiles(shape, { 'x.vitest-report.json': JSON.stringify({ testResults: [] }) });
  expect(() => sumReports(shape)).toThrow(/Vitest JSON report/);
  expect(cli('--sum-reports', shape).status).toBe(2);
});

it('[CT-06zzzzzzza] segmentReports: the packages a segment ran whose report is not in out/', () => {
  const snap = join(base, 'snapshot-reports');
  writeFiles(snap, {
    'package.json': JSON.stringify({ scripts: { 'test:int': 'turbo run test:int' } }),
    'test/package.json': JSON.stringify({
      name: '@couli/spec-tests',
      scripts: { 'test:int': 'v' },
    }),
    'apps/api/package.json': JSON.stringify({ name: '@couli/api', scripts: { 'test:int': 'v' } }),
    'packages/db/package.json': JSON.stringify({ name: '@couli/db', scripts: { 'test:int': 'v' } }),
    'packages/money/package.json': JSON.stringify({ name: '@couli/money', scripts: { test: 'v' } }),
  });
  expect(expectedReports(snap, '1')).toEqual([
    { name: '@couli/spec-tests', file: 'test.vitest-report.json' },
  ]);
  expect(expectedReports(snap, 'rest')).toEqual([
    { name: '@couli/api', file: 'apps-api.vitest-report.json' },
    { name: '@couli/db', file: 'packages-db.vitest-report.json' },
  ]);
  expect(() => expectedReports(snap, '../x')).toThrow(/segment/);

  const report = JSON.stringify({ numTotalTests: 4, testResults: [{}, {}] });
  const out = join(base, 'out-segment');
  writeFiles(out, { 'apps-api.vitest-report.json': report });
  // The command exited 0, but packages/db left no report: named, so the host records exit 2.
  expect(segmentReports(out, snap, 'rest')).toEqual({ files: 2, tests: 4, missing: ['@couli/db'] });
  expect(segmentReports(out, snap, '1')).toMatchObject({ missing: ['@couli/spec-tests'] });
  writeFiles(out, { 'packages-db.vitest-report.json': report });
  expect(segmentReports(out, snap, 'rest')).toEqual({ files: 4, tests: 8, missing: [] });

  const res = cli('--sum-reports', out, '--snapshot', snap, '--segment', '2');
  expect(res.status, res.stderr).toBe(0);
  expect(JSON.parse(res.stdout)).toEqual({ files: 4, tests: 8, missing: ['@couli/spec-tests'] });
  for (const args of [
    ['--sum-reports', out, '--snapshot', snap],
    ['--sum-reports', out, '--segment', 'rest'],
    ['--snapshot', snap, '--segment', 'rest'],
    ['--sum-reports', out, '--snapshot', snap, '--segment', 'x/y'],
  ]) {
    expect(cli(...args).status, args.join(' ')).toBe(2);
  }
});
