// B2-04zy rule tests on a real PostgreSQL (D10-726; BR-FUND-04 ⑦ SB9, BR-TEXT-09): credits made by
// a call that then failed with an ordinary error count for the next publish of the run. The run
// stops once (part=1 partial), is continued (SB8), the continuing call credits one order and fails
// at the next one (the batch stays EXECUTING, nothing is published), an SB9 take-over then stops
// before its first item because a switch is off → part=2 partial, with the earlier call's credit
// counted. The outcome must not depend on any clock: the cases differ only in how far the executor
// that published part=1 or the one that takes over is ahead of or behind the harness clock (the
// clock the credits write credited_at with).
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
  runState,
  untouched,
  watermarkReady,
} from './kit.ts';

const p = databaseFixture(createTestDatabase);

/** Far beyond the gaps the switch steps put between the credits of these cases. */
const LEAD_MS = 600_000;

it.each([
  { label: '三个执行器时钟一致', tag: 'same', first: 0, takerOffset: 0 },
  { label: '首发 part=1 的执行器时钟领先', tag: 'lead', first: LEAD_MS, takerOffset: 0 },
  { label: '接管的执行器时钟落后', tag: 'lag', first: 0, takerOffset: -LEAD_MS },
])(
  '[AC-B2-04zy#3][BR-FUND-04][BR-TEXT-09] 接管 / 错误重试（$label）：part=1 partial 后继续执行，这次调用入账一单后在下一单普通错误退出（批次 EXECUTING、不发）；开关关闭后 SB9 接管、在第一条未处理明细前停住 → 发 part=2 partial（前次调用的入账照算），水位 1 → 2；再继续执行完发 part=3 done、水位 3',
  async ({ tag, first, takerOffset }) => {
    await watermarkReady(p.db);
    const f = await fixture(p.db);
    const r = rig(f);
    const groups = await f.orderGroups(`takeover-${tag}`, [3]);
    const { runId, batches } = await f.seedRun(groups);
    const b = at(batches, 0);
    const orders = at(groups, 0);
    const opener = r.worker({ offsetMs: first });
    const failing = r.worker();
    const taker = r.worker({ offsetMs: takerOffset });

    r.stopAfter(nth(orders, 0));
    await delivered(f, opener, b, 'partial');
    const partOne = f.runEvent(runId, 1, 'partial', 1);
    expect(await f.runDone()).toStrictEqual([partOne]);
    expect(await runState(f, runId)).toEqual({ part: 1, last_outcome: 'partial', watermark: 1 });

    // 继续执行：这次调用入账第 2 单，第 3 单的事务里普通错误退出。
    f.switchBackOn();
    await f.resume(b);
    r.failAt(nth(orders, 2));
    await expect(failing.deliver(b)).rejects.toThrow();
    expect(await f.status(b)).toBe('EXECUTING');
    await creditedOnce(f, nth(orders, 1));
    await untouched(f, nth(orders, 2));
    expect(await creditedCount(f, b)).toBe(2);
    expect(await f.runDone()).toStrictEqual([partOne]);
    expect(await runState(f, runId)).toEqual({ part: 1, last_outcome: 'partial', watermark: 1 });

    // SB9 接管：开关已关，第一条未处理明细前停住；前次调用的那单算进这次发布。
    r.switchOff();
    await delivered(f, taker, b, 'partial');
    const partTwo = f.runEvent(runId, 2, 'partial', 1);
    expect(await f.runDone()).toStrictEqual([partOne, partTwo]);
    expect(await runState(f, runId)).toEqual({ part: 2, last_outcome: 'partial', watermark: 2 });
    await untouched(f, nth(orders, 2));

    f.switchBackOn();
    await f.resume(b);
    await delivered(f, taker, b, 'done');
    expect(await f.runDone()).toStrictEqual([partOne, partTwo, f.runEvent(runId, 3, 'done', 1)]);
    expect(await runState(f, runId)).toEqual({ part: 3, last_outcome: 'done', watermark: 3 });
    expect(await creditedCount(f, b)).toBe(3);
    for (const o of orders) await creditedOnce(f, o);
  },
  TIMEOUT,
);
