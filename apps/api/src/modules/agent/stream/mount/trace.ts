// B3-08q · BR-AI-19「每个 run 都必须异步落 PG，不阻塞 SSE」(rule tests: test/spec/agent/trace-persist/**).
// The stream runtime's per-run trace: every card frame the RunManager wrote (whatever path wrote
// it: model tool, degraded keyword search, deterministic link path, intent port) goes to
// app.agent_cards, and the core's tool calls (OrchestratorTrace.tool_calls, arguments already
// masked by the runtime's traceMask, BR-AI-14) go to app.agent_tool_calls (seq 1..n in call order),
// both through agent/store/results createPgAgentTraceWriter.
//
// createRunTraceRecorder({writer, logger}):
//   cardWritten(runId, card) — RunManagerDeps.onCardWritten: the written frame's card, kept for its
//     run while that run's body is in progress (a card of no open run is ignored).
//   sink — the core's RunTraceSink (AgentRunBodyDeps.trace): the run's tool calls, kept likewise.
//   body(input, inner) — the run body the HTTP layer starts: opens the run's record under the
//     server-side run context only (app = input.caller.appId, session / run = the RunContext's;
//     never a model argument, BR-AI-03), runs `inner`, and when it settles (done, error, thrown, or
//     returned after the run was cancelled / timed out: the core returns at once on abort and the
//     manager writes no card after the ending) hands the record to the writer WITHOUT waiting: the
//     reply, its frames and its finish reason never depend on the trace. Both writes are asked for
//     (tool calls and cards, each only when there is something); any failure, whatever its number,
//     is one warn line `agent_trace_write_failed` with the flat run_id and error_name only (no card,
//     argument or user text); nothing is rethrown, so no rejection is left unhandled. Repeated
//     writes stay one row through the writer's unique keys (ON CONFLICT DO NOTHING).
// An earnings_summary card is stored without its amounts (storedCard, D32).
// Out of scope (BR-AI-19, other tasks): the 24-hour local retry queue and agent.trace_lost; run-level
// fields of agent_runs (model snapshot, tokens, cost, intent); retention (BR-ID-30 ①).
import type { RunBodyInput } from '../../http/index.ts';
import type { OrchestratorTrace, RunTraceSink } from '../../orchestrator/core/ports.ts';
import type { AgentTraceWriter, ToolCallRecord } from '../../store/results/index.ts';
import type { RunBody } from '../run/index.ts';
import type { CardInput } from '../writer/index.ts';
import type { RootLogger } from '../../../platform/index.ts';

/** The one warn line of a run whose trace could not be written. */
export const TRACE_WRITE_FAILED = 'agent_trace_write_failed';

export interface RunTraceRecorderDeps {
  readonly writer: AgentTraceWriter;
  readonly logger: Pick<RootLogger, 'warn'>;
}

export interface RunTraceRecorder {
  readonly sink: RunTraceSink;
  cardWritten(runId: string, card: CardInput): void;
  body(input: RunBodyInput, inner: RunBody): RunBody;
}

/** One run's trace while its body is in progress (server-side app / session / run only). */
interface AgentRunTrace {
  readonly appId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly cards: CardInput[];
  toolCalls: OrchestratorTrace['tool_calls'];
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The card as stored: the written frame unchanged, except an earnings_summary card, whose stored
 * data keeps only as_of and actions (BR-AI-19 细则 D32: no amount copy; the amounts appear only in
 * the SSE frame that delivered the card; agent_cards_earnings_no_amount_check).
 */
export function storedCard(card: CardInput): CardInput {
  if (card.type !== 'earnings_summary') return card;
  const data: Record<string, unknown> = {};
  for (const key of ['as_of', 'actions']) {
    if (Object.hasOwn(card.data, key)) data[key] = card.data[key];
  }
  return { ...card, data };
}

/** The core's masked tool calls as agent_tool_calls rows: seq 1..n in call order. */
export function toolCallRecords(calls: OrchestratorTrace['tool_calls']): ToolCallRecord[] {
  return calls.map((call, index) => ({
    seq: index + 1,
    name: call.name,
    // Only the traceMask result is stored; anything that is not an object is stored as null.
    args: isRecord(call.args) ? call.args : null,
    result_digest: null,
    status: call.status,
    latency_ms: null,
  }));
}

export function createRunTraceRecorder(deps: RunTraceRecorderDeps): RunTraceRecorder {
  const open = new Map<string, AgentRunTrace>();

  async function persist(run: AgentRunTrace): Promise<void> {
    const writes: Promise<void>[] = [];
    // A writer that throws synchronously counts as a failed write like a rejection.
    const attempt = (call: () => Promise<void>): void => {
      writes.push(Promise.resolve().then(call));
    };
    if (run.toolCalls.length > 0) {
      const records = toolCallRecords(run.toolCalls);
      attempt(() => deps.writer.recordToolCalls(run.appId, run.runId, records));
    }
    if (run.cards.length > 0) {
      const cards = [...run.cards];
      attempt(() => deps.writer.recordCards(run.appId, run.sessionId, run.runId, cards));
    }
    const results = await Promise.allSettled(writes);
    const failed = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failed === undefined) return;
    const error: unknown = failed.reason;
    deps.logger.warn(
      { run_id: run.runId, error_name: error instanceof Error ? error.name : typeof error },
      TRACE_WRITE_FAILED,
    );
  }

  function flush(run: AgentRunTrace): void {
    open.delete(run.runId);
    // Apart from the stream: never awaited by the run; never a rejection left unhandled.
    void persist(run).catch(() => undefined);
  }

  return {
    sink: {
      record(runId, trace) {
        const run = open.get(runId);
        if (run !== undefined) run.toolCalls = [...trace.tool_calls];
      },
    },
    cardWritten(runId, card) {
      open.get(runId)?.cards.push(storedCard(card));
    },
    body(input, inner) {
      return async (ctx) => {
        const run: AgentRunTrace = {
          appId: input.caller.appId,
          sessionId: ctx.sessionId,
          runId: ctx.runId,
          cards: [],
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
