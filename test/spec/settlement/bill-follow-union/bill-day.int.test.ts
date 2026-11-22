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
  batchesOf,
  billRow,
  byRole,
  confirmDrafts,
  countsOf,
  creditKey,
  creditOn,
  databaseFixture,
  diffsOf,
  expectAlertShape,
  failVersionWrite,
  itemsFor,
  itemsOf,
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
  type App,
  type OrderSpec,
  type Seeded,
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

      await confirmDrafts(a, await admin(a));
      await w.execute(batchId);
    });

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
