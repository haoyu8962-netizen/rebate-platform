// B3-08y · BR-AI-19「TraceWriter 写入失败时进本地重试队列，最多重试 24 小时，仍失败记告警
// agent.trace_lost，不得静默丢弃」, BR-AI-22 (no trace written back into a session already detached
// from its user). Rule tests: test/spec/agent/trace-retry/** (they import this file by path: names,
// signatures and the semantics written here are the contract).
// B3-08zc (BR-AI-19 细则「助手回复落库」, D10-1297): the stream runtime no longer hands cards to this
// queue (they are written with the run's terminal state) and nothing reads its pending cards any
// more: withPendingCards / processPendingCards / sharePendingCards are gone, card references read
// committed agent_cards only. The queue itself still writes a record's cards when given some.
// B3-08zh (D10-1522, [AC-B3-08zh#1]): pendingCard / PendingCardSource are retired too — there is
// no in-process pending card any more; card references read committed data only.
//
// traceRedoDefaults(): a fresh {maxRuns: 5000, firstDelayMs: 1000, maxDelayMs: 300000,
//   windowMs: 86400000} (agent's own injectable defaults, like runTimingsDefaults; not a content
//   config key).
// createTraceRedoQueue(deps): TraceRedoQueue — one per stream runtime, nothing running at build.
//   persist(record): writes the run's tool calls (when any) and cards (when any) through
//     deps.writer, apart from the stream; resolves once that first attempt settled (written,
//     skipped, queued or lost); never rejects (a writer throwing synchronously is a failed write).
//     A half that failed with a transient error is queued with its run (one entry per run; only the
//     failed half is written again; the writes are idempotent by their unique keys).
//     First failure: exactly ONE warn line `agent_trace_write_failed` {run_id, error_name}; later
//     failures of the same run log at debug only.
//     Permanent errors are never written again and are lost at once (reason 'rejected'): the
//     writer's own checks (run not found in this app / session, invalid card_id) and PG errors whose
//     SQLSTATE (error.code) is of class 22, 23 or 42. Anything else is transient.
//     A half the writer answers 'skipped' (the session is detached from its user, BR-AI-22) is done:
//     not written again, not lost; one info line `agent_trace_skipped_erased` {run_id} per run.
//   Backoff: the n-th write again of a run comes firstDelayMs·2^(n−1) after the previous attempt,
//     capped at maxDelayMs (1 s, 2 s, 4 s, … 5 min); time only from deps.clock / deps.scheduler (the
//     runtime's; real timers unref'd). The window ends windowMs after the run's first failure: no
//     attempt after it; a run still unwritten then is lost (reason 'expired').
//     Deadline boundary (B3-08y review S1): deadline = deps.clock.now() at the first failure +
//     windowMs, and before EVERY write again (a timer firing, or close()'s last write) the queue
//     reads deps.clock.now() again: now ≥ deadline (exactly equal counts as expired) → the writer
//     is not called and the run is lost 'expired' (one line, one onLost('expired')). A timer that
//     fires a few ms late therefore never writes after the window; close() loses such a run as
//     'expired', not 'shutdown'.
//     B3-08y review S1 (r2): the deadline's start is the moment the run's FIRST half failed (set when
//     that half fails, not when the other half settles). From then each run has its own deadline
//     timer (deps.scheduler, unref'd in production, cancelled when the run is written, skipped or
//     lost and at close()): at the deadline the run is lost 'expired' (one line, one onLost) even
//     while a write is in flight; whatever that write returns later is dropped (one debug line
//     `agent_trace_result_after_lost`), never counted as written and never lost again.
//   Overflow: at most maxRuns runs are queued; a new one beyond that drops the OLDEST queued run
//     (lost, reason 'overflow') and is queued itself.
//   Lost: exactly one error line `agent.trace_lost` {run_id, reason: expired|rejected|overflow|
//     shutdown, cards, tool_calls} per lost run, where cards / tool_calls are the numbers of that
//     run's cards / tool calls left unwritten (a written half counts 0); no card, data, argument,
//     user text or fallback text; and one call deps.onLost(reason) (default: nothing).
//   queued(): the number of runs waiting to be written again.
//   close(boundMs): stops every timer, makes one last attempt for each queued run (and waits for
//     first attempts in flight), all bounded by boundMs on deps.scheduler; whatever is still
//     unwritten then is lost (reason 'shutdown'). Resolves within boundMs; after it the writer is
//     never called again by a timer. With nothing queued or in flight it resolves at once.
// The writer: createPgAgentTraceWriter (agent/store/results) locks the run's session row
//   (FOR SHARE, exclusive with the deletion purge's FOR NO KEY UPDATE) in the write's transaction;
//   a session detached from its user (user_id NULL with user_hash set) makes the write resolve
//   'skipped' and write nothing; a guest session (no user_hash) is written as before.
import type { Clock, RootLogger, Scheduler } from '../../../platform/index.ts';
import {
  AgentTraceRejected,
  isTraceSkipped,
  type ToolCallRecord,
} from '../../store/results/index.ts';
import type { CardInput } from '../writer/index.ts';

export type TraceLostReason = 'expired' | 'rejected' | 'overflow' | 'shutdown';

/** What one write resolves: done (nothing or 'written') or 'skipped' (session detached). */
export type TraceWriteOutcome = void | 'written' | 'skipped';

/** createPgAgentTraceWriter's shape as the queue uses it (AgentTraceWriter fits). */
export interface RedoTraceWriter {
  recordCards(
    appId: string,
    sessionId: string,
    runId: string,
    cards: readonly CardInput[],
  ): Promise<TraceWriteOutcome>;
  recordToolCalls(
    appId: string,
    runId: string,
    calls: readonly ToolCallRecord[],
  ): Promise<TraceWriteOutcome>;
}

export interface TraceRedoParams {
  /** Runs queued at most (default 5000). */
  readonly maxRuns: number;
  /** Delay before the first write again (default 1000 ms); doubled after each failure. */
  readonly firstDelayMs: number;
  /** Upper bound of one delay (default 300000 ms). */
  readonly maxDelayMs: number;
  /** From a run's first failure to its last possible attempt (default 86400000 ms). */
  readonly windowMs: number;
}

/** One run's trace in stored form (server-side app / session / run only, BR-AI-03). */
export interface RunTraceRecord {
  readonly appId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly cards: readonly CardInput[];
  readonly toolCalls: readonly ToolCallRecord[];
}

export interface TraceRedoQueueDeps {
  readonly writer: RedoTraceWriter;
  readonly clock: Clock;
  readonly scheduler: Scheduler;
  readonly logger: Pick<RootLogger, 'debug' | 'info' | 'warn' | 'error'>;
  /** traceRedoDefaults() when absent. */
  readonly params?: TraceRedoParams;
  /** Called once per lost run; nothing by default. */
  readonly onLost?: (reason: TraceLostReason) => void;
}

export interface TraceRedoQueue {
  persist(record: RunTraceRecord): Promise<void>;
  queued(): number;
  close(boundMs: number): Promise<void>;
}

/** The one warn line of a run's first failed trace write (B3-08q, kept). */
export const TRACE_WRITE_FAILED = 'agent_trace_write_failed';
/** The error line of a run whose trace is given up (BR-AI-19 告警 agent.trace_lost). */
export const TRACE_LOST = 'agent.trace_lost';
/** The info line of a run whose session was detached from its user (BR-AI-22). */
export const TRACE_SKIPPED_ERASED = 'agent_trace_skipped_erased';
/** The debug line of a later failed write of a run already queued. */
const TRACE_WRITE_FAILED_AGAIN = 'agent_trace_write_failed_again';

export function traceRedoDefaults(): TraceRedoParams {
  return { maxRuns: 5_000, firstDelayMs: 1_000, maxDelayMs: 300_000, windowMs: 86_400_000 };
}

/** SQLSTATE classes writing again cannot cure: data exception, integrity, syntax / access rule. */
const PERMANENT_SQLSTATE = /^(?:22|23|42)[0-9A-Z]{3}$/u;

function isPermanent(error: unknown): boolean {
  if (error instanceof AgentTraceRejected) return true;
  if (error === null || typeof error !== 'object') return false;
  if ((error as { name?: unknown }).name === 'AgentTraceRejected') return true;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && PERMANENT_SQLSTATE.test(code);
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/** One run in the queue (or in its first attempt). */
interface RedoEntry {
  readonly record: RunTraceRecord;
  /** The half still to be written. */
  cardsLeft: boolean;
  toolsLeft: boolean;
  /** Failed attempts so far. */
  failures: number;
  /** clock ms from which no attempt is made (first failure + windowMs; equal is expired). */
  deadline: number | undefined;
  phase: 'first' | 'queued' | 'over';
  attempt: Promise<void> | undefined;
  timer: AbortController | undefined;
  /** The run's own deadline timer (armed at its first failed half). */
  deadlineTimer: AbortController | undefined;
  skipLogged: boolean;
}

/** The debug line of a write that returned after its run was already lost. */
const TRACE_RESULT_AFTER_LOST = 'agent_trace_result_after_lost';

type HalfResult =
  | { readonly ok: true; readonly skipped: boolean }
  | { readonly ok: false; readonly error: unknown };

async function half(call: () => Promise<unknown>): Promise<HalfResult> {
  try {
    // A writer throwing synchronously lands here too: a failed write like a rejection.
    return { ok: true, skipped: isTraceSkipped(await call()) };
  } catch (error) {
    return { ok: false, error };
  }
}

export function createTraceRedoQueue(deps: TraceRedoQueueDeps): TraceRedoQueue {
  const params = deps.params ?? traceRedoDefaults();
  const { logger, scheduler } = deps;
  /** Queued runs, oldest first (Set keeps insertion order). */
  const queue = new Set<RedoEntry>();
  /** Runs whose first attempt is in flight. */
  const firsts = new Set<RedoEntry>();
  let closed = false;
  let closing: Promise<void> | undefined;

  function finish(entry: RedoEntry): void {
    entry.phase = 'over';
    queue.delete(entry);
    firsts.delete(entry);
    entry.timer?.abort();
    entry.timer = undefined;
    entry.deadlineTimer?.abort();
    entry.deadlineTimer = undefined;
  }

  function lose(entry: RedoEntry, reason: TraceLostReason): void {
    if (entry.phase === 'over') return;
    const cards = entry.cardsLeft ? entry.record.cards.length : 0;
    const toolCalls = entry.toolsLeft ? entry.record.toolCalls.length : 0;
    finish(entry);
    // Counts only: no card, data, argument, user text or fallback text.
    logger.error({ run_id: entry.record.runId, reason, cards, tool_calls: toolCalls }, TRACE_LOST);
    try {
      deps.onLost?.(reason);
    } catch {
      // A failing hook never stops the queue.
    }
  }

  function enqueue(entry: RedoEntry): void {
    firsts.delete(entry);
    entry.phase = 'queued';
    while (queue.size >= Math.max(1, params.maxRuns)) {
      const oldest = queue.values().next().value;
      if (oldest === undefined) break;
      lose(oldest, 'overflow');
    }
    queue.add(entry);
  }

  function nowMs(): number {
    return deps.clock.now().getTime();
  }

  /** Before a write again: past (or exactly at) the deadline → lost 'expired', no write. */
  function expiredNow(entry: RedoEntry): boolean {
    if (entry.deadline === undefined || nowMs() < entry.deadline) return false;
    lose(entry, 'expired');
    return true;
  }

  /** A half failed: the first one starts the run's window and its own deadline timer. */
  function failedHalf(entry: RedoEntry): void {
    if (entry.phase === 'over' || entry.deadline !== undefined) return;
    const deadline = nowMs() + params.windowMs;
    entry.deadline = deadline;
    const timer = new AbortController();
    entry.deadlineTimer = timer;
    const wait = (): void => {
      scheduler.sleep(Math.max(0, deadline - nowMs()), timer.signal).then(
        () => {
          if (entry.deadlineTimer !== timer || entry.phase === 'over') return;
          // The clock decides; a scheduler running ahead of it waits the rest.
          if (nowMs() < deadline) {
            wait();
            return;
          }
          lose(entry, 'expired');
        },
        () => undefined,
      );
    };
    wait();
  }

  function schedule(entry: RedoEntry): void {
    const remaining = (entry.deadline ?? 0) - nowMs();
    if (remaining <= 0) {
      lose(entry, 'expired');
      return;
    }
    const delay = Math.min(params.maxDelayMs, params.firstDelayMs * 2 ** (entry.failures - 1));
    const timer = new AbortController();
    entry.timer = timer;
    // The last attempt falls on the end of the window at the latest, never after it.
    scheduler.sleep(Math.min(delay, remaining), timer.signal).then(
      () => {
        if (entry.timer === timer) entry.timer = undefined;
        if (entry.phase !== 'queued' || closed) return;
        if (expiredNow(entry)) return;
        void write(entry);
      },
      () => undefined,
    );
  }

  function settle(
    entry: RedoEntry,
    results: readonly (readonly ['cards' | 'tools', HalfResult])[],
  ) {
    if (entry.phase === 'over') {
      // Lost already (deadline, overflow or shutdown): the late result is dropped.
      logger.debug({ run_id: entry.record.runId }, TRACE_RESULT_AFTER_LOST);
      return;
    }
    let failure: { error: unknown } | undefined;
    let permanent = false;
    let skipped = false;
    for (const [which, result] of results) {
      if (result.ok) {
        if (which === 'cards') entry.cardsLeft = false;
        else entry.toolsLeft = false;
        skipped ||= result.skipped;
      } else {
        failure ??= { error: result.error };
        permanent ||= isPermanent(result.error);
      }
    }
    if (skipped && !entry.skipLogged) {
      entry.skipLogged = true;
      logger.info({ run_id: entry.record.runId }, TRACE_SKIPPED_ERASED);
    }
    if (failure === undefined) {
      finish(entry);
      return;
    }
    const fields = { run_id: entry.record.runId, error_name: errorName(failure.error) };
    if (entry.failures === 0) logger.warn(fields, TRACE_WRITE_FAILED);
    else logger.debug(fields, TRACE_WRITE_FAILED_AGAIN);
    entry.failures += 1;
    failedHalf(entry);
    if (permanent) {
      lose(entry, 'rejected');
      return;
    }
    if (closed) {
      lose(entry, 'shutdown');
      return;
    }
    if (entry.phase === 'first') enqueue(entry);
    schedule(entry);
  }

  /** One attempt of the halves still left; never rejects. */
  function write(entry: RedoEntry): Promise<void> {
    const { appId, sessionId, runId, cards, toolCalls } = entry.record;
    const halves: Promise<readonly ['cards' | 'tools', HalfResult]>[] = [];
    if (entry.toolsLeft) {
      halves.push(
        half(() => deps.writer.recordToolCalls(appId, runId, toolCalls)).then((result) => {
          if (!result.ok) failedHalf(entry);
          return ['tools', result] as const;
        }),
      );
    }
    if (entry.cardsLeft) {
      halves.push(
        half(() => deps.writer.recordCards(appId, sessionId, runId, cards)).then((result) => {
          if (!result.ok) failedHalf(entry);
          return ['cards', result] as const;
        }),
      );
    }
    const attempt = Promise.all(halves)
      .then((results) => settle(entry, results))
      .catch(() => undefined)
      .finally(() => {
        if (entry.attempt === attempt) entry.attempt = undefined;
      });
    entry.attempt = attempt;
    return attempt;
  }

  return {
    async persist(record) {
      if (record.cards.length === 0 && record.toolCalls.length === 0) return;
      const entry: RedoEntry = {
        record,
        cardsLeft: record.cards.length > 0,
        toolsLeft: record.toolCalls.length > 0,
        failures: 0,
        deadline: undefined,
        phase: 'first',
        attempt: undefined,
        timer: undefined,
        deadlineTimer: undefined,
        skipLogged: false,
      };
      firsts.add(entry);
      await write(entry);
    },

    queued() {
      return queue.size;
    },

    close(boundMs) {
      closed = true;
      closing ??= (async () => {
        const attempts: Promise<void>[] = [];
        for (const entry of [...queue]) {
          entry.timer?.abort();
          entry.timer = undefined;
          if (entry.attempt !== undefined) {
            attempts.push(entry.attempt);
          } else if (!expiredNow(entry)) {
            // One last attempt at once, only while the run's window is open.
            attempts.push(write(entry));
          }
        }
        for (const entry of firsts) if (entry.attempt !== undefined) attempts.push(entry.attempt);
        if (attempts.length === 0) return;
        const bound = new AbortController();
        try {
          await Promise.race([
            Promise.allSettled(attempts),
            scheduler.sleep(boundMs, bound.signal).catch(() => undefined),
          ]);
        } finally {
          bound.abort();
        }
        for (const entry of [...firsts, ...queue]) lose(entry, 'shutdown');
      })();
      return closing;
    },
  };
}

/**
 * The system scheduler with unref'd timers: a queued write never keeps the process alive. Used by
 * the stream runtime when it has no scheduler seam.
 */
export function unrefScheduler(): Scheduler {
  return {
    now: () => performance.now(),
    sleep(ms, signal) {
      return new Promise<void>((resolve, reject) => {
        if (signal?.aborted === true) {
          reject(signal.reason);
          return;
        }
        const started = performance.now();
        const duration = Number.isNaN(ms) ? 0 : Math.max(0, ms);
        let timer: ReturnType<typeof setTimeout> | undefined;
        const cancel = (): void => {
          clearTimeout(timer);
          reject(signal?.reason);
        };
        const tick = (): void => {
          const remaining = duration - (performance.now() - started);
          if (remaining > 0) {
            timer = setTimeout(tick, Math.min(2_147_483_647, Math.ceil(remaining)));
            timer.unref();
            return;
          }
          signal?.removeEventListener('abort', cancel);
          resolve();
        };
        signal?.addEventListener('abort', cancel, { once: true });
        tick();
      });
    },
  };
}
