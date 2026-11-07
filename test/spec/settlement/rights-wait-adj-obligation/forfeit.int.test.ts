// B2-04zza: a banned / deleted beneficiary with an unfinished obligation, on a CREDITED order whose
// rights success waits for the union (WAIT_COMMISSION), when the union's new settlement record is a
// negative difference. BR-FUND-06 / D10-474 ②: answered as R10 SETTLE_ADJUST, the rights record
// closed on the same transaction. BR-FUND-09: a banned / deleted beneficiary's new entitlement is
// the smaller of the re-split share and the net, the rest goes to the platform difference; the
// obligation whose remaining amount went to the platform is closed on the same transaction
// (BR-FUND-04 ⑫, R10「本次把其剩余未履约金额归了平台…同一事务关闭该义务」); a first-credit obligation
// forfeited in full appends the forfeited event (BR-CALC-13), a deferred one does not (R5a).
//
// Self held at credit (frozen → first_credit obligation, pending 425): direct 85 / indirect 42
// credited, platform 448, UNION_RECEIVABLE 575. Record 600 (seq 3) → B 510 → 255 / 51 / 25:
//   self: net 0, share 255 → 255 to the platform, pending 425 → 0, obligation forfeited;
//   direct 85 → 51 (−34), indirect 42 → 25 (−17);
//   platform new = 600 − (51 + 25) = 524, old 448 → +76 (debit UNION_RECEIVABLE / credit revenue);
//   UNION_RECEIVABLE Δ = −34 − 17 + 76 = +25 = −(1000 − 600) − (0 − 425); after 600.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { LATER, TIMEOUT, databaseFixture, harness, people, receivable } from './kit.ts';

const p = databaseFixture(createTestDatabase);

for (const [ac, state, reason] of [
  [1, 'banned', 'banned'],
  [2, 'deleting', 'deleted'],
  [3, 'deleted', 'deleted'],
] as const) {
  it(
    `[AC-B2-04zza#${ac}] 入账时本人冻结（first_credit 义务、待补记 425），之后${state}；维权成功等佣金中，联盟新结算记录 600（seq 3）负差 → 按 R10 SETTLE_ADJUST 记账（直推 −34、间推 −17、平台 +76，键 ADJ:3，无 CLAWBACK），本人份额 255 归平台、义务 forfeited / closed_by R10 并追加 forfeited 事件（原因 ${reason}），同一同步事务关闭维权记录；应收 600、booked 510 / 600、仍 CREDITED、无告警`,
    async () => {
      const h = await harness(p.db);
      const { o, waitingId } = await h.waiting({ people: people({ self: 'frozen' }) }, (seeded) =>
        h.setState(seeded, 'self', state),
      );
      const obligations = await h.orderObligations(o);
      expect(obligations).toEqual([
        expect.objectContaining({
          user_id: o.user('self'),
          role: 'self',
          kind: 'first_credit',
          status: 'open',
        }),
      ]);
      expect(await h.orderSubjectNet(o, receivable(o))).toBe(575n);
      const keys = await h.orderVoucherKeys(o);
      const events = await h.newBeneficiaryEvents(o);

      h.clock.set(LATER);
      const { result } = await h.arrive(o, { settleAfter: 600n, newSeq: 3 });

      expect(result).toMatchObject({
        outcome: 'settle_adjusted',
        transition: 'R10',
        orderKey: o.orderKey,
        bookedBaseFen: 510n,
        bookedNFen: 600n,
      });
      await h.expectAdjusted(o, keys, 3, { users: { direct: 34n, indirect: 17n }, platform: -76n });
      expect(await h.balance(o.user('self'))).toBe(0n);
      expect(await h.balance(o.user('direct'))).toBe(51n);
      expect(await h.balance(o.user('indirect'))).toBe(25n);
      expect(await h.orderSubjectNet(o, receivable(o))).toBe(600n);
      expect(await h.orderObligations(o)).toEqual([
        expect.objectContaining({
          beneficiary_credit_id: obligations[0]!.beneficiary_credit_id,
          status: 'forfeited',
          closed_by: 'R10',
          closed_at: new Date(LATER),
        }),
      ]);
      expect(await h.newBeneficiaryEvents(o)).toEqual([
        ...events,
        expect.objectContaining({
          user_id: o.user('self'),
          role: 'self',
          status: 'forfeited',
          reason,
          created_at: new Date(LATER),
        }),
      ]);
      await h.expectBooked(o, 510n, 600n);
      await h.expectAnswered(o, waitingId);
      expect(await h.candidates(o)).toEqual([]);
      expect(h.heldAlerts()).toEqual([]);
    },
    TIMEOUT,
  );
}

it(
  '[AC-B2-04zza#4] 本人此前已有延后差额义务（deferred，净额 0、待补记 425），现封禁；维权等佣金中联盟新结算记录 600 负差 → R10 记账（直推 −34、间推 −17、平台 +76），延后义务 forfeited / closed_by R10，不追加 forfeited 事件；维权记录同事务关闭，应收 600、booked 510 / 600',
  async () => {
    const h = await harness(p.db);
    let deferredId = '';
    const { o, waitingId } = await h.waiting({}, async (seeded) => {
      // History: self's 425 went back to UNION_RECEIVABLE and stays pending under a deferred
      // obligation (platform 448 + nets 0 / 85 / 42 + pending 425 = booked_n 1000).
      await h.pastVoucher(seeded, 'self', 425n, 'receivable');
      deferredId = await h.seedDeferred(seeded, 'self');
      await h.setState(seeded, 'self', 'banned');
    });
    expect(await h.balance(o.user('self'))).toBe(0n);
    expect(await h.orderSubjectNet(o, receivable(o))).toBe(575n);
    const keys = await h.orderVoucherKeys(o);
    const events = await h.newBeneficiaryEvents(o);

    h.clock.set(LATER);
    const { result } = await h.arrive(o, { settleAfter: 600n, newSeq: 3 });

    expect(result).toMatchObject({
      outcome: 'settle_adjusted',
      transition: 'R10',
      bookedBaseFen: 510n,
      bookedNFen: 600n,
    });
    await h.expectAdjusted(o, keys, 3, { users: { direct: 34n, indirect: 17n }, platform: -76n });
    expect(await h.balance(o.user('self'))).toBe(0n);
    expect(await h.orderSubjectNet(o, receivable(o))).toBe(600n);
    expect(await h.orderObligations(o)).toEqual([
      expect.objectContaining({
        beneficiary_credit_id: deferredId,
        kind: 'deferred',
        status: 'forfeited',
        closed_by: 'R10',
        closed_at: new Date(LATER),
      }),
    ]);
    expect(await h.newBeneficiaryEvents(o)).toEqual(events);
    await h.expectBooked(o, 510n, 600n);
    await h.expectAnswered(o, waitingId);
    expect(h.heldAlerts()).toEqual([]);
  },
  TIMEOUT,
);
