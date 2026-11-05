// B2-03s · 真实同步入口上的版本推进（BR-CALC-15，D10-578）：① 结算后只来新预估不推；② 结算首次到达或变化使有效 N
// 不同时推，金额行按新 N；未结算的单 est 变才推。手算：预留 0、本人 50 %，N 1000 → B 1000 → 500，
// N 800 → 400，N 700 → 350，N 900 → 450，N 1200 → 600。commission_moved 只看 rebate 端口收到的 change。
import { createTestDatabase } from '@couli/db/testing';
import { expect, it, vi } from 'vitest';
import {
  TIMEOUT,
  capture,
  databaseFixture,
  received,
  settled,
  touched,
  tracing,
  versionWrites,
  withRule,
} from './kit.ts';

const p = databaseFixture(createTestDatabase);

it(
  '[AC-B2-03s#4][BR-CALC-15][BR-FUND-03] ① 结算后联盟只回传新预估：est 存档，版本不变，金额行不变，钱包与订单页不变',
  async () => {
    await withRule(p.db, async (w) => {
      const o = w.order(await w.app());
      await o.sync();
      await o.sync(received());
      await o.sync(settled(1000n));
      expect(await o.row()).toMatchObject({ commission_version: 1, rebate_status: 'WAITING' });

      await o.sync(settled(null, { ...touched(1), est_commission_fen: 1500n }));
      await o.sync(settled(1000n, { ...touched(2), est_commission_fen: 1600n }));

      expect(await o.row()).toMatchObject({
        est_commission_fen: 1600n,
        settle_commission_fen: 1000n,
        commission_version: 1,
        rebate_status: 'WAITING',
      });
      expect(await o.versions()).toEqual({ amounts: [1], totals: [1] });
      expect(await o.amounts(1)).toEqual([[1000n, 500n]]);
      expect((await o.wallet()).estimated_total_fen).toBe(500n);
      expect(await o.figure()).toMatchObject({ b_est: 1000n, est_rebate_fen: 500n });
      expect(w.moves()).toEqual([false, false, false, false]);
    });
  },
  TIMEOUT,
);

it.each(['WAITING', 'ESTIMATED'] as const)(
  '[AC-B2-03s#5][BR-CALC-15][BR-CALC-27] ② %s 单结算首次到达、settle ≠ est：+1，新版本行与四段金额按新 N，v1 不动，钱包与订单页按新 N',
  async (state) => {
    await withRule(p.db, async (w) => {
      const app = await w.app();
      // 不认的 period_basis 让订单留在 ESTIMATED（AC-B1-09n#11）。
      if (state === 'ESTIMATED') await w.setConfig(app, 'settle.period_basis.pdd', 'settled_at');
      const o = w.order(app);
      await o.sync();
      await o.sync(received());

      await o.sync(settled(800n));

      expect(await o.row()).toMatchObject({
        est_commission_fen: 1000n,
        settle_commission_fen: 800n,
        commission_version: 2,
        rebate_status: state,
      });
      expect(await o.versions()).toEqual({ amounts: [1, 2], totals: [1, 2] });
      expect(await o.amounts(1)).toEqual([[1000n, 500n]]);
      expect(await o.amounts(2)).toEqual([[800n, 400n]]);
      expect(await o.fourAmounts(2)).toEqual({
        n_total_fen: 800n,
        pre_base_deduct_fen: 0n,
        base_fen: 800n,
        user_share_total_fen: 400n,
        tlj_redpacket_fen: 0n,
        platform_est_profit_fen: 400n,
      });
      // BR-FUND-18：钱包只算 WAITING 和「ESTIMATED 且 PAID」，平台已结算的 ESTIMATED 单只在订单页有金额。
      const walletFen = state === 'WAITING' ? 400n : 0n;
      expect((await o.wallet()).estimated_total_fen).toBe(walletFen);
      expect(await o.figure()).toMatchObject({ b_est: 800n, est_rebate_fen: 400n });
      expect(w.moves()).toEqual([false, true]);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-03s#6][BR-CALC-15] ② 结算首次到达、settle = est：有效 N 没变，不 +1，没有新行，commission_moved 为 false',
  async () => {
    await withRule(p.db, async (w) => {
      const o = w.order(await w.app());
      await o.sync();
      await o.sync(received());

      await o.sync(settled(1000n));

      expect(await o.row()).toMatchObject({
        settle_commission_fen: 1000n,
        commission_version: 1,
      });
      expect(await o.versions()).toEqual({ amounts: [1], totals: [1] });
      expect(w.moves()).toEqual([false, false]);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-03s#7][BR-CALC-15][BR-CALC-02] ② 同一报文 est 变、settle 等于旧 est：N 仍是 1000，est 存档，不 +1',
  async () => {
    await withRule(p.db, async (w) => {
      const o = w.order(await w.app());
      await o.sync();
      await o.sync(received());

      await o.sync(settled(1000n, { est_commission_fen: 1200n }));

      expect(await o.row()).toMatchObject({
        est_commission_fen: 1200n,
        settle_commission_fen: 1000n,
        commission_version: 1,
      });
      expect(await o.versions()).toEqual({ amounts: [1], totals: [1] });
      expect(await o.amounts(1)).toEqual([[1000n, 500n]]);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-03s#8][BR-CALC-15] ② 同一报文 est 与 settle 都变：只 +1 一次，新行按结算额，不按预估',
  async () => {
    await withRule(p.db, async (w) => {
      const o = w.order(await w.app());
      await o.sync();
      await o.sync(received());

      await o.sync(settled(900n, { est_commission_fen: 1200n }));

      expect(await o.row()).toMatchObject({
        est_commission_fen: 1200n,
        settle_commission_fen: 900n,
        commission_version: 2,
      });
      expect(await o.amounts(2)).toEqual([[900n, 450n]]);
      expect(w.moves()).toEqual([false, true]);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-03s#9][BR-CALC-15] ② 结算再变：每变一次 +1，同值重放不 +1（幂等），变回旧值也是变',
  async () => {
    await withRule(p.db, async (w) => {
      const o = w.order(await w.app());
      await o.sync();
      await o.sync(received());

      await o.sync(settled(800n));
      expect((await o.row()).commission_version).toBe(2);

      await o.sync(settled(700n, touched(1)));
      expect((await o.row()).commission_version).toBe(3);
      expect(await o.amounts(3)).toEqual([[700n, 350n]]);

      await o.sync(settled(700n, touched(2)));
      expect((await o.row()).commission_version).toBe(3);
      expect(await o.versions()).toEqual({ amounts: [1, 2, 3], totals: [1, 2, 3] });
      expect((await o.wallet()).estimated_total_fen).toBe(350n);

      await o.sync(settled(800n, touched(3)));
      expect((await o.row()).commission_version).toBe(4);
      expect(await o.amounts(4)).toEqual([[800n, 400n]]);
      expect((await o.wallet()).estimated_total_fen).toBe(400n);
      expect(w.moves()).toEqual([false, true, true, false, true]);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-03s#10][BR-CALC-15][BR-FUND-03] 未结算的单：est 变 +1 且新行按新预估，est 不变不 +1，commission_moved 与之一致',
  async () => {
    await withRule(p.db, async (w) => {
      const o = w.order(await w.app());
      await o.sync();

      await o.sync({ est_commission_fen: 1200n });
      expect(await o.row()).toMatchObject({ est_commission_fen: 1200n, commission_version: 2 });
      expect(await o.amounts(2)).toEqual([[1200n, 600n]]);

      await o.sync({ ...touched(1), est_commission_fen: 1200n });
      expect((await o.row()).commission_version).toBe(2);
      expect(await o.versions()).toEqual({ amounts: [1, 2], totals: [1, 2] });
      expect(w.moves()).toEqual([true, false]);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-03s#11][BR-CALC-15] commission_moved 只来自列计划：恰等于这次写库版本动没动，不看 est 前后，也不看结算额是否出现在报文里',
  async () => {
    await withRule(p.db, async (w) => {
      const o = w.order(await w.app());
      await o.sync();
      const reports = [
        { est_commission_fen: 1200n },
        received({ est_commission_fen: 1200n }),
        settled(800n, { est_commission_fen: 1200n }),
        settled(null, { ...touched(1), est_commission_fen: 1500n }),
        settled(700n, { ...touched(2), est_commission_fen: 1500n }),
        settled(700n, { ...touched(3), est_commission_fen: 1500n }),
      ];

      const versionMoved: boolean[] = [];
      for (const report of reports) {
        const before = (await o.row()).commission_version;
        await o.sync(report);
        versionMoved.push((await o.row()).commission_version !== before);
      }

      expect(versionMoved).toEqual([true, false, true, false, true, false]);
      expect(w.moves()).toEqual(versionMoved);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-03s#12][BR-CALC-15] 一次写：结算到达时版本与结算列在同一条 UPDATE，带 row_version 的 CAS，没有第二条写版本的语句',
  async () => {
    const traced = tracing(p.db);
    await withRule(traced.db, async (w) => {
      const o = w.order(await w.app());
      await o.sync();
      await o.sync(received());
      traced.queries.length = 0;

      await o.sync(settled(800n));

      const writes = versionWrites(traced.queries);
      expect(writes).toHaveLength(1);
      const write = writes[0];
      const [written = '', guarded = ''] = (write?.sql ?? '').split(/\swhere\s/i);
      const version = /"commission_version" = \$(\d+)/.exec(written);
      expect(version).not.toBeNull();
      expect(write?.parameters[Number(version?.[1]) - 1]).toBe(2);
      expect(written).toMatch(/"settle_commission_fen" = \$\d+/);
      expect(guarded).toMatch(/"row_version" = \$\d+/);
      expect((await o.row()).commission_version).toBe(2);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-03s#13][BR-CALC-15] 版本、结算列与金额行同事务：后面失败整体回滚，重投才落 v2，且只落一次',
  async () => {
    await withRule(p.db, async (w) => {
      const o = w.order(await w.app());
      await o.sync();
      await o.sync(received());
      const publish = w.events.publish.bind(w.events);
      const failure = new Error('synthetic bus failure');
      const bus = vi.spyOn(w.events, 'publish').mockImplementation(async (trx, event) => {
        if (event.name === 'order.updated') throw failure;
        return publish(trx, event);
      });

      expect(await capture(() => o.report(settled(800n)))).toEqual({ ok: false, error: failure });
      expect(await o.row()).toMatchObject({
        settle_commission_fen: null,
        commission_version: 1,
      });
      expect(await o.versions()).toEqual({ amounts: [1], totals: [1] });
      bus.mockRestore();

      await o.sync(settled(800n));
      expect(await o.row()).toMatchObject({
        settle_commission_fen: 800n,
        commission_version: 2,
      });
      expect(await o.versions()).toEqual({ amounts: [1, 2], totals: [1, 2] });
      expect(await o.amounts(2)).toEqual([[800n, 400n]]);
    });
  },
  TIMEOUT,
);
