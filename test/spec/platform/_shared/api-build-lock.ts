// Cross-process lock around the `tsc -b apps/api` of the dist-subprocess integration tests
// (CT-06zzzzzm, D10-1937 / D10-1953 / D10-1962). Under a large parallel run several of these test
// files build apps/api at the same time; one of those builds died in 14–33 s with no output
// (likely killed by a signal), and build() never showed the signal. lockApiBuild() /
// unlockApiBuild() around the spawnSync make the builds of one worktree run one at a time;
// reportApiBuild(result) prints one line per build with status, signal and the stderr tail.
// Nothing here asserts, changes the spawnSync arguments or its result, or swallows an error.
// Synchronous, because build() is.
//
// How the lock works. The directory .tmp/api-build-lock/<hash of the repository root> (.tmp/ is
// ignored by git) is never removed while in use; every holding of the lock is a numbered epoch in
// it. Epoch n is the file `<n>.owner` (pid, a token of this acquisition, start time in ms since
// the epoch), created by an atomic link of a fully written draft, so it either does not exist or
// is complete, and is never changed afterwards; its holder releases it by creating `<n>.released`.
// To acquire, a process reads the highest epoch m and judges it: released, holder gone
// (process.kill(pid, 0) fails with ESRCH: the holder died, e.g. a worker killed while building, or
// never reached unlockApiBuild()), or older than STALE_MS — then it links its own `<m+1>.owner`;
// otherwise it sleeps POLL_MS and reads again. After the link it reads the directory again and
// keeps the epoch only when it is the highest (else it leaves that file alone, writes nothing and
// starts over); then it deletes the files of epochs below m. The link is the compare-and-set: it
// succeeds for exactly one process per epoch number and only while that number is free, so taking
// over never moves, renames or deletes the holding it judged or anyone else's — an epoch is
// deleted only once two newer ones exist, and only the process whose token is in `<n>.owner`
// writes `<n>.released`.
//
// The interleavings (m = the highest epoch a waiter read):
// - Two, three or more waiters judge the same dead / stale / released m at once: all link
//   `<m+1>.owner`; exactly one succeeds, the others get EEXIST, read again, find m+1 held by a live
//   process and wait. Nothing of epoch m is touched.
// - The holder of m releases just while a waiter reads it: the waiter sees `<m>.released` (and
//   links m+1) or not yet (and sleeps POLL_MS and reads again). Releasing writes only the holder's
//   own `<m>.released`.
// - A new holder has just linked m+1 while a slow waiter still judges m: the waiter's link of m+1
//   gets EEXIST; it reads again and waits for m+1.
// - A waiter read the directory so long ago that the holder of m+2 has deleted m in the meantime:
//   its read of `<m>.owner` finds nothing and it reads again; or it links a deleted, lower number
//   k, sees a higher epoch on the read after the link, leaves `<k>.owner` as it is (inert: k stays
//   below the highest, the next sweep deletes it) and reads again — it never builds then.
// - The holder of m dies (kill -9): its pid is gone, the next waiter links m+1.
// - The holder of m still runs past STALE_MS (by design the only way to two builds at once, see
//   STALE_MS): a waiter links m+1; the old holder's unlockApiBuild() writes only `<m>.released`
//   and reports lock_lost=true.
// - Both at once (review r2): waiter A reads released m-1 and stalls; B links m, stalls past
//   STALE_MS and is taken over; the holders reach m+2, whose sweep deletes `<m>.owner`; A resumes,
//   links `<m>.owner` (its own token now), sees m+2 and goes on without writing anything; B resumes
//   and unlocks: `<m>.owner` holds A's token, not B's, so B writes nothing and reports
//   lock_lost=true. Had B's `<m>.owner` still stood but `<m>.released` already existed, B also
//   records lock_lost=true (the only EEXIST it lets pass). B's lock is never marked released by
//   anyone else; A's stray `<m>.owner` is never judged (m is below the highest) and is swept.
import { createHash, randomUUID } from 'node:crypto';
import type { SpawnSyncReturns } from 'node:child_process';
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
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

const EPOCH = /^(\d+)\.(owner|released)$/;
const DRAFT = /^draft-(\d+)-/;

type Owner = { pid: number; token: string; startedAt: number };

type State = {
  epoch: number;
  token: string;
  /** performance.now() when the lock was acquired / released. */
  acquired: number;
  released: number | null;
  waitMs: number;
  /** How the lock was got: free (released by its holder), or taken from a dead / stale holder. */
  via: 'free' | 'dead-owner' | 'stale';
  /**
   * unlockApiBuild found a newer epoch, or its number no longer its own / already marked: this
   * holding was taken over (stale) while held.
   */
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

function epochFile(n: number, kind: 'owner' | 'released'): string {
  return path.join(LOCK_DIR, `${String(n).padStart(12, '0')}.${kind}`);
}

/** The highest epoch number in the lock directory; 0 when there is none. */
function highestEpoch(): number {
  let max = 0;
  for (const name of readdirSync(LOCK_DIR)) {
    const m = EPOCH.exec(name);
    if (m !== null) max = Math.max(max, Number(m[1]));
  }
  return max;
}

/** The owner of epoch n, or null when its file is gone (deleted after two newer epochs). */
function ownerOf(n: number): Owner | null {
  const file = epochFile(n, 'owner');
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if (codeOf(err) === 'ENOENT') return null;
    throw err;
  }
  // Linked in whole, never rewritten: anything unreadable here was not written by this helper.
  const value = JSON.parse(text) as Partial<Owner>;
  if (
    typeof value.pid !== 'number' ||
    typeof value.token !== 'string' ||
    typeof value.startedAt !== 'number'
  ) {
    throw new Error(`api build lock: ${file} is not an owner record: ${JSON.stringify(text)}`);
  }
  return { pid: value.pid, token: value.token, startedAt: value.startedAt };
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
 * Deletes the files of epochs below `below` and the drafts of processes that are gone. Run by a
 * holder of epoch below + 1 only, so the epoch it judged (below) and its own stay.
 */
function sweep(below: number): void {
  for (const name of readdirSync(LOCK_DIR)) {
    const e = EPOCH.exec(name);
    const d = DRAFT.exec(name);
    if ((e !== null && Number(e[1]) < below) || (d !== null && !alive(Number(d[1])))) {
      rmSync(path.join(LOCK_DIR, name), { force: true });
    }
  }
}

/** Takes the cross-process lock of this worktree's apps/api build; blocks until it has it. */
export function lockApiBuild(): void {
  if (state !== null && state.released === null) {
    throw new Error('lockApiBuild: this process holds the apps/api build lock already');
  }
  mkdirSync(LOCK_DIR, { recursive: true });
  const token = `${process.pid}-${threadId}-${randomUUID()}`;
  const draft = path.join(LOCK_DIR, `draft-${process.pid}-${token}`);
  const start = performance.now();
  for (;;) {
    const m = highestEpoch();
    let via: State['via'] = 'free';
    if (m > 0) {
      const owner = ownerOf(m);
      if (owner === null) continue; // deleted since the read: newer epochs exist, read again
      if (existsSync(epochFile(m, 'released'))) via = 'free';
      else if (!alive(owner.pid)) via = 'dead-owner';
      else if (Date.now() - owner.startedAt > STALE_MS) via = 'stale';
      else {
        sleepSync(POLL_MS);
        continue;
      }
    }
    const mine = m + 1;
    const record: Owner = { pid: process.pid, token, startedAt: Date.now() };
    writeFileSync(draft, JSON.stringify(record), { flag: 'wx' });
    try {
      linkSync(draft, epochFile(mine, 'owner'));
    } catch (err) {
      if (codeOf(err) !== 'EEXIST') throw err;
      continue; // another waiter linked this epoch first: read again
    } finally {
      unlinkSync(draft);
    }
    if (highestEpoch() !== mine) {
      // A number freed by the sweep while a newer epoch exists: never hold it, and write nothing
      // more. A `.released` here could clash with that number's first holder, still in its build
      // after being taken over as stale, whose unlock writes it; removing the owner file again would
      // be a read then an unlink — not atomic against the sweep and a further re-link. Left as it
      // is the file is inert: the number is below the highest for good (the highest epoch is never
      // deleted), so nobody judges it, and the next holder's sweep deletes it.
      continue;
    }
    sweep(m);
    const acquired = performance.now();
    state = {
      epoch: mine,
      token,
      acquired,
      released: null,
      waitMs: Math.round(acquired - start),
      via,
      lost: false,
      infoBefore: mtimeOf(BUILD_INFO),
    };
    return;
  }
}

/** Releases this acquisition's epoch; a second call (or one without a lock) does nothing. */
export function unlockApiBuild(): void {
  if (state === null || state.released !== null) return;
  state.released = performance.now();
  const owner = ownerOf(state.epoch);
  if (owner === null || owner.token !== state.token) {
    // Taken over as stale, then swept (and the number maybe re-linked by a slow waiter): the
    // number is no longer this acquisition's; touch nothing.
    state.lost = true;
    return;
  }
  state.lost = highestEpoch() > state.epoch;
  try {
    writeFileSync(epochFile(state.epoch, 'released'), '', { flag: 'wx' });
  } catch (err) {
    // Already marked: only possible after this number was swept and reused while this build ran
    // past STALE_MS, i.e. it was taken over — the one known, harmless EEXIST. Anything else throws.
    if (codeOf(err) !== 'EEXIST') throw err;
    state.lost = true;
  }
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
    `lock_epoch=${s === null ? 'unknown' : String(s.epoch)}`,
    `lock_lost=${s === null ? 'unknown' : String(s.lost)}`,
    `tsbuildinfo_changed=${built}`,
    `stdout_chars=${String(stdout.length)}`,
    `stderr_tail=${JSON.stringify(stderr.slice(-1500))}`,
  ];
  process.stderr.write(`[api-build] tsc -b apps/api ${fields.join(' ')}\n`);
}
