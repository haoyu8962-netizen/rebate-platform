// B3-08y rule-test kit · BR-AI-19「TraceWriter 写入失败时进本地重试队列，最多重试 24 小时，仍失败记
// 告警 agent.trace_lost，不得静默丢弃」; BR-AI-22 (注销后不回填); BR-AI-03 / BR-AI-07 (B3-08q S2).
// Plan: couli-runs/FU-AGENT-TRACE-RETRY/plan.md §4 单 1 (D10-1060).
//
// Contract pinned by the tests of this directory (the implementation's freedom ends here):
// - Entry: apps/api/src/modules/agent/stream/mount/trace-retry.ts
//   createTraceRedoQueue({writer, clock, scheduler, logger, params?, onLost?}) → TraceRedoQueue
//   {persist(record), queued(), close(boundMs)};
//   traceRedoDefaults() = DEFAULTS below (agent's own injectable defaults, never a content key);
// - persist writes tool calls and cards (each only when present); resolves once the first attempt
//   settled, never rejects. Transient failure (anything but a permanent one): the run is queued,
//   only its failed half is written again, after 1 s, 2 s, 4 s, … capped at 5 min, until 24 h after
//   the first failure; time only from the injected Clock and Scheduler.
// - Permanent failure (the writer's own checks — run not found, invalid card_id — and SQLSTATE
//   class 22 / 23 / 42 in error.code): never written again, lost at once with reason 'rejected'.
// - Logs: first failure of a run → exactly ONE warn WRITE_FAILED {run_id, error_name}; later
//   failures debug only. Each lost run → exactly ONE error line LOST {run_id, reason, cards,
//   tool_calls} (numbers of the run's cards / tool calls left unwritten; a written half counts 0),
//   no card, data, argument, user text or fallback text, plus one onLost(reason) call. A write the
//   writer answers 'skipped' (session detached from its user) is done: no write again, no lost,
//   one info line SKIPPED {run_id} per run.
// - Overflow: more than params.maxRuns queued runs → the oldest is dropped (lost 'overflow').
// - close(boundMs): one last bounded attempt (in-flight first attempts are waited for within the
//   same bound); what is left is lost 'shutdown'; resolves within boundMs of scheduler time; no
//   timer calls the writer afterwards. The stream runtime's close() does this with
//   timings.lockGraceMs after its runs ended, and still returns.
// - The writer (agent/store/results createPgAgentTraceWriter): a session detached from its user
//   (user_id NULL, user_hash set — purgeAgentDataForUser) makes recordCards / recordToolCalls resolve
//   'skipped' and write nothing, also when the purge is committing concurrently (the write waits for
//   it); a guest session (user_hash NULL) and a live member session are written as before.
// - The production stream runtime (createAgentStreamRuntime, no new dependency or seam) routes every
//   run's trace through such a queue on its own Clock and scheduler.
// - Frozen and kept: test/spec/agent/trace-persist/** (one warn within 500 ms for a failing writer,
//   runtime.close() returns, createOrderCardRefs(db) semantics).
// Everything under test is built inside the tests (never in hooks). Synthetic values only.
// This file holds what the unit tests need (no database); ./runtime-kit.ts the integration side.
import { expect, vi } from 'vitest';
import type { ToolCallRecord } from '../../../../apps/api/src/modules/agent/store/results/index.ts';
import {
  createTraceRedoQueue,
  type RedoTraceWriter,
  type RunTraceRecord,
  type TraceLostReason,
  type TraceRedoParams,
  type TraceWriteOutcome,
} from '../../../../apps/api/src/modules/agent/stream/mount/trace-retry.ts';
import type { CardInput } from '../../../../apps/api/src/modules/agent/stream/writer/index.ts';
import { createRootLogger } from '../../../../apps/api/src/modules/platform/logging/logger.ts';
import { ManualTime } from '../stream-run/kit.ts';

export { ManualTime };

/** The error line of a lost run. */
export const LOST = 'agent.trace_lost';
/** The one warn line of a run's first failed write (B3-08q, kept). */
export const WRITE_FAILED = 'agent_trace_write_failed';
/** The info line of a run whose session was detached from its user (BR-AI-22). */
export const SKIPPED = 'agent_trace_skipped_erased';

export const SECOND = 1_000;
export const MINUTE = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

/** traceRedoDefaults(). */
export const DEFAULTS: TraceRedoParams = {
  maxRuns: 5_000,
  firstDelayMs: 1_000,
  maxDelayMs: 300_000,
  windowMs: 86_400_000,
};

export const LEVEL = { debug: 20, info: 30, warn: 40, error: 50 } as const;

/** Fields a lost line must never carry (counts only). */
export const NOT_IN_LOST = [
  'card',
  'data',
  'args',
  'items',
  'user_text',
  'text',
  'fallback_text',
  'calls',
  'record',
];

/** Free text of the synthetic run; it must never appear in a log line. */
export const SECRET = '合成用户搜索词';

export const APP = 'synthetic-b3-08y-app';
export const OTHER_APP = 'synthetic-b3-08y-other-app';
export const SESSION = '0192f3a1-7c00-7000-8000-0000000a0001';
export const OTHER_SESSION = '0192f3a1-7c00-7000-8000-0000000a0002';
export const ORDER_ID = '0192f3a1-7c00-7000-8000-00000000d001';

// ---- log lines ----------------------------------------------------------------------------------

export interface LogLine {
  readonly level: number;
  readonly msg: string;
  readonly [field: string]: unknown;
}

/** A root logger writing JSON lines to memory (every level). */
export class Lines {
  readonly lines: string[] = [];
  readonly logger = createRootLogger(
    { level: 'trace', entry: 'stream', appEnv: 'test' },
    { write: (line: string) => void this.lines.push(line) },
  );
  all(): LogLine[] {
    return this.lines.map((line) => JSON.parse(line) as LogLine);
  }
  of(msg: string): LogLine[] {
    return this.all().filter((line) => line.msg === msg);
  }
  atLevel(level: number): LogLine[] {
    return this.all().filter((line) => line.level === level);
  }
}

/**
 * The lost line of `expected.run_id` among `lines`: exactly one, error level, the fields given,
 * counts only, no free text.
 */
export function expectLost(
  lines: readonly LogLine[],
  expected: {
    readonly run_id: string;
    readonly reason: TraceLostReason;
    readonly cards: number;
    readonly tool_calls: number;
  },
): void {
  const mine = lines.filter((line) => line.msg === LOST && line['run_id'] === expected.run_id);
  expect(mine, `one ${LOST} line of ${expected.run_id}`).toHaveLength(1);
  const line = mine[0];
  expect(line).toMatchObject({ level: LEVEL.error, msg: LOST, ...expected });
  for (const field of NOT_IN_LOST) expect(line, field).not.toHaveProperty(field);
  expect(JSON.stringify(line)).not.toContain(SECRET);
}

// ---- synthetic records --------------------------------------------------------------------------

let runNo = 0;

/** A new synthetic run id (uuid-shaped). */
export function newRunId(): string {
  runNo += 1;
  return `0192f3a1-7c00-7000-8000-${runNo.toString(16).padStart(12, '0')}`;
}

export function notice(cardId: string): CardInput {
  return {
    card_id: cardId,
    type: 'notice',
    schema_version: 1,
    data: { level: 'info', text_key: 'k', actions: [] },
    fallback_text: `${SECRET} 兜底`,
  };
}

export function orderCard(cardId: string, orderId: string = ORDER_ID): CardInput {
  return {
    card_id: cardId,
    type: 'order_status',
    schema_version: 1,
    data: { order_id: orderId, display_status: 'tracking', actions: [] },
    fallback_text: '合成订单卡',
  };
}

/** An earnings card still carrying an amount (and an order_id): never stored that way (D32). */
export function earningsCard(cardId: string): CardInput {
  return {
    card_id: cardId,
    type: 'earnings_summary',
    schema_version: 1,
    data: {
      as_of: '2026-10-01T00:00:00+08:00',
      actions: [],
      withdrawable_fen: 100,
      order_id: ORDER_ID,
    },
    fallback_text: '合成收益卡',
  };
}

export function toolCall(seq: number, name = 'search_products'): ToolCallRecord {
  return {
    seq,
    name,
    args: { q: SECRET },
    result_digest: null,
    status: 'ok',
    latency_ms: null,
  };
}

/** One run's trace: two cards (notice c1, order_status c2) and one tool call, unless overridden. */
export function record(over: Partial<RunTraceRecord> = {}): RunTraceRecord {
  return {
    appId: APP,
    sessionId: SESSION,
    runId: newRunId(),
    cards: [notice('c1'), orderCard('c2')],
    toolCalls: [toolCall(1)],
    ...over,
  };
}

/** A PG-like error carrying a SQLSTATE in `code` (as node-postgres raises it). */
export function pgError(code: string): Error {
  return Object.assign(new Error(`合成数据库错误 ${code}`), {
    name: 'DatabaseError',
    code,
    severity: 'ERROR',
  });
}

// ---- a scripted writer (unit tests) -------------------------------------------------------------

/**
 * How the fake writer answers a call: 'pass' resolves, 'fail' rejects with a plain (transient)
 * error, 'sync' throws synchronously, 'hold' waits for release() and then resolves, 'skip'
 * resolves 'skipped', an Error rejects with that error.
 */
export type Behaviour = 'pass' | 'fail' | 'sync' | 'hold' | 'skip' | Error;

export interface FakeCall {
  readonly method: 'recordCards' | 'recordToolCalls';
  readonly appId: string;
  readonly sessionId: string | null;
  readonly runId: string;
  readonly count: number;
  /** ManualTime.t when called. */
  readonly at: number;
  readonly behaviour: Behaviour;
}

export function fakeWriter(time: ManualTime) {
  const calls: FakeCall[] = [];
  const written: FakeCall[] = [];
  let cards: Behaviour = 'pass';
  let tools: Behaviour = 'pass';
  let open!: () => void;
  let gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  function act(call: FakeCall): Promise<TraceWriteOutcome> {
    calls.push(call);
    const behaviour = call.behaviour;
    if (behaviour === 'sync') throw new Error('合成同步写入失败');
    const held = gate;
    return (async () => {
      if (behaviour instanceof Error) throw behaviour;
      if (behaviour === 'fail') throw new Error('合成 trace 写入失败');
      if (behaviour === 'skip') return 'skipped' as const;
      if (behaviour === 'hold') await held;
      written.push(call);
      return undefined;
    })();
  }
  const writer: RedoTraceWriter = {
    recordCards(appId, sessionId, runId, list) {
      return act({
        method: 'recordCards',
        appId,
        sessionId,
        runId,
        count: list.length,
        at: time.t,
        behaviour: cards,
      });
    },
    recordToolCalls(appId, runId, list) {
      return act({
        method: 'recordToolCalls',
        appId,
        sessionId: null,
        runId,
        count: list.length,
        at: time.t,
        behaviour: tools,
      });
    },
  };
  return {
    writer,
    calls,
    written,
    /** Both halves answer `behaviour` from now on. */
    set(behaviour: Behaviour): void {
      cards = behaviour;
      tools = behaviour;
    },
    setCards(behaviour: Behaviour): void {
      cards = behaviour;
    },
    setTools(behaviour: Behaviour): void {
      tools = behaviour;
    },
    /** Lets every call held so far go on (calls held later wait for the next release). */
    release(): void {
      open();
      gate = new Promise<void>((resolve) => {
        open = resolve;
      });
    },
    of(method: FakeCall['method'], runId: string): FakeCall[] {
      return calls.filter((call) => call.method === method && call.runId === runId);
    },
    writtenOf(method: FakeCall['method'], runId: string): FakeCall[] {
      return written.filter((call) => call.method === method && call.runId === runId);
    },
  };
}

export type FakeWriter = ReturnType<typeof fakeWriter>;

/** Manual time, a memory logger, the fake writer and an onLost spy; build() makes the queue. */
export function queueRig(options: { readonly params?: TraceRedoParams } = {}) {
  const time = new ManualTime();
  const logs = new Lines();
  const w = fakeWriter(time);
  const onLost = vi.fn<(reason: TraceLostReason) => void>();
  function build(writer: RedoTraceWriter = w.writer) {
    return createTraceRedoQueue({
      writer,
      clock: time.clock,
      scheduler: time.scheduler,
      logger: logs.logger,
      onLost,
      ...(options.params === undefined ? {} : { params: options.params }),
    });
  }
  return { time, logs, w, onLost, build };
}

/** Moves manual time forward to `target` (ms since start) in steps of at most `stepMs`. */
export async function advanceTo(time: ManualTime, target: number, stepMs = MINUTE): Promise<void> {
  while (time.t < target) await time.to(Math.min(target, time.t + stepMs));
}

/** Lets pending microtasks and immediates run. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}
