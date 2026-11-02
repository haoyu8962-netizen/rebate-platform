// B1-09n · 未映射状态（BR-FUND-02、R11）：生产上 hold 与 system:risk 审计随订单事务提交或回滚。审计是 admin 的
// createSystemAuditWriter，配置是 content 的 order_sync.unmapped_status_hold.enabled，都不自注入。
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import {
  AUTO_HOLD,
  expectHoldSnapshot,
  stored,
  SYSTEM_RISK,
  UNMAPPED,
} from '../../admin/system-audit/kit.ts';
import { capture, JD_RECEIVED, JD_UNMAPPED, RECEIVED_AT, TIMEOUT, withFixture } from './kit.ts';

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

/** The hold's other half: one open pending row of this order with the reported code (BR-FUND-02). */
function expectOnePending(rows: readonly unknown[], orderId: string) {
  expect(rows).toEqual([
    expect.objectContaining({
      order_id: orderId,
      reason: UNMAPPED,
      raw_status: JD_UNMAPPED,
      status: 'open',
    }),
  ]);
}

it(
  '[AC-B1-09n#16] 未映射状态：hold=true、hold_reason=UNMAPPED_STATUS，写一行 system:risk 审计',
  async () => {
    await withFixture(db, async (f) => {
      await f.sync();
      expect(await f.row()).toMatchObject({ rebate_status: 'ESTIMATED', hold: false });
      await f.sync(f.touch(1, { raw_status: JD_UNMAPPED }));
      const row = await f.row();
      expect(row).toMatchObject({
        platform_status: 'PAID',
        rebate_status: 'ESTIMATED',
        hold: true,
        hold_reason: UNMAPPED,
      });
      const audits = await stored(db, f.appId);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        admin_id: null,
        system_actor: SYSTEM_RISK,
        action: AUTO_HOLD,
        target: `orders:${row.order_id}`,
        ip: null,
        at: f.clock.now(),
      });
      expectHoldSnapshot(audits[0]!.before, false, null);
      expectHoldSnapshot(audits[0]!.after, true, UNMAPPED);
      expectOnePending(await f.pending(), row.order_id);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B1-09n#17] 同一事务后面失败：hold 与审计行一起回滚，重投后恰好一行',
  async () => {
    await withFixture(db, async (f) => {
      await f.sync();
      expect(await f.row()).toMatchObject({ rebate_status: 'ESTIMATED', hold: false });
      const publish = f.events.publish.bind(f.events);
      const failure = new Error('synthetic bus failure');
      const bus = vi.spyOn(f.events, 'publish').mockImplementation(async (trx, event) => {
        if (event.name === 'order.updated') throw failure;
        return publish(trx, event);
      });
      const unmapped = f.touch(1, { raw_status: JD_UNMAPPED });
      expect(await capture(() => f.report(unmapped))).toEqual({ ok: false, error: failure });
      expect(await f.row()).toMatchObject({ hold: false, hold_reason: null });
      expect(await stored(db, f.appId)).toEqual([]);
      bus.mockRestore();
      await f.sync(unmapped);
      expect(await f.row()).toMatchObject({ hold: true, hold_reason: UNMAPPED });
      expect(await stored(db, f.appId)).toHaveLength(1);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B1-09n#18] 开关 order_sync.unmapped_status_hold.enabled 关：经 content 读到，不 hold、不写审计',
  async () => {
    await withFixture(db, async (f) => {
      await f.setConfig('order_sync.unmapped_status_hold.enabled', false);
      await f.sync();
      expect(await f.row()).toMatchObject({ rebate_status: 'ESTIMATED', hold: false });
      await f.sync(f.touch(1, { raw_status: JD_UNMAPPED }));
      expect(await f.row()).toMatchObject({ hold: false, hold_reason: null });
      expect(await stored(db, f.appId)).toEqual([]);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B1-09n#28] WAITING 订单遇未映射状态：同样 hold，写一行 system:risk 审计，留一条待处理',
  async () => {
    await withFixture(db, async (f) => {
      await f.sync();
      await f.sync(f.touch(1, { raw_status: JD_RECEIVED, received_at: RECEIVED_AT }));
      expect(await f.row()).toMatchObject({ rebate_status: 'WAITING', hold: false });
      await f.sync(f.touch(2, { raw_status: JD_UNMAPPED, received_at: RECEIVED_AT }));
      const row = await f.row();
      expect(row).toMatchObject({
        platform_status: 'RECEIVED',
        rebate_status: 'WAITING',
        hold: true,
        hold_reason: UNMAPPED,
      });
      const audits = await stored(db, f.appId);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        admin_id: null,
        system_actor: SYSTEM_RISK,
        action: AUTO_HOLD,
        target: `orders:${row.order_id}`,
      });
      expectHoldSnapshot(audits[0]!.before, false, null);
      expectHoldSnapshot(audits[0]!.after, true, UNMAPPED);
      expectOnePending(await f.pending(), row.order_id);
    });
  },
  TIMEOUT,
);
