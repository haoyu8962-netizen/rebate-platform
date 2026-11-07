// B2-04zzd: an R10 negative settlement difference (BR-FUND-09 ①「入账后负差即时补差」) publishes
// order.settle_adjusted on the transaction of its SETTLE_ADJUST vouchers (D10-773 B, D10-817 ①),
// through the assembled worker. Amounts are the B2-04zi ones, written by hand: reserve 0, own share
// 50 %, so N 1000 credits 500 to the member (role share) and 500 to the platform.
import { createTestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import type { DB } from '@couli/db';
import { expect, it, vi } from 'vitest';
import { level, relation, user } from '../../commission/resolver/kit.ts';
import {
  CLAWED_BACK,
  MEMBER_ROLE,
  SETTLE_ADJUSTED,
  TIMEOUT,
  adjusted,
  capture,
  credited,
  databaseFixture,
  published,
  settled,
  touched,
  withSync,
} from './kit.ts';

const p = databaseFixture(createTestDatabase);

it(
  '[AC-B2-04zzd#1] 1000→601 三位受益人负差：同步事务发一条 order.settle_adjusted，载荷逐项为订单 id、订单键、settle_seq 2、sub_type SETTLE_DIFF 与本人 -200 / 直推 -40 / 间推 -20（整数分字符串，bucket user_available），平台差不列入，不发 order.clawed_back',
  async () => {
    await withSync(p.db, async (w) => {
      const app = await w.app();
      const direct = await user(p.db, app.appId);
      const indirect = await user(p.db, app.appId);
      await level(p.db, app.appId, direct, 'L2');
      await level(p.db, app.appId, indirect, 'L3');
      await relation(p.db, app.appId, app.userId, direct);
      await relation(p.db, app.appId, direct, indirect);
      const { o, read } = await credited(p.db, w, { app });
      expect(await published(p.db, app, SETTLE_ADJUSTED)).toEqual([]);

      await o.sync(settled(601n, touched(1)));

      const row = await o.row();
      expect(row).toMatchObject({
        rebate_status: 'CREDITED',
        booked_base_fen: 601n,
        booked_n_fen: 601n,
      });
      const events = await published(p.db, app, SETTLE_ADJUSTED);
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        order_id: row.order_id,
        order_key: read.orderRef,
        settle_seq: 2,
        sub_type: 'SETTLE_DIFF',
        beneficiaries: expect.arrayContaining([
          adjusted(app.userId, MEMBER_ROLE, '-200', 'user_available'),
          adjusted(direct, 'direct', '-40', 'user_available'),
          adjusted(indirect, 'indirect', '-20', 'user_available'),
        ]),
      });
      expect(events[0]!['beneficiaries']).toHaveLength(3);
      expect(await published(p.db, app, CLAWED_BACK)).toEqual([]);
    });
  },
  TIMEOUT,
);

/** A beneficiary in deletion processing / done: the decrease goes to BAD_DEBT, listed as bad_debt. */
async function badDebt(db: Kysely<DB>, status: 'deleting' | 'deleted'): Promise<void> {
  await withSync(db, async (w) => {
    const { app, o, read } = await credited(db, w);
    await db
      .updateTable('users')
      .set({ status })
      .where('app_id', '=', app.appId)
      .where('id', '=', app.userId)
      .execute();

    await o.sync(settled(800n, touched(1)));
    await read.adjustment(2, 100n, 100n, 'BAD_DEBT');
    const orderId = (await o.row()).order_id;
    const first = {
      order_id: orderId,
      order_key: read.orderRef,
      settle_seq: 2,
      sub_type: 'SETTLE_DIFF',
      beneficiaries: [adjusted(app.userId, MEMBER_ROLE, '-100', 'bad_debt')],
    };
    expect(await published(db, app, SETTLE_ADJUSTED)).toEqual([first]);

    await o.sync(settled(600n, touched(2)));
    await read.adjustment(3, 100n, 100n, 'BAD_DEBT');
    expect(await published(db, app, SETTLE_ADJUSTED)).toEqual([first, { ...first, settle_seq: 3 }]);
    expect(await published(db, app, CLAWED_BACK)).toEqual([]);
  });
}

it(
  '[AC-B2-04zzd#2] 受益人注销处理中（deleting）遇 1000→800：本人 100 记 BAD_DEBT，order.settle_adjusted 仍列入该行，adjust_fen -100、bucket bad_debt；再降到 600 的第二条 settle_seq 3',
  async () => {
    await badDebt(p.db, 'deleting');
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zzd#3] 受益人已注销（deleted）遇 1000→800：本人 100 记 BAD_DEBT，order.settle_adjusted 列入 adjust_fen -100、bucket bad_debt；再降到 600 的第二条 settle_seq 3',
  async () => {
    await badDebt(p.db, 'deleted');
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zzd#4] 基数相等只平台冲回（N 2→1、预留 7500：base 0 不变，受益人差额 0、只记平台 1 分）：R10 仍发一条 order.settle_adjusted，beneficiaries 为空数组（作者裁定：照发，消费端无信可发）',
  async () => {
    await withSync(p.db, async (w) => {
      const { app, o, read } = await credited(p.db, w, { n: 2n, reserveBp: 7500 });
      expect(await o.row()).toMatchObject({ booked_base_fen: 0n, booked_n_fen: 2n });

      await o.sync(settled(1n, touched(1)));

      await read.adjustment(2, 0n, 1n);
      expect(await read.history()).toMatchObject([{ event: 'SETTLE_NEGATIVE_DIFF' }]);
      expect(await published(p.db, app, SETTLE_ADJUSTED)).toEqual([
        {
          order_id: (await o.row()).order_id,
          order_key: read.orderRef,
          settle_seq: 2,
          sub_type: 'SETTLE_DIFF',
          beneficiaries: [],
        },
      ]);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zzd#5] 同事务：order.settle_adjusted 入队时同一事务里已有本次两张 SETTLE_ADJUST 凭证；入队失败 → 整个同步回滚，凭证、余额、订单列、历史、结算记录与事件都不留下；重投后恰好一套凭证、一条事件',
  async () => {
    await withSync(p.db, async (w) => {
      const { app, o, read } = await credited(p.db, w);
      const before = await read.money();
      const recordsBefore = await o.records();
      const publish = w.events.publish.bind(w.events);
      const failure = new Error('synthetic settle_adjusted failure');
      let inside: string[] = [];
      const bus = vi.spyOn(w.events, 'publish').mockImplementation(async (trx, event) => {
        if (event.name === SETTLE_ADJUSTED) {
          const rows = await trx
            .selectFrom('ledger_vouchers')
            .select('uniq_key')
            .where('app_id', '=', app.appId)
            .where('order_key', '=', read.orderRef)
            .where('voucher_kind', '=', 'SETTLE_ADJUST')
            .execute();
          inside = rows.map((r) => r.uniq_key).sort();
          throw failure;
        }
        return publish(trx, event);
      });
      try {
        expect(await capture(() => o.report(settled(800n, touched(1))))).toEqual({
          ok: false,
          error: failure,
        });
        expect(inside).toEqual(
          [
            `${read.orderRef}:${app.userId}:${MEMBER_ROLE}:ADJ:2`,
            `${read.orderRef}:PLATFORM:ADJ:2`,
          ].sort(),
        );
        expect(await read.money()).toEqual(before);
        expect(await o.records()).toEqual(recordsBefore);
        expect(await published(p.db, app, SETTLE_ADJUSTED)).toEqual([]);
      } finally {
        bus.mockRestore();
      }

      await o.sync(settled(800n, touched(1)));
      await read.adjustment(2, 100n, 100n);
      expect(await published(p.db, app, SETTLE_ADJUSTED)).toEqual([
        {
          order_id: (await o.row()).order_id,
          order_key: read.orderRef,
          settle_seq: 2,
          sub_type: 'SETTLE_DIFF',
          beneficiaries: [adjusted(app.userId, MEMBER_ROLE, '-100', 'user_available')],
        },
      ]);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zzd#6] 同一结算记录重放（同报文、仅 mtime 变）：不追加凭证，也不再发 order.settle_adjusted，始终只有 settle_seq 2 那一条',
  async () => {
    await withSync(p.db, async (w) => {
      const { app, o, read } = await credited(p.db, w);
      const report = settled(800n, touched(1));

      await o.sync(report);
      await read.adjustment(2, 100n, 100n);
      const once = await published(p.db, app, SETTLE_ADJUSTED);
      expect(once).toEqual([
        {
          order_id: (await o.row()).order_id,
          order_key: read.orderRef,
          settle_seq: 2,
          sub_type: 'SETTLE_DIFF',
          beneficiaries: [adjusted(app.userId, MEMBER_ROLE, '-100', 'user_available')],
        },
      ]);
      const money = await read.money();

      await o.sync(report);
      await o.sync({ ...report, ...touched(2) });

      expect(await read.money()).toEqual(money);
      expect((await o.records()).map((r) => r.seq)).toEqual([1, 2]);
      expect(await published(p.db, app, SETTLE_ADJUSTED)).toEqual(once);
    });
  },
  TIMEOUT,
);
