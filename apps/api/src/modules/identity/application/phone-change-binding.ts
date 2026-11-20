// The phone binding of a phone_change step_up_token (B1-20b, Codex money r1 S0 #2; BR-ID-06 /
// BR-ID-08: a change proves the number it replaces). POST /v1/auth/step-up signs it into the claim
// STEP_UP_PHONE_BINDING_CLAIM when it issues action=phone_change by SMS: SHA-256 hex of the token's
// jti and the users.phone_hmac whose old-number code it checked. The phone change compares it,
// under its users row lock, with the phone_hmac it is about to replace: a token issued for a number
// the account no longer has (another change committed since) does not authorise this change.
// phone_hmac is a keyed blind index, and the jti salts it, so the claim neither reveals the number
// nor links two tokens of one number. Never logged.
//
// Also compiled by the `test` project: erasable syntax only, `.ts` relative imports.
import { createHash } from 'node:crypto';

/** The claim value for a token `jti` issued after checking the number of `phoneHmac`. */
export function phoneChangeBinding(jti: string, phoneHmac: string): string {
  return createHash('sha256').update(`phone_change\n${jti}\n${phoneHmac}`).digest('hex');
}

/** Does the token's binding claim (null: none) name this phone_hmac? Fails closed. */
export function phoneChangeBindingMatches(
  claim: { readonly jti: string; readonly phone_binding: string | null },
  phoneHmac: string,
): boolean {
  return (
    typeof claim.phone_binding === 'string' &&
    claim.phone_binding === phoneChangeBinding(claim.jti, phoneHmac)
  );
}
