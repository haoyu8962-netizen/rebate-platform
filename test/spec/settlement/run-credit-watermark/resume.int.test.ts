// B2-04zy rule tests on a real PostgreSQL (D10-726; BR-FUND-04 ⑦ SB8, BR-TEXT-09 「0 笔不发」): manual
// continues of a run whose executors run on different clocks. Worker Q is on the harness clock (the
// one the credits write credited_at with, and the one batch A finishes on); worker P is on its own
// FixedClock, ahead of or behind Q. A run of A (one order) and B (three orders):
//   1. A done on Q (the run does not rest: B still waits);
//   2. B on P credits b0 and is stopped by the switch → part=1 partial, published by P;
//   3. continue, stopped again before any credit, on P → nothing published;
//   4. continue, b1 credited, stopped, on Q → part=2 partial;
//   5. continue, stopped again before any credit, on P → nothing published;
//   6. continue to DONE on Q → part=3 done.
// With P ahead, part=1's publish instant lies after every later credit of Q, so a timestamp
// comparison misses step 4; with P behind, it lies before A's finish, so a timestamp comparison
// counts A again in step 3. The counts decide both.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
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
  type RunState,
} from './kit.ts';

const p = databaseFixture(createTestDatabase);

/** Far beyond the gaps the switch steps put between the moves of these cases. */
const SKEW_MS = 600_000;

it.each([
  { label: '发布方时钟领先', tag: 'lead', offsetMs: SKEW_MS },
  { label: '发布方时钟落后', tag: 'lag', offsetMs: -SKEW_MS },
])(
  '[AC-B2-04zy#4][BR-FUND-04][BR-TEXT-09] 慢时钟人工续跑（$label）：A 在 Q 上 DONE；B 在时钟不同的 P 上入账一单后停住 → part=1 partial（水位 2）；P 上零入账续跑 → 不发；Q 上续跑入账一单后停住 → 发 part=2 partial（水位 3）；P 上再零入账续跑 → 不发；Q 上续跑到 DONE → 发 part=3 done（水位 4）',
  async ({ tag, offsetMs }) => {
    await watermarkReady(p.db);
    const f = await fixture(p.db);
    const r = rig(f);
    const groups = await f.orderGroups(`resume-${tag}`, [1, 3]);
    const { runId, batches } = await f.seedRun(groups);
    const [a, b] = [at(batches, 0), at(batches, 1)];
    const [aOrders, bOrders] = [at(groups, 0), at(groups, 1)];
    const q = r.worker();
    const slow = r.worker({ offsetMs });

    async function counted(state: RunState): Promise<void> {
      expect(await runState(f, runId)).toEqual(state);
      expect(await runCredited(f, runId)).toBe(state.watermark);
    }

    await delivered(f, q, a, 'done');
    expect(await f.runDone()).toEqual([]);
    f.clock.advanceMs(1_000);
    r.stopAfter(nth(bOrders, 0));
    await delivered(f, slow, b, 'partial');
    const partOne = f.runEvent(runId, 1, 'partial', 2);
    expect(await f.runDone()).toStrictEqual([partOne]);
    await counted({ part: 1, last_outcome: 'partial', watermark: 2 });

    // P 上续跑，处理下一单之前开关再关：本次零入账。
    f.switchBackOn();
    await f.resume(b);
    r.switchOff();
    await delivered(f, slow, b, 'partial');
    expect(await f.runDone()).toStrictEqual([partOne]);
    await counted({ part: 1, last_outcome: 'partial', watermark: 2 });
    await untouched(f, nth(bOrders, 1));

    // Q 上续跑，入账 b1 后停住。
    f.switchBackOn();
    await f.resume(b);
    r.stopAfter(nth(bOrders, 1));
    await delivered(f, q, b, 'partial');
    const partTwo = f.runEvent(runId, 2, 'partial', 2);
    expect(await f.runDone()).toStrictEqual([partOne, partTwo]);
    await counted({ part: 2, last_outcome: 'partial', watermark: 3 });

    // P 上再续跑，零入账。
    f.switchBackOn();
    await f.resume(b);
    r.switchOff();
    await delivered(f, slow, b, 'partial');
    expect(await f.runDone()).toStrictEqual([partOne, partTwo]);
    await counted({ part: 2, last_outcome: 'partial', watermark: 3 });
    await untouched(f, nth(bOrders, 2));

    f.switchBackOn();
    await f.resume(b);
    await delivered(f, q, b, 'done');
    expect(await f.runDone()).toStrictEqual([partOne, partTwo, f.runEvent(runId, 3, 'done', 2)]);
    await counted({ part: 3, last_outcome: 'done', watermark: 4 });
    expect([await creditedCount(f, a), await creditedCount(f, b)]).toEqual([1, 3]);
    for (const o of [...aOrders, ...bOrders]) await creditedOnce(f, o);
  },
  TIMEOUT,
);
