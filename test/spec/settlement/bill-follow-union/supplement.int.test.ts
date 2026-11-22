// B2-18：补充发起经后台入口的生产装配（createHttpApp('admin') → POST /admin/v1/settle-bills/{bill_id}/
// supplement-batches，../admin-settle-commands/kit.ts）遇金额不一致，同账单日任务按 R7 以联盟结算数据重生成后再
// 校验：一致的进补充批次、不登记差错单；重生成失败的不入批、不登记差错单；补充不回写账单的计数列；工程把快照修好
// 之后再对同一账单发起补充，该单入补充批次。真实订单行与分佣快照（./kit.ts seedOrder），账单行按后台夹具。
// 顶层 it()（规划/11 §4.3）。
import { expect, it } from 'vitest';
import {
  creditSwitch,
  everything,
  fixture,
  itemsOf as batchItems,
  later,
  launched,
  seedBill,
  setSwitch,
  suite,
  withCommandsAdmin,
  type Fixture,
} from '../admin-settle-commands/kit.ts';
import {
  EXAMPLE_PEOPLE,
  TIMEOUT,
  app,
  byRole,
  diffsOf,
  engineeringVersion,
  failVersionWrite,
  itemsFor,
  orderRow,
  seedOrder,
  unionConclusion,
  versionsOf,
  type App,
  type Seeded,
} from './kit.ts';

const s = suite();
const BILL_ID = '2026-09';
const TAOBAO = { platform: 'taobao' };

/** 后台夹具应用上的订单上下文：settle_period 2026-09，订单与结算记录写在 2026-09-20 10:00 +08:00。 */
async function appOf(f: Fixture): Promise<App> {
  await setSwitch(f, creditSwitch('taobao'), true);
  await seedBill(f, BILL_ID);
  return app(f.db, {
    appId: f.appId,
    clock: f.clock,
    period: BILL_ID,
    at: new Date('2026-09-20T10:00:00+08:00'),
  });
}

function example2(a: App): Promise<Seeded> {
  return seedOrder(a, { snapshotN: 1234n, settleFen: 1100n, people: EXAMPLE_PEOPLE });
}

async function bases(a: App, o: Seeded): Promise<[number, bigint][]> {
  return (await versionsOf(a, o)).totals.map((t): [number, bigint] => [
    t.commission_version,
    t.base_fen,
  ]);
}

it(
  '[AC-B2-18#16] 后台补充（生产装配）：快照 1234、结算 1100 的单在补充事务里追加 v2（基数 1100、550 / 110，created_at 取注入 Clock）后进 kind=supplement 批次（b_settle 1100、settle_seq 1），一致单照常入批；联盟结算 0 而快照基数 1000 的不重生成、不入批；不登记差错单；账单行（含 amount_mismatch_count 等计数列）一字不回写',
  async () => {
    const f = fixture(s);
    const a = await appOf(f);
    const o = await example2(a);
    // 自拟（预留 0）：快照与结算都取 1000 → 一致；快照 1000 而结算 0 → 结算为 0、基数 > 0。
    const ok = await seedOrder(a, { snapshotN: 1000n, settleFen: 1000n, people: EXAMPLE_PEOPLE });
    const zero = await seedOrder(a, { snapshotN: 1000n, settleFen: 0n, people: EXAMPLE_PEOPLE });
    const zeroBefore = await versionsOf(a, zero);

    await withCommandsAdmin(f, async (h) => {
      const { bills } = await everything(f);
      const data = await launched(await h.supplement(BILL_ID, TAOBAO));
      expect(data.outcome).toBe('generated');
      expect(data.batch_ids).toHaveLength(1);

      expect(await diffsOf(a)).toEqual([]);
      expect(await bases(a, o)).toEqual([
        [1, 1234n],
        [2, 1100n],
      ]);
      expect((await versionsOf(a, o)).amounts.filter((r) => r.commission_version === 2)).toEqual(
        byRole([
          {
            commission_version: 2,
            user_id: o.user('self'),
            role: 'self',
            base_fen: 1100n,
            amount_fen: 550n,
            created_at: f.clock.now(),
          },
          {
            commission_version: 2,
            user_id: o.user('direct'),
            role: 'direct',
            base_fen: 1100n,
            amount_fen: 110n,
            created_at: f.clock.now(),
          },
        ]),
      );
      expect((await orderRow(a, o)).commission_version).toBe(2);
      const items = await batchItems(f, data.batch_ids);
      expect(items.map((i) => i.order_id).sort()).toEqual([o.orderId, ok.orderId].sort());
      expect(await itemsFor(a, o)).toEqual([
        expect.objectContaining({ item_type: 'order', settle_seq: 1, b_settle_fen: 1100n }),
      ]);
      expect(await itemsFor(a, ok)).toEqual([expect.objectContaining({ b_settle_fen: 1000n })]);
      expect(await versionsOf(a, zero)).toEqual(zeroBefore);
      expect(await itemsFor(a, zero)).toEqual([]);
      expect((await everything(f)).bills).toEqual(bills);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-18#17] 后台补充遇重生成抛错（库层：写该单金额版本合计行失败；该单另有一张结论「以联盟为准」的差错单）：不入批、不登记差错单、版本号与金额行原样、账单行不回写；工程按联盟结算额补好快照（v2 基数 1100、550 / 110）后再对同一账单发起 → 该单进补充批次（b_settle 1100），不再追加版本',
  async () => {
    const base = fixture(s);
    const a = await appOf(base);
    const o = await example2(a);
    await unionConclusion(a, o, 1234n, 1100n);
    const diffsBefore = await diffsOf(a);
    const versionsBefore = await versionsOf(a, o);
    const fault = failVersionWrite(base.db, [o.orderId]);
    const f: Fixture = { ...base, db: fault.db };

    await withCommandsAdmin(f, async (h) => {
      const { bills } = await everything(base);
      const first = await launched(await h.supplement(BILL_ID, TAOBAO));
      expect(first.outcome).toBe('generated');
      expect(fault.fired).toBeGreaterThanOrEqual(1);
      expect(first.batch_ids).toEqual([]);
      expect(await diffsOf(a)).toEqual(diffsBefore);
      expect(await versionsOf(a, o)).toEqual(versionsBefore);
      expect(await orderRow(a, o)).toMatchObject({
        rebate_status: 'WAITING',
        commission_version: 1,
      });
      expect((await everything(base)).bills).toEqual(bills);

      // 工程处置：按联盟结算额 1100（预留 0）补好快照——例 2 的 550 / 110。
      await engineeringVersion(a, o, 2, 1100n, [550n, 110n]);
      base.clock.set(later(base, 1));
      const second = await launched(await h.supplement(BILL_ID, TAOBAO));
      expect(second.batch_ids).toHaveLength(1);
      expect(await batchItems(base, second.batch_ids)).toEqual([
        expect.objectContaining({
          item_type: 'order',
          order_id: o.orderId,
          settle_seq: 1,
          b_settle_fen: 1100n,
        }),
      ]);
      expect(await bases(a, o)).toEqual([
        [1, 1234n],
        [2, 1100n],
      ]);
      expect(await diffsOf(a)).toEqual(diffsBefore);
    });
  },
  TIMEOUT,
);
