import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  fixture,
  assertAlert,
  capture,
  HOUR,
  HANDOFF,
  positiveControl,
  succeed,
  splits,
} from './kit.ts';

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

it.each(['pipeline', 'scan', 'error'] as const)(
  '[AC-B1-08u#9] %s 在23h59m仍不发，恰好24h才告警',
  async (path) => {
    // 两张独立订单避免前一次扫描刷新 detected_at 而遮住24h边界。
    for (const age of [24 * HOUR - 60_000, 24 * HOUR]) {
      const f = await fixture(db, path === 'pipeline' ? 'pipeline' : 'scan');
      const first = (await f.pending())[0]!;
      if (path === 'error') f.port.create.mockRejectedValue(new Error('synthetic port failure'));
      f.clock.advanceMs(age);
      const incoming = { ...f.incoming, modified_at: f.clock.now(), paid_fen: 12346n };
      expect(
        await capture<unknown>(() => (path === 'pipeline' ? f.process(incoming) : f.scan())),
      ).toMatchObject({ ok: true });
      expect(f.port.create).toHaveBeenCalledTimes(1);
      if (age < 24 * HOUR) {
        expect(f.events()).toEqual([]);
        expect(f.alerts()).toEqual([]);
        expect((await f.pending())[0]).toMatchObject({
          created_at: first.created_at,
          resolution_note: first.resolution_note,
        });
      } else {
        assertAlert(f, first);
        expect((await f.pending())[0]).toMatchObject({
          resolution_note: HANDOFF,
          status: 'open',
          resolved_at: null,
        });
      }
    }
  },
);

it.each(['pipeline', 'scan'] as const)(
  '[AC-B1-08u#10] %s 满24h成功 created 或 existing 只处置，不发耗尽事件',
  async (path) => {
    for (const outcome of ['created', 'existing']) {
      const f = await fixture(db, path);
      const port = await succeed(f, db);
      if (outcome === 'existing') {
        await db.transaction().execute((trx) =>
          port.create(trx, {
            appId: f.ctx.app_id,
            orderId: f.current.order_id,
            platform: f.incoming.platform,
            paidAt: f.current.paid_at!,
            paidAtSource: 'platform',
            orderType: 'share',
            activityType: null,
            rebateMode: null,
            nBaseFen: path === 'pipeline' ? 758n : 789n,
            subsidyCommissionFen: 0n,
            tljDeductFen: 0n,
            tljRedpacketFen: 0n,
            ownerUserId: f.userId,
          }),
        );
      }
      port.create.mockClear();
      f.clock.advanceMs(24 * HOUR);
      expect(
        await capture<unknown>(() => (path === 'pipeline' ? f.process(f.next()) : f.scan())),
      ).toMatchObject({ ok: true });
      expect(port.create).toHaveBeenCalledTimes(1);
      expect((await f.pending())[0]).toMatchObject({
        status: 'resolved',
        resolution_note: `auto: commission snapshot ${outcome}`,
        resolved_at: f.clock.now(),
      });
      expect(await splits(db, f.ctx.app_id)).toHaveLength(1);
      expect(f.events()).toEqual([]);
      expect(f.alerts()).toEqual([]);
    }
    await positiveControl(db);
  },
);

it.each(['CLAWED_BACK', 'unattributed'] as const)(
  '[AC-B1-08u#11] %s 用有变化报文进入更新仍不重试、不告警，扫描也跳过',
  async (guard) => {
    const f = await fixture(db);
    await db
      .withSchema('app')
      .updateTable('orders')
      .set(guard === 'unattributed' ? { user_id: null } : { rebate_status: 'CLAWED_BACK' })
      .where('app_id', '=', f.ctx.app_id)
      .execute();
    // 未归属订单也不能在本次报文被重新归属，确保命中所测守卫。
    if (guard === 'unattributed') f.findUser.mockResolvedValue(null);
    const before = await f.pending();
    const orderBefore = (await f.read()).orders[0]!;
    f.clock.advanceMs(24 * HOUR);
    const incoming = f.next();
    expect(incoming.modified_at).not.toEqual(f.incoming.modified_at);
    expect(incoming.paid_fen).not.toBe(f.incoming.paid_fen);
    expect(await capture(() => f.process(incoming))).toMatchObject({ ok: true });
    const after = (await f.read()).orders[0]!;
    expect(after.content_hash).not.toEqual(orderBefore.content_hash);
    if (guard === 'unattributed') expect(after.user_id).toBeNull();
    else expect(after.rebate_status).toBe('CLAWED_BACK');
    await f.scan();
    expect(f.port.create).not.toHaveBeenCalled();
    expect(f.events()).toEqual([]);
    expect(await f.pending()).toEqual(before);
    await positiveControl(db);
  },
);

it('[AC-B1-08u#12] 新原因插新行且 created_at=Clock，同键刷新不延后时间，耗尽仍定位最早原因', async () => {
  const f = await fixture(db, 'pipeline');
  const first = (await f.pending())[0]!;
  // 新原因要 N 未知才出现：库内与报文的 est 都为空，且报文缺服务费。
  await db
    .updateTable('orders')
    .set({ est_commission_fen: null })
    .where('app_id', '=', f.ctx.app_id)
    .execute();
  f.clock.advanceMs(HOUR);
  const missingFee = { ...f.next(), est_commission_fen: null, service_fee_fen: null };
  expect(await capture(() => f.process(missingFee))).toMatchObject({ ok: true });
  const rows = await f.pending();
  expect(rows).toHaveLength(2);
  expect(rows.find((p) => p.id === first.id)).toEqual(first);
  const changed = rows.find((p) => p.reason === 'SERVICE_FEE_RATE_MISSING')!;
  expect(changed).toMatchObject({
    status: 'open',
    created_at: f.clock.now(),
    detected_at: f.clock.now(),
    resolved_at: null,
  });
  expect(changed.id).not.toBe(first.id);
  f.clock.advanceMs(HOUR);
  await f.process({ ...f.next(), est_commission_fen: null, service_fee_fen: null });
  expect(await f.pending()).toEqual([
    first,
    expect.objectContaining({
      id: changed.id,
      status: 'open',
      created_at: changed.created_at,
      detected_at: f.clock.now(),
    }),
  ]);
  expect(f.events()).toEqual([]);
  f.clock.advanceMs(24 * HOUR);
  await f.process({ ...f.next(), est_commission_fen: null, service_fee_fen: null });
  assertAlert(f, first);
  expect((await f.pending()).map((p) => [p.id, p.status, p.created_at, p.resolution_note])).toEqual(
    [
      [first.id, 'open', first.created_at, HANDOFF],
      [changed.id, 'open', changed.created_at, HANDOFF],
    ],
  );
});

it('[AC-B1-08u#13] 未注入 events 的扫描沿用日志和转人工行为，重复扫描不再重试', async () => {
  const f = await fixture(db);
  f.clock.advanceMs(24 * HOUR);
  await f.legacyScan();
  expect(f.events()).toEqual([]);
  expect(f.alerts()).toHaveLength(1);
  expect((await f.pending())[0]).toMatchObject({
    status: 'open',
    resolved_at: null,
    resolution_note: HANDOFF,
  });
  f.clock.advanceMs(2 * HOUR);
  await f.legacyScan();
  expect(f.alerts()).toHaveLength(1);
  expect(f.port.create).toHaveBeenCalledTimes(1);
  await positiveControl(db);
});

it('[AC-B1-08u#14] 资料不可恢复的 skip 满24h也告警，载荷不加入 skip 细节', async () => {
  const f = await fixture(db);
  const pending = (await f.pending())[0]!;
  await db
    .withSchema('app')
    .updateTable('orders')
    .set({ paid_at_source: 'platform_modified' })
    .where('app_id', '=', f.ctx.app_id)
    .execute();
  f.clock.advanceMs(24 * HOUR);
  await f.scan();
  expect(f.port.create).not.toHaveBeenCalled();
  assertAlert(f, pending);
  expect((await f.pending())[0]?.resolution_note).toBe(HANDOFF);
});
