// B2-04zp (D10-588 ⑤, BR-FUND-09): one order, two numbers taken at the bill's cut-off.
// decidingSettlement picks the record that decides the amount, the same one
// orders.settle_commission_fen holds for R5; latestSeqWithin gives the seq a batch item stores. They
// differ once an API record follows a STATEMENT: the amount stays with the STATEMENT, the seq moves
// on to the API record. R5 and R5a compare the item's seq with the order's greatest seq, so an item
// carrying the deciding record's seq would be skipped as settlement_changed on every run.

export interface DecidingSettlementRow {
  readonly seq: number;
  readonly source: 'API' | 'STATEMENT';
  /** When we obtained the record: the cut-off compares this, never the union's settlement time. */
  readonly createdAt: Date;
}

/**
 * The record that decides the amount among those obtained up to and including cutoffMs: the greatest
 * seq STATEMENT when there is one, otherwise the greatest seq API; null when no record qualifies.
 * Only the amount: the seq a batch item stores stays the order's greatest seq within the cut-off.
 */
export function decidingSettlement<T extends DecidingSettlementRow>(
  rows: readonly T[],
  cutoffMs: number,
): T | null {
  let statement: T | null = null;
  let api: T | null = null;
  for (const row of rows) {
    if (row.createdAt.getTime() > cutoffMs) continue;
    if (row.source === 'STATEMENT') {
      if (statement === null || row.seq > statement.seq) statement = row;
    } else if (api === null || row.seq > api.seq) {
      api = row;
    }
  }
  return statement ?? api;
}

/**
 * The seq a batch item stores: the order's greatest seq of any source obtained up to and including
 * cutoffMs. `deciding` is decidingSettlement's result on the same rows, so a seq always exists.
 */
export function latestSeqWithin(
  rows: readonly DecidingSettlementRow[],
  cutoffMs: number,
  deciding: DecidingSettlementRow,
): number {
  let latest = deciding.seq;
  for (const row of rows) {
    if (row.createdAt.getTime() <= cutoffMs && row.seq > latest) latest = row.seq;
  }
  return latest;
}
