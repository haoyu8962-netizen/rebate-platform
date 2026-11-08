// Identity's port for "does this user have a withdrawal in flight" (task B1-15d §9.2 #2;
// BR-ID-27, BR-ID-31; orchestrator ruling D10-97). POST /v1/me/deletion asks it inside the claim's
// transaction, after locking the user's row, and answers 30412 when it says true.
//
// true = the user has a withdrawal in PENDING_REVIEW, APPROVED or PAYING, NOT counting one that
// was frozen by hand because of a ban (BR-ID-31: those are settled by finance during cooling).
// The status rule belongs to the implementation of this port (the payout module); identity never
// reads or judges withdrawal states itself. Reads on the caller's transaction (`trx`), no writes,
// no logging.
//
// app.module injects payout's reader (createWithdrawalInFlightReader, B2-05e) for this port and
// for WithdrawalNonTerminalReader below.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for type-only imports,
// relative imports with `.ts`.
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';

export interface WithdrawalInFlightInput {
  readonly appId: string;
  readonly userId: string;
}

export interface WithdrawalInFlightReader {
  hasInFlight(trx: Transaction<DB>, input: WithdrawalInFlightInput): Promise<boolean>;
}

/**
 * B1-15f (BR-ID-27 「进入 processing 前该用户所有提现必须已到终态」): true = the user has ANY withdrawal
 * not in a terminal state, INCLUDING one frozen by hand because of a ban — a wider rule than
 * hasInFlight. Same caller transaction, no writes, no logging. app.module's implementation of
 * WithdrawalInFlightReader implements this method too (false until B2-05, which replaces both).
 * Declared as its own interface so B1-15d's readers keep compiling.
 */
export interface WithdrawalNonTerminalReader {
  hasNonTerminal(trx: Transaction<DB>, input: WithdrawalInFlightInput): Promise<boolean>;
}

/**
 * B1-15g (D10-137 ②): true = the user has at least one withdrawal that was paid out (the deletion
 * cleanup then keeps the real-name ciphertext, marked tax_retained). Same caller transaction, no
 * writes, no logging. Until B2-05 app.module's implementation truthfully answers false.
 */
export interface WithdrawalSucceededReader {
  hasSucceeded(trx: Transaction<DB>, input: WithdrawalInFlightInput): Promise<boolean>;
}
