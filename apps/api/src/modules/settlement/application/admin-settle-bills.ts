// B2-09d: the settlement console's monthly bill reads (CT-24z listAdminSettleBills,
// getAdminSettleBill, listAdminSettleBatchItems; 08 BR-FUND-04 细则「月结账单状态」; 04 §3.2
// settle_bills, settle_batches, settle_batch_items). Read only: the bill status is derived from the
// batches of the bill's latest round at read time and never stored.
//
// Every statement reads settlement's own three tables of the given app on the given handle; the
// permission check (settle.bill or fund.view, read only) is the controller's and appId is always
// the guard's actor. Nothing is written, locked or audited, and no batch command is called. The
// bill-day totals of settle_bills are shown as stored (supplement batches do not write them back,
// D10-280 ③); item counts are summed at read time. Items carry the user_id only, never a phone.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for type-only imports.
import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import { fenToJsonNumber } from '@couli/money';
import { sql, type Kysely, type Selectable } from 'kysely';

export type AdminSettleBillStatus = Schema<'AdminSettleBillStatus'>;

/** The settle_batches columns the derived status and the latest round are read from (as stored). */
export interface AdminSettleRoundBatch {
  readonly batch_id: string;
  readonly platform: string;
  readonly kind: string;
  readonly status: string;
  readonly settle_mode: string;
  readonly scheduled_at: Date | null;
  readonly created_at: Date;
  /**
   * created_at as epoch microseconds, the column's precision (a Date keeps milliseconds), as text;
   * the reads below always select it.
   */
  readonly created_micros?: string;
}

/** What AdminSettleBillStatus derives for one bill at one instant. */
export interface AdminSettleBillDerivation {
  readonly status: AdminSettleBillStatus;
  /**
   * batch_id of every batch of the bill's latest round, CANCELLED included (the batches whose
   * in_current_round is true); [] when the bill has no batch.
   */
  readonly currentRound: readonly string[];
}

/** A batch's created_at in microseconds: the column's value, else the Date's milliseconds. */
function createdMicros(batch: AdminSettleRoundBatch): bigint {
  return batch.created_micros === undefined
    ? BigInt(batch.created_at.getTime()) * 1000n
    : BigInt(batch.created_micros);
}

/** The round a batch belongs to: every main batch is one round, a supplement launch another. */
function roundKey(batch: AdminSettleRoundBatch): string {
  return batch.kind === 'main'
    ? 'main'
    : `supplement|${batch.platform}|${String(createdMicros(batch))}`;
}

/** The batches of the latest round: largest round time, a tie to the round with the largest id. */
function latestRound(batches: readonly AdminSettleRoundBatch[]): AdminSettleRoundBatch[] {
  const rounds = new Map<string, AdminSettleRoundBatch[]>();
  for (const batch of batches) {
    const key = roundKey(batch);
    const round = rounds.get(key);
    if (round === undefined) rounds.set(key, [batch]);
    else round.push(batch);
  }
  let best: { time: bigint; maxId: string; batches: AdminSettleRoundBatch[] } | undefined;
  for (const round of rounds.values()) {
    let time = createdMicros(round[0]!);
    let maxId = '';
    for (const batch of round) {
      const created = createdMicros(batch);
      if (created > time) time = created;
      // uuid text in lower case orders as PostgreSQL orders the uuid column.
      const id = batch.batch_id.toLowerCase();
      if (id > maxId) maxId = id;
    }
    if (best === undefined || time > best.time || (time === best.time && maxId > best.maxId)) {
      best = { time, maxId, batches: round };
    }
  }
  return best?.batches ?? [];
}

/**
 * AdminSettleBillStatus of a bill: `generatedAt` is settle_bills.generated_at, `batches` every
 * settle_batches row of the bill (any order), `now` the server clock.
 */
export function deriveAdminSettleBill(
  generatedAt: Date | null,
  batches: readonly AdminSettleRoundBatch[],
  now: Date,
): AdminSettleBillDerivation {
  const round = latestRound(batches);
  const currentRound = round.map((batch) => batch.batch_id);
  // The first rule that holds wins, in the contract's order.
  if (generatedAt === null) return { status: 'generating', currentRound };
  const live = round.filter((batch) => batch.status !== 'CANCELLED');
  if (live.length === 0 || live.some((batch) => batch.status === 'DRAFT')) {
    return { status: 'issued', currentRound };
  }
  if (live.every((batch) => batch.status === 'DONE')) return { status: 'settled', currentRound };
  const due = (batch: AdminSettleRoundBatch): boolean =>
    batch.status === 'EXECUTING' ||
    batch.status === 'PARTIAL' ||
    (batch.status === 'CONFIRMED' &&
      (batch.settle_mode === 'IMMEDIATE' ||
        (batch.scheduled_at !== null && batch.scheduled_at.getTime() <= now.getTime())));
  if (live.some(due)) return { status: 'settling', currentRound };
  return { status: 'scheduled', currentRound };
}

/** A 20001 with data.fields (the bill month range, an unknown bill_id or batch_id of the app). */
export class AdminSettleBillFieldsError extends Error {
  readonly fields: readonly string[];

  constructor(fields: readonly string[]) {
    super('settlement: admin settle bill read refused');
    this.name = 'AdminSettleBillFieldsError';
    this.fields = fields;
  }
}

/** What the reads need besides the app (assembled on the admin entry). */
export interface AdminSettleBillReadDeps {
  readonly db: Kysely<DB>;
  /** The response instant (injected Clock): CONFIRMED batches due or not. */
  readonly now: () => Date;
}

export interface AdminSettleBillListQuery {
  readonly awaiting_confirm?: boolean;
  readonly page?: number;
  readonly page_size?: number;
  readonly bill_from?: string;
  readonly bill_to?: string;
  readonly status?: AdminSettleBillStatus;
}

export interface AdminSettleBatchItemListQuery {
  readonly page?: number;
  readonly page_size?: number;
  readonly item_type?: Schema<'AdminSettleBatchItemType'>;
  readonly result?: Schema<'AdminSettleBatchItemResultFilterValue'>;
}

/** Contract AdminPage / AdminPageSize defaults. */
const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;

/** settle_batches.batch_id is a uuid column; any other text names no batch. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type BillRow = Selectable<DB['settle_bills']>;
type BatchRow = Selectable<DB['settle_batches']>;
type ItemRow = Selectable<DB['settle_batch_items']>;
type Bill = Schema<'AdminSettleBill'>;
type ItemCounts = Schema<'AdminSettleBatchItemCounts'>;

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

function fen(value: bigint | null): number | null {
  return value === null ? null : fenToJsonNumber(value);
}

function billView(
  row: BillRow,
  batches: readonly AdminSettleRoundBatch[],
  derived: AdminSettleBillDerivation,
): Bill {
  return {
    bill_id: row.bill_id,
    status: derived.status,
    generation_started_at: row.generation_started_at.toISOString(),
    generated_at: iso(row.generated_at),
    platform_order_counts: row.platform_order_counts as Bill['platform_order_counts'],
    platform_settle_commission_totals:
      row.platform_settle_commission_totals as Bill['platform_settle_commission_totals'],
    beneficiary_total_fen: fen(row.beneficiary_total_fen),
    platform_retained_fen: fen(row.platform_retained_fen),
    error_count: row.error_count,
    held_count: row.held_count,
    batch_count: batches.length,
    draft_batch_count: batches.filter((batch) => batch.status === 'DRAFT').length,
    created_at: row.created_at.toISOString(),
  };
}

/** Exact on PostgreSQL 14 and later (extract returns numeric); never through a JS Date. */
const CREATED_MICROS = sql<string>`(extract(epoch from created_at) * 1000000)::bigint::text`.as(
  'created_micros',
);

const ROUND_COLUMNS = [
  'bill_id',
  'batch_id',
  'platform',
  'kind',
  'status',
  'settle_mode',
  'scheduled_at',
  'created_at',
] as const;

/** One page of the app's bills, bill_id descending, each with its status derived now. */
export async function listAdminSettleBills(
  deps: AdminSettleBillReadDeps,
  appId: string,
  query: AdminSettleBillListQuery,
): Promise<Schema<'AdminSettleBillPage'>> {
  const { bill_from: from, bill_to: to } = query;
  // YYYY-MM (the route schema's pattern) orders as text.
  if (from !== undefined && to !== undefined && from > to) {
    throw new AdminSettleBillFieldsError(['bill_from', 'bill_to']);
  }
  const page = query.page ?? DEFAULT_PAGE;
  const pageSize = query.page_size ?? DEFAULT_PAGE_SIZE;
  // A bill per month: the bills of the range and their batches are few, and the status filter
  // goes by the status derived at response time, so the page is cut after deriving.
  let bills = deps.db
    .withSchema('app')
    .selectFrom('settle_bills')
    .selectAll()
    .where('app_id', '=', appId);
  let batches = deps.db
    .withSchema('app')
    .selectFrom('settle_batches')
    .select([...ROUND_COLUMNS, CREATED_MICROS])
    .where('app_id', '=', appId);
  if (from !== undefined) {
    bills = bills.where('bill_id', '>=', from);
    batches = batches.where('bill_id', '>=', from);
  }
  if (to !== undefined) {
    bills = bills.where('bill_id', '<=', to);
    batches = batches.where('bill_id', '<=', to);
  }
  const billRows = await bills.orderBy('bill_id', 'desc').execute();
  const byBill = new Map<string, AdminSettleRoundBatch[]>();
  for (const batch of await batches.execute()) {
    const list = byBill.get(batch.bill_id);
    if (list === undefined) byBill.set(batch.bill_id, [batch]);
    else list.push(batch);
  }
  const now = deps.now();
  const rows: Bill[] = [];
  for (const row of billRows) {
    const own = byBill.get(row.bill_id) ?? [];
    const derived = deriveAdminSettleBill(row.generated_at, own, now);
    if (query.status !== undefined && derived.status !== query.status) continue;
    rows.push(billView(row, own, derived));
  }
  const offset = (page - 1) * pageSize;
  return {
    items: rows.slice(offset, offset + pageSize),
    page,
    page_size: pageSize,
    total: rows.length,
  };
}

/** Item counts of the batches by item_type × result (pending = result null). */
async function itemCounts(
  db: Kysely<DB>,
  appId: string,
  batchIds: readonly string[],
): Promise<Map<string, ItemCounts>> {
  const counts = new Map<string, ItemCounts>();
  for (const id of batchIds) {
    counts.set(id, {
      order: { credited: 0, skipped: 0, pending: 0 },
      beneficiary: { credited: 0, skipped: 0, deferred: 0, pending: 0 },
    });
  }
  if (batchIds.length === 0) return counts;
  const groups = await db
    .withSchema('app')
    .selectFrom('settle_batch_items')
    .select((eb) => ['batch_id', 'item_type', 'result', eb.fn.countAll<string>().as('n')])
    .where('app_id', '=', appId)
    .where('batch_id', 'in', batchIds)
    .groupBy(['batch_id', 'item_type', 'result'])
    .execute();
  for (const group of groups) {
    const cells = counts.get(group.batch_id);
    if (cells === undefined) continue;
    const n = Number(group.n);
    const result = group.result ?? 'pending';
    if (group.item_type === 'order') {
      const order = cells.order as Record<string, number>;
      if (result in order) order[result] = (order[result] ?? 0) + n;
    } else if (group.item_type === 'beneficiary') {
      const beneficiary = cells.beneficiary as Record<string, number>;
      if (result in beneficiary) beneficiary[result] = (beneficiary[result] ?? 0) + n;
    }
  }
  return counts;
}

function batchView(
  row: BatchRow,
  inCurrentRound: boolean,
  counts: ItemCounts,
): Schema<'AdminSettleBatch'> {
  return {
    batch_id: row.batch_id,
    platform: row.platform as Schema<'AdminSettleBatch'>['platform'],
    kind: row.kind as Schema<'AdminSettleBatchKind'>,
    status: row.status as Schema<'AdminSettleBatchStatus'>,
    settle_mode: row.settle_mode as Schema<'AdminSettleMode'>,
    scheduled_at: iso(row.scheduled_at),
    confirmed_by: row.confirmed_by,
    confirmed_at: iso(row.confirmed_at),
    cancelled_reason: row.cancelled_reason,
    order_count: row.order_count,
    started_at: iso(row.started_at),
    finished_at: iso(row.finished_at),
    paused_by_switch_at: iso(row.paused_by_switch_at),
    created_at: row.created_at.toISOString(),
    row_version: row.row_version,
    in_current_round: inCurrentRound,
    item_counts: counts,
  };
}

/** The app's bill with every batch (created_at, then batch_id) and the batches' item counts. */
export async function getAdminSettleBill(
  deps: AdminSettleBillReadDeps,
  appId: string,
  billId: string,
): Promise<Schema<'AdminSettleBillDetail'>> {
  const bill = await deps.db
    .withSchema('app')
    .selectFrom('settle_bills')
    .selectAll()
    .where('app_id', '=', appId)
    .where('bill_id', '=', billId)
    .executeTakeFirst();
  if (bill === undefined) throw new AdminSettleBillFieldsError(['bill_id']);
  const batches = await deps.db
    .withSchema('app')
    .selectFrom('settle_batches')
    .selectAll()
    .select(CREATED_MICROS)
    .where('app_id', '=', appId)
    .where('bill_id', '=', billId)
    .orderBy('created_at')
    .orderBy('batch_id')
    .execute();
  const derived = deriveAdminSettleBill(bill.generated_at, batches, deps.now());
  const current = new Set(derived.currentRound);
  const counts = await itemCounts(
    deps.db,
    appId,
    batches.map((batch) => batch.batch_id),
  );
  return {
    ...billView(bill, batches, derived),
    batches: batches.map((batch) =>
      batchView(batch, current.has(batch.batch_id), counts.get(batch.batch_id)!),
    ),
  };
}

function itemView(row: ItemRow): Schema<'AdminSettleBatchItem'> {
  return {
    id: row.id,
    item_type: row.item_type as Schema<'AdminSettleBatchItemType'>,
    order_id: row.order_id,
    user_id: row.user_id,
    role: row.role as Schema<'AdminSettleBatchItem'>['role'],
    beneficiary_credit_id: row.beneficiary_credit_id,
    settle_seq: row.settle_seq,
    b_settle_fen: fen(row.b_settle_fen),
    amount_fen: fen(row.amount_fen),
    result: row.result as Schema<'AdminSettleBatchItem'>['result'],
    skip_reason: row.skip_reason,
    created_at: row.created_at.toISOString(),
  };
}

/** One page of the items of the app's batch, settle_seq then id ascending. */
export async function listAdminSettleBatchItems(
  deps: AdminSettleBillReadDeps,
  appId: string,
  batchId: string,
  query: AdminSettleBatchItemListQuery,
): Promise<Schema<'AdminSettleBatchItemPage'>> {
  if (!UUID.test(batchId)) throw new AdminSettleBillFieldsError(['batch_id']);
  const id = batchId.toLowerCase();
  const batch = await deps.db
    .withSchema('app')
    .selectFrom('settle_batches')
    .select('batch_id')
    .where('app_id', '=', appId)
    .where('batch_id', '=', id)
    .executeTakeFirst();
  if (batch === undefined) throw new AdminSettleBillFieldsError(['batch_id']);
  const page = query.page ?? DEFAULT_PAGE;
  const pageSize = query.page_size ?? DEFAULT_PAGE_SIZE;
  let items = deps.db
    .withSchema('app')
    .selectFrom('settle_batch_items')
    .where('app_id', '=', appId)
    .where('batch_id', '=', id);
  if (query.item_type !== undefined) items = items.where('item_type', '=', query.item_type);
  if (query.result === 'pending') items = items.where('result', 'is', null);
  else if (query.result !== undefined) items = items.where('result', '=', query.result);
  const counted = await items
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .executeTakeFirstOrThrow();
  const total = Number(counted.n);
  const offset = (page - 1) * pageSize;
  const rows =
    offset >= total
      ? []
      : await items
          .selectAll()
          .orderBy('settle_seq')
          .orderBy('id')
          .offset(offset)
          .limit(pageSize)
          .execute();
  return { items: rows.map(itemView), page, page_size: pageSize, total };
}
