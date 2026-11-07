// B2-04zzd: only the R10 negative route publishes order.settle_adjusted (D10-817 ③). A positive
// difference, an equal record, an R8 through the settlement amount, a positive difference left
// waiting beside a WAIT_COMMISSION rights record and an R9 publish none; each case then ends with
// the negative route of the same kind publishing exactly one, so the case cannot pass on a path that
// never publishes. Assembled worker; amounts as in B2-04zi (reserve 0, own share 50 %).
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  CLAWED_BACK,
  MEMBER_ROLE,
  SETTLED_LATER,
  SETTLE_ADJUSTED,
  TIMEOUT,
  adjusted,
  credited,
  databaseFixture,
  published,
  settled,
  touched,
  withSync,
} from './kit.ts';

const p = databaseFixture(createTestDatabase);

it(
  '[AC-B2-04zzd#7] 正差 1200 只告警、不发 order.settle_adjusted；随后 800 按 booked 1000 负差：只发一条，settle_seq 3、本人 -100',
  async () => {
    await withSync(p.db, async (w, logs) => {
      const { app, o, read } = await credited(p.db, w);

      await o.sync(settled(1200n, touched(1)));
      expect(logs).toContainEqual(
        expect.objectContaining({ level: 40, alert: 'settle_adjust_positive_pending', seq: 2 }),
      );
      expect(await published(p.db, app, SETTLE_ADJUSTED)).toEqual([]);

      await o.sync(settled(800n, touched(2)));
      await read.adjustment(3, 100n, 100n);
      expect(await published(p.db, app, SETTLE_ADJUSTED)).toEqual([
        {
          order_id: (await o.row()).order_id,
          order_key: read.orderRef,
          settle_seq: 3,
          sub_type: 'SETTLE_DIFF',
          beneficiaries: [adjusted(app.userId, MEMBER_ROLE, '-100', 'user_available')],
        },
      ]);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zzd#8] 同额新记录（seq 2、金额 1000）无动作、不发 order.settle_adjusted；随后 800 负差只发一条 settle_seq 3',
  async () => {
    await withSync(p.db, async (w) => {
      const { app, o, read } = await credited(p.db, w);

      await o.sync(settled(1000n, { ...touched(1), settled_at: SETTLED_LATER }));
      expect((await o.records()).map((r) => r.seq)).toEqual([1, 2]);
      expect(await read.history()).toEqual([]);
      expect(await published(p.db, app, SETTLE_ADJUSTED)).toEqual([]);

      await o.sync(settled(800n, { ...touched(2), settled_at: SETTLED_LATER }));
      await read.adjustment(3, 100n, 100n);
      expect(await published(p.db, app, SETTLE_ADJUSTED)).toEqual([
        {
          order_id: (await o.row()).order_id,
          order_key: read.orderRef,
          settle_seq: 3,
          sub_type: 'SETTLE_DIFF',
          beneficiaries: [adjusted(app.userId, MEMBER_ROLE, '-100', 'user_available')],
        },
      ]);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zzd#9] 结算佣金降到 0 走 R8（CLAWED_BACK、COMMISSION_ZERO）：只发 order.clawed_back，不发 order.settle_adjusted；另一单 1000→800 负差发一条',
  async () => {
    await withSync(p.db, async (w) => {
      const zero = await credited(p.db, w);
      const negative = await credited(p.db, w);

      await zero.o.sync(settled(0n, touched(1)));
      expect(await zero.o.row()).toMatchObject({
        rebate_status: 'CLAWED_BACK',
        reason: 'COMMISSION_ZERO',
      });
      expect(await published(p.db, zero.app, CLAWED_BACK)).toMatchObject([
        { transition: 'R8', reason: 'COMMISSION_ZERO' },
      ]);
      expect(await published(p.db, zero.app, SETTLE_ADJUSTED)).toEqual([]);

      await negative.o.sync(settled(800n, touched(1)));
      await negative.read.adjustment(2, 100n, 100n);
      expect(await published(p.db, negative.app, SETTLE_ADJUSTED)).toEqual([
        {
          order_id: (await negative.o.row()).order_id,
          order_key: negative.read.orderRef,
          settle_seq: 2,
          sub_type: 'SETTLE_DIFF',
          beneficiaries: [adjusted(negative.app.userId, MEMBER_ROLE, '-100', 'user_available')],
        },
      ]);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zzd#10] 维权等待中（WAIT_COMMISSION）遇正差 1200：留待、不发 order.settle_adjusted；另一单等待中遇 800 负差：维权关闭，同事务发一条 settle_seq 2、本人 -100',
  async () => {
    await withSync(p.db, async (w) => {
      const positive = await credited(p.db, w);
      const negative = await credited(p.db, w);
      const posId = await positive.o.rights('WAIT_COMMISSION', null);
      const negId = await negative.o.rights('WAIT_COMMISSION', null);
      await positive.o.markRightsPending();
      await negative.o.markRightsPending();

      await positive.o.sync(settled(1200n, touched(1)));
      expect(await positive.o.rightsRow(posId)).toEqual({
        status: 'WAIT_COMMISSION',
        answered_at: null,
      });
      expect(await published(p.db, positive.app, SETTLE_ADJUSTED)).toEqual([]);

      await negative.o.sync(settled(800n, touched(1)));
      await negative.read.adjustment(2, 100n, 100n);
      expect(await negative.o.rightsRow(negId)).toMatchObject({ status: 'SUCCEEDED' });
      expect(await published(p.db, negative.app, SETTLE_ADJUSTED)).toEqual([
        {
          order_id: (await negative.o.row()).order_id,
          order_key: negative.read.orderRef,
          settle_seq: 2,
          sub_type: 'SETTLE_DIFF',
          beneficiaries: [adjusted(negative.app.userId, MEMBER_ROLE, '-100', 'user_available')],
        },
      ]);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zzd#11] 退款数量增加时同步新结算 600：走 R9 不走 R10，不发 order.settle_adjusted；order.clawed_back 载荷逐项为订单 id、订单键、C{版本}、R9、reason PART_REFUND 与本人扣回 200',
  async () => {
    await withSync(p.db, async (w) => {
      const { app, o, read } = await credited(p.db, w);
      // UnionOrder has no quantity fields: the orders-owned fact onUpdated reads is seeded, as in
      // AC-B2-04zi#5; the new settlement still enters through the production pipeline.
      await p.db
        .updateTable('orders')
        .set({ quantity: 4, refunded_quantity: 1, refunded_quantity_at_credit: 0 })
        .where('app_id', '=', app.appId)
        .where('order_id', '=', (await o.row()).order_id)
        .execute();

      await o.sync(settled(600n, touched(1)));

      const row = await o.row();
      expect(row).toMatchObject({
        rebate_status: 'CREDITED',
        booked_base_fen: 600n,
        booked_n_fen: 600n,
      });
      expect(await published(p.db, app, SETTLE_ADJUSTED)).toEqual([]);
      expect(await published(p.db, app, CLAWED_BACK)).toEqual([
        {
          order_id: row.order_id,
          order_key: read.orderRef,
          rights_event_id: `C${String(row.commission_version)}`,
          transition: 'R9',
          reason: 'PART_REFUND',
          beneficiaries: [{ user_id: app.userId, role: MEMBER_ROLE, clawback_fen: '200' }],
        },
      ]);
    });
  },
  TIMEOUT,
);
