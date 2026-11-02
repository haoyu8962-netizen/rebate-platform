// B2-15q rule test (claude-independent, D10-553; review r1): the ticks of the interval. After the
// first seconds of a worker's life the interval ticks are the only ticks there are, so a stop waits
// for them as it does for the seed timer's tick. ticks.test.ts and handshake.int.test.ts hold that
// first tick only, on gates that open once; those files are frozen at spec_commit, so the gate that
// can shut again lives here (`latchedDb`, same pool shape as kit.ts gatedDb).
//
// #8 and #10: the tick held is one the interval started, after earlier ticks have ended: an
// implementation that tracks the seed timer's tick alone has nothing left to wait for. #9 and #10:
// the interval comes due while a tick is held: `inFlight = tick()` at the interval's call site, with
// a tick that returns early while one runs, overwrites the promise of the tick still running. #11:
// the same on a failed tick, and a failed tick does not stop the next one.
//
// A tick is one or two statements, so the gate only shuts between two ticks (`firstTickEnded` and
// the drains after an opened gate: with no gate every statement ends in microtasks). Every test is
// red on the old modules at `stop.outcome()`, because their stop returns at once. Fake module timers
// and bounded waits as in ticks.test.ts. Top-level it() only (规划/11 §4.3).
//
// B2-15s (FU-TICK-STOP-BOUND) changed #8: a stop now waits for the tick in flight 800 ms at most, so
// #8 pins the bound where it pinned a wait without end. Its 799 and 1 stay inside the test: any
// change outside the test blocks would judge the whole file (tools/guard/lib/test-blocks.ts).
import { createDb, type DB } from '@couli/db';
import type { Kysely, PostgresPool } from 'kysely';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  LOAD_TIMEOUT_MS,
  TIMERS,
  deferred,
  drain,
  fakeModuleTimers,
  fixedClock,
  idleQueue,
  loadTargets,
  recordingLogger,
  stopping,
  syntheticError,
  type Lifecycle,
  type LogLine,
  type Target,
  type TimerName,
} from './kit.ts';

let targets: Record<TimerName, Target>;

beforeAll(async () => {
  targets = await loadTargets();
}, LOAD_TIMEOUT_MS);

beforeEach(() => {
  fakeModuleTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

interface LatchedDb {
  readonly db: Kysely<DB>;
  /** Connections asked for so far: one per statement of a tick. */
  connects(): number;
  /** Connections asked for and held at the gate. */
  waiting(): number;
  /** Shuts the gate: the next connects wait at it. */
  close(): void;
  /** Answers the held connects with an empty result; the gate stays open until closed again. */
  open(): void;
  /** Rejects the held connects with `error`; the gate stays open until closed again. */
  fail(error: Error): void;
}

interface Gate {
  readonly passed: ReturnType<typeof deferred>;
  failure: Error | null;
}

/** createDb over a pool without connections whose gate starts open and can shut again. */
function latchedDb(): LatchedDb {
  let gate: Gate | null = null;
  let connects = 0;
  let waiting = 0;
  const client = {
    query: async () => ({ command: 'SELECT', rowCount: 0, rows: [] }),
    release: () => undefined,
  };
  const pool = {
    options: {},
    connect: async () => {
      connects += 1;
      const held = gate;
      if (held === null) return client;
      waiting += 1;
      await held.passed.promise;
      waiting -= 1;
      if (held.failure !== null) throw held.failure;
      return client;
    },
    end: async () => undefined,
  };
  const pass = (failure: Error | null): void => {
    if (gate === null) return;
    gate.failure = failure;
    gate.passed.resolve();
    gate = null;
  };
  return {
    db: createDb({ poolFactory: () => pool as unknown as PostgresPool }),
    connects: () => connects,
    waiting: () => waiting,
    close: () => {
      gate ??= { passed: deferred(), failure: null };
    },
    open: () => {
      pass(null);
    },
    fail: (error) => {
      pass(error);
    },
  };
}

interface LatchedRig {
  readonly timer: Lifecycle;
  readonly pool: LatchedDb;
  warnings(): LogLine[];
}

function latchedRig(target: Target): LatchedRig {
  const pool = latchedDb();
  const { logger, warnings } = recordingLogger();
  const timer = target.build({
    db: pool.db,
    clock: fixedClock(),
    queue: idleQueue(),
    logger,
  });
  return { timer, pool, warnings };
}

/** Bootstraps a timer and lets its first tick run to its end with the gate open. */
async function firstTickEnded(target: Target): Promise<LatchedRig> {
  const rig = latchedRig(target);
  rig.timer.onApplicationBootstrap();
  vi.advanceTimersByTime(target.seedDelayMs);
  await drain();
  expect(rig.pool.connects(), 'fixture: the first tick ran').toBeGreaterThan(0);
  expect(rig.pool.waiting(), 'fixture: the first tick ended').toBe(0);
  return rig;
}

/** Shuts the gate between two ticks and lets the interval start the next tick, held at the pool. */
async function nextTickHeld(rig: LatchedRig, target: Target): Promise<void> {
  rig.pool.close();
  vi.advanceTimersByTime(target.healIntervalMs);
  await drain();
  expect(rig.pool.waiting(), 'the interval tick did not start').toBe(1);
}

it.each(TIMERS)(
  '[AC-B2-15q#8] %s：首个 tick 已结束，interval 起的 tick 在途时 onModuleDestroy 最多等 800 毫秒上限（799 毫秒时未返回，800 毫秒时返回），期间和之后都不再起新 tick',
  async (name) => {
    const target = targets[name];
    const rig = await firstTickEnded(target);
    await nextTickHeld(rig, target);

    const stop = stopping(rig.timer);
    await drain();
    expect(stop.outcome(), 'the stop returned with an interval tick in flight').toBe('pending');

    const held = rig.pool.connects();
    vi.advanceTimersByTime(799);
    await drain();
    expect(stop.outcome(), 'the stop returned before the bound').toBe('pending');

    vi.advanceTimersByTime(1);
    await drain();
    expect(stop.outcome(), 'the stop did not return at the bound').toBe('returned');
    expect(rig.pool.connects(), 'a tick started during the stop').toBe(held);

    rig.pool.open();
    await drain();
    expect(rig.pool.waiting(), 'fixture: the held tick ended').toBe(0);
    const statements = rig.pool.connects();
    vi.advanceTimersByTime(target.healIntervalMs * 3);
    await drain();
    expect(rig.pool.connects(), 'a tick ran after the stop').toBe(statements);
  },
);

it.each(TIMERS)(
  '[AC-B2-15q#9] %s：首个 tick 在途时 interval 到点，不叠加新 tick；之后 stop 仍等这个首个 tick 结束',
  async (name) => {
    const target = targets[name];
    const rig = latchedRig(target);
    rig.pool.close();
    rig.timer.onApplicationBootstrap();
    vi.advanceTimersByTime(target.seedDelayMs);
    await drain();
    expect(rig.pool.waiting(), 'fixture: the first tick is held at the pool').toBe(1);

    vi.advanceTimersByTime(target.healIntervalMs * 2);
    await drain();
    expect(rig.pool.connects(), 'a tick overlapped the tick in flight').toBe(1);

    const stop = stopping(rig.timer);
    await drain();
    expect(stop.outcome(), 'the stop lost the tick still in flight').toBe('pending');

    rig.pool.open();
    expect(await stop.settled(), 'the stop did not return after the tick ended').toBe('returned');
    expect(rig.pool.waiting(), 'the stop left a statement in flight').toBe(0);
  },
);

it.each(TIMERS)(
  '[AC-B2-15q#10] %s：后续 interval tick 在途时下一次 interval 到点，不叠加新 tick；之后 stop 仍等这个在途 tick 结束',
  async (name) => {
    const target = targets[name];
    const rig = await firstTickEnded(target);
    await nextTickHeld(rig, target);
    rig.pool.open();
    await drain();
    expect(rig.pool.waiting(), 'fixture: the first interval tick ended').toBe(0);

    await nextTickHeld(rig, target);
    const held = rig.pool.connects();
    vi.advanceTimersByTime(target.healIntervalMs);
    await drain();
    expect(rig.pool.connects(), 'a tick overlapped the tick in flight').toBe(held);

    const stop = stopping(rig.timer);
    await drain();
    expect(stop.outcome(), 'the stop lost the tick still in flight').toBe('pending');

    rig.pool.open();
    expect(await stop.settled(), 'the stop did not return after the tick ended').toBe('returned');
    expect(rig.pool.waiting(), 'the stop left a statement in flight').toBe(0);
  },
);

it.each(TIMERS)(
  '[AC-B2-15q#11] %s：interval tick 失败只记 warn，下一次 tick 照常运行；它在途失败时 stop 同样等它结束后正常返回',
  async (name) => {
    const target = targets[name];
    const rig = await firstTickEnded(target);
    await nextTickHeld(rig, target);
    rig.pool.fail(syntheticError('SyntheticEarlierError'));
    await drain();
    expect(rig.pool.waiting(), 'fixture: the failed tick ended').toBe(0);

    await nextTickHeld(rig, target);
    const stop = stopping(rig.timer);
    await drain();
    expect(stop.outcome(), 'the stop returned with an interval tick in flight').toBe('pending');

    rig.pool.fail(syntheticError('SyntheticLaterError'));
    expect(await stop.settled(), 'a failed tick must not fail the shutdown').toBe('returned');
    expect(
      rig
        .warnings()
        .filter((line) => line.message === target.failureLine)
        .map((line) => line.fields['error_name']),
    ).toStrictEqual(['SyntheticEarlierError', 'SyntheticLaterError']);
  },
);
