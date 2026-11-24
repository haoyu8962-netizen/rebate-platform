// B2-04re: the platform settle credit gate (08 BR-FUND-16 细则「加锁流程」第 0 步, 2026-11-24).
// The rule tests read the spelling below back through creditGateKey to find the lock in pg_locks.
// This file is the only place that spells the namespace and the two lock statements; the three
// callers import from here. Transaction level only, ordinary wait (no lock_timeout, no try form),
// released by commit or rollback only (no session form, no unlock).
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
import { sql, type Transaction } from 'kysely';

const NAMESPACE = 'settlement.credit_gate';

/** The two text keys of the gate; the lock is taken on (hashtext(namespace), hashtext(key)). */
export interface CreditGateKey {
  /** Always 'settlement.credit_gate'. */
  readonly namespace: string;
  /** `${appId}:${platform}`. */
  readonly key: string;
}

/** The gate key of (appId, platform), spelled as in the header comment. */
export function creditGateKey(appId: string, platform: string): CreditGateKey {
  return { namespace: NAMESPACE, key: `${appId}:${platform}` };
}

/** Shared mode on `trx` (transaction level): an item transaction of the batch executor. */
export async function lockCreditGateShared(
  trx: Transaction<DB>,
  appId: string,
  platform: string,
): Promise<void> {
  const gate = creditGateKey(appId, platform);
  // Exactly the header's statement text (no surrounding whitespace).
  await sql`select pg_advisory_xact_lock_shared(hashtext(${gate.namespace}), hashtext(${gate.key}))`.execute(
    trx,
  );
}

/** Exclusive mode on `trx` (transaction level): the supplement launch and the bill-day job. */
export async function lockCreditGateExclusive(
  trx: Transaction<DB>,
  appId: string,
  platform: string,
): Promise<void> {
  const gate = creditGateKey(appId, platform);
  await sql`select pg_advisory_xact_lock(hashtext(${gate.namespace}), hashtext(${gate.key}))`.execute(
    trx,
  );
}
