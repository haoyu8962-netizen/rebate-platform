// B1-08t：分佣快照补偿重试的纯判定（BR-ATTR-01 ⑥、BR-CALC-10 的实现方案；08 未写重试，编排裁定 D10-81 / D10-84）。
// 不做 I/O。信号只看「该子订单仍有 open 的快照类待处理行」，不看 commission_splits 是否存在；资格沿用
// isSnapshotEligible（本次 ⑦ 迁移与 ② 归属后的值，rebate_status 用库内值）。planCommissionSnapshot 与
// crossesSnapshotEligibility 的行为不变（「首次跨入」仍只由它们判定）。
// - 入参恢复：N = 结算收入 ?? 预估收入，不再减服务费（est 已是净额，适配器算，B1-08zh）。两者都空：
//   拼多多且没有服务费（报文没给，或扫描读到列为空）→ SERVICE_FEE_RATE_MISSING；其余 → AMOUNT_PARSE_FAILED。
//   都不按 0 兜底。
// - paidAt 按库内 paid_at_source：platform → paid_at；observed → 首条到 PAID+ 的历史时刻；platform_modified
//   （预售迁到 PAID 那条报文的平台更新时间）不可恢复 → skip paid_at_unknown；为空 → chooseSnapshotPaidAt
//   （movedToPaidNow=false），由调用方照 B1-08k 写入 paid_at_source。
// - 淘礼金场景：推广位场景取不到（扫描路径无 pids 端口）的淘宝单 → skip pid_scene_unknown，不替它选返利模式。
// - 扫描排序（B1-08v，待编排裁定 3）：isScanSkipCertain 判定扫描路径必然 skip 的单，候选排序把它们排在末尾。
// 金额只经 @couli/money（整数分）。
import {
  chooseSnapshotPaidAt,
  type CommissionSnapshotCallInput,
  type PaidAtSource,
  type SnapshotPendingReason,
} from './commission-snapshot.ts';
import { findPlatformRules } from './platform-rules/index.ts';

/** 快照类待处理原因（B1-08k 写入）；TLJ_FACE_VALUE_UNMATCHED 是快照已生成后另写的，不属于重试对象。 */
export const SNAPSHOT_RETRY_REASONS = [
  'RULE_VERSION_PLATFORM_MISSING',
  'AMOUNT_PARSE_FAILED',
  'SERVICE_FEE_RATE_MISSING',
] as const;
export type SnapshotRetryReason = (typeof SNAPSHOT_RETRY_REASONS)[number];

export function isSnapshotRetryReason(reason: string): reason is SnapshotRetryReason {
  return (SNAPSHOT_RETRY_REASONS as readonly string[]).includes(reason);
}

/** 待编排裁定 6（默认）：08 无值。扫描每 15 分钟一轮、每轮至多 100 个子订单，open 满 1 小时到期。 */
export const SNAPSHOT_RETRY_SCAN_INTERVAL_MS = 15 * 60_000;
export const SNAPSHOT_RETRY_BATCH = 100;
export const SNAPSHOT_RETRY_DUE_MS = 3_600_000;
/** 最早一条 open 快照类行的 created_at 满 24 小时后仍失败 → 告警转人工。 */
export const SNAPSHOT_RETRY_EXHAUSTED_MS = 24 * 3_600_000;

/** 转人工后写在仍为 open 的快照类行上的系统标记（不含个人信息）；有此标记的子订单不再自动重试。 */
export const SNAPSHOT_RETRY_HANDOFF_NOTE = 'auto: commission snapshot retry exhausted; manual';

export function snapshotResolutionNote(outcome: 'created' | 'existing'): string {
  return `auto: commission snapshot ${outcome}`;
}

/** 扫描是否到期：该子订单 open 快照类行里最晚一次 detected_at 不晚于 now − 1 小时（恰好 1 小时算到期）。 */
export function isSnapshotRetryDue(latestDetectedAt: Date, now: Date): boolean {
  return latestDetectedAt.getTime() <= now.getTime() - SNAPSHOT_RETRY_DUE_MS;
}

/** 是否已满 24 小时：最早一条 open 快照类行的 created_at 不晚于 now − 24 小时。 */
export function isSnapshotRetryExhausted(earliestCreatedAt: Date, now: Date): boolean {
  return earliestCreatedAt.getTime() <= now.getTime() - SNAPSHOT_RETRY_EXHAUSTED_MS;
}

export type SnapshotRetrySkipReason = 'paid_at_unknown' | 'pid_scene_unknown';

export type SnapshotRetryPlan =
  | { readonly kind: 'skip'; readonly reason: SnapshotRetrySkipReason }
  | { readonly kind: 'pending'; readonly reason: SnapshotPendingReason }
  | { readonly kind: 'call'; readonly input: CommissionSnapshotCallInput };

export interface SnapshotRetryPaid {
  readonly paidAt: Date;
  readonly paidAtSource: PaidAtSource;
  /** 库内 paid_at_source 为空、按 chooseSnapshotPaidAt 定出来源，调用方须照 B1-08k 写入订单。 */
  readonly writeSource: boolean;
}

/** 按库内 paid_at_source 恢复快照的 paidAt；不可恢复返回 null。 */
export function resolveRetryPaidAt(input: {
  readonly paidAtSource: string | null;
  readonly paidAt: Date | null;
  readonly depositPaidAt: Date | null;
  readonly firstPaidAt: Date | null;
  readonly now: Date;
}): SnapshotRetryPaid | null {
  switch (input.paidAtSource) {
    case 'platform':
      return input.paidAt === null
        ? null
        : { paidAt: input.paidAt, paidAtSource: 'platform', writeSource: false };
    case 'observed':
      return input.firstPaidAt === null
        ? null
        : { paidAt: input.firstPaidAt, paidAtSource: 'observed', writeSource: false };
    case null: {
      const chosen = chooseSnapshotPaidAt({
        order: {
          app_id: '',
          order_id: '',
          platform: 'jd',
          buy_type: 'self',
          activity_type: null,
          is_presale: false,
          paid_at: input.paidAt,
          deposit_paid_at: input.depositPaidAt,
          est_commission_fen: null,
          settle_commission_fen: null,
          subsidy_commission_fen: null,
        },
        incoming: { modified_at: null, service_fee_fen: null },
        movedToPaidNow: false,
        firstPaidAt: input.firstPaidAt,
        now: input.now,
      });
      return { ...chosen, writeSource: true };
    }
    default:
      // platform_modified：迁到 PAID 那条报文的平台更新时间未持久化（待编排裁定 2）；未知值同样不猜。
      return null;
  }
}

export interface PlanSnapshotRetryInput {
  readonly order: {
    readonly app_id: string;
    readonly order_id: string;
    readonly platform: CommissionSnapshotCallInput['platform'];
    readonly buy_type: 'self' | 'share';
    readonly activity_type: string | null;
    readonly est_commission_fen: bigint | null;
    readonly settle_commission_fen: bigint | null;
    readonly subsidy_commission_fen: bigint | null;
  };
  readonly ownerUserId: string;
  /** null = paidAt 不可恢复。 */
  readonly paid: SnapshotRetryPaid | null;
  /** 拼多多服务费：流水线为本次报文的值（null = 报文没给）；扫描为订单当前列，列为空传 'unknown'。 */
  readonly serviceFeeFen: bigint | null | 'unknown';
  /** 订单推广位的 pid_scene；'unknown' = 无从查询（扫描路径无 pids 端口）。 */
  readonly pidScene: string | null | 'unknown';
}

const TAOLIJIN_SCENE = 'taolijin';
/**
 * 报文佣金含服务费的平台（拼多多，净额在适配器算，B1-08zh，这里不再减）。B1-08za：判定只查规则表的
 * serviceFeeDeducted；本常量只留作 SQL（infra/snapshot-retry-store.ts）的单平台取值，须与规则表一致。
 */
export const SERVICE_FEE_PLATFORM = 'pdd' as const;
/**
 * 推广位场景（淘礼金）决定返利模式的平台；扫描路径查不到场景，此平台的单一律 skip。B1-08za：判定只查规则表的
 * taolijinPidScene；本常量只留作 SQL 的单平台取值，须与规则表一致。
 */
export const PID_SCENE_PLATFORM = 'taobao' as const;

/** 重试时的入参组装；判定顺序与 planCommissionSnapshot 一致（金额 → 服务费 → paidAt），其余字段同 B1-08k。 */
export function planSnapshotRetry(input: PlanSnapshotRetryInput): SnapshotRetryPlan {
  const { order } = input;
  const rules = findPlatformRules(order.platform);
  const commission = order.settle_commission_fen ?? order.est_commission_fen;
  if (commission === null) {
    // est 已是净额（B1-08zh）；N 为空只看服务费有没有：没有（含扫描读到列为空）是缺费率，不是 skip，
    // pending 会刷新 detected_at，不占扫描名额。
    const feeMissing =
      rules?.serviceFeeDeducted === true && typeof input.serviceFeeFen !== 'bigint';
    return {
      kind: 'pending',
      reason: feeMissing ? 'SERVICE_FEE_RATE_MISSING' : 'AMOUNT_PARSE_FAILED',
    };
  }
  const nBaseFen = commission;
  if (input.paid === null) return { kind: 'skip', reason: 'paid_at_unknown' };
  let pidScene: string | null;
  if (input.pidScene === 'unknown') {
    // 淘礼金只在淘宝；别的平台场景未知时与 B1-08k「查不到 → 非淘礼金」一致。
    if (rules?.taolijinPidScene === true) return { kind: 'skip', reason: 'pid_scene_unknown' };
    pidScene = null;
  } else {
    pidScene = input.pidScene;
  }
  const taolijin = pidScene === TAOLIJIN_SCENE;
  return {
    kind: 'call',
    input: {
      appId: order.app_id,
      orderId: order.order_id,
      platform: order.platform,
      paidAt: input.paid.paidAt,
      paidAtSource: input.paid.paidAtSource,
      orderType: order.buy_type,
      activityType: order.activity_type,
      rebateMode: taolijin ? 'none' : null,
      nBaseFen,
      subsidyCommissionFen: order.subsidy_commission_fen ?? 0n,
      tljDeductFen: 0n,
      tljRedpacketFen: taolijin ? null : 0n,
      ownerUserId: input.ownerUserId,
    },
  };
}

/** 扫描排序用的订单列（读自 orders 当前行）。 */
export interface ScanSkipOrder {
  readonly platform: string;
  readonly est_commission_fen: bigint | null;
  readonly settle_commission_fen: bigint | null;
  readonly service_fee_fen: bigint | null;
  readonly paid_at_source: string | null;
  readonly paid_at: Date | null;
}

/**
 * B1-08v（待编排裁定 3）：扫描路径对该单是否必然 skip（只看订单列，不读状态历史）。与 readSnapshotRetryInput →
 * planSnapshotRetry 的 skip 分支同口径：佣金基数可得（否则是 pending AMOUNT_PARSE_FAILED，会刷新 detected_at），且
 * ① paidAt 不可恢复（platform 而 paid_at 为空；platform_modified 或未知来源），或
 * ③ 淘宝（推广位场景未知）。observed 而状态历史没有到 PAID+ 的记录也会 skip，但要读历史，这里不计（排在前面只是多试一次）。
 * skip 不刷新 detected_at、不离开候选；selectDueSubOrders 按同一口径把这类单排在候选末尾，免得它们占满每轮名额
 * 饿死后面的订单。两处须同改（SQL 在 infra/snapshot-retry-store.ts）。
 */
export function isScanSkipCertain(order: ScanSkipOrder): boolean {
  if ((order.settle_commission_fen ?? order.est_commission_fen) === null) return false;
  const rules = findPlatformRules(order.platform);
  const source = order.paid_at_source;
  if (source === 'platform' && order.paid_at === null) return true;
  if (source !== null && source !== 'platform' && source !== 'observed') return true;
  return rules?.taolijinPidScene === true;
}
