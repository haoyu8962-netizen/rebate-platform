// B1-27l (B1-27a money r1 S2, D10-1077 ③; 规划/08 BR-ID-25 细则「实名更正」, BR-WDR-02 细则「核验结果与
// 保存分开」): a vendor answer obtained for a record reserved before a real-name correction must not
// bind the card under the corrected identity. Real AppModule, PG (couli_app) and Redis through
// PUT /v1/me/payout-account; only the vendor factories are replaced (payout-bank-card/kit.ts).
//
// The interleaving is deterministic: the fake vendor itself completes the correction inside its
// callback, then answers match. No timing is involved. The correction is the shape
// admin-realname-correction.ts writes, under the same users row lock: same realname id and name, new
// ID number, verified_at = the correction's instant, row_version + 1.
//
// The tests are red on today's code because it binds and answers 0. Behaviours that are already
// green today (the controls, the same-key retry) live inside #1, on purpose: the red check has no
// exemption for new tests. The controls run first, so a red run has already exercised them.
import { randomUUID } from 'node:crypto';
import {
  acquireTestRedis,
  createTestDatabase,
  type TestDatabase,
  type TestRedis,
} from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import {
  BANK_CONTEXT,
  NAME,
  account,
  bankBody,
  card,
  close,
  envelope,
  fixture,
  open,
  reset,
  seedAttempt,
  state,
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

/** The correction's write at the Clock's instant; returns the new ID number. */
async function correctRealname(f: Fixture): Promise<string> {
  const idNo = `corrected-id-${randomUUID()}`;
  const at = kit.clock.now();
  await kit.db.transaction().execute(async (trx) => {
    await trx
      .selectFrom('users')
      .select('id')
      .where('app_id', '=', f.appId)
      .where('id', '=', f.uid)
      .forNoKeyUpdate()
      .executeTakeFirstOrThrow();
    const written = await trx
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
  });
  return idNo;
}

/**
 * The next vendor call completes a correction, then answers match. A failure of the correction
 * would be swallowed as "no answer" by the vendor deadline wrapper, so each test first asserts
 * `newIdNo` was set: a broken interleaving cannot pass for the behaviour under test.
 */
function correctionDuring(f: Fixture, call: 'verify' | 'query') {
  const race: { newIdNo?: string } = {};
  const answer = async () => {
    kit.clock.advanceMs(CORRECTION_LAG_MS);
    race.newIdNo = await correctRealname(f);
    return 'match' as const;
  };
  if (call === 'verify') kit.verify.mockImplementationOnce(answer);
  else kit.query.mockImplementationOnce(answer);
  return race;
}

async function expectBoundToCard(f: Fixture) {
  const { accounts } = await state(kit, f);
  expect(accounts.filter((row) => row.is_current)).toEqual([
    expect.objectContaining({
      payout_method: 'bank_card',
      bank_card_hmac: kit.crypto.blindIndex(card(), BANK_CONTEXT),
    }),
  ]);
}

it('[AC-B1-27l#1] 核验期间实名更正：不绑卡、40901、记录照实 matched、无绑卡写入，同键重试 20901；未更正、更正早于或等于预留时刻照常绑卡', async () => {
  // Control: no correction at all.
  const untouched = await fixture(kit);
  envelope(kit, await untouched.submit());
  await expectBoundToCard(untouched);
  expect(kit.verify).toHaveBeenLastCalledWith(
    expect.objectContaining({ name: NAME, id_no: untouched.idNo }),
  );

  // Controls: the correction finished before the reservation (1 s before, then the same instant:
  // only a record reserved earlier than the correction is the old identity's).
  for (const gapMs of [1_000, 0]) {
    const corrected = await fixture(kit);
    const newIdNo = await correctRealname(corrected);
    kit.clock.advanceMs(gapMs);
    envelope(kit, await corrected.submit());
    await expectBoundToCard(corrected);
    expect((await corrected.attempts()).map((row) => row.status)).toEqual(['matched']);
    expect(kit.verify).toHaveBeenLastCalledWith(
      expect.objectContaining({ name: NAME, id_no: newIdNo }),
    );
  }

  // The interleaving.
  const f = await fixture(kit);
  const key = randomUUID();
  const reservedAt = kit.clock.now();
  const vendorCalls = kit.verify.mock.calls.length;
  const race = correctionDuring(f, 'verify');
  const response = await f.submit(bankBody(), key);
  expect(race.newIdNo, 'the correction must have completed during the vendor call').toBeDefined();
  envelope(kit, response, 40901);

  // The vendor really did answer, for the old identity: the record says so.
  expect(kit.verify).toHaveBeenCalledTimes(vendorCalls + 1);
  expect(kit.verify).toHaveBeenLastCalledWith(
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
  // No current account of the card, no change row; the 40901 is not stored with the key.
  expect(await state(kit, f)).toEqual({ accounts: [], changes: [] });
  expect(await f.idempotency(key)).toEqual([]);

  // The same key again is another request of the corrected identity (existing semantics).
  envelope(kit, await f.submit(bankBody(), key), 20901);
  expect(kit.verify).toHaveBeenCalledTimes(vendorCalls + 1);
  expect(kit.query).not.toHaveBeenCalled();
  expect(await f.attempts()).toHaveLength(1);
  expect(await state(kit, f)).toEqual({ accounts: [], changes: [] });
});

it('[AC-B1-27l#2] 核验期间实名更正后换新键重试：不复用旧记录，第二次供应商调用按新身份核验，一致后绑卡成功', async () => {
  const f = await fixture(kit);
  const race = correctionDuring(f, 'verify');
  const first = await f.submit(bankBody(), randomUUID());
  expect(race.newIdNo, 'the correction must have completed during the vendor call').toBeDefined();
  envelope(kit, first, 40901);

  kit.clock.advanceMs(1_000);
  envelope(kit, await f.submit(bankBody(), randomUUID()));

  expect(kit.verify).toHaveBeenCalledTimes(2);
  expect(kit.verify).toHaveBeenLastCalledWith(
    expect.objectContaining({ name: NAME, id_no: race.newIdNo, card_no: card() }),
  );
  const rows = await f.attempts();
  expect(rows.map((row) => row.status)).toEqual(['matched', 'matched']);
  expect(new Set(rows.map((row) => row.vendor_request_id)).size).toBe(2);
  expect(kit.verify.mock.calls.map(([input]) => input.vendor_request_id)).toEqual(
    rows.map((row) => row.vendor_request_id),
  );
  await expectBoundToCard(f);
  expect((await state(kit, f)).changes).toEqual([]);
});

it('[AC-B1-27l#3] 换绑路径：已有支付宝时核验期间实名更正，原账号仍是当前账号，不写变更记录、不占当月次数，记录 matched', async () => {
  const f = await fixture(kit);
  // A real correction would also retire this row. It is kept here so that the path that writes a
  // change row and retires the current account exists: a first binding writes no change row at all.
  await account(kit, f);
  const before = await state(kit, f);
  const race = correctionDuring(f, 'verify');
  const response = await f.submit(bankBody(), randomUUID());
  expect(race.newIdNo, 'the correction must have completed during the vendor call').toBeDefined();
  envelope(kit, response, 40901);

  expect(await state(kit, f)).toEqual(before);
  expect((await f.attempts()).map((row) => row.status)).toEqual(['matched']);
});

it('[AC-B1-27l#4] 请求内复核拿到一致同样比较：复核期间实名更正不绑卡、40901，旧记录落 matched，本次不再发付费核验', async () => {
  const f = await fixture(kit);
  const row = await seedAttempt(kit, f, { status: 'unknown' });
  const race = correctionDuring(f, 'query');
  const response = await f.submit(bankBody(), randomUUID());
  expect(race.newIdNo, 'the correction must have completed during the vendor call').toBeDefined();
  envelope(kit, response, 40901);

  expect(kit.query).toHaveBeenCalledExactlyOnceWith(row.vendor_request_id);
  expect(kit.verify).not.toHaveBeenCalled();
  expect(await state(kit, f)).toEqual({ accounts: [], changes: [] });
  expect(await f.attempts()).toEqual([expect.objectContaining({ id: row.id, status: 'matched' })]);
});
