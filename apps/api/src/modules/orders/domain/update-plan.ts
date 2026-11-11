// B1-08i：已有子订单同步更新的纯判定（BR-FUND-01 / 02 / 03 / 07；D10-41）。判定先于写库：
// 原始码 → 映射事件 → 生成的 transitionOrderPlatform 判定本次迁移，再展开为逐步的 history 计划。
// - 表外事件（illegal）→ 整条拒收，pending ILLEGAL_TRANSITION（不受 P10 开关影响）。
// - P10 倒退：开关开 → 整条拒收；开关关 → 状态不迁移、其余列照写；两种都留 pending ILLEGAL_TRANSITION。
// - 表外码：返利状态 CREDITED / CLAWED_BACK（待编排裁定 2）→ 整条拒收；其余 → 状态不变、其余列照写；
//   两种都留 pending UNMAPPED_STATUS（hold 由 settlement 经端口决定）。
// - P7 / P8 / P15：noop，不写 history，规则编号交 settlement。
// - P3 / P14 缺收货时间、P5 缺收货与结算时间：不越过 PAID，pending NO_RECEIVED_AT（待编排裁定 4）。
// - P5（及到 SETTLED 而库内无收货时间的其他步）：received_at = 平台收货时间 ?? 平台结算时间（BR-FUND-02）。
// 每一步都再经 transitionOrderPlatform 判定（P5 自 DEPOSIT_PAID 三步、自 PAID 两步；P14 两步）。
import { transitionOrderPlatform, type OrderPlatformState } from '@couli/domain';
import type { DB } from '@couli/db';
import type { Selectable } from 'kysely';
import type { UnionOrder } from '../../union/index.ts';
import { orderContentHash } from './content-hash.ts';
import type { ImportHistory } from './import-state.ts';
import { rawItemId, rawPayloadId } from './order-fields.ts';
import { mapPlatformStatus, type PlatformStatusEvent, type StatusMap } from './status-map.ts';

export interface UpdateStateInput {
  readonly platform_status: OrderPlatformState;
  readonly rebate_status: string;
  readonly received_at: Date | null;
}

export interface OrderUpdatePlan {
  readonly kind: 'pending' | 'update';
  readonly platform_status: OrderPlatformState;
  readonly received_at: Date | null;
  readonly history: readonly ImportHistory[];
  readonly pending: 'ILLEGAL_TRANSITION' | 'UNMAPPED_STATUS' | 'NO_RECEIVED_AT' | null;
  readonly rule: string | null;
  /** 本次报文映射到的事件；表外码为 null（供待处理说明，并经 OrderStatusSource 交 settlement；不写 orders）。 */
  readonly event?: PlatformStatusEvent | null;
}

/** 已入账（含已追回，待编排裁定 2）的订单收到表外码：整条报文不落 orders（BR-FUND-02 细则 ②）。 */
const BOOKED_REBATE: ReadonlySet<string> = new Set(['CREDITED', 'CLAWED_BACK']);

/** 经过 RECEIVED、须有可用收货时间的迁移（P3、P14、P5）。 */
const RECEIVED_GUARDED: ReadonlySet<string> = new Set(['P3', 'P14', 'P5']);

/** 事件到它对应的推进步：P5 / P14 从当前状态补走的中间步（每步仍经 transition 判定）。 */
const STEP_EVENTS: Readonly<Record<OrderPlatformState, PlatformStatusEvent>> = {
  DEPOSIT_PAID: 'PLATFORM_DEPOSIT_PAID',
  PAID: 'PLATFORM_PAID',
  RECEIVED: 'PLATFORM_RECEIVED',
  SETTLED: 'PLATFORM_SETTLED',
  INVALID: 'PLATFORM_INVALID',
};

/** P5 / P14 的补写路径（不含 from 本身）；其他迁移只有一步。 */
function pathTo(
  from: OrderPlatformState,
  rule: string,
  to: OrderPlatformState,
): OrderPlatformState[] {
  if (rule === 'P5') {
    return from === 'DEPOSIT_PAID' ? ['PAID', 'RECEIVED', 'SETTLED'] : ['RECEIVED', 'SETTLED'];
  }
  if (rule === 'P14') return ['PAID', 'RECEIVED'];
  return [to];
}

interface Walked {
  readonly history: ImportHistory[];
  readonly to: OrderPlatformState;
  readonly rule: string | null;
}

/** Walks the generated table step by step; a step that is not a real move is a bug in pathTo. */
function walk(from: OrderPlatformState, states: readonly OrderPlatformState[]): Walked {
  const history: ImportHistory[] = [];
  let cursor = from;
  let rule: string | null = null;
  for (const state of states) {
    const event = STEP_EVENTS[state];
    const step = transitionOrderPlatform(cursor, event);
    if (!step.ok || step.noop || step.to !== state) {
      throw new Error(`ORDER_PLAN_STEP_INVALID: ${cursor}→${event}`);
    }
    history.push({ from_status: cursor, event, to_status: state });
    cursor = state;
    rule = step.id;
  }
  return { history, to: cursor, rule };
}

export function planOrderUpdate(
  current: UpdateStateInput,
  incoming: UnionOrder,
  map: StatusMap,
  regressionHold: boolean,
): OrderUpdatePlan {
  const from = current.platform_status;
  const incomingReceived = incoming.received_at ?? null;
  const incomingSettled = incoming.settled_at ?? null;
  /** 状态不迁移时的结果；整条拒收的不写任何列，received_at 保持库内值。 */
  const stay = (
    kind: OrderUpdatePlan['kind'],
    pending: OrderUpdatePlan['pending'],
    rule: string | null,
    event: PlatformStatusEvent | null,
  ): OrderUpdatePlan => ({
    kind,
    platform_status: from,
    received_at:
      kind === 'pending' ? current.received_at : (current.received_at ?? incomingReceived),
    history: [],
    pending,
    rule,
    event,
  });

  const mapped = mapPlatformStatus(map, incoming.raw_status ?? null);
  if (mapped.kind === 'unmapped') {
    const booked = BOOKED_REBATE.has(current.rebate_status);
    return stay(booked ? 'pending' : 'update', 'UNMAPPED_STATUS', null, null);
  }
  const event = mapped.event;
  const result = transitionOrderPlatform(from, event);
  if (!result.ok) {
    if (result.reason === 'backward') {
      return stay(regressionHold ? 'pending' : 'update', 'ILLEGAL_TRANSITION', 'P10', event);
    }
    return stay('pending', 'ILLEGAL_TRANSITION', null, event);
  }
  if (result.noop) return stay('update', null, result.id, event);

  const target = result.to;
  const path = pathTo(from, result.id, target);
  // BR-FUND-02：收货时间只取平台收货时间；到 SETTLED 而未给收货时取平台结算时间。已有值不覆盖。
  const received =
    current.received_at ??
    (target === 'SETTLED' ? (incomingReceived ?? incomingSettled) : incomingReceived);
  if (RECEIVED_GUARDED.has(result.id) && received === null) {
    // P3 / P14 / P5 缺可用收货时间：不越过 PAID，收货事件进待处理（待编排裁定 4；R4 守卫）。
    const walked = walk(from, path.slice(0, path.indexOf('RECEIVED')));
    return {
      kind: 'update',
      platform_status: walked.to,
      received_at: null,
      history: walked.history,
      pending: 'NO_RECEIVED_AT',
      rule: walked.rule,
      event,
    };
  }
  const walked = walk(from, path);
  return {
    kind: 'update',
    platform_status: walked.to,
    received_at: received,
    history: walked.history,
    pending: null,
    rule: result.id,
    event,
  };
}

export type OrderSyncColumns = Pick<
  Selectable<DB['orders']>,
  | 'pay_amount_fen'
  | 'est_commission_fen'
  | 'commission_version'
  | 'settle_commission_fen'
  | 'received_at'
  | 'platform_received_at'
  | 'deposit_paid_at'
  | 'paid_at'
  | 'settled_at'
  | 'platform_modified_at'
  | 'parent_order_id'
  | 'raw_item_id'
  | 'content_hash'
  | 'raw_payload_id'
>;

/**
 * B1-08zi（D10-814）：orders 的件数两列。不并进 OrderSyncColumns（B1-08i 冻结的同步列集合，[AC-B1-08i#14]），
 * 另经 planOrderQuantities 计划，与同步 upsert 同一事务、同一条写入。
 */
export interface OrderQuantityColumns {
  readonly quantity: number | null;
  readonly refunded_quantity: number | null;
}

/** 本次报文的数量小于库内值（不写、保留旧值）时的告警原因。 */
export type OrderQuantityAlert = 'quantity_decreased' | 'refunded_quantity_decreased';

export interface OrderQuantityPlan extends OrderQuantityColumns {
  /** 本次被拒写的变小，按 quantity、refunded_quantity 的顺序；没有为空数组。 */
  readonly alerts: readonly OrderQuantityAlert[];
}

/**
 * B1-08zi（D10-814 ② ③）：两列各自独立：本次报文没给（缺键或 null）→ 沿用库内值；给了且不小于库内值（或库内为空）
 * → 写新值；小于库内值 → 不写、保留库内值并给出告警。只看 quantity / refunded_quantity 两个字段，不看平台、
 * 不用 refund_tag / item_num / return_status 推算；不影响 commission_version（BR-CALC-15 / D10-578）。
 * 首次入库 current 两列都是 null。
 */
export function planOrderQuantities(
  current: OrderQuantityColumns,
  incoming: Pick<UnionOrder, 'quantity' | 'refunded_quantity'>,
): OrderQuantityPlan {
  const quantity = planCount(current.quantity, incoming.quantity);
  const refunded = planCount(current.refunded_quantity, incoming.refunded_quantity);
  const alerts: OrderQuantityAlert[] = [];
  if (quantity.decreased) alerts.push('quantity_decreased');
  if (refunded.decreased) alerts.push('refunded_quantity_decreased');
  return { quantity: quantity.value, refunded_quantity: refunded.value, alerts };
}

/** 一列：没给沿用库内值；给了且不小于库内值（或库内为空）取新值；变小保留库内值并标记。 */
function planCount(
  stored: number | null,
  reported: number | null | undefined,
): { readonly value: number | null; readonly decreased: boolean } {
  if (reported === undefined || reported === null) return { value: stored, decreased: false };
  if (stored !== null && reported < stored) return { value: stored, decreased: true };
  return { value: reported, decreased: false };
}

/**
 * BR-FUND-02：本次报文给出且算数的结算额：只在（迁移后）平台明确已结算时才算；否则 null。
 * 同时决定列与结算记录（BR-FUND-09），两者不会各走一条判定。
 */
export function reportedSettleFen(
  incoming: Pick<UnionOrder, 'settle_commission_fen'>,
  plan: Pick<OrderUpdatePlan, 'platform_status'>,
): bigint | null {
  return plan.platform_status === 'SETTLED' ? (incoming.settle_commission_fen ?? null) : null;
}

/** 本次写库后的预估与结算两列（planOrderSyncColumns 与 commissionNMoved 共用同一取值）。 */
function plannedCommission(
  current: Pick<OrderSyncColumns, 'est_commission_fen' | 'settle_commission_fen'>,
  incoming: UnionOrder,
  plan: OrderUpdatePlan,
  statementFen: bigint | null,
): { readonly est: bigint | null; readonly settle: bigint | null } {
  // BR-FUND-07：预估佣金缺失不覆盖，预估变化总是存档。
  const est = incoming.est_commission_fen ?? current.est_commission_fen;
  // BR-FUND-09：最新 STATEMENT，否则本次算数的结算额（列即最新 API 记录），都没有保留库内值。
  const settle = statementFen ?? reportedSettleFen(incoming, plan) ?? current.settle_commission_fen;
  return { est, settle };
}

/**
 * BR-CALC-15（D10-578）：有效联盟佣金 N（BR-CALC-02，结算优先）在本次写库后与库内值不同；0 与负数都是已知值，
 * 结算后只来新预估不算变。
 */
export function commissionNMoved(
  current: Pick<OrderSyncColumns, 'est_commission_fen' | 'settle_commission_fen'>,
  incoming: UnionOrder,
  plan: OrderUpdatePlan,
  statementFen: bigint | null = null,
): boolean {
  const { est, settle } = plannedCommission(current, incoming, plan, statementFen);
  return (settle ?? est) !== (current.settle_commission_fen ?? current.est_commission_fen);
}

export interface SubsidyVersionInput {
  /** 本次报文的补贴类佣金；undefined = 适配器不输出（沿用库内值，不算变化）。 */
  readonly incomingSubsidyFen: bigint | null | undefined;
  /** 本次报文的平台更新时间。 */
  readonly incomingModifiedAt: Date | null | undefined;
  /** 订单当前记录的平台更新时间（orders.platform_modified_at，planOrderSyncColumns 保证只前进不倒退）。 */
  readonly currentModifiedAt: Date | null;
  /**
   * 当前版本合计行记的补贴（为空时已回退该单分佣快照的补贴，由 commission 给出）；undefined = 没有可比的版本
   * （未生成快照、还没有版本行或端口未注入）。
   */
  readonly recordedSubsidyFen: bigint | undefined;
}

/**
 * B1-18i（BR-CALC-15、BR-CALC-27「仅补贴变化的版本」）：有效 N 不变时，本次报文的补贴与当前版本记录的补贴不同
 * 也让 commission_version +1。空值与 0 相同；报文缺省补贴字段不算变化；报文平台更新时间早于订单当前记录的不因
 * 补贴推版本（相等照常）；同一报文重投时记录的补贴已是新值，自然不推。调用方只在 N 不变时问它。
 */
export function subsidyMovesVersion(input: SubsidyVersionInput): boolean {
  const reported = input.incomingSubsidyFen;
  if (reported === undefined || input.recordedSubsidyFen === undefined) return false;
  const at = input.incomingModifiedAt ?? null;
  if (
    at !== null &&
    input.currentModifiedAt !== null &&
    at.getTime() < input.currentModifiedAt.getTime()
  ) {
    return false;
  }
  return (reported ?? 0n) !== input.recordedSubsidyFen;
}

/** 两个时刻取晚的；一方为空取另一方。 */
function latestTime(a: Date | null, b: Date | null): Date | null {
  if (a === null) return b;
  if (b === null) return a;
  return a.getTime() < b.getTime() ? b : a;
}

/**
 * Returns resolved values of sync-owned data columns; CAS/status/attribution are applied separately.
 * statementFen: the order's latest STATEMENT amount (BR-FUND-09); it wins over the report.
 * subsidyMoved（B1-18i）：subsidyMovesVersion 的判定；N 不变而补贴变了也 +1，N 与补贴同变只 +1 一次。
 * 补贴本身不进返回的列集合（B1-08i 冻结的同步列，[AC-B1-08i#14]）。
 */
export function planOrderSyncColumns(
  current: OrderSyncColumns,
  incoming: UnionOrder,
  plan: OrderUpdatePlan,
  statementFen: bigint | null = null,
  subsidyMoved = false,
): OrderSyncColumns {
  const { est, settle } = plannedCommission(current, incoming, plan, statementFen);
  // BR-CALC-15（D10-578、D10-1258）：有效 N 变了，或 N 不变而补贴与当前版本记录的不同，commission_version+1。
  const commissionMoved =
    (settle ?? est) !== (current.settle_commission_fen ?? current.est_commission_fen) ||
    subsidyMoved;
  // BR-FUND-02：received_at 一旦写入不再覆盖；后到的不同收货时间另存 platform_received_at。
  const incomingReceived = incoming.received_at ?? null;
  const laterReceived =
    current.received_at !== null &&
    incomingReceived !== null &&
    incomingReceived.getTime() !== current.received_at.getTime();
  const itemId = rawItemId(incoming);
  return {
    pay_amount_fen: incoming.paid_fen,
    est_commission_fen: est,
    commission_version: commissionMoved
      ? current.commission_version + 1
      : current.commission_version,
    settle_commission_fen: settle,
    received_at: current.received_at ?? plan.received_at,
    platform_received_at: laterReceived ? incomingReceived : current.platform_received_at,
    // 待编排裁定 5：时间入参为 null 一律不覆盖。
    deposit_paid_at: incoming.deposit_paid_at ?? current.deposit_paid_at,
    paid_at: incoming.paid_at ?? current.paid_at,
    settled_at: incoming.settled_at ?? current.settled_at,
    // B1-18i（Codex money r1 S1）：只前进不倒退。旧报文（早于库内记录）不把它拉回去，否则连续旧报文与交错重投会让
    // 重投的旧报文显得「不早于」库内值，subsidyMovesVersion 误推版本；与开启乱序判定时丢弃旧报文的口径一致。
    platform_modified_at: latestTime(incoming.modified_at ?? null, current.platform_modified_at),
    // 同 B1-08h 取值；商品号全空时保留库内值（首次入库才回退为 ''）。
    parent_order_id: incoming.parent_order_id ?? null,
    raw_item_id: itemId === '' ? current.raw_item_id : itemId,
    content_hash: orderContentHash(incoming),
    raw_payload_id: rawPayloadId(incoming),
  };
}
