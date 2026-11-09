// B2-09gg rule tests, the handling (claude-independent, SPEC_REF 03383a10): 08 BR-FUND-22 R13 and 申诉
// 恢复 ②, 编排 D10-1180 — the difference a revoked appeal registered is handled by the existing R13
// through the real restore route: CLAWED_BACK → CREDITED, each beneficiary's and the platform's
// difference from the current net (BR-FUND-08) as ADMIN_ADJUST (sub_type RESTORE) on the current
// effective union commission; booked pair and refunded_quantity_r9_baseline in the same transaction;
// the `B{id}` vouchers of the clawback stay as they were. The nets are asserted beneficiary by
// beneficiary. Expected amounts are written by hand (BR-CALC-02 / BR-CALC-04). Top-level it() only.
import { expect, it } from 'vitest';
import {
  RESTORE_ACTION,
  audits,
  available,
  expectAdjusted,
  expectRestoreStep,
  memberLines,
  netOf,
  netsOf,
  newKey,
  orderHistory,
  orderRow,
  platformKey,
  platformLines,
  platformRestored,
  restoreKey,
  restoreVouchers,
  voucherLines,
  type DiffRow,
  type Role,
} from '../platform-restore/kit.ts';
import {
  TIMEOUT,
  app,
  blacklistClawback,
  clawbackRecords,
  clawedOrder,
  everything,
  registeredDiff,
  setOrderFigures,
  suite,
  withConsoleAndWorker,
  type App,
  type ConsoleEntry,
  type SeededOrder,
} from './kit.ts';

const s = suite();

interface Owed {
  readonly self: bigint;
  readonly direct: bigint;
  readonly indirect: bigint;
  readonly platform: bigint;
}

const ROLES = ['self', 'direct', 'indirect'] as const satisfies readonly Role[];

/** After a full clawback every net is 0 and every member's available is back to 0. */
async function expectClearedNets(a: App, order: SeededOrder): Promise<void> {
  const nets = await netsOf(a.f, order.orderKey);
  for (const role of ROLES) {
    expect(netOf(nets, order.user(role), role), role).toBe(0n);
    expect(await available(a.f, order.user(role)), role).toBe(0n);
  }
  expect(nets.platform_net_fen).toBe(0n);
  expect(nets.union_receivable_net_fen).toBe(0n);
}

/** Exactly these RESTORE vouchers with these lines, and the nets and balances they leave. */
async function expectRestoredAmounts(
  a: App,
  order: SeededOrder,
  diff: DiffRow,
  owed: Owed,
  nFen: bigint,
): Promise<void> {
  const keys = ROLES.map((role) => restoreKey(order.orderKey, order.user(role), role, diff.id));
  const platform = platformKey(order.orderKey, diff.id);
  expect((await restoreVouchers(a.f)).map((v) => v.uniq_key).sort()).toEqual(
    [...keys, platform].sort(),
  );
  const nets = await netsOf(a.f, order.orderKey);
  for (const role of ROLES) {
    const userId = order.user(role);
    expect(
      await voucherLines(a.f, restoreKey(order.orderKey, userId, role, diff.id)),
      role,
    ).toEqual(memberLines(order.platform, userId, owed[role]));
    expect(netOf(nets, userId, role), `net of ${role}`).toBe(owed[role]);
    expect(await available(a.f, userId), `available of ${role}`).toBe(owed[role]);
  }
  expect(await voucherLines(a.f, platform)).toEqual(platformLines(order.platform, owed.platform));
  expect(nets.platform_net_fen).toBe(owed.platform);
  expect(nets.union_receivable_net_fen).toBe(nFen);
}

async function restoreOf(
  a: App,
  admin: ConsoleEntry,
  order: SeededOrder,
  diff: DiffRow,
  expected: { readonly restoredFen: bigint },
) {
  const stateBefore = {
    order: await orderRow(a.f, order.orderId),
    history: await orderHistory(a.f, order.orderId),
  };
  const data = await platformRestored(await admin.restore(diff.id));
  expect(data.restored_fen).toBe(Number(expected.restoredFen));
  expect(data.rebate_status_after).toBe('CREDITED');
  await expectAdjusted(a.f, diff, {
    adminId: admin.operator.id,
    from: 'CLAWED_BACK',
    to: 'CREDITED',
    restoredFen: expected.restoredFen,
  });
  await expectRestoreStep(a.f, stateBefore, { from: 'CLAWED_BACK', to: 'CREDITED' });
  const records = (await audits(a.f, RESTORE_ACTION)).filter((r) => r.target === diff.id);
  expect(records).toHaveLength(1);
  return orderRow(a.f, order.orderId);
}

it(
  '[AC-B2-09gg#6] 处理走通（真实 step-up）：真实黑名单扣回（425 / 85 / 42，平台 448）后结算佣金变为 2000，撤销登记的差错单经 restore 走 R13：CLAWED_BACK → CREDITED；按当前有效佣金 B 1700 重算，ADMIN_ADJUST（RESTORE）本人 850、直推 170、间推 85、平台 895，键 `{order_key}:{user_id}:{role}:RESTORE:{id}` 与 `{order_key}:PLATFORM:RESTORE:{id}`；恢复后净额逐受益人等于重算应得；同事务 booked_base_fen 1700、booked_n_fen 2000、refunded_quantity_r9_baseline = 当时 refunded_quantity（2），refunded_quantity_at_credit 不动；响应 restored_fen 1105、rebate_status_after CREDITED；原 `B{id}` 凭证与分录不变',
  async () => {
    const a = await app(s);
    await withConsoleAndWorker(a, async (admin, worker) => {
      const { order, entryId, clawbackDiff } = await clawedOrder(a, admin);
      const clawback = await clawbackRecords(a, clawbackDiff);
      expect(clawback.vouchers).toHaveLength(4);
      await expectClearedNets(a, order);
      await setOrderFigures(a, order, { settleFen: 2000n, quantity: 3, refundedQuantity: 2 });
      const atCredit = (await orderRow(a.f, order.orderId)).refunded_quantity_at_credit;

      const diff = await registeredDiff(a, worker, order, entryId);
      const row = await restoreOf(a, admin, order, diff, { restoredFen: 1105n });

      await expectRestoredAmounts(
        a,
        order,
        diff,
        { self: 850n, direct: 170n, indirect: 85n, platform: 895n },
        2000n,
      );
      expect(row.rebate_status).toBe('CREDITED');
      expect(row.booked_base_fen).toBe(1700n);
      expect(row.booked_n_fen).toBe(2000n);
      expect(row.refunded_quantity_r9_baseline).toBe(2);
      expect(row.refunded_quantity_at_credit).toBe(atCredit);
      expect(await clawbackRecords(a, clawbackDiff)).toEqual(clawback);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-09gg#7] 扣回前有过部分退款（差额按净额算，不是按首次入账）：首次入账 425 / 85 / 42、平台 448，部分退款 N 1000 → 600 先扣到 255 / 51 / 25、平台 269（R9），确认扣回把这些净额清零；撤销后 R13 按当前有效佣金 600（B 510）写 255 / 51 / 25、平台 269，恢复后净额逐受益人等于重算应得，不是首次入账额；booked_base_fen 510、booked_n_fen 600',
  async () => {
    const a = await app(s);
    await withConsoleAndWorker(a, async (admin, worker) => {
      const order = await a.h.credited();
      expect(
        await a.h.apply(order, {
          cause: 'PARTIAL_REFUND',
          ref: { kind: 'commission' },
          newCommissionFen: 600n,
        }),
      ).toMatchObject({
        outcome: 'clawed_back',
        transition: 'R9',
        bookedBaseFen: 510n,
        bookedNFen: 600n,
      });
      await setOrderFigures(a, order, { settleFen: 600n });
      const netsAfterRefund = await netsOf(a.f, order.orderKey);
      expect(netOf(netsAfterRefund, order.user('self'), 'self')).toBe(255n);
      expect(netOf(netsAfterRefund, order.user('direct'), 'direct')).toBe(51n);
      expect(netOf(netsAfterRefund, order.user('indirect'), 'indirect')).toBe(25n);
      expect(netsAfterRefund.platform_net_fen).toBe(269n);

      const { entryId, clawbackDiff } = await blacklistClawback(a, admin, order);
      const clawback = await clawbackRecords(a, clawbackDiff);
      await expectClearedNets(a, order);

      const diff = await registeredDiff(a, worker, order, entryId);
      const row = await restoreOf(a, admin, order, diff, { restoredFen: 331n });

      await expectRestoredAmounts(
        a,
        order,
        diff,
        { self: 255n, direct: 51n, indirect: 25n, platform: 269n },
        600n,
      );
      expect(row.rebate_status).toBe('CREDITED');
      expect(row.booked_base_fen).toBe(510n);
      expect(row.booked_n_fen).toBe(600n);
      expect(await clawbackRecords(a, clawbackDiff)).toEqual(clawback);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-09gg#8] 幂等：同一 Idempotency-Key 同一请求体回放返回第一次的应答，不重复记账、不再写审计、不再改订单',
  async () => {
    const a = await app(s);
    await withConsoleAndWorker(a, async (admin, worker) => {
      const { order, entryId } = await clawedOrder(a, admin);
      const diff = await registeredDiff(a, worker, order, entryId);
      const key = newKey();
      const body = { note: '核对后恢复' };

      const sent = await admin.restore(diff.id, body, { key });
      const data = await platformRestored(sent);
      expect(data.restored_fen).toBe(552);
      expect(data.rebate_status_after).toBe('CREDITED');
      const after = await everything(a);

      for (let replay = 0; replay < 2; replay += 1) {
        const again = await admin.restore(diff.id, body, { key });
        expect(again.statusCode).toBe(sent.statusCode);
        expect(again.body).toBe(sent.body);
      }
      expect(await everything(a)).toEqual(after);
      await expectRestoredAmounts(
        a,
        order,
        diff,
        { self: 425n, direct: 85n, indirect: 42n, platform: 448n },
        1000n,
      );
      const records = (await audits(a.f, RESTORE_ACTION)).filter((r) => r.target === diff.id);
      expect(records).toHaveLength(1);
    });
  },
  TIMEOUT,
);
