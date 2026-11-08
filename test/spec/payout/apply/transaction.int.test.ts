import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { assertContract } from '../rules/http-kit.ts';
import {
  NOW,
  TIMEOUT,
  close,
  fixture,
  invariant,
  open,
  rows,
  state,
  success,
  type Harness,
} from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, 120_000);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

it.each(['alipay', 'bank_card'] as const)(
  '[AC-B2-05d#1] %s 建单与全额 FREEZE 同事务，返回快照脱敏且契约有效',
  async (method) => {
    const f = await fixture(h, { method });
    const useCase = f.service();
    const before = await state(f);
    const data = await h.db.transaction().execute(async (trx) => {
      const result = success(
        await useCase.apply(trx, { ...f.actor, amountFen: 1000n, stepUpValid: true }),
      );
      const inside = await state(f, trx);
      expect(inside.withdrawals).toHaveLength(1);
      expect(inside.vouchers).toHaveLength(1);
      expect(inside.entries).toHaveLength(2);
      expect(inside.events).toHaveLength(2);
      expect(await state(f, h.observer)).toEqual(before);
      return result;
    });
    const s = await state(f);
    expect(s.withdrawals[0]).toMatchObject({
      id: data.withdrawal_id,
      app_id: f.actor.appId,
      user_id: f.actor.userId,
      status: 'PENDING_REVIEW',
      amount_fen: 1000n,
      fee_fen: 0n,
      tax_fen: 0n,
      net_fen: 1000n,
      fee_rule_id: null,
      tax_rule_version: null,
      income_type: 'SERVICE_FEE',
      payout_method: method,
      payee_name: '合成姓名',
      payee_hmac: f.hmac,
      payee_account_cipher: f.cipher,
      created_at: new Date(NOW),
      updated_at: new Date(NOW),
      review_mode: 'manual',
      review_deadline: new Date('2026-10-20T02:00:00.000Z'),
    });
    expect(s.balances[0]).toMatchObject({ available_fen: 9000n, frozen_fen: 1000n });
    expect(s.vouchers[0]).toMatchObject({
      uniq_key: `wd:${data.withdrawal_id}:FREEZE`,
      biz_type: 'withdrawal',
      biz_id: data.withdrawal_id,
      operator: `user:${f.actor.userId}`,
    });
    expect(s.entries).toEqual([
      expect.objectContaining({
        voucher_id: s.vouchers[0]!.id,
        account_id: s.balances[0]!.account_id,
        sub_account: 'available',
        amount_fen: 1000n,
        ledger_type: 'WITHDRAW_FREEZE',
      }),
      expect.objectContaining({
        voucher_id: s.vouchers[0]!.id,
        account_id: s.balances[0]!.account_id,
        sub_account: 'frozen',
        amount_fen: -1000n,
        ledger_type: 'WITHDRAW_FREEZE',
      }),
    ]);
    expect(data).toEqual({
      withdrawal_id: s.withdrawals[0]!.id,
      status: 'PENDING_REVIEW',
      review_mode: 'manual',
      amount_fen: 1000,
      fee_fen: 0,
      tax_fen: 0,
      net_fen: 1000,
      payout_channel: method,
      payout_channel_name: method === 'alipay' ? '支付宝' : '银行卡',
      masked_account: method === 'alipay' ? 'zh***@example.test' : '尾号 0123',
      reason_code: null,
      fail_action: null,
      channel_order_id: null,
      created_at: '2026-10-19T10:00:00.000+08:00',
      review_deadline: '2026-10-20T10:00:00.000+08:00',
      executed_at: null,
      first_attempt_at: null,
      paid_at: null,
      channel_state: null,
      confirm_deadline: null,
      sub_text_branch: 'processing',
      hold_days: null,
    });
    await assertContract(
      { statusCode: 200, json: <T>() => ({ code: 0, msg: '', data, trace_id: randomUUID() }) as T },
      'WithdrawalResponse',
    );
    expect(s.withdrawals[0]!.out_biz_no).toMatch(/^W[A-Z0-9]{20}$/);
    expect(s.withdrawals[0]!.out_biz_no.toLowerCase()).not.toContain(
      f.actor.userId.replaceAll('-', '').slice(0, 8),
    );
    await invariant(f);
  },
  TIMEOUT,
);

it('[AC-B2-05d#2] fee/tax 固化与规则版本、净额一致；冻结仍为申请总额', async () => {
  const f = await fixture(h);
  const feeRuleId = randomUUID();
  // Calculator port supplies a synthetic future rule; this tests snapshotting, not fee policy.
  f.options.rules.feeTax = {
    calculate: async () => ({
      fee_fen: 23n,
      tax_fen: 71n,
      net_fen: 1000n,
      fee_rule_id: feeRuleId,
      tax_rule_version: 'synthetic-v2',
    }),
  };
  const data = success(await h.db.transaction().execute((trx) => f.apply(trx)));
  expect(data).toMatchObject({ amount_fen: 1000, fee_fen: 23, tax_fen: 71, net_fen: 906 });
  expect((await rows(f))[0]).toMatchObject({
    amount_fen: 1000n,
    fee_fen: 23n,
    tax_fen: 71n,
    net_fen: 906n,
    fee_rule_id: feeRuleId,
    tax_rule_version: 'synthetic-v2',
  });
  expect((await state(f)).balances[0]).toMatchObject({ available_fen: 9000n, frozen_fen: 1000n });
  f.options.rules.feeTax = {
    calculate: async () => ({ fee_fen: 0n, tax_fen: 0n, net_fen: 1000n }),
  };
  expect((await rows(f))[0]).toMatchObject({ fee_fen: 23n, tax_fen: 71n, net_fen: 906n });
  await invariant(f);
});

it('[AC-B2-05d#3] caller 回滚撤销提现单、凭证、余额及两条事件', async () => {
  const f = await fixture(h);
  const useCase = f.service();
  const before = await state(f);
  const abort = new Error('synthetic caller rollback');
  await expect(
    h.db.transaction().execute(async (trx) => {
      success(await useCase.apply(trx, { ...f.actor, amountFen: 1000n, stepUpValid: true }));
      expect((await rows(f, trx)).length).toBe(1);
      throw abort;
    }),
  ).rejects.toBe(abort);
  expect(await state(f)).toEqual(before);
  expect((await f.request()).status).toBe(200);
  await invariant(f);
});

it.each(['ledger', 'second-event'] as const)(
  '[AC-B2-05d#4] %s 故障不能留下半笔建单，也不能保存幂等成功结果',
  async (fault) => {
    const f = await fixture(h);
    const failure = new Error('synthetic write failure');
    const realBus = f.options.eventBus!;
    let calls = 0;
    if (fault === 'ledger')
      f.options.ledger = {
        ...f.ledger,
        post: async () => {
          throw failure;
        },
      };
    else
      f.options.eventBus = {
        publish: async (trx, event) => {
          calls += 1;
          if (calls === 2) throw failure;
          return realBus.publish(trx, event);
        },
      };
    f.service(); // Red must be NotImplemented outside the expected rejection.
    const before = await state(f);
    await expect(f.request()).rejects.toBe(failure);
    expect(await state(f)).toEqual(before);
  },
);

it.each([
  ['2026-10-19T02:00:00.000Z', '2026-10-20T02:00:00.000Z'],
  ['2026-10-23T12:00:00.000Z', '2026-10-26T12:00:00.000Z'],
  ['2026-10-24T07:00:00.000Z', '2026-10-26T16:00:00.000Z'],
] as const)(
  '[AC-B2-05d#5] 关闭自动到账，申请时间 %s 的人工审核期限为 %s',
  async (now, deadline) => {
    const f = await fixture(h);
    f.clock.set(now);
    await f.set('withdraw.auto_payout.enabled', false);
    success(await h.db.transaction().execute((trx) => f.apply(trx)));
    expect((await rows(f))[0]).toMatchObject({
      created_at: new Date(now),
      review_mode: 'manual',
      review_deadline: new Date(deadline),
    });
  },
);

it('[AC-B2-05d#6] 自动到账开启时 review_mode 与 review_deadline 均未决', async () => {
  const f = await fixture(h);
  await f.set('withdraw.auto_payout.enabled', true);
  const data = success(await h.db.transaction().execute((trx) => f.apply(trx)));
  expect(data.review_mode).toBeNull();
  expect((await rows(f))[0]).toMatchObject({ review_mode: null, review_deadline: null });
});

it('[AC-B2-05d#7] 两条同事务事件的整数金额、状态和租户准确，不含收款隐私', async () => {
  const f = await fixture(h);
  const data = success(await h.db.transaction().execute((trx) => f.apply(trx)));
  const events = (await state(f)).events;
  expect(events).toEqual([
    expect.objectContaining({
      app_id: f.actor.appId,
      name: 'wallet.withdrawal_changed',
      occurred_at: new Date(NOW),
      payload: {
        v: 1,
        data: {
          withdrawal_id: data.withdrawal_id,
          user_id: f.actor.userId,
          status: 'PENDING_REVIEW',
        },
      },
    }),
    expect.objectContaining({
      app_id: f.actor.appId,
      name: 'withdrawal.created',
      occurred_at: new Date(NOW),
      payload: {
        v: 1,
        data: {
          withdrawal_id: data.withdrawal_id,
          user_id: f.actor.userId,
          amount_fen: 1000,
          review_mode: 'manual',
        },
      },
    }),
  ]);
  for (const secret of [f.account, f.hmac, '合成姓名', f.cipher.toString()]) {
    expect(
      JSON.stringify(events, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)),
    ).not.toContain(secret);
  }
});

it('[AC-B2-05d#8] 未注入总线仍可建单并冻结', async () => {
  const f = await fixture(h);
  delete f.options.eventBus;
  success(await h.db.transaction().execute((trx) => f.apply(trx)));
  const s = await state(f);
  expect(s.events).toEqual([]);
  expect(s.withdrawals).toHaveLength(1);
  expect(s.vouchers).toHaveLength(1);
  await invariant(f);
});
