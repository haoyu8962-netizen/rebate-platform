// BR-WDR-16 + BR-WDR-23: actual admin HTTP W8, real pg-boss transaction and real recon handler.
import { sql } from 'kysely';
import { expect, it } from 'vitest';
import {
  answer,
  approved,
  entryOf,
  expectItems,
  newKey,
  paid,
  payee,
  reviewing,
  skipped,
  state,
  withManualAdmin,
} from '../admin-manual-paid/manual-paid-harness.ts';
import {
  BILL_DATE,
  IN_DAY,
  alertsAbout,
  books,
  channelOrderId,
  diffs,
  diffsOf,
  expectDiff,
  expectReconHold,
  holdsOf,
  lineOf,
  runs,
} from '../recon-channel/kit.ts';
import { expectQueued, jobs, lateJobs, runLate, stored, suite } from './late-paid-harness.ts';

const s = suite(true);

it('[AC-B2-09t#1] alipay W8 恰一个无延迟任务，同事务 xmin 相等 [AC-B2-09t#31]；同 key 重放仍一个 [AC-B2-09t#5]', async () => {
  const f = await s.setup();
  const a = s.admin(f);
  await withManualAdmin(a, async (h) => {
    const w = await approved(a, h, await payee(a, h));
    const entry = entryOf(a, w);
    const key = newKey();
    await expectItems(await h.manualPaid([entry], { key }), [paid(w.id)]);
    const job = await expectQueued(f, w.id);
    // Read before replay or any other write: a send after COMMIT has a different xmin.
    const versions = await sql<{ job_xmin: string; withdrawal_xmin: string }>`
      SELECT j.xmin::text AS job_xmin, w.xmin::text AS withdrawal_xmin
      FROM pgboss.job j CROSS JOIN app.withdrawals w
      WHERE j.name = 'payout-recon' AND j.id = ${job.id}::uuid
        AND w.app_id = ${f.appId} AND w.id = ${w.id}::uuid`.execute(f.h.observer);
    expect(versions.rows).toHaveLength(1);
    expect(versions.rows[0]!.job_xmin).toBe(versions.rows[0]!.withdrawal_xmin);
    expect(await lateJobs(f)).toHaveLength(1);
    await expectItems(await h.manualPaid([entry], { key }), [paid(w.id)]);
    expect(await lateJobs(f)).toEqual([job]);
  });
}, 120_000);

it('[AC-B2-09t#32] 同一批两张 alipay W8 各入队一次，payload 各指向自己的提现单', async () => {
  const f = await s.setup();
  const a = s.admin(f);
  await withManualAdmin(a, async (h) => {
    const who = await payee(a, h);
    const first = await approved(a, h, who);
    const second = await approved(a, h, who);
    await expectItems(await h.manualPaid([entryOf(a, first), entryOf(a, second)]), [
      paid(first.id),
      paid(second.id),
    ]);
    const firstJob = await expectQueued(f, first.id);
    const secondJob = await expectQueued(f, second.id);
    expect(firstJob.id).not.toBe(secondJob.id);
    expect(await lateJobs(f)).toHaveLength(2);
  });
}, 120_000);

it('[AC-B2-09t#33] 消费 W8 真实任务，当前轮 active 时仍独立入队 round 1、2，各延迟一小时', async () => {
  const f = await s.setup();
  const a = s.admin(f);
  await withManualAdmin(a, async (h) => {
    const who = await payee(a, h);
    const w = await approved(a, h, who);
    await expectItems(await h.manualPaid([entryOf(a, w)]), [paid(w.id)]);
    let current = await expectQueued(f, w.id);
    expect(await runs(f)).toEqual([]);
    for (const nextRound of [1, 2]) {
      // Retain the active row while handling it: deleting it would hide a reused singletonKey.
      const claimed = await sql<{ id: string }>`UPDATE pgboss.job
        SET state = 'active', started_on = now()
        WHERE name = 'payout-recon' AND id = ${current.id}::uuid AND state = 'created'
        RETURNING id::text`.execute(f.h.observer);
      expect(claimed.rows).toEqual([{ id: current.id }]);
      await runLate(f, w.id, nextRound - 1, {
        id: current.id,
        queue: current.name,
        name: current.data.name,
        payload: current.data.payload,
        attempt: 1,
      });
      const all = await lateJobs(f);
      const next = all.filter((j) => j.data.payload['round'] === nextRound);
      expect(next).toHaveLength(1);
      expect(all).toHaveLength(nextRound + 1);
      expect(next[0]!.id).not.toBe(current.id);
      expect(next[0]!.data).toEqual({
        name: 'late_paid_check',
        payload: { app_id: f.appId, withdrawal_id: w.id, round: nextRound },
      });
      expect(
        Math.abs(next[0]!.start_after.getTime() - next[0]!.created_on.getTime() - 3_600_000),
      ).toBeLessThan(1000);
      expect(await diffsOf(f, [w.id])).toEqual([]);
      expect(await holdsOf(f, who.userId)).toEqual([]);
      await sql`UPDATE pgboss.job SET state = 'completed', completed_on = now()
        WHERE name = 'payout-recon' AND id = ${current.id}::uuid`.execute(f.h.observer);
      current = next[0]!;
      f.clock.set(new Date(f.clock.now().getTime() + 3_600_000));
    }
  });
}, 120_000);

it('[AC-B2-09t#2] 银行卡不入队；同批 alipay 成功照常入队，未审核条目不入队 [AC-B2-09t#3]', async () => {
  const f = await s.setup();
  const a = s.admin(f);
  await withManualAdmin(a, async (h) => {
    const who = await payee(a, h);
    const bank = await approved(a, h, who, { method: 'bank_card' });
    const denied = await reviewing(a, h, who);
    const yes = await approved(a, h, who);
    await expectItems(await h.manualPaid([entryOf(a, bank), entryOf(a, denied), entryOf(a, yes)]), [
      paid(bank.id),
      skipped(denied.id, 'not_approved'),
      paid(yes.id),
    ]);
    await expectQueued(f, yes.id);
    expect((await lateJobs(f)).map((j) => j.data.payload['withdrawal_id'])).toEqual([yes.id]);
  });
}, 120_000);

it('[AC-B2-09t#4] audit、voucher、tax_ytd 逐项故障回滚不留任务；恢复后同 key 重试恰一个', async () => {
  for (const point of ['audit', 'voucher', 'tax_ytd'] as const) {
    const f = await s.setup();
    const a = s.admin(f);
    await withManualAdmin(a, async (h) => {
      const w = await approved(a, h, await payee(a, h));
      const entry = entryOf(a, w);
      const key = newKey();
      const before = await state(a);
      h.fault.point = point;
      await answer(await h.manualPaid([entry], { key }), 50001);
      expect(h.fault.tripped).toBe(1);
      expect(await lateJobs(f)).toEqual([]);
      expect(await state(a)).toEqual(before);
      await expectItems(await h.manualPaid([entry], { key }), [paid(w.id)]);
      await expectQueued(f, w.id);
      expect(await lateJobs(f)).toHaveLength(1);
    });
  }
}, 180_000);

it('[AC-B2-09t#6] 贯通：原样消费 W8 的真实队列任务，已 succeeded 无账单行，差错确实由该任务创建', async () => {
  const f = await s.setup();
  const a = s.admin(f);
  f.setBill(BILL_DATE, []);
  await f.runDay();
  expect((await runs(f)).find((r) => r.bill_date === BILL_DATE)?.status).toBe('succeeded');
  await withManualAdmin(a, async (h) => {
    const who = await payee(a, h);
    const w = await approved(a, h, who, { created_at: new Date('2026-10-17T02:00:00Z') });
    await expectItems(await h.manualPaid([entryOf(a, w, { paid_at: IN_DAY.toISOString() })]), [
      paid(w.id),
    ]);
    const job = await expectQueued(f, w.id);
    expect(await diffsOf(f, [w.id])).toEqual([]);
    expect(await holdsOf(f, who.userId)).toEqual([]);
    const before = {
      stored: await stored(f),
      books: await books(f),
      calls: f.billCalls(),
      jobs: await jobs(f),
    };
    // No daily run between the empty baseline and these assertions; name/payload are untouched.
    await runLate(f, w.id, 0, {
      id: job.id,
      queue: job.name,
      name: job.data.name,
      payload: job.data.payload,
      attempt: 1,
    });
    const found = await diffsOf(f, [w.id]);
    expect(found).toHaveLength(1);
    expectDiff(f, found[0], {
      refType: 'withdrawal',
      refIds: [w.id],
      expectedFen: 12_347n,
      actualFen: 0n,
    });
    expect(found[0]).toMatchObject({
      dedupe_key: `R2:alipay:missing:wd:${w.id}`,
      resolution: { case: 'paid_not_in_bill' },
    });
    await expectReconHold(f, who.userId, found[0]);
    expect(alertsAbout(f, [w.id])).toHaveLength(1);
    expect(await stored(f)).toEqual(before.stored);
    expect(await books(f)).toEqual(before.books);
    expect(f.billCalls()).toEqual(before.calls);
    expect(await jobs(f)).toEqual(before.jobs);
  });
}, 120_000);

it('[AC-B2-09t#26] 真实 W8 补录历史 unknown_line 的流水，消费真实任务后旧差错原样保留且不冻结', async () => {
  const f = await s.setup();
  const a = s.admin(f);
  const order = channelOrderId();
  f.setBill(BILL_DATE, [
    lineOf({ outBizNo: 'manual', net: 12_347n }, { outBizNo: null, channelOrderId: order }),
  ]);
  await f.runDay();
  const before = await diffs(f);
  expect(before).toHaveLength(1);
  expect(before[0]?.resolution).toMatchObject({ case: 'unknown_line' });
  await withManualAdmin(a, async (h) => {
    const who = await payee(a, h);
    const w = await approved(a, h, who, { created_at: new Date('2026-10-17T02:00:00Z') });
    await expectItems(
      await h.manualPaid([
        entryOf(a, w, { channel_order_id: order, paid_at: IN_DAY.toISOString() }),
      ]),
      [paid(w.id)],
    );
    const job = await expectQueued(f, w.id);
    await runLate(f, w.id, 0, {
      id: job.id,
      queue: job.name,
      name: job.data.name,
      payload: job.data.payload,
      attempt: 1,
    });
    expect(await diffs(f)).toEqual(before);
    expect(await holdsOf(f, who.userId)).toEqual([]);
  });
}, 120_000);
