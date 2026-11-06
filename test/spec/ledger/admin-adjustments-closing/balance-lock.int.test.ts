// B2-12d approval under the balance lock (claude-independent; spec-test r1 S1 on
// concurrency.int.test.ts:45): adminApproveAdjustment — "Effects, in one transaction under the
// member's balance lock: amount_fen becomes the current available" (BR-FUND-24 ①「批准时在同一事务内
// 重读余额并写凭证」, ⑧「金额在批准时按当时 available 取」; ledger AGENTS.md 硬规则 2). The other side holds
// only the member's account_balances row (ledger.lockBalances on the suite's second pool, never
// identity's users lock), so holding the users row alone does not order the two; waiting is
// recognised with pg_blocking_pids.
// - writer first: the writer locks the balance row (available 2000) and, while the approval waits
//   on it, credits +500 and commits → the approval reads 2500 under the lock: amount 2500,
//   available 2500 → 0. An approval that read available before taking the lock would debit 2000
//   and leave 500.
// - approval first: the approval takes the balance lock (available 2000) and waits there; the
//   writer's lockBalances is blocked by it; once the approval commits (amount 2000, available 0)
//   the writer reads 0 and credits +500 → available 500. An approval that let the lock go before
//   its voucher would lose one of the two writes.
// Entries by hand: the seed −2000 on the member's line (a credit of 2000), the writer −500, the
// approval +2500 or +2000; available = −(sum of the member's lines).
import { expect, it } from 'vitest';
import {
  TIMEOUT,
  expectApproved,
  fixture,
  formNow,
  member,
  moneyOf,
  seedPrefill,
  seedRequest,
  suite,
  withClosingAdmin,
  type AdjustFixture,
  type AdminSent,
} from './kit.ts';
import {
  balanceBarrier,
  balanceWriter,
  blockersOf,
  settledFlag,
  until,
  userLines,
  waitersOn,
  type BalanceWriter,
} from './kit-r2.ts';

const s = suite();

/**
 * The member's own available lines, exactly: the seed credit of 2000 (−2000), the writer's credit
 * (−500) and the approval's debit (+amount); nothing else.
 */
async function expectMemberLines(
  f: AdjustFixture,
  e: {
    readonly userId: string;
    readonly adjustId: string;
    readonly writerKey: string;
    readonly approved: bigint;
  },
): Promise<void> {
  const lines = await userLines(f, e.userId);
  const of = (key: string) =>
    lines.filter((line) => line.uniq_key === key).map((line) => line.amount_fen);
  const adj = `ADJ:${e.adjustId}`;
  expect(of(adj), adj).toEqual([e.approved]);
  expect(of(e.writerKey), 'the writer credit').toEqual([-500n]);
  const others = lines.filter((line) => line.uniq_key !== adj && line.uniq_key !== e.writerKey);
  expect(
    others.map((line) => line.amount_fen),
    'the seed credit only',
  ).toEqual([-2000n]);
  expect(lines).toHaveLength(3);
}

it.each(['writer first', 'approval first'] as const)(
  '[AC-B2-12d#25] 只持 account_balances 行锁（不持 users 锁）的另一连接与批准并发（%s）：批准在余额锁内重读 available；提交后逐项核对单据金额、余额与双方分录',
  async (order) => {
    const f = fixture(s);
    const userId = await member(f, { available: 2000n, status: 'deleting' });
    const request = await seedRequest(f, userId);
    const form = await seedPrefill(f, userId, {
      refs: [{ ref_type: 'account_deletion', ref_id: request.id }],
    });
    const barrier = balanceBarrier(userId);
    await withClosingAdmin({ ...f, db: f.db.withPlugin(barrier.plugin) }, async (h) => {
      const token = await h.stepUp(h.maker);
      let writer: BalanceWriter | undefined;
      let approving: Promise<AdminSent> | undefined;
      try {
        if (order === 'writer first') {
          writer = await balanceWriter(f, userId, 500n);
          expect((await writer.locked).available_fen, 'the writer holds the row at 2000').toBe(
            2000n,
          );
          approving = h.approve(form.adjust_id, { stepUp: token });
          const approvalSettled = settledFlag(approving);
          const holder = writer.pid;
          await until(
            async () => (await waitersOn(f, holder)) >= 1,
            approvalSettled,
            'the approval waits on the balance row the writer holds (pg_blocking_pids)',
          );
          writer.open();
          await writer.done;
          const sent = await approving;
          await expectApproved(f, sent, { caller: h.maker, form, amount: 2500n });
          expect(await moneyOf(f, userId)).toEqual({ available: 0n, frozen: 0n });
          expect((await formNow(f, form.adjust_id))?.amount_fen).toBe(2500n);
          await expectMemberLines(f, {
            userId,
            adjustId: form.adjust_id,
            writerKey: writer.uniqKey,
            approved: 2500n,
          });
        } else {
          barrier.arm();
          approving = h.approve(form.adjust_id, { stepUp: token });
          const approvalSettled = settledFlag(approving);
          const reached = await Promise.race([
            barrier.reached.then(() => true),
            approving.then(
              () => false,
              () => false,
            ),
          ]);
          expect(reached, 'the approval locks the member balance row FOR UPDATE').toBe(true);
          writer = await balanceWriter(f, userId, 500n);
          const waiting = writer.pid;
          await until(
            async () => (await blockersOf(f, waiting)) >= 1,
            approvalSettled,
            'the writer waits on the balance row the approval holds (pg_blocking_pids)',
          );
          barrier.open();
          const sent = await approving;
          // The writer got the row only after the approval committed: it reads 0.
          expect((await writer.locked).available_fen, 'the writer reads after the approval').toBe(
            0n,
          );
          await expectApproved(f, sent, { caller: h.maker, form, amount: 2000n });
          writer.open();
          await writer.done;
          expect(await moneyOf(f, userId)).toEqual({ available: 500n, frozen: 0n });
          expect((await formNow(f, form.adjust_id))?.amount_fen).toBe(2000n);
          expect((await formNow(f, form.adjust_id))?.status).toBe('APPROVED');
          await expectMemberLines(f, {
            userId,
            adjustId: form.adjust_id,
            writerKey: writer.uniqKey,
            approved: 2000n,
          });
        }
      } finally {
        barrier.open();
        writer?.open();
        await writer?.done.catch(() => undefined);
        await approving?.catch(() => undefined);
      }
    });
  },
  TIMEOUT,
);
