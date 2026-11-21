import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import type { BillSourceRow } from '../../../../apps/api/src/modules/settlement/bill/job.ts';
import { expect, it } from 'vitest';
import { appendVersion, event } from '../../commission/snapshot-read/fixtures.ts';
import {
  databaseFixture,
  fixture,
  order,
  settlement,
  snapshot,
  state,
  validations,
  obligation,
  BEFORE,
  MONTH,
  TIMEOUT,
} from './kit.ts';

const database = databaseFixture(createTestDatabase);

it.each(['off', 'on'] as const)(
  '[AC-B2-04n#31] 同一 app 淘宝开启、京东 %s：普通候选与 open 义务只进所属平台批次',
  async (jdEnabled) => {
    const h = fixture(database.db);
    await snapshot(h);
    h.values.set('credit.enabled.jd', jdEnabled);
    const taobaoOrder = await order(h);
    const jdOrder = await order(h, {}, 'jd');
    const taobaoCredited = await order(h, { rebateStatus: 'CREDITED' });
    const jdCredited = await order(h, { rebateStatus: 'CREDITED' }, 'jd');
    for (const o of [taobaoOrder, jdOrder, taobaoCredited, jdCredited]) await settlement(h, o);
    const taobaoCredit = await obligation(h, taobaoCredited);
    const jdCredit = await obligation(h, jdCredited);
    const before = await state(h);

    await h.run('taobao');
    const taobaoState = await state(h);
    expect(taobaoState.batches).toEqual([
      expect.objectContaining({ platform: 'taobao', status: 'DRAFT' }),
    ]);
    expect(taobaoState.items).toHaveLength(2);
    expect(taobaoState.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ item_type: 'order', order_id: taobaoOrder.id }),
        expect.objectContaining({
          item_type: 'beneficiary',
          order_id: taobaoCredited.id,
          beneficiary_credit_id: taobaoCredit.beneficiary_credit_id,
        }),
      ]),
    );

    await h.run('jd');
    const s = await state(h);
    expect(s.batches.map((b) => b.platform).sort()).toEqual(
      jdEnabled === 'on' ? ['jd', 'taobao'] : ['taobao'],
    );
    expect(s.items).toHaveLength(jdEnabled === 'on' ? 4 : 2);
    for (const batch of s.batches) {
      const ordinary = batch.platform === 'jd' ? jdOrder : taobaoOrder;
      const credited = batch.platform === 'jd' ? jdCredited : taobaoCredited;
      const credit = batch.platform === 'jd' ? jdCredit : taobaoCredit;
      const items = s.items.filter((i) => i.batch_id === batch.batch_id);
      expect(items).toHaveLength(2);
      expect(items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ item_type: 'order', order_id: ordinary.id }),
          expect.objectContaining({
            item_type: 'beneficiary',
            order_id: credited.id,
            beneficiary_credit_id: credit.beneficiary_credit_id,
            user_id: credit.user_id,
            role: credit.role,
            amount_fen: null,
          }),
        ]),
      );
    }
    expect(await validations(h)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ orderKey: jdOrder.key, result: 'candidate' }),
        expect.objectContaining({ orderKey: jdCredited.key, result: 'already_credited' }),
      ]),
    );
    expect(s.obligations).toEqual(before.obligations);
    expect(s.vouchers).toEqual([]);
    expect(s.balances).toEqual([]);
    expect((await h.run('taobao')).outcome).toBe('duplicate');
    expect((await h.run('jd')).outcome).toBe('duplicate');
    expect(await state(h)).toEqual(s);
  },
  TIMEOUT,
);

it.each([
  {
    label: '无淘礼金扣减',
    pricing: { tlj: 0n, base: 850n, amounts: [425n, 85n, 42n], userTotal: 552n, retain: 298n },
    forfeitedAmounts: [425n, 0n, 42n],
    forfeitedUserTotal: 467n,
    beneficiaryTotal: 1104n,
    retainedTotal: 596n,
  },
  {
    label: '有淘礼金扣减',
    pricing: { tlj: 100n, base: 750n, amounts: [375n, 75n, 37n], userTotal: 487n, retain: 263n },
    forfeitedAmounts: [375n, 0n, 37n],
    forfeitedUserTotal: 412n,
    beneficiaryTotal: 974n,
    retainedTotal: 526n,
  },
])(
  '[AC-B2-04n#32] $label：账单受益人合计含被剥夺份额，平台留存不含该份额',
  async ({ pricing, forfeitedAmounts, forfeitedUserTotal, beneficiaryTotal, retainedTotal }) => {
    const h = fixture(database.db);
    await snapshot(h);
    h.readTljDeductFen.mockResolvedValue(pricing.tlj);
    const normal = await order(h, {}, 'taobao', pricing);
    const forfeited = await order(h, {}, 'taobao', pricing);
    await event(h.db, forfeited, forfeited.people[1]!, 'forfeited', 'banned', new Date(BEFORE));
    await appendVersion(
      h.db,
      forfeited,
      2,
      pricing.base,
      1000n,
      forfeitedAmounts,
      forfeitedUserTotal,
      new Date(BEFORE),
    );
    forfeited.fact.order.commissionVersion = 2;
    await settlement(h, normal);
    await settlement(h, forfeited);
    await h.run();
    const s = await state(h);
    // BR-FUND-04 ⑤、BR-FUND-05：受益人份额合计含被剥夺与暂缓份额，平台留存 = 基数 − 全部份额。
    // 基数 850 时，受益人 (425 + 85 + 42) × 2 = 1104，平台 (850 − 552) × 2 = 596；
    // 扣减后基数 750 时，受益人 (375 + 75 + 37) × 2 = 974，平台 (750 − 487) × 2 = 526。
    // 被剥夺份额入账时另写平台 FORFEIT 凭证，不并入账单平台留存；联盟佣金合计仍为 2000。
    expect(s.bills).toEqual([
      expect.objectContaining({
        platform_order_counts: { taobao: 2 },
        platform_settle_commission_totals: { taobao: '2000' },
        beneficiary_total_fen: beneficiaryTotal,
        platform_retained_fen: retainedTotal,
        error_count: 0,
        held_count: 0,
      }),
    ]);
    expect(s.items).toHaveLength(2);
    expect(s.items).toEqual(
      expect.arrayContaining(
        [normal, forfeited].map((o) =>
          expect.objectContaining({
            order_id: o.id,
            item_type: 'order',
            b_settle_fen: pricing.base,
          }),
        ),
      ),
    );
    expect(s.diffs).toEqual([]);
    expect((await h.run()).outcome).toBe('duplicate');
    expect(await state(h)).toEqual(s);
  },
  TIMEOUT,
);

it('[AC-B2-04n#27] 未配置 max_orders 时 5001 个候选拆为 5000 与 1 两批', async () => {
  const h = fixture(database.db);
  await snapshot(h);
  // 大批量用合成的公开读口事实，实际 order_keys/账单/批次/明细仍在 PG。
  const keys = Array.from({ length: 5001 }, (_, i) => ({
    app_id: h.appId,
    order_id: randomUUID(),
    platform: 'taobao',
    sub_order_id: `bulk-${String(i).padStart(5, '0')}`,
    attr_at: h.clock.now(),
  }));
  for (let start = 0; start < keys.length; start += 500) {
    await h.db
      .insertInto('order_keys')
      .values(keys.slice(start, start + 500))
      .execute();
  }
  const rows: BillSourceRow[] = keys.map((k) => ({
    orderKey: `taobao:${k.sub_order_id}`,
    order: {
      orderId: k.order_id,
      rebateStatus: 'WAITING',
      settlePeriod: MONTH,
      hold: false,
      rightsPending: false,
      commissionVersion: 1,
      unionAuthoritative: false,
    },
    settlements: [
      {
        seq: 1,
        source: 'API',
        createdAt: h.clock.now(),
        settledAt: h.clock.now(),
        commissionFen: 1000n,
      },
    ],
  }));
  h.readSource.mockResolvedValue(rows.reverse());
  h.readSnapshot.mockResolvedValue({
    baseFen: 1000n,
    reserveBp: 0,
    beneficiaries: [
      {
        userId: randomUUID(),
        role: 'self',
        ratioBp: 5000,
        initialStatus: 'active',
      },
    ],
    forfeitedEvents: [],
  });
  await h.run();
  const s = await state(h);
  expect(s.batches.map((b) => b.order_count).sort((a, b) => a - b)).toEqual([1, 5000]);
  expect(s.items).toHaveLength(5001);
  const last = s.batches.find((b) => b.order_count === 1)!;
  expect(s.items.filter((i) => i.batch_id === last.batch_id).map((i) => i.order_id)).toEqual([
    keys[5000]!.order_id,
  ]);
}, 120_000);

it(
  '[AC-B2-04n#28] 下一账单再次纳入未完成义务，仍引用原 beneficiary_credit_id',
  async () => {
    const h = fixture(database.db);
    await snapshot(h);
    const o = await order(h, { rebateStatus: 'CREDITED' });
    await settlement(h, o);
    const credit = await obligation(h, o);
    await h.run();
    h.clock.set('2032-08-24T00:30:00+08:00');
    expect((await h.run('taobao', new Date('2032-08-24T00:01:00+08:00'))).outcome).toBe(
      'generated',
    );
    const s = await state(h);
    expect(s.jobs).toHaveLength(2);
    expect(s.bills.map((b) => b.bill_id)).toEqual(['2032-06', '2032-07']);
    expect(s.items).toHaveLength(2);
    expect(
      s.items.every(
        (i) => i.beneficiary_credit_id === credit.beneficiary_credit_id && i.amount_fen === null,
      ),
    ).toBe(true);
    expect(new Set(s.items.map((i) => i.batch_id)).size).toBe(2);
    expect(s.obligations).toEqual([credit]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04n#15] 候选按 order_key 升序拆批，批次均为未确认 DRAFT，生成不入账',
  async () => {
    const h = fixture(database.db);
    await snapshot(h);
    h.values.set('settle.batch.max_orders', 2);
    const orders = [];
    for (let i = 0; i < 5; i += 1) {
      const o = await order(h);
      await settlement(h, o);
      orders.push(o);
    }
    h.facts.sort((a, b) => (a.orderKey < b.orderKey ? 1 : -1));
    const before = await state(h);
    expect(await h.run()).toMatchObject({ outcome: 'generated', status: '已出账' });
    const s = await state(h);
    expect(s.batches).toHaveLength(3);
    expect(s.items).toHaveLength(5);
    const sorted = [...orders].sort((a, b) => (a.key < b.key ? -1 : 1)).map((o) => o.id);
    const groups = s.batches
      .map((b) =>
        s.items
          .filter((i) => i.batch_id === b.batch_id)
          .map((i) => i.order_id)
          .sort()
          .join(','),
      )
      .sort();
    expect(groups).toEqual(
      [sorted.slice(0, 2), sorted.slice(2, 4), sorted.slice(4)]
        .map((g) => g.sort().join(','))
        .sort(),
    );
    for (const batch of s.batches) {
      expect(batch).toMatchObject({
        app_id: h.appId,
        bill_id: MONTH,
        platform: 'taobao',
        kind: 'main',
        status: 'DRAFT',
        confirmed_at: null,
        confirmed_by: null,
        started_at: null,
        finished_at: null,
        settle_run_id: null,
      });
      expect(batch.order_count).toBe(s.items.filter((i) => i.batch_id === batch.batch_id).length);
    }
    for (const item of s.items)
      expect(item).toMatchObject({
        item_type: 'order',
        settle_seq: 1,
        b_settle_fen: 850n,
        amount_fen: null,
        result: null,
        user_id: null,
        role: null,
        beneficiary_credit_id: null,
      });
    expect(s.vouchers).toEqual(before.vouchers);
    expect(s.balances).toEqual(before.balances);
    expect(h.facts.every((f) => f.order.rebateStatus === 'WAITING')).toBe(true);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04n#16] 账单六项合计落库，受益份额逐角色取整，重跑不重复累计',
  async () => {
    const h = fixture(database.db);
    await snapshot(h);
    await settlement(h, await order(h));
    await settlement(h, await order(h));
    await h.run();
    const s = await state(h);
    expect(s.bills).toEqual([
      expect.objectContaining({
        bill_id: MONTH,
        platform_order_counts: { taobao: 2 },
        platform_settle_commission_totals: { taobao: '2000' },
        beneficiary_total_fen: 1104n,
        platform_retained_fen: 596n,
        error_count: 0,
        held_count: 0,
      }),
    ]);
    expect((await h.run()).outcome).toBe('duplicate');
    expect(await state(h)).toEqual(s);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04n#17] 不同平台独立任务，共用同月账单；合计保留已完成平台，不覆盖或串批',
  async () => {
    const h = fixture(database.db);
    await snapshot(h);
    const a = await order(h);
    const b = await order(h, {}, 'jd');
    await settlement(h, a);
    await settlement(h, b);
    await Promise.all([h.run('taobao'), h.run('jd')]);
    const s = await state(h);
    expect(s.bills).toEqual([
      expect.objectContaining({
        platform_order_counts: { taobao: 1, jd: 1 },
        platform_settle_commission_totals: { taobao: '1000', jd: '1000' },
        beneficiary_total_fen: 1104n,
        platform_retained_fen: 596n,
      }),
    ]);
    expect(s.jobs.map((j) => j.platform).sort()).toEqual(['jd', 'taobao']);
    expect(s.batches).toHaveLength(2);
    for (const batch of s.batches) {
      expect(s.items.filter((i) => i.batch_id === batch.batch_id).map((i) => i.order_id)).toEqual([
        batch.platform === 'jd' ? b.id : a.id,
      ]);
    }
  },
  TIMEOUT,
);

it.each(['off', undefined])(
  '[AC-B2-04n#18] credit.enabled=%s 不生成任何批次，仍保存逐单校验、差错与暂缓',
  async (enabled) => {
    const h = fixture(database.db);
    await snapshot(h);
    h.values.set('credit.enabled.taobao', enabled);
    const good = await order(h);
    await settlement(h, good);
    const bad = await order(h);
    await settlement(h, bad, { settle_commission_fen: 9000n });
    const held = await order(h, { hold: true });
    await order(h);
    const credited = await order(h, { rebateStatus: 'CREDITED' });
    await settlement(h, credited);
    const open = await obligation(h, credited);
    expect(await h.run()).toMatchObject({ outcome: 'generated', status: '已出账' });
    const s = await state(h);
    expect(s.batches).toEqual([]);
    expect(s.items).toEqual([]);
    expect(s.diffs).toHaveLength(1);
    expect(s.bills[0]).toMatchObject({ error_count: 1, held_count: 1 });
    expect(await validations(h)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ orderKey: good.key, result: 'candidate' }),
        expect.objectContaining({ orderKey: bad.key, result: 'amount_mismatch' }),
        expect.objectContaining({ orderKey: held.key, result: 'deferred' }),
      ]),
    );
    expect(s.obligations).toEqual([open]);
    const before = await state(h);
    h.values.set('credit.enabled.taobao', 'on');
    expect((await h.run()).outcome).toBe('duplicate');
    expect(await state(h)).toEqual(before);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04n#19] 超过 JS 安全整数的联盟佣金合计用十进制整数串持久化，无一分钱丢失',
  async () => {
    const h = fixture(database.db);
    await snapshot(h);
    const a = await order(h, { unionAuthoritative: true });
    const b = await order(h, { unionAuthoritative: true });
    await settlement(h, a, { settle_commission_fen: 9007199254740993n });
    await settlement(h, b, { settle_commission_fen: 9007199254740994n });
    await h.run();
    expect((await state(h)).bills[0]?.platform_settle_commission_totals).toEqual({
      taobao: '18014398509481987',
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04n#20] CREDITED 的每个 open 义务生成独立补记项，不做金额匹配、不预算金额或关闭义务',
  async () => {
    const h = fixture(database.db);
    await snapshot(h);
    const o = await order(h, {
      rebateStatus: 'CREDITED',
      settlePeriod: '2031-01',
      hold: true,
      rightsPending: true,
    });
    await settlement(h, o, { seq: 7, settle_commission_fen: 9000n });
    const first = await obligation(h, o);
    const deferred = await obligation(h, o, {
      user_id: o.people[1]!.userId,
      role: 'direct',
      kind: 'deferred',
      opened_by: 'R10',
      origin_ledger_type: 'ADJ',
      origin_sub_type: 'SETTLE',
    });
    const before = await state(h);
    await h.run();
    const s = await state(h);
    expect(s.batches).toEqual([expect.objectContaining({ status: 'DRAFT', platform: 'taobao' })]);
    expect(s.items).toHaveLength(2);
    for (const credit of [first, deferred])
      expect(s.items).toContainEqual(
        expect.objectContaining({
          item_type: 'beneficiary',
          order_id: o.id,
          beneficiary_credit_id: credit.beneficiary_credit_id,
          user_id: credit.user_id,
          role: credit.role,
          settle_seq: 7,
          amount_fen: null,
          result: null,
        }),
      );
    expect(s.obligations).toEqual(before.obligations);
    expect(s.diffs).toEqual([]);
    expect(s.vouchers).toEqual([]);
    expect(s.balances).toEqual([]);
    await h.run();
    expect((await state(h)).items).toEqual(s.items);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04n#21] 非 open 义务和非 CREDITED 订单不生成补记项；另一 app 的义务隔离',
  async () => {
    const h = fixture(database.db);
    await snapshot(h);
    for (const status of ['done', 'forfeited', 'voided'] as const) {
      const o = await order(h, { rebateStatus: 'CREDITED' });
      await settlement(h, o);
      await obligation(h, o, {
        status,
        closed_by: status === 'voided' ? 'R8' : 'R5a',
        closed_ref: 'synthetic-closed',
        closed_at: h.clock.now(),
      });
    }
    const voided = await order(h, { rebateStatus: 'CLAWED_BACK' });
    await obligation(h, voided);
    const other = fixture(database.db);
    const otherOrder = await order(other, { rebateStatus: 'CREDITED' });
    await settlement(other, otherOrder);
    await obligation(other, otherOrder);
    const untouched = await state(other);
    await h.run();
    expect((await state(h)).items).toEqual([]);
    expect((await state(h)).batches).toEqual([]);
    expect(await state(other)).toEqual(untouched);
  },
  TIMEOUT,
);
