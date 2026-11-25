// B2-18 第 9 次写测（任务书 §17.1；08 BR-FUND-04 ④ 与细则「一次出账的重生成上限」，SPEC_REF 1025764be5af，编排
// D10-2982 / D10-2987 / D10-2988 / D10-3045 / D10-3046）：一次出账（月结账单日任务或一次补充）里，重生成成功、订单键锁
// 留到事务提交的子订单最多 500 张（技术常量，不进配置；只供测试注入 BillJobDependencies.regenerationCap）。名额只数
// 重生成成功的；金额本来相符的不取锁、不占名额；重生成失败或重生成后仍不一致的回滚放锁、照旧告警、不占名额；取锁后
// 重读即相符或已不是候选的回滚放锁、不占名额；名额满了之后本来要去重生成的单（含版本刚被别的事务推进、取锁前无从判断
// 金额的）本轮不重算、不取锁、不入批、不登记差错单、不告警、保持 WAITING、不进逐单结果、不改账单计数；本次留下的张数
// 只打一条 warn 日志 settle_regeneration_deferred（app_id、bill_id、platform、run、deferred_count；不带订单号与 alert），
// 留下 0 张不打；下一次对同一账单发起补充接着处理。
//
// 直接组装（./kit.ts directAssembly：生产 readSource、commission / ledger 的真实端口）；重生成端口是 kit
// refreshRegeneration（把 orders.commission_version 推到 +1、由 commission 真实的 refresh 按联盟结算佣金写这一版）。
// 处理顺序 = 来源读口的返回顺序，生产来源读口按订单键升序：本文件的子订单号都是 `{tag}-{两位序号}-{标签}`，序号即顺序。
// 顶层 it()（规划/11 §4.3）；等待一律有界（kit within / WAIT_MS）。
//
// 金额（自拟，预留 0、淘礼金 0）：相符单快照 N 1000、联盟结算 1000 → B_settle = floor(1000 × 10000 / 10000) − 0 = 1000
// = 基数 1000；其余单快照 N 1200（v1 基数 1200）、联盟结算 1000 → B_settle 1000 ≠ 1200，超出容差 0，要重生成；重生成后
// v2 基数 1000，自购 5000bp、直推 1000bp → 1000 × 5000 / 10000 = 500、1000 × 1000 / 10000 = 100（与 splitCommission
// 对同一输入的结果比，kit splitOf）。
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { addFen } from '@couli/money';
import { expect, it } from 'vitest';
import { createBillJob } from '../../../../apps/api/src/modules/settlement/bill/index.ts';
import { createSupplementCommand } from '../../../../apps/api/src/modules/settlement/bill/supplement/command.ts';
import { legacyBill } from '../bill-unsettled-count/kit.ts';
import {
  BILL_RUN_AT,
  EXAMPLE_PEOPLE,
  TAOBAO,
  TIMEOUT,
  WARN_LEVEL,
  admin,
  alertsFor,
  allAlerts,
  amountsAt,
  app,
  basesOf,
  batchesOf,
  billRow,
  byRole,
  countsOf,
  databaseFixture,
  deferredSummary,
  diffsOf,
  directAssembly,
  errorText,
  expectAlertShape,
  holdBy,
  itemsFor,
  itemsOf,
  orderKeyFree,
  orderKeyLocks,
  orderRow,
  placedIn,
  pushVersionToUnion,
  refreshRegeneration,
  seedMany,
  seedOrder,
  settleJobsOf,
  splitOf,
  traceStatements,
  versionRows,
  versionsOf,
  within,
  type App,
  type Direct,
  type Outcome,
  type Seeded,
} from './kit.ts';

const pools = databaseFixture(createTestDatabase);

/** 一次运行的结果（'ok' 或错误文字）。 */
function shown(outcome: Outcome<unknown> | undefined): string {
  if (outcome === undefined) return 'not run';
  return outcome.ok ? 'ok' : errorText(outcome.error);
}

/** 子订单号生成器：`{tag}-{两位序号}-{标签}`，同一 tag 下订单键升序 = 序号顺序。 */
function keys(): (index: number, label: string) => string {
  const tag = `bfu-cap-${randomUUID()}`;
  return (index, label) => `${tag}-${String(index).padStart(2, '0')}-${label}`;
}

/** 自拟：快照 1200、联盟结算 1000 → 要重生成（见文件头）。 */
function mismatching(a: App, subOrderId: string): Promise<Seeded> {
  return seedOrder(a, { snapshotN: 1200n, settleFen: 1000n, people: EXAMPLE_PEOPLE, subOrderId });
}

interface Scene {
  /** 序号 00：金额相符（1000 / 1000）。 */
  readonly matching: Seeded;
  /** 序号 01：重生成端口对它抛错（重生成失败）。 */
  readonly failing: Seeded;
  /** 序号 02 起：重生成会成功。 */
  readonly regenerable: readonly Seeded[];
}

/** 来源顺序：相符 1 张、重生成失败 1 张、重生成会成功的 n 张。 */
async function scene(a: App, n: number): Promise<Scene> {
  const key = keys();
  const matching = await seedOrder(a, {
    snapshotN: 1000n,
    settleFen: 1000n,
    people: EXAMPLE_PEOPLE,
    subOrderId: key(0, 'match'),
  });
  const failing = await mismatching(a, key(1, 'fail'));
  const regenerable: Seeded[] = [];
  for (let i = 0; i < n; i += 1) regenerable.push(await mismatching(a, key(2 + i, 'regen')));
  return { matching, failing, regenerable };
}

function all(s: Scene): Seeded[] {
  return [s.matching, s.failing, ...s.regenerable];
}

/** 逐单结果：orderId → result（本组依赖上收到的全部）。 */
function resultsOf(d: Direct): Map<string | null, string> {
  return new Map(d.saved.map((v) => [v.orderId, v.result]));
}

/** 直接组装的账单日任务跑一次（async：组装时抛的错也落成 rejection）。 */
async function billOnce(a: App, d: Direct, db: App['db']) {
  return createBillJob(d.deps).run(db, { appId: a.appId, platform: TAOBAO, runAt: BILL_RUN_AT });
}

/** 直接组装的补充命令 launch 一次（名义时刻 = Clock）。 */
async function supplementOnce(a: App, d: Direct, db: App['db']) {
  return createSupplementCommand(d.deps).launch(db, {
    appId: a.appId,
    billId: a.period,
    platform: TAOBAO,
    requestedAt: a.clock.now(),
  });
}

function runBill(a: App, d: Direct, db: App['db'] = a.db) {
  return within(billOnce(a, d, db), 'bill run');
}

function runSupplement(a: App, d: Direct, db: App['db'] = a.db) {
  return within(supplementOnce(a, d, db), 'supplement launch');
}

/** 重生成成功的单的 v2 金额行期望：基数 1000，各方与 splitCommission 对同一输入的结果相同。 */
function regeneratedRows(a: App, o: Seeded) {
  return byRole(versionRows(o, 2, splitOf(o, 1000n), a.clock.now()));
}

it(
  '[AC-B2-18#35] 月结到上限即停（上限注入 2）：来源顺序为相符 1 张、重生成失败 1 张、重生成会成功 4 张——相符的照常入批；失败的告警一次、amount_mismatch_count 1、不入批、版本原样（不占名额）；恰 2 张重生成成功（各追加 v2 基数 1000、入批）；其余 2 张不重算、不调用端口、版本原样、保持 WAITING、不入批、没有差错单、没有为它们打的告警、不在逐单结果里；账单四个计数只反映前面那些单；恰一条 warn 日志 settle_regeneration_deferred（run bill、deferred_count 2、不带订单号与 alert）',
  async () => {
    const a = await app(pools.db);
    const s = await scene(a, 4);
    const [r0, r1, r2, r3] = s.regenerable as [Seeded, Seeded, Seeded, Seeded];
    const before = {
      failing: await versionsOf(a, s.failing),
      r2: await versionsOf(a, r2),
      r3: await versionsOf(a, r3),
    };
    const regen = refreshRegeneration(a, new Set([s.failing.orderId]));
    const d = directAssembly(a, { regenerateSnapshot: regen.port, regenerationCap: 2 });

    const outcome = await runBill(a, d);

    expect(shown(outcome)).toBe('ok');
    // 端口只为失败的那张与名额内的两张调用（按来源顺序）；相符的与名额满后的都不调用。
    expect(regen.calls).toEqual([s.failing.orderId, r0.orderId, r1.orderId]);
    // 相符的照常入批（B_settle 1000）。
    expect(await itemsFor(a, s.matching)).toEqual([
      expect.objectContaining({ item_type: 'order', settle_seq: 1, b_settle_fen: 1000n }),
    ]);
    // 重生成成功恰 2 张：v2 基数 1000（500 / 100，各方之和 + 留存 = 1000），指向 v2，入批。
    for (const o of [r0, r1]) {
      expect(await basesOf(a, o), o.orderKey).toEqual([
        [1, 1200n],
        [2, 1000n],
      ]);
      expect(await amountsAt(a, o, 2)).toEqual(regeneratedRows(a, o));
      const split = splitOf(o, 1000n);
      expect(split.base).toBe(1000n);
      expect([...split.shares, split.retain].reduce((x, y) => addFen(x, y), 0n)).toBe(1000n);
      expect(await orderRow(a, o)).toMatchObject({
        rebate_status: 'WAITING',
        commission_version: 2,
      });
      expect(await itemsFor(a, o)).toEqual([
        expect.objectContaining({ item_type: 'order', settle_seq: 1, b_settle_fen: 1000n }),
      ]);
    }
    // 失败的：版本原样、不入批、告警一次（同款字段）。
    expect(await versionsOf(a, s.failing)).toEqual(before.failing);
    expect(await orderRow(a, s.failing)).toMatchObject({
      rebate_status: 'WAITING',
      commission_version: 1,
    });
    expect(await itemsFor(a, s.failing)).toEqual([]);
    const alerts = alertsFor(d.lines, s.failing);
    expect(alerts).toHaveLength(1);
    expectAlertShape(alerts[0]!, a, s.failing);
    expect(allAlerts(d.lines)).toHaveLength(1);
    // 名额满后留下的 2 张：什么都没动。
    expect(await versionsOf(a, r2)).toEqual(before.r2);
    expect(await versionsOf(a, r3)).toEqual(before.r3);
    for (const o of [r2, r3]) {
      expect(await orderRow(a, o), o.orderKey).toMatchObject({
        rebate_status: 'WAITING',
        commission_version: 1,
      });
      expect(await itemsFor(a, o)).toEqual([]);
      expect(alertsFor(d.lines, o)).toEqual([]);
    }
    // 逐单结果：前四张各有一条，留下的两张没有。
    const results = resultsOf(d);
    expect(results.get(s.matching.orderId)).toBe('candidate');
    expect(results.get(s.failing.orderId)).toBe('amount_mismatch');
    expect(results.get(r0.orderId)).toBe('candidate');
    expect(results.get(r1.orderId)).toBe('candidate');
    expect(results.has(r2.orderId)).toBe(false);
    expect(results.has(r3.orderId)).toBe(false);
    expect(d.saved).toHaveLength(4);
    // 不登记任何差错单；四个计数只含失败那张的 amount_mismatch 1。
    expect(await diffsOf(a)).toEqual([]);
    expect(await countsOf(a)).toEqual({
      error_count: 0,
      held_count: 0,
      unsettled_count: 0,
      amount_mismatch_count: 1,
    });
    // 恰一条留下事件。
    expect(deferredSummary(d.lines, all(s))).toEqual({
      events: [
        {
          level: WARN_LEVEL,
          app_id: a.appId,
          bill_id: a.period,
          platform: TAOBAO,
          run: 'bill',
          deferred_count: 2,
          alert: false,
          order_id: false,
        },
      ],
      leaks: [],
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-18#36] 月结里被留下的单不取订单键锁：同 #35 的单与上限 2，出账所用执行器上的语句里——重生成成功的两张各取过订单键锁（lockOrderKey 的键文本），被留下的两张与金额本来相符的那张一次都没出现在取订单键锁的语句里；留下事件 deferred_count 2',
  async () => {
    const a = await app(pools.db);
    const s = await scene(a, 4);
    const [r0, r1, r2, r3] = s.regenerable as [Seeded, Seeded, Seeded, Seeded];
    const regen = refreshRegeneration(a, new Set([s.failing.orderId]));
    const d = directAssembly(a, { regenerateSnapshot: regen.port, regenerationCap: 2 });
    const traced = traceStatements(a.db);

    const outcome = await runBill(a, d, traced.db);

    expect(shown(outcome)).toBe('ok');
    expect(traced.statements.length).toBeGreaterThan(0);
    const locks = {
      matching: orderKeyLocks(traced.statements, s.matching),
      r0: orderKeyLocks(traced.statements, r0),
      r1: orderKeyLocks(traced.statements, r1),
      r2: orderKeyLocks(traced.statements, r2),
      r3: orderKeyLocks(traced.statements, r3),
    };
    expect(locks.r0).toBeGreaterThanOrEqual(1);
    expect(locks.r1).toBeGreaterThanOrEqual(1);
    expect({ matching: locks.matching, r2: locks.r2, r3: locks.r3 }).toEqual({
      matching: 0,
      r2: 0,
      r3: 0,
    });
    expect(deferredSummary(d.lines, all(s)).events).toEqual([
      expect.objectContaining({ run: 'bill', deferred_count: 2 }),
    ]);
    expect(await itemsFor(a, r2)).toEqual([]);
    expect(await itemsFor(a, r3)).toEqual([]);
  },
  TIMEOUT,
);

it.each([
  { label: '月结留下 2 张，补充处理完、留下 0 张', regenerable: 4, billDeferred: 2, left: 0 },
  { label: '月结留下 3 张，补充处理 2 张、留下 1 张', regenerable: 5, billDeferred: 3, left: 1 },
])(
  '[AC-B2-18#37] 下一次补充接着处理（上限 2）——$label：月结之后对同一账单发起补充（直接组装的 launch，不带 refusePendingDraft：月结的草稿批次留着，其中的单按 blocksSupplement 不重复入批）；月结已重生成成功的 2 张金额已相符，不再调用端口、不占名额、没有 v3；接下来 2 张这次重生成成功（v2 基数 1000）并入补充批次；仍留下的保持原样；留下 0 张时补充不打 settle_regeneration_deferred，留下 1 张时打一条 run supplement、deferred_count 1；补充不写账单计数',
  async ({ regenerable, billDeferred, left }) => {
    const a = await app(pools.db);
    const s = await scene(a, regenerable);
    const regen = refreshRegeneration(a, new Set([s.failing.orderId]));
    const bill = directAssembly(a, { regenerateSnapshot: regen.port, regenerationCap: 2 });

    const billed = await runBill(a, bill);
    const countsAfterBill = await countsOf(a);
    const billCalls = [...regen.calls];
    regen.calls.length = 0;

    // 补充用 launch（finance 的通用发起），不带 refusePendingDraft：主批次的草稿不确认也不驳回——这样补充的结果只由
    // 上限与金额决定；草稿里的单按 blocksSupplement 不重复入批（BR-FUND-04 迁移表表外），不影响本条要看的名额。
    const supplement = directAssembly(a, { regenerateSnapshot: regen.port, regenerationCap: 2 });
    const launched = await runSupplement(a, supplement);

    const [r0, r1, r2, r3] = s.regenerable as [Seeded, Seeded, Seeded, Seeded];
    expect(shown(billed)).toBe('ok');
    expect(billCalls).toEqual([s.failing.orderId, r0.orderId, r1.orderId]);
    expect(deferredSummary(bill.lines, all(s)).events).toEqual([
      expect.objectContaining({ run: 'bill', deferred_count: billDeferred }),
    ]);

    expect(shown(launched)).toBe('ok');
    expect(launched.ok ? launched.value : null).toMatchObject({ outcome: 'generated' });
    // 补充里端口只为失败的那张（再失败一次）与名额内的接下来两张调用。
    expect(regen.calls).toEqual([s.failing.orderId, r2.orderId, r3.orderId]);
    // 月结已重生成的两张：仍只有 v2，明细只有月结主批次那一份。
    for (const o of [r0, r1]) {
      expect(await basesOf(a, o), o.orderKey).toEqual([
        [1, 1200n],
        [2, 1000n],
      ]);
      expect(await placedIn(a, o)).toEqual(['main']);
    }
    // 接下来两张：这次重生成 v2 基数 1000、入补充批次。
    for (const o of [r2, r3]) {
      expect(await basesOf(a, o), o.orderKey).toEqual([
        [1, 1200n],
        [2, 1000n],
      ]);
      expect(await amountsAt(a, o, 2)).toEqual(regeneratedRows(a, o));
      expect(await orderRow(a, o)).toMatchObject({
        rebate_status: 'WAITING',
        commission_version: 2,
      });
      expect(await placedIn(a, o)).toEqual(['supplement']);
      expect(await itemsFor(a, o)).toEqual([
        expect.objectContaining({ item_type: 'order', settle_seq: 1, b_settle_fen: 1000n }),
      ]);
    }
    // 仍留下的（只有第二组有一张）：原样。
    for (const o of s.regenerable.slice(4)) {
      expect(await basesOf(a, o), o.orderKey).toEqual([[1, 1200n]]);
      expect(await itemsFor(a, o)).toEqual([]);
    }
    expect(s.regenerable.slice(4)).toHaveLength(left);
    expect(deferredSummary(supplement.lines, all(s))).toEqual({
      events:
        left === 0
          ? []
          : [
              {
                level: WARN_LEVEL,
                app_id: a.appId,
                bill_id: a.period,
                platform: TAOBAO,
                run: 'supplement',
                deferred_count: left,
                alert: false,
                order_id: false,
              },
            ],
      leaks: [],
    });
    expect(alertsFor(supplement.lines, s.failing)).toHaveLength(1);
    expect(allAlerts(supplement.lines)).toHaveLength(1);
    // 补充不写账单计数列；全程没有差错单。
    expect(await countsOf(a)).toEqual(countsAfterBill);
    expect(countsAfterBill).toEqual({
      error_count: 0,
      held_count: 0,
      unsettled_count: 0,
      amount_mismatch_count: 1,
    });
    expect(await diffsOf(a)).toEqual([]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-18#38] 补充到上限即停（上限 2，与 #35 同构，走补充命令）：相符的入补充批次；失败的告警一次、不入批、版本原样；恰 2 张重生成成功并入补充批次；其余 2 张不重算、不入批、没有差错单、不在逐单结果里；一条 settle_regeneration_deferred（run supplement、deferred_count 2）；账单行一字不动；保存逐单结果时（逐单处理之后、提交之前）从另一个连接 pg_try_advisory_xact_lock 探：被留下的两张、相符的与失败的都能取到，重生成成功的两张取不到',
  async () => {
    const a = await app(pools.db);
    await legacyBill(a.db, a.appId, { billId: a.period, platformOrderCounts: { taobao: 0 } });
    const s = await scene(a, 4);
    const [r0, r1, r2, r3] = s.regenerable as [Seeded, Seeded, Seeded, Seeded];
    const billBefore = await billRow(a);
    const before = { r2: await versionsOf(a, r2), r3: await versionsOf(a, r3) };
    const regen = refreshRegeneration(a, new Set([s.failing.orderId]));
    const probes: Record<string, boolean | string> = {};
    const d = directAssembly(a, {
      regenerateSnapshot: regen.port,
      regenerationCap: 2,
      onSaveValidations: async () => {
        for (const [name, o] of [
          ['matching', s.matching],
          ['failing', s.failing],
          ['r0', r0],
          ['r1', r1],
          ['r2', r2],
          ['r3', r3],
        ] as const) {
          probes[name] = await orderKeyFree(pools.left, o);
        }
      },
    });

    const launched = await runSupplement(a, d);

    expect(shown(launched)).toBe('ok');
    expect(launched.ok ? launched.value.batchIds : []).toHaveLength(1);
    expect(regen.calls).toEqual([s.failing.orderId, r0.orderId, r1.orderId]);
    expect(await placedIn(a, s.matching)).toEqual(['supplement']);
    for (const o of [r0, r1]) {
      expect(await basesOf(a, o), o.orderKey).toEqual([
        [1, 1200n],
        [2, 1000n],
      ]);
      expect(await amountsAt(a, o, 2)).toEqual(regeneratedRows(a, o));
      expect(await placedIn(a, o)).toEqual(['supplement']);
      expect(await itemsFor(a, o)).toEqual([
        expect.objectContaining({ settle_seq: 1, b_settle_fen: 1000n }),
      ]);
    }
    expect(await itemsFor(a, s.failing)).toEqual([]);
    expect(await basesOf(a, s.failing)).toEqual([[1, 1200n]]);
    const alerts = alertsFor(d.lines, s.failing);
    expect(alerts).toHaveLength(1);
    expectAlertShape(alerts[0]!, a, s.failing);
    expect(allAlerts(d.lines)).toHaveLength(1);
    expect(await versionsOf(a, r2)).toEqual(before.r2);
    expect(await versionsOf(a, r3)).toEqual(before.r3);
    for (const o of [r2, r3]) {
      expect(await itemsFor(a, o)).toEqual([]);
      expect(await orderRow(a, o)).toMatchObject({
        rebate_status: 'WAITING',
        commission_version: 1,
      });
    }
    const results = resultsOf(d);
    expect(results.has(r2.orderId)).toBe(false);
    expect(results.has(r3.orderId)).toBe(false);
    expect(results.get(s.failing.orderId)).toBe('amount_mismatch');
    expect(deferredSummary(d.lines, all(s))).toEqual({
      events: [
        {
          level: WARN_LEVEL,
          app_id: a.appId,
          bill_id: a.period,
          platform: TAOBAO,
          run: 'supplement',
          deferred_count: 2,
          alert: false,
          order_id: false,
        },
      ],
      leaks: [],
    });
    expect(await diffsOf(a)).toEqual([]);
    expect(await billRow(a)).toEqual(billBefore);
    // 提交前那一刻：留到提交的订单键锁只剩重生成成功的两张。
    expect(probes).toEqual({
      matching: true,
      failing: true,
      r0: false,
      r1: false,
      r2: true,
      r3: true,
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-18#39] 缺省上限是 500（不注入 regenerationCap）：一次月结里 501 张重生成会成功的单（自拟：快照 1200、联盟结算 1000）——重生成成功恰 500 张（来源顺序前 500 张，各 v2 基数 1000、入批），留下恰 1 张（来源顺序最后一张：版本原样、不入批）；settle_regeneration_deferred 一条，deferred_count 1；不告警、不登记差错单、计数全 0',
  async () => {
    const a = await app(pools.db);
    const orders = await seedMany(a, { count: 501, snapshotN: 1200n, settleFen: 1000n });
    const last = orders[500]!;
    const regen = refreshRegeneration(a);
    const d = directAssembly(a, { regenerateSnapshot: regen.port });

    const outcome = await runBill(a, d);

    expect(shown(outcome)).toBe('ok');
    expect(regen.calls).toEqual(orders.slice(0, 500).map((o) => o.orderId));
    const rows = await a.db
      .selectFrom('orders')
      .select(['order_id', 'commission_version'])
      .where('app_id', '=', a.appId)
      .execute();
    const versionOf = new Map(rows.map((r) => [r.order_id, r.commission_version]));
    expect(orders.slice(0, 500).filter((o) => versionOf.get(o.orderId) === 2)).toHaveLength(500);
    expect(versionOf.get(last.orderId)).toBe(1);
    expect(await basesOf(a, last)).toEqual([[1, 1200n]]);
    const items = await itemsOf(a);
    expect(items).toHaveLength(500);
    expect(items.every((i) => i.b_settle_fen === 1000n)).toBe(true);
    expect(items.some((i) => i.order_id === last.orderId)).toBe(false);
    expect(deferredSummary(d.lines, [last])).toEqual({
      events: [
        {
          level: WARN_LEVEL,
          app_id: a.appId,
          bill_id: a.period,
          platform: TAOBAO,
          run: 'bill',
          deferred_count: 1,
          alert: false,
          order_id: false,
        },
      ],
      leaks: [],
    });
    expect(allAlerts(d.lines)).toEqual([]);
    expect(await diffsOf(a)).toEqual([]);
    expect(await countsOf(a)).toEqual({
      error_count: 0,
      held_count: 0,
      unsettled_count: 0,
      amount_mismatch_count: 0,
    });
  },
  TIMEOUT,
);

it.each([
  { entry: 'bill' as const, cap: 0 },
  { entry: 'bill' as const, cap: -1 },
  { entry: 'bill' as const, cap: 1.5 },
  { entry: 'supplement' as const, cap: 0 },
  { entry: 'supplement' as const, cap: -1 },
  { entry: 'supplement' as const, cap: 1.5 },
])(
  '[AC-B2-18#40] 非法上限（$entry，regenerationCap = $cap）：出账抛 RangeError，不写任何行——没有 settle_jobs、批次、明细、差错单，账单行不新建也不改，订单版本原样，重生成端口不被调用',
  async ({ entry, cap }) => {
    const a = await app(pools.db);
    if (entry === 'supplement') {
      await legacyBill(a.db, a.appId, { billId: a.period, platformOrderCounts: { taobao: 0 } });
    }
    const o = await mismatching(a, `bfu-cap-bad-${randomUUID()}`);
    const before = { versions: await versionsOf(a, o), bill: await billRow(a) };
    const regen = refreshRegeneration(a);
    const d = directAssembly(a, { regenerateSnapshot: regen.port, regenerationCap: cap });

    const outcome = entry === 'bill' ? await runBill(a, d) : await runSupplement(a, d);

    expect(
      outcome.ok
        ? 'resolved'
        : outcome.error instanceof RangeError
          ? 'RangeError'
          : errorText(outcome.error),
    ).toBe('RangeError');
    expect(regen.calls).toEqual([]);
    expect(await settleJobsOf(a)).toEqual([]);
    expect(await batchesOf(a)).toEqual([]);
    expect(await itemsOf(a)).toEqual([]);
    expect(await diffsOf(a)).toEqual([]);
    expect(await billRow(a)).toEqual(before.bill);
    expect(await versionsOf(a, o)).toEqual(before.versions);
  },
  TIMEOUT,
);

it.each([
  {
    label:
      '(i) 另一个事务把它的版本推进到与联盟一致（commission 真实 refresh 写 v2 基数 1000）并提交，取锁后重读即相符',
    variant: 'pushed' as const,
  },
  {
    label: '(ii) 另一个事务经 R11 给它加人工 hold 并提交，取锁后重读已不是候选（暂缓）',
    variant: 'held' as const,
  },
])(
  '[AC-B2-18#41] 取锁后没有重生成的不占名额、提交时不持锁（D10-3046 (1)；上限 1）——$label：来源读出之后、逐单处理到它之前（包一层来源读口，在行交回任务之前做完并发动作）；来源顺序里它排在一张重生成会成功的单之前；它不被本次出账重生成，结果照重读到的处理；后面那张照常重生成成功并入批，没有 settle_regeneration_deferred；提交前从另一个连接探它的订单键锁能取到、后面那张取不到',
  async ({ variant }) => {
    const a = await app(pools.db);
    const key = keys();
    const x = await mismatching(a, key(0, 'x'));
    const y = await mismatching(a, key(1, 'y'));
    const adminId = await admin(a);
    const regen = refreshRegeneration(a);
    const concurrent: { outcome?: Outcome<string> } = {};
    const probes: Record<string, boolean | string> = {};
    const d = directAssembly(a, {
      regenerateSnapshot: regen.port,
      regenerationCap: 1,
      afterFirstSourceRead: async () => {
        concurrent.outcome = await within(
          variant === 'pushed'
            ? pushVersionToUnion(pools.left, a, x, 1000n).then((v) => `v${String(v)}`)
            : holdBy(pools.left, a, x, adminId),
          'concurrent transaction',
        );
      },
      onSaveValidations: async () => {
        probes['x'] = await orderKeyFree(pools.control, x);
        probes['y'] = await orderKeyFree(pools.control, y);
      },
    });

    const outcome = await runBill(a, d);

    const done = concurrent.outcome;
    expect(shown(done)).toBe('ok');
    expect(done !== undefined && done.ok ? done.value : null).toBe(
      variant === 'pushed' ? 'v2' : 'applied',
    );
    expect(shown(outcome)).toBe('ok');
    // 本次出账只为后面那张调用重生成端口；它没被重生成。
    expect(regen.calls).toEqual([y.orderId]);
    const results = resultsOf(d);
    if (variant === 'pushed') {
      // 只有并发事务写的 v2，本次出账没有再追加；按 v2 入批。
      expect(await basesOf(a, x)).toEqual([
        [1, 1200n],
        [2, 1000n],
      ]);
      expect(await orderRow(a, x)).toMatchObject({
        rebate_status: 'WAITING',
        commission_version: 2,
      });
      expect(await itemsFor(a, x)).toEqual([
        expect.objectContaining({ item_type: 'order', settle_seq: 1, b_settle_fen: 1000n }),
      ]);
      expect(results.get(x.orderId)).toBe('candidate');
    } else {
      // 暂缓：不比较、不重生成、不入批，计入 held_count。
      expect(await basesOf(a, x)).toEqual([[1, 1200n]]);
      expect(await orderRow(a, x)).toMatchObject({
        rebate_status: 'WAITING',
        hold: true,
        commission_version: 1,
      });
      expect(await itemsFor(a, x)).toEqual([]);
      expect(results.get(x.orderId)).toBe('deferred');
    }
    // 后面那张照常重生成成功并入批。
    expect(await basesOf(a, y)).toEqual([
      [1, 1200n],
      [2, 1000n],
    ]);
    expect(await itemsFor(a, y)).toEqual([
      expect.objectContaining({ item_type: 'order', settle_seq: 1, b_settle_fen: 1000n }),
    ]);
    expect(results.get(y.orderId)).toBe('candidate');
    expect(deferredSummary(d.lines, [x, y]).events).toEqual([]);
    expect(allAlerts(d.lines)).toEqual([]);
    expect(await diffsOf(a)).toEqual([]);
    expect(await countsOf(a)).toEqual({
      error_count: 0,
      held_count: variant === 'held' ? 1 : 0,
      unsettled_count: 0,
      amount_mismatch_count: 0,
    });
    expect(probes).toEqual({ x: true, y: false });
  },
  TIMEOUT,
);

it(
  '[AC-B2-18#42] 名额已满时版本被推进的单也留下（D10-3046 (2)；上限 1）：来源顺序第一张重生成成功占满名额；第二张在来源读出之后被另一个事务把版本推进到与联盟一致（commission 真实 refresh 写 v2）——它不取订单键锁、不入批、不在逐单结果里、计入 deferred_count 1；版本只有并发事务写的 v2；不告警、不登记差错单',
  async () => {
    const a = await app(pools.db);
    const key = keys();
    const y = await mismatching(a, key(0, 'y'));
    const x = await mismatching(a, key(1, 'x'));
    const regen = refreshRegeneration(a);
    const concurrent: { outcome?: Outcome<number> } = {};
    const d = directAssembly(a, {
      regenerateSnapshot: regen.port,
      regenerationCap: 1,
      afterFirstSourceRead: async () => {
        concurrent.outcome = await within(
          pushVersionToUnion(pools.left, a, x, 1000n),
          'concurrent transaction',
        );
      },
    });
    const traced = traceStatements(a.db);

    const outcome = await runBill(a, d, traced.db);

    expect(shown(concurrent.outcome)).toBe('ok');
    expect(shown(outcome)).toBe('ok');
    expect(regen.calls).toEqual([y.orderId]);
    expect(await basesOf(a, y)).toEqual([
      [1, 1200n],
      [2, 1000n],
    ]);
    expect(await itemsFor(a, y)).toEqual([
      expect.objectContaining({ item_type: 'order', settle_seq: 1, b_settle_fen: 1000n }),
    ]);
    expect(orderKeyLocks(traced.statements, y)).toBeGreaterThanOrEqual(1);
    // 留下的那张：不取订单键锁、不入批、不在逐单结果里；版本只有并发事务写的 v2。
    expect(orderKeyLocks(traced.statements, x)).toBe(0);
    expect(await itemsFor(a, x)).toEqual([]);
    expect(resultsOf(d).has(x.orderId)).toBe(false);
    expect(await basesOf(a, x)).toEqual([
      [1, 1200n],
      [2, 1000n],
    ]);
    expect(await orderRow(a, x)).toMatchObject({ rebate_status: 'WAITING', commission_version: 2 });
    expect(deferredSummary(d.lines, [x, y])).toEqual({
      events: [
        {
          level: WARN_LEVEL,
          app_id: a.appId,
          bill_id: a.period,
          platform: TAOBAO,
          run: 'bill',
          deferred_count: 1,
          alert: false,
          order_id: false,
        },
      ],
      leaks: [],
    });
    expect(allAlerts(d.lines)).toEqual([]);
    expect(await diffsOf(a)).toEqual([]);
    expect(await countsOf(a)).toEqual({
      error_count: 0,
      held_count: 0,
      unsettled_count: 0,
      amount_mismatch_count: 0,
    });
  },
  TIMEOUT,
);
