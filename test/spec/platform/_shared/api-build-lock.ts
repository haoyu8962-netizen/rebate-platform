// Cross-process lock around the `tsc -b apps/api` of the dist-subprocess integration tests
// (CT-06zzzzzm, D10-1937 / D10-1953). Under a large parallel run several of these test files build
// apps/api at the same time; one of those builds died in 14–33 s with no output (likely killed by a
// signal), and build() never showed the signal. lockApiBuild() / unlockApiBuild() around the
// spawnSync make the builds of one worktree run one at a time; reportApiBuild(result) prints one
// line per build with status, signal and the stderr tail. Nothing here asserts, changes the
// spawnSync arguments or its result, or swallows an error. Synchronous, because build() is.
//
// The lock is the directory .tmp/api-build-lock/<hash of the repository root> (.tmp/ is ignored by
// git), taken with an atomic mkdir; the file `owner` inside records the holder's pid, a token of
// this acquisition and its start time (ms since the epoch). A waiter takes the lock over at once
// when the holder's process is gone (process.kill(pid, 0) fails with ESRCH: the holder died,
// e.g. a worker killed while building — this also covers a holder that never reached
// unlockApiBuild()), else after STALE_MS, else it sleeps POLL_MS and tries again.
import { createHash, randomUUID } from 'node:crypto';
import type { SpawnSyncReturns } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { threadId } from 'node:worker_threads';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../../..');
const LOCK_DIR = path.join(
  ROOT,
  '.tmp',
  'api-build-lock',
  createHash('sha256').update(ROOT).digest('hex').slice(0, 16),
);
const OWNER_FILE = path.join(LOCK_DIR, 'owner');
/** Written by tsc -b for apps/api (apps/api/tsconfig.json tsBuildInfoFile). */
const BUILD_INFO = path.join(ROOT, 'apps/api/dist/tsconfig.tsbuildinfo');

// A holder that still runs is taken over only after STALE_MS. The build it guards is bounded by
// its spawnSync timeout of 120 s (the child is killed then and spawnSync returns), so a live
// holder keeps the lock at most a little over 120 s: 150 s leaves 30 s for that. It stays below
// the shortest timeout of a calling test (180 s) so a waiter behind one dead-but-unnoticed holder
// (pid reused) still gets its turn; a waiter queued behind several live builds can still run past
// its own test timeout — the lock serialises, it does not shorten anything.
const STALE_MS = 150_000;
const POLL_MS = 200;

type Owner = { pid: number; token: string; startedAt: number };

type State = {
  token: string;
  /** performance.now() when the lock was acquired / released. */
  acquired: number;
  released: number | null;
  waitMs: number;
  /** How the lock was got: free, or taken over from a dead / stale holder. */
  via: 'free' | 'dead-owner' | 'stale';
  /** unlockApiBuild found another owner: this lock was taken over while held. */
  lost: boolean;
  /** mtimeMs of apps/api's tsbuildinfo when the lock was acquired; null when absent. */
  infoBefore: number | null;
};

let state: State | null = null;

function codeOf(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err
    ? String((err as { code: unknown }).code)
    : undefined;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** The owner file's text, or null when it is not there (yet / any more). */
function readOwnerText(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch (err) {
    if (codeOf(err) === 'ENOENT') return null;
    throw err;
  }
}

function parseOwner(text: string | null): Owner | null {
  if (text === null) return null;
  try {
    const value = JSON.parse(text) as Partial<Owner>;
    if (
      typeof value.pid === 'number' &&
      typeof value.token === 'string' &&
      typeof value.startedAt === 'number'
    ) {
      return { pid: value.pid, token: value.token, startedAt: value.startedAt };
    }
  } catch {
    // Not JSON (the owner file is renamed in whole, so only a foreign or damaged file): judged by
    // the directory's age, like a missing one — at worst it is taken over after STALE_MS.
  }
  return null;
}

/** process.kill(pid, 0): ESRCH means gone, EPERM means alive under another user. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = codeOf(err);
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    throw err;
  }
}

function mtimeOf(file: string): number | null {
  try {
    return statSync(file).mtimeMs;
  } catch (err) {
    if (codeOf(err) === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Removes the lock judged dead or stale (its owner file read `seen`). It is first renamed to a
 * unique name so two waiters cannot both remove it; when the renamed lock turns out to be a newer
 * one (taken between the read and the rename) it is put back. Should that fail because yet another
 * lock exists already, the moved holder runs unlocked — two builds at once, as before this helper,
 * never a deadlock.
 */
function takeOver(seen: string | null): void {
  const grave = `${LOCK_DIR}.gone-${process.pid}-${randomUUID()}`;
  try {
    renameSync(LOCK_DIR, grave);
  } catch (err) {
    if (codeOf(err) === 'ENOENT') return;
    throw err;
  }
  if (readOwnerText(path.join(grave, 'owner')) !== seen) {
    try {
      renameSync(grave, LOCK_DIR);
      return;
    } catch (err) {
      const code = codeOf(err);
      if (code !== 'EEXIST' && code !== 'ENOTEMPTY') throw err;
    }
  }
  rmSync(grave, { recursive: true, force: true });
}

/** Takes the cross-process lock of this worktree's apps/api build; blocks until it has it. */
export function lockApiBuild(): void {
  if (state !== null && state.released === null) {
    throw new Error('lockApiBuild: this process holds the apps/api build lock already');
  }
  mkdirSync(path.dirname(LOCK_DIR), { recursive: true });
  const token = `${process.pid}-${threadId}-${randomUUID()}`;
  const start = performance.now();
  let via: State['via'] = 'free';
  for (;;) {
    try {
      mkdirSync(LOCK_DIR);
    } catch (err) {
      if (codeOf(err) !== 'EEXIST') throw err;
      const seen = readOwnerText(OWNER_FILE);
      const owner = parseOwner(seen);
      if (owner !== null && !alive(owner.pid)) {
        takeOver(seen);
        via = 'dead-owner';
        continue;
      }
      // Without a readable owner file (being written, or its writer died) the directory's mtime
      // stands for the start time.
      const since = owner?.startedAt ?? mtimeOf(LOCK_DIR);
      if (since === null) continue; // released between the mkdir and the stat: try again
      if (Date.now() - since > STALE_MS) {
        takeOver(seen);
        via = 'stale';
        continue;
      }
      sleepSync(POLL_MS);
      continue;
    }
    const owner: Owner = { pid: process.pid, token, startedAt: Date.now() };
    // Written aside and renamed in, so a waiter never reads half of it.
    const draft = path.join(LOCK_DIR, `owner.${token}`);
    writeFileSync(draft, JSON.stringify(owner));
    renameSync(draft, OWNER_FILE);
    break;
  }
  const acquired = performance.now();
  state = {
    token,
    acquired,
    released: null,
    waitMs: Math.round(acquired - start),
    via,
    lost: false,
    infoBefore: mtimeOf(BUILD_INFO),
  };
}

/** Releases the lock when this process (this acquisition) owns it; a second call does nothing. */
export function unlockApiBuild(): void {
  if (state === null || state.released !== null) return;
  state.released = performance.now();
  const owner = parseOwner(readOwnerText(OWNER_FILE));
  if (owner === null || owner.token !== state.token) {
    state.lost = true;
    return;
  }
  rmSync(OWNER_FILE, { force: true });
  rmSync(LOCK_DIR, { recursive: true, force: true });
}

/**
 * Prints one line about the build to stderr; changes nothing. "built" is a heuristic: whether
 * apps/api's tsbuildinfo got a new mtime during the lock (tsc -b writes or touches it whenever it
 * does not find apps/api up to date; an up-to-date check writes nothing), next to how long the
 * build held the lock.
 */
export function reportApiBuild(result: SpawnSyncReturns<string>): void {
  const after = mtimeOf(BUILD_INFO);
  const s = state;
  const built =
    s === null
      ? 'unknown (no lock taken)'
      : after === null
        ? 'no tsbuildinfo'
        : s.infoBefore === after
          ? 'no'
          : 'yes';
  const duration =
    s === null ? 'unknown' : String(Math.round((s.released ?? performance.now()) - s.acquired));
  const stderr = typeof result.stderr === 'string' ? result.stderr : String(result.stderr);
  const stdout = typeof result.stdout === 'string' ? result.stdout : String(result.stdout);
  const fields = [
    `status=${String(result.status)}`,
    `signal=${String(result.signal)}`,
    `error=${result.error === undefined ? 'none' : JSON.stringify(String(result.error))}`,
    `pid=${String(result.pid)}`,
    `build_ms=${duration}`,
    `lock_wait_ms=${s === null ? 'unknown' : String(s.waitMs)}`,
    `lock_via=${s === null ? 'unknown' : s.via}`,
    `lock_lost=${s === null ? 'unknown' : String(s.lost)}`,
    `tsbuildinfo_changed=${built}`,
    `stdout_chars=${String(stdout.length)}`,
    `stderr_tail=${JSON.stringify(stderr.slice(-1500))}`,
  ];
  process.stderr.write(`[api-build] tsc -b apps/api ${fields.join(' ')}\n`);
}
