// B1-08zh（D10-574）下游不再减：快照与补偿重试的 N 一律是 settle ?? est（BR-CALC-02 取值阶段），settle 按已扣服务费处理。
// serviceFeeDeducted 只留一个含义：拼多多的 N 为空且没有服务费时，待处理原因用 SERVICE_FEE_RATE_MISSING。
// 淘宝、京东行为不变；只作负面用例，放在拼多多的正面断言之后。
import { expect, it } from 'vitest';
import {
  planCommissionSnapshot,
  type CommissionSnapshotPlan,
  type PlanCommissionSnapshotInput,
} from '../../../../apps/api/src/modules/orders/domain/commission-snapshot.ts';
import {
  isScanSkipCertain,
  planSnapshotRetry,
  type PlanSnapshotRetryInput,
  type SnapshotRetryPaid,
  type SnapshotRetryPlan,
} from '../../../../apps/api/src/modules/orders/domain/snapshot-retry.ts';

type PlatformCode = PlanCommissionSnapshotInput['order']['platform'];

const PAID = new Date('2026-10-12T02:03:04Z');
const NOW = new Date('2026-10-19T05:06:07Z');
const PAID_PLATFORM: SnapshotRetryPaid = {
  paidAt: PAID,
  paidAtSource: 'platform',
  writeSource: false,
};

interface Amounts {
  readonly est: bigint | null;
  readonly settle?: bigint | null;
}

function snapshotPlan(
  platform: PlatformCode,
  amounts: Amounts,
  fee: bigint | null,
): CommissionSnapshotPlan {
  return planCommissionSnapshot({
    before: null,
    after: { user_id: 'owner-1', platform_status: 'PAID', rebate_status_before: 'UNATTRIBUTED' },
    order: {
      app_id: 'app-1',
      order_id: 'order-1',
      platform,
      buy_type: 'self',
      activity_type: null,
      is_presale: false,
      paid_at: PAID,
      deposit_paid_at: null,
      est_commission_fen: amounts.est,
      settle_commission_fen: amounts.settle ?? null,
      subsidy_commission_fen: null,
    },
    incoming: { modified_at: null, service_fee_fen: fee },
    pidScene: null,
    movedToPaidNow: true,
    firstPaidAt: null,
    now: NOW,
  });
}

function retryPlan(
  platform: PlatformCode,
  amounts: Amounts,
  fee: PlanSnapshotRetryInput['serviceFeeFen'],
): SnapshotRetryPlan {
  return planSnapshotRetry({
    order: {
      app_id: 'app-1',
      order_id: 'order-1',
      platform,
      buy_type: 'self',
      activity_type: null,
      est_commission_fen: amounts.est,
      settle_commission_fen: amounts.settle ?? null,
      subsidy_commission_fen: null,
    },
    ownerUserId: 'owner-1',
    paid: PAID_PLATFORM,
    serviceFeeFen: fee,
    pidScene: null,
  });
}

/** 调端口时的 N；不调端口时原样返回计划，toBe 按断言失败。 */
function nOf(plan: CommissionSnapshotPlan | SnapshotRetryPlan): unknown {
  return plan.kind === 'call' ? plan.input.nBaseFen : plan;
}

const FEE_MISSING = { kind: 'pending', reason: 'SERVICE_FEE_RATE_MISSING' };
const AMOUNT_FAILED = { kind: 'pending', reason: 'AMOUNT_PARSE_FAILED' };

it('[AC-B1-08zh#6][BR-CALC-02] 快照：拼多多 est 900 → N 900，服务费 100 也不再减一次', () => {
  expect(nOf(snapshotPlan('pdd', { est: 900n }, 100n))).toBe(900n);
  expect(nOf(snapshotPlan('pdd', { est: 900n }, 0n))).toBe(900n);
  // 净额为负：负值原样进 N，基数在 commission 按 0 算。
  expect(nOf(snapshotPlan('pdd', { est: -200n }, 300n))).toBe(-200n);
});

it('[AC-B1-08zh#7][BR-CALC-02] 快照：settle 优先时同样不减，est 不参与', () => {
  expect(nOf(snapshotPlan('pdd', { est: 1000n, settle: 900n }, 100n))).toBe(900n);
  expect(nOf(snapshotPlan('pdd', { est: 1000n, settle: -51n }, 100n))).toBe(-51n);
});

it('[AC-B1-08zh#8][BR-CALC-02] 快照：N 已知时本次报文缺服务费不进待处理，N 就是 est（或 settle）', () => {
  expect(nOf(snapshotPlan('pdd', { est: 900n }, null))).toBe(900n);
  expect(nOf(snapshotPlan('pdd', { est: 1000n, settle: 900n }, null))).toBe(900n);
});

it('[AC-B1-08zh#9][BR-CALC-03] 快照：拼多多 N 为空且本次报文没有服务费 → SERVICE_FEE_RATE_MISSING；有服务费仍是 AMOUNT_PARSE_FAILED', () => {
  expect(snapshotPlan('pdd', { est: null }, null)).toEqual(FEE_MISSING);
  expect(snapshotPlan('pdd', { est: null }, 100n)).toEqual(AMOUNT_FAILED);
});

it('[AC-B1-08zh#10][BR-CALC-02] 重试：N 不再减，也不再依赖服务费；服务费有值、没给、列为空（unknown）都按 settle ?? est', () => {
  expect(nOf(retryPlan('pdd', { est: 900n }, 100n))).toBe(900n);
  expect(nOf(retryPlan('pdd', { est: 1000n, settle: 900n }, 100n))).toBe(900n);
  expect(nOf(retryPlan('pdd', { est: 900n }, null))).toBe(900n);
  expect(nOf(retryPlan('pdd', { est: 900n }, 'unknown'))).toBe(900n);
});

it('[AC-B1-08zh#11][BR-CALC-03] 重试：N 为空且报文没有服务费 → SERVICE_FEE_RATE_MISSING；扫描读到的列为空也不新开 AMOUNT_PARSE_FAILED', () => {
  expect(retryPlan('pdd', { est: null }, null)).toEqual(FEE_MISSING);
  // 列为空就是最近一次报文没给（B1-08v）：跳过或沿用同一原因都行，新开 AMOUNT_PARSE_FAILED 行不行。
  expect([FEE_MISSING, { kind: 'skip', reason: 'service_fee_unknown' }]).toContainEqual(
    retryPlan('pdd', { est: null }, 'unknown'),
  );
  expect(retryPlan('pdd', { est: null }, 100n)).toEqual(AMOUNT_FAILED);
});

it('[AC-B1-08zh#12][BR-CALC-02] 扫描排序：拼多多有 N 而服务费列为空不再必然 skip；paidAt 不可恢复仍然 skip', () => {
  const scan = (service_fee_fen: bigint | null, paid_at: Date | null) =>
    isScanSkipCertain({
      platform: 'pdd',
      est_commission_fen: 900n,
      settle_commission_fen: null,
      service_fee_fen,
      paid_at_source: 'platform',
      paid_at,
    });
  expect(scan(null, PAID)).toBe(false);
  expect(scan(100n, PAID)).toBe(false);
  expect(scan(null, null)).toBe(true);
});

it('[AC-B1-08zh#13][BR-CALC-03] 其他平台不变：淘宝、京东没有服务费也不进 SERVICE_FEE_RATE_MISSING，N 不受影响', () => {
  expect(nOf(snapshotPlan('pdd', { est: 900n }, 100n))).toBe(900n);

  for (const platform of ['taobao', 'jd'] as const) {
    expect(nOf(snapshotPlan(platform, { est: 1000n }, null)), platform).toBe(1000n);
    expect(nOf(snapshotPlan(platform, { est: 1000n }, 150n)), platform).toBe(1000n);
    expect(nOf(snapshotPlan(platform, { est: 1000n, settle: 800n }, null)), platform).toBe(800n);
    expect(snapshotPlan(platform, { est: null }, null), platform).toEqual(AMOUNT_FAILED);
    expect(nOf(retryPlan(platform, { est: 1000n }, null)), platform).toBe(1000n);
    expect(retryPlan(platform, { est: null }, null), platform).toEqual(AMOUNT_FAILED);
  }
});
