// B2-09zb rule tests (claude-independent, SPEC_REF 18f0015): the scheduled trigger (08 BR-FUND-09:
// R1 正差候选随月结账单生成任务（BR-FUND-04 ③，月结账单日当日资产快照完成后）对 CREDITED 子订单运行;
// task §9 触发). After the `bill` run of (app, platform, D) is done the handler sends one
// `settle_adjust` job (singletonKey settle_adjust:<app_id>:<platform>:<D>); the `settle_adjust`
// delivery runs the generator for (app, platform) and records settle_jobs job=settle_adjust
// running → done; a redelivery generates nothing more. Default bill day 24: D = 2032-07-24 is the
// credit harness's day (NOW 2032-07-24 10:00 +08:00), bill month 2032-06.
import { expect, it } from 'vitest';
import { harness as creditHarness } from '../credit/kit.ts';
import { EXAMPLE, createDatabase, databaseFixture } from './harness.ts';
import {
  adjustBatches,
  adjustJob,
  adjustSend,
  adjustSends,
  billJob,
  candidateRows,
  jobRows,
  raiseSettlement,
  withAdjustWorker,
} from './worker-harness.ts';

const p = databaseFixture(createDatabase);

const TIMEOUT = 180_000;
const DAY = '2032-07-24';
const PLAIN_DAY = '2032-07-10';

/** 08 BR-FUND-09 example: credited at 1234 (617 / 123 / 494), raised to 1300: +33 / +7 / +26. */
async function raisedOrder(h: Awaited<ReturnType<typeof creditHarness>>) {
  const o = await h.order(EXAMPLE);
  expect(await h.credit(o)).toMatchObject({ outcome: 'credited' });
  const seq = await raiseSettlement(h, o, 1300n);
  return { o, seq };
}

it(
  '[AC-B2-09zb#9] bill 完成后入队一条 settle_adjust（payload app_id / platform / accounting_date，singletonKey settle_adjust:<app>:<platform>:<D>）；投递它生成候选，settle_jobs 记 settle_adjust 一行走到 done',
  async () => {
    const h = await creditHarness(p.db);
    const { o, seq } = await raisedOrder(h);

    await withAdjustWorker(h, p.db, new Map(), async ({ handler, queue }) => {
      await expect(handler(billJob(h.appId, 'taobao', DAY))).resolves.toBeUndefined();
      expect(await jobRows(h, 'bill')).toEqual([
        expect.objectContaining({ platform: 'taobao', status: 'done' }),
      ]);
      expect(adjustSends(queue)).toEqual([adjustSend(h.appId, 'taobao', DAY)]);

      await expect(handler(adjustJob(h.appId, 'taobao', DAY))).resolves.toBeUndefined();
    });

    const jobs = await jobRows(h, 'settle_adjust');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ platform: 'taobao', status: 'done' });
    expect(jobs[0]!.finished_at).not.toBeNull();
    const rows = await candidateRows(h);
    expect(
      rows
        .map((r) => [r.order_id, r.role, r.diff_fen, r.status, r.settle_seq] as const)
        .sort((a, b) => String(a[1]).localeCompare(String(b[1]))),
    ).toEqual(
      [
        [o.orderId, 'direct', 7n, 'pending', seq],
        [o.orderId, null, 26n, 'pending', seq],
        [o.orderId, 'self', 33n, 'pending', seq],
      ].sort((a, b) => String(a[1]).localeCompare(String(b[1]))),
    );
    expect(await adjustBatches(h)).toHaveLength(1);
  },
  TIMEOUT,
);

it(
  '[AC-B2-09zb#9] settle_adjust 重投（同一 D）：不重复生成，候选与批次不变，settle_jobs 仍只有一行 done',
  async () => {
    const h = await creditHarness(p.db);
    await raisedOrder(h);

    await withAdjustWorker(h, p.db, new Map(), async ({ handler, queue }) => {
      await expect(handler(billJob(h.appId, 'taobao', DAY))).resolves.toBeUndefined();
      expect(adjustSends(queue)).toEqual([adjustSend(h.appId, 'taobao', DAY)]);
      await expect(handler(adjustJob(h.appId, 'taobao', DAY))).resolves.toBeUndefined();
      const rows = await candidateRows(h);
      expect(rows).toHaveLength(3);

      await expect(handler(adjustJob(h.appId, 'taobao', DAY))).resolves.toBeUndefined();

      expect(await candidateRows(h)).toEqual(rows);
      expect(await adjustBatches(h)).toHaveLength(1);
    });
    const jobs = await jobRows(h, 'settle_adjust');
    expect(jobs.map((j) => j.status)).toEqual(['done']);
  },
  TIMEOUT,
);

it(
  '[AC-B2-09zb#9] bill 没有完成（非账单日 not_due，settle_jobs 无 bill 行）：不入队 settle_adjust；到账单日 bill 完成才入队，且只为那一天入队一条',
  async () => {
    const h = await creditHarness(p.db);
    await raisedOrder(h);
    h.clock.set('2032-07-10T10:00:00+08:00');

    await withAdjustWorker(h, p.db, new Map(), async ({ handler, queue }) => {
      await expect(handler(billJob(h.appId, 'taobao', PLAIN_DAY))).resolves.toBeUndefined();
      expect(await jobRows(h, 'bill')).toEqual([]);
      expect(adjustSends(queue)).toEqual([]);
      expect(await jobRows(h, 'settle_adjust')).toEqual([]);
      expect(await candidateRows(h)).toEqual([]);

      h.clock.set('2032-07-24T10:00:00+08:00');
      await expect(handler(billJob(h.appId, 'taobao', DAY))).resolves.toBeUndefined();
      expect(adjustSends(queue)).toEqual([adjustSend(h.appId, 'taobao', DAY)]);
    });
  },
  TIMEOUT,
);
