// Archive override of the transactional mode (task B1-01zzs; orchestrator D10-1099 Q-6 (B), from
// the B1-20c plan §8.1 Q-6; 规划/04 §3.2 sessions「token 只存哈希」). POST /v1/auth/merge answers
// with the target account's access / refresh tokens; the stored record of the key must not carry
// them. The rule tests in test/spec/platform/idempotency-archive-override/** pin this contract.
//
// `executeInTransaction(request, handler, options?)` takes an optional third argument of type
// IdempotencyArchiveOptions (`execute`, the standard mode, gets no such option). With
// `options.archive` a function:
//   - The response returned to this caller is unchanged: the handler's status and
//     JSON.stringify(handler envelope), source 'handler'. It is fixed before `archive` runs, so an
//     `archive` that changes the object it is given does not change the returned body.
//   - Only for a result that is stored (code 0 or 30000–39999, section 4 of ./index.ts),
//     `archive` is called exactly once, with the handler's envelope (equal by value). The record's
//     `response` becomes {"status": <the handler's status>, "body": JSON.stringify(<what archive
//     returned>)} (the returned object's key order is kept) instead of the handler's body.
//     Every other column of the row (scope, user_id, request_hash, status 'completed', created_at,
//     expire_at) is what it would be without the option, and the handler's writes through `trx`
//     commit with it, as before.
//   - A later request of the key replays what was stored — the archived body, byte for byte,
//     source 'replay' — whatever options that later request passes; neither the handler nor any
//     `archive` runs then. Different body → 20901, as before.
//   - A result that is not stored (1xxxx, 2xxxx, 4xxxx, 5xxxx): unchanged — the handler's response
//     is returned, everything is rolled back, no row; `archive` is not called.
//   - `archive` is synchronous. It throws → the same error object is rethrown unchanged and
//     everything is rolled back, no row, as for a handler that throws.
//   - `archive` returns anything but a valid envelope — the rules of HandlerResult.envelope in
//     ./index.ts (plain object; integer `code` ≥ 0; string `msg`; string `trace_id`; optional
//     `data` that canonicalJson accepts, so no undefined, NaN, class instance … at any depth) — or
//     an envelope whose `code` differs from the handler's (the storing decision and a later replay
//     must agree) → IdempotencyError('invalid_result'), everything rolled back, no row. Returning
//     undefined is invalid too: a forgotten return never falls back to storing the handler's body.
//   - Options absent, undefined, `{}` or `{ archive: undefined }`: exactly the behaviour before
//     this task (the stored body is the returned body).
//   - Nothing new is logged; the archived envelope and the handler's envelope are never logged.
//
// Also compiled by the `test` project: erasable syntax only. The envelope shape below matches
// ResponseEnvelope of ./index.ts structurally; it is declared here so that ./index.ts can import
// this file without a cycle (as ./stored-rejection.ts does).

interface ArchivedEnvelope {
  readonly code: number;
  readonly msg: string;
  readonly data?: unknown;
  readonly trace_id: string;
}

/** The optional third argument of executeInTransaction (see above). */
export interface IdempotencyArchiveOptions {
  /** Given the handler's envelope of a stored result; returns the envelope to store instead. */
  readonly archive?: ((envelope: ArchivedEnvelope) => ArchivedEnvelope) | undefined;
}
