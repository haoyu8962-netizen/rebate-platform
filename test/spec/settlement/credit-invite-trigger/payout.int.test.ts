// B2-04zzc (编排 D10-805 ②; 08 BR-INV-24 ②「发放在该迁移提交之后进行，是独立凭证、不随订单迁移」, ④, ⑥):
// the credit transaction only records the trigger; growth's payout scan pays (REWARD:INVITE
// vouchers, budgets) after it committed, and a trigger order clawed back before the payout voids
// the reward for good. Orders and amounts as in trigger.int.test.ts; 1000 per party, the total
// budget reserved 2000 at qualification, the day's budget 20000.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import type { EventBus } from '../../../../apps/api/src/modules/platform/index.ts';
import { NOW, databaseFixture, fixture } from '../batch-executor/kit.ts';
import {
  TIMEOUT,
  budgetsOf,
  creditInBatch,
  inviteeOrder,
  pair,
  productionTrigger,
  qualify,
  rewardOf,
  rewardSide,
  rewardVoucherKeys,
  triggerOf,
} from './kit.ts';

const p = databaseFixture(createTestDatabase);

const CREDITED_AT = new Date(NOW).toISOString();
/** The +08:00 accounting date of the payout (the credit clock). */
const PAY_DAY = '2032-07-24';

it(
  '[AC-B2-04zzc#9] 入账事务里只记触发：发布 order.credited 时同一事务里已有触发记录，但没有 REWARD 凭证、预算未动；提交后仍未发放；随后发放扫描才发放（两张 INVITE_REWARD 凭证，总预算占用 2000 转为已发放，当日已发放 2000，资格 processed）',
  async () => {
    const f = await fixture(p.db);
    const pr = await pair(f);
    await qualify(f, pr);
    const o = await inviteeOrder(f, pr);
    const reserved = await budgetsOf(f);
    expect(reserved).toStrictEqual([{ period: 'total', reserved_fen: 2000n, granted_fen: 0n }]);
    const inCredit: unknown[] = [];
    const publish: EventBus['publish'] = async (trx, event) => {
      if (event.name === 'order.credited') {
        const app = trx.withSchema('app');
        const vouchers = await app
          .selectFrom('ledger_vouchers')
          .select('uniq_key')
          .where('app_id', '=', f.appId)
          .where('uniq_key', 'like', 'INVITE_REWARD:%')
          .execute();
        const budgets = await app
          .selectFrom('invite_reward_budgets')
          .select(['period', 'reserved_fen', 'granted_fen'])
          .where('app_id', '=', f.appId)
          .orderBy('period')
          .execute();
        const reward = await app
          .selectFrom('invite_rewards')
          .select(['status', 'trigger_order_id'])
          .where('app_id', '=', f.appId)
          .where('invitee_id', '=', pr.invitee)
          .executeTakeFirstOrThrow();
        inCredit.push({ vouchers: vouchers.map((v) => v.uniq_key), budgets, reward });
      }
      return f.h.publish(trx, event);
    };

    await creditInBatch(f, [o], { trigger: await productionTrigger(), publish });

    expect(inCredit).toStrictEqual([
      {
        vouchers: [],
        budgets: reserved,
        reward: { status: 'qualified', trigger_order_id: o.orderId },
      },
    ]);
    expect(await rewardVoucherKeys(f)).toStrictEqual([]);
    expect(await budgetsOf(f)).toStrictEqual(reserved);
    expect(await triggerOf(f, pr.invitee)).toStrictEqual({
      status: 'qualified',
      trigger_order_id: o.orderId,
      triggered_at: CREDITED_AT,
    });

    await rewardSide(f).scanner.tick();

    expect(await rewardOf(f, pr.invitee)).toMatchObject({
      status: 'processed',
      trigger_order_id: o.orderId,
      inviter_result: 'granted',
      invitee_result: 'granted',
    });
    expect(await rewardVoucherKeys(f)).toStrictEqual(
      [`INVITE_REWARD:${pr.invitee}:invitee`, `INVITE_REWARD:${pr.invitee}:inviter`].sort(),
    );
    expect(await budgetsOf(f)).toStrictEqual([
      { period: PAY_DAY, reserved_fen: 0n, granted_fen: 2000n },
      { period: 'total', reserved_fen: 0n, granted_fen: 2000n },
    ]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zzc#10] 触发后、发放前触发订单被扣回：发放扫描判作废（voided，order_clawed_back），两方都不发、释放总预算占用 2000；之后该被邀请人再入账的自购单不触发（触发仍是原单，状态仍 voided，无 REWARD 凭证）',
  async () => {
    const f = await fixture(p.db);
    const pr = await pair(f);
    await qualify(f, pr);
    const first = await inviteeOrder(f, pr);
    const second = await inviteeOrder(f, pr);
    const trigger = await productionTrigger();

    await creditInBatch(f, [first], { trigger });
    expect(await triggerOf(f, pr.invitee)).toStrictEqual({
      status: 'qualified',
      trigger_order_id: first.orderId,
      triggered_at: CREDITED_AT,
    });

    // The trigger order is clawed back before the payout (BR-FUND-01: CREDITED → CLAWED_BACK).
    await f.db
      .withSchema('app')
      .updateTable('orders')
      .set({ rebate_status: 'CLAWED_BACK' })
      .where('app_id', '=', f.appId)
      .where('order_id', '=', first.orderId)
      .execute();
    await rewardSide(f).scanner.tick();

    expect(await rewardOf(f, pr.invitee)).toMatchObject({
      status: 'voided',
      void_reason: 'order_clawed_back',
      trigger_order_id: first.orderId,
      inviter_result: null,
      invitee_result: null,
    });
    expect(await budgetsOf(f)).toStrictEqual([
      { period: 'total', reserved_fen: 0n, granted_fen: 0n },
    ]);

    await creditInBatch(f, [second], { trigger });

    expect(await f.rebateOf(second)).toBe('CREDITED');
    expect(await triggerOf(f, pr.invitee)).toStrictEqual({
      status: 'voided',
      trigger_order_id: first.orderId,
      triggered_at: CREDITED_AT,
    });
    expect(await rewardVoucherKeys(f)).toStrictEqual([]);
  },
  TIMEOUT,
);
