import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { fresh, fakePort, runFresh, runUpdate, scenario, at } from './db-kit.ts';

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

it('[AC-B1-08k#27] 端口 pending 映射原因、同键 open 仅刷新 detected_at、订单仍提交', async () => {
  const f = await fresh(db);
  const oldAt = at('2026-10-01T03:04:05Z');
  await db
    .insertInto('order_sync_pending')
    .values({
      app_id: f.ctx.app_id,
      platform: 'pdd',
      sub_order_id: f.incoming.sub_order_id!,
      order_id: null,
      reason: 'RULE_VERSION_PLATFORM_MISSING',
      detail: 'preserved',
      raw_status: 'old',
      raw_payload_id: 55n,
      detected_at: oldAt,
      status: 'open',
    })
    .execute();
  const old = (await f.read()).pending[0]!;
  const port = fakePort();
  port.create.mockResolvedValue({ kind: 'pending', reason: 'no published rule version' });
  expect(await runFresh(f, port)).toMatchObject({ ok: true, value: { kind: 'inserted' } });
  expect(port.create).toHaveBeenCalledTimes(1);
  const saved = await f.read();
  expect(saved.orders).toHaveLength(1);
  expect(saved.pending).toEqual([{ ...old, detected_at: f.clock.now() }]);
  expect(saved.orders[0]?.paid_at_source).toBe('platform');
  expect(f.onImported.mock.calls[0]?.[1]).toMatchObject({ snapshot: 'pending' });
});

it.each(['no published rule version', 'missing platform rule', 'missing reserve'])(
  '[AC-B1-08k#28] 新 pending %s 的 detail 带 commission_snapshot 原因且告警字段平铺',
  async (reason) => {
    const f = await fresh(db);
    const port = fakePort();
    port.create.mockResolvedValue({ kind: 'pending', reason });
    expect(await runFresh(f, port)).toMatchObject({ ok: true });
    const saved = await f.read();
    expect(saved.pending).toHaveLength(1);
    expect(saved.pending[0]).toMatchObject({
      reason: 'RULE_VERSION_PLATFORM_MISSING',
      order_id: saved.orders[0]!.order_id,
      detail: `commission_snapshot ${reason}`,
      detected_at: f.clock.now(),
    });
    expect(f.logger.warn).toHaveBeenCalled();
    for (const [fields] of f.logger.warn.mock.calls) {
      expect(fields).toMatchObject({
        platform: 'pdd',
        app_id: f.ctx.app_id,
        outcome: expect.any(String),
        reason: expect.any(String),
      });
      expect(
        Object.values(fields as object).every((v) => v === null || typeof v !== 'object'),
      ).toBe(true);
      expect(JSON.stringify(fields)).not.toContain(f.incoming.sub_order_id);
      expect(JSON.stringify(fields)).not.toContain(f.userId);
    }
  },
);

it.each(['AMOUNT_PARSE_FAILED', 'SERVICE_FEE_RATE_MISSING'])(
  '[AC-B1-08k#29] 计划 pending %s 不调端口但写来源、待处理并通知 settlement',
  async (reason) => {
    // 对照：est 有值时本次报文缺服务费不进计划 pending，调端口，N 就是 est。
    const known = await fresh(db, { service_fee_fen: null });
    const knownPort = fakePort();
    expect(await runFresh(known, knownPort)).toMatchObject({ ok: true });
    expect(knownPort.create).toHaveBeenCalledTimes(1);
    expect(knownPort.create.mock.calls[0]?.[1]).toMatchObject({ nBaseFen: 789n });

    const f = await fresh(db, {
      est_commission_fen: null,
      service_fee_fen: reason === 'SERVICE_FEE_RATE_MISSING' ? null : 31n,
    });
    const port = fakePort();
    expect(await runFresh(f, port)).toMatchObject({ ok: true });
    expect(port.create).not.toHaveBeenCalled();
    const saved = await f.read();
    expect(saved.pending).toHaveLength(1);
    expect(saved.pending[0]).toMatchObject({ reason, order_id: saved.orders[0]!.order_id });
    expect(saved.orders[0]?.paid_at_source).toBe('platform');
    expect(f.onImported.mock.calls[0]?.[1]).toMatchObject({ snapshot: 'pending' });
    expect(f.logger.warn.mock.calls.map(([fields]) => fields)).toContainEqual(
      expect.objectContaining({ app_id: f.ctx.app_id, platform: 'pdd', reason }),
    );
    for (const args of f.logger.warn.mock.calls) {
      const fields = args[0] as Record<string, unknown>;
      expect(Object.values(fields).every((v) => v === null || typeof v !== 'object')).toBe(true);
      for (const key of [
        'pid',
        'relation_id',
        'sub_union_id',
        'custom_parameters',
        'sub_order_id',
      ]) {
        expect(fields).not.toHaveProperty(key);
      }
      for (const value of [f.incoming.sub_order_id, f.userId, 'abcd1234']) {
        expect(JSON.stringify(args)).not.toContain(value);
      }
    }
  },
);

it('[AC-B1-08k#39] 淘礼金面额未匹配仍调用快照，传 null 面额与 none 模式', async () => {
  const f = await fresh(db);
  f.findPid.mockResolvedValue([{ pid_scene: 'taolijin', status: 'active', site_id: null }]);
  const port = fakePort();
  expect(await runFresh(f, port)).toMatchObject({ ok: true, value: { kind: 'inserted' } });
  expect(port.create).toHaveBeenCalledTimes(1);
  expect(port.create.mock.calls[0]?.[1]).toMatchObject({
    tljRedpacketFen: null,
    rebateMode: 'none',
  });
  expect((await f.read()).orders).toHaveLength(1);
  expect(f.onImported.mock.calls[0]?.[1]).toMatchObject({ snapshot: 'created' });
});

it.each(['port', 'plan'])(
  '[AC-B1-08k#30] update 首次 %s pending 写待处理并通知 settlement',
  async (mode) => {
    // 对照：更新时 est 有值、本次报文缺服务费不进计划 pending，调端口，N 就是 est。
    const known = await scenario(db, { raw_status: 'deposit', service_fee_fen: null });
    const knownPort = fakePort();
    expect(await runUpdate(known, knownPort, known.next({ raw_status: 'paid' }))).toMatchObject({
      ok: true,
    });
    expect(knownPort.create).toHaveBeenCalledTimes(1);
    expect(knownPort.create.mock.calls[0]?.[1]).toMatchObject({ nBaseFen: 789n });

    const f = await scenario(db, {
      raw_status: 'deposit',
      est_commission_fen: mode === 'plan' ? null : 789n,
      service_fee_fen: mode === 'plan' ? null : 31n,
    });
    const port = fakePort();
    port.create.mockResolvedValue({ kind: 'pending', reason: 'missing reserve' });
    expect(await runUpdate(f, port, f.next({ raw_status: 'paid' }))).toMatchObject({ ok: true });
    expect(f.onUpdated.mock.calls[0]?.[1]).toMatchObject({ snapshot: 'pending' });
    const before = await f.read();
    expect(before.pending).toHaveLength(1);
    expect(before.pending[0]?.reason).toBe(
      mode === 'plan' ? 'SERVICE_FEE_RATE_MISSING' : 'RULE_VERSION_PLATFORM_MISSING',
    );
  },
);

it.each(['fresh', 'update'])(
  '[AC-B1-08k#31] %s 端口抛错整体回滚 orders/history/pending，错误传出供重试',
  async (mode) => {
    const port = fakePort();
    const error = new Error('synthetic snapshot failure');
    port.create.mockRejectedValue(error);
    if (mode === 'fresh') {
      const f = await fresh(db, { raw_status: 'received', received_at: null });
      const before = await f.read();
      expect(await runFresh(f, port)).toEqual({ ok: false, error });
      expect(port.create).toHaveBeenCalledTimes(1);
      expect(await f.read()).toEqual(before);
      expect(f.onImported).not.toHaveBeenCalled();
    } else {
      const f = await scenario(db, { raw_status: 'deposit', service_fee_fen: 31n });
      const before = await f.read();
      expect(
        await runUpdate(f, port, f.next({ raw_status: 'received', received_at: null })),
      ).toEqual({ ok: false, error });
      expect(port.create).toHaveBeenCalledTimes(1);
      expect(await f.read()).toEqual(before);
      expect(f.onUpdated).not.toHaveBeenCalled();
      expect(f.publish).not.toHaveBeenCalled();
    }
  },
);
