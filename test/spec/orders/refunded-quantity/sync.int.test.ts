// B1-08zi（D10-814 ① ② ③）：件数与已退件数经生产 worker 的订单流水线写进 orders：首次入库（pipeline-port）与
// 后续同步（update-step）都写、与同步 upsert 同一事务；缺失沿用库内值、只增不减（变小不写，打一条带 alert 字段
// 的告警日志，不带子订单号）；只有数量变化时 commission_version 不动；refunded_quantity_at_credit 不由同步写。
// 路径与 ../../settlement/settle-diff-sync/kit.ts 相同：报文是归一后的 UnionOrder，平台是 pdd（那套 kit 只有
// pdd 的状态表带结算码）。拼多多适配器本身不给这两个字段，这里的值是合成的：orders 只读归一后的 DTO、不按平台
// 分支（orders/AGENTS.md 硬规则 1），京东的字段来源由 jd-mapping.test.ts 钉住。
// 另钉：下游失败整事务回滚、重投只一次（#36）；P10 倒退整条不落（#37、#38，表外事件见 reject.test.ts）；
// 入账前（ESTIMATED / WAITING）已退件数增加不动钱（#39、#40）。
// Task-local AC labels ([AC-B1-08zi#n]) identify this task's acceptance points, not business rules.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it, vi } from 'vitest';
import type { UnionOrder } from '../../../../apps/api/src/modules/union/index.ts';
import { creditedWith, settled } from '../../settlement/credit-refund-baseline/kit.ts';
import {
  TIMEOUT,
  capture,
  databaseFixture,
  touched,
  withSync,
  type Worker,
} from '../../settlement/settle-diff-sync/kit.ts';
import { PDD_PAID, received } from '../../settlement/settlement-records/kit.ts';

const p = databaseFixture(createTestDatabase);

type Patch = Partial<UnionOrder>;

/** Every voucher, entry and balance row of the app: what a money effect would change. */
async function ledgerOf(appId: string) {
  return {
    vouchers: await p.db
      .selectFrom('ledger_vouchers')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('uniq_key')
      .execute(),
    entries: await p.db
      .selectFrom('ledger_entries')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('id')
      .execute(),
    balances: await p.db
      .selectFrom('account_balances')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('account_id')
      .execute(),
  };
}

/** The four CLAWBACK lines of R9 at 600 on the kit's N 1000 (own share 50 %, reserve 0). */
const R9_AT_600 = [
  'USER_BALANCE|200',
  'COMMISSION_REVENUE|200',
  'UNION_RECEIVABLE:pdd|-200',
  'UNION_RECEIVABLE:pdd|-200',
].sort();

/** The alert lines that name `reason` for the app (any field value), from the captured pino lines. */
function alertsNaming(logs: readonly Record<string, unknown>[], appId: string, reason: string) {
  return logs.filter(
    (line) =>
      typeof line.alert === 'string' &&
      line.app_id === appId &&
      Object.values(line).includes(reason),
  );
}

it(
  '[AC-B1-08zi#15] 首次入库写报文给的 quantity / refunded_quantity；报文不给的订单两列为空；at_credit 都为空',
  async () => {
    await withSync(p.db, async (w) => {
      const app = await w.app();
      const given = w.order(app, { quantity: 3, refunded_quantity: 1 });
      const absent = w.order(app);
      await given.sync();
      await absent.sync();
      expect(await given.row()).toMatchObject({
        quantity: 3,
        refunded_quantity: 1,
        refunded_quantity_at_credit: null,
      });
      expect(await absent.row()).toMatchObject({
        quantity: null,
        refunded_quantity: null,
        refunded_quantity_at_credit: null,
      });
    });
  },
  TIMEOUT,
);

it(
  '[AC-B1-08zi#16] 后续同步：增加写入；没给沿用；变小不写并告警；commission_version 与返利状态都不动',
  async () => {
    await withSync(p.db, async (w, logs) => {
      const app = await w.app();
      const o = w.order(app, { quantity: 3, refunded_quantity: 0 });
      await o.sync();
      const first = await o.row();
      expect(first).toMatchObject({ quantity: 3, refunded_quantity: 0 });

      await o.sync({ ...touched(1), refunded_quantity: 2 });
      expect(await o.row()).toMatchObject({ quantity: 3, refunded_quantity: 2 });

      await o.sync({ ...touched(2), quantity: null, refunded_quantity: null });
      expect(await o.row()).toMatchObject({ quantity: 3, refunded_quantity: 2 });
      expect(alertsNaming(logs, app.appId, 'refunded_quantity_decreased')).toEqual([]);

      await o.sync({ ...touched(3), quantity: 3, refunded_quantity: 1 });
      const last = await o.row();
      expect(last).toMatchObject({
        quantity: 3,
        refunded_quantity: 2,
        refunded_quantity_at_credit: null,
        commission_version: first.commission_version,
        rebate_status: first.rebate_status,
        est_commission_fen: first.est_commission_fen,
      });
      // 告警只在拒写的那次同步出现；本次报文的其余列照写（platform_modified_at 前进）。
      const alerts = alertsNaming(logs, app.appId, 'refunded_quantity_decreased');
      expect(alerts).toHaveLength(1);
      expect(Object.values(alerts[0]!)).not.toContain(o.subOrderId);
      expect(last.platform_modified_at?.toISOString()).toBe('2026-10-21T10:03:00.000Z');
    });
  },
  TIMEOUT,
);

it(
  '[AC-B1-08zi#17] 件数变小同样不写并告警；已退件数同一次增加照写',
  async () => {
    await withSync(p.db, async (w, logs) => {
      const app = await w.app();
      const o = w.order(app, { quantity: 4, refunded_quantity: 1 });
      await o.sync();
      await o.sync({ ...touched(1), quantity: 2, refunded_quantity: 2 });
      expect(await o.row()).toMatchObject({ quantity: 4, refunded_quantity: 2 });
      expect(alertsNaming(logs, app.appId, 'quantity_decreased')).toHaveLength(1);
      expect(alertsNaming(logs, app.appId, 'refunded_quantity_decreased')).toEqual([]);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B1-08zi#18] 首次入库已退件数大于 0 也原样写；同一报文重放不改两列',
  async () => {
    await withSync(p.db, async (w) => {
      const app = await w.app();
      const o = w.order(app, { quantity: 5, refunded_quantity: 2 });
      await o.sync();
      const row = await o.row();
      expect([row.quantity, row.refunded_quantity, row.refunded_quantity_at_credit]).toEqual([
        5,
        2,
        null,
      ]);
      await o.sync();
      expect(await o.row()).toMatchObject({ quantity: 5, refunded_quantity: 2 });
    });
  },
  TIMEOUT,
);

it.each(['order.clawed_back', 'order.updated'] as const)(
  '[AC-B1-08zi#36] 入账后同一次同步件数 3 → 4、已退 0 → 1、结算 1000 → 600，%s 入队失败：件数、已退件数、佣金、版本与资金效果全部回滚；恢复后重投只产生一次 R9',
  async (failing) => {
    await withSync(p.db, async (w) => {
      const { o, read } = await creditedWith(p.db, w, { quantity: 3, refunded_quantity: 0 });
      const rowBefore = await o.row();
      expect(rowBefore).toMatchObject({
        quantity: 3,
        refunded_quantity: 0,
        refunded_quantity_at_credit: 0,
        settle_commission_fen: 1000n,
      });
      const moneyBefore = await read.money();
      const totalsBefore = await o.totals();
      const recordsBefore = await o.records();
      const report = settled(600n, { ...touched(1), quantity: 4, refunded_quantity: 1 });

      const publish = w.events.publish.bind(w.events);
      const failure = new Error('synthetic downstream failure');
      const bus = vi.spyOn(w.events, 'publish').mockImplementation(async (trx, event) => {
        if (event.name === failing) throw failure;
        return publish(trx, event);
      });
      try {
        expect(await capture(() => o.report(report))).toEqual({ ok: false, error: failure });
        // 订单行逐列不变：quantity、refunded_quantity、at_credit、settle_commission_fen、commission_version、row_version。
        expect(await o.row()).toEqual(rowBefore);
        expect(await o.row()).toMatchObject({ quantity: 3, refunded_quantity: 0 });
        expect(await read.money()).toEqual(moneyBefore);
        expect(await o.totals()).toEqual(totalsBefore);
        expect(await o.records()).toEqual(recordsBefore);
      } finally {
        bus.mockRestore();
      }

      await o.sync(report);
      const after = await o.row();
      expect(after).toMatchObject({
        rebate_status: 'CREDITED',
        quantity: 4,
        refunded_quantity: 1,
        refunded_quantity_at_credit: 0,
        settle_commission_fen: 600n,
        booked_base_fen: 600n,
        booked_n_fen: 600n,
      });
      const clawback = (await read.lines()).filter((l) => l.ledger_type === 'CLAWBACK');
      expect(clawback.map((l) => `${l.subject}|${l.amount_fen}`).sort()).toEqual(R9_AT_600);
      expect((await read.lines()).filter((l) => l.ledger_type === 'SETTLE_ADJUST')).toEqual([]);
      expect(await read.history()).toHaveLength(1);
      await read.balanced();

      const once = await read.money();
      await o.sync(report);
      expect(await read.money()).toEqual(once);
      expect(await o.row()).toMatchObject({
        quantity: 4,
        refunded_quantity: 1,
        commission_version: after.commission_version,
      });
    });
  },
  TIMEOUT,
);

/** One report that P10 rejects as a whole: the order row, both counts included, stays as it was. */
async function rejectedWhole(o: ReturnType<Worker['order']>, report: Patch): Promise<void> {
  const before = await o.row();
  expect(await o.report(report)).toMatchObject({ kind: 'pending', reason: 'ILLEGAL_TRANSITION' });
  expect(await o.row()).toEqual(before);
}

it(
  '[AC-B1-08zi#37] P10 倒退（RECEIVED / SETTLED 后回传 PAID，SETTLED 后回传 RECEIVED）带不同件数与已退件数：整条拒收，订单行（含两列）完全不变',
  async () => {
    await withSync(p.db, async (w) => {
      const o = w.order(await w.app(), { quantity: 3, refunded_quantity: 0 });
      await o.sync();
      await o.sync(received(touched(1)));
      expect(await o.row()).toMatchObject({
        platform_status: 'RECEIVED',
        quantity: 3,
        refunded_quantity: 0,
      });
      await rejectedWhole(o, {
        raw_status: PDD_PAID,
        ...touched(2),
        quantity: 5,
        refunded_quantity: 2,
      });

      await o.sync(settled(1000n, touched(3)));
      expect(await o.row()).toMatchObject({
        platform_status: 'SETTLED',
        quantity: 3,
        refunded_quantity: 0,
      });
      await rejectedWhole(o, {
        raw_status: PDD_PAID,
        ...touched(4),
        quantity: 4,
        refunded_quantity: 1,
      });
      await rejectedWhole(o, received({ ...touched(5), quantity: 4, refunded_quantity: 3 }));
      // 对照：同一状态（P15）的报文照写两列。
      await o.sync(settled(1000n, { ...touched(6), refunded_quantity: 1 }));
      expect(await o.row()).toMatchObject({ quantity: 3, refunded_quantity: 1 });
    });
  },
  TIMEOUT,
);

it(
  '[AC-B1-08zi#38] 已入账订单收到 P10 倒退（回传 RECEIVED）带已退件数增加：整条拒收，订单行与凭证、分录、余额都不变，不触发扣回',
  async () => {
    await withSync(p.db, async (w) => {
      const { app, o } = await creditedWith(p.db, w, { quantity: 3, refunded_quantity: 0 });
      expect(await o.row()).toMatchObject({ refunded_quantity: 0, refunded_quantity_at_credit: 0 });
      const before = await ledgerOf(app.appId);
      await rejectedWhole(o, received({ ...touched(1), quantity: 3, refunded_quantity: 2 }));
      expect(await ledgerOf(app.appId)).toEqual(before);
    });
  },
  TIMEOUT,
);

/**
 * An order brought to `status` by `setup`, then one report of the same platform status with one
 * more refunded item: counts written, status and commission version kept, no money written.
 */
async function refundBeforeCredit(
  w: Worker,
  status: 'ESTIMATED' | 'WAITING',
  setup: readonly Patch[],
  next: Patch,
): Promise<void> {
  const app = await w.app();
  const o = w.order(app, { quantity: 3, refunded_quantity: 0 });
  await o.sync();
  for (const report of setup) await o.sync(report);
  const before = await o.row();
  expect(before).toMatchObject({ rebate_status: status, quantity: 3, refunded_quantity: 0 });
  const ledgerBefore = await ledgerOf(app.appId);

  await o.sync({ ...next, refunded_quantity: 1 });

  expect(await o.row()).toMatchObject({
    rebate_status: status,
    platform_status: before.platform_status,
    quantity: 3,
    refunded_quantity: 1,
    refunded_quantity_at_credit: null,
    commission_version: before.commission_version,
    est_commission_fen: before.est_commission_fen,
    booked_base_fen: null,
    booked_n_fen: null,
  });
  expect(await ledgerOf(app.appId)).toEqual(ledgerBefore);
}

it(
  '[AC-B1-08zi#39] ESTIMATED 订单已退件数 0 → 1：只写件数，返利状态与金额版本不变，凭证、分录、余额都没有变化',
  async () => {
    await withSync(p.db, async (w) => {
      await refundBeforeCredit(w, 'ESTIMATED', [], touched(1));
    });
  },
  TIMEOUT,
);

it(
  '[AC-B1-08zi#40] WAITING 订单已退件数 0 → 1：只写件数，返利状态与金额版本不变，凭证、分录、余额都没有变化',
  async () => {
    await withSync(p.db, async (w) => {
      await refundBeforeCredit(w, 'WAITING', [received(touched(1))], received(touched(2)));
    });
  },
  TIMEOUT,
);
