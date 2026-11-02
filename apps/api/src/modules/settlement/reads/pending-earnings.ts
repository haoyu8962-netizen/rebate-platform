import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import { expectedSettlementCredit } from '@couli/domain';
import { addFen, subFen } from '@couli/money';
import type { Clock } from '../../platform/index.ts';
import { readOpenDeductionTotals } from '../rights/rights-store.ts';
import {
  creditEnabledValue,
  earlierPeriod,
  effectiveCommissionFen,
  integerConfig,
  pendingBaseFen,
  splitPendingShares,
  type PendingShare,
} from './pending-earnings-rules.ts';

export interface PendingSnapshotInput {
  readonly appId: string;
  readonly orderId: string;
  readonly commissionVersion: number;
}

/** B2-04i 返回值的结构化子集；由公开的 readCommissionSnapshot 注入。 */
export interface PendingSnapshot {
  readonly reserveBp: number;
  readonly beneficiaries: readonly {
    readonly userId: string;
    readonly role: 'self' | 'share' | 'direct' | 'indirect';
    readonly ratioBp: number;
    readonly initialStatus: 'active' | 'forfeited';
    readonly forfeitLifted?: true;
  }[];
  readonly forfeitedEvents: readonly {
    readonly userId: string;
    readonly role: 'self' | 'share' | 'direct' | 'indirect';
  }[];
}

/** B2-04w 尚未提供 ledger 类型；合并后由编排对齐此临时端口。金额均为整数分。 */
export interface UserPendingEarnings {
  readonly estimated_total_fen: bigint;
  readonly estimated_fen: bigint;
  readonly pending_credit_fen: bigint;
  readonly pending_credit_paused_fen: bigint;
  readonly next_credit_period: string | null;
  readonly credit_overdue: boolean;
}

export interface AppPendingEarnings {
  readonly total_waiting_fen: bigint;
  readonly total_estimated_fen: bigint;
}

export interface PendingEarningsSource {
  forUser(
    trx: Transaction<DB>,
    input: { readonly appId: string; readonly userId: string },
  ): Promise<UserPendingEarnings>;
  forApp(trx: Transaction<DB>, input: { readonly appId: string }): Promise<AppPendingEarnings>;
}

export interface PendingEarningsDependencies {
  readonly clock: Clock;
  readonly config: { get(appId: string, key: string): Promise<unknown> };
  readonly readSnapshot: (
    trx: Transaction<DB>,
    input: PendingSnapshotInput,
  ) => Promise<PendingSnapshot | null>;
  /**
   * 与快照读取共用调用方事务，返回不可变的 commission_splits.tlj_deduct_fen。
   * TODO(规划/11 §7.1): 由 commission 公开端口接线 — blocked on B2-04i 未暴露淘礼金扣减额。
   * 不允许因端口缺失默认返回零，settlement 不跨模块直读 commission 表。
   */
  readonly readTljDeductFen: (trx: Transaction<DB>, input: PendingSnapshotInput) => Promise<bigint>;
}

interface PendingOrderRow {
  readonly order_id: string;
  readonly platform: string;
  readonly platform_status: string;
  readonly rebate_status: string;
  readonly hold: boolean;
  readonly rights_pending: boolean;
  readonly settle_period: string | null;
  readonly union_settled_at: Date | null;
  readonly est_commission_fen: bigint | null;
  readonly settle_commission_fen: bigint | null;
  readonly commission_version: number;
}

interface PricedOrder {
  readonly row: PendingOrderRow;
  /** 'estimated' = ESTIMATED 且 PAID；'waiting' = WAITING（BR-FUND-18）。 */
  readonly bucket: 'estimated' | 'waiting';
  readonly shares: readonly PendingShare[];
}

// 08 默认值（BR-FUND-04 ③⑪）：账单日 24、宽限 10 天、平台月偏移 1。
const DEFAULT_BILL_DAY = 24;
const DEFAULT_GRACE_DAYS = 10;
const DEFAULT_PERIOD_OFFSET_MONTHS = 1;

/** 只读：本 app 中进入预估类口径的订单（ESTIMATED 且 PAID，或 WAITING），按 order_id 稳定排序。 */
async function selectPendingOrders(
  trx: Transaction<DB>,
  appId: string,
): Promise<PendingOrderRow[]> {
  return trx
    .withSchema('app')
    .selectFrom('orders')
    .select([
      'order_id',
      'platform',
      'platform_status',
      'rebate_status',
      'hold',
      'rights_pending',
      'settle_period',
      'union_settled_at',
      'est_commission_fen',
      'settle_commission_fen',
      'commission_version',
    ])
    .where('app_id', '=', appId)
    .where((eb) =>
      eb.or([
        eb.and([eb('rebate_status', '=', 'ESTIMATED'), eb('platform_status', '=', 'PAID')]),
        eb('rebate_status', '=', 'WAITING'),
      ]),
    )
    .orderBy('order_id')
    .execute();
}

/**
 * B2-03r（BR-FUND-18、D10-474 ①、D10-483）：预估中订单的 N 减未关闭应扣，下限 0，与 R5 入账同一写法；
 * 没有未关闭应扣时原样返回（负数、null 都不动）。CREDITED 不走这里。
 */
export function netOfOpenDeduction(nFen: bigint | null, openFen: bigint): bigint | null {
  if (nFen === null || openFen === 0n) return nFen;
  const reduced = subFen(nFen, openFen);
  return reduced > 0n ? reduced : 0n;
}

/** BR-FUND-18：只读调用方事务，时间取 Clock，日期计算交给 domain。 */
export function createPendingEarningsSource(
  deps: PendingEarningsDependencies,
): PendingEarningsSource {
  /** 单次读取内按 (app, key) 复用配置值；不跨调用缓存，读取总是反映调用方事务的现态。 */
  function configReader(appId: string): (key: string) => Promise<unknown> {
    const cache = new Map<string, Promise<unknown>>();
    return (key) => {
      let value = cache.get(key);
      if (value === undefined) {
        value = deps.config.get(appId, key);
        cache.set(key, value);
      }
      return value;
    };
  }

  /** BR-CALC-02：份额按有效联盟佣金（结算优先）与快照的预留比例、淘礼金扣减、受益比例重算。 */
  async function priceOrders(trx: Transaction<DB>, appId: string): Promise<PricedOrder[]> {
    const rows = await selectPendingOrders(trx, appId);
    const open = await readOpenDeductionTotals(
      trx,
      appId,
      rows.map((row) => row.order_id),
    );
    const priced: PricedOrder[] = [];
    for (const row of rows) {
      const bucket = row.rebate_status === 'WAITING' ? 'waiting' : 'estimated';
      // 尚无分佣快照（版本 0）或佣金未知的订单没有可计的份额，不臆造金额。
      if (row.commission_version < 1) continue;
      const input: PendingSnapshotInput = {
        appId,
        orderId: row.order_id,
        commissionVersion: row.commission_version,
      };
      const snapshot = await deps.readSnapshot(trx, input);
      if (snapshot === null) continue;
      const nFen = netOfOpenDeduction(
        effectiveCommissionFen(row.est_commission_fen, row.settle_commission_fen),
        open.get(row.order_id) ?? 0n,
      );
      const baseFen =
        nFen === null
          ? 0n
          : pendingBaseFen(nFen, snapshot.reserveBp, await deps.readTljDeductFen(trx, input));
      const shares = splitPendingShares(baseFen, snapshot.beneficiaries, snapshot.forfeitedEvents);
      priced.push({ row, bucket, shares });
    }
    return priced;
  }

  return {
    async forUser(trx, input) {
      const { appId, userId } = input;
      const config = configReader(appId);
      const now = deps.clock.now();
      const orders = await priceOrders(trx, appId);
      let estimated = 0n;
      let pending = 0n;
      let paused = 0n;
      let next: string | null = null;
      let overdue = false;
      for (const order of orders) {
        const mine = order.shares.filter((s) => s.userId === userId);
        if (mine.length === 0) continue;
        const amount = mine.reduce((sum, s) => addFen(sum, s.amountFen), 0n);
        if (order.bucket === 'estimated') {
          estimated = addFen(estimated, amount);
          continue;
        }
        const { row } = order;
        pending = addFen(pending, amount);
        if (row.hold || row.rights_pending) {
          paused = addFen(paused, amount);
          continue;
        }
        const platform = row.platform;
        const enabled = creditEnabledValue(await config(`credit.enabled.${platform}`));
        if (!enabled) continue;
        const offsetKey = `settle.period_offset_months.${platform}`;
        const expected = expectedSettlementCredit({
          rebate_status: 'WAITING',
          settle_period: row.settle_period,
          union_settled_at: row.union_settled_at,
          hold: row.hold,
          rights_pending: row.rights_pending,
          credit_enabled: enabled,
          period_offset_months: integerConfig(
            await config(offsetKey),
            offsetKey,
            DEFAULT_PERIOD_OFFSET_MONTHS,
          ),
          bill_day: integerConfig(
            await config('settle.bill_day'),
            'settle.bill_day',
            DEFAULT_BILL_DAY,
          ),
          grace_days: integerConfig(
            await config('settle.statement.grace_days'),
            'settle.statement.grace_days',
            DEFAULT_GRACE_DAYS,
          ),
          now,
        });
        if (expected.credit_overdue) overdue = true;
        else if (expected.expected_credit_period !== null) {
          next = earlierPeriod(next, expected.expected_credit_period);
        }
      }
      return {
        estimated_total_fen: addFen(estimated, pending),
        estimated_fen: estimated,
        pending_credit_fen: pending,
        pending_credit_paused_fen: paused,
        next_credit_period: next,
        credit_overdue: overdue,
      };
    },

    async forApp(trx, input) {
      const orders = await priceOrders(trx, input.appId);
      let waiting = 0n;
      let estimated = 0n;
      for (const order of orders) {
        const amount = order.shares.reduce((sum, s) => addFen(sum, s.amountFen), 0n);
        if (order.bucket === 'waiting') waiting = addFen(waiting, amount);
        else estimated = addFen(estimated, amount);
      }
      return { total_waiting_fen: waiting, total_estimated_fen: estimated };
    },
  };
}
