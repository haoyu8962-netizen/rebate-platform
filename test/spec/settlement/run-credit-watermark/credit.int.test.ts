// B2-04zy rule tests on a real PostgreSQL (D10-726; BR-FUND-04 ⑦, BR-TEXT-09): the batch counter
// app.settle_batches.credited_count moves by +1 on the item transaction whose item result is
// 'credited' (order items and beneficiary items alike), without touching row_version. A rolled-back
// item transaction (day rollover, injected failure) adds nothing; a duplicate delivery or the same
// order again in another batch of the run adds nothing; skipped and deferred items add nothing.
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  TIMEOUT,
  at,
  batchXmin,
  countFailsAfter,
  creditedCount,
  creditedItems,
  creditedOnce,
  databaseFixture,
  delivered,
  fixture,
  itemXmin,
  nth,
  rig,
  runCredited,
  runState,
  untouched,
  watermarkReady,
} from './kit.ts';

const p = databaseFixture(createTestDatabase);

const EVENING = '2032-07-23T23:59:50+08:00';
const AFTER_MIDNIGHT = '2032-07-24T00:00:05+08:00';

interface Seen {
  readonly count: number;
  /** The previous order's item row and the batch row carry the same xmin. */
  readonly sameTransaction: boolean;
  readonly rowVersion: number;
}

it(
  '[AC-B2-04zy#2][BR-FUND-04][BR-TEXT-09] 入账同事务 +1、不改 row_version：单批 3 单依次入账；每单事务开始时从另一连接看，上一单的明细行与批次行由同一个事务写入（xmin 相同）、计数已是 1、2，批次 row_version 不随计数变化；DONE 后计数 = 3 = 结果为 credited 的明细数，run 发 part=1 done、水位 3',
  async () => {
    await watermarkReady(p.db);
    const f = await fixture(p.db);
    const r = rig(f);
    const groups = await f.orderGroups('count-same-tx', [3]);
    const { runId, batches } = await f.seedRun(groups);
    const b = at(batches, 0);
    const orders = at(groups, 0);

    const seen: Seen[] = [];
    for (const [index, o] of orders.slice(1).entries()) {
      const previous = nth(orders, index);
      r.onCredit(o, async () => {
        seen.push({
          count: await creditedCount(f, b),
          sameTransaction: (await itemXmin(f, b, previous)) === (await batchXmin(f, b)),
          rowVersion: (await f.stored(b)).row_version,
        });
      });
    }
    await delivered(f, r.worker(), b, 'done');

    expect(seen.map((s) => ({ count: s.count, sameTransaction: s.sameTransaction }))).toEqual([
      { count: 1, sameTransaction: true },
      { count: 2, sameTransaction: true },
    ]);
    expect(seen.map((s) => s.rowVersion)).toEqual([at(seen, 0).rowVersion, at(seen, 0).rowVersion]);
    expect(await creditedCount(f, b)).toBe(3);
    expect(await creditedItems(f, b)).toBe(3);
    for (const o of orders) await creditedOnce(f, o);
    expect(await f.runDone()).toStrictEqual([f.runEvent(runId, 1, 'done', 1)]);
    expect(await runState(f, runId)).toEqual({ part: 1, last_outcome: 'done', watermark: 3 });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zy#2][BR-FUND-04] 明细事务回滚不加（跨日）：执行中跨过日切而新一天快照未完成，在途第 2 单的事务整单回滚、批次停在 EXECUTING → credited_count 只算已提交的第 1 单（=1）；快照完成后 SB9 续跑完，计数 = 3，与结果为 credited 的明细数相同',
  async () => {
    await watermarkReady(p.db);
    const f = await fixture(p.db);
    const r = rig(f);
    const groups = await f.orderGroups('count-rollover', [3]);
    const { runId, batches } = await f.seedRun(groups, [
      { confirmed_at: new Date('2032-07-23T23:00:00+08:00') },
    ]);
    const b = at(batches, 0);
    const orders = at(groups, 0);
    f.clock.set(EVENING);
    // 第 2 单的事务里时钟走过 00:00（07-23 的快照还没有，也没到 00:30）。
    r.onCredit(nth(orders, 1), async () => {
      f.clock.set(AFTER_MIDNIGHT);
    });

    expect(await r.worker().deliver(b)).toMatchObject({ outcome: 'day_rollover' });
    expect(await f.status(b)).toBe('EXECUTING');
    await creditedOnce(f, nth(orders, 0));
    await untouched(f, nth(orders, 1));
    expect((await f.itemOf(b, nth(orders, 1))).result).toBeNull();
    expect(await creditedCount(f, b)).toBe(1);
    expect(await creditedItems(f, b)).toBe(1);

    await f.snapshotDone('2032-07-23');
    f.clock.set('2032-07-24T00:20:00+08:00');
    await delivered(f, r.worker(), b, 'done');
    expect(await creditedCount(f, b)).toBe(3);
    expect(await creditedItems(f, b)).toBe(3);
    for (const o of orders) await creditedOnce(f, o);
    expect(await runState(f, runId)).toEqual({ part: 1, last_outcome: 'done', watermark: 3 });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zy#2][BR-FUND-04] 明细事务回滚不加（注入失败）：第 1 单事务里 credited_count 的 UPDATE 已在库里执行后注入失败 → 整个明细事务回滚：计数仍为 0、该单仍 WAITING 且明细未处理、批次停在 EXECUTING、run 无发布；接管续跑完计数 = 3',
  async () => {
    await watermarkReady(p.db);
    const f = await fixture(p.db);
    const r = rig(f);
    const groups = await f.orderGroups('count-injected', [3]);
    const { runId, batches } = await f.seedRun(groups);
    const b = at(batches, 0);
    const orders = at(groups, 0);

    const faulty = countFailsAfter(p.db);
    await expect(r.worker({ via: faulty.db }).deliver(b)).rejects.toThrow();
    expect(faulty.injected()).toBe(1);
    expect(await f.status(b)).toBe('EXECUTING');
    for (const o of orders) await untouched(f, o);
    expect((await f.itemOf(b, nth(orders, 0))).result).toBeNull();
    expect(await creditedCount(f, b)).toBe(0);
    expect(await f.runDone()).toEqual([]);

    await delivered(f, r.worker(), b, 'done');
    expect(await creditedCount(f, b)).toBe(3);
    expect(await creditedItems(f, b)).toBe(3);
    for (const o of orders) await creditedOnce(f, o);
    expect(await runState(f, runId)).toEqual({ part: 1, last_outcome: 'done', watermark: 3 });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zy#2][BR-FUND-04][BR-TEXT-09] 重复投递去重不加：同一 CONFIRMED 批次在两条连接上被同时投递，只有一个执行，计数 = 单数 3；DONE 后再投递都是 idle、计数不变；同一批订单又出现在同 run 的另一批里，那些明细被入账幂等跳过、那一批计数为 0，run 合计仍为 3、发 part=1 done 水位 3',
  async () => {
    await watermarkReady(p.db);
    const f = await fixture(p.db);
    const r = rig(f);
    const orders = at(await f.orderGroups('count-replay', [3]), 0);
    const { runId, batches } = await f.seedRun([orders, orders]);
    const [first, again] = [at(batches, 0), at(batches, 1)];

    const token = randomUUID().slice(0, 8);
    const outcomes = await Promise.all([
      r.worker({ via: p.pool(`count-replay-x-${token}`) }).deliver(first),
      r.worker({ via: p.pool(`count-replay-y-${token}`) }).deliver(first),
    ]);
    expect(outcomes.filter((o) => o.outcome === 'done')).toHaveLength(1);
    expect(outcomes.filter((o) => o.outcome === 'busy' || o.outcome === 'idle')).toHaveLength(1);
    expect(await f.status(first)).toBe('DONE');
    expect(await creditedCount(f, first)).toBe(3);

    for (const by of [r.worker(), r.worker({ via: p.pool() })]) {
      expect(await by.deliver(first)).toMatchObject({ outcome: 'idle' });
    }
    expect(await creditedCount(f, first)).toBe(3);
    expect(await f.runDone()).toEqual([]);

    await delivered(f, r.worker(), again, 'done');
    for (const o of orders) {
      expect((await f.itemOf(again, o)).result).toBe('skipped');
      await creditedOnce(f, o);
    }
    expect(await creditedCount(f, again)).toBe(0);
    expect(await creditedCount(f, first)).toBe(3);
    expect(await runCredited(f, runId)).toBe(3);
    expect(await f.runDone()).toStrictEqual([f.runEvent(runId, 1, 'done', 2)]);
    expect(await runState(f, runId)).toEqual({ part: 1, last_outcome: 'done', watermark: 3 });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zy#2][BR-FUND-04][BR-TEXT-09] skipped / deferred 不加：一批里订单明细一条入账、一条因结算记录 seq 已变被跳过，受益人补记项一条入账、一条暂缓、一条跳过 → DONE 后计数 = 2（只算两条 credited），run 发 part=1 done 水位 2',
  async () => {
    await watermarkReady(p.db);
    const f = await fixture(p.db);
    const r = rig(f);
    const groups = await f.orderGroups('count-kinds', [2, 3]);
    const orders = at(groups, 0);
    const held = at(groups, 1);
    const stale = nth(orders, 1);
    const runId = randomUUID();
    const b = await f.batch(
      orders,
      { settle_run_id: runId },
      new Map([[stale.orderId, stale.seq + 1]]),
    );
    const paid = await f.beneficiaryItem(b, nth(held, 0), 'direct');
    const waiting = await f.beneficiaryItem(b, nth(held, 1), 'direct');
    const passed = await f.beneficiaryItem(b, nth(held, 2), 'direct');
    r.answers.set(paid.beneficiaryCreditId, { result: 'credited', amountFen: 80n });
    r.answers.set(waiting.beneficiaryCreditId, { result: 'deferred' });
    r.answers.set(passed.beneficiaryCreditId, { result: 'skipped', reason: 'not_open' });

    await delivered(f, r.worker(), b, 'done');
    expect(await f.itemOf(b, nth(orders, 0))).toMatchObject({ result: 'credited' });
    expect(await f.itemOf(b, stale)).toMatchObject({
      result: 'skipped',
      skip_reason: 'settlement_changed',
    });
    expect(await f.item(b, paid.beneficiaryCreditId)).toMatchObject({ result: 'credited' });
    expect(await f.item(b, waiting.beneficiaryCreditId)).toMatchObject({ result: 'deferred' });
    expect(await f.item(b, passed.beneficiaryCreditId)).toMatchObject({ result: 'skipped' });
    expect(await creditedCount(f, b)).toBe(2);
    expect(await creditedItems(f, b)).toBe(2);
    expect(await f.runDone()).toStrictEqual([f.runEvent(runId, 1, 'done', 1)]);
    expect(await runState(f, runId)).toEqual({ part: 1, last_outcome: 'done', watermark: 2 });
  },
  TIMEOUT,
);
