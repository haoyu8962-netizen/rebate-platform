// B1-04zv (BR-CALC-03, D10-522 ⑤, D10-570): one page of order rows under CallCtx.rowErrors. A row
// its mapper refuses goes to `rejected` and the rest of the page goes on; mappers keep throwing.
// Only the mapper's own refusal (UnionError invalid_dto) is caught here: anything else is not a bad
// row. `detail` is the refusal's message, and those carry field names and reasons, never a value.
import { createHash } from 'node:crypto';
import { UnionError, type RejectedOrderRow, type UnionOrder } from '../domain/types.ts';

/** What a refused row still says about itself; reading it must not throw. */
export interface OrderRowIdentity {
  readonly sub_order_id: string | null;
  readonly raw_status: string | null;
}

/** `row:` + the first 32 hex digits of the row's sha256: the same row always gets the same key. */
function rowKey(row: unknown): string {
  const digest = createHash('sha256').update(JSON.stringify(row)).digest('hex');
  return `row:${digest.slice(0, 32)}`;
}

/** Items and refused rows of one page, in upstream order. */
export function collectOrderRows(
  rows: readonly unknown[],
  rawPayloadId: string | null,
  map: (row: unknown) => UnionOrder,
  identify: (row: unknown) => OrderRowIdentity,
): { readonly items: readonly UnionOrder[]; readonly rejected: readonly RejectedOrderRow[] } {
  const items: UnionOrder[] = [];
  const rejected: RejectedOrderRow[] = [];
  for (const row of rows) {
    try {
      items.push(map(row));
    } catch (error) {
      if (!(error instanceof UnionError) || error.code !== 'invalid_dto') throw error;
      const identity = identify(row);
      rejected.push({
        ...identity,
        raw_payload_id: rawPayloadId,
        detail: error.message,
        row_key: identity.sub_order_id ?? rowKey(row),
      });
    }
  }
  return { items, rejected };
}
