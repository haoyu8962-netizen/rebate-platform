// BR-WDR-23 / BR-WDR-16, D10-632: late_paid_check reads stored bills, never reruns R2.
import { randomUUID } from 'node:crypto';
import { PostgresQueryCompiler, sql, type KyselyPlugin } from 'kysely';
import { expect, it } from 'vitest';
import {
  BILL_DATE,
  IN_DAY,
  LINE_FAIL,
  LINE_SUCCESS,
  LINE_UNKNOWN,
  NEAR_DAY_END,
  NEXT_BILL_DATE,
  NEXT_RUN,
  alertsAbout,
  books,
  channelOrderId,
  diffs,
  diffsOf,
  expectDiff,
  expectReconHold,
  holdsOf,
  lineOf,
  reconRows,
  runs,
  type ReconFixture,
} from '../recon-channel/kit.ts';
import {
  compete,
  expectClean,
  expectMissing,
  expectRetry,
  incomplete,
  jobs,
  lateJob,
  lateJobs,
  runLate,
  stored,
  suite,
} from './late-paid-harness.ts';

const s = suite();

async function emptyDay(f: ReconFixture, day = BILL_DATE) {
  f.setBill(day, []);
  await f.runDay(day);
  expect((await runs(f)).find((r) => r.bill_date === day)?.status).toBe('succeeded');
}

it('[AC-B2-09t#11] 已跑账单无成功行：一张 missing 差错、永久冻结、告警，账本与已存账单完全不动', async () => {
  const f = await s.setup();
  await emptyDay(f);
  const w = await f.seedManual(IN_DAY, { net: 12_347n });
  const before = {
    stored: await stored(f),
    books: await books(f),
    jobs: await jobs(f),
    calls: f.billCalls(),
  };
  expect(await diffsOf(f, [w.id])).toEqual([]);
  await runLate(f, w.id);
  await expectMissing(f, w);
  expect(alertsAbout(f, [w.id])).toHaveLength(1);
  expect(await stored(f)).toEqual(before.stored);
  expect(await books(f)).toEqual(before.books);
  expect(await jobs(f)).toEqual(before.jobs);
  expect(f.billCalls()).toEqual(before.calls);
}, 60_000);

it('[AC-B2-09t#7] 先落 unknown_line 后补同流水号：核上，不新增或关闭旧差错，不冻结', async () => {
  const f = await s.setup();
  const order = channelOrderId();
  f.setBill(BILL_DATE, [
    lineOf({ outBizNo: 'unrelated', net: 12_347n }, { outBizNo: null, channelOrderId: order }),
  ]);
  await f.runDay();
  const prior = await diffs(f);
  expect(prior).toHaveLength(1);
  expect(prior[0]).toMatchObject({ status: 'open', resolution: { case: 'unknown_line' } });
  const w = await f.seedManual(IN_DAY, { net: 12_347n });
  await sql`UPDATE app.withdrawals SET channel_order_id = ${order}
    WHERE app_id = ${f.appId} AND id = ${w.id}`.execute(f.h.db);
  const before = {
    stored: await stored(f),
    books: await books(f),
    jobs: await jobs(f),
    calls: f.billCalls(),
  };
  f.clock.set(new Date(f.clock.now().getTime() + 3_600_000));
  await runLate(f, w.id);
  await expectClean(f, w);
  expect(await diffs(f)).toEqual(prior);
  expect(await stored(f)).toEqual(before.stored);
  expect(await books(f)).toEqual(before.books);
  expect(await jobs(f)).toEqual(before.jobs);
  expect(f.billCalls()).toEqual(before.calls);
}, 60_000);

it('[AC-B2-09t#8] paid_at 倒填 D，D−3 的成功行仍能核上；多个成功金额中任一等于 net 即结束', async () => {
  const f = await s.setup();
  const order = channelOrderId();
  f.setBill('2026-10-15', [
    lineOf(
      { outBizNo: 'old', net: 12_347n },
      { outBizNo: null, channelOrderId: order, bookedAt: '2026-10-15T10:00:00+08:00' },
    ),
  ]);
  await f.runDay('2026-10-15');
  f.setBill('2026-10-16', [
    lineOf(
      { outBizNo: 'old', net: 12_346n },
      { outBizNo: null, channelOrderId: order, bookedAt: '2026-10-16T10:00:00+08:00' },
    ),
  ]);
  await f.runDay('2026-10-16');
  await emptyDay(f);
  const w = await f.seedManual(IN_DAY, { net: 12_347n });
  await sql`UPDATE app.withdrawals SET channel_order_id = ${order} WHERE id = ${w.id} AND app_id = ${f.appId}`.execute(
    f.h.db,
  );
  const before = await diffs(f);
  await runLate(f, w.id);
  await expectClean(f, w);
  expect(await diffs(f)).toEqual(before);
}, 60_000);

it('[AC-B2-09t#9] PAID_API 仅 out_biz_no 命中与仅 channel_order_id 命中均核上；无下载、查询或次日入队 [AC-B2-09t#10]', async () => {
  for (const key of ['out_biz_no', 'channel_order_id']) {
    const f = await s.setup();
    const order = channelOrderId();
    if (key === 'channel_order_id') {
      // Persist the unknown line before the withdrawal exists: R2 must not fill out_biz_no.
      f.setBill(BILL_DATE, [
        lineOf({ outBizNo: 'unused', net: 1000n }, { outBizNo: null, channelOrderId: order }),
      ]);
      await f.runDay();
    }
    const w = await f.seedPaid(IN_DAY);
    if (key === 'channel_order_id') {
      await sql`UPDATE app.withdrawals SET channel_order_id = ${order}
        WHERE app_id = ${f.appId} AND id = ${w.id}`.execute(f.h.db);
    } else {
      f.setBill(BILL_DATE, [lineOf(w, { channelOrderId: order })]);
      await f.runDay();
      expect(order).not.toBe(w.channelOrderId);
    }
    const rows = await reconRows(f);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      out_biz_no: key === 'channel_order_id' ? null : w.outBizNo,
      channel_order_id: order,
    });
    const priorDiffs = await diffs(f);
    const before = {
      stored: await stored(f),
      jobs: await jobs(f),
      calls: f.billCalls(),
      books: await books(f),
    };
    f.clock.set(new Date(f.clock.now().getTime() + 3_600_000));
    await runLate(f, w.id);
    await expectClean(f, w);
    expect(await diffs(f)).toEqual(priorDiffs);
    expect(await stored(f)).toEqual(before.stored);
    expect(await jobs(f)).toEqual(before.jobs);
    expect(f.billCalls()).toEqual(before.calls);
    expect(await books(f)).toEqual(before.books);
  }
}, 60_000);

it('[AC-B2-09t#12] 金额多一分与少一分：按 net_fen，差错 period 是成功行的账单日', async () => {
  for (const actual of [12_346n, 12_348n]) {
    const f = await s.setup();
    const order = channelOrderId();
    f.setBill('2026-10-15', [
      lineOf(
        { outBizNo: 'old', net: actual },
        { outBizNo: null, channelOrderId: order, bookedAt: '2026-10-15T10:00:00+08:00' },
      ),
    ]);
    await f.runDay('2026-10-15');
    const w = await f.seedManual(IN_DAY, { net: 12_347n });
    expect(w.amount).toBe(12_847n);
    await sql`UPDATE app.withdrawals SET channel_order_id = ${order} WHERE id = ${w.id} AND app_id = ${f.appId}`.execute(
      f.h.db,
    );
    const before = await books(f);
    const job = lateJob(f, w.id);
    await runLate(f, w.id, 0, job);
    const found = await diffsOf(f, [w.id]);
    expect(found).toHaveLength(1);
    expectDiff(f, found[0], {
      refType: 'withdrawal',
      refIds: [w.id],
      expectedFen: 12_347n,
      actualFen: actual,
      periods: ['2026-10-15'],
    });
    expect(found[0]?.resolution).toMatchObject({ case: 'amount_mismatch' });
    await expectReconHold(f, w.userId, found[0]);
    expect(alertsAbout(f, [w.id]).length).toBeGreaterThan(0);
    expect(await books(f)).toEqual(before);
    const holds = await holdsOf(f, w.userId);
    await runLate(f, w.id, 0, { ...job, attempt: 2 });
    expect(await diffsOf(f, [w.id])).toEqual(found);
    expect(await holdsOf(f, w.userId)).toEqual(holds);
    await expectReconHold(f, w.userId, found[0]);
  }
}, 60_000);

it('[AC-B2-09t#13] 单不存在时 LINE_FAIL、LINE_UNKNOWN 不落行；补录后已跑完且无行报 missing', async () => {
  for (const status of [LINE_FAIL, LINE_UNKNOWN]) {
    const f = await s.setup();
    const order = channelOrderId();
    f.setBill(BILL_DATE, [
      lineOf(
        { outBizNo: 'unknown', net: 1000n },
        { outBizNo: null, channelOrderId: order, status },
      ),
    ]);
    await f.runDay();
    expect(await reconRows(f)).toEqual([]);
    const w = await f.seedManual(IN_DAY);
    await sql`UPDATE app.withdrawals SET channel_order_id = ${order} WHERE id = ${w.id} AND app_id = ${f.appId}`.execute(
      f.h.db,
    );
    await runLate(f, w.id);
    await expectMissing(f, w);
  }
}, 60_000);

it('[AC-B2-09t#14] 手动单的业务单号命中另一成功流水：duplicate_line 优先，即使同时有本流水成功', async () => {
  for (const ownLine of [false, true]) {
    const f = await s.setup();
    const w = await f.seedPaid(IN_DAY, { net: 12_347n });
    const stray = lineOf(w, { channelOrderId: channelOrderId() });
    f.setBill(BILL_DATE, [stray]);
    await f.runDay();
    if (ownLine) {
      f.setBill('2026-10-17', [lineOf(w)]);
      await f.runDay('2026-10-17');
    }
    // Fixture represents a later W8 snapshot; don't touch needs_manual (couli_payout only).
    await sql`UPDATE app.withdrawals SET status = 'PAID_MANUAL', manual_entry_by = ${randomUUID()},
      manual_confirm_by = ${randomUUID()} WHERE id = ${w.id} AND app_id = ${f.appId}`.execute(
      f.h.db,
    );
    expect(await diffs(f)).toEqual([]);
    const job = lateJob(f, w.id);
    await runLate(f, w.id, 0, job);
    const found = await diffs(f);
    expect(found).toHaveLength(1);
    expectDiff(f, found[0], {
      refType: 'channel_order_id',
      refIds: [stray.channelOrderId],
      expectedFen: 0n,
      actualFen: 12_347n,
    });
    expect(found[0]?.resolution).toMatchObject({ case: 'duplicate_line', withdrawal_id: w.id });
    await expectReconHold(f, w.userId, found[0]);
    const holds = await holdsOf(f, w.userId);
    await runLate(f, w.id, 0, { ...job, attempt: 2 });
    expect(await diffs(f)).toEqual(found);
    expect(await holdsOf(f, w.userId)).toEqual(holds);
    await expectReconHold(f, w.userId, found[0]);
  }
}, 60_000);

it('[AC-B2-09t#15] D 未运行、failed、partial 各自等一小时，真实 R2 跑成后才判', async () => {
  for (const status of ['absent', 'failed', 'partial'] as const) {
    const f = await s.setup();
    if (status !== 'absent') await incomplete(f, status);
    const w = await f.seedManual(IN_DAY);
    const before = await stored(f);
    await runLate(f, w.id, 7);
    await expectRetry(f, w, 7);
    expect(await stored(f)).toEqual(before);
    // Move paid_at outside D only while running the formerly incomplete bill, so R2 does
    // not preempt the worker's missing judgment. This is fixture setup, not a business write.
    await sql`UPDATE app.withdrawals SET paid_at = ${new Date('2026-10-20T02:00:00Z')}
      WHERE app_id = ${f.appId} AND id = ${w.id}`.execute(f.h.db);
    await emptyDay(f);
    await sql`UPDATE app.withdrawals SET paid_at = ${IN_DAY} WHERE app_id = ${f.appId} AND id = ${w.id}`.execute(
      f.h.db,
    );
    await expectClean(f, w);
    const next = (await lateJobs(f))[0]!;
    f.clock.set(new Date(f.clock.now().getTime() + 3_600_000));
    await runLate(f, w.id, 8, {
      id: next.id,
      queue: next.name,
      name: next.data.name,
      payload: next.data.payload,
      attempt: 1,
    });
    await expectMissing(f, w);
  }
}, 60_000);

it('[AC-B2-09t#16] round 94 入队 95；round 95 只告警点名单号，不下结论、不再排队', async () => {
  for (const round of [94, 95]) {
    const f = await s.setup();
    const w = await f.seedPaid(IN_DAY);
    await runLate(f, w.id, round);
    if (round === 94) await expectRetry(f, w, 94);
    else {
      expect(await lateJobs(f)).toEqual([]);
      expect(alertsAbout(f, [w.id]).length).toBeGreaterThan(0);
      await expectClean(f, w);
    }
  }
}, 60_000);

it('[AC-B2-09t#17] 日界含恰好十分钟：D+1 未跑要等，早一毫秒不等，两天无行才差错，次日有行核上', async () => {
  for (const scenario of ['wait', 'early', 'missing', 'next_success']) {
    const f = await s.setup();
    await emptyDay(f);
    const order = channelOrderId();
    if (scenario === 'missing' || scenario === 'next_success') {
      f.clock.set(NEXT_RUN);
      f.setBill(
        NEXT_BILL_DATE,
        scenario === 'missing'
          ? []
          : [
              lineOf(
                { outBizNo: 'next', net: 1000n },
                { outBizNo: null, channelOrderId: order, bookedAt: '2026-10-19T00:00:01+08:00' },
              ),
            ],
      );
      await f.runDay(NEXT_BILL_DATE);
    }
    const paidAt = new Date(
      scenario === 'early' ? '2026-10-18T15:49:59.999Z' : '2026-10-18T15:50:00.000Z',
    );
    const w = await f.seedManual(paidAt);
    await sql`UPDATE app.withdrawals SET channel_order_id = ${order} WHERE id = ${w.id} AND app_id = ${f.appId}`.execute(
      f.h.db,
    );
    await runLate(f, w.id);
    if (scenario === 'wait') await expectRetry(f, w, 0);
    else if (scenario === 'next_success') await expectClean(f, w);
    else await expectMissing(f, w);
  }
}, 60_000);

it('[AC-B2-09t#18] R2 先判和任务先判，两种顺序都复用 missing 去重键，仅一张差错和一次冻结', async () => {
  for (const first of ['R2', 'late']) {
    const f = await s.setup();
    if (first === 'late') await emptyDay(f);
    const w = await f.seedManual(IN_DAY);
    f.setBill(BILL_DATE, []);
    if (first === 'R2') await f.runDay();
    await runLate(f, w.id);
    if (first === 'late') await f.runDay();
    await expectMissing(f, w);
  }
}, 60_000);

it('[AC-B2-09t#19] 同一任务重投两次，差错冻结各一且不重复告警，不改终态账本', async () => {
  const f = await s.setup();
  await emptyDay(f);
  const w = await f.seedPaid(IN_DAY);
  const job = lateJob(f, w.id);
  const before = await books(f);
  await runLate(f, w.id, 0, job);
  const first = await diffs(f);
  const hold = await holdsOf(f, w.userId);
  await runLate(f, w.id, 0, { ...job, attempt: 2 });
  await expectMissing(f, w);
  expect(await diffs(f)).toEqual(first);
  expect(await holdsOf(f, w.userId)).toEqual(hold);
  expect(alertsAbout(f, [w.id])).toHaveLength(1);
  expect(await books(f)).toEqual(before);
}, 60_000);

it('[AC-B2-09t#20] 外部事务持有同 dedupe_key，PG 证明 worker 等待；提交后沿用差错且不加冻结', async () => {
  const f = await s.setup();
  await emptyDay(f);
  const w = await f.seedManual(IN_DAY);
  await compete(f, w);
}, 60_000);

it('[AC-B2-09t#21] 别的 app 的成功流水和 succeeded 都无效；本 app 才能结束等待，差错冻结不串租户', async () => {
  for (const ownDaySucceeded of [false, true]) {
    const f = await s.setup();
    const other = await s.setup();
    if (ownDaySucceeded) await emptyDay(f);
    const w = await f.seedManual(IN_DAY);
    other.setBill(BILL_DATE, [lineOf(w, { outBizNo: null })]);
    await other.runDay();
    const otherBefore = {
      stored: await stored(other),
      diffs: await diffs(other),
      books: await books(other),
    };
    await expectClean(f, w);
    await runLate(f, w.id);
    if (ownDaySucceeded) await expectMissing(f, w);
    else await expectRetry(f, w, 0);
    expect(await stored(other)).toEqual(otherBefore.stored);
    expect(await diffs(other)).toEqual(otherBefore.diffs);
    expect(await books(other)).toEqual(otherBefore.books);
    expect(await holdsOf(other, w.userId)).toEqual([]);
  }
}, 60_000);

it('[AC-B2-09t#25] 重读后不存在、非 PAID_*、银行卡都结束，不动账本、不排任务、不生差错冻结', async () => {
  const f = await s.setup();
  await emptyDay(f);
  const unpaid = await f.seedWithdrawal({ status: 'APPROVED' });
  const bank = await f.seedWithdrawal({ status: 'PAID_API', channel: 'bank_card' });
  const before = { books: await books(f), stored: await stored(f), jobs: await jobs(f) };
  for (const id of [randomUUID(), unpaid.id, bank.id]) await runLate(f, id);
  expect(await books(f)).toEqual(before.books);
  expect(await stored(f)).toEqual(before.stored);
  expect(await jobs(f)).toEqual(before.jobs);
  expect(await diffs(f)).toEqual([]);
  expect(await holdsOf(f, unpaid.userId)).toEqual([]);
}, 60_000);

it('[AC-B2-09t#27] paid_at 按 +08:00 取账单日：UTC 10-18 的付款须等 10-19，跑成后 period 为 10-19', async () => {
  const f = await s.setup();
  await emptyDay(f);
  const paidAt = new Date('2026-10-18T16:30:00Z');
  const w = await f.seedManual(paidAt);
  expect((await runs(f)).map((r) => r.bill_date)).toEqual([BILL_DATE]);
  await runLate(f, w.id);
  await expectRetry(f, w, 0);
  // Keep daily R2 from deciding first: only the late task should create this diff.
  await sql`UPDATE app.withdrawals SET paid_at = ${new Date('2026-10-20T02:00:00Z')}
    WHERE app_id = ${f.appId} AND id = ${w.id}`.execute(f.h.db);
  f.clock.set(NEXT_RUN);
  await emptyDay(f, NEXT_BILL_DATE);
  await sql`UPDATE app.withdrawals SET paid_at = ${paidAt}
    WHERE app_id = ${f.appId} AND id = ${w.id}`.execute(f.h.db);
  await expectClean(f, w);
  const next = (await lateJobs(f))[0]!;
  await runLate(f, w.id, 1, {
    id: next.id,
    queue: next.name,
    name: next.data.name,
    payload: next.data.payload,
    attempt: 1,
  });
  const found = await diffsOf(f, [w.id]);
  expect(found).toHaveLength(1);
  expectDiff(f, found[0], {
    refType: 'withdrawal',
    refIds: [w.id],
    expectedFen: w.net,
    actualFen: 0n,
    periods: ['2026-10-19'],
  });
  expect(found[0]).toMatchObject({
    dedupe_key: `R2:alipay:missing:wd:${w.id}`,
    resolution: { case: 'paid_not_in_bill' },
  });
  await expectReconHold(f, w.userId, found[0]);
}, 60_000);

it('[AC-B2-09t#28] 已存非成功 diff 行沿用 paid_line_not_success，不再产生金额或漏单差错及冻结', async () => {
  for (const status of [LINE_FAIL, LINE_UNKNOWN]) {
    const f = await s.setup();
    const w = await f.seedManual(IN_DAY, { net: 12_347n });
    f.setBill(BILL_DATE, [lineOf(w, { outBizNo: null, amountFen: 12_346n, status })]);
    await f.runDay();
    const rows = await reconRows(f);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      channel_order_id: w.channelOrderId,
      channel_status: status,
      channel_amount_fen: 12_346n,
      our_amount_fen: w.net,
      result: 'diff',
    });
    const before = await diffs(f);
    expect(before).toHaveLength(1);
    expectDiff(f, before[0], {
      refType: 'withdrawal',
      refIds: [w.id],
      expectedFen: w.net,
      actualFen: 0n,
    });
    expect(before[0]?.resolution).toMatchObject({ case: 'paid_line_not_success' });
    await expectReconHold(f, w.userId, before[0]);
    const holds = await holdsOf(f, w.userId);
    f.clock.set(new Date(f.clock.now().getTime() + 3_600_000));
    await runLate(f, w.id);
    expect(await diffs(f)).toEqual(before);
    expect(await holdsOf(f, w.userId)).toEqual(holds);
    expect(await lateJobs(f)).toEqual([]);
  }
}, 60_000);

it('[AC-B2-09t#29] R2 先判 amount_mismatch，迟到复核复用同一张差错和同一条冻结', async () => {
  const f = await s.setup();
  const w = await f.seedManual(IN_DAY, { net: 12_347n });
  f.setBill(BILL_DATE, [lineOf(w, { outBizNo: null, amountFen: 12_348n })]);
  await f.runDay();
  const before = await diffs(f);
  expect(before).toHaveLength(1);
  expectDiff(f, before[0], {
    refType: 'withdrawal',
    refIds: [w.id],
    expectedFen: w.net,
    actualFen: 12_348n,
  });
  expect(before[0]?.resolution).toMatchObject({ case: 'amount_mismatch' });
  await expectReconHold(f, w.userId, before[0]);
  const holds = await holdsOf(f, w.userId);
  await runLate(f, w.id);
  expect(await diffs(f)).toEqual(before);
  expect(await holdsOf(f, w.userId)).toEqual(holds);
}, 60_000);

it('[AC-B2-09t#30] 日界窗口内 D 为 partial 或 failed，即使 D+1 succeeded 仍须等待', async () => {
  for (const status of ['partial', 'failed'] as const) {
    const f = await s.setup();
    await incomplete(f, status);
    f.clock.set(NEXT_RUN);
    await emptyDay(f, NEXT_BILL_DATE);
    const w = await f.seedManual(new Date('2026-10-18T15:50:00.000Z'));
    expect(await runs(f)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ bill_date: BILL_DATE, status }),
        expect.objectContaining({ bill_date: NEXT_BILL_DATE, status: 'succeeded' }),
      ]),
    );
    await runLate(f, w.id);
    await expectRetry(f, w, 0);
  }
}, 60_000);

it('[AC-B2-09t#34] R2 在复核的两次读取之间提交成功行，不得用旧空行和新 succeeded 误报漏单', async () => {
  const f = await s.setup();
  const w = await f.seedManual(IN_DAY, { net: 12_347n });
  f.setBill(BILL_DATE, [lineOf(w, { outBizNo: null })]);
  expect(await runs(f)).toEqual([]);
  expect(await reconRows(f)).toEqual([]);
  expect(await diffs(f)).toEqual([]);
  await expectClean(f, w);

  const compiler = new PostgresQueryCompiler();
  let firstQuery: object | undefined;
  let triggered = 0;
  const plugin: KyselyPlugin = {
    transformQuery({ node, queryId }) {
      const compiled = compiler.compileQuery(node, queryId);
      if (firstQuery === undefined && /\b(recon_channel|payout_recon_runs)\b/.test(compiled.sql)) {
        firstQuery = queryId;
      }
      return node;
    },
    async transformResult({ result, queryId }) {
      if (queryId === firstQuery && triggered === 0) {
        triggered += 1;
        // The first read has executed, but its result has not reached the worker yet.
        // Commit real R2 through the original h.db, without this plugin, before resuming.
        await f.runDay();
      }
      return result;
    },
  };
  await expect(
    f.reconJob({ db: f.h.db.withPlugin(plugin) })(lateJob(f, w.id)),
  ).resolves.toBeUndefined();
  expect(triggered).toBe(1);
  expect(await runs(f)).toEqual([
    expect.objectContaining({ bill_date: BILL_DATE, status: 'succeeded', matched: 1, diffs: 0 }),
  ]);
  expect(await reconRows(f)).toEqual([
    expect.objectContaining({
      bill_date: BILL_DATE,
      channel_order_id: w.channelOrderId,
      channel_status: LINE_SUCCESS,
      channel_amount_fen: w.net,
      result: 'matched',
    }),
  ]);
  expect(await diffs(f)).toEqual([]);
  await expectClean(f, w);
}, 60_000);

it('[AC-B2-09t#35] 日界已有 paid_line_not_success 时优先结束，D+1 未跑也不再入队或增加差错冻结', async () => {
  const f = await s.setup();
  const w = await f.seedManual(NEAR_DAY_END, { net: 12_347n });
  f.setBill(BILL_DATE, [lineOf(w, { outBizNo: null, amountFen: 12_346n, status: LINE_FAIL })]);
  await f.runDay();
  expect(await runs(f)).toEqual([
    expect.objectContaining({ bill_date: BILL_DATE, status: 'succeeded' }),
  ]);
  expect(await reconRows(f)).toEqual([
    expect.objectContaining({
      bill_date: BILL_DATE,
      channel_order_id: w.channelOrderId,
      channel_status: LINE_FAIL,
      channel_amount_fen: 12_346n,
      our_amount_fen: w.net,
      result: 'diff',
    }),
  ]);
  const before = await diffs(f);
  expect(before).toHaveLength(1);
  expectDiff(f, before[0], {
    refType: 'withdrawal',
    refIds: [w.id],
    expectedFen: w.net,
    actualFen: 0n,
    periods: [BILL_DATE],
  });
  expect(before[0]?.resolution).toMatchObject({ case: 'paid_line_not_success' });
  await expectReconHold(f, w.userId, before[0]);
  const holds = await holdsOf(f, w.userId);
  const queued = await jobs(f);
  f.send.mockClear();
  f.clock.set(new Date(f.clock.now().getTime() + 3_600_000));
  await runLate(f, w.id);
  expect(f.send).not.toHaveBeenCalled();
  expect(await lateJobs(f)).toEqual([]);
  expect(await jobs(f)).toEqual(queued);
  expect(await diffs(f)).toEqual(before);
  expect(await holdsOf(f, w.userId)).toEqual(holds);
  await expectReconHold(f, w.userId, before[0]);
}, 60_000);
