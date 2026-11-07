// B2-04zzg 的作用范围（编排 9.2 第 2 条、D10-864 ②）：只对 platform jd；拼多多（淘宝同理：两列由映射置空）即使同步
// 写进了数量、开关开也不作废、不告警。已入账（CREDITED）单不走本路（入账后的已退件数归 B1-08zi 的 R9 开关）；VOID
// 等终态不再动，不写第二条 order.invalidated。开关按 app 读：一个 app 开了不影响另一个 app。
// 每条都带同 app（或开关开的 app）里一张未入账京东单作废的正向断言：主干不看数量，所以红。
// Task-local AC labels ([AC-B2-04zzg#n]) identify this task's acceptance points, not business rules.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  JD_INVALID,
  SWITCH,
  TIMEOUT,
  counts,
  databaseFixture,
  precredit,
  touched,
  withWorker,
  type SyncedOrder,
} from './kit.ts';

const p = databaseFixture(createTestDatabase);

/** VOID by R6 with reason REFUND and exactly one order.invalidated (reason REFUND). */
async function expectRemainingZeroVoid(o: SyncedOrder, from: string): Promise<void> {
  expect(await o.row()).toMatchObject({ rebate_status: 'VOID', reason: 'REFUND' });
  expect(await o.voids()).toEqual([
    { from_status: from, event: 'PLATFORM_INVALID', to_status: 'VOID', source: 'sync' },
  ]);
  expect((await o.invalidated()).map((e) => e.payload['reason'])).toEqual(['REFUND']);
}

it.each(['ESTIMATED', 'WAITING'] as const)(
  '[AC-B2-04zzg#11] 开关开：拼多多 %s 单同步写进件数 2、已退 2 也不作废、不入队、不告警；同 app 的京东单同样报文作废',
  async (status) => {
    await withWorker(p.db, async (w, logs) => {
      const app = await w.app();
      await w.setConfig(app, SWITCH, true);
      const pdd = await precredit(w, app, 'pdd', status);
      const jd = await precredit(w, app, 'jd', status);
      const pddBefore = await pdd.row();
      const ledger = await w.ledgerOf(app);

      await pdd.sync(touched(5, counts(2, 2)));
      await jd.sync(touched(6, counts(2, 2)));

      expect(await pdd.row()).toMatchObject({
        platform: 'pdd',
        rebate_status: status,
        reason: null,
        quantity: 2,
        refunded_quantity: 2,
        commission_version: pddBefore.commission_version,
      });
      expect(await pdd.voids()).toEqual([]);
      expect(await pdd.invalidated()).toEqual([]);
      expect(await pdd.alerts(logs)).toEqual([]);
      expect(await w.ledgerOf(app)).toEqual(ledger);
      await expectRemainingZeroVoid(jd, status);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zzg#12] 开关关时退完而照常入账的京东单：开关打开后再同步（数量不变）仍是 CREDITED，booked 不变，不作废、不入队、不告警；同 app 未入账京东单作废',
  async () => {
    await withWorker(p.db, async (w, logs) => {
      const app = await w.app();
      const credited = await precredit(w, app, 'jd', 'WAITING');
      await credited.sync(touched(5, counts(2, 2)));
      expect(await credited.row()).toMatchObject({
        rebate_status: 'WAITING',
        refunded_quantity: 2,
      });
      await credited.credited(2);
      const before = await credited.row();
      const alertsBefore = (await credited.alerts(logs)).length;
      const waiting = await precredit(w, app, 'jd', 'WAITING');
      await w.setConfig(app, SWITCH, true);
      const ledger = await w.ledgerOf(app);

      await credited.sync(touched(6, counts(2, 2)));
      await waiting.sync(touched(7, counts(2, 2)));

      expect(await credited.row()).toMatchObject({
        rebate_status: 'CREDITED',
        reason: null,
        booked_base_fen: before.booked_base_fen,
        booked_n_fen: before.booked_n_fen,
        refunded_quantity: 2,
        refunded_quantity_at_credit: 2,
        commission_version: before.commission_version,
      });
      expect(await credited.voids()).toEqual([]);
      expect(await credited.invalidated()).toEqual([]);
      expect(await credited.alerts(logs)).toHaveLength(alertsBefore);
      expect(await w.ledgerOf(app)).toEqual(ledger);
      await expectRemainingZeroVoid(waiting, 'WAITING');
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zzg#13] 开关开：平台已判无效而 VOID 的京东单之后退完：仍是 VOID（原因不改），不写第二条 order.invalidated；同 app 未入账京东单作废',
  async () => {
    await withWorker(p.db, async (w) => {
      const app = await w.app();
      await w.setConfig(app, SWITCH, true);
      const voided = await precredit(w, app, 'jd', 'ESTIMATED');
      await voided.sync(touched(5, { raw_status: JD_INVALID }));
      expect(await voided.row()).toMatchObject({ rebate_status: 'VOID', reason: 'REFUND' });
      const history = await voided.history();
      expect(await voided.invalidated()).toHaveLength(1);
      const estimated = await precredit(w, app, 'jd', 'ESTIMATED');

      await voided.sync(touched(6, { raw_status: JD_INVALID, ...counts(2, 2) }));
      await estimated.sync(touched(7, counts(2, 2)));

      expect(await voided.row()).toMatchObject({
        rebate_status: 'VOID',
        reason: 'REFUND',
        refunded_quantity: 2,
      });
      expect(await voided.history()).toEqual(history);
      expect(await voided.invalidated()).toHaveLength(1);
      await expectRemainingZeroVoid(estimated, 'ESTIMATED');
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zzg#14] app 隔离：只有 app A 开了开关；A、B 各一张京东单同样退完 → A 作废、B 不变且只在 B 告警；A 不告警，事件只进 A',
  async () => {
    await withWorker(p.db, async (w, logs) => {
      const a = await w.app();
      const b = await w.app();
      await w.setConfig(a, SWITCH, true);
      const inA = await precredit(w, a, 'jd', 'ESTIMATED');
      const inB = await precredit(w, b, 'jd', 'ESTIMATED');

      await inA.sync(touched(5, counts(2, 2)));
      await inB.sync(touched(6, counts(2, 2)));

      await expectRemainingZeroVoid(inA, 'ESTIMATED');
      expect(await inA.alerts(logs)).toEqual([]);
      expect(await inB.row()).toMatchObject({
        rebate_status: 'ESTIMATED',
        reason: null,
        refunded_quantity: 2,
      });
      expect(await inB.voids()).toEqual([]);
      expect((await w.eventsOf(b)).filter((e) => e.name === 'order.invalidated')).toEqual([]);
      const alerts = await inB.alerts(logs);
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toMatchObject({ app_id: b.appId });
    });
  },
  TIMEOUT,
);
