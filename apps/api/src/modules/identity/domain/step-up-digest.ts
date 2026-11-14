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
 * Inside the business lock: does the token's digest bind this business request? `undefined` means
 * the caller judged no step-up context (a direct service call that is not one of the HTTP
 * operations); the HTTP operations always pass the token's digest or null (none in the claims),
 * and null never matches.
 */
export function digestMatches(
  claimed: string | null | undefined,
  expected: string | null,
): boolean {
  if (claimed === undefined) return true;
  return claimed !== null && expected !== null && claimed === expected;
}
