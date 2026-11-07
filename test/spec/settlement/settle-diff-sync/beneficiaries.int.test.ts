// BR-FUND-09 negative route: status-specific postings and open obligations share the sync txn.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it, vi } from 'vitest';
import {
  MEMBER_ROLE,
  TIMEOUT,
  capture,
  credited,
  databaseFixture,
  moveUserFunds,
  risk,
  settled,
  touched,
  withSync,
} from './kit.ts';

const p = databaseFixture(createTestDatabase);

it(
  '[AC-B2-04zi#32] 已到账后封禁，负差只把净额500扣到新份额400，不能整份没收',
  async () => {
    await withSync(p.db, async (w) => {
      const { app, o, read } = await credited(p.db, w);
      await risk(p.db, w, app, 'banned');
      await o.sync(settled(800n, touched(1)));
      await read.adjustment(2, 100n, 100n);
      expect(await w.available(app)).toBe(400n);
      expect(await o.row()).toMatchObject({
        rebate_status: 'CREDITED',
        booked_base_fen: 800n,
        booked_n_fen: 800n,
      });
      expect(await read.obligations()).toEqual([]);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zi#33] 没收义务的同步后续失败：forfeited事件与关闭义务一同回滚，重投恰好关闭一次',
  async () => {
    await withSync(p.db, async (w) => {
      const { app, o, read } = await credited(p.db, w, { held: true });
      await risk(p.db, w, app, 'banned');
      const before = await read.money();
      const eventsBefore = await read.events();
      const recordsBefore = await o.records();
      const publish = w.events.publish.bind(w.events);
      const failure = new Error('synthetic obligation rollback');
      const bus = vi.spyOn(w.events, 'publish').mockImplementation(async (trx, event) => {
        if (event.name === 'order.updated') throw failure;
        return publish(trx, event);
      });
      try {
        expect(await capture(() => o.report(settled(800n, touched(1))))).toEqual({
          ok: false,
          error: failure,
        });
        expect(await read.money()).toEqual(before);
        expect(await read.events()).toEqual(eventsBefore);
        expect(await o.records()).toEqual(recordsBefore);
      } finally {
        bus.mockRestore();
      }
      await o.sync(settled(800n, touched(1)));
      await read.adjustment(2, 0n, -300n);
      expect(await read.obligations()).toMatchObject([{ status: 'forfeited', closed_by: 'R10' }]);
      expect((await read.events()).filter((e) => e.status === 'forfeited')).toHaveLength(1);
    });
  },
  TIMEOUT,
);

for (const [ac, status] of [
  [18, 'deleting'],
  [19, 'deleted'],
] as const) {
  it(
    `[AC-B2-04zi#${ac}] 已到账受益人${status}，1000→800的100分负差记BAD_DEBT，不动用户账户`,
    async () => {
      await withSync(p.db, async (w) => {
        const { app, o, read } = await credited(p.db, w);
        await p.db
          .updateTable('users')
          .set({ status })
          .where('app_id', '=', app.appId)
          .where('id', '=', app.userId)
          .execute();
        const before = await read.balance();
        await o.sync(settled(800n, touched(1)));
        await read.adjustment(2, 100n, 100n, 'BAD_DEBT');
        expect(await read.balance()).toEqual(before);
        expect(await o.row()).toMatchObject({
          rebate_status: 'CREDITED',
          booked_base_fen: 800n,
          booked_n_fen: 800n,
        });
        // BAD_DEBT must count toward this beneficiary's order net: the next change takes only 100.
        await o.sync(settled(600n, touched(2)));
        await read.adjustment(3, 100n, 100n, 'BAD_DEBT');
        expect(await read.balance()).toEqual(before);
      });
    },
    TIMEOUT,
  );
}

for (const [ac, state] of [
  [20, 'banned'],
  [21, 'deleted'],
] as const) {
  it(
    `[AC-B2-04zi#${ac}] 原暂缓500、现${state}：新份额400归平台，义务forfeited/closed_by R10并追加事件`,
    async () => {
      await withSync(p.db, async (w) => {
        const { app, o, read } = await credited(p.db, w, { held: true });
        const obligations = await read.obligations();
        expect(obligations).toMatchObject([{ status: 'open', kind: 'first_credit' }]);
        if (state === 'banned') await risk(p.db, w, app, 'banned');
        else
          await p.db
            .updateTable('users')
            .set({ status: 'deleted' })
            .where('app_id', '=', app.appId)
            .where('id', '=', app.userId)
            .execute();
        await o.sync(settled(800n, touched(1)));
        // Before: receivable/platform=500, pending=500. After: platform=800, pending=0.
        // Δreceivable=-200-(-500)=+300; platform ADJ therefore credits revenue by 300.
        await read.adjustment(2, 0n, -300n);
        expect(await read.obligations()).toMatchObject([
          {
            beneficiary_credit_id: obligations[0]!.beneficiary_credit_id,
            status: 'forfeited',
            closed_by: 'R10',
            closed_at: w.clock.now(),
          },
        ]);
        expect((await read.events()).filter((e) => e.status === 'forfeited')).toMatchObject([
          {
            user_id: app.userId,
            role: MEMBER_ROLE,
            status: 'forfeited',
            reason: state,
            created_at: w.clock.now(),
          },
        ]);
        expect(await o.row()).toMatchObject({
          rebate_status: 'CREDITED',
          booked_base_fen: 800n,
          booked_n_fen: 800n,
        });
        expect(await w.available(app)).toBe(0n);
        expect(await read.candidates()).toEqual([]);
        const before = await read.money();
        const eventsBefore = await read.events();
        await o.sync(settled(800n, touched(2)));
        expect(await read.money()).toEqual(before);
        expect(await read.events()).toEqual(eventsBefore);
      });
    },
    TIMEOUT,
  );
}

for (const [ac, state] of [
  [22, 'frozen'],
  [23, 'appealing'],
  [24, 'normal'],
] as const) {
  it(
    `[AC-B2-04zi#${ac}] 暂缓后${state}的新应得400仍待补记，原义务保留、不先补给也不进候选`,
    async () => {
      await withSync(p.db, async (w) => {
        const { app, o, read } = await credited(p.db, w, { held: true });
        const before = await read.obligations();
        expect(before).toMatchObject([{ status: 'open', kind: 'first_credit' }]);
        await risk(p.db, w, app, state);
        await o.sync(settled(800n, touched(1)));
        // pending 500→400: union delta=-200-(-100)=-100, platform 500→400.
        await read.adjustment(2, 0n, 100n);
        expect(await read.obligations()).toEqual(before);
        expect(await w.available(app)).toBe(0n);
        expect(await read.candidates()).toEqual([]);
        expect(await o.row()).toMatchObject({
          rebate_status: 'CREDITED',
          booked_base_fen: 800n,
          booked_n_fen: 800n,
        });
        expect((await read.events()).filter((e) => e.status === 'forfeited')).toEqual([]);
      });
    },
    TIMEOUT,
  );
}

for (const [ac, state] of [
  [25, 'frozen'],
  [26, 'appealing'],
  [27, 'normal'],
] as const) {
  it(
    `[AC-B2-04zi#${ac}] ${state}受益人净额已由历史调整降到0、没有义务：负差路线新开deferred/R10保留400`,
    async () => {
      await withSync(p.db, async (w) => {
        const { app, o, read } = await credited(p.db, w);
        // Historical correction redistributed the user's 500 to platform. Booked remains 1000;
        // net user=0, platform=1000, pending=0. Do not simulate this by editing account balances.
        await moveUserFunds(p.db, w, app, o, 'past-clawback');
        expect(await read.obligations()).toEqual([]);
        await risk(p.db, w, app, state);
        await o.sync(settled(800n, touched(1)));
        // New platform 400, pending 400: union delta=-200-400=-600.
        await read.adjustment(2, 0n, 600n);
        expect(await read.obligations()).toMatchObject([
          {
            user_id: app.userId,
            role: MEMBER_ROLE,
            status: 'open',
            kind: 'deferred',
            opened_by: 'R10',
            origin_ledger_type: 'SETTLE_ADJUST',
            origin_sub_type: 'SETTLE_DIFF',
            opened_at: w.clock.now(),
          },
        ]);
        expect(await w.available(app)).toBe(0n);
        expect(await read.candidates()).toEqual([]);
        expect(await o.row()).toMatchObject({ booked_base_fen: 800n, booked_n_fen: 800n });
        const obligations = await read.obligations();
        await o.sync(settled(600n, touched(2)));
        await read.adjustment(3, 0n, 100n);
        expect(await read.obligations()).toEqual(obligations);
      });
    },
    TIMEOUT,
  );
}
