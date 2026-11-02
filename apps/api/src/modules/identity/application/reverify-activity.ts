// The two values BR-WDR-01 细则「判定」keeps on the account, overwritten on every login and refresh,
// and the judgement of a login (migration 0111; B1-02zp). completeLogin, the one path of every login
// method, calls recordLoginActivity in the login transaction; refresh.ts calls
// recordRefreshActivity, which only overwrites.
//
// A login judges on the values from before its overwrite, under the users row lock, so concurrent
// logins cannot both flag. Every caller of completeLogin already holds that lock (or inserted the
// row); with the switch on it is taken again here so the judgement never depends on that. An
// existing flag is never judged again: its instant and trusted identities stay until the manual
// clearing. The account merge (BR-ID-06) judges separately and is not implemented here.
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
