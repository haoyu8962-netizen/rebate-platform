import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { createBillJob } from '../../../../apps/api/src/modules/settlement/bill/job.ts';
import {
  databaseFixture,
  fixture,
  order,
  settlement,
  snapshot,
  state,
  failItemWrite,
  jobConstraint,
  RUN,
  TIMEOUT,
} from './kit.ts';

const database = databaseFixture(createTestDatabase);

it(
  '[AC-B2-04n#22] 两个独立运行器并发同键，只生成一份任务、批次、差错与校验记录，PG 唯一约束兜底',
  async () => {
    const h = fixture(database.db);
    await snapshot(h);
    const good = await order(h);
    await settlement(h, good);
    await order(h);
    const otherRunner = createBillJob(h.deps);
    const input = { appId: h.appId, platform: 'taobao', runAt: new Date(RUN) };
    const results = await Promise.all([h.job.run(h.db, input), otherRunner.run(h.db, input)]);
    expect(results.map((r) => r.outcome).sort()).toEqual(['duplicate', 'generated']);
    const s = await state(h);
    expect(s.jobs).toEqual([
      expect.objectContaining({
        app_id: h.appId,
        job: 'bill',
        platform: 'taobao',
        run_at: new Date(RUN),
        status: 'done',
      }),
    ]);
    expect(s.bills).toHaveLength(1);
    expect(s.batches).toHaveLength(1);
    expect(s.items).toEqual([expect.objectContaining({ order_id: good.id })]);
    expect(s.diffs).toHaveLength(0);
    expect(s.validations).toHaveLength(2);
    expect(await jobConstraint(h)).toEqual([
      { definition: 'UNIQUE (app_id, job, platform, run_at)' },
    ]);
    await expect(
      h.db
        .insertInto('settle_jobs')
        .values({ ...s.jobs[0]!, id: randomUUID() })
        .execute(),
    ).rejects.toMatchObject({ code: '23505', constraint: 'settle_jobs_run_key' });
    expect(await state(h)).toEqual(s);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04n#23] 重放由数据库识别，重建服务和改变订单/开关均不重生成',
  async () => {
    const h = fixture(database.db);
    await snapshot(h);
    await settlement(h, await order(h));
    await h.run();
    const s = await state(h);
    await settlement(h, await order(h));
    h.values.set('credit.enabled.taobao', 'off');
    h.clock.advanceMs(60_000);
    const fresh = createBillJob(h.deps);
    expect(
      await fresh.run(h.db, { appId: h.appId, platform: 'taobao', runAt: new Date(RUN) }),
    ).toMatchObject({ outcome: 'duplicate' });
    expect(await state(h)).toEqual(s);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04n#24] 幂等键包含 app_id 与 job，另一应用和同刻其他任务不阻挡出账',
  async () => {
    const h = fixture(database.db);
    const other = fixture(database.db);
    for (const f of [h, other]) {
      await snapshot(f);
      await settlement(f, await order(f));
    }
    await h.db
      .insertInto('settle_jobs')
      .values({
        id: randomUUID(),
        app_id: h.appId,
        job: 'recon_union',
        platform: 'taobao',
        run_at: new Date(RUN),
        status: 'done',
        processed_count: 0,
        skipped_count: 0,
        started_at: h.clock.now(),
        finished_at: h.clock.now(),
      })
      .execute();
    expect((await h.run()).outcome).toBe('generated');
    const first = await state(h);
    expect((await other.run()).outcome).toBe('generated');
    expect(await state(h)).toEqual(first);
    expect((await state(other)).batches).toHaveLength(1);
    expect(first.jobs.map((j) => j.job).sort()).toEqual(['bill', 'recon_union']);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04n#25] 明细实际写入后故障，不能标记已出账；原键恢复后没有残留或重复',
  async () => {
    const h = fixture(database.db);
    await snapshot(h);
    const o = await order(h);
    await settlement(h, o);
    await order(h);
    const input = { appId: h.appId, platform: 'taobao', runAt: new Date(RUN) };
    await expect(h.job.run(failItemWrite(h.db), input)).rejects.toThrow(
      'injected item write failure',
    );
    const failed = await state(h);
    expect(failed.bills.every((b) => b.generated_at === null)).toBe(true);
    expect(failed.jobs.every((j) => j.status !== 'done')).toBe(true);
    expect(failed.items).toEqual([]);
    expect(failed.vouchers).toEqual([]);
    expect(failed.balances).toEqual([]);
    // 故障恢复是新投递同一任务，不更改名义 run_at 来逃避幂等。
    expect((await createBillJob(h.deps).run(h.db, input)).outcome).toBe('generated');
    const recovered = await state(h);
    expect(recovered.jobs).toEqual([expect.objectContaining({ status: 'done' })]);
    expect(recovered.bills).toHaveLength(1);
    expect(recovered.batches).toHaveLength(1);
    expect(recovered.items).toEqual([expect.objectContaining({ order_id: o.id })]);
    expect(recovered.diffs).toHaveLength(0);
    expect(recovered.validations).toHaveLength(2);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04n#26] 校验结果保存失败不能留下成功账单，off 平台也不能静默丢失结果',
  async () => {
    const h = fixture(database.db);
    await snapshot(h);
    h.values.set('credit.enabled.taobao', 'off');
    await settlement(h, await order(h));
    h.saveValidations.mockRejectedValueOnce(new Error('injected validation failure'));
    await expect(h.run()).rejects.toThrow('injected validation failure');
    const failed = await state(h);
    expect(failed.jobs.every((j) => j.status !== 'done')).toBe(true);
    expect(failed.bills.every((b) => b.generated_at === null)).toBe(true);
    expect((await h.run()).outcome).toBe('generated');
    const s = await state(h);
    expect(s.validations).toHaveLength(1);
    expect(s.batches).toEqual([]);
  },
  TIMEOUT,
);
