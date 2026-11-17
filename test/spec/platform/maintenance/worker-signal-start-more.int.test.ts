// Supplementary rule tests of worker contract 7 (task B1-01t; contract in the header of
// ./worker-signal-start.int.test.ts, not repeated here). Added after spec-test review round 1:
//   - 7 c: `stopped` is logged only after services.stop() has finished. The last stop step (closing
//     the maintenance handle) is held open: the maintenance pool connects through a TCP relay in
//     this test process that, once PostgreSQL closed a session after the pool's Terminate, does
//     not pass the close on to the worker until released — pg's end() waits for that close (db
//     contract: "end() can wait for the peer's FIN forever"). While held (well inside the handle's
//     5 s close bound), the process must still run and no `stopped` line may exist; after the
//     release `stopped` follows and the process ends on its own with exit code 0.
//   - 7 e: the SAME signal twice (SIGTERM then SIGTERM, SIGINT then SIGINT; the second one only
//     after the first one's `stopping` line is out) — the second is ignored: one `stopping` line,
//     the start still runs to its end, exit 0 on its own (a handler registered with
//     process.once would let the second signal take the default action).
//   - 7 c, services.stop() rejecting after a signal during the start (`shutdown_failed`, exit 1): not
//     tested here. At entry level no stop step can be made to reject on purpose — the queue stop,
//     the maintenance stop and both handles' close() settle successfully (the close bound ends in a
//     force close that resolves); stand-ins need the Nest entry in-process, which test/ cannot
//     compile. See couli-runs/B1-01t/author-supplement-1.md.
// Helpers are copied from ./worker-signal-start.int.test.ts (a test file cannot be imported).
// Top-level it() only (规划/11 §4.3).
// B1-01w supplementary (worker 契约 8, header of ./worker-day-partitions.int.test.ts): the worker's
// maintenance now also pre-creates the 15 link_logs day partitions, so its first run reports
// ensured 23 (8 month + 15 day partitions) instead of 8; only that count changed here.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import net from 'node:net';
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
      if (index > 0) {
        // The first signal has been handled (its stopping line is out) before the next is sent.
        await waitFor(
          () => worker.exited() || keyMessages(worker.stdout()).includes('stopping'),
          3000,
        );
        await sleep(100);
      }
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

interface Relay {
  /** `url` with its host and port replaced by the relay's. */
  urlThrough(url: string): string;
  /** Number of worker-side sockets whose close is being held back. */
  held(): number;
  /** Passes every held close on (and stops holding). */
  release(): void;
  close(): Promise<void>;
}

/** A TCP relay to the host and port of `url` that holds back the server's close of a session. */
async function startRelay(url: string): Promise<Relay> {
  const target = new URL(url);
  const host = target.hostname;
  const port = Number(target.port === '' ? '5432' : target.port);
  let holding = true;
  const heldSockets: net.Socket[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer({ allowHalfOpen: true }, (client) => {
    const upstream = net.connect({ host, port, allowHalfOpen: true });
    sockets.add(client);
    sockets.add(upstream);
    client.on('data', (chunk) => upstream.write(chunk));
    client.on('end', () => upstream.end());
    upstream.on('data', (chunk) => client.write(chunk));
    upstream.on('end', () => {
      if (holding) heldSockets.push(client);
      else client.end();
    });
    const drop = (): void => {
      client.destroy();
      upstream.destroy();
    };
    client.on('error', drop);
    upstream.on('error', drop);
    client.on('close', () => {
      sockets.delete(client);
      upstream.destroy();
    });
    upstream.on('close', () => sockets.delete(upstream));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const relayPort = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    urlThrough(original: string): string {
      const next = new URL(original);
      next.hostname = '127.0.0.1';
      next.port = String(relayPort);
      return next.href;
    },
    held: () => heldSockets.length,
    release(): void {
      holding = false;
      for (const socket of heldSockets.splice(0)) socket.end();
    },
    async close(): Promise<void> {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

interface HeldStop {
  readonly blocked: { readonly waiting: boolean; readonly exited: boolean; readonly key: string[] };
  readonly whileHeld: {
    readonly reached: boolean;
    readonly exited: boolean;
    readonly key: string[];
  };
  readonly code: number | null;
  readonly signal: string | null;
  readonly key: string[];
  readonly stopped: LogRecord[];
  readonly stderr: string;
  readonly endsPromptly: boolean;
  readonly text: string;
}

/**
 * Starts the worker (maintenance pool through `relay`) while the first maintenance run waits on
 * the advisory lock, sends `signal`, releases the lock, waits until the stop reached the close of
 * the maintenance handle (a close held by the relay), looks 600 ms later, then releases the relay.
 */
async function holdStop(
  observer: Kysely<DB>,
  vars: Record<string, string>,
  holder: Holder,
  relay: Relay,
  signal: NodeJS.Signals,
): Promise<HeldStop> {
  await holder.locked;
  const worker = launch(vars);
  try {
    const waiting = await waitFor(async () => {
      if (worker.exited()) return true;
      const now = await waiters(observer);
      return JSON.stringify(now) === JSON.stringify([MAINT_WAITER]);
    }, 45_000);
    worker.child.kill(signal);
    await waitFor(() => worker.exited() || keyMessages(worker.stdout()).includes('stopping'), 3000);
    const blocked = {
      waiting: waiting && !worker.exited(),
      exited: worker.exited(),
      key: keyMessages(worker.stdout()),
    };
    holder.release();
    await holder.done;
    const reached = await waitFor(() => worker.exited() || relay.held() > 0, 5000);
    await sleep(600);
    const whileHeld = {
      reached: reached && relay.held() > 0,
      exited: worker.exited(),
      key: keyMessages(worker.stdout()),
    };
    const releasedAt = performance.now();
    relay.release();
    // launch() pauses the child at its `stopped` line; this test only needs it to go on.
    await Promise.race([worker.atStopped, worker.closed]);
    worker.resume();
    const end = await worker.closed;
    const stdout = worker.stdout();
    return {
      blocked,
      whileHeld,
      code: end.code,
      signal: end.signal,
      key: keyMessages(stdout),
      stopped: linesOf(stdout, 'stopped'),
      stderr: worker.stderr(),
      endsPromptly: end.at - releasedAt < 3000,
      text: `${stdout}\n${worker.stderr()}`,
    };
  } finally {
    holder.release();
    relay.release();
    await holder.done.catch(() => undefined);
    worker.child.kill('SIGKILL');
    await worker.closed;
  }
}

it('[ADR-0001 §4.2 #4、#11; worker 契约 7 e] 真实入口（dist 子进程）：维护首轮卡在分区锁上时连收两次同一信号（SIGTERM→SIGTERM、SIGINT→SIGINT，第二次在第一次的 stopping 已记之后发）——第二次被忽略：只一行 stopping、不退出、不记 started；放锁后这一轮做完，按启停顺序停、记 stopped，进程自然结束、退出码 0', async () => {
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
      'SIGTERM',
    ]);
    const int = await signalWhileBlocked(observer, vars, holdAdvisory(holderDb), MAINT_WAITER, [
      'SIGINT',
      'SIGINT',
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
}, 180_000);

it('[ADR-0001 §4.2 #4、#11; worker 契约 3、7 c] 真实入口（dist 子进程）：维护首轮中收到 SIGTERM，放锁后启动做完并开始停止；停止的最后一步（关维护池）被挂住时进程仍在、只有 stopping 与 partition_maintenance_done、没有 stopped；放开后才记 stopped，进程自然结束、退出码 0', async () => {
  const built = build();
  const database = await createTestDatabase();
  const holderDb = createDb({ connectionString: database.urlFor('couli_app'), max: 1 });
  const observer = createDb({ connectionString: database.urlFor('couli_app'), max: 1 });
  const relay = await startRelay(database.urlFor('couli_maint'));
  let seen: unknown;
  try {
    const appUrl = database.urlFor('couli_app');
    const maintUrl = database.urlFor('couli_maint');
    const phrases = [appUrl, maintUrl].map((url) => decodeURIComponent(new URL(url).password));
    const run = await holdStop(
      observer,
      {
        APP_ENV: 'test',
        CLOCK_NOW,
        DATABASE_URL: appUrl,
        DATABASE_MAINT_URL: relay.urlThrough(maintUrl),
        REDIS_URL: 'redis://127.0.0.1:1/0',
      },
      holdAdvisory(holderDb),
      relay,
      'SIGTERM',
    );
    const { text, ...rest } = run;
    seen = { built, run: rest, leaks: leaksIn(text, phrases) };
  } catch (error) {
    seen = { error: String(error) };
  } finally {
    await relay.close();
    await Promise.all([holderDb, observer].map((db) => destroyDb(db).catch(() => undefined)));
    await database.drop();
  }
  expect(seen).toEqual({
    built: '',
    run: {
      blocked: { waiting: true, exited: false, key: ['stopping'] },
      whileHeld: {
        reached: true,
        exited: false,
        key: ['stopping', 'partition_maintenance_done'],
      },
      code: 0,
      signal: null,
      key: ['stopping', 'partition_maintenance_done', 'stopped'],
      stopped: [STOPPED_LINE],
      stderr: 'exit-probe: beforeExit 0\n',
      endsPromptly: true,
    },
    leaks: [],
  });
}, 180_000);
