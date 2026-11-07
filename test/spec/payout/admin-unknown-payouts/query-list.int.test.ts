// BR-WDR-14/15/17: manual queries append evidence and cannot land, return or resend money.
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  ACCOUNT,
  DAY,
  answer,
  attemptsOf,
  auditFacts,
  audits,
  entryOf,
  expectNoSecrets,
  fixture,
  otherApp,
  payee,
  queuedQueries,
  queryWorker,
  returned,
  reviewing,
  rowOf,
  secretsOf,
  seedAttempt,
  setSwitch,
  state,
  suite,
  textOf,
  unknownWithdrawal,
  withUnknownAdmin,
} from './unknown-harness.ts';

const s = suite();

it('[AC-B2-09s#12] 入队后真实query-job只追加一条query：needs_manual及W9退回单，对success/fail/unknown均不迁移、不记账、不排下一点、不重提转账；开关暂停不拦查询', async () => {
  const f = fixture(s);
  await withUnknownAdmin(f, async (h) => {
    await setSwitch(f, 'payout.enabled', false);
    await setSwitch(f, 'payout.queue_paused', true);
    for (const mode of ['manual', 'returned']) {
      for (const kind of ['success', 'fail', 'unknown'] as const) {
        const who = await payee(f, h);
        const w =
          mode === 'manual' ? await unknownWithdrawal(f, h, who) : await returned(f, h, who);
        const before = await state(f);
        const count = (await queuedQueries(f)).length;
        await answer(await h.query(w.id), 0, { withdrawal_id: w.id, result: 'submitted' });
        const jobs = await queuedQueries(f);
        expect(jobs).toHaveLength(count + 1);
        const job = jobs.find((j) => j.payload['withdrawal_id'] === w.id);
        expect(job).toBeDefined();
        const afterSubmit = await state(f);
        const worker = queryWorker(f, h, {
          kind,
          raw: { code: 'SYNTHETIC_QUERY', subCode: 'SYNTHETIC_DETAIL' },
          status: 'SYNTHETIC_STATUS',
          ...(kind === 'success'
            ? { channelOrderId: 'query-proof', paidAt: f.clock.now().toISOString() }
            : {}),
        });
        await worker.handler(job!);
        expect(worker.query).toHaveBeenCalledTimes(1);
        expect(worker.query.mock.calls[0]?.[0]).toBe(w.out_biz_no);
        expect(worker.transfer).not.toHaveBeenCalled();
        const attempts = await attemptsOf(f, w);
        expect(attempts.filter((a) => a.kind === 'transfer')).toHaveLength(1);
        const queries = attempts.filter((a) => a.kind === 'query');
        expect(queries).toHaveLength(1);
        expect(queries[0]).toMatchObject({
          result: kind,
          request: expect.objectContaining({ out_biz_no: w.out_biz_no }),
        });
        const afterRun = await state(f);
        expect({ ...afterRun, attempts: [] }).toEqual({ ...afterSubmit, attempts: [] });
        for (const field of [
          'withdrawals',
          'vouchers',
          'entries',
          'balances',
          'holds',
          'events',
          'tax',
        ] as const) {
          expect(afterRun[field]).toEqual(before[field]);
        }
        expect(await rowOf(f, w)).toEqual(w);
        if (mode === 'manual') {
          const page = await answer(await h.list(), 0);
          const items = (page.data as { items: Array<Record<string, unknown>> }).items;
          const item = items.find((candidate) => candidate['withdrawal_id'] === w.id);
          expect(item).toMatchObject({
            out_biz_no: w.out_biz_no,
            user: { user_id: who.userId },
            payout_channel: 'alipay',
            amount_fen: 12_560,
            net_fen: 12_347,
            latest_query: {
              result: kind,
              resp_code: 'SYNTHETIC_QUERY',
              resp_sub_code: 'SYNTHETIC_DETAIL',
              channel_status: 'SYNTHETIC_STATUS',
              channel_order_id: kind === 'success' ? 'query-proof' : null,
              paid_at: kind === 'success' ? expect.any(String) : null,
            },
          });
          expect(Date.parse(String(item!['first_transfer_at']))).toBe(
            attempts.find((attempt) => attempt.kind === 'transfer')!.at.getTime(),
          );
          const latest = item!['latest_query'] as Record<string, unknown>;
          expect(Date.parse(String(latest['at']))).toBe(queries[0]!.at.getTime());
          if (kind === 'success') {
            expect(Date.parse(String(latest['paid_at']))).toBe(f.clock.now().getTime());
          }
          expectNoSecrets(textOf(page), secretsOf(w, ACCOUNT.alipay, who));
        }
      }
    }
  });
});

it('[AC-B2-09s#13] W9退回单查询fail写成真实尝试后，W3守卫可读到并成功驳回；needs_manual单W8仍not_approved', async () => {
  const f = fixture(s);
  await withUnknownAdmin(f, async (h) => {
    const w = await returned(f, h, await payee(f, h));
    await answer(await h.query(w.id), 0);
    const job = (await queuedQueries(f))[0];
    expect(job).toBeDefined();
    await queryWorker(f, h, { kind: 'fail', raw: { code: 'SYNTHETIC_FAIL' } }).handler(job!);
    const reviewer = await h.caller(['withdraw.review']);
    await answer(await h.reject(w.id, { caller: reviewer }), 0);
    expect((await rowOf(f, w)).status).toBe('REJECTED');
    const manual = await unknownWithdrawal(f, h, await payee(f, h));
    const entry = await h.caller(['payout.manual_entry']);
    await answer(await h.manualPaid([entryOf(f, manual)], { caller: entry }), 0, {
      items: [{ withdrawal_id: manual.id, result: 'skipped', reason: 'not_approved' }],
    });
    expect(await rowOf(f, manual)).toEqual(manual);
    expect((await attemptsOf(f, manual)).filter((a) => a.kind === 'transfer')).toHaveLength(1);
  });
});

it('[AC-B2-09s#14] 查询同键同体只入队一次、异键在途不再入队；payout_query_request审计恰一次每请求且无个人资料，按target_id可查', async () => {
  const f = fixture(s);
  await withUnknownAdmin(f, async (h) => {
    const who = await payee(f, h);
    const w = await unknownWithdrawal(f, h, who);
    const key = randomUUID();
    const first = await h.query(w.id, { key });
    await answer(first, 0, { withdrawal_id: w.id, result: 'submitted' });
    const before = await state(f);
    expect((await h.query(w.id, { key })).body).toBe(first.body);
    expect(await state(f)).toEqual(before);
    expect(await queuedQueries(f)).toHaveLength(1);
    const records = await audits(f, 'payout_query_request');
    expect(records).toHaveLength(1);
    const facts = auditFacts(records[0]!);
    expect(facts.text).toContain(w.id);
    expect(facts.text).toContain('PAYING');
    expectNoSecrets(facts.text, secretsOf(w, ACCOUNT.alipay, who));
    const reader = await h.caller(['audit.view_all']);
    const listed = await answer(await h.audit(w.id, { caller: reader }), 0);
    expect(listed.data).toMatchObject({
      items: [
        expect.objectContaining({ action: 'payout_query_request', permission: 'payout.execute' }),
      ],
      total: 1,
    });
    await answer(await h.query(w.id), 0, { withdrawal_id: w.id, result: 'submitted' });
    expect(await queuedQueries(f)).toHaveLength(1);
    expect(await audits(f, 'payout_query_request')).toHaveLength(2);
  });
});

it('[AC-B2-09s#15] 列表仅本app PAYING+needs_manual，按T最老优先且分页；latest_query来自最新at/id，响应不含原始账号、姓名及响应中的额外私密字段', async () => {
  const f = fixture(s);
  await withUnknownAdmin(f, async (h) => {
    const who = await payee(f, h);
    const youngest = await unknownWithdrawal(f, h, who, {
      age: DAY,
      // Created earlier, transferred later: sorting by created_at instead of T is wrong.
      seed: { created_at: new Date(f.clock.now().getTime() - DAY * 10) },
    });
    const oldest = await unknownWithdrawal(f, h, who, { age: DAY * 3 });
    const middle = await unknownWithdrawal(f, h, who, { age: DAY * 2 });
    await returned(f, h, who);
    await reviewing(f, h, who, { status: 'PAYING' });
    for (const status of ['PAID_API', 'PAID_MANUAL', 'REJECTED', 'FAILED']) {
      await reviewing(f, h, who, { status, needs_manual: true });
    }
    const g = otherApp(f);
    await unknownWithdrawal(g, h, await payee(g, h), { age: DAY * 4 });
    await seedAttempt(f, oldest, {
      kind: 'query',
      result: 'success',
      at: new Date(f.clock.now().getTime() - 1),
      response: { channel_order_id: 'OLD' },
    });
    await seedAttempt(f, oldest, {
      kind: 'query',
      result: 'unknown',
      at: f.clock.now(),
      response: { raw: { payee: ACCOUNT.alipay }, payee_name: oldest.payee_name },
    });
    const before = await state(f);
    const first = await answer(await h.list('?page=1&page_size=2'), 0);
    expect(first.data).toMatchObject({
      page: 1,
      page_size: 2,
      total: 3,
      items: [
        {
          withdrawal_id: oldest.id,
          latest_query: {
            result: 'unknown',
            resp_code: null,
            resp_sub_code: null,
            channel_status: null,
            channel_order_id: null,
            paid_at: null,
          },
        },
        { withdrawal_id: middle.id, latest_query: null },
      ],
    });
    const second = await answer(await h.list('?page=2&page_size=2'), 0);
    expect(second.data).toMatchObject({
      total: 3,
      items: [{ withdrawal_id: youngest.id, latest_query: null }],
    });
    expect((await answer(await h.list('?page=3&page_size=2'), 0)).data).toMatchObject({
      total: 3,
      items: [],
    });
    expectNoSecrets(textOf(first), secretsOf(oldest, ACCOUNT.alipay, who));
    expect(await state(f)).toEqual(before);
  });
});

it('[AC-B2-09s#16] 查询其他状态20902，未知id/跨app/非UUID为20001，不入队不审计', async () => {
  const f = fixture(s);
  await withUnknownAdmin(f, async (h) => {
    for (const status of [
      'PENDING_REVIEW',
      'APPROVED',
      'PAYING',
      'PAID_API',
      'PAID_MANUAL',
      'FAILED',
      'REJECTED',
    ]) {
      const w = await reviewing(f, h, await payee(f, h), { status });
      const before = await state(f);
      await answer(await h.query(w.id), 20902, { resource: 'withdrawal' });
      expect(await state(f)).toEqual(before);
    }
    const g = otherApp(f);
    const foreign = await unknownWithdrawal(g, h, await payee(g, h));
    for (const id of [randomUUID(), foreign.id, 'not-a-uuid']) {
      const before = await state(f);
      await answer(await h.query(id), 20001, { fields: ['withdrawal_id'] });
      expect(await state(f)).toEqual(before);
    }
  });
});
