// B2-17 the involved-members list of a diff registered per sub-order (claude-independent): 细则「关联
// 差错单的执行」(差错单涉及的受益用户……日终校验按子订单登记的差异为该子订单的全部受益人，按账户、凭证登记的为
// 所涉用户) with §12.2 of the task (编排 D10-3237 (二)): when the daily ledger check registers a diff
// with ref_type order, involved_user_ids = the members involvedUsers finds ∪ every beneficiary of
// that sub-order (ledger_vouchers of the app and order_key with beneficiary_user_id set), lower case,
// unique, ascending; the members held stay those of involvedUsers. Then, at the admin entry, the
// first beneficiary's adjustment leaves the diff processing and the second one's sets it adjusted.
// Fixtures: ../daily-check-execute/kit.ts (executor with its fake ports on a fresh database) and
// ../admin-adjustments/kit.ts (the admin entry, on the same database through a suite-shaped object
// and a Redis of its own). No real data.
import { randomUUID } from 'node:crypto';
import { acquireTestRedis, createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { createLedger } from '../../../../apps/api/src/modules/ledger/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import type { Suite } from '../../payment/orders/kit.ts';
import {
  answer,
  member as adjustMember,
  withAdjustAdmin,
  type AdjustFixture,
} from '../admin-adjustments/kit.ts';
import {
  APP,
  DAY,
  OTHER,
  diffByRef,
  executedOf,
  invalidCreditedAccountDiff,
  member,
  orderKey,
  userAccount,
  voucher,
  withHarness,
  type Harness,
  type UserAccount,
} from '../daily-check-execute/kit.ts';
import { diffNow, diffRef, listOf, schemaReady, send, tick } from './kit.ts';

/** 2032-06-16 10:00 +08:00: after the run that registered the diffs of 2032-06-15. */
const ADMIN_NOW = '2032-06-16T02:00:00.000Z';

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

/** The member's USER_BALANCE account of APP. */
async function accountOf(h: Harness, userId: string): Promise<UserAccount> {
  const row = await h.db
    .selectFrom('ledger_accounts')
    .select('id')
    .where('app_id', '=', APP)
    .where('owner_type', '=', 'user')
    .where('owner_id', '=', userId)
    .where('subject', '=', 'USER_BALANCE')
    .executeTakeFirst();
  expect(row, `USER_BALANCE of ${userId}`).toBeDefined();
  return { appId: APP, userId, accountId: row!.id };
}

/** Lower case, unique, ascending. */
function sorted(ids: readonly string[]): string[] {
  return [...new Set(ids.map((id) => id.toLowerCase()))].sort();
}

/** An adjust fixture of APP on the harness's database, with a Redis of its own. */
async function onHarness(h: Harness, run: (f: AdjustFixture) => Promise<void>): Promise<void> {
  const redis = await acquireTestRedis();
  try {
    const s: Suite = { db: () => h.db, holder: () => h.observer, redisUrl: () => redis.url };
    const clock = new FixedClock(ADMIN_NOW);
    await run({ s, db: h.db, clock, appId: APP, ledger: createLedger({ clock }) });
  } finally {
    await redis.stop();
  }
}

it('[AC-B2-17#42] 按子订单登记（08，非 05）、明细只列 U1 而该子订单的凭证上有 U1、U2 两位受益人（另有别的子订单、别的应用的同号凭证）→ 名单 = [U1, U2]（小写升序），加冻结的只有 U1；之后经后台入口 U1 调账 → 差错单 processing（handler_id、closed_at 为空），U2 调账 → adjusted', async () => {
  await withHarness(createTestDatabase, async (h) => {
    await schemaReady(h.db);
    await onHarness(h, async (f) => {
      const u1 = await adjustMember(f, { available: 1000n });
      const u2 = await adjustMember(f, { available: 1000n });
      const stranger = await adjustMember(f);
      const elsewhere = await member(h, OTHER);
      const key = orderKey();
      for (const userId of [u1, u2, u2]) await credit(h, key, userId);
      await credit(h, orderKey(), stranger);
      await credit(h, key, elsewhere, OTHER);
      const order = {
        orderKey: key,
        orderId: randomUUID(),
        beneficiaryUserIds: [u1],
        unlocatedUserIds: [],
      };
      const difference = invalidCreditedAccountDiff(order, await accountOf(h, u1));
      const execution = await h.executor.execute(h.db, {
        accountingDate: DAY,
        differences: [difference],
      });

      const row = await diffByRef(h, `08:${key}`);
      expect(row.ref_type).toBe('order');
      const list = await listOf(h.db, APP, row.id);
      expect(list, '名单 = 明细会员 ∪ 子订单受益人').toEqual(sorted([u1, u2]));
      const held = executedOf(execution, row).heldUserIds;
      expect(sorted(held), '加冻结的会员不变').toEqual(sorted([u1]));

      await withAdjustAdmin(f, async (a) => {
        await answer(await send(a, { userId: u1, refs: [diffRef(row)] }), 0);
        const processing = await diffNow(f, row.id);
        expect(processing, 'U1 调账后 processing').toEqual({
          ...row,
          status: 'processing',
          handler_id: null,
          closed_at: null,
          updated_at: f.clock.now(),
        });
        tick(f);
        await answer(await send(a, { userId: u2, refs: [diffRef(row)] }), 0);
        expect(await diffNow(f, row.id), 'U2 调账后 adjusted').toEqual({
          ...processing,
          status: 'adjusted',
          handler_id: a.maker.id,
          closed_at: f.clock.now(),
          updated_at: f.clock.now(),
        });
      });
    });
  });
}, 180_000);

it('[AC-B2-17#43] 按子订单登记时明细列了订单凭证上没有的会员 → 名单是明细会员与凭证受益人的并集（U3 只在明细、U4 只在凭证 → [U3, U4]；U5 在明细也在凭证、U6 只在凭证、同一受益人两张凭证 → [U5, U6]），小写、去重、升序；加冻结的只是明细里的会员', async () => {
  await withHarness(createTestDatabase, async (h) => {
    await schemaReady(h.db);
    const u3 = await userAccount(h);
    const u4 = await member(h);
    const u5 = await userAccount(h);
    const u6 = await member(h);
    const first = orderKey();
    const second = orderKey();
    await credit(h, first, u4);
    for (const userId of [u5.userId, u6, u6]) await credit(h, second, userId);
    const orderOf = (key: string, account: UserAccount) => ({
      orderKey: key,
      orderId: randomUUID(),
      beneficiaryUserIds: [account.userId],
      unlocatedUserIds: [],
    });
    const differences = [
      invalidCreditedAccountDiff(orderOf(first, u3), u3),
      invalidCreditedAccountDiff(orderOf(second, u5), u5),
    ];
    const execution = await h.executor.execute(h.db, { accountingDate: DAY, differences });

    const expected: readonly (readonly [string, string[], string[]])[] = [
      [`08:${first}`, sorted([u3.userId, u4]), sorted([u3.userId])],
      [`08:${second}`, sorted([u5.userId, u6]), sorted([u5.userId])],
    ];
    for (const [refId, users, holds] of expected) {
      const row = await diffByRef(h, refId);
      expect(await listOf(h.db, APP, row.id), refId).toEqual(users);
      const held = executedOf(execution, row).heldUserIds;
      expect(sorted(held), `${refId} 加冻结的会员`).toEqual(holds);
    }
  });
}, 60_000);
