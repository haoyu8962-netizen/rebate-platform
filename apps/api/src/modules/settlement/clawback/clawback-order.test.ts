// B2-04zza 源码旁单元测试（不连库）：入账后维权等待中、新结算记录回应时，哪些结算计划仍留着等待。
// 依据 BR-FUND-08 细则（D10-474 ②）与编排 D10-781：负差一路（含义务没收 / 新开延后 / 保持重算）一律按
// R10 写并关闭维权记录，只有正差一路留着等待（FU-SETTLE-ADJ-POSITIVE）。
import {
  planCommissionAdjustment,
  type AdjustmentBeneficiary,
  type AdjustmentInput,
} from '@couli/domain';
import type { DB } from '@couli/db';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type Transaction,
} from 'kysely';
import { expect, it } from 'vitest';
import {
  answeredRightsWaits,
  baselineOnlyAfter,
  closesWaitOnNoChange,
  refundQuantityBaseline,
  refundQuantityIncreased,
  refundQuantityRoute,
} from './clawback-order.ts';
import { casClawbackOrder, casRefundBaseline } from './clawback-store.ts';

function seat(
  role: AdjustmentBeneficiary['role'],
  over: Partial<AdjustmentBeneficiary> = {},
): AdjustmentBeneficiary {
  return {
    user_id: `u-${role}`,
    role,
    ratio_bp: role === 'self' ? 5000n : 1000n,
    status: 'active',
    risk_state: 'normal',
    deletion_status: null,
    is_minor: false,
    net_fen: 0n,
    obligation: null,
    ...over,
  };
}

// booked 1000 / 1000，无预留：self 500、share 100、direct 100，平台 300。平台净额按 BR-FUND-19 ⑤ 的等式
// 取 booked − 受益人净额 − 未完成义务的待补记额（份额减净额），让夹具自洽。
function input(nNew: bigint, beneficiaries: readonly AdjustmentBeneficiary[]): AdjustmentInput {
  const held = beneficiaries.reduce((sum, b) => {
    const pending = b.obligation === null ? 0n : (1000n * b.ratio_bp) / 10000n - b.net_fen;
    return sum + b.net_fen + (pending > 0n ? pending : 0n);
  }, 0n);
  return {
    event: 'settlement',
    n_new_fen: nNew,
    reserve_bp: 0n,
    booked_base_fen: 1000n,
    booked_n_fen: 1000n,
    platform_net_fen: 1000n - held,
    beneficiaries,
  };
}

it('[AC-B2-04zza#U1] 负差 + 封禁受益人的首次入账义务要没收：不再等待，计划是 R10', () => {
  const plan = planCommissionAdjustment(
    input(800n, [
      seat('self', {
        status: 'held',
        risk_state: 'banned',
        obligation: { beneficiary_credit_id: 'bc-1', kind: 'first_credit' },
      }),
      seat('share', { net_fen: 100n }),
      seat('direct', { net_fen: 100n }),
    ]),
  );
  expect(plan.route).toBe('immediate');
  expect(plan.transition).toBe('R10');
  expect(plan.beneficiaries.find((b) => b.role === 'self')?.obligation_action).toBe('forfeited');
  expect(answeredRightsWaits(plan)).toBe(false);
});

it('[AC-B2-04zza#U2] 负差 + 冻结受益人新开延后义务（open）：不再等待，计划是 R10', () => {
  const plan = planCommissionAdjustment(
    input(800n, [
      seat('self', { risk_state: 'frozen', net_fen: 0n }),
      seat('share', { net_fen: 100n }),
      seat('direct', { net_fen: 100n }),
    ]),
  );
  expect(plan.route).toBe('immediate');
  expect(plan.transition).toBe('R10');
  expect(plan.beneficiaries.find((b) => b.role === 'self')?.obligation_action).toBe('open');
  expect(answeredRightsWaits(plan)).toBe(false);
});

it('[AC-B2-04zza#U3] 负差 + 已有义务仍冻结（keep，待补记额随 booked 重算）：不再等待', () => {
  const plan = planCommissionAdjustment(
    input(800n, [
      seat('self', {
        status: 'held',
        risk_state: 'frozen',
        obligation: { beneficiary_credit_id: 'bc-1', kind: 'first_credit' },
      }),
      seat('share', { net_fen: 100n }),
      seat('direct', { net_fen: 100n }),
    ]),
  );
  const self = plan.beneficiaries.find((b) => b.role === 'self');
  expect(plan.transition).toBe('R10');
  expect(self?.obligation_action).toBe('keep');
  expect(self?.pending_after_fen).not.toBe(self?.pending_before_fen);
  expect(answeredRightsWaits(plan)).toBe(false);
});

it('[AC-B2-04zza#U4] 正差仍留着等待（approval 路）；无动作与纯负差不等待', () => {
  const seats = [
    seat('self', { net_fen: 500n }),
    seat('share', { net_fen: 100n }),
    seat('direct', { net_fen: 100n }),
  ];
  const up = planCommissionAdjustment(input(1200n, seats));
  expect(up.route).toBe('approval');
  expect(answeredRightsWaits(up)).toBe(true);
  const same = planCommissionAdjustment(input(1000n, seats));
  expect(same.transition).toBeNull();
  expect(answeredRightsWaits(same)).toBe(false);
  const down = planCommissionAdjustment(input(600n, seats));
  expect(down.transition).toBe('R10');
  expect(answeredRightsWaits(down)).toBe(false);
});

it('[AC-B2-04zza#U5] 结算事件的计划只有 null / R8 / R10，负差一路不出现 R9 与受益人正差', () => {
  const mixes: AdjustmentBeneficiary[][] = [
    [
      seat('self', { net_fen: 500n }),
      seat('share', {
        status: 'held',
        risk_state: 'banned',
        obligation: { beneficiary_credit_id: 'bc-2', kind: 'first_credit' },
      }),
      seat('direct', { risk_state: 'appealing', net_fen: 0n }),
    ],
    [
      seat('self', { deletion_status: 'done', net_fen: 500n }),
      seat('share', { net_fen: 100n }),
      seat('direct', { net_fen: 100n }),
    ],
  ];
  for (const beneficiaries of mixes) {
    for (const nNew of [0n, 1n, 300n, 800n, 999n, 1000n, 1001n, 1500n]) {
      const plan = planCommissionAdjustment(input(nNew, beneficiaries));
      expect(plan.transition).not.toBe('R9');
      if (plan.route === 'immediate' && plan.transition === 'R10') {
        expect(plan.beneficiaries.every((b) => b.delta_fen <= 0n)).toBe(true);
      }
    }
  }
});

// B2-04zzf 源码旁单元测试（不连库）：「已退件数增加」改比 COALESCE(r9 基线, at_credit, 0)，写库语句同句推基线，
// 只推基线的出口按结果判定（D10-870）。

const SYNTHETIC_CAS_KEY = {
  app_id: 'app-synthetic',
  order_id: '0192f0a0-0000-7000-8000-000000000001',
  attr_at: new Date('2026-10-20T03:00:00.000Z'),
  rebate_status: 'CREDITED',
  row_version: 7,
} as const;
const UNIT_AT = new Date('2026-11-08T02:00:00.000Z');

/** Compiles every statement and answers no rows (DummyDriver). */
function recordingTrx(): { trx: Transaction<DB>; statements: CompiledQuery[] } {
  const statements: CompiledQuery[] = [];
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (inner) => new PostgresIntrospector(inner),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
    log: (event) => {
      if (event.level === 'query') statements.push(event.query);
    },
  });
  return { trx: db as unknown as Transaction<DB>, statements };
}

it('[AC-B2-04zzf#U1] 基准取 COALESCE(基线, at_credit, 0)：基线优先，空时回退 at_credit，再空为 0', () => {
  expect(
    refundQuantityBaseline({
      refunded_quantity: 3,
      refunded_quantity_at_credit: 1,
      refunded_quantity_r9_baseline: 2,
    }),
  ).toBe(2);
  expect(
    refundQuantityBaseline({
      refunded_quantity: 3,
      refunded_quantity_at_credit: 1,
      refunded_quantity_r9_baseline: null,
    }),
  ).toBe(1);
  expect(refundQuantityBaseline({ refunded_quantity: 3, refunded_quantity_at_credit: 1 })).toBe(1);
  expect(
    refundQuantityBaseline({
      refunded_quantity: 3,
      refunded_quantity_at_credit: null,
      refunded_quantity_r9_baseline: null,
    }),
  ).toBe(0);
  // 基线 0 是有效值，不回退到 at_credit。
  expect(
    refundQuantityBaseline({
      refunded_quantity: 1,
      refunded_quantity_at_credit: 1,
      refunded_quantity_r9_baseline: 0,
    }),
  ).toBe(0);
});

it('[AC-B2-04zzf#U2] 增加是严格大于基准；R9 之后已退件数不变不再算增加，再退一件才算', () => {
  const afterR9 = { refunded_quantity: 1, refunded_quantity_at_credit: 0 };
  expect(refundQuantityIncreased({ ...afterR9, refunded_quantity_r9_baseline: null })).toBe(true);
  expect(refundQuantityIncreased({ ...afterR9, refunded_quantity_r9_baseline: 1 })).toBe(false);
  expect(
    refundQuantityIncreased({ ...afterR9, refunded_quantity: 2, refunded_quantity_r9_baseline: 1 }),
  ).toBe(true);
  expect(
    refundQuantityIncreased({
      refunded_quantity: null,
      refunded_quantity_at_credit: null,
      refunded_quantity_r9_baseline: null,
    }),
  ).toBe(false);
});

it('[AC-B2-04zzf#U3] refundQuantityRoute 比基线：基线追平后 pdd / jd 都是 none；基线落后时 pdd r9、jd 按开关', () => {
  const caught = {
    refunded_quantity: 2,
    refunded_quantity_at_credit: 0,
    refunded_quantity_r9_baseline: 2,
  };
  expect(refundQuantityRoute({ ...caught, platform: 'pdd' }, false)).toBe('none');
  expect(refundQuantityRoute({ ...caught, platform: 'jd' }, true)).toBe('none');
  const behind = { ...caught, refunded_quantity_r9_baseline: 1 };
  expect(refundQuantityRoute({ ...behind, platform: 'pdd' }, false)).toBe('r9');
  expect(refundQuantityRoute({ ...behind, platform: 'jd' }, true)).toBe('r9');
  expect(refundQuantityRoute({ ...behind, platform: 'jd' }, false)).toBe('alert_only');
});

it('[AC-B2-04zzf#U4] 只推基线的出口：无变化、跳过、R9b 推；扣回、R10 已在写库同句推；等联盟佣金不推', () => {
  const key = 'pdd:1';
  expect(baselineOnlyAfter({ outcome: 'no_change', orderKey: key, rightsEventId: 'C1' })).toBe(
    true,
  );
  expect(baselineOnlyAfter({ outcome: 'skipped', reason: 'not_reverse' })).toBe(true);
  expect(
    baselineOnlyAfter({ outcome: 'estimate_archived', orderKey: key, reconDiff: 'none' }),
  ).toBe(true);
  expect(
    baselineOnlyAfter({ outcome: 'wait_commission', orderKey: key, rightsEventId: 'C1' }),
  ).toBe(false);
  const booked = { orderKey: key, rightsEventId: 'C1', bookedBaseFen: 600n, bookedNFen: 600n };
  expect(baselineOnlyAfter({ outcome: 'clawed_back', transition: 'R9', ...booked })).toBe(false);
  expect(baselineOnlyAfter({ outcome: 'settle_adjusted', transition: 'R10', ...booked })).toBe(
    false,
  );
});

it('[AC-B2-04zzf#U5] casClawbackOrder 一条 UPDATE：rebate_status、booked 对与基线 = 本行 refunded_quantity 同句，CAS 条件不变', async () => {
  const { trx, statements } = recordingTrx();
  await casClawbackOrder(trx, SYNTHETIC_CAS_KEY, {
    to: 'CREDITED',
    booked_base_fen: 600n,
    booked_n_fen: 600n,
    at: UNIT_AT,
  });
  expect(statements).toHaveLength(1);
  expect(statements[0]!.sql).toBe(
    'update "app"."orders" set "rebate_status" = $1, "booked_base_fen" = $2, "booked_n_fen" = $3, "refunded_quantity_r9_baseline" = "refunded_quantity", "row_version" = $4, "updated_at" = $5 where "app_id" = $6 and "order_id" = $7 and "attr_at" = $8 and "rebate_status" = $9 and "row_version" = $10',
  );
  expect(statements[0]!.parameters).toEqual([
    'CREDITED',
    600n,
    600n,
    8,
    UNIT_AT,
    'app-synthetic',
    SYNTHETIC_CAS_KEY.order_id,
    SYNTHETIC_CAS_KEY.attr_at,
    'CREDITED',
    7,
  ]);
});

it('[AC-B2-04zzf#U6] casRefundBaseline 只写基线与 row_version / updated_at，CAS 在 (CREDITED, row_version) 上', async () => {
  const { trx, statements } = recordingTrx();
  const written = await casRefundBaseline(trx, SYNTHETIC_CAS_KEY, UNIT_AT);
  expect(written).toBe(false);
  expect(statements).toHaveLength(1);
  expect(statements[0]!.sql).toBe(
    'update "app"."orders" set "refunded_quantity_r9_baseline" = "refunded_quantity", "row_version" = $1, "updated_at" = $2 where "app_id" = $3 and "order_id" = $4 and "attr_at" = $5 and "rebate_status" = $6 and "row_version" = $7',
  );
  expect(statements[0]!.parameters).toEqual([
    8,
    UNIT_AT,
    'app-synthetic',
    SYNTHETIC_CAS_KEY.order_id,
    SYNTHETIC_CAS_KEY.attr_at,
    'CREDITED',
    7,
  ]);
});

it('[AC-B2-04zzf#U7] R9 判定一路无变化且本次有新结算记录才关闭等联盟佣金的待处理；无新记录的无变化与其他结果不关', () => {
  const key = 'pdd:1';
  const noChange = { outcome: 'no_change', orderKey: key, rightsEventId: 'C1' } as const;
  expect(closesWaitOnNoChange(noChange, 2)).toBe(true);
  expect(closesWaitOnNoChange(noChange, null)).toBe(false);
  expect(
    closesWaitOnNoChange({ outcome: 'wait_commission', orderKey: key, rightsEventId: 'C1' }, 2),
  ).toBe(false);
  expect(closesWaitOnNoChange({ outcome: 'skipped', reason: 'not_reverse' }, 2)).toBe(false);
  const booked = { orderKey: key, rightsEventId: 'C1', bookedBaseFen: 600n, bookedNFen: 600n };
  expect(closesWaitOnNoChange({ outcome: 'clawed_back', transition: 'R9', ...booked }, 2)).toBe(
    false,
  );
});
