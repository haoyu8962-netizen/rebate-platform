import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  createOrderPipeline,
  createOrderUpdateStep,
  type OrderUpdateDeps,
} from '../../../../apps/api/src/modules/orders/index.ts';
import { fresh, runFresh, runUpdate, scenario, at, capture, RECEIVED } from './db-kit.ts';
import { realPort, splits } from './real-kit.ts';

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

it('[AC-B1-08k#32] 真实端口落一个快照；同单重放及 P3 金额变化不重建', async () => {
  const f = await fresh(db, {
    deposit_paid_at: at('2026-10-04T01:02:03Z'),
    paid_at: at('2026-10-12T02:03:04Z'),
    modified_at: at('2026-10-13T03:04:05Z'),
  });
  const port = await realPort(db, f);
  expect(await runFresh(f, port)).toMatchObject({ ok: true });
  const before = await splits(db, f.ctx.app_id);
  expect(before).toHaveLength(1);
  expect(before[0]).toMatchObject({
    app_id: f.ctx.app_id,
    order_id: (await f.read()).orders[0]!.order_id,
    rule_version_id: port.version.rule_version_id,
    paid_at: f.incoming.paid_at,
    paid_at_source: 'platform',
    raw_n_fen: 789n,
  });
  expect(await runFresh(f, port)).toMatchObject({ ok: true, value: { kind: 'unchanged' } });
  const updateDeps: OrderUpdateDeps & { snapshots: typeof port } = {
    ...f.deps,
    snapshots: port,
    rebate: { onUpdated: async () => {}, onUnmappedStatus: async () => {} },
    events: { publish: async () => ({ eventId: 'synthetic', duplicate: false }) },
  };
  f.clock.advanceMs(80_000);
  expect(
    await capture(() =>
      createOrderPipeline({ ...f.deps, updateStep: createOrderUpdateStep(updateDeps) }).process(
        {
          ...f.incoming,
          raw_status: 'received',
          received_at: at(RECEIVED),
          est_commission_fen: 899n,
          modified_at: at('2026-10-17T18:00:00Z'),
        },
        f.ctx,
      ),
    ),
  ).toMatchObject({ ok: true });
  expect(port.create).toHaveBeenCalledTimes(1);
  expect(await splits(db, f.ctx.app_id)).toEqual(before);
});

it('[AC-B1-08k#33] rebate 抛错时真实快照与订单、历史、pending 一起回滚', async () => {
  const f = await fresh(db, { raw_status: 'received', received_at: null });
  const port = await realPort(db, f);
  const before = await f.read();
  const error = new Error('synthetic settlement failure');
  const visible: number[] = [];
  f.onImported.mockImplementation(async (trx) => {
    visible.push((await splits(trx, f.ctx.app_id)).length);
    throw error;
  });
  expect(await runFresh(f, port)).toEqual({ ok: false, error });
  expect(visible).toEqual([1]);
  expect(port.create).toHaveBeenCalledTimes(1);
  expect(await splits(db, f.ctx.app_id)).toEqual([]);
  expect(await f.read()).toEqual(before);
  for (const table of [
    'commission_split_amounts',
    'commission_split_totals',
    'commission_split_beneficiary_events',
  ] as const) {
    expect(
      await db.selectFrom(table).selectAll().where('app_id', '=', f.ctx.app_id).execute(),
    ).toEqual([]);
  }
});

it('[AC-B1-08k#34] 并发重复入库由同单锁串行化，真实端口只调用一次', async () => {
  const f = await fresh(db);
  const port = await realPort(db, f);
  const results = await Promise.all([runFresh(f, port), runFresh(f, port)]);
  expect(results.every((r) => r.ok)).toBe(true);
  expect(port.create).toHaveBeenCalledTimes(1);
  expect(await splits(db, f.ctx.app_id)).toHaveLength(1);
  expect((await f.read()).orders).toHaveLength(1);
});

it('[AC-B1-08k#39] update rebate 抛错：真实快照和 P2 迁移一起回滚', async () => {
  const f = await scenario(db, { raw_status: 'deposit', service_fee_fen: 31n });
  const port = await realPort(db, f);
  const before = await f.read();
  const visible: number[] = [];
  const error = new Error('synthetic update settlement failure');
  f.onUpdated.mockImplementation(async (trx) => {
    visible.push((await splits(trx, f.ctx.app_id)).length);
    throw error;
  });
  expect(await runUpdate(f, port, f.next({ raw_status: 'paid' }))).toEqual({ ok: false, error });
  expect(visible).toEqual([1]);
  expect(await splits(db, f.ctx.app_id)).toEqual([]);
  expect(await f.read()).toEqual(before);
  expect(f.publish).not.toHaveBeenCalled();
});
