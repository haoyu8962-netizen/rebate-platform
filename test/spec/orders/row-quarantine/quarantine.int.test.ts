// B1-04zv（BR-CALC-03：字段缺失或非数字 → 订单进待处理表并告警，不生成快照，不得按 0 处理；D10-522 ⑤、
// D10-570）：单列坏行写 order_sync_pending（reason=ORDER_ROW_INVALID），好行照常入库，水位照常前进。
// 真库、真实 worker 运行体与流水线，真实京东适配器 + 假传输。
import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  BAD_AMOUNT,
  boundsOf,
  decimalId,
  FINISHED,
  quarantined,
  withWorld,
} from './worker-harness.ts';

let database: TestDatabase | undefined;
let db: Kysely<DB>;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 8 });
}, 180_000);
afterAll(async () => {
  try {
    if (db) await destroyDb(db);
  } finally {
    await database?.drop();
  }
}, 30_000);

it('[AC-B1-04zv#6] 一窗含好行和坏行：好行入库，坏行写待处理（首次无订单 order_id 为 null），水位推进一次', () =>
  withWorld(db, async (w) => {
    const [first, broken, last] = [decimalId(), decimalId(), decimalId()];
    const run = await w.run('increment', [
      { id: '70601', rows: [w.good(first), w.bad(broken), w.good(last)] },
    ]);
    expect(run).toMatchObject({ ok: true });
    expect(await w.subOrders()).toEqual([first, last].sort());
    expect(await w.pending()).toEqual([
      quarantined(w, broken, 70601n, {
        order_id: null,
        raw_status: '16',
        detected_at: w.clock.now(),
        resolved_by: null,
        resolved_at: null,
        resolution_note: null,
      }),
    ]);
    expect(w.advance).toHaveBeenCalledTimes(1);
    expect(await w.cursor('increment')).toBe(boundsOf(0).window_end);
  }));

it('[AC-B1-04zv#6] 坏行没有 orders 行、order_keys、状态历史、快照，金额不按 0；detail 不含报文取值', () =>
  withWorld(db, async (w) => {
    const [good, broken] = [decimalId(), decimalId()];
    const run = await w.run('increment', [{ id: '70602', rows: [w.good(good), w.bad(broken)] }]);
    expect(run).toMatchObject({ ok: true });

    const opened = await w.pending();
    expect(opened).toEqual([quarantined(w, broken, 70602n)]);
    expect(opened[0]!.detail).not.toContain(BAD_AMOUNT);
    expect(opened[0]!.detail).not.toContain(broken);

    const orders = await w.orders();
    expect(orders.map((order) => order.sub_order_id)).toEqual([good]);
    expect(orders[0]).toMatchObject({ est_commission_fen: 123n, pay_amount_fen: 4560n });
    expect((await w.keys()).map((key) => key.sub_order_id)).toEqual([good]);
    const ownHistory = new Set((await w.history()).map((step) => step.order_id));
    expect([...ownHistory]).toEqual([orders[0]!.order_id]);
    expect(await w.splits()).toEqual([]);
  }));

// 上一条的好行没归属，本来就不生成快照；这里两行归属同一用户，好行确实有快照，「坏行没有」才有意义。
it('[AC-B1-04zv#6] 快照对照：同一归属用户的好行生成快照，坏行不生成', () =>
  withWorld(db, async (w) => {
    const { userId, attribution } = await w.member();
    const [good, broken] = [decimalId(), decimalId()];
    const run = await w.run('increment', [
      { id: '70603', rows: [w.good(good, attribution), w.bad(broken, attribution)] },
    ]);
    expect(run).toMatchObject({ ok: true });
    const orders = await w.orders();
    expect(orders).toEqual([expect.objectContaining({ sub_order_id: good, user_id: userId })]);
    expect((await w.splits()).map((split) => split.order_id)).toEqual([orders[0]!.order_id]);
    expect(await w.pending()).toEqual([quarantined(w, broken, 70603n)]);
  }));

it.each([
  { field: 'estimateFee', rawStatus: '16', row: { estimateFee: undefined } },
  { field: 'actualFee', rawStatus: '17', row: { ...FINISHED, actualFee: undefined } },
])(
  '[AC-B1-04zv#6] 佣金字段 $field 缺失（$rawStatus）：同样进待处理，不按 0 入库，水位推进',
  ({ field, rawStatus, row }) =>
    withWorld(db, async (w) => {
      const [good, broken] = [decimalId(), decimalId()];
      const run = await w.run('increment', [
        { id: '70604', rows: [w.good(good), w.bad(broken, row)] },
      ]);
      expect(run).toMatchObject({ ok: true });
      expect(await w.subOrders()).toEqual([good]);
      expect(await w.pending()).toEqual([
        quarantined(w, broken, 70604n, {
          raw_status: rawStatus,
          detail: expect.stringContaining(field),
        }),
      ]);
      expect(await w.cursor('increment')).toBe(boundsOf(0).window_end);
    }),
);

it('[AC-B1-04zv#8] 已有订单收到缺佣金字段的行：佣金不被冲成 0，订单各列不变', () =>
  withWorld(db, async (w) => {
    const id = decimalId();
    const imported = await w.run('increment', [{ id: '70804', rows: [w.good(id)] }]);
    expect(imported).toMatchObject({ ok: true });
    const before = await w.orders();
    expect(before).toEqual([expect.objectContaining({ est_commission_fen: 123n })]);

    w.clock.advanceMs(70_000);
    const run = await w.run(
      'increment',
      [{ id: '70805', rows: [w.bad(id, { estimateFee: undefined })] }],
      { window: 1 },
    );
    expect(run).toMatchObject({ ok: true });
    expect(await w.pending()).toEqual([
      quarantined(w, id, 70805n, { order_id: before[0]!.order_id }),
    ]);
    expect(await w.orders()).toEqual(before);
  }));

it('[AC-B1-04zv#8] 已有订单收到坏行：待处理的 order_id 填上，订单各列与状态历史都不变，水位前进', () =>
  withWorld(db, async (w) => {
    const id = decimalId();
    const imported = await w.run('increment', [{ id: '70801', rows: [w.good(id)] }]);
    expect(imported).toMatchObject({ ok: true });
    const before = await w.orders();
    expect(before).toHaveLength(1);
    const history = await w.history();

    w.clock.advanceMs(70_000);
    const run = await w.run('increment', [{ id: '70802', rows: [w.bad(id)] }], { window: 1 });
    expect(run).toMatchObject({ ok: true });
    expect(await w.pending()).toEqual([
      quarantined(w, id, 70802n, { order_id: before[0]!.order_id }),
    ]);
    expect(await w.orders()).toEqual(before);
    expect(await w.history()).toEqual(history);
    expect(await w.cursor('increment')).toBe(boundsOf(1).window_end);
  }));

it('[AC-B1-04zv#8] 同一子订单的键属于别的 App：order_id 留空（不写别家的订单），任务照常完成', () =>
  withWorld(db, async (w) => {
    const id = decimalId();
    await db
      .insertInto('order_keys')
      .values({
        platform: 'jd',
        sub_order_id: id,
        order_id: randomUUID(),
        app_id: `quarantine-other-${randomUUID()}`,
        attr_at: w.clock.now(),
      })
      .execute();
    const run = await w.run('increment', [{ id: '70803', rows: [w.bad(id)] }]);
    expect(run).toMatchObject({ ok: true });
    expect(await w.pending()).toEqual([quarantined(w, id, 70803n, { order_id: null })]);
    expect(await w.cursor('increment')).toBe(boundsOf(0).window_end);
  }));
