// Reads of a login (规划/08 BR-ID-01 细则「受限会话」, BR-ID-04, BR-INV-09): the existing account of a
// phone and the device row of the request. Runs in the caller's transaction.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for types, `.ts`
// relative imports, no decorators.
import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';

export interface LoginAccount {
  readonly id: string;
  readonly parent_bind_source: string | null;
}

/**
 * The account holding this phone blind index in the app, if any. An account in the deletion
 * cooling-off period counts as existing; a finished deletion (status deleted) does not (BR-ID-01
 * 细则「受限会话·受限登录」); a deletion in processing is judged under the row lock (lockAccountStatus). The partial unique index (app_id, phone_hmac) WHERE status <> 'deleted'
 * keeps it at most one row.
 */
export async function findAccountByPhone(
  trx: Transaction<DB>,
  appId: string,
  phoneHmac: string,
): Promise<LoginAccount | undefined> {
  return trx
    .selectFrom('users')
    .select(['id', 'parent_bind_source'])
    .where('app_id', '=', appId)
    .where('phone_hmac', '=', phoneHmac)
    .where('status', '<>', 'deleted')
    .executeTakeFirst();
}

/**
 * The account's row lock for the login (B1-15f money review r1 S1): FOR NO KEY UPDATE on the
 * users row by id, in the same lock order as every other path (users first, then the consent
 * lock; the deletion expiry locks users before deletion_requests), and its status read under
 * that lock. Once the expiry committed deleting, the login sees it here and writes nothing; while
 * the login holds the lock the expiry waits, so a session is never issued to a deleting account.
 * B1-20b (Codex money r1 S0 #3): phone_hmac is read under the same lock, so a login found by
 * number can confirm the number is still this account's once a concurrent change committed.
 * undefined: no row of this app with that id.
 */
export async function lockAccountStatus(
  trx: Transaction<DB>,
  appId: string,
  userId: string,
): Promise<{ readonly status: string; readonly phone_hmac: string | null } | undefined> {
  return trx
    .selectFrom('users')
    .select(['status', 'phone_hmac'])
    .where('app_id', '=', appId)
    .where('id', '=', userId)
    .forNoKeyUpdate()
    .executeTakeFirst();
}

/**
 * device_hash of the request's device row (the registration service reads no devices). Also read
 * on the pool by the SMS send risk (B1-03g, application/sms-risk-ports.ts).
 */
export async function deviceHashOf(
  trx: Kysely<DB>,
  appId: string,
  deviceId: string,
): Promise<string | undefined> {
  const row = await trx
    .selectFrom('devices')
    .select('device_hash')
    .where('app_id', '=', appId)
    .where('id', '=', deviceId)
    .executeTakeFirst();
  return row?.device_hash;
}
