// B2-09zb rule test (claude-independent, SPEC_REF 18f0015; D10-802): a forfeited share in the
// positive route (08 BR-CALC-09: status=forfeited 的受益人新应得恒为 0，不生成任何调整（经申诉恢复的除外）;
// BR-FUND-09: 正差一路里不出现受益人负差). A forfeited share whose order net is negative must still get
// no candidate row: its "new entitlement 0 − net" would be a positive difference, but a forfeited
// share takes no adjustment at all. The other beneficiaries and the platform row are generated as
// usual. Contrast: banned / deleted / minor take min(re-split share, net), never a positive
// difference for a negative net, so only the forfeited status gives this case its teeth.
//
// Seeding (no INSERT of voucher rows): the real B2-04m credit (1234: 617 / 123, platform 494), then a
// beneficiary-key CLAWBACK posted through the real ledger post (debit self's available 700, credit
// COMMISSION_REVENUE 700: self's net 617 − 700 = −83, platform net 494 + 700 = 1194; BR-FUND-19 ⑤
// still holds: −83 + 123 + 1194 = 1234 = booked_n_fen = UNION_RECEIVABLE), and a forfeited event of
// (self) through the harness' commission event writer (isForfeitedShare). No settlement path
// leaves a forfeited share negative on its own, so the net is put there by the ledger directly.
//
// Settlement 1300 (reserve 0): direct 130 − 123 = +7; self forfeited, no row, its net stays −83;
// platform new = 1300 − 130 − (−83) = 1253, 1253 − 1194 = +59 (its 26 plus self's 33 increase).
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  EXAMPLE,
  TIMEOUT,
  adjustHarness,
  beneficiaryRow,
  createDatabase,
  databaseFixture,
  ordered,
  platformRow,
  type AdjustHarness,
  type SeededOrder,
} from './harness.ts';

const p = databaseFixture(createDatabase);

/** A beneficiary-key CLAWBACK of `amount` to COMMISSION_REVENUE, through the real ledger post. */
async function clawToPlatform(h: AdjustHarness, o: SeededOrder, amount: bigint): Promise<void> {
  const userId = o.user('self');
  await p.db.transaction().execute(async (trx) => {
    const [balance] = await h.ledger.lockBalances(trx, { appId: h.appId, userIds: [userId] });
    if (balance === undefined) throw new Error('forfeited test: self has no account');
    await h.ledger.post(trx, {
      appId: h.appId,
      uniqKey: `${o.orderKey}:${userId}:self:CLAWBACK:${randomUUID()}`,
      bizType: 'ORDER_CLAWBACK',
      bizId: o.orderKey,
      operator: 'system',
      memo: null,
      orderKey: o.orderKey,
      beneficiaryUserId: userId,
      role: 'self',
      voucherKind: 'CLAWBACK',
      entries: [
        {
          account: { ownerType: 'user', accountId: balance.account_id },
          sub_account: 'available',
          amount_fen: amount,
          ledger_type: 'CLAWBACK',
          sub_type: null,
          income_type: null,
        },
        {
          account: { ownerType: 'platform', subject: 'COMMISSION_REVENUE' },
          sub_account: 'available',
          amount_fen: -amount,
          ledger_type: 'CLAWBACK',
          sub_type: null,
          income_type: null,
        },
      ],
    });
  });
}

it(
  '[AC-B2-09zb#4] forfeited 份额订单净额为负（−83）：结算上调到 1300 后不给它写候选行；直推 +7、平台行 +59 照常',
  async () => {
    const h = await adjustHarness(p.db);
    const o = await h.credited(EXAMPLE);
    await clawToPlatform(h, o, 700n);
    await p.db.transaction().execute((trx) =>
      h.appendBeneficiaryEvent(trx, {
        appId: h.appId,
        orderId: o.orderId,
        userId: o.user('self'),
        role: 'self',
        status: 'forfeited',
        reason: 'banned',
      }),
    );
    // The settlement record is written strictly after the seeded CLAWBACK (决-10 A takes it).
    h.clock.advanceMs(15 * 60_000);
    const seq = await h.settle(o, 1300n);
    // The seeded state the case is about (BR-FUND-08 net of the forfeited share, platform net).
    expect(await h.netOf(o, 'self')).toBe(-83n);
    expect((await h.nets(o)).platform_net_fen).toBe(1194n);
    const before = await h.state();

    await h.run();

    expect(ordered(await h.rowsOf(o))).toEqual([
      beneficiaryRow(o, 'direct', 7n, seq),
      platformRow(59n, seq),
    ]);
    expect(await h.netOf(o, 'self')).toBe(-83n);
    expect(await h.state()).toEqual(before);
  },
  TIMEOUT,
);
