// B2-04zzg（FU-JD-REMAINING-ZERO-VOID，D10-864 ②、D10-875、D10-878；BR-CALC-15「剩余数量为 0 … 按整单失效处理（入账前
// R6 → VOID…）」、BR-FUND-07、BR-FUND-01 R6）：开关 orders.jd.refunded_quantity_r9_enabled 为 JSON true 时，未入账的
// 京东单经生产同步写入 quantity − refunded_quantity ≤ 0 → 经生成的 transition() 走 R6 → VOID：orders.reason = REFUND、
// reason_sub 留空、不写分录、余额不变、同事务入队恰一条 order.invalidated（reason REFUND）、返利历史一行
// PLATFORM_INVALID → VOID（D10-878：走现有 PLATFORM_INVALID 事件）。佣金版本与金额行不动。
// 主干的入账前判定不看数量：本文件每条在主干上都因「未作废 / 无 order.invalidated」而红。
// Task-local AC labels ([AC-B2-04zzg#n]) identify this task's acceptance points, not business rules.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  SWITCH,
  TIMEOUT,
  counts,
  databaseFixture,
  precredit,
  touched,
  withWorker,
  type App,
  type SyncedOrder,
  type Worker,
} from './kit.ts';

const p = databaseFixture(createTestDatabase);

type OrderRow = Awaited<ReturnType<SyncedOrder['row']>>;

/**
 * The order is VOID by R6 from `from` with reason REFUND (D10-878), one order.invalidated naming it,
 * and nothing else of the order moved: platform status, estimate, commission version and its rows,
 * the booked pair, the app's vouchers, entries and balances.
 */
async function expectVoided(
  w: Worker,
  app: App,
  o: SyncedOrder,
  from: 'UNATTRIBUTED' | 'ESTIMATED' | 'WAITING',
  before: {
    readonly row: OrderRow;
    readonly ledger: Awaited<ReturnType<Worker['ledgerOf']>>;
    readonly totals: Awaited<ReturnType<SyncedOrder['totals']>>;
  },
  platformStatus: string = before.row.platform_status,
): Promise<void> {
  const row = await o.row();
  expect(row).toMatchObject({
    rebate_status: 'VOID',
    reason: 'REFUND',
    reason_sub: null,
    platform_status: platformStatus,
    commission_version: before.row.commission_version,
    est_commission_fen: before.row.est_commission_fen,
    booked_base_fen: null,
    booked_n_fen: null,
  });
  expect(await o.voids()).toEqual([
    { from_status: from, event: 'PLATFORM_INVALID', to_status: 'VOID', source: 'sync' },
  ]);
  const events = await o.invalidated();
  expect(events).toHaveLength(1);
  expect(events[0]!.payload).toMatchObject({
    order_id: row.order_id,
    platform: 'jd',
    reason: 'REFUND',
  });
  expect(await o.totals()).toEqual(before.totals);
  expect(await w.ledgerOf(app)).toEqual(before.ledger);
}

async function snapshot(w: Worker, app: App, o: SyncedOrder) {
  return { row: await o.row(), ledger: await w.ledgerOf(app), totals: await o.totals() };
}

it.each(['ESTIMATED', 'WAITING'] as const)(
  '[AC-B2-04zzg#1] 开关开：%s 京东单 skuNum 2、skuReturnNum 0 → 2：R6 → VOID，reason REFUND，无分录、余额不变，恰一条 order.invalidated，历史一行 PLATFORM_INVALID',
  async (status) => {
    await withWorker(p.db, async (w) => {
      const app = await w.app();
      const o = await precredit(w, app, 'jd', status);
      await w.setConfig(app, SWITCH, true);
      const before = await snapshot(w, app, o);
      expect(await o.invalidated()).toEqual([]);

      await o.sync(touched(5, counts(2, 2)));

      expect(await o.row()).toMatchObject({ quantity: 2, refunded_quantity: 2 });
      await expectVoided(w, app, o, status, before);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zzg#2] 开关开：UNATTRIBUTED 京东单剩余数量归 0 同样 R6 → VOID（BR-FUND-07 的来源含 UNATTRIBUTED）',
  async () => {
    await withWorker(p.db, async (w) => {
      const app = await w.app();
      await w.setConfig(app, SWITCH, true);
      const o = w.order(app, 'jd', counts(3, 0), { unattributed: true });
      await o.sync();
      expect(await o.row()).toMatchObject({ rebate_status: 'UNATTRIBUTED', user_id: null });
      const before = await snapshot(w, app, o);

      await o.sync(touched(5, counts(3, 3)));

      await expectVoided(w, app, o, 'UNATTRIBUTED', before);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zzg#3] 开关开：同一报文既确认收货又退完：ESTIMATED 直接 R6 → VOID，不先走 R4 到 WAITING',
  async () => {
    await withWorker(p.db, async (w) => {
      const app = await w.app();
      const o = await precredit(w, app, 'jd', 'ESTIMATED');
      await w.setConfig(app, SWITCH, true);
      const before = await snapshot(w, app, o);

      await o.sync(o.receipt(5, counts(2, 2)));

      await expectVoided(w, app, o, 'ESTIMATED', before, 'RECEIVED');
      expect((await o.history()).filter((h) => h.to_status === 'WAITING')).toEqual([]);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zzg#4] 开关开：已退件数超过件数（2 件退 3）同样按剩余 ≤ 0 作废',
  async () => {
    await withWorker(p.db, async (w) => {
      const app = await w.app();
      const o = await precredit(w, app, 'jd', 'WAITING');
      await w.setConfig(app, SWITCH, true);
      const before = await snapshot(w, app, o);

      await o.sync(touched(5, counts(2, 3)));

      expect(await o.row()).toMatchObject({ quantity: 2, refunded_quantity: 3 });
      await expectVoided(w, app, o, 'WAITING', before);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zzg#5] 开关开：同一报文预估归 0 且退完：按剩余数量走 R6，reason 是 REFUND 而不是 COMMISSION_ZERO（数量判定先于佣金判定）',
  async () => {
    await withWorker(p.db, async (w) => {
      const app = await w.app();
      const o = await precredit(w, app, 'jd', 'ESTIMATED');
      await w.setConfig(app, SWITCH, true);

      await o.sync(touched(5, { ...counts(2, 2), est_commission_fen: 0n, commission_fen: 0n }));

      const row = await o.row();
      expect(row).toMatchObject({ rebate_status: 'VOID', reason: 'REFUND' });
      expect(await o.voids()).toEqual([
        { from_status: 'ESTIMATED', event: 'PLATFORM_INVALID', to_status: 'VOID', source: 'sync' },
      ]);
      const events = await o.invalidated();
      expect(events.map((e) => e.payload['reason'])).toEqual(['REFUND']);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zzg#6] 开关开：剩余数量 > 0（2 件退 1）不作废、不入队、不告警，预估不变；之后退完（2 件退 2）才作废',
  async () => {
    await withWorker(p.db, async (w, logs) => {
      const app = await w.app();
      const o = await precredit(w, app, 'jd', 'WAITING');
      await w.setConfig(app, SWITCH, true);
      const before = await snapshot(w, app, o);

      await o.sync(touched(5, counts(2, 1)));

      expect(await o.row()).toMatchObject({
        rebate_status: 'WAITING',
        reason: null,
        quantity: 2,
        refunded_quantity: 1,
        commission_version: before.row.commission_version,
        est_commission_fen: before.row.est_commission_fen,
      });
      expect(await o.voids()).toEqual([]);
      expect(await o.invalidated()).toEqual([]);
      expect(await o.alerts(logs)).toEqual([]);
      expect(await w.ledgerOf(app)).toEqual(before.ledger);

      await o.sync(touched(6, counts(2, 2)));

      await expectVoided(w, app, o, 'WAITING', before);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zzg#7] 开关开：件数为空（报文没给 skuNum）的京东单已退件数再多也不作废；同 app 件数齐全的京东单照常作废',
  async () => {
    await withWorker(p.db, async (w) => {
      const app = await w.app();
      await w.setConfig(app, SWITCH, true);
      const unknown = w.order(app, 'jd', counts(null, 0));
      await unknown.sync();
      expect(await unknown.row()).toMatchObject({
        rebate_status: 'ESTIMATED',
        quantity: null,
        refunded_quantity: 0,
      });
      const known = await precredit(w, app, 'jd', 'ESTIMATED');
      const knownBefore = await snapshot(w, app, known);

      await unknown.sync(touched(5, counts(null, 2)));
      await known.sync(touched(6, counts(2, 2)));

      expect(await unknown.row()).toMatchObject({
        rebate_status: 'ESTIMATED',
        reason: null,
        quantity: null,
        refunded_quantity: 2,
      });
      expect(await unknown.invalidated()).toEqual([]);
      await expectVoided(w, app, known, 'ESTIMATED', knownBefore);
    });
  },
  TIMEOUT,
);
