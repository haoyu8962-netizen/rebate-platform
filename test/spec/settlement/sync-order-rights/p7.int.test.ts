// B2-04zzr rule tests, P7 (claude-independent, SPEC_REF b1410c4f): BR-FUND-01 P 表 P7 / O9, BR-FUND-08
// (event key P{row_version}), D10-1118 / D10-1124 / D10-1133 ①. A SETTLED order reported invalid keeps
// platform_status SETTLED; the same sync writes exactly one order_rights(INVALID_AFTER_SETTLE,
// SUCCEEDED) whose platform_rights_no is 'P' || the row_version of that sync update, whatever the
// rebate status (credited → R8 as today; not credited → R6 as today; already CLAWED_BACK / VOID →
// nothing else). A replay of the same report is short-circuited by content_hash and writes nothing;
// a new invalid report after a restore is a new event and a new row. A pre-settlement invalid (P6)
// writes no such row. Everything goes through the production worker (harness.ts); expected values by
// hand. Top-level it() only.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it, vi } from 'vitest';
import {
  TIMEOUT,
  clawbacks,
  creditedOrder,
  databaseFixture,
  expectWrittenSucceeded,
  fullClawback,
  invalidAfterSettle,
  invalidBeforeSettle,
  paidOrder,
  punishPaid,
  punishSettled,
  rebateColumns,
  report,
  restoredByHand,
  rightsBrief,
  waitingOrder,
  withWorker,
} from './harness.ts';
import type { StatusMapModule } from './status-codes.ts';

vi.mock('../../../../apps/api/src/modules/orders/domain/status-map.ts', async (importOriginal) =>
  (await import('./status-codes.ts')).withSyntheticCodes(await importOriginal<StatusMapModule>()),
);

const p = databaseFixture(createTestDatabase);

const P7_ROW = (rowVersion: number) => ({
  type: 'INVALID_AFTER_SETTLE',
  status: 'SUCCEEDED',
  platform_rights_no: `P${String(rowVersion)}`,
});

it(
  '[AC-B2-04zzr#1] P7 已入账（CREDITED、SETTLED）：同一次同步写恰好一行 order_rights(INVALID_AFTER_SETTLE, SUCCEEDED)，platform_rights_no = P{这次同步更新写入的 row_version}，与 R8 扣回键同值（R8 后的 row_version 不是键）；R8 照旧：两张 CLAWBACK（FULL）各 500、CLAWED_BACK、原因码 REFUND、platform_status 仍 SETTLED；不因这一行多出第二笔扣回；rights_pending 仍 false',
  async () => {
    await withWorker(p.db, async (w) => {
      const { app, o, read } = await creditedOrder(p.db, w);

      const rowVersion = await report(o, invalidAfterSettle(1));
      const event = `P${String(rowVersion)}`;

      expect(await rightsBrief(p.db, app, o)).toEqual([P7_ROW(rowVersion)]);
      await expectWrittenSucceeded(p.db, app, o);
      expect(await clawbacks(read)).toEqual(fullClawback(read, app, event, 'FULL'));
      expect(await o.row()).toMatchObject({
        rebate_status: 'CLAWED_BACK',
        platform_status: 'SETTLED',
        reason: 'REFUND',
        booked_base_fen: 0n,
        booked_n_fen: 0n,
        rights_pending: false,
        row_version: rowVersion + 1,
      });
      expect((await read.history()).map((row) => [row.to_status, row.event])).toEqual([
        ['CLAWED_BACK', 'INVALID_AFTER_SETTLE'],
      ]);
      expect(await read.balance()).toEqual({ available_fen: 0n, frozen_fen: 0n });
      await read.balanced();
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zzr#2] P7 已入账的重放：同一报文再同步一次、再投递一次都被 content_hash 短路（unchanged）→ order_rights 仍恰好一行（同一单号），扣回凭证仍只一笔，订单列不变',
  async () => {
    await withWorker(p.db, async (w) => {
      const { app, o, read } = await creditedOrder(p.db, w);
      const rowVersion = await report(o, invalidAfterSettle(1));
      expect(await rightsBrief(p.db, app, o)).toEqual([P7_ROW(rowVersion)]);
      const rows = await rightsBrief(p.db, app, o);
      const lines = await clawbacks(read);
      const order = await rebateColumns(o);

      expect(await o.report(invalidAfterSettle(1))).toMatchObject({ kind: 'unchanged' });
      expect(await o.report(invalidAfterSettle(1))).toMatchObject({ kind: 'unchanged' });

      expect(await rightsBrief(p.db, app, o)).toEqual(rows);
      expect(await clawbacks(read)).toEqual(lines);
      expect(await clawbacks(read)).toEqual(
        fullClawback(read, app, `P${String(rowVersion)}`, 'FULL'),
      );
      expect(await rebateColumns(o)).toEqual(order);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zzr#3] P7 未入账（WAITING、SETTLED）：R6 照旧作废为 VOID、不写凭证；同一次同步写恰好一行 (INVALID_AFTER_SETTLE, SUCCEEDED, P{row_version})；同报文重放（content_hash 短路）仍一行；rights_pending 仍 false',
  async () => {
    await withWorker(p.db, async (w) => {
      const { app, o, read } = await waitingOrder(p.db, w);

      const rowVersion = await report(o, invalidAfterSettle(1));

      expect(await rightsBrief(p.db, app, o)).toEqual([P7_ROW(rowVersion)]);
      await expectWrittenSucceeded(p.db, app, o);
      expect(await o.row()).toMatchObject({
        rebate_status: 'VOID',
        platform_status: 'SETTLED',
        rights_pending: false,
      });
      expect(await read.vouchers()).toEqual([]);

      expect(await o.report(invalidAfterSettle(1))).toMatchObject({ kind: 'unchanged' });
      expect(await rightsBrief(p.db, app, o)).toEqual([P7_ROW(rowVersion)]);
      expect(await read.vouchers()).toEqual([]);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zzr#4] 订单已是 CLAWED_BACK（入账后被处罚扣回）或 VOID（入账前被处罚作废）时再来 P7：照旧不再扣回、不再作废、返利列不变，但 (INVALID_AFTER_SETTLE, SUCCEEDED, P{row_version}) 这一行照写',
  async () => {
    await withWorker(p.db, async (w) => {
      const clawed = await creditedOrder(p.db, w);
      await report(clawed.o, punishSettled(1));
      expect(await clawed.o.row()).toMatchObject({
        rebate_status: 'CLAWED_BACK',
        reason: 'PUNISH',
      });
      const clawedLines = await clawbacks(clawed.read);
      const clawedBefore = await clawed.o.row();

      const voided = await waitingOrder(p.db, w);
      await report(voided.o, punishSettled(1));
      expect(await voided.o.row()).toMatchObject({ rebate_status: 'VOID' });
      const voidedBefore = await voided.o.row();

      const clawedVersion = await report(clawed.o, invalidAfterSettle(2));
      const voidedVersion = await report(voided.o, invalidAfterSettle(2));

      for (const [c, before, rowVersion] of [
        [clawed, clawedBefore, clawedVersion],
        [voided, voidedBefore, voidedVersion],
      ] as const) {
        const rows = await rightsBrief(p.db, c.app, c.o);
        expect(rows.filter((row) => row.type === 'INVALID_AFTER_SETTLE')).toEqual([
          P7_ROW(rowVersion),
        ]);
        const after = await c.o.row();
        expect({
          rebate_status: after.rebate_status,
          reason: after.reason,
          booked_base_fen: after.booked_base_fen,
          booked_n_fen: after.booked_n_fen,
          rights_pending: after.rights_pending,
        }).toEqual({
          rebate_status: before.rebate_status,
          reason: before.reason,
          booked_base_fen: before.booked_base_fen,
          booked_n_fen: before.booked_n_fen,
          rights_pending: false,
        });
      }
      expect(await clawbacks(clawed.read)).toEqual(clawedLines);
      expect(await voided.read.vouchers()).toEqual([]);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zzr#5] 恢复后再次失效：P7（未入账 → VOID，第一行 P{v1}）→ 平台恢复 R12（VOID → WAITING）→ 平台又一次失效（新的同步更新、新的 row_version v2）→ 新写第二行 P{v2}，两行并存、单号不同；订单再次 VOID',
  async () => {
    await withWorker(p.db, async (w) => {
      const { app, o } = await waitingOrder(p.db, w);
      const first = await report(o, invalidAfterSettle(1));
      expect(await rightsBrief(p.db, app, o)).toEqual([P7_ROW(first)]);

      await restoredByHand(p.db, w, app, o);
      const second = await report(o, invalidAfterSettle(2));

      expect(second).toBeGreaterThan(first);
      expect(await rightsBrief(p.db, app, o)).toEqual([P7_ROW(first), P7_ROW(second)]);
      await expectWrittenSucceeded(p.db, app, o);
      expect(await o.row()).toMatchObject({ rebate_status: 'VOID', rights_pending: false });
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zzr#6] 结算前失效（P6：PAID → INVALID）不写 INVALID_AFTER_SETTLE 行（R6 照旧作废）；对照：结算前的处罚（P8，PAID）写恰好一行 (PUNISH, SUCCEEDED)；rights_pending 仍 false',
  async () => {
    await withWorker(p.db, async (w) => {
      const invalid = await paidOrder(p.db, w);
      await report(invalid.o, invalidBeforeSettle(1));
      expect(await invalid.o.row()).toMatchObject({
        platform_status: 'INVALID',
        rebate_status: 'VOID',
        rights_pending: false,
      });
      expect(
        (await rightsBrief(p.db, invalid.app, invalid.o)).filter(
          (row) => row.type === 'INVALID_AFTER_SETTLE',
        ),
      ).toEqual([]);

      const punished = await paidOrder(p.db, w);
      await report(punished.o, punishPaid(1));
      expect(await punished.o.row()).toMatchObject({
        platform_status: 'PAID',
        rebate_status: 'VOID',
        rights_pending: false,
      });
      expect(await rightsBrief(p.db, punished.app, punished.o)).toEqual([
        { type: 'PUNISH', status: 'SUCCEEDED', platform_rights_no: null },
      ]);
    });
  },
  TIMEOUT,
);
