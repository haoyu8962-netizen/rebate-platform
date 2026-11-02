import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { fresh, fakePort, runFresh, at, RECEIVED, SETTLED } from './db-kit.ts';

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

it.each(['paid', 'received', 'settled'])(
  '[AC-B1-08k#19] 首次 %s 已归因：history 之后、rebate / events 之前同事务调用',
  async (raw_status) => {
    const f = await fresh(db, { raw_status, received_at: at(RECEIVED), settled_at: at(SETTLED) });
    const port = fakePort();
    const observations: {
      transaction: boolean;
      source: string | null | undefined;
      history: number;
      rebateCalls: number;
    }[] = [];
    const respond = port.create.getMockImplementation()!;
    port.create.mockImplementation(async (trx, input) => {
      const row = await trx
        .withSchema('app')
        .selectFrom('orders')
        .selectAll()
        .where('app_id', '=', input.appId)
        .where('order_id', '=', input.orderId)
        .executeTakeFirst();
      const history = await trx
        .withSchema('app')
        .selectFrom('order_status_history')
        .selectAll()
        .where('app_id', '=', input.appId)
        .where('order_id', '=', input.orderId)
        .execute();
      observations.push({
        transaction: trx.isTransaction,
        source: row?.paid_at_source,
        history: history.length,
        rebateCalls: f.onImported.mock.calls.length,
      });
      return respond(trx, input);
    });
    const publish = vi.fn().mockResolvedValue({ eventId: 'synthetic', duplicate: false });
    expect(await runFresh(f, port, { events: { publish } })).toMatchObject({
      ok: true,
      value: { kind: 'inserted' },
    });
    expect(port.create).toHaveBeenCalledTimes(1);
    const [trx, input] = port.create.mock.calls[0]!;
    const row = (await f.read()).orders[0]!;
    expect(input).toEqual({
      appId: f.ctx.app_id,
      orderId: row.order_id,
      platform: 'pdd',
      paidAt: f.incoming.paid_at,
      paidAtSource: 'platform',
      orderType: 'share',
      activityType: null,
      rebateMode: null,
      nBaseFen: 789n,
      subsidyCommissionFen: 0n,
      tljDeductFen: 0n,
      tljRedpacketFen: 0n,
      ownerUserId: f.userId,
    });
    expect(observations).toEqual([
      { transaction: true, rebateCalls: 0, source: 'platform', history: expect.any(Number) },
    ]);
    expect(observations[0]!.history).toBeGreaterThan(0);
    expect(f.onImported.mock.calls[0]?.[0]).toBe(trx);
    expect(f.onImported.mock.calls[0]?.[1]).toMatchObject({ snapshot: 'created' });
    expect(publish.mock.calls[0]?.[0]).toBe(trx);
    expect(port.create.mock.invocationCallOrder[0]).toBeLessThan(
      f.onImported.mock.invocationCallOrder[0]!,
    );
    expect(f.onImported.mock.invocationCallOrder[0]).toBeLessThan(
      publish.mock.invocationCallOrder[0]!,
    );
    expect(row).toMatchObject({
      paid_at_source: 'platform',
      est_commission_fen: 789n,
      n_total_fen: null,
      pre_base_deduct_fen: null,
      base_fen: null,
      platform_est_profit_fen: null,
      initial_est_fen: null,
      booked_base_fen: null,
      booked_n_fen: null,
      commission_version: 0,
      rebate_status: 'UNATTRIBUTED',
      paid_at: f.incoming.paid_at,
    });
  },
);

it.each(['unattributed', 'deposit', 'invalid'])(
  '[AC-B1-08k#20] %s 不调快照，settlement 明确收到 none',
  async (mode) => {
    const f = await fresh(db, {
      raw_status: mode === 'deposit' || mode === 'invalid' ? mode : 'paid',
    });
    if (mode === 'unattributed') f.findUser.mockResolvedValue(null);
    const port = fakePort();
    expect(await runFresh(f, port)).toMatchObject({
      ok: true,
      value: { kind: 'inserted' },
    });
    expect(port.create).not.toHaveBeenCalled();
    expect(f.onImported.mock.calls[0]?.[1]).toMatchObject({ snapshot: 'none' });
  },
);

it('[AC-B1-08k#21] existing 结果继续向 settlement 传递，不改成 created', async () => {
  const f = await fresh(db);
  const port = fakePort('existing');
  expect(await runFresh(f, port)).toMatchObject({ ok: true });
  expect(port.create).toHaveBeenCalledTimes(1);
  expect(f.onImported.mock.calls[0]?.[1]).toMatchObject({ snapshot: 'existing' });
});

it('[AC-B1-08k#22] 缺收货时间 pending 已在同事务可见，按最终 PAID 调快照', async () => {
  const f = await fresh(db, { raw_status: 'received', received_at: null });
  const port = fakePort();
  const observed: string[][] = [];
  const respond = port.create.getMockImplementation()!;
  port.create.mockImplementation(async (trx, input) => {
    const rows = await trx
      .withSchema('app')
      .selectFrom('order_sync_pending')
      .select('reason')
      .where('app_id', '=', input.appId)
      .execute();
    observed.push(rows.map((r) => r.reason));
    return respond(trx, input);
  });
  expect(await runFresh(f, port)).toMatchObject({ ok: true });
  expect(observed).toEqual([['NO_RECEIVED_AT']]);
  expect(f.onImported.mock.calls[0]?.[1]).toMatchObject({ snapshot: 'created' });
});

it.each(['platform_modified', 'observed'])(
  '[AC-B1-08k#40] 首次预售已付缺尾款，%s 来源同次写入订单和快照入参',
  async (source) => {
    const deposit = at('2026-10-04T01:02:03Z');
    const modified = at('2026-10-13T03:04:05Z');
    const f = await fresh(db, {
      deposit_paid_at: deposit,
      paid_at: at(deposit.toISOString()),
      modified_at: source === 'observed' ? null : modified,
    });
    const port = fakePort();
    expect(await runFresh(f, port)).toMatchObject({ ok: true });
    expect(port.create.mock.calls[0]?.[1]).toMatchObject({
      paidAtSource: source,
      paidAt: source === 'observed' ? f.clock.now() : modified,
    });
    expect((await f.read()).orders[0]).toMatchObject({ paid_at_source: source, paid_at: deposit });
  },
);
