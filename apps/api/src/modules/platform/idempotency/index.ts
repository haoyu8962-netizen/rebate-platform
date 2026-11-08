// Idempotency-Key handling and the abandon primitive of the sensitive operations (规划/04 §5「幂等」,
// §3.2 idempotency_keys, §6.1 POST /v1/idempotency-keys/abandon, §7 20901 / 20903 / 40901; 08
// BR-WDR-07 幂等段, BR-ID-01 ④, BR-ID-08, BR-ID-10 细则「敏感操作的幂等键」, BR-ID-30 ⑤; 规划/02 §18
// 「幂等 API」: idempotency_keys plus the business unique constraints as the last line).
// Implementation contract for task B1-01i. The rule tests
// in test/spec/platform/idempotency/** import this file by path; the names, signatures and
// semantics written here are the contract. Table shape: db/schema.sql (idempotency_keys after
// migration 0004: request_hash and response null exactly on abandoned rows; status processing /
// completed / abandoned; UNIQUE (app_id, subject, method, path, key)).
//
// 1. Who owns a key — `subjectOf(actor)` (规划/04 §5「幂等」)
//    actor = { userId, deviceId, phoneHmac }, each a string or null; the first non-null wins:
//      userId     → `u:<userId>`      logged-in request (the token's user)
//      deviceId   → `d:<deviceId>`    anonymous request with X-Device-Id
//      phoneHmac  → `p:<phoneHmac>`   landing page without a device (POST /v1/invites/landing-register;
//                                      the caller normalises the phone per BR-ID-05 and passes the
//                                      blind index of platform/crypto)
//    Formats (else IdempotencyError('invalid_subject')): userId and deviceId are lowercase
//    canonical UUID strings (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/; both
//    are UUIDv7 issued by the server, 04 §5「字段」); phoneHmac is 64 lowercase hex characters. All
//    three null → IdempotencyError('invalid_subject'). Only the winning value is checked; the
//    later ones are ignored entirely (whatever they hold). The record's `user_id` column is
//    userId for a `u:` subject, else null.
//    Admin accounts (task B2-15e; 04 §5「幂等」, D10-168 ②): the optional `adminUserId` (the
//    admin token's admin_users.id, same UUID format) → `a:<adminUserId>`, the record's user_id
//    null. It is set only on /admin/v1 requests, where the other three are null; set but
//    malformed → IdempotencyError('invalid_subject'). Absent or null: the order above, unchanged.
//
// 2. The key — header Idempotency-Key, contract schema IdempotencyKey: 8 to 64 characters of
//    [A-Za-z0-9_-] (contracts/openapi.yaml). Missing (undefined), empty or outside the format →
//    the response is 20001 (section 5), the handler does not run, the database is not touched.
//
// 3. The request hash — `requestHashOf(body)` = lowercase hex SHA-256 of the UTF-8 bytes of
//    `canonicalJson(body)` (BR-WDR-07: sha256(键名排序、无空白的规范化 JSON)).
//    `canonicalJson(body)`: `body` is the parsed JSON request body.
//      - undefined (no body at all) → '' (the empty string); this differs from null → 'null'.
//      - null, booleans, strings, finite numbers → JSON.stringify of the value (so -0 → '0',
//        1.0 → '1', strings keep JSON.stringify's escaping).
//      - arrays → '[' elements in their order, each canonical, joined by ',' ']'.
//      - plain objects (prototype Object.prototype or null) → '{' then for each own enumerable
//        string key, sorted by UTF-16 code units (the default Array.prototype.sort order, as RFC
//        8785), JSON.stringify(key) ':' canonical(value), joined by ',' '}'. Nothing is dropped:
//        a key whose value is null stays.
//      - no whitespace anywhere outside strings.
//      - anything else, at any depth (undefined inside an object or array, NaN, ±Infinity,
//        bigint, symbol, function, Date, Map, Buffer, any other class instance) →
//        IdempotencyError('invalid_request').
//      - nesting deeper than MAX_CANONICAL_DEPTH (256) arrays / objects (the top-level array or
//        object is depth 1; task B1-01zt) → IdempotencyError('invalid_request'), raised before
//        the encoder recurses that deep, so a deeply nested body never overflows the stack (a
//        RangeError would end as 50001). isNestingTooDeep(error) tells this error apart from the
//        other invalid_request errors (the HTTP layer answers it as 20001 with data.fields
//        ['body']); the mark lives outside the error object, which keeps section 10's own
//        properties.
//    Only the body is hashed: method, path, app and subject are part of the unique key instead.
//
//    Keyed request digest (task B1-01zzf; 08 BR-WDR-07: 请求体含个人敏感信息的幂等操作改用带密钥摘要
//    HMAC-SHA256, 密钥同 FieldCrypto 盲索引, 按密钥版本记录). A request with
//    `keyedRequestDigest: true` (the caller's explicit choice; omitted or false keeps the SHA-256
//    above unchanged, requestHashOf included) stores request_hash =
//    KEYED_REQUEST_DIGEST_PREFIX ('hmac1:', 1 = version 1 of the blind-index key; a new blind-index
//    key would become 'hmac2:') + options.fieldCrypto.blindIndex(canonicalJson(body),
//    KEYED_REQUEST_DIGEST_CONTEXT) — the same canonical JSON as the SHA-256 path, 64 lowercase hex
//    characters. No unkeyed SHA-256 is written for such a request (new rows and lease takeovers
//    alike). Comparison with a stored request_hash for such a request: a value with the 'hmac1:'
//    prefix is compared with the keyed digest; an unprefixed value (a row written before this task)
//    with the SHA-256 of the same body; equal → the same request, anything else → 20901 (or 40901
//    under contention, as below); a prefixed value never falls back to the SHA-256 comparison.
//    FieldCrypto not injected, throwing, or returning anything but 64 lowercase hex characters →
//    the call rejects with RequestDigestUnavailable (the HTTP layer answers 50001) before the
//    database is touched: no lookup, so no replay of an older SHA-256 row either, no write, no
//    handler, and never a fallback to SHA-256. Requests without the option never call FieldCrypto.
//
// 4. One request — `idempotency.execute(request, handler)` (standard operations) and
//    `idempotency.executeInTransaction(request, handler)` (the four sensitive operations).
//    request = { appId, actor, method, path, key, body, traceId }:
//      appId    the token's app_id, non-empty string
//      method   'POST' | 'PUT' | 'PATCH' | 'DELETE'
//      path     the concrete request path (path parameters filled in, so POST /v1/links/A/open and
//               POST /v1/links/B/open never share a record), starting with '/', without query
//               string or fragment (no '?' or '#')
//      key      the Idempotency-Key header value or undefined
//      body     the parsed JSON body (undefined when none)
//      traceId  the request's trace id; goes into every envelope this module builds
//      keyedRequestDigest  optional, true only for a body with personal data (section 3)
//    Bad appId / method / path / body → IdempotencyError('invalid_request') before anything else
//    (a programming error, not a client error); bad actor → 'invalid_subject'.
//    Scope of a record: (app_id, subject, method, path, key) — exactly the unique constraint.
//
//    Decision for an existing committed record of the scope (BR-ID-01 ④; BR-WDR-07 ⓪):
//      abandoned                      → 20903, without comparing the hash (BR-ID-10 细则)
//      completed, same request_hash   → replay: the stored status and body, byte for byte
//      completed, other request_hash  → 20901
//      processing (live)              → 40901, whatever the hash (待编排会话确认: 04 and BR-WDR-07
//                                       do not order 40901 against 20901 for a running request;
//                                       a running sensitive request is not visible at all, so the
//                                       standard mode answers 40901 as well)
//    Contention (task B1-01zt): both modes take the scope's advisory lock without waiting; when
//    another request holds it, the scope is read once without the lock (the committed state at
//    that moment): completed with the same request_hash → that replay; anything else (no visible
//    row, processing, abandoned, completed with another hash) → 40901. So concurrent retries of a
//    finished request all get the original response, and a different body under contention
//    still gets 40901 (20901 once the lock is free).
//    In each of these cases the handler is not called. Replay comes before everything the
//    handler checks (ban, version gate, step-up: BR-ID-01 ④ before ④a–⑮, BR-ID-08), so a
//    completed record is returned without calling the handler even when it would now refuse.
//
//    What is stored (BR-WDR-07; 04 §5): the handler's result is stored when its envelope `code`
//    is 0 or 30000–39999. Any other code (1xxxx, 2xxxx, 4xxxx, 5xxxx) is not stored: the key has
//    no record afterwards and the same key may be sent again (step-up replay with the original
//    key, BR-ID-08; transport retries). A handler that throws (or rejects) stores nothing either;
//    the same error object is rethrown unchanged.
//    Stored form: `response` jsonb is exactly {"status": <HTTP status>, "body": <body string>}
//    where the body string is the exact text returned to the first caller (section 5); a replay
//    returns that string unchanged (no re-serialisation: jsonb would reorder object keys).
//
//    Standard mode — `execute(request, handler: () => Promise<HandlerResult>)`:
//      - Refuses the four sensitive (method, path) pairs of section 6 with
//        IdempotencyError('transactional_required') (they must use executeInTransaction).
//      - No record: inserts a `processing` row (request_hash set, response null) and commits it
//        on its own, then calls the handler outside any transaction of this module. Concurrent
//        requests of the same scope: exactly one inserts (the unique constraint decides; a
//        conflict is never surfaced as an error, the loser re-reads and decides as above), the
//        others get 40901 while the row is processing.
//      - After the handler: stored result → the row becomes `completed` with `response`; result
//        not stored, or the handler threw → the row is deleted. Both updates are conditional on
//        the row still being this request's processing row (same id, status processing, same
//        created_at). If it is not (taken over, see the lease), nothing is written, exactly one
//        line is logged — `options.logger.warn({ method, path }, 'idempotency_record_lost')` —
//        and the handler's response is still returned (source 'handler').
//      - The `completed` write fails (task B1-01zh: the handler has already had its effect, so a
//        50001 "failure" would be untrue): it is retried a bounded number of times
//        (COMPLETION_ATTEMPTS, waits COMPLETION_RETRY_DELAYS_MS, well under a second in all),
//        each attempt with the same ownership condition (a takeover in between →
//        idempotency_record_lost as above, the taker's row is never overwritten). An attempt that
//        succeeds returns the handler's response. The whole of it (every attempt, connection
//        acquisition included, and the waits) has a client-side deadline,
//        COMPLETION_DEADLINE_MS, measured with a timer only (no clock read): a write that hangs
//        (network gone, TCP not yet reporting it; the pool has no acquire or query timeout) is
//        no longer awaited when it passes, no further attempt starts, and the request is
//        treated as "every attempt failed" below, so neither the request nor shutdown (HTTP
//        close waits for requests in flight) waits on the database. The abandoned write is left
//        to settle on its own: its rejection is swallowed, and it logs and changes nothing more.
//        If it later succeeds it is an ordinary `completed` write under the same ownership
//        condition (the stored response is the handler's own; a later retry of the key replays
//        it), which is acceptable; if it finds the row taken over it writes nothing. If every
//        attempt fails, the row is left as it is (processing, not deleted, not changed), exactly
//        one line is logged —
//        `options.logger.error({ method, path, attempts }, 'idempotency_completion_unknown')`
//        (warn when the logger has no error; never the driver error, whose message or detail
//        may carry parameters) — and the call rejects with IdempotencyError('outcome_unknown'),
//        which the HTTP layer answers by closing the connection as for the transactional mode.
//        The key then answers 40901 until the lease expires; a takeover after that runs the
//        handler again. This makes the answer honest, it does not make an external call happen
//        only once: the transactional mode protects only writes in this database, so a
//        per-call-billed external call needs its own idempotency and recovery.
//        The delete after a thrown or unstored handler is not retried (unchanged). After an
//        unstored result its failure rejects with the driver's error. After a thrown handler
//        (task B1-01zt) the handler's error is still rethrown unchanged; the failed delete only
//        logs one line — `error` (else warn) `({ method, path }, 'idempotency_cleanup_failed')`,
//        never the driver error, a body or a key — and the row stays processing (40901 until the
//        lease expires, then a takeover). The key is not stored either way.
//      - Lease (待编排会话确认; no document gives a value): a processing row whose created_at is
//        at least `processingLeaseMs` (default 60 000) before clock.now() is stale (its process
//        died or hangs): the next request of the scope takes it over atomically (conditional
//        update: request_hash of the new request, created_at and expire_at from now) and runs
//        its handler, whatever the old hash was. created_at more recent than that → 40901. The
//        business unique constraints are the last line against a double effect (规划/02 §18).
//
//    Transactional mode — `executeInTransaction(request, handler: (trx) => Promise<HandlerResult>)`
//    for the four step-up operations (BR-ID-10 细则「敏感操作的幂等键」「作废与业务结果互斥」;
//    BR-WDR-07 ⑧; 04 §3.2):
//      - One database transaction holds the key, calls the handler with it (`trx`, a Kysely
//        Transaction bound to schema app like the db handle) and writes the record. The business
//        writes the handler makes through `trx` and the record commit together or not at all.
//      - No processing row is ever committed for these operations: while the handler runs, no
//        other session can see any row of the scope (a process that dies leaves no trace; the
//        key goes back to "no record").
//      - A request of the same scope arriving while such a transaction is open gets 40901 without
//        waiting for that transaction to end (a short bounded wait is acceptable; the rule tests
//        allow 3 s while the first transaction stays open for longer). Suggested: a transaction-
//        scoped advisory lock taken with pg_try_advisory_xact_lock on a hash of the scope
//        (two-int4 form, so it never collides with the one-bigint locks of BR-WDR-07 ③), plus
//        INSERT … ON CONFLICT DO NOTHING on the unique constraint, which stays the arbiter.
//      - Existing committed record → decided as above (abandoned → 20903 and the handler never
//        runs, so a key abandoned while the vendor call of PUT /v1/me/payout-account ran makes
//        that request roll back as a whole with 20903, BR-ID-10 细则).
//      - Stored result → commit with the `completed` row. Result not stored → roll back
//        everything (the handler's writes too) and return the response. Handler threw → roll
//        back, rethrow the same error.
//      - The commit itself fails (outcome unknown, e.g. the connection dropped during COMMIT) →
//        one line `error` (else warn) `({ method, path }, 'idempotency_commit_unknown')` (task
//        B1-01zt; never the driver error, a body or a key; also for the claim commit of the
//        standard mode) and reject with IdempotencyError('outcome_unknown'): the HTTP layer must then answer without
//        the envelope (close the connection), BR-ID-10 细则「服务端的配合」. A failure before
//        COMMIT rolls back and rejects with the driver's error.
//      - Optional third argument `{ archive }` (task B1-01zzs; contract in ./archive.ts): for a
//        stored result the record keeps what `archive` returns instead of the handler's body;
//        the caller still gets the handler's response. Absent → unchanged.
//
//    HandlerResult = { status, envelope }: status an integer 200–599; envelope a plain object
//    with integer `code` ≥ 0, string `msg`, string `trace_id` and optional `data`. The body is
//    JSON.stringify(envelope) — the handler's key order is kept. Anything else →
//    IdempotencyError('invalid_result'), handled like a thrown handler (row deleted / rolled
//    back, nothing stored).
//    IdempotentResponse = plain object with exactly { status, body, source }:
//      source 'handler'      the handler ran in this call (body = JSON.stringify(envelope))
//             'replay'       a stored response, unchanged
//             'idempotency'  an envelope this module built (section 5) or the abandon result
//
// 5. Envelopes this module builds (contract ErrorEnvelope; contracts/error-codes.yaml http):
//    body = JSON.stringify of an object whose keys are in this order: code, msg, data (only when
//    listed), trace_id = request.traceId.
//      20001  HTTP 400  msg 'Idempotency-Key is missing or malformed'  data {"fields":["idempotency-key"]}
//      20901  HTTP 409  msg 'Idempotency-Key was used with a different request body'
//      20903  HTTP 409  msg 'Idempotency-Key was abandoned'
//      40901  HTTP 409  msg 'a request with this Idempotency-Key is in progress'
//    The field name is the header name lower-cased, as platform/validation names header fields.
//
// 6. Sensitive operations — `SENSITIVE_OPERATIONS` (04 §5 step-up row; BR-ID-08):
//      withdraw               POST /v1/withdrawals          retention unlimited
//      payout_account_change  PUT  /v1/me/payout-account    retention unlimited
//      phone_change           POST /v1/me/phone             retention 30 days
//      account_deletion       POST /v1/me/deletion          retention 30 days
//    POST /v1/me/phone also serves the first binding (no step-up); the path is shared, so every
//    POST /v1/me/phone uses executeInTransaction.
//
// 7. Retention — `expire_at` (BR-ID-30 ⑤; BR-WDR-07): every row this module writes gets
//    created_at = clock.now() and expire_at = created_at + 30 days (IDEMPOTENCY_RETENTION_MS =
//    2 592 000 000 ms), except the rows of POST /v1/withdrawals and PUT /v1/me/payout-account
//    (any status, abandoned included): expire_at = 'infinity' — "不按 30 天清理，保留期 ≥ 提现单
//    保留期", and the retention of withdrawals is still open (BR-ID-30 ⑫, no deletion task), so
//    these rows are kept (待编排会话确认). A completion keeps the row's created_at and expire_at;
//    a lease takeover sets both anew. The column default now() is never relied on.
//    `purgeExpired()` deletes every row (any status, any app) whose expire_at < clock.now() and
//    resolves with the number deleted; rows with expire_at = 'infinity' are never deleted. The
//    04:00 schedule that calls it belongs to the worker (BR-ID-30): queue/idempotency-purge.ts.
//
// 8. Abandon primitive — `idempotency.abandon({ appId, userId, action, key, traceId })`
//    (04 §6.1; BR-ID-10 细则「作废接口」). The HTTP route is task B1-02; it passes the token's
//    app_id and user and the request body's action and idempotency_key.
//      - action not one of the four of section 6 and/or key outside the format of section 2 →
//        20001 (HTTP 400, msg 'invalid abandon request', data {"fields": [...]} listing 'action'
//        and/or 'idempotency_key' in that order); nothing is touched.
//      - userId must pass the userId format of section 1, else IdempotencyError('invalid_subject').
//      - Scope: (appId, `u:<userId>`, method and path of the action, key). Atomically, under the
//        unique constraint: no record → insert {status abandoned, request_hash null, response
//        null, user_id userId, created_at now, expire_at per section 7} and answer abandoned;
//        abandoned record → abandoned again (no second row); completed record → completed with
//        `original`, nothing written; processing record, or the key held by an open transaction
//        of executeInTransaction → 40901 without waiting for it (as in section 4).
//      - Answer: HTTP 200, source 'idempotency', body JSON.stringify of
//        {code: 0, msg: '', data: {outcome, original}, trace_id} where original is null for
//        abandoned, and for completed the stored envelope reduced to {code, msg, data} (in that
//        order; `data` only when the stored envelope has it; no trace_id), unchanged otherwise.
//      - Banned or deleting accounts are not this primitive's concern (10006 / 10007 whitelists
//        are the route's, BR-ID-31, BR-ID-27); it grants no right to run the original operation.
//
// 9. Factory — `createIdempotency({ db, clock, logger, processingLeaseMs?, fieldCrypto? })`
//    fieldCrypto: the FieldCrypto of platform/crypto (only blindIndex is used, section 3); may be
//    absent, then only requests with keyedRequestDigest fail.
//    db: Kysely<DB> bound to schema app (platform/db `db` handle, role couli_app); clock: Clock —
//    the only source of time (no Date.now(), no new Date() without argument, no SQL now() for
//    values written or compared); logger: anything with pino's warn(fields, msg) and, optionally,
//    error(fields, msg) (warn is used in its place when absent).
//    processingLeaseMs: an integer from 1 000 to 600 000 (default 60 000), else
//    IdempotencyError('invalid_option'). Creating touches neither db nor clock.
//
// 10. Logging and errors. The module logs nothing but the lines of section 4 (never a body, a
//     key value, a hash or a stored response). IdempotencyError: name 'IdempotencyError', `code`,
//     the fixed message of its code (IDEMPOTENCY_ERROR_MESSAGES); own properties exactly stack,
//     message, name and code; no cause. Database errors other than the handled unique conflict
//     (and the lock-not-available of the bounded wait) reject with the driver's error.
//
// 11. Wiring (implementation of this task; outside what the rule tests import): PlatformModule
//     provides token IDEMPOTENCY = createIdempotency({ db: DB handle, clock: CLOCK, logger:
//     ROOT_LOGGER, fieldCrypto: FIELD_CRYPTO when provided }) when database handles exist, exported
//     from platform/index.ts. No global HTTP
//     hook or interceptor: controllers / use cases of the operations marked I call execute or
//     executeInTransaction (the transactional handler needs `trx`), after signature and token
//     checks (BR-ID-01 ①–③) and before everything else. The abandon route is B1-02.
//     Stage ④a (B1-03c): every instance carries the post-miss check list of ./post-miss.ts,
//     awaited in both modes after a miss or before an expired-lease takeover, before any write,
//     and an entry observer list called first in both modes (risk uses it to tell "the
//     idempotency module disposed of this request" from "the route never reached it").
//     While a post-miss check runs, idempotencyPostMissTransaction() returns the
//     transaction of the claim that holds the advisory lock, so a check that reads the database
//     reads on that connection instead of borrowing a second one from the pool (a pool full of
//     claims would otherwise wait on itself). It is passed through an AsyncLocalStorage, not as a
//     second argument, so the checks keep the one-argument call the rule tests pin.
//     Stored refusal (B1-02za E21): a check may throw StoredRejection (./stored-rejection.ts,
//     codes 30000–39999 only). The remaining checks and the handler do not run; the claim goes on
//     as for a handler whose result is that refusal (standard mode: processing row, then
//     `completed`; transactional mode: `completed` in the claim's transaction), and later
//     requests of the key replay it. Any other throw rolls back and stores nothing, as before.
//
// 12. Rules for the implementation: this file is compiled by the `test` project too
//     (erasableSyntaxOnly, no decorators): erasable syntax only (no parameter properties, enum,
//     namespace, decorators), no NestJS, `import type` for type-only imports, relative imports
//     with `.ts`. Runtime imports only: `node:crypto`, `node:async_hooks`, `kysely`, and files of
//     this directory;
//     `@couli/db`, `../clock/index.ts` and `../crypto/index.ts` type-only. No process.env.
import type { DB } from '@couli/db';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import type { Clock } from '../clock/index.ts';
import type { FieldCrypto } from '../crypto/index.ts';
import type { IdempotencyArchiveOptions } from './archive.ts';
import { StoredRejection } from './stored-rejection.ts';

export { StoredRejection } from './stored-rejection.ts';
export type { IdempotencyArchiveOptions } from './archive.ts';

/** The four step-up actions (04 §2.5 step_up_action). */
export type StepUpAction =
  'withdraw' | 'payout_account_change' | 'phone_change' | 'account_deletion';

export type IdempotentMethod = 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** Section 6. */
export const SENSITIVE_OPERATIONS: Readonly<
  Record<
    StepUpAction,
    Readonly<{ method: IdempotentMethod; path: string; retention: 'unlimited' | 'default' }>
  >
> = Object.freeze({
  withdraw: Object.freeze({ method: 'POST', path: '/v1/withdrawals', retention: 'unlimited' }),
  payout_account_change: Object.freeze({
    method: 'PUT',
    path: '/v1/me/payout-account',
    retention: 'unlimited',
  }),
  phone_change: Object.freeze({ method: 'POST', path: '/v1/me/phone', retention: 'default' }),
  account_deletion: Object.freeze({
    method: 'POST',
    path: '/v1/me/deletion',
    retention: 'default',
  }),
} as const);

/** 30 days (BR-ID-30 ⑤). */
export const IDEMPOTENCY_RETENTION_MS = 2_592_000_000;

/** Section 4, lease (待编排会话确认). */
export const DEFAULT_PROCESSING_LEASE_MS = 60_000;

/** Section 4, standard mode: attempts at the `completed` write before outcome_unknown. */
export const COMPLETION_ATTEMPTS = 3;

/** Section 4: the wait before each retry of the `completed` write (400 ms in all). */
export const COMPLETION_RETRY_DELAYS_MS: readonly number[] = Object.freeze([100, 300]);

/** Section 4: client-side deadline for the whole `completed` write (attempts and waits). */
export const COMPLETION_DEADLINE_MS = 2_000;

export interface IdempotencyActor {
  readonly userId: string | null;
  readonly deviceId: string | null;
  readonly phoneHmac: string | null;
  /** Section 1 (B2-15e): an admin account's request → `a:<adminUserId>`, user_id null. */
  readonly adminUserId?: string | null;
}

export interface IdempotentRequest {
  readonly appId: string;
  readonly actor: IdempotencyActor;
  readonly method: IdempotentMethod;
  readonly path: string;
  readonly key: string | undefined;
  readonly body: unknown;
  readonly traceId: string;
  /**
   * Section 3, keyed request digest: true for an operation whose body carries personal data
   * (BR-WDR-07). Omitted or false: the unkeyed SHA-256 request hash.
   */
  readonly keyedRequestDigest?: boolean;
}

export interface ResponseEnvelope {
  readonly code: number;
  readonly msg: string;
  readonly data?: unknown;
  readonly trace_id: string;
}

export interface HandlerResult {
  readonly status: number;
  readonly envelope: ResponseEnvelope;
}

export interface IdempotentResponse {
  readonly status: number;
  readonly body: string;
  readonly source: 'handler' | 'replay' | 'idempotency';
}

export interface AbandonRequest {
  readonly appId: string;
  readonly userId: string;
  /** Unvalidated input from the request body. */
  readonly action: string;
  /** Unvalidated input from the request body. */
  readonly key: string;
  readonly traceId: string;
}

/** Anything with pino's `warn(fields, msg)`; `error` is optional (warn stands in for it). */
export interface IdempotencyLogger {
  warn(fields: Readonly<Record<string, unknown>>, msg: string): void;
  error?(fields: Readonly<Record<string, unknown>>, msg: string): void;
}

export interface IdempotencyOptions {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly logger: IdempotencyLogger;
  readonly processingLeaseMs?: number;
  /** Section 3: the blind index of platform/crypto, needed only by keyedRequestDigest requests. */
  readonly fieldCrypto?: Pick<FieldCrypto, 'blindIndex'> | null;
}

export interface Idempotency {
  execute(
    request: IdempotentRequest,
    handler: () => Promise<HandlerResult>,
  ): Promise<IdempotentResponse>;
  executeInTransaction(
    request: IdempotentRequest,
    handler: (trx: Transaction<DB>) => Promise<HandlerResult>,
    /** Archive override (task B1-01zzs; contract in ./archive.ts). */
    options?: IdempotencyArchiveOptions,
  ): Promise<IdempotentResponse>;
  abandon(request: AbandonRequest): Promise<IdempotentResponse>;
  purgeExpired(): Promise<number>;
}

export type IdempotencyErrorCode =
  | 'invalid_option'
  | 'invalid_subject'
  | 'invalid_request'
  | 'invalid_result'
  | 'transactional_required'
  | 'outcome_unknown';

export const IDEMPOTENCY_ERROR_MESSAGES: Readonly<Record<IdempotencyErrorCode, string>> =
  Object.freeze({
    invalid_option: 'processingLeaseMs must be an integer from 1000 to 600000',
    invalid_subject: 'the request has no valid idempotency subject',
    invalid_request: 'the idempotent request is invalid',
    invalid_result: 'the handler returned an invalid result',
    transactional_required: 'this operation must use executeInTransaction',
    outcome_unknown: 'the transaction outcome is unknown',
  });

/** Section 10. */
export class IdempotencyError extends Error {
  readonly code: IdempotencyErrorCode;
  constructor(code: IdempotencyErrorCode) {
    super(IDEMPOTENCY_ERROR_MESSAGES[code]);
    this.name = 'IdempotencyError';
    this.code = code;
  }
}

/** Section 1. */
export function subjectOf(actor: IdempotencyActor): string {
  if (actor == null) throw new IdempotencyError('invalid_subject');
  const admin = actor.adminUserId;
  if (admin !== undefined && admin !== null) {
    // Section 1, admin accounts (B2-15e): `a:<admin_users.id>`, checked like the other UUIDs.
    if (typeof admin !== 'string' || !UUID.test(admin) || admin.includes('\n')) {
      throw new IdempotencyError('invalid_subject');
    }
    return `a:${admin}`;
  }
  for (const [value, prefix, pattern] of [
    [actor.userId, 'u', UUID],
    [actor.deviceId, 'd', UUID],
    [actor.phoneHmac, 'p', /^[0-9a-f]{64}$/],
  ] as const) {
    if (value === null) continue;
    if (typeof value !== 'string' || !pattern.test(value) || value.includes('\n')) {
      throw new IdempotencyError('invalid_subject');
    }
    return `${prefix}:${value}`;
  }
  throw new IdempotencyError('invalid_subject');
}

/** Section 3. */
export function canonicalJson(body: unknown): string {
  if (body === undefined) return '';
  const ancestors = new Set<object>();
  function encode(value: unknown, depth: number): string {
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value))
    )
      return JSON.stringify(value);
    if (typeof value !== 'object' || value === null || ancestors.has(value)) {
      throw new IdempotencyError('invalid_request');
    }
    if (depth > MAX_CANONICAL_DEPTH) {
      const error = new IdempotencyError('invalid_request');
      TOO_DEEP.add(error);
      throw error;
    }
    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        // Array.from visits holes too; sparse arrays must not silently lose values.
        return `[${Array.from(value, (item: unknown) => encode(item, depth + 1)).join(',')}]`;
      }
      if (!isPlainObject(value)) throw new IdempotencyError('invalid_request');
      return `{${Object.keys(value)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${encode(value[key], depth + 1)}`)
        .join(',')}}`;
    } finally {
      ancestors.delete(value);
    }
  }
  return encode(body, 1);
}

/** Section 3: the deepest nesting of arrays / objects canonicalJson accepts (task B1-01zt). */
export const MAX_CANONICAL_DEPTH = 256;

const TOO_DEEP = new WeakSet<object>();

/** Section 3: true only for the invalid_request error of a body nested deeper than the limit. */
export function isNestingTooDeep(error: unknown): boolean {
  return typeof error === 'object' && error !== null && TOO_DEEP.has(error);
}

/** Section 3. */
export function requestHashOf(body: unknown): string {
  return sha256Hex(canonicalJson(body));
}

/** Section 3: the blind-index context of the keyed request digest (its own, no other column's). */
export const KEYED_REQUEST_DIGEST_CONTEXT = 'idempotency.request_hash';

/** Section 3: version 1 of the blind-index key; stored before the 64 hex characters. */
export const KEYED_REQUEST_DIGEST_PREFIX = 'hmac1:';

/**
 * Section 3: a keyedRequestDigest request while FieldCrypto is missing or failing. Thrown before
 * the database is touched; the HTTP layer answers it as 50001. Fixed message, no cause (the
 * FieldCrypto error is not passed on).
 */
export class RequestDigestUnavailable extends Error {
  constructor() {
    super('the keyed request digest is unavailable');
    this.name = 'RequestDigestUnavailable';
  }
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

const HEX64 = /^[0-9a-f]{64}$/;

/** Section 3: 'hmac1:' + blind index of the canonical body; RequestDigestUnavailable otherwise. */
function keyedDigestOf(
  canonical: string,
  fieldCrypto: Pick<FieldCrypto, 'blindIndex'> | null | undefined,
): string {
  if (fieldCrypto == null || typeof fieldCrypto.blindIndex !== 'function') {
    throw new RequestDigestUnavailable();
  }
  let index: unknown;
  try {
    index = fieldCrypto.blindIndex(canonical, KEYED_REQUEST_DIGEST_CONTEXT);
  } catch {
    throw new RequestDigestUnavailable();
  }
  if (typeof index !== 'string' || !HEX64.test(index)) throw new RequestDigestUnavailable();
  return `${KEYED_REQUEST_DIGEST_PREFIX}${index}`;
}

/** Section 9. */
export function createIdempotency(options: IdempotencyOptions): Idempotency {
  const lease =
    options.processingLeaseMs === undefined
      ? DEFAULT_PROCESSING_LEASE_MS
      : options.processingLeaseMs;
  if (!Number.isInteger(lease) || lease < 1000 || lease > 600_000) {
    throw new IdempotencyError('invalid_option');
  }
  const { db, clock, logger } = options;
  const fieldCrypto = options.fieldCrypto;
  // Stage ④a registration points (./post-miss.ts registers into them), read per request.
  const hooks: IdempotencyHooks = { postMiss: [], entry: [] };
  const postMissChecks = hooks.postMiss;

  /** One error line (warn when the logger has no error); fields never carry a body or key. */
  function report(fields: Readonly<Record<string, unknown>>, msg: string) {
    if (typeof logger.error === 'function') logger.error(fields, msg);
    else logger.warn(fields, msg);
  }

  /** First thing of either execute mode, before any validation, lookup or write. */
  function entered(request: IdempotentRequest) {
    for (const observer of [...hooks.entry]) observer(request);
  }

  /**
   * After a miss (or an expired lease about to be taken over), before any write or handler. The
   * checks see the claim's transaction through idempotencyPostMissTransaction().
   */
  async function afterMiss(
    request: IdempotentRequest,
    trx: Transaction<DB>,
  ): Promise<HandlerResult | undefined> {
    return POST_MISS_CONTEXT.run({ trx }, async () => {
      try {
        for (const check of [...postMissChecks]) await check(request);
      } catch (error) {
        // A stored business refusal (./stored-rejection.ts) stands in for the handler's result;
        // anything else propagates unchanged (nothing written, the claim rolls back).
        if (error instanceof StoredRejection) return error.result;
        throw error;
      }
      return undefined;
    });
  }

  async function finish(row: Row, request: IdempotentRequest, response?: IdempotentResponse) {
    // Every attempt (the delete, each completion retry) keeps the ownership condition.
    const owned = sql<boolean>`id = ${row.id} AND status = 'processing'
      AND created_at = ${row.ownership_created_at}::timestamptz`;
    let changed: { id: unknown }[];
    if (response === undefined) {
      changed = await db.deleteFrom('idempotency_keys').where(owned).returning('id').execute();
    } else {
      const complete = () =>
        db
          .updateTable('idempotency_keys')
          .set({
            status: 'completed',
            response: { status: response.status, body: response.body },
          })
          .where(owned)
          .returning('id')
          .execute();
      // Attempts run until one settles the write or the deadline passes, whichever is first.
      // The loop never rejects (a late rejection of an abandoned attempt is swallowed here), and
      // once abandoned it starts no attempt and its result is ignored (no log, no further write).
      let attempt = 0;
      let abandoned = false;
      const attempts = (async (): Promise<{ id: unknown }[] | undefined> => {
        for (;;) {
          attempt += 1;
          try {
            return await complete();
          } catch {
            // The handler has had its effect: never surface the driver error (a "failure").
            if (abandoned || attempt >= COMPLETION_ATTEMPTS) return undefined;
            await wait(COMPLETION_RETRY_DELAYS_MS[attempt - 1] ?? 0);
            if (abandoned) return undefined;
          }
        }
      })().catch(() => undefined);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), COMPLETION_DEADLINE_MS);
      });
      let settled: { id: unknown }[] | undefined;
      try {
        settled = await Promise.race([attempts, deadline]);
      } finally {
        abandoned = true;
        clearTimeout(timer);
      }
      if (settled === undefined) {
        const fields = { method: request.method, path: request.path, attempts: attempt };
        report(fields, 'idempotency_completion_unknown');
        throw new IdempotencyError('outcome_unknown');
      }
      changed = settled;
    }
    if (changed.length === 0)
      logger.warn({ method: request.method, path: request.path }, 'idempotency_record_lost');
  }

  const instance: Idempotency = {
    async execute(request, handler) {
      entered(request);
      const prepared = prepare(request, fieldCrypto);
      if (!validKey(request.key)) return errorResponse(20001, request.traceId);
      if (sensitiveOperation(request)) throw new IdempotencyError('transactional_required');
      // Set when a post-miss check threw a StoredRejection: its result replaces the handler's.
      let rejected: HandlerResult | undefined;
      const claimed = await transaction(db, request, report, async (trx) => {
        if (!(await lockScope(trx, prepared.scope))) return busyResponse(trx, prepared, request);
        return boundedClaim(trx, async () => {
          let checked = false;
          for (;;) {
            const row = await findRow(trx, prepared.scope);
            let now = clock.now();
            if (row !== undefined) {
              if (row.status !== 'processing' || now.getTime() - row.created_at.getTime() < lease) {
                return existingResponse(row, prepared, request.traceId);
              }
              // An expired lease is taken over like a missing key: ④a runs before the takeover.
              if (!checked) {
                rejected = await afterMiss(request, trx);
                checked = true;
                now = clock.now();
              }
              const taken = await trx
                .updateTable('idempotency_keys')
                .set({ request_hash: prepared.hash, ...timestamps(request, now), response: null })
                .where('id', '=', row.id)
                .where('status', '=', 'processing')
                .where('created_at', '=', sql<Date>`${row.ownership_created_at}::timestamptz`)
                .returningAll()
                .returning(ownershipTimestamp)
                .executeTakeFirst();
              if (taken !== undefined) return taken;
            } else {
              if (!checked) {
                rejected = await afterMiss(request, trx);
                checked = true;
                now = clock.now();
              }
              const inserted = await insertRow(
                trx,
                prepared.scope,
                'processing',
                prepared.hash,
                now,
              );
              if (inserted !== undefined) return inserted;
            }
            // A concurrent completion, cleanup, or unique-key winner changed the row.
            // Re-read under READ COMMITTED before deciding; never overwrite a terminal row.
          }
        });
      });
      if ('source' in claimed) return claimed;
      const stored = rejected;
      let result: ReturnType<typeof handlerResponse>;
      try {
        result = handlerResponse(stored === undefined ? await handler() : stored);
      } catch (error) {
        // The handler's error is the answer; a failed cleanup must not replace it (B1-01zt ③).
        // The row stays processing until its lease expires (40901 meanwhile, then a takeover).
        try {
          await finish(claimed, request);
        } catch {
          report({ method: request.method, path: request.path }, 'idempotency_cleanup_failed');
        }
        throw error;
      }
      await finish(claimed, request, result.store ? result.response : undefined);
      return result.response;
    },

    async executeInTransaction(request, handler, options) {
      entered(request);
      const archive = options?.archive;
      const prepared = prepare(request, fieldCrypto);
      if (!validKey(request.key)) return errorResponse(20001, request.traceId);
      return transaction(db, request, report, async (trx) => {
        if (!(await lockScope(trx, prepared.scope))) return busyResponse(trx, prepared, request);
        let rejected: HandlerResult | undefined;
        const claim = await boundedClaim(trx, async () => {
          let checked = false;
          for (;;) {
            const row = await findRow(trx, prepared.scope);
            if (row !== undefined) return existingResponse(row, prepared, request.traceId);
            if (!checked) {
              rejected = await afterMiss(request, trx);
              checked = true;
            }
            const inserted = await insertRow(
              trx,
              prepared.scope,
              'processing',
              prepared.hash,
              clock.now(),
            );
            if (inserted !== undefined) return inserted;
          }
        });
        if ('source' in claim) return claim;
        const stored = rejected;
        const result = handlerResponse(stored === undefined ? await handler(trx) : stored);
        if (!result.store) throw new RollbackResponse(result.response);
        // Archive override (./archive.ts): the returned response is fixed above; only the stored
        // body changes. Called only for a stored result; a throw rolls back like the handler's.
        const storedBody =
          archive === undefined ? result.response.body : archivedBody(result.response, archive);
        // This processing row has never been visible outside this transaction. The unique
        // constraint reserves the key before any business writes and excludes abandonment.
        await trx
          .updateTable('idempotency_keys')
          .set({
            status: 'completed',
            response: { status: result.response.status, body: storedBody },
          })
          .where('id', '=', claim.id)
          .execute();
        return result.response;
      });
    },

    async abandon(request) {
      const fields: string[] = [];
      const actionValid = Object.hasOwn(SENSITIVE_OPERATIONS, request.action);
      if (!actionValid) fields.push('action');
      if (!validKey(request.key)) fields.push('idempotency_key');
      if (fields.length > 0)
        return envelopeResponse(400, 20001, 'invalid abandon request', request.traceId, { fields });
      if (typeof request.appId !== 'string' || request.appId.length === 0)
        throw new IdempotencyError('invalid_request');
      const subject = subjectOf({ userId: request.userId, deviceId: null, phoneHmac: null });
      const operation = SENSITIVE_OPERATIONS[request.action as StepUpAction];
      const scope: Scope = {
        app_id: request.appId,
        subject,
        method: operation.method,
        path: operation.path,
        key: request.key,
      };
      return transaction(
        db,
        { method: operation.method, path: operation.path, traceId: request.traceId },
        report,
        async (trx) => {
          if (!(await lockScope(trx, scope))) throw new KeyBusy();
          return boundedClaim(trx, async () => {
            for (;;) {
              const row = await findRow(trx, scope);
              if (row?.status === 'processing') return errorResponse(40901, request.traceId);
              if (row?.status === 'completed') {
                const stored = storedResponse(row);
                const original = JSON.parse(stored.body) as ResponseEnvelope;
                return envelopeResponse(200, 0, '', request.traceId, {
                  outcome: 'completed',
                  original: {
                    code: original.code,
                    msg: original.msg,
                    ...(Object.hasOwn(original, 'data') ? { data: original.data } : {}),
                  },
                });
              }
              if (
                row?.status === 'abandoned' ||
                (await insertRow(trx, scope, 'abandoned', null, clock.now())) !== undefined
              ) {
                return envelopeResponse(200, 0, '', request.traceId, {
                  outcome: 'abandoned',
                  original: null,
                });
              }
            }
          });
        },
      );
    },

    async purgeExpired() {
      const result = await db
        .deleteFrom('idempotency_keys')
        .where('expire_at', '<', clock.now())
        .executeTakeFirstOrThrow();
      return Number(result.numDeletedRows);
    },
  };
  HOOKS.set(instance, hooks);
  return instance;
}

/** The live stage ④a hook lists of one instance (./post-miss.ts registers into them). */
export interface IdempotencyHooks {
  /** Awaited after a miss or before an expired-lease takeover, before any write or handler. */
  readonly postMiss: ((request: IdempotentRequest) => Promise<void>)[];
  /** Called synchronously on entry to execute / executeInTransaction, whatever follows. */
  readonly entry: ((request: IdempotentRequest) => void)[];
}

const HOOKS = new WeakMap<Idempotency, IdempotencyHooks>();

/** What a post-miss check may use of the claim it runs in. */
export interface IdempotencyPostMissContext {
  /** The claim's transaction (holding the key's advisory lock), schema app like the db handle. */
  readonly trx: Transaction<DB>;
}

/** Set only while the post-miss checks of one claim run; never shared between claims. */
const POST_MISS_CONTEXT = new AsyncLocalStorage<IdempotencyPostMissContext>();

/**
 * Inside a post-miss check (./post-miss.ts): the claim's transaction, to read on the connection
 * that already holds the key's lock instead of borrowing another one from the pool. Undefined
 * anywhere else (the store is scoped to the checks of one claim).
 */
export function idempotencyPostMissTransaction(): Transaction<DB> | undefined {
  return POST_MISS_CONTEXT.getStore()?.trx;
}

/**
 * For ./post-miss.ts only (the register functions there are the API): the live hook lists of an
 * instance built by createIdempotency, undefined for any other object.
 */
export function idempotencyHooksOf(idempotency: Idempotency): IdempotencyHooks | undefined {
  return HOOKS.get(idempotency);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
type Scope = Pick<
  Selectable<DB['idempotency_keys']>,
  'app_id' | 'subject' | 'method' | 'path' | 'key'
>;
type Row = Selectable<DB['idempotency_keys']> & { ownership_created_at: string };
// Preserve PostgreSQL timestamp precision for conditional ownership checks on legacy rows.
const ownershipTimestamp = sql<string>`created_at::text`.as('ownership_created_at');

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function validKey(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 8 &&
    value.length <= 64 &&
    !/[^A-Za-z0-9_-]/.test(value)
  );
}

function sensitiveOperation(request: { method: string; path: string }) {
  return Object.values(SENSITIVE_OPERATIONS).find(
    (op) => op.method === request.method && op.path === request.path,
  );
}

/** The scope, the request_hash to write, and the comparison with a stored one (section 3). */
interface Prepared {
  readonly scope: Scope;
  readonly hash: string;
  readonly matches: (stored: string | null) => boolean;
}

function prepare(
  request: IdempotentRequest,
  fieldCrypto: Pick<FieldCrypto, 'blindIndex'> | null | undefined,
): Prepared {
  if (
    typeof request.appId !== 'string' ||
    request.appId.length === 0 ||
    !['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method) ||
    typeof request.path !== 'string' ||
    !request.path.startsWith('/') ||
    /[?#]/.test(request.path)
  ) {
    throw new IdempotencyError('invalid_request');
  }
  const canonical = canonicalJson(request.body);
  const plain = sha256Hex(canonical);
  const subject = subjectOf(request.actor);
  const scope: Scope = {
    app_id: request.appId,
    subject,
    method: request.method,
    path: request.path,
    key: request.key ?? '',
  };
  if (request.keyedRequestDigest !== true) {
    return { scope, hash: plain, matches: (stored) => stored === plain };
  }
  // Before anything reads the database: without FieldCrypto nothing is looked up or replayed.
  const keyed = keyedDigestOf(canonical, fieldCrypto);
  return {
    scope,
    hash: keyed,
    matches: (stored) => {
      if (stored === null) return false;
      if (stored.startsWith(KEYED_REQUEST_DIGEST_PREFIX)) return stored === keyed;
      // TODO(规划/11 §2.3): 删除旧 sha256 比对 — blocked on 幂等记录最长留存期（IDEMPOTENCY_RETENTION_MS）过后
      // （2026-10-19 起 keyed 指纹写入；实名提交、绑定手机号的行 30 天保留，2026-11-18 之后不再有
      // 无前缀旧值。提现 / 收款账号行 expire_at = infinity（第 7 节），那两类若改 keyed，删除前须另议）。
      return HEX64.test(stored) && stored === plain;
    },
  };
}

function timestamps(request: { method: string; path: string }, now: Date) {
  const created_at = now.toISOString();
  return {
    created_at,
    expire_at:
      sensitiveOperation(request)?.retention === 'unlimited'
        ? 'infinity'
        : sql<Date>`${created_at}::timestamptz + ${IDEMPOTENCY_RETENTION_MS} * interval '1 millisecond'`,
  };
}

function findRow(db: Kysely<DB>, scope: Scope) {
  return db
    .selectFrom('idempotency_keys')
    .selectAll()
    .select(ownershipTimestamp)
    .where('app_id', '=', scope.app_id)
    .where('subject', '=', scope.subject)
    .where('method', '=', scope.method)
    .where('path', '=', scope.path)
    .where('key', '=', scope.key)
    .executeTakeFirst();
}

function insertRow(
  db: Kysely<DB>,
  scope: Scope,
  status: 'processing' | 'abandoned',
  hash: string | null,
  now: Date,
) {
  return db
    .insertInto('idempotency_keys')
    .values({
      ...scope,
      user_id: scope.subject.startsWith('u:') ? scope.subject.slice(2) : null,
      request_hash: hash,
      status,
      response: null,
      ...timestamps(scope, now),
    })
    .onConflict((oc) => oc.columns(['app_id', 'subject', 'method', 'path', 'key']).doNothing())
    .returningAll()
    .returning(ownershipTimestamp)
    .executeTakeFirst();
}

function storedResponse(row: Row): { status: number; body: string } {
  const response = row.response;
  if (
    !isPlainObject(response) ||
    typeof response.status !== 'number' ||
    typeof response.body !== 'string'
  ) {
    throw new IdempotencyError('invalid_result');
  }
  return { status: response.status, body: response.body };
}

function existingResponse(row: Row, prepared: Prepared, traceId: string): IdempotentResponse {
  if (row.status === 'abandoned') return errorResponse(20903, traceId);
  if (row.status === 'processing') return errorResponse(40901, traceId);
  if (!prepared.matches(row.request_hash)) return errorResponse(20901, traceId);
  return { ...storedResponse(row), source: 'replay' };
}

function handlerResponse(result: HandlerResult): { response: IdempotentResponse; store: boolean } {
  if (
    result == null ||
    !Number.isInteger(result.status) ||
    result.status < 200 ||
    result.status > 599 ||
    !isPlainObject(result.envelope) ||
    !Number.isInteger(result.envelope.code) ||
    result.envelope.code < 0 ||
    typeof result.envelope.msg !== 'string' ||
    typeof result.envelope.trace_id !== 'string'
  ) {
    throw new IdempotencyError('invalid_result');
  }
  let body: string;
  try {
    canonicalJson(result.envelope); // Reject values JSON.stringify would silently discard/coerce.
    body = JSON.stringify(result.envelope);
  } catch {
    throw new IdempotencyError('invalid_result');
  }
  const code = result.envelope.code;
  return {
    response: { status: result.status, body, source: 'handler' },
    store: code === 0 || (code >= 30000 && code <= 39999),
  };
}

/**
 * The body to store under the archive override (./archive.ts). `archive` gets a fresh copy of the
 * handler's envelope (parsed from the body already fixed for the caller, so changing it cannot
 * change the returned response); what it returns must be a valid envelope with the same code.
 */
function archivedBody(
  response: IdempotentResponse,
  archive: NonNullable<IdempotencyArchiveOptions['archive']>,
): string {
  if (typeof archive !== 'function') throw new IdempotencyError('invalid_result');
  const original = JSON.parse(response.body) as ResponseEnvelope;
  const code = original.code; // Read before `archive` may change `original`.
  const archived = handlerResponse({
    status: response.status,
    envelope: archive(original),
  }).response.body;
  if ((JSON.parse(archived) as ResponseEnvelope).code !== code) {
    throw new IdempotencyError('invalid_result');
  }
  return archived;
}

function envelopeResponse(
  status: number,
  code: number,
  msg: string,
  traceId: string,
  data?: unknown,
): IdempotentResponse {
  return {
    status,
    body: JSON.stringify({ code, msg, ...(data === undefined ? {} : { data }), trace_id: traceId }),
    source: 'idempotency',
  };
}

function errorResponse(code: 20001 | 20901 | 20903 | 40901, traceId: string): IdempotentResponse {
  const messages = {
    20001: 'Idempotency-Key is missing or malformed',
    20901: 'Idempotency-Key was used with a different request body',
    20903: 'Idempotency-Key was abandoned',
    40901: 'a request with this Idempotency-Key is in progress',
  };
  return envelopeResponse(
    code === 20001 ? 400 : 409,
    code,
    messages[code],
    traceId,
    code === 20001 ? { fields: ['idempotency-key'] } : undefined,
  );
}

/** A pause between completion attempts (a timer, no clock read). */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

class KeyBusy extends Error {}
class RollbackResponse extends Error {
  readonly response: IdempotentResponse;
  constructor(response: IdempotentResponse) {
    super('rollback without storing result');
    this.response = response;
  }
}

/** Takes the scope's transaction-scoped advisory lock without waiting; false when it is held. */
async function lockScope(trx: Transaction<DB>, scope: Scope): Promise<boolean> {
  const digest = createHash('sha256')
    .update(JSON.stringify([scope.app_id, scope.subject, scope.method, scope.path, scope.key]))
    .digest();
  // The two-int4 advisory namespace is disjoint from the business one-bigint locks.
  const lock = await sql<{
    acquired: boolean;
  }>`SELECT pg_try_advisory_xact_lock(${digest.readInt32BE(0)}::int4, ${digest.readInt32BE(4)}::int4) AS acquired`.execute(
    trx,
  );
  return lock.rows[0]?.acquired === true;
}

/**
 * The scope's lock is held by another request (B1-01zt ①): one read without the lock (READ
 * COMMITTED, so it sees what is committed now). A completed record of the same request hash is
 * final, so its stored response is replayed as without contention; anything else (no visible
 * row, processing, abandoned, completed with another hash) stays 40901, since the holder may be
 * about to change it.
 */
async function busyResponse(
  trx: Transaction<DB>,
  prepared: Prepared,
  request: { traceId: string },
): Promise<IdempotentResponse> {
  const row = await findRow(trx, prepared.scope);
  if (row?.status === 'completed' && prepared.matches(row.request_hash)) {
    return { ...storedResponse(row), source: 'replay' };
  }
  return errorResponse(40901, request.traceId);
}

async function boundedClaim<T>(trx: Transaction<DB>, claim: () => Promise<T>): Promise<T> {
  const previous = await sql<{
    value: string;
  }>`SELECT current_setting('lock_timeout') AS value`.execute(trx);
  await sql`SELECT set_config('lock_timeout', '250ms', true)`.execute(trx);
  let result: T;
  try {
    result = await claim();
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === '55P03')
      throw new KeyBusy();
    throw error;
  }
  // Do not impose the key acquisition timeout on the handler's unrelated business locks.
  await sql`SELECT set_config('lock_timeout', ${previous.rows[0]!.value}, true)`.execute(trx);
  return result;
}

async function transaction<T>(
  db: Kysely<DB>,
  request: { method: string; path: string; traceId: string },
  report: (fields: Readonly<Record<string, unknown>>, msg: string) => void,
  run: (trx: Transaction<DB>) => Promise<T>,
): Promise<T | IdempotentResponse> {
  let committing = false;
  try {
    return await db
      .transaction()
      .setIsolationLevel('read committed')
      .execute(async (trx) => {
        const result = await run(trx);
        // Only a failure after the callback succeeded can be an uncertain COMMIT. Failures
        // writing the completed record remain driver errors and roll back the business writes.
        committing = true;
        return result;
      });
  } catch (error) {
    if (committing) {
      // One line (B1-01zt ④): method and path only, never the driver error (it may carry
      // parameters), a body or a key.
      report({ method: request.method, path: request.path }, 'idempotency_commit_unknown');
      throw new IdempotencyError('outcome_unknown');
    }
    if (error instanceof KeyBusy) return errorResponse(40901, request.traceId);
    if (error instanceof RollbackResponse) return error.response;
    throw error;
  }
}
