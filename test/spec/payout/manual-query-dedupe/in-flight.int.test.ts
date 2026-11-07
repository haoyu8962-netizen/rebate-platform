// B2-09y (FU-W10-QUERY-DEDUPE; 编排 D10-702 ③, D10-707 ②; 08 BR-WDR-15, BR-WDR-14): while one manual
// query of a withdrawal is in flight, another click with another Idempotency-Key, or by another
// person, answers submitted, records its own payout_query_request and queues nothing. The one job in
// flight asks the channel once and its answer is the latest_query. Real HTTP entry, real pgboss.job
// rows, real query job over fake channels; synthetic data only.
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  answer,
  attemptsOf,
  audits,
  balanceOf,
  fixture,
  payee,
  rowOf,
  state,
  suite,
  unknownWithdrawal,
  voucherOf,
  withUnknownAdmin,
} from '../admin-unknown-payouts/unknown-harness.ts';
import {
  QUERY_AUDIT,
  auditsBy,
  channelWorker,
  click,
  expectNoTransfer,
  jobIdsOf,
  jobsOf,
  latestOf,
  queriedWith,
  requestIdOf,
  stateOfJob,
} from './kit.ts';

const s = suite();

it('[AC-B2-09y#1] 首条人工查询仍在队列里时换幂等键再点：应答submitted、不入第二条（队列里仍是首条及其manual_request_id）、审计记两条；两个键各自同键重放应答逐字相同、不增任务与审计', async () => {
  const f = fixture(s);
  await withUnknownAdmin(f, async (h) => {
    const w = await unknownWithdrawal(f, h, await payee(f, h));
    const firstIdem = randomUUID();
    const first = await click(h, w, { key: firstIdem });
    const queued = await jobsOf(f, w);
    expect(queued).toHaveLength(1);
    const job = queued[0]!;
    const requestId = requestIdOf(job);
    expect(await stateOfJob(f, job)).toBe('created');

    const secondIdem = randomUUID();
    const second = await click(h, w, { key: secondIdem });
    expect(await jobIdsOf(f, w), 'a click while the first job is queued queues nothing').toEqual([
      job.id,
    ]);
    const after = await jobsOf(f, w);
    expect(requestIdOf(after[0]!)).toBe(requestId);
    expect(after[0]!.payload).toEqual(job.payload);
    expect(await audits(f, QUERY_AUDIT)).toHaveLength(2);

    const before = await state(f);
    expect((await h.query(w.id, { key: firstIdem })).body).toBe(first.body);
    expect((await h.query(w.id, { key: secondIdem })).body).toBe(second.body);
    expect(await state(f)).toEqual(before);
    expect(await jobIdsOf(f, w)).toEqual([job.id]);
    expect(await audits(f, QUERY_AUDIT)).toHaveLength(2);
  });
});

it('[AC-B2-09y#2] 两位处置人各用自己的幂等键同时点同一张单：两人都得submitted，队列只有一条人工查询任务，两人各记一条payout_query_request审计', async () => {
  const f = fixture(s);
  await withUnknownAdmin(f, async (h) => {
    const w = await unknownWithdrawal(f, h, await payee(f, h));
    const other = await h.caller(['payout.execute']);
    const [one, two] = await Promise.all([
      h.query(w.id, { key: randomUUID() }),
      h.query(w.id, { key: randomUUID(), caller: other }),
    ]);
    for (const sent of [one, two]) {
      await answer(sent, 0, { withdrawal_id: w.id, result: 'submitted' });
    }
    const jobs = await jobsOf(f, w);
    expect(jobs, 'two people clicking at once queue one manual query').toHaveLength(1);
    requestIdOf(jobs[0]!);
    expect(await stateOfJob(f, jobs[0]!)).toBe('created');
    expect(await audits(f, QUERY_AUDIT)).toHaveLength(2);
    for (const who of [h.executor, other]) {
      expect(await auditsBy(f, who.id), `payout_query_request of ${who.id}`).toHaveLength(1);
    }
  });
});

it('[AC-B2-09y#3] 被去重的那次点击只留审计与幂等记录：不入队、不另查通道、不另记query尝试；在途首条执行后通道只调一次、仅一条query，提现单状态余额凭证不变，latest_query即首条结果', async () => {
  const f = fixture(s);
  await withUnknownAdmin(f, async (h) => {
    const who = await payee(f, h);
    const w = await unknownWithdrawal(f, h, who);
    await click(h, w);
    const [first] = await jobsOf(f, w);
    expect(first).toBeDefined();

    const beforeClick = await state(f);
    await click(h, w);
    const afterClick = await state(f);
    // The deduplicated request writes only its audit record and its idempotency record.
    expect({ ...afterClick, audits: [], idempotency: [] }).toEqual({
      ...beforeClick,
      audits: [],
      idempotency: [],
    });
    expect(afterClick.audits).toHaveLength(beforeClick.audits.length + 1);
    expect(await jobIdsOf(f, w)).toEqual([first!.id]);

    const balance = await balanceOf(f.db, f.ledger, f.appId, who.userId);
    const worker = channelWorker(f, h, {
      kind: 'fail',
      raw: { code: 'SYNTHETIC_FAIL', subCode: 'SYNTHETIC_FAIL_DETAIL' },
      status: 'SYNTHETIC_CLOSED',
    });
    // Every job the clicks left in the queue runs once, as the payout process would take them.
    for (const job of await jobsOf(f, w)) {
      await expect(worker.handler(job)).resolves.toBeUndefined();
      f.clock.advanceMs(1);
    }
    expect(queriedWith(worker), 'the channel is asked once for the one job in flight').toEqual([
      w.out_biz_no,
    ]);
    expect(worker.channels.alipay.query).toHaveBeenCalledTimes(1);
    expectNoTransfer(worker);
    const attempts = await attemptsOf(f, w);
    expect(attempts.filter((a) => a.kind === 'transfer')).toHaveLength(1);
    const queries = attempts.filter((a) => a.kind === 'query');
    expect(queries).toHaveLength(1);
    expect(queries[0]).toMatchObject({
      result: 'fail',
      request: expect.objectContaining({ out_biz_no: w.out_biz_no }),
    });
    const afterRun = await state(f);
    expect({ ...afterRun, attempts: [] }).toEqual({ ...afterClick, attempts: [] });
    expect(await rowOf(f, w)).toEqual(w);
    expect(await balanceOf(f.db, f.ledger, f.appId, who.userId)).toEqual(balance);
    expect(await voucherOf(f.db, f.appId, `wd:${w.id}:PAID`)).toEqual([]);
    const latest = await latestOf(h, w);
    expect(latest).toMatchObject({
      result: 'fail',
      resp_code: 'SYNTHETIC_FAIL',
      resp_sub_code: 'SYNTHETIC_FAIL_DETAIL',
      channel_status: 'SYNTHETIC_CLOSED',
    });
    expect(Date.parse(String(latest!['at']))).toBe(queries[0]!.at.getTime());
  });
});
