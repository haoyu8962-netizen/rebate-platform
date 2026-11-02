// B1-09q · BR-FUND-17 第 12 行、BR-TEXT-04：credit_overdue=true 的单，Agent 三条路的 order_status
// 卡片 expected_credit_period 都是 null；详情接口的同名字段不变（冻结 [AC-B1-09p#24]）。
// 未逾期与逾期两侧写在同一条用例里，由注入 Clock 跨过截止时刻：一律抹掉月份或一律保留都过不了。
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { EXPECTED, useDatabase, waiting } from '../../orders/figures/kit.ts';
import { DEADLINE_LAST_MS, DEADLINE_NEXT_DAY, PATHS, byOrder, card, rig } from './kit.ts';

const pg = useDatabase(createTestDatabase);
const SEPTEMBER = { date_from: '2027-09-01', date_to: '2027-09-30' };

it.each(PATHS)(
  '[AC-B1-09q#1][BR-FUND-17] $path：账单日 + 宽限当天月份保留，次日逾期卡片为 null，详情字段仍是月份',
  async ({ read }) => {
    const r = await rig(pg.db, { now: DEADLINE_LAST_MS });
    const o = await r.f.order({ patch: waiting() });
    expect(await read(r, o)).toEqual(
      card(o, { display_status: 'WAITING', expected_credit_period: EXPECTED }),
    );
    r.f.clock.set(DEADLINE_NEXT_DAY);
    expect(await read(r, o)).toEqual(
      card(o, { display_status: 'CREDITING', expected_credit_period: null }),
    );
    expect(await r.f.detail(o)).toMatchObject({
      display_status: 'CREDITING',
      expected_credit_period: EXPECTED,
      credit_overdue: true,
    });
  },
  60_000,
);

it.each(PATHS)(
  '[AC-B1-09q#2][BR-FUND-04] $path：已有 union_settled_at 时按其所在月的账单日 + 宽限判逾期',
  async ({ read }) => {
    // 2027-09 + 24 + 10 → 2027-10-04（+08:00），早于 settle_period 那个月份的截止日。
    const r = await rig(pg.db, { now: '2027-10-04T15:59:59.999Z' }, SEPTEMBER);
    const o = await r.f.order({
      patch: waiting({
        paid_at: '2027-09-10T02:00:00.000Z',
        union_settled_at: '2027-09-15T04:00:00.000Z',
      }),
    });
    expect(await read(r, o)).toEqual(
      card(o, { display_status: 'WAITING', expected_credit_period: '2027-09' }),
    );
    r.f.clock.set('2027-10-04T16:00:00.000Z');
    expect(await read(r, o)).toEqual(
      card(o, { display_status: 'CREDITING', expected_credit_period: null }),
    );
    expect(await r.f.detail(o)).toMatchObject({
      expected_credit_period: '2027-09',
      credit_overdue: true,
    });
  },
  60_000,
);

it.each(PATHS)(
  '[AC-B1-09q#3][BR-FUND-04] $path：settle.bill_day 与 settle.statement.grace_days 读配置，22 + 5 → 12-27',
  async ({ read }) => {
    const r = await rig(pg.db, {
      now: '2027-12-27T15:59:59.999Z',
      config: { 'settle.bill_day': 22, 'settle.statement.grace_days': 5 },
    });
    const o = await r.f.order({ patch: waiting() });
    expect(await read(r, o)).toEqual(
      card(o, { display_status: 'WAITING', expected_credit_period: EXPECTED }),
    );
    r.f.clock.set('2027-12-27T16:00:00.000Z');
    expect(await read(r, o)).toEqual(
      card(o, { display_status: 'CREDITING', expected_credit_period: null }),
    );
    expect(await r.f.detail(o)).toMatchObject({
      expected_credit_period: EXPECTED,
      credit_overdue: true,
    });
  },
  60_000,
);

it.each(PATHS)(
  '[AC-B1-09q#4][BR-FUND-17] $path：按 credit_overdue 判而不是 display_status，逾期的 NO_REBATE 单同样不带月份',
  async ({ read }) => {
    const r = await rig(pg.db, { now: DEADLINE_NEXT_DAY });
    const o = await r.f.order({ patch: waiting({ est_commission_fen: 0n }) });
    expect(await read(r, o)).toEqual(
      card(o, {
        display_status: 'NO_REBATE',
        est_rebate_fen: null,
        expected_credit_period: null,
      }),
    );
    expect(await r.f.detail(o)).toMatchObject({
      display_status: 'NO_REBATE',
      expected_credit_period: EXPECTED,
      credit_overdue: true,
    });
  },
  60_000,
);

it('[AC-B1-09q#5][BR-FUND-17][BR-AI-07] list_my_orders 多单各判各的：第 10、12 行与分享单都不带月份，未逾期的单留月份', async () => {
  const r = await rig(pg.db, { now: DEADLINE_NEXT_DAY, config: { 'credit.enabled.pdd': false } });
  const late = await r.f.order({ patch: waiting() });
  const open = await r.f.order({ patch: waiting({ settle_period: '2027-12' }) });
  const off = await r.f.order({ patch: waiting({ platform: 'pdd' }) });
  const shared = await r.f.order({
    patch: waiting({ buy_type: 'share' }),
    people: [{ userId: r.f.subject.user_id, role: 'share', ratioBp: 4000 }],
  });
  const crediting = { display_status: 'CREDITING', expected_credit_period: null };
  expect(byOrder(await r.list())).toEqual(
    new Map<unknown, unknown>([
      [late.orderId, card(late, crediting)],
      [open.orderId, card(open, { display_status: 'WAITING', expected_credit_period: '2028-01' })],
      [off.orderId, card(off, crediting)],
      [
        shared.orderId,
        card(shared, {
          ...crediting,
          title: null,
          is_other_product: true,
          est_rebate_fen: 340,
        }),
      ],
    ]),
  );
}, 60_000);

it('[AC-B1-09q#6][BR-FUND-17][BR-AI-07] explain_order 按主单号命中多个子单：各判各的', async () => {
  const r = await rig(pg.db, { now: DEADLINE_NEXT_DAY });
  const parent = 'parent-overdue-mixed';
  const late = await r.f.order({ patch: waiting({ parent_order_id: parent }) });
  const open = await r.f.order({
    patch: waiting({ parent_order_id: parent, settle_period: '2027-12' }),
  });
  expect(byOrder(await r.number(parent))).toEqual(
    new Map<unknown, unknown>([
      [late.orderId, card(late, { display_status: 'CREDITING', expected_credit_period: null })],
      [open.orderId, card(open, { display_status: 'WAITING', expected_credit_period: '2028-01' })],
    ]),
  );
}, 60_000);

it('[AC-B1-09q#7][BR-FUND-17][BR-TEXT-02] explain_order 按卡片读分享单：逾期不带月份，详情字段仍是月份', async () => {
  const r = await rig(pg.db, { now: DEADLINE_NEXT_DAY });
  const o = await r.f.order({
    patch: waiting({ buy_type: 'share' }),
    people: [{ userId: r.f.subject.user_id, role: 'share', ratioBp: 4000 }],
  });
  expect(await r.onCard(o)).toEqual(
    card(o, {
      title: null,
      is_other_product: true,
      display_status: 'CREDITING',
      est_rebate_fen: 340,
      expected_credit_period: null,
    }),
  );
  expect(await r.f.detail(o)).toMatchObject({
    expected_credit_period: EXPECTED,
    credit_overdue: true,
  });
}, 60_000);
