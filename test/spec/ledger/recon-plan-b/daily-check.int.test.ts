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
  DAY,
  TIMEOUT,
  balanceCacheDiff,
  diffByRef,
  diffsOf,
  entry,
  invalidCreditedAccountDiff,
  orderKey,
  platformAccount,
  userAccount,
  voucher,
  voucherDiff,
  withHarness,
} from '../daily-check-execute/kit.ts';
import { listOf, schemaReady } from './kit.ts';

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
