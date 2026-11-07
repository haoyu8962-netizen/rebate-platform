// BR-FUND-01/08/09, BR-CALC-02/23. Each case includes a positive assertion of the missing R10.
import { createTestDatabase } from '@couli/db/testing';
import { addFen } from '@couli/money';
import { expect, it } from 'vitest';
import { level, relation, user } from '../../commission/resolver/kit.ts';
import {
  MEMBER_ROLE,
  TIMEOUT,
  SETTLED_LATER,
  credited,
  databaseFixture,
  moveUserFunds,
  settled,
  touched,
  withSync,
} from './kit.ts';

const p = databaseFixture(createTestDatabase);

it(
  '[AC-B2-04zi#34] 本人、直推、间推分别扣200/40/20，平台扣139：四张凭证按各自user与role生成，金额版本同为601',
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
      await o.sync(settled(601n, touched(1)));
      const lines = (await read.lines()).filter((l) => l.uniq_key.endsWith(':ADJ:2'));
      const expected: string[] = [];
      for (const [id, role, debit] of [
        [app.userId, MEMBER_ROLE, 200n],
        [direct, 'direct', 40n],
        [indirect, 'indirect', 20n],
      ] as const) {
        const ref = `${read.orderRef}:${id}:${role}:ADJ:2`;
        expected.push(
          `${ref}|USER_BALANCE|${id}|${debit}`,
          `${ref}|UNION_RECEIVABLE:pdd|platform|${-debit}`,
        );
      }
      const platform = `${read.orderRef}:PLATFORM:ADJ:2`;
      expected.push(
        `${platform}|COMMISSION_REVENUE|platform|139`,
        `${platform}|UNION_RECEIVABLE:pdd|platform|-139`,
      );
      expect(
        lines.map((l) => `${l.uniq_key}|${l.subject}|${l.owner_id}|${l.amount_fen}`).sort(),
      ).toEqual(expected.sort());
      expect(lines.map((l) => [l.ledger_type, l.sub_type])).toEqual(
        Array.from({ length: 8 }, () => ['SETTLE_ADJUST', 'SETTLE_DIFF']),
      );
      const row = await o.row();
      expect(row).toMatchObject({
        rebate_status: 'CREDITED',
        booked_base_fen: 601n,
        booked_n_fen: 601n,
      });
      const amounts = await p.db
        .selectFrom('commission_split_amounts')
        .select(['user_id', 'role', 'base_fen', 'amount_fen'])
        .where('app_id', '=', app.appId)
        .where('order_id', '=', row.order_id)
        .where('commission_version', '=', row.commission_version)
        .orderBy('role')
        .execute();
      expect(amounts).toEqual([
        { user_id: direct, role: 'direct', base_fen: 601n, amount_fen: 60n },
        { user_id: indirect, role: 'indirect', base_fen: 601n, amount_fen: 30n },
        { user_id: app.userId, role: MEMBER_ROLE, base_fen: 601n, amount_fen: 300n },
      ]);
      await read.balanced();
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zi#1] 1000→601：逐分重拆 500→300，平台500→301；available可负、frozen不动，版本金额与booked同步',
  async () => {
    await withSync(p.db, async (w) => {
      const { app, o, read } = await credited(p.db, w);
      const before = await o.row();
      await moveUserFunds(p.db, w, app, o, 'freeze');
      await o.sync(settled(601n, touched(1)));
      await read.adjustment(2, 200n, 199n);
      expect(await read.balance()).toEqual({ available_fen: -200n, frozen_fen: 500n });
      expect(await o.row()).toMatchObject({
        rebate_status: 'CREDITED',
        booked_base_fen: 601n,
        booked_n_fen: 601n,
        commission_version: before.commission_version + 1,
      });
      expect(await read.history()).toMatchObject([
        {
          event: 'SETTLE_NEGATIVE_DIFF',
          from_status: 'CREDITED',
          to_status: 'CREDITED',
          at: w.clock.now(),
        },
      ]);
      const adjusted = (await read.lines()).filter((l) => l.uniq_key.endsWith(':ADJ:2'));
      expect(
        adjusted
          .filter((l) => l.subject === 'UNION_RECEIVABLE:pdd')
          .reduce((sum, l) => addFen(sum, l.amount_fen), 0n),
      ).toBe(-399n);
      expect(adjusted.every((l) => l.booked_at.getTime() === w.clock.now().getTime())).toBe(true);
      const amounts = await p.db
        .selectFrom('commission_split_amounts')
        .select(['commission_version', 'base_fen', 'amount_fen'])
        .where('app_id', '=', app.appId)
        .where('order_id', '=', before.order_id)
        .where('commission_version', '=', before.commission_version + 1)
        .execute();
      expect(amounts).toEqual([
        { commission_version: before.commission_version + 1, base_fen: 601n, amount_fen: 300n },
      ]);
      expect(
        await p.db
          .selectFrom('event_log')
          .select('name')
          .where('app_id', '=', app.appId)
          .where('name', '=', 'order.clawed_back')
          .execute(),
      ).toEqual([]);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zi#2] 正差1200只告警、不动账或候选；随后800按booked1000扣200，不能按1200扣',
  async () => {
    await withSync(p.db, async (w, logs) => {
      const { app, o, read } = await credited(p.db, w);
      const before = await read.money();
      const row = await o.row();
      await o.sync(settled(1200n, touched(1)));
      expect(logs).toContainEqual(
        expect.objectContaining({
          level: 40,
          alert: 'settle_adjust_positive_pending',
          app_id: app.appId,
          order_id: row.order_id,
          seq: 2,
        }),
      );
      expect(await read.money()).toEqual(before);
      await o.sync(settled(800n, touched(2)));
      await read.adjustment(3, 100n, 100n);
      expect(await o.row()).toMatchObject({ booked_base_fen: 800n, booked_n_fen: 800n });
      expect(await w.available(app)).toBe(400n);
      expect(await read.candidates()).toEqual([]);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zi#3] 同额新时间seq无动作；实际降额后同报文与仅mtime重放均不重记、不追加history',
  async () => {
    await withSync(p.db, async (w) => {
      const { o, read } = await credited(p.db, w);
      const before = await read.money();
      await o.sync(settled(1000n, { ...touched(1), settled_at: SETTLED_LATER }));
      expect((await o.records()).map((r) => r.seq)).toEqual([1, 2]);
      expect(await read.money()).toEqual(before);
      const report = settled(800n, { ...touched(2), settled_at: SETTLED_LATER });
      await o.sync(report);
      await read.adjustment(3, 100n, 100n);
      const adjusted = await read.money();
      await o.sync(report);
      await o.sync({ ...report, ...touched(3) });
      expect(await read.money()).toEqual(adjusted);
      expect((await o.records()).map((r) => r.seq)).toEqual([1, 2, 3]);
      expect(await read.history()).toHaveLength(1);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zi#4] 新结算+预估同时变化走R10不出R9b差错；仅预估变仍只存档并出差错',
  async () => {
    await withSync(p.db, async (w) => {
      const { app, o, read } = await credited(p.db, w);
      await w.setConfig(app, 'settle.estimate_change_diff.enabled', true);
      const diffs = () =>
        p.db
          .selectFrom('recon_diffs')
          .selectAll()
          .where('app_id', '=', app.appId)
          .where('type', '=', 'estimate_changed_after_credit')
          .execute();
      await o.sync(settled(800n, { ...touched(1), est_commission_fen: 600n }));
      await read.adjustment(2, 100n, 100n);
      expect(await diffs()).toEqual([]);
      const before = await read.money();
      await o.sync(settled(800n, { ...touched(2), est_commission_fen: 500n }));
      expect(await read.money()).toEqual(before);
      expect(await diffs()).toHaveLength(1);
      expect(await o.row()).toMatchObject({ est_commission_fen: 500n, booked_n_fen: 800n });
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zi#5] 退款数量已增加时同步新结算：R9按新结算600扣回400，不能忽略新佣金等维权',
  async () => {
    await withSync(p.db, async (w) => {
      const { app, o, read } = await credited(p.db, w);
      // UnionOrder has no quantity fields. Seed the orders-owned fact that onUpdated reads;
      // the new settlement itself still enters through the production pipeline and recordApi.
      await p.db
        .updateTable('orders')
        .set({ quantity: 4, refunded_quantity: 1, refunded_quantity_at_credit: 0 })
        .where('app_id', '=', app.appId)
        .where('order_id', '=', (await o.row()).order_id)
        .execute();
      await o.sync(settled(600n, touched(1)));
      expect(await o.row()).toMatchObject({
        rebate_status: 'CREDITED',
        booked_base_fen: 600n,
        booked_n_fen: 600n,
      });
      const lines = (await read.lines()).filter((l) => l.ledger_type === 'CLAWBACK');
      expect(lines.map((l) => `${l.subject}|${l.amount_fen}`).sort()).toEqual(
        [
          'USER_BALANCE|200',
          'COMMISSION_REVENUE|200',
          'UNION_RECEIVABLE:pdd|-200',
          'UNION_RECEIVABLE:pdd|-200',
        ].sort(),
      );
      const version = (await o.row()).commission_version;
      expect([...new Set(lines.map((l) => l.uniq_key))].sort()).toEqual(
        [
          `${read.orderRef}:${(await o.row()).user_id}:${MEMBER_ROLE}:CLAWBACK:C${version}`,
          `${read.orderRef}:PLATFORM:CLAWBACK:C${version}`,
        ].sort(),
      );
      expect((await read.lines()).filter((l) => l.ledger_type === 'SETTLE_ADJUST')).toEqual([]);
      await read.balanced();
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zi#6] 有维权记录+新结算但预估没变：优先R9，600新佣金优先于维权应扣100',
  async () => {
    await withSync(p.db, async (w) => {
      const { o, read } = await credited(p.db, w);
      await o.rights('SUCCEEDED', 100n);
      await o.sync(settled(600n, touched(1)));
      expect(await o.row()).toMatchObject({
        rebate_status: 'CREDITED',
        booked_base_fen: 600n,
        booked_n_fen: 600n,
      });
      const lines = (await read.lines()).filter((l) => l.ledger_type === 'CLAWBACK');
      expect(
        lines.filter((l) => l.subject === 'UNION_RECEIVABLE:pdd').map((l) => l.amount_fen),
      ).toEqual([-200n, -200n]);
      expect((await read.lines()).filter((l) => l.ledger_type === 'SETTLE_ADJUST')).toEqual([]);
      await read.balanced();
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zi#7] 已调整到800再有STATEMENT800：后到API0不决定金额、不误走R8',
  async () => {
    await withSync(p.db, async (w) => {
      const { o, read } = await credited(p.db, w);
      await o.sync(settled(800n, touched(1)));
      await read.adjustment(2, 100n, 100n);
      await o.statement(3, 800n);
      const before = await read.money();
      await o.sync(settled(0n, touched(2)));
      expect(await o.row()).toMatchObject({
        settle_commission_fen: 800n,
        booked_n_fen: 800n,
        rebate_status: 'CREDITED',
      });
      expect(await read.money()).toEqual(before);
      expect((await o.records()).map((r) => [r.seq, r.source, r.settle_commission_fen])).toEqual([
        [1, 'API', 1000n],
        [2, 'API', 800n],
        [3, 'STATEMENT', 800n],
        [4, 'API', 0n],
      ]);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zi#8] 等待维权负差关闭、正差继续等待；无维权单同样即时R10',
  async () => {
    await withSync(p.db, async (w) => {
      const negative = await credited(p.db, w);
      const positive = await credited(p.db, w);
      const ordinary = await credited(p.db, w);
      const negId = await negative.o.rights('WAIT_COMMISSION', null);
      const posId = await positive.o.rights('WAIT_COMMISSION', null);
      await negative.o.markRightsPending();
      await positive.o.markRightsPending();
      await negative.o.sync(settled(800n, touched(1)));
      await negative.read.adjustment(2, 100n, 100n);
      expect(await negative.o.rightsRow(negId)).toMatchObject({
        status: 'SUCCEEDED',
      });
      expect(await negative.o.row()).toMatchObject({ rights_pending: false });
      const before = await positive.read.money();
      await positive.o.sync(settled(1200n, touched(1)));
      expect(await positive.o.rightsRow(posId)).toEqual({
        status: 'WAIT_COMMISSION',
        answered_at: null,
      });
      expect(await positive.o.row()).toMatchObject({ rights_pending: true });
      expect(await positive.read.money()).toEqual(before);
      await ordinary.o.sync(settled(800n, touched(1)));
      await ordinary.read.adjustment(2, 100n, 100n);
    });
  },
  TIMEOUT,
);
