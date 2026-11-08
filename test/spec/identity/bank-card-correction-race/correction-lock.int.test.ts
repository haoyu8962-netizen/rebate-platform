// B1-27l, rule-test review r1 S1 (B1-27a money r1 S2, D10-1077 ③): the comparison of the record's
// reserved_at with the real name's verified_at has to happen under the users row lock. In
// correction-race.int.test.ts the correction has committed before the vendor callback returns, so
// a read without the lock would see it as well. Here it commits only after the request is blocked
// on that row: anything the request read before the lock is stale, and only a read after the lock
// sees the correction.
//
// Real AppModule, PG (couli_app) and Redis through PUT /v1/me/payout-account; only the vendor
// factories are replaced (payout-bank-card/kit.ts). The interleaving is observed, not timed: the
// holder takes the lock inside the vendor callback, and the correction waits for the wait edge in
// pg_blocking_pids. FOR NO KEY UPDATE permits FK key-share locks, so only another request for that
// row lock can show up behind the holder ([AC-B1-13f#60]).
import { randomUUID } from 'node:crypto';
import {
  acquireTestRedis,
  createTestDatabase,
  type TestDatabase,
  type TestRedis,
} from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { pid } from '../payout-account/kit.ts';
import {
  NAME,
  account,
  bankBody,
  card,
  close,
  envelope,
  fixture,
  open,
  reset,
  state,
  until,
  type Fixture,
  type Kit,
} from '../payout-bank-card/kit.ts';

/** How long after the reservation the correction lands (less than the vendor deadline). */
const CORRECTION_LAG_MS = 5_000;

let database: TestDatabase;
let redis: TestRedis;
let kit: Kit;
beforeAll(async () => {
  database = await createTestDatabase();
  redis = await acquireTestRedis();
  kit = await open(database, redis);
});
beforeEach(() => reset(kit));
afterAll(async () => {
  try {
    await close(kit);
  } finally {
    try {
      await redis?.stop();
    } finally {
      await database?.drop();
    }
  }
});

/** An independent open transaction holding the lock the correction and the save both take. */
async function holdUserRow(f: Fixture) {
  const holder = await kit.db.startTransaction().execute();
  try {
    await holder
      .selectFrom('users')
      .select('id')
      .where('app_id', '=', f.appId)
      .where('id', '=', f.uid)
      .forNoKeyUpdate()
      .executeTakeFirstOrThrow();
    return { holder, holderPid: await pid(holder) };
  } catch (error) {
    await holder.rollback().execute();
    throw error;
  }
}
type Held = Awaited<ReturnType<typeof holdUserRow>>;

async function someoneWaitsBehind(holderPid: number): Promise<boolean> {
  const result = await sql<{ blocked: boolean }>`SELECT EXISTS (
    SELECT 1 FROM pg_stat_activity
    WHERE datname = current_database()
      AND wait_event_type = 'Lock'
      AND ${holderPid} = ANY(pg_blocking_pids(pid))
  ) AS blocked`.execute(kit.db);
  return result.rows[0]!.blocked;
}

/** The shape admin-realname-correction.ts writes, in the transaction that holds the lock. */
async function writeCorrection(holder: Held['holder'], f: Fixture): Promise<void> {
  const idNo = `corrected-id-${randomUUID()}`;
  const at = kit.clock.now();
  const written = await holder
    .updateTable('realname')
    .set({
      id_no_cipher: Buffer.from(kit.crypto.encrypt(idNo, 'realname.id_no')),
      id_no_hmac: kit.crypto.blindIndex(idNo, 'realname.id_no'),
      verified_at: at,
      updated_at: at,
      row_version: sql<number>`row_version + 1`,
    })
    .where('app_id', '=', f.appId)
    .where('user_id', '=', f.uid)
    .where('status', '=', 'verified')
    .executeTakeFirst();
  expect(written.numUpdatedRows).toBe(1n);
}

it('[AC-B1-27l#5] 供应商答一致后实名更正持 users 行锁、绑卡请求已被它阻塞，更正提交后不绑卡（首绑与换绑）、40901、无变更记录、记录照实 matched', async () => {
  for (const bound of [false, true]) {
    const f = await fixture(kit);
    // With a current Alipay account the save would retire it and write a change row: a first
    // binding writes no change row at all.
    if (bound) await account(kit, f);
    const before = await state(kit, f);
    const key = randomUUID();
    const reservedAt = kit.clock.now();
    kit.verify.mockClear();

    const holding = Promise.withResolvers<Held>();
    kit.verify.mockImplementationOnce(async () => {
      holding.resolve(await holdUserRow(f));
      return 'match' as const;
    });
    const pending = f.submit(bankBody(), key);
    // A request that answers without the callback holding the row must not wait for the timeout.
    const held = await Promise.race([holding.promise, pending.then(() => undefined)]);
    expect(held, 'the vendor callback must hold the users row first').toBeDefined();
    const { holder, holderPid } = held!;

    let finished = false;
    try {
      await until(() => someoneWaitsBehind(holderPid));
      kit.clock.advanceMs(CORRECTION_LAG_MS);
      await writeCorrection(holder, f);
      await holder.commit().execute();
      finished = true;
    } finally {
      // A failed step must not leave the request behind the lock.
      if (!finished) await holder.rollback().execute();
      await pending.catch(() => undefined);
    }

    envelope(kit, await pending, 40901);

    // The vendor really did answer, for the old identity: the record says so.
    expect(kit.verify).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ name: NAME, id_no: f.idNo, card_no: card() }),
    );
    expect(await f.attempts()).toEqual([
      expect.objectContaining({
        status: 'matched',
        reserved_at: reservedAt,
        resolved_at: expect.any(Date),
        idempotency_key: key,
      }),
    ]);
    // No account of the card, the current account untouched, no change row; 40901 is not stored.
    expect(await state(kit, f)).toEqual(before);
    expect(await f.idempotency(key)).toEqual([]);
  }
});
