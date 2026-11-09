// B1-04zgc · 拼多多 4 / 10 在未入账一侧（D10-1069）：真实 worker 入口的流水线读真实 pdd.csv
// （../rebate-wiring/kit.ts，只读复用；拼多多单佣金 1000、服务费 100，带佣金也照样按失效）。
// 今天这两个码是表外码：首次入库只进待处理不建单，已有单写 UNMAPPED_STATUS 并 hold。改进表后照京东先例
// B1-04zga 的失效口径：首见即失效走 P13 同事务 VOID，已有 ESTIMATED / WAITING 走 R6 VOID，都不进待处理、
// 不 hold；不写子原因（reason_sub 为 null）。
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { AUTO_HOLD, stored } from '../../admin/system-audit/kit.ts';
import { RECEIVED_AT, TIMEOUT, withFixture } from '../rebate-wiring/kit.ts';
import { INVALID_CODES, PDD_RECEIVED } from './kit.ts';

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

/** The app's system:risk auto-hold audit rows (BR-FUND-02): a hold leaves one. */
async function autoHolds(appId: string) {
  return (await stored(db, appId)).filter((audit) => audit.action === AUTO_HOLD);
}

it.each(INVALID_CODES)(
  '[AC-B1-04zgc#1] 首次入库即拼多多 %s（带佣金）：建订单行并同事务作废（VOID，reason=REFUND，reason_sub 为空），不进待处理、不 hold、不生成快照（P13）',
  async (code) => {
    await withFixture(
      db,
      async (f) => {
        await f.sync();
        expect(await f.pending()).toEqual([]);
        expect(await f.row()).toMatchObject({
          user_id: f.userId,
          platform: 'pdd',
          sub_order_id: f.incoming.sub_order_id,
          platform_status: 'INVALID',
          rebate_status: 'VOID',
          reason: 'REFUND',
          reason_sub: null,
          commission_version: 0,
          hold: false,
          hold_reason: null,
        });
        expect(await f.splits()).toEqual([]);
        expect(await f.amounts()).toEqual([]);
        expect(await f.eventNames()).toContain('order.invalidated');
        expect(await autoHolds(f.appId)).toEqual([]);
      },
      { platform: 'pdd', patch: { raw_status: code } },
    );
  },
  TIMEOUT,
);

it.each(INVALID_CODES)(
  '[AC-B1-04zgc#2] ESTIMATED 订单收到拼多多 %s：作废（R6 VOID，reason=REFUND，reason_sub 为空），不写 UNMAPPED_STATUS、不 hold、不写审计',
  async (code) => {
    await withFixture(
      db,
      async (f) => {
        await f.sync();
        expect(await f.row()).toMatchObject({ rebate_status: 'ESTIMATED', hold: false });
        await f.sync(f.touch(1, { raw_status: code }));
        expect(await f.pending()).toEqual([]);
        expect(await f.row()).toMatchObject({
          platform_status: 'INVALID',
          rebate_status: 'VOID',
          reason: 'REFUND',
          reason_sub: null,
          hold: false,
          hold_reason: null,
        });
        expect(await f.eventNames()).toContain('order.invalidated');
        expect(await autoHolds(f.appId)).toEqual([]);
      },
      { platform: 'pdd' },
    );
  },
  TIMEOUT,
);

it.each(INVALID_CODES)(
  '[AC-B1-04zgc#3] WAITING 订单收到拼多多 %s：作废（R6 VOID，reason=REFUND，reason_sub 为空），不写 UNMAPPED_STATUS、不 hold、不写审计',
  async (code) => {
    await withFixture(
      db,
      async (f) => {
        await f.sync();
        await f.sync(f.touch(1, { raw_status: PDD_RECEIVED, received_at: RECEIVED_AT }));
        expect(await f.row()).toMatchObject({ rebate_status: 'WAITING', hold: false });
        await f.sync(f.touch(2, { raw_status: code, received_at: RECEIVED_AT }));
        expect(await f.pending()).toEqual([]);
        expect(await f.row()).toMatchObject({
          platform_status: 'INVALID',
          rebate_status: 'VOID',
          reason: 'REFUND',
          reason_sub: null,
          hold: false,
          hold_reason: null,
        });
        expect(await f.eventNames()).toContain('order.invalidated');
        expect(await autoHolds(f.appId)).toEqual([]);
      },
      { platform: 'pdd' },
    );
  },
  TIMEOUT,
);
