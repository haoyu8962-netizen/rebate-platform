import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  CLI_TIMEOUT,
  removeDir,
  scratchDir,
  writeFiles,
} from '../../../../tools/ops/test-helpers.ts';

const ROOT = resolve(import.meta.dirname, '../../../..');
const PARSER = join(ROOT, 'tools/ci/int-shards.ts');
const REST = "pnpm test:int --log-order=stream --filter='!@couli/spec-tests'";
const FIRST = 'pnpm test:int --log-order=stream --filter=@couli/spec-tests -- --shard=1/2';
const SECOND = FIRST.replace('--shard=1/2', '--shard=2/2');

function job(id: number, ...commands: string[]): string {
  return [
    `  verify-int-${id}:`,
    '    runs-on: ubuntu-latest',
    '    steps:',
    ...commands.map((cmd) => `      - run: ${cmd}`),
  ].join('\n');
}

function workflow(...jobs: string[]): string {
  return ['name: Fixture CI', 'jobs:', ...jobs, ''].join('\n');
}

async function loadParser() {
  expect(existsSync(PARSER), 'CI shard parser exists').toBe(true);
  const { readIntShards } = (await import(/* @vite-ignore */ pathToFileURL(PARSER).href)) as {
    readIntShards: (workflowText: string) => unknown;
  };
  expect(readIntShards, 'readIntShards is exported').toBeTypeOf('function');
  return readIntShards;
}

let base: string;
beforeAll(() => {
  base = scratchDir('int-shards');
});
afterAll(() => removeDir(base));

function runParser(...args: string[]) {
  expect(existsSync(PARSER), 'CI shard CLI exists').toBe(true);
  return spawnSync(process.execPath, [PARSER, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 10_000,
  });
}

function runFixture(contents: string) {
  const file = 'fixture workflow.yml';
  writeFiles(base, { [file]: contents });
  return runParser('--workflow', join(base, file));
}

it(
  '[AC-CT-06zzzzzzza#1] the real workflow yields the six CI commands and the unsharded command',
  async () => {
    const readIntShards = await loadParser();
    const expected = {
      n: 6,
      segments: [
        ...Array.from({ length: 6 }, (_, index) => ({
          id: String(index + 1),
          command: FIRST.replace('--shard=1/2', `--shard=${index + 1}/6`),
        })),
        { id: 'rest', command: REST },
      ],
    };
    expect(readIntShards(readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8'))).toEqual(
      expected,
    );
    const cli = runParser();
    expect(cli.status, cli.stderr).toBe(0);
    expect(cli.stdout.trimEnd().split('\n')).toHaveLength(1);
    expect(JSON.parse(cli.stdout)).toEqual(expected);
  },
  CLI_TIMEOUT,
);

it(
  '[AC-CT-06zzzzzzza#2] commands follow shard order and retain the workflow text',
  async () => {
    const readIntShards = await loadParser();
    const first = FIRST.replace('--log-order=stream ', '');
    const second = SECOND.replace('--log-order=stream ', '');
    const rest = REST.replace('--log-order=stream ', '');
    const contents = workflow(job(2, `${second}  `, 'pnpm test:smoke', rest), job(1, `  ${first}`));
    const expected = {
      n: 2,
      segments: [
        { id: '1', command: first },
        { id: '2', command: second },
        { id: 'rest', command: rest },
      ],
    };
    expect(readIntShards(contents)).toEqual(expected);
    const cli = runFixture(contents);
    expect(cli.status, cli.stderr).toBe(0);
    expect(cli.stdout.trimEnd().split('\n')).toHaveLength(1);
    expect(JSON.parse(cli.stdout)).toEqual(expected);
  },
  CLI_TIMEOUT,
);

it.each([
  ['a shard is missing', workflow(job(1, FIRST, REST))],
  ['a job index is duplicated', workflow(job(1, FIRST), job(1, FIRST, REST), job(2, SECOND))],
  ['a command repeats another index', workflow(job(1, FIRST), job(2, FIRST, REST))],
  [
    'shard indices are swapped between their named jobs',
    workflow(job(1, SECOND), job(2, FIRST, REST)),
  ],
  [
    'a shard index exceeds N even though there are N numbered jobs',
    workflow(job(1, FIRST), job(3, FIRST.replace('--shard=1/2', '--shard=3/2'), REST)),
  ],
  ['shard denominators differ', workflow(job(1, FIRST), job(2, SECOND.replace('/2', '/3'), REST))],
  [
    'the numbered commands differ beyond the shard index',
    workflow(
      job(1, FIRST),
      job(2, SECOND.replace('--log-order=stream', '--log-order=grouped'), REST),
    ),
  ],
  ['rest is missing', workflow(job(1, FIRST), job(2, SECOND))],
  ['rest occurs twice', workflow(job(1, FIRST, REST), job(2, SECOND, REST))],
  [
    'an extra numbered job has no test:int command',
    workflow(job(1, FIRST), job(2, SECOND, REST), job(3, 'pnpm test:smoke')),
  ],
] as const)(
  '[AC-CT-06zzzzzzza#3] rejects the workflow when %s',
  async (_reason, contents) => {
    const readIntShards = await loadParser();
    expect(() => readIntShards(contents)).toThrow();
    const cli = runFixture(contents);
    expect(cli.status, cli.stderr).toBe(2);
    expect(cli.stderr.trim()).not.toBe('');
  },
  CLI_TIMEOUT,
);
