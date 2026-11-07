// B2-04zza on a real PostgreSQL: the R10 answering a waiting rights record (BR-FUND-06 / D10-474 ②)
// interleaved with the credit of another order of the same beneficiary. Both go through the lock
// flow of BR-FUND-16 细则「加锁流程」(order_key advisory lock → users rows ascending → balance rows →
// states); the two orders have different order keys, so the shared users row is where one waits.
// Two single connections and a deterministic barrier (the first transaction pauses after it read
// the states, locks held; the second one's wait is observed on the server with pg_blocking_pids),
// both orders of arrival. The result must equal the serial one, with no deadlock.
//
// Order X (waiting): self held at credit then banned (first_credit obligation), direct U normal,
// indirect normal; credit 0 / 85 / 42, platform 448. Record 600 (seq 3) → R10: direct −34,
// indirect −17, platform +76, self's obligation forfeited (same money as forfeit.int.test.ts #1).
// Order Y (WAITING): U is the only beneficiary (self 5000); credit B 850 → U 425, platform 575.
// Serial result: U 85 − 34 + 425 = 476; X UNION_RECEIVABLE 600, Y 1000.
//
// Why the opponent is a users-row-first writer (Codex spec-test r2 S1, orchestrator §12):
// the users row lock already serialises every writer of a user's balance, so for this path the
// balance row lock is a redundant guard and dropping it is an equivalent mutant; no opponent is
// made up here.
// Every ledger.lockBalances call that is followed by a balance write takes the users row first,
// on the same transaction (users lock → lockBalances, apps/api/src/modules/…):
//   settlement/clawback/clawback-order.ts:816→822, :1076→1082 (this path);
//   settlement/credit/credit-order.ts:377→384; settlement/credit/beneficiary/beneficiary-credit.ts
//   :412→417; settlement/application/admin-recon-restore.ts:319→328;
//   ledger/application/admin-adjustment.ts:533→535; admin-adjustment-closing.ts:387→389;
//   bad-debt-writeoff.ts:173→174, :503→504; invite-reward-grant.ts:186, whose only caller
//   (through apps/api/src/app.module.ts:1587) growth/application/invite-reward.ts locks users
//   at :824 before grant at :966;
//   payout/application/withdraw-apply.ts:350→351; withdrawal-commands.ts:198→199;
//   went-negative.ts:81→82; withdrawal-manual-paid.ts:127→128; withdrawal-proven-success.ts
//   :270→271; admin-unknown-payouts.ts:516→517; auto-payout.ts:450→451; payout/jobs/review-job.ts
//   :87→88; payout-landing.ts:149→150 on its own transaction, and on the caller's one
//   payout/jobs/landing-job.ts:310 locks users before landing.success / fail (:360, :378).
// The one lockBalances call without a users lock, payout/application/payout-execute.ts:309, writes
// no balance (its ledger port is getBalances | lockBalances only, :96; header :24-27). The only
// other balance writer, ledger.reverse
// (settlement/application/admin-union-receipts.ts:374), reverses a platform-only RECEIPT
// voucher. Every user entry goes through post, which refuses an account
// this transaction did not lock (NOT_LOCKED, ledger/application/ledger.ts:438-445), re-locks the
// held rows NOWAIT (:451) and writes by a version CAS (ledger/infra/store.ts:367-386). So a mutant
// that drops lockBalances from this path cannot post at all (no account id, or NOT_LOCKED).
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  LATER,
  TIMEOUT,
  creditKey,
  databaseFixture,
  deferred,
  harness,
  platformKey,
  platformLines,
  receivable,
  userCreditLines,
  waitBlocked,
  type Arrival,
  type Harness,
  type SeededOrder,
} from './kit.ts';

const p = databaseFixture(createTestDatabase);

interface Pair {
  readonly h: Harness;
  readonly x: SeededOrder;
  readonly y: SeededOrder;
  readonly u: string;
  readonly waitingId: string;
  readonly keysX: readonly string[];
  readonly eventsX: Awaited<ReturnType<Harness['newBeneficiaryEvents']>>;
}

async function pair(): Promise<Pair> {
  const h = await harness(p.db);
  const u = await h.user();
  const { o: x, waitingId } = await h.waiting(
    {
      people: [
        { role: 'self', ratioBp: 5000, state: 'frozen' },
        { role: 'direct', ratioBp: 1000, userId: u },
        { role: 'indirect', ratioBp: 500 },
      ],
    },
    (seeded) => h.setState(seeded, 'self', 'banned'),
  );
  expect(await h.balance(u)).toBe(85n);
  expect(await h.orderSubjectNet(x, receivable(x))).toBe(575n);
  const y = await h.order({ people: [{ role: 'self', ratioBp: 5000, userId: u }] });
  expect(await h.read(y)).toMatchObject({ rebate_status: 'WAITING' });
  return {
    h,
    x,
    y,
    u,
    waitingId,
    keysX: await h.orderVoucherKeys(x),
    eventsX: await h.newBeneficiaryEvents(x),
  };
}

/**
 * Whether the barrier was reached before the paused transaction settled (a transaction that never
 * reads the states would otherwise leave the barrier waiting until the test times out).
 */
function firstOf(paused: Promise<void>, run: Promise<unknown>): Promise<'paused' | 'settled'> {
  return Promise.race([
    paused.then(() => 'paused' as const),
    run.then(
      () => 'settled' as const,
      () => 'settled' as const,
    ),
  ]);
}

/** Both orders as the serial run leaves them. */
async function expectSerialResult(s: Pair, arrival: Arrival, credit: unknown): Promise<void> {
  const { h, x, y, u } = s;
  expect(arrival.result).toMatchObject({
    outcome: 'settle_adjusted',
    transition: 'R10',
    orderKey: x.orderKey,
    bookedBaseFen: 510n,
    bookedNFen: 600n,
  });
  expect(credit).toMatchObject({ outcome: 'credited' });

  // X: the R10 of the waiting rights record, as forfeit.int.test.ts #1.
  await h.expectAdjusted(x, s.keysX, 3, { users: { direct: 34n, indirect: 17n }, platform: -76n });
  expect(await h.balance(x.user('self'))).toBe(0n);
  expect(await h.balance(x.user('indirect'))).toBe(25n);
  expect(await h.orderSubjectNet(x, receivable(x))).toBe(600n);
  expect(await h.orderObligations(x)).toEqual([
    expect.objectContaining({
      user_id: x.user('self'),
      role: 'self',
      status: 'forfeited',
      closed_by: 'R10',
      closed_at: new Date(LATER),
    }),
  ]);
  expect(await h.newBeneficiaryEvents(x)).toEqual([
    ...s.eventsX,
    expect.objectContaining({ user_id: x.user('self'), status: 'forfeited', reason: 'banned' }),
  ]);
  await h.expectBooked(x, 510n, 600n);
  await h.expectAnswered(x, s.waitingId);
  expect(h.heldAlerts()).toEqual([]);

  // Y: an ordinary credit (R5).
  expect(await h.orderVoucherKeys(y)).toEqual([creditKey(y, 'self'), platformKey(y)].sort());
  expect(await h.voucherLines(creditKey(y, 'self'))).toEqual(userCreditLines(y, 'self', 425n));
  expect(await h.voucherLines(platformKey(y))).toEqual(platformLines(y, 575n));
  expect(await h.orderSubjectNet(y, receivable(y))).toBe(1000n);
  expect(await h.orderObligations(y)).toEqual([]);
  expect(await h.read(y)).toMatchObject({
    rebate_status: 'CREDITED',
    booked_base_fen: 850n,
    booked_n_fen: 1000n,
  });

  // The shared beneficiary: X's direct share after the R10 plus Y's self share.
  expect(await h.balance(u)).toBe(476n);
}

it(
  '[AC-B2-04zza#19] 并发（R10 先）：受益人 U 是等佣金维权单 X 的直推、又是待入账单 Y 的本人；X 的同步事务（联盟新结算记录 600 负差）锁住 users 行并读完状态后暂停，Y 的入账在 U 的 users 行锁上等待（pg_blocking_pids 观察）；放行后两单都完成、无死锁：X 按 R10 记账（直推 −34、间推 −17、平台 +76）、本人义务 forfeited 并关闭维权记录，Y 正常入账，U 余额 476，与串行结果一致',
  async () => {
    const s = await pair();
    const { h, x, y } = s;
    h.clock.set(LATER);
    h.boot();
    const paused = deferred();
    const release = deferred();
    h.pauseAfterStates(async () => {
      paused.resolve();
      await release.promise;
    });
    let arrivePid = 0;
    const arrival = h.arrive(x, {
      settleAfter: 600n,
      newSeq: 3,
      via: p.left,
      onPid: (pid) => {
        arrivePid = pid;
      },
    });
    let credit: Promise<unknown> | undefined;
    const results: unknown[] = [];
    try {
      const reached = await firstOf(paused.promise, arrival);
      expect(reached, 'the R10 pauses after reading the states').toBe('paused');
      let creditPid = 0;
      const started = deferred();
      credit = h.credit(y, {
        via: p.right,
        onPid: (pid) => {
          creditPid = pid;
          started.resolve();
        },
      });
      await started.promise;
      await waitBlocked(p.control, creditPid, arrivePid);
      release.resolve();
      results.push(await arrival, await credit);
    } finally {
      release.resolve();
      await arrival.catch(() => undefined);
      await credit?.catch(() => undefined);
    }
    await expectSerialResult(s, results[0] as Arrival, results[1]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zza#20] 并发（入账先）：Y 的入账锁住 U 的 users 行并读完状态后暂停，X 的同步事务（联盟新结算记录 600 负差回应等佣金维权）在 U 的 users 行锁上等待（pg_blocking_pids 观察）；放行后两单都完成、无死锁：Y 正常入账，X 按 R10 记账、本人义务 forfeited 并关闭维权记录，U 余额 476，余额、分录与义务都与串行结果一致',
  async () => {
    const s = await pair();
    const { h, x, y } = s;
    h.clock.set(LATER);
    h.boot();
    const paused = deferred();
    const release = deferred();
    h.pauseAfterStates(async () => {
      paused.resolve();
      await release.promise;
    });
    let creditPid = 0;
    const credit = h.credit(y, {
      via: p.left,
      onPid: (pid) => {
        creditPid = pid;
      },
    });
    let arrival: Promise<Arrival> | undefined;
    const results: unknown[] = [];
    try {
      const reached = await firstOf(paused.promise, credit);
      expect(reached, 'the credit pauses after reading the states').toBe('paused');
      let arrivePid = 0;
      const started = deferred();
      arrival = h.arrive(x, {
        settleAfter: 600n,
        newSeq: 3,
        via: p.right,
        onPid: (pid) => {
          arrivePid = pid;
          started.resolve();
        },
      });
      await started.promise;
      await waitBlocked(p.control, arrivePid, creditPid);
      release.resolve();
      results.push(await credit, await arrival);
    } finally {
      release.resolve();
      await credit.catch(() => undefined);
      await arrival?.catch(() => undefined);
    }
    await expectSerialResult(s, results[1] as Arrival, results[0]);
  },
  TIMEOUT,
);
