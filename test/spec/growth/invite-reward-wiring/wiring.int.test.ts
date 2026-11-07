// B2-16c rule tests (08 BR-INV-24 ③ ⑦; D10-805 ①; FU-INVITE-REWARD-WIRING): the invite reward
// payout as the worker entry assembles it. Every round is the scanner a real
// AppModule.forEntry({ entry: 'worker' }) provides, over PostgreSQL and ledger's real REWARD:INVITE
// writer; no port of growth is injected here (the self-assembled cases are B1-35's, under
// test/spec/growth/invite-reward/, frozen).
//   - the payout writes one REWARD voucher per paid party (key INVITE_REWARD:{invitee}:{side}, the
//     amount locked on the qualification record), never deferring with
//     invite_reward_writer_unavailable;
//   - BR-INV-24 ③「只该方不发、另一方照发」: a party in the deletion flow (cooling, processing or done)
//     is skipped with reason deleting, read through identity's deletion stage (deletion_requests,
//     app-scoped), not users.status alone; 「命中即不发、不补发」: withdrawing the request later
//     pays nothing more.
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  LOCKED_AMOUNT,
  NEXT_ROUND,
  PAID,
  PARTIES,
  TIMEOUT,
  WRITER_UNAVAILABLE,
  budget,
  configure,
  deletionRequest,
  duePair,
  hex,
  newAppId,
  partyUser,
  reward,
  rewardKey,
  rewardLines,
  round,
  userStatus,
  voucherLines,
  vouchers,
  withdrawRequest,
  worker,
  type Pair,
  type Party,
  type Worker,
} from './kit.ts';

let database: Awaited<ReturnType<typeof createTestDatabase>> | undefined;
let db: Kysely<DB>;

beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 10 });
}, 180_000);

afterAll(async () => {
  try {
    if (db !== undefined) await destroyDb(db);
  } finally {
    await database?.drop();
  }
}, 60_000);

async function withWorker(run: (w: Worker) => Promise<void>): Promise<void> {
  const w = await worker(db);
  try {
    await run(w);
  } finally {
    await w.close();
  }
}

function other(party: Party): Party {
  return party === 'inviter' ? 'invitee' : 'inviter';
}

function voucherColumn(party: Party): 'inviter_voucher_id' | 'invitee_voucher_id' {
  return party === 'inviter' ? 'inviter_voucher_id' : 'invitee_voucher_id';
}

/** No round of this app deferred for a missing writer. */
function expectNoWriterWarning(w: Worker, appId: string): void {
  expect(w.logs(appId).filter((line) => line.msg === WRITER_UNAVAILABLE)).toEqual([]);
}

/** The party's REWARD voucher: keyed by the invitee and side, on the row, with the locked amount. */
async function expectGranted(pair: Pair, party: Party): Promise<void> {
  const row = await reward(db, pair);
  const key = rewardKey(pair.invitee, party);
  const voucher = (await vouchers(db, pair.appId)).find((v) => v.uniq_key === key);
  expect(voucher, `REWARD voucher ${party}`).toBeDefined();
  expect(voucher).toMatchObject({
    biz_type: 'INVITE_REWARD',
    biz_id: pair.invitee,
    order_key: null,
  });
  expect(row?.[voucherColumn(party)]).toBe(voucher?.id);
  expect(await voucherLines(db, pair.appId, voucher?.id ?? '')).toEqual(
    rewardLines(partyUser(pair, party), LOCKED_AMOUNT),
  );
}

/**
 * Only `paid` parties have a voucher for this pair: of the app's vouchers, those keyed
 * INVITE_REWARD:{invitee}: or carrying the pair's invitee as biz_id (other pairs of the same app
 * are not counted).
 */
async function expectVoucherKeys(pair: Pair, paid: readonly Party[]): Promise<void> {
  const prefix = `INVITE_REWARD:${pair.invitee}:`;
  const mine = (await vouchers(db, pair.appId)).filter(
    (v) => v.uniq_key.startsWith(prefix) || v.biz_id === pair.invitee,
  );
  expect(mine.map((v) => v.uniq_key)).toEqual(
    paid.map((party) => rewardKey(pair.invitee, party)).sort(),
  );
}

/** processed: `skipped` not paid with reason deleting, the other party granted with its voucher. */
async function expectOneSideDeleting(pair: Pair, skipped: Party): Promise<void> {
  const paid = other(skipped);
  const row = await reward(db, pair);
  expect(row).toMatchObject({
    status: 'processed',
    [`${skipped}_result`]: 'skipped',
    [`${skipped}_skip_reason`]: 'deleting',
    [voucherColumn(skipped)]: null,
    [`${paid}_result`]: 'granted',
    [`${paid}_skip_reason`]: null,
  });
  await expectVoucherKeys(pair, [paid]);
  await expectGranted(pair, paid);
}

it(
  '[AC-B2-16c#1] worker 入口装配的发放写出 REWARD 凭证：记录 processed，双方各一张（INVITE_REWARD:{invitee}:{side}，金额取资格锁定值），无 invite_reward_writer_unavailable',
  async () => {
    await withWorker(async (w) => {
      const pair = await duePair(db);
      await round(w);

      expect(await reward(db, pair)).toMatchObject({
        status: 'processed',
        inviter_result: 'granted',
        invitee_result: 'granted',
        inviter_skip_reason: null,
        invitee_skip_reason: null,
        granted_at: new Date(PAID),
      });
      await expectVoucherKeys(pair, PARTIES);
      for (const party of PARTIES) await expectGranted(pair, party);
      // Both reserved amounts moved to granted, on the total and on the day.
      expect(await budget(db, pair.appId)).toEqual({
        reserved_fen: 0n,
        granted_fen: LOCKED_AMOUNT * 2n,
      });
      expect(await budget(db, pair.appId, '2026-11-25')).toEqual({
        reserved_fen: 0n,
        granted_fen: LOCKED_AMOUNT * 2n,
      });
      expectNoWriterWarning(w, pair.appId);
      expect(w.logs(pair.appId).map((line) => line.msg)).toContain('invite_reward_processed');

      // A later round finds nothing due: no second voucher, the row is unchanged.
      const before = await reward(db, pair);
      await round(w, NEXT_ROUND);
      expect(await reward(db, pair)).toEqual(before);
      await expectVoucherKeys(pair, PARTIES);
    });
  },
  TIMEOUT,
);

it.each(PARTIES)(
  '[AC-B2-16c#2] %s 处于注销冷静期（cooling）：该方 deleting 不发、另一方照发；撤回注销后下一轮不补发',
  async (skipped) => {
    await withWorker(async (w) => {
      const pair = await duePair(db);
      const request = await deletionRequest(db, pair.appId, partyUser(pair, skipped), 'cooling');
      await round(w);

      await expectOneSideDeleting(pair, skipped);
      // The skipped party's reservation is released, the paid one moved to granted.
      expect(await budget(db, pair.appId)).toEqual({
        reserved_fen: 0n,
        granted_fen: LOCKED_AMOUNT,
      });
      expectNoWriterWarning(w, pair.appId);

      // BR-INV-24 ③「命中即不发、不补发」: the user withdraws, the next round pays nothing more.
      await withdrawRequest(db, request);
      const before = await reward(db, pair);
      await round(w, NEXT_ROUND);
      expect(await reward(db, pair)).toEqual(before);
      await expectVoucherKeys(pair, [other(skipped)]);
      expect(await budget(db, pair.appId)).toEqual({
        reserved_fen: 0n,
        granted_fen: LOCKED_AMOUNT,
      });
    });
  },
  TIMEOUT,
);

for (const [stage, status] of [
  ['processing', 'deleting'],
  ['done', 'deleted'],
] as const) {
  it.each(PARTIES)(
    `[AC-B2-16c#3] %s 处于注销 ${stage}（users.status ${status}）：仍按 deleting 只该方不发、另一方照发`,
    async (skipped) => {
      await withWorker(async (w) => {
        const pair = await duePair(db, {
          ...(skipped === 'inviter' ? { inviterStatus: status } : { inviteeStatus: status }),
        });
        await deletionRequest(db, pair.appId, partyUser(pair, skipped), stage);
        await round(w);

        await expectOneSideDeleting(pair, skipped);
        expectNoWriterWarning(w, pair.appId);
      });
    },
    TIMEOUT,
  );
}

it(
  '[AC-B2-16c#4] 注销阶段读 identity 的注销单：users.status 仍为 normal、只有 cooling 注销单的被邀请人判 deleting；只有已撤回注销单的照发',
  async () => {
    await withWorker(async (w) => {
      const appId = newAppId();
      await configure(db, appId);
      const cooling = await duePair(db, { appId });
      await deletionRequest(db, appId, cooling.invitee, 'cooling');
      const withdrawn = await duePair(db, { appId });
      await deletionRequest(db, appId, withdrawn.invitee, 'cancelled');
      // The users row carries no trace of the deletion flow: only deletion_requests does.
      expect(await userStatus(db, appId, cooling.invitee)).toBe('normal');
      expect(await userStatus(db, appId, withdrawn.invitee)).toBe('normal');
      await round(w);

      await expectOneSideDeleting(cooling, 'invitee');
      expect(await reward(db, withdrawn)).toMatchObject({
        status: 'processed',
        inviter_result: 'granted',
        invitee_result: 'granted',
        invitee_skip_reason: null,
      });
      for (const party of PARTIES) await expectGranted(withdrawn, party);
      // The judgement wrote nothing to the users rows.
      expect(await userStatus(db, appId, cooling.invitee)).toBe('normal');
      expectNoWriterWarning(w, appId);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-16c#5] app 隔离：另一 app 同手机号用户的 cooling 注销单不影响本 app，各 app 只按自己的注销单判定',
  async () => {
    await withWorker(async (w) => {
      const phoneHmac = hex();
      const mine = await duePair(db, { inviteePhoneHmac: phoneHmac });
      const theirs = await duePair(db, { inviteePhoneHmac: phoneHmac });
      await deletionRequest(db, theirs.appId, theirs.invitee, 'cooling');
      // And the other way round: a cooling inviter of this app leaves the other app's inviter paid.
      await deletionRequest(db, mine.appId, mine.inviter, 'cooling');
      await round(w);

      await expectOneSideDeleting(mine, 'inviter');
      await expectOneSideDeleting(theirs, 'invitee');
      expectNoWriterWarning(w, mine.appId);
      expectNoWriterWarning(w, theirs.appId);
    });
  },
  TIMEOUT,
);
