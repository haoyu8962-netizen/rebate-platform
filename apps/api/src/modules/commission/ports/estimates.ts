// B2-03q (D10-540, D10-565, D10-568): commission's estimate port for settlement's rebate
// (RebateDependencies['estimates'], signatures unchanged). bases is read-only; refresh appends the
// amount and totals rows of orders' current commission_version on the caller's transaction.
// Commission does not read the orders table: the columns come through deps.readOrder, the owner's
// read on the same transaction.
// B1-18f (BR-CALC-27 存储, BR-CALC-15; D10-1258): a new version's totals carry the order's subsidy
// when it is written (orders.subsidy_commission_fen through readOrder, null as 0), and the stored N is
// n_total_fen minus the subsidy of that version's totals row (null: the frozen subsidy).
// B1-18i (BR-CALC-15, BR-CALC-27「仅补贴变化的版本」; D10-1258): recordedSubsidy answers the subsidy the
// latest version was written with (null: the frozen one), for orders' version decision; refreshSubsidy
// writes a version that only the subsidy moved: every amount row and B copied from the latest
// version, the totals' n_total / pre_base_deduct / platform_est_profit recomputed on its stored N and
// the order's current subsidy.
import type { DB } from '@couli/db';
import { addFen, subFen } from '@couli/money';
import type { Transaction } from 'kysely';
import {
  frozenBase,
  planVersion,
  storedN,
  type FrozenTerms,
  type PlannedTotals,
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
  /** The order's current subsidy class commission (BR-CALC-18); null counts as 0. */
  readonly subsidy_commission_fen: bigint | null;
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
  /**
   * B1-18i: the subsidy the latest version's totals row records (a row written before 0138 has none:
   * the snapshot's frozen subsidy). undefined: no snapshot, or no version written yet.
   */
  recordedSubsidy(trx: Transaction<DB>, input: EstimateOrderRef): Promise<bigint | undefined>;
  /**
   * B1-18i: writes orders' current commission_version as a subsidy-only version (see
   * subsidyOnlyTotals); once, like refresh. Nothing without a snapshot or a stored version.
   */
  refreshSubsidy(trx: Transaction<DB>, input: EstimateOrderRef): Promise<void>;
}

/**
 * B1-18i (BR-CALC-27「仅补贴变化的版本」): the totals of a version only the subsidy moved. B, the user
 * shares and the redpacket stay the latest version's; ① = its stored N + the new subsidy (null as
 * 0), ② = ① − B, ④ = ① − Σ shares − redpacket (unknown redpacket: unknown ④, as planVersion).
 */
export function subsidyOnlyTotals(
  latest: Pick<TotalsRow, 'base_fen' | 'user_share_total_fen' | 'tlj_redpacket_fen'>,
  n: bigint,
  subsidyFen: bigint | null,
): PlannedTotals {
  const subsidy = subsidyFen ?? 0n;
  const nTotal = addFen(n, subsidy);
  const redpacket = latest.tlj_redpacket_fen;
  return {
    n_total_fen: nTotal,
    pre_base_deduct_fen: subFen(nTotal, latest.base_fen),
    base_fen: latest.base_fen,
    user_share_total_fen: latest.user_share_total_fen,
    tlj_redpacket_fen: redpacket,
    platform_est_profit_fen:
      redpacket === null ? null : subFen(subFen(nTotal, latest.user_share_total_fen), redpacket),
    subsidy_commission_fen: subsidy,
  };
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

  /** The latest version as it stands: a credited order moved on with no known N (B2-03q). */
  async function copyLatest(
    trx: Transaction<DB>,
    ref: EstimateOrderRef,
    version: number,
    split: SplitRow,
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
          // The copied n_total_fen keeps the subsidy it was valued on; a pre-0138 row's is the frozen one.
          subsidy_commission_fen: latest.subsidy_commission_fen ?? split.subsidy_commission_fen,
        },
      },
    );
  }

  /** A new N over the frozen terms (BR-CALC-02, BR-CALC-27); a credited order's too (BR-CALC-23 (a)). */
  async function revalue(
    trx: Transaction<DB>,
    ref: EstimateOrderRef,
    version: number,
    n: bigint,
    subsidyFen: bigint | null,
    split: SplitRow,
    latest: TotalsRow,
  ): Promise<void> {
    const terms = frozenTerms(split);
    const shares = await readShareStates(trx, ref.appId, ref.orderId, terms.beneficiaries);
    const plan = planVersion(
      terms,
      n,
      subsidyFen,
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
        version,
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
      return { ...bases, nChanged: n !== storedN(terms, latest) };
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
      const n =
        value === undefined
          ? (order.settle_commission_fen ?? order.est_commission_fen)
          : value.commissionFen;
      if (n !== null) {
        await revalue(trx, input, version, n, order.subsidy_commission_fen, split, latest);
        return;
      }
      // Unknown N: a credited order still needs this version's rows (the clawback reads them); before
      // credit nothing is written, like a pending snapshot.
      if (order.rebate_status === 'CREDITED') await copyLatest(trx, input, version, split, latest);
    },

    async recordedSubsidy(trx, input) {
      const split = await findSplit(trx, input.appId, input.orderId);
      if (split === undefined) return undefined;
      const latest = await selectLatestTotals(trx, input.appId, input.orderId);
      if (latest === undefined) return undefined;
      return latest.subsidy_commission_fen ?? split.subsidy_commission_fen;
    },

    async refreshSubsidy(trx, input) {
      const order = await orderOf(trx, input);
      const version = order.commission_version;
      if (version < 1) return;
      const split = await findSplit(trx, input.appId, input.orderId);
      if (split === undefined) return;
      const latest = await selectLatestTotals(trx, input.appId, input.orderId);
      if (latest === undefined) throw new Error('commission: snapshot has no amount version');
      // At-least-once delivery: this version is written once, by whichever call came first.
      if (latest.commission_version >= version) return;
      // The shares and B of the latest version as they stand (it may be an R7 repricing), not a
      // fresh split of the order's commission.
      const amounts = await selectVersionAmounts(
        trx,
        input.appId,
        input.orderId,
        latest.commission_version,
      );
      const n = storedN(frozenTerms(split), latest);
      await insertVersion(
        trx,
        { appId: input.appId, orderId: input.orderId, version, createdAt: deps.clock.now() },
        { amounts, totals: subsidyOnlyTotals(latest, n, order.subsidy_commission_fen) },
      );
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
