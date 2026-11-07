// B2-04zzi（FU-R6-VERSION-ROW，D10-931 ①、D10-932；BR-CALC-15「结算收入首次到达或变化，使有效联盟佣金与当前版本的存值
// 不同时 +1，并按新的有效联盟佣金用同一算法写该版本的金额行」「rebate_status ∈ {ESTIMATED, WAITING}（未入账）：只更新预估，
// 不写流水」「入账前 R6 → VOID」）：未入账的京东单（v1 有行）经生产同步来一条映射 PLATFORM_INVALID 的报文（京东 3），
// 同一报文预估 1000 → 0 或 → 600：R6 → VOID（reason REFUND）、commission_version 推到 2，v2 也要有按新 N 写的金额行与
// 四段金额，v1 行不动，R6 仍不写任何凭证、分录，余额不动。
// 主干的 reverse 分支推进 R6 后不重算：本文件每条在主干上都因「v2 没有金额行 / 四段金额」而红（断言失败）。
// 不在本文件：PLATFORM_PUNISH 走同一分支、一并修，但现有状态映射表（specs/order-status-map/*.csv）没有码映射到它，
// 经真实同步不可达，不硬造报文；导入即无效、从未有预估的单（P13）v1 无行，冻结的 rebate-wiring/flow.int.test.ts 已钉。
// Task-local AC labels ([AC-B2-04zzi#n]) identify this task's acceptance points, not business rules.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  JD_INVALID,
  TIMEOUT,
  databaseFixture,
  touched,
  unbooked,
  versionRows,
  withWorker,
  type App,
  type SyncedOrder,
  type Unbooked,
  type Worker,
} from './kit.ts';

const p = databaseFixture(createTestDatabase);

/** The new N of the invalid report, with the B and own share it gives (reserve 0, own 50 %). */
interface Moved {
  readonly n: bigint;
  readonly base: bigint;
  readonly own: bigint;
}

const TO_ZERO: Moved = { n: 0n, base: 0n, own: 0n };
const TO_600: Moved = { n: 600n, base: 600n, own: 300n };

/** The report that both invalidates the order (jd 3) and moves its estimate to `n`. */
function invalidMoved(minute: number, n: bigint) {
  return touched(minute, { raw_status: JD_INVALID, est_commission_fen: n, commission_fen: n });
}

/** Everything of the app and the order that must stay as it was, before the invalid report. */
async function before(w: Worker, app: App, o: SyncedOrder) {
  return {
    rows: await versionRows(p.db, app, o),
    ledger: await w.ledgerOf(app),
  };
}

/** R6 from `from`: VOID with reason REFUND, one history row, one order.invalidated naming it. */
async function expectR6(o: SyncedOrder, from: Unbooked, version: number): Promise<void> {
  const row = await o.row();
  expect(row).toMatchObject({
    platform_status: 'INVALID',
    rebate_status: 'VOID',
    reason: 'REFUND',
    commission_version: version,
    booked_base_fen: null,
    booked_n_fen: null,
  });
  expect(await o.voids()).toEqual([
    { from_status: from, event: 'PLATFORM_INVALID', to_status: 'VOID', source: 'sync' },
  ]);
  const events = await o.invalidated();
  expect(events.map((e) => e.payload['reason'])).toEqual(['REFUND']);
}

/**
 * The invalid report moved the version to 2 on `moved`: v2 has one amount row per v1 row (same
 * beneficiary, new B and share) and its four amounts; v1's rows are byte for byte as before.
 */
async function expectV2Rows(
  app: App,
  o: SyncedOrder,
  prior: Awaited<ReturnType<typeof before>>,
  moved: Moved,
): Promise<void> {
  const now = await versionRows(p.db, app, o);
  const v1 = prior.rows.amounts.filter((r) => r.commission_version === 1);
  expect(v1).toEqual([
    {
      commission_version: 1,
      user_id: app.userId,
      role: v1[0]?.role,
      base_fen: 1000n,
      amount_fen: 500n,
    },
  ]);
  const v2 = v1.map((r) => ({
    ...r,
    commission_version: 2,
    base_fen: moved.base,
    amount_fen: moved.own,
  }));
  expect(now.amounts).toEqual([...v1, ...v2]);
  const v1Totals = prior.rows.totals.filter((t) => t.commission_version === 1);
  expect(v1Totals).toHaveLength(1);
  const tlj = v1Totals[0]?.tlj_redpacket_fen ?? null;
  expect(now.totals).toEqual([
    ...v1Totals,
    {
      commission_version: 2,
      n_total_fen: moved.n,
      pre_base_deduct_fen: moved.n - moved.base,
      base_fen: moved.base,
      user_share_total_fen: moved.own,
      // refresh carries the snapshot's red packet over; the profit is N − users − red packet.
      tlj_redpacket_fen: tlj,
      platform_est_profit_fen: tlj === null ? null : moved.n - moved.own - tlj,
    },
  ]);
}

/** R6 books nothing: no voucher, no entry, no balance moved. */
async function expectNoMoney(
  w: Worker,
  app: App,
  prior: Awaited<ReturnType<typeof before>>,
): Promise<void> {
  const ledger = await w.ledgerOf(app);
  expect(ledger.vouchers).toEqual([]);
  expect(ledger.entries).toEqual([]);
  expect(ledger).toEqual(prior.ledger);
}

async function voidMoved(status: Unbooked, moved: Moved): Promise<void> {
  await withWorker(p.db, async (w) => {
    const app = await w.app();
    const o = await unbooked(w, app, status);
    const prior = await before(w, app, o);
    expect(prior.rows.totals.map((t) => t.commission_version)).toEqual([1]);

    await o.sync(invalidMoved(5, moved.n));

    expect(await o.row()).toMatchObject({ est_commission_fen: moved.n });
    await expectR6(o, status, 2);
    await expectNoMoney(w, app, prior);
    await expectV2Rows(app, o, prior, moved);
  });
}

it(
  '[AC-B2-04zzi#1][BR-CALC-15] ESTIMATED 京东单同一报文转无效（京东 3）且预估 1000 → 0：R6 → VOID（REFUND），commission_version 2，v2 金额行 0 / 0 与四段金额按 N 0 写出，v1 行不动，无凭证、无分录、余额不动',
  async () => {
    await voidMoved('ESTIMATED', TO_ZERO);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zzi#2][BR-CALC-15] ESTIMATED 京东单同一报文转无效且预估 1000 → 600：R6 → VOID（REFUND），commission_version 2，v2 金额行 600 / 300 与四段金额按 N 600 写出，v1 行不动，无凭证、无分录、余额不动',
  async () => {
    await voidMoved('ESTIMATED', TO_600);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zzi#3][BR-CALC-15] WAITING 京东单（已收货）同一报文转无效且预估 1000 → 0：R6 → VOID（REFUND），commission_version 2，v2 金额行 0 / 0 与四段金额，v1 行不动，无凭证、无分录、余额不动',
  async () => {
    await voidMoved('WAITING', TO_ZERO);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zzi#4][BR-CALC-15] WAITING 京东单（已收货）同一报文转无效且预估 1000 → 600：R6 → VOID（REFUND），commission_version 2，v2 金额行 600 / 300 与四段金额，v1 行不动，无凭证、无分录、余额不动',
  async () => {
    await voidMoved('WAITING', TO_600);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zzi#5][BR-CALC-15] 对照：同 app 同一无效报文、预估不变的单仍是 v1、不多写版本与金额行；预估 1000 → 600 的单才推到 v2 并有 v2 金额行',
  async () => {
    await withWorker(p.db, async (w) => {
      const app = await w.app();
      const still = await unbooked(w, app, 'ESTIMATED');
      const moved = await unbooked(w, app, 'ESTIMATED');
      const stillPrior = await before(w, app, still);
      const movedPrior = await before(w, app, moved);

      await still.sync(touched(5, { raw_status: JD_INVALID }));
      await moved.sync(invalidMoved(6, TO_600.n));

      expect(await still.row()).toMatchObject({ est_commission_fen: 1000n });
      await expectR6(still, 'ESTIMATED', 1);
      expect(await versionRows(p.db, app, still)).toEqual(stillPrior.rows);

      await expectR6(moved, 'ESTIMATED', 2);
      await expectNoMoney(w, app, movedPrior);
      await expectV2Rows(app, moved, movedPrior, TO_600);
    });
  },
  TIMEOUT,
);
