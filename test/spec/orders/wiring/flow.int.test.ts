import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { UnionAdapter } from '../../../../apps/api/src/modules/union/index.ts';
import { handleOrderSyncWindow } from '../../../../apps/api/src/modules/orders/jobs/order-sync.ts';
import { order } from '../attribution/kit.ts';
import { job } from '../sync/kit.ts';
import { account, at, pid, START, user } from './db-kit.ts';
import { contextOf, runtime } from './context-kit.ts';

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

it('[AC-B1-08n#19] worker 运行体接通真实归因/更新/事件总线；一页订单入库、水位推进、更新不重复建单', async () => {
  const a = await account(db);
  const u = await user(db, a.app_id, { status: 'deleted' });
  await pid(db, a);
  const f = await contextOf('worker', true, db);
  try {
    const r = await runtime(f.context);
    const end = '2026-10-17T17:00:00.000Z';
    const win = {
      app_id: a.app_id,
      platform: 'pdd' as const,
      union_account_id: a.id,
      query_kind: 'increment' as const,
      scene: '-' as const,
      window_start: START,
      window_end: end,
    };
    const incoming = order({ raw_status: '0', sub_order_id: randomUUID() });
    const listOrders = vi
      .fn<UnionAdapter['listOrders']>()
      .mockResolvedValue({ items: [incoming], nextCursor: null });
    // Only the adapter and credential lookup are replaced: demo credentials are deliberately
    // non-queryable. Real access auth, cursor store, mapping, pipeline and readers remain wired.
    expect(typeof r.access.queryableAccount).toBe('function');
    vi.spyOn(r.access, 'queryableAccount').mockResolvedValue(a.id);
    const registered = f.queue.register.mock.calls.find(([name]) => name === 'order-sync')?.[1];
    expect(typeof registered).toBe('function');
    vi.spyOn(r.registry, 'get').mockReturnValue({ listOrders });
    await registered!(job(win));
    const read = () => db.selectFrom('orders').selectAll().where('app_id', '=', a.app_id).execute();
    const rows = await read();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      user_id: u.id,
      platform_status: 'PAID',
      rebate_status: expect.stringMatching(/^(UNATTRIBUTED|ESTIMATED)$/),
    });
    expect(await r.cursors.read(win)).toBe(end);
    expect(listOrders.mock.calls[0]?.[2]).toMatchObject({ appId: a.app_id, purpose: 'order_sync' });
    const events = () =>
      db.selectFrom('event_log').selectAll().where('app_id', '=', a.app_id).execute();
    expect(await events()).toEqual([expect.objectContaining({ name: 'order.created' })]);
    // Use the same assembled pipeline/updateStep on the next observed normalized order.
    listOrders.mockResolvedValue({
      items: [
        {
          ...incoming,
          raw_status: '2',
          received_at: at('2026-10-16T03:04:05.000Z'),
          raw_payload_id: '202',
        },
      ],
      nextCursor: null,
    });
    const next = { ...win, window_start: end, window_end: '2026-10-17T17:30:00.000Z' };
    await handleOrderSyncWindow(job(next), r);
    const updated = await read();
    expect(updated).toHaveLength(1);
    expect(updated[0]).toMatchObject({
      order_id: rows[0]!.order_id,
      user_id: u.id,
      platform_status: 'RECEIVED',
    });
    expect(await r.cursors.read(next)).toBe(next.window_end);
    expect((await events()).map((e) => e.name).sort()).toEqual(['order.created', 'order.updated']);
  } finally {
    await f.context.close();
  }
});
