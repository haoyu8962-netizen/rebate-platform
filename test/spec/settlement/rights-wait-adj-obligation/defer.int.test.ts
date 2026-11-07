// B2-04zza: a frozen / appealing beneficiary on a CREDITED order whose rights success waits for the
// union (WAIT_COMMISSION), when the union's new settlement record is a negative difference.
// BR-FUND-06 / D10-474 ②: R10 SETTLE_ADJUST, rights record closed on the same transaction.
// BR-FUND-09 负差一路「冻结、申诉中受益人的正差…留作待补记额（BR-FUND-04 ⑫ 受益人补记项）；都不进补差
// 候选」: without an open obligation a new deferred one is opened by R10 (B2-04zi shape: kind deferred,
// origin SETTLE_ADJUST / SETTLE_DIFF); with one it stays open and its pending amount (re-split share
// at the new booked_base_fen − net, BR-FUND-19 ⑤) follows the new booked pair.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { LATER, TIMEOUT, databaseFixture, harness, people, receivable } from './kit.ts';

const p = databaseFixture(createTestDatabase);

// Self credited 425, then an earlier clawback moved it to the platform (net 0, platform 873, no
// obligation, UNION_RECEIVABLE 1000); self frozen / appealing. Record 600 (seq 3) → 255 / 51 / 25:
//   self: net 0, share 255 → pending 255 (new deferred obligation, nothing paid);
//   direct −34, indirect −17;
//   platform new = 600 − (255 + 51 + 25) = 269, old 873 → −604 (debit revenue / credit receivable);
//   UNION_RECEIVABLE Δ = −34 − 17 − 604 = −655 = −(1000 − 600) − (255 − 0); after 345.
for (const [ac, state] of [
  [5, 'frozen'],
  [6, 'appealing'],
] as const) {
  it(
    `[AC-B2-04zza#${ac}] 本人净额已由历史扣回降到 0、无义务、现${state}；维权等佣金中联盟新结算记录 600（seq 3）负差 → R10 记账（直推 −34、间推 −17、平台 −604，键 ADJ:3），本人正差 255 留作待补记：新开 deferred 义务（opened_by R10、来源 SETTLE_ADJUST / SETTLE_DIFF），不补给、不进候选；同事务关闭维权记录，应收 345、booked 510 / 600`,
    async () => {
      const h = await harness(p.db);
      const { o, waitingId } = await h.waiting({}, async (seeded) => {
        await h.pastVoucher(seeded, 'self', 425n, 'revenue');
        await h.setState(seeded, 'self', state);
      });
      expect(await h.orderObligations(o)).toEqual([]);
      expect(await h.balance(o.user('self'))).toBe(0n);
      expect(await h.orderSubjectNet(o, receivable(o))).toBe(1000n);
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
      await h.expectAdjusted(o, keys, 3, { users: { direct: 34n, indirect: 17n }, platform: 604n });
      expect(await h.balance(o.user('self'))).toBe(0n);
      expect(await h.balance(o.user('direct'))).toBe(51n);
      expect(await h.balance(o.user('indirect'))).toBe(25n);
      expect(await h.orderSubjectNet(o, receivable(o))).toBe(345n);
      expect(await h.orderObligations(o)).toEqual([
        expect.objectContaining({
          app_id: h.appId,
          order_id: o.orderId,
          user_id: o.user('self'),
          role: 'self',
          kind: 'deferred',
          status: 'open',
          opened_by: 'R10',
          origin_ledger_type: 'SETTLE_ADJUST',
          origin_sub_type: 'SETTLE_DIFF',
          opened_at: new Date(LATER),
          closed_by: null,
          closed_at: null,
        }),
      ]);
      expect(await h.newBeneficiaryEvents(o)).toEqual(events);
      expect(await h.candidates(o)).toEqual([]);
      await h.expectBooked(o, 510n, 600n);
      await h.expectAnswered(o, waitingId);
      expect(h.heldAlerts()).toEqual([]);
    },
    TIMEOUT,
  );
}

// Self held at credit (first_credit obligation, pending 425), still frozen / appealing. Record 600:
//   self: net 0, share 255 → pending 425 → 255, obligation kept open (same row);
//   direct −34, indirect −17;
//   platform new = 600 − (255 + 51 + 25) = 269, old 448 → −179;
//   UNION_RECEIVABLE Δ = −34 − 17 − 179 = −230 = −(1000 − 600) − (255 − 425); 575 → 345.
for (const [ac, state] of [
  [7, 'frozen'],
  [8, 'appealing'],
] as const) {
  it(
    `[AC-B2-04zza#${ac}] 入账时本人${state}（first_credit 义务、待补记 425）且仍${state}；维权等佣金中联盟新结算记录 600 负差 → R10 记账（直推 −34、间推 −17、平台 −179），义务保持未完成（同一行不变），待补记额按新 booked 510 重算为 255（应收 575 → 345）；同事务关闭维权记录，booked 510 / 600、仍 CREDITED`,
    async () => {
      const h = await harness(p.db);
      const { o, waitingId } = await h.waiting({ people: people({ self: state }) });
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
        bookedBaseFen: 510n,
        bookedNFen: 600n,
      });
      await h.expectAdjusted(o, keys, 3, { users: { direct: 34n, indirect: 17n }, platform: 179n });
      expect(await h.balance(o.user('self'))).toBe(0n);
      expect(await h.balance(o.user('direct'))).toBe(51n);
      expect(await h.balance(o.user('indirect'))).toBe(25n);
      // BR-FUND-19 ⑤: UNION_RECEIVABLE = booked_n 600 − Σ pending 255.
      expect(await h.orderSubjectNet(o, receivable(o))).toBe(345n);
      expect(await h.orderObligations(o)).toEqual(obligations);
      expect(await h.newBeneficiaryEvents(o)).toEqual(events);
      expect(await h.candidates(o)).toEqual([]);
      await h.expectBooked(o, 510n, 600n);
      await h.expectAnswered(o, waitingId);
      expect(h.heldAlerts()).toEqual([]);
    },
    TIMEOUT,
  );
}

// Self held at credit (frozen → first_credit obligation, pending 425), then released to normal; the
// R5a credit of the obligation has not run yet (BR-FUND-09 负差一路「已解除、等补记的份额，留作待补记
// 额」). Record 600: same money as #7 — self's share 255 stays pending under the same obligation, not
// paid out by the R10; direct −34, indirect −17, platform −179; UNION_RECEIVABLE 575 → 345.
it(
  '[AC-B2-04zza#18] 入账时本人冻结（first_credit 义务、待补记 425），之后恢复 normal 但补记尚未执行；维权等佣金中联盟新结算记录 600 负差 → R10 记账（直推 −34、间推 −17、平台 −179），本人不写凭证、余额仍 0，义务保持未完成（同一行不变），待补记额按新 booked 510 重算为 255（应收 575 → 345）；不进候选、无 forfeited 事件；同事务关闭维权记录，booked 510 / 600、仍 CREDITED',
  async () => {
    const h = await harness(p.db);
    const { o, waitingId } = await h.waiting({ people: people({ self: 'frozen' }) }, (seeded) =>
      h.setState(seeded, 'self', 'normal'),
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
    expect(await h.balance(o.user('self'))).toBe(0n);
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
    await h.expectAdjusted(o, keys, 3, { users: { direct: 34n, indirect: 17n }, platform: 179n });
    expect(await h.balance(o.user('self'))).toBe(0n);
    expect(await h.balance(o.user('direct'))).toBe(51n);
    expect(await h.balance(o.user('indirect'))).toBe(25n);
    // BR-FUND-19 ⑤: UNION_RECEIVABLE = booked_n 600 − Σ pending 255.
    expect(await h.orderSubjectNet(o, receivable(o))).toBe(345n);
    expect(await h.orderObligations(o)).toEqual(obligations);
    expect(await h.newBeneficiaryEvents(o)).toEqual(events);
    expect(await h.candidates(o)).toEqual([]);
    await h.expectBooked(o, 510n, 600n);
    await h.expectAnswered(o, waitingId);
    expect(h.heldAlerts()).toEqual([]);
  },
  TIMEOUT,
);
