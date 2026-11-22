// B2-18：重生成端口的约定与「端口没有注入 / 重生成后仍不一致」两种失败，经直接组装的账单日任务与补充发起
// （生产 readSource 读真实订单行，commission / ledger 的真实端口；重生成端口不给或给一个记录器）。
// 端口可选（BillJobDependencies.regenerateSnapshot），未注入时按重生成失败处理：告警工程、保持 WAITING、
// 不登记差错单、计入 amount_mismatch_count（补充发起不回写账单计数列）。顶层 it()（规划/11 §4.3）。
import { createTestDatabase } from '@couli/db/testing';
import type { DB } from '@couli/db';
import { subFen } from '@couli/money';
import type { Transaction } from 'kysely';
import { expect, it } from 'vitest';
import {
  getAssetSnapshotStatus,
  registerReconDiff,
  readUnionAuthoritativeOrderKeys,
} from '../../../../apps/api/src/modules/ledger/index.ts';
import {
  createBillJob,
  createBillSourceReader,
  saveBillValidations,
  type BillJobDependencies,
  type BillSourceSelection,
  type BillValidation,
} from '../../../../apps/api/src/modules/settlement/bill/index.ts';
import type {
  BillSnapshotRegeneration,
  BillSnapshotRegenerationInput,
} from '../../../../apps/api/src/modules/settlement/bill/regenerate.ts';
import {
  createSupplementCommand,
  type SupplementDependencies,
} from '../../../../apps/api/src/modules/settlement/bill/supplement/command.ts';
import { legacyBill } from '../bill-unsettled-count/kit.ts';
import { isTransaction } from '../worker/kit.ts';
import {
  BILL_DAY,
  EXAMPLE_PEOPLE,
  TIMEOUT,
  alertsFor,
  allAlerts,
  app,
  billRow,
  capturingLogger,
  countsOf,
  databaseFixture,
  diffsOf,
  errorText,
  expectAlertShape,
  itemsFor,
  orderRow,
  seedOrder,
  unionConclusion,
  versionsOf,
  within,
  type App,
  type Seeded,
} from './kit.ts';

const pools = databaseFixture(createTestDatabase);

// commission 的公开出口（运行时加载，Nest 装饰器不进测试工程的编译）。
const commission = (await import(
  new URL('../../../../apps/api/src/modules/commission/index.ts', import.meta.url).href
)) as {
  readonly readCommissionSnapshot: BillJobDependencies['readSnapshot'];
  readonly readTljDeductFen: BillJobDependencies['readTljDeductFen'];
};

/** 账单日 00:00 +08:00：账单任务的名义 run_at。 */
const RUN_AT = new Date(`${BILL_DAY}T00:00:00+08:00`);

/** 账单日任务与补充发起共用的依赖：生产 readSource 与 commission / ledger 的真实端口；入账开关 on。 */
function dependencies(a: App): BillJobDependencies {
  return {
    clock: a.clock,
    config: {
      get: async (_appId, key) => (key.startsWith('credit.enabled.') ? 'on' : undefined),
    },
    readSource: createBillSourceReader({ readUnionAuthoritative: readUnionAuthoritativeOrderKeys }),
    readSnapshot: commission.readCommissionSnapshot,
    readTljDeductFen: commission.readTljDeductFen,
    snapshotStatus: getAssetSnapshotStatus,
    registerDiff: registerReconDiff,
    saveValidations: saveBillValidations,
  };
}

function example2(a: App): Promise<Seeded> {
  return seedOrder(a, { snapshotN: 1234n, settleFen: 1100n, people: EXAMPLE_PEOPLE });
}

/** 自拟：快照与结算都取 1000（预留 0）→ 一致。 */
function matching(a: App): Promise<Seeded> {
  return seedOrder(a, { snapshotN: 1000n, settleFen: 1000n, people: EXAMPLE_PEOPLE });
}

interface RecordedCall {
  readonly inTransaction: boolean;
  readonly input: BillSnapshotRegenerationInput;
}

/**
 * 一个「重生成成功但仍不一致」的端口：记下调用，按 R7 的形状追加 v(n+1)，但基数故意取 B_settle + 7（及按
 * 5000 / 1000bp 拆出的金额），并把 orders.commission_version 推到它。
 */
function skewedPort(
  a: App,
  people: Seeded['people'],
): {
  readonly port: BillSnapshotRegeneration;
  readonly calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const port: BillSnapshotRegeneration = {
    async regenerate(trx: Transaction<DB>, input) {
      calls.push({ inTransaction: isTransaction(trx), input });
      const version = input.commissionVersion + 1;
      // 自拟：B_settle 1100 + 7 = 1107；1107 × 5000 / 10000 = 553，× 1000 / 10000 = 110。
      const base = input.bSettleFen + 7n;
      const amounts = [553n, 110n];
      await trx
        .insertInto('commission_split_totals')
        .values({
          app_id: input.appId,
          order_id: input.orderId,
          commission_version: version,
          n_total_fen: base,
          pre_base_deduct_fen: 0n,
          base_fen: base,
          user_share_total_fen: 663n,
          tlj_redpacket_fen: 0n,
          platform_est_profit_fen: subFen(base, 663n),
          subsidy_commission_fen: 0n,
          created_at: a.clock.now(),
        })
        .execute();
      await trx
        .insertInto('commission_split_amounts')
        .values(
          people.map((p, i) => ({
            app_id: input.appId,
            order_id: input.orderId,
            commission_version: version,
            user_id: p.userId,
            role: p.role,
            base_fen: base,
            amount_fen: amounts[i]!,
            created_at: a.clock.now(),
          })),
        )
        .execute();
      await trx
        .updateTable('orders')
        .set((eb) => ({ commission_version: version, row_version: eb('row_version', '+', 1) }))
        .where('app_id', '=', input.appId)
        .where('order_id', '=', input.orderId)
        .execute();
      return { commissionVersion: version };
    },
  };
  return { port, calls };
}

it(
  '[AC-B2-18#10] 重生成端口没有注入（依赖类型上可选）：账单日任务遇金额不一致按重生成失败处理——不登记差错单、不计 error_count、amount_mismatch_count=1、保持 WAITING、版本原样、不进批次；一致单照常入批',
  async () => {
    const a = await app(pools.db);
    const o = await example2(a);
    const ok = await matching(a);
    const before = await versionsOf(a, o);
    // 第 3 次写测（评审第 5 条）：直接组装的任务经依赖里的 logger 告警（与 SupplementDependencies.logger 同名）。
    const { logger, lines } = capturingLogger();
    const deps = { ...dependencies(a), logger };
    const job = createBillJob(deps);

    const result = await job.run(a.db, { appId: a.appId, platform: 'taobao', runAt: RUN_AT });
    expect(result).toMatchObject({ outcome: 'generated' });

    expect(await diffsOf(a)).toEqual([]);
    expect(await countsOf(a)).toEqual({
      error_count: 0,
      held_count: 0,
      unsettled_count: 0,
      amount_mismatch_count: 1,
    });
    expect(await versionsOf(a, o)).toEqual(before);
    expect(await orderRow(a, o)).toMatchObject({ rebate_status: 'WAITING', commission_version: 1 });
    expect(await itemsFor(a, o)).toEqual([]);
    expect(await itemsFor(a, ok)).toEqual([expect.objectContaining({ b_settle_fen: 1000n })]);
    // 恰好一条 error 级结构化告警（alert 与 #3 / #12 同一个），带 app_id / bill_id / order_id、不带子订单号与受益人。
    const alerts = alertsFor(lines, o);
    expect(alerts).toHaveLength(1);
    expectAlertShape(alerts[0]!, a, o);
    expect(allAlerts(lines)).toHaveLength(1);
  },
  TIMEOUT,
);

it(
  '[AC-B2-18#11] 端口在出账的同一事务里只为超容差的单调用一次，入参为当前版本、决定金额的联盟结算佣金与 B_settle；端口追加了版本而再校验仍不一致（基数 1107 ≠ 1100）→ 不进批次、不登记差错单、不计 error_count、amount_mismatch_count=1；一致单不调用端口',
  async () => {
    const a = await app(pools.db);
    const o = await example2(a);
    const ok = await matching(a);
    const { port, calls } = skewedPort(a, o.people);
    const { logger, lines } = capturingLogger();
    const deps = { ...dependencies(a), regenerateSnapshot: port, logger };
    const job = createBillJob(deps);

    await job.run(a.db, { appId: a.appId, platform: 'taobao', runAt: RUN_AT });

    expect(calls).toEqual([
      {
        inTransaction: true,
        input: {
          appId: a.appId,
          orderId: o.orderId,
          commissionVersion: 1,
          settleCommissionFen: 1100n,
          bSettleFen: 1100n,
        },
      },
    ]);
    expect(await itemsFor(a, o)).toEqual([]);
    expect((await orderRow(a, o)).rebate_status).toBe('WAITING');
    expect(await itemsFor(a, ok)).toEqual([expect.objectContaining({ b_settle_fen: 1000n })]);
    expect(await diffsOf(a)).toEqual([]);
    expect(await countsOf(a)).toEqual({
      error_count: 0,
      held_count: 0,
      unsettled_count: 0,
      amount_mismatch_count: 1,
    });
    // 再校验仍不一致（1107 ≠ 1100）：恰好一条同款告警，带 app_id / bill_id / order_id、不带子订单号与受益人。
    const alerts = alertsFor(lines, o);
    expect(alerts).toHaveLength(1);
    expectAlertShape(alerts[0]!, a, o);
    expect(allAlerts(lines)).toHaveLength(1);
  },
  TIMEOUT,
);

it(
  '[AC-B2-18#12] 补充发起（直接组装、不注入重生成端口、logger 收日志）遇金额不一致：一条 error 级告警工程（固定 alert，带 app_id / bill_id / order_id，不带子订单号与受益人）、不登记差错单、不入批、保持 WAITING；「以联盟为准」结论同样不读；补充不回写账单的任何计数列',
  async () => {
    const a = await app(pools.db);
    await legacyBill(a.db, a.appId, { billId: a.period, platformOrderCounts: { taobao: 0 } });
    const concluded = await example2(a);
    const o = await example2(a);
    await unionConclusion(a, concluded, 1234n, 1100n);
    const diffsBefore = await diffsOf(a);
    const billBefore = await billRow(a);
    const { logger, lines } = capturingLogger();
    const deps: SupplementDependencies = { ...dependencies(a), logger };
    const command = createSupplementCommand(deps);

    const result = await command.launch(a.db, {
      appId: a.appId,
      billId: a.period,
      platform: 'taobao',
      requestedAt: a.clock.now(),
    });

    expect(result).toMatchObject({ outcome: 'generated', batchIds: [] });
    for (const x of [concluded, o]) {
      const alerts = alertsFor(lines, x);
      expect(alerts, x.orderKey).toHaveLength(1);
      expectAlertShape(alerts[0]!, a, x);
      expect(await itemsFor(a, x)).toEqual([]);
      expect(await orderRow(a, x)).toMatchObject({
        rebate_status: 'WAITING',
        commission_version: 1,
      });
    }
    expect(await diffsOf(a)).toEqual(diffsBefore);
    expect(await billRow(a)).toEqual(billBefore);
  },
  TIMEOUT,
);

// ---------------------------------------------------------------------------------------------
// 第 3 次写测（评审 9 条 S1）。

/** 账单日任务与补充发起的配置：入账开关 on、容差按给定值（其余未设）。 */
function configWith(toleranceFen: string): BillJobDependencies['config'] {
  return {
    get: async (_appId: string, key: string): Promise<unknown> =>
      key.startsWith('credit.enabled.')
        ? 'on'
        : key === 'settle.batch.match_tolerance_fen'
          ? toleranceFen
          : undefined,
  };
}

it(
  '[AC-B2-18#26] 逐单结果（直接组装的账单日任务、saveValidations 记录器；编排 D10-2415 ④(i)、D10-2532 零结算而基数为正一律拦下、不看容差）：容差 5 分时联盟结算 0、基数 3 的单逐单结果为 amount_mismatch、不调用重生成端口、不入批、告警一次、amount_mismatch_count 1；基数 0 结算 0 与基数 1103 结算 1100（差 3 在容差内）的结果为 candidate、入批、也不调用端口',
  async () => {
    const a = await app(pools.db);
    // 自拟（预留 0）：基数 3 / 结算 0；基数 0 / 结算 0；基数 1103 / 结算 1100。
    const zero = await seedOrder(a, { snapshotN: 3n, settleFen: 0n, people: EXAMPLE_PEOPLE });
    const bothZero = await seedOrder(a, { snapshotN: 0n, settleFen: 0n, people: EXAMPLE_PEOPLE });
    const near = await seedOrder(a, { snapshotN: 1103n, settleFen: 1100n, people: EXAMPLE_PEOPLE });
    const saved: BillValidation[] = [];
    const { port, calls } = skewedPort(a, zero.people);
    const { logger, lines } = capturingLogger();
    const deps = {
      ...dependencies(a),
      config: configWith('5'),
      saveValidations: async (
        _trx: Transaction<DB>,
        _input: BillSourceSelection,
        rows: readonly BillValidation[],
      ): Promise<void> => {
        saved.push(...rows);
      },
      regenerateSnapshot: port,
      logger,
    };
    const job = createBillJob(deps);

    const outcome = await within(
      job.run(a.db, { appId: a.appId, platform: 'taobao', runAt: RUN_AT }),
      'bill run',
    );

    expect(outcome.ok ? 'ok' : errorText(outcome.error)).toBe('ok');
    const results = new Map(saved.map((v) => [v.orderId, v.result]));
    expect(results.get(zero.orderId)).toBe('amount_mismatch');
    expect(results.get(bothZero.orderId)).toBe('candidate');
    expect(results.get(near.orderId)).toBe('candidate');
    expect(calls).toEqual([]);
    expect(await itemsFor(a, zero)).toEqual([]);
    expect(await itemsFor(a, bothZero)).toEqual([expect.objectContaining({ b_settle_fen: 0n })]);
    expect(await itemsFor(a, near)).toEqual([expect.objectContaining({ b_settle_fen: 1100n })]);
    const alerts = alertsFor(lines, zero);
    expect(alerts).toHaveLength(1);
    expectAlertShape(alerts[0]!, a, zero);
    expect(allAlerts(lines)).toHaveLength(1);
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
  '[AC-B2-18#31] 补充发起（直接组装、不注入重生成端口）不再调用「以联盟为准」结论读口（端口保留）：生产 readSource 的结论读口换成一调用就抛错并计数的替身 → 补充照常 generated，调用 0 次；有结论与没结论的两张例 2 单结果相同（按端口未注入：各告警一次、不入批、保持 WAITING）；一致单照常入批；已有差错单原样、账单行不回写',
  async () => {
    const a = await app(pools.db);
    await legacyBill(a.db, a.appId, { billId: a.period, platformOrderCounts: { taobao: 0 } });
    const concluded = await example2(a);
    const bare = await example2(a);
    const ok = await matching(a);
    await unionConclusion(a, concluded, 1234n, 1100n);
    const diffsBefore = await diffsOf(a);
    const billBefore = await billRow(a);
    const reads = { calls: 0 };
    const { logger, lines } = capturingLogger();
    const deps: SupplementDependencies = {
      ...dependencies(a),
      readSource: createBillSourceReader({
        readUnionAuthoritative: async () => {
          reads.calls += 1;
          throw new Error('synthetic: the union conclusion read must not be called');
        },
      }),
      logger,
    };
    const command = createSupplementCommand(deps);

    const outcome = await within(
      command.launch(a.db, {
        appId: a.appId,
        billId: a.period,
        platform: 'taobao',
        requestedAt: a.clock.now(),
      }),
      'supplement',
    );

    expect(outcome.ok ? 'ok' : errorText(outcome.error)).toBe('ok');
    expect(reads.calls).toBe(0);
    expect(outcome.ok ? outcome.value : null).toMatchObject({ outcome: 'generated' });
    expect(outcome.ok ? outcome.value.batchIds : []).toHaveLength(1);
    for (const x of [concluded, bare]) {
      const alerts = alertsFor(lines, x);
      expect(alerts, x.orderKey).toHaveLength(1);
      expectAlertShape(alerts[0]!, a, x);
      expect(await itemsFor(a, x)).toEqual([]);
      expect(await orderRow(a, x)).toMatchObject({
        rebate_status: 'WAITING',
        commission_version: 1,
      });
    }
    expect(await itemsFor(a, ok)).toEqual([expect.objectContaining({ b_settle_fen: 1000n })]);
    expect(await diffsOf(a)).toEqual(diffsBefore);
    expect(await billRow(a)).toEqual(billBefore);
  },
  TIMEOUT,
);
