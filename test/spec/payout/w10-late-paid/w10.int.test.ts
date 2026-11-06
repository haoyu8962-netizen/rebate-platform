// B2-09u / BR-WDR-15、23 / D10-679. Real admin W10, pg-boss rows and recon worker.
// Existing W10 already resolves paid; missing enqueue must fail assertions, not imports.
import { sql } from 'kysely';
import { expect, it } from 'vitest';
import {
  DAY,
  answer,
  member,
  newKey,
  paidBody,
  payee,
  refused,
  reviewing,
  rowOf,
  seedQueries,
  serial,
  state,
  unknownWithdrawal,
  withUnknownAdmin,
} from '../admin-unknown-payouts/unknown-harness.ts';
import {
  BILL_DATE,
  alertsAbout,
  books,
  diffs,
  diffsOf,
  expectDiff,
  expectReconHold,
  holdsOf,
  lineOf,
  reconRows,
  runs,
} from '../recon-channel/kit.ts';
import {
  expectQueued,
  jobs,
  lateJobs,
  runLate,
  stored,
  suite,
} from '../recon-late-paid/late-paid-harness.ts';

const s = suite(true);

it('[AC-B2-09u#1] alipay W10 恰一个无延迟任务，payload 三字段准确，与 PAID_API 状态变更事件的 xmin 相同；同键重放仍一个', async () => {
  const f = await s.setup();
  const a = s.admin(f);
  await withUnknownAdmin(a, async (h) => {
    const w = await unknownWithdrawal(a, h, await payee(a, h));
    const body = paidBody(a, w);
    const key = newKey();
    expect(await lateJobs(f)).toEqual([]);
    const response = await h.resolve(w.id, body, { key });
    await answer(response, 0);
    expect(await rowOf(a, w)).toMatchObject({
      status: 'PAID_API',
      manual_resolution: 'paid',
      channel_order_id: body.channel_order_id,
      paid_at: new Date(body.paid_at),
    });
    const job = await expectQueued(f, w.id);
    expect(await lateJobs(f)).toEqual([job]);
    // Before replay / any further write. The withdrawal UPDATE has a subtransaction xmin.
    // The PAID_API event is written outside that SAVEPOINT, on the same main transaction as
    // the job; the observer's couli_app role has table-level SELECT on app.event_log.
    const versions = await sql<{ job_xmin: string; event_xmin: string }>`
      SELECT j.xmin::text AS job_xmin, e.xmin::text AS event_xmin
      FROM pgboss.job j CROSS JOIN app.event_log e
      WHERE j.name = 'payout-recon' AND j.id = ${job.id}::uuid
        AND e.app_id = ${f.appId} AND e.name = 'wallet.withdrawal_changed'
        AND e.payload->'data'->>'withdrawal_id' = ${w.id}
        AND e.payload->'data'->>'status' = 'PAID_API'`.execute(f.h.observer);
    expect(versions.rows).toHaveLength(1);
    expect(versions.rows[0]!.job_xmin).toBe(versions.rows[0]!.event_xmin);
    const beforeReplay = await state(a);
    const replay = await h.resolve(w.id, body, { key });
    await answer(replay, 0);
    expect(replay.body).toBe(response.body);
    expect(await lateJobs(f)).toEqual([job]);
    expect(await state(a)).toEqual(beforeReplay);
  });
}, 120_000);

it('[AC-B2-09u#2] 银行卡与微信 W10 判成功不入复核队列，同场 alipay 成功才入队', async () => {
  const f = await s.setup();
  const a = s.admin(f);
  await withUnknownAdmin(a, async (h) => {
    for (const method of ['bank_card', 'wechat'] as const) {
      const w = await unknownWithdrawal(a, h, await payee(a, h), { seed: { method } });
      await answer(await h.resolve(w.id, paidBody(a, w)), 0);
      expect(await rowOf(a, w)).toMatchObject({ status: 'PAID_API', payout_channel: method });
      expect(await lateJobs(f)).toEqual([]);
    }
    // Positive control also makes the pre-implementation failure an enqueue assertion.
    const yes = await unknownWithdrawal(a, h, await payee(a, h));
    await answer(await h.resolve(yes.id, paidBody(a, yes)), 0);
    const job = await expectQueued(f, yes.id);
    expect(await lateJobs(f)).toEqual([job]);
  });
}, 120_000);

it.each([
  { ac: 3, reason: 'resolve_query_failed', field: 'resolution' },
  { ac: 4, reason: 'resolve_order_id_taken', field: 'channel_order_id' },
  { ac: 5, reason: 'resolve_paid_at_invalid', field: 'paid_at' },
])(
  '[AC-B2-09u#$ac] $reason 拒绝不入队，修正条件后同键判成功恰一个任务',
  async ({ reason, field }) => {
    const f = await s.setup();
    const a = s.admin(f);
    await withUnknownAdmin(a, async (h) => {
      const w = await unknownWithdrawal(a, h, await payee(a, h));
      const valid = paidBody(a, w);
      let body = valid;
      if (reason === 'resolve_query_failed') {
        await seedQueries(a, w, [['fail', 1]]);
      } else if (reason === 'resolve_order_id_taken') {
        const occupied = serial();
        await reviewing(a, h, await payee(a, h), { channel_order_id: occupied });
        body = { ...valid, channel_order_id: occupied };
      } else {
        body = { ...valid, paid_at: new Date(a.clock.now().getTime() - DAY - 1).toISOString() };
      }
      const key = newKey();
      const before = await state(a);
      await refused(await h.resolve(w.id, body, { key }), reason, field);
      expect(await lateJobs(f)).toEqual([]);
      expect(await state(a)).toEqual(before);
      expect((await rowOf(a, w)).status).toBe('PAYING');
      if (reason === 'resolve_query_failed') await seedQueries(a, w, [['unknown', 0]]);
      await answer(await h.resolve(w.id, valid, { key }), 0);
      const job = await expectQueued(f, w.id);
      expect(await lateJobs(f)).toEqual([job]);
    });
  },
  120_000,
);

it.each([
  { ac: 6, point: 'audit' as const },
  { ac: 7, point: 'voucher' as const },
  { ac: 8, point: 'tax_ytd' as const },
])(
  '[AC-B2-09u#$ac] $point 故障回滚不留任务；同键重试成功才入队',
  async ({ point }) => {
    const f = await s.setup();
    const a = s.admin(f);
    await withUnknownAdmin(a, async (h) => {
      const w = await unknownWithdrawal(a, h, await payee(a, h));
      const body = paidBody(a, w);
      const key = newKey();
      const before = await state(a);
      h.fault.point = point;
      const response = await h.resolve(w.id, body, { key });
      expect(h.fault.tripped, `必须实际触发 ${point}`).toBe(1);
      await answer(response, 50001);
      expect(await lateJobs(f)).toEqual([]);
      expect(await state(a)).toEqual(before);
      expect((await rowOf(a, w)).status).toBe('PAYING');
      await answer(await h.resolve(w.id, body, { key }), 0);
      const job = await expectQueued(f, w.id);
      expect(await lateJobs(f)).toEqual([job]);
    });
  },
  120_000,
);

it('[AC-B2-09u#9] 缺少已核实名 resolve_identity_missing 不留任务；实名完整的单正常入队', async () => {
  const f = await s.setup();
  const a = s.admin(f);
  await withUnknownAdmin(a, async (h) => {
    const missing = await unknownWithdrawal(a, h, await member(a, h));
    const before = await state(a);
    await refused(
      await h.resolve(missing.id, paidBody(a, missing)),
      'resolve_identity_missing',
      'withdrawal_id',
    );
    expect(await lateJobs(f)).toEqual([]);
    expect(await state(a)).toEqual(before);
    expect((await rowOf(a, missing)).status).toBe('PAYING');
    const yes = await unknownWithdrawal(a, h, await payee(a, h));
    await answer(await h.resolve(yes.id, paidBody(a, yes)), 0);
    const job = await expectQueued(f, yes.id);
    expect(await lateJobs(f)).toEqual([job]);
  });
}, 120_000);

// UTC date is 10-17; +08:00 accounting date is 10-18. Both are long before the admin clock.
// T precedes paid_at (W10 guard), and paid_at is far from the end-of-day grace window.
const HISTORICAL_PAID_AT = '2026-10-17T18:00:00.000Z';
const FIRST_TRANSFER_AT = '2026-10-17T02:00:00.000Z';

it.each([
  { ac: 11, evidence: 'missing' },
  { ac: 12, evidence: 'channel_order_id' },
])(
  '[AC-B2-09u#$ac] 贯通 W10 真实任务：历史账单已 succeeded，$evidence 分支准确复核',
  async ({ evidence }) => {
    const f = await s.setup();
    const a = s.admin(f);
    await withUnknownAdmin(a, async (h) => {
      const who = await payee(a, h);
      const w = await unknownWithdrawal(a, h, who, {
        age: a.clock.now().getTime() - Date.parse(FIRST_TRANSFER_AT),
        automatic: false,
      });
      const order = serial();
      const line = lineOf(
        { outBizNo: w.out_biz_no, net: 12_347n },
        evidence === 'channel_order_id'
          ? { outBizNo: null, channelOrderId: order }
          : { channelOrderId: serial() },
      );
      // Populate real stored bills and succeeded through the fake channel and real daily worker,
      // before W10 writes paid_at / channel_order_id. No daily run after this point.
      f.setBill(BILL_DATE, evidence === 'missing' ? [] : [line]);
      await f.runDay();
      expect(await runs(f)).toEqual([
        expect.objectContaining({ bill_date: BILL_DATE, status: 'succeeded' }),
      ]);
      expect(await rowOf(a, w)).toMatchObject({ status: 'PAYING', channel_order_id: null });
      const rows = await reconRows(f);
      if (evidence === 'missing') {
        expect(rows).toEqual([]);
      } else {
        expect(rows).toEqual([
          expect.objectContaining({
            out_biz_no: evidence === 'channel_order_id' ? null : w.out_biz_no,
            channel_order_id: line.channelOrderId,
            channel_status: 'SUCCESS',
            channel_amount_fen: 12_347n,
            bill_date: BILL_DATE,
          }),
        ]);
        if (evidence === 'out_biz_no') expect(line.channelOrderId).not.toBe(order);
      }
      // An unassigned channel-only bill may already have unknown_line: preserve that history.
      const priorDiffs = await diffs(f);
      if (evidence === 'channel_order_id') {
        expect(priorDiffs).toHaveLength(1);
        expect(priorDiffs[0]?.resolution).toMatchObject({ case: 'unknown_line' });
      } else {
        expect(priorDiffs).toEqual([]);
      }
      await answer(
        await h.resolve(
          w.id,
          paidBody(a, w, {
            channel_order_id: order,
            paid_at: HISTORICAL_PAID_AT,
          }),
        ),
        0,
      );
      expect(await rowOf(a, w)).toMatchObject({
        status: 'PAID_API',
        channel_order_id: order,
        paid_at: new Date(HISTORICAL_PAID_AT),
      });
      const job = await expectQueued(f, w.id);
      expect(await lateJobs(f)).toEqual([job]);
      expect(await diffsOf(f, [w.id])).toEqual([]);
      expect(await holdsOf(f, who.userId)).toEqual([]);
      expect(await diffs(f)).toEqual(priorDiffs);
      const before = {
        stored: await stored(f),
        books: await books(f),
        jobs: await jobs(f),
        calls: f.billCalls(),
        withdrawal: await rowOf(a, w),
      };
      // Consume the exact stored name and payload. Only this handler can create the new diff.
      await runLate(f, w.id, 0, {
        id: job.id,
        queue: job.name,
        name: job.data.name,
        payload: job.data.payload,
        attempt: 1,
      });
      const found = await diffsOf(f, [w.id]);
      if (evidence === 'missing') {
        expect(found).toHaveLength(1);
        expectDiff(f, found[0], {
          refType: 'withdrawal',
          refIds: [w.id],
          expectedFen: 12_347n,
          actualFen: 0n,
          periods: ['2026-10-18'],
        });
        expect(found[0]).toMatchObject({
          period: '2026-10-18',
          dedupe_key: `R2:alipay:missing:wd:${w.id}`,
          resolution: { case: 'paid_not_in_bill' },
        });
        expect(await diffs(f)).toEqual(found);
        await expectReconHold(f, who.userId, found[0]);
        expect(alertsAbout(f, [w.id])).toHaveLength(1);
      } else {
        expect(found).toEqual([]);
        expect(await diffs(f)).toEqual(priorDiffs);
        expect(await holdsOf(f, who.userId)).toEqual([]);
        expect(alertsAbout(f, [w.id])).toEqual([]);
      }
      expect(await stored(f)).toEqual(before.stored);
      expect(await books(f)).toEqual(before.books);
      expect(await jobs(f)).toEqual(before.jobs);
      expect(f.billCalls()).toEqual(before.calls);
      expect(await rowOf(a, w)).toEqual(before.withdrawal);
    });
  },
  120_000,
);

it('[AC-B2-09x#17] 承 [AC-B2-09u#10]：历史成功账单流水不符先拒，改为账单流水后成功并消费真实复核任务', async () => {
  const f = await s.setup();
  const a = s.admin(f);
  await withUnknownAdmin(a, async (h) => {
    const who = await payee(a, h);
    const w = await unknownWithdrawal(a, h, who, {
      age: a.clock.now().getTime() - Date.parse(FIRST_TRANSFER_AT),
      automatic: false,
    });
    const order = serial();
    const line = lineOf({ outBizNo: w.out_biz_no, net: 12_347n }, { channelOrderId: serial() });
    // Original #10: persist the historical bill through the real daily worker before W10.
    f.setBill(BILL_DATE, [line]);
    await f.runDay();
    expect(await runs(f)).toEqual([
      expect.objectContaining({ bill_date: BILL_DATE, status: 'succeeded' }),
    ]);
    expect(await rowOf(a, w)).toMatchObject({ status: 'PAYING', channel_order_id: null });
    const rows = await reconRows(f);
    expect(rows).toEqual([
      expect.objectContaining({
        out_biz_no: w.out_biz_no,
        channel_order_id: line.channelOrderId,
        channel_status: 'SUCCESS',
        channel_amount_fen: 12_347n,
        bill_date: BILL_DATE,
      }),
    ]);
    const priorDiffs = await diffs(f);
    expect(priorDiffs).toEqual([]);

    // New rule: a different human-entered serial is refused, with only a durable audit.
    const beforeRefusal = await state(a);
    await refused(
      await h.resolve(
        w.id,
        paidBody(a, w, {
          channel_order_id: order,
          paid_at: HISTORICAL_PAID_AT,
        }),
      ),
      'resolve_order_id_mismatch',
      'channel_order_id',
    );
    expect(await rowOf(a, w)).toMatchObject({ status: 'PAYING', channel_order_id: null });
    expect(await lateJobs(f)).toEqual([]);
    expect(await diffsOf(f, [w.id])).toEqual([]);
    expect(await holdsOf(f, who.userId)).toEqual([]);
    expect(await diffs(f)).toEqual(priorDiffs);
    const afterRefusal = await state(a);
    expect({ ...afterRefusal, audits: [] }).toEqual({ ...beforeRefusal, audits: [] });
    const appended = afterRefusal.audits.filter(
      (r) => !beforeRefusal.audits.some((b) => b.id === r.id),
    );
    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatchObject({
      app_id: a.appId,
      admin_id: h.executor.id,
      target: w.id,
      action: 'withdrawal_resolve_refused',
      after: { withdrawal_id: w.id, reason: 'resolve_order_id_mismatch' },
    });
    expect(
      afterRefusal.audits.filter((r) => r.target === w.id && r.action === 'withdrawal_resolve'),
    ).toEqual([]);

    // Original #10 success assertions, now using the bill's serial throughout.
    await answer(
      await h.resolve(
        w.id,
        paidBody(a, w, {
          channel_order_id: line.channelOrderId,
          paid_at: HISTORICAL_PAID_AT,
        }),
      ),
      0,
    );
    expect(await rowOf(a, w)).toMatchObject({
      status: 'PAID_API',
      channel_order_id: line.channelOrderId,
      paid_at: new Date(HISTORICAL_PAID_AT),
    });
    const job = await expectQueued(f, w.id);
    expect(await lateJobs(f)).toEqual([job]);
    expect(await diffsOf(f, [w.id])).toEqual([]);
    expect(await holdsOf(f, who.userId)).toEqual([]);
    expect(await diffs(f)).toEqual(priorDiffs);
    const before = {
      stored: await stored(f),
      books: await books(f),
      jobs: await jobs(f),
      calls: f.billCalls(),
      withdrawal: await rowOf(a, w),
    };
    // Original #10: consume the exact stored task name and payload, then compare every snapshot.
    await runLate(f, w.id, 0, {
      id: job.id,
      queue: job.name,
      name: job.data.name,
      payload: job.data.payload,
      attempt: 1,
    });
    const found = await diffsOf(f, [w.id]);
    expect(found).toEqual([]);
    expect(await diffs(f)).toEqual(priorDiffs);
    expect(await holdsOf(f, who.userId)).toEqual([]);
    expect(alertsAbout(f, [w.id])).toEqual([]);
    expect(await stored(f)).toEqual(before.stored);
    expect(await books(f)).toEqual(before.books);
    expect(await jobs(f)).toEqual(before.jobs);
    expect(f.billCalls()).toEqual(before.calls);
    expect(await rowOf(a, w)).toEqual(before.withdrawal);
  });
}, 120_000);
