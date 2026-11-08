// B2-02t rule tests: the check of R5a first_credit vouchers (BR-FUND-04 ⑫; D10-1038 ② 偏离 1、2).
// Example order (settlement beneficiary-credit kit): N = 1000, reserve_bp 1500 → booked_base_fen 850;
// direct 1000 → 85, held at R5 with an open first_credit obligation.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  TIMEOUT,
  creditKey,
  databaseFixture,
  forfeitKey,
  type Harness,
  type SeededOrder,
} from '../../settlement/beneficiary-credit/kit.ts';
import {
  diffsOf,
  expectDiff,
  expectHold,
  expectOneAlert,
  expectOneJob,
  expectQuiet,
  holdsOf,
  lastJob,
  r5aSide,
  voucherIdOf,
} from './kit.ts';

const p = databaseFixture(createTestDatabase);

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
  '[AC-B2-02t#6] R5a net_before_fen = 0：金额 = floor(B×bp)，任务带写凭证时的基数，一致不报',
  async () => {
    const { h, side, execute } = await r5aSide(p.db);
    const o = await h.order();

    expect((await execute(o)).outcome).toBe('credited');

    expect(await h.voucherLines(creditKey(o, 'direct'))).toHaveLength(2);
    expectOneJob(side, o.orderId, [
      {
        voucher_id: await voucherIdOf(h, creditKey(o, 'direct')),
        user_id: o.user('direct'),
        role: 'direct',
        kind: 'credit',
        base_fen: '850',
        net_before_fen: '0',
      },
    ]);
    await side.handle(lastJob(side));
    await expectQuiet(side);
  },
  TIMEOUT,
);

it(
  '[AC-B2-02t#20] R5a net_before_fen > 0：金额 = floor(B×bp) − 写前净额，任务带写前净额，一致不报',
  async () => {
    const { h, side, execute } = await r5aSide(p.db);
    const o = await h.order();
    await netBefore(h, o);

    expect(await execute(o)).toMatchObject({ outcome: 'credited', amountFen: 55n });

    expectOneJob(side, o.orderId, [
      {
        voucher_id: await voucherIdOf(h, creditKey(o, 'direct')),
        user_id: o.user('direct'),
        role: 'direct',
        kind: 'credit',
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
  '[AC-B2-02t#21] R5a net_before_fen > 0 差一分：报差错单（重算 55、凭证 54），冻结该用户，告警一条',
  async () => {
    const { h, side, execute, skew } = await r5aSide(p.db);
    const o = await h.order();
    await netBefore(h, o);
    skew(creditKey(o, 'direct'), -1n);

    await execute(o);
    await side.handle(lastJob(side));

    const diff = await expectDiff(side, {
      voucherId: await voucherIdOf(h, creditKey(o, 'direct')),
      expectedFen: 55n,
      actualFen: 54n,
      orderKey: o.orderKey,
      userId: o.user('direct'),
      role: 'direct',
      baseFen: '850',
      ratioBp: '1000',
    });
    const holds = await holdsOf(side);
    expect(holds).toHaveLength(1);
    expectHold(side, holds[0], diff.id, o.user('direct'));
    expectOneAlert(side, [o.user('direct')]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-02t#22] R5a 转没收（首次入账义务）：一致不报；差一分只登差错单、告警，不写 withdraw_holds',
  async () => {
    const people = [
      { role: 'self', ratioBp: 5000 },
      { role: 'direct', ratioBp: 1000, state: 'banned' },
      { role: 'indirect', ratioBp: 500 },
    ] as const;

    const same = await r5aSide(p.db);
    const consistent = await same.h.order({ people });
    expect((await same.execute(consistent)).outcome).toBe('forfeited');
    expectOneJob(same.side, consistent.orderId, [
      {
        voucher_id: await voucherIdOf(same.h, forfeitKey(consistent, 'direct')),
        user_id: consistent.user('direct'),
        role: 'direct',
        kind: 'forfeit',
        base_fen: '850',
        net_before_fen: '0',
      },
    ]);
    await same.side.handle(lastJob(same.side));
    await expectQuiet(same.side);

    const { h, side, execute, skew } = await r5aSide(p.db);
    const o = await h.order({ people });
    skew(forfeitKey(o, 'direct'), -1n);
    await execute(o);
    await side.handle(lastJob(side));

    await expectDiff(side, {
      voucherId: await voucherIdOf(h, forfeitKey(o, 'direct')),
      expectedFen: 85n,
      actualFen: 84n,
      orderKey: o.orderKey,
      userId: o.user('direct'),
      role: 'direct',
      baseFen: '850',
      ratioBp: '1000',
    });
    expect(await diffsOf(side)).toHaveLength(1);
    expect(await holdsOf(side), 'a forfeit voucher never holds').toEqual([]);
    expectOneAlert(side, [o.user('direct')]);
  },
  TIMEOUT,
);
