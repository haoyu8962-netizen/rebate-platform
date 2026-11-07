// B1-09u (编排 D10-819 ①、D10-821 ③; 08 12_TEXT BR-TEXT-05「子原因 reason_sub」): storage rules of
// the manual sub-reason columns — app.rights_imports.reason_sub, app.order_rights.reason_sub +
// reason_sub_manual, app.orders.reason_sub_manual. The columns are not in db.gen.ts when these
// tests are written, so every statement is raw SQL. Fixtures come from the B1-08a and B1-09e kits
// (imported, not changed: rule-test files are add-only). Tests assert column shapes and
// behaviour, never migration file names or constraint names.
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { expect } from 'vitest';

export {
  CHECK_VIOLATION,
  PERMISSION_DENIED,
  column,
  newOrder,
  newOrderKey,
  sqlState,
} from '../kit.ts';
export { connect, insert, newOrderId, orderRight, rightsImport } from '../../orders-ops/kit.ts';

/** BR-TEXT-05: the 15 sub-reason codes (PUNISH 12, REFUND 2, RIGHTS 1). */
export const REASON_SUB_CODES = [
  'VIOLATION_PROMO',
  'SHOP_TK',
  'INSITE_PROMO',
  'PROXY_BUY',
  'FAKE_TRADE',
  'INSITE_RESALE',
  'OVER_LIMIT',
  'MARKET_DISRUPT',
  'MULTI_TRADE_ABNORMAL',
  'SINGLE_TRADE_ABNORMAL',
  'RISK_ORDER',
  'PUNISH_ORDER',
  'IN_SALE',
  'AFTER_SETTLE',
  'AFTER_SALE',
] as const;

/** 「无」chosen explicitly (D10-819 ①): only rights_imports and order_rights store it. */
export const REASON_SUB_NONE = 'none';

/** Strings outside the list: unknown code, wrong case, empty, upper-case none, padded code. */
export const REJECTED_REASON_SUBS = ['OTHER', 'fake_trade', '', 'NONE', 'FAKE_TRADE '] as const;

export const NOT_NULL_VIOLATION = '23502';

export type Attribute = {
  type: string;
  notNull: boolean;
  defaultExpr: string | null;
  /** pg_attribute.atthasmissing: rows stored before ADD COLUMN read the column's missing value. */
  hasMissing: boolean;
};

/**
 * The column as the catalog sees it on app.<table> (also partitions, which the application role
 * may hold no privilege on, so information_schema would hide them); undefined when absent.
 */
export async function attribute(
  db: Kysely<DB>,
  table: string,
  name: string,
): Promise<Attribute | undefined> {
  const result = await sql<{
    type: string;
    not_null: boolean;
    default_expr: string | null;
    has_missing: boolean;
  }>`
    SELECT format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS not_null,
           pg_get_expr(d.adbin, d.adrelid) AS default_expr, a.atthasmissing AS has_missing
    FROM pg_attribute a
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE a.attrelid = to_regclass(${`app.${table}`}) AND a.attname = ${name}
      AND a.attnum > 0 AND NOT a.attisdropped
  `.execute(db);
  const row = result.rows[0];
  if (row === undefined) return undefined;
  return {
    type: row.type,
    notNull: row.not_null,
    defaultExpr: row.default_expr,
    hasMissing: row.has_missing,
  };
}

// Must be called inside every test before DML: an absent migration is an assertion failure.
export async function requireColumn(db: Kysely<DB>, table: string, name: string): Promise<void> {
  expect(await attribute(db, table, name), `app.${table}.${name} exists`).toBeDefined();
}

/** Whether the role holds the privilege on the column app.<table>.<name>. */
export async function hasColumnPrivilege(
  db: Kysely<DB>,
  role: string,
  table: string,
  name: string,
  privilege: string,
): Promise<boolean> {
  const result = await sql<{ ok: boolean }>`
    SELECT has_column_privilege(${role}::name, ${`app.${table}`}::text, ${name}::text,
                                ${privilege}::text) AS ok
  `.execute(db);
  return result.rows[0]?.ok === true;
}

/** The stored (reason_sub, reason_sub_manual) of the order_rights row. */
export async function storedRight(
  db: Kysely<DB>,
  id: unknown,
): Promise<{ reason_sub: string | null; reason_sub_manual: boolean }[]> {
  const result = await sql<{ reason_sub: string | null; reason_sub_manual: boolean }>`
    SELECT reason_sub, reason_sub_manual FROM app.order_rights WHERE id = ${id}
  `.execute(db);
  return result.rows;
}

/** The stored reason_sub of the rights_imports row. */
export async function storedImport(
  db: Kysely<DB>,
  id: unknown,
): Promise<{ reason_sub: string | null }[]> {
  const result = await sql<{ reason_sub: string | null }>`
    SELECT reason_sub FROM app.rights_imports WHERE id = ${id}
  `.execute(db);
  return result.rows;
}

/** The partition and stored reason_sub_manual of the order. */
export async function storedOrder(
  db: Kysely<DB>,
  orderId: unknown,
): Promise<{ part: string; manual: boolean }[]> {
  const result = await sql<{ part: string; manual: boolean }>`
    SELECT tableoid::regclass::text AS part, reason_sub_manual AS manual
    FROM app.orders WHERE order_id = ${orderId}
  `.execute(db);
  return result.rows;
}
