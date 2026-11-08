// The whole-machine verify slot of verify-container.sh (CT-06zzzx, FU-COLIMA-VERIFY-SLOT, D10-950):
// the two modes that run verify:fast inside the container (--fast and the default `pnpm verify`)
// take one slot for the whole machine before the first docker call, so at most one of them runs
// at a time; --red, --browser and --dry-run never take it. A stub `docker` first on PATH records
// every call together with what the slot directory held at the moment the verify container ran,
// as in verify-container.services.test.ts; no real container starts.
//
// What these tests fix for the implementation:
//   - slot directory: COULI_VERIFY_SLOT_DIR, default $RUNS/verify-slot (created when missing);
//   - the lock: the directory <slot dir>/slot.lock, created with mkdir (atomic), holding the file
//     `owner` with one key=value per line: pid (the pid of verify-container.sh), task, mode
//     (verify:fast or verify), started_at (UTC, 2026-11-08T00:00:00Z), token (unique per run,
//     16 or more letters and digits);
//   - a holder whose pid is alive (any live process) is never moved; a holder whose pid is dead
//     is stale and may be taken over only through the gate <slot dir>/slot.lock.takeover (mkdir,
//     exclusive), after checking that the token is still the stale one;
//   - waiting: at most COULI_VERIFY_SLOT_WAIT_SECS seconds (default 1800, a positive integer);
//     while waiting, stderr says `waiting for the verify slot` with the holder's task and pid and
//     the seconds waited, at the start and again every COULI_VERIFY_SLOT_REPORT_SECS seconds
//     (a positive integer); past the limit exit 2 with `verify slot`, the holder's task and pid,
//     no docker call and no result.json;
//   - taking over a stale slot says `stale verify slot` and the old holder's task on stderr;
//   - the run removes the lock only when its token is still its own, however it ends (success,
//     failure, signal); exit codes and result.json do not change.
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
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
const PREFIX = 'couli-slottest';
const LOCK = 'slot.lock';
const GATE = 'slot.lock.takeover';
const WAITING = 'waiting for the verify slot';
/** The fields of result.json for --fast and pnpm verify, unchanged by the slot. */
const RESULT_KEYS = [
  'mode',
  'script',
  'exit_code',
  'commit',
  'tree',
  'prop_seed',
  'prop_runs',
  'started_at',
  'finished_at',
];

// Stand-in for the docker CLI. Every call is appended to STUB_DOCKER_LOG as { args, at, end, slot }:
// for the verify container (`couli-verify-entrypoint`) `slot` is what STUB_SLOT_DIR held when it
// started (its entries and the text of slot.lock/owner) and `at` / `end` are its start and end in
// ms. STUB_DOCKER_STARTED=<file> is written when the verify container starts;
// STUB_DOCKER_REPLACE_LOCK=<text> replaces the lock with one whose owner file is that text (another
// holder took it over); STUB_DOCKER_SLEEP=<s> makes the container run that long;
// STUB_DOCKER_RUN_EXIT is its exit code. Everything else answers like a healthy daemon.
const STUB = String.raw`'use strict';
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const slotDir = process.env.STUB_SLOT_DIR || '';
const entry = args.includes('couli-verify-entrypoint');
const call = { args, at: Date.now(), end: null, slot: null };
function slot() {
  if (slotDir === '' || !fs.existsSync(slotDir)) return { entries: [], owner: null };
  let owner = null;
  try {
    owner = fs.readFileSync(path.join(slotDir, 'slot.lock', 'owner'), 'utf8');
  } catch {
    owner = null;
  }
  return { entries: fs.readdirSync(slotDir).sort(), owner };
}
if (entry) {
  call.slot = slot();
  if (process.env.STUB_DOCKER_STARTED) fs.writeFileSync(process.env.STUB_DOCKER_STARTED, 'started\n');
  if (process.env.STUB_DOCKER_REPLACE_LOCK) {
    const lock = path.join(slotDir, 'slot.lock');
    fs.rmSync(lock, { recursive: true, force: true });
    fs.mkdirSync(lock, { recursive: true });
    fs.writeFileSync(path.join(lock, 'owner'), process.env.STUB_DOCKER_REPLACE_LOCK);
  }
  const secs = Number(process.env.STUB_DOCKER_SLEEP || '0');
  if (secs > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, secs * 1000);
  call.end = Date.now();
}
fs.appendFileSync(process.env.STUB_DOCKER_LOG, JSON.stringify(call) + '\n');
function answer(text, code) {
  if (text !== '') fs.writeSync(1, text + '\n');
  process.exit(code);
}
if (args[0] === 'version') answer('28.0.1', 0);
if (args[0] === 'run' && args.includes('-d')) answer('0123456789ab', 0);
if (args[0] === 'exec' && args.includes('redis-cli')) answer('PONG', 0);
if (args[0] === 'inspect') answer('true', 0);
if (entry) answer('', Number(process.env.STUB_DOCKER_RUN_EXIT || '0'));
answer('', 0);
`;

type Slot = { entries: string[]; owner: string | null };
type Call = { args: string[]; at: number; end: number | null; slot: Slot | null };
type Run = {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  calls: Call[];
  elapsed: number;
  pid: number;
};

let base = '';
let runs = '';
let bin = '';
let counter = 0;

beforeAll(() => {
  base = scratchDir('verify-slot');
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

/** A pnpm lockfile with one playwright version (what --browser needs). */
function lockWithPlaywright(version: string): string {
  return [
    "lockfileVersion: '9.0'",
    '',
    'packages:',
    '',
    `  playwright@${version}:`,
    '    resolution: {integrity: sha512-playwright}',
    '',
    'snapshots:',
    '',
    `  playwright@${version}: {}`,
    '',
  ].join('\n');
}

/** A workspace the container path accepts (pinned pnpm, lockfile, workspace file). */
function workspace(name: string, lock = PLAIN_LOCK): string {
  const root = JSON.parse(readFileSync(join(repoRoot(), 'package.json'), 'utf8')) as {
    packageManager: string;
  };
  const dir = join(base, 'ws', name);
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

/** A fresh slot directory for one test (not created: the script creates it when missing). */
function slotDir(name: string): string {
  return join(base, 'slots', name);
}

/** The owner file text of a lock, in the format the tests fix (see the header). */
function ownerText(fields: { pid: number; task: string; token: string; mode?: string }): string {
  return [
    `pid=${String(fields.pid)}`,
    `task=${fields.task}`,
    `mode=${fields.mode ?? 'verify:fast'}`,
    'started_at=2026-11-08T00:00:00Z',
    `token=${fields.token}`,
    '',
  ].join('\n');
}

/** Puts a lock (and its owner file) into the slot directory, as another holder would. */
function placeLock(dir: string, text: string, name = LOCK): void {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, 'owner'), text);
}

function readOwner(dir: string, name = LOCK): string | null {
  const file = join(dir, name, 'owner');
  return existsSync(file) ? readFileSync(file, 'utf8') : null;
}

function parseOwner(text: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of (text ?? '').split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

/** What is left in a slot directory (nothing when it does not exist). */
function leftIn(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

/** A pid that certainly belonged to a process that has exited (the stale holder). */
function deadPid(): number {
  const res = spawnSync('true');
  expect(res.pid).toBeGreaterThan(0);
  return res.pid;
}

const pause = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/** Waits until `check` holds (true) or `ms` passed (false). */
async function until(check: () => boolean, ms: number): Promise<boolean> {
  const stop = Date.now() + ms;
  while (Date.now() < stop) {
    if (check()) return true;
    await pause(25);
  }
  return check();
}

function readCalls(log: string): Call[] {
  return existsSync(log)
    ? readFileSync(log, 'utf8')
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as Call)
    : [];
}

type Started = {
  pid: number;
  log: string;
  done: Promise<Run>;
  kill: (sig: NodeJS.Signals) => void;
};

/**
 * Starts the script with the stub docker. `slot` is the slot directory handed to the run
 * (COULI_VERIFY_SLOT_DIR) and to the stub; null leaves COULI_VERIFY_SLOT_DIR unset (the default
 * $COULI_RUNS/verify-slot is then what the stub looks at).
 */
function start(args: string[], slot: string | null, env: Record<string, string> = {}): Started {
  counter += 1;
  const log = join(base, `calls-${String(counter)}.jsonl`);
  const began = Date.now();
  const child = spawn('bash', [SCRIPT, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PATH: `${bin}:${process.env['PATH'] ?? ''}`,
      COULI_RUNS: runs,
      COULI_TRUSTED_ROOT: repoRoot(),
      COULI_VERIFY_PREFIX: PREFIX,
      // The caller's settings never change what a test sees (as in the services tests).
      PROP_RUNS: undefined,
      PROP_SEED: undefined,
      COULI_VERIFY_TIMEOUT_SECS: undefined,
      COULI_VERIFY_HOST_SERVICES: undefined,
      COULI_VERIFY_SLOT_DIR: slot ?? undefined,
      COULI_VERIFY_SLOT_WAIT_SECS: undefined,
      COULI_VERIFY_SLOT_REPORT_SECS: undefined,
      STUB_DOCKER_LOG: log,
      STUB_SLOT_DIR: slot ?? join(runs, 'verify-slot'),
      ...env,
    },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const done = new Promise<Run>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (status, signal) => {
      resolve({
        status,
        signal,
        stdout,
        stderr,
        calls: readCalls(log),
        elapsed: Date.now() - began,
        pid: child.pid ?? -1,
      });
    });
  });
  return {
    pid: child.pid ?? -1,
    log,
    done,
    kill: (sig) => {
      child.kill(sig);
    },
  };
}

function run(args: string[], slot: string | null, env: Record<string, string> = {}): Promise<Run> {
  return start(args, slot, env).done;
}

function entrypointCall(calls: readonly Call[]): Call | undefined {
  return calls.find((c) => c.args.includes('couli-verify-entrypoint'));
}

/** The lock the verify container saw is this run's own: pid, task, mode, start, token. */
function expectOwnLock(call: Call | undefined, pid: number, task: string, mode: string): string {
  expect(call?.slot?.entries).toContain(LOCK);
  expect(call?.slot?.entries).not.toContain(GATE);
  const owner = parseOwner(call?.slot?.owner);
  expect(owner['pid']).toBe(String(pid));
  expect(owner['task']).toBe(task);
  expect(owner['mode']).toBe(mode);
  expect(owner['started_at']).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  expect(owner['token']).toMatch(/^[0-9A-Za-z]{16,}$/);
  return owner['token'] ?? '';
}

function resultOf(task: string, kind: string, n = 1): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(runs, task, kind, String(n), 'result.json'), 'utf8'),
  ) as Record<string, unknown>;
}

/** No result.json anywhere under the task's run directory. */
function noResult(task: string): boolean {
  const dir = join(runs, task);
  if (!existsSync(dir)) return true;
  const found = (readdirSync(dir, { recursive: true }) as string[]).filter((p) =>
    p.endsWith('result.json'),
  );
  return found.length === 0;
}

it(
  '[CT-06zzzx] --fast holds the slot while its container runs and removes it afterwards; exit code and result.json as before',
  async () => {
    const slot = slotDir('fast');
    const res = await run(['V5-01', '--worktree', workspace('fast'), '--fast'], slot);
    expect(res.status, res.stderr).toBe(0);
    // While the verify container ran, the slot was this run's: its pid, task, mode, start, token.
    expectOwnLock(entrypointCall(res.calls), res.pid, 'V5-01', 'verify:fast');
    // Afterwards nothing is left: no lock, no gate.
    expect(leftIn(slot)).toEqual([]);
    const result = resultOf('V5-01', 'verify-fast');
    expect(Object.keys(result)).toEqual(RESULT_KEYS);
    expect(result).toMatchObject({ mode: 'container', script: 'verify:fast', exit_code: 0 });
    expect(res.stdout).toContain('"exit_code": 0');
  },
  CLI_TIMEOUT,
);

it(
  '[CT-06zzzx] without COULI_VERIFY_SLOT_DIR the slot is <COULI_RUNS>/verify-slot',
  async () => {
    const res = await run(['V5-02', '--worktree', workspace('default-dir'), '--fast'], null);
    expect(res.status, res.stderr).toBe(0);
    expectOwnLock(entrypointCall(res.calls), res.pid, 'V5-02', 'verify:fast');
    expect(leftIn(join(runs, 'verify-slot'))).toEqual([]);
  },
  CLI_TIMEOUT,
);

it(
  '[CT-06zzzx] the default pnpm verify takes the slot too (mode verify) and releases it',
  async () => {
    const slot = slotDir('verify');
    const res = await run(['V5-03', '--worktree', workspace('verify')], slot);
    expect(res.status, res.stderr).toBe(0);
    const verify = entrypointCall(res.calls);
    expect(verify?.args.slice(-2)).toEqual(['couli-verify-entrypoint', 'verify']);
    expectOwnLock(verify, res.pid, 'V5-03', 'verify');
    expect(leftIn(slot)).toEqual([]);
    const result = resultOf('V5-03', 'verify');
    expect(Object.keys(result)).toEqual(RESULT_KEYS);
    expect(result).toMatchObject({ mode: 'container', script: 'verify', exit_code: 0 });
  },
  CLI_TIMEOUT,
);

it(
  '[CT-06zzzx] --dry-run does not wait for a held slot and leaves it alone',
  async () => {
    const slot = slotDir('dry-run');
    const holder = ownerText({ pid: process.pid, task: 'X9-01', token: 'x9-01:holder:dry-run' });
    placeLock(slot, holder);
    const ws = workspace('dry-run');
    for (const extra of [['--fast'], []]) {
      const res = await run(['V5-04', '--worktree', ws, ...extra, '--dry-run'], slot, {
        COULI_VERIFY_SLOT_WAIT_SECS: '3',
        COULI_VERIFY_SLOT_REPORT_SECS: '1',
      });
      expect(res.status, res.stderr).toBe(0);
      expect(JSON.parse(res.stdout)).toMatchObject({
        script: extra.length === 0 ? 'verify' : 'verify:fast',
      });
      expect(res.stderr).not.toContain(WAITING);
      expect(res.elapsed).toBeLessThan(3000);
      expect(res.calls).toEqual([]);
    }
    expect(leftIn(slot)).toEqual([LOCK]);
    expect(readOwner(slot)).toBe(holder);
  },
  CLI_TIMEOUT,
);

it(
  '[CT-06zzzx] --red runs while the slot is held, without waiting and without touching the lock',
  async () => {
    const slot = slotDir('red');
    const holder = ownerText({ pid: process.pid, task: 'X9-02', token: 'x9-02:holder:red' });
    placeLock(slot, holder);
    // B1-02b: legacy ledger entry without test_paths (see verify-container.test.ts, CR3-01).
    const repo = workspace('red');
    fixtureGit(repo, ['init', '-q', '-b', 'main']);
    fixtureGit(repo, ['add', '-A']);
    fixtureGit(repo, ['commit', '-q', '-m', 'fixture']);
    writeFiles(repo, {
      'test/spec/identity/devices.test.ts': "it('[BR-ID-05] x', () => {});\n",
    });
    const res = await run(['B1-02b', '--worktree', repo, '--red', '--base', 'main'], slot, {
      COULI_VERIFY_SLOT_WAIT_SECS: '3',
      COULI_VERIFY_SLOT_REPORT_SECS: '1',
    });
    // The red container ran (the stub writes no report, so the run then stops: that is the
    // red path as before and not what this test is about).
    const red = entrypointCall(res.calls);
    expect(red?.args.slice(-2), res.stderr).toEqual(['couli-verify-entrypoint', 'red']);
    expect(red?.slot?.owner).toBe(holder);
    expect(res.stderr).not.toContain(WAITING);
    expect(leftIn(slot)).toEqual([LOCK]);
    expect(readOwner(slot)).toBe(holder);
  },
  CLI_TIMEOUT,
);

it(
  '[CT-06zzzx] --browser runs while the slot is held, without waiting and without touching the lock',
  async () => {
    const slot = slotDir('browser');
    const holder = ownerText({ pid: process.pid, task: 'X9-03', token: 'x9-03:holder:browser' });
    placeLock(slot, holder);
    const res = await run(
      ['V5-05', '--worktree', workspace('browser', lockWithPlaywright('1.56.1')), '--browser'],
      slot,
      { COULI_VERIFY_SLOT_WAIT_SECS: '3', COULI_VERIFY_SLOT_REPORT_SECS: '1' },
    );
    const browser = entrypointCall(res.calls);
    expect(browser?.args.slice(-2), res.stderr).toEqual(['couli-verify-entrypoint', 'browser']);
    expect(browser?.slot?.owner).toBe(holder);
    // As before: a green browser run that exported no screenshot counts as failed (exit 1).
    expect(res.status, res.stderr).toBe(1);
    expect(resultOf('V5-05', 'browser')).toMatchObject({ script: 'browser', exit_code: 1 });
    expect(res.stderr).not.toContain(WAITING);
    expect(leftIn(slot)).toEqual([LOCK]);
    expect(readOwner(slot)).toBe(holder);
  },
  CLI_TIMEOUT,
);

it(
  '[CT-06zzzx] a live holder: --fast waits, reports the holder and the time waited, and runs once the slot is free',
  async () => {
    const slot = slotDir('live');
    const holder = ownerText({ pid: process.pid, task: 'X9-04', token: 'x9-04:holder:live' });
    placeLock(slot, holder);
    const started = start(['V5-06', '--worktree', workspace('live'), '--fast'], slot, {
      COULI_VERIFY_SLOT_WAIT_SECS: '30',
      COULI_VERIFY_SLOT_REPORT_SECS: '1',
    });
    await pause(2500);
    // While the holder holds the slot nothing runs: no docker call at all, the lock is the holder's.
    expect(readCalls(started.log)).toEqual([]);
    expect(readOwner(slot)).toBe(holder);
    // The holder releases the slot.
    removeDir(join(slot, LOCK));
    const res = await started.done;
    expect(res.status, res.stderr).toBe(0);
    const waits = res.stderr.split('\n').filter((line) => line.includes(WAITING));
    // Reported at the start of the wait and again while waiting: the holder and the time waited.
    expect(waits.length, res.stderr).toBeGreaterThanOrEqual(2);
    for (const line of waits) {
      expect(line).toContain('X9-04');
      expect(line).toContain(String(process.pid));
      expect(line).toMatch(/\d+ ?s\b/);
    }
    // It then ran with the slot as its own, and released it.
    expectOwnLock(entrypointCall(res.calls), res.pid, 'V5-06', 'verify:fast');
    expect(leftIn(slot)).toEqual([]);
    expect(resultOf('V5-06', 'verify-fast')).toMatchObject({ script: 'verify:fast', exit_code: 0 });
  },
  CLI_TIMEOUT,
);

it(
  '[CT-06zzzx] two --fast runs started together never run their containers at the same time',
  async () => {
    const slot = slotDir('pair');
    const env = {
      STUB_DOCKER_SLEEP: '1',
      COULI_VERIFY_SLOT_WAIT_SECS: '30',
      COULI_VERIFY_SLOT_REPORT_SECS: '1',
    };
    const a = start(['V5-07', '--worktree', workspace('pair-a'), '--fast'], slot, env);
    const b = start(['V5-08', '--worktree', workspace('pair-b'), '--fast'], slot, env);
    const [ra, rb] = await Promise.all([a.done, b.done]);
    expect(ra.status, ra.stderr).toBe(0);
    expect(rb.status, rb.stderr).toBe(0);
    const ca = entrypointCall(ra.calls);
    const cb = entrypointCall(rb.calls);
    const tokenA = expectOwnLock(ca, ra.pid, 'V5-07', 'verify:fast');
    const tokenB = expectOwnLock(cb, rb.pid, 'V5-08', 'verify:fast');
    expect(tokenA).not.toBe(tokenB);
    const [first, second, firstTask, secondRun] =
      (ca?.at ?? 0) <= (cb?.at ?? 0) ? [ca, cb, 'V5-07', rb] : [cb, ca, 'V5-08', ra];
    // The second container started only after the first had ended.
    expect(second?.at ?? 0).toBeGreaterThanOrEqual(first?.end ?? Number.POSITIVE_INFINITY);
    // The one that waited said whom it waited for.
    expect(secondRun.stderr).toContain(WAITING);
    expect(secondRun.stderr).toContain(firstTask);
    expect(leftIn(slot)).toEqual([]);
  },
  CLI_TIMEOUT,
);

it(
  '[CT-06zzzx] waiting is bounded: past COULI_VERIFY_SLOT_WAIT_SECS exit 2 naming the holder, no docker call, the lock untouched',
  async () => {
    const slot = slotDir('timeout');
    const holder = ownerText({ pid: process.pid, task: 'X9-05', token: 'x9-05:holder:timeout' });
    placeLock(slot, holder);
    const res = await run(['V5-09', '--worktree', workspace('timeout'), '--fast'], slot, {
      COULI_VERIFY_SLOT_WAIT_SECS: '2',
      COULI_VERIFY_SLOT_REPORT_SECS: '1',
    });
    expect(res.status, res.stderr).toBe(2);
    // It did wait (not an immediate refusal), and stopped near the limit.
    expect(res.elapsed).toBeGreaterThanOrEqual(1000);
    expect(res.elapsed).toBeLessThan(20_000);
    // Not silent: the last word on stderr names the slot and its holder.
    const last = res.stderr.trim().split('\n').at(-1) ?? '';
    expect(last, res.stderr).toContain('verify slot');
    expect(last).toContain('X9-05');
    expect(last).toContain(String(process.pid));
    // The stub docker was never called; no result; the holder's lock is as it was.
    expect(res.calls).toEqual([]);
    expect(noResult('V5-09')).toBe(true);
    expect(leftIn(slot)).toEqual([LOCK]);
    expect(readOwner(slot)).toBe(holder);
  },
  CLI_TIMEOUT,
);

it(
  '[CT-06zzzx] COULI_VERIFY_SLOT_WAIT_SECS defaults to 1800; it and COULI_VERIFY_SLOT_REPORT_SECS must be positive integers',
  async () => {
    const ws = workspace('settings');
    for (const name of ['COULI_VERIFY_SLOT_WAIT_SECS', 'COULI_VERIFY_SLOT_REPORT_SECS']) {
      for (const value of ['x', '-1', '1.5', '0']) {
        const res = await run(['V5-10', '--worktree', ws, '--fast'], slotDir('settings'), {
          [name]: value,
        });
        expect(res.status, `${name}=${value}`).toBe(2);
        expect(res.stderr, `${name}=${value}`).toContain(`${name} must be a positive integer`);
        expect(res.calls, `${name}=${value}`).toEqual([]);
      }
    }
    expect(noResult('V5-10')).toBe(true);
    // The default wait is 30 minutes (FU-COLIMA-VERIFY-SLOT).
    const text = readFileSync(SCRIPT, 'utf8');
    expect(text).toContain('COULI_VERIFY_SLOT_WAIT_SECS');
    expect(text).toMatch(/SLOT_WAIT_SECS[^\n]*1800/);
  },
  CLI_TIMEOUT,
);

it(
  '[CT-06zzzx] a stale slot (holder pid dead) is taken over through the gate: --fast runs and leaves nothing behind',
  async () => {
    const slot = slotDir('stale');
    const dead = deadPid();
    placeLock(slot, ownerText({ pid: dead, task: 'X9-06', token: 'x9-06:stale:holder' }));
    const res = await run(['V5-11', '--worktree', workspace('stale'), '--fast'], slot, {
      COULI_VERIFY_SLOT_WAIT_SECS: '10',
      COULI_VERIFY_SLOT_REPORT_SECS: '1',
    });
    expect(res.status, res.stderr).toBe(0);
    // Said so, with the old holder.
    expect(res.stderr).toContain('stale verify slot');
    expect(res.stderr).toContain('X9-06');
    // The container ran with the slot as this run's own (the gate already gone).
    expectOwnLock(entrypointCall(res.calls), res.pid, 'V5-11', 'verify:fast');
    expect(leftIn(slot)).toEqual([]);
    expect(resultOf('V5-11', 'verify-fast')).toMatchObject({ script: 'verify:fast', exit_code: 0 });
  },
  CLI_TIMEOUT,
);

it(
  '[CT-06zzzx] a stale slot whose takeover gate is held is not removed: --fast waits to the limit (exit 2)',
  async () => {
    const slot = slotDir('stale-gate');
    const stale = ownerText({ pid: deadPid(), task: 'X9-07', token: 'x9-07:stale:gated' });
    placeLock(slot, stale);
    // Someone else (alive) is in the middle of taking it over.
    const gate = ownerText({ pid: process.pid, task: 'X9-08', token: 'x9-08:gate:holder' });
    placeLock(slot, gate, GATE);
    const res = await run(['V5-12', '--worktree', workspace('stale-gate'), '--fast'], slot, {
      COULI_VERIFY_SLOT_WAIT_SECS: '2',
      COULI_VERIFY_SLOT_REPORT_SECS: '1',
    });
    expect(res.status, res.stderr).toBe(2);
    const last = res.stderr.trim().split('\n').at(-1) ?? '';
    expect(last, res.stderr).toContain('verify slot');
    expect(last).toContain('X9-07');
    expect(res.calls).toEqual([]);
    expect(noResult('V5-12')).toBe(true);
    // Neither the stale lock nor the gate was removed by this run.
    expect(leftIn(slot)).toEqual([LOCK, GATE]);
    expect(readOwner(slot)).toBe(stale);
    expect(readOwner(slot, GATE)).toBe(gate);
  },
  CLI_TIMEOUT,
);

it(
  '[CT-06zzzx] release checks the token: a lock replaced during the run is left to its new holder',
  async () => {
    const slot = slotDir('replaced');
    const other = ownerText({ pid: process.pid, task: 'X9-09', token: 'x9-09:other:holder' });
    const res = await run(['V5-13', '--worktree', workspace('replaced'), '--fast'], slot, {
      STUB_DOCKER_REPLACE_LOCK: other,
    });
    expect(res.status, res.stderr).toBe(0);
    // The run had the slot when its container started.
    expectOwnLock(entrypointCall(res.calls), res.pid, 'V5-13', 'verify:fast');
    // The lock now belongs to someone else: this run did not remove it.
    expect(leftIn(slot)).toEqual([LOCK]);
    expect(readOwner(slot)).toBe(other);
    expect(resultOf('V5-13', 'verify-fast')).toMatchObject({ script: 'verify:fast', exit_code: 0 });
  },
  CLI_TIMEOUT,
);

it(
  '[CT-06zzzx] a TERM during the run releases the slot; the exit code is the interrupt code as before (143)',
  async () => {
    const slot = slotDir('term');
    const marker = join(base, 'term-started');
    const started = start(['V5-14', '--worktree', workspace('term'), '--fast'], slot, {
      STUB_DOCKER_SLEEP: '1',
      STUB_DOCKER_STARTED: marker,
    });
    expect(await until(() => existsSync(marker), 15_000)).toBe(true);
    // The slot is held by this run while its container runs.
    expect(parseOwner(readOwner(slot))['pid']).toBe(String(started.pid));
    started.kill('SIGTERM');
    const res = await started.done;
    expect(res.status, res.stderr).toBe(143);
    expect(noResult('V5-14')).toBe(true);
    expect(leftIn(slot)).toEqual([]);
  },
  CLI_TIMEOUT,
);

it(
  '[CT-06zzzx] a failing run keeps its exit code and result.json and still releases the slot',
  async () => {
    for (const [task, extra, kind, script, code] of [
      ['V5-15', ['--fast'], 'verify-fast', 'verify:fast', 3],
      ['V5-16', [], 'verify', 'verify', 5],
    ] as const) {
      const slot = slotDir(`fail-${task}`);
      const res = await run([task, '--worktree', workspace(`fail-${task}`), ...extra], slot, {
        STUB_DOCKER_RUN_EXIT: String(code),
      });
      expect(res.status, res.stderr).toBe(code);
      expectOwnLock(entrypointCall(res.calls), res.pid, task, script);
      const result = resultOf(task, kind);
      expect(Object.keys(result)).toEqual(RESULT_KEYS);
      expect(result).toMatchObject({ mode: 'container', script, exit_code: code });
      expect(leftIn(slot)).toEqual([]);
    }
  },
  CLI_TIMEOUT,
);
