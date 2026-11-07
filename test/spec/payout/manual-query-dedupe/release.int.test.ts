// B2-09y (FU-W10-QUERY-DEDUPE; 编排 D10-702 ③, D10-707 ②; 08 BR-WDR-15, BR-WDR-14): "in flight" is
// the life of one manual query job of a withdrawal and execute_seq on the payout queue — queued,
// waiting for its retry, running. Only when it is completed, or failed with its retries spent, does
// the next click queue a new one. Other execute_seqs, other withdrawals and other apps each keep their
// own one. Real HTTP entry, real pgboss.job rows (moved as the payout process's queue moves them, see
// ./kit.ts), real query job over fake channels; synthetic data only.
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { expect, it } from 'vitest';
import {
  attemptsOf,
  audits,
  fixture,
  otherApp,
  payee,
  queuedQueries,
  rowOf,
  suite,
  unknownWithdrawal,
  withUnknownAdmin,
  type ReviewFixture,
  type WithdrawalRow,
} from '../admin-unknown-payouts/unknown-harness.ts';
import {
  QUERY_AUDIT,
  channelWorker,
  click,
  expectHeld,
  expectNoTransfer,
  jobIdsOf,
  jobsOf,
  moveJob,
  queriedWith,
  requestIdOf,
  stateOfJob,
} from './kit.ts';

const s = suite();

it('[AC-B2-09y#4] 上一条在途时再点不入队；它执行完、队列记为completed后再点才入队新的一条，manual_request_id不同；两条各查通道一次共两条query尝试，不重提转账，新一条在途时再点仍不入队', async () => {
  const f = fixture(s);
  await withUnknownAdmin(f, async (h) => {
    const w = await unknownWithdrawal(f, h, await payee(f, h));
    await click(h, w);
    const [first] = await jobsOf(f, w);
    expect(first).toBeDefined();
    await click(h, w, { key: randomUUID() });
    expect(await jobIdsOf(f, w), 'the first job is still queued: no second job').toEqual([
      first!.id,
    ]);

    const worker = channelWorker(f, h);
    await expect(worker.handler(first!)).resolves.toBeUndefined();
    await moveJob(f, first!, 'completed');
    f.clock.advanceMs(1);
    await click(h, w);
    const jobs = await jobsOf(f, w);
    expect(jobs.map((job) => job.id)).toHaveLength(2);
    expect(jobs[0]!.id).toBe(first!.id);
    const second = jobs[1]!;
    expect(requestIdOf(second)).not.toBe(requestIdOf(first!));
    expect(second.payload).toMatchObject({
      withdrawal_id: w.id,
      execute_seq: w.execute_seq,
      app_id: f.appId,
    });
    expect(await stateOfJob(f, second)).toBe('created');
    await click(h, w);
    expect(await jobIdsOf(f, w), 'the new job is queued: no third job').toEqual([
      first!.id,
      second.id,
    ]);

    await expect(worker.handler(second)).resolves.toBeUndefined();
    expect(queriedWith(worker)).toEqual([w.out_biz_no, w.out_biz_no]);
    expect(worker.channels.alipay.query).toHaveBeenCalledTimes(2);
    expectNoTransfer(worker);
    const attempts = await attemptsOf(f, w);
    expect(attempts.filter((a) => a.kind === 'query')).toHaveLength(2);
    expect(attempts.filter((a) => a.kind === 'transfer')).toHaveLength(1);
    expect(await rowOf(f, w)).toEqual(w);
    expect(await audits(f, QUERY_AUDIT)).toHaveLength(4);
  });
});

it('[AC-B2-09y#5] 上一条失败等重试（retry）及重试执行中（active）时再点均不入队、审计照记、应答submitted；重试耗尽记为failed后再点才入队新的一条', async () => {
  const f = fixture(s);
  await withUnknownAdmin(f, async (h) => {
    const w = await unknownWithdrawal(f, h, await payee(f, h));
    await click(h, w);
    const [first] = await jobsOf(f, w);
    expect(first).toBeDefined();
    const requestId = requestIdOf(first!);
    let clicks = 1;
    for (const held of ['retry', 'active'] as const) {
      await moveJob(f, first!, held);
      await expectHeld(f, h, first!);
      await click(h, w);
      clicks += 1;
      expect(await jobIdsOf(f, w), `the first job is ${held}: no second job`).toEqual([first!.id]);
      expect(await stateOfJob(f, first!)).toBe(held);
      expect(await audits(f, QUERY_AUDIT)).toHaveLength(clicks);
    }
    expect(requestIdOf((await jobsOf(f, w))[0]!)).toBe(requestId);

    await moveJob(f, first!, 'failed');
    await click(h, w);
    clicks += 1;
    const jobs = await jobsOf(f, w);
    expect(jobs.map((job) => job.id)).toHaveLength(2);
    expect(jobs[0]!.id).toBe(first!.id);
    expect(requestIdOf(jobs[1]!)).not.toBe(requestId);
    expect(await stateOfJob(f, jobs[1]!)).toBe('created');
    expect(await audits(f, QUERY_AUDIT)).toHaveLength(clicks);
  });
});

/** Another execution of the same withdrawal, as a re-executed returned row would carry it. */
async function nextExecution(f: ReviewFixture, w: WithdrawalRow): Promise<WithdrawalRow> {
  const moved = await sql`UPDATE app.withdrawals SET execute_seq = execute_seq + 1
    WHERE app_id = ${w.app_id} AND id = ${w.id} AND execute_seq = ${w.execute_seq}`.execute(f.db);
  expect(moved.numAffectedRows, `withdrawal ${w.id} execute_seq + 1`).toBe(1n);
  return rowOf(f, w);
}

it('[AC-B2-09y#6] 在途去重只按同一提现单同一execute_seq：另一张单、同单下一个execute_seq各自能入队一条且各自在途时再点不再入队；另一app的同状态单各自独立', async () => {
  const f = fixture(s);
  const g = otherApp(f);
  let w1!: WithdrawalRow;
  let held: string[] = [];
  await withUnknownAdmin(f, async (h) => {
    w1 = await unknownWithdrawal(f, h, await payee(f, h));
    const w2 = await unknownWithdrawal(f, h, await payee(f, h));
    await click(h, w1);
    const [a] = await jobsOf(f, w1);
    expect(a).toBeDefined();
    await click(h, w2);
    const [b] = await jobsOf(f, w2);
    expect(b, 'another withdrawal is not held by the first one').toBeDefined();
    await click(h, w1);
    await click(h, w2);
    expect(await jobIdsOf(f, w1)).toEqual([a!.id]);
    expect(await jobIdsOf(f, w2)).toEqual([b!.id]);

    const next = await nextExecution(f, w1);
    expect(next.execute_seq).not.toBe(w1.execute_seq);
    expect({ ...next, execute_seq: w1.execute_seq }).toEqual(w1);
    await click(h, next);
    const ids = await jobIdsOf(f, w1);
    expect(ids, 'the next execute_seq is not held by the previous one').toHaveLength(2);
    const [, c] = await jobsOf(f, w1);
    expect(c!.payload['execute_seq']).toBe(next.execute_seq);
    await click(h, next);
    expect(await jobIdsOf(f, w1)).toEqual([a!.id, c!.id]);
    expect(await audits(f, QUERY_AUDIT)).toHaveLength(6);
    held = (await queuedQueries(f)).map((job) => job.id);
    expect(held).toHaveLength(3);
  });

  await withUnknownAdmin(g, async (h) => {
    const gw = await unknownWithdrawal(g, h, await payee(g, h));
    await click(h, gw);
    const [own] = await jobsOf(g, gw);
    expect(own, 'jobs of another app do not hold this one').toBeDefined();
    await click(h, gw);
    expect(await jobIdsOf(g, gw)).toEqual([own!.id]);
    expect((await queuedQueries(g)).map((job) => job.id)).toEqual([own!.id]);
    expect(await audits(g, QUERY_AUDIT)).toHaveLength(2);
    // Nothing of the first app moved.
    expect((await queuedQueries(f)).map((job) => job.id)).toEqual(held);
    expect(await jobIdsOf(f, w1)).toHaveLength(2);
    expect(await audits(f, QUERY_AUDIT)).toHaveLength(6);
  });
});
