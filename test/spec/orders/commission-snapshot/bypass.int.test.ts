import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  createOrderPipeline,
  createOrderUpdateStep,
} from '../../../../apps/api/src/modules/orders/index.ts';
import { at, capture, fakePort, runUpdate, scenario, RECEIVED } from './db-kit.ts';

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

it.each(['P10', 'illegal', 'booked-unmapped'])(
  '[AC-B1-08k#35] 整条不落 orders（%s）不生成；后续合法 R3a 才调用',
  async (mode) => {
    const f = await scenario(
      db,
      {
        raw_status: mode === 'illegal' ? 'deposit' : 'received',
        received_at: at(RECEIVED),
        service_fee_fen: 31n,
      },
      { unattributed: true, regressionHold: () => true },
    );
    if (mode === 'booked-unmapped') {
      await db
        .updateTable('orders')
        .set({ rebate_status: 'CREDITED' })
        .where('app_id', '=', f.ctx.app_id)
        .execute();
    }
    f.findUser.mockResolvedValue(f.userId);
    const port = fakePort();
    const before = await f.read();
    const raw_status = mode === 'P10' ? 'paid' : mode === 'illegal' ? 'rights' : 'unknown';
    expect(await runUpdate(f, port, f.next({ raw_status }))).toMatchObject({
      ok: true,
      value: { kind: 'pending' },
    });
    expect(port.create).not.toHaveBeenCalled();
    expect(f.onUpdated).not.toHaveBeenCalled();
    expect((await f.read()).orders).toEqual(before.orders);
    expect(
      await runUpdate(
        f,
        port,
        f.next({ raw_status: mode === 'illegal' ? 'paid' : 'received', est_commission_fen: 888n }),
      ),
    ).toMatchObject({
      ok: true,
    });
    expect(port.create).toHaveBeenCalledTimes(1);
    expect(f.onUpdated.mock.calls[0]?.[1]).toMatchObject({ snapshot: 'created' });
  },
);

it.each(['stale', 'unchanged', 'app_conflict'])(
  '[AC-B1-08k#36] 外层短路 %s 不进入快照；未归因订单合法更新才生成',
  async (mode) => {
    const f = await scenario(db, { service_fee_fen: 31n }, { unattributed: true });
    f.findUser.mockResolvedValue(f.userId);
    const port = fakePort();
    const updateDeps = { ...f.updateDeps, snapshots: port, pids: f.deps.pids };
    const pipeline = createOrderPipeline({
      ...f.deps,
      mtimeOrdering: () => true,
      updateStep: createOrderUpdateStep(updateDeps),
    });
    const incoming =
      mode === 'unchanged' ? f.incoming : f.next({ modified_at: at('2026-10-02T03:04:05Z') });
    const ctx = mode === 'app_conflict' ? { ...f.ctx, app_id: `${f.ctx.app_id}-other` } : f.ctx;
    const before = await f.read();
    expect(await capture(() => pipeline.process(incoming, ctx))).toMatchObject({
      ok: true,
      value: { kind: mode },
    });
    expect(port.create).not.toHaveBeenCalled();
    expect(f.onUpdated).not.toHaveBeenCalled();
    expect(await f.read()).toEqual(before);
    expect(await capture(() => pipeline.process(f.next(), f.ctx))).toMatchObject({ ok: true });
    expect(port.create).toHaveBeenCalledTimes(1);
  },
);

it('[AC-B1-08k#38] R3a 同次 SETTLED 用写库后的结算收入而非本次预估', async () => {
  const f = await scenario(db, { service_fee_fen: 31n }, { unattributed: true });
  f.findUser.mockResolvedValue(f.userId);
  const port = fakePort();
  expect(
    await runUpdate(
      f,
      port,
      f.next({
        raw_status: 'settled',
        settle_commission_fen: 501n,
        est_commission_fen: 999n,
        received_at: at(RECEIVED),
        settled_at: at('2026-10-17T04:05:06Z'),
      }),
    ),
  ).toMatchObject({ ok: true });
  expect(port.create.mock.calls[0]?.[1]).toMatchObject({ nBaseFen: 501n });
  expect((await f.read()).orders[0]).toMatchObject({
    settle_commission_fen: 501n,
    est_commission_fen: 999n,
  });
});
