// The business digest of a step_up_token (规划/08 BR-ID-08 细则「绑定业务摘要」; contract POST
// /v1/auth/step-up `summary`, CT-26c; task B1-02zzzb). One string claim `summary`:
//   withdraw               `w:<payout_account_id>:<amount_fen>` (copied as sent, never checked here);
//   payout_account_change  `p:<payout_method>:<HMAC of the normalised account>` (alipay, bank_card;
//                          the same blind-index contexts payout_accounts uses), or
//                          `p:wechat:<attempt_id>` (the payout_bind authorization attempt).
// Only these two actions are bound; phone_change and account_deletion carry no digest. The digest
// never contains a plaintext account and is never logged or returned.
//
// Also compiled by the `test` project: erasable syntax only, `.ts` relative imports.

/**
 * The one answer of every step-up failure (BR-ID-08: 10003, HTTP 403, no data, no reason told
 * apart): stage ⑫ and the step_up_token verifier refuse with it, and a business that finds the
 * token's digest not binding its request (or no digest) answers with exactly the same status and
 * text, so the response body is the same apart from trace_id.
 */
export const STEP_UP_FAILURE = Object.freeze({
  code: 10003,
  status: 403,
  msg: '需要二次验证',
} as const);

/** Name of the digest claim in the step_up_token. */
export const STEP_UP_SUMMARY_CLAIM = 'summary';

/** The actions whose step_up_token is bound to a business digest. */
export function isDigestAction(action: string): action is 'withdraw' | 'payout_account_change' {
  return action === 'withdraw' || action === 'payout_account_change';
}

/** The withdrawal digest: the current payout account row id and the amount in whole fen. */
export function withdrawDigest(payoutAccountId: string, amountFen: bigint): string {
  return `w:${payoutAccountId}:${amountFen.toString()}`;
}

/** The payout account change digest of an Alipay / bank card account (its blind index). */
export function payoutAccountDigest(method: 'alipay' | 'bank_card', hmac: string): string {
  return `p:${method}:${hmac}`;
}

/** The WeChat change digest: the payout_bind authorization attempt (BR-WDR-33 ②). */
export function wechatPayoutDigest(attemptId: string): string {
  return `p:wechat:${attemptId}`;
}

/**
 * Inside the business lock: does the token's digest bind this business request? Every caller
 * passes the token's digest, or null when the claims carry none (or no token was judged); null
 * never matches, and neither does anything that is not a string (fails closed).
 */
export function digestMatches(claimed: string | null, expected: string | null): boolean {
  return typeof claimed === 'string' && typeof expected === 'string' && claimed === expected;
}
