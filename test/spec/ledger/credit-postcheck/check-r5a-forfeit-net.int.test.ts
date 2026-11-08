// B2-02t rule tests: an R5a first_credit item that turns into a forfeit after the beneficiary already
// holds a net on the order (BR-FUND-04 ⑫; BR-CALC-13). Example order: booked_base_fen 850, direct 1000
// → 85, net before the voucher 30, so the forfeit voucher and the recomputed share are both 55. The job
// the real R5a path sends must carry that net, or a correct forfeit would be reported as 85 ≠ 55.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  TIMEOUT,
  databaseFixture,
  forfeitKey,
  platformLines,
  type Harness,
  type PersonSpec,
  type SeededOrder,
} from '../../settlement/beneficiary-credit/kit.ts';
import {
  diffsOf,
  expectDiff,
  expectOneAlert,
  expectOneJob,
  expectQuiet,
  holdsOf,
  lastJob,
  r5aSide,
  voucherIdOf,
} from './kit.ts';

const p = databaseFixture(createTestDatabase);

/** Direct is banned when the item runs, so its first_credit obligation is forfeited. */
const PEOPLE: readonly PersonSpec[] = [
  { role: 'self', ratioBp: 5000 },
  { role: 'direct', ratioBp: 1000, state: 'banned' },
  { role: 'indirect', ratioBp: 500 },
];

/** A net of 30 already on the direct key: BR-FUND-19 ⑤ still holds (receivable 945 = 1000 − 55). */
async function netBefore(h: Harness, o: SeededOrder): Promise<void> {
  const direct = o.people.find((person) => person.role === 'direct');
  expect(direct, 'the direct beneficiary').toBeDefined();
  await h.seedVoucher(
    h.userVoucher(
      o,
      `${o.orderKey}:${o.user('direct')}:direct:ADJ:2`,
      direct!,
      30n,
      'SETTLE_ADJUST',
      'SETTLE_ADJUST',
      'SETTLE_DIFF',
    ),
  );
  expect(await h.netOf(o, 'direct')).toBe(30n);
}

it(
  '[AC-B2-02t#28] R5a 转没收且写前净额 30：入队带净额 30，凭证与重算都是 55，一致不报、不写 withdraw_holds',
  async () => {
    const { h, side, execute } = await r5aSide(p.db);
    const o = await h.order({ people: PEOPLE });
    await netBefore(h, o);

    expect(await execute(o)).toMatchObject({ outcome: 'forfeited', amountFen: 55n });

    expect(await h.voucherLines(forfeitKey(o, 'direct'))).toEqual(platformLines(o, 55n));
    expectOneJob(side, o.orderId, [
      {
        voucher_id: await voucherIdOf(h, forfeitKey(o, 'direct')),
        user_id: o.user('direct'),
        role: 'direct',
        kind: 'forfeit',
        base_fen: '850',
        net_before_fen: '30',
      },
    ]);
    await side.handle(lastJob(side));
    await expectQuiet(side);
  },
  TIMEOUT,
);

it(
  '[AC-B2-02t#29] R5a 转没收且写前净额 30 差一分：入队带净额 30，差错单重算 55、凭证 54，告警一条，不写 withdraw_holds',
  async () => {
    const { h, side, execute, skew } = await r5aSide(p.db);
    const o = await h.order({ people: PEOPLE });
    await netBefore(h, o);
    skew(forfeitKey(o, 'direct'), -1n);

    expect((await execute(o)).outcome).toBe('forfeited');

    const voucherId = await voucherIdOf(h, forfeitKey(o, 'direct'));
    expectOneJob(side, o.orderId, [
      {
        voucher_id: voucherId,
        user_id: o.user('direct'),
        role: 'direct',
        kind: 'forfeit',
        base_fen: '850',
        net_before_fen: '30',
      },
    ]);
    await side.handle(lastJob(side));

    await expectDiff(side, {
      voucherId,
      expectedFen: 55n,
      actualFen: 54n,
      orderKey: o.orderKey,
      userId: o.user('direct'),
      role: 'direct',
      baseFen: '850',
      ratioBp: '1000',
    });
    expect(await diffsOf(side)).toHaveLength(1);
    expect(await holdsOf(side), 'a forfeit voucher never holds').toEqual([]);
    expectOneAlert(
      side,
      o.people.map((person) => person.userId),
    );
  },
  TIMEOUT,
);
