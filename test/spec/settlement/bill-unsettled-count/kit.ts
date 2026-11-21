// B2-18a 规则测试夹具（claude-independent，SPEC_REF 6c631c2）：BR-FUND-04 ④ 2026-11-21 改写——
// settle_period = 账单月、未 hold、未维权而截至生成开始仍无联盟结算数据的子订单只计入账单的「应结未结」数，
// 不生成差错单；app.settle_bills 新增 unsettled_count（应结未结数）与 amount_mismatch_count（B2-18 用，
// 本单只建列）。新列经本文件的读取函数读：列不存在时返回 COLUMN_MISSING，让先红红在断言上，
// 而不是红在「列不存在」的 SQL 错误上。
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';

/** 新列尚不存在时读取函数返回的标记（不是任何合法取值）。 */
export const COLUMN_MISSING = 'column-missing';
export type NewCount = number | null | typeof COLUMN_MISSING;

export const NEW_COLUMNS = ['unsettled_count', 'amount_mismatch_count'] as const;
export type NewColumn = (typeof NEW_COLUMNS)[number];

export const CHECKS: Record<NewColumn, string> = {
  unsettled_count: 'settle_bills_unsettled_count_check',
  amount_mismatch_count: 'settle_bills_amount_mismatch_count_check',
};

export interface ColumnShape {
  readonly name: string;
  readonly dataType: string;
  readonly nullable: boolean;
  readonly defaultValue: string | null;
}

/** information_schema 里 app.settle_bills 的这些列（不存在的列不出现）。 */
export async function settleBillColumns(
  db: Kysely<DB>,
  names: readonly string[],
): Promise<ColumnShape[]> {
  const { rows } = await sql<{
    name: string;
    data_type: string;
    nullable: boolean;
    default_value: string | null;
  }>`
    SELECT column_name AS name, data_type, is_nullable = 'YES' AS nullable,
      column_default AS default_value
    FROM information_schema.columns
    WHERE table_schema = 'app' AND table_name = 'settle_bills'
      AND column_name IN (${sql.join(names)})
    ORDER BY column_name
  `.execute(db);
  return rows.map((r) => ({
    name: r.name,
    dataType: r.data_type,
    nullable: r.nullable,
    defaultValue: r.default_value,
  }));
}

/** 两个新列各自在不在（information_schema）。 */
export async function newColumnsPresent(db: Kysely<DB>): Promise<Record<NewColumn, boolean>> {
  const present = new Set((await settleBillColumns(db, NEW_COLUMNS)).map((c) => c.name));
  return {
    unsettled_count: present.has('unsettled_count'),
    amount_mismatch_count: present.has('amount_mismatch_count'),
  };
}

export interface BillCounts {
  readonly error_count: number | null;
  readonly held_count: number | null;
  readonly unsettled_count: NewCount;
  readonly amount_mismatch_count: NewCount;
}

/**
 * 一张账单的四个计数；账单行不存在时为 null。整行经 to_jsonb 读出，不在 SQL 里点名新列，
 * 列不存在时对应字段是 COLUMN_MISSING。
 */
export async function billCounts(
  db: Kysely<DB>,
  appId: string,
  billId = '2032-06',
): Promise<BillCounts | null> {
  const present = await newColumnsPresent(db);
  const { rows } = await sql<{ row: Record<string, unknown> }>`
    SELECT to_jsonb(b) AS row FROM app.settle_bills AS b
    WHERE b.app_id = ${appId} AND b.bill_id = ${billId}
  `.execute(db);
  const row = rows[0]?.row;
  if (row === undefined) return null;
  const count = (value: unknown): number | null => (typeof value === 'number' ? value : null);
  const newCount = (column: NewColumn): NewCount =>
    present[column] && column in row ? count(row[column]) : COLUMN_MISSING;
  return {
    error_count: count(row['error_count']),
    held_count: count(row['held_count']),
    unsettled_count: newCount('unsettled_count'),
    amount_mismatch_count: newCount('amount_mismatch_count'),
  };
}

/** 迁移前形状的账单行：只写已有列，新列不出现在 INSERT 里。 */
export async function legacyBill(
  db: Kysely<DB>,
  appId: string,
  values: {
    readonly billId?: string;
    readonly platformOrderCounts?: Record<string, number>;
    readonly platformCommissionTotals?: Record<string, string>;
    readonly errorCount?: number;
    readonly heldCount?: number;
  } = {},
): Promise<void> {
  const at = new Date('2032-07-24T00:05:00+08:00');
  await sql`
    INSERT INTO app.settle_bills
      (app_id, bill_id, generation_started_at, generated_at, platform_order_counts,
       platform_settle_commission_totals, beneficiary_total_fen, platform_retained_fen,
       error_count, held_count)
    VALUES (${appId}, ${values.billId ?? '2032-06'}, ${at}, ${at},
      ${JSON.stringify(values.platformOrderCounts ?? {})}::jsonb,
      ${JSON.stringify(values.platformCommissionTotals ?? {})}::jsonb,
      ${0n}, ${0n}, ${values.errorCount ?? 0}, ${values.heldCount ?? 0})
  `.execute(db);
}
