// B2-09a: the console reads of recon_diffs of sources R1–R3 (contracts/openapi.yaml
// listAdminReconDiffs, getAdminReconDiff; 08 BR-FUND-22 差错单). Read only on the given handle, by
// app; source R4 (收款对账) stays with payment's listAdminPayReconDiffs. The permission check
// (fund.recon or fund.view, read only) is the controller's; appId is always the guard's actor.
// Nothing is written or audited. Every answer is built field by field from the contract's schema;
// amounts stay bigint fen until the JSON integer of @couli/money.
import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import { fenToJsonNumber } from '@couli/money';
import type { Kysely, Selectable } from 'kysely';
import {
  countAdminReconDiffs,
  findAdminReconDiff,
  pageAdminReconDiffs,
  type AdminReconDiffFilter,
} from '../infra/recon-diffs-store.ts';

/** A 20001 with data.fields (the period range; recon_diff_id for an id naming no listed row). */
export class ReconDiffFieldsError extends Error {
  readonly fields: readonly string[];

  constructor(fields: readonly string[]) {
    super('ledger: admin recon diff read refused');
    this.name = 'ReconDiffFieldsError';
    this.fields = fields;
  }
}

/** Contract AdminPage / AdminPageSize defaults. */
const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;

/** recon_diffs.id is a uuid column; any other text names no row (contract Id is any short string). */
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ReconDiffRow = Selectable<DB['recon_diffs']>;

/** The query of listAdminReconDiffs after the route schema (page / page_size as integers). */
export interface ReconDiffListQuery {
  readonly page?: number;
  readonly page_size?: number;
  readonly type?: Schema<'AdminReconDiffType'>;
  readonly source?: Schema<'AdminReconDiffSource'>;
  readonly status?: Schema<'AdminReconDiffStatus'>;
  readonly period_from?: string;
  readonly period_to?: string;
  readonly ref_id?: string;
}

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

/** The contract AdminReconDiff of an R1–R3 row. */
function listView(row: ReconDiffRow): Schema<'AdminReconDiff'> {
  return {
    recon_diff_id: row.id,
    source: row.source as Schema<'AdminReconDiffSource'>,
    type: row.type as Schema<'AdminReconDiffType'>,
    period: row.period,
    ref_type: row.ref_type,
    ref_id: row.ref_id,
    expected_fen: fenToJsonNumber(row.expected_fen),
    actual_fen: fenToJsonNumber(row.actual_fen),
    diff_fen: fenToJsonNumber(row.diff_fen),
    status: row.status as Schema<'AdminReconDiffStatus'>,
    created_at: row.created_at.toISOString(),
    closed_at: iso(row.closed_at),
  };
}

/** The contract AdminReconDiffDetail: the list fields plus handler, updated_at and resolution. */
export function detailView(row: ReconDiffRow): Schema<'AdminReconDiffDetail'> {
  return {
    ...listView(row),
    handler_id: row.handler_id,
    updated_at: row.updated_at.toISOString(),
    resolution: row.resolution as Schema<'AdminReconDiffDetail'>['resolution'],
  };
}

/**
 * The store filter of a list query (every given field ANDed, absent = all). B2-02w: the dashboard's
 * recon_diff_open count builds its filter here too, so it and the list's total are one judgement.
 */
export function reconDiffListFilter(
  appId: string,
  query: Omit<ReconDiffListQuery, 'page' | 'page_size'>,
): AdminReconDiffFilter {
  return {
    appId,
    type: query.type,
    source: query.source,
    status: query.status,
    periodFrom: query.period_from,
    periodTo: query.period_to,
    refId: query.ref_id,
  };
}

/** One page of the app's R1–R3 recon diffs, created_at then id descending. */
export async function listAdminReconDiffs(
  db: Kysely<DB>,
  appId: string,
  query: ReconDiffListQuery,
): Promise<Schema<'AdminReconDiffPage'>> {
  // Both ends inclusive and compared as plain strings (code-unit order, as the store's "C" order).
  if (
    query.period_from !== undefined &&
    query.period_to !== undefined &&
    query.period_from > query.period_to
  ) {
    throw new ReconDiffFieldsError(['period_from', 'period_to']);
  }
  const page = query.page ?? DEFAULT_PAGE;
  const pageSize = query.page_size ?? DEFAULT_PAGE_SIZE;
  const filter = reconDiffListFilter(appId, query);
  const total = await countAdminReconDiffs(db, filter);
  const offset = (page - 1) * pageSize;
  const rows = offset >= total ? [] : await pageAdminReconDiffs(db, filter, offset, pageSize);
  return { items: rows.map(listView), page, page_size: pageSize, total };
}

/** One R1–R3 recon diff of the app with its handling summary; otherwise recon_diff_id refused. */
export async function getAdminReconDiff(
  db: Kysely<DB>,
  appId: string,
  reconDiffId: string,
): Promise<Schema<'AdminReconDiffDetail'>> {
  // Unknown, another app's and R4 answer alike: no 404 and no hint which one it was.
  if (!UUID.test(reconDiffId)) throw new ReconDiffFieldsError(['recon_diff_id']);
  const row = await findAdminReconDiff(db, appId, reconDiffId.toLowerCase());
  if (row === undefined) throw new ReconDiffFieldsError(['recon_diff_id']);
  return detailView(row);
}
