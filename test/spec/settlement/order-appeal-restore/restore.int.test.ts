// B2-09gd rule tests, the handling (claude-independent, SPEC_REF d5713bf4): task brief 9.2 B and 08
// BR-FUND-22 R12 — an appeal_restore difference with reason_code BLACKLIST and a parsable ref_id goes
// to the platform restore's R12 (no entry, the difference adjusted, audit recon_diff_restore, the
// response carries rebate_status_after); the account-appeal path stays as it was; the re-checks of
// 处理时再核 apply. The orders here already have a snapshot, so no snapshot is in play. Requests go
// through the real admin entry. Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import {
  RESTORE_ACTION,
  answer,
  audits,
  available,
  diffNow,
  fixture,
  restored,
  seedCase,
  suite,
  withRestoreAdmin,
} from '../admin-recon-restore/kit.ts';
import {
  addRebateStep,
  expectAdjusted,
  expectRestoreStep,
  orderConflict,
  orderHistory,
  orderRow,
  platformRestored,
  refusedWith,
  world,
} from '../platform-restore/kit.ts';
import {
  RECEIVED_AT,
  TIMEOUT,
  seedAppealDiff,
  seedRules,
  seedVoid,
  splitsOf,
  stateOf,
  type VoidOrder,
} from './kit.ts';

const s = suite();

it(
  '[AC-B2-09gd#4] 处理：账户申诉路径回归不变（补发 85）；订单申诉（BLACKLIST）走 R12 回 ESTIMATED / WAITING（settle_period 按 received_at），不写分录、余额不变，差错单 adjusted，审计 recon_diff_restore 一条，响应带 rebate_status_after，经状态机迁移 row_version + 1、历史恰新增一行',
  async () => {
    const f = await fixture(s);
    const account = await seedCase(f);
    const paid = await seedVoid(f, { snapshot: true });
    const received = await seedVoid(f, {
      snapshot: true,
      platformStatus: 'RECEIVED',
      receivedAt: RECEIVED_AT,
    });
    await withRestoreAdmin(f, async (h) => {
      expect((await restored(await h.restore(account.diff.id))).restored_fen).toBe(85);
      expect(await available(f, account.userId)).toBe(85n);

      const before = await world(f);
      for (const [order, to, period] of [
        [paid, 'ESTIMATED', null],
        [received, 'WAITING', '2026-10'],
      ] as const) {
        const diff = await seedAppealDiff(f, order);
        const state = await stateOf(f, order);
        const splits = await splitsOf(f, order.orderId);

        const data = await platformRestored(await h.restore(diff.id));
        expect(data.restored_fen, to).toBe(0);
        expect(data.rebate_status_after, to).toBe(to);
        await expectAdjusted(f, diff, {
          adminId: h.operator.id,
          from: 'VOID',
          to,
          restoredFen: 0n,
        });
        await expectRestoreStep(f, state, { from: 'VOID', to });
        const now = await orderRow(f, order.orderId);
        expect(now.rebate_status, to).toBe(to);
        expect(now.settle_period, to).toBe(period);
        expect(now.booked_base_fen, to).toBeNull();
        expect(await splitsOf(f, order.orderId), to).toEqual(splits);

        const records = (await audits(f, RESTORE_ACTION)).filter((r) => r.target === diff.id);
        expect(records, to).toHaveLength(1);
        expect(records[0]!.admin_id, to).toBe(h.operator.id);
      }
      const after = await world(f);
      expect(after.vouchers).toEqual(before.vouchers);
      expect(after.entries).toEqual(before.entries);
      expect(after.balances).toEqual(before.balances);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-09gd#10] 处理时再核（BR-FUND-22）：平台状态又 INVALID → 20001 restore_platform_invalid；订单又被作废过（entry_id 不符）、订单已不是 VOID → 20902 order；ref_id 解析不了或 reason_code 不是 BLACKLIST → 20001 restore_not_supported；都不改订单、差错单仍 open',
  async () => {
    const f = await fixture(s);
    await seedRules(f);
    const invalid = await seedVoid(f, { platformStatus: 'INVALID', snapshot: true });
    const reVoided = await seedVoid(f, { snapshot: true });
    await addRebateStep(f, reVoided.orderId, {
      from: 'VOID',
      event: 'ADMIN_RESTORE',
      to: 'ESTIMATED',
      source: 'admin',
    });
    await addRebateStep(f, reVoided.orderId, {
      from: 'ESTIMATED',
      event: 'BLACKLIST_HIT',
      to: 'VOID',
    });
    const left = await seedVoid(f, { snapshot: true });
    await f.db
      .updateTable('orders')
      .set({ rebate_status: 'ESTIMATED' })
      .where('app_id', '=', f.appId)
      .where('order_id', '=', left.orderId)
      .execute();
    const unparsable = await seedVoid(f, { snapshot: true });
    const otherCode = await seedVoid(f, { snapshot: true });

    const invalidDiff = await seedAppealDiff(f, invalid);
    const reVoidedDiff = await seedAppealDiff(f, reVoided);
    const leftDiff = await seedAppealDiff(f, left);
    const unparsableDiff = await seedAppealDiff(f, unparsable, { ref_id: unparsable.orderKey });
    const otherCodeDiff = await seedAppealDiff(f, otherCode, {
      resolution: { reason_code: 'SOMETHING_ELSE' },
    });

    const states = new Map<string, Awaited<ReturnType<typeof stateOf>>>();
    for (const order of [invalid, reVoided, left, unparsable, otherCode]) {
      states.set(order.orderId, await stateOf(f, order));
    }
    async function unchanged(order: VoidOrder, diff: Awaited<ReturnType<typeof seedAppealDiff>>) {
      expect(await diffNow(f, diff.id)).toEqual(diff);
      expect(await orderHistory(f, order.orderId)).toEqual(states.get(order.orderId)!.history);
      expect(await orderRow(f, order.orderId)).toEqual(states.get(order.orderId)!.order);
    }

    await withRestoreAdmin(f, async (h) => {
      await refusedWith(await h.restore(invalidDiff.id), 'restore_platform_invalid');
      await unchanged(invalid, invalidDiff);

      await orderConflict(await h.restore(reVoidedDiff.id));
      await unchanged(reVoided, reVoidedDiff);

      await orderConflict(await h.restore(leftDiff.id));
      await unchanged(left, leftDiff);

      await answer(await h.restore(unparsableDiff.id), 20001, {
        fields: ['recon_diff_id'],
        reason: 'restore_not_supported',
      });
      await unchanged(unparsable, unparsableDiff);

      await answer(await h.restore(otherCodeDiff.id), 20001, {
        fields: ['recon_diff_id'],
        reason: 'restore_not_supported',
      });
      await unchanged(otherCode, otherCodeDiff);
    });
  },
  TIMEOUT,
);
