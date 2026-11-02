// app.users' re-verification columns and app.reverified_devices (migration 0111; 规划/08 BR-WDR-01
// 细则「旧手机号被二次放号时的提现加验」). identity is the only writer.
//
// The failure count (D10-149, D10-161; couli #174 r5). Nothing here reads and then writes without
// holding the users row. reverify_fail_epoch names one run of the count: every reset moves it on.
//   reserve  one conditional UPDATE: below the limit, or on another day, takes a place (the day
//            change is inside the same statement, so two requests of a new day cannot both write
//            1, and a reset of the count moves the epoch). No row back → no place left. It returns
//            the epoch the place belongs to.
//   release  one conditional UPDATE: −1, never below 0, only if the day and the epoch are still
//            the reservation's, so it cannot take a failure counted after a clear. The conditions
//            are on the row itself: a statement that waited for the row judges them again on the
//            row's latest version.
//   pass     one UPDATE clears the count and moves the epoch; every actual pass does, also when a
//            concurrent pass already recorded this device. It takes the row lock, the device row
//            (if new) follows in the same transaction.
//   clear    REVERIFY_CLEARED, joined to the console phone change's write under its row lock: the
//            flag, its instant, the snapshot and the count go and the epoch moves on, so a place
//            reserved before it cannot be released against a failure counted after it. The save
//            sets last_active_at beside it (编排 D10-584): that value is its clock's instant.
//
// An account in deletion (BR-ID-28 细则「待加验记录」; B1-02zy). The cleanup of the deletion round runs
// once, so a request still in flight must not write the data back: reserve and pass write nothing
// when users.status is deleting or deleted. The condition is on the UPDATE itself, not a read before
// it: a statement that waited for the row behind the cleanup judges it on the row's latest version.
// A pass that updated the row holds its lock, so the status cannot move before the device row
// commits, and the cleanup that follows removes that row. release needs no condition: the cleanup
// cleared the day it matches on.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for types, `.ts`
// relative imports, no decorators.
import type { DB } from '@couli/db';
import { sql, type Kysely, type Transaction } from 'kysely';
import { newUuidV7 } from '../../platform/index.ts';
import { REVERIFY_FAIL_LIMIT, type ReverifyProvider } from '../domain/reverify.ts';

export interface ReverifySubject {
  readonly app_id: string;
  readonly user_id: string;
}

export interface ReverifyAccount {
  readonly flagged_at: Date | null;
  readonly trusted: unknown;
  readonly fail_count: number;
  readonly fail_day: string | null;
}

/** One reservation of a failure place, as its release needs it. */
export interface FailureReservation {
  readonly day: string;
  /** The reverify_fail_epoch this place belongs to. */
  readonly epoch: number;
  /** The account's count after this reservation. */
  readonly count: number;
}

export async function readReverifyAccount(
  db: Kysely<DB>,
  subject: ReverifySubject,
): Promise<ReverifyAccount | undefined> {
  const row = await db
    .selectFrom('users')
    .select((eb) => [
      eb.ref('reverify_flagged_at').as('flagged_at'),
      eb.ref('reverify_trusted').as('trusted'),
      eb.ref('reverify_fail_count').as('fail_count'),
      sql<string | null>`reverify_fail_day::text`.as('fail_day'),
    ])
    .where('app_id', '=', subject.app_id)
    .where('id', '=', subject.user_id)
    .executeTakeFirst();
  return row;
}

export async function isReverifiedDevice(
  db: Kysely<DB>,
  subject: ReverifySubject,
  deviceHash: string,
): Promise<boolean> {
  const row = await db
    .selectFrom('reverified_devices')
    .select('id')
    .where('app_id', '=', subject.app_id)
    .where('user_id', '=', subject.user_id)
    .where('device_hash', '=', deviceHash)
    .executeTakeFirst();
  return row !== undefined;
}

/** id_no_hmac of the account's completed real name, or null. */
export async function verifiedIdNoHmac(
  db: Kysely<DB>,
  subject: ReverifySubject,
): Promise<string | null> {
  const row = await db
    .selectFrom('realname')
    .select('id_no_hmac')
    .where('app_id', '=', subject.app_id)
    .where('user_id', '=', subject.user_id)
    .where('status', '=', 'verified')
    .executeTakeFirst();
  return row?.id_no_hmac ?? null;
}

/** union_id of the account's binding of this provider, or null. */
export async function boundUnionId(
  db: Kysely<DB>,
  subject: ReverifySubject,
  provider: ReverifyProvider,
): Promise<string | null> {
  const row = await db
    .selectFrom('user_oauth')
    .select('union_id')
    .where('app_id', '=', subject.app_id)
    .where('user_id', '=', subject.user_id)
    .where('provider', '=', provider)
    .executeTakeFirst();
  return row?.union_id ?? null;
}

/**
 * Takes one failure place of `today` (+08:00), or null when none is left or the account is in
 * deletion.
 */
export async function reserveFailure(
  db: Kysely<DB>,
  subject: ReverifySubject,
  today: string,
  now: Date,
): Promise<FailureReservation | null> {
  return db
    .transaction()
    .setIsolationLevel('read committed')
    .execute(async (trx) => {
      const reserved = await sql<{
        reverify_fail_count: number;
        reverify_fail_epoch: number;
      }>`UPDATE app.users SET
          reverify_fail_count = CASE WHEN reverify_fail_day = ${today}::date
            THEN reverify_fail_count + 1 ELSE 1 END,
          reverify_fail_epoch = CASE WHEN reverify_fail_day = ${today}::date
            THEN reverify_fail_epoch ELSE reverify_fail_epoch + 1 END,
          reverify_fail_day = ${today}::date,
          updated_at = ${now}
        WHERE app_id = ${subject.app_id} AND id = ${subject.user_id}
          AND status NOT IN ('deleting', 'deleted')
          AND (reverify_fail_day IS DISTINCT FROM ${today}::date
            OR reverify_fail_count < ${REVERIFY_FAIL_LIMIT})
        RETURNING reverify_fail_count, reverify_fail_epoch`.execute(trx);
      const row = reserved.rows[0];
      if (row === undefined) return null;
      return { day: today, epoch: row.reverify_fail_epoch, count: row.reverify_fail_count };
    });
}

/** Undoes this reservation only (see the header). */
export async function releaseFailure(
  db: Kysely<DB>,
  subject: ReverifySubject,
  reservation: FailureReservation,
  now: Date,
): Promise<void> {
  await db
    .transaction()
    .setIsolationLevel('read committed')
    .execute(async (trx) => {
      await sql`UPDATE app.users SET
          reverify_fail_count = GREATEST(reverify_fail_count - 1, 0),
          updated_at = ${now}
        WHERE app_id = ${subject.app_id} AND id = ${subject.user_id}
          AND reverify_fail_day = ${reservation.day}::date
          AND reverify_fail_epoch = ${reservation.epoch}`.execute(trx);
    });
}

/**
 * A pass: this device is re-verified (source self), the count is cleared, the flag stays.
 * `alongside` joins the same transaction (a replaced Apple refresh token). False: the account is
 * in deletion, or gone, and nothing was written, `alongside` included.
 */
export async function settlePassed(
  db: Kysely<DB>,
  subject: ReverifySubject,
  input: {
    readonly deviceHash: string;
    readonly now: Date;
    readonly alongside?: (trx: Transaction<DB>) => Promise<void>;
  },
): Promise<boolean> {
  const { deviceHash, now, alongside } = input;
  return db
    .transaction()
    .setIsolationLevel('read committed')
    .execute(async (trx) => {
      // A pass clears the count even when a concurrent pass already recorded this device.
      const updated = await sql`UPDATE app.users SET
          reverify_fail_count = 0,
          reverify_fail_day = NULL,
          reverify_fail_epoch = reverify_fail_epoch + 1,
          updated_at = ${now}
        WHERE app_id = ${subject.app_id} AND id = ${subject.user_id}
          AND status NOT IN ('deleting', 'deleted')
        RETURNING id`.execute(trx);
      if (updated.rows.length === 0) return false;
      await trx
        .insertInto('reverified_devices')
        .values({
          id: newUuidV7(now),
          app_id: subject.app_id,
          user_id: subject.user_id,
          device_hash: deviceHash,
          source: 'self',
          created_at: now,
        })
        .onConflict((oc) => oc.columns(['app_id', 'user_id', 'device_hash']).doNothing())
        .execute();
      await alongside?.(trx);
      return true;
    });
}

/** The columns of the manual clearing (BR-WDR-01 细则「清除标记只走人工」); see the header. */
export const REVERIFY_CLEARED = {
  reverify_flagged_at: null,
  reverify_trusted: null,
  reverify_fail_count: 0,
  reverify_fail_day: null,
  reverify_fail_epoch: sql<number>`reverify_fail_epoch + 1`,
};

/**
 * Deletes every binding of the user outside `trusted`. RETURNING hands back the row as deleted, so
 * an Apple token replaced while this waited for the row is the one returned.
 */
export async function unbindUntrusted(
  trx: Transaction<DB>,
  subject: ReverifySubject,
  trusted: readonly ReverifyProvider[],
) {
  let unbind = trx
    .deleteFrom('user_oauth')
    .where('app_id', '=', subject.app_id)
    .where('user_id', '=', subject.user_id);
  if (trusted.length > 0) unbind = unbind.where('provider', 'not in', [...trusted]);
  return unbind.returning(['provider', 'apple_refresh_token_cipher']).execute();
}

/**
 * A console record (source admin, B1-02zx): one row, or none when this account already recorded
 * this device, whatever the source. The caller holds the users row, so the row read back after a
 * conflict is committed and stays. Answers the row as it stands: the first record's source and
 * time when nothing was written.
 */
export async function addReverifiedDevice(
  trx: Transaction<DB>,
  subject: ReverifySubject,
  input: { readonly deviceHash: string; readonly now: Date },
): Promise<{
  readonly source: 'self' | 'admin';
  readonly created: boolean;
  readonly created_at: Date;
}> {
  const { deviceHash, now } = input;
  const inserted = await trx
    .insertInto('reverified_devices')
    .values({
      id: newUuidV7(now),
      app_id: subject.app_id,
      user_id: subject.user_id,
      device_hash: deviceHash,
      source: 'admin',
      created_at: now,
    })
    .onConflict((oc) => oc.columns(['app_id', 'user_id', 'device_hash']).doNothing())
    .returning(['source', 'created_at'])
    .executeTakeFirst();
  const row =
    inserted ??
    (await trx
      .selectFrom('reverified_devices')
      .select(['source', 'created_at'])
      .where('app_id', '=', subject.app_id)
      .where('user_id', '=', subject.user_id)
      .where('device_hash', '=', deviceHash)
      .executeTakeFirstOrThrow());
  return {
    // reverified_devices_source_check allows nothing else.
    source: row.source as 'self' | 'admin',
    created: inserted !== undefined,
    created_at: row.created_at,
  };
}

/** The trusted identities as they are now: a completed real name and the bound providers. */
export async function trustedIdentitiesNow(trx: Transaction<DB>, subject: ReverifySubject) {
  const realname = await verifiedIdNoHmacExists(trx, subject);
  const bindings = await trx
    .selectFrom('user_oauth')
    .select('provider')
    .where('app_id', '=', subject.app_id)
    .where('user_id', '=', subject.user_id)
    .orderBy('provider')
    .execute();
  return { realname, providers: bindings.map((binding) => binding.provider) };
}

async function verifiedIdNoHmacExists(
  trx: Transaction<DB>,
  subject: ReverifySubject,
): Promise<boolean> {
  const row = await trx
    .selectFrom('realname')
    .select('id')
    .where('app_id', '=', subject.app_id)
    .where('user_id', '=', subject.user_id)
    .where('status', '=', 'verified')
    .executeTakeFirst();
  return row !== undefined;
}
