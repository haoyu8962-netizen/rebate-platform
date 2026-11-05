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
 * BR-FUND-02：本次报文给出且算数的结算额：只在（迁移后）平台明确已结算时才算；否则 null。
 * 同时决定列与结算记录（BR-FUND-09），两者不会各走一条判定。
 */
export function reportedSettleFen(
  incoming: Pick<UnionOrder, 'settle_commission_fen'>,
  plan: Pick<OrderUpdatePlan, 'platform_status'>,
): bigint | null {
  return plan.platform_status === 'SETTLED' ? (incoming.settle_commission_fen ?? null) : null;
}

/**
 * Returns resolved values of sync-owned data columns; CAS/status/attribution are applied separately.
 * statementFen: the order's latest STATEMENT amount (BR-FUND-09); it wins over the report.
 */
export function planOrderSyncColumns(
  current: OrderSyncColumns,
  incoming: UnionOrder,
  plan: OrderUpdatePlan,
  statementFen: bigint | null = null,
): OrderSyncColumns {
  // BR-FUND-07：预估佣金缺失不覆盖，预估变化总是存档。
  const est = incoming.est_commission_fen ?? current.est_commission_fen;
  // BR-FUND-09：最新 STATEMENT，否则本次算数的结算额（列即最新 API 记录），都没有保留库内值。
  const settle = statementFen ?? reportedSettleFen(incoming, plan) ?? current.settle_commission_fen;
  // BR-CALC-15（D10-578）：有效联盟佣金（BR-CALC-02，结算优先）变了才 commission_version+1，
  // 0 与负数都是已知值；结算后只来新预估不算变。
  const commissionMoved =
    (settle ?? est) !== (current.settle_commission_fen ?? current.est_commission_fen);
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
    platform_modified_at: incoming.modified_at ?? current.platform_modified_at,
    // 同 B1-08h 取值；商品号全空时保留库内值（首次入库才回退为 ''）。
    parent_order_id: incoming.parent_order_id ?? null,
    raw_item_id: itemId === '' ? current.raw_item_id : itemId,
    content_hash: orderContentHash(incoming),
    raw_payload_id: rawPayloadId(incoming),
  };
}
