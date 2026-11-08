// RunManager: the life cycle of one Agent run (B3-03b; 规划/02 §9.1–9.2 「取消与断线」, 04 §8.1–8.2,
// BR-AI-23 细则「受理记录与收尾」, BR-AI-13 撤回同意, BR-AI-12 agent.enabled 关闭, BR-AI-14 细则
// 「单轮时限」). Frames are written only through StreamWriter (../writer, B3-03a); the quota is settled
// only through Admission.settle (../admission, B3-03c; refunds are decided there). The rule tests in
// test/spec/agent/stream-run/** import this file by path: names, signatures and the semantics
// written here are the contract. Out of scope: HTTP wiring and steps ①–⑥ (B3-03d), the Orchestrator
// (B3-05), OutputGuard (B3-06), trace (B3-09).
//
// runConfigDefaults(): heartbeatMs 15 000 (04 §8.1), maxRunMs 20 000 (BR-AI-14 细则「单轮时限」),
// disconnectGraceMs 60 000 (02 §9.2), guardPollMs ≤ 10 000 (BR-AI-12, BR-AI-13 「10 秒内」),
// signalPollMs (cross-instance cancel poll; agent default, positive). Every value is configurable;
// guard polling is capped at 5 seconds, with a 2-second read timeout, to leave termination margin.
//
// numberCard(card, firstNo): pure. The frame takes c<firstNo>; then, in order, each
// product_list data.items[i] or the rebate_quote data.product takes the next number (04 §8.2
// 「card」: frame first, then embedded items). No other type (unknown types included) has embedded
// ids. used = how many numbers were taken. The input is not modified.
//
// createRunManager(deps).start(start, body):
//   1. registry.register({runId, sessionId, ownerKey}) and the meta frame first (session_id and
//      run_id from the ticket, the rest from start.meta; duplicate false or absent); body is called
//      only after meta was written. When the meta write fails (sink throws or is closed), the body
//      is not called and the run ends at once as disconnected; the tail (step 4) still runs.
//   2. While the run is live: pings (`: ping`, no seq) so that no gap between two writes (frame or
//      ping) exceeds heartbeatMs; when idle, the ping comes exactly heartbeatMs after the last write
//      (a fixed 15-second period also satisfies this); registry.cancelRequested polled every signalPollMs; guard.check() polled at
//      least every guardPollMs (throws/timeouts allow the next round; a late revocation still
//      terminates a live run); the time
//      limit at ticket.acceptedAtMs + maxRunMs (epoch ms of the Clock: counted from acceptance, not
//      from start); after the sink closes, an abort at close + disconnectGraceMs.
//      All waiting goes through deps.scheduler (monotonic) and the current instant through
//      deps.clock; no bare timers.
//   3. Endings (the first one wins; the signal aborts once with the AbortReason as reason):
//      cancel → done cancelled; time limit → text.delta texts.text('agent.timeout'), done timeout;
//      guard 30501 → error{30501, texts.errorMsg(30501), retryable false, fallback null}, ending
//      disabled; guard 10004 → the same with 10004, ending consent_withdrawn; disconnect → nothing
//      more is written to the sink, ending disconnected, and the terminal that is saved (not sent)
//      is done{finish_reason 'cancelled', quota_left} (agent default: no rule names a disconnect
//      frame; 04 §3.2 final_event is set for every ended run, for the 04 §8.1 duplicate replay); body done → done with its finish_reason
//      (ending = the same name, or `ending` when given; finish_reason 'error' → server_error);
//      body error → that error frame as given, ending server_error for 5xxxx (client_error
//      otherwise); body throws → error{50001, texts.errorMsg(50001), retryable true, fallback null},
//      ending server_error. A body result arriving after another ending is ignored; ctx calls after
//      the abort write nothing.
//   4. Tail (BR-AI-23 细则「受理记录与收尾」), each step awaited before the next starts:
//      registry.recordFacts(runId, {ending, cardsDelivered}, draft) (the run facts other instances read
//      when they complete a crashed run's tail), then admission.settle(ticket, {ending,
//      cardsDelivered}, start.limits) exactly once, then registry.finish(runId, terminal) (every
//      ending has a terminal), then the terminal frame when the sink is open (done.quota_left =
//      settle's quotaLeft), then start() resolves with that terminal in RunFinal. A step starts
//      only after the previous one's promise resolved (saved, not just called). Write failures (closed or failing sink) are silent and never skip the
//      settle. cardsDelivered counts card frames whose write succeeded; after each such card,
//      before ctx.card resolves, recordFacts(runId, {ending: null, cardsDelivered}) is saved too.
//      Fact saves retry once on rejection; exhausted retries mark facts unconfirmed and do not
//      block later saves or settlement. The tail always tries the final snapshot again and exposes
//      failed confirmation through the injected logger, never RunFinal. Registration failure also
//      settles server_error. The draft contains complete error data or done.finish_reason; recovery
//      reads registry.draft(runId) and adds quota_left only after settlement, before finish.
//   ctx.card reserves numbers with cards.reserve(sessionId, used) and writes the numbered card; an
//   invalid card rejects with StreamProtocolError('invalid_frame') and the run goes on. B3-08q:
//   deps.onCardWritten, when given, gets (runId, the written card) right after each card frame
//   write that succeeded (the stream mount's run trace, BR-AI-19); a throw there is ignored.
// cancel(runId, ownerKey) → registry.requestCancel (not owner, unknown or finished: 'not_found').
//
// createRedisRunRegistry: uses only RedisNamespace.get and set (no eval), every set with
// deps.ttlSeconds; instances sharing one namespace see each other's runs, cancel requests, run facts
// and final frames (cross-instance cancel; a new instance reads what an old one saved). Two
// instances interleaving their get/set never lose each other's writes: a cancel request, the saved
// card count (only grows, 04 §3.2 card_delivered) and the final frame survive a concurrent write
// from an instance holding an older read (e.g. one key per fact instead of one JSON). The
// database columns behind the facts and the recovery wiring belong to B3-03d / 12 X-10.
//
// Rules for the implementation: also compiled by the `test` project: erasable syntax only,
// `import type` for type-only imports, relative imports with `.ts`, no NestJS, no process.env,
// time only from the injected Clock and Scheduler.
export * from './types.ts';

export { numberCard } from './cards.ts';
export { createRedisRunRegistry } from './registry.ts';
export { createRunManager } from './manager.ts';
