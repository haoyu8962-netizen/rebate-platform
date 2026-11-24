// B2-04re: the platform settle credit gate (08 BR-FUND-16 细则「加锁流程」第 0 步, 2026-11-24).
// Skeleton only (rule-test round): every body throws NotImplemented; the implementation follows the
// spelling written here, which the rule tests read back through creditGateKey to find the lock in
// pg_locks.
//
// One transaction-level advisory lock per (app, platform), in the two-int key form so that it lives
// in a key space apart from orders' bigint order key lock (`pg_advisory_xact_lock(hashtextextended(
// $1, 0))`, pg_locks objsubid 1); this one shows in pg_locks with objsubid 2,
// classid = hashtext(namespace), objid = hashtext(key):
//   namespace = 'settlement.credit_gate'
//   key       = `${appId}:${platform}`   (app_id, a colon, the platform code)
// Statements ($1 = namespace, $2 = key):
//   shared:    select pg_advisory_xact_lock_shared(hashtext($1), hashtext($2))
//   exclusive: select pg_advisory_xact_lock(hashtext($1), hashtext($2))
// Who takes it, always before any order key lock and never while holding one:
//   - the batch executor: the first statement of every item transaction, shared mode;
//   - the supplement launch (after its first source read, outside the chunk savepoints) and the
//     bill-day job (after the bill row lock and the replay check, before reading the source):
//     exclusive mode, held to commit.
// No other ledger transaction takes it.
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';

/** The two text keys of the gate; the lock is taken on (hashtext(namespace), hashtext(key)). */
export interface CreditGateKey {
  /** Always 'settlement.credit_gate'. */
  readonly namespace: string;
  /** `${appId}:${platform}`. */
  readonly key: string;
}

/** The gate key of (appId, platform), spelled as in the header comment. */
export function creditGateKey(appId: string, platform: string): CreditGateKey {
  void appId;
  void platform;
  throw new Error('NotImplemented: creditGateKey');
}

/** Shared mode on `trx` (transaction level): an item transaction of the batch executor. */
export function lockCreditGateShared(
  trx: Transaction<DB>,
  appId: string,
  platform: string,
): Promise<void> {
  void trx;
  void appId;
  void platform;
  throw new Error('NotImplemented: lockCreditGateShared');
}

/** Exclusive mode on `trx` (transaction level): the supplement launch and the bill-day job. */
export function lockCreditGateExclusive(
  trx: Transaction<DB>,
  appId: string,
  platform: string,
): Promise<void> {
  void trx;
  void appId;
  void platform;
  throw new Error('NotImplemented: lockCreditGateExclusive');
}
