// B1-08k：归因流水线第 ⑥ 步「分佣快照调用」的纯判定（BR-ATTR-01 ⑥、BR-CALC-10 / 11 / 02 / 03 / 19 / 27）。
// 不做 I/O：调用方（首次入库与已有订单更新）把本次 ⑦ 迁移后的取值与写库后的金额喂进来，这里决定
// skip（本次没有跨入资格）/ pending（不调端口，进待处理）/ call（组好 commission 快照端口的入参）。
// - 资格：user_id 非空 ∧ platform_status ∈ {PAID, RECEIVED, SETTLED} ∧ rebate_status ∉ {VOID, CLAWED_BACK}；
//   只在本次由「不满足」跨入「满足」时不为 skip（「首次」；commission_splits 以 order_id 唯一兜底）。
// - paid_at（BR-CALC-11 细则）：平台付款时间（预售须是尾款时间）→ 迁到 PAID 那条报文的平台更新时间 →
//   本系统首次观测到 PAID+ 的时刻。
// - N（BR-CALC-02 取值阶段）：结算收入非空只取结算收入，否则取预估收入；两者都空不按 0 兜底。
//   拼多多的联盟佣金含软件服务费，N = 佣金 − 服务费（BR-CALC-03；D10-42 / D10-66），服务费缺失进待处理。
// 金额只经 @couli/money（整数分，可为负）。
import type { OrderPlatformState } from '@couli/domain';
import type { components } from '@couli/contracts-ts';
import { findPlatformRules } from './platform-rules/index.ts';

/**
 * commission 快照端口的入参（与 commission/index.ts 导出的 CreateCommissionSnapshotInput 逐字段同构；
 * 源码旁单元测试做双向可赋值检查）。orders 的领域层不依赖别的模块，所以在这里按结构声明。
 */
export interface CommissionSnapshotCallInput {
  readonly appId: string;
  readonly orderId: string;
  readonly platform: components['schemas']['PlatformCode'];
  readonly paidAt: Date;
  readonly paidAtSource: PaidAtSource;
  readonly orderType: 'self' | 'share';
  readonly activityType: string | null;
  readonly rebateMode: 'none' | 'normal' | null;
  readonly nBaseFen: bigint;
  readonly subsidyCommissionFen: bigint;
  readonly tljDeductFen: bigint;
  readonly tljRedpacketFen: bigint | null;
  readonly ownerUserId: string;
}

export type PaidAtSource = 'platform' | 'platform_modified' | 'observed';

export interface SnapshotEligibility {
  readonly user_id: string | null;
  readonly platform_status: OrderPlatformState;
  readonly rebate_status: string;
}

export interface PlanCommissionSnapshotInput {
  /** 本次处理前的资格三元组；首次入库为 null。 */
  readonly before: SnapshotEligibility | null;
  /** 本次 ⑦ 迁移与 ② 归属之后；rebate_status 由 settlement 写，这里是本次处理前的值。 */
  readonly after: {
    readonly user_id: string | null;
    readonly platform_status: OrderPlatformState;
    readonly rebate_status_before: string;
  };
  /** 写库后的订单行取值。 */
  readonly order: {
    readonly app_id: string;
    readonly order_id: string;
    readonly platform: CommissionSnapshotCallInput['platform'];
    readonly buy_type: 'self' | 'share';
    readonly activity_type: string | null;
    readonly is_presale: boolean;
    readonly paid_at: Date | null;
    readonly deposit_paid_at: Date | null;
    readonly est_commission_fen: bigint | null;
    readonly settle_commission_fen: bigint | null;
    readonly subsidy_commission_fen: bigint | null;
  };
  /** 本次报文。 */
  readonly incoming: {
    readonly modified_at: Date | null;
    readonly service_fee_fen: bigint | null;
  };
  /** 订单推广位的 pid_scene；查不到为 null（按非淘礼金处理）。 */
  readonly pidScene: string | null;
  /** 本次处理就是该单首次进入 PAID+ 的那次（含首次入库即 PAID+）。 */
  readonly movedToPaidNow: boolean;
  /** 该单 order_status_history 首条到 PAID+ 的时刻（本事务刚写的为本次 now）；没有为 null。 */
  readonly firstPaidAt: Date | null;
  readonly now: Date;
}

/** 计划阶段就不调端口的原因（order_sync_pending.reason 已登记值）。 */
export type SnapshotPendingReason = 'AMOUNT_PARSE_FAILED' | 'SERVICE_FEE_RATE_MISSING';

export type CommissionSnapshotPlan =
  | { readonly kind: 'skip' }
  | { readonly kind: 'pending'; readonly reason: SnapshotPendingReason }
  | { readonly kind: 'call'; readonly input: CommissionSnapshotCallInput };

const PAID_OR_LATER: ReadonlySet<OrderPlatformState> = new Set(['PAID', 'RECEIVED', 'SETTLED']);
/** BR-ATTR-01 ⑥：返利已作废 / 已扣回的不生成快照（R3b 不生成，BR-CALC-10）。 */
const NO_SNAPSHOT_REBATE: ReadonlySet<string> = new Set(['VOID', 'CLAWED_BACK']);
/** BR-CALC-19：我方淘礼金推广位。 */
const TAOLIJIN_SCENE = 'taolijin';

export function isPaidOrLater(status: string): boolean {
  return PAID_OR_LATER.has(status as OrderPlatformState);
}

export function isSnapshotEligible(state: SnapshotEligibility): boolean {
  return (
    state.user_id !== null &&
    isPaidOrLater(state.platform_status) &&
    !NO_SNAPSHOT_REBATE.has(state.rebate_status)
  );
}

/** 「首次」= 本次由不满足资格跨入满足资格；首次入库 before 为 null。 */
export function crossesSnapshotEligibility(
  before: SnapshotEligibility | null,
  after: PlanCommissionSnapshotInput['after'],
): boolean {
  const now: SnapshotEligibility = {
    user_id: after.user_id,
    platform_status: after.platform_status,
    rebate_status: after.rebate_status_before,
  };
  return isSnapshotEligible(now) && (before === null || !isSnapshotEligible(before));
}

/**
 * BR-CALC-11 细则的 paid_at 降级顺序。非预售与「尾款时间已不同于定金时间」的预售取平台付款时间；
 * 预售付款时间仍是定金时间（或缺失）时，本次就是迁到 PAID 的那次且报文带平台更新时间 → 取它；
 * 否则取本系统首次观测到 PAID+ 的时刻（晚归属时是旧的首条历史，不是本次 now）。
 */
export function chooseSnapshotPaidAt(
  input: Pick<
    PlanCommissionSnapshotInput,
    'order' | 'incoming' | 'movedToPaidNow' | 'firstPaidAt' | 'now'
  >,
): { readonly paidAt: Date; readonly paidAtSource: PaidAtSource } {
  const { paid_at: paidAt, deposit_paid_at: depositAt } = input.order;
  if (paidAt !== null && (depositAt === null || paidAt.getTime() !== depositAt.getTime())) {
    return { paidAt, paidAtSource: 'platform' };
  }
  const modifiedAt = input.incoming.modified_at;
  if (input.movedToPaidNow && modifiedAt !== null) {
    return { paidAt: modifiedAt, paidAtSource: 'platform_modified' };
  }
  return { paidAt: input.firstPaidAt ?? input.now, paidAtSource: 'observed' };
}

export function planCommissionSnapshot(input: PlanCommissionSnapshotInput): CommissionSnapshotPlan {
  if (!crossesSnapshotEligibility(input.before, input.after)) return { kind: 'skip' };
  const ownerUserId = input.after.user_id;
  if (ownerUserId === null) return { kind: 'skip' };
  const { order } = input;
  // BR-CALC-02 取值阶段：结算收入一旦非空只取结算收入（写库后的值）。
  const commission = order.settle_commission_fen ?? order.est_commission_fen;
  if (commission === null) {
    // BR-CALC-03：est 已是净额（适配器扣，B1-08zh）；为空且本次没有服务费 = 缺费率，不按 0。
    const feeMissing =
      findPlatformRules(order.platform)?.serviceFeeDeducted === true &&
      input.incoming.service_fee_fen === null;
    return {
      kind: 'pending',
      reason: feeMissing ? 'SERVICE_FEE_RATE_MISSING' : 'AMOUNT_PARSE_FAILED',
    };
  }
  const nBaseFen = commission;
  const paid = chooseSnapshotPaidAt(input);
  // BR-CALC-19 / 27：淘礼金面额匹配（tlj_grants）未实现，一律视为匹配不到 → 照常生成、rebate_mode=none、
  // 红包面额记空（D10-68；待处理与告警由调用方写）；非淘礼金 rebate_mode 为空、红包 0。
  // 淘礼金扣除只在 normal 模式下非 0，这里恒为 0。
  const taolijin = input.pidScene === TAOLIJIN_SCENE;
  return {
    kind: 'call',
    input: {
      appId: order.app_id,
      orderId: order.order_id,
      platform: order.platform,
      paidAt: paid.paidAt,
      paidAtSource: paid.paidAtSource,
      orderType: order.buy_type,
      activityType: order.activity_type,
      rebateMode: taolijin ? 'none' : null,
      nBaseFen,
      subsidyCommissionFen: order.subsidy_commission_fen ?? 0n,
      tljDeductFen: 0n,
      tljRedpacketFen: taolijin ? null : 0n,
      ownerUserId,
    },
  };
}

/**
 * 写进 orders.paid_at_source 的来源（BR-CALC-11「在订单与快照记」）：本次跨入资格时写，计划 pending 也写
 * （取值同将来快照的口径）；skip 不写。
 */
export function snapshotPaidAtSource(
  input: PlanCommissionSnapshotInput,
  plan: CommissionSnapshotPlan,
): PaidAtSource | null {
  if (plan.kind === 'skip') return null;
  if (plan.kind === 'call') return plan.input.paidAtSource;
  return chooseSnapshotPaidAt(input).paidAtSource;
}
