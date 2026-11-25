// B2-18 (BR-FUND-04 ④, BR-FUND-09): every order_settlements row of one sub-order, re-read on the
// generating transaction after the order key lock, in the shape the bill source hands over
// (BillSourceSettlement). Read only; settlement owns order_settlements' reads for the bill.
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import type { BillSourceSettlement } from '../types.ts';

function settlementSource(value: string): BillSourceSettlement['source'] {
  if (value !== 'API' && value !== 'STATEMENT') {
    throw new Error('settlement bill: unknown order_settlements source');
  }
  return value;
}

export async function readOrderSettlements(
  trx: Transaction<DB>,
  appId: string,
  orderId: string,
): Promise<BillSourceSettlement[]> {
  const rows = await trx
    .withSchema('app')
    .selectFrom('order_settlements')
    .select(['seq', 'source', 'created_at', 'settled_at', 'settle_commission_fen'])
    .where('app_id', '=', appId)
    .where('order_id', '=', orderId)
    .orderBy('seq')
    .execute();
  return rows.map((r) => ({
    seq: r.seq,
    source: settlementSource(r.source),
    createdAt: r.created_at,
    settledAt: r.settled_at,
    commissionFen: r.settle_commission_fen,
  }));
}
