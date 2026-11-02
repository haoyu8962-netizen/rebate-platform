// B1-04zv：好行入库或更新时，与它同事务解决 (app, platform, sub_order_id, ORDER_ROW_INVALID) 的 open 记录：
// status=resolved，resolved_at 取 Clock，resolved_by 为空，resolution_note 写来源与好行的 raw_payload_id。
// 只有订单真的入库、更新或内容已相同才算解决；丢弃、app_conflict、整条拒收都不算。只改 status='open' 的行。
import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { num } from '../../union/jd-orders/kit.ts';
import { capture } from '../attribution/kit.ts';
import {
  decimalId,
  FINISHED,
  PENDING_UPDATE,
  quarantined,
  REASON,
  ROUTES,
  sabotage,
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

it.each(ROUTES)(
  '[AC-B1-04zv#9] 修正：%s 下一轮同单好行入库，open 记录同事务置 resolved，时刻取 Clock、说明含来源与好行归档 id',
  (route) =>
    withWorld(db, async (w) => {
      const id = decimalId();
      const broken = await w.run('increment', [{ id: '70901', rows: [w.bad(id)] }]);
      expect(broken).toMatchObject({ ok: true });
      const [opened] = await w.pending();
      expect(opened).toMatchObject({ sub_order_id: id, status: 'open' });

      w.clock.advanceMs(70_000);
      const fixed = await w.run(route, [{ id: '70902', rows: [w.good(id)] }], { window: 1 });
      expect(fixed).toMatchObject({ ok: true });
      expect(await w.subOrders()).toEqual([id]);
      const after = await w.pending();
      expect(after).toEqual([
        expect.objectContaining({
          id: opened?.id,
          status: 'resolved',
          resolved_at: w.clock.now(),
          resolved_by: null,
        }),
      ]);
      const note = after[0]!.resolution_note;
      expect(note).toContain(route);
      expect(note).toContain('70902');
      for (const other of ROUTES.filter((name) => name !== route)) {
        expect(note).not.toContain(other);
      }
    }),
);

it('[AC-B1-04zv#9] 已有订单走更新路径也解决：坏行之后同单好行带来新内容，订单更新，open 记录 resolved', () =>
  withWorld(db, async (w) => {
    const id = decimalId();
    const imported = await w.run('increment', [{ id: '70903', rows: [w.good(id)] }]);
    expect(imported).toMatchObject({ ok: true });
    const broken = await w.run('increment', [{ id: '70904', rows: [w.bad(id)] }], { window: 1 });
    expect(broken).toMatchObject({ ok: true });
    const [opened] = await w.pending();
    expect(opened).toMatchObject({ sub_order_id: id, status: 'open' });

    w.clock.advanceMs(70_000);
    const fixed = await w.run(
      'increment',
      [{ id: '70905', rows: [w.good(id, { estimateFee: num('2.34') })] }],
      { window: 2 },
    );
    expect(fixed).toMatchObject({ ok: true });
    expect(await w.orders()).toEqual([expect.objectContaining({ est_commission_fen: 234n })]);
    const after = await w.pending();
    expect(after).toEqual([
      expect.objectContaining({
        id: opened?.id,
        status: 'resolved',
        resolved_at: w.clock.now(),
        resolved_by: null,
      }),
    ]);
    expect(after[0]!.resolution_note).toContain('increment');
    expect(after[0]!.resolution_note).toContain('70905');
  }));

// 好行内容与库内完全相同时流水线走 content_hash 短路（pipeline-port 的 unchanged），不进更新路径。
// 时钟前进后订单整行不变，证明走的确实是短路：更新路径会刷 updated_at。
it.each(ROUTES)(
  '[AC-B1-04zv#9] %s：已有订单收到坏行，平台改回原样，好行走 unchanged 短路，open 记录也解决，订单与历史不变',
  (route) =>
    withWorld(db, async (w) => {
      const id = decimalId();
      const imported = await w.run('increment', [{ id: '70911', rows: [w.good(id)] }]);
      expect(imported).toMatchObject({ ok: true });
      const before = await w.orders();
      expect(before).toHaveLength(1);
      const history = await w.history();

      const broken = await w.run('increment', [{ id: '70912', rows: [w.bad(id)] }], { window: 1 });
      expect(broken).toMatchObject({ ok: true });
      const [opened] = await w.pending();
      expect(opened).toMatchObject({
        sub_order_id: id,
        status: 'open',
        order_id: before[0]!.order_id,
      });

      w.clock.advanceMs(70_000);
      const fixed = await w.run(route, [{ id: '70913', rows: [w.good(id)] }], { window: 2 });
      expect(fixed).toMatchObject({ ok: true });
      expect(await w.orders()).toEqual(before);
      expect(await w.history()).toEqual(history);
      const after = await w.pending();
      expect(after).toEqual([
        expect.objectContaining({
          id: opened?.id,
          status: 'resolved',
          resolved_at: w.clock.now(),
          resolved_by: null,
        }),
      ]);
      const note = after[0]!.resolution_note;
      expect(note).toContain(route);
      expect(note).toContain('70913');
    }),
);

it('[AC-B1-04zv#9] 解决与入库同事务：解决写失败时好行也回滚，open 记录原样留着，任务失败可重试', async () => {
  const broken = sabotage(db, PENDING_UPDATE);
  await withWorld(
    db,
    async (w) => {
      const id = decimalId();
      const opened = await w.run('increment', [{ id: '70906', rows: [w.bad(id)] }]);
      expect(opened).toMatchObject({ ok: true });
      expect(await w.pending()).toEqual([quarantined(w, id, 70906n)]);

      broken.state.armed = true;
      const fixed = await w.run('increment', [{ id: '70907', rows: [w.good(id)] }], { window: 1 });
      broken.state.armed = false;
      expect(broken.state.hits, 'the resolving UPDATE was reached').toBeGreaterThan(0);
      expect(fixed).toMatchObject({ ok: false });
      expect(await w.subOrders()).toEqual([]);
      expect(await w.pending()).toEqual([quarantined(w, id, 70906n)]);
    },
    broken.db,
  );
});

it('[AC-B1-04zv#9] 更新路径同事务：解决写失败时订单更新也回滚，open 记录原样留着，重试后才解决', async () => {
  const broken = sabotage(db, PENDING_UPDATE);
  await withWorld(
    db,
    async (w) => {
      const id = decimalId();
      const imported = await w.run('increment', [{ id: '70914', rows: [w.good(id)] }]);
      expect(imported).toMatchObject({ ok: true });
      const opened = await w.run('increment', [{ id: '70915', rows: [w.bad(id)] }], { window: 1 });
      expect(opened).toMatchObject({ ok: true });
      const [orders, history, pending] = [await w.orders(), await w.history(), await w.pending()];
      expect(pending).toEqual([expect.objectContaining({ sub_order_id: id, status: 'open' })]);

      w.clock.advanceMs(70_000);
      const changed = { id: '70916', rows: [w.good(id, { estimateFee: num('2.34') })] };
      broken.state.armed = true;
      const fixed = await w.run('increment', [changed], { window: 2 });
      broken.state.armed = false;
      expect(broken.state.hits, 'the resolving UPDATE was reached').toBeGreaterThan(0);
      expect(fixed).toMatchObject({ ok: false });
      expect(await w.orders()).toEqual(orders);
      expect(await w.history()).toEqual(history);
      expect(await w.pending()).toEqual(pending);

      const retried = await w.run('increment', [changed], { window: 2, attempt: 2 });
      expect(retried).toMatchObject({ ok: true });
      expect(await w.orders()).toEqual([expect.objectContaining({ est_commission_fen: 234n })]);
      expect(await w.pending()).toEqual([expect.objectContaining({ status: 'resolved' })]);
    },
    broken.db,
  );
});

// 这几条好行都过了映射，但流水线没让它落库：坏行修没修好还不知道，待处理不能关。
it.each([
  { outcome: 'PID_NOT_OURS', row: { positionId: num('3999999999') } },
  { outcome: 'NO_PAY_TIME', row: { validCode: num('15') } },
  { outcome: 'BEFORE_SYNC_START', row: { orderTime: '2026-09-01 08:00:01' } },
])('[AC-B1-04zv#9] 好行被丢弃（$outcome）：没入库，open 记录不解决', ({ row }) =>
  withWorld(db, async (w) => {
    const id = decimalId();
    const broken = await w.run('increment', [{ id: '70917', rows: [w.bad(id)] }]);
    expect(broken).toMatchObject({ ok: true });
    const opened = await w.pending();
    expect(opened).toEqual([quarantined(w, id, 70917n)]);

    w.clock.advanceMs(70_000);
    const dropped = await w.run('increment', [{ id: '70918', rows: [w.good(id, row)] }], {
      window: 1,
    });
    expect(dropped).toMatchObject({ ok: true });
    expect(await w.subOrders()).toEqual([]);
    expect(await w.pending()).toEqual(opened);
  }),
);

it('[AC-B1-04zv#9] 单号键属于别的 App（app_conflict）：好行没入库，open 记录不解决', () =>
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
    const broken = await w.run('increment', [{ id: '70919', rows: [w.bad(id)] }]);
    expect(broken).toMatchObject({ ok: true });
    const opened = await w.pending();
    expect(opened).toEqual([quarantined(w, id, 70919n, { order_id: null })]);

    w.clock.advanceMs(70_000);
    const conflict = await w.run('increment', [{ id: '70920', rows: [w.good(id)] }], { window: 1 });
    expect(conflict).toMatchObject({ ok: true });
    expect(await w.subOrders()).toEqual([]);
    expect(await w.pending()).toEqual(opened);
  }));

it('[AC-B1-04zv#9] 好行首态是表外码：只进 UNMAPPED_STATUS 待处理没入库，ORDER_ROW_INVALID 那条不解决', () =>
  withWorld(db, async (w) => {
    const id = decimalId();
    const broken = await w.run('increment', [{ id: '70921', rows: [w.bad(id)] }]);
    expect(broken).toMatchObject({ ok: true });
    const opened = await w.pending();
    expect(opened).toEqual([quarantined(w, id, 70921n)]);

    w.clock.advanceMs(70_000);
    const unmapped = await w.run(
      'increment',
      [{ id: '70922', rows: [w.good(id, { validCode: num('99') })] }],
      { window: 1 },
    );
    expect(unmapped).toMatchObject({ ok: true });
    expect(await w.subOrders()).toEqual([]);
    expect(await w.pending()).toEqual([
      ...opened,
      expect.objectContaining({ sub_order_id: id, reason: 'UNMAPPED_STATUS', status: 'open' }),
    ]);
  }));

// 结果带 order_id 也不等于入库：P10 倒退整条拒收，订单一列没动，只多一条 ILLEGAL_TRANSITION。
it('[AC-B1-04zv#9] 已有订单的好行被整条拒收（倒退）：订单不变，ORDER_ROW_INVALID 那条不解决', () =>
  withWorld(db, async (w) => {
    const id = decimalId();
    const imported = await w.run('increment', [{ id: '70923', rows: [w.good(id, FINISHED)] }]);
    expect(imported).toMatchObject({ ok: true });
    const before = await w.orders();
    expect(before).toEqual([expect.objectContaining({ platform_status: 'RECEIVED' })]);
    const broken = await w.run('increment', [{ id: '70924', rows: [w.bad(id)] }], { window: 1 });
    expect(broken).toMatchObject({ ok: true });
    const opened = await w.pending();
    expect(opened).toEqual([expect.objectContaining({ reason: REASON, status: 'open' })]);

    w.clock.advanceMs(70_000);
    const rejected = await w.run('increment', [{ id: '70925', rows: [w.good(id)] }], { window: 2 });
    expect(rejected).toMatchObject({ ok: true });
    expect(await w.orders()).toEqual(before);
    expect(await w.pending()).toEqual([
      ...opened,
      expect.objectContaining({ reason: 'ILLEGAL_TRANSITION', status: 'open' }),
    ]);
  }));

it.each([
  { path: 'unchanged', again: {} },
  { path: 'updated', again: { estimateFee: num('2.34') } },
])(
  '[AC-B1-04zv#9] 只改 open 的行：好行再投一次（$path），已 resolved 的 resolved_at 与说明不变',
  ({ again }) =>
    withWorld(db, async (w) => {
      const id = decimalId();
      const broken = await w.run('increment', [{ id: '70926', rows: [w.bad(id)] }]);
      expect(broken).toMatchObject({ ok: true });
      w.clock.advanceMs(70_000);
      const fixed = await w.run('increment', [{ id: '70927', rows: [w.good(id)] }], { window: 1 });
      expect(fixed).toMatchObject({ ok: true });
      const resolved = await w.pending();
      expect(resolved).toEqual([expect.objectContaining({ status: 'resolved' })]);

      w.clock.advanceMs(70_000);
      const redelivered = await w.run('rescan', [{ id: '70928', rows: [w.good(id, again)] }], {
        window: 2,
      });
      expect(redelivered).toMatchObject({ ok: true });
      expect(await w.pending()).toEqual(resolved);
    }),
);

it.each([
  { path: 'inserted', imported: false },
  { path: 'unchanged', imported: true },
])(
  '[AC-B1-04zv#9] 只改 open 的行：人工 dismissed 的记录，好行来了（$path）也不动',
  ({ imported }) =>
    withWorld(db, async (w) => {
      const id = decimalId();
      if (imported) {
        const first = await w.run('increment', [{ id: '70929', rows: [w.good(id)] }]);
        expect(first).toMatchObject({ ok: true });
      }
      const broken = await w.run('increment', [{ id: '70930', rows: [w.bad(id)] }], { window: 1 });
      expect(broken).toMatchObject({ ok: true });
      const [opened] = await w.pending();
      expect(opened).toMatchObject({ sub_order_id: id, status: 'open' });
      await db
        .updateTable('order_sync_pending')
        .set({ status: 'dismissed', resolved_at: w.clock.now(), resolution_note: 'synthetic' })
        .where('id', '=', opened!.id)
        .execute();
      const dismissed = await w.pending();

      w.clock.advanceMs(70_000);
      const fixed = await w.run('increment', [{ id: '70931', rows: [w.good(id)] }], { window: 2 });
      expect(fixed).toMatchObject({ ok: true });
      expect(await w.subOrders()).toEqual([id]);
      expect(await w.pending()).toEqual(dismissed);
    }),
);

it('[AC-B1-04zv#9] 解决后同单再坏：新开一条并再打 P1，已解决的那条不动', () =>
  withWorld(db, async (w) => {
    const id = decimalId();
    const first = await w.run('increment', [{ id: '70908', rows: [w.bad(id)] }]);
    expect(first).toMatchObject({ ok: true });
    const fixed = await w.run('increment', [{ id: '70909', rows: [w.good(id)] }], { window: 1 });
    expect(fixed).toMatchObject({ ok: true });
    const [resolved] = await w.pending();
    expect(resolved).toMatchObject({ status: 'resolved' });

    const again = await w.run('increment', [{ id: '70910', rows: [w.bad(id)] }], { window: 2 });
    expect(again).toMatchObject({ ok: true });
    const orderId = (await w.orders())[0]?.order_id;
    expect(await w.pending()).toEqual([
      resolved,
      quarantined(w, id, 70910n, { order_id: orderId }),
    ]);
    expect(w.alerts()).toHaveLength(2);
  }));

it('[AC-B1-04zv#10] 精确匹配：别的 App、别的平台、别的单号、别的 reason 的 open 记录都不动', () =>
  withWorld(db, async (w) => {
    const id = decimalId();
    const broken = await w.run('increment', [{ id: '71001', rows: [w.bad(id)] }]);
    expect(broken).toMatchObject({ ok: true });
    const base = {
      app_id: w.app,
      platform: 'jd',
      sub_order_id: id,
      reason: REASON,
      detail: 'synthetic neighbour',
      detected_at: w.clock.now(),
      status: 'open',
    };
    const neighbours = [
      { ...base, app_id: `quarantine-other-${randomUUID()}` },
      { ...base, platform: 'pdd' },
      { ...base, sub_order_id: decimalId() },
      { ...base, reason: 'UNMAPPED_STATUS' },
    ];
    for (const row of neighbours) {
      const seeded = await capture(() => db.insertInto('order_sync_pending').values(row).execute());
      expect(seeded).toMatchObject({ ok: true });
    }
    const read = () =>
      db
        .selectFrom('order_sync_pending')
        .selectAll()
        .where('sub_order_id', 'in', [id, neighbours[2]!.sub_order_id])
        .orderBy('id')
        .execute();
    const before = await read();
    expect(before).toHaveLength(5);

    w.clock.advanceMs(70_000);
    const fixed = await w.run('increment', [{ id: '71002', rows: [w.good(id)] }], { window: 1 });
    expect(fixed).toMatchObject({ ok: true });
    const after = await read();
    expect(after[0]).toMatchObject({ id: before[0]?.id, status: 'resolved' });
    expect(after.slice(1)).toEqual(before.slice(1));
  }));
