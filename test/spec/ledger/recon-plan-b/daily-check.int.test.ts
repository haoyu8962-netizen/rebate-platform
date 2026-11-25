// B2-17 the involved-members list written at registration (claude-independent): 细则「对外差错单的调账」
// (差错单涉及的受益用户……日终校验按子订单登记的差异为该子订单的全部受益人，按账户、凭证登记的为所涉用户)
// with §9.3 ⑭ of the task (台账补丁 1, D10-2417: 涉及用户名单在登记差错单时写进差错单): when the daily
// ledger check (ledger/application/daily-check-execute.ts registerGroup, its involvedUsers unchanged)
// newly registers a diff, involved_user_ids is the members that function finds (lower case, unique,
// ascending), NULL when it finds none; a rerun of the same day (nothing newly registered) leaves the
// registered rows as they were. Fixtures and ports: ../daily-check-execute/kit.ts.
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  APP,
  DAY,
  OTHER,
  TIMEOUT,
  balanceCacheDiff,
  diffByRef,
  diffsOf,
  entry,
  executedOf,
  invalidCreditedAccountDiff,
  member,
  orderKey,
  platformAccount,
  receivableDiff,
  userAccount,
  voucher,
  voucherDiff,
  withHarness,
  type Harness,
} from '../daily-check-execute/kit.ts';
import { listOf, schemaReady } from './kit.ts';

/** A CREDIT voucher of the sub-order naming the beneficiary (no entries needed here). */
function credit(h: Harness, key: string, userId: string, appId = APP) {
  return voucher(h, {
    appId,
    orderKey: key,
    beneficiaryUserId: userId,
    role: 'self',
    kind: 'CREDIT',
  });
}

it(
  '[AC-B2-17#26] 日终校验新登记差错单时写入涉及会员名单：账户级差异 = 该账户的会员；按子订单登记、两位受益人（明细里一个写成大写）= 两人小写、去重、升序；只涉及平台科目的凭证差异算不出会员 = NULL；同一天重跑不改已登记的行',
  async () => {
    await withHarness(createTestDatabase, async (h) => {
      await schemaReady(h.db);
      const account = await userAccount(h);
      const first = await userAccount(h);
      const second = await userAccount(h);
      const key = orderKey();
      const order = {
        orderKey: key,
        orderId: randomUUID(),
        beneficiaryUserIds: [second.userId.toUpperCase(), first.userId],
        unlocatedUserIds: [],
      };
      const cash = await platformAccount(h, 'CASH');
      const receivable = await platformAccount(h);
      const v = await voucher(h);
      await entry(h, v.id, receivable, -100n, false);
      await entry(h, v.id, cash, 107n, false);
      const differences = [
        balanceCacheDiff(account, { expected: 300n, cache: 500n }),
        invalidCreditedAccountDiff(order, first),
        invalidCreditedAccountDiff(order, second),
        voucherDiff(v, 7n, 2),
      ];
      await h.executor.execute(h.db, { accountingDate: DAY, differences });

      const byAccount = await diffByRef(h, `01:${account.accountId}`);
      const byOrder = await diffByRef(h, `08:${key}`);
      const byVoucher = await diffByRef(h, `02:${v.id}`);
      const lists = async () => [
        await listOf(h.db, byAccount.app_id, byAccount.id),
        await listOf(h.db, byOrder.app_id, byOrder.id),
        await listOf(h.db, byVoucher.app_id, byVoucher.id),
      ];
      const pair = [first.userId, second.userId].map((id) => id.toLowerCase()).sort();
      expect(await lists()).toEqual([[account.userId.toLowerCase()], pair, null]);

      const registered = await diffsOf(h);
      await h.executor.execute(h.db, { accountingDate: DAY, differences });
      expect(await diffsOf(h), '重跑不改已登记的行').toEqual(registered);
      expect(await lists()).toEqual([[account.userId.toLowerCase()], pair, null]);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-17#34] 名单取自 involvedUsers 的全部来源、与同次登记加冻结的会员相同：不平凭证（明细只给 voucher_id）= 它的分录记到的两位会员账户的会员（平台科目不算）；联盟应收（05，按子订单登记、明细里没有会员）= 该子订单凭证上的两位受益人（同一受益人两张凭证只算一次；别的子订单、别的应用的凭证不算）；明细里有会员的 05 = 明细会员与凭证受益人的并集；都小写、去重、升序',
  async () => {
    await withHarness(createTestDatabase, async (h) => {
      await schemaReady(h.db);
      const debited = await userAccount(h);
      const credited = await userAccount(h);
      const cash = await platformAccount(h, 'CASH');
      const unbalanced = await voucher(h);
      await entry(h, unbalanced.id, debited.accountId, -100n, true);
      await entry(h, unbalanced.id, credited.accountId, 60n, true);
      await entry(h, unbalanced.id, cash, 33n, false);

      const bare = orderKey();
      const first = await member(h);
      const second = await member(h);
      const stranger = await member(h);
      const elsewhere = await member(h, OTHER);
      for (const userId of [first, second, first]) await credit(h, bare, userId);
      await credit(h, orderKey(), stranger);
      await credit(h, bare, elsewhere, OTHER);
      const withoutUsers = receivableDiff(bare, randomUUID(), first, {
        expected: 600n,
        actual: 500n,
      });
      const receivable = {
        ...withoutUsers,
        detail: { ...(withoutUsers.detail as Record<string, unknown>), pending_items: [] },
      };

      const named = orderKey();
      const pending = await member(h);
      const onVoucher = await member(h);
      await credit(h, named, onVoucher);
      const withUser = receivableDiff(named, randomUUID(), pending, {
        expected: 900n,
        actual: 800n,
      });

      const execution = await h.executor.execute(h.db, {
        accountingDate: DAY,
        differences: [voucherDiff(unbalanced, -7n, 3), receivable, withUser],
      });
      const sorted = (ids: readonly string[]) => ids.map((id) => id.toLowerCase()).sort();
      const expected: readonly (readonly [string, string[]])[] = [
        [`02:${unbalanced.id}`, sorted([debited.userId, credited.userId])],
        [`05:${bare}`, sorted([first, second])],
        [`05:${named}`, sorted([pending, onVoucher])],
      ];
      for (const [refId, users] of expected) {
        const row = await diffByRef(h, refId);
        expect(await listOf(h.db, row.app_id, row.id), refId).toEqual(users);
        const held = executedOf(execution, row).heldUserIds;
        expect(sorted(held), `${refId} 加冻结的会员`).toEqual(users);
      }
    });
  },
  TIMEOUT,
);
