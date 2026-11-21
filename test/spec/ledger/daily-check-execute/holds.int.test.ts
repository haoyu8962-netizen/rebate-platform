// B2-02p: withdrawal holds of non pay- differences (BR-FUND-19 冻结方式, BR-WDR-05): one
// withdraw_holds row per involved user and diff, through the payout port, on the diff's own
// transaction and only when that run inserted the diff.
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  APP,
  DAY,
  NEXT_DAY,
  TIMEOUT,
  balanceCacheDiff,
  diffByRef,
  diffsOf,
  duplicateCredits,
  entry,
  executedOf,
  expectHold,
  holdInput,
  holdsOf,
  negativeDropDiff,
  normalRiskState,
  orderKey,
  payAccountDiff,
  paySuspenseDiff,
  platformAccount,
  receivableDiff,
  sourceOf,
  standingOf,
  userAccount,
  voucher,
  voucherDiff,
  withHarness,
} from './kit.ts';

it(
  '[AC-B2-02p#10] 账户级差异：为账户 owner 经端口加 1 条冻结（ledger_mismatch、recon_diff:<差错单 id>、system、无期限）',
  async () => {
    await withHarness(createTestDatabase, async (h) => {
      const account = await userAccount(h);
      const bystander = await userAccount(h);
      await normalRiskState(h, account.userId);
      const before = await standingOf(h, [account.userId]);
      const execution = await h.executor.execute(h.db, {
        accountingDate: DAY,
        differences: [balanceCacheDiff(account, { expected: 300n, cache: 500n })],
      });
      const diff = await diffByRef(h, `01:${account.accountId}`);
      expect(h.holds.calls.map((call) => call.input)).toEqual([holdInput(diff, account.userId)]);
      const holds = await holdsOf(h);
      expect(holds).toHaveLength(1);
      expectHold(holds[0], diff, account.userId, h);
      expect(holds.some((hold) => hold.user_id === bystander.userId)).toBe(false);
      expect(executedOf(execution, diff).heldUserIds).toEqual([account.userId]);
      // BR-WDR-05: the freeze is the withdraw_holds row only; users and risk_state stay as they were.
      expect(await standingOf(h, [account.userId])).toEqual(before);
      expect(before.riskStates.map((row) => row.state)).toEqual(['normal']);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-02p#11] 冻结与差错单同一事务：端口拿到的事务里已有该差错单，而事务外此刻还看不到',
  async () => {
    await withHarness(createTestDatabase, async (h) => {
      const account = await userAccount(h);
      await h.executor.execute(h.db, {
        accountingDate: DAY,
        differences: [balanceCacheDiff(account, { expected: 300n, cache: 500n })],
      });
      expect(h.holds.calls).toHaveLength(1);
      expect(h.holds.calls[0]).toMatchObject({ diffInTransaction: true, diffOutside: false });
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-02p#12] ③ 同一子订单两位受益人：只 1 张差错单（03:<子订单键>），两人各 1 条冻结，都指向该单',
  async () => {
    await withHarness(createTestDatabase, async (h) => {
      const first = await userAccount(h);
      const second = await userAccount(h);
      const receivable = await platformAccount(h);
      const key = orderKey();
      const differences = [
        await duplicateCredits(h, key, first, 'self', receivable),
        await duplicateCredits(h, key, second, 'parent', receivable),
      ];
      const involved = [first.userId, second.userId];
      for (const userId of involved) await normalRiskState(h, userId);
      const before = await standingOf(h, involved);
      const execution = await h.executor.execute(h.db, { accountingDate: DAY, differences });
      // BR-WDR-05: the freeze is the withdraw_holds rows only; users and risk_state stay unchanged.
      expect(await standingOf(h, involved)).toEqual(before);
      expect(before.riskStates.map((row) => row.state)).toEqual(['normal', 'normal']);
      const rows = await diffsOf(h);
      expect(rows.map((row) => row.ref_id)).toEqual([`03:${key}`]);
      const diff = rows[0]!;
      const holds = await holdsOf(h);
      expect(holds.map((hold) => hold.user_id).sort()).toEqual(
        [first.userId, second.userId].sort(),
      );
      for (const hold of holds) expectHold(hold, diff, hold.user_id, h);
      for (const call of h.holds.calls) {
        expect(call).toMatchObject({ diffInTransaction: true, diffOutside: false });
      }
      expect([...executedOf(execution, diff).heldUserIds].sort()).toEqual(
        [first.userId, second.userId].sort(),
      );
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-02p#13] 同一差错单对同一用户只加 1 条：同一受益人在同一子订单有两个角色',
  async () => {
    await withHarness(createTestDatabase, async (h) => {
      const account = await userAccount(h);
      const receivable = await platformAccount(h);
      const key = orderKey();
      const differences = [
        await duplicateCredits(h, key, account, 'self', receivable),
        await duplicateCredits(h, key, account, 'parent', receivable),
      ];
      await h.executor.execute(h.db, { accountingDate: DAY, differences });
      const diff = await diffByRef(h, `03:${key}`);
      const holds = await holdsOf(h);
      expect(holds).toHaveLength(1);
      expectHold(holds[0], diff, account.userId, h);
      expect(h.holds.calls).toHaveLength(1);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-02p#14] ② 凭证不平：按该凭证分录所在的用户账户解析涉及用户并各加 1 条冻结，平台账户不算',
  async () => {
    await withHarness(createTestDatabase, async (h) => {
      const payer = await userAccount(h);
      const payee = await userAccount(h);
      const bystander = await userAccount(h);
      const cash = await platformAccount(h, 'CASH');
      const v = await voucher(h);
      await entry(h, v.id, payer.accountId, 100n, true);
      await entry(h, v.id, payee.accountId, -95n, true);
      await entry(h, v.id, cash, 2n, false);
      await h.executor.execute(h.db, {
        accountingDate: DAY,
        differences: [voucherDiff(v, 7n, 3)],
      });
      const diff = await diffByRef(h, `02:${v.id}`);
      const holds = await holdsOf(h);
      const held = holds.map((hold) => hold.user_id).sort();
      expect(held).toEqual([payer.userId, payee.userId].sort());
      for (const hold of holds) expectHold(hold, diff, hold.user_id, h);
      expect(holds.some((hold) => hold.user_id === bystander.userId)).toBe(false);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-02p#15] 全局差异解析不到用户：只登记差错单并告警，不臆造冻结',
  async () => {
    await withHarness(createTestDatabase, async (h) => {
      const cash = await platformAccount(h, 'CASH');
      const receivable = await platformAccount(h);
      const v = await voucher(h);
      await entry(h, v.id, cash, 10n, false);
      await entry(h, v.id, receivable, -3n, false);
      const execution = await h.executor.execute(h.db, {
        accountingDate: DAY,
        differences: [voucherDiff(v, 7n, 2)],
      });
      const diff = await diffByRef(h, `02:${v.id}`);
      expect(await holdsOf(h)).toEqual([]);
      expect(h.holds.calls).toEqual([]);
      expect(executedOf(execution, diff)).toMatchObject({ inserted: true, heldUserIds: [] });
      // Warnings and errors only (the logger has no other level).
      const named = h.logs.filter((line) => line.fields['invariant'] === '02');
      expect(
        named.map((line) => line.fields['app_id']),
        JSON.stringify(h.logs),
      ).toContain(APP);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-02p#16] ⑤ 应收不符：冻结该子订单的受益人',
  async () => {
    await withHarness(createTestDatabase, async (h) => {
      const beneficiary = await userAccount(h);
      const bystander = await userAccount(h);
      const receivable = await platformAccount(h);
      const key = orderKey();
      const v = await voucher(h, {
        orderKey: key,
        beneficiaryUserId: beneficiary.userId,
        role: 'self',
        kind: 'CREDIT',
      });
      await entry(h, v.id, beneficiary.accountId, -600n, true);
      await entry(h, v.id, receivable, 600n, false);
      const short = { expected: 1000n, actual: 900n };
      const difference = receivableDiff(key, randomUUID(), beneficiary.userId, short);
      await h.executor.execute(h.db, { accountingDate: DAY, differences: [difference] });
      const diff = await diffByRef(h, `05:${key}`);
      const holds = await holdsOf(h);
      expect(holds).toHaveLength(1);
      expectHold(holds[0], diff, beneficiary.userId, h);
      expect(holds.some((hold) => hold.user_id === bystander.userId)).toBe(false);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-02p#17] pay- 差异（账户级与全局）只登记差错单，不调冻结端口',
  async () => {
    await withHarness(createTestDatabase, async (h) => {
      const account = await userAccount(h);
      const execution = await h.executor.execute(h.db, {
        accountingDate: DAY,
        differences: [payAccountDiff(account), paySuspenseDiff()],
      });
      expect(await diffsOf(h)).toHaveLength(2);
      expect(h.holds.calls).toEqual([]);
      expect(await holdsOf(h)).toEqual([]);
      for (const executed of execution.reconDiffs) expect(executed.heldUserIds).toEqual([]);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-02p#18] 同日重跑（差错单已存在）不再加冻结；前一张未结时次日也不再加冻结',
  async () => {
    await withHarness(createTestDatabase, async (h) => {
      const account = await userAccount(h);
      const differences = [balanceCacheDiff(account, { expected: 300n, cache: 500n })];
      await h.executor.execute(h.db, { accountingDate: DAY, differences });
      const before = await holdsOf(h);
      expect(before).toHaveLength(1);

      const again = await h.executor.execute(h.db, { accountingDate: DAY, differences });
      expect(await holdsOf(h)).toEqual(before);
      expect(h.holds.calls).toHaveLength(1);
      const diff = await diffByRef(h, `01:${account.accountId}`);
      expect(executedOf(again, diff)).toMatchObject({ inserted: false, heldUserIds: [] });

      await h.executor.execute(h.db, { accountingDate: NEXT_DAY, differences });
      expect(await holdsOf(h)).toEqual(before);
      expect(h.holds.calls).toHaveLength(1);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-02p#19] 同一用户涉及两张差错单（① 与 ⑦）：各加 1 条，source_ref 各指向自己的差错单',
  async () => {
    await withHarness(createTestDatabase, async (h) => {
      const account = await userAccount(h);
      await h.executor.execute(h.db, {
        accountingDate: DAY,
        differences: [
          balanceCacheDiff(account, { expected: 300n, cache: 500n }),
          negativeDropDiff(account),
        ],
      });
      const cache = await diffByRef(h, `01:${account.accountId}`);
      const negative = await diffByRef(h, `07:${account.accountId}`);
      const holds = await holdsOf(h);
      expect(holds.map((hold) => hold.source_ref).sort()).toEqual(
        [sourceOf(cache.id), sourceOf(negative.id)].sort(),
      );
      for (const hold of holds) expect(hold.user_id).toBe(account.userId);
    });
  },
  TIMEOUT,
);
