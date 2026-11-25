// B2-18d 写测第 1 次（任务书 §19.1 第 1、2 条；规则测试评审第 1 轮第 1、3 条 S1）：一次出账的重生成上限（08 BR-FUND-04 ④
// 与细则「一次出账的重生成上限」，SPEC_REF 1025764be5af；编排 D10-2982 ①、D10-3046 (1)(2)(3)(5)）。
// - 名额用完之后的分类（[AC-B2-18#45] 月结、[#46] 补充）：名额满了之后只有「本来要去重生成的单」（金额超出容差）留下、
//   不进逐单结果；金额相符、零结算而正基数、暂缓、应结未结的单照常处理、照常进逐单结果与各自的计数或告警，都不计入
//   deferred_count。
// - 再校验仍不一致的回滚（[AC-B2-18#47]）：端口正常返回、却写了偏差版本并推进了指针——复核不一致的单回滚放锁（版本行与
//   指针回到重生成之前）、告警、不入批、不占名额；后面的合格单用足名额。
//
// 直接组装（./kit.ts directAssembly：生产 readSource、commission / ledger 的真实端口；上限只供测试注入，不接进生产，
// D10-3046 (5)）；重生成端口是 ./kit.ts refreshRegeneration（成功）与 skewedRefreshRegeneration（对指定订单写偏差版本）。
// 处理顺序 = 来源读口的返回顺序，生产来源读口按订单键升序：子订单号都是 `{tag}-{两位序号}-{标签}`，序号即顺序。
// 本文件不改 ./regen-cap.int.test.ts（那里的辅助在这里照写一份）。顶层 it()（规划/11 §4.3）；等待一律有界（kit within）。
//
// 金额（自拟，预留 0、淘礼金 0；BR-CALC-02：B = max(0, floor(N × (10000 − 0) / 10000) − 0) = N）：
// - 要重生成 / 超额的单：快照 N 1200（v1 基数 1200）、联盟结算 1000 → B_settle 1000 ≠ 1200（容差 0）；重生成后 v2 基数
//   1000，自购 5000bp、直推 1000bp → 1000 × 5000 / 10000 = 500、1000 × 1000 / 10000 = 100（与 splitCommission 对同一输入
//   的结果比，kit splitOf）。
// - 金额相符：快照 1000、结算 1000 → B_settle 1000 = 基数 1000。
// - 零结算而正基数：快照 1000、结算 0 → B_settle 0，基数 1000 > 0（D10-2415 ④(i)、D10-2532：不重生成、告警、不入批）。
// - 暂缓：hold、快照 1200、结算 1000（金额不符也不比较、不重生成）。
// - 应结未结：快照 1000、没有联盟结算（settle_period = 账单月）。
// - 偏差版本（#47）：端口按 1000 + 7 = 1007 估值写 v2 → 基数 1007 ≠ B_settle 1000，复核不一致。
// - B2-18d 写测第 2 次（任务书 §21.1 第 2 条；规则测试评审第 2 轮第 2 条 S1，BR-FUND-04 ④、BR-FUND-09 R1、D10-3046
//   (2)(3)）：tail() 尾部、名额用完之后另加——只在维权中（rights_pending、未 hold；./kit.ts seedOrder 的 rightsPending，
//   与 ./bill-day.int.test.ts [AC-B2-18#5] 同一造法）、快照 1200、结算 1000（金额本来超差）的一张：照常暂缓（deferred），
//   不比较、不重生成；联盟有结算而我方已作废（./kit.ts voidOrder，同 ./register-write-only.int.test.ts [AC-B2-18#43]）、
//   快照 1200、结算 1000（金额超差；B2-18d 写测第 3 次由 1000 改为 1200，规则测试评审第 3 轮第 2 条 S1）的一张：
//   照常登记一张 union_mismatch（unexpected_settlement）。两张都不计入 deferred_count；最后仍保留一张真正超额的 x1
//   （排在这两张之后）。
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
  alertsFor,
  allAlerts,
  amountsAt,
  app,
  basesOf,
  billRow,
  byRole,
  countsOf,
  databaseFixture,
  deferredSummary,
  diffsOf,
  directAssembly,
  errorText,
  expectAlertShape,
  itemsFor,
  orderKeyFree,
  orderRow,
  placedIn,
  refreshRegeneration,
  seedOrder,
  skewedRefreshRegeneration,
  splitOf,
  versionRows,
  versionsOf,
  voidOrder,
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
  const tag = `bfu-tail-${randomUUID()}`;
  return (index, label) => `${tag}-${String(index).padStart(2, '0')}-${label}`;
}

/** 自拟：快照 1200、联盟结算 1000 → 要重生成（见文件头）。 */
function mismatching(a: App, subOrderId: string): Promise<Seeded> {
  return seedOrder(a, { snapshotN: 1200n, settleFen: 1000n, people: EXAMPLE_PEOPLE, subOrderId });
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

function runBill(a: App, d: Direct) {
  return within(billOnce(a, d, a.db), 'bill run');
}

function runSupplement(a: App, d: Direct) {
  return within(supplementOnce(a, d, a.db), 'supplement launch');
}

/** 重生成成功的单的 v2 金额行期望：基数 1000，各方与 splitCommission 对同一输入的结果相同。 */
function regeneratedRows(a: App, o: Seeded) {
  return byRole(versionRows(o, 2, splitOf(o, 1000n), a.clock.now()));
}

/**
 * 名额（上限 2）在序号 01 用完之后的来源尾部（评审第 1 条；第 2 轮第 2 条加 07、08）：
 * 00 r0、01 r1（重生成会成功，用完名额）；02 x0（超额，留下）；03 相符；04 零结算而正基数；05 暂缓；06 应结未结；
 * 07 只在维权中（未 hold，金额超差）；08 联盟有结算而我方已作废（金额超差，第 3 轮第 2 条）；09 x1（超额，留下）。只做搭建。
 */
interface Tail {
  readonly r0: Seeded;
  readonly r1: Seeded;
  readonly x0: Seeded;
  readonly matching: Seeded;
  readonly zero: Seeded;
  readonly held: Seeded;
  readonly unsettled: Seeded;
  readonly rights: Seeded;
  readonly voided: Seeded;
  readonly x1: Seeded;
}

async function tail(a: App): Promise<Tail> {
  const key = keys();
  const r0 = await mismatching(a, key(0, 'regen'));
  const r1 = await mismatching(a, key(1, 'regen'));
  const x0 = await mismatching(a, key(2, 'excess'));
  const matching = await seedOrder(a, {
    snapshotN: 1000n,
    settleFen: 1000n,
    people: EXAMPLE_PEOPLE,
    subOrderId: key(3, 'match'),
  });
  const zero = await seedOrder(a, {
    snapshotN: 1000n,
    settleFen: 0n,
    people: EXAMPLE_PEOPLE,
    subOrderId: key(4, 'zero'),
  });
  const held = await seedOrder(a, {
    snapshotN: 1200n,
    settleFen: 1000n,
    hold: true,
    people: EXAMPLE_PEOPLE,
    subOrderId: key(5, 'held'),
  });
  const unsettled = await seedOrder(a, {
    snapshotN: 1000n,
    settleFen: null,
    people: EXAMPLE_PEOPLE,
    subOrderId: key(6, 'unsettled'),
  });
  // 只在维权中、没有 hold（rights_pending = true、hold = false）；快照 1200、结算 1000，金额本来超差。
  const rights = await seedOrder(a, {
    snapshotN: 1200n,
    settleFen: 1000n,
    rightsPending: true,
    people: EXAMPLE_PEOPLE,
    subOrderId: key(7, 'rights'),
  });
  // 联盟有结算（STATEMENT seq 1 结算 1000）而我方已作废（自拟：快照 1200、结算 1000 → B_settle 1000 ≠ 1200，金额超差；
  // B2-18d 第 3 轮评审第 2 条：满额后金额超差的作废单也不能被计作待重算，仍登记 union_mismatch）。
  const voided = await seedOrder(a, {
    snapshotN: 1200n,
    settleFen: 1000n,
    people: EXAMPLE_PEOPLE,
    subOrderId: key(8, 'void'),
  });
  await voidOrder(a, voided);
  const x1 = await mismatching(a, key(9, 'excess'));
  return { r0, r1, x0, matching, zero, held, unsettled, rights, voided, x1 };
}

function tailOrders(t: Tail): Seeded[] {
  return [t.r0, t.r1, t.x0, t.matching, t.zero, t.held, t.unsettled, t.rights, t.voided, t.x1];
}

/** 从另一条连接逐张探订单键锁（取数）。 */
async function probeAll(
  conn: App['db'],
  named: readonly (readonly [string, Seeded])[],
): Promise<Record<string, boolean | string>> {
  const out: Record<string, boolean | string> = {};
  for (const [name, o] of named) out[name] = await orderKeyFree(conn, o);
  return out;
}

function tailNamed(t: Tail): [string, Seeded][] {
  return [
    ['r0', t.r0],
    ['r1', t.r1],
    ['x0', t.x0],
    ['matching', t.matching],
    ['zero', t.zero],
    ['held', t.held],
    ['unsettled', t.unsettled],
    ['rights', t.rights],
    ['voided', t.voided],
    ['x1', t.x1],
  ];
}

/** 提交前那一刻：留到提交的订单键锁只剩重生成成功的 r0、r1（D10-3046 (1)）。 */
const TAIL_LOCKS = {
  r0: false,
  r1: false,
  x0: true,
  matching: true,
  zero: true,
  held: true,
  unsettled: true,
  rights: true,
  voided: true,
  x1: true,
};

/**
 * 逐单结果：名额满后的六张（相符、零结算、暂缓、应结未结、只在维权中、我方作废）照常各按本分支；超额的 x0、x1 不在
 * 逐单结果里。
 */
const TAIL_RESULTS = {
  r0: 'candidate',
  r1: 'candidate',
  x0: 'not in results',
  matching: 'candidate',
  zero: 'amount_mismatch',
  held: 'deferred',
  unsettled: 'missing_settlement',
  rights: 'deferred',
  voided: 'unexpected_settlement',
  x1: 'not in results',
};

/** 我方作废那张登记出来的 union_mismatch 应有的形状（BR-FUND-09；同 ./register-write-only.int.test.ts）。 */
function unionMismatchOf(a: App, o: Seeded) {
  return {
    app_id: a.appId,
    type: 'union_mismatch',
    source: 'R1',
    period: a.period,
    ref_type: 'order',
    ref_id: o.orderKey,
    dedupe_key: null,
    resolution: null,
    status: 'open',
  };
}

it(
  '[AC-B2-18#45] 月结名额用完之后的分类（上限注入 2；评审第 1 条，D10-3046 (2)(3)）：来源顺序 r0、r1（重生成成功，用完名额）、x0（超额）、金额相符、零结算而正基数（结算 0 / 基数 1000）、暂缓（hold，金额也不符）、应结未结、只在维权中（未 hold，金额也不符）、联盟有结算而我方作废（快照 1200、结算 1000，金额也超差）、x1（超额）——端口只为 r0、r1 调用；相符的照常入批（b_settle 1000）；零结算的告警一次、不重生成、不入批、计 amount_mismatch_count 1；暂缓与只在维权中的计 held_count 2、应结未结的计 unsettled_count 1，这三张都不重生成、不入批；作废单登记恰一张 union_mismatch、计 error_count 1；这六张都在逐单结果里（candidate / amount_mismatch / deferred / missing_settlement / deferred / unexpected_settlement）、都不计入 deferred_count；x0、x1 版本原样、不入批、不告警、不在逐单结果里；settle_regeneration_deferred 恰一条（run bill、deferred_count 2 = 超额张数）；提交前订单键锁只剩 r0、r1；除作废单那张外不登记差错单（第 2 轮评审第 2 条加只在维权中与作废单）',
  async () => {
    const a = await app(pools.db);
    const t = await tail(a);
    const before = {
      x0: await versionsOf(a, t.x0),
      x1: await versionsOf(a, t.x1),
      zero: await versionsOf(a, t.zero),
      held: await versionsOf(a, t.held),
      unsettled: await versionsOf(a, t.unsettled),
      matching: await versionsOf(a, t.matching),
      rights: await versionsOf(a, t.rights),
      voided: await versionsOf(a, t.voided),
    };
    const regen = refreshRegeneration(a);
    const probes: { seen?: Record<string, boolean | string> } = {};
    const d = directAssembly(a, {
      regenerateSnapshot: regen.port,
      regenerationCap: 2,
      onSaveValidations: async () => {
        probes.seen = await probeAll(pools.control, tailNamed(t));
      },
    });

    const outcome = await runBill(a, d);

    expect(shown(outcome)).toBe('ok');
    // 端口只为名额内的两张调用；相符、零结算、暂缓、应结未结与名额满后的超额单都不调用。
    expect(regen.calls).toEqual([t.r0.orderId, t.r1.orderId]);
    // r0、r1：v2 基数 1000（500 / 100，各方 + 留存 = 1000），指向 v2，入批。
    for (const o of [t.r0, t.r1]) {
      expect(await basesOf(a, o), o.orderKey).toEqual([
        [1, 1200n],
        [2, 1000n],
      ]);
      expect(await amountsAt(a, o, 2)).toEqual(regeneratedRows(a, o));
      const split = splitOf(o, 1000n);
      expect([...split.shares, split.retain].reduce((x, y) => addFen(x, y), 0n)).toBe(1000n);
      expect(await orderRow(a, o)).toMatchObject({
        rebate_status: 'WAITING',
        commission_version: 2,
      });
      expect(await itemsFor(a, o)).toEqual([
        expect.objectContaining({ item_type: 'order', settle_seq: 1, b_settle_fen: 1000n }),
      ]);
    }
    // 名额满后的金额相符单：照常入批，不追加版本。
    expect(await versionsOf(a, t.matching)).toEqual(before.matching);
    expect(await itemsFor(a, t.matching)).toEqual([
      expect.objectContaining({ item_type: 'order', settle_seq: 1, b_settle_fen: 1000n }),
    ]);
    // 零结算而正基数：告警一次（同款字段）、不重生成、不入批、保持 WAITING。
    expect(await versionsOf(a, t.zero)).toEqual(before.zero);
    expect(await orderRow(a, t.zero)).toMatchObject({
      rebate_status: 'WAITING',
      commission_version: 1,
    });
    expect(await itemsFor(a, t.zero)).toEqual([]);
    const zeroAlerts = alertsFor(d.lines, t.zero);
    expect(zeroAlerts).toHaveLength(1);
    expectAlertShape(zeroAlerts[0]!, a, t.zero);
    // 暂缓与应结未结：不重生成、不入批、保持 WAITING。
    expect(await versionsOf(a, t.held)).toEqual(before.held);
    expect(await orderRow(a, t.held)).toMatchObject({
      rebate_status: 'WAITING',
      hold: true,
      commission_version: 1,
    });
    expect(await itemsFor(a, t.held)).toEqual([]);
    expect(await versionsOf(a, t.unsettled)).toEqual(before.unsettled);
    expect(await orderRow(a, t.unsettled)).toMatchObject({
      rebate_status: 'WAITING',
      commission_version: 1,
      settle_commission_fen: null,
    });
    expect(await itemsFor(a, t.unsettled)).toEqual([]);
    // 只在维权中（未 hold）：照常暂缓——不比较、不重生成、不入批、不告警、保持 WAITING。
    expect(await versionsOf(a, t.rights)).toEqual(before.rights);
    expect(await orderRow(a, t.rights)).toMatchObject({
      rebate_status: 'WAITING',
      hold: false,
      rights_pending: true,
      commission_version: 1,
    });
    expect(await itemsFor(a, t.rights)).toEqual([]);
    expect(alertsFor(d.lines, t.rights)).toEqual([]);
    // 我方作废、联盟有结算：不比金额、不重生成、不入批、不告警，照常登记 union_mismatch（见下面差错单）。
    expect(await versionsOf(a, t.voided)).toEqual(before.voided);
    expect(await orderRow(a, t.voided)).toMatchObject({
      rebate_status: 'VOID',
      commission_version: 1,
    });
    expect(await itemsFor(a, t.voided)).toEqual([]);
    expect(alertsFor(d.lines, t.voided)).toEqual([]);
    // 超额的 x0、x1：什么都没动。
    expect(await versionsOf(a, t.x0)).toEqual(before.x0);
    expect(await versionsOf(a, t.x1)).toEqual(before.x1);
    for (const o of [t.x0, t.x1]) {
      expect(await orderRow(a, o), o.orderKey).toMatchObject({
        rebate_status: 'WAITING',
        commission_version: 1,
      });
      expect(await itemsFor(a, o)).toEqual([]);
      expect(alertsFor(d.lines, o)).toEqual([]);
    }
    expect(allAlerts(d.lines)).toHaveLength(1);
    // 逐单结果：除 x0、x1 外八张都在（第 2 轮评审第 2 条加只在维权中与作废单两张），结果各按本分支。
    const results = resultsOf(d);
    const byName = Object.fromEntries(
      tailNamed(t).map(([name, o]) => [name, results.get(o.orderId) ?? 'not in results']),
    );
    expect(byName).toEqual(TAIL_RESULTS);
    expect(d.saved).toHaveLength(8);
    // 账单：主批次三张（r0、r1、相符），合计 1000 × 3 = 3000；计数只反映零结算（amount_mismatch 1）、暂缓与只在
    // 维权中（held 2）、应结未结（unsettled 1）与作废单（error 1）。
    const splits = [t.r0, t.r1, t.matching].map((o) => splitOf(o, 1000n));
    const sum = (xs: readonly bigint[]) => xs.reduce((x, y) => addFen(x, y), 0n);
    expect(await billRow(a)).toMatchObject({
      platform_order_counts: { taobao: 3 },
      platform_settle_commission_totals: { taobao: '3000' },
      beneficiary_total_fen: sum(splits.map((x) => sum(x.shares))),
      platform_retained_fen: sum(splits.map((x) => x.retain)),
    });
    expect(await countsOf(a)).toEqual({
      error_count: 1,
      held_count: 2,
      unsettled_count: 1,
      amount_mismatch_count: 1,
    });
    // 差错单恰一张：作废单的 union_mismatch（BR-FUND-09）；名额满后的金额超差单不登记。
    expect(await diffsOf(a)).toEqual([expect.objectContaining(unionMismatchOf(a, t.voided))]);
    // 留下事件只数超额的两张。
    expect(deferredSummary(d.lines, tailOrders(t))).toEqual({
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
    expect(probes.seen).toEqual(TAIL_LOCKS);
  },
  TIMEOUT,
);

it(
  '[AC-B2-18#46] 补充名额用完之后的分类（上限注入 2，与 #45 同构，走补充命令；评审第 1 条，D10-3046 (2)(3)）：端口只为 r0、r1 调用；r0、r1 重生成 v2（基数 1000）与金额相符的单入补充批次；零结算而正基数的告警一次、不重生成、不入批；暂缓、只在维权中（未 hold）与应结未结的不重生成、不入批；作废单（联盟有结算；快照 1200、结算 1000，金额也超差）登记恰一张 union_mismatch；这六张都在逐单结果里（candidate / amount_mismatch / deferred / missing_settlement / deferred / unexpected_settlement）、都不计入 deferred_count；x0、x1 版本原样、不入批、不告警、不在逐单结果里；settle_regeneration_deferred 恰一条（run supplement、deferred_count 2 = 超额张数）；补充不写账单计数列（账单行一字不动）；提交前订单键锁只剩 r0、r1；除作废单那张外不登记差错单（第 2 轮评审第 2 条加只在维权中与作废单）',
  async () => {
    const a = await app(pools.db);
    await legacyBill(a.db, a.appId, { billId: a.period, platformOrderCounts: { taobao: 0 } });
    const t = await tail(a);
    const billBefore = await billRow(a);
    const before = {
      x0: await versionsOf(a, t.x0),
      x1: await versionsOf(a, t.x1),
      zero: await versionsOf(a, t.zero),
      held: await versionsOf(a, t.held),
      unsettled: await versionsOf(a, t.unsettled),
      matching: await versionsOf(a, t.matching),
      rights: await versionsOf(a, t.rights),
      voided: await versionsOf(a, t.voided),
    };
    const regen = refreshRegeneration(a);
    const probes: { seen?: Record<string, boolean | string> } = {};
    const d = directAssembly(a, {
      regenerateSnapshot: regen.port,
      regenerationCap: 2,
      onSaveValidations: async () => {
        probes.seen = await probeAll(pools.control, tailNamed(t));
      },
    });

    const launched = await runSupplement(a, d);

    expect(shown(launched)).toBe('ok');
    expect(launched.ok ? launched.value : null).toMatchObject({ outcome: 'generated' });
    expect(launched.ok ? launched.value.batchIds : []).toHaveLength(1);
    expect(regen.calls).toEqual([t.r0.orderId, t.r1.orderId]);
    for (const o of [t.r0, t.r1]) {
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
    expect(await versionsOf(a, t.matching)).toEqual(before.matching);
    expect(await placedIn(a, t.matching)).toEqual(['supplement']);
    expect(await itemsFor(a, t.matching)).toEqual([
      expect.objectContaining({ item_type: 'order', settle_seq: 1, b_settle_fen: 1000n }),
    ]);
    expect(await versionsOf(a, t.zero)).toEqual(before.zero);
    expect(await orderRow(a, t.zero)).toMatchObject({
      rebate_status: 'WAITING',
      commission_version: 1,
    });
    expect(await itemsFor(a, t.zero)).toEqual([]);
    const zeroAlerts = alertsFor(d.lines, t.zero);
    expect(zeroAlerts).toHaveLength(1);
    expectAlertShape(zeroAlerts[0]!, a, t.zero);
    expect(await versionsOf(a, t.held)).toEqual(before.held);
    expect(await orderRow(a, t.held)).toMatchObject({
      rebate_status: 'WAITING',
      hold: true,
      commission_version: 1,
    });
    expect(await itemsFor(a, t.held)).toEqual([]);
    expect(await versionsOf(a, t.unsettled)).toEqual(before.unsettled);
    expect(await itemsFor(a, t.unsettled)).toEqual([]);
    // 只在维权中（未 hold）：照常暂缓——不比较、不重生成、不入批、不告警。
    expect(await versionsOf(a, t.rights)).toEqual(before.rights);
    expect(await orderRow(a, t.rights)).toMatchObject({
      rebate_status: 'WAITING',
      hold: false,
      rights_pending: true,
      commission_version: 1,
    });
    expect(await itemsFor(a, t.rights)).toEqual([]);
    expect(alertsFor(d.lines, t.rights)).toEqual([]);
    // 我方作废、联盟有结算：不重生成、不入批、不告警，照常登记 union_mismatch（见下面差错单）。
    expect(await versionsOf(a, t.voided)).toEqual(before.voided);
    expect(await orderRow(a, t.voided)).toMatchObject({
      rebate_status: 'VOID',
      commission_version: 1,
    });
    expect(await itemsFor(a, t.voided)).toEqual([]);
    expect(alertsFor(d.lines, t.voided)).toEqual([]);
    expect(await versionsOf(a, t.x0)).toEqual(before.x0);
    expect(await versionsOf(a, t.x1)).toEqual(before.x1);
    for (const o of [t.x0, t.x1]) {
      expect(await orderRow(a, o), o.orderKey).toMatchObject({
        rebate_status: 'WAITING',
        commission_version: 1,
      });
      expect(await itemsFor(a, o)).toEqual([]);
      expect(alertsFor(d.lines, o)).toEqual([]);
    }
    expect(allAlerts(d.lines)).toHaveLength(1);
    const results = resultsOf(d);
    const byName = Object.fromEntries(
      tailNamed(t).map(([name, o]) => [name, results.get(o.orderId) ?? 'not in results']),
    );
    expect(byName).toEqual(TAIL_RESULTS);
    expect(d.saved).toHaveLength(8);
    // 补充不写账单计数列（[AC-B2-18a#23] 的口径：暂缓、作废单都不回写 held_count / error_count）；差错单恰一张：
    // 作废单的 union_mismatch（BR-FUND-09），名额满后的金额超差单不登记。
    expect(await billRow(a)).toEqual(billBefore);
    expect(await diffsOf(a)).toEqual([expect.objectContaining(unionMismatchOf(a, t.voided))]);
    expect(deferredSummary(d.lines, tailOrders(t))).toEqual({
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
    expect(probes.seen).toEqual(TAIL_LOCKS);
  },
  TIMEOUT,
);

it.each([{ entry: 'bill' as const }, { entry: 'supplement' as const }])(
  '[AC-B2-18#47] 再校验仍不一致的回滚（$entry；上限注入 2；评审第 3 条，BR-FUND-04 ④ 与细则「一次出账的重生成上限」、D10-2982 ①、D10-3046 (1)）：来源顺序 skew（端口正常返回、却按 1007 写了 v2 并把 orders.commission_version 推到 2）、r0、r1（重生成会成功）——端口为三张各调一次；skew 的版本行与指针完整回到重生成之前（没有 v2 行、commission_version 1）、告警一次、不入批、保持 WAITING、逐单结果 amount_mismatch；它不占名额：r0、r1 都重生成成功（v2 基数 1000）并入批，没有 settle_regeneration_deferred；提交前从另一个连接探 skew 的订单键锁能取到、r0 / r1 取不到；不登记差错单；月结计 amount_mismatch_count 1，补充不写账单计数',
  async ({ entry }) => {
    const a = await app(pools.db);
    if (entry === 'supplement') {
      await legacyBill(a.db, a.appId, { billId: a.period, platformOrderCounts: { taobao: 0 } });
    }
    const key = keys();
    const skew = await mismatching(a, key(0, 'skew'));
    const r0 = await mismatching(a, key(1, 'regen'));
    const r1 = await mismatching(a, key(2, 'regen'));
    const before = { skew: await versionsOf(a, skew), bill: await billRow(a) };
    const regen = skewedRefreshRegeneration(a, new Set([skew.orderId]));
    const probes: { seen?: Record<string, boolean | string> } = {};
    const d = directAssembly(a, {
      regenerateSnapshot: regen.port,
      regenerationCap: 2,
      onSaveValidations: async () => {
        probes.seen = await probeAll(pools.control, [
          ['skew', skew],
          ['r0', r0],
          ['r1', r1],
        ]);
      },
    });

    const outcome = entry === 'bill' ? await runBill(a, d) : await runSupplement(a, d);

    expect(shown(outcome)).toBe('ok');
    expect(regen.calls).toEqual([skew.orderId, r0.orderId, r1.orderId]);
    // skew：端口写的 v2（基数 1007）与指针都已回滚。
    expect(await versionsOf(a, skew)).toEqual(before.skew);
    expect(await basesOf(a, skew)).toEqual([[1, 1200n]]);
    expect(await amountsAt(a, skew, 2)).toEqual([]);
    expect(await orderRow(a, skew)).toMatchObject({
      rebate_status: 'WAITING',
      commission_version: 1,
    });
    expect(await itemsFor(a, skew)).toEqual([]);
    const alerts = alertsFor(d.lines, skew);
    expect(alerts).toHaveLength(1);
    expectAlertShape(alerts[0]!, a, skew);
    expect(allAlerts(d.lines)).toHaveLength(1);
    expect(resultsOf(d).get(skew.orderId)).toBe('amount_mismatch');
    // 后面的合格单用足名额。
    for (const o of [r0, r1]) {
      expect(await basesOf(a, o), o.orderKey).toEqual([
        [1, 1200n],
        [2, 1000n],
      ]);
      expect(await amountsAt(a, o, 2)).toEqual(regeneratedRows(a, o));
      expect(await orderRow(a, o)).toMatchObject({
        rebate_status: 'WAITING',
        commission_version: 2,
      });
      expect(await placedIn(a, o)).toEqual([entry === 'bill' ? 'main' : 'supplement']);
      expect(await itemsFor(a, o)).toEqual([
        expect.objectContaining({ item_type: 'order', settle_seq: 1, b_settle_fen: 1000n }),
      ]);
      expect(resultsOf(d).get(o.orderId)).toBe('candidate');
    }
    expect(deferredSummary(d.lines, [skew, r0, r1]).events).toEqual([]);
    expect(await diffsOf(a)).toEqual([]);
    if (entry === 'bill') {
      expect(await countsOf(a)).toEqual({
        error_count: 0,
        held_count: 0,
        unsettled_count: 0,
        amount_mismatch_count: 1,
      });
    } else {
      expect(await billRow(a)).toEqual(before.bill);
    }
    expect(probes.seen).toEqual({ skew: true, r0: false, r1: false });
  },
  TIMEOUT,
);
