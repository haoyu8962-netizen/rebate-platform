// B2-02t rule tests: the check of R5 vouchers. Example order (settlement credit kit): N = 1000,
// reserve_bp 1500 → B = 850; self 5000 / direct 1000 / indirect 500 → 425 / 85 / 42.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  TIMEOUT,
  creditKey,
  databaseFixture,
  forfeitKey,
  platformKey,
} from '../../settlement/credit/kit.ts';
import {
  alertsOf,
  diffsOf,
  expectDiff,
  expectHold,
  expectOneAlert,
  expectQuiet,
  holdsOf,
  lastJob,
  r5Side,
  voucherIdOf,
} from './kit.ts';

const p = databaseFixture(createTestDatabase);

const DAY_MS = 86_400_000;

it(
  '[AC-B2-02t#1] 一致：R5 各受益人凭证核对通过，不写差错单、不冻结、不告警',
  async () => {
    const { h, side, credit } = await r5Side(p.db);
    const o = await h.order();
    await credit(o);

    expect(lastJob(side).vouchers).toHaveLength(3);
    await side.handle(lastJob(side));

    await expectQuiet(side);
  },
  TIMEOUT,
);

it(
  '[AC-B2-02t#2] 不一致（少一分）：登 ledger_mismatch 差错单，新增一条该用户的 withdraw_holds，告警一条且不含个人信息',
  async () => {
    const { h, side, credit, skew } = await r5Side(p.db);
    const o = await h.order();
    skew(creditKey(o, 'self'), -1n);
    await credit(o);

    await side.handle(lastJob(side));

    const voucherId = await voucherIdOf(h, creditKey(o, 'self'));
    const diff = await expectDiff(side, {
      voucherId,
      expectedFen: 425n,
      actualFen: 424n,
      orderKey: o.orderKey,
      userId: o.user('self'),
      role: 'self',
      baseFen: '850',
      ratioBp: '5000',
    });
    expect(await diffsOf(side), 'only the wrong voucher is registered').toHaveLength(1);
    const holds = await holdsOf(side);
    expect(holds, 'one hold, the wrong voucher’s user only').toHaveLength(1);
    expectHold(side, holds[0], diff.id, o.user('self'));
    expect(holds[0]!.created_at).toEqual(h.clock.now());
    expectOneAlert(
      side,
      o.people.map((person) => person.userId),
    );
  },
  TIMEOUT,
);

it(
  '[AC-B2-02t#18] 多入账与少入账同单：差额 = 重算 − 凭证（正负都有），只冻结对应用户',
  async () => {
    const { h, side, credit, skew } = await r5Side(p.db);
    const o = await h.order();
    skew(creditKey(o, 'self'), 1n);
    skew(creditKey(o, 'direct'), -1n);
    await credit(o);

    await side.handle(lastJob(side));

    const over = await expectDiff(side, {
      voucherId: await voucherIdOf(h, creditKey(o, 'self')),
      expectedFen: 425n,
      actualFen: 426n,
      orderKey: o.orderKey,
      userId: o.user('self'),
      role: 'self',
      baseFen: '850',
      ratioBp: '5000',
    });
    expect(over.diff_fen).toBe(-1n);
    const under = await expectDiff(side, {
      voucherId: await voucherIdOf(h, creditKey(o, 'direct')),
      expectedFen: 85n,
      actualFen: 84n,
      orderKey: o.orderKey,
      userId: o.user('direct'),
      role: 'direct',
      baseFen: '850',
      ratioBp: '1000',
    });
    expect(under.diff_fen).toBe(1n);
    const holds = await holdsOf(side);
    expect(holds.map((hold) => hold.user_id).sort()).toEqual(
      [o.user('self'), o.user('direct')].sort(),
    );
    expect(alertsOf(side)).toHaveLength(2);
  },
  TIMEOUT,
);

it(
  '[AC-B2-02t#3] 重投幂等：同一任务再跑（含隔天重投），不多差错单、不多冻结、不多告警',
  async () => {
    const { h, side, credit, skew } = await r5Side(p.db);
    const o = await h.order();
    skew(creditKey(o, 'self'), -1n);
    await credit(o);
    const payload = lastJob(side);

    await side.handle(payload);
    await side.handle(payload);
    h.clock.advanceMs(DAY_MS);
    await side.handle(payload);

    expect(await diffsOf(side)).toHaveLength(1);
    expect(await holdsOf(side)).toHaveLength(1);
    expectOneAlert(side, [o.user('self')]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-02t#17] 冻结写入失败：差错单同事务回滚、不告警，重投后差错单、冻结、告警各补齐一次',
  async () => {
    const { h, side, credit, skew } = await r5Side(p.db);
    const o = await h.order();
    skew(creditKey(o, 'self'), -1n);
    await credit(o);
    const payload = lastJob(side);

    side.failNextHold();
    await expect(side.handle(payload)).rejects.toThrow(/synthetic hold failure/u);
    await expectQuiet(side);

    await side.handle(payload);

    const diffs = await diffsOf(side);
    expect(diffs).toHaveLength(1);
    const holds = await holdsOf(side);
    expect(holds).toHaveLength(1);
    expectHold(side, holds[0], diffs[0]!.id, o.user('self'));
    expectOneAlert(side, [o.user('self')]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-02t#4] 基数取写凭证那刻：入账后 booked_base_fen 被 R9 / R10 改掉，任务仍按 payload 的 base_fen 核，不误报',
  async () => {
    const { h, side, credit } = await r5Side(p.db);
    const o = await h.order();
    await credit(o);

    await h.db
      .updateTable('orders')
      .set({ booked_base_fen: 1100n, booked_n_fen: 1300n })
      .where('app_id', '=', h.appId)
      .where('order_id', '=', o.orderId)
      .execute();
    expect((await h.read(o)).booked_base_fen).toBe(1100n);

    await side.handle(lastJob(side));

    await expectQuiet(side);
  },
  TIMEOUT,
);

it(
  '[AC-B2-02t#5] commission_version 入账后变动：仍按不可变归属比例核，不误报',
  async () => {
    const { h, side, credit } = await r5Side(p.db);
    const o = await h.order();
    await credit(o);

    // No amount rows exist for version 2: a read at the current version finds nothing.
    await h.db
      .updateTable('orders')
      .set({ commission_version: 2 })
      .where('app_id', '=', h.appId)
      .where('order_id', '=', o.orderId)
      .execute();

    await side.handle(lastJob(side));

    await expectQuiet(side);
  },
  TIMEOUT,
);

it(
  '[AC-B2-02t#7] R5 没收凭证：一致不报；不一致只登差错单、告警，不写 withdraw_holds',
  async () => {
    const consistent = await r5Side(p.db);
    const same = await consistent.h.order({
      people: [
        { role: 'self', ratioBp: 5000 },
        { role: 'direct', ratioBp: 1000, state: 'banned' },
      ],
    });
    await consistent.credit(same);
    await consistent.side.handle(lastJob(consistent.side));
    await expectQuiet(consistent.side);

    const { h, side, credit, skew } = await r5Side(p.db);
    const o = await h.order({
      people: [
        { role: 'self', ratioBp: 5000 },
        { role: 'direct', ratioBp: 1000, state: 'banned' },
      ],
    });
    skew(forfeitKey(o, 'direct'), -1n);
    await credit(o);

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
    expect(await holdsOf(side), 'a forfeit voucher never holds').toEqual([]);
    expectOneAlert(side, [o.user('direct')]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-02t#10] 读不到归属或凭证、payload 不合法：抛错重试，不写差错单、不冻结、不告警，也不当成一致',
  async () => {
    const { h, side, credit } = await r5Side(p.db);
    const o = await h.order();
    await credit(o);
    const payload = lastJob(side);
    const first = payload.vouchers[0]!;
    const withVoucher = (patch: Partial<typeof first>) => ({
      ...payload,
      vouchers: [{ ...first, ...patch }],
    });

    side.failAttribution(true);
    await expect(side.handle(payload), 'attribution read fails').rejects.toThrow(/synthetic/u);
    side.failAttribution(false);
    await expectQuiet(side);

    side.keepBeneficiaries((b) => b.userId !== first.user_id);
    await expect(side.handle(payload), 'beneficiary not in the attribution').rejects.toThrow();
    side.keepBeneficiaries(null);
    await expectQuiet(side);

    await expect(
      side.handle(withVoucher({ voucher_id: '00000000-0000-4000-8000-000000000000' })),
      'voucher unknown',
    ).rejects.toThrow();
    await expectQuiet(side);

    await expect(
      side.handle(withVoucher({ voucher_id: await voucherIdOf(h, platformKey(o)) })),
      'voucher without a USER_BALANCE entry',
    ).rejects.toThrow();
    await expectQuiet(side);

    await expect(
      side.handle(withVoucher({ base_fen: 'not-a-number' })),
      'malformed base_fen',
    ).rejects.toThrow();
    await expectQuiet(side);

    // Same job, nothing wrong any more: it goes through, so the refusals above were the reads.
    await side.handle(payload);
    await expectQuiet(side);
  },
  TIMEOUT,
);

it(
  '[AC-B2-02t#13] 多租户：别的 app 同样的凭证不受影响，也读不到这个 app 的凭证',
  async () => {
    const a = await r5Side(p.db);
    const b = await r5Side(p.db);
    const orderA = await a.h.order();
    const orderB = await b.h.order();
    a.skew(creditKey(orderA, 'self'), -1n);
    await a.credit(orderA);
    await b.credit(orderB);

    await a.side.handle(lastJob(a.side));
    await b.side.handle(lastJob(b.side));

    expect(await diffsOf(a.side)).toHaveLength(1);
    expect(await holdsOf(a.side)).toHaveLength(1);
    await expectQuiet(b.side);

    const crossed = {
      ...lastJob(b.side),
      vouchers: [
        {
          ...lastJob(b.side).vouchers[0]!,
          voucher_id: await voucherIdOf(a.h, creditKey(orderA, 'self')),
        },
      ],
    };
    await expect(b.side.handle(crossed), 'another app’s voucher').rejects.toThrow();
    await expectQuiet(b.side);
    expect(await diffsOf(a.side), 'the other app is untouched').toHaveLength(1);
  },
  TIMEOUT,
);
