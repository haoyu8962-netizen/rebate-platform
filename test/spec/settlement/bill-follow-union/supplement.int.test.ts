// B2-18：补充发起经后台入口的生产装配（createHttpApp('admin') → POST /admin/v1/settle-bills/{bill_id}/
// supplement-batches）遇金额不一致，同账单日任务按 R7 以联盟结算数据重生成后再校验：一致的进补充批次、不登记
// 差错单；重生成失败、联盟结算 0 而快照基数 > 0 的不入批、不登记差错单、告警工程；补充不回写账单的计数列；工程把
// 快照修好之后再对同一账单发起补充，该单入补充批次。真实订单行与分佣快照（./kit.ts seedOrder），账单行按后台夹具。
// 第 3 次写测：后台入口改由本目录 kit 的 withSupplementAdmin 起（与 ../admin-settle-commands/kit.ts
// withCommandsAdmin 同一生产装配，只把根 logger 换成收集日志的，冻结 kit 不改）；补充批次确认后经 worker 的生产
// 处理器真实入账。顶层 it()（规划/11 §4.3）。
import { expect, it } from 'vitest';
import {
  countReconDiffOpen,
  getReconDiffs,
  lockReconDiffForRestore,
  readCreditPostcheckOpen,
  readReconDiffForRestore,
  readUnionAuthoritativeOrderKeys,
} from '../../../../apps/api/src/modules/ledger/index.ts';
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
  type Fixture,
} from '../admin-settle-commands/kit.ts';
import {
  EXAMPLE_PEOPLE,
  INJECTED_READ,
  TIMEOUT,
  admin,
  alertsFor,
  allAlerts,
  amountsAt,
  app,
  availables,
  batchesOf,
  byRole,
  confirmDrafts,
  creditKey,
  diffsOf,
  engineeringVersion,
  errorText,
  expectAlertShape,
  failVersionWrite,
  idempotencyKey,
  isReconDiffsRead,
  itemWriteFault,
  itemsFor,
  ledgerOf,
  orderRow,
  pendingOf,
  platformKey,
  platformLines,
  reconDiffsReadFault,
  regenerationAndItemWrites,
  seedOrder,
  setConfig,
  settleLater,
  splitOf,
  syncEstimate,
  unionConclusion,
  userCreditLines,
  versionRows,
  versionsOf,
  voucherLines,
  withSupplementAdmin,
  withWorker,
  within,
  type App,
  type LogLine,
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

/** 本应用全部 DRAFT 批次确认为立即结算后，经 worker 的生产处理器逐批 batch_execute（有界、不抛）。 */
async function confirmAndExecute(a: App, batchIds: readonly string[]): Promise<string[]> {
  await confirmDrafts(a, await admin(a));
  const results: string[] = [];
  await withWorker(a, async (w) => {
    for (const id of batchIds) {
      const outcome = await within(w.execute(id), 'execute');
      results.push(outcome.ok ? 'ok' : errorText(outcome.error));
    }
  });
  return results;
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
    const availableBefore = await availables(a, [o.user('self'), o.user('direct')]);
    const launchedIds: string[] = [];

    await withSupplementAdmin(f, async (h) => {
      const { bills } = await everything(f);
      const data = await launched(await h.supplement(BILL_ID, TAOBAO));
      expect(data.outcome).toBe('generated');
      expect(data.batch_ids).toHaveLength(1);
      launchedIds.push(...data.batch_ids);

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

      // 评审第 5 条：生产后台补充遇零结算 → 同一事件、同样字段的一条告警（后台根 logger 收集）。
      const zeroAlerts = alertsFor(h.lines, zero);
      expect(zeroAlerts).toHaveLength(1);
      expectAlertShape(zeroAlerts[0]!, a, zero, BILL_ID);
      expect(alertsFor(h.lines, o)).toEqual([]);
      expect(alertsFor(h.lines, ok)).toEqual([]);
      expect(allAlerts(h.lines)).toHaveLength(1);
      expect((await orderRow(a, zero)).rebate_status).toBe('WAITING');

      // 评审第 9 条：重生成入批之后、补充批次仍 DRAFT 时，该单没有任何凭证与分录、余额不动、仍 WAITING。
      expect((await batchesOf(a)).map((b) => [b.kind, b.status])).toEqual([
        ['supplement', 'DRAFT'],
      ]);
      expect(await ledgerOf(a, o)).toEqual({ keys: [], entries: 0 });
      expect(await availables(a, [o.user('self'), o.user('direct')])).toEqual(availableBefore);
      expect((await orderRow(a, o)).rebate_status).toBe('WAITING');
    });

    // 补充批次实际入账：确认后经同一生产处理器 R5，按 v2 入账例 2 的 550 / 110 / 440，恰好一组正式凭证。
    const executed = await confirmAndExecute(a, launchedIds);
    expect(executed).toEqual(['ok']);
    expect(await itemsFor(a, o)).toEqual([expect.objectContaining({ result: 'credited' })]);
    expect(await orderRow(a, o)).toMatchObject({
      rebate_status: 'CREDITED',
      commission_version: 2,
      booked_base_fen: 1100n,
    });
    expect(await voucherLines(a, creditKey(o, 'self'))).toEqual(userCreditLines(o, 'self', 550n));
    expect(await voucherLines(a, creditKey(o, 'direct'))).toEqual(
      userCreditLines(o, 'direct', 110n),
    );
    expect(await voucherLines(a, platformKey(o))).toEqual(platformLines(o, 440n));
    expect((await ledgerOf(a, o)).keys).toEqual(
      [creditKey(o, 'self'), creditKey(o, 'direct'), platformKey(o)].sort(),
    );
    expect(await availables(a, [o.user('self'), o.user('direct')])).toEqual([550n, 110n]);
    expect(await ledgerOf(a, zero)).toEqual({ keys: [], entries: 0 });
    expect((await orderRow(a, zero)).rebate_status).toBe('WAITING');
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

    await withSupplementAdmin(f, async (h) => {
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
      // 评审第 5 条：生产后台补充遇重生成写入失败 → 同一事件、同样字段的一条告警。
      const alerts = alertsFor(h.lines, o);
      expect(alerts).toHaveLength(1);
      expectAlertShape(alerts[0]!, a, o, BILL_ID);
      expect(allAlerts(h.lines)).toHaveLength(1);

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
      // 修好之后一致：不再告警。
      expect(alertsFor(h.lines, o)).toHaveLength(1);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-18#21] 混合来源触发重生成（后台补充，BR-FUND-09 R1 明细优先）：快照基数 1234；STATEMENT seq 1 结算 1100、之后到的 API seq 2 结算 1000 → 按 STATEMENT 的 1100 重生成 v2（550 / 110），补充批次明细 b_settle 1100、settle_seq 取整单最大 seq 2（同 [AC-B2-04zp#14]）；不告警、不登记差错单；确认后 R5 按 seq 2 校验通过、按 1100 入账 550 / 110 / 440',
  async () => {
    const f = fixture(s);
    const a = await appOf(f);
    const o = await seedOrder(a, {
      snapshotN: 1234n,
      settleFen: null,
      settlements: [
        { seq: 1, source: 'STATEMENT', fen: 1100n },
        { seq: 2, source: 'API', fen: 1000n },
      ],
      people: EXAMPLE_PEOPLE,
    });
    const seen: { status?: number; body?: string; lines: LogLine[] } = { lines: [] };

    await withSupplementAdmin(f, async (h) => {
      const sent = await h.supplement(BILL_ID, TAOBAO);
      seen.status = sent.statusCode;
      seen.body = sent.body;
      seen.lines = h.lines;
    });
    const batches = await batchesOf(a);

    expect(seen.status, seen.body).toBe(200);
    expect(allAlerts(seen.lines)).toEqual([]);
    // 决定金额的记录：STATEMENT seq 1 的 1100（预留 0）；按最大 seq 的 API 1000 重生成的错实现得 1000。
    expect(await bases(a, o)).toEqual([
      [1, 1234n],
      [2, 1100n],
    ]);
    expect(
      (await versionsOf(a, o)).amounts
        .filter((r) => r.commission_version === 2)
        .map((r) => [r.role, r.base_fen, r.amount_fen]),
    ).toEqual([
      ['direct', 1100n, 110n],
      ['self', 1100n, 550n],
    ]);
    // 明细的 settle_seq：截点内整单最大 seq 2。
    expect(await itemsFor(a, o)).toEqual([
      expect.objectContaining({ item_type: 'order', settle_seq: 2, b_settle_fen: 1100n }),
    ]);
    expect(batches.map((b) => [b.kind, b.status])).toEqual([['supplement', 'DRAFT']]);
    expect(await diffsOf(a)).toEqual([]);

    const executed = await confirmAndExecute(
      a,
      batches.map((b) => b.batch_id),
    );

    expect(executed).toEqual(['ok']);
    expect(await itemsFor(a, o)).toEqual([expect.objectContaining({ result: 'credited' })]);
    expect(await orderRow(a, o)).toMatchObject({
      rebate_status: 'CREDITED',
      commission_version: 2,
      booked_base_fen: 1100n,
    });
    expect(await voucherLines(a, creditKey(o, 'self'))).toEqual(userCreditLines(o, 'self', 550n));
    expect(await voucherLines(a, creditKey(o, 'direct'))).toEqual(
      userCreditLines(o, 'direct', 110n),
    );
    expect(await voucherLines(a, platformKey(o))).toEqual(platformLines(o, 440n));
  },
  TIMEOUT,
);

it(
  '[AC-B2-18#23] 重生成与补充批次同一事务（D10-2415）：后台补充（生产装配）里真实重生成成功之后、写补充批次明细那一步在库层故障 → 接口 500；该单版本行仍只有 v1、orders.commission_version 仍 1、待入账预估仍 617、账单行与批次 / 明细 / 差错单都没有新增；同一 Idempotency-Key 重试成功：v2 只追加一次（基数 1100），补充批次与明细各一份',
  async () => {
    const base = fixture(s);
    const a = await appOf(base);
    const o = await example2(a);
    const fault = itemWriteFault(base.db);
    const f: Fixture = { ...base, db: fault.db };
    const key = idempotencyKey();
    // 取数（不断言）：一单与本应用的状态。
    const probe = async () => ({
      versions: await versionsOf(a, o),
      version: (await orderRow(a, o)).commission_version,
      pending: (await pendingOf(a, o.user('self'))).pending_credit_fen,
      all: await everything(base),
    });
    const before = await probe();
    const seen: {
      first?: { status: number; body: string };
      afterFailure?: Awaited<ReturnType<typeof probe>>;
      failedQueries: ReturnType<typeof itemWriteFault>['queries'];
      second?: { status: number; body: string };
    } = { failedQueries: [] };

    await withSupplementAdmin(f, async (h) => {
      const first = await h.supplement(BILL_ID, TAOBAO, { key });
      seen.first = { status: first.statusCode, body: first.body };
      seen.failedQueries = [...fault.queries];
      seen.afterFailure = await probe();
      fault.disarm();
      const second = await h.supplement(BILL_ID, TAOBAO, { key });
      seen.second = { status: second.statusCode, body: second.body };
    });

    // 第一次：重生成先于写明细，明细写入故障让整笔回滚。
    expect(seen.first?.status, seen.first?.body).toBe(500);
    expect(fault.fired).toBeGreaterThanOrEqual(1);
    const order = regenerationAndItemWrites(seen.failedQueries, o.orderId);
    expect(order.totals, 'v2 written in the supplement transaction').toBeGreaterThan(-1);
    expect(order.items).toBeGreaterThan(order.totals);
    // 自购 1234 × 5000 / 10000 = 617：仍按 v1。
    expect(before.pending).toBe(617n);
    expect(seen.afterFailure?.versions).toEqual(before.versions);
    expect(seen.afterFailure?.version).toBe(1);
    expect(seen.afterFailure?.pending).toBe(617n);
    expect(seen.afterFailure?.all.bills).toEqual(before.all.bills);
    expect(seen.afterFailure?.all.batches).toEqual(before.all.batches);
    expect(seen.afterFailure?.all.items).toEqual(before.all.items);
    expect(seen.afterFailure?.all.diffs).toEqual(before.all.diffs);
    expect(seen.afterFailure?.all.vouchers).toEqual(before.all.vouchers);

    // 同键重试：只追加一个 v2，补充批次与明细各一份。
    expect(seen.second?.status, seen.second?.body).toBe(200);
    expect(await bases(a, o)).toEqual([
      [1, 1234n],
      [2, 1100n],
    ]);
    expect((await orderRow(a, o)).commission_version).toBe(2);
    expect((await pendingOf(a, o.user('self'))).pending_credit_fen).toBe(550n);
    expect((await batchesOf(a)).map((b) => [b.kind, b.status, b.order_count])).toEqual([
      ['supplement', 'DRAFT', 1],
    ]);
    expect(await itemsFor(a, o)).toEqual([
      expect.objectContaining({ item_type: 'order', settle_seq: 1, b_settle_fen: 1100n }),
    ]);
    expect(await diffsOf(a)).toEqual([]);
    expect((await everything(base)).bills).toEqual(before.all.bills);
  },
  TIMEOUT,
);

it(
  '[AC-B2-18#25] 后台补充同样不看容差拦下零结算（编排 D10-2415 ④(i)、D10-2532）：容差 5 分、结算 0、基数 3 → 不重生成、不入批、告警工程一次、保持 WAITING，账单计数列不回写；对照：基数 0 结算 0 仍入补充批次（b_settle 0），基数 1103 结算 1100 在容差内直接入批、不重生成、不告警；不登记差错单',
  async () => {
    const f = fixture(s);
    const a = await appOf(f);
    await setConfig(a, 'settle.batch.match_tolerance_fen', '5');
    // 自拟（预留 0）：基数 3 / 结算 0；基数 0 / 结算 0；基数 1103 / 结算 1100（差 3 ≤ 5）。
    const zero = await seedOrder(a, { snapshotN: 3n, settleFen: 0n, people: EXAMPLE_PEOPLE });
    const bothZero = await seedOrder(a, { snapshotN: 0n, settleFen: 0n, people: EXAMPLE_PEOPLE });
    const near = await seedOrder(a, { snapshotN: 1103n, settleFen: 1100n, people: EXAMPLE_PEOPLE });
    const before = {
      zero: await versionsOf(a, zero),
      bothZero: await versionsOf(a, bothZero),
      near: await versionsOf(a, near),
      bills: (await everything(f)).bills,
    };
    const seen: { status?: number; body?: string; lines: LogLine[] } = { lines: [] };

    await withSupplementAdmin(f, async (h) => {
      const sent = await h.supplement(BILL_ID, TAOBAO);
      seen.status = sent.statusCode;
      seen.body = sent.body;
      seen.lines = h.lines;
    });

    expect(seen.status, seen.body).toBe(200);
    const alerts = alertsFor(seen.lines, zero);
    expect(alerts).toHaveLength(1);
    expectAlertShape(alerts[0]!, a, zero, BILL_ID);
    expect(allAlerts(seen.lines)).toHaveLength(1);
    expect(await versionsOf(a, zero)).toEqual(before.zero);
    expect(await orderRow(a, zero)).toMatchObject({
      rebate_status: 'WAITING',
      commission_version: 1,
    });
    expect(await itemsFor(a, zero)).toEqual([]);
    expect(await versionsOf(a, bothZero)).toEqual(before.bothZero);
    expect(await itemsFor(a, bothZero)).toEqual([expect.objectContaining({ b_settle_fen: 0n })]);
    expect(await versionsOf(a, near)).toEqual(before.near);
    expect(await itemsFor(a, near)).toEqual([expect.objectContaining({ b_settle_fen: 1100n })]);
    expect(await diffsOf(a)).toEqual([]);
    expect((await everything(f)).bills).toEqual(before.bills);
  },
  TIMEOUT,
);

// ---------------------------------------------------------------------------------------------
// 第 4 次写测（编排 D10-2544，任务书 §12）。断言都在用例体里；后台回调里只发请求与取数。

it(
  '[AC-B2-18#33] 后台补充（真实后台生产入口）不读 recon_diffs（D10-2415；第 5 次写测改为白名单，编排 D10-2567）：快照 1234、结算 1100 的 WAITING 单另有一张已结案、结论「以联盟为准」的旧差错单；在这次请求所用的数据库执行器上，凡是把 recon_diffs 当读取对象的语句（任何 SELECT——含 SELECT *、整列 resolution、子查询、EXISTS、CTE、JOIN——以及 INSERT … SELECT / UPDATE … FROM 的数据来源；纯写入的 INSERT … VALUES / ON CONFLICT DO NOTHING 不算；允许清单为空）一执行就抛错并计数 → 请求 200，违规读取 0 次；探针自检：专用结论读口与 ledger 的通用读口（getReconDiffs 按单与按应用、恢复用的按 id 读与加锁读、未结计数、入账后核对 gauge）经同一执行器各调一次都被拦下；该单按 1100 重生成 v2（550 / 110）并入补充批次，明细恰好一份（b_settle 1100、settle_seq 1）；不告警、旧差错单原样不新增、账单行不回写',
  async () => {
    const base = fixture(s);
    const a = await appOf(base);
    const o = await example2(a);
    await unionConclusion(a, o, 1234n, 1100n);
    const diffsBefore = await diffsOf(a);
    const billsBefore = (await everything(base)).bills;
    const diffId = diffsBefore[0]?.id ?? 'no recon diff seeded';
    // 观察与故障装在后台入口所用的执行器上（dbHandles.db = f.db）；不替换任何端口、不改冻结 kit。判定规则与允许
    // 清单（空，零读取）见 kit isReconDiffsRead / RECON_DIFFS_READ_ALLOWLIST 的注释。
    const fault = reconDiffsReadFault(base.db);
    const f: Fixture = { ...base, db: fault.db };

    // 判定规则的形状自检（纯函数，取数；断言在下面）：这些都是「读」，那些是纯写入或别的表。
    const readShapes = [
      'select * from "app"."recon_diffs" where "app_id" = $1 and "ref_id" = $2 and "status" = $3',
      'select "resolution" from "app"."recon_diffs" where "id" = $1 for update',
      'select exists (select 1 from app.recon_diffs as d where d.ref_id = $1) as concluded',
      'with c as (select d.resolution from app.recon_diffs as d) select * from c',
      'select o.order_id from app.orders as o inner join app.recon_diffs as d on d.ref_id = $1',
      'insert into "app"."audit" ("ref") select "id" from "app"."recon_diffs" where "app_id" = $1',
      'update "app"."orders" set "x" = d."y" from "app"."recon_diffs" as d where d."id" = $1',
      'insert into "app"."recon_diffs" ("id") values ($1) on conflict ("id") do update set "id" = $1 returning *',
      'update "app"."recon_diffs" set "updated_at" = $1 where "id" = $2 returning "resolution"',
    ];
    const writeShapes = [
      'insert into "app"."recon_diffs" ("id", "app_id") values ($1, $2) on conflict do nothing returning *',
      'insert into app.recon_diffs (id) values ($1)',
      'insert into "app"."recon_diffs" ("id") values ($1) on conflict on constraint recon_diffs_business_key do nothing',
      'select * from "app"."orders" where "app_id" = $1',
    ];
    const missedReads = readShapes.filter((q) => !isReconDiffsRead(q));
    const flaggedWrites = writeShapes.filter((q) => isReconDiffsRead(q));

    // 探针自检（取数；断言在下面）：经同一执行器直接调专用读口与 ledger 公开的、能读到已结案差错单（或这张表）的
    // 每个读口各一次——每一次都必须被计为违规并抛错，证明白名单拦得住这些路径。
    const conclusionKeys = { appId: a.appId, orderKeys: [o.orderKey] };
    const closedOfOrder = { appId: a.appId, orderKey: o.orderKey, status: 'closed' as const };
    const restoreRead = fault.db.transaction();
    const restoreLock = fault.db.transaction();
    const probes: [string, () => Promise<unknown>][] = [
      [
        'readUnionAuthoritativeOrderKeys',
        () => readUnionAuthoritativeOrderKeys(fault.db, conclusionKeys),
      ],
      ['getReconDiffs by order, closed', () => getReconDiffs(fault.db, closedOfOrder)],
      ['getReconDiffs of the app', () => getReconDiffs(fault.db, { appId: a.appId })],
      [
        'readReconDiffForRestore',
        () => restoreRead.execute((trx) => readReconDiffForRestore(trx, a.appId, diffId)),
      ],
      [
        'lockReconDiffForRestore',
        () => restoreLock.execute((trx) => lockReconDiffForRestore(trx, a.appId, diffId)),
      ],
      ['countReconDiffOpen', () => countReconDiffOpen(fault.db, a.appId)],
      ['readCreditPostcheckOpen', () => readCreditPostcheckOpen(fault.db)],
    ];
    const probeResults: [string, string][] = [];
    for (const [name, read] of probes) {
      const outcome = await within(read(), `probe: ${name}`);
      probeResults.push([name, outcome.ok ? 'not rejected' : errorText(outcome.error)]);
    }
    const probed = { executed: fault.executed, fired: fault.fired, statements: fault.statements };
    const seen: { status?: number; body?: string; lines: LogLine[] } = { lines: [] };

    await withSupplementAdmin(f, async (h) => {
      const sent = await h.supplement(BILL_ID, TAOBAO);
      seen.status = sent.statusCode;
      seen.body = sent.body;
      seen.lines = h.lines;
    });

    expect(missedReads).toEqual([]);
    expect(flaggedWrites).toEqual([]);
    const rejected = probes.map(([name]) => [name, expect.stringContaining(INJECTED_READ)]);
    expect(probeResults).toEqual(rejected);
    expect(probed).toMatchObject({ executed: probes.length, fired: probes.length });

    // 请求成功，且这次请求里对 recon_diffs 的读取一次都没执行（观察确实装在请求的执行器上：其间经过了别的语句）。
    expect(seen.status, seen.body).toBe(200);
    expect(fault.violations.slice(probed.executed)).toEqual([]);
    expect(fault.executed - probed.executed).toBe(0);
    expect(fault.fired - probed.fired).toBe(0);
    expect(fault.statements).toBeGreaterThan(probed.statements);
    expect(allAlerts(seen.lines)).toEqual([]);

    // 按 9.2 第 1–3 条：重生成 v2（基数 = B_settle 1100，例 2 的 550 / 110）并入补充批次。
    expect(await bases(a, o)).toEqual([
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
      ['supplement', 'DRAFT', 1],
    ]);
    expect(await diffsOf(a)).toEqual(diffsBefore);
    expect((await everything(base)).bills).toEqual(billsBefore);
  },
  TIMEOUT,
);

it.each([
  {
    label: '另有一张已结案、结论「以联盟为准」的旧差错单（金额 1234 / 1100，退款前结的案）',
    concluded: true,
  },
  { label: '没有旧结论', concluded: false },
])(
  '[AC-B2-18#34] 新版本号 = 当前最大版本 + 1（BR-FUND-04 ④⑧、D10-2415；被删旧用例 monthly [AC-B2-09h#21] 的状态）——$label：v1 基数 1234，部分退款后订单同步把预估改为 600、commission 真实 refresh 写出 v2（基数 600），联盟结算 1100 后到；后台补充（真实后台入口）只追加一个 v3（基数 1100、550 / 110），orders.commission_version = 3，v1、v2 逐字不变；补充批次明细恰好一份（b_settle 1100）；不告警、不登记差错单、账单行不回写',
  async ({ concluded }) => {
    const f = fixture(s);
    const a = await appOf(f);
    // 例 2 的快照（预留 0）：v1 取 N 1234 → 基数 1234；先没有联盟结算数据（有结算佣金时预估变化不推版本）。
    const o = await seedOrder(a, { snapshotN: 1234n, settleFen: null, people: EXAMPLE_PEOPLE });
    if (concluded) await unionConclusion(a, o, 1234n, 1100n);
    // 部分退款：联盟回传的新预估 600（预留 0 → 基数 600），经生产途径（orders 列计划 + rebate.onUpdated R7 →
    // commission refresh）推进到 v2，不手写版本行。
    await syncEstimate(a, o, 600n);
    const refunded = {
      bases: await bases(a, o),
      version: (await orderRow(a, o)).commission_version,
      versions: await versionsOf(a, o),
    };
    // 联盟结算后到：STATEMENT seq 1 结算 1100（预留 0 → B_settle 1100）。
    await settleLater(a, o, { seq: 1, source: 'STATEMENT', fen: 1100n });
    const diffsBefore = await diffsOf(a);
    const billsBefore = (await everything(f)).bills;
    // v3 的期望：splitCommission 对同一输入（N 1100、预留 0、自购 5000 / 直推 1000bp）——例 2 的 550 / 110。
    const split = splitOf(o, 1100n);
    const seen: { status?: number; body?: string; lines: LogLine[] } = { lines: [] };

    await withSupplementAdmin(f, async (h) => {
      const sent = await h.supplement(BILL_ID, TAOBAO);
      seen.status = sent.statusCode;
      seen.body = sent.body;
      seen.lines = h.lines;
    });

    // 搭建结果：部分退款已把当前版本推进到 v2（基数 600）。
    expect(refunded.bases).toEqual([
      [1, 1234n],
      [2, 600n],
    ]);
    expect(refunded.version).toBe(2);
    expect(split.base).toBe(1100n);
    expect(split.shares).toEqual([550n, 110n]);

    expect(seen.status, seen.body).toBe(200);
    expect(allAlerts(seen.lines)).toEqual([]);
    // 只追加一个 v3（= 当前最大版本 2 + 1），基数 1100；固定写 v2 的错实现撞唯一约束、告警并留在 WAITING。
    expect(await bases(a, o)).toEqual([
      [1, 1234n],
      [2, 600n],
      [3, 1100n],
    ]);
    const after = await versionsOf(a, o);
    expect(after.totals.filter((t) => t.commission_version <= 2)).toEqual(refunded.versions.totals);
    expect(after.amounts.filter((r) => r.commission_version <= 2)).toEqual(
      refunded.versions.amounts,
    );
    expect(await amountsAt(a, o, 3)).toEqual(byRole(versionRows(o, 3, split, f.clock.now())));
    expect(await orderRow(a, o)).toMatchObject({ rebate_status: 'WAITING', commission_version: 3 });
    expect(await itemsFor(a, o)).toEqual([
      expect.objectContaining({ item_type: 'order', settle_seq: 1, b_settle_fen: 1100n }),
    ]);
    expect((await batchesOf(a)).map((b) => [b.kind, b.status, b.order_count])).toEqual([
      ['supplement', 'DRAFT', 1],
    ]);
    expect(await diffsOf(a)).toEqual(diffsBefore);
    expect((await everything(f)).bills).toEqual(billsBefore);
  },
  TIMEOUT,
);
