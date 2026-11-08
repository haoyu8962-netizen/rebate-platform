// B3-08u fixture (claude-independent; SPEC_REF 29c27a1b; BR-AI-23 细则「谁来收尾」: without a new
// request a worker finalizes left-over runs, so one stuck tick must not stall the sweeper). The
// sweeper loop of apps/api/src/modules/agent/stream/sweeper/loop.ts on a lock connection that goes
// half-open: the peer stops answering and the local side never notices, so a statement sent on it
// neither resolves nor rejects (in production only TCP retransmission ends it, after about 15
// minutes). Own kit; nothing of test/spec/agent/stream-recovery is imported or changed. Pieces:
// - HalfOpenDb: a real Kysely<DB> (Postgres adapter and compiler) on an in-memory driver. Every
//   db.connection().execute(…) borrows a NEW connection (ids 1, 2, …; a connection still stuck in an
//   abandoned tick is never handed out again, as with a pool whose stuck client was never
//   released). Statements are classified by their SQL: 'lock' (pg_try_advisory_lock), 'check'
//   (`SELECT 1`), 'unlock' (pg_advisory_unlock), 'other'. Healthy answers: lock → true, check → 1,
//   unlock → true, other → no rows. A Silence names one connection and the n-th statement of one
//   kind on it: from that statement on, that connection answers nothing at all (that statement and
//   every later one stay pending; Kysely's single-connection queue also keeps later ones waiting).
//   heal('answer') lets the connection come back (pending statements get their healthy answers,
//   later ones answer as usual); heal('fail') is the operating system finally noticing the reset
//   (pending and later statements reject with LATE_FAILURE, a message that must never reach a log).
// - VirtualTime: an AgentSweepSchedule plus the FixedClock of the loop. Each timer is due at the
//   clock instant it was armed + its delay; advance(ms) fires, in due order (ties: arming order),
//   every timer due by now + ms, moving the clock to each due instant. It never awaits the work a
//   timer started (a stuck tick would hang the test): between two timers it only lets the event
//   loop run a bounded number of setImmediate rounds. The timer purpose is taken as an opaque name:
//   the implementation may arm timers of a purpose of its own; only 'tick', 'tick_timeout' and
//   'stop_timeout' carry meaning here.
// - ScriptStep: the one-row sweeper double (Sweeper), answered from a queue (empty → wrapped, no
//   rows), recording each call's cursor and a 'step' event in the same event list as the statements.
// - Logs: a root logger at level trace writing JSON lines to memory.
// No test here ever awaits a promise that a stuck statement could keep pending: a stuck tick shows up
// as an assertion failure (outcome still 'pending', a later tick skipped as busy), never as a hang;
// teardown heals every silent connection so nothing is left pending after a test.
import type { DB } from '@couli/db';
import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type Dialect,
  type QueryResult,
} from 'kysely';
import { expect } from 'vitest';

import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { createRootLogger } from '../../../../apps/api/src/modules/platform/logging/logger.ts';
import type { RootLogger } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  sweepStart,
  type SweepCursor,
  type SweepResult,
  type Sweeper,
} from '../../../../apps/api/src/modules/agent/stream/sweeper/index.ts';
import {
  agentSweepLoopDefaults,
  startAgentSweeper,
  type AgentSweepLoop,
  type AgentSweepLoopConfig,
  type AgentSweepSchedule,
  type AgentSweepTimerHandle,
} from '../../../../apps/api/src/modules/agent/stream/sweeper/loop.ts';

/** 2026-11-08T10:00:00+08:00. */
export const START_MS = Date.parse('2026-11-08T10:00:00+08:00');

/** The rejection of every statement on a connection healed with 'fail' (never to be logged). */
export const LATE_FAILURE = 'fixture: connection reset by peer, 用户原话 13800138000';

export const LEVEL = { debug: 20, info: 30, warn: 40, error: 50 } as const;

/** Lets the event loop run: a bounded number of setImmediate rounds (no timer, no real wait). */
export async function settle(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

// ---- virtual time ---------------------------------------------------------------------------

export type Outcome = 'pending' | 'resolved' | 'rejected' | 'threw';

export interface VTimer {
  readonly seq: number;
  /** The purpose the loop named (opaque here). */
  readonly purpose: string;
  readonly delayMs: number;
  /** Clock instant (epoch ms) at which it is due. */
  readonly dueMs: number;
  readonly run: () => Promise<void>;
  cancelled: boolean;
  fired: boolean;
  /** How the promise returned by run settled (once fired). */
  outcome: Outcome;
}

export class VirtualTime {
  readonly clock: FixedClock;
  readonly timers: VTimer[] = [];
  readonly schedule: AgentSweepSchedule = (run, delayMs, timer): AgentSweepTimerHandle => {
    const entry: VTimer = {
      seq: this.timers.length,
      purpose: timer,
      delayMs,
      dueMs: this.nowMs() + delayMs,
      run,
      cancelled: false,
      fired: false,
      outcome: 'pending',
    };
    this.timers.push(entry);
    return {
      cancel: () => {
        entry.cancelled = true;
      },
    };
  };

  constructor(startMs: number) {
    this.clock = new FixedClock(new Date(startMs));
  }

  nowMs(): number {
    return this.clock.now().getTime();
  }

  /** Armed, not cancelled and not fired yet (of one purpose when given). */
  pending(purpose?: string): VTimer[] {
    return this.timers.filter(
      (t) => !t.cancelled && !t.fired && (purpose === undefined || t.purpose === purpose),
    );
  }

  /** Fired timers of one purpose, in firing order. */
  fired(purpose: string): VTimer[] {
    return this.timers.filter((t) => t.fired && t.purpose === purpose);
  }

  /**
   * Fires every timer due by now + ms (including timers armed meanwhile), earliest first, moving
   * the clock to each due instant and finally to now + ms. Never awaits the work a timer started.
   */
  async advance(ms: number): Promise<void> {
    await settle();
    const target = this.nowMs() + ms;
    for (let guard = 0; ; guard += 1) {
      if (guard >= 10_000) expect.fail('runaway timers: more than 10 000 fired in one advance');
      const next = this.pending()
        .filter((t) => t.dueMs <= target)
        .sort((a, b) => a.dueMs - b.dueMs || a.seq - b.seq)[0];
      if (next === undefined) break;
      if (next.dueMs > this.nowMs()) this.clock.set(new Date(next.dueMs));
      this.#fire(next);
      await settle();
    }
    if (target > this.nowMs()) this.clock.set(new Date(target));
    await settle();
  }

  #fire(entry: VTimer): void {
    entry.fired = true;
    let work: Promise<void>;
    try {
      work = entry.run();
    } catch {
      entry.outcome = 'threw';
      return;
    }
    void Promise.resolve(work).then(
      () => {
        entry.outcome = 'resolved';
      },
      () => {
        entry.outcome = 'rejected';
      },
    );
  }
}

// ---- half-open database ---------------------------------------------------------------------

export type Kind = 'lock' | 'check' | 'unlock' | 'other';

export function kindOf(text: string): Kind {
  if (/pg_try_advisory_lock/i.test(text)) return 'lock';
  if (/pg_advisory_unlock/i.test(text)) return 'unlock';
  if (/^\s*select\s+1\b/i.test(text)) return 'check';
  return 'other';
}

/** From the nth statement of `kind` on connection `connection` (1-based) on, nothing answers. */
export interface Silence {
  readonly connection: number;
  readonly kind: Exclude<Kind, 'other'>;
  readonly nth: number;
}

interface Hung {
  readonly kind: Kind;
  resolve(result: QueryResult<unknown>): void;
  reject(error: unknown): void;
}

export type LineState = 'healthy' | 'silent' | 'healed' | 'dead';

export interface Line {
  readonly id: number;
  state: LineState;
  readonly hung: Hung[];
  readonly counts: Record<Kind, number>;
  released: boolean;
}

function healthyAnswer(kind: Kind): QueryResult<unknown> {
  switch (kind) {
    case 'lock':
      return { rows: [{ pg_try_advisory_lock: true }] };
    case 'unlock':
      return { rows: [{ pg_advisory_unlock: true }] };
    case 'check':
      return { rows: [{ '?column?': 1 }] };
    default:
      return { rows: [] };
  }
}

export class HalfOpenDb {
  readonly db: Kysely<DB>;
  /** Every borrowed connection, in borrowing order (lines[i].id === i + 1). */
  readonly lines: Line[] = [];
  readonly #events: string[];
  readonly #silence: Silence | null;
  readonly #byConnection = new Map<DatabaseConnection, Line>();

  constructor(events: string[], silence: Silence | null) {
    this.#events = events;
    this.#silence = silence;
    const dialect: Dialect = {
      createAdapter: () => new PostgresAdapter(),
      createQueryCompiler: () => new PostgresQueryCompiler(),
      createIntrospector: (db) => new PostgresIntrospector(db),
      createDriver: () => ({
        init: () => Promise.resolve(),
        acquireConnection: () => Promise.resolve(this.#open()),
        beginTransaction: () => Promise.resolve(),
        commitTransaction: () => Promise.resolve(),
        rollbackTransaction: () => Promise.resolve(),
        releaseConnection: (connection: DatabaseConnection) => {
          const line = this.#byConnection.get(connection);
          if (line !== undefined) line.released = true;
          return Promise.resolve();
        },
        destroy: () => Promise.resolve(),
      }),
    };
    this.db = new Kysely<DB>({ dialect });
  }

  /** The connection that went silent (and has not been healed), if any. */
  silentLine(): Line | undefined {
    return this.lines.find((line) => line.state === 'silent');
  }

  /**
   * The silent connection comes back ('answer') or is finally seen as reset ('fail'): its pending
   * statements settle at once, in sending order. Returns how many were pending.
   */
  heal(mode: 'answer' | 'fail'): number {
    const line = this.silentLine();
    expect(line, 'a silent connection to heal').toBeDefined();
    return this.#heal(line!, mode);
  }

  /** Heals every connection still silent (teardown). */
  healAll(mode: 'answer' | 'fail'): void {
    for (const line of this.lines) if (line.state === 'silent') this.#heal(line, mode);
  }

  #heal(line: Line, mode: 'answer' | 'fail'): number {
    line.state = mode === 'answer' ? 'healed' : 'dead';
    const hung = line.hung.splice(0);
    for (const h of hung) {
      if (mode === 'answer') h.resolve(healthyAnswer(h.kind));
      else h.reject(new Error(LATE_FAILURE));
    }
    return hung.length;
  }

  #open(): DatabaseConnection {
    const line: Line = {
      id: this.lines.length + 1,
      state: 'healthy',
      hung: [],
      counts: { lock: 0, check: 0, unlock: 0, other: 0 },
      released: false,
    };
    this.lines.push(line);
    const connection: DatabaseConnection = {
      executeQuery: <R>(compiled: CompiledQuery): Promise<QueryResult<R>> =>
        this.#answer(line, compiled) as Promise<QueryResult<R>>,
      streamQuery: <R>(): AsyncIterableIterator<QueryResult<R>> => {
        throw new Error('fixture: no streaming');
      },
    };
    this.#byConnection.set(connection, line);
    return connection;
  }

  #answer(line: Line, compiled: CompiledQuery): Promise<QueryResult<unknown>> {
    const kind = kindOf(compiled.sql);
    line.counts[kind] += 1;
    this.#events.push(`c${String(line.id)}:${kind}`);
    const s = this.#silence;
    if (
      line.state === 'healthy' &&
      s !== null &&
      s.connection === line.id &&
      s.kind === kind &&
      s.nth === line.counts[kind]
    ) {
      line.state = 'silent';
    }
    if (line.state === 'silent') {
      return new Promise<QueryResult<unknown>>((resolve, reject) => {
        line.hung.push({ kind, resolve, reject });
      });
    }
    if (line.state === 'dead') return Promise.reject(new Error(LATE_FAILURE));
    return Promise.resolve(healthyAnswer(kind));
  }
}

// ---- sweeper double -------------------------------------------------------------------------

export function cursorAt(n: number): SweepCursor {
  return {
    lockExpiresAt: new Date(START_MS - 60_000 + n * 1_000),
    sessionId: `0190a000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`,
  };
}

/** One row handled by the one-row sweeper ('final': finalized, 'running': skipped as running). */
export function one(n: number, kind: 'final' | 'running' = 'final'): SweepResult {
  return {
    processed: 1,
    finalized: kind === 'final' ? 1 : 0,
    skipped: { running: kind === 'running' ? 1 : 0, held: 0 },
    failed: 0,
    nextCursor: cursorAt(n),
    wrapped: false,
  };
}

/** Nothing left from this cursor: back to the start. */
export function done(): SweepResult {
  return {
    processed: 0,
    finalized: 0,
    skipped: { running: 0, held: 0 },
    failed: 0,
    nextCursor: sweepStart(),
    wrapped: true,
  };
}

export class ScriptStep implements Sweeper {
  readonly cursors: SweepCursor[] = [];
  /** Clock time each call takes (the clock is advanced before it answers). */
  costMs = 0;
  readonly #events: string[];
  readonly #answers: SweepResult[];
  readonly #clock: FixedClock;

  constructor(events: string[], clock: FixedClock, answers: readonly SweepResult[]) {
    this.#events = events;
    this.#clock = clock;
    this.#answers = [...answers];
  }

  feed(...answers: SweepResult[]): void {
    this.#answers.push(...answers);
  }

  sweepOnce(cursor: SweepCursor): Promise<SweepResult> {
    this.cursors.push(cursor);
    this.#events.push('step');
    if (this.costMs > 0) this.#clock.advanceMs(this.costMs);
    return Promise.resolve(this.#answers.shift() ?? done());
  }
}

// ---- logs -----------------------------------------------------------------------------------

export interface LogLine {
  readonly level: number;
  readonly msg: string;
  readonly [field: string]: unknown;
}

const LOGGER_OPTIONS = { level: 'trace', entry: 'worker', appEnv: 'test' } as const;

export class Logs {
  readonly lines: string[] = [];
  readonly logger: RootLogger = createRootLogger(LOGGER_OPTIONS, {
    write: (line: string) => void this.lines.push(line),
  });
  all(): LogLine[] {
    return this.lines.map((line) => JSON.parse(line) as LogLine);
  }
  of(msg: string): LogLine[] {
    return this.all().filter((line) => line.msg === msg);
  }
}

/** The fields every line of the root logger carries (level, msg, time, the bound entry …). */
export function baseFields(): Set<string> {
  const lines: string[] = [];
  const probe = createRootLogger(LOGGER_OPTIONS, {
    write: (line: string) => void lines.push(line),
  });
  probe.info('probe');
  expect(lines, 'probe line').toHaveLength(1);
  return new Set(Object.keys(JSON.parse(lines[0]!) as Record<string, unknown>));
}

// ---- unhandled rejections -------------------------------------------------------------------

export interface UnhandledWatch {
  readonly reasons: unknown[];
  dispose(): void;
}

export function watchUnhandled(): UnhandledWatch {
  const reasons: unknown[] = [];
  const onRejection = (reason: unknown): void => {
    reasons.push(reason);
  };
  process.on('unhandledRejection', onRejection);
  return {
    reasons,
    dispose: () => {
      process.off('unhandledRejection', onRejection);
    },
  };
}

// ---- the rig --------------------------------------------------------------------------------

export interface Rig {
  readonly time: VirtualTime;
  readonly half: HalfOpenDb;
  readonly step: ScriptStep;
  readonly logs: Logs;
  /** Statements ('c<id>:<kind>') and step calls ('step'), in order. */
  readonly events: string[];
  readonly config: AgentSweepLoopConfig;
  readonly loop: AgentSweepLoop;
}

/**
 * The loop on a HalfOpenDb with virtual time. Config: the defaults (including any optional field
 * the implementation adds, e.g. an upper bound of the waits on the lock connection), no jitter,
 * period 3 × tickTimeoutMs, then `config`.
 */
export function rig(options: {
  readonly silence: Silence | null;
  readonly config?: Partial<AgentSweepLoopConfig>;
  readonly answers?: readonly SweepResult[];
}): Rig {
  const time = new VirtualTime(START_MS);
  const events: string[] = [];
  const half = new HalfOpenDb(events, options.silence);
  const step = new ScriptStep(events, time.clock, options.answers ?? []);
  const logs = new Logs();
  const defaults = agentSweepLoopDefaults();
  const config: AgentSweepLoopConfig = {
    ...defaults,
    jitterRatio: 0,
    intervalMs: 3 * defaults.tickTimeoutMs,
    ...options.config,
  };
  const loop = startAgentSweeper({
    step,
    db: half.db,
    clock: time.clock,
    logger: logs.logger,
    config,
    schedule: time.schedule,
    random: () => 0.5,
  });
  return { time, half, step, logs, events, config, loop };
}

/** Where a rig stood before a tick: to look only at what that tick did. */
export interface Mark {
  readonly timers: number;
  readonly events: number;
  readonly lines: number;
  readonly connections: number;
  readonly cursors: number;
}

export function mark(r: Rig): Mark {
  return {
    timers: r.time.timers.length,
    events: r.events.length,
    lines: r.logs.lines.length,
    connections: r.half.lines.length,
    cursors: r.step.cursors.length,
  };
}

/**
 * Heals every silent connection, stops the loop and lets its stop_timeout fire; bounded (never
 * awaits the loop's promises).
 */
export async function teardown(r: Rig): Promise<void> {
  r.half.healAll('answer');
  await settle();
  void r.loop.stop().catch(() => undefined);
  await r.time.advance(r.config.stopTimeoutMs);
  await settle();
}
