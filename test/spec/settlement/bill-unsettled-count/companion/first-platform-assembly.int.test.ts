// B2-18aa 伴随规则测试（第 3 次写测，规则测试评审第 2 轮；D10-2449 ①，BR-FUND-04 ③④⑤）：本账单第一个平台经
// 生产装配（app.module 交给 SettlementModule.forWorker 的端口 → settle 处理器）出账、出账前该（应用、账单月）没有
// settle_bills 行，本轮有一单重生成端口真的被调用并抛错（regeneration_failed，不是未接端口的 regeneration_unavailable）；
// 写入应结未结数的那条 SQL 执行之后、提交之前故障 → 账单行、批次、明细、差错单、任务完成状态一起回滚。
// 两种故障接在同一个 worker 句柄上（先例：[AC-B2-18#3] 的 failVersionWrite、[AC-B2-18#13] 的 failAfterCountWrite；
// 两个插件叠在同一执行器上的写法同 register-write-only.int.test.ts）。夹具只读 import（../kit.ts、
// ../../bill-follow-union/kit.ts），不改。顶层 it()，不套 describe。
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { failAfterCountWrite } from '../kit.ts';
import {
  EXAMPLE_PEOPLE,
  TIMEOUT,
  alertsFor,
  app,
  batchesOf,
  billRow,
  countsOf,
  creditOn,
  databaseFixture,
  diffsOf,
  errorText,
  failVersionWrite,
  itemsFor,
  itemsOf,
  orderRow,
  seedOrder,
  settleJobsOf,
  versionsOf,
  voidOrder,
  withWorker,
  within,
  type App,
  type LogLine,
  type Outcome,
  type Seeded,
} from '../../bill-follow-union/kit.ts';

const pools = databaseFixture(createTestDatabase);

/** 一次投递的结果（'ok' 或错误文字）。 */
function shown(outcome: Outcome<unknown> | undefined): string {
  if (outcome === undefined) return 'not run';
  return outcome.ok ? 'ok' : errorText(outcome.error);
}

/** 自拟的一单（预留 0、自购 5000 / 直推 1000bp）：快照 v1 取 N snapshotN，联盟结算 settleFen（null：无结算数据）。 */
function plain(
  a: App,
  snapshotN: bigint,
  settleFen: bigint | null,
  patch: { readonly hold?: boolean } = {},
): Promise<Seeded> {
  return seedOrder(a, { snapshotN, settleFen, people: EXAMPLE_PEOPLE, ...patch });
}

/** 这些订单的整行（按传入顺序）。 */
function rowsOf(a: App, orders: readonly Seeded[]) {
  return Promise.all(orders.map((o) => orderRow(a, o)));
}

it(
  '[AC-B2-18aa#4] 生产装配、首个平台出账、出账前没有账单行、本轮 1 单重生成端口真的抛错（例 2：快照 1234、联盟结算 1100，写版本合计行失败 → regeneration_failed）：同一次出账里写入应结未结数的 SQL 执行之后再故障 → 投递失败，账单行仍不存在，批次、明细、差错单、各订单整行与跑之前相同，淘宝没有 done 的任务，重生成失败那单版本号与金额行原样；原键重试（版本写入故障仍在、计数写入故障撤掉）→ 任务 done，计数 error 1 / held 1 / unsettled 1 / amount_mismatch 1，账单合计 taobao 1 单 1000、受益人 600、平台 400，批次、明细、差错单各一份；再投同键不再变',
  async () => {
    const a = await app(pools.db);
    await creditOn(a);
    // 淘宝（本账单唯一、首个出账的平台），settle_period 都是账单月 2032-06：
    // 正常候选：快照 1000、结算 1000（预留 0）→ 基数 1000 = B_settle 1000；受益人 500 + 100 = 600，平台 400。
    const good = await plain(a, 1000n, 1000n);
    // VOID 对上联盟结算（STATEMENT 1000）→ 登记 union_mismatch，error_count 1。
    const voided = await plain(a, 1000n, 1000n);
    await voidOrder(a, voided);
    // 应结未结：无联盟结算数据 → unsettled_count 1。
    const unsettled = await plain(a, 1000n, null);
    // hold（有结算 1000）→ 暂缓，held_count 1。
    const held = await plain(a, 1000n, 1000n, { hold: true });
    // 金额不一致：快照 1234、联盟结算 1100 → B_settle 1100 ≠ 1234，重生成时写版本合计行失败 → amount_mismatch 1。
    const broken = await seedOrder(a, {
      snapshotN: 1234n,
      settleFen: 1100n,
      people: EXAMPLE_PEOPLE,
    });
    const all = [good, voided, unsettled, held, broken];

    // 出账前：该应用、账单月 2032-06 没有账单行，也没有批次、明细、差错单与任务行。
    expect(await billRow(a)).toBeUndefined();
    expect(await batchesOf(a)).toEqual([]);
    expect(await itemsOf(a)).toEqual([]);
    expect(await diffsOf(a)).toEqual([]);
    expect(await settleJobsOf(a)).toEqual([]);
    const ordersBefore = await rowsOf(a, all);
    const brokenVersionsBefore = await versionsOf(a, broken);
    expect(brokenVersionsBefore.totals.map((t) => [t.commission_version, t.base_fen])).toEqual([
      [1, 1234n],
    ]);

    // 两种故障叠在同一个 worker 句柄上：先让重生成写版本失败，再让写应结未结数的 SQL 执行后失败。
    const version = failVersionWrite(a.db, [broken.orderId]);
    const count = failAfterCountWrite(version.db);
    const faulted: { outcome?: Outcome<void>; lines?: LogLine[] } = {};
    await withWorker(
      a,
      async (w) => {
        faulted.lines = w.lines;
        faulted.outcome = await within(w.bill(), 'faulted bill');
      },
      { db: count.db },
    );

    // 重生成确实被调用并失败（版本写入故障命中），计数写入故障命中一次，投递失败带注入的错误。
    expect(version.fired).toBeGreaterThanOrEqual(1);
    const versionFiredAfterFault = version.fired;
    expect(alertsFor(faulted.lines ?? [], broken)).toHaveLength(1);
    expect(count.fired).toBe(1);
    expect(faulted.outcome?.ok).toBe(false);
    expect(shown(faulted.outcome)).toContain('injected count write failure');

    // 计数与出账同一事务：账单行不存在（与跑之前相同），其余都回到跑之前。
    expect(await billRow(a)).toBeUndefined();
    expect(await batchesOf(a)).toEqual([]);
    expect(await itemsOf(a)).toEqual([]);
    expect(await diffsOf(a)).toEqual([]);
    expect((await settleJobsOf(a)).filter((j) => j.status === 'done')).toEqual([]);
    expect(await rowsOf(a, all)).toEqual(ordersBefore);
    expect(await versionsOf(a, broken)).toEqual(brokenVersionsBefore);

    // 原键重试：取「版本写入故障仍在、计数写入故障撤掉」——重生成再次失败，这单仍是 amount_mismatch。
    const retried: { outcome?: Outcome<void>; lines?: LogLine[] } = {};
    const replayed: { outcome?: Outcome<void> } = {};
    const afterRetry: {
      bill?: Awaited<ReturnType<typeof billRow>>;
      batches?: Awaited<ReturnType<typeof batchesOf>>;
      items?: Awaited<ReturnType<typeof itemsOf>>;
      diffs?: Awaited<ReturnType<typeof diffsOf>>;
      jobs?: Awaited<ReturnType<typeof settleJobsOf>>;
    } = {};
    await withWorker(
      a,
      async (w) => {
        retried.lines = w.lines;
        retried.outcome = await within(w.bill(), 'retried bill');
        afterRetry.bill = await billRow(a);
        afterRetry.batches = await batchesOf(a);
        afterRetry.items = await itemsOf(a);
        afterRetry.diffs = await diffsOf(a);
        afterRetry.jobs = await settleJobsOf(a);
        replayed.outcome = await within(w.bill(), 'replayed bill');
      },
      { db: version.db },
    );

    expect(shown(retried.outcome)).toBe('ok');
    expect(version.fired).toBeGreaterThan(versionFiredAfterFault);
    expect(alertsFor(retried.lines ?? [], broken)).toHaveLength(1);
    expect(count.fired).toBe(1);

    // 重试后各落一份，计数与合计是具体数。
    expect(afterRetry.bill).toMatchObject({
      bill_id: '2032-06',
      platform_order_counts: { taobao: 1 },
      platform_settle_commission_totals: { taobao: '1000' },
      beneficiary_total_fen: 600n,
      platform_retained_fen: 400n,
      error_count: 1,
      held_count: 1,
      unsettled_count: 1,
      amount_mismatch_count: 1,
    });
    expect(afterRetry.jobs?.map((j) => [j.platform, j.status])).toEqual([['taobao', 'done']]);
    expect(afterRetry.batches).toEqual([
      expect.objectContaining({
        platform: 'taobao',
        kind: 'main',
        status: 'DRAFT',
        order_count: 1,
      }),
    ]);
    expect(afterRetry.items).toEqual([
      expect.objectContaining({
        item_type: 'order',
        order_id: good.orderId,
        settle_seq: 1,
        b_settle_fen: 1000n,
      }),
    ]);
    expect(afterRetry.diffs).toEqual([
      expect.objectContaining({
        type: 'union_mismatch',
        ref_type: 'order',
        ref_id: voided.orderKey,
        period: '2032-06',
      }),
    ]);
    // 重生成失败的单：不进批次、版本号与金额行原样、仍指向 v1。
    expect(await itemsFor(a, broken)).toEqual([]);
    expect(await versionsOf(a, broken)).toEqual(brokenVersionsBefore);
    expect(await orderRow(a, broken)).toMatchObject({
      rebate_status: 'WAITING',
      commission_version: 1,
    });
    // 其余订单行不因出账而变。
    expect(await rowsOf(a, [good, voided, unsettled, held])).toEqual(ordersBefore.slice(0, 4));

    // 再投同键：不再变。
    expect(shown(replayed.outcome)).toBe('ok');
    expect(await billRow(a)).toEqual(afterRetry.bill);
    expect(await countsOf(a)).toEqual({
      error_count: 1,
      held_count: 1,
      unsettled_count: 1,
      amount_mismatch_count: 1,
    });
    expect(await batchesOf(a)).toEqual(afterRetry.batches);
    expect(await itemsOf(a)).toEqual(afterRetry.items);
    expect(await diffsOf(a)).toEqual(afterRetry.diffs);
    expect(await settleJobsOf(a)).toEqual(afterRetry.jobs);
    expect(await versionsOf(a, broken)).toEqual(brokenVersionsBefore);
  },
  TIMEOUT,
);
