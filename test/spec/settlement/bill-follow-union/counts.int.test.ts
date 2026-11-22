// B2-18：settle_bills.amount_mismatch_count 与 unsettled_count 同一口径（编排 D10-2521 ①）——同一条 UPDATE、同一
// 事务、同一把账单行锁内按读出的旧值累加（BR-FUND-04 ③⑤；评审第 7 条：取较大值、或事务里另起第二条 UPDATE 写
// 金额不一致数的实现都要红）。账单日任务用冻结的 ../bill/kit.ts 手工组装（不注入重生成端口、只 import 不改）：
// 金额不一致的单按 9.2 第 4 条算重生成失败，各计 1 进 amount_mismatch_count。屏障、语句观察与计数写入后故障照
// ../bill-unsettled-count/kit.ts 的写法（只 import 不改）。等待都有界：屏障用 within（WAIT_MS），锁等待用
// waitBlocked（服务端 pg_blocking_pids）。顶层 it()（规划/11 §4.3）。
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  RUN,
  fixture,
  order,
  settlement,
  snapshot,
  state,
  type Fixture,
  type Order,
} from '../bill/kit.ts';
import {
  backendPid,
  billCounts,
  billWrites,
  failAfterCountWrite,
  pauseAtBillLock,
  tracing,
  waitBlocked,
} from '../bill-unsettled-count/kit.ts';
import { TIMEOUT, databaseFixture, errorText, within } from './kit.ts';

const pools = databaseFixture(createTestDatabase);

const input = (h: Fixture, platform: string) => ({
  appId: h.appId,
  platform,
  runAt: new Date(RUN),
});

/**
 * 自拟的一个平台：fixture 的快照基数 850（N 1000、预留 1500bp），联盟结算 1000 → B_settle 850 一致；
 * 结算 9000 → floor(9000 × 8500 / 10000) = 7650 ≠ 850 金额不一致。
 */
async function platformOrders(
  h: Fixture,
  platform: string,
  counts: { readonly mismatched: number; readonly unsettled: number; readonly held: number },
) {
  const good = await order(h, {}, platform);
  await settlement(h, good);
  const mismatched: Order[] = [];
  for (let i = 0; i < counts.mismatched; i += 1) {
    const o = await order(h, {}, platform);
    await settlement(h, o, { settle_commission_fen: 9000n });
    mismatched.push(o);
  }
  for (let i = 0; i < counts.unsettled; i += 1) await order(h, {}, platform);
  for (let i = 0; i < counts.held; i += 1) await order(h, { hold: true }, platform);
  return { good, mismatched };
}

/** 写 settle_bills 且点名某列的语句。 */
function writesNaming(queries: readonly string[], column: string): string[] {
  const named = new RegExp(`\\b${column}\\b`, 'i');
  return billWrites(queries).filter((q) => named.test(q));
}

it.each([
  { first: 'taobao', second: 'jd' },
  { first: 'jd', second: 'taobao' },
])(
  '[AC-B2-18#27] 两个平台都有重生成后仍不一致的单（taobao 1 张、jd 2 张；手工组装、不注入重生成端口）：$first 持账单行锁时 $second 在锁上等待，放行后两平台都出账 → amount_mismatch_count 3（1 + 2，取较大值的实现得 2），unsettled_count 2、held_count 1、error_count 0（金额不一致不计 error_count、不登记差错单）；两平台主批次各只含候选 1 单',
  async ({ first, second }) => {
    const h = fixture(pools.db);
    await snapshot(h);
    // 先由第三个平台（pdd，无订单）出账，让账单行在两平台并发前已存在、四个计数都是具体数。
    const pdd = await h.run('pdd');
    const countsAfterPdd = await billCounts(h.db, h.appId);
    // taobao：候选 1、金额不一致 1、应结未结 1、hold 1；jd：候选 1、金额不一致 2、应结未结 1。
    const taobao = await platformOrders(h, 'taobao', { mismatched: 1, unsettled: 1, held: 1 });
    const jd = await platformOrders(h, 'jd', { mismatched: 2, unsettled: 1, held: 0 });

    const leftPid = await backendPid(pools.left);
    const rightPid = await backendPid(pools.right);
    const barrier = pauseAtBillLock(pools.left);
    const holder = h.job.run(barrier.db, input(h, first));
    const holderDone = holder.then(
      () => 'finished' as const,
      () => 'finished' as const,
    );
    const paused = await within(
      Promise.race([barrier.reached.then(() => 'paused' as const), holderDone]),
      'first platform holding the bill row lock',
    );
    let waiter: ReturnType<typeof h.job.run> | undefined;
    try {
      // 先到的任务必须停在账单行锁上；没取锁就跑完的实现在这里红，不挂到超时。
      expect(paused.ok ? paused.value : errorText(paused.error)).toBe('paused');
      waiter = h.job.run(pools.right, input(h, second));
      await waitBlocked(pools.control, rightPid, leftPid);
    } finally {
      barrier.release();
    }
    const held = await within(holder, 'first platform');
    const waited =
      waiter === undefined
        ? { ok: false as const, error: new Error('second platform not run') }
        : await within(waiter, 'second platform');

    expect(pdd.outcome).toBe('generated');
    expect(countsAfterPdd).toEqual({
      error_count: 0,
      held_count: 0,
      unsettled_count: 0,
      amount_mismatch_count: 0,
    });
    expect(held.ok ? held.value.outcome : errorText(held.error)).toBe('generated');
    expect(waited.ok ? waited.value.outcome : errorText(waited.error)).toBe('generated');
    expect(await billCounts(h.db, h.appId)).toEqual({
      error_count: 0,
      held_count: 1,
      unsettled_count: 2,
      amount_mismatch_count: 3,
    });
    const s = await state(h);
    expect(s.diffs).toEqual([]);
    expect(s.batches.map((b) => [b.platform, b.kind, b.status, b.order_count]).sort()).toEqual([
      ['jd', 'main', 'DRAFT', 1],
      ['taobao', 'main', 'DRAFT', 1],
    ]);
    expect(s.items.map((i) => i.order_id).sort()).toEqual([taobao.good.id, jd.good.id].sort());
    const notInBatch = new Set([...taobao.mismatched, ...jd.mismatched].map((o) => o.id));
    expect(s.items.filter((i) => notInBatch.has(i.order_id))).toEqual([]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-18#28] 写 amount_mismatch_count 的语句恰是写 unsettled_count 的那一条 UPDATE（经执行器的全部语句里观察）：jd 2 张重生成后仍不一致、1 张应结未结 → 写 settle_bills 且点名 amount_mismatch_count 的语句恰 1 条、点名 unsettled_count 的也恰 1 条，是同一条 UPDATE；账单 amount_mismatch_count 2、unsettled_count 1',
  async () => {
    const h = fixture(pools.db);
    await snapshot(h);
    await platformOrders(h, 'jd', { mismatched: 2, unsettled: 1, held: 0 });
    const traced = tracing(pools.db);

    const run = await within(h.job.run(traced.db, input(h, 'jd')), 'jd bill run');

    expect(run.ok ? run.value.outcome : errorText(run.error)).toBe('generated');
    const mismatchWrites = writesNaming(traced.queries, 'amount_mismatch_count');
    const unsettledWrites = writesNaming(traced.queries, 'unsettled_count');
    expect(mismatchWrites).toHaveLength(1);
    expect(unsettledWrites).toHaveLength(1);
    expect(mismatchWrites[0]).toBe(unsettledWrites[0]);
    expect(mismatchWrites[0]).toMatch(/\bupdate\b/i);
    expect(await billCounts(h.db, h.appId)).toEqual({
      error_count: 0,
      held_count: 0,
      unsettled_count: 1,
      amount_mismatch_count: 2,
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-18#29] 两列同一事务：写计数的那条 UPDATE 执行之后、提交之前故障 → 账单行（四个计数与合计）、批次、明细、差错单全部回到跑之前（pdd 已出账的值）；原键重试后 amount_mismatch_count、unsettled_count、held_count 各累加一次（1、1、1），批次一份',
  async () => {
    const h = fixture(pools.db);
    await snapshot(h);
    const pdd = await h.run('pdd');
    // taobao：候选 1、金额不一致 1、应结未结 1、hold 1。
    const taobao = await platformOrders(h, 'taobao', { mismatched: 1, unsettled: 1, held: 1 });
    const before = await state(h);
    const fault = failAfterCountWrite(pools.db);

    const faulted = await within(h.job.run(fault.db, input(h, 'taobao')), 'faulted bill run');
    const afterFault = await state(h);
    const retried = await within(h.job.run(pools.db, input(h, 'taobao')), 'retried bill run');

    expect(pdd.outcome).toBe('generated');
    expect(faulted.ok ? 'ok' : errorText(faulted.error)).toContain('injected count write failure');
    expect(fault.fired).toBe(1);
    expect(afterFault.bills).toEqual(before.bills);
    expect(afterFault.batches).toEqual(before.batches);
    expect(afterFault.items).toEqual(before.items);
    expect(afterFault.diffs).toEqual(before.diffs);
    const done = afterFault.jobs.filter((j) => j.platform === 'taobao' && j.status === 'done');
    expect(done).toEqual([]);

    expect(retried.ok ? retried.value.outcome : errorText(retried.error)).toBe('generated');
    expect(await billCounts(h.db, h.appId)).toEqual({
      error_count: 0,
      held_count: 1,
      unsettled_count: 1,
      amount_mismatch_count: 1,
    });
    const s = await state(h);
    expect(s.batches.map((b) => [b.platform, b.kind, b.order_count])).toEqual([
      ['taobao', 'main', 1],
    ]);
    expect(s.items.map((i) => i.order_id)).toEqual([taobao.good.id]);
    expect(s.diffs).toEqual([]);
  },
  TIMEOUT,
);
