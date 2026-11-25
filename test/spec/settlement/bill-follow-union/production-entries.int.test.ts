// B2-18d 写测第 1 次（任务书 §19.1 第 3、5 条；规则测试评审第 1 轮第 4、2 条 S1）：两个生产入口。
// - [AC-B2-18#48] 生产月结对 WAITING 金额不符单零读取差错表（D10-2415、BR-FUND-04 ④）：经 worker 的 settle 处理器
//   （./kit.ts withWorker）跑账单日，主库执行器装 ./kit.ts reconDiffsReadFault（凡是读 recon_diffs 的语句一执行就计数并
//   抛错；判定与允许清单——空——见 kit isReconDiffsRead）；账单里一张例 2 的 WAITING 单（快照 1234、联盟结算 1100），库里
//   已有它的一张已结案、结论「以联盟为准」的旧差错单（./kit.ts unionConclusion）。探针自检照 ./supplement.int.test.ts
//   [AC-B2-18#33]：经同一执行器调专用结论读口与 ledger 的通用读口 getReconDiffs 应被拦下。
// - [AC-B2-18#49] 账单日、[#50] 后台补充的缺省上限（08 BR-FUND-04 ④ 与细则「一次出账的重生成上限」500 张，D10-2982 ①；
//   上限不接进生产装配、生产不传，D10-3046 (5)）：不注入上限，各 501 张重生成会成功的单——只有来源顺序前 500 张推进版本
//   并入批，最后一张版本原样、保持 WAITING、不入批；settle_regeneration_deferred 恰一条、deferred_count 1。走生产装配里
//   真实的 commission 重生成（不是直接组装）。
//
// 夹具：#48、#49 用后台夹具的应用（../admin-settle-commands/kit.ts fixture，Clock 定在账单日 2032-07-24 10:00 +08:00，
// 资产快照已超时、可出账，同 ./register-write-only.int.test.ts）；#50 照 ./supplement.int.test.ts 的 appOf：入账开关 on、
// 账单 2026-09 已出过结果（seedBill：taobao 在 platform_order_counts 里、没有任何批次，所以没有草稿、不会 pending_draft）。
// 501 张单由 ./kit.ts seedMany 批量造（子订单号 `{tag}-{序号四位}`，订单键升序 = 返回顺序；生产来源读口按订单键升序）。
//
// 金额：#48 照 08 例 2（1100 / 1234 → 550 / 110，预留 0）；#49、#50 自拟（预留 0、淘礼金 0）：快照 N 1200（v1 基数 1200）、
// 联盟结算 1000 → B_settle = floor(1000 × 10000 / 10000) − 0 = 1000 ≠ 1200，要重生成；v2 基数 1000，自购 5000bp、直推
// 1000bp 的拆分与 splitCommission 对同一输入的结果比（kit splitOf：500 / 100）。
// 顶层 it()（规划/11 §4.3）；等待一律有界（kit within；501 张那两条给 LARGE_RUN_MS，远小于 TIMEOUT）。
import { expect, it } from 'vitest';
import {
  getReconDiffs,
  readUnionAuthoritativeOrderKeys,
} from '../../../../apps/api/src/modules/ledger/index.ts';
import {
  creditSwitch,
  everything,
  fixture,
  seedBill,
  setSwitch,
  suite,
  type Fixture,
} from '../admin-settle-commands/kit.ts';
import {
  BILL_DAY,
  EXAMPLE_PEOPLE,
  INJECTED_READ,
  TAOBAO,
  TIMEOUT,
  WARN_LEVEL,
  allAlerts,
  amountsAt,
  app,
  basesOf,
  batchesOf,
  byRole,
  countsOf,
  creditOn,
  deferredSummary,
  diffsOf,
  errorText,
  itemsFor,
  itemsOf,
  orderRow,
  placedIn,
  reconDiffsReadFault,
  seedMany,
  seedOrder,
  splitOf,
  unionConclusion,
  versionRows,
  withSupplementAdmin,
  withWorker,
  within,
  type App,
  type LogLine,
  type Outcome,
  type Seeded,
} from './kit.ts';

const s = suite();
/** 后台夹具的 Clock：账单日 10:00 +08:00（与 ./kit.ts 的 app 缺省 Clock 同一时刻）。 */
const AT_BILL_DAY = `${BILL_DAY}T10:00:00+08:00`;
/** #50 的账单（照 ./supplement.int.test.ts）。 */
const SUPPLEMENT_BILL = '2026-09';
/** 501 张单一次出账的有界等待（远小于 TIMEOUT 120 s；骨架与正确实现都应在此之内落定）。 */
const LARGE_RUN_MS = 90_000;

function shown(outcome: Outcome<unknown> | undefined): string {
  if (outcome === undefined) return 'not run';
  return outcome.ok ? 'ok' : errorText(outcome.error);
}

/** 账单月 2032-06 的应用（appId 与 Clock 取后台夹具的），入账开关 on。 */
async function billDayApp(f: Fixture): Promise<App> {
  const a = await app(f.db, { appId: f.appId, clock: f.clock });
  await creditOn(a);
  return a;
}

/** 后台夹具应用上已出过结果的账单 2026-09（没有批次）；订单与结算记录写在 2026-09-20 10:00 +08:00。 */
async function supplementApp(f: Fixture): Promise<App> {
  await setSwitch(f, creditSwitch(TAOBAO), true);
  await seedBill(f, SUPPLEMENT_BILL);
  return app(f.db, {
    appId: f.appId,
    clock: f.clock,
    period: SUPPLEMENT_BILL,
    at: new Date('2026-09-20T10:00:00+08:00'),
  });
}

/** 生产装配的账单日 bill 投递一次（worker 回调里只投递与取数）。 */
async function billVia(
  a: App,
  db: App['db'],
  limitMs?: number,
): Promise<{ outcome: Outcome<void> | undefined; lines: LogLine[] }> {
  const seen: { outcome?: Outcome<void>; lines: LogLine[] } = { lines: [] };
  await withWorker(
    a,
    async (w) => {
      seen.lines = w.lines;
      seen.outcome = await within(w.bill(), 'bill', limitMs);
    },
    { db },
  );
  return { outcome: seen.outcome, lines: seen.lines };
}

/** 本应用各单当前的 commission_version（orderId → 版本）。 */
async function versionByOrder(a: App): Promise<Map<string, number>> {
  const rows = await a.db
    .selectFrom('orders')
    .select(['order_id', 'commission_version'])
    .where('app_id', '=', a.appId)
    .execute();
  return new Map(rows.map((r) => [r.order_id, r.commission_version]));
}

/** 重生成成功的单的 v2 金额行期望：基数 1000，各方与 splitCommission 对同一输入的结果相同。 */
function regeneratedRows(a: App, o: Seeded) {
  return byRole(versionRows(o, 2, splitOf(o, 1000n), a.clock.now()));
}

it(
  '[AC-B2-18#48] 生产月结对 WAITING 金额不符单零读取差错表（评审第 4 条，D10-2415）：账单日经 worker 生产装配、主库执行器装 reconDiffsReadFault；例 2 的 WAITING 单（快照 1234、联盟结算 1100）另有一张已结案、结论「以联盟为准」的旧差错单 → 探针自检：经同一执行器调专用结论读口与 ledger 的 getReconDiffs（按单读 closed）都被拦下；任务完成，任务期间对 recon_diffs 的读取为零（executed / fired 增量 0、新增违规为空）而语句数增加；该单重生成 v2（基数 1100、550 / 110）并按 1100 入主批次（settle_seq 1）；旧差错单原样、不新增；不告警；四个计数都为 0',
  async () => {
    const base = fixture(s, AT_BILL_DAY);
    const a = await billDayApp(base);
    const o = await seedOrder(a, { snapshotN: 1234n, settleFen: 1100n, people: EXAMPLE_PEOPLE });
    await unionConclusion(a, o, 1234n, 1100n);
    const diffsBefore = await diffsOf(a);
    const main = reconDiffsReadFault(base.db);

    // 探针自检（取数；断言在下面）：经同一执行器调专用读口与通用读口各一次，都必须被计为违规并抛错。
    const conclusionKeys = { appId: a.appId, orderKeys: [o.orderKey] };
    const closedOfOrder = { appId: a.appId, orderKey: o.orderKey, status: 'closed' as const };
    const probes: [string, () => Promise<unknown>][] = [
      [
        'readUnionAuthoritativeOrderKeys',
        () => readUnionAuthoritativeOrderKeys(main.db, conclusionKeys),
      ],
      ['getReconDiffs by order, closed', () => getReconDiffs(main.db, closedOfOrder)],
    ];
    const probeResults: [string, string][] = [];
    for (const [name, read] of probes) {
      const outcome = await within(read(), `probe: ${name}`);
      probeResults.push([name, outcome.ok ? 'not rejected' : errorText(outcome.error)]);
    }
    const probed = { executed: main.executed, fired: main.fired, statements: main.statements };

    const billed = await billVia(a, main.db);

    expect(probeResults).toEqual(
      probes.map(([name]) => [name, expect.stringContaining(INJECTED_READ)]),
    );
    expect(probed).toMatchObject({ executed: probes.length, fired: probes.length });
    expect(shown(billed.outcome)).toBe('ok');
    expect(main.violations.slice(probed.executed)).toEqual([]);
    expect(main.executed - probed.executed).toBe(0);
    expect(main.fired - probed.fired).toBe(0);
    expect(main.statements).toBeGreaterThan(probed.statements);
    // 例 2：重生成 v2（基数 = B_settle 1100，550 / 110）并入主批次。
    expect(await basesOf(a, o)).toEqual([
      [1, 1234n],
      [2, 1100n],
    ]);
    expect((await amountsAt(a, o, 2)).map((r) => [r.role, r.base_fen, r.amount_fen])).toEqual([
      ['direct', 1100n, 110n],
      ['self', 1100n, 550n],
    ]);
    expect(await orderRow(a, o)).toMatchObject({ rebate_status: 'WAITING', commission_version: 2 });
    expect(await itemsFor(a, o)).toEqual([
      expect.objectContaining({ item_type: 'order', settle_seq: 1, b_settle_fen: 1100n }),
    ]);
    expect((await batchesOf(a)).map((b) => [b.kind, b.status, b.order_count])).toEqual([
      ['main', 'DRAFT', 1],
    ]);
    expect(allAlerts(billed.lines)).toEqual([]);
    expect(await diffsOf(a)).toEqual(diffsBefore);
    expect(await countsOf(a)).toEqual({
      error_count: 0,
      held_count: 0,
      unsettled_count: 0,
      amount_mismatch_count: 0,
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-18#49] 生产账单日的缺省上限是 500（评审第 2 条；worker 生产装配、不注入上限）：501 张重生成会成功的单（自拟：快照 1200、联盟结算 1000）——只有来源顺序前 500 张推进到 v2（基数 1000）并入主批次（b_settle 1000），最后一张版本原样（只有 v1 基数 1200）、保持 WAITING、不入批；settle_regeneration_deferred 恰一条（run bill、deferred_count 1、不带订单号与 alert）；不告警、不登记差错单、四个计数都为 0',
  async () => {
    const base = fixture(s, AT_BILL_DAY);
    const a = await billDayApp(base);
    const orders = await seedMany(a, { count: 501, snapshotN: 1200n, settleFen: 1000n });
    const first = orders[0]!;
    const last = orders[500]!;

    const billed = await billVia(a, a.db, LARGE_RUN_MS);

    expect(shown(billed.outcome)).toBe('ok');
    const versions = await versionByOrder(a);
    expect(orders.slice(0, 500).filter((o) => versions.get(o.orderId) === 2)).toHaveLength(500);
    expect(versions.get(last.orderId)).toBe(1);
    expect(await basesOf(a, first)).toEqual([
      [1, 1200n],
      [2, 1000n],
    ]);
    expect(await amountsAt(a, first, 2)).toEqual(regeneratedRows(a, first));
    expect(await basesOf(a, last)).toEqual([[1, 1200n]]);
    expect(await orderRow(a, last)).toMatchObject({
      rebate_status: 'WAITING',
      commission_version: 1,
    });
    const items = await itemsOf(a);
    expect(items).toHaveLength(500);
    expect(items.every((i) => i.b_settle_fen === 1000n)).toBe(true);
    expect(items.some((i) => i.order_id === last.orderId)).toBe(false);
    expect((await batchesOf(a)).map((b) => [b.kind, b.status, b.order_count])).toEqual([
      ['main', 'DRAFT', 500],
    ]);
    expect(deferredSummary(billed.lines, orders)).toEqual({
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
    expect(allAlerts(billed.lines)).toEqual([]);
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

it(
  '[AC-B2-18#50] 后台补充的缺省上限也是 500（评审第 2 条；真实后台生产入口、不注入上限；账单 2026-09 已出过结果、没有草稿批次）：501 张重生成会成功的单（自拟：快照 1200、联盟结算 1000）——请求 200；只有来源顺序前 500 张推进到 v2（基数 1000）并入一个补充批次（b_settle 1000），最后一张版本原样、保持 WAITING、不入批；settle_regeneration_deferred 恰一条（run supplement、deferred_count 1、不带订单号与 alert）；不告警、不登记差错单、账单行不回写',
  async () => {
    const f = fixture(s);
    const a = await supplementApp(f);
    const orders = await seedMany(a, { count: 501, snapshotN: 1200n, settleFen: 1000n });
    const first = orders[0]!;
    const last = orders[500]!;
    const billsBefore = (await everything(f)).bills;
    const seen: { outcome?: Outcome<{ statusCode: number; body: string }>; lines: LogLine[] } = {
      lines: [],
    };

    await withSupplementAdmin(f, async (h) => {
      seen.lines = h.lines;
      seen.outcome = await within(
        h.supplement(SUPPLEMENT_BILL, { platform: TAOBAO }),
        'supplement',
        LARGE_RUN_MS,
      );
    });

    expect(shown(seen.outcome)).toBe('ok');
    const sent = seen.outcome?.ok === true ? seen.outcome.value : undefined;
    expect(sent?.statusCode, sent?.body).toBe(200);
    const versions = await versionByOrder(a);
    expect(orders.slice(0, 500).filter((o) => versions.get(o.orderId) === 2)).toHaveLength(500);
    expect(versions.get(last.orderId)).toBe(1);
    expect(await basesOf(a, first)).toEqual([
      [1, 1200n],
      [2, 1000n],
    ]);
    expect(await amountsAt(a, first, 2)).toEqual(regeneratedRows(a, first));
    expect(await placedIn(a, first)).toEqual(['supplement']);
    expect(await basesOf(a, last)).toEqual([[1, 1200n]]);
    expect(await orderRow(a, last)).toMatchObject({
      rebate_status: 'WAITING',
      commission_version: 1,
    });
    const items = await itemsOf(a);
    expect(items).toHaveLength(500);
    expect(items.every((i) => i.b_settle_fen === 1000n)).toBe(true);
    expect(items.some((i) => i.order_id === last.orderId)).toBe(false);
    expect((await batchesOf(a)).map((b) => [b.kind, b.status, b.order_count])).toEqual([
      ['supplement', 'DRAFT', 500],
    ]);
    expect(deferredSummary(seen.lines, orders)).toEqual({
      events: [
        {
          level: WARN_LEVEL,
          app_id: a.appId,
          bill_id: SUPPLEMENT_BILL,
          platform: TAOBAO,
          run: 'supplement',
          deferred_count: 1,
          alert: false,
          order_id: false,
        },
      ],
      leaks: [],
    });
    expect(allAlerts(seen.lines)).toEqual([]);
    expect(await diffsOf(a)).toEqual([]);
    expect((await everything(f)).bills).toEqual(billsBefore);
  },
  TIMEOUT,
);
