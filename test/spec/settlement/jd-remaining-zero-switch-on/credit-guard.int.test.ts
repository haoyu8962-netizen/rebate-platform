// B2-04zzh 入账前守卫（BR-CALC-15「剩余数量为 0 … 按整单失效处理（入账前 R6 → VOID）」、BR-FUND-07、BR-FUND-01 R6、
// BR-FUND-04 ⑦ ⑨「扣回、补差、失效不受本条开关与批次影响」；D10-864 ②、D10-878、D10-923）：开关关期间退完的 WAITING
// 京东单留在 WAITING；打开开关后不再同步，直接跑入账批次（worker 自己的 settle 处理器）：单笔入账锁内重读到
// quantity − refunded_quantity ≤ 0 → 同一判定走 R6 → VOID（PLATFORM_INVALID、reason REFUND）、不写凭证与分录、
// 不发 order.credited、同事务恰一条 order.invalidated（reason REFUND），批次项 skipped / jd_remaining_zero_void；同批
// 剩余 > 0 的京东单照常入账。开关关 → 照常入账，并写一条入账时的 warn（复用 alert jd_remaining_zero_r6_disabled）。
// 主干的入账不看数量：退完的单照常 CREDITED、不告警，每条都红。
// Task-local AC labels ([AC-B2-04zzh#n]) identify this task's acceptance points, not business rules.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  SKIP_REASON,
  SWITCH,
  SYNC_OUTCOME,
  TIMEOUT,
  counts,
  databaseFixture,
  precredit,
  withWorker,
  zeroed,
} from './kit.ts';

const p = databaseFixture(createTestDatabase);

it(
  '[AC-B2-04zzh#1] 开关关时同步出 2 件退 2 的 WAITING 京东单 → 打开开关、不再同步、直接跑入账批次：该单 R6 → VOID（reason REFUND）、历史一行 PLATFORM_INVALID、恰一条 order.invalidated、无凭证无分录、无 order.credited，批次项 skipped / jd_remaining_zero_void；同批剩余 > 0 的京东单照常入账',
  async () => {
    await withWorker(p.db, async (w, logs) => {
      const app = await w.app();
      const gone = await zeroed(w, app, 'WAITING');
      const kept = await precredit(w, app, 'jd', 'WAITING', counts(2, 1));
      expect(await gone.alerts(logs), 'the sync-time alert while the switch was off').toHaveLength(
        1,
      );
      await w.setConfig(app, SWITCH, true);
      const b = await w.batch(app, 'jd', [gone, kept]);
      const before = await w.ledgerOf(app);
      const goneRow = await gone.row();

      await w.settle(b);

      // The order the union no longer has any item of: R6, not R5.
      expect(await gone.row()).toMatchObject({
        rebate_status: 'VOID',
        reason: 'REFUND',
        reason_sub: null,
        quantity: 2,
        refunded_quantity: 2,
        booked_base_fen: null,
        booked_n_fen: null,
        commission_version: goneRow.commission_version,
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
      // The switch is on: no alert at credit time.
      expect(await gone.alerts(logs)).toHaveLength(1);

      // The control in the same batch: 2 items, 1 refunded, credited as before.
      expect(await kept.row()).toMatchObject({ rebate_status: 'CREDITED', reason: null });
      expect(await kept.credits()).toHaveLength(1);
      expect(await kept.voids()).toEqual([]);
      expect(await kept.invalidated()).toEqual([]);
      expect(await kept.creditedEvents()).toHaveLength(1);
      expect(await w.itemOf(b, kept)).toMatchObject({ result: 'credited', skip_reason: null });
      const keptVouchers = await kept.vouchers();
      expect(keptVouchers.length).toBeGreaterThan(0);

      // Every voucher and entry the batch wrote is the control's: the void moved no money.
      const after = await w.ledgerOf(app);
      const earlier = new Set(before.vouchers.map((v) => v.id));
      const added = after.vouchers.filter((v) => !earlier.has(v.id));
      expect(added.map((v) => v.id).sort()).toEqual(keptVouchers.map((v) => v.id).sort());
      const addedIds = new Set(added.map((v) => v.id));
      const earlierEntries = new Set(before.entries.map((e) => String(e.id)));
      const newEntries = after.entries.filter((e) => !earlierEntries.has(String(e.id)));
      expect(newEntries.length).toBeGreaterThan(0);
      for (const entry of newEntries) expect(addedIds.has(entry.voucher_id)).toBe(true);

      expect((await w.batchOf(b)).status).toBe('DONE');
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zzh#2] 开关开、批次只有这一张退完的 WAITING 京东单：作废后该 app 的凭证、分录、余额逐行不变，批次 DONE；同一批次再投一次不再写第二条历史或事件',
  async () => {
    await withWorker(p.db, async (w) => {
      const app = await w.app();
      const gone = await zeroed(w, app, 'WAITING');
      await w.setConfig(app, SWITCH, true);
      const b = await w.batch(app, 'jd', [gone]);
      const ledger = await w.ledgerOf(app);

      await w.settle(b);

      expect(await gone.row()).toMatchObject({ rebate_status: 'VOID', reason: 'REFUND' });
      expect(await gone.voids()).toHaveLength(1);
      expect(await gone.invalidated()).toHaveLength(1);
      expect(await w.ledgerOf(app)).toEqual(ledger);
      expect(await w.itemOf(b, gone)).toEqual({
        result: 'skipped',
        skip_reason: SKIP_REASON,
        amount_fen: null,
      });
      expect((await w.batchOf(b)).status).toBe('DONE');

      await w.settle(b);

      expect(await gone.voids()).toHaveLength(1);
      expect(await gone.invalidated()).toHaveLength(1);
      expect(await gone.creditedEvents()).toEqual([]);
      expect(await w.ledgerOf(app)).toEqual(ledger);
    });
  },
  TIMEOUT,
);

const OFF: readonly (readonly [string, unknown])[] = [
  ['未配置', undefined],
  ['false', false],
];

it.each(OFF)(
  '[AC-B2-04zzh#3] 开关%s：2 件退 2 的 WAITING 京东单进批次 → 照常入账（CREDITED、有凭证、一条 order.credited、批次项 credited），不作废、无 order.invalidated；入账时多写一条 warn（alert jd_remaining_zero_r6_disabled，带 app_id、order_id、platform、quantity、refunded_quantity，outcome 标明入账时）',
  async (_name, value) => {
    await withWorker(p.db, async (w, logs) => {
      const app = await w.app();
      if (value !== undefined) await w.setConfig(app, SWITCH, value);
      const o = await zeroed(w, app, 'WAITING');
      const atSync = await o.alerts(logs);
      expect(atSync, 'the sync-time alert').toHaveLength(1);
      const b = await w.batch(app, 'jd', [o]);

      await w.settle(b);

      const row = await o.row();
      expect(row).toMatchObject({
        rebate_status: 'CREDITED',
        reason: null,
        quantity: 2,
        refunded_quantity: 2,
      });
      expect(await o.credits()).toHaveLength(1);
      expect(await o.voids()).toEqual([]);
      expect(await o.invalidated()).toEqual([]);
      expect(await o.creditedEvents()).toHaveLength(1);
      expect((await o.vouchers()).length).toBeGreaterThan(0);
      expect(await w.itemOf(b, o)).toMatchObject({ result: 'credited', skip_reason: null });

      const alerts = await o.alerts(logs);
      expect(alerts).toHaveLength(2);
      const atCredit = alerts[1]!;
      expect(atCredit).toMatchObject({
        level: 40,
        app_id: app.appId,
        order_id: row.order_id,
        platform: 'jd',
        quantity: 2,
        refunded_quantity: 2,
      });
      expect(typeof atCredit['outcome']).toBe('string');
      expect(atCredit['outcome']).not.toBe(SYNC_OUTCOME);
    });
  },
  TIMEOUT,
);
