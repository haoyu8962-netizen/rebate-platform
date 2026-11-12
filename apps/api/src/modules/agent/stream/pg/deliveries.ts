// B3-08zc · BR-AI-19 细则「助手回复落库」, BR-AI-05: the delivery records of the cards a run kept
// while its client was gone (numbered and stored with the reply, frame not written, so no B3-05i
// receipt and no model reference in that round). writeReply calls writeDeliveries in the terminal
// transaction, so once the reply is committed the next round (any process) resolves those
// card_ids through ResultSetStore.findDelivered exactly like cards that were framed.
//
// The records are what the orchestrator's receipt (orchestrator/core/run.ts receipt →
// DeliveryReceiptPort) would have written through store/results:
//   product_list — deliveredProductsOf: the set data.result_set_id; item i took c<frame + 1 + i>;
//     product_key (non-empty), platform (contracts enum) and integer final_price_fen required, else
//     the item is skipped; card = the card without card_ids, data.items = [that one item].
//     Written like recordDelivered: the set's owner (agent_result_sets ⋈ agent_runs; here also
//     required to be this run's app and session), positions max + 1 under the same advisory lock.
//   rebate_quote — quotedProductOf: data.product took c<frame + 1>; card = the card without
//     card_ids. Written like recordQuoted: the run's quoted result set (same id and marker,
//     ./../../store/results/keys.ts), then the same append.
// A card_id already delivered in the session is skipped (primary key, ON CONFLICT DO NOTHING), so a
// card that got its receipt is never written twice. A record the table constraints would refuse (a
// negative price, a price beyond the money bounds) drops its card's whole receipt, as a rejected
// receipt write does; it never fails the terminal transaction.
import { platform as platformEnum } from '@couli/contracts-ts';
import { parseFen } from '@couli/money';
import { sql } from 'kysely';
import { isUuid } from '../../store/index.ts';
import { deliveriesLockKey, QUOTED_CONDITIONS, quotedSetId } from '../../store/results/keys.ts';
import type { CardInput } from '../writer/index.ts';
import type { RunRow } from './store.ts';
import type { Queries } from './transaction.ts';

const PLATFORMS: readonly string[] = platformEnum;
const CARD_ID = /^c([1-9][0-9]*)$/u;

/** One delivery record, as DeliveredProductReceipt (final_price_fen already in fen, bigint). */
export interface DeliveryRecord {
  readonly card_id: string;
  readonly product_key: string;
  readonly platform: string;
  readonly final_price_fen: bigint;
  readonly card: Readonly<Record<string, unknown>>;
}

/** The receipt a framed card would have had: a product_list's set, or the run's quoted set. */
export type DeliveryReceipt =
  | {
      readonly kind: 'list';
      readonly resultSetId: string;
      readonly items: readonly DeliveryRecord[];
    }
  | { readonly kind: 'quoted'; readonly items: readonly DeliveryRecord[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function withoutCardId(value: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'card_id'));
}

/** A product's record at card number `no`; null when the receipt would skip it. */
function recordOf(
  product: Readonly<Record<string, unknown>>,
  no: number,
  card: Readonly<Record<string, unknown>>,
): DeliveryRecord | null | 'refused' {
  const productKey = product['product_key'];
  const platform = product['platform'];
  const finalPrice = product['final_price_fen'];
  if (typeof productKey !== 'string' || productKey === '') return null;
  if (typeof platform !== 'string' || !PLATFORMS.includes(platform)) return null;
  if (typeof finalPrice !== 'number' || !Number.isSafeInteger(finalPrice)) return null;
  if (!Number.isSafeInteger(no)) return null;
  let fen: bigint;
  try {
    fen = parseFen(finalPrice);
  } catch {
    return 'refused';
  }
  // agent_result_deliveries_final_price_fen_check: the normal receipt write would be rejected.
  if (fen < 0n) return 'refused';
  return {
    card_id: `c${String(no)}`,
    product_key: productKey,
    platform,
    final_price_fen: fen,
    card,
  };
}

/**
 * The receipt of `card` (numbered, as stored with the reply), or null when a framed card would
 * have none (another type, missing set or products, a record the table would refuse).
 */
export function deliveryReceiptOf(card: CardInput): DeliveryReceipt | null {
  const frame = CARD_ID.exec(card.card_id);
  if (frame === null || !isRecord(card.data)) return null;
  const first = Number(frame[1]);
  const envelope = withoutCardId(card);
  if (card.type === 'rebate_quote') {
    const product = card.data['product'];
    if (!isRecord(product)) return null;
    const copy = { ...envelope, data: { ...card.data, product: withoutCardId(product) } };
    const record = recordOf(product, first + 1, copy);
    if (record === null || record === 'refused') return null;
    return { kind: 'quoted', items: [record] };
  }
  if (card.type !== 'product_list') return null;
  const resultSetId = card.data['result_set_id'];
  const items = card.data['items'];
  if (typeof resultSetId !== 'string' || !isUuid(resultSetId) || !Array.isArray(items)) {
    return null;
  }
  const out: DeliveryRecord[] = [];
  for (const [index, item] of (items as unknown[]).entries()) {
    if (!isRecord(item)) continue;
    const copy = { ...envelope, data: { ...card.data, items: [withoutCardId(item)] } };
    const record = recordOf(item, first + 1 + index, copy);
    if (record === 'refused') return null;
    if (record !== null) out.push(record);
  }
  return out.length === 0 ? null : { kind: 'list', resultSetId, items: out };
}

interface Owner {
  readonly run_id: string;
}

/** The result set the receipt appends to, with the run that owns it; null: written nowhere. */
async function ownerOf(
  q: Queries,
  run: RunRow,
  receipt: DeliveryReceipt,
): Promise<{ readonly resultSetId: string; readonly runId: string } | null> {
  if (receipt.kind === 'list') {
    const rows = await q.query(sql<Owner>`SELECT s.run_id::text AS run_id
      FROM app.agent_result_sets s
      JOIN app.agent_runs r ON r.app_id = s.app_id AND r.id = s.run_id
      WHERE s.id = ${receipt.resultSetId}::uuid AND s.app_id = ${run.app_id}
        AND r.session_id = ${run.session_id}`);
    const owner = rows[0];
    return owner === undefined ? null : { resultSetId: receipt.resultSetId, runId: owner.run_id };
  }
  // One quoted set per run (recordQuoted): the same derived id and marker.
  await q.query(sql`INSERT INTO app.agent_result_sets (id, app_id, run_id, conditions)
    VALUES (${quotedSetId(sql`${run.id}`)}, ${run.app_id}, ${run.id}, ${QUOTED_CONDITIONS}::jsonb)
    ON CONFLICT (id) DO NOTHING`);
  const rows = await q.query(sql<{ id: string }>`SELECT id::text AS id FROM app.agent_result_sets
    WHERE app_id = ${run.app_id} AND run_id = ${run.id} AND id = ${quotedSetId(sql`${run.id}`)}`);
  const set = rows[0];
  return set === undefined ? null : { resultSetId: set.id, runId: run.id };
}

/**
 * Writes the receipts of `cards` (in delivery order) into agent_result_deliveries, in the caller's
 * transaction (writeReply's, i.e. the terminal one).
 */
export async function writeDeliveries(
  q: Queries,
  run: RunRow,
  cards: readonly CardInput[],
): Promise<void> {
  for (const card of cards) {
    const receipt = deliveryReceiptOf(card);
    if (receipt === null) continue;
    const owner = await ownerOf(q, run, receipt);
    if (owner === null) continue;
    // Same statement as store/results' advisoryLockSql, written as a sql tag at the call (the
    // agent write-scope gate reads every .query argument).
    const lockKey = JSON.stringify(deliveriesLockKey(run.app_id, owner.resultSetId));
    await q.query(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
    const last = await q.query(sql<{ max: number | null }>`SELECT max(position) AS max
      FROM app.agent_result_deliveries
      WHERE app_id = ${run.app_id} AND result_set_id = ${owner.resultSetId}::uuid`);
    let position = (last[0]?.max ?? 0) + 1;
    for (const item of receipt.items) {
      const inserted = await q.query(sql`INSERT INTO app.agent_result_deliveries
        (app_id, session_id, run_id, result_set_id, position, card_id, product_key, platform,
          final_price_fen, card)
        VALUES (${run.app_id}, ${run.session_id}, ${owner.runId}::uuid, ${owner.resultSetId}::uuid,
          ${position}, ${item.card_id}, ${item.product_key}, ${item.platform},
          ${item.final_price_fen}, ${JSON.stringify(item.card)}::jsonb)
        ON CONFLICT (app_id, session_id, card_id) DO NOTHING
        RETURNING card_id`);
      if (inserted.length > 0) position += 1;
    }
  }
}
