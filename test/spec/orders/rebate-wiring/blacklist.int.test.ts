// B1-09n · 黑名单第 ③ 步生产接线（BR-ATTR-26，BR-ID-36）：名单、命中、规则状态都走 risk 的真实端口，作废走
// settlement 的 BLACKLIST_HIT。尾号维度只有淘宝，淘宝还没有状态映射文件，这里用渠道维度（任何平台都查）。
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import * as pipeline from '../../../../apps/api/src/modules/orders/application/pipeline-port.ts';
import { setRule } from '../blacklist-rule-toggle/kit.ts';
import { at } from '../wiring/db-kit.ts';
import {
  AFTER_CREDIT,
  JD_RECEIVED,
  RECEIVED_AT,
  RELATION,
  TIMEOUT,
  UNKNOWN_CODE,
  withFixture,
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

/** The one hit a voided order ends with: BLACKLIST_HIT on the channel, void_commission. */
function voidHit(orderId: string, userId: string | null) {
  return expect.objectContaining({
    user_id: userId,
    rule_id: 'BLACKLIST_HIT',
    risk_action: 'void_commission',
    dimension: 'channel',
    ref_type: 'order',
    ref_id: orderId,
  });
}

it(
  '[AC-B1-09n#12] 规则启用，新订单命中：同事务作废，reason=BLACKLIST，记 void_commission，不生成快照',
  async () => {
    await withFixture(db, async (f) => {
      await setRule(db, f.appId, 'BLACKLIST_HIT', 'enabled', f.clock.now());
      await f.blockChannel();
      await f.sync();
      const row = await f.row();
      expect(row).toMatchObject({
        user_id: f.userId,
        rebate_status: 'VOID',
        reason: 'BLACKLIST',
        commission_version: 0,
      });
      expect(await f.splits()).toEqual([]);
      expect(await f.hits()).toEqual([
        expect.objectContaining({
          user_id: f.userId,
          rule_id: 'BLACKLIST_HIT',
          risk_action: 'void_commission',
          dimension: 'channel',
          ref_type: 'order',
          ref_id: row.order_id,
        }),
      ]);
      expect(await f.eventNames()).toContain('order.invalidated');
    });
  },
  TIMEOUT,
);

it(
  '[AC-B1-09n#13] 未入账的已有订单命中（ESTIMATED）：更新时作废，快照与 v1 金额行留存',
  async () => {
    await withFixture(db, async (f) => {
      await f.sync();
      expect(await f.row()).toMatchObject({ rebate_status: 'ESTIMATED' });
      await f.blockChannel();
      await f.sync(f.touch(1));
      expect(await f.row()).toMatchObject({ rebate_status: 'VOID', reason: 'BLACKLIST' });
      expect((await f.hits()).map((hit) => hit.risk_action)).toEqual(['void_commission']);
      expect((await f.amounts()).map((row) => row.amount_fen)).toEqual([500n]);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B1-09n#14] 已入账订单命中：只发 order.blacklist_hit_after_credit，记 manual_review，已入账金额不变',
  async () => {
    await withFixture(db, async (f) => {
      await f.sync();
      expect(await f.row()).toMatchObject({ rebate_status: 'ESTIMATED' });
      const creditedAt = at('2026-10-21T00:00:00.000Z');
      // 列直接写，代表此前的 R5 入账：本单只看命中之后这些列有没有被动过。
      await db
        .updateTable('orders')
        .set({
          rebate_status: 'CREDITED',
          credited_at: creditedAt,
          booked_base_fen: 1000n,
          booked_n_fen: 1000n,
        })
        .where('app_id', '=', f.appId)
        .execute();
      const money = (row: Awaited<ReturnType<typeof f.row>>) => ({
        rebate_status: row.rebate_status,
        reason: row.reason,
        est_commission_fen: row.est_commission_fen,
        commission_version: row.commission_version,
        booked_base_fen: row.booked_base_fen,
        booked_n_fen: row.booked_n_fen,
        credited_at: row.credited_at,
      });
      const before = money(await f.row());
      await f.blockChannel();
      await f.sync(f.touch(1));
      expect((await f.eventNames()).filter((name) => name === AFTER_CREDIT)).toHaveLength(1);
      expect(money(await f.row())).toEqual(before);
      expect((await f.hits()).map((hit) => hit.risk_action)).toEqual(['manual_review']);
      expect((await f.amounts()).map((row) => row.commission_version)).toEqual([1]);
      expect(await f.eventNames()).not.toContain('order.invalidated');
      const entries = await db
        .selectFrom('ledger_entries')
        .selectAll()
        .where('app_id', '=', f.appId)
        .execute();
      expect(entries).toEqual([]);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B1-09n#15] 规则停用不判定：名单在，订单照常 ESTIMATED，不写命中、不作废',
  async () => {
    await withFixture(db, async (f) => {
      await setRule(db, f.appId, 'BLACKLIST_HIT', 'disabled', f.clock.now());
      await f.blockChannel();
      await f.sync();
      expect(await f.row()).toMatchObject({
        rebate_status: 'ESTIMATED',
        reason: null,
        commission_version: 1,
      });
      expect(await f.hits()).toEqual([]);
      expect(await f.eventNames()).not.toContain('order.invalidated');
    });
  },
  TIMEOUT,
);

// BR-ATTR-26 作废的三种来源里 ESTIMATED 由 #12 #13 覆盖，下面两条是 WAITING 与 UNATTRIBUTED。
it(
  '[AC-B1-09n#25] WAITING 订单更新时命中：作废，reason=BLACKLIST，记 void_commission，发 order.invalidated',
  async () => {
    await withFixture(db, async (f) => {
      await f.sync();
      // 第二次报文同样是已收货：回到付款码会被当成 P10 倒退，整条拒收，走不到命中。
      const received = { raw_status: JD_RECEIVED, received_at: RECEIVED_AT };
      await f.sync(f.touch(1, received));
      const row = await f.row();
      expect(row).toMatchObject({ rebate_status: 'WAITING' });
      await f.blockChannel();
      await f.sync(f.touch(2, received));
      expect(await f.row()).toMatchObject({ rebate_status: 'VOID', reason: 'BLACKLIST' });
      expect(await f.hits()).toEqual([voidHit(row.order_id, f.userId)]);
      expect(await f.eventNames()).toContain('order.invalidated');
    });
  },
  TIMEOUT,
);

it(
  '[AC-B1-09n#26] 未归因订单入库时命中：同事务作废，reason=BLACKLIST，记 void_commission，发 order.invalidated',
  async () => {
    await withFixture(
      db,
      async (f) => {
        await f.blockChannel();
        await f.sync();
        const row = await f.row();
        expect(row).toMatchObject({
          user_id: null,
          rebate_status: 'VOID',
          reason: 'BLACKLIST',
          commission_version: 0,
        });
        expect(await f.splits()).toEqual([]);
        expect(await f.hits()).toEqual([voidHit(row.order_id, null)]);
        expect(await f.eventNames()).toContain('order.invalidated');
      },
      {
        patch: {
          attr_params: {
            relation_id: RELATION,
            sub_union_id: `n_${UNKNOWN_CODE}`,
            custom_parameters: null,
          },
        },
      },
    );
  },
  TIMEOUT,
);

// 尾号维度只有淘宝，淘宝没有状态映射文件，走不通流水线，所以直接问生产装配给流水线的端口。
it(
  '[AC-B1-09n#27] 尾号开关：有 config_items 行开启为 true，没有行为 false（BR-ATTR-26 ①）',
  async () => {
    const makePipeline = vi.spyOn(pipeline, 'createOrderPipeline');
    await withFixture(db, async (f) => {
      expect(makePipeline).toHaveBeenCalledTimes(1);
      const { blacklist } = makePipeline.mock.calls[0]![0];
      expect(blacklist, 'orderSyncPorts gives the blocklist').toBeDefined();
      await f.setConfig('attr.blacklist.order_suffix_void_enabled', true);
      expect(await blacklist!.suffixVoidEnabled(f.appId)).toBe(true);
      expect(await blacklist!.suffixVoidEnabled(`${f.appId}-no-row`)).toBe(false);
    });
  },
  TIMEOUT,
);
