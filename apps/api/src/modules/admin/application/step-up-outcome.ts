// Whether a guarded operation that threw may still have taken effect (B2-02ze, FU-STEPUP-COMMIT-
// UNKNOWN-RETAIN; 08 BR-ID-34 二次验证一次性, BR-ID-08 「只能用于 1 次成功的业务请求」).
//
// The step-up gate (./permission-guard.ts) gives a claimed token back when the operation is known
// not to have happened (a business refusal, or an error thrown inside the transaction callback,
// which Kysely rolls back), and keeps the claim until the token expires when the outcome is
// unknown: a COMMIT that failed or whose acknowledgement never arrived may have committed, and a
// retry with the same token must not run the operation a second time (the token is void; a retry
// needs a fresh step-up). Kysely sends ROLLBACK after a failed COMMIT too, so "the rollback
// succeeded" proves nothing there; the decision is made on the error alone, by this classifier:
//
// An error is "outcome unknown" when it, its `cause` chain or the members of an AggregateError
// (`errors`), up to 8 levels, holds any of:
//   - the agreed marker: an AdminOutcomeUnknownError (below), or any error object whose `code`
//     is 'outcome_unknown' (platform idempotency's IdempotencyError('outcome_unknown'), thrown
//     when the COMMIT of executeInTransaction fails);
//   - a PostgreSQL SQLSTATE of class 08 (connection exception: 08000, 08003, 08006, …) or
//     57P01 admin_shutdown, 57P02 crash_shutdown, 57P03 cannot_connect_now, or 57014
//     query_canceled (`code`, 5 chars): a statement timeout or a cancel can hit the COMMIT itself,
//     or a step after it, so it proves no roll-back (B2-02ze money r1 S1);
//   - a socket-level code of Node (ECONNRESET, EPIPE, ETIMEDOUT, ECONNABORTED, ENOTCONN,
//     ECONNREFUSED, EHOSTUNREACH, ENETUNREACH, ENETRESET, ERR_STREAM_DESTROYED,
//     ERR_SOCKET_CLOSED);
//   - a driver message of a dropped connection without any SQLSTATE (node-postgres throws a
//     plain Error('Connection terminated unexpectedly') when the socket closes while a query,
//     COMMIT included, awaits its answer): /connection terminated|terminating connection|
//     server closed the connection|connection (was )?(closed|ended|reset|lost)|socket hang up|
//     client has encountered a connection error/i.
// Anything else (a plain Error thrown by the business, a constraint violation, a serialization
// failure, an HttpException) is a known roll-back: the claim is released as before.
// A connection error raised before COMMIT (the transaction did roll back) is classified unknown
// as well: the gate cannot tell where it happened, and holding a token back only costs the
// operator a new verification, while releasing it wrongly could run a money operation twice.
//
// Pure module (no decorators, erasable syntax, no imports).

/** Thrown by an operation that cannot tell whether its effect was committed (agreed type). */
export class AdminOutcomeUnknownError extends Error {
  readonly code = 'outcome_unknown';
  constructor(message = 'the outcome of the operation is unknown', options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AdminOutcomeUnknownError';
  }
}

const UNKNOWN_SQLSTATES: ReadonlySet<string> = new Set(['57P01', '57P02', '57P03', '57014']);
const SOCKET_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'ECONNABORTED',
  'ENOTCONN',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETRESET',
  'ERR_STREAM_DESTROYED',
  'ERR_SOCKET_CLOSED',
]);
const DROPPED_MESSAGE =
  /connection terminated|terminating connection|server closed the connection|connection (?:was )?(?:closed|ended|reset|lost)|socket hang up|client has encountered a connection error/i;
const MAX_DEPTH = 8;

function unknownCode(code: unknown): boolean {
  if (typeof code !== 'string') return false;
  if (code === 'outcome_unknown') return true;
  if (/^08[0-9A-Z]{3}$/.test(code)) return true;
  return UNKNOWN_SQLSTATES.has(code) || SOCKET_CODES.has(code);
}

/** True when the thrown value says the operation may have taken effect (see the header). */
export function isOutcomeUnknown(error: unknown): boolean {
  const seen = new Set<unknown>();
  const visit = (value: unknown, depth: number): boolean => {
    if (depth > MAX_DEPTH || typeof value !== 'object' || value === null || seen.has(value)) {
      return false;
    }
    seen.add(value);
    if (value instanceof AdminOutcomeUnknownError) return true;
    const shape = value as { code?: unknown; message?: unknown; cause?: unknown; errors?: unknown };
    let code: unknown;
    let message: unknown;
    let cause: unknown;
    let errors: unknown;
    try {
      ({ code, message, cause, errors } = shape);
    } catch {
      // A throwing getter: treat as unknown rather than give the token back.
      return true;
    }
    if (unknownCode(code)) return true;
    if (typeof message === 'string' && DROPPED_MESSAGE.test(message)) return true;
    if (visit(cause, depth + 1)) return true;
    if (Array.isArray(errors)) return errors.some((item) => visit(item, depth + 1));
    return false;
  };
  return visit(error, 0);
}
