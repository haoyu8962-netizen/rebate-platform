// B2-09zc rule tests, attempt 3 (claude-independent, SPEC_REF b79958d; spec-test review r1 gap 4): two
// approvals of one batch that really compete. contracts/openapi.yaml adminApproveSettleAdjustBatch:
// 「of two concurrent approvals of one batch, each order is approved once and its vouchers are written
// once」 (candidates by row_version CAS); `already_decided`: another call approved or rejected this
// order's candidates first; a batch already confirmed answers 20902 (data.resource
// settle_adjust_batch). A read barrier on the admin entry's executor holds the first call right after
// it read the pending candidates until the second call has read them too, then lets them go on in
// either order (both release orders run). No 5xx, and the admin pool of 3 connections does not
// deadlock.
// Example order: 1234 (617 / 123 / 494, reserve 0) → 1300: +33 / +7 / +26.
import { expect, it } from 'vitest';
import {
  APPROVE_ACTION,
  EXAMPLE,
  TIMEOUT,
  answer,
  approveHarness,
  approveSuite,
  approvedData,
  platformIncrease,
  readBarrier,
  userIncrease,
  within,
  withAdmin,
  type ApproveData,
  type ReadBarrier,
  type SeededOrder,
  type Sent,
} from './kit.ts';

const s = approveSuite();

it.each(['arrival', 'reverse'] as const)(
  '[AC-B2-09zc#4] 两次批准同一批次（2 单）都读到待批候选后才放行（屏障，放行顺序 %s）：都在时限内答复、无 5xx，每个 200 或 20902；每单恰好一次 approved、另一 200 答复里该单为 already_decided；SETTLE_ADJUST 凭证各写一次（+33 / +7 / +26），候选都已批准，审计条数 = 200 答复数，批次确认',
  async (release) => {
    const h = await approveHarness(s);
    const seeded: { o: SeededOrder; seq: number }[] = [];
    for (let i = 0; i < 2; i += 1) seeded.push(await h.raised(EXAMPLE, 1300n));
    const batchId = await h.generate();
    h.clock.advanceMs(60_000);
    let barrier: ReadBarrier | undefined;

    await withAdmin(
      s,
      h,
      async (a) => {
        const sent: Sent[] = await within(
          120_000,
          Promise.all([a.approve(batchId), a.approve(batchId)]),
          `two approvals behind a read barrier (${release})`,
        );
        // The barrier held at least the first call's read of the pending candidates.
        expect(barrier?.arrivals() ?? 0).toBeGreaterThan(0);
        const served: ApproveData[] = [];
        for (const one of sent) {
          expect(one.statusCode, one.body).toBeLessThan(500);
          expect([200, 409], one.body).toContain(one.statusCode);
          if (one.statusCode === 200) served.push(await approvedData(one));
          else await answer(one, 20902, { resource: 'settle_adjust_batch' });
        }
        expect(served.length).toBeGreaterThan(0);
        for (const { o, seq } of seeded) {
          const outcomes = served.map(
            (d) => d.results.find((r) => r.order_id === o.orderId)?.outcome,
          );
          expect(
            outcomes.filter((x) => x === 'approved'),
            o.orderId,
          ).toHaveLength(1);
          expect(
            outcomes.filter((x) => x !== 'approved'),
            o.orderId,
          ).toEqual(outcomes.filter((x) => x === 'already_decided'));
          await h.expectAdjust(o, seq, [
            ...userIncrease(o, 'self', 33n, seq),
            ...userIncrease(o, 'direct', 7n, seq),
            ...platformIncrease(o, 26n, seq),
          ]);
          const adjVouchers = new Set((await h.adjLinesOf(o)).map((l) => l.uniq_key));
          expect(adjVouchers.size, o.orderId).toBe(3);
          expect(await h.balance(o.user('self'))).toBe(650n);
          expect(await h.balance(o.user('direct'))).toBe(130n);
          expect(await h.receivableOf(o)).toBe(1300n);
          expect(await h.read(o)).toMatchObject({ booked_base_fen: 1300n, booked_n_fen: 1300n });
          expect((await h.rowsOf(o)).map((r) => r.status)).toEqual([
            'approved',
            'approved',
            'approved',
          ]);
        }
        expect(await h.audits(APPROVE_ACTION)).toHaveLength(served.length);
        expect((await h.batch(batchId)).confirmed_at).toEqual(h.clock.now());
      },
      {
        wrap: (db) => {
          barrier = readBarrier(db, release);
          return barrier.db;
        },
      },
    );
  },
  TIMEOUT,
);
