// B2-04zy rule tests on a real PostgreSQL (D10-732; BR-TEXT-09 「0 笔不发」, BR-FUND-04 ⑦): an
// execution that credited nothing publishes no settle.run_done, also when its batch reaches DONE
// (every item skipped or deferred). The batch still moves to DONE with settle.batch_done, and the
// run's watermark stays where it was. When another batch of the same execution did credit, the
// run publishes as before. The counts are summed per (app_id, settle_run_id): credits of an earlier
// or parallel run of the same app, and of a run with the same id in another app, never count.
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import type { SeededOrder } from '../credit/kit.ts';
import {
  NOTHING,
  TIMEOUT,
  at,
  creditedCount,
  creditedOnce,
  databaseFixture,
  delivered,
  fixture,
  nth,
  rig,
  runCredited,
  runState,
  untouched,
  watermarkReady,
} from './kit.ts';

const p = databaseFixture(createTestDatabase);

/** Order items whose settlement seq no longer matches: the credit skips them. */
function staleSeqs(orders: readonly SeededOrder[]): ReadonlyMap<string, number> {
  return new Map(orders.map((o): [string, number] => [o.orderId, o.seq + 1]));
}

it(
  '[AC-B2-04zy#5][D10-732][BR-TEXT-09] 首次执行零入账而批次照样 DONE：run 唯一一批的订单明细全因结算记录 seq 已变被跳过、受益人补记项暂缓 → 批次 DONE、发 settle.batch_done，但不发 settle.run_done，settle_runs 无发布（无行，或 part 0、无 outcome、水位 0），计数 0',
  async () => {
    await watermarkReady(p.db);
    const f = await fixture(p.db);
    const r = rig(f);
    const groups = await f.orderGroups('zero-first', [2, 1]);
    const orders = at(groups, 0);
    const runId = randomUUID();
    const b = await f.batch(orders, { settle_run_id: runId }, staleSeqs(orders));
    const waiting = await f.beneficiaryItem(b, nth(at(groups, 1), 0), 'direct');
    r.answers.set(waiting.beneficiaryCreditId, { result: 'deferred' });

    await delivered(f, r.worker(), b, 'done');
    expect((await f.stored(b)).finished_at).not.toBeNull();
    expect(await f.batchDone(b)).toBe(1);
    for (const o of orders) {
      expect(await f.itemOf(b, o)).toMatchObject({ result: 'skipped' });
      await untouched(f, o);
    }
    expect(await f.item(b, waiting.beneficiaryCreditId)).toMatchObject({ result: 'deferred' });
    expect(await creditedCount(f, b)).toBe(0);
    expect(await f.runDone()).toEqual([]);
    expect(await runState(f, runId)).toEqual(NOTHING);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zy#5][D10-732][BR-TEXT-09] 续跑零入账而批次照样 DONE：单批 3 单，入账第 1 单后因开关停住 → part=1 partial（水位 1）；其余两单结算记录 seq 已变，继续执行把它们都跳过、批次 DONE → 不发 part=2，行仍为 part=1 partial、水位 1；settle.batch_done 照发一条',
  async () => {
    await watermarkReady(p.db);
    const f = await fixture(p.db);
    const r = rig(f);
    const orders = at(await f.orderGroups('zero-continue', [3]), 0);
    const runId = randomUUID();
    const b = await f.batch(orders, { settle_run_id: runId }, staleSeqs(orders.slice(1)));
    const w = r.worker();

    r.stopAfter(nth(orders, 0));
    await delivered(f, w, b, 'partial');
    const partial = f.runEvent(runId, 1, 'partial', 1);
    expect(await f.runDone()).toStrictEqual([partial]);
    expect(await runState(f, runId)).toEqual({ part: 1, last_outcome: 'partial', watermark: 1 });

    f.switchBackOn();
    await f.resume(b);
    await delivered(f, w, b, 'done');
    expect(await f.batchDone(b)).toBe(1);
    for (const o of orders.slice(1)) {
      expect(await f.itemOf(b, o)).toMatchObject({ result: 'skipped' });
      await untouched(f, o);
    }
    await creditedOnce(f, nth(orders, 0));
    expect(await creditedCount(f, b)).toBe(1);
    expect(await f.runDone()).toStrictEqual([partial]);
    expect(await runState(f, runId)).toEqual({ part: 1, last_outcome: 'partial', watermark: 1 });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zy#5][BR-FUND-04][BR-TEXT-09] 对照：同一次执行里别的批次有入账照发——A 入账一单 DONE（run 未静止），B 的明细全被跳过、DONE → run 静止，各批计数之和 1 > 水位 0 → 发 part=1 done，水位 1',
  async () => {
    await watermarkReady(p.db);
    const f = await fixture(p.db);
    const r = rig(f);
    const groups = await f.orderGroups('zero-mixed', [1, 2]);
    const [aOrders, bOrders] = [at(groups, 0), at(groups, 1)];
    const runId = randomUUID();
    const a = await f.batch(aOrders, { settle_run_id: runId });
    const b = await f.batch(bOrders, { settle_run_id: runId }, staleSeqs(bOrders));
    const w = r.worker();

    await delivered(f, w, a, 'done');
    expect(await f.runDone()).toEqual([]);
    await delivered(f, w, b, 'done');
    expect([await creditedCount(f, a), await creditedCount(f, b)]).toEqual([1, 0]);
    expect(await runCredited(f, runId)).toBe(1);
    expect(await f.runDone()).toStrictEqual([f.runEvent(runId, 1, 'done', 2)]);
    expect(await runState(f, runId)).toEqual({ part: 1, last_outcome: 'done', watermark: 1 });
    await creditedOnce(f, nth(aOrders, 0));
    for (const o of bOrders) await untouched(f, o);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zy#5][AC-B2-04zy#6][D10-732][BR-TEXT-09] 计数只按 (app_id, settle_run_id) 汇总：同一 app 先执行完 run A（入账两单 → part=1 done，水位 2）；同一 app 并行的 run C 入账一单后普通错误退出（EXECUTING、不发）；另一 app 与 B 同号的 run 同样入账一单后普通错误退出；再执行另一次确认的 run B，明细全被跳过、批次 DONE → B 不发 settle.run_done、无发布（水位 0），A 仍为 part=1 done 水位 2；之后 C 与另一 app 的同号 run 各自执行完只发各自的 part=1 done（水位 2），B 仍无发布',
  async () => {
    await watermarkReady(p.db);
    const f = await fixture(p.db);
    const g = await fixture(p.db);
    const r = rig(f);
    const s = rig(g);
    const groups = await f.orderGroups('zero-other', [2, 2, 2]);
    const [aOrders, cOrders, bOrders] = [at(groups, 0), at(groups, 1), at(groups, 2)];
    const twinOrders = at(await g.orderGroups('zero-twin', [2]), 0);
    const [runA, runB, runC] = [randomUUID(), randomUUID(), randomUUID()];
    const a = await f.batch(aOrders, { settle_run_id: runA });
    const c = await f.batch(cOrders, { settle_run_id: runC });
    const b = await f.batch(bOrders, { settle_run_id: runB }, staleSeqs(bOrders));
    const twin = await g.batch(twinOrders, { settle_run_id: runB });
    const w = r.worker();
    const v = s.worker();
    const doneA = f.runEvent(runA, 1, 'done', 1);
    const stateA = { part: 1, last_outcome: 'done', watermark: 2 };

    // run A：两单入账、DONE → part=1 done，水位 2。
    await delivered(f, w, a, 'done');
    expect(await creditedCount(f, a)).toBe(2);
    expect(await f.runDone()).toStrictEqual([doneA]);
    expect(await runState(f, runA)).toEqual(stateA);

    // 同一 app 的并行 run C：入账第 1 单，第 2 单普通错误退出（EXECUTING、不发）。
    r.failAt(nth(cOrders, 1));
    await expect(w.deliver(c)).rejects.toThrow();
    expect(await f.status(c)).toBe('EXECUTING');
    expect(await creditedCount(f, c)).toBe(1);
    await untouched(f, nth(cOrders, 1));

    // 另一 app 与 B 同号的 run：同样入账一单后普通错误退出。
    s.failAt(nth(twinOrders, 1));
    await expect(v.deliver(twin)).rejects.toThrow();
    expect(await g.status(twin)).toBe('EXECUTING');
    expect(await creditedCount(g, twin)).toBe(1);
    expect(await g.runDone()).toEqual([]);

    // run B：明细全被跳过、批次 DONE → 不发，无发布；A 不受影响。
    await delivered(f, w, b, 'done');
    expect(await f.batchDone(b)).toBe(1);
    for (const o of bOrders) {
      expect(await f.itemOf(b, o)).toMatchObject({ result: 'skipped' });
      await untouched(f, o);
    }
    expect(await creditedCount(f, b)).toBe(0);
    expect(await runCredited(f, runB)).toBe(0);
    expect(await f.runDone()).toStrictEqual([doneA]);
    expect(await runState(f, runB)).toEqual(NOTHING);
    expect(await runState(f, runA)).toEqual(stateA);
    expect(await g.runDone()).toEqual([]);
    expect(await runState(g, runB)).toEqual(NOTHING);

    // C 与另一 app 的同号 run 接管（SB9）执行完：各发各的 part=1 done，B 仍无发布。
    await delivered(f, w, c, 'done');
    await delivered(g, v, twin, 'done');
    expect(await f.runDone()).toStrictEqual([doneA, f.runEvent(runC, 1, 'done', 1)]);
    expect(await runState(f, runC)).toEqual({ part: 1, last_outcome: 'done', watermark: 2 });
    expect(await g.runDone()).toStrictEqual([g.runEvent(runB, 1, 'done', 1)]);
    expect(await runState(g, runB)).toEqual({ part: 1, last_outcome: 'done', watermark: 2 });
    expect(await runState(f, runB)).toEqual(NOTHING);
    expect(await runState(f, runA)).toEqual(stateA);
    for (const o of [...aOrders, ...cOrders]) await creditedOnce(f, o);
    for (const o of twinOrders) await creditedOnce(g, o);
  },
  TIMEOUT,
);
