// B1-02zzzb (BR-ID-08 细则「绑定业务摘要」; contract POST /v1/auth/step-up `summary`): the helpers
// the frozen payout fixtures call to give a payout_account_change step_up_token, or a payout save
// command, the business digest of the account it is for. The frozen fixtures only import and call
// these; every branch (no digest, which action, which default body) lives here.
import { normalizeBankCardNo } from '@couli/domain';
import { normalizeAlipayLogonId } from '../../../../apps/api/src/modules/identity/domain/alipay-logon.ts';

// Same values as payout-account/kit.ts (and the service's blind-index contexts); kept local so this
// helper does not import kit.ts, which imports it (no-circular).
const ALIPAY_CONTEXT = 'payout_accounts.alipay';
const BANK_CONTEXT = 'payout_accounts.bank_card';

type Blind = { blindIndex(value: string, context: string): string };

/**
 * The business digest a payout_account_change step_up_token carries for the account a save
 * submits — the string `p:<payout_method>:<HMAC of the normalised account>` (the payout_accounts
 * blind-index contexts). Takes the PUT body shape (payout_method + alipay_logon_id / card_no) or a
 * service command (alipayLogonId / cardNo). null when the account has no fingerprint (a body the
 * save refuses with 20001 before comparing any digest) or the body is no payout account.
 */
export function payoutSummary(crypto: Blind, body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const value = body as Readonly<Record<string, unknown>>;
  const logon =
    value['alipayLogonId'] ??
    (value['payout_method'] === 'alipay' ? value['alipay_logon_id'] : undefined);
  if (typeof logon === 'string') {
    const normalized = normalizeAlipayLogonId(logon);
    if (normalized.code !== 0) return null;
    return `p:alipay:${crypto.blindIndex(normalized.logon, ALIPAY_CONTEXT)}`;
  }
  const cardNo =
    value['cardNo'] ?? (value['payout_method'] === 'bank_card' ? value['card_no'] : undefined);
  if (typeof cardNo === 'string') {
    const normalized = normalizeBankCardNo(cardNo);
    if (normalized.length === 0) return null;
    return `p:bank_card:${crypto.blindIndex(normalized, BANK_CONTEXT)}`;
  }
  return null;
}

/**
 * The `summary` claim for the account `body` saves: `{}` when it has no digest, else
 * `{ summary }`. `body` undefined means `fallback` (what a default parameter would have given).
 */
export function summaryClaim(
  crypto: Blind,
  body: unknown,
  fallback?: unknown,
): Readonly<Record<string, string>> {
  const summary = payoutSummary(crypto, body === undefined ? fallback : body);
  return summary === null ? {} : { summary };
}

/** summaryClaim for a payout_account_change token; any other action carries no summary (`{}`). */
export function payoutChangeClaim(
  crypto: Blind,
  action: string,
  body: unknown,
  fallback?: unknown,
): Readonly<Record<string, string>> {
  return action === 'payout_account_change' ? summaryClaim(crypto, body, fallback) : {};
}

/** A save command with the step_up_token digest of the account it saves (payoutSummary). */
export function bound<T extends { readonly alipayLogonId: string }>(
  kit: { crypto: Blind },
  command: T,
): T & { readonly stepUpSummary: string | null } {
  return { ...command, stepUpSummary: payoutSummary(kit.crypto, command) };
}

/**
 * For `{ ...base, ...input, ...resavedDigest(crypto, base, input) }`: `{}` when `input` sets its
 * own stepUpSummary (the input wins), else the digest of the merged account `{ ...base, ...input }`.
 */
export function resavedDigest(
  crypto: Blind,
  base: object,
  input: object,
): { readonly stepUpSummary?: string | null } {
  if (Object.prototype.hasOwnProperty.call(input, 'stepUpSummary')) return {};
  return { stepUpSummary: payoutSummary(crypto, { ...base, ...input }) };
}
