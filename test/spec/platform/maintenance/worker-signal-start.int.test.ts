// Rule tests of SIGTERM / SIGINT during the worker start (task B1-01t; follow-up of the B1-01n code
// review round 1, S2). This header is the contract, numbered after the worker contract in
// apps/api/src/modules/platform/maintenance/worker.ts (sections 1–6; that header is not edited).
// Basis: ADR-0001 §4.2 第 4 项 (worker 里的定时任务以 couli_maint 建和删分区), 第 11 项 (连接池); worker
// contract sections 3 (stop order: maintenance → queue → resources) and 4 (entry wiring; `stopping`,
// services.stop(), `stopped`, exit 0, every pool closed by services.stop()).
//
// 7. Signals during the worker start (apps/api/src/entry.ts, worker branch only)
//    a. The worker installs its SIGTERM / SIGINT handling before it starts: before
//       createWorkerContext (at the latest before startWorkerServices is called). Today the handler
//       is installed only after `started`, so a signal during the start (Nest context, queue
//       start, first maintenance run — which can wait on a partition lock) takes the default
//       action: the process is killed, no pool is closed.
//    b. The first SIGTERM or SIGINT before `started` logs at once (when the signal arrives, not when
//       the start ends) the `stopping` line of section 4: level info, fields exactly { signal }
//       ('SIGTERM' / 'SIGINT'), through the root logger. It does not interrupt the start:
//       createWorkerContext and startWorkerServices (queue.start(), then the first maintenance run
//       or the partition_maintenance_disabled line) run to their end exactly as without a signal.
//    c. The start then succeeds: NO `started` line; services.stop() (section 3 order); then
//       `stopped` (level info, no other field) — or, when services.stop() rejects, `shutdown_failed`
//       { err } and exit code 1, as after `started`. No keep-alive timer is left running (none is
//       created, or it is cleared) and process.exit() is not called: the process ends on its own,
//       with exit code 0, well within 5 s after the start ended (not after a pool's idle timeout).
//    d. The start fails (any step, with or without a signal): unchanged — every resource that
//       exists is closed, `startup_failed`, exit code 1, the process ends on its own. When a signal
//       had arrived, its `stopping` line stays and NO `stopped` or `shutdown_failed` line follows
//       (待编排会话确认: suggested default).
//    e. Every later SIGTERM / SIGINT (during the start, during the stop, after) is ignored: no
//       second `stopping` line, nothing is started or stopped again.
//    f. A signal after `started`: unchanged (section 4; test/spec/platform/maintenance/
//       worker-entry.int.test.ts and test/spec/platform/queue/entries.int.test.ts).
//    g. COULI_EXIT_AFTER_INIT=1: unchanged (`started`, context and maintenance handle closed,
//       exit 0, queue and maintenance never started); signals in that mode are not part of this
//       contract.
//    h. api, stream, admin and payout: unchanged (not this task).
//
// How the tests hold the start: the built entry runs as a child process (`node dist/main.worker.js`
// as worker-entry.int.test.ts does, plus `--import ./exit-probe.ts`, which writes one stderr line
// only when the process ends on its own). Another session holds a lock the start must wait for:
//   - queue start: ACCESS EXCLUSIVE on pgboss.version (queue.start() reads it first, platform/queue
//     contract 5.1);
//   - first maintenance run: the advisory lock app.ensure_month_partition takes for
//     event_log_p202611 (CLOCK_NOW is in November 2026), as schedule.int.test.ts does. The run's
//     lock_timeout is 5 s (maintenance contract C.3), so the lock is released well before that.
// While the start waits (seen in pg_locks), the signals are sent; then the lock is released.
// When the `stopped` line arrives the child is paused (SIGSTOP) and pg_stat_activity must show no
// session of its pools (couli-worker, couli-worker-maint) any more; then it is continued.
// Children are kept few (four, on one clone of the migrated template). Top-level it() only
// (规划/11 §4.3).
// B1-01w supplementary (worker 契约 8, header of ./worker-day-partitions.int.test.ts): the worker's
// maintenance now also pre-creates the 15 link_logs day partitions, so its first run reports
// ensured 23 (8 month + 15 day partitions) instead of 8; only that count changed here.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { expect, it } from 'vitest';
import { leaksIn } from '../db/kit.ts';
import { ALL_ENSURED, gate, sleep, waitFor } from './kit.ts';
import { lockApiBuild, unlockApiBuild, reportApiBuild } from '../_shared/api-build-lock.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../../..');
const API_DIR = path.join(ROOT, 'apps/api');
const PROBE = pathToFileURL(path.join(HERE, 'exit-probe.ts')).href;
const CLOCK_NOW = '2026-11-20T03:04:05Z';
const ADVISORY_KEY = 'app.ensure_month_partition:event_log_p202611';

/** Builds apps/api (incremental); returns '' on success or what went wrong. */
function build(): string {
  const tsc = createRequire(path.join(ROOT, 'package.json')).resolve('typescript/bin/tsc');
  lockApiBuild();
  const result = spawnSync(process.execPath, [tsc, '-b', API_DIR], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120_000,
  });
  unlockApiBuild();
  reportApiBuild(result);
  if (result.status !== 0) {
    return `tsc -b apps/api: ${result.stdout}${result.stderr}`.slice(0, 2000);
  }
  return '';
}

/** A minimal environment: only what is given, plus PATH, HOME and TMPDIR. */
function childEnv(vars: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = { LOG_LEVEL: 'info', ...vars };
  for (const name of ['PATH', 'HOME', 'TMPDIR']) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

interface LogRecord {
  readonly [key: string]: unknown;
}

function parse(stdout: string): LogRecord[] {
  return stdout
    .split('\n')
    .filter((text) => text.trim() !== '')
    .map((text) => {
      try {
        return JSON.parse(text) as LogRecord;
      } catch {
        return { msg: `(not JSON) ${text}` };
      }
    });
}

/** A partition line or a lifecycle line (Nest's own start-up lines are not). */
function isKey(msg: string): boolean {
  return (
    msg.startsWith('partition_') ||
    msg.startsWith('(not JSON)') ||
    [
      'started',
      'stopping',
      'stopped',
      'startup_failed',
      'shutdown_failed',
      'config_invalid',
    ].includes(msg)
  );
}

function keyMessages(stdout: string): string[] {
  return parse(stdout)
    .map((record) => String(record.msg))
    .filter(isKey);
}

/** The records of `msg`, without time and pid. */
function linesOf(stdout: string, msg: string): LogRecord[] {
  return parse(stdout)
    .filter((record) => record.msg === msg)
    .map((record) => {
      const rest: Record<string, unknown> = { ...record };
      delete rest.time;
      delete rest.pid;
      return rest;
    });
}

interface Worker {
  readonly child: ChildProcess;
  stdout(): string;
  stderr(): string;
  /** True once the process exited (whatever the reason). */
  exited(): boolean;
  /**
   * Resolves when the `stopped` line arrived; the process is then paused (SIGSTOP) so that what
   * it still holds at that moment can be looked at; `resume()` continues it.
   */
  readonly atStopped: Promise<void>;
  resume(): void;
  /** Resolves when the process exited and its output was read to the end. */
  readonly closed: Promise<{ code: number | null; signal: string | null; at: number }>;
}

/** Starts the built worker entry with the exit probe; SIGKILL after `limitMs`. */
function launch(vars: Record<string, string>, limitMs = 60_000): Worker {
  const child = spawn(
    process.execPath,
    ['--import', PROBE, path.join(API_DIR, 'dist', 'main.worker.js')],
    { cwd: API_DIR, env: childEnv(vars), stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stdout = '';
  let stderr = '';
  let exited = false;
  let paused = false;
  const stoppedLine = gate();
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    stdout += chunk;
    if (!paused && /"msg":"stopped"/.test(stdout)) {
      paused = true;
      child.kill('SIGSTOP');
      stoppedLine.open();
    }
  });
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk;
  });
  child.on('exit', () => {
    exited = true;
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), limitMs);
  const closed = new Promise<{ code: number | null; signal: string | null; at: number }>(
    (resolve) => {
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal, at: performance.now() });
      });
    },
  );
  return {
    child,
    stdout: () => stdout,
    stderr: () => stderr,
    exited: () => exited,
    atStopped: stoppedLine.wait(),
    resume: () => {
      if (paused) child.kill('SIGCONT');
    },
    closed,
  };
}

interface Waiter {
  readonly app: string;
  readonly target: string;
}

/** Sessions of this database waiting for a lock: who (application_name) and on what. */
async function waiters(observer: Kysely<DB>): Promise<Waiter[]> {
  const rows = await sql<Waiter>`
    WITH k AS (SELECT hashtextextended(${ADVISORY_KEY}, 0) AS v)
    SELECT a.application_name AS app,
           CASE
             WHEN l.locktype = 'relation' THEN l.relation::regclass::text
             WHEN l.locktype = 'advisory'
                  AND l.objsubid = 1
                  AND l.classid::bigint = ((k.v >> 32) & 4294967295)
                  AND l.objid::bigint = (k.v & 4294967295)
               THEN 'advisory ' || ${ADVISORY_KEY}
             ELSE l.locktype
           END AS target
    FROM pg_locks l
    JOIN pg_stat_activity a ON a.pid = l.pid
    CROSS JOIN k
    WHERE NOT l.granted AND a.datname = current_database()
    ORDER BY 1, 2
  `.execute(observer);
  return rows.rows.map((row) => ({ app: row.app, target: row.target }));
}

/** Sessions of this database opened by the worker's pools (couli-worker, couli-worker-maint). */
async function workerSessions(observer: Kysely<DB>): Promise<number> {
  const rows = await sql<{ n: string }>`
    SELECT count(*)::text AS n FROM pg_stat_activity
    WHERE datname = current_database() AND application_name IN ('couli-worker', 'couli-worker-maint')
  `.execute(observer);
  return Number(rows.rows[0]?.n ?? -1);
}

interface Holder {
  /** Resolves once the lock is held. */
  readonly locked: Promise<void>;
  /** Lets the holder release the lock (and commit what it was told to). */
  release(): void;
  /** Settles once the holder's session released the lock. */
  readonly done: Promise<void>;
}

/** Holds the advisory lock app.ensure_month_partition takes for event_log_p202611. */
function holdAdvisory(db: Kysely<DB>): Holder {
  const locked = gate();
  const barrier = gate();
  const done = db.connection().execute(async (conn) => {
    await sql`SELECT pg_advisory_lock(hashtextextended(${ADVISORY_KEY}, 0))`.execute(conn);
    locked.open();
    await barrier.wait();
    await sql`SELECT pg_advisory_unlock(hashtextextended(${ADVISORY_KEY}, 0))`.execute(conn);
  });
  return { locked: locked.wait(), release: () => barrier.open(), done };
}

/**
 * Holds ACCESS EXCLUSIVE on pgboss.version in a transaction; on release, sets the version to
 * `commitVersion` (when given) in the same transaction, then commits.
 */
function holdVersionTable(db: Kysely<DB>, commitVersion: number | null): Holder {
  const locked = gate();
  const barrier = gate();
  const done = db.transaction().execute(async (trx) => {
    await sql`LOCK TABLE pgboss.version IN ACCESS EXCLUSIVE MODE`.execute(trx);
    locked.open();
    await barrier.wait();
    if (commitVersion !== null) {
      await sql`UPDATE pgboss.version SET version = ${commitVersion}`.execute(trx);
    }
  });
  return { locked: locked.wait(), release: () => barrier.open(), done };
}

interface Observed {
  readonly blocked: {
    readonly waiting: boolean;
    readonly exited: boolean;
    readonly key: string[];
    readonly waiters: Waiter[];
  };
  readonly code: number | null;
  readonly signal: string | null;
  readonly key: string[];
  readonly stopping: LogRecord[];
  readonly stopped: LogRecord[];
  readonly done: LogRecord[];
  readonly stderr: string;
  readonly endsPromptly: boolean;
  readonly sessionsAtStopped: number | null;
  readonly sessionsLeft: number;
  readonly text: string;
}

/**
 * Starts the worker while `holder` holds a lock, waits until the start waits for exactly
 * `expected`, sends `signals` (100 ms apart), looks again 500 ms later, then releases the lock and
 * waits for the process to end.
 */
async function signalWhileBlocked(
  observer: Kysely<DB>,
  vars: Record<string, string>,
  holder: Holder,
  expected: Waiter,
  signals: readonly NodeJS.Signals[],
): Promise<Observed> {
  await holder.locked;
  const worker = launch(vars);
  try {
    const waiting = await waitFor(async () => {
      if (worker.exited()) return true;
      const now = await waiters(observer);
      return JSON.stringify(now) === JSON.stringify([expected]);
    }, 45_000);
    for (const [index, signal] of signals.entries()) {
      if (index > 0) await sleep(100);
      worker.child.kill(signal);
    }
    await sleep(500);
    const blocked = {
      waiting: waiting && !worker.exited(),
      exited: worker.exited(),
      key: keyMessages(worker.stdout()),
      waiters: await waiters(observer),
    };
    const releasedAt = performance.now();
    holder.release();
    await holder.done;
    // Contract 7 c: `stopped` comes after services.stop() resolved, so by then both pools are
    // closed and the database has no session of them left (checked while the process is paused).
    let sessionsAtStopped: number | null = null;
    const first = await Promise.race([
      worker.atStopped.then(() => 'stopped'),
      worker.closed.then(() => 'closed'),
    ]);
    // CT-06zd: pg's end() destroys a socket locally when the connection is still starting or a
    // query is on it, so the worker's side is closed while PostgreSQL's backend is still tearing
    // down (it notices the EOF a moment later; under a loaded full run this showed as 1 session,
    // F1-02zs / CT-06o / B1-35 / B2-04g verify/1). The process stays paused (SIGSTOP) while we
    // look: it cannot close anything now, so a session that goes away meanwhile was already
    // closed by the worker, and one the worker still holds open stays and is counted. Bounded by
    // the handles' 5 s close bound; the pause is not the worker's time (endsPromptly below).
    let pausedMs = 0;
    if (first === 'stopped') {
      const pausedAt = performance.now();
      await waitFor(async () => {
        sessionsAtStopped = await workerSessions(observer);
        return sessionsAtStopped === 0;
      }, 5000);
      pausedMs = performance.now() - pausedAt;
      worker.resume();
    }
    const end = await worker.closed;
    // The process has exited, so its sessions end too; this only checks nothing outlives it.
    let sessionsLeft = -1;
    await waitFor(async () => {
      sessionsLeft = await workerSessions(observer);
      return sessionsLeft === 0;
    }, 3000);
    const stdout = worker.stdout();
    return {
      blocked,
      code: end.code,
      signal: end.signal,
      key: keyMessages(stdout),
      stopping: linesOf(stdout, 'stopping'),
      stopped: linesOf(stdout, 'stopped'),
      done: linesOf(stdout, 'partition_maintenance_done'),
      stderr: worker.stderr(),
      endsPromptly: end.at - releasedAt - pausedMs < 5000,
      sessionsAtStopped,
      sessionsLeft,
      text: `${stdout}\n${worker.stderr()}`,
    };
  } finally {
    holder.release();
    await holder.done.catch(() => undefined);
    worker.child.kill('SIGKILL');
    await worker.closed;
  }
}

const QUEUE_WAITER: Waiter = { app: 'couli-worker', target: 'pgboss.version' };
const MAINT_WAITER: Waiter = { app: 'couli-worker-maint', target: `advisory ${ADVISORY_KEY}` };

function stoppingLine(signal: NodeJS.Signals): LogRecord {
  return { level: 30, entry: 'worker', env: 'test', signal, msg: 'stopping' };
}

const STOPPED_LINE: LogRecord = { level: 30, entry: 'worker', env: 'test', msg: 'stopped' };
const DONE_LINE: LogRecord = {
  level: 30,
  entry: 'worker',
  env: 'test',
  ensured: ALL_ENSURED,
  dropped: 0,
  failed: 0,
  msg: 'partition_maintenance_done',
};

/** What a run that stops gracefully after its start ended looks like (contract 7 b, c, e). */
function graceful(signal: NodeJS.Signals, waiter: Waiter): unknown {
  return {
    blocked: { waiting: true, exited: false, key: ['stopping'], waiters: [waiter] },
    code: 0,
    signal: null,
    key: ['stopping', 'partition_maintenance_done', 'stopped'],
    stopping: [stoppingLine(signal)],
    stopped: [STOPPED_LINE],
    done: [DONE_LINE],
    stderr: 'exit-probe: beforeExit 0\n',
    endsPromptly: true,
    sessionsAtStopped: 0,
    sessionsLeft: 0,
  };
}

function view(run: Observed): unknown {
  const rest: Record<string, unknown> = { ...run };
  delete rest.text;
  return rest;
}

it('[ADR-0001 §4.2 #4、#11; worker 契约 3、4、7] 真实入口（dist 子进程）：worker 在队列启动时（pgboss.version 被另一会话锁住）收到 SIGTERM——立即记 stopping、不退出、不记 started；放锁后启动照常做完（维护首轮 ensured 23：8 个月分区 + link_logs 15 个日分区，B1-01w），不记 started，按启停顺序停、记 stopped，进程自然结束（无 process.exit、保活定时器已清、两个池都关）、放锁后 5 秒内退出码 0；同一阶段收到 SIGINT 后启动失败（放锁时版本改成 41）：stopping、startup_failed、不记 stopped，进程自然结束、退出码 1；输出不含口令', async () => {
  const built = build();
  const database = await createTestDatabase();
  const holderDb = createDb({ connectionString: database.urlFor('couli_app'), max: 1 });
  const observer = createDb({ connectionString: database.urlFor('couli_app'), max: 1 });
  let seen: unknown;
  try {
    const appUrl = database.urlFor('couli_app');
    const maintUrl = database.urlFor('couli_maint');
    const phrases = [appUrl, maintUrl].map((url) => decodeURIComponent(new URL(url).password));
    const vars = {
      APP_ENV: 'test',
      CLOCK_NOW,
      DATABASE_URL: appUrl,
      DATABASE_MAINT_URL: maintUrl,
      REDIS_URL: 'redis://127.0.0.1:1/0',
    };
    const ok = await signalWhileBlocked(
      observer,
      vars,
      holdVersionTable(holderDb, null),
      QUEUE_WAITER,
      ['SIGTERM'],
    );
    const failed = await signalWhileBlocked(
      observer,
      vars,
      holdVersionTable(holderDb, 41),
      QUEUE_WAITER,
      ['SIGINT'],
    );
    await sql`UPDATE pgboss.version SET version = 42`.execute(holderDb);
    seen = {
      built,
      ok: view(ok),
      failed: view(failed),
      leaks: [ok, failed].flatMap((run) => leaksIn(run.text, phrases)),
    };
  } catch (error) {
    seen = { error: String(error) };
  } finally {
    await Promise.all([holderDb, observer].map((db) => destroyDb(db).catch(() => undefined)));
    await database.drop();
  }
  expect(seen).toEqual({
    built: '',
    ok: graceful('SIGTERM', QUEUE_WAITER),
    failed: {
      blocked: { waiting: true, exited: false, key: ['stopping'], waiters: [QUEUE_WAITER] },
      code: 1,
      signal: null,
      key: ['stopping', 'startup_failed'],
      stopping: [stoppingLine('SIGINT')],
      stopped: [],
      done: [],
      stderr: 'exit-probe: beforeExit 1\n',
      endsPromptly: true,
      sessionsAtStopped: null,
      sessionsLeft: 0,
    },
    leaks: [],
  });
}, 300_000);

it('[ADR-0001 §4.2 #4、#11; worker 契约 3、4、7] 真实入口（dist 子进程）：worker 的维护首轮卡在 event_log_p202611 的分区锁上时收到 SIGTERM 再收到 SIGINT（或 SIGINT 再 SIGTERM）——只按第一个信号立即记一行 stopping、不退出、不记 started；放锁后这一轮做完（ensured 23 含 link_logs 15 个日分区（B1-01w）、failed 0），不记 started，按启停顺序停、记 stopped，进程自然结束（无 process.exit、保活定时器已清、维护池与主池都关）、放锁后 5 秒内退出码 0；输出不含口令', async () => {
  const built = build();
  const database = await createTestDatabase();
  const holderDb = createDb({ connectionString: database.urlFor('couli_app'), max: 1 });
  const observer = createDb({ connectionString: database.urlFor('couli_app'), max: 1 });
  let seen: unknown;
  try {
    const appUrl = database.urlFor('couli_app');
    const maintUrl = database.urlFor('couli_maint');
    const phrases = [appUrl, maintUrl].map((url) => decodeURIComponent(new URL(url).password));
    const vars = {
      APP_ENV: 'test',
      CLOCK_NOW,
      DATABASE_URL: appUrl,
      DATABASE_MAINT_URL: maintUrl,
      REDIS_URL: 'redis://127.0.0.1:1/0',
    };
    const term = await signalWhileBlocked(observer, vars, holdAdvisory(holderDb), MAINT_WAITER, [
      'SIGTERM',
      'SIGINT',
    ]);
    const int = await signalWhileBlocked(observer, vars, holdAdvisory(holderDb), MAINT_WAITER, [
      'SIGINT',
      'SIGTERM',
    ]);
    seen = {
      built,
      term: view(term),
      int: view(int),
      leaks: [term, int].flatMap((run) => leaksIn(run.text, phrases)),
    };
  } catch (error) {
    seen = { error: String(error) };
  } finally {
    await Promise.all([holderDb, observer].map((db) => destroyDb(db).catch(() => undefined)));
    await database.drop();
  }
  expect(seen).toEqual({
    built: '',
    term: graceful('SIGTERM', MAINT_WAITER),
    int: graceful('SIGINT', MAINT_WAITER),
    leaks: [],
  });
}, 300_000);
