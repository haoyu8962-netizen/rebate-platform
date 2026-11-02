// B2-15s rule test (claude-independent, FU-TICK-STOP-BOUND; no BR refs): the wait of a stop for the
// tick in flight is bounded. B2-15q made onModuleDestroy wait for the tick, without a limit: a tick
// stuck at pool.connect() (PostgreSQL unreachable, no connection timeout) keeps context.close() from
// ever ending. Now the five timers of the worker (payment's bill.recon chain, ledger's daily check,
// payout's recon and overdue chains, union's chain) wait 800 ms at most, then warn and return.
//
// Everything goes through the module's own onModuleDestroy: the platform function behind it is the
// implementation's to name, and is not imported. Over worker-shutdown/kit.ts: the real timers and
// tick functions on a gated pool (union: a monitor whose heal waits at the same kind of gate), fake
// module timers, and the stop watched from outside (kit stopping), so a stop that never returns is
// a failed assertion and never hangs Vitest. #6 needs a real timer handle: the fake clock only brings
// the tick into flight there.
//
// Red on the old modules, at an assertion: their stop waits for the tick for ever, so #1, #4 and #5
// fail on a stop that has not returned at the bound, and they arm no timer for the wait, so #2 and #3
// fail on the timer count and #6 on the list of real timeouts. #2 and #3 pin what the old modules do
// already (a tick that ends in time, no tick at all); they read the timer count while a tick is in
// flight, which is also what makes their count of 0 afterwards mean something. Top-level it() only
// (规划/11 §4.3).
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  LOAD_TIMEOUT_MS,
  TIMERS,
  deferred,
  drain,
  fakeModuleTimers,
  loadTargets,
  loadUnionTarget,
  recordingLogger,
  rigOf,
  stopping,
  syntheticError,
  type Lifecycle,
  type LogLine,
  type Target,
  type TimerName,
  type UnionTarget,
} from '../worker-shutdown/kit.ts';

/** How long a stop waits for the tick in flight (the task's TICK_STOP_WAIT_MS). */
const STOP_BOUND_MS = 800;
const TIMED_OUT_LINE = 'worker_tick_stop_timed_out';
const UNION_TIMER = 'union-auth';
const BOUNDED = [...TIMERS, UNION_TIMER] as const;
type BoundedName = (typeof BOUNDED)[number];
/** All a timed-out line may carry: which timer, and how long it waited. No business data. */
const LINE_FIELDS: ReadonlySet<string> = new Set(['timer', 'queue', 'module', 'wait_ms']);

/** A timer of the worker with its tick's work held at a gate the test opens. */
interface BoundRig {
  readonly timer: Lifecycle;
  /** Units of work (statements, heals) held at the gate. */
  waiting(): number;
  /** Units of work started so far. */
  started(): number;
  /** Lets the held work, and all later work, go on. */
  release(): void;
  /** Fails the held work, and all later work, with `error`. */
  fail(error: Error): void;
  warnings(): LogLine[];
}

interface Bounded {
  readonly seedDelayMs: number;
  readonly healIntervalMs: number;
  /** The warn line of a failed tick (it exists before this task). */
  readonly failureLine: string;
  rig(): BoundRig;
}

function poolRig(target: Target): BoundRig {
  const rig = rigOf(target);
  return {
    timer: rig.timer,
    waiting: () => rig.pool.waiting(),
    started: () => rig.pool.connects(),
    release: () => {
      rig.pool.open();
    },
    fail: (error) => {
      rig.pool.fail(error);
    },
    warnings: () => rig.warnings(),
  };
}

/** union's timer takes a monitor, not a database: its tick is held in heal. */
function unionRig(target: UnionTarget): BoundRig {
  const gate = deferred();
  const { logger, warnings } = recordingLogger();
  let failure: Error | null = null;
  let started = 0;
  let waiting = 0;
  const heal = async (): Promise<void> => {
    started += 1;
    waiting += 1;
    await gate.promise;
    waiting -= 1;
    if (failure !== null) throw failure;
  };
  return {
    timer: target.build({ seed: () => Promise.resolve(), heal }, logger),
    waiting: () => waiting,
    started: () => started,
    release: () => {
      gate.resolve();
    },
    fail: (error) => {
      failure = error;
      gate.resolve();
    },
    warnings,
  };
}

let poolTargets: Record<TimerName, Target>;
let unionTarget: UnionTarget;
let rejections: unknown[] = [];

function onRejection(reason: unknown): void {
  rejections.push(reason);
}

function boundedOf(name: BoundedName): Bounded {
  if (name === UNION_TIMER) {
    return {
      ...unionTarget,
      failureLine: 'union_auth_heal_failed',
      rig: () => unionRig(unionTarget),
    };
  }
  const target = poolTargets[name];
  return { ...target, rig: () => poolRig(target) };
}

/** Bootstraps a timer and lets its first tick start and reach the gate. */
async function tickHeld(target: Bounded): Promise<BoundRig> {
  const rig = target.rig();
  rig.timer.onApplicationBootstrap();
  vi.advanceTimersByTime(target.seedDelayMs);
  await drain();
  expect(rig.waiting(), 'fixture: the first tick is held at the gate').toBe(1);
  return rig;
}

function timedOut(rig: BoundRig): LogLine[] {
  return rig.warnings().filter((line) => line.message === TIMED_OUT_LINE);
}

/** Stops a timer whose tick stays held and runs the fake clock to the bound. */
async function stopTimedOut(rig: BoundRig): Promise<void> {
  const stop = stopping(rig.timer);
  await drain();
  vi.advanceTimersByTime(STOP_BOUND_MS);
  await drain();
  expect(stop.outcome(), 'the stop did not return at the bound').toBe('returned');
}

interface RealTimeout {
  readonly delay: number | undefined;
  readonly handle: { hasRef(): boolean };
}

/** Keeps what the real setTimeout returns from now on (undone by vi.unstubAllGlobals). */
function recordRealTimeouts(): RealTimeout[] {
  const real = globalThis.setTimeout;
  const armed: RealTimeout[] = [];
  vi.stubGlobal('setTimeout', (callback: () => void, delay?: number) => {
    const handle = real(callback, delay) as unknown as RealTimeout['handle'];
    armed.push({ delay, handle });
    return handle;
  });
  return armed;
}

beforeAll(async () => {
  poolTargets = await loadTargets();
  unionTarget = await loadUnionTarget();
}, LOAD_TIMEOUT_MS);

beforeEach(() => {
  rejections = [];
  process.on('unhandledRejection', onRejection);
  fakeModuleTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  process.off('unhandledRejection', onRejection);
});

it.each(BOUNDED)(
  '[AC-B2-15s#1] %s：tick 一直不结束时 onModuleDestroy 恰在 800 毫秒后返回，不抛错，打一条 warn，字段含 timer 名、不含业务数据',
  async (name) => {
    const rig = await tickHeld(boundedOf(name));

    const stop = stopping(rig.timer);
    await drain();
    vi.advanceTimersByTime(STOP_BOUND_MS - 1);
    await drain();
    expect(stop.outcome(), 'the stop returned before the bound').toBe('pending');
    expect(timedOut(rig), 'the line came before the bound').toStrictEqual([]);

    vi.advanceTimersByTime(1);
    await drain();
    expect(stop.outcome(), 'the stop did not return at the bound').toBe('returned');
    const lines = timedOut(rig);
    expect(lines).toHaveLength(1);
    const fields: Record<string, unknown> = lines[0]?.fields ?? {};
    expect(fields['timer']).toBe(name);
    const extra = Object.keys(fields).filter((key) => !LINE_FIELDS.has(key));
    expect(extra, 'the line carries more than the timer').toStrictEqual([]);
    expect(vi.getTimerCount(), 'a timer outlived the stop').toBe(0);
  },
);

it.each(BOUNDED)(
  '[AC-B2-15s#2] %s：tick 在上限内结束时等到结束就返回，不打 warn，上限定时器随即清掉',
  async (name) => {
    const rig = await tickHeld(boundedOf(name));

    const stop = stopping(rig.timer);
    await drain();
    expect(vi.getTimerCount(), 'the wait has no bound').toBe(1);
    vi.advanceTimersByTime(STOP_BOUND_MS - 1);
    await drain();
    expect(stop.outcome(), 'the stop returned with a tick still in flight').toBe('pending');

    rig.release();
    expect(await stop.settled(), 'the stop did not return after the tick ended').toBe('returned');
    expect(vi.getTimerCount(), 'the bound outlived the stop').toBe(0);
    expect(timedOut(rig)).toStrictEqual([]);

    vi.advanceTimersByTime(STOP_BOUND_MS);
    await drain();
    expect(timedOut(rig), 'the bound fired after the stop returned').toStrictEqual([]);
  },
);

it.each(BOUNDED)(
  '[AC-B2-15s#3] %s：没有在途 tick 时 onModuleDestroy 立即返回，不起上限定时器，不打 warn；有在途 tick 时才起',
  async (name) => {
    const target = boundedOf(name);

    const notDue = target.rig();
    notDue.timer.onApplicationBootstrap();
    const notDueStop = stopping(notDue.timer);
    await drain();
    expect(notDueStop.outcome(), 'no tick ran: nothing to wait for').toBe('returned');
    expect(vi.getTimerCount(), 'a timer outlived the stop').toBe(0);

    const ended = await tickHeld(target);
    ended.release();
    await drain();
    expect(ended.waiting(), 'fixture: the tick ended').toBe(0);
    const endedStop = stopping(ended.timer);
    await drain();
    expect(endedStop.outcome(), 'the tick had ended: nothing to wait for').toBe('returned');
    expect(vi.getTimerCount(), 'a timer outlived the stop').toBe(0);

    vi.advanceTimersByTime(STOP_BOUND_MS);
    await drain();
    expect(timedOut(notDue)).toStrictEqual([]);
    expect(timedOut(ended)).toStrictEqual([]);

    const held = await tickHeld(target);
    const heldStop = stopping(held.timer);
    await drain();
    expect(vi.getTimerCount(), 'the wait for a tick in flight has no bound').toBe(1);
    held.release();
    expect(await heldStop.settled()).toBe('returned');
  },
);

it.each(BOUNDED)(
  '[AC-B2-15s#4] %s：超时返回后 tick 才失败，错误由 tick 自身接住、记它原有的 warn，不产生 unhandledRejection',
  async (name) => {
    const target = boundedOf(name);
    const rig = await tickHeld(target);
    await stopTimedOut(rig);

    rig.fail(syntheticError('SyntheticLateError'));
    await drain();
    expect(rig.waiting(), 'fixture: the tick ended').toBe(0);
    expect(rejections, 'a late failure became an unhandled rejection').toStrictEqual([]);
    expect(
      rig
        .warnings()
        .filter((line) => line.message === target.failureLine)
        .map((line) => line.fields['error_name']),
    ).toStrictEqual(['SyntheticLateError']);
    expect(timedOut(rig)).toHaveLength(1);
  },
);

it.each(BOUNDED)(
  '[AC-B2-15s#5] %s：超时返回后不再起新 tick：在途 tick 结束前后，到点的定时器和再次 bootstrap 都不起',
  async (name) => {
    const target = boundedOf(name);
    const rig = await tickHeld(target);
    await stopTimedOut(rig);

    const held = rig.started();
    vi.advanceTimersByTime(target.healIntervalMs * 3);
    await drain();
    expect(rig.started(), 'a tick started after the stop timed out').toBe(held);

    rig.release();
    await drain();
    expect(rig.waiting(), 'fixture: the tick ended').toBe(0);
    const finished = rig.started();
    vi.advanceTimersByTime(target.healIntervalMs * 3);
    await drain();
    expect(rig.started(), 'a tick started once the stuck one ended').toBe(finished);

    rig.timer.onApplicationBootstrap();
    vi.advanceTimersByTime(target.seedDelayMs + target.healIntervalMs * 3);
    await drain();
    expect(rig.started(), 'a bootstrap after the stop started a tick').toBe(finished);
    expect(vi.getTimerCount(), 'a timer outlived the stop').toBe(0);
  },
);

it.each(BOUNDED)(
  '[AC-B2-15s#6] %s：上限定时器 unref（真实 setTimeout 的返回值 hasRef() 为 false），不让进程因它多活',
  async (name) => {
    const rig = await tickHeld(boundedOf(name));

    vi.useRealTimers();
    const armed = recordRealTimeouts();
    const stop = stopping(rig.timer);
    await drain();

    const bounds = armed.filter((timeout) => timeout.delay === STOP_BOUND_MS);
    expect(bounds, 'the stop armed no real timer for its bound').toHaveLength(1);
    expect(bounds[0]?.handle.hasRef(), 'the bound keeps the process alive').toBe(false);

    rig.release();
    expect(await stop.settled(), 'the stop did not return after the tick ended').toBe('returned');
  },
);
