// B2-18aa 伴随规则测试（FU-B2-18A-SPEC-R2-GAPS 缺口 ①；BR-FUND-04 ③⑤，D10-2449 ①）：本账单第一个平台出账、
// 出账前该（应用、账单月）没有 settle_bills 行时，应结未结数与账单合计、批次、明细、差错单、任务完成状态在同一事务
// 写入。写入应结未结数的那条 SQL 执行之后、提交之前故障 → 一起回滚（账单行仍不存在）；原键重试后各落一份、计数为
// 具体数；第二个平台接着出账后计数是两个平台之和。
// [#3]（第 2 次写测，规则测试评审第 1 轮第 1 条）：同一场景再加一单「重生成后仍不一致」（amount_mismatch_count 为 1），
// 钉住「只在首个平台建账单且本轮有金额不一致时把整条合计与计数 UPDATE 挪到提交后」的拆事务实现。金额不一致的单照
// ../../bill-follow-union/counts.int.test.ts（[AC-B2-18#27]–[#29]）的写法：../../bill/kit.ts 手工组装的任务不注入
// 重生成端口，快照基数 850、联盟结算 9000 → B_settle 7650 ≠ 850，算重生成失败，计 1 进 amount_mismatch_count。
// 夹具只读 import（../kit.ts、../../bill/kit.ts），不改。顶层 it()，不套 describe。
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { createBillJob } from '../../../../../apps/api/src/modules/settlement/bill/job.ts';
import {
  databaseFixture,
  fixture,
  order,
  settlement,
  snapshot,
  state,
  validations,
  RUN,
  TIMEOUT,
  type Fixture,
  type Order,
} from '../../bill/kit.ts';
import { billCounts, failAfterCountWrite } from '../kit.ts';

const database = databaseFixture(createTestDatabase);

it(
  '[AC-B2-18aa#1] 首个平台出账、出账前没有账单行：写入应结未结数的 SQL 执行之后故障 → 账单行仍不存在，批次、明细、差错单、校验结果与跑之前相同，淘宝没有 done 的任务；原键重试 generated，计数 error 1 / held 1 / unsettled 1 / amount_mismatch 0，批次、明细、差错单各一份，再投 duplicate 不变；京东接着出账后计数为两平台之和 2 / 2 / 3 / 0',
  async () => {
    const h = fixture(database.db);
    await snapshot(h);
    // 淘宝（首个出账的平台）：1 单候选（结算 1000 → B_settle 850）、1 单 VOID 对上联盟结算（union_mismatch）、
    // 1 单应结未结、1 单 hold。
    const good = await order(h);
    await settlement(h, good);
    const voided = await order(h, { rebateStatus: 'VOID' });
    await settlement(h, voided);
    await order(h);
    await order(h, { hold: true });
    // 京东（第二个出账的平台）：1 单候选、1 单 VOID 对上联盟结算、2 单应结未结、1 单维权中。
    const jdGood = await order(h, {}, 'jd');
    await settlement(h, jdGood);
    const jdVoided = await order(h, { rebateStatus: 'VOID' }, 'jd');
    await settlement(h, jdVoided);
    await order(h, {}, 'jd');
    await order(h, {}, 'jd');
    await order(h, { rightsPending: true }, 'jd');

    // 出账前：该应用、账单月 2032-06 没有账单行。
    expect(await billCounts(h.db, h.appId)).toBeNull();
    const before = await state(h);
    expect(before.bills).toEqual([]);
    expect(before.jobs).toEqual([]);
    const input = { appId: h.appId, platform: 'taobao', runAt: new Date(RUN) };

    const faulty = failAfterCountWrite(h.db);
    await expect(h.job.run(faulty.db, input)).rejects.toThrow('injected count write failure');
    expect(faulty.fired).toBe(1);

    // 计数与出账同一事务：故障后账单行不存在（与跑之前相同），其余都回到跑之前。
    const failed = await state(h);
    expect(await billCounts(h.db, h.appId)).toBeNull();
    expect(failed.bills).toEqual([]);
    expect(failed.batches).toEqual(before.batches);
    expect(failed.items).toEqual(before.items);
    expect(failed.diffs).toEqual(before.diffs);
    expect(failed.validations).toEqual(before.validations);
    expect(failed.jobs.filter((j) => j.status === 'done')).toEqual([]);

    // 原键重试（不带故障的句柄）：各落一份，计数是具体数。
    expect((await createBillJob(h.deps).run(h.db, input)).outcome).toBe('generated');
    const taobaoOnly = {
      error_count: 1,
      held_count: 1,
      unsettled_count: 1,
      amount_mismatch_count: 0,
    };
    expect(await billCounts(h.db, h.appId)).toEqual(taobaoOnly);
    const recovered = await state(h);
    expect(recovered.bills).toEqual([
      expect.objectContaining({
        bill_id: '2032-06',
        platform_order_counts: { taobao: 1 },
        platform_settle_commission_totals: { taobao: '1000' },
        beneficiary_total_fen: 552n,
        platform_retained_fen: 298n,
      }),
    ]);
    expect(recovered.jobs.map((j) => [j.platform, j.status])).toEqual([['taobao', 'done']]);
    expect(recovered.batches).toEqual([
      expect.objectContaining({ platform: 'taobao', kind: 'main', order_count: 1 }),
    ]);
    expect(recovered.items).toEqual([
      expect.objectContaining({ order_id: good.id, b_settle_fen: 850n }),
    ]);
    expect(recovered.diffs).toEqual([
      expect.objectContaining({ type: 'union_mismatch', ref_id: voided.key, period: '2032-06' }),
    ]);
    expect(recovered.validations).toHaveLength(4);

    // 再投同键：duplicate，什么都不再变。
    expect((await createBillJob(h.deps).run(h.db, input)).outcome).toBe('duplicate');
    expect(await state(h)).toEqual(recovered);
    expect(await billCounts(h.db, h.appId)).toEqual(taobaoOnly);

    // 京东接着出账：计数是两个平台之和（首个平台的数没有被覆盖、也没有漏加）。
    expect((await h.run('jd')).outcome).toBe('generated');
    expect(await billCounts(h.db, h.appId)).toEqual({
      error_count: 2,
      held_count: 2,
      unsettled_count: 3,
      amount_mismatch_count: 0,
    });
    const both = await state(h);
    expect(both.bills).toEqual([
      expect.objectContaining({
        platform_order_counts: { taobao: 1, jd: 1 },
        platform_settle_commission_totals: { taobao: '1000', jd: '1000' },
        beneficiary_total_fen: 1104n,
        platform_retained_fen: 596n,
      }),
    ]);
    expect(both.jobs.map((j) => [j.platform, j.status]).sort()).toEqual([
      ['jd', 'done'],
      ['taobao', 'done'],
    ]);
    expect(both.batches.map((b) => [b.platform, b.kind, b.order_count]).sort()).toEqual([
      ['jd', 'main', 1],
      ['taobao', 'main', 1],
    ]);
    expect(both.items.map((i) => i.order_id).sort()).toEqual([good.id, jdGood.id].sort());
    expect(both.diffs.map((d) => [d.type, d.ref_id]).sort()).toEqual(
      [
        ['union_mismatch', voided.key],
        ['union_mismatch', jdVoided.key],
      ].sort(),
    );
    expect(both.validations).toHaveLength(4 + 5);
  },
  TIMEOUT,
);

/** 某单已有的金额版本号（commission_split_totals，升序）。 */
async function versionsOf(h: Fixture, o: Order): Promise<number[]> {
  const rows = await h.db
    .selectFrom('commission_split_totals')
    .select('commission_version')
    .where('app_id', '=', h.appId)
    .where('order_id', '=', o.id)
    .orderBy('commission_version')
    .execute();
  return rows.map((r) => r.commission_version);
}

it(
  '[AC-B2-18aa#3] 首个平台出账、出账前没有账单行、本轮有 1 单重生成后仍不一致（不注入重生成端口，结算 9000 → B_settle 7650 ≠ 快照 850）：写入应结未结数的 SQL 执行之后故障 → 账单行仍不存在，批次、明细、差错单、校验结果与跑之前相同，淘宝没有 done 的任务；原键重试 generated，计数 error 1 / held 1 / unsettled 1 / amount_mismatch 1，账单合计 taobao 1 单 1000、受益人 552、平台 298，批次、明细、差错单各一份，再投 duplicate 不变；京东（也有 1 单金额不一致）接着出账后计数为两平台之和 2 / 2 / 3 / 2',
  async () => {
    const h = fixture(database.db);
    await snapshot(h);
    // 淘宝（首个出账的平台）：1 单候选（结算 1000 → B_settle 850）、1 单 VOID 对上联盟结算（union_mismatch）、
    // 1 单金额不一致（结算 9000 → B_settle 7650）、1 单应结未结、1 单 hold。
    const good = await order(h);
    await settlement(h, good);
    const voided = await order(h, { rebateStatus: 'VOID' });
    await settlement(h, voided);
    const mismatched = await order(h);
    await settlement(h, mismatched, { settle_commission_fen: 9000n });
    await order(h);
    await order(h, { hold: true });
    // 京东（第二个出账的平台）：1 单候选、1 单 VOID 对上联盟结算、1 单金额不一致、2 单应结未结、1 单维权中。
    const jdGood = await order(h, {}, 'jd');
    await settlement(h, jdGood);
    const jdVoided = await order(h, { rebateStatus: 'VOID' }, 'jd');
    await settlement(h, jdVoided);
    const jdMismatched = await order(h, {}, 'jd');
    await settlement(h, jdMismatched, { settle_commission_fen: 9000n });
    await order(h, {}, 'jd');
    await order(h, {}, 'jd');
    await order(h, { rightsPending: true }, 'jd');

    // 出账前：该应用、账单月 2032-06 没有账单行。
    expect(await billCounts(h.db, h.appId)).toBeNull();
    const before = await state(h);
    expect(before.bills).toEqual([]);
    expect(before.jobs).toEqual([]);
    expect(await versionsOf(h, mismatched)).toEqual([1]);
    const input = { appId: h.appId, platform: 'taobao', runAt: new Date(RUN) };

    const faulty = failAfterCountWrite(h.db);
    await expect(h.job.run(faulty.db, input)).rejects.toThrow('injected count write failure');
    expect(faulty.fired).toBe(1);

    // 计数与出账同一事务：故障后账单行不存在（与跑之前相同），其余都回到跑之前。
    const failed = await state(h);
    expect(await billCounts(h.db, h.appId)).toBeNull();
    expect(failed.bills).toEqual([]);
    expect(failed.batches).toEqual(before.batches);
    expect(failed.items).toEqual(before.items);
    expect(failed.diffs).toEqual(before.diffs);
    expect(failed.validations).toEqual(before.validations);
    expect(failed.jobs.filter((j) => j.status === 'done')).toEqual([]);
    expect(await versionsOf(h, mismatched)).toEqual([1]);

    // 原键重试（不带故障的句柄）：各落一份，计数是具体数（金额不一致 1）。
    expect((await createBillJob(h.deps).run(h.db, input)).outcome).toBe('generated');
    const taobaoOnly = {
      error_count: 1,
      held_count: 1,
      unsettled_count: 1,
      amount_mismatch_count: 1,
    };
    expect(await billCounts(h.db, h.appId)).toEqual(taobaoOnly);
    const recovered = await state(h);
    expect(recovered.bills).toEqual([
      expect.objectContaining({
        bill_id: '2032-06',
        platform_order_counts: { taobao: 1 },
        platform_settle_commission_totals: { taobao: '1000' },
        beneficiary_total_fen: 552n,
        platform_retained_fen: 298n,
      }),
    ]);
    expect(recovered.jobs.map((j) => [j.platform, j.status])).toEqual([['taobao', 'done']]);
    expect(recovered.batches).toEqual([
      expect.objectContaining({ platform: 'taobao', kind: 'main', order_count: 1 }),
    ]);
    // 金额不一致的单不进批次。
    expect(recovered.items).toEqual([
      expect.objectContaining({ order_id: good.id, b_settle_fen: 850n }),
    ]);
    // 金额不一致不登记差错单：只有 VOID 那一张。
    expect(recovered.diffs).toEqual([
      expect.objectContaining({ type: 'union_mismatch', ref_id: voided.key, period: '2032-06' }),
    ]);
    expect(recovered.validations).toHaveLength(5);
    const mismatchRows = (await validations(h)).filter((v) => v.orderId === mismatched.id);
    expect(mismatchRows.map((v) => v.result)).toEqual(['amount_mismatch']);
    // 重生成失败：没有新版本。
    expect(await versionsOf(h, mismatched)).toEqual([1]);

    // 再投同键：duplicate，什么都不再变。
    expect((await createBillJob(h.deps).run(h.db, input)).outcome).toBe('duplicate');
    expect(await state(h)).toEqual(recovered);
    expect(await billCounts(h.db, h.appId)).toEqual(taobaoOnly);

    // 京东接着出账：计数是两个平台之和（首个平台的数没有被覆盖、也没有漏加）。
    expect((await h.run('jd')).outcome).toBe('generated');
    expect(await billCounts(h.db, h.appId)).toEqual({
      error_count: 2,
      held_count: 2,
      unsettled_count: 3,
      amount_mismatch_count: 2,
    });
    const both = await state(h);
    expect(both.bills).toEqual([
      expect.objectContaining({
        platform_order_counts: { taobao: 1, jd: 1 },
        platform_settle_commission_totals: { taobao: '1000', jd: '1000' },
        beneficiary_total_fen: 1104n,
        platform_retained_fen: 596n,
      }),
    ]);
    expect(both.jobs.map((j) => [j.platform, j.status]).sort()).toEqual([
      ['jd', 'done'],
      ['taobao', 'done'],
    ]);
    expect(both.batches.map((b) => [b.platform, b.kind, b.order_count]).sort()).toEqual([
      ['jd', 'main', 1],
      ['taobao', 'main', 1],
    ]);
    expect(both.items.map((i) => i.order_id).sort()).toEqual([good.id, jdGood.id].sort());
    expect(both.diffs.map((d) => [d.type, d.ref_id]).sort()).toEqual(
      [
        ['union_mismatch', voided.key],
        ['union_mismatch', jdVoided.key],
      ].sort(),
    );
    expect(both.validations).toHaveLength(5 + 6);
  },
  TIMEOUT,
);
