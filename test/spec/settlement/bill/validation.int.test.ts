import { createTestDatabase } from '@couli/db/testing';
import type { BillValidationResult } from '@couli/domain';
import { expect, it } from 'vitest';
import { appendVersion } from '../../commission/snapshot-read/fixtures.ts';
import {
  databaseFixture,
  fixture,
  order,
  settlement,
  snapshot,
  state,
  validations,
  currentVersion,
  NOW,
  BEFORE,
  MONTH,
  TIMEOUT,
} from './kit.ts';

const database = databaseFixture(createTestDatabase);

it(
  '[AC-B2-04n#29] 换算读取不可变淘礼金扣减，不把原始联盟佣金当作 B_settle',
  async () => {
    const h = fixture(database.db);
    await snapshot(h);
    const o = await order(h, {}, 'taobao', {
      tlj: 100n,
      base: 750n,
      amounts: [375n, 75n, 37n],
      userTotal: 487n,
      retain: 263n,
    });
    h.readTljDeductFen.mockResolvedValue(100n);
    await settlement(h, o);
    await h.run();
    const s = await state(h);
    expect(s.items).toEqual([expect.objectContaining({ order_id: o.id, b_settle_fen: 750n })]);
    expect(s.diffs).toEqual([]);
    expect(s.bills[0]).toMatchObject({ beneficiary_total_fen: 487n, platform_retained_fen: 263n });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04n#30] 零基数且联盟零结算仍可成为候选，不生成应结未结差错',
  async () => {
    const h = fixture(database.db);
    await snapshot(h);
    const o = await order(h);
    await appendVersion(h.db, o, 2, 0n, 0n, [0n, 0n, 0n], 0n, new Date(BEFORE));
    o.fact.order.commissionVersion = 2;
    await settlement(h, o, { settle_commission_fen: 0n });
    await h.run();
    const s = await state(h);
    expect(s.items).toEqual([expect.objectContaining({ order_id: o.id, b_settle_fen: 0n })]);
    expect(s.bills[0]).toMatchObject({ beneficiary_total_fen: 0n, platform_retained_fen: 0n });
    expect(s.diffs).toEqual([]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04n#7] WAITING 有结算数据收历史月份，无数据只收账单月，未来月份排除',
  async () => {
    const h = fixture(database.db);
    await snapshot(h);
    const old = await order(h, { settlePeriod: '2032-05' });
    const current = await order(h);
    const future = await order(h, { settlePeriod: '2032-07' });
    const oldMissing = await order(h, { settlePeriod: '2032-05' });
    const missing = await order(h);
    const futureMissing = await order(h, { settlePeriod: '2032-07' });
    for (const o of [old, current, future]) await settlement(h, o);
    await h.run();
    expect((await validations(h)).map((v) => [v.orderKey, v.result]).sort()).toEqual(
      [
        [old.key, 'candidate'],
        [current.key, 'candidate'],
        [missing.key, 'missing_settlement'],
      ].sort(),
    );
    const s = await state(h);
    expect(s.items.map((i) => i.order_id).sort()).toEqual([old.id, current.id].sort());
    // B2-18a：账单月内无结算数据只计入应结未结数，不再登记 settle_missing。
    expect(s.diffs).not.toContainEqual(
      expect.objectContaining({ type: 'settle_missing', ref_id: missing.key, period: MONTH }),
    );
    expect(s.diffs).toEqual([]);
    expect(
      s.items.some((i) => [future.id, oldMissing.id, futureMissing.id].includes(i.order_id)),
    ).toBe(false);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04n#8] 生成截点含等号，只用截至截点的最大 seq，不用更晚收到的旧联盟时间覆盖',
  async () => {
    const h = fixture(database.db);
    await snapshot(h);
    const a = await order(h);
    await settlement(h, a, { seq: 1, settle_commission_fen: 2000n });
    await settlement(h, a, { seq: 2, created_at: new Date(NOW) });
    await settlement(h, a, {
      seq: 3,
      created_at: new Date('2032-07-24T00:10:00.001+08:00'),
      settled_at: new Date(BEFORE),
      settle_commission_fen: 3000n,
    });
    const late = await order(h);
    await settlement(h, late, { created_at: new Date('2032-07-24T00:10:00.001+08:00') });
    await h.run();
    expect((await state(h)).items).toEqual([
      expect.objectContaining({ order_id: a.id, settle_seq: 2, b_settle_fen: 850n }),
    ]);
    expect(await validations(h)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ orderKey: a.key, result: 'candidate', settleSeq: 2 }),
        expect.objectContaining({
          orderKey: late.key,
          result: 'missing_settlement',
          settleSeq: null,
        }),
      ]),
    );
  },
  TIMEOUT,
);

it.each([
  { label: '一致', commission: 1000n, tolerance: 0n, expected: 'candidate' },
  { label: '换算后向下取整仍一致', commission: 1001n, tolerance: 0n, expected: 'candidate' },
  { label: '正差恰等容差', commission: 1002n, tolerance: 1n, expected: 'candidate' },
  { label: '负差恰等容差', commission: 998n, tolerance: 2n, expected: 'candidate' },
  { label: '正差超过容差一分', commission: 1002n, tolerance: 0n, expected: 'amount_mismatch' },
  { label: '负差超过容差一分', commission: 998n, tolerance: 1n, expected: 'amount_mismatch' },
] as const)(
  '[AC-B2-04n#9] 金额一致性：$label',
  async ({ commission, tolerance, expected }) => {
    const h = fixture(database.db);
    await snapshot(h);
    const o = await order(h);
    await settlement(h, o, { settle_commission_fen: commission });
    h.values.set('settle.batch.match_tolerance_fen', tolerance.toString());
    await h.run();
    expect(await validations(h)).toEqual([expect.objectContaining({ result: expected })]);
    const s = await state(h);
    expect(s.items).toHaveLength(expected === 'candidate' ? 1 : 0);
    expect(s.diffs).toHaveLength(expected === 'candidate' ? 0 : 1);
    if (expected === 'amount_mismatch') {
      expect(s.diffs[0]).toMatchObject({
        type: 'settle_amount_mismatch',
        ref_id: o.key,
        expected_fen: 850n,
      });
      expect(h.registerDiff).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ appId: h.appId, type: 'settle_amount_mismatch', refId: o.key }),
        expect.objectContaining({ clock: h.clock }),
      );
    }
  },
  TIMEOUT,
);

it(
  '[AC-B2-04n#10] 使用最大分佣版本，结算零佣金是有数据而非应结未结',
  async () => {
    const h = fixture(database.db);
    await snapshot(h);
    const latest = await order(h);
    await currentVersion(h, latest);
    await settlement(h, latest, { settle_commission_fen: 2000n });
    const zero = await order(h);
    await settlement(h, zero, { settle_commission_fen: 0n });
    await h.run();
    expect(h.readSnapshot).toHaveBeenCalledWith(expect.anything(), {
      appId: h.appId,
      orderId: latest.id,
      commissionVersion: 2,
    });
    const s = await state(h);
    expect(s.items).toEqual([
      expect.objectContaining({ order_id: latest.id, b_settle_fen: 1700n }),
    ]);
    expect(s.diffs).toEqual([
      expect.objectContaining({ ref_id: zero.key, type: 'settle_amount_mismatch', actual_fen: 0n }),
    ]);
  },
  TIMEOUT,
);

it.each([
  { hold: true, rightsPending: false },
  { hold: false, rightsPending: true },
  { hold: true, rightsPending: true },
])(
  '[AC-B2-04n#11] 暂缓优先于金额不符与应结未结：$hold/$rightsPending',
  async (patch) => {
    const h = fixture(database.db);
    await snapshot(h);
    const bad = await order(h, patch);
    const missing = await order(h, patch);
    await settlement(h, bad, { settle_commission_fen: 9000n });
    await h.run();
    expect(await validations(h)).toEqual(
      expect.arrayContaining(
        [bad, missing].map((o) => expect.objectContaining({ orderKey: o.key, result: 'deferred' })),
      ),
    );
    expect(await state(h)).toMatchObject({
      batches: [],
      items: [],
      diffs: [],
      bills: [expect.objectContaining({ held_count: 2, error_count: 0 })],
    });
    expect(h.registerDiff).not.toHaveBeenCalled();
  },
  TIMEOUT,
);

it(
  '[AC-B2-04n#12] 以联盟为准只豁免金额差异，不能越过 hold 或缺结算数据',
  async () => {
    const h = fixture(database.db);
    await snapshot(h);
    const accepted = await order(h, { unionAuthoritative: true });
    const held = await order(h, { unionAuthoritative: true, hold: true });
    const missing = await order(h, { unionAuthoritative: true });
    for (const o of [accepted, held]) await settlement(h, o, { settle_commission_fen: 2000n });
    await h.run();
    expect((await state(h)).items).toEqual([
      expect.objectContaining({ order_id: accepted.id, b_settle_fen: 1700n }),
    ]);
    expect(await validations(h)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ orderKey: accepted.key, result: 'candidate' }),
        expect.objectContaining({ orderKey: held.key, result: 'deferred' }),
        expect.objectContaining({ orderKey: missing.key, result: 'missing_settlement' }),
      ]),
    );
  },
  TIMEOUT,
);

it.each(['ESTIMATED', 'VOID', 'CLAWED_BACK', 'CREDITED'] as const)(
  '[AC-B2-04n#13] 联盟已有数据而我方 %s：不进入普通入账批次',
  async (rebateStatus) => {
    const h = fixture(database.db);
    await snapshot(h);
    const o = await order(h, { rebateStatus });
    await settlement(h, o);
    await h.run();
    const expected: BillValidationResult =
      rebateStatus === 'CREDITED' ? 'already_credited' : 'unexpected_settlement';
    expect(await validations(h)).toEqual([
      expect.objectContaining({ orderKey: o.key, result: expected }),
    ]);
    const s = await state(h);
    expect(s.items).toEqual([]);
    expect(s.diffs).toHaveLength(rebateStatus === 'CREDITED' ? 0 : 1);
    if (rebateStatus !== 'CREDITED') {
      // BR-FUND-04 ④ 沿用 BR-FUND-09 的「结算有、我方状态异常」联盟差错；
      // contracts/enums/fund.yaml 对应 union_mismatch。引用本单键，账期为七月账单日的上月六月。
      expect(s.diffs).toEqual([
        expect.objectContaining({
          type: 'union_mismatch',
          ref_id: o.key,
          period: '2032-06',
        }),
      ]);
    }
    expect(s.vouchers).toEqual([]);
    expect(s.balances).toEqual([]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04n#14] 上传备用的归一化数据同样校验；无我方订单登记差错，不伪造批次明细',
  async () => {
    const h = fixture(database.db);
    await snapshot(h);
    const o = await order(h);
    await settlement(h, o, { source: 'STATEMENT' });
    h.orphans.push({
      orderKey: 'taobao:synthetic-orphan',
      order: null,
      settlements: [
        {
          seq: 1,
          source: 'STATEMENT',
          createdAt: new Date(BEFORE),
          settledAt: new Date(BEFORE),
          commissionFen: 1000n,
        },
      ],
    });
    await h.run();
    const s = await state(h);
    expect(s.items).toEqual([expect.objectContaining({ order_id: o.id })]);
    expect(s.diffs).toEqual([
      expect.objectContaining({ ref_id: 'taobao:synthetic-orphan', type: 'union_mismatch' }),
    ]);
    expect(await validations(h)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ orderId: null, result: 'unexpected_settlement' }),
      ]),
    );
  },
  TIMEOUT,
);
