// B2-18aa 伴随规则测试（FU-B2-18A-SPEC-R2-GAPS 缺口 ③；BR-FUND-04 ②③④，D10-2449 ③）：settle_period 为上一个
// 账单月、结算数据在上一期账单日之后才取得的 WAITING 单，本期账单日任务把它收进本期主批次；任务跑完后库里的
// app.orders 行逐列不变（settle_period 仍是原月，不改成账单月），同批的本期候选与本期应结未结的单也逐列不变；
// 上一期账单行不因本期任务而变，本期不把它计为应结未结。
// 走生产装配：../../bill-follow-union/kit.ts 的 withWorker（app.module 在 worker 入口交给
// SettlementModule.forWorker 的端口 → settle 处理器，真实账单任务与生产 readSource）、seedOrder（真实 orders 行与
// 分佣快照 v1）、settleLater（结算记录后到并跟上订单行）。夹具只读 import，不改。顶层 it()，不套 describe。
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  BILL_MONTH,
  EXAMPLE_PEOPLE,
  TIMEOUT,
  app,
  batchesOf,
  billRow,
  countsOf,
  creditOn,
  databaseFixture,
  diffsOf,
  itemsOf,
  orderRow,
  seedOrder,
  settleJobsOf,
  settleLater,
  withWorker,
} from '../../bill-follow-union/kit.ts';

const pools = databaseFixture(createTestDatabase);

/** 上一个账单月（本期账单月 BILL_MONTH = 2032-06）。 */
const PREVIOUS_MONTH = '2032-05';
/** 上一期（2032-05）的账单日 2032-06-24 00:00 +08:00 之后的出账时刻。 */
const PREVIOUS_BILL_AT = '2032-06-24T00:40:00+08:00';
/** 上一期订单的写入时刻（也是应用规则版本的生效时刻）。 */
const EARLY = '2032-05-20T10:00:00+08:00';
/** 本期订单的写入时刻。 */
const CURRENT = '2032-06-20T10:00:00+08:00';
/** 上一期账单日之后、本期账单日（2032-07-24）之前才取得的联盟结算数据。 */
const ARRIVED = '2032-07-02T10:00:00+08:00';

it(
  '[AC-B2-18aa#2] 生产装配的账单日任务：settle_period 2032-05、结算数据 07-02 才到的 WAITING 单进 2032-06 主批次（settle_seq 1、b_settle 1000），任务后从库里重读该订单行逐列不变（settle_period 仍 2032-05、仍 WAITING），同批本期候选与本期应结未结单的行也逐列不变；2032-05 账单行不变，2032-06 应结未结只计本期那 1 单',
  async () => {
    const a = await app(pools.db, { at: new Date(EARLY) });
    await creditOn(a);
    // 上一期的单：确认收货在 2032-05，上一期账单日时没有结算数据（计过应结未结），07-02 联盟结算 1000。
    // 快照 v1：N 1000、预留 0 → 基数 1000，自购 500 / 直推 100，平台 400。
    const late = await seedOrder(
      { ...a, period: PREVIOUS_MONTH },
      { snapshotN: 1000n, settleFen: null, people: EXAMPLE_PEOPLE },
    );
    await settleLater({ ...a, at: new Date(ARRIVED) }, late, { seq: 1, fen: 1000n });
    // 本期的单：一单已有结算 1000（候选），一单截至生成开始仍无结算数据（应结未结）。
    const current = { ...a, at: new Date(CURRENT) };
    const good = await seedOrder(current, {
      snapshotN: 1000n,
      settleFen: 1000n,
      people: EXAMPLE_PEOPLE,
    });
    const missing = await seedOrder(current, {
      snapshotN: 1000n,
      settleFen: null,
      people: EXAMPLE_PEOPLE,
    });
    // 上一期账单行：出账时 late 计为应结未结 1，没有主批次。
    await a.db
      .insertInto('settle_bills')
      .values({
        app_id: a.appId,
        bill_id: PREVIOUS_MONTH,
        generation_started_at: new Date(PREVIOUS_BILL_AT),
        generated_at: new Date(PREVIOUS_BILL_AT),
        platform_order_counts: JSON.stringify({ taobao: 0 }),
        platform_settle_commission_totals: JSON.stringify({ taobao: '0' }),
        beneficiary_total_fen: 0n,
        platform_retained_fen: 0n,
        error_count: 0,
        held_count: 0,
        unsettled_count: 1,
        amount_mismatch_count: 0,
        created_at: new Date(PREVIOUS_BILL_AT),
      })
      .execute();

    const lateBefore = await orderRow(a, late);
    expect(lateBefore).toMatchObject({
      settle_period: PREVIOUS_MONTH,
      rebate_status: 'WAITING',
      settle_commission_fen: 1000n,
    });
    const goodBefore = await orderRow(a, good);
    const missingBefore = await orderRow(a, missing);
    const previousBefore = await billRow(a, PREVIOUS_MONTH);
    expect(previousBefore).toBeDefined();
    expect(await billRow(a, BILL_MONTH)).toBeUndefined();

    await withWorker(a, async (w) => {
      await w.bill();
    });

    expect(await settleJobsOf(a)).toEqual([
      expect.objectContaining({ job: 'bill', platform: 'taobao', status: 'done' }),
    ]);
    // 本期主批次收进后到的上一期单与本期候选：各 B_settle 1000（预留 0）、settle_seq 1。
    const batches = await batchesOf(a);
    expect(batches).toEqual([
      expect.objectContaining({
        bill_id: BILL_MONTH,
        platform: 'taobao',
        kind: 'main',
        status: 'DRAFT',
        order_count: 2,
      }),
    ]);
    const items = (await itemsOf(a)).map((i) => [
      i.batch_id,
      i.item_type,
      i.order_id,
      i.settle_seq,
      i.b_settle_fen,
    ]);
    expect(items.sort()).toEqual(
      [
        [batches[0]!.batch_id, 'order', late.orderId, 1, 1000n],
        [batches[0]!.batch_id, 'order', good.orderId, 1, 1000n],
      ].sort(),
    );
    // 两单各 1000：受益人 500 + 100、平台 400。
    expect(await billRow(a, BILL_MONTH)).toMatchObject({
      platform_order_counts: { taobao: 2 },
      platform_settle_commission_totals: { taobao: '2000' },
      beneficiary_total_fen: 1200n,
      platform_retained_fen: 800n,
    });
    // 本期只把本期仍无结算数据的 missing 计为应结未结；后到的上一期单不计。
    expect(await countsOf(a, BILL_MONTH)).toEqual({
      error_count: 0,
      held_count: 0,
      unsettled_count: 1,
      amount_mismatch_count: 0,
    });
    // 上一期账单行一字不动（计数保持出账时的值）。
    expect(await billRow(a, PREVIOUS_MONTH)).toEqual(previousBefore);
    expect(await countsOf(a, PREVIOUS_MONTH)).toEqual({
      error_count: 0,
      held_count: 0,
      unsettled_count: 1,
      amount_mismatch_count: 0,
    });
    // 从库里重读订单行：逐列与跑之前相同，settle_period 仍是原来的月份。
    const lateAfter = await orderRow(a, late);
    expect(lateAfter).toEqual(lateBefore);
    expect(lateAfter.settle_period).toBe(PREVIOUS_MONTH);
    expect(lateAfter.rebate_status).toBe('WAITING');
    expect(await orderRow(a, good)).toEqual(goodBefore);
    expect(await orderRow(a, missing)).toEqual(missingBefore);
    expect(await diffsOf(a)).toEqual([]);
  },
  TIMEOUT,
);
