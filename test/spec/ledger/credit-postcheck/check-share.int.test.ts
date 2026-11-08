// B2-02t rule tests: share orders (buy_type share, role share, BR-CALC-24) through the real R5 and R5a
// entries. Example order: B = 850; share 5000 / direct 1000 / indirect 500 → 425 / 85 / 42.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { creditKey as r5aCreditKey, userLines } from '../../settlement/beneficiary-credit/kit.ts';
import {
  TIMEOUT,
  creditKey,
  databaseFixture,
  userCreditLines,
} from '../../settlement/credit/kit.ts';
import {
  diffsOf,
  expectDiff,
  expectHold,
  expectOneAlert,
  expectOneJob,
  expectQuiet,
  holdsOf,
  lastJob,
  r5Side,
  r5aSide,
  voucherIdOf,
} from './kit.ts';

const p = databaseFixture(createTestDatabase);

const SHARE_PEOPLE = [
  { role: 'share', ratioBp: 5000 },
  { role: 'direct', ratioBp: 1000 },
  { role: 'indirect', ratioBp: 500 },
] as const;

it(
  '[AC-B2-02t#30] R5 分享单：入队包含 share 凭证，金额一致不报',
  async () => {
    const { h, side, credit } = await r5Side(p.db);
    const o = await h.order({ people: SHARE_PEOPLE });

    await credit(o);

    expect(await h.voucherLines(creditKey(o, 'share'))).toEqual(userCreditLines(o, 'share', 425n));
    expectOneJob(side, o.orderId, [
      {
        voucher_id: await voucherIdOf(h, creditKey(o, 'share')),
        user_id: o.user('share'),
        role: 'share',
        kind: 'credit',
        base_fen: '850',
        net_before_fen: '0',
      },
      {
        voucher_id: await voucherIdOf(h, creditKey(o, 'direct')),
        user_id: o.user('direct'),
        role: 'direct',
        kind: 'credit',
        base_fen: '850',
        net_before_fen: '0',
      },
      {
        voucher_id: await voucherIdOf(h, creditKey(o, 'indirect')),
        user_id: o.user('indirect'),
        role: 'indirect',
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
  '[AC-B2-02t#31] R5 分享单 share 凭证差一分：登差错单（重算 425、凭证 424），冻结分享者，告警一条',
  async () => {
    const { h, side, credit, skew } = await r5Side(p.db);
    const o = await h.order({ people: SHARE_PEOPLE });
    skew(creditKey(o, 'share'), -1n);

    await credit(o);
    await side.handle(lastJob(side));

    const diff = await expectDiff(side, {
      voucherId: await voucherIdOf(h, creditKey(o, 'share')),
      expectedFen: 425n,
      actualFen: 424n,
      orderKey: o.orderKey,
      userId: o.user('share'),
      role: 'share',
      baseFen: '850',
      ratioBp: '5000',
    });
    expect(await diffsOf(side), 'only the wrong voucher is registered').toHaveLength(1);
    const holds = await holdsOf(side);
    expect(holds, 'one hold, the sharer only').toHaveLength(1);
    expectHold(side, holds[0], diff.id, o.user('share'));
    expectOneAlert(
      side,
      o.people.map((person) => person.userId),
    );
  },
  TIMEOUT,
);

it(
  '[AC-B2-02t#32] R5a 分享单 share 首次入账义务：入队带 share 凭证，金额一致不报',
  async () => {
    const { h, side, execute } = await r5aSide(p.db);
    const o = await h.order({ people: SHARE_PEOPLE, held: ['share'] });

    expect(await execute(o)).toMatchObject({ outcome: 'credited', amountFen: 425n });

    expect(await h.voucherLines(r5aCreditKey(o, 'share'))).toEqual(userLines(o, 'share', 425n));
    expectOneJob(side, o.orderId, [
      {
        voucher_id: await voucherIdOf(h, r5aCreditKey(o, 'share')),
        user_id: o.user('share'),
        role: 'share',
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
  '[AC-B2-02t#33] R5a 分享单 share 凭证差一分：登差错单（重算 425、凭证 424），冻结分享者，告警一条',
  async () => {
    const { h, side, execute, skew } = await r5aSide(p.db);
    const o = await h.order({ people: SHARE_PEOPLE, held: ['share'] });
    skew(r5aCreditKey(o, 'share'), -1n);

    await execute(o);
    await side.handle(lastJob(side));

    const diff = await expectDiff(side, {
      voucherId: await voucherIdOf(h, r5aCreditKey(o, 'share')),
      expectedFen: 425n,
      actualFen: 424n,
      orderKey: o.orderKey,
      userId: o.user('share'),
      role: 'share',
      baseFen: '850',
      ratioBp: '5000',
    });
    expect(await diffsOf(side)).toHaveLength(1);
    const holds = await holdsOf(side);
    expect(holds, 'one hold, the sharer only').toHaveLength(1);
    expectHold(side, holds[0], diff.id, o.user('share'));
    expectOneAlert(
      side,
      o.people.map((person) => person.userId),
    );
  },
  TIMEOUT,
);
