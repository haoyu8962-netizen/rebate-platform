// B1-04zv：取不到单号的坏行，sub_order_id = `row:` + 行内容 sha256 前 32 位十六进制（占位键）。同一行再来是
// 同一个键，内容不同是另一个键。行内容怎样序列化是实现的事，这里只看形状与相等关系；占位键没有对应的好行，
// 不会被自动解决。
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { num } from '../../union/jd-orders/kit.ts';
import { decimalId, withWorld } from './worker-harness.ts';

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

const PLACEHOLDER = /^row:[0-9a-f]{32}$/;

it('[AC-B1-04zv#11] 无单号坏行：占位键 row:<32 位十六进制>；同行重试同键、只一行，P1 只一条', () =>
  withWorld(db, async (w) => {
    const row = w.nameless();
    const first = await w.run('increment', [{ id: '71101', rows: [row] }]);
    expect(first).toMatchObject({ ok: true });
    const opened = await w.pending();
    expect(opened).toEqual([
      expect.objectContaining({
        sub_order_id: expect.stringMatching(PLACEHOLDER),
        order_id: null,
        status: 'open',
      }),
    ]);

    w.clock.advanceMs(70_000);
    const again = await w.run('increment', [{ id: '71102', rows: [row] }], { window: 1 });
    expect(again).toMatchObject({ ok: true });
    expect(await w.pending()).toEqual(
      opened.map((pending) => ({ ...pending, detected_at: w.clock.now() })),
    );
    expect(w.alerts()).toHaveLength(1);
  }));

it('[AC-B1-04zv#11] 内容不同的两条无单号坏行是两个键，同一页也不互相覆盖', () =>
  withWorld(db, async (w) => {
    const run = await w.run('increment', [
      {
        id: '71103',
        rows: [
          w.nameless({ orderId: num('3123456789012001') }),
          w.nameless({ orderId: num('3123456789012002') }),
        ],
      },
    ]);
    expect(run).toMatchObject({ ok: true });
    const keys = (await w.pending()).map((pending) => pending.sub_order_id);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
    for (const key of keys) expect(key).toMatch(PLACEHOLDER);
  }));

it('[AC-B1-04zv#11] 好行永远不会自动解决占位行：同一父单的好行入库后它仍是 open', () =>
  withWorld(db, async (w) => {
    const orderId = num('3123456789012003');
    const broken = await w.run('increment', [{ id: '71104', rows: [w.nameless({ orderId })] }]);
    expect(broken).toMatchObject({ ok: true });
    const opened = await w.pending();
    expect(opened).toEqual([expect.objectContaining({ status: 'open', resolved_at: null })]);

    const id = decimalId();
    const good = await w.run('increment', [{ id: '71105', rows: [w.good(id, { orderId })] }], {
      window: 1,
    });
    expect(good).toMatchObject({ ok: true });
    expect(await w.subOrders()).toEqual([id]);
    expect(await w.pending()).toEqual(opened);
  }));
