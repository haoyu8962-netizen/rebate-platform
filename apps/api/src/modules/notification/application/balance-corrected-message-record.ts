// B2-02z: records the BALANCE_CORRECTED in-app message of a balance recalculation on the caller's
// transaction (D10-2092 ⑤, D10-2097; contracts/openapi.yaml recalcBalanceAdminReconDiff 「Member
// notice」): inbox only — no push, no sms. users.status is read on the caller's transaction: a
// member who is `deleting` or `deleted` gets nothing; a member in the cooling-off period of a
// deletion request (status still one that signs in) gets it as usual. The inbox notify_logs row
// (dedupe key `balance_corrected:{reconDiffId}:{balanceVersion}`, the pair of the B2-02x voucher
// source `recalc:<recon_diff_id>:<version>`, D10-2084) and the inbox message commit or roll back with
// the recalculation itself; a second record of the same pair writes nothing. The recalculation
// (ledger) receives this through app.module, never by import.
//
// Skeleton (B2-02z test round): the writer throws NotImplemented; the implementation round fills
// it in (rule tests test/spec/notification/balance-corrected/**).
import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';
import type { BalanceCorrectedFacts } from './balance-corrected-message.ts';

export interface BalanceCorrectedRecordInput {
  readonly appId: string;
  readonly userId: string;
  /** The recon_diffs row whose recalculation corrected the balance. */
  readonly reconDiffId: string;
  /** The balance row's version after the recalculation wrote it. */
  readonly balanceVersion: number;
  readonly facts: BalanceCorrectedFacts;
  /** The recalculation's instant (its injected Clock). */
  readonly now: Date;
}

/** True when a message was written (a changed available balance seen for the first time). */
export function recordBalanceCorrectedMessage(
  trx: Transaction<DB> | Kysely<DB>,
  input: BalanceCorrectedRecordInput,
): Promise<boolean> {
  void trx;
  void input;
  throw new Error('NotImplemented: recordBalanceCorrectedMessage (B2-02z)');
}
