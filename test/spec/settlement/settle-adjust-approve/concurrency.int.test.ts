// B2-09zc rule tests (claude-independent, SPEC_REF b79958d): approval order by order, each on its own
// transaction under the order's lock, candidates by row_version CAS (contracts/openapi.yaml
// adminApproveSettleAdjustBatch: 「of two concurrent approvals of one batch, each order is approved once
// and its vouchers are written once」; `already_decided`: another call approved or rejected this
// order's candidates first; D10-770 ①: 任一单作废不挡同批其余各单). The admin entry runs on a pool of 3
// connections (the production size): concurrent approvals must neither deadlock on the pool nor
// write twice (B2-09x lesson: no second connection taken while a request transaction is held).
// A failure in the middle of one order's vouchers (injected after PostgreSQL ran the statement)
// leaves that order exactly as it was — vouchers, balances, booked pair, candidates — and the other
// orders of the batch are approved; a later call approves the rest.
// Example order: 1234 (617 / 123 / 494, reserve 0) → 1300: +33 / +7 / +26.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { expect, it } from 'vitest';
import {
  APPROVE_ACTION,
  EXAMPLE,
  TIMEOUT,
  answer,
  approveHarness,
  approveSuite,
  approvedData,
  expectApproved,
  failAfter,
  platformIncrease,
  result,
  userIncrease,
  within,
  withAdmin,
  type ApproveData,
  type ApproveHarness,
  type SeededOrder,
  type Sent,
} from './kit.ts';

const s = approveSuite();

/** The order's +33 / +7 / +26 vouchers of `seq`. */
async function expectExample(h: ApproveHarness, o: SeededOrder, seq: number): Promise<void> {
  await h.expectAdjust(o, seq, [
    ...userIncrease(o, 'self', 33n, seq),
    ...userIncrease(o, 'direct', 7n, seq),
    ...platformIncrease(o, 26n, seq),
  ]);
  expect(await h.balance(o.user('self'))).toBe(650n);
  expect(await h.balance(o.user('direct'))).toBe(130n);
  expect(await h.read(o)).toMatchObject({ booked_base_fen: 1300n, booked_n_fen: 1300n });
}

it(
  '[AC-B2-09zc#4] 另一次调用已先决定了某单的候选（CAS 赢了）：本次该单答 already_decided / 0、不写；同批其余单照常 approved',
  async () => {
    const h = await approveHarness(s);
    const first = await h.raised(EXAMPLE, 1300n);
    const second = await h.raised(EXAMPLE, 1300n);
    const batchId = await h.generate();
    h.clock.advanceMs(60_000);
    // The state another approval leaves on `first` once its CAS won (its candidates approved).
    const other = await h.admin();
    await h.decide(first.o, 'approved', other, '2032-07-24T10:00:30+08:00');
    const decidedRows = await h.rowsOf(first.o);

    await withAdmin(s, h, async (a) => {
      const firstMoney = await h.moneyOf(first.o);
      await expectApproved(await a.approve(batchId), batchId, [
        result(first.o, 'already_decided', 0),
        result(second.o, 'approved', 40),
      ]);
      expect(await h.rowsOf(first.o)).toEqual(decidedRows);
      expect(await h.moneyOf(first.o)).toEqual(firstMoney);
      expect(await h.adjLinesOf(first.o)).toEqual([]);
      await expectExample(h, second.o, second.seq);
      expect((await h.batch(batchId)).confirmed_by).toBe(a.adjuster.id);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-09zc#4] 三次并发批准同一批次（4 单，不同幂等键，admin 连接池 3）：都在时限内答复（不死锁），每个 200 或 20902；每单恰好一次 approved、其余 200 答复里为 already_decided；凭证各写一次，审计条数 = 200 答复数',
  async () => {
    const h = await approveHarness(s);
    const seeded: { o: SeededOrder; seq: number }[] = [];
    for (let i = 0; i < 4; i += 1) seeded.push(await h.raised(EXAMPLE, 1300n));
    const batchId = await h.generate();
    h.clock.advanceMs(60_000);

    await withAdmin(s, h, async (a) => {
      const sent: Sent[] = await within(
        120_000,
        Promise.all([a.approve(batchId), a.approve(batchId), a.approve(batchId)]),
        'three concurrent approvals on a pool of 3',
      );
      const served: ApproveData[] = [];
      for (const one of sent) {
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
        await expectExample(h, o, seq);
        expect((await h.rowsOf(o)).map((r) => r.status)).toEqual([
          'approved',
          'approved',
          'approved',
        ]);
      }
      expect(await h.audits(APPROVE_ACTION)).toHaveLength(served.length);
      expect((await h.batch(batchId)).confirmed_at).toEqual(h.clock.now());
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-09zc#7] 某单写凭证中途失败（注入故障，语句已执行后抛错）：该单分录、余额、booked、候选全不变（仍待批），同批另一单照常批准，批次不确认；之后再批准：该单 approved、另一单 already_decided，批次确认',
  async () => {
    const h = await approveHarness(s);
    const broken = await h.raised(EXAMPLE, 1300n);
    const healthy = await h.raised(EXAMPLE, 1300n);
    const batchId = await h.generate();
    h.clock.advanceMs(60_000);
    const brokenRows = await h.rowsOf(broken.o);
    const brokenMoney = await h.moneyOf(broken.o);
    const brokenPrefix = `${broken.o.orderKey}:`;
    let injected = (): number => 0;
    const wrap = (db: Kysely<DB>): Kysely<DB> => {
      const faulty = failAfter(
        db,
        (q) =>
          /insert\s+into\s+(?:"?app"?\.)?"?ledger_vouchers"?/i.test(q.sql) &&
          q.parameters.some(
            (p) => typeof p === 'string' && p.startsWith(brokenPrefix) && p.includes(':ADJ:'),
          ),
      );
      injected = faulty.injected;
      return faulty.db;
    };

    await withAdmin(
      s,
      h,
      async (a) => {
        const sent = await a.approve(batchId);
        expect(injected()).toBeGreaterThan(0);
        if (sent.statusCode === 200) {
          const data = await approvedData(sent);
          const outcome = data.results.find((r) => r.order_id === broken.o.orderId)?.outcome;
          expect(['approved', 'approved_zero']).not.toContain(outcome);
        }
        expect(await h.rowsOf(broken.o)).toEqual(brokenRows);
        expect(await h.moneyOf(broken.o)).toEqual(brokenMoney);
        expect(await h.adjLinesOf(broken.o)).toEqual([]);
        await expectExample(h, healthy.o, healthy.seq);
        expect((await h.batch(batchId)).confirmed_at).toBeNull();
      },
      { wrap },
    );

    await withAdmin(s, h, async (a) => {
      await expectApproved(await a.approve(batchId), batchId, [
        result(broken.o, 'approved', 40),
        result(healthy.o, 'already_decided', 0),
      ]);
      await expectExample(h, broken.o, broken.seq);
      await expectExample(h, healthy.o, healthy.seq);
      expect(await h.batch(batchId)).toMatchObject({
        confirmed_by: a.adjuster.id,
        confirmed_at: h.clock.now(),
      });
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-09zc#7] 批次 6 单在 3 连接的 admin 池上一次批准：在时限内答复、6 单全部 approved，审计一条（审计不在持有请求事务时另取连接）',
  async () => {
    const h = await approveHarness(s);
    const seeded: { o: SeededOrder; seq: number }[] = [];
    for (let i = 0; i < 6; i += 1) seeded.push(await h.raised(EXAMPLE, 1300n));
    const batchId = await h.generate();
    h.clock.advanceMs(60_000);

    await withAdmin(s, h, async (a) => {
      const sent = await within(120_000, a.approve(batchId), 'one approval on a pool of 3');
      await expectApproved(
        sent,
        batchId,
        seeded.map(({ o }) => result(o, 'approved', 40)),
      );
      for (const { o, seq } of seeded) await expectExample(h, o, seq);
      expect(await h.audits(APPROVE_ACTION)).toHaveLength(1);
    });
  },
  TIMEOUT,
);
