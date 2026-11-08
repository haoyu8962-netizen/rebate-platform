// B2-04zzh 守卫只认「剩余数量为 0」（BR-CALC-15「剩余数量为 0 或 N_new = 0 按整单失效处理（入账前 R6 → VOID）」；
// 任务书 §9.2 第 1 条「两列都非空」、「两列有空 … 完全照旧」，§9.5 #11）：京东单报文没给 skuNum / skuReturnNum
// （quantity、refunded_quantity 都为 null）是件数未知，不是 0。开关开，这样一张 WAITING 京东单与一张开关关期间
// 2 件退 2 的 WAITING 京东单同批入账：前者照常 R5 → CREDITED（凭证、一条 order.credited、批次项 credited），
// 无 PLATFORM_INVALID 历史、无 order.invalidated、无告警；后者照 #1 作废（对照）。主干的入账不看数量，对照那张被
// 照常入账，所以红。
// Task-local AC labels ([AC-B2-04zzh#n]) identify this task's acceptance points, not business rules.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  SKIP_REASON,
  SWITCH,
  TIMEOUT,
  counts,
  databaseFixture,
  precredit,
  withWorker,
  zeroed,
} from './kit.ts';

const p = databaseFixture(createTestDatabase);

it(
  '[AC-B2-04zzh#11] 开关开：件数为空（quantity、refunded_quantity 都为 null）的 WAITING 京东单与 2 件退 2 的 WAITING 京东单同批入账 → 前者照常 CREDITED（凭证、一条 order.credited、批次项 credited），无 PLATFORM_INVALID 历史、无 order.invalidated、无告警；后者作废（VOID、REFUND、批次项 skipped / jd_remaining_zero_void）',
  async () => {
    await withWorker(p.db, async (w, logs) => {
      const app = await w.app();
      const blank = await precredit(w, app, 'jd', 'WAITING', counts(null, null));
      const gone = await zeroed(w, app, 'WAITING');
      await w.setConfig(app, SWITCH, true);
      const b = await w.batch(app, 'jd', [blank, gone]);
      const goneRow = await gone.row();

      await w.settle(b);

      // Counts unknown: credited as before.
      expect(await blank.row()).toMatchObject({
        platform: 'jd',
        rebate_status: 'CREDITED',
        reason: null,
        reason_sub: null,
        quantity: null,
        refunded_quantity: null,
      });
      const blankCredits = await blank.credits();
      expect(blankCredits).toHaveLength(1);
      expect(blankCredits[0]).toMatchObject({ from_status: 'WAITING', to_status: 'CREDITED' });
      expect(await blank.voids()).toEqual([]);
      expect((await blank.history()).filter((h) => h.event === 'PLATFORM_INVALID')).toEqual([]);
      expect(await blank.invalidated()).toEqual([]);
      expect(await blank.creditedEvents()).toHaveLength(1);
      expect((await blank.vouchers()).length).toBeGreaterThan(0);
      expect(await w.itemOf(b, blank)).toMatchObject({ result: 'credited', skip_reason: null });
      expect(await blank.alerts(logs)).toEqual([]);

      // The control in the same batch: 2 items, both refunded → R6 at credit time.
      expect(await gone.row()).toMatchObject({
        rebate_status: 'VOID',
        reason: 'REFUND',
        reason_sub: null,
        quantity: 2,
        refunded_quantity: 2,
        booked_base_fen: null,
        booked_n_fen: null,
      });
      const voids = await gone.voids();
      expect(voids).toHaveLength(1);
      expect(voids[0]).toMatchObject({
        from_status: 'WAITING',
        event: 'PLATFORM_INVALID',
        to_status: 'VOID',
      });
      expect(await gone.credits()).toEqual([]);
      const invalidated = await gone.invalidated();
      expect(invalidated).toHaveLength(1);
      expect(invalidated[0]!.payload).toMatchObject({
        order_id: goneRow.order_id,
        platform: 'jd',
        reason: 'REFUND',
      });
      expect(await gone.creditedEvents()).toEqual([]);
      expect(await gone.vouchers()).toEqual([]);
      expect(await w.itemOf(b, gone)).toEqual({
        result: 'skipped',
        skip_reason: SKIP_REASON,
        amount_fen: null,
      });

      expect((await w.batchOf(b)).status).toBe('DONE');
    });
  },
  TIMEOUT,
);
