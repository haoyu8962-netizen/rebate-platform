import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
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
import type { Clock, EventBus, RootLogger } from '../../../platform/index.ts';
import {
  commissionChangeOf,
  commissionOutcome,
  hasEstimate,
  isBaseZero,
  isCreditablePlatform,
  isHoldable,
  isLocked,
  isPrecredit,
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
import { casRightsPending, computeRightsPending } from '../../clawback/clawback-store.ts';
import {
  closeAnsweredWaitingRights,
  hasWaitingRights,
  hasWaitingRightsBefore,
  markRightsAnswered,
  readLatestSettlementAt,
} from '../../rights/rights-store.ts';
import { IllegalTransition, RebateError } from './errors.ts';

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
export type RebatePort = OrderPipelineDeps['rebate'] &
  OrderUpdateDeps['rebate'] & {
    apply(trx: Transaction<DB>, order: RebateChangeInput, event: PrecreditEvent): Promise<void>;
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
   */
  readonly estimates: {
    bases(
      trx: Transaction<DB>,
      input: RebateChangeInput,
    ): Promise<{ readonly before: bigint | null; readonly after: bigint | null }>;
    refresh(trx: Transaction<DB>, input: RebateOrderRef): Promise<void>;
  };
  /**
   * System-actor audit must commit/roll back with hold. Existing AuditPort accepts admin UUIDs
   * and owns its own transaction, so it cannot silently stand in for this capability.
   * TODO(规划/11 §7.1): provide system audit adapter — blocked on transactional system:risk audit port.
   */
  readonly audit: {
    append(trx: Transaction<DB>, input: RebateHoldAudit): Promise<void>;
  };
}

type MutableSet = { -readonly [K in keyof RebateSet]: RebateSet[K] };

/** 一次判定的结果：先在内存里按迁移表走完，再一条 CAS 写库（判定先于写库，BR-FUND-01）。 */
interface Draft {
  state: OrderRebateState | null;
  readonly steps: RebateStep[];
  readonly set: MutableSet;
  readonly guards: { unheld?: boolean; unlocked?: boolean };
  refresh: boolean;
  invalidated: VoidReason | null;
  audit: RebateHoldAudit | null;
}

interface Plan {
  readonly steps: readonly RebateStep[];
  /** false：库内值不变（只有 R1 历史，或只重算预估）。 */
  readonly write: boolean;
  readonly set: RebateSet;
  readonly guards: RebateCasGuards;
  readonly refresh: boolean;
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
    invalidated: d.invalidated,
    audit: d.audit,
  };
}

/**
 * orders moved commission_version with this estimate (BR-FUND-03), past the version 1 the snapshot
 * writes itself: readCommissionSnapshot needs rows of the new version, whatever the outcome.
 */
function versionMoved(row: OrderRow, change: OrderUpdateChange): boolean {
  return change.est_before !== change.est_after && row.commission_version > 1;
}

function refOf(order: { app_id: string; order_id: string; attr_at: Date }): RebateOrderRef {
  return { appId: order.app_id, orderId: order.order_id, attrAt: order.attr_at };
}

export function createRebatePort(deps: RebateDependencies): RebatePort {
  const { logger } = deps;

  /**
   * 重读 → 判定 → CAS；CAS 0 行重读一次再判定（02 §18），仍 0 行抛 ORDER_CAS_CONFLICT。
   * 写库成功后同事务写历史、入队 order.invalidated、重算预估、写系统审计；任何一步抛错整事务回滚。
   */
  async function execute(
    trx: Transaction<DB>,
    ref: RebateOrderRef,
    source: 'sync' | 'system',
    decide: (row: OrderRow, now: Date) => Promise<Plan | null>,
  ): Promise<void> {
    const now = deps.clock.now();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const row = await readRebateOrder(trx, ref);
      if (row === undefined) {
        logger.warn({ app_id: ref.appId, outcome: 'order_not_found' }, 'rebate order not found');
        throw new RebateError('ORDER_NOT_FOUND', 'order not found for app_id/order_id/attr_at');
      }
      const plan = await decide(row, now);
      if (plan === null) return;
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
      if (plan.invalidated !== null) {
        await deps.events.publish(trx, {
          appId: row.app_id,
          name: 'order.invalidated',
          payload: { order_id: row.order_id, platform: row.platform, reason: plan.invalidated },
        });
      }
      if (plan.refresh) await deps.estimates.refresh(trx, ref);
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
      if (!versionMoved(row, change)) return null;
      // BR-FUND-01 R9b: archive only, but the clawback reads the current version; it runs after this.
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
        return finish(d, row.rebate_status);
      }
      if (outcome === 'recalc' && (d.state === 'ESTIMATED' || d.state === 'WAITING')) {
        advance(d, 'COMMISSION_CHANGED');
        d.refresh = true;
      }
    }
    if (versionMoved(row, change) && (d.state === 'ESTIMATED' || d.state === 'WAITING')) {
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
    const bases = await deps.estimates.bases(trx, input);
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
    if (row.platform_status !== 'DEPOSIT_PAID') d.refresh = true;
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
   * With a settlement record only a settlement record received after the row counts (BR-FUND-08 ①);
   * without one, a new estimate. The open SUCCEEDED deductions it absorbed get answered_at (never
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
      before = await readLatestSettlementAt(trx, ref.appId, ref.orderId);
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
    async onImported(trx: Transaction<DB>, order: ImportedOrder): Promise<void> {
      await execute(trx, refOf(order), 'sync', (row, now) => decideImport(row, now));
    },

    async onUpdated(
      trx: Transaction<DB>,
      change: OrderUpdateChange,
      source: OrderStatusSource,
    ): Promise<void> {
      await execute(trx, refOf(change), 'sync', (row, now) =>
        decideUpdate(trx, row, change, source, now),
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
    ): Promise<void> {
      const ref: RebateOrderRef = {
        appId: order.appId,
        orderId: order.orderId,
        attrAt: order.attrAt,
      };
      await execute(trx, ref, 'system', (row) => decideApply(trx, row, order, event));
    },
  };
}
