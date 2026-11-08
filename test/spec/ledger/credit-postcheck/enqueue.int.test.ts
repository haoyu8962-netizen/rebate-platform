// B2-02t rule tests: what R5 and R5a enqueue, on which transaction, and what stays out of the job
// (D10-1038 ①②). Tests that assert “no job” start with an order that does send one, so a missing
// enqueue cannot pass them.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { TIMEOUT, creditKey as r5aCreditKey } from '../../settlement/beneficiary-credit/kit.ts';
import { creditKey, databaseFixture, forfeitKey } from '../../settlement/credit/kit.ts';
import { expectOneJob, expectQuiet, lastJob, r5Side, r5aSide, voucherIdOf } from './kit.ts';

const p = databaseFixture(createTestDatabase);

/** Five minutes: BR-FUND-19's window. */
const WINDOW_SECONDS = 300;

it(
  '[AC-B2-02t#16] R5：写完凭证同事务入队一个任务，带三张受益人 CREDIT 凭证、写凭证时的基数和净额 0，不延后超过 5 分钟',
  async () => {
    const { h, side, credit } = await r5Side(p.db);
    const o = await h.order();

    await credit(o);

    const sent = expectOneJob(side, o.orderId, [
      {
        voucher_id: await voucherIdOf(h, creditKey(o, 'self')),
        user_id: o.user('self'),
        role: 'self',
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
    expect(sent.options.trx, 'enqueued on the credit’s transaction').toBe(side.transactions[0]);
    expect(sent.options.delaySeconds ?? 0).toBeLessThan(WINDOW_SECONDS);
  },
  TIMEOUT,
);

it(
  '[AC-B2-02t#23] R5a：写完凭证同事务入队，只带这一张凭证',
  async () => {
    const { h, side, execute } = await r5aSide(p.db);
    const o = await h.order();

    await execute(o);

    expect(side.sends).toHaveLength(1);
    expect(side.sends[0]!.options.trx, 'enqueued on the item’s transaction').toBe(
      side.transactions[0],
    );
    expect(side.sends[0]!.options.delaySeconds ?? 0).toBeLessThan(WINDOW_SECONDS);
    expect(lastJob(side).vouchers.map((v) => v.voucher_id)).toEqual([
      await voucherIdOf(h, r5aCreditKey(o, 'direct')),
    ]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-02t#8] R5 不核的凭证与无凭证的受益人不进任务：平台留存、暂缓、快照已没收；全无凭证时不入队、不报错',
  async () => {
    const { h, side, credit } = await r5Side(p.db);
    const mixed = await h.order({
      people: [
        { role: 'self', ratioBp: 5000 },
        { role: 'direct', ratioBp: 1000, state: 'frozen' },
        { role: 'indirect', ratioBp: 500, initialStatus: 'forfeited' },
      ],
    });

    await credit(mixed);

    expectOneJob(side, mixed.orderId, [
      {
        voucher_id: await voucherIdOf(h, creditKey(mixed, 'self')),
        user_id: mixed.user('self'),
        role: 'self',
        kind: 'credit',
        base_fen: '850',
        net_before_fen: '0',
      },
    ]);

    // B = 0: every share is 0, no beneficiary voucher at all.
    await credit(await h.order({ settleFen: 0n }));

    expect(side.sends, 'no job without a checked voucher').toHaveLength(1);
    await expectQuiet(side);
  },
  TIMEOUT,
);

it(
  '[AC-B2-02t#24] R5 转没收凭证进任务（kind forfeit），受益人是被没收的人',
  async () => {
    const { h, side, credit } = await r5Side(p.db);
    const o = await h.order({
      people: [
        { role: 'self', ratioBp: 5000 },
        { role: 'direct', ratioBp: 1000, state: 'banned' },
      ],
    });

    await credit(o);

    expectOneJob(side, o.orderId, [
      {
        voucher_id: await voucherIdOf(h, creditKey(o, 'self')),
        user_id: o.user('self'),
        role: 'self',
        kind: 'credit',
        base_fen: '850',
        net_before_fen: '0',
      },
      {
        voucher_id: await voucherIdOf(h, forfeitKey(o, 'direct')),
        user_id: o.user('direct'),
        role: 'direct',
        kind: 'forfeit',
        base_fen: '850',
        net_before_fen: '0',
      },
    ]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-02t#25] R5a 不核 ADJ:DEFERRED 与 FORFEIT:DEFERRED：延后义务写了凭证也不入队、不报错',
  async () => {
    const { h, side, execute } = await r5aSide(p.db);
    await execute(await h.order());
    expect(side.sends, 'a first_credit item sends one job').toHaveLength(1);

    const credited = await h.order({ adjustTo: 1200n, deferred: ['direct'] });
    expect((await execute(credited)).outcome).toBe('credited');

    const forfeited = await h.order({
      adjustTo: 1200n,
      deferred: ['direct'],
      people: [
        { role: 'self', ratioBp: 5000 },
        { role: 'direct', ratioBp: 1000, state: 'banned' },
        { role: 'indirect', ratioBp: 500 },
      ],
    });
    expect((await execute(forfeited)).outcome).toBe('forfeited');

    expect(side.sends, 'deferred items send nothing').toHaveLength(1);
    await expectQuiet(side);
  },
  TIMEOUT,
);

it(
  '[AC-B2-02t#9] R5 开关 ledger.credit_postcheck.enabled：未设置与 true 入队，false 不入队',
  async () => {
    const { h, side, credit } = await r5Side(p.db);

    await credit(await h.order());
    expect(side.sends, 'unset is on').toHaveLength(1);

    side.setSwitch(true);
    await credit(await h.order());
    expect(side.sends, 'true is on').toHaveLength(2);

    side.setSwitch(false);
    await credit(await h.order());
    expect(side.sends, 'false enqueues nothing').toHaveLength(2);
  },
  TIMEOUT,
);

it(
  '[AC-B2-02t#26] R5a 开关 ledger.credit_postcheck.enabled：未设置入队，false 不入队',
  async () => {
    const { h, side, execute } = await r5aSide(p.db);

    await execute(await h.order());
    expect(side.sends, 'unset is on').toHaveLength(1);

    side.setSwitch(false);
    expect((await execute(await h.order())).outcome).toBe('credited');
    expect(side.sends, 'false enqueues nothing').toHaveLength(1);
  },
  TIMEOUT,
);
