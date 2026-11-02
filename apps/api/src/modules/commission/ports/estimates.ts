// B2-03q (D10-540, D10-565, D10-568): commission's estimate port for settlement's rebate
// (RebateDependencies['estimates'], signatures unchanged). bases is read-only; refresh appends the
// amount and totals rows of orders' current commission_version on the caller's transaction.
// Commission does not read the orders table: the columns come through deps.readOrder, the owner's
// read on the same transaction.
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import {
  frozenBase,
  planVersion,
  storedN,
  type FrozenTerms,
} from '../application/estimate-plan.ts';
import { readShareStates } from '../application/forfeited-state-read.ts';
import {
  createCommissionSnapshot,
  type CommissionSnapshotDependencies,
  type CreateCommissionSnapshotInput,
  type CreateCommissionSnapshotResult,
} from '../application/snapshot.ts';
import { parseSnapshotBeneficiaries } from '../domain/snapshot-read.ts';
import {
  insertVersion,
  selectLatestTotals,
  selectVersionAmounts,
  type TotalsRow,
} from '../infra/estimate-store.ts';
import { findSplit, type SplitRow } from '../infra/snapshot-store.ts';
import type { Clock } from '../../platform/index.ts';

export interface EstimateOrderRef {
  readonly appId: string;
  readonly orderId: string;
  readonly attrAt: Date;
}

export interface EstimateChangeInput extends EstimateOrderRef {
  readonly estBefore: bigint | null;
  readonly estAfter: bigint | null;
  readonly settleCommissionFen: bigint | null;
  /** B2-03r (BR-CALC-15): also answer nChanged; the stored N is commission's, settlement cannot read it. */
  readonly compareN?: true;
}

/** null means unknown, never zero. */
export interface EstimateBases {
  readonly before: bigint | null;
  readonly after: bigint | null;
  /** Only with compareN and a known N: this N (net of the fee) differs from the latest version's. */
  readonly nChanged?: boolean;
}

/** The columns bases and refresh need, as the orders row carries them. */
export interface EstimateOrder {
  readonly platform: string;
  readonly commission_version: number;
  readonly rebate_status: string;
  readonly est_commission_fen: bigint | null;
  readonly settle_commission_fen: bigint | null;
}

export interface CommissionEstimatesDependencies {
  /**
   * Not read since B1-08zh: est is already net of the fee. Kept optional so the frozen kit of
   * test/spec/commission/estimate-port compiles unchanged (FU-ESTIMATES-FEE-DEP-CLEANUP).
   */
  serviceFeeDeducted?(platform: string): boolean;
  readonly clock: Clock;
  /** The order row re-read on the caller's transaction, which holds the order lock. */
  readOrder(trx: Transaction<DB>, ref: EstimateOrderRef): Promise<EstimateOrder | undefined>;
}

/** B2-03r: the commission a new version is valued on when it is not the orders columns' (R7). */
export interface EstimateRefreshValue {
  readonly commissionFen: bigint;
}

export interface CommissionEstimates {
  bases(trx: Transaction<DB>, input: EstimateChangeInput): Promise<EstimateBases>;
  refresh(
    trx: Transaction<DB>,
    input: EstimateOrderRef,
    value?: EstimateRefreshValue,
  ): Promise<void>;
}

function frozenTerms(split: SplitRow): FrozenTerms {
  if (split.order_type !== 'self' && split.order_type !== 'share') {
    throw new TypeError('commission: stored snapshot order_type is not self/share');
  }
  return {
    orderType: split.order_type,
    reserveBp: split.reserve_bp,
    tljDeductFen: split.tlj_deduct_fen,
    subsidyCommissionFen: split.subsidy_commission_fen,
    beneficiaries: parseSnapshotBeneficiaries(split.beneficiaries),
  };
}

/** The effective commission net of the fee: settlement wins, 0 and negatives are known values. */
export function createCommissionEstimates(
  deps: CommissionEstimatesDependencies,
): CommissionEstimates {
  async function orderOf(trx: Transaction<DB>, ref: EstimateOrderRef): Promise<EstimateOrder> {
    const order = await deps.readOrder(trx, ref);
    if (order === undefined) throw new Error('commission: snapshot order row is not readable');
    return order;
  }

  /** BR-FUND-01 R9b: the latest version as it stands, whatever the commission columns say now. */
  async function copyLatest(
    trx: Transaction<DB>,
    ref: EstimateOrderRef,
    version: number,
    latest: TotalsRow,
  ): Promise<void> {
    const amounts = await selectVersionAmounts(
      trx,
      ref.appId,
      ref.orderId,
      latest.commission_version,
    );
    await insertVersion(
      trx,
      { appId: ref.appId, orderId: ref.orderId, version, createdAt: deps.clock.now() },
      {
        amounts,
        totals: {
          n_total_fen: latest.n_total_fen,
          pre_base_deduct_fen: latest.pre_base_deduct_fen,
          base_fen: latest.base_fen,
          user_share_total_fen: latest.user_share_total_fen,
          tlj_redpacket_fen: latest.tlj_redpacket_fen,
          platform_est_profit_fen: latest.platform_est_profit_fen,
        },
      },
    );
  }

  /** A new N over the frozen terms; an unknown N writes nothing, like a pending snapshot. */
  async function revalue(
    trx: Transaction<DB>,
    ref: EstimateOrderRef,
    order: EstimateOrder,
    split: SplitRow,
    latest: TotalsRow,
    value: EstimateRefreshValue | undefined,
  ): Promise<void> {
    const n =
      value === undefined
        ? (order.settle_commission_fen ?? order.est_commission_fen)
        : value.commissionFen;
    if (n === null) return;
    const terms = frozenTerms(split);
    const shares = await readShareStates(trx, ref.appId, ref.orderId, terms.beneficiaries);
    const plan = planVersion(
      terms,
      n,
      latest.tlj_redpacket_fen,
      (b) =>
        shares.forfeitedEvents.some((e) => e.userId === b.userId && e.role === b.role) ||
        shares.beneficiaries.some(
          (s) =>
            s.userId === b.userId &&
            s.role === b.role &&
            s.initialStatus === 'forfeited' &&
            s.forfeitLifted !== true,
        ),
    );
    await insertVersion(
      trx,
      {
        appId: ref.appId,
        orderId: ref.orderId,
        version: order.commission_version,
        createdAt: deps.clock.now(),
      },
      plan,
    );
  }

  return {
    async bases(trx, input) {
      const split = await findSplit(trx, input.appId, input.orderId);
      if (split === undefined) return { before: null, after: null };
      const latest = await selectLatestTotals(trx, input.appId, input.orderId);
      await orderOf(trx, input);
      const n = input.settleCommissionFen ?? input.estAfter;
      const terms = frozenTerms(split);
      const bases = {
        before: latest?.base_fen ?? null,
        after: n === null ? null : frozenBase(terms, n),
      };
      if (input.compareN !== true || n === null || latest === undefined) return bases;
      return { ...bases, nChanged: n !== storedN(terms, latest.n_total_fen) };
    },

    async refresh(trx, input, value) {
      const order = await orderOf(trx, input);
      const version = order.commission_version;
      if (version < 1) return;
      const split = await findSplit(trx, input.appId, input.orderId);
      if (split === undefined) return;
      const latest = await selectLatestTotals(trx, input.appId, input.orderId);
      if (latest === undefined) throw new Error('commission: snapshot has no amount version');
      // At-least-once delivery: this version is written once, by whichever call came first.
      if (latest.commission_version >= version) return;
      // CREDITED first: a copy needs neither the fee nor any commission column.
      if (order.rebate_status === 'CREDITED') {
        await copyLatest(trx, input, version, latest);
        return;
      }
      await revalue(trx, input, order, split, latest, value);
    },
  };
}

export type CommissionSnapshotPortDependencies = CommissionEstimatesDependencies &
  Pick<CommissionSnapshotDependencies, 'logger' | 'beneficiaries'>;

/**
 * D10-568: what orders' runCommissionSnapshot takes. create is createCommissionSnapshot; refresh is
 * the estimates port's refresh, for a created snapshot of an order already past version 1.
 */
export interface CommissionOrderSnapshotPort {
  create(
    trx: Transaction<DB>,
    input: CreateCommissionSnapshotInput,
  ): Promise<CreateCommissionSnapshotResult>;
  refresh(trx: Transaction<DB>, input: EstimateOrderRef): Promise<void>;
}

export function createCommissionSnapshotPort(
  deps: CommissionSnapshotPortDependencies,
): CommissionOrderSnapshotPort {
  const { clock, logger, beneficiaries } = deps;
  const estimates = createCommissionEstimates(deps);
  return {
    create: (trx, input) => createCommissionSnapshot(trx, input, { clock, logger, beneficiaries }),
    refresh: (trx, input) => estimates.refresh(trx, input),
  };
}
