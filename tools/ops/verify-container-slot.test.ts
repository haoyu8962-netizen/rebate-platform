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
  utimesSync,
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
// CT-06zzzzb: `docker ps` (or `docker container ls`) prints STUB_DOCKER_PS_ID (one container id)
// only when one of its arguments is the filter label=couli.slot-token=<STUB_DOCKER_PS_TOKEN>
// (as `label=...` after --filter, or `--filter=label=...`), and only while the file
// STUB_DOCKER_PS_WHILE exists when that is set; otherwise it prints nothing (no such container).
// STUB_DOCKER_PS_EXIT=<code> makes every docker ps fail with that code.
// STUB_DOCKER_PS_HANG=<s> makes every docker ps hang that long first (a stuck daemon); with
// STUB_DOCKER_PS_PIDS=<dir> each such ps writes its pid as a file name there before it hangs.
// CT-06zzzzy: with STUB_DOCKER_REPLACE_LOCK_ON=<first argument> (e.g. `version`) the lock is
// replaced by STUB_DOCKER_REPLACE_LOCK in every docker call whose first argument is that, and no
// longer in the verify container; unset, STUB_DOCKER_REPLACE_LOCK acts in the verify container as
// before.
const STUB = String.raw`'use strict';
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const slotDir = process.env.STUB_SLOT_DIR || '';
const entry = args.includes('couli-verify-entrypoint');
const replaceOn = process.env.STUB_DOCKER_REPLACE_LOCK_ON || '';
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
function replaceLock() {
  const lock = path.join(slotDir, 'slot.lock');
  fs.rmSync(lock, { recursive: true, force: true });
  fs.mkdirSync(lock, { recursive: true });
  fs.writeFileSync(path.join(lock, 'owner'), process.env.STUB_DOCKER_REPLACE_LOCK);
}
if (process.env.STUB_DOCKER_REPLACE_LOCK && replaceOn !== '' && args[0] === replaceOn) replaceLock();
if (entry) {
  call.slot = slot();
  if (process.env.STUB_DOCKER_STARTED) fs.writeFileSync(process.env.STUB_DOCKER_STARTED, 'started\n');
  if (process.env.STUB_DOCKER_REPLACE_LOCK && replaceOn === '') replaceLock();
  const secs = Number(process.env.STUB_DOCKER_SLEEP || '0');
  if (secs > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, secs * 1000);
  call.end = Date.now();
}
fs.appendFileSync(process.env.STUB_DOCKER_LOG, JSON.stringify(call) + '\n');
function answer(text, code) {
  if (text !== '') fs.writeSync(1, text + '\n');
  process.exit(code);
}
const isPs =
  args[0] === 'ps' || (args[0] === 'container' && ['ls', 'ps', 'list'].includes(args[1]));
if (isPs) {
  const hang = Number(process.env.STUB_DOCKER_PS_HANG || '0');
  if (hang > 0) {
    if (process.env.STUB_DOCKER_PS_PIDS) {
      fs.writeFileSync(path.join(process.env.STUB_DOCKER_PS_PIDS, String(process.pid)), '');
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, hang * 1000);
  }
  if (process.env.STUB_DOCKER_PS_EXIT) {
    fs.writeSync(2, 'Cannot connect to the Docker daemon (stub)\n');
    process.exit(Number(process.env.STUB_DOCKER_PS_EXIT));
  }
  const tok = process.env.STUB_DOCKER_PS_TOKEN || '';
  const want = 'label=couli.slot-token=' + tok;
  const asked = tok !== '' && args.some((a) => a === want || a.endsWith('=' + want));
  const gone = process.env.STUB_DOCKER_PS_WHILE && !fs.existsSync(process.env.STUB_DOCKER_PS_WHILE);
  answer(asked && !gone ? process.env.STUB_DOCKER_PS_ID || '0123456789cd' : '', 0);
}
if (args[0] === 'version') answer('28.0.1', 0);
if (args[0] === 'run' && args.includes('-d')) answer('0123456789ab', 0);
if (args[0] === 'exec' && args.includes('redis-cli')) answer('PONG', 0);
if (args[0] === 'inspect') answer('true', 0);
if (entry) answer('', Number(process.env.STUB_DOCKER_RUN_EXIT || '0'));
answer('', 0);
`;

// Stand-in for ln (CT-06zzzzy), first on PATH like the stub docker. With STUB_LN_STEAL=<text> set
// and the file STUB_LN_ONCE present, an ln whose target (its last argument) ends in
// /slot.lock/owner removes STUB_LN_ONCE (so it acts once) and first writes that text to the target:
// another holder's owner file appeared before this run's. Then, and in every other case, the real
// /bin/ln runs with the same arguments.
const LN_STUB = [
  '#!/bin/sh',
  'if [ -n "${STUB_LN_STEAL:-}" ] && [ -n "${STUB_LN_ONCE:-}" ] && [ -f "$STUB_LN_ONCE" ]; then',
  '  last=',
  '  for a in "$@"; do last="$a"; done',
  '  case "$last" in',
  '    */slot.lock/owner)',
  '      rm -f "$STUB_LN_ONCE"',
  '      printf \'%s\' "$STUB_LN_STEAL" >"$last"',
  '      ;;',
  '  esac',
  'fi',
  'exec /bin/ln "$@"',
  '',
].join('\n');

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
  const ln = join(bin, 'ln');
  writeFileSync(ln, LN_STUB);
  chmodSync(ln, 0o755);
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
      COULI_VERIFY_SLOT_ORPHAN_SECS: undefined,
      STUB_DOCKER_PS_TOKEN: undefined,
      STUB_DOCKER_PS_ID: undefined,
      STUB_DOCKER_PS_WHILE: undefined,
      STUB_DOCKER_PS_EXIT: undefined,
      COULI_VERIFY_SLOT_PS_TIMEOUT_SECS: undefined,
      STUB_DOCKER_PS_HANG: undefined,
      STUB_DOCKER_PS_PIDS: undefined,
      STUB_DOCKER_REPLACE_LOCK: undefined,
      STUB_DOCKER_REPLACE_LOCK_ON: undefined,
      STUB_LN_STEAL: undefined,
      STUB_LN_ONCE: undefined,
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

/**
 * The lock the verify container saw is this run's own: pid, task, mode, start, token. `context`
 * (optional, CT-06zzzzy) is added to the message of every assertion that fails.
 */
function expectOwnLock(
  call: Call | undefined,
  pid: number,
  task: string,
  mode: string,
  context?: string,
): string {
  expect(call?.slot?.entries, context).toContain(LOCK);
  expect(call?.slot?.entries, context).not.toContain(GATE);
  const owner = parseOwner(call?.slot?.owner);
  expect(owner['pid'], context).toBe(String(pid));
  expect(owner['task'], context).toBe(task);
  expect(owner['mode'], context).toBe(mode);
  expect(owner['started_at'], context).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  expect(owner['token'], context).toMatch(/^[0-9A-Za-z]{16,}$/);
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
    // FU-FLAKE-CT06ZZZX-SLOT-WAIT: the holder may release the slot between a failed mkdir and the
    // owner read; that one iteration then reports "an unknown holder", and only as the last waiting
    // line (the next iteration takes the slot). Every other report names the holder.
    const unknown = waits.filter((line) => line.includes('an unknown holder'));
    const named = waits.filter((line) => !line.includes('an unknown holder'));
    expect(unknown.length, res.stderr).toBeLessThanOrEqual(1);
    if (unknown.length === 1) expect(waits.at(-1), res.stderr).toBe(unknown[0]);
    // Reported at the start of the wait and again while waiting: the holder and the time waited.
    expect(named.length, res.stderr).toBeGreaterThanOrEqual(2);
    for (const line of named) {
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
    // CT-06zzzzy: what both runs said and when their containers ran, in every failure message
    // below (the CI failure of D10-1365 could not be told apart without it).
    const context = [
      `A V5-07 (pid ${String(ra.pid)}, exit ${String(ra.status)}, ${String(ra.elapsed)} ms): container ${String(ca?.at)}..${String(ca?.end)}, slot ${JSON.stringify(ca?.slot)}`,
      `B V5-08 (pid ${String(rb.pid)}, exit ${String(rb.status)}, ${String(rb.elapsed)} ms): container ${String(cb?.at)}..${String(cb?.end)}, slot ${JSON.stringify(cb?.slot)}`,
      `--- A stderr ---\n${ra.stderr}`,
      `--- B stderr ---\n${rb.stderr}`,
    ].join('\n');
    const tokenA = expectOwnLock(ca, ra.pid, 'V5-07', 'verify:fast', context);
    const tokenB = expectOwnLock(cb, rb.pid, 'V5-08', 'verify:fast', context);
    expect(tokenA, context).not.toBe(tokenB);
    const [first, second, firstTask, secondRun] =
      (ca?.at ?? 0) <= (cb?.at ?? 0) ? [ca, cb, 'V5-07', rb] : [cb, ca, 'V5-08', ra];
    // The second container started only after the first had ended.
    expect(second?.at ?? 0, context).toBeGreaterThanOrEqual(first?.end ?? Number.POSITIVE_INFINITY);
    // The one that waited said whom it waited for.
    expect(secondRun.stderr, context).toContain(WAITING);
    expect(secondRun.stderr, context).toContain(firstTask);
    expect(leftIn(slot), context).toEqual([]);
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

// CT-06zzzzb (FU-COLIMA-VERIFY-SLOT-REST; the two S2 of #2751). What these tests fix in addition:
//   - the verify container (the docker run of couli-verify-entrypoint) carries the label
//     couli.slot-token=<the token of this run's slot> as the two arguments `--label` and
//     `couli.slot-token=<token>`;
//   - before a lock whose holder pid is dead counts as stale, `docker ps` with the filter
//     label=couli.slot-token=<its token> is asked: a container listed there means the holder was
//     killed (SIGKILL, no trap) while its container still runs, so the lock is not stale and the
//     run keeps waiting (stderr says `still running` with the holder's task) until the container
//     is gone or the limit is reached; a docker ps that fails counts as "not stale" as well;
//   - a lock or a takeover gate without an owner file whose directory mtime is older than
//     COULI_VERIFY_SLOT_ORPHAN_SECS (default 30, a positive integer) is an orphan and is removed
//     (stderr says `orphan`); a younger one is left alone; an orphan lock is removed only through
//     the gate (a live gate holder keeps it);
//   - a takeover gate whose owner pid is dead is removed (stderr says `stale takeover gate` with
//     its task); one whose owner is alive is left alone (the CT-06zzzx test above).
const TOKEN_LABEL = 'couli.slot-token';

function isPs(args: readonly string[]): boolean {
  return (
    args[0] === 'ps' || (args[0] === 'container' && ['ls', 'ps', 'list'].includes(args[1] ?? ''))
  );
}

/** The docker ps calls that asked for the containers labelled with this slot token. */
function psCallsFor(calls: readonly Call[], token: string): Call[] {
  const want = `label=${TOKEN_LABEL}=${token}`;
  return calls.filter(
    (c) => isPs(c.args) && c.args.some((a) => a === want || a.endsWith(`=${want}`)),
  );
}

/** docker run calls (any container). */
function runCalls(calls: readonly Call[]): Call[] {
  return calls.filter((c) => c.args[0] === 'run');
}

/** Sets the mtime (and atime) of a path to `secs` seconds ago. */
function age(path: string, secs: number): void {
  const t = Date.now() / 1000 - secs;
  utimesSync(path, t, t);
}

/** A lock or gate directory without an owner file, its mtime `secs` seconds ago. */
function placeOrphan(dir: string, name: string, secs: number): void {
  mkdirSync(join(dir, name), { recursive: true });
  age(join(dir, name), secs);
}

/** The stderr lines that contain every one of `parts`. */
function linesWith(stderr: string, ...parts: string[]): string[] {
  return stderr.split('\n').filter((line) => parts.every((p) => line.includes(p)));
}

it(
  '[CT-06zzzzb] the verify container carries --label couli.slot-token=<the token in its slot owner> (--fast and pnpm verify)',
  async () => {
    for (const [task, extra, mode] of [
      ['V6-01', ['--fast'], 'verify:fast'],
      ['V6-02', [], 'verify'],
    ] as const) {
      const slot = slotDir(`label-${task}`);
      const res = await run([task, '--worktree', workspace(`label-${task}`), ...extra], slot);
      expect(res.status, res.stderr).toBe(0);
      const verify = entrypointCall(res.calls);
      const token = expectOwnLock(verify, res.pid, task, mode);
      const args = verify?.args ?? [];
      const labels = args.flatMap((a, i) => (a === '--label' ? [args[i + 1] ?? ''] : []));
      expect(labels, `${task}: ${args.join(' ')}`).toContain(`${TOKEN_LABEL}=${token}`);
      // One slot-token label, the run's own.
      expect(args.filter((a) => a.includes(`${TOKEN_LABEL}=`))).toEqual([
        `${TOKEN_LABEL}=${token}`,
      ]);
      expect(leftIn(slot)).toEqual([]);
    }
  },
  CLI_TIMEOUT,
);

it(
  '[CT-06zzzzb] holder pid dead but its container still running (docker ps by token lists it): not stale, --fast waits to the limit (exit 2), the lock untouched',
  async () => {
    const slot = slotDir('ps-running');
    const token = 'x9-10:killed';
    const stale = ownerText({ pid: deadPid(), task: 'X9-10', token });
    placeLock(slot, stale);
    const res = await run(['V6-03', '--worktree', workspace('ps-running'), '--fast'], slot, {
      COULI_VERIFY_SLOT_WAIT_SECS: '2',
      COULI_VERIFY_SLOT_REPORT_SECS: '1',
      STUB_DOCKER_PS_TOKEN: token,
      STUB_DOCKER_PS_ID: '0123456789cd',
    });
    expect(res.status, res.stderr).toBe(2);
    // It asked docker for the containers of that slot token.
    expect(psCallsFor(res.calls, token).length, JSON.stringify(res.calls)).toBeGreaterThanOrEqual(
      1,
    );
    // Said why it does not take the slot over: the old holder's container is still running.
    expect(
      linesWith(res.stderr, 'still running', 'X9-10').length,
      res.stderr,
    ).toBeGreaterThanOrEqual(1);
    expect(res.stderr).not.toContain('taking over');
    // The usual end of a bounded wait.
    const last = res.stderr.trim().split('\n').at(-1) ?? '';
    expect(last, res.stderr).toContain('verify slot');
    expect(last).toContain('X9-10');
    expect(entrypointCall(res.calls)).toBeUndefined();
    expect(runCalls(res.calls)).toEqual([]);
    expect(noResult('V6-03')).toBe(true);
    expect(leftIn(slot)).toEqual([LOCK]);
    expect(readOwner(slot)).toBe(stale);
  },
  CLI_TIMEOUT,
);

it(
  '[CT-06zzzzb] holder pid dead and no container with its token (docker ps lists none): the stale slot is taken over as before',
  async () => {
    const slot = slotDir('ps-gone');
    const token = 'x9-11:gone';
    placeLock(slot, ownerText({ pid: deadPid(), task: 'X9-11', token }));
    const res = await run(['V6-04', '--worktree', workspace('ps-gone'), '--fast'], slot, {
      COULI_VERIFY_SLOT_WAIT_SECS: '10',
      COULI_VERIFY_SLOT_REPORT_SECS: '1',
      // A container of some other slot token runs; none of this one.
      STUB_DOCKER_PS_TOKEN: 'x9-99:other',
      STUB_DOCKER_PS_ID: '0123456789ef',
    });
    expect(res.status, res.stderr).toBe(0);
    const asked = psCallsFor(res.calls, token);
    expect(asked.length, JSON.stringify(res.calls)).toBeGreaterThanOrEqual(1);
    const verify = entrypointCall(res.calls);
    // The check came before the takeover, i.e. before this run's container.
    expect(asked[0]?.at ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(verify?.at ?? 0);
    expect(res.stderr).toContain('stale verify slot');
    expect(res.stderr).toContain('X9-11');
    expect(res.stderr).not.toContain('still running');
    expectOwnLock(verify, res.pid, 'V6-04', 'verify:fast');
    expect(leftIn(slot)).toEqual([]);
    expect(resultOf('V6-04', 'verify-fast')).toMatchObject({ script: 'verify:fast', exit_code: 0 });
  },
  CLI_TIMEOUT,
);

it('[CT-06zzzzb] the killed holder container ends while --fast waits: the next check finds none and the slot is taken over', async () => {
  const slot = slotDir('ps-ends');
  const token = 'x9-12:ends';
  const stale = ownerText({ pid: deadPid(), task: 'X9-12', token });
  placeLock(slot, stale);
  const alive = join(base, 'ps-ends-alive');
  writeFileSync(alive, 'running\n');
  const started = start(['V6-05', '--worktree', workspace('ps-ends'), '--fast'], slot, {
    COULI_VERIFY_SLOT_WAIT_SECS: '20',
    COULI_VERIFY_SLOT_REPORT_SECS: '1',
    STUB_DOCKER_PS_TOKEN: token,
    STUB_DOCKER_PS_WHILE: alive,
  });
  await pause(2000);
  // While the old container runs: asked, not taken over, no container of this run.
  const before = readCalls(started.log);
  expect(psCallsFor(before, token).length, JSON.stringify(before)).toBeGreaterThanOrEqual(1);
  expect(entrypointCall(before)).toBeUndefined();
  expect(readOwner(slot)).toBe(stale);
  // The old container ends.
  removeDir(alive);
  const res = await started.done;
  expect(res.status, res.stderr).toBe(0);
  expect(linesWith(res.stderr, 'still running', 'X9-12').length, res.stderr).toBeGreaterThanOrEqual(
    1,
  );
  expect(res.stderr).toContain('stale verify slot');
  expectOwnLock(entrypointCall(res.calls), res.pid, 'V6-05', 'verify:fast');
  expect(leftIn(slot)).toEqual([]);
  expect(resultOf('V6-05', 'verify-fast')).toMatchObject({ script: 'verify:fast', exit_code: 0 });
}, 60_000);

it(
  '[CT-06zzzzb] docker ps itself fails: the dead holder counts as not stale, --fast waits to the limit (exit 2), the lock untouched',
  async () => {
    const slot = slotDir('ps-fails');
    const token = 'x9-13:psfail';
    const stale = ownerText({ pid: deadPid(), task: 'X9-13', token });
    placeLock(slot, stale);
    const res = await run(['V6-06', '--worktree', workspace('ps-fails'), '--fast'], slot, {
      COULI_VERIFY_SLOT_WAIT_SECS: '2',
      COULI_VERIFY_SLOT_REPORT_SECS: '1',
      STUB_DOCKER_PS_EXIT: '1',
    });
    expect(res.status, res.stderr).toBe(2);
    expect(psCallsFor(res.calls, token).length, JSON.stringify(res.calls)).toBeGreaterThanOrEqual(
      1,
    );
    expect(res.stderr).not.toContain('taking over');
    const last = res.stderr.trim().split('\n').at(-1) ?? '';
    expect(last, res.stderr).toContain('verify slot');
    expect(last).toContain('X9-13');
    expect(runCalls(res.calls)).toEqual([]);
    expect(noResult('V6-06')).toBe(true);
    expect(leftIn(slot)).toEqual([LOCK]);
    expect(readOwner(slot)).toBe(stale);
  },
  CLI_TIMEOUT,
);

it(
  '[CT-06zzzzb] a lock without an owner file: older than COULI_VERIFY_SLOT_ORPHAN_SECS it is an orphan and taken over (nothing left after); younger it is left alone, as is an old one while a live holder has the gate',
  async () => {
    // Old: taken over, the run runs, nothing is left.
    const oldSlot = slotDir('ownerless-old');
    placeOrphan(oldSlot, LOCK, 60);
    const taken = await run(
      ['V6-07', '--worktree', workspace('ownerless-old'), '--fast'],
      oldSlot,
      {
        COULI_VERIFY_SLOT_WAIT_SECS: '10',
        COULI_VERIFY_SLOT_REPORT_SECS: '1',
        COULI_VERIFY_SLOT_ORPHAN_SECS: '1',
      },
    );
    expect(taken.status, taken.stderr).toBe(0);
    expect(linesWith(taken.stderr, 'orphan').length, taken.stderr).toBeGreaterThanOrEqual(1);
    expectOwnLock(entrypointCall(taken.calls), taken.pid, 'V6-07', 'verify:fast');
    expect(leftIn(oldSlot)).toEqual([]);
    expect(resultOf('V6-07', 'verify-fast')).toMatchObject({ script: 'verify:fast', exit_code: 0 });

    // Young (it may be a lock whose owner file is being written): left alone, wait to the limit.
    const youngSlot = slotDir('ownerless-young');
    placeOrphan(youngSlot, LOCK, 0);
    const young = await run(
      ['V6-08', '--worktree', workspace('ownerless-young'), '--fast'],
      youngSlot,
      {
        COULI_VERIFY_SLOT_WAIT_SECS: '2',
        COULI_VERIFY_SLOT_REPORT_SECS: '1',
        COULI_VERIFY_SLOT_ORPHAN_SECS: '30',
      },
    );
    expect(young.status, young.stderr).toBe(2);
    expect(young.stderr).not.toContain('orphan');
    expect(young.calls).toEqual([]);
    expect(noResult('V6-08')).toBe(true);
    expect(leftIn(youngSlot)).toEqual([LOCK]);
    expect(readOwner(youngSlot)).toBeNull();

    // Old, but a live holder has the gate: removed only through the gate, so both stay.
    const gatedSlot = slotDir('ownerless-gated');
    placeOrphan(gatedSlot, LOCK, 60);
    const gate = ownerText({ pid: process.pid, task: 'X9-14', token: 'x9-14:gate:live' });
    placeLock(gatedSlot, gate, GATE);
    const gated = await run(
      ['V6-11', '--worktree', workspace('ownerless-gated'), '--fast'],
      gatedSlot,
      {
        COULI_VERIFY_SLOT_WAIT_SECS: '2',
        COULI_VERIFY_SLOT_REPORT_SECS: '1',
        COULI_VERIFY_SLOT_ORPHAN_SECS: '1',
      },
    );
    expect(gated.status, gated.stderr).toBe(2);
    expect(runCalls(gated.calls)).toEqual([]);
    expect(noResult('V6-11')).toBe(true);
    expect(leftIn(gatedSlot)).toEqual([LOCK, GATE]);
    expect(readOwner(gatedSlot)).toBeNull();
    expect(readOwner(gatedSlot, GATE)).toBe(gate);
  },
  CLI_TIMEOUT,
);

it(
  '[CT-06zzzzb] without COULI_VERIFY_SLOT_ORPHAN_SECS the orphan limit is 30 s: a 40 s old ownerless lock is taken over, a 20 s old one is not',
  async () => {
    const oldSlot = slotDir('ownerless-default-old');
    placeOrphan(oldSlot, LOCK, 40);
    const taken = await run(
      ['V6-09', '--worktree', workspace('ownerless-default-old'), '--fast'],
      oldSlot,
      { COULI_VERIFY_SLOT_WAIT_SECS: '10', COULI_VERIFY_SLOT_REPORT_SECS: '1' },
    );
    expect(taken.status, taken.stderr).toBe(0);
    expect(linesWith(taken.stderr, 'orphan').length, taken.stderr).toBeGreaterThanOrEqual(1);
    expectOwnLock(entrypointCall(taken.calls), taken.pid, 'V6-09', 'verify:fast');
    expect(leftIn(oldSlot)).toEqual([]);

    const youngSlot = slotDir('ownerless-default-young');
    placeOrphan(youngSlot, LOCK, 20);
    const left = await run(
      ['V6-10', '--worktree', workspace('ownerless-default-young'), '--fast'],
      youngSlot,
      { COULI_VERIFY_SLOT_WAIT_SECS: '2', COULI_VERIFY_SLOT_REPORT_SECS: '1' },
    );
    expect(left.status, left.stderr).toBe(2);
    expect(left.calls).toEqual([]);
    expect(leftIn(youngSlot)).toEqual([LOCK]);
    expect(readOwner(youngSlot)).toBeNull();
  },
  CLI_TIMEOUT,
);

it(
  '[CT-06zzzzb] a takeover gate whose owner pid is dead is removed: --fast then takes over the stale lock, runs, leaves neither lock nor gate',
  async () => {
    const slot = slotDir('gate-dead');
    placeLock(slot, ownerText({ pid: deadPid(), task: 'X9-15', token: 'x9-15:stale' }));
    placeLock(slot, ownerText({ pid: deadPid(), task: 'X9-16', token: 'x9-16:gate:dead' }), GATE);
    const res = await run(['V6-12', '--worktree', workspace('gate-dead'), '--fast'], slot, {
      COULI_VERIFY_SLOT_WAIT_SECS: '10',
      COULI_VERIFY_SLOT_REPORT_SECS: '1',
    });
    expect(res.status, res.stderr).toBe(0);
    expect(
      linesWith(res.stderr, 'stale takeover gate', 'X9-16').length,
      res.stderr,
    ).toBeGreaterThanOrEqual(1);
    expect(res.stderr).toContain('stale verify slot');
    expect(res.stderr).toContain('X9-15');
    expectOwnLock(entrypointCall(res.calls), res.pid, 'V6-12', 'verify:fast');
    expect(leftIn(slot)).toEqual([]);
    expect(resultOf('V6-12', 'verify-fast')).toMatchObject({ script: 'verify:fast', exit_code: 0 });
  },
  CLI_TIMEOUT,
);

it(
  '[CT-06zzzzb] a takeover gate without an owner file: older than COULI_VERIFY_SLOT_ORPHAN_SECS it is removed and the stale lock taken over (nothing left); younger it is left alone (exit 2)',
  async () => {
    const oldSlot = slotDir('gate-ownerless-old');
    placeLock(oldSlot, ownerText({ pid: deadPid(), task: 'X9-17', token: 'x9-17:stale' }));
    placeOrphan(oldSlot, GATE, 60);
    const taken = await run(
      ['V6-13', '--worktree', workspace('gate-ownerless-old'), '--fast'],
      oldSlot,
      {
        COULI_VERIFY_SLOT_WAIT_SECS: '10',
        COULI_VERIFY_SLOT_REPORT_SECS: '1',
        COULI_VERIFY_SLOT_ORPHAN_SECS: '1',
      },
    );
    expect(taken.status, taken.stderr).toBe(0);
    expect(
      linesWith(taken.stderr, 'orphan', 'takeover gate').length,
      taken.stderr,
    ).toBeGreaterThanOrEqual(1);
    expect(taken.stderr).toContain('stale verify slot');
    expectOwnLock(entrypointCall(taken.calls), taken.pid, 'V6-13', 'verify:fast');
    expect(leftIn(oldSlot)).toEqual([]);
    expect(resultOf('V6-13', 'verify-fast')).toMatchObject({ script: 'verify:fast', exit_code: 0 });

    const youngSlot = slotDir('gate-ownerless-young');
    const stale = ownerText({ pid: deadPid(), task: 'X9-18', token: 'x9-18:stale' });
    placeLock(youngSlot, stale);
    placeOrphan(youngSlot, GATE, 0);
    const young = await run(
      ['V6-14', '--worktree', workspace('gate-ownerless-young'), '--fast'],
      youngSlot,
      {
        COULI_VERIFY_SLOT_WAIT_SECS: '2',
        COULI_VERIFY_SLOT_REPORT_SECS: '1',
        COULI_VERIFY_SLOT_ORPHAN_SECS: '30',
      },
    );
    expect(young.status, young.stderr).toBe(2);
    expect(young.stderr).not.toContain('orphan');
    expect(runCalls(young.calls)).toEqual([]);
    expect(noResult('V6-14')).toBe(true);
    expect(leftIn(youngSlot)).toEqual([LOCK, GATE]);
    expect(readOwner(youngSlot)).toBe(stale);
    expect(readOwner(youngSlot, GATE)).toBeNull();
  },
  CLI_TIMEOUT,
);

it(
  '[CT-06zzzzb] COULI_VERIFY_SLOT_ORPHAN_SECS must be a positive integer (exit 2, no docker call) and defaults to 30',
  async () => {
    const ws = workspace('ownerless-settings');
    const name = 'COULI_VERIFY_SLOT_ORPHAN_SECS';
    for (const value of ['x', '-1', '1.5', '0']) {
      const res = await run(['V6-15', '--worktree', ws, '--fast'], slotDir('ownerless-settings'), {
        [name]: value,
      });
      expect(res.status, `${name}=${value}`).toBe(2);
      expect(res.stderr, `${name}=${value}`).toContain(`${name} must be a positive integer`);
      expect(res.calls, `${name}=${value}`).toEqual([]);
    }
    expect(noResult('V6-15')).toBe(true);
    const text = readFileSync(SCRIPT, 'utf8');
    expect(text).toMatch(/SLOT_ORPHAN_SECS[^\n]*\b30\b/);
  },
  CLI_TIMEOUT,
);

// CT-06zzzzb (编排 12:29): the docker ps of the stale check runs under the takeover gate, so it
// has a limit, COULI_VERIFY_SLOT_PS_TIMEOUT_SECS (a positive integer, default 10). A docker ps that
// outlives it is cut off and counts as a failed lookup: not stale, the gate is dropped, the run
// keeps waiting; stderr says so with `docker ps` and `timed out` on one line.

/** True while a process with this pid exists. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

it('[CT-06zzzzb] a docker ps that hangs past COULI_VERIFY_SLOT_PS_TIMEOUT_SECS is cut off and counts as failed: no takeover, the gate dropped, exit 2 at the wait limit, no hung ps left', async () => {
  const slot = slotDir('ps-hangs');
  const token = 'x9-19:pshang';
  const stale = ownerText({ pid: deadPid(), task: 'X9-19', token });
  placeLock(slot, stale);
  const pids = join(base, 'ps-hangs-pids');
  mkdirSync(pids, { recursive: true });
  const hungPids = () => readdirSync(pids).map(Number);
  // What the slot directory held, sampled while the run waits: is the gate there?
  const samples: { t: number; gate: boolean }[] = [];
  const sampler = setInterval(() => {
    samples.push({ t: Date.now(), gate: existsSync(join(slot, GATE)) });
  }, 25);
  try {
    const started = start(['V6-16', '--worktree', workspace('ps-hangs'), '--fast'], slot, {
      COULI_VERIFY_SLOT_WAIT_SECS: '4',
      COULI_VERIFY_SLOT_REPORT_SECS: '1',
      COULI_VERIFY_SLOT_PS_TIMEOUT_SECS: '1',
      // The stuck daemon: each docker ps hangs 12 s, far past the 1 s limit, then lists nothing.
      STUB_DOCKER_PS_HANG: '12',
      STUB_DOCKER_PS_PIDS: pids,
    });
    const res = await started.done;
    const end = Date.now();
    clearInterval(sampler);
    expect(res.status, res.stderr).toBe(2);
    // It asked, and the stuck ps was cut off near its limit: the run ended at its own wait
    // limit, long before one hung ps (12 s) could have returned.
    const asked = psCallsFor(res.calls, token);
    expect(asked.length, JSON.stringify(res.calls)).toBeGreaterThanOrEqual(1);
    expect(res.elapsed, res.stderr).toBeLessThan(9000);
    // Said so: docker ps timed out (with the old holder's task).
    expect(
      linesWith(res.stderr, 'docker ps', 'timed out', 'X9-19').length,
      res.stderr,
    ).toBeGreaterThanOrEqual(1);
    // A timeout is a failed lookup, not "no container": no takeover.
    expect(res.stderr).not.toContain('taking over');
    expect(runCalls(res.calls)).toEqual([]);
    expect(entrypointCall(res.calls)).toBeUndefined();
    expect(noResult('V6-16')).toBe(true);
    // After the hung ps the gate was dropped while the run still waited (not held to the end),
    // and nothing but the stale lock, as it was, is left.
    const first = asked[0]?.at ?? end;
    const freed = samples.filter((s) => s.t > first + 500 && s.t < end - 200 && !s.gate);
    expect(freed.length, JSON.stringify(samples.filter((s) => s.gate).length)).toBeGreaterThan(0);
    expect(leftIn(slot)).toEqual([LOCK]);
    expect(readOwner(slot)).toBe(stale);
    // Every hung docker ps is gone (cut off, not left running in the background).
    expect(hungPids().length).toBeGreaterThanOrEqual(1);
    expect(await until(() => hungPids().every((pid) => !pidAlive(pid)), 3000)).toBe(true);
  } finally {
    clearInterval(sampler);
    for (const pid of hungPids()) {
      if (pidAlive(pid)) process.kill(pid, 'SIGKILL');
    }
  }
}, 40_000);

it(
  '[CT-06zzzzb] COULI_VERIFY_SLOT_PS_TIMEOUT_SECS must be a positive integer (exit 2, no docker call) and defaults to 10',
  async () => {
    const ws = workspace('ps-timeout-settings');
    const name = 'COULI_VERIFY_SLOT_PS_TIMEOUT_SECS';
    for (const value of ['x', '-1', '1.5', '0']) {
      const res = await run(['V6-17', '--worktree', ws, '--fast'], slotDir('ps-timeout-settings'), {
        [name]: value,
      });
      expect(res.status, `${name}=${value}`).toBe(2);
      expect(res.stderr, `${name}=${value}`).toContain(`${name} must be a positive integer`);
      expect(res.calls, `${name}=${value}`).toEqual([]);
    }
    expect(noResult('V6-17')).toBe(true);
    const text = readFileSync(SCRIPT, 'utf8');
    expect(text).toMatch(/SLOT_PS_TIMEOUT_SECS[^\n]*\b10\b/);
  },
  CLI_TIMEOUT,
);

// CT-06zzzzy (D10-1365). What these tests fix in addition:
//   - taking the slot: after the mkdir the owner file is written aside and put in place with ln (a
//     hard link that never replaces an existing owner); the run then reads it back and its token
//     must be this run's. When the ln fails or the owner read back is someone else's, this run did
//     not get the slot: it removes only its own temporary file (no owner.tmp.* is left), leaves the
//     lock and the other owner alone, says `lost the verify slot while taking it` with the holder
//     on stderr and waits again (the wait limit and the wait reports as before);
//   - before each container a slot-holding run starts (--fast: the verify container; the default
//     pnpm verify: the services, then the verify container) the owner token is checked again; when
//     the slot is no longer this run's, stderr says `the verify slot is no longer this run's (now
//     <holder>): not starting <the verify container | the services>` and the run exits 2: that
//     container is not started, no result.json, the other holder's lock is left as it is;
//   - --red, --browser, --related and --dry-run take no slot and make no such check.
// The stub `ln` (STUB_LN_STEAL / STUB_LN_ONCE) makes another owner appear between this run's mkdir
// and its ln; the stub docker (STUB_DOCKER_REPLACE_LOCK_ON) replaces the lock after the slot was
// taken and before any container started.

/** The entries inside the lock directory (nothing when it does not exist). */
function insideLock(dir: string): string[] {
  return leftIn(join(dir, LOCK));
}

it(
  "[CT-06zzzzy] another owner appears between this run's mkdir and its ln: it is not overwritten; --fast says it lost the slot, waits again without any docker call, and runs as itself once the slot is free",
  async () => {
    const slot = slotDir('ln-lost');
    const once = join(base, 'ln-lost-once');
    writeFileSync(once, 'once\n');
    const foreign = ownerText({ pid: process.pid, task: 'X9-20', token: 'x9-20:foreign:ln' });
    const started = start(['V7-01', '--worktree', workspace('ln-lost'), '--fast'], slot, {
      COULI_VERIFY_SLOT_WAIT_SECS: '30',
      COULI_VERIFY_SLOT_REPORT_SECS: '1',
      STUB_LN_STEAL: foreign,
      STUB_LN_ONCE: once,
    });
    try {
      // The run put its owner in place with ln (the stub fired), or it went on to docker instead.
      expect(
        await until(() => !existsSync(once) || readCalls(started.log).length > 0, 15_000),
      ).toBe(true);
      expect(existsSync(once), 'the owner file was not put in place with ln').toBe(false);
      await pause(1000);
      // Lost: waiting, no docker call; the other owner as it appeared, nothing of this run's left in
      // the lock.
      expect(readCalls(started.log)).toEqual([]);
      expect(readOwner(slot)).toBe(foreign);
      expect(insideLock(slot)).toEqual(['owner']);
      // The other holder releases the slot.
      removeDir(join(slot, LOCK));
      const res = await started.done;
      expect(res.status, res.stderr).toBe(0);
      expect(
        linesWith(res.stderr, 'lost the verify slot while taking it', 'X9-20').length,
        res.stderr,
      ).toBeGreaterThanOrEqual(1);
      // The wait is reported as before, naming the other holder.
      expect(linesWith(res.stderr, WAITING, 'X9-20').length, res.stderr).toBeGreaterThanOrEqual(1);
      // It then ran with the slot as its own, and released it: nothing is left (no owner.tmp.*).
      expectOwnLock(entrypointCall(res.calls), res.pid, 'V7-01', 'verify:fast', res.stderr);
      expect(leftIn(slot)).toEqual([]);
      const result = resultOf('V7-01', 'verify-fast');
      expect(Object.keys(result)).toEqual(RESULT_KEYS);
      expect(result).toMatchObject({ mode: 'container', script: 'verify:fast', exit_code: 0 });
    } finally {
      started.kill('SIGTERM');
    }
  },
  CLI_TIMEOUT,
);

it(
  '[CT-06zzzzy] after losing the slot while taking it, the run holds nothing: at COULI_VERIFY_SLOT_WAIT_SECS it exits 2 naming the other holder, whose lock and owner stay as they are; no docker call, no result.json',
  async () => {
    const slot = slotDir('ln-lost-limit');
    const once = join(base, 'ln-lost-limit-once');
    writeFileSync(once, 'once\n');
    const foreign = ownerText({ pid: process.pid, task: 'X9-21', token: 'x9-21:foreign:ln' });
    const res = await run(['V7-02', '--worktree', workspace('ln-lost-limit'), '--fast'], slot, {
      COULI_VERIFY_SLOT_WAIT_SECS: '2',
      COULI_VERIFY_SLOT_REPORT_SECS: '1',
      STUB_LN_STEAL: foreign,
      STUB_LN_ONCE: once,
    });
    expect(existsSync(once), 'the owner file was not put in place with ln').toBe(false);
    expect(res.status, res.stderr).toBe(2);
    expect(
      linesWith(res.stderr, 'lost the verify slot while taking it', 'X9-21').length,
      res.stderr,
    ).toBeGreaterThanOrEqual(1);
    // The usual end of a bounded wait, naming the other holder.
    const last = res.stderr.trim().split('\n').at(-1) ?? '';
    expect(last, res.stderr).toContain('verify slot');
    expect(last).toContain('X9-21');
    expect(last).toContain(String(process.pid));
    expect(res.calls).toEqual([]);
    expect(noResult('V7-02')).toBe(true);
    // The release did not take the other holder's lock for this run's own (this run held nothing,
    // so it had nothing to leave to anyone either).
    expect(res.stderr).not.toContain('left to its holder');
    expect(leftIn(slot)).toEqual([LOCK]);
    expect(insideLock(slot)).toEqual(['owner']);
    expect(readOwner(slot)).toBe(foreign);
  },
  CLI_TIMEOUT,
);

it(
  "[CT-06zzzzy] --fast: the slot replaced after it was taken (at docker version) → exit 2 before the verify container, `no longer this run's` naming the new holder, no result.json, the new holder's lock untouched",
  async () => {
    const slot = slotDir('recheck-fast');
    const other = ownerText({ pid: process.pid, task: 'X9-22', token: 'x9-22:other:recheck' });
    const res = await run(['V7-03', '--worktree', workspace('recheck-fast'), '--fast'], slot, {
      STUB_DOCKER_REPLACE_LOCK: other,
      STUB_DOCKER_REPLACE_LOCK_ON: 'version',
    });
    expect(res.status, res.stderr).toBe(2);
    // The lock was replaced where intended: at docker version, after the slot was taken.
    expect(res.calls.some((c) => c.args[0] === 'version')).toBe(true);
    expect(entrypointCall(res.calls), res.stderr).toBeUndefined();
    expect(
      linesWith(res.stderr, "no longer this run's", 'not starting the verify container', 'X9-22')
        .length,
      res.stderr,
    ).toBeGreaterThanOrEqual(1);
    expect(noResult('V7-03')).toBe(true);
    expect(leftIn(slot)).toEqual([LOCK]);
    expect(readOwner(slot)).toBe(other);
  },
  CLI_TIMEOUT,
);

it(
  "[CT-06zzzzy] pnpm verify: the slot replaced after it was taken (at docker version) → exit 2 before the services start (no docker run -d) and before the verify container, `no longer this run's` naming the new holder, no result.json, the lock untouched",
  async () => {
    const slot = slotDir('recheck-verify');
    const other = ownerText({ pid: process.pid, task: 'X9-23', token: 'x9-23:other:recheck' });
    const res = await run(['V7-04', '--worktree', workspace('recheck-verify')], slot, {
      STUB_DOCKER_REPLACE_LOCK: other,
      STUB_DOCKER_REPLACE_LOCK_ON: 'version',
    });
    expect(res.status, res.stderr).toBe(2);
    expect(res.calls.some((c) => c.args[0] === 'version')).toBe(true);
    expect(
      runCalls(res.calls).filter((c) => c.args.includes('-d')),
      res.stderr,
    ).toEqual([]);
    expect(entrypointCall(res.calls), res.stderr).toBeUndefined();
    expect(
      linesWith(res.stderr, "no longer this run's", 'not starting the services', 'X9-23').length,
      res.stderr,
    ).toBeGreaterThanOrEqual(1);
    expect(noResult('V7-04')).toBe(true);
    expect(leftIn(slot)).toEqual([LOCK]);
    expect(readOwner(slot)).toBe(other);
  },
  CLI_TIMEOUT,
);

it(
  "[CT-06zzzzy] pnpm verify: the slot replaced while the services start (at docker exec, the readiness checks) → exit 2 before the verify container, `no longer this run's` naming the new holder, no result.json, the lock untouched",
  async () => {
    const slot = slotDir('recheck-verify-services');
    const other = ownerText({ pid: process.pid, task: 'X9-24', token: 'x9-24:other:recheck' });
    const res = await run(['V7-05', '--worktree', workspace('recheck-verify-services')], slot, {
      STUB_DOCKER_REPLACE_LOCK: other,
      STUB_DOCKER_REPLACE_LOCK_ON: 'exec',
    });
    expect(res.status, res.stderr).toBe(2);
    // The services did start (the slot was still this run's then), and their readiness was asked.
    expect(
      runCalls(res.calls).filter((c) => c.args.includes('-d')).length,
      res.stderr,
    ).toBeGreaterThanOrEqual(1);
    expect(res.calls.some((c) => c.args[0] === 'exec')).toBe(true);
    expect(entrypointCall(res.calls), res.stderr).toBeUndefined();
    expect(
      linesWith(res.stderr, "no longer this run's", 'not starting the verify container', 'X9-24')
        .length,
      res.stderr,
    ).toBeGreaterThanOrEqual(1);
    expect(noResult('V7-05')).toBe(true);
    expect(leftIn(slot)).toEqual([LOCK]);
    expect(readOwner(slot)).toBe(other);
  },
  CLI_TIMEOUT,
);

it(
  '[CT-06zzzzy] --browser takes no slot and makes no slot check: with the lock replaced at docker version it runs exactly as before',
  async () => {
    const slot = slotDir('recheck-browser');
    const other = ownerText({ pid: process.pid, task: 'X9-25', token: 'x9-25:other:browser' });
    const res = await run(
      [
        'V7-06',
        '--worktree',
        workspace('recheck-browser', lockWithPlaywright('1.56.1')),
        '--browser',
      ],
      slot,
      { STUB_DOCKER_REPLACE_LOCK: other, STUB_DOCKER_REPLACE_LOCK_ON: 'version' },
    );
    const browser = entrypointCall(res.calls);
    expect(browser?.args.slice(-2), res.stderr).toEqual(['couli-verify-entrypoint', 'browser']);
    // The replacement came first (at docker version): the browser container saw the other lock.
    expect(browser?.slot?.owner).toBe(other);
    // As before: a green browser run that exported no screenshot counts as failed (exit 1).
    expect(res.status, res.stderr).toBe(1);
    expect(resultOf('V7-06', 'browser')).toMatchObject({ script: 'browser', exit_code: 1 });
    expect(res.stderr).not.toContain("no longer this run's");
    expect(res.stderr).not.toContain(WAITING);
    expect(leftIn(slot)).toEqual([LOCK]);
    expect(readOwner(slot)).toBe(other);
  },
  CLI_TIMEOUT,
);
