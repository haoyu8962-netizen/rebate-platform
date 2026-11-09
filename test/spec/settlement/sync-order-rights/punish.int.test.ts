// B2-04zzr rule tests, P8 punishment (claude-independent, SPEC_REF b1410c4f): BR-FUND-01 P 表 P8 / O4 /
// O9, BR-FUND-02 (处罚码映射为 PLATFORM_PUNISH, 写 order_rights type=PUNISH), BR-FUND-08 (sub_type and
// reason PUNISH), D10-1118 / D10-1124, K-2 / D10-346 (a punishment without a rights number: one row
// per order). A status code mapped to PLATFORM_PUNISH on a PAID / RECEIVED / SETTLED order leaves
// platform_status as it is and writes exactly one order_rights(PUNISH, SUCCEEDED) with no rights
// number in the same sync: credited → R8 PUNISH as today, not credited → R6 as today. A replay of the
// same report (content_hash) and a later punish report with other content write no second row and no
// second clawback. No status map has a punish code yet: the synthetic pdd code of ./status-codes.ts
// carries the event through the production worker (harness.ts). Top-level it() only.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it, vi } from 'vitest';
import {
  TIMEOUT,
  clawbacks,
  creditedOrder,
  databaseFixture,
  expectWrittenSucceeded,
  fullClawback,
  paidOrder,
  punishPaid,
  punishReceived,
  punishSettled,
  rebateColumns,
  receivedOrder,
  report,
  rightsBrief,
  waitingOrder,
  withWorker,
} from './harness.ts';
import type { StatusMapModule } from './status-codes.ts';

vi.mock('../../../../apps/api/src/modules/orders/domain/status-map.ts', async (importOriginal) =>
  (await import('./status-codes.ts')).withSyntheticCodes(await importOriginal<StatusMapModule>()),
);

const p = databaseFixture(createTestDatabase);

const PUNISH_ROW = { type: 'PUNISH', status: 'SUCCEEDED', platform_rights_no: null };

it(
  '[AC-B2-04zzr#7] P8 处罚已入账（CREDITED、SETTLED）：同一次同步写恰好一行 (PUNISH, SUCCEEDED)、无单号；R8 照旧：两张 CLAWBACK（PUNISH）各 500、键 P{row_version}、CLAWED_BACK、原因码 PUNISH、platform_status 仍 SETTLED；rights_pending 仍 false',
  async () => {
    await withWorker(p.db, async (w) => {
      const { app, o, read } = await creditedOrder(p.db, w);

      const rowVersion = await report(o, punishSettled(1));

      expect(await rightsBrief(p.db, app, o)).toEqual([PUNISH_ROW]);
      await expectWrittenSucceeded(p.db, app, o);
      expect(await clawbacks(read)).toEqual(
        fullClawback(read, app, `P${String(rowVersion)}`, 'PUNISH'),
      );
      expect(await o.row()).toMatchObject({
        rebate_status: 'CLAWED_BACK',
        platform_status: 'SETTLED',
        reason: 'PUNISH',
        booked_base_fen: 0n,
        booked_n_fen: 0n,
        rights_pending: false,
      });
      expect((await read.history()).map((row) => [row.to_status, row.event])).toEqual([
        ['CLAWED_BACK', 'PUNISH'],
      ]);
      await read.balanced();
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zzr#8] P8 处罚重放：同报文再同步（content_hash 短路）不多写；之后内容不同的又一份处罚报文（新的同步更新）仍只这一行（无单号处罚每单一条），也不出第二笔扣回、返利列不变',
  async () => {
    await withWorker(p.db, async (w) => {
      const { app, o, read } = await creditedOrder(p.db, w);
      await report(o, punishSettled(1));
      expect(await rightsBrief(p.db, app, o)).toEqual([PUNISH_ROW]);
      const lines = await clawbacks(read);
      const columns = await rebateColumns(o);

      expect(await o.report(punishSettled(1))).toMatchObject({ kind: 'unchanged' });
      expect(await rightsBrief(p.db, app, o)).toEqual([PUNISH_ROW]);
      expect(await rebateColumns(o)).toEqual(columns);

      await report(o, punishSettled(2));
      expect(await rightsBrief(p.db, app, o)).toEqual([PUNISH_ROW]);
      expect(await clawbacks(read)).toEqual(lines);
      const after = await rebateColumns(o);
      expect({ ...after, row_version: columns.row_version }).toEqual(columns);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zzr#9] P8 处罚结算前与未入账（PAID / ESTIMATED、RECEIVED、SETTLED / WAITING）：platform_status 不变，R6 照旧作废为 VOID、不写凭证；每单恰好一行 (PUNISH, SUCCEEDED)、无单号；同报文重放仍一行；rights_pending 仍 false',
  async () => {
    await withWorker(p.db, async (w) => {
      const cases = [
        { c: await paidOrder(p.db, w), patch: punishPaid(1), platform: 'PAID' },
        { c: await receivedOrder(p.db, w), patch: punishReceived(1), platform: 'RECEIVED' },
        { c: await waitingOrder(p.db, w), patch: punishSettled(1), platform: 'SETTLED' },
      ];
      for (const { c, patch, platform } of cases) {
        await report(c.o, patch);
        expect(await c.o.row(), platform).toMatchObject({
          platform_status: platform,
          rebate_status: 'VOID',
          rights_pending: false,
        });
        expect(await rightsBrief(p.db, c.app, c.o), platform).toEqual([PUNISH_ROW]);
        await expectWrittenSucceeded(p.db, c.app, c.o);
        expect(await c.read.vouchers(), platform).toEqual([]);

        expect(await c.o.report(patch), platform).toMatchObject({ kind: 'unchanged' });
        expect(await rightsBrief(p.db, c.app, c.o), platform).toEqual([PUNISH_ROW]);
      }
    });
  },
  TIMEOUT,
);
