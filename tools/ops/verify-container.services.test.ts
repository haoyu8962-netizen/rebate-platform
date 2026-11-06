// The docker commands verify-container.sh issues for the one-shot services (PostgreSQL, Redis):
// a stub `docker` first on PATH records every call and answers like a healthy daemon, so the
// plan — what starts on which network with which settings, what the verify container receives,
// what is removed at the end — is checked without Docker. Whether the real images behave is the
// job of tools/ops/verify-container.selftest.sh (run by hand, see tools/ops/README.md).
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { repoRoot } from '../lib/paths.ts';
import {
  CLI_TIMEOUT,
  fixtureGit,
  OPS_DIR,
  removeDir,
  scratchDir,
  writeFiles,
} from './test-helpers.ts';

const SCRIPT = join(OPS_DIR, 'verify-container.sh');
const PREFIX = 'couli-stubtest';
const PG_IMAGE = 'pgvector/pgvector:0.8.6-pg18-trixie';
const REDIS_IMAGE = 'redis:7.4.11-alpine';
const REDIS_URL = 'redis://redis:6379/0';
/** The one-shot PostgreSQL URL a container gets; recognised by its value. */
const PG_URL = /^postgres:\/\/postgres:[0-9a-f]{32}@pg:5432\/postgres$/;
/** What the host may have set: it must never reach a verify container. */
const HOST_REDIS_URL = 'redis://host.invalid:1/9';
/** Settings of infra/local/compose.yaml (ADR-0001 §4.2 #17): no RDB, no AOF, noeviction. */
const REDIS_SETTINGS = {
  save: '',
  appendonly: 'no',
  maxmemory: '256mb',
  'maxmemory-policy': 'noeviction',
};

// Stand-in for the docker CLI. Every call is appended to STUB_DOCKER_LOG with the environment
// it hands to the container: `-e NAME` takes the caller's value of NAME, `-e NAME=value` its own.
// STUB_DOCKER_FAIL=redis-start fails `run -d` of the Redis container; redis-exits makes it a
// container that has stopped (`inspect` says not running, `exec` fails). STUB_DOCKER_LOADING=<n>
// answers the first n `redis-cli ping` with a LOADING reply (exit 0); STUB_DOCKER_RUN_EXIT is the
// exit code of the verify / red / browser container. STUB_DOCKER_FAIL=image-missing makes
// `image inspect` fail, so the script builds the image (the `build` call is recorded).
// STUB_DOCKER_SCREENSHOT=1 makes the browser container leave one PNG in <out>/screenshots (where
// Vitest browser mode writes), STUB_DOCKER_SMOKE_SHOTS=<n> n build smoke PNGs (smoke-<i>.png at the
// top of <out>/screenshots). STUB_DOCKER_ORPHANS=<id,...> is what `ps` lists (containers an earlier
// host-services run left).
const STUB = String.raw`'use strict';
const fs = require('node:fs');
const args = process.argv.slice(2);
const logFile = process.env.STUB_DOCKER_LOG;
const earlier = fs.existsSync(logFile)
  ? fs.readFileSync(logFile, 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l).args)
  : [];
const env = {};
args.forEach((a, i) => {
  if (args[i - 1] !== '-e') return;
  const eq = a.indexOf('=');
  if (eq === -1) env[a] = process.env[a] ?? null;
  else env[a.slice(0, eq)] = a.slice(eq + 1);
});
fs.appendFileSync(logFile, JSON.stringify({ args, env }) + '\n');
const failures = (process.env.STUB_DOCKER_FAIL || '').split(',');
const aboutRedis = args.some((a) => a.includes('-redis-'));
function answer(text, code) {
  if (text !== '') fs.writeSync(1, text + '\n'); // CT-06zxf (D10-375): written before the exit
  process.exit(code);
}
if (args[0] === 'version') answer('28.0.1', 0);
if (args[0] === 'image' && args[1] === 'inspect' && failures.includes('image-missing')) {
  process.stderr.write('Error: No such image\n');
  process.exit(1);
}
if (args[0] === 'run' && args.includes('-d')) {
  if (failures.includes('redis-start') && aboutRedis) {
    process.stderr.write('stub: cannot start the container\n');
    process.exit(125);
  }
  answer('0123456789ab', 0);
}
if (args[0] === 'run' && args.includes('couli-verify-entrypoint')) {
  const out = args.find((a, i) => args[i - 1] === '-v' && a.endsWith(':/out'));
  // Host services: STUB_DOCKER_ECHO_URL=1 prints the PostgreSQL URL (to the run's log),
  // STUB_DOCKER_RED_URL=1 writes it into a red report, STUB_DOCKER_SLEEP=<s> hangs that long.
  const url = Object.values(env).find((v) => typeof v === 'string' && v.startsWith('postgres://'));
  if (process.env.STUB_DOCKER_ECHO_URL === '1' && url) process.stdout.write('connecting to ' + url + '\n');
  if (process.env.STUB_DOCKER_RED_URL === '1' && url && out)
    fs.writeFileSync(out.slice(0, -':/out'.length) + '/spec-int.json', JSON.stringify({ title: 'probe ' + url }));
  // STUB_DOCKER_RED_REPORT=<file>: every group of the red plan gets that report (CT-06p).
  if (process.env.STUB_DOCKER_RED_REPORT && out && process.env.RED_PLAN)
    for (const g of JSON.parse(process.env.RED_PLAN).groups)
      fs.copyFileSync(process.env.STUB_DOCKER_RED_REPORT, out.slice(0, -':/out'.length) + '/' + g.name + '.json');
  if (process.env.STUB_DOCKER_SLEEP)
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.STUB_DOCKER_SLEEP) * 1000);
  if (process.env.STUB_DOCKER_SCREENSHOT === '1' && args.at(-1) === 'browser' && out) {
    const dir = out.slice(0, -':/out'.length) + '/screenshots/spec/x.browser.test.ts';
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(dir + '/shot-chromium-linux.png', 'png');
  }
  const smokeShots = Number(process.env.STUB_DOCKER_SMOKE_SHOTS || '0');
  if (smokeShots > 0 && args.at(-1) === 'browser' && out) {
    const dir = out.slice(0, -':/out'.length) + '/screenshots';
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < smokeShots; i += 1) fs.writeFileSync(dir + '/smoke-' + i + '.png', 'png');
  }
  answer('', Number(process.env.STUB_DOCKER_RUN_EXIT || '0'));
}
if (args[0] === 'ps') answer((process.env.STUB_DOCKER_ORPHANS || '').split(',').filter((x) => x !== '').join('\n'), 0);
if (args[0] === 'inspect') answer(failures.includes('redis-exits') && aboutRedis ? 'false' : 'true', 0);
if (args[0] === 'exec' && args.includes('redis-cli')) {
  if (failures.includes('redis-exits')) {
    process.stderr.write('Error response from daemon: container is not running\n');
    process.exit(1);
  }
  const pings = earlier.filter((a) => a[0] === 'exec' && a.includes('redis-cli')).length;
  const loading = Number(process.env.STUB_DOCKER_LOADING || '0');
  answer(pings < loading ? 'LOADING Redis is loading the dataset in memory' : 'PONG', 0);
}
answer('', 0);
`;

type Call = { args: string[]; env: Record<string, string | null> };
type Run = { status: number; stdout: string; stderr: string; calls: Call[] };

let base = '';
let runs = '';
let bin = '';
let logs = 0;

beforeAll(() => {
  base = scratchDir('verify-services');
  runs = join(base, 'runs');
  bin = join(base, 'bin');
  writeFiles(base, { 'bin/docker-stub.cjs': STUB });
  const docker = join(bin, 'docker');
  writeFileSync(
    docker,
    `#!/bin/sh\nexec '${process.execPath}' '${join(bin, 'docker-stub.cjs')}' "$@"\n`,
  );
  chmodSync(docker, 0o755);
});
afterAll(() => removeDir(base));

const PLAIN_LOCK = "lockfileVersion: '9.0'\n";

/**
 * A pnpm 10 lockfile that has playwright `version` (and playwright-core, which must not be
 * taken for it): an importer entry, the packages section and the snapshots section.
 */
function lockWithPlaywright(version: string): string {
  return [
    "lockfileVersion: '9.0'",
    '',
    'importers:',
    '',
    '  test:',
    '    devDependencies:',
    '      playwright:',
    `        specifier: ${version}`,
    `        version: ${version}`,
    '',
    'packages:',
    '',
    `  playwright-core@${version}:`,
    '    resolution: {integrity: sha512-core}',
    '',
    `  playwright@${version}:`,
    '    resolution: {integrity: sha512-playwright}',
    '',
    'snapshots:',
    '',
    `  playwright-core@${version}: {}`,
    '',
    `  playwright@${version}:`,
    '    dependencies:',
    `      playwright-core: ${version}`,
    '',
  ].join('\n');
}

/** A workspace the container path accepts (pinned pnpm, lockfile, workspace file). */
function workspace(name: string, lock = PLAIN_LOCK): string {
  const root = JSON.parse(readFileSync(join(repoRoot(), 'package.json'), 'utf8')) as {
    packageManager: string;
  };
  const dir = join(base, name);
  writeFiles(dir, {
    'package.json': `${JSON.stringify(
      { name, private: true, packageManager: root.packageManager, scripts: { verify: 'true' } },
      null,
      2,
    )}\n`,
    'pnpm-workspace.yaml': 'packages: []\n',
    'pnpm-lock.yaml': lock,
  });
  return dir;
}

/** Runs the script with the stub docker; the host has TEST_REDIS_URL set. */
function run(args: string[], env: Record<string, string> = {}): Run {
  logs += 1;
  const log = join(base, `calls-${String(logs)}.jsonl`);
  const res = spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env['PATH'] ?? ''}`,
      COULI_RUNS: runs,
      COULI_TRUSTED_ROOT: repoRoot(),
      COULI_VERIFY_PREFIX: PREFIX,
      TEST_REDIS_URL: HOST_REDIS_URL,
      // What the script hands on to the container from the caller's environment (PROP_SEED,
      // PROP_RUNS, COULI_VERIFY_TIMEOUT_SECS as VERIFY_TIMEOUT_SECS) is cleared, so the caller's
      // settings (the orchestrator verifies with PROP_RUNS=100000) do not change what a test
      // sees; a test sets them explicitly when it needs them.
      PROP_RUNS: undefined,
      PROP_SEED: undefined,
      COULI_VERIFY_TIMEOUT_SECS: undefined,
      // The host services of the test machine are off unless a test turns them on.
      COULI_VERIFY_HOST_SERVICES: undefined,
      COULI_VERIFY_SVC_USER: undefined,
      COULI_VERIFY_SVC_GROUP: undefined,
      COULI_VERIFY_SVC_ROOT: undefined,
      COULI_VERIFY_PG_BIN: undefined,
      COULI_VERIFY_REDIS_BIN: undefined,
      STUB_DOCKER_LOG: log,
      ...env,
    },
  });
  const calls = existsSync(log)
    ? readFileSync(log, 'utf8')
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as Call)
    : [];
  return { status: res.status ?? -1, stdout: res.stdout, stderr: res.stderr, calls };
}

/** The value that follows `flag` in `args`, or null. */
function valueOf(args: readonly string[], flag: string): string | null {
  const i = args.indexOf(flag);
  return i === -1 ? null : (args[i + 1] ?? null);
}

/** `-e NAME` pairs of a `docker run`. */
function passedEnv(args: readonly string[]): string[] {
  return args.flatMap((arg, i) => (args[i - 1] === '-e' ? [arg.replace(/=.*$/s, '')] : []));
}

/** `--opt value` / `opt value` words as a settings record. */
function settings(words: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i + 1 < words.length; i += 2) {
    out[(words[i] ?? '').replace(/^--/, '')] = words[i + 1] ?? '';
  }
  return out;
}

function containerRuns(calls: readonly Call[], image: string): Call[] {
  return calls.filter(
    (c) => c.args[0] === 'run' && c.args.includes('-d') && c.args.includes(image),
  );
}

function entrypointRun(calls: readonly Call[]): Call | undefined {
  return calls.find((c) => c.args.includes('couli-verify-entrypoint'));
}

/** The values handed to the container of `call` that are one-shot PostgreSQL URLs. */
function pgUrls(call: Call | undefined): string[] {
  return Object.values(call?.env ?? {}).filter((v): v is string => v !== null && PG_URL.test(v));
}

/** True when TEST_REDIS_URL does not reach the container of `call`, in any form. */
function noRedisUrl(call: Call | undefined): boolean {
  return (call?.args ?? []).every((a) => !a.includes('TEST_REDIS_URL'));
}

it(
  'pnpm verify: Redis starts beside PostgreSQL on the internal network and the run gets both URLs',
  () => {
    const res = run(['V2-01', '--worktree', workspace('verify')], {
      STUB_DOCKER_LOADING: '2',
      STUB_DOCKER_RUN_EXIT: '3',
      PROP_RUNS: '7',
    });
    // The exit code of the verify container is the result.
    expect(res.status, res.stderr).toBe(3);
    const result = JSON.parse(
      readFileSync(join(runs, 'V2-01', 'verify', '1', 'result.json'), 'utf8'),
    ) as { script: string; exit_code: number };
    expect(result).toMatchObject({ script: 'verify', exit_code: 3 });

    const { calls } = res;
    const network = calls.find((c) => c.args[0] === 'network' && c.args[1] === 'create');
    const net = network?.args.at(-1) ?? '';
    expect(net).toMatch(/^couli-stubtest-net-v2-01-1-\d+$/);
    expect(network?.args).toContain('--internal');

    // Exactly one Redis: on that network only, alias `redis`, data on tmpfs, no published
    // port, the settings of the local stack.
    const redis = containerRuns(calls, REDIS_IMAGE);
    expect(redis).toHaveLength(1);
    const redisName = valueOf(redis[0]?.args ?? [], '--name') ?? '';
    expect(redisName).toMatch(/^couli-stubtest-redis-v2-01-1-\d+$/);
    expect(redis[0]?.args).toEqual([
      'run',
      '-d',
      '--name',
      redisName,
      '--label',
      'couli.verify=1',
      '--label',
      'couli.task=V2-01',
      '--network',
      net,
      '--network-alias',
      'redis',
      '--tmpfs',
      '/data',
      REDIS_IMAGE,
      'redis-server',
      ...Object.entries(REDIS_SETTINGS).flatMap(([key, value]) => [`--${key}`, value]),
    ]);

    // PostgreSQL is still there, on the same network, with a fresh random password.
    const pg = containerRuns(calls, PG_IMAGE);
    expect(pg).toHaveLength(1);
    expect(valueOf(pg[0]?.args ?? [], '--network')).toBe(net);
    expect(valueOf(pg[0]?.args ?? [], '--network-alias')).toBe('pg');
    const pgName = valueOf(pg[0]?.args ?? [], '--name') ?? '';
    expect(pgName).toMatch(/^couli-stubtest-pg-v2-01-1-\d+$/);
    const pgPassword = pg[0]?.env['POSTGRES_PASSWORD'] ?? '';
    expect(pgPassword).toMatch(/^[0-9a-f]{32}$/);

    // The run starts only after Redis answered PONG (two LOADING replies first; the container
    // was still running each time).
    const verifyAt = calls.findIndex((c) => c.args.includes('couli-verify-entrypoint'));
    const pings = calls.flatMap((c, i) =>
      c.args[0] === 'exec' && c.args.includes('redis-cli') ? [i] : [],
    );
    expect(pings).toHaveLength(3);
    expect(calls[pings[0] ?? -1]?.args).toEqual(['exec', redisName, 'redis-cli', 'ping']);
    expect(Math.max(...pings)).toBeLessThan(verifyAt);
    const inspections = calls.filter((c) => c.args[0] === 'inspect');
    expect(inspections.map((c) => c.args)).toEqual([
      ['inspect', '-f', '{{.State.Running}}', redisName],
      ['inspect', '-f', '{{.State.Running}}', redisName],
    ]);

    // The verify container: same network; TEST_REDIS_URL passed by name with the in-network
    // address, whatever the host had set; exactly one PostgreSQL URL (found by its value) with
    // the password the PostgreSQL container got.
    const verify = calls[verifyAt];
    expect(verify?.args.slice(-2)).toEqual(['couli-verify-entrypoint', 'verify']);
    expect(valueOf(verify?.args ?? [], '--network')).toBe(net);
    expect(passedEnv(verify?.args ?? [])).toContain('TEST_REDIS_URL');
    expect(verify?.args).not.toContain(`TEST_REDIS_URL=${REDIS_URL}`);
    expect(verify?.env['TEST_REDIS_URL']).toBe(REDIS_URL);
    expect(pgUrls(verify)).toEqual([`postgres://postgres:${pgPassword}@pg:5432/postgres`]);
    // PROP_RUNS, set explicitly for this run, is passed through unchanged.
    expect(verify?.env['PROP_RUNS']).toBe('7');

    // Cleanup removes both service containers (with their anonymous volumes), then the network.
    const rmAt = calls.findIndex((c) => c.args[0] === 'rm');
    expect(rmAt).toBeGreaterThan(verifyAt);
    expect(calls[rmAt]?.args.slice(0, 3)).toEqual(['rm', '-f', '-v']);
    expect(calls[rmAt]?.args).toEqual(expect.arrayContaining([pgName, redisName]));
    const netRmAt = calls.findIndex((c) => c.args[0] === 'network' && c.args[1] === 'rm');
    expect(netRmAt).toBeGreaterThan(rmAt);
    expect(calls[netRmAt]?.args).toEqual(['network', 'rm', net]);
  },
  CLI_TIMEOUT,
);

it(
  'a Redis that cannot start stops the run (exit 2, no result) and nothing is left behind',
  () => {
    const res = run(['V2-02', '--worktree', workspace('redis-fails')], {
      STUB_DOCKER_FAIL: 'redis-start',
    });
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('cannot start Redis');
    expect(existsSync(join(runs, 'V2-02', 'verify', '1', 'result.json'))).toBe(false);
    expect(entrypointRun(res.calls)).toBeUndefined();

    const pgName = valueOf(containerRuns(res.calls, PG_IMAGE)[0]?.args ?? [], '--name') ?? '';
    const redisName = valueOf(containerRuns(res.calls, REDIS_IMAGE)[0]?.args ?? [], '--name') ?? '';
    expect(redisName).toMatch(/^couli-stubtest-redis-v2-02-1-\d+$/);
    const rm = res.calls.find((c) => c.args[0] === 'rm');
    expect(rm?.args).toEqual(expect.arrayContaining([pgName, redisName]));
    const net = res.calls.find((c) => c.args[0] === 'network' && c.args[1] === 'create');
    const netRm = res.calls.find((c) => c.args[0] === 'network' && c.args[1] === 'rm');
    expect(netRm?.args).toEqual(['network', 'rm', net?.args.at(-1)]);
  },
  CLI_TIMEOUT,
);

it(
  'a Redis that exits before it answers stops the run at once, with its logs, and nothing is left behind',
  () => {
    const res = run(['V2-04', '--worktree', workspace('redis-exits')], {
      STUB_DOCKER_FAIL: 'redis-exits',
    });
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('Redis exited before it became ready');
    expect(existsSync(join(runs, 'V2-04', 'verify', '1', 'result.json'))).toBe(false);
    expect(entrypointRun(res.calls)).toBeUndefined();

    const redisName = valueOf(containerRuns(res.calls, REDIS_IMAGE)[0]?.args ?? [], '--name') ?? '';
    expect(redisName).toMatch(/^couli-stubtest-redis-v2-04-1-\d+$/);
    // One ping, one look at the container, its logs: no 60-second wait.
    const pings = res.calls.filter((c) => c.args[0] === 'exec' && c.args.includes('redis-cli'));
    expect(pings).toHaveLength(1);
    expect(res.calls.filter((c) => c.args[0] === 'inspect').map((c) => c.args)).toEqual([
      ['inspect', '-f', '{{.State.Running}}', redisName],
    ]);
    expect(res.calls.some((c) => c.args[0] === 'logs' && c.args[1] === redisName)).toBe(true);
    const pgName = valueOf(containerRuns(res.calls, PG_IMAGE)[0]?.args ?? [], '--name') ?? '';
    expect(res.calls.find((c) => c.args[0] === 'rm')?.args).toEqual(
      expect.arrayContaining([pgName, redisName]),
    );
    expect(res.calls.some((c) => c.args[0] === 'network' && c.args[1] === 'rm')).toBe(true);
  },
  CLI_TIMEOUT,
);

it(
  '--fast starts no service and passes no TEST_REDIS_URL, even when the host has one',
  () => {
    const res = run(['V2-03', '--worktree', workspace('fast'), '--fast']);
    expect(res.status, res.stderr).toBe(0);
    const { calls } = res;
    expect(calls.some((c) => c.args[0] === 'network' && c.args[1] === 'create')).toBe(false);
    expect(calls.some((c) => c.args[0] === 'run' && c.args.includes('-d'))).toBe(false);
    const verify = entrypointRun(calls);
    expect(valueOf(verify?.args ?? [], '--network')).toBe('none');
    expect(noRedisUrl(verify)).toBe(true);
    // Nothing else is handed over either (CT-06zzw: plus the Node heap limit of every container).
    expect(Object.keys(verify?.env ?? {}).sort()).toEqual([
      'NODE_OPTIONS',
      'PROP_SEED',
      'VERIFY_SCRIPT',
      'VERIFY_TIMEOUT_SECS',
      'VITEST_MAX_WORKERS',
    ]);
    expect(verify?.env['NODE_OPTIONS']).toBe('--max-old-space-size=8192');
    // CT-06zzza: every container that runs tests caps vitest at 2 workers by default.
    expect(verify?.env['VITEST_MAX_WORKERS']).toBe('2');
  },
  CLI_TIMEOUT,
);

/** A git fixture whose task (B1-02b, legacy ledger, see verify-container.test.ts) adds `files`. */
function redFixture(name: string, files: Record<string, string>, lock = PLAIN_LOCK): string {
  const repo = workspace(name, lock);
  fixtureGit(repo, ['init', '-q', '-b', 'main']);
  fixtureGit(repo, ['add', '-A']);
  fixtureGit(repo, ['commit', '-q', '-m', 'fixture']);
  writeFiles(repo, files);
  return repo;
}

it(
  '--red: an integration group gets Redis and TEST_REDIS_URL like PostgreSQL',
  () => {
    const res = run([
      'B1-02b',
      '--worktree',
      redFixture('red-int', {
        'test/spec/identity/devices.int.test.ts': "it('[BR-ID-05] y', () => {});\n",
      }),
      '--red',
      '--base',
      'main',
    ]);
    // The stub writes no report, so the run stops after the red container (exit 2).
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('wrote no report for spec-int');
    const net =
      res.calls.find((c) => c.args[0] === 'network' && c.args[1] === 'create')?.args.at(-1) ?? '';
    expect(net).toMatch(/^couli-stubtest-net-b1-02b-1-\d+$/);
    const redis = containerRuns(res.calls, REDIS_IMAGE);
    expect(redis).toHaveLength(1);
    expect(valueOf(redis[0]?.args ?? [], '--network')).toBe(net);
    const red = entrypointRun(res.calls);
    expect(red?.args.at(-1)).toBe('red');
    expect(valueOf(red?.args ?? [], '--network')).toBe(net);
    expect(passedEnv(red?.args ?? [])).toContain('TEST_REDIS_URL');
    expect(red?.env['TEST_REDIS_URL']).toBe(REDIS_URL);
    const pgPassword = containerRuns(res.calls, PG_IMAGE)[0]?.env['POSTGRES_PASSWORD'] ?? '';
    expect(pgPassword).toMatch(/^[0-9a-f]{32}$/);
    expect(pgUrls(red)).toEqual([`postgres://postgres:${pgPassword}@pg:5432/postgres`]);
    const redisName = valueOf(redis[0]?.args ?? [], '--name') ?? '';
    expect(res.calls.find((c) => c.args[0] === 'rm')?.args).toContain(redisName);
    expect(res.calls.some((c) => c.args[0] === 'network' && c.args[1] === 'rm')).toBe(true);
  },
  CLI_TIMEOUT,
);

it(
  '--red: a unit-only plan gets no service, no network and no database URL',
  () => {
    const res = run([
      'B1-02b',
      '--worktree',
      redFixture('red-unit', {
        'test/spec/identity/devices.test.ts': "it('[BR-ID-05] x', () => {});\n",
      }),
      '--red',
      '--base',
      'main',
    ]);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('wrote no report for spec-unit');
    expect(res.calls.some((c) => c.args[0] === 'run' && c.args.includes('-d'))).toBe(false);
    const red = entrypointRun(res.calls);
    expect(red?.args.at(-1)).toBe('red');
    expect(valueOf(red?.args ?? [], '--network')).toBe('none');
    expect(noRedisUrl(red)).toBe(true);
    // Nothing else is handed over either (CT-06zzw: plus the Node heap limit of every container).
    expect(Object.keys(red?.env ?? {}).sort()).toEqual([
      'NODE_OPTIONS',
      'PROP_SEED',
      'RED_PLAN',
      'VERIFY_TIMEOUT_SECS',
      'VITEST_MAX_WORKERS',
    ]);
    expect(red?.env['NODE_OPTIONS']).toBe('--max-old-space-size=8192');
    // CT-06zzza: every container that runs tests caps vitest at 2 workers by default.
    expect(red?.env['VITEST_MAX_WORKERS']).toBe('2');
  },
  CLI_TIMEOUT,
);

/** The image tag of the `docker build` call, or null when the script built nothing. */
function builtImage(calls: readonly Call[]): string | null {
  const build = calls.find((c) => c.args[0] === 'build');
  return build === undefined ? null : valueOf(build.args, '-t');
}

/** `--build-arg` values of the `docker build` call. */
function buildArgs(calls: readonly Call[]): string[] {
  const build = calls.find((c) => c.args[0] === 'build')?.args ?? [];
  return build.flatMap((arg, i) => (build[i - 1] === '--build-arg' ? [arg] : []));
}

it(
  '[F1-01j] the image is built with the playwright version of the lockfile, and the tag changes with it',
  () => {
    function fast(name: string, lock: string): Run {
      return run(['V3-01', '--worktree', workspace(name, lock), '--fast'], {
        STUB_DOCKER_FAIL: 'image-missing',
      });
    }
    const v163 = fast('pw-163', lockWithPlaywright('1.63.0'));
    expect(v163.status, v163.stderr).toBe(0);
    const root = JSON.parse(readFileSync(join(repoRoot(), 'package.json'), 'utf8')) as {
      packageManager: string;
    };
    const pnpm = root.packageManager.replace('pnpm@', '');
    expect(buildArgs(v163.calls)).toEqual([`PNPM_VERSION=${pnpm}`, 'PLAYWRIGHT_VERSION=1.63.0']);
    const tag163 = builtImage(v163.calls) ?? '';
    expect(tag163).toMatch(/^couli-verify:[0-9a-f]{16}$/);
    // The run uses the image it built.
    expect(entrypointRun(v163.calls)?.args).toContain(tag163);

    // Same version, same image; another version or none, another image.
    const again = fast('pw-163-again', lockWithPlaywright('1.63.0'));
    expect(builtImage(again.calls)).toBe(tag163);
    const v164 = fast('pw-164', lockWithPlaywright('1.64.0'));
    expect(buildArgs(v164.calls)).toContain('PLAYWRIGHT_VERSION=1.64.0');
    const none = fast('pw-none', PLAIN_LOCK);
    expect(none.status, none.stderr).toBe(0);
    expect(buildArgs(none.calls)).toContain('PLAYWRIGHT_VERSION=none');
    const tags = [tag163, builtImage(v164.calls), builtImage(none.calls)];
    expect(new Set(tags).size).toBe(3);

    // Two versions in one lockfile: no guess, the run stops before Docker is asked anything.
    const two = fast(
      'pw-two',
      `${lockWithPlaywright('1.63.0')}\n  playwright@1.64.0:\n    resolution: {integrity: x}\n`,
    );
    expect(two.status).toBe(2);
    expect(two.stderr).toContain('more than one playwright version');
    expect(two.calls).toEqual([]);
  },
  CLI_TIMEOUT,
);

it(
  '[F1-01j, F1-01k] --browser: the browser projects only, no network, screenshots and reports exported to browser/<n>/out',
  () => {
    const ws = workspace('browser', lockWithPlaywright('1.63.0'));
    const res = run(['V3-02', '--worktree', ws, '--browser'], { STUB_DOCKER_RUN_EXIT: '1' });
    // Vitest's exit code is the result; result.json says browser.
    expect(res.status, res.stderr).toBe(1);
    const dir = join(runs, 'V3-02', 'browser', '1');
    const result = JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8')) as {
      mode: string;
      script: string;
      exit_code: number;
    };
    expect(result).toMatchObject({ mode: 'container', script: 'browser', exit_code: 1 });
    expect(existsSync(join(dir, 'out'))).toBe(true);
    // Writable and searchable for the container's uid, not listable, sticky (not 0777).
    expect(statSync(join(dir, 'out')).mode & 0o7777).toBe(0o1733);
    // The snapshot is not kept.
    expect(existsSync(join(dir, 'src'))).toBe(false);

    const { calls } = res;
    expect(calls.some((c) => c.args[0] === 'network' && c.args[1] === 'create')).toBe(false);
    expect(calls.some((c) => c.args[0] === 'run' && c.args.includes('-d'))).toBe(false);
    const browser = entrypointRun(calls);
    const args = browser?.args ?? [];
    expect(args.slice(-2)).toEqual(['couli-verify-entrypoint', 'browser']);
    expect(valueOf(args, '--network')).toBe('none');
    // The output directory is the one writable mount besides the tmpfs; the snapshot and the
    // store stay read-only; no planning snapshot, no red reporter.
    const mounts = args.flatMap((a, i) => (args[i - 1] === '-v' ? [a] : []));
    expect(mounts).toEqual([
      expect.stringMatching(/\/V3-02\/browser\/1\/src:\/src:ro$/),
      expect.stringMatching(/^couli-stubtest-store-[0-9a-f]{16}:\/store:ro$/),
      expect.stringMatching(/\/V3-02\/browser\/1\/out:\/out$/),
    ]);
    // The hardening of every verify container.
    for (const flag of ['--init', '--read-only', 'no-new-privileges']) expect(args).toContain(flag);
    expect(valueOf(args, '--cap-drop')).toBe('ALL');
    // The projects come from the trusted table, in its order; nothing else is handed over.
    expect(browser?.env).toEqual({
      NODE_OPTIONS: '--max-old-space-size=8192',
      PROP_SEED: '20261001',
      VERIFY_TIMEOUT_SECS: '3600',
      VITEST_MAX_WORKERS: '2',
      BROWSER_PROJECTS:
        'spec-browser:test:vitest.browser.config.ts build-smoke:test:vitest.build-smoke.config.ts',
    });
    expect(noRedisUrl(browser)).toBe(true);
  },
  CLI_TIMEOUT,
);

it(
  '[F1-01j] --browser: a green run that exported no screenshot fails; with screenshots it passes',
  () => {
    const lock = lockWithPlaywright('1.63.0');
    const empty = run(['V3-04', '--worktree', workspace('browser-empty', lock), '--browser']);
    expect(empty.status).toBe(1);
    expect(empty.stderr).toContain('no screenshot was exported');
    const emptyDir = join(runs, 'V3-04', 'browser', '1');
    const result = JSON.parse(readFileSync(join(emptyDir, 'result.json'), 'utf8')) as {
      exit_code: number;
    };
    expect(result.exit_code).toBe(1);
    expect(readFileSync(join(emptyDir, 'log.txt'), 'utf8')).toContain(
      'browser tests exited 0; screenshots exported: 0',
    );

    const shots = run(['V3-05', '--worktree', workspace('browser-shots', lock), '--browser'], {
      STUB_DOCKER_SCREENSHOT: '1',
    });
    expect(shots.status, shots.stderr).toBe(0);
    const shotsDir = join(runs, 'V3-05', 'browser', '1');
    expect(readFileSync(join(shotsDir, 'log.txt'), 'utf8')).toContain(
      'browser tests exited 0; screenshots exported: 1 (browser tests 1, build smoke 0;',
    );

    // F1-01k: the build smoke's screenshots alone also count; the log tells the two kinds apart.
    const smoke = run(['V3-06', '--worktree', workspace('browser-smoke', lock), '--browser'], {
      STUB_DOCKER_SCREENSHOT: '1',
      STUB_DOCKER_SMOKE_SHOTS: '4',
    });
    expect(smoke.status, smoke.stderr).toBe(0);
    expect(readFileSync(join(runs, 'V3-06', 'browser', '1', 'log.txt'), 'utf8')).toContain(
      'browser tests exited 0; screenshots exported: 5 (browser tests 1, build smoke 4;',
    );
  },
  CLI_TIMEOUT,
);

it(
  '[F1-01j] --red with integration and browser rule tests: two containers, the browser group stays offline',
  () => {
    const files = {
      'test/spec/identity/devices.int.test.ts': "it('[BR-ID-05] y', () => {});\n",
      'test/spec/identity/devices.browser.test.ts': "it('[BR-ID-05] z', () => {});\n",
    };
    const repo = redFixture('red-mixed', files, lockWithPlaywright('1.63.0'));
    const res = run(['B1-02b', '--worktree', repo, '--red', '--base', 'main']);
    // The stub writes no report, so the run stops after the red containers (exit 2).
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('wrote no report for');
    const net =
      res.calls.find((c) => c.args[0] === 'network' && c.args[1] === 'create')?.args.at(-1) ?? '';
    // Other tests of this file ran B1-02b before: the run number is not 1.
    expect(net).toMatch(/^couli-stubtest-net-b1-02b-\d+-\d+$/);
    const reds = res.calls.filter((c) => c.args.includes('couli-verify-entrypoint'));
    expect(reds).toHaveLength(2);
    function groupsOf(call: Call | undefined): string[] {
      const plan = JSON.parse(call?.env['RED_PLAN'] ?? '{"groups":[]}') as {
        groups: { name: string }[];
      };
      return plan.groups.map((g) => g.name);
    }
    const db = reds.find((c) => groupsOf(c).includes('spec-int'));
    const offline = reds.find((c) => groupsOf(c).includes('spec-browser'));
    // The integration group alone on the internal network, with both service URLs.
    expect(groupsOf(db)).toEqual(['spec-int']);
    expect(valueOf(db?.args ?? [], '--network')).toBe(net);
    expect(db?.env['TEST_REDIS_URL']).toBe(REDIS_URL);
    expect(pgUrls(db)).toHaveLength(1);
    // The browser group alone with no network and no database URL of any kind.
    expect(groupsOf(offline)).toEqual(['spec-browser']);
    expect(valueOf(offline?.args ?? [], '--network')).toBe('none');
    expect(noRedisUrl(offline)).toBe(true);
    expect(pgUrls(offline)).toEqual([]);
    expect(Object.keys(offline?.env ?? {}).sort()).toEqual([
      'NODE_OPTIONS',
      'PROP_SEED',
      'RED_PLAN',
      'VERIFY_TIMEOUT_SECS',
      'VITEST_MAX_WORKERS',
    ]);
    expect(offline?.env['NODE_OPTIONS']).toBe('--max-old-space-size=8192');
    // CT-06zzza: every container that runs tests caps vitest at 2 workers by default.
    expect(offline?.env['VITEST_MAX_WORKERS']).toBe('2');
    // Two containers, two names; both are removed at the end.
    const names = reds.map((c) => valueOf(c.args, '--name') ?? '');
    expect(new Set(names).size).toBe(2);
    expect(res.calls.find((c) => c.args[0] === 'rm')?.args).toEqual(expect.arrayContaining(names));
  },
  CLI_TIMEOUT,
);

it(
  '[F1-01j] --browser on a lockfile without playwright stops (exit 2, no result) before Docker',
  () => {
    const res = run(['V3-03', '--worktree', workspace('browser-old'), '--browser']);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('--browser needs playwright in pnpm-lock.yaml');
    expect(res.calls).toEqual([]);
    expect(existsSync(join(runs, 'V3-03', 'browser', '1', 'result.json'))).toBe(false);
  },
  CLI_TIMEOUT,
);

it(
  '[F1-01j] --red with a browser rule test: the spec-browser group runs without network; without playwright the run stops',
  () => {
    const files = {
      'test/spec/identity/devices.browser.test.ts': "it('[BR-ID-05] z', () => {});\n",
    };
    const res = run([
      'B1-02b',
      '--worktree',
      redFixture('red-browser', files, lockWithPlaywright('1.63.0')),
      '--red',
      '--base',
      'main',
    ]);
    // The stub writes no report, so the run stops after the red container (exit 2).
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('wrote no report for spec-browser');
    expect(res.calls.some((c) => c.args[0] === 'run' && c.args.includes('-d'))).toBe(false);
    const red = entrypointRun(res.calls);
    expect(red?.args.at(-1)).toBe('red');
    expect(valueOf(red?.args ?? [], '--network')).toBe('none');
    const plan = JSON.parse(red?.env['RED_PLAN'] ?? '{}') as { groups?: unknown };
    expect(plan.groups).toEqual([
      {
        name: 'spec-browser',
        dir: 'test',
        config: 'vitest.browser.config.ts',
        database: false,
        browser: true,
        files: ['spec/identity/devices.browser.test.ts'],
      },
    ]);

    const old = run([
      'B1-02b',
      '--worktree',
      redFixture('red-browser-old', files),
      '--red',
      '--base',
      'main',
    ]);
    expect(old.status).toBe(2);
    expect(old.stderr).toContain(
      'the red run has browser rule tests, but pnpm-lock.yaml has no playwright',
    );
    expect(entrypointRun(old.calls)).toBeUndefined();
  },
  CLI_TIMEOUT,
);

it('Redis has one image and one configuration in the verify container, CI and the local stack', () => {
  const script = readFileSync(SCRIPT, 'utf8');
  const compose = readFileSync(join(repoRoot(), 'infra', 'local', 'compose.yaml'), 'utf8');
  const ci = readFileSync(join(repoRoot(), '.github', 'workflows', 'ci.yml'), 'utf8');
  expect(script).toContain(`\nREDIS_IMAGE='${REDIS_IMAGE}'\n`);
  expect(compose).toContain(`    image: ${REDIS_IMAGE}\n`);
  expect(ci).toContain(`        image: ${REDIS_IMAGE}\n`);

  // infra/local/compose.yaml: the command list of the redis service.
  const list = /\n {2}redis:\n[\s\S]*?\n {4}command:\n((?: {6}- .*\n)+)/.exec(compose)?.[1] ?? '';
  const command = list
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => line.replace(/^ {6}- /, '').replace(/^'(.*)'$/, '$1'));
  expect(command[0]).toBe('redis-server');
  expect(settings(command.slice(1))).toEqual(REDIS_SETTINGS);

  // CI: a service container takes no command; the same settings are applied with CONFIG SET.
  const configSet = /redis-cli CONFIG SET (.+?)\)"/.exec(ci)?.[1] ?? '';
  const words = configSet.split(' ').map((w) => (w === "''" ? '' : w));
  expect(settings(words)).toEqual(REDIS_SETTINGS);
  // The port is published on the loopback address only; the same step checks from the runner
  // that it answers PING there, and the integration tests get that address as TEST_REDIS_URL.
  expect(ci).toContain('          - 127.0.0.1:6379:6379\n');
  expect(ci).not.toMatch(/^ +- 6379:6379$/m);
  expect(ci).toContain('if exec 3<>/dev/tcp/127.0.0.1/6379; then\n');
  expect(ci).toContain("printf 'PING\\r\\n' >&3\n");
  expect(ci).toContain(`if [ "\${pong%$'\\r'}" != '+PONG' ]; then\n`);
  // CT-06zzb: verify-int is split into verify-int-1 / -2; each shard connects the same way.
  for (const shard of ['1/2', '2/2']) {
    expect(ci).toContain(
      `      - run: pnpm test:int -- --shard=${shard}\n        env:\n          TEST_REDIS_URL: redis://127.0.0.1:6379/0\n`,
    );
  }
});

// --- host services (COULI_VERIFY_HOST_SERVICES=1, the AWS test machine) -------------------------
// Stand-ins for sudo, id, getent and timeout, first on PATH in these tests only. sudo records every
// call (arguments, and what arrived on stdin) to STUB_SUDO_LOG and plays the host: nft lists the
// isolation chain, systemd-run "starts" a unit (initdb makes pgdata, postgres and redis-server make
// their socket files), systemctl stop / show / is-active / list-units, pgrep, install -d, find, rm
// and the presence / instance-root / residue checks act on the scratch directory.
// STUB_SUDO_FAIL (comma-separated): firewall-missing, firewall-accept, egress-open, initdb,
// pg-exits, redis-migrate (MIGRATE still known), root-not-mount, root-not-tmpfs, root-owner, stop
// (units stay active), rm (the run directory cannot be removed); and, only once the verify
// container has run (the clean-up after the run): state-empty (systemctl show answers nothing),
// state-timeout (it times out), state-error (it cannot reach systemd), presence-error (the
// presence check cannot run), procs-left, pgrep-error, ipc-left, ipcs-fails, find-fails (inside
// the real check script), procs-sudo-error (sudo refuses the process listing).
// STUB_SUDO_UNITS=<unit,...> is what list-units shows.
const SUDO_STUB = String.raw`'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
let args = process.argv.slice(2);
const fail = (process.env.STUB_SUDO_FAIL || '').split(',');
let stdin = '';
if (args.includes('--pipe')) stdin = fs.readFileSync(0, 'utf8');
fs.appendFileSync(process.env.STUB_SUDO_LOG, JSON.stringify({ args, stdin }) + '\n');
if (args[0] === '-n') args = args.slice(1);
// The clean-up after the run: the verify container has been started (the docker stub's log).
const dockerLog = process.env.STUB_DOCKER_LOG;
const after = fs.existsSync(dockerLog) && fs.readFileSync(dockerLog, 'utf8').includes('couli-verify-entrypoint');
const late = (mode) => after && fail.includes(mode);
const out = (text, code) => {
  if (text !== '') fs.writeSync(1, text + '\n'); // CT-06zxf (D10-375): written before the exit
  process.exit(code);
};
const real = (cmd, rest) => {
  const r = spawnSync(cmd, rest, { stdio: 'inherit' });
  process.exit(r.status ?? 1);
};
if (args[0] === '-u') {
  const cmd = args.slice(2);
  const base = path.basename(cmd[0]);
  if (base === 'timeout') out('', fail.includes('egress-open') ? 0 : 1);
  if (base === 'pg_isready') out('', fail.includes('pg-exits') ? 2 : 0);
  if (base === 'redis-cli') {
    if (cmd.includes('ping')) out('PONG', 0);
    if (cmd.includes('MIGRATE'))
      out(fail.includes('redis-migrate') ? 'NOKEY' : "ERR unknown command 'MIGRATE'", 0);
    if (cmd.includes('CONFIG')) out('maxmemory-policy\nnoeviction', 0);
  }
  out('', 1);
}
const [cmd, ...rest] = args;
if (cmd === 'nft') {
  if (fail.includes('firewall-missing')) out('Error: No such file or directory', 1);
  const verdict = fail.includes('firewall-accept') ? 'accept' : 'reject';
  out('table inet couli_isolation {\n\tchain output {\n\t\ttype filter hook output priority -300; policy accept;\n\t\tmeta skuid 4242 counter packets 0 bytes 0 ' + verdict + ' comment "couli-svc: no egress"\n\t}\n}', 0);
}
if (cmd === 'install') {
  fs.mkdirSync(rest.at(-1), { recursive: true });
  out('', 0);
}
if (cmd === 'systemd-run') {
  const unit = (rest.find((a) => a.startsWith('--unit=')) || '').slice('--unit='.length);
  if (unit.endsWith('-initdb')) {
    if (fail.includes('initdb')) out('initdb: error: stub', 1);
    const dir = rest[rest.indexOf('sh', rest.indexOf('--')) + 1];
    fs.mkdirSync(dir + '/pgdata', { recursive: true });
  }
  if (unit.endsWith('-pg')) {
    const sock = rest.find((a) => a.startsWith('unix_socket_directories=')).split('=')[1];
    fs.writeFileSync(sock + '/.s.PGSQL.5432', '');
  }
  if (unit.endsWith('-redis')) fs.writeFileSync(rest[rest.indexOf('--unixsocket') + 1], '');
  out('', 0);
}
if (cmd === 'systemctl') {
  if (rest[0] === 'list-units')
    out((process.env.STUB_SUDO_UNITS || '').split(',').filter((u) => u !== '').map((u) => u + ' loaded active running stub').join('\n'), 0);
  if (rest[0] === 'stop') out('', fail.includes('stop') ? 1 : 0);
  if (rest[0] === 'show') {
    if (late('state-empty')) out('', 0);
    if (late('state-timeout')) process.exit(124);
    if (late('state-error')) {
      process.stderr.write('Failed to connect to bus: stub\n');
      process.exit(1);
    }
    if (fail.includes('stop')) out('LoadState=loaded\nActiveState=active', 0);
    out('LoadState=not-found\nActiveState=inactive', 0);
  }
  if (rest[0] === 'is-active') {
    if (fail.includes('pg-exits') && rest[1].endsWith('-pg.service')) out('failed', 3);
    out('inactive', 3);
  }
  out('', 0);
}
if (cmd === 'pgrep') {
  if (late('procs-left')) out('4711 postgres', 0);
  if (late('pgrep-error')) process.exit(3);
  out('', 1);
}
if (cmd === 'sh' && rest[0] === '-c') {
  // The real host-check script of verify-container.sh, with fake findmnt, stat, pgrep, ipcs,
  // ipcrm and find first on PATH; sudo itself refusing is presence-error / procs-sudo-error.
  const check = rest[2];
  if (check === 'couli-presence' && late('presence-error')) process.exit(1);
  if (check === 'couli-procs' && late('procs-sudo-error')) process.exit(1);
  const fake = path.join(path.dirname(process.argv[1]), 'fake');
  const r = spawnSync('sh', rest, { stdio: 'inherit', env: { ...process.env, PATH: fake + ':' + process.env.PATH } });
  process.exit(r.status ?? 1);
}
if (cmd === 'journalctl') out('stub journal', 0);
if (cmd === 'rm' && fail.includes('rm')) out('rm: stub refuses', 1);
if (cmd === 'find' || cmd === 'rm') real(cmd, rest);
out('', 0);
`;
// Fake host commands for the real check script (see the sudo stub): the same failure switches.
const FAKEHOST = String.raw`'use strict';
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const [name, ...args] = process.argv.slice(2);
const fail = (process.env.STUB_SUDO_FAIL || '').split(',');
const dockerLog = process.env.STUB_DOCKER_LOG;
const after = fs.existsSync(dockerLog) && fs.readFileSync(dockerLog, 'utf8').includes('couli-verify-entrypoint');
const late = (mode) => after && fail.includes(mode);
const out = (text, code) => {
  if (text !== '') fs.writeSync(1, text + '\n'); // CT-06zxf (D10-375): written before the exit
  process.exit(code);
};
if (name === 'findmnt') {
  if (fail.includes('root-not-mount')) out('', 1);
  out(args[args.indexOf('--mountpoint') + 1] + ' ' + (fail.includes('root-not-tmpfs') ? 'ext4' : 'tmpfs'), 0);
}
if (name === 'stat') out(fail.includes('root-owner') ? 'root 755' : 'couli-svc 700', 0);
if (name === 'pgrep') {
  if (late('procs-left')) out('4711 postgres', 0);
  if (late('pgrep-error')) out('', 3);
  out('', 1);
}
if (name === 'ipcs') {
  if (late('ipcs-fails')) out('', 1);
  const header = '------ Shared Memory Segments --------\nkey        shmid      owner      perms      bytes      nattch     status';
  out(late('ipc-left') ? header + '\n0x00000000 7          couli-svc  600        4096       0' : header, 0);
}
if (name === 'ipcrm') out('', 0);
if (name === 'find') {
  if (args.some((a) => a === '/dev/shm' || a === '/dev/mqueue')) out('', late('find-fails') ? 1 : 0);
  const r = spawnSync('find', args, { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}
out('', 2);
`;
const ID_STUB = `#!/bin/sh
case "$1 $2" in
  '-u couli-svc') echo 4242 ;;
  '-Gn couli-svc') echo couli-sock ;;
  *) exec /usr/bin/id "$@" ;;
esac
`;
const GETENT_STUB = `#!/bin/sh
if [ "$1 $2" = 'group couli-sock' ]; then echo 'couli-sock:x:4243:'; exit 0; fi
exec /usr/bin/getent "$@"
`;
// GNU timeout's interface, without the limit (the stub host answers at once); STUB_REAL_TIMEOUT=1
// uses the real one.
const TIMEOUT_STUB = `#!/bin/sh
if [ -n "\${STUB_REAL_TIMEOUT:-}" ] && [ -x /usr/bin/timeout ]; then exec /usr/bin/timeout "$@"; fi
while [ $# -gt 0 ]; do
  case "$1" in
    -k) shift 2 ;;
    -*) shift ;;
    *) shift; break ;;
  esac
done
exec "$@"
`;

type SudoCall = { args: string[]; stdin: string };

let hostBin = '';
function hostBinDir(): string {
  if (hostBin !== '') return hostBin;
  hostBin = join(base, 'hostbin');
  writeFiles(hostBin, { 'sudo-stub.cjs': SUDO_STUB });
  const scripts: Record<string, string> = {
    sudo: `#!/bin/sh\nexec '${process.execPath}' '${join(hostBin, 'sudo-stub.cjs')}' "$@"\n`,
    id: ID_STUB,
    getent: GETENT_STUB,
    timeout: TIMEOUT_STUB,
  };
  for (const [name, body] of Object.entries(scripts)) {
    writeFileSync(join(hostBin, name), body);
    chmodSync(join(hostBin, name), 0o755);
  }
  writeFiles(join(hostBin, 'fake'), { 'fakehost.cjs': FAKEHOST });
  for (const name of ['findmnt', 'stat', 'pgrep', 'ipcs', 'ipcrm', 'find']) {
    const file = join(hostBin, 'fake', name);
    writeFileSync(
      file,
      `#!/bin/sh\nexec '${process.execPath}' '${join(hostBin, 'fake', 'fakehost.cjs')}' ${name} "$@"\n`,
    );
    chmodSync(file, 0o755);
  }
  // Every command line of node, sed, awk and grep the script runs is recorded (STUB_ARGV_LOG):
  // the one-shot password must be in none of them.
  for (const name of ['node', 'sed', 'awk', 'grep']) {
    const real =
      name === 'node'
        ? process.execPath
        : spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).stdout.trim();
    const file = join(hostBin, name);
    writeFileSync(
      file,
      `#!/bin/sh\nif [ -n "\${STUB_ARGV_LOG:-}" ]; then printf '%s\\n' "${name} $*" >>"$STUB_ARGV_LOG"; fi\nexec '${real}' "$@"\n`,
    );
    chmodSync(file, 0o755);
  }
  // The installed binaries the script checks for (never run: sudo answers for them).
  for (const exe of [
    'pg/initdb',
    'pg/postgres',
    'pg/pg_isready',
    'redis/redis-server',
    'redis/redis-cli',
  ]) {
    writeFiles(join(base, 'hostsvc-bin'), { [exe]: '#!/bin/sh\nexit 99\n' });
    chmodSync(join(base, 'hostsvc-bin', exe), 0o755);
  }
  return hostBin;
}

let hostRuns = 0;
/** Runs the script with host services on, the stub host and its own tmpfs stand-in. */
function hostRun(
  args: string[],
  env: Record<string, string> = {},
  prepare?: (svcRoot: string, registry: string) => void,
): Run & { sudo: SudoCall[]; svcRoot: string; registry: string; argv: string } {
  hostRuns += 1;
  const svcRoot = join(base, `svc-root-${String(hostRuns)}`);
  const lockDir = join(base, `svc-lock-${String(hostRuns)}`);
  mkdirSync(svcRoot, { recursive: true });
  mkdirSync(lockDir, { recursive: true });
  const registry = join(lockDir, 'couli-host-services.runs');
  prepare?.(svcRoot, registry);
  const sudoLog = join(base, `sudo-${String(hostRuns)}.jsonl`);
  const argvLog = join(base, `argv-${String(hostRuns)}.log`);
  const res = run(args, {
    PATH: `${hostBinDir()}:${bin}:${process.env['PATH'] ?? ''}`,
    COULI_VERIFY_HOST_SERVICES: '1',
    COULI_VERIFY_SVC_ROOT: svcRoot,
    COULI_VERIFY_SVC_LOCK: join(lockDir, 'couli-host-services.lock'),
    COULI_VERIFY_PG_BIN: join(base, 'hostsvc-bin', 'pg'),
    COULI_VERIFY_REDIS_BIN: join(base, 'hostsvc-bin', 'redis'),
    STUB_SUDO_LOG: sudoLog,
    STUB_ARGV_LOG: argvLog,
    ...env,
  });
  const sudo = existsSync(sudoLog)
    ? readFileSync(sudoLog, 'utf8')
        .split('\n')
        .filter((l) => l !== '')
        .map((l) => JSON.parse(l) as SudoCall)
    : [];
  const argv = existsSync(argvLog) ? readFileSync(argvLog, 'utf8') : '';
  return { ...res, sudo, svcRoot, registry, argv };
}

/** `systemd-run` calls of the stub host by unit suffix (initdb, pg, redis). */
function unitRun(sudo: readonly SudoCall[], suffix: string): SudoCall | undefined {
  return sudo.find(
    (c) =>
      c.args.includes('systemd-run') &&
      c.args.some((a) => a.startsWith('--unit=') && a.endsWith(`-${suffix}`)),
  );
}

/** `-p` properties of a systemd-run call. */
function properties(call: SudoCall | undefined): string[] {
  const a = call?.args ?? [];
  return a.flatMap((x, i) => (a[i - 1] === '-p' ? [x] : []));
}

/** `-v` mounts of a `docker run`. */
function mountsOf(args: readonly string[]): string[] {
  return args.flatMap((a, i) => (args[i - 1] === '-v' ? [a] : []));
}

const HOST_PG_URL = /^postgres:\/\/postgres:([0-9a-f]{32})@127\.0\.0\.1:5432\/postgres$/;

/** Passwords of the host-services PostgreSQL URLs handed to the container of `call`. */
function hostPgPasswords(call: Call | undefined): string[] {
  return Object.values(call?.env ?? {}).flatMap((v) => {
    const m = v === null ? null : HOST_PG_URL.exec(v);
    return m?.[1] === undefined ? [] : [m[1]];
  });
}

it(
  'host services: pnpm verify gets a fresh sandboxed PostgreSQL and Redis as couli-svc, reaches only their sockets, and the result exists only after they are gone',
  () => {
    const res = hostRun(['V4-01', '--worktree', workspace('host-verify')], {
      STUB_DOCKER_RUN_EXIT: '3',
    });
    expect(res.status, res.stderr).toBe(3);
    const dir = join(runs, 'V4-01', 'verify', '1');
    const result = JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(result).toMatchObject({
      mode: 'container',
      script: 'verify',
      exit_code: 3,
      services: 'host-ephemeral',
    });

    // No service container and no network at all.
    const { calls, sudo } = res;
    expect(calls.some((c) => c.args[0] === 'network')).toBe(false);
    expect(calls.some((c) => c.args[0] === 'run' && c.args.includes('-d'))).toBe(false);

    // Isolation checked first (rule and live probe), then what an earlier run left, then the units.
    const at = (pred: (c: SudoCall) => boolean): number => sudo.findIndex(pred);
    const nftAt = at((c) => c.args.includes('nft'));
    const probeAt = at(
      (c) =>
        c.args.includes('-u') && c.args.includes('bash') && c.args.join(' ').includes('/dev/tcp/'),
    );
    const sweepAt = at((c) => c.args.includes('list-units'));
    const initdbAt = sudo.indexOf(unitRun(sudo, 'initdb') as SudoCall);
    expect(sudo[nftAt]?.args).toEqual([
      '-n',
      'nft',
      'list',
      'chain',
      'inet',
      'couli_isolation',
      'output',
    ]);
    expect(nftAt).toBeGreaterThanOrEqual(0);
    expect(probeAt).toBeGreaterThan(nftAt);
    expect(sweepAt).toBeGreaterThan(probeAt);
    expect(initdbAt).toBeGreaterThan(sweepAt);
    expect(
      calls.some((c) => c.args[0] === 'ps' && c.args.includes('label=couli.services=host')),
    ).toBe(true);

    // Every unit runs as couli-svc in the sandbox.
    const runDir = (unitRun(sudo, 'initdb')?.args ?? []).at(-2) ?? '';
    expect(runDir).toMatch(new RegExp(`^${res.svcRoot}/v4-01-1-\\d+$`));
    for (const suffix of ['initdb', 'pg', 'redis']) {
      const call = unitRun(sudo, suffix);
      expect(call?.args).toEqual(
        expect.arrayContaining(['--uid=couli-svc', '--gid=couli-sock', '--collect']),
      );
      expect(properties(call)).toEqual(
        expect.arrayContaining([
          'PrivateNetwork=yes',
          'RestrictAddressFamilies=AF_UNIX',
          'IPAddressDeny=any',
          'NoNewPrivileges=yes',
          'ProtectSystem=strict',
          'ProtectHome=yes',
          `ReadWritePaths=${runDir}`,
          'TemporaryFileSystem=/run:ro',
          'CapabilityBoundingSet=',
          'ProtectProc=invisible',
          // No host IPC, limits, the system-service calls only; /tmp, /var/tmp and /dev/shm in
          // the run directory on the tmpfs (no PrivateTmp on the host's disk).
          'PrivateIPC=yes',
          'RemoveIPC=yes',
          'MemoryMax=4G',
          'TasksMax=512',
          'SystemCallFilter=@system-service',
          `BindPaths=${runDir}/tmp:/tmp ${runDir}/vartmp:/var/tmp ${runDir}/shm:/dev/shm`,
        ]),
      );
      // The code, the logs and the host services' configuration (Pigsty's passwords) are hidden.
      const hidden = (properties(call).find((p) => p.startsWith('InaccessiblePaths=')) ?? '')
        .slice('InaccessiblePaths='.length)
        .split(' ');
      expect(hidden).toEqual(
        expect.arrayContaining([
          '-/Users',
          '-/var/log',
          '-/data',
          '-/etc/grafana',
          '-/etc/pg_exporter.yml',
          '-/etc/alertmanager.yml',
        ]),
      );
    }
    // The password reaches initdb on stdin only.
    const initdb = unitRun(sudo, 'initdb');
    const password = /^([0-9a-f]{32})\n$/.exec(initdb?.stdin ?? '')?.[1] ?? '';
    expect(password).toMatch(/^[0-9a-f]{32}$/);
    expect(initdb?.args).toContain('--pipe');
    // PostgreSQL: no TCP, socket only, in the run's socket directory, group access only.
    const pg = unitRun(sudo, 'pg')?.args ?? [];
    expect(pg).toEqual(
      expect.arrayContaining([
        'listen_addresses=',
        `unix_socket_directories=${runDir}/sock`,
        'unix_socket_permissions=0770',
      ]),
    );
    expect(properties(unitRun(sudo, 'pg'))).toEqual(
      expect.arrayContaining([expect.stringMatching(/^RuntimeMaxSec=\d+$/)]),
    );
    // Redis: no TCP, no persistence, the limits of the local stack, dangerous commands disabled.
    const redis = unitRun(sudo, 'redis')?.args ?? [];
    const after = redis.slice(redis.indexOf('--') + 2);
    expect(settings(after.slice(0, 16))).toMatchObject({
      port: '0',
      unixsocket: `${runDir}/sock/redis.sock`,
      unixsocketperm: '770',
      ...REDIS_SETTINGS,
    });
    const renamed = after.flatMap((a, i) => (after[i - 1] === '--rename-command' ? [a] : []));
    expect(renamed).toEqual(
      expect.arrayContaining(['MIGRATE', 'REPLICAOF', 'SLAVEOF', 'MODULE', 'DEBUG']),
    );
    // CONFIG stays (the Redis rule tests read maxmemory-policy); protected settings are immutable.
    expect(renamed).not.toContain('CONFIG');
    expect(
      settings(
        after.slice(
          after.indexOf('--enable-protected-configs'),
          after.indexOf('--enable-protected-configs') + 6,
        ),
      ),
    ).toEqual({
      'enable-protected-configs': 'no',
      'enable-debug-command': 'no',
      'enable-module-command': 'no',
    });
    for (const c of renamed) expect(after[after.indexOf(c) + 1]).toBe('');

    // The verify container: no network, only the run's socket directory and the proxy, the socket
    // group, the label the next run sweeps by, the proxy routes; the URL carries the password.
    const verify = entrypointRun(calls);
    const args = verify?.args ?? [];
    expect(valueOf(args, '--network')).toBe('none');
    expect(valueOf(args, '--group-add')).toBe('4243');
    expect(args).toEqual(expect.arrayContaining(['--label', 'couli.services=host']));
    expect(mountsOf(args)).toEqual([
      `${runDir}/sock:/run/couli-services:ro`,
      expect.stringMatching(
        /\/V4-01\/verify\/1\/services-proxy\.cjs:\/couli-services\/proxy\.cjs:ro$/,
      ),
      expect.stringMatching(/\/V4-01\/verify\/1\/src:\/src:ro$/),
      expect.stringMatching(/^couli-stubtest-store-[0-9a-f]{16}:\/store:ro$/),
    ]);
    expect(args.slice(-5, -2)).toEqual([
      '-c',
      expect.stringContaining('exec "$@"'),
      'couli-services',
    ]);
    expect(JSON.parse(verify?.env['COULI_SERVICES_ROUTES'] ?? '[]')).toEqual([
      [5432, '/run/couli-services/.s.PGSQL.5432'],
      [6379, '/run/couli-services/redis.sock'],
    ]);
    expect(passedEnv(args)).toEqual(expect.arrayContaining(['TEST_REDIS_URL']));
    // Exactly one PostgreSQL URL (found by its value, passed by name) with initdb's password.
    expect(hostPgPasswords(verify)).toEqual([password]);
    expect(verify?.env['TEST_REDIS_URL']).toBe('redis://127.0.0.1:6379/0');
    for (const flag of ['--init', '--read-only', 'no-new-privileges']) expect(args).toContain(flag);

    // Afterwards: units stopped, run directory removed (and checked), before result.json.
    const stopAt = at(
      (c) => c.args.includes('stop') && c.args.some((a) => a.endsWith('-pg.service')),
    );
    const rmAt = at((c) => c.args.includes('rm') && c.args.includes(runDir));
    expect(stopAt).toBeGreaterThan(initdbAt);
    expect(rmAt).toBeGreaterThan(stopAt);
    expect(existsSync(runDir)).toBe(false);
    const log = readFileSync(join(dir, 'log.txt'), 'utf8');
    expect(log.indexOf('host services of this run stopped and removed')).toBeGreaterThan(-1);
    // Removal is confirmed, not assumed: the units' state, no process left, the directory absent,
    // no IPC or shared memory left; the run leaves the registry.
    const cleanupCalls = sudo.slice(stopAt);
    expect(
      cleanupCalls.some((c) => c.args.includes('show') && c.args.includes('ActiveState')),
    ).toBe(true);
    expect(cleanupCalls.some((c) => c.args.includes('couli-procs'))).toBe(true);
    expect(
      cleanupCalls.some((c) => c.args.includes('couli-presence') && c.args.includes(runDir)),
    ).toBe(true);
    expect(cleanupCalls.some((c) => c.args.includes('couli-residue'))).toBe(true);
    expect(readFileSync(res.registry, 'utf8')).toBe('');
    // The instance root was checked (dedicated tmpfs) before anything was swept or created.
    const rootAt = at((c) => c.args.includes('couli-rootcheck'));
    expect(rootAt).toBeGreaterThan(probeAt);
    expect(rootAt).toBeLessThan(sweepAt);
    // Provenance of the gate, recorded in the result itself.
    const gate = result['gate'] as { commit: unknown; clean: unknown; script_sha256: unknown };
    expect(Object.keys(gate).sort()).toEqual(['clean', 'commit', 'script_sha256']);
    expect(gate.commit === null || /^[0-9a-f]{40,64}$/.test(String(gate.commit))).toBe(true);
    expect(typeof gate.clean).toBe('boolean');
    expect(gate.script_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(properties(unitRun(sudo, 'pg'))).not.toContain('PrivateTmp=yes');

    // The password is in no command line, log or output; the proxy file is gone.
    for (const text of [
      res.stdout,
      res.stderr,
      log,
      JSON.stringify(calls.map((c) => c.args)),
      JSON.stringify(sudo.map((c) => c.args)),
    ]) {
      expect(text).not.toContain(password);
    }
    expect(existsSync(join(dir, 'services-proxy.cjs'))).toBe(false);
  },
  CLI_TIMEOUT,
);

it(
  'host services: --fast and a unit-only --red start none; an integration --red group gets them and they are removed',
  () => {
    const fast = hostRun(['V4-02', '--worktree', workspace('host-fast'), '--fast']);
    expect(fast.status, fast.stderr).toBe(0);
    expect(fast.sudo).toEqual([]);
    const fastResult = JSON.parse(
      readFileSync(join(runs, 'V4-02', 'verify-fast', '1', 'result.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(fastResult['services']).toBeUndefined();

    const unit = hostRun([
      'B1-02b',
      '--worktree',
      redFixture('host-red-unit', {
        'test/spec/identity/devices.test.ts': "it('[BR-ID-05] x', () => {});\n",
      }),
      '--red',
      '--base',
      'main',
    ]);
    expect(unit.status).toBe(2);
    expect(unit.sudo).toEqual([]);
    expect(noRedisUrl(entrypointRun(unit.calls))).toBe(true);

    const int = hostRun([
      'B1-02b',
      '--worktree',
      redFixture('host-red-int', {
        'test/spec/identity/devices.int.test.ts': "it('[BR-ID-05] y', () => {});\n",
      }),
      '--red',
      '--base',
      'main',
    ]);
    // The stub writes no report: the run stops after the red container (exit 2); the services
    // are removed all the same.
    expect(int.status).toBe(2);
    expect(int.stderr).toContain('wrote no report for spec-int');
    const red = entrypointRun(int.calls);
    expect(red?.args.slice(-2)).toEqual(['couli-verify-entrypoint', 'red']);
    expect(valueOf(red?.args ?? [], '--network')).toBe('none');
    expect(hostPgPasswords(red)).toHaveLength(1);
    expect(unitRun(int.sudo, 'pg')).toBeDefined();
    expect(int.sudo.some((c) => c.args.includes('rm'))).toBe(true);
    expect(readdirOf(int.svcRoot)).toEqual([]);
  },
  CLI_TIMEOUT,
);

function readdirOf(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir) : [];
}

it(
  'host services: no egress rule, a rule that accepts, or a probe that gets out stops the run before any service starts (exit 2, no result)',
  () => {
    for (const [i, failure] of ['firewall-missing', 'firewall-accept', 'egress-open'].entries()) {
      const id = `V4-1${String(i)}`;
      const res = hostRun([id, '--worktree', workspace(`host-fw-${failure}`)], {
        STUB_SUDO_FAIL: failure,
      });
      expect(res.status, failure).toBe(2);
      expect(res.stderr).toContain("the host services' isolation is not in place");
      expect(unitRun(res.sudo, 'initdb')).toBeUndefined();
      expect(entrypointRun(res.calls)).toBeUndefined();
      expect(existsSync(join(runs, id, 'verify', '1', 'result.json'))).toBe(false);
    }
  },
  CLI_TIMEOUT,
);

it(
  '[CT-06zxf] host services: a rule that does not block writes the nft listing it received to the run log (D10-375)',
  () => {
    const res = hostRun(['V4-13', '--worktree', workspace('host-fw-listing')], {
      STUB_SUDO_FAIL: 'firewall-accept',
    });
    expect(res.status).toBe(2);
    const log = readFileSync(join(runs, 'V4-13', 'verify', '1', 'log.txt'), 'utf8');
    expect(log).toContain('nft list chain inet couli_isolation output, as received:');
    expect(log).toContain(
      'meta skuid 4242 counter packets 0 bytes 0 accept comment "couli-svc: no egress"',
    );
  },
  CLI_TIMEOUT,
);

// CT-06zp: this case runs verify-container.sh three times (failed initdb, PostgreSQL exiting
// early, Redis still knowing MIGRATE), each through the whole preamble; no single wait dominates
// (the stub reports the unit `failed` on the first readiness poll). Green on main in CI it took
// 17.5–26.6 s (12 runs, 2026-10-22/23) and hit the 30 s CLI_TIMEOUT now and then (since 10-15,
// #476; again #1368 at 30.2 s). 90 s is about 3× the longest observed, as in CT-06zb; assertions
// are unchanged. It does not bound a hang: hostRun is synchronous, the script's own 60 s readiness
// limit and the CI job limit do.
const INITDB_CASE_TIMEOUT = 90_000;
it(
  'host services: a failed initdb or a PostgreSQL that exits stops the run (exit 2, no result) and the run directory is removed',
  () => {
    const initdb = hostRun(['V4-20', '--worktree', workspace('host-initdb')], {
      STUB_SUDO_FAIL: 'initdb',
    });
    expect(initdb.status).toBe(2);
    expect(initdb.stderr).toContain('initdb of the one-shot PostgreSQL failed');
    expect(unitRun(initdb.sudo, 'pg')).toBeUndefined();
    expect(entrypointRun(initdb.calls)).toBeUndefined();
    expect(readdirOf(initdb.svcRoot)).toEqual([]);
    expect(existsSync(join(runs, 'V4-20', 'verify', '1', 'result.json'))).toBe(false);

    const exits = hostRun(['V4-21', '--worktree', workspace('host-pg-exits')], {
      STUB_SUDO_FAIL: 'pg-exits',
    });
    expect(exits.status).toBe(2);
    expect(exits.stderr).toContain('PostgreSQL exited before it became ready');
    expect(exits.sudo.some((c) => c.args.includes('journalctl'))).toBe(true);
    expect(entrypointRun(exits.calls)).toBeUndefined();
    expect(readdirOf(exits.svcRoot)).toEqual([]);

    const config = hostRun(['V4-22', '--worktree', workspace('host-redis-migrate')], {
      STUB_SUDO_FAIL: 'redis-migrate',
    });
    expect(config.status).toBe(2);
    expect(config.stderr).toContain('still knows MIGRATE');
    expect(entrypointRun(config.calls)).toBeUndefined();
  },
  INITDB_CASE_TIMEOUT,
);

it(
  'host services: when the clean-up fails a green run is an infrastructure error (exit 2) and writes no result',
  () => {
    // Every way of not knowing counts as not removed: a state query that answers nothing, times
    // out or cannot reach systemd, a presence check that cannot run, processes or IPC left, a
    // process listing that fails.
    const failures = [
      'rm',
      'stop',
      'state-empty',
      'state-timeout',
      'state-error',
      'presence-error',
      'procs-left',
      'pgrep-error',
      'ipc-left',
      // Failures inside the real check script, and sudo refusing it (formerly read as "none").
      'ipcs-fails',
      'find-fails',
      'procs-sudo-error',
    ];
    for (const [i, failure] of failures.entries()) {
      const id = `V4-3${String(i)}a`;
      const res = hostRun([id, '--worktree', workspace(`host-cleanup-${failure}`)], {
        STUB_SUDO_FAIL: failure,
      });
      expect(entrypointRun(res.calls)).toBeDefined();
      expect(res.status, failure).toBe(2);
      expect(res.stderr).toContain('could not be removed');
      expect(existsSync(join(runs, id, 'verify', '1', 'result.json'))).toBe(false);
    }
  },
  CLI_TIMEOUT * 6,
);

it(
  'host services: what an earlier killed run left (container, units, directories) is removed under the lock before the services start',
  () => {
    const res = hostRun(
      ['V4-40', '--worktree', workspace('host-sweep')],
      {
        STUB_DOCKER_ORPHANS: 'deadbeef0001,deadbeef0002',
        STUB_SUDO_UNITS: 'couli-svc-x-1-9-pg.service,couli-svc-x-1-9-redis.service',
      },
      (root, registry) => {
        writeFiles(root, { 'x-1-9/pgdata/PG_VERSION': '18\n' });
        writeFileSync(registry, 'x-1-9\n');
      },
    );
    expect(res.status, res.stderr).toBe(0);
    const rmOrphans = res.calls.find((c) => c.args[0] === 'rm' && c.args.includes('deadbeef0001'));
    expect(rmOrphans?.args).toEqual(['rm', '-f', '-v', 'deadbeef0001', 'deadbeef0002']);
    const stopOrphans = res.sudo.find(
      (c) => c.args.includes('stop') && c.args.includes('couli-svc-x-1-9-pg.service'),
    );
    expect(stopOrphans?.args).toEqual(expect.arrayContaining(['couli-svc-x-1-9-redis.service']));
    expect(res.sudo.indexOf(stopOrphans as SudoCall)).toBeLessThan(
      res.sudo.indexOf(unitRun(res.sudo, 'initdb') as SudoCall),
    );
    expect(res.calls.indexOf(rmOrphans as Call)).toBeLessThan(
      res.calls.indexOf(entrypointRun(res.calls) as Call),
    );
    expect(readdirOf(res.svcRoot)).toEqual([]);
    expect(readFileSync(res.registry, 'utf8')).toBe('');

    // A directory no registered run owns is never removed: the run stops instead.
    const stray = hostRun(['V4-41', '--worktree', workspace('host-stray')], {}, (root) =>
      writeFiles(root, { 'not-ours/keep': 'x' }),
    );
    expect(stray.status).toBe(2);
    expect(stray.stderr).toContain('cannot remove what an earlier run left');
    expect(readFileSync(join(runs, 'V4-41', 'verify', '1', 'log.txt'), 'utf8')).toContain(
      'holds entries no registered run owns (not removed): not-ours',
    );
    expect(existsSync(join(stray.svcRoot, 'not-ours', 'keep'))).toBe(true);
    expect(unitRun(stray.sudo, 'initdb')).toBeUndefined();
  },
  CLI_TIMEOUT,
);

it(
  'host services: an instance root that is not the dedicated tmpfs (not a mount point, not tmpfs, wrong owner or mode) stops the run before anything is swept or created',
  () => {
    for (const [i, failure] of ['root-not-mount', 'root-not-tmpfs', 'root-owner'].entries()) {
      const id = `V4-7${String(i)}`;
      const res = hostRun(
        [id, '--worktree', workspace(`host-${failure}`)],
        { STUB_SUDO_FAIL: failure },
        (root) => writeFiles(root, { 'something/else': 'x' }),
      );
      expect(res.status, failure).toBe(2);
      expect(res.stderr).toContain('the instance root is not the dedicated tmpfs');
      expect(res.sudo.some((c) => c.args.includes('list-units'))).toBe(false);
      expect(unitRun(res.sudo, 'initdb')).toBeUndefined();
      expect(existsSync(join(res.svcRoot, 'something', 'else'))).toBe(true);
    }
  },
  CLI_TIMEOUT,
);

it(
  'host services: a second run waits for the lock (flock) held by the first',
  async () => {
    mkdirSync(join(base, 'shared-lock'), { recursive: true });
    const lock = join(base, 'shared-lock', 'couli-host-services.lock');
    const holder = spawn('flock', [lock, 'sleep', '3'], { stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 500));
    const started = Date.now();
    const res = hostRun(['V4-50', '--worktree', workspace('host-lock')], {
      COULI_VERIFY_SVC_LOCK: lock,
    });
    const waited = Date.now() - started;
    holder.kill();
    expect(res.status, res.stderr).toBe(0);
    expect(waited).toBeGreaterThanOrEqual(2000);
    expect(readFileSync(join(runs, 'V4-50', 'verify', '1', 'log.txt'), 'utf8')).toContain(
      'waiting for the host-services lock',
    );
  },
  CLI_TIMEOUT,
);

it(
  'host services: COULI_VERIFY_HOST_SERVICES other than 1, or a path that is not plain, stops before anything runs',
  () => {
    const bad = run(['V4-60', '--worktree', workspace('host-bad')], {
      COULI_VERIFY_HOST_SERVICES: 'yes',
    });
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain('COULI_VERIFY_HOST_SERVICES must be 1');
    expect(bad.calls).toEqual([]);
    const root = run(['V4-61', '--worktree', workspace('host-root')], {
      COULI_VERIFY_HOST_SERVICES: '1',
      COULI_VERIFY_SVC_ROOT: '/var/lib/x y',
    });
    expect(root.status).toBe(2);
    expect(root.stderr).toContain('host service paths must be absolute');
    expect(root.calls).toEqual([]);
  },
  CLI_TIMEOUT,
);

/** The one-shot password of a host-services run (what initdb got on stdin). */
function oneShotPassword(sudo: readonly SudoCall[]): string {
  return /^([0-9a-f]{32})\n$/.exec(unitRun(sudo, 'initdb')?.stdin ?? '')?.[1] ?? '';
}

it(
  'host services: the one-shot password is replaced in the log and in red reports, and is in no command line, the redaction included',
  () => {
    const res = hostRun(['V4-80', '--worktree', workspace('host-redact')], {
      STUB_DOCKER_ECHO_URL: '1',
    });
    expect(res.status, res.stderr).toBe(0);
    const password = oneShotPassword(res.sudo);
    expect(password).toMatch(/^[0-9a-f]{32}$/);
    const dir = join(runs, 'V4-80', 'verify', '1');
    const log = readFileSync(join(dir, 'log.txt'), 'utf8');
    expect(log).toContain('connecting to postgres://postgres:[one-shot password]@127.0.0.1:5432/');
    expect(log).not.toContain(password);
    expect(readFileSync(join(dir, 'result.json'), 'utf8')).not.toContain(password);
    // node (the redaction, the proxy, red-plan ...), sed, awk and grep ran, never with it.
    expect(res.argv).toContain('node -e');
    expect(res.argv).not.toContain(password);
    for (const c of res.sudo) expect(c.args.join(' ')).not.toContain(password);
    for (const c of res.calls) expect(c.args.join(' ')).not.toContain(password);

    const red = hostRun(
      [
        'B1-02b',
        '--worktree',
        redFixture('host-redact-red', {
          'test/spec/identity/devices.int.test.ts': "it('[BR-ID-05] y', () => {});\n",
        }),
        '--red',
        '--base',
        'main',
      ],
      { STUB_DOCKER_RED_URL: '1' },
    );
    // The stub's report is no Vitest report: red-check does not pass it (exit 1 or 2); the report
    // is redacted all the same.
    expect([1, 2]).toContain(red.status);
    const redPassword = oneShotPassword(red.sudo);
    const n = readdirSync(join(runs, 'B1-02b', 'red'))
      .map(Number)
      .sort((x, y) => x - y)
      .at(-1);
    const report = readFileSync(
      join(runs, 'B1-02b', 'red', String(n), 'out', 'spec-int.json'),
      'utf8',
    );
    expect(report).toContain('[one-shot password]');
    expect(report).not.toContain(redPassword);
    expect(red.argv).not.toContain(redPassword);
  },
  CLI_TIMEOUT,
);

it(
  'host services: a docker run that outlives the host-side limit is removed, the services are stopped, and no result is written',
  () => {
    const res = hostRun(['V4-81', '--worktree', workspace('host-limit')], {
      STUB_REAL_TIMEOUT: '1',
      COULI_VERIFY_SVC_RUN_LIMIT: '2',
      STUB_DOCKER_SLEEP: '20',
    });
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('exceeded the host-side limit of 2s');
    expect(existsSync(join(runs, 'V4-81', 'verify', '1', 'result.json'))).toBe(false);
    const verifyAt = res.calls.findIndex((c) => c.args.includes('couli-verify-entrypoint'));
    const name = valueOf(res.calls[verifyAt]?.args ?? [], '--name') ?? '';
    const rmAt = res.calls.findIndex(
      (c, i) => i > verifyAt && c.args[0] === 'rm' && c.args.includes(name),
    );
    expect(rmAt).toBeGreaterThan(verifyAt);
    expect(
      res.sudo.some(
        (c) => c.args.includes('stop') && c.args.some((a) => a.endsWith('-pg.service')),
      ),
    ).toBe(true);
    expect(readdirOf(res.svcRoot)).toEqual([]);
  },
  CLI_TIMEOUT,
);

it(
  '[CT-06p] --red hands red-check the base and the snapshot tree: unchanged tests of a file that existed at the base are exempt',
  () => {
    const t = (title: string, body: string): string => `it('${title}', () => {\n  ${body}\n});\n`;
    const vitest = "import { expect, it } from 'vitest';\n";
    const file = 'test/spec/identity/devices.test.ts';
    // main holds the rule test as merged; the task changes the assertion of [BR-ID-05] a only.
    const repo = redFixture('red-base-exempt', {
      [file]:
        vitest + t('[BR-ID-05] a', 'expect(1).toBe(1);') + t('[BR-ID-05] b', 'expect(2).toBe(2);'),
    });
    fixtureGit(repo, ['add', '-A']);
    fixtureGit(repo, ['commit', '-q', '-m', 'base: the rule test as merged']);
    writeFiles(repo, {
      [file]:
        vitest + t('[BR-ID-05] a', 'expect(1).toBe(3);') + t('[BR-ID-05] b', 'expect(2).toBe(2);'),
    });
    const report = join(base, 'red-base-exempt.json');
    writeFileSync(
      report,
      JSON.stringify({
        reporter: 'couli-red-reporter',
        testResults: [
          {
            name: `/work/repo/${file}`,
            assertionResults: [
              {
                fullName: '[BR-ID-05] a',
                status: 'failed',
                failures: [{ causes: [{ name: 'AssertionError', message: 'expected 1 to be 3' }] }],
              },
              { fullName: '[BR-ID-05] b', status: 'passed', failures: [] },
            ],
          },
        ],
      }),
    );
    const res = run(['B1-02b', '--worktree', repo, '--red', '--base', 'main'], {
      STUB_DOCKER_RED_REPORT: report,
    });
    expect(res.status, res.stderr).toBe(0);
    const n = readdirSync(join(runs, 'B1-02b', 'red'))
      .map(Number)
      .sort((x, y) => x - y)
      .at(-1);
    const dir = join(runs, 'B1-02b', 'red', String(n));
    expect(JSON.parse(readFileSync(join(dir, 'red-check.json'), 'utf8'))).toMatchObject({
      ok: true,
      expected: [file],
      red: [`${file} > [BR-ID-05] a`],
      exempt: [{ file, test: '[BR-ID-05] b', status: 'passed' }],
    });
    expect(JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8'))).toMatchObject({
      script: 'red',
      exit_code: 0,
      red_tests: [`${file} > [BR-ID-05] a`],
    });
  },
  CLI_TIMEOUT,
);

/** result.json of the latest run of task `id` under `dir` (verify, verify-fast, browser, red). */
function latestResult(id: string, dir: string): Record<string, unknown> {
  const n = readdirSync(join(runs, id, dir))
    .map(Number)
    .sort((x, y) => x - y)
    .at(-1);
  const file = join(runs, id, dir, String(n), 'result.json');
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
}

/** A --red run of one new rule test whose report shows it red, so the run ends with a result. */
function redRunWithReport(name: string, env: Record<string, string>): Run {
  const file = 'test/spec/identity/devices.test.ts';
  const repo = redFixture(name, { [file]: "it('[BR-ID-05] x', () => {});\n" });
  const report = join(base, `${name}.json`);
  writeFileSync(
    report,
    JSON.stringify({
      reporter: 'couli-red-reporter',
      testResults: [
        {
          name: `/work/repo/${file}`,
          assertionResults: [
            {
              fullName: '[BR-ID-05] x',
              status: 'failed',
              failures: [{ causes: [{ name: 'AssertionError', message: 'expected 1 to be 2' }] }],
            },
          ],
        },
      ],
    }),
  );
  return run(['B1-02b', '--worktree', repo, '--red', '--base', 'main'], {
    STUB_DOCKER_RED_REPORT: report,
    ...env,
  });
}

/**
 * verify, --fast, --browser and --red: the container gets `count` and result.json records it;
 * with null the container gets no PROP_RUNS at all and result.json records JSON null.
 */
function expectPropRunsInEveryMode(
  id: string,
  label: string,
  env: Record<string, string>,
  count: number | null,
): void {
  const lock = lockWithPlaywright('1.63.0');
  const cases: [Run, string, string][] = [
    [run([id, '--worktree', workspace(`${label}-verify`)], env), id, 'verify'],
    [run([id, '--worktree', workspace(`${label}-fast`), '--fast'], env), id, 'verify-fast'],
    [
      run([id, '--worktree', workspace(`${label}-browser`, lock), '--browser'], {
        STUB_DOCKER_SCREENSHOT: '1',
        ...env,
      }),
      id,
      'browser',
    ],
    [redRunWithReport(`${label}-red`, env), 'B1-02b', 'red'],
  ];
  for (const [res, task, dir] of cases) {
    expect(res.status, res.stderr).toBe(0);
    const passed = passedEnv(entrypointRun(res.calls)?.args ?? []);
    expect(entrypointRun(res.calls)?.env['PROP_RUNS']).toBe(
      count === null ? undefined : String(count),
    );
    expect(passed.includes('PROP_RUNS')).toBe(count !== null);
    expect(latestResult(task, dir)['prop_runs']).toBe(count);
  }
}

it(
  '[CT-06zzc] no PROP_RUNS from the caller: no mode gets one and result.json records null (D10-499)',
  () => {
    expectPropRunsInEveryMode('V5-01', 'runs-unset', {}, null);
    expect(Object.keys(latestResult('V5-01', 'verify'))).toEqual([
      'mode',
      'script',
      'exit_code',
      'commit',
      'tree',
      'prop_seed',
      'prop_runs',
      'started_at',
      'finished_at',
    ]);
  },
  CLI_TIMEOUT,
);

it(
  '[CT-06zzc] PROP_RUNS from the caller reaches every mode and result.json records it as a number',
  () => {
    expectPropRunsInEveryMode('V5-02', 'runs-caller', { PROP_RUNS: '7' }, 7);
  },
  CLI_TIMEOUT,
);
