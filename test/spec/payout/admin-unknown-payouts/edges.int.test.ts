// B2-09s r1 additions only (SPEC_REF 6f50a051): BR-WDR-09/14/15/17/33, task §11.
// Real admin entry, query job, role-separated PG, ledger and queue. All channel data is synthetic.
// Existing cases #1–26 and their helpers are unchanged. No provider transport is used.
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { expect, it, vi } from 'vitest';
import { lockUsersForUpdate } from '../../../../apps/api/src/modules/identity/ports/lock-users.ts';
import type { QueryResult } from '../../../../apps/api/src/modules/payout/domain/channel-result.ts';
import type { PayoutChannel } from '../../../../apps/api/src/modules/payout/infra/channels/payout-channel.ts';
import { createQueryJob } from '../../../../apps/api/src/modules/payout/jobs/query-job.ts';
import { configPort } from '../proven-success/kit.ts';
import { holdRow } from './lock-harness.ts';
import {
  AFTER_FREEZE,
  DAY,
  PROOF,
  answer,
  attemptsOf,
  balanceOf,
  bill,
  entries,
  fixture,
  frozenMismatches,
  landThroughChannel,
  lowAndHigh,
  paidBody,
  payee,
  platformLine,
  queuedQueries,
  refused,
  returned,
  reviewing,
  rowOf,
  seedAttempt,
  seedQueries,
  seedQueryWithId,
  setSwitch,
  state,
  suite,
  track,
  unknownWithdrawal,
  userLine,
  voucherOf,
  withUnknownAdmin,
  type ReviewFixture,
  type UnknownAdmin,
  type WithdrawalRow,
} from './unknown-harness.ts';

const s = suite();

/** Distinct spies per channel, with rejection supported; no change to the shared queryWorker. */
function channelWorker(f: ReviewFixture, h: UnknownAdmin) {
  function fake() {
    return {
      query: vi.fn<PayoutChannel['query']>().mockResolvedValue({
        kind: 'unknown',
        raw: { code: 'SYNTHETIC_UNKNOWN' },
      }),
      transfer: vi.fn<PayoutChannel['transfer']>().mockResolvedValue({
        kind: 'unknown',
        raw: { code: 'SYNTHETIC_TRANSFER_MUST_NOT_RUN' },
        latencyMs: 0,
      }),
    };
  }
  const channels = { alipay: fake(), bank_card: fake(), wechat: fake() };
  const handler = createQueryJob({
    db: f.db,
    attemptsDb: f.payout,
    clock: f.clock,
    config: configPort(),
    ledger: f.ledger,
    lockUsersForUpdate,
    queue: h.queue,
    eventBus: h.events,
    channels,
    sleep: async () => undefined,
    logger: { info: () => undefined, warn: () => undefined },
  });
  return { handler, channels };
}

function success(f: ReviewFixture): QueryResult {
  return {
    kind: 'success',
    raw: { code: 'SYNTHETIC_SUCCESS' },
    channelOrderId: randomUUID(),
    paidAt: f.clock.now().toISOString(),
  };
}

/** Always consume a job obtained from the real HTTP enqueue, not a hand-made manual payload. */
async function submit(f: ReviewFixture, h: UnknownAdmin, w: WithdrawalRow, key = randomUUID()) {
  const before = await queuedQueries(f);
  await answer(await h.query(w.id, { key }), 0, {
    withdrawal_id: w.id,
    result: 'submitted',
  });
  const fresh = (await queuedQueries(f)).filter((job) => !before.some((old) => old.id === job.id));
  expect(fresh).toHaveLength(1);
  expect(fresh[0]!.payload['withdrawal_id']).toBe(w.id);
  return fresh[0]!;
}

function manualRequestId(job: Awaited<ReturnType<typeof submit>>): string {
  const id = job.payload['manual_request_id'];
  expect(id, 'HTTP enqueue must give each manual request a stable identifier').toEqual(
    expect.any(String),
  );
  expect(id).not.toBe('');
  return id as string;
}

function noTransfer(worker: ReturnType<typeof channelWorker>): void {
  for (const channel of Object.values(worker.channels)) {
    expect(channel.transfer).not.toHaveBeenCalled();
  }
}

it('[AC-B2-09s#27] 最近查询success允许判成功；同一at时先fail后success按id倒序取成功，不能只允许unknown', async () => {
  const f = fixture(s);
  await withUnknownAdmin(f, async (h) => {
    for (const precedingFail of [false, true]) {
      const w = await unknownWithdrawal(f, h, await payee(f, h));
      const { low, high } = lowAndHigh();
      if (precedingFail) await seedQueryWithId(f, w, low, 'fail', f.clock.now());
      await seedQueryWithId(f, w, high, 'success', f.clock.now());
      const body = paidBody(f, w);
      await answer(await h.resolve(w.id, body), 0);
      expect(await rowOf(f, w)).toMatchObject({
        status: 'PAID_API',
        manual_resolution: 'paid',
        channel_order_id: body.channel_order_id,
        paid_at: new Date(body.paid_at),
      });
      expect(await voucherOf(f.db, f.appId, `wd:${w.id}:PAID`)).toHaveLength(1);
    }
  });
});

it('[AC-B2-09s#28] 真实手动查询任务返回success只留凭证，随后W10判成功贯通；较早fail不会挡住新success', async () => {
  const f = fixture(s);
  await withUnknownAdmin(f, async (h) => {
    const w = await unknownWithdrawal(f, h, await payee(f, h));
    await seedQueries(f, w, [['fail', 1]]);
    const job = await submit(f, h, w);
    const before = await state(f);
    const worker = channelWorker(f, h);
    const result = success(f);
    worker.channels.alipay.query.mockResolvedValue(result);
    await expect(worker.handler(job)).resolves.toBeUndefined();
    expect(worker.channels.alipay.query).toHaveBeenCalledTimes(1);
    expect(worker.channels.alipay.query.mock.calls[0]?.[0]).toBe(w.out_biz_no);
    noTransfer(worker);
    const after = await state(f);
    expect({ ...after, attempts: [] }).toEqual({ ...before, attempts: [] });
    expect((await attemptsOf(f, w)).filter((a) => a.kind === 'query').map((a) => a.result)).toEqual(
      ['fail', 'success'],
    );
    const page = await answer(await h.list(), 0);
    expect(page.data).toMatchObject({
      items: [{ withdrawal_id: w.id, latest_query: { result: 'success' } }],
    });
    await answer(
      await h.resolve(
        w.id,
        paidBody(f, w, {
          channel_order_id: result.channelOrderId,
          paid_at: result.paidAt,
        }),
      ),
      0,
    );
    expect((await rowOf(f, w)).status).toBe('PAID_API');
    expect(await voucherOf(f.db, f.appId, `wd:${w.id}:PAID`)).toHaveLength(1);
  });
});

it('[AC-B2-09s#29] 最近查询fail且本单账单CLOSED未映射成功，仍resolve_query_failed，不能把有行当成功', async () => {
  const f = fixture(s);
  await withUnknownAdmin(f, async (h) => {
    await setSwitch(f, 'payout.query_status_map', { SUCCESS: 'success' });
    const w = await unknownWithdrawal(f, h, await payee(f, h));
    await seedQueries(f, w, [['fail', 1]]);
    await bill(f, w, 'CLOSED');
    const before = await state(f);
    await refused(await h.resolve(w.id, paidBody(f, w)), 'resolve_query_failed');
    expect(await state(f)).toEqual(before);
  });
});

it('[AC-B2-09s#30] 账单成功按本app的query_status_map判定：非SUCCESS的合成状态映射success能解除fail保护', async () => {
  const f = fixture(s);
  await withUnknownAdmin(f, async (h) => {
    await setSwitch(f, 'payout.query_status_map', { SYNTHETIC_SETTLED: 'success' });
    const w = await unknownWithdrawal(f, h, await payee(f, h));
    await seedQueries(f, w, [['fail', 1]]);
    await bill(f, w, 'SYNTHETIC_SETTLED');
    const own = await f.db
      .withSchema('app')
      .selectFrom('recon_channel')
      .select('channel_order_id')
      .where('app_id', '=', w.app_id)
      .where('out_biz_no', '=', w.out_biz_no)
      .where('channel_status', '=', 'SYNTHETIC_SETTLED')
      .executeTakeFirstOrThrow();
    await answer(
      await h.resolve(w.id, paidBody(f, w, { channel_order_id: own.channel_order_id })),
      0,
    );
    expect((await rowOf(f, w)).status).toBe('PAID_API');
    expect(await voucherOf(f.db, f.appId, `wd:${w.id}:PAID`)).toHaveLength(1);
  });
});

it('[AC-B2-09s#31] 微信W10判成功贷CASH_WECHAT：六条分录金额科目逐条核对且与同金额W5相同，available不变frozen归零', async () => {
  const f = fixture(s);
  await withUnknownAdmin(f, async (h) => {
    const who = await payee(f, h);
    const w = await unknownWithdrawal(f, h, who, { seed: { method: 'wechat' } });
    const body = paidBody(f, w);
    await answer(await h.resolve(w.id, body), 0);
    expect(await rowOf(f, w)).toMatchObject({
      status: 'PAID_API',
      payout_channel: 'wechat',
      channel_order_id: body.channel_order_id,
      paid_at: new Date(body.paid_at),
    });
    const key = `wd:${w.id}:PAID`;
    expect(await voucherOf(f.db, f.appId, key)).toHaveLength(1);
    const actual = await entries(f.db, f.appId, key);
    expect(actual).toEqual([
      userLine(88n, 'TAX_WITHHOLD'),
      platformLine('TAX_PAYABLE', -88n, 'TAX_WITHHOLD'),
      userLine(125n, 'WITHDRAW_FEE'),
      platformLine('FEE_INCOME', -125n, 'WITHDRAW_FEE'),
      userLine(12_347n, 'WITHDRAW_PAID'),
      platformLine('CASH_WECHAT', -12_347n, 'WITHDRAW_PAID'),
    ]);
    const viaW5 = await reviewing(f, h, await payee(f, h), {
      status: 'PAYING',
      method: 'wechat',
      execute_seq: 1,
    });
    await landThroughChannel(f, viaW5);
    expect(actual).toEqual(await entries(f.db, f.appId, `wd:${viaW5.id}:PAID`));
    expect(await balanceOf(f.db, f.ledger, f.appId, who.userId)).toEqual({
      available_fen: AFTER_FREEZE,
      frozen_fen: 0n,
    });
    expect(await frozenMismatches(f.db, f.appId)).toEqual([]);
  });
});

it('[AC-B2-09s#32] 手动查询按提现快照选wechat和bank_card通道，只有对应fake被调用一次且参数为本单out_biz_no', async () => {
  const f = fixture(s);
  await withUnknownAdmin(f, async (h) => {
    for (const method of ['wechat', 'bank_card'] as const) {
      const w = await unknownWithdrawal(f, h, await payee(f, h), { seed: { method } });
      const job = await submit(f, h, w);
      const before = await state(f);
      const worker = channelWorker(f, h);
      await expect(worker.handler(job)).resolves.toBeUndefined();
      for (const [name, channel] of Object.entries(worker.channels)) {
        expect(channel.query).toHaveBeenCalledTimes(name === method ? 1 : 0);
      }
      expect(worker.channels[method].query.mock.calls[0]?.[0]).toBe(w.out_biz_no);
      noTransfer(worker);
      const queries = (await attemptsOf(f, w)).filter((a) => a.kind === 'query');
      expect(queries).toHaveLength(1);
      expect(queries[0]).toMatchObject({
        result: 'unknown',
        request: expect.objectContaining({ out_biz_no: w.out_biz_no }),
      });
      const after = await state(f);
      expect({ ...after, attempts: [] }).toEqual({ ...before, attempts: [] });
    }
  });
});

it('[AC-B2-09s#33] 手动查询传输异常只调一次并记一条unknown，任务不失败不迁移；W9退回单随后驳回仍reject_query_required', async () => {
  const f = fixture(s);
  await withUnknownAdmin(f, async (h) => {
    const reviewer = await h.caller(['withdraw.review']);
    for (const mode of ['manual', 'returned'] as const) {
      const who = await payee(f, h);
      const w = mode === 'manual' ? await unknownWithdrawal(f, h, who) : await returned(f, h, who);
      const job = await submit(f, h, w);
      const before = await state(f);
      const worker = channelWorker(f, h);
      worker.channels.alipay.query.mockRejectedValue(new Error('synthetic transport failure'));
      await expect(worker.handler(job)).resolves.toBeUndefined();
      expect(worker.channels.alipay.query).toHaveBeenCalledTimes(1);
      expect(worker.channels.alipay.query.mock.calls[0]?.[0]).toBe(w.out_biz_no);
      expect(worker.channels.wechat.query).not.toHaveBeenCalled();
      expect(worker.channels.bank_card.query).not.toHaveBeenCalled();
      noTransfer(worker);
      const attempts = await attemptsOf(f, w);
      expect(attempts.filter((a) => a.kind === 'transfer')).toHaveLength(1);
      expect(attempts.filter((a) => a.kind === 'query')).toEqual([
        expect.objectContaining({
          result: 'unknown',
          request: expect.objectContaining({ out_biz_no: w.out_biz_no }),
        }),
      ]);
      const after = await state(f);
      expect({ ...after, attempts: [] }).toEqual({ ...before, attempts: [] });
      expect(await rowOf(f, w)).toEqual(w);
      if (mode === 'returned') {
        await refused(
          await h.reject(w.id, { caller: reviewer }),
          'reject_query_required',
          'withdrawal_id',
        );
        expect(await state(f)).toEqual(after);
      }
    }
  });
});

it('[AC-B2-09s#34] APPROVED+payout_disabled不是付款方失败退回单，查询20902，状态余额审计队列均不变', async () => {
  const f = fixture(s);
  await withUnknownAdmin(f, async (h) => {
    const w = await reviewing(f, h, await payee(f, h), {
      status: 'APPROVED',
      hold_reason: 'payout_disabled',
      hold_at: f.clock.now(),
    });
    const before = await state(f);
    await answer(await h.query(w.id), 20902, { resource: 'withdrawal' });
    expect(await state(f)).toEqual(before);
  });
});

it('[AC-B2-09s#35] failed先检查状态：PAID_API及普通PAYING均20902；空白proof_text先于未知withdrawal_id检查', async () => {
  const f = fixture(s);
  await withUnknownAdmin(f, async (h) => {
    for (const status of ['PAID_API', 'PAYING']) {
      const w = await reviewing(f, h, await payee(f, h), {
        status,
        executed_at: new Date(f.clock.now().getTime() - DAY * 2),
      });
      await seedAttempt(f, w, {
        kind: 'transfer',
        result: 'unknown',
        at: new Date(f.clock.now().getTime() - DAY * 2),
      });
      const before = await state(f);
      await answer(await h.resolve(w.id, { resolution: 'failed', proof_text: PROOF }), 20902, {
        resource: 'withdrawal',
      });
      expect(await state(f)).toEqual(before);
    }
    const before = await state(f);
    await answer(
      await h.resolve(randomUUID(), { resolution: 'failed', proof_text: ' \t\n ' }),
      20001,
      {
        fields: ['proof_text'],
      },
    );
    expect(await state(f)).toEqual(before);
  });
});

it('[AC-B2-09s#36] T取首次transfer.at而非早7分钟的executed_at：列表、fail_blockers及24小时少1毫秒/恰到边界一致', async () => {
  const f = fixture(s);
  await withUnknownAdmin(f, async (h) => {
    for (const age of [DAY - 1, DAY]) {
      const t = new Date(f.clock.now().getTime() - age);
      const executed = new Date(t.getTime() - 7 * 60_000);
      const w = await unknownWithdrawal(f, h, await payee(f, h), {
        age,
        seed: { executed_at: executed, created_at: new Date(executed.getTime() - 60_000) },
      });
      const before = await state(f);
      const response = await answer(await h.list(), 0);
      const item = (response.data as { items: Array<Record<string, unknown>> }).items.find(
        (row) => row['withdrawal_id'] === w.id,
      );
      expect(item).toBeDefined();
      expect(Date.parse(String(item!['first_transfer_at']))).toBe(t.getTime());
      expect(item!['fail_blockers']).toEqual([
        ...(age < DAY ? ['resolve_too_early'] : []),
        'resolve_bill_unverifiable',
        'resolve_query_unverifiable',
      ]);
      await refused(
        await h.resolve(w.id, { resolution: 'failed', proof_text: PROOF }),
        age < DAY ? 'resolve_too_early' : 'resolve_bill_unverifiable',
      );
      expect(await state(f)).toEqual(before);
    }
  });
});

it('[AC-B2-09s#37] paid_at下限取首次transfer.at：executed_at早7分钟，T前1毫秒拒绝，恰好T允许', async () => {
  const f = fixture(s);
  await withUnknownAdmin(f, async (h) => {
    const t = new Date(f.clock.now().getTime() - DAY);
    const executed = new Date(t.getTime() - 7 * 60_000);
    const w = await unknownWithdrawal(f, h, await payee(f, h), {
      seed: { executed_at: executed, created_at: new Date(executed.getTime() - 60_000) },
    });
    const before = await state(f);
    await refused(
      await h.resolve(
        w.id,
        paidBody(f, w, {
          paid_at: new Date(t.getTime() - 1).toISOString(),
        }),
      ),
      'resolve_paid_at_invalid',
      'paid_at',
    );
    expect(await state(f)).toEqual(before);
    await answer(await h.resolve(w.id, paidBody(f, w, { paid_at: t.toISOString() })), 0);
    expect(await rowOf(f, w)).toMatchObject({ status: 'PAID_API', paid_at: t });
  });
});

it('[AC-B2-09s#38] 手动任务确认前重投按manual_request_id去重：首次fail、重投通道会抛错，不再调用且仍只有fail，W10保护不被unknown解除', async () => {
  const f = fixture(s);
  await withUnknownAdmin(f, async (h) => {
    const w = await unknownWithdrawal(f, h, await payee(f, h));
    const key = randomUUID();
    const job = await submit(f, h, w, key);
    const requestId = manualRequestId(job);
    const worker = channelWorker(f, h);
    worker.channels.alipay.query.mockResolvedValueOnce({
      kind: 'fail',
      raw: { code: 'SYNTHETIC_FAIL' },
    });
    worker.channels.alipay.query.mockRejectedValue(
      new Error('synthetic redelivery transport failure'),
    );
    const before = await state(f);
    await expect(worker.handler(job)).resolves.toBeUndefined();
    expect(worker.channels.alipay.query).toHaveBeenCalledTimes(1);
    const first = await state(f);
    expect({ ...first, attempts: [] }).toEqual({ ...before, attempts: [] });
    const queries = (await attemptsOf(f, w)).filter((a) => a.kind === 'query');
    expect(queries).toHaveLength(1);
    expect(queries[0]!.result).toBe('fail');
    // Later Clock makes an erroneously appended unknown unambiguously the latest evidence.
    f.clock.advanceMs(1);
    // A fresh handler models the process dying after the attempt committed, before queue ACK.
    const restarted = channelWorker(f, h);
    restarted.channels.alipay.query.mockRejectedValue(
      new Error('synthetic restarted transport failure'),
    );
    await expect(restarted.handler({ ...job, attempt: job.attempt + 1 })).resolves.toBeUndefined();
    expect(worker.channels.alipay.query).toHaveBeenCalledTimes(1);
    for (const channel of Object.values(restarted.channels)) {
      expect(channel.query).not.toHaveBeenCalled();
    }
    noTransfer(worker);
    noTransfer(restarted);
    expect(await state(f)).toEqual(first);
    await answer(await h.query(w.id, { key }), 0);
    expect(await queuedQueries(f)).toHaveLength(1);
    expect(manualRequestId((await queuedQueries(f))[0]!)).toBe(requestId);
    const page = await answer(await h.list(), 0);
    expect(page.data).toMatchObject({
      items: [{ withdrawal_id: w.id, latest_query: { result: 'fail' } }],
    });
    const beforeRefusal = await state(f);
    await refused(await h.resolve(w.id, paidBody(f, w)), 'resolve_query_failed');
    expect(await state(f)).toEqual(beforeRefusal);
  });
});

it('[AC-B2-09s#39] 首条在途时异键再点不再入队；首条真正完成后异键再点才入队新的一条，manual_request_id不同，各查一次；各自重投后仍恰两条query', async () => {
  const f = fixture(s);
  await withUnknownAdmin(f, async (h) => {
    const w = await unknownWithdrawal(f, h, await payee(f, h));
    const first = await submit(f, h, w);
    await answer(await h.query(w.id, { key: randomUUID() }), 0, {
      withdrawal_id: w.id,
      result: 'submitted',
    });
    expect((await queuedQueries(f)).map((job) => job.id)).toEqual([first.id]);
    const worker = channelWorker(f, h);
    const before = await state(f);
    await expect(worker.handler(first)).resolves.toBeUndefined();
    expect({ ...(await state(f)), attempts: [] }).toEqual({ ...before, attempts: [] });
    // The payout process's queue completes the job once its handler resolved (B2-09y kit.ts).
    const completed = await sql`UPDATE pgboss.job SET state = 'completed', completed_on = now()
      WHERE name = 'payout' AND id = ${first.id}::uuid AND state = 'created'`.execute(f.db);
    expect(completed.numAffectedRows).toBe(1n);
    f.clock.advanceMs(1);
    const second = await submit(f, h, w);
    expect(manualRequestId(second)).not.toBe(manualRequestId(first));
    const beforeSecond = await state(f);
    await expect(worker.handler(second)).resolves.toBeUndefined();
    expect({ ...(await state(f)), attempts: [] }).toEqual({ ...beforeSecond, attempts: [] });
    expect(worker.channels.alipay.query).toHaveBeenCalledTimes(2);
    expect(worker.channels.alipay.query.mock.calls.map((call) => call[0])).toEqual([
      w.out_biz_no,
      w.out_biz_no,
    ]);
    const after = await state(f);
    expect((await attemptsOf(f, w)).filter((a) => a.kind === 'query')).toHaveLength(2);
    for (const job of [first, second]) {
      await expect(worker.handler({ ...job, attempt: job.attempt + 1 })).resolves.toBeUndefined();
    }
    expect(worker.channels.alipay.query).toHaveBeenCalledTimes(2);
    noTransfer(worker);
    expect(await state(f)).toEqual(after);
  });
});

it('[AC-B2-09s#40] 同一手动任务两个处理器确定性交错：首个通道响应被闸门扣住，允许第二个查询通道，最终只留一条query', async () => {
  const f = fixture(s);
  await withUnknownAdmin(f, async (h) => {
    const w = await unknownWithdrawal(f, h, await payee(f, h));
    const job = await submit(f, h, w);
    manualRequestId(job);
    const before = await state(f);
    // Separate handlers: no in-memory state is shared except the underlying database/queue.
    const one = channelWorker(f, h);
    const two = channelWorker(f, h);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    one.channels.alipay.query.mockImplementation(async () => {
      entered.resolve();
      await release.promise;
      return { kind: 'unknown', raw: { code: 'SYNTHETIC_UNKNOWN' } };
    });
    two.channels.alipay.query.mockImplementation(async () => {
      await release.promise;
      return { kind: 'unknown', raw: { code: 'SYNTHETIC_UNKNOWN' } };
    });
    const first = track(one.handler(job));
    let second: typeof first | undefined;
    try {
      expect(
        await Promise.race([entered.promise.then(() => true), first.promise.then(() => false)]),
        'the first delivery reached the channel and is held before recording its answer',
      ).toBe(true);
      // Capture the first worker's open transactions while its channel promise is held. The
      // dedicated fixture DB has no other business request running. A durable pending claim
      // may instead release its transaction: in that design the second delivery can finish.
      // Each non-superuser sees state only for its own role: inspect both writer handles.
      const readOwners = sql<{ pid: number }>`SELECT pid FROM pg_stat_activity
        WHERE datname = current_database() AND state = 'idle in transaction'`;
      const owners = (
        await Promise.all([readOwners.execute(f.db), readOwners.execute(f.payout)])
      ).flatMap((result) => result.rows.map((owner) => owner.pid));
      second = track(two.handler({ ...job, attempt: job.attempt + 1 }));
      let observed = false;
      for (let poll = 0; poll < 2000; poll += 1) {
        if (second.settled || two.channels.alipay.query.mock.calls.length > 0) {
          observed = true;
          break;
        }
        // pid/datname and pg_blocking_pids are visible across roles; wait_event_type is not.
        const waiting = await sql<{ pid: number }>`SELECT pid FROM pg_stat_activity
          WHERE datname = current_database()
            AND pg_blocking_pids(pid) && ${owners}::integer[]`.execute(f.db);
        if (waiting.rows.length > 0) {
          observed = true;
          break;
        }
      }
      expect(
        observed,
        'observe second delivery blocked, deduplicated, or at channel; no sleep',
      ).toBe(true);
      expect(first.settled).toBe(false);
      expect(one.channels.alipay.query).toHaveBeenCalledTimes(1);
    } finally {
      release.resolve();
      await Promise.allSettled([first.promise, ...(second ? [second.promise] : [])]);
    }
    await expect(first.promise).resolves.toBeUndefined();
    expect(second).toBeDefined();
    await expect(second!.promise).resolves.toBeUndefined();
    const calls = [
      ...one.channels.alipay.query.mock.calls,
      ...two.channels.alipay.query.mock.calls,
    ];
    for (const call of calls) {
      expect(call[0]).toBe(w.out_biz_no);
    }
    for (const worker of [one, two]) {
      noTransfer(worker);
      expect(worker.channels.bank_card.query).not.toHaveBeenCalled();
      expect(worker.channels.wechat.query).not.toHaveBeenCalled();
    }
    expect((await attemptsOf(f, w)).filter((a) => a.kind === 'query')).toHaveLength(1);
    expect((await attemptsOf(f, w)).filter((a) => a.kind === 'transfer')).toHaveLength(1);
    const after = await state(f);
    expect({ ...after, attempts: [] }).toEqual({ ...before, attempts: [] });
  });
});

it('[AC-B2-09s#41] 最新查询fail时，账单状态虽在map内但映射fail或unknown均不能解除resolve_query_failed，状态凭证余额不变', async () => {
  const f = fixture(s);
  await withUnknownAdmin(f, async (h) => {
    await setSwitch(f, 'payout.query_status_map', {
      SUCCESS: 'success',
      TEST_CLOSED: 'fail',
      TEST_WAIT: 'unknown',
    });
    for (const status of ['TEST_CLOSED', 'TEST_WAIT']) {
      const who = await payee(f, h);
      const w = await unknownWithdrawal(f, h, who);
      await seedQueries(f, w, [['fail', 1]]);
      await bill(f, w, status);
      const before = await state(f);
      const balance = await balanceOf(f.db, f.ledger, f.appId, who.userId);
      await refused(await h.resolve(w.id, paidBody(f, w)), 'resolve_query_failed');
      expect(await rowOf(f, w)).toEqual(w);
      expect(await voucherOf(f.db, f.appId, `wd:${w.id}:PAID`)).toEqual([]);
      expect(await balanceOf(f.db, f.ledger, f.appId, who.userId)).toEqual(balance);
      expect(await state(f)).toEqual(before);
    }
  });
});

it('[AC-B2-09s#42] 同一手动查询两处理器各过通道闸门后同时写入：外部提现行锁证明两者阻塞，提交后恰一条query且不迁移不重转账', async () => {
  const f = fixture(s);
  await withUnknownAdmin(f, async (h) => {
    const w = await unknownWithdrawal(f, h, await payee(f, h));
    const job = await submit(f, h, w);
    manualRequestId(job);
    const before = await state(f);
    const one = channelWorker(f, h);
    const two = channelWorker(f, h);
    const enteredOne = Promise.withResolvers<void>();
    const enteredTwo = Promise.withResolvers<void>();
    const releaseOne = Promise.withResolvers<void>();
    const releaseTwo = Promise.withResolvers<void>();
    one.channels.alipay.query.mockImplementation(async () => {
      enteredOne.resolve();
      await releaseOne.promise;
      return { kind: 'unknown', raw: { code: 'SYNTHETIC_UNKNOWN' } };
    });
    two.channels.alipay.query.mockImplementation(async () => {
      enteredTwo.resolve();
      await releaseTwo.promise;
      return { kind: 'unknown', raw: { code: 'SYNTHETIC_UNKNOWN' } };
    });
    const first = track(one.handler(job));
    const second = track(two.handler({ ...job, attempt: job.attempt + 1 }));
    let hold: Awaited<ReturnType<typeof holdRow>> | undefined;

    // Observe across roles via pg_blocking_pids: couli_app cannot see couli_payout's
    // wait_event_type/query. Use f.db, not the two payout connections occupied by the writers.
    async function waitingOn(holder: number, count: number): Promise<number[]> {
      for (let poll = 0; poll < 2000; poll += 1) {
        const result = await sql<{ pid: number }>`WITH RECURSIVE waiting_on(pid) AS (
          SELECT pid FROM pg_stat_activity WHERE datname = current_database()
            AND ${holder}::integer = ANY(pg_blocking_pids(pid))
          UNION
          SELECT a.pid FROM pg_stat_activity a
            JOIN waiting_on w ON w.pid = ANY(pg_blocking_pids(a.pid))
            WHERE a.datname = current_database()
        ) SELECT DISTINCT pid FROM waiting_on`.execute(f.db);
        if (result.rows.length >= count) return result.rows.map((row) => row.pid);
        if (first.settled || second.settled) return [];
      }
      return [];
    }

    try {
      expect(
        await Promise.race([enteredOne.promise.then(() => true), first.promise.then(() => false)]),
        'first delivery reached its channel gate before writing',
      ).toBe(true);
      expect(
        await Promise.race([enteredTwo.promise.then(() => true), second.promise.then(() => false)]),
        'second delivery reached its own channel gate before either answer was recorded',
      ).toBe(true);
      // Acquire only after both read phases: the row lock then blocks the attempts' FK check
      // (or an explicit write-phase row lock), never the initial read before the channel call.
      hold = await holdRow(f, 'withdrawals', w.id);
      releaseOne.resolve();
      const firstWaiters = await waitingOn(hold.pid, 1);
      expect(firstWaiters, 'first writer waits on the external withdrawal lock').toHaveLength(1);
      expect(first.settled).toBe(false);
      releaseTwo.resolve();
      const bothWaiters = await waitingOn(hold.pid, 2);
      // A deduplicating writer may wait indirectly on the first writer; an unprotected one
      // waits directly on the same withdrawal. Both must have reached the write phase.
      expect(bothWaiters, 'both writers are in the holder-rooted blocking chain').toHaveLength(2);
      expect(bothWaiters).toContain(firstWaiters[0]);
      expect(first.settled).toBe(false);
      expect(second.settled).toBe(false);
    } finally {
      releaseOne.resolve();
      releaseTwo.resolve();
      try {
        await hold?.release();
      } finally {
        await Promise.allSettled([first.promise, second.promise]);
      }
    }
    await expect(first.promise).resolves.toBeUndefined();
    await expect(second.promise).resolves.toBeUndefined();
    for (const worker of [one, two]) {
      expect(worker.channels.alipay.query).toHaveBeenCalledTimes(1);
      expect(worker.channels.alipay.query.mock.calls[0]?.[0]).toBe(w.out_biz_no);
      expect(worker.channels.bank_card.query).not.toHaveBeenCalled();
      expect(worker.channels.wechat.query).not.toHaveBeenCalled();
      noTransfer(worker);
    }
    const attempts = await attemptsOf(f, w);
    expect(attempts.filter((a) => a.kind === 'query')).toHaveLength(1);
    expect(attempts.filter((a) => a.kind === 'transfer')).toHaveLength(1);
    expect(await rowOf(f, w)).toEqual(w);
    const after = await state(f);
    expect({ ...after, attempts: [] }).toEqual({ ...before, attempts: [] });
  });
});
