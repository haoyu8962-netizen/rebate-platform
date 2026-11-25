// B2-04zd (D10-443): the production readSource of the bill job (BR-FUND-04 ③ ④).
// Read only, on the job's transaction: the app / platform's orders with every order_settlements row,
// plus settlement rows without an order (order = null). Scope, cut-off and the greatest seq stay
// with the bill job; nothing the job has to judge is filtered out here.
// B2-18 (D10-2415 ③, D10-2567): the recon diff 「以联盟为准」 conclusion is no longer an input of the
// bill or the supplement. The reader never calls the conclusion port it may still be given (kept until
// FU-B2-18-RETIRE-UNION-CONCLUSION) and never reads recon_diffs; unionAuthoritative is always false.
//
// settlement reads orders / order_keys / order_settlements on the caller's transaction, as the
// credit store does (credit-store.ts). UNATTRIBUTED orders are not one of the bill's six results
// (@couli/domain settlement/bill); they and their settlement rows are left out here, not passed on
// as orphans (the order exists on our side).
import type { DB } from '@couli/db';
import { orderKey, type OrderRebateState } from '@couli/domain';
import { sql, type Kysely } from 'kysely';
import type {
  BillJobDependencies,
  BillSourceOrder,
  BillSourceRow,
  BillSourceSettlement,
  BillUnionConclusion,
} from '../job.ts';

/**
 * Structurally ledger's readUnionAuthoritativeOrderKeys (a Map with the concluded amounts, D10-506).
 * B2-18: still part of the shape (the assemblies and frozen kits pass it) but never called; the bill
 * no longer reads conclusions.
 */
export interface BillSourceDependencies {
  readonly readUnionAuthoritative: (
    db: Kysely<DB>,
    selection: { readonly appId: string; readonly orderKeys: readonly string[] },
  ) => Promise<ReadonlySet<string> | ReadonlyMap<string, readonly BillUnionConclusion[]>>;
}

type BillRebateStatus = BillSourceOrder['rebateStatus'];

const BILL_REBATE_STATUSES: ReadonlySet<string> = new Set<
  Exclude<OrderRebateState, 'UNATTRIBUTED'>
>(['ESTIMATED', 'WAITING', 'CREDITED', 'VOID', 'CLAWED_BACK']);

function billRebateStatus(value: string): BillRebateStatus {
  if (!BILL_REBATE_STATUSES.has(value)) {
    throw new Error('settlement bill source: unknown rebate_status');
  }
  return value as BillRebateStatus;
}

function settlementSource(value: string): BillSourceSettlement['source'] {
  if (value !== 'API' && value !== 'STATEMENT') {
    throw new Error('settlement bill source: unknown order_settlements source');
  }
  return value;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** One row of the single source statement: an orders row or an order_settlements row. */
interface SourceFactRow {
  readonly kind: 'order' | 'settlement';
  readonly order_id: string;
  readonly platform: string;
  readonly sub_order_id: string;
  readonly rebate_status: string | null;
  readonly settle_period: string | null;
  readonly hold: boolean | null;
  readonly rights_pending: boolean | null;
  readonly commission_version: number | null;
  readonly seq: number | null;
  readonly source: string | null;
  readonly created_at: Date | null;
  readonly settled_at: Date | null;
  readonly settle_commission_fen: bigint | null;
}

interface OrderFact {
  readonly order_id: string;
  readonly platform: string;
  readonly sub_order_id: string;
  readonly rebate_status: string;
  readonly settle_period: string | null;
  readonly hold: boolean;
  readonly rights_pending: boolean;
  readonly commission_version: number;
}

interface SettlementFact {
  readonly order_id: string;
  readonly platform: string;
  readonly sub_order_id: string;
  readonly seq: number;
  readonly source: string;
  readonly created_at: Date;
  readonly settled_at: Date;
  readonly settle_commission_fen: bigint;
}

function malformed(): never {
  throw new Error('settlement bill source: malformed source row');
}

function orderFact(row: SourceFactRow): OrderFact {
  const { rebate_status, hold, rights_pending, commission_version } = row;
  if (rebate_status === null || hold === null || rights_pending === null) return malformed();
  if (commission_version === null) return malformed();
  return {
    order_id: row.order_id,
    platform: row.platform,
    sub_order_id: row.sub_order_id,
    rebate_status,
    settle_period: row.settle_period,
    hold,
    rights_pending,
    commission_version,
  };
}

function settlementFact(row: SourceFactRow): SettlementFact {
  const { seq, source, created_at, settled_at, settle_commission_fen } = row;
  if (seq === null || source === null || created_at === null || settled_at === null) {
    return malformed();
  }
  if (settle_commission_fen === null) return malformed();
  return {
    order_id: row.order_id,
    platform: row.platform,
    sub_order_id: row.sub_order_id,
    seq,
    source,
    created_at,
    settled_at,
    settle_commission_fen,
  };
}

export function createBillSourceReader(
  dependencies: BillSourceDependencies,
): BillJobDependencies['readSource'] {
  // B2-18: the conclusion port is not used (see the header).
  void dependencies;
  return async (trx, input) => {
    // FU-B204ZD-SNAPSHOT: orders and order_settlements in ONE statement, so both come from the same
    // snapshot even on a READ COMMITTED transaction with other statements before this one (an
    // order-sync commit between two reads would mix the facts of two instants).
    const { rows: sourceRows } = await sql<SourceFactRow>`
      SELECT 'order' AS kind, o.order_id::text AS order_id, o.platform, o.sub_order_id,
        o.rebate_status, o.settle_period, o.hold, o.rights_pending, o.commission_version,
        NULL::integer AS seq, NULL::text AS source, NULL::timestamptz AS created_at,
        NULL::timestamptz AS settled_at, NULL::bigint AS settle_commission_fen
      FROM app.orders AS o
      WHERE o.app_id = ${input.appId} AND o.platform = ${input.platform}
      UNION ALL
      SELECT 'settlement' AS kind, s.order_id::text AS order_id, k.platform, k.sub_order_id,
        NULL::text, NULL::text, NULL::boolean, NULL::boolean, NULL::integer,
        s.seq, s.source, s.created_at, s.settled_at, s.settle_commission_fen
      FROM app.order_settlements AS s
      INNER JOIN app.order_keys AS k ON k.app_id = s.app_id AND k.order_id = s.order_id
      WHERE s.app_id = ${input.appId} AND k.platform = ${input.platform}
      ORDER BY kind, order_id, seq
    `.execute(trx);
    const orders: OrderFact[] = [];
    const settlements: SettlementFact[] = [];
    for (const row of sourceRows) {
      if (row.kind === 'order') orders.push(orderFact(row));
      else settlements.push(settlementFact(row));
    }

    const unattributed = new Set<string>();
    const facts = new Map<string, { key: string; row: OrderFact }>();
    for (const row of orders) {
      if (row.rebate_status === 'UNATTRIBUTED') {
        unattributed.add(row.order_id);
        continue;
      }
      facts.set(row.order_id, { key: orderKey(row.platform, row.sub_order_id), row });
    }

    const byOrder = new Map<string, { key: string; settlements: BillSourceSettlement[] }>();
    for (const [orderId, fact] of facts) byOrder.set(orderId, { key: fact.key, settlements: [] });
    for (const s of settlements) {
      if (unattributed.has(s.order_id)) continue;
      let entry = byOrder.get(s.order_id);
      if (entry === undefined) {
        entry = { key: orderKey(s.platform, s.sub_order_id), settlements: [] };
        byOrder.set(s.order_id, entry);
      }
      entry.settlements.push({
        seq: s.seq,
        source: settlementSource(s.source),
        createdAt: s.created_at,
        settledAt: s.settled_at,
        commissionFen: s.settle_commission_fen,
      });
    }

    const rows: BillSourceRow[] = [];
    for (const [orderId, entry] of byOrder) {
      const fact = facts.get(orderId);
      rows.push({
        orderKey: entry.key,
        order:
          fact === undefined
            ? null
            : {
                orderId,
                rebateStatus: billRebateStatus(fact.row.rebate_status),
                settlePeriod: fact.row.settle_period,
                hold: fact.row.hold,
                rightsPending: fact.row.rights_pending,
                commissionVersion: fact.row.commission_version,
                unionAuthoritative: false,
              },
        settlements: entry.settlements,
      });
    }
    return rows.sort((a, b) => compareText(a.orderKey, b.orderKey));
  };
}
