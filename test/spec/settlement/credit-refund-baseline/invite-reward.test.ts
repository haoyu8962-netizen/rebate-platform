// B1-08zi（D10-814 ⑥，BR-INV-24 细则 判定顺序 3 ⑥）：邀请奖励「触发订单已扣回 / 入账后退款」与 R9 用同一比较
// (refunded_quantity ?? 0) > (refunded_quantity_at_credit ?? 0)。京东挂开关 orders.jd.refunded_quantity_r9_enabled：
// 关时不据此作废未发奖励（只看 rebate_status），开时照旧；其他平台与未带平台的订单事实照旧据此作废。
// Task-local AC labels ([AC-B1-08zi#n]) identify this task's acceptance points, not business rules.
import { propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import {
  inviteRewardOrderClawedBack,
  type InviteRewardOrder,
} from '../../../../apps/api/src/modules/growth/application/invite-reward.ts';

function order(patch: Partial<InviteRewardOrder> = {}): InviteRewardOrder {
  return {
    app_id: 'app-synthetic',
    order_id: '0192f0a0-0000-7000-8000-000000000002',
    user_id: '0192f0a0-0000-7000-8000-000000000003',
    buy_type: 'self',
    base_fen: 320n,
    pay_amount_fen: 4990n,
    attr_at: new Date('2026-10-22T02:00:00.000Z'),
    credited_at: new Date('2026-11-24T02:00:00.000Z'),
    rebate_status: 'CREDITED',
    refunded_quantity: 0,
    refunded_quantity_at_credit: 0,
    rights_pending: false,
    has_rights: false,
    ...patch,
  };
}

it('[AC-B1-08zi#28] 京东已退 2 > 定格 1：开关关 → 不作废（false），开关开 → 作废（true）', () => {
  const jd = order({ platform: 'jd', refunded_quantity: 2, refunded_quantity_at_credit: 1 });
  expect(inviteRewardOrderClawedBack(jd, false)).toBe(false);
  expect(inviteRewardOrderClawedBack(jd, true)).toBe(true);
  const nullBaseline = order({
    platform: 'jd',
    refunded_quantity: 1,
    refunded_quantity_at_credit: null,
  });
  expect(inviteRewardOrderClawedBack(nullBaseline, false)).toBe(false);
  expect(inviteRewardOrderClawedBack(nullBaseline, true)).toBe(true);
});

it('[AC-B1-08zi#29] 非京东与未带平台：已退件数增加照旧作废，与开关无关', () => {
  for (const platform of ['pdd', 'taobao', null] as const) {
    const fact = order({ platform, refunded_quantity: 1, refunded_quantity_at_credit: 0 });
    expect(inviteRewardOrderClawedBack(fact, false)).toBe(true);
    expect(inviteRewardOrderClawedBack(fact, true)).toBe(true);
  }
  const legacy = order({ refunded_quantity: 1, refunded_quantity_at_credit: 0 });
  expect(Object.hasOwn(legacy, 'platform')).toBe(false);
  expect(inviteRewardOrderClawedBack(legacy, false)).toBe(true);
});

it('[AC-B1-08zi#30] 不再是 CREDITED 一律作废；CREDITED 且未增加一律不作废（与平台、开关无关）', () => {
  for (const platform of ['jd', 'pdd'] as const) {
    for (const enabled of [false, true]) {
      for (const status of ['CLAWED_BACK', 'WAITING', 'VOID']) {
        const fact = order({ platform, rebate_status: status });
        expect(inviteRewardOrderClawedBack(fact, enabled)).toBe(true);
      }
      const kept = order({ platform, refunded_quantity: 1, refunded_quantity_at_credit: 1 });
      expect(inviteRewardOrderClawedBack(kept, enabled)).toBe(false);
    }
  }
});

it('[AC-B1-08zi#31] 任意组合与手算结果一致', () => {
  const count = fc.option(fc.integer({ min: 0, max: 9 }), { nil: null });
  const platform = fc.constantFrom('jd', 'pdd', 'taobao', null);
  const status = fc.constantFrom('CREDITED', 'CLAWED_BACK', 'WAITING');
  expect(() =>
    fc.assert(
      fc.property(
        platform,
        status,
        count,
        count,
        fc.boolean(),
        (code, rebate, refunded, atCredit, enabled) => {
          const fact = order({
            platform: code,
            rebate_status: rebate,
            refunded_quantity: refunded,
            refunded_quantity_at_credit: atCredit,
          });
          const increased = (refunded ?? 0) > (atCredit ?? 0);
          const expected = rebate !== 'CREDITED' || (increased && (code !== 'jd' || enabled));
          expect(inviteRewardOrderClawedBack(fact, enabled)).toBe(expected);
          return true;
        },
      ),
      propParams(),
    ),
  ).not.toThrow();
}, 900_000);
