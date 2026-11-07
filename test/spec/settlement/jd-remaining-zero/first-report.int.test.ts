// B2-04zzg 首次入库（BR-CALC-15「剩余数量为 0 … 按整单失效处理（入账前 R6 → VOID）」、BR-FUND-01 R1 / R2 / R6、
// BR-FUND-07；D10-864 ②、D10-878）：京东单的首个报文就已退完（skuNum 2、skuReturnNum 2）。开关开 → 同一事务先 R1
// （已归因，IMPORT_ATTRIBUTED）或 R2（未归因，IMPORT_UNATTRIBUTED），再 R6（PLATFORM_INVALID）→ VOID：reason REFUND、
// reason_sub 留空、不推佣金版本（已归因的只有 orders 分佣快照写的 v1，未归因无行）、不写分录、余额不变、恰一条 order.invalidated
// （reason REFUND）。开关关 → 按 R1 / R2 留在 ESTIMATED / UNATTRIBUTED，只写一条 warn（alert
// jd_remaining_zero_r6_disabled）；之后开关打开、同数量再同步一次即作废。
// 主干首次入库只做 R1 / R2：不作废、无 order.invalidated、无这条告警，每条都红。
// Task-local AC labels ([AC-B2-04zzg#n]) identify this task's acceptance points, not business rules.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  SWITCH,
  TIMEOUT,
  counts,
  databaseFixture,
  touched,
  withWorker,
  type App,
  type SyncedOrder,
  type Worker,
} from './kit.ts';

const p = databaseFixture(createTestDatabase);

type Imported = 'ESTIMATED' | 'UNATTRIBUTED';

const IMPORT_EVENT: Record<Imported, string> = {
  ESTIMATED: 'IMPORT_ATTRIBUTED',
  UNATTRIBUTED: 'IMPORT_UNATTRIBUTED',
};

/** A jd order whose very first report already has every item refunded (2 of 2). */
function refundedOnArrival(w: Worker, app: App, imported: Imported): SyncedOrder {
  return w.order(app, 'jd', counts(2, 2), { unattributed: imported === 'UNATTRIBUTED' });
}

/**
 * The first report, with the switch on: R1 / R2 then R6 in the same sync, VOID with reason REFUND,
 * no new commission version, no money, exactly one order.invalidated (reason REFUND), no alert.
 */
async function expectVoidedOnImport(imported: Imported): Promise<void> {
  await withWorker(p.db, async (w, logs) => {
    const app = await w.app();
    await w.setConfig(app, SWITCH, true);
    const ledger = await w.ledgerOf(app);
    const o = refundedOnArrival(w, app, imported);

    await o.sync();

    const row = await o.row();
    expect(row).toMatchObject({
      platform: 'jd',
      user_id: imported === 'ESTIMATED' ? app.userId : null,
      rebate_status: 'VOID',
      reason: 'REFUND',
      reason_sub: null,
      quantity: 2,
      refunded_quantity: 2,
      booked_base_fen: null,
      booked_n_fen: null,
    });
    expect(await o.history()).toEqual([
      { from_status: null, event: IMPORT_EVENT[imported], to_status: imported, source: 'sync' },
      { from_status: imported, event: 'PLATFORM_INVALID', to_status: 'VOID', source: 'sync' },
    ]);
    const events = await o.invalidated();
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({
      order_id: row.order_id,
      platform: 'jd',
      reason: 'REFUND',
    });
    expect((await o.totals()).map((t) => t.commission_version)).toEqual(
      imported === 'ESTIMATED' ? [1] : [],
    );
    expect(await w.ledgerOf(app)).toEqual(ledger);
    expect(await o.alerts(logs)).toEqual([]);
  });
}

it(
  '[AC-B2-04zzg#16] 开关开：已归因京东单首个报文就 2 件退 2 → 同一事务 R1 后 R6 → VOID，reason REFUND，历史两行，恰一条 order.invalidated，不生成预估、无分录、余额不变',
  async () => {
    await expectVoidedOnImport('ESTIMATED');
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zzg#17] 开关开：未归因京东单首个报文就 2 件退 2 → 同一事务 R2 后 R6 → VOID，reason REFUND，历史两行，恰一条 order.invalidated，不生成预估、无分录、余额不变',
  async () => {
    await expectVoidedOnImport('UNATTRIBUTED');
  },
  TIMEOUT,
);

const OFF: readonly (readonly [string, Imported, unknown])[] = [
  ['未配置', 'ESTIMATED', undefined],
  ['false', 'ESTIMATED', false],
  ['未配置', 'UNATTRIBUTED', undefined],
  ['false', 'UNATTRIBUTED', false],
];

it.each(OFF)(
  '[AC-B2-04zzg#18] 开关%s：京东单首个报文就 2 件退 2 → 按 R1 / R2 留在 %s、不作废、无 order.invalidated，恰一条 warn 告警；之后开关置 true、同样数量再同步一次 → R6 → VOID',
  async (_name, imported, value) => {
    await withWorker(p.db, async (w, logs) => {
      const app = await w.app();
      if (value !== undefined) await w.setConfig(app, SWITCH, value);
      const ledger = await w.ledgerOf(app);
      const o = refundedOnArrival(w, app, imported);

      await o.sync();

      const kept = await o.row();
      expect(kept).toMatchObject({
        platform: 'jd',
        rebate_status: imported,
        reason: null,
        quantity: 2,
        refunded_quantity: 2,
      });
      expect(await o.history()).toEqual([
        { from_status: null, event: IMPORT_EVENT[imported], to_status: imported, source: 'sync' },
      ]);
      expect(await o.invalidated()).toEqual([]);
      expect(await w.ledgerOf(app)).toEqual(ledger);
      const alerts = await o.alerts(logs);
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toMatchObject({
        level: 40,
        alert: 'jd_remaining_zero_r6_disabled',
        app_id: app.appId,
        order_id: kept.order_id,
        platform: 'jd',
        quantity: 2,
        refunded_quantity: 2,
      });

      await w.setConfig(app, SWITCH, true);
      await o.sync(touched(5, counts(2, 2)));

      expect(await o.row()).toMatchObject({
        rebate_status: 'VOID',
        reason: 'REFUND',
        reason_sub: null,
      });
      expect(await o.voids()).toEqual([
        { from_status: imported, event: 'PLATFORM_INVALID', to_status: 'VOID', source: 'sync' },
      ]);
      const events = await o.invalidated();
      expect(events.map((e) => e.payload['reason'])).toEqual(['REFUND']);
      expect(events[0]!.payload).toMatchObject({ order_id: kept.order_id, platform: 'jd' });
      expect(await o.alerts(logs)).toHaveLength(1);
      expect(await w.ledgerOf(app)).toEqual(ledger);
    });
  },
  TIMEOUT,
);
