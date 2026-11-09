import type { DB } from '@couli/db';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { OrderRebateEvent, OrderRebateState } from '@couli/domain';
import { chinaMonth } from '@couli/domain';
import type {
  ImportedOrder,
  OrderPipelineDeps,
  OrderStatusSource,
  OrderUpdateChange,
  OrderUpdateDeps,
  UnmappedOrderInfo,
} from '../../../orders/index.ts';
import { lockOrderKey } from '../../../orders/index.ts';
import type { AuditPort, Clock, EventBus, RootLogger } from '../../../platform/index.ts';
import {
  commissionChangeOf,
  commissionOutcome,
  hasEstimate,
  isBaseZero,
  isCreditablePlatform,
  isHoldable,
  isLocked,
  isPrecredit,
  jdRemainingZero,
  isReceivedOrSettled,
  isRebateState,
  periodBasisSupported,
  reverseEventOf,
  step,
  unmappedHoldEnabled,
  voidReasonOf,
  type RebateStep,
  type VoidReason,
} from '../domain/rules.ts';
import {
  casUpdateRebate,
  insertRebateHistory,
  readRebateOrder,
  type OrderRow,
  type RebateCasGuards,
  type RebateSet,
} from '../infra/rebate-store.ts';
import { jdRefundR9Enabled } from '../../clawback/clawback-order.ts';
import { casRightsPending, computeRightsPending } from '../../clawback/clawback-store.ts';
import {
  closeAnsweredWaitingRights,
  hasWaitingRights,
  hasWaitingRightsBefore,
  markRightsAnswered,
  readLatestSettlementAt,
  type ManualReasonSub,
} from '../../rights/rights-store.ts';
import { recordSyncRights } from '../../rights/sync-rights.ts';
import { createSettlementRecords } from '../../settlements/index.ts';
import { IllegalTransition, RebateError } from './errors.ts';
import {
  REASON_SUB_UNMAPPED_ALERT,
  reasonSubWithReason,
  type ReasonSubContext,
  type ReasonSubMaps,
} from '../domain/reason-sub.ts';
import { defaultReasonSubMaps } from '../infra/reason-sub-table.ts';

/** B2-04zzg：京东剩余数量为 0 但开关关，只告警。 */
const ALERT_JD_REMAINING_ZERO_OFF = 'jd_remaining_zero_r6_disabled';
/** B1-08zi / D10-864 ②：京东已退件数驱动一切资金处置的开关（content 配置项，默认关）。 */
const JD_REFUND_R9_SWITCH = 'orders.jd.refunded_quantity_r9_enabled';

export interface RebateOrderRef {
  readonly appId: string;
  readonly orderId: string;
  readonly attrAt: Date;
}

/** R6 / R7 commands shared with the later rights writer; no rights persistence here. */
export type PrecreditEvent =
  | 'PLATFORM_INVALID'
  | 'RIGHTS_FULL'
  | 'PUNISH'
  | 'BLACKLIST_HIT'
  | 'PARTIAL_REFUND'
  | 'RIGHTS_PARTIAL';

export interface RebateChangeInput extends RebateOrderRef {
  readonly estBefore: bigint | null;
  readonly estAfter: bigint | null;
  readonly settleCommissionFen: bigint | null;
}

export interface RebateHoldAudit extends RebateOrderRef {
  readonly actor: 'system:risk';
  readonly reason: 'UNMAPPED_STATUS';
  readonly before: { readonly hold: false; readonly holdReason: string | null };
  readonly after: { readonly hold: true; readonly holdReason: 'UNMAPPED_STATUS' };
  readonly at: Date;
}

/**
 * Caller owns the transaction and already holds orders.lockOrderKey(platform, sub_order_id).
 * Re-read by app_id/order_id/attr_at; decide before writing; transitionOrderRebate + CAS
 * (old rebate_status AND row_version), re-read after a zero-row CAS. Never open a transaction.
 * CREDITED updates only log, plus a refresh when the version moved. No ledger calls. Imports arrive with DB default UNATTRIBUTED.
 * R1/R2 history starts at null, not that storage default. R2/R3a may chain R4 or R6.
 */
/**
 * B1-09v (08 BR-TEXT-05 子原因 写入来源 ②): `manual` is a sub-reason chosen by hand that the record
 * behind the event carries (a punish import's reason_sub; value null is 「无」). When the CAS writes
 * reason PUNISH it replaces the automatic mapping and sets orders.reason_sub_manual in the same
 * CAS; under any other reason it is ignored (a PUNISH sub-reason never goes with another parent).
 */
export type ReasonSubWrite = ReasonSubContext & { readonly manual?: ManualReasonSub | undefined };

export type RebatePort = OrderPipelineDeps['rebate'] &
  OrderUpdateDeps['rebate'] & {
    /**
     * B2-04zze: `subContext` (optional) is what the caller knows of the cause, for the reason_sub
     * written with the reason (the rights command passes the record type and violation text, and
     * B1-09v the record's choice made by hand).
     */
    apply(
      trx: Transaction<DB>,
      order: RebateChangeInput,
      event: PrecreditEvent,
      subContext?: ReasonSubWrite,
    ): Promise<void>;
  };

export interface RebateDependencies {
  readonly clock: Clock;
  readonly logger: Pick<RootLogger, 'info' | 'warn' | 'error'>;
  readonly events: Pick<EventBus, 'publish'>;
  readonly config: {
    get(appId: string, key: string): Promise<unknown>;
  };
  /**
   * Commission-owned valuation boundary. bases is read-only, uses frozen snapshot terms
   * and effective commission (settlement wins); null means unknown, never zero.
   * before = the effective base the order's current estimate was last valued on (commission-stored;
   * the port input carries no previous settle amount), after = the effective base of the current columns.
   * refresh writes the rows of the current version in the supplied transaction, without touching
   * balances. orders has already updated commission_version: refresh must not increment it again.
   * value (B2-03r, R7): the commission the new version is valued on instead of the columns; the sync
   * path never gives it, and refresh never reads the open deductions itself (it runs before
   * closeAnsweredRights there, so they would be subtracted twice).
   */
  readonly estimates: {
    bases(
      trx: Transaction<DB>,
      input: RebateChangeInput & { readonly compareN?: true },
    ): Promise<{
      readonly before: bigint | null;
      readonly after: bigint | null;
      /** Answered only when asked with compareN and N is known: N differs from the latest version's. */
      readonly nChanged?: boolean;
    }>;
    refresh(
      trx: Transaction<DB>,
      input: RebateOrderRef,
      value?: { readonly commissionFen: bigint },
    ): Promise<void>;
  };
  /**
   * System-actor audit must commit/roll back with hold. Existing AuditPort accepts admin UUIDs
   * and owns its own transaction, so it cannot silently stand in for this capability.
   * TODO(规划/11 §7.1): provide system audit adapter — blocked on transactional system:risk audit port.
   */
  readonly audit: {
    append(trx: Transaction<DB>, input: RebateHoldAudit): Promise<void>;
  };
  /**
   * B2-04zze: the sub-reason tables (specs/reason-sub-map/); absent → the process' tables, read
   * once when the port is built.
   */
  readonly reasonSubMaps?: ReasonSubMaps;
}

type MutableSet = { -readonly [K in keyof RebateSet]: RebateSet[K] };

/** 一次判定的结果：先在内存里按迁移表走完，再一条 CAS 写库（判定先于写库，BR-FUND-01）。 */
interface Draft {
  state: OrderRebateState | null;
  readonly steps: RebateStep[];
  readonly set: MutableSet;
  readonly guards: { unheld?: boolean; unlocked?: boolean; commissionVersion?: number };
  refresh: boolean;
  refreshValue: EstimateRefreshValue | null;
  invalidated: VoidReason | null;
  audit: RebateHoldAudit | null;
}

type EstimateRefreshValue = NonNullable<Parameters<RebateDependencies['estimates']['refresh']>[2]>;

/**
 * B1-09v: the CAS set plus orders.reason_sub_manual, written only with reason PUNISH and a sub-reason
 * chosen by hand. casUpdateRebate writes every key of the set it is given (`...set`).
 */
type RebateWrite = RebateSet & { readonly reason_sub_manual?: true };

interface Plan {
  readonly steps: readonly RebateStep[];
  /** false：库内值不变（只有 R1 历史，或只重算预估）。 */
  readonly write: boolean;
  readonly set: RebateWrite;
  readonly guards: RebateCasGuards;
  readonly refresh: boolean;
  readonly refreshValue: EstimateRefreshValue | null;
  readonly invalidated: VoidReason | null;
  readonly audit: RebateHoldAudit | null;
}

function draft(state: OrderRebateState | null): Draft {
  return {
    state,
    steps: [],
    set: {},
    guards: {},
    refresh: false,
    refreshValue: null,
    invalidated: null,
    audit: null,
  };
}

/** 按生成的 transition() 走一步；调用方已判定合法，表外即编码错误。 */
function advance(d: Draft, event: OrderRebateEvent): void {
  const next = step(d.state, event);
  if (next === null) throw new IllegalTransition(d.state ?? '—', event);
  d.steps.push(next);
  d.state = next.to;
  const reason = voidReasonOf(event);
  if (next.to === 'VOID' && reason !== null) {
    d.set.reason = reason;
    d.invalidated = reason;
    d.refresh = false;
    d.refreshValue = null;
  }
}

function finish(d: Draft, stored: string): Plan | null {
  const write =
    d.steps.length > 0 &&
    !(d.steps.length === 1 && d.steps[0]?.from === null && d.state === stored);
  if (d.steps.length === 0 && !d.refresh) return null;
  const set: RebateSet = write && d.state !== null ? { ...d.set, rebate_status: d.state } : d.set;
  return {
    steps: d.steps,
    write,
    set,
    guards: d.guards,
    refresh: d.refresh,
    refreshValue: d.refreshValue,
    invalidated: d.invalidated,
    audit: d.audit,
  };
}

function refOf(order: { app_id: string; order_id: string; attr_at: Date }): RebateOrderRef {
  return { appId: order.app_id, orderId: order.order_id, attrAt: order.attr_at };
}

export function createRebatePort(deps: RebateDependencies): RebatePort {
  const { logger } = deps;
  const settlements = createSettlementRecords({ clock: deps.clock });
  const reasonSubMaps = deps.reasonSubMaps ?? defaultReasonSubMaps();

  /**
   * B2-04zze: a plan that writes orders.reason also writes orders.reason_sub in the same CAS
   * (domain/reason-sub.ts); returns the plan to run and the raw text to alert on (unmapped).
   * B1-09v: a choice made by hand under reason PUNISH is written as is, with reason_sub_manual,
   * instead of the automatic mapping (no table lookup, no unmapped alert).
   */
  function withReasonSub(
    row: OrderRow,
    plan: Plan,
    context: ReasonSubWrite,
  ): { readonly plan: Plan; readonly unmapped: { readonly raw: string | null } | null } {
    const reason = plan.set.reason;
    if (!plan.write || reason === undefined) return { plan, unmapped: null };
    const manual = context.manual;
    if (manual !== undefined && reason === 'PUNISH') {
      const set: RebateWrite = { ...plan.set, reason_sub: manual.value, reason_sub_manual: true };
      return { plan: { ...plan, set }, unmapped: null };
    }
    const decision = reasonSubWithReason(row, reason, context, reasonSubMaps);
    if (!decision.write) return { plan, unmapped: null };
    return {
      plan: { ...plan, set: { ...plan.set, reason_sub: decision.value } },
      unmapped: decision.unmapped,
    };
  }

  /**
   * 重读 → 判定 → CAS；CAS 0 行重读一次再判定（02 §18），仍 0 行抛 ORDER_CAS_CONFLICT。
   * 写库成功后同事务写历史、入队 order.invalidated、重算预估、写系统审计；任何一步抛错整事务回滚。
   */
  async function execute(
    trx: Transaction<DB>,
    ref: RebateOrderRef,
    source: 'sync' | 'system',
    decide: (row: OrderRow, now: Date) => Promise<Plan | null>,
    subContext: ReasonSubWrite = {},
  ): Promise<void> {
    const now = deps.clock.now();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const row = await readRebateOrder(trx, ref);
      if (row === undefined) {
        logger.warn({ app_id: ref.appId, outcome: 'order_not_found' }, 'rebate order not found');
        throw new RebateError('ORDER_NOT_FOUND', 'order not found for app_id/order_id/attr_at');
      }
      const decided = await decide(row, now);
      if (decided === null) return;
      const { plan, unmapped } = withReasonSub(row, decided, subContext);
      if (plan.write) {
        const hit = await casUpdateRebate(trx, row, plan.set, plan.guards, now);
        if (!hit) {
          logger.info(
            { app_id: row.app_id, platform: row.platform, outcome: 'cas_retry' },
            'rebate CAS matched no row; re-reading',
          );
          continue;
        }
      }
      await insertRebateHistory(trx, row, plan.steps, source, now);
      if (unmapped !== null) {
        // D10-862 ①: platform and raw text only (no order / rights number, user or amount).
        logger.warn(
          {
            alert: REASON_SUB_UNMAPPED_ALERT,
            platform: row.platform,
            violation_type: unmapped.raw,
            reason_sub: 'PUNISH_ORDER',
          },
          'violation text outside the sub-reason table; fallback sub-reason written',
        );
      }
      if (plan.invalidated !== null) {
        await deps.events.publish(trx, {
          appId: row.app_id,
          name: 'order.invalidated',
          payload: { order_id: row.order_id, platform: row.platform, reason: plan.invalidated },
        });
      }
      if (plan.refresh) {
        if (plan.refreshValue === null) await deps.estimates.refresh(trx, ref);
        else await deps.estimates.refresh(trx, ref, plan.refreshValue);
      }
      if (plan.audit !== null) await deps.audit.append(trx, plan.audit);
      const last = plan.steps.at(-1);
      logger.info(
        {
          app_id: row.app_id,
          platform: row.platform,
          event: last?.event ?? null,
          rebate_status: last?.to ?? row.rebate_status,
          outcome: plan.write ? 'transitioned' : 'recorded',
        },
        'rebate status processed',
      );
      return;
    }
    throw new RebateError('ORDER_CAS_CONFLICT', 'order changed concurrently twice');
  }

  function illegal(row: OrderRow, event: string, detail?: string): IllegalTransition {
    logger.warn(
      {
        app_id: row.app_id,
        platform: row.platform,
        rebate_status: row.rebate_status,
        event,
        alert: 'rebate_illegal_transition',
        outcome: 'rejected',
      },
      'rebate event outside the transition table',
    );
    return new IllegalTransition(row.rebate_status, event, detail);
  }

  function currentState(row: OrderRow, event: string): OrderRebateState {
    if (!isRebateState(row.rebate_status))
      throw illegal(row, event, 'unknown stored rebate_status');
    return row.rebate_status;
  }

  /** R4（BR-FUND-04 ②）：ESTIMATED 且平台已收货 / 结算；守卫不过只不迁移，不抛错。 */
  async function tryReceive(d: Draft, row: OrderRow, now: Date): Promise<void> {
    if (d.state !== 'ESTIMATED' || !isReceivedOrSettled(row.platform_status)) return;
    const base = { app_id: row.app_id, platform: row.platform, rebate_status: d.state };
    if (row.received_at === null) {
      logger.info({ ...base, reason: 'NO_RECEIVED_AT', outcome: 'r4_guard' }, 'waiting held back');
      return;
    }
    if (!isCreditablePlatform(row.platform)) {
      logger.info(
        { ...base, reason: 'NO_CREDITABLE_EVENT', outcome: 'r4_guard' },
        'platform has no registered creditable event',
      );
      return;
    }
    const basis = await deps.config.get(row.app_id, `settle.period_basis.${row.platform}`);
    if (!periodBasisSupported(basis)) {
      logger.error(
        { ...base, reason: 'PERIOD_BASIS_UNSUPPORTED', outcome: 'r4_guard' },
        'unsupported settle.period_basis; order kept ESTIMATED',
      );
      return;
    }
    advance(d, 'PLATFORM_RECEIVED_OR_SETTLED');
    // BR-FUND-04 ②：settle_period 写入后不重算；received_synced_at 取注入的 Clock，已有值不覆写。
    if (row.settle_period === null) d.set.settle_period = chinaMonth(row.received_at);
    if (row.received_synced_at === null) d.set.received_synced_at = now;
  }

  /**
   * B2-04zzg（BR-CALC-15「剩余数量为 0 …入账前 R6 → VOID」；D10-864 ②、D10-878）：京东单 quantity −
   * refunded_quantity ≤ 0 时，同一个开关 orders.jd.refunded_quantity_r9_enabled 管京东已退件数驱动的一切
   * 处置：开 → 返回 true，调用方按整单失效走 R6（事件 PLATFORM_INVALID、orders.reason REFUND、不写分录、
   * 同事务 order.invalidated）；关 → 只写一条 warn（alert jd_remaining_zero_r6_disabled）、返回 false、
   * 状态不变。首次入库（decideImport）与同步更新（decideUpdate）共用。
   */
  async function jdRemainingZeroVoids(
    row: OrderRow,
    base: Record<string, unknown>,
  ): Promise<boolean> {
    if (!jdRemainingZero(row)) return false;
    if (jdRefundR9Enabled(await deps.config.get(row.app_id, JD_REFUND_R9_SWITCH))) return true;
    logger.warn(
      {
        ...base,
        order_id: row.order_id,
        alert: ALERT_JD_REMAINING_ZERO_OFF,
        quantity: row.quantity,
        refunded_quantity: row.refunded_quantity,
        outcome: 'status_kept',
      },
      'jd remaining quantity is zero before credit; R9 switch off, not voided',
    );
    return false;
  }

  async function decideImport(row: OrderRow, now: Date): Promise<Plan | null> {
    const attributed = row.user_id !== null;
    const event = attributed ? 'IMPORT_ATTRIBUTED' : 'IMPORT_UNATTRIBUTED';
    // 入库时库内是存储默认值 UNATTRIBUTED；逻辑上的来源是「—」（R1 / R2 的 from 为 null）。
    if (row.rebate_status !== 'UNATTRIBUTED') throw illegal(row, event, 'order already imported');
    const d = draft(null);
    advance(d, event);
    if (row.platform_status === 'INVALID') {
      // P13：R1 / R2 后同事务按 R6 置 VOID，不生成预估。
      advance(d, 'PLATFORM_INVALID');
    } else if (
      await jdRemainingZeroVoids(row, {
        app_id: row.app_id,
        platform: row.platform,
        rebate_status: d.state,
      })
    ) {
      // B2-04zzg：首次入库的京东报文已退完（剩余数量 ≤ 0）：同 P13，R1 / R2 后同事务 R6 → VOID，不生成预估。
      advance(d, 'PLATFORM_INVALID');
    } else if (attributed) {
      if (hasEstimate(row.platform_status)) d.refresh = true;
      await tryReceive(d, row, now);
    }
    return finish(d, row.rebate_status);
  }

  async function decideUpdate(
    trx: Transaction<DB>,
    row: OrderRow,
    change: OrderUpdateChange,
    source: OrderStatusSource,
    now: Date,
  ): Promise<Plan | null> {
    const state = currentState(row, source.event ?? 'SYNC');
    const base = {
      app_id: row.app_id,
      platform: row.platform,
      rebate_status: state,
      rule: change.rule,
      event: source.event,
    };
    if (state === 'CREDITED') {
      // TODO(规划/11 §4.2): 入账后扣回 / 补差路由 — blocked on B2-04s / B2-04t。
      logger.info({ ...base, outcome: 'credited_noop' }, 'credited order update not routed yet');
      if (change.commission_moved !== true) return null;
      // BR-CALC-23 (a): the rows follow the new N, booked and ledger stay; the clawback and R10 read
      // the current version and run after this.
      const archived = draft(state);
      archived.refresh = true;
      return finish(archived, row.rebate_status);
    }
    if (isLocked(state)) {
      if (change.rule === 'P9') {
        // TODO(规划/11 §4.2): P9 差错单登记 — blocked on B2-04k。
        logger.warn(
          { ...base, alert: 'rebate_void_recovered', outcome: 'status_kept' },
          'invalid order reported active again; rebate status kept',
        );
      } else {
        logger.info({ ...base, outcome: 'locked_noop' }, 'locked order update ignored');
      }
      return null;
    }
    const d = draft(state);
    if (state === 'UNATTRIBUTED' && change.attributed_now) {
      if (row.locked || row.user_id === null) {
        throw illegal(row, 'SYNC_ATTRIBUTED', 'orders.locked=true or user_id empty');
      }
      advance(d, 'SYNC_ATTRIBUTED');
      d.guards.unlocked = true;
      if (hasEstimate(row.platform_status)) d.refresh = true;
    }
    const reverse = reverseEventOf(source.event, row.platform_status);
    if (reverse !== null) {
      advance(d, reverse);
      // BR-CALC-15（B2-03q，同 BASE_ZERO）：无效 / 处罚报文若也让 orders 推了佣金版本，该版本仍要有金额行；
      // advance 到带原因的 VOID 会清掉 refresh，所以补在其后。R6 照样不记账。
      if (change.commission_moved === true) d.refresh = true;
      return finish(d, row.rebate_status);
    }
    // B2-04zzg：京东单本次同步后剩余数量 ≤ 0（两列由 orders 在同一事务写入，这里读锁内重读的行）。
    if (await jdRemainingZeroVoids(row, base)) {
      advance(d, 'PLATFORM_INVALID');
      // BR-CALC-15（同 BASE_ZERO）：同一报文若也让 orders 推了佣金版本，该版本仍要有金额行；R6 照样不记账。
      if (change.commission_moved === true) d.refresh = true;
      return finish(d, row.rebate_status);
    }
    // BR-FUND-03 / 07：有效基数 = 有结算佣金用结算佣金、否则用预估。本次报文后有结算佣金就一律经估值端口
    // 比较前后有效基数（不凭预估是否变化跳过）；只有确认有效基数未变时，预估变化才按规则只存档。
    const commission = commissionChangeOf({
      estBefore: change.est_before,
      estAfter: change.est_after,
      settleCommissionFen: change.settle_commission_fen,
      platformStatus: row.platform_status,
      fromPlatformStatus: change.from_status,
    });
    if (commission !== 'none') {
      const bases = await deps.estimates.bases(trx, {
        appId: change.app_id,
        orderId: change.order_id,
        attrAt: change.attr_at,
        estBefore: change.est_before,
        estAfter: change.est_after,
        settleCommissionFen: change.settle_commission_fen,
      });
      const outcome = commissionOutcome({
        change: commission,
        before: bases.before,
        after: bases.after,
        platformStatus: row.platform_status,
        fromPlatformStatus: change.from_status,
      });
      if (outcome === 'none' && change.est_before !== change.est_after) {
        logger.info(
          { ...base, outcome: 'estimate_archived' },
          'estimate changed while effective settle base unchanged; archived only',
        );
      }
      if (outcome === 'void') {
        advance(d, 'BASE_ZERO');
        // BR-CALC-15: the version moved to the zero / negative N, so its rows must exist for a later
        // ADMIN_RESTORE to read; R6 still books nothing.
        if (change.commission_moved === true) d.refresh = true;
        return finish(d, row.rebate_status);
      }
      if (outcome === 'recalc' && (d.state === 'ESTIMATED' || d.state === 'WAITING')) {
        advance(d, 'COMMISSION_CHANGED');
        d.refresh = true;
      }
    }
    // BR-CALC-15: the column plan moved the version, so it needs rows, even with the same B.
    if (change.commission_moved === true && (d.state === 'ESTIMATED' || d.state === 'WAITING')) {
      d.refresh = true;
    }
    if (
      change.from_status === 'DEPOSIT_PAID' &&
      hasEstimate(row.platform_status) &&
      (d.state === 'ESTIMATED' || d.state === 'WAITING')
    ) {
      // P2 / P14：进入付款时的预估视为首次预估（BR-FUND-03 / 07）。
      d.refresh = true;
    }
    await tryReceive(d, row, now);
    return finish(d, row.rebate_status);
  }

  /**
   * B2-03r: only an estimate can move the version on R7. Any settlement record, in the column or in
   * order_settlements (jd only has the row), keeps it: the bill compares b_settle with the current
   * version's base, and R5 subtracts the open deductions itself.
   */
  async function estimateOnly(trx: Transaction<DB>, row: OrderRow): Promise<boolean> {
    if (row.settle_commission_fen !== null) return false;
    return (await readLatestSettlementAt(trx, row.app_id, row.order_id)) === null;
  }

  async function decideApply(
    trx: Transaction<DB>,
    row: OrderRow,
    input: RebateChangeInput,
    event: PrecreditEvent,
  ): Promise<Plan | null> {
    const state = currentState(row, event);
    if (state === 'CREDITED') {
      // TODO(规划/11 §4.2): R8 / R9 入账后扣回 — blocked on B2-04s / B2-04t。
      logger.warn(
        {
          app_id: row.app_id,
          platform: row.platform,
          rebate_status: state,
          event,
          outcome: 'credited_noop',
        },
        'credited order command not routed yet',
      );
      return null;
    }
    if (step(state, event) === null) throw illegal(row, event);
    const d = draft(state);
    if (voidReasonOf(event) !== null) {
      advance(d, event);
      return finish(d, row.rebate_status);
    }
    const repricing = event === 'RIGHTS_PARTIAL' && (await estimateOnly(trx, row));
    const bases = await deps.estimates.bases(trx, repricing ? { ...input, compareN: true } : input);
    if (
      isPrecredit(state) &&
      isBaseZero({
        before: bases.before,
        after: bases.after,
        platformStatus: row.platform_status,
        fromPlatformStatus: null,
      })
    ) {
      advance(d, 'BASE_ZERO');
      return finish(d, row.rebate_status);
    }
    advance(d, event);
    if (row.platform_status === 'DEPOSIT_PAID') return finish(d, row.rebate_status);
    d.refresh = true;
    // N_new = effective commission − open deductions, floor 0 (rights-command, as credit-order's R5).
    // BR-CALC-15: a new version only when N differs. Unknown N (a pdd order without its fee) writes
    // no rows, so it moves nothing. A base of 0 is known: it moves like any other (R7 原 B 已为 0).
    const nNew = input.settleCommissionFen ?? input.estAfter;
    if (repricing && bases.after !== null && bases.nChanged === true && nNew !== null) {
      d.set.commission_version = row.commission_version + 1;
      d.guards.commissionVersion = row.commission_version;
      d.refreshValue = { commissionFen: nNew };
    }
    return finish(d, row.rebate_status);
  }

  function decideHold(row: OrderRow, ref: RebateOrderRef, now: Date): Plan | null {
    const base = { app_id: row.app_id, platform: row.platform, rebate_status: row.rebate_status };
    if (!isHoldable(row.rebate_status)) {
      // BR-FUND-02：已入账、未归因与终态订单不能 hold，只告警（待处理表由 orders 写）。
      logger.warn(
        {
          ...base,
          reason: 'UNMAPPED_STATUS',
          alert: 'rebate_unmapped_status',
          outcome: 'not_holdable',
        },
        'unmapped platform status on an order that cannot be held',
      );
      return null;
    }
    if (row.hold) {
      logger.info(
        { ...base, reason: 'UNMAPPED_STATUS', outcome: 'already_held' },
        'order already held',
      );
      return null;
    }
    const d = draft(row.rebate_status);
    advance(d, 'HOLD');
    d.set.hold = true;
    d.set.hold_reason = 'UNMAPPED_STATUS';
    d.guards.unheld = true;
    d.audit = {
      ...ref,
      actor: 'system:risk',
      reason: 'UNMAPPED_STATUS',
      before: { hold: false, holdReason: row.hold_reason },
      after: { hold: true, holdReason: 'UNMAPPED_STATUS' },
      at: now,
    };
    return finish(d, row.rebate_status);
  }

  /**
   * B2-04lb (D10-463 ③, D10-483; BR-FUND-06「等联盟回传新佣金后按 R7/R9 处理并关闭」): before credit,
   * the union's updated commission answers the rights records it absorbed, on the sync transaction.
   * With a settlement record only a settlement record received after the row counts (BR-FUND-08 ①),
   * and only the one that decides orders.settle_commission_fen (BR-FUND-09): a newer API record
   * beside a STATEMENT absorbs nothing, the order's amount did not come from it. Without one, a new
   * estimate. The open SUCCEEDED deductions it absorbed get answered_at (never
   * subtracted again); the WAIT_COMMISSION rows it answers close and rights_pending is recomputed.
   * A CREDITED order is left to the clawback's sync hook.
   */
  async function closeAnsweredRights(
    trx: Transaction<DB>,
    change: OrderUpdateChange,
  ): Promise<void> {
    const ref = refOf(change);
    const row = await readRebateOrder(trx, ref);
    if (row === undefined || row.rebate_status === 'CREDITED') return;
    let before: Date | null;
    if (change.settle_commission_fen !== null) {
      before = await settlements.latestDecidingRecordAt(trx, ref);
      if (before === null) return;
    } else {
      if (change.est_after === null || change.est_after === change.est_before) return;
      before = null;
    }
    const now = deps.clock.now();
    const answered = await markRightsAnswered(trx, ref.appId, ref.orderId, before, now);
    const waiting =
      before === null
        ? await hasWaitingRights(trx, ref.appId, ref.orderId)
        : await hasWaitingRightsBefore(trx, ref.appId, ref.orderId, before);
    let closed = 0n;
    if (waiting) {
      closed = await closeAnsweredWaitingRights(trx, ref.appId, ref.orderId, before, now);
      const pending = await computeRightsPending(trx, ref.appId, ref.orderId);
      if (pending !== row.rights_pending) {
        const ok = await casRightsPending(trx, row, pending, now);
        if (!ok) throw new RebateError('ORDER_CAS_CONFLICT', 'rights_pending CAS matched no row');
      }
    }
    if (answered === 0n && closed === 0n) return;
    logger.info(
      {
        app_id: row.app_id,
        platform: row.platform,
        rebate_status: row.rebate_status,
        answered: String(answered),
        closed: String(closed),
        outcome: 'rights_answered',
      },
      'rights answered by the union commission',
    );
  }

  return {
    // B2-04zj: the sync reaches the settlement records through this one port (BR-FUND-09).
    settlements,

    async onImported(trx: Transaction<DB>, order: ImportedOrder): Promise<void> {
      await execute(trx, refOf(order), 'sync', (row, now) => decideImport(row, now));
    },

    async onUpdated(
      trx: Transaction<DB>,
      change: OrderUpdateChange,
      source: OrderStatusSource,
    ): Promise<void> {
      // B2-04zzr (BR-FUND-01 P7 / P8): the order_rights row of this status signal, before R6 here
      // and R8 in the clawback hook that follows (both bump row_version; P7's number is the sync's).
      await recordSyncRights(trx, change, source, deps.clock.now());
      await execute(
        trx,
        refOf(change),
        'sync',
        (row, now) => decideUpdate(trx, row, change, source, now),
        { fromPlatformStatus: change.from_status },
      );
      await closeAnsweredRights(trx, change);
    },

    async onUnmappedStatus(
      trx: Transaction<DB>,
      info: UnmappedOrderInfo,
      source: OrderStatusSource,
    ): Promise<void> {
      void source;
      const enabled = await deps.config.get(info.app_id, 'order_sync.unmapped_status_hold.enabled');
      if (!unmappedHoldEnabled(enabled)) {
        logger.warn(
          {
            app_id: info.app_id,
            reason: 'UNMAPPED_STATUS',
            alert: 'rebate_unmapped_status',
            outcome: 'hold_disabled',
          },
          'unmapped platform status; system hold disabled',
        );
        return;
      }
      const ref = refOf(info);
      // 以库内现态为准，info.rebate_status 只是调用时的提示（可能已过期）。
      await execute(trx, ref, 'system', async (row, now) => decideHold(row, ref, now));
    },

    async apply(
      trx: Transaction<DB>,
      order: RebateChangeInput,
      event: PrecreditEvent,
      subContext?: ReasonSubWrite,
    ): Promise<void> {
      const ref: RebateOrderRef = {
        appId: order.appId,
        orderId: order.orderId,
        attrAt: order.attrAt,
      };
      await execute(
        trx,
        ref,
        'system',
        (row) => decideApply(trx, row, order, event),
        subContext ?? {},
      );
    },
  };
}

/**
 * B2-04zzh（FU-JD-REMAINING-ZERO-SWITCH-ON，D10-923 / D10-930；BR-CALC-15、BR-FUND-07、BR-FUND-01 R6）：
 * 京东未入账单一次性重评（运维 CLI apps/api/scripts/jd-remaining-zero-reevaluate.ts 的服务）的依赖。
 * audit：admin 的审计写者，建在逐单事务上（audit_logs 与作废同事务提交 / 回滚）。
 */
export interface JdRemainingZeroReevaluationDependencies {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly logger: Pick<RootLogger, 'info' | 'warn' | 'error'>;
  readonly events: Pick<EventBus, 'publish'>;
  readonly config: {
    get(appId: string, key: string): Promise<unknown>;
  };
  readonly audit: (trx: Transaction<DB>) => AuditPort;
}

/** 清单中的一张单：只带内部 order_id 与返利状态（不带子订单号、用户与买家参数）。 */
export interface JdRemainingZeroCandidate {
  readonly orderId: string;
  readonly rebateStatus: 'UNATTRIBUTED' | 'ESTIMATED' | 'WAITING';
}

/** candidates：清单张数（处理数）；voided：作废数；skipped：锁内重读后已不满足而跳过的张数。 */
export interface JdRemainingZeroReevaluationSummary {
  readonly candidates: number;
  readonly voided: number;
  readonly skipped: number;
}

export interface JdRemainingZeroReevaluationApplyInput {
  readonly appId: string;
  /** 运维执行人（admin_users.id），写进每条 audit_logs。 */
  readonly actor: string;
}

/**
 * list：该 app 京东、rebate_status ∈ {UNATTRIBUTED, ESTIMATED, WAITING}、两列非空且
 * quantity − refunded_quantity ≤ 0 的单，什么都不写。
 * apply：逐单独立事务、取 orders.lockOrderKey、锁内重读按 B2-04zzg 同一判定 R6 → VOID（PLATFORM_INVALID、
 * orders.reason REFUND、不写分录、同事务 order.invalidated 与一条 audit_logs）；开关关时不改任何单。
 */
export interface JdRemainingZeroReevaluation {
  list(appId: string): Promise<readonly JdRemainingZeroCandidate[]>;
  apply(input: JdRemainingZeroReevaluationApplyInput): Promise<JdRemainingZeroReevaluationSummary>;
}

/** B2-04zzh：入账守卫作废时批次项的跳过原因（settle_batch_items.skip_reason 是 text，契约无枚举）。 */
export const JD_REMAINING_ZERO_SKIP_REASON = 'jd_remaining_zero_void';
/** B2-04zzh：一次性重评作废一张单写的 audit_logs.action（target orders:<order_id>）。 */
export const JD_REMAINING_ZERO_AUDIT_ACTION = 'order_remaining_zero_void';
const REMAINING_ZERO_FROM: readonly OrderRebateState[] = ['UNATTRIBUTED', 'ESTIMATED', 'WAITING'];

/** 入账守卫与一次性重评共用的依赖（不需要估值与审计端口：作废不推佣金版本、不写分录）。 */
export interface JdRemainingZeroVoidDependencies {
  readonly clock: Clock;
  readonly logger: Pick<RootLogger, 'info' | 'warn' | 'error'>;
  readonly events: Pick<EventBus, 'publish'>;
  readonly config: {
    get(appId: string, key: string): Promise<unknown>;
  };
}

type RemainingZeroContext = 'credit' | 'reevaluate';

interface RemainingZeroResult {
  readonly outcome: 'voided' | 'kept' | 'not_applicable';
  readonly from: OrderRebateState | null;
}

/**
 * B2-04zzh（BR-CALC-15「剩余数量为 0 … 入账前 R6 → VOID」、BR-FUND-07、BR-FUND-01 R6；D10-923）：调用方已持有
 * orders.lockOrderKey 并在自己的事务里。锁内重读；UNATTRIBUTED / ESTIMATED / WAITING 的京东单两列都已知且
 * quantity − refunded_quantity ≤ 0 时，与 B2-04zzg 同一判定：开关开 → 经生成的 transition() 走 R6
 * （PLATFORM_INVALID → VOID、orders.reason REFUND、reason_sub 不动）、CAS、history 一行（source system）、同事务
 * order.invalidated，不写分录；开关关 → 不改，入账时写一条 warn（alert jd_remaining_zero_r6_disabled）。
 * 本次没有新报文，orders 没推佣金版本，不刷金额行。
 */
async function voidRemainingZeroLocked(
  deps: JdRemainingZeroVoidDependencies,
  trx: Transaction<DB>,
  ref: RebateOrderRef,
  context: RemainingZeroContext,
): Promise<RemainingZeroResult> {
  const row = await readRebateOrder(trx, ref);
  if (row === undefined || !isRebateState(row.rebate_status)) {
    return { outcome: 'not_applicable', from: null };
  }
  const from = row.rebate_status;
  if (!REMAINING_ZERO_FROM.includes(from) || !jdRemainingZero(row)) {
    return { outcome: 'not_applicable', from };
  }
  const base = {
    app_id: row.app_id,
    order_id: row.order_id,
    platform: row.platform,
    rebate_status: from,
  };
  if (!jdRefundR9Enabled(await deps.config.get(row.app_id, JD_REFUND_R9_SWITCH))) {
    if (context === 'credit') {
      deps.logger.warn(
        {
          ...base,
          alert: ALERT_JD_REMAINING_ZERO_OFF,
          quantity: row.quantity,
          refunded_quantity: row.refunded_quantity,
          outcome: 'credited_anyway',
        },
        'jd remaining quantity is zero at credit; R9 switch off, credited as before',
      );
    }
    return { outcome: 'kept', from };
  }
  const now = deps.clock.now();
  const d = draft(from);
  advance(d, 'PLATFORM_INVALID');
  const plan = finish(d, row.rebate_status);
  if (plan === null || !plan.write) {
    throw new RebateError('ORDER_CAS_CONFLICT', 'remaining-zero void planned no write');
  }
  // 调用方持有订单键锁：同步与入账都在同一把锁下写，CAS 落空只能是并发写漏了锁，整事务回滚。
  if (!(await casUpdateRebate(trx, row, plan.set, plan.guards, now))) {
    throw new RebateError('ORDER_CAS_CONFLICT', 'order changed under the order key lock');
  }
  await insertRebateHistory(trx, row, plan.steps, 'system', now);
  if (plan.invalidated !== null) {
    await deps.events.publish(trx, {
      appId: row.app_id,
      name: 'order.invalidated',
      payload: { order_id: row.order_id, platform: row.platform, reason: plan.invalidated },
    });
  }
  deps.logger.info(
    {
      ...base,
      event: 'PLATFORM_INVALID',
      outcome: context === 'credit' ? 'voided_at_credit' : 'voided_by_reevaluation',
    },
    'jd order with no item left voided before credit',
  );
  return { outcome: 'voided', from };
}

/**
 * B2-04zzh 入账前守卫（credit-order 的可选依赖）：返回 true 表示已按 R6 作废，调用方不入账、批次项记
 * skipped / jd_remaining_zero_void；false 表示照常入账（不适用，或开关关只告警）。
 */
export function createJdRemainingZeroGuard(
  deps: JdRemainingZeroVoidDependencies,
): (trx: Transaction<DB>, ref: RebateOrderRef) => Promise<boolean> {
  return async (trx, ref) =>
    (await voidRemainingZeroLocked(deps, trx, ref, 'credit')).outcome === 'voided';
}

interface CandidateRow {
  readonly order_id: string;
  readonly attr_at: Date;
  readonly sub_order_id: string;
  readonly rebate_status: string;
}

/**
 * apply 有单张失败（该张已整体回滚）时在处理完全部候选后抛出；summary 是已提交的计数，failed 是失败张数。
 * CLI 据此打印计数并以退出码 1 结束；重跑会把失败的单再选进来。
 */
export class JdRemainingZeroReevaluationError extends Error {
  override readonly name = 'JdRemainingZeroReevaluationError';
  readonly summary: JdRemainingZeroReevaluationSummary;
  readonly failed: number;

  constructor(summary: JdRemainingZeroReevaluationSummary, failed: number) {
    super(`${String(failed)} order(s) failed and were rolled back`);
    this.summary = summary;
    this.failed = failed;
  }
}

export function createJdRemainingZeroReevaluation(
  deps: JdRemainingZeroReevaluationDependencies,
): JdRemainingZeroReevaluation {
  const core: JdRemainingZeroVoidDependencies = {
    clock: deps.clock,
    logger: deps.logger,
    events: deps.events,
    config: deps.config,
  };

  async function candidates(appId: string): Promise<CandidateRow[]> {
    const rows = await deps.db
      .withSchema('app')
      .selectFrom('orders')
      .select([
        'order_id',
        'attr_at',
        'sub_order_id',
        'rebate_status',
        'platform',
        'quantity',
        'refunded_quantity',
      ])
      .where('app_id', '=', appId)
      .where('platform', '=', 'jd')
      .where('rebate_status', 'in', [...REMAINING_ZERO_FROM])
      .where('quantity', 'is not', null)
      .where('refunded_quantity', 'is not', null)
      .where(sql<boolean>`quantity - refunded_quantity <= 0`)
      .orderBy('order_id')
      .execute();
    // 与同步、入账同一个纯判定（件数为 0 等边界以它为准）。
    return rows.filter((row) => jdRemainingZero(row));
  }

  return {
    async list(appId) {
      return (await candidates(appId)).map((row) => ({
        orderId: row.order_id,
        rebateStatus: row.rebate_status as JdRemainingZeroCandidate['rebateStatus'],
      }));
    },

    async apply(input) {
      const rows = await candidates(input.appId);
      if (!jdRefundR9Enabled(await deps.config.get(input.appId, JD_REFUND_R9_SWITCH))) {
        deps.logger.warn(
          {
            app_id: input.appId,
            alert: ALERT_JD_REMAINING_ZERO_OFF,
            candidates: rows.length,
            outcome: 'listed_only',
          },
          'jd remaining-zero re-evaluation: R9 switch off, nothing voided',
        );
        return { candidates: rows.length, voided: 0, skipped: 0 };
      }
      let voided = 0;
      let skipped = 0;
      let failed = 0;
      for (const row of rows) {
        // 逐单独立事务：一张失败只回滚它自己，其余照常处理；重跑时已 VOID 的不再入选。
        let done: boolean;
        try {
          done = await deps.db.transaction().execute(async (trx) => {
            await lockOrderKey(trx, 'jd', row.sub_order_id);
            const ref = { appId: input.appId, orderId: row.order_id, attrAt: row.attr_at };
            const result = await voidRemainingZeroLocked(core, trx, ref, 'reevaluate');
            if (result.outcome !== 'voided') return false;
            await deps.audit(trx).append({
              appId: input.appId,
              actor: input.actor,
              action: JD_REMAINING_ZERO_AUDIT_ACTION,
              target: `orders:${row.order_id}`,
              before: { rebate_status: result.from },
              after: { rebate_status: 'VOID', reason: 'REFUND' },
              ip: null,
            });
            return true;
          });
        } catch (error) {
          failed += 1;
          deps.logger.error(
            {
              app_id: input.appId,
              err: error instanceof Error ? error.name : 'unknown',
              outcome: 'reevaluation_order_failed',
            },
            'jd remaining-zero re-evaluation: one order failed and was rolled back',
          );
          continue;
        }
        if (done) voided += 1;
        else skipped += 1;
      }
      if (failed > 0) {
        throw new JdRemainingZeroReevaluationError(
          { candidates: rows.length, voided, skipped },
          failed,
        );
      }
      deps.logger.info(
        {
          app_id: input.appId,
          candidates: rows.length,
          voided,
          skipped,
          outcome: 'reevaluated',
        },
        'jd remaining-zero re-evaluation applied',
      );
      return { candidates: rows.length, voided, skipped };
    },
  };
}
