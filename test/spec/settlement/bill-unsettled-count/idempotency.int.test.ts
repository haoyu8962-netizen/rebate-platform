// B2-18a：应结未结数与差错单的幂等与并发（BR-FUND-04 ③④，迁移后 settle_bills.unsettled_count）。
// 原冻结用例 [AC-B2-04n#22]、[#25] 用「无结算数据的单」钉「差错单只登记一份 / 不残留」；改后那张单不再有
// 差错单，这里换成「VOID 单对上联盟结算」（union_mismatch，仍会登记）钉同样的并发同键与故障恢复。
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { createBillJob } from '../../../../apps/api/src/modules/settlement/bill/job.ts';
import {
  databaseFixture,
  failItemWrite,
  fixture,
  order,
  settlement,
  snapshot,
  state,
  RUN,
  TIMEOUT,
  type Fixture,
} from '../bill/kit.ts';
import { billCounts, failAfterCountWrite } from './kit.ts';

const database = databaseFixture(createTestDatabase);

/** 一单候选、一单 VOID 对上联盟结算（union_mismatch）、一单应结未结。 */
async function mixed(h: Fixture) {
  await snapshot(h);
  const good = await order(h);
  await settlement(h, good);
  const voided = await order(h, { rebateStatus: 'VOID' });
  await settlement(h, voided);
  const missing = await order(h);
  return { good, voided, missing };
}

it(
  '[AC-B2-18a#7] 同一平台同一账单重复投递：同 run_at 重放、另一 run_at 再投都答 duplicate，unsettled_count 不重复累加',
  async () => {
    const h = fixture(database.db);
    await snapshot(h);
    await order(h);
    await order(h);
    expect((await h.run()).outcome).toBe('generated');
    const counts = {
      error_count: 0,
      held_count: 0,
      unsettled_count: 2,
      amount_mismatch_count: null,
    };
    expect(await billCounts(h.db, h.appId)).toEqual(counts);
    const first = await state(h);

    expect((await h.run()).outcome).toBe('duplicate');
    expect(await billCounts(h.db, h.appId)).toEqual(counts);
    // 同一账单日的另一名义时刻：账单上该平台已出过主批次，duplicate，不再累加。
    const other = await h.run('taobao', new Date('2032-07-24T00:05:00+08:00'));
    expect(other.outcome).toBe('duplicate');
    expect(await billCounts(h.db, h.appId)).toEqual(counts);
    // 新建的服务实例重放同一键也一样。
    const input = { appId: h.appId, platform: 'taobao', runAt: new Date(RUN) };
    const replay = await createBillJob(h.deps).run(h.db, input);
    expect(replay.outcome).toBe('duplicate');
    expect(await billCounts(h.db, h.appId)).toEqual(counts);
    const s = await state(h);
    expect(s.bills).toEqual(first.bills);
    expect(s.diffs).toEqual([]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-18a#8] 两个独立运行器并发同键：只生成一份任务与批次，union_mismatch 差错单恰一张、不重复，不登记 settle_missing；unsettled_count 只累加一次',
  async () => {
    const h = fixture(database.db);
    const { good, voided } = await mixed(h);
    const otherRunner = createBillJob(h.deps);
    const input = { appId: h.appId, platform: 'taobao', runAt: new Date(RUN) };

    const results = await Promise.all([h.job.run(h.db, input), otherRunner.run(h.db, input)]);

    expect(results.map((r) => r.outcome).sort()).toEqual(['duplicate', 'generated']);
    const s = await state(h);
    expect(s.jobs).toEqual([expect.objectContaining({ job: 'bill', status: 'done' })]);
    expect(s.batches).toHaveLength(1);
    expect(s.items).toEqual([expect.objectContaining({ order_id: good.id })]);
    expect(s.diffs).toEqual([
      expect.objectContaining({ type: 'union_mismatch', ref_id: voided.key, period: '2032-06' }),
    ]);
    expect(s.validations).toHaveLength(3);
    expect(await billCounts(h.db, h.appId)).toEqual({
      error_count: 1,
      held_count: 0,
      unsettled_count: 1,
      amount_mismatch_count: null,
    });
    const types = h.registerDiff.mock.calls.map((call) => call[1].type);
    expect(types).not.toContain('settle_missing');
  },
  TIMEOUT,
);

it(
  '[AC-B2-18a#9] 明细写入后故障整事务回滚：不留账单计数与差错单；原键重试后 union_mismatch 恰一张、unsettled_count 1，不多计',
  async () => {
    const h = fixture(database.db);
    const { good, voided } = await mixed(h);
    const input = { appId: h.appId, platform: 'taobao', runAt: new Date(RUN) };

    await expect(h.job.run(failItemWrite(h.db), input)).rejects.toThrow(
      'injected item write failure',
    );
    const failed = await state(h);
    expect(failed.diffs).toEqual([]);
    expect(failed.items).toEqual([]);
    expect(failed.bills.every((b) => b.generated_at === null)).toBe(true);
    expect(failed.jobs.every((j) => j.status !== 'done')).toBe(true);

    expect((await createBillJob(h.deps).run(h.db, input)).outcome).toBe('generated');
    const recovered = await state(h);
    expect(recovered.jobs).toEqual([expect.objectContaining({ status: 'done' })]);
    expect(recovered.batches).toHaveLength(1);
    expect(recovered.items).toEqual([expect.objectContaining({ order_id: good.id })]);
    expect(recovered.diffs).toEqual([
      expect.objectContaining({ type: 'union_mismatch', ref_id: voided.key, period: '2032-06' }),
    ]);
    expect(recovered.validations).toHaveLength(3);
    expect(await billCounts(h.db, h.appId)).toEqual({
      error_count: 1,
      held_count: 0,
      unsettled_count: 1,
      amount_mismatch_count: null,
    });

    // 再重放一次：duplicate，计数与差错单都不变。
    expect((await createBillJob(h.deps).run(h.db, input)).outcome).toBe('duplicate');
    expect(await state(h)).toEqual(recovered);
    expect(await billCounts(h.db, h.appId)).toEqual({
      error_count: 1,
      held_count: 0,
      unsettled_count: 1,
      amount_mismatch_count: null,
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-18a#22] 计数与出账同一事务：写入应结未结数的那条 SQL 执行之后、提交之前故障 → 账单三个计数、合计、任务完成状态、批次、明细与差错单全部回到跑之前；原键重试后计数各累加一次、差错单与批次各一份',
  async () => {
    const h = fixture(database.db);
    await snapshot(h);
    // 京东先出账，账单行带非零计数：1 单应结未结、1 单 hold、1 单 VOID 对上联盟结算。
    await order(h, {}, 'jd');
    await order(h, { hold: true }, 'jd');
    const jdVoided = await order(h, { rebateStatus: 'VOID' }, 'jd');
    await settlement(h, jdVoided);
    expect((await h.run('jd')).outcome).toBe('generated');
    const jdOnly = {
      error_count: 1,
      held_count: 1,
      unsettled_count: 1,
      amount_mismatch_count: null,
    };
    expect(await billCounts(h.db, h.appId)).toEqual(jdOnly);
    // 淘宝：1 单候选、1 单 VOID 对上联盟结算、1 单应结未结、1 单维权中。
    const good = await order(h);
    await settlement(h, good);
    const voided = await order(h, { rebateStatus: 'VOID' });
    await settlement(h, voided);
    await order(h);
    await order(h, { rightsPending: true });
    const before = await state(h);
    const input = { appId: h.appId, platform: 'taobao', runAt: new Date(RUN) };

    const faulty = failAfterCountWrite(h.db);
    await expect(h.job.run(faulty.db, input)).rejects.toThrow('injected count write failure');
    expect(faulty.fired).toBe(1);

    const failed = await state(h);
    expect(await billCounts(h.db, h.appId)).toEqual(jdOnly);
    expect(failed.bills).toEqual(before.bills);
    expect(failed.batches).toEqual(before.batches);
    expect(failed.items).toEqual(before.items);
    expect(failed.diffs).toEqual(before.diffs);
    expect(failed.validations).toEqual(before.validations);
    expect(failed.jobs.filter((j) => j.platform === 'jd')).toEqual(
      before.jobs.filter((j) => j.platform === 'jd'),
    );
    expect(failed.jobs.filter((j) => j.platform === 'taobao' && j.status === 'done')).toEqual([]);

    expect((await createBillJob(h.deps).run(h.db, input)).outcome).toBe('generated');
    expect(await billCounts(h.db, h.appId)).toEqual({
      error_count: 2,
      held_count: 2,
      unsettled_count: 2,
      amount_mismatch_count: null,
    });
    const recovered = await state(h);
    expect(recovered.bills).toEqual([
      expect.objectContaining({
        platform_order_counts: { jd: 0, taobao: 1 },
        platform_settle_commission_totals: { jd: '0', taobao: '1000' },
        beneficiary_total_fen: 552n,
        platform_retained_fen: 298n,
      }),
    ]);
    expect(recovered.jobs.map((j) => [j.platform, j.status]).sort()).toEqual([
      ['jd', 'done'],
      ['taobao', 'done'],
    ]);
    expect(recovered.batches).toEqual([
      expect.objectContaining({ platform: 'taobao', kind: 'main', order_count: 1 }),
    ]);
    expect(recovered.items).toEqual([expect.objectContaining({ order_id: good.id })]);
    expect(recovered.diffs.map((d) => [d.type, d.ref_id]).sort()).toEqual(
      [
        ['union_mismatch', jdVoided.key],
        ['union_mismatch', voided.key],
      ].sort(),
    );
    expect(recovered.validations).toHaveLength(3 + 4);

    // 再投一次同键：duplicate，什么都不再变。
    expect((await createBillJob(h.deps).run(h.db, input)).outcome).toBe('duplicate');
    expect(await state(h)).toEqual(recovered);
  },
  TIMEOUT,
);
