// B2-18：重生成与出账同一事务、幂等与并发（生产装配的 settle 处理器）。出账在写账单计数时故障 → 重生成的版本
// 随之回滚，同键重投递只生成一个新版本；两个运行器并发同键只出一份；账单日任务与订单同步同时动同一单——不出现
// 重复版本号、不丢订单同步的更新、批次明细不以旧快照入批。顶层 it()（规划/11 §4.3）。
//
// 写法（第 2 次写测）：worker 回调里只投递与取数，断言都在用例体里；并发与屏障的等待一律有界（kit within /
// lockWaitOrDone，WAIT_MS），等不到时落到断言失败，不跑满用例超时。运行器跑在多连接池上（kit Pools 的注释）。
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { lockOrderKey } from '../../../../apps/api/src/modules/orders/index.ts';
import { failAfterCountWrite } from '../bill-unsettled-count/kit.ts';
import {
  EXAMPLE_PEOPLE,
  TIMEOUT,
  alertsFor,
  app,
  batchesOf,
  countsOf,
  creditOn,
  databaseFixture,
  diffsOf,
  errorText,
  itemsFor,
  lockWaitOrDone,
  orderRow,
  seedOrder,
  settleJobsOf,
  tracked,
  versionsOf,
  withWorker,
  within,
  type App,
  type LogLine,
  type Outcome,
  type Seeded,
} from './kit.ts';

const pools = databaseFixture(createTestDatabase);

function example2(a: App): Promise<Seeded> {
  return seedOrder(a, { snapshotN: 1234n, settleFen: 1100n, people: EXAMPLE_PEOPLE });
}

async function bases(a: App, o: Seeded): Promise<[number, bigint][]> {
  return (await versionsOf(a, o)).totals.map((t): [number, bigint] => [
    t.commission_version,
    t.base_fen,
  ]);
}

/** 一次投递的结果（'ok' 或错误文字）。 */
function shown(outcome: Outcome<unknown> | undefined): string {
  if (outcome === undefined) return 'not run';
  return outcome.ok ? 'ok' : errorText(outcome.error);
}

it(
  '[AC-B2-18#13] 出账事务在写账单计数时故障：整体回滚，重生成的版本与 orders.commission_version 一起回到原样、无批次、任务行不是 done；同键重投递经 RETRY 只生成一个新版本 v2 并入批；再投递是重放，不产生 v3',
  async () => {
    const a = await app(pools.db);
    await creditOn(a);
    const o = await example2(a);
    const before = await versionsOf(a, o);
    const fault = failAfterCountWrite(a.db);

    // 取数（不断言）：一次投递之后该单的版本、指针、明细与本应用的批次数。
    const probe = async (outcome: Outcome<void>) => ({
      outcome: shown(outcome),
      bases: await bases(a, o),
      version: (await orderRow(a, o)).commission_version,
      items: await itemsFor(a, o),
      batches: (await batchesOf(a)).length,
    });
    type Probe = Awaited<ReturnType<typeof probe>>;

    const faulted: { outcome?: Outcome<void> } = {};
    await withWorker(
      a,
      async (w) => {
        faulted.outcome = await within(w.bill(), 'faulted bill');
      },
      { db: fault.db },
    );
    expect(faulted.outcome?.ok).toBe(false);
    expect(shown(faulted.outcome)).toContain('injected count write failure');
    expect(fault.fired).toBe(1);
    expect(await versionsOf(a, o)).toEqual(before);
    expect((await orderRow(a, o)).commission_version).toBe(1);
    expect(await batchesOf(a)).toEqual([]);
    expect((await settleJobsOf(a)).every((j) => j.status !== 'done')).toBe(true);

    const seen: { retried?: Probe; replayed?: Probe } = {};
    await withWorker(a, async (w) => {
      seen.retried = await probe(await within(w.bill(), 'retried bill'));
      seen.replayed = await probe(await within(w.bill(), 'replayed bill'));
    });

    // 重投递：只生成 v2（基数 1100），指针指向它，按 1100 入一个主批次。
    expect(seen.retried).toEqual({
      outcome: 'ok',
      bases: [
        [1, 1234n],
        [2, 1100n],
      ],
      version: 2,
      items: [expect.objectContaining({ settle_seq: 1, b_settle_fen: 1100n })],
      batches: 1,
    });
    // 再投递是重放：不产生 v3、不出第二个批次。
    expect(seen.replayed).toEqual({
      outcome: 'ok',
      bases: [
        [1, 1234n],
        [2, 1100n],
      ],
      version: 2,
      items: [expect.objectContaining({ settle_seq: 1, b_settle_fen: 1100n })],
      batches: 1,
    });
    expect((await settleJobsOf(a)).map((j) => j.status)).toEqual(['done']);
    expect(await diffsOf(a)).toEqual([]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-18#14] 两个运行器（两个独立连接池上的两个 worker）并发投递同一 bill：两次都不报错，只出一份——一个主批次、该单只有一个新版本 v2、settle_jobs 一行 done、amount_mismatch_count 0',
  async () => {
    const a = await app(pools.db);
    await creditOn(a);
    const o = await example2(a);

    const runs: { results?: readonly Outcome<void>[] } = {};
    await withWorker(
      a,
      async (left) => {
        await withWorker(
          a,
          async (right) => {
            runs.results = await Promise.all([
              within(left.bill(), 'left bill'),
              within(right.bill(), 'right bill'),
            ]);
          },
          { db: pools.workerRight },
        );
      },
      { db: pools.workerLeft },
    );

    expect((runs.results ?? []).map((r) => shown(r))).toEqual(['ok', 'ok']);
    expect(await bases(a, o)).toEqual([
      [1, 1234n],
      [2, 1100n],
    ]);
    expect(await batchesOf(a)).toHaveLength(1);
    expect(await itemsFor(a, o)).toEqual([expect.objectContaining({ b_settle_fen: 1100n })]);
    expect((await settleJobsOf(a)).map((j) => j.status)).toEqual(['done']);
    expect(await countsOf(a)).toEqual({
      error_count: 0,
      held_count: 0,
      unsettled_count: 0,
      amount_mismatch_count: 0,
    });
    expect(await diffsOf(a)).toEqual([]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-18#15] 账单日任务与订单同步同时动同一单：订单同步持订单键锁与订单行锁、已把预估改为 1500 并按联盟结算额写好 v2（基数 1100、550 / 110）而未提交时出账 → 提交后出账完成；版本号连续不重复、orders.commission_version 指向最大版本、预估 1500 不丢；入批的话 b_settle 等于当前版本基数 1100，否则按重生成失败告警并计数；不登记差错单',
  async () => {
    const a = await app(pools.db);
    await creditOn(a);
    const o = await example2(a);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let onLocked!: () => void;
    const locked = new Promise<void>((resolve) => {
      onLocked = resolve;
    });

    // 库层屏障：订单同步的事务拿到订单键锁与订单行锁、写完 v2 后停在 gate 上（未提交）。
    const sync = pools.left.transaction().execute(async (trx) => {
      await lockOrderKey(trx, o.platform, o.subOrderId);
      const row = await trx
        .selectFrom('orders')
        .selectAll()
        .where('app_id', '=', a.appId)
        .where('order_id', '=', o.orderId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const version = row.commission_version + 1;
      await trx
        .updateTable('orders')
        .set({
          est_commission_fen: 1500n,
          commission_version: version,
          row_version: row.row_version + 1,
          updated_at: a.clock.now(),
        })
        .where('app_id', '=', a.appId)
        .where('order_id', '=', o.orderId)
        .execute();
      // WAITING 且已有结算额的单，R7 估值取结算额（结算优先）：N 1100、预留 0 → 基数 1100、550 / 110（例 2）。
      await trx
        .insertInto('commission_split_amounts')
        .values(
          o.people.map((p) => ({
            app_id: a.appId,
            order_id: o.orderId,
            commission_version: version,
            user_id: p.userId,
            role: p.role,
            base_fen: 1100n,
            amount_fen: p.role === 'self' ? 550n : 110n,
            created_at: a.clock.now(),
          })),
        )
        .execute();
      await trx
        .insertInto('commission_split_totals')
        .values({
          app_id: a.appId,
          order_id: o.orderId,
          commission_version: version,
          n_total_fen: 1100n,
          pre_base_deduct_fen: 0n,
          base_fen: 1100n,
          user_share_total_fen: 660n,
          tlj_redpacket_fen: 0n,
          platform_est_profit_fen: 440n,
          subsidy_commission_fen: 0n,
          created_at: a.clock.now(),
        })
        .execute();
      onLocked();
      await gate;
    });
    // 有界：订单同步停在屏障上（或它自己失败了），不无限等。
    const ready = await within(Promise.race([locked, sync]), 'order sync holding its locks');

    let lines: LogLine[] = [];
    const running = withWorker(
      a,
      async (w) => {
        lines = w.lines;
        await w.bill();
      },
      { db: pools.workerRight },
    );
    const bill = tracked(running);
    // 有界：出账在订单同步的锁上等（'lock'），或没等就跑完了（'done'）；都没有的到上限（'timeout'）。
    const observed = await lockWaitOrDone(pools.control, 1, () => bill.settled);
    release();
    const synced = await within(sync, 'order sync');
    const billed = await within(running, 'bill run');

    expect(shown(ready)).toBe('ok');
    expect(shown(synced)).toBe('ok');
    expect(observed).not.toBe('timeout');
    expect(shown(billed)).toBe('ok');

    expect(await diffsOf(a)).toEqual([]);
    const versions = (await bases(a, o)).map(([v]) => v);
    expect(versions.length).toBeGreaterThanOrEqual(2);
    expect(versions).toEqual(versions.map((_v, i) => i + 1));
    const row = await orderRow(a, o);
    expect(row.commission_version).toBe(versions[versions.length - 1]);
    expect(row.est_commission_fen).toBe(1500n);
    expect(row.rebate_status).toBe('WAITING');
    const latest = (await bases(a, o))[versions.length - 1]!;
    expect(latest[1]).toBe(1100n);
    const items = await itemsFor(a, o);
    const counts = await countsOf(a);
    if (items.length > 0) {
      expect(items).toEqual([expect.objectContaining({ settle_seq: 1, b_settle_fen: latest[1] })]);
      expect(counts.amount_mismatch_count).toBe(0);
    } else {
      expect(counts.amount_mismatch_count).toBe(1);
      expect(alertsFor(lines, o)).toHaveLength(1);
    }
    expect(counts.error_count).toBe(0);
    expect((await settleJobsOf(a)).map((j) => j.status)).toEqual(['done']);
  },
  TIMEOUT,
);
