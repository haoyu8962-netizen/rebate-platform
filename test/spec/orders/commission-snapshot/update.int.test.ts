import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { at, fakePort, runUpdate, scenario, RECEIVED, untouchedAmounts } from './db-kit.ts';

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

it('[AC-B1-08k#23] P2 按库内预估收入调用，P3 不重建，paid_at_source 只写一次', async () => {
  const deposit = at('2026-10-04T01:02:03Z');
  const f = await scenario(db, {
    raw_status: 'deposit',
    paid_at: deposit,
    deposit_paid_at: deposit,
    service_fee_fen: 31n,
  });
  const port = fakePort();
  const seen: unknown[] = [];
  const respond = port.create.getMockImplementation()!;
  port.create.mockImplementation(async (trx, input) => {
    seen.push(
      await trx
        .withSchema('app')
        .selectFrom('orders')
        .select(['platform_status', 'paid_at_source'])
        .where('app_id', '=', input.appId)
        .where('order_id', '=', input.orderId)
        .executeTakeFirst(),
    );
    seen.push(
      await trx
        .withSchema('app')
        .selectFrom('order_status_history')
        .select('to_status')
        .where('app_id', '=', input.appId)
        .where('to_status', '=', 'PAID')
        .execute(),
    );
    return respond(trx, input);
  });
  const incoming = f.next({ raw_status: 'paid', settle_commission_fen: 501n });
  expect(await runUpdate(f, port, incoming)).toMatchObject({
    ok: true,
    value: { kind: 'updated' },
  });
  expect(port.create).toHaveBeenCalledTimes(1);
  expect(port.create.mock.calls[0]?.[1]).toMatchObject({
    nBaseFen: 789n,
    paidAt: incoming.modified_at,
    paidAtSource: 'platform_modified',
  });
  expect(seen).toEqual([
    { platform_status: 'PAID', paid_at_source: 'platform_modified' },
    [{ to_status: 'PAID' }],
  ]);
  expect(f.onUpdated.mock.calls[0]?.[0]).toBe(port.create.mock.calls[0]?.[0]);
  expect(f.publish.mock.calls[0]?.[0]).toBe(port.create.mock.calls[0]?.[0]);
  expect(f.onUpdated.mock.calls[0]?.[1]).toMatchObject({ snapshot: 'created' });
  expect(port.create.mock.invocationCallOrder[0]).toBeLessThan(
    f.onUpdated.mock.invocationCallOrder[0]!,
  );
  expect(f.onUpdated.mock.invocationCallOrder[0]).toBeLessThan(
    f.publish.mock.invocationCallOrder[0]!,
  );
  const after = await f.read();
  expect(untouchedAmounts(after.orders[0]!)).toEqual(untouchedAmounts(f.original));
  f.clock.advanceMs(90_000);
  expect(
    await runUpdate(f, port, f.next({ raw_status: 'received', received_at: at(RECEIVED) })),
  ).toMatchObject({ ok: true });
  expect(port.create).toHaveBeenCalledTimes(1);
  expect(f.onUpdated.mock.calls[1]?.[1]).toMatchObject({ snapshot: 'none' });
  expect((await f.read()).orders[0]?.paid_at_source).toBe('platform_modified');
});

it.each(['PAID', 'DEPOSIT_PAID', 'VOID', 'CLAWED_BACK'])(
  '[AC-B1-08k#24] 同步归属 %s：R3a 仅已付调用、R3b 和扣回不调用',
  async (state) => {
    const f = await scenario(
      db,
      { raw_status: state === 'DEPOSIT_PAID' ? 'deposit' : 'paid', service_fee_fen: 31n },
      { unattributed: true },
    );
    if (state === 'VOID' || state === 'CLAWED_BACK') {
      await db
        .updateTable('orders')
        .set({ rebate_status: state })
        .where('app_id', '=', f.ctx.app_id)
        .execute();
    }
    f.findUser.mockResolvedValue(f.userId);
    const port = fakePort();
    expect(await runUpdate(f, port)).toMatchObject({ ok: true, value: { kind: 'updated' } });
    expect(port.create).toHaveBeenCalledTimes(state === 'PAID' ? 1 : 0);
    expect(f.onUpdated.mock.calls[0]?.[1]).toMatchObject({
      attributed_now: true,
      snapshot: state === 'PAID' ? 'created' : 'none',
    });
    const row = (await f.read()).orders[0]!;
    expect(row.user_id).toBe(f.userId);
    expect(row.rebate_status).toBe(
      state === 'VOID' || state === 'CLAWED_BACK' ? state : 'UNATTRIBUTED',
    );
  },
);

it('[AC-B1-08k#25] 晚归属 observed 取首条已付历史，不取定金历史或本次 now', async () => {
  const deposit = at('2026-10-04T01:02:03Z');
  const f = await scenario(
    db,
    { raw_status: 'paid', paid_at: deposit, deposit_paid_at: deposit, service_fee_fen: 31n },
    { unattributed: true },
  );
  const firstPaidAt = f.before.history.find(
    (r) => r.field === 'platform' && r.to_status === 'PAID',
  )!.at;
  await db
    .insertInto('order_status_history')
    .values({
      app_id: f.ctx.app_id,
      order_id: f.original.order_id,
      field: 'platform',
      from_status: null,
      event: 'PLATFORM_DEPOSIT_PAID',
      to_status: 'DEPOSIT_PAID',
      source: 'sync',
      at: deposit,
    })
    .execute();
  f.findUser.mockResolvedValue(f.userId);
  const port = fakePort();
  expect(await runUpdate(f, port)).toMatchObject({ ok: true });
  expect(port.create.mock.calls[0]?.[1]).toMatchObject({
    paidAt: firstPaidAt,
    paidAtSource: 'observed',
  });
  expect((await f.read()).orders[0]).toMatchObject({
    paid_at: deposit,
    paid_at_source: 'observed',
  });
});

it('[AC-B1-08k#26] update 已有 paid_at_source 不覆盖；pid 查不到告警并按非淘礼金处理', async () => {
  const f = await scenario(db, { service_fee_fen: 31n }, { unattributed: true });
  await db
    .updateTable('orders')
    .set({ paid_at_source: 'observed' })
    .where('app_id', '=', f.ctx.app_id)
    .execute();
  f.findUser.mockResolvedValue(f.userId);
  f.findPid.mockResolvedValue([]);
  const port = fakePort();
  expect(await runUpdate(f, port)).toMatchObject({ ok: true });
  expect(port.create).toHaveBeenCalledTimes(1);
  expect((await f.read()).orders[0]?.paid_at_source).toBe('observed');
  expect(f.logger.warn).toHaveBeenCalled();
});
