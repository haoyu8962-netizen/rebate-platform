// B1-28s: the read-only query behind GET /admin/v1/product-feedbacks (adminListProductFeedbacks,
// CT-26x, 编排 D10-757; 08 BR-ID-30 细则「商品反馈记录」). Reads only feedback's own table
// app.product_feedbacks, scoped to the console's app_id; writes nothing (no audit record).
// Filters combine with AND: platform, reason, created_at in [from, to). `from` not earlier than
// `to` (equal included) is refused with data.fields=[from, to]. Newest first, id as the stable
// second key so equal created_at rows never repeat or go missing across pages. Items carry exactly
// the contract's 12 fields: never device_id, app_id or anything of the account.
// Records of a user whose deletion completed were deleted by the cleanup step (deletion.ts).
//
// Also compiled by the `test` project: erasable syntax only, `import type` for type-only imports,
// relative imports with `.ts`.
import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import { fenToJsonNumber } from '@couli/money';
import { sql, type Kysely } from 'kysely';

/** Contract AdminPage / AdminPageSize defaults. */
const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;

/** The query of the list as the route schema leaves it (all optional). */
export interface AdminProductFeedbackListQuery {
  readonly page?: number;
  readonly page_size?: number;
  readonly platform?: string;
  readonly reason?: string;
  readonly from?: string;
  readonly to?: string;
}

export type AdminProductFeedbackPage = Schema<'AdminProductFeedbackPage'>;
type Item = Schema<'AdminProductFeedbackListItem'>;

/** A refusal of the list (20001 data.fields), thrown for the controller. */
export class AdminProductFeedbackFieldsError extends Error {
  readonly fields: readonly string[];

  constructor(fields: readonly string[]) {
    super('feedback: admin product feedback list refused');
    this.name = 'AdminProductFeedbackFieldsError';
    this.fields = fields;
  }
}

/** The contract's 12 columns only (no app_id, device_id). */
function selectItems(db: Kysely<DB>) {
  return db
    .withSchema('app')
    .selectFrom('product_feedbacks')
    .select([
      'id',
      'platform',
      'product_key',
      'item_ref',
      'link_id',
      'shown_final_price_fen',
      'shown_rebate_fen',
      'quoted_at',
      'reason',
      'note',
      'user_id',
      'created_at',
    ]);
}

type Row = Awaited<ReturnType<ReturnType<typeof selectItems>['executeTakeFirstOrThrow']>>;

function viewOf(row: Row): Item {
  return {
    id: row.id,
    platform: row.platform as Item['platform'],
    product_key: row.product_key,
    item_ref: row.item_ref,
    link_id: row.link_id,
    shown_final_price_fen: fenToJsonNumber(row.shown_final_price_fen),
    shown_rebate_fen: row.shown_rebate_fen === null ? null : fenToJsonNumber(row.shown_rebate_fen),
    quoted_at: row.quoted_at.toISOString(),
    reason: row.reason as Item['reason'],
    note: row.note,
    user_id: row.user_id,
    created_at: row.created_at.toISOString(),
  };
}

/**
 * `from` not earlier than `to` (equal included). Compared by PostgreSQL on the same casts the
 * filters use, so any date-time the route schema lets through is judged at full precision.
 */
async function rangeEmpty(db: Kysely<DB>, from: string, to: string): Promise<boolean> {
  const { rows } = await sql<{
    empty: boolean;
  }>`SELECT (${from}::timestamptz >= ${to}::timestamptz) AS empty`.execute(db);
  return rows[0]?.empty === true;
}

/** One page of the app's product feedback records, newest first. */
export async function listAdminProductFeedbacks(
  db: Kysely<DB>,
  appId: string,
  query: AdminProductFeedbackListQuery,
): Promise<AdminProductFeedbackPage> {
  const { platform, reason, from, to } = query;
  if (from !== undefined && to !== undefined && (await rangeEmpty(db, from, to))) {
    throw new AdminProductFeedbackFieldsError(['from', 'to']);
  }
  const page = query.page ?? DEFAULT_PAGE;
  const pageSize = query.page_size ?? DEFAULT_PAGE_SIZE;
  let rows = selectItems(db).where('app_id', '=', appId);
  let count = db
    .withSchema('app')
    .selectFrom('product_feedbacks')
    .select(sql<string>`count(*)`.as('total'))
    .where('app_id', '=', appId);
  if (platform !== undefined) {
    rows = rows.where('platform', '=', platform);
    count = count.where('platform', '=', platform);
  }
  if (reason !== undefined) {
    rows = rows.where('reason', '=', reason);
    count = count.where('reason', '=', reason);
  }
  if (from !== undefined) {
    rows = rows.where('created_at', '>=', sql<Date>`${from}::timestamptz`);
    count = count.where('created_at', '>=', sql<Date>`${from}::timestamptz`);
  }
  if (to !== undefined) {
    rows = rows.where('created_at', '<', sql<Date>`${to}::timestamptz`);
    count = count.where('created_at', '<', sql<Date>`${to}::timestamptz`);
  }
  const items = await rows
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .limit(pageSize)
    .offset((page - 1) * pageSize)
    .execute();
  const { total } = await count.executeTakeFirstOrThrow();
  return {
    items: items.map(viewOf),
    page,
    page_size: pageSize,
    total: Number(total),
  };
}
