// B2-09zb rule tests (claude-independent, SPEC_REF 18f0015): a run is one app and one platform
// (settle_jobs.job=settle_adjust per (app, platform, D); task §9 算法「某 app、某平台」). Another app's
// orders never enter this app's batch, and another platform's orders wait for their own run.
import { expect, it } from 'vitest';
import {
  EXAMPLE,
  TIMEOUT,
  adjustHarness,
  beneficiaryRow,
  createDatabase,
  databaseFixture,
  ordered,
  platformRow,
} from './harness.ts';

const p = databaseFixture(createDatabase);

it(
  '[AC-B2-09zb#11] app 隔离：本 app 的运行只为本 app 的单生成，批次 app_id 为本 app；别的 app 的同类单不生成、不建批次',
  async () => {
    const mine = await adjustHarness(p.db);
    const other = await adjustHarness(p.db);
    const a = await mine.raised(EXAMPLE, 1300n);
    const b = await other.raised(EXAMPLE, 1300n);

    const result = await mine.run();

    expect(ordered(await mine.rowsOf(a.o))).toEqual([
      beneficiaryRow(a.o, 'self', 33n, a.seq),
      beneficiaryRow(a.o, 'direct', 7n, a.seq),
      platformRow(26n, a.seq),
    ]);
    expect(await other.rowsOf(b.o)).toEqual([]);
    expect(await other.batches()).toEqual([]);
    const batches = await mine.batches();
    expect(batches.map((x) => [x.batch_id, x.app_id])).toEqual([[result.batchId, mine.appId]]);
    const everyRow = await p.db
      .selectFrom('settle_adjustments')
      .select(['app_id', 'order_id'])
      .where('batch_id', '=', batches[0]!.batch_id)
      .execute();
    expect(everyRow.map((r) => r.app_id)).toEqual([mine.appId, mine.appId, mine.appId]);
    expect(everyRow.every((r) => r.order_id === a.o.orderId)).toBe(true);
  },
  TIMEOUT,
);

it(
  '[AC-B2-09zb#11] 平台隔离：taobao 的运行不碰本 app 的 jd 单；jd 的运行再为 jd 单单独建批次',
  async () => {
    const h = await adjustHarness(p.db);
    const taobao = await h.raised(EXAMPLE, 1300n);
    const jd = await h.raised({ ...EXAMPLE, platform: 'jd' }, 1300n);

    const first = await h.run({ platform: 'taobao' });

    expect(first).toMatchObject({ orders: 1, candidates: 3 });
    expect(await h.rowsOf(jd.o)).toEqual([]);
    expect((await h.rowsOf(taobao.o)).every((r) => r.batch_id === first.batchId)).toBe(true);

    const second = await h.run({ platform: 'jd' });

    expect(second).toMatchObject({ orders: 1, candidates: 3 });
    expect(second.batchId).not.toBe(first.batchId);
    expect(ordered(await h.rowsOf(jd.o))).toEqual([
      beneficiaryRow(jd.o, 'self', 33n, jd.seq),
      beneficiaryRow(jd.o, 'direct', 7n, jd.seq),
      platformRow(26n, jd.seq),
    ]);
    expect((await h.rowsOf(jd.o)).every((r) => r.batch_id === second.batchId)).toBe(true);
  },
  TIMEOUT,
);
