// B1-02zzzb (BR-ID-08: any step-up failure is 10003, HTTP 403, no reason told apart): payout's copy
// of identity's STEP_UP_FAILURE, the answer of POST /v1/withdrawals when the step_up_token's digest
// does not bind the withdrawal. A copy, not an import: identity's barrel carries Nest controllers
// (decorators) that the `test` project (erasable syntax only) must not compile through payout.
// step-up-failure.test.ts asserts it equals identity's value field for field.
//
// Also compiled by the `test` project: erasable syntax only, `.ts` relative imports.

/** Stage ⑫'s 10003 (code, HTTP status, package default text); same value as identity's STEP_UP_FAILURE. */
export const STEP_UP_FAILURE = Object.freeze({
  code: 10003,
  status: 403,
  msg: '需要二次验证',
} as const);
