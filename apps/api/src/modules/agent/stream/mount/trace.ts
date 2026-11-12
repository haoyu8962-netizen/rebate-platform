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
// Out of scope (BR-AI-19, other tasks): run-level fields of agent_runs (model snapshot, tokens,
// cost, intent); retention (BR-ID-30 ①); the trace-missing alert (FU-AGENT-TRACE-ALERT).
import type { RunBodyInput } from '../../http/index.ts';
import type { OrchestratorTrace, RunTraceSink } from '../../orchestrator/core/ports.ts';
import type { ToolCallRecord } from '../../store/results/index.ts';
import type { RunBody } from '../run/index.ts';
import type { RunTraceRecord, TraceRedoQueue } from './trace-retry.ts';

export { TRACE_WRITE_FAILED } from './trace-retry.ts';

export interface RunTraceRecorderDeps {
  readonly queue: Pick<TraceRedoQueue, 'persist'>;
}

export interface RunTraceRecorder {
  readonly sink: RunTraceSink;
  body(input: RunBodyInput, inner: RunBody): RunBody;
}

/** One run's trace while its body is in progress (server-side app / session / run only). */
interface AgentRunTrace {
  readonly appId: string;
  readonly sessionId: string;
  readonly runId: string;
  toolCalls: OrchestratorTrace['tool_calls'];
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

  function flush(run: AgentRunTrace): void {
    open.delete(run.runId);
    if (run.toolCalls.length === 0) return;
    const record: RunTraceRecord = {
      appId: run.appId,
      sessionId: run.sessionId,
      runId: run.runId,
      // B3-08zc: the cards are stored with the terminal state, never by the trace.
      cards: [],
      toolCalls: toolCallRecords(run.toolCalls),
    };
    // Apart from the stream: never awaited by the run; never a rejection left unhandled.
    void deps.queue.persist(record).catch(() => undefined);
  }

  return {
    sink: {
      record(runId, trace) {
        const run = open.get(runId);
        if (run !== undefined) run.toolCalls = initiatedCalls(trace);
      },
    },
    body(input, inner) {
      return async (ctx) => {
        const run: AgentRunTrace = {
          appId: input.caller.appId,
          sessionId: ctx.sessionId,
          runId: ctx.runId,
          toolCalls: [],
        };
        open.set(run.runId, run);
        try {
          return await inner(ctx);
        } finally {
          flush(run);
        }
      };
    },
  };
}
