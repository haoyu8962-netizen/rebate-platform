// B3-08q · BR-AI-19「每个 run 都必须异步落 PG，不阻塞 SSE」(rule tests: test/spec/agent/trace-persist/**).
// The stream runtime's per-run trace: the core's tool calls (OrchestratorTrace.tool_calls,
// arguments already masked by the runtime's traceMask, BR-AI-14) go to app.agent_tool_calls (seq
// 1..n in call order) through agent/store/results createPgAgentTraceWriter.
// B3-08zc (BR-AI-19 细则「助手回复落库」): cards no longer go through the trace; the reply's cards are
// written with the run's terminal state (../pg/reply.ts), so a record here carries no card.
// B3-05p: each tool call row carries its initiator (model / server, BR-AI-01 细则「意图兜底与不空回复」
// 「标明由服务端发起」).
//
// createRunTraceRecorder({queue}):
//   sink — the core's RunTraceSink (AgentRunBodyDeps.trace): the run's tool calls, kept for its run
//     while that run's body is in progress (a trace of no open run is ignored).
//   body(input, inner) — the run body the HTTP layer starts: opens the run's record under the
//     server-side run context only (app = input.caller.appId, session / run = the RunContext's;
//     never a model argument, BR-AI-03), runs `inner`, and when it settles (done, error, thrown, or
//     returned after the run was cancelled / timed out: the core returns at once on abort and the
//     manager writes no card after the ending) hands the record (when it has a tool call; cards
//     always []) to queue.persist WITHOUT waiting: the reply, its frames and its finish reason never depend on
//     the trace. B3-08y: the queue (./trace-retry.ts createTraceRedoQueue) writes the record, logs
//     the first failure as one warn line `agent_trace_write_failed` {run_id, error_name}, writes a
//     failed half again for up to 24 hours and logs agent.trace_lost when it gives up; it never
//     rejects. Repeated writes stay one row through the writer's unique keys (ON CONFLICT DO
//     NOTHING).
// B3-08t (BR-AI-19 细则「运行级字段」, BR-AI-05 细则「上下文块」⑤; rule tests
// test/spec/agent/run-fields/**), with `runFields` in the deps (the stream runtime passes its Clock):
//   sync — settleFields(runId), called by the runtime right before admission.settle, gives the
//     terminal transaction the run's intent (orchestrator storedIntentOf over the intent port's
//     verdict, the core's trace intent and the first tool called), input_passed (inputPassed(runId),
//     called by the runtime's input check wrapper when the check let the message through: review
//     passed, no refusal pre-check, no prohibited goods) and whether model output was used (the core
//     trace's model, not a degraded result; unknown while the core has not recorded its trace yet,
//     e.g. a run cancelled while its model call is pending). What arrives after settle is never
//     written by the terminal transaction.
//   async — with the record handed to the queue at the body's end: runFields (the used model as
//     model and model_snapshot, tokens summed over the run's model answers, ttft_ms = first text
//     delta since the body started, latency_ms = the body's whole time, both from the Clock; the
//     filter hits, truncation and the page guide rejection reason). The writer sets them by value.
//   The intent port of the business assembly reports its verdict through recordIntentVerdict
//   (appId, runId), kept only for a run whose body is open in this process.
// Out of scope (BR-AI-19, other tasks): cost (B4); retention (BR-ID-30 ①); the trace-missing alert
// (FU-AGENT-TRACE-ALERT).
import type { PageGuideRejectReason } from '@couli/contracts-ts';
import type { RunBodyInput } from '../../http/index.ts';
import type { Clock } from '../../../platform/index.ts';
import type { OrchestratorTrace, RunTraceSink } from '../../orchestrator/core/ports.ts';
import { storedIntentOf } from '../../orchestrator/core/run-intent.ts';
import type { IntentTrace } from '../../orchestrator/intents/index.ts';
import type { RunFieldsRecord, ToolCallRecord } from '../../store/results/index.ts';
import type { LiveRunFields } from '../pg/index.ts';
import type { RunBody, RunContext } from '../run/index.ts';
import type { RunTraceRecord, TraceRedoQueue } from './trace-retry.ts';

export { TRACE_WRITE_FAILED } from './trace-retry.ts';

export interface RunTraceRecorderDeps {
  readonly queue: Pick<TraceRedoQueue, 'persist'>;
  /** B3-08t: record the run-level fields (sync and async), timed on this Clock. */
  readonly runFields?: { readonly clock: Clock };
}

export interface RunTraceRecorder {
  readonly sink: RunTraceSink;
  body(input: RunBodyInput, inner: RunBody): RunBody;
  /** B3-08t: the input check let this run's message through (「判定顺序」 step 1 passed). */
  inputPassed(runId: string): void;
  /**
   * B3-08t: the fields the terminal transaction writes for a run whose body this recorder opened
   * (undefined otherwise, or without `runFields`). Called once, right before settle.
   */
  settleFields(runId: string): LiveRunFields | undefined;
}

/** The intent port's verdict of one run (its last record). */
interface IntentVerdict {
  readonly intent: string | null;
  readonly reason: PageGuideRejectReason | null;
}

/** One run's trace while its body is in progress (server-side app / session / run only). */
interface AgentRunTrace {
  readonly appId: string;
  readonly sessionId: string;
  readonly runId: string;
  toolCalls: OrchestratorTrace['tool_calls'];
  /** B3-08t: the core's trace of the run (null until recorded). */
  core: OrchestratorTrace | null;
  inputPassed: boolean;
  startedMs: number | null;
  firstTextMs: number | null;
  /** settleFields was called: what changes later is for the async write only. */
  settled: boolean;
  /** The body ended and the record was handed to the queue. */
  flushed: boolean;
  /** The intent port's verdict as of the body's end (null: none, or not ended yet). */
  verdict: IntentVerdict | null;
}

/** B3-08t: open slots for the intent port's verdicts, by run id (UUIDv7, server generated). */
const verdictSlots = new Map<string, { readonly appId: string; verdict: IntentVerdict | null }>();

/**
 * B3-08t: the business assembly's intent port reports its verdict (IntentDeps.trace.record): the
 * server-checked intent (判定顺序②) and the page guide rejection reason. Kept for a run whose body
 * is in progress under a recorder of this process and of the same app; anything else is ignored.
 */
export function recordIntentVerdict(appId: string, runId: string, value: IntentTrace): void {
  const slot = verdictSlots.get(runId);
  if (slot === undefined || slot.appId !== appId) return;
  slot.verdict = { intent: value.intent, reason: value.page_guide_reject_reason };
}

/** B3-08t: the core's trace as the stored intent's facts. */
function intentOf(run: AgentRunTrace, verdict: IntentVerdict | null) {
  const core = run.core;
  return storedIntentOf({
    entry: core?.entry_intent ?? null,
    ...(verdict === null ? {} : { checked: verdict.intent }),
    traced: core?.intent ?? null,
    unchecked: core?.intent_unchecked === true,
    unserved: core?.degraded_unserved === true,
    firstTool: core?.tool_calls[0]?.name ?? null,
  });
}

/** B3-08t: the model whose output the run's result used (null: none). */
function usedModel(core: OrchestratorTrace): string | null {
  return core.degraded === true ? null : core.model;
}

/** B3-08t: the core's filter hits as stored (the three contract values, once each). */
function filterHits(core: OrchestratorTrace | null): RunFieldsRecord['filter_hits'] {
  const hits: RunFieldsRecord['filter_hits'][number][] = [];
  for (const hit of core?.filter_hits ?? []) {
    if ((hit === 'amount' || hit === 'url' || hit === 'tpwd') && !hits.includes(hit)) {
      hits.push(hit);
    }
  }
  return hits;
}

/** B3-08t: a non-negative whole number of ms between two Clock readings, else null. */
function elapsed(from: number | null, to: number | null): number | null {
  if (from === null || to === null) return null;
  const ms = Math.round(to - from);
  return Number.isSafeInteger(ms) && ms >= 0 ? ms : null;
}

/**
 * B3-08t: the run context the core gets, observing the first text delta (ttft). Every member is
 * passed through unchanged (the same signal and counters).
 */
function timedContext(ctx: RunContext, firstText: () => void): RunContext {
  return {
    get runId() {
      return ctx.runId;
    },
    get sessionId() {
      return ctx.sessionId;
    },
    get signal() {
      return ctx.signal;
    },
    get cardsDelivered() {
      return ctx.cardsDelivered;
    },
    text(delta) {
      ctx.text(delta);
      if (delta !== '') firstText();
    },
    toolStatus: (tool, phase, displayText) => ctx.toolStatus(tool, phase, displayText),
    card: (card, delivered) => ctx.card(card, delivered),
    suggestions: (items) => ctx.suggestions(items),
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The core's masked tool calls as agent_tool_calls rows: seq 1..n in call order. B3-05p: initiator
 * 'server' for a call the core marked server-initiated, 'model' for every other call. */
export function toolCallRecords(calls: OrchestratorTrace['tool_calls']): ToolCallRecord[] {
  return calls.map((call, index) => ({
    seq: index + 1,
    name: call.name,
    // Only the traceMask result is stored; anything that is not an object is stored as null.
    args: isRecord(call.args) ? call.args : null,
    result_digest: null,
    status: call.status,
    latency_ms: null,
    initiator: call.initiator === 'server' ? 'server' : 'model',
  }));
}

/**
 * B3-05p (BR-AI-01 细则「意图兜底与不空回复」「标明由服务端发起」): the run's tool calls with their
 * initiator. A run no model answered (trace.model null: the deterministic link path's
 * get_rebate_quote, the no-model path) never made a model-requested call, so every call it traced
 * was made on the server's own initiative and is marked 'server'; otherwise each call keeps the
 * core's own mark (intent-fallback.ts rule 2). The core's trace entries are never changed.
 */
export function initiatedCalls(trace: OrchestratorTrace): OrchestratorTrace['tool_calls'] {
  if (trace.model !== null) return [...trace.tool_calls];
  return trace.tool_calls.map((call) =>
    call.initiator === 'server' ? call : { ...call, initiator: 'server' as const },
  );
}

export function createRunTraceRecorder(deps: RunTraceRecorderDeps): RunTraceRecorder {
  const open = new Map<string, AgentRunTrace>();
  /** B3-08t: bodies that ended before their settle (the sync fields are still to be taken). */
  const ended = new Map<string, AgentRunTrace>();
  const clock = deps.runFields?.clock;

  function nowMs(): number | null {
    if (clock === undefined) return null;
    try {
      return clock.now().getTime();
    } catch {
      return null;
    }
  }

  /** B3-08t: the async run-level columns of a run whose body ended. */
  function runFieldsOf(run: AgentRunTrace, verdict: IntentVerdict | null): RunFieldsRecord {
    const core = run.core;
    return {
      model: core === null ? null : usedModel(core),
      input_tokens: core?.usage?.input_tokens ?? null,
      output_tokens: core?.usage?.output_tokens ?? null,
      ttft_ms: elapsed(run.startedMs, run.firstTextMs),
      latency_ms: elapsed(run.startedMs, nowMs()),
      filter_hits: filterHits(core),
      output_truncated: core?.output_truncated === true,
      // The intent port's reason, else the no-model path's (BR-AI-19 细则「运行级字段」).
      page_guide_reject_reason: verdict?.reason ?? core?.page_guide_reject_reason ?? null,
    };
  }

  function flush(run: AgentRunTrace): void {
    open.delete(run.runId);
    run.flushed = true;
    const slot = verdictSlots.get(run.runId);
    const verdict = slot?.verdict ?? null;
    verdictSlots.delete(run.runId);
    // The verdict as of the body's end, for the settle that follows.
    run.verdict = verdict;
    if (clock !== undefined && !run.settled) ended.set(run.runId, run);
    const runFields = clock === undefined ? undefined : runFieldsOf(run, verdict);
    if (run.toolCalls.length === 0 && runFields === undefined) return;
    const record: RunTraceRecord = {
      appId: run.appId,
      sessionId: run.sessionId,
      runId: run.runId,
      // B3-08zc: the cards are stored with the terminal state, never by the trace.
      cards: [],
      toolCalls: toolCallRecords(run.toolCalls),
      ...(runFields === undefined ? {} : { runFields }),
    };
    // Apart from the stream: never awaited by the run; never a rejection left unhandled.
    void deps.queue.persist(record).catch(() => undefined);
  }

  return {
    sink: {
      record(runId, trace) {
        const run = open.get(runId);
        if (run === undefined) return;
        run.toolCalls = initiatedCalls(trace);
        run.core = trace;
      },
    },
    body(input, inner) {
      return async (ctx) => {
        const run: AgentRunTrace = {
          appId: input.caller.appId,
          sessionId: ctx.sessionId,
          runId: ctx.runId,
          toolCalls: [],
          core: null,
          inputPassed: false,
          startedMs: nowMs(),
          firstTextMs: null,
          settled: false,
          flushed: false,
          verdict: null,
        };
        open.set(run.runId, run);
        if (clock !== undefined) verdictSlots.set(run.runId, { appId: run.appId, verdict: null });
        const inside =
          clock === undefined
            ? ctx
            : timedContext(ctx, () => {
                if (run.firstTextMs === null && !run.flushed) run.firstTextMs = nowMs();
              });
        try {
          return await inner(inside);
        } finally {
          flush(run);
        }
      };
    },
    inputPassed(runId) {
      const run = open.get(runId);
      if (run !== undefined && !run.settled) run.inputPassed = true;
    },
    settleFields(runId) {
      if (clock === undefined) return undefined;
      const run = open.get(runId) ?? ended.get(runId);
      ended.delete(runId);
      if (run === undefined || run.settled) return undefined;
      run.settled = true;
      const verdict = run.flushed ? run.verdict : (verdictSlots.get(runId)?.verdict ?? null);
      return {
        intent: intentOf(run, verdict),
        inputPassed: run.inputPassed,
        modelUsed: run.core === null ? null : usedModel(run.core) !== null,
      };
    },
  };
}
