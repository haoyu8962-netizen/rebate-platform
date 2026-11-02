// B2-13a（BR-FUND-25）收益看板的订单侧事实：自购 / 分享栏的付款笔数与本人预估份额，邀请栏的
// 本人直推 / 间推预估份额。只读调用方事务：SELECT orders（与 pending-earnings 同一做法），分佣快照
// 与淘礼金扣减只经 commission 的公开读端口（由 app.module 注入），不读 commission 的表。
// - 计入笔数的订单（状态事实列举）：已归因（user_id 非空）、platform_status 到过 PAID（不是只付定金
//   DEPOSIT_PAID）、rebate_status ∈ {ESTIMATED, WAITING, CREDITED}；paid_at 落在调用方给的窗口内。
// - 预估：其中 rebate_status ∈ {ESTIMATED, WAITING} 的本人份额，份额算法同 BR-FUND-18（BR-CALC-02
//   有效佣金 → 基数，逐单逐角色向下取整，被剥夺的为 0）；① 只取 role=self，② 只取 role=share，
//   ③ 取 direct + indirect，始终全部平台。
// 不读时钟、不做期间归类（交给调用方）、不写库。
import type { DB } from '@couli/db';
import { addFen } from '@couli/money';
import { sql, type Transaction } from 'kysely';
import { readOpenDeductionTotals } from '../rights/rights-store.ts';
import {
  netOfOpenDeduction,
  type PendingSnapshot,
  type PendingSnapshotInput,
} from './pending-earnings.ts';
import {
  effectiveCommissionFen,
  pendingBaseFen,
  splitPendingShares,
  type PendingRole,
  type PendingShare,
} from './pending-earnings-rules.ts';

/** platform_status 到过 PAID 或之后（DEPOSIT_PAID 只付定金，不计）。 */
const REACHED_PAID = ['PAID', 'RECEIVED', 'SETTLED', 'INVALID'] as const;
/** 计入付款笔数的返利状态。 */
const COUNTED = ['ESTIMATED', 'WAITING', 'CREDITED'] as const;
/** 计入预估的返利状态。 */
const ESTIMATING = ['ESTIMATED', 'WAITING'] as const;
const REFERRAL_ROLES: readonly PendingRole[] = ['direct', 'indirect'];

export interface EarningsOrdersInput {
  readonly appId: string;
  readonly userId: string;
  /** 只筛自购 / 分享；null = 全部平台。邀请栏不受影响。 */
  readonly platform: string | null;
  /** paid_at 窗口 [paidFrom, paidTo)，timestamptz 字面量（如 2026-10-01T00:00:00+08:00）。 */
  readonly paidFrom: string;
  readonly paidTo: string;
  /** false 时不读邀请栏（referral_visible 关闭）。 */
  readonly referral: boolean;
}

/** 本人为归属用户的一笔计入笔数的子订单。 */
export interface EarningsOwnOrder {
  readonly buyType: 'self' | 'share';
  readonly paidAt: Date;
  /** 本人在该栏角色（self / share）上的预估份额；CREDITED 的为 0。 */
  readonly estFen: bigint;
}

/** 本人作为直推 / 间推受益人的一笔预估中的子订单。 */
export interface EarningsReferralOrder {
  readonly paidAt: Date;
  readonly estFen: bigint;
}

export interface EarningsOrders {
  readonly own: readonly EarningsOwnOrder[];
  readonly referral: readonly EarningsReferralOrder[];
}

export interface EarningsOrdersDependencies {
  readonly readSnapshot: (
    trx: Transaction<DB>,
    input: PendingSnapshotInput,
  ) => Promise<PendingSnapshot | null>;
  readonly readTljDeductFen: (trx: Transaction<DB>, input: PendingSnapshotInput) => Promise<bigint>;
}

export interface EarningsOrdersSource {
  read(trx: Transaction<DB>, input: EarningsOrdersInput): Promise<EarningsOrders>;
}

interface PricingRow {
  readonly order_id: string;
  readonly est_commission_fen: bigint | null;
  readonly settle_commission_fen: bigint | null;
  readonly commission_version: number;
}

/** 本人在给定角色上的份额合计（同一人同单同角色只应有一行；多行照加）。 */
export function userShareFen(
  shares: readonly PendingShare[],
  userId: string,
  roles: readonly PendingRole[],
): bigint {
  return shares
    .filter((s) => s.userId === userId && roles.includes(s.role))
    .reduce((sum, s) => addFen(sum, s.amountFen), 0n);
}

function instant(value: string) {
  return sql<Date>`cast(${value} as timestamptz)`;
}

export function createEarningsOrdersSource(deps: EarningsOrdersDependencies): EarningsOrdersSource {
  /**
   * BR-CALC-02 / BR-FUND-18：按有效联盟佣金（B2-03r：减未关闭应扣，与钱包同数）与快照的预留、淘礼金扣减、
   * 受益比例重算本单各份额。
   */
  async function priceShares(
    trx: Transaction<DB>,
    appId: string,
    row: PricingRow,
    openFen: bigint,
  ): Promise<PendingShare[]> {
    // 尚无分佣快照（版本 0）的订单没有可计的份额，不臆造金额。
    if (row.commission_version < 1) return [];
    const input: PendingSnapshotInput = {
      appId,
      orderId: row.order_id,
      commissionVersion: row.commission_version,
    };
    const snapshot = await deps.readSnapshot(trx, input);
    if (snapshot === null) return [];
    const nFen = netOfOpenDeduction(
      effectiveCommissionFen(row.est_commission_fen, row.settle_commission_fen),
      openFen,
    );
    const baseFen =
      nFen === null
        ? 0n
        : pendingBaseFen(nFen, snapshot.reserveBp, await deps.readTljDeductFen(trx, input));
    return splitPendingShares(baseFen, snapshot.beneficiaries, snapshot.forfeitedEvents);
  }

  async function readOwn(
    trx: Transaction<DB>,
    input: EarningsOrdersInput,
  ): Promise<EarningsOwnOrder[]> {
    const rows = await trx
      .withSchema('app')
      .selectFrom('orders')
      .select([
        'order_id',
        'buy_type',
        'paid_at',
        'rebate_status',
        'est_commission_fen',
        'settle_commission_fen',
        'commission_version',
      ])
      .where('app_id', '=', input.appId)
      .where('user_id', '=', input.userId)
      .where('buy_type', 'in', ['self', 'share'])
      .where('platform_status', 'in', [...REACHED_PAID])
      .where('rebate_status', 'in', [...COUNTED])
      .where('paid_at', '>=', instant(input.paidFrom))
      .where('paid_at', '<', instant(input.paidTo))
      .$if(input.platform !== null, (qb) => qb.where('platform', '=', input.platform ?? ''))
      .orderBy('order_id')
      .execute();
    const isEstimating = (row: { readonly rebate_status: string }) =>
      (ESTIMATING as readonly string[]).includes(row.rebate_status);
    const open = await readOpenDeductionTotals(
      trx,
      input.appId,
      rows.filter(isEstimating).map((row) => row.order_id),
    );
    const own: EarningsOwnOrder[] = [];
    for (const row of rows) {
      const buyType = row.buy_type;
      const paidAt = row.paid_at;
      if ((buyType !== 'self' && buyType !== 'share') || paidAt === null) continue;
      const estFen = isEstimating(row)
        ? userShareFen(
            await priceShares(trx, input.appId, row, open.get(row.order_id) ?? 0n),
            input.userId,
            [buyType],
          )
        : 0n;
      own.push({ buyType, paidAt, estFen });
    }
    return own;
  }

  async function readReferral(
    trx: Transaction<DB>,
    input: EarningsOrdersInput,
  ): Promise<EarningsReferralOrder[]> {
    // TODO(规划/11 §2.3): 按受益人（direct / indirect）先取订单号再定价，避免逐单读全 app 两个月的
    // 预估中订单 — blocked on commission 尚无覆盖 indirect 的受益人订单读端口。
    const rows = await trx
      .withSchema('app')
      .selectFrom('orders')
      .select([
        'order_id',
        'paid_at',
        'est_commission_fen',
        'settle_commission_fen',
        'commission_version',
      ])
      .where('app_id', '=', input.appId)
      .where('user_id', 'is not', null)
      .where('platform_status', 'in', [...REACHED_PAID])
      .where('rebate_status', 'in', [...ESTIMATING])
      .where('paid_at', '>=', instant(input.paidFrom))
      .where('paid_at', '<', instant(input.paidTo))
      .orderBy('order_id')
      .execute();
    const open = await readOpenDeductionTotals(
      trx,
      input.appId,
      rows.map((row) => row.order_id),
    );
    const referral: EarningsReferralOrder[] = [];
    for (const row of rows) {
      if (row.paid_at === null) continue;
      const shares = await priceShares(trx, input.appId, row, open.get(row.order_id) ?? 0n);
      if (!shares.some((s) => s.userId === input.userId && REFERRAL_ROLES.includes(s.role))) {
        continue;
      }
      referral.push({
        paidAt: row.paid_at,
        estFen: userShareFen(shares, input.userId, REFERRAL_ROLES),
      });
    }
    return referral;
  }

  return {
    async read(trx, input) {
      const own = await readOwn(trx, input);
      const referral = input.referral ? await readReferral(trx, input) : [];
      return { own, referral };
    },
  };
}
