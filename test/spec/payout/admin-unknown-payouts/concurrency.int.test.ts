import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { lockUsersForUpdate } from '../../../../apps/api/src/modules/identity/ports/lock-users.ts';
import { createLandingJob } from '../../../../apps/api/src/modules/payout/jobs/landing-job.ts';
import { blocked, holdRow, waitersSql } from './lock-harness.ts';
import {
  DAY,
  AFTER_FREEZE,
  answer,
  attemptsOf,
  automaticJob,
  balanceOf,
  changes,
  fixture,
  paidBody,
  payee,
  queuedQueries,
  queryWorker,
  refused,
  reviewing,
  rowOf,
  seedAttempt,
  seedTaxRow,
  state,
  suite,
  taxRows,
  track,
  unknownWithdrawal,
  voucherOf,
  withUnknownAdmin,
  type AdminSent,
} from './unknown-harness.ts';

const s = suite();

it('[AC-B2-09s#22] 同单两个判成功确定性交错：外部持users锁，证明两个请求排队后放行，仅一个成功另一个20902，恰一张凭证一次事件', async () => {
  const f = fixture(s);
  await withUnknownAdmin(f, async (h) => {
    const who = await payee(f, h);
    const w = await unknownWithdrawal(f, h, who);
    const hold = await holdRow(f, 'users', who.userId);
    const first = track(h.resolve(w.id, paidBody(f, w)));
    let second: typeof first | undefined;
    try {
      expect((await blocked(f, hold.pid, 1, [first])).length).toBe(1);
      second = track(h.resolve(w.id, paidBody(f, w)));
      expect((await blocked(f, hold.pid, 2, [first, second])).length).toBe(2);
    } finally {
      await hold.release();
      await Promise.allSettled([first.promise, ...(second ? [second.promise] : [])]);
    }
    await answer(await first.promise, 0);
    expect(second).toBeDefined();
    await answer(await second!.promise, 20902, { resource: 'withdrawal' });
    expect(await voucherOf(f.db, f.appId, `wd:${w.id}:PAID`)).toHaveLength(1);
    expect(await changes(f.db, f.appId)).toHaveLength(1);
    expect(await balanceOf(f.db, f.ledger, f.appId, who.userId)).toEqual({
      available_fen: AFTER_FREEZE,
      frozen_fen: 0n,
    });
  });
});

it('[AC-B2-09s#23] 两张单争相同流水号：第一请求在tax_ytd上被外部持锁，第二请求在唯一索引等第一事务；提交后输家20001而非5xx，冻结不退不扣', async () => {
  const f = fixture(s);
  await withUnknownAdmin(f, async (h) => {
    const who = await payee(f, h);
    const loser = await payee(f, h);
    await seedTaxRow(f, who, 2026, 50_003n, 1_009n);
    const firstRow = await unknownWithdrawal(f, h, who);
    const secondRow = await unknownWithdrawal(f, h, loser);
    const serial = randomUUID();
    const tax = (await taxRows(f)).find((row) => row.user_id === who.userId);
    expect(tax).toBeDefined();
    const hold = await holdRow(f, 'tax_ytd', tax!.id);
    const first = track(
      h.resolve(firstRow.id, paidBody(f, firstRow, { channel_order_id: serial })),
    );
    let second: typeof first | undefined;
    try {
      const pids = await blocked(f, hold.pid, 1, [first]);
      expect(pids).toHaveLength(1);
      expect((await waitersSql(f, pids)).join(' ')).toContain('tax_ytd');
      second = track(h.resolve(secondRow.id, paidBody(f, secondRow, { channel_order_id: serial })));
      const chain = await blocked(f, hold.pid, 2, [first, second]);
      expect(chain).toHaveLength(2);
      expect((await waitersSql(f, chain)).join(' ')).toContain('withdrawals');
    } finally {
      await hold.release();
      await Promise.allSettled([first.promise, ...(second ? [second.promise] : [])]);
    }
    await answer(await first.promise, 0);
    expect(second).toBeDefined();
    await refused(await second!.promise, 'resolve_order_id_taken', 'channel_order_id');
    expect(await rowOf(f, secondRow)).toEqual(secondRow);
    expect(await voucherOf(f.db, f.appId, `wd:${firstRow.id}:PAID`)).toHaveLength(1);
    expect(await voucherOf(f.db, f.appId, `wd:${secondRow.id}:PAID`)).toEqual([]);
    expect(await changes(f.db, f.appId)).toHaveLength(1);
    expect(await balanceOf(f.db, f.ledger, f.appId, loser.userId)).toEqual({
      available_fen: AFTER_FREEZE,
      frozen_fen: 12_560n,
    });
  });
});

it('[AC-B2-09s#24] 已排队的迟到W5/W6和W10互斥：landing先读普通PAYING并被users锁挡住，真实查询任务置needs_manual，再排W10；放行后landing锁内复核无副作用，仅W10成功', async () => {
  const f = fixture(s);
  await withUnknownAdmin(f, async (h) => {
    for (const kind of ['success', 'fail'] as const) {
      const who = await payee(f, h);
      const t = new Date(f.clock.now().getTime() - DAY);
      const w = await reviewing(f, h, who, {
        status: 'PAYING',
        execute_seq: 1,
        created_at: new Date(t.getTime() - 60_000),
        executed_at: t,
      });
      const attempt = await seedAttempt(f, w, {
        kind: 'transfer',
        result: kind,
        at: t,
        response: {
          kind,
          raw: { code: 'SYNTHETIC' },
          channel_order_id: randomUUID(),
          paid_at: f.clock.now().toISOString(),
        },
      });
      const landing = createLandingJob({
        db: f.db,
        ledger: f.ledger,
        clock: f.clock,
        lockUsersForUpdate,
        eventBus: h.events,
        logger: { info: () => undefined, warn: () => undefined },
      });
      const hold = await holdRow(f, 'users', who.userId);
      const late = track(
        landing({
          id: randomUUID(),
          queue: 'payout-landing',
          name: 'land',
          attempt: 0,
          payload: {
            app_id: f.appId,
            withdrawal_id: w.id,
            execute_seq: w.execute_seq,
            attempt_id: attempt.id,
          },
        }),
      );
      let resolve: ReturnType<typeof track<AdminSent>> | undefined;
      try {
        expect((await blocked(f, hold.pid, 1, [late])).length).toBe(1);
        await queryWorker(f, h, { kind: 'unknown', raw: { code: 'SYNTHETIC' } }).handler(
          automaticJob(w),
        );
        expect((await rowOf(f, w)).needs_manual).toBe(true);
        resolve = track(h.resolve(w.id, paidBody(f, w)));
        expect((await blocked(f, hold.pid, 2, [late, resolve])).length).toBe(2);
      } finally {
        await hold.release();
        await Promise.allSettled([late.promise, ...(resolve ? [resolve.promise] : [])]);
      }
      await late.promise;
      expect(resolve).toBeDefined();
      await answer(await resolve!.promise, 0);
      expect((await rowOf(f, w)).status).toBe('PAID_API');
      expect(await voucherOf(f.db, f.appId, `wd:${w.id}:PAID`)).toHaveLength(1);
      expect(await voucherOf(f.db, f.appId, `wd:${w.id}:RETURN`)).toEqual([]);
      expect(
        (await changes(f.db, f.appId)).filter((event) => event['withdrawal_id'] === w.id),
      ).toHaveLength(1);
      expect((await attemptsOf(f, w)).filter((a) => a.kind === 'transfer')).toHaveLength(1);
    }
  });
});

it('[AC-B2-09s#25] 处置进行中40901：证明首请求被外部锁阻塞，再用同键同体或异体重入均拒绝，释放后只完成一次', async () => {
  const f = fixture(s);
  await withUnknownAdmin(f, async (h) => {
    const who = await payee(f, h);
    const w = await unknownWithdrawal(f, h, who);
    const body = paidBody(f, w);
    const key = randomUUID();
    const hold = await holdRow(f, 'users', who.userId);
    const first = track(h.resolve(w.id, body, { key }));
    try {
      expect((await blocked(f, hold.pid, 1, [first])).length).toBe(1);
      const before = await state(f);
      await answer(await h.resolve(w.id, body, { key }), 40901);
      await answer(await h.resolve(w.id, { ...body, proof_text: 'different' }, { key }), 40901);
      expect(await state(f)).toEqual(before);
    } finally {
      await hold.release();
      await Promise.allSettled([first.promise]);
    }
    await answer(await first.promise, 0);
    expect(await voucherOf(f.db, f.appId, `wd:${w.id}:PAID`)).toHaveLength(1);
  });
});

it('[AC-B2-09s#26] 查询进行中40901：外部持提现行锁，首请求进入等待后同键重入拒绝；释放后入队一次且重放不重复', async () => {
  const f = fixture(s);
  await withUnknownAdmin(f, async (h) => {
    const w = await unknownWithdrawal(f, h, await payee(f, h));
    const key = randomUUID();
    const hold = await holdRow(f, 'withdrawals', w.id);
    const first = track(h.query(w.id, { key }));
    try {
      expect((await blocked(f, hold.pid, 1, [first])).length).toBe(1);
      await answer(await h.query(w.id, { key }), 40901);
      expect(await queuedQueries(f)).toEqual([]);
    } finally {
      await hold.release();
      await Promise.allSettled([first.promise]);
    }
    const sent = await first.promise;
    await answer(sent, 0, { withdrawal_id: w.id, result: 'submitted' });
    expect((await h.query(w.id, { key })).body).toBe(sent.body);
    expect(await queuedQueries(f)).toHaveLength(1);
  });
});
