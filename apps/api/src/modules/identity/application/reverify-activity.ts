// The two values BR-WDR-01 细则「判定」keeps on the account, overwritten on every login and refresh,
// and the judgement of a login (migration 0111; B1-02zp). completeLogin, the one path of every login
// method, calls recordLoginActivity in the login transaction; refresh.ts calls
// recordRefreshActivity, which only overwrites.
//
// A login judges on the values from before its overwrite, under the users row lock, so concurrent
// logins cannot both flag. Every caller of completeLogin already holds that lock (or inserted the
// row); with the switch on it is taken again here so the judgement never depends on that. An
// existing flag is never judged again: its instant and trusted identities stay until the manual
// clearing. The account merge (BR-ID-06; B1-20c merge-account.ts) judges separately, with the two
// functions at the end of this file: flagDormantMerge in a short transaction of its own, committed
// before the merge transaction opens (a refused merge, 10010, must not take the flag with it), and
// isDormantUnflagged as the merge transaction's read-only check that the flag was not missed.
//
// The switch is read before the login transaction opens (readDormantReverifyDays): content's reader
// runs on its own handle and must not borrow a second connection while this one is held. A missing
// row or a value that is no positive whole number is off: the registry's item has no other default
// and db/seeds holds 0 (D10-567 ②).
//
// Also compiled by the `test` project: erasable syntax only, `import type` for types, `.ts`
// relative imports, no decorators.
import type { DB } from '@couli/db';
import { sql, type Transaction } from 'kysely';
import { isDormantLogin } from '../domain/reverify.ts';
import { trustedIdentitiesNow } from '../infra/reverify-store.ts';
import type { SmsConfigReader } from './sms-codes.ts';

/** BR-WDR-01 细则: days without activity after which a new device flags the account. */
export const DORMANT_REVERIFY_DAYS_KEY = 'withdraw.dormant_reverify_days';

export async function readDormantReverifyDays(
  config: SmsConfigReader | undefined,
  appId: string,
): Promise<number | undefined> {
  if (config === undefined) return undefined;
  const value = (await config.configValue(appId, DORMANT_REVERIFY_DAYS_KEY))?.value;
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export interface LoginActivity {
  readonly app_id: string;
  readonly user_id: string;
  readonly deviceHash: string | null;
  readonly now: Date;
  /** readDormantReverifyDays' answer; absent: off, the values are only overwritten. */
  readonly days: number | undefined;
}

export async function recordLoginActivity(
  trx: Transaction<DB>,
  input: LoginActivity,
): Promise<void> {
  const { app_id: appId, user_id: userId, deviceHash, now, days } = input;
  let flag: Readonly<Record<string, unknown>> = {};
  if (days !== undefined) {
    const before = await trx
      .selectFrom('users')
      .select(['last_active_at', 'last_login_device_hash', 'reverify_flagged_at'])
      .where('app_id', '=', appId)
      .where('id', '=', userId)
      .forNoKeyUpdate()
      .executeTakeFirst();
    if (
      before !== undefined &&
      isDormantLogin({
        days,
        now,
        lastActiveAt: before.last_active_at,
        lastDeviceHash: before.last_login_device_hash,
        deviceHash,
        flaggedAt: before.reverify_flagged_at,
      })
    ) {
      const trusted = await trustedIdentitiesNow(trx, { app_id: appId, user_id: userId });
      flag = {
        reverify_flagged_at: now,
        reverify_trusted: sql`${JSON.stringify(trusted)}::jsonb`,
      };
    }
  }
  await trx
    .updateTable('users')
    .set({ last_active_at: now, last_login_device_hash: deviceHash, updated_at: now, ...flag })
    .where('app_id', '=', appId)
    .where('id', '=', userId)
    .execute();
}

/**
 * A refresh: the session's device, read in the statement; never judges. Nothing is written once the
 * account is in deletion (BR-ID-28 细则「待加验记录」): the condition is on the UPDATE itself, so a
 * refresh that waited for the row behind the deletion cleanup judges it on the row's latest version.
 */
export async function recordRefreshActivity(
  trx: Transaction<DB>,
  input: {
    readonly app_id: string;
    readonly user_id: string;
    readonly device_id: string;
    readonly now: Date;
  },
): Promise<void> {
  const { app_id: appId, user_id: userId, device_id: deviceId, now } = input;
  await trx
    .updateTable('users')
    .set((eb) => ({
      last_active_at: now,
      last_login_device_hash: eb
        .selectFrom('devices')
        .select('device_hash')
        .where('app_id', '=', appId)
        .where('id', '=', deviceId),
      updated_at: now,
    }))
    .where('app_id', '=', appId)
    .where('id', '=', userId)
    .where('status', 'not in', ['deleting', 'deleted'])
    .execute();
}

/**
 * The stored values judged as a login of `user_id` on `deviceHash` would judge them, under the
 * users row lock (FOR NO KEY UPDATE); false when the switch is off, the row is missing or the
 * account is flagged already.
 */
export async function isDormantUnflagged(
  trx: Transaction<DB>,
  input: LoginActivity,
): Promise<boolean> {
  const { app_id: appId, user_id: userId, deviceHash, now, days } = input;
  if (days === undefined) return false;
  const before = await trx
    .selectFrom('users')
    .select(['last_active_at', 'last_login_device_hash', 'reverify_flagged_at'])
    .where('app_id', '=', appId)
    .where('id', '=', userId)
    .forNoKeyUpdate()
    .executeTakeFirst();
  return (
    before !== undefined &&
    isDormantLogin({
      days,
      now,
      lastActiveAt: before.last_active_at,
      lastDeviceHash: before.last_login_device_hash,
      deviceHash,
      flaggedAt: before.reverify_flagged_at,
    })
  );
}

/**
 * B1-20c (BR-WDR-01 细则「并号」; Codex money review r1 S1): the merge's judgement of the phone
 * account, on a transaction of its own that the caller commits before the merge transaction opens.
 * Flags exactly as a login would (the instant, the account's own trusted identities read now, before
 * any identity moves) and writes nothing else: the activity values are overwritten only by a merge
 * that goes through, in its own transaction. A flag is never judged again.
 * Codex money review r2 S1: the caller found the account by the ticket's number without a lock;
 * under the row lock taken here the account must still be status normal and still hold that number
 * (`phoneHmac`), the main transaction's own check after its lock — a number moved to another account
 * (or an account gone into deletion) while this waited is never flagged. The UPDATE repeats the same
 * conditions on the row itself. True when it flagged.
 */
export async function flagDormantMerge(
  trx: Transaction<DB>,
  input: LoginActivity & { readonly phoneHmac: string },
): Promise<boolean> {
  const { app_id: appId, user_id: userId, deviceHash, now, days, phoneHmac } = input;
  if (days === undefined) return false;
  const row = await trx
    .selectFrom('users')
    .select([
      'status',
      'phone_hmac',
      'last_active_at',
      'last_login_device_hash',
      'reverify_flagged_at',
    ])
    .where('app_id', '=', appId)
    .where('id', '=', userId)
    .forNoKeyUpdate()
    .executeTakeFirst();
  if (row === undefined || row.status !== 'normal' || row.phone_hmac !== phoneHmac) return false;
  if (
    !isDormantLogin({
      days,
      now,
      lastActiveAt: row.last_active_at,
      lastDeviceHash: row.last_login_device_hash,
      deviceHash,
      flaggedAt: row.reverify_flagged_at,
    })
  ) {
    return false;
  }
  const trusted = await trustedIdentitiesNow(trx, { app_id: appId, user_id: userId });
  const flagged = await trx
    .updateTable('users')
    .set({
      reverify_flagged_at: now,
      reverify_trusted: sql`${JSON.stringify(trusted)}::jsonb`,
      updated_at: now,
    })
    .where('app_id', '=', appId)
    .where('id', '=', userId)
    .where('status', '=', 'normal')
    .where('phone_hmac', '=', phoneHmac)
    .where('reverify_flagged_at', 'is', null)
    .executeTakeFirst();
  return flagged.numUpdatedRows === 1n;
}
