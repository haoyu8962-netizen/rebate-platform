// B2-04j：入账前返利迁移的纯判定（BR-FUND-01 R1–R7、BR-FUND-02、BR-FUND-03、BR-FUND-04 ②、BR-FUND-06、
// BR-FUND-07）。不读库、不读时钟；状态合法性只经生成的 transitionOrderRebate。
import { transitionOrderRebate, type OrderRebateEvent, type OrderRebateState } from '@couli/domain';

/** 订单原因码（orders.reason，BR-FUND-07 的 void 类编码）。 */
export type VoidReason = 'REFUND' | 'RIGHTS' | 'PUNISH' | 'BLACKLIST' | 'COMMISSION_ZERO';

/** R6 的作废事件 → 原因码（BR-FUND-07）。 */
export function voidReasonOf(event: OrderRebateEvent): VoidReason | null {
  switch (event) {
    case 'PLATFORM_INVALID':
      return 'REFUND';
    case 'RIGHTS_FULL':
      return 'RIGHTS';
    case 'PUNISH':
      return 'PUNISH';
    case 'BLACKLIST_HIT':
      return 'BLACKLIST';
    case 'BASE_ZERO':
      return 'COMMISSION_ZERO';
    default:
      return null;
  }
}

/** 入账前可迁移的状态（R6 的来源）。 */
export function isPrecredit(state: string): state is 'UNATTRIBUTED' | 'ESTIMATED' | 'WAITING' {
  return state === 'UNATTRIBUTED' || state === 'ESTIMATED' || state === 'WAITING';
}

/** BR-FUND-06：hold 只能对 ESTIMATED / WAITING 设置（R11）。 */
export function isHoldable(state: string): state is 'ESTIMATED' | 'WAITING' {
  return state === 'ESTIMATED' || state === 'WAITING';
}

/** 已锁定订单（BR-FUND-01 细则「订单锁定」）：平台正向推进与重复上报不改变返利。 */
export function isLocked(state: string): state is 'VOID' | 'CREDITED' | 'CLAWED_BACK' {
  return state === 'VOID' || state === 'CREDITED' || state === 'CLAWED_BACK';
}

export function isRebateState(state: string): state is OrderRebateState {
  return isPrecredit(state) || isLocked(state);
}

/** BR-FUND-03：已归因且 platform_status ∈ {PAID, RECEIVED, SETTLED} 才有预估。 */
export function hasEstimate(platformStatus: string): boolean {
  return platformStatus === 'PAID' || platformStatus === 'RECEIVED' || platformStatus === 'SETTLED';
}

/**
 * BR-FUND-02 可入账事件已登记的平台（taobao、jd、pdd = 确认收货；meituan = 订单完成或核销）。P1 平台
 * （vip、douyin、eleme）未写入前不进入 WAITING。
 * TODO(规划/11 §4.2): 改为读 specs/creditable-events.yaml — blocked on 该文件尚未建立。
 */
export function isCreditablePlatform(platform: string): boolean {
  return platform === 'taobao' || platform === 'jd' || platform === 'pdd' || platform === 'meituan';
}

/** R4 的触发状态：平台已收货或已结算。 */
export function isReceivedOrSettled(platformStatus: string): boolean {
  return platformStatus === 'RECEIVED' || platformStatus === 'SETTLED';
}

/**
 * BR-FUND-07 / R6 基数归零分支：原有效基数为正、新有效基数为 0（null 表示未知，不视为 0）。有效基数按
 * BR-FUND-03 取「有结算佣金用结算佣金、否则用预估」，结算佣金参与判定；平台处于定金期、或本次是从定金期
 * 进入付款（P2 / P14 的「首次 B_est」）时不触发。「结算佣金已到后预估单独变化」的豁免在 commissionChangeOf 判定，
 * 不在这里按结算佣金非空一刀切排除。
 */
export function isBaseZero(input: {
  readonly before: bigint | null;
  readonly after: bigint | null;
  readonly platformStatus: string;
  readonly fromPlatformStatus: string | null;
}): boolean {
  if (input.platformStatus === 'DEPOSIT_PAID' || input.fromPlatformStatus === 'DEPOSIT_PAID') {
    return false;
  }
  return input.before !== null && input.before > 0n && input.after === 0n;
}

/**
 * 本次同步报文里有效联盟佣金（BR-FUND-03：结算佣金优先，否则预估）可能怎样变化：
 * - none：有效佣金没变（定金期一律 none，BR-FUND-07；无结算佣金且预估未变）。
 * - estimate：无结算佣金、预估变化 → 按有效基数比较走 R6 / R7。
 * - settle_arrived：结算佣金本次首次写入（orders 只在平台已结算时写结算佣金，来源不是 SETTLED 即此前为空）→
 *   有效佣金由预估换成结算额，走 R6 / R7。
 * - settle_recheck：平台本来就已结算、本次报文后有结算佣金 → 不论预估是否变化，一律取估值端口的前后有效
 *   基数比较（端口不给旧结算额，结算额可能与预估同报文被修正）；只有前后有效基数相同才算「结算额未变」，
 *   此时预估变化按 BR-FUND-03 / 07 豁免：只存档、不重算、不触发 COMMISSION_ZERO。
 */
export type CommissionChange = 'none' | 'estimate' | 'settle_arrived' | 'settle_recheck';

export function commissionChangeOf(input: {
  readonly estBefore: bigint | null;
  readonly estAfter: bigint | null;
  readonly settleCommissionFen: bigint | null;
  readonly platformStatus: string;
  readonly fromPlatformStatus: string;
}): CommissionChange {
  if (input.platformStatus === 'DEPOSIT_PAID') return 'none';
  if (input.settleCommissionFen === null) {
    return input.estBefore !== input.estAfter ? 'estimate' : 'none';
  }
  return input.fromPlatformStatus !== 'SETTLED' ? 'settle_arrived' : 'settle_recheck';
}

/**
 * 有效佣金变化后的返利结论（判定先于写库）：void = R6 BASE_ZERO；recalc = R7 COMMISSION_CHANGED 并重算预估
 * （只对 ESTIMATED / WAITING）；none = 不动。settle_recheck 只有前后有效基数不同才算变化。
 */
export function commissionOutcome(input: {
  readonly change: CommissionChange;
  readonly before: bigint | null;
  readonly after: bigint | null;
  readonly platformStatus: string;
  readonly fromPlatformStatus: string | null;
}): 'void' | 'recalc' | 'none' {
  if (input.change === 'none') return 'none';
  if (isBaseZero(input)) return 'void';
  if (input.change === 'settle_recheck' && input.before === input.after) return 'none';
  return 'recalc';
}

/** 本次报文的平台事件映射到 R6 的作废事件（P6 / P7 → 整单失效，P8 处罚 → PUNISH）；其他为 null。 */
export function reverseEventOf(
  sourceEvent: string | null,
  platformStatus: string,
): 'PLATFORM_INVALID' | 'PUNISH' | null {
  if (sourceEvent === 'PLATFORM_INVALID' || platformStatus === 'INVALID') return 'PLATFORM_INVALID';
  if (sourceEvent === 'PLATFORM_PUNISH') return 'PUNISH';
  return null;
}

export interface RebateStep {
  readonly from: OrderRebateState | null;
  readonly event: OrderRebateEvent;
  readonly to: OrderRebateState;
}

/** 按生成的迁移表求一步；表外返回 null。 */
export function step(from: OrderRebateState | null, event: OrderRebateEvent): RebateStep | null {
  const result = transitionOrderRebate(from, event);
  return result.ok ? { from, event, to: result.to } : null;
}

/** settle.period_basis.<platform> 的取值：未配置按默认 received_at；其他取值本任务不认。 */
export function periodBasisSupported(value: unknown): boolean {
  return value === undefined || value === null || value === 'received_at';
}

/** order_sync.unmapped_status_hold.enabled：默认 on，只有明确的 off 才关闭。 */
export function unmappedHoldEnabled(value: unknown): boolean {
  return !(value === false || value === 'false' || value === 'off');
}

/** B2-04zzg：入账前判定读到的件数事实（同步事务里锁内重读的 orders 行；两列由 orders 写，B1-08zi）。 */
export interface RemainingQuantityFacts {
  readonly platform: string;
  readonly quantity: number | null;
  readonly refunded_quantity: number | null;
}

/**
 * B2-04zzg（BR-CALC-15「剩余数量为 0 …按整单失效处理（入账前 R6 → VOID）」，D10-864 ②、D10-875、D10-878）：
 * 京东单两列都已知且 quantity − refunded_quantity ≤ 0 → 剩余为 0。只看 platform jd（淘宝、拼多多两列保持 null，
 * B1-08zi）；任一列为空不判定；quantity 为 0 的单也不判定（没有件数就没有「剩余」）。
 */
export function jdRemainingZero(order: RemainingQuantityFacts): boolean {
  if (order.platform !== 'jd') return false;
  if (order.quantity === null || order.refunded_quantity === null) return false;
  if (order.quantity <= 0) return false;
  return order.quantity - order.refunded_quantity <= 0;
}
