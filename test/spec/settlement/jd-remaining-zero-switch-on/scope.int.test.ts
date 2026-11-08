// B2-04zzh 守卫的作用范围（任务书 §9.2 第 1 条「非京东、两列有空、剩余 > 0 → 完全照旧」；§9.4 不推算淘宝 / 拼多多数量）：
// 开关开，拼多多单两列为空（映射置空），或即使写进了 2 件退 2，入账照旧（CREDITED、凭证、order.credited、批次项
// credited），不作废、不入队 order.invalidated、不告警。同 app 一张开关关期间退完的 WAITING 京东单在自己的批次里被
// 作废：主干的入账不看数量，所以红。
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
  type SyncedOrder,
} from './kit.ts';

const p = databaseFixture(createTestDatabase);

/** R5 as on trunk: CREDITED, one R5 row, vouchers, one order.credited; no R6, no event, no alert. */
async function expectCreditedAsBefore(
  o: SyncedOrder,
  logs: readonly Record<string, unknown>[],
): Promise<void> {
  expect(await o.row()).toMatchObject({ rebate_status: 'CREDITED', reason: null });
  expect(await o.credits()).toHaveLength(1);
  expect(await o.voids()).toEqual([]);
  expect(await o.invalidated()).toEqual([]);
  expect(await o.creditedEvents()).toHaveLength(1);
  expect((await o.vouchers()).length).toBeGreaterThan(0);
  expect(await o.alerts(logs)).toEqual([]);
}

it(
  '[AC-B2-04zzh#4] 开关开：拼多多 WAITING 单（两列为 null；以及写进了 2 件退 2 的）照常入账、不作废、不告警；同 app 开关关期间退完的 WAITING 京东单在京东批次里作废',
  async () => {
    await withWorker(p.db, async (w, logs) => {
      const app = await w.app();
      const blank = await precredit(w, app, 'pdd', 'WAITING', counts(null, null));
      const refunded = await precredit(w, app, 'pdd', 'WAITING', counts(2, 2));
      const jd = await zeroed(w, app, 'WAITING');
      await w.setConfig(app, SWITCH, true);
      const pddBatch = await w.batch(app, 'pdd', [blank, refunded]);
      const jdBatch = await w.batch(app, 'jd', [jd]);

      await w.settle(pddBatch);
      await w.settle(jdBatch);

      expect(await blank.row()).toMatchObject({
        platform: 'pdd',
        quantity: null,
        refunded_quantity: null,
      });
      await expectCreditedAsBefore(blank, logs);
      await expectCreditedAsBefore(refunded, logs);
      for (const o of [blank, refunded]) {
        expect(await w.itemOf(pddBatch, o)).toMatchObject({
          result: 'credited',
          skip_reason: null,
        });
      }
      expect((await w.batchOf(pddBatch)).status).toBe('DONE');

      expect(await jd.row()).toMatchObject({ rebate_status: 'VOID', reason: 'REFUND' });
      expect(await jd.voids()).toHaveLength(1);
      expect(await jd.invalidated()).toHaveLength(1);
      expect(await jd.vouchers()).toEqual([]);
      expect(await w.itemOf(jdBatch, jd)).toMatchObject({
        result: 'skipped',
        skip_reason: SKIP_REASON,
      });
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zzh#5] 开关开：京东单剩余 > 0（3 件退 2）照常入账、不作废；同批 2 件退 2 的京东单作废（剩余 ≤ 0 才是失效条件）',
  async () => {
    await withWorker(p.db, async (w, logs) => {
      const app = await w.app();
      const left = await precredit(w, app, 'jd', 'WAITING', counts(3, 2));
      const gone = await zeroed(w, app, 'WAITING');
      await w.setConfig(app, SWITCH, true);
      const b = await w.batch(app, 'jd', [left, gone]);

      await w.settle(b);

      await expectCreditedAsBefore(left, logs);
      expect(await w.itemOf(b, left)).toMatchObject({ result: 'credited', skip_reason: null });
      expect(await gone.row()).toMatchObject({ rebate_status: 'VOID', reason: 'REFUND' });
      expect(await w.itemOf(b, gone)).toMatchObject({
        result: 'skipped',
        skip_reason: SKIP_REASON,
      });
    });
  },
  TIMEOUT,
);
