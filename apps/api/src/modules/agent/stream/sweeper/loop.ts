// Agent sweeper worker loop (B3-03h; design couli-runs/B3-03g/design.md v5 §5.3 「worker 内循环 +
// advisory lock」, §5.1, §7.4 B3-03h, §10.1 T10; BR-AI-23 细则「受理记录与收尾 · 谁来收尾」: without a
// new request a worker finalizes left-over runs, a crash does not change the result; BR-AI-15 退还).
// Rule tests: test/spec/agent/stream-recovery/** import this file by path: names, signatures and
// the semantics written here are the contract. Discovery, the cursor order and each finalize call
// are B3-03e's createSweeper (./index.ts). A B3-03e pass cannot be interrupted once started, so the
// loop never runs one big pass: deps.step is a sweeper that handles at most ONE row per call
// (createSweeper with config {...sweeperDefaults(), maxPerTick: 1}), and a tick calls it again and
// again under one cluster-wide advisory lock, checking before every call whether it may go on.
//
// agentSweepLoopDefaults(): {intervalMs 60 000, jitterRatio 0.1, tickTimeoutMs 60 000, maxPerTick
//   500 (= sweeperDefaults().maxPerTick), stopTimeoutMs: a positive safe integer} (T10: period
//   60 s ± 10 %, one tick at most 60 s and 500 rows). A fresh object per call; nothing reads
//   process.env.
// startAgentSweeper(deps) → {stop()}; throws RangeError unless intervalMs, tickTimeoutMs,
//   maxPerTick and stopTimeoutMs are safe integers ≥ 1 and 0 ≤ jitterRatio < 1 (nothing armed
//   then). Nothing runs synchronously but arming the first 'tick' timer. Timers go only through
//   deps.schedule (default: setTimeout, unref'd, cancel = clearTimeout), each call naming its
//   purpose; the current instant only through deps.clock.
//   - Period: start arms one 'tick' timer with delay round(intervalMs × (1 + jitterRatio × (2r −
//     1))), r = deps.random() (default Math.random) drawn once per 'tick' delay (no other timer
//     draws), so every delay lies in [intervalMs × (1 − jitterRatio), intervalMs × (1 +
//     jitterRatio)]. When a 'tick' timer fires (and the loop is not stopped) it first arms the
//     next 'tick' timer, then runs a tick; the promise returned to the timer resolves when that
//     tick is over (never rejects).
//   - running: a tick fired while another tick of this loop is still running does not run: info
//     or debug 'agent_sweep_skipped' {reason: 'busy'} and nothing else (no connection, no lock).
//     A tick that ended on its time-limit timer is over (see below) even if its last step is
//     still in flight.
//   - A tick: db.connection().execute(c => …) — one pinned connection c for the whole tick; on c
//     `SELECT pg_try_advisory_lock(hashtextextended('agent.sweep', 0))`. false → info or debug
//     'agent_sweep_skipped' {reason: 'locked'}; the tick ends, step never called. Borrowing c
//     failing (db.connection().execute rejects before the callback runs) or the lock query
//     failing → error 'agent_sweep_lock_failed' {stage: 'acquire', error_name}; the tick ends,
//     step never called. true → t0 =
//     deps.clock.now(); a 'tick_timeout' timer of tickTimeoutMs is armed; then the dispatch loop:
//       before EVERY step call, in this order: (1) stop() was called → end; (2) rows handled in
//       this tick (sum of the steps' processed) ≥ maxPerTick → end; (3) deps.clock.now() − t0 ≥
//       tickTimeoutMs → warn 'agent_sweep_tick_timeout' {timeout_ms, processed}, end; (4)
//       `SELECT 1` on the same c fails → error 'agent_sweep_lock_lost' {error_name}, end without
//       unlocking (the backend is gone and PostgreSQL released its lock; another worker may hold
//       it now). Then step.sweepOnce(cursor): resolved → counts are added, cursor = nextCursor;
//       wrapped true ends the tick (the eligible rows are exhausted; the next tick starts from
//       sweepStart()); a rejection → error 'agent_sweep_failed' {error_name}, cursor unchanged,
//       end.
//       The 'tick_timeout' timer firing while a step is in flight ends the tick at once: warn
//       'agent_sweep_tick_timeout' {timeout_ms, processed}; that step is abandoned — the finalize
//       it runs is not interrupted (row locks and conditional writes make it idempotent), its
//       later result or rejection is ignored (never unhandled, cursor unchanged) and NOTHING more
//       is dispatched by this tick, ever.
//     Every end except lock lost: `SELECT pg_advisory_unlock(hashtextextended('agent.sweep', 0))`
//     on the same c, then c goes back to the pool (an unlock failure, e.g. c's backend died after
//     the last step, is only an error line 'agent_sweep_lock_failed' {stage: 'unlock',
//     error_name}, in addition to the tick's own end line). The armed 'tick_timeout' timer is
//     cancelled when the tick ends otherwise (no pending 'tick_timeout' after a normal end).
//     Failure containment: whatever fails — borrowing c, the lock query, a step, `SELECT 1`, the
//     unlock — the promise returned to the 'tick' timer resolves (never rejects, nothing
//     unhandled: with the default setTimeout a rejection would end the worker process) and the
//     running flag is cleared, so the next tick runs as usual.
//     A tick that ended on (1), (2) or wrapped logs info 'agent_sweep_tick' {processed, finalized,
//     skipped_running, skipped_held, failed, wrapped, duration_ms} (sums over its steps; duration
//     = deps.clock.now() at the end − t0). Every tick logs exactly one of 'agent_sweep_skipped',
//     'agent_sweep_tick', 'agent_sweep_tick_timeout', 'agent_sweep_lock_lost', 'agent_sweep_failed'
//     or 'agent_sweep_lock_failed' {stage: 'acquire'} (plus, at most, one unlock failure line
//     {stage: 'unlock'}).
//     The cursor is kept in this process across ticks: sweepStart() at first, then the nextCursor
//     of the last step that resolved in time.
//     Log lines carry counts and error names only (never error messages: they may hold user
//     text). Whatever happens, the next 'tick' timer still fires as usual.
//   - B3-08u (half-open lock connection): a tick waiting on one statement of its pinned
//     connection (borrowing c, the lock query, a `SELECT 1`, the unlock) answers only within TCP
//     retransmission (~15 min) when the connection is half open. Such a wait is a stall; steps
//     never are. When a 'tick' timer fires while the running tick has stalled for at least
//     stallLimit = min(tickTimeoutMs, floor(intervalMs × (1 − jitterRatio))) (≥ 1), the running
//     tick is given up instead of 'busy': error 'agent_sweep_lock_failed' {stage: 'acquire' |
//     'check' | 'unlock', error_name: 'AgentSweepConnectionStalled'} (that tick's only error
//     line), its timer promise resolves, and this tick runs as usual on a newly borrowed
//     connection. Whatever the abandoned tick's connection answers later (a result or a
//     failure) is ignored: no step is dispatched, nothing is logged, the cursor stays (a lock it
//     got late is given back quietly). No extra timer is armed for this.
//   - stop(): idempotent (every call resolves; later calls do nothing more). Cancels the armed
//     'tick' timer; a 'tick' timer that still fires afterwards does nothing; a running tick
//     dispatches no further step (check (1)) and unlocks after its current step; stop() resolves
//     when that tick is over or when a 'stop_timeout' timer of stopTimeoutMs fires, whichever
//     comes first. After stop() no tick starts.
//
// Rules for the implementation: erasable syntax only, `import type` for type-only imports,
// relative imports with `.ts`, no NestJS, no process.env, time only from the injected Clock and
// the injected schedule, data access only through Kysely on deps.db (the lock statements and the
// `SELECT 1` check only).
import type { DB } from '@couli/db';
import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import type { Clock, RootLogger } from '../../../platform/index.ts';
import { sweeperDefaults, sweepStart, type Sweeper } from './index.ts';

export interface AgentSweepLoopConfig {
  /** Mean period between two ticks (T10: 60 s). */
  readonly intervalMs: number;
  /** Uniform jitter of each period, as a ratio of intervalMs (T10: 0.1). */
  readonly jitterRatio: number;
  /** Time limit of one tick, from the lock on (T10: 60 s). */
  readonly tickTimeoutMs: number;
  /** Rows one tick hands to its steps at most (T10: 500). */
  readonly maxPerTick: number;
  /** Upper bound of stop() waiting for a running tick. */
  readonly stopTimeoutMs: number;
}

/** Why the loop asks for a timer. */
export type AgentSweepTimer = 'tick' | 'tick_timeout' | 'stop_timeout';

export interface AgentSweepTimerHandle {
  /** Prevents a call not yet made; harmless after the call. */
  cancel(): void;
}

/**
 * Calls `run` once after `delayMs`. The promise `run` returns resolves when the work started by
 * that call is over (a tick: the end of the tick) and never rejects.
 */
export type AgentSweepSchedule = (
  run: () => Promise<void>,
  delayMs: number,
  timer: AgentSweepTimer,
) => AgentSweepTimerHandle;

export interface AgentSweepLoopDeps {
  /** A sweeper handling at most one row per sweepOnce (createSweeper with maxPerTick 1). */
  readonly step: Sweeper;
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly logger: Pick<RootLogger, 'debug' | 'info' | 'warn' | 'error'>;
  readonly config: AgentSweepLoopConfig;
  /** Default: setTimeout (unref'd). */
  readonly schedule?: AgentSweepSchedule;
  /** Jitter source in [0, 1); default Math.random. */
  readonly random?: () => number;
}

export interface AgentSweepLoop {
  stop(): Promise<void>;
}

export function agentSweepLoopDefaults(): AgentSweepLoopConfig {
  return {
    intervalMs: 60_000,
    jitterRatio: 0.1,
    tickTimeoutMs: 60_000,
    maxPerTick: sweeperDefaults().maxPerTick,
    stopTimeoutMs: 5_000,
  };
}

const defaultSchedule: AgentSweepSchedule = (run, delayMs) => {
  const handle = setTimeout(() => void run(), delayMs);
  handle.unref();
  return { cancel: () => clearTimeout(handle) };
};

type TickEnd =
  | { kind: 'normal' }
  | { kind: 'timeout' }
  | { kind: 'abandoned' }
  | { kind: 'lost' | 'failed'; error: unknown };

/** The statement of the pinned lock connection a tick is waiting on (B3-08u). */
type AbandonStage = 'acquire' | 'check' | 'unlock';

/** One running tick: its stall tracking and the abandonment by a later 'tick' timer (B3-08u). */
interface TickRun {
  abandoned: boolean;
  over: Promise<void>;
  stall(stage: AbandonStage): void;
  flowing(): void;
  stalledFor(now: number, limitMs: number): boolean;
  abandon(): void;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}

export function startAgentSweeper(deps: AgentSweepLoopDeps): AgentSweepLoop {
  const { db, step, clock, logger } = deps;
  const { intervalMs, jitterRatio, tickTimeoutMs, maxPerTick, stopTimeoutMs } = deps.config;
  if (
    [intervalMs, tickTimeoutMs, maxPerTick, stopTimeoutMs].some(
      (value) => !Number.isSafeInteger(value) || value < 1,
    ) ||
    !Number.isFinite(jitterRatio) ||
    jitterRatio < 0 ||
    jitterRatio >= 1
  ) {
    throw new RangeError('Invalid agent sweep loop configuration');
  }
  const schedule = deps.schedule ?? defaultSchedule;
  const random = deps.random ?? Math.random;
  let stopped = false;
  let pendingTick: AgentSweepTimerHandle;
  let running: TickRun | undefined;
  // B3-08u: a tick waiting this long on one statement of its lock connection (borrow, lock,
  // SELECT 1, unlock) is given up by the next 'tick' timer. Steps never count as a stall.
  const stallLimitMs = Math.min(
    tickTimeoutMs,
    Math.max(1, Math.floor(intervalMs * (1 - jitterRatio))),
  );

  function tickRun(): TickRun {
    let stage: AbandonStage | null = null;
    let since = 0;
    let release!: () => void;
    const abandonedOver = new Promise<void>((resolve) => (release = resolve));
    const run: TickRun = {
      abandoned: false,
      over: Promise.resolve(),
      stall(next) {
        stage = next;
        since = clock.now().getTime();
      },
      flowing() {
        stage = null;
      },
      stalledFor(now, limitMs) {
        return !run.abandoned && stage !== null && now - since >= limitMs;
      },
      abandon() {
        if (run.abandoned) return;
        run.abandoned = true;
        logger.error(
          { stage: stage ?? 'acquire', error_name: 'AgentSweepConnectionStalled' },
          'agent_sweep_lock_failed',
        );
        release();
      },
    };
    // A late result of an abandoned tick is ignored; nothing it does can reject this promise.
    run.over = Promise.race([tick(run).catch(() => undefined), abandonedOver]);
    return run;
  }
  let stopping: Promise<void> | undefined;
  let cursor = sweepStart();

  async function tick(run: TickRun): Promise<void> {
    let endLogged = false;
    try {
      run.stall('acquire');
      await db.connection().execute(async (connection) => {
        const { rows } = await sql<{
          pg_try_advisory_lock: boolean;
        }>`SELECT pg_try_advisory_lock(hashtextextended('agent.sweep', 0))`.execute(connection);
        run.flowing();
        if (run.abandoned) {
          // Abandoned while the lock statement hung: give the lock back quietly, dispatch nothing.
          if (rows[0]?.pg_try_advisory_lock === true) {
            await sql`SELECT pg_advisory_unlock(hashtextextended('agent.sweep', 0))`
              .execute(connection)
              .catch(() => undefined);
          }
          return;
        }
        if (rows[0]?.pg_try_advisory_lock !== true) {
          endLogged = true;
          logger.info({ reason: 'locked' }, 'agent_sweep_skipped');
          return;
        }

        const t0 = clock.now().getTime();
        const counts = {
          processed: 0,
          finalized: 0,
          skipped_running: 0,
          skipped_held: 0,
          failed: 0,
          wrapped: false,
        };
        let ended = false;
        let lockLost = false;
        let timeout: AgentSweepTimerHandle | undefined;
        const timedOut = new Promise<TickEnd>((resolve) => {
          timeout = schedule(
            async () => {
              if (ended) return;
              ended = true;
              resolve({ kind: 'timeout' });
            },
            tickTimeoutMs,
            'tick_timeout',
          );
        });

        // Only this function advances the shared cursor. After a timer wins the race, every
        // continuation observes ended before dispatching or accepting a late step result.
        async function dispatch(): Promise<TickEnd> {
          while (!ended) {
            if (stopped || counts.processed >= maxPerTick) return { kind: 'normal' };
            if (clock.now().getTime() - t0 >= tickTimeoutMs) return { kind: 'timeout' };
            try {
              run.stall('check');
              await sql`SELECT 1`.execute(connection);
            } catch (error) {
              if (run.abandoned) return { kind: 'abandoned' };
              return { kind: 'lost', error };
            } finally {
              run.flowing();
            }
            if (run.abandoned) return { kind: 'abandoned' };
            if (ended) return { kind: 'timeout' };
            // A signal or the deadline may have arrived while the connection was checked.
            if (stopped) return { kind: 'normal' };
            if (clock.now().getTime() - t0 >= tickTimeoutMs) return { kind: 'timeout' };
            try {
              const result = await step.sweepOnce(cursor);
              if (run.abandoned) return { kind: 'abandoned' };
              if (ended) return { kind: 'timeout' };
              counts.processed += result.processed;
              counts.finalized += result.finalized;
              counts.skipped_running += result.skipped.running;
              counts.skipped_held += result.skipped.held;
              counts.failed += result.failed;
              counts.wrapped = result.wrapped;
              cursor = result.wrapped ? sweepStart() : result.nextCursor;
              if (result.wrapped) return { kind: 'normal' };
            } catch (error) {
              return { kind: 'failed', error };
            }
          }
          return { kind: 'timeout' };
        }

        try {
          const end = await Promise.race([dispatch(), timedOut]);
          ended = true;
          timeout?.cancel();
          lockLost = end.kind === 'lost';
          endLogged = true;
          if (end.kind === 'abandoned' || run.abandoned) {
            // The abandonment already wrote this tick's one end line.
          } else if (end.kind === 'normal') {
            logger.info({ ...counts, duration_ms: clock.now().getTime() - t0 }, 'agent_sweep_tick');
          } else if (end.kind === 'timeout') {
            logger.warn(
              { timeout_ms: tickTimeoutMs, processed: counts.processed },
              'agent_sweep_tick_timeout',
            );
          } else {
            logger.error(
              { error_name: errorName(end.error) },
              end.kind === 'lost' ? 'agent_sweep_lock_lost' : 'agent_sweep_failed',
            );
          }
        } finally {
          ended = true;
          timeout?.cancel();
          if (!lockLost) {
            try {
              run.stall('unlock');
              await sql`SELECT pg_advisory_unlock(hashtextextended('agent.sweep', 0))`.execute(
                connection,
              );
            } catch (error) {
              if (!run.abandoned) {
                logger.error(
                  { stage: 'unlock', error_name: errorName(error) },
                  'agent_sweep_lock_failed',
                );
              }
            } finally {
              run.flowing();
            }
          }
        }
      });
    } catch (error) {
      if (!endLogged && !run.abandoned) {
        logger.error({ stage: 'acquire', error_name: errorName(error) }, 'agent_sweep_lock_failed');
      }
    } finally {
      run.flowing();
    }
  }

  function armTick(): void {
    const delay = Math.round(intervalMs * (1 + jitterRatio * (2 * random() - 1)));
    pendingTick = schedule(
      async () => {
        if (stopped) return;
        armTick();
        if (running !== undefined) {
          if (!running.stalledFor(clock.now().getTime(), stallLimitMs)) {
            logger.info({ reason: 'busy' }, 'agent_sweep_skipped');
            return;
          }
          // B3-08u: the running tick hangs on a statement of its pinned connection (half-open TCP
          // answers nothing for ~15 min): give it up and start this tick on a new connection.
          running.abandon();
        }
        const run = tickRun();
        running = run;
        try {
          await run.over;
        } finally {
          if (running === run) running = undefined;
        }
      },
      delay,
      'tick',
    );
  }

  armTick();
  return {
    stop(): Promise<void> {
      if (stopping !== undefined) return stopping;
      stopped = true;
      pendingTick.cancel();
      if (running === undefined) {
        stopping = Promise.resolve();
      } else {
        const active = running.over;
        stopping = (async () => {
          let timeout: AgentSweepTimerHandle | undefined;
          const deadline = new Promise<void>((resolve) => {
            timeout = schedule(async () => resolve(), stopTimeoutMs, 'stop_timeout');
          });
          try {
            await Promise.race([active, deadline]);
          } finally {
            timeout?.cancel();
          }
        })();
      }
      return stopping;
    },
  };
}
