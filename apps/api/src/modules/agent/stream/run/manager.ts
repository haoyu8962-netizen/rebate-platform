import { createFrameValidator, StreamProtocolError, StreamWriter } from '../writer/index.ts';
import type {
  CardInput,
  ErrorData,
  FinishReason,
  StreamEvent,
  StreamEventInput,
} from '../writer/index.ts';
import type { RunEnding } from '../admission/index.ts';
import { numberCard } from './cards.ts';
import type {
  AbortReason,
  RunBody,
  RunBodyResult,
  RunContext,
  RunFacts,
  RunFinal,
  RunManager,
  RunManagerDeps,
  RunStart,
  TerminalDraft,
  TerminalFrame,
} from './types.ts';

type End = { ending: RunEnding } & (
  { event: 'done'; finishReason: FinishReason } | { event: 'error'; error: ErrorData }
);

// BR-AI-12/13: leave room within the revocation deadline for reads and the ordered tail.
const MAX_GUARD_POLL_MS = 5_000;
const GUARD_READ_TIMEOUT_MS = 2_000;

export function createRunManager(deps: RunManagerDeps): RunManager {
  for (const [name, ms] of Object.entries(deps.config)) {
    if (!Number.isSafeInteger(ms) || ms < (name === 'disconnectGraceMs' ? 0 : 1)) {
      throw new RangeError(`Invalid run duration: ${name}`);
    }
  }
  if (deps.config.guardPollMs > 10_000) {
    throw new RangeError('Run guard polling must respect the revocation deadline');
  }
  const validator = deps.validator ?? createFrameValidator();
  return {
    start: (start, body) => run(deps, validator, start, body),
    cancel: (runId, ownerKey) => deps.registry.requestCancel(runId, ownerKey),
  };
}

async function run(
  deps: RunManagerDeps,
  validator: ReturnType<typeof createFrameValidator>,
  start: RunStart,
  body: RunBody,
): Promise<RunFinal> {
  const { ticket, sink } = start;
  const { runId, sessionId } = ticket;
  const { config, registry, scheduler } = deps;
  let guard = deps.guard;
  const writer = new StreamWriter({ sink, validator });
  const bodyAbort = new AbortController();
  const waits = new AbortController();
  const deadline = ticket.acceptedAtMs + config.maxRunMs;
  let stopped = false;
  let connected = true;
  let cardsDelivered = 0;
  // B3-08zc (BR-AI-19 细则「助手回复落库」): the reply as this run delivered it, stored with the
  // terminal state by admission.settle — written or not (a client gone within the grace).
  let replyText = '';
  const replyCards: CardInput[] = [];
  // Their card_ids whose frame was not written: no receipt now, delivery records at the ending.
  const unframed: string[] = [];
  let cardQueue = Promise.resolve();
  let factsQueue = Promise.resolve();
  let endingSaved: Promise<void> | undefined;
  let resolveEnd!: (end: End) => void;
  const ended = new Promise<End>((resolve) => {
    resolveEnd = resolve;
  });

  const errorEnd = (code: number, ending: RunEnding, retryable: boolean): End => ({
    ending,
    event: 'error',
    error: { code, msg: deps.texts.errorMsg(code), retryable, fallback: null },
  });

  // All contenders enter here synchronously, before any persistence or abort callbacks.
  // Normal completion stops context writes too, but does not abort the body's signal.
  function choose(end: End, reason?: AbortReason): void {
    if (stopped) return;
    stopped = true;
    endingSaved = registry
      .recordEnding?.(runId, { ending: end.ending, cardsDelivered }, draftOf(end))
      .catch(() => undefined);
    waits.abort();
    if (reason !== undefined) bodyAbort.abort(reason);
    resolveEnd(end);
  }

  function interrupt(reason: AbortReason): void {
    if (stopped) return;
    if (reason === 'disabled' || reason === 'consent_withdrawn') {
      choose(errorEnd(reason === 'disabled' ? 30501 : 10004, reason, false), reason);
      return;
    }
    choose(
      {
        ending: reason,
        event: 'done',
        finishReason: reason === 'timeout' ? 'timeout' : 'cancelled',
      },
      reason,
    );
    if (reason === 'timeout') say(deps.texts.text('agent.timeout'));
  }

  function background(work: () => Promise<void>): void {
    void work().catch(() => {
      if (!stopped) choose(errorEnd(50001, 'server_error', true));
    });
  }

  function disconnected(): void {
    if (!connected) return;
    connected = false;
    if (stopped) return;
    background(async () => {
      await scheduler.sleep(config.disconnectGraceMs, waits.signal);
      if (!stopped) interrupt('disconnected');
    });
  }

  function write<E extends StreamEvent>(event: E, data: StreamEventInput[E]): boolean {
    if (!connected || writer.closed) return false;
    try {
      writer.emit(event, data);
      return true;
    } catch (error) {
      // Protocol errors leave the writer open; socket failures close it, even when a sink
      // happens to throw a StreamProtocolError. Uncertain delivery must never be retried.
      if (!writer.closed) throw error;
      disconnected();
      return false;
    }
  }

  /** A text.delta of the reply: framed while connected, kept for the stored reply either way. */
  function say(delta: string): void {
    // A refused (invalid) frame throws before anything is kept.
    write('text.delta', { delta });
    replyText += delta;
  }

  /** Whether `card` would pass the writer's check as the next frame (it is not written). */
  function frameable(card: CardInput): boolean {
    const id = writer.seq + 1;
    let data: Record<string, unknown>;
    try {
      data = { ...(JSON.parse(JSON.stringify(card)) as Record<string, unknown>), seq: id };
    } catch {
      return false;
    }
    return validator({ event: 'card', id, data }).ok;
  }

  function live(): boolean {
    if (!stopped && deps.clock.now().getTime() >= deadline) interrupt('timeout');
    return !stopped;
  }

  async function saveFacts(facts: RunFacts, draft?: TerminalDraft): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await registry.recordFacts(runId, facts, draft);
        return;
      } catch {
        // Delivery already happened: keep the actual count and the chosen ending in memory.
        // A failed save must neither reject the queue nor turn revocation into server_error.
      }
    }
    deps.logger?.error(
      { run_id: runId, ending: facts.ending, cards_delivered: facts.cardsDelivered },
      'agent.run_facts_unconfirmed',
    );
  }

  const ctx: RunContext = {
    runId,
    sessionId,
    signal: bodyAbort.signal,
    get cardsDelivered() {
      return cardsDelivered;
    },
    text(delta): void {
      if (live()) say(delta);
    },
    toolStatus(tool, phase, displayText): void {
      if (live()) write('tool.status', { tool, phase, display_text: displayText });
    },
    suggestions(items): void {
      if (live()) write('suggestions', { items });
    },
    async card(input, delivered): Promise<void> {
      if (!live()) return;
      // Detach before awaiting a reservation. Serialize reservations and delivery so card ids
      // remain in delivery order even when the body calls card() concurrently.
      const snapshot = numberCard(input, 1);
      const pending = cardQueue.then(async () => {
        if (!live()) return;
        const first = await deps.cards.reserve(sessionId, snapshot.used);
        if (!live()) return;
        const numbered = numberCard(snapshot.card, first);
        const written = write('card', numbered.card);
        // B3-08zc: a card not framed (the client is gone) is still numbered and stored with the
        // reply, but only a valid one (a written frame was checked by the writer).
        if (!written && !frameable(numbered.card)) {
          throw new StreamProtocolError('invalid_frame', 'Invalid card');
        }
        replyCards.push(structuredClone(numbered.card));
        // Kept for the stored reply only: no receipt (B3-05i: the model never references a card
        // whose frame was not written), not counted as delivered. The terminal transaction writes
        // its delivery records, so later rounds can reference it (BR-AI-19, the reply is stored).
        if (!written) {
          unframed.push(numbered.card.card_id);
          return;
        }
        // Notices are delivered as card frames but do not count toward quota refund eligibility.
        if (numbered.card.type !== 'notice') cardsDelivered += 1;
        // B3-08q: told of the written frame (best effort, never ends the run).
        try {
          deps.onCardWritten?.(runId, numbered.card);
        } catch {
          // An observer never changes the run.
        }
        // B3-05i: the receipt, only for a frame actually written.
        delivered?.(numbered.card.card_id);
        const facts = { ending: null, cardsDelivered };
        factsQueue = factsQueue.then(() => saveFacts(facts));
        await factsQueue;
      });
      // Rejected invalid cards do not poison subsequent calls. The caller still sees rejection.
      cardQueue = pending.catch(() => undefined);
      await pending;
    },
  };

  function bodyEnded(result: RunBodyResult): void {
    if (!live()) return;
    if (result.kind === 'error') {
      // Preserve a valid error verbatim, but never persist a malformed final frame.
      const error = structuredClone(result.error);
      if (!validator({ event: 'error', id: writer.seq + 1, data: error }).ok) {
        throw new StreamProtocolError('invalid_frame', 'Invalid body terminal');
      }
      choose({
        ending: error.code >= 50_000 && error.code < 60_000 ? 'server_error' : 'client_error',
        event: 'error',
        error,
      });
    } else {
      choose({
        ending:
          result.ending ?? (result.finishReason === 'error' ? 'server_error' : result.finishReason),
        event: 'done',
        finishReason: result.finishReason,
      });
    }
  }

  async function poll(ms: number, check: () => Promise<void>): Promise<void> {
    let due = scheduler.now() + ms;
    while (!stopped) {
      await scheduler.sleep(Math.max(0, due - scheduler.now()), waits.signal);
      if (stopped) return;
      // A failed read is retried on the next poll; it does not become a user cancellation.
      try {
        await check();
      } catch {
        // The acceptance deadline continues independently of this dependency.
      }
      // Read latency consumes this interval, rather than extending every polling period.
      due = Math.max(due + ms, scheduler.now());
    }
  }

  async function checkGuard(): Promise<void> {
    const timeout = new AbortController();
    try {
      // The timeout releases polling, not the observation of this query's result. A late
      // revocation still interrupts a live run; choose() protects an already chosen ending.
      await Promise.race([
        guard.check().then((answer) => {
          if (answer !== null) interrupt(answer.code === 30501 ? 'disabled' : 'consent_withdrawn');
        }),
        scheduler
          .sleep(GUARD_READ_TIMEOUT_MS, AbortSignal.any([waits.signal, timeout.signal]))
          .then(() => {
            throw new Error('Run guard read timed out');
          }),
      ]);
    } finally {
      timeout.abort();
    }
  }

  sink.onClose(disconnected);
  try {
    try {
      if (deps.guardFor !== undefined && start.appId !== undefined) {
        guard = deps.guardFor({ appId: start.appId, ownerKey: start.ownerKey, runId });
      }
      await registry.register({ runId, sessionId, ownerKey: start.ownerKey });
    } catch {
      // Admission has charged the run; registration or guard construction failure must settle.
      choose(errorEnd(50001, 'server_error', true));
    }
    const metaWritten = write('meta', { ...start.meta, session_id: sessionId, run_id: runId });
    if (!metaWritten) {
      interrupt('disconnected');
    } else if (live()) {
      background(async () => {
        await scheduler.sleep(Math.max(0, deadline - deps.clock.now().getTime()), waits.signal);
        interrupt('timeout');
      });
      background(async () => {
        // A fixed cadence bounds every gap between writes, including while frames are flowing.
        while (!stopped) {
          await scheduler.sleep(config.heartbeatMs, waits.signal);
          if (stopped || !connected) return;
          try {
            writer.ping();
          } catch (error) {
            if (!writer.closed) throw error;
            disconnected();
            return;
          }
        }
      });
      background(() =>
        poll(config.signalPollMs, async () => {
          if (await registry.cancelRequested(runId)) interrupt('cancelled');
        }),
      );
      background(() => poll(Math.min(config.guardPollMs, MAX_GUARD_POLL_MS), checkGuard));
      // A body ignoring its signal never blocks the tail. Both fulfillment and rejection of
      // a late body are observed, with choose() preventing any second ending.
      background(async () => bodyEnded(await body(ctx)));
    }

    const end = await ended;
    // Wait only for facts from writes that actually succeeded, never for an outstanding card
    // reservation or body. A late live fact cannot overwrite the final ending.
    await endingSaved;
    await factsQueue;
    const outcome = { ending: end.ending, cardsDelivered };
    const draft = draftOf(end);
    // Always save a fresh final snapshot, even after all live saves failed. Exhausted retries
    // are logged, but must not prevent the admission gate releasing the lock. The draft keeps
    // the complete chosen result recoverable if this process dies after settle, before finish.
    await saveFacts(outcome, draft);
    // B3-08zc: the reply goes into the terminal transaction (nothing is added after the ending).
    const reply = {
      text: replyText,
      cards: replyCards.map((card) => structuredClone(card)),
      unframed: [...unframed],
    };
    const settled = await deps.admission.settle(ticket, outcome, start.limits, reply);
    const terminal: TerminalFrame =
      draft.event === 'done'
        ? {
            event: 'done',
            data: { ...draft.data, quota_left: settled.quotaLeft },
          }
        : draft;
    const sent = (await registry.finish(runId, terminal)) ?? terminal;
    if (sent.event === 'done') write('done', sent.data);
    else write('error', sent.data);
    return { terminal: sent, ...outcome };
  } finally {
    stopped = true;
    waits.abort();
  }
}

function draftOf(end: End): TerminalDraft {
  return end.event === 'done'
    ? { event: 'done', data: { finish_reason: end.finishReason } }
    : { event: 'error', data: end.error };
}
