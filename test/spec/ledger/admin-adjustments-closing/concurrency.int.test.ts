// B2-12d approval against the completion (claude-independent): BR-FUND-24 ⑧ (须在注销 done 前完成) and
// D10-137 ① (a balance never passes to done). The member's users row and balance row are held from
// the suite's second pool (B2-12c kit holdMember, the order every funds writer takes) while the
// approval on the admin entry and a round of the worker entry's deletion runner both queue behind
// them, in either order; then the hold is released and both run. Whatever order they end up in:
// the approval takes the whole 2000; when the completion turns the users row into the tombstone,
// the member's committed available is already 0 (tombstoneProbe reads it from another connection
// right after that statement, inside the completion transaction); the next round completes the
// deletion if this one did not.
import { expect, it } from 'vitest';
import {
  TIMEOUT,
  expectApproved,
  fixture,
  holdMember,
  lockWaiters,
  member,
  moneyOf,
  requestNow,
  seedPrefill,
  seedRequest,
  settleOpenDeletions,
  suite,
  tombstoneProbe,
  userStatusOf,
  withClosingAdmin,
  withDeletionWorker,
  type AdminSent,
} from './kit.ts';

const s = suite();

it.each(['approval first', 'completion first'] as const)(
  '[AC-B2-12d#24] 批准与注销完成事务并发（%s 排队）：批准取整笔 2000；注销完成写墓碑时已提交的 available 为 0，绝不把余额带进 done；之后一轮内完成注销',
  async (order) => {
    const f = fixture(s);
    await settleOpenDeletions(f);
    const userId = await member(f, { available: 2000n, status: 'deleting' });
    const request = await seedRequest(f, userId);
    const form = await seedPrefill(f, userId, {
      refs: [{ ref_type: 'account_deletion', ref_id: request.id }],
    });
    const probe = tombstoneProbe(f, userId);
    await withClosingAdmin(f, async (h) => {
      await withDeletionWorker(
        f,
        async (w) => {
          const token = await h.stepUp(h.maker);
          const held = await holdMember(f, userId);
          let approving: Promise<AdminSent> | undefined;
          let round: Promise<void> | undefined;
          let queued: unknown;
          try {
            if (order === 'approval first') {
              approving = h.approve(form.adjust_id, { stepUp: token });
              await lockWaiters(f, 1);
              round = w.round();
            } else {
              round = w.round();
              await lockWaiters(f, 1);
              approving = h.approve(form.adjust_id, { stepUp: token });
            }
            await lockWaiters(f, 2);
          } catch (error: unknown) {
            queued = error;
          } finally {
            await held.release();
          }
          // Both always settle before the entries close, whatever happened above.
          const [sent, ran] = await Promise.allSettled([
            approving ?? Promise.reject(new Error('the approval was not sent')),
            round ?? Promise.resolve(),
          ]);
          if (queued !== undefined) throw queued;
          expect(ran.status, 'the deletion round').toBe('fulfilled');
          expect(sent.status, 'the approval request').toBe('fulfilled');
          if (sent.status !== 'fulfilled') return;
          await expectApproved(f, sent.value, { caller: h.maker, form, amount: 2000n });

          f.clock.advanceMs(60_000);
          await w.round();
          expect((await requestNow(f, request.id)).status).toBe('done');
          expect(await userStatusOf(f, userId)).toBe('deleted');
          expect(await moneyOf(f, userId)).toEqual({ available: 0n, frozen: 0n });
          expect(probe.seen.length, 'the completion wrote the tombstone once').toBe(1);
          expect(probe.seen, 'committed available when the tombstone was written').toEqual([0n]);
        },
        [probe.plugin],
      );
    });
  },
  TIMEOUT,
);
