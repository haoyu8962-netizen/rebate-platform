// B2-18：账单日任务经生产装配（app.module 交给 SettlementModule.forWorker 的端口 → settle 处理器）遇金额不一致，
// 按 BR-FUND-04 ④（2026-11-21 改写）、细则校验结果表第 2 行、例 2 与 BR-FUND-01 R7 跟随联盟：同一事务以联盟结算
// 数据追加一个金额版本再校验一次，一致进批次候选、不登记差错单；仍不一致 / 重生成失败 / 联盟结算 0 而快照基数 > 0
// 的告警工程、保持 WAITING、计入 amount_mismatch_count。08 给了数的（例 2：1100 / 1234 / 550 / 110 / 440）照原文写；
// 自拟的金额在注释里写算式；带尾差的拆分期望取 @couli/domain splitCommission（commission 写版本行用的同一个函数）
// 对同一输入的结果。顶层 it()，不套 describe（规划/11 §4.3）。
import { createTestDatabase } from '@couli/db/testing';
import { addFen } from '@couli/money';
import { expect, it } from 'vitest';
import {
  BILL_MONTH,
  EXAMPLE_PEOPLE,
  THREE_PEOPLE,
  TIMEOUT,
  admin,
  alertsFor,
  allAlerts,
  amountsAt,
  app,
  availableOf,
  availables,
  batchesOf,
  billRow,
  byRole,
  confirmDrafts,
  countsOf,
  creditKey,
  creditOn,
  databaseFixture,
  diffsOf,
  errorText,
  expectAlertShape,
  failVersionWrite,
  itemsFor,
  itemsOf,
  ledgerOf,
  openDeduction,
  orderRow,
  pendingOf,
  platformKey,
  platformLines,
  seedOrder,
  setConfig,
  splitOf,
  unionConclusion,
  userCreditLines,
  versionRows,
  versionsOf,
  voucherKeys,
  voucherLines,
  withWorker,
  within,
  type App,
  type LogLine,
  type OrderSpec,
  type Outcome,
  type Seeded,
  type WorkerOptions,
} from './kit.ts';

const pools = databaseFixture(createTestDatabase);

/** 账单日一次出账后，本应用唯一的主批次 id。 */
async function onlyBatch(a: App): Promise<string> {
  const batches = await batchesOf(a);
  expect(batches).toHaveLength(1);
  return batches[0]!.batch_id;
}

/** 例 2 的一单：快照 v1 取 N 1234（预留 0，基数 1234，617 / 123），联盟结算 1100。 */
function example2(a: App, patch: Partial<OrderSpec> = {}): Promise<Seeded> {
  return seedOrder(a, { snapshotN: 1234n, settleFen: 1100n, people: EXAMPLE_PEOPLE, ...patch });
}

/** 自拟的一单（预留 0、自购 5000 / 直推 1000bp）：快照 v1 取 N snapshotN，联盟结算 settleFen。 */
function plain(a: App, snapshotN: bigint, settleFen: bigint, patch: Partial<OrderSpec> = {}) {
  return seedOrder(a, { snapshotN, settleFen, people: EXAMPLE_PEOPLE, ...patch });
}

/** 一单各版本的 [版本号, 基数]。 */
async function bases(a: App, o: Seeded): Promise<[number, bigint][]> {
  return (await versionsOf(a, o)).totals.map((t): [number, bigint] => [
    t.commission_version,
    t.base_fen,
  ]);
}

it(
  '[AC-B2-18#1] BR-FUND-04 例 2（生产装配的账单日任务）：快照基数 1234、联盟结算 1100、容差 0 → 出账同一事务追加 v2（基数 1100、自购 550 / 直推 110，受益人与角色同 v1，v1 一字不动，created_at 取注入 Clock），orders.commission_version=2，进主批次（b_settle 1100、settle_seq 1），不登记差错单，四个计数都为 0；用户侧待入账随 v2；确认后经同一处理器 R5 入账 550 / 110 / 440',
  async () => {
    const a = await app(pools.db);
    await creditOn(a);
    const o = await example2(a);
    const before = await versionsOf(a, o);
    expect(before.totals.map((t) => t.base_fen)).toEqual([1234n]);
    const availableBefore = await availables(a, [o.user('self'), o.user('direct')]);

    await withWorker(a, async (w) => {
      await w.bill();

      expect(await diffsOf(a)).toEqual([]);
      expect(allAlerts(w.lines)).toEqual([]);
      expect(await countsOf(a)).toEqual({
        error_count: 0,
        held_count: 0,
        unsettled_count: 0,
        amount_mismatch_count: 0,
      });
      expect(await billRow(a)).toMatchObject({
        platform_order_counts: { taobao: 1 },
        platform_settle_commission_totals: { taobao: '1100' },
        beneficiary_total_fen: 660n,
        platform_retained_fen: 440n,
      });

      // 新版本：版本号 = 最大版本 + 1，基数 = B_settle = 1100（预留 0），各方 550 / 110。
      const after = await versionsOf(a, o);
      expect(after.totals).toEqual([
        before.totals[0],
        {
          commission_version: 2,
          base_fen: 1100n,
          user_share_total_fen: 660n,
          created_at: a.clock.now(),
        },
      ]);
      expect(after.amounts.filter((r) => r.commission_version === 1)).toEqual(before.amounts);
      expect(await amountsAt(a, o, 2)).toEqual(
        byRole([
          {
            commission_version: 2,
            user_id: o.user('self'),
            role: 'self',
            base_fen: 1100n,
            amount_fen: 550n,
            created_at: a.clock.now(),
          },
          {
            commission_version: 2,
            user_id: o.user('direct'),
            role: 'direct',
            base_fen: 1100n,
            amount_fen: 110n,
            created_at: a.clock.now(),
          },
        ]),
      );
      expect(await orderRow(a, o)).toMatchObject({
        rebate_status: 'WAITING',
        commission_version: 2,
      });

      const batchId = await onlyBatch(a);
      expect(await batchesOf(a)).toEqual([
        expect.objectContaining({
          bill_id: BILL_MONTH,
          platform: 'taobao',
          kind: 'main',
          status: 'DRAFT',
          order_count: 1,
        }),
      ]);
      expect(await itemsOf(a)).toEqual([
        expect.objectContaining({
          batch_id: batchId,
          item_type: 'order',
          order_id: o.orderId,
          settle_seq: 1,
          b_settle_fen: 1100n,
          result: null,
        }),
      ]);
      // 用户侧待入账预估读订单当前版本（v2）的快照：自购 1100 × 5000 / 10000 = 550。
      expect((await pendingOf(a, o.user('self'))).pending_credit_fen).toBe(550n);
      // 评审第 9 条（BR-FUND-04 ⑥⑦ 未确认不得入账；BR-FUND-09 R1 WAITING 不走首次入账）：重生成并入批之后、
      // 批次仍 DRAFT 时，该单没有任何凭证与分录，各受益人可提现余额与出账前相同，订单仍 WAITING——重生成只改
      // 快照版本与待入账预估。
      expect((await batchesOf(a)).map((b) => b.status)).toEqual(['DRAFT']);
      expect(await ledgerOf(a, o)).toEqual({ keys: [], entries: 0 });
      expect(await availables(a, [o.user('self'), o.user('direct')])).toEqual(availableBefore);
      expect((await orderRow(a, o)).rebate_status).toBe('WAITING');

      await confirmDrafts(a, await admin(a));
      await w.execute(batchId);
    });

    // 确认并执行后才出现恰好一组正式凭证（本人、直推、平台各一张）。
    expect((await ledgerOf(a, o)).keys).toEqual(
      [creditKey(o, 'self'), creditKey(o, 'direct'), platformKey(o)].sort(),
    );
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
    expect(await availableOf(a, o.user('self'))).toBe(550n);
    expect(await availableOf(a, o.user('direct'))).toBe(110n);
    expect(await diffsOf(a)).toEqual([]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-18#2] 新版本的形状（自拟，预留 1500bp、5000 / 1000 / 500bp）：联盟多结（1300 → B 1105）与少结（800 → B 680）都只追加一版、基数取 B_settle，各方金额与 splitCommission 同一输入的结果相等、各方之和 + 平台 = 新基数；联盟再结算以 seq 2 的 1200（B 1020）重生成、明细 settle_seq 2；金额一致的单（1000 → B 850 = 基数）不追加版本；账单合计按新基数',
  async () => {
    const a = await app(pools.db);
    await creditOn(a);
    // 快照 v1 都取 N 1000：基数 floor(1000 × 8500 / 10000) = 850。
    const spec = { snapshotN: 1000n, reserveBp: 1500, people: THREE_PEOPLE } as const;
    // floor(1300 × 8500 / 10000) = 1105（联盟多结，正差）。
    const up = await seedOrder(a, { ...spec, settleFen: 1300n });
    // floor(800 × 8500 / 10000) = 680（联盟少结，负差）。
    const down = await seedOrder(a, { ...spec, settleFen: 800n });
    // floor(1000 × 8500 / 10000) = 850 = 快照基数：不重生成。
    const same = await seedOrder(a, { ...spec, settleFen: 1000n });
    // 两条 API 记录，决定金额的是 seq 2 的 1200：floor(1200 × 8500 / 10000) = 1020。
    const resettled = await seedOrder(a, {
      ...spec,
      settleFen: null,
      settlements: [
        { seq: 1, source: 'API', fen: 1000n },
        { seq: 2, source: 'API', fen: 1200n },
      ],
    });
    const sameBefore = await versionsOf(a, same);

    await withWorker(a, async (w) => {
      await w.bill();
    });

    const cases = [
      { o: up, n: 1300n, base: 1105n, seq: 1 },
      { o: down, n: 800n, base: 680n, seq: 1 },
      { o: resettled, n: 1200n, base: 1020n, seq: 2 },
    ];
    for (const { o, n, base, seq } of cases) {
      const split = splitOf(o, n);
      expect(split.base, o.orderKey).toBe(base);
      expect(split.shares.reduce((x, y) => addFen(x, y), split.retain)).toBe(base);
      expect(await bases(a, o)).toEqual([
        [1, 850n],
        [2, base],
      ]);
      expect(await amountsAt(a, o, 2)).toEqual(byRole(versionRows(o, 2, split, a.clock.now())));
      expect((await orderRow(a, o)).commission_version).toBe(2);
      expect(await itemsFor(a, o)).toEqual([
        expect.objectContaining({ item_type: 'order', settle_seq: seq, b_settle_fen: base }),
      ]);
    }
    expect(await versionsOf(a, same)).toEqual(sameBefore);
    expect((await orderRow(a, same)).commission_version).toBe(1);
    expect(await itemsFor(a, same)).toEqual([
      expect.objectContaining({ item_type: 'order', settle_seq: 1, b_settle_fen: 850n }),
    ]);

    const splits = [
      splitOf(up, 1300n),
      splitOf(down, 800n),
      splitOf(resettled, 1200n),
      splitOf(same, 1000n),
    ];
    const sum = (xs: readonly bigint[]) => xs.reduce((x, y) => addFen(x, y), 0n);
    expect(await billRow(a)).toMatchObject({
      platform_order_counts: { taobao: 4 },
      // 1300 + 800 + 1200 + 1000 = 4300。
      platform_settle_commission_totals: { taobao: '4300' },
      beneficiary_total_fen: sum(splits.map((s) => sum(s.shares))),
      platform_retained_fen: sum(splits.map((s) => s.retain)),
    });
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
  '[AC-B2-18#3] 重生成抛错（库层：写该单金额版本合计行的语句执行后失败）：该单告警工程一次（error 级、固定 alert、app_id / bill_id / order_id，不带子订单号与受益人）、不登记差错单、不计 error_count、amount_mismatch_count=1，保持 WAITING、版本号与金额行原样、不进批次；同账单另一张不一致单照常重生成入批、一致单照常入批（单张失败不拖垮整份账单）；之后执行批次也不以旧快照给它入账',
  async () => {
    const a = await app(pools.db);
    await creditOn(a);
    const broken = await example2(a);
    const fine = await example2(a);
    // 自拟：快照与结算都取 1000（预留 0）→ 基数 1000 = B_settle 1000。
    const matching = await plain(a, 1000n, 1000n);
    const brokenBefore = await versionsOf(a, broken);
    const fault = failVersionWrite(a.db, [broken.orderId]);

    await withWorker(
      a,
      async (w) => {
        await w.bill();
        expect(fault.fired).toBeGreaterThanOrEqual(1);

        const alerts = alertsFor(w.lines, broken);
        expect(alerts).toHaveLength(1);
        expectAlertShape(alerts[0]!, a, broken);
        expect(alertsFor(w.lines, fine)).toEqual([]);
        expect(alertsFor(w.lines, matching)).toEqual([]);

        expect(await diffsOf(a)).toEqual([]);
        expect(await countsOf(a)).toEqual({
          error_count: 0,
          held_count: 0,
          unsettled_count: 0,
          amount_mismatch_count: 1,
        });
        expect(await versionsOf(a, broken)).toEqual(brokenBefore);
        expect(await orderRow(a, broken)).toMatchObject({
          rebate_status: 'WAITING',
          commission_version: 1,
        });
        expect(await itemsFor(a, broken)).toEqual([]);
        expect((await orderRow(a, fine)).commission_version).toBe(2);
        expect(await itemsFor(a, fine)).toEqual([
          expect.objectContaining({ settle_seq: 1, b_settle_fen: 1100n }),
        ]);
        expect(await itemsFor(a, matching)).toEqual([
          expect.objectContaining({ settle_seq: 1, b_settle_fen: 1000n }),
        ]);
        // 合计只含入批的两单：1100 + 1000；受益人 660 + 600，平台 440 + 400。
        expect(await billRow(a)).toMatchObject({
          platform_order_counts: { taobao: 2 },
          platform_settle_commission_totals: { taobao: '2100' },
          beneficiary_total_fen: 1260n,
          platform_retained_fen: 840n,
        });

        const batchId = await onlyBatch(a);
        await confirmDrafts(a, await admin(a));
        await w.execute(batchId);
      },
      { db: fault.db },
    );

    expect(await orderRow(a, broken)).toMatchObject({
      rebate_status: 'WAITING',
      commission_version: 1,
    });
    expect((await voucherKeys(a)).some((key) => key.includes(broken.subOrderId))).toBe(false);
    expect((await orderRow(a, fine)).rebate_status).toBe('CREDITED');
    expect((await orderRow(a, matching)).rebate_status).toBe('CREDITED');
  },
  TIMEOUT,
);

it(
  '[AC-B2-18#4] 联盟结算佣金为 0 而快照基数 > 0：不作废、不重生成、告警工程、不登记差错单、amount_mismatch_count=1、保持 WAITING 不入批；快照基数与结算都为 0 的仍是候选（b_settle 0），也不追加版本',
  async () => {
    const a = await app(pools.db);
    await creditOn(a);
    // 自拟：快照 N 1000（预留 0）→ 基数 1000；联盟结算 0。
    const zeroSettle = await plain(a, 1000n, 0n);
    const bothZero = await plain(a, 0n, 0n);
    const zeroBefore = await versionsOf(a, zeroSettle);
    const bothBefore = await versionsOf(a, bothZero);

    await withWorker(a, async (w) => {
      await w.bill();
      const alerts = alertsFor(w.lines, zeroSettle);
      expect(alerts).toHaveLength(1);
      expectAlertShape(alerts[0]!, a, zeroSettle);
      expect(alertsFor(w.lines, bothZero)).toEqual([]);
    });

    expect(await versionsOf(a, zeroSettle)).toEqual(zeroBefore);
    expect(await orderRow(a, zeroSettle)).toMatchObject({
      rebate_status: 'WAITING',
      commission_version: 1,
    });
    expect(await itemsFor(a, zeroSettle)).toEqual([]);
    expect(await versionsOf(a, bothZero)).toEqual(bothBefore);
    expect(await itemsFor(a, bothZero)).toEqual([
      expect.objectContaining({ item_type: 'order', b_settle_fen: 0n }),
    ]);
    expect(await diffsOf(a)).toEqual([]);
    expect(await countsOf(a)).toEqual({
      error_count: 0,
      held_count: 0,
      unsettled_count: 0,
      amount_mismatch_count: 1,
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-18#5] 不该重生成的：hold、维权中的金额不一致单记暂缓（held_count 2），不比较、不追加版本；容差 5 分时差 3 分的直接候选（b_settle 1100）不追加版本，差 6 分的才重生成后入批；amount_mismatch_count=0',
  async () => {
    const a = await app(pools.db);
    await creditOn(a);
    await setConfig(a, 'settle.batch.match_tolerance_fen', '5');
    const held = await example2(a, { hold: true });
    const rights = await example2(a, { rightsPending: true });
    // 自拟（预留 0）：快照基数 1103 与 B_settle 1100 差 3 ≤ 5；1106 差 6 > 5。
    const near = await plain(a, 1103n, 1100n);
    const far = await plain(a, 1106n, 1100n);
    const before = {
      held: await versionsOf(a, held),
      rights: await versionsOf(a, rights),
      near: await versionsOf(a, near),
    };

    await withWorker(a, async (w) => {
      await w.bill();
      expect(allAlerts(w.lines)).toEqual([]);
    });

    expect(await versionsOf(a, held)).toEqual(before.held);
    expect(await versionsOf(a, rights)).toEqual(before.rights);
    expect(await versionsOf(a, near)).toEqual(before.near);
    for (const o of [held, rights, near]) {
      expect((await orderRow(a, o)).commission_version).toBe(1);
    }
    expect(await itemsFor(a, held)).toEqual([]);
    expect(await itemsFor(a, rights)).toEqual([]);
    expect(await itemsFor(a, near)).toEqual([expect.objectContaining({ b_settle_fen: 1100n })]);
    expect(await bases(a, far)).toEqual([
      [1, 1106n],
      [2, 1100n],
    ]);
    expect(await itemsFor(a, far)).toEqual([expect.objectContaining({ b_settle_fen: 1100n })]);
    expect(await countsOf(a)).toEqual({
      error_count: 0,
      held_count: 2,
      unsettled_count: 0,
      amount_mismatch_count: 0,
    });
    expect(await diffsOf(a)).toEqual([]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-18#6] credit.enabled 关着（缺省 off）的平台照样校验与重生成：不一致单追加 v2、重生成失败的单仍告警并计 amount_mismatch_count=1，只是不生成任何批次；不登记差错单',
  async () => {
    const a = await app(pools.db);
    const regenerated = await example2(a);
    const broken = await example2(a);
    const brokenBefore = await versionsOf(a, broken);
    const fault = failVersionWrite(a.db, [broken.orderId]);

    await withWorker(
      a,
      async (w) => {
        await w.bill();
        expect(alertsFor(w.lines, broken)).toHaveLength(1);
        expect(alertsFor(w.lines, regenerated)).toEqual([]);
      },
      { db: fault.db },
    );

    expect(await bases(a, regenerated)).toEqual([
      [1, 1234n],
      [2, 1100n],
    ]);
    expect((await orderRow(a, regenerated)).commission_version).toBe(2);
    expect(await versionsOf(a, broken)).toEqual(brokenBefore);
    expect(await batchesOf(a)).toEqual([]);
    expect(await itemsOf(a)).toEqual([]);
    expect(await billRow(a)).toMatchObject({ platform_order_counts: { taobao: 0 } });
    expect(await countsOf(a)).toEqual({
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
  '[AC-B2-18#7] 「以联盟为准」的结论不再读：同一金额状态（快照 1234、结算 1100）下，有没有一张已结案、结论 union 的差错单结果完全相同——重生成失败的两单都告警、都不入批；重生成成功的两单都按 1100 入批；已有差错单原样、不新增',
  async () => {
    const a = await app(pools.db);
    await creditOn(a);
    const concludedFail = await example2(a);
    const plainFail = await example2(a);
    const concludedOk = await example2(a);
    const plainOk = await example2(a);
    await unionConclusion(a, concludedFail, 1234n, 1100n);
    await unionConclusion(a, concludedOk, 1234n, 1100n);
    const diffsBefore = await diffsOf(a);
    const fault = failVersionWrite(a.db, [concludedFail.orderId, plainFail.orderId]);

    await withWorker(
      a,
      async (w) => {
        await w.bill();
        for (const o of [concludedFail, plainFail]) expect(alertsFor(w.lines, o)).toHaveLength(1);
        for (const o of [concludedOk, plainOk]) expect(alertsFor(w.lines, o)).toEqual([]);
      },
      { db: fault.db },
    );

    for (const o of [concludedFail, plainFail]) {
      expect(await itemsFor(a, o), o.orderKey).toEqual([]);
      expect(await orderRow(a, o)).toMatchObject({
        rebate_status: 'WAITING',
        commission_version: 1,
      });
    }
    for (const o of [concludedOk, plainOk]) {
      expect(await itemsFor(a, o), o.orderKey).toEqual([
        expect.objectContaining({ settle_seq: 1, b_settle_fen: 1100n }),
      ]);
      expect((await orderRow(a, o)).commission_version).toBe(2);
    }
    expect(await diffsOf(a)).toEqual(diffsBefore);
    expect(await countsOf(a)).toEqual({
      error_count: 0,
      held_count: 0,
      unsettled_count: 0,
      amount_mismatch_count: 2,
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-18#8] app_id 隔离：另一个应用有同平台、同样金额不一致（快照 1234、结算 1100）的单（子订单号不同：order_keys 主键是全局的平台 + 子订单号）——只给本应用出账时它的版本、订单行与账单都不动；之后给它出账只动它自己，本应用的单不再追加版本',
  async () => {
    const mine = await app(pools.db);
    const other = await app(pools.db);
    await creditOn(mine);
    await creditOn(other);
    const o = await example2(mine);
    const twin = await example2(other);
    expect(twin.platform).toBe(o.platform);
    const twinBefore = await versionsOf(other, twin);
    const twinRow = await orderRow(other, twin);

    await withWorker(mine, async (w) => {
      await w.bill();
    });
    expect((await bases(mine, o)).map(([v]) => v)).toEqual([1, 2]);
    expect(await versionsOf(other, twin)).toEqual(twinBefore);
    expect(await orderRow(other, twin)).toEqual(twinRow);
    expect(await billRow(other)).toBeUndefined();
    expect(await batchesOf(other)).toEqual([]);

    await withWorker(other, async (w) => {
      await w.bill();
    });
    expect((await bases(other, twin)).map(([v]) => v)).toEqual([1, 2]);
    expect((await bases(mine, o)).map(([v]) => v)).toEqual([1, 2]);
    expect((await orderRow(mine, o)).commission_version).toBe(2);
  },
  TIMEOUT,
);

it(
  '[AC-B2-18#9] 部分退款（有未抵完的扣减时 R5 自扣）：快照 1234、结算 1100、一条成功未应答的维权扣减 100 → 账单日按结算额重生成 v2（基数 1100）、b_settle 1100 入批；执行时 R5 以 1100 − 100 = 1000 入账，自拟 500 / 100 / 400（1000 × 5000 / 10000、× 1000 / 10000、余额归平台）',
  async () => {
    const a = await app(pools.db);
    await creditOn(a);
    const o = await example2(a);
    await openDeduction(a, o, 100n);

    await withWorker(a, async (w) => {
      await w.bill();
      expect(await bases(a, o)).toEqual([
        [1, 1234n],
        [2, 1100n],
      ]);
      expect(await itemsFor(a, o)).toEqual([
        expect.objectContaining({ settle_seq: 1, b_settle_fen: 1100n }),
      ]);
      expect(await diffsOf(a)).toEqual([]);
      const batchId = await onlyBatch(a);
      await confirmDrafts(a, await admin(a));
      await w.execute(batchId);
    });

    expect(await orderRow(a, o)).toMatchObject({
      rebate_status: 'CREDITED',
      commission_version: 2,
      booked_base_fen: 1000n,
    });
    expect(await voucherLines(a, creditKey(o, 'self'))).toEqual(userCreditLines(o, 'self', 500n));
    expect(await voucherLines(a, creditKey(o, 'direct'))).toEqual(
      userCreditLines(o, 'direct', 100n),
    );
    expect(await voucherLines(a, platformKey(o))).toEqual(platformLines(o, 400n));
    expect(await availableOf(a, o.user('self'))).toBe(500n);
    expect(await availableOf(a, o.user('direct'))).toBe(100n);
  },
  TIMEOUT,
);

// ---------------------------------------------------------------------------------------------
// 第 3 次写测（评审 9 条 S1）。断言都在用例体里；worker 回调里只投递与取数，投递经 within 有界、成败都不抛。

/** 一次投递的结果（'ok' 或错误文字）。 */
function shown(outcome: Outcome<unknown> | undefined): string {
  if (outcome === undefined) return 'not run';
  return outcome.ok ? 'ok' : errorText(outcome.error);
}

/** 生产装配的账单日 bill 投递一次：结果与 worker 日志。 */
async function billOnce(
  a: App,
  options: WorkerOptions = {},
): Promise<{ outcome: Outcome<void>; lines: LogLine[] }> {
  const seen: { outcome?: Outcome<void>; lines: LogLine[] } = { lines: [] };
  await withWorker(
    a,
    async (w) => {
      seen.lines = w.lines;
      seen.outcome = await within(w.bill(), 'bill');
    },
    options,
  );
  return {
    outcome: seen.outcome ?? { ok: false, error: new Error('bill not run') },
    lines: seen.lines,
  };
}

/** 本应用全部 DRAFT 批次确认为立即结算后，经同一生产处理器逐批 batch_execute（有界）。 */
async function confirmAndExecute(a: App, batchIds: readonly string[]): Promise<string[]> {
  await confirmDrafts(a, await admin(a));
  const results: string[] = [];
  await withWorker(a, async (w) => {
    for (const id of batchIds) results.push(shown(await within(w.execute(id), 'execute')));
  });
  return results;
}

/** 某版本合计行的 N、基数前扣减与基数。 */
function totalsAt(a: App, o: Seeded, version: number) {
  return a.db
    .selectFrom('commission_split_totals')
    .select(['n_total_fen', 'pre_base_deduct_fen', 'base_fen'])
    .where('app_id', '=', a.appId)
    .where('order_id', '=', o.orderId)
    .where('commission_version', '=', version)
    .executeTakeFirst();
}

const sumOf = (xs: readonly bigint[]) => xs.reduce((x, y) => addFen(x, y), 0n);

it(
  '[AC-B2-18#18] 重生成按 BR-CALC-02 换算（含淘礼金扣减、向下取整）：快照预留 1500bp、淘礼金扣减 100（我方淘礼金 normal 模式）、旧基数 900，联盟结算 1010 → 生产重生成追加 v2，基数 = floor(1010 × 8500 / 10000) − 100 = 858 − 100 = 758（漏扣淘礼金得 858 / 859，四舍五入得 759），v2 的 N 1010、基数前扣减 252（预留 1010 − 858 = 152 加淘礼金 100），各方 = splitCommission 同一输入、各方 + 平台留存 = 758；按 758 入主批次、账单合计按 758 拆；不告警、不登记差错单',
  async () => {
    const a = await app(pools.db);
    await creditOn(a);
    // 自拟 v1：N 1177 → floor(1177 × 8500 / 10000) = floor(1000.45) = 1000，减淘礼金 100 → 旧基数 900。
    // 第 4 次写测（§12.4）：这是直接预置的快照行（rebate_mode=normal、tlj_deduct_fen=100），不经淘礼金来源流水线；
    // 本条验证的是出账读到已落库的扣减后按 BR-CALC-02 得 758。
    const o = await seedOrder(a, {
      snapshotN: 1177n,
      settleFen: 1010n,
      reserveBp: 1500,
      tljDeductFen: 100n,
      people: THREE_PEOPLE,
    });
    // 新基数（BR-CALC-02 原文）：B = max(0, floor(N_base × (10000 − reserve_bp) / 10000) − tlj_deduct_fen)
    // = floor(1010 × 8500 / 10000) − 100 = floor(858.5) − 100 = 758。各方拆分不手推，取 splitCommission。
    const split = splitOf(o, 1010n);

    const run = await billOnce(a);

    expect(o.snapshotBase).toBe(900n);
    expect(split.base).toBe(758n);
    expect(addFen(sumOf(split.shares), split.retain)).toBe(758n);
    expect(shown(run.outcome)).toBe('ok');
    expect(allAlerts(run.lines)).toEqual([]);
    expect(await bases(a, o)).toEqual([
      [1, 900n],
      [2, 758n],
    ]);
    // v2 合计：N 1010（补贴 0）；基数前扣减 = N − B = 1010 − 758 = 252 = 预留 152 + 淘礼金 100。
    expect(await totalsAt(a, o, 2)).toEqual({
      n_total_fen: 1010n,
      pre_base_deduct_fen: 252n,
      base_fen: 758n,
    });
    expect(await amountsAt(a, o, 2)).toEqual(byRole(versionRows(o, 2, split, a.clock.now())));
    expect(await orderRow(a, o)).toMatchObject({ rebate_status: 'WAITING', commission_version: 2 });
    expect(await itemsFor(a, o)).toEqual([
      expect.objectContaining({ item_type: 'order', settle_seq: 1, b_settle_fen: 758n }),
    ]);
    expect(await billRow(a)).toMatchObject({
      platform_order_counts: { taobao: 1 },
      platform_settle_commission_totals: { taobao: '1010' },
      beneficiary_total_fen: sumOf(split.shares),
      platform_retained_fen: split.retain,
    });
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
  '[AC-B2-18#19] 重生成的向下取整走到真实入账（淘礼金 0）：快照预留 1500bp、旧基数 900，联盟结算 1010 → v2 基数 floor(1010 × 8500 / 10000) = floor(858.5) = 858（四舍五入得 859），各方 = splitCommission 同一输入、和 + 平台留存 = 858；按 858 入主批次，确认前无凭证；确认后经同一处理器 R5 入账：booked_base 858、booked_n 1010，受益人凭证 = 各方份额，平台凭证 = 平台留存 + 预留 152（1010 − 858，BR-FUND-05）',
  async () => {
    const a = await app(pools.db);
    await creditOn(a);
    // 自拟 v1：N 1059 → floor(1059 × 8500 / 10000) = floor(900.15) = 900。
    const o = await seedOrder(a, {
      snapshotN: 1059n,
      settleFen: 1010n,
      reserveBp: 1500,
      people: THREE_PEOPLE,
    });
    const split = splitOf(o, 1010n);
    const people = o.people.map((p) => p.userId);
    const availableBefore = await availables(a, people);

    const run = await billOnce(a);
    const afterBill = {
      ledger: await ledgerOf(a, o),
      available: await availables(a, people),
      batches: await batchesOf(a),
    };

    expect(o.snapshotBase).toBe(900n);
    expect(split.base).toBe(858n);
    expect(addFen(sumOf(split.shares), split.retain)).toBe(858n);
    expect(shown(run.outcome)).toBe('ok');
    expect(await bases(a, o)).toEqual([
      [1, 900n],
      [2, 858n],
    ]);
    expect(await amountsAt(a, o, 2)).toEqual(byRole(versionRows(o, 2, split, a.clock.now())));
    expect(await itemsFor(a, o)).toEqual([
      expect.objectContaining({ settle_seq: 1, b_settle_fen: 858n, result: null }),
    ]);
    expect(afterBill.batches.map((b) => b.status)).toEqual(['DRAFT']);
    expect(afterBill.ledger).toEqual({ keys: [], entries: 0 });
    expect(afterBill.available).toEqual(availableBefore);

    const executed = await confirmAndExecute(
      a,
      afterBill.batches.map((b) => b.batch_id),
    );

    expect(executed).toEqual(['ok']);
    expect(await itemsFor(a, o)).toEqual([expect.objectContaining({ result: 'credited' })]);
    expect(await orderRow(a, o)).toMatchObject({
      rebate_status: 'CREDITED',
      commission_version: 2,
      booked_base_fen: 858n,
      booked_n_fen: 1010n,
    });
    for (const [i, p] of o.people.entries()) {
      const share = split.shares[i]!;
      expect(await voucherLines(a, creditKey(o, p.role)), p.role).toEqual(
        userCreditLines(o, p.role, share),
      );
      expect(await availableOf(a, p.userId), p.role).toBe(share);
    }
    // BR-FUND-05：平台凭证金额 = 平台留存 + 预留 reserve_fen；reserve_fen = 1010 − floor(1010 × 8500 / 10000) = 152。
    expect(await voucherLines(a, platformKey(o))).toEqual(
      platformLines(o, addFen(split.retain, 152n)),
    );
    expect((await ledgerOf(a, o)).keys).toEqual(
      [...o.people.map((p) => creditKey(o, p.role)), platformKey(o)].sort(),
    );
    expect(await diffsOf(a)).toEqual([]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-18#20] 混合来源触发重生成（账单日，BR-FUND-09 R1 明细优先）：快照基数 1234；STATEMENT seq 1 结算 1100、之后到的 API seq 2 结算 1000 → 决定金额的是 STATEMENT 的 1100（不是最大 seq 的 1000）：v2 基数 1100（550 / 110）、明细 b_settle 1100、账单联盟结算合计 1100；明细 settle_seq 取整单最大 seq 2（同 [AC-B2-04zp#14]）；确认后 R5 按 seq 2 校验通过、按 1100 入账 550 / 110 / 440',
  async () => {
    const a = await app(pools.db);
    await creditOn(a);
    const o = await seedOrder(a, {
      snapshotN: 1234n,
      settleFen: null,
      settlements: [
        { seq: 1, source: 'STATEMENT', fen: 1100n },
        { seq: 2, source: 'API', fen: 1000n },
      ],
      people: EXAMPLE_PEOPLE,
    });

    const run = await billOnce(a);
    const batches = await batchesOf(a);

    expect(shown(run.outcome)).toBe('ok');
    expect(allAlerts(run.lines)).toEqual([]);
    // 决定金额的记录：STATEMENT seq 1 的 1100（预留 0 → B_settle 1100）；按 API 1000 重生成的错实现得 1000。
    expect(await bases(a, o)).toEqual([
      [1, 1234n],
      [2, 1100n],
    ]);
    expect((await amountsAt(a, o, 2)).map((r) => [r.role, r.base_fen, r.amount_fen])).toEqual([
      ['direct', 1100n, 110n],
      ['self', 1100n, 550n],
    ]);
    expect(await billRow(a)).toMatchObject({
      platform_settle_commission_totals: { taobao: '1100' },
    });
    // 明细的 settle_seq：截点内整单最大 seq 2。
    expect(await itemsFor(a, o)).toEqual([
      expect.objectContaining({ item_type: 'order', settle_seq: 2, b_settle_fen: 1100n }),
    ]);
    expect(batches).toHaveLength(1);
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
  '[AC-B2-18#24] 联盟结算 0 而快照基数 > 0 一律拦下、不看容差（编排 D10-2415 ④(i)、D10-2532）：容差 5 分、结算 0、基数 3 → 不重生成（版本行与 commission_version 不变）、不入批、告警工程一次、amount_mismatch_count 1、保持 WAITING；同账单对照：基数 0 结算 0 仍是候选（b_settle 0，[AC-B2-04n#30] 不变），基数 1103 而结算 1100 在容差内直接候选、不重生成、不告警',
  async () => {
    const a = await app(pools.db);
    await creditOn(a);
    await setConfig(a, 'settle.batch.match_tolerance_fen', '5');
    // 自拟（预留 0）：基数 3、结算 0（|0 − 3| = 3 ≤ 5，先按容差放行的错实现会让它入批）。
    const zero = await plain(a, 3n, 0n);
    const bothZero = await plain(a, 0n, 0n);
    // 自拟（预留 0）：基数 1103、B_settle 1100，差 3 ≤ 5。
    const near = await plain(a, 1103n, 1100n);
    const before = {
      zero: await versionsOf(a, zero),
      bothZero: await versionsOf(a, bothZero),
      near: await versionsOf(a, near),
    };

    const run = await billOnce(a);

    expect(shown(run.outcome)).toBe('ok');
    const alerts = alertsFor(run.lines, zero);
    expect(alerts).toHaveLength(1);
    expectAlertShape(alerts[0]!, a, zero);
    expect(allAlerts(run.lines)).toHaveLength(1);
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
    expect(await countsOf(a)).toEqual({
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
  '[AC-B2-18#30] 账单日任务不再调用「以联盟为准」结论读口（端口保留，FU-B2-18-RETIRE-UNION-CONCLUSION 之前不删）：把生产装配的 readUnionAuthoritative 换成一调用就抛错并计数的替身 → 出账照常成功，调用 0 次；有结论与没结论的两张例 2 单都按 1100 重生成 v2 并入批，已有差错单原样',
  async () => {
    const a = await app(pools.db);
    await creditOn(a);
    const concluded = await example2(a);
    const bare = await example2(a);
    await unionConclusion(a, concluded, 1234n, 1100n);
    const diffsBefore = await diffsOf(a);
    const reads = { calls: 0 };

    const run = await billOnce(a, {
      ports: (captured) => ({
        ...captured,
        readUnionAuthoritative: async () => {
          reads.calls += 1;
          throw new Error('synthetic: the union conclusion read must not be called');
        },
      }),
    });

    expect(shown(run.outcome)).toBe('ok');
    expect(reads.calls).toBe(0);
    for (const o of [concluded, bare]) {
      expect(await bases(a, o), o.orderKey).toEqual([
        [1, 1234n],
        [2, 1100n],
      ]);
      expect(await itemsFor(a, o), o.orderKey).toEqual([
        expect.objectContaining({ settle_seq: 1, b_settle_fen: 1100n }),
      ]);
    }
    expect(allAlerts(run.lines)).toEqual([]);
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
  '[AC-B2-18#32] [AC-B2-18#9] 的变体——部分退款与旧结论交叉：两张例 2 单（快照 1234、结算 1100）各有一条成功未应答的维权扣减 100，其中一张另有一张已结案、结论「以联盟为准」的旧差错单 → 两张结果完全相同：都重生成 v2（基数 1100）、b_settle 1100 入批，R5 都以 1100 − 100 = 1000 入账，自拟 500 / 100 / 400；旧差错单原样、不新增',
  async () => {
    const a = await app(pools.db);
    await creditOn(a);
    const concluded = await example2(a);
    const bare = await example2(a);
    await openDeduction(a, concluded, 100n);
    await openDeduction(a, bare, 100n);
    await unionConclusion(a, concluded, 1234n, 1100n);
    const diffsBefore = await diffsOf(a);

    const run = await billOnce(a);
    const batches = await batchesOf(a);

    expect(shown(run.outcome)).toBe('ok');
    for (const o of [concluded, bare]) {
      expect(await bases(a, o), o.orderKey).toEqual([
        [1, 1234n],
        [2, 1100n],
      ]);
      expect(await itemsFor(a, o), o.orderKey).toEqual([
        expect.objectContaining({ settle_seq: 1, b_settle_fen: 1100n }),
      ]);
    }
    expect(batches).toHaveLength(1);

    const executed = await confirmAndExecute(
      a,
      batches.map((b) => b.batch_id),
    );

    expect(executed).toEqual(['ok']);
    for (const o of [concluded, bare]) {
      expect(await orderRow(a, o), o.orderKey).toMatchObject({
        rebate_status: 'CREDITED',
        commission_version: 2,
        booked_base_fen: 1000n,
      });
      expect(await voucherLines(a, creditKey(o, 'self'))).toEqual(userCreditLines(o, 'self', 500n));
      expect(await voucherLines(a, creditKey(o, 'direct'))).toEqual(
        userCreditLines(o, 'direct', 100n),
      );
      expect(await voucherLines(a, platformKey(o))).toEqual(platformLines(o, 400n));
    }
    expect(await diffsOf(a)).toEqual(diffsBefore);
  },
  TIMEOUT,
);
