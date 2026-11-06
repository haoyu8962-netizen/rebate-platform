// B2-04zy rule tests on a real PostgreSQL (D10-726; BR-FUND-04 ⑦, BR-TEXT-09): the run watermark
// app.settle_runs.published_credited_count. Every publish of settle.run_done (the first INSERT of
// the row or a later row_version CAS UPDATE) writes the sum of credited_count over the run's batches
// as the new watermark, on the publishing transaction. A refused publish rolls that transaction back
// and a lost CAS publishes nothing: in both the watermark stays as it was, and the credits of that
// execution count for the next publish instead.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
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
  refuseRunDone,
  rig,
  runCasMisses,
  runCredited,
  runState,
  untouched,
  watermarkReady,
  type RunState,
} from './kit.ts';

const p = databaseFixture(createTestDatabase);

it(
  '[AC-B2-04zy#6][BR-FUND-04][BR-TEXT-09] 发布后水位 = 本 run 各批计数之和：A 两单 DONE（run 未静止、无行）；B 入账一单停住 → part=1 partial 水位 3；续跑再入账一单停住 → part=2 partial 水位 4；续跑到 DONE → part=3 done 水位 5，每次都等于两批 credited_count 之和',
  async () => {
    await watermarkReady(p.db);
    const f = await fixture(p.db);
    const r = rig(f);
    const groups = await f.orderGroups('mark-sum', [2, 3]);
    const { runId, batches } = await f.seedRun(groups);
    const [a, b] = [at(batches, 0), at(batches, 1)];
    const bOrders = at(groups, 1);
    const w = r.worker();

    async function published(state: RunState, counts: readonly number[]): Promise<void> {
      expect(await runState(f, runId)).toEqual(state);
      expect([await creditedCount(f, a), await creditedCount(f, b)]).toEqual(counts);
      expect(await runCredited(f, runId)).toBe(state.watermark);
    }

    await delivered(f, w, a, 'done');
    expect(await runState(f, runId)).toEqual(NOTHING);

    r.stopAfter(nth(bOrders, 0));
    await delivered(f, w, b, 'partial');
    await published({ part: 1, last_outcome: 'partial', watermark: 3 }, [2, 1]);

    f.switchBackOn();
    await f.resume(b);
    r.stopAfter(nth(bOrders, 1));
    await delivered(f, w, b, 'partial');
    await published({ part: 2, last_outcome: 'partial', watermark: 4 }, [2, 2]);

    f.switchBackOn();
    await f.resume(b);
    await delivered(f, w, b, 'done');
    await published({ part: 3, last_outcome: 'done', watermark: 5 }, [2, 3]);
    expect(await f.runDone()).toStrictEqual([
      f.runEvent(runId, 1, 'partial', 2),
      f.runEvent(runId, 2, 'partial', 2),
      f.runEvent(runId, 3, 'done', 2),
    ]);
    for (const group of groups) for (const o of group) await creditedOnce(f, o);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zy#6][BR-FUND-04][BR-TEXT-09] 发布失败（事务回滚）水位不变：单批 3 单，首发（INSERT）时 settle.run_done 被拒 → 执行拒绝、批次 EXECUTING、无行（水位 0）、已入账的那单不回滚；接管后停住发 part=1 水位 1；再次续跑入账一单、停住时（CAS UPDATE）被拒 → 行仍为 part=1 水位 1；接管后发 part=2 水位 2；续跑完 part=3 水位 3',
  async () => {
    await watermarkReady(p.db);
    const f = await fixture(p.db);
    const r = rig(f);
    const groups = await f.orderGroups('mark-refused', [3]);
    const { runId, batches } = await f.seedRun(groups);
    const b = at(batches, 0);
    const orders = at(groups, 0);
    const w = r.worker();
    const refusing = r.worker({ publish: refuseRunDone(f) });

    r.stopAfter(nth(orders, 0));
    await expect(refusing.deliver(b)).rejects.toThrow();
    expect(await f.status(b)).toBe('EXECUTING');
    expect(await f.runDone()).toEqual([]);
    expect(await runState(f, runId)).toEqual(NOTHING);
    expect(await creditedCount(f, b)).toBe(1);
    await creditedOnce(f, nth(orders, 0));

    // 开关仍关：接管（SB9）后在下一单前停住，这次发布带上前面那单。
    await delivered(f, w, b, 'partial');
    const partOne = f.runEvent(runId, 1, 'partial', 1);
    expect(await f.runDone()).toStrictEqual([partOne]);
    expect(await runState(f, runId)).toEqual({ part: 1, last_outcome: 'partial', watermark: 1 });

    f.switchBackOn();
    await f.resume(b);
    r.stopAfter(nth(orders, 1));
    await expect(refusing.deliver(b)).rejects.toThrow();
    expect(await f.status(b)).toBe('EXECUTING');
    expect(await f.runDone()).toStrictEqual([partOne]);
    expect(await runState(f, runId)).toEqual({ part: 1, last_outcome: 'partial', watermark: 1 });
    expect(await creditedCount(f, b)).toBe(2);
    await untouched(f, nth(orders, 2));

    await delivered(f, w, b, 'partial');
    const partTwo = f.runEvent(runId, 2, 'partial', 1);
    expect(await f.runDone()).toStrictEqual([partOne, partTwo]);
    expect(await runState(f, runId)).toEqual({ part: 2, last_outcome: 'partial', watermark: 2 });

    f.switchBackOn();
    await f.resume(b);
    await delivered(f, w, b, 'done');
    expect(await f.runDone()).toStrictEqual([partOne, partTwo, f.runEvent(runId, 3, 'done', 1)]);
    expect(await runState(f, runId)).toEqual({ part: 3, last_outcome: 'done', watermark: 3 });
    for (const o of orders) await creditedOnce(f, o);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zy#6][BR-FUND-04][BR-TEXT-09] CAS 丢失水位不变：单批 3 单，入账第 1 单停住 → part=1 水位 1；续跑入账第 2 单后停住，这次发布的 settle_runs CAS UPDATE 没有命中行 → 批次照样 PARTIAL、不发 part=2，行仍为 part=1 水位 1；续跑到 DONE → 发 part=2 done，水位 3（丢失那次的入账算进这次）',
  async () => {
    await watermarkReady(p.db);
    const f = await fixture(p.db);
    const r = rig(f);
    const groups = await f.orderGroups('mark-cas', [3]);
    const { runId, batches } = await f.seedRun(groups);
    const b = at(batches, 0);
    const orders = at(groups, 0);
    const w = r.worker();

    r.stopAfter(nth(orders, 0));
    await delivered(f, w, b, 'partial');
    const partOne = f.runEvent(runId, 1, 'partial', 1);
    expect(await f.runDone()).toStrictEqual([partOne]);
    expect(await runState(f, runId)).toEqual({ part: 1, last_outcome: 'partial', watermark: 1 });

    f.switchBackOn();
    await f.resume(b);
    r.stopAfter(nth(orders, 1));
    const lost = runCasMisses(p.db);
    await delivered(f, r.worker({ via: lost.db }), b, 'partial');
    expect(lost.misses()).toBeGreaterThan(0);
    expect(await f.runDone()).toStrictEqual([partOne]);
    expect(await runState(f, runId)).toEqual({ part: 1, last_outcome: 'partial', watermark: 1 });
    expect(await creditedCount(f, b)).toBe(2);

    f.switchBackOn();
    await f.resume(b);
    await delivered(f, w, b, 'done');
    expect(await f.runDone()).toStrictEqual([partOne, f.runEvent(runId, 2, 'done', 1)]);
    expect(await runState(f, runId)).toEqual({ part: 2, last_outcome: 'done', watermark: 3 });
    for (const o of orders) await creditedOnce(f, o);
  },
  TIMEOUT,
);
