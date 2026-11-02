// B1-09p (D10-551 item 9, D10-558): the per-order figures behind orders' OrderFiguresReader, one
// viewer at a time. Read only: the orders, open deductions, snapshots, ledger and beneficiary_credits
// of one call are read on one read-only REPEATABLE READ transaction, so an amount never mixes a
// commission column and an open deduction from either side of a union sync (B2-03r); configuration
// and appeals come in over their own handles, so they run after it and the transaction never waits
// for a second connection. Amounts reuse
// pending-earnings-rules, so they are the wallet's; forUser is not used (it has no per-order output).
// Every order read is in the result. actual_fen is the BR-TEXT-02 formula as written (D10-558 ①).
import type { DB } from '@couli/db';
import { expectedSettlementCredit, orderKey } from '@couli/domain';
import { addFen, subFen } from '@couli/money';
import type { Kysely, Transaction } from 'kysely';
import type { Clock } from '../../platform/index.ts';
import { readOpenDeductionTotals } from '../rights/rights-store.ts';
import {
  creditEnabledValue,
  effectiveCommissionFen,
  integerConfig,
  pendingBaseFen,
  splitPendingShares,
} from './pending-earnings-rules.ts';
import {
  netOfOpenDeduction,
  type PendingEarningsDependencies,
  type PendingSnapshotInput,
} from './pending-earnings.ts';

export interface OrderFiguresSubject {
  readonly app_id: string;
  readonly user_id: string;
}

/** Same fields as orders' OrderFigures; settlement does not import orders. */
export interface OrderFiguresValue {
  readonly b_est: bigint | null;
  readonly est_rebate_fen: bigint | null;
  readonly actual_fen: bigint | null;
  readonly clawback_fen: bigint | null;
  readonly has_clawback: boolean;
  readonly part_clawed_at: string | null;
  readonly viewer_share_held: boolean;
  readonly expected_credit_period: string | null;
  readonly credit_overdue: boolean;
  readonly appeal_pending: boolean;
}

export interface OrderFiguresSource {
  forOrders(
    subject: OrderFiguresSubject,
    orderIds: readonly string[],
  ): Promise<ReadonlyMap<string, OrderFiguresValue>>;
}

/** One order on the viewer's own account; amounts as the user sees them, in whole fen. */
export interface OrderFiguresLedgerEntry {
  readonly credited_fen: bigint;
  /** Σ SETTLE_ADJUST, signed from the user's side: a positive adjustment adds to the balance. */
  readonly settle_adjust_fen: bigint;
  /** Σ |CLAWBACK|. */
  readonly clawback_fen: bigint;
  /** booked_at of the latest CLAWBACK (D10-558 ②), null without one. */
  readonly last_clawback_at: Date | null;
}

export interface OrderFiguresLedgerSelection {
  readonly appId: string;
  readonly userId: string;
  readonly orderKeys: readonly string[];
}

/** ledger's read port; orders without an entry on the account are left out of the map. */
export type OrderFiguresLedgerRead = (
  db: Kysely<DB>,
  selection: OrderFiguresLedgerSelection,
) => Promise<ReadonlyMap<string, OrderFiguresLedgerEntry>>;

/** risk's read port. */
export interface OrderFiguresAppealRead {
  /** The given orders of the app with a processing order appeal of the user. */
  pendingOrderIds(
    appId: string,
    userId: string,
    orderIds: readonly string[],
  ): Promise<ReadonlySet<string>>;
}

export interface OrderFiguresDependencies {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly config: PendingEarningsDependencies['config'];
  readonly readSnapshot: PendingEarningsDependencies['readSnapshot'];
  readonly readTljDeductFen: PendingEarningsDependencies['readTljDeductFen'];
  readonly ledger: OrderFiguresLedgerRead;
  readonly appeals: OrderFiguresAppealRead;
}

export type OrderFiguresPricingPorts = Pick<
  OrderFiguresDependencies,
  'readSnapshot' | 'readTljDeductFen'
>;

/** The orders columns the figures need. */
export interface OrderFiguresRow {
  readonly order_id: string;
  readonly platform: string;
  readonly sub_order_id: string;
  readonly buy_type: string | null;
  readonly rebate_status: string;
  readonly platform_status: string;
  readonly hold: boolean;
  readonly rights_pending: boolean;
  readonly booked_base_fen: bigint | null;
  readonly settle_period: string | null;
  readonly union_settled_at: Date | null;
  readonly est_commission_fen: bigint | null;
  readonly settle_commission_fen: bigint | null;
  readonly commission_version: number;
}

/** B_est and the viewer's share of it; share null when the viewer's role is unknown. */
export interface OrderFiguresPricing {
  readonly baseFen: bigint;
  readonly viewerShareFen: bigint | null;
}

/** The platform's BR-FUND-04 ⑪ configuration. */
export interface OrderCreditTerms {
  readonly credit_enabled: boolean;
  readonly period_offset_months: number;
  readonly bill_day: number;
  readonly grace_days: number;
}

export interface OrderFiguresFacts {
  readonly row: OrderFiguresRow;
  readonly held: boolean;
  /** null: nothing to show, or B_est unknown (no snapshot, no commission). */
  readonly pricing: OrderFiguresPricing | null;
  readonly entry: OrderFiguresLedgerEntry | undefined;
  readonly appealed: boolean;
  readonly terms: OrderCreditTerms;
  readonly now: Date;
}

type RebateStatus = Parameters<typeof expectedSettlementCredit>[0]['rebate_status'];

// BR-FUND-04 ③⑪ defaults, the same three as the wallet's (pending-earnings.ts).
const DEFAULT_BILL_DAY = 24;
const DEFAULT_GRACE_DAYS = 10;
const DEFAULT_PERIOD_OFFSET_MONTHS = 1;
const HELD_KINDS = ['first_credit', 'reassign_credit'];

/** BR-FUND-17 row 3 comes first: a credited order with booked base 0 shows no amount at all. */
function creditedShown(row: OrderFiguresRow, held: boolean): boolean {
  return row.rebate_status === 'CREDITED' && row.booked_base_fen !== 0n && !held;
}

/** BR-TEXT-02 预估金额行: PAID, WAITING and their paused forms, and REVIEWING on a held credit. */
export function needsPricing(row: OrderFiguresRow, held: boolean): boolean {
  if (row.rebate_status === 'WAITING') return true;
  if (row.rebate_status === 'ESTIMATED') return row.platform_status !== 'DEPOSIT_PAID';
  return row.rebate_status === 'CREDITED' && held && row.booked_base_fen !== 0n;
}

/** One order's figures from what was read; pure. */
export function orderFiguresOf(facts: OrderFiguresFacts): OrderFiguresValue {
  const { row, held, pricing, terms, now } = facts;
  const entry = facts.entry;
  const credited = creditedShown(row, held);
  const clawbackShown = credited || row.rebate_status === 'CLAWED_BACK';
  const clawbackFen = entry?.clawback_fen ?? 0n;
  const lastClawbackAt = entry?.last_clawback_at ?? null;
  const expected = expectedSettlementCredit({
    rebate_status: row.rebate_status as RebateStatus,
    settle_period: row.settle_period,
    union_settled_at: row.union_settled_at,
    hold: row.hold,
    rights_pending: row.rights_pending,
    now,
    ...terms,
  });
  return {
    b_est: pricing?.baseFen ?? null,
    // B_est = 0 is NO_REBATE, which shows no amount; a forfeited share is 0, not null (D10-558 ④).
    est_rebate_fen: pricing === null || pricing.baseFen === 0n ? null : pricing.viewerShareFen,
    actual_fen: credited
      ? subFen(addFen(entry?.credited_fen ?? 0n, entry?.settle_adjust_fen ?? 0n), clawbackFen)
      : null,
    clawback_fen: clawbackShown ? clawbackFen : null,
    has_clawback: clawbackShown && clawbackFen > 0n,
    part_clawed_at: clawbackShown && lastClawbackAt !== null ? lastClawbackAt.toISOString() : null,
    viewer_share_held: held,
    expected_credit_period: expected.expected_credit_period,
    credit_overdue: expected.credit_overdue,
    appeal_pending: facts.appealed,
  };
}

/** Runs on the caller's transaction, or on its own read-only REPEATABLE READ one. */
function onReadTransaction<T>(
  db: Kysely<DB>,
  run: (trx: Transaction<DB>) => Promise<T>,
): Promise<T> {
  if (db.isTransaction) return run(db as Transaction<DB>);
  return db
    .transaction()
    .setIsolationLevel('repeatable read')
    .setAccessMode('read only')
    .execute(run);
}

function selectOrders(
  trx: Transaction<DB>,
  appId: string,
  orderIds: readonly string[],
): Promise<OrderFiguresRow[]> {
  return trx
    .withSchema('app')
    .selectFrom('orders')
    .select([
      'order_id',
      'platform',
      'sub_order_id',
      'buy_type',
      'rebate_status',
      'platform_status',
      'hold',
      'rights_pending',
      'booked_base_fen',
      'settle_period',
      'union_settled_at',
      'est_commission_fen',
      'settle_commission_fen',
      'commission_version',
    ])
    .where('app_id', '=', appId)
    .where('order_id', 'in', [...orderIds])
    .execute();
}

/** BR-FUND-17 查看者本人份额暂缓: an open first or reassign obligation; deferred was credited. */
async function selectHeld(
  trx: Transaction<DB>,
  subject: OrderFiguresSubject,
  orderIds: readonly string[],
): Promise<ReadonlySet<string>> {
  const rows = await trx
    .withSchema('app')
    .selectFrom('beneficiary_credits')
    .select('order_id')
    .where('app_id', '=', subject.app_id)
    .where('user_id', '=', subject.user_id)
    .where('status', '=', 'open')
    .where('kind', 'in', HELD_KINDS)
    .where('order_id', 'in', [...orderIds])
    .execute();
  return new Set(rows.map((row) => row.order_id));
}

/** A shared order's owner reads the share role, a self purchase self; direct / indirect never. */
function viewerRole(row: OrderFiguresRow): 'self' | 'share' | null {
  if (row.buy_type === 'share' || row.buy_type === 'self') return row.buy_type;
  return null;
}

/**
 * The base a priced order's shares split. A held CREDITED order takes booked_base_fen as it stands
 * (BR-CALC-13, BR-FUND-04 ⑫): R5a credits floor(booked_base_fen × ratio), and that column is the
 * entry base (BR-FUND-05), so it follows R9 / R10 while settle_commission_fen stays, and 淘礼金 is
 * not deducted from it again. Every other order converts the effective commission (BR-CALC-02)
 * net of its open deductions (B2-03r, the wallet's figure).
 */
async function pricedBaseFen(
  deps: OrderFiguresPricingPorts,
  trx: Transaction<DB>,
  row: OrderFiguresRow,
  input: PendingSnapshotInput,
  reserveBp: number,
  openFen: bigint,
): Promise<bigint | null> {
  if (row.rebate_status === 'CREDITED') return row.booked_base_fen;
  const nFen = netOfOpenDeduction(
    effectiveCommissionFen(row.est_commission_fen, row.settle_commission_fen),
    openFen,
  );
  if (nFen === null) return null;
  return pendingBaseFen(nFen, reserveBp, await deps.readTljDeductFen(trx, input));
}

export async function priceOrder(
  deps: OrderFiguresPricingPorts,
  trx: Transaction<DB>,
  subject: OrderFiguresSubject,
  row: OrderFiguresRow,
  openFen = 0n,
): Promise<OrderFiguresPricing | null> {
  // No snapshot yet (version 0) or no commission: B_est is unknown, never 0 (BR-FUND-17).
  if (row.commission_version < 1) return null;
  const input: PendingSnapshotInput = {
    appId: subject.app_id,
    orderId: row.order_id,
    commissionVersion: row.commission_version,
  };
  const snapshot = await deps.readSnapshot(trx, input);
  if (snapshot === null) return null;
  const baseFen = await pricedBaseFen(deps, trx, row, input, snapshot.reserveBp, openFen);
  if (baseFen === null) return null;
  const role = viewerRole(row);
  if (role === null) return { baseFen, viewerShareFen: null };
  const viewerShareFen = splitPendingShares(
    baseFen,
    snapshot.beneficiaries,
    snapshot.forfeitedEvents,
  )
    .filter((share) => share.userId === subject.user_id && share.role === role)
    .reduce((sum, share) => addFen(sum, share.amountFen), 0n);
  return { baseFen, viewerShareFen };
}

async function creditTerms(
  config: OrderFiguresDependencies['config'],
  appId: string,
  platforms: ReadonlySet<string>,
): Promise<ReadonlyMap<string, OrderCreditTerms>> {
  const terms = new Map<string, OrderCreditTerms>();
  if (platforms.size === 0) return terms;
  const billDay = integerConfig(
    await config.get(appId, 'settle.bill_day'),
    'settle.bill_day',
    DEFAULT_BILL_DAY,
  );
  const graceDays = integerConfig(
    await config.get(appId, 'settle.statement.grace_days'),
    'settle.statement.grace_days',
    DEFAULT_GRACE_DAYS,
  );
  for (const platform of platforms) {
    const offsetKey = `settle.period_offset_months.${platform}`;
    terms.set(platform, {
      credit_enabled: creditEnabledValue(await config.get(appId, `credit.enabled.${platform}`)),
      period_offset_months: integerConfig(
        await config.get(appId, offsetKey),
        offsetKey,
        DEFAULT_PERIOD_OFFSET_MONTHS,
      ),
      bill_day: billDay,
      grace_days: graceDays,
    });
  }
  return terms;
}

export function createOrderFiguresReader(deps: OrderFiguresDependencies): OrderFiguresSource {
  return {
    async forOrders(subject, orderIds) {
      const figures = new Map<string, OrderFiguresValue>();
      if (orderIds.length === 0) return figures;
      const { app_id: appId, user_id: userId } = subject;
      const read = await onReadTransaction(deps.db, async (trx) => {
        const rows = await selectOrders(trx, appId, orderIds);
        const keyOf = (row: OrderFiguresRow) => orderKey(row.platform, row.sub_order_id);
        const ledger = await deps.ledger(trx, { appId, userId, orderKeys: rows.map(keyOf) });
        const held = await selectHeld(trx, subject, orderIds);
        const open = await readOpenDeductionTotals(
          trx,
          appId,
          rows.filter((row) => needsPricing(row, false)).map((row) => row.order_id),
        );
        const orders = [];
        for (const row of rows) {
          const isHeld = held.has(row.order_id);
          orders.push({
            row,
            held: isHeld,
            pricing: needsPricing(row, isHeld)
              ? await priceOrder(deps, trx, subject, row, open.get(row.order_id) ?? 0n)
              : null,
            entry: ledger.get(keyOf(row)),
          });
        }
        return orders;
      });
      if (read.length === 0) return figures;
      const now = deps.clock.now();
      const appealed = await deps.appeals.pendingOrderIds(appId, userId, orderIds);
      const platforms = new Set(read.map((order) => order.row.platform));
      const terms = await creditTerms(deps.config, appId, platforms);
      for (const order of read) {
        const platformTerms = terms.get(order.row.platform);
        if (platformTerms === undefined) throw new Error('settlement: platform terms not read');
        figures.set(
          order.row.order_id,
          orderFiguresOf({
            ...order,
            appealed: appealed.has(order.row.order_id),
            terms: platformTerms,
            now,
          }),
        );
      }
      return figures;
    },
  };
}
