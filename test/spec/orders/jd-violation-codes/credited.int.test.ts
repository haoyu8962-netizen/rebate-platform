// B1-04zga · 已入账订单收到违规码（D10-867）：照现有失效口径 R8 整单扣回，sub_type FULL，不再整条拒收。
// 入账走真实 worker 的 settle handler，扣回走同一 worker 的订单流水线，读真实 jd.csv
// （../../settlement/ledger-hooks/kit.ts，只读复用）。手算：N = 1000、reserve 0、本人 50 %，入账与全额扣回都是 500。
import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { capture, close, open, TIMEOUT, withWorker } from '../../settlement/ledger-hooks/kit.ts';
import { at } from '../wiring/db-kit.ts';
import { VIOLATION_CODES } from './kit.ts';

let h: Awaited<ReturnType<typeof open>>;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, 180_000);
afterAll(async () => {
  await close(h);
}, 30_000);

it.each(VIOLATION_CODES)(
  '[AC-B1-04zga#5] CREDITED 订单收到京东 %s：R8 整单扣回（CLAWED_BACK，reason=REFUND，sub_type FULL），不进待处理、不整条拒收',
  async (code) => {
    await withWorker(h, async (w) => {
      const app = await w.app();
      const o = await w.waiting(app);
      await w.credit(app, o);
      expect(await o.row()).toMatchObject({ rebate_status: 'CREDITED' });
      expect(await w.balance(app)).toEqual({ available: 500n, frozen: 0n });

      const report = { raw_status: code, modified_at: at('2026-10-21T01:01:00.000Z') };
      expect(await capture(() => o.report(report))).toMatchObject({ ok: true });

      const pending = await h.db
        .selectFrom('order_sync_pending')
        .selectAll()
        .where('app_id', '=', app.appId)
        .execute();
      expect(pending).toEqual([]);
      expect(await o.row()).toMatchObject({
        platform_status: 'INVALID',
        rebate_status: 'CLAWED_BACK',
        reason: 'REFUND',
        booked_base_fen: 0n,
        booked_n_fen: 0n,
        hold: false,
      });
      const clawbacks = await h.db
        .selectFrom('ledger_entries')
        .select(['sub_type'])
        .where('app_id', '=', app.appId)
        .where('ledger_type', '=', 'CLAWBACK')
        .execute();
      expect(clawbacks.length).toBeGreaterThan(0);
      expect(new Set(clawbacks.map((entry) => entry.sub_type))).toEqual(new Set(['FULL']));
      expect(await w.balance(app)).toEqual({ available: 0n, frozen: 0n });
    });
  },
  TIMEOUT,
);
